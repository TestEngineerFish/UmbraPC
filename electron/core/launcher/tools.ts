// 快捷入口小工具（纯函数，无 Electron 依赖，便于复用/测试）：计算器、单位换算、编解码。

import { Parser } from "expr-eval";

// ── 计算器 ────────────────────────────────────────────────────────────────
//
// 旧实现是手写的 Shunting-yard + RPN，入口卡一道字符白名单
// （/^[0-9+\-*/%^().\s]+$/）。那行既是安全兜底也是兼容性天花板：
// `1-1=`（按计算器习惯敲的等号）、中文输入法下的 `１＋１`／`（1+2）*3`／`2×3`、
// 千分位 `1,234+1`、百分号 `50%`、`2**10`、`sqrt(16)` 全都被它挡在门外。
// 每支持一种写法就要动一次核心逻辑，成本不在初版而在后续每一次。
//
// 现在分层：**归一化（自己写）→ expr-eval 解析求值 → 结果闸门**。
// expr-eval 不用 eval / new Function，自带 AST 沙箱，安全性由库担保，
// 所以字符白名单可以整条撤掉 —— 安全和输入规范化本来就该解耦。
//
// 中文桌面端的输入归一化（全角、中文标点、输入法符号）是必须自己写的一层，
// 任何表达式库都不会替你做。

// 只留算术。expr-eval 默认还开着比较、逻辑、赋值、三元、字符串拼接 ——
// 启动器只要四则运算，多开一类就多一类「本该让位给搜索的输入被算出了结果」。
const PARSER = new Parser({
  operators: {
    add: true, subtract: true, multiply: true, divide: true,
    remainder: true, power: true, factorial: true,
    concatenate: false, conditional: false, logical: false,
    comparison: false, in: false, assignment: false,
  },
});

// 全角 → 半角：数字、字母都是「码位减 0xFEE0」，符号则逐个映射。
const SYMBOL_MAP: Record<string, string> = {
  "＋": "+", "﹢": "+",
  "－": "-", "﹣": "-", "−": "-", "–": "-", "—": "-",
  "＊": "*", "×": "*", "✕": "*", "✖": "*", "·": "*", "⋅": "*", "∗": "*",
  "／": "/", "÷": "/", "∕": "/", "⁄": "/",
  "（": "(", "［": "(", "｛": "(", "【": "(", "[": "(", "{": "(",
  "）": ")", "］": ")", "｝": ")", "】": ")", "]": ")", "}": ")",
  "。": ".", "．": ".",
  "％": "%", "＾": "^", "＝": "=", "，": ",", "！": "!", "　": " ",
  "π": "PI", "Π": "PI",
};

// 把用户实际敲出来的东西整理成 expr-eval 认识的写法。导出仅为了单测能逐条盯住。
export function normalizeExpr(input: string): string {
  let s = (input || "").trim();
  if (!s) return "";

  // 1) 全角数字/字母：ＡＺ ａｚ ０９ 三段都是偏移 0xFEE0。
  s = s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  // 2) 逐个符号映射（中文标点、数学符号、输入法产物）。
  s = s.replace(/[＋﹢－﹣−–—＊×✕✖·⋅∗／÷∕⁄（［｛【[{）］｝】\]}。．％＾＝，！　πΠ]/g, (c) => SYMBOL_MAP[c] ?? c);
  // 3) 等号：用户按计算器习惯会敲 `1+1=`，也有人写 `=1+1`（Excel 习惯）。首尾一律剥掉。
  s = s.replace(/^=+/, "").replace(/=+$/, "").trim();
  // 4) `2**10` 是编程写法，expr-eval 的幂是 `^`。
  s = s.replace(/\*\*/g, "^");
  // 5) 千分位逗号。判据是「逗号后**恰好**跟 3 位数字」——(?!\d) 那半句不能省，
  //    否则 max(3,7) 里的参数逗号会被当千分位吞掉，再被下一步补上隐式乘法，算成 21。
  //    循环 3 次是为了 1,234,567 这种多段的（每轮只能消掉不重叠的一批）。
  for (let i = 0; i < 3; i += 1) s = s.replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  // 6) 百分号有两种语义：`50%` 是除以 100，`10%3` 是取模。
  //    判据是后面还跟不跟数值 —— 不跟，才是百分比。
  s = s.replace(/%(?!\s*[\d.(a-zA-Z])/g, "/100");
  // 7) 隐式乘法。后行断言不能省：朴素的 /(\d+)\s*\(/ 会把 log10(100)
  //    拆成 log1 + 0*(100)，函数名当场报废。
  s = s.replace(/(?<![a-zA-Z0-9_.])(\d+(?:\.\d+)?)\s*\(/g, "$1*(");
  s = s.replace(/\)\s*\(/g, ")*(");

  return s.trim();
}

// 算得出来 ≠ 该显示。计算器节点挂在 trigger.always 上（每次输入都跑、结果并入搜索），
// 所以闸门比算法本身更要紧：放行得太宽，就会从单位换算、文件搜索手里抢走结果位。
function shouldShow(norm: string): boolean {
  // 去掉开头的正负号再判：`-5` 本质还是个纯数字，没有计算意义。
  const body = norm.replace(/^[+-]+/, "");
  // 有二元/后缀运算符，或者有函数调用（sqrt(…)、max(…)），才算是在「算」。
  return /[+\-*/%^!]/.test(body) || /[a-zA-Z_][a-zA-Z_0-9]*\s*\(/.test(body);
}

// 求值。返回 null 表示「这条输入不该由计算器接管」，不区分算不出和不该算 ——
// 调用方只关心要不要出这条结果。
export function evaluateExpression(input: string): number | null {
  const s = normalizeExpr(input);
  if (!s || !shouldShow(s)) return null;
  try {
    const expr = PARSER.parse(s);
    // 还有未绑定变量 → 是 `100usd`、`10km`、`abc` 这类，该让给单位换算/搜索。
    // 靠这一条就够，不用额外维护单位白名单。内置函数与 PI/E 不算变量。
    if (expr.variables().length > 0) return null;
    const val = expr.evaluate({});
    if (typeof val !== "number" || !isFinite(val)) return null;   // 1/0 → Infinity，也不显示
    return val;
  } catch { return null; }
}

// 去掉浮点毛刺，保留至多 10 位小数（沿用旧行为，0.1+0.2 显示 0.3）。
export function formatResult(v: number): string {
  return String(Math.round(v * 1e10) / 1e10);
}

// 对外签名保持不变：算不出返回 null。
export function calc(input: string): string | null {
  const v = evaluateExpression(input);
  return v === null ? null : formatResult(v);
}

// ── 单位换算：形如 "10 km to mi"、"72f to c"、"5 kg in lb"。──
const LEN: Record<string, number> = { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, ft: 0.3048, in: 0.0254, yd: 0.9144 };
const MASS: Record<string, number> = { g: 1, kg: 1000, mg: 0.001, lb: 453.592, oz: 28.3495, t: 1e6 };
const UNIT_ALIAS: Record<string, string> = { 公里: "km", 千米: "km", 米: "m", 厘米: "cm", 毫米: "mm", 英里: "mi", 英尺: "ft", 英寸: "in", 千克: "kg", 公斤: "kg", 克: "g", 磅: "lb", 盎司: "oz", 摄氏: "c", 华氏: "f" };

export function convertUnits(input: string): { title: string; subtitle: string } | null {
  const m = (input || "").trim().toLowerCase().match(/^([-\d.]+)\s*([a-z°一-龥]+)\s*(?:to|in|=|→|换成|转)\s*([a-z°一-龥]+)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]); if (!isFinite(n)) return null;
  const from = UNIT_ALIAS[m[2]] || m[2].replace("°", "");
  const to = UNIT_ALIAS[m[3]] || m[3].replace("°", "");
  const fmt = (x: number) => String(Math.round(x * 1e6) / 1e6);
  // 温度
  const temp = (u: string) => ["c", "f", "k"].includes(u);
  if (temp(from) && temp(to)) {
    let c = from === "c" ? n : from === "f" ? (n - 32) * 5 / 9 : n - 273.15;
    const out = to === "c" ? c : to === "f" ? c * 9 / 5 + 32 : c + 273.15;
    return { title: `${fmt(out)} ${to.toUpperCase()}`, subtitle: `${n} ${from.toUpperCase()} = ${fmt(out)} ${to.toUpperCase()}` };
  }
  for (const table of [LEN, MASS]) {
    if (from in table && to in table) {
      const out = n * table[from] / table[to];
      return { title: `${fmt(out)} ${to}`, subtitle: `${n} ${from} = ${fmt(out)} ${to}` };
    }
  }
  return null;
}

// ── 编解码 ──
export function unicodeTransform(s: string): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (/\\u[0-9a-fA-F]{4}/.test(s)) {
    try { out.push({ label: "Unicode 解码", value: s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) }); } catch { /* */ }
  }
  const enc = Array.from(s).map((ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  out.push({ label: "Unicode 编码", value: enc });
  return out;
}
export function urlTransform(s: string): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  try { if (/%[0-9a-fA-F]{2}/.test(s)) out.push({ label: "URL 解码", value: decodeURIComponent(s) }); } catch { /* */ }
  out.push({ label: "URL 编码", value: encodeURIComponent(s) });
  return out;
}
export function base64Transform(s: string): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  try { if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length % 4 === 0) out.push({ label: "Base64 解码", value: Buffer.from(s, "base64").toString("utf-8") }); } catch { /* */ }
  out.push({ label: "Base64 编码", value: Buffer.from(s, "utf-8").toString("base64") });
  return out;
}

