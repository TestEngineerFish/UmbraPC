// 工具 → 常用语：维护可在快捷入口里直接粘贴的短语列表（支持关键字直达、上下调序），
// 外加一把独立的全局快捷键 —— 按下后打开的是剪贴板面板的「常用语」分类（同一个弹框，默认列表不同）。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card, Row, btnGhost, toAccelerator } from "../../components/ui";
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
  const inputCls = "border border-border rounded-lg px-[10px] py-[6px] text-[12.5px] bg-bg text-text";

  return (
    <Card title={t("settings.phrases")} sub={t("settings.phrasesSub")}>
      {/* 常用语快捷键：唤起的是剪贴板面板，只是默认停在「常用语」分类 */}
      {hasClip ? (
        <>
          <Row label={t("settings.phrasesShortcut")}>
            <button
              onClick={() => setRecording(true)}
              className={`flex-1 text-left border rounded-lg px-[11px] py-[7px] text-[13px] font-mono bg-bg text-text ${recording ? "border-orange" : "border-border"}`}
            >
              {recording ? t("settings.pressShortcut") : shortcut || t("common.none")}
            </button>
            <button className={btnGhost} onClick={() => { setShortcut(DEFAULT_PHRASES_SHORTCUT); void clipApi().setPhrasesShortcut(DEFAULT_PHRASES_SHORTCUT); }}>
              {t("common.reset")}
            </button>
          </Row>
          <div className="text-[11.5px] text-muted -mt-[6px]">{t("settings.phrasesShortcutHint")}</div>
        </>
      ) : null}
      <div className="flex flex-col gap-1.5">
        {phrases.length ? phrases.map((p, i) => (
          <div key={p.id} className="flex items-center gap-2 bg-bg border border-border rounded-lg px-[10px] py-[7px]">
            <div className="flex flex-col leading-none mr-1">
              <button className="text-muted text-[10px] disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
              <button className="text-muted text-[10px] disabled:opacity-30" disabled={i === phrases.length - 1} onClick={() => move(i, 1)}>▼</button>
            </div>
            {editId === p.id ? (
              <div className="flex-1 flex items-center gap-1.5 flex-wrap">
                <input value={p.name} onChange={(e) => update(p.id, { name: e.target.value })} placeholder={t("settings.phraseName")} className={`w-[110px] ${inputCls}`} />
                <input value={p.keyword || ""} onChange={(e) => update(p.id, { keyword: e.target.value || undefined })} placeholder={t("settings.phraseKeyword")} className={`w-[90px] ${inputCls} font-mono`} />
                <input value={p.content} onChange={(e) => update(p.id, { content: e.target.value })} placeholder={t("settings.phraseContent")} className={`flex-1 min-w-[160px] ${inputCls}`} />
                <button className="px-[10px] py-[5px] bg-orange text-white rounded-lg text-[12px]" onClick={() => setEditId(null)}>{t("common.done")}</button>
              </div>
            ) : (
              <div className="flex-1 flex items-center gap-2 min-w-0 cursor-pointer" onClick={() => setEditId(p.id)}>
                <span className="font-medium text-[12.5px]">{p.name}</span>
                {p.keyword ? <span className="text-orange-text text-[11px]">{p.keyword}</span> : null}
                <span className="text-muted truncate flex-1 text-[11.5px]">{p.content}</span>
              </div>
            )}
            <button className="text-danger text-[12px]" onClick={() => save(phrases.filter((x) => x.id !== p.id))}>{t("common.delete")}</button>
          </div>
        )) : <div className="text-[12px] text-muted">{t("settings.phrasesEmpty")}</div>}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap pt-1">
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("settings.phraseName")} className={`w-[110px] ${inputCls}`} />
        <input value={draft.keyword} onChange={(e) => setDraft({ ...draft, keyword: e.target.value })} placeholder={t("settings.phraseKeyword")} className={`w-[90px] ${inputCls} font-mono`} />
        <input value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") add(); }} placeholder={t("settings.phraseContent")} className={`flex-1 min-w-[160px] ${inputCls}`} />
        <button className="px-[12px] py-[6px] bg-orange text-white rounded-lg text-[12.5px] font-semibold" onClick={add}>{t("common.add")}</button>
      </div>
      <div className="text-[11px] text-muted">{t("settings.phrasesHint")}</div>
    </Card>
  );
}
