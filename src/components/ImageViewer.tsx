// 通用图片预览器（可复用）：全屏遮罩看大图，支持放大/缩小、拖动、下载、ESC/点击背景关闭，
// 多图时左右切换（← → 键 / 两侧箭头钮 / 工具条计数）。
//
// 用法：受控组件——传 src 打开、onClose 关闭。要左右切换就再传 items（同一组图的列表），
// 预览器按 src 在 items 里定位当前项；items 不传就是单图（老调用方一个字不用改）。
//
// ⚠️ 这个组件必须 createPortal 挂到应用根（.umbra-root，没有就 body）——
// 验收实锤（sam，2026-09-03）：保险箱里 fixed 定位的预览器被画在了附件控件内部。
// 详情栏的进场动画（vDetailIn / vBlockIn 带 transform）会让祖先在动画期间成为 fixed 的
// 包含块，inset:0 就变成「铺满那张卡」。挂到根上就与调用处的任何 transform/overflow 无关。
// 挂 .umbra-root 而不是 body 的原因同 DateTimePicker：主窗口的深色主题只作用在那棵子树上。
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconDownload, IconX, IconChevronLeft, IconChevronRight } from "./icons";

export interface ViewerItem { src: string; alt?: string }

// 把一组图交给**独立图片窗**打开（批次 011：不遮任何界面，看图时原窗口照常操作）。
// 返回 false = 没有主进程桥（浏览器预览），调用方退回窗口内 overlay。
// source：内容来源标记 —— 保险箱传 "vault"，锁定时主进程只连带关它的图。
export function openInViewerWindow(items: ViewerItem[], src: string, source?: string): boolean {
  const api = (window as unknown as {
    umbraViewer?: { open(p: { items: ViewerItem[]; index: number; source?: string }): Promise<void> };
  }).umbraViewer;
  if (!api?.open) return false;
  const index = Math.max(0, items.findIndex((i) => i.src === src));
  void api.open({ items, index, source });
  return true;
}

export function ImageViewer({ src, alt, items, onClose, variant = "overlay", onFit }: {
  src: string | null; alt?: string; items?: ViewerItem[]; onClose: () => void;
  /** overlay = 窗口内全屏遮罩（iOS 与浏览器预览的旧行为）；window = 独立图片窗里的正文
   *  （批次 011 稿）：工具条即拖动区 + 失焦态 + 只有 Esc/关闭钮关窗（点空白**不**关 ——
   *  独立窗里空白是它自己的底，点它关窗会误关）。 */
  variant?: "overlay" | "window";
  /** window 模式：图片原始尺寸上报（主进程按比例适配窗口）。 */
  onFit?: (w: number, h: number) => void;
}) {
  const isWin = variant === "window";
  // 失焦态（稿定，独立窗新问题）：键盘焦点不在这扇窗时 ← → / Esc 都不生效，
  // 但窗看起来一模一样 —— 压暗工具条与侧钮、脚注明说，别让人以为快捷键坏了。
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    if (!isWin) return;
    const on = () => setFocused(true), off = () => setFocused(false);
    setFocused(document.hasFocus());
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => { window.removeEventListener("focus", on); window.removeEventListener("blur", off); };
  }, [isWin]);
  // 当前看的是哪一张：有 items 时按 src 定位，之后 ← → 在列表里走；没有就只有 src 一张。
  const list = useMemo<ViewerItem[]>(
    () => (items && items.length ? items : src ? [{ src, alt }] : []),
    [items, src, alt],
  );
  const [cur, setCur] = useState(0);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const reset = () => { setScale(1); setTx(0); setTy(0); };

  // 每次打开（src 变）重定位 + 重置视图。
  useEffect(() => {
    if (!src) return;
    const i = list.findIndex((it) => it.src === src);
    setCur(i < 0 ? 0 : i);
    reset();
  }, [src, list]);

  const canNav = list.length > 1;
  // 不循环（批次 009 定稿）：循环会让「我看完了没」失去边界。到头时 go 不动，
  // 两侧钮转 30% 不可点。
  const go = (d: number) => {
    if (!canNav) return;
    setCur((c) => {
      const next = c + d;
      if (next < 0 || next >= list.length) return c;
      reset();
      return next;
    });
  };

  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") setScale((s) => Math.min(s + 0.25, 8));
      else if (e.key === "-") setScale((s) => Math.max(s - 0.25, 0.25));
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // go 只依赖 list.length，闭包里取的是最新的 setCur，不用进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, onClose, list.length]);

  if (!src || !list.length) return null;
  const item = list[Math.min(cur, list.length - 1)];

  const zoom = (d: number) => setScale((s) => Math.min(8, Math.max(0.25, +(s + d).toFixed(2))));
  const download = async () => {
    try {
      const resp = await fetch(item.src);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (item.alt || "image").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) + ".png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { /* ignore */ }
  };

  // 工具条按批次 009 定稿（token imageViewerPc）收成两件：34 下载 + 34 关闭，左侧文件名、
  // 右侧「N / M」计数。缩放钮组撤了 —— 缩放保留为**隐性交互**（滚轮、+/- 键，双击重置），
  // 这条偏离已在批次 010 通报（sam 验收过放大功能，能力不能随工具条一起撤）。
  const btn = "w-[34px] h-[34px] flex items-center justify-center rounded-full bg-white/15 hover:bg-white/25 text-white cursor-pointer select-none";
  // 两侧 44 圆钮（稿：rgba(255,255,255,.07) 底 + .16 描边）；到头 30% 不可点。
  const navBtn = "absolute top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center rounded-full bg-[rgba(255,255,255,.07)] border border-[rgba(255,255,255,.16)] text-white select-none z-[101]";
  const navState = (ok: boolean) => (ok ? "cursor-pointer hover:bg-[rgba(255,255,255,.14)]" : "opacity-30 pointer-events-none");
  // 脚注四态（批次 010/011 稿）：放大 > 失焦 > 平时（多图/单图）。
  // 独立窗不写「点空白关闭」—— 空白是它自己的底，点它关窗会误关（稿定去掉）。
  const closeHint = isWin ? "Esc 关窗" : "Esc 或点空白关闭";
  const footnote = isWin && !focused
    ? "这扇窗没有焦点 · 点一下窗内任意处再用 ← → 和 Esc"
    : scale > 1 ? "拖动平移 · 双击回到适应窗口"
    : canNav ? `← → 切换 · 滚轮缩放 · ${closeHint}`
    : `滚轮缩放 · ${closeHint}`;
  const node = (
    <div
      // 全屏底用 --viewer-bg（设计定稿 #0B0A09，两主题同值，与 iOS 同源）。
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--viewer-bg)]"
      // overlay：主窗口顶部 40px 是标题栏拖拽区（shell.ts），吃鼠标不看 z-index，
      // 全屏浮层打开时整块声明 no-drag（验收实锤「按钮只有下半部分能点」）。
      // window：拖动区交给工具条（见下），正文保持 no-drag。
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      onClick={isWin ? undefined : onClose}>
      {/* 工具条（高 52）：左文件名 · 右计数 + 下载 + 关闭。
          独立窗里它就是拖动区（稿定：无边框窗最容易出的问题是「这窗挪不动」，
          左端一颗六点把手明示这件事），按钮各自 no-drag。失焦整体压到 .5。 */}
      <div
        className={`absolute top-0 left-0 right-0 h-[52px] px-4 flex items-center gap-2 z-[101] ${isWin && !focused ? "opacity-50" : ""}`}
        style={isWin ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined}
        onClick={(e) => e.stopPropagation()}>
        {isWin ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.5)" strokeWidth="2.4" strokeLinecap="round" className="flex-none select-none">
            <path d="M8 6h.01M16 6h.01M8 12h.01M16 12h.01M8 18h.01M16 18h.01" />
          </svg>
        ) : null}
        <div className="flex-1 min-w-0 truncate text-[rgba(255,255,255,.78)] text-[12px] font-mono select-none">{item.alt || ""}</div>
        {canNav ? <span className="flex-none text-white/80 text-[12px] select-none whitespace-nowrap">{cur + 1} / {list.length}</span> : null}
        <button className={btn} style={isWin ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined} title="下载" onClick={download}><IconDownload size={15} /></button>
        <button className={btn} style={isWin ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined} title="关闭（Esc）" onClick={onClose}><IconX size={15} /></button>
      </div>
      {canNav ? (
        <>
          <button className={`${navBtn} left-4 ${navState(cur > 0)} ${isWin && !focused ? "opacity-30" : ""}`} title="上一张（←）" onClick={(e) => { e.stopPropagation(); go(-1); }}><IconChevronLeft size={18} /></button>
          <button className={`${navBtn} right-4 ${navState(cur < list.length - 1)} ${isWin && !focused ? "opacity-30" : ""}`} title="下一张（→）" onClick={(e) => { e.stopPropagation(); go(1); }}><IconChevronRight size={18} /></button>
        </>
      ) : null}
      <div className="absolute bottom-4 left-0 right-0 text-center text-[11.5px] text-[rgba(255,255,255,.45)] select-none z-[101]" onClick={(e) => e.stopPropagation()}>
        {footnote}
      </div>
      {/* 图片：contain 居中、不放大超过原尺寸（<img> 天然不超原尺寸，max 约束只缩不放）。
          滚轮缩放 / 拖动 / 双击重置是隐性交互（工具条上没有钮，见上）。
          key 跟着 src 走：切图时让 <img> 重建，别让上一张的尺寸撑着过渡。 */}
      <img
        key={item.src}
        src={item.src}
        alt={item.alt || ""}
        draggable={false}
        onLoad={(e) => {
          const el = e.currentTarget;
          if (el.naturalWidth && el.naturalHeight) onFit?.(el.naturalWidth, el.naturalHeight);
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={reset}
        onWheel={(e) => { zoom(e.deltaY < 0 ? 0.2 : -0.2); }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, tx, ty };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setTx(drag.current.tx + (e.clientX - drag.current.x));
          setTy(drag.current.ty + (e.clientY - drag.current.y));
        }}
        onPointerUp={() => { drag.current = null; }}
        className="max-w-[92vw] max-h-[88vh] object-contain select-none"
        style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})`, cursor: scale > 1 ? "grab" : "default" }}
      />
    </div>
  );
  return createPortal(node, document.querySelector(".umbra-root") ?? document.body);
}
