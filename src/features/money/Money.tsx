// 记账页（一级导航「记账」）。一期 = 统计 + 流水 + 记一笔 + 设置里的分类管理，
// 分期依据见 doc/记账-实现方案.md §4：这一期是后面三期（周期/预算/截图导入）的地基。
//
// 页面状态一共四种（对齐稿的预览态清单，去掉演示用的切换器）：
//   loading（骨架）→ error（连不上服务端 + 重试）/ empty（这个月还没记账）/ 有数据。
// 三个请求（分类 / 流水 / 统计）一把发出去，**任何一个挂了都算 error** ——
// 分类挂了流水页全是 slug 裸奔，统计挂了首页是空的，缺一块的页面比整页重试更糊弄人。
//
// 月份固定当月（拍板 D3：接口从第一天就吃 month，界面一期只做本月）。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  deleteMoneyEntries, fetchMoneyCats, fetchMoneyEntries, fetchMoneyStats,
  type MoneyCat, type MoneyEntry, type MoneyStats,
} from "../../services/server";
import { askConfirm, showToast } from "../../components/overlay";
import { EmptyState, btn } from "../../components/ui";
import { IconPlus } from "../../components/icons";
import { AddEntry } from "./AddEntry";
import { MoneyStatsView } from "./MoneyStats";
import { MoneyListView } from "./MoneyList";
import { ymOf, yuan } from "./money";

type Phase = "loading" | "error" | "ready";

export function Money() {
  const { t } = useTranslation();
  const [view, setView] = useState<"stats" | "list">("stats");
  const [phase, setPhase] = useState<Phase>("loading");
  const [ym, setYm] = useState(ymOf(new Date()));
  const [cats, setCats] = useState<MoneyCat[]>([]);
  const [entries, setEntries] = useState<MoneyEntry[]>([]);
  const [stats, setStats] = useState<MoneyStats | null>(null);
  const [filterCat, setFilterCat] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<MoneyEntry | null>(null);

  const reload = useCallback(async (silent = false) => {
    // 每次重拉时重算当月：页面在月底跨零点开着不关，第二天记的账要进新的月。
    const m = ymOf(new Date());
    setYm(m);
    if (!silent) setPhase("loading");
    // 趋势一次拉 12 个月，近 6 月在统计页里切片 —— 切档位不再打接口。
    const [c, e, s] = await Promise.all([
      fetchMoneyCats(), fetchMoneyEntries(m), fetchMoneyStats(m, 12),
    ]);
    if (!c || !e || !s) { setPhase("error"); return; }
    setCats(c);
    setEntries(e.items);
    setStats(s);
    setPhase("ready");
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // slug → 显示名 / 色槽。分类接口默认不含停用的，但**历史流水可能指向停用分类**
  // （停用不影响历史数据），所以查不到时名字回退成 slug 本身、色槽回退中性灰，
  // 而不是让那行流水消失或崩掉。
  const catName = useCallback((slug: string) => cats.find((c) => c.slug === slug)?.name || slug, [cats]);
  const catSlot = useCallback((slug: string) => cats.find((c) => c.slug === slug)?.slot ?? 0, [cats]);

  const monthText = t("money.monthLabel", { y: ym.slice(0, 4), m: Number(ym.slice(5)) });
  const isEmpty = phase === "ready" && !entries.length && !!stats && stats.expense === 0 && stats.income === 0;

  const doDelete = async (e: MoneyEntry) => {
    const name = e.merchant || catName(e.cat);
    const ok = await askConfirm({
      title: t("money.deleteTitle", { name: `${name} · ¥${yuan(e.cents)}` }),
      // 与其它类别的删除文案对齐：「移入回收站，保留 30 天」+ 跨端后果说在前面。
      message: t("money.deleteBody"),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    const n = await deleteMoneyEntries([e.id]);
    showToast(n ? t("money.deleted") : t("money.deleteFailed"), { tone: n ? "ok" : "warn" });
    if (n) void reload(true);
  };

  const tabBtn = (on: boolean, last?: boolean) =>
    `flex items-center gap-[6px] flex-none whitespace-nowrap px-[13px] py-[5px] text-[12.5px] cursor-pointer ${
      last ? "" : "border-r border-border"} ${on ? "bg-orange text-white font-semibold" : "bg-transparent text-text"}`;

  return (
    <div className="absolute inset-0 flex flex-col min-h-0 text-[13px] bg-bg">
      {/* 顶栏：视图切换 + 记一笔。稿里还有「周期记账」按钮（二期）和预览态切换（演示用），一期都不画。 */}
      <div className="flex-none flex items-center gap-[12px] px-[18px] py-[11px] border-b border-border bg-card">
        <div className="flex-none flex border border-border rounded-[8px] overflow-hidden">
          <button className={tabBtn(view === "stats")} onClick={() => setView("stats")}>{t("money.tabStats")}</button>
          <button className={tabBtn(view === "list", true)} onClick={() => setView("list")}>{t("money.tabList")}</button>
        </div>
        <span className="flex-1" />
        <button className={btn("primary")} onClick={() => setAddOpen(true)}>
          <span className="flex items-center gap-[6px]"><IconPlus size={13} />{t("money.addOne")}</span>
        </button>
      </div>

      {phase === "loading" ? (
        // 骨架（稿 692–716 的简化版）：形状对上就行，别做成第二套布局。
        <div className="flex-1 min-h-0 overflow-y-auto px-[18px] py-[16px]">
          <div className="flex flex-col gap-[14px] max-w-[1000px]">
            <div className="flex gap-[14px] flex-wrap">
              <div className="flex-[1_1_340px] min-w-[300px] h-[118px] bg-card border border-border rounded-[12px]" />
              <div className="flex-[1_1_220px] min-w-[200px] h-[118px] bg-card border border-border rounded-[12px]" />
            </div>
            <div className="h-[274px] bg-card border border-border rounded-[12px] px-[17px] flex gap-[20px] items-center">
              <span className="w-[200px] h-[200px] flex-none rounded-full bg-track" />
              <div className="flex-1 flex flex-col gap-[12px]">
                <span className="h-[12px] rounded-[6px] bg-track" />
                <span className="h-[12px] w-[82%] rounded-[6px] bg-track" />
                <span className="h-[12px] w-[64%] rounded-[6px] bg-track" />
                <span className="h-[12px] w-[48%] rounded-[6px] bg-track" />
              </div>
            </div>
          </div>
        </div>
      ) : phase === "error" ? (
        <EmptyState kind="offline" title={t("money.errTitle")} body={t("money.errBody")}
          actionLabel={t("common.retry")} onAction={() => void reload()} />
      ) : isEmpty ? (
        // 空态动作只给「记一笔」。稿里第二个动作是「从截图导入」—— 那是四期的入口，
        // 现在放上去点了没反应，比不放更糟。
        <EmptyState icon="M3 6h18v14H3zM3 10h18M8 15h3"
          title={t("money.emptyTitle")} body={t("money.emptyBody")}
          actionLabel={t("money.addOne")} onAction={() => setAddOpen(true)} />
      ) : view === "stats" && stats ? (
        <div className="flex-1 min-h-0 overflow-y-auto px-[18px] pt-[16px] pb-[26px]">
          {/* 一期只看本月（D3）：标签不是选择器 */}
          <div className="flex items-center gap-[10px] mb-[14px]">
            <span className="flex-none px-[12px] py-[4px] border border-border bg-card rounded-[8px] text-[13px] font-semibold whitespace-nowrap">{monthText}</span>
          </div>
          <MoneyStatsView stats={stats} entries={entries} catName={catName} catSlot={catSlot}
            onGoList={(cat) => { setFilterCat(cat); setView("list"); }} />
        </div>
      ) : (
        <MoneyListView entries={entries} catName={catName} catSlot={catSlot}
          cats={cats.filter((c) => c.enabled).map((c) => [c.slug, c.name])}
          filterCat={filterCat} setFilterCat={setFilterCat} monthText={monthText}
          onAdd={() => setAddOpen(true)} onEdit={(e) => setEditEntry(e)} onDelete={(e) => void doDelete(e)} />
      )}

      {addOpen || editEntry ? (
        <AddEntry cats={cats} entries={entries} initial={editEntry}
          onClose={() => { setAddOpen(false); setEditEntry(null); }}
          onSaved={() => { showToast(t("money.saved"), { tone: "ok" }); void reload(true); }} />
      ) : null}
    </div>
  );
}
