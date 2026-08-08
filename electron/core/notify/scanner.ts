// 提醒的到点判定与重复推进 —— **纯逻辑，不碰文件、不发请求、不弹通知**。
//
// 单独抽出来是因为这一段最容易写错，而写错的表现是「提醒不响」或者「一次弹二十条」，
// 两种都很难在真机上复现。纯函数就能进 vitest（见 tests/notify.test.ts）。
//
// 两条铁律（来自 doc/提醒与定时任务-设计与待办.md）：
//   1. **不给每条提醒挂定时器**。Electron 的 Notification 没有 at/deliveryDate，
//      而 setTimeout 跨系统休眠不可靠 —— 一律「持久化到点列表 + 短周期扫描 + 醒来补扫」。
//   2. 幂等键**用计划时刻，不用当前时刻**。这样扫描晚跑了、休眠后补扫了、进程重启后
//      重扫了，算出来的 key 都一样，天然去重。
import type { CustomFreq, Reminder, ReminderTomb, RepeatRule } from "./types";

// 错过多久以内还算「正常弹一条」。超过就并成一条摘要，免得一开机糊十几条横幅。
export const FRESH_WINDOW_MS = 15 * 60_000;

// fired 记录保留多久。只要比「一条提醒可能被补弹的最长窗口」长就行，7 天足够。
export const FIRED_KEEP_MS = 7 * 24 * 3600_000;

// 一次待触发。一条提醒最多产生两次：本体，以及提前提醒（如果设了）。
export interface Occurrence {
  reminder: Reminder;
  /** 幂等键：`<id>:<计划时刻>` 或 `<id>:<计划时刻>:ahead` */
  key: string;
  /** 计划触发时刻（不是「现在」） */
  fireAtMs: number;
  /** 是不是提前提醒那一条 */
  ahead: boolean;
}

// 一轮扫描的结果。三档分级见 doc/提醒同步与消息送达-设计草案.md §6.5。
export interface FirePlan {
  /** 错过 ≤15 分钟：正常弹，一条一个通知 */
  due: Occurrence[];
  /** 错过 15 分钟 ~ 今天之内：合并成一条「你有 N 条错过的提醒」 */
  missed: Occurrence[];
  /** 错过超过今天：不弹，只在列表里标逾期 */
  stale: Occurrence[];
  /** 本轮要记进 fired 的全部键（三档都记，否则 stale 会每分钟被重新算一遍） */
  keys: string[];
}

/** 幂等键。**用计划时刻**，见文件头第 2 条。 */
export function firedKey(id: string, fireAtMs: number, ahead: boolean): string {
  return ahead ? `${id}:${fireAtMs}:ahead` : `${id}:${fireAtMs}`;
}

/** 当天 00:00 的时刻。用来判「错过的是不是今天的」。 */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 算出这一轮该弹什么。
 *
 * items 里 done 的、已到点但已经弹过的（fired 里有键的）都会被跳过。
 * **不修改入参**，也不负责推进重复提醒 —— 那是 advance() 的事，调用方分两步做。
 */
export function plan(items: Reminder[], nowMs: number, fired: Record<string, number>): FirePlan {
  const out: FirePlan = { due: [], missed: [], stale: [], keys: [] };
  const today = startOfDay(nowMs);

  const all: Occurrence[] = [];
  for (const r of items) {
    if (r.done) continue;
    all.push({ reminder: r, key: firedKey(r.id, r.atMs, false), fireAtMs: r.atMs, ahead: false });
    if (r.aheadMinutes > 0) {
      const at = r.atMs - r.aheadMinutes * 60_000;
      all.push({ reminder: r, key: firedKey(r.id, r.atMs, true), fireAtMs: at, ahead: true });
    }
  }

  for (const occ of all) {
    if (occ.fireAtMs > nowMs) continue;          // 还没到点
    if (fired[occ.key] !== undefined) continue;  // 这台机器已经弹过了
    out.keys.push(occ.key);
    const late = nowMs - occ.fireAtMs;
    if (late <= FRESH_WINDOW_MS) out.due.push(occ);
    else if (occ.fireAtMs >= today) out.missed.push(occ);
    else out.stale.push(occ);
  }
  return out;
}

/** 按规则往后走一步。不重复的返回 null。 */
export function stepOnce(atMs: number, rule: RepeatRule, freq: CustomFreq, n: number): number | null {
  const d = new Date(atMs);
  const k = Math.max(1, n);
  switch (rule) {
    case "daily":
      d.setDate(d.getDate() + 1);
      return d.getTime();
    case "weekly":
      d.setDate(d.getDate() + 7);
      return d.getTime();
    case "monthly":
      d.setMonth(d.getMonth() + 1);
      return d.getTime();
    case "weekday": {
      // 跳到下一个工作日（跳过周六周日）。
      do {
        d.setDate(d.getDate() + 1);
      } while (d.getDay() === 0 || d.getDay() === 6);
      return d.getTime();
    }
    case "custom":
      switch (freq) {
        case "hour": d.setHours(d.getHours() + k); return d.getTime();
        case "week": d.setDate(d.getDate() + 7 * k); return d.getTime();
        case "month": d.setMonth(d.getMonth() + k); return d.getTime();
        case "year": d.setFullYear(d.getFullYear() + k); return d.getTime();
        default: d.setDate(d.getDate() + k); return d.getTime();
      }
    default:
      return null;
  }
}

/**
 * 把一条已经过点的重复提醒推进到下一个**未来**的时刻。
 *
 * 返回 null 表示不用动（不重复、还没到点、或者已经 done）。
 * 越过 repeatEndMs 就返回 done:true —— 重复到头了，整条标完成。
 *
 * 一次推进可能跨过好几次（出差三天回来），但**只推进、不为跳过的那几次补通知** ——
 * 这就是「重复提醒只补最近一次」的落点：三天没开电脑，回来只该看到一条「吃药」，
 * 不是二十一条。
 */
export function advance(r: Reminder, nowMs: number): { atMs: number; done: boolean } | null {
  if (r.done || r.repeatRule === "none") return null;
  if (r.atMs > nowMs) return null;

  let at = r.atMs;
  // 400 是防死循环的护栏：规则算错时（比如 custom 的 n 被写成 0）宁可停下，
  // 也不能让主进程在这里转到天荒地老。
  for (let i = 0; i < 400; i++) {
    const next = stepOnce(at, r.repeatRule, r.customFreq, r.customN);
    if (next === null || next <= at) return null;   // 规则不推进，别陷进去
    at = next;
    if (r.repeatEndMs !== null && at > r.repeatEndMs) return { atMs: r.atMs, done: true };
    if (at > nowMs) return { atMs: at, done: false };
  }
  return null;
}

/** 清掉过期的 fired 记录，别让它无限长。返回新的一份（不改入参）。 */
export function pruneFired(fired: Record<string, number>, nowMs: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(fired)) {
    if (nowMs - v < FIRED_KEEP_MS) out[k] = v;
  }
  return out;
}

/** 未完成且已过期/今天到点的条数 —— 与 iOS 底栏角标、中号小组件同一口径。 */
export function pendingCount(items: Reminder[], nowMs: number): number {
  const end = startOfDay(nowMs) + 24 * 3600_000;
  return items.filter((r) => !r.done && r.atMs < end).length;
}

/**
 * 把服务端拉到的一批并进本地。**纯函数**，与 iOS 的 ReminderMerge.apply 是同一套规则 ——
 * 两端判得不一样的话会出现「这台删了那台又同步回来」的鬼打墙。
 *
 * 逐条 last-write-wins，但**本地未推送（dirty）且更新时本地赢**：
 * 不这么做的话，断网时改了一条，联网拉一次就被服务端旧值覆盖，用户的修改凭空消失。
 */
export function mergeRemote(local: Reminder[], items: Reminder[], tombs: ReminderTomb[]): Reminder[] {
  const byId = new Map<string, Reminder>();
  for (const r of local) byId.set(r.id, r);

  for (const s of items) {
    const mine = byId.get(s.id);
    if (mine && mine.dirty && mine.updatedAtMs > s.updatedAtMs) continue;
    byId.set(s.id, s);
  }
  for (const t of tombs) {
    const mine = byId.get(t.id);
    if (mine && mine.dirty && mine.updatedAtMs > t.deletedAtMs) continue;
    byId.delete(t.id);
  }
  return [...byId.values()].sort((a, b) => a.atMs - b.atMs);
}
