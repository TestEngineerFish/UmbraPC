// 记账页（一级导航「记账」）。批次 012 起套页面骨架：
//   页头：「记账 · M 月 · N 笔」+ 主按钮「记一笔」+ 次级「周期记账 · 在跑数」+ 齿轮（记账设置）；
//   第二行：最左「统计 / 流水」分段，流水态再接筛选件（月份 / 收支 / 分类 / 搜索 / 清空）；
//   统计态 = T4 仪表盘（Dashboard + CardGrid + DashCard，卡在 MoneyStats.tsx）；
//   流水态 = T2（ListModal full + 按天 Group + FooterTotal，在 MoneyList.tsx）；
//   记账设置（PageShell 的 settings）= T3：「分类与色槽」（原总设置那页整块搬来）+ 「周期记账」入口。
// 原来自绘的顶栏 / 骨架 / absolute 根容器全部退场，页面根就是 PageShell。
//
// 一期 = 统计 + 流水 + 记一笔 + 分类管理，分期依据见 doc/记账-实现方案.md §4：
// 这一期是后面三期（周期/预算/截图导入）的地基。
//
// 页面状态一共四种（对齐稿的预览态清单，去掉演示用的切换器）：
//   loading（Skeleton）→ error（连不上服务端 + 重试）/ empty（这个月还没记账）/ 有数据。
// 三个请求（分类 / 流水 / 统计）一把发出去，**任何一个挂了都算 error** ——
// 分类挂了流水页全是 slug 裸奔，统计挂了首页是空的，缺一块的页面比整页重试更糊弄人。
//
// 月份固定当月（拍板 D3：接口从第一天就吃 month，界面一期只做本月）。
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  deleteMoneyEntries, fetchMoneyCats, fetchMoneyEntries, fetchMoneyRecur, fetchMoneyStats,
  type MoneyCat, type MoneyEntry, type MoneyRecur, type MoneyStats,
} from "../../services/server";
import { askConfirm, showToast } from "../../components/overlay";
import { EmptyState, RowsCard, RowHint, Segmented, SettingRow, btn } from "../../components/ui";
import { Dashboard, PageShell, SettingsPage, SettingsSection, Skeleton } from "../../components/layout";
import { AddEntry } from "./AddEntry";
import { MoneyStatsView } from "./MoneyStats";
import { MoneyListFilters, MoneyListView, type MoneyDir } from "./MoneyList";
import { MoneyCats } from "./MoneyCats";
import { RecurModal } from "./RecurModal";
import { catIcon, ymOf, yuan } from "./moneyKit";

type Phase = "loading" | "error" | "ready";

export function Money() {
  const { t } = useTranslation();
  const [view, setView] = useState<"stats" | "list">("stats");
  const [phase, setPhase] = useState<Phase>("loading");
  const [ym, setYm] = useState(ymOf(new Date()));
  const [cats, setCats] = useState<MoneyCat[]>([]);
  const [entries, setEntries] = useState<MoneyEntry[]>([]);
  const [stats, setStats] = useState<MoneyStats | null>(null);
  /** 流水筛选三件套。第二行由页头渲染（不在列表组件树里），所以状态放这一层；
   *  统计页点某个分类要带着 filterCat 跳到流水。 */
  const [filterCat, setFilterCat] = useState<string | null>(null);
  const [dir, setDir] = useState<MoneyDir>("all");
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<MoneyEntry | null>(null);
  /** 周期规则（二期）。null = 弹窗没开；"" = 开在列表态；非空 = 直接落某条的编辑态。 */
  const [rules, setRules] = useState<MoneyRecur[]>([]);
  const [recurOpen, setRecurOpen] = useState<string | null>(null);
  // 页面还在不在：离开设置视图要静默重拉，但整页卸载时（切去别的功能）就不用再发请求了。
  // 挂载时也置一次 true —— StrictMode 会把 effect 拆挂再重挂，只在清理里置 false 会卡在 false。
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const reload = useCallback(async (silent = false) => {
    // 每次重拉时重算当月：页面在月底跨零点开着不关，第二天记的账要进新的月。
    const m = ymOf(new Date());
    setYm(m);
    if (!silent) setPhase("loading");
    // 趋势一次拉 12 个月，近 6 月在统计页里切片 —— 切档位不再打接口。
    const [c, e, s, r] = await Promise.all([
      fetchMoneyCats(), fetchMoneyEntries(m), fetchMoneyStats(m, 12), fetchMoneyRecur(),
    ]);
    if (!c || !e || !s) { setPhase("error"); return; }
    setCats(c);
    setEntries(e.items);
    setStats(s);
    // 周期规则不参与整页成败：拉挂了保持旧值，按钮上的计数顶多旧一拍。
    if (r) setRules(r);
    setPhase("ready");
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // slug → 显示名 / 色槽。分类接口默认不含停用的，但**历史流水可能指向停用分类**
  // （停用不影响历史数据），所以查不到时名字回退成 slug 本身、色槽回退中性灰，
  // 而不是让那行流水消失或崩掉。
  const catName = useCallback((slug: string) => cats.find((c) => c.slug === slug)?.name || slug, [cats]);
  const catSlot = useCallback((slug: string) => cats.find((c) => c.slug === slug)?.slot ?? 0, [cats]);
  // 图标 path：存储的语义名优先（用户新增分类挑的那个，批次 004），slug 兜底。
  // 流水行 / 排行 / Top5 只有 slug，这里替它们把 icon 查出来。
  const catArt = useCallback((slug: string) => catIcon(slug, cats.find((c) => c.slug === slug)?.icon), [cats]);

  const monthText = t("money.monthLabel", { y: ym.slice(0, 4), m: Number(ym.slice(5)) });
  const isEmpty = phase === "ready" && !entries.length && !!stats && stats.expense === 0 && stats.income === 0;
  // 在跑的周期规则数：进次级按钮的文案（「周期记账 · 3」），tooltip 给全量（共 N 条 · M 条在跑）。
  const live = rules.filter((r) => !r.paused && r.next_at_ms > 0).length;
  const clearFilter = () => { setFilterCat(null); setQuery(""); setDir("all"); };
  // 筛选件只在真正显示流水时才出现在第二行；加载 / 出错 / 空月只留「统计 / 流水」分段。
  const showList = phase === "ready" && !isEmpty && view === "list";
  // 副标题「M 月 · N 笔」；没就绪前只报月份，别先亮一个「0 笔」。
  const month = Number(ym.slice(5));
  const subtitle = phase === "ready" ? t("money.headSub", { m: month, n: entries.length }) : t("money.monthOnly", { m: month });

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

  return (
    <PageShell
      header={{
        title: t("nav.money"),
        subtitle,
        primary: { label: t("money.addOne"), onClick: () => setAddOpen(true) },
        // 周期记账（二期）：带在跑条数。status 槽空着 —— 现有代码没有独立的刷新态（静默重拉不换骨架）。
        secondary: [{
          label: live ? `${t("money.recTitle")} · ${live}` : t("money.recTitle"),
          title: t("money.recSub", { total: rules.length, live }),
          onClick: () => setRecurOpen(""),
        }],
        secondRow: (<>
          <Segmented<"stats" | "list"> value={view} onChange={setView} options={[
            { v: "stats", label: t("money.tabStats") },
            { v: "list", label: t("money.tabList") },
          ]} />
          {showList ? (
            <MoneyListFilters dir={dir} setDir={setDir} query={query} setQuery={setQuery}
              filterCat={filterCat} setFilterCat={setFilterCat}
              cats={cats.filter((c) => c.enabled).map((c) => [c.slug, c.name])}
              catName={catName} monthText={monthText} onClear={clearFilter} />
          ) : null}
        </>),
      }}
      settings={{
        title: t("money.settingsTitle"),
        backLabel: t("money.backLabel"),
        content: (
          <MoneySettings cats={cats} rules={rules}
            onChanged={() => void reload(true)}
            onLeave={() => { if (alive.current) void reload(true); }} />
        ),
      }}>
      {phase === "loading" ? (
        <Skeleton rows={4} />
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
        <Dashboard>
          <MoneyStatsView stats={stats} entries={entries} catName={catName} catSlot={catSlot} catArt={catArt}
            onGoList={(cat) => { setFilterCat(cat); setView("list"); }} />
        </Dashboard>
      ) : (
        <MoneyListView entries={entries} catName={catName} catSlot={catSlot} catArt={catArt}
          dir={dir} query={query} filterCat={filterCat} onClearFilter={clearFilter}
          onAdd={() => setAddOpen(true)} onEdit={(e) => setEditEntry(e)} onDelete={(e) => void doDelete(e)}
          onOpenRule={(ruleId) => {
            // 规则可能已删（删规则不删流水）—— 那就说人话，别装作能跳。
            if (rules.some((r) => r.id === ruleId)) setRecurOpen(ruleId);
            else showToast(t("money.recGone"), { tone: "warn" });
          }} />
      )}

      {addOpen || editEntry ? (
        <AddEntry cats={cats} entries={entries} initial={editEntry}
          onClose={() => { setAddOpen(false); setEditEntry(null); }}
          onSaved={() => { showToast(t("money.saved"), { tone: "ok" }); void reload(true); }} />
      ) : null}

      {recurOpen !== null ? (
        <RecurModal cats={cats} rules={rules} initialEditId={recurOpen || null}
          onClose={() => setRecurOpen(null)}
          onChanged={() => void reload(true)} />
      ) : null}
    </PageShell>
  );
}

// ── 记账设置（T3，PageShell 的 settings 视图）：分类与色槽 + 周期记账 ─────────
// 两组不到三组，不传 nav。「分类与色槽」就是原总设置那一页（MoneyCats）整块搬来；
// 「周期记账」的规则列表还长在 RecurModal 里（那个文件不在这批可改范围），这里先放
// 一颗「管理周期记账」打开原弹窗 —— 弹窗必须挂在这棵子树里：主视图在设置态是
// visibility:hidden，挂在那边的弹窗会跟着看不见。
function MoneySettings({ cats, rules, onChanged, onLeave }: {
  cats: MoneyCat[];
  rules: MoneyRecur[];
  /** 规则增删改停之后：规则和流水都可能变，父组件重拉。 */
  onChanged: () => void;
  /** 离开设置视图：分类改名 / 换色槽 / 换图标在 MoneyCats 里直接落服务端，而主视图
   *  常驻不卸载（PageShell 只是把它藏起来），不重拉的话流水与图表还是旧名旧色。 */
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  const [recurOpen, setRecurOpen] = useState(false);
  // 设置视图关掉 = 这个组件卸载，卸载即「离开」（只在卸载时跑一次，故意不挂依赖）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => onLeave(), []);
  const live = rules.filter((r) => !r.paused && r.next_at_ms > 0).length;

  return (
    <SettingsPage>
      <SettingsSection title={t("settings.secMoneycat")} desc={t("settings.secMoneycatDesc")}>
        <MoneyCats />
      </SettingsSection>

      <SettingsSection title={t("money.recTitle")} desc={t("money.recFoot")}>
        <RowsCard>
          <SettingRow label={t("money.recTitle")}>
            <RowHint>{t("money.recSub", { total: rules.length, live })}</RowHint>
            <button className={btn("ghost", "sm")} onClick={() => setRecurOpen(true)}>{t("money.recManage")}</button>
          </SettingRow>
        </RowsCard>
      </SettingsSection>

      {recurOpen ? (
        <RecurModal cats={cats} rules={rules} onClose={() => setRecurOpen(false)} onChanged={onChanged} />
      ) : null}
    </SettingsPage>
  );
}
