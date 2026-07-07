// 实时聊天：连接 /ws/chat，按现有协议驱动设计稿里的聊天组件
// （流式回复、工具轨迹、任务进度卡、执行前确认、完成通知、图片预览、跨端同步）。
//
// 多会话（Phase 2）：
//   - 'assistant'  = 你↔秘书主会话（可发送）
//   - 'device:<id>' = 服务端↔某设备的编排流（默认只读，设置里可开启发送）
//   顶部会话条切换；每个会话各自维护消息/分页/未读；服务端推送按 msg.conversation 路由。
import {
  chatConn,
  fetchHistory,
  fetchConversations,
  fetchDevices,
  clearHistory,
  getServerUrl,
  getAllowDeviceSend,
  getAutoApproveOperate,
} from "../../services/server";
import { t } from "../../i18n";

type Block =
  | { kind: "user"; text: string; ts?: string | number }
  | { kind: "assistant"; thinking: boolean; streaming: boolean; text: string; trace: string[]; traceOpen: boolean; ts?: string | number }
  | { kind: "device"; text: string; ts?: string | number }
  | { kind: "job"; jobId: string; goal: string; pct: number; status: string; message: string; confirmTaskId?: string; results?: { title: string; url: string }[] }
  | { kind: "done"; goal: string; results: { title: string; url: string }[] }
  | { kind: "confirm"; taskId: string; summary: string; detail?: unknown; resolved?: "approved" | "denied" }
  | { kind: "error"; text: string };

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
}

const MAIN = "assistant";
const PAGE = 20;

const convs: Record<string, ConvState> = {};
let convOrder: string[] = [MAIN]; // 会话条显示顺序（主会话恒在首位）
let activeConv = MAIN;
// 设备会话友好名：convId → 设备名（如 device:pc-… → MacBook-Pro-2.local）。
const convNames: Record<string, string> = {};

let container: HTMLElement | null = null;
let started = false;
let appRerender: (() => void) | null = null;
// 滚动策略：贴底时才跟随新消息，上滑查看历史时不打扰；forceScroll 用于发送/切换/首次加载强制到底。
let stick = true;
let forceScroll = false;
let loadingOlder = false;
// 输入草稿：切换模块/重挂载后仍保留，避免已输入内容丢失。
let draftText = "";
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
  };
}

function cs(id: string): ConvState {
  let s = convs[id];
  if (!s) {
    s = convs[id] = newConvState();
    if (!convOrder.includes(id)) convOrder.push(id);
  }
  return s;
}

// 设备会话是否只读（非主会话且未开启“允许向设备发送”）。
function isReadonly(id: string): boolean {
  return id !== MAIN && !getAllowDeviceSend();
}

// 会话展示名：'assistant'→秘书；设备优先用友好名，否则退回 id。
function convLabel(id: string): string {
  if (id === MAIN) return t("chat.secretary");
  if (convNames[id]) return convNames[id];
  if (id.startsWith("device:")) return id.slice("device:".length);
  return id;
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
  // 拉会话列表（含历史设备会话）+ 在线设备（恒显示房间），并加载主会话首屏历史。
  loadConversationsList();
  loadDevices();
  loadConvHistory(MAIN);
  // 设备可能稍后上线：定时刷新，让新设备的房间及时出现。
  window.setInterval(loadDevices, 15000);
}

// 为每个在线设备恒建一个会话房间（哪怕还没有交互记录），并记录友好名。
async function loadDevices(): Promise<void> {
  const devices = await fetchDevices();
  let changed = false;
  for (const d of devices) {
    if (!d.device_id) continue;
    const id = `device:${d.device_id}`;
    if (!convOrder.includes(id)) { cs(id); changed = true; }
    if (d.device_name && convNames[id] !== d.device_name) { convNames[id] = d.device_name; changed = true; }
  }
  if (changed) renderConvBar();
}

async function loadConversationsList(): Promise<void> {
  const rows = await fetchConversations();
  for (const r of rows) {
    if (r.conversation === MAIN) continue;
    if (!convOrder.includes(r.conversation)) {
      cs(r.conversation); // 建状态 + 入列
    }
  }
  renderConvBar();
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

// 推送归属的会话：job_update 带 conversation；流式/同步消息属于主会话。
function convOf(msg: any): string {
  const c = msg && typeof msg.conversation === "string" ? msg.conversation : "";
  return c || MAIN;
}

// 已自动批准过的 task，避免重复发送。
const autoApproved = new Set<string>();
// 若开启「自动批准电脑操作」，收到确认请求就自动批准，不再每次询问。
function autoApproveIfEnabled(taskId: string | undefined): void {
  if (!taskId || autoApproved.has(taskId) || !getAutoApproveOperate()) return;
  autoApproved.add(taskId);
  chatConn.sendConfirm(taskId, true);
  resolveConfirm(taskId, true);
}

function onMessage(msg: any): void {
  let target = MAIN;
  switch (msg.type) {
    case "delta": {
      const a = currentAssistant();
      if (a) { a.thinking = false; a.text += msg.text || ""; }
      break;
    }
    case "tool_call": {
      const a = currentAssistant();
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
      const a = currentAssistant();
      if (a) {
        let p = String(msg.preview || "").replace(/\s+/g, " ").trim();
        if (p.length > 160) p = p.slice(0, 160) + "…";
        a.trace.push(`↳ ${msg.name} → ${p}`);
      }
      break;
    }
    case "reply": {
      const a = currentAssistant();
      if (a) { a.thinking = false; a.streaming = false; a.text = msg.text || a.text; }
      cs(MAIN).assistantIdx = null;
      break;
    }
    case "job_update":
      target = handleJob(msg);
      break;
    case "device_message": {
      // 服务端↔设备的直接交互（非 Job），落到对应设备会话（只读）。
      target = convOf(msg);
      const s = cs(target);
      const ts = msg.created_at || Date.now();
      if (msg.role === "device") s.blocks.push({ kind: "device", text: msg.text || "", ts });
      else s.blocks.push({ kind: "assistant", thinking: false, streaming: false, text: msg.text || "", trace: [], traceOpen: false, ts });
      break;
    }
    case "confirm_request":
      // 执行前授权卡：默认落在主会话，供用户处理（Job 路径的确认卡随 job_update 落到设备会话）。
      target = convOf(msg);
      if (msg.task_id) {
        const s = cs(target);
        if (!s.blocks.some((b) => b.kind === "confirm" && b.taskId === msg.task_id)) {
          s.blocks.push({ kind: "confirm", taskId: msg.task_id, summary: msg.summary || t("chat.needConfirm"), detail: msg.detail });
        }
        autoApproveIfEnabled(msg.task_id);
      }
      break;
    case "confirm_resolved":
      resolveConfirm(msg.task_id || "", Boolean(msg.approved)); // 跨会话统一更新
      renderConvBar();
      return;
    case "history_cleared": {
      // 其它端清空了主会话历史 → 本端同步清空。
      const conv = convOf(msg);
      const s = cs(conv);
      s.blocks = []; s.assistantIdx = null; s.jobMap = {}; s.doneJobs.clear();
      s.oldestId = null; s.hasMore = false;
      if (conv === activeConv) renderMessages();
      return;
    }
    case "chat_message": {
      const s = cs(MAIN);
      if (msg.role === "user") s.blocks.push({ kind: "user", text: msg.text || "", ts: Date.now() });
      else s.blocks.push({ kind: "assistant", thinking: false, streaming: false, text: msg.text || "", trace: [], traceOpen: false, ts: Date.now() });
      break;
    }
    case "error": {
      const s = cs(MAIN);
      if (s.assistantIdx !== null) { const a = currentAssistant(); if (a) { a.thinking = false; a.streaming = false; } s.assistantIdx = null; }
      s.blocks.push({ kind: "error", text: msg.message || t("chat.error") });
      break;
    }
    default:
      return;
  }
  // 目标会话不是当前查看的 → 标记未读并刷新会话条；否则刷新消息区。
  if (target !== activeConv) {
    cs(target).unread = true;
    renderConvBar();
  } else {
    renderMessages();
  }
}

function currentAssistant(): Extract<Block, { kind: "assistant" }> | null {
  const s = cs(MAIN);
  if (s.assistantIdx === null) return null;
  const b = s.blocks[s.assistantIdx];
  return b && b.kind === "assistant" ? b : null;
}

// 返回该 job_update 归属的会话 id（供 onMessage 决定是否刷新/标未读）。
function handleJob(msg: any): string {
  const id = msg.job_id;
  const conv = convOf(msg);
  if (!id) return conv;
  const s = cs(conv);
  const overall = typeof msg.overall === "number" ? msg.overall : msg.status === "done" ? 1 : 0;
  const pct = Math.max(0, Math.min(100, Math.round(overall * 100)));
  let idx = s.jobMap[id];
  if (idx === undefined) {
    s.blocks.push({ kind: "job", jobId: id, goal: msg.goal || t("chat.task"), pct, status: msg.status || "running", message: msg.message || "" });
    idx = s.blocks.length - 1;
    s.jobMap[id] = idx;
  }
  const b = s.blocks[idx];
  if (b.kind !== "job") return conv;
  b.pct = pct;
  b.status = msg.status || b.status;
  b.message = msg.message || b.message;
  if (msg.goal) b.goal = msg.goal;
  b.confirmTaskId = msg.event === "confirm" && msg.needs_confirm ? msg.confirm_task_id : undefined;
  if (b.confirmTaskId) autoApproveIfEnabled(b.confirmTaskId);
  if (msg.results) b.results = msg.results;
  if (msg.status === "done" && !s.doneJobs.has(id)) {
    s.doneJobs.add(id);
    s.blocks.push({ kind: "done", goal: b.goal, results: msg.results || b.results || [] });
  }
  return conv;
}

// ── 渲染 ────────────────────────────────────────────────────────────────────
function imageHtml(url: string): string {
  return `<img data-img="${esc(url)}" src="${esc(url)}" alt="${esc(t("chat.imageAlt"))}" style="display:block;margin-top:8px;max-width:320px;max-height:320px;border-radius:8px;border:1px solid var(--border);cursor:zoom-in;" onerror="this.remove()">`;
}
function assistantBody(text: string): string {
  let html = esc(text);
  const urls = (text || "").match(/https?:\/\/[^\s)]+/g) || [];
  for (const u of urls) if (isImageUrl(u)) html += imageHtml(u);
  return html;
}

const dots = `<span style="display:inline-flex;gap:4px;align-items:center;"><span style="width:7px;height:7px;border-radius:999px;background:var(--muted);animation:umbob 1.2s infinite;"></span><span style="width:7px;height:7px;border-radius:999px;background:var(--muted);animation:umbob 1.2s infinite .2s;"></span><span style="width:7px;height:7px;border-radius:999px;background:var(--muted);animation:umbob 1.2s infinite .4s;"></span></span>`;

const timeLine = (ts: string | number | undefined, align: "flex-start" | "flex-end") => {
  const s = fmtMsgTime(ts);
  return s ? `<div style="align-self:${align};font-size:10.5px;color:var(--muted);padding:0 4px;">${s}</div>` : "";
};

function blockHtml(b: Block, i: number): string {
  if (b.kind === "user")
    return `<div style="align-self:flex-end;max-width:78%;background:var(--user-bubble);padding:11px 14px;border-radius:14px 14px 4px 14px;line-height:1.55;white-space:pre-wrap;">${esc(b.text)}</div>${timeLine(b.ts, "flex-end")}`;

  if (b.kind === "device") {
    // 设备上报（服务端↔设备只读流里的“设备”一侧）：靠右、青色气泡区分秘书。
    return `<div style="align-self:flex-end;max-width:78%;background:var(--track);border:1px solid var(--border);padding:11px 14px;border-radius:14px 14px 4px 14px;line-height:1.55;white-space:pre-wrap;">${esc(b.text)}</div>${timeLine(b.ts, "flex-end")}`;
  }

  if (b.kind === "assistant") {
    const trace = b.trace.length
      ? `<div style="align-self:flex-start;max-width:80%;width:100%;">
          <div data-trace="${i}" style="display:flex;align-items:center;gap:7px;cursor:pointer;color:var(--muted);font-size:12px;margin-bottom:6px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="transition:transform .15s;transform:rotate(${b.traceOpen ? 90 : 0}deg);"><path d="M9 6l6 6-6 6"></path></svg>${esc(t("chat.toolTrace", { count: b.trace.length }))}</div>
          ${b.traceOpen ? `<div style="background:var(--track);border:1px solid var(--border);border-radius:8px;padding:9px 11px;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:11.5px;line-height:1.85;color:var(--muted);">${b.trace.map((t) => `<div>${esc(t)}</div>`).join("")}</div>` : ""}
        </div>`
      : "";
    const bubble = `<div style="align-self:flex-start;max-width:80%;background:var(--card);border:1px solid var(--border);padding:11px 14px;border-radius:14px 14px 14px 4px;line-height:1.6;min-height:20px;white-space:pre-wrap;">${b.thinking ? dots : ""}${assistantBody(b.text)}${b.streaming && b.text ? `<span style="display:inline-block;width:2px;height:15px;background:var(--orange);vertical-align:-2px;margin-left:1px;animation:umblink 1s steps(1) infinite;"></span>` : ""}</div>`;
    return trace + bubble + (b.streaming ? "" : timeLine(b.ts, "flex-start"));
  }

  if (b.kind === "job") {
    const color = b.status === "done" ? "var(--success)" : b.status === "failed" ? "var(--danger)" : "var(--orange)";
    // 授权按钮在任意会话都可点（只读仅限制文本输入，不限制确认操作）。
    const confirm = b.confirmTaskId
      ? `<div style="display:flex;gap:9px;margin-top:11px;"><button data-approve="${esc(b.confirmTaskId)}" style="padding:7px 15px;background:var(--orange);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">${esc(t("chat.approve"))}</button><button data-deny="${esc(b.confirmTaskId)}" style="padding:7px 15px;background:transparent;color:var(--danger);border:1px solid var(--danger);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">${esc(t("chat.reject"))}</button></div>`
      : "";
    return `<div style="align-self:flex-start;max-width:80%;width:100%;background:var(--card);border:1px solid var(--border);border-left:3px solid ${color};border-radius:10px;padding:13px 15px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;"><span style="font-weight:600;">${esc(b.goal)}</span><span style="font-size:12px;color:var(--orange-text);font-weight:600;">${b.pct}%</span></div>
        <div style="height:6px;border-radius:999px;background:var(--track);overflow:hidden;margin-bottom:8px;"><div style="height:100%;width:${b.pct}%;background:${color};border-radius:999px;"></div></div>
        <div style="font-size:12.5px;color:var(--muted);display:flex;align-items:center;gap:6px;"><span style="width:6px;height:6px;border-radius:999px;background:${color};"></span>${esc(b.message)}</div>
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
      : `<div style="display:flex;gap:9px;margin-top:11px;"><button data-approve="${esc(b.taskId)}" style="padding:7px 15px;background:var(--orange);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">${esc(t("chat.approve"))}</button><button data-deny="${esc(b.taskId)}" style="padding:7px 15px;background:transparent;color:var(--danger);border:1px solid var(--danger);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">${esc(t("chat.reject"))}</button></div>`;
    return `<div style="align-self:flex-start;max-width:80%;width:100%;background:var(--orange-soft);border:1px solid var(--orange);border-radius:10px;padding:13px 15px;">
        <div style="font-weight:600;color:var(--orange-text);margin-bottom:6px;display:flex;align-items:center;gap:7px;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"></path><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>${esc(t("chat.needConfirm"))}</div>
        <div style="font-size:13px;line-height:1.55;color:var(--text);">${esc(b.summary)}</div>
        ${detail ? `<div style="font-size:11.5px;color:var(--muted);margin-top:6px;font-family:ui-monospace,Menlo,monospace;word-break:break-all;">${esc(detail)}</div>` : ""}
        ${foot}
      </div>`;
  }

  return `<div style="align-self:flex-start;max-width:80%;border:1px solid rgba(180,35,24,.3);background:var(--danger-soft);color:var(--danger);padding:11px 14px;border-radius:10px;">${esc(b.text)}</div>`;
}

// 会话切换条（主会话 + 各设备会话）。
function renderConvBar(): void {
  if (!container) return;
  const bar = container.querySelector("#uconvbar") as HTMLElement | null;
  if (!bar) return;
  if (convOrder.length <= 1) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "flex";
  bar.innerHTML = convOrder
    .map((id) => {
      const s = convs[id];
      const on = id === activeConv;
      const dot = s && s.unread && !on ? `<span style="width:6px;height:6px;border-radius:999px;background:var(--orange);"></span>` : "";
      const lock = id !== MAIN && isReadonly(id) ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:.7;"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>` : "";
      return `<button data-conv="${esc(id)}" style="display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;font-size:12.5px;cursor:pointer;white-space:nowrap;border:1px solid ${on ? "var(--orange)" : "var(--border)"};background:${on ? "var(--orange-soft)" : "var(--card)"};color:${on ? "var(--orange-text)" : "var(--text)"};font-weight:${on ? 600 : 400};">${lock}${esc(convLabel(id))}${dot}</button>`;
    })
    .join("");
}

function renderMessages(preserve = false): void {
  if (!container) return;
  const el = container.querySelector("#umsgs") as HTMLElement | null;
  if (!el) return;
  const s = cs(activeConv);
  const prevTop = el.scrollTop;
  if (s.blocks.length === 0) {
    const emptyHint = activeConv === MAIN ? t("chat.emptyHint") : t("chat.deviceEmptyHint");
    el.innerHTML = s.loading
      ? `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);gap:9px;min-height:300px;font-size:14px;">${dots}<span>${esc(t("common.loading"))}</span></div>`
      : `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--muted);gap:10px;min-height:300px;"><span style="width:46px;height:46px;border-radius:12px;background:var(--orange);color:#fff;font-weight:700;font-size:24px;display:flex;align-items:center;justify-content:center;opacity:.92;">U</span><span style="font-size:15px;">${esc(emptyHint)}</span></div>`;
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

// 根据当前会话是否只读，切换输入区（可发送）/只读提示。
function refreshComposer(): void {
  if (!container) return;
  const wrap = container.querySelector("#ucomposer") as HTMLElement | null;
  if (!wrap) return;
  if (isReadonly(activeConv)) {
    wrap.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:12px 16px;color:var(--muted);font-size:12.5px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg><span>${esc(t("chat.deviceConvReadonly"))}</span></div>`;
    return;
  }
  // 可发送：若还不是输入框（从只读切过来），重建输入区并绑定事件。
  if (!wrap.querySelector("#draft")) {
    wrap.innerHTML = `
      <div style="display:flex;gap:10px;align-items:flex-end;padding:12px 16px;">
        <textarea id="draft" placeholder="${esc(t("chat.placeholder"))}" rows="2" style="flex:1;resize:none;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:10px;padding:9px 12px;font-size:13.5px;line-height:1.5;font-family:inherit;outline:none;max-height:120px;"></textarea>
        <button id="sendbtn" style="flex:none;display:flex;align-items:center;gap:6px;padding:9px 16px;height:40px;background:var(--orange);color:#fff;border:none;border-radius:10px;font-size:13.5px;font-weight:600;cursor:pointer;align-self:center;">${esc(t("chat.send"))}<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"></path></svg></button>
      </div>`;
    wrap.querySelector("#sendbtn")!.addEventListener("click", send);
    const ta = wrap.querySelector("#draft") as HTMLTextAreaElement;
    ta.value = draftText; // 恢复草稿（切模块/重挂载后不丢）
    ta.addEventListener("input", () => { draftText = ta.value; });
    ta.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
  } else {
    const ta = wrap.querySelector("#draft") as HTMLTextAreaElement | null;
    if (ta) ta.placeholder = t("chat.placeholder");
  }
}

function send(): void {
  if (!container) return;
  const ta = container.querySelector("#draft") as HTMLTextAreaElement | null;
  if (!ta) return;
  if (clearing) return; // 清空历史进行中，暂不发送，避免与会话重置竞争
  const text = ta.value.trim();
  if (!text) return;
  ta.value = "";
  draftText = "";
  stick = true;
  forceScroll = true; // 自己发的消息总是滚到底
  // 发送始终由秘书处理（服务端才是与设备对话的一方），故落在主会话。
  const s = cs(MAIN);
  const now = Date.now();
  s.blocks.push({ kind: "user", text, ts: now });
  s.blocks.push({ kind: "assistant", thinking: true, streaming: true, text: "", trace: [], traceOpen: true, ts: now });
  s.assistantIdx = s.blocks.length - 1;
  if (!chatConn.sendMessage(text)) {
    s.blocks.push({ kind: "error", text: t("chat.notConnected") });
    s.assistantIdx = null;
  }
  if (activeConv !== MAIN) switchConv(MAIN);
  else renderMessages();
}

function switchConv(id: string): void {
  if (id === activeConv) return;
  activeConv = id;
  const s = cs(id);
  s.unread = false;
  stick = true;
  forceScroll = true;
  renderConvBar();
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
  s.loaded = true; // 已清空，无需再拉历史
}

// 把聊天屏渲染进 container；只在首次写入外壳，事件只刷新消息区（保留输入框焦点）。
let chatShellEl: HTMLElement | null = null;

function refreshChatShell(el: HTMLElement): void {
  const h1 = el.querySelector("h1");
  if (h1) h1.textContent = t("nav.chat");
  const clearBtn = el.querySelector("#clearhist");
  if (clearBtn) {
    clearBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"></path></svg>${esc(t("chat.clearHistory"))}`;
  }
}

export function mount(el: HTMLElement): void {
  container = el;
  ensureStarted();
  if (chatShellEl === el) {
    refreshChatShell(el);
    renderConvBar();
    renderMessages();
    return;
  }
  chatShellEl = el;
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;min-height:0;position:relative;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid var(--border);flex:none;">
        <h1 style="margin:0;font-size:16px;font-weight:600;">${esc(t("nav.chat"))}</h1>
        <button id="clearhist" style="display:flex;align-items:center;gap:6px;padding:6px 13px;border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:8px;font-size:13px;cursor:pointer;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"></path></svg>${esc(t("chat.clearHistory"))}</button>
      </div>
      <div id="uconvbar" style="display:none;gap:8px;padding:10px 18px;border-bottom:1px solid var(--border);flex:none;overflow-x:auto;"></div>
      <div id="umsgs" style="flex:1;overflow-y:auto;padding:22px;display:flex;flex-direction:column;gap:16px;min-height:0;"></div>
      <div id="ucomposer" style="flex:none;border-top:1px solid var(--border);background:var(--card);"></div>
      <div id="ulightbox"></div>
    </div>`;

  el.querySelector("#clearhist")!.addEventListener("click", clearActiveHistory);
  const barEl = el.querySelector("#uconvbar") as HTMLElement;
  barEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-conv]") as HTMLElement | null;
    if (btn && btn.dataset.conv) switchConv(btn.dataset.conv);
  });
  const msgsEl = el.querySelector("#umsgs") as HTMLElement;
  msgsEl.addEventListener("click", onMsgsClick);
  // 跟踪是否贴底：上滑超过阈值即停止自动跟随，回到底部附近恢复跟随。
  msgsEl.addEventListener("scroll", () => {
    stick = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
    if (msgsEl.scrollTop < 60) loadOlder(); // 滚到顶附近 → 加载更早历史
  });
  forceScroll = true; // 首次挂载滚到底
  renderConvBar();
  renderMessages();
}

function onMsgsClick(e: Event): void {
  const t = (e.target as HTMLElement).closest("[data-trace],[data-approve],[data-deny],[data-img]") as HTMLElement | null;
  if (!t) return;
  if (t.dataset.trace !== undefined) {
    const b = cs(activeConv).blocks[Number(t.dataset.trace)];
    if (b && b.kind === "assistant") { b.traceOpen = !b.traceOpen; renderMessages(); }
  } else if (t.dataset.approve) {
    chatConn.sendConfirm(t.dataset.approve, true);
    resolveConfirm(t.dataset.approve, true);
    renderMessages();
  } else if (t.dataset.deny) {
    chatConn.sendConfirm(t.dataset.deny, false);
    resolveConfirm(t.dataset.deny, false);
    renderMessages();
  } else if (t.dataset.img) {
    openLightbox(t.dataset.img);
  }
}

// 标记某个确认已被处理（所有会话里的 Job 卡片 + 独立确认卡片都更新）。
function resolveConfirm(taskId: string, approved: boolean): void {
  for (const id of convOrder) {
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
