// 工具 → 常用语：维护可在快捷入口里直接粘贴的短语列表（支持关键字直达、上下调序）。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "../../components/ui";
import { launcherApi, type Phrase } from "./bridges";

export function PhrasesTool() {
  const { t } = useTranslation();
  const api = launcherApi();
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [draft, setDraft] = useState<{ name: string; keyword: string; content: string }>({ name: "", keyword: "", content: "" });
  const [editId, setEditId] = useState<string | null>(null);

  useEffect(() => { void api.getPhrases().then((p) => setPhrases(p || [])); }, []);
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
