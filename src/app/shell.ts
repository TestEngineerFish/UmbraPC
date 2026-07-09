// 主窗口 shell：React 根(app/App.tsx)之下的 legacy 桥接层。
// 提供标题栏/侧边栏(仍为 legacy HTML，经 LegacyHost 托管)、全局状态与 React 页面复用的处理器/访问器，
// 以及 render()→React 重渲染、nav 同步、点击/键盘委托与设备事件订阅(initLegacy)。
// 业务逻辑走 services/*(server/desktop/…)；聊天走 features/chat。

import { chatConn, getServerUrl, setServerUrl, setToken, getToken, getDeviceName, setDeviceName } from "../services/server";
import { fetchJobs, fetchJobDetail, type Job, type JobDetail } from "../services/server";
import { fetchInspirations, type Inspiration } from "../services/server";
import * as chat from "../features/chat/chat";
import * as desktop from "../services/desktop";
import { t } from "../i18n";

export type Nav = "chat" | "tasks" | "inspiration" | "abilities" | "realtime" | "logs" | "settings";

const state = {
  nav: "chat" as Nav,
  dark: false,
  cu: false,
  codingMode: 1,
  tasks: {
    list: [] as Job[],
    loading: false,
    refreshing: false,
    detailId: null as string | null,
    detail: null as JobDetail | null,
  },
  insp: {
    list: [] as Inspiration[],
    loading: false,
    refreshing: false,
    filter: "" as "" | "open" | "done" | "archived",
  },
  // 剪贴板历史设置
  clip: {
    enabled: true,
    shortcut: "Alt+V",
    recording: false, // 正在录制快捷键
  },
  // 截图设置
  shot: {
    enabled: true,
    shortcut: "CommandOrControl+Alt+A",
    recording: false,
    hasGlmKey: false,
  },
};

// 剪贴板历史 IPC 桥（面板与设置页共用；浏览器预览下为 undefined）。
interface ClipBridge {
  clear(): Promise<boolean>;
  getSettings(): Promise<{ enabled: boolean; shortcut: string }>;
  setEnabled(enabled: boolean): Promise<void>;
  setShortcut(acc: string): Promise<{ ok: boolean }>;
}
const clipBridge: ClipBridge | undefined = (window as unknown as { umbraClip?: ClipBridge }).umbraClip;

// ── React 桥接（Phase A：React 作为根，托管现有 vanilla 渲染）──
// 现有代码里所有 render() 调用改为触发 React 重渲染；nav 变化同步给 React。
let bridgeRerender: () => void = () => {};
let bridgeNav: (n: Nav) => void = () => {};
export function setBridge(rerender: () => void, nav: (n: Nav) => void): void {
  bridgeRerender = rerender;
  bridgeNav = nav;
}
export function toggleTheme(): void {
  state.dark = !state.dark;
  bridgeRerender();
}
export function mountChat(el: HTMLElement): void {
  chat.mount(el);
}
export function getNav(): Nav {
  return state.nav;
}
export function isDark(): boolean {
  return state.dark;
}

// 截图 IPC 桥（设置页用；浏览器预览下为 undefined）。
interface ShotBridge {
  getSettings(): Promise<{ enabled: boolean; shortcut: string; hasGlmKey: boolean }>;
  setEnabled(enabled: boolean): Promise<void>;
  setShortcut(acc: string): Promise<{ ok: boolean }>;
  setGlmKey(key: string): Promise<boolean>;
}
const shotBridge: ShotBridge | undefined = (window as unknown as { umbraShot?: ShotBridge }).umbraShot;



const SVG = {
  chat: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-11.9 7.6L4 20l1-4.6A8.4 8.4 0 1 1 21 11.5z"></path></svg>`,
  tasks: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"></path><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"></path></svg>`,
  inspiration: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4"></path><path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.8.9.9 1.5l.1.7h5.2l.1-.7c.1-.6.4-1.1.9-1.5A6 6 0 0 0 12 3z"></path></svg>`,
  abilities: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect></svg>`,
  realtime: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>`,
  logs: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="2"></rect><path d="M6.5 9l3 2.5-3 2.5M12 15h5"></path></svg>`,
  settings: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"></path><circle cx="16" cy="7" r="2.4"></circle><circle cx="8" cy="17" r="2.4"></circle></svg>`,
};

function navItem(key: Nav, label: string, svg: string): string {
  const active = state.nav === key;
  const style = `display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;font-size:13.5px;cursor:pointer;border:none;width:100%;text-align:left;font-family:inherit;white-space:nowrap;background:${active ? "var(--orange)" : "transparent"};color:${active ? "#fff" : "rgba(255,255,255,.72)"};font-weight:${active ? 600 : 500};`;
  return `<button data-act="nav-${key}" style="${style}">${svg}<span>${label}</span></button>`;
}


function titlebar(): string {
  const themeIcon = state.dark
    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path></svg>`;
  return `
  <div style="height:40px;flex:none;display:flex;align-items:center;gap:12px;padding:0 14px;background:var(--titlebar);border-bottom:1px solid var(--border);-webkit-app-region:drag;">
    <div style="display:flex;gap:8px;align-items:center;">
      <span style="width:12px;height:12px;border-radius:999px;background:#FF5F57;"></span>
      <span style="width:12px;height:12px;border-radius:999px;background:#FEBC2E;"></span>
      <span style="width:12px;height:12px;border-radius:999px;background:#28C840;"></span>
    </div>
    <span style="font-weight:600;font-size:13px;letter-spacing:.2px;">Umbra</span>
    <div style="flex:1;"></div>
    <button data-act="theme" title="${t("conn.toggleTheme")}" style="-webkit-app-region:no-drag;display:flex;align-items:center;justify-content:center;width:28px;height:24px;border:1px solid var(--border);background:var(--card);border-radius:7px;color:var(--muted);cursor:pointer;">${themeIcon}</button>
    ${connBadge()}
  </div>`;
}

function connBadge(): string {
  const s = chatConn.status;
  const color = s === "online" ? "var(--success)" : s === "connecting" ? "var(--warning)" : "var(--danger)";
  const soft = s === "online" ? "var(--success-soft)" : s === "connecting" ? "var(--warning-soft)" : "var(--danger-soft)";
  const label = s === "online" ? t("conn.onlineWithServer", { server: chat.serverLabel() }) : s === "connecting" ? t("conn.connecting") : t("conn.offline");
  return `<div style="display:flex;align-items:center;gap:7px;padding:3px 10px;border:1px solid var(--border);border-radius:999px;background:var(--card);">
      <span style="width:8px;height:8px;border-radius:999px;background:${color};box-shadow:0 0 0 3px ${soft};"></span>
      <span style="font-size:11.5px;color:var(--muted);">${label}</span>
    </div>`;
}

// 设备 ID 展示：桌面态取真实 deviceId，否则占位。
function deviceIdLabel(): string {
  const ds = desktop.getDeviceState();
  return ds?.deviceId || t("common.desktopOnly");
}

// 设备引擎状态卡（仅桌面应用显示）：连接状态 + Provider 数 + 最近任务。

// Token 输入占位：设备注册需要与服务端 ASSIST_TOKEN 一致。
function tokenPlaceholder(): string {
  const set = desktop.isDesktop() ? !!desktop.getDesktopConfig()?.hasToken : !!getToken();
  return set ? t("settings.tokenSaved") : t("settings.tokenHint");
}

// 设置页里的内联连接状态。

function sidebar(): string {
  return `
  <nav style="width:180px;flex:none;background:var(--nav);display:flex;flex-direction:column;padding:14px 10px;gap:3px;">
    <div style="display:flex;align-items:center;gap:9px;padding:4px 6px 14px;">
      <span style="width:26px;height:26px;border-radius:7px;background:var(--orange);color:#fff;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center;">U</span>
      <span style="color:#fff;font-weight:600;font-size:14.5px;">Umbra</span>
    </div>
    ${navItem("chat", t("nav.chat"), SVG.chat)}
    ${navItem("tasks", t("nav.tasks"), SVG.tasks)}
    ${navItem("inspiration", t("nav.inspiration"), SVG.inspiration)}
    ${navItem("abilities", t("nav.abilities"), SVG.abilities)}
    ${navItem("realtime", t("nav.realtime"), SVG.realtime)}
    ${navItem("logs", t("nav.logs"), SVG.logs)}
    ${navItem("settings", t("nav.settings"), SVG.settings)}
    <div style="flex:1;"></div>
    <div style="border-top:1px solid rgba(255,255,255,.08);padding:12px 6px 2px;">
      <div style="color:rgba(255,255,255,.9);font-size:12px;font-weight:500;">MacBook-Pro-2.local</div>
      <div style="color:rgba(255,255,255,.42);font-size:11px;margin-top:2px;">macOS · ${t("sidebar.thisDevice")}</div>
    </div>
  </nav>`;
}

function chatScreen(): string {
  // 聊天屏由 chat 模块接管（实时连接 /ws/chat）；这里只放挂载容器。
  return `<div id="chatroot" style="height:100%;min-height:0;"></div>`;
}



// 解析 SQLite UTC 时间戳 "YYYY-MM-DD HH:MM:SS" → Date。
function parseTs(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? null : d;
}
// 时间戳 → 本地 HH:MM（详情时间线可带秒）。
function fmtTime(s?: string, withSec = false): string {
  const d = parseTs(s);
  if (!d) return "";
  return d.toLocaleTimeString([], withSec ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
}
// IM 风格相对时间：今天→HH:MM，昨天→昨天，今年→M月D日，更早→YYYY/M/D。
function fmtListTime(s?: string): string {
  const d = parseTs(s);
  if (!d) return "";
  const now = new Date();
  const sod = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((sod(now) - sod(d)) / 86400000);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days <= 0) return hm;
  if (days === 1) return t("time.yesterday");
  if (d.getFullYear() === now.getFullYear()) return t("time.monthDay", { month: d.getMonth() + 1, day: d.getDate() });
  return t("time.yearMonthDay", { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() });
}



// 解析子任务结果，渲染图片/文件链接/本机路径/变更清单。





// 单张能力卡：状态(检测/停用) + 启用开关；自定义程序additionally可编辑/删除。

// 桌面态：用设备引擎上报的真实 Provider 渲染能力页。

// 自定义程序 新增/编辑 表单弹窗。

// 把弹窗表单当前 DOM 值同步进 state（增删技能/保存前调用，避免重渲染丢输入）。

function delProv(prov: string): void {
  const list = desktop.getCustomProviders().filter((p) => p.provider !== prov);
  desktop.saveCustomProviders(list).then(render).catch(() => {});
}


// 桌面态：computer-use 实时监看（v0 展示开关/权限状态 + 原子动作历史；operate 自主循环后续接入）。



// 单条权限行：已授予显示绿勾，否则显示"去授权"按钮。

// 权限卡：桌面态读取真实授权状态（辅助功能 / 屏幕录制），按钮打开系统设置对应面板。

// 剪贴板历史设置卡片（开关 / 快捷键录制 / 清空历史）。

// 载入剪贴板设置（进入设置页时）。
async function loadClipSettings(): Promise<void> {
  if (!clipBridge) return;
  try {
    const s = await clipBridge.getSettings();
    state.clip.enabled = s.enabled;
    state.clip.shortcut = s.shortcut;
    if (state.nav === "settings") render();
  } catch {
    /* ignore */
  }
}

// 截图设置卡片（开关 / 快捷键录制）。

async function loadShotSettings(): Promise<void> {
  if (!shotBridge) return;
  try {
    const s = await shotBridge.getSettings();
    state.shot.enabled = s.enabled;
    state.shot.shortcut = s.shortcut;
    state.shot.hasGlmKey = s.hasGlmKey;
    if (state.nav === "settings") render();
  } catch {
    /* ignore */
  }
}

// 通用快捷键录制：捕获修饰键 + 物理键位（event.code），组装 Electron Accelerator。
type ShortcutTarget = "clip" | "shot";
function beginShortcutRecording(target: ShortcutTarget): void {
  const bridge = target === "clip" ? clipBridge : shotBridge;
  if (!bridge) return;
  const slot = target === "clip" ? state.clip : state.shot;
  slot.recording = true;
  desktop.pauseShortcuts(); // 录制期间暂停全局快捷键，避免按下旧键触发功能
  render();
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      finish();
      return;
    }
    const mods: string[] = [];
    if (e.metaKey) mods.push("Command");
    if (e.ctrlKey) mods.push("Control");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    const code = e.code;
    let main = "";
    if (/^Key([A-Z])$/.test(code)) main = code.slice(3);
    else if (/^Digit([0-9])$/.test(code)) main = code.slice(5);
    else if (/^F([0-9]{1,2})$/.test(code)) main = code;
    else if (code === "Space") main = "Space";
    else if (code === "Backquote") main = "`";
    if (mods.length === 0 || !main) return; // 必须含修饰键 + 有效主键
    const acc = [...mods, main].join("+");
    bridge.setShortcut(acc).then((r) => {
      if (!r.ok) console.warn("快捷键注册失败（可能被占用）：" + acc);
    });
    slot.shortcut = acc;
    finish();
  };
  const finish = () => {
    slot.recording = false;
    window.removeEventListener("keydown", onKey, true);
    desktop.resumeShortcuts(); // 恢复全局快捷键（新键已在 setShortcut 里注册）
    render();
  };
  window.addEventListener("keydown", onKey, true);
}

function toggleClipEnabled(): void {
  if (!clipBridge) return;
  state.clip.enabled = !state.clip.enabled;
  render();
  clipBridge.setEnabled(state.clip.enabled).catch(() => {});
}

function clearClipHistory(): void {
  if (!clipBridge) return;
  if (!confirm(t("settings.clipClearConfirm"))) return;
  clipBridge.clear().catch(() => {});
}

function toggleShotEnabled(): void {
  if (!shotBridge) return;
  state.shot.enabled = !state.shot.enabled;
  render();
  shotBridge.setEnabled(state.shot.enabled).catch(() => {});
}



// 只剩聊天页走 LegacyHost 桥接（其余页面均 React 化）。
function currentScreen(): string {
  return chatScreen();
}

// 触发 React 重渲染（React 的 LegacyHost 会重建各区块 innerHTML 并还原滚动、挂载聊天子树）。
function render(): void {
  bridgeRerender();
}

// 从设置表单读取并保存连接配置，然后重连。

// React 设置页用：带参保存连接配置并重连（等价于旧 saveAndReconnect，但入参来自受控输入）。
export function applyConnection(server: string, token: string, device: string): void {
  if (server) setServerUrl(server);
  if (token) setToken(token);
  if (device) setDeviceName(device);
  desktop.pushConfig({ serverUrl: server || getServerUrl(), token: token || "", deviceName: device || getDeviceName() }).catch(() => {});
  chatConn.reconnect();
  render();
}
// React 设置页用：保存智谱 Key（入参来自受控输入）。
export function setShotGlmKey(key: string): void {
  if (!shotBridge) return;
  const k = (key || "").trim();
  if (!k) return;
  shotBridge.setGlmKey(k).then(() => {
    state.shot.hasGlmKey = true;
    render();
  }).catch(() => {});
}
// React 设置页用的状态访问器。
export function getCodingMode(): number {
  return state.codingMode;
}
export function getClipState() {
  return state.clip;
}
export function getShotState() {
  return state.shot;
}
// React 页面切换（复用 setNav 的副作用 + 同步 React nav）。
export function navigate(n: Nav): void {
  setNav(n);
}
export function getTasksState() {
  return state.tasks;
}
export function getInspState() {
  return state.insp;
}
export function setInspFilter(f: "" | "open" | "done" | "archived"): void {
  state.insp.filter = f;
  loadInspirations();
}
// React 能力页：写入/删除自定义程序（复用 providers.json 持久化逻辑）。
export function saveCustomProviderEntry(entry: desktop.CustomProviderCfg, original: string | null): void {
  const list = [...desktop.getCustomProviders()];
  const idx = list.findIndex((p) => p.provider === (original || entry.provider));
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  desktop.saveCustomProviders(list).then(render).catch(() => {});
}
export function deleteCustomProvider(prov: string): void {
  delProv(prov);
}
export function toggleProviderEnabled(prov: string): void {
  desktop.setProviderEnabled(prov, desktop.isProviderDisabled(prov)).then(render).catch(() => {});
}

const EXEC_MODES = ["never", "confirm", "always"] as const;
// coding 权限切换：同步到设备引擎。
function setCodingMode(m: number): void {
  state.codingMode = m;
  desktop.pushConfig({ codingAllowExec: EXEC_MODES[m] }).catch(() => {});
  render();
}

// computer-use 总开关当前值（桌面态取主进程配置）。
function computerEnabled(): boolean {
  return desktop.isDesktop() ? !!desktop.getDesktopConfig()?.computerUseEnabled : state.cu;
}
// 切换 computer-use：写主进程配置并触发设备重注册（registry 据此增/删 computer Provider）。
function toggleComputerUse(): void {
  const next = !computerEnabled();
  state.cu = next;
  render();
  desktop.pushConfig({ computerUseEnabled: next }).then(() => render()).catch(() => {});
}

// ── 任务页数据（/jobs）──────────────────────────────────────────────────────
let tasksTimer: number | undefined;

// 拉取任务列表；若详情抽屉打开则一并刷新详情。
async function loadJobs(): Promise<void> {
  if (state.tasks.list.length === 0) state.tasks.loading = true;
  const [list, detail] = await Promise.all([
    fetchJobs(30),
    state.tasks.detailId ? fetchJobDetail(state.tasks.detailId) : Promise.resolve(null),
  ]);
  state.tasks.list = list;
  state.tasks.loading = false;
  if (state.tasks.detailId && detail) state.tasks.detail = detail;
  if (state.nav === "tasks") render();
}

// 手动刷新：转圈动效 + 至少转满 500ms，给出明确反馈。
async function manualRefresh(): Promise<void> {
  state.tasks.refreshing = true;
  render();
  await Promise.all([loadJobs(), new Promise((r) => setTimeout(r, 500))]);
  state.tasks.refreshing = false;
  render();
}

function startTasksPolling(): void {
  loadJobs();
  if (tasksTimer) clearInterval(tasksTimer);
  tasksTimer = window.setInterval(loadJobs, 3500);
}
function stopTasksPolling(): void {
  if (tasksTimer) clearInterval(tasksTimer);
  tasksTimer = undefined;
}

// ── 灵感页数据（/inspirations）───────────────────────────────────────────────
let inspTimer: number | undefined;

async function loadInspirations(): Promise<void> {
  if (state.insp.list.length === 0) state.insp.loading = true;
  state.insp.list = await fetchInspirations(state.insp.filter || undefined);
  state.insp.loading = false;
  if (state.nav === "inspiration") render();
}
async function manualRefreshInsp(): Promise<void> {
  state.insp.refreshing = true;
  render();
  await Promise.all([loadInspirations(), new Promise((r) => setTimeout(r, 400))]);
  state.insp.refreshing = false;
  render();
}
function startInspPolling(): void {
  loadInspirations();
  if (inspTimer) clearInterval(inspTimer);
  inspTimer = window.setInterval(loadInspirations, 5000);
}
function stopInspPolling(): void {
  if (inspTimer) clearInterval(inspTimer);
  inspTimer = undefined;
}

async function openJob(id: string): Promise<void> {
  state.tasks.detailId = id;
  state.tasks.detail = null;
  render();
  const d = await fetchJobDetail(id);
  if (state.tasks.detailId === id) {
    state.tasks.detail = d;
    render();
  }
}
function closeJob(): void {
  state.tasks.detailId = null;
  state.tasks.detail = null;
  render();
}

// 切换页面：管理任务轮询的启停。
function setNav(nav: Nav): void {
  state.nav = nav;
  if (nav === "tasks") startTasksPolling();
  else stopTasksPolling();
  if (nav === "inspiration") startInspPolling();
  else stopInspPolling();
  if (nav === "settings") {
    loadClipSettings();
    loadShotSettings();
  }
  bridgeNav(nav); // 同步给 React（会触发重渲染）
}

// 只处理仍由 legacy HTML 承载的 chrome：侧边栏 nav 与标题栏 theme（其余页面已 React 化，各自处理事件）。
function onClick(e: MouseEvent): void {
  const target = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
  if (!target) return;
  const act = target.dataset.act!;
  if (act === "noop") { e.preventDefault(); return; }
  if (act.startsWith("nav-")) { setNav(act.slice(4) as Nav); return; }
  if (act === "theme") { state.dark = !state.dark; render(); }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && state.tasks.detailId) closeJob();
}

// 由 React 根（main.tsx）在挂载后调用：接管点击委托、键盘、设备事件订阅。
export function initLegacy(): void {
  chat.setAppRerender(render);
  document.addEventListener("click", onClick); // 委托：处理各页面/弹窗内的 data-act（含侧边栏 nav / 标题栏 theme）
  window.addEventListener("keydown", onKeydown);
  // 快捷入口「发给秘书」：跳到聊天页并把这条消息发给秘书。
  const umbra = (window as unknown as { umbra?: { onLauncherSendChat?: (cb: (t: string) => void) => () => void } }).umbra;
  umbra?.onLauncherSendChat?.((text) => {
    setNav("chat");
    setTimeout(() => chat.sendText(text), 0); // 等聊天页挂载后再发，确保渲染
  });
  // 窗口重新获得焦点时刷新权限状态（用户可能刚去系统设置授予了权限）。
  window.addEventListener("focus", () => {
    if (desktop.isDesktop()) desktop.refreshPermissions().then(() => { if (state.nav === "settings") render(); });
  });
  // 桌面态：同步主进程配置并订阅设备引擎状态（浏览器预览下为 no-op）。
  // 聊天页从不被设备事件重渲染（自管子树）；日志只在日志页刷新；其它页仅 state 事件刷新。
  desktop.initDesktop((kind) => {
    if (state.nav === "chat") return;
    if (kind === "log" && state.nav !== "logs") return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return; // 正在输入，别打断
    render();
  }).catch(() => {});
}

// 供 React 根渲染各区块。
export { titlebar, sidebar, currentScreen };
// 供 React 设置页复用的处理器 / 载入器。
export { setCodingMode, toggleComputerUse, computerEnabled, tokenPlaceholder, deviceIdLabel, toggleClipEnabled, clearClipHistory, toggleShotEnabled, beginShortcutRecording, loadClipSettings, loadShotSettings };
// 供 React 任务页复用。
export { openJob, closeJob, manualRefresh, fmtTime, fmtListTime };
// 供 React 灵感页复用。
export { manualRefreshInsp };
