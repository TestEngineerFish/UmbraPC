// 工具 → 常用语：维护可在快捷入口里直接粘贴的短语列表（关键词直达、拖拽调序、云端同步），
// 外加一把独立的全局快捷键 —— 按下后打开的是剪贴板面板的「常用语」分类（同一个弹框，默认列表不同）。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu, Pill, RefreshButton, btnGhost, btnPrimary, inputHotkey, inputSmall,
} from "../../components/ui";
import { HotkeyButton, HotkeyConflictBanner, useHotkeyConflict } from "./hotkeys";
import { useHotkeyRecorder } from "../../components/HotkeyRecorder";
import { IconGrip } from "../../components/icons";
import { launcherApi, clipApi, hasClip, type Phrase, type PhraseSyncState } from "./bridges";

// 常用语快捷键的出厂值（⌘⌥V，和剪贴板的 ⌘⇧V 同族好记）。
const DEFAULT_PHRASES_SHORTCUT = "Command+Alt+V";
// 拖拽重排的动画时长。再长就显得拖沓，再短又看不出「让位」的过程。
const FLIP_MS = 180;

// 同步状态一句话。没配服务器就直说，别让用户对着一个不动的按钮猜。
function syncLabel(s: PhraseSyncState | null, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (!s) return "";
  if (!s.configured) return t("tools.phraseSyncOff");
  if (s.syncing) return t("tools.phraseSyncing");
  if (s.lastError) return t("tools.phraseSyncFailed", { err: s.lastError });
  if (!s.lastAt) return t("tools.phraseSyncNever");
  const min = Math.floor((Date.now() - s.lastAt) / 60000);
  return min < 1 ? t("tools.phraseSyncJustNow") : t("tools.phraseSyncAgo", { n: min });
}

// 同步状态 + 立即同步按钮。单独导出是因为它要摆在页面标题行的右上角（见 Tools.tsx），
// 而标题行由 Tools.tsx 统一渲染，不在本组件的树里。
export function PhrasesSyncStatus() {
  const { t } = useTranslation();
  const api = launcherApi();
  const [sync, setSync] = useState<PhraseSyncState | null>(null);
  const refresh = () => { void api.phrasesSyncState().then(setSync).catch(() => {}); };
  useEffect(() => {
    refresh();
    // 同步完成会广播常用语变更，借它顺带刷新状态；再加一个低频轮询让「N 分钟前」自己往上走。
    const off = api.onPhrasesChanged(() => refresh());
    const timer = window.setInterval(refresh, 30_000);
    return () => { off(); window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="flex-none flex items-center gap-[8px]">
      <span className={`whitespace-nowrap text-[11.5px] ${sync?.lastError ? "text-danger" : "text-faint"}`}
        title={sync?.lastError || undefined}>
        {syncLabel(sync, t)}
      </span>
      <RefreshButton title={t("tools.phraseSyncNow")} spinning={!!sync?.syncing}
        onClick={async () => { await api.phrasesSyncNow(); refresh(); }} />
    </div>
  );
}

export function PhrasesTool() {
  const { t } = useTranslation();
  const api = launcherApi();
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [draft, setDraft] = useState<{ name: string; keyword: string; content: string }>({ name: "", keyword: "", content: "" });
  // 编辑缓冲区：编辑期间只改这份草稿，点「完成」才落盘，点「取消」直接丢弃。
  // 之前是边打字边写配置，所以根本没有「取消」可言。
  const [edit, setEdit] = useState<Phrase | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  // 手柄按下标记：整行 draggable，但只认手柄发起的拖拽（见 row 里的 onDragStart）。
  const fromHandle = useRef(false);
  const [shortcut, setShortcut] = useState(DEFAULT_PHRASES_SHORTCUT);
  // 录制统一走 useHotkeyRecorder：e.code 取主键（Mac 上 Option 会改 e.key，
  // Option+Shift+V 会录成「◊」）、录制期间关掉全局快捷键。
  const { recording, start } = useHotkeyRecorder((acc) => { setShortcut(acc); void clipApi().setPhrasesShortcut(acc); });
  const conflict = useHotkeyConflict("phrases", shortcut);

  useEffect(() => { void api.getPhrases().then((p) => setPhrases(p || [])); }, []);
  // 云端同步改写了常用语时跟着更新（别的设备改了这边要看得到）。
  useEffect(() => {
    const off = api.onPhrasesChanged((list) => setPhrases(list || []));
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!hasClip) return;
    void clipApi().getSettings().then((s) => { if (s.phrasesShortcut) setShortcut(s.phrasesShortcut); });
  }, []);


  // 落盘。主进程会盖改动时间戳、收集删除墓碑并排一次云端推送，这里不用自己管同步。
  const save = (list: Phrase[]) => {
    setPhrases(list);
    void api.setPhrases(list);
  };

  const add = () => {
    if (!draft.content.trim()) return;
    const p: Phrase = {
      id: `ph${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      name: draft.name.trim() || draft.content.trim().slice(0, 20),
      content: draft.content.trim(),
      keyword: draft.keyword.trim() || undefined,
    };
    save([...phrases, p]);
    setDraft({ name: "", keyword: "", content: "" });
  };
  const commitEdit = () => {
    if (!edit) return;
    save(phrases.map((p) => (p.id === edit.id ? { ...edit, keyword: (edit.keyword || "").trim() || undefined } : p)));
    setEdit(null);
  };

  // ── 拖拽调序：跟手实时重排 + FLIP 动画 ──────────────────────────────────
  // 做法是业界通用的 FLIP（First-Last-Invert-Play）：改完顺序后，把每个元素先用
  // transform 拉回它原来的位置（此时视觉上还没动），下一帧再放开，让它「滑」到新位置。
  // 只有 transform 参与动画，不碰 layout，所以怎么拖都不掉帧。
  // 参考：https://aerotwist.com/blog/flip-your-animations/
  const [dragId, setDragId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const prevRects = useRef(new Map<string, DOMRect>());
  // 拖拽期间的顺序改动不落盘（拖到一半松手前一直在变），dragEnd 时才写。
  const orderDirty = useRef(false);
  // 上一次换位的让位动画播完的时刻。动画期间元素视觉上还停在旧位置，
  // 此时 dragover 仍会打在它身上，不锁住就会立刻换回去，表现为疯狂闪烁。
  const lockUntil = useRef(0);

  // First：每次渲染前把当前位置记下来，供下一次渲染做 Invert。
  const snapshot = () => {
    const m = new Map<string, DOMRect>();
    rowRefs.current.forEach((el, id) => m.set(id, el.getBoundingClientRect()));
    prevRects.current = m;
  };

  // Last + Invert + Play：DOM 已经是新顺序了，把每个位移过的元素先按差值拉回去，再放开。
  useLayoutEffect(() => {
    rowRefs.current.forEach((el, id) => {
      const before = prevRects.current.get(id);
      if (!before) return;
      const after = el.getBoundingClientRect();
      const dy = before.top - after.top;
      if (!dy) return;
      // 正在被拖的那条不参与动画：它跟着鼠标走，再叠一层过渡只会打架。
      if (id === dragId) return;
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(.2,.7,.3,1)`;
        el.style.transform = "";
      });
    });
    prevRects.current.clear();
  }, [phrases, dragId]);

  // 拖过某一行 → 把被拖的那条挪到它的位置（跟手重排），FLIP 负责把动画补上。
  //
  // 两道防抖，缺一不可（只碰到就换位会疯狂闪烁）：
  // ① **越过中线才换**。碰到就换的话，换完之后指针往往还压在同一行上，下一帧又换回去。
  //    按方向判：往下拖要指针过了目标行中线，往上拖要指针在中线之上——换完之后条件自然
  //    不再成立，所以稳得住。
  // ② **让位动画期间不再换**。动画头几帧元素被 transform 拉在旧位置上，命中测试用的是
  //    变换后的位置，dragover 照样打在它身上，光靠中线还是会来回跳。
  const moveTo = (targetId: string, clientY: number) => {
    if (!dragId || dragId === targetId) return;
    if (Date.now() < lockUntil.current) return;
    const from = phrases.findIndex((p) => p.id === dragId);
    const to = phrases.findIndex((p) => p.id === targetId);
    if (from < 0 || to < 0) return;
    const el = rowRefs.current.get(targetId);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    if (to > from ? clientY < mid : clientY > mid) return;
    lockUntil.current = Date.now() + FLIP_MS;
    snapshot();
    const list = phrases.slice();
    const [it] = list.splice(from, 1);
    list.splice(to, 0, it);
    orderDirty.current = true;
    setPhrases(list);           // 只改内存，松手才落盘
  };

  const endDrag = () => {
    setDragId(null);
    lockUntil.current = 0;
    if (orderDirty.current) {
      orderDirty.current = false;
      void api.setPhrases(phrases);
    }
  };

  const row = (p: Phrase, editing: boolean) => (
    <div
      key={p.id}
      ref={(el) => { if (el) rowRefs.current.set(p.id, el); else rowRefs.current.delete(p.id); }}
      // 整行都是拖拽源，所以拖起来的是「一整条记录」的影像而不是一个小手柄；
      // 但只有在手柄上按下才真的开始拖（onDragStart 里判），否则点行进编辑会被误判成拖拽。
      draggable={!editing}
      onDragStart={(e) => {
        if (!fromHandle.current) { e.preventDefault(); return; }
        lockUntil.current = 0;
        setDragId(p.id);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", p.id);
      }}
      onDragEnd={endDrag}
      onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; moveTo(p.id, e.clientY); } }}
      onDrop={(e) => { e.preventDefault(); endDrag(); }}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id: p.id }); }}
      className={`flex items-center gap-[11px] p-[9px_16px] border-b border-border-soft ${
        dragId === p.id ? "opacity-45 bg-orange-soft" : "hover:bg-hover"}`}
    >
      <span
        onMouseDown={() => { fromHandle.current = true; }}
        onMouseUp={() => { fromHandle.current = false; }}
        title={t("tools.dragToReorder")}
        className="flex-none flex items-center text-faint cursor-grab active:cursor-grabbing hover:text-orange-text"
      >
        <IconGrip size={13} />
      </span>

      {editing && edit ? (
        <div className="flex-1 min-w-0 flex items-center gap-[8px]"
          onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEdit(null); }}>
          <input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            placeholder={t("settings.phraseName")} className={inputSmall} />
          <input value={edit.keyword || ""} onChange={(e) => setEdit({ ...edit, keyword: e.target.value })}
            placeholder={t("settings.phraseKeyword")} className={`${inputSmall} font-mono`} />
          <input value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })}
            placeholder={t("settings.phraseContent")} className={inputHotkey} />
          <button className={btnGhost} onClick={() => setEdit(null)}>{t("common.cancel")}</button>
          <button className={btnPrimary} onClick={commitEdit}>{t("common.done")}</button>
        </div>
      ) : (
        <div className="flex-1 min-w-0 flex items-center gap-[11px] cursor-pointer" onClick={() => setEdit({ ...p })}>
          <span className="w-[132px] flex-none truncate text-[12.5px] font-medium">{p.name}</span>
          {p.keyword ? <Pill tone="accent" mono>{p.keyword}</Pill> : null}
          <span className="flex-1 min-w-0 truncate text-[12px] text-muted">{p.content}</span>
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* 常用语快捷键：唤起的是剪贴板面板，只是默认停在「常用语」分类 */}
      {hasClip ? (
        <section className="bg-card border border-border rounded-[12px] p-[16px]">
          <div className="flex items-center gap-[14px]">
            <div className="w-[120px] flex-none whitespace-nowrap text-[13px]">{t("settings.phrasesShortcut")}</div>
            <div className="flex-1 min-w-0 flex items-center gap-[8px]">
              <HotkeyButton recording={recording} value={shortcut} onClick={start} />
              <button className={btnGhost} onClick={() => { setShortcut(DEFAULT_PHRASES_SHORTCUT); void clipApi().setPhrasesShortcut(DEFAULT_PHRASES_SHORTCUT); }}>
                {t("common.reset")}
              </button>
            </div>
          </div>
          <div className="text-[11.5px] text-faint mt-[10px]">{t("settings.phrasesShortcutHint")}</div>
        </section>
      ) : null}

      {conflict ? <HotkeyConflictBanner owner={conflict} /> : null}

      <section className="bg-card border border-border rounded-[12px] overflow-hidden">
        <div className="flex items-center gap-[10px] p-[13px_16px] border-b border-border-soft">
          <span className="flex-none whitespace-nowrap text-[13px] font-semibold">{t("settings.phrases")}</span>
          <Pill>{t("tools.phraseCount", { n: phrases.length })}</Pill>
          <div className="flex-1" />
          <span className="flex-none whitespace-nowrap text-[11.5px] text-faint">{t("tools.phraseListHint")}</span>
        </div>

        <div className="flex flex-col" onDragEnd={endDrag}>
          {phrases.length
            ? phrases.map((p) => row(p, edit?.id === p.id))
            : <div className="p-[18px_16px] text-[12px] text-faint">{t("settings.phrasesEmpty")}</div>}
        </div>

        <div className="flex items-center gap-[8px] p-[12px_16px] bg-bg">
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("settings.phraseName")} className={inputSmall} />
          <input value={draft.keyword} onChange={(e) => setDraft({ ...draft, keyword: e.target.value })} placeholder={t("settings.phraseKeyword")} className={`${inputSmall} font-mono`} />
          <input value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") add(); }} placeholder={t("settings.phraseContent")} className={inputHotkey} />
          {/* 没填内容时按钮真禁用（add 里也再判一次，回车路径同样拦得住） */}
          <button className={btnPrimary} disabled={!draft.content.trim()} onClick={add}>{t("common.add")}</button>
        </div>
      </section>

      <div className="text-[11.5px] text-faint leading-[1.6]">{t("settings.phrasesHint")}</div>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}
          items={[{
            label: t("common.delete"),
            danger: true,
            onClick: () => {
              if (edit?.id === menu.id) setEdit(null);
              snapshot();
              save(phrases.filter((x) => x.id !== menu.id));
            },
          }]} />
      ) : null}
    </>
  );
}
