// 截图编排（主进程）：抓屏 + 常驻覆盖窗（无感打开）+ 全局快捷键 + 输出 IPC。
// 阶段1：抓屏/覆盖窗/框选/核心标注/复制·保存。OCR/翻译/贴图在后续阶段接入（此处留 IPC 占位）。
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { ConfigStore } from "../config";
import { ocrImage, translateImage } from "./ocr";
import { StickerManager } from "./stickers";

interface CaptureResult {
  dataUrl: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

interface ManagerOpts {
  preloadPath: string;
  devUrl: string;
  distDir: string;
}

export class ScreenshotManager {
  private overlay: Electron.BrowserWindow | null = null;
  private capturing = false;
  private lastCapture: CaptureResult | null = null;
  private showFallback: NodeJS.Timeout | null = null;

  private stickers: StickerManager;

  // reregister：截图与剪贴板共用 globalShortcut，改快捷键时由 main.ts 统一 unregisterAll 后各自重注册。
  constructor(private cfg: ConfigStore, private opts: ManagerOpts, private reregister: () => void) {
    this.stickers = new StickerManager(opts);
  }

  async init(): Promise<void> {
    this.registerIpc();
    // 无感打开：启动约 3s 后后台预创建并加载覆盖窗（不显示）。
    setTimeout(() => this.ensureOverlay().catch(() => {}), 3000);
  }

  // ── 全局快捷键 ──（只注册自身，不 unregisterAll；清理由 main.ts 统一做）
  async registerShortcut(): Promise<void> {
    const { globalShortcut } = await import("electron");
    if (!this.cfg.get().screenshotEnabled) return;
    const acc = this.cfg.get().screenshotShortcut || "CommandOrControl+Alt+A";
    try {
      const ok = globalShortcut.register(acc, () => this.trigger());
      if (!ok) console.warn(`[screenshot] 快捷键注册失败（可能被占用）：${acc}`);
    } catch (e) {
      console.warn(`[screenshot] 快捷键注册异常：${acc}`, e);
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.cfg.save({ screenshotEnabled: enabled });
    this.reregister();
  }
  async setShortcut(acc: string): Promise<{ ok: boolean }> {
    await this.cfg.save({ screenshotShortcut: acc });
    this.reregister();
    const { globalShortcut } = await import("electron");
    return { ok: globalShortcut.isRegistered(acc) };
  }

  // ── 权限（mac 屏幕录制）──
  private async ensureScreenPermission(): Promise<boolean> {
    if (process.platform !== "darwin") return true;
    const { systemPreferences, desktopCapturer, dialog, shell } = await import("electron");
    if (systemPreferences.getMediaAccessStatus("screen") === "granted") return true;
    // 先调一次 desktopCapturer，让应用出现在系统设置的屏幕录制列表里。
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
    const r = await dialog.showMessageBox({
      type: "info",
      buttons: ["去授权", "取消"],
      defaultId: 0,
      cancelId: 1,
      message: "需要「屏幕录制」权限",
      detail: "截图需在 系统设置 → 隐私与安全性 → 屏幕录制 中授权 Umbra（授权后需重启应用生效）。",
    });
    if (r.response === 0) shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    return false;
  }

  // ── 抓屏（光标所在显示器）──
  private async capture(): Promise<CaptureResult | null> {
    const { screen, desktopCapturer } = await import("electron");
    const pt = screen.getCursorScreenPoint();
    const disp = screen.getDisplayNearestPoint(pt);
    const sf = disp.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(disp.size.width * sf), height: Math.round(disp.size.height * sf) },
    });
    const src = sources.find((s) => s.display_id === String(disp.id)) || sources[0];
    if (!src) return null;
    return { dataUrl: src.thumbnail.toDataURL(), bounds: disp.bounds, scaleFactor: sf };
  }

  // ── 覆盖窗 ──
  private async ensureOverlay(): Promise<Electron.BrowserWindow> {
    if (this.overlay && !this.overlay.isDestroyed()) return this.overlay;
    const { BrowserWindow } = await import("electron");
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      frame: false,
      transparent: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      enableLargerThanScreen: true,
      // 覆盖窗承载文字工具的输入法上下文，禁用 mac panel 类型（NSPanel 无法挂输入法）。
      webPreferences: { preload: this.opts.preloadPath, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (this.opts.devUrl) win.loadURL(`${this.opts.devUrl}/screenshot.html`).catch(() => {});
    else win.loadFile(path.join(this.opts.distDir, "screenshot.html")).catch(() => {});
    this.overlay = win;
    return win;
  }

  async trigger(): Promise<void> {
    if (this.capturing) return; // 进行中忽略重复触发
    const ok = await this.ensureScreenPermission();
    if (!ok) return;
    const cap = await this.capture();
    if (!cap) return;
    this.capturing = true;
    this.lastCapture = cap;
    const win = await this.ensureOverlay();
    win.setBounds(cap.bounds);
    // 渲染层收到会话事件 → 重置状态、加载冻结画面 → onLoad 后调 ready 显示窗口。
    win.webContents.send("screenshot:session", cap);
    if (this.showFallback) clearTimeout(this.showFallback);
    this.showFallback = setTimeout(() => this.showOverlay(), 1500); // 兜底强制显示
  }

  private showOverlay(): void {
    if (this.showFallback) {
      clearTimeout(this.showFallback);
      this.showFallback = null;
    }
    if (!this.overlay || this.overlay.isDestroyed() || !this.lastCapture) return;
    this.overlay.setBounds(this.lastCapture.bounds);
    this.overlay.show();
    this.overlay.focus();
  }

  private hideOverlay(): void {
    this.capturing = false;
    // 层级恢复（文字输入阶段可能降过层级）
    if (this.overlay && !this.overlay.isDestroyed()) {
      this.overlay.setAlwaysOnTop(true, "screen-saver");
      this.overlay.hide();
    }
  }

  // ── IPC ──
  private async registerIpc(): Promise<void> {
    const { ipcMain, clipboard, nativeImage, dialog, app } = await import("electron");

    ipcMain.handle("screenshot:getCapture", () => this.lastCapture);
    ipcMain.handle("screenshot:ready", () => {
      this.showOverlay();
      return true;
    });
    ipcMain.handle("screenshot:cancel", () => {
      this.hideOverlay();
      return true;
    });

    // 完成/复制：PNG 写入剪贴板（剪贴板历史会自动收录），关闭截图。
    ipcMain.handle("screenshot:finish", (_e, dataUrl: string) => {
      if (dataUrl) {
        const img = nativeImage.createFromDataURL(dataUrl);
        if (!img.isEmpty()) clipboard.writeImage(img);
      }
      this.hideOverlay();
      return true;
    });

    // 保存：系统保存对话框，默认图片目录 + 时间戳文件名；保存后同时复制。
    ipcMain.handle("screenshot:save", async (_e, dataUrl: string) => {
      const now = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      const name = `Umbra截图-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.png`;
      const { canceled, filePath } = await dialog.showSaveDialog(this.overlay!, {
        defaultPath: path.join(app.getPath("pictures"), name),
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (canceled || !filePath) return null;
      const img = nativeImage.createFromDataURL(dataUrl);
      await fs.writeFile(filePath, img.toPNG());
      clipboard.writeImage(img); // 保存后同时复制
      this.hideOverlay();
      return filePath;
    });

    // 文字输入模式：激活应用 + 临时降层级（screen-saver 会盖住输入法候选窗）。阶段2 使用。
    ipcMain.handle("screenshot:setInputMode", (_e, active: boolean) => {
      if (!this.overlay || this.overlay.isDestroyed()) return;
      if (active) {
        app.focus({ steal: true });
        this.overlay.setAlwaysOnTop(true, "floating");
      } else {
        this.overlay.setAlwaysOnTop(true, "screen-saver");
      }
    });

    // OCR（识别选区原始画面，dataUrl 应为无标注底图）+ 翻译（PC 直连智谱）。结果在覆盖窗内展示，不关闭截图。
    ipcMain.handle("screenshot:ocr", (_e, dataUrl: string) => ocrImage(dataUrl));
    ipcMain.handle("screenshot:translate", (_e, dataUrl: string) => translateImage(dataUrl, this.cfg.get().glmApiKey));

    // 贴图：原位钉在桌面（选区坐标基于覆盖窗=显示器原点），然后关闭截图。
    ipcMain.handle("screenshot:pin", async (_e, dataUrl: string, selection: { x: number; y: number; w: number; h: number }) => {
      if (this.lastCapture && dataUrl) await this.stickers.pin(dataUrl, selection, this.lastCapture.bounds);
      this.hideOverlay();
      return { ok: true };
    });

    // 设置页
    ipcMain.handle("screenshot:getSettings", () => ({ enabled: this.cfg.get().screenshotEnabled, shortcut: this.cfg.get().screenshotShortcut, hasGlmKey: !!this.cfg.get().glmApiKey }));
    ipcMain.handle("screenshot:setEnabled", (_e, enabled: boolean) => this.setEnabled(!!enabled));
    ipcMain.handle("screenshot:setShortcut", (_e, acc: string) => this.setShortcut(acc));
    ipcMain.handle("screenshot:setGlmKey", (_e, key: string) => this.cfg.save({ glmApiKey: (key || "").trim() }).then(() => true));
  }
}
