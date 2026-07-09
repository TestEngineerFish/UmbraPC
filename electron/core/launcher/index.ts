// 快捷入口 Launcher（类 Alfred）：全局快捷键唤起的浮层搜索窗。
// 输入 query → 并发查询各 Provider（app 启动 / 文件夹书签 / 剪贴板历史）→ 结果列表 → 回车执行 action。
// 窗口/焦点还原范式镜像 ClipboardManager。
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { ConfigStore, expandHome, LauncherFolder, LauncherScript, Phrase, Workflow } from "../config";
import { ClipStore } from "../clipboard/store";
import { writeToClipboard, simulatePaste } from "../clipboard/paste";
import { getAppIcon } from "../clipboard/source-app";
import { run } from "../shared/util";
import { WorkflowEngine, migrateScriptsToWorkflows, migrateFoldersAndYoudao, seedBuiltinTools, NO_BRANCH } from "./workflow";

// ── 结果与动作类型 ──
export interface LauncherAction {
  kind: "open_app" | "open_path" | "paste_clip" | "paste_text" | "copy" | "run_script" | "workflow";
  payload: Record<string, unknown>;
}
export interface LauncherResult {
  id: string;              // 稳定 id（供 run 回查）
  title: string;
  subtitle?: string;
  icon?: string;           // data URL / emoji
  source: string;          // 来源 provider（app/folder/clipboard/workflow）
  score: number;           // 合并排序用
  action: LauncherAction;  // 主动作（回车执行）
  mods?: string[];         // 工作流结果的修饰键分支（如 ["cmd"]），供渲染层提示 ⌘ 分支
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
  private shownAt = 0;  // 唤起时刻：刚弹出瞬间的失焦（主窗口被激活抢焦）要忽略，避免立刻收起/来回切换
  private cache = new Map<string, LauncherResult>();  // 本次查询结果，供 run 回查
  private lastQuery = "";                              // 本次查询词，供 run 记录使用频率
  private usage: Record<string, { c: number; t: number }> = {};  // 使用频率学习：`${query}\n${id}` → {次数,最近}
  private usageFile: string;
  private engine: WorkflowEngine;  // 工作流执行引擎
  private wfWin: Electron.BrowserWindow | null = null;  // 工作流编排 独立窗口
  private largeWin: Electron.BrowserWindow | null = null;  // 大字显示浮层窗
  private pendingLarge = "";  // 大字待显示文本（等渲染层 ready 后发送）
  private largeBounds: Electron.Rectangle | null = null;  // 大字窗目标位置（渲染完成后再显示）

  constructor(private cfg: ConfigStore, private clipStore: ClipStore, userData: string, private opts: ManagerOpts, private reregister: () => void) {
    this.usageFile = path.join(userData, "launcher-usage.json");
    this.engine = new WorkflowEngine(cfg, {
      sendAssistant: (t) => this.chatSender?.(t),
      hide: (rf) => this.hide(rf),
      showLargeType: (t) => { void this.showLargeType(t); },
    });
  }

  async init(): Promise<void> {
    this.registerIpc();
    migrateScriptsToWorkflows(this.cfg);   // 一次性：旧脚本 → 工作流
    migrateFoldersAndYoudao(this.cfg);     // 一次性：文件夹书签 + 有道 → 工作流
    seedBuiltinTools(this.cfg);            // 一次性：编解码/计算/换算 → 默认工作流
    try { this.usage = JSON.parse(await fs.readFile(this.usageFile, "utf-8")); } catch { this.usage = {}; }
    // 预热：启动时就把浮层窗建好并加载渲染层（藏着），首次唤起即可秒开，避免忽快忽慢。
    try { await this.ensurePanel(); } catch { /* 预热失败不影响后续按需创建 */ }
    // 全局快捷键由 main.ts 统一注册（见 registerShortcut）。
  }

  // 使用频率学习：同一 query 下选过的项自动加权置顶。
  private usageKey(q: string, id: string): string { return `${q.trim().toLowerCase()}\n${id}`; }
  private boost(q: string, id: string): number {
    const u = this.usage[this.usageKey(q, id)];
    if (!u) return 0;
    return Math.min(u.c * 25, 200) + (Date.now() - u.t < 7 * 864e5 ? 20 : 0);
  }
  private noteUse(id: string): void {
    if (!this.lastQuery) return;
    const k = this.usageKey(this.lastQuery, id);
    const u = this.usage[k] || { c: 0, t: 0 };
    this.usage[k] = { c: u.c + 1, t: Date.now() };
    fs.mkdir(path.dirname(this.usageFile), { recursive: true })
      .then(() => fs.writeFile(this.usageFile, JSON.stringify(this.usage), "utf-8")).catch(() => {});
  }

  // ── 面板窗口（镜像剪贴板面板）──
  private async ensurePanel(): Promise<Electron.BrowserWindow> {
    if (this.panel && !this.panel.isDestroyed()) return this.panel;
    const { BrowserWindow } = await import("electron");
    const win = new BrowserWindow({
      width: 720,
      height: 96,            // 初始只放搜索框；有结果后由渲染层上报高度动态放大（launcher:resize）
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      fullscreenable: false,
      hasShadow: false,      // 阴影交给内部卡片画，避免透明窗留一圈方角暗影
      backgroundColor: "#00000000",
      webPreferences: { preload: this.opts.preloadPath, contextIsolation: true, nodeIntegration: false },
    });
    // floating 层级：压住主窗口即可；不要更高（如 pop-up-menu），否则会盖住系统输入法候选窗。
    win.setAlwaysOnTop(true, "floating");
    // 在「当前所在的桌面/屏幕」直接显示，不要切换到窗口原来所在的 Space（否则会跳屏）。
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 刚弹出瞬间主窗口可能被激活抢走焦点（macOS 激活 app 会带出其它窗口）→ 忽略这段时间的 blur 并夺回焦点。
    win.on("blur", () => {
      if (Date.now() - this.shownAt < 600) { if (!win.isDestroyed()) win.focus(); return; }
      this.hide(false);
    });
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
    this.shownAt = Date.now();
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
    this.lastQuery = q;
    const results: LauncherResult[] = [];

    // ① 工作流 keyword 触发优先（如 "yd hello" / "uni 你好"）。命中即独占返回。
    const wf = await this.engine.query(q).catch(() => [] as LauncherResult[]);
    if (wf.length) return this.finalize(q, wf);

    // ② 普通：并发 app/剪贴板 + 常用语 + 「始终触发」工作流（计算器/单位换算等）。
    const [apps, clips, always] = await Promise.all([
      this.searchApps(q).catch(() => []),
      Promise.resolve(this.searchClipboard(q)),
      this.engine.queryAlways(q).catch(() => [] as LauncherResult[]),
    ]);
    results.push(...always, ...this.searchPhrases(q), ...apps, ...clips);
    return this.finalize(q, results);
  }

  // Provider：常用语（按名称/内容/关键词搜；回车插入到前台）。
  private searchPhrases(q: string): LauncherResult[] {
    if (!q) return [];
    const ql = q.toLowerCase();
    const phrases = this.cfg.get().phrases || [];
    return phrases
      .map((p, i): LauncherResult | null => {
        const kw = (p.keyword || "").toLowerCase();
        const nameHit = (p.name || "").toLowerCase().includes(ql);
        const kwHit = kw && (kw === ql || kw.startsWith(ql));
        const contentHit = (p.content || "").toLowerCase().includes(ql);
        if (!nameHit && !kwHit && !contentHit) return null;
        const score = 130 + (kwHit ? 60 : nameHit ? 30 : 0) - i;  // 靠前的略高
        return {
          id: `phrase:${p.id}`, title: p.name || p.content.slice(0, 40),
          subtitle: `常用语 · 回车插入 · ${p.content.replace(/\s+/g, " ").slice(0, 50)}`,
          icon: "💬", source: "phrase", score,
          action: { kind: "paste_text", payload: { text: p.content } },
        };
      })
      .filter((r): r is LauncherResult => r !== null);
  }

  // 使用频率加权 + 排序 + 截断 + 缓存。
  private finalize(q: string, results: LauncherResult[]): LauncherResult[] {
    for (const r of results) r.score += this.boost(q, r.id);
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

  // 「发给秘书」：把当前输入直接发到 PC 聊天主会话（跳转聊天页 + 发送）。由 main.ts 注入回调。
  private chatSender?: (text: string) => void;
  setChatSender(fn: (text: string) => void): void { this.chatSender = fn; }
  private async sendAssistant(text: string): Promise<string> {
    const t = (text || "").trim();
    if (!t || !this.chatSender) return "";
    this.chatSender(t);          // 主进程 → 主窗口：跳聊天页并发送
    await this.hide(false);      // 关闭快捷入口（焦点交给主窗口）
    return "";
  }

  // 返回：空字符串=已隐藏窗口(无需提示)；非空=提示文案(渲染层弹 toast 后再隐藏)。
  // mod：回车分支修饰键（""=回车，"cmd"/"alt"…），仅工作流结果用。
  private async runResult(id: string, mod = ""): Promise<string> {
    const r = this.cache.get(id);
    if (!r) return "";
    this.noteUse(id);  // 学习：这次在该 query 下选了它
    const clip = async (text: string) => { const { clipboard } = await import("electron"); clipboard.writeText(text); };

    const a = r.action;
    if (a.kind === "workflow") {
      const fb = await this.engine.run(String(a.payload.token), mod);
      return fb === NO_BRANCH ? "" : fb;  // 无该修饰键分支 → 静默（渲染层已按 mods 决定是否走此路）
    }
    if (a.kind === "open_app") {
      await run("open", [String(a.payload.path)]);
      await this.hide(false);
      return "";
    }
    if (a.kind === "open_path") {
      const p = expandHome(String(a.payload.path));
      const app = String(a.payload.app || "");
      await run("open", app ? ["-a", app, p] : [p]);
      await this.hide(false);
      return "";
    }
    if (a.kind === "copy") {
      await clip(String(a.payload.text || ""));
      return "已复制 ✓";
    }
    if (a.kind === "run_script") {
      const cmd = String(a.payload.command || "");
      const input = String(a.payload.input || "");
      const res = await run("bash", ["-lc", cmd, "umbra", input], { timeoutMs: 20000 });
      const out = (res.output || "").trim();
      if (res.code !== 0) return `脚本出错：${out.slice(0, 40) || "非零退出"}`;
      if ((a.payload.output || "copy") === "copy" && out) { await clip(out); return `已复制：${out.slice(0, 30)}`; }
      return "已执行 ✓";
    }
    if (a.kind === "paste_clip") {
      const it = this.clipStore.get(Number(a.payload.id));
      if (!it) return "";
      await writeToClipboard(it);
      await this.hide(true);                       // 隐藏并把焦点还给原应用
      await new Promise((rr) => setTimeout(rr, 180));
      await simulatePaste();
      return "";
    }
    if (a.kind === "paste_text") {
      const text = String(a.payload.text || "");
      await clip(text);
      await this.hide(true);                       // 隐藏并把焦点还给原应用
      await new Promise((rr) => setTimeout(rr, 180));
      const ok = await simulatePaste();            // 未授权辅助功能则降级为仅复制
      return ok ? "" : "已复制 ✓";
    }
    return "";
  }

  async setFolders(folders: LauncherFolder[]): Promise<void> {
    await this.cfg.save({ launcherFolders: Array.isArray(folders) ? folders : [] });
  }

  private async registerIpc(): Promise<void> {
    const { ipcMain, globalShortcut } = await import("electron");
    ipcMain.handle("launcher:query", (_e, q: string) => this.query(q));
    ipcMain.handle("launcher:run", (_e, id: string, mod?: string) => this.runResult(id, mod || ""));
    ipcMain.handle("launcher:sendAssistant", (_e, text: string) => this.sendAssistant(text));
    ipcMain.handle("launcher:hide", () => this.hide(true));
    // 渲染层上报内容高度 → 窗口贴合内容（顶部锚点不变），消除空白/暗框。
    ipcMain.handle("launcher:resize", (_e, h: number) => {
      if (!this.panel || this.panel.isDestroyed()) return;
      const [w] = this.panel.getSize();
      const height = Math.max(96, Math.min(Math.round(Number(h) || 96), 720));
      this.panel.setSize(w, height);
    });
    // 选择文件夹/文件（书签路径可为文件夹或具体文件）。
    ipcMain.handle("launcher:pickPath", async () => {
      const { dialog } = await import("electron");
      const r = await dialog.showOpenDialog({ properties: ["openFile", "openDirectory"] });
      return r.canceled ? "" : (r.filePaths[0] || "");
    });
    // 选择用于打开的应用（返回应用名，供 open -a 使用）。
    ipcMain.handle("launcher:pickApp", async () => {
      const { dialog } = await import("electron");
      const r = await dialog.showOpenDialog({
        properties: ["openFile"], defaultPath: "/Applications",
        filters: [{ name: "Application", extensions: ["app"] }],
      });
      if (r.canceled || !r.filePaths[0]) return "";
      return path.basename(r.filePaths[0]).replace(/\.app$/i, "");
    });
    ipcMain.handle("launcher:getSettings", () => {
      const c = this.cfg.get();
      return {
        enabled: c.launcherEnabled,
        shortcut: c.launcherShortcut,
        folders: c.launcherFolders || [],
        scripts: c.launcherScripts || [],
        registered: globalShortcut.isRegistered(c.launcherShortcut || "Alt+Space"),
        youdaoConfigured: !!(c.youdaoAppKey && c.youdaoSecret),
      };
    });
    ipcMain.handle("launcher:setEnabled", (_e, enabled: boolean) => this.setEnabled(enabled));
    ipcMain.handle("launcher:setShortcut", (_e, acc: string) => this.setShortcut(acc));
    ipcMain.handle("launcher:setFolders", (_e, folders: LauncherFolder[]) => this.setFolders(folders));
    ipcMain.handle("launcher:setScripts", (_e, scripts: LauncherScript[]) =>
      this.cfg.save({ launcherScripts: Array.isArray(scripts) ? scripts : [] }));
    ipcMain.handle("launcher:setYoudao", (_e, appKey: string, secret: string) =>
      this.cfg.save({ youdaoAppKey: String(appKey || ""), youdaoSecret: String(secret || "") }));
    // 工作流读写（画布编辑器用）。写入后重注册 Hotkey 触发。
    ipcMain.handle("launcher:getWorkflows", () => this.cfg.get().launcherWorkflows || []);
    ipcMain.handle("launcher:setWorkflows", async (_e, workflows: Workflow[]) => {
      await this.cfg.save({ launcherWorkflows: Array.isArray(workflows) ? workflows : [] });
      this.reregister();  // 工作流里的 Hotkey 触发可能变化 → 重注册全局快捷键
    });
    ipcMain.handle("launcher:openWorkflowEditor", () => this.openWorkflowEditor());
    // 常用语读写（设置页管理）。
    ipcMain.handle("launcher:getPhrases", () => this.cfg.get().phrases || []);
    ipcMain.handle("launcher:setPhrases", (_e, phrases: Phrase[]) => this.cfg.save({ phrases: Array.isArray(phrases) ? phrases : [] }));
    // 大字显示浮层：渲染层 ready 时索取文本；渲染完成后再显示窗口（去残影）；关闭时隐藏。
    ipcMain.handle("largetype:ready", () => this.pendingLarge);
    ipcMain.handle("largetype:rendered", () => {
      if (!this.largeWin || this.largeWin.isDestroyed()) return;
      if (this.largeBounds) this.largeWin.setBounds(this.largeBounds);
      this.largeWin.showInactive();
      this.largeWin.focus();
    });
    ipcMain.handle("largetype:close", () => { if (this.largeWin && !this.largeWin.isDestroyed()) this.largeWin.hide(); });
    // 文件/App 图标 → dataURL（工作流编辑器 Launch 列表用）。
    ipcMain.handle("launcher:fileIcon", async (_e, p: string) => {
      try {
        const { app } = await import("electron");
        const ep = expandHome(String(p || ""));
        if (/\.app$/i.test(ep)) { try { const ic = await getAppIcon(ep); if (ic) return ic; } catch { /* 退回 getFileIcon */ } }
        const img = await app.getFileIcon(ep, { size: "normal" });
        return img && !img.isEmpty() ? img.toDataURL() : "";
      } catch { return ""; }
    });
  }

  // 打开「工作流编排」独立窗口（带原生标题栏，不覆盖主窗口）。
  async openWorkflowEditor(): Promise<void> {
    const { BrowserWindow } = await import("electron");
    if (this.wfWin && !this.wfWin.isDestroyed()) { this.wfWin.show(); this.wfWin.focus(); return; }
    const win = new BrowserWindow({
      width: 1060, height: 720, minWidth: 840, minHeight: 560,
      title: "工作流编排",
      backgroundColor: "#15110E",
      webPreferences: { preload: this.opts.preloadPath, contextIsolation: true, nodeIntegration: false },
    });
    if (this.opts.devUrl) win.loadURL(`${this.opts.devUrl}/workflow.html`).catch(() => {});
    else win.loadFile(path.join(this.opts.distDir, "workflow.html")).catch(() => {});
    win.on("closed", () => { this.wfWin = null; });
    this.wfWin = win;
  }

  // 大字显示：全屏透明浮层，居中放大显示内容（点击/Esc 关闭）。
  // 窗口先隐藏，渲染层把新内容画好后回调 largetype:rendered 再显示，避免先闪出上次内容。
  async showLargeType(text: string): Promise<void> {
    const t = (text || "").trim();
    if (!t) return;
    this.pendingLarge = t;
    const { BrowserWindow, screen } = await import("electron");
    this.largeBounds = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    if (!this.largeWin || this.largeWin.isDestroyed()) {
      const win = new BrowserWindow({
        x: this.largeBounds.x, y: this.largeBounds.y, width: this.largeBounds.width, height: this.largeBounds.height,
        frame: false, transparent: true, resizable: false, movable: false,
        skipTaskbar: true, show: false, fullscreenable: false, hasShadow: false,
        backgroundColor: "#00000000",
        webPreferences: { preload: this.opts.preloadPath, contextIsolation: true, nodeIntegration: false },
      });
      win.setAlwaysOnTop(true, "screen-saver");
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.on("blur", () => { if (this.largeWin && !this.largeWin.isDestroyed()) this.largeWin.hide(); });
      win.webContents.on("before-input-event", (_e, input) => { if (input.type === "keyDown" && input.key === "Escape") win.hide(); });
      if (this.opts.devUrl) win.loadURL(`${this.opts.devUrl}/largetype.html`).catch(() => {});
      else win.loadFile(path.join(this.opts.distDir, "largetype.html")).catch(() => {});
      win.webContents.on("did-finish-load", () => win.webContents.send("largetype:text", this.pendingLarge));
      this.largeWin = win;
    } else {
      if (this.largeWin.isVisible()) this.largeWin.hide();  // 先藏起旧内容，等渲染完再显
      this.largeWin.webContents.send("largetype:text", this.pendingLarge);
    }
  }

  // 注册工作流里的 Hotkey 触发（由 main.ts 在 reregisterShortcuts 里调用；清理由 main.ts 统一做）。
  async registerWorkflowHotkeys(): Promise<void> {
    if (!this.cfg.get().launcherEnabled) return;
    const { globalShortcut } = await import("electron");
    for (const h of this.engine.hotkeys()) {
      try {
        if (globalShortcut.isRegistered(h.accelerator)) continue;  // 让位给已占用的快捷键
        globalShortcut.register(h.accelerator, () => this.engine.fireHotkey(h.wfId, h.nodeId));
      } catch (e) {
        console.warn(`[launcher] 工作流 Hotkey 注册失败：${h.accelerator}`, e);
      }
    }
  }
}
