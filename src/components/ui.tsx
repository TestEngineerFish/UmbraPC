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
// 通用次要按钮类名。
export const btnGhost = "px-[13px] py-[6px] border border-border bg-transparent text-text rounded-lg text-[12.5px] cursor-pointer";
// 通用主按钮类名。
export const btnPrimary = "px-[13px] py-[6px] bg-orange text-white rounded-lg text-[12.5px] font-semibold cursor-pointer";

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
