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
}

// 拉历史：limit 条；传 beforeId 取更早一页（上拉加载）。
export async function fetchHistory(limit = 20, beforeId?: number): Promise<HistoryRow[]> {
  try {
    const q = `?limit=${limit}` + (beforeId ? `&before_id=${beforeId}` : "");
    const r = await fetch(`${getServerUrl()}/history${q}`);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
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
    ws.addEventListener("open", () => {
      this.backoff = 1000;
      this.setStatus("online");
    });
    ws.addEventListener("message", (e) => {
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.handlers.onMessage?.(msg);
    });
    ws.addEventListener("close", () => {
      this.ws = null;
      this.setStatus("offline");
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => ws.close());
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
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
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
