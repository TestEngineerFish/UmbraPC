// 提醒页用到的 preload 桥类型与可用性探测。
//
// ⚠️ 类型在这里**重复声明**，不要从 electron/core/notify/types 里 import ——
// 那会把主进程侧的 node:fs 之类拖进前端 bundle（bridges.ts 的注释里论证过同一件事）。
// 两边字段要手动保持一致，改一处记得改另一处。

export type RepeatRule = "none" | "daily" | "weekly" | "monthly" | "weekday" | "custom";
export type CustomFreq = "hour" | "day" | "week" | "month" | "year";

// 一条提醒。时刻一律 epoch 毫秒（`Ms` 后缀）。
export interface Reminder {
  id: string;
  text: string;
  note: string;
  atMs: number;
  repeatRule: RepeatRule;
  customFreq: CustomFreq;
  customN: number;
  repeatEndMs: number | null;
  aheadMinutes: number;
  done: boolean;
  source: "manual" | "chat" | "task";
  tz: string;
  updatedAtMs: number;
  dirty: boolean;
}

// 同步状态，页面上显示「上次同步 X 分钟前 / 失败原因」。
export interface NotifySyncState {
  syncing: boolean;
  lastAt: number;
  lastError: string;
  configured: boolean;
}

// 提醒主进程桥。
export interface NotifyAPI {
  list(): Promise<Reminder[]>;
  state(): Promise<NotifySyncState>;
  save(r: Reminder): Promise<{ ok: boolean; error?: string }>;
  remove(id: string): Promise<{ ok: boolean; error?: string }>;
  setDone(id: string, done: boolean): Promise<{ ok: boolean }>;
  snooze(id: string, minutes: number): Promise<{ ok: boolean }>;
  syncNow(): Promise<boolean>;
  onChanged(cb: () => void): () => void;
  onOpen(cb: (id: string) => void): () => void;
}

interface Win { umbraNotify?: NotifyAPI }
const w = window as unknown as Win;

// 只有桌面端（Electron）注入，Web 端不显示提醒页。
export const hasNotify = typeof w.umbraNotify !== "undefined";

// 取桥实例：只在 hasNotify 为 true 时调用。
export const notifyApi = (): NotifyAPI => w.umbraNotify as NotifyAPI;

// ── 展示用的小工具（纯前端，不进主进程）──────────────────────────────

// 重复规则的中文名。**中文只用于显示**，存储与传输一律用上面的英文枚举
// （服务端有白名单校验，中文会被 400 挡回来）。
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

// 提前提醒的档位，与 iOS 一致（两端选项不一样会让人以为丢数据）。
export const AHEAD_OPTIONS: { label: string; minutes: number }[] = [
  { label: "无", minutes: 0 },
  { label: "5 分钟", minutes: 5 },
  { label: "15 分钟", minutes: 15 },
  { label: "1 小时", minutes: 60 },
  { label: "1 天", minutes: 1440 },
];

/** 「今天 09:30」/「明天 09:30」/「7月31日 09:30」 —— 与 iOS 的 timeLabel 同一套说法。 */
export function timeLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const tomorrow = new Date(now.getTime() + 86400_000);
  const yesterday = new Date(now.getTime() - 86400_000);
  if (sameDay(d, now)) return `今天 ${hm}`;
  if (sameDay(d, tomorrow)) return `明天 ${hm}`;
  if (sameDay(d, yesterday)) return `昨天 ${hm}`;
  const y = d.getFullYear() === now.getFullYear() ? "" : `${d.getFullYear()}年`;
  return `${y}${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 列表分组。**过期排最前** —— 过期的提醒最需要被看见（与 iOS 同一口径）。 */
export function groupOf(r: Reminder): string {
  if (r.done) return "已完成";
  const now = Date.now();
  if (r.atMs < now) return "已过期";
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  if (r.atMs <= end.getTime()) return "今天";
  if (r.atMs <= end.getTime() + 86400_000) return "明天";
  if (r.atMs <= end.getTime() + 7 * 86400_000) return "本周";
  return "更远";
}

/** 分组的展示顺序。 */
export const GROUP_ORDER = ["已过期", "今天", "明天", "本周", "更远", "已完成"];

/** `<input type="datetime-local">` 需要本地时区的 `YYYY-MM-DDTHH:mm`，不能用 toISOString（那是 UTC）。 */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local 的值转回毫秒。空串返回 0，由调用方决定怎么兜。 */
export function fromLocalInput(v: string): number {
  if (!v) return 0;
  const ms = new Date(v).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}
