// 本地文件检索层：工作流的「文件能力」一组节点（File Filter / File Conditional /
// 在文件管理器中显示 / 在终端中打开 / 文件暂存区）都建在这上面。
//
// ── 一个关键判断：不自己造索引 ──────────────────────────────────────────────
// 待办里把这块写成「等本地索引能力就绪」，听起来像要建一套爬盘 + 落库 + 监听变更 + 增量
// 更新的索引。**不做**，理由很实在：
//   · macOS 上 Spotlight 就是那套索引，而且它由系统维护、随文件变更实时更新、
//     还认文件内容和一堆我们读不到的元数据字段。自己爬一遍只会是它的劣化版。
//   · 索引最贵的从来不是「查」，是「保持新鲜」—— 要监听 FSEvents、处理外置磁盘、
//     处理权限被拒的目录、处理几十万文件的首次全量。这些坑一个都躲不掉。
//   · Alfred 自己的 File Filter 也是查 Spotlight 元数据，不是自建索引。
// 所以这一层是**检索的门面**，不是索引：macOS 走 mdfind，别的平台（以及 mdfind 用不了
// 的时候）退回「在指定目录里按名字走一遍」。前者全盘且快，后者要求限定目录、只走有限层。
//
// 这个取舍的代价写在明处：非 macOS 上**必须**指定搜索目录，不能全盘搜。
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { expandHome } from "../config";
import { run, which } from "../shared/util";

// 一条命中。ext 统一小写且不含点，方便下游按扩展名比对。
export interface FileHit {
  path: string;
  name: string;
  ext: string;
  dir: boolean;
}

// 文件类别。值同时也是节点配置里下拉框的取值，改这里要同步改 WorkflowEditor 的选项。
export type FileKind = "any" | "folder" | "image" | "audio" | "movie" | "pdf" | "text" | "archive";

// 类别 → Spotlight 的内容类型树。用 ContentTypeTree 而不是 ContentType：
// 前者认继承关系（png / jpeg / heic 都是 public.image 的后代），后者要逐个列全。
const KIND_UTI: Record<FileKind, string> = {
  any: "",
  folder: "public.folder",
  image: "public.image",
  audio: "public.audio",
  movie: "public.movie",
  pdf: "com.adobe.pdf",
  text: "public.text",
  archive: "public.archive",
};

// 类别 → 扩展名。给非 macOS 的兜底路径用（那边没有 UTI 这套东西）。
// 列不全是必然的，所以兜底路径的类别过滤只当「粗筛」，真要精确就让用户填扩展名。
const KIND_EXTS: Record<FileKind, string[]> = {
  any: [],
  folder: [],
  image: ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff", "svg"],
  audio: ["mp3", "wav", "aac", "flac", "m4a", "ogg"],
  movie: ["mp4", "mov", "mkv", "avi", "webm", "m4v"],
  pdf: ["pdf"],
  text: ["txt", "md", "json", "yaml", "yml", "csv", "log", "xml", "html", "js", "ts", "py", "sh"],
  archive: ["zip", "tar", "gz", "bz2", "7z", "rar"],
};

// 兜底遍历的两道闸：目录层数与最多访问的条目数。
// 没有索引就只能现走，走深了会卡住主进程 —— 宁可少给几条结果，也不能让快捷入口卡住。
const WALK_MAX_DEPTH = 4;
const WALK_MAX_VISIT = 20_000;
// mdfind 的超时。它平时是毫秒级，超过这个数基本就是索引在重建，等下去没意义。
const MDFIND_TIMEOUT = 2_500;
// 不管哪条路径，最多返回多少条。再多界面也放不下，只是白白占内存。
const HARD_LIMIT = 200;

export interface FileQuery {
  keyword: string;      // 按文件名匹配的关键词；空串 = 只按类别/扩展名筛
  scopes: string[];     // 限定目录（支持 ~）；空 = 全盘（仅 macOS 支持）
  kind: FileKind;
  exts: string[];       // 扩展名精确过滤（小写，不含点），与 kind 是「且」的关系
  limit: number;
}

// 把用户填的扩展名串（"png, jpg" / ".png .jpg"）规整成小写无点的数组。
export function parseExts(raw: string): string[] {
  return String(raw || "")
    .split(/[\s,;、]+/)
    .map((s) => s.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
}

// 从路径拿 {name, ext}。ext 小写不含点；没有扩展名时是空串。
export function describe(p: string, dir = false): FileHit {
  const name = path.basename(p);
  const i = name.lastIndexOf(".");
  const ext = i > 0 ? name.slice(i + 1).toLowerCase() : "";
  return { path: p, name, ext, dir };
}

// 拼 mdfind 的查询串。单独抽出来是为了能单测 —— 拼错一个引号就是零结果，
// 而零结果和「真的没有」在界面上长得一模一样，是最难查的那种错。
export function buildMdfindQuery(q: FileQuery): string {
  const parts: string[] = [];
  const kw = q.keyword.trim();
  // c=忽略大小写，d=忽略音标。单引号里的单引号要转义，否则整条查询会被截断。
  if (kw) parts.push(`kMDItemFSName == '*${kw.replace(/'/g, "\\'")}*'cd`);
  const uti = KIND_UTI[q.kind] || "";
  if (uti) parts.push(`kMDItemContentTypeTree == '${uti}'`);
  // 扩展名交给后置过滤：mdfind 没有直接按扩展名筛的字段，硬拼 FSName 会和关键词打架。
  return parts.length ? parts.join(" && ") : "kMDItemFSName == '*'";
}

// 后置过滤：扩展名 + 类别（兜底路径没有 UTI，只能靠扩展名粗筛）。
export function matchesFilters(hit: FileHit, q: FileQuery, byExtOnly: boolean): boolean {
  if (q.exts.length && !q.exts.includes(hit.ext)) return false;
  if (!byExtOnly) return true;
  if (q.kind === "any") return true;
  if (q.kind === "folder") return hit.dir;
  const list = KIND_EXTS[q.kind] || [];
  return !hit.dir && list.includes(hit.ext);
}

// 兜底检索：在给定目录里走一遍，按文件名匹配。
// 只在指定目录内走，且有层数与访问量上限 —— 没有索引就只能现走，必须自己踩刹车。
export async function walkSearch(q: FileQuery): Promise<FileHit[]> {
  const roots = q.scopes.map((s) => expandHome(s)).filter(Boolean);
  if (!roots.length) return [];   // 没限定目录就不给走：全盘现走会卡死
  const kw = q.keyword.trim().toLowerCase();
  const out: FileHit[] = [];
  let visited = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > WALK_MAX_DEPTH || out.length >= q.limit || visited >= WALK_MAX_VISIT) return;
    let entries: { name: string; isDirectory(): boolean }[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }   // 权限不足 / 目录不在了：跳过，不算错
    for (const e of entries) {
      if (out.length >= q.limit || visited >= WALK_MAX_VISIT) return;
      visited++;
      // 点开头的一律跳过：.git / node_modules 里的东西不是用户想搜的，
      // 而且它们的数量能把访问上限一口气吃光。
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      const hit = describe(full, e.isDirectory());
      if ((!kw || hit.name.toLowerCase().includes(kw)) && matchesFilters(hit, q, true)) out.push(hit);
      if (e.isDirectory()) await walk(full, depth + 1);
    }
  };

  for (const r of roots) await walk(r, 0);
  return out.slice(0, q.limit);
}

// 检索入口。macOS 上走 Spotlight，其余（或 mdfind 不可用）退回目录遍历。
// 两条路的返回形状一致，调用方不用关心走的是哪条。
export async function searchFiles(input: Partial<FileQuery>): Promise<FileHit[]> {
  const q: FileQuery = {
    keyword: String(input.keyword || ""),
    scopes: (input.scopes || []).filter(Boolean),
    kind: (input.kind || "any") as FileKind,
    exts: input.exts || [],
    limit: Math.max(1, Math.min(Number(input.limit) || 20, HARD_LIMIT)),
  };
  // 关键词和类别都没有 = 等于「把这些目录列出来」，多半是配漏了，别真去全盘扫。
  if (!q.keyword.trim() && q.kind === "any" && !q.exts.length && !q.scopes.length) return [];

  if (process.platform === "darwin" && which("mdfind")) {
    const args: string[] = [];
    for (const s of q.scopes) args.push("-onlyin", expandHome(s));
    args.push(buildMdfindQuery(q));
    const r = await run("mdfind", args, { timeoutMs: MDFIND_TIMEOUT });
    if (r.code === 0) {
      const hits: FileHit[] = [];
      for (const line of r.output.split("\n")) {
        const p = line.trim();
        if (!p) continue;
        // Spotlight 不告诉我们是不是目录，靠有没有扩展名猜不准（Xcode.app 有扩展名却是目录）。
        // 这里只对「筛文件夹」的场景才去 stat，其余情况按文件处理即可，省掉几百次系统调用。
        let dir = false;
        if (q.kind === "folder") {
          try { dir = (await fs.stat(p)).isDirectory(); } catch { continue; }
        }
        const hit = describe(p, dir);
        if (matchesFilters(hit, q, false)) hits.push(hit);
        if (hits.length >= q.limit) break;
      }
      // Spotlight 真返回了东西就用它；一条没有时不再回退——那多半就是真没有，
      // 再走一遍目录遍历只会让「没结果」变得很慢。
      if (hits.length || q.scopes.length === 0) return hits;
    }
  }
  return walkSearch(q);
}
