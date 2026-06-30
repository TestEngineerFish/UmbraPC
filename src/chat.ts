// 实时聊天：连接 /ws/chat，按现有协议驱动设计稿里的聊天组件
// （流式回复、工具轨迹、任务进度卡、执行前确认、完成通知、图片预览、跨端同步）。
import { chatConn, fetchHistory, getServerUrl } from "./server";

type Block =
  | { kind: "user"; text: string; ts?: string | number }
  | { kind: "assistant"; thinking: boolean; streaming: boolean; text: string; trace: string[]; traceOpen: boolean; ts?: string | number }
  | { kind: "job"; jobId: string; goal: string; pct: number; status: string; message: string; confirmTaskId?: string; results?: { title: string; url: string }[] }
  | { kind: "done"; goal: string; results: { title: string; url: string }[] }
  | { kind: "confirm"; taskId: string; summary: string; detail?: unknown; resolved?: "approved" | "denied" }
  | { kind: "error"; text: string };

let blocks: Block[] = [];
let assistantIdx: number | null = null;
const jobMap: Record<string, number> = {};
const doneJobs = new Set<string>();
let container: HTMLElement | null = null;
let started = false;
let appRerender: (() => void) | null = null;
// 滚动策略：贴底时才跟随新消息，上滑查看历史时不打扰；forceScroll 用于发送/首次加载强制到底。
let stick = true;
let forceScroll = false;
let historyLoading = false;
// 分页游标：oldestId 为已加载最早消息的 id；hasMore 表示可能还有更早的；loadingOlder 防并发。
const PAGE = 20;
let oldestId: number | null = null;
let hasMore = false;
let loadingOlder = false;

function rowToBlock(m: { role: string; content: string; created_at?: string }): Block {
  return m.role === "user"
    ? { kind: "user", text: m.content, ts: m.created_at }
    : { kind: "assistant", thinking: false, streaming: false, text: m.content, trace: [], traceOpen: false, ts: m.created_at };
}

// IM 风格消息时间：今天→HH:MM，昨天→昨天 HH:MM，今年→M月D日 HH:MM，更早→YYYY年M月D日 HH:MM。
function fmtMsgTime(ts?: string | number): string {
  if (ts == null) return "";
  const d = typeof ts === "number" ? new Date(ts) : new Date(String(ts).includes("T") ? String(ts) : String(ts).replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sod = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((sod(now) - sod(d)) / 86400000);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days <= 0) return hm;
  if (days === 1) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
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
  historyLoading = true;
  renderMessages();
  fetchHistory(PAGE)
    .then((rows) => {
      historyLoading = false;
      if (rows.length && blocks.length === 0) {
        for (const m of rows) blocks.push(rowToBlock(m));
        oldestId = rows[0].id;
        hasMore = rows.length >= PAGE;
      }
      forceScroll = true;
      renderMessages();
    })
    .catch(() => {
      historyLoading = false;
      renderMessages();
    });
}

// 上拉加载更早一页历史，并保持当前可视位置不跳动。
async function loadOlder(): Promise<void> {
  if (loadingOlder || !hasMore || oldestId == null || !container) return;
  loadingOlder = true;
  const el = container.querySelector("#umsgs") as HTMLElement | null;
  const prevH = el ? el.scrollHeight : 0;
  const prevTop = el ? el.scrollTop : 0;
  const rows = await fetchHistory(PAGE, oldestId);
  loadingOlder = false;
  if (rows.length === 0) {
    hasMore = false;
    return;
  }
  if (rows.length < PAGE) hasMore = false;
  oldestId = rows[0].id;
  const n = rows.length;
  // 前置插入后，已有块的索引整体右移，需同步 jobMap 与 assistantIdx。
  for (const k of Object.keys(jobMap)) jobMap[k] += n;
  if (assistantIdx != null) assistantIdx += n;
  blocks = [...rows.map(rowToBlock), ...blocks];
  renderMessages(true); // 保留滚动，由下面手动恢复
  if (el) el.scrollTop = prevTop + (el.scrollHeight - prevH);
}

function onMessage(msg: any): void {
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
      assistantIdx = null;
      break;
    }
    case "job_update": handleJob(msg); break;
    case "confirm_request":
      if (msg.task_id && !blocks.some((b) => b.kind === "confirm" && b.taskId === msg.task_id)) {
        blocks.push({ kind: "confirm", taskId: msg.task_id, summary: msg.summary || "需要执行前确认", detail: msg.detail });
      }
      break;
    case "confirm_resolved":
      resolveConfirm(msg.task_id || "", Boolean(msg.approved));
      break;
    case "chat_message":
      if (msg.role === "user") blocks.push({ kind: "user", text: msg.text || "", ts: Date.now() });
      else blocks.push({ kind: "assistant", thinking: false, streaming: false, text: msg.text || "", trace: [], traceOpen: false, ts: Date.now() });
      break;
    case "error":
      if (assistantIdx !== null) { const a = currentAssistant(); if (a) { a.thinking = false; a.streaming = false; } assistantIdx = null; }
      blocks.push({ kind: "error", text: msg.message || "出错了" });
      break;
    default: return;
  }
  renderMessages();
}

function currentAssistant(): Extract<Block, { kind: "assistant" }> | null {
  if (assistantIdx === null) return null;
  const b = blocks[assistantIdx];
  return b && b.kind === "assistant" ? b : null;
}

function handleJob(msg: any): void {
  const id = msg.job_id;
  if (!id) return;
  const overall = typeof msg.overall === "number" ? msg.overall : msg.status === "done" ? 1 : 0;
  const pct = Math.max(0, Math.min(100, Math.round(overall * 100)));
  let idx = jobMap[id];
  if (idx === undefined) {
    blocks.push({ kind: "job", jobId: id, goal: msg.goal || "任务", pct, status: msg.status || "running", message: msg.message || "" });
    idx = blocks.length - 1;
    jobMap[id] = idx;
  }
  const b = blocks[idx];
  if (b.kind !== "job") return;
  b.pct = pct;
  b.status = msg.status || b.status;
  b.message = msg.message || b.message;
  if (msg.goal) b.goal = msg.goal;
  b.confirmTaskId = msg.event === "confirm" && msg.needs_confirm ? msg.confirm_task_id : undefined;
  if (msg.results) b.results = msg.results;
  if (msg.status === "done" && !doneJobs.has(id)) {
    doneJobs.add(id);
    blocks.push({ kind: "done", goal: b.goal, results: msg.results || b.results || [] });
  }
}

// ── 渲染 ────────────────────────────────────────────────────────────────────
function imageHtml(url: string): string {
  return `<img data-img="${esc(url)}" src="${esc(url)}" alt="图片" style="display:block;margin-top:8px;max-width:320px;max-height:320px;border-radius:8px;border:1px solid var(--border);cursor:zoom-in;" onerror="this.remove()">`;
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

  if (b.kind === "assistant") {
    const trace = b.trace.length
      ? `<div style="align-self:flex-start;max-width:80%;width:100%;">
          <div data-trace="${i}" style="display:flex;align-items:center;gap:7px;cursor:pointer;color:var(--muted);font-size:12px;margin-bottom:6px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="transition:transform .15s;transform:rotate(${b.traceOpen ? 90 : 0}deg);"><path d="M9 6l6 6-6 6"></path></svg>工具轨迹 · ${b.trace.length} 步</div>
          ${b.traceOpen ? `<div style="background:var(--track);border:1px solid var(--border);border-radius:8px;padding:9px 11px;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:11.5px;line-height:1.85;color:var(--muted);">${b.trace.map((t) => `<div>${esc(t)}</div>`).join("")}</div>` : ""}
        </div>`
      : "";
    const bubble = `<div style="align-self:flex-start;max-width:80%;background:var(--card);border:1px solid var(--border);padding:11px 14px;border-radius:14px 14px 14px 4px;line-height:1.6;min-height:20px;white-space:pre-wrap;">${b.thinking ? dots : ""}${assistantBody(b.text)}${b.streaming && b.text ? `<span style="display:inline-block;width:2px;height:15px;background:var(--orange);vertical-align:-2px;margin-left:1px;animation:umblink 1s steps(1) infinite;"></span>` : ""}</div>`;
    return trace + bubble + (b.streaming ? "" : timeLine(b.ts, "flex-start"));
  }

  if (b.kind === "job") {
    const color = b.status === "done" ? "var(--success)" : b.status === "failed" ? "var(--danger)" : "var(--orange)";
    const confirm = b.confirmTaskId
      ? `<div style="display:flex;gap:9px;margin-top:11px;"><button data-approve="${esc(b.confirmTaskId)}" style="padding:7px 15px;background:var(--orange);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">批准执行</button><button data-deny="${esc(b.confirmTaskId)}" style="padding:7px 15px;background:transparent;color:var(--danger);border:1px solid var(--danger);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">拒绝</button></div>`
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
    return `<div style="align-self:flex-start;max-width:80%;background:var(--success-soft);border:1px solid var(--success);border-left:3px solid var(--success);border-radius:10px;padding:13px 15px;"><div style="font-weight:600;color:var(--success);margin-bottom:7px;">🎉 任务完成：${esc(b.goal)}</div>${links}</div>`;
  }

  if (b.kind === "confirm") {
    const detail = b.detail != null ? (typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail)) : "";
    const foot = b.resolved
      ? `<div style="font-size:12.5px;font-weight:600;margin-top:9px;color:${b.resolved === "approved" ? "var(--success)" : "var(--danger)"};">${b.resolved === "approved" ? "✅ 已批准执行" : "🚫 已拒绝"}</div>`
      : `<div style="display:flex;gap:9px;margin-top:11px;"><button data-approve="${esc(b.taskId)}" style="padding:7px 15px;background:var(--orange);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">批准执行</button><button data-deny="${esc(b.taskId)}" style="padding:7px 15px;background:transparent;color:var(--danger);border:1px solid var(--danger);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">拒绝</button></div>`;
    return `<div style="align-self:flex-start;max-width:80%;width:100%;background:var(--orange-soft);border:1px solid var(--orange);border-radius:10px;padding:13px 15px;">
        <div style="font-weight:600;color:var(--orange-text);margin-bottom:6px;display:flex;align-items:center;gap:7px;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"></path><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>执行前确认</div>
        <div style="font-size:13px;line-height:1.55;color:var(--text);">${esc(b.summary)}</div>
        ${detail ? `<div style="font-size:11.5px;color:var(--muted);margin-top:6px;font-family:ui-monospace,Menlo,monospace;word-break:break-all;">${esc(detail)}</div>` : ""}
        ${foot}
      </div>`;
  }

  return `<div style="align-self:flex-start;max-width:80%;border:1px solid rgba(180,35,24,.3);background:var(--danger-soft);color:var(--danger);padding:11px 14px;border-radius:10px;">${esc(b.text)}</div>`;
}

function renderMessages(preserve = false): void {
  if (!container) return;
  const el = container.querySelector("#umsgs") as HTMLElement | null;
  if (!el) return;
  const prevTop = el.scrollTop;
  if (blocks.length === 0) {
    el.innerHTML = historyLoading
      ? `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);gap:9px;min-height:300px;font-size:14px;">${dots}<span>加载历史消息…</span></div>`
      : `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--muted);gap:10px;min-height:300px;"><span style="width:46px;height:46px;border-radius:12px;background:var(--orange);color:#fff;font-weight:700;font-size:24px;display:flex;align-items:center;justify-content:center;opacity:.92;">U</span><span style="font-size:15px;">开始和 Umbra 聊天</span></div>`;
  } else {
    // 每条消息包一层 flex:none，避免纵向 flex 在内容（高图片）超高时压缩重叠。
    el.innerHTML = blocks
      .map((b, i) => `<div style="flex:none;display:flex;flex-direction:column;gap:8px;">${blockHtml(b, i)}</div>`)
      .join("");
  }
  if (preserve) return; // 上拉加载：由调用方手动恢复滚动位置
  // 贴底或强制时滚到底；否则尽量保持原有滚动位置（避免上滑被弹回）。
  if (stick || forceScroll) {
    el.scrollTop = el.scrollHeight;
    forceScroll = false;
  } else {
    el.scrollTop = prevTop;
  }
}

function send(): void {
  if (!container) return;
  const ta = container.querySelector("#draft") as HTMLTextAreaElement | null;
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) return;
  ta.value = "";
  stick = true;
  forceScroll = true; // 自己发的消息总是滚到底
  const now = Date.now();
  blocks.push({ kind: "user", text, ts: now });
  blocks.push({ kind: "assistant", thinking: true, streaming: true, text: "", trace: [], traceOpen: true, ts: now });
  assistantIdx = blocks.length - 1;
  if (!chatConn.sendMessage(text)) {
    blocks.push({ kind: "error", text: "未连接到服务端，消息未发出。请检查设置里的服务端地址。" });
    assistantIdx = null;
  }
  renderMessages();
}

function newSession(): void {
  blocks = [];
  assistantIdx = null;
  for (const k of Object.keys(jobMap)) delete jobMap[k];
  doneJobs.clear();
  oldestId = null;
  hasMore = false;
  chatConn.sendMessage("/new");
  renderMessages();
}

// 把聊天屏渲染进 container；只在首次写入外壳，事件只刷新消息区（保留输入框焦点）。
export function mount(el: HTMLElement): void {
  container = el;
  ensureStarted();
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;min-height:0;position:relative;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid var(--border);flex:none;">
        <h1 style="margin:0;font-size:16px;font-weight:600;">聊天</h1>
        <button id="newsess" style="display:flex;align-items:center;gap:6px;padding:6px 13px;border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:8px;font-size:13px;cursor:pointer;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>新会话</button>
      </div>
      <div id="umsgs" style="flex:1;overflow-y:auto;padding:22px;display:flex;flex-direction:column;gap:16px;min-height:0;"></div>
      <div style="flex:none;border-top:1px solid var(--border);background:var(--card);padding:12px 16px;">
        <div style="display:flex;gap:10px;align-items:flex-end;">
          <textarea id="draft" placeholder="输入消息，Enter 发送，Shift+Enter 换行" rows="2" style="flex:1;resize:none;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:10px;padding:9px 12px;font-size:13.5px;line-height:1.5;font-family:inherit;outline:none;max-height:120px;"></textarea>
          <button id="sendbtn" style="flex:none;display:flex;align-items:center;gap:6px;padding:9px 16px;height:40px;background:var(--orange);color:#fff;border:none;border-radius:10px;font-size:13.5px;font-weight:600;cursor:pointer;align-self:center;">发送<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"></path></svg></button>
        </div>
      </div>
      <div id="ulightbox"></div>
    </div>`;

  el.querySelector("#sendbtn")!.addEventListener("click", send);
  el.querySelector("#newsess")!.addEventListener("click", newSession);
  const ta = el.querySelector("#draft") as HTMLTextAreaElement;
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  const msgsEl = el.querySelector("#umsgs") as HTMLElement;
  msgsEl.addEventListener("click", onMsgsClick);
  // 跟踪是否贴底：上滑超过阈值即停止自动跟随，回到底部附近恢复跟随。
  msgsEl.addEventListener("scroll", () => {
    stick = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
    if (msgsEl.scrollTop < 60) loadOlder(); // 滚到顶附近 → 加载更早历史
  });
  forceScroll = true; // 首次挂载滚到底
  renderMessages();
}

function onMsgsClick(e: Event): void {
  const t = (e.target as HTMLElement).closest("[data-trace],[data-approve],[data-deny],[data-img]") as HTMLElement | null;
  if (!t) return;
  if (t.dataset.trace !== undefined) {
    const b = blocks[Number(t.dataset.trace)];
    if (b && b.kind === "assistant") { b.traceOpen = !b.traceOpen; renderMessages(); }
  } else if (t.dataset.approve) {
    chatConn.sendConfirm(t.dataset.approve, true);
    resolveConfirm(t.dataset.approve, true);
  } else if (t.dataset.deny) {
    chatConn.sendConfirm(t.dataset.deny, false);
    resolveConfirm(t.dataset.deny, false);
  } else if (t.dataset.img) {
    openLightbox(t.dataset.img);
  }
}

// 标记某个确认已被处理（Job 卡片 + 独立确认卡片都更新）。
function resolveConfirm(taskId: string, approved: boolean): void {
  for (const b of blocks) {
    if (b.kind === "job" && b.confirmTaskId === taskId) { b.confirmTaskId = undefined; b.message = approved ? "已批准，执行中…" : "已拒绝"; }
    if (b.kind === "confirm" && b.taskId === taskId) { b.resolved = approved ? "approved" : "denied"; }
  }
  renderMessages();
}

function openLightbox(src: string): void {
  if (!container) return;
  const lb = container.querySelector("#ulightbox") as HTMLElement;
  lb.innerHTML = `<div id="lbclose" style="position:absolute;inset:0;background:rgba(0,0,0,.82);z-index:60;display:flex;align-items:center;justify-content:center;cursor:zoom-out;"><img src="${esc(src)}" style="max-width:92%;max-height:92%;border-radius:8px;box-shadow:0 12px 48px rgba(0,0,0,.5);"></div>`;
  lb.querySelector("#lbclose")!.addEventListener("click", () => (lb.innerHTML = ""));
}

export function unmount(): void {
  container = null;
}

export function serverLabel(): string {
  return getServerUrl().replace(/^https?:\/\//, "");
}
