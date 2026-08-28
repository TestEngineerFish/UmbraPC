// 提醒页的纯函数层：分组、文案、日期换算、默认值与保存前校验。
//
// 单独抽出来（同 money/moneyKit.ts 的理由）：bridge.ts 顶部要摸 window，进不了 vitest；
// 而「结束重复默认给哪天」「什么算非法」这两件事恰恰最该有测试 —— 验收时抓到的
// 「结束日期 yyyy/mm/dd, --:-- 也能保存成功」就是没校验的后果。
//
// **不碰 window、不碰 IPC**，只吃入参。

import type { CustomFreq, Reminder, RepeatRule } from "./bridge";

// ── 常量 ────────────────────────────────────────────────────────────────

/** 一条提醒最多几张附件。与主进程 types.MAX_ATTS、服务端 reminders.MAX_ATTS 同一个数。 */
export const MAX_ATTS = 4;

/** 正文上限。系统通知横幅只显示前一两行，写成小作文没有意义；备注给 1000，放得下一段说明或一个地址。
 *  **上限做在客户端、服务端刻意不限**（2026-08-27 拍板，正本在
 *  doc/提醒同步与消息送达-设计草案.md §10.1）：服务端一限，还没跟上的端写了长文本，
 *  那条提醒每轮 PUT 都 400、永远同步失败。iOS 及后续端各自抄这两个数。 */
export const TEXT_MAX = 200;
export const NOTE_MAX = 1000;

/** 重复规则的中文名。**中文只用于显示**，存储与传输一律用英文枚举（服务端有白名单，中文会被 400 挡回来）。 */
export const RULE_LABELS: Record<RepeatRule, string> = {
  none: "不重复",
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  weekday: "工作日",
  custom: "自定义",
};

export const FREQ_LABELS: Record<CustomFreq, string> = {
  hour: "小时", day: "天", week: "周", month: "月", year: "年",
};

/** 提前提醒的档位，与 iOS 一致（两端选项不一样会让人以为丢数据）。 */
export const AHEAD_OPTIONS: { label: string; minutes: number }[] = [
  { label: "无", minutes: 0 },
  { label: "5 分钟", minutes: 5 },
  { label: "15 分钟", minutes: 15 },
  { label: "1 小时", minutes: 60 },
  { label: "1 天", minutes: 1440 },
];

/** 分组的展示顺序。 */
export const GROUP_ORDER = ["已过期", "今天", "明天", "本周", "更远", "已完成"];

// ── 日期小工具（全部本地时区）────────────────────────────────────────────

const p2 = (n: number) => String(n).padStart(2, "0");

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** 当天 00:00.000。 */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 当天 23:59:59.999。结束重复存的是这个值：scanner 判 `at > repeatEndMs`，含当天最后一秒。 */
export function endOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** `<input type="date">` 的取值 `YYYY-MM-DD`。不能用 toISOString（那是 UTC，晚上会跳到第二天）。 */
export function toDateInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** `<input type="time">` 的取值 `HH:mm`。 */
export function toTimeInput(ms: number): string {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/**
 * 把日期框 / 时间框的值合回一个时刻。任一边非法（空串、浏览器给的 "--:--"）返回 0，
 * 由调用方决定是保留旧值还是报错 —— 这里不猜。
 */
export function combineDateTime(date: string, time: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return 0;
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const dt = new Date(y, m - 1, d, hh, mm, 0, 0);
  const ms = dt.getTime();
  // new Date(2026, 1, 31) 会悄悄滚到 3 月 3 日；这种「合法格式、非法日期」也当非法。
  if (Number.isNaN(ms) || dt.getMonth() !== m - 1 || dt.getDate() !== d) return 0;
  return ms;
}

/** 日期框的值 → 当天 00:00 的时刻；非法返回 0。 */
export function fromDateInput(date: string): number {
  return combineDateTime(date, "00:00");
}

/** 「今天 09:30」/「明天 09:30」/「7月31日 09:30」 —— 与 iOS 的 timeLabel 同一套说法。 */
export function timeLabel(ms: number, nowMs = Date.now()): string {
  const d = new Date(ms);
  const now = new Date(nowMs);
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const tomorrow = new Date(nowMs + 86400_000);
  const yesterday = new Date(nowMs - 86400_000);
  if (sameDay(d, now)) return `今天 ${hm}`;
  if (sameDay(d, tomorrow)) return `明天 ${hm}`;
  if (sameDay(d, yesterday)) return `昨天 ${hm}`;
  const y = d.getFullYear() === now.getFullYear() ? "" : `${d.getFullYear()}年`;
  return `${y}${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 「8月30日」这种只带日期的说法，给「到 8月30日 为止」用。 */
export function dateLabel(ms: number, nowMs = Date.now()): string {
  const d = new Date(ms);
  const y = d.getFullYear() === new Date(nowMs).getFullYear() ? "" : `${d.getFullYear()}年`;
  return `${y}${d.getMonth() + 1}月${d.getDate()}日`;
}

// ── 分组与列表文案 ────────────────────────────────────────────────────────

/** 列表分组。**过期排最前** —— 过期的提醒最需要被看见（与 iOS 同一口径）。 */
export function groupOf(r: Reminder, nowMs = Date.now()): string {
  if (r.done) return "已完成";
  if (r.atMs < nowMs) return "已过期";
  const end = endOfDay(nowMs);
  if (r.atMs <= end) return "今天";
  if (r.atMs <= end + 86400_000) return "明天";
  if (r.atMs <= end + 7 * 86400_000) return "本周";
  return "更远";
}

/**
 * 「再等 10 分钟」只对**今天（含已过期）**的提醒有意义：明天的提醒推迟到「现在 + 10 分钟」
 * 等于把它提前到今天，验收时被抓到的就是这个。已完成的也不给 —— 它已经不会响了。
 */
export function canSnooze(r: Reminder, nowMs = Date.now()): boolean {
  return !r.done && r.atMs <= endOfDay(nowMs);
}

/** 列表上的重复标签：「每天」「工作日」「每 3 天」。不重复返回空串。 */
export function repeatLabel(r: Pick<Reminder, "repeatRule" | "customFreq" | "customN">): string {
  if (r.repeatRule === "none") return "";
  if (r.repeatRule !== "custom") return RULE_LABELS[r.repeatRule];
  const n = Math.max(1, Math.floor(r.customN || 1));
  // 「每 1 天」读起来像 bug，退化成「每天」；小时没有这种简写，保持「每 1 小时」。
  if (n === 1 && r.customFreq !== "hour") return `每${FREQ_LABELS[r.customFreq]}`;
  return `每 ${n} ${FREQ_LABELS[r.customFreq]}`;
}

// ── 结束重复：默认值与校验 ───────────────────────────────────────────────

/**
 * 勾选「到某天为止」时给的默认结束日 —— **跨端统一规则**（2026-08-27 拍板，正本与完整表
 * 在 doc/提醒同步与消息送达-设计草案.md §10.2，iOS 对照实现是 UmbraReminder.defaultRepeatEnd，
 * 改这里必须同改那边和那张表）：按重复类型往后铺一段「看起来像一个周期」的长度 ——
 * 每天/工作日 → 1 个月；每周 → 3 个月；每月 → 1 年；自定义按单位放大（小时 → 7 天、
 * 天 → 1 个月、周 → 3 个月、月 → 1 年、年 → 5 年）。
 * 起点取「提醒时刻」和「现在」里更晚的那个：编辑一条起点在过去的老提醒时，默认不该落在今天以前。
 * 返回当天 23:59:59.999。
 */
export function defaultRepeatEnd(
  rule: RepeatRule, freq: CustomFreq, n: number, atMs: number, nowMs = Date.now(),
): number {
  const base = new Date(Math.max(atMs, nowMs));
  const k = Math.max(1, Math.floor(n || 1));
  switch (rule) {
    case "weekly": base.setMonth(base.getMonth() + 3); break;
    case "monthly": base.setFullYear(base.getFullYear() + 1); break;
    case "custom":
      switch (freq) {
        case "hour": base.setDate(base.getDate() + 7); break;
        case "week": base.setMonth(base.getMonth() + 3 * Math.min(k, 4)); break;
        case "month": base.setFullYear(base.getFullYear() + Math.min(k, 3)); break;
        case "year": base.setFullYear(base.getFullYear() + 5 * Math.min(k, 2)); break;
        default: base.setMonth(base.getMonth() + Math.min(k, 6)); break;
      }
      break;
    default: base.setMonth(base.getMonth() + 1); break;   // daily / weekday
  }
  return endOfDay(base.getTime());
}

/** 只看「结束重复」这一项的错误，给弹窗那一行就地显示用。空串 = 合法（含「永不」）。 */
export function repeatEndError(r: Reminder, nowMs = Date.now()): string {
  if (r.repeatRule === "none" || r.repeatEndMs === null) return "";
  if (!Number.isFinite(r.repeatEndMs) || r.repeatEndMs <= 0) return "结束日期不完整";
  if (r.repeatEndMs < startOfDay(r.atMs)) return "结束日期不能早于提醒日期";
  if (r.repeatEndMs < startOfDay(nowMs)) return "结束日期已经过去了";
  return "";
}

/**
 * 保存前的最后一道闸。返回错误文案，空串 = 合法。
 * 界面上各控件已经各自挡了一遍，这里再查一次是因为「控件挡得住」和「状态里就没有脏值」
 * 是两回事 —— 浏览器把 date 框清空时 onChange 给的是空串，一路存到状态里就是 0 / NaN。
 */
export function validateReminder(r: Reminder, nowMs = Date.now()): string {
  const text = r.text.trim();
  if (!text) return "提醒内容不能为空";
  if (text.length > TEXT_MAX) return `提醒内容最多 ${TEXT_MAX} 字`;
  if ((r.note || "").length > NOTE_MAX) return `备注最多 ${NOTE_MAX} 字`;
  if (!Number.isFinite(r.atMs) || r.atMs <= 0) return "提醒时间不完整";
  if (r.repeatRule === "custom" && (!Number.isInteger(r.customN) || r.customN < 1)) return "自定义间隔至少是 1";
  const endErr = repeatEndError(r, nowMs);
  if (endErr) return endErr;
  if ((r.atts || []).length > MAX_ATTS) return `最多 ${MAX_ATTS} 张附件`;
  return "";
}

/**
 * 保存前把草稿规整成该有的形状：正文去首尾空白、不重复时清掉结束日期与自定义参数。
 * 不做这一步的话，「先选每天再改回不重复」会留下一个 repeatEndMs，列表上不显示但一直同步。
 */
export function normalizeReminder(r: Reminder): Reminder {
  const repeating = r.repeatRule !== "none";
  return {
    ...r,
    text: r.text.trim(),
    note: r.note || "",
    repeatEndMs: repeating ? r.repeatEndMs : null,
    customN: r.repeatRule === "custom" ? Math.max(1, Math.floor(r.customN || 1)) : 1,
    atts: (r.atts || []).slice(0, MAX_ATTS),
  };
}
