// 日志页（React + Tailwind）。桌面态展示设备引擎真实日志。
//
// 稿 1978-1997。相对原来的整行灰字平铺，这里做了三件事：
//   1. 顶栏加四颗来源筛选胶囊（全部 / 任务 / 连接 / 能力执行）——
//      日志本来就是「出事了才来看」的地方，进来第一件事就是把无关的滤掉。
//   2. 每行拆成三列：时间（muted）/ 标签（62px 定宽、加粗、按性质上色）/ 正文。
//      定宽是关键，正文左边缘对齐了才扫得动；标签跟着正文流走的话每行起点都不一样。
//   3. 空态走 EmptyState —— 而且要分清「一条都没有」和「筛掉了」，
//      后者给一颗「看全部」，不然用户会以为日志坏了。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as desktop from "../../services/desktop";
import type { LogSrc, LogTag } from "../../services/deviceTransport";
import { filterChip, filterChipCount, EmptyState } from "../../components/ui";

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
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between px-[22px] py-[14px] border-b border-border shrink-0 gap-3">
        <div className="flex items-center gap-[14px] min-w-0">
          <h1 className="m-0 text-[16px] font-semibold flex-none">{t("logs.title")}</h1>
          <div className="flex gap-[6px] flex-wrap">
            {FILTERS.map((f) => (
              <button key={f.key} className={filterChip(filter === f.key, "sm")} onClick={() => setFilter(f.key)}>
                <span>{t(f.i18n)}</span>
                <span className={filterChipCount(filter === f.key)}>{countOf(f.key)}</span>
              </button>
            ))}
          </div>
        </div>
        <button onClick={() => desktop.openLogsFolder()} className="flex items-center gap-1.5 px-3 py-1.5 border border-border bg-card text-text rounded-lg text-[12.5px] cursor-pointer flex-none whitespace-nowrap hover:border-orange hover:text-orange-text transition-colors duration-[130ms]">{t("logs.openFolder")}</button>
      </div>
      <div className="flex-1 overflow-y-auto px-[22px] py-[14px] font-mono text-[12px] leading-[1.95] min-h-0 flex flex-col">
        {lines.length ? (
          lines.map((l, i) => (
            <div key={i} className="flex gap-[11px]">
              <span className="text-muted flex-none">{l.time}</span>
              <span className={`flex-none w-[62px] font-semibold ${TAG_COLOR[l.tag]}`}>{l.tag}</span>
              <span className="text-text break-all min-w-0">{l.msg}</span>
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
    </div>
  );
}
