// 提醒扫描与合并的行为测试。
//
// 守住四条最容易写错、又最难在真机上复现的规则：
//   1. 错过分级（≤15 分钟正常弹 / 当天内合并 / 过了今天不弹）；
//   2. 幂等键用**计划时刻**，同一次触发扫多少遍都只弹一次；
//   3. 重复提醒**只补最近一次** —— 出差三天回来不该被二十一条淹没；
//   4. 合并时「本地未推送且更新」要赢，否则断网期间的修改会被服务端旧值抹掉。
import { describe, expect, it } from "vitest";

import {
  FRESH_WINDOW_MS, advance, firedKey, mergeRemote, pendingCount, plan, pruneFired, stepOnce,
} from "../electron/core/notify/scanner";
import type { Reminder, ReminderTomb } from "../electron/core/notify/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// 造一条提醒。默认「一小时后、不重复、没推送过」。
function r(patch: Partial<Reminder> = {}): Reminder {
  return {
    id: "r1", text: "吃药", note: "", atMs: Date.now() + HOUR,
    repeatRule: "none", customFreq: "day", customN: 1, repeatEndMs: null,
    aheadMinutes: 0, done: false, source: "manual", tz: "Asia/Shanghai",
    updatedAtMs: Date.now(), dirty: false, ...patch,
  };
}

// 今天正午。用固定的「当天某时刻」当 now，免得测试在午夜前后跑出不同结果。
function noon(): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

describe("plan · 到点判定与错过分级", () => {
  it("还没到点的不弹", () => {
    const now = noon();
    const p = plan([r({ atMs: now + 5 * MIN })], now, {});
    expect(p.due).toHaveLength(0);
    expect(p.keys).toHaveLength(0);
  });

  it("刚过点的正常弹一条", () => {
    const now = noon();
    const p = plan([r({ atMs: now - MIN })], now, {});
    expect(p.due).toHaveLength(1);
    expect(p.missed).toHaveLength(0);
  });

  it("错过 15 分钟内仍算正常弹（边界）", () => {
    const now = noon();
    expect(plan([r({ atMs: now - FRESH_WINDOW_MS })], now, {}).due).toHaveLength(1);
    expect(plan([r({ atMs: now - FRESH_WINDOW_MS - 1000 })], now, {}).due).toHaveLength(0);
  });

  it("错过 15 分钟以上但还是今天的 → 进 missed（合并成一条摘要）", () => {
    const now = noon();
    const p = plan([r({ atMs: now - 3 * HOUR })], now, {});
    expect(p.missed).toHaveLength(1);
    expect(p.due).toHaveLength(0);
  });

  it("错过超过今天的 → 只标逾期，不弹", () => {
    const now = noon();
    const p = plan([r({ atMs: now - 2 * DAY })], now, {});
    expect(p.stale).toHaveLength(1);
    expect(p.due).toHaveLength(0);
    expect(p.missed).toHaveLength(0);
  });

  it("已完成的一律不弹", () => {
    const now = noon();
    expect(plan([r({ atMs: now - MIN, done: true })], now, {}).keys).toHaveLength(0);
  });

  it("提前提醒是独立的一条，键带 :ahead", () => {
    const now = noon();
    // 主体还没到点，提前那条已经到了。
    const p = plan([r({ atMs: now + 10 * MIN, aheadMinutes: 15 })], now, {});
    expect(p.due).toHaveLength(1);
    expect(p.due[0].ahead).toBe(true);
    expect(p.due[0].key.endsWith(":ahead")).toBe(true);
  });

  it("三档都要记进 fired，否则 stale 每轮都会被重新算一遍", () => {
    const now = noon();
    const p = plan(
      [r({ id: "a", atMs: now - MIN }), r({ id: "b", atMs: now - 3 * HOUR }), r({ id: "c", atMs: now - 2 * DAY })],
      now, {},
    );
    expect(p.keys).toHaveLength(3);
  });
});

describe("firedKey · 幂等", () => {
  it("键用计划时刻而不是当前时刻，所以扫多少遍都一样", () => {
    const at = noon() - MIN;
    expect(firedKey("r1", at, false)).toBe(`r1:${at}`);
    expect(firedKey("r1", at, true)).toBe(`r1:${at}:ahead`);
  });

  it("已经弹过的不再弹", () => {
    const now = noon();
    const item = r({ atMs: now - MIN });
    const fired = { [firedKey(item.id, item.atMs, false)]: now - 30_000 };
    expect(plan([item], now, fired).due).toHaveLength(0);
  });

  it("snooze 改了 atMs 就是一次新触发，不会被旧键挡住", () => {
    const now = noon();
    const old = r({ atMs: now - HOUR });
    const fired = { [firedKey(old.id, old.atMs, false)]: now - HOUR };
    const snoozed = { ...old, atMs: now - MIN };   // 推后又到点了
    expect(plan([snoozed], now, fired).due).toHaveLength(1);
  });

  it("pruneFired 清掉 7 天前的记录", () => {
    const now = noon();
    const kept = pruneFired({ old: now - 8 * DAY, fresh: now - HOUR }, now);
    expect(kept.old).toBeUndefined();
    expect(kept.fresh).toBeDefined();
  });
});

describe("advance · 重复推进", () => {
  it("不重复的不动", () => {
    expect(advance(r({ atMs: noon() - HOUR }), noon())).toBeNull();
  });

  it("还没到点的不动", () => {
    expect(advance(r({ atMs: noon() + HOUR, repeatRule: "daily" }), noon())).toBeNull();
  });

  it("每天：过点后推到下一个未来时刻", () => {
    const now = noon();
    const adv = advance(r({ atMs: now - HOUR, repeatRule: "daily" }), now);
    expect(adv).not.toBeNull();
    expect(adv?.done).toBe(false);
    expect(adv?.atMs).toBeGreaterThan(now);
  });

  it("重复提醒只补最近一次：落后三天也只推进到下一个未来点，不会产生三条", () => {
    const now = noon();
    const adv = advance(r({ atMs: now - 3 * DAY - HOUR, repeatRule: "daily" }), now);
    expect(adv).not.toBeNull();
    expect(adv?.atMs).toBeGreaterThan(now);
    // 且只跨过必要的天数：下一个点不应该超过一整天以后。
    expect(adv!.atMs - now).toBeLessThanOrEqual(DAY);
  });

  it("越过结束日期 → 整条标完成", () => {
    const now = noon();
    const adv = advance(r({ atMs: now - HOUR, repeatRule: "daily", repeatEndMs: now - 10 * MIN }), now);
    expect(adv?.done).toBe(true);
  });

  it("工作日跳过周末", () => {
    // 周五正午往后一步应该落在周一。
    const fri = new Date();
    fri.setHours(12, 0, 0, 0);
    fri.setDate(fri.getDate() + ((5 - fri.getDay() + 7) % 7));
    const next = stepOnce(fri.getTime(), "weekday", "day", 1);
    expect(next).not.toBeNull();
    expect(new Date(next as number).getDay()).toBe(1);
  });

  it("custom 的 n 被写成 0 也不会死循环", () => {
    const now = noon();
    const adv = advance(r({ atMs: now - HOUR, repeatRule: "custom", customFreq: "day", customN: 0 }), now);
    expect(adv).not.toBeNull();     // 兜底成每 1 天
    expect(adv?.atMs).toBeGreaterThan(now);
  });

  it("snooze 与 repeat 并存：推后之后仍按原规则继续重复", () => {
    const now = noon();
    const snoozed = r({ atMs: now + 10 * MIN, repeatRule: "daily" });
    expect(advance(snoozed, now)).toBeNull();                 // 还没到点，不动
    const later = advance({ ...snoozed, atMs: now - MIN }, now);
    expect(later?.atMs).toBeGreaterThan(now);                 // 到点后照常推进
  });
});

describe("mergeRemote · 跨端合并", () => {
  const base = r({ id: "x", updatedAtMs: 1000, dirty: false });

  it("服务端更新的覆盖本地", () => {
    const out = mergeRemote([base], [{ ...base, text: "新的", updatedAtMs: 2000 }], []);
    expect(out[0].text).toBe("新的");
  });

  it("本地未推送且更新时本地赢（断网期间的修改不能被抹掉）", () => {
    const mine = { ...base, text: "我改的", updatedAtMs: 3000, dirty: true };
    const out = mergeRemote([mine], [{ ...base, text: "服务端的", updatedAtMs: 2000 }], []);
    expect(out[0].text).toBe("我改的");
  });

  it("本地虽新但已推送（dirty=false）→ 以服务端为准", () => {
    const mine = { ...base, text: "本地", updatedAtMs: 3000, dirty: false };
    const out = mergeRemote([mine], [{ ...base, text: "服务端", updatedAtMs: 2000 }], []);
    expect(out[0].text).toBe("服务端");
  });

  it("服务端墓碑删掉本地条目", () => {
    const tombs: ReminderTomb[] = [{ id: "x", deletedAtMs: 2000 }];
    expect(mergeRemote([base], [], tombs)).toHaveLength(0);
  });

  it("删除之后本地又改过（更晚）→ 删除作废，条目留下", () => {
    const mine = { ...base, text: "又改了", updatedAtMs: 3000, dirty: true };
    const tombs: ReminderTomb[] = [{ id: "x", deletedAtMs: 2000 }];
    expect(mergeRemote([mine], [], tombs)).toHaveLength(1);
  });

  it("结果按触发时刻升序", () => {
    const a = r({ id: "a", atMs: 5000 });
    const b = r({ id: "b", atMs: 1000 });
    expect(mergeRemote([], [a, b], []).map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("pendingCount · 角标口径", () => {
  it("只数「未完成且今天之内到点」的，与 iOS 底栏角标同一口径", () => {
    const now = noon();
    const items = [
      r({ id: "过期", atMs: now - DAY }),
      r({ id: "今天", atMs: now + HOUR }),
      r({ id: "明天", atMs: now + DAY }),
      r({ id: "完成了", atMs: now - HOUR, done: true }),
    ];
    expect(pendingCount(items, now)).toBe(2);
  });
});
