// 聚合本机所有内置 + 配置 Provider，构建一个注册表。
import { UmbraConfig } from "../config";
import { Registry } from "./registry";
import { registerSystem } from "./system";
import { registerAgent } from "./agent";
import { registerConfigProviders } from "./config-providers";
import { registerComputer } from "../computer";

// 构建注册表：system → agent → computer(默认关) → providers.json（同名覆盖）。
//
// 注：旧的 claude_code / codex 的一次性 write_code 已**下线**——它被「代理任务(agent)」完全取代
//（同一个引擎、同一个目录，但任务有句柄、能追问、能收工）。同时留着两条路只会让秘书选错，
// 而且一次性那条根本没法验收。coding.ts 仍保留，agent.ts 复用它的引擎探测与路径防护。
export async function buildRegistry(cfg: UmbraConfig): Promise<Registry> {
  const r = new Registry();
  registerSystem(r, cfg);
  registerAgent(r, cfg); // 代理任务：可追问的长任务（服务端只拿 job_id 说话）
  registerComputer(r, cfg);
  await registerConfigProviders(r, cfg);
  // 用户在能力页手动停用的程序：标记为不可用（仍上报以便在页面上看到并可重新开启）。
  const disabled = new Set(cfg.disabledProviders || []);
  for (const m of r.providers()) {
    if (disabled.has(m.provider)) {
      m.available = false;
      m.unavailable_reason = "已停用（在能力页开启）";
    }
  }
  return r;
}
