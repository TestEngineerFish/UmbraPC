// 与 Umbra 服务端的连接层：配置 + /ws/chat WebSocket（自动重连）+ HTTP 拉取。
// 聊天协议与现有 Web 调试页一致，复用已验证的消息格式。

export type ConnStatus = "connecting" | "online" | "offline";

const LS = {
  serverUrl: "umbra.serverUrl",
  token: "umbra.token",
  clientId: "umbra.clientId",
  deviceName: "umbra.deviceName",
};

const DEFAULT_SERVER = "https://umbra.tingyusha.xyz";

export function getServerUrl(): string {
  return (localStorage.getItem(LS.serverUrl) || DEFAULT_SERVER).replace(/\/+$/, "");
}
export function setServerUrl(v: string): void {
  localStorage.setItem(LS.serverUrl, v.trim().replace(/\/+$/, ""));
}
export function getToken(): string {
  return localStorage.getItem(LS.token) || "";
}
export function setToken(v: string): void {
  localStorage.setItem(LS.token, v);
}
export function getClientId(): string {
  let id = localStorage.getItem(LS.clientId);
  if (!id) {
    id = "pc-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(LS.clientId, id);
  }
  return id;
}
export function getDeviceName(): string {
  return localStorage.getItem(LS.deviceName) || "此设备";
}
export function setDeviceName(v: string): void {
  localStorage.setItem(LS.deviceName, v);
}

function wsUrl(): string {
  const base = getServerUrl();
  return base.replace(/^http/, "ws") + "/ws/chat";
}

export interface HistoryRow {
  id: number;
  role: string;
  content: string;
  created_at?: string;
  conversation?: string;
}

// 拉历史：limit 条；传 beforeId 取更早一页（上拉加载）；conversation 指定会话
// （默认 'assistant' 主会话；'device:<id>' 取某设备的只读会话）。
export async function fetchHistory(
  limit = 20,
  beforeId?: number,
  conversation = "assistant",
): Promise<HistoryRow[]> {
  try {
    const q =
      `?limit=${limit}` +
      (beforeId ? `&before_id=${beforeId}` : "") +
      `&conversation=${encodeURIComponent(conversation)}`;
    const r = await fetch(`${getServerUrl()}/history${q}`);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

// 清空主会话历史（你↔秘书）。返回删除条数。
export async function clearHistory(): Promise<number> {
  try {
    const r = await fetch(`${getServerUrl()}/history/clear`, { method: "POST" });
    if (!r.ok) return 0;
    const data = await r.json();
    return typeof data?.deleted === "number" ? data.deleted : 0;
  } catch {
    return 0;
  }
}

export interface ConversationRow {
  conversation: string;
  last_role: string;
  last_content: string;
  last_at?: string;
  count: number;
}

// 会话列表：'assistant'=你↔秘书；'device:<id>'=服务端↔某设备（只读）。
export async function fetchConversations(): Promise<ConversationRow[]> {
  try {
    const r = await fetch(`${getServerUrl()}/conversations`);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

export interface DeviceInfo {
  device_id: string;
  device_name: string;
  platform?: string;
}

// 在线设备列表：用于给每个设备恒显示一个会话房间（哪怕还没有交互记录）。
export async function fetchDevices(): Promise<DeviceInfo[]> {
  try {
    const r = await fetch(`${getServerUrl()}/devices`);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

// 聊天设置：是否允许向设备会话发送消息（默认关，设备会话仅查看）。
const LS_ALLOW_DEVICE_SEND = "umbra.allowDeviceSend";
export function getAllowDeviceSend(): boolean {
  return localStorage.getItem(LS_ALLOW_DEVICE_SEND) === "1";
}
export function setAllowDeviceSend(v: boolean): void {
  localStorage.setItem(LS_ALLOW_DEVICE_SEND, v ? "1" : "0");
}

export interface Job {
  id: string;
  goal: string;
  status: string; // pending/running/done/failed/cancelled
  result_summary?: string | null;
  channel?: string | null;
  created_at?: string;
  updated_at?: string;
}
export interface Subtask {
  id: string;
  seq: number;
  title?: string | null;
  provider?: string | null;
  skill?: string | null;
  status: string; // pending/dispatched/running/done/failed
  result_json?: string | null;
  error?: string | null;
}
export interface JobEvent {
  id: number;
  type: string;
  message?: string | null;
  subtask_id?: string | null;
  created_at?: string;
}
export interface JobDetail {
  job: Job;
  subtasks: Subtask[];
  events: JobEvent[];
}

// 任务列表（最近 limit 条，按更新时间倒序）。
export async function fetchJobs(limit = 30): Promise<Job[]> {
  try {
    const r = await fetch(`${getServerUrl()}/jobs?limit=${limit}`);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

// 批量删除任务（全选/多选）。返回实际删除数量。
export async function deleteJobs(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  try {
    const r = await fetch(`${getServerUrl()}/jobs/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!r.ok) return 0;
    const data = await r.json();
    return typeof data?.deleted === "number" ? data.deleted : 0;
  } catch {
    return 0;
  }
}

// 单个任务详情（子任务 + 事件时间线）。
export async function fetchJobDetail(id: string): Promise<JobDetail | null> {
  try {
    const r = await fetch(`${getServerUrl()}/jobs/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export interface ChatHandlers {
  onStatus?: (s: ConnStatus) => void;
  onMessage?: (msg: any) => void;
}

// 单例聊天连接：跨页面切换保持，断线指数退避重连。
class ChatConnection {
  private ws: WebSocket | null = null;
  private handlers: ChatHandlers = {};
  private backoff = 1000;
  private timer: number | undefined;
  status: ConnStatus = "offline";

  setHandlers(h: ChatHandlers): void {
    this.handlers = h;
  }

  private setStatus(s: ConnStatus): void {
    this.status = s;
    this.handlers.onStatus?.(s);
  }

  connect(): void {
    this.close();
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // 守卫：只有仍是"当前连接"的回调才生效，避免 connect/reconnect 抖动时旧连接的 close
    // 回调误触发重连（会导致服务端一度存在多个 /ws/chat 连接、把自己的消息当"其它端"广播回来 → 消息重复）。
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.backoff = 1000;
      this.setStatus("online");
    });
    ws.addEventListener("message", (e) => {
      if (this.ws !== ws) return;
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.handlers.onMessage?.(msg);
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return; // 不是当前连接（被 connect/reconnect 主动替换）→ 不重连
      this.ws = null;
      this.setStatus("offline");
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  private scheduleReconnect(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }

  reconnect(): void {
    this.backoff = 1000;
    this.connect();
  }

  close(): void {
    clearTimeout(this.timer);
    if (this.ws) {
      const old = this.ws;
      this.ws = null; // 先置空，让 old 的 close 回调因守卫失配而不触发重连
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
  }

  private rawSend(obj: any): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  sendMessage(content: string): boolean {
    return this.rawSend({ type: "message", content, client_id: getClientId() });
  }

  sendConfirm(taskId: string, approved: boolean): boolean {
    return this.rawSend({ type: "job_confirm_response", task_id: taskId, approved });
  }

  // 紧急停止：让服务端中止正在运行的 operate 循环。
  sendOperateStop(): boolean {
    return this.rawSend({ type: "operate_stop" });
  }
}

export const chatConn = new ChatConnection();
