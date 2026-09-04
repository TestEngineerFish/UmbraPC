// 工具 → 常用语：维护可在快捷入口里直接粘贴的短语列表（关键词直达、拖拽调序、云端同步），
// 外加一把独立的全局快捷键 —— 按下后打开的是剪贴板面板的「常用语」分类（同一个弹框，默认列表不同）。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu, Modal, Pill, btnGhost, btnPrimary,
} from "../../components/ui";
import { askConfirm } from "../../components/overlay";
import { SyncStamp } from "../../components/SyncStamp";
import { HotkeyButton, HotkeyConflictBanner, useHotkeyConflict } from "./hotkeys";
import { useHotkeyRecorder } from "../../components/HotkeyRecorder";
import { IconGrip } from "../../components/icons";
import { launcherApi, clipApi, hasClip, type Phrase, type PhraseSyncState } from "./bridges";

// 常用语快捷键的出厂值（⌘⌥V，和剪贴板的 ⌘⇧V 同族好记）。
const DEFAULT_PHRASES_SHORTCUT = "Command+Alt+V";
// 拖拽重排的动画时长。再长就显得拖沓，再短又看不出「让位」的过程。
const FLIP_MS = 180;

// 同步状态 + 立即同步按钮。单独导出是因为它要摆在页面标题行的右上角（见 Tools.tsx），
// 而标题行由 Tools.tsx 统一渲染，不在本组件的树里。
export function PhrasesSyncStatus() {
  const { t } = useTranslation();
  const api = launcherApi();
  const [sync, setSync] = useState<PhraseSyncState | null>(null);
  const refresh = () => { void api.phrasesSyncState().then(setSync).catch(() => {}); };
  useEffect(() => {
    refresh();
    // 同步完成会广播常用语变更，借它顺带刷新状态。
    const off = api.onPhrasesChanged(() => refresh());
    return () => { off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 文案与「N 分钟前」的心跳都在 SyncStamp 里（提醒页同一块），这里不再自己格式化、也不再轮询。
  return (
    <SyncStamp state={sync ? { ...sync, offText: t("tools.phraseSyncOff") } : null}
      title={t("tools.phraseSyncNow")}
      onSync={async () => { await api.phrasesSyncNow(); refresh(); }} />
  );
}

export function PhrasesTool() {
  const { t } = useTranslation();
  const api = launcherApi();
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  // 编辑 / 新增共用一个弹窗（批次 011 稿：行内那排小输入框撤掉 ——「内容」框只有
  // 200px 宽，写三段话根本看不见，和列表里看不全是同一个毛病）。
  // modal.p 是编辑缓冲：期间只改这份草稿，点「保存」才落盘，取消直接丢弃。
  const [modal, setModal] = useState<{ id: string | null; name: string; keyword: string; content: string } | null>(null);
  // 点行原地展开只读全文（看和改分开 ——「看不全」和「改不动」是两件事）。
  const [expanded, setExpanded] = useState<string | null>(null);
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

  // 弹窗保存：id 为空 = 新增（接在末尾），否则改那一条。
  // 名称和内容都填了才允许保存（稿定）；触发词可空 —— 那条只能靠名称搜到。
  const modalValid = !!modal && !!modal.name.trim() && !!modal.content.trim();
  const commitModal = () => {
    if (!modal || !modalValid) return;
    const kw = modal.keyword.trim() || undefined;
    if (modal.id) {
      save(phrases.map((p) => (p.id === modal.id
        ? { ...p, name: modal.name.trim(), content: modal.content, keyword: kw } : p)));
    } else {
      save([...phrases, {
        id: `ph${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        name: modal.name.trim(), content: modal.content, keyword: kw,
      }]);
    }
    setModal(null);
  };

  // 删除：产品硬性规则「所有删除都要二次确认」——原来右键直删是漏网存量，顺手补上。
  // 文案与 iOS 端同句（常用语没有回收站，走墓碑同步，不套「移入回收站」那句）。
  const askDelete = async (id: string) => {
    const p = phrases.find((x) => x.id === id);
    if (!p) return;
    const ok = await askConfirm({
      message: t("tools.phraseDeleteAsk", { name: p.name }),
      confirmText: t("common.delete"), danger: true,
    });
    if (!ok) return;
    if (expanded === id) setExpanded(null);
    snapshot();
    save(phrases.filter((x) => x.id !== id));
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

  // 一行：点行 = 原地展开只读全文（--bg 底、max-height:180 内部滚动、保留换行），
  // 改走行尾的 [编辑]，删除走行尾 [删除] / 右键 —— 看和改分开（批次 011 稿）。
  // 长内容（多行或 >60 字）行尾多一个字数，先给个「有多长」的量级感再点开。
  const row = (p: Phrase) => {
    const open = expanded === p.id;
    const long = p.content.includes("\n") || p.content.length > 60;
    return (
      <div
        key={p.id}
        ref={(el) => { if (el) rowRefs.current.set(p.id, el); else rowRefs.current.delete(p.id); }}
        // 整行都是拖拽源，所以拖起来的是「一整条记录」的影像而不是一个小手柄；
        // 但只有在手柄上按下才真的开始拖（onDragStart 里判），否则点行展开会被误判成拖拽。
        draggable
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
        className={`border-b border-border-soft ${dragId === p.id ? "opacity-45 bg-orange-soft" : ""}`}
      >
        <div className={`flex items-center gap-[11px] p-[9px_16px] group/prow ${dragId ? "" : "hover:bg-hover"}`}>
          <span
            onMouseDown={() => { fromHandle.current = true; }}
            onMouseUp={() => { fromHandle.current = false; }}
            title={t("tools.dragToReorder")}
            className="flex-none flex items-center text-faint cursor-grab active:cursor-grabbing hover:text-orange-text"
          >
            <IconGrip size={13} />
          </span>
          <div className="flex-1 min-w-0 flex items-center gap-[11px] cursor-pointer"
            onClick={() => setExpanded(open ? null : p.id)}
            title={open ? t("tools.phraseCollapse") : t("tools.phraseExpand")}>
            <span className="w-[132px] flex-none truncate text-[12.5px] font-medium">{p.name}</span>
            {p.keyword ? <Pill tone="accent" mono>{p.keyword}</Pill> : null}
            <span className="flex-1 min-w-0 truncate text-[12px] text-muted">{p.content.split("\n")[0]}</span>
            {long ? <span className="flex-none whitespace-nowrap text-[10.5px] text-faint font-mono">{t("tools.phraseChars", { n: p.content.length })}</span> : null}
          </div>
          <button className="flex-none whitespace-nowrap px-[8px] py-[3px] border border-border bg-transparent rounded-[7px] text-[11px] text-muted cursor-pointer hover:border-orange hover:text-orange-text"
            onClick={() => setModal({ id: p.id, name: p.name, keyword: p.keyword || "", content: p.content })}>{t("common.edit")}</button>
          <button className="flex-none whitespace-nowrap px-[8px] py-[3px] border border-border bg-transparent rounded-[7px] text-[11px] text-muted cursor-pointer hover:border-danger hover:text-danger"
            onClick={() => void askDelete(p.id)}>{t("common.delete")}</button>
        </div>
        {open ? (
          <div className="mx-[16px] mb-[10px] p-[10px_12px] rounded-[9px] bg-bg border border-border-soft text-[12.5px] leading-[1.7] whitespace-pre-wrap break-words max-h-[180px] overflow-y-auto">
            {p.content}
          </div>
        ) : null}
      </div>
    );
  };

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
          {/* 新增走同一个弹窗（批次 011 稿：行内那排 200px 的小输入框写不了三段话，撤掉）。 */}
          <button className={btnPrimary} onClick={() => setModal({ id: null, name: "", keyword: "", content: "" })}>
            {t("tools.phraseNew")}
          </button>
        </div>

        <div className="flex flex-col" onDragEnd={endDrag}>
          {phrases.length
            ? phrases.map((p) => row(p))
            : <div className="p-[18px_16px] text-[12px] text-faint">{t("settings.phrasesEmpty")}</div>}
        </div>
      </section>

      <div className="text-[11.5px] text-faint leading-[1.6]">{t("settings.phrasesHint")}</div>

      {/* 编辑 / 新增弹窗（宽 560，批次 011 稿）：名称 + 触发词并排，内容区大块可拉伸。 */}
      {modal ? (
        <Modal width={560} title={modal.id ? t("tools.phraseEditTitle") : t("tools.phraseNew")}
          onClose={() => setModal(null)}
          footer={<>
            <span className="flex-1" />
            <button className={btnGhost} onClick={() => setModal(null)}>{t("common.cancel")}</button>
            <button className={btnPrimary} disabled={!modalValid} onClick={commitModal}>{t("common.save")}</button>
          </>}>
          <div className="flex flex-wrap gap-[8px]">
            <input autoFocus value={modal.name} onChange={(e) => setModal({ ...modal, name: e.target.value })}
              placeholder={t("settings.phraseName")}
              className="border border-border bg-bg text-text rounded-[8px] px-[10px] py-[7px] text-[13px] outline-none focus:border-orange"
              style={{ flex: "1 1 240px", minWidth: 0 }} />
            <input value={modal.keyword} onChange={(e) => setModal({ ...modal, keyword: e.target.value })}
              placeholder={t("settings.phraseKeyword")}
              className="border border-border bg-bg text-text rounded-[8px] px-[10px] py-[7px] text-[13px] font-mono outline-none focus:border-orange"
              style={{ flex: "0 1 168px", minWidth: 0 }} />
          </div>
          <div className="flex items-baseline gap-[8px] mt-[10px] mb-[6px]">
            <span className="flex-none text-[11.5px] font-semibold tracking-[.05em] text-faint">{t("settings.phraseContent")}</span>
            <span className="flex-1" />
            <span className="flex-none text-[10.5px] text-faint font-mono">{t("tools.phraseChars", { n: modal.content.length })}</span>
          </div>
          <textarea
            value={modal.content}
            onChange={(e) => setModal({ ...modal, content: e.target.value })}
            placeholder={t("tools.phraseContentPh")}
            className="w-full border border-border bg-bg text-text rounded-[9px] px-[11px] py-[9px] text-[12.5px] leading-[1.7] outline-none focus:border-orange resize-y"
            style={{ minHeight: 220, maxHeight: 300 }}
          />
        </Modal>
      ) : null}

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}
          items={[{
            label: t("common.delete"),
            danger: true,
            onClick: () => { void askDelete(menu.id); },
          }]} />
      ) : null}
    </>
  );
}
