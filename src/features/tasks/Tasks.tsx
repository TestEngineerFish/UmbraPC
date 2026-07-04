// 任务页（React + Tailwind）。列表 + 刷新（轮询由 legacy setNav 驱动 → 触发 React 重渲染）+ 详情抽屉。
import * as legacy from "../../app/shell";
import type { Job, JobDetail, Subtask } from "../../services/server";

type Kind = "ok" | "run" | "wait" | "fail" | "off";
const STATUS: Record<string, [string, Kind]> = {
  done: ["已完成", "ok"],
  running: ["执行中", "run"],
  pending: ["待执行", "wait"],
  failed: ["失败", "fail"],
  cancelled: ["已取消", "off"],
};
const KIND_CLS: Record<Kind, string> = {
  ok: "bg-success-soft text-success",
  run: "bg-orange-soft text-orange-text",
  wait: "bg-warning-soft text-warning",
  fail: "bg-danger-soft text-danger",
  off: "bg-chip text-muted",
};

function Badge({ status }: { status: string }) {
  const [label, kind] = STATUS[status] || [status, "wait"];
  return <span className={`px-[10px] py-[2px] rounded-full text-[11px] font-semibold shrink-0 ${KIND_CLS[kind]}`}>{label}</span>;
}

function isImg(u: string) {
  return /\.(png|jpe?g|gif|bmp|webp)(\?|$)/i.test(u);
}

export function Tasks() {
  const t = legacy.getTasksState();
  return (
    <div className="h-full overflow-y-auto p-[18px_22px] relative">
      <div className="flex items-center justify-between mb-4">
        <h1 className="m-0 text-[16px] font-semibold">任务</h1>
        <button onClick={() => legacy.manualRefresh()} className="flex items-center gap-1.5 px-3 py-1.5 border border-border bg-card text-text rounded-lg text-[12.5px] cursor-pointer">
          <span className={t.refreshing ? "inline-block animate-spin" : ""}>↻</span>
          {t.refreshing ? "刷新中" : "刷新"}
        </button>
      </div>

      <div className="flex flex-col gap-2.5">
        {t.list.length ? (
          t.list.map((j) => <TaskRow key={j.id} job={j} active={j.id === t.detailId} onOpen={() => legacy.openJob(j.id)} />)
        ) : (
          <div className="text-muted p-10 text-center">{t.loading ? "加载任务中…" : "暂无任务"}</div>
        )}
      </div>

      {t.detailId ? <Drawer detailId={t.detailId} detail={t.detail} onClose={() => legacy.closeJob()} /> : null}
    </div>
  );
}

function TaskRow({ job, active, onOpen }: { job: Job; active: boolean; onOpen: () => void }) {
  const failed = job.status === "failed";
  const sub = job.result_summary ? job.result_summary.slice(0, 70) : job.channel ? `来自 ${job.channel}` : "";
  const running = job.status === "running" || job.status === "pending";
  return (
    <div onClick={onOpen} className={`bg-card border rounded-xl p-[13px_16px] cursor-pointer ${active ? "border-orange" : "border-border"}`}>
      <div className="flex items-center gap-[14px]">
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
  const loading = !detail || detail.job.id !== detailId;
  return (
    <>
      <div onClick={onClose} className="absolute inset-0 bg-black/30 z-30" />
      <div className="absolute top-0 right-0 bottom-0 w-[420px] bg-card border-l border-border z-[31] flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-muted">加载详情…</div>
        ) : (
          <DrawerBody d={detail!} onClose={onClose} />
        )}
      </div>
    </>
  );
}

function DrawerBody({ d, onClose }: { d: JobDetail; onClose: () => void }) {
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
            <span className="text-[12px] text-muted">总进度</span>
            <span className="text-[12px] text-orange-text font-semibold">{pct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-track overflow-hidden">
            <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
          </div>
        </div>

        <div>
          <div className="text-[12px] text-muted font-semibold mb-2.5">步骤</div>
          <div className="flex flex-col gap-[9px]">
            {subs.length ? subs.map((s) => <Step key={s.seq} s={s} />) : <div className="text-[12.5px] text-muted">（无步骤）</div>}
          </div>
        </div>

        <div>
          <div className="text-[12px] text-muted font-semibold mb-2.5">事件时间线</div>
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
              <div className="text-[12.5px] text-muted pl-4">（无事件）</div>
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
            {r.filename || "下载结果"}
          </a>
        </div>,
      );
    }
    if (typeof r.project_dir === "string") items.push(<div key={`pd${i}`} className="font-mono text-[11px] text-muted mt-[3px]">{r.project_dir}</div>);
    if (typeof r.path === "string") items.push(<div key={`p${i}`} className="font-mono text-[11px] text-muted mt-[3px]">{r.path}</div>);
    if (Array.isArray(r.changed_files) && r.changed_files.length) {
      const cf = r.changed_files;
      items.push(<div key={`cf${i}`} className="text-[11.5px] text-muted mt-1">变更 {cf.length} 个文件：{cf.slice(0, 8).join("、")}{cf.length > 8 ? " …" : ""}</div>);
    }
  });
  if (!items.length) return null;
  return (
    <div>
      <div className="text-[12px] text-muted font-semibold mb-2.5">生成结果</div>
      <div className="flex flex-col gap-1">{items}</div>
    </div>
  );
}
