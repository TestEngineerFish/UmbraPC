// 来源应用：前台应用名 + 路径（无 Rust 方案，用系统命令）；应用图标按路径缓存为 DataURL。
import { execFile } from "node:child_process";

function sh(cmd: string, args: string[], timeout = 3000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (_e, stdout) => resolve((stdout || "").trim()));
  });
}

export interface SourceApp {
  name?: string;
  path?: string;
}

// 当前前台应用名 + 路径。获取失败静默降级（返回空字段）。
export async function frontmostApp(): Promise<SourceApp> {
  try {
    if (process.platform === "darwin") {
      const name = await sh("osascript", ["-e", 'tell application "System Events" to name of first application process whose frontmost is true']);
      const path = await sh("osascript", ["-e", 'tell application "System Events" to POSIX path of application file of first application process whose frontmost is true']);
      return { name: name || undefined, path: path || undefined };
    }
    if (process.platform === "win32") {
      const ps = `Add-Type @"
using System;using System.Runtime.InteropServices;using System.Diagnostics;
public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);}
"@; $p=0;[W]::GetWindowThreadProcessId([W]::GetForegroundWindow(),[ref]$p);$pr=Get-Process -Id $p;Write-Output $pr.ProcessName;Write-Output $pr.Path`;
      const out = await sh("powershell", ["-NoProfile", "-Command", ps], 4000);
      const [name, path] = out.split(/\r?\n/);
      return { name: name?.trim() || undefined, path: path?.trim() || undefined };
    }
  } catch {
    /* 静默降级 */
  }
  return {};
}

// 应用图标缓存：路径 → DataURL。
const iconCache = new Map<string, string>();

export async function getAppIcon(appPath: string): Promise<string> {
  if (!appPath) return "";
  const cached = iconCache.get(appPath);
  if (cached !== undefined) return cached;
  let dataUrl = "";
  try {
    const { app, nativeImage } = await import("electron");
    let img: Electron.NativeImage | null = null;
    // macOS 的 .app 目录用 getFileIcon 常返回通用图标，优先用缩略图。
    if (process.platform === "darwin" && appPath.endsWith(".app")) {
      try {
        img = await nativeImage.createThumbnailFromPath(appPath, { width: 64, height: 64 });
      } catch {
        img = null;
      }
    }
    if (!img || img.isEmpty()) {
      const icon = await app.getFileIcon(appPath, { size: "normal" });
      img = icon;
    }
    if (img && !img.isEmpty()) dataUrl = img.toDataURL();
  } catch {
    dataUrl = "";
  }
  iconCache.set(appPath, dataUrl);
  return dataUrl;
}
