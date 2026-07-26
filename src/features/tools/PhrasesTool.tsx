// 工具 → 常用语：维护可在快捷入口里直接粘贴的短语列表（支持关键字直达、上下调序），
// 外加一把独立的全局快捷键 —— 按下后打开的是剪贴板面板的「常用语」分类（同一个弹框，默认列表不同）。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Pill, btnGhost, btnPrimary, btnIcon, inputSmall, inputHotkey, toAccelerator } from "../../components/ui";
import { HotkeyButton, HotkeyConflictBanner, useHotkeyConflict } from "./hotkeys";
import { IconUp, IconDown, IconTrash } from "../../components/icons";
import { launcherApi, clipApi, hasClip, type Phrase } from "./bridges";

// 常用语快捷键的出厂值（⌘⌥V，和剪贴板的 ⌘⇧V 同族好记）。
const DEFAULT_PHRASES_SHORTCUT = "Command+Alt+V";

export function PhrasesTool() {
  const { t } = useTranslation();
  const api = launcherApi();
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [draft, setDraft] = useState<{ name: string; keyword: string; content: string }>({ name: "", keyword: "", content: "" });
  const [editId, setEditId] = useState<string | null>(null);
  const [shortcut, setShortcut] = useState(DEFAULT_PHRASES_SHORTCUT);
  const [recording, setRecording] = useState(false);
  const conflict = useHotkeyConflict("phrases", shortcut);

  useEffect(() => { void api.getPhrases().then((p) => setPhrases(p || [])); }, []);
  useEffect(() => {
    if (!hasClip) return;
    void clipApi().getSettings().then((s) => { if (s.phrasesShortcut) setShortcut(s.phrasesShortcut); });
  }, []);

  // 录制快捷键：按下组合键即保存；Esc 取消。
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setRecording(false); return; }
      const acc = toAccelerator(e);
      if (!acc) return;
      setShortcut(acc); void clipApi().setPhrasesShortcut(acc); setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const save = (list: Phrase[]) => { setPhrases(list); void api.setPhrases(list); };

  const add = () => {
    if (!draft.content.trim()) return;
    const p: Phrase = { id: `ph${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: draft.name.trim() || draft.content.trim().slice(0, 20), content: draft.content.trim(), keyword: draft.keyword.trim() || undefined };
    save([...phrases, p]);
    setDraft({ name: "", keyword: "", content: "" });
  };
  const update = (id: string, patch: Partial<Phrase>) => save(phrases.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir; if (j < 0 || j >= phrases.length) return;
    const list = phrases.slice(); [list[i], list[j]] = [list[j], list[i]]; save(list);
  };
  // 调序用的小箭头：26px 的图标按钮在 9px 行高里放不下两个，所以这一对压到 13px 高。
  const moveBtn = "w-[18px] h-[13px] flex items-center justify-center bg-transparent border-none text-faint cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed";

  return (
    <>
      {/* 常用语快捷键：唤起的是剪贴板面板，只是默认停在「常用语」分类 */}
      {hasClip ? (
        <section className="bg-card border border-border rounded-[12px] p-[16px]">
          <div className="flex items-center gap-[14px]">
            <div className="w-[120px] flex-none whitespace-nowrap text-[13px]">{t("settings.phrasesShortcut")}</div>
            <div className="flex-1 min-w-0 flex items-center gap-[8px]">
              <HotkeyButton recording={recording} value={shortcut} onClick={() => setRecording(true)} />
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

        <div className="flex flex-col">
          {phrases.length ? phrases.map((p, i) => (
            <div key={p.id} className="flex items-center gap-[11px] p-[9px_16px] border-b border-border-soft hover:bg-hover">
              {/* 调序按钮拆成行内的兄弟节点，不套在整行按钮里，否则点箭头会连带触发「进入编辑」 */}
              <div className="flex-none flex flex-col">
                <button className={moveBtn} disabled={i === 0} onClick={() => move(i, -1)} title={t("tools.moveUp")}><IconUp size={11} /></button>
                <button className={moveBtn} disabled={i === phrases.length - 1} onClick={() => move(i, 1)} title={t("tools.moveDown")}><IconDown size={11} /></button>
              </div>
              {editId === p.id ? (
                <div className="flex-1 min-w-0 flex items-center gap-[8px]">
                  <input value={p.name} onChange={(e) => update(p.id, { name: e.target.value })} placeholder={t("settings.phraseName")} className={inputSmall} />
                  <input value={p.keyword || ""} onChange={(e) => update(p.id, { keyword: e.target.value || undefined })} placeholder={t("settings.phraseKeyword")} className={`${inputSmall} font-mono`} />
                  <input value={p.content} onChange={(e) => update(p.id, { content: e.target.value })} placeholder={t("settings.phraseContent")} className={inputHotkey} />
                  <button className={btnPrimary} onClick={() => setEditId(null)}>{t("common.done")}</button>
                </div>
              ) : (
                <div className="flex-1 min-w-0 flex items-center gap-[11px] cursor-pointer" onClick={() => setEditId(p.id)}>
                  <span className="w-[132px] flex-none truncate text-[12.5px] font-medium">{p.name}</span>
                  {p.keyword ? <Pill tone="accent" mono>{p.keyword}</Pill> : null}
                  <span className="flex-1 min-w-0 truncate text-[12px] text-muted">{p.content}</span>
                </div>
              )}
              <button className={`${btnIcon} hover:border-danger hover:text-danger`} title={t("common.delete")} onClick={() => save(phrases.filter((x) => x.id !== p.id))}>
                <IconTrash size={13} />
              </button>
            </div>
          )) : (
            <div className="p-[18px_16px] text-[12px] text-faint">{t("settings.phrasesEmpty")}</div>
          )}
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
    </>
  );
}
