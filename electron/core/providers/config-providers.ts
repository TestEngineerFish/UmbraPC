// 配置驱动的 Provider：从 providers.json 读取用户登记的程序与技能（不写代码即可扩展）。
// 对齐 Python config_providers.py：命令以 argv 执行，params 仅作单个 token 注入，AI 不能注入新命令。
import { promises as fs } from "node:fs";
import { run, which } from "../util";
import { UmbraConfig } from "../config";
import { Confirm, Manifest, Registry, Report } from "../registry";

interface SkillCfg {
  description?: string;
  params?: Record<string, string>;
  command?: string[];
  timeout?: number;
  confirm?: boolean;
}
interface ProviderCfg {
  provider: string;
  display_name?: string;
  kind?: "program" | "system";
  detect?: string;
  version_cmd?: string[];
  skills?: Record<string, SkillCfg>;
}

const TOKEN = /\{(\w+)\}/g;
function substitute(tok: string, params: Record<string, unknown>): string {
  return tok.replace(TOKEN, (_, k) => String(params[k] ?? ""));
}

async function loadConfig(file: string): Promise<ProviderCfg[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (data && typeof data === "object" && !Array.isArray(data)) data = (data as any).providers || [];
  return Array.isArray(data) ? (data as ProviderCfg[]) : [];
}

async function detectVersion(versionCmd: string[] | undefined): Promise<string | null> {
  if (!versionCmd || versionCmd.length === 0) return null;
  const res = await run(versionCmd[0], versionCmd.slice(1), { timeoutMs: 3000 });
  const first = (res.output || "").trim().split("\n")[0];
  return first ? first.slice(0, 40) : null;
}

function makeHandler(provider: string, skillsCfg: Record<string, SkillCfg>) {
  return async (skill: string, params: Record<string, unknown>, report: Report, confirm: Confirm): Promise<unknown> => {
    const spec = skillsCfg[skill];
    if (!spec) throw new Error(`${provider} 不支持技能：${skill}`);
    const tpl = spec.command;
    if (!tpl || tpl.length === 0) throw new Error(`技能 ${provider}.${skill} 未在配置里声明 command`);

    if (spec.confirm) {
      const ok = await confirm(`将执行 ${provider}.${skill}（${tpl.join(" ")}），是否允许？`, { provider, skill });
      if (!ok) throw new Error("用户拒绝执行");
    }

    const cmd = tpl.map((t) => substitute(t, params));
    await report(`执行 ${provider}.${skill} …`, { progress: 0.3 });
    const timeout = Number(spec.timeout || 600);
    const res = await run(cmd[0], cmd.slice(1), { timeoutMs: timeout * 1000 });
    if (res.timedOut) throw new Error(`${provider}.${skill} 执行超时（${timeout}s）`);
    if (res.code !== 0) throw new Error(`${provider}.${skill} 失败（exit=${res.code}）：${res.output.slice(-300)}`);
    return { provider, skill, exit_code: res.code, output: res.output.slice(-2000) };
  };
}

// 读取 providers.json 并把其中声明的 Provider 注册进 registry（同名覆盖内置）。
export async function registerConfigProviders(r: Registry, cfg: UmbraConfig): Promise<void> {
  const entries = await loadConfig(cfg.providersFile);
  for (const entry of entries) {
    if (!entry.provider) continue;
    const available = entry.detect ? which(entry.detect) !== null : true;
    const skillsCfg = entry.skills || {};
    const skills: Manifest["skills"] = {};
    for (const [k, v] of Object.entries(skillsCfg)) skills[k] = { description: v.description || "", params: v.params || {} };
    const manifest: Manifest = {
      provider: entry.provider,
      display_name: entry.display_name || entry.provider,
      kind: entry.kind || "program",
      available,
      unavailable_reason: available ? "" : `未安装 ${entry.detect}`,
      version: available ? await detectVersion(entry.version_cmd) : null,
      skills,
    };
    r.register(manifest, makeHandler(entry.provider, skillsCfg));
  }
}
