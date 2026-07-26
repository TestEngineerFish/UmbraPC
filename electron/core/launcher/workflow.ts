// 工作流执行引擎（类 Alfred Workflow）。
// 触发(Keyword/Hotkey) → 输入(Script Filter，跑脚本解析 Alfred JSON) → 修饰键分支 → 动作链(Action)。
// 与内置 provider 结果并存：本引擎只产出/执行「工作流」结果，LauncherManager 负责合并与分发。
import * as crypto from "node:crypto";
import { ConfigStore, expandHome, httpBase, Workflow, WorkflowNode } from "../config";
import { run } from "../shared/util";
import { simulatePaste, simulateCopy } from "../clipboard/paste";
import { readClipboardFiles } from "../clipboard/watcher";
import { calc, convertUnits, unicodeTransform, urlTransform, base64Transform } from "./tools";
import { TraceRecorder } from "./trace";
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

  // 占位替换：{query}→arg，{var:name}→变量。
  private subst(tpl: string, arg: string, vars: Record<string, string>): string {
    return (tpl || "")
      .replace(/\{query\}/g, arg)
      .replace(/\{var:([^}]+)\}/g, (_m, k) => vars[String(k).trim()] ?? "");
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
      case "input.translate": return this.runTranslate(wf, node, arg);
      case "input.codec": return this.runCodec(wf, node, arg);
      case "input.calc": return this.runCompute(wf, node, arg, "calc");
      case "input.units": return this.runCompute(wf, node, arg, "units");
      default: return null;
    }
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
    const cwd = node.config.cwd ? expandHome(String(node.config.cwd)) : undefined;
    const env: Record<string, string> = {};
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
    cwd: string | undefined, env: Record<string, string>, vars: Record<string, string>, key: string,
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

  // 内置输入节点：有道翻译（读工作流变量 youdaoAppKey/youdaoSecret，回退到全局配置）。
  private async runTranslate(wf: Workflow, node: WorkflowNode, arg: string): Promise<LauncherResult[]> {
    const v = this.baseVars(wf);
    const cfg = this.cfg.get();
    const appKey = v.youdaoAppKey || cfg.youdaoAppKey;
    const secret = v.youdaoSecret || cfg.youdaoSecret;
    const text = (arg || "").trim();
    if (!appKey || !secret) return [this.errResult(wf.name, "未配置有道 appKey/secret（在工作流变量里填）")];
    if (!text) return [];
    const q = text.replace(/([A-Z])/g, " $1").toLowerCase().trim();
    const isZh = /^[一-龥]+$/.test(q);
    const from = isZh ? "zh-CHS" : "auto";
    const to = isZh ? "en" : "zh-CHS";
    const salt = String(Math.floor(Math.random() * 1e5));
    const sign = crypto.createHash("md5").update(appKey + q + salt + secret, "utf8").digest("hex");
    const url = "https://openapi.youdao.com/api?" + new URLSearchParams({ q, from, to, appKey, salt, sign }).toString();
    try {
      const resp = await fetch(url);
      const data = await resp.json() as { errorCode?: string; translation?: string[]; basic?: { explains?: string[] }; web?: { key: string; value: string[] }[] };
      if (data.errorCode !== "0") return [this.errResult(wf.name, `有道错误码：${data.errorCode}`)];
      const out: LauncherResult[] = [];
      const push = (title: string, sub: string) => out.push(this.itemResult(wf, node.id, { title, subtitle: sub, arg: title }, []));
      if (data.translation?.length) push(data.translation[0], `翻译：${text} · 回车复制`);
      data.basic?.explains?.forEach((e) => push(e, "释义 · 回车复制"));
      data.web?.slice(0, 2).forEach((w) => push(w.value.join(", "), `${w.key} · 回车复制`));
      return out.length ? out : [this.errResult(wf.name, "没有更多释义")];
    } catch (e) {
      return [this.errResult(wf.name, `翻译请求失败：${String(e).slice(0, 40)}`)];
    }
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
  private async runNode(wf: Workflow, nodeId: string, arg: string, varsIn: Record<string, string>, visited: Set<string>, tr: TraceRun | null = null): Promise<string> {
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
        const r = await this.runNode(wf, c.to, arg, vars, visited, tr);
        if (r) fb = r;
      }
      return fb;
    }
    const { clipboard, Notification } = await import("electron");
    let feedback = "";
    let outArg = arg;   // 默认把 arg 原样传给下游
    let outPort = "";   // 从哪个出口往下继续（多出口节点会改写：conditional 的 r0/else、脚本失败的 error）
    let stop = false;   // 是否就此终止本条链路（不再往下游传）
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
        const cwd = node.config.cwd ? expandHome(String(node.config.cwd)) : undefined;
        const env: Record<string, string> = {};
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
    }
    } catch (e) {
      // 节点内部抛异常：先把这一步记进轨迹（否则调试抽屉里只会看到「跑到一半没了」），再原样抛出。
      this.trace.stepEnd(step, startedAt, { outArg: arg, error: String(e), stdout, stderr, exitCode });
      throw e;
    }
    this.trace.stepEnd(step, startedAt, { outArg, outPort, feedback, stopped: stop, stdout, stderr, exitCode });
    if (stop) return feedback;   // 链路被节点主动终止（脚本失败、远程调用失败等）
    // 传给 outPort 出口上的所有下游（回车分支）——链式/扇出都把 arg 与变量继续传递。
    for (const c of this.outConns(wf, nodeId, "", outPort)) {
      const fb = await this.runNode(wf, c.to, outArg, vars, visited, tr);
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
      const resp = await fetch(`${httpBase(c)}/web/message`, {
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
      const resp = await fetch(`${httpBase(c)}/devices/all`, { headers, signal: AbortSignal.timeout(15000) });
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
      const resp = await fetch(`${httpBase(c)}/devices/${encodeURIComponent(deviceId)}/dispatch`, {
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
      const resp = await fetch(`${httpBase(c)}/inspirations`, { method: "POST", headers, body: JSON.stringify({ raw: t }) });
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

// 迁移 V2：文件夹书签 → Keyword+Open File 工作流；有道密钥 → Keyword(fy)+有道翻译 工作流（幂等）。
export function migrateFoldersAndYoudao(cfg: ConfigStore): boolean {
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
  // 有道翻译（有密钥才建）
  if (c.youdaoAppKey && c.youdaoSecret) {
    wfs.push({
      id: `youdao-${Date.now().toString(36)}`, name: "有道翻译", icon: "🌐", enabled: true,
      variables: { youdaoAppKey: c.youdaoAppKey, youdaoSecret: c.youdaoSecret },
      nodes: [
        { id: "n1", type: "trigger.keyword", x: 60, y: 140, config: { keyword: "fy", arg: "required", title: "有道翻译" } },
        { id: "n2", type: "input.translate", x: 340, y: 140, config: {} },
      ],
      connections: [{ from: "n1", to: "n2", mod: "" }],
    });
  }
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
