// 实时聊天：连接 /ws/chat，按现有协议驱动设计稿里的聊天组件
// （流式回复、工具轨迹、任务进度卡、执行前确认、完成通知、图片预览、跨端同步）。
//
// 微信式三栏（Phase 3）：
//   左：联系人列表 —— 秘书 + 所有已知设备（在线绿点 / 离线灰点、最后一条消息、未读点）
//   中：聊天详情   —— 会话消息；输入框**只在主会话（与秘书）显示**，设备会话是
//                    秘书↔设备交互流水（只读，秘书请求靠左、设备回应靠右）
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
  retryTask,
  getServerUrl,
  getClientId,
  getAutoApproveOperate,
  setAutoApproveOperate,
  type KnownDevice,
} from "../../services/server";
import { getDesktopConfig } from "../../services/desktop";
import { hasNotify, notifyApi } from "../notify/bridge";
import { mdToHtml } from "./markdown";
import { t } from "../../i18n";
import { askConfirm, showToast } from "../../components/overlay";
// 这一层是 vanilla，用不了 React 组件，但**用得了样式工厂** —— kit 返回的是 Tailwind
// 类名字符串，拼进 class="" 就行。类名字面量在 kit.ts 里，JIT 照样能扫到并生成。
// 于是按钮这类有工厂对应件的元素不必再手写内联 style，取值也就跟着设计稿走了。
import { btn, btnWide } from "../../components/kit";

type Block =
  | { kind: "user"; text: string; ts?: string | number }
  | { kind: "assistant"; thinking: boolean; streaming: boolean; text: string; trace: string[]; traceOpen: boolean; ts?: string | number }
  | { kind: "device"; text: string; ts?: string | number }
  // 任务进度卡（task_update）：引擎里程碑 + 电脑操控共用。kind 沿用 "job" 只是
  // 界面层的历史名（连着 i18n 的 chat.job* 文案键），线上协议已全部是 task_id。
  // confirmId 是嵌在卡里的授权单号（operate 的 confirm_id），不是任务 id。
  | { kind: "job"; taskId: string; goal: string; pct: number; status: string; message: string; confirmId?: string; confirmScope?: string; results?: { title: string; url: string }[] }
  | { kind: "done"; goal: string; results: { title: string; url: string }[] }
  | { kind: "confirm"; confirmId: string; summary: string; detail?: unknown; scope?: string; resolved?: "approved" | "denied" }
  // 问答卡：秘书在派活前把歧义问清楚（多题、单选/多选、可自定义、逐题推进、统一提交）。
  | { kind: "question"; cardId: string; title: string; questions: QCard[]; at: number; picked: Record<string, string[]>; custom: Record<string, string>; done?: boolean }
  // 系统提示行（稿 1412-1413）：居中的一颗小灰胶囊，说明「不是你干的、但这里变了」。
  // 目前只有一个来源：别的端清空了这段历史。没有它的话，聊天窗会毫无征兆地整个变空。
  | { kind: "system"; text: string; ts?: string | number }
  // 「找位置」卡（稿 1645-1670）：电脑操作时模型反复定位不准，停下来请你指一下。
  // 服务端一直支持（operate.py `_locate_with_user`），iOS 也早就做了（LocateCard.swift），
  // **只有 PC 端一直没接** —— 后果是 operate 卡住时 PC 上什么都不显示，
  // 用户看着任务停在那儿，直到服务端 LOCATE_TIMEOUT 到点自己放弃。
  | {
      kind: "locate";
      askId: string;  // 这次求助的单号（回答用它）；一次操控可能求助多次，每次一个
      runId: string;  // 这次操控运行的编号（「暂停后继续」用它）
      imageUrl: string;
      target: string;
      hint: string;
      nx?: number; ny?: number;          // 已选中的点，归一化 0-1000
      fbOpen?: boolean; fbText?: string; // 文字纠偏输入框
      resolved?: "located" | "feedback" | "paused" | "resumed";
    }
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
// 标题栏 ⋯ 溢出菜单是否展开。挂在模块上而不是 DOM 里，是因为 renderHeader 每次都重画
// innerHTML —— 存在 DOM 上会被自己擦掉。
let headMenuOpen = false;
// 点空白关菜单的 document 监听。存下引用是为了 unmount 时摘干净（聊天页会被反复挂载卸载，
// 不摘就会一次一个地攒在 document 上）。
let docClickHandler: (() => void) | null = null;

let container: HTMLElement | null = null;
let started = false;
let appRerender: (() => void) | null = null;
// 滚动策略：贴底时才跟随新消息，上滑查看历史时不打扰；forceScroll 用于发送/切换/首次加载强制到底。
let stick = true;
let forceScroll = false;
let loadingOlder = false;
// 输入草稿：按会话各存一份，切换联系人不串味。
const drafts: Record<string, string> = {};
// ── 「/」快捷输入（批次 005 落地；三态「模式」开关同批撤除）──────────────────
// 动作是把自然语言引向特定意图的**芯片**，不是结构化命令：发出去的永远是
// 「【动作名】+ 用户原文」，由秘书的语言理解接住 —— 所以这里不需要迷你表单，
// 将来 Skill / MCP 动态接入的动作也只要提供 图标/名称/说明/占位 四样就能进面板。
interface SlashAction {
  k: string;        // 动作 id（过滤时也当英文别名匹配）
  label: string;
  desc: string;
  params: string;   // 选中后输入框的灰色参数占位
  icon: string;     // 24×24 线性描边 path（取值照稿）
  tag?: string;     // Skill / MCP 胶囊标签（内建动作无）
}
// 目录做成函数而不是常量：label 走 i18n，语言切换后要取到新文案。
// 「接入的能力」组现在是空的 —— 稿里那三条（翻译/压缩视频/查天气）是示例，
// 没有真实后端能力之前不放假动作；组为空整组不渲染，接入后追加进来即可。
function slashCatalog(): { name: string; items: SlashAction[] }[] {
  return [
    { name: t("chat.slashGroupRecord"), items: [
      { k: "money", label: t("chat.slashMoney"), desc: t("chat.slashMoneyDesc"), params: t("chat.slashMoneyParams"),
        icon: "M5 4.5l7 9 7-9M8 13.5h8M8 17.5h8M12 13.5V21" },
      { k: "insp", label: t("chat.slashInsp"), desc: t("chat.slashInspDesc"), params: t("chat.slashInspParams"),
        icon: "M9.5 18h5M10.5 21.5h3M12 2.5a7 7 0 0 0-4 12.8V18h8v-2.7a7 7 0 0 0-4-12.8" },
      { k: "rem", label: t("chat.slashRem"), desc: t("chat.slashRemDesc"), params: t("chat.slashRemParams"),
        icon: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" },
    ] },
    { name: t("chat.slashGroupTask"), items: [
      { k: "task", label: t("chat.slashTask"), desc: t("chat.slashTaskDesc"), params: t("chat.slashTaskParams"),
        icon: "M9 11.5l3 3L22 5M21 12.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" },
    ] },
  ];
}
let chipAction: SlashAction | null = null; // 输入框左侧的前缀芯片（选中的动作）
let slashSel = 0;                          // 面板键盘选中下标（拉平序）
let slashDismissed = false;                // 「当普通消息发」：这段 / 开头文本不再弹面板
let ideaBanner: string | null = null;      // 灵感来源横幅文案（「知道了」可关）
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

// 任务卡「查看结果」要跳到任务页并展开那条任务，而那个能力在 shell.ts（openTaskFrom）。
// 这里不直接 import shell —— shell 已经 import 了 chat（sendText / setAppRerender），
// 反向再 import 就成了循环依赖。沿用 setAppRerender 同一套注入写法由 shell 回填。
let openTaskCb: ((taskId: string) => void) | null = null;
export function setOpenTask(cb: (taskId: string) => void): void {
  openTaskCb = cb;
}
// 斜杠面板空态的「去能力」要跳能力页，同 openTask 一样由 shell 注入（防循环依赖）。
let goNavCb: ((nav: string) => void) | null = null;
export function setGoNav(cb: (nav: string) => void): void {
  goNavCb = cb;
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
  // 设备上/下线是这条路进来的（device_presence 事件），消息区不重绘，
  // 所以离线横幅要在这里单独刷一次 —— 不然设备刚掉线，横幅要等到你发条消息才出现。
  refreshOfflineBar();
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

// 已自动批准过的确认单（confirm_id），避免重复发送。
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
function autoApproveIfEnabled(confirmId: string | undefined, scope?: string): void {
  if (!confirmId || autoApproved.has(confirmId) || scope === "agent" || !operateAutoApprove()) return;
  autoApproved.add(confirmId);
  chatConn.sendConfirm(confirmId, true);
  resolveConfirm(confirmId, true);
}

// 提醒变更 → 让主进程立刻拉一次。
//
// **为什么必须有这一下**：主进程的提醒同步是 5 分钟一轮（PULL_INTERVAL_MS）。
// 用户在聊天里说「5 分钟后提醒我」，秘书答应了，这台电脑却要到下一轮才知道有这条 ——
// 到点什么也不会响。服务端建/改/删完就广播，这里收到就同步。
//
// 攒 300ms 再发：秘书一次可能建好几条（每条一个广播），逐条同步纯属浪费。
// 只有桌面端有提醒模块，Web 端 hasNotify=false，整段跳过。
//
// ⚠️ 已知边界：/ws/chat 是 ensureStarted() 里连的，而它只在**首次进聊天页**时跑。
// 所以「开了 App 但一次都没点进聊天」的情况下收不到广播，提醒仍要等 5 分钟的定时拉。
// 实际影响很小（秘书建提醒时用户必然就在聊天页），真要补就得让 App 启动即连 —— 那是
// 另一个决定（会连带在启动时拉会话列表和历史），别顺手改。
let reminderSyncTimer: number | undefined;
function syncRemindersSoon(): void {
  if (!hasNotify) return;
  if (reminderSyncTimer !== undefined) clearTimeout(reminderSyncTimer);
  reminderSyncTimer = window.setTimeout(() => {
    reminderSyncTimer = undefined;
    void notifyApi().syncNow();
  }, 300);
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
    case "task_update": // 任务进度（引擎里程碑 + 电脑操控共用）：更新/新建进度卡
      target = handleTaskUpdate(msg);
      break;
    case "device_presence": {
      // 设备上/下线：刷新联系人列表（顺带更新能力目录）。
      loadDevices();
      return;
    }
    case "reminder_updated":
    case "reminder_deleted": {
      // 提醒被任一端（含秘书自己）建/改/撤 → 立刻同步，别等下一轮。
      // return 不 break：这类事件不属于任何聊天会话，不该走后面的重绘。
      syncRemindersSoon();
      return;
    }
    case "device_message": {
      // 服务端↔设备的直接交互（不属于任何任务卡），落到对应设备会话。
      const s = cs(target);
      const ts = msg.created_at || Date.now();
      if (msg.role === "device") s.blocks.push({ kind: "device", text: msg.text || "", ts });
      else s.blocks.push({ kind: "assistant", thinking: false, streaming: false, text: msg.text || "", trace: [], traceOpen: false, ts });
      s.lastText = msg.text || "";
      s.lastAt = ts;
      break;
    }
    case "confirm_request":
      // 执行前授权卡：落在事件所属会话，供用户处理。confirm_id 是这张卡的单号
      //（B 批改名：原来叫 task_id，和真正的任务 id 一直在打架）。
      if (msg.confirm_id) {
        const s = cs(target);
        if (!s.blocks.some((b) => b.kind === "confirm" && b.confirmId === msg.confirm_id)) {
          s.blocks.push({ kind: "confirm", confirmId: msg.confirm_id, summary: msg.summary || t("chat.needConfirm"), detail: msg.detail, scope: msg.scope });
        }
        autoApproveIfEnabled(msg.confirm_id, msg.scope);
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
    case "operate_locate_request": {
      // 电脑操作定位不准 → 停下来请人指位。服务端广播给所有端，谁先答谁作数
      // （operate.py 的 future 只 set_result 一次，晚到的 has_pending_locate 已经是 false）。
      const s = cs(target);
      if (msg.ask_id && msg.image_url && !s.blocks.some((b) => b.kind === "locate" && b.askId === msg.ask_id)) {
        s.blocks.push({
          kind: "locate", askId: msg.ask_id, runId: msg.run_id || "",
          imageUrl: msg.image_url, target: msg.target || "", hint: msg.hint || t("chat.locateHint"),
        });
        s.lastText = t("chat.locateTitle");
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
      resolveConfirm(msg.confirm_id || "", Boolean(msg.approved)); // 跨会话统一更新
      renderMessages();
      return;
    case "history_cleared": {
      // 其它端清空了某个会话 → 本端同步清空。
      const s = cs(target);
      s.blocks = []; s.assistantIdx = null; s.jobMap = {}; s.doneJobs.clear();
      s.oldestId = null; s.hasMore = false; s.lastText = "";
      // 清空是**别人**干的时才留一条系统提示行 —— 自己刚点过「清空聊天」的话，
      // 本地已经乐观清过一遍，再说一句「别的端清空了」是自己骗自己。
      //
      // 靠广播里的 by 认发起方（服务端 /history/clear 原样回填 client_id）。
      // by 为空 = 老版本客户端发起的，认不出来就当别人清的 —— 宁可多一条提示，
      // 也别让某一端的聊天窗毫无征兆地整个变空。
      if (msg.by !== getClientId()) {
        s.blocks.push({ kind: "system", text: t("chat.clearedElsewhere"), ts: Date.now() });
      }
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

// 返回该 task_update 归属的会话 id（供 onMessage 决定是否刷新/标未读）。
// 引擎里程碑与电脑操控共用这一种事件；操控的进度卡也按 task_id 建 ——
// 它落库就是一条单步任务，聊天卡和任务页指的是同一条。
function handleTaskUpdate(msg: any): string {
  const id = msg.task_id;
  const conv = convOf(msg);
  if (!id) return conv;
  const s = cs(conv);
  const overall = typeof msg.overall === "number" ? msg.overall : msg.status === "done" ? 1 : 0;
  const pct = Math.max(0, Math.min(100, Math.round(overall * 100)));
  // 进度按里程碑 done/total，消息尾部标一下。
  const milestone = typeof msg.steps_total === "number" && msg.steps_total > 0
    ? `（${msg.steps_done || 0}/${msg.steps_total} 里程碑）` : "";
  let idx = s.jobMap[id];
  if (idx === undefined) {
    s.blocks.push({ kind: "job", taskId: id, goal: msg.goal || t("chat.task"), pct, status: msg.status || "running", message: (msg.message || "") + milestone });
    idx = s.blocks.length - 1;
    s.jobMap[id] = idx;
  }
  const b = s.blocks[idx];
  if (b.kind !== "job") return conv;
  b.pct = pct;
  b.status = msg.status || b.status;
  b.message = (msg.message || b.message) + (msg.message ? milestone : "");
  if (msg.goal) b.goal = msg.goal;
  // 操控的执行前授权嵌在进度卡里：confirm_id 是授权单号（不是任务 id）。
  b.confirmId = msg.event === "confirm" && msg.needs_confirm ? msg.confirm_id : undefined;
  b.confirmScope = msg.scope;
  if (b.confirmId) autoApproveIfEnabled(b.confirmId, b.confirmScope);
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
// 服务端给的图片地址多是相对路径（/files/<id>），拼上当前服务端地址才能加载。
// 已经是绝对地址（http/https）或 data: 的原样返回 —— 别粗暴地无脑拼前缀。
function absUrl(u: string): string {
  const s = u || "";
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  return getServerUrl().replace(/\/+$/, "") + (s.startsWith("/") ? s : `/${s}`);
}

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
// ── 任务卡的状态徽章 ────────────────────────────────────────────────────────
// 稿给了六个状态（running/idle/done/failed/stopped/auth），但那是设计稿自己编的一套。
// 服务端**也**是六个，只是不完全重合（task_tools.py:79 _STATUS_CN）：
//   pending 待执行 · running 执行中 · suspended 已挂起 · done 已完成 · failed 失败 · cancelled 已取消
// 加上一个纯前端的 awaiting（电脑操控停下来等你授权，卡里嵌着确认子卡），一共七档。
// 这里按**服务端的真实状态**建表，色调借稿的：
//   - 在动的（running）用橙 —— 橙是「Umbra 正在为你做事」，全站一致
//   - 等外部条件的（suspended 等设备、awaiting 等你）用琥珀 —— 卡住了，需要人或设备介入
//   - 还没开始 / 被中止的（pending、cancelled）用中性 chip —— 它们不是错误，别用红
//   - done 绿、failed 红
type JobState = "pending" | "running" | "suspended" | "awaiting" | "done" | "failed" | "cancelled";
const JOB_TONE: Record<JobState, { bg: string; fg: string; key: string }> = {
  pending:   { bg: "var(--chip)",         fg: "var(--muted)",       key: "chat.jobPending" },
  running:   { bg: "var(--orange-soft)",  fg: "var(--orange-text)", key: "chat.jobRunning" },
  suspended: { bg: "var(--warning-soft)", fg: "var(--warning)",     key: "chat.jobSuspended" },
  awaiting:  { bg: "var(--warning-soft)", fg: "var(--warning)",     key: "chat.awaitingReview" },
  done:      { bg: "var(--success-soft)", fg: "var(--success)",     key: "chat.jobDone" },
  failed:    { bg: "var(--danger-soft)",  fg: "var(--danger)",      key: "chat.jobFailed" },
  cancelled: { bg: "var(--chip)",         fg: "var(--muted)",       key: "chat.jobCancelled" },
};
// awaiting 优先于服务端状态：服务端那会儿还是 running，但对人来说它已经停下来等你了。
function jobState(status: string, awaiting: boolean): JobState {
  if (awaiting) return "awaiting";
  return (status in JOB_TONE && status !== "awaiting" ? status : "running") as JobState;
}

function confirmButtons(confirmId: string, scope?: string, tight = false): string {
  const tid = esc(confirmId);
  // scope=agent：授权只在这个任务内有效（端侧只问一次），因此不提供「总是允许(全局)」。
  //
  // 稿 1533-1535 在这种情况下还要给一句解释「这类授权不给『总是允许』」——
  // 光让按钮消失，用户只会以为是 bug。这一句先记在台账里，等文案定了再补。
  const always = scope === "agent"
    ? ""
    : `<button data-approve-always="${tid}" class="${btn("ghost", "sm")}">${esc(t("chat.approveAlways"))}</button>`;
  // 稿 1539-1549 的排布：批准（实心橙）+ 总是允许（描边）+ **spacer** + 拒绝右对齐。
  // 拒绝被推到最右不是排版偏好 —— 它和另外两个是相反方向的动作，挨着放很容易点错。
  //
  // tight：嵌在任务卡的琥珀子卡里时用。那个容器自己是 flex-column + gap 8，
  // 再带 margin-top 就成了 8+11 的双份间距。独立的确认卡没有 gap，仍然要这条 margin。
  return `<div style="display:flex;align-items:center;gap:9px;${tight ? "" : "margin-top:11px;"}flex-wrap:wrap;">`
    + `<button data-approve="${tid}" class="${btn("primary", "sm")}">${esc(t("chat.approve"))}</button>`
    + always
    + `<span style="flex:1;"></span>`
    + `<button data-deny="${tid}" class="${btn("danger", "sm")}">${esc(t("chat.reject"))}</button>`
    + `</div>`;
}

// ── 图标 ────────────────────────────────────────────────────────────────────
// 这一层是 vanilla（不是 React），拿不到 components/icons.tsx 里的组件，只能拼 SVG 字符串。
// 取值照抄设计稿：对勾 1626、授权三档 7267-7269。
//
// 为什么非换不可：原先这几处用的是 🎉 / ✅ / 🚫 emoji。emoji 在 Windows 和 macOS 上是两套
// 完全不同的彩色字形，既撞了「图标只用线性描边，不用填充图标、彩色图标、emoji」这条硬规则，
// 也没法跟着 --success / --danger 变色 —— 拒绝态的 🚫 在深色下依然是刺眼的红白圆盘。
//
// TODO(icons)：等 ClaudeDesign 交回图标清单后，这几条 path 会挪进跨端共用的图标源，
// 由脚本生成 PC / iOS 两边的图标文件，这里改成从那个源取。
const ICON_CHECK = "m5 12.5 4 4 10-10";
const ICON_AUTH_APPROVED = "M20 11a8 8 0 0 0-13.7-5.7L3 8M3 4v4h4";
const ICON_AUTH_DENIED = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6";
// 和 ui.tsx 的 ErrorCard 用的是同一组 path，只是那边分成三条、这边拼成一条 d
// （每段都以 M 起头，描边渲染等价）。
const ICON_ALERT = "M12 8v4M12 16v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z";

function svgIcon(d: string, size: number, width: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><path d="${d}"></path></svg>`;
}

// 设备会话里，每条气泡上方带一行发言人标签（稿 1417-1427）。
//
// 为什么必须跟着 D12 一起做：设备消息从「靠右」改成「靠左」之后，秘书和设备的气泡
// 长得一模一样 —— 没有标签就分不出谁在说话。只改对齐等于把界面改坏，两件事是一件事。
//
// 主会话不标：那里只有你和秘书，靠左右就分得清。
function speakerLabel(who: "assistant" | "device"): string {
  if (activeConv === MAIN) return "";
  const inner = who === "device"
    // 设备用 emoji + 设备名 —— 稿 1425 就是 `{{ ch.curEmoji }} {{ ch.curName }}`，
    // 这处 emoji 是设计要求的，不在「emoji 换线性图标」那条规则的适用范围里。
    ? `${esc(platformIcon(deviceOf(activeConv)?.platform))} ${esc(convLabel(activeConv))}`
    : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><rect x="4" y="8" width="16" height="12" rx="3"></rect><path d="M12 4v4M8 14v.01M16 14v.01"></path></svg>${esc(t("chat.secretary"))}`;
  return `<span style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--faint);white-space:nowrap;">${inner}</span>`;
}

// 把气泡裹进「标签 + 气泡」的一列（gap 5，照稿 1417）。没有标签时原样返回，
// 不多包一层 div —— 外面那层 gap:8 的包装还在，多套一层会多出 8px 的缝。
//
// ⚠️ 外层**不设** align-self：让它在纵向 flex 里默认 stretch 撑满整个消息区宽度，
// 里面靠 align-items:flex-start 把标签和气泡按左边缘对齐。这样气泡自己那个
// `max-width:80%` 才是「消息区的 80%」。如果外层 align-self:flex-start，容器会先
// 收缩到内容宽，80% 再乘一次，气泡会被压得很窄。
function labeled(who: "assistant" | "device", bubbleHtml: string): string {
  const label = speakerLabel(who);
  if (!label) return bubbleHtml;
  return `<div style="display:flex;flex-direction:column;align-items:flex-start;gap:5px;">${label}${bubbleHtml}</div>`;
}

function blockHtml(b: Block, i: number): string {
  if (b.kind === "user")
    return `<div style="align-self:flex-end;max-width:76%;background:var(--user-bubble);padding:10px 13px;border-radius:12px 12px 4px 12px;line-height:1.65;white-space:pre-wrap;">${esc(b.text)}</div>${timeLine(b.ts, "flex-end")}`;

  if (b.kind === "device") {
    // 设备发出的消息**靠左**。
    //
    // 这里翻过一次案：之前是靠右 + --track 底 + 虚线描边，理由是「本机(PC)是自己」。
    // 但那个口径下，同一条流水里「谁是自己」会随着你在哪台设备上看而变，两端的左右
    // 正好相反。现在统一成一条规则（决策 D12）：**只有用户自己发的消息靠右，其余一律靠左**。
    // 稿 1424-1427 画的也是靠左的 --card 实线气泡。
    // 取值和同页的秘书气泡同档（82% / 圆角 12-12-12-4 / 内距 11-13 / 行高 1.65，稿 1424-1427、1472）。
    // 缺角在左下 —— 指向说话人的那一侧。
    return labeled("device", `<div style="align-self:flex-start;max-width:82%;background:var(--card);border:1px solid var(--border);padding:11px 13px;border-radius:12px 12px 12px 4px;line-height:1.65;white-space:pre-wrap;">${esc(b.text)}</div>`)
      + timeLine(b.ts, "flex-start");
  }

  if (b.kind === "assistant") {
    const trace = b.trace.length
      ? `<div style="align-self:flex-start;max-width:82%;width:100%;">
          <div data-trace="${i}" style="display:flex;align-items:center;gap:7px;cursor:pointer;color:var(--muted);font-size:11.5px;margin-bottom:6px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="transition:transform .15s;transform:rotate(${b.traceOpen ? 90 : 0}deg);"><path d="M9 6l6 6-6 6"></path></svg>${esc(t("chat.toolTrace", { count: b.trace.length }))}</div>
          ${b.traceOpen ? `<div style="display:flex;flex-direction:column;gap:5px;background:var(--track);border:1px solid var(--border);border-radius:9px;padding:9px 11px;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:11.5px;line-height:1.7;color:var(--muted);">${b.trace.map((t) => `<div>${esc(t)}</div>`).join("")}</div>` : ""}
        </div>`
      : "";
    // 注意：这里不能用 white-space:pre-wrap —— Markdown 渲染已把换行转成块/段落/<br>，
    // 再 pre-wrap 会把 md 源码里的换行重复显示成大片空白。
    const bubble = `<div style="align-self:flex-start;max-width:82%;background:var(--card);border:1px solid var(--border);padding:11px 13px;border-radius:12px 12px 12px 4px;line-height:1.65;min-height:20px;overflow-wrap:break-word;">${b.thinking ? dots : ""}${assistantBody(b.text)}${b.streaming && b.text ? `<span style="display:inline-block;width:2px;height:15px;background:var(--orange);vertical-align:-2px;margin-left:1px;animation:umblink 1s steps(1) infinite;"></span>` : ""}</div>`;
    return trace + labeled("assistant", bubble) + (b.streaming ? "" : timeLine(b.ts, "flex-start"));
  }

  if (b.kind === "job") {
    // 卡里嵌着待处理的授权 —— 那不是「90%」，那是**待确认**（停下来等你点头）。
    const awaiting = !!b.confirmId && b.status !== "done" && b.status !== "failed";
    const st = jobState(b.status, awaiting);
    const tone = JOB_TONE[st];
    // 稿 1487-1524。相对原来这张卡的四处改动：
    //   1. 左侧那条 3px 的彩色竖边去掉了，状态改由右上角的**胶囊徽章**承载。
    //      竖边只有一个颜色维度，同一个橙既是「运行中」也是「待确认」，看不出差别。
    //   2. 运行中标题前加一枚转圈图标 —— 卡片是静态的，进度条几十秒才动一格，
    //      没有任何东西告诉你它还活着。（稿把这条 keyframes 叫 umspin，本工程里
    //      早就有一条一模一样的 umbspin，用现成的，不为改名再加一条重复的。）
    //   3. 百分比从标题栏挪到进度条右侧，mono 600 11.5px，跟条同色。
    //   4. 底部补一颗动作按钮：失败给「重试任务」，其余给「查看结果」（跳任务页详情）。
    //      这张卡以前是**纯展示**的死胡同——任务失败了只能自己去侧栏找任务页。
    const spin = st === "running"
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--orange)" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" style="flex:none;animation:umbspin 1s linear infinite;"><path d="M20 11a8 8 0 0 0-13.7-5.7L3 8"></path><path d="M3 4v4h4"></path></svg>`
      : "";
    // 待确认时不画进度条（稿 taskShowBar: task !== 'idle'）：那个百分比停在哪儿都是误导，
    // 它不代表「还差多少」，只代表「上一轮跑到哪儿停下来等你」。
    const bar = awaiting
      ? ""
      : `<div style="display:flex;align-items:center;gap:9px;">
          <span style="flex:1;min-width:0;height:6px;border-radius:999px;background:var(--track);overflow:hidden;display:block;"><span style="display:block;height:100%;width:${b.pct}%;background:${tone.fg};border-radius:999px;"></span></span>
          <span style="flex:none;font:600 11.5px ui-monospace,Menlo,monospace;color:${tone.fg};">${b.pct}%</span>
        </div>`;
    // 稿 1505-1519：待确认的授权嵌在任务卡里时是一块琥珀底的子卡，不是一排裸按钮 ——
    // 它要求你停下来做决定，得和卡片其余部分在视觉上分开。
    const confirm = b.confirmId
      ? `<div style="padding:10px 11px;background:var(--warning-soft);border:1px solid var(--warning);border-radius:9px;display:flex;flex-direction:column;gap:8px;">
          <div style="display:flex;align-items:center;gap:7px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><path d="M12 3 4 6v6c0 5 3.5 7.5 8 9 4.5-1.5 8-4 8-9V6z"></path></svg><span style="flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--warning);">${esc(t("chat.needConfirm"))}</span></div>
          ${confirmButtons(b.confirmId, b.confirmScope, true)}
        </div>`
      : "";
    const actLabel = st === "failed" ? t("chat.retryTask") : t("chat.viewResult");
    // 琥珀档（等你授权）不给右下角按钮（批次 006 定稿：三键就地内嵌、授权就地完成，
    // 稿把原来的「去授权」单按钮删了 —— 留着它用户会以为通向另一个地方）。
    const actRow = awaiting
      ? ""
      : `<div style="display:flex;align-items:center;gap:8px;">
          <span style="flex:1;"></span>
          <button data-jobact="${esc(b.taskId)}" data-jobfail="${st === "failed" ? "1" : ""}" class="${btn("ghost", "sm")}">${esc(actLabel)}</button>
        </div>`;
    // 长摘要（agent 的输出动辄几百字）限高可滚，别撑破卡片。
    return `<div style="align-self:flex-start;max-width:82%;width:100%;background:var(--card);border:1px solid var(--border);border-radius:11px;padding:12px 14px;display:flex;flex-direction:column;gap:9px;">
        <div style="display:flex;align-items:center;gap:9px;">
          ${spin}
          <span style="flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(b.goal)}</span>
          <span style="flex:none;display:inline-flex;align-items:center;padding:1px 9px;border-radius:999px;font-size:11px;white-space:nowrap;background:${tone.bg};color:${tone.fg};">${esc(t(tone.key))}</span>
        </div>
        ${bar}
        <span style="font-size:12px;color:var(--muted);line-height:1.7;max-height:150px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;">${esc(b.message)}</span>
        ${confirm}
        ${actRow}
      </div>`;
  }

  if (b.kind === "locate") return locateCardHtml(b, i);

  if (b.kind === "system") {
    // 稿 1412-1413：居中一颗小灰胶囊。刻意做得比任何消息都弱 —— 它不是谁说的话。
    return `<div style="align-self:center;padding:3px 11px;border-radius:999px;background:var(--chip);color:var(--faint);font-size:11px;white-space:nowrap;">${esc(b.text)}</div>`;
  }

  if (b.kind === "done") {
    // 产出区按批次 005 的统一行形态（原来是手写的绿字绿框 + 裸图块）：
    // 38×38 前导（图片缩略 / 文件描边图标）+ 文件名橙链接 + 等宽 meta + 24px 下载按钮，
    // 容器 1px 描边圆角 9、行间 --border-soft。图片点开走灯箱（data-img → openLightbox）。
    const results = b.results || [];
    const rows = results.map((r, i) => {
      const url = absUrl(r.url);
      const img = isImageUrl(url);
      const lead = img
        ? `<img data-img="${esc(url)}" src="${esc(url)}" alt="${esc(r.title)}" style="flex:none;width:38px;height:38px;border-radius:7px;object-fit:cover;cursor:zoom-in;" onerror="this.style.display='none'">`
        : `<span style="flex:none;width:38px;height:38px;border-radius:8px;background:var(--chip);color:var(--muted);display:flex;align-items:center;justify-content:center;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path></svg></span>`;
      const meta = url.replace(/^https?:\/\/[^/]+/, "");
      const name = img
        ? `<span data-img="${esc(url)}" style="font-size:12.5px;font-weight:500;color:var(--orange-text);cursor:zoom-in;">${esc(r.title)}</span>`
        : `<a href="${esc(url)}" target="_blank" rel="noopener" style="font-size:12.5px;font-weight:500;color:var(--orange-text);text-decoration:none;">${esc(r.title)}</a>`;
      return `<div class="hover:bg-hover transition-colors" style="display:flex;align-items:center;gap:10px;padding:8px 11px;${i > 0 ? "border-top:1px solid var(--border-soft);" : ""}">${lead}`
        + `<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;">${name}`
        + `<span style="font-size:10.5px;color:var(--faint);font-family:ui-monospace,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(meta)}</span></div>`
        + `<a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(t("chat.resultDownload"))}" style="flex:none;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:7px;color:var(--muted);"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"></path></svg></a></div>`;
    }).join("");
    const out = results.length
      ? `<div style="font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--faint);margin:9px 0 6px;">${esc(t("chat.resultsTitle", { n: results.length }))}</div>`
        + `<div style="border:1px solid var(--border);border-radius:9px;background:var(--card);overflow:hidden;">${rows}</div>`
      : "";
    return `<div style="align-self:flex-start;max-width:82%;width:100%;background:var(--success-soft);border:1px solid var(--success);border-radius:11px;padding:12px 14px;"><div style="font-weight:600;color:var(--success);display:flex;align-items:center;gap:7px;">${svgIcon(ICON_CHECK, 14, 2.2)}<span style="min-width:0;">${esc(t("chat.done"))}：${esc(b.goal)}</span></div>${out}</div>`;
  }

  if (b.kind === "confirm") {
    const detail = b.detail != null ? (typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail)) : "";
    const foot = b.resolved
      ? `<div style="font-size:12.5px;font-weight:600;margin-top:9px;display:flex;align-items:center;gap:6px;color:${b.resolved === "approved" ? "var(--success)" : "var(--danger)"};">${
          b.resolved === "approved"
            ? `${svgIcon(ICON_AUTH_APPROVED, 12, 1.9)}${esc(t("chat.approved"))}`
            : `${svgIcon(ICON_AUTH_DENIED, 12, 1.9)}${esc(t("chat.denied"))}`}</div>`
      : confirmButtons(b.confirmId, b.scope);
    return `<div style="align-self:flex-start;max-width:82%;width:100%;background:var(--card);border:1px solid var(--border);border-radius:11px;padding:12px 14px;">
        <div style="font-weight:600;color:var(--orange-text);margin-bottom:6px;display:flex;align-items:center;gap:7px;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"></path><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>${esc(t("chat.needConfirm"))}</div>
        <div style="font-size:13px;line-height:1.55;color:var(--text);">${esc(b.summary)}</div>
        ${detail ? `<div style="font-size:11.5px;color:var(--muted);margin-top:6px;font-family:ui-monospace,Menlo,monospace;word-break:break-all;">${esc(detail)}</div>` : ""}
        ${foot}
      </div>`;
  }

  if (b.kind === "question") return questionCardHtml(b, i);

  // 错误块照「PC 错误卡」的 strip 档重画（稿 1672-1673）。原先这里有两个问题：
  //   ① 描边写死了 `rgba(180,35,24,.3)` —— 撞「颜色一律走 CSS 变量」，深色下也不跟着变
  //   ② 只有一行字，没有动作 —— 撞「失败态三段式，第三段必须是可点按钮」
  // 稿给的动作是「重新连接」（7323）。这里接 chatConn.connect()，它内部对已连接是幂等的。
  return `<div style="align-self:flex-start;max-width:82%;width:100%;background:var(--danger-soft);border:1px solid var(--danger);border-radius:11px;padding:11px 13px;display:flex;align-items:center;gap:9px;">
      <span style="flex:none;color:var(--danger);display:flex;">${svgIcon(ICON_ALERT, 15, 2.1)}</span>
      <span style="flex:1;min-width:0;font-size:12.5px;font-weight:600;color:var(--danger);line-height:1.65;">${esc(b.text)}</span>
      <button data-reconnect="1" class="${btn("danger", "sm")}">${esc(t("chat.reconnect"))}</button>
    </div>`;
}

// 问答卡：一次一题（可回上一题改），全部答完统一提交。
// 为什么要这个：歧义必须在派活**之前**消除——「写个棋牌小程序」是微信还是支付宝？
// 带着歧义开工，返工的代价远大于问一句。
// ── 「找位置」卡 ────────────────────────────────────────────────────────────
// 稿 1645-1670 画了这张卡，但只画了两条出路：清掉 / 发回去。
// 服务端（operate.py on_locate_response）实际认**四**种回应，iOS 也四种都做了：
//   ① 指位 nx,ny  ② 文字纠偏 feedback  ③ 暂停我来 paused  ④ 取消 cancelled
// 只做前两条等于把②③砍掉 —— 而②③恰恰是「截图根本不对」「这事我自己两秒就点了」
// 这两种最常见的卡住场景的出路。所以这里按服务端的能力做全，稿的缺口记进回流台账。
//
// 与 iOS 的一处**故意**不同：iOS 是拖箭头（箭尾→尖端），PC 这里是点一下。
// 箭头在 iOS 上是为了解决「手指挡住要点的位置」，鼠标指针不遮挡，桌面端不需要，
// 稿也画的是点选。回传给服务端的都只有尖端那一个点，协议是一样的。
function locateCardHtml(b: Extract<Block, { kind: "locate" }>, i: number): string {
  const head = `<div style="display:flex;align-items:center;gap:8px;">
      <span style="flex:none;width:22px;height:22px;border-radius:7px;background:var(--orange-soft);color:var(--orange-text);display:flex;align-items:center;justify-content:center;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19 19 5M19 5h-7M19 5v7"></path></svg></span>
      <span style="flex:1;min-width:0;font-size:12.5px;font-weight:600;">${esc(t("chat.locateTitle"))}</span>
    </div>`;
  const body = `<span style="font-size:12px;color:var(--muted);line-height:1.7;white-space:pre-wrap;">${esc(b.hint)}</span>`;
  const shell = (inner: string) =>
    `<div style="align-self:flex-start;max-width:82%;width:100%;background:var(--card);border:1px solid var(--border);border-radius:11px;padding:12px 14px;display:flex;flex-direction:column;gap:9px;">${head}${body}${inner}</div>`;

  // 已经答过（本端答的，或别的端抢先答了）→ 只剩一行状态。
  // 「暂停我来」是唯一还留着动作的：你处理完了得有地方点「继续」，否则任务就吊在那里。
  if (b.resolved) {
    const done = `<span style="font-size:11.5px;color:var(--faint);">${esc(t(`chat.locate_${b.resolved}`))}</span>`;
    if (b.resolved !== "paused") return shell(done);
    return shell(`<div style="display:flex;align-items:center;gap:8px;">${done}<span style="flex:1;"></span>`
      + `<button data-locresume="${i}" class="${btn("primary", "sm")}">${esc(t("chat.locateResume"))}</button></div>`);
  }

  const src = absUrl(b.imageUrl);
  // 图片外面这层容器**必须贴着图片本身**（inline-block + line-height:0），不能是个更大的框：
  // 点击坐标是拿 offsetX / clientWidth 算的，容器比图大出来的那圈会让换算整体偏移。
  const dot = b.nx !== undefined && b.ny !== undefined
    ? `<span style="position:absolute;left:${b.nx / 10}%;top:${b.ny / 10}%;width:13px;height:13px;margin:-6.5px 0 0 -6.5px;border-radius:999px;background:var(--orange);border:2px solid #fff;box-shadow:0 0 0 1px var(--orange);pointer-events:none;"></span>`
    : "";
  // 描边挂在容器上、图片贴着容器内沿，所以那颗点的百分比定位比图片实际位置差 1px 的边框宽度 ——
  // 肉眼看不出来，但换算坐标时不能这么将就，见 onMsgsClick 里量的是 <img> 而不是这一层。
  const shot = `<span data-locshot="${i}" style="position:relative;display:inline-block;line-height:0;max-width:100%;align-self:flex-start;border-radius:9px;border:1px solid var(--border);background:var(--track);cursor:crosshair;overflow:hidden;">`
    + `<img src="${esc(src)}" alt="${esc(t("chat.locateShotAlt"))}" style="display:block;max-width:100%;max-height:280px;" draggable="false">${dot}</span>`;

  // 文字纠偏的输入框默认收着 —— 展开着会喧宾夺主，让人以为「必须写点什么」，
  // 而大多数时候点一下就完事了。
  const fb = b.fbOpen
    ? `<div style="display:flex;gap:8px;align-items:center;">
        <input data-locfb="${i}" value="${esc(b.fbText || "")}" placeholder="${esc(t("chat.locateFbPlaceholder"))}" style="flex:1;min-width:0;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:7px;padding:6px 9px;font-size:12px;font-family:inherit;outline:none;">
        <button data-locfbsend="${i}" class="${btn("primary", "sm")}"${(b.fbText || "").trim() ? "" : " disabled"}>${esc(t("chat.locateFbSend"))}</button>
      </div>`
    : "";
  const foot = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <span style="flex:1;min-width:80px;font-size:11px;color:var(--faint);line-height:1.65;">${esc(t("chat.locateFootHint"))}</span>
      ${b.nx !== undefined ? `<button data-locclear="${i}" class="${btn("ghost", "sm")}">${esc(t("chat.locateClear"))}</button>` : ""}
      <button data-locfbtoggle="${i}" class="${btn("ghost", "sm")}">${esc(t(b.fbOpen ? "chat.locateFbClose" : "chat.locateFbOpen"))}</button>
      <button data-locpause="${i}" class="${btn("ghost", "sm")}">${esc(t("chat.locatePause"))}</button>
      <button data-locsend="${i}" class="${btn("primary", "sm")}"${b.nx === undefined ? " disabled" : ""}>${esc(t("chat.locateSend"))}</button>
    </div>`;
  return shell(shot + fb + foot);
}

function questionCardHtml(b: Extract<Block, { kind: "question" }>, i: number): string {
  const total = b.questions.length;
  if (b.done) {
    return `<div style="align-self:flex-start;max-width:82%;width:100%;background:var(--card);border:1px solid var(--border);border-radius:11px;padding:12px 14px;">
      <div style="font-weight:600;margin-bottom:6px;">${esc(b.title)}</div>
      <div style="font-size:12.5px;color:var(--success);display:flex;align-items:center;gap:6px;">${svgIcon(ICON_CHECK, 13, 2.2)}${esc(t("chat.questionSubmitted"))}</div>
    </div>`;
  }
  const q = b.questions[Math.min(b.at, total - 1)];
  if (!q) return "";
  const sel = b.picked[q.id] || [];
  const opts = q.options
    .map((o) => {
      const on = sel.includes(o);
      return `<button data-qopt="${i}" data-val="${esc(o)}" style="display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:9px 12px;margin-bottom:6px;border-radius:9px;cursor:pointer;font-size:13px;border:1px solid ${on ? "var(--orange)" : "var(--border)"};background:${on ? "var(--orange-soft)" : "var(--bg)"};color:${on ? "var(--orange-text)" : "var(--text)"};">
        <span style="flex:none;width:15px;height:15px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border-radius:${q.multi ? "4px" : "999px"};border:1.6px solid ${on ? "var(--orange)" : "var(--border)"};background:${on ? "var(--orange)" : "transparent"};">${on ? `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4 4 10-10"></path></svg>` : ""}</span>${esc(o)}
      </button>`;
    })
    .join("");
  // 自定义答案与选项**同款同列**：渲染成列表里的最后一行（铅笔图标 + 行内输入框），
  // 不再是独立杵在下面的输入区块——它和选项是同一层意思（多一种可选答案）。
  const customOn = (b.custom[q.id] || "").trim().length > 0;
  const custom = q.allow_custom || q.options.length === 0
    ? `<div style="display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:0 12px;margin-bottom:6px;border-radius:9px;border:1px solid ${customOn ? "var(--orange)" : "var(--border)"};background:${customOn ? "var(--orange-soft)" : "var(--bg)"};">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${customOn ? "var(--orange-text)" : "var(--muted)"}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path></svg>
        <input data-qcustom="${i}" value="${esc(b.custom[q.id] || "")}" placeholder="${esc(q.options.length ? t("chat.questionCustom") : t("chat.questionAnswer"))}" style="flex:1;min-width:0;border:none;background:transparent;color:${customOn ? "var(--orange-text)" : "var(--text)"};padding:9px 0;font-size:13px;outline:none;" />
      </div>`
    : "";
  const last = b.at >= total - 1;
  const answered = sel.length > 0 || (b.custom[q.id] || "").trim().length > 0;
  return `<div style="align-self:flex-start;max-width:82%;width:100%;background:var(--card);border:1px solid var(--border);border-radius:11px;padding:12px 14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">
        <span style="font-weight:600;">${esc(b.title)}</span>
        <span style="flex:none;font-size:11px;color:var(--faint);font-family:ui-monospace,Menlo,monospace;">${b.at + 1} / ${total}</span>
      </div>
      <div style="font-size:13.5px;margin:10px 0 9px;">${esc(q.text)}${q.multi ? `<span style="display:inline-flex;align-items:center;padding:1px 7px;margin-left:6px;border-radius:999px;background:var(--orange-soft);color:var(--orange-text);font-size:11px;font-weight:600;white-space:nowrap;vertical-align:1px;">${esc(t("chat.questionMulti"))}</span>` : ""}</div>
      ${opts}
      ${custom}
      <div style="display:flex;gap:8px;margin-top:11px;">
        ${b.at > 0 ? `<button data-qprev="${i}" class="${btn("ghost", "sm")}">${esc(t("chat.questionPrev"))}</button>` : ""}
        <span style="flex:1;"></span>
        <button data-${last ? "qsubmit" : "qnext"}="${i}" ${answered ? "" : "disabled"} class="${btn("primary", "sm")}">${esc(last ? t("chat.questionSubmit") : t("chat.questionNext"))}</button>
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

// 在线状态：**圆点 + 文字**，摆在联系人行的第二行（稿 1347-1350、7165-7169）。
//
// 之前是在头像右下角压一个 8px 的点，没有文字 —— 撞了「状态必须『图标 + 文字』」这条硬规则。
// 光靠一个绿/灰点表意，对色觉障碍用户等于没有状态；点又小又压在头像上，正常视力也得凑近看。
//
// 两态的形状也不同，不是只换颜色：在线是 6px **实心**，离线是 7px **空心描边**。
// 这样即使完全不看颜色，形状也能分辨。
function presenceDot(conv: string): string {
  if (conv === MAIN) return "";
  const on = !!deviceOf(conv)?.online;
  return on
    ? `<span style="width:6px;height:6px;flex:none;border-radius:999px;background:var(--success);"></span>`
    : `<span style="width:7px;height:7px;flex:none;border-radius:999px;border:1.5px solid var(--faint);box-sizing:border-box;"></span>`;
}

// 圆点 + 文字。会话头和详情栏那两处本来就在旁边写了文字，只取上面的点即可。
function presenceRow(conv: string): string {
  const dot = presenceDot(conv);
  if (!dot) return "";
  const on = !!deviceOf(conv)?.online;
  return dot + `<span style="flex:none;font-size:10.5px;color:${on ? "var(--success)" : "var(--faint)"};white-space:nowrap;">${esc(on ? t("chat.online") : t("chat.offline"))}</span>`;
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
        ${avatarHtml(id)}
        <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;">
          <span style="display:flex;align-items:center;gap:6px;">
            <span style="flex:1;min-width:0;font-size:13.5px;font-weight:${on ? 600 : 500};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(convLabel(id))}</span>
            <span style="flex:none;font-size:10.5px;color:var(--muted);">${esc(time)}</span>
          </span>
          <span style="display:flex;align-items:center;gap:6px;">
            ${presenceRow(id)}
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
  // 稿 1370-1379：标题栏是**一行**（头像 26 + 名字 14/600 + 副标题 11.5 faint），
  // 右侧只有两颗 26px 的图标按钮：⋯ 溢出菜单、ⓘ 设备详情。
  // 原先这里是「头像 32 + 两行堆叠」，外加两颗常驻的文字按钮（复制聊天 / 清空聊天）——
  // 那两颗一直占着标题栏，而它们都是低频动作，尤其「清空聊天」是破坏性的，
  // 常驻反而增加误点面积。收进溢出菜单后标题栏干净了，危险动作也多隔了一层。
  const iconBtn = (id: string, title: string, path: string, on: boolean) =>
    `<button id="${id}" title="${esc(title)}" style="flex:none;display:flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid ${on ? "var(--orange)" : "var(--border)"};background:${on ? "var(--orange-soft)" : "transparent"};color:${on ? "var(--orange-text)" : "var(--muted)"};border-radius:7px;cursor:pointer;transition:border-color .13s ease,color .13s ease;">`
    + `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${path}</svg></button>`;
  const info =
    activeConv === MAIN
      ? ""
      : iconBtn("udetailbtn", t("chat.deviceDetail"), `<circle cx="12" cy="12" r="9"></circle><path d="M12 16v-4M12 8h.01"></path>`, detailOpen);
  el.innerHTML = `
    ${avatarHtml(activeConv, 26)}
    <span style="flex:none;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%;">${esc(convLabel(activeConv))}</span>
    <span style="flex:none;font-size:11.5px;color:var(--faint);white-space:nowrap;display:flex;align-items:center;gap:5px;min-width:0;overflow:hidden;">${presenceDot(activeConv)}${esc(sub)}</span>
    <span style="flex:1;min-width:8px;"></span>
    ${iconBtn("uheadmore", t("chat.more"), `<path d="M6 12h.01M12 12h.01M18 12h.01"></path>`, headMenuOpen)}
    ${info}
    ${headMenuOpen ? headMenuHtml() : ""}`;
  el.querySelector("#uheadmore")?.addEventListener("click", (e) => {
    e.stopPropagation();
    headMenuOpen = !headMenuOpen;
    renderHeader();
  });
  el.querySelector("#uheadmenu")?.addEventListener("click", (e) => e.stopPropagation());
  el.querySelector("#uhm-copy")?.addEventListener("click", () => { headMenuOpen = false; renderHeader(); void copyActiveHistory(); });
  el.querySelector("#uhm-clear")?.addEventListener("click", () => { headMenuOpen = false; renderHeader(); void clearActiveHistory(); });
  el.querySelector("#udetailbtn")?.addEventListener("click", () => {
    detailOpen = !detailOpen;
    renderHeader();
    renderDetail();
  });
}

// 标题栏 ⋯ 的溢出菜单。取值照「PC 浮层菜单」组件（宽 142 / 圆角 9 / 内距 4 /
// 行 6-10 12.5px / 分隔线 --border-soft 上下留 4 边距 6 / 阴影 0 8 24 rgba(0,0,0,.13)）。
//
// 稿的菜单是三项：新会话 / 复制聊天 / ── / 清空聊天。这里**只做后两项**：
// 「新会话」服务端没有对应能力 —— 会话 id 是固定的 'assistant' 与 'device:<id>'，
// /conversations 只能列举、不能新建，也没有「一个设备下多条会话」的数据结构。
// 加个按钮点了只能弹个假吐司，或者退化成「清空聊天」的同义词，两种都更糟。
// 等服务端真支持多会话了再补，那时它还要连带影响左侧联系人列表的结构。
function headMenuHtml(): string {
  const row = (id: string, label: string, path: string, danger = false) =>
    `<div id="${id}" style="display:flex;align-items:center;gap:9px;padding:6px 10px;border-radius:6px;font-size:12.5px;color:${danger ? "var(--danger)" : "var(--text)"};white-space:nowrap;cursor:pointer;">`
    + `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="flex:none;">${path}</svg>`
    + `<span style="flex:1;min-width:0;">${esc(label)}</span></div>`;
  return `<div id="uheadmenu" style="position:absolute;right:14px;top:40px;z-index:40;width:142px;background:var(--card);border:1px solid var(--border);border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.13);padding:4px;">`
    + row("uhm-copy", t("chat.copyHistory"), `<rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>`)
    + `<div style="height:1px;background:var(--border-soft);margin:4px 6px;"></div>`
    + row("uhm-clear", t("chat.clearHistory"), `<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"></path>`, true)
    + `</div>`;
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
      ${!d.online ? `<button id="uforget" class="${btnWide("danger")} mt-auto">${esc(t("chat.forgetDevice"))}</button>` : ""}
    </div>`;

  el.querySelector("#uforget")?.addEventListener("click", async () => {
    // 走全局确认弹窗而不是 window.confirm —— 系统弹窗跟设计稿完全两回事，深色下还是一块白板。
    const ok = await askConfirm({
      message: t("chat.forgetConfirm", { name: d.device_name }),
      confirmText: t("chat.forgetDevice"),
      danger: true,
    });
    if (!ok) return;
    if (await forgetDevice(d.device_id)) {
      detailOpen = false;
      if (activeConv === `device:${d.device_id}`) switchConv(MAIN);
      await loadDevices();
      renderDetail();
      showToast(t("chat.forgotDevice", { name: d.device_name }), { tone: "ok" });
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
  // 离线横幅跟着消息区一起刷：设备上下线会走 device_presence → loadDevices → renderContacts，
  // 但那条路不重绘消息区，所以下面 loadDevices 里也单独叫了一次。
  refreshOfflineBar();
  if (preserve) return; // 上拉加载：由调用方手动恢复滚动位置
  if (stick || forceScroll) {
    el.scrollTop = el.scrollHeight;
    forceScroll = false;
  } else {
    el.scrollTop = prevTop;
  }
}

// 输入区：**只有主会话（与秘书）显示**；设备会话是秘书↔设备的交互流水（只读），
// 输入区先默认隐藏（以后要支持对设备直接喊话再放开）。
function refreshComposer(): void {
  if (!container) return;
  const wrap = container.querySelector("#ucomposer") as HTMLElement | null;
  if (!wrap) return;
  if (activeConv !== MAIN) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "";
  if (!wrap.querySelector("#draft")) {
    // position:relative：斜杠面板绝对定位在输入区上方（稿：left 16、贴着输入条向上）。
    wrap.style.position = "relative";
    wrap.innerHTML = `
      <div id="uslash"></div>
      <div id="uideabanner"></div>
      <div style="display:flex;gap:10px;align-items:flex-end;padding:10px 16px 4px;">
        <div style="flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:flex-start;gap:7px;border:1px solid var(--border);background:var(--bg);border-radius:10px;padding:6px 8px;">
          <span id="uchip"></span>
          <textarea id="draft" rows="2" class="flex-1 min-w-[120px] resize-none border-none bg-transparent text-text px-[4px] py-[3px] text-[13.5px] leading-[1.5] font-[inherit] max-h-[120px] outline-none"></textarea>
        </div>
        <button id="sendbtn" class="${btn("primary")} gap-[6px] self-center" ${clearing ? "disabled" : ""}>${esc(t("chat.send"))}<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"></path></svg></button>
      </div>
      <div id="uchiphint" style="padding:0 16px 10px;"></div>`;
    wrap.querySelector("#sendbtn")!.addEventListener("click", send);
    const ta = wrap.querySelector("#draft") as HTMLTextAreaElement;
    ta.addEventListener("input", () => {
      drafts[activeConv] = ta.value;
      // 文本不再以 / 开头（清空/改写）时，「当普通消息发」的豁免自动失效。
      if (ta.value.charAt(0) !== "/") slashDismissed = false;
      slashSel = 0;
      renderSlashPanel();
    });
    ta.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      // 芯片态：空文本按 Backspace 删芯片，回到普通输入（稿的 PC 删法）。
      if (chipAction && e.key === "Backspace" && !ta.value) {
        e.preventDefault();
        setChip(null);
        return;
      }
      const flat = slashFlat();
      if (slashPanelOn()) {
        // 面板开着：↑↓ 移动选中、Enter 选用、Esc 清掉 / 关面板 —— 都不落进文本。
        if (e.key === "Escape") { e.preventDefault(); ta.value = ""; drafts[activeConv] = ""; renderSlashPanel(); return; }
        if (e.key === "ArrowDown") { e.preventDefault(); slashSel = Math.min(slashSel + 1, Math.max(flat.length - 1, 0)); renderSlashPanel(); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); slashSel = Math.max(slashSel - 1, 0); renderSlashPanel(); return; }
        if (e.key === "Enter" && !e.shiftKey && flat.length) { e.preventDefault(); pickSlash(flat[Math.min(slashSel, flat.length - 1)]); return; }
      }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    // 面板行点击 / hover 同步选中 / 空态两个出口，全走事件代理。
    (wrap.querySelector("#uslash") as HTMLElement).addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-slash],[data-slashgocaps],[data-slashplain]") as HTMLElement | null;
      if (!el) return;
      if (el.dataset.slashgocaps !== undefined) { goNavCb?.("abilities"); return; }
      if (el.dataset.slashplain !== undefined) {
        slashDismissed = true;                 // 保留文本，仅本段 / 文本不再弹面板
        renderSlashPanel();
        (wrap.querySelector("#draft") as HTMLTextAreaElement).focus();
        return;
      }
      const a = slashFlat().find((x) => x.k === el.dataset.slash);
      if (a) pickSlash(a);
    });
    (wrap.querySelector("#uslash") as HTMLElement).addEventListener("mouseover", (e) => {
      const el = (e.target as HTMLElement).closest("[data-slash]") as HTMLElement | null;
      if (!el) return;
      const idx = slashFlat().findIndex((x) => x.k === el.dataset.slash);
      if (idx >= 0 && idx !== slashSel) { slashSel = idx; renderSlashPanel(); }
    });
    // 芯片可点删（Backspace 之外的鼠标出口）；横幅「知道了」关横幅。
    (wrap.querySelector("#uchip") as HTMLElement).addEventListener("click", () => setChip(null));
    (wrap.querySelector("#uideabanner") as HTMLElement).addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-ideagotit]")) { ideaBanner = null; renderIdeaBanner(); }
    });
  }
  const ta = wrap.querySelector("#draft") as HTMLTextAreaElement;
  ta.placeholder = chipAction ? chipAction.params : t("chat.placeholder");
  if (ta.value !== (drafts[activeConv] || "")) ta.value = drafts[activeConv] || "";
  renderChip();
  renderIdeaBanner();
  renderSlashPanel();
}

// ── 「/」面板的渲染与状态 ────────────────────────────────────────────────────
function slashQuery(): string {
  const d = drafts[MAIN] || "";
  return d.charAt(0) === "/" ? d.slice(1).trim() : "";
}
function slashPanelOn(): boolean {
  const d = drafts[MAIN] || "";
  return activeConv === MAIN && !chipAction && !slashDismissed && d.charAt(0) === "/";
}
// 过滤后的分组与拉平序（键盘选中按拉平序走）。匹配名称，动作 id 当英文别名。
function slashGroupsFiltered(): { name: string; items: SlashAction[] }[] {
  const q = slashQuery();
  return slashCatalog()
    .map((g) => ({ name: g.name, items: g.items.filter((a) => !q || a.label.includes(q) || a.k.includes(q.toLowerCase())) }))
    .filter((g) => g.items.length > 0);
}
function slashFlat(): SlashAction[] {
  return slashGroupsFiltered().flatMap((g) => g.items);
}
function pickSlash(a: SlashAction): void {
  setChip(a);
  drafts[MAIN] = "";
  slashSel = 0;
  refreshComposer();
  (container?.querySelector("#draft") as HTMLTextAreaElement | null)?.focus();
}
function setChip(a: SlashAction | null): void {
  chipAction = a;
  refreshComposer();
  (container?.querySelector("#draft") as HTMLTextAreaElement | null)?.focus();
}
function renderChip(): void {
  const el = container?.querySelector("#uchip") as HTMLElement | null;
  const hint = container?.querySelector("#uchiphint") as HTMLElement | null;
  if (!el || !hint) return;
  if (!chipAction) { el.innerHTML = ""; el.style.display = "none"; hint.innerHTML = ""; return; }
  el.style.display = "";
  el.innerHTML = `<span title="${esc(t("chat.slashSendAsIs"))}" style="flex:none;display:inline-flex;align-items:center;gap:5px;height:23px;margin-top:3px;padding:0 8px;border:1px solid var(--orange);background:var(--orange-soft);color:var(--orange-text);border-radius:7px;font-size:11.5px;font-weight:600;white-space:nowrap;cursor:pointer;">`
    + `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${chipAction.icon}"></path></svg>${esc(chipAction.label)}</span>`;
  hint.innerHTML = `<span style="font-size:11px;color:var(--faint);line-height:1.65;">${esc(t("chat.slashActionHint", { label: chipAction.label }))}</span>`;
}
function renderIdeaBanner(): void {
  const el = container?.querySelector("#uideabanner") as HTMLElement | null;
  if (!el) return;
  el.innerHTML = ideaBanner
    ? `<div style="display:flex;align-items:center;gap:9px;margin:8px 16px 0;padding:7px 11px;border:1px solid var(--orange);background:var(--orange-soft);border-radius:9px;">`
      + `<span style="flex:1;min-width:0;font-size:11.5px;color:var(--orange-text);line-height:1.6;">${esc(ideaBanner)}</span>`
      + `<button data-ideagotit="1" style="flex:none;border:none;background:transparent;color:var(--orange-text);font-size:11.5px;cursor:pointer;font-family:inherit;padding:0;white-space:nowrap;">${esc(t("chat.ideaBannerGotIt"))}</button></div>`
    : "";
}
function renderSlashPanel(): void {
  const el = container?.querySelector("#uslash") as HTMLElement | null;
  if (!el) return;
  if (!slashPanelOn()) { el.innerHTML = ""; return; }
  const groups = slashGroupsFiltered();
  const flat = slashFlat();
  const at = Math.min(slashSel, Math.max(flat.length - 1, 0));
  const total = slashCatalog().reduce((n, g) => n + g.items.length, 0);
  const rows = groups.map((g) =>
    `<div style="display:flex;flex-direction:column;">`
    + `<span style="padding:9px 12px 4px;font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--faint);white-space:nowrap;">${esc(g.name)}</span>`
    + g.items.map((a) => {
      const on = flat[at]?.k === a.k;
      const tag = a.tag ? `<span style="flex:none;padding:1px 7px;border-radius:999px;background:var(--chip);color:var(--muted);font-size:10px;font-weight:600;">${esc(a.tag)}</span>` : "";
      return `<div data-slash="${esc(a.k)}" style="display:flex;align-items:center;gap:9px;padding:7px 12px;cursor:pointer;background:${on ? "var(--orange-soft)" : "transparent"};color:${on ? "var(--orange-text)" : "var(--text)"};">`
        + `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><path d="${a.icon}"></path></svg>`
        + `<span style="flex:none;font-size:12.5px;font-weight:600;white-space:nowrap;">${esc(a.label)}</span>`
        + `<span style="flex:1;min-width:0;font-size:11.5px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.desc)}</span>${tag}</div>`;
    }).join("") + `</div>`).join("");
  const empty = !flat.length
    ? `<div style="display:flex;flex-direction:column;gap:7px;padding:14px 12px 15px;">`
      + `<span style="font-size:12.5px;font-weight:600;">${esc(t("chat.slashEmptyTitle", { q: slashQuery() }))}</span>`
      + `<span style="font-size:11.5px;color:var(--faint);line-height:1.65;">${esc(t("chat.slashEmptyBody"))}</span>`
      + `<div style="display:flex;gap:8px;padding-top:2px;">`
      + `<button data-slashgocaps="1" class="${btn("ghost", "sm")}">${esc(t("chat.slashGoCaps"))}</button>`
      + `<button data-slashplain="1" class="${btn("ghost", "sm")}">${esc(t("chat.slashSendAsIs"))}</button></div></div>`
    : "";
  el.innerHTML =
    `<div style="position:absolute;left:16px;bottom:calc(100% - 5px);z-index:40;width:424px;max-width:calc(100% - 32px);display:flex;flex-direction:column;border:1px solid var(--border);border-radius:11px;background:var(--card);box-shadow:0 8px 24px rgba(0,0,0,.13);overflow:hidden;">`
    + `<div style="flex:none;display:flex;align-items:center;gap:10px;padding:8px 12px 7px;border-bottom:1px solid var(--border-soft);">`
    + `<span style="flex:1;min-width:0;font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--faint);white-space:nowrap;">${esc(t("chat.slashTitle"))}</span>`
    + `<span style="flex:none;font-size:10.5px;color:var(--faint);white-space:nowrap;">${esc(t("chat.slashKeys"))}</span></div>`
    + `<div style="max-height:282px;overflow-y:auto;">${rows}${empty}</div>`
    + `<div style="flex:none;padding:7px 12px;border-top:1px solid var(--border-soft);">`
    + `<span style="font-size:10.5px;color:var(--faint);line-height:1.6;">${esc(t("chat.slashFoot", { n: total }))}</span></div></div>`;
}

// 设备离线横幅（稿 1390-1395）：贴在会话头下面，横跨整个消息区顶部。
//
// ⚠️ 这块以前写在 composer 里（`#uoffline`），于是**永远不会渲染**：
// composer 在 `activeConv !== MAIN` 时整个 display:none 并提前 return，
// 而横幅要提示的恰恰是「你正在看的这台设备离线了」—— 只有设备会话才需要它。
// 主会话对面是秘书，不是设备，deviceOf(MAIN) 永远是 undefined，那个判断从来没真过。
// 稿把它画在会话头下面而不是输入框里，也是这个道理：它说的是整个会话的状态，
// 不是「你这条消息发不出去」（设备会话本来就不能发消息）。
function refreshOfflineBar(): void {
  if (!container) return;
  const bar = container.querySelector("#uofflinebar") as HTMLElement | null;
  if (!bar) return;
  const d = activeConv === MAIN ? undefined : deviceOf(activeConv);
  bar.innerHTML = d && !d.online
    ? `<div style="flex:none;display:flex;align-items:center;gap:8px;padding:8px 16px;background:var(--warning-soft);border-bottom:1px solid var(--warning);">`
      + `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><path d="M12 4 2.5 20h19zM12 10v4M12 17v.01"></path></svg>`
      + `<span style="flex:1;min-width:0;font-size:11.5px;color:var(--warning);">${esc(t("chat.deviceOfflineHint"))}</span></div>`
    : "";
}

function send(): void {
  if (!container) return;
  const ta = container.querySelector("#draft") as HTMLTextAreaElement | null;
  if (!ta) return;
  if (clearing) return; // 清空历史进行中，暂不发送，避免与会话重置竞争
  const raw = ta.value.trim();
  if (!raw) return;
  // 芯片承载意图：发出去的是「【动作名】+ 原文」——服务端零改动，秘书的语言理解
  // 接得住，聊天历史里也看得出这条消息带着什么意图（Telegram 的 /命令 同理）。
  const text = chipAction ? `【${chipAction.label}】${raw}` : raw;
  ta.value = "";
  drafts[activeConv] = "";
  chipAction = null;
  ideaBanner = null;
  slashDismissed = false;
  refreshComposer();
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
  // ⚠️ 这里**故意**和稿不一致：稿 7240 画的轨迹是收起态，但稿是静态图，没有「流式」这个概念。
  // 正在生成的回复要能眼看着工具一条条跑出来，收起了就等于把过程藏了，所以新回复保持展开。
  // 注意只有这一处是 true —— 从历史里读出来的回复（loadHistory / 增量同步那三处）仍然收起，
  // 那些已经跑完了，展开只是噪音。真觉得展开吵，把这一个词改回 false 即可。
  s.blocks.push({ kind: "assistant", thinking: true, streaming: true, text: "", trace: [], traceOpen: true, ts: now });
  s.assistantIdx = s.blocks.length - 1;
  s.lastText = t2;
  s.lastAt = now;
  // 「模式」三态开关随批次 005 撤除：一律发 auto（服务端 mode 参数保留一段时间，
  // 界面不再出现）。意图改由「/」动作芯片表达（send 里拼进正文）。
  if (!chatConn.sendMessage(t2, operateAutoApprove(), conv, "auto")) {
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

// 灵感页「让 Umbra 去做这件事」的新通路（稿：不再直发、不再切模式）：
// 跳过来时**预填**「创建任务」芯片 + 灵感正文，配一条来源横幅 ——
// 用户看一眼、补两句再回车，比背着他直接发出去多一步确认，少一次误发。
export function prefillTaskFromIdea(text: string, sourceTitle: string): void {
  chipAction = slashCatalog().flatMap((g) => g.items).find((a) => a.k === "task") || null;
  drafts[MAIN] = text;
  ideaBanner = t("chat.ideaBanner", { title: sourceTitle });
  slashDismissed = false;
  if (activeConv !== MAIN) switchConv(MAIN);
  refreshComposer();
  (container?.querySelector("#draft") as HTMLTextAreaElement | null)?.focus();
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
  headMenuOpen = false; // 菜单里的动作都是「对当前会话」的，换了会话还开着就有歧义
  renderContacts();
  renderHeader();
  renderDetail();
  renderMessages();
  if (!s.loaded) loadConvHistory(id);
}

// 把当前会话序列化成纯文本（消息 + 各类卡片状态），一键复制——方便整段发出去排查问题。
function conversationToText(convId: string): string {
  const s = cs(convId);
  const lines: string[] = [`【会话】${convLabel(convId)}　导出时间 ${new Date().toLocaleString()}`, ""];
  for (const b of s.blocks) {
    if (b.kind === "user") lines.push(`[我] ${b.text}`, "");
    else if (b.kind === "assistant") {
      if (b.trace.length) lines.push("[工具轨迹]", ...b.trace.map((x) => `  ${x}`));
      if (b.text) lines.push(`[秘书] ${b.text}`);
      lines.push("");
    } else if (b.kind === "device") lines.push(`[设备] ${b.text}`, "");
    else if (b.kind === "job") {
      // b.pct 本身就是 0-100 的百分数，别再乘一次（之前导出文本里写成 9000%）。
      lines.push(`[任务卡] ${b.goal}（${b.pct || 0}%，${b.status}）${b.message || ""}`, "");
    } else if (b.kind === "done") {
      const urls = (b.results || []).map((r) => r.url).filter(Boolean).join(" ");
      lines.push(`[任务完成] ${b.goal}${urls ? `　产物：${urls}` : ""}`, "");
    } else if (b.kind === "confirm") {
      lines.push(`[确认卡] ${b.summary}${b.resolved ? `（${b.resolved === "approved" ? "已批准" : "已拒绝"}）` : "（待确认）"}`, "");
    } else if (b.kind === "question") {
      lines.push(`[问答卡] ${b.title}${b.done ? "（已提交）" : "（待回答）"}`, "");
    } else if (b.kind === "system") {
      lines.push(`[系统] ${b.text}`, "");
    } else if (b.kind === "locate") {
      lines.push(`[找位置] ${b.target || b.hint}${b.resolved ? `（${b.resolved}）` : "（待处理）"}`, "");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// 复制当前会话历史到剪贴板。
// 反馈从「按钮文字短暂变成已复制」改成了吐司 —— 动作已经收进溢出菜单里，
// 点完菜单就关了，原来那个会变字的按钮根本不在屏幕上，反馈就丢了。
async function copyActiveHistory(): Promise<void> {
  try {
    await navigator.clipboard.writeText(conversationToText(activeConv));
    showToast(t("chat.copiedHistory"), { tone: "ok" });
  } catch {
    // 剪贴板不可用（权限/环境）时要说一声：这个动作没有别的可见结果，
    // 静默失败等于用户以为复制成功了，去粘贴才发现是空的。
    showToast(t("chat.copyFailed"), { tone: "fail" });
  }
}

// 清空【当前会话】历史：先本地立即清空（乐观），再后台调服务端删除。
async function clearActiveHistory(): Promise<void> {
  if (clearing) return;
  const conv = activeConv;
  const confirmMsg = conv === MAIN ? t("chat.clearConfirm") : t("chat.clearConfirmDevice", { name: convLabel(conv) });
  if (!await askConfirm({ message: confirmMsg, confirmText: t("chat.clearHistory"), danger: true })) return;
  clearing = true;
  resetConv(conv);
  renderMessages();
  renderContacts();
  try {
    await clearHistory(conv);
    showToast(t("chat.clearedToast"), { tone: "ok" });
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
  // 三栏底色照稿：联系人栏与设备详情栏是 --rail（1324、1714），会话头是 --card（1365），
  // 中间消息区留给 --bg。之前联系人栏和详情栏都写成了 --card、会话头没设底色继承了 --bg ——
  // 结果是「两侧比中间浅」，稿要的是「两侧比中间沉」，层次整个反了。
  // kit README 特意为详情栏标过一句「不是 --card」，就是因为这处容易写错。
  el.innerHTML = `
    <div style="display:flex;height:100%;min-height:0;">
      <aside style="flex:none;width:236px;border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0;background:var(--rail);">
        <div style="padding:14px 16px 10px;font-size:12px;font-weight:600;color:var(--muted);flex:none;">${esc(t("chat.contacts"))}</div>
        <div id="ucontacts" style="flex:1;overflow-y:auto;padding:0 8px 10px;display:flex;flex-direction:column;gap:2px;min-height:0;"></div>
      </aside>
      <section style="flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;position:relative;">
        <div id="uchathead" style="position:relative;display:flex;align-items:center;gap:9px;padding:10px 16px;border-bottom:1px solid var(--border);flex:none;background:var(--card);"></div>
        <div id="uofflinebar"></div>
        <div id="umsgs" style="flex:1;overflow-y:auto;padding:18px 20px 22px;display:flex;flex-direction:column;gap:14px;min-height:0;"></div>
        <div id="ucomposer" style="flex:none;border-top:1px solid var(--border);background:var(--card);"></div>
        <div id="ulightbox"></div>
      </section>
      <aside id="udetail" style="display:none;flex:none;width:272px;border-left:1px solid var(--border);overflow-y:auto;background:var(--rail);"></aside>
    </div>`;

  // 点空白处关掉标题栏的溢出菜单。挂在 document 上（捕获阶段之外即可）而不是壳上 ——
  // 菜单要能被「点消息区」「点联系人」「点右侧详情」任意一处关掉，壳内冒泡覆盖不全。
  // 菜单自身与 ⋯ 按钮的 click 都 stopPropagation 了，不会自己把自己关掉。
  if (docClickHandler) document.removeEventListener("click", docClickHandler);
  docClickHandler = () => {
    if (!headMenuOpen) return;
    headMenuOpen = false;
    renderHeader();
  };
  document.addEventListener("click", docClickHandler);

  const contactsEl = el.querySelector("#ucontacts") as HTMLElement;
  contactsEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-conv]") as HTMLElement | null;
    if (btn && btn.dataset.conv) switchConv(btn.dataset.conv);
  });
  const msgsEl = el.querySelector("#umsgs") as HTMLElement;
  msgsEl.addEventListener("click", onMsgsClick);
  // 问答卡的自定义填空：随敲随存（不重渲染，避免打断输入焦点）。
  msgsEl.addEventListener("input", (ev) => {
    const t2 = ev.target as HTMLInputElement;
    if (t2 && t2.dataset && t2.dataset.qcustom !== undefined) {
      const i = Number(t2.dataset.qcustom);
      const b = cs(activeConv).blocks[i];
      if (b && b.kind === "question") {
        const q = b.questions[b.at];
        if (q) {
          b.custom[q.id] = t2.value;
          // 就地刷新「下一题/提交」按钮的可用态——之前只存值不刷按钮，
          // 不点选项、直接输入自定义答案时按钮一直是灰的，进不了下一题（实测 bug）。
          const answered = (b.picked[q.id] || []).length > 0 || t2.value.trim().length > 0;
          // 只翻 disabled 就够了：按钮走的是工厂类名，禁用态由 disabled: 变体接管，
          // 不用再手改 background / cursor（以前那两行写死了 --border 底 + 白字，
          // 深色下是一块灰底白字的东西，跟「禁用态一律 chip 底 + faint 字」的硬规则也对不上）。
          const nextBtn = msgsEl.querySelector(`[data-qnext="${i}"],[data-qsubmit="${i}"]`) as HTMLButtonElement | null;
          if (nextBtn) nextBtn.disabled = !answered;
        }
      }
    }
    // 「找位置」卡的文字纠偏：同样随敲随存 + 只翻按钮的 disabled，不重渲染。
    // 重渲染会把 <input> 整个换掉，光标就跑了 —— 问答卡那边踩过，这里照抄它的做法。
    if (t2 && t2.dataset && t2.dataset.locfb !== undefined) {
      const i = Number(t2.dataset.locfb);
      const b = cs(activeConv).blocks[i];
      if (b && b.kind === "locate") {
        b.fbText = t2.value;
        const sendBtn = msgsEl.querySelector(`[data-locfbsend="${i}"]`) as HTMLButtonElement | null;
        if (sendBtn) sendBtn.disabled = !t2.value.trim();
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
  const el = (e.target as HTMLElement).closest(
    "[data-trace],[data-approve],[data-approve-always],[data-deny],[data-img],[data-qopt],[data-qprev],[data-qnext],[data-qsubmit],[data-reconnect],[data-jobact],"
    + "[data-locshot],[data-locclear],[data-locfbtoggle],[data-locfbsend],[data-locpause],[data-locsend],[data-locresume]",
  ) as HTMLElement | null;
  if (!el) return;
  // ── 错误块的「重新连接」──
  // 用 data-* 而不是 id：一屏里可能有多条错误块，id 会重复。
  if (el.dataset.reconnect !== undefined) {
    chatConn.connect();
    return;
  }
  // ── 任务卡底部的动作按钮 ──
  if (el.dataset.jobact !== undefined) {
    const taskId = el.dataset.jobact;
    if (!taskId) return;
    if (el.dataset.jobfail) {
      // 失败 → 重试。retryTask 会保留已完成的步骤，只重跑断掉的那些，所以文案是「重试」不是「重来」。
      // 电脑操控任务服务端会回 409「不支持重试」——原样提示，让用户重新发起一次。
      void retryTask(taskId).then((r) => {
        if (r.ok) showToast(t("chat.retryStarted"), { tone: "ok" });
        else showToast(r.error || t("chat.retryFailed"), { tone: "fail" });
      });
      return;
    }
    // 其余 → 跳到任务页并展开这条任务。回调没接上（理论上不会发生）就什么也不做，
    // 总比抛异常把整个点击代理打断强。
    openTaskCb?.(taskId);
    return;
  }
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
  // ── 「找位置」卡 ──
  const li = el.dataset.locshot ?? el.dataset.locclear ?? el.dataset.locfbtoggle
    ?? el.dataset.locfbsend ?? el.dataset.locpause ?? el.dataset.locsend ?? el.dataset.locresume;
  if (li !== undefined) {
    const b = cs(activeConv).blocks[Number(li)];
    if (!b || b.kind !== "locate") return;
    if (el.dataset.locshot !== undefined) {
      // 点在截图上 → 换算成归一化 0-1000。两个坑：
      //  1. 不能用 offsetX：它是相对**事件目标**算的，目标可能是 <img> 也可能是外层容器
      //     （点在边框/圆角上时），两者原点差一圈，混用会让某几次点击整体偏一截。
      //  2. 要量 <img> 自己的矩形，不是容器的 —— 容器带 1px 描边，拿它当基准整张图会偏。
      const img = (el as HTMLElement).querySelector("img");
      const r = (img || (el as HTMLElement)).getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const e2 = e as MouseEvent;
        b.nx = Math.max(0, Math.min(1000, Math.round(((e2.clientX - r.left) / r.width) * 1000)));
        b.ny = Math.max(0, Math.min(1000, Math.round(((e2.clientY - r.top) / r.height) * 1000)));
      }
    } else if (el.dataset.locclear !== undefined) {
      b.nx = undefined; b.ny = undefined;
    } else if (el.dataset.locfbtoggle !== undefined) {
      b.fbOpen = !b.fbOpen;
    } else if (el.dataset.locfbsend !== undefined) {
      const txt = (b.fbText || "").trim();
      if (!txt) return;
      chatConn.sendLocate(b.askId, { feedback: txt });
      b.resolved = "feedback";
      showToast(t("chat.locateFbSentToast"), { tone: "ok" });
    } else if (el.dataset.locpause !== undefined) {
      chatConn.sendLocate(b.askId, { paused: true });
      b.resolved = "paused";
    } else if (el.dataset.locsend !== undefined) {
      if (b.nx === undefined || b.ny === undefined) return;
      chatConn.sendLocate(b.askId, { nx: b.nx, ny: b.ny });
      b.resolved = "located";
      showToast(t("chat.locateSentToast"), { tone: "ok" });
    } else if (el.dataset.locresume !== undefined) {
      // 「继续」按 run_id 走，不是 ask_id：一次操控可能求助过好几次，
      // 服务端等的是「这次运行能接着跑了」。runId 为空说明这条求助是旧协议来的，
      // 唤不醒就别把卡片标成已继续，不然按钮消失了、任务还吊着。
      if (!b.runId) { showToast(t("chat.locateResumeNoJob"), { tone: "fail" }); return; }
      chatConn.sendOperateResume(b.runId);
      b.resolved = "resumed";
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
    // 这一下改的是**全局开关**，以后同类操作都不再问了 —— 影响比「批准这一次」大得多，
    // 必须给回执。稿 7273 的文案就是这句。
    showToast(t("chat.alwaysAllowed"), { tone: "warn" });
  } else if (el.dataset.approve) {
    chatConn.sendConfirm(el.dataset.approve, true);
    resolveConfirm(el.dataset.approve, true);
    renderMessages();
    showToast(t("chat.approvedToast"), { tone: "ok" });
  } else if (el.dataset.deny) {
    chatConn.sendConfirm(el.dataset.deny, false);
    resolveConfirm(el.dataset.deny, false);
    renderMessages();
    showToast(t("chat.deniedToast"));
  } else if (el.dataset.img) {
    openLightbox(el.dataset.img);
  }
}

// 标记某张确认单已被处理（所有会话里的任务卡内嵌授权 + 独立确认卡都更新）。
function resolveConfirm(confirmId: string, approved: boolean): void {
  for (const id of Object.keys(convs)) {
    const s = convs[id];
    if (!s) continue;
    for (const b of s.blocks) {
      if (b.kind === "job" && b.confirmId === confirmId) { b.confirmId = undefined; b.message = approved ? t("chat.approved") : t("chat.denied"); }
      if (b.kind === "confirm" && b.confirmId === confirmId) { b.resolved = approved ? "approved" : "denied"; }
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
  headMenuOpen = false;
  if (docClickHandler) { document.removeEventListener("click", docClickHandler); docClickHandler = null; }
}

export function serverLabel(): string {
  return getServerUrl().replace(/^https?:\/\//, "");
}
