// Windows 多虚拟桌面下，快捷键弹窗会跟着预热窗口/贴图跳回原桌面。
// 这一层是纯决策：要不要挪窗口、hide 时焦点还给谁、刚弹出的 blur 要不要理。
// 真正的 user32 / IVirtualDesktopManager 在 win32-desktop.ts，测试用假 API 钉住分支。
import { describe, expect, it } from "vitest";
import {
  OVERLAY_BLUR_GRACE_MS,
  captureForegroundFromApi,
  hwndFromHandle,
  parseGuid,
  pinHwndToForegroundDesktop,
  planHideOverlay,
  pinOverlayToCurrentDesktop,
  shouldIgnoreOverlayBlur,
  type OverlayForeground,
  type Win32DesktopApi,
} from "../electron/core/shared/overlay-focus";

function api(partial: Partial<Win32DesktopApi> = {}): Win32DesktopApi {
  return {
    getForegroundHwnd: () => 0x100n,
    getPid: () => 7,
    isOnCurrentDesktop: () => false,
    moveToDesktopOf: () => true,
    setForeground: () => true,
    ...partial,
  };
}

describe("shouldIgnoreOverlayBlur", () => {
  it("刚弹出的一小段时间内忽略失焦，避免跳桌面动画把面板立刻收掉", () => {
    expect(shouldIgnoreOverlayBlur(1000, 1000)).toBe(true);
    expect(shouldIgnoreOverlayBlur(1000, 1000 + OVERLAY_BLUR_GRACE_MS - 1)).toBe(true);
    expect(shouldIgnoreOverlayBlur(1000, 1000 + OVERLAY_BLUR_GRACE_MS)).toBe(false);
    expect(shouldIgnoreOverlayBlur(1000, 2000)).toBe(false);
  });
});

describe("hwndFromHandle", () => {
  it("按指针宽度读 HWND：64 位 8 字节，32 位 4 字节", () => {
    const x64 = Buffer.alloc(8);
    x64.writeBigUInt64LE(0x00000000FFFEn, 0);
    expect(hwndFromHandle(x64)).toBe(0xfffen);
    const x86 = Buffer.alloc(4);
    x86.writeUInt32LE(0x12345678, 0);
    expect(hwndFromHandle(x86)).toBe(0x12345678n);
    expect(hwndFromHandle(Buffer.alloc(0))).toBeNull();
  });
});

describe("parseGuid", () => {
  it("按 Windows GUID 布局拆（Data1/2/3 是整数，Data4 是原始字节）", () => {
    const g = parseGuid("aa509086-5ca9-4c25-8f95-589d3c07b48a");
    expect(g.Data1).toBe(0xaa509086);
    expect(g.Data2).toBe(0x5ca9);
    expect(g.Data3).toBe(0x4c25);
    expect(g.Data4).toEqual([0x8f, 0x95, 0x58, 0x9d, 0x3c, 0x07, 0xb4, 0x8a]);
  });
});

describe("pinHwndToForegroundDesktop", () => {
  it("已经在当前桌面就不动，免得无谓改 HWND 归属", () => {
    let moved = 0;
    const ok = pinHwndToForegroundDesktop(0xaaaan, api({
      isOnCurrentDesktop: (h) => h === 0xaaaan,
      moveToDesktopOf: () => { moved++; return true; },
    }));
    expect(ok).toBe(true);
    expect(moved).toBe(0);
  });

  it("不在当前桌面 → 挪到前台窗口所在桌面（用户正在看的那一屏）", () => {
    const calls: Array<[bigint, bigint]> = [];
    const ok = pinHwndToForegroundDesktop(0xaaaan, api({
      getForegroundHwnd: () => 0x100n,
      isOnCurrentDesktop: () => false,
      moveToDesktopOf: (h, fg) => { calls.push([h, fg]); return true; },
    }));
    expect(ok).toBe(true);
    expect(calls).toEqual([[0xaaaan, 0x100n]]);
  });

  it("拿不到前台窗口或搬家失败 → false，调用方应重建窗口", () => {
    expect(pinHwndToForegroundDesktop(0xaaaan, api({ getForegroundHwnd: () => null }))).toBe(false);
    expect(pinHwndToForegroundDesktop(0xaaaan, api({ moveToDesktopOf: () => false }))).toBe(false);
  });

  it("IsWindowOnCurrentVirtualDesktop 查不出来时仍尝试搬家（API 对隐藏窗有时会失败）", () => {
    let moved = 0;
    const ok = pinHwndToForegroundDesktop(0xaaaan, api({
      isOnCurrentDesktop: () => null,
      moveToDesktopOf: () => { moved++; return true; },
    }));
    expect(ok).toBe(true);
    expect(moved).toBe(1);
  });
});

describe("captureForegroundFromApi", () => {
  it("前台是别人的窗口 → 记下 HWND，关掉弹窗时还回去", () => {
    const got = captureForegroundFromApi(api({
      getForegroundHwnd: () => 0xabcn,
      getPid: (h) => (h === 0xabcn ? 99 : 1),
    }), 1);
    expect(got).toEqual({ hwnd: 0xabcn });
  });

  it("前台已经是 Umbra 自己（主窗口/贴图）→ self，hide 时不要去抢别人", () => {
    const got = captureForegroundFromApi(api({
      getForegroundHwnd: () => 0x10n,
      getPid: () => 42,
    }), 42);
    expect(got).toEqual({ self: true });
  });

  it("没有前台窗口 → null", () => {
    expect(captureForegroundFromApi(api({ getForegroundHwnd: () => null }), 1)).toBeNull();
  });
});

describe("planHideOverlay", () => {
  const external: OverlayForeground = { hwnd: 0xabcn };
  const self: OverlayForeground = { self: true };

  it("macOS：唤起前不在 Umbra 里 → 先 app.hide() 再藏面板，焦点还给原应用", () => {
    expect(planHideOverlay({ platform: "darwin", appWasActive: false, saved: external, returnFocus: true }))
      .toEqual({ hideApp: true, restoreHwnd: null });
    expect(planHideOverlay({ platform: "darwin", appWasActive: true, saved: self, returnFocus: true }))
      .toEqual({ hideApp: false, restoreHwnd: null });
  });

  it("Windows：把焦点还给唤起前的 HWND，避免 hide 后落到另一桌面的贴图/主窗口", () => {
    expect(planHideOverlay({ platform: "win32", appWasActive: false, saved: external, returnFocus: true }))
      .toEqual({ hideApp: false, restoreHwnd: 0xabcn });
    expect(planHideOverlay({ platform: "win32", appWasActive: false, saved: self, returnFocus: true }))
      .toEqual({ hideApp: false, restoreHwnd: null });
    expect(planHideOverlay({ platform: "win32", appWasActive: false, saved: external, returnFocus: false }))
      .toEqual({ hideApp: false, restoreHwnd: null });
  });

  it("blur 收起（returnFocus=false）不要 restore，否则和正在抢焦点的窗口打架", () => {
    expect(planHideOverlay({ platform: "win32", appWasActive: false, saved: external, returnFocus: false }))
      .toEqual({ hideApp: false, restoreHwnd: null });
  });
});

describe("pinOverlayToCurrentDesktop", () => {
  it("非 Windows 直接成功（macOS/Linux 走 setVisibleOnAllWorkspaces）", () => {
    if (process.platform === "win32") return;
    expect(pinOverlayToCurrentDesktop({} as never)).toBe(true);
  });
});
