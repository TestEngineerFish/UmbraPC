// PC 端样式工厂 —— 对应设计移交包里的 `UI` 工厂（designs/Umbra PC 端通用组件.dc.html §样式工厂）。
//
// 为什么要有这层：设计包的原话是「以前九个模块各写一份近似样式，现在改工厂就等于改全页」。
// 我们这边是同一个病 —— 九个 feature 里散着几十份「差不多但不一样」的按钮类名。
//
// 与设计稿的一处刻意偏离：设计稿的工厂返回**内联 style 字符串**，这里返回 **Tailwind 类名**。
// 理由是移交包 README §0 明说「在目标工程的既有环境里、用你们现有的写法重建」，而本工程
// 全量走 Tailwind + CSS 变量；返回 style 字符串会绕开 Tailwind 的主题映射，两套并存更糟。
// 取值一律照抄设计稿，没有近似。
//
// ⚠️ Tailwind JIT 只扫源码里的**字面量**。所以下面凡是带尺寸的档位（图标按钮的 26/24/22
// 之类）都必须把每一档写成完整的字面量字符串，**不能**用 `w-[${n}px]` 拼 —— 那样类名
// 生成不出来，运行时是没有宽度的裸按钮。

// ── 按钮 ────────────────────────────────────────────────────────────────────
// 设计稿取值：高 32（sm 28）· 圆角 7 · 横向内距 14（sm 11）· 字号 12.5（sm 12）。
// 五种角色对应设计稿的 ghost / primary / danger / dangerSolid / warn。
export type BtnKind = "ghost" | "primary" | "danger" | "dangerSolid" | "warn";
export type BtnSize = "sm" | undefined;

const BTN_BASE = "flex items-center flex-none whitespace-nowrap rounded-[7px] cursor-pointer transition-colors duration-[130ms] ease-out";
const BTN_SIZE: Record<"md" | "sm", string> = {
  md: "h-[32px] px-[14px] text-[12.5px]",
  sm: "h-[28px] px-[11px] text-[12px]",
};

// 禁用态是一条硬规则，设计稿原文：「禁用态一律 --chip 底 + --faint 字 + not-allowed，
// **不降透明度**」。降透明度会让禁用的红按钮变成一个浅红色的东西，看着像另一种状态。
// hover 也要一起掐掉，否则禁用按钮鼠标划过去还会变色。
const BTN_DISABLED =
  "disabled:bg-chip disabled:text-faint disabled:border-transparent disabled:cursor-not-allowed " +
  "disabled:hover:bg-chip disabled:hover:text-faint disabled:hover:border-transparent";

const BTN_KIND: Record<BtnKind, string> = {
  // 次要按钮 hover **只转描边与文字色，不改底色**（设计稿硬规则）。
  ghost: "bg-card border border-border text-text hover:border-orange hover:text-orange-text",
  // 主按钮字重是 560 不是 600 —— 设计包的字重档位只有 400/560/600/650。
  primary: "bg-orange text-white font-[560] hover:bg-orange-deep",
  // 破坏性操作用**描边红**；hover 只补一层软底，描边和字保持红。
  danger: "bg-transparent border border-danger text-danger hover:bg-danger-soft",
  // 实心红只允许出现在确认弹窗的最终动作上。设计稿那一处没有定义 hover，这里也不给。
  dangerSolid: "bg-danger text-white font-[560]",
  warn: "bg-transparent border border-warning text-warning hover:bg-warning-soft",
};

/** 普通按钮。kind 省略 = ghost；size 传 'sm' 得小一号。 */
export function btn(kind: BtnKind = "ghost", size?: BtnSize): string {
  return `${BTN_BASE} ${BTN_SIZE[size === "sm" ? "sm" : "md"]} ${BTN_KIND[kind]} ${BTN_DISABLED}`;
}

/** 按钮里要放图标时用这个：同 btn，外加居中 + gap 5。 */
export function btnRow(kind: BtnKind = "ghost", size?: BtnSize): string {
  return `${btn(kind, size)} justify-center gap-[5px]`;
}

/** 占满一行的按钮 —— 详情面板底部的主操作。居中、gap 6、上下 8px（不锁死高度）。 */
export function btnWide(kind: BtnKind = "ghost"): string {
  return `w-full flex items-center justify-center gap-[6px] whitespace-nowrap px-[14px] py-[8px] rounded-[7px] text-[12.5px] cursor-pointer transition-colors duration-[130ms] ease-out ${BTN_KIND[kind]} ${BTN_DISABLED}`;
}

// ── 图标按钮 ────────────────────────────────────────────────────────────────
// 设计稿：n ≥ 24 带描边（--muted 字），n ≤ 22 无描边（--faint 字）；用 26 / 24 / 22 三档。
// 三档全部写死成字面量，见文件头关于 JIT 的说明。
const ICON_BOX: Record<26 | 24 | 22, string> = {
  26: "w-[26px] h-[26px] border border-border text-muted",
  24: "w-[24px] h-[24px] border border-border text-muted",
  22: "w-[22px] h-[22px] border-none text-faint",
};
/** 方形图标按钮。只有 26 / 24 / 22 三档 —— 设计稿就这三档，别现调第四个。 */
export function icon(n: 26 | 24 | 22 = 26): string {
  return `${ICON_BOX[n]} flex-none flex items-center justify-center bg-transparent rounded-[7px] cursor-pointer transition-colors duration-[130ms] ease-out hover:border-orange hover:text-orange-text disabled:text-faint disabled:border-border disabled:cursor-not-allowed disabled:hover:text-faint disabled:hover:border-border`;
}

// ── 菜单行 ──────────────────────────────────────────────────────────────────
// 下拉与右键菜单里的一行。tone 省略是常规，'warn' 琥珀，'danger' 红。
// hover 底色按 tone 分：危险项用 --danger-soft，其余用 --chip。
export type MenuTone = "warn" | "danger";
const MENU_TONE: Record<"normal" | "warn" | "danger", string> = {
  normal: "text-text hover:bg-chip",
  warn: "text-warning hover:bg-chip",
  danger: "text-danger hover:bg-danger-soft",
};
export function menuRow(tone?: MenuTone): string {
  const k = tone === "danger" ? "danger" : tone === "warn" ? "warn" : "normal";
  return `w-full flex items-center gap-[9px] px-[10px] py-[6px] rounded-[6px] text-[12.5px] whitespace-nowrap text-left bg-transparent border-none cursor-pointer ${MENU_TONE[k]} disabled:text-faint disabled:cursor-not-allowed disabled:hover:bg-transparent`;
}

// ── 输入与选择 ──────────────────────────────────────────────────────────────
// 设计稿：高 32 · 圆角 7 · 内距 10 · 底 --bg（弹窗内传 card）。
// 聚焦态是**描边转橙 + 3px 橙软光环**，现有代码全线 outline-none 且没有聚焦态 —— 这次补上。
const FIELD_BASE =
  "min-w-0 h-[32px] px-[10px] rounded-[7px] border border-border text-text text-[12.5px] outline-none " +
  "transition-[border-color,box-shadow] duration-[130ms] ease-out " +
  "hover:border-orange focus:border-orange focus:shadow-[var(--focus-ring)] " +
  "disabled:bg-chip disabled:text-faint disabled:cursor-not-allowed";

/** 文本输入框。bg 默认 --bg；弹窗内的输入框传 'card'（弹窗自身就是 card 底，再套一层会糊）。 */
export function field(bg: "bg" | "card" = "bg", size?: BtnSize): string {
  const b = bg === "card" ? "bg-card" : "bg-bg";
  const s = size === "sm" ? "h-[28px] text-[12px]" : "";
  return `${FIELD_BASE} ${b} ${s}`;
}

/** 多行输入框：与 field 同一套描边 / 聚焦态，但**不钉高度**（高度由内容或 rows 决定）。
 *  单独一个工厂而不是 `field() + h-auto`：h-[32px] 与 h-auto 同属性，靠 className 顺序覆盖不可靠。 */
export function textarea(bg: "bg" | "card" = "bg"): string {
  const b = bg === "card" ? "bg-card" : "bg-bg";
  return `${FIELD_BASE.replace("h-[32px] ", "")} ${b} py-[6px] leading-[20px] block resize-y`;
}

/** 占满剩余宽度的输入框（表单行右半区）。min-w-0 不能省：不加的话内容一长就把整行撑破。 */
export function fieldFlex(bg: "bg" | "card" = "bg", size?: BtnSize): string {
  return `flex-1 ${field(bg, size)}`;
}

/** 下拉框。flex-none + nowrap 是防中文选项把行挤断。 */
export function select(size?: BtnSize): string {
  const s = size === "sm" ? "h-[28px] text-[12px]" : "h-[32px] text-[12.5px]";
  return `flex-none whitespace-nowrap ${s} px-[10px] rounded-[7px] border border-border bg-bg text-text outline-none cursor-pointer transition-colors duration-[130ms] ease-out hover:border-orange focus:border-orange disabled:bg-chip disabled:text-faint disabled:cursor-not-allowed`;
}

/** 等宽输入 —— 路径、密钥、快捷键、JSON。这几类要对齐着看，比例字体会读错。 */
export function mono(opts?: { bg?: "bg" | "card"; size?: BtnSize }): string {
  return `${field(opts?.bg ?? "bg", opts?.size)} font-mono`;
}

// ── 胶囊 ────────────────────────────────────────────────────────────────────
/** 灰底胶囊，放计数与次要标签。 */
export function chip(): string {
  return "inline-flex items-center flex-none whitespace-nowrap px-[8px] h-[20px] rounded-full bg-chip text-muted text-[11px]";
}

// 筛选标签（可选中的胶囊）。和上面的 chip() 是两个东西：chip 是只读标记，这个是可点的筛选器。
//
// ⚠️ 皮肤取值有过一次翻案，记在这里免得下次又改回去。移交包里有两种说法：
//   A（通用组件稿 1211-1213）：高 26 · 内距 0 12 · 12px · 选中 = **橙实底白字 560**
//   B（任务稿 6890-6895 / 日志稿 7738-7742）：内距 4/9 或 4/11 · 选中 = **橙软底橙字 600**
// sam 拍板取 B（决策 D11）。理由侧证：两个真实模块页画的都是 B，通用组件页那份是孤例。
//
// 尺寸两档，也是照两个模块页来的 —— 皮肤一样，只有内距和字号不同：
//   sm  = 任务档：4/9 · 11.5px（这一档后面通常还跟一个计数 span）
//   默认 = 日志档：4/11 · 12px
// 未选中底色取 transparent（B 的两处都是 transparent；A 那份是 --card，一并跟着 B 走）。
export function filterChip(on: boolean, size?: BtnSize): string {
  const s = size === "sm" ? "px-[9px] py-[4px] text-[11.5px] gap-[5px]" : "px-[11px] py-[4px] text-[12px]";
  const skin = on
    ? "border-orange bg-orange-soft text-orange-text font-semibold"
    // hover 只转描边，不转底色 —— 跟 btn 的次要按钮同一条规则。
    : "border-border bg-transparent text-muted hover:border-orange";
  return `flex items-center flex-none whitespace-nowrap rounded-full border cursor-pointer transition-colors duration-[130ms] ease-out ${s} ${skin}`;
}

/** 筛选胶囊里的计数。选中时跟着转橙，未选中是 --faint。 */
export function filterChipCount(on: boolean): string {
  return `text-[10.5px] font-semibold ${on ? "text-orange-text" : "text-faint"}`;
}

// ── 字段标签 ────────────────────────────────────────────────────────────────
/** 表单字段标签：11px / 600 / .06em 字距 / --faint。全项目统一，别再各写各的。 */
export const fieldLabel = "text-[11px] font-semibold tracking-[.06em] text-faint";

// ── 兼容别名 ────────────────────────────────────────────────────────────────
// 旧代码里散落的这四个常量继续可用，但都改成工厂产物 —— 换句话说，
// 它们的视觉从这一版起和设计稿一致了（高 32、圆角 7、禁用态不再降透明度）。
// 新代码请直接用 btn()/icon()。
export const btnGhost = btn("ghost");
export const btnPrimary = btn("primary");
export const btnDanger = btn("danger");
export const btnDangerSolid = btn("dangerSolid");
export const btnIcon = icon(26);
