// 任务页（React + Tailwind）。结构对齐 ClaudeDesign 的任务稿：
// 左边 452px 列表列（--rail 底：标题+计数+管理/刷新、搜索、筛选胶囊、任务卡），
// 右边详情列（状态徽章+标题+统计条+总进度，下面「步骤」与「事件时间线」两栏）。
// 原来的浮层抽屉撤了 —— 详情常驻右侧，切任务不再一层层盖。
// 轮询由 legacy setNav 驱动（触发 React 重渲染），选中项仍走 legacy 的 detailId/detail。
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as legacy from "../../app/shell";
import { deleteTasks, getServerUrl, retryTask, stopTask } from "../../services/server";
import type { TaskItem, TaskDetail, StepError, TaskStep } from "../../services/server";
import { ImageViewer } from "../../components/ImageViewer";
import { btnGhost, btnDanger, RefreshButton, filterChip, filterChipCount, ErrorCard, EmptyState } from "../../components/ui";
import { showToast } from "../../components/overlay";
import { IconSearch, IconRefresh, IconCheck, IconX, IconClock, IconAlert, IconFolder } from "../../components/icons";
import { mdToHtml } from "../chat/markdown";

// 全局图片预览：任意 Step 图片点击后打开（避免逐层透传 onClick）。
let openPreview: (src: string, alt?: string) => void = () => {};

// 从步骤结果里收集所有可点的 url（顶层 + device_results 两层；相对路径拼服务端地址）。
// url 藏两层是服务端的真实形状：技能直回的在顶层，执行轮聚合的设备结果在
// device_results[]（截图任务的 url 就在这层）——只看顶层等于大多数时候看不见。
function stepUrls(s: TaskStep): { url: string; name: string }[] {
  if (!s.result_json) return [];
  const out: { url: string; name: string }[] = [];
  try {
    const r = JSON.parse(s.result_json);
    if (!r || typeof r !== "object") return [];
    const cands = [...(Array.isArray(r.device_results) ? r.device_results : []), r];
    for (const d of cands) {
      if (!d || typeof d.url !== "string" || !d.url) continue;
      const url = d.url.startsWith("http") ? d.url : getServerUrl() + d.url;
      if (out.some((x) => x.url === url)) continue;
      out.push({ url, name: (typeof d.filename === "string" && d.filename) || url.split("/").pop() || "产出" });
    }
  } catch { /* ignore */ }
  return out;
}

// 该步的内联截图：结果里第一个图片类 url。
function stepShot(s: TaskStep): string | null {
  return stepUrls(s).find((x) => isImg(x.url))?.url || null;
}

// 从截图 URL 里抠出文件名给脚注用。带查询串的先切掉 ?，解码失败就用原样 ——
// 一个文件名而已，不值得为它抛异常把整个详情页拖垮。
function shotName(url: string): string {
  try {
    const path = url.split("?")[0];
    return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)) || path;
  } catch {
    return url.split("/").pop() || url;
  }
}

// ── 状态语义（徽章配色 + 图标 + 进度条颜色的唯一来源）──
// 绿=已完成，橙=执行中，黄=已挂起（等设备/等外部条件），红=失败，灰=待执行/已取消。
type Tone = "success" | "orange" | "warning" | "danger" | "neutral";
const STATUS_META: Record<string, { key: string; tone: Tone }> = {
  done: { key: "tasks.statusDone", tone: "success" },
  running: { key: "tasks.statusRunning", tone: "orange" },
  suspended: { key: "tasks.statusSuspended", tone: "warning" },
  pending: { key: "tasks.statusPending", tone: "neutral" },
  failed: { key: "tasks.statusFailed", tone: "danger" },
  cancelled: { key: "tasks.statusCancelled", tone: "neutral" },
};
// 徽章 / 图标块的底色与前景色。写成两张表而不是拼字符串，是因为同类工具类不能靠顺序覆盖。
const TONE_SOFT: Record<Tone, string> = {
  success: "bg-success-soft text-success", orange: "bg-orange-soft text-orange-text",
  warning: "bg-warning-soft text-warning", danger: "bg-danger-soft text-danger", neutral: "bg-chip text-muted",
};
const TONE_BAR: Record<Tone, string> = {
  success: "bg-success", orange: "bg-orange", warning: "bg-warning", danger: "bg-danger", neutral: "bg-muted",
};
const TONE_TEXT: Record<Tone, string> = {
  success: "text-success", orange: "text-orange-text", warning: "text-warning", danger: "text-danger", neutral: "text-muted",
};
function StatusIcon({ status, size = 13 }: { status: string; size?: number }) {
  if (status === "done") return <IconCheck size={size} />;
  if (status === "failed") return <IconX size={size} />;
  if (status === "running") return <IconRefresh size={size} />;
  if (status === "suspended") return <IconAlert size={size} />;
  return <IconClock size={size} />;
}

const metaOf = (status: string) => STATUS_META[status] || { key: status, tone: "neutral" as Tone };

function isImg(u: string) {
  // /files/<id> 是服务端文件接口，通常没有扩展名 —— 截图任务的产出就长这样。
  // 按图片试渲染；真不是图时内联 <img> 的 onError 会把自己藏起来，不留破图标。
  return /\.(png|jpe?g|gif|bmp|webp)(\?|$)/i.test(u) || /\/files\//.test(u);
}

// 里程碑进度百分比。没有 steps_total 的旧任务行按状态兜底（完成=100，其余=0），不编假进度。
function pctOf(task: TaskItem): number {
  if (task.steps_total) return Math.round(((task.steps_done || 0) / task.steps_total) * 100);
  return task.status === "done" ? 100 : 0;
}

// 耗时：created_at → updated_at（执行中的算到现在）。这是整任务的量级；每步各自的耗时在步骤行（elapsed_ms）。
function durationOf(task: TaskItem, t: (k: string, o?: Record<string, unknown>) => string): string {
  const a = task.created_at ? Date.parse(task.created_at.replace(" ", "T")) : NaN;
  if (Number.isNaN(a)) return "—";
  const running = task.status === "running" || task.status === "pending";
  const bRaw = running ? Date.now() : task.updated_at ? Date.parse(task.updated_at.replace(" ", "T")) : NaN;
  if (Number.isNaN(bRaw) || bRaw < a) return "—";
  const human = humanMs(bRaw - a);
  if (task.status === "failed") return t("tasks.durInterrupted", { human });
  if (running) return t("tasks.durRunning", { human });
  return human;
}
// 毫秒 → 「6秒 / 4分08秒 / 1小时12分」。只给两个量级，够看了。
function humanMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${String(s % 60).padStart(2, "0")}秒`;
  return `${Math.floor(m / 60)}小时${String(m % 60).padStart(2, "0")}分`;
}

export function Tasks() {
  const { t } = useTranslation();
  const tasks = legacy.getTasksState();
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [preview, setPreview] = useState<{ src: string; alt?: string } | null>(null);
  openPreview = (src, alt) => setPreview({ src, alt });

  // 搜索命中范围：短标题 + 详细描述 + 结果摘要（错误信息通常落在 result_summary 里）。
  const kw = q.trim().toLowerCase();
  const list = useMemo(() => tasks.list.filter((j) => {
    if (filter !== "all" && j.status !== filter) return false;
    if (!kw) return true;
    return `${j.name || ""} ${j.goal} ${j.result_summary || ""}`.toLowerCase().includes(kw);
  }), [tasks.list, filter, kw]);

  // 筛选胶囊的计数与徽章同源（都直接用服务端状态）。
  // cancelled / suspended 没有单独的档，只出现在「全部」里。
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: tasks.list.length };
    for (const j of tasks.list) {
      c[j.status] = (c[j.status] || 0) + 1;
    }
    return c;
  }, [tasks.list]);
  const FILTERS: { k: string; label: string }[] = [
    { k: "all", label: t("tasks.filterAll") },
    { k: "running", label: t("tasks.statusRunning") },
    { k: "pending", label: t("tasks.statusPending") },
    { k: "done", label: t("tasks.statusDone") },
    { k: "failed", label: t("tasks.statusFailed") },
  ];

  // 没有选中项时自动打开第一条：详情列常驻，空着一大片不如直接给内容。
  // openedRef 防止拉取失败时每次重渲染都重发请求。
  const openedRef = useRef(false);
  useEffect(() => {
    if (tasks.detailId || selectMode || !list.length) return;
    if (openedRef.current) return;
    openedRef.current = true;
    void legacy.openTask(list[0].id);
  }, [tasks.detailId, selectMode, list]);

  const ids = list.map((j) => j.id);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  const toggle = (id: string) => setSelected((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const exitSelect = () => { setSelectMode(false); setSelected(new Set()); setConfirming(false); };
  const doDelete = async () => {
    if (!selected.size) return;
    setBusy(true);
    const r = await deleteTasks([...selected]);
    setBusy(false);
    exitSelect();
    legacy.manualRefresh();
    // 服务端只删得动终态的任务，还在跑的要先停止（回收站方案 D1）。
    // **这句必须说出来**：删除数比请求的少而界面一声不吭，用户看到的是
    // 「我点了删除，它没反应」—— 最难受也最难查的一种失败。
    if (r.busy.length) {
      showToast(t("tasks.deleteBusy", { count: r.busy.length }), { tone: "warn" });
    } else if (r.deleted) {
      showToast(t("tasks.deletedToTrash", { count: r.deleted }), { tone: "ok" });
    }
  };

  return (
    <div className="h-full flex min-h-0">
      {/* ── 列表列 ── */}
      <section className="w-[452px] flex-none border-r border-border bg-rail flex flex-col min-h-0">
        <div className="flex-none flex flex-col gap-[11px] p-[14px_14px_11px] border-b border-border">
          <div className="flex items-center gap-[9px]">
            <span className="flex-none whitespace-nowrap text-[16px] font-semibold">{t("tasks.title")}</span>
            <span className="flex-1 min-w-0 truncate text-[11.5px] text-faint">
              {t("tasks.countLine", { n: tasks.list.length, running: counts.running || 0 })}
            </span>
            {selectMode ? (<>
              <button className={btnGhost} onClick={() => setSelected(allSelected ? new Set() : new Set(ids))}>
                {allSelected ? t("tasks.deselectAll") : t("tasks.selectAll")}
              </button>
              <button className={btnDanger} disabled={!selected.size || busy} onClick={() => setConfirming(true)}>
                {t("tasks.deleteN", { count: selected.size })}
              </button>
              <button className={btnGhost} onClick={exitSelect}>{t("common.cancel")}</button>
            </>) : (<>
              <button className={btnGhost} disabled={!tasks.list.length} onClick={() => setSelectMode(true)}>{t("tasks.manage")}</button>
              <RefreshButton onClick={() => legacy.manualRefresh()} spinning={tasks.refreshing} />
            </>)}
          </div>

          <div className="flex items-center gap-[7px] bg-card border border-border rounded-[8px] px-[9px] py-[5px]">
            <span className="flex-none text-faint"><IconSearch size={12} /></span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("tasks.searchPlaceholder")}
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-[12px]" />
          </div>

          {/* 五档筛选（待确认那档随旧代理状态一起删了 —— B 批后任务只有服务端那六个状态）。
              flex-wrap 让它窄窗折行，不要挤成一条压扁的胶囊带。 */}
          <div className="flex flex-wrap gap-[4px]">
            {FILTERS.map((f) => {
              const on = filter === f.k;
              return (
                <button key={f.k} onClick={() => setFilter(f.k)} className={filterChip(on, "sm")}>
                  <span>{f.label}</span>
                  <span className={filterChipCount(on)}>{counts[f.k] || 0}</span>
                </button>
              );
            })}
          </div>
        </div>

        {confirming ? (
          <div className="flex-none m-[9px_9px_0] flex items-center gap-[10px] bg-danger-soft border border-danger rounded-[10px] px-[12px] py-[10px]">
            <span className="flex-1 min-w-0 text-[12.5px]">{t("tasks.confirmDelete", { count: selected.size })}</span>
            <button className={btnDanger} disabled={busy} onClick={doDelete}>{t("tasks.confirmDeleteBtn")}</button>
            <button className={btnGhost} onClick={() => setConfirming(false)}>{t("common.cancel")}</button>
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto p-[9px] flex flex-col gap-[7px]">
          {list.map((j) => (
            <TaskCard key={j.id} task={j} active={j.id === tasks.detailId && !selectMode}
              selectMode={selectMode} checked={selected.has(j.id)}
              onOpen={() => (selectMode ? toggle(j.id) : legacy.openTask(j.id))} />
          ))}
          {/* 空态走通用空态件。compact 是因为它落在 452px 的列表列里，不是主区。
              「搜索无结果」和「一条都没有」给的是两套动作：前者该能一键清掉筛选，
              后者清筛选没有意义。加载中不给动作 —— 那不是空，是还没到。 */}
          {!list.length ? (
            <div className="py-6">
              <EmptyState
                compact
                title={tasks.loading ? t("tasks.loading") : kw ? t("tasks.noMatch", { q: kw }) : filter !== "all" ? t("tasks.noneInFilter") : t("tasks.empty")}
                actionLabel={!tasks.loading && (kw || filter !== "all") ? t("tasks.clearFilter") : undefined}
                onAction={!tasks.loading && (kw || filter !== "all") ? () => { setQ(""); setFilter("all"); } : undefined}
              />
            </div>
          ) : null}
        </div>
      </section>

      {/* ── 详情列 ── */}
      <main className="flex-1 min-w-0 flex flex-col min-h-0 bg-bg">
        {/* onChanged：重试/停止改了服务端状态之后重拉列表与详情——不然按钮按完界面纹丝不动。
            注释放在三元外面：放进表达式容器里会被当成对象字面量，编译不过（灵感页踩过一次）。 */}
        {tasks.detailId && tasks.detail && tasks.detail.task.id === tasks.detailId ? (
          <Detail key={tasks.detail.task.id} d={tasks.detail}
            onChanged={() => { void legacy.manualRefresh(); void legacy.openTask(tasks.detail!.task.id); }} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-[12.5px] text-muted">
            {tasks.detailId ? t("tasks.loadingDetail") : t("tasks.pickOne")}
          </div>
        )}
      </main>

      <ImageViewer src={preview?.src ?? null} alt={preview?.alt} onClose={() => setPreview(null)} />
    </div>
  );
}

// 列表里的一张任务卡。选中态用「橙描边 + 左侧 3px 橙条」，比只换描边更容易在一屏卡片里找到。
function TaskCard({ task, active, selectMode, checked, onOpen }: {
  task: TaskItem; active: boolean; selectMode: boolean; checked: boolean; onOpen: () => void;
}) {
  const { t } = useTranslation();
  const st = task.status;
  const m = metaOf(st);
  const pct = pctOf(task);
  const running = st === "running";
  const total = task.steps_total || 0;
  const done = task.steps_done || 0;
  // 里程碑小格：步数多时格子变窄，免得把一行撑破。
  const pipW = total > 6 ? "w-[4px]" : "w-[9px]";
  const err = st === "failed" ? task.result_summary || "" : "";
  const sub = task.name ? task.goal : task.channel ? t("tasks.fromChannel", { channel: task.channel }) : task.result_summary || "";

  return (
    <div onClick={onOpen}
      className={`bg-card border rounded-[11px] p-[11px_13px] cursor-pointer ${
        active || checked ? "border-orange shadow-[inset_3px_0_0_var(--orange)]" : "border-border hover:border-orange"}`}>
      <div className="flex items-start gap-[10px]">
        {selectMode ? (
          <span className={`w-4 h-4 flex-none mt-[2px] rounded-[5px] flex items-center justify-center border-[1.5px] ${
            checked ? "bg-orange border-orange text-white" : "bg-transparent border-border"}`}>
            {checked ? <IconCheck size={11} /> : null}
          </span>
        ) : null}
        <span className={`w-6 h-6 flex-none rounded-[7px] flex items-center justify-center ${TONE_SOFT[m.tone]}`}>
          <StatusIcon status={st} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-[8px]">
            <span className="flex-1 min-w-0 text-[13px] font-medium leading-[1.45] line-clamp-2">{task.name || task.goal}</span>
            <span className="flex-none whitespace-nowrap text-[10.5px] text-faint" title={task.updated_at || ""}>{legacy.fmtListTime(task.updated_at)}</span>
          </div>
          <div className="flex items-center gap-[8px] mt-[5px]">
            <span className={`flex-none whitespace-nowrap px-[8px] py-px rounded-full text-[10.5px] font-semibold ${TONE_SOFT[m.tone]}`}>{t(m.key)}</span>
            {total ? (
              <span className="flex-none flex gap-[3px]">
                {Array.from({ length: total }, (_, i) => (
                  <span key={i} className={`${pipW} h-[3px] rounded-full flex-none ${i < done ? TONE_BAR[m.tone] : "bg-track"}`} />
                ))}
              </span>
            ) : null}
            <span className="flex-1 min-w-0 truncate text-[11px] text-muted">{sub}</span>
          </div>
          {err ? (
            <div className="mt-[7px] bg-danger-soft rounded-[7px] px-[9px] py-[6px] flex gap-[7px] items-start">
              <span className="flex-none mt-[2px] text-danger"><IconAlert size={12} /></span>
              <span className="flex-1 min-w-0 text-[11.5px] text-danger leading-[1.55] line-clamp-2">{err}</span>
            </div>
          ) : null}
          {running && total ? (
            <div className="mt-[8px] flex items-center gap-[8px]">
              <span className="flex-1 h-[4px] rounded-full bg-track overflow-hidden">
                <span className="block h-full bg-orange rounded-full" style={{ width: `${pct}%` }} />
              </span>
              <span className="flex-none whitespace-nowrap text-[11px] font-semibold text-orange-text">{pct}%</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// 把任务详情序列化成纯文本，方便一键复制发出去调试。
function detailToText(d: TaskDetail): string {
  const subs = [...d.steps].sort((a, b) => a.seq - b.seq);
  const lines: string[] = [];
  lines.push(`任务：${d.task.goal}`);
  lines.push(`状态：${d.task.status}`);
  if (d.task.result_summary) lines.push(`结果：${d.task.result_summary}`);
  lines.push("", "步骤：");
  subs.forEach((s) => {
    lines.push(`  ${s.seq + 1}. [${s.status}] ${s.title || `${s.provider || ""}.${s.skill || ""}`}${s.error ? ` — 错误：${s.error}` : ""}`);
    // 说明单起一行缩进：它是这一步真正干了什么，复制出去排查时最有用的往往就是这句。
    if (s.detail) lines.push(`      ${s.detail}`);
  });
  lines.push("", "事件时间线：");
  d.events.forEach((e) => lines.push(`  [${(e.created_at || "").replace("T", " ").slice(0, 19)}] ${e.message || e.type}`));
  return lines.join("\n");
}

function Detail({ d, onChanged }: { d: TaskDetail; onChanged: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  // 重试/停止的进行中标志与失败提示。成功不提示——列表会自己刷新，状态胶囊就是反馈。
  const [busy, setBusy] = useState("");
  const [actErr, setActErr] = useState("");
  const [retryNote, setRetryNote] = useState("");
  // 目标描述默认收起（两行截断）；这份 state 靠外层的 key={job.id} 在切换任务时自动重置。
  const [descOpen, setDescOpen] = useState(false);
  const st = d.task.status;
  const m = metaOf(st);
  const subs = useMemo(() => [...d.steps].sort((a, b) => a.seq - b.seq), [d.steps]);
  const total = d.task.steps_total || subs.length;
  const done = d.task.steps_total ? (d.task.steps_done || 0) : subs.filter((s) => s.status === "done").length;
  const pct = total ? Math.round((done / total) * 100) : pctOf(d.task);
  const kind = d.task.channel || "";
  // 失败卡用的错误：取第一个失败步骤的结构化错误（比任务级的 result_summary 具体）。
  const failErr: StepError | null = useMemo(
    () => subs.map((x) => normErr(x.error)).find(Boolean) || null, [subs]);
  // task.name 存在时 goal 才是「描述」；没有 name 时 goal 已经顶在标题位置了，不重复铺一遍。
  const desc = d.task.name ? (d.task.goal || "") : "";

  // 执行设备：任务本身不绑定设备（去设备化模型），设备是**逐步骤**记的，
  // 所以这里把各步骤的设备去重列出来 —— 一个任务确实可能跨设备跑。
  // 一台都没有（纯 server 步）时整格不出现，不摆破折号占位。
  const devices = useMemo(
    () => [...new Set(subs.map((s) => s.device_id).filter(Boolean) as string[])],
    [subs],
  );
  // 统计条：里程碑与创建/更新时间是现成的；耗时由起止时间推。
  const stats: { k: string; v: string }[] = [
    { k: t("tasks.statMilestone"), v: total ? `${done} / ${total}` : "—" },
    { k: t("tasks.statDuration"), v: durationOf(d.task, t) },
    ...(devices.length ? [{ k: t("tasks.statDevice"), v: devices.join("、") }] : []),
    // 自动纠错回合只在真补做过时才出现 —— 恒为 0 的一格纯占地方。
    ...(d.task.fix_rounds ? [{ k: t("tasks.statFixRounds"), v: t("tasks.fixRoundsN", { n: d.task.fix_rounds }) }] : []),
    { k: t("tasks.statCreated"), v: legacy.fmtTime(d.task.created_at) },
    { k: t("tasks.statUpdated"), v: legacy.fmtTime(d.task.updated_at) },
  ];

  // 重试对失败/已取消开放（电脑操控任务服务端会回 409「不支持重试」——原样显示给用户）；
  // 停止只对还在跑或挂起的任务开放。两个按钮都按状态出现，不摆死按钮。
  const canRetry = st === "failed" || st === "cancelled";
  const canStop = st === "running" || st === "pending" || st === "suspended";
  const act = async (kind: "retry" | "stop") => {
    if (busy) return;
    setBusy(kind); setActErr("");
    const r = kind === "retry" ? await retryTask(d.task.id) : await stopTask(d.task.id);
    setBusy("");
    if (!r.ok) { setActErr(r.error); return; }
    onChanged();
  };

  return (<>
    <div className="flex-none p-[15px_20px_13px] border-b border-border bg-card">
      <div className="flex items-start gap-[12px]">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-[8px] mb-[5px]">
            <span className={`flex-none whitespace-nowrap px-[9px] py-[2px] rounded-full text-[11px] font-semibold ${TONE_SOFT[m.tone]}`}>{t(m.key)}</span>
            {kind ? <span className="flex-none whitespace-nowrap text-[11px] text-faint">{kind}</span> : null}
          </div>
          <div className="text-[15.5px] font-semibold leading-[1.45]">{d.task.name || d.task.goal}</div>
          {/* 目标描述：只有标题另有其名时才单独铺一段（否则 goal 已经当标题用了）。
              收起态两行截断，展开态给一个 132px 的滚动窗；描述够长才出切换按钮。 */}
          {desc ? (
            <div className="mt-[5px]">
              <div
                className={`text-[12.5px] text-muted leading-[1.65] ${descOpen ? "max-h-[132px] overflow-y-auto" : "line-clamp-2"}`}
                style={{ textWrap: "pretty" } as React.CSSProperties}
              >{desc}</div>
              {desc.length > 62 ? (
                <button
                  className="mt-[3px] p-0 border-none bg-transparent text-orange-text hover:text-orange-deep text-[11.5px] font-medium whitespace-nowrap cursor-pointer"
                  onClick={() => setDescOpen((v) => !v)}
                >{t(descOpen ? "tasks.collapseDesc" : "tasks.expandDesc")}</button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex-none flex gap-[7px]">
          {canRetry ? (
            <button className={btnGhost} disabled={!!busy} title={t("tasks.retryHint")}
              onClick={() => void act("retry")}>{busy === "retry" ? t("tasks.retrying") : t("tasks.retry")}</button>
          ) : null}
          {canStop ? (
            <button className={btnDanger} disabled={!!busy}
              onClick={() => void act("stop")}>{busy === "stop" ? t("tasks.stopping") : t("tasks.stop")}</button>
          ) : null}
          <button className={btnGhost} onClick={() => {
            navigator.clipboard.writeText(detailToText(d)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
          }}>{copied ? t("tasks.copied") : t("tasks.copyDetail")}</button>
        </div>
      </div>

      <div className="flex mt-[13px] border border-border rounded-[10px] overflow-hidden">
        {stats.map((s, i) => (
          <div key={s.k} className={`flex-1 min-w-0 flex flex-col gap-[2px] px-[12px] py-[8px] ${i < stats.length - 1 ? "border-r border-border" : ""}`}>
            <div className="text-[10.5px] text-faint whitespace-nowrap">{s.k}</div>
            <div className="text-[12.5px] font-medium truncate">{s.v}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-[10px] mt-[12px]">
        <span className="flex-none whitespace-nowrap text-[11.5px] text-muted">{t("tasks.progress")}</span>
        <span className="flex-1 h-[6px] rounded-full bg-track overflow-hidden">
          <span className={`block h-full rounded-full ${TONE_BAR[m.tone]}`} style={{ width: `${pct}%` }} />
        </span>
        <span className={`flex-none w-[38px] text-right whitespace-nowrap text-[12.5px] font-semibold ${TONE_TEXT[m.tone]}`}>{pct}%</span>
      </div>
      {/* 重试/停止失败的原因原样显示（409「当前状态不能重试」这类信息必须让用户看到） */}
      {actErr ? <div className="mt-[8px] text-[11.5px] text-danger leading-[1.6]">{actErr}</div> : null}
    </div>

    <div className="flex-1 overflow-y-auto p-[16px_20px_28px]">
      {/* 步骤 / 时间线两栏：窄窗口下允许换行叠成一列，两栏各自留 300px 的最小宽度。 */}
      <div className="flex flex-wrap gap-[18px] items-start">
        <div className="flex-[1_1_340px] min-w-[300px] flex flex-col gap-[14px]">
          <div>
            <div className="flex items-center gap-[8px] mb-[9px]">
              <span className="flex-1 min-w-0 text-[11px] font-semibold tracking-[.06em] text-faint whitespace-nowrap">{t("tasks.steps")}</span>
              <span className="flex-none whitespace-nowrap text-[10.5px] text-faint">{t("tasks.stepCount", { n: subs.length })}</span>
            </div>
            {subs.length ? (
              <div className="flex flex-col bg-card border border-border rounded-[11px] px-[13px] pt-[12px]">
                {subs.map((s, i) => <Step key={s.seq} s={s} last={i === subs.length - 1} />)}
              </div>
            ) : <div className="text-[12.5px] text-muted">{t("tasks.noSteps")}</div>}
          </div>

          {/* 失败卡：优先用失败步骤的结构化错误（带分类），没有就退回任务级的 result_summary。
              另给一个「前往能力设置」的出口（失败多半是 Key/额度问题）。 */}
          {/* 失败态走通用错误卡（稿 2176 就是 `PC 错误卡 variant="card"`）。
              之前这里是手抄的一份近似结构，缺了两样稿里要求的东西：
              ① meta 行（稿要 模型 / HTTP / 错误码 三项，我们目前只拿得到分类和步数，就先给这两项）
              ② 第一动作「重试任务」—— 三段式的第三段必须是**可点的**，只剩一个「前往能力设置」不算。
              原始返回改走 raw 槽（稿 2177-2180 的「查看原始响应」）。 */}
          {st === "failed" ? (
            <div className="flex flex-col gap-[8px]">
              <ErrorCard
                variant="card"
                title={t("tasks.statusFailed")}
                reason={failErr?.message || d.task.result_summary || t("tasks.statusFailed")}
                raw={failErr?.detail || undefined}
                meta={[
                  ...(failErr?.kind && ERR_KIND_KEY[failErr.kind] ? [{ label: t("tasks.errKindLabel"), value: t(ERR_KIND_KEY[failErr.kind]) }] : []),
                  ...(total ? [{ label: t("tasks.errStepLabel"), value: `${done + 1} / ${total}` }] : []),
                ]}
                actions={[
                  { label: t("tasks.retry"), kind: "primary", onClick: () => setRetryNote(t("tasks.retryNotReady")) },
                  { label: t("tasks.goAbilities"), kind: "ghost", onClick: () => legacy.goNav("abilities") },
                ]}
              />
              {/* 重试链路还在调试（决策 D22），按钮保留但如实说清点了不会发生什么，不要静默无反应。 */}
              {retryNote ? <div className="text-[11.5px] text-warning leading-[1.6]">{retryNote}</div> : null}
            </div>
          ) : null}

          <Checklist raw={d.task.checklist} />

          <Results subs={subs} />
        </div>

        {/* 事件时间线：右侧一列，和步骤列一起参与换行 */}
        <div className="flex-[1_1_320px] min-w-[300px]">
          <div className="flex items-center gap-[8px] mb-[9px]">
            <span className="flex-1 min-w-0 text-[11px] font-semibold tracking-[.06em] text-faint whitespace-nowrap">{t("tasks.timeline")}</span>
            <span className="flex-none whitespace-nowrap text-[10.5px] text-faint">{t("tasks.eventCount", { n: d.events.length })}</span>
          </div>
          <div className="bg-card border border-border rounded-[11px] px-[13px] py-[12px] flex flex-col">
            {d.events.length ? d.events.map((e, i) => {
              // 事件着色只按能可靠判断的两类来：带 fail/error 的标红，其余走正文色。
              const bad = /fail|error/i.test(e.type || "");
              return (
                <div key={i} className="flex gap-[9px]">
                  <div className="flex flex-col items-center flex-none w-[9px]">
                    <span className={`w-[9px] h-[9px] flex-none rounded-full mt-[4px] ${bad ? "bg-danger" : "bg-orange"}`} />
                    {i < d.events.length - 1 ? <span className="flex-1 w-px bg-border min-h-[12px]" /> : null}
                  </div>
                  <div className="flex-1 min-w-0 pb-[11px]">
                    <div className="text-[10.5px] text-faint font-mono">{legacy.fmtTime(e.created_at, true)}</div>
                    <div className={`text-[12px] mt-[2px] leading-[1.55] ${bad ? "text-danger font-medium" : "text-text"}`}>{e.message || e.type}</div>
                  </div>
                </div>
              );
            }) : <div className="text-[12.5px] text-muted">{t("tasks.noEvents")}</div>}
          </div>
          <div className="text-[10.5px] text-faint mt-[9px] leading-[1.6]">{t("tasks.timelineFootnote")}</div>
        </div>
      </div>
    </div>
  </>);
}

// 分区小标题：11px 600 + 字距，四处共用。
function SecLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold tracking-[.06em] text-faint mb-[9px]">{children}</div>;
}

// 步骤时间线的一行：左侧 20px 标记列（圆点 + 竖线），右侧标题 / 说明 / 截图。
// 步骤错误有两种形状：结构化对象，或旧数据里的一串自由文本。统一成对象再渲染。
function normErr(e: TaskStep["error"]): StepError | null {
  if (!e) return null;
  if (typeof e === "string") return { kind: "", message: e };
  return e.message ? e : null;
}
// 错误分类的中文名。kind 认不出来时不硬编一个名字，让界面只显示 message。
const ERR_KIND_KEY: Record<string, string> = {
  step_error: "tasks.errStep",
  device_error: "tasks.errDevice",
  timeout: "tasks.errTimeout",
};
// 毫秒 → 人读的耗时。null（没开始过）返回破折号，别显示 0 秒骗人。
function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分 ${sec % 60} 秒`;
  return `${Math.floor(min / 60)} 时 ${min % 60} 分`;
}
// 字节 → 人读的大小。null/undefined（设备没回报）返回破折号。
function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Step({ s, last }: { s: TaskStep; last: boolean }) {
  const { t } = useTranslation();
  const pale = s.status === "pending";
  const m = metaOf(s.status === "dispatched" ? "running" : s.status);
  const title = s.title || `${s.provider || ""}.${s.skill || ""}`;
  const shot = stepShot(s);
  const err = normErr(s.error);
  return (
    <div className="flex gap-[10px]">
      <div className="flex flex-col items-center flex-none w-[20px]">
        <span className={`w-[20px] h-[20px] flex-none rounded-full flex items-center justify-center ${
          pale ? "bg-transparent border-[1.5px] border-border text-faint" : `${TONE_BAR[m.tone]} text-white`}`}>
          {pale ? null : <StatusIcon status={s.status === "dispatched" ? "running" : s.status} size={12} />}
        </span>
        {!last ? <span className="flex-1 w-px min-h-[14px] bg-border" /> : null}
      </div>
      <div className="flex-1 min-w-0 pb-[14px]">
        <div className="flex items-baseline gap-[8px]">
          <span className={`flex-1 min-w-0 text-[12.5px] leading-[1.5] ${pale ? "text-faint font-normal" : "text-text font-medium"}`}>{title}</span>
          {/* 本步耗时：只在真开始过之后才显示（elapsed_ms 为 null 时整块不出现，不摆破折号） */}
          {s.elapsed_ms != null ? <span className="flex-none whitespace-nowrap text-[10.5px] text-faint font-mono">{fmtMs(s.elapsed_ms)}</span> : null}
        </div>
        {/* 这一步实际干了什么（稿 2155-2157 的 st.note）。服务端一直在回 detail，
            以前步骤类型里压根没声明这个字段，于是整层说明信息在界面上凭空消失 ——
            步骤列表只剩四行光秃秃的标题，「设备不在线，挂起等待」这种话一句看不见。
            失败步骤不重复显示：下面的错误块已经把话说得更具体了。
            按 Markdown 渲染（复用聊天的 mdToHtml，转义在前注入不进来）：执行轮写的
            结论天然带 **粗体** / [链接](url) / ---，纯文本展示就是裸星号加不可点的
            长 URL（用户点名）。注意不能再叠 pre-wrap —— mdToHtml 已把换行转成
            段落/<br>，叠上会双倍空行（聊天气泡踩过同一个坑）。 */}
        {s.detail && !err ? (
          <div className="text-[11.5px] text-muted mt-[3px] leading-[1.6] break-words"
            dangerouslySetInnerHTML={{ __html: mdToHtml(s.detail) }} />
        ) : null}
        {/* 执行设备：server 步没有设备，这一行就不出现 */}
        {s.device_id ? (
          <div className="text-[10.5px] text-faint mt-[2px] whitespace-nowrap">
            {t("tasks.stepDevice")}<span className="font-mono">{s.device_id}</span>
          </div>
        ) : null}
        {err ? (
          <div className="mt-[4px] flex flex-col gap-[2px]">
            <div className="flex items-center gap-[6px]">
              {err.kind && ERR_KIND_KEY[err.kind]
                ? <span className="flex-none whitespace-nowrap px-[6px] py-px rounded-full bg-danger-soft text-danger text-[10px] font-semibold">{t(ERR_KIND_KEY[err.kind])}</span>
                : null}
              <span className="flex-1 min-w-0 text-[11.5px] text-danger leading-[1.6] whitespace-pre-wrap break-all">{err.message}</span>
            </div>
            {/* detail 是原始错误文本，多半很长，折起来放；要查根因的人才展开 */}
            {err.detail && err.detail !== err.message ? (
              <details className="text-[10.5px] text-faint">
                <summary className="cursor-pointer whitespace-nowrap">{t("tasks.errDetail")}</summary>
                <div className="mt-[3px] font-mono leading-[1.55] whitespace-pre-wrap break-all">{err.detail}</div>
              </details>
            ) : null}
          </div>
        ) : null}
        {shot ? (
          // 该步「完成后」状态截图：内联显示，点击打开预览器（放大/缩小/下载）。
          // 底下那条脚注是稿 2162-2166 的：文件名 + 「打开」。
          // 光有图的话，图里是什么截图、存到哪儿去了都无从得知——排查时经常要的正是文件名。
          <div className="mt-[8px] max-w-[330px] border border-border rounded-[9px] overflow-hidden">
            {/* /files/<id> 无扩展名，按图试渲染；真不是图就整块收起（脚注单独留着没意义） */}
            <img src={shot} alt={title} title={`${title} · ${t("tasks.shotOpen")}`} onClick={() => openPreview(shot, title)}
              className="block w-full cursor-zoom-in"
              onError={(e) => { const box = (e.target as HTMLImageElement).parentElement; if (box) box.style.display = "none"; }} />
            <div className="flex items-center gap-[6px] px-[9px] py-[5px] bg-card border-t border-border">
              <span className="flex-1 min-w-0 text-[10.5px] text-faint truncate" title={shotName(shot)}>{shotName(shot)}</span>
              <button onClick={() => openPreview(shot, title)}
                className="flex-none whitespace-nowrap text-[10.5px] text-orange-text bg-transparent border-none cursor-pointer p-0">{t("tasks.shotOpen")}</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// 验收清单：秘书建任务时定下的「做到什么算完成」。服务端存的是一段 JSON 文本。
// 解析失败一律当没有——一条脏数据不该把整个详情页拖垮。
function Checklist({ raw }: { raw?: string | null }) {
  const { t } = useTranslation();
  const items = useMemo(() => {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
    } catch { return []; }
  }, [raw]);
  if (!items.length) return null;
  return (
    <div>
      <SecLabel>{t("tasks.checklist")}</SecLabel>
      <div className="bg-card border border-border rounded-[11px] px-[13px] py-[11px] flex flex-col gap-[7px]">
        {items.map((it, i) => (
          <div key={i} className="flex items-start gap-[8px]">
            {/* 刻意不画勾/叉：服务端只存「验收标准是什么」，没有逐条的通过与否，
                画成勾选框会让人以为那是真实结果。 */}
            <span className="flex-none w-[16px] h-[16px] mt-[1px] rounded-[5px] bg-chip text-faint flex items-center justify-center text-[10px] font-semibold">{i + 1}</span>
            <span className="flex-1 min-w-0 text-[12.5px] leading-[1.65]">{it}</span>
          </div>
        ))}
      </div>
      <div className="text-[10.5px] text-faint mt-[7px] leading-[1.6]">{t("tasks.checklistFootnote")}</div>
    </div>
  );
}

// 生成结果：从每步的 result_json 里挑出产物（下载链接 / 路径 / 变更文件），
// 外加 write_artifact 登记的产物（带字节数——设备写文件时回报的，服务端 stat 不到）。
function Results({ subs }: { subs: TaskStep[] }) {
  const { t } = useTranslation();
  const rows: { name: string; path: string; url?: string; ext: string; bytes?: number | null }[] = [];
  const notes: string[] = [];
  for (const s of subs) {
    // 先收 artifacts：这是唯一带大小的来源。同一条路径可能又出现在 result_json 里，
    // 用 path 去重时以这一份为准（它信息更全）。
    for (const a of s.artifacts || []) {
      const name = a.path.split("/").filter(Boolean).pop() || a.path;
      rows.push({ name, path: a.path, bytes: a.bytes,
                  ext: (name.includes(".") ? name.split(".").pop()! : "DOC").toUpperCase().slice(0, 4) });
    }
  }
  for (const s of subs) {
    if (!s.result_json) continue;
    let r: { url?: string; filename?: string; project_dir?: string; path?: string;
             changed_files?: string[]; device_results?: { url?: string; filename?: string }[] };
    try { r = JSON.parse(s.result_json); } catch { continue; }
    if (!r || typeof r !== "object") continue;
    const path = r.path || r.project_dir || "";
    if (typeof r.url === "string" && r.url) {
      const url = r.url.startsWith("http") ? r.url : getServerUrl() + r.url;
      const name = r.filename || url.split("/").pop() || t("tasks.downloadResult");
      rows.push({ name, path, url, ext: (name.split(".").pop() || "").toUpperCase().slice(0, 4) });
    } else if (path) {
      const name = path.split("/").filter(Boolean).pop() || path;
      rows.push({ name, path, ext: (name.includes(".") ? name.split(".").pop()! : "DIR").toUpperCase().slice(0, 4) });
    }
    // 设备工作结果（执行轮聚合的一层）：截图这类产出的 url 在这层，不在顶层 ——
    // 只扫顶层等于大多数带 url 的产出都收不到（用户实测：截完图结果区是空的）。
    for (const d of (Array.isArray(r.device_results) ? r.device_results : [])) {
      if (!d || typeof d.url !== "string" || !d.url) continue;
      const url = d.url.startsWith("http") ? d.url : getServerUrl() + d.url;
      const name = (typeof d.filename === "string" && d.filename) || url.split("/").pop() || t("tasks.downloadResult");
      rows.push({ name, path: "", url, ext: (name.includes(".") ? name.split(".").pop()! : "IMG").toUpperCase().slice(0, 4) });
    }
    if (Array.isArray(r.changed_files) && r.changed_files.length) {
      notes.push(t("tasks.changedFiles", { count: r.changed_files.length, files: r.changed_files.slice(0, 8).join("、") + (r.changed_files.length > 8 ? " …" : "") }));
    }
  }
  // 按路径去重：artifacts 先入表，所以带大小的那份会留下。
  const seen = new Set<string>();
  const uniq = rows.filter((r) => {
    const k = r.path || r.url || r.name;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!uniq.length && !notes.length) return null;
  return (
    <div>
      <SecLabel>{t("tasks.results")}</SecLabel>
      <div className="flex flex-col gap-[7px]">
        {uniq.map((r, i) => (
          <div key={i} className="flex items-center gap-[10px] bg-card border border-border rounded-[10px] px-[12px] py-[9px]">
            <span className="w-7 h-7 flex-none rounded-[7px] bg-chip text-muted flex items-center justify-center text-[10px] font-semibold">{r.ext}</span>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] truncate">{r.name}</div>
              {r.path ? <div className="text-[10.5px] text-faint font-mono truncate">{r.path}</div> : null}
            </div>
            {/* 大小：设备回报了才显示。没回报的（老数据、非 write_artifact 产出）整块不出现 */}
            {r.bytes != null ? <span className="flex-none whitespace-nowrap text-[11px] text-faint font-mono">{fmtBytes(r.bytes)}</span> : null}
            {r.url && isImg(r.url) ? (
              <button className="w-[26px] h-[26px] flex-none flex items-center justify-center border border-border bg-transparent text-muted rounded-[7px] hover:border-orange hover:text-orange-text"
                title={t("tasks.shotOpen")} onClick={() => openPreview(r.url!, r.name)}><IconSearch size={13} /></button>
            ) : null}
            {r.url ? (
              <a href={r.url} target="_blank" rel="noopener noreferrer" title={t("tasks.downloadResult")}
                className="w-[26px] h-[26px] flex-none flex items-center justify-center border border-border text-muted rounded-[7px] hover:border-orange hover:text-orange-text"><IconFolder size={13} /></a>
            ) : null}
          </div>
        ))}
        {notes.map((n, i) => <div key={`n${i}`} className="text-[11.5px] text-muted leading-[1.6]">{n}</div>)}
      </div>
    </div>
  );
}
