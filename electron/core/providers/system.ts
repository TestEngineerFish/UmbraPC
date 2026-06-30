// system Provider：设备自身（OS 级）能力——截图、文件操作。始终可用。
// 对齐 Python prov_system.py + file_system.py + screenshot.py。
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../util";
import { uploadFile } from "../upload";
import { httpBase, UmbraConfig } from "../config";
import { Manifest, Registry } from "../registry";

function expand(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

// 递归遍历目录，收集文件（跳过常见噪声目录），最多 limit 条。
async function walkFiles(base: string, match: (name: string) => boolean, limit: number): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set([".git", "node_modules", "__pycache__", ".venv", "Library"]);
  async function rec(dir: string): Promise<void> {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name) && !e.name.startsWith(".")) await rec(full);
      } else if (e.isFile() && match(e.name)) {
        out.push(full);
      }
    }
  }
  await rec(base);
  return out;
}

// 通配符 → 正则（支持 * 与 ?）。
function globToRe(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

const FS_ALIASES: Record<string, string> = { find: "find_file", read: "read_file", upload: "upload_file", list: "list_directory" };

async function fileSystem(action: string, params: Record<string, any>, cfg: UmbraConfig): Promise<unknown> {
  const a = FS_ALIASES[action] || action;

  if (a === "find_file") {
    const base = expand(String(params.path || "~"));
    const re = globToRe(String(params.pattern || "*"));
    const matches = await walkFiles(base, (n) => re.test(n), 20);
    return { found: matches.length > 0, matches };
  }
  if (a === "read_file") {
    const p = expand(String(params.path));
    const maxBytes = Number(params.max_bytes || 8192);
    let buf: Buffer;
    try {
      buf = await fs.readFile(p);
    } catch {
      throw new Error(`文件不存在：${p}`);
    }
    const slice = buf.subarray(0, maxBytes);
    const text = slice.toString("utf-8");
    if (text.includes("�") && buf.length > 0) throw new Error("该文件可能为二进制文件，请使用 upload_file 上传");
    return { content: text, truncated: buf.length > maxBytes };
  }
  if (a === "upload_file") {
    const p = expand(String(params.path));
    try {
      await fs.access(p);
    } catch {
      throw new Error(`文件不存在：${p}`);
    }
    return uploadFile(httpBase(cfg), cfg.token, p);
  }
  if (a === "list_directory") {
    const base = expand(String(params.path || "~"));
    let entries;
    try {
      entries = await fs.readdir(base, { withFileTypes: true });
    } catch {
      throw new Error(`不是目录或不可读：${base}`);
    }
    const rows = await Promise.all(
      entries.slice(0, 50).map(async (e) => {
        let size = 0;
        if (e.isFile()) {
          try {
            size = (await fs.stat(path.join(base, e.name))).size;
          } catch {
            /* ignore */
          }
        }
        return { name: e.name, is_dir: e.isDirectory(), size };
      }),
    );
    return { entries: rows };
  }
  throw new Error(`未知 file_system action：${action}`);
}

async function capture(cfg: UmbraConfig): Promise<unknown> {
  const tmp = path.join(os.tmpdir(), `umbra-shot-${Date.now()}.png`);
  const plat = process.platform;
  let res;
  if (plat === "darwin") res = await run("screencapture", ["-x", tmp]);
  else if (plat === "linux") res = await run("scrot", [tmp]);
  else if (plat === "win32") res = await run("powershell", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${tmp.replace(/\\/g, "\\\\")}')`]);
  else throw new Error(`不支持的平台：${plat}`);
  if (res.code !== 0) throw new Error(`截图失败：${res.output.slice(-200)}`);
  const up = await uploadFile(httpBase(cfg), cfg.token, tmp, "screenshot.png", "image/png");
  fs.unlink(tmp).catch(() => {});
  return up;
}

const FS_SKILLS: Manifest["skills"] = {
  find_file: { description: "在某目录下递归查找匹配文件", params: { path: "起始目录，如 ~/Desktop", pattern: "通配符，如 *.pdf" } },
  read_file: { description: "读取文本文件内容", params: { path: "文件路径", max_bytes: "可选，最多读取字节数" } },
  upload_file: { description: "上传指定文件到服务端并返回下载链接", params: { path: "文件路径" } },
  list_directory: { description: "列出目录下的条目", params: { path: "目录路径" } },
};
const SHOT_SKILLS: Manifest["skills"] = {
  capture: { description: "截取整个屏幕，上传后返回图片链接", params: {} },
};

// 注册 system Provider 到 registry。
export function registerSystem(r: Registry, cfg: UmbraConfig): void {
  const manifest: Manifest = {
    provider: "system",
    display_name: "系统",
    kind: "system",
    available: true,
    unavailable_reason: "",
    version: null,
    skills: { ...SHOT_SKILLS, ...FS_SKILLS },
  };
  r.register(manifest, async (skill, params) => {
    if (skill === "capture") return capture(cfg);
    if (skill in FS_SKILLS || skill in FS_ALIASES) return fileSystem(skill, params, cfg);
    throw new Error(`system 不支持技能：${skill}`);
  });
}
