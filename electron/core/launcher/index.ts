// 快捷入口 Launcher（类 Alfred）：全局快捷键唤起的浮层搜索窗。
// 输入 query → 并发查询各 Provider（app 启动 / 文件夹书签 / 剪贴板历史）→ 结果列表 → 回车执行 action。
// 窗口/焦点还原范式镜像 ClipboardManager。
import * as path from "node:path";
import { ConfigStore, expandHome, LauncherFolder } from "../config";
import { ClipStore } from "../clipboard/store";
import { writeToClipboard, simulatePaste } from "../clipboard/paste";
import { getAppIcon } from "../clipboard/source-app";
import { run } from "../shared/util";

// ── 结果与动作类型 ──
export interface LauncherAction {
  kind: "open_app" | "open_path" | "paste_clip" | "copy";
  payload: Record<string, unknown>;
}
export interface LauncherResult {
  id: string;              // 稳定 id（供 run 回查）
  title: string;
  subtitle?: string;
  icon?: string;           // data URL / emoji
  source: string;          // 来源 provider（app/folder/clipboard）
  score: number;           // 合并排序用
  action: LauncherAction;  // 主动作（回车执行）
}

interface ManagerOpts {
  preloadPath: string;
  devUrl: string;
  distDir: string;
}

const MAX_RESULTS = 12;

export class LauncherManager {
  private panel: Electron.BrowserWindow | null = null;
  private appWasActive = false;
  private cache = new Map<string, LauncherResult>();  // 本次查询结果，供 run 回查

  constructor(private cfg: ConfigStore, private clipStore: ClipStore, private opts: ManagerOpts, private reregister: () => void) {}

  async init(): Promise<void> {
    this.registerIpc();
    // 全局快捷键由 main.ts 统一注册（见 registerShortcut）。
  }

  // ── 面板窗口（镜像剪贴板面板）──
  private async ensurePanel(): Promise<Electron.BrowserWindow> {
    if (this.panel && !this.panel.isDestroyed()) return this.panel;
    const { BrowserWindow } = await import("electron");
    const win = new BrowserWindow({
      width: 720,
      height: 460,
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
    win.on("blur", () => this.hide(false));
    win.webContents.on("before-input-event", (_e, input) => {
      if (input.type === "keyDown" && input.key === "Escape") this.hide(true);
    });
    if (this.opts.devUrl) win.loadURL(`${this.opts.devUrl}/launcher.html`).catch(() => {});
    else win.loadFile(path.join(this.opts.distDir, "launcher.html")).catch(() => {});
    this.panel = win;
    return win;
  }

  async toggle(): Promise<void> {
    if (this.panel && !this.panel.isDestroyed() && this.panel.isVisible()) await this.hide(true);
    else await this.show();
  }

  private async show(): Promise<void> {
    const { BrowserWindow, screen } = await import("electron");
    this.appWasActive = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
    const win = await this.ensurePanel();
    // 每次唤起都居中到光标所在屏幕上方 1/3（Alfred 风格）。
    try {
      const pt = screen.getCursorScreenPoint();
      const wa = screen.getDisplayNearestPoint(pt).workArea;
      const [w] = win.getSize();
      win.setPosition(Math.round(wa.x + (wa.width - w) / 2), Math.round(wa.y + wa.height * 0.22));
    } catch { win.center(); }
    win.show();
    win.focus();
    win.webContents.send("launcher:shown");
  }

  private async hide(returnFocus = false): Promise<void> {
    if (this.panel && !this.panel.isDestroyed() && this.panel.isVisible()) this.panel.hide();
    if (returnFocus && !this.appWasActive && process.platform === "darwin") {
      const { app } = await import("electron");
      app.hide();
    }
  }

  // ── 全局快捷键（只注册自身；清理由 main.ts 统一做）──
  async registerShortcut(): Promise<void> {
    if (!this.cfg.get().launcherEnabled) return;
    const { globalShortcut } = await import("electron");
    const acc = this.cfg.get().launcherShortcut || "Alt+Space";
    try {
      const ok = globalShortcut.register(acc, () => this.toggle());
      if (!ok) console.warn(`[launcher] 快捷键注册失败（可能被占用）：${acc}`);
    } catch (e) {
      console.warn(`[launcher] 快捷键注册异常：${acc}`, e);
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.cfg.save({ launcherEnabled: enabled });
    this.reregister();
  }
  async setShortcut(acc: string): Promise<{ ok: boolean }> {
    await this.cfg.save({ launcherShortcut: acc });
    this.reregister();
    const { globalShortcut } = await import("electron");
    return { ok: globalShortcut.isRegistered(acc) };
  }

  // ── 查询分发 ──
  private async query(raw: string): Promise<LauncherResult[]> {
    const q = (raw || "").trim();
    const results: LauncherResult[] = [];
    // 并发各 provider（失败不影响其它）。
    const [apps, folders, clips] = await Promise.all([
      this.searchApps(q).catch(() => []),
      Promise.resolve(this.searchFolders(q)),
      Promise.resolve(this.searchClipboard(q)),
    ]);
    results.push(...folders, ...apps, ...clips);
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, MAX_RESULTS);
    this.cache.clear();
    for (const r of top) this.cache.set(r.id, r);
    return top;
  }

  // Provider①：启动 App（mdfind 搜已安装应用 + 提取图标）。
  private async searchApps(q: string): Promise<LauncherResult[]> {
    if (process.platform !== "darwin" || q.length < 1) return [];
    const res = await run("mdfind", [
      `kMDItemContentType == 'com.apple.application-bundle' && kMDItemDisplayName == '*${q}*'c`,
    ], { timeoutMs: 2500 });
    if (res.code !== 0) return [];
    const paths = res.output.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 6);
    const out: LauncherResult[] = [];
    for (const p of paths) {
      const name = path.basename(p).replace(/\.app$/i, "");
      const lower = name.toLowerCase();
      const ql = q.toLowerCase();
      const score = 100 + (lower === ql ? 60 : lower.startsWith(ql) ? 40 : 0);
      let icon = "";
      try { icon = await getAppIcon(p); } catch { /* 图标失败不阻塞 */ }
      out.push({
        id: `app:${p}`, title: name, subtitle: p, icon: icon || "📦", source: "app", score,
        action: { kind: "open_app", payload: { path: p } },
      });
    }
    return out;
  }

  // Provider②：文件夹书签（用指定软件打开固定文件夹）。
  private searchFolders(q: string): LauncherResult[] {
    const folders: LauncherFolder[] = this.cfg.get().launcherFolders || [];
    const ql = q.toLowerCase();
    return folders
      .map((f, i): LauncherResult | null => {
        const name = (f.name || path.basename(f.path)).trim();
        const hit = !q || name.toLowerCase().includes(ql) || (f.path || "").toLowerCase().includes(ql);
        if (!hit) return null;
        const score = 120 + (name.toLowerCase().startsWith(ql) ? 40 : 0);
        const via = f.app ? `用 ${f.app} 打开` : "打开文件夹";
        return {
          id: `folder:${i}`, title: name, subtitle: `${via} · ${f.path}`, icon: "📁", source: "folder", score,
          action: { kind: "open_path", payload: { path: f.path, app: f.app || "" } },
        };
      })
      .filter((r): r is LauncherResult => r !== null);
  }

  // Provider③：剪贴板历史（搜索文本，回车粘贴）。
  private searchClipboard(q: string): LauncherResult[] {
    if (q.length < 1) return [];
    const items = this.clipStore.list("text", q).slice(0, 5);
    return items.map((it): LauncherResult => ({
      id: `clip:${it.id}`,
      title: (it.preview || it.content || "").slice(0, 80),
      subtitle: "剪贴板 · 回车粘贴",
      icon: "📋", source: "clipboard", score: 60,
      action: { kind: "paste_clip", payload: { id: it.id } },
    }));
  }

  // ── 执行动作 ──
  private async runResult(id: string): Promise<boolean> {
    const r = this.cache.get(id);
    if (!r) return false;
    const a = r.action;
    if (a.kind === "open_app") {
      await run("open", [String(a.payload.path)]);
      await this.hide(false);
      return true;
    }
    if (a.kind === "open_path") {
      const p = expandHome(String(a.payload.path));
      const app = String(a.payload.app || "");
      await run("open", app ? ["-a", app, p] : [p]);
      await this.hide(false);
      return true;
    }
    if (a.kind === "copy") {
      const { clipboard } = await import("electron");
      clipboard.writeText(String(a.payload.text || ""));
      await this.hide(true);
      return true;
    }
    if (a.kind === "paste_clip") {
      const it = this.clipStore.get(Number(a.payload.id));
      if (!it) return false;
      await writeToClipboard(it);
      await this.hide(true);                       // 隐藏并把焦点还给原应用
      await new Promise((rr) => setTimeout(rr, 180));
      return await simulatePaste();
    }
    return false;
  }

  async setFolders(folders: LauncherFolder[]): Promise<void> {
    await this.cfg.save({ launcherFolders: Array.isArray(folders) ? folders : [] });
  }

  private async registerIpc(): Promise<void> {
    const { ipcMain, globalShortcut } = await import("electron");
    ipcMain.handle("launcher:query", (_e, q: string) => this.query(q));
    ipcMain.handle("launcher:run", (_e, id: string) => this.runResult(id));
    ipcMain.handle("launcher:hide", () => this.hide(true));
    ipcMain.handle("launcher:getSettings", () => {
      const c = this.cfg.get();
      return {
        enabled: c.launcherEnabled,
        shortcut: c.launcherShortcut,
        folders: c.launcherFolders || [],
        registered: globalShortcut.isRegistered(c.launcherShortcut || "Alt+Space"),
      };
    });
    ipcMain.handle("launcher:setEnabled", (_e, enabled: boolean) => this.setEnabled(enabled));
    ipcMain.handle("launcher:setShortcut", (_e, acc: string) => this.setShortcut(acc));
    ipcMain.handle("launcher:setFolders", (_e, folders: LauncherFolder[]) => this.setFolders(folders));
  }
}
