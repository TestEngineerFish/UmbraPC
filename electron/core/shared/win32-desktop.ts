// Windows 虚拟桌面 + 前台窗口。只在 win32 上真正 load koffi；其它平台 getWin32DesktopApi() 返回 null。
//
// IVirtualDesktopManager 是 Win10+ 公开 COM：把我们自己的 HWND 挪到「当前前台窗口」所在桌面，
// 这样 show() 不会把用户从桌面 3 拽回预热窗口创建时的桌面 1。
export interface GuidParts {
  Data1: number;
  Data2: number;
  Data3: number;
  Data4: number[];
}

export function parseGuid(s: string): GuidParts {
  const p = s.trim().split("-");
  if (p.length !== 5) throw new Error(`bad GUID: ${s}`);
  const d4 = Buffer.from(`${p[3]}${p[4]}`, "hex");
  if (d4.length !== 8) throw new Error(`bad GUID: ${s}`);
  return {
    Data1: parseInt(p[0], 16) >>> 0,
    Data2: parseInt(p[1], 16) & 0xffff,
    Data3: parseInt(p[2], 16) & 0xffff,
    Data4: [...d4],
  };
}

export interface Win32DesktopApi {
  getForegroundHwnd(): bigint | null;
  getPid(hwnd: bigint): number | null;
  isOnCurrentDesktop(hwnd: bigint): boolean | null;
  moveToDesktopOf(hwnd: bigint, desktopOwnerHwnd: bigint): boolean;
  setForeground(hwnd: bigint): boolean;
}

let cached: Win32DesktopApi | null | undefined;
let testOverride: Win32DesktopApi | null | undefined;

export function getWin32DesktopApi(): Win32DesktopApi | null {
  if (testOverride !== undefined) return testOverride;
  if (cached !== undefined) return cached;
  if (process.platform !== "win32") {
    cached = null;
    return null;
  }
  try {
    cached = createKoffiApi();
  } catch (e) {
    console.warn("[overlay] Windows 虚拟桌面 API 不可用，将重建弹窗", e);
    cached = null;
  }
  return cached;
}

/** 单测注入；传 undefined 恢复真实加载。 */
export function _setWin32DesktopApiForTests(api: Win32DesktopApi | null | undefined): void {
  testOverride = api;
  if (api === undefined) cached = undefined;
}

function createKoffiApi(): Win32DesktopApi {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require("koffi") as Koffi;
  const user32 = koffi.load("user32.dll");
  const ole32 = koffi.load("ole32.dll");
  const kernel32 = koffi.load("kernel32.dll");

  koffi.struct("GUID", {
    Data1: "uint32",
    Data2: "uint16",
    Data3: "uint16",
    Data4: koffi.array("uint8", 8),
  });

  const GetForegroundWindow = user32.func("void * __stdcall GetForegroundWindow()");
  const SetForegroundWindow = user32.func("bool __stdcall SetForegroundWindow(void *hWnd)");
  const BringWindowToTop = user32.func("bool __stdcall BringWindowToTop(void *hWnd)");
  const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)");
  const AttachThreadInput = user32.func("bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)");
  const GetCurrentThreadId = kernel32.func("uint32 __stdcall GetCurrentThreadId()");
  const AllowSetForegroundWindow = user32.func("bool __stdcall AllowSetForegroundWindow(uint32 dwProcessId)");

  const CoInitializeEx = ole32.func("long __stdcall CoInitializeEx(void *reserved, uint32 dwCoInit)");
  const CoCreateInstance = ole32.func("long __stdcall CoCreateInstance(GUID *clsid, void *outer, uint32 ctx, GUID *iid, _Out_ void **ppv)");

  const hrInit = asHr(CoInitializeEx(null, 0x2)); // COINIT_APARTMENTTHREADED
  if (hrInit < 0 && (hrInit >>> 0) !== 0x80010106) {
    throw new Error(`CoInitializeEx 0x${(hrInit >>> 0).toString(16)}`);
  }

  const clsid = guidToKoffi(parseGuid("aa509086-5ca9-4c25-8f95-589d3c07b48a"));
  const iid = guidToKoffi(parseGuid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"));
  const ppv: Array<unknown> = [null];
  const hr = asHr(CoCreateInstance(clsid, null, 1, iid, ppv)); // CLSCTX_INPROC_SERVER
  if (hr < 0 || !ppv[0]) throw new Error(`CoCreateInstance IVirtualDesktopManager 0x${(hr >>> 0).toString(16)}`);
  const obj = ppv[0];

  const Vtbl = koffi.struct("IVirtualDesktopManagerVtbl", {
    QueryInterface: "void *",
    AddRef: "void *",
    Release: "void *",
    IsWindowOnCurrentVirtualDesktop: "void *",
    GetWindowDesktopId: "void *",
    MoveWindowToDesktop: "void *",
  });
  const lpVtbl = koffi.decode(obj, "void *");
  const vtbl = koffi.decode(lpVtbl, Vtbl) as {
    IsWindowOnCurrentVirtualDesktop: unknown;
    GetWindowDesktopId: unknown;
    MoveWindowToDesktop: unknown;
  };

  const IsOnCurrent = koffi.decode(
    vtbl.IsWindowOnCurrentVirtualDesktop,
    koffi.proto("long __stdcall (void *self, void *hwnd, _Out_ int *onCurrent)"),
  ) as (self: unknown, hwnd: bigint, out: number[]) => number;
  const GetDesktopId = koffi.decode(
    vtbl.GetWindowDesktopId,
    koffi.proto("long __stdcall (void *self, void *hwnd, _Out_ GUID *desktop)"),
  ) as (self: unknown, hwnd: bigint, out: unknown[]) => number;
  const MoveToDesktop = koffi.decode(
    vtbl.MoveWindowToDesktop,
    koffi.proto("long __stdcall (void *self, void *hwnd, GUID *desktop)"),
  ) as (self: unknown, hwnd: bigint, desktop: unknown) => number;

  const ptr = (h: bigint) => h;

  return {
    getForegroundHwnd(): bigint | null {
      const h = GetForegroundWindow() as bigint | null;
      if (h == null || h === 0n) return null;
      return asHwnd(h);
    },
    getPid(hwnd: bigint): number | null {
      const pid = [0];
      GetWindowThreadProcessId(ptr(hwnd), pid);
      return pid[0] || null;
    },
    isOnCurrentDesktop(hwnd: bigint): boolean | null {
      const out = [0];
      const r = IsOnCurrent(obj, ptr(hwnd), out);
      if (r < 0) return null;
      return out[0] !== 0;
    },
    moveToDesktopOf(hwnd: bigint, desktopOwnerHwnd: bigint): boolean {
      const desktop: unknown[] = [guidToKoffi(parseGuid("00000000-0000-0000-0000-000000000000"))];
      const r1 = GetDesktopId(obj, ptr(desktopOwnerHwnd), desktop);
      if (r1 < 0 || !desktop[0]) return false;
      const r2 = MoveToDesktop(obj, ptr(hwnd), desktop[0]);
      return r2 >= 0;
    },
    setForeground(hwnd: bigint): boolean {
      try {
        AllowSetForegroundWindow(0xffffffff); // ASFW_ANY
      } catch {
        /* 旧系统没有也无妨 */
      }
      const target = ptr(hwnd);
      const fg = GetForegroundWindow() as bigint | null;
      const curTid = GetCurrentThreadId() as number;
      const fgTid = fg && asHwnd(fg) !== 0n ? (GetWindowThreadProcessId(fg, [0]) as number) : 0;
      const targetTid = GetWindowThreadProcessId(target, [0]) as number;
      if (fgTid && fgTid !== curTid) AttachThreadInput(curTid, fgTid, true);
      if (targetTid && targetTid !== curTid) AttachThreadInput(curTid, targetTid, true);
      const ok = !!SetForegroundWindow(target);
      BringWindowToTop(target);
      if (targetTid && targetTid !== curTid) AttachThreadInput(curTid, targetTid, false);
      if (fgTid && fgTid !== curTid) AttachThreadInput(curTid, fgTid, false);
      return ok;
    },
  };
}

function guidToKoffi(g: GuidParts): { Data1: number; Data2: number; Data3: number; Data4: number[] } {
  return { Data1: g.Data1, Data2: g.Data2, Data3: g.Data3, Data4: g.Data4 };
}

function asHr(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function asHwnd(h: bigint | number | unknown): bigint {
  if (typeof h === "bigint") return h;
  if (typeof h === "number") return BigInt(h >>> 0);
  return 0n;
}

// koffi 没有稳定的公开 TS 类型，这里只声明我们用到的那一小撮。
interface Koffi {
  load: (name: string) => {
    func: (sig: string) => (...args: unknown[]) => unknown;
  };
  struct: (name: string, fields: Record<string, unknown>) => unknown;
  array: (type: string, n: number) => unknown;
  decode: (value: unknown, type: unknown) => unknown;
  proto: (sig: string) => unknown;
}
