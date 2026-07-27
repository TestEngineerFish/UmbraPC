// 工作区页（React + Tailwind）。结构对齐 ClaudeDesign 的工作区稿：
// 左边 396px 列表列（--rail 底：标题+计数+新增/刷新、搜索、筛选胶囊、工作区卡），
// 右边详情列（monogram + 名称 + 路径 + 三个操作、四格统计条，下面「相关任务 / 描述」与「目录内容」两栏）。
// 工作区是服务端注册表（tasks 靠 project 名字引用），列表/描述/移除全走 REST；
// 「目录内容」走 PC 侧的 umbra:listDir（只读顶层，不递归）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchWorkspaces, createWorkspace, deleteWorkspace, updateWorkspaceDesc, fetchJobsByProject } from "../../services/server";
import type { Workspace, Job } from "../../services/server";
import { getState } from "../../services/deviceTransport";
import * as desktop from "../../services/desktop";
import type { DirEntry } from "../../services/desktop";
import * as legacy from "../../app/shell";
import { btnGhost, btnPrimary, btnIcon, inputFlex } from "../../components/ui";
import { IconSearch, IconRefresh, IconPlus, IconCopy, IconCheck, IconFolder, IconTrash, IconX, IconAlert, IconPencil } from "../../components/icons";

// 名字首字母（或首个汉字）做 monogram 方块 —— 设计规范里分类与记录一律用字母方块，不用彩色 emoji。
function monogramOf(name: string): string {
  const c = (name || "?").trim().charAt(0);
  return /[a-z]/i.test(c) ? c.toUpperCase() : c;
}
// 路径缩写：把家目录换成 ~，列表里一行放得下。
function shortPath(p: string | null): string {
  if (!p) return "";
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}
// 字节 → 人话。目录（size<0）不显示大小。
function humanSize(n: number): string {
  if (n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
// 任务状态 → 徽章配色。和任务页同一套语义（绿完成 / 橙执行中 / 黄挂起 / 红失败 / 灰其它）。
const JOB_TONE: Record<string, string> = {
  done: "bg-success-soft text-success", running: "bg-orange-soft text-orange-text",
  pending: "bg-chip text-muted", failed: "bg-danger-soft text-danger",
  cancelled: "bg-chip text-muted", suspended: "bg-warning-soft text-warning",
};
const JOB_KEY: Record<string, string> = {
  done: "tasks.statusDone", running: "tasks.statusRunning", pending: "tasks.statusPending",
  failed: "tasks.statusFailed", cancelled: "tasks.statusCancelled", suspended: "tasks.statusSuspended",
};

// 分区小标题：11px 600 + 字距，几处共用。right 放右侧的链接式按钮。
function SecLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-[8px] mb-[9px]">
      <span className="flex-1 min-w-0 text-[11px] font-semibold tracking-[.06em] text-faint">{children}</span>
      {right}
    </div>
  );
}

export function Workspaces() {
  const { t } = useTranslation();
  const [list, setList] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [selId, setSelId] = useState<string>("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // 新增弹框
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", dir: "", description: "" });
  // 移除弹框：null=关闭；purge 决定是「仅移除」还是「连文件一起删」
  const [removing, setRemoving] = useState<Workspace | null>(null);
  const [purge, setPurge] = useState(false);

  const load = useCallback(async (spin = false) => {
    if (spin) setRefreshing(true);
    const rows = await fetchWorkspaces();
    setList(rows);
    setLoading(false);
    if (spin) setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [load]);

  const kw = q.trim().toLowerCase();
  const shown = useMemo(() => list.filter((w) => {
    if (filter !== "all" && w.origin !== filter) return false;
    if (!kw) return true;
    return `${w.name} ${w.dir || ""} ${w.description || ""}`.toLowerCase().includes(kw);
  }), [list, filter, kw]);

  const autoN = list.filter((w) => w.origin === "auto").length;
  const FILTERS = [
    { k: "all", label: t("workspaces.filterAll"), n: list.length },
    { k: "auto", label: t("workspaces.filterAuto"), n: autoN },
    { k: "manual", label: t("workspaces.filterManual"), n: list.length - autoN },
  ];

  // 选中项：优先用户点过的；否则跟着列表第一条走（详情列常驻，空着一大片不如直接给内容）。
  const sel = shown.find((w) => w.id === selId) || shown[0] || null;

  async function submitAdd() {
    const name = form.name.trim();
    if (!name) return;
    const deviceId = getState().deviceId;
    if (!deviceId) { setErr(t("workspaces.notConnected")); return; }
    setBusy(true);
    setErr("");
    const r = await createWorkspace(name, deviceId, form.dir.trim() || undefined, form.description.trim() || undefined);
    setBusy(false);
    if ("error" in r) { setErr(r.error); return; }
    setAdding(false);
    setForm({ name: "", dir: "", description: "" });
    setSelId(r.id);
    void load();
  }

  async function doRemove() {
    if (!removing) return;
    setBusy(true);
    const res = await deleteWorkspace(removing.id, purge);
    setBusy(false);
    setRemoving(null);
    setPurge(false);
    if (res && purge && res.purge_error) {
      // 记录被删了，但文件没删掉（设备离线等）——提示一下。
      setErr(t("workspaces.purgeFailed", { reason: res.purge_error }));
    }
    void load();
  }

  return (
    <div className="h-full relative flex min-h-0">
      {/* ── 列表列 ── */}
      <section className="w-[396px] flex-none border-r border-border bg-rail flex flex-col min-h-0">
        <div className="flex-none flex flex-col gap-[11px] p-[14px_14px_11px] border-b border-border">
          <div className="flex items-center gap-[9px]">
            <span className="flex-none whitespace-nowrap text-[16px] font-semibold">{t("workspaces.title")}</span>
            <span className="flex-1 min-w-0 truncate text-[11.5px] text-faint">
              {t("workspaces.countLine", { n: list.length, auto: autoN })}
            </span>
            <button className={btnPrimary} onClick={() => { setErr(""); setAdding(true); }}>
              <span className="flex items-center gap-1"><IconPlus size={12} />{t("workspaces.add")}</span>
            </button>
            <button className={btnIcon} title={t("common.refresh")} onClick={() => void load(true)}>
              <span className={`flex ${refreshing ? "animate-spin" : ""}`}><IconRefresh size={13} /></span>
            </button>
          </div>

          <div className="flex items-center gap-[7px] bg-card border border-border rounded-[8px] px-[9px] py-[5px]">
            <span className="flex-none text-faint"><IconSearch size={12} /></span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("workspaces.searchPlaceholder")}
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-[12px]" />
          </div>

          <div className="flex gap-[4px]">
            {FILTERS.map((f) => {
              const on = filter === f.k;
              return (
                <button key={f.k} onClick={() => setFilter(f.k)}
                  className={`flex-none whitespace-nowrap flex items-center gap-[5px] px-[9px] py-[4px] rounded-full text-[11.5px] border ${
                    on ? "border-orange bg-orange-soft text-orange-text font-semibold" : "border-border bg-transparent text-muted hover:border-orange"}`}>
                  <span>{f.label}</span>
                  <span className={`text-[10.5px] font-semibold ${on ? "text-orange-text" : "text-faint"}`}>{f.n}</span>
                </button>
              );
            })}
          </div>
        </div>

        {err ? (
          <div className="flex-none m-[9px_9px_0] flex items-start gap-[8px] bg-danger-soft border border-danger rounded-[10px] px-[11px] py-[9px]">
            <span className="flex-none mt-px text-danger"><IconAlert size={13} /></span>
            <span className="flex-1 min-w-0 text-[11.5px] text-danger leading-[1.55]">{err}</span>
            <button className="flex-none bg-transparent text-danger" title={t("common.close")} onClick={() => setErr("")}><IconX size={12} /></button>
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto p-[9px] flex flex-col gap-[7px]">
          {shown.map((w) => {
            const on = sel?.id === w.id;
            return (
              <div key={w.id} onClick={() => setSelId(w.id)}
                className={`bg-card border rounded-[11px] p-[11px_13px] cursor-pointer ${
                  on ? "border-orange shadow-[inset_3px_0_0_var(--orange)]" : "border-border hover:border-orange"}`}>
                <div className="flex items-center gap-[10px]">
                  <span className={`w-7 h-7 flex-none rounded-[8px] flex items-center justify-center text-[12px] font-semibold ${
                    on ? "bg-orange text-white" : "bg-chip text-muted"}`}>{monogramOf(w.name)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-[7px]">
                      <span className="flex-1 min-w-0 truncate text-[13px] font-medium">{w.name}</span>
                      {w.origin === "auto" ? (
                        <span className="flex-none whitespace-nowrap px-[7px] py-px rounded-full bg-chip text-muted text-[10px]">{t("workspaces.originAuto")}</span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-faint font-mono truncate mt-[3px]">
                      {shortPath(w.dir) || t("workspaces.pathPending")}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-[9px] mt-[9px]">
                  <span className="flex-none whitespace-nowrap px-[8px] py-px rounded-full bg-chip text-muted text-[10.5px]">
                    {t("workspaces.taskCount", { count: w.task_count })}
                  </span>
                  <span className="flex-1" />
                  <span className="flex-none whitespace-nowrap text-[10.5px] text-faint">{legacy.fmtListTime(w.last_active_at)}</span>
                </div>
              </div>
            );
          })}
          {!shown.length ? (
            <div className="py-10 text-center text-[12.5px] text-muted">
              {loading ? t("common.loading") : kw ? t("workspaces.noMatch", { q: kw }) : filter !== "all" ? t("workspaces.noneInFilter") : t("workspaces.empty")}
            </div>
          ) : null}
          <div className="mt-[4px] px-[12px] py-[11px] border border-dashed border-border rounded-[11px]">
            <div className="text-[11.5px] text-muted leading-[1.65]">{t("workspaces.hint")}</div>
          </div>
        </div>
      </section>

      {/* ── 详情列 ── */}
      <main className="flex-1 min-w-0 flex flex-col min-h-0 bg-bg">
        {sel ? <Detail w={sel} onRemove={() => { setRemoving(sel); setPurge(false); }} onSaved={() => void load()} />
          : <div className="flex-1 flex items-center justify-center text-[12.5px] text-muted">{t("workspaces.pickOne")}</div>}
      </main>

      {/* ── 新增弹框 ── */}
      {adding ? (
        <Modal width={470} title={t("workspaces.newTitle")} onClose={() => setAdding(false)}
          footer={<>
            <span className="flex-1 min-w-0 truncate text-[11px] text-faint">{t("workspaces.newFootnote")}</span>
            <button className={btnGhost} onClick={() => setAdding(false)}>{t("common.cancel")}</button>
            <button className={btnPrimary} disabled={busy || !form.name.trim()} onClick={() => void submitAdd()}>{t("workspaces.createBtn")}</button>
          </>}>
          <Field label={t("workspaces.fieldName")}>
            <input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t("workspaces.namePlaceholder")} className={inputFlex} />
          </Field>
          <Field label={t("workspaces.fieldPath")} hint={t("workspaces.fieldPathHint")}>
            <input value={form.dir} onChange={(e) => setForm({ ...form, dir: e.target.value })}
              placeholder="~/UmbraWorks/…" className={`${inputFlex} font-mono`} />
          </Field>
          <Field label={t("workspaces.fieldDesc")}>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder={t("workspaces.descPlaceholder")} className={inputFlex} />
          </Field>
        </Modal>
      ) : null}

      {/* ── 移除弹框：两个单选（仅移除 / 连文件一起删），选后者时再加一块红色警告 ── */}
      {removing ? (
        <Modal width={430} title={t("workspaces.removeTitle")} onClose={() => setRemoving(null)}
          footer={<>
            <span className="flex-1" />
            <button className={btnGhost} onClick={() => setRemoving(null)}>{t("common.cancel")}</button>
            <button disabled={busy} onClick={() => void doRemove()}
              className={`flex-none whitespace-nowrap px-[13px] py-[6px] rounded-[8px] text-[12.5px] font-semibold ${
                purge ? "bg-danger text-white" : "bg-transparent border border-danger text-danger hover:bg-danger hover:text-white"}`}>
              {purge ? t("workspaces.removeWipeBtn") : t("workspaces.removeKeepBtn")}
            </button>
          </>}>
          <div className="text-[12.5px] text-muted leading-[1.6]">
            {t("workspaces.removeHint2", { name: removing.name, count: removing.task_count })}
          </div>
          <div className="border border-border rounded-[10px] overflow-hidden">
            <RadioRow on={!purge} title={t("workspaces.keepFiles")} hint={t("workspaces.keepFilesHint")} onPick={() => setPurge(false)} />
            <RadioRow on={purge} danger last title={t("workspaces.wipeFiles")} hint={t("workspaces.wipeFilesHint")} onPick={() => setPurge(true)} />
          </div>
          {purge ? (
            <div className="bg-danger-soft rounded-[9px] px-[11px] py-[9px] flex gap-[8px] items-start">
              <span className="flex-none mt-px text-danger"><IconAlert size={13} /></span>
              <span className="flex-1 min-w-0 text-[11.5px] text-danger leading-[1.55] break-all">
                {t("workspaces.wipeWarn", { path: shortPath(removing.dir) || removing.name })}
              </span>
            </div>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}

// 详情列。相关任务与目录内容都随选中项重新拉一次。
function Detail({ w, onRemove, onSaved }: { w: Workspace; onRemove: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dir, setDir] = useState<{ items: DirEntry[]; total: number }>({ items: [], total: -1 });
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // 切工作区时把两块异步数据都重拉；alive 守卫防止旧请求晚回来把新选中项的数据盖掉。
  useEffect(() => {
    let alive = true;
    setJobs([]);
    setDir({ items: [], total: -1 });
    setEditing(false);
    void fetchJobsByProject(w.name, 20).then((r) => { if (alive) setJobs(r); });
    if (w.dir) void desktop.listDir(w.dir, 5).then((r) => { if (alive) setDir(r); });
    return () => { alive = false; };
  }, [w.id, w.name, w.dir]);

  const stats: { k: string; v: string }[] = [
    { k: t("workspaces.statTasks"), v: t("workspaces.taskCount", { count: w.task_count }) },
    { k: t("workspaces.statOrigin"), v: w.origin === "auto" ? t("workspaces.originAuto") : t("workspaces.originManual") },
    { k: t("workspaces.statLastActive"), v: legacy.fmtTime(w.last_active_at) },
    { k: t("workspaces.statDevice"), v: w.device_id || "—" },
  ];

  const saveDesc = async () => {
    setSaving(true);
    await updateWorkspaceDesc(w.id, draft.trim());
    setSaving(false);
    setEditing(false);
    onSaved();
  };

  return (<>
    <div className="flex-none p-[15px_20px_14px] border-b border-border bg-card">
      <div className="flex items-start gap-[12px]">
        <span className="w-9 h-9 flex-none rounded-[10px] bg-orange-soft text-orange-text flex items-center justify-center text-[15px] font-semibold">{monogramOf(w.name)}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-[8px]">
            <span className="flex-1 min-w-0 truncate text-[16px] font-semibold">{w.name}</span>
            {w.origin === "auto" ? (
              <span className="flex-none whitespace-nowrap px-[7px] py-px rounded-full bg-chip text-muted text-[10px]">{t("workspaces.originAuto")}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-[7px] mt-[6px]">
            <span className="flex-1 min-w-0 truncate text-[11.5px] text-muted font-mono">{shortPath(w.dir) || t("workspaces.pathPending")}</span>
            {w.dir ? (
              <button className={btnIcon} title={t("workspaces.copyPath")} onClick={() => {
                void navigator.clipboard.writeText(w.dir!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
              }}>{copied ? <IconCheck size={12} /> : <IconCopy size={12} />}</button>
            ) : null}
          </div>
        </div>
        <div className="flex-none flex gap-[7px]">
          {w.dir ? (
            <button className={btnGhost} onClick={() => void desktop.openPath(w.dir!)}>
              <span className="flex items-center gap-1.5"><IconFolder size={12} />{t("workspaces.openFolder")}</span>
            </button>
          ) : null}
          {/* 「在此新建任务」跳到聊天页：任务是在对话里发起的，这里只负责把人送过去。 */}
          <button className={btnGhost} onClick={() => legacy.goNav("chat")}>{t("workspaces.newTaskHere")}</button>
          <button className={`${btnIcon} hover:border-danger hover:text-danger`} title={t("workspaces.remove")} onClick={onRemove}><IconTrash size={13} /></button>
        </div>
      </div>

      <div className="flex mt-[13px] border border-border rounded-[10px] overflow-hidden">
        {stats.map((s, i) => (
          <div key={s.k} className={`flex-1 min-w-0 flex flex-col gap-[2px] px-[12px] py-[8px] ${i < stats.length - 1 ? "border-r border-border" : ""}`}>
            <div className="text-[10.5px] text-faint whitespace-nowrap">{s.k}</div>
            <div className="text-[12.5px] font-medium truncate" title={s.v}>{s.v}</div>
          </div>
        ))}
      </div>
    </div>

    <div className="flex-1 overflow-y-auto p-[16px_20px_28px]">
      <div className="flex gap-[18px] items-start">
        <div className="flex-1 min-w-0 flex flex-col gap-[16px]">
          <div>
            <SecLabel right={
              <button className="flex-none whitespace-nowrap bg-transparent text-[11.5px] text-orange-text" onClick={() => legacy.goNav("tasks")}>
                {t("workspaces.viewAllInTasks")}
              </button>
            }>{t("workspaces.relatedJobs")}</SecLabel>
            <div className="flex flex-col gap-[7px]">
              {jobs.map((j) => (
                <div key={j.id} className="bg-card border border-border rounded-[10px] px-[12px] py-[10px]">
                  <div className="flex items-baseline gap-[8px]">
                    <span className="flex-1 min-w-0 text-[12.5px] font-medium line-clamp-2 leading-[1.45]">{j.name || j.goal}</span>
                    <span className="flex-none whitespace-nowrap text-[10.5px] text-faint">{legacy.fmtListTime(j.updated_at)}</span>
                  </div>
                  <div className="flex items-center gap-[8px] mt-[5px]">
                    <span className={`flex-none whitespace-nowrap px-[8px] py-px rounded-full text-[10.5px] font-semibold ${JOB_TONE[j.status] || "bg-chip text-muted"}`}>
                      {t(JOB_KEY[j.status] || j.status)}
                    </span>
                    {j.steps_total ? <span className="flex-none whitespace-nowrap text-[11px] text-muted">{j.steps_done || 0} / {j.steps_total}</span> : null}
                    <span className="flex-1 min-w-0 truncate text-[11px] text-muted">{j.result_summary || ""}</span>
                  </div>
                </div>
              ))}
              {!jobs.length ? <div className="text-[12px] text-muted">{t("workspaces.noRelatedJobs")}</div> : null}
            </div>
          </div>

          <div>
            <SecLabel>{t("workspaces.descTitle")}</SecLabel>
            <div className="bg-card border border-border rounded-[11px] px-[13px] py-[12px]">
              {editing ? (
                <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={3}
                  placeholder={t("workspaces.descPlaceholder")}
                  className="w-full bg-bg border border-border rounded-[8px] px-[11px] py-[8px] text-[12.5px] leading-[1.7] outline-none resize-y" />
              ) : w.description ? (
                <div className="text-[12.5px] leading-[1.7]">{w.description}</div>
              ) : (
                <div className="text-[12.5px] text-faint">{t("workspaces.descEmpty")}</div>
              )}
              <div className="flex items-center gap-[8px] mt-[11px]">
                <span className="flex-1 min-w-0 text-[10.5px] text-faint">{t("workspaces.descFootnote")}</span>
                {editing ? (<>
                  <button className={btnGhost} onClick={() => setEditing(false)}>{t("common.cancel")}</button>
                  <button className={btnPrimary} disabled={saving} onClick={() => void saveDesc()}>{t("common.save")}</button>
                </>) : (
                  <button className={btnGhost} onClick={() => { setDraft(w.description || ""); setEditing(true); }}>
                    <span className="flex items-center gap-1.5"><IconPencil size={12} />{t("common.edit")}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 目录内容：只读顶层前 5 项。走 PC 侧 IPC；Web 端没有桥 → total=-1 → 显示读不到。 */}
        <div className="w-[330px] flex-none">
          <SecLabel right={dir.total >= 0 ? <span className="flex-none whitespace-nowrap text-[10.5px] text-faint">{t("workspaces.dirCount", { n: dir.total })}</span> : undefined}>
            {t("workspaces.dirTitle")}
          </SecLabel>
          <div className="bg-card border border-border rounded-[11px] overflow-hidden">
            {dir.items.map((f) => (
              <div key={f.name} className="flex items-center gap-[9px] px-[12px] py-[9px] border-b border-border-soft hover:bg-hover">
                <span className="w-7 h-7 flex-none rounded-[7px] bg-chip text-muted flex items-center justify-center text-[9.5px] font-semibold">
                  {f.dir ? "DIR" : (f.name.includes(".") ? f.name.split(".").pop()! : "—").toUpperCase().slice(0, 4)}
                </span>
                <div className="flex-1 min-w-0 text-[12px] font-mono truncate">{f.name}</div>
                <span className="flex-none whitespace-nowrap text-[10.5px] text-faint">{humanSize(f.size)}</span>
              </div>
            ))}
            {!dir.items.length ? (
              <div className="px-[12px] py-[11px] text-[11.5px] text-muted leading-[1.6]">
                {!w.dir ? t("workspaces.dirNoPath") : dir.total < 0 ? t("workspaces.dirUnreadable") : t("workspaces.dirEmpty")}
              </div>
            ) : null}
            <div className="flex items-center gap-[8px] px-[12px] py-[9px] bg-bg">
              <span className="flex-1 min-w-0 truncate text-[10.5px] text-faint">
                {dir.total > dir.items.length ? t("workspaces.dirTopN", { n: dir.items.length }) : ""}
              </span>
              {w.dir ? (
                <button className="flex-none whitespace-nowrap bg-transparent text-[11px] text-orange-text" onClick={() => void desktop.openPath(w.dir!)}>
                  {t("workspaces.openInFinder")}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  </>);
}

// 通用弹框：标题栏 + 内容 + 底栏。两个弹框共用，避免两处各写一遍遮罩与圆角。
function Modal({ width, title, children, footer, onClose }: {
  width: number; title: string; children: React.ReactNode; footer: React.ReactNode; onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="absolute inset-0 z-40 bg-black/40 flex items-center justify-center" onMouseDown={onClose}>
      <div className="bg-card border border-border rounded-[14px] overflow-hidden flex flex-col max-h-[calc(100%-32px)]"
        style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex-none flex items-center gap-[10px] px-[16px] py-[14px] border-b border-border">
          <span className="flex-1 min-w-0 truncate text-[14px] font-semibold">{title}</span>
          <button className={btnIcon} title={t("common.close")} onClick={onClose}><IconX size={12} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-[16px] py-[15px] flex flex-col gap-[13px]">{children}</div>
        <div className="flex-none flex items-center gap-[8px] px-[16px] py-[12px] border-t border-border bg-bg">{footer}</div>
      </div>
    </div>
  );
}

// 弹框里的一个字段块：标签 + 控件 + 可选脚注。
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11.5px] text-muted mb-[5px]">{label}</div>
      <div className="flex gap-[7px]">{children}</div>
      {hint ? <div className="text-[10.5px] text-faint mt-[5px] leading-[1.55]">{hint}</div> : null}
    </div>
  );
}

// 移除弹框里的单选行。danger=true 时标题走红色、选中点也是红的。
function RadioRow({ on, title, hint, danger, last, onPick }: {
  on: boolean; title: string; hint: string; danger?: boolean; last?: boolean; onPick: () => void;
}) {
  return (
    <div onClick={onPick} className={`flex items-start gap-[10px] px-[12px] py-[11px] cursor-pointer hover:bg-hover ${last ? "" : "border-b border-border-soft"}`}>
      <span className={`w-4 h-4 flex-none mt-px rounded-full flex items-center justify-center border-[1.5px] ${
        on ? (danger ? "bg-danger border-danger" : "bg-orange border-orange") : "bg-transparent border-border"}`}>
        {on ? <span className="w-[7px] h-[7px] rounded-full bg-white block" /> : null}
      </span>
      <div className="flex-1 min-w-0">
        <div className={`text-[12.5px] font-medium ${danger ? "text-danger" : ""}`}>{title}</div>
        <div className="text-[11px] text-muted mt-[2px] leading-[1.5]">{hint}</div>
      </div>
    </div>
  );
}
