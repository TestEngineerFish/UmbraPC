// 快捷入口 Launcher（类 Alfred）：全局快捷键唤起的浮层搜索窗。
// 输入 query → 并发查询各 Provider（app 启动 / 文件夹书签 / 剪贴板历史）→ 结果列表 → 回车执行 action。
// 窗口/焦点还原范式镜像 ClipboardManager。
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { ConfigStore, expandHome, LauncherFolder, LauncherScript, Phrase, Workflow, WorkflowPrefab } from "../config";
import { PhraseSync, collectTombs, stampUpdated } from "./phrases-sync";
import { keepSystemEventsAlive, simulatePaste } from "../clipboard/paste";
import { getAppIcon } from "../clipboard/source-app";
import { run } from "../shared/util";
import { suppressAppActivate } from "../activation";
import { anyStrongMatch, bestMatch, frecency, frecencyBoost, lookupUsage, noteUsage, pruneUsage, type UsageEntry } from "./rank";
import { readBundleNames, searchableNames, type BundleNames } from "./appinfo";
import { pinyinAliases } from "./pinyin";
import { WorkflowEngine, migrateScriptsToWorkflows, migrateFolders, seedBuiltinTools, NO_BRANCH } from "./workflow";
import { accelMessage, accelProblem, checkAccel, parseAccel } from "./hotkey";
import type { TextViewPayload } from "./workflow";
import { ensureWorkflowDir } from "./workspace";

// ── 结果与动作类型 ──
export interface LauncherAction {
  kind: "open_app" | "open_path" | "paste_text" | "copy" | "run_script" | "workflow" | "assistant";
  payload: Record<string, unknown>;
}
export interface LauncherResult {
  id: string;              // 稳定 id（供 run 回查）
  title: string;
  subtitle?: string;
  icon?: string;           // data URL / emoji
  source: string;          // 来源 provider（app/folder/clipboard/workflow）
  score: number;           // 合并排序用（来源基准分 + 匹配质量；frecency 在 finalize 里再加）
  match?: number;          // 纯匹配质量分，仅用于同分时的第二级排序
  action: LauncherAction;  // 主动作（回车执行）
  mods?: string[];         // 工作流结果的修饰键分支（如 ["cmd"]），供渲染层提示 ⌘ 分支
  // 使用频率学习用的稳定标识。工作流结果的 id 是一次性 token，每次查询都在变，
  // 拿它当学习键永远学不会；有 learnId 时一律用 learnId 记账。缺省回落到 id。
  learnId?: string;
  noLearn?: boolean;       // 明确不参与频率学习（脚本声明了 skipknowledge / 纯提示项）
  autocomplete?: string;   // Tab 补全时写回输入框的完整查询词
  quicklook?: string;      // ⌘Y 预览的 URL 或文件路径
  // 这一行允许换行、完整显示。**只给报错行用**：报错的价值全在细节里
  // （哪个文件、哪一行），截成一句「no such file or director」等于什么都没说。
  // 正常结果一律保持单行 —— 一个会换行的结果列表没法快速扫。
  wrap?: boolean;
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


// 标签名去重、去空白、去空串，保序。
function uniqTags(names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const v = String(n || "").trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

export class LauncherManager {
  private panel: Electron.BrowserWindow | null = null;
  private shownAt = 0;  // 唤起时刻：刚弹出瞬间的失焦（主窗口被激活抢焦）要忽略，避免立刻收起/来回切换
  private cache = new Map<string, LauncherResult>();  // 本次查询结果，供 run 回查
  private lastQuery = "";                              // 本次查询词，供 run 记录使用频率
  // 使用习惯学习：`${查询词前缀}\n${id}` → {次数, 最近时间}。前缀分桶见 rank.ts 的说明。
  private usage: Record<string, UsageEntry> = {};
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
  private phraseSync: PhraseSync;                          // 常用语云端同步（按条目合并 + 删除墓碑）

  constructor(private cfg: ConfigStore, userData: string, private opts: ManagerOpts, private reregister: () => void) {
    this.usageFile = path.join(userData, "launcher-usage.json");
    // 同步结果落地后广播，让设置页和快捷入口面板都拿到最新的常用语。
    this.phraseSync = new PhraseSync(cfg, () => this.broadcastPhrases());
    this.engine = new WorkflowEngine(cfg, {
      sendAssistant: (t) => this.chatSender?.(t),
      hide: (rf) => this.hide(rf),
      showPanel: (pre) => this.show(pre),
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
    migrateFolders(this.cfg);              // 一次性：文件夹书签 → 工作流
    seedBuiltinTools(this.cfg);            // 一次性：编解码/计算/换算 → 默认工作流
    try { this.usage = JSON.parse(await fs.readFile(this.usageFile, "utf-8")); } catch { this.usage = {}; }
    // 预热：启动时就把浮层窗建好并加载渲染层（藏着），首次唤起即可秒开，避免忽快忽慢。
    try { await this.ensurePanel(); } catch { /* 预热失败不影响后续按需创建 */ }
    // 应用目录 + 包内名字索引也提前建好（要读几百个 Info.plist，别摊到第一次搜索上）。
    void this.listAppDirs().catch(() => { /* 建不起来就退回按文件名搜 */ });
    // System Events 保活：工作流热键的选区抓取 / 前台查询、常用语的模拟粘贴都走它，
    // 冷启动 1~2 秒是「热键慢」的大头（见 paste.ts 的说明）。
    keepSystemEventsAlive();
    // 常用语云端同步：启动拉一次，之后按周期拉；本地改动由 setPhrases 触发推送。
    this.phraseSync.start();
    // 全局快捷键由 main.ts 统一注册（见 registerShortcut）。
  }

  // 标签清单：配置里的顺序在前，phrases 里用到但清单里没有的 keyword 按出现顺序追加。
  phraseTags(): string[] {
    const c = this.cfg.get();
    const used = (c.phrases || []).map((p) => (p.keyword || "").trim()).filter(Boolean);
    return uniqTags([...(c.phraseTags || []), ...used]);
  }

  // 常用语被云端同步改写后广播给所有窗口，设置页/面板不用轮询也能刷新。
  private async broadcastPhrases(): Promise<void> {
    const { BrowserWindow } = await import("electron");
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("launcher:phrases:changed", this.cfg.get().phrases || []);
    }
  }

  // 使用习惯加权：frecency（次数 × 时近乘子）再用 ln 压成有界加分，见 rank.ts。
  private boost(q: string, id: string): number {
    return frecencyBoost(frecency(lookupUsage(this.usage, q, id), Date.now()));
  }
  // 记一次使用。查询词的每个前缀都记一份，所以「打 sour 选了 SourceTree」
  // 之后只打一个 s 也能把它顶到第一位。空查询也记（前缀 "" 即全局桶）。
  private noteUse(id: string): void {
    const now = Date.now();
    noteUsage(this.usage, this.lastQuery, id, now);
    pruneUsage(this.usage, now);
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
      // ⚠️ 非激活面板（NSPanel，Alfred / Spotlight 的做法，2026-09-03 验收第四轮）：
      // 面板要接键盘输入（做 key window）但**不激活本 app**。原来是普通窗口，
      // 拿焦点 = 激活整个 app —— 被别的软件盖住的主窗口会被 macOS 一并带到本 app
      // 最前，Esc 收面板的瞬间主窗口闪到屏幕最上层再沉回去（sam 实锤的那个闪现）；
      // 工作流触发大字显示时主窗口跑到最前，也是同一条根。panel 化之后 app 从头到尾
      // 没被激活，主窗口在哪层就呆在哪层，焦点用完自动还给原应用（粘贴常用语
      // 也因此更稳 —— 不再依赖 app.hide() 把焦点交还）。
      type: process.platform === "darwin" ? "panel" : undefined,
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

  // prefill：唤起时预先填进搜索框的内容（Hotkey 节点的「打开快捷入口」用）。
  // 不传就是普通唤起（搜索框清空）。
  private async show(prefill?: { q: string; caret?: "left" | "right" }): Promise<void> {
    const { screen } = await import("electron");
    const win = await this.ensurePanel();
    // 每次唤起都居中到光标所在屏幕上方 1/3（Alfred 风格）。
    try {
      const pt = screen.getCursorScreenPoint();
      const wa = screen.getDisplayNearestPoint(pt).workArea;
      const [w] = win.getSize();
      win.setPosition(Math.round(wa.x + (wa.width - w) / 2), Math.round(wa.y + wa.height * 0.22));
    } catch { win.center(); }
    this.panelBounds = win.getBounds();   // 大字显示等浮层据此认「当前屏幕」（见 currentDisplay）
    this.shownAt = Date.now();
    // show()/focus() 会顺带激活整个 app，触发 main.ts 的 app.on("activate")。
    // 那个回调是给「点 Dock 图标」用的，跑到这里只会 dock.show() + 把主窗口拽到前台抢焦点。
    suppressAppActivate();
    win.show();
    win.focus();
    // 预填内容跟着 shown 一起发：分两条消息的话，渲染层收到 shown 会先把输入框清空，
    // 预填那条随后到达 —— 中间会闪一下空框，而且两条的先后顺序没有保证。
    win.webContents.send("launcher:shown", prefill || null);
  }

  // returnFocus 参数保留但已无实际分支（历史：普通窗口时代靠 app.hide() 还焦点）。
  // panel 化（见 ensurePanel）后 app 从未被激活，焦点天然一直在原应用手里 ——
  // 原来那段「先 app.hide() 再 panel.hide()」的顺序舞蹈连同它治的闪烁一起消失了。
  private async hide(_returnFocus = false): Promise<void> {
    // 面板一收起，脚本要求的自动重查就没意义了，定时器要跟着停掉。
    if (this.rerunTimer) { clearTimeout(this.rerunTimer); this.rerunTimer = undefined; }
    // Spotlight 结果只在一次面板会话内复用（见 spotlightLater）。
    this.spotlightCache.clear();
    this.spotlightSeq++;
    if (this.panel && !this.panel.isDestroyed() && this.panel.isVisible()) {
      this.panelHiddenAt = Date.now();
      this.panel.hide();
    }
  }

  // ── 全局快捷键（只注册自身；清理由 main.ts 统一做）──
  async registerShortcut(): Promise<void> {
    if (!this.cfg.get().launcherEnabled) return;
    const { globalShortcut } = await import("electron");
    const acc = this.cfg.get().launcherShortcut || "Alt+Space";
    const bad = accelProblem(acc);
    if (bad) { console.warn(`[launcher] 快捷键用不了（${bad}）：${acc} —— 去设置里重录一次`); return; }
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

    // ② 普通：并发 app + 常用语 + 「始终触发」工作流（计算器/单位换算等）。
    // 刻意**不搜剪贴板历史**：剪贴板里全是正文，随便几个字母就能蹭上一堆条目，
    // 把真正想要的应用挤到下面去 —— 压低基准分也治不住，因为噪音是量的问题不是分的问题。
    // 要翻剪贴板走它自己的面板（⌘⌥V），那里有分类、收藏和预览，比在这儿混着搜好用得多。
    const [apps, always] = await Promise.all([
      this.searchApps(q).catch(() => []),
      this.engine.queryAlways(q).catch(() => [] as LauncherResult[]),
    ]);
    results.push(...always, ...this.searchPhrases(q), ...apps);
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
      .map((p): LauncherResult | null => {
        const kw = (p.keyword || "").toLowerCase();
        const kwHit = !!kw && (kw === ql || kw.startsWith(ql));
        // 命中判定交给模糊匹配，但同样只认词首级别的匹配，免得正文里散落几个字母就冒出来。
        // 关键词是「直达」语义，永远保留；用过的条目也豁免。
        // 名字含汉字时补拼音别名（首字母 zbmb + 全拼 zhoubaomuban）。只给名字补，不给正文补：
        // 正文动辄几十上百字，转成一长串首字母之后什么查询都能蹭上，纯属噪音。
        const py = pinyinAliases(p.name || "");
        if (!kwHit
            && !anyStrongMatch(q, [p.name, ...py, p.content])
            && this.boost(q, `phrase:${p.id}`) <= 0) return null;
        const m = Math.max(0, bestMatch(q, [p.name, ...py, p.keyword, p.content]));
        const score = 100 + Math.round(m * 0.55) + (kwHit ? 35 : 0);
        return {
          id: `phrase:${p.id}`, title: p.name || p.content.slice(0, 40),
          subtitle: `常用语 · 回车插入 · ${p.content.replace(/\s+/g, " ").slice(0, 50)}`,
          icon: "💬", source: "phrase", score, match: m,
          action: { kind: "paste_text", payload: { text: p.content } },
        };
      })
      .filter((r): r is LauncherResult => r !== null);
  }

  // 使用习惯加权 + 排序 + 截断 + 缓存。
  // 排序三级：总分（来源基准 + 匹配质量 + frecency）→ 纯匹配质量 → 标题字典序。
  // 最后一级是为了让「分数完全打平」的情况有个稳定、可预期的顺序，而不是随провider返回顺序漂。
  private finalize(q: string, results: LauncherResult[]): LauncherResult[] {
    for (const r of results) if (!r.noLearn) r.score += this.boost(q, r.learnId || r.id);
    results.sort((a, b) =>
      b.score - a.score
      || (b.match ?? 0) - (a.match ?? 0)
      || a.title.localeCompare(b.title));
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
  //
  // ⚠️ 速度（sam 验收：打 wechat 要等 2 秒，系统搜索框却是瞬出）：
  // 病根是这里原来 **同步等 mdfind**。Spotlight 对全盘索引做四个字段的 `*q*` 模糊查，
  // 冷的时候几百毫秒到两秒都有，而本地目录扫描（缓存 + 内存匹配）只要几毫秒 ——
  // 一个毫秒级的结果被一个秒级的结果拖着一起出。现在两条腿**分开走**：
  //   · 扫描结果立刻返回（这是 99% 的命中来源，中文名 / 展示名 / 拼音都在里面）；
  //   · Spotlight 在后台跑，回来后**只有真的补出了扫描没命中的应用**才把列表再推一次
  //     （复用 rerun 那条 launcher:results 通道），否则什么都不动，列表不闪。
  // 第二个慢点是图标：前 8 名原来是 for-await 串行取，首次命中的应用要各走一次
  // createThumbnailFromPath，8 个串起来又是几百毫秒。改成并行，并在启动建索引时
  // 就把全部应用的图标预热进缓存 —— 查询路径上不再有第一次。
  private async searchApps(q: string): Promise<LauncherResult[]> {
    if (process.platform !== "darwin" || q.length < 1) return [];
    const byScan = await this.scanApps(q).catch(() => [] as string[]);
    // 本轮面板会话里 Spotlight 已经回来过的词直接用；没有就后台去查，别让这次查询等它。
    const cached = this.spotlightCache.get(q);
    const byIndex = cached ?? [];
    if (!cached) this.spotlightLater(q, byScan);
    return this.rankApps(q, byScan, byIndex);
  }

  // Spotlight 结果缓存：查询词 → 路径列表。面板收起就清（一次会话内够用，跨会话还是要重查，
  // 用户可能刚装了新应用）。
  private spotlightCache = new Map<string, string[]>();
  private spotlightSeq = 0;
  private spotlightLater(q: string, byScan: string[]): void {
    const seq = ++this.spotlightSeq;
    void this.mdfindApps(q).catch(() => [] as string[]).then(async (idx) => {
      this.spotlightCache.set(q, idx);
      // 用户已经改词、面板已经收起、或又发起了新的 Spotlight 查询：这份结果只进缓存，不推。
      if (seq !== this.spotlightSeq || this.lastQuery !== q) return;
      if (!this.panel || this.panel.isDestroyed() || !this.panel.isVisible()) return;
      // 扫描已经命中的一个不少 → Spotlight 没带来新东西，不重推（重推会让列表无谓地闪一下）。
      const scanned = new Set(byScan);
      if (!idx.some((p) => !scanned.has(p))) return;
      const results = await this.queryOnce(q).catch(() => null);
      if (!results || this.lastQuery !== q || !this.panel || this.panel.isDestroyed()) return;
      this.panel.webContents.send("launcher:results", { q, results });
    });
  }

  // 打分 + 截断 + 取图标。byIndex 是 Spotlight 命中的路径（可能为空），
  // 它认的一律放行 —— 见下面 fromSpotlight 的说明。
  private async rankApps(q: string, byScan: string[], byIndex: string[]): Promise<LauncherResult[]> {
    // 候选池要够大：以前这里直接 slice(0,6)，而 scanApps 是按「前缀优先 + 名字短优先」排的，
    // 于是打一个 s，Safari / Slack / Siri 这些短名字先把 6 个位置占满，
    // SourceTree 连进入打分环节的机会都没有 —— 「常用的软件打首字母排第一」自然永远做不到。
    // 现在放到 40 个候选，先用模糊匹配 + 使用习惯排完序，再只给前 8 名取图标。
    const paths = [...new Set([...byScan, ...byIndex])].slice(0, 40);

    const ql = q.toLowerCase();
    // Spotlight 这一路命中的一律放行：它索引到的某个字段确实匹配了这次查询，
    // 哪怕本地的名字都对不上（别名、本地化名等我们读不到的字段）。
    const fromSpotlight = new Set(byIndex);
    const scored = paths.map((p) => {
      const names = this.appNames(p);
      // 标题优先用包内展示名（企业微信.app 显示成 WeCom），回落文件名；副标题始终是完整路径。
      const name = this.appTitle(p);
      let m = bestMatch(q, names);
      const spotlight = fromSpotlight.has(p);
      // 本地名字都对不上、但 Spotlight 认它：给一个中档保底分，
      // 排在真·词首匹配之后、其它一切之前，而不是锁死 0 分被截断掉。
      if (m < 0) m = spotlight ? 100 : 0;
      const lowers = names.map((n) => n.toLowerCase());
      if (lowers.includes(ql)) m += 60;                          // 完全同名一定压住其它
      else if (lowers.some((n) => n.startsWith(ql))) m += 25;    // 前缀次之
      const keep = spotlight || anyStrongMatch(q, names) || this.boost(q, `app:${p}`) > 0;
      return { p, name, base: 100 + Math.round(m * 0.55), match: m, keep };
    }).filter((x) => x.keep);
    // 先按「基准分 + 使用习惯」排，再截断取图标。
    scored.sort((a, b) =>
      (b.base + this.boost(q, `app:${b.p}`)) - (a.base + this.boost(q, `app:${a.p}`))
      || b.match - a.match
      || a.name.localeCompare(b.name));

    // 图标并行取（缓存命中时是同步返回，预热过之后这里基本不等）。
    const top = scored.slice(0, 8);
    const icons = await Promise.all(top.map((it) => getAppIcon(it.p).catch(() => "")));
    return top.map((it, i): LauncherResult => ({
      id: `app:${it.p}`, title: it.name, subtitle: it.p, icon: icons[i] || "📦", source: "app",
      score: it.base, match: it.match,
      action: { kind: "open_app", payload: { path: it.p } },
    }));
  }

  // 图标预热：索引建好后在后台把全部应用的图标读进 getAppIcon 的缓存。
  //
  // ⚠️ 第一版是每批 4 个、批间 setTimeout(0) —— 实机翻车（sam：唤起有时要 1 秒）：
  // createThumbnailFromPath 每个要几十毫秒的主进程侧开销，几百个应用连着跑，
  // 事件循环被塞满，**全局快捷键的回调都得排队** —— 唤起慢、工作流热键慢，全是它。
  // 现在：开跑前先歇 15s（避开启动高峰）、每批 3 个、批间 150ms，且面板可见时暂停
  // （用户正在用，一个毫秒都别跟他抢）。预热慢点无所谓 —— 没预热到的图标只是第一次
  // 搜到时现取一次。同一份索引只预热一次；索引重建（5 分钟）时补新增的。
  private iconWarmAt = 0;
  private async prewarmIcons(paths: string[], at: number): Promise<void> {
    if (process.platform !== "darwin" || this.iconWarmAt === at) return;
    this.iconWarmAt = at;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await sleep(15_000);
    for (let i = 0; i < paths.length; i += 3) {
      if (this.appDirCache.at !== at) return;   // 索引又重建了，交给下一轮
      while (this.panel && !this.panel.isDestroyed() && this.panel.isVisible()) await sleep(500);
      await Promise.all(paths.slice(i, i + 3).map((p) => getAppIcon(p).catch(() => "")));
      await sleep(150);
    }
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
  // 应用目录缓存。
  // info 是「路径 → 包内名字」：很多应用的**文件名和展示名不是一回事**，
  // 比如 /Applications/企业微信.app 的 CFBundleDisplayName 是 WeCom，
  // 只按文件名搜，打 we 就永远找不到它 —— Alfred / Spotlight 能找到，正是因为它们认的是包里的名字。
  // 这份数据直接读 Info.plist（见 appinfo.ts），不依赖 Spotlight，也就不会因为索引状态而静默失效。
  private appDirCache: { at: number; paths: string[]; info: Map<string, BundleNames> } =
    { at: 0, paths: [], info: new Map() };
  // 路径 → 参与匹配的全部名字（文件名 / 展示名 / 短名 / bundle id 尾段 / 拼音首字母）
  // 结果缓存起来：每敲一个字母都要对几百个应用各算一遍名字数组（还含拼音转换），
  // 而这份数据只在目录缓存重建时才会变。缓存跟着 appDirCache.at 一起失效。
  private namesCache: { at: number; map: Map<string, string[]> } = { at: 0, map: new Map() };
  private appNames(p: string): string[] {
    if (this.namesCache.at !== this.appDirCache.at) {
      this.namesCache = { at: this.appDirCache.at, map: new Map() };
    }
    let v = this.namesCache.map.get(p);
    if (!v) {
      v = searchableNames(p, this.appDirCache.info.get(p) || {});
      this.namesCache.map.set(p, v);
    }
    return v;
  }
  // 路径 → 列表里显示的标题：优先包内展示名（企业微信.app 显示成 WeCom），回落文件名。
  private appTitle(p: string): string {
    const b = this.appDirCache.info.get(p);
    return (b?.display || b?.name || "").trim() || path.basename(p).replace(/\.app$/i, "");
  }

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
    // 多扫一层子目录：不少应用（尤其国内的套装）装在 /Applications/<厂商>/xxx.app 下，
    // 只扫顶层会整个漏掉。再深就不值当了，会把 .app 内部的嵌套包也翻出来。
    const found: string[] = [];
    for (const root of roots) {
      try {
        for (const e of await fs.readdir(root, { withFileTypes: true })) {
          const full = path.join(root, e.name);
          if (e.name.endsWith(".app")) { found.push(full); continue; }
          if (!e.isDirectory() || e.name.startsWith(".")) continue;
          try {
            for (const sub of await fs.readdir(full)) {
              if (sub.endsWith(".app")) found.push(path.join(full, sub));
            }
          } catch { /* 子目录读不了就跳过 */ }
        }
      } catch {
        /* 目录不存在 */
      }
    }
    this.appDirCache = { at: now, paths: found, info: await this.readAllBundleNames(found) };
    void this.prewarmIcons(found, now);
    return found;
  }

  // 批量读包内名字。纯文件读取，几百个包也就几十毫秒，而且 5 分钟才重建一次。
  // 分批并发，别一次甩几百个 open 出去把 fd 打满。
  private async readAllBundleNames(paths: string[]): Promise<Map<string, BundleNames>> {
    const map = new Map<string, BundleNames>();
    if (process.platform !== "darwin") return map;
    const BATCH = 32;
    for (let i = 0; i < paths.length; i += BATCH) {
      const slice = paths.slice(i, i + BATCH);
      const got = await Promise.all(slice.map((p) => readBundleNames(p)));
      slice.forEach((p, k) => map.set(p, got[k]));
    }
    return map;
  }

  // 目录扫描候选：判定从「包含」放宽到「子序列」，这样 st→SourceTree、wc→WeChat 也能进候选池。
  // 这里只负责初筛 + 粗排，精排（含使用习惯）在 searchApps 里做。
  private async scanApps(q: string): Promise<string[]> {
    const all = await this.listAppDirs();
    const hits: { p: string; m: number; n: string }[] = [];
    for (const p of all) {
      // 文件名 / 展示名 / 短名 / bundle id 尾段全试一遍，取最高分。
      // 企业微信.app 就是靠展示名 WeCom（或 id 尾段 WeWorkMac）被 we 命中的。
      const names = this.appNames(p);
      const m = bestMatch(q, names);
      if (m < 0) continue;
      // 字符散落在词中间的弱匹配（we ↔ Unsplash Wallpapers）直接不出现，
      // 但用户真用过的条目豁免——他既然这么搜过并选中，就说明这条对他有意义。
      if (!anyStrongMatch(q, names) && this.boost(q, `app:${p}`) <= 0) continue;
      hits.push({ p, m, n: (names[0] || "").toLowerCase() });
    }
    // 粗排时也把使用习惯算进来，免得候选池截断again 把常用项挡在门外。
    hits.sort((a, b) =>
      (b.m + this.boost(q, `app:${b.p}`)) - (a.m + this.boost(q, `app:${a.p}`))
      || a.n.length - b.n.length);
    return hits.map((h) => h.p);
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

  // ── 秘书可达性 +「/」功能菜单的发送通道（批次 009）───────────────────────
  //
  // 「/」菜单的内容统一发给秘书整理后入库，所以发送前要先知道服务端通不通 ——
  // 通就转发聊天页（离开面板后的失败用户看不见，必须在面板里拦住）；
  // 不通就把三段式错误卡交给渲染层画，内容留在输入框不丢（稿定）。
  // 探测走 /health（无鉴权、只回一个 ok），1.5s 超时；结果缓存 8s ——
  // 菜单每次打开都问一次，别让每个键击都去 ping。
  private onlineCache: { at: number; ok: boolean } = { at: 0, ok: false };
  private async assistantOnline(): Promise<boolean> {
    const c = this.cfg.get();
    if (!c.serverUrl || !c.token) return false;   // 没配服务端 = 离线，不用发包
    if (Date.now() - this.onlineCache.at < 8_000) return this.onlineCache.ok;
    let ok = false;
    try {
      const { httpFetch } = await import("../http");
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 1_500);
      const r = await httpFetch(`${String(c.serverUrl).replace(/\/+$/, "")}/health`, { signal: ctl.signal });
      clearTimeout(timer);
      ok = r.ok;
    } catch { ok = false; }
    this.onlineCache = { at: Date.now(), ok };
    return ok;
  }

  // kind → 发给秘书的句式。带上意图前缀，秘书才会选对工具（add_money_entry /
  // add_phrase / save_inspiration / create_reminder）；裸内容它得先猜这是要干嘛。
  private static readonly SLASH_PREFIX: Record<string, string> = {
    insp: "记一条灵感：",
    money: "记一笔：",
    phrase: "加一条常用语：",
    rem: "提醒我：",
  };
  private async slashSend(kind: string, text: string): Promise<{ ok: boolean }> {
    const t = (text || "").trim();
    const prefix = LauncherManager.SLASH_PREFIX[kind];
    if (!t || !prefix || !this.chatSender) return { ok: false };
    if (!(await this.assistantOnline())) return { ok: false };
    this.chatSender(prefix + t);
    // 不在这里 hide：渲染层要先闪一帧「已交给秘书」再收起（稿定，收起本身就是反馈）。
    return { ok: true };
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

  // Umbra 自己的全局快捷键分别归谁。key = 归一化键位，value = 归属方显示名；
  // **value 为空串表示「归提问的那个节点自己」**（调用方据此判为不冲突）。
  //
  // 这张表是「谁在用」的唯一可靠答案。globalShortcut.isRegistered 只能回答
  // 「有没有被注册」，回答不了「被谁」—— 而用户要的恰恰是后者：
  // 报一句「已经用在别处了（快捷入口、截屏、剪贴板或另一条工作流）」等于让他
  // 自己去四个地方翻一遍。
  private hotkeyOwners(askerWfId: string, askerNodeId: string): Map<string, string> {
    const out = new Map<string, string>();
    const put = (acc: string, name: string) => {
      const a = parseAccel(acc || "");
      if (!a) return;
      if (!out.has(a.id)) out.set(a.id, name);   // 先登记的赢，和注册顺序一致
    };
    const c = this.cfg.get();
    put(c.clipboardShortcut || "", "剪贴板面板");
    put(c.phrasesShortcut || "", "常用语");
    put(c.screenshotShortcut || "", "截屏");
    if (c.launcherEnabled !== false) put(c.launcherShortcut || "Alt+Space", "快捷入口");
    put(c.vaultShortcut || "", "密码保险箱");
    // 工作流里的 Hotkey / Universal 触发器。归提问者自己的那条登记成空串。
    const names = new Map((this.cfg.get().launcherWorkflows || []).map((w) => [w.id, w.name]));
    for (const h of [...this.engine.hotkeys(), ...this.engine.universals()]) {
      const mine = h.wfId === askerWfId && h.nodeId === askerNodeId;
      put(h.accelerator, mine ? "" : `工作流「${names.get(h.wfId) || h.wfId}」`);
    }
    return out;
  }

  private async registerIpc(): Promise<void> {
    const { ipcMain, globalShortcut } = await import("electron");
    ipcMain.handle("launcher:query", (_e, q: string) => this.query(q));
    ipcMain.handle("launcher:run", (_e, id: string, mod?: string) => this.runResult(id, mod || ""));
    ipcMain.handle("launcher:sendAssistant", (_e, text: string) => this.sendAssistant(text));
    // 「/」功能菜单（批次 009）：发送 + 可达性探测（菜单态与「问秘书」兜底项的离线灰都靠它）。
    ipcMain.handle("launcher:slashSend", (_e, kind: string, text: string) => this.slashSend(String(kind || ""), String(text || "")));
    ipcMain.handle("launcher:assistantOnline", () => this.assistantOnline());
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
      };
    });
    ipcMain.handle("launcher:setEnabled", (_e, enabled: boolean) => this.setEnabled(enabled));
    ipcMain.handle("launcher:setShortcut", (_e, acc: string) => this.setShortcut(acc));
    ipcMain.handle("launcher:setFolders", (_e, folders: LauncherFolder[]) => this.setFolders(folders));
    ipcMain.handle("launcher:setScripts", (_e, scripts: LauncherScript[]) =>
      this.cfg.save({ launcherScripts: Array.isArray(scripts) ? scripts : [] }));
    // 工作流读写（画布编辑器用）。写入后重注册 Hotkey 触发。
    ipcMain.handle("launcher:getWorkflows", () => this.cfg.get().launcherWorkflows || []);
    ipcMain.handle("launcher:setWorkflows", async (_e, workflows: Workflow[]) => {
      await this.cfg.save({ launcherWorkflows: Array.isArray(workflows) ? workflows : [] });
      this.reregister();  // 工作流里的 Hotkey 触发可能变化 → 重注册全局快捷键
    });
    ipcMain.handle("launcher:openWorkflowEditor", () => this.openWorkflowEditor());
    // 打开这条工作流自己的目录（不存在就先建）。脚本节点的默认 cwd 就是这里，
    // 用户把 runtime/、index.js 这类随行文件丢进去，脚本才能写相对路径。
    ipcMain.handle("launcher:openWorkflowDir", async (_e, wfId: string) => {
      const dir = await ensureWorkflowDir(this.cfg.dir, String(wfId || ""));
      const { shell } = await import("electron");
      const err = await shell.openPath(dir);
      return { ok: !err, dir, error: err || "" };
    });
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
    // 快捷键可用性检测：查一张已知系统快捷键表，表里没有再做一次注册探测。
    // 探测**必须用完就注销** —— 用户还在配置界面上试键位，留着就等于已经把键抢过来了；
    // 而且我们自己已经注册过的键（比如快捷入口那个）会让 register 返回 false，
    // 所以先用 isRegistered 把「自己占的」摘出去，否则会把自家的键报成「被别的应用占用」。
    // askerWfId / askerNodeId：**正在编辑的那个节点**。它自己占着这个键不算冲突 ——
    // 保存之后我们就把这个键注册上了，不排除自己的话，再打开这个节点必然报一条
    // 「已经用在别处了」，而那个「别处」就是它本人（用户点名的假阳性）。
    ipcMain.handle("launcher:checkAccel", async (_e, accel: string, askerWfId?: string, askerNodeId?: string) => {
      const { globalShortcut } = await import("electron");
      const acc = String(accel || "");
      const owners = this.hotkeyOwners(String(askerWfId || ""), String(askerNodeId || ""));
      const r = checkAccel(acc, (id) => {
        // 走到 probe 说明 owners 里没人认领 —— 此时 isRegistered 为真只可能是残留
        // （比如另一次探测正在进行）。仍然报 self，但措辞上说清「没查出是哪一处」，
        // 不再冒充确定结论。
        if (globalShortcut.isRegistered(id)) return "self";
        let ok = false;
        try { ok = globalShortcut.register(id, () => { /* 探测用，不做事 */ }); }
        catch { return "taken"; }
        if (ok) globalShortcut.unregister(id);
        return ok ? "free" : "taken";
      }, process.platform, owners);
      // 提示语在主进程拼好一并返回：措辞和判定是一回事，分到渲染层去写迟早会对不上。
      return { ...r, message: accelMessage(r, acc) };
    });
    // 工作流调试轨迹：只读内存里最近若干次执行（编辑器底部调试抽屉用）。
    // 编辑器顶栏的「运行」：带参跑一条工作流，轨迹照常进调试抽屉。
    ipcMain.handle("launcher:runWorkflow", (_e, wfId: string, nodeId: string, arg: string) =>
      this.engine.runFromEditor(String(wfId || ""), String(nodeId || ""), String(arg ?? "")));
    ipcMain.handle("launcher:getTrace", (_e, wfId: string) => this.engine.trace.list(wfId || undefined));
    ipcMain.handle("launcher:clearTrace", () => { this.engine.trace.clear(); });
    // 常用语读写（设置页管理）。
    ipcMain.handle("launcher:getPhrases", () => this.cfg.get().phrases || []);
    // 保存常用语：顺带盖改动时间戳、收集删除墓碑，再排一次云端推送。
    // 时间戳只盖在「内容真的变了」的条目上——无脑全盖会让本机的所有条目在合并时
    // 无理由地赢过别的设备。
    ipcMain.handle("launcher:setPhrases", async (_e, phrases: Phrase[]) => {
      const next = Array.isArray(phrases) ? phrases : [];
      const prev = this.cfg.get().phrases || [];
      await this.cfg.save({
        phrases: stampUpdated(next, prev),
        phrasesDeleted: collectTombs(next, prev, this.cfg.get().phrasesDeleted || []),
      });
      this.phraseSync.schedulePush();
    });
    // 常用语标签清单（批次 012）。读：配置里的清单 + phrases 里出现过但不在清单里的 keyword 兜底追加
    // （老数据的触发词自动成为标签，不用迁数据）。写：整份覆盖 + 盖时间戳 + 排一次推送。
    ipcMain.handle("launcher:getPhraseTags", () => this.phraseTags());
    ipcMain.handle("launcher:setPhraseTags", async (_e, names: string[]) => {
      const clean = uniqTags(Array.isArray(names) ? names : []);
      await this.cfg.save({ phraseTags: clean, phraseTagsUpdatedAt: Date.now() });
      this.phraseSync.schedulePush();
      await this.broadcastPhrases();
    });
    // 常用语同步：设置页的「立即同步」按钮 + 状态展示。
    ipcMain.handle("launcher:phrasesSyncNow", () => this.phraseSync.sync());
    ipcMain.handle("launcher:phrasesSyncState", () => this.phraseSync.getState());
    // 大字显示浮层：渲染层 ready 时索取文本；渲染完成后再显示窗口（去残影）；关闭时隐藏。
    ipcMain.handle("largetype:ready", () => this.pendingLarge);
    ipcMain.handle("largetype:rendered", () => {
      if (!this.largeWin || this.largeWin.isDestroyed()) return;
      if (this.largeBounds) this.largeWin.setBounds(this.largeBounds);
      // 只 showInactive、不 focus：大字窗是给人**看**的，不该把焦点从用户正在用的
      // 应用手里抢走；抢了焦点又会引出下面那串「失焦就消失」的连锁反应。
      this.largeWin.showInactive();
      this.armLargeEscape(true);
    });
    ipcMain.handle("largetype:close", () => this.hideLargeType());
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

  // 大字显示：全屏透明浮层，居中放大显示内容，**常驻到 Esc 或点击为止**。
  // 窗口先隐藏，渲染层把新内容画好后回调 largetype:rendered 再显示，避免先闪出上次内容。
  //
  // ⚠️ 两个验收实锤（sam，2026-09-03）：「触发时跳到别的屏幕」「过一会儿自己消失」。
  // 病根是同一个：这个窗原来 focus() 抢焦点 + 监听 blur 自动收起。工作流从快捷入口
  // 触发时面板随即收起，macOS 就把本 app 的下一个窗口（主窗口）顶到前台 —— 主窗口在
  // 哪个 Space/屏幕，画面就切到哪（「跳屏」）；主窗口一到前台大字窗就失焦（「消失」）。
  // 现在：① 窗口是**非激活面板**（type: panel + focusable: false），显示、点击都不会
  // 把本 app 激活，用户正在用的应用一直握着焦点，Space 不会切；② 不再监听 blur；
  // ③ Esc 走**全局快捷键**（只在可见期间注册，收起即注销 —— 窗口不拿焦点，键盘事件
  // 到不了它，只能这么接）；④ 点击浮层任意处关闭（渲染层的 click → largetype:close）。
  //
  // 「先闪一下上次的内容再换成这次的」（sam 第二轮）：hide 只是把窗口藏起来，DOM 里还是
  // 上次的字；再显示时 macOS 会先把旧的那帧合成上去，新帧要等渲染层下一次绘制。
  // 两头一起堵：收起时就让渲染层把内容清空（largetype:clear，见 hideLargeType），
  // 渲染层画完新内容后等两帧 rAF 再回调 rendered（见 largetype-entry.ts）—— 显示的那一刻
  // 屏幕上一定是这次的字，最坏也只是空白，不会是上次的。
  async showLargeType(text: string): Promise<void> {
    const t = (text || "").trim();
    if (!t) return;
    const { BrowserWindow, screen } = await import("electron");
    // 上次的窗还开着 → 先收（顺带清空内容），再当新的一次显示。
    if (this.largeWin && !this.largeWin.isDestroyed() && this.largeWin.isVisible()) this.hideLargeType();
    this.pendingLarge = t;
    this.largeBounds = this.currentDisplay(screen).workArea;
    if (!this.largeWin || this.largeWin.isDestroyed()) {
      const win = new BrowserWindow({
        x: this.largeBounds.x, y: this.largeBounds.y, width: this.largeBounds.width, height: this.largeBounds.height,
        frame: false, transparent: true, resizable: false, movable: false,
        skipTaskbar: true, show: false, fullscreenable: false, hasShadow: false,
        // macOS：NSPanel + 非激活掩码。点它不会激活本 app、不会把主窗口拽到前台。
        // focusable:false 让 showInactive 也不可能被系统顺手给焦点；acceptFirstMouse
        // 让「第一下点击」直接算点击（否则非激活窗的第一下会被吃成激活动作）。
        type: process.platform === "darwin" ? "panel" : undefined,
        focusable: false,
        acceptFirstMouse: true,
        backgroundColor: "#00000000",
        // backgroundThrottling:false —— 这个窗大部分时间藏着，渲染层要在**藏着的时候**把
        // 新内容画好再显示（见 largetype-entry.ts 的两帧 rAF）；节流一开，隐藏页的 rAF
        // 根本不跑，窗口就永远等不到 rendered。
        webPreferences: { preload: this.opts.preloadPath, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      win.setAlwaysOnTop(true, "screen-saver");
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      if (this.opts.devUrl) win.loadURL(`${this.opts.devUrl}/largetype.html`).catch(() => {});
      else win.loadFile(path.join(this.opts.distDir, "largetype.html")).catch(() => {});
      win.webContents.on("did-finish-load", () => win.webContents.send("largetype:text", this.pendingLarge));
      win.on("closed", () => { this.armLargeEscape(false); this.largeWin = null; });
      this.largeWin = win;
    } else {
      this.largeWin.webContents.send("largetype:text", this.pendingLarge);
    }
  }

  // 收起：注销 Esc、藏窗、清空待显示文本，并让渲染层把 DOM 里的字也清掉（见 showLargeType 的说明）。
  private hideLargeType(): void {
    this.armLargeEscape(false);
    this.pendingLarge = "";
    if (!this.largeWin || this.largeWin.isDestroyed()) return;
    if (this.largeWin.isVisible()) this.largeWin.hide();
    this.largeWin.webContents.send("largetype:clear");
  }

  // 大字窗可见期间接管 Esc。全局快捷键是系统级的，注册着就会把别的应用的 Esc 也吃掉，
  // 所以必须「显示才注册、收起立刻注销」，一刻都不能多占。
  private largeEscArmed = false;
  private armLargeEscape(on: boolean): void {
    if (on === this.largeEscArmed) return;
    this.largeEscArmed = on;
    void import("electron").then(({ globalShortcut }) => {
      try {
        if (on) globalShortcut.register("Escape", () => this.hideLargeType());
        else globalShortcut.unregister("Escape");
      } catch { /* 注册不上就只剩点击关闭，不影响显示 */ }
    });
  }

  // 「当前屏幕」：快捷入口面板开着、或**刚刚**才收起（工作流是 showLargeType 与
  // hide 紧挨着调的，等 import 回来时面板已经藏了）就用面板所在的屏 —— 用户正对着它
  // 敲的回车；否则用鼠标所在的屏，和面板唤起时的定位规则一致。
  private panelBounds: Electron.Rectangle | null = null;
  private panelHiddenAt = 0;
  private currentDisplay(screen: Electron.Screen): Electron.Display {
    const visible = !!this.panel && !this.panel.isDestroyed() && this.panel.isVisible();
    if (this.panelBounds && (visible || Date.now() - this.panelHiddenAt < 1500)) {
      try { return screen.getDisplayMatching(this.panelBounds); } catch { /* 回落到鼠标 */ }
    }
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
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
        // 同快捷入口面板：非激活 panel，focus 拿键盘（Esc / 滚动）但不激活 app，
        // 不把被盖住的主窗口带到最前（2026-09-03 第四轮，同一条根）。
        type: process.platform === "darwin" ? "panel" : undefined,
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
        // 非 ASCII 的键位（旧版录制器留下的 "Alt+Shift+◊"）交给 Electron 会在原生层
        // 打 ERROR 再抛异常。挡在这里，日志才看得懂，也不会影响别的工作流注册。
        const bad = accelProblem(h.accelerator);
        if (bad) { console.warn(`[launcher] 工作流快捷键用不了（${bad}）：${h.accelerator} —— 去节点里重录一次`); continue; }
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
