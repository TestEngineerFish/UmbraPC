// 独立图片查看窗（批次 011：从「窗口内全屏遮罩」改成真窗口 —— 不遮首页，
// 看图的同时主窗口照常操作；后期任何窗口要看图都走这一扇）。
//
// 形态按稿：无边框深底（--viewer-bg）、顶部悬浮工具条即拖动区、**不置顶**
// （普通窗层级，可以被主窗压住）、**同时只开一扇**（再点开换内容并前置）——
// 多开对比先不做：需求还没出现，开了就得管 N 个窗的生命周期，
// 还会和「保险箱锁定连带关窗」叠成一堆边界。
// 内容通道走 largetype 同款范式：open 存 pending → 渲染层 ready 索取 →
// 已开着就直接推 viewer:data 就地换图，不闪窗。
import * as path from "node:path";

export interface ViewerPayload {
  items: { src: string; alt?: string }[];
  index: number;
  /** 内容来源：保险箱的图是解密后的 data URL，锁定时要连带关窗（见 closeIfSource）。 */
  source?: string;
}

interface ViewerOpts {
  preloadPath: string;
  devUrl: string;
  distDir: string;
}

let win: Electron.BrowserWindow | null = null;
let pending: ViewerPayload | null = null;
let opts: ViewerOpts | null = null;

/** main.ts 启动时注册一次：拿窗口参数 + 挂 IPC。 */
export async function registerImageViewer(o: ViewerOpts): Promise<void> {
  opts = o;
  const { ipcMain } = await import("electron");
  ipcMain.handle("viewer:open", (_e, payload: ViewerPayload) => openImageViewer(payload));
  ipcMain.handle("viewer:ready", () => pending);
  ipcMain.handle("viewer:close", () => { if (win && !win.isDestroyed()) win.close(); });
  // 渲染层图片 load 后上报原始尺寸 → 按比例适配窗口（上限 80% 屏、下限 420×320，稿定）。
  // 只在**换图**时调，用户手动拉过的窗口不抢着改（renderer 只在打开/切图时上报）。
  ipcMain.handle("viewer:fit", (_e, w: number, h: number) => {
    if (!win || win.isDestroyed()) return;
    void import("electron").then(({ screen }) => {
      if (!win || win.isDestroyed()) return;
      const wa = screen.getDisplayMatching(win.getBounds()).workArea;
      const maxW = Math.round(wa.width * 0.8), maxH = Math.round(wa.height * 0.8);
      // 图片区外还有工具条(52) + 脚注(~40)的呼吸空间。
      const k = Math.min(1, maxW / Math.max(1, w), (maxH - 92) / Math.max(1, h));
      const tw = Math.max(420, Math.round(w * k));
      const th = Math.max(320, Math.round(h * k) + 92);
      const b = win.getBounds();
      // 以当前中心为锚缩放，别每次都跳回屏幕中央。
      win.setBounds({
        x: Math.round(b.x + (b.width - tw) / 2),
        y: Math.round(b.y + (b.height - th) / 2),
        width: tw, height: th,
      });
    });
  });
}

export async function openImageViewer(payload: ViewerPayload): Promise<void> {
  if (!opts) return;
  const items = (payload?.items || []).filter((it) => it && it.src);
  if (!items.length) return;
  pending = { items, index: Math.max(0, Math.min(payload.index || 0, items.length - 1)), source: payload.source };
  const { BrowserWindow, screen } = await import("electron");
  if (win && !win.isDestroyed()) {
    // 已开着：换内容并前置（单实例，稿定）。show() 会给它焦点 —— 用户就是点开它的。
    win.webContents.send("viewer:data", pending);
    win.show();
    return;
  }
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const w = Math.min(960, Math.round(wa.width * 0.7));
  const h = Math.min(700, Math.round(wa.height * 0.75));
  const b = new BrowserWindow({
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: Math.round(wa.y + (wa.height - h) / 2),
    width: w, height: h, minWidth: 420, minHeight: 320,
    frame: false,
    backgroundColor: "#0B0A09",   // --viewer-bg，两主题同值
    show: false,
    skipTaskbar: false,           // 它是正经窗口，任务栏/Dock 里该有一席
    webPreferences: { preload: opts.preloadPath, contextIsolation: true, nodeIntegration: false },
  });
  if (opts.devUrl) b.loadURL(`${opts.devUrl}/viewer.html`).catch(() => {});
  else b.loadFile(path.join(opts.distDir, "viewer.html")).catch(() => {});
  b.once("ready-to-show", () => b.show());
  b.on("closed", () => { win = null; pending = null; });
  win = b;
}

/** 关掉图片窗（若开着）。source 给了就只在**当前内容来自该来源**时关 ——
 *  保险箱锁定时只该带走保险箱的图，别把用户正看着的记账凭证一起关掉。 */
export function closeImageViewer(source?: string): void {
  if (!win || win.isDestroyed()) return;
  if (source && pending?.source !== source) return;
  win.close();
}
