// 三态的落点（批次 012 · 骨架件第 04 节）：挂在模板上，页面不再自绘。
//   空态三种 → 通用 EmptyState（空 / 无结果 + 清掉筛选 / 离线 + 重新连接）
//   加载 → 首屏三行骨架（--track、圆角 6、不做呼吸动画）；刷新已有列表不换骨架，旋转弧在页头同步戳位
//   错误 → ErrorCard 两种形：整页拿不到数据 = 内容区居中卡最宽 520；局部 / 通道 = 同一张卡压成横幅贴顶
import React from "react";
import { ErrorCard, type ErrAction } from "../ui";

/** 首屏骨架：rows 行，宽度错落一点像真内容；不做动画（设计定）。 */
export function Skeleton({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  const widths = ["w-[62%]", "w-[84%]", "w-[46%]", "w-[73%]", "w-[58%]"];
  return (
    <div className={`flex flex-col gap-[10px] p-[16px_18px] ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <span key={i} className={`block h-[12px] rounded-[6px] bg-track ${widths[i % widths.length]}`} />
      ))}
    </div>
  );
}

/** 整页拿不到数据：ErrorCard 的 card 形态居中，最宽 520。 */
export function PageError({ title, reason, raw, actions, kind }: {
  title: string; reason?: string; raw?: string; actions?: ErrAction[]; kind?: "danger" | "warning";
}) {
  return (
    <div className="flex-1 min-h-0 flex items-start justify-center p-[28px_20px] overflow-y-auto">
      <div className="w-full max-w-[520px]">
        <ErrorCard variant="card" kind={kind} title={title} reason={reason} raw={raw} actions={actions} />
      </div>
    </div>
  );
}

/** 局部或通道问题：同一张卡压成横幅贴内容区顶部（提醒级用 warning）。 */
export function PageBanner({ title, reason, actions, kind }: {
  title: string; reason?: string; actions?: ErrAction[]; kind?: "danger" | "warning";
}) {
  return <ErrorCard variant="banner" kind={kind} title={title} reason={reason} actions={actions} />;
}

/** 页头同步戳位的旋转弧（刷新已有列表时用，不换骨架）。 */
export function SyncSpinner({ text }: { text?: string }) {
  return (
    <span className="flex items-center gap-[6px] text-[12px] text-faint whitespace-nowrap">
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" className="animate-spin flex-none"><path d="M12 3a9 9 0 0 1 9 9" /></svg>
      {text}
    </span>
  );
}

/** T5 全铺工作台：例外只在内容区，这里只是个语义容器。 */
export function Workbench({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 min-h-0 flex">{children}</div>;
}
