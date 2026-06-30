// 聚合本机所有内置 + 配置 Provider，构建一个注册表。
import { UmbraConfig } from "../config";
import { Registry } from "../registry";
import { registerSystem } from "./system";
import { registerCoding } from "./coding";
import { registerConfigProviders } from "./config-providers";

// 构建注册表：system → codex/claude_code → providers.json（同名覆盖）。
export async function buildRegistry(cfg: UmbraConfig): Promise<Registry> {
  const r = new Registry();
  registerSystem(r, cfg);
  registerCoding(r, cfg);
  await registerConfigProviders(r, cfg);
  return r;
}
