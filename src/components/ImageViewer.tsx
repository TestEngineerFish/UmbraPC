// 通用图片预览器（可复用）：全屏遮罩看大图，支持放大/缩小、拖动、下载、ESC/点击背景关闭。
// 用法：受控组件——传 src 打开、onClose 关闭。
import { useEffect, useRef, useState } from "react";

export function ImageViewer({ src, alt, onClose }: { src: string | null; alt?: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  // 每次打开新图重置视图。
  useEffect(() => {
    if (src) { setScale(1); setTx(0); setTy(0); }
  }, [src]);

  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") setScale((s) => Math.min(s + 0.25, 8));
      else if (e.key === "-") setScale((s) => Math.max(s - 0.25, 0.25));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src, onClose]);

  if (!src) return null;

  const zoom = (d: number) => setScale((s) => Math.min(8, Math.max(0.25, +(s + d).toFixed(2))));
  const download = async () => {
    try {
      const resp = await fetch(src);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (alt || "image").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) + ".png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { /* ignore */ }
  };

  const btn = "w-9 h-9 flex items-center justify-center rounded-full bg-white/15 hover:bg-white/25 text-white text-[16px] cursor-pointer select-none";
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80" onClick={onClose}>
      {/* 工具条 */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-[101]" onClick={(e) => e.stopPropagation()}>
        <button className={btn} title="缩小" onClick={() => zoom(-0.25)}>－</button>
        <span className="text-white/80 text-[12px] w-12 text-center select-none">{Math.round(scale * 100)}%</span>
        <button className={btn} title="放大" onClick={() => zoom(0.25)}>＋</button>
        <button className={btn} title="重置" onClick={() => { setScale(1); setTx(0); setTy(0); }}>⟲</button>
        <button className={btn} title="下载" onClick={download}>⭳</button>
        <button className={btn} title="关闭" onClick={onClose}>✕</button>
      </div>
      {/* 图片（可拖动、滚轮缩放） */}
      <img
        src={src}
        alt={alt || ""}
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
}
