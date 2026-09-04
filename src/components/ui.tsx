// 各页共用的基础控件：卡片 / 标签行 / 开关 / 输入框类名 / 快捷键采集 / 刷新按钮 / 弹窗。
// 抽出来是因为「工具」模块从设置页拆分后，两边需要完全一致的视觉与交互；
// 刷新按钮与弹窗则是任务 / 工作区 / 灵感三个列表页反复用到的同一套东西。
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconRefresh, IconX } from "./icons";
import { btn, icon as iconBtn, field, fieldFlex, mono, menuRow, select as selectCls } from "./kit";
import type { MenuTone } from "./kit";

// 样式一律从 kit 工厂取（对应设计移交包的 `UI` 工厂）。这里只做转发，
// 别在本文件里再写第二份近似样式 —— 那正是工厂要消灭的东西。
export * from "./kit";

// 开关按钮。设计稿取值：轨 36×21、滑块 16、左位 2.5 / 17.5、130ms 缓动，关时轨用 --track。
// 之前是 38×22 + 18 滑块 + bg-border，跟设计稿差一档，也和 iOS 那边对不上。
export function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`w-[36px] h-[21px] flex-none rounded-full relative border-none cursor-pointer transition-colors duration-[130ms] ease-out ${on ? "bg-orange" : "bg-track"}`}>
      <span className={`absolute top-[2.5px] w-[16px] h-[16px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.18)] transition-[left] duration-[130ms] ease-out ${on ? "left-[17.5px]" : "left-[2.5px]"}`} />
    </button>
  );
}

// 输入框类名。全部转成工厂产物，取值随之对齐设计稿（高 32 / 圆角 7 / 聚焦转橙 + 3px 光环）。
// 之前这几个是 py-[7px] + 圆角 8 + outline-none，**根本没有聚焦态**。
export const inputFlex = fieldFlex("bg");
export const inputHotkey = `flex-1 ${mono({ bg: "bg" })}`;
export const inputSmall = `w-[132px] flex-none ${field("card")}`;
export const selectBox = selectCls();

// 一张设置卡：12px 圆角 + 1px 描边，内部逐行铺 SettingRow（行间发丝线由行自己画）。
// 上下内边距不对称是因为第一行/最后一行本身带 13px 的行内边距。
export function RowsCard({ children }: { children: React.ReactNode }) {
  return <section className="bg-card border border-border rounded-[12px] p-[4px_16px_8px]">{children}</section>;
}

// 卡内一行：左侧定宽中文标签 + 中间说明/控件 + 右侧操作，行间 --border-soft 发丝线，最后一行不画线。
// 标签必须 flex-none + whitespace-nowrap，否则「开启历史记录」这类标签会被压成两行。
export function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-[14px] py-[13px] border-b border-border-soft last:border-b-0">
      <div className="w-[120px] flex-none whitespace-nowrap text-[13px]">{label}</div>
      {children}
    </div>
  );
}

// 行内的灰色说明文字（占满标签与右侧操作之间的空档）。
// children 可省：没有说明文字时它就只当撑开的空档用，把右侧的控件顶到行尾。
export function RowHint({ children }: { children?: React.ReactNode }) {
  return <div className="flex-1 min-w-0 text-[12.5px] text-muted">{children}</div>;
}

// 自带标题的卡：hint 跟在标题后面（同一行）或另起一行，取决于 stack。
export function Panel({ title, hint, stack, children }: { title?: string; hint?: string; stack?: boolean; children: React.ReactNode }) {
  return (
    <section className="bg-card border border-border rounded-[12px] p-[16px]">
      {title ? (
        stack ? (
          <>
            <div className="text-[13px] font-semibold mb-[4px]">{title}</div>
            {hint ? <div className="text-[11.5px] text-faint mb-[13px]">{hint}</div> : null}
          </>
        ) : (
          <div className="flex items-baseline gap-[8px] mb-[12px]">
            <span className="text-[13px] font-semibold flex-none whitespace-nowrap">{title}</span>
            {hint ? <span className="text-[11.5px] text-faint">{hint}</span> : null}
          </div>
        )
      ) : null}
      {children}
    </section>
  );
}

// 状态徽章。配色固定：绿=已完成/已授予/在线，橙=执行中/待授权，红=失败/危险，灰=待执行/未安装，橙软=计数与关键词。
export type PillTone = "success" | "warning" | "danger" | "neutral" | "accent";
export function Pill({ tone = "neutral", dot, mono, children }: { tone?: PillTone; dot?: boolean; mono?: boolean; children: React.ReactNode }) {
  const skin: Record<PillTone, string> = {
    success: "bg-success-soft text-success font-semibold",
    warning: "bg-warning-soft text-warning font-semibold",
    danger: "bg-danger-soft text-danger font-semibold",
    accent: "bg-orange-soft text-orange-text",
    neutral: "bg-chip text-muted",
  };
  const dotSkin: Record<PillTone, string> = {
    success: "bg-success", warning: "bg-warning", danger: "bg-danger", accent: "bg-orange", neutral: "bg-muted",
  };
  return (
    <span className={`inline-flex items-center gap-[5px] flex-none whitespace-nowrap px-[8px] py-[1px] rounded-full text-[11px] ${skin[tone]} ${mono ? "font-mono" : ""}`}>
      {dot ? <span className={`w-[6px] h-[6px] rounded-full flex-none ${dotSkin[tone]}`} /> : null}
      {children}
    </span>
  );
}

// 分段选择器（连体单选按钮）：设置页的权限档位、编码权限档位都是这个形状。
// 两处注意：① 分隔线只能加在「除最后一项」上，border-r 和无 border-r 属同类工具类、
// 靠 className 顺序覆盖不了；② 中文档位名一律 flex-none + nowrap，否则「直接执行」会被压断。
// tone 决定选中态的底色：accent=橙（正向档位），danger=红（拒绝这类），neutral=卡片底（默认档位）。
export function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: { v: T; label: string; tone?: "accent" | "danger" | "neutral" }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex-none flex border border-border rounded-[8px] overflow-hidden">
      {options.map((o, i) => {
        const on = value === o.v;
        const skin = !on ? "bg-transparent text-text hover:bg-hover"
          : o.tone === "danger" ? "bg-danger text-white font-semibold"
          : o.tone === "neutral" ? "bg-chip text-text font-semibold"
          : "bg-orange text-white font-semibold";
        return (
          <button key={o.v} onClick={() => onChange(o.v)}
            className={`flex-none whitespace-nowrap px-[12px] py-[6px] text-[12.5px] cursor-pointer ${i < options.length - 1 ? "border-r border-border" : ""} ${skin}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// toAccelerator 搬到了 components/hotkey.ts（连同显示与录制 hook）。
// 原来这份用 e.key 取主键：Mac 上 Option 会改字符，Option+Shift+V 录出来是「◊」、
// Option+Shift+Space 录出来是个看不见的空格，存进去主进程一律判「键位写法不对」。
// 别在这里再加一份，录制一律用 components/HotkeyRecorder 的 useHotkeyRecorder。

// ── 刷新按钮 ────────────────────────────────────────────────────────────────
// 纯图标的刷新按钮，任务 / 工作区 / 灵感三处共用。
// 关键在 minMs：本地服务端一次列表请求常常只要十几毫秒，光看 loading 标志位，
// 图标还没转起来就已经复位，用户会以为按钮没反应。所以这里给自旋一个最短时长，
// 请求早早回来也要把这一圈转完。
// spinning 给已经有外部刷新态的页面用（任务 / 灵感走 shell 轮询，态在 shell 里）。
export function RefreshButton({ onClick, spinning, minMs = 550, title }: {
  onClick: () => void | Promise<unknown>;
  spinning?: boolean;
  minMs?: number;
  title?: string;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const on = busy || !!spinning;
  const run = async () => {
    if (on) return;
    setBusy(true);
    const started = Date.now();
    try {
      await onClick();
    } finally {
      const rest = minMs - (Date.now() - started);
      if (rest > 0) await new Promise((r) => setTimeout(r, rest));
      if (alive.current) setBusy(false);
    }
  };

  return (
    <button className={iconBtn(26)}
      title={title || t("common.refresh")} onClick={() => void run()}>
      <span className={`flex ${on ? "animate-spin" : ""}`}><IconRefresh size={13} /></span>
    </button>
  );
}

// ── 弹窗 ────────────────────────────────────────────────────────────────────
// 遮罩 + 居中卡片。标题栏与底栏都是可选的：不传 title 就没有标题栏（确认框那种），
// 不传 footer 就没有底栏。点遮罩关闭，点卡片内部不关闭。
// 用 fixed 而不是 absolute：页面根节点不一定是定位元素，absolute 会往上找到不确定的祖先。
// 宽度三档（批次 012 tokens.modal，全站唯一一组取值）：480 单字段 / 二次确认 · 560 表单（1–2 列）·
// 680 带列表或并排双栏。默认 480。原来的 460 / 720 与各页私调的 400 / 430 / 470 / 500 / 520 / 620 全部归档。
export function Modal({ width = 480, title, sub, children, footer, onClose }: {
  width?: number;
  title?: React.ReactNode;
  sub?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // Esc 关弹窗，并且**拦下这次按键**（capture + preventDefault）：功能内设置视图也在听 Esc（PageShell），
  // 不拦的话弹窗和它底下的设置视图会一起关掉，填了一半的东西就没了。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 bg-[rgba(20,16,12,.42)] flex items-center justify-center p-[24px]"
      // 标题栏 40px 拖拽区吃鼠标事件不看 z-index（同 ImageViewer 的注释）。高弹窗（max-h-full，
      // 外边距只有 24px）的标题行会探进 0–40px，右上角关闭钮的上半截就点不动了 —— 整块浮层
      // 声明 no-drag，把自己从拖拽区里抠出来。
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      onMouseDown={onClose}>
      <div className="bg-card border border-border rounded-[12px] shadow-[shadow:var(--shadow-modal)] overflow-hidden flex flex-col max-w-full max-h-full"
        style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        {title ? (
          <div className="flex-none flex items-center gap-[9px] px-[16px] py-[12px] border-b border-border">
            <span className="flex-1 min-w-0 truncate text-[13.5px] font-semibold">{title}</span>
            {sub ? <span className="flex-none text-[11.5px] text-faint whitespace-nowrap">{sub}</span> : null}
            {/* 标题右侧只放关闭图标，不放第二个动作（设计稿硬规则）。
                关闭用 22 档无描边图标钮：带描边的方按钮会和标题抢注意力。 */}
            <button className={iconBtn(22)} title={t("common.close")} onClick={onClose}><IconX size={14} /></button>
          </div>
        ) : null}
        <div className="flex-1 min-h-0 overflow-y-auto px-[16px] py-[15px] flex flex-col gap-[13px]">{children}</div>
        {footer ? (
          <div className="flex-none flex items-center gap-[9px] px-[16px] py-[12px] border-t border-border-soft bg-rail">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

// 确认框：一句话 + 取消 / 确认。danger 时确认按钮是实心红（不可逆操作才用）。
// children 用来塞额外选项（比如工作区移除时的「是否连文件一起删」单选）。
export function ConfirmDialog({ title, message, confirmText, danger, busy, onConfirm, onCancel, children }: {
  title?: string;
  message: React.ReactNode;
  confirmText: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Modal width={480} title={title} onClose={onCancel} footer={<>
      <span className="flex-1" />
      <button className={btn("ghost")} onClick={onCancel}>{t("common.cancel")}</button>
      {/* 实心红只出现在这里 —— 确认弹窗里的最终动作。别处的破坏性操作一律描边红。 */}
      <button className={btn(danger ? "dangerSolid" : "primary")} disabled={busy} onClick={onConfirm}>{confirmText}</button>
    </>}>
      <div className="text-[12.5px] leading-[1.7]">{message}</div>
      {children}
    </Modal>
  );
}

// ── 右键菜单 ────────────────────────────────────────────────────────────────
// 贴着光标弹出的小菜单（列表行的删除等破坏性操作放这里，不必在每行常驻一个按钮）。
// 自己夹在视口内：贴着右边/下边弹时翻到另一侧，免得菜单被窗口边裁掉。
// 设计稿硬规则：**右键菜单分三组：状态类、编辑类、破坏性。删除永远单独一组、放最后，
// 红色只出现在这一项和确认弹窗里。** 分组靠 divider 行，别靠留白。
export interface MenuAction {
  label?: string;
  onClick?: () => void;
  danger?: boolean;          // 破坏性操作，标红（等价于 tone:"danger"，旧调用点保留）
  tone?: "warn" | "danger";
  divider?: boolean;         // 一条分隔线，不是可点行
  group?: string;            // 组标题（11px 字距标签），不是可点行
  icon?: React.ReactNode;    // 13px 线性图标
  hint?: string;             // 右侧的快捷键提示，等宽
  disabled?: boolean;
}
const MENU_W = 168;
export function ContextMenu({ x, y, items, onClose }: {
  x: number; y: number; items: MenuAction[]; onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  // 点菜单外面 / 按 Esc / 滚动都收起。用 capture 是为了先于页面自身的点击处理跑到，
  // 但**必须把菜单内部排掉**：否则按在菜单项上时菜单先被卸载，click 压根不会发生
  // （表现就是「点删除没反应」）。在 mousedown 阶段用 contains 判，比 stopPropagation 可靠——
  // 后者只挡冒泡，挡不住已经在捕获阶段跑过的 window 监听。
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    const close = () => onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  // 距窗口边至少 8px（设计稿）。
  const left = x + MENU_W + 8 <= window.innerWidth ? x : Math.max(8, x - MENU_W);
  const top = Math.min(y, Math.max(8, window.innerHeight - 12 - items.length * 30));
  // 4px 内边距 + 行自带 6px 圆角：悬停底是一块**内缩的圆角**，不铺满到边框。
  // 这和之前「不留内边距、高亮铺满」是相反的做法，按设计稿改。
  return (
    <div ref={boxRef} className="fixed z-50 bg-card border border-border rounded-[9px] shadow-[shadow:var(--shadow-floating)] p-[4px]"
      style={{ left, top, width: MENU_W }}>
      {items.map((it, i) => {
        if (it.divider) return <div key={i} className="h-[1px] bg-border-soft my-[4px] mx-[6px]" />;
        if (it.group) return <div key={i} className="px-[10px] pt-[5px] pb-[3px] text-[10.5px] font-semibold tracking-[.06em] text-faint whitespace-nowrap">{it.group}</div>;
        const tone: MenuTone | undefined = it.tone ?? (it.danger ? "danger" : undefined);
        return (
          <button key={i} disabled={it.disabled}
            onClick={() => { if (it.disabled) return; onClose(); it.onClick?.(); }}
            className={menuRow(tone)}>
            {it.icon ? <span className="flex-none flex">{it.icon}</span> : null}
            <span className="flex-1 min-w-0 whitespace-nowrap">{it.label}</span>
            {it.hint ? <span className="flex-none font-mono text-[10.5px] text-faint whitespace-nowrap">{it.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

// ── 状态胶囊 ────────────────────────────────────────────────────────────────
// 设计稿硬规则：**状态永不只靠颜色表意，必须图标 + 文字**，且五个状态的图标是固定映射：
//   运行中 = 旋转弧 · 已完成 = 对勾 · 需确认 = 三角感叹 · 失败 = 圆叉 · 排队中 = 时钟
// 图标写在这里而不是 icons.tsx：设计稿给这五个的描边是 2.2 / 2.2 / 2 / 2 / 2，
// 和 icons.tsx 统一的 1.8 不同，混进去会让那边的「统一描边」变成一句空话。
export type StatusKind = "running" | "done" | "confirm" | "failed" | "queued";

const STATUS_SKIN: Record<StatusKind, string> = {
  running: "bg-orange-soft text-orange-text",
  done: "bg-success-soft text-success",
  confirm: "bg-warning-soft text-warning",
  failed: "bg-danger-soft text-danger",
  queued: "bg-chip text-muted",
};

function StatusIcon({ kind }: { kind: StatusKind }) {
  const p = { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className: "flex-none" };
  switch (kind) {
    // Tailwind 的 animate-spin 正好是 1s linear infinite，与设计稿的 umspin 一致。
    case "running": return <svg {...p} strokeWidth={2.2} className="flex-none animate-spin"><path d="M12 3a9 9 0 0 1 9 9" /></svg>;
    case "done": return <svg {...p} strokeWidth={2.2}><path d="M4 12.5l5 5L20 6.5" /></svg>;
    case "confirm": return <svg {...p} strokeWidth={2}><path d="M12 4l9 16H3z" /><path d="M12 10v4" /><path d="M12 17v.01" /></svg>;
    case "failed": return <svg {...p} strokeWidth={2}><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6" /><path d="M9 9l6 6" /></svg>;
    case "queued": return <svg {...p} strokeWidth={2}><circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 2" /></svg>;
  }
}

/** 状态胶囊。图标是固定映射，调用方只给 kind 和文字 —— 别自己换图标。 */
export function StatusPill({ kind, children }: { kind: StatusKind; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-[6px] flex-none whitespace-nowrap h-[24px] px-[10px] rounded-full text-[11.5px] ${STATUS_SKIN[kind]}`}>
      <StatusIcon kind={kind} />
      {children}
    </span>
  );
}

/** 状态点（列表行用）。只有点没有字的场合，务必另外给文字或 title。 */
export function StatusDot({ tone }: { tone: "success" | "faint" | "danger" }) {
  const c = tone === "success" ? "bg-success" : tone === "danger" ? "bg-danger" : "bg-faint";
  return <span className={`w-[7px] h-[7px] flex-none rounded-full ${c}`} />;
}

/** 进度条。done 时填充转成功色并铺满 —— 完成态不显示百分比（设计稿）。 */
export function ProgressBar({ pct, done }: { pct: number; done?: boolean }) {
  return (
    <span className="block h-[4px] rounded-full bg-track overflow-hidden">
      <span className={`block h-full rounded-full ${done ? "bg-success" : "bg-orange"}`} style={{ width: `${done ? 100 : Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  );
}

// ── 空态 ────────────────────────────────────────────────────────────────────
// 对应设计包的「PC 空态」。三种 kind 只改图标底色与标题色，结构完全一样。
export type EmptyKind = "empty" | "error" | "offline";
const EMPTY_SKIN: Record<EmptyKind, { box: string; title: string }> = {
  empty: { box: "bg-chip text-muted", title: "text-text" },
  error: { box: "bg-danger-soft text-danger", title: "text-danger" },
  offline: { box: "bg-warning-soft text-warning", title: "text-text" },
};
const EMPTY_PATH: Record<EmptyKind, string[]> = {
  empty: ["M4 7h16v13H4z", "M4 7l2-3h12l2 3", "M9 12h6"],
  error: ["M12 8v4", "M12 16v.01", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"],
  offline: ["M3 3l18 18", "M8.5 16.4a5 5 0 0 1 7 0", "M5 12.9a10 10 0 0 1 4-2.6", "M12 20h.01"],
};

export function EmptyState({ kind = "empty", title, body, hint, compact, icon, actionLabel, onAction, secondaryLabel, onSecondary }: {
  kind?: EmptyKind;
  title: string;
  body?: string;
  hint?: string;
  compact?: boolean;
  icon?: string;           // 单条 path，覆盖 kind 的默认图标
  actionLabel?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  const skin = EMPTY_SKIN[kind];
  const paths = icon ? [icon] : EMPTY_PATH[kind];
  const n = compact ? "w-[40px] h-[40px] rounded-[12px]" : "w-[52px] h-[52px] rounded-[14px]";
  const s = compact ? 18 : 24;
  return (
    <div className={`flex-1 min-h-0 flex flex-col items-center justify-center text-center ${compact ? "gap-[9px] p-[30px_18px]" : "gap-[11px] p-[0_18px]"}`}>
      <span className={`${n} ${skin.box} flex-none flex items-center justify-center`}>
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          {paths.map((d, i) => <path key={i} d={d} />)}
        </svg>
      </span>
      <span className={`${compact ? "text-[13.5px]" : "text-[14px]"} font-semibold ${skin.title}`}>{title}</span>
      {body ? <span className="text-[12.5px] text-muted max-w-[360px] leading-[1.7]">{body}</span> : null}
      {hint ? <span className="text-[11.5px] text-faint max-w-[340px] leading-[1.65]">{hint}</span> : null}
      {actionLabel || secondaryLabel ? (
        <span className="flex gap-[9px] mt-[3px] flex-wrap justify-center">
          {actionLabel ? <button className={btn("primary")} onClick={onAction}>{actionLabel}</button> : null}
          {secondaryLabel ? <button className={btn("ghost")} onClick={onSecondary}>{secondaryLabel}</button> : null}
        </span>
      ) : null}
    </div>
  );
}

// ── 错误卡 ──────────────────────────────────────────────────────────────────
// 对应设计包的「PC 错误卡」。硬规则：**三段式 —— 发生了什么 → 为什么 → 现在能做什么，
// 第三段必须是可点按钮**。三种形态：strip（行内条）/ card（带明细的卡）/ banner（贴顶边）。
export interface ErrAction { label: string; kind?: "primary" | "danger" | "ghost"; onClick?: () => void }
export function ErrorCard({ kind = "danger", variant = "strip", title, reason, meta, raw, actions }: {
  kind?: "danger" | "warning";
  variant?: "strip" | "card" | "banner";
  title: string;
  reason?: string;
  meta?: { label: string; value: string }[];
  raw?: string;
  actions?: ErrAction[];
}) {
  const isCard = variant === "card";
  const tone = kind === "warning" ? "text-warning" : "text-danger";
  const bd = kind === "warning" ? "border-warning" : "border-danger";
  const soft = kind === "warning" ? "bg-warning-soft" : "bg-danger-soft";
  const path = kind === "warning"
    ? ["M12 4l9 16H3z", "M12 10v4", "M12 17v.01"]
    : ["M12 8v4", "M12 16v.01", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"];
  const Ico = (
    <svg width={isCard ? 14 : 15} height={isCard ? 14 : 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round"
      className={`flex-none ${tone} ${reason && !isCard ? "mt-[1px]" : ""}`}>
      {path.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
  const actionRow = actions?.length ? (
    <span className={`flex gap-[8px] flex-wrap ${isCard ? "" : "flex-none items-center"}`}>
      {actions.map((a, i) => (
        <button key={i} onClick={a.onClick}
          className={`flex-none whitespace-nowrap rounded-[7px] cursor-pointer ${isCard ? "px-[13px] py-[6px] text-[12px]" : "px-[11px] py-[4px] text-[11.5px]"} ${
            a.kind === "primary" ? "bg-orange text-white border-none font-semibold"
            : a.kind === "ghost" ? "bg-transparent border border-border text-text"
            : `bg-transparent border ${bd} ${tone} font-semibold`}`}>
          {a.label}
        </button>
      ))}
    </span>
  ) : null;

  // banner 贴弹窗或面板顶边：无圆角、只有下边框（设计稿硬规则）。
  const shell = isCard
    ? `bg-card border ${bd} rounded-[11px] overflow-hidden`
    : variant === "banner"
      ? `flex-none ${soft} border-b ${bd} px-[16px] py-[9px] flex gap-[9px] ${reason ? "items-start" : "items-center"}`
      : `${soft} border ${bd} rounded-[9px] px-[13px] py-[11px] flex gap-[9px] ${reason ? "items-start" : "items-center"}`;

  return (
    <div className={shell}>
      <div className={isCard ? `flex items-center gap-[9px] px-[13px] py-[10px] ${soft}` : `flex gap-[9px] flex-1 min-w-0 ${reason ? "items-start" : "items-center"}`}>
        {Ico}
        <div className="flex-1 min-w-0 flex flex-col gap-[4px]">
          <span className={`text-[12.5px] font-semibold ${tone} ${isCard ? "truncate" : "leading-[1.65]"}`}>{title}</span>
          {reason && !isCard ? <span className={`text-[11.5px] ${tone} leading-[1.65]`}>{reason}</span> : null}
        </div>
        {!isCard ? actionRow : null}
      </div>
      {isCard ? (
        <div className="px-[14px] py-[12px] flex flex-col gap-[9px]">
          {meta?.length ? (
            <div className="flex gap-[14px] flex-wrap">
              {meta.map((m, i) => (
                <span key={i} className="text-[11.5px] text-muted whitespace-nowrap">
                  {m.label} <span className="text-text font-mono">{m.value}</span>
                </span>
              ))}
            </div>
          ) : null}
          {reason ? <span className="text-[12.5px] leading-[1.7]">{reason}</span> : null}
          {raw ? <pre className="m-0 text-[11px] text-faint font-mono bg-track rounded-[7px] px-[10px] py-[8px] break-all whitespace-pre-wrap">{raw}</pre> : null}
          {actionRow}
        </div>
      ) : null}
    </div>
  );
}

// ── 吐司 ────────────────────────────────────────────────────────────────────
// 对应设计包的「PC 吐司」。**这是 PC 端唯一硬编码深色的面** —— 它浮在任何界面之上，
// 跟随主题反而会在浅色下变成一块白底白字的东西。所以这里不用主题变量。
export type ToastTone = "" | "ok" | "warn" | "fail";
const TOAST_PATH: Record<Exclude<ToastTone, "">, string[]> = {
  ok: ["M5 13l4.5 4.5L19 7"],
  warn: ["M12 4l9 16H3z", "M12 10v4", "M12 17v.01"],
  fail: ["M12 8v4", "M12 16v.01", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"],
};
const TOAST_COLOR: Record<Exclude<ToastTone, "">, string> = {
  ok: "var(--success)", warn: "var(--warning)", fail: "var(--danger)",
};

export function Toast({ text, tone = "", actionLabel, onAction, place = "right" }: {
  text: string;
  tone?: ToastTone;
  actionLabel?: string;
  onAction?: () => void;
  place?: "right" | "center";
}) {
  return (
    <div className={`fixed z-[60] flex items-center gap-[10px] px-[12px] py-[9px] rounded-full bg-[rgba(21,17,14,.86)] backdrop-blur-[12px] shadow-[0_10px_30px_rgba(0,0,0,.24)] ${
      place === "center" ? "left-1/2 -translate-x-1/2 bottom-[26px]" : "right-[18px] bottom-[18px]"}`}>
      {tone ? (
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={TOAST_COLOR[tone]} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" className="flex-none">
          {TOAST_PATH[tone].map((d, i) => <path key={i} d={d} />)}
        </svg>
      ) : null}
      <span className="flex-none text-[12.5px] text-[#F4F1EA] whitespace-nowrap">{text}</span>
      {actionLabel ? (
        <button onClick={onAction}
          className="flex-none h-[24px] px-[10px] rounded-full border border-[rgba(255,255,255,.28)] bg-transparent text-[#F4F1EA] text-[11.5px] font-semibold cursor-pointer whitespace-nowrap hover:border-[rgba(255,255,255,.55)]">
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
