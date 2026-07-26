// 设置类页面共用的基础控件（设置页与工具页都用）：卡片 / 标签行 / 开关 / 状态点 / 输入框类名 / 快捷键采集。
// 抽出来是因为「工具」模块从设置页拆分后，两边需要完全一致的视觉与交互。
import type React from "react";

// 一张设置卡：标题 + 可选副标题 + 纵向排列的若干行。
export function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="bg-card border border-border rounded-xl p-[16px_18px]">
      <div className="font-semibold mb-[14px]">
        {title}
        {sub ? <span className="text-[12px] text-muted font-normal ml-1.5">{sub}</span> : null}
      </div>
      <div className="flex flex-col gap-[13px]">{children}</div>
    </section>
  );
}

// 一行设置项：左侧固定宽度标签 + 右侧内容。
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-[14px]">
      <label className="w-[120px] text-[13px] text-muted shrink-0">{label}</label>
      {children}
    </div>
  );
}

// 开关按钮：on 时滑块靠右并变橙色。
export function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`w-[38px] h-[22px] rounded-full p-[2px] flex shrink-0 transition-colors ${on ? "justify-end bg-orange" : "justify-start bg-border"}`}>
      <span className="w-[18px] h-[18px] rounded-full bg-white shadow" />
    </button>
  );
}

// 连接状态小圆点：在线绿 / 连接中黄 / 离线红。
export function StatusDot({ kind }: { kind: "online" | "connecting" | "offline" }) {
  const color = kind === "online" ? "bg-success" : kind === "connecting" ? "bg-warning" : "bg-danger";
  return <span className={`w-2 h-2 rounded-full ${color}`} />;
}

// 通用输入框类名（占满剩余宽度）。
export const input = "flex-1 border border-border bg-bg text-text rounded-lg px-[11px] py-[7px] text-[13px] outline-none";
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
export function RowHint({ children }: { children: React.ReactNode }) {
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
