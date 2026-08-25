// 记账的纯函数层与客户端常量：分类图标 / 二级预设 / 金额算式 / 月份工具 / 日分组。
//
// 字段名一律照抄服务端 JSON（拍板 D2：服务端定一份正本，两端照它落表与序列化，
// 不做重命名层）。这里只放**不碰网络、不碰 React** 的东西，好测也好被 iOS 对照。
//
// 分类的**图标不存服务端** —— 服务端 schema 注释明写：两端的图标是各自的本地资源，
// 服务端只管 slug / 显示名 / 色槽。所以这张 slug→path 表是 PC 自己的资源文件，
// 服务端新增分类（现在还不能）时这里兜底用「其他」的三个点。
import { Parser } from "expr-eval";

// ── 分类图标（线性描边 path）────────────────────────────────────────────────
// 取值照抄 doc/Umbra设计稿-ClaudeDesign/umbra-icons.json 的 category 组 ——
// 那份文件自己声明「两端同名图标以本文件为准」，稿里 demo 的 CATS 表偶尔滞后，
// 以 json 为正本（2026-08-24 全量导入起）。bonus / parttime / invest 三个
// json 没收录，沿用稿的 CATS 值。iOS 的 MoneyCatArt 是同一批 path 的
// M/L/C/Z 转换版，改这里必须同步改那边。
export const CAT_ICON: Record<string, string> = {
  housing: "M4 11l8-6 8 6v9H4zM10 20v-6h4v6",
  food: "M6 3v4.2M9 3v4.2M12 3v4.2M6 7.2h6M9 7.2V21M17.5 10.6V21M17.5 2.9c1.5 0 2.7 1.7 2.7 3.9s-1.2 3.9-2.7 3.9-2.7-1.7-2.7-3.9 1.2-3.9 2.7-3.9z",
  shopping: "M5 8h14l-1.2 12H6.2zM9 8V5a3 3 0 0 1 6 0v3",
  transport: "M2.5 15.5v-2.6l2.3-.6 2.4-3.3h9l2.6 3.3 2.7.6v2.6h-2.4M14.8 15.5H9.2M5 15.5H2.5M5.2 15.7a1.9 1.9 0 1 0 3.8 0 1.9 1.9 0 1 0-3.8 0M15 15.7a1.9 1.9 0 1 0 3.8 0 1.9 1.9 0 1 0-3.8 0",
  fun: "M4 6h16v12H4zM9 9v6l5-3z",
  daily: "M7 4h10l1 16H6zM10 4V2h4v2M9 12h6",
  medical: "M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z",
  study: "M2.5 9.2 12 5.2l9.5 4-9.5 4zM6.8 11v4.2c0 1.4 2.3 2.4 5.2 2.4s5.2-1 5.2-2.4V11M21.5 9.6v4.4",
  social: "M12 20s-7-4.4-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.6-7 9-7 9z",
  other: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M8.4 12h.01M12 12h.01M15.6 12h.01",
  salary: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M8.8 8.2 12 12l3.2-3.8M12 12v4.6M9.4 13h5.2",
  bonus: "M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z",
  parttime: "M4 8h16v11H4zM9 8V5h6v3",
  invest: "M4 18l5-6 4 3 6-8M4 20h16",
  reimburse: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  other_in: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M8.4 12h.01M12 12h.01M15.6 12h.01",
};
export const catIcon = (slug: string): string => CAT_ICON[slug] || CAT_ICON.other;

// ── 来源徽章（label 走 i18n `money.src_*`，这里只放图标 path）────────────────
// recur 的徽章按稿要能点回规则 —— 那是二期（周期记账）的事，一期只显示。
export const SRC_ICON: Record<string, string> = {
  manual: "M4 20h4L20 8l-4-4L4 16z",
  shot: "M4 8V6a2 2 0 0 1 2-2h2M20 8V6a2 2 0 0 0-2-2h-2M4 16v2a2 2 0 0 0 2 2h2M20 16v2a2 2 0 0 1-2 2h-2M9 12h6",
  import: "M12 4v11M7 11l5 5 5-5M5 20h14",
  chat: "M21 11.5a8.4 8.4 0 0 1-11.9 7.6L4 20l1-4.6A8.4 8.4 0 1 1 21 11.5z",
  recur: "M20 11a8 8 0 0 0-13.7-5.7L3 8M3 4v4h4M4 13a8 8 0 0 0 13.7 5.7L21 16M21 20v-4h-4",
};

// ── 二级分类预设（稿 SUBS 表原样）──────────────────────────────────────────
// 二级存的是**中文字符串不是 slug**（服务端 §3.1 明写，稿就是这么设计的），
// 所以这张表是「输入建议」不是枚举 —— 流水里出现表外的二级也完全合法。
export const SUBS: Record<string, string[]> = {
  food: ["早餐", "午餐", "晚餐", "外卖", "咖啡奶茶", "请客"],
  transport: ["打车", "公交地铁", "加油", "停车", "火车高铁", "机票"],
  shopping: ["服饰", "数码", "家居", "美妆"],
  housing: ["房租房贷", "水电燃气", "物业", "宽带"],
  daily: ["生活用品", "母婴", "宠物"],
  fun: ["订阅会员", "游戏", "观影演出", "旅行"],
  medical: ["门诊", "药品", "体检", "保险"],
  study: ["书籍", "课程", "软件工具"],
  social: ["红包", "礼物", "请客送礼"],
  other: [],
  salary: ["月薪", "年终"],
  reimburse: ["差旅", "办公"],
};

// ── 金额与色槽 ──────────────────────────────────────────────────────────────
/** 整数分 → "1,800.00"。金额一律整数分（服务端硬规则），只在展示时除 100。 */
export function yuan(cents: number): string {
  return (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 色槽 → CSS 变量。slot 1–7 是彩色，0（无槽）与一切非法值用中性灰 --c8。 */
export function catColor(slot: number): string {
  return slot >= 1 && slot <= 7 ? `var(--c${slot})` : "var(--c8)";
}

// ── 金额算式（记一笔的输入框支持直接敲 258/3）───────────────────────────────
// 解析求值交给 expr-eval（不用 eval / new Function，AST 沙箱，快捷入口计算器同款）。
// 归一化**没有**复用 electron/core/launcher/tools.ts 的那份：本工程的边界惯例是
// 渲染层不跨层 import 主进程代码（见 features/tools/bridges.ts 的注释），而且这里
// 只要四则运算 —— 启动器那层的 %、^、sqrt、单位换算在金额框里都是干扰。
const AMOUNT_PARSER = new Parser({
  operators: {
    add: true, subtract: true, multiply: true, divide: true,
    // 金额框只有 + - × ÷（小键盘就这四个）。多开一类就多一类惊喜。
    remainder: false, power: false, factorial: false,
    concatenate: false, conditional: false, logical: false,
    comparison: false, in: false, assignment: false,
  },
});

/** 全角数字/符号、中文输入法标点、¥ 前缀、首尾等号 → 标准算式。 */
export function normalizeAmount(input: string): string {
  return String(input || "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/[×ｘＸ]/g, "*")
    .replace(/[÷]/g, "/")
    .replace(/[＋]/g, "+")
    .replace(/[－−–—]/g, "-")
    .replace(/[．]/g, ".")
    .replace(/（/g, "(").replace(/）/g, ")")
    .replace(/[，,]/g, "")        // 千分位逗号（全角/半角）直接拿掉
    .replace(/[¥￥元\s]/g, "")    // ¥1,800 / 30元 这种习惯写法
    .replace(/^=+|=+$/g, "")      // 按计算器习惯敲的等号
    .trim();
}

/** 算式/数字 → **整数分**。算不出、≤0、超过 ¥9,999,999.99 都回 null。
 *
 *  上限不是拍脑袋：SQLite 的 INTEGER 装得下，但一笔上千万的「记账」几乎必然是
 *  把算式敲错了（比如少个小数点）——静默收下再显示出来，比当场拒绝更害人。 */
export function amountToCents(input: string): number | null {
  const s = normalizeAmount(input);
  if (!s || !/\d/.test(s)) return null;
  // 白名单闸门：归一化之后只该剩数字和四则符号。这不是多余的保险 ——
  // expr-eval 的 operators 开关**管不到内置函数**，sqrt(16)、PI 这类照样能算出来，
  // 而金额框里出现任何字母都只可能是误触或粘贴错了。
  if (/[^0-9+\-*/().]/.test(s)) return null;
  let v: number;
  try {
    const r: unknown = AMOUNT_PARSER.parse(s).evaluate({});
    if (typeof r !== "number") return null;
    v = r;
  } catch {
    return null;
  }
  if (!isFinite(v) || v <= 0) return null;
  const cents = Math.round(v * 100);
  if (cents <= 0 || cents > 999_999_999) return null;
  return cents;
}

/** 输入里带没带运算符（决定要不要显示「= ¥86.00」的预览行）。 */
export function isExpr(input: string): boolean {
  return /[+\-*/×÷＋－]/.test(normalizeAmount(input).replace(/^-/, ""));
}

// ── 月份工具（与服务端 money.py 的 month_of / shift_month 同构）─────────────
/** 本地时区的 YYYY-MM。月份是**本地时间**概念（服务端按 tz_offset_min 分桶）。 */
export function ymOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "2026-08" ± N 个月。跨年靠整数月运算，别用 Date 加减（夏令时会咬人）。 */
export function shiftYm(ym: string, delta: number): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12 + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`;
}

/** 客户端时区偏移（东八区 = +480）。写入 tz_offset_min 用，正负号与服务端约定一致。 */
export function tzOffsetMin(): number {
  return -new Date().getTimezoneOffset();
}

// ── 流水行（服务端 _row 的镜像类型在 server.ts；这里只做分组）────────────────
export interface DayGroup<T extends { at_ms: number; direction: string; cents: number }> {
  /** 本地日期键 YYYY-MM-DD，组内第一条的 at_ms 决定。 */
  day: string;
  /** 这一天的第一条（取 Date 展示用）。 */
  date: Date;
  items: T[];
  spend: number;
  earn: number;
}

/** 按**本地日**分组。入参默认已按 at_ms 降序（服务端就是这么排的），
 *  这里不重排 —— 排序是服务端的责任，客户端再排一遍等于两处真相。 */
export function groupByDay<T extends { at_ms: number; direction: string; cents: number }>(items: T[]): DayGroup<T>[] {
  const out: DayGroup<T>[] = [];
  let cur: DayGroup<T> | null = null;
  for (const e of items) {
    const d = new Date(e.at_ms);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!cur || cur.day !== key) {
      cur = { day: key, date: d, items: [], spend: 0, earn: 0 };
      out.push(cur);
    }
    cur.items.push(e);
    if (e.direction === "income") cur.earn += e.cents; else cur.spend += e.cents;
  }
  return out;
}
