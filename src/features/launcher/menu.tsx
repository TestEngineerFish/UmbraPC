// 右键菜单（多级子菜单）。从 WorkflowEditor 抽出来单独成文件：
// 节点配置弹窗里的表格也要用它（行的删除/上移/下移都收进右键菜单），
// 留在 WorkflowEditor 里的话 nodeform 要 import 它、它又要 import nodeform，绕成环。
import { useState } from "react";
import type { ReactNode } from "react";
import { IconChevronRight } from "../../components/icons";

// ── 右键菜单（多级子菜单）──
// count：分类行右侧的「已实现/总数」；keyHint：动作行右侧的快捷键；title：面板顶部的分区小标题。
export interface MenuItem { label?: string; icon?: ReactNode; count?: string; keyHint?: string; onClick?: () => void; sub?: MenuItem[]; danger?: boolean; sep?: boolean }
// 菜单面板宽度（用来判断子菜单往右还是往左展开），和 min-w 保持一致。
const MENU_W = 224;
// 面板的落点。left 必给；top / bottom 二选一（点在下半屏时用 bottom 向上生长）；
// maxH 是这块面板自己的高度上限，超了它自己滚。
interface MenuAt { left: number; top?: number; bottom?: number; maxH: number }

// dark=true 用画布那套硬编码深色（菜单开在深色画布上，跟着主题变会和画布打架）；
// 否则走主题变量，给顶栏「⋯」这种开在浅色区域的菜单用。
//
// 关于定位：每一级面板都是 position:fixed，坐标由调用方（根级）或父级行的 getBoundingClientRect（子级）算出来。
// 曾经的做法是给菜单套一个带 overflow-y-auto 的外层、子菜单用 absolute left-full 挂在行上，
// 结果二级菜单被那个滚动容器裁掉了（横竖都被切，还多出一条横向滚动条）。
// fixed 不受祖先 overflow 裁剪（祖先里没有 transform / filter，不会成为 fixed 的包含块），
// 所以每级都 fixed 之后，每级面板都能独立带上自己的 max-height + 滚动，且不裁下一级。
function MenuList({ items, onClose, dark, title, at }: {
  items: MenuItem[]; onClose: () => void; dark?: boolean; title?: string; at: MenuAt;
}) {
  const [open, setOpen] = useState<{ i: number; at: MenuAt } | null>(null);
  const panel = dark
    ? "bg-[rgba(31,28,24,.98)] border border-[#3A342B] rounded-[10px] p-1 shadow-[0_10px_30px_rgba(0,0,0,.45)] min-w-[208px] overflow-y-auto"
    : "bg-card border border-border rounded-[10px] p-1 shadow-2xl min-w-[208px] overflow-y-auto";
  const row = "w-full flex items-center gap-[9px] px-[9px] py-[5px] rounded-md text-[12px] text-left bg-transparent";
  const rowTone = dark ? "text-[#D8D3CA] hover:bg-[rgba(232,89,12,.16)] hover:text-[#F0A878]" : "text-text hover:bg-orange-soft hover:text-orange-text";
  const iconTone = dark ? "text-[#8A837A]" : "text-muted";
  const dimTone = dark ? "text-[#6E675E]" : "text-faint";

  // 悬停到带子菜单的行上：按这一行的实际位置算子菜单落点。
  // 右边放得下就贴右侧，放不下翻到左侧；纵向与行顶齐平，并留出至少 140px 的可视高度。
  const enter = (i: number, hasSub: boolean, e: React.MouseEvent<HTMLDivElement>) => {
    if (!hasSub) { setOpen(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    const left = r.right + MENU_W + 8 <= window.innerWidth ? r.right + 2 : Math.max(8, r.left - MENU_W - 2);
    const top = Math.max(8, Math.min(r.top - 5, window.innerHeight - 148));
    setOpen({ i, at: { left, top, maxH: window.innerHeight - top - 8 } });
  };

  return (
    <>
      {/* 本级面板滚动时关掉子菜单：子菜单是 fixed 的，跟不了父级的滚动，留着会脱锚。 */}
      <div className={panel} onScroll={() => setOpen(null)}
        style={{ position: "fixed", left: at.left, top: at.top, bottom: at.bottom, maxHeight: at.maxH }}>
        {title ? <div className={`px-[9px] pt-[5px] pb-[3px] text-[10px] tracking-[.06em] ${dimTone}`}>{title}</div> : null}
        {items.map((it, i) => it.sep ? <div key={i} className={`h-px my-1 mx-1.5 ${dark ? "bg-[#332E26]" : "bg-border-soft"}`} /> : (
          <div key={i} onMouseEnter={(e) => enter(i, !!it.sub, e)}>
            <button className={`${row} ${it.danger ? "text-danger hover:bg-danger-soft" : rowTone}`}
              onClick={() => { if (it.sub) return; it.onClick?.(); onClose(); }}>
              <span className={`w-4 flex-none flex justify-center ${it.danger ? "" : iconTone}`}>{it.icon}</span>
              <span className="flex-1 whitespace-nowrap">{it.label}</span>
              {it.count ? <span className={`flex-none text-[10px] tabular-nums ${dimTone}`}>{it.count}</span> : null}
              {it.keyHint ? <span className={`flex-none font-mono text-[10px] ${dimTone}`}>{it.keyHint}</span> : null}
              {it.sub ? <span className={`flex-none ${dimTone}`}><IconChevronRight size={10} /></span> : null}
            </button>
          </div>
        ))}
      </div>
      {/* 子菜单画在本级面板外面（同为 fixed），所以不会被本级的滚动容器裁掉。 */}
      {open && items[open.i]?.sub ? <MenuList items={items[open.i].sub!} onClose={onClose} dark={dark} at={open.at} /> : null}
    </>
  );
}
// 根级落点：水平按视口宽度夹住（右键点在最右边时菜单不溢出）；
// 点在下半屏时用 bottom 贴住点击位置向上生长，免得被窗口底边切掉。
export function ContextMenu({ x, y, items, onClose, dark, title }: { x: number; y: number; items: MenuItem[]; onClose: () => void; dark?: boolean; title?: string }) {
  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_W - 8));
  const upward = y > window.innerHeight / 2;
  const at: MenuAt = upward
    ? { left, bottom: window.innerHeight - y, maxH: y - 8 }
    : { left, top: y, maxH: window.innerHeight - y - 8 };
  return (
    <div className="fixed inset-0 z-[70]" onMouseDown={onClose} onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div onMouseDown={(e) => e.stopPropagation()}>
        <MenuList items={items} onClose={onClose} dark={dark} title={title} at={at} />
      </div>
    </div>
  );
}

