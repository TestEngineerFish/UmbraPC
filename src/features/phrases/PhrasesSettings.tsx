// 常用语设置（页头齿轮进入，T3；批次 013 正式稿 · 稿 02 节 / tokens.phraseTags.settings）。
// **两组叠放，不出二级目录**：
//   ① 标签：分组头「标签」+ 右侧「顺序决定列表里的分组顺序」；卡内每行 min-height 48、padding 0 12 0 14、gap 11：
//      26 图标块（--chip 圆角 7，phrase 14）· 标签名 13/560 · 条数 12px --faint（flex 1）· ↑ 28 · ↓ 28 · ⋯ 28（改名 / 合并到… / 删除）。
//      「无标签」永远最后一行：↑↓ 禁用、没有 ⋯——它是兜底桶，不是标签。第一行 ↑ 禁用，倒数第二行（无标签之上）↓ 禁用。
//      卡底一条 --bg：「「无标签」不是标签，删不掉也排不动，永远在列表最后。」+ 「新增标签」28 描边钮（开 480 弹窗）。
//   ② 唤起与同步：行 1「唤起快捷键」+ kbd 芯片 + 「重新录制」（录制逻辑复用 useHotkeyRecorder）；行 2「云端同步」+ 同步戳。
// 排序用 ↑↓ 不做拖拽（裁定 10：几条标签不值得为设置视图再做一套 FLIP）。
// 合并 / 删除标签弹窗都是 480：删标签不是删数据，正文明写「不进回收站」，**不用** 30 天模板。
//
// 数据仍在主进程：标签清单与 phrases 由父级改好后一并写回（onTags / onPhrases）。
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ContextMenu, ErrorCard, Modal, btn, field, select as selectCls } from "../../components/ui";
import { SettingsPage, headerIconBtn } from "../../components/layout";
import { askConfirm, showToast } from "../../components/overlay";
import { useHotkeyRecorder } from "../../components/HotkeyRecorder";
import { displayAccel } from "../../components/hotkey";
import { useHotkeyConflict, OWNER_LABEL } from "../tools/hotkeys";
import { IconDots, IconDown, IconPhrase, IconUp } from "../../components/icons";
import { hasClip, type Phrase } from "../tools/bridges";
import { SyncStatus, tagOf } from "./shared";

// 右键 / ⋯ 菜单宽 168（ContextMenu 的定值），⋯ 钮下沿右对齐弹出时要用它算 x。
const MENU_W = 168;

export function PhrasesSettings({ phrases, tags, onTags, onPhrases, shortcut, onShortcut }: {
  phrases: Phrase[];
  tags: string[];
  onTags: (next: string[]) => void;
  onPhrases: (next: Phrase[]) => void;
  /** 唤起快捷键（Electron Accelerator）与写回。 */
  shortcut: string;
  onShortcut: (acc: string) => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState<string | null>(null);              // 新增标签弹窗的草稿；null = 没开
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [merging, setMerging] = useState<{ from: string; to: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; tag: string } | null>(null);
  // 清单里没有但短语用到的标签也列出来（老触发词自动成为标签）。
  const all = useMemo(() => {
    const out = [...tags];
    for (const p of phrases) { const k = tagOf(p); if (k && !out.includes(k)) out.push(k); }
    return out;
  }, [tags, phrases]);
  const countOf = (tag: string) => phrases.filter((p) => tagOf(p) === tag).length;
  const untagged = phrases.filter((p) => !tagOf(p)).length;

  const addTag = () => {
    const v = (adding || "").trim();
    if (!v) return;
    if (all.includes(v)) { showToast(t("phrases.tagExists"), { tone: "warn" }); return; }
    onTags([...all, v]);
    setAdding(null);
  };
  const doRename = () => {
    if (!renaming) return;
    const to = renaming.to.trim();
    if (!to || to === renaming.from) { setRenaming(null); return; }
    if (all.includes(to)) { showToast(t("phrases.tagExists"), { tone: "warn" }); return; }
    onPhrases(phrases.map((p) => (tagOf(p) === renaming.from ? { ...p, keyword: to } : p)));
    onTags(all.map((x) => (x === renaming.from ? to : x)));
    setRenaming(null);
  };
  const doMerge = () => {
    if (!merging || !merging.to || merging.to === merging.from) { setMerging(null); return; }
    onPhrases(phrases.map((p) => (tagOf(p) === merging.from ? { ...p, keyword: merging.to } : p)));
    onTags(all.filter((x) => x !== merging.from));
    setMerging(null);
  };
  // 删标签不删短语：短语转「无标签」，也不进回收站——所以二次确认不用 30 天模板，确认钮是实心红「删除标签」。
  const doDelete = async (tag: string) => {
    const ok = await askConfirm({
      title: t("phrases.deleteTagTitle", { name: tag }),
      message: t("phrases.deleteTagBody", { n: countOf(tag) }),
      confirmText: t("phrases.deleteTagDo"),
      danger: true,
    });
    if (!ok) return;
    onPhrases(phrases.map((p) => (tagOf(p) === tag ? { ...p, keyword: undefined } : p)));
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
  // ⋯ 贴钮下沿、右对齐弹出（同页头 ⋯ 的算法）。
  const openMore = (e: React.MouseEvent<HTMLButtonElement>, tag: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: Math.max(8, r.right - MENU_W), y: r.bottom + 4, tag });
  };

  // 唤起快捷键：录制逻辑复用 useHotkeyRecorder（录制期间关全局快捷键、Esc 取消、卸载收尾都在里面）。
  const { recording, start, stop } = useHotkeyRecorder((acc) => onShortcut(acc));
  const conflict = useHotkeyConflict("phrases", shortcut);

  const groupHead = "flex-none text-[11px] font-semibold tracking-[.06em] text-faint whitespace-nowrap";

  return (
    <SettingsPage>
      {/* ── ① 标签 ─────────────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-[8px]">
        <div className="flex items-center gap-[8px] px-[2px]">
          <span className={groupHead}>{t("phrases.secTags")}</span>
          <span className="flex-1" />
          <span className="flex-none text-[11px] text-faint whitespace-nowrap">{t("phrases.orderHint")}</span>
        </div>
        <div className="bg-card border border-border rounded-[12px] overflow-hidden">
          <div>
            {all.map((tag, i) => (
              <TagRow key={tag} name={tag} count={countOf(tag)}
                upDisabled={i === 0} downDisabled={i === all.length - 1}
                onUp={() => move(tag, -1)} onDown={() => move(tag, 1)} onMore={(e) => openMore(e, tag)} />
            ))}
            {/* 「无标签」永远最后：排不动也删不掉。 */}
            <TagRow name={t("phrases.untagged")} count={untagged} upDisabled downDisabled />
          </div>
          <div className="flex items-center gap-[10px] px-[14px] py-[11px] bg-bg">
            <span className="flex-1 min-w-0 text-[11.5px] text-faint leading-[1.6]">{t("phrases.untaggedNote")}</span>
            <button className={btn("ghost", "sm")} onClick={() => setAdding("")}>{t("phrases.addTag")}</button>
          </div>
        </div>
      </section>

      {/* ── ② 唤起与同步 ───────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-[8px]">
        <span className={`${groupHead} px-[2px]`}>{t("phrases.secInvoke")}</span>
        {conflict ? <ErrorCard variant="strip" kind="warning" title={t("tools.hotkeyConflict", { owner: t(OWNER_LABEL[conflict]) })} /> : null}
        <div className="bg-card border border-border rounded-[12px] overflow-hidden">
          {hasClip ? (
            <div className="flex items-center gap-[14px] min-h-[52px] px-[16px] py-[13px] border-b border-border-soft">
              <div className="flex-1 min-w-0">
                <div className="text-[13px]">{t("phrases.hotkeyTitle")}</div>
                <div className="text-[11.5px] text-faint mt-[3px] leading-[1.6]">{t("phrases.hotkeySub")}</div>
              </div>
              {/* kbd 芯片：等宽 12/600，--bg 底 1px 描边圆角 7；录制中整块转橙，比只换一句提示文案更容易被注意到。 */}
              <span className={`flex-none px-[10px] py-[4px] rounded-[7px] border font-mono text-[12px] font-semibold whitespace-nowrap ${
                recording ? "border-orange bg-orange-soft text-orange-text" : "border-border bg-bg text-text"}`}>
                {recording ? t("settings.pressShortcut") : displayAccel(shortcut) || t("common.none")}
              </span>
              <button className={btn("ghost", "sm")} onClick={recording ? stop : start}>
                {recording ? t("common.cancel") : t("phrases.rerecord")}
              </button>
            </div>
          ) : null}
          <div className="flex items-center gap-[14px] min-h-[52px] px-[16px] py-[13px]">
            <div className="flex-1 min-w-0">
              <div className="text-[13px]">{t("phrases.secSync")}</div>
              <div className="text-[11.5px] text-faint mt-[3px] leading-[1.6]">{t("phrases.syncSub")}</div>
            </div>
            {/* 稿画的是开关；主进程没有「关掉同步」的开关（配好服务器就同步），这里放同步戳 + 立即同步。 */}
            <SyncStatus />
          </div>
        </div>
      </section>

      {/* ── ⋯ 菜单：改名 / 合并到… / — / 删除 ───────────────────────────────── */}
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { label: t("phrases.rename"), onClick: () => setRenaming({ from: menu.tag, to: menu.tag }) },
          { label: t("phrases.mergeInto"), disabled: all.length < 2, onClick: () => setMerging({ from: menu.tag, to: "" }) },
          { divider: true },
          { label: t("common.delete"), danger: true, onClick: () => { void doDelete(menu.tag); } },
        ]} />
      ) : null}

      {/* ── 弹窗：新增 / 改名 / 合并（都是 480 单字段档）──────────────────────── */}
      {adding !== null ? (
        <Modal width={480} title={t("phrases.addTag")} onClose={() => setAdding(null)} footer={<>
          <span className="flex-1" />
          <button className={btn("ghost")} onClick={() => setAdding(null)}>{t("common.cancel")}</button>
          <button className={btn("primary")} disabled={!adding.trim()} onClick={addTag}>{t("common.add")}</button>
        </>}>
          <input autoFocus value={adding} onChange={(e) => setAdding(e.target.value)} placeholder={t("phrases.tagNamePh")}
            onKeyDown={(e) => { if (e.key === "Enter") addTag(); }} className={`w-full ${field("card")}`} />
        </Modal>
      ) : null}
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
        <Modal width={480} title={t("phrases.mergeAsk", { name: merging.from })} onClose={() => setMerging(null)} footer={<>
          <span className="flex-1" />
          <button className={btn("ghost")} onClick={() => setMerging(null)}>{t("common.cancel")}</button>
          <button className={btn("primary")} disabled={!merging.to} onClick={doMerge}>{t("phrases.mergeDo")}</button>
        </>}>
          <select autoFocus value={merging.to} onChange={(e) => setMerging({ ...merging, to: e.target.value })} className={`w-full ${selectCls()}`}>
            <option value="">{t("phrases.mergePick")}</option>
            {all.filter((x) => x !== merging.from).map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <div className="text-[12px] text-muted leading-[1.7]">
            {t("phrases.mergeBody", { from: merging.from, to: merging.to || "…", n: countOf(merging.from) })}
          </div>
        </Modal>
      ) : null}
    </SettingsPage>
  );
}

/** 标签管理的一行。没给 onMore 的是「无标签」那行：⋯ 的位置留空，↑↓ 列才不会比上面几行往右跳。 */
function TagRow({ name, count, upDisabled, downDisabled, onUp, onDown, onMore }: {
  name: string;
  count: number;
  upDisabled: boolean;
  downDisabled: boolean;
  onUp?: () => void;
  onDown?: () => void;
  onMore?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useTranslation();
  const iconBtn = `${headerIconBtn} disabled:opacity-40`;
  return (
    <div className="flex items-center gap-[11px] min-h-[48px] pl-[14px] pr-[12px] border-b border-border-soft last:border-b-0">
      <span className="w-[26px] h-[26px] flex-none rounded-[7px] bg-chip text-muted flex items-center justify-center"><IconPhrase size={14} /></span>
      <span className="flex-none text-[13px] font-[560] whitespace-nowrap">{name}</span>
      <span className="flex-1 min-w-0 text-[12px] text-faint whitespace-nowrap [font-variant-numeric:tabular-nums]">{t("phrases.tagCount", { n: count })}</span>
      <button className={iconBtn} title={t("phrases.moveUp")} disabled={upDisabled} onClick={onUp}><IconUp size={14} /></button>
      <button className={iconBtn} title={t("phrases.moveDown")} disabled={downDisabled} onClick={onDown}><IconDown size={14} /></button>
      {onMore
        ? <button className={headerIconBtn} title={t("layout.more")} onClick={onMore}><IconDots size={15} /></button>
        : <span className="w-[28px] h-[28px] flex-none" />}
    </div>
  );
}
