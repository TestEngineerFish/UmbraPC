// 写回剪贴板 + 模拟粘贴（无 Rust 方案：系统命令）。未授权/不可用时降级为仅复制。
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as fssync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClipItem } from "./store";

// macOS：把文件路径写成 NSFilenamesPboardType（Finder / 支持文件粘贴的应用可直接粘贴文件）。
function writeFilesMac(clipboard: Electron.Clipboard, paths: string[]): void {
  const items = paths.map((p) => `\t<string>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`).join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<array>\n${items}\n</array>\n</plist>`;
  clipboard.writeBuffer("NSFilenamesPboardType", Buffer.from(plist, "utf-8"));
}

// 把条目内容写回系统剪贴板。
export async function writeToClipboard(it: ClipItem): Promise<void> {
  const { clipboard, nativeImage } = await import("electron");

  if (it.type === "image") {
    if (process.platform === "darwin") {
      // 关键：写文件引用而非位图，才能粘贴到 Finder 目录 / 大多数支持图片的应用。
      let filePath = it.sourcePath && fssync.existsSync(it.sourcePath) ? it.sourcePath : it.content;
      if (!it.sourcePath) {
        // 位图（截图等）：复制到临时文件给个友好文件名再引用。
        // 文件名用内容 hash 而不是时间戳 —— 同一张图每次写回都是同一个路径，
        // 监听器算出的 hash 才稳定，配合 syncBaseline 才不会重复入库。
        const tmp = path.join(os.tmpdir(), `Umbra-${it.hash.slice(0, 12)}.png`);
        try {
          await fs.copyFile(it.content, tmp);
          filePath = tmp;
        } catch {
          /* 用原路径兜底 */
        }
      }
      if (fssync.existsSync(filePath)) writeFilesMac(clipboard, [filePath]);
    } else {
      const img = nativeImage.createFromPath(it.content);
      if (!img.isEmpty()) clipboard.writeImage(img);
    }
    return;
  }

  if (it.type === "files") {
    let paths: string[] = [];
    try {
      paths = JSON.parse(it.content);
    } catch {
      paths = [it.content];
    }
    if (process.platform === "darwin") writeFilesMac(clipboard, paths);
    else clipboard.writeText(paths.join("\n")); // 非 mac 写回路径文本
    return;
  }

  clipboard.writeText(it.content);
}

// ── System Events 保活（2026-09-03 验收第四轮，sam：工作流热键要等 2~3 秒）─────
//
// simulateCopy / simulatePaste / 工作流的前台应用查询全走 osascript 的
// "System Events"。这个系统进程**空闲几分钟就自动退出**，下一次 AppleEvent 得先把它
// 冷启动起来 —— 实测一次 keystroke 冷的时候 1~2 秒，这就是「热键按下去等半天」的大头
// （剩下的是 osascript 进程本身 ~0.2s，省不掉）。
// 保活：每 4 分钟发一个最便宜的查询（count processes，不需要辅助功能授权），
// 让它一直热着。代价是每 4 分钟一次 ~10ms 的系统调用，可忽略。
// 失败静默 —— 保活挂了只是回到「第一下慢」，不是故障。
let seAliveTimer: NodeJS.Timeout | undefined;
export function keepSystemEventsAlive(): void {
  if (process.platform !== "darwin" || seAliveTimer) return;
  const ping = () => {
    try {
      execFile("osascript", ["-e", 'tell application "System Events" to count processes'],
        { timeout: 5000 }, () => { /* 结果不重要，把它叫醒就行 */ });
    } catch { /* 静默 */ }
  };
  ping();
  seAliveTimer = setInterval(ping, 4 * 60_000);
  seAliveTimer.unref?.();   // 别拦着进程退出
}

// 模拟 Cmd/Ctrl+C（W4 Universal Action）：让前台应用把当前选中的东西写进剪贴板。
// 和 simulatePaste 一样依赖辅助功能授权，未授权/非 mac/win 一律返回 false，由调用方决定怎么兜底。
export async function simulateCopy(): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      const { systemPreferences } = await import("electron");
      if (!systemPreferences.isTrustedAccessibilityClient(false)) return false; // 未授权 → 抓不到选区
      await new Promise<void>((resolve, reject) => {
        execFile("osascript", ["-e", 'tell application "System Events" to keystroke "c" using command down'], { timeout: 4000 }, (e) => (e ? reject(e) : resolve()));
      });
      return true;
    }
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "powershell",
          ["-NoProfile", "-Command", 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^c")'],
          { timeout: 4000 },
          (e) => (e ? reject(e) : resolve()),
        );
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

// 模拟 Cmd/Ctrl+V。返回是否成功触发按键（失败即降级为仅复制）。
export async function simulatePaste(): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      const { systemPreferences } = await import("electron");
      if (!systemPreferences.isTrustedAccessibilityClient(false)) return false; // 未授权 → 降级
      await new Promise<void>((resolve, reject) => {
        execFile("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down'], { timeout: 4000 }, (e) => (e ? reject(e) : resolve()));
      });
      return true;
    }
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "powershell",
          ["-NoProfile", "-Command", 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^v")'],
          { timeout: 4000 },
          (e) => (e ? reject(e) : resolve()),
        );
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

// ── 任意按键组合 ────────────────────────────────────────────────────────────
// 工作流的「发送按键」节点用。键位串沿用应用里录快捷键的那套格式（Command+Shift+K），
// 用户在别处录到什么就能在这里填什么，不用再学一套写法。
//
// macOS 上分两条路：单个可打印字符走 keystroke，功能键走 key code。
// 这是 System Events 的硬约束 —— keystroke "Return" 会真的把 R-e-t-u-r-n 六个字母打出去。
const MAC_KEY_CODES: Record<string, number> = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51,
  escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121, forwarddelete: 117,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
};
// Windows 的 SendKeys 写法：修饰键是符号前缀，功能键是花括号名。
const WIN_MODS: Record<string, string> = { command: "^", control: "^", alt: "%", shift: "+" };
const WIN_KEYS: Record<string, string> = {
  return: "{ENTER}", enter: "{ENTER}", tab: "{TAB}", space: " ", delete: "{BACKSPACE}",
  backspace: "{BACKSPACE}", escape: "{ESC}", esc: "{ESC}", left: "{LEFT}", right: "{RIGHT}",
  down: "{DOWN}", up: "{UP}", home: "{HOME}", end: "{END}", pageup: "{PGUP}", pagedown: "{PGDN}",
  forwarddelete: "{DEL}",
};

// 把 "Command+Shift+K" 拆成修饰键集合与主键。主键统一小写。
// 单独抽出来是为了能单测：拆错一个键位，表现是「按了没反应」，最难查。
export function parseAccelerator(accel: string): { mods: string[]; key: string } | null {
  const parts = String(accel || "").split("+").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const key = (parts.pop() || "").toLowerCase();
  if (!key) return null;
  const mods: string[] = [];
  for (const p of parts) {
    const m = p.toLowerCase();
    // CommandOrControl / Cmd / Opt 这些别名都归一，Electron 的录制器会产出其中几种
    const norm = m === "cmd" || m === "commandorcontrol" ? "command"
      : m === "opt" || m === "option" ? "alt"
      : m === "ctrl" ? "control" : m;
    if (["command", "control", "alt", "shift"].includes(norm) && !mods.includes(norm)) mods.push(norm);
  }
  return { mods, key };
}

// 向前台应用发一组按键。返回 {ok, error}：失败原因要能带给用户看
// —— 「按了没反应」和「没有辅助功能权限」在界面上必须能区分开。
export async function simulateKeyCombo(accel: string): Promise<{ ok: boolean; error: string }> {
  const parsed = parseAccelerator(accel);
  if (!parsed) return { ok: false, error: "键位为空或格式不对" };
  const { mods, key } = parsed;
  try {
    if (process.platform === "darwin") {
      const { systemPreferences } = await import("electron");
      if (!systemPreferences.isTrustedAccessibilityClient(false)) {
        return { ok: false, error: "没有辅助功能权限，无法向其它应用发送按键" };
      }
      const code = MAC_KEY_CODES[key];
      // 只有单个字符能走 keystroke；多字符又不在功能键表里的，说明填了个我们不认识的键
      if (code === undefined && [...key].length !== 1) {
        return { ok: false, error: `不认识的按键：${key}` };
      }
      const using = mods.length ? ` using {${mods.map((m) => `${m} down`).join(", ")}}` : "";
      const body = code !== undefined
        ? `key code ${code}${using}`
        : `keystroke "${key.replace(/["\\]/g, "\\$&")}"${using}`;
      await new Promise<void>((resolve, reject) => {
        execFile("osascript", ["-e", `tell application "System Events" to ${body}`], { timeout: 4000 },
          (e) => (e ? reject(e) : resolve()));
      });
      return { ok: true, error: "" };
    }
    if (process.platform === "win32") {
      const prefix = mods.map((m) => WIN_MODS[m] || "").join("");
      const main = WIN_KEYS[key] || ([...key].length === 1 ? key : "");
      if (!main) return { ok: false, error: `不认识的按键：${key}` };
      const seq = prefix + main;
      await new Promise<void>((resolve, reject) => {
        execFile("powershell",
          ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${seq}")`],
          { timeout: 4000 }, (e) => (e ? reject(e) : resolve()));
      });
      return { ok: true, error: "" };
    }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 120) };
  }
  return { ok: false, error: "当前系统不支持模拟按键" };
}
