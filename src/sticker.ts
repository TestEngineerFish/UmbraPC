// 贴图窗口渲染层（vanilla）：显示图片 + 拖移 + 滚轮缩放 + 右键菜单 + Esc/双击关闭。
interface StickerAPI {
  getImage(): Promise<string>;
  move(x: number, y: number): Promise<void>;
  setScale(scale: number): Promise<void>;
  showMenu(): Promise<void>;
  close(): Promise<void>;
}
const api = (window as unknown as { umbraSticker: StickerAPI }).umbraSticker;

const img = document.getElementById("sticker-img") as HTMLImageElement;
api.getImage().then((url) => {
  if (url) img.src = url;
});

// 拖拽移动：mousedown 记录窗口内偏移，mousemove 用 screenX/Y 反推窗口左上角。
let dragging = false;
let offX = 0;
let offY = 0;
window.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  dragging = true;
  offX = e.clientX;
  offY = e.clientY;
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  api.move(e.screenX - offX, e.screenY - offY);
});
window.addEventListener("mouseup", () => {
  dragging = false;
});

// 滚轮缩放（0.2–3 倍，以中心）。
let scale = 1;
window.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    scale = Math.max(0.2, Math.min(3, scale * (1 - e.deltaY * 0.0015)));
    api.setScale(scale);
  },
  { passive: false },
);

// 右键原生菜单
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  api.showMenu();
});

// Esc / 双击关闭
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") api.close();
});
window.addEventListener("dblclick", () => api.close());
