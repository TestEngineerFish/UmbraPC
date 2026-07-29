// 工作流执行引擎（类 Alfred Workflow）。
// 触发(Keyword/Hotkey) → 输入(Script Filter，跑脚本解析 Alfred JSON) → 修饰键分支 → 动作链(Action)。
// 与内置 provider 结果并存：本引擎只产出/执行「工作流」结果，LauncherManager 负责合并与分发。
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigStore, expandHome, httpBase, Workflow, WorkflowNode } from "../config";
import { httpFetch } from "../http";
import { run } from "../shared/util";
import { simulatePaste, simulateCopy } from "../clipboard/paste";
import { readClipboardFiles } from "../clipboard/watcher";
import { calc, convertUnits, unicodeTransform, urlTransform, base64Transform } from "./tools";
import { ensureWorkflowDir, workflowEnv, resolveCwd } from "./workspace";
import { TraceRecorder, maskSecret } from "./trace";
import type { TraceRun } from "./trace";

// 与 LauncherManager 的结果结构对齐（避免运行时循环依赖，仅类型引用）。
import type { LauncherResult } from "./index";

// run(token, mod) 的特殊返回：该修饰键没有连线分支 → 交回上层兜底（如「发给秘书」）。
// 用不可打印的 NUL 前缀，确保永远不会和真实的提示文案撞车。
export const NO_BRANCH = "\u0000NO_BRANCH";

// Alfred item（Script Filter 输出）关键字段。
interface AlfredMod { arg?: string; subtitle?: string; valid?: boolean; variables?: Record<string, string>; }
interface AlfredItem {
  title?: string; subtitle?: string; arg?: string | string[];
  icon?: { path?: string; type?: string };
  uid?: string; valid?: boolean; match?: string; autocomplete?: string;
  mods?: Record<string, AlfredMod>;
  text?: { copy?: string; largetype?: string };
  variables?: Record<string, string>;
  quicklookurl?: string;
}

// List Filter 节点里维护的一行。uid 只用于使用频率学习（不填就拿 title 当键）。
interface ListRow { title?: string; subtitle?: string; arg?: string; icon?: string; uid?: string }

// Script Filter 脚本输出的顶层结构（Alfred 约定）。
interface SFOutput {
  items?: AlfredItem[];
  variables?: Record<string, string>;                    // 本次会话变量：并进每个 item 的变量
  rerun?: number;                                        // 0.1~5 秒后自动再查一次
  cache?: { seconds?: number; loosereload?: boolean };   // 输出缓存
  skipknowledge?: boolean;                               // 本次结果不参与使用频率学习
}

// 一条工作流结果被选中时，run 需要的上下文。
interface ItemCtx {
  wfId: string;
  srcNodeId: string;               // 分支的发出节点（Script Filter 或 直连动作时的 Trigger）
  arg: string;                     // 该项默认 arg
  variables: Record<string, string>;
  valid: boolean;
  mods: Record<string, AlfredMod>; // item 级修饰键覆盖
  hintOnly?: boolean;              // 仅提示（如「需输入」），不可执行
}

// 文本视图（Text View）一次展示请求：title=标题栏文案，md=是否按 Markdown 渲染，
// append=追加到现有内容（流式续写）而不是整体替换，loading=显示等待动画（等秘书回复时用）。
export interface TextViewPayload {
  text: string;
  title?: string;
  md?: boolean;
  append?: boolean;
  loading?: boolean;
}

export interface WorkflowDeps {
  sendAssistant: (text: string) => void;         // 复用「发给秘书」链路
  hide: (returnFocus: boolean) => Promise<void>; // 关闭启动器
  showLargeType: (text: string) => void;         // 大字显示浮层
  showTextView: (p: TextViewPayload) => void;    // 文本视图浮层（可 Markdown、可流式追加）
  // 取密码保险箱里的明文（W10 的 password 配置项）。保险箱锁着/引用失效返回 null。
  // 主进程启动顺序上 launcher 先于 vault 建好，所以这里允许后置注入（缺省当作取不到）。
  getSecret?: (ref: string) => string | null;
}

const SCRIPT_TIMEOUT = 20000;
// 问秘书 / 设备派发走 HTTP，比本地脚本慢得多，单独给一个更长的超时。
const REMOTE_TIMEOUT = 120000;

// 日期时间占位符的格式化：只认这几个字段，够用且不用引第三方库。
//   YYYY 年 / MM 月 / DD 日 / HH 时(24) / mm 分 / ss 秒 / SSS 毫秒 / ddd 星期几（中文）
// 长的写在前面，避免 YYYY 被 YY 先吃掉一半。
function formatNow(fmt: string): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MM: p2(d.getMonth() + 1),
    DD: p2(d.getDate()),
    HH: p2(d.getHours()),
    mm: p2(d.getMinutes()),
    ss: p2(d.getSeconds()),
    SSS: String(d.getMilliseconds()).padStart(3, "0"),
    ddd: "日一二三四五六"[d.getDay()],
  };
  return (fmt || "").replace(/YYYY|SSS|ddd|YY|MM|DD|HH|mm|ss/g, (k) => map[k] ?? k);
}

// 随机占位符 {random[:参数]}：
//   （空）        0~999999 的整数
//   uuid         标准 UUID
//   N            0~N 的整数
//   A-B          A~B 的整数（闭区间）
//   hexN / strN  N 位十六进制 / N 位大小写字母数字串（上限 64）
function randomToken(param: string): string {
  const p = (param || "").trim().toLowerCase();
  const int = (min: number, max: number) => String(min + Math.floor(Math.random() * (max - min + 1)));
  if (!p) return int(0, 999999);
  if (p === "uuid") return randomUUID();
  const hex = p.match(/^hex(\d+)$/);
  if (hex) {
    const n = Math.min(64, Math.max(1, Number(hex[1])));
    return [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
  }
  const str = p.match(/^str(\d+)$/);
  if (str) {
    const n = Math.min(64, Math.max(1, Number(str[1])));
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return [...Array(n)].map(() => abc[Math.floor(Math.random() * abc.length)]).join("");
  }
  const range = p.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
  if (range) {
    const a = Number(range[1]); const b = Number(range[2]);
    return int(Math.min(a, b), Math.max(a, b));
  }
  const max = Number(p);
  return Number.isFinite(max) ? int(0, Math.max(0, Math.floor(max))) : "";
}

// 文件已存在且选了「另存新文件」时，在扩展名前加 -1、-2… 直到找到没被占用的名字。
async function uniquePath(p: string): Promise<string> {
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const cand = `${base}-${i}${ext}`;
    if (!(await fs.stat(cand).then(() => true).catch(() => false))) return cand;
  }
  return `${base}-${Date.now()}${ext}`;
}

// Split / Join 的分隔符：预置 comma / space / tab / newline，custom 用用户自己填的串。
// custom 里认 \n \t \\ 三种转义（面板上只有一个单行输入框，敲不了真的换行/制表符）。
function delimOf(kind: string, custom: string): string {
  switch (String(kind || "comma")) {
    case "space": return " ";
    case "tab": return "\t";
    case "newline": return "\n";
    case "custom":
      return String(custom || "").replace(/\\(.)/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "\\" ? "\\" : `\\${c}`));
    case "comma":
    default: return ",";
  }
}

// 按分隔符拆分。先把 \r\n / \r 归一成 \n，这样从 Windows / 网页复制来的文本也能正确按行拆；
// 分隔符为空（选了 Custom 却没填）时不拆，整条当成一项，免得静默变成逐字符拆开。
function splitBy(text: string, sep: string): string[] {
  const s = String(text ?? "").replace(/\r\n?/g, "\n");
  return sep ? s.split(sep) : [s];
}

// 扇出上下文：Split 以「参数列表」方式输出时，下游会被拆出的每一项各跑一遍，
// 这个对象贯穿这一批的所有项，让链路末端的 Join 知道「现在是第几项、一共几项、已经收了哪些」。
// bucket 挂在这一批上而不是引擎实例上，所以嵌套的 Split 与并发触发各收各的，互不串台。
interface FanCtx {
  index: number;                  // 当前是第几项（0 起）
  total: number;                  // 这一批共几项
  bucket: Map<string, string[]>;  // Join 节点 id → 该节点已收集到的参数
  parent: FanCtx | null;          // 外层扇出（Split 套 Split 时用；Join 合并完回到外层）
}

// 一次扇出最多跑多少项：Split 撞上一份大文本时（比如整个文件按行拆），
// 逐项串行跑几千遍会把链路拖到没反应，超出部分直接截断并在反馈里说明。
const MAX_FAN = 200;

export class WorkflowEngine {
  private ctx = new Map<string, ItemCtx>();  // token → 上下文（每次 query 重置）
  private seq = 0;
  // 调试轨迹：每次执行都往里记，工作流编辑器的调试抽屉从这里取（只在内存里留最近若干次）。
  readonly trace = new TraceRecorder();
  // Script Filter 输出缓存（W3 的 cache 字段）：键 = 工作流+节点+工作目录+参数+脚本正文。
  // 只在内存里放，进程退出即清空；最多 100 条，超了丢最旧的。
  private sfCache = new Map<string, { out: string; at: number; ttl: number; loose: boolean }>();
  // rerun（W3）：脚本要求过 N 秒自动再查一次。每次查询前清零，查完由上层 takeRerun() 取走并安排定时。
  private rerunAfter = 0;

  constructor(private cfg: ConfigStore, private deps: WorkflowDeps) {}

  private workflows(): Workflow[] {
    return (this.cfg.get().launcherWorkflows || []).filter((w) => w && w.enabled !== false);
  }
  private node(wf: Workflow, id: string): WorkflowNode | undefined {
    return wf.nodes.find((n) => n.id === id);
  }

  // 工作流的基础变量（W10 Configuration 分层的唯一出口）。三层叠加，后面的盖前面的：
  //   1) 配置项声明里的 default —— 作者给的兜底；
  //   2) variables 里使用者真正填的值；
  //   3) 值若是 vault://... 引用（password 类型），现场去保险箱取明文；取不到就留空串，
  //      让脚本自己报「没配密钥」，而不是把引用串当密码传下去。
  // 所有需要「工作流变量」的入口都走这里，避免有的地方解密了有的地方没解密。
  private baseVars(wf: Workflow): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of wf.config || []) if (f?.key && f.default !== undefined) out[f.key] = String(f.default);
    for (const [k, v] of Object.entries(wf.variables || {})) out[k] = String(v ?? "");
    for (const [k, v] of Object.entries(out)) {
      if (!v.startsWith("vault://")) continue;
      out[k] = this.deps.getSecret?.(v) ?? "";
    }
    return out;
  }
  // 从 nodeId 的指定「出口」沿指定修饰键分支发出的连线。
  // fromPort 缺省为 ""（默认出口）——旧数据没有这个字段，落在默认出口上，行为不变。
  private outConns(wf: Workflow, nodeId: string, mod: string, fromPort = "") {
    return (wf.connections || []).filter(
      (c) => c.from === nodeId && (c.mod || "") === mod && (c.fromPort || "") === fromPort,
    );
  }
  // 该发出节点上有哪些修饰键分支（供渲染层提示 ⌘ 分支存在）。
  private branchMods(wf: Workflow, nodeId: string): string[] {
    const s = new Set<string>();
    for (const c of wf.connections || []) if (c.from === nodeId && c.mod) s.add(c.mod);
    return [...s];
  }

  // 占位替换（工作流全局共用的一套动态占位符）：
  //   · {query}                 上游传下来的 arg
  //   · {var:name}              工作流变量（含配置项、Script Filter 输出的 variables）
  //   · {clipboard}             当前剪贴板文本
  //   · {date} / {date:格式}    日期，默认 YYYY-MM-DD
  //   · {time} / {time:格式}    时间，默认 HH:mm:ss
  //   · {random} / {random:参数} 随机数，见 randomToken()
  // 只跑一遍正则（而不是一个占位符一个 .replace 链下来）：
  // 剪贴板/变量里如果正好有 "{query}" 这样的字面量，不会被后一轮替换二次展开。
  // 认不出来的占位符原样留着 —— 脚本自己的模板语法不该被我们吃掉。
  private subst(tpl: string, arg: string, vars: Record<string, string>): string {
    return (tpl || "").replace(/\{(query|var|clipboard|date|time|random)(?::([^}]*))?\}/g, (m, name: string, param?: string) => {
      switch (name) {
        case "query": return param === undefined ? arg : m;
        case "var": return param === undefined ? m : (vars[param.trim()] ?? "");
        case "clipboard": return this.clipText();
        case "date": return formatNow(param || "YYYY-MM-DD");
        case "time": return formatNow(param || "HH:mm:ss");
        case "random": return randomToken(param || "");
        default: return m;
      }
    });
  }

  // 同步读剪贴板：subst 是同步方法（Conditional 规则求值等地方也在用），
  // 没有 await import("electron") 的机会，这里跟 loadIcon 一样走同步 require。
  private clipText(): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { clipboard } = require("electron") as typeof import("electron");
      return clipboard.readText() || "";
    } catch { return ""; }   // 非 Electron 环境（单测）当作空剪贴板
  }

  // 取走本次查询里脚本要求的自动重查间隔（秒，0 = 不需要）。取完即清零，避免重复安排。
  takeRerun(): number {
    const s = this.rerunAfter;
    this.rerunAfter = 0;
    return s;
  }

  // ── 查询：keyword 触发 → 产出结果（命中即独占返回）──
  async query(raw: string): Promise<LauncherResult[]> {
    this.ctx.clear();
    this.rerunAfter = 0;
    const q = (raw || "").trim();
    if (!q) return [];
    for (const wf of this.workflows()) {
      // 被停用的触发器直接跳过：整条链路唤不起来（E6 节点禁用）。
      for (const trig of wf.nodes.filter((n) => n.type === "trigger.keyword" && !n.disabled)) {
        const kw = String(trig.config.keyword || "").trim();
        if (!kw) continue;
        const argMode = String(trig.config.arg || "optional"); // required | optional | none
        let arg = "";
        if (argMode === "none") {
          if (q.toLowerCase() !== kw.toLowerCase()) continue;
        } else {
          const re = new RegExp(`^${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+([\\s\\S]+))?$`, "i");
          const m = q.match(re);
          if (!m) continue;
          arg = (m[1] || "").trim();
          if (argMode === "required" && !arg) return [this.hintResult(wf, trig)]; // 提示待输入
        }
        const target = this.outConns(wf, trig.id, "").map((c) => this.node(wf, c.to)).find(Boolean);
        const inputRes = target ? await this.runInput(wf, target, arg) : null;
        if (inputRes) {
          // Alfred 的 autocomplete 给的是「参数」部分，按 Tab 补全时要连关键词一起写回输入框。
          for (const r of inputRes) if (r.autocomplete) r.autocomplete = `${kw} ${r.autocomplete}`;
          return inputRes;
        }
        return [this.directResult(wf, trig, arg)]; // 直连动作
      }
    }
    return [];
  }

  // 「始终触发」工作流（无关键词，任意输入都尝试，如计算器/单位换算）：贡献到普通结果，不独占。
  async queryAlways(raw: string): Promise<LauncherResult[]> {
    this.rerunAfter = 0;
    const q = (raw || "").trim();
    if (!q) return [];
    const out: LauncherResult[] = [];
    for (const wf of this.workflows()) {
      for (const trig of wf.nodes.filter((n) => n.type === "trigger.always" && !n.disabled)) {
        const target = this.outConns(wf, trig.id, "").map((c) => this.node(wf, c.to)).find(Boolean);
        const res = target ? await this.runInput(wf, target, q) : null;
        if (res) out.push(...res);
      }
    }
    return out;
  }

  // 输入节点分发 → 结果列表（非 input 节点返回 null，表示走「直连动作」）。
  private async runInput(wf: Workflow, node: WorkflowNode, arg: string): Promise<LauncherResult[] | null> {
    // 输入节点被停用 → 当作没有输入节点（走「直连动作」单条结果），执行时该节点也会被旁路。
    if (node.disabled) return null;
    switch (node.type) {
      case "input.scriptfilter": return this.runScriptFilter(wf, node, arg);
      case "input.listfilter": return this.runListFilter(wf, node, arg);
      case "input.codec": return this.runCodec(wf, node, arg);
      case "input.calc": return this.runCompute(wf, node, arg, "calc");
      case "input.units": return this.runCompute(wf, node, arg, "units");
      default: return null;
    }
  }

  // 内置输入：List Filter —— 在节点里维护一张固定列表，按输入过滤后当结果给出来。
  // 和 Script Filter 的区别就是「不用写脚本」：菜单、预设、常用地址这类内容直接列进去。
  // 过滤规则（match）对齐 Alfred：
  //   word     = 从词首匹配（整条以输入开头，或任意一个空白分隔的词以输入开头）——默认
  //   contains = 任意位置包含
  //   none     = 不过滤，永远整表给出（配合上游关键词「无参数」用）
  private runListFilter(wf: Workflow, node: WorkflowNode, arg: string): LauncherResult[] {
    const rows = Array.isArray(node.config.items) ? (node.config.items as ListRow[]) : [];
    if (!rows.length) return [];
    const vars = this.baseVars(wf);
    const mode = String(node.config.match || "word");
    const q = (arg || "").trim().toLowerCase();
    const hit = (row: ListRow): boolean => {
      if (mode === "none" || !q) return true;
      const hay = `${row.title || ""} ${row.subtitle || ""}`.toLowerCase();
      if (mode === "contains") return hay.includes(q);
      return hay.split(/\s+/).some((w) => w.startsWith(q));
    };
    // 「参与使用频率学习」默认开：同一个关键词下常选的那项会被顶上来（靠 uid 记，不是靠位置）。
    const learn = node.config.learn !== false;
    const mods = this.branchMods(wf, node.id);
    const limit = Math.max(1, Math.min(Number(this.cfg.get().launcherMaxResults) || 12, 50));
    return rows.filter(hit).slice(0, limit).map((row, i) => {
      // 只有 arg 走占位替换：标题/副标题是给人看的，塞 {query} 会让过滤结果自相矛盾。
      const val = this.subst(String(row.arg ?? row.title ?? ""), arg, vars);
      const r = this.itemResult(wf, node.id, {
        title: String(row.title || val), subtitle: row.subtitle ? String(row.subtitle) : undefined,
        arg: val, uid: learn ? String(row.uid || row.title || i) : undefined,
      }, mods, { rank: i, noLearn: !learn });
      // 图标：带「/」的当文件路径去加载，否则当 emoji 直接用（列表里手写 emoji 是常态）。
      if (row.icon) r.icon = String(row.icon).includes("/") ? this.loadIcon(String(row.icon), wf.icon || "🧩") : String(row.icon);
      return r;
    });
  }

  // 内置输入：编解码（unicode / url / base64）。
  private runCodec(wf: Workflow, node: WorkflowNode, arg: string): LauncherResult[] {
    if (!arg) return [];
    const mode = String(node.config.mode || "unicode");
    const items = mode === "url" ? urlTransform(arg) : mode === "base64" ? base64Transform(arg) : unicodeTransform(arg);
    return items.map((it) => { const r = this.itemResult(wf, node.id, { title: it.value, subtitle: `${it.label} · 回车复制`, arg: it.value }, []); r.icon = wf.icon || "🔡"; r.score = 300; return r; });
  }
  // 内置输入：计算器 / 单位换算。
  private runCompute(wf: Workflow, node: WorkflowNode, arg: string, kind: "calc" | "units"): LauncherResult[] {
    if (kind === "calc") {
      const c = calc(arg);
      if (c === null) return [];
      const r = this.itemResult(wf, node.id, { title: `= ${c}`, subtitle: "计算结果 · 回车复制", arg: String(c) }, []);
      r.icon = wf.icon || "🔢"; r.score = 320; return [r];
    }
    const u = convertUnits(arg);
    if (!u) return [];
    const r = this.itemResult(wf, node.id, { title: u.title, subtitle: `${u.subtitle} · 回车复制`, arg: u.title }, []);
    r.icon = wf.icon || "📐"; r.score = 320; return [r];
  }

  // 跑 Script Filter 脚本 → 解析 Alfred JSON → 结果列表。
  // 除 items 外，还认 Alfred 的三个顶层字段（W3 对齐）：
  //   · cache {seconds, loosereload}：同样的「脚本 + 参数」在 N 秒内直接复用上次输出，不再起进程；
  //     loosereload=true 时先返回旧的、同时后台重跑刷新缓存，下次查询就是新的；
  //   · rerun 0.1~5：让启动器过 N 秒自动再查一次（脚本产出「进行中」这类会变的结果时用）；
  //   · skipknowledge：本次结果不参与使用频率学习，完全按脚本给的顺序排。
  private async runScriptFilter(wf: Workflow, node: WorkflowNode, arg: string): Promise<LauncherResult[]> {
    const vars = this.baseVars(wf);
    const script = this.subst(String(node.config.script || ""), arg, vars);
    // cwd 缺省就是本工作流自己的目录 —— 脚本才能写 ./runtime/txiki ./index.js 这种相对路径。
    const dir = await ensureWorkflowDir(this.cfg.dir, wf.id);
    const cwd = resolveCwd(dir, String(node.config.cwd || ""), expandHome);
    const env: Record<string, string> = { ...workflowEnv(dir, wf.id, wf.name) };
    for (const [k, v] of Object.entries(vars)) env[k] = String(v ?? "");
    env.query = arg;
    // 缓存键要带上脚本正文：改了脚本就该重跑，不能还吃旧缓存。
    const key = `${wf.id}\n${node.id}\n${cwd || ""}\n${arg}\n${script}`;

    const hit = this.sfCache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl * 1000) {
      // 缓存还新鲜：本次不起进程。loosereload 时顺手在后台重跑刷新缓存（不影响本次返回的内容）。
      if (hit.loose) void this.execScriptFilter(wf, node, arg, script, cwd, env, vars, key).catch(() => {});
      return this.buildScriptFilter(wf, node, arg, hit.out);
    }
    const r = await this.execScriptFilter(wf, node, arg, script, cwd, env, vars, key);
    return typeof r === "string" ? this.buildScriptFilter(wf, node, arg, r) : r;
  }

  // 真正起进程跑 Script Filter 脚本：成功返回 stdout，失败返回一条错误结果（外层原样透传给列表）。
  // 顺带记调试轨迹，并按脚本声明的 cache 写入缓存。
  private async execScriptFilter(
    wf: Workflow, node: WorkflowNode, arg: string, script: string,
    cwd: string, env: Record<string, string>, vars: Record<string, string>, key: string,
  ): Promise<string | LauncherResult[]> {
    // 调试轨迹：Script Filter 在「查询」阶段就跑脚本，单独记成一次运行（W8 调试抽屉）。
    const tr = this.trace.begin(wf.id, wf.name, "Script Filter 查询", arg);
    const st = this.trace.stepStart(tr, node.id, node.type, arg, vars);
    const startedAt = Date.now();
    let stderr = "";
    let res;
    try {
      res = await run("bash", ["-lc", script, "umbra", arg], {
        timeoutMs: SCRIPT_TIMEOUT, cwd, env, onStderr: (c) => { stderr += c; },
      });
    } catch (e) {
      this.trace.stepEnd(st, startedAt, { error: `脚本启动失败：${String(e)}`, stderr });
      this.trace.end(tr);
      return [this.errResult(wf.name, `脚本启动失败：${String(e).slice(0, 50)}`)];
    }
    const out = (res.output || "").trim();
    let data: SFOutput;
    try {
      data = JSON.parse(out) as SFOutput;
    } catch {
      const msg = res.code !== 0 ? `脚本出错：${out.slice(0, 60)}` : `输出非 JSON：${out.slice(0, 60)}`;
      this.trace.stepEnd(st, startedAt, { outArg: out, stdout: out, stderr, exitCode: res.code ?? undefined, error: msg });
      this.trace.end(tr);
      return [this.errResult(wf.name, msg)];
    }
    this.trace.stepEnd(st, startedAt, { outArg: out, stdout: out, stderr, exitCode: res.code ?? undefined });
    this.trace.end(tr);
    // 缓存只在真跑过之后写：命中缓存的那条路径不刷新时间戳，免得缓存被无限续命。
    const sec = Number(data.cache?.seconds || 0);
    if (sec >= 1) this.putSfCache(key, out, Math.min(sec, 86400), data.cache?.loosereload === true);
    return out;
  }

  // 写 Script Filter 缓存，顺手把最旧的挤出去（上限 100 条）。
  private putSfCache(key: string, out: string, ttl: number, loose: boolean): void {
    this.sfCache.delete(key);
    this.sfCache.set(key, { out, at: Date.now(), ttl, loose });
    while (this.sfCache.size > 100) {
      const oldest = this.sfCache.keys().next().value;
      if (oldest === undefined) break;
      this.sfCache.delete(oldest);
    }
  }

  // 解析脚本输出 → 结果列表（缓存命中和真跑走的是同一段逻辑，保证两条路径表现一致）。
  private buildScriptFilter(wf: Workflow, node: WorkflowNode, arg: string, out: string): LauncherResult[] {
    let data: SFOutput;
    try {
      data = JSON.parse(out) as SFOutput;
    } catch {
      return [this.errResult(wf.name, `输出非 JSON：${out.slice(0, 60)}`)];
    }
    // rerun：Alfred 限定 0.1~5 秒，超出范围就夹到边界，避免脚本写个 0.001 把 CPU 打满。
    const rr = Number(data.rerun || 0);
    if (rr > 0) this.rerunAfter = Math.min(5, Math.max(0.1, rr));
    let items = Array.isArray(data.items) ? data.items : [];
    // 「Alfred 过滤结果」开关：本地按 match/title 过滤。
    if (node.config.alfredFilters && arg) {
      const a = arg.toLowerCase();
      items = items.filter((it) => (it.match || it.title || "").toLowerCase().includes(a));
    }
    const mods = this.branchMods(wf, node.id);
    // 取用上限跟随设置（launcherMaxResults），不再硬编码 12 条。
    const limit = Math.max(1, Math.min(Number(this.cfg.get().launcherMaxResults) || 12, 50));
    return items.slice(0, limit).map((it, i) => this.itemResult(wf, node.id, it, mods, {
      rank: i, noLearn: data.skipknowledge === true, baseVars: data.variables || {},
    }));
  }

  // Script Filter item → LauncherResult（缓存上下文）。
  // opts.rank：脚本给的原始次序 —— 分数按名次微降（160、159.9、159.8…），
  //   既保住脚本自己的排序，又让「使用频率加权」（一次 +25 起）能把常用项顶上来。
  //   以前所有工作流结果都写死 150，脚本排前排后完全体现不出来。
  // opts.noLearn：脚本声明了 skipknowledge，本次结果不参与频率学习。
  // opts.baseVars：脚本输出顶层 variables，作为每个 item 的基础变量（item 自己的同名键覆盖它）。
  private itemResult(
    wf: Workflow, srcNodeId: string, it: AlfredItem, mods: string[],
    opts: { rank?: number; noLearn?: boolean; baseVars?: Record<string, string> } = {},
  ): LauncherResult {
    const arg = Array.isArray(it.arg) ? it.arg.join("\n") : String(it.arg ?? it.title ?? "");
    const token = this.store({
      wfId: wf.id, srcNodeId, arg,
      variables: { ...(opts.baseVars || {}), ...(it.variables || {}) },
      valid: it.valid !== false, mods: it.mods || {},
    });
    const r: LauncherResult = {
      id: token, title: String(it.title ?? arg), subtitle: it.subtitle ? String(it.subtitle) : `${wf.name} · 回车执行`,
      icon: this.loadIcon(it.icon?.path, wf.icon || "🧩"), source: "workflow",
      score: opts.rank === undefined ? 150 : 160 - opts.rank * 0.1,
      action: { kind: "workflow", payload: { token } }, mods,
    };
    // uid：Alfred 用它记住「这个查询下你更常选哪一项」。token 每次查询都在变，
    // 拿它当学习键等于永远学不会，所以频率学习一律走 uid（脚本没给 uid 就不学）。
    if (it.uid && !opts.noLearn) r.learnId = `wf:${wf.id}:${srcNodeId}:${it.uid}`;
    if (opts.noLearn) r.noLearn = true;
    if (it.autocomplete) r.autocomplete = String(it.autocomplete);
    if (it.quicklookurl) r.quicklook = String(it.quicklookurl);
    return r;
  }

  // 直连动作（Keyword→Action，无 Script Filter）：单条结果。
  private directResult(wf: Workflow, trig: WorkflowNode, arg: string): LauncherResult {
    const mods = this.branchMods(wf, trig.id);
    const token = this.store({ wfId: wf.id, srcNodeId: trig.id, arg, variables: {}, valid: true, mods: {} });
    const title = String(trig.config.title || wf.name);
    return {
      id: token, title, subtitle: arg ? `输入：${arg.slice(0, 40)} · 回车执行` : `${wf.name} · 回车执行`,
      icon: wf.icon || "🧩", source: "workflow", score: 150,
      action: { kind: "workflow", payload: { token } }, mods,
      // 直连动作没有 uid 可用，但「工作流+触发器」本身就是稳定的一项，可以直接拿来学习。
      learnId: `wf:${wf.id}:${trig.id}`,
    };
  }

  private hintResult(wf: Workflow, trig: WorkflowNode): LauncherResult {
    const token = this.store({ wfId: wf.id, srcNodeId: trig.id, arg: "", variables: {}, valid: false, mods: {}, hintOnly: true });
    return {
      id: token, title: String(trig.config.title || wf.name), subtitle: "输入内容后回车…",
      icon: wf.icon || "🧩", source: "workflow", score: 150, action: { kind: "workflow", payload: { token } },
      noLearn: true,   // 「请输入内容」只是占位提示，不该被记成一次使用
    };
  }
  private errResult(name: string, msg: string): LauncherResult {
    const token = this.store({ wfId: "", srcNodeId: "", arg: "", variables: {}, valid: false, mods: {}, hintOnly: true });
    return {
      id: token, title: msg, subtitle: `${name} · 工作流`, icon: "⚠️", source: "workflow", score: 150,
      action: { kind: "workflow", payload: { token } }, noLearn: true,
    };
  }

  private store(c: ItemCtx): string {
    const token = `wf:${c.wfId}:${c.srcNodeId}:${this.seq++}`;
    this.ctx.set(token, c);
    return token;
  }

  // 图标：文件路径 → dataURL；否则用 emoji 兜底。
  private loadIcon(p: string | undefined, fallback: string): string {
    if (!p) return fallback;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { nativeImage } = require("electron") as typeof import("electron");
      const img = nativeImage.createFromPath(expandHome(p));
      if (!img.isEmpty()) return img.resize({ width: 32, height: 32 }).toDataURL();
    } catch { /* 加载失败用兜底 */ }
    return fallback;
  }

  // ── 执行：沿修饰键分支跑动作链 ──
  // 返回：提示文案（渲染层弹 toast）；NO_BRANCH=该修饰键无分支（上层兜底）。
  async run(token: string, mod: string): Promise<string> {
    const c = this.ctx.get(token);
    if (!c) return "";
    if (c.hintOnly || !c.valid) return c.hintOnly ? "" : "该项不可执行";
    const wf = this.workflows().find((w) => w.id === c.wfId);
    if (!wf) return "";
    const m = (mod || "").toLowerCase();
    const modData = c.mods[m];
    const arg = modData?.arg ?? c.arg;
    const vars = { ...this.baseVars(wf), ...c.variables, ...(modData?.variables || {}) };
    const conns = this.outConns(wf, c.srcNodeId, m);
    if (!conns.length) {
      if (m !== "") return NO_BRANCH;           // 修饰键无分支 → 上层兜底
      if (arg) { const { clipboard } = await import("electron"); clipboard.writeText(arg); return "已复制 ✓"; } // 回车且无下游 → 默认复制 arg
      return "";
    }
    const visited = new Set<string>();
    // 调试轨迹：一次「选中结果并回车/修饰键执行」= 一条运行记录。
    const tr = this.trace.begin(wf.id, wf.name, m ? `${m} 分支` : "回车", arg);
    let fb = "";
    try {
      for (const conn of conns) fb = (await this.runNode(wf, conn.to, arg, vars, visited, tr)) || fb;
    } finally {
      this.trace.end(tr);   // 中途抛异常也要把已记录的步数留下，否则最需要看的那次反而丢了
    }
    return fb;
  }

  // 执行单个节点，随后把「输出 arg」传给所有下游（回车分支）——支持链式(a→b→c)与扇出(a→b, a→c)多节点参数传递。
  // varsIn 在入口处复制一份：本节点写入的变量对自己的下游可见，但不会污染兄弟分支。
  // tr：本次运行的调试轨迹（W8），一路往下传而不是存在实例上，避免并发执行互相串台。
  // fan：当前所处的扇出批次（上游有 Split 且走「参数列表」输出时才非空），同样一路往下传给 Join 用。
  private async runNode(wf: Workflow, nodeId: string, arg: string, varsIn: Record<string, string>, visited: Set<string>, tr: TraceRun | null = null, fan: FanCtx | null = null): Promise<string> {
    if (visited.has(nodeId)) return "";  // 防环
    visited.add(nodeId);
    const node = this.node(wf, nodeId);
    if (!node) return "";
    const vars = { ...varsIn };
    // 节点被停用（E6）→ 旁路：不执行自身逻辑，入参原样从默认出口继续往下传。
    if (node.disabled) {
      const skipAt = Date.now();
      const skipStep = this.trace.stepStart(tr, node.id, node.type, arg, vars);
      this.trace.stepEnd(skipStep, skipAt, { outArg: arg, skipped: true });
      let fb = "";
      for (const c of this.outConns(wf, nodeId, "", "")) {
        const r = await this.runNode(wf, c.to, arg, vars, visited, tr, fan);
        if (r) fb = r;
      }
      return fb;
    }
    const { clipboard, Notification } = await import("electron");
    let feedback = "";
    let outArg = arg;   // 默认把 arg 原样传给下游
    let outPort = "";   // 从哪个出口往下继续（多出口节点会改写：conditional 的 r0/else、脚本失败的 error）
    let stop = false;   // 是否就此终止本条链路（不再往下游传）
    // Split / Join 用：fanItems 非空表示本节点要把下游按项逐条跑一遍；
    // hold=true 表示 Join 还没收齐、这一项到此为止；fanOut 是传给下游的扇出批次（Join 合并后回到外层）。
    let fanItems: string[] | null = null;
    let fanOut: FanCtx | null = fan;
    let hold = false;
    // 调试轨迹用：脚本类节点的输出与退出码，跑完一并写进这一步。
    let stdout: string | undefined;
    let stderr: string | undefined;
    let exitCode: number | undefined;
    const step = this.trace.stepStart(tr, node.id, node.type, arg, vars);
    const startedAt = Date.now();
    try {
    switch (node.type) {
      // ── 工具：Args & Vars —— 改写下游 arg，并写入/覆盖变量（整个工作流的地基节点）──
      case "utility.args": {
        const mode = String(node.config.argMode || "keep");   // keep=沿用上游 | set=用模板改写 | clear=清空
        if (mode === "set") outArg = this.subst(String(node.config.text || ""), arg, vars);
        else if (mode === "clear") outArg = "";
        const kv = (node.config.vars || {}) as Record<string, string>;
        for (const [k, v] of Object.entries(kv)) {
          const key = String(k || "").trim();
          if (key) vars[key] = this.subst(String(v ?? ""), outArg, vars);
        }
        break;
      }

      // ── 工具：Conditional —— 逐条规则求值，命中第 i 条走 "r{i}" 出口，全不中走 "else" 出口 ──
      case "utility.conditional": {
        const rules = Array.isArray(node.config.rules) ? (node.config.rules as Record<string, unknown>[]) : [];
        let hit = -1;
        for (let i = 0; i < rules.length; i++) {
          if (this.matchRule(rules[i] || {}, arg, vars)) { hit = i; break; }
        }
        // 命中的出口若没连线，下面的循环取不到连线，链路自然终止——不会回退到默认出口。
        outPort = hit >= 0 ? `r${hit}` : "else";
        break;
      }

      // ── 工具：Transform —— 对 arg 或指定变量做大小写 / 编解码变换 ──
      case "utility.transform": {
        const target = String(node.config.target || "").trim();   // 空=作用于 arg，否则作用于该变量
        const done = this.transformText(target ? (vars[target] ?? "") : arg, String(node.config.mode || "upper"));
        if (target) vars[target] = done; else outArg = done;
        break;
      }

      // ── 工具：Replace —— 字符串 / 正则替换，可作用于 arg 或指定变量 ──
      case "utility.replace": {
        const target = String(node.config.target || "").trim();
        const src = target ? (vars[target] ?? "") : arg;
        const find = String(node.config.find || "");
        const to = String(node.config.to || "");
        let done = src;
        if (find) {
          // 非正则模式也走 RegExp（转义后），这样「忽略大小写」对两种模式都生效。
          const pattern = node.config.regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          try { done = src.replace(new RegExp(pattern, "g" + (node.config.ci ? "i" : "")), to); }
          catch { feedback = "替换失败：正则表达式不合法"; }
        }
        if (target) vars[target] = done; else outArg = done;
        break;
      }

      // ── 工具：Split 拆分参数 —— 把一条参数按分隔符拆成多条 ──
      // 两种输出方式：
      //   vars（变量）：拆出的项写成 {prefix}1..{prefix}N 加一个 {prefix}Count，arg 原样透传，链路仍是单条；
      //   args（参数列表）：下游按拆出的项逐条跑一遍（扇出），串行执行、保持原顺序，末端可用 Join 合回一条。
      case "utility.split": {
        const sep = delimOf(String(node.config.with || "comma"), String(node.config.custom || ""));
        let items = splitBy(arg, sep);
        if (node.config.trim !== false) items = items.map((s) => s.trim());   // 默认去掉每项两端空白
        if (node.config.discardEmpty) items = items.filter((s) => s !== "");  // 默认保留空项（和 Alfred 一致）
        if (items.length > MAX_FAN) {
          feedback = `拆出 ${items.length} 项，超出上限只取前 ${MAX_FAN} 项`;
          items = items.slice(0, MAX_FAN);
        }
        if (String(node.config.output || "vars") === "args") {
          fanItems = items;
          stdout = `拆出 ${items.length} 项，下游逐条执行`;
        } else {
          const prefix = String(node.config.prefix || "split").trim() || "split";
          for (let i = 0; i < items.length; i++) vars[`${prefix}${i + 1}`] = items[i];
          vars[`${prefix}Count`] = String(items.length);
          stdout = `拆出 ${items.length} 项 → ${prefix}1..${prefix}${items.length}`;
        }
        break;
      }

      // ── 工具：Join 合并参数 —— 把 Split 扇出的多条参数并回一条 ──
      // 不在扇出里（上游没接 Split，或 Split 走的是变量输出）时直接透传，和 Alfred「单项则原样通过」一致。
      // 在扇出里：前 N-1 项只往桶里收、不再往下走，最后一项把桶里的内容用分隔符连成一条交给下游。
      // 已知取舍：中途某一项被 Conditional 之类拦掉就不会进桶（那一项丢失）；若最后一项压根没走到这里，
      // 整批都不会输出。这是「按到达顺序收集」换来的简单，链路里有条件分支时要留意。
      case "utility.join": {
        if (!fan) { stdout = "不在拆分批次里，原样透传"; break; }
        const box = fan.bucket.get(node.id) || [];
        box.push(arg);
        fan.bucket.set(node.id, box);
        if (fan.index < fan.total - 1) {
          hold = true;
          stdout = `已收集 ${box.length}/${fan.total} 项，等后面的项`;
          break;
        }
        const sep = delimOf(String(node.config.with || "newline"), String(node.config.custom || ""));
        outArg = box.join(sep);
        fan.bucket.delete(node.id);
        fanOut = fan.parent;   // 合并完就不在这一批里了，回到外层扇出（没有外层则回到普通单条链路）
        stdout = `合并 ${box.length} 项`;
        break;
      }

      // ── 工具：Debug 打点 —— 往调试轨迹里写一行文本，链路本身照常往下走 ──
      // 文本走 stdout 字段，调试抽屉里就在这个节点下面显示，和脚本输出一个位置。
      case "utility.debug": {
        // 「清空本工作流的调试记录」：只清这条工作流之前的运行，本次运行还没入队，不受影响。
        if (node.config.clear) this.trace.clear(wf.id);
        const text = this.substDebug(String(node.config.text ?? "{query}"), arg, vars);
        stdout = text;
        // after=pass（默认）入参原样传给下游；after=replace 把打点文本当作下游 arg。
        if (String(node.config.after || "pass") === "replace") outArg = text;
        break;
      }

      // ── 工具：Delay —— 等待若干秒再继续（上限 60 秒，避免卡死链路）──
      case "utility.delay": {
        const ms = Math.max(0, Math.min(Number(node.config.seconds || 0) * 1000, 60000));
        if (ms) await new Promise((r) => setTimeout(r, ms));
        break;
      }

      case "action.copy":
        clipboard.writeText(arg); feedback = "已复制 ✓"; break;
      case "action.paste":
        clipboard.writeText(arg);
        await this.deps.hide(true);
        await new Promise((r) => setTimeout(r, 180));
        await simulatePaste();
        break;
      case "action.openurl": {
        const url = this.subst(String(node.config.url || "{query}"), arg, vars) || arg;
        await run("open", [url]); await this.deps.hide(false); break;
      }
      case "action.openfile": {
        const p = expandHome(this.subst(String(node.config.path || "{query}"), arg, vars) || arg);
        const app = String(node.config.app || "");
        await run("open", app ? ["-a", app, p] : [p]); await this.deps.hide(false); break;
      }
      case "action.launch": {
        const paths = Array.isArray(node.config.paths) ? (node.config.paths as string[]) : [];
        const toggle = !!node.config.toggleVisibility;
        for (const raw of paths) {
          const ep = expandHome(String(raw || "").trim());
          if (!ep) continue;
          if (toggle && /\.app$/i.test(ep)) {
            const name = (ep.split("/").pop() || "").replace(/\.app$/i, "");
            const front = await run("osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true']);
            if (front.output.trim() === name) { await run("osascript", ["-e", `tell application "System Events" to set visible of process "${name}" to false`]); continue; }
          }
          await run("open", [ep]);
        }
        await this.deps.hide(false); break;
      }
      case "action.script": {
        const script = this.subst(String(node.config.script || ""), arg, vars);
        // cwd 缺省 = 本工作流自己的目录；填了相对路径也按工作流目录解析。
        // 这样脚本里就能直接写 ./runtime/txiki ./index.js，随行文件跟着工作流走。
        const dir = await ensureWorkflowDir(this.cfg.dir, wf.id);
        const cwd = resolveCwd(dir, String(node.config.cwd || ""), expandHome);
        const env: Record<string, string> = { ...workflowEnv(dir, wf.id, wf.name) };
        for (const [k, v] of Object.entries(vars)) env[k] = String(v ?? "");
        env.query = arg;
        let err = "";
        const res = await run("bash", ["-lc", script, "umbra", arg], {
          timeoutMs: SCRIPT_TIMEOUT, cwd, env, onStderr: (c) => { err += c; },
        });
        const out = (res.output || "").trim();
        stdout = out; stderr = err; exitCode = res.code ?? undefined;   // 记进调试轨迹
        outArg = out;  // 脚本把 stdout 作为下游 arg
        if (res.code !== 0) {
          feedback = `脚本出错：${out.slice(0, 40) || "非零退出"}`;
          // onError：stop=终止链路（默认，出错就不该继续做后面的事）| continue=照常往下走 | branch=改走 error 出口
          const onError = String(node.config.onError || "stop");
          if (onError === "branch") outPort = "error";
          else if (onError !== "continue") stop = true;
          break;
        }
        // Alfred 包裹输出 {"alfredworkflow":{"arg":..,"variables":{..}}}：解析出来回写 arg 与变量。
        const wrapped = this.parseAlfredOutput(out);
        if (wrapped) {
          if (wrapped.arg !== undefined) outArg = wrapped.arg;
          for (const [k, v] of Object.entries(wrapped.variables || {})) vars[k] = v;
        }
        if ((node.config.output || "none") === "copy" && outArg) { clipboard.writeText(outArg); feedback = `已复制：${outArg.slice(0, 30)}`; }
        else feedback = "已执行 ✓";
        break;
      }
      case "action.assistant":
        this.deps.sendAssistant(arg); break;
      case "action.inspiration":
        feedback = await this.postInspiration(arg); break;

      // ── 问秘书并等回复：回复文本作为下游 arg 继续传递（Umbra 差异化节点）──
      case "action.ask_assistant": {
        const content = this.subst(String(node.config.prompt || "{query}"), arg, vars).trim();
        if (!content) { feedback = "问秘书：内容为空"; stop = true; break; }
        const title = this.subst(String(node.config.title || ""), arg, vars) || "秘书";
        const show = node.config.show !== false;   // 默认开文本视图展示，等待期间显示 loading
        if (show) {
          this.deps.showTextView({ text: content, title, md: true, loading: true });
          await this.deps.hide(false);
        }
        const r = await this.askAssistant(content);
        if (r.error) {
          feedback = `问秘书失败：${r.error.slice(0, 40)}`;
          if (show) this.deps.showTextView({ text: feedback, title, md: false });
          stop = true; break;
        }
        outArg = r.reply;
        if (show) this.deps.showTextView({ text: r.reply, title, md: true });
        else feedback = "秘书已回复 ✓";
        break;
      }

      // ── 建任务：服务端没有独立的建任务路由，这里是「/web/message + 建任务前缀」的薄封装 ──
      case "action.create_task": {
        const body = this.subst(String(node.config.text || "{query}"), arg, vars).trim();
        if (!body) { feedback = "建任务：内容为空"; stop = true; break; }
        const prefix = String(node.config.prefix ?? "帮我建个任务：");
        const r = await this.askAssistant(`${prefix}${body}`);
        if (r.error) { feedback = `建任务失败：${r.error.slice(0, 40)}`; stop = true; break; }
        outArg = r.reply;
        feedback = "已交给秘书建任务 ✓";
        break;
      }

      // ── 设备技能派发：把参数交给某台在线设备的 provider.skill 执行，结果作为下游 arg ──
      case "action.device_skill": {
        const provider = String(node.config.provider || "").trim();
        const skill = String(node.config.skill || "").trim();
        if (!provider || !skill) { feedback = "设备技能：未填写 provider / skill"; stop = true; break; }
        let params: Record<string, unknown> = {};
        // 参数是一段 JSON 文本，占位符按 JSON 字符串转义后再插入，避免引号/换行把 JSON 打断。
        const rawParams = this.substJson(String(node.config.params || ""), arg, vars).trim();
        if (rawParams) {
          try { params = JSON.parse(rawParams) as Record<string, unknown>; }
          catch { feedback = "设备技能：参数不是合法 JSON"; stop = true; break; }
        }
        let device = String(node.config.device || "").trim();
        if (!device) {
          device = await this.pickDevice(provider, skill);   // 留空=自动挑一台有该技能的在线设备
          if (!device) { feedback = `没有在线设备提供 ${provider}.${skill}`; stop = true; break; }
        }
        const r = await this.dispatchDevice(device, provider, skill, params);
        if (r.error) { feedback = `派发失败：${r.error.slice(0, 40)}`; stop = true; break; }
        outArg = r.text;
        feedback = r.text ? `设备已执行：${r.text.slice(0, 30)}` : "设备已执行 ✓";
        break;
      }

      case "output.largetype":
        this.deps.showLargeType(arg); await this.deps.hide(false); break;

      // ── 文本视图：把长文摊在浮层里（可 Markdown、可追加），大字显示装不下时用 ──
      case "output.textview": {
        this.deps.showTextView({
          text: arg,
          title: this.subst(String(node.config.title || ""), arg, vars) || wf.name,
          md: node.config.markdown !== false,
          append: !!node.config.append,
        });
        await this.deps.hide(false);
        break;
      }

      case "output.notify":
        try { new Notification({ title: wf.name, body: arg }).show(); } catch { /* 无通知权限忽略 */ }
        break;

      // ── 输出：写文本文件 —— 把内容落到磁盘，并把「最终写入的绝对路径」作为下游 arg ──
      // 路径规则：~ 展开；绝对路径按填的走；相对路径落到本工作流的 data 目录
      //（脚本读得到 $alfred_workflow_data，工作流整包拷走时文件也跟着走）。
      case "output.writefile": {
        const rawPath = this.subst(String(node.config.path || ""), arg, vars).trim();
        const body = this.subst(String(node.config.content ?? "{query}"), arg, vars);
        if (!rawPath) { feedback = "写文件：没填文件名"; stop = true; break; }
        if (!body && !node.config.allowEmpty) { feedback = "写文件：内容为空（未勾选允许空文件）"; stop = true; break; }
        const dir = await ensureWorkflowDir(this.cfg.dir, wf.id);
        const ep = expandHome(rawPath);
        let target = path.isAbsolute(ep) ? ep : path.join(dir, "data", ep);
        // 加 UUID：加在扩展名之前，扩展名保住（notes.md → notes-3f2a….md）。
        if (node.config.uuid) {
          const ext = path.extname(target);
          target = `${target.slice(0, target.length - ext.length)}-${randomUUID()}${ext}`;
        }
        if (node.config.mkdirs) {
          try { await fs.mkdir(path.dirname(target), { recursive: true }); }
          catch (e) { feedback = `写文件：建目录失败 ${String(e).slice(0, 40)}`; stop = true; break; }
        }
        const exists = await fs.stat(target).then(() => true).catch(() => false);
        // 已存在时怎么办：overwrite=覆盖（默认）| append=追加 | unique=另存 name-1.txt | skip=什么都不做
        const mode = String(node.config.ifExists || "overwrite");
        if (exists && mode === "skip") { outArg = target; feedback = "写文件：已存在，跳过"; break; }
        if (exists && mode === "unique") target = await uniquePath(target);
        try {
          if (exists && mode === "append") await fs.appendFile(target, body, "utf8");
          else await fs.writeFile(target, body, "utf8");
        } catch (e) { feedback = `写文件失败：${String(e).slice(0, 60)}`; stop = true; break; }
        outArg = target;   // 下游拿到的是绝对路径，接「打开文件」「复制」都顺手
        feedback = `已写入：${path.basename(target)} ✓`;
        break;
      }
    }
    } catch (e) {
      // 节点内部抛异常：先把这一步记进轨迹（否则调试抽屉里只会看到「跑到一半没了」），再原样抛出。
      this.trace.stepEnd(step, startedAt, { outArg: arg, error: String(e), stdout, stderr, exitCode });
      throw e;
    }
    this.trace.stepEnd(step, startedAt, { outArg, outPort, feedback, stopped: stop, stdout, stderr, exitCode });
    if (stop) return feedback;   // 链路被节点主动终止（脚本失败、远程调用失败等）
    if (hold) return feedback;   // Join 还没收齐，这一项到此为止，等这批的最后一项来了再往下走
    // Split（参数列表输出）：下游按拆出的每一项各跑一遍，串行且保序，方便脚本节点顺序处理。
    if (fanItems) {
      const ctx: FanCtx = { index: 0, total: fanItems.length, bucket: new Map(), parent: fan };
      for (let i = 0; i < fanItems.length; i++) {
        ctx.index = i;
        for (const c of this.outConns(wf, nodeId, "", outPort)) {
          // visited 传副本而不是同一个：对上游仍然防环，但下游节点允许每一项各执行一次。
          const fb = await this.runNode(wf, c.to, fanItems[i], vars, new Set(visited), tr, ctx);
          if (fb) feedback = fb;
        }
      }
      return feedback;
    }
    // 传给 outPort 出口上的所有下游（回车分支）——链式/扇出都把 arg 与变量继续传递。
    for (const c of this.outConns(wf, nodeId, "", outPort)) {
      const fb = await this.runNode(wf, c.to, outArg, vars, visited, tr, fanOut);
      if (fb) feedback = fb;
    }
    return feedback;
  }

  // Conditional 单条规则求值。subject 支持占位（缺省 {query}=上游 arg）；ci 缺省 true（忽略大小写）。
  private matchRule(rule: Record<string, unknown>, arg: string, vars: Record<string, string>): boolean {
    const op = String(rule.op || "contains");
    const ci = rule.ci !== false;
    const rawSubject = this.subst(String(rule.subject || "{query}"), arg, vars);
    const rawValue = this.subst(String(rule.value ?? ""), arg, vars);
    const subject = ci ? rawSubject.toLowerCase() : rawSubject;
    const value = ci ? rawValue.toLowerCase() : rawValue;
    const num = (s: string) => Number(String(s).replace(/,/g, "").trim());
    switch (op) {
      case "is": return subject === value;
      case "is_not": return subject !== value;
      case "contains": return subject.includes(value);
      case "not_contains": return !subject.includes(value);
      case "starts_with": return subject.startsWith(value);
      case "ends_with": return subject.endsWith(value);
      case "is_empty": return subject.trim() === "";
      case "is_not_empty": return subject.trim() !== "";
      case "gt": return num(subject) > num(value);
      case "gte": return num(subject) >= num(value);
      case "lt": return num(subject) < num(value);
      case "lte": return num(subject) <= num(value);
      case "matches":
      case "not_matches": {
        let ok = false;
        try { ok = new RegExp(rawValue, ci ? "i" : "").test(rawSubject); }
        catch { ok = false; }   // 正则写错当作不命中，不阻断链路
        return op === "matches" ? ok : !ok;
      }
      default: return false;
    }
  }

  // Transform 节点的文本变换实现。
  private transformText(src: string, mode: string): string {
    switch (mode) {
      case "upper": return src.toUpperCase();
      case "lower": return src.toLowerCase();
      case "title": return src.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
      case "trim": return src.trim();
      case "urlencode": return encodeURIComponent(src);
      case "urldecode": { try { return decodeURIComponent(src); } catch { return src; } }
      case "base64encode": return Buffer.from(src, "utf8").toString("base64");
      case "base64decode": { try { return Buffer.from(src, "base64").toString("utf8"); } catch { return src; } }
      default: return src;
    }
  }

  // 占位替换（Debug 打点版）：在通用占位符之外多认一个 {variables} —— 当前全部变量的转储。
  // 顺序是「先通用替换、后展开 {variables}」：{variables} 不在通用占位符表里会原样留到最后一步，
  // 这样变量值里若正好写着 {query} 也不会被二次展开。疑似密钥按调试抽屉同一套规则打码。
  private substDebug(tpl: string, arg: string, vars: Record<string, string>): string {
    const done = this.subst(tpl, arg, vars);
    if (!done.includes("{variables}")) return done;
    const entries = Object.entries(vars);
    const dump = entries.length ? entries.map(([k, v]) => `${k} = ${maskSecret(k, String(v ?? ""))}`).join("\n") : "（无变量）";
    return done.replace(/\{variables\}/g, () => dump);
  }

  // 占位替换（JSON 版）：值按 JSON 字符串转义后插入，供「参数是一段 JSON 文本」的节点使用。
  private substJson(tpl: string, arg: string, vars: Record<string, string>): string {
    const esc = (v: string) => JSON.stringify(String(v ?? "")).slice(1, -1);
    return (tpl || "")
      .replace(/\{query\}/g, () => esc(arg))
      .replace(/\{var:([^}]+)\}/g, (_m, k) => esc(vars[String(k).trim()] ?? ""));
  }

  // 解析 Run Script 的 Alfred 包裹输出 {"alfredworkflow":{"arg":..,"variables":{..}}}。
  // 不是这个形状（普通 stdout）时返回 null，仍按「stdout 即 arg」处理。
  private parseAlfredOutput(out: string): { arg?: string; variables?: Record<string, string> } | null {
    const t = (out || "").trim();
    if (!t.startsWith("{") || !t.includes("alfredworkflow")) return null;
    try {
      const data = JSON.parse(t) as { alfredworkflow?: { arg?: unknown; variables?: Record<string, unknown> } };
      const w = data.alfredworkflow;
      if (!w || typeof w !== "object") return null;
      const arg = w.arg === undefined ? undefined : Array.isArray(w.arg) ? w.arg.join("\n") : String(w.arg);
      const variables: Record<string, string> = {};
      for (const [k, v] of Object.entries(w.variables || {})) variables[k] = String(v ?? "");
      return { arg, variables };
    } catch { return null; }
  }

  // 问秘书：走服务端 /web/message 完整链路，返回回复文本；出错时 error 有值。
  private async askAssistant(content: string): Promise<{ reply: string; error?: string }> {
    try {
      const c = this.cfg.get();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (c.token) headers["X-Umbra-Token"] = c.token;
      const resp = await httpFetch(`${httpBase(c)}/web/message`, {
        method: "POST", headers,
        body: JSON.stringify({ client_id: c.deviceId, content, node_id: c.deviceId }),
        signal: AbortSignal.timeout(REMOTE_TIMEOUT),
      });
      if (!resp.ok) return { reply: "", error: `HTTP ${resp.status}` };
      const data = await resp.json() as { reply?: string };
      return { reply: String(data.reply ?? "") };
    } catch (e) {
      return { reply: "", error: String(e) };
    }
  }

  // 按 provider.skill 自动挑一台在线设备（/devices/all 给的是规范化后的能力目录）。
  private async pickDevice(provider: string, skill: string): Promise<string> {
    try {
      const c = this.cfg.get();
      const headers: Record<string, string> = {};
      if (c.token) headers["X-Umbra-Token"] = c.token;
      const resp = await httpFetch(`${httpBase(c)}/devices/all`, { headers, signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return "";
      const list = await resp.json() as {
        device_id?: string; online?: boolean;
        providers?: { provider?: string; available?: boolean; skills?: { name?: string }[] }[];
      }[];
      for (const d of Array.isArray(list) ? list : []) {
        if (!d.online || !d.device_id) continue;
        const p = (d.providers || []).find((x) => x.provider === provider && x.available !== false);
        if (p && (p.skills || []).some((s) => s.name === skill)) return String(d.device_id);
      }
    } catch { /* 查不到就返回空，由调用方给出提示 */ }
    return "";
  }

  // 把技能派发给指定设备执行（服务端同步等结果）。
  private async dispatchDevice(deviceId: string, provider: string, skill: string, params: Record<string, unknown>): Promise<{ text: string; error?: string }> {
    try {
      const c = this.cfg.get();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (c.token) headers["X-Umbra-Token"] = c.token;
      const resp = await httpFetch(`${httpBase(c)}/devices/${encodeURIComponent(deviceId)}/dispatch`, {
        method: "POST", headers,
        body: JSON.stringify({ provider, skill, params }),
        signal: AbortSignal.timeout(REMOTE_TIMEOUT),
      });
      if (!resp.ok) return { text: "", error: `HTTP ${resp.status}` };
      const data = await resp.json() as { result?: unknown };
      const r = data.result;
      return { text: typeof r === "string" ? r : r === undefined || r === null ? "" : JSON.stringify(r) };
    } catch (e) {
      return { text: "", error: String(e) };
    }
  }

  private async postInspiration(raw: string): Promise<string> {
    const t = (raw || "").trim();
    if (!t) return "";
    try {
      const c = this.cfg.get();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (c.token) headers["X-Umbra-Token"] = c.token;
      const resp = await httpFetch(`${httpBase(c)}/inspirations`, { method: "POST", headers, body: JSON.stringify({ raw: t }) });
      return resp.ok ? "已记为灵感 ✓" : `记灵感失败：${resp.status}`;
    } catch (e) {
      return `记灵感失败：${String(e).slice(0, 40)}`;
    }
  }

  // ── Hotkey 触发：供 main.ts 在 reregisterShortcuts 里注册 ──
  hotkeys(): { accelerator: string; wfId: string; nodeId: string }[] {
    const out: { accelerator: string; wfId: string; nodeId: string }[] = [];
    for (const wf of this.workflows()) {
      for (const n of wf.nodes.filter((n) => n.type === "trigger.hotkey" && !n.disabled)) {
        const acc = String(n.config.accelerator || "").trim();
        if (acc) out.push({ accelerator: acc, wfId: wf.id, nodeId: n.id });
      }
    }
    return out;
  }
  // Hotkey 触发：arg = 当前剪贴板文本；沿该节点的回车分支执行动作链。
  // ── 从编辑器手动运行（顶栏「运行」按钮）──────────────────────────────────
  // 和快捷键/Universal 触发的区别只有入口：参数是用户在顶栏输入框里现填的，
  // 而不是从剪贴板或选区抓的。跑的仍然是「回车」分支，走同一条 runNode，
  // 所以调试抽屉里看到的轨迹和真实触发时完全一致 —— 这正是这个按钮的意义。
  //
  // nodeId 为空 = 让引擎自己挑入口：优先第一个**没被停用**的触发器节点。
  // 编辑器里选中了某个节点时会把它传进来，这样可以只跑链路的一段。
  // 返回 from 是为了让界面能说清「从哪个节点跑的」，跑完一脸茫然最难受。
  async runFromEditor(wfId: string, nodeId: string, arg: string): Promise<{ ok: boolean; from: string; feedback: string; error: string }> {
    const fail = (error: string) => ({ ok: false, from: "", feedback: "", error });
    const wf = this.workflows().find((w) => w.id === wfId);
    if (!wf) return fail("工作流不存在");
    let start = nodeId ? wf.nodes.find((n) => n.id === nodeId) : undefined;
    if (nodeId && !start) return fail("选中的节点已不存在");
    if (!start) start = wf.nodes.find((n) => n.type.startsWith("trigger.") && !n.disabled);
    if (!start) return fail("这条工作流还没有可用的触发器节点");
    if (start.disabled) return fail("这个节点已停用");
    const conns = this.outConns(wf, start.id, "");
    if (!conns.length) return fail("这个节点的「回车」出口还没有连线");

    const vars = this.baseVars(wf);
    const visited = new Set<string>();
    // 轨迹的触发方式写「手动运行」，和真实触发区分开，回头看记录时不会认错。
    const tr = this.trace.begin(wf.id, wf.name, "手动运行", arg);
    let feedback = "";
    try {
      for (const conn of conns) feedback = (await this.runNode(wf, conn.to, arg, vars, visited, tr)) || feedback;
    } catch (e) {
      return { ok: false, from: start.id, feedback, error: String(e instanceof Error ? e.message : e) };
    } finally {
      // 中途抛异常也要把已记录的步数留下 —— 手动运行本来就多半是为了看它错在哪。
      this.trace.end(tr);
    }
    return { ok: true, from: start.id, feedback, error: "" };
  }

  async fireHotkey(wfId: string, nodeId: string): Promise<void> {
    const wf = this.workflows().find((w) => w.id === wfId);
    if (!wf) return;
    const { clipboard } = await import("electron");
    const arg = clipboard.readText() || "";
    const vars = this.baseVars(wf);
    const visited = new Set<string>();
    const tr = this.trace.begin(wf.id, wf.name, "快捷键", arg);
    try {
      for (const conn of this.outConns(wf, nodeId, "")) await this.runNode(wf, conn.to, arg, vars, visited, tr);
    } finally {
      this.trace.end(tr);
    }
  }

  // ── Universal Action 触发（W4）：把「当前选中的东西」喂给工作流 ──
  // 和 Hotkey 触发的区别：Hotkey 读的是剪贴板里已有的内容；Universal Action 会先模拟一次 ⌘C
  // 把前台应用的选区抓过来，用完再把原来的剪贴板还回去。
  universals(): { accelerator: string; wfId: string; nodeId: string }[] {
    const out: { accelerator: string; wfId: string; nodeId: string }[] = [];
    for (const wf of this.workflows()) {
      for (const n of wf.nodes.filter((n) => n.type === "trigger.universal" && !n.disabled)) {
        const acc = String(n.config.accelerator || "").trim();
        if (acc) out.push({ accelerator: acc, wfId: wf.id, nodeId: n.id });
      }
    }
    return out;
  }

  // 抓当前选区：模拟 ⌘C → 等剪贴板真的变了 → 读文本/文件路径 → 还原剪贴板。
  // 还原是为了不吞掉用户手里的复制内容；剪贴板历史 800ms 轮询一次，一般也来不及看见这一瞬间。
  // want：text=只要文本，files=只要文件路径，auto=有文件先用文件，否则用文本。
  private async grabSelection(want: string): Promise<{ text: string; files: string[] }> {
    const { clipboard } = await import("electron");
    // 先备份现场：文件 > 图片 > 纯文本，还原时按剪贴板里原本有的那种写回去。
    const prevText = clipboard.readText();
    let prevFiles: Buffer | null = null;
    try { const b = clipboard.readBuffer("NSFilenamesPboardType"); if (b && b.length) prevFiles = b; } catch { /* 非 mac 没这个类型 */ }
    let prevImg: Electron.NativeImage | null = null;
    if (!prevFiles) { try { const i = clipboard.readImage(); if (!i.isEmpty()) prevImg = i; } catch { /* 忽略 */ } }
    const before = `${prevText}\u0000${readClipboardFiles(clipboard).join("\u0000")}`;

    if (!(await simulateCopy())) return { text: "", files: [] };   // 没授权/不支持 → 抓不到
    // 等前台应用真的把选区写进剪贴板，最多等 600ms（每 60ms 看一眼）。
    let text = "", files: string[] = [];
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 60));
      const t = clipboard.readText(), f = readClipboardFiles(clipboard);
      if (`${t}\u0000${f.join("\u0000")}` !== before) { text = t; files = f; break; }
    }
    try {
      clipboard.writeText(prevText);
      if (prevFiles) clipboard.writeBuffer("NSFilenamesPboardType", prevFiles);
      else if (prevImg) clipboard.writeImage(prevImg);
    } catch { /* 还原失败不影响本次触发 */ }

    if (want === "files") return { text: files.join("\n"), files };
    if (want === "text") return { text, files: [] };
    return { text: files.length ? files.join("\n") : text, files };
  }

  // Universal Action 触发：arg = 选中的文本（或文件路径，一行一个）；
  // 额外注入 selection_type / selection_files 两个变量，脚本里可以据此分开处理。
  async fireUniversal(wfId: string, nodeId: string): Promise<void> {
    const wf = this.workflows().find((w) => w.id === wfId);
    if (!wf) return;
    const n = this.node(wf, nodeId);
    const { text, files } = await this.grabSelection(String(n?.config.source || "auto"));
    const arg = text.trim() ? text : files.join("\n");
    if (!arg) {
      // 抓不到就明说，别让用户对着没反应的快捷键猜。最常见的原因是没给辅助功能权限。
      try {
        const { Notification } = await import("electron");
        new Notification({ title: wf.name, body: "没抓到选中的内容（先选中一段文字/几个文件，并确认已给 Umbra 辅助功能权限）" }).show();
      } catch { /* 无通知权限忽略 */ }
      return;
    }
    const vars = this.baseVars(wf);
    vars.selection_type = files.length ? "files" : "text";
    vars.selection_files = files.join("\n");
    const visited = new Set<string>();
    const tr = this.trace.begin(wf.id, wf.name, "Universal Action", arg);
    try {
      for (const conn of this.outConns(wf, nodeId, "")) await this.runNode(wf, conn.to, arg, vars, visited, tr);
    } finally {
      this.trace.end(tr);
    }
  }
}

// 迁移：把旧 launcherScripts 转成 Keyword+Run Script 工作流（幂等，一次性）。
export function migrateScriptsToWorkflows(cfg: ConfigStore): boolean {
  const c = cfg.get();
  if (c.launcherScriptsMigrated) return false;
  const scripts = c.launcherScripts || [];
  const wfs: Workflow[] = [...(c.launcherWorkflows || [])];
  scripts.forEach((s, i) => {
    const id = `migrated-${i}-${Date.now().toString(36)}`;
    const trig: WorkflowNode = {
      id: "n1", type: "trigger.keyword", x: 60, y: 140,
      config: { keyword: s.keyword || s.name, arg: s.needsInput ? "optional" : "none", title: s.name },
    };
    const act: WorkflowNode = {
      id: "n2", type: "action.script", x: 340, y: 140,
      config: { script: s.command, output: s.output || "copy" },
    };
    wfs.push({
      id, name: s.name, icon: s.icon || "📜", enabled: true, variables: {},
      nodes: [trig, act], connections: [{ from: "n1", to: "n2", mod: "" }],
    });
  });
  cfg.save({ launcherWorkflows: wfs, launcherScriptsMigrated: true });
  return true;
}

// 迁移 V2：文件夹书签 → Keyword+Open File 工作流（幂等）。
export function migrateFolders(cfg: ConfigStore): boolean {
  const c = cfg.get();
  if (c.launcherMigratedV2) return false;
  const wfs: Workflow[] = [...(c.launcherWorkflows || [])];
  // 文件夹书签
  (c.launcherFolders || []).forEach((f, i) => {
    const name = f.name || f.path.split("/").pop() || f.path;
    wfs.push({
      id: `folder-${i}-${Date.now().toString(36)}`, name, icon: "📁", enabled: true, variables: {},
      nodes: [
        { id: "n1", type: "trigger.keyword", x: 60, y: 140, config: { keyword: name, arg: "none", title: name } },
        { id: "n2", type: "action.openfile", x: 340, y: 140, config: { path: f.path, app: f.app || "" } },
      ],
      connections: [{ from: "n1", to: "n2", mod: "" }],
    });
  });
  cfg.save({ launcherWorkflows: wfs, launcherMigratedV2: true });
  return true;
}

// 种子：把内置工具（编解码/计算/换算）作为默认工作流写入（用户可编辑/删除）。幂等。
export function seedBuiltinTools(cfg: ConfigStore): boolean {
  const c = cfg.get();
  if (c.launcherToolsSeeded) return false;
  const wfs: Workflow[] = [...(c.launcherWorkflows || [])];
  const kw = (id: string, name: string, icon: string, keyword: string, inputType: string, mode?: string): Workflow => ({
    id: `builtin-${id}-${Date.now().toString(36)}`, name, icon, enabled: true, variables: {},
    nodes: [
      { id: "n1", type: "trigger.keyword", x: 60, y: 140, config: { keyword, arg: "required", title: name } },
      { id: "n2", type: inputType, x: 340, y: 140, config: mode ? { mode } : {} },
    ],
    connections: [{ from: "n1", to: "n2", mod: "" }],
  });
  const always = (id: string, name: string, icon: string, inputType: string): Workflow => ({
    id: `builtin-${id}-${Date.now().toString(36)}`, name, icon, enabled: true, variables: {},
    nodes: [
      { id: "n1", type: "trigger.always", x: 60, y: 140, config: {} },
      { id: "n2", type: inputType, x: 340, y: 140, config: {} },
    ],
    connections: [{ from: "n1", to: "n2", mod: "" }],
  });
  wfs.push(
    kw("uni", "Unicode 编解码", "🔡", "uni", "input.codec", "unicode"),
    kw("url", "URL 编解码", "🔗", "url", "input.codec", "url"),
    kw("b64", "Base64 编解码", "🔠", "b64", "input.codec", "base64"),
    always("calc", "计算器", "🔢", "input.calc"),
    always("units", "单位换算", "📐", "input.units"),
  );
  cfg.save({ launcherWorkflows: wfs, launcherToolsSeeded: true });
  return true;
}
