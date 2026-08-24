// 流水页（对齐稿 753–862）。筛选在客户端做：一个月的流水一次全量拉回（见 server.ts
// fetchMoneyEntries 的注释），方向/分类/搜索都是本地过滤，敲一个字立刻变。
// 底部合计按**筛选结果**算 —— 数据全在手上，合计和服务端按同样口径算出来是同一个数。
//
// 月份固定当月（拍板 D3），顶栏的月份只是个标签不是选择器，二期放开时再换控件。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MoneyEntry } from "../../services/server";
import { ContextMenu, EmptyState } from "../../components/ui";
import { IconChevronDown, IconPencil, IconSearch, IconTrash } from "../../components/icons";
import { catColor, catIcon, groupByDay, SRC_ICON, yuan } from "./moneyKit";

interface Ctx { x: number; y: number; entry: MoneyEntry }

export function MoneyListView({ entries, cats, catName, catSlot, filterCat, setFilterCat, monthText, onAdd, onEdit, onDelete }: {
  entries: MoneyEntry[];
  /** 可选分类（含收入侧），给筛选菜单用：[slug, 显示名]。 */
  cats: [string, string][];
  catName: (slug: string) => string;
  catSlot: (slug: string) => number;
  /** 分类筛选提到 Money.tsx：统计页点某个分类要带着它跳过来。 */
  filterCat: string | null;
  setFilterCat: (slug: string | null) => void;
  monthText: string;
  onAdd: () => void;
  onEdit: (e: MoneyEntry) => void;
  onDelete: (e: MoneyEntry) => void;
}) {
  const { t, i18n } = useTranslation();
  const [dir, setDir] = useState<"all" | "expense" | "income">("all");
  const [query, setQuery] = useState("");
  const [catMenu, setCatMenu] = useState(false);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 分类筛选菜单：点外面收起。
  useEffect(() => {
    if (!catMenu) return;
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setCatMenu(false); };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [catMenu]);

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
  const hasFilter = !!(filterCat || q || dir !== "all");
  const clearFilter = () => { setFilterCat(null); setQuery(""); setDir("all"); };

  const dayLabel = (d: Date) =>
    `${t("time.monthDay", { month: d.getMonth() + 1, day: d.getDate() })} ${d.toLocaleDateString(i18n.language, { weekday: "short" })}`;

  const segBtn = (on: boolean, last?: boolean) =>
    `flex-none whitespace-nowrap px-[11px] py-[4px] text-[12px] cursor-pointer ${last ? "" : "border-r border-border"} ${
      on ? "bg-orange text-white font-semibold" : "bg-transparent text-text"}`;

  if (!entries.length) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <EmptyState compact icon="M4 7h16v13H4zM4 7l2-3h12l2 3M9 12h6"
          title={t("money.listEmptyTitle")} body={t("money.listEmptyBody")}
          actionLabel={t("money.addOne")} onAction={onAdd} />
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 筛选条 */}
      <div className="flex-none flex items-center gap-[9px] px-[18px] py-[11px] border-b border-border bg-rail flex-wrap">
        {/* 一期只做本月（D3）：这是标签不是选择器，所以没有 hover 转橙、没有下拉箭头 */}
        <span className="flex-none whitespace-nowrap px-[11px] py-[4px] border border-border bg-card rounded-[8px] text-[12px] text-muted">
          {monthText}
        </span>
        <div className="flex-none flex border border-border rounded-[8px] overflow-hidden bg-card">
          <button className={segBtn(dir === "all")} onClick={() => setDir("all")}>{t("money.dirAll")}</button>
          <button className={segBtn(dir === "expense")} onClick={() => setDir("expense")}>{t("money.expense")}</button>
          <button className={segBtn(dir === "income", true)} onClick={() => setDir("income")}>{t("money.income")}</button>
        </div>
        <div className="relative flex-none" ref={menuRef}>
          <button onClick={() => setCatMenu(!catMenu)}
            className="flex items-center gap-[6px] px-[11px] py-[4px] border border-border bg-card rounded-[8px] text-[12px] text-text cursor-pointer whitespace-nowrap hover:border-orange">
            {filterCat ? catName(filterCat) : t("money.allCats")}
            <IconChevronDown size={12} />
          </button>
          {catMenu ? (
            <div className="absolute left-0 top-[calc(100%+4px)] z-30 w-[150px] max-h-[260px] overflow-y-auto bg-card border border-border rounded-[9px] shadow-[var(--shadow-floating)] p-[4px]">
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
        <div className="flex-1 min-w-[180px] flex items-center gap-[7px] bg-card border border-border rounded-[8px] px-[9px] py-[4px]">
          <span className="flex-none flex text-faint"><IconSearch size={12} /></span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("money.searchPh")}
            className="flex-1 min-w-0 border-none bg-transparent text-text text-[12px] outline-none" />
        </div>
        {hasFilter ? (
          <button onClick={clearFilter}
            className="flex-none whitespace-nowrap px-[11px] py-[4px] border border-border bg-transparent rounded-[8px] text-[12px] text-muted cursor-pointer hover:border-orange hover:text-orange-text">
            {t("money.clearFilter")}
          </button>
        ) : null}
      </div>

      {/* 列表主体 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-[18px] pt-[12px] pb-[20px]">
        {!groups.length ? (
          <EmptyState compact icon="M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4.3-4.3"
            title={q ? t("money.searchEmpty", { q }) : t("money.filterEmpty")}
            body={t("money.filterEmptyBody")}
            actionLabel={t("money.clearFilter")} onAction={clearFilter} />
        ) : groups.map((g) => (
          <div key={g.day} className="mb-[14px]">
            <div className="flex items-center gap-[9px] px-[2px] pb-[7px]">
              <span className="flex-none text-[12px] font-semibold whitespace-nowrap">{dayLabel(g.date)}</span>
              <span className="flex-1 h-px bg-border-soft" />
              <span className="flex-none text-[11px] text-muted whitespace-nowrap font-mono">
                {[g.spend ? t("money.daySpend", { v: yuan(g.spend) }) : "", g.earn ? t("money.dayEarn", { v: yuan(g.earn) }) : ""]
                  .filter(Boolean).join(" · ")}
              </span>
            </div>
            <div className="bg-card border border-border rounded-[11px] overflow-hidden">
              {g.items.map((e) => (
                <div key={e.id}
                  onContextMenu={(ev) => { ev.preventDefault(); setCtx({ x: ev.clientX, y: ev.clientY, entry: e }); }}
                  className="flex items-center gap-[11px] px-[13px] py-[9px] border-b border-border-soft last:border-b-0 hover:bg-hover">
                  <span className="w-[28px] h-[28px] flex-none rounded-[8px] bg-chip flex items-center justify-center"
                    style={{ color: catColor(catSlot(e.cat)) }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={catIcon(e.cat)} /></svg>
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-[7px]">
                      <span className="text-[12.5px] truncate">{e.merchant || catName(e.cat)}</span>
                      {e.src !== "manual" ? (
                        // 周期来源的徽章在稿里能点回规则 —— 那是二期的事，一期只亮个身份。
                        <span className={`flex items-center gap-[3px] flex-none whitespace-nowrap px-[6px] py-[1px] rounded-full text-[10.5px] ${
                          e.src === "recur" ? "bg-orange-soft text-orange-text" : "bg-chip text-faint"}`}>
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
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* 底栏合计 */}
      <div className="flex-none flex items-center gap-[10px] px-[18px] py-[9px] border-t border-border bg-rail">
        <span className="flex-1 min-w-0 text-[11.5px] text-muted font-mono truncate whitespace-nowrap">
          {t("money.footTotals", { n: list.length, spend: yuan(spendTotal), earn: yuan(earnTotal) })}
        </span>
        <span className="flex-none text-[10.5px] text-faint whitespace-nowrap">{t("money.footHint")}</span>
      </div>

      {ctx ? (
        <ContextMenu x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} items={[
          { group: ctx.entry.merchant || catName(ctx.entry.cat) },
          { label: t("common.edit"), icon: <IconPencil size={13} />, onClick: () => onEdit(ctx.entry) },
          { divider: true },
          // 破坏性操作单独一组放最后（设计稿硬规则）。删除 = 移入回收站，确认弹窗在 Money.tsx。
          { label: t("common.delete"), tone: "danger", icon: <IconTrash size={13} />, onClick: () => onDelete(ctx.entry) },
        ]} />
      ) : null}
    </div>
  );
}
