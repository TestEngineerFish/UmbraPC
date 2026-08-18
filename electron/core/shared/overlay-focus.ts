// 快捷键弹窗（剪贴板 / 快捷入口 / 截屏）显示在「用户正在看的那一桌」，关掉后焦点还给原窗口。
//
// macOS Space：面板已经 setVisibleOnAllWorkspaces，但它 show()/focus() 会激活整个 app。
// 系统随后切到「这个 app 有普通窗口的那个 Space」——主窗口或截图贴图还停在 Space 1 时，
// 人在 Space 3 按快捷键就会被拽回去；贴图抢走焦点，面板 blur 再把自己收掉（闪一下）。
// 对策：弹出前先把其它可见窗口 hide，激活完再用 showInactive 放回去（不抢焦、不跳 Space）；
// 贴图不算「用户在 Umbra 里」；Esc 时 app.hide() 之后再 showInactive 把贴图/主窗口放回原 Space。
//
// Windows：setVisibleOnAllWorkspaces 是空操作，预热 HWND 绑在创建时的虚拟桌面，
// show 前要用 IVirtualDesktopManager 挪到当前桌面（失败则重建）。

import { BrowserWindow } from "electron";
import { isOnActiveSpace } from "./darwin-space";
import { getWin32DesktopApi, parseGuid, type Win32DesktopApi } from "./win32-desktop";

export type { Win32DesktopApi };
export { parseGuid };

/** 刚弹出时跳桌面/激活其它窗口会甩来一次 blur，这段时间内忽略并夺回焦点。 */
export const OVERLAY_BLUR_GRACE_MS = 600;

export const ALL_WORKSPACES = { visibleOnFullScreen: true, skipTransformProcessType: true } as const;

export function shouldIgnoreOverlayBlur(shownAt: number, now = Date.now(), graceMs = OVERLAY_BLUR_GRACE_MS): boolean {
  return now - shownAt < graceMs;
}

export type OverlayForeground = { hwnd: bigint } | { self: true };

export type WindowRole = "chrome" | "overlay";

export interface FocusSnapshot {
  focused: boolean;
  role: WindowRole;
  onActiveSpace: boolean | null;
}

/** 贴图/悬浮面板不算「人在 Umbra 里」；主窗口若在别的 Space 上也不算。 */
export function computeAppWasActive(windows: FocusSnapshot[]): boolean {
  return windows.some((w) => {
    if (!w.focused || w.role !== "chrome") return false;
    if (w.onActiveSpace === false) return false;
    return true;
  });
}

const overlayWins = new WeakSet<object>();

export function markOverlayWindow(win: object): void {
  overlayWins.add(win);
}

export function isOverlayWindow(win: object): boolean {
  return overlayWins.has(win);
}

export function hwndFromHandle(buf: Buffer | null | undefined): bigint | null {
  if (!buf || buf.length < 4) return null;
  if (buf.length >= 8) return buf.readBigUInt64LE(0);
  return BigInt(buf.readUInt32LE(0));
}

export function pinHwndToForegroundDesktop(hwnd: bigint, api: Win32DesktopApi): boolean {
  const fg = api.getForegroundHwnd();
  if (fg == null) return false;
  if (api.isOnCurrentDesktop(hwnd) === true) return true;
  return api.moveToDesktopOf(hwnd, fg);
}

export function captureForegroundFromApi(api: Win32DesktopApi, ourPid: number): OverlayForeground | null {
  const fg = api.getForegroundHwnd();
  if (fg == null) return null;
  const pid = api.getPid(fg);
  if (pid != null && pid === ourPid) return { self: true };
  return { hwnd: fg };
}

export function planHideOverlay(opts: {
  platform: string;
  appWasActive: boolean;
  saved: OverlayForeground | null;
  returnFocus: boolean;
}): { hideApp: boolean; restoreHwnd: bigint | null; restoreParked: boolean } {
  if (!opts.returnFocus || opts.appWasActive) return { hideApp: false, restoreHwnd: null, restoreParked: false };
  if (opts.platform === "darwin") return { hideApp: true, restoreHwnd: null, restoreParked: true };
  if (opts.platform === "win32" && opts.saved && "hwnd" in opts.saved) {
    return { hideApp: false, restoreHwnd: opts.saved.hwnd, restoreParked: false };
  }
  return { hideApp: false, restoreHwnd: null, restoreParked: false };
}

function native(): Win32DesktopApi | null {
  return getWin32DesktopApi();
}

export function captureOverlayForeground(): OverlayForeground | null {
  const api = native();
  if (!api) return null;
  return captureForegroundFromApi(api, process.pid);
}

export async function detectAppWasActive(): Promise<{ appWasActive: boolean; saved: OverlayForeground | null }> {
  const snapshots: FocusSnapshot[] = BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed())
    .map((w) => ({
      focused: w.isFocused(),
      role: isOverlayWindow(w) ? "overlay" : "chrome",
      onActiveSpace: process.platform === "darwin" ? isOnActiveSpace(w) : null,
    }));
  const appWasActive = computeAppWasActive(snapshots);
  const saved = captureOverlayForeground();
  if (saved && "hwnd" in saved) return { appWasActive, saved };
  return { appWasActive, saved: appWasActive ? { self: true } : null };
}

/** 把已有 BrowserWindow 绑到当前虚拟桌面。非 Windows 直接成功；Windows 失败则调用方应重建窗口。 */
export function pinOverlayToCurrentDesktop(win: BrowserWindow, owner?: OverlayForeground | null): boolean {
  if (process.platform !== "win32") return true;
  const api = native();
  if (!api) return false;
  try {
    const hwnd = hwndFromHandle(win.getNativeWindowHandle());
    if (hwnd == null) return false;
    if (owner && "hwnd" in owner) {
      if (api.isOnCurrentDesktop(hwnd) === true) return true;
      return api.moveToDesktopOf(hwnd, owner.hwnd);
    }
    return pinHwndToForegroundDesktop(hwnd, api);
  } catch {
    return false;
  }
}

let parked: BrowserWindow[] = [];

/** 弹出前先把其它可见窗口藏起来，避免激活 app 时系统跳到它们所在的 Space；激活后再 showInactive 放回。 */
export function presentOverlayWindow(overlay: BrowserWindow): void {
  markOverlayWindow(overlay);
  parked = [];
  try {
    const all = typeof BrowserWindow.getAllWindows === "function" ? BrowserWindow.getAllWindows() : [];
    parked = all.filter((w) => w !== overlay && !w.isDestroyed() && w.isVisible());
  } catch {
    parked = [];
  }
  for (const w of parked) {
    try { w.hide(); } catch { /* 销毁中 */ }
  }
  overlay.show();
  overlay.focus();
  for (const w of parked) {
    try { if (!w.isDestroyed()) w.showInactive(); } catch { /* 销毁中 */ }
  }
}

export async function releaseOverlayFocus(opts: {
  appWasActive: boolean;
  saved: OverlayForeground | null;
  returnFocus: boolean;
}): Promise<void> {
  const plan = planHideOverlay({
    platform: process.platform,
    appWasActive: opts.appWasActive,
    saved: opts.saved,
    returnFocus: opts.returnFocus,
  });
  if (plan.restoreHwnd != null) native()?.setForeground(plan.restoreHwnd);
  if (plan.hideApp) {
    const { app } = await import("electron");
    app.hide();
  }
  if (plan.restoreParked) {
    for (const w of parked) {
      try { if (!w.isDestroyed()) w.showInactive(); } catch { /* 销毁中 */ }
    }
  }
  parked = [];
}

export function waitDidFinishLoad(win: BrowserWindow, timeoutMs = 4000): Promise<void> {
  // 必须在 loadURL/loadFile 之前挂上。新建窗的 getURL() 经常是 about:blank，
  // 不能拿「已经有 URL」当加载完成，否则会不等真正的页面。
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    try {
      win.webContents.once("did-finish-load", () => {
        clearTimeout(t);
        resolve();
      });
    } catch {
      clearTimeout(t);
      resolve();
    }
  });
}
