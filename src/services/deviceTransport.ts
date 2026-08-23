// 设备引擎传输层（渲染层 / Chromium）。
// 因为 Electron 主进程的网络在部分环境被代理/WAF RST，这条 /ws/device 改由渲染层
// 的浏览器 WebSocket 承载（与聊天同一套能过的网络栈）；任务执行经 IPC 交给主进程。
import { getServerUrl } from "./server";

export interface ProviderManifest {
  provider: string;
  display_name: string;
  kind: string;
  available: boolean;
  unavailable_reason: string;
  version: string | null;
  skills: Record<string, { description: string; params: Record<string, string> }>;
}
export interface TaskLog {
  taskId: string;
  provider: string;
  skill: string;
  status: string;
  message: string;
  ts: number;
}
// ── 日志条目 ────────────────────────────────────────────────────────────────
// 原来这里是 `string[]`，每条已经把时间拼死在字符串里了。日志页因此只能整行平铺，
// 既没法按来源筛，也没法给不同性质的行上色 —— 一屏几百行全是同一个灰，
// 找一条「哪儿断的」得靠肉眼扫。稿（1982-1996、5032-5042）要的是三列：时间 / 标签 / 正文。
//
// 两个维度是**分开**的，别合并：
//   src = 筛选分组，只有三档（conn 连接 / jobs 任务 / cap 能力执行），对应稿上四颗胶囊里的后三颗；
//   tag = 这一行本身是什么性质（conn/job/cap/warn/info/error），决定颜色。
// 一条「能力执行时等用户确认」是 src=cap（属于能力执行这一组）但 tag=warn（黄的），
// 合成一个维度就表达不了 —— 它要么被归进错误组，要么就没有颜色。
export type LogSrc = "conn" | "jobs" | "cap";
export type LogTag = "conn" | "job" | "cap" | "warn" | "info" | "error";
/** 行首字符前缀。`ok` → ✓（成功事件，绿）；`cont` → └（上一行的续行：结果/参数/原始返回，灰）。
 *
 *  设计规范禁止用 Unicode 符号代替图标，**日志是唯一的例外**，稿里写明了理由：
 *  日志是引擎原样打出来的文本，行首字符属于内容而不是图标 —— 复制出去要能和终端对上。
 *  所以它单独占一列（12px 居中），不跟正文挤，也不换成 SVG。 */
export type LogMark = "ok" | "cont";
export interface LogLine {
  time: string;
  tag: LogTag;
  src: LogSrc;
  /** 见 LogMark。没有前缀时是 undefined。 */
  mark?: LogMark;
  msg: string;
}

export interface DeviceState {
  status: "connecting" | "online" | "offline";
  deviceId: string;
  deviceName: string;
  serverUrl: string;
  providers: ProviderManifest[];
  recentTasks: TaskLog[];
  // 下面三个给设置页的「设备与引擎」用。0 = 还没有数据。
  registeredAt: number;      // 本次注册成功的时刻（时间戳）→ 算「已注册多久」
  lastHeartbeatAt: number;   // 最近一次收到 heartbeat_ack 的时刻 → 算「心跳 N 秒前」
  latencyMs: number;         // 最近一次心跳的往返耗时
}

let ws: WebSocket | null = null;
let status: DeviceState["status"] = "offline";
let providers: ProviderManifest[] = [];
let recentTasks: TaskLog[] = [];
let logs: LogLine[] = [];
let deviceId = "";
let deviceName = "";
let started = false;
let backoff = 2000;
let registeredThisSession = false;
let reconnectTimer: number | undefined;
let heartbeatTimer: number | undefined;
// 心跳往返统计：发出去时记时刻，收到 heartbeat_ack 时算差值。
// 这是全应用唯一有真实往返数据的地方（聊天那条 WS 没有 ping/pong 协议），
// 所以设置页的延迟/心跳都读这里。
let heartbeatSentAt = 0;
let lastHeartbeatAt = 0;
let latencyMs = 0;
let registeredAt = 0;
const pendingResults = new Map<string, unknown>();
let notify: (kind: string) => void = () => {};

const wsUrl = () => getServerUrl().replace(/^http/, "ws") + "/ws/device";

function log(msg: string, tag: LogTag = "info", src: LogSrc = "conn", mark?: LogMark): void {
  logs.unshift({ time: new Date().toLocaleTimeString(), tag, src, mark, msg });
  logs = logs.slice(0, 200); // 内存里只留最近 200 条给界面看
  // 同时落盘（userData/logs/umbra-YYYY-MM-DD.log）：应用一关内存日志就没了，
  // 而排查问题往往是事后才想起来要看日志。
  // 落盘的仍然是**纯文本**：日志文件是给人拿文本编辑器看的，塞 tag/src 只会碍事；
  // 分组是界面的事，文件里那一行本身就带着足够的语义。
  // 落盘时把前缀**拼回正文**：日志文件没有"列"，`└ 结果：…` 那条不带前缀就成了
  // 一句无主的话，看不出它是上一行的续行。界面上前缀单独成列，文件里它就得在句首。
  window.umbra?.appendLog(mark === "ok" ? `✓ ${msg}` : mark === "cont" ? `　└ ${msg}` : msg);
  notify("log");
}
function setStatus(s: DeviceState["status"]): void {
  status = s;
  notify("state");
}

export function getState(): DeviceState {
  return {
    status, deviceId, deviceName, serverUrl: getServerUrl(), providers,
    recentTasks: recentTasks.slice(0, 20),
    registeredAt, lastHeartbeatAt, latencyMs,
  };
}
export function getLogs(): LogLine[] {
  return logs;
}

// 启动传输：订阅主进程的进度/确认事件 + 连接 /ws/device。
export function start(onUpdate: (kind: string) => void): void {
  notify = onUpdate;
  if (started) return;
  started = true;
  const u = window.umbra!;
  u.onTaskProgress((p) => {
    sendJson({ type: "task_progress", task_id: p.taskId, message: p.message, ...(p.extra || {}) });
    recordTask(p.taskId, "running", p.message);
    log(`执行：${p.message}`, "cap", "cap"); // 同时进 PC 日志，便于调试
  });
  u.onConfirmRequest((c) => {
    sendJson({ type: "task_confirm_request", task_id: c.taskId, summary: c.summary, detail: c.detail });
    log(`请求授权 [${short(c.taskId)}]：${c.summary}`, "warn", "cap");
  });
  connect();
}

export function reconnect(): void {
  backoff = 2000;
  registeredThisSession = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  connect();
}

function connect(): void {
  setStatus("connecting");
  registeredThisSession = false;
  // 断了就把注册时刻与心跳统计清零：留着旧值会让界面显示「已注册 3 小时」而其实刚断线。
  registeredAt = 0;
  lastHeartbeatAt = 0;
  latencyMs = 0;
  heartbeatSentAt = 0;
  log(`连接服务端 ${wsUrl()} …`, "conn", "conn");
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl());
  } catch (e) {
    log(`连接失败：${String(e)}`, "error", "conn");
    scheduleReconnect();
    return;
  }
  ws = sock;
  // 守卫：只有仍是"当前连接"的回调才生效，避免 connect/reconnect 抖动时旧连接误触发重连（重复注册）。
  sock.onopen = async () => {
    if (ws !== sock) return;
    try {
      const info = await window.umbra!.getRegisterInfo();
      deviceId = info.deviceId;
      deviceName = info.deviceName;
      providers = info.providers;
      notify("state");
      sendJson({
        type: "register",
        device_id: info.deviceId,
        device_name: info.deviceName,
        platform: info.platform,
        providers: info.providers,
        token: info.token,
        timezone: info.timezone,
        locale: info.locale,
      });
    } catch (e) {
      log(`获取注册信息失败：${String(e)}`, "error", "conn");
    }
  };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    onMessage(String(ev.data));
  };
  sock.onclose = () => {
    if (ws !== sock) return; // 不是当前连接 → 不重连
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    setStatus("offline");
    scheduleReconnect();
  };
  sock.onerror = () => {
    try {
      sock.close();
    } catch {
      /* ignore */
    }
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const wait = registeredThisSession ? 2000 : backoff;
  reconnectTimer = window.setTimeout(connect, wait);
  backoff = registeredThisSession ? 2000 : Math.min(backoff * 2, 30000);
}

function sendJson(obj: unknown): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function onMessage(raw: string): void {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.type) {
    case "registered":
      registeredThisSession = true;
      registeredAt = Date.now();
      backoff = 2000;
      log(`已注册为 ${deviceName}（${deviceId}）`, "conn", "conn", "ok");
      setStatus("online");
      startHeartbeat();
      flushPending();
      break;
    case "task":
      handleTask(msg).catch((e) => log(`任务处理异常：${String(e)}`, "error", "jobs"));
      break;
    case "task_confirm_response":
      window.umbra!.confirmResponse(msg.task_id || "", Boolean(msg.approved));
      break;
    case "task_cancel":
      // 服务端 cancel_task：杀掉正在跑这个任务的引擎进程（项目会话保留给同项目的下个任务）。
      window.umbra!.cancelTask(msg.task_id || "").catch((e) => log(`取消任务异常：${String(e)}`, "error", "jobs"));
      break;
    case "heartbeat_ack":
      // 一来一回算延迟。heartbeatSentAt 为 0 说明这条 ack 没有对应的发送记录（重连边界），跳过统计。
      lastHeartbeatAt = Date.now();
      if (heartbeatSentAt) latencyMs = lastHeartbeatAt - heartbeatSentAt;
      heartbeatSentAt = 0;
      notify("state");
      break;
    case "error":
      log(`服务端错误：${msg.message}`, "error", "conn");
      break;
    default:
      break;
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = window.setInterval(() => {
    heartbeatSentAt = Date.now();
    sendJson({ type: "heartbeat" });
    if (pendingResults.size > 0) flushPending();
  }, 30000);
}

// 日志用：截短的 task_id / JSON，既能对上号又不刷屏。
function short(id: string): string {
  return (id || "").slice(0, 8);
}
function brief(v: unknown, n = 160): string {
  let t = "";
  try {
    t = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    t = String(v);
  }
  t = (t || "").replace(/\s+/g, " ");
  return t.length > n ? t.slice(0, n) + "…" : t;
}

async function handleTask(msg: any): Promise<void> {
  const taskId: string = msg.task_id || "";
  const provider: string = msg.provider || "";
  const skill: string = msg.skill || "";
  const params: Record<string, unknown> = msg.params || {};
  const t0 = Date.now();
  // 日志要能还原「谁让我干什么、参数是什么、干了多久、结果如何」——出问题时这就是全部线索。
  log(`收到任务 [${short(taskId)}] ${provider}.${skill} 参数=${brief(params)}`, "job", "jobs");
  recordTask(taskId, "running", "执行中…", provider, skill);
  // 立刻回一条 ACK：让服务端时间线上**一定**有「设备已收到」这一条。
  // 否则「服务端没发到」和「设备收到但卡住」在时间线上长得一模一样，只能靠猜。
  sendJson({ type: "task_progress", task_id: taskId, message: `设备已收到任务 ${provider}.${skill}`, progress: 0.02 });
  try {
    const result = await window.umbra!.runTask(taskId, provider, skill, params);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    recordTask(taskId, "ok", "完成", provider, skill);
    const sent = sendOrQueue(taskId, { type: "task_result", task_id: taskId, status: "ok", result });
    log(`任务完成 [${short(taskId)}] ${provider}.${skill} 用时 ${sec}s${sent ? "" : "（结果上报失败，已入队待重发）"}`, "job", "jobs");
    log(`结果：${brief(result, 240)}`, "info", "jobs", "cont");
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    recordTask(taskId, "error", err, provider, skill);
    const sent = sendOrQueue(taskId, { type: "task_result", task_id: taskId, status: "error", error: err });
    log(`任务失败 [${short(taskId)}] ${provider}.${skill} 用时 ${sec}s：${err}${sent ? "" : "（上报失败，已入队）"}`, "error", "jobs");
  }
}

function sendOrQueue(taskId: string, payload: unknown): boolean {
  if (!sendJson(payload)) {
    pendingResults.set(taskId, payload);
    log(`结果上报失败（连接已断），已入队 ${short(taskId)}，将在下次心跳重发`, "warn", "jobs");
    return false;
  }
  return true;
}
function flushPending(): void {
  for (const [id, p] of [...pendingResults]) {
    if (sendJson(p)) pendingResults.delete(id);
    else break;
  }
}

function recordTask(taskId: string, st: string, message: string, provider?: string, skill?: string): void {
  const idx = recentTasks.findIndex((t) => t.taskId === taskId);
  const prev = idx >= 0 ? recentTasks[idx] : undefined;
  // 成功时若传入的是通用"完成"，保留上一条更具体的消息（如"点击 (x,y)"），避免详情被覆盖。
  const keepDetail = st === "ok" && message === "完成" && prev && prev.message && prev.message !== "执行中…";
  const t: TaskLog = {
    taskId,
    provider: provider ?? prev?.provider ?? "",
    skill: skill ?? prev?.skill ?? "",
    status: st,
    message: keepDetail ? prev!.message : message,
    ts: Date.now(),
  };
  if (idx >= 0) recentTasks[idx] = t;
  else recentTasks.unshift(t);
  recentTasks = recentTasks.slice(0, 20);
  notify("state");
}
