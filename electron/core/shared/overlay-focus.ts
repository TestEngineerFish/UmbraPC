// 快捷键弹窗（剪贴板 / 快捷入口 / 截屏）的「显示在当前桌面、关掉后焦点还给原窗口」。
//
// macOS 靠 setVisibleOnAllWorkspaces + app.hide()，早就处理过 Space 跳屏。
// Windows 上那套 API 是空操作：预热时建的隐藏窗、截图贴图，都会绑在当时的虚拟桌面。
// 之后在别的桌面按快捷键：
//   · show()/focus() 那个 HWND → 系统切回窗口所在桌面；
//   · 贴图/主窗口是同进程 alwaysOnTop，切过去的瞬间把面板焦抢走，blur 再把面板收掉（不到 1 秒闪一下）；
//   · Esc 藏面板后焦点落到另一桌面的贴图 → 再切回去。
// 所以 Windows 要在 show 前把弹窗挪到「当前前台窗口」所在桌面，hide 时把焦点还给那个窗口。

import type { BrowserWindow } from "electron";
import { getWin32DesktopApi, parseGuid, type Win32DesktopApi } from "./win32-desktop";

export type { Win32DesktopApi };
export { parseGuid };

/** 刚弹出时跳桌面/激活其它窗口会甩来一次 blur，这段时间内忽略并夺回焦点。 */
export const OVERLAY_BLUR_GRACE_MS = 600;

export function shouldIgnoreOverlayBlur(shownAt: number, now = Date.now(), graceMs = OVERLAY_BLUR_GRACE_MS): boolean {
  return now - shownAt < graceMs;
}

export type OverlayForeground = { hwnd: bigint } | { self: true };

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
}): { hideApp: boolean; restoreHwnd: bigint | null } {
  if (!opts.returnFocus || opts.appWasActive) return { hideApp: false, restoreHwnd: null };
  if (opts.platform === "darwin") return { hideApp: true, restoreHwnd: null };
  if (opts.platform === "win32" && opts.saved && "hwnd" in opts.saved) {
    return { hideApp: false, restoreHwnd: opts.saved.hwnd };
  }
  return { hideApp: false, restoreHwnd: null };
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
  const saved = captureOverlayForeground();
  if (saved) return { appWasActive: "self" in saved, saved };
  const { BrowserWindow } = await import("electron");
  const appWasActive = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
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
