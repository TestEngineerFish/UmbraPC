// 「工具」模块用到的 preload 桥类型与可用性探测。
// 这些能力只有桌面端（Electron）才注入 window.umbraXxx，Web 端一律不显示对应二级页。
import { type WF } from "../launcher/WorkflowEditor";

// 文件夹书签：用指定软件打开固定文件夹。
export interface LauncherFolder { name: string; path: string; app?: string }
// 自定义脚本项：关键字触发，可选是否要输入、结果是否回写剪贴板。
export interface LauncherScript { name: string; keyword?: string; command: string; icon?: string; needsInput?: boolean; output?: "copy" | "none" }
// 常用语：名称 + 内容，可选关键字直达。
export interface Phrase { id: string; name: string; content: string; keyword?: string; updatedAt?: number }

// 常用语云端同步状态（设置页展示「上次同步 / 失败原因」用）。
export interface PhraseSyncState {
  syncing: boolean;
  lastAt: number;       // 上次成功同步的时间戳，0=从没成功过
  lastError: string;    // 上次失败原因，空串=没失败
  configured: boolean;  // 是否配好了服务器地址与 token
}

// 快捷入口主进程桥。
export interface LauncherAPI {
  getSettings(): Promise<{ enabled: boolean; shortcut: string; folders: LauncherFolder[]; scripts: LauncherScript[]; registered: boolean }>;
  setEnabled(enabled: boolean): Promise<void>;
  setShortcut(acc: string): Promise<{ ok: boolean }>;
  setFolders(folders: LauncherFolder[]): Promise<void>;
  setScripts(scripts: LauncherScript[]): Promise<void>;
  pickPath(): Promise<string>;
  pickApp(): Promise<string>;
  getWorkflows(): Promise<WF[]>;
  setWorkflows(workflows: WF[]): Promise<void>;
  openWorkflowEditor(): Promise<void>;
  // 打开这条工作流自己的目录（随行脚本/可执行文件放在里面），不存在会先建。
  openWorkflowDir(wfId: string): Promise<{ ok: boolean; dir: string; error: string }>;
  getPhrases(): Promise<Phrase[]>;
  setPhrases(phrases: Phrase[]): Promise<void>;
  phrasesSyncNow(): Promise<boolean>;
  phrasesSyncState(): Promise<PhraseSyncState>;
  onPhrasesChanged(cb: (list: Phrase[]) => void): () => void;
}

// 剪贴板历史分类保留时长（小时，0=永久保留）。
export interface ClipKeep {
  text: number;
  image: number;
  files: number;
}

// 剪贴板历史主进程桥（设置面用到的子集）。
export interface ClipAPI {
  getSettings(): Promise<{ autoPaste?: boolean; keep?: ClipKeep; phrasesShortcut?: string }>;
  setShortcut(acc: string): Promise<unknown>;
  setAutoPaste(on: boolean): Promise<unknown>;
  setKeep(keep: ClipKeep): Promise<unknown>;
  setPhrasesShortcut(acc: string): Promise<{ ok: boolean }>;
  // 只清收藏，返回删掉的条数（保留时长永远不碰收藏，所以单给一个出口）。
  clearFavorites(): Promise<number>;
}

// 截图主进程桥（设置面用到的子集）。
export interface ShotAPI {
  setShortcut(acc: string): Promise<unknown>;
}

// 密码保险箱主进程桥（设置面用到的子集）。
export interface VaultAPI {
  openWindow(): Promise<void>;
  status(): Promise<{ shortcut: string }>;
  setShortcut(acc: string): Promise<{ ok: boolean }>;
}

// ── 运行时环境（Java / Python 多版本）──────────────────────────────────────────
// 这些类型是主进程 electron/core/runtime/parse.ts 的镜像。刻意重复声明而不是跨层 import：
// 渲染层 import 主进程的文件会把 node:fs / node:child_process 拖进 bundle
// （工作流引擎那边已经踩过这个坑）。字段少、变动也少，重复的代价小于把 Node API 打进前端。

/** 一个装在机器上的运行时。 */
export interface RuntimeInstall {
  id: string; kind: string; version: string; raw: string;
  home: string; bin: string; vendor: string; arch: string;
  source: string; managed: boolean;
}
/** 「当前生效的是哪个」。刻意是多条 —— 命令行与构建工具的答案经常不一样。 */
export interface RuntimeActive { who: string; installId: string; reason: string; path: string }
/** 一条诊断。fix 是给用户自己去终端执行的命令。 */
export interface RuntimeIssue { code: string; level: "error" | "warn" | "info"; title: string; detail: string; fix: string }
export interface RuntimeManager { name: string; version: string; path: string }

export interface RuntimeScan {
  kind: string;
  installs: RuntimeInstall[];
  actives: RuntimeActive[];
  issues: RuntimeIssue[];
  managers: RuntimeManager[];
  aliases: Record<string, string>;
  /** 探测实际用的 PATH：appPathDirs 与 shellPathDirs 的并集。 */
  pathDirs: string[];
  /** Umbra 进程自己的 PATH。 */
  appPathDirs: string[];
  /** 登录 shell 的真实 PATH；读不到（或 Windows）时是空数组。 */
  shellPathDirs: string[];
  scannedAt: number;
  elapsedMs: number;
  /** 哪些探测超时/失败了。**必须显示** —— 静默少一条比报错更坏。 */
  partial: string[];
}

export interface RuntimeAPI {
  scan(kind: string): Promise<RuntimeScan>;
}

/** 来源 key → 中文名。认不出就原样显示（宁可露出个英文 key 也别显示空白）。 */
export const RUNTIME_SOURCE: Record<string, string> = {
  system: "系统自带", homebrew: "Homebrew", pyenv: "pyenv", uv: "uv",
  sdkman: "SDKMAN", "jvm-dir": "系统 JDK 目录", framework: "python.org 安装包",
  conda: "conda", mise: "mise", path: "PATH 上找到",
};

type Win = {
  umbraClip?: ClipAPI;
  umbraShot?: ShotAPI;
  umbraLauncher?: LauncherAPI;
  umbraVault?: VaultAPI;
  umbraRuntime?: RuntimeAPI;
};
const w = window as unknown as Win;

// 各能力是否可用（桌面端注入才为 true）。
export const hasClip = typeof w.umbraClip !== "undefined";
export const hasShot = typeof w.umbraShot !== "undefined";
export const hasLauncher = typeof w.umbraLauncher !== "undefined";
export const hasVault = typeof w.umbraVault !== "undefined";
export const hasRuntime = typeof w.umbraRuntime !== "undefined";

// 取桥实例：只在对应 hasXxx 为 true 时调用。
export const clipApi = (): ClipAPI => w.umbraClip as ClipAPI;
export const shotApi = (): ShotAPI => w.umbraShot as ShotAPI;
export const launcherApi = (): LauncherAPI => w.umbraLauncher as LauncherAPI;
export const vaultApi = (): VaultAPI => w.umbraVault as VaultAPI;
export const runtimeApi = (): RuntimeAPI => w.umbraRuntime as RuntimeAPI;
