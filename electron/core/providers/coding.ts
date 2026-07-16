// coding 引擎公共工具（Claude Code / Codex）：引擎探测、PATH 补齐、项目路径防护。
//
// ⚠️ 旧的 claude_code / codex 一次性 write_code Provider **已删除**（此前已停止注册）：
// 它被「代理任务(agent.agent_run)」完全取代，且服务端统一任务模型后（create_task 的
// skill 步对 codex/claude_code 有守卫，一律引导走 agent 执行体）永远不会再派 write_code。
// 本文件只保留 agent.ts 复用的四个工具函数。
import { readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { which } from "../shared/util";
import { UmbraConfig } from "../config";

// 引擎名 → 可执行文件名。
const ENGINE_BIN: Record<string, string> = { claude: "claude", codex: "codex" };

// 本机实际可用（已安装）的引擎，按配置优先级排列。
export function availableEngines(cfg: UmbraConfig): string[] {
  const p = enginePath();
  return cfg.codingEngines.filter((e) => which(ENGINE_BIN[e] || e, p) !== null);
}

// 打包后的 GUI 应用只有 /usr/bin:/bin:… —— claude/codex 常装在 homebrew / npm-global / bun 下。
// which 与子进程都要用这份补齐后的 PATH，否则「能力页说已就绪、真跑起来找不到」。
export function enginePath(): string {
  const home = os.homedir();
  const extra = [
    "/opt/homebrew/bin", "/usr/local/bin",
    path.join(home, ".local/bin"), path.join(home, ".bun/bin"),
    path.join(home, ".npm-global/bin"), path.join(home, ".volta/bin"),
    "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ];
  // nvm：node 常只存在于 ~/.nvm/versions/node/<ver>/bin —— 而 claude 的 shebang 要找 node。
  // GUI 启动的应用没有登录 shell 的 PATH，会出现「claude 找得到、node 找不到」。
  try {
    const nvm = path.join(home, ".nvm/versions/node");
    for (const v of readdirSync(nvm)) extra.push(path.join(nvm, v, "bin"));
  } catch {
    /* 没装 nvm */
  }
  const cur = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return [...new Set([...cur, ...extra])].join(path.delimiter);
}

// 在 baseDir 下解析隔离的项目目录，拒绝路径逃逸。
export function safeProjectDir(baseDir: string, project: string | undefined): string {
  const base = path.resolve(baseDir.replace(/^~(?=$|\/)/, os.homedir()));
  const name = (project || "").trim();
  let slug: string;
  if (name) {
    slug = name.replace(/[^\w一-鿿.-]+/gu, "-").replace(/^[-.]+|[-.]+$/g, "") || "project";
  } else {
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    slug = `project-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  }
  const target = path.resolve(base, slug);
  if (base !== target && !target.startsWith(base + path.sep)) throw new Error(`非法项目路径：${project}`);
  return target;
}

// 选引擎：requested 为空/auto 用第一个可用的；指定了但不可用就报错（不静默换）。
export function pickEngine(requested: string | undefined, engines: string[]): string {
  if (engines.length === 0) throw new Error("本机未安装可用的编码助手（claude/codex）");
  const req = (requested || "auto").trim().toLowerCase();
  if (req === "" || req === "auto") return engines[0];
  if (engines.includes(req)) return req;
  throw new Error(`请求的引擎 ${req} 不可用；可用：${engines.join(", ")}`);
}
