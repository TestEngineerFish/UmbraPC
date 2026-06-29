// Umbra 桌面客户端 · 渲染层（vanilla TS）
// 依据 Claude Design 设计稿还原。当前为界面 + mock 交互；
// 后续接入核心引擎（连服务端、Provider、computer-use）时，把 mock 数据换成真实数据源即可。

import { chatConn, getServerUrl, setServerUrl, setToken, getToken, getDeviceName, setDeviceName } from "./server";
import * as chat from "./chat";

type Nav = "chat" | "tasks" | "abilities" | "realtime" | "logs" | "settings";

const state = {
  nav: "chat" as Nav,
  dark: false,
  taskOpen: false,
  rtRunning: true,
  cu: false,
  codingMode: 1,
  logFilter: "all" as "all" | "jobs" | "conn" | "cap",
};

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

function tasksScreen(): string {
  const drawer = state.taskOpen
    ? `<div data-act="task-close" style="position:absolute;inset:0;background:rgba(0,0,0,.32);z-index:30;"></div>
      <div style="position:absolute;top:0;right:0;bottom:0;width:420px;background:var(--card);border-left:1px solid var(--border);z-index:31;display:flex;flex-direction:column;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:15px 20px;border-bottom:1px solid var(--border);"><div><div style="font-weight:600;font-size:15px;">写一个待办小程序</div><div style="font-size:11.5px;color:var(--orange-text);margin-top:2px;">执行中 · Claude Code</div></div><button data-act="task-close" style="border:none;background:transparent;color:var(--muted);cursor:pointer;font-size:20px;line-height:1;">×</button></div>
        <div style="flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:20px;">
          <div><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;"><span style="font-size:12px;color:var(--muted);">总进度</span><span style="font-size:12px;color:var(--orange-text);font-weight:600;">65%</span></div><div style="height:6px;border-radius:999px;background:var(--track);overflow:hidden;"><div style="height:100%;width:65%;background:var(--orange);"></div></div></div>
          <div><div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:10px;">步骤</div><div style="display:flex;flex-direction:column;gap:9px;">
            <div style="display:flex;align-items:center;gap:9px;font-size:13px;"><span style="width:18px;height:18px;border-radius:999px;background:var(--success);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;">✓</span>拟定结构</div>
            <div style="display:flex;align-items:center;gap:9px;font-size:13px;"><span style="width:18px;height:18px;border-radius:999px;border:2px solid var(--orange);"></span>生成 index.html</div>
            <div style="display:flex;align-items:center;gap:9px;font-size:13px;color:var(--muted);"><span style="width:18px;height:18px;border-radius:999px;border:2px solid var(--border);"></span>接入交互逻辑</div>
            <div style="display:flex;align-items:center;gap:9px;font-size:13px;color:var(--muted);"><span style="width:18px;height:18px;border-radius:999px;border:2px solid var(--border);"></span>本地保存与通知</div>
          </div></div>
          <div><div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:10px;">事件时间线</div><div style="display:flex;flex-direction:column;border-left:2px solid var(--border);margin-left:4px;">
            <div style="position:relative;padding:0 0 13px 16px;"><span style="position:absolute;left:-6px;top:3px;width:9px;height:9px;border-radius:999px;background:var(--orange);"></span><span style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);">14:08</span><div style="font-size:12.5px;">创建任务</div></div>
            <div style="position:relative;padding:0 0 13px 16px;"><span style="position:absolute;left:-6px;top:3px;width:9px;height:9px;border-radius:999px;background:var(--orange);"></span><span style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);">14:08</span><div style="font-size:12.5px;">拟定结构 · 4 个步骤</div></div>
            <div style="position:relative;padding:0 0 2px 16px;"><span style="position:absolute;left:-6px;top:3px;width:9px;height:9px;border-radius:999px;background:var(--orange);"></span><span style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);">14:09</span><div style="font-size:12.5px;">生成 index.html…</div></div>
          </div></div>
          <div><div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:10px;">生成结果</div><div style="display:flex;align-items:center;gap:8px;font-size:13px;border:1px solid var(--border);border-radius:8px;padding:9px 11px;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path></svg><a href="#" data-act="noop" style="color:var(--orange-text);text-decoration:none;font-weight:500;">index.html</a><span style="flex:1;"></span><span style="font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--muted);">~/Downloads/todo/</span></div></div>
        </div>
      </div>`
    : "";

  return `
  <div style="height:100%;overflow-y:auto;padding:18px 22px;">
    <h1 style="margin:0 0 16px;font-size:16px;font-weight:600;">任务</h1>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:13px 16px;display:flex;align-items:center;gap:14px;"><div style="flex:1;"><div style="font-weight:500;">导出周报 PDF</div><div style="font-size:11.5px;color:var(--muted);margin-top:2px;">本机 · MacBook-Pro-2</div></div>${badge("已完成", "ok")}<span style="font-size:12px;color:var(--muted);width:42px;text-align:right;">14:02</span></div>
      <div data-act="task-open" style="background:var(--card);border:1px solid var(--orange);border-radius:12px;padding:13px 16px;cursor:pointer;"><div style="display:flex;align-items:center;gap:14px;margin-bottom:9px;"><div style="flex:1;"><div style="font-weight:500;">写一个待办小程序</div><div style="font-size:11.5px;color:var(--muted);margin-top:2px;">Claude Code · 执行模式</div></div>${badge("执行中", "run")}<span style="font-size:12px;color:var(--muted);width:42px;text-align:right;">14:09</span></div><div style="height:5px;border-radius:999px;background:var(--track);overflow:hidden;"><div style="height:100%;width:65%;background:var(--orange);"></div></div></div>
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:13px 16px;display:flex;align-items:center;gap:14px;"><div style="flex:1;"><div style="font-weight:500;">给落地页换主图</div><div style="font-size:11.5px;color:var(--muted);margin-top:2px;">排队中</div></div>${badge("待执行", "wait")}<span style="font-size:12px;color:var(--muted);width:42px;text-align:right;">14:11</span></div>
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:13px 16px;display:flex;align-items:center;gap:14px;"><div style="flex:1;"><div style="font-weight:500;">批量压缩视频</div><div style="font-size:11.5px;color:var(--danger);margin-top:2px;">FFmpeg 退出码 1 · 磁盘空间不足</div></div>${badge("失败", "fail")}<span style="font-size:12px;color:var(--muted);width:42px;text-align:right;">13:40</span></div>
    </div>
  </div>
  ${drawer}`;
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

function abilitiesScreen(): string {
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

function realtimeScreen(): string {
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
  const view = state.logFilter === "all" ? LOGS : LOGS.filter((l) => l.src === state.logFilter);
  const rows = view
    .map((l) => `<div style="display:flex;gap:11px;"><span style="color:var(--muted);flex:none;">${l.time}</span><span style="flex:none;width:62px;font-weight:600;color:${l.color};">${l.tag}</span><span style="color:var(--text);">${esc(l.msg)}</span></div>`)
    .join("");
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

function settingsScreen(): string {
  const inputBase = "flex:1;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;padding:7px 11px;font-size:13px;outline:none;";
  const cuTrack = `width:38px;height:22px;border-radius:999px;border:none;cursor:pointer;padding:2px;display:flex;justify-content:${state.cu ? "flex-end" : "flex-start"};background:${state.cu ? "var(--orange)" : "var(--border)"};transition:background .15s;`;
  return `
  <div style="height:100%;overflow-y:auto;padding:18px 22px;">
    <h1 style="margin:0 0 16px;font-size:16px;font-weight:600;">设置</h1>
    <div style="display:flex;flex-direction:column;gap:14px;max-width:680px;">
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;"><div style="font-weight:600;margin-bottom:14px;">连接</div><div style="display:flex;flex-direction:column;gap:13px;">
        <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">服务端地址</label><input id="set-server" value="${esc(getServerUrl())}" style="${inputBase}font-family:ui-monospace,Menlo,monospace;"></div>
        <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">访问 Token</label><input id="set-token" type="password" placeholder="${getToken() ? "（已保存，留空不变）" : "可选"}" style="${inputBase}font-family:ui-monospace,Menlo,monospace;letter-spacing:2px;"></div>
        <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">连接状态</label>${connStatusInline()}<span style="flex:1;"></span><button data-act="reconnect" style="padding:6px 13px;border:1px solid var(--border);background:transparent;color:var(--text);border-radius:8px;font-size:12.5px;cursor:pointer;">保存并重连</button></div>
      </div></div>
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;"><div style="font-weight:600;margin-bottom:14px;">设备</div><div style="display:flex;flex-direction:column;gap:13px;">
        <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">设备 ID</label><span style="font-size:13px;font-family:ui-monospace,Menlo,monospace;color:var(--text);">dev_8f3a-2c91-mbp2</span></div>
        <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">设备名</label><input id="set-device" value="${esc(getDeviceName())}" style="${inputBase}"></div>
      </div></div>
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;"><div style="font-weight:600;margin-bottom:5px;">权限 <span style="font-size:12px;color:var(--muted);font-weight:400;">macOS</span></div><div style="display:flex;flex-direction:column;">
        <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);"><div style="flex:1;"><div style="font-size:13.5px;">辅助功能</div><div style="font-size:11.5px;color:var(--muted);margin-top:1px;">允许控制其它应用（点击、输入）</div></div><span style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;color:var(--success);font-weight:600;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>已授予</span></div>
        <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);"><div style="flex:1;"><div style="font-size:13.5px;">屏幕录制</div><div style="font-size:11.5px;color:var(--muted);margin-top:1px;">用于截图与 computer-use 监看</div></div><span style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;color:var(--warning);font-weight:600;"><span style="width:7px;height:7px;border-radius:999px;background:var(--warning);"></span>未授予</span><button style="padding:5px 12px;border:1px solid var(--warning);color:var(--warning);background:transparent;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;">去授权</button></div>
        <div style="display:flex;align-items:center;gap:12px;padding:12px 0;"><div style="flex:1;"><div style="font-size:13.5px;">computer-use 总开关</div><div style="font-size:11.5px;color:var(--muted);margin-top:1px;">允许 AI 像人一样操作本机软件（默认关）</div></div><button data-act="cu-toggle" style="${cuTrack}"><span style="width:18px;height:18px;border-radius:999px;background:#fff;display:block;box-shadow:0 1px 2px rgba(0,0,0,.25);"></span></button></div>
      </div></div>
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;"><div style="font-weight:600;margin-bottom:14px;">能力配置</div>
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">providers.json</label><span style="flex:1;font-size:12px;font-family:ui-monospace,Menlo,monospace;color:var(--muted);">~/.umbra/providers.json</span><button style="padding:6px 13px;border:1px solid var(--border);background:transparent;color:var(--text);border-radius:8px;font-size:12.5px;cursor:pointer;">编辑</button></div>
        <div style="display:flex;align-items:center;gap:14px;"><label style="width:120px;font-size:13px;color:var(--muted);">coding 权限</label><div style="display:flex;border:1px solid var(--border);border-radius:8px;overflow:hidden;"><button data-act="mode-0" style="${seg(state.codingMode === 0)}">只生成</button><button data-act="mode-1" style="${seg(state.codingMode === 1)}">执行前确认</button><button data-act="mode-2" style="${seg(state.codingMode === 2, true)}">直接执行</button></div></div>
      </div>
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

function render(): void {
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="umbra-root" data-theme="${state.dark ? "dark" : "light"}" style="position:relative;">
      ${titlebar()}
      <div style="flex:1;display:flex;min-height:0;">
        ${sidebar()}
        <main style="flex:1;display:flex;flex-direction:column;min-width:0;background:var(--bg);">${currentScreen()}</main>
      </div>
    </div>`;
  if (state.nav === "chat") {
    const root = document.getElementById("chatroot");
    if (root) chat.mount(root);
  }
}

// 从设置表单读取并保存连接配置，然后重连。
function saveAndReconnect(): void {
  const server = (document.getElementById("set-server") as HTMLInputElement | null)?.value;
  const token = (document.getElementById("set-token") as HTMLInputElement | null)?.value;
  const device = (document.getElementById("set-device") as HTMLInputElement | null)?.value;
  if (server) setServerUrl(server);
  if (token) setToken(token);
  if (device) setDeviceName(device);
  chatConn.reconnect();
  render();
}

function onClick(e: MouseEvent): void {
  const target = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
  if (!target) return;
  const act = target.dataset.act!;
  if (act === "noop") { e.preventDefault(); return; }
  if (act.startsWith("nav-")) { state.nav = act.slice(4) as Nav; render(); return; }
  switch (act) {
    case "theme": state.dark = !state.dark; render(); break;
    case "reconnect": saveAndReconnect(); break;
    case "task-open": state.taskOpen = true; render(); break;
    case "task-close": state.taskOpen = false; render(); break;
    case "rt-toggle": state.rtRunning = !state.rtRunning; render(); break;
    case "cu-toggle": state.cu = !state.cu; render(); break;
    case "mode-0": state.codingMode = 0; render(); break;
    case "mode-1": state.codingMode = 1; render(); break;
    case "mode-2": state.codingMode = 2; render(); break;
    case "log-all": state.logFilter = "all"; render(); break;
    case "log-jobs": state.logFilter = "jobs"; render(); break;
    case "log-conn": state.logFilter = "conn"; render(); break;
    case "log-cap": state.logFilter = "cap"; render(); break;
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && state.taskOpen) { state.taskOpen = false; render(); }
}

chat.setAppRerender(render);
document.getElementById("app")!.addEventListener("click", onClick);
window.addEventListener("keydown", onKeydown);
render();
