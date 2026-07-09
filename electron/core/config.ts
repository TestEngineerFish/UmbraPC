// 设备引擎配置：持久化到 Electron userData 下的 umbra-config.json，
// 默认值可被环境变量覆盖；设置页通过 IPC 改写后立即生效（触发重连）。
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AllowExec = "never" | "confirm" | "always";

export interface UmbraConfig {
  serverUrl: string;        // https://host  → 派生 ws(s)://host/ws/device 与 http 基址
  token: string;            // 对应服务端 ASSIST_TOKEN
  deviceId: string;
  deviceName: string;
  heartbeatInterval: number; // 秒
  codingEnabled: boolean;
  codingEngines: string[];   // 优先级，auto 取第一个可用
  codingBaseDir: string;     // 代码产物根目录
  codingTimeout: number;     // 秒
  codingAllowExec: AllowExec;
  confirmTimeout: number;    // 秒
  providersFile: string;     // providers.json 路径
  // ── computer-use（GUI 自动化，高权限，默认关）──
  computerUseEnabled: boolean;   // 总开关：关则 computer Provider 不注册、不可用
  computerConfirm: boolean;      // 关键动作(type/key/open_app)执行前需用户确认
  // 每个电脑动作的授权策略：'allow'=总是允许(跳过确认)，'deny'=禁止执行；未列出=按 computerConfirm 询问。
  computerSkillPolicy: Record<string, "allow" | "deny">;
  computerBlacklist: string[];   // 禁止操作的应用名（子串匹配，前台应用命中即拒绝）
  disabledProviders: string[];   // 用户在能力页手动停用的程序名（即使安装/可用也不上报、不可执行）
  // ── 剪贴板历史 ──
  clipboardEnabled: boolean;     // 后台监听剪贴板开关
  clipboardShortcut: string;     // 唤起面板的全局快捷键（Electron Accelerator）
  clipboardAutoPaste: boolean;   // 选中历史后自动粘贴到前台应用（默认关，只复制）
  // ── 截图 ──
  screenshotEnabled: boolean;    // 截图功能开关（关则不注册快捷键）
  screenshotShortcut: string;    // 截图全局快捷键
  glmApiKey: string;             // 智谱 GLM API Key（截图翻译直连用；不硬编码，走 env/设置）
  // ── 快捷入口 Launcher（类 Alfred）──
  launcherEnabled: boolean;      // 总开关（关则不注册快捷键、不可唤起）
  launcherShortcut: string;      // 唤起快捷键（Electron Accelerator，默认 ⌥Space = "Alt+Space"）
  launcherFolders: LauncherFolder[]; // 文件夹书签：用指定软件打开固定文件夹
  launcherScripts: LauncherScript[]; // 自定义脚本（旧；加载时迁移为工作流）
  phrases: Phrase[];                 // 常用语（快捷入口可搜、回车插入；设置里管理排序）
  launcherWorkflows: Workflow[];     // 工作流编排（类 Alfred Workflow）
  launcherScriptsMigrated?: boolean; // 迁移标记：launcherScripts 已转成工作流（幂等）
  launcherMigratedV2?: boolean;      // 迁移标记 V2：文件夹书签 + 有道 已转成工作流
  launcherToolsSeeded?: boolean;     // 种子标记：内置工具(编解码/计算/换算)已作为默认工作流写入
  youdaoAppKey: string;          // 有道翻译 appKey（Phase 2 用）
  youdaoSecret: string;          // 有道翻译 secret（Phase 2 用）
  locale?: string;               // 界面语言（zh-CN | en）；缺省时由主进程按系统语言初始化
}

// 文件夹书签：在快捷入口里用 app（缺省则系统默认）打开 path。
export interface LauncherFolder {
  name: string;   // 显示名
  path: string;   // 绝对路径（支持 ~）
  app?: string;   // 用哪个应用打开（如 "Visual Studio Code"、"Finder"）；空=系统默认
}

// 自定义脚本：搜到即可执行；needsInput 时把 keyword 后的文本作为 $1 传入。
// （已被工作流取代：加载时自动迁移为 Keyword+Run Script 工作流，此类型仅为迁移兼容保留。）
export interface LauncherScript {
  name: string;         // 显示名
  keyword?: string;     // 可选前缀触发（如 "fy"）；空则按名称匹配
  command: string;      // shell 命令（bash -lc 执行，输入作为 $1）
  icon?: string;        // emoji / 图标
  needsInput?: boolean; // 是否需要输入
  output?: "copy" | "none"; // 输出处理：复制 stdout / 忽略。默认 copy
}

// 常用语：在快捷入口按名称/内容/关键词搜到，回车即插入（粘贴到前台应用）。数组顺序即显示排序。
export interface Phrase {
  id: string;
  name: string;      // 显示名/标签
  content: string;   // 实际文本（插入的内容）
  keyword?: string;  // 可选关键词，快速定位
}

// ── 工作流编排（类 Alfred Workflow）──
// 一个工作流 = 一张节点图：触发(Trigger) → 输入(Input/Script Filter) → 动作(Action) → 输出(Output)。
// 节点间用连线连接，连线可带修饰键（回车/⌘/⌥/⌃/⇧）走不同分支。兼容 Alfred Script Filter JSON。
export interface WorkflowNode {
  id: string;                        // 节点内唯一 id
  type: string;                      // "trigger.keyword" | "trigger.hotkey" | "input.scriptfilter"
                                     // | "action.script" | "action.copy" | "action.paste"
                                     // | "action.openurl" | "action.openfile" | "action.assistant"
                                     // | "action.inspiration" | "output.notify" | "output.largetype"
  x: number;                         // 画布坐标
  y: number;
  config: Record<string, unknown>;   // 节点配置（随 type 不同）
}
// 连线：from 节点输出 → to 节点输入；mod 指定触发该分支的修饰键（空=回车）。
export interface WorkflowConnection {
  from: string;
  to: string;
  mod?: "" | "cmd" | "alt" | "ctrl" | "shift" | "cmd+alt" | "cmd+shift" | "cmd+ctrl";
}
export interface Workflow {
  id: string;
  name: string;
  icon?: string;                     // emoji 或 图标路径
  desc?: string;                     // 描述（可选）
  enabled: boolean;
  variables?: Record<string, string>; // 工作流级变量（可含密钥），注入脚本 env
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
}

const envBool = (k: string, d: boolean) => {
  const v = (process.env[k] || "").toLowerCase();
  if (!v) return d;
  return ["1", "true", "yes", "on"].includes(v);
};

// 展开开头的 ~ 为用户主目录。
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function defaults(configDir: string): UmbraConfig {
  return {
    serverUrl: (process.env.UMBRA_SERVER_URL || "https://umbra.tingyusha.xyz").replace(/\/+$/, ""),
    token: process.env.UMBRA_DEVICE_TOKEN || "",
    deviceId: process.env.UMBRA_DEVICE_ID || "",
    deviceName: process.env.UMBRA_DEVICE_NAME || `${os.hostname()} (${process.platform})`,
    heartbeatInterval: Number(process.env.UMBRA_HEARTBEAT_INTERVAL || 30),
    codingEnabled: envBool("UMBRA_CODING_ENABLED", true),
    codingEngines: (process.env.UMBRA_CODING_ENGINES || "claude,codex").split(",").map((s) => s.trim()).filter(Boolean),
    codingBaseDir: process.env.UMBRA_CODING_BASE_DIR || "~/Umbra/projects",
    codingTimeout: Number(process.env.UMBRA_CODING_TIMEOUT || 600),
    codingAllowExec: (process.env.UMBRA_CODING_ALLOW_EXEC || "confirm").toLowerCase() as AllowExec,
    confirmTimeout: Number(process.env.UMBRA_CONFIRM_TIMEOUT || 300),
    providersFile: process.env.UMBRA_PROVIDERS_FILE || path.join(configDir, "providers.json"),
    computerUseEnabled: envBool("UMBRA_COMPUTER_USE", false),
    // 默认关：operate 在服务端做"方案确认 + 红线确认"，不在设备端逐个动作确认（太吵）。
    computerConfirm: envBool("UMBRA_COMPUTER_CONFIRM", false),
    computerSkillPolicy: {},
    computerBlacklist: [
      "terminal", "iterm", "console",
      "keychain", "钥匙串", "1password", "bitwarden", "lastpass",
      "system settings", "system preferences", "系统设置", "系统偏好",
      "alipay", "支付宝", "wechat", "微信", "bank", "银行", "wallet", "钱包",
      "活动监视器", "activity monitor",
    ],
    disabledProviders: [],
    clipboardEnabled: envBool("UMBRA_CLIPBOARD_ENABLED", true),
    clipboardShortcut: process.env.UMBRA_CLIPBOARD_SHORTCUT || "Command+Shift+V",
    clipboardAutoPaste: envBool("UMBRA_CLIPBOARD_AUTOPASTE", false),
    screenshotEnabled: envBool("UMBRA_SCREENSHOT_ENABLED", true),
    screenshotShortcut: process.env.UMBRA_SCREENSHOT_SHORTCUT || "Command+Control+A",
    glmApiKey: process.env.UMBRA_GLM_API_KEY || "",
    launcherEnabled: envBool("UMBRA_LAUNCHER_ENABLED", true),
    launcherShortcut: process.env.UMBRA_LAUNCHER_SHORTCUT || "Alt+Space",
    launcherFolders: [],
    launcherScripts: [],
    phrases: [],
    launcherWorkflows: [],
    launcherScriptsMigrated: false,
    youdaoAppKey: process.env.UMBRA_YOUDAO_APPKEY || "",
    youdaoSecret: process.env.UMBRA_YOUDAO_SECRET || "",
  };
}

// 派生：设备 WebSocket 地址。
export function deviceWsUrl(c: UmbraConfig): string {
  return c.serverUrl.replace(/^http/, "ws") + "/ws/device";
}
// 派生：HTTP 基址（用于 /files/upload）。
export function httpBase(c: UmbraConfig): string {
  return c.serverUrl.replace(/\/+$/, "");
}

// 配置存取：加载（缺省值 ← 文件覆盖）、保存补丁、确保 deviceId 稳定。
export class ConfigStore {
  private file: string;
  private cfg: UmbraConfig;

  constructor(private configDir: string) {
    this.file = path.join(configDir, "umbra-config.json");
    this.cfg = defaults(configDir);
  }

  async load(): Promise<UmbraConfig> {
    try {
      const raw = await fs.readFile(this.file, "utf-8");
      const saved = JSON.parse(raw);
      this.cfg = { ...this.cfg, ...saved };
    } catch {
      /* 文件不存在或损坏 → 用默认 */
    }
    if (!this.cfg.deviceId) {
      this.cfg.deviceId = `pc-${os.hostname()}-${Math.random().toString(36).slice(2, 8)}`.replace(/\s+/g, "-");
      await this.save({});
    }
    return this.cfg;
  }

  get(): UmbraConfig {
    return this.cfg;
  }

  async save(patch: Partial<UmbraConfig>): Promise<UmbraConfig> {
    this.cfg = { ...this.cfg, ...patch };
    if (typeof this.cfg.serverUrl === "string") this.cfg.serverUrl = this.cfg.serverUrl.replace(/\/+$/, "");
    await fs.mkdir(this.configDir, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.cfg, null, 2), "utf-8");
    return this.cfg;
  }
}
