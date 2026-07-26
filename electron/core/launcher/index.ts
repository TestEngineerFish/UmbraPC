// 快捷入口 Launcher（类 Alfred）：全局快捷键唤起的浮层搜索窗。
// 输入 query → 并发查询各 Provider（app 启动 / 文件夹书签 / 剪贴板历史）→ 结果列表 → 回车执行 action。
// 窗口/焦点还原范式镜像 ClipboardManager。
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { ConfigStore, expandHome, LauncherFolder, LauncherScript, Phrase, Workflow, WorkflowPrefab } from "../config";
import { ClipStore } from "../clipboard/store";
import { writeToClipboard, simulatePaste } from "../clipboard/paste";
import { getAppIcon } from "../clipboard/source-app";
import { run } from "../shared/util";
import { WorkflowEngine, migrateScriptsToWorkflows, migrateFoldersAndYoudao, seedBuiltinTools, NO_BRANCH } from "./workflow";
import type { TextViewPayload } from "./workflow";

// ── 结果与动作类型 ──
export interface LauncherAction {
  kind: "open_app" | "open_path" | "paste_clip" | "paste_text" | "copy" | "run_script" | "workflow" | "assistant";
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
  // 使用频率学习用的稳定标识。工作流结果的 id 是一次性 token，每次查询都在变，
  // 拿它当学习键永远学不会；有 learnId 时一律用 learnId 记账。缺省回落到 id。
  learnId?: string;
  noLearn?: boolean;       // 明确不参与频率学习（脚本声明了 skipknowledge / 纯提示项）
  autocomplete?: string;   // Tab 补全时写回输入框的完整查询词
  quicklook?: string;      // ⌘Y 预览的 URL 或文件路径
}

// 密码保险箱在 Launcher 这边需要的最小面（W10）。
// 只声明用到的三个成员，不 import VaultManager —— 免得两个模块互相依赖。
export interface VaultBridge {
  readonly unlocked: boolean;
  getSecret(ref: string): string | null;
  putSecret(ref: string | undefined, title: string, value: string): Promise<string>;
}

interface ManagerOpts {
  preloadPath: string;
  devUrl: string;
  distDir: string;
}


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
  private textWin: Electron.BrowserWindow | null = null;   // 文本视图浮层窗（长文/Markdown/流式）
  private pendingText: TextViewPayload | null = null;      // 文本视图待展示内容（等渲染层 ready 后发送）
  private textBounds: Electron.Rectangle | null = null;    // 文本视图窗目标位置（渲染完成后再显示）
  private textLoading = false;                             // 文本视图正在等远程回复：此时失焦不自动收起
  private secretDeps: VaultBridge | null = null;   // 密码保险箱桥（W10 的 password 配置项）
  private rerunTimer: NodeJS.Timeout | undefined;          // Script Filter 的 rerun 定时器（W3）

  constructor(private cfg: ConfigStore, private clipStore: ClipStore, userData: string, private opts: ManagerOpts, private reregister: () => void) {
    this.usageFile = path.join(userData, "launcher-usage.json");
    this.engine = new WorkflowEngine(cfg, {
      sendAssistant: (t) => this.chatSender?.(t),
      hide: (rf) => this.hide(rf),
      showLargeType: (t) => { void this.showLargeType(t); },
      showTextView: (p) => { void this.showTextView(p); },
      getSecret: (ref) => this.secretDeps?.getSecret(ref) ?? null,
    });
  }

  // 密码保险箱接线（W10）：工作流配置项里 type=password 的值只在保险箱里，
  // 引擎执行时现取。主进程建 launcher 时保险箱还没建好，所以这里后置注入。
  setVault(v: VaultBridge): void { this.secretDeps = v; }

  async init(): Promise<void> {
    this.registerIpc();
    // 每跑完一条工作流链路，就把轨迹推给工作流编辑器窗口（没开着就不推）。
    this.engine.trace.onRun((r) => {
      if (this.wfWin && !this.wfWin.isDestroyed()) this.wfWin.webContents.send("launcher:trace", r);
    });
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
  private noteUse(key: string): void {
    if (!this.lastQuery) return;
    const k = this.usageKey(this.lastQuery, key);
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
    // 面板一收起，脚本要求的自动重查就没意义了，定时器要跟着停掉。
    if (this.rerunTimer) { clearTimeout(this.rerunTimer); this.rerunTimer = undefined; }
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
  // 对外入口：查一次，然后按脚本声明的 rerun 安排下一次自动重查（W3）。
  private async query(raw: string): Promise<LauncherResult[]> {
    const res = await this.queryOnce(raw);
    this.scheduleRerun((raw || "").trim());
    return res;
  }

  // rerun（W3）：Script Filter 在输出里写了 rerun 就代表「结果还会变，过 N 秒再问我一次」。
  // 到点时若输入框还是同一个词、面板也还开着，就重查一遍并把新结果推给渲染层；
  // 新结果里若还带 rerun，就自然接着排下一次，直到脚本不再要求为止。
  private scheduleRerun(q: string): void {
    if (this.rerunTimer) clearTimeout(this.rerunTimer);
    this.rerunTimer = undefined;
    const sec = this.engine.takeRerun();
    if (!sec) return;
    this.rerunTimer = setTimeout(() => {
      this.rerunTimer = undefined;
      if (this.lastQuery !== q) return;                                        // 用户已经改词了
      if (!this.panel || this.panel.isDestroyed() || !this.panel.isVisible()) return;
      void this.query(q).then((r) => {
        if (this.lastQuery !== q || !this.panel || this.panel.isDestroyed()) return;
        this.panel.webContents.send("launcher:results", { q, results: r });
      }).catch(() => { /* 自动重查失败就安静收手，不打扰用户 */ });
    }, Math.round(sec * 1000));
  }

  private async queryOnce(raw: string): Promise<LauncherResult[]> {
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
    // ③ 兜底搜索：什么都没搜到时补一条「问秘书」可执行项（只在有输入且开关打开时）。
    //    注意这是一条可执行项，不是「最近使用」列表 —— 空结果下不做任何历史回填。
    if (!results.length && q && this.cfg.get().launcherFallbackAssistant !== false) {
      results.push({
        id: `assistant:${q}`, title: `问秘书：${q}`, subtitle: "没有匹配结果 · 回车交给秘书处理",
        icon: "🤖", source: "assistant", score: 50,
        action: { kind: "assistant", payload: { text: q } },
      });
    }
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
    for (const r of results) if (!r.noLearn) r.score += this.boost(q, r.learnId || r.id);
    results.sort((a, b) => b.score - a.score);
    // 展示条数跟随设置（launcherMaxResults），上限 50 条防止列表失控。
    const max = Math.max(1, Math.min(Number(this.cfg.get().launcherMaxResults) || 12, 50));
    const top = results.slice(0, max);
    this.cache.clear();
    for (const r of top) this.cache.set(r.id, r);
    return top;
  }

  // Provider①：启动 App。
  //
  // 之前只用 mdfind 查 kMDItemDisplayName 一个字段 —— 而 Spotlight 给这个字段的
  // 往往是 bundle 的内部名（企业微信.app 的 DisplayName 是 "WeCom"），
  // 于是搜「企业微信」一无所获、搜「wecom」反而命中。这很反直觉。
  //
  // 现在两条腿走路：mdfind 多字段查（拿 Spotlight 索引到的别名/包名）
  // + **直接扫应用目录**（文件名是什么就能搜到什么，中文名 100% 命中）。合并去重。
  private async searchApps(q: string): Promise<LauncherResult[]> {
    if (process.platform !== "darwin" || q.length < 1) return [];
    const [byIndex, byScan] = await Promise.all([
      this.mdfindApps(q).catch(() => [] as string[]),
      this.scanApps(q).catch(() => [] as string[]),
    ]);
    const paths = [...new Set([...byScan, ...byIndex])].slice(0, 6); // 目录扫描的结果更可信，排前面

    const ql = q.toLowerCase();
    const out: LauncherResult[] = [];
    for (const p of paths) {
      const name = path.basename(p).replace(/\.app$/i, "");
      const lower = name.toLowerCase();
      // 完全相同 > 前缀 > 包含；文件名里搜不到但 Spotlight 命中的（别名/包名）分最低。
      const hit = lower === ql ? 60 : lower.startsWith(ql) ? 40 : lower.includes(ql) ? 20 : 0;
      let icon = "";
      try { icon = await getAppIcon(p); } catch { /* 图标失败不阻塞 */ }
      out.push({
        id: `app:${p}`, title: name, subtitle: p, icon: icon || "📦", source: "app", score: 100 + hit,
        action: { kind: "open_app", payload: { path: p } },
      });
    }
    return out;
  }

  // Spotlight：多字段一起查（显示名 / 文件名 / 别名 / bundle id），别只押一个字段。
  private async mdfindApps(q: string): Promise<string[]> {
    const like = (field: string) => `${field} == '*${q}*'cd`; // c=忽略大小写 d=忽略音标
    const res = await run("mdfind", [
      `kMDItemContentType == 'com.apple.application-bundle' && (` +
        [
          like("kMDItemDisplayName"),
          like("kMDItemFSName"),
          like("kMDItemAlternateNames"),
          like("kMDItemCFBundleIdentifier"),
        ].join(" || ") +
        `)`,
    ], { timeoutMs: 2500 });
    if (res.code !== 0) return [];
    return res.output.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  // 兜底：直接扫应用目录，按**文件名**匹配。
  // Spotlight 索引抽风 / 字段对不上时，这条路照样能找到「企业微信.app」。
  private appDirCache: { at: number; paths: string[] } = { at: 0, paths: [] };

  private async listAppDirs(): Promise<string[]> {
    const now = Date.now();
    if (now - this.appDirCache.at < 5 * 60_000 && this.appDirCache.paths.length) {
      return this.appDirCache.paths; // 5 分钟缓存：别每敲一个字就 readdir 一遍
    }
    const roots = [
      "/Applications",
      "/Applications/Utilities",
      "/System/Applications",
      "/System/Applications/Utilities",
      path.join(os.homedir(), "Applications"),
    ];
    const found: string[] = [];
    for (const root of roots) {
      try {
        for (const e of await fs.readdir(root)) {
          if (e.endsWith(".app")) found.push(path.join(root, e));
        }
      } catch {
        /* 目录不存在 */
      }
    }
    this.appDirCache = { at: now, paths: found };
    return found;
  }

  private async scanApps(q: string): Promise<string[]> {
    const ql = q.toLowerCase();
    const all = await this.listAppDirs();
    return all
      .filter((p) => path.basename(p).replace(/\.app$/i, "").toLowerCase().includes(ql))
      .sort((a, b) => {
        const an = path.basename(a).toLowerCase();
        const bn = path.basename(b).toLowerCase();
        return Number(bn.startsWith(ql)) - Number(an.startsWith(ql)) || an.length - bn.length;
      });
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
    // 学习：这次在该 query 下选了它（工作流结果按 learnId 记，避免记到一次性 token 上）。
    if (!r.noLearn) this.noteUse(r.learnId || id);
    const clip = async (text: string) => { const { clipboard } = await import("electron"); clipboard.writeText(text); };

    const a = r.action;
    if (a.kind === "workflow") {
      const fb = await this.engine.run(String(a.payload.token), mod);
      return fb === NO_BRANCH ? "" : fb;  // 无该修饰键分支 → 静默（渲染层已按 mods 决定是否走此路）
    }
    if (a.kind === "assistant") {
      return this.sendAssistant(String(a.payload.text || ""));   // 兜底搜索：把原始输入交给秘书
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
    // ⌘Y 预览（W3 的 quicklookurl）：http(s) 交给默认浏览器，其余当作路径交给系统默认程序打开。
    // 面板不收起 —— 预览的意义就是「看一眼再决定选哪个」。
    ipcMain.handle("launcher:quicklook", async (_e, target: string) => {
      const t = String(target || "").trim();
      if (!t) return;
      const { shell } = await import("electron");
      if (/^https?:\/\//i.test(t)) await shell.openExternal(t);
      else await shell.openPath(expandHome(t));
    });
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
    // 预制件读写（E3）：跨工作流复用的节点组，存在全局配置里而不是某条工作流里。
    ipcMain.handle("launcher:getPrefabs", () => this.cfg.get().launcherPrefabs || []);
    ipcMain.handle("launcher:setPrefabs", (_e, prefabs: WorkflowPrefab[]) =>
      this.cfg.save({ launcherPrefabs: Array.isArray(prefabs) ? prefabs : [] }));
    // 工作流配置项里的密钥（W10）：明文只交给保险箱，工作流 JSON 里存回来的引用串。
    // 保险箱锁着就直说，让用户先去解锁 —— 不做「先存明文回头再搬」这种将就。
    ipcMain.handle("launcher:setWfSecret", async (_e, ref: string, title: string, value: string) => {
      if (!this.secretDeps) return { ok: false, error: "保险箱不可用" };
      try { return { ok: true, ref: await this.secretDeps.putSecret(String(ref || "") || undefined, String(title || "工作流密钥"), String(value ?? "")) }; }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    });
    // 保险箱是否已解锁：配置面板据此提示「先解锁才能存/改密钥」。
    ipcMain.handle("launcher:vaultUnlocked", () => !!this.secretDeps?.unlocked);
    // 工作流调试轨迹：只读内存里最近若干次执行（编辑器底部调试抽屉用）。
    ipcMain.handle("launcher:getTrace", (_e, wfId: string) => this.engine.trace.list(wfId || undefined));
    ipcMain.handle("launcher:clearTrace", () => { this.engine.trace.clear(); });
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
    // 文本视图浮层：同样是「渲染层 ready 索取内容 → 画好回调 rendered → 主进程才显示」，避免闪出上次内容。
    ipcMain.handle("textview:ready", () => this.pendingText);
    ipcMain.handle("textview:rendered", () => {
      if (!this.textWin || this.textWin.isDestroyed()) return;
      if (this.textWin.isVisible()) return;              // 已经在显示（流式续写）→ 不重复摆位/抢焦点
      if (this.textBounds) this.textWin.setBounds(this.textBounds);
      this.textWin.showInactive();
      this.textWin.focus();
    });
    ipcMain.handle("textview:close", () => {
      this.textLoading = false;
      if (this.textWin && !this.textWin.isDestroyed()) this.textWin.hide();
    });
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

  // 文本视图：居中浮层，用来摊开长文/Markdown（大字显示放不下的场景），也是「问秘书」的等待与展示界面。
  // 与大字显示同样的去残影范式：窗口先藏着，渲染层画好回调 textview:rendered 再显示。
  async showTextView(p: TextViewPayload): Promise<void> {
    const payload: TextViewPayload = {
      text: String(p.text ?? ""),
      title: p.title || "文本视图",
      md: p.md !== false,
      append: !!p.append,
      loading: !!p.loading,
    };
    this.pendingText = payload;
    this.textLoading = payload.loading === true;
    const { BrowserWindow, screen } = await import("electron");
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const w = Math.min(920, Math.round(wa.width * 0.7));
    const h = Math.min(720, Math.round(wa.height * 0.7));
    this.textBounds = {
      x: Math.round(wa.x + (wa.width - w) / 2),
      y: Math.round(wa.y + (wa.height - h) / 2),
      width: w, height: h,
    };
    if (!this.textWin || this.textWin.isDestroyed()) {
      const win = new BrowserWindow({
        x: this.textBounds.x, y: this.textBounds.y, width: w, height: h,
        frame: false, transparent: true, resizable: false,
        skipTaskbar: true, show: false, fullscreenable: false, hasShadow: false,
        backgroundColor: "#00000000",
        webPreferences: { preload: this.opts.preloadPath, contextIsolation: true, nodeIntegration: false },
      });
      win.setAlwaysOnTop(true, "screen-saver");
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      // 等远程回复期间（loading）失焦不收起，否则内容还没回来窗口就没了。
      win.on("blur", () => {
        if (this.textLoading) return;
        if (this.textWin && !this.textWin.isDestroyed()) this.textWin.hide();
      });
      win.webContents.on("before-input-event", (_e, input) => {
        if (input.type === "keyDown" && input.key === "Escape") { this.textLoading = false; win.hide(); }
      });
      if (this.opts.devUrl) win.loadURL(`${this.opts.devUrl}/textview.html`).catch(() => {});
      else win.loadFile(path.join(this.opts.distDir, "textview.html")).catch(() => {});
      win.webContents.on("did-finish-load", () => win.webContents.send("textview:data", this.pendingText));
      this.textWin = win;
    } else {
      // 窗口已在 → 直接推新内容（追加=流式续写，否则整体替换），由渲染层就地更新，不闪窗。
      this.textWin.webContents.send("textview:data", payload);
    }
  }

  // 注册工作流里的 Hotkey / Universal Action 触发（由 main.ts 在 reregisterShortcuts 里调用；
  // 清理由 main.ts 统一做）。两者都是全局快捷键，区别只在按下之后 arg 从哪来。
  async registerWorkflowHotkeys(): Promise<void> {
    if (!this.cfg.get().launcherEnabled) return;
    const { globalShortcut } = await import("electron");
    const list = [
      ...this.engine.hotkeys().map((h) => ({ ...h, universal: false })),
      ...this.engine.universals().map((h) => ({ ...h, universal: true })),
    ];
    for (const h of list) {
      try {
        if (globalShortcut.isRegistered(h.accelerator)) continue;  // 让位给已占用的快捷键
        globalShortcut.register(h.accelerator, () => (h.universal
          ? this.engine.fireUniversal(h.wfId, h.nodeId)
          : this.engine.fireHotkey(h.wfId, h.nodeId)));
      } catch (e) {
        console.warn(`[launcher] 工作流快捷键注册失败：${h.accelerator}`, e);
      }
    }
  }
}
