// 与 Umbra 服务端的连接层：配置 + /ws/chat WebSocket（自动重连）+ HTTP 拉取。
// 聊天协议与现有 Web 调试页一致，复用已验证的消息格式。

export type ConnStatus = "connecting" | "online" | "offline";

// 连接配置（服务器地址 / 令牌 / 设备名 / 客户端 ID）的**唯一真源是主进程**的 umbra-config.json。
// 桌面端启动时由 desktop.ts 灌进来，改配置也是「先写主进程、再回灌镜像」，渲染层只持有只读副本。
//
// 以前是两边各存一份（渲染层放 localStorage、主进程放配置文件），后果：
// - 同一个 serverUrl 有两个出处，改一处忘另一处就会出现「聊天连 A、主进程连 B」；
// - 令牌在 localStorage 里另存了一份明文，而渲染层压根不用它（HTTP 请求都不带 token）；
// - 客户端 ID 也各生成各的（渲染层 pc-xxxx、主进程 deviceId），日志里对不上号。
//
// localStorage 只留给**浏览器预览**（没有 window.umbra 的跑法）兜底。
const LS = {
  serverUrl: "umbra.serverUrl",
  clientId: "umbra.clientId",
  deviceName: "umbra.deviceName",
};
// 历史遗留：老版本把令牌明文存在这个键下。桌面端接管配置时顺手清掉，别留着。
const LEGACY_TOKEN_KEY = "umbra.token";

const DEFAULT_SERVER = "https://umbra.tingyusha.xyz";

// 主进程配置的渲染层镜像。null = 不是桌面端（浏览器预览），走 localStorage 兜底。
interface RuntimeConfig { serverUrl: string; deviceName: string; clientId: string; hasToken: boolean }
let runtime: RuntimeConfig | null = null;

// 桌面端专用：把主进程的公开配置灌进来。desktop.ts 在启动、回读、写配置之后都会调用。
export function adoptDesktopConfig(c: { serverUrl?: string; deviceId?: string; deviceName?: string; hasToken?: boolean }): void {
  runtime = {
    serverUrl: (c.serverUrl || DEFAULT_SERVER).replace(/\/+$/, ""),
    deviceName: c.deviceName || "此设备",
    // 客户端 ID 直接用主进程的 deviceId：聊天消息带的 client_id 与设备通道从此是同一个标识。
    clientId: c.deviceId || "pc",
    hasToken: !!c.hasToken,
  };
  try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch { /* 无痕模式等禁用 storage，忽略 */ }
}

export function getServerUrl(): string {
  if (runtime) return runtime.serverUrl;
  return (localStorage.getItem(LS.serverUrl) || DEFAULT_SERVER).replace(/\/+$/, "");
}
// 桌面端只更新镜像（真正落盘由 desktop.pushConfig 写主进程），浏览器预览下才写 localStorage。
export function setServerUrl(v: string): void {
  const s = v.trim().replace(/\/+$/, "");
  if (!s) return;
  if (runtime) { runtime.serverUrl = s; return; }
  localStorage.setItem(LS.serverUrl, s);
}
// 是否已配置令牌。令牌本身渲染层不持有 —— 它只在主进程发请求时用得到。
export function hasToken(): boolean {
  return runtime ? runtime.hasToken : false;
}
export function getClientId(): string {
  if (runtime) return runtime.clientId;
  let id = localStorage.getItem(LS.clientId);
  if (!id) {
    id = "pc-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(LS.clientId, id);
  }
  return id;
}
export function getDeviceName(): string {
  if (runtime) return runtime.deviceName;
  return localStorage.getItem(LS.deviceName) || "此设备";
}
export function setDeviceName(v: string): void {
  const s = v.trim();
  if (!s) return;
  if (runtime) { runtime.deviceName = s; return; }
  localStorage.setItem(LS.deviceName, s);
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

// 清空指定会话历史（默认主会话；传 device:<id> 清某设备房间）。返回删除条数。
export async function clearHistory(conversation = "assistant"): Promise<number> {
  try {
    const r = await fetch(`${getServerUrl()}/history/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 带上本端 id：服务端会把它原样放进 history_cleared 广播的 by 字段，
      // 让各端能认出「这条是我自己发起的」（见 app.py 的 /history/clear 注释）。
      body: JSON.stringify({ conversation, client_id: getClientId() }),
    });
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

// 在线设备列表。
export async function fetchDevices(): Promise<DeviceInfo[]> {
  try {
    const r = await fetch(`${getServerUrl()}/devices`);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

// 设备能力目录（程序 → 技能），设备详情页用；与 /capabilities 同一形状。
export interface DeviceSkill {
  name: string;
  description?: string;
}
export interface DeviceProvider {
  provider: string;
  display_name?: string;
  kind?: string;
  available?: boolean;
  unavailable_reason?: string;
  version?: string;
  skills?: DeviceSkill[];
}
// 已知设备（含离线）：聊天页的「联系人列表」。
export interface KnownDevice {
  device_id: string;
  device_name: string;
  platform: string;
  online: boolean;
  last_seen?: string | null;
  providers: DeviceProvider[];
}

export async function fetchAllDevices(): Promise<KnownDevice[]> {
  try {
    const r = await fetch(`${getServerUrl()}/devices/all`);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

// 把某台（离线的）设备从联系人列表移除；它下次上线会重新出现。
export async function forgetDevice(deviceId: string): Promise<boolean> {
  try {
    const r = await fetch(`${getServerUrl()}/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
    return r.ok;
  } catch {
    return false;
  }
}

// 设置：自动批准电脑操作授权（默认关；开启后确认卡自动批准，不再每次询问）。
const LS_AUTO_APPROVE_OPERATE = "umbra.autoApproveOperate";
export function getAutoApproveOperate(): boolean {
  return localStorage.getItem(LS_AUTO_APPROVE_OPERATE) === "1";
}
export function setAutoApproveOperate(v: boolean): void {
  localStorage.setItem(LS_AUTO_APPROVE_OPERATE, v ? "1" : "0");
}

export interface Job {
  id: string;
  // 新任务模型：name=短标题（列表主展示），goal=详细描述（副行）。旧数据 name 为空 → 回退显示 goal。
  name?: string | null;
  goal: string;
  status: string; // pending/running/done/failed/cancelled
  result_summary?: string | null;
  channel?: string | null;
  created_at?: string;
  updated_at?: string;
  // 代理任务（可追问的长任务）：kind='agent'；agent_state=working/idle/suspended/closed。
  // idle = 干完一轮、**等你确认**（改还是收工）——这才是它真实的状态，不是「执行中」。
  kind?: string;
  agent_state?: string | null;
  // 新任务模型（tasks 表）在 /jobs 列表里附带的里程碑进度：done/total。
  // 旧 Job 行没有这两个字段 → 列表行不显示进度条（显示不准不如不显示）。
  steps_total?: number;
  steps_done?: number;
  is_task?: boolean;
  // 所属工作区的名字（tasks.project）。旧 Job 行没有项目概念，恒为空。
  project?: string | null;
  // 验收清单：服务端存的是 JSON 文本（`["…","…"]`），这里原样透传，由界面解析。
  // 解析放界面而不是这里，是因为脏数据只该影响那一块的渲染，不该让整个详情挂掉。
  checklist?: string | null;
  // 已用掉的自动纠错回合数（验收没过时秘书会自己补做几轮）。0 或缺省 = 一次都没补过。
  fix_rounds?: number;
}
// 一步失败时的结构化错误。kind 决定界面怎么归类：
// step_error=执行轮自己抛的异常 · device_error=设备报错 · timeout=看门狗判定卡住（此时步骤仍在跑）。
export interface StepError {
  kind: string;
  message: string;
  detail?: string;
}
// 一条产物。bytes 由设备写文件时回报 —— 服务端拿不到大小（文件在设备的项目目录里），
// 所以它可能是 null，界面要能显示破折号而不是 0 B。
export interface StepArtifact {
  path: string;
  bytes?: number | null;
}
export interface Subtask {
  id: string;
  seq: number;
  title?: string | null;
  provider?: string | null;
  skill?: string | null;
  status: string; // pending/dispatched/running/done/failed
  /** 这一步实际干了什么，引擎自己写的一句人话（tasks_engine 的 update_step_status(detail=...)）。
   *
   *  服务端一直在写、`_step_as_subtask` 一直在回，但这个字段以前**根本没声明**，
   *  于是 PC 端整层「每步在干什么」的信息凭空消失了 —— 步骤列表只剩一行标题，
   *  「设备不在线，挂起等待」「检查点直过：未注入执行轮」这种关键说明全看不到。
   *  和 error.detail 不是一回事：那个是失败时的原始错误文本，这个是正常流程的说明。 */
  detail?: string | null;
  result_json?: string | null;
  // 新任务的里程碑回结构化对象；旧 Job 的 subtask 回的是一串自由文本。两种都要认。
  error?: string | StepError | null;
  // ↓ 以下四项只有新任务（is_task）才有，旧 Job 一律缺省。
  device_id?: string | null;   // 这一步派给了哪台设备；server 步没有设备，空串
  started_at?: string | null;  // 真正开始执行的时刻（不是排里程碑的时刻）
  elapsed_ms?: number | null;  // 本步耗时；没开始过时为 null，界面显示破折号
  artifacts?: StepArtifact[];
  artifacts_bytes?: number;    // 本步产物字节合计（bytes 缺失的条目不计入）
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
// ── 用户画像（服务端 data/user_profile.md）：设置页查看/编辑/重置 ─────────────
export async function fetchProfile(): Promise<string> {
  try {
    const r = await fetch(`${getServerUrl()}/profile`);
    if (!r.ok) return "";
    return (await r.json()).markdown || "";
  } catch {
    return "";
  }
}
// 保存编辑后的画像（整篇覆盖）。返回服务端落盘后的内容；失败返回 null。
export async function saveProfile(markdown: string): Promise<string | null> {
  try {
    const r = await fetch(`${getServerUrl()}/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown }),
    });
    if (!r.ok) return null;
    return (await r.json()).markdown ?? "";
  } catch {
    return null;
  }
}
// 重置画像为空白模板（画像积累错误认知时一键清掉）。失败返回 null。
export async function resetProfile(): Promise<string | null> {
  try {
    const r = await fetch(`${getServerUrl()}/profile`, { method: "DELETE" });
    if (!r.ok) return null;
    return (await r.json()).markdown ?? "";
  } catch {
    return null;
  }
}

export async function fetchJobs(limit = 30): Promise<Job[]> {
  try {
    const r = await fetch(`${getServerUrl()}/jobs?limit=${limit}`);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

// 某个工作区（= 项目名）下的任务。过滤在服务端做（/jobs?project=），
// 不把全部任务拉回客户端再筛 —— 任务多了那样会越来越慢。
export async function fetchJobsByProject(project: string, limit = 20): Promise<Job[]> {
  if (!project) return [];
  try {
    const r = await fetch(`${getServerUrl()}/jobs?limit=${limit}&project=${encodeURIComponent(project)}`);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

// 停止一个正在跑/挂起中的任务。服务端两种任务都认（新任务走取消，旧 operate Job 走停止请求）。
// 返回是否成功；失败原因交给调用方提示（这里不弹窗，任务面板自己有提示位）。
export async function stopJob(id: string): Promise<{ ok: boolean; error: string }> {
  try {
    const r = await fetch(`${getServerUrl()}/jobs/${encodeURIComponent(id)}/stop`, { method: "POST" });
    if (!r.ok) return { ok: false, error: await errText(r) };
    return { ok: true, error: "" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// 重试任务：从失败的那一步继续（已完成的里程碑保留不重做）。
// 409 = 当前状态不能重试（比如任务还在跑，或者已经做完了）——这类错误要原样告诉用户。
export async function retryJob(id: string): Promise<{ ok: boolean; error: string; kept?: number; total?: number }> {
  try {
    const r = await fetch(`${getServerUrl()}/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });
    if (!r.ok) return { ok: false, error: await errText(r) };
    const data = await r.json();
    return { ok: true, error: "", kept: data?.kept, total: data?.total };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// 从 FastAPI 的错误响应里取 detail；取不到就退回状态码，别让界面显示一句空话。
async function errText(r: Response): Promise<string> {
  try {
    const d = await r.json();
    if (d && typeof d.detail === "string" && d.detail) return d.detail;
  } catch { /* 不是 JSON 就算了 */ }
  return `HTTP ${r.status}`;
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

// ── 工作区（项目目录）─────────────────────────────────────────────────────────
export interface Workspace {
  id: string;
  name: string;
  device_id: string;
  dir: string | null;
  description: string | null;
  origin: string; // auto=任务自动建 / manual=手动新增
  task_count: number;
  last_goal: string | null;
  last_active_at: string;
}

// 改工作区描述（服务端 PATCH /workspaces/{id}）。返回更新后的行，失败返回 null。
export async function updateWorkspaceDesc(id: string, description: string): Promise<Workspace | null> {
  try {
    const r = await fetch(`${getServerUrl()}/workspaces/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: description || null }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// 工作区列表（可只看某设备的）。
export async function fetchWorkspaces(deviceId?: string): Promise<Workspace[]> {
  try {
    const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
    const r = await fetch(`${getServerUrl()}/workspaces${q}`);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

// 手动新增工作区（可自定义路径）。成功返回记录，失败返回 {error}。
export async function createWorkspace(
  name: string, deviceId: string, dir?: string, description?: string,
): Promise<Workspace | { error: string }> {
  try {
    const r = await fetch(`${getServerUrl()}/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, device_id: deviceId, dir: dir || null, description: description || null }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      return { error: (d && d.detail) || `HTTP ${r.status}` };
    }
    return await r.json();
  } catch (e) {
    return { error: String(e) };
  }
}

// 移除工作区。purge=true 时同时派发设备删除目录内所有文件。
export async function deleteWorkspace(
  id: string, purge: boolean,
): Promise<{ removed: number; purged: boolean; purge_error: string | null } | null> {
  try {
    const r = await fetch(`${getServerUrl()}/workspaces/${encodeURIComponent(id)}?purge=${purge}`, {
      method: "DELETE",
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
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

// ── 灵感速记（/inspirations）────────────────────────────────────────────────
export interface Inspiration {
  id: number;
  raw: string;
  title: string;
  summary: string;
  tags: string[];
  status: string; // open/done/archived
  source_channel?: string;
  job_id?: string; // 已落地成任务时指向 tasks.id；空串表示没关联
  created_at?: string;
  updated_at?: string;

  // 下面四个都是**可选**：连到还没升级的服务端时字段是缺的。
  // 界面一律走 organizeStateOf / researchStateOf 取值，别直接读裸字段。
  /** pending 待补整理 | done 已整理 | failed 整理失败 */
  organize_status?: string;
  /** 轻调研纪要（Markdown）。没查过是空串 */
  research?: string;
  /** idle | queued | running | done | failed */
  research_status?: string;
  research_at?: string;
}

export const organizeStateOf = (i: Inspiration): string => i.organize_status || "done";
export const researchStateOf = (i: Inspiration): string => i.research_status || "idle";
export const researchInFlight = (i: Inspiration): boolean => {
  const s = researchStateOf(i);
  return s === "queued" || s === "running";
};

// 各状态的灵感条数。筛选栏要同时显示四个数字，列表接口按 status 查不出来。
export interface InspirationCounts {
  all: number;
  open: number;
  done: number;
  archived: number;
}

// 返回 null 表示这个接口不可用（服务端还没升级到带计数的版本），
// 由调用方决定怎么兜底——直接给一串 0 会让筛选栏看起来像「一条灵感都没有」。
export async function fetchInspirationCounts(): Promise<InspirationCounts | null> {
  try {
    const r = await fetch(`${getServerUrl()}/inspirations/counts`);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || typeof j.all !== "number") return null;
    return { all: 0, open: 0, done: 0, archived: 0, ...j };
  } catch {
    return null;
  }
}

export async function fetchInspirations(status?: string): Promise<Inspiration[]> {
  try {
    const q = status ? `?status=${encodeURIComponent(status)}` : "";
    const r = await fetch(`${getServerUrl()}/inspirations${q}`);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

export async function createInspiration(body: {
  raw: string;
  title?: string;
  summary?: string;
  tags?: string[];
  /** 顺便让秘书查一查。**默认不查**——每条都自动查会烧 token，
   *  灵感列表也会变成一堆没人读的半成品报告。 */
  research?: boolean;
}): Promise<Inspiration | null> {
  try {
    const r = await fetch(`${getServerUrl()}/inspirations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function updateInspiration(
  id: number,
  patch: Partial<Pick<Inspiration, "raw" | "title" | "summary" | "tags" | "status" | "job_id">>,
): Promise<Inspiration | null> {
  try {
    const r = await fetch(`${getServerUrl()}/inspirations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** 「帮我查查」：把这条排进调研队列。
 *
 * 只排队不等结果 —— 一轮调研（搜索 + 模型汇总）几十秒，HTTP 上干等必然超时。
 * 返回的是刚置成 queued 的那条；进度靠 shell 那边 5 秒一轮的轮询拉回来。
 * 返回 null = 没排上（服务端旧版没这个路由，或网络断了），调用方要如实提示。
 */
export async function requestInspirationResearch(id: number): Promise<Inspiration | null> {
  try {
    const r = await fetch(`${getServerUrl()}/inspirations/${id}/research`, { method: "POST" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function deleteInspirations(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  try {
    const r = await fetch(`${getServerUrl()}/inspirations/delete`, {
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

  // conversation：'assistant' 主会话；'device:<id>' = 在某台设备的聊天窗口里说话
  //（服务端会把「目标设备=这台」作为上下文，端侧任务直接派给它）。
  // mode：三态开关 auto/chat/execution（输入框旁的「自动/聊天/执行」切换）。
  sendMessage(content: string, autoApproveOperate = false, conversation = "assistant", mode = "auto"): boolean {
    return this.rawSend({
      type: "message", content, client_id: getClientId(),
      auto_approve_operate: autoApproveOperate, conversation, mode,
    });
  }

  sendConfirm(taskId: string, approved: boolean): boolean {
    return this.rawSend({ type: "job_confirm_response", task_id: taskId, approved });
  }

  // 问答卡：多题答完后一次性提交（秘书在派活前把歧义问清楚）。
  sendAnswers(cardId: string, answers: Record<string, string[]>): boolean {
    return this.rawSend({ type: "question_answer", card_id: cardId, answers });
  }

  // 紧急停止：让服务端中止正在运行的 operate 循环。
  sendOperateStop(): boolean {
    return this.rawSend({ type: "operate_stop" });
  }

  // 电脑操作「人工求助」的回传。服务端（operate.py on_locate_response）认四种，
  // 按优先级依次判断：paused > feedback > cancelled > 坐标。所以这里只传其中一种，
  // 别一次带两个字段 —— 服务端不会合并，只会按它的顺序取第一个命中的。
  //
  // nx/ny 是**归一化到 0-1000** 的整数，不是像素：截图分辨率因设备而异，
  // 传像素的话服务端还得知道原图尺寸才能还原。
  sendLocate(taskId: string, body: { nx?: number; ny?: number; feedback?: string; paused?: boolean; cancelled?: boolean }): boolean {
    return this.rawSend({ type: "operate_locate_response", task_id: taskId, ...body });
  }

  // 用户「暂停我来」自己处理完，点「继续」→ 唤醒挂起的任务，AI 重新看屏接着干。
  // 注意它按 job_id 走，不是 task_id（一个 job 可能求助过好几次）。
  sendOperateResume(jobId: string): boolean {
    return this.rawSend({ type: "operate_resume", job_id: jobId });
  }
}

export const chatConn = new ChatConnection();
