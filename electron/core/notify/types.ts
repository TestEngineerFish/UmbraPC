// 提醒模块的数据类型。**字段与服务端 /reminders 一一对应**，只是命名从
// 服务端的 snake_case 换成本地惯用的 camelCase（映射在 sync.ts 里做，只此一处）。
//
// 时刻一律 epoch 毫秒（`Ms` 后缀）。服务端刻意用毫秒整数而不是时间字符串，
// 因为两端都要拿它做日历运算，字符串来回解析会在时区上翻车。

// 重复规则。**必须与服务端白名单一致**：服务端会校验，传别的值直接 400。
export type RepeatRule = "none" | "daily" | "weekly" | "monthly" | "weekday" | "custom";

// 自定义重复的单位（repeatRule === "custom" 时才有意义）。
export type CustomFreq = "hour" | "day" | "week" | "month" | "year";

// 提醒来源：谁建的。只做记录，不影响行为。
export type ReminderSource = "manual" | "chat" | "task";

// 一条提醒。
export interface Reminder {
  id: string;              // 客户端生成的稳定 id（离线也能建，联网后 upsert）
  text: string;            // 正文
  note: string;            // 备注
  atMs: number;            // 下一次（或唯一一次）触发时刻
  repeatRule: RepeatRule;
  customFreq: CustomFreq;
  customN: number;         // 每 N 个单位
  repeatEndMs: number | null; // 结束重复的时刻；null = 永不
  aheadMinutes: number;    // 提前提醒分钟数，0 = 不提前
  done: boolean;
  source: ReminderSource;
  tz: string;              // 创建时的时区（如 Asia/Shanghai）
  updatedAtMs: number;     // 跨端合并靠它比大小
  dirty: boolean;          // 本地改过、还没成功推给服务端
}

// 一条删除墓碑。没有它，这台机器删掉的提醒会被别的设备一推又复活。
export interface ReminderTomb {
  id: string;
  deletedAtMs: number;
}

// 同步状态，给设置页/提醒页显示「上次同步 X 分钟前 / 失败原因」。
// 形状与 PhraseSyncState 一致，两处的 UI 可以长一样。
export interface NotifySyncState {
  syncing: boolean;
  lastAt: number;       // 上次成功同步的时间戳，0=从没成功过
  lastError: string;    // 上次失败原因，空串=没失败
  configured: boolean;  // 是否配好了服务器地址与 token
}

// 新建一条提醒时的默认值。放这里而不是散在调用点，免得两处默认不一致。
export function blankReminder(id: string, atMs: number): Reminder {
  return {
    id,
    text: "",
    note: "",
    atMs,
    repeatRule: "none",
    customFreq: "day",
    customN: 1,
    repeatEndMs: null,
    aheadMinutes: 0,
    done: false,
    source: "manual",
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    updatedAtMs: 0,
    dirty: true,
  };
}
