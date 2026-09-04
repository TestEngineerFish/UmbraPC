// 灵感页（React + Tailwind）。批次 012 起套页面骨架的 **T1 列表 + 详情**：
//   页头（标题「灵感」+ 计数副标题 + 「记灵感」主按钮 + 「刷新」次级钮，刷新中旋转弧在状态槽；
//   第二行 = 搜索 + 排序下拉 + 状态筛选芯片，行末一个「标签」下拉） | 左列表 400（列内单列卡片） | 右详情 flex
// 原来的 186px 筛选轨（状态 + 标签云）整个撤掉：状态项变成第二行的筛选芯片，标签云收成行末的下拉。
// 数据由 legacy shell 轮询（getInspState），变更后调 manualRefreshInsp 立即回读。
// 状态筛选走服务端（setInspFilter），搜索 / 标签 / 排序都在本地做——灵感量级很小，没必要来回请求。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as legacy from "../../app/shell";
import { btn, btnRow, btnGhost, btnPrimary, select as selectCls, ConfirmDialog, Modal, EmptyState, filterChip, filterChipCount } from "../../components/ui";
import { PageShell, HeaderSearch, ListDetail, CardList, ListCard, DetailHead, SectionHeader, detailIconBtn, SyncSpinner, Skeleton } from "../../components/layout";
import { showToast } from "../../components/overlay";
import { ImageViewer, openInViewerWindow } from "../../components/ImageViewer";
import {
  IconArrowRight, IconBulb, IconChat, IconCheck, IconCopy, IconKeyboard,
  IconPencil, IconPhone, IconPlus, IconTrash,
} from "../../components/icons";
import {
  createInspiration, deleteInspirations, fetchTaskDetail, fileUrl, organizeStateOf,
  requestInspirationResearch, researchInFlight, researchStateOf, updateInspiration,
} from "../../services/server";
import type { Inspiration, TaskItem } from "../../services/server";
import { mdToHtml } from "../chat/markdown";

type Filter = "" | "open" | "done" | "archived";
type Sort = "recent" | "updated" | "tag";

// 三种状态各自的徽章配色。（原筛选轨上的状态圆点随轨一起撤了：第二行的筛选芯片和任务页同款，只有文字 + 计数。）
const STATE_META: Record<string, { key: string; badge: string }> = {
  open: { key: "inspiration.statusOpen", badge: "bg-orange-soft text-orange-text" },
  done: { key: "inspiration.statusDone", badge: "bg-success-soft text-success" },
  archived: { key: "inspiration.statusArchived", badge: "bg-chip text-muted" },
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

// 标签胶囊：选中态跟着第二行的标签下拉联动高亮。
const tagChip = (on: boolean) =>
  `flex-none whitespace-nowrap px-[8px] py-[1px] rounded-full text-[10.5px] ${
    on ? "bg-orange-soft text-orange-text" : "bg-chip text-muted"}`;

// 「让 Umbra 去做这件事」发给秘书的那条消息。
//
// 为什么是**跳聊天页 + 预填「创建任务」芯片 + 这段文字**（批次 005 起，原「执行模式」已撤），
// 而不是直接调 create_task：灵感常常只是一句话，直接建任务等于让秘书拿着半个需求硬做。
// 预填不直发 —— 用户看一眼、补两句再回车；芯片把意图递给秘书，由它先问清楚
// 再决定建几个任务、怎么拆 —— 这是秘书本来就擅长的事。
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

  // 标签下拉只统计当前状态筛选下的条目——切到「归档」就只看得到归档里出现过的标签。
  const tags = useMemo(() => {
    const n: Record<string, number> = {};
    for (const i of st.list) for (const g of i.tags) n[g] = (n[g] || 0) + 1;
    return Object.keys(n).sort((a, b) => n[b] - n[a] || a.localeCompare(b)).map((label) => ({ label, n: n[label] }));
  }, [st.list]);
  // 选中的标签在当前状态下一条都没有时（切了状态筛选），下拉里仍要有它这一项 ——
  // 否则受控 select 会回落到「全部标签」，看着像没筛，列表却还是按它筛空的。
  const tagOptions = tag && !tags.some((g) => g.label === tag) ? [{ label: tag, n: 0 }, ...tags] : tags;

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

  // 不默认选中：进页面时右侧是占位，点一下选中、再点一下取消。
  // 选中项被筛掉时自然回到占位（find 找不到就是 null），不擅自跳到别的条目。
  const current = list.find((i) => i.id === sel) || null;
  const pick = (id: number) => setSel((prev) => (prev === id ? null : id));

  const setFilter = (f: Filter) => { legacy.setInspFilter(f); setSel(null); };

  const stateFilters: { k: Filter; label: string; n: number }[] = [
    { k: "", label: t("inspiration.filterAll"), n: st.counts.all },
    { k: "open", label: t("inspiration.statusOpen"), n: st.counts.open },
    { k: "done", label: t("inspiration.statusDone"), n: st.counts.done },
    { k: "archived", label: t("inspiration.statusArchived"), n: st.counts.archived },
  ];

  const doDelete = async () => {
    if (!current) return;
    setBusy(true);
    // deleteInspirations 失败时返回 0 —— 之前这个返回值被丢掉了，删不掉也照样清空选中并刷新，
    // 界面看起来跟删成功一模一样。
    const n = await deleteInspirations([current.id]);
    setBusy(false);
    setConfirming(false);
    if (!n) { showToast(t("inspiration.deleteFailed"), { tone: "fail" }); return; }
    setSel(null);
    legacy.manualRefreshInsp();
    showToast(t("inspiration.deletedToast"), { tone: "ok" });
  };

  // 列表栏三种空法（shared.emptyState）：首屏骨架 / 无结果（有搜索、有标签、或筛了状态但别的状态下有货）/ 真空。
  // 状态筛选原来不算「无结果」—— 筛「已归档」一条没有时画的是带橙钮的真空态；裁定 8 之后那会和页头凑成两颗橙，
  // 所以按规范的三分法归位：整体有货只是这个状态下没有 = 无结果（清掉筛选连状态一起清）；整体一条都没有才是真空。
  const loadingFirst = st.loading && !st.list.length;
  const noResult = !!q.trim() || !!tag || (!!filter && st.counts.all > 0);
  // 裁定 8（tokens.pageTemplate.shared.emptyHeaderPrimary）：真空态时页头不渲染「记灵感」，橙留给空态里那颗。
  // 「真空」= 首屏骨架已过 && 列表一条都没有 && 不是无结果。判定和下面画空态的那条分支一字不差，页面上永远只有一颗橙。
  // （本页拿不到离线态：拉取失败回空列表，和真空同形 —— 那时列表栏画的也是这同一个空态，仍只有一颗橙。）
  const blank = !loadingFirst && !list.length && !noResult;

  return (
    <PageShell header={{
      title: t("inspiration.title"),
      subtitle: t("inspiration.countLine", { n: st.counts.all, open: st.counts.open }),
      status: st.refreshing ? <SyncSpinner /> : undefined,
      primary: blank ? undefined : { label: t("inspiration.add"), onClick: () => setEditing(null) },
      secondary: [{ label: t("common.refresh"), onClick: () => legacy.manualRefreshInsp() }],
      // 第二行从左到右：搜索 · 排序 · 四档状态芯片 · （撑开）· 标签下拉。
      // 搜索框收到 200（默认 240）、标签下拉封顶 150：这一行东西多，最小窗口（900 − 176 导航）下也得放得下。
      secondRow: (<>
        <HeaderSearch value={q} onChange={setQ} placeholder={t("inspiration.searchPlaceholder")} width={200} />
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={selectCls("sm")}>
          <option value="recent">{t("inspiration.sortRecent")}</option>
          <option value="updated">{t("inspiration.sortUpdated")}</option>
          <option value="tag">{t("inspiration.sortTag")}</option>
        </select>
        {stateFilters.map((f) => {
          const on = filter === f.k;
          return (
            <button key={f.k} onClick={() => setFilter(f.k)} className={filterChip(on, "sm")}>
              <span>{f.label}</span>
              <span className={filterChipCount(on)}>{f.n}</span>
            </button>
          );
        })}
        <span className="flex-1" />
        {/* 标签云收成一个下拉：全部 / 各标签（带计数）。没有标签时禁用并如实写出来。 */}
        <select value={tag ?? ""} onChange={(e) => setTag(e.target.value || null)} disabled={!tagOptions.length}
          className={`${selectCls("sm")} max-w-[150px]`} title={t("inspiration.railTags")}>
          <option value="">{tagOptions.length ? t("inspiration.allTags") : t("inspiration.noTags")}</option>
          {tagOptions.map((g) => <option key={g.label} value={g.label}>{g.label} ({g.n})</option>)}
        </select>
      </>),
    }}>
      <ListDetail
        listEmpty={!list.length}
        list={loadingFirst ? (
          <Skeleton rows={3} />
        ) : list.length ? (
          <CardList>
            {list.map((i) => <Card key={i.id} item={i} on={current?.id === i.id} tag={tag} onPick={() => pick(i.id)} />)}
          </CardList>
        ) : noResult ? (
          /* 空态走通用空态件（compact，放列表栏内；右侧只留底色）。
             硬规则说橙色只出现在主操作、当前选中、进度三处，空态图标不属于任何一处。
             无结果：清掉筛选把搜索、标签、状态一起清 —— 三样里任一样都可能是把列表筛空的那个。 */
          <EmptyState compact
            title={t("inspiration.noResult")}
            actionLabel={t("inspiration.clearFilter")}
            onAction={() => { setQ(""); setTag(null); if (filter) setFilter(""); }} />
        ) : (
          /* 真空：这颗「记一条灵感」就是这一页唯一的橙 —— 页头的主按钮此时不渲染（裁定 8，见上面的 blank）。 */
          <EmptyState compact
            title={t("inspiration.emptyTitle")}
            body={t("inspiration.emptyHint")}
            actionLabel={t("inspiration.emptyAction")}
            onAction={() => setEditing(null)} />
        )}
        detail={current ? (
          <Detail
            key={current.id}
            item={current}
            busy={busy}
            onEdit={() => setEditing(current)}
            onDelete={() => setConfirming(true)}
            onChanged={() => legacy.manualRefreshInsp()}
            setBusy={setBusy}
          />
        ) : null}
      />

      {editing !== undefined ? (
        <Editor item={editing} onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); legacy.manualRefreshInsp(); }} />
      ) : null}

      {confirming && current ? (
        <ConfirmDialog danger busy={busy} message={t("inspiration.confirmDeleteOne")}
          confirmText={t("inspiration.confirmDeleteBtn")}
          onConfirm={doDelete} onCancel={() => setConfirming(false)} />
      ) : null}
    </PageShell>
  );
}

// 来源一行：图标 + 名字。认不出来的 channel 原样显示。
function Source({ channel, size = 11 }: { channel?: string; size?: number }) {
  const { t } = useTranslation();
  const m = SOURCE_META[channel || ""];
  if (!m) return <>{channel || t("inspiration.sourceUnknown")}</>;
  const Icon = m.Icon;
  return <><Icon size={size} />{t(m.key)}</>;
}

// 列表里的一张灵感卡（卡片密度）。选中态照骨架件：1px --orange + --orange-soft，不再加左侧色条。
function Card({ item, on, tag, onPick }: { item: Inspiration; on: boolean; tag: string | null; onPick: () => void }) {
  const { t } = useTranslation();
  const m = metaOf(item.status);
  const title = item.title || item.raw.slice(0, 24) + (item.raw.length > 24 ? "…" : "");
  return (
    <ListCard onClick={onPick} selected={on}>
      {/* 归档的卡整体压淡；ListCard 不收 className，透明度套在内容层上。 */}
      <div className={item.status === "archived" ? "opacity-[.72]" : ""}>
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
          {item.task_id ? (
            <span className="flex-none inline-flex items-center gap-[4px] text-[10.5px] text-success whitespace-nowrap">
              <IconCheck size={10} />{t("inspiration.linkedJob")}
            </span>
          ) : null}
        </div>
      </div>
    </ListCard>
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
  const [task, setTask] = useState<TaskItem | null>(null);
  const m = metaOf(item.status);
  // 附件（批次 013：带图记灵感时服务端把原图挂上）。点开走通用 ImageViewer：先试独立图片窗
  // （批次 011，不遮详情），没有桥（网页预览 / 测试）退回窗口内 overlay —— 与记账弹窗同一套。
  const atts = item.atts || [];
  const [viewer, setViewer] = useState<string | null>(null);
  const viewerItems = atts.map((a) => ({ src: fileUrl(a.file_id), alt: a.label }));
  const openImg = (src: string) => { if (!openInViewerWindow(viewerItems, src)) setViewer(src); };

  // 关联任务的标题 / 状态 / 时间不在灵感行里，按 task_id 单独取一次（只有选中项会取）。
  useEffect(() => {
    let alive = true;
    setTask(null);
    if (!item.task_id) return;
    fetchTaskDetail(item.task_id).then((d) => { if (alive && d) setTask(d.task); });
    return () => { alive = false; };
  }, [item.task_id]);

  const setStatus = async (status: string) => {
    setBusy(true);
    const prev = item.status;
    const r = await updateInspiration(item.id, { status });
    setBusy(false);
    if (!r) { showToast(t("inspiration.updateFailed"), { tone: "fail" }); return; }
    onChanged();
    // 状态切换是可逆的，给撤销而不是给确认。
    showToast(t(status === "done" ? "inspiration.doneToast" : status === "archived" ? "inspiration.archivedToast" : "inspiration.reopenToast"), {
      tone: "ok",
      actionLabel: t("common.undo"),
      onAction: async () => { await updateInspiration(item.id, { status: prev }); onChanged(); },
    });
  };
  const copy = () => {
    const text = [item.title, item.raw, item.summary, item.tags.join(" ")].filter(Boolean).join("\n");
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (<>
    {/* 详情头走骨架件 DetailHead：状态徽章当前导，标题，「来源 · 时间」当副行；右上角编辑 / 复制 / 删除三颗 24 图标钮。 */}
    <DetailHead
      lead={<span className={`flex-none whitespace-nowrap px-[9px] py-[2px] rounded-full text-[11px] font-semibold ${m.badge}`}>{t(m.key)}</span>}
      title={<span style={{ textWrap: "pretty" } as React.CSSProperties}>{item.title || item.raw.slice(0, 30)}</span>}
      sub={
        <span className="flex items-center gap-[8px]">
          <span className="inline-flex items-center gap-[4px] whitespace-nowrap"><Source channel={item.source_channel} /></span>
          <span>·</span>
          <span className="whitespace-nowrap">{legacy.fmtListTime(item.created_at)}</span>
        </span>
      }
      actions={<>
        <button className={detailIconBtn} title={t("common.edit")} onClick={onEdit}><IconPencil size={13} /></button>
        <button className={detailIconBtn} title={copied ? t("common.copied") : t("common.copy")} onClick={copy}>
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
        </button>
        <button className={detailIconBtn} title={t("common.delete")} onClick={onDelete}><IconTrash size={13} /></button>
      </>}
    />

    {/* 详情列现在是 flex 宽（不再是 392 定宽），正文限宽 760 免得一行字拉得太长。分区小标题一律 SectionHeader。 */}
    <div className="flex-1 overflow-y-auto p-[7px_20px_24px]">
      <div className="max-w-[760px] flex flex-col gap-[10px]">
        <div>
          <SectionHeader>{t("inspiration.rawLabel")}</SectionHeader>
          <div className="text-[12.5px] leading-[1.75] whitespace-pre-wrap bg-card border border-border rounded-[10px] p-[11px_12px]"
            style={{ textWrap: "pretty" } as React.CSSProperties}>{item.raw}</div>
          {/* 附件缩略条（批次 013）：正文下面 8px，缩略 78 / 圆角 8 / 1px --border / --chip 底 / cover / gap 6 ——
              与聊天里带附件的文字气泡同一形态（tokens.launcherImage.chatForm）。只在详情画，卡片上不画。 */}
          {atts.length ? (
            <div className="flex flex-wrap gap-[6px] mt-[8px]">
              {atts.map((a) => (
                <button key={a.file_id} title={a.label} onClick={() => openImg(fileUrl(a.file_id))}
                  className="flex-none w-[78px] h-[78px] p-0 rounded-[8px] border border-border bg-chip overflow-hidden cursor-zoom-in">
                  <img src={fileUrl(a.file_id)} alt={a.label} className="w-full h-full object-cover block" />
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {item.summary ? (
          <div>
            <SectionHeader>
              <span className="inline-flex items-center gap-[6px]"><span className="text-orange-text flex"><IconBulb size={12} /></span>{t("inspiration.summaryLabel")}</span>
            </SectionHeader>
            <div className="bg-orange-soft rounded-[10px] p-[11px_12px]">
              <div className="text-[12.5px] leading-[1.7] text-orange-text" style={{ textWrap: "pretty" } as React.CSSProperties}>{item.summary}</div>
            </div>
          </div>
        ) : organizeStateOf(item) === "pending" ? (
          // 手动记完立刻点进来，这一节空着会让人以为没在整理，转头就自己去填标题了。
          <div>
            <SectionHeader>{t("inspiration.summaryLabel")}</SectionHeader>
            <div className="text-[12px] text-faint leading-[1.7]">{t("inspiration.organizingHint")}</div>
          </div>
        ) : null}

        <Research item={item} onChanged={onChanged} />

        <div>
          <SectionHeader>{t("inspiration.railTags")}</SectionHeader>
          <div className="flex flex-wrap gap-[5px]">
            {item.tags.map((g, k) => <span key={k} className={tagChip(false)}>{g}</span>)}
            <button onClick={onEdit}
              className="flex-none whitespace-nowrap flex items-center gap-[3px] px-[9px] py-[2px] rounded-full border border-dashed border-border bg-transparent text-faint text-[11px] cursor-pointer hover:border-orange hover:text-orange-text">
              <IconPlus size={10} />{t("inspiration.addTag")}
            </button>
          </div>
        </div>

        {item.task_id ? (
          <div>
            <SectionHeader>{t("inspiration.jobLabel")}</SectionHeader>
            <div className="flex items-center gap-[9px] bg-card border border-border rounded-[10px] p-[10px_12px] hover:border-orange">
              <span className="w-[22px] h-[22px] flex-none rounded-[6px] bg-success-soft text-success flex items-center justify-center"><IconCheck size={12} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] truncate">{task ? (task.name || task.goal) : item.task_id}</div>
                <div className="text-[10.5px] text-faint mt-[2px] whitespace-nowrap">
                  {task ? `${t(`tasks.status${task.status.charAt(0).toUpperCase()}${task.status.slice(1)}`, { defaultValue: task.status })} · ${legacy.fmtListTime(task.updated_at)}` : t("common.loading")}
                </div>
              </div>
              <button onClick={() => legacy.openTaskFrom(item.task_id!)}
                className="flex-none whitespace-nowrap p-0 border-none bg-transparent text-orange-text hover:text-orange-deep text-[11px] cursor-pointer">
                {t("inspiration.jobOpen")}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>

    {/* 详情列底部动作区。一页只准一颗橙实心，那颗是页头的「记灵感」——
        所以「让 Umbra 去做这件事」从橙实心改成描边钮，放在最右；两个状态切换钮在左。 */}
    <div className="flex-none flex items-center gap-[8px] px-[20px] py-[12px] border-t border-border bg-card">
      <button className={btn("ghost")} disabled={busy} onClick={() => setStatus(item.status === "done" ? "open" : "done")}>
        {item.status === "done" ? t("inspiration.markOpen") : t("inspiration.markDone")}
      </button>
      <button className={btn("ghost")} disabled={busy} onClick={() => setStatus(item.status === "archived" ? "open" : "archived")}>
        {item.status === "archived" ? t("inspiration.unarchive") : t("inspiration.archive")}
      </button>
      <span className="flex-1" />
      <button className={btnRow("ghost")} onClick={() => legacy.prefillTaskToChat(doItPrompt(item), item.title || item.raw.slice(0, 18))}>
        <IconArrowRight size={13} />{t("inspiration.sendToChat")}
      </button>
    </div>
    {/* 独立图片窗开不了时的回落形态（overlay，portal 到应用根，不受详情栏进场动画影响）。 */}
    <ImageViewer src={viewer} items={viewerItems} onClose={() => setViewer(null)} />
  </>);
}

// 详情栏的「秘书调研」一节。四态的边框卡先保留手写（不属于这批迁移），只把分区小标题换成骨架件。
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
      className="flex-none whitespace-nowrap px-[11px] py-[6px] border border-border bg-transparent text-text rounded-[8px] text-[12px] cursor-pointer hover:border-orange hover:text-orange-text disabled:bg-chip disabled:text-faint disabled:border-transparent disabled:cursor-not-allowed disabled:hover:bg-chip disabled:hover:text-faint disabled:hover:border-transparent">
      {busy ? t("inspiration.researchQueuing") : label}
    </button>
  );

  return (
    <div>
      <SectionHeader>{t("inspiration.researchLabel")}</SectionHeader>

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
    <Modal width={560} onClose={onClose}
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
