// 快捷入口计算器。
//
// 这里盯的不是「四则运算算得对不对」——那是 expr-eval 的事，它自己有测试。
// 这里盯的是我们自己写的那两层：**输入归一化**（中文输入法/习惯写法）和
// **结果闸门**（算得出来 ≠ 该显示）。这两层是手写的，也是历史上出问题的地方。
import { describe, it, expect } from "vitest";
import { calc, normalizeExpr, evaluateExpression, formatResult } from "../electron/core/launcher/tools";

describe("calc · 基础算术（回归保护，改归一化时别把这些改坏）", () => {
  const ok: [string, string][] = [
    ["1+1", "2"],
    ["10-3", "7"],
    ["6*7", "42"],
    ["10/4", "2.5"],
    ["10%3", "1"],          // 后面跟着数值 → 取模，不是百分比
    ["2^10", "1024"],
    ["2^-1", "0.5"],        // 一元负号作指数：手写实现时代这里容易算成 0
    ["-3+5", "2"],
    ["(1+2)*3", "9"],
    ["0.1+0.2", "0.3"],     // 浮点毛刺被 formatResult 抹掉
  ];
  for (const [input, want] of ok) it(`${input} = ${want}`, () => expect(calc(input)).toBe(want));
});

describe("calc · 等号（用户按计算器/Excel 习惯敲的）", () => {
  it("尾部等号剥掉：1-1=", () => expect(calc("1-1=")).toBe("0"));
  it("首部等号剥掉：=1+1", () => expect(calc("=1+1")).toBe("2"));
  it("首尾都有：=1+1=", () => expect(calc("=1+1=")).toBe("2"));
  it("只有等号不算数", () => expect(calc("=")).toBeNull());
});

describe("calc · 中文输入法（全角与中文标点）", () => {
  const ok: [string, string][] = [
    ["１＋１", "2"],
    ["（1+2）*3", "9"],
    ["（2＋3）×４", "20"],
    ["１，２３４＋１", "1235"],       // 全角千分位逗号
    ["2×3", "6"],
    ["10÷2", "5"],
    ["5−3", "2"],                   // U+2212 减号
    ["2·3", "6"],                   // 中点当乘号
    ["3。5+1", "4.5"],              // 中文句号当小数点
  ];
  for (const [input, want] of ok) it(`${input} = ${want}`, () => expect(calc(input)).toBe(want));
});

describe("calc · 千分位逗号", () => {
  it("1,234+1", () => expect(calc("1,234+1")).toBe("1235"));
  it("多段：1,234,567+1", () => expect(calc("1,234,567+1")).toBe("1234568"));
  // 这一条是防回归的重点：早期版本漏了 (?!\d)，max(3,7) 的参数逗号被当千分位吞掉，
  // 再被隐式乘法补上一个 *，算成了 21。
  it("不吞函数参数逗号：max(3,7)", () => expect(calc("max(3,7)")).toBe("7"));
  it("不吞函数参数逗号：min(10,2)", () => expect(calc("min(10,2)")).toBe("2"));
  // 已知取舍：max(1,234) 里的 1,234 长得就是个千分位，无法从字面区分。
  // 记在这里是为了「有人改到这块时知道这是设计选择，不是漏洞」。
  it("已知歧义：max(1,234) 被当成 max(1234)", () => expect(calc("max(1,234)")).toBe("1234"));
});

describe("calc · 百分号的两种语义", () => {
  it("后面没东西 → 百分比：50%", () => expect(calc("50%")).toBe("0.5"));
  it("后面没东西 → 百分比：200*5%", () => expect(calc("200*5%")).toBe("10"));
  it("后面跟着数值 → 取模：10%3", () => expect(calc("10%3")).toBe("1"));
  it("后面跟着括号 → 取模：10%(1+2)", () => expect(calc("10%(1+2)")).toBe("1"));
});

describe("calc · 隐式乘法", () => {
  it("2(3+4)", () => expect(calc("2(3+4)")).toBe("14"));
  it("(1+2)(3+4)", () => expect(calc("(1+2)(3+4)")).toBe("21"));
  it("带空格：2 (3+4)", () => expect(calc("2 (3+4)")).toBe("14"));
  // 防回归：没有后行断言的话 log10( 会被拆成 log1 + 0*(
  it("不拆函数名：log10(100)", () => expect(calc("log10(100)")).toBe("2"));
  it("不拆函数名：atan2(1,1) 可解析", () => expect(calc("atan2(1,1)")).not.toBeNull());
});

describe("calc · 函数与常量", () => {
  it("sqrt(16)", () => expect(calc("sqrt(16)")).toBe("4"));
  it("abs(-3)", () => expect(calc("abs(-3)")).toBe("3"));
  it("round(2.6)", () => expect(calc("round(2.6)")).toBe("3"));
  it("floor(2.9)", () => expect(calc("floor(2.9)")).toBe("2"));
  it("ceil(2.1)", () => expect(calc("ceil(2.1)")).toBe("3"));
  it("5!", () => expect(calc("5!")).toBe("120"));
  it("2**10 → 幂", () => expect(calc("2**10")).toBe("1024"));
  it("PI*2", () => expect(calc("PI*2")).toBe("6.2831853072"));
  it("π*2（中文π）", () => expect(calc("π*2")).toBe("6.2831853072"));
});

describe("calc · 结果闸门：这些必须让位给别的输入节点", () => {
  const nulls = [
    "",            // 空
    "   ",         // 只有空白
    "42",          // 纯数字，没有计算意义
    "-5",          // 带符号的纯数字，同上
    "1,234",       // 千分位数字，归一化后还是纯数字
    "1+",          // 还在输入中途
    "+",           // 只有运算符
    "(",           // 括号不闭合
    "abc",         // 未绑定变量
    "100usd",      // 该走汇率/单位换算
    "10km",        // 该走单位换算
    "10 km to mi", // 单位换算的标准写法
    "hello world",
    "PI",          // 只有常量，没在「算」
    "1/0",         // Infinity 不显示
    "-1/0",        // -Infinity 同上
    "0/0",         // NaN 同上
  ];
  for (const input of nulls) it(`${JSON.stringify(input)} → null`, () => expect(calc(input)).toBeNull());
});

describe("calc · 安全：非算术运算符一律关掉（撤掉字符白名单后的兜底）", () => {
  const nulls = ["1>2", "1==1", "1 and 1", "1 or 0", "true ? 1 : 2", 'x = 5', '"a" || "b"', "1 in [1,2]"];
  for (const input of nulls) it(`${JSON.stringify(input)} → null`, () => expect(calc(input)).toBeNull());
});

describe("normalizeExpr · 归一化本身", () => {
  it("全角数字转半角", () => expect(normalizeExpr("１２３")).toBe("123"));
  it("全角字母转半角", () => expect(normalizeExpr("ｓｑｒｔ（４）")).toBe("sqrt(4)"));
  it("各类乘号统一成 *", () => {
    for (const c of ["×", "✕", "✖", "⋅", "∗", "＊"]) expect(normalizeExpr(`2${c}3`)).toBe("2*3");
  });
  it("各类减号统一成 -", () => {
    for (const c of ["－", "﹣", "−", "–", "—"]) expect(normalizeExpr(`5${c}3`)).toBe("5-3");
  });
  it("各类括号统一成圆括号", () => {
    for (const [l, r] of [["［", "］"], ["｛", "｝"], ["【", "】"], ["[", "]"], ["{", "}"]]) {
      expect(normalizeExpr(`${l}1+2${r}`)).toBe("(1+2)");
    }
  });
  it("全角空格不残留", () => expect(normalizeExpr("1　+　1")).toBe("1 + 1"));
});

describe("evaluateExpression / formatResult · 分层接口", () => {
  it("返回的是数字而不是字符串", () => expect(evaluateExpression("1+1")).toBe(2));
  it("算不出返回 null", () => expect(evaluateExpression("abc")).toBeNull());
  it("formatResult 抹掉浮点毛刺", () => expect(formatResult(0.1 + 0.2)).toBe("0.3"));
  it("formatResult 保留至多 10 位小数", () => expect(formatResult(1 / 3)).toBe("0.3333333333"));
  it("calc = evaluateExpression + formatResult", () => expect(calc("7/2")).toBe(formatResult(evaluateExpression("7/2")!)));
});
