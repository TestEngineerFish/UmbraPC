// 贴图（Snipaste 式）：截图原位钉在桌面，可多张、拖移、滚轮缩放、右键原生菜单。
import * as path from "node:path";
import { promises as fs } from "node:fs";

interface StickerOpts {
  preloadPath: string;
  devUrl: string;
  distDir: string;
}

export class StickerManager {
  private images = new Map<number, string>(); // webContents.id → dataUrl
  private base = new Map<number, { w: number; h: number }>(); // 原始尺寸（缩放基准）
  private wins = new Map<number, Electron.BrowserWindow>();
  private ipcReady = false;

  constructor(private opts: StickerOpts) {}

  // 原位贴图：位置=显示器原点+选区坐标，大小=选区。
  async pin(dataUrl: string, selection: { x: number; y: number; w: number; h: number }, displayBounds: { x: number; y: number }): Promise<void> {
    await this.ensureIpc();
    const { BrowserWindow } = await import("electron");
    const w = Math.max(24, Math.round(selection.w));
    const h = Math.max(24, Math.round(selection.h));
    const win = new BrowserWindow({
      x: Math.round(displayBounds.x + selection.x),
      y: Math.round(displayBounds.y + selection.y),
      width: w,
      height: h,
      minWidth: 24,
      minHeight: 24,
      frame: false,
      transparent: false,
      resizable: true, // 支持拖边调整大小
      movable: true,
      hasShadow: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: { preload: this.opts.preloadPath, contextIsolation: true, nodeIntegration: false },
    });
    win.setAspectRatio(w / h); // 拖边缩放锁定原始比例
    win.setAlwaysOnTop(true, "floating");
    const id = win.webContents.id;
    this.images.set(id, dataUrl);
    this.base.set(id, { w, h });
    this.wins.set(id, win);
    win.on("closed", () => {
      this.images.delete(id);
      this.base.delete(id);
      this.wins.delete(id);
    });
    if (this.opts.devUrl) win.loadURL(`${this.opts.devUrl}/sticker.html`).catch(() => {});
    else win.loadFile(path.join(this.opts.distDir, "sticker.html")).catch(() => {});
  }

  private async ensureIpc(): Promise<void> {
    if (this.ipcReady) return;
    this.ipcReady = true;
    const { ipcMain, clipboard, nativeImage, dialog, Menu, app, BrowserWindow } = await import("electron");

    ipcMain.handle("stickers:getImage", (e) => this.images.get(e.sender.id) || "");

    ipcMain.handle("stickers:move", (e, x: number, y: number) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win) return;
      const [w, h] = win.getSize();
      win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
    });

    ipcMain.handle("stickers:setScale", (e, scale: number) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const b = this.base.get(e.sender.id);
      if (!win || !b) return;
      const s = Math.max(0.2, Math.min(3, scale));
      const nw = Math.round(b.w * s);
      const nh = Math.round(b.h * s);
      const cur = win.getBounds();
      const cx = cur.x + cur.width / 2;
      const cy = cur.y + cur.height / 2;
      win.setBounds({ x: Math.round(cx - nw / 2), y: Math.round(cy - nh / 2), width: nw, height: nh });
    });

    ipcMain.handle("stickers:close", (e) => {
      BrowserWindow.fromWebContents(e.sender)?.close();
    });

    ipcMain.handle("stickers:showMenu", (e) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win) return;
      const dataUrl = this.images.get(e.sender.id) || "";
      const menu = Menu.buildFromTemplate([
        {
          label: "复制",
          click: () => {
            const img = nativeImage.createFromDataURL(dataUrl);
            if (!img.isEmpty()) clipboard.writeImage(img);
          },
        },
        {
          label: "保存…",
          click: async () => {
            const now = new Date();
            const p = (n: number) => String(n).padStart(2, "0");
            const name = `Umbra截图-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.png`;
            const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("pictures"), name), filters: [{ name: "PNG", extensions: ["png"] }] });
            if (canceled || !filePath) return;
            const img = nativeImage.createFromDataURL(dataUrl);
            await fs.writeFile(filePath, img.toPNG());
          },
        },
        { type: "separator" },
        { label: "关闭贴图", click: () => win.close() },
        { label: "关闭全部贴图", click: () => this.closeAll() },
      ]);
      menu.popup({ window: win });
    });
  }

  closeAll(): void {
    for (const win of this.wins.values()) if (!win.isDestroyed()) win.close();
  }
}
