// 工作区页（React + Tailwind）。批次 012 起套页面骨架的 **T1 列表 + 详情**：
// 页头（标题「工作区」+ 计数副标题 + 「新增」主按钮 + 「刷新」次级钮，刷新中旋转弧落在状态槽；
// 第二行搜索 + 三档筛选芯片），左列表 400（--rail 底，行密度 ListRow：monogram + 名称 + 路径 + 任务数），
// 右详情常驻（DetailHead：monogram + 名称 + 路径 / 打开位置 · 在此新建任务 · 移除，下面统计条，
// 再下面「相关任务 / 描述」与 330px「目录内容」两栏）。原来列表栏里的标题 / 搜索 / 筛选 / 新增 / 刷新一律上移页头。
// 工作区是服务端注册表（tasks 靠 project 名字引用），列表/描述/移除全走 REST；
// 「目录内容」走 PC 侧的 umbra:listDir（只读顶层，不递归）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchWorkspaces, createWorkspace, deleteWorkspace, updateWorkspaceDesc, fetchTasksByProject } from "../../services/server";
import type { Workspace, TaskItem } from "../../services/server";
import { getState } from "../../services/deviceTransport";
import * as desktop from "../../services/desktop";
import type { DirEntry } from "../../services/desktop";
import * as legacy from "../../app/shell";
import { btn, btnRow, btnGhost, btnPrimary, icon as iconBtn, inputFlex, Modal, filterChip, filterChipCount, EmptyState } from "../../components/ui";
import { PageShell, HeaderSearch, ListDetail, ListRow, DetailHead, StatBar, SectionHeader, PageBanner, SyncSpinner, Skeleton } from "../../components/layout";
import { IconCopy, IconCheck, IconFolder, IconTrash, IconAlert, IconPencil } from "../../components/icons";

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

export function Workspaces() {
  const { t } = useTranslation();
  const [list, setList] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [selId, setSelId] = useState<string>("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // 页头「刷新」的进行中标志（旋转弧落在页头状态槽）。
  const [refreshing, setRefreshing] = useState(false);
  // 新增弹框
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", dir: "", description: "" });
  // 移除弹框：null=关闭；purge 决定是「仅移除」还是「连文件一起删」
  const [removing, setRemoving] = useState<Workspace | null>(null);
  const [purge, setPurge] = useState(false);

  // 取数；轮询与页头刷新都走它。
  const load = useCallback(async () => {
    const rows = await fetchWorkspaces();
    setList(rows);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [load]);

  // 页头「刷新」：原 RefreshButton 里的最短自旋时长（550ms）搬到这里 —— 本地服务端一次列表请求
  // 常常只要十几毫秒，光看请求状态旋转弧还没转起来就复位了，用户会以为按钮没反应。
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    await Promise.all([load(), new Promise((r) => setTimeout(r, 550))]);
    setRefreshing(false);
  };

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

  const filtering = !!kw || filter !== "all";
  const clearFilter = () => { setQ(""); setFilter("all"); };
  // 裁定 8（tokens.pageTemplate.shared.emptyHeaderPrimary）：真空态时页头不渲染「新增」，橙留给空态里那颗。
  // 「真空」= 一个工作区都没有（全量 list 为空，不是筛出来的 shown）&& 没搜索没筛选 && 首屏骨架已过。
  // 搜 / 筛没结果是无结果态，主按钮照常在。（本页拿不到离线态：拉取失败回空列表，和真空同形，
  // 那时列表栏画的也是这同一个空态，页面上仍只有一颗橙。）
  const blank = !loading && !list.length && !filtering;

  return (
    <PageShell header={{
      title: t("workspaces.title"),
      subtitle: t("workspaces.countLine", { n: list.length, auto: autoN }),
      status: refreshing ? <SyncSpinner /> : undefined,
      primary: blank ? undefined : { label: t("common.add"), onClick: () => { setErr(""); setAdding(true); } },
      secondary: [{ label: t("common.refresh"), onClick: () => void refresh() }],
      secondRow: (<>
        <HeaderSearch value={q} onChange={setQ} placeholder={t("workspaces.searchPlaceholder")} />
        {FILTERS.map((f) => {
          const on = filter === f.k;
          return (
            <button key={f.k} onClick={() => setFilter(f.k)} className={filterChip(on, "sm")}>
              <span>{f.label}</span>
              <span className={filterChipCount(on)}>{f.n}</span>
            </button>
          );
        })}
      </>),
    }}>
      {/* 局部错误（新增失败 / 设备未连接 / 文件没删掉）走通用横幅贴内容区顶部，不再自绘红条。 */}
      {err ? <PageBanner title={err} actions={[{ label: t("common.close"), kind: "ghost", onClick: () => setErr("") }]} /> : null}

      <ListDetail
        listEmpty={!shown.length}
        list={<>
          {/* 首屏走骨架；之后列表为空走通用空态。三种情形给的动作不一样：
              搜/筛没结果 → 清空筛选；一个工作区都没有 → 新增。 */}
          {loading && !list.length ? (
            <Skeleton rows={3} />
          ) : shown.length ? (
            /* 行外再包一层 flex-none：ListRow 自带 min-h 52，直接当滚动容器的 flex 子项会在
               列表溢出时被压到 52 高、两行内容叠到一起。 */
            <div className="flex-none flex flex-col">
              {shown.map((w) => {
                const on = sel?.id === w.id;
                return (
                  <ListRow key={w.id} selected={on} onClick={() => setSelId(w.id)}>
                    <div className="flex items-center gap-[10px]">
                      <span className={`w-7 h-7 flex-none rounded-[8px] flex items-center justify-center text-[12px] font-semibold ${
                        on ? "bg-orange text-white" : "bg-chip text-muted"}`}>{monogramOf(w.name)}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-[7px]">
                          <span className="flex-1 min-w-0 truncate text-[13px] font-medium">{w.name}</span>
                          {w.origin === "auto" ? (
                            <span className="flex-none whitespace-nowrap px-[7px] py-px rounded-full bg-chip text-muted text-[10px]">{t("workspaces.originAuto")}</span>
                          ) : null}
                          <span className="flex-none whitespace-nowrap text-[10.5px] text-faint">{legacy.fmtListTime(w.last_active_at)}</span>
                        </div>
                        <div className="flex items-center gap-[8px] mt-[3px]">
                          <span className="flex-1 min-w-0 truncate text-[11px] text-faint font-mono">
                            {shortPath(w.dir) || t("workspaces.pathPending")}
                          </span>
                          <span className="flex-none whitespace-nowrap text-[10.5px] text-faint">{t("workspaces.taskCount", { count: w.task_count })}</span>
                        </div>
                      </div>
                    </div>
                  </ListRow>
                );
              })}
            </div>
          ) : (
            <EmptyState compact
              title={kw ? t("workspaces.noMatch", { q: kw }) : filter !== "all" ? t("workspaces.noneInFilter") : t("workspaces.empty")}
              actionLabel={filtering ? t("workspaces.clearFilter") : t("workspaces.add")}
              onAction={filtering ? clearFilter : () => setAdding(true)} />
          )}
          <div className="flex-none m-[12px] px-[12px] py-[11px] border border-dashed border-border rounded-[11px]">
            <div className="text-[11.5px] text-muted leading-[1.65]">{t("workspaces.hint")}</div>
          </div>
        </>}
        detail={sel ? (
          <Detail w={sel} onRemove={() => { setRemoving(sel); setPurge(false); }} onSaved={() => void load()} />
        ) : null}
        placeholder={t("workspaces.pickOne")}
      />

      {/* ── 新增弹框 ── */}
      {adding ? (
        <Modal width={560} title={t("workspaces.newTitle")} onClose={() => setAdding(false)}
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
        <Modal width={480} title={t("workspaces.removeTitle")} onClose={() => setRemoving(null)}
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
    </PageShell>
  );
}

// 详情列。相关任务与目录内容都随选中项重新拉一次。
function Detail({ w, onRemove, onSaved }: { w: Workspace; onRemove: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [dir, setDir] = useState<{ items: DirEntry[]; total: number }>({ items: [], total: -1 });
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // 切工作区时把两块异步数据都重拉；alive 守卫防止旧请求晚回来把新选中项的数据盖掉。
  useEffect(() => {
    let alive = true;
    setTasks([]);
    setDir({ items: [], total: -1 });
    setEditing(false);
    void fetchTasksByProject(w.name, 20).then((r) => { if (alive) setTasks(r); });
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
    {/* 详情头走骨架件 DetailHead：monogram 当前导，名称当标题，路径（+ 复制）当副行；
        右侧「打开位置 / 在此新建任务 / 移除」三颗 28 高小钮，移除是描边红。四格统计条改成 StatBar。 */}
    <DetailHead
      lead={
        <span className="w-[24px] h-[24px] flex-none rounded-[7px] bg-orange-soft text-orange-text flex items-center justify-center text-[12.5px] font-semibold">
          {monogramOf(w.name)}
        </span>
      }
      title={
        <span className="flex items-center gap-[8px]">
          <span className="min-w-0 truncate">{w.name}</span>
          {w.origin === "auto" ? (
            <span className="flex-none whitespace-nowrap px-[7px] py-px rounded-full bg-chip text-muted text-[10px] font-normal">{t("workspaces.originAuto")}</span>
          ) : null}
        </span>
      }
      sub={
        <span className="flex items-center gap-[6px]">
          <span className="min-w-0 truncate font-mono">{shortPath(w.dir) || t("workspaces.pathPending")}</span>
          {w.dir ? (
            <button className={iconBtn(22)} title={t("workspaces.copyPath")} onClick={() => {
              void navigator.clipboard.writeText(w.dir!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
            }}>{copied ? <IconCheck size={12} /> : <IconCopy size={12} />}</button>
          ) : null}
        </span>
      }
      actions={<>
        {w.dir ? (
          <button className={btnRow("ghost", "sm")} onClick={() => void desktop.openPath(w.dir!)}>
            <IconFolder size={12} />{t("workspaces.openFolder")}
          </button>
        ) : null}
        {/* 「在此新建任务」跳到聊天页：任务是在对话里发起的，这里只负责把人送过去。 */}
        <button className={btn("ghost", "sm")} onClick={() => legacy.goNav("chat")}>{t("workspaces.newTaskHere")}</button>
        <button className={btnRow("danger", "sm")} title={t("workspaces.remove")} onClick={onRemove}>
          <IconTrash size={12} />{t("workspaces.remove")}
        </button>
      </>}
    />
    <StatBar>
      {stats.map((s) => (
        <span key={s.k} className="flex-none flex items-baseline gap-[5px] min-w-0">
          <span className="text-faint">{s.k}</span>
          <span className="text-text font-medium truncate" title={s.v}>{s.v}</span>
        </span>
      ))}
    </StatBar>

    <div className="flex-1 overflow-y-auto p-[7px_20px_28px]">
      <div className="flex gap-[18px] items-start">
        <div className="flex-1 min-w-0 flex flex-col gap-[10px]">
          <div>
            <SectionHeader action={
              <button className="flex-none whitespace-nowrap bg-transparent border-none p-0 text-[11.5px] text-orange-text cursor-pointer hover:text-orange-deep" onClick={() => legacy.goNav("tasks")}>
                {t("workspaces.viewAllInTasks")}
              </button>
            }>{t("workspaces.relatedJobs")}</SectionHeader>
            <div className="flex flex-col gap-[7px]">
              {tasks.map((j) => (
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
              {!tasks.length ? <div className="text-[12px] text-muted">{t("workspaces.noRelatedJobs")}</div> : null}
            </div>
          </div>

          <div>
            <SectionHeader>{t("workspaces.descTitle")}</SectionHeader>
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
                {/* 「保存」不再是橙实心：一页只准一颗主按钮，那颗在页头（新增）。 */}
                {editing ? (<>
                  <button className={btn("ghost", "sm")} onClick={() => setEditing(false)}>{t("common.cancel")}</button>
                  <button className={btn("ghost", "sm")} disabled={saving} onClick={() => void saveDesc()}>{t("common.save")}</button>
                </>) : (
                  <button className={btnRow("ghost", "sm")} onClick={() => { setDraft(w.description || ""); setEditing(true); }}>
                    <IconPencil size={12} />{t("common.edit")}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 目录内容：只读顶层前 5 项。走 PC 侧 IPC；Web 端没有桥 → total=-1 → 显示读不到。 */}
        <div className="w-[330px] flex-none">
          <SectionHeader count={dir.total >= 0 ? t("workspaces.dirCount", { n: dir.total }) : undefined}>
            {t("workspaces.dirTitle")}
          </SectionHeader>
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
                <button className="flex-none whitespace-nowrap bg-transparent border-none p-0 text-[11px] text-orange-text cursor-pointer hover:text-orange-deep" onClick={() => void desktop.openPath(w.dir!)}>
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
