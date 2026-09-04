// 常用语（一级导航，批次 012）。套页面骨架的 **T2 列表 + 弹窗**：
//   页头：「常用语 · N 条」+ 同步戳 + 主按钮「新增短语」+ 齿轮（常用语设置）
//   内容：按**标签**分组（分组头 = 标签名 + 条数，「无标签」永远排最后），卡内逐行；
//         点行原地展开只读全文；hover 行尾 24 铅笔进编辑弹窗；删除只在右键菜单；
//         组内拖手柄调序（跨组不拖 —— 换标签去编辑弹窗改）；新增保存后落顶部并高亮 1.2s。
//   设置视图（T3）：标签管理（新增 / 改名 / 合并 / 删除 / 排序）+ 唤起快捷键 + 云端同步。
//
// 触发词 → 标签（sam 定，一条一个）：数据上标签名就是 Phrase.keyword，老触发词自动成为标签；
// 编辑时只能从清单里**选**，要新标签去设置视图建（和记账分类同一个纪律）。
// 数据仍在主进程（umbra-config.json + 云端同步），这里只做展示与派发。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ContextMenu, EmptyState, Modal, RowsCard, SettingRow, RowHint, ErrorCard, btn, select as selectCls, field } from "../../components/ui";
import { PageShell, ListModal, Group, GroupRow, RowExpand, useFlashId, SettingsPage, SettingsSection, detailIconBtn } from "../../components/layout";
import { askConfirm, showToast } from "../../components/overlay";
import { SyncStamp } from "../../components/SyncStamp";
import { HotkeyButton, useHotkeyConflict, OWNER_LABEL } from "../tools/hotkeys";
import { useHotkeyRecorder } from "../../components/HotkeyRecorder";
import { IconGrip, IconPencil, IconUp, IconDown } from "../../components/icons";
import { launcherApi, clipApi, hasClip, hasLauncher, type Phrase, type PhraseSyncState } from "../tools/bridges";

// 常用语快捷键的出厂值（⌘⌥V，和剪贴板的 ⌘⇧V 同族好记）。
const DEFAULT_PHRASES_SHORTCUT = "Command+Alt+V";
// 拖拽重排的动画时长。再长就显得拖沓，再短又看不出「让位」的过程。
const FLIP_MS = 180;

/** 同步状态 + 立即同步按钮（页头同步戳位）。 */
function SyncStatus() {
  const { t } = useTranslation();
  const api = launcherApi();
  const [sync, setSync] = useState<PhraseSyncState | null>(null);
  const refresh = () => { void api.phrasesSyncState().then(setSync).catch(() => {}); };
  useEffect(() => {
    refresh();
    const off = api.onPhrasesChanged(() => refresh());
    return () => { off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <SyncStamp state={sync ? { ...sync, offText: t("tools.phraseSyncOff") } : null}
      title={t("tools.phraseSyncNow")}
      onSync={async () => { await api.phrasesSyncNow(); refresh(); }} />
  );
}

export function Phrases() {
  const { t } = useTranslation();
  const api = launcherApi();
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [modal, setModal] = useState<{ id: string | null; name: string; tag: string; content: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [flashId, flash] = useFlashId();
  const fromHandle = useRef(false);

  const reload = () => {
    void api.getPhrases().then((p) => setPhrases(p || []));
    void api.getPhraseTags().then((tg) => setTags(tg || []));
  };
  useEffect(() => {
    if (!hasLauncher) return;
    reload();
    // 云端同步改写了常用语 / 标签时跟着更新（别的设备改了这边要看得到）。
    const off = api.onPhrasesChanged(() => reload());
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 落盘。主进程会盖改动时间戳、收集删除墓碑并排一次云端推送。
  const save = (list: Phrase[]) => { setPhrases(list); void api.setPhrases(list); };

  // 按标签分组：清单顺序在前，「无标签」永远最后；清单里没有但短语用到的标签也得有一组（老数据兜底）。
  const groups = useMemo(() => {
    const order = [...tags];
    for (const p of phrases) { const k = (p.keyword || "").trim(); if (k && !order.includes(k)) order.push(k); }
    const out: { tag: string; rows: Phrase[] }[] = order.map((tag) => ({ tag, rows: phrases.filter((p) => (p.keyword || "").trim() === tag) }));
    const none = phrases.filter((p) => !(p.keyword || "").trim());
    if (none.length) out.push({ tag: "", rows: none });
    return out.filter((g) => g.rows.length);
  }, [phrases, tags]);

  const modalValid = !!modal && !!modal.name.trim() && !!modal.content.trim();
  const commitModal = () => {
    if (!modal || !modalValid) return;
    const kw = modal.tag.trim() || undefined;
    if (modal.id) {
      save(phrases.map((p) => (p.id === modal.id ? { ...p, name: modal.name.trim(), content: modal.content, keyword: kw } : p)));
    } else {
      // 新条落**顶部**（稿定），保存后高亮 1.2s。
      const id = `ph${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      save([{ id, name: modal.name.trim(), content: modal.content, keyword: kw }, ...phrases]);
      flash(id);
    }
    setModal(null);
  };

  const askDelete = async (id: string) => {
    const p = phrases.find((x) => x.id === id);
    if (!p) return;
    const ok = await askConfirm({ message: t("tools.phraseDeleteAsk", { name: p.name }), confirmText: t("common.delete"), danger: true });
    if (!ok) return;
    if (expanded === id) setExpanded(null);
    snapshot();
    save(phrases.filter((x) => x.id !== id));
  };

  // ── 组内拖拽调序（FLIP，沿用 011 那套；跨组不拖）──────────────────────────
  const [dragId, setDragId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const prevRects = useRef(new Map<string, DOMRect>());
  const orderDirty = useRef(false);
  const lockUntil = useRef(0);
  const snapshot = () => {
    const m = new Map<string, DOMRect>();
    rowRefs.current.forEach((el, id) => m.set(id, el.getBoundingClientRect()));
    prevRects.current = m;
  };
  useLayoutEffect(() => {
    rowRefs.current.forEach((el, id) => {
      const before = prevRects.current.get(id);
      if (!before) return;
      const dy = before.top - el.getBoundingClientRect().top;
      if (!dy || id === dragId) return;
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => { el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(.2,.7,.3,1)`; el.style.transform = ""; });
    });
    prevRects.current.clear();
  }, [phrases, dragId]);
  const moveTo = (targetId: string, clientY: number) => {
    if (!dragId || dragId === targetId || Date.now() < lockUntil.current) return;
    const from = phrases.findIndex((p) => p.id === dragId);
    const to = phrases.findIndex((p) => p.id === targetId);
    if (from < 0 || to < 0) return;
    if ((phrases[from].keyword || "").trim() !== (phrases[to].keyword || "").trim()) return;   // 跨组不拖
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
    setPhrases(list);
  };
  const endDrag = () => {
    setDragId(null);
    lockUntil.current = 0;
    if (orderDirty.current) { orderDirty.current = false; void api.setPhrases(phrases); }
  };

  const openEdit = (p: Phrase) => setModal({ id: p.id, name: p.name, tag: p.keyword || "", content: p.content });

  const row = (p: Phrase) => {
    const open = expanded === p.id;
    const long = p.content.includes("\n") || p.content.length > 60;
    return (
      <div key={p.id}
        ref={(el) => { if (el) rowRefs.current.set(p.id, el); else rowRefs.current.delete(p.id); }}
        draggable
        onDragStart={(e) => {
          if (!fromHandle.current) { e.preventDefault(); return; }
          lockUntil.current = 0; setDragId(p.id);
          e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", p.id);
        }}
        onDragEnd={endDrag}
        onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; moveTo(p.id, e.clientY); } }}
        onDrop={(e) => { e.preventDefault(); endDrag(); }}
        className={dragId === p.id ? "opacity-45" : ""}>
        <GroupRow flash={flashId === p.id} active={open}
          onClick={() => setExpanded(open ? null : p.id)}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id: p.id }); }}>
          <span onMouseDown={() => { fromHandle.current = true; }} onMouseUp={() => { fromHandle.current = false; }}
            onClick={(e) => e.stopPropagation()}
            title={t("tools.dragToReorder")}
            className="flex-none flex items-center text-faint cursor-grab active:cursor-grabbing hover:text-orange-text">
            <IconGrip size={13} />
          </span>
          <span className="w-[132px] flex-none truncate text-[12.5px] font-medium">{p.name}</span>
          <span className="flex-1 min-w-0 truncate text-[12px] text-muted">{p.content.split("\n")[0]}</span>
          {long ? <span className="flex-none whitespace-nowrap text-[10.5px] text-faint font-mono">{t("tools.phraseChars", { n: p.content.length })}</span> : null}
          <span className="flex-none opacity-0 group-hover/row:opacity-100 transition-opacity duration-[130ms]">
            <button className={detailIconBtn} title={t("common.edit")} onClick={(e) => { e.stopPropagation(); openEdit(p); }}><IconPencil size={13} /></button>
          </span>
        </GroupRow>
        {open ? <RowExpand text={p.content} /> : null}
      </div>
    );
  };

  if (!hasLauncher) {
    return (
      <PageShell header={{ title: t("nav.phrases") }}>
        <EmptyState title={t("common.desktopOnly")} />
      </PageShell>
    );
  }

  return (
    <PageShell
      header={{
        title: t("nav.phrases"),
        subtitle: t("phrases.countN", { n: phrases.length }),
        status: <SyncStatus />,
        primary: { label: t("tools.phraseNew"), onClick: () => setModal({ id: null, name: "", tag: "", content: "" }) },
      }}
      settings={{
        title: t("phrases.settingsTitle"),
        backLabel: t("phrases.backLabel"),
        content: <PhrasesSettings phrases={phrases} tags={tags} onTags={(next) => { setTags(next); void api.setPhraseTags(next); }} onPhrases={save} />,
      }}>
      {phrases.length ? (
        <ListModal>
          {groups.map((g) => (
            <Group key={g.tag || "__none"} title={g.tag || t("phrases.untagged")} count={t("phrases.tagCount", { n: g.rows.length })}>
              <div onDragEnd={endDrag}>{g.rows.map(row)}</div>
            </Group>
          ))}
          <div className="text-[11.5px] text-faint leading-[1.6] px-[2px]">{t("settings.phrasesHint")}</div>
        </ListModal>
      ) : (
        <EmptyState title={t("settings.phrasesEmpty")} actionLabel={t("tools.phraseNew")}
          onAction={() => setModal({ id: null, name: "", tag: "", content: "" })} />
      )}

      {/* 编辑 / 新增弹窗（560 那档）：名称 + 标签（从清单里选）并排，内容区大块可拉伸。 */}
      {modal ? (
        <Modal width={560} title={modal.id ? t("tools.phraseEditTitle") : t("tools.phraseNew")}
          onClose={() => setModal(null)}
          footer={<>
            <span className="flex-1" />
            <button className={btn("ghost")} onClick={() => setModal(null)}>{t("common.cancel")}</button>
            <button className={btn("primary")} disabled={!modalValid} onClick={commitModal}>{t("common.save")}</button>
          </>}>
          <div className="flex flex-wrap gap-[8px]">
            <input autoFocus value={modal.name} onChange={(e) => setModal({ ...modal, name: e.target.value })}
              placeholder={t("settings.phraseName")} className={field("card")} style={{ flex: "1 1 240px", minWidth: 0 }} />
            <select value={modal.tag} onChange={(e) => setModal({ ...modal, tag: e.target.value })}
              className={selectCls()} style={{ flex: "0 1 168px", minWidth: 0 }} title={t("phrases.tagLabel")}>
              <option value="">{t("phrases.noTag")}</option>
              {tags.map((tg) => <option key={tg} value={tg}>{tg}</option>)}
            </select>
          </div>
          <div className="flex items-baseline gap-[8px] mt-[10px] mb-[6px]">
            <span className="flex-none text-[11.5px] font-semibold tracking-[.05em] text-faint">{t("settings.phraseContent")}</span>
            <span className="flex-1" />
            <span className="flex-none text-[10.5px] text-faint font-mono">{t("tools.phraseChars", { n: modal.content.length })}</span>
          </div>
          <textarea value={modal.content} onChange={(e) => setModal({ ...modal, content: e.target.value })}
            placeholder={t("tools.phraseContentPh")}
            className="w-full border border-border bg-bg text-text rounded-[9px] px-[11px] py-[9px] text-[12.5px] leading-[1.7] outline-none focus:border-orange resize-y"
            style={{ minHeight: 220, maxHeight: 300 }} />
          {!tags.length ? <div className="text-[11.5px] text-faint">{t("phrases.noTagsYet")}</div> : null}
        </Modal>
      ) : null}

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { label: t("common.edit"), onClick: () => { const p = phrases.find((x) => x.id === menu.id); if (p) openEdit(p); } },
          { divider: true },
          { label: t("common.delete"), danger: true, onClick: () => { void askDelete(menu.id); } },
        ]} />
      ) : null}
    </PageShell>
  );
}

// ── 常用语设置（T3）：标签管理 + 快捷键 + 同步 ─────────────────────────────
function PhrasesSettings({ phrases, tags, onTags, onPhrases }: {
  phrases: Phrase[]; tags: string[]; onTags: (next: string[]) => void; onPhrases: (next: Phrase[]) => void;
}) {
  const { t } = useTranslation();
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [merging, setMerging] = useState<{ from: string; to: string } | null>(null);
  // 清单里没有但短语用到的标签也列出来（老触发词自动成为标签）。
  const all = useMemo(() => {
    const out = [...tags];
    for (const p of phrases) { const k = (p.keyword || "").trim(); if (k && !out.includes(k)) out.push(k); }
    return out;
  }, [tags, phrases]);
  const countOf = (tag: string) => phrases.filter((p) => (p.keyword || "").trim() === tag).length;

  const addTag = () => {
    const v = newName.trim();
    if (!v) return;
    if (all.includes(v)) { showToast(t("phrases.tagExists"), { tone: "warn" }); return; }
    onTags([...all, v]);
    setNewName("");
  };
  const doRename = () => {
    if (!renaming) return;
    const to = renaming.to.trim();
    if (!to || to === renaming.from) { setRenaming(null); return; }
    if (all.includes(to)) { showToast(t("phrases.tagExists"), { tone: "warn" }); return; }
    onPhrases(phrases.map((p) => ((p.keyword || "").trim() === renaming.from ? { ...p, keyword: to } : p)));
    onTags(all.map((x) => (x === renaming.from ? to : x)));
    setRenaming(null);
  };
  const doMerge = () => {
    if (!merging || !merging.to || merging.to === merging.from) { setMerging(null); return; }
    onPhrases(phrases.map((p) => ((p.keyword || "").trim() === merging.from ? { ...p, keyword: merging.to } : p)));
    onTags(all.filter((x) => x !== merging.from));
    setMerging(null);
  };
  const doDelete = async (tag: string) => {
    const n = countOf(tag);
    const ok = await askConfirm({ message: t("phrases.deleteTagAsk", { name: tag, n }), confirmText: t("common.delete"), danger: true });
    if (!ok) return;
    // 删标签不删短语：短语转「无标签」。
    onPhrases(phrases.map((p) => ((p.keyword || "").trim() === tag ? { ...p, keyword: undefined } : p)));
    onTags(all.filter((x) => x !== tag));
  };
  const move = (tag: string, d: -1 | 1) => {
    const i = all.indexOf(tag);
    const j = i + d;
    if (i < 0 || j < 0 || j >= all.length) return;
    const next = all.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onTags(next);
  };

  // 快捷键（从原来的常用语页搬过来，逻辑不变）。
  const [shortcut, setShortcut] = useState(DEFAULT_PHRASES_SHORTCUT);
  const { recording, start } = useHotkeyRecorder((acc) => { setShortcut(acc); void clipApi().setPhrasesShortcut(acc); });
  const conflict = useHotkeyConflict("phrases", shortcut);
  useEffect(() => {
    if (!hasClip) return;
    void clipApi().getSettings().then((s) => { if (s.phrasesShortcut) setShortcut(s.phrasesShortcut); });
  }, []);

  return (
    <SettingsPage>
      <SettingsSection title={t("phrases.secTags")} desc={t("phrases.secTagsDesc")}>
        <RowsCard>
          {all.map((tag, i) => (
            <SettingRow key={tag} label={tag}>
              <RowHint>{t("phrases.tagCount", { n: countOf(tag) })}</RowHint>
              <button className={detailIconBtn} title={t("phrases.moveUp")} disabled={i === 0} onClick={() => move(tag, -1)}><IconUp size={13} /></button>
              <button className={detailIconBtn} title={t("phrases.moveDown")} disabled={i === all.length - 1} onClick={() => move(tag, 1)}><IconDown size={13} /></button>
              <button className={btn("ghost", "sm")} onClick={() => setRenaming({ from: tag, to: tag })}>{t("phrases.rename")}</button>
              <button className={btn("ghost", "sm")} disabled={all.length < 2} onClick={() => setMerging({ from: tag, to: "" })}>{t("phrases.mergeInto")}</button>
              <button className={btn("danger", "sm")} onClick={() => void doDelete(tag)}>{t("common.delete")}</button>
            </SettingRow>
          ))}
          <SettingRow label={t("phrases.addTag")}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("phrases.tagNamePh")}
              onKeyDown={(e) => { if (e.key === "Enter") addTag(); }} className={`flex-1 ${field("card")}`} />
            <button className={btn("ghost", "sm")} disabled={!newName.trim()} onClick={addTag}>{t("common.add")}</button>
          </SettingRow>
        </RowsCard>
      </SettingsSection>

      {hasClip ? (
        <SettingsSection title={t("phrases.secHotkey")} desc={t("settings.phrasesShortcutHint")}>
          {conflict ? <ErrorCard variant="strip" kind="warning" title={t("tools.hotkeyConflict", { owner: t(OWNER_LABEL[conflict]) })} /> : null}
          <RowsCard>
            <SettingRow label={t("settings.phrasesShortcut")}>
              <div className="flex-1 min-w-0 flex items-center gap-[8px]">
                <HotkeyButton recording={recording} value={shortcut} onClick={start} />
                <button className={btn("ghost")} onClick={() => { setShortcut(DEFAULT_PHRASES_SHORTCUT); void clipApi().setPhrasesShortcut(DEFAULT_PHRASES_SHORTCUT); }}>
                  {t("common.reset")}
                </button>
              </div>
            </SettingRow>
          </RowsCard>
        </SettingsSection>
      ) : null}

      <SettingsSection title={t("phrases.secSync")} desc={t("phrases.secSyncDesc")}>
        <RowsCard>
          <SettingRow label={t("phrases.secSync")}>
            <RowHint />
            <SyncStatus />
          </SettingRow>
        </RowsCard>
      </SettingsSection>

      {renaming ? (
        <Modal width={480} title={t("phrases.renameTitle")} onClose={() => setRenaming(null)} footer={<>
          <span className="flex-1" />
          <button className={btn("ghost")} onClick={() => setRenaming(null)}>{t("common.cancel")}</button>
          <button className={btn("primary")} disabled={!renaming.to.trim()} onClick={doRename}>{t("common.save")}</button>
        </>}>
          <input autoFocus value={renaming.to} onChange={(e) => setRenaming({ ...renaming, to: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") doRename(); }} className={`w-full ${field("card")}`} />
        </Modal>
      ) : null}
      {merging ? (
        <Modal width={480} title={t("phrases.mergeTitle", { name: merging.from })} onClose={() => setMerging(null)} footer={<>
          <span className="flex-1" />
          <button className={btn("ghost")} onClick={() => setMerging(null)}>{t("common.cancel")}</button>
          <button className={btn("primary")} disabled={!merging.to} onClick={doMerge}>{t("phrases.mergeDo")}</button>
        </>}>
          <select value={merging.to} onChange={(e) => setMerging({ ...merging, to: e.target.value })} className={`w-full ${selectCls()}`}>
            <option value="">{t("phrases.mergePick")}</option>
            {all.filter((x) => x !== merging.from).map((x) => <option key={x} value={x}>{x}（{t("phrases.tagCount", { n: countOf(x) })}）</option>)}
          </select>
          <div className="text-[11.5px] text-faint leading-[1.65]">{t("phrases.mergeHint", { n: countOf(merging.from) })}</div>
        </Modal>
      ) : null}
    </SettingsPage>
  );
}
