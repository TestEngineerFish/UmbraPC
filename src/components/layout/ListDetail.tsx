// T1 列表 + 详情（批次 012 · tokens.pageTemplate.listDetail + shared 零件）。
// 任务 / 工作区 / 灵感 / 能力四页套它：左列表固定宽 400（452 / 396 / 392 一起收掉），
// --rail 底 + 右边 1px；列表栏头 44 高只放分组 / 排序（搜索、筛选、新增一律上移页头）；
// 右侧详情 flex:1 min-width:0，未选中居中占位「左边选一项看详情」。
// 列表整体为空时空态放列表栏内，右侧只留底色 —— 两个空态叠一屏等于什么都没说。
import React from "react";
import { useTranslation } from "react-i18next";
import { IconDots, IconList } from "../icons";

export function ListDetail({ listHead, list, listFoot, detail, listEmpty, placeholder }: {
  /** 列表栏头（44 高）：分组 / 排序。 */
  listHead?: React.ReactNode;
  /** 列表内容（自己决定行密度还是卡片密度）。 */
  list: React.ReactNode;
  /** 贴列表栏底部的多选工具条等。 */
  listFoot?: React.ReactNode;
  /** 详情；null = 未选中，画占位。 */
  detail: React.ReactNode | null;
  /** 列表整体为空：true 时右侧只留底色（不叠第二个空态）。 */
  listEmpty?: boolean;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 min-h-0 flex">
      <aside className="w-[400px] flex-none bg-rail border-r border-border flex flex-col min-h-0">
        {listHead ? <div className="h-[44px] flex-none flex items-center gap-[8px] px-[14px] border-b border-border-soft">{listHead}</div> : null}
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">{list}</div>
        {listFoot}
      </aside>
      <section className="flex-1 min-w-0 min-h-0 flex flex-col bg-bg">
        {detail ?? (listEmpty ? null : <DetailPlaceholder text={placeholder || t("layout.pickOne")} />)}
      </section>
    </div>
  );
}

/** 右侧未选中占位：图标 24 --faint + 一句话。 */
export function DetailPlaceholder({ text }: { text: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-[9px] text-faint">
      <IconList size={24} />
      <span className="text-[12.5px]">{text}</span>
    </div>
  );
}

/** 分区小标题：11px / 600 / .06em / --faint，padding 9/14/5；带计数时右侧 10.5px --faint。 */
export function SectionHeader({ children, count, action }: { children: React.ReactNode; count?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex-none flex items-center gap-[8px] pt-[9px] px-[14px] pb-[5px]">
      <span className="flex-1 min-w-0 truncate text-[11px] font-semibold tracking-[.06em] text-faint">{children}</span>
      {count !== undefined ? <span className="flex-none text-[10.5px] text-faint [font-variant-numeric:tabular-nums]">{count}</span> : null}
      {action}
    </div>
  );
}

/** 统计条：36 高 / --rail 底 / 上边 1px --border / 11.5px --muted，数字 tabular；不做成卡片。 */
export function StatBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-none h-[36px] flex items-center gap-[14px] px-[14px] bg-rail border-t border-border text-[11.5px] text-muted [font-variant-numeric:tabular-nums] whitespace-nowrap overflow-hidden">
      {children}
    </div>
  );
}

/** 详情头：padding 14/20 + 下边 1px --border；标题 15.5/620，下一行 11.5px --faint 状态；右上角图标钮 + ⋯。 */
export function DetailHead({ title, sub, lead, actions, onMore }: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  /** 标题前的前导（状态徽章 / 头像块）。 */
  lead?: React.ReactNode;
  actions?: React.ReactNode;
  onMore?: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="flex-none flex items-start gap-[12px] px-[20px] py-[14px] border-b border-border bg-card">
      {lead ? <span className="flex-none flex items-center h-[24px]">{lead}</span> : null}
      <div className="flex-1 min-w-0">
        <div className="text-[15.5px] font-[620] leading-[1.4] break-words">{title}</div>
        {sub ? <div className="mt-[3px] text-[11.5px] text-faint leading-[1.55]">{sub}</div> : null}
      </div>
      {actions ? <span className="flex-none flex items-center gap-[6px]">{actions}</span> : null}
      {onMore ? (
        <button className={detailIconBtn} onClick={onMore} title="…"><IconDots size={14} /></button>
      ) : null}
    </div>
  );
}

/** 详情头 / 行尾用的 24 图标钮（无描边，--muted，hover --hover 底）。 */
export const detailIconBtn =
  "w-[24px] h-[24px] flex-none flex items-center justify-center rounded-[6px] bg-transparent border-none text-muted cursor-pointer transition-colors duration-[130ms] ease-out hover:bg-hover hover:text-text disabled:text-faint disabled:cursor-not-allowed";

/** 列表行（行密度）：最小 52 高 / padding 11/14 / 行间 1px --border-soft。
 *  四个态：默认透明 · 悬停 --hover + 行尾动作 · 选中 --orange-soft + 主文 --orange-text（不加色条、不加描边）· 多选行首 16 方框。 */
export function ListRow({ selected, checked, checkable, onClick, onContextMenu, actions, children }: {
  selected?: boolean;
  checked?: boolean;
  checkable?: boolean;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** 行尾动作（hover 才现身）。 */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const on = selected || checked;
  return (
    <div onClick={onClick} onContextMenu={onContextMenu}
      className={`group/row flex-none flex items-center gap-[10px] min-h-[52px] px-[14px] py-[11px] border-b border-border-soft cursor-pointer transition-colors duration-[130ms] ease-out ${
        on ? "bg-orange-soft text-orange-text" : "hover:bg-hover"}`}>
      {checkable ? (
        <span className={`w-[16px] h-[16px] flex-none rounded-[4px] border-[1.5px] flex items-center justify-center ${checked ? "bg-orange border-orange" : "border-border bg-card"}`}>
          {checked ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4 4 10-10" /></svg> : null}
        </span>
      ) : null}
      <div className="flex-1 min-w-0">{children}</div>
      {actions ? <span className="flex-none flex items-center gap-[4px] opacity-0 group-hover/row:opacity-100 transition-opacity duration-[130ms]">{actions}</span> : null}
    </div>
  );
}

/** 卡片密度的列表容器：padding 12 / gap 8。 */
export function CardList({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-[8px] p-[12px]">{children}</div>;
}

/** 卡片密度的一张：--card + 1px --border + 圆角 11 + padding 12/14；选中 = 1px --orange + --orange-soft。 */
export function ListCard({ selected, checked, onClick, onContextMenu, children }: {
  selected?: boolean; checked?: boolean; onClick?: () => void; onContextMenu?: (e: React.MouseEvent) => void; children: React.ReactNode;
}) {
  const on = selected || checked;
  return (
    <div onClick={onClick} onContextMenu={onContextMenu}
      className={`rounded-[11px] border px-[14px] py-[12px] cursor-pointer transition-colors duration-[130ms] ease-out ${
        on ? "bg-orange-soft border-orange" : "bg-card border-border hover:border-orange"}`}>
      {children}
    </div>
  );
}

/** 多选工具条：44 高、贴列表栏底部，--card 底 + 上边 1px；左「已选 N 项」右动作。 */
export function MultiSelectBar({ count, children }: { count: number; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex-none h-[44px] flex items-center gap-[8px] px-[14px] bg-card border-t border-border">
      <span className="flex-1 min-w-0 text-[12.5px] [font-variant-numeric:tabular-nums]">{t("layout.selectedN", { n: count })}</span>
      {children}
    </div>
  );
}
