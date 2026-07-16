// 实时聊天：连接 /ws/chat，按现有协议驱动设计稿里的聊天组件
// （流式回复、工具轨迹、任务进度卡、执行前确认、完成通知、图片预览、跨端同步）。
//
// 微信式三栏（Phase 3）：
//   左：联系人列表 —— 秘书 + 所有已知设备（在线绿点 / 离线灰点、最后一条消息、未读点）
//   中：聊天详情   —— 会话消息 + 输入框（设备会话可直接发送，服务端会把「目标设备=这台」注入上下文）
//   右：设备详情   —— 点标题栏 ⓘ 展开：平台 / 在线状态 / 最后在线 / 设备 ID / 能力目录（程序→技能）
//
// 会话 id：'assistant' = 你↔秘书；'device:<id>' = 与某台设备（含它的编排流）。
import {
  chatConn,
  fetchHistory,
  fetchConversations,
  fetchAllDevices,
  forgetDevice,
  clearHistory,
  getServerUrl,
  getAutoApproveOperate,
  setAutoApproveOperate,
  type KnownDevice,
} from "../../services/server";
import { getDesktopConfig } from "../../services/desktop";
import { mdToHtml } from "./markdown";
import { t } from "../../i18n";

type Block =
  | { kind: "user"; text: string; ts?: string | number }
  | { kind: "assistant"; thinking: boolean; streaming: boolean; text: string; trace: string[]; traceOpen: boolean; ts?: string | number }
  | { kind: "device"; text: string; ts?: string | number }
  | { kind: "job"; jobId: string; goal: string; pct: number; status: string; message: string; agentState?: string; confirmTaskId?: string; confirmScope?: string; results?: { title: string; url: string }[] }
  | { kind: "done"; goal: string; results: { title: string; url: string }[] }
  | { kind: "confirm"; taskId: string; summary: string; detail?: unknown; scope?: string; resolved?: "approved" | "denied" }
  // 问答卡：秘书在派活前把歧义问清楚（多题、单选/多选、可自定义、逐题推进、统一提交）。
  | { kind: "question"; cardId: string; title: string; questions: QCard[]; at: number; picked: Record<string, string[]>; custom: Record<string, string>; done?: boolean }
  | { kind: "error"; text: string };

interface QCard {
  id: string;
  text: string;
  multi: boolean;
  options: string[];
  allow_custom: boolean;
}

// 每个会话的独立状态。
interface ConvState {
  blocks: Block[];
  assistantIdx: number | null;
  jobMap: Record<string, number>;
  doneJobs: Set<string>;
  oldestId: number | null;
  hasMore: boolean;
  loaded: boolean; // 首屏历史是否已拉过
  loading: boolean; // 首屏历史加载中
  unread: boolean;
  lastText: string; // 联系人列表的消息预览
  lastAt?: string | number;
}

const MAIN = "assistant";
const PAGE = 20;

const convs: Record<string, ConvState> = {};
let activeConv = MAIN;
// 已知设备（含离线），联系人列表的数据源。
let devices: KnownDevice[] = [];
let detailOpen = false;

let container: HTMLElement | null = null;
let started = false;
let appRerender: (() => void) | null = null;
// 滚动策略：贴底时才跟随新消息，上滑查看历史时不打扰；forceScroll 用于发送/切换/首次加载强制到底。
let stick = true;
let forceScroll = false;
let loadingOlder = false;
// 输入草稿：按会话各存一份，切换联系人不串味。
const drafts: Record<string, string> = {};
// 三态开关（过渡拐杖）：auto=模型判；chat=强制聊天；execution=强制执行。默认 auto。
type ChatMode = "auto" | "chat" | "execution";
let chatMode: ChatMode = "auto";
// 正在清空历史：清空期间禁发消息，避免新消息被服务端的会话重置一起删掉。
let clearing = false;

function newConvState(): ConvState {
  return {
    blocks: [],
    assistantIdx: null,
    jobMap: {},
    doneJobs: new Set<string>(),
    oldestId: null,
    hasMore: false,
    loaded: false,
    loading: false,
    unread: false,
    lastText: "",
  };
}

function cs(id: string): ConvState {
  let s = convs[id];
  if (!s) s = convs[id] = newConvState();
  return s;
}

// 联系人顺序：秘书恒在首位 → 在线设备 → 离线设备（服务端已排好序）。
function contactIds(): string[] {
  return [MAIN, ...devices.map((d) => `device:${d.device_id}`)];
}
function deviceIdOf(conv: string): string {
  return conv.startsWith("device:") ? conv.slice("device:".length) : "";
}
function deviceOf(conv: string): KnownDevice | null {
  const id = deviceIdOf(conv);
  return id ? devices.find((d) => d.device_id === id) || null : null;
}
function convLabel(id: string): string {
  if (id === MAIN) return t("chat.secretary");
  return deviceOf(id)?.device_name || deviceIdOf(id) || id;
}
// 平台 → 头像图标。
function platformIcon(platform?: string): string {
  const p = (platform || "").toLowerCase();
  if (p === "ios" || p === "android") return "📱";
  if (p === "macos" || p === "windows" || p === "linux") return "💻";
  return "🖥️";
}

function rowToBlock(m: { role: string; content: string; created_at?: string }): Block {
  if (m.role === "user") return { kind: "user", text: m.content, ts: m.created_at };
  if (m.role === "device") return { kind: "device", text: m.content, ts: m.created_at };
  return { kind: "assistant", thinking: false, streaming: false, text: m.content, trace: [], traceOpen: false, ts: m.created_at };
}

// IM 风格消息时间：今天→HH:MM，昨天→昨天 HH:MM，今年→M月D日 HH:MM，更早→YYYY年M月D日 HH:MM。
function fmtMsgTime(ts?: string | number): string {
  if (ts == null) return "";
  const d = typeof ts === "number" ? new Date(ts) : new Date(String(ts).includes("T") ? String(ts) : String(ts).replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sod = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((sod(now) - sod(d)) / 86400000);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (days <= 0) return hm;
  if (days === 1) return t("time.yesterdayAt", { time: hm });
  if (d.getFullYear() === now.getFullYear()) return t("time.monthDayAt", { month: d.getMonth() + 1, day: d.getDate(), time: hm });
  return t("time.yearMonthDayAt", { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), time: hm });
}

export function setAppRerender(cb: () => void): void {
  appRerender = cb;
}

const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const isImageUrl = (u: string) =>
  /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(u) || /(chatglm|bigmodel|cogview|aigc)/i.test(u) || /\/files\//.test(u);

function ensureStarted(): void {
  if (started) return;
  started = true;
  chatConn.setHandlers({
    onStatus: () => appRerender?.(),
    onMessage: onMessage,
  });
  chatConn.connect();
  loadConversationsList();
  loadDevices();
  loadConvHistory(MAIN);
  // 设备上下线有 device_presence 实时推送；这里兜底轮询，防止推送漏掉。
  window.setInterval(loadDevices, 30000);
}

// 已知设备（含离线）：联系人列表的数据源。
async function loadDevices(): Promise<void> {
  devices = await fetchAllDevices();
  renderContacts();
  renderHeader();
  if (detailOpen) renderDetail();
}

// 各会话的最后一条消息（联系人列表的预览文案）。
async function loadConversationsList(): Promise<void> {
  const rows = await fetchConversations();
  for (const r of rows) {
    const s = cs(r.conversation);
    if (!s.lastText) {
      s.lastText = r.last_content || "";
      s.lastAt = r.last_at;
    }
  }
  renderContacts();
}

// 拉某会话首屏历史（首次进入时懒加载）。
async function loadConvHistory(id: string): Promise<void> {
  const s = cs(id);
  if (s.loaded || s.loading) return;
  s.loading = true;
  if (id === activeConv) renderMessages();
  const rows = await fetchHistory(PAGE, undefined, id);
  s.loading = false;
  s.loaded = true;
  if (rows.length && s.blocks.length === 0) {
    for (const m of rows) s.blocks.push(rowToBlock(m));
    s.oldestId = rows[0].id;
    s.hasMore = rows.length >= PAGE;
  }
  if (id === activeConv) {
    forceScroll = true;
    renderMessages();
  }
}

// 上拉加载当前会话更早一页历史，并保持当前可视位置不跳动。
async function loadOlder(): Promise<void> {
  const s = cs(activeConv);
  if (loadingOlder || !s.hasMore || s.oldestId == null || !container) return;
  loadingOlder = true;
  const el = container.querySelector("#umsgs") as HTMLElement | null;
  const prevH = el ? el.scrollHeight : 0;
  const prevTop = el ? el.scrollTop : 0;
  const rows = await fetchHistory(PAGE, s.oldestId, activeConv);
  loadingOlder = false;
  if (rows.length === 0) {
    s.hasMore = false;
    return;
  }
  if (rows.length < PAGE) s.hasMore = false;
  s.oldestId = rows[0].id;
  const n = rows.length;
  // 前置插入后，已有块的索引整体右移，需同步 jobMap 与 assistantIdx。
  for (const k of Object.keys(s.jobMap)) s.jobMap[k] += n;
  if (s.assistantIdx != null) s.assistantIdx += n;
  s.blocks = [...rows.map(rowToBlock), ...s.blocks];
  renderMessages(true); // 保留滚动，由下面手动恢复
  if (el) el.scrollTop = prevTop + (el.scrollHeight - prevH);
}

// 推送归属的会话：服务端已给所有事件打上 conversation 标签；缺省视为主会话。
function convOf(msg: any): string {
  const c = msg && typeof msg.conversation === "string" ? msg.conversation : "";
  return c || MAIN;
}

// 已自动批准过的 task，避免重复发送。
const autoApproved = new Set<string>();
// 是否自动批准电脑操作：开了「自动批准」开关，或把核心动作(打开/点击/输入/按键)都设成了「总是允许」。
function operateAutoApprove(): boolean {
  if (getAutoApproveOperate()) return true;
  const pol = getDesktopConfig()?.computerSkillPolicy || {};
  return ["open_app", "click", "type", "key"].every((k) => pol[k] === "allow");
}
// 满足自动批准条件时，收到确认请求就自动批准，不再每次询问。
// 注意：「总是允许」只对**电脑操作(operate)**生效。代理任务(scope=agent)的执行模式授权
// 必须你亲自点——否则一个为了少弹窗打开的开关，会顺手放开所有任务的跑命令/装依赖权限。
function autoApproveIfEnabled(taskId: string | undefined, scope?: string): void {
  if (!taskId || autoApproved.has(taskId) || scope === "agent" || !operateAutoApprove()) return;
  autoApproved.add(taskId);
  chatConn.sendConfirm(taskId, true);
  resolveConfirm(taskId, true);
}

function onMessage(msg: any): void {
  let target = convOf(msg);
  switch (msg.type) {
    case "delta": {
      const a = assistantOf(target);
      if (a) { a.thinking = false; a.text += msg.text || ""; }
      break;
    }
    case "tool_call": {
      const a = assistantOf(target);
      if (a) {
        if (a.text.trim()) { a.trace.push("💭 " + a.text.trim()); a.text = ""; }
        let args = "";
        try { args = JSON.stringify(msg.args || {}); } catch { args = String(msg.args); }
        if (args.length > 120) args = args.slice(0, 120) + "…";
        a.trace.push(`🔧 ${msg.name}(${args})`);
      }
      break;
    }
    case "tool_result": {
      const a = assistantOf(target);
      if (a) {
        let p = String(msg.preview || "").replace(/\s+/g, " ").trim();
        if (p.length > 160) p = p.slice(0, 160) + "…";
        a.trace.push(`↳ ${msg.name} → ${p}`);
      }
      break;
    }
    case "reply": {
      const a = assistantOf(target);
      if (a) { a.thinking = false; a.streaming = false; a.text = msg.text || a.text; }
      cs(target).assistantIdx = null;
      cs(target).lastText = msg.text || "";
      cs(target).lastAt = Date.now();
      break;
    }
    case "job_update":
    case "task_update": // 新任务模型（里程碑进度）：复用进度卡，按 done/total 显示
      target = handleJob(msg);
      break;
    case "device_presence": {
      // 设备上/下线：刷新联系人列表（顺带更新能力目录）。
      loadDevices();
      return;
    }
    case "device_message": {
      // 服务端↔设备的直接交互（非 Job），落到对应设备会话。
      const s = cs(target);
      const ts = msg.created_at || Date.now();
      if (msg.role === "device") s.blocks.push({ kind: "device", text: msg.text || "", ts });
      else s.blocks.push({ kind: "assistant", thinking: false, streaming: false, text: msg.text || "", trace: [], traceOpen: false, ts });
      s.lastText = msg.text || "";
      s.lastAt = ts;
      break;
    }
    case "confirm_request":
      // 执行前授权卡：落在事件所属会话，供用户处理。
      if (msg.task_id) {
        const s = cs(target);
        if (!s.blocks.some((b) => b.kind === "confirm" && b.taskId === msg.task_id)) {
          s.blocks.push({ kind: "confirm", taskId: msg.task_id, summary: msg.summary || t("chat.needConfirm"), detail: msg.detail, scope: msg.scope });
        }
        autoApproveIfEnabled(msg.task_id, msg.scope);
      }
      break;
    case "question_card": {
      const s = cs(target);
      if (!s.blocks.some((b) => b.kind === "question" && b.cardId === msg.card_id)) {
        s.blocks.push({
          kind: "question", cardId: msg.card_id, title: msg.title || "",
          questions: (msg.questions || []) as QCard[],
          at: 0, picked: {}, custom: {},
        });
        s.lastText = msg.title || "有几个问题要确认";
        s.lastAt = Date.now();
      }
      break;
    }
    case "question_resolved": {
      // 别的端已经答过了 → 本端把卡片标成已完成，别重复作答。
      for (const id of Object.keys(convs)) {
        for (const b of convs[id].blocks) {
          if (b.kind === "question" && b.cardId === msg.card_id) b.done = true;
        }
      }
      renderMessages();
      return;
    }
    case "confirm_resolved":
      resolveConfirm(msg.task_id || "", Boolean(msg.approved)); // 跨会话统一更新
      renderMessages();
      return;
    case "history_cleared": {
      // 其它端清空了某个会话 → 本端同步清空。
      const s = cs(target);
      s.blocks = []; s.assistantIdx = null; s.jobMap = {}; s.doneJobs.clear();
      s.oldestId = null; s.hasMore = false; s.lastText = "";
      if (target === activeConv) renderMessages();
      renderContacts();
      return;
    }
    case "chat_message": {
      // 其它端发出的消息（跨端同步）。
      const s = cs(target);
      const ts = Date.now();
      if (msg.role === "user") s.blocks.push({ kind: "user", text: msg.text || "", ts });
      else s.blocks.push({ kind: "assistant", thinking: false, streaming: false, text: msg.text || "", trace: [], traceOpen: false, ts });
      s.lastText = msg.text || "";
      s.lastAt = ts;
      break;
    }
    case "error": {
      const s = cs(target);
      if (s.assistantIdx !== null) { const a = assistantOf(target); if (a) { a.thinking = false; a.streaming = false; } s.assistantIdx = null; }
      s.blocks.push({ kind: "error", text: msg.message || t("chat.error") });
      break;
    }
    default:
      return;
  }
  // 目标会话不是当前查看的 → 标记未读；否则刷新消息区。
  if (target !== activeConv) cs(target).unread = true;
  else renderMessages();
  renderContacts();
}

function assistantOf(conv: string): Extract<Block, { kind: "assistant" }> | null {
  const s = cs(conv);
  if (s.assistantIdx === null) return null;
  const b = s.blocks[s.assistantIdx];
  return b && b.kind === "assistant" ? b : null;
}

// 返回该 job_update/task_update 归属的会话 id（供 onMessage 决定是否刷新/标未读）。
function handleJob(msg: any): string {
  const id = msg.job_id || msg.task_id; // 兼容旧 job_update 与新 task_update
  const conv = convOf(msg);
  if (!id) return conv;
  const s = cs(conv);
  const overall = typeof msg.overall === "number" ? msg.overall : msg.status === "done" ? 1 : 0;
  const pct = Math.max(0, Math.min(100, Math.round(overall * 100)));
  // 新任务：进度按里程碑 done/total，消息尾部标一下。
  const milestone = typeof msg.steps_total === "number" && msg.steps_total > 0
    ? `（${msg.steps_done || 0}/${msg.steps_total} 里程碑）` : "";
  let idx = s.jobMap[id];
  if (idx === undefined) {
    s.blocks.push({ kind: "job", jobId: id, goal: msg.goal || t("chat.task"), pct, status: msg.status || "running", message: (msg.message || "") + milestone });
    idx = s.blocks.length - 1;
    s.jobMap[id] = idx;
  }
  const b = s.blocks[idx];
  if (b.kind !== "job") return conv;
  b.pct = pct;
  b.status = msg.status || b.status;
  b.message = (msg.message || b.message) + (msg.message ? milestone : "");
  if (msg.agent_state) b.agentState = msg.agent_state;
  if (msg.goal) b.goal = msg.goal;
  b.confirmTaskId = msg.event === "confirm" && msg.needs_confirm ? msg.confirm_task_id : undefined;
  b.confirmScope = msg.scope;
  if (b.confirmTaskId) autoApproveIfEnabled(b.confirmTaskId, b.confirmScope);
  if (msg.results) b.results = msg.results;
  if (msg.status === "done" && !s.doneJobs.has(id)) {
    s.doneJobs.add(id);
    s.blocks.push({ kind: "done", goal: b.goal, results: msg.results || b.results || [] });
  }
  s.lastText = b.message || b.goal;
  s.lastAt = Date.now();
  return conv;
}

// ── 渲染 ────────────────────────────────────────────────────────────────────
function imageHtml(url: string): string {
  return `<img data-img="${esc(url)}" src="${esc(url)}" alt="${esc(t("chat.imageAlt"))}" style="display:block;margin-top:8px;max-width:320px;max-height:320px;border-radius:8px;border:1px solid var(--border);cursor:zoom-in;" onerror="this.remove()">`;
}
// 秘书回复按 Markdown 渲染（AI 输出经常是 md 格式，纯文本很难读）；
// mdToHtml 内部先整体转义再转换，注入的 HTML 只会当普通文字显示。
// 图片链接仍沿用旧逻辑：扫原文里的图片 URL，气泡尾部追加预览图。
function assistantBody(text: string): string {
  let html = mdToHtml(text);
  const urls = (text || "").match(/https?:\/\/[^\s)]+/g) || [];
  for (const u of urls) if (isImageUrl(u)) html += imageHtml(u);
  return html;
}

const dots = `<span style="display:inline-flex;gap:4px;align-items:center;"><span style="width:7px;height:7px;border-radius:999px;background:var(--muted);animation:umbob 1.2s infinite;"></span><span style="width:7px;height:7px;border-radius:999px;background:var(--muted);animation:umbob 1.2s infinite .2s;"></span><span style="width:7px;height:7px;border-radius:999px;background:var(--muted);animation:umbob 1.2s infinite .4s;"></span></span>`;

const timeLine = (ts: string | number | undefined, align: "flex-start" | "flex-end") => {
  const s = fmtMsgTime(ts);
  return s ? `<div style="align-self:${align};font-size:10.5px;color:var(--muted);padding:0 4px;">${s}</div>` : "";
};

// 授权卡按钮：批准 / 总是允许 / 拒绝。「总是允许」= 打开自动批准 + 批准本次。
function confirmButtons(taskId: string, scope?: string): string {
  const tid = esc(taskId);
  // scope=agent：授权只在这个任务内有效（端侧只问一次），因此不提供「总是允许(全局)」。
  const always = scope === "agent"
    ? ""
    : `<button data-approve-always="${tid}" style="padding:7px 15px;background:var(--orange-soft);color:var(--orange-text);border:1px solid var(--orange);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">${esc(t("chat.approveAlways"))}</button>`;
  return `<div style="display:flex;gap:9px;margin-top:11px;flex-wrap:wrap;">`
    + `<button data-approve="${tid}" style="padding:7px 15px;background:var(--orange);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">${esc(t("chat.approve"))}</button>`
    + always
    + `<button data-deny="${tid}" style="padding:7px 15px;background:transparent;color:var(--danger);border:1px solid var(--danger);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">${esc(t("chat.reject"))}</button>`
    + `</div>`;
}

function blockHtml(b: Block, i: number): string {
  if (b.kind === "user")
    return `<div style="align-self:flex-end;max-width:78%;background:var(--user-bubble);padding:11px 14px;border-radius:14px 14px 4px 14px;line-height:1.55;white-space:pre-wrap;">${esc(b.text)}</div>${timeLine(b.ts, "flex-end")}`;

  if (b.kind === "device") {
    // 设备上报（服务端↔设备编排流里的“设备”一侧）：靠左、描边气泡区分秘书。
    return `<div style="align-self:flex-start;max-width:78%;background:var(--track);border:1px dashed var(--border);padding:11px 14px;border-radius:14px 14px 14px 4px;line-height:1.55;white-space:pre-wrap;">${esc(b.text)}</div>${timeLine(b.ts, "flex-start")}`;
  }

  if (b.kind === "assistant") {
    const trace = b.trace.length
      ? `<div style="align-self:flex-start;max-width:80%;width:100%;">
          <div data-trace="${i}" style="display:flex;align-items:center;gap:7px;cursor:pointer;color:var(--muted);font-size:12px;margin-bottom:6px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="transition:transform .15s;transform:rotate(${b.traceOpen ? 90 : 0}deg);"><path d="M9 6l6 6-6 6"></path></svg>${esc(t("chat.toolTrace", { count: b.trace.length }))}</div>
          ${b.traceOpen ? `<div style="background:var(--track);border:1px solid var(--border);border-radius:8px;padding:9px 11px;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:11.5px;line-height:1.85;color:var(--muted);">${b.trace.map((t) => `<div>${esc(t)}</div>`).join("")}</div>` : ""}
        </div>`
      : "";
    // 注意：这里不能用 white-space:pre-wrap —— Markdown 渲染已把换行转成块/段落/<br>，
    // 再 pre-wrap 会把 md 源码里的换行重复显示成大片空白。
    const bubble = `<div style="align-self:flex-start;max-width:80%;background:var(--card);border:1px solid var(--border);padding:11px 14px;border-radius:14px 14px 14px 4px;line-height:1.6;min-height:20px;overflow-wrap:break-word;">${b.thinking ? dots : ""}${assistantBody(b.text)}${b.streaming && b.text ? `<span style="display:inline-block;width:2px;height:15px;background:var(--orange);vertical-align:-2px;margin-left:1px;animation:umblink 1s steps(1) infinite;"></span>` : ""}</div>`;
    return trace + bubble + (b.streaming ? "" : timeLine(b.ts, "flex-start"));
  }

  if (b.kind === "job") {
    // 代理任务干完一轮会停在 idle —— 那不是「90%」，那是**待确认**（等你说改还是收工）。
    const awaiting = b.agentState === "idle" && b.status !== "done" && b.status !== "failed";
    const color = b.status === "done" ? "var(--success)" : b.status === "failed" ? "var(--danger)" : "var(--orange)";
    const confirm = b.confirmTaskId ? confirmButtons(b.confirmTaskId, b.confirmScope) : "";
    const tag = awaiting
      ? `<span style="font-size:11.5px;color:var(--orange-text);font-weight:600;background:var(--orange-soft);border:1px solid var(--orange);border-radius:999px;padding:1px 8px;">${esc(t("chat.awaitingReview"))}</span>`
      : `<span style="font-size:12px;color:var(--orange-text);font-weight:600;">${b.pct}%</span>`;
    // 长摘要（agent 的输出动辄几百字）限高可滚，别撑破卡片。
    return `<div style="align-self:flex-start;max-width:80%;width:100%;background:var(--card);border:1px solid var(--border);border-left:3px solid ${color};border-radius:10px;padding:13px 15px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px;"><span style="font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(b.goal)}</span>${tag}</div>
        <div style="height:6px;border-radius:999px;background:var(--track);overflow:hidden;margin-bottom:8px;"><div style="height:100%;width:${b.pct}%;background:${color};border-radius:999px;"></div></div>
        <div style="font-size:12.5px;color:var(--muted);display:flex;align-items:flex-start;gap:6px;max-height:150px;overflow-y:auto;"><span style="flex:none;width:6px;height:6px;border-radius:999px;background:${color};margin-top:6px;"></span><span style="flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;">${esc(b.message)}</span></div>
        ${confirm}
      </div>`;
  }

  if (b.kind === "done") {
    const links = (b.results || [])
      .map((r) => {
        const img = isImageUrl(r.url) ? imageHtml(r.url) : "";
        return `${img}<div style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:5px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"></path></svg><a href="${esc(r.url)}" target="_blank" rel="noopener" style="color:var(--orange-text);text-decoration:none;font-weight:500;">${esc(r.title)}</a></div>`;
      })
      .join("");
    return `<div style="align-self:flex-start;max-width:80%;background:var(--success-soft);border:1px solid var(--success);border-left:3px solid var(--success);border-radius:10px;padding:13px 15px;"><div style="font-weight:600;color:var(--success);margin-bottom:7px;">🎉 ${esc(t("chat.done"))}：${esc(b.goal)}</div>${links}</div>`;
  }

  if (b.kind === "confirm") {
    const detail = b.detail != null ? (typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail)) : "";
    const foot = b.resolved
      ? `<div style="font-size:12.5px;font-weight:600;margin-top:9px;color:${b.resolved === "approved" ? "var(--success)" : "var(--danger)"};">${b.resolved === "approved" ? `✅ ${esc(t("chat.approved"))}` : `🚫 ${esc(t("chat.denied"))}`}</div>`
      : confirmButtons(b.taskId, b.scope);
    return `<div style="align-self:flex-start;max-width:80%;width:100%;background:var(--orange-soft);border:1px solid var(--orange);border-radius:10px;padding:13px 15px;">
        <div style="font-weight:600;color:var(--orange-text);margin-bottom:6px;display:flex;align-items:center;gap:7px;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"></path><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>${esc(t("chat.needConfirm"))}</div>
        <div style="font-size:13px;line-height:1.55;color:var(--text);">${esc(b.summary)}</div>
        ${detail ? `<div style="font-size:11.5px;color:var(--muted);margin-top:6px;font-family:ui-monospace,Menlo,monospace;word-break:break-all;">${esc(detail)}</div>` : ""}
        ${foot}
      </div>`;
  }

  if (b.kind === "question") return questionCardHtml(b, i);

  return `<div style="align-self:flex-start;max-width:80%;border:1px solid rgba(180,35,24,.3);background:var(--danger-soft);color:var(--danger);padding:11px 14px;border-radius:10px;">${esc(b.text)}</div>`;
}

// 问答卡：一次一题（可回上一题改），全部答完统一提交。
// 为什么要这个：歧义必须在派活**之前**消除——「写个棋牌小程序」是微信还是支付宝？
// 带着歧义开工，返工的代价远大于问一句。
function questionCardHtml(b: Extract<Block, { kind: "question" }>, i: number): string {
  const total = b.questions.length;
  if (b.done) {
    return `<div style="align-self:flex-start;max-width:80%;width:100%;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:13px 15px;">
      <div style="font-weight:600;margin-bottom:6px;">${esc(b.title)}</div>
      <div style="font-size:12.5px;color:var(--success);">✅ ${esc(t("chat.questionSubmitted"))}</div>
    </div>`;
  }
  const q = b.questions[Math.min(b.at, total - 1)];
  if (!q) return "";
  const sel = b.picked[q.id] || [];
  const opts = q.options
    .map((o) => {
      const on = sel.includes(o);
      return `<button data-qopt="${i}" data-val="${esc(o)}" style="display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:9px 12px;margin-bottom:6px;border-radius:9px;cursor:pointer;font-size:13px;border:1px solid ${on ? "var(--orange)" : "var(--border)"};background:${on ? "var(--orange-soft)" : "var(--bg)"};color:${on ? "var(--orange-text)" : "var(--text)"};">
        <span style="flex:none;width:14px;height:14px;border-radius:${q.multi ? "4px" : "999px"};border:1.5px solid ${on ? "var(--orange)" : "var(--border)"};background:${on ? "var(--orange)" : "transparent"};"></span>${esc(o)}
      </button>`;
    })
    .join("");
  const custom = q.allow_custom || q.options.length === 0
    ? `<input data-qcustom="${i}" value="${esc(b.custom[q.id] || "")}" placeholder="${esc(q.options.length ? t("chat.questionCustom") : t("chat.questionAnswer"))}" style="width:100%;box-sizing:border-box;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:9px;padding:9px 12px;font-size:13px;outline:none;" />`
    : "";
  const last = b.at >= total - 1;
  const answered = sel.length > 0 || (b.custom[q.id] || "").trim().length > 0;
  return `<div style="align-self:flex-start;max-width:80%;width:100%;background:var(--card);border:1px solid var(--orange);border-radius:10px;padding:13px 15px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">
        <span style="font-weight:600;">${esc(b.title)}</span>
        <span style="flex:none;font-size:11.5px;color:var(--muted);">${b.at + 1} / ${total}</span>
      </div>
      <div style="font-size:13.5px;margin:10px 0 9px;">${esc(q.text)}${q.multi ? `<span style="font-size:11px;color:var(--muted);margin-left:6px;">${esc(t("chat.questionMulti"))}</span>` : ""}</div>
      ${opts}
      ${custom}
      <div style="display:flex;gap:8px;margin-top:11px;">
        ${b.at > 0 ? `<button data-qprev="${i}" style="padding:7px 14px;border:1px solid var(--border);background:transparent;color:var(--text);border-radius:8px;font-size:13px;cursor:pointer;">${esc(t("chat.questionPrev"))}</button>` : ""}
        <span style="flex:1;"></span>
        <button data-${last ? "qsubmit" : "qnext"}="${i}" ${answered ? "" : "disabled"} style="padding:7px 16px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:${answered ? "pointer" : "not-allowed"};background:${answered ? "var(--orange)" : "var(--border)"};color:#fff;">${esc(last ? t("chat.questionSubmit") : t("chat.questionNext"))}</button>
      </div>
    </div>`;
}

// ── 左栏：联系人列表 ─────────────────────────────────────────────────────────
function avatarHtml(conv: string, size = 40): string {
  const fs = Math.round(size * 0.5);
  if (conv === MAIN) {
    return `<span style="flex:none;width:${size}px;height:${size}px;border-radius:10px;background:var(--orange);color:#fff;font-weight:700;font-size:${fs}px;display:flex;align-items:center;justify-content:center;">U</span>`;
  }
  const d = deviceOf(conv);
  const dim = d && !d.online ? "filter:grayscale(1);opacity:.55;" : "";
  return `<span style="flex:none;width:${size}px;height:${size}px;border-radius:10px;background:var(--track);border:1px solid var(--border);font-size:${fs}px;display:flex;align-items:center;justify-content:center;${dim}">${platformIcon(d?.platform)}</span>`;
}

function presenceDot(conv: string): string {
  if (conv === MAIN) return "";
  const d = deviceOf(conv);
  const on = !!d?.online;
  const color = on ? "var(--success)" : "var(--muted)";
  return `<span title="${esc(on ? t("chat.online") : t("chat.offline"))}" style="flex:none;width:8px;height:8px;border-radius:999px;background:${color};box-shadow:0 0 0 2px var(--card);"></span>`;
}

function renderContacts(): void {
  if (!container) return;
  const el = container.querySelector("#ucontacts") as HTMLElement | null;
  if (!el) return;
  el.innerHTML = contactIds()
    .map((id) => {
      const s = convs[id];
      const on = id === activeConv;
      const preview = (s?.lastText || "").replace(/\s+/g, " ").slice(0, 40);
      const time = s?.lastAt ? fmtMsgTime(s.lastAt) : "";
      const unread = s?.unread && !on ? `<span style="flex:none;width:8px;height:8px;border-radius:999px;background:var(--orange);"></span>` : "";
      return `<button data-conv="${esc(id)}" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 12px;border:none;border-radius:9px;cursor:pointer;background:${on ? "var(--orange-soft)" : "transparent"};color:var(--text);">
        <span style="position:relative;display:flex;">${avatarHtml(id)}<span style="position:absolute;right:-2px;bottom:-2px;">${presenceDot(id)}</span></span>
        <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;">
          <span style="display:flex;align-items:center;gap:6px;">
            <span style="flex:1;min-width:0;font-size:13.5px;font-weight:${on ? 600 : 500};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(convLabel(id))}</span>
            <span style="flex:none;font-size:10.5px;color:var(--muted);">${esc(time)}</span>
          </span>
          <span style="display:flex;align-items:center;gap:6px;">
            <span style="flex:1;min-width:0;font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(preview || (id === MAIN ? t("chat.secretaryDesc") : t("chat.devicePreviewEmpty")))}</span>
            ${unread}
          </span>
        </span>
      </button>`;
    })
    .join("");
}

// ── 中栏标题栏 ──────────────────────────────────────────────────────────────
function renderHeader(): void {
  if (!container) return;
  const el = container.querySelector("#uchathead") as HTMLElement | null;
  if (!el) return;
  const d = deviceOf(activeConv);
  const sub =
    activeConv === MAIN
      ? t("chat.secretaryDesc")
      : d
        ? d.online
          ? t("chat.online")
          : d.last_seen
            ? t("chat.lastSeenAt", { time: fmtMsgTime(d.last_seen) })
            : t("chat.offline")
        : t("chat.offline");
  const info =
    activeConv === MAIN
      ? ""
      : `<button id="udetailbtn" title="${esc(t("chat.deviceDetail"))}" style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid ${detailOpen ? "var(--orange)" : "var(--border)"};background:${detailOpen ? "var(--orange-soft)" : "var(--card)"};color:${detailOpen ? "var(--orange-text)" : "var(--text)"};border-radius:8px;cursor:pointer;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 16v-4M12 8h.01"></path></svg></button>`;
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;min-width:0;">
      ${avatarHtml(activeConv, 32)}
      <div style="min-width:0;">
        <div style="font-size:14.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(convLabel(activeConv))}</div>
        <div style="font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:5px;">${presenceDot(activeConv)}${esc(sub)}</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex:none;">
      ${info}
      <button id="clearhist" style="display:flex;align-items:center;gap:6px;padding:6px 13px;border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:8px;font-size:13px;cursor:pointer;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"></path></svg>${esc(t("chat.clearHistory"))}</button>
    </div>`;
  el.querySelector("#clearhist")?.addEventListener("click", clearActiveHistory);
  el.querySelector("#udetailbtn")?.addEventListener("click", () => {
    detailOpen = !detailOpen;
    renderHeader();
    renderDetail();
  });
}

// ── 右栏：设备详情（能力目录）────────────────────────────────────────────────
function renderDetail(): void {
  if (!container) return;
  const el = container.querySelector("#udetail") as HTMLElement | null;
  if (!el) return;
  const d = deviceOf(activeConv);
  if (!detailOpen || activeConv === MAIN || !d) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }
  el.style.display = "block";
  const provs = d.providers || [];
  const caps = provs.length
    ? provs
        .map((m) => {
          const avail = m.available !== false;
          const skills = m.skills || [];
          return `<div style="border:1px solid var(--border);border-radius:9px;padding:10px 12px;background:var(--card);">
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="width:6px;height:6px;border-radius:999px;background:${avail ? "var(--success)" : "var(--muted)"};"></span>
              <span style="font-size:13px;font-weight:600;">${esc(m.display_name || m.provider)}</span>
              ${m.version ? `<span style="font-size:10.5px;color:var(--muted);">v${esc(m.version)}</span>` : ""}
            </div>
            ${!avail && m.unavailable_reason ? `<div style="font-size:11px;color:var(--muted);margin-top:4px;">${esc(m.unavailable_reason)}</div>` : ""}
            ${skills.length
              ? `<div style="margin-top:7px;display:flex;flex-direction:column;gap:4px;">${skills
                  .map((s) => `<div style="font-size:11.5px;color:var(--muted);"><span style="font-family:ui-monospace,Menlo,monospace;color:var(--text);">${esc(s.name)}</span>${s.description ? ` · ${esc(s.description)}` : ""}</div>`)
                  .join("")}</div>`
              : ""}
          </div>`;
        })
        .join("")
    : `<div style="font-size:12.5px;color:var(--muted);">${esc(t("chat.noCapabilities"))}</div>`;

  el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px;padding:18px 16px;">
      <div style="display:flex;flex-direction:column;align-items:center;gap:8px;">
        ${avatarHtml(activeConv, 56)}
        <div style="font-size:15px;font-weight:600;">${esc(d.device_name)}</div>
        <div style="font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:5px;">${presenceDot(activeConv)}${esc(d.online ? t("chat.online") : d.last_seen ? t("chat.lastSeenAt", { time: fmtMsgTime(d.last_seen) }) : t("chat.offline"))}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
        <div style="display:flex;justify-content:space-between;gap:8px;"><span style="color:var(--muted);">${esc(t("chat.platform"))}</span><span>${esc(d.platform || "-")}</span></div>
        <div style="display:flex;justify-content:space-between;gap:8px;"><span style="flex:none;color:var(--muted);">${esc(t("chat.deviceId"))}</span><span style="font-family:ui-monospace,Menlo,monospace;font-size:11px;word-break:break-all;text-align:right;">${esc(d.device_id)}</span></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <div style="font-size:12px;font-weight:600;color:var(--muted);">${esc(t("chat.capabilities"))}</div>
        ${caps}
      </div>
      ${!d.online ? `<button id="uforget" style="margin-top:4px;padding:7px 12px;border:1px solid var(--danger);background:transparent;color:var(--danger);border-radius:8px;font-size:12.5px;cursor:pointer;">${esc(t("chat.forgetDevice"))}</button>` : ""}
    </div>`;

  el.querySelector("#uforget")?.addEventListener("click", async () => {
    if (!window.confirm(t("chat.forgetConfirm", { name: d.device_name }))) return;
    if (await forgetDevice(d.device_id)) {
      detailOpen = false;
      if (activeConv === `device:${d.device_id}`) switchConv(MAIN);
      await loadDevices();
      renderDetail();
    }
  });
}

function renderMessages(preserve = false): void {
  if (!container) return;
  const el = container.querySelector("#umsgs") as HTMLElement | null;
  if (!el) return;
  const s = cs(activeConv);
  const prevTop = el.scrollTop;
  if (s.blocks.length === 0) {
    const emptyHint = activeConv === MAIN ? t("chat.emptyHint") : t("chat.deviceEmptyHint", { name: convLabel(activeConv) });
    el.innerHTML = s.loading
      ? `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);gap:9px;min-height:300px;font-size:14px;">${dots}<span>${esc(t("common.loading"))}</span></div>`
      : `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--muted);gap:10px;min-height:300px;">${avatarHtml(activeConv, 46)}<span style="font-size:14px;text-align:center;max-width:280px;line-height:1.5;">${esc(emptyHint)}</span></div>`;
  } else {
    // 每条消息包一层 flex:none，避免纵向 flex 在内容（高图片）超高时压缩重叠。
    el.innerHTML = s.blocks
      .map((b, i) => `<div style="flex:none;display:flex;flex-direction:column;gap:8px;">${blockHtml(b, i)}</div>`)
      .join("");
  }
  refreshComposer();
  if (preserve) return; // 上拉加载：由调用方手动恢复滚动位置
  if (stick || forceScroll) {
    el.scrollTop = el.scrollHeight;
    forceScroll = false;
  } else {
    el.scrollTop = prevTop;
  }
}

// 输入区：所有会话都可发送；设备会话的占位符点名该设备，离线时给一行提示。
function refreshComposer(): void {
  if (!container) return;
  const wrap = container.querySelector("#ucomposer") as HTMLElement | null;
  if (!wrap) return;
  const d = deviceOf(activeConv);
  const ph = activeConv === MAIN ? t("chat.placeholder") : t("chat.placeholderDevice", { name: convLabel(activeConv) });
  if (!wrap.querySelector("#draft")) {
    wrap.innerHTML = `
      <div id="uoffline"></div>
      <div id="umodebar" style="display:flex;gap:6px;align-items:center;padding:8px 16px 0;"></div>
      <div style="display:flex;gap:10px;align-items:flex-end;padding:10px 16px 12px;">
        <textarea id="draft" rows="2" style="flex:1;resize:none;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:10px;padding:9px 12px;font-size:13.5px;line-height:1.5;font-family:inherit;outline:none;max-height:120px;"></textarea>
        <button id="sendbtn" style="flex:none;display:flex;align-items:center;gap:6px;padding:9px 16px;height:40px;background:var(--orange);color:#fff;border:none;border-radius:10px;font-size:13.5px;font-weight:600;cursor:pointer;align-self:center;">${esc(t("chat.send"))}<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"></path></svg></button>
      </div>`;
    wrap.querySelector("#sendbtn")!.addEventListener("click", send);
    const ta = wrap.querySelector("#draft") as HTMLTextAreaElement;
    ta.addEventListener("input", () => { drafts[activeConv] = ta.value; });
    ta.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    // 三态开关（自动/聊天/执行）：点选即切，只对本端后续发送生效。
    wrap.querySelector("#umodebar")!.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-mode]") as HTMLElement | null;
      if (!el) return;
      chatMode = (el.dataset.mode as ChatMode) || "auto";
      renderModeBar(wrap);
    });
  }
  renderModeBar(wrap);
  const ta = wrap.querySelector("#draft") as HTMLTextAreaElement;
  ta.placeholder = ph;
  if (ta.value !== (drafts[activeConv] || "")) ta.value = drafts[activeConv] || "";
  const off = wrap.querySelector("#uoffline") as HTMLElement;
  off.innerHTML =
    d && !d.online
      ? `<div style="display:flex;align-items:center;gap:7px;padding:8px 16px 0;font-size:11.5px;color:var(--muted);"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"></path><circle cx="12" cy="12" r="9"></circle></svg><span>${esc(t("chat.deviceOfflineHint"))}</span></div>`
      : "";
}

// 渲染「自动/聊天/执行」三态切换条（当前项高亮）。仅主会话显示（设备会话语义不同）。
function renderModeBar(wrap: HTMLElement): void {
  const bar = wrap.querySelector("#umodebar") as HTMLElement | null;
  if (!bar) return;
  if (activeConv !== MAIN) { bar.style.display = "none"; return; }
  bar.style.display = "flex";
  const items: Array<[ChatMode, string]> = [
    ["auto", t("chat.modeAuto")], ["chat", t("chat.modeChat")], ["execution", t("chat.modeExec")],
  ];
  bar.innerHTML =
    `<span style="font-size:11px;color:var(--muted);margin-right:2px;">${esc(t("chat.modeLabel"))}</span>` +
    items.map(([m, label]) => {
      const on = chatMode === m;
      return `<button data-mode="${m}" style="padding:3px 10px;border-radius:999px;font-size:11.5px;cursor:pointer;border:1px solid ${on ? "var(--orange)" : "var(--border)"};background:${on ? "var(--orange-soft,rgba(255,140,0,.12))" : "transparent"};color:${on ? "var(--orange-text,var(--orange))" : "var(--muted)"};">${esc(label)}</button>`;
    }).join("");
}

function send(): void {
  if (!container) return;
  const ta = container.querySelector("#draft") as HTMLTextAreaElement | null;
  if (!ta) return;
  if (clearing) return; // 清空历史进行中，暂不发送，避免与会话重置竞争
  const text = ta.value.trim();
  if (!text) return;
  ta.value = "";
  drafts[activeConv] = "";
  sendTo(activeConv, text);
}

// 发送到指定会话（主会话或某台设备）。
function sendTo(conv: string, text: string): void {
  const t2 = (text || "").trim();
  if (!t2 || clearing) return;
  stick = true;
  forceScroll = true;
  const s = cs(conv);
  const now = Date.now();
  s.blocks.push({ kind: "user", text: t2, ts: now });
  s.blocks.push({ kind: "assistant", thinking: true, streaming: true, text: "", trace: [], traceOpen: true, ts: now });
  s.assistantIdx = s.blocks.length - 1;
  s.lastText = t2;
  s.lastAt = now;
  // 三态开关只对主会话生效（设备会话有自己的「目标设备」上下文语义）。
  const mode = conv === MAIN ? chatMode : "auto";
  if (!chatConn.sendMessage(t2, operateAutoApprove(), conv, mode)) {
    s.blocks.push({ kind: "error", text: t("chat.notConnected") });
    s.assistantIdx = null;
  }
  if (activeConv !== conv) switchConv(conv);
  else renderMessages();
  renderContacts();
}

// 直接发送一段文本到主会话（供快捷入口「发给秘书」调用；不依赖输入框/是否已挂载聊天页）。
export function sendText(text: string): void {
  sendTo(MAIN, text);
}

function switchConv(id: string): void {
  if (id === activeConv) {
    renderMessages();
    return;
  }
  activeConv = id;
  const s = cs(id);
  s.unread = false;
  stick = true;
  forceScroll = true;
  detailOpen = false;
  renderContacts();
  renderHeader();
  renderDetail();
  renderMessages();
  if (!s.loaded) loadConvHistory(id);
}

// 清空【当前会话】历史：先本地立即清空（乐观），再后台调服务端删除。
async function clearActiveHistory(): Promise<void> {
  if (clearing) return;
  const conv = activeConv;
  const confirmMsg = conv === MAIN ? t("chat.clearConfirm") : t("chat.clearConfirmDevice", { name: convLabel(conv) });
  if (!window.confirm(confirmMsg)) return;
  clearing = true;
  resetConv(conv);
  renderMessages();
  renderContacts();
  try {
    await clearHistory(conv);
  } finally {
    clearing = false;
  }
}

function resetConv(convId: string): void {
  const s = cs(convId);
  s.blocks = [];
  s.assistantIdx = null;
  s.jobMap = {};
  s.doneJobs.clear();
  s.oldestId = null;
  s.hasMore = false;
  s.lastText = "";
  s.lastAt = undefined;
  s.loaded = true; // 已清空，无需再拉历史
}

// 把聊天屏渲染进 container；只在首次写入外壳，事件只刷新消息区（保留输入框焦点）。
let chatShellEl: HTMLElement | null = null;

export function mount(el: HTMLElement): void {
  container = el;
  ensureStarted();
  if (chatShellEl === el) {
    renderContacts();
    renderHeader();
    renderDetail();
    renderMessages();
    return;
  }
  chatShellEl = el;
  el.innerHTML = `
    <div style="display:flex;height:100%;min-height:0;">
      <aside style="flex:none;width:236px;border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0;background:var(--card);">
        <div style="padding:14px 16px 10px;font-size:12px;font-weight:600;color:var(--muted);flex:none;">${esc(t("chat.contacts"))}</div>
        <div id="ucontacts" style="flex:1;overflow-y:auto;padding:0 8px 10px;display:flex;flex-direction:column;gap:2px;min-height:0;"></div>
      </aside>
      <section style="flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;position:relative;">
        <div id="uchathead" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 18px;border-bottom:1px solid var(--border);flex:none;"></div>
        <div id="umsgs" style="flex:1;overflow-y:auto;padding:22px;display:flex;flex-direction:column;gap:16px;min-height:0;"></div>
        <div id="ucomposer" style="flex:none;border-top:1px solid var(--border);background:var(--card);"></div>
        <div id="ulightbox"></div>
      </section>
      <aside id="udetail" style="display:none;flex:none;width:272px;border-left:1px solid var(--border);overflow-y:auto;background:var(--card);"></aside>
    </div>`;

  const contactsEl = el.querySelector("#ucontacts") as HTMLElement;
  contactsEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-conv]") as HTMLElement | null;
    if (btn && btn.dataset.conv) switchConv(btn.dataset.conv);
  });
  const msgsEl = el.querySelector("#umsgs") as HTMLElement;
  msgsEl.addEventListener("click", onMsgsClick);
  // 问答卡的自定义填空：随敲随存（不重渲染，避免打断输入）
  msgsEl.addEventListener("input", (ev) => {
    const t2 = ev.target as HTMLInputElement;
    if (t2 && t2.dataset && t2.dataset.qcustom !== undefined) {
      const b = cs(activeConv).blocks[Number(t2.dataset.qcustom)];
      if (b && b.kind === "question") {
        const q = b.questions[b.at];
        if (q) b.custom[q.id] = t2.value;
      }
    }
  });
  // 跟踪是否贴底：上滑超过阈值即停止自动跟随，回到底部附近恢复跟随。
  msgsEl.addEventListener("scroll", () => {
    stick = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
    if (msgsEl.scrollTop < 60) loadOlder(); // 滚到顶附近 → 加载更早历史
  });
  forceScroll = true; // 首次挂载滚到底
  renderContacts();
  renderHeader();
  renderDetail();
  renderMessages();
}

function onMsgsClick(e: Event): void {
  const el = (e.target as HTMLElement).closest("[data-trace],[data-approve],[data-approve-always],[data-deny],[data-img],[data-qopt],[data-qprev],[data-qnext],[data-qsubmit]") as HTMLElement | null;
  if (!el) return;
  // ── 问答卡 ──
  const qi = el.dataset.qopt ?? el.dataset.qprev ?? el.dataset.qnext ?? el.dataset.qsubmit;
  if (qi !== undefined) {
    const b = cs(activeConv).blocks[Number(qi)];
    if (!b || b.kind !== "question") return;
    const q = b.questions[b.at];
    if (el.dataset.qopt !== undefined && q) {
      const v = el.dataset.val || "";
      const cur = b.picked[q.id] || [];
      // 多选=切换；单选=替换（顺手清掉别的选项）
      b.picked[q.id] = q.multi ? (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]) : cur.includes(v) ? [] : [v];
    } else if (el.dataset.qprev !== undefined) {
      b.at = Math.max(0, b.at - 1); // 可以回上一题改答案
    } else if (el.dataset.qnext !== undefined) {
      b.at = Math.min(b.questions.length - 1, b.at + 1);
    } else if (el.dataset.qsubmit !== undefined) {
      const answers: Record<string, string[]> = {};
      for (const qq of b.questions) {
        const picked = [...(b.picked[qq.id] || [])];
        const c = (b.custom[qq.id] || "").trim();
        if (c) picked.push(c); // 自定义回复与选项并存（用户总有你没想到的答案）
        answers[qq.id] = picked;
      }
      chatConn.sendAnswers(b.cardId, answers);
      b.done = true;
    }
    renderMessages();
    return;
  }
  if (el.dataset.trace !== undefined) {
    const b = cs(activeConv).blocks[Number(el.dataset.trace)];
    if (b && b.kind === "assistant") { b.traceOpen = !b.traceOpen; renderMessages(); }
  } else if (el.dataset.approveAlways) {
    // 总是允许：打开「自动批准电脑操作」（设置里同步）+ 批准本次。
    setAutoApproveOperate(true);
    chatConn.sendConfirm(el.dataset.approveAlways, true);
    resolveConfirm(el.dataset.approveAlways, true);
    renderMessages();
  } else if (el.dataset.approve) {
    chatConn.sendConfirm(el.dataset.approve, true);
    resolveConfirm(el.dataset.approve, true);
    renderMessages();
  } else if (el.dataset.deny) {
    chatConn.sendConfirm(el.dataset.deny, false);
    resolveConfirm(el.dataset.deny, false);
    renderMessages();
  } else if (el.dataset.img) {
    openLightbox(el.dataset.img);
  }
}

// 标记某个确认已被处理（所有会话里的 Job 卡片 + 独立确认卡片都更新）。
function resolveConfirm(taskId: string, approved: boolean): void {
  for (const id of Object.keys(convs)) {
    const s = convs[id];
    if (!s) continue;
    for (const b of s.blocks) {
      if (b.kind === "job" && b.confirmTaskId === taskId) { b.confirmTaskId = undefined; b.message = approved ? t("chat.approved") : t("chat.denied"); }
      if (b.kind === "confirm" && b.taskId === taskId) { b.resolved = approved ? "approved" : "denied"; }
    }
  }
}

function openLightbox(src: string): void {
  if (!container) return;
  const lb = container.querySelector("#ulightbox") as HTMLElement;
  lb.innerHTML = `<div id="lbclose" style="position:absolute;inset:0;background:rgba(0,0,0,.82);z-index:60;display:flex;align-items:center;justify-content:center;cursor:zoom-out;"><img src="${esc(src)}" style="max-width:92%;max-height:92%;border-radius:8px;box-shadow:0 12px 48px rgba(0,0,0,.5);"></div>`;
  lb.querySelector("#lbclose")!.addEventListener("click", () => (lb.innerHTML = ""));
}

export function unmount(): void {
  container = null;
  chatShellEl = null;
}

export function serverLabel(): string {
  return getServerUrl().replace(/^https?:\/\//, "");
}
