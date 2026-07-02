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
  computerBlacklist: string[];   // 禁止操作的应用名（子串匹配，前台应用命中即拒绝）
  disabledProviders: string[];   // 用户在能力页手动停用的程序名（即使安装/可用也不上报、不可执行）
  // ── 剪贴板历史 ──
  clipboardEnabled: boolean;     // 后台监听剪贴板开关
  clipboardShortcut: string;     // 唤起面板的全局快捷键（Electron Accelerator）
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
    computerBlacklist: [
      "terminal", "iterm", "console",
      "keychain", "钥匙串", "1password", "bitwarden", "lastpass",
      "system settings", "system preferences", "系统设置", "系统偏好",
      "alipay", "支付宝", "wechat", "微信", "bank", "银行", "wallet", "钱包",
      "活动监视器", "activity monitor",
    ],
    disabledProviders: [],
    clipboardEnabled: envBool("UMBRA_CLIPBOARD_ENABLED", true),
    clipboardShortcut: process.env.UMBRA_CLIPBOARD_SHORTCUT || "Alt+V",
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
