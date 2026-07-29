// 快捷入口的排序内核：匹配质量（fuzzy）+ 使用习惯（frecency）。
//
// 两套业界成熟做法，各管一半：
//
// ① 匹配质量 —— Sublime Text 那套子序列模糊匹配（Forrest Smith 2016/2017 公开的实现）。
//    常量沿用他递归版的取值：连续 +15、分隔符后 +30、驼峰 +30、首字母 +15、
//    开头未匹配每字 -5（最多 -15）、目标里没用上的字 -1。
//    好处是「st」能命中 SourceTree、「wc」能命中 WeChat，而不用死磕前缀/包含三档。
//
// ② 使用习惯 —— frecency（frequency + recency），采用 zoxide 的时间分档乘子：
//    一小时内 ×4、一天内 ×2、一周内 ×1、一月内 ×0.5、更早 ×0.25。
//    再用 ln 压一道转成有界加分，免得用了一百次的条目把匹配度彻底淹没。
//
// 最终排序 = 来源基准分 + 匹配分 + frecency 加分，同分再看匹配分、最后按标题字典序。

// ── ① 模糊匹配 ────────────────────────────────────────────────────────────
const SEQ_BONUS = 15;        // 与上一个命中字相邻
const SEP_BONUS = 30;        // 紧跟在分隔符后面（词首）
const CAMEL_BONUS = 30;      // 小写后面的大写（驼峰词首）
const FIRST_BONUS = 15;      // 命中目标的第 0 个字符
const LEAD_PENALTY = -5;     // 目标开头每个没用上的字符
const LEAD_PENALTY_MAX = -15;
const UNMATCHED_PENALTY = -1;
const UNMATCHED_CAP = 30;    // 未命中字符的扣分上限：不然长文本（剪贴板预览）会被一路扣穿
const BASE = 100;            // 起评分，让常见情况落在正数区间，便于和别的分量相加
const MAX_TARGET = 120;      // 超长目标只看前面这一截，别让回溯跑飞
const MAX_STEPS = 2000;      // 回溯步数上限（兜底，极端输入下不卡住主进程）

const SEPARATORS = " \t_-./\\:|·，,（）()[]【】";
function isSep(c: string): boolean {
  return SEPARATORS.includes(c);
}

// 中日韩表意文字：这类文字没有分隔符，但每个字本身就是一个「词」，
// 所以「微信」应该能在「企业微信」里拿到词首加分，否则中文名永远排在英文名后面。
function isCJK(c: string): boolean {
  const n = c.codePointAt(0) || 0;
  return (n >= 0x3040 && n <= 0x30ff) || (n >= 0x3400 && n <= 0x4dbf) || (n >= 0x4e00 && n <= 0x9fff)
    || (n >= 0xf900 && n <= 0xfaff) || (n >= 0xac00 && n <= 0xd7af);
}

export interface MatchResult {
  score: number;
  matched: number[]; // 命中位置（渲染层将来要做高亮的话可以直接用）
}

// 给一组命中位置打分。
function scoreOf(target: string, matched: number[]): number {
  let s = BASE;
  s += Math.max(LEAD_PENALTY_MAX, LEAD_PENALTY * matched[0]);
  s += UNMATCHED_PENALTY * Math.min(target.length - matched.length, UNMATCHED_CAP);
  for (let i = 0; i < matched.length; i++) {
    const idx = matched[i];
    if (i > 0 && matched[i - 1] === idx - 1) s += SEQ_BONUS;
    if (idx === 0) {
      s += FIRST_BONUS;
      continue;
    }
    const prev = target[idx - 1];
    const cur = target[idx];
    if (isSep(prev)) s += SEP_BONUS;
    else if (isCJK(cur)) s += SEP_BONUS;
    else if (cur !== cur.toLowerCase() && prev === prev.toLowerCase() && prev !== prev.toUpperCase()) s += CAMEL_BONUS;
  }
  return s;
}

// 廉价的子序列预判：一次线性扫描就能否掉绝大多数候选，
// 免得每个应用名都白跑一趟回溯（应用目录动辄几百个，全量打分是实打实的开销）。
function isSubsequence(lp: string, lt: string): boolean {
  let i = 0;
  for (let j = 0; j < lt.length && i < lp.length; j++) if (lt[j] === lp[i]) i++;
  return i === lp.length;
}

// pattern 是否为 target 的子序列；是则返回得分最高的那条命中路径，否则 null。
// 同一个字符可能有多处可匹配（"ftw" 落在 "ForrestTheWoods" 上的 t 有两个候选），
// 所以要回溯着找分最高的一条，而不是贪心取第一条。
export function fuzzyMatch(pattern: string, target: string): MatchResult | null {
  const p = (pattern || "").trim();
  if (!p) return { score: 0, matched: [] };
  const t = (target || "").slice(0, MAX_TARGET);
  if (!t || p.length > t.length) return null;

  const lp = p.toLowerCase();
  const lt = t.toLowerCase();
  if (!isSubsequence(lp, lt)) return null;
  let best: MatchResult | null = null;
  let steps = 0;
  const acc: number[] = [];

  const walk = (pi: number, from: number): void => {
    if (steps++ > MAX_STEPS) return;
    if (pi >= lp.length) {
      const sc = scoreOf(t, acc);
      if (!best || sc > best.score) best = { score: sc, matched: acc.slice() };
      return;
    }
    // 剩下的字符不够填满 pattern 就没必要往下走了
    for (let i = from; i <= lt.length - (lp.length - pi); i++) {
      if (lt[i] !== lp[pi]) continue;
      acc.push(i);
      walk(pi + 1, i + 1);
      acc.pop();
      if (steps > MAX_STEPS) return;
    }
  };
  walk(0, 0);
  return best;
}

// 只要分数，不匹配给 -1（调用方普遍只关心分数）。
export function matchScore(pattern: string, target: string): number {
  const m = fuzzyMatch(pattern, target);
  return m ? m.score : -1;
}

// 一个条目可能有多个可搜字段（应用名 / 路径 / 常用语的名称+关键词+正文），取最高分。
export function bestMatch(pattern: string, targets: (string | undefined | null)[]): number {
  let best = -1;
  for (const t of targets) {
    if (!t) continue;
    const s = matchScore(pattern, t);
    if (s > best) best = s;
  }
  return best;
}

// ── ①b 「像样的匹配」判定 ────────────────────────────────────────────────
// 纯子序列太宽松：查 we 会把 Unsplash Wallpapers（W…e）、wpsoffice（w…e）这种
// 字符散落在词中间的也算命中，列出来纯占位置。Alfred 那套的实质是**只认词首**，
// 这里照做：要么 query 作为连续子串出现在某个词的开头，要么每个字符都落在词首（首字母缩写）。
// 注意这只是「要不要展示」的闸门，打分仍走上面那套；有使用记录的条目由调用方豁免，
// 免得把用户真的用过的东西也一并挡掉。
function isWordStart(t: string, i: number): boolean {
  if (i === 0) return true;
  const prev = t[i - 1];
  const cur = t[i];
  if (isSep(prev)) return true;
  if (isCJK(cur)) return true;                 // 中文每个字都是词首
  // 驼峰：小写（或数字）后面的大写
  const prevLower = prev === prev.toLowerCase() && prev !== prev.toUpperCase();
  if (cur !== cur.toLowerCase() && (prevLower || /[0-9]/.test(prev))) return true;
  return false;
}

export function isStrongMatch(pattern: string, target: string): boolean {
  const p = (pattern || "").trim().toLowerCase();
  if (!p) return true;
  const t = (target || "").slice(0, MAX_TARGET);
  if (!t) return false;
  const lt = t.toLowerCase();

  // ① 连续子串，且落在某个词的开头
  for (let idx = lt.indexOf(p); idx >= 0; idx = lt.indexOf(p, idx + 1)) {
    if (isWordStart(t, idx)) return true;
  }
  // ② 首字母缩写：每个字符按顺序都落在词首（st → SourceTree、vsc → Visual Studio Code）
  let i = 0;
  for (let j = 0; j < t.length && i < p.length; j++) {
    if (lt[j] === p[i] && isWordStart(t, j)) i++;
  }
  return i === p.length;
}

// 多字段版本：任意一个字段够格就算够格。
export function anyStrongMatch(pattern: string, targets: (string | undefined | null)[]): boolean {
  return targets.some((t) => !!t && isStrongMatch(pattern, t));
}

// ── ② frecency ───────────────────────────────────────────────────────────
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

// zoxide 的时间分档：越近的一次使用，同样的次数值钱越多。
export function recencyMultiplier(ageMs: number): number {
  if (ageMs < HOUR) return 4;
  if (ageMs < DAY) return 2;
  if (ageMs < WEEK) return 1;
  if (ageMs < MONTH) return 0.5;
  return 0.25;
}

export interface UsageEntry {
  c: number; // 累计次数
  t: number; // 最近一次使用时间戳
}

export function frecency(u: UsageEntry | undefined, now: number): number {
  if (!u || !u.c) return 0;
  return u.c * recencyMultiplier(now - u.t);
}

// 用 ln 把 frecency 压成有界加分。
// 取值感受：刚用过一次 ≈ +55，用过十次 ≈ +103，用得再多也顶到 150 封顶。
// 这个量级刻意做得能盖过匹配度差异 —— 用户要的就是「我常开的那个，打首字母就该在第一位」。
const FRECENCY_WEIGHT = 34;
const FRECENCY_CAP = 150;
export function frecencyBoost(f: number): number {
  if (f <= 0) return 0;
  return Math.min(FRECENCY_CAP, Math.round(FRECENCY_WEIGHT * Math.log1p(f)));
}

// ── ③ 使用记录：按「查询词前缀」分桶 ───────────────────────────────────────
// 键是 `${前缀}\n${条目id}`，写入时把查询词的每一个前缀都记一遍（含空串=全局桶）。
// 这样「我打 sour 选了 SourceTree」这件事，下次只打一个 s 也能用上——
// 旧实现把学习绑死在完整查询词上，打 s 和打 sour 是两条互不相干的记录，
// 于是「常用的软件打首字母排第一」这个最自然的诉求永远实现不了。
export const MAX_PREFIX = 8; // 只记前 8 个字符的前缀，再长收益很小、条目却翻倍

export function usageKey(prefix: string, id: string): string {
  return `${prefix}\n${id}`;
}

// 一次使用要写入的所有键（前缀 0..MAX_PREFIX）。
export function usageKeysForWrite(query: string, id: string): string[] {
  const q = (query || "").trim().toLowerCase();
  const n = Math.min(q.length, MAX_PREFIX);
  const keys: string[] = [];
  for (let k = 0; k <= n; k++) keys.push(usageKey(q.slice(0, k), id));
  return keys;
}

// 查询时从最长前缀往回找，第一个命中的就是最贴合当前输入的那条记录。
// （写入时短前缀一定也写了，所以短前缀的次数天然 ≥ 长前缀，回退不会漏。）
export function lookupUsage(
  usage: Record<string, UsageEntry>,
  query: string,
  id: string,
): UsageEntry | undefined {
  const q = (query || "").trim().toLowerCase();
  for (let k = Math.min(q.length, MAX_PREFIX); k >= 0; k--) {
    const u = usage[usageKey(q.slice(0, k), id)];
    if (u) return u;
  }
  return undefined;
}

// 记录一次使用：所有前缀桶各加一次。
export function noteUsage(usage: Record<string, UsageEntry>, query: string, id: string, now: number): void {
  for (const k of usageKeysForWrite(query, id)) {
    const u = usage[k] || { c: 0, t: 0 };
    usage[k] = { c: u.c + 1, t: now };
  }
}

// 老化：条目太多时按 frecency 砍掉尾部。
// 前缀分桶会让记录数涨得比以前快（一次使用最多写 9 条），所以必须有这一步。
const PRUNE_AT = 6000;
const PRUNE_KEEP = 3500;
export function pruneUsage(usage: Record<string, UsageEntry>, now: number): void {
  const keys = Object.keys(usage);
  if (keys.length <= PRUNE_AT) return;
  keys
    .map((k) => ({ k, f: frecency(usage[k], now) }))
    .sort((a, b) => b.f - a.f)
    .slice(PRUNE_KEEP)
    .forEach((x) => delete usage[x.k]);
}
