// 任务页（React + Tailwind）。列表 + 刷新（轮询由 legacy setNav 驱动 → 触发 React 重渲染）+ 详情抽屉。
// 支持「管理」模式：多选 / 全选 / 批量删除。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as legacy from "../../app/shell";
import { deleteJobs } from "../../services/server";
import type { Job, JobDetail, Subtask } from "../../services/server";

type Kind = "ok" | "run" | "wait" | "fail" | "off";
const STATUS_KEYS: Record<string, [string, Kind]> = {
  done: ["tasks.statusDone", "ok"],
  running: ["tasks.statusRunning", "run"],
  pending: ["tasks.statusPending", "wait"],
  failed: ["tasks.statusFailed", "fail"],
  cancelled: ["tasks.statusCancelled", "off"],
};
const KIND_CLS: Record<Kind, string> = {
  ok: "bg-success-soft text-success",
  run: "bg-orange-soft text-orange-text",
  wait: "bg-warning-soft text-warning",
  fail: "bg-danger-soft text-danger",
  off: "bg-chip text-muted",
};

function Badge({ status }: { status: string }) {
  const { t } = useTranslation();
  const [key, kind] = STATUS_KEYS[status] || [status, "wait"];
  return <span className={`px-[10px] py-[2px] rounded-full text-[11px] font-semibold shrink-0 ${KIND_CLS[kind]}`}>{t(key)}</span>;
}

function isImg(u: string) {
  return /\.(png|jpe?g|gif|bmp|webp)(\?|$)/i.test(u);
}

export function Tasks() {
  const { t } = useTranslation();
  const tasks = legacy.getTasksState();
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const ids = tasks.list.map((j) => j.id);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
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
    await deleteJobs([...selected]);
    setBusy(false);
    exitSelect();
    legacy.manualRefresh();
  };

  const btn = "px-3 py-1.5 border border-border bg-card text-text rounded-lg text-[12.5px] cursor-pointer";
  return (
    <div className="h-full overflow-y-auto p-[18px_22px] relative">
      <div className="flex items-center justify-between mb-4">
        <h1 className="m-0 text-[16px] font-semibold">{t("tasks.title")}</h1>
        <div className="flex items-center gap-2">
          {selectMode ? (
            <>
              <button onClick={toggleAll} className={btn}>
                {allSelected ? t("tasks.deselectAll") : t("tasks.selectAll")}
              </button>
              <button
                onClick={() => setConfirming(true)}
                disabled={!selected.size || busy}
                className={`px-3 py-1.5 rounded-lg text-[12.5px] font-semibold ${selected.size ? "bg-danger text-white cursor-pointer" : "bg-chip text-muted cursor-not-allowed"}`}
              >
                {t("tasks.deleteN", { count: selected.size })}
              </button>
              <button onClick={exitSelect} className={btn}>{t("common.cancel")}</button>
            </>
          ) : (
            <>
              <button onClick={() => setSelectMode(true)} className={btn} disabled={!tasks.list.length}>
                {t("tasks.manage")}
              </button>
              <button onClick={() => legacy.manualRefresh()} className={`flex items-center gap-1.5 ${btn}`}>
                <span className={tasks.refreshing ? "inline-block animate-spin" : ""}>↻</span>
                {tasks.refreshing ? t("common.refreshing") : t("common.refresh")}
              </button>
            </>
          )}
        </div>
      </div>

      {confirming ? (
        <div className="mb-3 flex items-center justify-between gap-3 bg-danger-soft border border-danger rounded-lg px-[14px] py-[10px]">
          <span className="text-[13px] text-danger">{t("tasks.confirmDelete", { count: selected.size })}</span>
          <div className="flex gap-2 shrink-0">
            <button onClick={doDelete} disabled={busy} className="px-3 py-1.5 rounded-lg text-[12.5px] font-semibold bg-danger text-white cursor-pointer">
              {t("tasks.confirmDeleteBtn")}
            </button>
            <button onClick={() => setConfirming(false)} className={btn}>{t("common.cancel")}</button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2.5">
        {tasks.list.length ? (
          tasks.list.map((j) => (
            <TaskRow
              key={j.id}
              job={j}
              active={j.id === tasks.detailId}
              selectMode={selectMode}
              checked={selected.has(j.id)}
              onOpen={() => (selectMode ? toggle(j.id) : legacy.openJob(j.id))}
            />
          ))
        ) : (
          <div className="text-muted p-10 text-center">{tasks.loading ? t("tasks.loading") : t("tasks.empty")}</div>
        )}
      </div>

      {tasks.detailId && !selectMode ? <Drawer detailId={tasks.detailId} detail={tasks.detail} onClose={() => legacy.closeJob()} /> : null}
    </div>
  );
}

function TaskRow({
  job,
  active,
  selectMode,
  checked,
  onOpen,
}: {
  job: Job;
  active: boolean;
  selectMode: boolean;
  checked: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const failed = job.status === "failed";
  const sub = job.result_summary ? job.result_summary.slice(0, 70) : job.channel ? t("tasks.fromChannel", { channel: job.channel }) : "";
  const running = job.status === "running" || job.status === "pending";
  return (
    <div onClick={onOpen} className={`bg-card border rounded-xl p-[13px_16px] cursor-pointer ${(active && !selectMode) || checked ? "border-orange" : "border-border"}`}>
      <div className="flex items-center gap-[14px]">
        {selectMode ? (
          <span className={`w-[18px] h-[18px] rounded-md border-2 flex items-center justify-center shrink-0 ${checked ? "bg-orange border-orange text-white" : "border-border"}`}>
            {checked ? <span className="text-[11px] leading-none">✓</span> : null}
          </span>
        ) : null}
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{job.goal}</div>
          <div className={`text-[11.5px] mt-0.5 truncate ${failed ? "text-danger" : "text-muted"}`}>{sub || " "}</div>
        </div>
        <Badge status={job.status} />
        <span title={job.updated_at || ""} className="text-[12px] text-muted whitespace-nowrap shrink-0">
          {legacy.fmtListTime(job.updated_at)}
        </span>
      </div>
      {running ? (
        <div className="h-[3px] rounded-full bg-track overflow-hidden mt-[9px]">
          <div className="h-full w-[38%] bg-orange rounded-full" />
        </div>
      ) : null}
    </div>
  );
}

function Drawer({ detailId, detail, onClose }: { detailId: string; detail: JobDetail | null; onClose: () => void }) {
  const { t } = useTranslation();
  const loading = !detail || detail.job.id !== detailId;
  return (
    <>
      <div onClick={onClose} className="absolute inset-0 bg-black/30 z-30" />
      <div className="absolute top-0 right-0 bottom-0 w-[420px] bg-card border-l border-border z-[31] flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-muted">{t("tasks.loadingDetail")}</div>
        ) : (
          <DrawerBody d={detail!} onClose={onClose} />
        )}
      </div>
    </>
  );
}

function DrawerBody({ d, onClose }: { d: JobDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const subs = [...d.subtasks].sort((a, b) => a.seq - b.seq);
  const doneN = subs.filter((s) => s.status === "done").length;
  const pct = subs.length ? Math.round((doneN / subs.length) * 100) : d.job.status === "done" ? 100 : 0;
  const barColor = d.job.status === "failed" ? "bg-danger" : d.job.status === "done" ? "bg-success" : "bg-orange";
  return (
    <>
      <div className="flex items-start justify-between gap-2.5 p-[15px_20px] border-b border-border">
        <div className="min-w-0">
          <div className="font-semibold text-[15px]">{d.job.goal}</div>
          <div className="mt-[5px]">
            <Badge status={d.job.status} />
          </div>
        </div>
        <button onClick={onClose} className="border-0 bg-transparent text-muted cursor-pointer text-[20px] leading-none shrink-0">
          ×
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-[18px_20px] flex flex-col gap-5">
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] text-muted">{t("tasks.progress")}</span>
            <span className="text-[12px] text-orange-text font-semibold">{pct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-track overflow-hidden">
            <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
          </div>
        </div>

        <div>
          <div className="text-[12px] text-muted font-semibold mb-2.5">{t("tasks.steps")}</div>
          <div className="flex flex-col gap-[9px]">
            {subs.length ? subs.map((s) => <Step key={s.seq} s={s} />) : <div className="text-[12.5px] text-muted">{t("tasks.noSteps")}</div>}
          </div>
        </div>

        <div>
          <div className="text-[12px] text-muted font-semibold mb-2.5">{t("tasks.timeline")}</div>
          <div className="flex flex-col border-l-2 border-border ml-1">
            {d.events.length ? (
              d.events.map((e, i) => (
                <div key={i} className="relative pl-4 pb-[13px]">
                  <span className="absolute -left-[6px] top-[3px] w-[9px] h-[9px] rounded-full bg-orange" />
                  <span className="font-mono text-[11px] text-muted">{legacy.fmtTime(e.created_at, true)}</span>
                  <div className="text-[12.5px]">{e.message || e.type}</div>
                </div>
              ))
            ) : (
              <div className="text-[12.5px] text-muted pl-4">{t("tasks.noEvents")}</div>
            )}
          </div>
        </div>

        <Results subs={subs} />
      </div>
    </>
  );
}

function Step({ s }: { s: Subtask }) {
  const icon =
    s.status === "done" ? (
      <span className="w-[18px] h-[18px] rounded-full bg-success text-white flex items-center justify-center text-[11px] shrink-0">✓</span>
    ) : s.status === "failed" ? (
      <span className="w-[18px] h-[18px] rounded-full bg-danger text-white flex items-center justify-center text-[11px] shrink-0">✕</span>
    ) : s.status === "running" || s.status === "dispatched" ? (
      <span className="w-[18px] h-[18px] rounded-full border-2 border-orange shrink-0" />
    ) : (
      <span className="w-[18px] h-[18px] rounded-full border-2 border-border shrink-0" />
    );
  return (
    <div className={`flex items-center gap-[9px] text-[13px] ${s.status === "pending" ? "text-muted" : "text-text"}`}>
      {icon}
      <span className="truncate">{s.title || `${s.provider || ""}.${s.skill || ""}`}</span>
    </div>
  );
}

function Results({ subs }: { subs: Subtask[] }) {
  const { t } = useTranslation();
  const items: React.ReactNode[] = [];
  subs.forEach((s, i) => {
    if (!s.result_json) return;
    let r: { url?: string; filename?: string; project_dir?: string; path?: string; changed_files?: string[] };
    try {
      r = JSON.parse(s.result_json);
    } catch {
      return;
    }
    if (!r || typeof r !== "object") return;
    if (typeof r.url === "string") {
      const url = r.url;
      if (isImg(url)) items.push(<a key={`img${i}`} href={url} target="_blank" rel="noopener noreferrer"><img src={url} className="block max-w-full rounded-lg border border-border mb-1.5" /></a>);
      items.push(
        <div key={`u${i}`} className="flex items-center gap-2 text-[13px]">
          <span className="text-muted">📄</span>
          <a href={url} target="_blank" rel="noopener noreferrer" className="text-orange-text no-underline font-medium">
            {r.filename || t("tasks.downloadResult")}
          </a>
        </div>,
      );
    }
    if (typeof r.project_dir === "string") items.push(<div key={`pd${i}`} className="font-mono text-[11px] text-muted mt-[3px]">{r.project_dir}</div>);
    if (typeof r.path === "string") items.push(<div key={`p${i}`} className="font-mono text-[11px] text-muted mt-[3px]">{r.path}</div>);
    if (Array.isArray(r.changed_files) && r.changed_files.length) {
      const cf = r.changed_files;
      items.push(<div key={`cf${i}`} className="text-[11.5px] text-muted mt-1">{t("tasks.changedFiles", { count: cf.length, files: cf.slice(0, 8).join("、") + (cf.length > 8 ? " …" : "") })}</div>);
    }
  });
  if (!items.length) return null;
  return (
    <div>
      <div className="text-[12px] text-muted font-semibold mb-2.5">{t("tasks.results")}</div>
      <div className="flex flex-col gap-1">{items}</div>
    </div>
  );
}
