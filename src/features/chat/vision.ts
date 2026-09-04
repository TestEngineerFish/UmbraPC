// 识图（批次 013 稿 04 ③④⑤）：快捷入口带图 → 服务端「识图先行」在聊天里的三种落地。
//   ③ 占位气泡变体「正在看图…」（复用思考中那颗旋转弧 umbspin，不新造动画）
//   ④ 识图结果确认卡（只有记账出）：四个字段就地可改、低置信只标那一项、「记入」/「改成手动填」
//   ⑤ 识不出：三段式错误卡（没看清这张图 / reason / [手动填一笔] [换一张图]）
// 这里只放**纯 HTML 拼接与纯函数**（vanilla DOM，同 chat.ts 的写法）；块的状态、事件、
// 发送链路都在 chat.ts。分类清单由 chat.ts 拉一次（fetchMoneyCats）缓存后传进来。
import { t } from "../../i18n";
import { btn } from "../../components/kit";
import type { MoneyCat, VisionFields } from "../../services/server";
import { CAT_LABEL, catColor, catIcon, catTint } from "../money/moneyKit";

// ── 块形状（进 chat.ts 的 Block 联合）────────────────────────────────────────
/** 识图结果确认卡。fields 是**就地编辑的当前值**：输入事件随敲随存，整区重绘不丢。
 *
 *  state（批次 013 回执裁定 3 把原来那个含糊的 stale 拆成两态 —— 一句「可能已在别的端处理」
 *  盖了「知道结果」和「不知道结果」两件事，后一种用户看完还得自己去流水里翻）：
 *    open      可改可点
 *    waiting   已点「记入」，等服务端回执
 *    approved  本端记成功（「已记入」，下面紧跟着一条秘书消息）
 *    manual    本端改成手动填
 *    elsewhere **A · 知道结果**：这张卡被别的端记掉了 → 「这笔已经记好了 · 在别的设备上」+「看这笔记录」
 *    stale     **B · 不知道结果**：服务端重启 / 已不认这张卡 / 20 秒没等到回执 →
 *              「这张卡失效了」+ 一句为什么 +「去流水里看」「手动记一笔」
 *  A / B 两态整卡退成只读：描边转 --border-soft、头图标块转中性、四个字段收成一行摘要，
 *  不留禁用的输入框与下拉（禁用态的控件会被反复点）。出口一律次级钮。卡不删也不消失。
 *  卡不持久化（离线由服务端补发）。 */
export interface VCardBlock {
  kind: "vcard";
  confirmId: string;
  /** 原图 file_id：记入后服务端挂成这笔账的凭证；改成手动填时带进记一笔的草稿。 */
  att: string;
  fields: VisionFields;
  /** 服务端随卡给的分类显示名（fields.cat_name）：分类清单还没拉回来时的兜底，别让 slug 裸奔。 */
  catName?: string;
  /** 模型没看清的字段名（yuan / cat / merchant / at_ms），只标那一项，整卡不变色。 */
  unsure: string[];
  userMsgId?: number;
  state: "open" | "waiting" | "approved" | "manual" | "elsewhere" | "stale";
  /** elsewhere 态下服务端给的那笔流水 id / 月份（resolved 带回来）：「看这笔记录」跳过去要它们 ——
   *  识图记账的日期取自票据，拍上个月的票就落在上个月，记账页只加载当月，没有 ym 就只能干瞪眼。 */
  entryId?: string;
  entryYm?: string;
  /** 本端点过「记入」——决定 approved 的回执画成「已记入」还是 A 态「在别的设备上」。
   *  不能靠 state 猜：本端点完超时进了 B 态，和「别的端先记了、本端被 stale 掉」两种情形
   *  state 都是 stale，但一个该是「已记入」、一个该是 A 态。 */
  mine?: boolean;
  /** 服务端回过 stale（这张卡它已经不认了）：那本端这次「记入」肯定没算数，
   *  随后到的 approved 广播是**别的端**记的 —— 光看 mine 会把它错认成本端记成功。 */
  staleAck?: boolean;
  /** 本端在 B 态点过「手动记一笔」：迟到的 approved 回执要提醒一句「那边也记上了，别记重了」。 */
  manualDone?: boolean;
  /** B 态第二句写什么：wait = 等了 20 秒没回执（不知道结果）；otherManual = 别的端把它改成手动填了。 */
  staleWhy?: "wait" | "otherManual";
  ts: number;
}

/** 识不出：三段式错误卡。busy = 「换一张图」选中后正在上传（按钮禁用）。 */
export interface VFailBlock {
  kind: "vfail";
  confirmId: string;
  att: string;
  reason: string;
  userMsgId?: number;
  busy?: boolean;
  ts: number;
}

// ── 图标（线性描边 path；取值照稿 04 节）────────────────────────────────────
// 头部 22 图标块用的记账图标：稿画的就是记账分类里那枚「¥ 圆币」（moneyKit 的 salary 同形）。
const ICON_MONEY = "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M8.8 8.2 12 12l3.2-3.8M12 12v4.6M9.4 13h5.2";
const ICON_CHECK = "M20 6 9 17l-5-5";
const ICON_PENCIL = "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z";
const ICON_WARN_TRI = "M12 4l9 16H3zM12 10v4M12 17v.01";
const ICON_CHEVRON = "M6 9l6 6 6-6";
// 稿 ⑤ 的警示图标是八角形（不是错误块那颗圆的）。
const ICON_ALERT_OCT = "M8.6 3h6.8L21 8.6v6.8L15.4 21H8.6L3 15.4V8.6zM12 8v4.5M12 16h.01";
const ICON_SPIN_ARC = "M12 3a9 9 0 1 0 9 9";
// 失效卡 B 态的时钟（稿 07 节）：不是错误，只是这张卡过期了，所以不用警示形也不用红。
const ICON_CLOCK = "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M12 7.5V12l3 1.8";
/** 引用条 / 气泡内引用块尾部的图片图标（umbra-icons `image`）。 */
export const ICON_IMAGE = "M3 5h18v14H3zM3 16l5-4 4 3 3-2 6 4";

const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function svg(d: string, size: number, width: number, color = "currentColor", extra = ""): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" style="flex:none;${extra}"><path d="${d}"></path></svg>`;
}

// ── 日期时间（datetime-local 的值是本地时间、不带时区）──────────────────────
const pad2 = (n: number) => String(n).padStart(2, "0");
/** at_ms → "2026-09-04T12:38"（<input type=datetime-local> 的 value 格式）。 */
export function toDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** "2026-09-04T12:38" → at_ms（按本地时区解析）；解析不出回 NaN。 */
export function fromDateTimeLocal(v: string): number {
  const s = String(v || "").trim();
  if (!s) return NaN;
  return new Date(s).getTime();
}
/** 只读展示：「2026-09-04 12:38」。 */
export function fmtDateTime(ms: number): string {
  return toDateTimeLocal(ms).replace("T", " ");
}
/** 失效卡摘要里的日期：「09-04」（稿 07 节；一行摘要里不需要年和分钟）。 */
export function fmtDate(ms: number): string {
  return toDateTimeLocal(ms).slice(5, 10);
}

// ── 分类 ────────────────────────────────────────────────────────────────────
export function catOf(cats: MoneyCat[] | null, slug: string): MoneyCat | undefined {
  return cats?.find((c) => c.slug === slug);
}
/** 分类显示名：分类清单 → 服务端随卡给的 cat_name（清单没回来时它比内置表更准，用户可能改过名）
 *  → 内置分类的默认名 → slug 本身。 */
export function catName(cats: MoneyCat[] | null, slug: string, given?: string): string {
  return catOf(cats, slug)?.name || given || CAT_LABEL[slug] || slug || CAT_LABEL.other;
}
/** 卡里分类下拉的候选：同方向 + 启用中（当前选中的那一个即使停用了也保留，别把识出来的值弄丢）。 */
function catOptions(cats: MoneyCat[] | null, direction: VisionFields["direction"], current: string, given?: string): { slug: string; name: string }[] {
  const list = (cats || [])
    .filter((c) => c.direction === direction && (c.enabled || c.slug === current))
    .sort((a, b) => a.seq - b.seq)
    .map((c) => ({ slug: c.slug, name: c.name }));
  if (current && !list.some((o) => o.slug === current)) list.unshift({ slug: current, name: catName(cats, current, given) });
  return list;
}

// ── ③ 识图中 ────────────────────────────────────────────────────────────────
/** 占位气泡里替掉三点的那一行：旋转弧 + 「正在看图…」。 */
export function readingHtml(): string {
  return `<span style="display:inline-flex;align-items:center;gap:9px;">`
    + svg(ICON_SPIN_ARC, 14, 2.2, "var(--orange)", "animation:umbspin 1s linear infinite;")
    + `<span style="font-size:13px;color:var(--muted);white-space:nowrap;">${esc(t("chat.readingImage"))}</span></span>`;
}

// ── ④ 确认卡 ────────────────────────────────────────────────────────────────
const LABEL = "font-size:11px;font-weight:600;letter-spacing:.06em;white-space:nowrap;";
const INPUT = "border:none;background:transparent;color:var(--text);outline:none;font-family:inherit;padding:0;margin:0;min-width:0;";

function fieldLabel(text: string, unsure: boolean): string {
  return `<span style="${LABEL}color:${unsure ? "var(--warning)" : "var(--faint)"};">${esc(text)}${unsure ? ` · ${esc(t("chat.vcardUnsure"))}` : ""}</span>`;
}
// 35 高字段框；低置信那一项换 --warning 描边 + --warning-soft 底。
function boxStyle(unsure: boolean, fixedH: boolean): string {
  return `display:flex;align-items:center;gap:8px;${fixedH ? "height:35px;" : ""}padding:0 10px;border:1px solid ${unsure ? "var(--warning)" : "var(--border)"};border-radius:8px;background:${unsure ? "var(--warning-soft)" : "var(--bg)"};`;
}
function checkTail(): string {
  return `<span style="flex:none;font-size:11px;color:var(--warning);white-space:nowrap;">${esc(t("chat.vcardCheck"))}</span>`;
}
function fieldCol(label: string, box: string, flex = ""): string {
  return `<div style="${flex}min-width:0;display:flex;flex-direction:column;gap:5px;">${label}${box}</div>`;
}

/** A / B 两态的一行摘要：¥ 金额（650/17 等宽 tabular）+ 分类 · 商家 + 日期（等宽），12.5px --muted。 */
function staleSummary(b: VCardBlock, cats: MoneyCat[] | null): string {
  const f = b.fields;
  const mid = [catName(cats, f.cat, b.catName) + (f.sub ? ` · ${f.sub}` : ""), f.merchant].filter(Boolean).join(" · ");
  return `<div style="display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;font-size:12.5px;color:var(--muted);">`
    + `<span style="flex:none;font:650 17px ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;color:var(--text);white-space:nowrap;">¥${esc(f.yuan)}</span>`
    + (mid ? `<span style="flex:none;white-space:nowrap;">${esc(mid)}</span>` : "")
    + `<span style="flex:none;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;">${esc(fmtDate(f.at_ms))}</span>`
    + `</div>`;
}

/** 失效卡（稿 07 节）：A「这笔已经记好了 · 在别的设备上」/ B「这张卡失效了」+ 为什么。
 *  整卡 1px --border-soft、头图标块 --chip / --faint、摘要一行、出口一律次级钮。 */
function vcardStaleHtml(b: VCardBlock, i: number, cats: MoneyCat[] | null, sel: boolean): string {
  const elsewhere = b.state === "elsewhere";
  const halo = sel ? "box-shadow:0 0 0 2px var(--orange-soft);" : "";
  const haloAttr = sel ? ` data-halo="1"` : "";
  const ghost = btn("ghost", "sm");
  const head = `<span style="flex:none;width:22px;height:22px;border-radius:6px;background:var(--chip);color:var(--faint);display:flex;align-items:center;justify-content:center;">`
    + svg(elsewhere ? ICON_CHECK : ICON_CLOCK, 13, elsewhere ? 2.2 : 1.9) + `</span>`
    + `<span style="flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">`
    + esc(t(elsewhere ? "chat.vcardElsewhere" : "chat.vcardStale")) + `</span>`
    + (elsewhere ? `<span style="flex:none;font-size:11px;color:var(--faint);white-space:nowrap;">${esc(t("chat.vcardElsewhereWhere"))}</span>` : "");
  // B 态的第二句照实说：不知道结果就写「等了 20 秒没等到回执」；已知是别的端改成手动填的就直说
  //（稿 07：「服务端能区分就照实换一句，句式不变」）。
  const why = elsewhere ? ""
    : `<div style="font-size:12px;line-height:1.7;color:var(--muted);text-wrap:pretty;">${
      esc(t(b.staleWhy === "otherManual" ? "chat.vcardStaleWhyManual" : "chat.vcardStaleWhy"))}</div>`;
  const exits = elsewhere
    ? `<button data-vcseeentry="${i}" class="${ghost}">${esc(t("chat.vcardSeeEntry"))}</button>`
    : `<button data-vcseelist="${i}" class="${ghost}">${esc(t("chat.vcardSeeList"))}</button>`
      + `<button data-vcmanualnow="${i}" class="${ghost}">${esc(t("chat.vcardManualNow"))}</button>`;
  return `<div${haloAttr} data-vcard="${i}" style="align-self:flex-start;width:420px;max-width:100%;background:var(--card);border:1px solid var(--border-soft);border-radius:12px 12px 12px 4px;overflow:hidden;${halo}">`
    + `<div style="display:flex;align-items:center;gap:9px;padding:11px 13px;border-bottom:1px solid var(--border-soft);">${head}</div>`
    + `<div style="padding:12px 13px 13px;display:flex;flex-direction:column;gap:12px;">`
    + staleSummary(b, cats) + why
    + `<div style="display:flex;align-items:center;gap:9px;">${exits}</div>`
    + `</div></div>`;
}

export function vcardHtml(b: VCardBlock, i: number, cats: MoneyCat[] | null, sel: boolean): string {
  // A / B 失效两态是另一张卡（只读摘要 + 出口），不走下面这套四字段的排版。
  if (b.state === "elsewhere" || b.state === "stale") return vcardStaleHtml(b, i, cats, sel);
  const f = b.fields;
  const editable = b.state === "open";
  const dis = editable ? "" : " disabled";
  const unsure = (k: string) => b.state === "open" && b.unsure.includes(k);
  const halo = sel ? "box-shadow:0 0 0 2px var(--orange-soft);" : "";
  const haloAttr = sel ? ` data-halo="1"` : "";

  // 头：22 图标块 + 标题 + 右「确认后记入」。已处理态换成勾 +「已记入」/ 铅笔 +「已改成手动填」。
  let head: string;
  if (b.state === "approved") {
    head = `<span style="flex:none;width:22px;height:22px;border-radius:6px;background:var(--success-soft);color:var(--success);display:flex;align-items:center;justify-content:center;">${svg(ICON_CHECK, 13, 2.2)}</span>`
      + `<span style="flex:1;min-width:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(t("chat.vcardDone"))}</span>`;
  } else if (b.state === "manual") {
    head = `<span style="flex:none;width:22px;height:22px;border-radius:6px;background:var(--chip);color:var(--muted);display:flex;align-items:center;justify-content:center;">${svg(ICON_PENCIL, 13, 1.9)}</span>`
      + `<span style="flex:1;min-width:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(t("chat.vcardManualDone"))}</span>`;
  } else {
    head = `<span style="flex:none;width:22px;height:22px;border-radius:6px;background:var(--orange-soft);color:var(--orange-text);display:flex;align-items:center;justify-content:center;">${svg(ICON_MONEY, 13, 1.9)}</span>`
      + `<span style="flex:1;min-width:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(t(f.direction === "income" ? "chat.vcardTitleIncome" : "chat.vcardTitleExpense"))}</span>`
      + `<span style="flex:none;font-size:11px;color:var(--faint);white-space:nowrap;">${esc(t("chat.vcardConfirmHint"))}</span>`;
  }

  // 金额：¥ 12px --faint + 650/21 等宽 tabular，直接是 input。
  const uYuan = unsure("yuan");
  const amountBox = `<div style="display:flex;align-items:baseline;gap:6px;padding:6px 11px;border:1px solid ${uYuan ? "var(--warning)" : "var(--border)"};border-radius:8px;background:${uYuan ? "var(--warning-soft)" : "var(--bg)"};cursor:${editable ? "text" : "default"};">`
    + `<span style="flex:none;font-size:12px;color:var(--faint);">¥</span>`
    + (editable
      ? `<input data-vcyuan="${i}" value="${esc(f.yuan)}" inputmode="decimal" autocomplete="off" spellcheck="false" style="${INPUT}flex:1;width:100%;font:650 21px/1.2 ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;">`
      : `<span style="flex:1;min-width:0;font:650 21px/1.2 ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.yuan)}</span>`)
    + (uYuan ? checkTail() : "")
    + `</div>`;

  // 分类：22 分类色块 + 名称 + 下拉箭头。下拉是叠在框上的透明 <select>（原生弹层、自绘外观）。
  const uCat = unsure("cat");
  const cat = catOf(cats, f.cat);
  const slot = cat?.slot ?? 0;
  const opts = catOptions(cats, f.direction, f.cat, b.catName)
    .map((o) => `<option value="${esc(o.slug)}"${o.slug === f.cat ? " selected" : ""}>${esc(o.name)}</option>`).join("");
  const catBox = `<div style="position:relative;${boxStyle(uCat, true)}">`
    + `<span style="flex:none;width:22px;height:22px;border-radius:6px;background:${catTint(slot)};color:${catColor(slot)};display:flex;align-items:center;justify-content:center;">${svg(catIcon(f.cat, cat?.icon), 13, 1.9)}</span>`
    + `<span style="flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(catName(cats, f.cat, b.catName))}</span>`
    + (uCat ? checkTail() : "")
    + (editable
      ? svg(ICON_CHEVRON, 13, 2, "var(--faint)")
        + `<select data-vccat="${i}" title="${esc(t("money.thCat"))}" style="position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;">${opts}</select>`
      : "")
    + `</div>`;

  // 商家：文本 input；没看清时前置警示三角（稿画法）。
  const uMerch = unsure("merchant");
  const merchBox = `<div style="${boxStyle(uMerch, true)}">`
    + (uMerch ? svg(ICON_WARN_TRI, 14, 2, "var(--warning)") : "")
    + (editable
      ? `<input data-vcmerch="${i}" value="${esc(f.merchant)}" placeholder="${esc(t("money.notePh"))}" autocomplete="off" spellcheck="false" style="${INPUT}flex:1;width:100%;font-size:13px;">`
      : `<span style="flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${f.merchant ? "" : "color:var(--faint);"}">${esc(f.merchant || "—")}</span>`)
    + (uMerch ? checkTail() : "")
    + `</div>`;

  // 日期：日历图标 + 等宽 13px；可改时是原生 datetime-local（全站的原生日期件样式已在 index.css 收拾过）。
  const uAt = unsure("at_ms");
  const cal = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${uAt ? "var(--warning)" : "var(--faint)"}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><rect x="3.5" y="5" width="17" height="15.5" rx="3"></rect><path d="M3.5 10h17M8 3.5v3M16 3.5v3"></path></svg>`;
  const dateBox = `<div style="${boxStyle(uAt, true)}">${cal}`
    + (editable
      ? `<input data-vcdate="${i}" type="datetime-local" value="${esc(toDateTimeLocal(f.at_ms))}" style="${INPUT}flex:1;width:100%;font:13px ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;">`
      : `<span style="flex:1;min-width:0;font:13px ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;white-space:nowrap;">${esc(fmtDateTime(f.at_ms))}</span>`)
    + (uAt ? checkTail() : "")
    + `</div>`;

  // 底行：左「原图存进这笔的附件」+ 右「改成手动填」（描边 28）+「记入」（橙实心 28）。
  // waiting 只禁按钮不换文案 —— 服务端回 resolved 是几百毫秒的事，闪一下「记入中」反而像出了状况。
  // manual 没有底行：图没有跟着这张卡去任何地方，那句「原图存进这笔的附件」就不成立。
  let foot = "";
  if (b.state === "open" || b.state === "waiting") {
    foot = `<div style="display:flex;align-items:center;gap:9px;padding-top:3px;">`
      + `<span style="flex:1;min-width:0;font-size:11px;color:var(--faint);line-height:1.6;">${esc(t("chat.vcardKeepImg"))}</span>`
      + `<button data-vcmanual="${i}" class="${btn("ghost", "sm")}"${dis}>${esc(t("chat.vcardManual"))}</button>`
      + `<button data-vcrecord="${i}" class="${btn("primary", "sm")}"${dis}>${esc(t("chat.vcardRecord"))}</button>`
      + `</div>`;
  } else if (b.state === "approved") {
    foot = `<div style="display:flex;align-items:center;gap:9px;padding-top:3px;">`
      + `<span style="flex:1;min-width:0;font-size:11px;color:var(--faint);line-height:1.6;">${esc(t("chat.vcardKeepImg"))}</span></div>`;
  }

  // 卡：420 宽（窄窗口按消息区收）、圆角 12 12 12 4、--card + 1px --border。
  return `<div${haloAttr} data-vcard="${i}" style="align-self:flex-start;width:420px;max-width:100%;background:var(--card);border:1px solid var(--border);border-radius:12px 12px 12px 4px;overflow:hidden;${halo}">`
    + `<div style="display:flex;align-items:center;gap:9px;padding:11px 13px;border-bottom:1px solid var(--border-soft);">${head}</div>`
    + `<div style="padding:13px;display:flex;flex-direction:column;gap:9px;">`
    + `<div style="display:flex;align-items:flex-end;gap:10px;">`
    + fieldCol(fieldLabel(t("money.amount"), uYuan), amountBox, "flex:1;")
    + fieldCol(fieldLabel(t("money.thCat"), uCat), catBox, "flex:1;")
    + `</div>`
    + fieldCol(fieldLabel(t("chat.vcardMerchant"), uMerch), merchBox)
    + fieldCol(fieldLabel(t("chat.vcardDate"), uAt), dateBox)
    + foot
    + `</div></div>`;
}

/** 右键「复制摘要」/ 复制聊天 用的一行文字。 */
export function vcardSummary(b: VCardBlock, cats: MoneyCat[] | null): string {
  const f = b.fields;
  const head = b.state === "approved" ? t("chat.vcardDone")
    : b.state === "manual" ? t("chat.vcardManualDone")
    : b.state === "elsewhere" ? t("chat.vcardElsewhere")
    : b.state === "stale" ? t("chat.vcardStale")
    : t(f.direction === "income" ? "chat.vcardTitleIncome" : "chat.vcardTitleExpense");
  const parts = [`¥${f.yuan}`, catName(cats, f.cat, b.catName) + (f.sub ? ` · ${f.sub}` : ""), f.merchant, fmtDateTime(f.at_ms)].filter(Boolean);
  return `${head}：${parts.join(" · ")}`;
}

// ── ⑤ 识不出 ────────────────────────────────────────────────────────────────
export function vfailHtml(b: VFailBlock, i: number): string {
  const dis = b.busy ? " disabled" : "";
  return `<div data-vfail="${i}" style="align-self:flex-start;max-width:82%;width:100%;background:var(--danger-soft);border:1px solid var(--danger);border-radius:11px;padding:13px 14px;display:flex;flex-direction:column;gap:9px;">`
    + `<div style="display:flex;align-items:center;gap:8px;">${svg(ICON_ALERT_OCT, 15, 1.9, "var(--danger)")}`
    + `<span style="font-size:13px;font-weight:600;color:var(--danger);white-space:nowrap;">${esc(t("chat.visionFailTitle"))}</span></div>`
    + `<div style="font-size:12px;line-height:1.7;color:var(--text);white-space:pre-wrap;">${esc(b.reason || t("chat.visionFailBody"))}</div>`
    + `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">`
    + `<button data-vfmanual="${i}" class="${btn("primary", "sm")}"${dis}>${esc(t("chat.visionFailManual"))}</button>`
    + `<button data-vfretry="${i}" class="${btn("ghost", "sm")}"${dis}>${esc(b.busy ? t("chat.uploading") + "…" : t("chat.visionFailRetry"))}</button>`
    + `</div></div>`;
}
