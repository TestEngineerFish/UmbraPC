// 快捷入口排序内核：模糊匹配打分 + frecency 加权。
// 这块是「看着没问题、实际排序不对」的重灾区，用例都盯着相对顺序、不盯绝对分值
//（常量将来可能调，锁死分数只会让测试变成改动的阻力）。
import { describe, expect, it } from "vitest";
import {
  anyStrongMatch, bestMatch, frecency, frecencyBoost, isStrongMatch,
  noteUsage, recencyMultiplier, type UsageEntry,
} from "../electron/core/launcher/rank";

describe("模糊匹配", () => {
  it("首字母缩写能命中（这是用子序列匹配而不是前缀匹配的全部理由）", () => {
    expect(bestMatch("st", ["SourceTree"])).toBeGreaterThan(0);
    expect(bestMatch("wc", ["WeChat"])).toBeGreaterThan(0);
  });

  it("词首匹配得分高于散落在词中间的匹配", () => {
    expect(bestMatch("we", ["WeChat"])).toBeGreaterThan(bestMatch("we", ["Unsplash Wallpapers"]));
  });

  it("命中得越多越连续，分越高", () => {
    const full = bestMatch("sourcetree", ["SourceTree"]);
    const part = bestMatch("sour", ["SourceTree"]);
    const abbr = bestMatch("st", ["SourceTree"]);
    expect(full).toBeGreaterThan(part);
    expect(part).toBeGreaterThan(abbr);
  });

  it("中文每个字都算词首，中文名不会被英文名系统性压过", () => {
    expect(isStrongMatch("微信", "企业微信")).toBe(true);
  });

  it("闸门挡掉字符散落在词中间的弱匹配", () => {
    expect(isStrongMatch("we", "Unsplash Wallpapers")).toBe(false);
    expect(isStrongMatch("we", "WeChat")).toBe(true);
  });

  it("匹配不上返回负数，调用方据此丢弃", () => {
    expect(bestMatch("zzz", ["SourceTree"])).toBeLessThan(0);
  });

  it("多个名字取最高分（一个应用有文件名/展示名/bundle id 好几个目标）", () => {
    expect(bestMatch("wecom", ["企业微信", "WeCom"])).toBeGreaterThan(0);
    expect(anyStrongMatch("wecom", ["企业微信", "WeCom"])).toBe(true);
  });
});

describe("frecency", () => {
  const now = 1_700_000_000_000;
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;

  it("越近用过乘子越大（zoxide 的时间分档）", () => {
    expect(recencyMultiplier(HOUR / 2)).toBeGreaterThan(recencyMultiplier(2 * DAY));
    expect(recencyMultiplier(2 * DAY)).toBeGreaterThan(recencyMultiplier(60 * DAY));
  });

  it("用得多分更高，但被 ln 压住，不会把匹配度彻底淹没", () => {
    const few: UsageEntry = { c: 1, t: now - HOUR };
    const many: UsageEntry = { c: 100, t: now - HOUR };
    expect(frecency(many, now)).toBeGreaterThan(frecency(few, now));
    expect(frecencyBoost(frecency(many, now))).toBeLessThanOrEqual(150);
  });

  it("没用过就没有加分", () => {
    expect(frecency(undefined, now)).toBe(0);
    expect(frecencyBoost(0)).toBe(0);
  });

  it("用过一次之后，同样的查询下它该往前排", () => {
    const usage: Record<string, UsageEntry> = {};
    noteUsage(usage, "s", "app:/A.app", now);
    const entry = Object.values(usage)[0];
    expect(frecencyBoost(frecency(entry, now))).toBeGreaterThan(0);
  });
});
