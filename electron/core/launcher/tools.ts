// 快捷入口小工具（纯函数，无 Electron 依赖，便于复用/测试）：计算器、单位换算、编解码。

// ── 计算器：安全表达式求值（不使用 eval）。支持 + - * / % ^ 和括号、小数、一元负号。──
export function calc(input: string): string | null {
  const s = (input || "").trim();
  if (!s || !/[0-9]/.test(s) || !/[-+*/%^]/.test(s)) return null;      // 至少含数字与运算符
  if (!/^[0-9+\-*/%^().\s]+$/.test(s)) return null;                    // 仅允许安全字符
  try {
    const rpn = toRPN(s);
    if (!rpn) return null;
    const val = evalRPN(rpn);
    if (val === null || !isFinite(val)) return null;
    // 去掉浮点毛刺，保留至多 10 位小数。
    const r = Math.round(val * 1e10) / 1e10;
    return String(r);
  } catch { return null; }
}

const PREC: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3 };
function toRPN(s: string): string[] | null {
  const out: string[] = []; const ops: string[] = [];
  const tokens = s.match(/\d+\.?\d*|\.\d+|[-+*/%^()]/g);
  if (!tokens) return null;
  let prev: string | null = null;
  for (let tk of tokens) {
    if (/^[\d.]/.test(tk)) { out.push(tk); prev = "num"; continue; }
    if (tk === "(") { ops.push(tk); prev = "("; continue; }
    if (tk === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") out.push(ops.pop()!);
      if (!ops.length) return null;
      ops.pop(); prev = ")"; continue;
    }
    // 一元负号：出现在开头/运算符/左括号后 → 记为 "u-"
    if (tk === "-" && (prev === null || prev === "op" || prev === "(")) { ops.push("u-"); prev = "op"; continue; }
    const p = PREC[tk];
    while (ops.length) {
      const top = ops[ops.length - 1];
      if (top === "(") break;
      const tp = top === "u-" ? 4 : PREC[top];
      if (tp > p || (tp === p && tk !== "^")) out.push(ops.pop()!); else break;
    }
    ops.push(tk); prev = "op";
  }
  while (ops.length) { const o = ops.pop()!; if (o === "(") return null; out.push(o); }
  return out;
}
function evalRPN(rpn: string[]): number | null {
  const st: number[] = [];
  for (const tk of rpn) {
    if (/^[\d.]/.test(tk)) { st.push(parseFloat(tk)); continue; }
    if (tk === "u-") { const a = st.pop(); if (a === undefined) return null; st.push(-a); continue; }
    const b = st.pop(); const a = st.pop();
    if (a === undefined || b === undefined) return null;
    st.push(tk === "+" ? a + b : tk === "-" ? a - b : tk === "*" ? a * b : tk === "/" ? a / b : tk === "%" ? a % b : Math.pow(a, b));
  }
  return st.length === 1 ? st[0] : null;
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

// ── 有道翻译签名（md5(appKey+text+salt+secret)）；用 Node crypto，主进程调用。──
export function youdaoSign(appKey: string, text: string, salt: string, secret: string, md5: (s: string) => string): string {
  return md5(appKey + text + salt + secret);
}
