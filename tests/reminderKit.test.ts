// 提醒页纯函数层（src/features/notify/reminderKit.ts）。
//
// 盯的重点是验收时抓到的三件事：
// ① 「再等 10 分钟」只给今天（含过期）的提醒；
// ② 「结束重复」必须有默认值、且非法值（空框 / 早于起点 / 已过去）过不了校验 ——
//    原来 datetime-local 留着 "yyyy/mm/dd, --:--" 也能保存成功；
// ③ 日期框 / 时间框合回时刻时，任一边不完整要返回 0 而不是猜。
import { describe, expect, it } from "vitest";
import type { Reminder } from "../src/features/notify/bridge";
import {
  canSnooze, combineDateTime, defaultRepeatEnd, endOfDay, groupOf, normalizeReminder,
  repeatEndError, repeatLabel, startOfDay, toDateInput, toTimeInput, validateReminder,
  MAX_ATTS, NOTE_MAX, TEXT_MAX,
} from "../src/features/notify/reminderKit";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function r(patch: Partial<Reminder> = {}): Reminder {
  return {
    id: "r1", text: "吃药", note: "", atMs: noon() + HOUR,
    repeatRule: "none", customFreq: "day", customN: 1, repeatEndMs: null,
    aheadMinutes: 0, done: false, source: "manual", tz: "Asia/Shanghai",
    updatedAtMs: 0, dirty: true, atts: [], ...patch,
  };
}

// 今天正午当 now，免得测试在午夜前后跑出不同结果。
function noon(): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

describe("canSnooze · 只给今天的", () => {
  const now = noon();
  it("今天晚些时候的给", () => expect(canSnooze(r({ atMs: now + 3 * HOUR }), now)).toBe(true));
  it("已过期的给", () => expect(canSnooze(r({ atMs: now - 2 * DAY }), now)).toBe(true));
  it("明天的不给", () => expect(canSnooze(r({ atMs: now + DAY }), now)).toBe(false));
  it("今天最后一分钟还给、跨过午夜就不给", () => {
    expect(canSnooze(r({ atMs: endOfDay(now) }), now)).toBe(true);
    expect(canSnooze(r({ atMs: endOfDay(now) + 1 }), now)).toBe(false);
  });
  it("已完成的不给", () => expect(canSnooze(r({ atMs: now + HOUR, done: true }), now)).toBe(false));
});

describe("groupOf", () => {
  const now = noon();
  it("过期 / 今天 / 明天 / 本周 / 更远 / 已完成", () => {
    expect(groupOf(r({ atMs: now - 1 }), now)).toBe("已过期");
    expect(groupOf(r({ atMs: now + HOUR }), now)).toBe("今天");
    expect(groupOf(r({ atMs: now + DAY }), now)).toBe("明天");
    expect(groupOf(r({ atMs: now + 3 * DAY }), now)).toBe("本周");
    expect(groupOf(r({ atMs: now + 30 * DAY }), now)).toBe("更远");
    expect(groupOf(r({ atMs: now - DAY, done: true }), now)).toBe("已完成");
  });
});

describe("日期框 / 时间框换算", () => {
  it("toDateInput / toTimeInput 用本地时区", () => {
    const ms = new Date(2026, 7, 30, 9, 5).getTime();
    expect(toDateInput(ms)).toBe("2026-08-30");
    expect(toTimeInput(ms)).toBe("09:05");
  });
  it("合法的一对合回同一时刻", () => {
    expect(combineDateTime("2026-08-30", "09:05")).toBe(new Date(2026, 7, 30, 9, 5).getTime());
  });
  it("任一边不完整返回 0（浏览器清空框时给的就是空串）", () => {
    expect(combineDateTime("", "09:05")).toBe(0);
    expect(combineDateTime("2026-08-30", "")).toBe(0);
    expect(combineDateTime("2026-08-30", "--:--")).toBe(0);
  });
  it("格式合法但日期不存在也算非法（2 月 31 日）", () => {
    expect(combineDateTime("2026-02-31", "09:00")).toBe(0);
  });
});

describe("repeatLabel", () => {
  it("固定规则直接给中文名", () => {
    expect(repeatLabel(r({ repeatRule: "daily" }))).toBe("每天");
    expect(repeatLabel(r({ repeatRule: "weekday" }))).toBe("工作日");
    expect(repeatLabel(r({ repeatRule: "none" }))).toBe("");
  });
  it("自定义：每 1 天退化成「每天」，其余带数字", () => {
    expect(repeatLabel(r({ repeatRule: "custom", customFreq: "day", customN: 1 }))).toBe("每天");
    expect(repeatLabel(r({ repeatRule: "custom", customFreq: "day", customN: 3 }))).toBe("每 3 天");
    expect(repeatLabel(r({ repeatRule: "custom", customFreq: "hour", customN: 1 }))).toBe("每 1 小时");
  });
});

describe("defaultRepeatEnd · 按规则给默认", () => {
  const now = noon();
  it("每天 → 一个月后当天 23:59:59.999", () => {
    const end = defaultRepeatEnd("daily", "day", 1, now + HOUR, now);
    const exp = new Date(now + HOUR); exp.setMonth(exp.getMonth() + 1);
    expect(end).toBe(endOfDay(exp.getTime()));
    expect(new Date(end).getHours()).toBe(23);
    expect(new Date(end).getMinutes()).toBe(59);
  });
  it("每周 → 三个月；每月 → 一年", () => {
    const w = new Date(defaultRepeatEnd("weekly", "day", 1, now + HOUR, now));
    const m = new Date(defaultRepeatEnd("monthly", "day", 1, now + HOUR, now));
    const base = new Date(now + HOUR);
    const expW = new Date(base); expW.setMonth(expW.getMonth() + 3);
    const expM = new Date(base); expM.setFullYear(expM.getFullYear() + 1);
    expect(startOfDay(w.getTime())).toBe(startOfDay(expW.getTime()));
    expect(startOfDay(m.getTime())).toBe(startOfDay(expM.getTime()));
  });
  it("起点在过去时从「现在」起算，默认不会落在今天以前", () => {
    const end = defaultRepeatEnd("daily", "day", 1, now - 400 * DAY, now);
    expect(end).toBeGreaterThan(now);
  });
  it("自定义按单位放大", () => {
    const hour = defaultRepeatEnd("custom", "hour", 2, now + HOUR, now);
    expect(startOfDay(hour)).toBe(startOfDay(now + HOUR + 7 * DAY));
  });
});

describe("repeatEndError / validateReminder · 结束重复的闸门", () => {
  const now = noon();
  it("永不 → 合法", () => {
    expect(repeatEndError(r({ repeatRule: "daily", repeatEndMs: null }), now)).toBe("");
  });
  it("空框 / NaN → 不完整（原来 --:-- 也能保存，就是漏了这条）", () => {
    expect(repeatEndError(r({ repeatRule: "daily", repeatEndMs: 0 }), now)).toMatch(/不完整/);
    expect(repeatEndError(r({ repeatRule: "daily", repeatEndMs: Number.NaN }), now)).toMatch(/不完整/);
    expect(validateReminder(r({ repeatRule: "daily", repeatEndMs: 0 }), now)).toMatch(/不完整/);
  });
  it("早于提醒日期 / 已经过去 → 报错", () => {
    expect(repeatEndError(r({ repeatRule: "daily", atMs: now + 5 * DAY, repeatEndMs: endOfDay(now + DAY) }), now))
      .toMatch(/早于提醒日期/);
    expect(repeatEndError(r({ repeatRule: "daily", atMs: now - 5 * DAY, repeatEndMs: endOfDay(now - 2 * DAY) }), now))
      .toMatch(/已经过去/);
  });
  it("结束在提醒当天（含当天）→ 合法", () => {
    expect(repeatEndError(r({ repeatRule: "daily", atMs: now + HOUR, repeatEndMs: endOfDay(now) }), now)).toBe("");
  });
  it("不重复时结束日期随便是什么都不管", () => {
    expect(validateReminder(r({ repeatRule: "none", repeatEndMs: 0 }), now)).toBe("");
  });
});

describe("validateReminder · 其它字段", () => {
  const now = noon();
  it("空正文 / 超长正文 / 超长备注", () => {
    expect(validateReminder(r({ text: "   " }), now)).toMatch(/不能为空/);
    expect(validateReminder(r({ text: "x".repeat(TEXT_MAX + 1) }), now)).toMatch(/最多/);
    expect(validateReminder(r({ note: "x".repeat(NOTE_MAX + 1) }), now)).toMatch(/备注最多/);
    expect(validateReminder(r({ text: "x".repeat(TEXT_MAX) }), now)).toBe("");
  });
  it("时间不完整 / 自定义间隔 / 附件超限", () => {
    expect(validateReminder(r({ atMs: 0 }), now)).toMatch(/时间不完整/);
    expect(validateReminder(r({ repeatRule: "custom", customN: 0 }), now)).toMatch(/至少是 1/);
    const atts = Array.from({ length: MAX_ATTS + 1 }, (_, i) => ({ fileId: `f${i}`, label: "" }));
    expect(validateReminder(r({ atts }), now)).toMatch(/附件/);
  });
});

describe("normalizeReminder", () => {
  it("改回不重复时清掉结束日期与自定义参数", () => {
    const out = normalizeReminder(r({ text: " 吃药 ", repeatRule: "none", repeatEndMs: 123, customN: 5 }));
    expect(out.text).toBe("吃药");
    expect(out.repeatEndMs).toBeNull();
    expect(out.customN).toBe(1);
  });
  it("重复时保留结束日期", () => {
    const out = normalizeReminder(r({ repeatRule: "weekly", repeatEndMs: 123 }));
    expect(out.repeatEndMs).toBe(123);
  });
});
