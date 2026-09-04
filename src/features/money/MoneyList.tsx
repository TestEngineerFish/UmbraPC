// 流水页（对齐稿 753–862）。批次 012 起套页面骨架的 **T2 列表 + 弹窗**（表格类满铺）：
//   筛选栏整体上移到页头第二行 —— 这里导出 MoneyListFilters，由 Money.tsx 组进 secondRow
//   （分段「统计 / 流水」之后）；筛选状态（方向 / 搜索 / 分类）跟着提到 Money.tsx。
//   列表本体 = ListModal full + 按天分组的 Group + 卡内 GroupRow；底栏合计 = FooterTotal
//   （放在 ListModal 之外、内容区最后）；编辑 / 删除只在右键菜单，弹窗照旧在 Money.tsx。
//
// 筛选在客户端做：一个月的流水一次全量拉回（见 server.ts fetchMoneyEntries 的注释），
// 方向/分类/搜索都是本地过滤，敲一个字立刻变。
// 底部合计按**筛选结果**算 —— 数据全在手上，合计和服务端按同样口径算出来是同一个数。
//
// 月份固定当月（拍板 D3），第二行的月份只是个标签不是选择器，二期放开时再换控件。
//
// focusId（批次 013 裁定 3）：别处（聊天里失效的识图确认卡）跳过来时可以点名一笔流水，
// 这里负责滚过去 + 闪 1.2s；那笔不在当月或被筛掉就静默略过 —— 见下面 useEffect 的注释。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MoneyEntry } from "../../services/server";
import { ContextMenu, EmptyState, Segmented, btn, btnRow, chip } from "../../components/ui";
import { FooterTotal, Group, GroupRow, HeaderSearch, ListModal, useFlashId } from "../../components/layout";
import { IconChevronDown, IconPencil, IconTrash } from "../../components/icons";
import { catColor, catTint, groupByDay, SRC_ICON, yuan } from "./moneyKit";

/** 收支方向筛选：全部 / 只看支出 / 只看收入。 */
export type MoneyDir = "all" | "expense" | "income";

interface Ctx { x: number; y: number; entry: MoneyEntry }

/** 页头第二行的筛选件：月份标签 / 收支分段 / 分类下拉 / 搜索 / 清空筛选。
 *  状态全在 Money.tsx（第二行由 PageShell 的页头渲染，不在列表组件树里）。 */
export function MoneyListFilters({ dir, setDir, query, setQuery, filterCat, setFilterCat, cats, catName, monthText, onClear }: {
  dir: MoneyDir;
  setDir: (d: MoneyDir) => void;
  query: string;
  setQuery: (q: string) => void;
  filterCat: string | null;
  setFilterCat: (slug: string | null) => void;
  /** 可选分类（含收入侧），给筛选菜单用：[slug, 显示名]。 */
  cats: [string, string][];
  catName: (slug: string) => string;
  monthText: string;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [catMenu, setCatMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 分类筛选菜单：点外面收起。
  useEffect(() => {
    if (!catMenu) return;
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setCatMenu(false); };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [catMenu]);

  const hasFilter = !!(filterCat || query.trim() || dir !== "all");

  return (<>
    {/* 一期只做本月（D3）：这是标签不是选择器，所以是只读胶囊，没有 hover 转橙、没有下拉箭头 */}
    <span className={chip()}>{monthText}</span>
    <Segmented<MoneyDir> value={dir} onChange={setDir} options={[
      { v: "all", label: t("money.dirAll") },
      { v: "expense", label: t("money.expense") },
      { v: "income", label: t("money.income") },
    ]} />
    <div className="relative flex-none" ref={menuRef}>
      <button className={btnRow("ghost", "sm")} onClick={() => setCatMenu(!catMenu)}>
        {filterCat ? catName(filterCat) : t("money.allCats")}
        <IconChevronDown size={12} />
      </button>
      {catMenu ? (
        <div className="absolute left-0 top-[calc(100%+4px)] z-30 w-[150px] max-h-[260px] overflow-y-auto bg-card border border-border rounded-[9px] shadow-[shadow:var(--shadow-floating)] p-[4px]">
          {[[null, t("money.allCats")] as [string | null, string], ...cats].map(([slug, name]) => (
            <button key={slug ?? "__all"} onClick={() => { setFilterCat(slug); setCatMenu(false); }}
              className={`flex items-center w-full px-[9px] py-[5px] rounded-[6px] text-[12px] cursor-pointer text-left whitespace-nowrap ${
                filterCat === slug ? "bg-orange-soft text-orange-text" : "bg-transparent text-text hover:bg-chip"}`}>
              {name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
    {/* 搜索框收窄到 200：这一行前面已经排了两组分段 + 月份 + 分类，240 在最窄窗口（主区 724）会挤出去 */}
    <HeaderSearch value={query} onChange={setQuery} placeholder={t("money.searchPh")} width={200} />
    {hasFilter ? (
      <button className={btn("ghost", "sm")} onClick={onClear}>{t("money.clearFilter")}</button>
    ) : null}
  </>);
}

export function MoneyListView({ entries, catName, catSlot, catArt, dir, query, filterCat, focusId, onClearFilter, onAdd, onEdit, onDelete, onOpenRule }: {
  entries: MoneyEntry[];
  catName: (slug: string) => string;
  catSlot: (slug: string) => number;
  /** 图标 path（存储语义名优先、slug 兜底，批次 004）——查表在 Money.tsx。 */
  catArt: (slug: string) => string;
  /** 三个筛选条件都在 Money.tsx：第二行在页头里；统计页点某个分类要带着 filterCat 跳过来。 */
  dir: MoneyDir;
  query: string;
  filterCat: string | null;
  /** 从别处跳来要定位的那一笔（Money.gotoMoneyList）：滚过去 + 闪 1.2s。命中不了就什么都不做。 */
  focusId?: string | null;
  onClearFilter: () => void;
  onAdd: () => void;
  onEdit: (e: MoneyEntry) => void;
  onDelete: (e: MoneyEntry) => void;
  /** 「周期」徽章点回规则（稿 8378：生成的流水挂徽章能跳回规则）。 */
  onOpenRule: (ruleId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [flashId, flash] = useFlashId();
  // 行的 DOM（照 Phrases 的 rowRefs 同一套回调 ref）：只给「滚到那一行」用。
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  // 定位一笔流水（批次 013 裁定 3：聊天里失效卡的两个出口）：滚到那一行 + 闪 1.2s。
  // **命中不了就什么都不做，不报错也不吐司** —— 记账页只加载当月（拍板 D3），那笔可能在别的月里，
  // 也可能被当前筛选滤掉了；用户本来就是被送到流水页来自己翻的，弹一句「找不到」只是打断他。
  // 依赖只有 focusId：换筛选、静默重拉都不会重跑，不会反复闪。Money 那边一切视图就把它清掉。
  useEffect(() => {
    if (!focusId) return;
    const el = rowRefs.current.get(focusId);
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    flash(focusId);
  }, [focusId, flash]);

  const q = query.trim();
  const list = entries.filter((e) => {
    if (dir !== "all" && e.direction !== dir) return false;
    if (filterCat && e.cat !== filterCat) return false;
    // 搜的是备注 / 分类名 / 二级 —— 跟服务端 keyword 的口径一致再多盖一个分类名。
    if (q && !(e.merchant + catName(e.cat) + e.sub).includes(q)) return false;
    return true;
  });
  const groups = groupByDay(list);
  const spendTotal = list.filter((e) => e.direction === "expense").reduce((n, e) => n + e.cents, 0);
  const earnTotal = list.filter((e) => e.direction === "income").reduce((n, e) => n + e.cents, 0);

  const dayLabel = (d: Date) =>
    `${t("time.monthDay", { month: d.getMonth() + 1, day: d.getDate() })} ${d.toLocaleDateString(i18n.language, { weekday: "short" })}`;

  if (!entries.length) {
    // 整月一条都没有：通用空态直接铺内容区（flex-1 自己居中），没有筛选可清、也不画底栏。
    return (
      <EmptyState compact icon="M4 7h16v13H4zM4 7l2-3h12l2 3M9 12h6"
        title={t("money.listEmptyTitle")} body={t("money.listEmptyBody")}
        actionLabel={t("money.addOne")} onAction={onAdd} />
    );
  }

  return (<>
    {!groups.length ? (
      <EmptyState compact icon="M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4.3-4.3"
        title={q ? t("money.searchEmpty", { q }) : t("money.filterEmpty")}
        body={t("money.filterEmptyBody")}
        actionLabel={t("money.clearFilter")} onAction={onClearFilter} />
    ) : (
      // 表格类满铺（full）：分组 = 一天，分组头是日期 + 当天合计，卡内逐行。
      <ListModal full>
        {groups.map((g) => (
          // 当天合计走 action 而不是 count：T2 组头的 count 是「N 条」那种紧挨标题的计数，
          // 合计在稿里一直是靠右的一段等宽数字（批次 013 回执裁定 2 之后两者位置分开了）。
          <Group key={g.day} title={dayLabel(g.date)}
            action={<span className="flex-none text-[11px] text-muted font-mono [font-variant-numeric:tabular-nums] whitespace-nowrap">{
              [g.spend ? t("money.daySpend", { v: yuan(g.spend) }) : "", g.earn ? t("money.dayEarn", { v: yuan(g.earn) }) : ""]
                .filter(Boolean).join(" · ")}</span>}>
            {g.items.map((e) => (
              <GroupRow key={e.id} flash={flashId === e.id}
                rowRef={(el) => { if (el) rowRefs.current.set(e.id, el); else rowRefs.current.delete(e.id); }}
                onContextMenu={(ev) => { ev.preventDefault(); setCtx({ x: ev.clientX, y: ev.clientY, entry: e }); }}>
                {/* 分类色块（批次 003）：图标底是同色 tint 圆角块，描边取色槽色。 */}
                <span className="w-[28px] h-[28px] flex-none rounded-[8px] flex items-center justify-center"
                  style={{ color: catColor(catSlot(e.cat)), background: catTint(catSlot(e.cat)) }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={catArt(e.cat)} /></svg>
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-[7px]">
                    <span className="text-[12.5px] truncate">{e.merchant || catName(e.cat)}</span>
                    {e.src === "recur" ? (
                      // 稿 8378：周期生成的流水挂徽章，**点徽章跳回规则**（二期落地）。
                      <button
                        className="flex items-center gap-[3px] flex-none whitespace-nowrap px-[6px] py-[1px] rounded-full text-[10.5px] bg-orange-soft text-orange-text cursor-pointer border-none"
                        title={t("money.recBadgeTip")}
                        onClick={(ev) => { ev.stopPropagation(); onOpenRule(e.rule_id); }}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={SRC_ICON[e.src] || SRC_ICON.manual} /></svg>
                        {t(`money.src_${e.src}`)}
                      </button>
                    ) : e.src !== "manual" ? (
                      <span className="flex items-center gap-[3px] flex-none whitespace-nowrap px-[6px] py-[1px] rounded-full text-[10.5px] bg-chip text-faint">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={SRC_ICON[e.src] || SRC_ICON.manual} /></svg>
                        {t(`money.src_${e.src}`)}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[10.5px] text-faint mt-[2px] truncate">
                    {catName(e.cat)}{e.sub ? ` · ${e.sub}` : ""}
                  </div>
                </div>
                <span className={`flex-none w-[112px] text-right text-[13px] font-semibold font-mono whitespace-nowrap ${
                  e.direction === "income" ? "text-success" : "text-text"}`}>
                  {e.direction === "income" ? "+" : "-"}¥{yuan(e.cents)}
                </span>
              </GroupRow>
            ))}
          </Group>
        ))}
      </ListModal>
    )}

    {/* 底栏合计（T4/T2 共用件）：左合计、右操作提示 */}
    <FooterTotal>
      <span className="flex-1 min-w-0 truncate">
        {t("money.footTotals", { n: list.length, spend: yuan(spendTotal), earn: yuan(earnTotal) })}
      </span>
      <span className="flex-none text-[10.5px] text-faint">{t("money.footHint")}</span>
    </FooterTotal>

    {ctx ? (
      <ContextMenu x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} items={[
        { group: ctx.entry.merchant || catName(ctx.entry.cat) },
        { label: t("common.edit"), icon: <IconPencil size={13} />, onClick: () => onEdit(ctx.entry) },
        { divider: true },
        // 破坏性操作单独一组放最后（设计稿硬规则）。删除 = 移入回收站，确认弹窗在 Money.tsx。
        { label: t("common.delete"), tone: "danger", icon: <IconTrash size={13} />, onClick: () => onDelete(ctx.entry) },
      ]} />
    ) : null}
  </>);
}
