// 常用语页三个文件（Phrases / PhraseRow / PhrasesSettings）共用的小零件：
//   · 行内小图标：手柄 / 铅笔 / 复制 / 勾 —— 取值照《PC 常用语与带图入口.dc.html》01 节的 path，
//     和 components/icons 里同名的那几枚形不一样（那边是 1.8 描边的通用形，这边是稿里给的行内形），
//     所以按简报「没有现成组件的就在文件里写内联 svg」放这里，不往 icons.tsx 里再塞一套近似形。
//   · 页头 / 设置视图共用的同步戳（SyncStamp + 立即同步）。
//   · 唤起快捷键的读写（clipApi 那份 phrasesShortcut）：空态文案与设置视图都要它。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SyncStamp } from "../../components/SyncStamp";
import { clipApi, hasClip, launcherApi, type Phrase, type PhraseSyncState } from "../tools/bridges";

// 常用语快捷键的出厂值（⌘⌥V，和剪贴板的 ⌘⇧V 同族好记）。
export const DEFAULT_PHRASES_SHORTCUT = "Command+Alt+V";
// 拖拽重排的动画时长。再长就显得拖沓，再短又看不出「让位」的过程。
export const FLIP_MS = 180;

/** 一条短语的标签（数据上就是 keyword，去空白；空串 = 无标签）。 */
export const tagOf = (p: Phrase): string => (p.keyword || "").trim();

// ── 行内小图标 ────────────────────────────────────────────────────────────────
const G = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** 六点拖手柄：13px / 描边 2.2（稿 01 节）。 */
export function GlyphGrip({ size = 13 }: { size?: number }) {
  return <svg width={size} height={size} {...G} strokeWidth={2.2}><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" /></svg>;
}
/** 铅笔：14px / 描边 2。 */
export function GlyphPencil({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} {...G} strokeWidth={2}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
}
/** 复制：15px / 描边 1.8。 */
export function GlyphCopy({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} {...G} strokeWidth={1.8}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></svg>;
}
/** 勾（复制成功后 2 秒）：15px / 描边 2。 */
export function GlyphCheck({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} {...G} strokeWidth={2}><path d="M20 6 9 17l-5-5" /></svg>;
}

// ── 同步戳 ────────────────────────────────────────────────────────────────────
/** 同步状态 + 立即同步按钮：页头 status 槽与设置视图「云端同步」行共用。 */
export function SyncStatus() {
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

// ── 唤起快捷键 ────────────────────────────────────────────────────────────────
/** 唤起快捷键（存在剪贴板那份设置里）：读一次，改了就写回主进程。没桥（Web 端）时停在出厂值只用来显示。 */
export function usePhrasesShortcut(): [string, (acc: string) => void] {
  const [shortcut, setShortcut] = useState(DEFAULT_PHRASES_SHORTCUT);
  useEffect(() => {
    if (!hasClip) return;
    void clipApi().getSettings().then((s) => { if (s.phrasesShortcut) setShortcut(s.phrasesShortcut); }).catch(() => {});
  }, []);
  const set = (acc: string) => { setShortcut(acc); if (hasClip) void clipApi().setPhrasesShortcut(acc); };
  return [shortcut, set];
}
