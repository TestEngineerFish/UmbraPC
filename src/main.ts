// Umbra 桌面客户端 · 渲染层（vanilla TS）
// 依据 Claude Design 设计稿还原。当前为界面 + mock 交互；
// 后续接入核心引擎（连服务端、Provider、computer-use）时，把 mock 数据换成真实数据源即可。

import { chatConn, getServerUrl, setServerUrl, setToken, getToken, getDeviceName, setDeviceName } from "./server";
import { fetchJobs, fetchJobDetail, type Job, type JobDetail, type Subtask } from "./server";
import * as chat from "./chat";
import * as desktop from "./desktop";

export type Nav = "chat" | "tasks" | "abilities" | "realtime" | "logs" | "settings";

const state = {
  nav: "chat" as Nav,
  dark: false,
  rtRunning: true,
  cu: false,
  codingMode: 1,
  logFilter: "all" as "all" | "jobs" | "conn" | "cap",
  tasks: {
    list: [] as Job[],
    loading: false,
    refreshing: false,
    detailId: null as string | null,
    detail: null as JobDetail | null,
  },
  // 自定义程序 新增/编辑 表单弹窗
  provModal: {
    open: false,
    original: null as string | null, // 正在编辑的程序名（null=新增）
    light: false, // 轻量覆盖模式（内置程序如 Claude Code/Codex：只改显示名/检测命令，不编辑技能命令）
    provider: "",
    display_name: "",
    detect: "",
    skills: [{ skill: "", description: "", command: "", confirm: false }] as Array<{ skill: string; description: string; command: string; confirm: boolean }>,
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

const LOGS = [
  { time: "14:01:55", tag: "conn", src: "conn", color: "var(--success)", msg: "已连接 umbra.tingyusha.xyz · 设备已登记" },
  { time: "14:02:03", tag: "job", src: "jobs", color: "var(--orange-text)", msg: 'create_job(goal="导出周报 PDF")' },
  { time: "14:02:18", tag: "cap", src: "cap", color: "#7c5cff", msg: "system.export_pdf → ~/Downloads/weekly.pdf" },
  { time: "14:02:19", tag: "job", src: "jobs", color: "var(--orange-text)", msg: "job#3142 已完成 · 248KB" },
  { time: "14:08:40", tag: "job", src: "jobs", color: "var(--orange-text)", msg: 'create_job(goal="写一个待办小程序")' },
  { time: "14:08:41", tag: "cap", src: "cap", color: "#7c5cff", msg: 'claude_code.write_code(file="index.html")' },
  { time: "14:09:02", tag: "warn", src: "cap", color: "var(--warning)", msg: "等待用户确认进入执行模式" },
  { time: "14:09:30", tag: "info", src: "conn", color: "var(--muted)", msg: "心跳 ok · 延迟 38ms" },
  { time: "13:40:11", tag: "error", src: "jobs", color: "var(--danger)", msg: "ffmpeg.compress 退出码 1 · 磁盘空间不足" },
];

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const SVG = {
  chat: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-11.9 7.6L4 20l1-4.6A8.4 8.4 0 1 1 21 11.5z"></path></svg>`,
  tasks: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"></path><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"></path></svg>`,
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

const chip = (active: boolean) =>
  `padding:4px 11px;border-radius:999px;font-size:12px;cursor:pointer;font-family:inherit;border:1px solid ${active ? "var(--orange)" : "var(--border)"};background:${active ? "var(--orange-soft)" : "transparent"};color:${active ? "var(--orange-text)" : "var(--muted)"};font-weight:${active ? 600 : 400};`;
const seg = (active: boolean, last = false) =>
  `padding:6px 13px;font-size:12.5px;cursor:pointer;border:none;border-right:${last ? "none" : "1px solid var(--border)"};font-family:inherit;background:${active ? "var(--orange)" : "transparent"};color:${active ? "#fff" : "var(--text)"};font-weight:${active ? 600 : 400};`;

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
    <button data-act="theme" title="切换深浅色" style="-webkit-app-region:no-drag;display:flex;align-items:center;justify-content:center;width:28px;height:24px;border:1px solid var(--border);background:var(--card);border-radius:7px;color:var(--muted);cursor:pointer;">${themeIcon}</button>
    ${connBadge()}
  </div>`;
}

function connBadge(): string {
  const s = chatConn.status;
  const color = s === "online" ? "var(--success)" : s === "connecting" ? "var(--warning)" : "var(--danger)";
  const soft = s === "online" ? "var(--success-soft)" : s === "connecting" ? "var(--warning-soft)" : "var(--danger-soft)";
  const label = s === "online" ? `已连接 · ${chat.serverLabel()}` : s === "connecting" ? "连接中…" : "未连接";
  return `<div style="display:flex;align-items:center;gap:7px;padding:3px 10px;border:1px solid var(--border);border-radius:999px;background:var(--card);">
      <span style="width:8px;height:8px;border-radius:999px;background:${color};box-shadow:0 0 0 3px ${soft};"></span>
      <span style="font-size:11.5px;color:var(--muted);">${label}</span>
    </div>`;
}

// 设备 ID 展示：桌面态取真实 deviceId，否则占位。
function deviceIdLabel(): string {
  const ds = desktop.getDeviceState();
  return ds?.deviceId || "（仅桌面应用可用）";
}

// 设备引擎状态卡（仅桌面应用显示）：连接状态 + Provider 数 + 最近任务。
function deviceEngineCard(): string {
  if (!desktop.isDesktop()) return "";
  const ds = desktop.getDeviceState();
  const status = ds?.status || "offline";
  const color = status === "online" ? "var(--success)" : status === "connecting" ? "var(--warning)" : "var(--danger)";
  const soft = status === "online" ? "var(--success-soft)" : status === "connecting" ? "var(--warning-soft)" : "var(--danger-soft)";
  const label = status === "online" ? "运行中" : status === "connecting" ? "连接中…" : "未连接";
  const provCount = ds ? ds.providers.filter((p) => p.available).length : 0;
  const last = ds && ds.recentTasks[0];
  const lastLine = last ? `最近任务：${esc(last.provider)}.${esc(last.skill)} · ${esc(last.message)}` : "暂无任务";
  const lastLog = desktop.getDeviceLogs()[0] || "（无日志）";
  return `<div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;"><div style="font-weight:600;margin-bottom:14px;">设备引擎</div><div style="display:flex;flex-direction:column;gap:11px;">
      <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">引擎状态</label><span style="display:inline-flex;align-items:center;gap:7px;font-size:13px;"><span style="width:8px;height:8px;border-radius:999px;background:${color};box-shadow:0 0 0 3px ${soft};"></span>${label}</span><span style="flex:1;"></span><span style="font-size:12px;color:var(--muted);">查看「日志」页排错</span></div>
      <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">可用程序</label><span style="font-size:13px;">${provCount} 个</span></div>
      <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">任务</label><span style="font-size:12.5px;color:var(--muted);">${lastLine}</span></div>
      <div style="display:flex;align-items:flex-start;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">最近日志</label><span style="font-size:12px;color:var(--muted);font-family:ui-monospace,Menlo,monospace;flex:1;word-break:break-all;">${esc(lastLog)}</span></div>
    </div></div>`;
}

// Token 输入占位：设备注册需要与服务端 ASSIST_TOKEN 一致。
function tokenPlaceholder(): string {
  const set = desktop.isDesktop() ? !!desktop.getDesktopConfig()?.hasToken : !!getToken();
  return set ? "（已保存，留空不变）" : "填服务端 ASSIST_TOKEN（设备注册需要）";
}

// 设置页里的内联连接状态。
function connStatusInline(): string {
  const s = chatConn.status;
  const color = s === "online" ? "var(--success)" : s === "connecting" ? "var(--warning)" : "var(--danger)";
  const soft = s === "online" ? "var(--success-soft)" : s === "connecting" ? "var(--warning-soft)" : "var(--danger-soft)";
  const label = s === "online" ? "已连接" : s === "connecting" ? "连接中…" : "未连接";
  return `<span style="display:inline-flex;align-items:center;gap:7px;font-size:13px;"><span style="width:8px;height:8px;border-radius:999px;background:${color};box-shadow:0 0 0 3px ${soft};"></span>${label}</span>`;
}

function sidebar(): string {
  return `
  <nav style="width:180px;flex:none;background:var(--nav);display:flex;flex-direction:column;padding:14px 10px;gap:3px;">
    <div style="display:flex;align-items:center;gap:9px;padding:4px 6px 14px;">
      <span style="width:26px;height:26px;border-radius:7px;background:var(--orange);color:#fff;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center;">U</span>
      <span style="color:#fff;font-weight:600;font-size:14.5px;">Umbra</span>
    </div>
    ${navItem("chat", "聊天", SVG.chat)}
    ${navItem("tasks", "任务", SVG.tasks)}
    ${navItem("abilities", "能力", SVG.abilities)}
    ${navItem("realtime", "实时操作", SVG.realtime)}
    ${navItem("logs", "日志", SVG.logs)}
    ${navItem("settings", "设置", SVG.settings)}
    <div style="flex:1;"></div>
    <div style="border-top:1px solid rgba(255,255,255,.08);padding:12px 6px 2px;">
      <div style="color:rgba(255,255,255,.9);font-size:12px;font-weight:500;">MacBook-Pro-2.local</div>
      <div style="color:rgba(255,255,255,.42);font-size:11px;margin-top:2px;">macOS · 此设备</div>
    </div>
  </nav>`;
}

function chatScreen(): string {
  // 聊天屏由 chat 模块接管（实时连接 /ws/chat）；这里只放挂载容器。
  return `<div id="chatroot" style="height:100%;min-height:0;"></div>`;
}

function badge(text: string, kind: "ok" | "run" | "wait" | "fail" | "off"): string {
  const map: Record<string, string> = {
    ok: "background:var(--success-soft);color:var(--success);",
    run: "background:var(--orange-soft);color:var(--orange-text);",
    wait: "background:var(--chip);color:var(--muted);",
    fail: "background:var(--danger-soft);color:var(--danger);",
    off: "background:var(--chip);color:var(--muted);",
  };
  return `<span style="display:inline-flex;align-items:center;gap:5px;padding:2px 10px;border-radius:999px;font-size:11.5px;font-weight:600;${map[kind]}">${text}</span>`;
}

const isImageUrl = (u: string) => /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(u) || /(chatglm|bigmodel|cogview|aigc)/i.test(u) || /\/files\//.test(u);

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
  if (days === 1) return "昨天";
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function jobStatusBadge(status: string): string {
  const map: Record<string, [string, "ok" | "run" | "wait" | "fail" | "off"]> = {
    done: ["已完成", "ok"],
    running: ["执行中", "run"],
    pending: ["待执行", "wait"],
    failed: ["失败", "fail"],
    cancelled: ["已取消", "off"],
  };
  const [label, kind] = map[status] || [status, "wait"];
  return badge(label, kind);
}

function tasksScreen(): string {
  const t = state.tasks;
  const rows = t.list.length
    ? t.list
        .map((j) => {
          const failed = j.status === "failed";
          const sub = j.result_summary ? esc(j.result_summary.slice(0, 70)) : j.channel ? `来自 ${esc(j.channel)}` : "";
          const running = j.status === "running" || j.status === "pending";
          return `<div data-act="task-open" data-id="${esc(j.id)}" style="background:var(--card);border:1px solid ${j.id === t.detailId ? "var(--orange)" : "var(--border)"};border-radius:12px;padding:13px 16px;cursor:pointer;">
        <div style="display:flex;align-items:center;gap:14px;"><div style="flex:1;min-width:0;"><div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(j.goal)}</div><div style="font-size:11.5px;color:${failed ? "var(--danger)" : "var(--muted)"};margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${sub || "&nbsp;"}</div></div>${jobStatusBadge(j.status)}<span title="${esc(j.updated_at || "")}" style="font-size:12px;color:var(--muted);white-space:nowrap;flex:none;">${fmtListTime(j.updated_at)}</span></div>
        ${running ? `<div style="height:3px;border-radius:999px;background:var(--track);overflow:hidden;margin-top:9px;"><div style="height:100%;width:38%;background:var(--orange);border-radius:999px;animation:umbslide 1.4s ease-in-out infinite;"></div></div>` : ""}
      </div>`;
        })
        .join("")
    : `<div style="color:var(--muted);padding:40px;text-align:center;">${t.loading ? "加载任务中…" : "暂无任务"}</div>`;

  return `
  <div style="height:100%;overflow-y:auto;padding:18px 22px;position:relative;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin:0 0 16px;"><h1 style="margin:0;font-size:16px;font-weight:600;">任务</h1><button data-act="tasks-refresh" style="display:flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:8px;font-size:12.5px;cursor:pointer;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="${t.refreshing ? "animation:umbspin .8s linear infinite;" : ""}"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"></path></svg>${t.refreshing ? "刷新中" : "刷新"}</button></div>
    <div style="display:flex;flex-direction:column;gap:10px;">${rows}</div>
  </div>
  ${taskDrawer()}`;
}

// 解析子任务结果，渲染图片/文件链接/本机路径/变更清单。
function taskResults(subs: Subtask[]): string {
  const items: string[] = [];
  for (const s of subs) {
    if (!s.result_json) continue;
    let r: any;
    try {
      r = JSON.parse(s.result_json);
    } catch {
      continue;
    }
    if (!r || typeof r !== "object") continue;
    if (typeof r.url === "string") {
      if (isImageUrl(r.url)) items.push(`<a href="${esc(r.url)}" target="_blank" rel="noopener"><img src="${esc(r.url)}" style="display:block;max-width:100%;border-radius:8px;border:1px solid var(--border);margin-bottom:6px;" onerror="this.remove()"></a>`);
      items.push(`<div style="display:flex;align-items:center;gap:8px;font-size:13px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path></svg><a href="${esc(r.url)}" target="_blank" rel="noopener" style="color:var(--orange-text);text-decoration:none;font-weight:500;">${esc(r.filename || "下载结果")}</a></div>`);
    }
    if (typeof r.project_dir === "string") items.push(`<div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);margin-top:3px;">${esc(r.project_dir)}</div>`);
    if (typeof r.path === "string") items.push(`<div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);margin-top:3px;">${esc(r.path)}</div>`);
    if (Array.isArray(r.changed_files) && r.changed_files.length) items.push(`<div style="font-size:11.5px;color:var(--muted);margin-top:4px;">变更 ${r.changed_files.length} 个文件：${r.changed_files.slice(0, 8).map((x: string) => esc(x)).join("、")}${r.changed_files.length > 8 ? " …" : ""}</div>`);
  }
  if (!items.length) return "";
  return `<div><div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:10px;">生成结果</div><div style="display:flex;flex-direction:column;gap:4px;">${items.join("")}</div></div>`;
}

function stepIcon(st: string): string {
  if (st === "done") return `<span style="width:18px;height:18px;border-radius:999px;background:var(--success);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;flex:none;">✓</span>`;
  if (st === "failed") return `<span style="width:18px;height:18px;border-radius:999px;background:var(--danger);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;flex:none;">✕</span>`;
  if (st === "running" || st === "dispatched") return `<span style="width:18px;height:18px;border-radius:999px;border:2px solid var(--orange);flex:none;"></span>`;
  return `<span style="width:18px;height:18px;border-radius:999px;border:2px solid var(--border);flex:none;"></span>`;
}

function taskDrawer(): string {
  const t = state.tasks;
  if (!t.detailId) return "";
  const overlay = `<div data-act="task-close" style="position:absolute;inset:0;background:rgba(0,0,0,.32);z-index:30;"></div>`;
  const d = t.detail;
  if (!d || d.job.id !== t.detailId) {
    return `${overlay}<div style="position:absolute;top:0;right:0;bottom:0;width:420px;background:var(--card);border-left:1px solid var(--border);z-index:31;display:flex;align-items:center;justify-content:center;color:var(--muted);">加载详情…</div>`;
  }
  const subs = [...d.subtasks].sort((a, b) => a.seq - b.seq);
  const doneN = subs.filter((s) => s.status === "done").length;
  const pct = subs.length ? Math.round((doneN / subs.length) * 100) : d.job.status === "done" ? 100 : 0;
  const barColor = d.job.status === "failed" ? "var(--danger)" : d.job.status === "done" ? "var(--success)" : "var(--orange)";
  const statusText = jobStatusBadge(d.job.status);
  const steps = subs.length
    ? subs.map((s) => `<div style="display:flex;align-items:center;gap:9px;font-size:13px;color:${s.status === "pending" ? "var(--muted)" : "var(--text)"};">${stepIcon(s.status)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.title || `${s.provider || ""}.${s.skill || ""}`)}</span></div>`).join("")
    : `<div style="font-size:12.5px;color:var(--muted);">（无步骤）</div>`;
  const timeline = d.events.length
    ? d.events.map((e) => `<div style="position:relative;padding:0 0 13px 16px;"><span style="position:absolute;left:-6px;top:3px;width:9px;height:9px;border-radius:999px;background:var(--orange);"></span><span style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);">${fmtTime(e.created_at, true)}</span><div style="font-size:12.5px;">${esc(e.message || e.type)}</div></div>`).join("")
    : `<div style="font-size:12.5px;color:var(--muted);">（无事件）</div>`;
  const results = taskResults(subs);
  return `${overlay}
    <div style="position:absolute;top:0;right:0;bottom:0;width:420px;background:var(--card);border-left:1px solid var(--border);z-index:31;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:15px 20px;border-bottom:1px solid var(--border);"><div style="min-width:0;"><div style="font-weight:600;font-size:15px;">${esc(d.job.goal)}</div><div style="margin-top:5px;">${statusText}</div></div><button data-act="task-close" style="border:none;background:transparent;color:var(--muted);cursor:pointer;font-size:20px;line-height:1;flex:none;">×</button></div>
      <div style="flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:20px;">
        <div><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;"><span style="font-size:12px;color:var(--muted);">总进度</span><span style="font-size:12px;color:var(--orange-text);font-weight:600;">${pct}%</span></div><div style="height:6px;border-radius:999px;background:var(--track);overflow:hidden;"><div style="height:100%;width:${pct}%;background:${barColor};"></div></div></div>
        <div><div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:10px;">步骤</div><div style="display:flex;flex-direction:column;gap:9px;">${steps}</div></div>
        <div><div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:10px;">事件时间线</div><div style="display:flex;flex-direction:column;border-left:2px solid var(--border);margin-left:4px;">${timeline}</div></div>
        ${results}
      </div>
    </div>`;
}

function provCard(opts: { icon: string; name: string; sub: string; badge: string; skills: string[]; dim?: boolean; warn?: boolean; full?: boolean }): string {
  const iconBg = opts.dim ? "background:var(--chip);color:var(--muted);" : opts.warn ? "background:var(--warning-soft);color:var(--warning);" : "background:var(--orange-soft);color:var(--orange-text);";
  const skills = opts.skills.map((s) => `<span style="padding:3px 9px;border-radius:999px;background:var(--chip);font-size:11.5px;color:var(--muted);font-family:ui-monospace,Menlo,monospace;">${s}</span>`).join("");
  return `<div style="background:var(--card);border:1px solid ${opts.warn ? "var(--warning)" : "var(--border)"};border-radius:12px;padding:15px;${opts.dim ? "opacity:.62;" : ""}${opts.full ? "grid-column:1 / -1;" : ""}">
    <div style="display:flex;align-items:center;gap:11px;margin-bottom:12px;">
      <span style="width:34px;height:34px;border-radius:9px;${iconBg}display:flex;align-items:center;justify-content:center;">${opts.icon}</span>
      <div style="flex:1;"><div style="font-weight:600;">${opts.name}</div><div style="font-size:11.5px;color:${opts.warn ? "var(--warning)" : "var(--muted)"};">${opts.sub}</div></div>
      ${opts.warn ? `<button data-act="nav-settings" style="padding:4px 11px;border:1px solid var(--warning);color:var(--warning);background:transparent;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;">去授权</button>` : ""}
      ${opts.badge}
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;">${skills}</div>
  </div>`;
}

const PROV_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"></rect><path d="M3 9h18"></path></svg>`;

// 单张能力卡：状态(检测/停用) + 启用开关；自定义程序additionally可编辑/删除。
function abilityCard(m: desktop.ProviderManifest): string {
  const enabled = !desktop.isProviderDisabled(m.provider);
  const cfgEntry = desktop.getCustomProviders().find((p) => p.provider === m.provider);
  // 真·自定义程序（可删除、标注“自定义”）：providers.json 里含带命令的技能。仅“轻量覆盖”内置程序的条目不算。
  const isCustom = !!cfgEntry && Object.values(cfgEntry.skills || {}).some((s) => (s.command?.length ?? 0) > 0);
  const canEdit = m.kind === "program"; // Claude Code / Codex / 自定义程序可编辑；系统内置不可编辑
  const status = !enabled ? "已停用" : m.available ? (m.version ? `v${m.version}` : m.kind === "system" ? "系统内置" : "已就绪") : m.unavailable_reason || "不可用";
  const track = `width:36px;height:21px;border-radius:999px;border:none;cursor:pointer;padding:2px;display:flex;justify-content:${enabled ? "flex-end" : "flex-start"};background:${enabled ? "var(--orange)" : "var(--border)"};flex:none;transition:background .15s;`;
  const skills = Object.keys(m.skills || {})
    .map((s) => `<span style="padding:3px 9px;border-radius:999px;background:var(--chip);font-size:11.5px;color:var(--muted);font-family:ui-monospace,Menlo,monospace;">${esc(s)}</span>`)
    .join("");
  const editBtn = `<button data-act="prov-edit" data-prov="${esc(m.provider)}" style="padding:3px 10px;border:1px solid var(--border);background:transparent;color:var(--text);border-radius:6px;font-size:11.5px;cursor:pointer;">编辑</button>`;
  const delBtn = `<button data-act="prov-del" data-prov="${esc(m.provider)}" style="padding:3px 10px;border:1px solid var(--danger);background:transparent;color:var(--danger);border-radius:6px;font-size:11.5px;cursor:pointer;">删除</button>`;
  const custBtns = canEdit ? `<span style="flex:1;"></span>${editBtn}${isCustom ? delBtn : ""}` : "";
  return `<div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:15px;${enabled && !m.available ? "opacity:.72;" : ""}">
    <div style="display:flex;align-items:center;gap:11px;margin-bottom:12px;">
      <span style="width:34px;height:34px;border-radius:9px;background:var(--orange-soft);color:var(--orange-text);display:flex;align-items:center;justify-content:center;flex:none;">${PROV_ICON}</span>
      <div style="flex:1;min-width:0;"><div style="font-weight:600;">${esc(m.display_name || m.provider)}${isCustom ? ' <span style="font-size:10.5px;color:var(--muted);font-weight:400;">自定义</span>' : ""}</div><div style="font-size:11.5px;color:var(--muted);">${esc(status)}</div></div>
      <button data-act="prov-toggle" data-prov="${esc(m.provider)}" title="${enabled ? "停用" : "启用"}" style="${track}"><span style="width:17px;height:17px;border-radius:999px;background:#fff;display:block;box-shadow:0 1px 2px rgba(0,0,0,.25);"></span></button>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">${skills}${custBtns}</div>
  </div>`;
}

// 桌面态：用设备引擎上报的真实 Provider 渲染能力页。
function abilitiesReal(): string {
  const ds = desktop.getDeviceState()!;
  const cards = ds.providers.length
    ? ds.providers.map(abilityCard).join("")
    : `<div style="grid-column:1 / -1;color:var(--muted);padding:30px;text-align:center;">设备引擎未就绪或暂无 Provider（状态：${ds.status}）。</div>`;
  return `
  <div style="height:100%;overflow-y:auto;padding:18px 22px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px;"><div style="display:flex;align-items:baseline;gap:10px;"><h1 style="margin:0;font-size:16px;font-weight:600;">能力</h1><span style="font-size:12px;color:var(--muted);">本机真实能力 · 设备 ${esc(ds.deviceName)}</span></div><button data-act="prov-add" style="display:flex;align-items:center;gap:6px;padding:6px 13px;border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:8px;font-size:13px;cursor:pointer;flex:none;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>新增程序</button></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:13px;">${cards}</div>
    <div style="margin-top:14px;font-size:11.5px;color:var(--muted);">内置程序装了就自动可用；开关可停用不想让 AI 用的程序。自定义程序（providers.json）可编辑/删除，或点「新增程序」添加，无需手写 JSON。</div>
  </div>
  ${provModalHtml()}`;
}

// 自定义程序 新增/编辑 表单弹窗。
function provModalHtml(): string {
  const pm = state.provModal;
  if (!pm.open) return "";
  const inp = "width:100%;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;padding:7px 10px;font-size:13px;outline:none;box-sizing:border-box;";
  const skillsHtml = pm.skills
    .map(
      (s, i) => `<div style="border:1px solid var(--border);border-radius:10px;padding:11px;margin-bottom:9px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;"><span style="font-size:12px;color:var(--muted);font-weight:600;">技能 ${i + 1}</span>${pm.skills.length > 1 ? `<button data-act="pm-del-skill" data-idx="${i}" style="border:none;background:transparent;color:var(--danger);cursor:pointer;font-size:12px;">删除</button>` : ""}</div>
        <input id="pm-skill-${i}" placeholder="技能名，如 to_gif" value="${esc(s.skill)}" style="${inp}margin-bottom:6px;">
        <input id="pm-desc-${i}" placeholder="说明（给 AI 看的）" value="${esc(s.description)}" style="${inp}margin-bottom:6px;">
        <input id="pm-cmd-${i}" placeholder="命令模板(空格分隔)，如 ffmpeg -y -i {input} {output}" value="${esc(s.command)}" style="${inp}font-family:ui-monospace,Menlo,monospace;margin-bottom:6px;">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);"><input id="pm-confirm-${i}" type="checkbox" ${s.confirm ? "checked" : ""}>执行前需确认</label>
      </div>`,
    )
    .join("");
  return `<div data-act="pm-cancel" style="position:absolute;inset:0;background:rgba(0,0,0,.32);z-index:30;"></div>
    <div style="position:absolute;top:0;right:0;bottom:0;width:460px;background:var(--card);border-left:1px solid var(--border);z-index:31;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:15px 20px;border-bottom:1px solid var(--border);"><div style="font-weight:600;font-size:15px;">${pm.original ? "编辑程序" : "新增程序"}</div><button data-act="pm-cancel" style="border:none;background:transparent;color:var(--muted);cursor:pointer;font-size:20px;line-height:1;">×</button></div>
      <div style="flex:1;overflow-y:auto;padding:18px 20px;">
        ${pm.light ? `<div style="font-size:12px;color:var(--muted);background:var(--chip);border-radius:8px;padding:9px 11px;margin-bottom:14px;line-height:1.5;">内置程序：仅可覆盖显示名与检测命令，执行仍走内置逻辑（引擎选择 / 隔离目录等），因此不提供技能命令编辑。</div>` : ""}
        <label style="font-size:12px;color:var(--muted);">程序标识（provider，英文小写）</label>
        <input id="pm-provider" placeholder="如 ffmpeg" value="${esc(pm.provider)}" ${pm.original ? "readonly" : ""} style="${inp}margin:5px 0 12px;${pm.original ? "opacity:.6;" : ""}">
        <label style="font-size:12px;color:var(--muted);">显示名</label>
        <input id="pm-display" placeholder="如 FFmpeg" value="${esc(pm.display_name)}" style="${inp}margin:5px 0 12px;">
        <label style="font-size:12px;color:var(--muted);">检测命令（可选，用 which 判断是否安装，留空视为始终可用）</label>
        <input id="pm-detect" placeholder="如 ffmpeg" value="${esc(pm.detect)}" style="${inp}margin:5px 0 14px;">
        ${pm.light ? "" : `<div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:8px;">技能（命令用 {参数名} 占位，AI 只能填参数、不能改命令本身）</div>
        ${skillsHtml}
        <button data-act="pm-add-skill" style="width:100%;padding:8px;border:1px dashed var(--border);background:transparent;color:var(--muted);border-radius:8px;font-size:12.5px;cursor:pointer;">+ 添加技能</button>`}
      </div>
      <div style="padding:14px 20px;border-top:1px solid var(--border);display:flex;gap:10px;justify-content:flex-end;">
        <button data-act="pm-cancel" style="padding:8px 16px;border:1px solid var(--border);background:transparent;color:var(--text);border-radius:8px;font-size:13px;cursor:pointer;">取消</button>
        <button data-act="pm-save" style="padding:8px 16px;background:var(--orange);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">保存</button>
      </div>
    </div>`;
}

// 把弹窗表单当前 DOM 值同步进 state（增删技能/保存前调用，避免重渲染丢输入）。
function captureProvModal(): void {
  const pm = state.provModal;
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value;
  const chk = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.checked;
  pm.provider = val("pm-provider") ?? pm.provider;
  pm.display_name = val("pm-display") ?? pm.display_name;
  pm.detect = val("pm-detect") ?? pm.detect;
  pm.skills = pm.skills.map((s, i) => ({
    skill: val(`pm-skill-${i}`) ?? s.skill,
    description: val(`pm-desc-${i}`) ?? s.description,
    command: val(`pm-cmd-${i}`) ?? s.command,
    confirm: chk(`pm-confirm-${i}`) ?? s.confirm,
  }));
}

function openProvAdd(): void {
  state.provModal = { open: true, light: false, original: null, provider: "", display_name: "", detect: "", skills: [{ skill: "", description: "", command: "", confirm: false }] };
  render();
}
function openProvEdit(prov: string): void {
  const e = desktop.getCustomProviders().find((p) => p.provider === prov);
  const hasCmd = !!e && Object.values(e.skills || {}).some((s) => (s.command?.length ?? 0) > 0);
  if (e && hasCmd) {
    // 真·自定义程序：完整编辑（含技能命令）
    const skills = Object.entries(e.skills || {}).map(([k, v]) => ({ skill: k, description: v.description || "", command: (v.command || []).join(" "), confirm: !!v.confirm }));
    state.provModal = { open: true, light: false, original: prov, provider: e.provider, display_name: e.display_name || "", detect: e.detect || "", skills: skills.length ? skills : [{ skill: "", description: "", command: "", confirm: false }] };
  } else {
    // 内置程序（Claude Code / Codex）：轻量覆盖，只改显示名 / 检测命令，执行仍走内置逻辑。
    const m = desktop.getDeviceState()?.providers.find((p) => p.provider === prov);
    state.provModal = { open: true, light: true, original: prov, provider: prov, display_name: e?.display_name || m?.display_name || "", detect: e?.detect || "", skills: [] };
  }
  render();
}
function saveProvModal(): void {
  captureProvModal();
  const pm = state.provModal;
  const provider = pm.provider.trim();
  if (!provider) return;
  const list = [...desktop.getCustomProviders()];
  let entry: desktop.CustomProviderCfg;
  if (pm.light) {
    // 轻量覆盖：只写 display_name / detect（无技能命令 → 后端识别为覆盖内置 manifest，不替换执行器）。
    entry = { provider, display_name: pm.display_name.trim() || undefined, detect: pm.detect.trim() || undefined };
  } else {
    const skills: Record<string, { description: string; params: Record<string, string>; command: string[]; confirm: boolean }> = {};
    for (const s of pm.skills) {
      const name = s.skill.trim();
      const cmd = s.command.trim();
      if (name && cmd) skills[name] = { description: s.description.trim(), params: {}, command: cmd.split(/\s+/), confirm: !!s.confirm };
    }
    if (Object.keys(skills).length === 0) return; // 自定义程序需至少一个含命令的技能
    entry = { provider, display_name: pm.display_name.trim() || undefined, detect: pm.detect.trim() || undefined, skills };
  }
  const idx = list.findIndex((p) => p.provider === (pm.original || provider));
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  state.provModal.open = false;
  render();
  desktop.saveCustomProviders(list).then(render).catch(() => {});
}
function delProv(prov: string): void {
  const list = desktop.getCustomProviders().filter((p) => p.provider !== prov);
  desktop.saveCustomProviders(list).then(render).catch(() => {});
}

function abilitiesScreen(): string {
  if (desktop.isDesktop() && desktop.getDeviceState()) return abilitiesReal();
  const okBadge = badge(`<span style="width:6px;height:6px;border-radius:999px;background:var(--success);"></span>可用`, "ok");
  return `
  <div style="height:100%;overflow-y:auto;padding:18px 22px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;"><h1 style="margin:0;font-size:16px;font-weight:600;">能力</h1><button data-act="nav-settings" style="display:flex;align-items:center;gap:6px;padding:6px 13px;border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:8px;font-size:13px;cursor:pointer;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>添加程序</button></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:13px;">
      ${provCard({ icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13 5l-2 14"></path></svg>`, name: "Claude Code", sub: "v1.0.7", badge: okBadge, skills: ["write_code", "edit_file", "run_command", "capture"] })}
      ${provCard({ icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6-6-6M12 19h8"></path></svg>`, name: "Codex CLI", sub: "未安装 codex", badge: badge("未安装", "off"), skills: ["write_code", "refactor"], dim: true })}
      ${provCard({ icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"></rect><path d="M3 9h18"></path></svg>`, name: "系统", sub: "macOS 内置", badge: okBadge, skills: ["open_app", "find_file", "read_file", "notify"] })}
      ${provCard({ icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8z"></path><rect x="2" y="6" width="14" height="12" rx="2"></rect></svg>`, name: "FFmpeg", sub: "v6.1", badge: okBadge, skills: ["transcode", "compress", "extract_frame"] })}
      ${provCard({ icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>`, name: `电脑操作 <span style="font-size:11px;color:var(--muted);font-weight:400;">computer-use</span>`, sub: "需在设置授予『屏幕录制 / 辅助功能』权限", badge: badge(`<span style="width:6px;height:6px;border-radius:999px;background:var(--warning);"></span>待授权`, "wait"), skills: ["screenshot", "click", "type", "key"], warn: true, full: true })}
    </div>
  </div>`;
}

// 桌面态：computer-use 实时监看（v0 展示开关/权限状态 + 原子动作历史；operate 自主循环后续接入）。
function realtimeReal(): string {
  const enabled = computerEnabled();
  const perms = desktop.getPermissions();
  const ds = desktop.getDeviceState();
  const acts = (ds?.recentTasks || []).filter((t) => t.provider === "computer");
  const running = acts.some((t) => t.status === "running");
  const stopBtn = `<button data-act="cu-stop" style="display:flex;align-items:center;gap:7px;padding:7px 15px;border:1.5px solid var(--danger);color:var(--danger);background:var(--danger-soft);border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>紧急停止</button>`;
  const head = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;"><h1 style="margin:0;font-size:16px;font-weight:600;">实时操作</h1>${enabled ? stopBtn : ""}</div>`;

  if (!enabled) {
    return `<div style="height:100%;overflow-y:auto;padding:18px 22px;">${head}
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--muted);height:380px;"><span style="width:54px;height:54px;border-radius:14px;background:var(--card);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg></span><div style="font-size:14px;">computer-use 未开启</div><button data-act="nav-settings" style="padding:7px 15px;background:var(--orange);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">去设置开启</button></div></div>`;
  }

  const permOk = perms.accessibility && perms.screen === "granted";
  const permWarn = permOk
    ? ""
    : `<div style="background:var(--warning-soft);border:1px solid var(--warning);border-radius:10px;padding:12px 15px;margin-bottom:16px;display:flex;align-items:center;gap:10px;"><span style="width:7px;height:7px;border-radius:999px;background:var(--warning);"></span><span style="font-size:13px;color:var(--warning);flex:1;">权限不全：${perms.accessibility ? "" : "辅助功能 "}${perms.screen === "granted" ? "" : "屏幕录制 "}未授予，computer-use 无法执行</span><button data-act="nav-settings" style="padding:5px 12px;border:1px solid var(--warning);color:var(--warning);background:transparent;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;">去授权</button></div>`;

  const idleHint = running
    ? `<div style="font-size:12px;color:var(--orange-text);display:flex;align-items:center;gap:6px;"><span style="width:7px;height:7px;border-radius:999px;background:var(--orange);animation:umblink 1.4s infinite;"></span>正在执行电脑操作…</div>`
    : `<div style="font-size:13px;color:var(--muted);">当前没有进行中的电脑操作。v0 支持原子动作（点击/输入/按键/滚动/打开应用/截图）；operate 自主操作尚未接入决策引擎。</div>`;

  const skillLabel = (s: string): string =>
    ({ click: "点击", type: "输入", key: "按键", scroll: "滚动", open_app: "打开应用", screenshot: "截图", operate: "自主操作" } as Record<string, string>)[s] || s;
  const statusColor = (st: string): string => (st === "error" ? "var(--danger)" : st === "ok" ? "var(--success)" : "var(--orange)");
  const statusText = (st: string): string => (st === "error" ? "失败" : st === "ok" ? "完成" : "进行中");

  const history = acts.length
    ? acts
        .map(
          (t, i) => `<div style="padding:10px 14px;${i < acts.length - 1 ? "border-bottom:1px solid var(--border);" : ""}${t.status === "running" ? "background:var(--orange-soft);" : ""}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <span style="width:7px;height:7px;border-radius:999px;background:${statusColor(t.status)};flex:none;"></span>
          <span style="font-size:13px;font-weight:600;">${skillLabel(t.skill)}</span>
          <span style="font-size:10.5px;color:var(--muted);font-family:ui-monospace,Menlo,monospace;">${esc(t.skill)}</span>
          <span style="flex:1;"></span>
          <span style="font-size:11px;color:${statusColor(t.status)};flex:none;">${statusText(t.status)}</span>
          <span style="font-size:11px;color:var(--muted);flex:none;">${new Date(t.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
        </div>
        <div style="font-size:12.5px;color:${t.status === "error" ? "var(--danger)" : "var(--text)"};line-height:1.55;word-break:break-word;padding-left:15px;">${esc(t.message)}</div>
      </div>`,
        )
        .join("")
    : `<div style="padding:16px;color:var(--muted);font-size:12.5px;">暂无动作记录</div>`;

  return `<div style="height:100%;overflow-y:auto;padding:18px 22px;">${head}${permWarn}
    <div style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:18px;">${idleHint}</div>
    <div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:9px;">动作历史（最新在上）</div>
    <div style="background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden;">${history}</div>
  </div>`;
}

function realtimeScreen(): string {
  if (desktop.isDesktop()) return realtimeReal();
  const head = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;"><div style="display:flex;align-items:center;gap:10px;"><h1 style="margin:0;font-size:16px;font-weight:600;">实时操作</h1><button data-act="rt-toggle" style="font-size:11.5px;color:var(--muted);background:transparent;border:1px solid var(--border);border-radius:999px;padding:2px 9px;cursor:pointer;">切换状态</button></div>${state.rtRunning ? `<button style="display:flex;align-items:center;gap:7px;padding:7px 15px;border:1.5px solid var(--danger);color:var(--danger);background:var(--danger-soft);border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>紧急停止</button>` : ""}</div>`;

  const idle = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--muted);height:420px;"><span style="width:54px;height:54px;border-radius:14px;background:var(--card);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg></span><div style="font-size:14px;">当前没有进行中的电脑操作</div><div style="font-size:12px;display:flex;align-items:center;gap:6px;"><span style="width:7px;height:7px;border-radius:999px;background:var(--warning);"></span>computer-use 已开启 · 权限待授予</div></div>`;

  const running = `<div style="display:grid;grid-template-columns:1.15fr 1fr;gap:16px;">
      <div>
        <div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px;"><span style="width:6px;height:6px;border-radius:999px;background:var(--danger);animation:umblink 1.4s infinite;"></span>当前屏幕</div>
        <div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;background:#3a3633;aspect-ratio:16/10;position:relative;">
          <div style="position:absolute;inset:0;background:linear-gradient(135deg,#4a4540,#2e2b28);"></div>
          <div style="position:absolute;left:18px;top:16px;right:18px;height:62%;background:var(--card);border-radius:8px;border:1px solid rgba(0,0,0,.2);overflow:hidden;">
            <div style="height:22px;background:var(--titlebar);display:flex;align-items:center;gap:4px;padding:0 8px;border-bottom:1px solid var(--border);"><span style="width:7px;height:7px;border-radius:999px;background:#FF5F57;"></span><span style="width:7px;height:7px;border-radius:999px;background:#FEBC2E;"></span><span style="width:7px;height:7px;border-radius:999px;background:#28C840;"></span><span style="font-size:9px;color:var(--muted);margin-left:6px;">访达 — 下载</span></div>
            <div style="padding:8px 10px;display:flex;flex-direction:column;gap:5px;"><div style="font-size:9.5px;color:var(--muted);">📄 report.docx</div><div style="font-size:9.5px;background:var(--orange-soft);color:var(--orange-text);border-radius:4px;padding:2px 4px;width:fit-content;">📕 weekly.pdf</div><div style="font-size:9.5px;color:var(--muted);">🖼 cover.png</div></div>
          </div>
          <div style="position:absolute;left:42%;top:46%;width:18px;height:18px;border:2px solid var(--orange);border-radius:999px;box-shadow:0 0 0 6px rgba(232,89,12,.25);"></div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:13px 15px;"><div style="font-size:11.5px;color:var(--muted);margin-bottom:5px;">目标</div><div style="font-size:13.5px;line-height:1.5;">把『下载』里的 weekly.pdf 发给飞书『增长组』</div></div>
        <div style="background:var(--orange-soft);border:1px solid var(--orange);border-radius:10px;padding:13px 15px;"><div style="font-size:11.5px;color:var(--orange-text);margin-bottom:5px;">当前动作</div><div style="font-size:13.5px;line-height:1.5;color:var(--text);display:flex;align-items:center;gap:8px;"><span style="width:7px;height:7px;border-radius:999px;background:var(--orange);"></span>在访达中选中 weekly.pdf</div></div>
        <div style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:13px 15px;"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;"><span style="font-size:11.5px;color:var(--muted);">引擎：云端 computer-use</span><span style="font-size:11.5px;color:var(--orange-text);font-weight:600;">第 3 / 20 步</span></div><div style="height:6px;border-radius:999px;background:var(--track);overflow:hidden;"><div style="height:100%;width:15%;background:var(--orange);"></div></div></div>
      </div>
    </div>
    <div style="margin-top:18px;"><div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:9px;">动作历史</div><div style="background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden;font-family:ui-monospace,Menlo,monospace;font-size:12px;">
      <div style="display:flex;gap:10px;padding:8px 13px;border-bottom:1px solid var(--border);"><span style="color:var(--muted);width:34px;">#1</span><span style="color:var(--orange-text);width:46px;">点击</span><span>Dock 上的「访达」图标</span></div>
      <div style="display:flex;gap:10px;padding:8px 13px;border-bottom:1px solid var(--border);"><span style="color:var(--muted);width:34px;">#2</span><span style="color:var(--orange-text);width:46px;">按键</span><span>⌘ + ⇧ + L 进入「下载」</span></div>
      <div style="display:flex;gap:10px;padding:8px 13px;background:var(--orange-soft);"><span style="color:var(--muted);width:34px;">#3</span><span style="color:var(--orange-text);width:46px;">点击</span><span>选中 weekly.pdf（当前）</span></div>
    </div></div>`;

  return `<div style="height:100%;overflow-y:auto;padding:18px 22px;">${head}${state.rtRunning ? running : idle}</div>`;
}

function logsScreen(): string {
  let rows: string;
  if (desktop.isDesktop()) {
    // 桌面态：展示设备引擎真实日志（连接/注册/任务/错误）。
    const dlogs = desktop.getDeviceLogs();
    rows = dlogs.length
      ? dlogs.map((l) => `<div style="color:var(--text);">${esc(l)}</div>`).join("")
      : `<div style="color:var(--muted);">暂无设备引擎日志（等待连接/注册）…</div>`;
  } else {
    const view = state.logFilter === "all" ? LOGS : LOGS.filter((l) => l.src === state.logFilter);
    rows = view
      .map((l) => `<div style="display:flex;gap:11px;"><span style="color:var(--muted);flex:none;">${l.time}</span><span style="flex:none;width:62px;font-weight:600;color:${l.color};">${l.tag}</span><span style="color:var(--text);">${esc(l.msg)}</span></div>`)
      .join("");
  }
  return `
  <div style="height:100%;display:flex;flex-direction:column;min-height:0;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid var(--border);flex:none;gap:12px;">
      <div style="display:flex;align-items:center;gap:14px;"><h1 style="margin:0;font-size:16px;font-weight:600;">日志</h1><div style="display:flex;gap:6px;">
        <button data-act="log-all" style="${chip(state.logFilter === "all")}">全部</button>
        <button data-act="log-jobs" style="${chip(state.logFilter === "jobs")}">任务</button>
        <button data-act="log-conn" style="${chip(state.logFilter === "conn")}">连接</button>
        <button data-act="log-cap" style="${chip(state.logFilter === "cap")}">能力执行</button>
      </div></div>
      <button style="display:flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:8px;font-size:12.5px;cursor:pointer;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>打开日志文件夹</button>
    </div>
    <div style="flex:1;overflow-y:auto;padding:14px 22px;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:12px;line-height:1.95;min-height:0;">${rows}</div>
  </div>`;
}

// 单条权限行：已授予显示绿勾，否则显示"去授权"按钮。
function permRow(title: string, desc: string, granted: boolean, actName: string): string {
  const status = granted
    ? `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;color:var(--success);font-weight:600;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>已授予</span>`
    : `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;color:var(--warning);font-weight:600;"><span style="width:7px;height:7px;border-radius:999px;background:var(--warning);"></span>未授予</span><button data-act="${actName}" style="padding:5px 12px;border:1px solid var(--warning);color:var(--warning);background:transparent;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;">去授权</button>`;
  return `<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);"><div style="flex:1;"><div style="font-size:13.5px;">${title}</div><div style="font-size:11.5px;color:var(--muted);margin-top:1px;">${desc}</div></div>${status}</div>`;
}

// 权限卡：桌面态读取真实授权状态（辅助功能 / 屏幕录制），按钮打开系统设置对应面板。
function permissionsCard(cuTrack: string): string {
  const p = desktop.getPermissions();
  return `<div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;"><div style="font-weight:600;margin-bottom:5px;">权限 <span style="font-size:12px;color:var(--muted);font-weight:400;">macOS</span></div><div style="display:flex;flex-direction:column;">
        ${permRow("辅助功能", "允许控制其它应用（点击、输入）", p.accessibility, "perm-accessibility")}
        ${permRow("屏幕录制", "用于截图与 computer-use 监看", p.screen === "granted", "perm-screen")}
        <div style="display:flex;align-items:center;gap:12px;padding:12px 0;"><div style="flex:1;"><div style="font-size:13.5px;">computer-use 总开关</div><div style="font-size:11.5px;color:var(--muted);margin-top:1px;">允许 AI 像人一样操作本机软件（默认关）</div></div><button data-act="cu-toggle" style="${cuTrack}"><span style="width:18px;height:18px;border-radius:999px;background:#fff;display:block;box-shadow:0 1px 2px rgba(0,0,0,.25);"></span></button></div>
      </div></div>`;
}

// 剪贴板历史设置卡片（开关 / 快捷键录制 / 清空历史）。
function clipboardCard(): string {
  if (!clipBridge) return "";
  const on = state.clip.enabled;
  const track = `width:38px;height:22px;border-radius:999px;border:none;cursor:pointer;padding:2px;display:flex;justify-content:${on ? "flex-end" : "flex-start"};background:${on ? "var(--orange)" : "var(--border)"};transition:background .15s;flex:none;`;
  const shortcutText = state.clip.recording ? "按下快捷键…（Esc 取消）" : esc(state.clip.shortcut);
  return `
  <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;"><div style="font-weight:600;margin-bottom:14px;">剪贴板历史</div><div style="display:flex;flex-direction:column;gap:14px;">
    <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">开启历史记录</label><span style="flex:1;font-size:12px;color:var(--muted);">后台监听剪贴板，${on ? "已开启" : "已关闭（历史保留）"}</span><button data-act="clip-toggle" style="${track}"><span style="width:18px;height:18px;border-radius:999px;background:#fff;display:block;box-shadow:0 1px 2px rgba(0,0,0,.25);"></span></button></div>
    <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">面板快捷键</label><button data-act="clip-rec" style="flex:1;text-align:left;border:1px solid ${state.clip.recording ? "var(--orange)" : "var(--border)"};background:var(--bg);color:var(--text);border-radius:8px;padding:7px 11px;font-size:13px;cursor:pointer;font-family:ui-monospace,Menlo,monospace;">${shortcutText}</button></div>
    <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">清空历史</label><span style="flex:1;font-size:12px;color:var(--muted);">删除全部非收藏条目（收藏保留）</span><button data-act="clip-clear" style="padding:6px 13px;border:1px solid var(--danger);background:transparent;color:var(--danger);border-radius:8px;font-size:12.5px;cursor:pointer;">清空</button></div>
  </div></div>`;
}

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
function screenshotCard(): string {
  if (!shotBridge) return "";
  const on = state.shot.enabled;
  const track = `width:38px;height:22px;border-radius:999px;border:none;cursor:pointer;padding:2px;display:flex;justify-content:${on ? "flex-end" : "flex-start"};background:${on ? "var(--orange)" : "var(--border)"};transition:background .15s;flex:none;`;
  const shortcutText = state.shot.recording ? "按下快捷键…（Esc 取消）" : esc(state.shot.shortcut);
  return `
  <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;"><div style="font-weight:600;margin-bottom:14px;">截图</div><div style="display:flex;flex-direction:column;gap:14px;">
    <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">开启截图</label><span style="flex:1;font-size:12px;color:var(--muted);">${on ? "已开启" : "已关闭（不注册快捷键）"}；需「屏幕录制」权限</span><button data-act="shot-toggle" style="${track}"><span style="width:18px;height:18px;border-radius:999px;background:#fff;display:block;box-shadow:0 1px 2px rgba(0,0,0,.25);"></span></button></div>
    <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">截图快捷键</label><button data-act="shot-rec" style="flex:1;text-align:left;border:1px solid ${state.shot.recording ? "var(--orange)" : "var(--border)"};background:var(--bg);color:var(--text);border-radius:8px;padding:7px 11px;font-size:13px;cursor:pointer;font-family:ui-monospace,Menlo,monospace;">${shortcutText}</button></div>
    <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">翻译 Key</label><input id="shot-glmkey" type="password" placeholder="${state.shot.hasGlmKey ? "已设置（智谱 GLM）" : "智谱 GLM API Key（翻译用）"}" style="flex:1;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;padding:7px 11px;font-size:13px;outline:none;font-family:ui-monospace,Menlo,monospace;"><button data-act="shot-savekey" style="padding:6px 13px;border:1px solid var(--border);background:transparent;color:var(--text);border-radius:8px;font-size:12.5px;cursor:pointer;">保存</button></div>
  </div></div>`;
}

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
  if (!confirm("确定清空全部非收藏的剪贴板历史？收藏条目会保留。")) return;
  clipBridge.clear().catch(() => {});
}

function toggleShotEnabled(): void {
  if (!shotBridge) return;
  state.shot.enabled = !state.shot.enabled;
  render();
  shotBridge.setEnabled(state.shot.enabled).catch(() => {});
}

function saveShotGlmKey(): void {
  if (!shotBridge) return;
  const el = document.getElementById("shot-glmkey") as HTMLInputElement | null;
  const key = (el?.value || "").trim();
  if (!key) return;
  shotBridge.setGlmKey(key).then(() => {
    state.shot.hasGlmKey = true;
    if (el) el.value = "";
    render();
  }).catch(() => {});
}

function settingsScreen(): string {
  const inputBase = "flex:1;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;padding:7px 11px;font-size:13px;outline:none;";
  const cuOn = computerEnabled();
  const cuTrack = `width:38px;height:22px;border-radius:999px;border:none;cursor:pointer;padding:2px;display:flex;justify-content:${cuOn ? "flex-end" : "flex-start"};background:${cuOn ? "var(--orange)" : "var(--border)"};transition:background .15s;`;
  return `
  <div id="scroll-main" style="height:100%;overflow-y:auto;padding:18px 22px;">
    <h1 style="margin:0 0 16px;font-size:16px;font-weight:600;">设置</h1>
    <div style="display:flex;flex-direction:column;gap:14px;max-width:680px;">
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;"><div style="font-weight:600;margin-bottom:14px;">连接</div><div style="display:flex;flex-direction:column;gap:13px;">
        <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">服务端地址</label><input id="set-server" value="${esc(getServerUrl())}" style="${inputBase}font-family:ui-monospace,Menlo,monospace;"></div>
        <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">访问 Token</label><input id="set-token" type="password" placeholder="${tokenPlaceholder()}" style="${inputBase}font-family:ui-monospace,Menlo,monospace;letter-spacing:2px;"></div>
        <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">连接状态</label>${connStatusInline()}<span style="flex:1;"></span><button data-act="reconnect" style="padding:6px 13px;border:1px solid var(--border);background:transparent;color:var(--text);border-radius:8px;font-size:12.5px;cursor:pointer;">保存并重连</button></div>
      </div></div>
      ${deviceEngineCard()}
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;"><div style="font-weight:600;margin-bottom:14px;">设备</div><div style="display:flex;flex-direction:column;gap:13px;">
        <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">设备 ID</label><span style="font-size:13px;font-family:ui-monospace,Menlo,monospace;color:var(--text);">${esc(deviceIdLabel())}</span></div>
        <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">设备名</label><input id="set-device" value="${esc(getDeviceName())}" style="${inputBase}"></div>
      </div></div>
      ${permissionsCard(cuTrack)}
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;"><div style="font-weight:600;margin-bottom:14px;">能力配置</div>
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">providers.json</label><span style="flex:1;font-size:12px;font-family:ui-monospace,Menlo,monospace;color:var(--muted);word-break:break-all;">${esc(desktop.getDesktopConfig()?.providersFile || "（仅桌面应用可用）")}</span><button data-act="edit-providers" style="padding:6px 13px;border:1px solid var(--border);background:transparent;color:var(--text);border-radius:8px;font-size:12.5px;cursor:pointer;">编辑</button></div>
        <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">coding 权限</label><div style="display:flex;border:1px solid var(--border);border-radius:8px;overflow:hidden;"><button data-act="mode-0" style="${seg(state.codingMode === 0)}">只生成</button><button data-act="mode-1" style="${seg(state.codingMode === 1)}">执行前确认</button><button data-act="mode-2" style="${seg(state.codingMode === 2, true)}">直接执行</button></div></div>
      </div>
      ${clipboardCard()}
      ${screenshotCard()}
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;display:flex;align-items:center;gap:14px;"><div style="flex:1;"><div style="font-weight:600;">关于</div><div style="font-size:12px;color:var(--muted);margin-top:3px;">Umbra 桌面客户端 · v0.1.0 (electron)</div></div><button style="padding:6px 13px;border:1px solid var(--border);background:transparent;color:var(--text);border-radius:8px;font-size:12.5px;cursor:pointer;">检查更新</button></div>
    </div>
  </div>`;
}

function currentScreen(): string {
  switch (state.nav) {
    case "chat": return chatScreen();
    case "tasks": return tasksScreen();
    case "abilities": return abilitiesScreen();
    case "realtime": return realtimeScreen();
    case "logs": return logsScreen();
    case "settings": return settingsScreen();
  }
}

// 触发 React 重渲染（React 的 LegacyHost 会重建各区块 innerHTML 并还原滚动、挂载聊天子树）。
function render(): void {
  bridgeRerender();
}

// 从设置表单读取并保存连接配置，然后重连。
function saveAndReconnect(): void {
  const server = (document.getElementById("set-server") as HTMLInputElement | null)?.value;
  const token = (document.getElementById("set-token") as HTMLInputElement | null)?.value;
  const device = (document.getElementById("set-device") as HTMLInputElement | null)?.value;
  if (server) setServerUrl(server);
  if (token) setToken(token);
  if (device) setDeviceName(device);
  // 桌面态：把同样的配置推给主进程设备引擎（触发其重连）。
  desktop.pushConfig({ serverUrl: server || getServerUrl(), token: token || "", deviceName: device || getDeviceName() }).catch(() => {});
  chatConn.reconnect();
  render();
}

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
  if (nav === "settings") {
    loadClipSettings();
    loadShotSettings();
  }
  bridgeNav(nav); // 同步给 React（会触发重渲染）
}

function onClick(e: MouseEvent): void {
  const target = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
  if (!target) return;
  const act = target.dataset.act!;
  if (act === "noop") { e.preventDefault(); return; }
  if (act.startsWith("nav-")) { setNav(act.slice(4) as Nav); return; }
  switch (act) {
    case "theme": state.dark = !state.dark; render(); break;
    case "reconnect": saveAndReconnect(); break;
    case "task-open": if (target.dataset.id) openJob(target.dataset.id); break;
    case "task-close": closeJob(); break;
    case "tasks-refresh": manualRefresh(); break;
    case "rt-toggle": state.rtRunning = !state.rtRunning; render(); break;
    case "cu-toggle": toggleComputerUse(); break;
    case "cu-stop": desktop.computerStop(); chatConn.sendOperateStop(); break;
    case "perm-screen": desktop.openPrivacy("screen"); break;
    case "perm-accessibility": desktop.openPrivacy("accessibility"); break;
    case "edit-providers": desktop.openProvidersFile(); break;
    case "prov-toggle": if (target.dataset.prov) desktop.setProviderEnabled(target.dataset.prov, desktop.isProviderDisabled(target.dataset.prov)).then(render); break;
    case "prov-add": openProvAdd(); break;
    case "prov-edit": if (target.dataset.prov) openProvEdit(target.dataset.prov); break;
    case "prov-del": if (target.dataset.prov) delProv(target.dataset.prov); break;
    case "pm-add-skill": captureProvModal(); state.provModal.skills.push({ skill: "", description: "", command: "", confirm: false }); render(); break;
    case "pm-del-skill": { captureProvModal(); const i = Number(target.dataset.idx); if (i >= 0) state.provModal.skills.splice(i, 1); render(); break; }
    case "pm-save": saveProvModal(); break;
    case "pm-cancel": state.provModal.open = false; render(); break;
    case "mode-0": setCodingMode(0); break;
    case "mode-1": setCodingMode(1); break;
    case "mode-2": setCodingMode(2); break;
    case "clip-toggle": toggleClipEnabled(); break;
    case "clip-rec": beginShortcutRecording("clip"); break;
    case "clip-clear": clearClipHistory(); break;
    case "shot-toggle": toggleShotEnabled(); break;
    case "shot-rec": beginShortcutRecording("shot"); break;
    case "shot-savekey": saveShotGlmKey(); break;
    case "log-all": state.logFilter = "all"; render(); break;
    case "log-jobs": state.logFilter = "jobs"; render(); break;
    case "log-conn": state.logFilter = "conn"; render(); break;
    case "log-cap": state.logFilter = "cap"; render(); break;
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  if (state.provModal.open) { state.provModal.open = false; render(); return; }
  if (state.tasks.detailId) closeJob();
}

// 由 React 根（main.tsx）在挂载后调用：接管点击委托、键盘、设备事件订阅。
export function initLegacy(): void {
  chat.setAppRerender(render);
  document.addEventListener("click", onClick); // 委托：处理各页面/弹窗内的 data-act（含侧边栏 nav / 标题栏 theme）
  window.addEventListener("keydown", onKeydown);
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
