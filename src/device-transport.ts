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
export interface DeviceState {
  status: "connecting" | "online" | "offline";
  deviceId: string;
  deviceName: string;
  serverUrl: string;
  providers: ProviderManifest[];
  recentTasks: TaskLog[];
}

let ws: WebSocket | null = null;
let status: DeviceState["status"] = "offline";
let providers: ProviderManifest[] = [];
let recentTasks: TaskLog[] = [];
let logs: string[] = [];
let deviceId = "";
let deviceName = "";
let started = false;
let backoff = 2000;
let registeredThisSession = false;
let reconnectTimer: number | undefined;
let heartbeatTimer: number | undefined;
const pendingResults = new Map<string, unknown>();
let notify: (kind: string) => void = () => {};

const wsUrl = () => getServerUrl().replace(/^http/, "ws") + "/ws/device";

function log(line: string): void {
  logs.unshift(`${new Date().toLocaleTimeString()}  ${line}`);
  logs = logs.slice(0, 200);
  notify("log");
}
function setStatus(s: DeviceState["status"]): void {
  status = s;
  notify("state");
}

export function getState(): DeviceState {
  return { status, deviceId, deviceName, serverUrl: getServerUrl(), providers, recentTasks: recentTasks.slice(0, 20) };
}
export function getLogs(): string[] {
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
  });
  u.onConfirmRequest((c) => {
    sendJson({ type: "task_confirm_request", task_id: c.taskId, summary: c.summary, detail: c.detail });
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
  log(`连接服务端 ${wsUrl()} …`);
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl());
  } catch (e) {
    log(`连接失败：${String(e)}`);
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
      });
    } catch (e) {
      log(`获取注册信息失败：${String(e)}`);
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
      backoff = 2000;
      log(`✓ 已注册为 ${deviceName}（${deviceId}）`);
      setStatus("online");
      startHeartbeat();
      flushPending();
      break;
    case "task":
      handleTask(msg).catch((e) => log(`任务处理异常：${String(e)}`));
      break;
    case "task_confirm_response":
      window.umbra!.confirmResponse(msg.task_id || "", Boolean(msg.approved));
      break;
    case "heartbeat_ack":
      break;
    case "error":
      log(`服务端错误：${msg.message}`);
      break;
    default:
      break;
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = window.setInterval(() => {
    sendJson({ type: "heartbeat" });
    if (pendingResults.size > 0) flushPending();
  }, 30000);
}

async function handleTask(msg: any): Promise<void> {
  const taskId: string = msg.task_id || "";
  const provider: string = msg.provider || "";
  const skill: string = msg.skill || "";
  const params: Record<string, unknown> = msg.params || {};
  log(`收到任务 ${provider}.${skill}`);
  recordTask(taskId, "running", "执行中…", provider, skill);
  try {
    const result = await window.umbra!.runTask(taskId, provider, skill, params);
    recordTask(taskId, "ok", "完成", provider, skill);
    sendOrQueue(taskId, { type: "task_result", task_id: taskId, status: "ok", result });
    log(`任务完成 ${provider}.${skill}`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    recordTask(taskId, "error", err, provider, skill);
    sendOrQueue(taskId, { type: "task_result", task_id: taskId, status: "error", error: err });
    log(`任务失败 ${provider}.${skill}：${err}`);
  }
}

function sendOrQueue(taskId: string, payload: unknown): void {
  if (!sendJson(payload)) {
    pendingResults.set(taskId, payload);
    log(`结果上报失败（连接已断），已入队 ${taskId}`);
  }
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
  const t: TaskLog = {
    taskId,
    provider: provider ?? prev?.provider ?? "",
    skill: skill ?? prev?.skill ?? "",
    status: st,
    message,
    ts: Date.now(),
  };
  if (idx >= 0) recentTasks[idx] = t;
  else recentTasks.unshift(t);
  recentTasks = recentTasks.slice(0, 20);
  notify("state");
}
