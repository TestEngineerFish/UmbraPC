// 功能页统一页头（批次 012 · 《PC 页面骨架.dc.html》第 01 节 / tokens.pageHeader）。
// 14 个功能页共用这一份，页面不再各自画顶栏。取值照 tokens 到像素：
//   高 52 定高一行 · --card 底 + 下边 1px --border · 左内边距 18 / 右 14
//   标题 16/600（一档）· 副标题「· 」+ 12px --faint · 按钮高 28 · 图标钮 28×28 圆角 7
//   右侧动作组从右往左固定：⋯ 更多 · 设置齿轮 · 状态/同步戳 · 次级按钮 0–2 · 主按钮 1
//   缺哪项空哪项，其余位置不移；齿轮与 ⋯ 是每页都有的家具，钉在右角。
//   第二行 44 高 / --rail 底 / 下边 1px，放搜索 + 筛选芯片，不参与页头定高。
//
// 设置视图变体（第 05 节）：左侧换成返回钮 28 + 「{功能名}设置」，左内边距收到 10；
// 视图内没有齿轮、没有主按钮（改动即时生效，不出现「保存」）。
import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { btn, ContextMenu, type MenuAction } from "../ui";
import { IconArrowLeft, IconDots, IconGear, IconSearch } from "../icons";

/** 页头里的一颗文字按钮：主按钮橙实心一页最多一颗；次级描边 0–2 颗。 */
export interface HeaderButton {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  /** danger = 红描边（回收站「清空回收站」这类破坏性次级动作）；默认 ghost 描边。 */
  tone?: "danger";
  /** 按钮前的 12px 图标（如变体 E 的「▶ 运行」）。 */
  icon?: React.ReactNode;
}

export interface PageHeaderProps {
  title: string;
  /** 标题前的对象身份块（变体 E：22 图标块），--chip 底 / 圆角 6 由调用方画。 */
  lead?: React.ReactNode;
  /** 标题后的徽章（变体 E：「已启用」胶囊）。 */
  badge?: React.ReactNode;
  /** 副标题：渲染成「· xxx」，可传节点（带状态点 / 计数）。 */
  subtitle?: React.ReactNode;
  /** 状态 / 同步戳槽位（12px --faint）；传 SyncStamp 或一段文字。 */
  status?: React.ReactNode;
  primary?: HeaderButton;
  secondary?: HeaderButton[];
  /** 传了齿轮才出现：进本功能自己的设置视图。 */
  onSettings?: () => void;
  /** ⋯ 更多：低频 / 破坏性动作。红字项在末尾并加分隔线（调用方按 ContextMenu 的规矩排）。 */
  more?: MenuAction[];
  /** 可选第二行（搜索 + 筛选芯片）。 */
  secondRow?: React.ReactNode;
  /** 设置视图变体：左侧返回钮 + 标题；给了它就不画齿轮 / 主按钮。 */
  back?: { label: string; onBack: () => void };
  /** 变体 E（批次 013 · 画布工作台）：第二行当工具条时传 true —— 第二行不再是搜索 / 筛选那档的
   *  内边距 16，改成 padding 0 16 + gap 8 且允许调用方放输入框与图标钮。取值其实一样，
   *  这个开关只用来在代码里标明「这是唯一被允许把主按钮放进第二行的页面」。 */
  toolbarRow?: boolean;
}

// 图标钮：28×28 / 圆角 7 / --muted，hover 加 --hover 底 + --text。无描边（和 kit.icon 的 26 档不同，
// 那档带描边是给内容区用的；页头里的是「家具」，描边会让右角变成一排小方块）。
export const headerIconBtn =
  "w-[28px] h-[28px] flex-none flex items-center justify-center rounded-[7px] bg-transparent border-none text-muted cursor-pointer transition-colors duration-[130ms] ease-out hover:bg-hover hover:text-text disabled:text-faint disabled:cursor-not-allowed disabled:hover:bg-transparent";

export function PageHeader(p: PageHeaderProps) {
  const { t } = useTranslation();
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const openMore = () => {
    const r = moreRef.current?.getBoundingClientRect();
    if (!r) return;
    // 菜单贴钮下沿、右对齐（ContextMenu 宽 168，自己夹在视口内）。
    setMenuAt({ x: Math.max(8, r.right - 168), y: r.bottom + 4 });
  };
  // 设置视图（back）里不画主按钮 / 齿轮（规范：视图内没有主按钮、改动即时生效）；⋯ 与次级钮允许（回收站的「清空回收站」）。
  const primary = p.back ? undefined : p.primary;
  const hasTextBtns = !!primary || !!(p.secondary && p.secondary.length);
  const hasIconBtns = (!p.back && !!p.onSettings) || !!(p.more && p.more.length);
  return (
    <div className="flex-none">
      <div className={`h-[52px] flex items-center gap-[10px] bg-card border-b border-border ${p.back ? "pl-[10px]" : "pl-[18px]"} pr-[14px]`}>
        {p.back ? (
          <button className={headerIconBtn} title={p.back.label} onClick={p.back.onBack}><IconArrowLeft size={15} /></button>
        ) : null}
        {p.lead ? <span className="flex-none flex items-center">{p.lead}</span> : null}
        <span className="flex-none max-w-[46%] truncate text-[16px] font-semibold tracking-[-.005em]">{p.title}</span>
        {p.badge ? <span className="flex-none flex items-center">{p.badge}</span> : null}
        {p.subtitle ? (
          <span className="flex-1 min-w-0 truncate text-[12px] text-faint flex items-center gap-[6px] [font-variant-numeric:tabular-nums]">
            <span className="flex-none">·</span>{p.subtitle}
          </span>
        ) : <span className="flex-1 min-w-[8px]" />}
        {/* 从右往左：⋯ · 齿轮 · 状态 · 次级 · 主按钮 —— DOM 顺序反过来写。 */}
        {primary ? (
          <button className={`${btn("primary", "sm")}${primary.icon ? " gap-[6px]" : ""}`} disabled={primary.disabled} title={primary.title} onClick={primary.onClick}>{primary.icon}{primary.label}</button>
        ) : null}
        {(p.secondary || []).slice(0, 2).map((b, i) => (
          <button key={i} className={`${btn(b.tone === "danger" ? "danger" : "ghost", "sm")}${b.icon ? " gap-[6px]" : ""}`} disabled={b.disabled} title={b.title} onClick={b.onClick}>{b.icon}{b.label}</button>
        ))}
        {p.status ? <span className="flex-none flex items-center text-[12px] text-faint whitespace-nowrap">{p.status}</span> : null}
        {hasTextBtns && hasIconBtns ? <span className="flex-none w-px h-[18px] bg-border mx-[2px]" /> : null}
        {!p.back && p.onSettings ? (
          <button className={headerIconBtn} title={t("layout.settings")} onClick={p.onSettings}><IconGear size={15} /></button>
        ) : null}
        {p.more && p.more.length ? (
          <button ref={moreRef} className={headerIconBtn} title={t("layout.more")} onClick={openMore}><IconDots size={15} /></button>
        ) : null}
      </div>
      {p.secondRow ? (
        <div className="h-[44px] flex items-center gap-[8px] px-[16px] bg-rail border-b border-border">{p.secondRow}</div>
      ) : null}
      {menuAt && p.more ? <ContextMenu x={menuAt.x} y={menuAt.y} items={p.more} onClose={() => setMenuAt(null)} /> : null}
    </div>
  );
}

/** 第二行的搜索框：240×28 / 圆角 7 / --card 底 / 1px --border（tokens.pageHeader.secondRow.search）。 */
export function HeaderSearch({ value, onChange, placeholder, width = 240 }: {
  value: string; onChange: (v: string) => void; placeholder?: string; width?: number;
}) {
  return (
    <label className="flex-none h-[28px] flex items-center gap-[7px] px-[9px] rounded-[7px] bg-card border border-border transition-colors duration-[130ms] ease-out focus-within:border-orange" style={{ width }}>
      <span className="flex-none text-faint flex"><IconSearch size={12} /></span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="flex-1 min-w-0 bg-transparent border-none outline-none text-[12px] text-text" />
    </label>
  );
}
