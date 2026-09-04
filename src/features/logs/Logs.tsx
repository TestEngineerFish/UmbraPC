// 日志页（React + Tailwind）。桌面态展示设备引擎真实日志。
// 批次 012 起套页面骨架：页头「日志 · N 条 · 实时」+ 次级钮「打开日志文件夹」，
// 四颗来源筛选芯片上移到页头第二行；日志流照旧；底栏那句「只留 200 条」走 FooterTotal。
//
// 稿 1978-1997。相对原来的整行灰字平铺，这里做了三件事：
//   1. 页头第二行四颗来源筛选芯片（全部 / 任务 / 连接 / 能力执行）——
//      日志本来就是「出事了才来看」的地方，进来第一件事就是把无关的滤掉。
//   2. 每行拆成三列：时间（muted）/ 标签（62px 定宽、加粗、按性质上色）/ 正文。
//      定宽是关键，正文左边缘对齐了才扫得动；标签跟着正文流走的话每行起点都不一样。
//   3. 空态走 EmptyState —— 而且要分清「一条都没有」和「筛掉了」，
//      后者给一颗「看全部」，不然用户会以为日志坏了。
//   4. 行首前缀（✓ / └）单独占第三列，底栏说明内存只留 200 条。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as desktop from "../../services/desktop";
import type { LogMark, LogSrc, LogTag } from "../../services/deviceTransport";
import { filterChip, filterChipCount, EmptyState } from "../../components/ui";
import { PageShell, FooterTotal } from "../../components/layout";

// 行首前缀（稿 6059-6067、9716-9719）。这是全系统唯一允许用字符代替 SVG 图标的地方——
// 日志是引擎原样打出来的文本，行首字符属于**内容**而不是图标，复制出去要能和终端对上。
// ✓ 用成功绿；└ 用 --faint，并且把它那行的正文也降到 --muted ——
// 续行是上一行的附属信息（结果 / 参数 / 原始返回），和主事件同样重会让人分不清主次。
const MARK_CHAR: Record<LogMark, string> = { ok: "✓", cont: "└" };
const MARK_COLOR: Record<LogMark, string> = { ok: "text-success", cont: "text-faint" };

// 标签配色（稿 5033-5041）。info 是 --muted 而不是某种彩色 —— 它是「说明性的补充行」，
// 上色会跟真正需要注意的行抢视线。
const TAG_COLOR: Record<LogTag, string> = {
  conn: "text-success",
  job: "text-orange-text",
  cap: "text-success",
  warn: "text-warning",
  info: "text-muted",
  error: "text-danger",
};

// 内存缓冲上限，和 deviceTransport 里 logs.slice(0, 200) 是同一个数。
// 写成常量是为了底栏那句说明和真实行为对得上——两处各写一个数字，早晚会对不上。
const LOG_CAP = 200;

type Filter = "all" | LogSrc;
const FILTERS: { key: Filter; i18n: string }[] = [
  { key: "all", i18n: "logs.filterAll" },
  { key: "jobs", i18n: "logs.filterJobs" },
  { key: "conn", i18n: "logs.filterConn" },
  { key: "cap", i18n: "logs.filterCap" },
];

export function Logs() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("all");
  const all = desktop.getDeviceLogs();
  const lines = filter === "all" ? all : all.filter((l) => l.src === filter);
  // 每颗胶囊上带条数：不点进去就知道「连接那组有 3 条」，省一次点击。
  const countOf = (f: Filter) => (f === "all" ? all.length : all.filter((l) => l.src === f).length);
  return (
    <PageShell header={{
      title: t("logs.title"),
      // 「N 条 · 实时」：条数是内存缓冲里的总数（不随筛选变），「实时」说明这一页不用手动刷新。
      subtitle: t("logs.countLive", { n: all.length }),
      secondary: [{ label: t("logs.openFolder"), onClick: () => desktop.openLogsFolder() }],
      secondRow: FILTERS.map((f) => (
        <button key={f.key} className={filterChip(filter === f.key, "sm")} onClick={() => setFilter(f.key)}>
          <span>{t(f.i18n)}</span>
          <span className={filterChipCount(filter === f.key)}>{countOf(f.key)}</span>
        </button>
      )),
    }}>
      <div className="flex-1 overflow-y-auto px-[22px] py-[14px] font-mono text-[12px] leading-[1.95] min-h-0 flex flex-col">
        {lines.length ? (
          lines.map((l, i) => (
            <div key={i} className="flex gap-[11px]">
              <span className="text-muted flex-none">{l.time}</span>
              <span className={`flex-none w-[62px] font-semibold ${TAG_COLOR[l.tag]}`}>{l.tag}</span>
              {/* 前缀单独占一列（12px 居中），不挤正文——挤进正文的话每行起点就不齐了，扫不动 */}
              {l.mark ? <span className={`flex-none w-[12px] text-center ${MARK_COLOR[l.mark]}`}>{MARK_CHAR[l.mark]}</span> : null}
              <span className={`break-all min-w-0 ${l.mark === "cont" ? "text-muted" : "text-text"}`}>{l.msg}</span>
            </div>
          ))
        ) : (
          // 「这一组是空的」和「一条日志都没有」给的动作不一样：前者能一键看全部，
          // 后者清筛选毫无意义（跟 Tasks 页同一条规矩）。
          <EmptyState
            title={all.length ? t("logs.noneInFilter") : t("logs.empty")}
            body={all.length ? undefined : t("logs.emptyBody")}
            actionLabel={all.length ? t("logs.showAll") : undefined}
            onAction={all.length ? () => setFilter("all") : undefined}
          />
        )}
      </div>
      {/* 底栏（稿 2435-2438），骨架件的 FooterTotal（40 高 / --rail 底）。这句「只留 200 条」很要紧：
          不写的话，用户翻到底发现日志断在某个时间点，会以为是日志坏了或者丢了——其实是内存缓冲的
          容量到头了。真正的完整记录在日志文件夹里，所以这句话和页头那颗「打开日志文件夹」是一对。 */}
      {all.length ? (
        <FooterTotal>
          <span className="flex-1 min-w-0 truncate">{t("logs.capNote", { cap: LOG_CAP })}</span>
          <span className="flex-none font-mono">{t("logs.capCount", { n: lines.length, cap: LOG_CAP })}</span>
        </FooterTotal>
      ) : null}
    </PageShell>
  );
}
