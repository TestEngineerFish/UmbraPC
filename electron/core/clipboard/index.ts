// 剪贴板历史编排：面板窗口 + 采集器 + 全局快捷键 + IPC。
import * as path from "node:path";
import { ClipStore, ClipCategory } from "./store";
import { ClipWatcher } from "./watcher";
import { writeToClipboard, simulatePaste } from "./paste";
import { getAppIcon } from "./source-app";
import { ConfigStore } from "../config";

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp)$/i;

interface ManagerOpts {
  preloadPath: string;
  devUrl: string;
  distDir: string; // 打包后 dist 目录
}

export class ClipboardManager {
  private store: ClipStore;
  private watcher: ClipWatcher;
  private panel: Electron.BrowserWindow | null = null;
  // 打开面板前 Umbra 自身是否已在前台。false=用户在别的应用里（如 Finder/Chrome），
  // 关闭面板时需把焦点还给那个应用，而不是让 Umbra 主窗口抢到前台。
  private appWasActive = false;

  // reregister：截图与剪贴板共用 globalShortcut，改快捷键时由 main.ts 统一清理后各自重注册。
  constructor(private cfg: ConfigStore, userData: string, private opts: ManagerOpts, private reregister: () => void) {
    this.store = new ClipStore(userData);
    this.watcher = new ClipWatcher(this.store, () => this.broadcast("clipboard:history:changed"));
  }

  async init(): Promise<void> {
    await this.store.load();
    if (this.cfg.get().clipboardEnabled) this.watcher.start();
    this.registerIpc();
    // 全局快捷键由 main.ts 统一注册（与截图共用 globalShortcut）。
  }

  // 共享剪贴板存储给快捷入口 Launcher（同一实例，避免两份读写同一文件冲突）。
  getStore(): ClipStore {
    return this.store;
  }

  // ── 面板窗口 ──
  private async ensurePanel(): Promise<Electron.BrowserWindow> {
    if (this.panel && !this.panel.isDestroyed()) return this.panel;
    const { BrowserWindow } = await import("electron");
    const win = new BrowserWindow({
      width: 680,
      height: 520,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      fullscreenable: false,
      backgroundColor: "#00000000",
      webPreferences: { preload: this.opts.preloadPath, contextIsolation: true, nodeIntegration: false },
    });
    win.setAlwaysOnTop(true, "floating");
    // 在「当前所在的桌面/屏幕」直接显示，不跟随窗口原 Space（否则会跳屏）。
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.on("blur", () => this.hidePanel(false));
    win.webContents.on("before-input-event", (_e, input) => {
      if (input.type === "keyDown" && input.key === "Escape") this.hidePanel(true);
    });
    if (this.opts.devUrl) win.loadURL(`${this.opts.devUrl}/clipboard-panel.html`).catch(() => {});
    else win.loadFile(path.join(this.opts.distDir, "clipboard-panel.html")).catch(() => {});
    this.panel = win;
    return win;
  }

  async togglePanel(): Promise<void> {
    if (this.panel && !this.panel.isDestroyed() && this.panel.isVisible()) {
      await this.hidePanel(true);
    } else {
      await this.showPanel();
    }
  }

  private async showPanel(): Promise<void> {
    const { BrowserWindow } = await import("electron");
    // 记录打开前 Umbra 是否已在前台（有窗口聚焦即为是）。
    this.appWasActive = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
    const win = await this.ensurePanel();
    // 每次唤起都重新定位到「光标所在屏幕」居中（不再只定位一次，否则会弹到上次/前台屏幕）。
    try {
      const { screen } = await import("electron");
      const pt = screen.getCursorScreenPoint();
      const disp = screen.getDisplayNearestPoint(pt);
      const wa = disp.workArea;
      const [w, h] = win.getSize();
      win.setPosition(Math.round(wa.x + (wa.width - w) / 2), Math.round(wa.y + (wa.height - h) / 2));
    } catch {
      win.center();
    }
    win.show();
    win.focus();
    win.webContents.send("clipboard:panel:shown");
  }

  // returnFocus=true 且打开面板前不在 Umbra 里时，隐藏整个 app，把焦点还给原应用
  // （否则 macOS 会把 Umbra 主窗口带到前台，粘贴也会落到主窗口而非原应用）。
  private async hidePanel(returnFocus = false): Promise<void> {
    if (this.panel && !this.panel.isDestroyed() && this.panel.isVisible()) this.panel.hide();
    if (returnFocus && !this.appWasActive && process.platform === "darwin") {
      const { app } = await import("electron");
      app.hide();
    }
  }

  // ── 全局快捷键 ──（只注册自身，不 unregisterAll；清理由 main.ts 统一做）
  async registerShortcut(): Promise<void> {
    const { globalShortcut } = await import("electron");
    const acc = this.cfg.get().clipboardShortcut || "Alt+V";
    try {
      const ok = globalShortcut.register(acc, () => this.togglePanel());
      if (!ok) console.warn(`[clipboard] 快捷键注册失败（可能被占用）：${acc}`);
    } catch (e) {
      console.warn(`[clipboard] 快捷键注册异常：${acc}`, e);
    }
  }

  // ── 采集开关 / 快捷键 / 清空（供设置页调用）──
  async setEnabled(enabled: boolean): Promise<void> {
    await this.cfg.save({ clipboardEnabled: enabled });
    if (enabled) this.watcher.start();
    else this.watcher.stop();
  }
  async setShortcut(acc: string): Promise<{ ok: boolean }> {
    await this.cfg.save({ clipboardShortcut: acc });
    this.reregister();
    const { globalShortcut } = await import("electron");
    return { ok: globalShortcut.isRegistered(acc) };
  }

  // 广播历史变更给所有窗口（面板 + 主窗口）。
  private async broadcast(channel: string, payload?: unknown): Promise<void> {
    const { BrowserWindow } = await import("electron");
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  }

  private async registerIpc(): Promise<void> {
    const { ipcMain, nativeImage } = await import("electron");

    ipcMain.handle("clip:list", (_e, category: ClipCategory, keyword: string) => this.store.list(category, keyword));

    ipcMain.handle("clip:copy", async (_e, id: number) => {
      const it = this.store.get(id);
      if (!it) return false;
      this.watcher.noteWriteBack(it.hash);
      await writeToClipboard(it);
      this.store.touch(id);
      this.broadcast("clipboard:history:changed");
      return true;
    });

    ipcMain.handle("clip:paste", async (_e, id: number) => {
      const it = this.store.get(id);
      if (!it) return false;
      this.watcher.noteWriteBack(it.hash);
      await writeToClipboard(it);
      this.store.touch(id);
      this.broadcast("clipboard:history:changed");
      await this.hidePanel(true); // 隐藏面板并把焦点还给原应用
      await new Promise((r) => setTimeout(r, 180)); // 等焦点切换完成
      return await simulatePaste();
    });

    ipcMain.handle("clip:setFavorite", (_e, id: number, favorite: boolean) => {
      const it = this.store.setFavorite(id, favorite); // 超上限抛错 → 渲染层 catch 展示
      this.broadcast("clipboard:history:changed");
      return !!it;
    });

    ipcMain.handle("clip:remove", (_e, id: number) => {
      this.store.remove(id);
      this.broadcast("clipboard:history:changed");
      return true;
    });

    ipcMain.handle("clip:clear", () => {
      this.store.clearNonFavorite();
      this.broadcast("clipboard:history:changed");
      return true;
    });

    ipcMain.handle("clip:readImageDataUrl", (_e, id: number) => {
      const it = this.store.get(id);
      if (!it || it.type !== "image") return "";
      const img = nativeImage.createFromPath(it.content);
      if (img.isEmpty()) return "";
      return img.resize({ width: 320 }).toDataURL();
    });

    ipcMain.handle("clip:readPathThumbnail", (_e, p: string) => {
      if (!p || !IMAGE_EXT.test(p)) return "";
      const img = nativeImage.createFromPath(p);
      if (img.isEmpty()) return "";
      return img.resize({ width: 320 }).toDataURL();
    });

    ipcMain.handle("clip:getAppIcon", (_e, p: string) => getAppIcon(p));

    ipcMain.handle("clip:hidePanel", () => {
      this.hidePanel(true);
      return true;
    });

    // 设置页
    ipcMain.handle("clip:getSettings", () => ({ enabled: this.cfg.get().clipboardEnabled, shortcut: this.cfg.get().clipboardShortcut }));
    ipcMain.handle("clip:setEnabled", (_e, enabled: boolean) => this.setEnabled(!!enabled));
    ipcMain.handle("clip:setShortcut", (_e, acc: string) => this.setShortcut(acc));
  }
}
