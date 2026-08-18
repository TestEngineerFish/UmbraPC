// 截图编排（主进程）：抓屏 + 常驻覆盖窗（无感打开）+ 全局快捷键 + 输出 IPC。
// 阶段1：抓屏/覆盖窗/框选/核心标注/复制·保存。OCR/翻译/贴图在后续阶段接入（此处留 IPC 占位）。
// 滚动长截图：用户手动滚页面，主进程定时重抓选区，交给 ScrollStitcher 去重叠拼接（见 ./scroll）。
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { ConfigStore } from "../config";
import { mt } from "../../i18n";
import { ocrImage, translateImage } from "./ocr";
import { StickerManager } from "./stickers";
import { ScrollStitcher } from "./scroll";
import { loadNut, requireAccessibility } from "../computer";
import { suppressAppActivate } from "../activation";
import { accelProblem } from "../launcher/hotkey";
import {
  ALL_WORKSPACES,
  detectAppWasActive,
  markOverlayWindow,
  pinOverlayToCurrentDesktop,
  presentOverlayWindow,
  releaseOverlayFocus,
  waitDidFinishLoad,
  type OverlayForeground,
} from "../shared/overlay-focus";

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

// 选区：覆盖窗内的 CSS 像素坐标，与渲染层的 Selection 同构。
interface SelectionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// 一次滚动长截图会话的运行时状态。
interface ScrollSession {
  stitcher: ScrollStitcher;
  timer: NodeJS.Timeout | null;
  display: Electron.Display;
  box: Electron.Rectangle; // 选区在抓屏位图里的裁剪框（物理像素）
  busy: boolean;           // 上一帧还没处理完时跳过本次 tick，避免堆积
  // 自动滚：开着就在每帧之后替用户滚一下（nut.js 模拟滚轮），到底自动关掉。
  auto: boolean;
  point: { x: number; y: number }; // 选区中心的全局逻辑坐标——滚轮事件要送到这个位置
  sameStreak: number;              // 连续抓到「没有新内容」的次数，用来判到底
  atBottom: boolean;               // 已判定滚到底（自动滚会停下，等用户确认收工）
  autoError: string;               // 自动滚失败原因（多半是没给辅助功能权限），显示在控制条上
}

// ── 滚动长截图参数 ──

// 抓帧间隔（毫秒）。每帧都要抓一次整屏再裁剪，太快 CPU 顶不住；
// 太慢则用户稍微滚快一点就跨过一屏、咬不上重叠。250ms 是手感与开销的折中。
const SCROLL_TICK_MS = 250;

// 选区高度下限（物理像素）。太矮的选区放不下探针，匹配没有意义。
const SCROLL_MIN_HEIGHT = 80;

// 滚动过程中覆盖窗缩成的「控制条」尺寸与留白（逻辑像素）。
// 复用覆盖窗而不是另开一个窗口：省掉一套 html 入口，状态也还在同一个 React 实例里。
const SCROLL_BAR_W = 500;
const SCROLL_BAR_H = 86;
const SCROLL_BAR_MARGIN = 24;

// 自动滚每次滚几格。多数应用一格 3~5 行，5 格约半屏——既留得下重叠区，又不用截太多帧。
const AUTO_SCROLL_CLICKS = 5;

// 连续多少帧「没有新内容」才判定滚到底。给几帧是因为页面加载慢时会有短暂的原地不动。
const AUTO_BOTTOM_STREAK = 3;

export class ScreenshotManager {
  private overlay: Electron.BrowserWindow | null = null;
  private capturing = false;
  private lastCapture: CaptureResult | null = null;
  private showFallback: NodeJS.Timeout | null = null;
  // 非 null 表示正在滚动长截图（此时覆盖窗缩成了底部控制条）。
  private scroll: ScrollSession | null = null;
  private appWasActive = false;
  private savedFg: OverlayForeground | null = null;
  private rebuilding = false;

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
    const bad = accelProblem(acc);
    if (bad) { console.warn(`[screenshot] 快捷键用不了（${bad}）：${acc} —— 去设置里重录一次`); return; }
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
  private permGranted = false; // 授权过一次就不用每次触发都再查一遍

  // 预热：启动后就把覆盖窗建好、页面加载完（隐藏着）。
  // 首次截图否则要现场建窗 + 加载 screenshot.html + 首帧渲染，快门明显迟滞。
  async warmup(): Promise<void> {
    try {
      await this.ensureOverlay();
    } catch {
      /* 预热失败不影响功能 */
    }
  }

  private async ensureScreenPermission(): Promise<boolean> {
    if (process.platform !== "darwin") return true;
    if (this.permGranted) return true;
    const { systemPreferences, desktopCapturer, dialog, shell } = await import("electron");
    if (systemPreferences.getMediaAccessStatus("screen") === "granted") {
      this.permGranted = true;
      return true;
    }
    // 先调一次 desktopCapturer，让应用出现在系统设置的屏幕录制列表里。
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
    const r = await dialog.showMessageBox({
      type: "info",
      buttons: [mt("electron.goAuthorize"), mt("common.cancel")],
      defaultId: 0,
      cancelId: 1,
      message: mt("electron.screenPermTitle"),
      detail: mt("electron.screenPermDetail"),
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
  private async ensureOverlay(forceNew = false): Promise<Electron.BrowserWindow> {
    if (!forceNew && this.overlay && !this.overlay.isDestroyed()) return this.overlay;
    if (this.overlay && !this.overlay.isDestroyed()) {
      this.rebuilding = true;
      try { this.overlay.destroy(); } catch { /* 重建途中 */ }
      this.overlay = null;
      this.rebuilding = false;
    }
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
    win.setVisibleOnAllWorkspaces(true, ALL_WORKSPACES);
    markOverlayWindow(win);
    const loaded = waitDidFinishLoad(win);
    if (this.opts.devUrl) win.loadURL(`${this.opts.devUrl}/screenshot.html`).catch(() => {});
    else win.loadFile(path.join(this.opts.distDir, "screenshot.html")).catch(() => {});
    await loaded;
    this.overlay = win;
    return win;
  }

  async trigger(): Promise<void> {
    if (this.capturing) return; // 进行中忽略重复触发
    const fg = await detectAppWasActive();
    this.appWasActive = fg.appWasActive;
    this.savedFg = fg.saved;
    const ok = await this.ensureScreenPermission();
    if (!ok) return;
    const cap = await this.capture();
    if (!cap) return;
    this.capturing = true;
    this.lastCapture = cap;
    let win = await this.ensureOverlay();
    if (!pinOverlayToCurrentDesktop(win, this.savedFg)) win = await this.ensureOverlay(true);
    win.setBounds(cap.bounds);
    // 渲染层收到会话事件 → 重置状态、加载冻结画面 → onLoad 后调 ready 显示窗口。
    win.webContents.send("screenshot:session", cap);
    if (this.showFallback) clearTimeout(this.showFallback);
    this.showFallback = setTimeout(() => this.showOverlay(), 1500); // 兜底强制显示
  }

  private showOverlay(): void {
    if (this.rebuilding) return;
    if (this.showFallback) {
      clearTimeout(this.showFallback);
      this.showFallback = null;
    }
    if (!this.overlay || this.overlay.isDestroyed() || !this.lastCapture) return;
    this.overlay.setBounds(this.lastCapture.bounds);
    pinOverlayToCurrentDesktop(this.overlay, this.savedFg);
    suppressAppActivate(); // 同上：别让覆盖窗的激活把主窗口拽出来
    presentOverlayWindow(this.overlay);
  }

  private hideOverlay(): void {
    this.capturing = false;
    this.abortScroll(); // 截图整体结束时，顺手把还挂着的滚动会话拆掉（定时器不能留）
    const win = this.overlay;
    // 先还焦点再藏窗：Windows 上如果先 hide，焦点会落到另一桌面的贴图/主窗口。
    void releaseOverlayFocus({ appWasActive: this.appWasActive, saved: this.savedFg, returnFocus: true }).then(() => {
      if (win && !win.isDestroyed()) {
        win.setAlwaysOnTop(true, "screen-saver");
        if (win.isVisible()) win.hide();
      }
    });
  }

  // ── 滚动长截图 ──
  // 流程：渲染层框好选区后点「长截图」→ startScroll 把覆盖窗缩成控制条、开始定时抓帧 →
  // 用户自己滚页面，每帧交给 ScrollStitcher 去重叠追加 → 点「完成」→ stopScroll 拼图并回传长图。

  /** 抓取指定显示器的整屏画面，裁出 box（物理像素）并返回 BGRA 位图；抓不到返回 null。 */
  private async captureRegion(display: Electron.Display, box: Electron.Rectangle): Promise<Buffer | null> {
    const { desktopCapturer } = await import("electron");
    const sf = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) },
    });
    const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!src) return null;
    return src.thumbnail.crop(box).toBitmap();
  }

  /**
   * 算控制条该摆哪儿：优先选区下方、其次上方，都放不下才退到屏幕底部。
   *
   * 为什么要躲开选区：控制条本身也在屏幕上，压住选区就会被一起抓进长图，
   * 而且它的文字每帧都在变，会让重叠匹配彻底失效。
   */
  private scrollBarBounds(display: Electron.Display, sel: SelectionRect): Electron.Rectangle {
    const b = display.bounds;
    const x = Math.round(b.x + (b.width - SCROLL_BAR_W) / 2);
    const below = b.y + sel.y + sel.h + SCROLL_BAR_MARGIN;
    if (below + SCROLL_BAR_H <= b.y + b.height) {
      return { x, y: Math.round(below), width: SCROLL_BAR_W, height: SCROLL_BAR_H };
    }
    const above = b.y + sel.y - SCROLL_BAR_MARGIN - SCROLL_BAR_H;
    if (above >= b.y) {
      return { x, y: Math.round(above), width: SCROLL_BAR_W, height: SCROLL_BAR_H };
    }
    // 兜底：选区几乎占满整屏，控制条只能压在上面（长图会带上这条，属已知限制）。
    return { x, y: Math.round(b.y + b.height - SCROLL_BAR_H - SCROLL_BAR_MARGIN), width: SCROLL_BAR_W, height: SCROLL_BAR_H };
  }

  /** 开始滚动长截图。返回 {ok:false, error} 时渲染层原地留在标注阶段并提示。 */
  private async startScroll(sel: SelectionRect): Promise<{ ok: boolean; error?: string }> {
    if (this.scroll) return { ok: false, error: mt("screenshot.scrollBusy") };
    if (!this.lastCapture || !this.overlay || this.overlay.isDestroyed()) {
      return { ok: false, error: mt("screenshot.scrollNoSession") };
    }
    const { screen } = await import("electron");
    const display = screen.getDisplayMatching(this.lastCapture.bounds);
    const sf = this.lastCapture.scaleFactor || 1;
    const maxW = Math.round(display.size.width * sf);
    const maxH = Math.round(display.size.height * sf);
    const x = Math.max(0, Math.min(Math.round(sel.x * sf), maxW - 1));
    const y = Math.max(0, Math.min(Math.round(sel.y * sf), maxH - 1));
    const box: Electron.Rectangle = {
      x,
      y,
      width: Math.max(1, Math.min(Math.round(sel.w * sf), maxW - x)),
      height: Math.max(1, Math.min(Math.round(sel.h * sf), maxH - y)),
    };
    if (box.height < SCROLL_MIN_HEIGHT) return { ok: false, error: mt("screenshot.scrollTooShort") };

    const session: ScrollSession = {
      stitcher: new ScrollStitcher(box.width, box.height),
      timer: null,
      display,
      box,
      busy: false,
      auto: false,
      // 选区中心（全局逻辑坐标）：滚轮事件按光标位置派发，得先把光标挪到目标窗口上。
      point: {
        x: Math.round(display.bounds.x + sel.x + sel.w / 2),
        y: Math.round(display.bounds.y + sel.y + sel.h / 2),
      },
      sameStreak: 0,
      atBottom: false,
      autoError: "",
    };
    this.scroll = session;
    this.overlay.setBounds(this.scrollBarBounds(display, sel));
    // 先同步抓一帧：控制条一出现就该显示「已捕获 1 屏」，而不是空等一个 tick。
    await this.scrollTick();
    if (this.scroll !== session) return { ok: true }; // 抓第一帧期间用户就取消了
    session.timer = setInterval(() => void this.scrollTick(), SCROLL_TICK_MS);
    return { ok: true };
  }

  /** 抓一帧喂给拼接器，自动滚模式下顺手滚一屏，并把进度回传渲染层；顶到行数上限就自动收尾。 */
  private async scrollTick(): Promise<void> {
    const s = this.scroll;
    if (!s || s.busy) return;
    s.busy = true;
    try {
      const frame = await this.captureRegion(s.display, s.box);
      if (!frame || this.scroll !== s) return; // 期间会话已被取消/结束
      const r = s.stitcher.push(frame);

      // 自动滚：先判到底（连着几帧没有新内容），没到底就替用户滚一下。
      // 判到底只关掉自动滚、不直接收工——万一是页面在加载卡了一下，用户还能接着手动滚。
      if (s.auto) {
        s.sameStreak = r.status === "same" ? s.sameStreak + 1 : 0;
        if (s.sameStreak >= AUTO_BOTTOM_STREAK) {
          s.auto = false;
          s.atBottom = true;
        } else {
          await this.autoScrollOnce(s);
        }
      }

      this.overlay?.webContents.send("screenshot:scrollProgress", {
        rows: s.stitcher.rows,
        frameHeight: s.stitcher.frameHeight,
        gaps: s.stitcher.gaps,
        status: r.status,
        full: s.stitcher.full,
        auto: s.auto,
        atBottom: s.atBottom,
        autoError: s.autoError,
      });
      if (s.stitcher.full) await this.stopScroll(true);
    } catch (e) {
      console.warn("[screenshot] 滚动截图抓帧失败", e);
    } finally {
      s.busy = false;
    }
  }

  /**
   * 开/关自动滚。开之前先要辅助功能权限——没授权时 nut.js 的滚轮事件会被系统静默丢掉，
   * 表现成「点了没反应」，不如在这里就把原因说清楚。
   */
  private async setScrollAuto(on: boolean): Promise<{ ok: boolean; error?: string }> {
    const s = this.scroll;
    if (!s) return { ok: false, error: mt("screenshot.scrollNoSession") };
    if (!on) {
      s.auto = false;
      return { ok: true };
    }
    try {
      await requireAccessibility();
      await loadNut(); // 原生库首次加载可能失败（架构不匹配等），提前暴露
    } catch (e) {
      s.autoError = e instanceof Error ? e.message : String(e);
      return { ok: false, error: s.autoError };
    }
    s.autoError = "";
    s.sameStreak = 0;
    s.atBottom = false;
    s.auto = true;
    return { ok: true };
  }

  /** 把光标挪到选区中心并滚一下。失败（权限被中途撤销等）就关掉自动滚并把原因带给用户。 */
  private async autoScrollOnce(s: ScrollSession): Promise<void> {
    try {
      const nut = await loadNut();
      await nut.mouse.setPosition(new nut.Point(s.point.x, s.point.y));
      await nut.mouse.scrollDown(AUTO_SCROLL_CLICKS);
    } catch (e) {
      s.auto = false;
      s.autoError = e instanceof Error ? e.message : String(e);
      console.warn("[screenshot] 自动滚动失败，已切回手动", e);
    }
  }

  /**
   * 结束滚动长截图：commit=true 拼图并把长图回传渲染层，false 则只是取消。
   * 无论哪种都会把覆盖窗恢复成整屏并重新聚焦（键盘要能继续用）。
   */
  private async stopScroll(commit: boolean): Promise<{ ok: boolean }> {
    const s = this.scroll;
    if (!s) return { ok: false };
    this.scroll = null;
    if (s.timer) clearInterval(s.timer);

    let payload: Record<string, unknown>;
    if (!commit || s.stitcher.rows <= 0) {
      payload = { ok: false, canceled: true };
    } else {
      const { nativeImage } = await import("electron");
      const { data, width, height } = s.stitcher.result();
      const img = nativeImage.createFromBitmap(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { width, height });
      payload = {
        ok: true,
        dataUrl: img.toDataURL(),
        width,
        height,
        gaps: s.stitcher.gaps,
        screens: height / s.stitcher.frameHeight,
        // 覆盖窗恢复整屏后的 CSS 尺寸。渲染层要等窗口真的变回这个尺寸再排版长图——
        // setBounds 是异步生效的，紧接着就读 window.innerWidth 拿到的还是控制条那 460×86。
        view: this.lastCapture ? { width: this.lastCapture.bounds.width, height: this.lastCapture.bounds.height } : null,
      };
    }
    this.showOverlay(); // 恢复整屏 + 重新聚焦，随后渲染层才好接着标注
    this.overlay?.webContents.send("screenshot:scrollDone", payload);
    return { ok: true };
  }

  /** 拆掉还挂着的滚动会话（截图被整体取消/结束时调用），不回传任何结果。 */
  private abortScroll(): void {
    if (!this.scroll) return;
    if (this.scroll.timer) clearInterval(this.scroll.timer);
    this.scroll = null;
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
      const time = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
      const name = `${mt("electron.shotFilename", { time })}.png`;
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

    // 滚动长截图：开始（覆盖窗缩成控制条、定时抓帧）/ 结束（true=拼图回传，false=取消）。
    // 进度与结果走 screenshot:scrollProgress / screenshot:scrollDone 事件推回渲染层。
    ipcMain.handle("screenshot:scrollStart", (_e, sel: SelectionRect) => this.startScroll(sel));
    ipcMain.handle("screenshot:scrollStop", (_e, commit: boolean) => this.stopScroll(!!commit));
    ipcMain.handle("screenshot:scrollAuto", (_e, on: boolean) => this.setScrollAuto(!!on));

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
