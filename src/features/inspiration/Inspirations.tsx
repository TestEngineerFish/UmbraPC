// 灵感页（React + Tailwind）。列表 + 过滤 + 新增/编辑 + 状态切换 + 多选删除。
// 数据由 legacy shell 轮询（getInspState），变更后调 manualRefreshInsp 立即回读。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as legacy from "../../app/shell";
import { createInspiration, updateInspiration, deleteInspirations } from "../../services/server";
import type { Inspiration } from "../../services/server";

type Filter = "" | "open" | "done" | "archived";

const STATUS_CLS: Record<string, string> = {
  open: "bg-warning-soft text-warning",
  done: "bg-success-soft text-success",
  archived: "bg-chip text-muted",
};

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const label =
    status === "done" ? t("inspiration.statusDone") : status === "archived" ? t("inspiration.statusArchived") : t("inspiration.statusOpen");
  return <span className={`px-[9px] py-[2px] rounded-full text-[11px] font-semibold shrink-0 ${STATUS_CLS[status] || STATUS_CLS.open}`}>{label}</span>;
}

const btn = "px-3 py-1.5 border border-border bg-card text-text rounded-lg text-[12.5px] cursor-pointer";

export function Inspirations() {
  const { t } = useTranslation();
  const st = legacy.getInspState();
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Inspiration | null>(null); // 编辑中的条目
  const [adding, setAdding] = useState(false); // 新增表单显隐

  const ids = st.list.map((i) => i.id);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));

  const toggle = (id: number) =>
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(ids));
  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
    setConfirming(false);
  };
  const doDelete = async () => {
    if (!selected.size) return;
    setBusy(true);
    await deleteInspirations([...selected]);
    setBusy(false);
    exitSelect();
    legacy.manualRefreshInsp();
  };

  const setFilter = (f: Filter) => legacy.setInspFilter(f);
  const filter = st.filter as Filter;

  const filters: { key: Filter; label: string }[] = [
    { key: "", label: t("inspiration.filterAll") },
    { key: "open", label: t("inspiration.statusOpen") },
    { key: "done", label: t("inspiration.statusDone") },
    { key: "archived", label: t("inspiration.statusArchived") },
  ];

  return (
    <div className="h-full overflow-y-auto p-[18px_22px] relative">
      <div className="flex items-center justify-between mb-1">
        <div>
          <h1 className="m-0 text-[16px] font-semibold">{t("inspiration.title")}</h1>
          <div className="text-[12px] text-muted mt-0.5">{t("inspiration.subtitle")}</div>
        </div>
        <div className="flex items-center gap-2">
          {selectMode ? (
            <>
              <button onClick={toggleAll} className={btn}>{allSelected ? t("inspiration.deselectAll") : t("inspiration.selectAll")}</button>
              <button
                onClick={() => setConfirming(true)}
                disabled={!selected.size || busy}
                className={`px-3 py-1.5 rounded-lg text-[12.5px] font-semibold ${selected.size ? "bg-danger text-white cursor-pointer" : "bg-chip text-muted cursor-not-allowed"}`}
              >
                {t("inspiration.deleteN", { count: selected.size })}
              </button>
              <button onClick={exitSelect} className={btn}>{t("inspiration.cancel")}</button>
            </>
          ) : (
            <>
              <button onClick={() => { setAdding((v) => !v); setEditing(null); }} className="px-3 py-1.5 rounded-lg text-[12.5px] font-semibold bg-orange text-white cursor-pointer">{t("inspiration.add")}</button>
              <button onClick={() => setSelectMode(true)} className={btn} disabled={!st.list.length}>{t("inspiration.manage")}</button>
              <button onClick={() => legacy.manualRefreshInsp()} className={`flex items-center gap-1.5 ${btn}`}>
                <span className={st.refreshing ? "inline-block animate-spin" : ""}>↻</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* 过滤标签 */}
      <div className="flex items-center gap-1.5 my-3">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-[11px] py-1 rounded-full text-[12px] cursor-pointer border ${filter === f.key ? "bg-orange border-orange text-white font-semibold" : "bg-card border-border text-muted"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {adding ? <Editor onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); legacy.manualRefreshInsp(); }} /> : null}

      {confirming ? (
        <div className="mb-3 flex items-center justify-between gap-3 bg-danger-soft border border-danger rounded-lg px-[14px] py-[10px]">
          <span className="text-[13px] text-danger">{t("inspiration.confirmDelete", { count: selected.size })}</span>
          <div className="flex gap-2 shrink-0">
            <button onClick={doDelete} disabled={busy} className="px-3 py-1.5 rounded-lg text-[12.5px] font-semibold bg-danger text-white cursor-pointer">{t("inspiration.confirmDeleteBtn")}</button>
            <button onClick={() => setConfirming(false)} className={btn}>{t("inspiration.cancel")}</button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2.5">
        {st.list.length ? (
          st.list.map((i) =>
            editing && editing.id === i.id ? (
              <Editor key={i.id} item={i} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); legacy.manualRefreshInsp(); }} />
            ) : (
              <Card
                key={i.id}
                item={i}
                selectMode={selectMode}
                checked={selected.has(i.id)}
                onSelect={() => toggle(i.id)}
                onEdit={() => { setEditing(i); setAdding(false); }}
              />
            ),
          )
        ) : (
          <div className="text-muted p-10 text-center text-[13px]">{st.loading ? t("inspiration.loading") : t("inspiration.empty")}</div>
        )}
      </div>
    </div>
  );
}

function Card({
  item,
  selectMode,
  checked,
  onSelect,
  onEdit,
}: {
  item: Inspiration;
  selectMode: boolean;
  checked: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = item.title || item.raw.slice(0, 24) + (item.raw.length > 24 ? "…" : "");

  const setStatus = async (status: string) => {
    setBusy(true);
    await updateInspiration(item.id, { status });
    setBusy(false);
    legacy.manualRefreshInsp();
  };
  const copy = () => {
    const text = [item.title, item.raw, item.summary, item.tags.join(" ")].filter(Boolean).join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      onClick={selectMode ? onSelect : undefined}
      className={`bg-card border rounded-xl p-[13px_16px] ${selectMode ? "cursor-pointer" : ""} ${checked ? "border-orange" : "border-border"}`}
    >
      <div className="flex items-start gap-[12px]">
        {selectMode ? (
          <span className={`mt-0.5 w-[18px] h-[18px] rounded-md border-2 flex items-center justify-center shrink-0 ${checked ? "bg-orange border-orange text-white" : "border-border"}`}>
            {checked ? <span className="text-[11px] leading-none">✓</span> : null}
          </span>
        ) : null}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[14px] truncate">{title}</span>
            <StatusBadge status={item.status} />
          </div>
          <div className="text-[13px] text-text mt-1 whitespace-pre-wrap break-words">{item.raw}</div>
          {item.summary ? <div className="text-[12.5px] text-muted mt-1.5 whitespace-pre-wrap break-words">💡 {item.summary}</div> : null}
          {item.tags.length ? (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {item.tags.map((tag, k) => (
                <span key={k} className="px-[8px] py-[1px] rounded-full text-[11px] bg-chip text-muted">{tag}</span>
              ))}
            </div>
          ) : null}
          <div className="flex items-center gap-2 mt-2 text-[11px] text-muted">
            <span>{legacy.fmtListTime(item.created_at)}</span>
            {item.source_channel ? <span>· {item.source_channel === "manual" ? t("inspiration.sourceManual") : t("inspiration.sourceChat")}</span> : null}
          </div>
        </div>
      </div>

      {!selectMode ? (
        <div className="flex items-center gap-2 mt-2.5 pt-2.5 border-t border-border">
          {item.status !== "done" ? (
            <button onClick={() => setStatus("done")} disabled={busy} className="px-[10px] py-[4px] rounded-lg text-[11.5px] cursor-pointer bg-success-soft text-success">{t("inspiration.markDone")}</button>
          ) : (
            <button onClick={() => setStatus("open")} disabled={busy} className="px-[10px] py-[4px] rounded-lg text-[11.5px] cursor-pointer bg-warning-soft text-warning">{t("inspiration.markOpen")}</button>
          )}
          {item.status !== "archived" ? (
            <button onClick={() => setStatus("archived")} disabled={busy} className="px-[10px] py-[4px] rounded-lg text-[11.5px] cursor-pointer bg-chip text-muted">{t("inspiration.archive")}</button>
          ) : null}
          <div className="flex-1" />
          <button onClick={onEdit} className="px-[10px] py-[4px] rounded-lg text-[11.5px] cursor-pointer border border-border text-text">{t("inspiration.edit")}</button>
          <button onClick={copy} className="px-[10px] py-[4px] rounded-lg text-[11.5px] cursor-pointer border border-border text-text">{copied ? t("inspiration.copied") : t("inspiration.copy")}</button>
        </div>
      ) : null}
    </div>
  );
}

// 新增/编辑表单（item 存在=编辑，否则新增）。
function Editor({ item, onCancel, onSaved }: { item?: Inspiration; onCancel: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState(item?.raw || "");
  const [title, setTitle] = useState(item?.title || "");
  const [tags, setTags] = useState((item?.tags || []).join(", "));
  const [note, setNote] = useState(item?.summary || "");
  const [busy, setBusy] = useState(false);

  const parseTags = () => tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const save = async () => {
    if (!raw.trim()) return;
    setBusy(true);
    if (item) await updateInspiration(item.id, { raw, title, summary: note, tags: parseTags() });
    else await createInspiration({ raw, title, summary: note, tags: parseTags() });
    setBusy(false);
    onSaved();
  };

  const input = "w-full bg-card border border-border rounded-lg px-3 py-2 text-[13px] text-text outline-none focus:border-orange";
  return (
    <div className="bg-card border border-orange rounded-xl p-[14px_16px] mb-2.5 flex flex-col gap-2.5">
      <textarea value={raw} onChange={(e) => setRaw(e.target.value)} placeholder={t("inspiration.rawPh")} rows={3} className={`${input} resize-y`} />
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("inspiration.titlePh")} className={input} />
      <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t("inspiration.tagsPh")} className={input} />
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("inspiration.notePh")} className={input} />
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className={btn}>{t("inspiration.cancel")}</button>
        <button onClick={save} disabled={busy || !raw.trim()} className={`px-3 py-1.5 rounded-lg text-[12.5px] font-semibold ${raw.trim() ? "bg-orange text-white cursor-pointer" : "bg-chip text-muted cursor-not-allowed"}`}>{t("inspiration.save")}</button>
      </div>
    </div>
  );
}
