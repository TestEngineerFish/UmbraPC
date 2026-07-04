// 贴图窗口（React）：显示图片 + 拖移 + 滚轮缩放 + 右键菜单 + Esc/双击关闭。
import { useEffect, useRef, useState } from "react";

interface StickerAPI {
  getImage(): Promise<string>;
  move(x: number, y: number): Promise<void>;
  setScale(scale: number): Promise<void>;
  showMenu(): Promise<void>;
  close(): Promise<void>;
}
const api = (window as unknown as { umbraSticker: StickerAPI }).umbraSticker;

export function Sticker() {
  const [src, setSrc] = useState("");
  const scale = useRef(1);
  const off = useRef({ x: 0, y: 0 });
  const dragging = useRef(false);

  useEffect(() => {
    api.getImage().then((u) => {
      if (u) setSrc(u);
    });
    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
      dragging.current = true;
      off.current = { x: e.clientX, y: e.clientY };
    };
    const move = (e: MouseEvent) => {
      if (dragging.current) api.move(e.screenX - off.current.x, e.screenY - off.current.y);
    };
    const up = () => {
      dragging.current = false;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      scale.current = Math.max(0.2, Math.min(3, scale.current * (1 - e.deltaY * 0.0015)));
      api.setScale(scale.current);
    };
    const ctx = (e: MouseEvent) => {
      e.preventDefault();
      api.showMenu();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") api.close();
    };
    const dbl = () => api.close();
    window.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("contextmenu", ctx);
    window.addEventListener("keydown", key);
    window.addEventListener("dblclick", dbl);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("contextmenu", ctx);
      window.removeEventListener("keydown", key);
      window.removeEventListener("dblclick", dbl);
    };
  }, []);

  return <img src={src} draggable={false} alt="" style={{ width: "100vw", height: "100vh", display: "block", objectFit: "fill", border: "1px solid rgba(255,255,255,0.35)", boxSizing: "border-box", WebkitUserDrag: "none" } as React.CSSProperties} />;
}

