// T2 列表 + 弹窗（批次 012 · tokens.pageTemplate.listModal）。
// 提醒 / 记账流水 / 常用语套它：分组列表最宽 920（表格类满铺），分组头用统一分区小标题，
// 卡内是行、行间 1px --border-soft；行支持原地展开只读全文；编辑走 Modal（480 / 560 / 680）；
// 行内不放删除，破坏性动作进右键菜单。新增在页头主按钮位，保存后新条落顶部并高亮 1.2s。
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SectionHeader } from "./ListDetail";
import { showToast } from "../overlay";
import { IconCopy } from "../icons";

/** T2 的滚动容器：padding 20/24/24 + 组间 18 + 组头到卡 7（批次 013 裁定 2，
 *  tokens.pageTemplate.listModal.content；与 T3 内容区 20/24 同档，012 骨架小样里的 16/20 是示意），
 *  内容最宽 920。组头到卡那 7 在下面的 Group 里给。
 *  full（表格类，眼下只有记账流水）= 只去掉宽度上限，**内边距和别处一样**（裁定 2 点名了记账流水页
 *  跟着这组走）—— 满铺指的是宽度不设上限，不是让分组头贴到窗口边上。 */
export function ListModal({ full, children }: { full?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className={`flex flex-col gap-[18px] p-[20px_24px_24px] ${full ? "" : "max-w-[920px]"}`}>{children}</div>
    </div>
  );
}

/** 一个分组：分区小标题（可带计数）+ 一张卡，卡内逐行。
 *  组头到卡 7（批次 013 裁定 2，tokens.pageTemplate.listModal.content）：距离由这里的 gap 给，
 *  组头本身走贴左那一档（pad="group"）—— 卡贴着内容区左边，组头缩 14 会比卡还往里。 */
export function Group({ title, count, action, children }: { title: React.ReactNode; count?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-[7px]">
      <SectionHeader pad="group" count={count} action={action}>{title}</SectionHeader>
      <div className="bg-card border border-border rounded-[12px] overflow-hidden">{children}</div>
    </section>
  );
}

/** 卡内一行：最小 52 高 / padding 11/14 / 行间 1px --border-soft；hover --hover；flash = 刚新增的高亮（1.2s 渐隐）。
 *  rowRef：把行的 DOM 交出去，给「滚到这一行」用（照 Phrases 的 PhraseRow 同一套回调 ref）。 */
export function GroupRow({ onClick, onContextMenu, flash, active, rowRef, children }: {
  onClick?: () => void; onContextMenu?: (e: React.MouseEvent) => void; flash?: boolean; active?: boolean;
  rowRef?: (el: HTMLDivElement | null) => void;
  children: React.ReactNode;
}) {
  return (
    <div ref={rowRef} onClick={onClick} onContextMenu={onContextMenu}
      className={`group/row flex items-center gap-[10px] min-h-[52px] px-[14px] py-[11px] border-b border-border-soft last:border-b-0 transition-colors duration-[1200ms] ease-out ${
        flash ? "bg-orange-soft" : active ? "bg-hover" : "hover:bg-hover"} ${onClick ? "cursor-pointer" : ""}`}>
      {children}
    </div>
  );
}

/** 刚新增的那条要短暂高亮：返回当前应高亮的 id（1.2s 后自动清）。 */
export function useFlashId(): [string | null, (id: string) => void] {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    const t = window.setTimeout(() => setId(null), 1200);
    return () => window.clearTimeout(t);
  }, [id]);
  return [id, setId];
}

/** 行的原地展开只读全文：--bg 底 + 1px --border-soft + 圆角 9 + max-height 180 内部滚动 + pre-wrap，
 *  底下一行「只读全文 · 要改内容点右边」+ 复制。批次 011 ⑤ 落地的那套原样进规范。 */
export function RowExpand({ text, hint }: { text: string; hint?: string }) {
  const { t } = useTranslation();
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); showToast(t("layout.copied"), { tone: "ok" }); }
    catch { showToast(t("layout.copyFailed"), { tone: "fail" }); }
  };
  return (
    <div className="mx-[14px] mb-[11px] rounded-[9px] border border-border-soft bg-bg overflow-hidden" onClick={(e) => e.stopPropagation()}>
      <div className="max-h-[180px] overflow-y-auto px-[12px] py-[9px] text-[12.5px] leading-[1.7] whitespace-pre-wrap break-words">{text}</div>
      <div className="flex items-center gap-[8px] px-[12px] py-[6px] border-t border-border-soft text-[11px] text-faint">
        <span className="flex-1 min-w-0 truncate">{hint || t("layout.readOnlyHint")}</span>
        <button className="flex-none flex items-center gap-[4px] bg-transparent border-none text-muted cursor-pointer hover:text-text" onClick={() => void copy()}>
          <IconCopy size={12} />{t("layout.copy")}
        </button>
      </div>
    </div>
  );
}
