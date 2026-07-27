// 工具 → 常用语：维护可在快捷入口里直接粘贴的短语列表（支持关键字直达、拖拽调序），
// 外加一把独立的全局快捷键 —— 按下后打开的是剪贴板面板的「常用语」分类（同一个弹框，默认列表不同）。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Pill, btnGhost, btnPrimary, btnIcon, inputSmall, inputHotkey, toAccelerator } from "../../components/ui";
import { HotkeyButton, HotkeyConflictBanner, useHotkeyConflict } from "./hotkeys";
import { IconGrip, IconTrash } from "../../components/icons";
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
  // 拖拽调序：手柄本身是 draggable 源，整行是放置目标。
  // 只让手柄可拖，不把 draggable 放在整行上——否则选中行内输入框里的文字都会被当成拖拽起手。
  const [dragI, setDragI] = useState<number | null>(null);
  const [overI, setOverI] = useState<number | null>(null);
  const endDrag = () => { setDragI(null); setOverI(null); };
  const dropAt = (to: number) => {
    if (dragI === null || dragI === to) { endDrag(); return; }
    const list = phrases.slice();
    const [it] = list.splice(dragI, 1);
    list.splice(to, 0, it);
    save(list);
    endDrag();
  };

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
            <div key={p.id}
              onDragOver={(e) => { if (dragI !== null) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOverI(i); } }}
              onDrop={(e) => { e.preventDefault(); dropAt(i); }}
              className={`flex items-center gap-[11px] p-[9px_16px] border-b border-border-soft ${
                dragI === i ? "opacity-40" : overI === i && dragI !== null ? "bg-orange-soft" : "hover:bg-hover"}`}>
              {/* 手柄是拖拽源，和整行并列而不是套在行按钮里，否则按下手柄会连带触发「进入编辑」 */}
              <span draggable
                onDragStart={(e) => { setDragI(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", p.id); }}
                onDragEnd={endDrag}
                title={t("tools.dragToReorder")}
                className="flex-none flex items-center text-faint cursor-grab active:cursor-grabbing hover:text-orange-text">
                <IconGrip size={13} />
              </span>
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
