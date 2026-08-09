// 灵感页（React + Tailwind），按 ClaudeDesign「Umbra 灵感」设计稿三栏布局：
//   186px 筛选轨（状态 + 标签云） | 双列卡片网格（搜索 / 排序 / 记灵感） | 392px 详情栏
// 数据由 legacy shell 轮询（getInspState），变更后调 manualRefreshInsp 立即回读。
// 状态筛选走服务端（setInspFilter），搜索 / 标签 / 排序都在本地做——灵感量级很小，没必要来回请求。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as legacy from "../../app/shell";
import { btnGhost, btnIcon, btnPrimary, selectBox, ConfirmDialog, Modal, RefreshButton } from "../../components/ui";
import {
  IconArrowRight, IconBulb, IconChat, IconCheck, IconCopy, IconKeyboard,
  IconPencil, IconPhone, IconPlus, IconSearch, IconTrash,
} from "../../components/icons";
import {
  createInspiration, deleteInspirations, fetchJobDetail, organizeStateOf,
  requestInspirationResearch, researchInFlight, researchStateOf, updateInspiration,
} from "../../services/server";
import type { Inspiration, Job } from "../../services/server";
import { mdToHtml } from "../chat/markdown";

type Filter = "" | "open" | "done" | "archived";
type Sort = "recent" | "updated" | "tag";

// 三种状态各自的徽章配色与圆点色（圆点用在左侧筛选轨上）。
const STATE_META: Record<string, { key: string; badge: string; dot: string }> = {
  open: { key: "inspiration.statusOpen", badge: "bg-orange-soft text-orange-text", dot: "bg-orange" },
  done: { key: "inspiration.statusDone", badge: "bg-success-soft text-success", dot: "bg-success" },
  archived: { key: "inspiration.statusArchived", badge: "bg-chip text-muted", dot: "bg-faint" },
};
const metaOf = (s: string) => STATE_META[s] || STATE_META.open;

// source_channel 的取值是开放的（manual 由本页写入，其余由各端上报），
// 认识的给中文名 + 图标，不认识的原样显示，不猜。
const SOURCE_META: Record<string, { key: string; Icon: typeof IconChat }> = {
  manual: { key: "inspiration.sourceManual", Icon: IconPencil },
  chat: { key: "inspiration.sourceChat", Icon: IconChat },
  assist: { key: "inspiration.sourceChat", Icon: IconChat },
  hotkey: { key: "inspiration.sourceHotkey", Icon: IconKeyboard },
  phone: { key: "inspiration.sourcePhone", Icon: IconPhone },
  ios: { key: "inspiration.sourcePhone", Icon: IconPhone },
};

// 标签胶囊：选中态跟着左侧标签云联动高亮。
const tagChip = (on: boolean) =>
  `flex-none whitespace-nowrap px-[8px] py-[1px] rounded-full text-[10.5px] ${
    on ? "bg-orange-soft text-orange-text" : "bg-chip text-muted"}`;

// 「让 Umbra 去做这件事」发给秘书的那条消息。
//
// 为什么是**跳聊天页 + 切「执行」模式 + 发一段固定格式的文字**，而不是直接调 create_task：
// 灵感常常只是一句话，直接建任务等于让秘书拿着半个需求硬做。走执行模式让它先把需求问清楚，
// 确认之后再由它自己决定建几个任务、怎么拆 —— 这是秘书本来就擅长的事。
//
// 为什么把灵感**正文整段带上**，而不是只发一个 id 让它自己查：
// 秘书手上查灵感的工具是 list_inspirations，它只回「标题 + 标签」，拿不到正文；
// 只给 id 的话它得靠关键词去搜，搜不到就只能瞎猜。id 也一并附上，方便它回头引用。
function doItPrompt(item: Inspiration): string {
  const body = [
    item.title ? `标题：${item.title}` : "",
    item.summary ? `摘要：${item.summary}` : "",
    item.raw ? `原文：${item.raw}` : "",
    item.tags?.length ? `标签：${item.tags.join("、")}` : "",
    `灵感 ID：${item.id}`,
  ].filter(Boolean).join("\n");
  return [
    "下面是我记录的一条灵感。请先分析它到底想要什么，有不清楚的地方随时问我；",
    "等你确认完全清楚之后，再创建任务把它实现。灵感内容如下：",
    "",
    body,
  ].join("\n");
}

export function Inspirations() {
  const { t } = useTranslation();
  const st = legacy.getInspState();
  const [sel, setSel] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("recent");
  const [editing, setEditing] = useState<Inspiration | null | undefined>(undefined); // undefined=关闭，null=新增
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const filter = st.filter as Filter;

  // 标签云只统计当前状态筛选下的条目——切到「归档」就只看得到归档里出现过的标签。
  const tags = useMemo(() => {
    const n: Record<string, number> = {};
    for (const i of st.list) for (const g of i.tags) n[g] = (n[g] || 0) + 1;
    return Object.keys(n).sort((a, b) => n[b] - n[a] || a.localeCompare(b)).map((label) => ({ label, n: n[label] }));
  }, [st.list]);

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    let out = st.list.filter((i) => {
      if (tag && !i.tags.includes(tag)) return false;
      if (!kw) return true;
      return [i.title, i.raw, i.summary, i.tags.join(" ")].some((s) => (s || "").toLowerCase().includes(kw));
    });
    if (sort === "updated") out = [...out].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    // 「标签分组」= 按首个标签把同类聚在一起，组内仍按时间倒序；没有标签的排在最后。
    else if (sort === "tag") {
      out = [...out].sort((a, b) => {
        const ka = a.tags[0] || "￿", kb = b.tags[0] || "￿";
        return ka === kb ? (b.created_at || "").localeCompare(a.created_at || "") : ka.localeCompare(kb);
      });
    }
    return out;
  }, [st.list, q, tag, sort]);

  // 不默认选中：进页面时右侧是空态，点一下选中、再点一下取消。
  // 选中项被筛掉时自然回到空态（find 找不到就是 null），不擅自跳到别的条目。
  const current = list.find((i) => i.id === sel) || null;
  const pick = (id: number) => setSel((prev) => (prev === id ? null : id));

  const setFilter = (f: Filter) => { legacy.setInspFilter(f); setSel(null); };

  const stateFilters: { k: Filter; label: string; n: number; dot: string }[] = [
    { k: "", label: t("inspiration.filterAll"), n: st.counts.all, dot: "bg-faint" },
    { k: "open", label: t("inspiration.statusOpen"), n: st.counts.open, dot: STATE_META.open.dot },
    { k: "done", label: t("inspiration.statusDone"), n: st.counts.done, dot: STATE_META.done.dot },
    { k: "archived", label: t("inspiration.statusArchived"), n: st.counts.archived, dot: STATE_META.archived.dot },
  ];

  const doDelete = async () => {
    if (!current) return;
    setBusy(true);
    await deleteInspirations([current.id]);
    setBusy(false);
    setConfirming(false);
    setSel(null);
    legacy.manualRefreshInsp();
  };

  return (
    <div className="h-full flex min-h-0">
      {/* ── 筛选轨 ── */}
      <aside className="w-[186px] flex-none bg-rail border-r border-border flex flex-col min-h-0">
        <div className="flex-none p-[14px_12px_10px]">
          <div className="text-[15px] font-semibold">{t("inspiration.title")}</div>
          <div className="text-[11px] text-faint mt-[3px] leading-[1.5]">{t("inspiration.railSubtitle")}</div>
        </div>

        <div className="flex-1 overflow-y-auto p-[0_8px_12px]">
          <div className="mb-[14px]">
            <RailLabel>{t("inspiration.railState")}</RailLabel>
            <div className="flex flex-col gap-px">
              {stateFilters.map((f) => {
                const on = filter === f.k;
                return (
                  <button key={f.k} onClick={() => setFilter(f.k)}
                    className={`flex items-center gap-[8px] w-full px-[8px] py-[6px] rounded-[8px] border-none text-[12.5px] cursor-pointer ${
                      on ? "bg-orange-soft text-orange-text font-semibold" : "bg-transparent text-text hover:bg-hover"}`}>
                    <span className={`w-[7px] h-[7px] flex-none rounded-full ${f.dot}`} />
                    <span className="flex-1 text-left whitespace-nowrap">{f.label}</span>
                    <span className={`flex-none text-[10.5px] font-semibold ${on ? "text-orange-text" : "text-faint"}`}>{f.n}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-[6px] p-[0_8px_6px]">
              <span className="flex-1 text-[10.5px] font-semibold tracking-[.06em] text-faint">{t("inspiration.railTags")}</span>
              {tag ? (
                <button onClick={() => setTag(null)}
                  className="flex-none whitespace-nowrap p-0 border-none bg-transparent text-orange-text hover:text-orange-deep text-[10.5px] cursor-pointer">
                  {t("inspiration.clearTag")}
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-[5px] px-[8px]">
              {tags.length ? tags.map((g) => {
                const on = tag === g.label;
                return (
                  <button key={g.label} onClick={() => setTag(on ? null : g.label)}
                    className={`flex-none whitespace-nowrap flex items-center gap-[4px] px-[8px] py-[2px] rounded-full border text-[11px] cursor-pointer hover:border-orange ${
                      on ? "border-orange bg-orange-soft text-orange-text font-semibold" : "border-border bg-transparent text-muted"}`}>
                    {g.label}<span className={`text-[9.5px] ${on ? "text-orange-text" : "text-faint"}`}>{g.n}</span>
                  </button>
                );
              }) : <span className="text-[11px] text-faint px-[1px]">{t("inspiration.noTags")}</span>}
            </div>
          </div>
        </div>

        <div className="flex-none p-[11px_12px] border-t border-border">
          <div className="text-[10.5px] text-faint leading-[1.65]">{t("inspiration.railFootnote")}</div>
        </div>
      </aside>

      {/* ── 网格列 ── */}
      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex-none flex items-center gap-[9px] p-[13px_16px] border-b border-border bg-card">
          <div className="flex-1 min-w-0 flex items-center gap-[7px] bg-bg border border-border rounded-[8px] px-[9px] py-[5px]">
            <span className="flex-none text-faint"><IconSearch size={12} /></span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("inspiration.searchPlaceholder")}
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-[12px]" />
          </div>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={selectBox}>
            <option value="recent">{t("inspiration.sortRecent")}</option>
            <option value="updated">{t("inspiration.sortUpdated")}</option>
            <option value="tag">{t("inspiration.sortTag")}</option>
          </select>
          <button className={btnPrimary} onClick={() => setEditing(null)}>
            <span className="inline-flex items-center gap-[5px]"><IconPlus size={12} />{t("inspiration.add")}</span>
          </button>
          <RefreshButton onClick={() => legacy.manualRefreshInsp()} spinning={st.refreshing} />
        </div>

        {/* 详情栏关掉后中间会宽出 392px，固定两列会把卡片撑得很空，
            所以按 300px 最小宽度自动分列：详情栏开着仍是设计稿的两列，关掉自动变三列。 */}
        <div className="flex-1 overflow-y-auto p-[12px]">
          {list.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-[10px] content-start">
              {list.map((i) => <Card key={i.id} item={i} on={current?.id === i.id} tag={tag} onPick={() => pick(i.id)} />)}
            </div>
          ) : (
            <div className="h-[420px] flex flex-col items-center justify-center gap-[11px]">
              <span className="w-[46px] h-[46px] rounded-[13px] bg-orange-soft text-orange-text flex items-center justify-center"><IconBulb size={22} /></span>
              <div className="text-[13.5px] font-semibold">{st.loading ? t("inspiration.loading") : t("inspiration.emptyTitle")}</div>
              <div className="text-[12px] text-muted text-center leading-[1.7] max-w-[330px]">{t("inspiration.emptyHint")}</div>
              <button className={btnPrimary} onClick={() => setEditing(null)}>{t("inspiration.emptyAction")}</button>
            </div>
          )}
        </div>
      </section>

      {/* ── 详情栏 ── 没选中就整列不出现，中间的网格自己撑满剩余宽度 */}
      {current ? (
        <aside className="w-[392px] flex-none bg-card border-l border-border flex flex-col min-h-0">
          <Detail
            key={current.id}
            item={current}
            busy={busy}
            onEdit={() => setEditing(current)}
            onDelete={() => setConfirming(true)}
            onChanged={() => legacy.manualRefreshInsp()}
            setBusy={setBusy}
          />
        </aside>
      ) : null}

      {editing !== undefined ? (
        <Editor item={editing} onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); legacy.manualRefreshInsp(); }} />
      ) : null}

      {confirming && current ? (
        <ConfirmDialog danger busy={busy} message={t("inspiration.confirmDeleteOne")}
          confirmText={t("inspiration.confirmDeleteBtn")}
          onConfirm={doDelete} onCancel={() => setConfirming(false)} />
      ) : null}
    </div>
  );
}

// 筛选轨里的分组小标题：10.5px 600 + 字距，两处共用。
function RailLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10.5px] font-semibold tracking-[.06em] text-faint p-[0_8px_6px]">{children}</div>;
}

// 详情栏里的分区小标题。
function SecLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10.5px] font-semibold tracking-[.06em] text-faint mb-[7px]">{children}</div>;
}

// 来源一行：图标 + 名字。认不出来的 channel 原样显示。
function Source({ channel, size = 11 }: { channel?: string; size?: number }) {
  const { t } = useTranslation();
  const m = SOURCE_META[channel || ""];
  if (!m) return <>{channel || t("inspiration.sourceUnknown")}</>;
  const Icon = m.Icon;
  return <><Icon size={size} />{t(m.key)}</>;
}

function Card({ item, on, tag, onPick }: { item: Inspiration; on: boolean; tag: string | null; onPick: () => void }) {
  const { t } = useTranslation();
  const m = metaOf(item.status);
  const title = item.title || item.raw.slice(0, 24) + (item.raw.length > 24 ? "…" : "");
  return (
    <div onClick={onPick}
      className={`bg-card border rounded-[12px] p-[12px_14px] cursor-pointer ${
        on ? "border-orange shadow-[inset_3px_0_0_var(--orange)]" : "border-border hover:border-orange"} ${
        item.status === "archived" ? "opacity-[.72]" : ""}`}>
      <div className="flex items-center gap-[7px]">
        <span className={`flex-none whitespace-nowrap px-[8px] py-[1px] rounded-full text-[10.5px] font-semibold ${m.badge}`}>{t(m.key)}</span>
        <span className="flex-1" />
        <span className="flex-none whitespace-nowrap text-[10.5px] text-faint">{legacy.fmtListTime(item.created_at)}</span>
      </div>
      <div className="text-[13.5px] font-semibold mt-[8px] leading-[1.4] line-clamp-2">{title}</div>
      <div className="text-[12px] text-muted mt-[6px] leading-[1.65] whitespace-pre-wrap line-clamp-3">{item.raw}</div>
      {item.tags.length || organizeStateOf(item) === "pending" || researchInFlight(item) ? (
        <div className="flex flex-wrap gap-[4px] mt-[9px]">
          {/* 进行时提示用 faint 字，别和用户自己打的标签抢注意力 */}
          {organizeStateOf(item) === "pending" ? (
            <span className="flex-none whitespace-nowrap px-[8px] py-[1px] rounded-full text-[10.5px] bg-chip text-faint">{t("inspiration.organizing")}</span>
          ) : null}
          {researchInFlight(item) ? (
            <span className="flex-none whitespace-nowrap px-[8px] py-[1px] rounded-full text-[10.5px] bg-chip text-faint">{t("inspiration.researching")}</span>
          ) : null}
          {item.tags.slice(0, 4).map((g, k) => <span key={k} className={tagChip(tag === g)}>{g}</span>)}
        </div>
      ) : null}
      <div className="flex items-center gap-[7px] mt-[10px] pt-[9px] border-t border-border-soft">
        <span className="flex-1 inline-flex items-center gap-[4px] text-[10.5px] text-faint whitespace-nowrap">
          <Source channel={item.source_channel} />
        </span>
        {item.job_id ? (
          <span className="flex-none inline-flex items-center gap-[4px] text-[10.5px] text-success whitespace-nowrap">
            <IconCheck size={10} />{t("inspiration.linkedJob")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Detail({ item, busy, onEdit, onDelete, onChanged, setBusy }: {
  item: Inspiration;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => void;
  setBusy: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const m = metaOf(item.status);

  // 关联任务的标题 / 状态 / 时间不在灵感行里，按 job_id 单独取一次（只有选中项会取）。
  useEffect(() => {
    let alive = true;
    setJob(null);
    if (!item.job_id) return;
    fetchJobDetail(item.job_id).then((d) => { if (alive && d) setJob(d.job); });
    return () => { alive = false; };
  }, [item.job_id]);

  const setStatus = async (status: string) => {
    setBusy(true);
    await updateInspiration(item.id, { status });
    setBusy(false);
    onChanged();
  };
  const copy = () => {
    const text = [item.title, item.raw, item.summary, item.tags.join(" ")].filter(Boolean).join("\n");
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (<>
    <div className="flex-none p-[14px_16px_13px] border-b border-border">
      <div className="flex items-center gap-[8px]">
        <span className={`flex-none whitespace-nowrap px-[9px] py-[2px] rounded-full text-[11px] font-semibold ${m.badge}`}>{t(m.key)}</span>
        <span className="flex-1" />
        <button className={`${btnIcon} hover:border-orange hover:text-orange-text`} title={t("common.edit")} onClick={onEdit}><IconPencil size={12} /></button>
        <button className={`${btnIcon} hover:border-orange hover:text-orange-text`} title={copied ? t("common.copied") : t("common.copy")} onClick={copy}>
          {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
        </button>
        <button className={`${btnIcon} hover:border-danger hover:text-danger`} title={t("common.delete")} onClick={onDelete}><IconTrash size={12} /></button>
      </div>
      <div className="text-[15.5px] font-semibold leading-[1.45] mt-[9px]" style={{ textWrap: "pretty" } as React.CSSProperties}>
        {item.title || item.raw.slice(0, 30)}
      </div>
      <div className="flex items-center gap-[8px] mt-[8px] text-[11px] text-faint">
        <span className="inline-flex items-center gap-[4px] whitespace-nowrap"><Source channel={item.source_channel} /></span>
        <span>·</span>
        <span className="whitespace-nowrap">{legacy.fmtListTime(item.created_at)}</span>
      </div>
    </div>

    <div className="flex-1 overflow-y-auto p-[14px_16px_20px] flex flex-col gap-[15px]">
      <div>
        <SecLabel>{t("inspiration.rawLabel")}</SecLabel>
        <div className="text-[12.5px] leading-[1.75] whitespace-pre-wrap bg-bg border border-border rounded-[10px] p-[11px_12px]"
          style={{ textWrap: "pretty" } as React.CSSProperties}>{item.raw}</div>
      </div>

      {item.summary ? (
        <div>
          <div className="flex items-center gap-[6px] mb-[7px]">
            <span className="flex-none text-orange-text"><IconBulb size={12} /></span>
            <span className="flex-1 text-[10.5px] font-semibold tracking-[.06em] text-faint">{t("inspiration.summaryLabel")}</span>
          </div>
          <div className="bg-orange-soft rounded-[10px] p-[11px_12px]">
            <div className="text-[12.5px] leading-[1.7] text-orange-text" style={{ textWrap: "pretty" } as React.CSSProperties}>{item.summary}</div>
          </div>
        </div>
      ) : organizeStateOf(item) === "pending" ? (
        // 手动记完立刻点进来，这一节空着会让人以为没在整理，转头就自己去填标题了。
        <div>
          <SecLabel>{t("inspiration.summaryLabel")}</SecLabel>
          <div className="text-[12px] text-faint leading-[1.7]">{t("inspiration.organizingHint")}</div>
        </div>
      ) : null}

      <Research item={item} onChanged={onChanged} />

      <div>
        <SecLabel>{t("inspiration.railTags")}</SecLabel>
        <div className="flex flex-wrap gap-[5px]">
          {item.tags.map((g, k) => <span key={k} className={tagChip(false)}>{g}</span>)}
          <button onClick={onEdit}
            className="flex-none whitespace-nowrap flex items-center gap-[3px] px-[9px] py-[2px] rounded-full border border-dashed border-border bg-transparent text-faint text-[11px] cursor-pointer hover:border-orange hover:text-orange-text">
            <IconPlus size={10} />{t("inspiration.addTag")}
          </button>
        </div>
      </div>

      {item.job_id ? (
        <div>
          <SecLabel>{t("inspiration.jobLabel")}</SecLabel>
          <div className="flex items-center gap-[9px] border border-border rounded-[10px] p-[10px_12px] hover:border-orange">
            <span className="w-[22px] h-[22px] flex-none rounded-[6px] bg-success-soft text-success flex items-center justify-center"><IconCheck size={12} /></span>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] truncate">{job ? (job.name || job.goal) : item.job_id}</div>
              <div className="text-[10.5px] text-faint mt-[2px] whitespace-nowrap">
                {job ? `${t(`tasks.status${job.status.charAt(0).toUpperCase()}${job.status.slice(1)}`, { defaultValue: job.status })} · ${legacy.fmtListTime(job.updated_at)}` : t("common.loading")}
              </div>
            </div>
            <button onClick={() => legacy.openTaskFrom(item.job_id!)}
              className="flex-none whitespace-nowrap p-0 border-none bg-transparent text-orange-text hover:text-orange-deep text-[11px] cursor-pointer">
              {t("inspiration.jobOpen")}
            </button>
          </div>
        </div>
      ) : null}
    </div>

    <div className="flex-none p-[12px_16px] border-t border-border bg-bg flex flex-col gap-[9px]">
      <button onClick={() => legacy.sendToChat(doItPrompt(item), "execution")}
        className="w-full flex items-center justify-center gap-[6px] px-0 py-[8px] bg-orange text-white border-none rounded-[8px] text-[12.5px] font-semibold cursor-pointer hover:bg-orange-deep">
        <IconArrowRight size={13} />{t("inspiration.sendToChat")}
      </button>
      <div className="flex gap-[7px]">
        <button disabled={busy} onClick={() => setStatus(item.status === "done" ? "open" : "done")}
          className="flex-1 py-[7px] border border-border bg-transparent text-text rounded-[8px] text-[12px] cursor-pointer whitespace-nowrap hover:border-success hover:text-success disabled:opacity-45">
          {item.status === "done" ? t("inspiration.markOpen") : t("inspiration.markDone")}
        </button>
        <button disabled={busy} onClick={() => setStatus(item.status === "archived" ? "open" : "archived")}
          className="flex-1 py-[7px] border border-border bg-transparent text-text rounded-[8px] text-[12px] cursor-pointer whitespace-nowrap hover:border-orange hover:text-orange-text disabled:opacity-45">
          {item.status === "archived" ? t("inspiration.unarchive") : t("inspiration.archive")}
        </button>
      </div>
    </div>
  </>);
}

// 详情栏的「秘书调研」一节。
//
// 四个状态各画各的，**不合并成「有内容就显示」**：「还没查过」和「查了但失败了」
// 对用户是完全不同的两件事 —— 前者该给按钮，后者该说清为什么再给重试。
// 合成一个的话失败会静默退化成「没查过」，用户点了半天不知道一直在失败。
function Research({ item, onChanged }: { item: Inspiration; onChanged: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const state = researchStateOf(item);

  const go = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await requestInspirationResearch(item.id);
    setBusy(false);
    // 没排上就如实说（多半是服务端还没升级到带这个路由的版本），
    // 不要静默失败 —— 那样用户只会以为按钮坏了，一直点。
    if (!ok) { setFailed(true); return; }
    onChanged();
  };

  const askBtn = (label: string) => (
    <button disabled={busy} onClick={go}
      className="flex-none whitespace-nowrap px-[11px] py-[6px] border border-border bg-transparent text-text rounded-[8px] text-[12px] cursor-pointer hover:border-orange hover:text-orange-text disabled:opacity-45">
      {busy ? t("inspiration.researchQueuing") : label}
    </button>
  );

  return (
    <div>
      <SecLabel>{t("inspiration.researchLabel")}</SecLabel>

      {state === "queued" || state === "running" ? (
        <div className="text-[12px] text-muted leading-[1.7] border border-border rounded-[10px] p-[10px_12px]">
          {t(state === "queued" ? "inspiration.researchQueued" : "inspiration.researchRunning")}
        </div>
      ) : state === "done" && item.research ? (
        <div className="border border-border rounded-[10px] p-[11px_12px]">
          {/* 服务端产出的是 Markdown（要点 + 链接）。mdToHtml 是先整体转义再替换标记的，
              注入不进来，可以放心 dangerouslySetInnerHTML。 */}
          <div className="text-[12.5px] leading-[1.75]" dangerouslySetInnerHTML={{ __html: mdToHtml(item.research) }} />
          <div className="flex items-center gap-[8px] mt-[9px] pt-[8px] border-t border-border-soft">
            <span className="flex-1 text-[10.5px] text-faint whitespace-nowrap">
              {item.research_at ? `${t("inspiration.researchAt")} ${legacy.fmtListTime(item.research_at)}` : ""}
            </span>
            {askBtn(t("inspiration.researchAgain"))}
          </div>
        </div>
      ) : state === "failed" ? (
        <div className="border border-border rounded-[10px] p-[10px_12px] flex flex-col gap-[9px]">
          {/* 失败原因是服务端写进 research 的（没配搜索 key？模型限流？），原样显示，
              不要翻译成「出错了」这种等于没说的话。 */}
          <div className="text-[12px] text-muted leading-[1.7] whitespace-pre-wrap">
            {item.research || t("inspiration.researchFailed")}
          </div>
          <div className="flex"><span className="flex-1" />{askBtn(t("inspiration.researchRetry"))}</div>
        </div>
      ) : (
        <div className="flex items-start gap-[10px]">
          <div className="flex-1 text-[12px] text-muted leading-[1.7]">{t("inspiration.researchHint")}</div>
          {askBtn(t("inspiration.researchAsk"))}
        </div>
      )}

      {failed ? (
        <div className="text-[11px] text-danger mt-[6px] leading-[1.6]">{t("inspiration.researchQueueFailed")}</div>
      ) : null}
    </div>
  );
}

// 记灵感 / 编辑弹窗（item 为 null 时是新增）。⌘↩ / Ctrl+↩ 直接保存。
function Editor({ item, onClose, onSaved }: { item: Inspiration | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState(item?.raw || "");
  const [title, setTitle] = useState(item?.title || "");
  const [tags, setTags] = useState((item?.tags || []).join(", "));
  const [busy, setBusy] = useState(false);
  // **默认关**（2026-08-08 与用户确认）：想查再勾，不是不想查再取消。
  const [research, setResearch] = useState(false);

  const parseTags = () => tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const save = async () => {
    if (!raw.trim() || busy) return;
    setBusy(true);
    if (item) await updateInspiration(item.id, { raw, title, tags: parseTags() });
    else await createInspiration({ raw, title, tags: parseTags(), research });
    setBusy(false);
    onSaved();
  };

  const field = "w-full border border-border bg-bg text-text rounded-[8px] px-[11px] py-[7px] text-[12.5px] outline-none focus:border-orange";
  return (
    <Modal width={500} onClose={onClose}
      title={<span className="flex items-center gap-[10px]">
        <span className="w-[24px] h-[24px] flex-none rounded-[7px] bg-orange-soft text-orange-text flex items-center justify-center"><IconBulb size={13} /></span>
        {item ? t("inspiration.editTitle") : t("inspiration.newTitle")}
      </span>}
      footer={<>
        <span className="flex-1 text-[11px] text-faint whitespace-nowrap">{t("inspiration.saveHotkey")}</span>
        <button className={btnGhost} onClick={onClose}>{t("common.cancel")}</button>
        <button className={btnPrimary} disabled={busy || !raw.trim()} onClick={save}>{t("common.save")}</button>
      </>}>
      <div className="flex flex-col gap-[13px]"
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void save(); }}>
        <div>
          <div className="text-[11.5px] text-muted mb-[5px]">{t("inspiration.fieldRaw")}</div>
          <textarea rows={5} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder={t("inspiration.rawPh")}
            className={`${field} rounded-[9px] px-[12px] py-[10px] leading-[1.7] resize-y`} />
        </div>
        <div className="flex gap-[10px]">
          <div className="flex-1 min-w-0">
            <div className="text-[11.5px] text-muted mb-[5px]">{t("inspiration.fieldTitle")}</div>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("inspiration.titlePh")} className={field} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[11.5px] text-muted mb-[5px]">{t("inspiration.railTags")}</div>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t("inspiration.tagsPh")} className={field} />
          </div>
        </div>
        <div className="flex items-center gap-[9px] bg-orange-soft rounded-[9px] p-[9px_11px]">
          <span className="flex-none text-orange-text"><IconBulb size={13} /></span>
          <span className="flex-1 text-[11.5px] text-orange-text leading-[1.55]">{t("inspiration.autoFillHint")}</span>
        </div>
        {/* 「顺便查一查」只在新建时出现 —— 改一条已有灵感时想查，详情栏有「帮我查查」，
            在这儿再放一个只会让人搞不清点了会不会重查一遍。 */}
        {item ? null : (
          <label className="flex items-start gap-[9px] border border-border rounded-[9px] p-[9px_11px] cursor-pointer hover:border-orange">
            <input type="checkbox" checked={research} onChange={(e) => setResearch(e.target.checked)}
              className="flex-none mt-[2px] accent-[var(--orange)] cursor-pointer" />
            <span className="flex-1">
              <span className="block text-[12.5px]">{t("inspiration.researchOnCreate")}</span>
              <span className="block text-[11px] text-faint leading-[1.6] mt-[2px]">{t("inspiration.researchOnCreateHint")}</span>
            </span>
          </label>
        )}
      </div>
    </Modal>
  );
}
