// 聚合本机所有内置 + 配置 Provider，构建一个注册表。
import { UmbraConfig } from "../config";
import { Registry } from "../registry";
import { registerSystem } from "./system";
import { registerCoding } from "./coding";
import { registerConfigProviders } from "./config-providers";
import { registerComputer } from "../computer";

// 构建注册表：system → codex/claude_code → computer(默认关) → providers.json（同名覆盖）。
export async function buildRegistry(cfg: UmbraConfig): Promise<Registry> {
  const r = new Registry();
  registerSystem(r, cfg);
  registerCoding(r, cfg);
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
