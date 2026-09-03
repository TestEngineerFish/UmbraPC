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
import { IconMinus, IconPlus, IconRefresh, IconDownload, IconX, IconChevronLeft, IconChevronRight } from "./icons";

export interface ViewerItem { src: string; alt?: string }

export function ImageViewer({ src, alt, items, onClose }: {
  src: string | null; alt?: string; items?: ViewerItem[]; onClose: () => void;
}) {
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
  const go = (d: number) => {
    if (!canNav) return;
    setCur((c) => (c + d + list.length) % list.length);
    reset();
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

  const btn = "w-9 h-9 flex items-center justify-center rounded-full bg-white/15 hover:bg-white/25 text-white text-[16px] cursor-pointer select-none";
  // 两侧的切换钮：比工具条的大一号（44），停在遮罩左右边缘中线上；单图不画。
  const navBtn = "absolute top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center rounded-full bg-white/15 hover:bg-white/25 text-white cursor-pointer select-none z-[101]";
  const node = (
    <div
      // 全屏底用 --viewer-bg（设计定稿 #0B0A09，两主题同值，与 iOS 同源）。
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--viewer-bg)]"
      // 主窗口顶部 40px 是标题栏拖拽区（shell.ts 的 -webkit-app-region:drag）。拖拽区吃掉
      // 鼠标事件**不看 z-index**，所以右上角工具条的上半截落在 0–40px 里就点不动 ——
      // 验收实锤「按钮只有下半部分能点」。全屏浮层打开时整块声明 no-drag。
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      onClick={onClose}>
      {/* 工具条 */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-[101]" onClick={(e) => e.stopPropagation()}>
        {canNav ? <span className="text-white/80 text-[12px] mr-1 select-none whitespace-nowrap">{cur + 1} / {list.length}</span> : null}
        {/* 六个动作原先都是字符（－＋⟲⭳✕）。字符图标的字形、粗细、基线随系统字体走，
            六个摆一排会明显参差；换成同一套线性描边图标之后尺寸和光学重心才对得齐。 */}
        <button className={btn} title="缩小" onClick={() => zoom(-0.25)}><IconMinus size={15} /></button>
        <span className="text-white/80 text-[12px] w-12 text-center select-none">{Math.round(scale * 100)}%</span>
        <button className={btn} title="放大" onClick={() => zoom(0.25)}><IconPlus size={15} /></button>
        <button className={btn} title="重置" onClick={reset}><IconRefresh size={15} /></button>
        <button className={btn} title="下载" onClick={download}><IconDownload size={15} /></button>
        <button className={btn} title="关闭" onClick={onClose}><IconX size={15} /></button>
      </div>
      {/* 文件名：左上角，和工具条同一行。多图切换时靠它认现在看的是哪张。 */}
      {item.alt ? (
        <div className="absolute top-4 left-4 max-w-[40vw] truncate text-white/80 text-[12.5px] select-none z-[101]" onClick={(e) => e.stopPropagation()}>{item.alt}</div>
      ) : null}
      {canNav ? (
        <>
          <button className={`${navBtn} left-4`} title="上一张（←）" onClick={(e) => { e.stopPropagation(); go(-1); }}><IconChevronLeft size={18} /></button>
          <button className={`${navBtn} right-4`} title="下一张（→）" onClick={(e) => { e.stopPropagation(); go(1); }}><IconChevronRight size={18} /></button>
        </>
      ) : null}
      {/* 图片（可拖动、滚轮缩放）。key 跟着 src 走：切图时让 <img> 重建，别让上一张的尺寸撑着过渡。 */}
      <img
        key={item.src}
        src={item.src}
        alt={item.alt || ""}
        draggable={false}
        onClick={(e) => e.stopPropagation()}
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
