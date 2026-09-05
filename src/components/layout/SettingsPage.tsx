// T3 设置分组（批次 012 · tokens.pageTemplate.settings）。
// 总设置 / 小工具三页 / 各功能自己的设置面套它：二级目录 190 宽 --rail 底，**只在三组以上
// 「且」十二行以上时出现**；内容最宽 720，padding 20/24；RowsCard = --card + 1px + 圆角 12；
//
// ⚠️ 这里原来抄成了「或」，批次 016 设计侧再次确认是「**且**」，并补了理由 ——
// 二级栏的职责是「在组之间跳」，两组不需要跳、多长都不需要。所以**组数是必要条件，
// 行数只是充分性的下限**：三组但只有五行，出栏等于给一个滚一下就到底的页面加导航；
// 按「或」的话，一个两组四十行的页面会长出一条只有两个目标的栏，那条栏比没有更糟。
// （记账设置现在两组约 18 行，按「且」不出栏是对的；拆到四组之后两条都过，栏跟着出现。）
// SettingRow 最小 52 高；破坏性项落分组末尾，红描边 + 二次确认。
import React from "react";

export interface SubNavItem { key: string; label: string; icon?: React.ReactNode; count?: React.ReactNode }
export interface SubNavGroup { label?: string; items: SubNavItem[] }

export function SettingsPage({ nav, active, onSelect, children }: {
  /** 传了才画二级目录（调用方按「三组以上**且**十二行以上」的规矩决定传不传）。 */
  nav?: SubNavGroup[];
  active?: string;
  onSelect?: (key: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex-1 min-h-0 flex">
      {nav ? (
        <aside className="w-[190px] flex-none bg-rail border-r border-border overflow-y-auto py-[10px] px-[8px] flex flex-col gap-[2px]">
          {nav.map((g, gi) => (
            <React.Fragment key={gi}>
              {g.label ? <div className="px-[8px] pt-[10px] pb-[4px] text-[10.5px] font-semibold tracking-[.06em] text-faint whitespace-nowrap">{g.label}</div> : null}
              {g.items.map((it) => {
                const on = it.key === active;
                return (
                  <button key={it.key} onClick={() => onSelect?.(it.key)}
                    className={`flex items-center gap-[8px] w-full text-left px-[10px] h-[32px] rounded-[8px] border-none cursor-pointer text-[12.5px] whitespace-nowrap ${
                      on ? "bg-orange-soft text-orange-text font-semibold" : "bg-transparent text-text hover:bg-hover"}`}>
                    {it.icon ? <span className="flex-none flex">{it.icon}</span> : null}
                    <span className="flex-1 min-w-0 truncate">{it.label}</span>
                    {it.count !== undefined ? <span className={`flex-none text-[10.5px] ${on ? "text-orange-text" : "text-faint"}`}>{it.count}</span> : null}
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </aside>
      ) : null}
      <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
        <div className="max-w-[720px] p-[20px_24px_40px] flex flex-col gap-[16px]">{children}</div>
      </div>
    </div>
  );
}

/** 设置页里一组的标题行：14px/600 + 12px --faint 说明（替掉各处私有的 SecHead 17px）。 */
export function SettingsSection({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-[10px]">
      <div className="flex flex-col gap-[3px] px-[2px]">
        <span className="text-[14px] font-semibold">{title}</span>
        {desc ? <span className="text-[12px] text-faint leading-[1.65]">{desc}</span> : null}
      </div>
      {children}
    </section>
  );
}
