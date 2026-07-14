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
