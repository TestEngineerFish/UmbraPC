// 统计页（对齐稿 490–750 的「有数据」态；加载/空/错误三态由 Money.tsx 统一管）。
// 批次 012 起套页面骨架的 **T4 仪表盘**：外层 Dashboard 滚动容器在 Money.tsx，这里只出卡片 ——
// 一张 CardGrid（支出 / 收入 / 结余三张数字卡）+ 分类占比 / 月度趋势 / Top 5 各一张 DashCard。
// 图表本身不动（charts.tsx 手绘 canvas，自适应容器），只换外壳；单卡取不到数走 DashCard 的
// empty，不整页空态。月份标签上移到页头副标题（「M 月 · N 笔」），这里不再画。
//
// 一期范围（实现方案 §4）：支出/收入/结余、环比、分类占比（环/表切换）、
// 月度趋势（近 6/12 月 + 柱/表切换）、大额支出 Top 5。
// 稿里的「待确认横幅」（四期）和「预算进度」（三期）这一版不画。
// 月份固定当月，不做切换 —— 拍板 D3：接口从第一天就吃 month，界面一期只做本月。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MoneyEntry, MoneyStats as Stats } from "../../services/server";
import { Segmented, btn, btnRow } from "../../components/ui";
import { CardGrid, DashCard } from "../../components/layout";
import { IconUp, IconDown, IconArrowRight } from "../../components/icons";
import { DonutChart, TrendBars, type DonutSeg } from "./charts";
import { catColor, catTint, yuan } from "./moneyKit";

/** 环形图只画金额前 5 的分类，其余合并为「其他分类」（稿明写的规则）。 */
const RING_TOP = 5;

export function MoneyStatsView({ stats, entries, catName, catSlot, catArt, onGoList }: {
  stats: Stats;
  /** 本月流水（Top 5 从这里现算 —— 统计接口不回明细，两处数据同一次拉取）。 */
  entries: MoneyEntry[];
  catName: (slug: string) => string;
  catSlot: (slug: string) => number;
  /** 图标 path（存储语义名优先、slug 兜底，批次 004）——查表在 Money.tsx。 */
  catArt: (slug: string) => string;
  /** 跳到流水页，可带分类筛选（点分类排行的某一行）。 */
  onGoList: (cat: string | null) => void;
}) {
  const { t } = useTranslation();
  const [catTable, setCatTable] = useState(false);
  const [trendTable, setTrendTable] = useState(false);
  const [range12, setRange12] = useState(false);

  // ── 环比。prev_expense 三态：null=上月没有记录（不画箭头）；0=记过但支出为 0
  // （百分比会除零，直接说「上月支出 0」）；正数=正常算百分比。
  const prev = stats.prev_expense;
  const up = prev !== null && prev > 0 && stats.expense > prev;
  const pct = prev !== null && prev > 0 ? Math.round(Math.abs(stats.expense - prev) / prev * 100) : 0;
  // 本月还没过完的话，环比后面补一句剩余天数 —— 「比上月少 40%」在月中是个假象，
  // 这句尾巴就是拆穿它用的（稿的 partial 预览态说的就是这件事）。
  const now = new Date();
  const isCurrentYm = stats.ym === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const daysLeft = isCurrentYm ? new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate() : 0;

  // ── 分类排行与环形图分段。
  const rows = stats.by_cat.map((r) => ({
    slug: r.cat, name: catName(r.cat), cents: r.cents, count: r.count,
    ratio: stats.expense ? (r.cents / stats.expense * 100).toFixed(1) + "%" : "0%",
    color: catColor(catSlot(r.cat)),
  }));
  const ringSegs: DonutSeg[] = rows.slice(0, RING_TOP).map((r) => ({ label: r.name, cents: r.cents, color: r.color }));
  const restCents = rows.slice(RING_TOP).reduce((n, r) => n + r.cents, 0);
  if (restCents) ringSegs.push({ label: t("money.restCats"), cents: restCents, color: "var(--c8)" });

  // ── 趋势。一次拉的就是 12 个月，近 6 月是它的切片 —— 不为切档位多打一次接口。
  const pts = (range12 ? stats.trend : stats.trend.slice(-6)).map((p, i, arr) => ({
    label: `${Number(p.ym.slice(5))}${t("money.monthUnit")}`, cents: p.cents, current: i === arr.length - 1,
  }));

  // ── 大额支出 Top 5：本月支出按金额降序（从流水现算，稿就是这么派生的）。
  const top5 = entries.filter((e) => e.direction === "expense")
    .slice().sort((a, b) => b.cents - a.cents).slice(0, 5);

  // 数字一律 tabular，三张卡并排时小数点才对得齐。
  const num = "leading-[1.15] tracking-[-.01em] [font-variant-numeric:tabular-nums]";

  return (<>
    {/* 三张数字卡：支出是主指标（30px + 环比 + 剩余天数），收入 / 结余小一档 */}
    <CardGrid>
      <DashCard title={t("money.statsExpense")}>
        <div className={`text-[30px] font-[650] ${num}`}>¥{yuan(stats.expense)}</div>
        <div className="flex items-center gap-[8px] flex-wrap">
          {prev === null ? (
            <span className="flex-none text-[12px] text-muted">{t("money.cmpNone")}</span>
          ) : prev === 0 ? (
            <span className="flex-none text-[12px] text-muted">{t("money.cmpZeroPrev")}</span>
          ) : (
            <span className={`flex items-center gap-[5px] text-[12px] whitespace-nowrap ${up ? "text-danger" : "text-success"}`}>
              {up ? <IconUp size={13} /> : <IconDown size={13} />}
              {t(up ? "money.cmpMore" : "money.cmpLess", { pct })}
            </span>
          )}
          {daysLeft > 0 ? (
            <span className="flex-none text-[11px] text-faint whitespace-nowrap">{t("money.daysLeft", { n: daysLeft })}</span>
          ) : null}
        </div>
      </DashCard>
      <DashCard title={t("money.statsIncome")}>
        <div className={`text-[22px] font-[650] text-success ${num}`}>¥{yuan(stats.income)}</div>
      </DashCard>
      <DashCard title={t("money.balance")}>
        <div className={`text-[22px] font-[650] ${num}`}>¥{yuan(stats.balance)}</div>
      </DashCard>
    </CardGrid>

    {/* 分类占比（环 / 表切换）。本月没有支出就没有分类可分 —— 卡内一行空态，切换钮一起收起 */}
    <DashCard title={t("money.catShare")} empty={!rows.length}
      aside={rows.length ? (
        <button className={btn("ghost", "sm")} onClick={() => setCatTable(!catTable)}>
          {catTable ? t("money.viewRing") : t("money.viewTable")}
        </button>
      ) : undefined}>
      {catTable ? (
        <div className="border border-border rounded-[10px] overflow-hidden">
          <div className="flex gap-[10px] px-[12px] py-[8px] bg-rail border-b border-border text-[11px] font-semibold tracking-[.06em] text-faint">
            <span className="flex-1 min-w-0">{t("money.thCat")}</span>
            <span className="w-[110px] flex-none text-right">{t("money.thAmount")}</span>
            <span className="w-[64px] flex-none text-right">{t("money.thRatio")}</span>
            <span className="w-[56px] flex-none text-right">{t("money.thCount")}</span>
          </div>
          {rows.map((r) => (
            <div key={r.slug} className="flex gap-[10px] px-[12px] py-[8px] border-b border-border-soft last:border-b-0 text-[12.5px]">
              <span className="flex-1 min-w-0 flex items-center gap-[7px]">
                <span className="w-[8px] h-[8px] flex-none rounded-full" style={{ background: r.color }} />
                {r.name}
              </span>
              <span className="w-[110px] flex-none text-right font-mono">¥{yuan(r.cents)}</span>
              <span className="w-[64px] flex-none text-right font-mono text-muted">{r.ratio}</span>
              <span className="w-[56px] flex-none text-right text-faint">{t("money.countUnit", { n: r.count })}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-[20px] items-start">
          <div className="relative w-[230px] h-[230px] flex-none">
            <DonutChart segs={ringSegs} />
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none gap-[2px]">
              <span className="text-[19px] font-[650] tracking-[-.01em]">¥{yuan(stats.expense)}</span>
              <span className="text-[11px] text-faint">{t("money.statsExpense")}</span>
            </div>
          </div>
          <div className="flex-[1_1_380px] min-w-[320px] flex flex-col">
            {rows.map((r) => (
              <div key={r.slug} onClick={() => onGoList(r.slug)}
                className="flex items-center gap-[10px] px-[8px] py-[7px] rounded-[8px] cursor-pointer hover:bg-hover">
                <span className="w-[8px] h-[8px] flex-none rounded-full" style={{ background: r.color }} />
                {/* 分类色块（批次 003）：排行的图标也进同色 tint 块，色点保留当图例锚。 */}
                <span className="w-[22px] h-[22px] flex-none rounded-[6px] flex items-center justify-center"
                  style={{ color: r.color, background: `color-mix(in srgb, ${r.color} var(--cat-tint), transparent)` }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={catArt(r.slug)} /></svg>
                </span>
                <span className="w-[52px] flex-none text-[12.5px] whitespace-nowrap">{r.name}</span>
                <span className="flex-1 min-w-[40px] h-[5px] rounded-full bg-track overflow-hidden">
                  <span className="block h-full rounded-full" style={{ width: r.ratio, background: r.color }} />
                </span>
                <span className="w-[96px] flex-none text-right text-[12.5px] font-mono whitespace-nowrap">¥{yuan(r.cents)}</span>
                <span className="w-[52px] flex-none text-right text-[11.5px] text-muted font-mono whitespace-nowrap">{r.ratio}</span>
              </div>
            ))}
            <div className="text-[10.5px] text-faint leading-[1.6] mt-[7px] px-[8px]">{t("money.ringNote")}</div>
          </div>
        </div>
      )}
    </DashCard>

    {/* 月度趋势：图表区高 220（T4 的档位），近 6 / 12 月切片 + 柱 / 表切换都在卡头右侧 */}
    <DashCard title={t("money.trend")} empty={!pts.length}
      aside={pts.length ? (<>
        <Segmented<"6" | "12"> value={range12 ? "12" : "6"} onChange={(v) => setRange12(v === "12")} options={[
          { v: "6", label: t("money.range6"), tone: "neutral" },
          { v: "12", label: t("money.range12"), tone: "neutral" },
        ]} />
        <button className={btn("ghost", "sm")} onClick={() => setTrendTable(!trendTable)}>
          {trendTable ? t("money.viewBars") : t("money.viewTable")}
        </button>
      </>) : undefined}>
      {trendTable ? (
        <div className="border border-border rounded-[10px] overflow-hidden">
          <div className="flex gap-[10px] px-[12px] py-[8px] bg-rail border-b border-border text-[11px] font-semibold tracking-[.06em] text-faint">
            <span className="flex-1 min-w-0">{t("money.thMonth")}</span>
            <span className="w-[120px] flex-none text-right">{t("money.thExpense")}</span>
          </div>
          {(range12 ? stats.trend : stats.trend.slice(-6)).map((p) => (
            <div key={p.ym} className="flex gap-[10px] px-[12px] py-[8px] border-b border-border-soft last:border-b-0 text-[12.5px]">
              <span className="flex-1 min-w-0">{p.ym}</span>
              <span className="w-[120px] flex-none text-right font-mono">¥{yuan(p.cents)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="h-[220px] relative">
          <TrendBars points={pts} />
        </div>
      )}
      <div className="text-[10.5px] text-faint leading-[1.6]">{t("money.trendNote")}</div>
    </DashCard>

    {/* 大额支出 Top 5。原来没数据整卡不出现，套骨架后改成卡内一行空态（单卡不整页空态） */}
    <DashCard title={t("money.top5")} empty={!top5.length}>
      <div className="flex flex-col">
        {top5.map((e) => (
          <div key={e.id} className="flex items-center gap-[10px] py-[7px] border-b border-border-soft last:border-b-0">
            <span className="w-[26px] h-[26px] flex-none rounded-[7px] flex items-center justify-center"
              style={{ color: catColor(catSlot(e.cat)), background: catTint(catSlot(e.cat)) }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={catArt(e.cat)} /></svg>
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] truncate">{e.merchant || catName(e.cat)}</div>
              <div className="text-[10.5px] text-faint truncate">
                {catName(e.cat)}{e.sub ? ` · ${e.sub}` : ""} · {new Date(e.at_ms).getMonth() + 1}/{new Date(e.at_ms).getDate()}
              </div>
            </div>
            <span className="flex-none text-[13px] font-semibold font-mono whitespace-nowrap">-¥{yuan(e.cents)}</span>
          </div>
        ))}
      </div>
    </DashCard>

    <button className={`${btnRow("ghost")} self-start`} onClick={() => onGoList(null)}>
      {t("money.allEntries")}
      <IconArrowRight size={13} />
    </button>
  </>);
}
