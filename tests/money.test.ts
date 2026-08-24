// 记账纯函数层。
//
// 盯的重点有两个：
// ① **金额算式的闸门**。算式框直接吃用户键盘，「算得出来」和「该入账」是两回事 ——
//    负数、零、除以零、天文数字、被关掉的运算符，任何一个漏进去都是一条脏流水，
//    而且金额错的流水不像崩溃，它安安静静躺在统计里。
// ② **月份边界**。ym 是统计的分桶键，跨年/跨月算错一位，一笔账就进错一个月，
//    和服务端 test_money.py 盯的是同一类事、同一套取值，两端要算得一样。
import { describe, expect, it } from "vitest";
import {
  amountToCents, catIcon, catColor, groupByDay, isExpr, normalizeAmount, shiftYm, ymOf, yuan,
} from "../src/features/money/moneyKit";

describe("金额算式 · 正常路", () => {
  const ok: [string, number][] = [
    ["12", 1200],
    ["12.5", 1250],
    ["258/3", 8600],
    ["12+3.5*2", 1900],
    ["(2+3)*4", 2000],
    ["0.1+0.2", 30],          // 浮点毛刺被 Math.round 抹掉
    ["１２＋８", 2000],        // 全角数字与加号
    ["（2＋3）×4", 2000],      // 中文括号 + 全角乘号
    ["10÷4", 250],
    ["1,234+1", 123500],      // 千分位逗号
    ["¥30", 3000],            // 习惯写法：带货币符号
    ["30元", 3000],
    ["=1+1=", 200],           // 按计算器习惯敲的等号
    ["5−3", 200],             // U+2212 减号
  ];
  for (const [input, cents] of ok) {
    it(`${input} → ${cents} 分`, () => expect(amountToCents(input)).toBe(cents));
  }
});

describe("金额算式 · 闸门（算得出来 ≠ 该入账）", () => {
  const bad: string[] = [
    "", "   ", "abc", "。。",
    "0", "0.004",             // 四舍五入后不足 1 分
    "-5", "3-5",              // 金额必须是正的（服务端同样会 400）
    "1/0",                    // Infinity
    "10000000",               // 超过 ¥9,999,999.99 —— 几乎必然是敲错了
    "2^10", "10%3", "5!",     // 被关掉的运算符：金额框只有 + - × ÷
    "sqrt(16)",               // 函数调用不放行
    "alert(1)",               // 不是 eval，解析层直接拒绝
    "((2+3)*4",               // 括号不配对
  ];
  for (const input of bad) {
    it(`拒绝 ${JSON.stringify(input)}`, () => expect(amountToCents(input)).toBeNull());
  }

  it("上限内最大值放行：9999999.99", () => {
    expect(amountToCents("9999999.99")).toBe(999_999_999);
  });
});

describe("金额算式 · 预览判定与归一化", () => {
  it("纯数字不算算式（不显示 = 预览行）", () => {
    expect(isExpr("1234")).toBe(false);
    expect(isExpr("12.5")).toBe(false);
  });
  it("带运算符才算算式", () => {
    expect(isExpr("258/3")).toBe(true);
    expect(isExpr("12×3")).toBe(true);
    expect(isExpr("１＋１")).toBe(true);
  });
  it("归一化剥掉 ¥ / 空格 / 等号", () => {
    expect(normalizeAmount(" ¥ 1,2００ = ")).toBe("1200");
  });
});

describe("月份工具 · 与服务端同构", () => {
  it("shiftYm 跨年往前", () => expect(shiftYm("2026-01", -1)).toBe("2025-12"));
  it("shiftYm 跨年往后", () => expect(shiftYm("2026-12", 1)).toBe("2027-01"));
  it("shiftYm 一年整", () => expect(shiftYm("2026-08", -12)).toBe("2025-08"));
  it("shiftYm 原地不动", () => expect(shiftYm("2026-08", 0)).toBe("2026-08"));
  it("ymOf 一月不丢前导零", () => expect(ymOf(new Date(2026, 0, 31))).toBe("2026-01"));
  it("ymOf 十二月", () => expect(ymOf(new Date(2025, 11, 1))).toBe("2025-12"));
});

describe("展示工具", () => {
  it("yuan 千分位 + 两位小数", () => expect(yuan(180000)).toBe("1,800.00"));
  it("yuan 不足一元", () => expect(yuan(38)).toBe("0.38"));
  it("色槽 1–7 → 彩色变量，0 与越界 → 中性灰", () => {
    expect(catColor(1)).toBe("var(--c1)");
    expect(catColor(7)).toBe("var(--c7)");
    expect(catColor(0)).toBe("var(--c8)");
    expect(catColor(8)).toBe("var(--c8)");
  });
  it("未知 slug 的图标兜底到「其他」", () => {
    expect(catIcon("unknown_slug")).toBe(catIcon("other"));
  });
});

describe("按本地日分组", () => {
  // 造三条：8/19 两笔（一支一收）、8/18 一笔。at_ms 用本地时间构造，降序进。
  const at = (d: number, h: number) => new Date(2026, 7, d, h).getTime();
  const rows = [
    { at_ms: at(19, 12), direction: "expense", cents: 3800 },
    { at_ms: at(19, 9), direction: "income", cents: 32000 },
    { at_ms: at(18, 21), direction: "expense", cents: 21380 },
  ];
  const groups = groupByDay(rows);

  it("同一天并进一组，天序保持入参顺序（服务端已排好）", () => {
    expect(groups.map((g) => g.day)).toEqual(["2026-08-19", "2026-08-18"]);
    expect(groups[0].items.length).toBe(2);
  });
  it("组内支出 / 收入分开合计", () => {
    expect(groups[0].spend).toBe(3800);
    expect(groups[0].earn).toBe(32000);
    expect(groups[1].spend).toBe(21380);
    expect(groups[1].earn).toBe(0);
  });
  it("跨月的两天不并组（分组键含月份）", () => {
    const g = groupByDay([
      { at_ms: new Date(2026, 8, 1, 8).getTime(), direction: "expense", cents: 100 },
      { at_ms: new Date(2026, 7, 1, 8).getTime(), direction: "expense", cents: 100 },
    ]);
    expect(g.map((x) => x.day)).toEqual(["2026-09-01", "2026-08-01"]);
  });
});
