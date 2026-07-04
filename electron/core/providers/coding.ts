// coding 能力：本机调用编码助手（Claude Code / Codex）按需求写代码。
// 对齐 Python coding.py + prov_codex.py + prov_claude_code.py：选引擎、隔离目录、
// 权限闸门(never/confirm/always)、子进程执行、快照对比变更清单。
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run, which } from "../shared/util";
import { UmbraConfig } from "../config";
import { Confirm, Manifest, Registry, Report } from "./registry";

const ENGINE_BIN: Record<string, string> = { claude: "claude", codex: "codex" };

// 本机实际可用（已安装）的引擎，按配置优先级排列。
export function availableEngines(cfg: UmbraConfig): string[] {
  return cfg.codingEngines.filter((e) => which(ENGINE_BIN[e] || e) !== null);
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

export function pickEngine(requested: string | undefined, engines: string[]): string {
  if (engines.length === 0) throw new Error("本机未安装可用的编码助手（claude/codex）");
  const req = (requested || "auto").trim().toLowerCase();
  if (req === "" || req === "auto") return engines[0];
  if (engines.includes(req)) return req;
  throw new Error(`请求的引擎 ${req} 不可用；可用：${engines.join(", ")}`);
}

type Snap = Map<string, string>;

async function snapshot(dir: string): Promise<Snap> {
  const fp: Snap = new Map();
  const skip = new Set([".git", "node_modules", "__pycache__", ".venv"]);
  async function rec(d: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) await rec(full);
      } else if (e.isFile()) {
        try {
          const st = await fs.stat(full);
          fp.set(path.relative(dir, full), `${st.size}:${st.mtimeMs}`);
        } catch {
          /* ignore */
        }
      }
    }
  }
  await rec(dir);
  return fp;
}

function diffSnapshots(before: Snap, after: Snap): string[] {
  const changed: string[] = [];
  for (const [p, sig] of after) if (before.get(p) !== sig) changed.push(p);
  return changed.sort();
}

function buildCommand(engine: string, prompt: string, execMode: boolean): { bin: string; args: string[] } {
  const bin = ENGINE_BIN[engine] || engine;
  const extra = execMode ? (process.env[`UMBRA_CODING_${engine.toUpperCase()}_EXEC_ARGS`] || "").split(/\s+/).filter(Boolean) : [];
  if (engine === "claude") return { bin, args: ["-p", ...extra, prompt] };
  if (engine === "codex") return { bin, args: ["exec", ...extra, prompt] };
  return { bin, args: [...extra, prompt] };
}

function buildPrompt(task: string, execMode: boolean): string {
  if (execMode) return task;
  return `${task}\n\n严格约束：只在当前目录创建或修改文件来完成需求；不要运行任何命令、不要联网、不要安装依赖。`;
}

async function runCoding(params: Record<string, any>, cfg: UmbraConfig, report: Report, confirm: Confirm): Promise<unknown> {
  if (!cfg.codingEnabled) throw new Error("coding 能力已禁用");
  const task = String(params.task || params.topic || "").trim();
  if (!task) throw new Error("缺少 task（要写什么程序/需求）");

  const engines = availableEngines(cfg);
  const engine = pickEngine(params.engine ? String(params.engine) : undefined, engines);
  const projectDir = safeProjectDir(cfg.codingBaseDir, params.project ? String(params.project) : undefined);
  await fs.mkdir(projectDir, { recursive: true });

  let execMode = false;
  if (cfg.codingAllowExec === "always") execMode = true;
  else if (cfg.codingAllowExec === "confirm") {
    await report("等待用户确认是否允许执行模式…", { progress: 0.05 });
    execMode = await confirm(
      `将用 ${engine} 在「${path.basename(projectDir)}」执行模式写代码（可能运行命令/装依赖/联网），是否允许？`,
      { engine, project_dir: projectDir },
    );
  }

  await report(`使用 ${engine} ${execMode ? "(执行模式)" : "(只生成)"} 开始编码…`, { progress: 0.15 });
  const before = await snapshot(projectDir);
  const { bin, args } = buildCommand(engine, buildPrompt(task, execMode), execMode);

  let lastReport = 0;
  const res = await run(bin, args, {
    cwd: projectDir,
    timeoutMs: cfg.codingTimeout * 1000,
    onLine: (line) => {
      const now = Date.now();
      if (now - lastReport > 5000) {
        lastReport = now;
        report(`编码中… ${line.slice(0, 60)}`, { progress: 0.5 }).catch(() => {});
      }
    },
  });

  const after = await snapshot(projectDir);
  const changed = diffSnapshots(before, after);
  const summary = (res.output || "").trim().slice(-800) || "（引擎无输出）";
  await report("编码完成 ✅", { progress: 1.0 });

  if (res.code !== 0 && res.code !== null && changed.length === 0) {
    throw new Error(`${engine} 执行失败（exit=${res.code}）：${summary.slice(-300)}`);
  }
  return {
    engine,
    exec_mode: execMode,
    project_dir: projectDir,
    changed_files: changed,
    file_count: changed.length,
    summary,
    exit_code: res.code,
  };
}

const SKILLS: Manifest["skills"] = {
  write_code: { description: "按需求生成/修改代码，返回产物路径与变更清单", params: { task: "需求描述（必填）", project: "项目名（可选）" } },
};

function manifestFor(provider: string, displayName: string, bin: string): Manifest {
  const available = which(bin) !== null;
  return {
    provider,
    display_name: displayName,
    kind: "program",
    available,
    unavailable_reason: available ? "" : `未安装 ${bin}`,
    version: null,
    skills: SKILLS,
  };
}

// 注册 codex 与 claude_code 两个 Provider。
export function registerCoding(r: Registry, cfg: UmbraConfig): void {
  const defs: Array<[string, string, string, string]> = [
    ["claude_code", "Claude Code", "claude", "claude"],
    ["codex", "Codex CLI", "codex", "codex"],
  ];
  for (const [provider, display, bin, engine] of defs) {
    r.register(manifestFor(provider, display, bin), async (skill, params, report, confirm) => {
      if (!["write_code", "code", "write"].includes(skill)) throw new Error(`${provider} 不支持技能：${skill}`);
      return runCoding({ ...params, engine }, cfg, report, confirm);
    });
  }
}
