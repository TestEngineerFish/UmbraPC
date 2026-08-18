// macOS：[NSWindow isOnActiveSpace]。窗口在别的 Space 上时，isFocused() 仍可能为 true
// （用户只是 Control+← 切走、没点别的应用）。那种情况不能当成「人在 Umbra 里」。
import type { BrowserWindow } from "electron";

function viewPtr(win: BrowserWindow): bigint | null {
  try {
    const buf = win.getNativeWindowHandle();
    if (!buf || buf.length < 4) return null;
    if (buf.length >= 8) return buf.readBigUInt64LE(0);
    return BigInt(buf.readUInt32LE(0));
  } catch {
    return null;
  }
}

let impl: ((win: BrowserWindow) => boolean | null) | undefined;

export function isOnActiveSpace(win: BrowserWindow): boolean | null {
  if (process.platform !== "darwin") return null;
  if (impl === undefined) {
    try {
      impl = createObjcProbe();
    } catch (e) {
      console.warn("[overlay] isOnActiveSpace 不可用", e);
      impl = () => null;
    }
  }
  try {
    return impl(win);
  } catch {
    return null;
  }
}

function createObjcProbe(): (win: BrowserWindow) => boolean | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require("koffi") as {
    load: (name: string) => { func: (sig: string) => (...args: unknown[]) => unknown };
  };
  const objc = koffi.load("/usr/lib/libobjc.A.dylib");
  const sel_registerName = objc.func("void *sel_registerName(const char *name)");
  const msgId = objc.func("void *objc_msgSend(void *self, void *op)");
  const msgBool = objc.func("uint8 objc_msgSend(void *self, void *op)");
  const selWindow = sel_registerName("window");
  const selOnSpace = sel_registerName("isOnActiveSpace");
  return (win: BrowserWindow) => {
    const view = viewPtr(win);
    if (view == null || view === 0n) return null;
    const nsWin = msgId(view, selWindow);
    if (!nsWin) return null;
    return msgBool(nsWin, selOnSpace) !== 0;
  };
}
