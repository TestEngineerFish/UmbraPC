// system Provider：设备自身（OS 级）能力——截图、文件操作。始终可用。
// 对齐 Python prov_system.py + file_system.py + screenshot.py。
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../shared/util";
import { uploadFile } from "../shared/upload";
import { httpBase, UmbraConfig } from "../config";
import { Manifest, Registry } from "./registry";

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
  if (a === "write_file") {
    const p = expand(String(params.path || ""));
    if (!p) throw new Error("缺少 path");
    // 只允许写工作区内 —— 秘书写需求文档是正当需求，但不能因此获得「改你任何文件」的权力。
    const worksRoot = path.resolve(expand(cfg.workspacesDir || "~/UmbraWorks"));
    const target = path.resolve(p);
    if (target !== worksRoot && !target.startsWith(worksRoot + path.sep)) {
      throw new Error(`只允许写入工作区内（${worksRoot}），拒绝：${target}`);
    }
    const content = String(params.content ?? "");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf-8");
    return { path: target, bytes: Buffer.byteLength(content, "utf-8") };
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

  if (a === "delete_path") {
    const p = expand(String(params.path || ""));
    if (!p) throw new Error("缺少 path");
    // 硬护栏：只允许删除工作区**内部**的目录/文件（且不能是工作区根本身），防 rm -rf 灾难。
    const worksRoot = path.resolve(expand(cfg.workspacesDir || "~/UmbraWorks"));
    const target = path.resolve(p);
    if (target === worksRoot || !target.startsWith(worksRoot + path.sep)) {
      throw new Error(`只允许删除工作区内（${worksRoot}）的子目录/文件，拒绝：${target}`);
    }
    await fs.rm(target, { recursive: true, force: true });
    return { path: target, deleted: true };
  }
  throw new Error(`未知 file_system action：${action}`);
}

// 查某个应用是否已安装（供 operate 规划时预检）。macOS 用 mdfind + 标准目录；其它平台尽力而为。
// 当前前台应用名（供服务端在 open 后轮询等待应用真正到前台/初始化好再操作）。
async function frontmostApp(): Promise<unknown> {
  if (process.platform !== "darwin") return { app: "" };
  const res = await run("osascript", ["-e", 'tell application "System Events" to name of first application process whose frontmost is true'], { timeoutMs: 4000 });
  return { app: (res.output || "").trim() };
}

async function appExists(params: Record<string, any>): Promise<unknown> {
  const name = String(params.app || "").trim();
  if (!name) throw new Error("缺少 app 名称");
  const plat = process.platform;
  const matches: string[] = [];
  const push = (p: string) => { const s = p.trim(); if (s && !matches.includes(s)) matches.push(s); };

  if (plat === "darwin") {
    // 1) 按应用包文件名精确找
    let res = await run("mdfind", [`kMDItemContentType == 'com.apple.application-bundle' && kMDItemFSName == '${name}.app'c`]);
    if (res.code === 0) res.output.split("\n").forEach(push);
    // 2) 找不到再按显示名模糊找
    if (matches.length === 0) {
      res = await run("mdfind", [`kMDItemContentType == 'com.apple.application-bundle' && kMDItemDisplayName == '${name}*'c`]);
      if (res.code === 0) res.output.split("\n").slice(0, 10).forEach(push);
    }
    // 3) 标准目录兜底
    for (const base of ["/Applications", path.join(os.homedir(), "Applications")]) {
      const p = path.join(base, `${name}.app`);
      try { await fs.access(p); push(p); } catch { /* not there */ }
    }
  } else {
    const res = await run(plat === "win32" ? "where" : "which", [name]);
    if (res.code === 0) res.output.split("\n").forEach(push);
  }
  return { exists: matches.length > 0, matches: matches.slice(0, 10) };
}

// AX 探针：dump 指定应用前台窗口的 Accessibility 元素树，并单独列出文本输入框与按钮。
// 用于判断能否走「AX 精确操作」（找到输入框/发送键）而不是靠视觉猜坐标。
async function axDump(params: Record<string, any>): Promise<unknown> {
  if (process.platform !== "darwin") throw new Error("ax_dump 仅支持 macOS");
  const app = String(params.app || "").trim();
  if (!app) throw new Error("缺少 app 名称");
  const maxDepth = Math.max(1, Math.min(Number(params.max_depth || 10), 14));
  // JXA：遍历 AX 树，收集角色/名字/值/位置，并把文本框、按钮拎成扁平列表。
  const jxa = `
    function run() {
      ObjC.import('Foundation');
      const appName = ${JSON.stringify(app)};
      const MAX_DEPTH = ${maxDepth}, MAX_NODES = 500;
      const se = Application('System Events');
      let count = 0, truncated = false, a11yEnabled = false;
      const inputs = [], buttons = [];
      const safe = (fn) => { try { return fn(); } catch(e) { return null; } };
      function node(el, depth) {
        if (count >= MAX_NODES) { truncated = true; return null; }
        count++;
        const role = safe(() => el.role());
        const name = safe(() => el.name()) || safe(() => el.title()) || safe(() => el.description());
        let value = safe(() => el.value());
        if (typeof value === 'string') value = value.slice(0, 100);
        const pos = safe(() => el.position()); const size = safe(() => el.size());
        const focused = safe(() => el.focused());
        const flat = { role, name, value, pos, size, focused };
        if (role === 'AXTextField' || role === 'AXTextArea' || role === 'AXComboBox' || role === 'AXSearchField') inputs.push(flat);
        if (role === 'AXButton' && name) buttons.push({ role, name, pos, size });
        const o = { role, subrole: safe(() => el.subrole()), name, value, focused };
        if (depth < MAX_DEPTH) {
          const kids = safe(() => el.uiElements()) || [];
          const arr = [];
          for (let i = 0; i < kids.length; i++) {
            if (count >= MAX_NODES) { truncated = true; break; }
            const c = node(kids[i], depth + 1);
            if (c) arr.push(c);
          }
          if (arr.length) o.children = arr;
        }
        return o;
      }
      let proc;
      try { proc = se.processes.byName(appName); proc.name(); }
      catch (e) { return JSON.stringify({ error: '找不到进程：' + appName + '（应用是否已打开？名字是否正确？）' }); }
      // 关键：Electron/Chromium 默认不建可访问性树；设这两个属性可强制它按需构建。
      try { proc.attributes.byName('AXManualAccessibility').value = true; a11yEnabled = true; } catch (e) {}
      try { proc.attributes.byName('AXEnhancedUserInterface').value = true; a11yEnabled = true; } catch (e) {}
      $.NSThread.sleepForTimeInterval(1.0);  // 等 Chromium 构建 a11y 树
      const wins = safe(() => proc.windows()) || [];
      if (!wins.length) return JSON.stringify({ error: appName + ' 没有可见窗口（未打开或最小化）' });
      const tree = node(wins[0], 0);
      return JSON.stringify({ app: appName, window: safe(() => wins[0].name()), a11yEnabled, nodeCount: count, truncated, inputs, buttons, tree });
    }
  `;
  const res = await run("osascript", ["-l", "JavaScript", "-e", jxa], { timeoutMs: 20000 });
  if (res.code !== 0) throw new Error(`ax_dump 失败（可能缺辅助功能权限）：${res.output.slice(-300)}`);
  try {
    return JSON.parse(res.output.trim());
  } catch {
    return { raw: res.output.slice(0, 6000) };
  }
}

// 带坐标的 OCR（macOS Vision）：返回每段文字 + 归一化中心坐标(0-1000, 左上原点)。
// 用于 Set-of-Mark：让视觉模型「按编号选文字」而不是猜像素。
const OCR_BOXES_JXA = `
ObjC.import('Vision'); ObjC.import('AppKit');
function run() {
  var p = $.NSProcessInfo.processInfo.environment.objectForKey('UMBRA_OCR_PATH').js;
  var img = $.NSImage.alloc.initWithContentsOfFile(p);
  if (!img) return '[]';
  var rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
  var cg = rep.CGImage;
  var req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = 1; req.usesLanguageCorrection = true;
  req.recognitionLanguages = $(['zh-Hans','zh-Hant','ja','en']);
  var handler = $.VNImageRequestHandler.alloc.initWithCGImageOptions(cg, $({}));
  if (!handler.performRequestsError($([req]), null)) return '[]';
  var results = req.results, out = [];
  for (var i = 0; i < results.count; i++) {
    var obs = results.objectAtIndex(i);
    var cand = obs.topCandidates(1);
    if (cand.count === 0) continue;
    var text = cand.objectAtIndex(0).string.js;
    var bb = obs.boundingBox;  // 归一化, 左下原点
    var cx = bb.origin.x + bb.size.width / 2;
    var cyBottom = bb.origin.y + bb.size.height / 2;
    out.push({ text: text, nx: Math.round(cx * 1000), ny: Math.round((1 - cyBottom) * 1000) });
  }
  return JSON.stringify(out);
}
`;

async function ocrBoxes(imgPath: string): Promise<{ text: string; nx: number; ny: number }[]> {
  const scriptPath = path.join(os.tmpdir(), `umbra-ocrbox-${Date.now()}.js`);
  await fs.writeFile(scriptPath, OCR_BOXES_JXA, "utf-8");
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        "osascript",
        ["-l", "JavaScript", scriptPath],
        { timeout: 20000, env: { ...process.env, UMBRA_OCR_PATH: imgPath }, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout || "[]")),
      );
    });
    return JSON.parse(out.trim() || "[]");
  } catch {
    return [];
  } finally {
    fs.rm(scriptPath, { force: true }).catch(() => {});
  }
}

// 截屏 + 带坐标 OCR：返回截图链接/file_id + 文字元素列表（供 Set-of-Mark 视觉定位）。
async function ocrScreen(cfg: UmbraConfig): Promise<unknown> {
  if (process.platform !== "darwin") throw new Error("ocr_screen 仅支持 macOS");
  const tmp = path.join(os.tmpdir(), `umbra-ocrshot-${Date.now()}.png`);
  const res = await run("screencapture", ["-x", tmp]);
  if (res.code !== 0) throw new Error(`截图失败：${res.output.slice(-200)}`);
  const items = await ocrBoxes(tmp);              // 全分辨率 OCR 更准
  await run("sips", ["-Z", "1600", tmp]).catch(() => undefined);  // 下采样再上传/喂视觉
  const up = await uploadFile(httpBase(cfg), cfg.token, tmp, "screen.png", "image/png");
  fs.unlink(tmp).catch(() => {});
  return { ...up, count: items.length, items };
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

// 用系统默认程序打开文件/目录/网址（macOS: open / Windows: start / Linux: xdg-open）。
// 不经 shell（spawn argv），避免命令注入；网址只放行 http(s)。
async function openPath(params: Record<string, any>): Promise<unknown> {
  const raw = String(params.path || params.target || "").trim();
  if (!raw) throw new Error("缺少 path（要打开的文件/目录/网址）");

  const isUrl = /^https?:\/\//i.test(raw);
  if (!isUrl && /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new Error(`只允许打开本地路径或 http(s) 网址：${raw}`);
  }
  const target = isUrl ? raw : expand(raw);
  if (!isUrl) {
    try {
      await fs.access(target);
    } catch {
      throw new Error(`路径不存在：${target}`);
    }
  }

  const plat = process.platform;
  const cmd = plat === "darwin" ? "open" : plat === "win32" ? "cmd" : "xdg-open";
  const args = plat === "win32" ? ["/c", "start", "", target] : [target];
  const res = await run(cmd, args, { timeoutMs: 15_000 });
  if (res.code !== 0 && res.code !== null) {
    throw new Error(`打开失败（exit=${res.code}）：${res.output.slice(-200)}`);
  }
  return { opened: target, kind: isUrl ? "url" : "path" };
}

const FS_SKILLS: Manifest["skills"] = {
  find_file: { description: "在某目录下递归查找匹配文件", params: { path: "起始目录，如 ~/Desktop", pattern: "通配符，如 *.pdf" } },
  read_file: { description: "读取文本文件内容", params: { path: "文件路径", max_bytes: "可选，最多读取字节数" } },
  write_file: { description: "写入文本文件（覆盖）。用于落需求文档等；只允许写工作区(~/UmbraWorks)内", params: { path: "文件路径", content: "文本内容" } },
  upload_file: { description: "上传指定文件到服务端并返回下载链接", params: { path: "文件路径" } },
  list_directory: { description: "列出目录下的条目", params: { path: "目录路径" } },
  delete_path: { description: "删除工作区内的子目录/文件（移除工作区并清理文件时用；只允许 ~/UmbraWorks 内）", params: { path: "要删除的路径" } },
};
const SHOT_SKILLS: Manifest["skills"] = {
  capture: { description: "截取整个屏幕，上传后返回图片链接", params: {} },
  ocr_screen: { description: "截屏 + 带坐标 OCR：返回图片链接与每段文字的归一化中心坐标，用于精确定位", params: {} },
};
const APP_SKILLS: Manifest["skills"] = {
  // 打开文件/目录/网址：一条命令的事，别让 GUI agent 去 Finder 里翻箱倒柜找图标双击。
  open_path: {
    description: "用系统默认方式打开文件/目录/网址（等价于双击；比 GUI 操作可靠得多，优先用它）",
    params: { path: "文件或目录的绝对路径，或 http(s) 网址" },
  },
  app_exists: { description: "检查某个应用是否已安装（返回 exists 与匹配路径）", params: { app: "应用名，如 Claude" } },
  frontmost_app: { description: "返回当前前台应用名（{app}），用于判断某应用是否已在前台/初始化就绪", params: {} },
  ax_dump: { description: "导出某应用前台窗口的界面元素结构(Accessibility)，含输入框与按钮列表，用于判断能否精确操作", params: { app: "应用名，如 Claude", max_depth: "可选，遍历深度(默认10)" } },
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
    skills: { ...SHOT_SKILLS, ...FS_SKILLS, ...APP_SKILLS },
  };
  r.register(manifest, async (skill, params) => {
    if (skill === "capture") return capture(cfg);
    if (skill === "ocr_screen") return ocrScreen(cfg);
    if (skill === "open_path") return openPath(params);
    if (skill === "app_exists") return appExists(params);
    if (skill === "frontmost_app") return frontmostApp();
    if (skill === "ax_dump") return axDump(params);
    if (skill in FS_SKILLS || skill in FS_ALIASES) return fileSystem(skill, params, cfg);
    throw new Error(`system 不支持技能：${skill}`);
  });
}
