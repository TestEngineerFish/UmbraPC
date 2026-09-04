// 主窗口 shell：React 根(app/App.tsx)之下的 legacy 桥接层。
// 提供标题栏/侧边栏(仍为 legacy HTML，经 LegacyHost 托管)、全局状态与 React 页面复用的处理器/访问器，
// 以及 render()→React 重渲染、nav 同步、点击/键盘委托与设备事件订阅(initLegacy)。
// 业务逻辑走 services/*(server/desktop/…)；聊天走 features/chat。

import { chatConn, getServerUrl, setServerUrl, hasToken, getDeviceName, setDeviceName } from "../services/server";
import { fetchTasks, fetchTaskDetail, type TaskItem, type TaskDetail } from "../services/server";
import { fetchInspirations, fetchInspirationCounts, type Inspiration, type InspirationCounts } from "../services/server";
import { readLayout, toAccelerator, type LayoutMap } from "../components/hotkey";
import * as chat from "../features/chat/chat";
import * as desktop from "../services/desktop";
import { t } from "../i18n";
import { askConfirm, showToast } from "../components/overlay";

// 一级导航。工作流 / 密码保险箱 / 运行时环境 / 小工具**四项并列**（稿 4884-4889），
// 它们共用同一个 tools 视图，靠这里的取值决定进哪个子页 —— 不是四个独立页面。
// 之前只有一个 "tools"，四个功能全塞在它的二级侧栏里，跟稿差了一整层。
export type Nav = "chat" | "tasks" | "notify" | "money" | "workspaces" | "inspiration"
  | "abilities" | "flow" | "realtime" | "vault" | "runtime" | "tools" | "phrases"
  | "logs" | "settings";

// 走 tools 视图的四项。用于判断「要不要显示 190px 二级目录」——
// 只有小工具那一项要（它下面还有剪贴板/截图/快捷入口/常用语四个子页），其余三项自己铺满。
export const TOOLS_NAV: readonly Nav[] = ["flow", "vault", "runtime", "tools"];

// 外观偏好的持久化 key。标题栏那颗按钮与设置页的「外观」是同一份状态，
// 独立窗口（保险箱 vault.html / 工作流 workflow.html）与主窗口同源共享 localStorage，
// 靠这个 key + storage 事件跟随主窗口，因此它们内部不再各挂一个切换按钮。
const LS_THEME = "umbra.theme";
// 三档：显式浅色 / 显式深色 / 跟随系统。system 时实际深浅由 prefers-color-scheme 决定。
export type ThemePref = "light" | "dark" | "system";

// 读取已持久化的外观偏好。隐私模式 / storage 被禁时按浅色兜底，不让它抛出打断启动。
function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(LS_THEME);
    return v === "dark" || v === "system" ? v : "light";
  } catch { return "light"; }
}
// 系统当前是不是深色。matchMedia 在极老的环境里可能没有，兜底当浅色。
function systemDark(): boolean {
  try { return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false; } catch { return false; }
}
// 偏好 → 实际深浅。
function resolveDark(p: ThemePref): boolean {
  return p === "system" ? systemDark() : p === "dark";
}

const state = {
  nav: "chat" as Nav,
  themePref: readThemePref(),
  dark: resolveDark(readThemePref()),
  cu: false,
  codingMode: 1,
  tasks: {
    list: [] as TaskItem[],
    loading: false,
    refreshing: false,
    detailId: null as string | null,
    detail: null as TaskDetail | null,
  },
  insp: {
    list: [] as Inspiration[],
    loading: false,
    refreshing: false,
    filter: "" as "" | "open" | "done" | "archived",
    // 各状态条数：筛选栏四个数字要同时显示，列表按 status 查只回一种状态。
    counts: { all: 0, open: 0, done: 0, archived: 0 } as InspirationCounts,
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
// 设置外观偏好。写 localStorage 是为了让独立窗口跟随（storage 事件只在别的窗口触发，正合适），
// 顺带做到重启后保留上次选择。
export function setThemePref(p: ThemePref): void {
  state.themePref = p;
  state.dark = resolveDark(p);
  try { localStorage.setItem(LS_THEME, p); } catch { /* 写不进去只影响持久化，当前窗口照常切 */ }
  bridgeRerender();
}
export function getThemePref(): ThemePref {
  return state.themePref;
}
// 标题栏那颗按钮：始终在「显式浅色 / 显式深色」之间翻，按当前实际效果取反。
// 从「跟随系统」点一下就落到显式档，这跟系统设置类里的快捷开关是一个手感。
export function toggleTheme(): void {
  setThemePref(state.dark ? "light" : "dark");
}
// 跟随系统时要实时跟着系统日夜切换走。偏好不是 system 时监听器什么也不做。
try {
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.themePref !== "system") return;
    state.dark = systemDark();
    bridgeRerender();
  });
} catch { /* 老环境没有 matchMedia，跟随系统就退化成静态取值 */ }
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
  inspiration: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4"></path><path d="M12 3a6 6 0 0 1 3.6 10.8L15 18H9l-.6-4.2A6 6 0 0 1 12 3z"></path></svg>`,
  abilities: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect></svg>`,
  workspaces: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>`,
  realtime: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>`,
  logs: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="2"></rect><path d="M6.5 9l3 2.5-3 2.5M12 15h5"></path></svg>`,
  settings: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"></path><circle cx="16" cy="7" r="2.4"></circle><circle cx="8" cy="17" r="2.4"></circle></svg>`,
  notify: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.7 21a2 2 0 0 1-3.4 0"></path></svg>`,
  money: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"></path><path d="M4 10h16M9 15h2M15 15h.01"></path></svg>`,
  tools: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 3.5a4 4 0 0 0 5 5L9 19a3 3 0 1 1-4-4z"></path></svg>`,
  // 常用语 phrase（umbra-icons 1.2.0 正式版，批次 013）：竖条贴左 5、三条横线 9 / 6 / 8 不等长。
  phrases: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5v14"></path><path d="M10 7h9M10 12h6M10 17h8"></path></svg>`,
  // 以下三项的 path 照抄稿里 MODULES 对应条目的 d。
  flow: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h6v5H4zM14 14h6v5h-6zM10 7.5h4a2 2 0 0 1 2 2v4"></path></svg>`,
  vault: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11h16v9H4zM8 11V7.5a4 4 0 0 1 8 0V11M12 15v2"></path></svg>`,
  runtime: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v10H4zM9 19h6M12 15v4M8 8l2 2-2 2M13 12h3"></path></svg>`,
};

// 组间分隔线。稿的取值：1px、rgba(255,255,255,.07)、上下留白 7 / 5、左右缩进 6。
function navSep(): string {
  return `<span style="height:1px;background:rgba(255,255,255,.07);margin:7px 6px 5px;"></span>`;
}

// 稿 7719-7721 的取值：未选中主组 .62、底部组 .5、选中是橙底白字 **560**（不是 600）。
function navItem(key: Nav, label: string, svg: string, foot = false): string {
  const active = state.nav === key;
  const idle = foot ? "rgba(255,255,255,.5)" : "rgba(255,255,255,.62)";
  const style = `display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;font-size:13px;cursor:pointer;border:none;width:100%;text-align:left;font-family:inherit;white-space:nowrap;transition:background .13s ease;background:${active ? "var(--orange)" : "transparent"};color:${active ? "#fff" : idle};font-weight:${active ? 560 : 500};`;
  // 图标套一层 17px 定宽的 flex 壳：各图标的实际墨迹宽度不一样，不套壳文字起点会参差。
  return `<button data-act="nav-${key}" style="${style}"><span style="display:flex;width:17px;justify-content:center;flex:none;">${svg}</span><span>${label}</span></button>`;
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
    <span style="font-weight:600;font-size:13px;">Umbra</span>
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
      <span style="width:7px;height:7px;border-radius:999px;background:${color};box-shadow:0 0 0 3px ${soft};"></span>
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
  const set = hasToken();
  return set ? t("settings.tokenSaved") : t("settings.tokenHint");
}

// 设置页里的内联连接状态。

function sidebar(): string {
  return `
  <nav style="width:176px;flex:none;background:var(--nav);display:flex;flex-direction:column;padding:14px 10px;gap:2px;">
    <div style="display:flex;align-items:center;gap:9px;padding:4px 6px 14px;">
      <span style="width:25px;height:25px;border-radius:7px;background:var(--orange);color:#fff;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;flex:none;">U</span>
      <span style="color:#fff;font-weight:600;font-size:14px;">Umbra</span>
    </div>
    ${navItem("chat", t("nav.chat"), SVG.chat)}
    ${navSep()}
    ${navItem("tasks", t("nav.tasks"), SVG.tasks)}
    ${navItem("notify", t("nav.notify"), SVG.notify)}
    ${navItem("money", t("nav.money"), SVG.money)}
    ${navItem("workspaces", t("nav.workspaces"), SVG.workspaces)}
    ${navItem("inspiration", t("nav.inspiration"), SVG.inspiration)}
    ${navSep()}
    ${navItem("abilities", t("nav.abilities"), SVG.abilities)}
    ${navItem("flow", t("nav.flow"), SVG.flow)}
    ${navItem("realtime", t("nav.realtime"), SVG.realtime)}
    ${navItem("vault", t("nav.vault"), SVG.vault)}
    ${navItem("runtime", t("nav.runtime"), SVG.runtime)}
    ${navItem("tools", t("nav.tools"), SVG.tools)}
    ${navItem("phrases", t("nav.phrases"), SVG.phrases)}
    <div style="flex:1;min-height:10px;"></div>
    <div style="border-top:1px solid rgba(255,255,255,.07);padding-top:9px;display:flex;flex-direction:column;gap:2px;">
      ${navItem("logs", t("nav.logs"), SVG.logs, true)}
      ${navItem("settings", t("nav.settings"), SVG.settings, true)}
    </div>
    <div style="border-top:1px solid rgba(255,255,255,.08);padding:12px 6px 2px;margin-top:10px;">
      <div style="color:rgba(255,255,255,.88);font-size:12px;font-weight:500;white-space:nowrap;">MacBook-Pro-2.local</div>
      <div style="color:rgba(255,255,255,.4);font-size:11px;margin-top:2px;white-space:nowrap;">macOS · ${t("sidebar.thisDevice")}</div>
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
  // 键盘布局异步读一次（Mac 上 Option 会改 e.key，主键一律从 e.code 取；
  // 非 QWERTY 布局再靠布局表翻成键帽上印的字）。详见 components/hotkey.ts。
  let layout: LayoutMap = null;
  void readLayout().then((m) => { layout = m; });
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      finish();
      return;
    }
    const acc = toAccelerator(e, layout);
    if (!acc || acc.split("+").length < 2) return; // 必须含修饰键 + 有效主键
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
  // 破坏性操作走统一的确认弹窗（决策 D24/D25）。这里是 legacy 层，拿不到组件，
  // 所以走全局宿主暴露的 askConfirm —— 它返回 Promise，vanilla 里 then 一下就行。
  void askConfirm({
    message: t("settings.clipClearConfirm"),
    confirmText: t("settings.clipClearBtn"),
    danger: true,
  }).then((ok) => {
    if (!ok) return;
    clipBridge!.clear().catch(() => {});
    showToast(t("settings.clipClearedToast"), { tone: "ok" });
  });
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
  if (device) setDeviceName(device);
  // 令牌只往主进程写，渲染层不留副本 —— 它在渲染层没有任何用处（这里的 HTTP 请求都不带 token），
  // 留一份明文在 localStorage 里纯粹是白送一个泄露面。空串代表「没改」，主进程会忽略掉。
  desktop.pushConfig({
    serverUrl: server || getServerUrl(),
    token: token || "",
    deviceName: device || getDeviceName(),
  }).catch(() => {});
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
// 灵感页「让 Umbra 去做这件事」：跳到聊天页，**预填**「创建任务」芯片 + 灵感正文
// （批次 005：三态「模式」撤了，意图改由「/」动作芯片表达；预填不直发 ——
// 用户看一眼、补两句再回车，比背着他直接发出去多一步确认）。
// setTimeout(0) 是等聊天页挂载完，否则 composer 还没有容器可渲染。
export function prefillTaskToChat(text: string, sourceTitle: string): void {
  if (!text.trim()) return;
  setNav("chat");
  setTimeout(() => chat.prefillTaskFromIdea(text, sourceTitle), 0);
}
// 灵感详情「关联任务 → 查看」：跳到任务页并直接展开那条任务。
export function openTaskFrom(taskId: string): void {
  setNav("tasks");
  openTask(taskId);
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

// ── 任务页数据（/tasks）─────────────────────────────────────────────────────
let tasksTimer: number | undefined;

// 拉取任务列表；若详情抽屉打开则一并刷新详情。
async function loadTasks(): Promise<void> {
  if (state.tasks.list.length === 0) state.tasks.loading = true;
  const [list, detail] = await Promise.all([
    fetchTasks(30),
    state.tasks.detailId ? fetchTaskDetail(state.tasks.detailId) : Promise.resolve(null),
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
  await Promise.all([loadTasks(), new Promise((r) => setTimeout(r, 500))]);
  state.tasks.refreshing = false;
  render();
}

function startTasksPolling(): void {
  loadTasks();
  if (tasksTimer) clearInterval(tasksTimer);
  tasksTimer = window.setInterval(loadTasks, 3500);
}
function stopTasksPolling(): void {
  if (tasksTimer) clearInterval(tasksTimer);
  tasksTimer = undefined;
}

// ── 灵感页数据（/inspirations）───────────────────────────────────────────────
let inspTimer: number | undefined;

// 按状态数一遍列表，凑出和 /inspirations/counts 一样形状的结果（兜底用）。
function tallyInspStatus(list: Inspiration[]): InspirationCounts {
  const c: InspirationCounts = { all: list.length, open: 0, done: 0, archived: 0 };
  for (const i of list) {
    if (i.status === "open" || i.status === "done" || i.status === "archived") c[i.status] += 1;
  }
  return c;
}

async function loadInspirations(): Promise<void> {
  if (state.insp.list.length === 0) state.insp.loading = true;
  const [list, counts] = await Promise.all([
    fetchInspirations(state.insp.filter || undefined),
    fetchInspirationCounts(),
  ]);
  state.insp.list = list;
  // 计数接口不可用（服务端还没升到带 /inspirations/counts 的版本）时退回本地统计：
  // 没筛状态就直接数这次的列表，筛了状态才额外拉一次全量来数。
  state.insp.counts = counts || tallyInspStatus(state.insp.filter ? await fetchInspirations() : list);
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

async function openTask(id: string): Promise<void> {
  state.tasks.detailId = id;
  state.tasks.detail = null;
  render();
  const d = await fetchTaskDetail(id);
  if (state.tasks.detailId === id) {
    state.tasks.detail = d;
    render();
  }
}
function closeTask(): void {
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

// 供 React 侧主动切页用（设置页的快捷键总览要跳到「工具」那一级导航）。
// 走同一个 setNav，所以任务/灵感轮询的启停、以及同步给 React 的那一步都不会漏。
export function goNav(nav: Nav): void {
  setNav(nav);
}

// 只处理仍由 legacy HTML 承载的 chrome：侧边栏 nav 与标题栏 theme（其余页面已 React 化，各自处理事件）。
function onClick(e: MouseEvent): void {
  const target = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
  if (!target) return;
  const act = target.dataset.act!;
  if (act === "noop") { e.preventDefault(); return; }
  if (act.startsWith("nav-")) { setNav(act.slice(4) as Nav); return; }
  if (act === "theme") { toggleTheme(); }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && state.tasks.detailId) closeTask();
}

// 由 React 根（main.tsx）在挂载后调用：接管点击委托、键盘、设备事件订阅。
export function initLegacy(): void {
  chat.setAppRerender(render);
  // 聊天里的任务卡「查看结果」→ 跳任务页展开那条。回填而不是让 chat 直接 import 本文件，
  // 因为本文件已经 import 了 chat（sendText / setAppRerender），反向再引就是循环依赖。
  chat.setOpenTask(openTaskFrom);
  chat.setGoNav((n) => goNav(n as Nav)); // 斜杠面板空态「去能力」跳能力页（同款注入，防循环依赖）
  document.addEventListener("click", onClick); // 委托：处理各页面/弹窗内的 data-act（含侧边栏 nav / 标题栏 theme）
  window.addEventListener("keydown", onKeydown);
  // 快捷入口「发给秘书」：跳到聊天页并把这条消息发给秘书。
  // 批次 013 起主进程发的是 { text, atts? }（atts = 面板已传好的图片 file_id）：带图走
  // sendTextWithAtts（一条 kind=text + atts 的消息，秘书先看图再入库），没图照旧 sendText。
  // 老的裸字符串形状也兼容 —— 归一成对象再分流。
  type LauncherChatMsg = string | { text: string; atts?: string[] };
  const umbra = (window as unknown as { umbra?: { onLauncherSendChat?: (cb: (m: LauncherChatMsg) => void) => () => void } }).umbra;
  umbra?.onLauncherSendChat?.((msg) => {
    const m = typeof msg === "string" ? { text: msg } : (msg || { text: "" });
    const text = String(m.text ?? "");
    const atts = Array.isArray(m.atts) ? m.atts.filter((a): a is string => typeof a === "string" && !!a) : [];
    if (!text.trim() && !atts.length) return;
    setNav("chat");
    // 等聊天页挂载后再发，确保渲染。
    setTimeout(() => { if (atts.length) chat.sendTextWithAtts(text, atts); else chat.sendText(text); }, 0);
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
export { openTask, closeTask, manualRefresh, fmtTime, fmtListTime };
// 供 React 灵感页复用。
export { manualRefreshInsp };
