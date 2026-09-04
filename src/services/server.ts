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

// 消息的引用注脚（批次 011 消息菜单）：气泡顶部的被引用块 / 输入框上方的引用条都用它。
export interface MsgQuote { id?: number; role: string; text: string }
// 消息附加信息（服务端 meta JSON 列）：取消收尾的标注、执行过的工具清单、引用。
export interface MsgMeta {
  interrupted?: boolean;                      // 流式中停：半截保留，时间戳后缀「已中断」
  cancelled?: boolean;                        // 占位阶段停：这行是系统提示
  tools?: { name: string; args?: string }[];  // 停之前已执行的工具（琥珀行靠它说得具体）
  quote?: MsgQuote;
}

export interface HistoryRow {
  id: number;
  role: string;
  content: string;
  created_at?: string;
  conversation?: string;
  /** text / image（atts 是文件 id）/ system（取消提示这类系统行）。老服务端没有 → 当 text。 */
  kind?: string;
  atts?: string[];
  meta?: MsgMeta;
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

export interface TaskItem {
  id: string;
  // 新任务模型：name=短标题（列表主展示），goal=详细描述（副行）。旧数据 name 为空 → 回退显示 goal。
  name?: string | null;
  goal: string;
  status: string; // pending/running/done/failed/cancelled
  result_summary?: string | null;
  channel?: string | null;
  created_at?: string;
  updated_at?: string;
  // 里程碑进度：done/total（列表行的进度条）。
  steps_total?: number;
  steps_done?: number;
  // 所属工作区的名字（tasks.project）。
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
export interface TaskStep {
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
  error?: string | StepError | null;
  device_id?: string | null;   // 这一步派给了哪台设备；server 步没有设备，空串
  started_at?: string | null;  // 真正开始执行的时刻（不是排里程碑的时刻）
  elapsed_ms?: number | null;  // 本步耗时；没开始过时为 null，界面显示破折号
  artifacts?: StepArtifact[];
  artifacts_bytes?: number;    // 本步产物字节合计（bytes 缺失的条目不计入）
}
export interface TaskEvent {
  id: number;
  type: string;
  message?: string | null;
  // 事件挂在哪一步上（可空）。原来声明成 subtask_id，服务端实际给的键一直是 step_id。
  step_id?: string | null;
  created_at?: string;
}
export interface TaskDetail {
  // B 批改名：键名跟着任务模型走（原 {job, subtasks, events}）。
  task: TaskItem;
  steps: TaskStep[];
  events: TaskEvent[];
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

export async function fetchTasks(limit = 30): Promise<TaskItem[]> {
  try {
    const r = await fetch(`${getServerUrl()}/tasks?limit=${limit}`);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

// 某个工作区（= 项目名）下的任务。过滤在服务端做（/tasks?project=），
// 不把全部任务拉回客户端再筛 —— 任务多了那样会越来越慢。
export async function fetchTasksByProject(project: string, limit = 20): Promise<TaskItem[]> {
  if (!project) return [];
  try {
    const r = await fetch(`${getServerUrl()}/tasks?limit=${limit}&project=${encodeURIComponent(project)}`);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

// 停止一个正在跑/挂起中的任务（电脑操控任务也认：服务端先唤醒它的等待再收尾）。
// 返回是否成功；失败原因交给调用方提示（这里不弹窗，任务面板自己有提示位）。
export async function stopTask(id: string): Promise<{ ok: boolean; error: string }> {
  try {
    const r = await fetch(`${getServerUrl()}/tasks/${encodeURIComponent(id)}/stop`, { method: "POST" });
    if (!r.ok) return { ok: false, error: await errText(r) };
    return { ok: true, error: "" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// 重试任务：从失败的那一步继续（已完成的里程碑保留不重做）。
// 409 = 当前状态不能重试（比如任务还在跑，或者已经做完了）——这类错误要原样告诉用户。
export async function retryTask(id: string): Promise<{ ok: boolean; error: string; kept?: number; total?: number }> {
  try {
    const r = await fetch(`${getServerUrl()}/tasks/${encodeURIComponent(id)}/retry`, { method: "POST" });
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

// 批量删除任务（全选/多选）= **移进回收站**，保留 30 天。
//
// 返回 { deleted, busy }。busy 是「还在跑、删不掉」的那几个 id ——
// **调用方必须把它说出来**：服务端只删得动终态的任务（还在跑的要先停止），
// 删除数量比请求的少而界面上一声不吭，用户看到的就是「我点了删除，它没反应」。
export async function deleteTasks(ids: string[]): Promise<{ deleted: number; busy: string[] }> {
  if (!ids.length) return { deleted: 0, busy: [] };
  try {
    const r = await fetch(`${getServerUrl()}/tasks/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!r.ok) return { deleted: 0, busy: [] };
    const data = await r.json();
    return {
      deleted: typeof data?.deleted === "number" ? data.deleted : 0,
      busy: Array.isArray(data?.busy) ? (data.busy as string[]) : [],
    };
  } catch {
    return { deleted: 0, busy: [] };
  }
}

// ── 回收站 ───────────────────────────────────────────────────────────────────
// 这里只有**通用区**（灵感 / 任务 / 提醒，都存在服务端）。
// 保险箱那一区端到端加密、条目只在本机，走 vault 的 IPC，不经过这里 ——
// 服务端连它有几条都不知道。见 doc/回收站-实现方案.md §3。

/** kind 对外四种（操控记录在服务端就并进了 task）。money 是记账一期加的：
 *  流水删除也走统一回收站 —— 同一个产品里「删除」不该有两种下场（2026-08-24 拍板保留）。 */
export type TrashKind = "idea" | "task" | "reminder" | "money";

export interface TrashItem {
  kind: TrashKind;
  id: string | number;   // 灵感是自增整数，任务/提醒是 uuid 字符串
  title: string;
  deleted_at_ms: number;
  left_days: number;     // 服务端算好的，客户端不要自己再算一遍（两处算法迟早会差一天）
}

export interface TrashList {
  items: TrashItem[];
  counts: Record<TrashKind, number>;
  keep_days: number;
}

const EMPTY_TRASH: TrashList = {
  items: [], counts: { idea: 0, task: 0, reminder: 0, money: 0 }, keep_days: 30,
};

export async function fetchTrash(): Promise<TrashList> {
  try {
    const r = await fetch(`${getServerUrl()}/trash`);
    if (!r.ok) return EMPTY_TRASH;
    const d = await r.json();
    return {
      items: Array.isArray(d?.items) ? (d.items as TrashItem[]) : [],
      counts: d?.counts || EMPTY_TRASH.counts,
      keep_days: typeof d?.keep_days === "number" ? d.keep_days : 30,
    };
  } catch {
    return EMPTY_TRASH;
  }
}

/** 回收站的操作都按 {kind,id} 走：三类数据的 id 类型不一样，光给 id 服务端不知道去哪张表找。 */
export type TrashEntry = { kind: TrashKind; id: string | number };

async function trashAction(path: string, body: unknown): Promise<number> {
  try {
    const r = await fetch(`${getServerUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return 0;
    const d = await r.json();
    return typeof d?.restored === "number" ? d.restored
      : typeof d?.purged === "number" ? d.purged : 0;
  } catch {
    return 0;
  }
}

/** 恢复：条目回到原来的位置，状态原样保留（不会被复位成「待办」）。 */
export function restoreTrash(entries: TrashEntry[]): Promise<number> {
  return entries.length ? trashAction("/trash/restore", { entries }) : Promise.resolve(0);
}

/** 彻底删除：不进任何地方，也没有恢复的路。 */
export function purgeTrash(entries: TrashEntry[]): Promise<number> {
  return entries.length ? trashAction("/trash/purge", { entries }) : Promise.resolve(0);
}

/** 清空回收站。**只清通用区** —— 保险箱那一区服务端动不了，要解锁后单独清。 */
export function purgeAllTrash(): Promise<number> {
  return trashAction("/trash/purge", { all: true });
}

// ── 记账 ─────────────────────────────────────────────────────────────────────
// 字段名照抄服务端 JSON（拍板 D2：服务端定一份正本，两端照它落表与序列化，
// 不做 CodingKeys / 重命名层 —— 改字段时少一处能漏）。
//
// 这一节的取数函数在网络失败时回 **null 而不是空值**，跟 fetchTrash 那套不一样：
// 记账稿给「连不上服务端」画了独立的错误态（横幅 + 重试），空列表和连不上
// 必须分得开 —— 回空数组的话，断网会被渲染成「这个月还没有记账」，那是在说假话。

export interface MoneyCat {
  slug: string;          // 稳定标识，永不变：流水里存的是它
  name: string;          // 显示名，可改；改名不影响历史数据
  direction: "expense" | "income";
  slot: number;          // 0 = 无色槽（图表里中性灰），1–7 / 9 / 10 彩色
  seq: number;
  enabled: boolean;
  locked: boolean;       // other / other_in：兜底分类，不可停用
  /** 图标语义名（批次 004：新增分类弹窗挑的那个，gift / pet / …）。
   *  '' 或缺失 = 没挑过，按 slug 兜底 —— 内置分类走的就是这条路。 */
  icon?: string;
  /** 二级分类（第二批起服务端落库，随分类下发）。可选：老服务端没有这个字段。 */
  subs?: string[];
}

/** 一个子类（管理页视角）。used 按**全部历史**数 —— 删除确认说的是
 *  这个子类名下一共有多少账，跟停用分类那句「本月」是两个口径（稿如此）。 */
export interface MoneySub { label: string; used: number }

export interface MoneyEntry {
  id: string;            // 客户端生成（离线要能先记后同步）
  cents: number;         // 整数分。展示时才 /100
  direction: "expense" | "income";
  cat: string;           // 分类 slug
  sub: string;           // 二级，中文字符串不是 slug，可空
  merchant: string;      // 商家/备注（拍板 D1：一个字段）
  at_ms: number;
  tz_offset_min: number;
  ym: string;            // 服务端按 at_ms + tz_offset_min 算好的本地月
  src: "manual" | "shot" | "import" | "chat" | "recur";
  rule_id: string;
  batch_id: string;
  order_no: string;
  updated_at_ms: number;
  deleted: boolean;
  /** 附件（截图快捷记账的原图 + 手动加的图）。可选：老服务端没有这个字段。 */
  atts?: MoneyAtt[];
}

/** 一张账单附件。文件本体在服务端（GET /files/{file_id}），这里只有引用。 */
export interface MoneyAtt {
  file_id: string;
  label: string;
  /** 截图记账的原图：稿明写「一直留着，不能删」—— 它是这笔账的凭证。 */
  origin: boolean;
}

/** 一条周期规则（二期）。日期是 'YYYY-MM-DD' 文本 —— 「每月 31 号」的锚是
 *  首次日期的「31」，转时间戳这层日历语义就丢了。done_count / last_done_ms
 *  是服务端从流水现算的真值。 */
export interface MoneyRecur {
  id: string;
  name: string;
  cents: number;
  direction: "expense" | "income";
  cat: string;
  sub: string;
  merchant: string;
  cycle: "day" | "week" | "month" | "year";
  every_n: number;       // 每 N 个周期（D6 备用列，编辑器一期恒 1）
  week_day: number;      // cycle='week' 用，0=周一
  first_date: string;
  time_hhmm: string;
  tz_offset_min: number;
  end_kind: "never" | "date";   // 结束日期含当天
  end_date: string;
  next_date: string;     // '' = 到头了（过了结束日期）
  next_at_ms: number;
  paused: boolean;
  done_count: number;
  last_done_ms: number;
  updated_at_ms: number;
}

/** 当前筛选下的合计（服务端按**整个筛选结果**算，不是按页）。 */
export interface MoneyTotals { count: number; expense: number; income: number }

export interface MoneyStats {
  ym: string;
  expense: number;
  income: number;
  balance: number;
  by_cat: { cat: string; cents: number; count: number }[];   // 只含支出，金额降序
  prev_ym: string;
  /** null = 上月**没有记录**，无法对比（跟「上月花了 0」是两回事，别画箭头）。 */
  prev_expense: number | null;
  trend: { ym: string; cents: number }[];                    // 老→新，含当月
}

export async function fetchMoneyCats(includeDisabled = false): Promise<MoneyCat[] | null> {
  try {
    const r = await fetch(`${getServerUrl()}/money/categories${includeDisabled ? "?include_disabled=true" : ""}`);
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d) ? (d as MoneyCat[]) : null;
  } catch {
    return null;
  }
}

/** 新增分类（批次 004 弹窗）。slug 服务端生成；名字全局查重（弹窗里先本地查，
 *  这里的 null 只兜「并发另一端刚建了同名」这类漏网）。icon 是图标语义名，可空。 */
export async function createMoneyCat(
  name: string,
  direction: "expense" | "income",
  icon: string,
): Promise<MoneyCat | null> {
  try {
    const r = await fetch(`${getServerUrl()}/money/categories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, direction, icon }),
    });
    if (!r.ok) return null;
    return (await r.json()) as MoneyCat;
  } catch {
    return null;
  }
}

/** 改分类（改名 / 换色槽 / 停用启用 / 改图标）。slug 不可改 —— 它是流水指过来的
 *  稳定标识。icon 传语义名（批次 006「改图标」弹层）；空串 = 清掉回 slug 兜底。 */
export async function updateMoneyCat(
  slug: string,
  patch: { name?: string; slot?: number; enabled?: boolean; icon?: string },
): Promise<MoneyCat | null> {
  try {
    const r = await fetch(`${getServerUrl()}/money/categories/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) return null;
    return (await r.json()) as MoneyCat;
  } catch {
    return null;
  }
}

/** 某个月的全部流水（一期界面只看本月，筛选在客户端做 —— 一个月几百条，
 *  全量拉回来本地过滤，输入即响应；服务端的 direction/cat/keyword 参数留给
 *  iOS 和将来分页用，见拍板 D4）。 */
export async function fetchMoneyEntries(ym: string): Promise<{ items: MoneyEntry[]; totals: MoneyTotals } | null> {
  try {
    const r = await fetch(`${getServerUrl()}/money/entries?ym=${encodeURIComponent(ym)}&limit=1000`);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || !Array.isArray(d.items)) return null;
    return d as { items: MoneyEntry[]; totals: MoneyTotals };
  } catch {
    return null;
  }
}

/** 记一笔 / 改一笔。服务端逐条 last-write-wins，回 { entry, written }：
 *  written=false 表示库里那份更新、这次没写进去，界面要用回传的 entry 对齐。 */
export async function saveMoneyEntry(
  entry: Omit<MoneyEntry, "ym" | "deleted">,
): Promise<{ entry: MoneyEntry; written: boolean } | null> {
  try {
    const r = await fetch(`${getServerUrl()}/money/entries/${encodeURIComponent(entry.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || !d.entry) return null;
    return { entry: d.entry as MoneyEntry, written: !!d.written };
  } catch {
    return null;
  }
}

/** 删流水 = 移进回收站（保留 30 天，能在 设置→回收站 恢复）。返回删掉的条数。 */
export async function deleteMoneyEntries(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  try {
    const r = await fetch(`${getServerUrl()}/money/entries/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!r.ok) return 0;
    const d = await r.json();
    return typeof d?.deleted === "number" ? d.deleted : 0;
  } catch {
    return 0;
  }
}

/** 某个月的统计。服务端全部从流水现算 —— 没有汇总表，不存在「大数和明细对不上」。 */
export async function fetchMoneyStats(ym: string, trendMonths = 6): Promise<MoneyStats | null> {
  try {
    const r = await fetch(`${getServerUrl()}/money/stats?ym=${encodeURIComponent(ym)}&trend_months=${trendMonths}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || typeof d.expense !== "number") return null;
    return d as MoneyStats;
  } catch {
    return null;
  }
}

// ── 记账 · 子类管理（批次 004：PC 也能就地增删改，服务端 money_subs 是唯一正本）──

/** 某分类的子类 + 各自的在用笔数。展开管理区那一刻拉，别跟着分类列表常驻拉 ——
 *  with_used 要扫流水，16 个分类页面一开就全扫一遍纯属浪费。 */
export async function fetchMoneySubs(slug: string): Promise<MoneySub[] | null> {
  try {
    const r = await fetch(`${getServerUrl()}/money/categories/${encodeURIComponent(slug)}/subs?with_used=true`);
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d?.items) ? (d.items as MoneySub[]) : null;
  } catch {
    return null;
  }
}

/** 三个写操作共用一条 POST 通道。都成功后调用方**重新拉一次带 used 的列表**，
 *  而不是用响应里的 items —— 那份不带 used（服务端默认不算），拿去渲染会把
 *  「3 笔在用」全变成「未用过」。 */
async function postMoneySub(slug: string, path: string, body: Record<string, string>): Promise<boolean> {
  try {
    const r = await fetch(`${getServerUrl()}/money/categories/${encodeURIComponent(slug)}/subs${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}
export const addMoneySub = (slug: string, label: string) => postMoneySub(slug, "", { label });
export const renameMoneySub = (slug: string, old: string, next: string) => postMoneySub(slug, "/rename", { old, new: next });
export const deleteMoneySub = (slug: string, label: string) => postMoneySub(slug, "/delete", { label });

/** 附件图片的下载地址（GET /files/{id} 不鉴权，file_id 本身即凭证）。记账与提醒共用。 */
export function fileUrl(fileId: string): string {
  return `${getServerUrl()}/files/${encodeURIComponent(fileId)}`;
}
/** 传一张图上服务端，回 file_id（挂附件分两步：先传文件、再记引用）。记账与提醒共用。
 *  /files/upload 是这条链路里唯一带鉴权的接口 —— 桌面端从注册信息里拿 token
 *  （渲染层的公开配置刻意不含 token，而 getRegisterInfo 本来就带，设备配对页同款来源）；
 *  Web 版没有 token：服务端没配 assist_token 时照样能传，配了就 401 → 界面按失败提示。 */
export async function uploadFile(file: File): Promise<{ file_id: string; filename: string } | null> {
  try {
    const headers: Record<string, string> = {};
    const token = await window.umbra?.getRegisterInfo().then((r) => r.token).catch(() => "");
    if (token) headers["X-Umbra-Token"] = token;
    const fd = new FormData();
    fd.append("file", file, file.name);
    const r = await fetch(`${getServerUrl()}/files/upload`, { method: "POST", body: fd, headers });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.file_id ? { file_id: String(d.file_id), filename: String(d.filename || file.name) } : null;
  } catch {
    return null;
  }
}
/** 带进度 + 可中断的上传（批次 011 图片消息：气泡上要画**确定型**进度环 + 「取消上传」）。
 *  fetch 拿不到上传进度，这里用 XHR；abort() 后 promise 以 null 收场（和失败同形，
 *  调用方靠自己的状态区分「用户取消」与「真失败」——取消时它已经把气泡撤了）。 */
export function uploadFileProgress(
  file: File,
  onProgress: (loaded: number, total: number) => void,
): { promise: Promise<{ file_id: string; filename: string } | null>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  let aborted = false;
  const promise = (async () => {
    const token = await window.umbra?.getRegisterInfo().then((r) => r.token).catch(() => "");
    if (aborted) return null;
    return await new Promise<{ file_id: string; filename: string } | null>((resolve) => {
      xhr.open("POST", `${getServerUrl()}/files/upload`);
      if (token) xhr.setRequestHeader("X-Umbra-Token", token);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      xhr.onload = () => {
        try {
          const d = JSON.parse(xhr.responseText || "null");
          resolve(xhr.status >= 200 && xhr.status < 300 && d?.file_id
            ? { file_id: String(d.file_id), filename: String(d.filename || file.name) }
            : null);
        } catch { resolve(null); }
      };
      xhr.onerror = () => resolve(null);
      xhr.onabort = () => resolve(null);
      const fd = new FormData();
      fd.append("file", file, file.name);
      xhr.send(fd);
    });
  })();
  return { promise, abort: () => { aborted = true; try { xhr.abort(); } catch { /* 还没 open 就取消 */ } } };
}

/** 给一笔账挂上已上传的文件。服务端限一笔 4 张，超了回 400 → null。
 *  成功回这笔账**全量**的附件列表，界面直接用它对齐（别自己往数组里 push）。 */
export async function addMoneyAtt(entryId: string, fileId: string, label: string): Promise<MoneyAtt[] | null> {
  try {
    const r = await fetch(`${getServerUrl()}/money/entries/${encodeURIComponent(entryId)}/atts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId, label }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d?.atts) ? (d.atts as MoneyAtt[]) : null;
  } catch {
    return null;
  }
}

/** 摘一张附件。原图（origin）服务端会拒 —— 界面本来就不给它删除键。 */
export async function deleteMoneyAtt(entryId: string, fileId: string): Promise<boolean> {
  try {
    const r = await fetch(`${getServerUrl()}/money/entries/${encodeURIComponent(entryId)}/atts/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ── 记账 · 周期规则（二期）。触发在服务端（拍板 D5）：这里只管规则的增删改停，
// 到点写流水、停机补记都是服务端看门狗的事。

export async function fetchMoneyRecur(): Promise<MoneyRecur[] | null> {
  try {
    const r = await fetch(`${getServerUrl()}/money/recur`);
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d?.items) ? (d.items as MoneyRecur[]) : null;
  } catch {
    return null;
  }
}

/** 建/改一条规则。改动只影响以后的（服务端重算下一次，已生成流水不动）。 */
export async function putMoneyRecur(
  id: string,
  body: Record<string, unknown>,
): Promise<MoneyRecur | null> {
  try {
    const r = await fetch(`${getServerUrl()}/money/recur/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return (d?.rule as MoneyRecur) || null;
  } catch {
    return null;
  }
}

/** 停止/重新开始。恢复**不补停用期间的账**（服务端语义，稿的开关文案就是这么说的）。 */
export async function pauseMoneyRecur(id: string, paused: boolean): Promise<boolean> {
  try {
    const r = await fetch(`${getServerUrl()}/money/recur/${encodeURIComponent(id)}/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** 删规则不删已生成的流水（稿：那些是真花过的钱）。 */
export async function deleteMoneyRecur(id: string): Promise<boolean> {
  try {
    const r = await fetch(`${getServerUrl()}/money/recur/${encodeURIComponent(id)}`, { method: "DELETE" });
    return r.ok;
  } catch {
    return false;
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
export async function fetchTaskDetail(id: string): Promise<TaskDetail | null> {
  try {
    const r = await fetch(`${getServerUrl()}/tasks/${encodeURIComponent(id)}`);
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
  task_id?: string; // 已落地成任务时指向 tasks.id；空串表示没关联（B 批改名，原 job_id）
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
  patch: Partial<Pick<Inspiration, "raw" | "title" | "summary" | "tags" | "status" | "task_id">>,
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
  // quote：引用注脚（批次 011）——服务端落进这条消息的 meta.quote 并随广播带给各端。
  sendMessage(content: string, autoApproveOperate = false, conversation = "assistant", mode = "auto", quote?: MsgQuote): boolean {
    return this.rawSend({
      type: "message", content, client_id: getClientId(),
      auto_approve_operate: autoApproveOperate, conversation, mode,
      ...(quote ? { quote } : {}),
    });
  }

  // 图片消息（批次 011）：文件已先走 POST /files/upload 拿到 file_id，这里只送 id 列表。
  // 服务端落库 + 跨端广播，不触发秘书回复（一期不识图）；回执是 message_saved（带消息 id）。
  sendImageMessage(atts: string[], conversation = "assistant"): boolean {
    return this.rawSend({
      type: "message", kind: "image", atts, client_id: getClientId(), conversation,
    });
  }

  // 停掉正在处理的回复（批次 011 稿①）：服务端取消该会话在跑的那条 process_message，
  // 收尾（半截落库 / 系统提示行 / 工具清单）由服务端做完后以 reply_cancelled 事件回来。
  sendCancelReply(conversation = "assistant"): boolean {
    return this.rawSend({ type: "chat_cancel", conversation });
  }

  // 删一条消息（批次 011 稿②）：服务端软删进回收站（30 天），随后广播 message_deleted 给所有端。
  sendDeleteMessage(messageId: number): boolean {
    return this.rawSend({ type: "message_delete", id: messageId });
  }

  sendConfirm(confirmId: string, approved: boolean): boolean {
    // B 批改名：确认单号叫 confirm_id，不再冒充任务 id。
    return this.rawSend({ type: "confirm_response", confirm_id: confirmId, approved });
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
  sendLocate(askId: string, body: { nx?: number; ny?: number; feedback?: string; paused?: boolean; cancelled?: boolean }): boolean {
    return this.rawSend({ type: "operate_locate_response", ask_id: askId, ...body });
  }

  // 用户「暂停我来」自己处理完，点「继续」→ 唤醒挂起的任务，AI 重新看屏接着干。
  // 注意它按 run_id 走，不是 task_id（一次操控可能求助过好几次，续跑要对准这一次）。
  sendOperateResume(runId: string): boolean {
    return this.rawSend({ type: "operate_resume", run_id: runId });
  }
}

export const chatConn = new ChatConnection();
