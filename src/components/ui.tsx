// 各页共用的基础控件：卡片 / 标签行 / 开关 / 输入框类名 / 快捷键采集 / 刷新按钮 / 弹窗。
// 抽出来是因为「工具」模块从设置页拆分后，两边需要完全一致的视觉与交互；
// 刷新按钮与弹窗则是任务 / 工作区 / 灵感三个列表页反复用到的同一套东西。
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconRefresh, IconX } from "./icons";

// 开关按钮：on 时滑块靠右并变橙色。
export function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`w-[38px] h-[22px] rounded-full p-[2px] flex shrink-0 transition-colors ${on ? "justify-end bg-orange" : "justify-start bg-border"}`}>
      <span className="w-[18px] h-[18px] rounded-full bg-white shadow" />
    </button>
  );
}

// 以下三个按钮类名统一带 flex-none + whitespace-nowrap：中文按钮文字只有三四个字时，
// 在 flex 行里默认可收缩，宽度刚好等于内容就会从中间断成两行。
// 通用次要按钮类名（悬停转橙描边）。
export const btnGhost = "flex-none whitespace-nowrap px-[13px] py-[6px] border border-border bg-transparent text-text rounded-[8px] text-[12.5px] cursor-pointer hover:border-orange hover:text-orange-text";
// 通用主按钮类名（禁用时压暗并禁掉悬停色，配合 disabled 属性使用）。
export const btnPrimary = "flex-none whitespace-nowrap px-[15px] py-[7px] bg-orange text-white rounded-[8px] text-[12.5px] font-semibold cursor-pointer hover:bg-orange-deep disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:bg-orange";
// 危险操作按钮：平时红描边透明底，悬停才填成红底白字（实心红只留给确认弹窗里的最终按钮）。
export const btnDanger = "flex-none whitespace-nowrap px-[13px] py-[6px] border border-danger text-danger bg-transparent rounded-[8px] text-[12.5px] font-semibold cursor-pointer hover:bg-danger hover:text-white";
// 纯图标的小方按钮（删除、调序这类），26×26。
export const btnIcon = "w-[26px] h-[26px] flex-none flex items-center justify-center border border-border bg-transparent text-muted rounded-[7px] cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed";

// 占满剩余宽度的输入框（表单行右半区用）。min-w-0 是必须的：不加的话内容一长就把整行撑破。
export const inputFlex = "flex-1 min-w-0 border border-border bg-bg text-text rounded-[8px] px-[11px] py-[7px] text-[12.5px] outline-none";
// 同上，但用等宽字体——快捷键、关键词这类要对齐着看的内容。
export const inputHotkey = `${inputFlex} font-mono`;
// 定宽小输入框（132px，一行里并排放两三个的那种）。
export const inputSmall = "w-[132px] flex-none border border-border bg-card text-text rounded-[8px] px-[11px] py-[7px] text-[12.5px] outline-none";
// 下拉框：flex-none + nowrap，同样是防中文选项把行挤断。
export const selectBox = "flex-none whitespace-nowrap border border-border bg-card text-text rounded-[8px] px-[9px] py-[5px] text-[12.5px] outline-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";

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

// 浏览器 KeyboardEvent → Electron Accelerator（如 ⌥Space → "Alt+Space"）。未按到主键返回 null。
export function toAccelerator(e: KeyboardEvent): string | null {
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
  const mods: string[] = [];
  if (e.metaKey) mods.push("Command");
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  let key: string;
  if (e.key === " ") key = "Space";
  else if (e.key.startsWith("Arrow")) key = e.key.slice(5);
  else if (e.key.length === 1) key = e.key.toUpperCase();
  else key = e.key;
  return [...mods, key].join("+");
}

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
    <button className={`${btnIcon} hover:border-orange hover:text-orange-text`}
      title={title || t("common.refresh")} onClick={() => void run()}>
      <span className={`flex ${on ? "animate-spin" : ""}`}><IconRefresh size={13} /></span>
    </button>
  );
}

// ── 弹窗 ────────────────────────────────────────────────────────────────────
// 遮罩 + 居中卡片。标题栏与底栏都是可选的：不传 title 就没有标题栏（确认框那种），
// 不传 footer 就没有底栏。点遮罩关闭，点卡片内部不关闭。
// 用 fixed 而不是 absolute：页面根节点不一定是定位元素，absolute 会往上找到不确定的祖先。
export function Modal({ width = 460, title, children, footer, onClose }: {
  width?: number;
  title?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onMouseDown={onClose}>
      <div className="bg-card border border-border rounded-[14px] overflow-hidden flex flex-col max-h-[calc(100%-32px)]"
        style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        {title ? (
          <div className="flex-none flex items-center gap-[10px] px-[16px] py-[14px] border-b border-border">
            <span className="flex-1 min-w-0 truncate text-[14px] font-semibold">{title}</span>
            <button className={btnIcon} title={t("common.close")} onClick={onClose}><IconX size={12} /></button>
          </div>
        ) : null}
        <div className="flex-1 overflow-y-auto px-[16px] py-[15px] flex flex-col gap-[13px]">{children}</div>
        {footer ? (
          <div className="flex-none flex items-center gap-[8px] px-[16px] py-[12px] border-t border-border bg-bg">{footer}</div>
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
    <Modal width={400} title={title} onClose={onCancel} footer={<>
      <span className="flex-1" />
      <button className={btnGhost} onClick={onCancel}>{t("common.cancel")}</button>
      <button
        className={danger
          ? "flex-none whitespace-nowrap px-[15px] py-[7px] bg-danger text-white rounded-[8px] text-[12.5px] font-semibold cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
          : btnPrimary}
        disabled={busy} onClick={onConfirm}>{confirmText}</button>
    </>}>
      <div className="text-[12.5px] leading-[1.7]">{message}</div>
      {children}
    </Modal>
  );
}
