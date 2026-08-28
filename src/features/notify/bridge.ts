// 提醒页用到的 preload 桥类型与可用性探测。
//
// ⚠️ 类型在这里**重复声明**，不要从 electron/core/notify/types 里 import ——
// 那会把主进程侧的 node:fs 之类拖进前端 bundle（bridges.ts 的注释里论证过同一件事）。
// 两边字段要手动保持一致，改一处记得改另一处。

export type RepeatRule = "none" | "daily" | "weekly" | "monthly" | "weekday" | "custom";
export type CustomFreq = "hour" | "day" | "week" | "month" | "year";

// 一张附件的引用（文件本体在服务端 /files/{fileId}）。跟着整条提醒同步，不单独走。
export interface ReminderAtt {
  fileId: string;
  label: string;
}

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
  atts: ReminderAtt[];
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

// 展示用的小工具（分组 / 文案 / 日期换算 / 校验）都在 reminderKit.ts —— 纯函数，进得了 vitest。
