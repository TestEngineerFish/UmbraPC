// 代理任务（Agent Task）· 端侧执行体
//
// 分层（见 doc/代理任务(Agent Task)-设计草案.md）：
//   - 服务端持有 Job（句柄、目标、验收标准），只拿 job_id 说话；
//   - PC 端持有 Session（引擎、工作目录、权限、并发），服务端一概不问；
//   - agent（Claude Code / Codex）自己决定实现步骤 —— **PC 不规划，只执行 + 如实上报**。
//
// 关键取舍：
//   1. 工作区是**长期**的（~/UmbraWorks/<名字>），Job 只是对它的一次委托。
//      「改上次那篇文章」= 新 Job + 老工作区，目录不动，不需要把文件导来导去。
//   2. 权限闸门**按 job 隔离**：这个任务里点的「总是允许」不会泄漏到别的任务。
//   3. 同一工作区串行（并行写同一目录必然打架）；不同工作区可并行。
//   4. 会话空闲太久就收敛，之后重开会话续做——防止陈旧上下文（失败命令、调试噪音）
//      被反复 --continue 喂回去，污染模型注意力。
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { killTree, run } from "../shared/util";
import { UmbraConfig } from "../config";
import { Confirm, Manifest, Registry, Report } from "./registry";
import { availableEngines, enginePath, pickEngine, safeProjectDir } from "./coding";

const ENGINE_BIN: Record<string, string> = { claude: "claude", codex: "codex" };

interface AgentSession {
  jobId: string;
  workspace: string;
  workspaceDir: string;
  engine: string;
  turns: number;
  hasEngineSession: boolean; // 引擎侧是否已有可续的会话（决定用不用 --continue）
  execAllowed: boolean | null; // 本 job 的执行模式授权：null=还没问过
  lastActiveAt: number;
  closed: boolean;
  child?: import("node:child_process").ChildProcess; // 正在跑的引擎进程（收工/退出时要杀掉）
}

const sessions = new Map<string, AgentSession>(); // job_id → session
// 同一工作区串行执行的队列尾（Promise 链）+ 是否有在跑的一轮（用于「排队中」提示）。
const workspaceQueue = new Map<string, Promise<unknown>>();
const workspaceBusy = new Set<string>();

// 同一工作区串行。关键：**绝不无限期地静默等待前一轮**——
// 上一轮如果因为任何原因永远不结束（比如一个等交互授权的僵尸 claude），
// 新任务会一声不吭地卡在队列里，服务端只看到 dispatched，什么事件都没有。
// 所以排队要可见，而且有上限：超过就如实报错，让任务失败得明明白白。
async function enqueue<T>(key: string, waitMs: number, report: Report, fn: () => Promise<T>): Promise<T> {
  const prev = workspaceQueue.get(key);
  if (prev && workspaceBusy.has(key)) {
    await report(`同一工作区上一轮还在跑，排队等待…（最多 ${Math.round(waitMs / 1000)}s）`, { progress: 0.05 });
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`等待同一工作区的上一轮超过 ${Math.round(waitMs / 1000)}s，已放弃排队。`
        + `可能上一轮卡死了——可以在任务页把它收工，或重启 Umbra 客户端。`)), waitMs),
    );
    await Promise.race([prev.catch(() => undefined), timeout]);
  }
  workspaceBusy.add(key);
  const task = (async () => {
    try {
      return await fn();
    } finally {
      workspaceBusy.delete(key);
    }
  })();
  workspaceQueue.set(key, task.catch(() => undefined));
  return task;
}

// ── 工作区 ──────────────────────────────────────────────────────────────────
export function workspaceDirOf(cfg: UmbraConfig, name: string): string {
  // 复用 safeProjectDir 的路径逃逸防护（拒绝 ../、绝对路径等）。
  return safeProjectDir(cfg.workspacesDir, name);
}

// ── 提示词 ──────────────────────────────────────────────────────────────────
// 只生成模式：明确禁止跑命令/联网/装依赖（授权后才放开）。
// 末尾要求 agent 自报一条「验证命令」——verify 由 agent 提议、PC 执行，用户不用管。
const VERIFY_HINT =
  "\n\n完成后，如果这个项目存在可自动验证「没写坏」的命令（如 npm run build / pytest），" +
  "请在输出的最后单独一行写：VERIFY: <命令>；没有就写 VERIFY: none。";

// 你是被一个自动化流程调起来的，不是坐在终端前跟人对话：
// 绝不能起任何**不会自己退出**的进程（dev server / watch / tail -f），否则这一轮永远不结束。
// 上一版就是栽在这儿：claude 写完游戏后好心起了个 http.server 给用户预览，
// 那个服务器攥着 stdout 管道不放，任务就永远停在「执行中」。
const NO_DAEMON_GUARD =
  "\n\n执行环境约束（重要）：你是被自动化流程以非交互方式调起的。" +
  "**不要启动任何长驻进程**——不要起开发服务器（http.server / npm run dev / serve / vite / watch 模式），" +
  "不要 tail -f，不要跑任何不会自己退出的命令，也不要打开浏览器。" +
  "需要预览时，只把文件写好即可，用户会自己打开。所有命令都必须能在几秒内自行结束。";

function buildPrompt(body: string, execMode: boolean, spec: string | null): string {
  const specPart = spec ? `\n\n【需求文档（验收以它为准）】\n${spec}` : "";
  const guard = execMode
    ? NO_DAEMON_GUARD
    : "\n\n严格约束：只在当前目录创建或修改文件来完成需求；不要运行任何命令、不要联网、不要安装依赖。";
  return `${body}${specPart}${guard}${VERIFY_HINT}`;
}

// 关键：headless 调用必须显式给出权限策略，否则 claude 会等一个**永远不会来的**交互应答
// （新目录的「是否信任此文件夹」+ 每次 Write/Bash 的授权提示），而我们的 stdin 是 ignore ——
// 表现就是进程既不输出也不退出，任务永远卡在「开工…」。
//   执行模式  → --dangerously-skip-permissions（用户已授权跑命令/装依赖/联网）
//   只生成    → --permission-mode acceptEdits + 明确禁用 Bash/联网工具（自动拒绝，不弹窗、不挂起）
function buildArgs(engine: string, prompt: string, execMode: boolean, resume: boolean): { bin: string; args: string[] } {
  const bin = ENGINE_BIN[engine] || engine;
  const extra = execMode
    ? (process.env[`UMBRA_CODING_${engine.toUpperCase()}_EXEC_ARGS`] || "").split(/\s+/).filter(Boolean)
    : [];
  if (engine === "claude") {
    const perm = execMode
      ? ["--dangerously-skip-permissions"]
      : ["--permission-mode", "acceptEdits", "--disallowedTools", "Bash,WebFetch,WebSearch"];
    // 追问：--continue 续上这个目录里的上一次会话，保留上下文（不从零重来）。
    return { bin, args: [...(resume ? ["--continue"] : []), "-p", ...perm, ...extra, prompt] };
  }
  if (engine === "codex") {
    // codex exec 没有稳定的会话续接参数：靠工作目录里的既有产物 + 提示词里的上下文续做。
    const perm = execMode ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "workspace-write"];
    return { bin, args: ["exec", ...perm, ...extra, prompt] };
  }
  return { bin, args: [...extra, prompt] };
}


// ── 产物快照（变更清单）─────────────────────────────────────────────────────
type Snap = Map<string, string>;

async function snapshot(dir: string): Promise<Snap> {
  const fp: Snap = new Map();
  const skip = new Set([".git", "node_modules", "__pycache__", ".venv", "dist", "build"]);
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

// agent 自报的验证命令（VERIFY: xxx）。
function parseVerify(output: string): string | null {
  const m = output.match(/^VERIFY:\s*(.+)$/im);
  if (!m) return null;
  const cmd = m[1].trim();
  return !cmd || /^none$/i.test(cmd) ? null : cmd;
}

// 读需求文档（存在才读，验收以它为准）。
async function readSpec(dir: string, specPath: string | undefined): Promise<string | null> {
  if (!specPath) return null;
  try {
    const full = path.resolve(dir, specPath);
    if (!full.startsWith(path.resolve(dir))) return null; // 逃逸防护
    const text = await fs.readFile(full, "utf-8");
    return text.slice(0, 8000);
  } catch {
    return null;
  }
}

// ── 一轮执行 ────────────────────────────────────────────────────────────────
async function runTurn(
  s: AgentSession,
  body: string,
  specPath: string | undefined,
  cfg: UmbraConfig,
  report: Report,
  confirm: Confirm,
): Promise<Record<string, unknown>> {
  await fs.mkdir(s.workspaceDir, { recursive: true });

  // 权限闸门：基线策略在设置里（never / confirm / always）；
  // 「本任务内总是允许」只写进 session，**不回写设置**（这是 v1 的泄漏 bug）。
  if (s.execAllowed === null) {
    if (cfg.codingAllowExec === "always") s.execAllowed = true;
    else if (cfg.codingAllowExec === "never") s.execAllowed = false;
    else {
      await report("等待用户授权执行模式…", { progress: 0.05 });
      s.execAllowed = await confirm(
        `任务「${s.workspace}」需要用 ${s.engine} 的执行模式（可能运行命令 / 装依赖 / 联网）。仅本任务内有效。`,
        { engine: s.engine, workspace: s.workspace, workspace_dir: s.workspaceDir, job_id: s.jobId },
      );
    }
  }
  const execMode = s.execAllowed === true;

  const spec = await readSpec(s.workspaceDir, specPath);
  const prompt = buildPrompt(body, execMode, spec);
  const resume = s.hasEngineSession && s.engine === "claude";
  const { bin, args } = buildArgs(s.engine, prompt, execMode, resume);

  // 把**真实命令行**写进日志：卡住时能一眼看出是不是权限/参数问题（prompt 只留头部）。
  const cmdLine = `${bin} ${args.map((a) => (a === prompt ? `"${prompt.slice(0, 40)}…"` : a)).join(" ")}`;
  await report(`${s.engine} ${execMode ? "(执行模式)" : "(只生成)"} 开工：${cmdLine}`, {
    progress: 0.15,
    cwd: s.workspaceDir,
  });
  const before = await snapshot(s.workspaceDir);

  // 心跳：agent 可能长时间闷头干活不吐字。定期报「还活着」，把静默变成可见信息
  // （上次就是因为完全没动静，分不清是在思考还是挂死了）。
  const startedAt = Date.now();
  let sawOutput = false;
  const beat = setInterval(() => {
    const sec = Math.round((Date.now() - startedAt) / 1000);
    report(sawOutput ? `${s.engine} 干活中…（已 ${sec}s）` : `${s.engine} 启动中，暂无输出…（已 ${sec}s）`, {
      progress: 0.5,
    }).catch(() => {});
  }, 20_000);

  let last = 0;
  const res = await run(bin, args, {
    cwd: s.workspaceDir, // ← 目录就是这么"交给"agent 的：它在这里启动，天然在这里干活
    timeoutMs: cfg.agentTurnTimeout * 1000,
    env: { PATH: enginePath() },
    detached: true, // 独立进程组：万一它还是拉起了后台服务，收工/超时时能整组带走
    onSpawn: (child) => {
      s.child = child; // 记住它：收工或退出时要杀掉，别留孤儿进程
    },
    onLine: (line) => {
      // 如实上报 agent 的真实动静（不是 PC 编出来的步骤）
      sawOutput = true;
      const now = Date.now();
      if (now - last > 4000) {
        last = now;
        report(line.slice(0, 80), { progress: 0.5 }).catch(() => {});
      }
    },
  });
  clearInterval(beat);
  s.child = undefined;

  const after = await snapshot(s.workspaceDir);
  const changed = diffSnapshots(before, after);
  const output = (res.output || "").trim();
  const summary = output.replace(/^VERIFY:.*$/im, "").trim().slice(-800) || "（引擎无输出）";

  s.turns += 1;
  s.hasEngineSession = true;
  s.lastActiveAt = Date.now();

  // 超时：run() 会 SIGKILL 并返回 code=null —— 必须显式判 timedOut，
  // 否则「超时」会被当成「成功但没产物」上报（这是之前的判断漏洞）。
  if (res.timedOut) {
    throw new Error(
      `${s.engine} 超时（${cfg.agentTurnTimeout}s）已被终止。` +
        (output ? `最后输出：${output.slice(-200)}` : "全程无任何输出——通常是它在等一个交互应答（权限/信任提示）。"),
    );
  }
  if (res.code !== 0 && res.code !== null && changed.length === 0) {
    throw new Error(`${s.engine} 执行失败（exit=${res.code}）：${summary.slice(-300)}`);
  }

  await report("这一轮完成 ✅", { progress: 1.0 });
  return {
    job_id: s.jobId,
    turn: s.turns,
    engine: s.engine,
    exec_mode: execMode,
    workspace: s.workspace,
    workspace_dir: s.workspaceDir,
    changed_files: changed,
    file_count: changed.length,
    summary,
    suggested_verify: parseVerify(output), // verify 由 agent 提议，PC 执行（Phase 2）
    exit_code: res.code,
    agent_state: "idle", // 一轮结束 ≠ 任务结束：停在这里等你追问或收工
  };
}

// 空闲太久就收敛会话：之后再追问会**重开**会话（带着工作区里的产物续做），
// 而不是硬 --continue 一段陈旧上下文。
function reapIdle(cfg: UmbraConfig): void {
  if (!cfg.agentIdleCloseMin) return;
  const ttl = cfg.agentIdleCloseMin * 60_000;
  const now = Date.now();
  for (const [jobId, s] of sessions) {
    if (!s.closed && now - s.lastActiveAt > ttl) s.hasEngineSession = false;
    if (s.closed && now - s.lastActiveAt > ttl) sessions.delete(jobId);
  }
}

// ── 技能 ────────────────────────────────────────────────────────────────────
async function agentStart(
  params: Record<string, unknown>,
  cfg: UmbraConfig,
  report: Report,
  confirm: Confirm,
): Promise<unknown> {
  const jobId = String(params.job_id || "").trim();
  const goal = String(params.goal || "").trim();
  const workspace = String(params.workspace || "").trim() || "未命名";
  if (!jobId) throw new Error("缺少 job_id");
  if (!goal) throw new Error("缺少 goal（这次要干什么）");

  const engines = availableEngines(cfg);
  const engine = pickEngine(params.engine ? String(params.engine) : undefined, engines);
  const workspaceDir = workspaceDirOf(cfg, workspace);

  const s: AgentSession = {
    jobId,
    workspace,
    workspaceDir,
    engine,
    turns: 0,
    hasEngineSession: false,
    execAllowed: null,
    lastActiveAt: Date.now(),
    closed: false,
  };
  sessions.set(jobId, s);
  reapIdle(cfg);

  // 先报一声「已受理」——排队/授权都可能让第一条实质进度迟迟不来，
  // 服务端时间线上必须先有一条，否则「没收到任务」和「收到但卡住」长得一模一样。
  await report(`已受理：${engine} @ ${workspaceDir}`, { progress: 0.05 });

  // 同一工作区串行（并行写同一目录必然打架）
  return enqueue(workspaceDir, cfg.agentTurnTimeout * 1000, report, () =>
    runTurn(s, goal, params.spec_path ? String(params.spec_path) : undefined, cfg, report, confirm),
  );
}

async function agentContinue(
  params: Record<string, unknown>,
  cfg: UmbraConfig,
  report: Report,
  confirm: Confirm,
): Promise<unknown> {
  const jobId = String(params.job_id || "").trim();
  const message = String(params.message || "").trim();
  if (!jobId) throw new Error("缺少 job_id");
  if (!message) throw new Error("缺少 message（要改什么）");

  let s = sessions.get(jobId);
  if (!s || s.closed) {
    // 会话没了（进程重启 / 已收敛）→ 用工作区里的产物重开一个，续着做。
    const workspace = String(params.workspace || (s ? s.workspace : "")).trim();
    if (!workspace) throw new Error(`任务 ${jobId} 的会话已不存在，且没有工作区信息，无法续做`);
    const engines = availableEngines(cfg);
    s = {
      jobId,
      workspace,
      workspaceDir: workspaceDirOf(cfg, workspace),
      engine: pickEngine(undefined, engines),
      turns: 0,
      hasEngineSession: false, // 重开：不 --continue，靠目录里的产物 + 提示词续
      execAllowed: null,
      lastActiveAt: Date.now(),
      closed: false,
    };
    sessions.set(jobId, s);
  }

  const session = s;
  const body = session.hasEngineSession
    ? message
    : `接着这个目录里已有的工作继续（先看一眼现有文件了解上下文）：\n\n${message}`;

  await report(`已受理追问：${session.engine} @ ${session.workspaceDir}`, { progress: 0.05 });
  return enqueue(session.workspaceDir, cfg.agentTurnTimeout * 1000, report, () =>
    runTurn(session, body, params.spec_path ? String(params.spec_path) : undefined, cfg, report, confirm),
  );
}

async function agentStop(params: Record<string, unknown>): Promise<unknown> {
  const jobId = String(params.job_id || "").trim();
  const s = sessions.get(jobId);
  if (s) {
    s.closed = true;
    s.hasEngineSession = false;
    s.execAllowed = null; // 本任务的授权随任务一起作废（不泄漏到别的任务）
    s.lastActiveAt = Date.now();
    killChild(s); // 还在跑就杀掉——否则会留下孤儿进程，把这个工作区的队列永久堵死
  }
  return { job_id: jobId, agent_state: "closed" };
}

function killChild(s: AgentSession): void {
  const c = s.child;
  s.child = undefined;
  if (!c) return;
  killTree(c); // 整个进程组：把它可能拉起的 dev server 一并带走，否则会一直占着端口
}

// 客户端退出时把所有还在跑的引擎进程带走（Electron 关闭不会自动杀子进程）。
export function killAllAgentChildren(): void {
  for (const s of sessions.values()) killChild(s);
}

// ── 注册 ────────────────────────────────────────────────────────────────────
const SKILLS: Manifest["skills"] = {
  agent_start: {
    description: "开一个可追问的长任务（写程序/写文章），在工作区里干活；一轮结束不代表任务结束",
    params: { job_id: "任务句柄（服务端给）", goal: "这次的目标", workspace: "工作区名（长期目录）", spec_path: "需求文档路径（可选）" },
  },
  agent_continue: {
    description: "把追问/修改意见送进同一个任务（保留上下文，不从零重来）",
    params: { job_id: "任务句柄", message: "要改什么" },
  },
  agent_stop: {
    description: "收工：结束这个任务的会话（工作区保留，以后可以再委托）",
    params: { job_id: "任务句柄" },
  },
};

export function registerAgent(r: Registry, cfg: UmbraConfig): void {
  const engines = availableEngines(cfg);
  const available = cfg.codingEnabled && engines.length > 0;
  const manifest: Manifest = {
    provider: "agent",
    display_name: "代理任务（Claude Code / Codex）",
    kind: "program",
    available,
    unavailable_reason: available
      ? ""
      : !cfg.codingEnabled
        ? "coding 能力已禁用"
        : "本机未安装可用的编码助手（claude / codex）",
    version: null,
    skills: SKILLS,
  };
  r.register(manifest, async (skill, params, report, confirm) => {
    if (!cfg.codingEnabled) throw new Error("coding 能力已禁用");
    if (skill === "agent_start") return agentStart(params, cfg, report, confirm);
    if (skill === "agent_continue") return agentContinue(params, cfg, report, confirm);
    if (skill === "agent_stop") return agentStop(params);
    throw new Error(`agent 不支持技能：${skill}`);
  });
}

// 供设置页/调试用：当前活跃的代理会话。
export function agentSessions(): Array<{ jobId: string; workspace: string; turns: number; closed: boolean }> {
  return [...sessions.values()].map((s) => ({
    jobId: s.jobId,
    workspace: s.workspace,
    turns: s.turns,
    closed: s.closed,
  }));
}
