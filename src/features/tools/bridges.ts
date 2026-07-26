// 「工具」模块用到的 preload 桥类型与可用性探测。
// 这些能力只有桌面端（Electron）才注入 window.umbraXxx，Web 端一律不显示对应二级页。
import { type WF } from "../launcher/WorkflowEditor";

// 文件夹书签：用指定软件打开固定文件夹。
export interface LauncherFolder { name: string; path: string; app?: string }
// 自定义脚本项：关键字触发，可选是否要输入、结果是否回写剪贴板。
export interface LauncherScript { name: string; keyword?: string; command: string; icon?: string; needsInput?: boolean; output?: "copy" | "none" }
// 常用语：名称 + 内容，可选关键字直达。
export interface Phrase { id: string; name: string; content: string; keyword?: string }

// 快捷入口主进程桥。
export interface LauncherAPI {
  getSettings(): Promise<{ enabled: boolean; shortcut: string; folders: LauncherFolder[]; scripts: LauncherScript[]; registered: boolean; youdaoConfigured: boolean }>;
  setEnabled(enabled: boolean): Promise<void>;
  setShortcut(acc: string): Promise<{ ok: boolean }>;
  setFolders(folders: LauncherFolder[]): Promise<void>;
  setScripts(scripts: LauncherScript[]): Promise<void>;
  setYoudao(appKey: string, secret: string): Promise<void>;
  pickPath(): Promise<string>;
  pickApp(): Promise<string>;
  getWorkflows(): Promise<WF[]>;
  setWorkflows(workflows: WF[]): Promise<void>;
  openWorkflowEditor(): Promise<void>;
  getPhrases(): Promise<Phrase[]>;
  setPhrases(phrases: Phrase[]): Promise<void>;
}

// 剪贴板历史主进程桥（设置面用到的子集）。
export interface ClipAPI {
  getSettings(): Promise<{ autoPaste?: boolean }>;
  setShortcut(acc: string): Promise<unknown>;
  setAutoPaste(on: boolean): Promise<unknown>;
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

type Win = {
  umbraClip?: ClipAPI;
  umbraShot?: ShotAPI;
  umbraLauncher?: LauncherAPI;
  umbraVault?: VaultAPI;
};
const w = window as unknown as Win;

// 各能力是否可用（桌面端注入才为 true）。
export const hasClip = typeof w.umbraClip !== "undefined";
export const hasShot = typeof w.umbraShot !== "undefined";
export const hasLauncher = typeof w.umbraLauncher !== "undefined";
export const hasVault = typeof w.umbraVault !== "undefined";

// 取桥实例：只在对应 hasXxx 为 true 时调用。
export const clipApi = (): ClipAPI => w.umbraClip as ClipAPI;
export const shotApi = (): ShotAPI => w.umbraShot as ShotAPI;
export const launcherApi = (): LauncherAPI => w.umbraLauncher as LauncherAPI;
export const vaultApi = (): VaultAPI => w.umbraVault as VaultAPI;
