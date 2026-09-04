// 常用语列表的一行（批次 013 正式稿 · 稿 01 节 / tokens.phrasePage.row）。
//   48 高，padding 0 10 0 6，gap 10，从左到右：
//   拖手柄 16（hover 才显形，只在组内拖）· 名称 13/560 定宽 150 · 单行预览 12px --muted ·
//   字数 11px 等宽（去空白后超 60 字才出，否则不占位）· 铅笔 28（hover 才出但位置常占）· 复制 28（常驻，点后换勾 2 秒）。
//   行底色：hover 或展开态 = --hover；行间 1px --border-soft；整行 cursor pointer。
//   点行原地展开只读全文：padding 0 12 12 32，内放 rowExpand 取值的框 + 「只读全文 · 要改内容点右边的铅笔」+ 「复制全文」24 钮。
//   删除不在行内（右键菜单），换标签也走右键。
//
// 手柄 / 铅笔 / 复制的点击都 stopPropagation：它们各自是一件事，不该顺手把行展开或收起。
// 「刚新增 / 换了标签」的高亮不在这里画：父级拿 rowRef 去做 1.2s 的渐隐 + 滚到那一行。
//
// 拖拽源是**手柄本身**（draggable 只挂在手柄上），行不 draggable：整行 draggable 时 Chromium 会把
// 「按住一段文字拖动」当成 dragstart，展开的只读全文就选不了字；也不用再靠「是不是从手柄按下去的」
// 这种 ref 标志来拦 —— HTML5 拖拽期间不派发 mouseup，那类标志拖过一次就复位不了。
// 拖影用整行（父级在 dragstart 里 setDragImage），不然拖起来只有一颗 13px 的六点。
import type React from "react";
import { useTranslation } from "react-i18next";
import { headerIconBtn } from "../../components/layout";
import type { Phrase } from "../tools/bridges";
import { GlyphCheck, GlyphCopy, GlyphGrip, GlyphPencil } from "./shared";

export interface RowDrag {
  /** 手柄的 dragstart / dragend（手柄是唯一的拖拽源）。 */
  onStart: (e: React.DragEvent<HTMLElement>) => void;
  onEnd: () => void;
  /** 行作为落点：dragover 里让位、drop 收尾。 */
  onOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
}

export function PhraseRow({ p, open, copied, dragging, rowRef, drag, onToggle, onEdit, onCopy, onContextMenu }: {
  p: Phrase;
  open: boolean;
  /** 复制成功后的 2 秒：复制钮换勾 + --success。 */
  copied: boolean;
  /** 正在被拖的那条压淡。 */
  dragging: boolean;
  rowRef: (el: HTMLDivElement | null) => void;
  drag: RowDrag;
  onToggle: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  // 预览永远只给一行：换行与连续空白都压成一个空格。
  const preview = p.content.replace(/\s+/g, " ").trim();
  // 字数按去空白后算，和「超 60 才出」的门槛用同一个数，免得行尾写 66 字、门槛却按 80 判。
  const len = p.content.replace(/\s/g, "").length;
  return (
    <div ref={rowRef}
      onDragOver={drag.onOver} onDrop={drag.onDrop}
      onContextMenu={onContextMenu}
      className={`group/row border-b border-border-soft last:border-b-0 cursor-pointer transition-colors duration-[130ms] ease-out ${
        open ? "bg-hover" : "hover:bg-hover"} ${dragging ? "opacity-45" : ""}`}>
      <div onClick={onToggle} className="flex items-center gap-[10px] h-[48px] pl-[6px] pr-[10px]">
        {/* 手柄 hover 才显形（visibility，不是不渲染：宽度常占，名称列不跟着跳）；撑满 48 高，好按。 */}
        <span draggable onDragStart={drag.onStart} onDragEnd={drag.onEnd} onClick={(e) => e.stopPropagation()}
          title={t("phrases.dragHint")}
          className="w-[16px] flex-none self-stretch flex items-center justify-center text-faint cursor-grab active:cursor-grabbing invisible group-hover/row:visible">
          <GlyphGrip />
        </span>
        <span className="w-[150px] flex-none truncate text-[13px] font-[560]">{p.name}</span>
        <span className="flex-1 min-w-0 truncate text-[12px] text-muted">{preview}</span>
        {len > 60 ? (
          <span className="flex-none whitespace-nowrap font-mono text-[11px] font-semibold text-faint">{t("tools.phraseChars", { n: len })}</span>
        ) : null}
        {/* 铅笔 hover 才出，但位置永远占着——出现时行内其它元素不能往左跳。 */}
        <button className={`${headerIconBtn} invisible group-hover/row:visible`} title={t("common.edit")}
          onClick={(e) => { e.stopPropagation(); onEdit(); }}>
          <GlyphPencil />
        </button>
        {/* 复制常驻：常用语八成的用法是拿去粘到别处，最高频那件事不该等鼠标悬停。
            勾的颜色用内联 style：--success 要压过 headerIconBtn 自带的 --muted / hover --text。 */}
        <button className={headerIconBtn} title={t("phrases.copyFull")} style={copied ? { color: "var(--success)" } : undefined}
          onClick={(e) => { e.stopPropagation(); onCopy(); }}>
          {copied ? <GlyphCheck /> : <GlyphCopy />}
        </button>
      </div>
      {open ? (
        <div className="pl-[32px] pr-[12px] pb-[12px] flex flex-col gap-[7px]">
          <div className="bg-bg border border-border-soft rounded-[9px] px-[12px] py-[10px] max-h-[180px] overflow-y-auto text-[12.5px] leading-[1.75] whitespace-pre-wrap break-words cursor-text">
            {p.content}
          </div>
          <div className="flex items-center gap-[8px]">
            <span className="flex-1 min-w-0 text-[11px] text-faint leading-[1.6]">{t("phrases.readOnlyHint")}</span>
            <button onClick={onCopy}
              className="flex-none h-[24px] px-[10px] rounded-[7px] border border-border bg-card text-text text-[11.5px] whitespace-nowrap cursor-pointer transition-colors duration-[130ms] ease-out hover:border-orange hover:text-orange-text">
              {t("phrases.copyFull")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
