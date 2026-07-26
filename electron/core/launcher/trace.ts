// 工作流调试轨迹（W8「调试抽屉」的数据源）。
// 记录每次执行的「节点 → 入参 arg → 变量快照 → 出参 → 出口 → 耗时 → 脚本输出」，
// 只放内存、只留最近 N 次、进程退出即清空——纯调试用途，不落盘、不参与业务逻辑。
// 变量快照里疑似密钥的值会打码，避免调试抽屉把 API Key 明晃晃摊在界面上。

// 单步：一个节点的一次执行。
export interface TraceStep {
  seq: number;                    // 本次运行内的步序（从 1 开始，按开始顺序）
  nodeId: string;
  type: string;                   // 节点类型（如 action.script）
  arg: string;                    // 入参
  vars: Record<string, string>;   // 入口处的变量快照（疑似密钥已打码）
  outArg: string;                 // 出参（传给下游的 arg）
  outPort: string;                // 从哪个出口继续（""=默认 | r0.. | else | error）
  ms: number;                     // 本节点耗时（不含下游）
  feedback?: string;              // 该节点产生的提示文案
  error?: string;                 // 节点内部抛出的异常
  stdout?: string;                // 脚本类节点的输出（与引擎拿到的一致：stdout+stderr 合并）
  stderr?: string;                // 脚本类节点单独抓到的 stderr（便于一眼看出报错）
  exitCode?: number;              // 脚本退出码
  skipped?: boolean;              // 节点被禁用 → 旁路，未真正执行
  stopped?: boolean;              // 该节点主动终止了链路（脚本失败等）
}

// 一次运行 = 一条完整链路（从触发点开始，含其下所有节点）。
export interface TraceRun {
  id: string;
  wfId: string;
  wfName: string;
  trigger: string;   // 触发方式：如「回车」「⌘ 分支」「快捷键」「Script Filter 查询」
  arg: string;       // 触发时的输入
  at: number;        // 开始时刻（epoch ms）
  ms: number;        // 整条链路总耗时
  steps: TraceStep[];
}

// 只留最近 20 次运行；单次最多 200 步（防死循环/超大扇出把内存撑爆）。
const MAX_RUNS = 20;
const MAX_STEPS = 200;
// 单个文本字段的截断长度：脚本可能吐几 MB，全塞进 IPC 会卡住渲染层。
const MAX_TEXT = 4000;
// 疑似密钥的变量名（值打码后再进快照）。
const SECRET_RE = /(key|secret|token|password|passwd|pwd|credential|auth)/i;

// 截断长文本，尾部标注被截掉多少字符。
function cut(s: string): string {
  const t = String(s ?? "");
  return t.length <= MAX_TEXT ? t : `${t.slice(0, MAX_TEXT)}…（已截断 ${t.length - MAX_TEXT} 字）`;
}

// 变量快照：疑似密钥只留前 2 位 + 星号，其余原样（值同样截断）。
function snapshot(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars || {})) {
    const s = String(v ?? "");
    out[k] = SECRET_RE.test(k) && s ? `${s.slice(0, 2)}${"*".repeat(Math.min(8, Math.max(1, s.length - 2)))}` : cut(s);
  }
  return out;
}

// 一步执行的收尾数据（由引擎在节点跑完后填）。
export interface StepEnd {
  outArg?: string;
  outPort?: string;
  feedback?: string;
  error?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  skipped?: boolean;
  stopped?: boolean;
}

// 轨迹记录器：引擎在每次执行前 begin()，每个节点前后 stepStart()/stepEnd()，链路跑完 end()。
// 所有方法对 null run 都是安全的空操作，调用方不必到处判空。
export class TraceRecorder {
  private runs: TraceRun[] = [];
  private seq = 0;
  private listeners = new Set<(r: TraceRun) => void>();

  // 开一次运行。返回的对象要一路传给 runNode，避免并发执行互相串台。
  begin(wfId: string, wfName: string, trigger: string, arg: string): TraceRun {
    const r: TraceRun = {
      id: `t${++this.seq}`, wfId, wfName, trigger, arg: cut(arg), at: Date.now(), ms: 0, steps: [],
    };
    return r;
  }

  // 记一步的开始：返回该步对象（引擎跑完节点后交给 stepEnd 收尾）。步数超上限返回 null。
  stepStart(run: TraceRun | null, nodeId: string, type: string, arg: string, vars: Record<string, string>): TraceStep | null {
    if (!run || run.steps.length >= MAX_STEPS) return null;
    const st: TraceStep = {
      seq: run.steps.length + 1, nodeId, type, arg: cut(arg), vars: snapshot(vars),
      outArg: "", outPort: "", ms: 0,
    };
    run.steps.push(st);
    return st;
  }

  // 记一步的结束：写出参/耗时/脚本输出等。startedAt 由调用方在 stepStart 前后自行取。
  stepEnd(step: TraceStep | null, startedAt: number, e: StepEnd): void {
    if (!step) return;
    step.ms = Date.now() - startedAt;
    step.outArg = cut(e.outArg ?? "");
    step.outPort = e.outPort ?? "";
    if (e.feedback) step.feedback = cut(e.feedback);
    if (e.error) step.error = cut(e.error);
    if (e.stdout) step.stdout = cut(e.stdout);
    if (e.stderr) step.stderr = cut(e.stderr);
    if (e.exitCode !== undefined) step.exitCode = e.exitCode;
    if (e.skipped) step.skipped = true;
    if (e.stopped) step.stopped = true;
  }

  // 收一次运行：算总耗时、入队（超上限丢最旧的）、通知订阅者。没跑过任何节点的空运行不记。
  end(run: TraceRun | null): void {
    if (!run || !run.steps.length) return;
    run.ms = Date.now() - run.at;
    this.runs.unshift(run);
    if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS;
    for (const fn of this.listeners) { try { fn(run); } catch { /* 订阅者异常不影响执行链路 */ } }
  }

  // 最近的运行记录（新的在前）；给 wfId 则只取该工作流的。
  list(wfId?: string): TraceRun[] {
    return wfId ? this.runs.filter((r) => r.wfId === wfId) : this.runs.slice();
  }

  clear(): void { this.runs = []; }

  // 订阅「有新运行记录」，返回退订函数（供编辑器窗口实时刷新调试抽屉）。
  onRun(fn: (r: TraceRun) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
