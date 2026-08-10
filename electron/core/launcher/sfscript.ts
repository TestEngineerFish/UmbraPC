// Script Filter 的三块纯逻辑：跑哪个解释器、输入怎么过滤、参数空白怎么修。
//
// 单独拆出来是为了能单测 —— workflow.ts 里那一大坨要 Electron、要文件系统、要起进程，
// 而这三件事恰恰是最容易写错又最难在真机上复现的（匹配模式尤其）。
//
// 对齐的是 Alfred 的 Script Filter：
//   https://www.alfredapp.com/help/workflows/inputs/script-filter/

import * as path from "node:path";

// ── 语言 ────────────────────────────────────────────────────────────────────
//
// Alfred 的 Language 下拉。**默认必须是 bash**，不是 Alfred 的 zsh ——
// 这个节点以前写死 `bash -lc`，已有工作流的脚本都是按 bash 写的，
// 换默认值等于把它们全部弄坏一遍。新建节点时编辑器会给 zsh。
//
// 脚本怎么送进解释器，分三种：
//   inline —— 直接当命令行参数（shell 的 -c）。$1 就是用户输入。
//   file   —— 写一个临时文件再跑。**非 shell 语言一律走这条**：
//             脚本正文里必然有引号、换行、中文，拼进命令行参数迟早被截断，
//             而且每种 shell 的转义规则还不一样（AppleScript 上踩过）。
//   path   —— 「外部脚本」：脚本框里填的**是文件路径**，直接跑它。
export type ScriptVia = "inline" | "file" | "path";

export interface LangSpec {
  id: string;
  /** 编辑器下拉里显示的名字 */
  label: string;
  cmd: string;
  via: ScriptVia;
  /** via=file 时临时文件的后缀。有些解释器认后缀（osascript 尤其） */
  ext?: string;
  /** 解释器路径之后、脚本之前要插的参数（如 osascript 的 -l JavaScript） */
  pre?: string[];
}

// 顺序 = 下拉里的顺序。zsh 放第一个（Alfred 的默认，也是 macOS 的默认 shell）。
export const LANGS: LangSpec[] = [
  { id: "zsh", label: "/bin/zsh", cmd: "/bin/zsh", via: "inline" },
  { id: "bash", label: "/bin/bash", cmd: "/bin/bash", via: "inline" },
  { id: "python3", label: "/usr/bin/python3", cmd: "/usr/bin/python3", via: "file", ext: ".py" },
  { id: "ruby", label: "/usr/bin/ruby", cmd: "/usr/bin/ruby", via: "file", ext: ".rb" },
  { id: "perl", label: "/usr/bin/perl", cmd: "/usr/bin/perl", via: "file", ext: ".pl" },
  { id: "php", label: "/usr/bin/php", cmd: "/usr/bin/php", via: "file", ext: ".php" },
  { id: "node", label: "node", cmd: "node", via: "file", ext: ".js" },
  { id: "osascript", label: "/usr/bin/osascript (AppleScript)", cmd: "/usr/bin/osascript", via: "file", ext: ".applescript" },
  { id: "osascript-js", label: "/usr/bin/osascript (JavaScript)", cmd: "/usr/bin/osascript", via: "file", ext: ".js", pre: ["-l", "JavaScript"] },
  { id: "external", label: "外部脚本（脚本框里填路径）", cmd: "", via: "path" },
];

const LANG_BY_ID = new Map(LANGS.map((l) => [l.id, l]));

/** 认不出来的 id 一律退回 bash —— 老数据没有这个字段，而它们全是按 bash 写的。 */
export function langOf(id: unknown): LangSpec {
  return LANG_BY_ID.get(String(id || "bash")) || LANG_BY_ID.get("bash")!;
}

export interface Spawn { cmd: string; args: string[] }

/**
 * 组装出「跑这段脚本」的 argv。
 *
 * @param lang    语言
 * @param script  脚本正文（via=path 时是脚本框里填的路径）
 * @param arg     用户输入。**一律作为 argv 传进去**，脚本里 $1 / sys.argv[1] 就能拿到。
 * @param file    via=file 时临时文件的绝对路径；via=path 时解析好的脚本绝对路径
 *
 * shell 走 `-lc`（**登录 shell**）：打包后的 .app 只有极简 PATH，
 * 看不到 homebrew / nvm / pyenv，不走登录 shell 的话脚本里 `which python3` 直接找不到。
 */
export function buildSpawn(lang: LangSpec, script: string, arg: string, file?: string): Spawn {
  if (lang.via === "inline") {
    // 第二个位置参数是 $0（进程名），第三个才是 $1。
    return { cmd: lang.cmd, args: ["-lc", script, "umbra", arg] };
  }
  if (lang.via === "path") {
    if (!file) throw new Error("外部脚本没给出路径");
    return { cmd: file, args: [arg] };
  }
  if (!file) throw new Error("需要临时脚本文件");
  return { cmd: lang.cmd, args: [...(lang.pre || []), file, arg] };
}

/** via=file 时临时文件叫什么。带上节点 id，同一个工作流的多个脚本节点不会互相覆盖。 */
export function tempScriptName(lang: LangSpec, nodeId: string): string {
  const safe = String(nodeId || "n").replace(/[^\w.-]/g, "_");
  return `umbra-sf-${safe}${lang.ext || ".txt"}`;
}

/** 「外部脚本」的路径解析：相对路径按工作流目录算（和 Alfred 一致）。 */
export function resolveExternal(dir: string, raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  return path.isAbsolute(s) ? s : path.join(dir, s);
}

// ── 匹配模式 ────────────────────────────────────────────────────────────────
//
// 「由 Umbra 过滤结果」勾上之后按哪种规则筛。四种都照 Alfred 的定义实现，
// 文档里给的例子直接搬进了单测 —— 这几条规则口头描述听着差不多，
// 实际差别很大（"Fa Ph" 命中不命中 "My Family Photos" 取决于选了哪种）。
export type MatchMode = "boundary" | "start" | "words-any" | "words-seq";

export const MATCH_MODES: { id: MatchMode; label: string; hint: string }[] = [
  { id: "boundary", label: "从词首或空白处精确匹配", hint: "「My Family Photos」能被 My Family Photos / Family Photos / Photos 命中" },
  { id: "start", label: "从开头精确匹配", hint: "「My Family Photos」只能被 My Family Photos / My Family 命中" },
  { id: "words-any", label: "按词匹配 · 不计顺序", hint: "「My Family Photos」能被 Photos Family / Ph Fa 命中" },
  { id: "words-seq", label: "按词匹配 · 保持顺序", hint: "「My Family Photos」能被 My Photos / Fa Ph 命中，Photos My 不行" },
];

/** 去掉大小写和音调差异。Alfred 的匹配默认就是不分大小写、不计音标的。 */
function fold(s: string): string {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * 一条结果在给定模式下是否命中。
 *
 * @param hay 被匹配的文本：**优先用 item.match，没有才退回 title**（Alfred 的规则）。
 * @param needle 用户当前输入。空输入一律命中（还没开始筛）。
 */
export function matchItem(mode: MatchMode, hay: string, needle: string): boolean {
  const q = fold(needle).trim();
  if (!q) return true;
  const h = fold(hay);
  if (!h) return false;

  switch (mode) {
    case "start":
      return h.startsWith(q);

    case "words-any": {
      // 输入按空白拆成若干片，每片都要能在某个词的**词首**找到，且一个词只用一次。
      // 不「一个词只用一次」的话，输入 "fa fa" 会被单个 Family 同时满足两次。
      const words = h.split(/\s+/).filter(Boolean);
      const used = new Set<number>();
      return q.split(/\s+/).filter(Boolean).every((part) => {
        const i = words.findIndex((w, k) => !used.has(k) && w.startsWith(part));
        if (i < 0) return false;
        used.add(i);
        return true;
      });
    }

    case "words-seq": {
      // 同上，但命中的词必须**从左到右递增**：My Photos 行，Photos My 不行。
      const words = h.split(/\s+/).filter(Boolean);
      let at = 0;
      return q.split(/\s+/).filter(Boolean).every((part) => {
        const i = words.findIndex((w, k) => k >= at && w.startsWith(part));
        if (i < 0) return false;
        at = i + 1;
        return true;
      });
    }

    case "boundary":
    default:
      // 从整条开头，或任意一个空白之后开始精确匹配。整段输入（含空格）当一个前缀比，
      // 所以 "Family Photos" 命中，而 "Photos Family" 不命中。
      return h.startsWith(q) || h.split(/\s+/).some((_w, i, arr) => arr.slice(i).join(" ").startsWith(q));
  }
}

// ── 参数空白修剪 ────────────────────────────────────────────────────────────

/**
 * Alfred 的 Argument Whitespaces Trimming。默认修剪 —— 用户多打一个空格不该
 * 让脚本白跑一次（缓存键里带着 arg，多一个空格就是一次全新的执行）。
 * 关掉之后原样送进去：写代码片段、要求缩进的场景空格是有意义的。
 */
export function trimArg(raw: string, trim: boolean): string {
  const s = String(raw ?? "");
  if (!trim) return s;
  return s.trim().replace(/\s+/g, " ");
}

// ── 队列延迟 ────────────────────────────────────────────────────────────────

export type QueueDelay = "auto" | "immediate" | "custom";

/**
 * 这次查询要等多少毫秒再跑脚本。等待期间用户又敲了字就把这一次丢掉。
 *
 * - immediate：一律不等（脚本很快时手感最好）。
 * - custom：固定等 ms 毫秒。
 * - auto（默认）：**首字符立即跑，之后等一小会儿**。这是 Alfred 推荐的行为 ——
 *   第一下立刻有反馈，用户不会以为没反应；后面连打时才攒一攒，
 *   否则打一个七字的词就是七个进程，脚本一慢就把机器拖住，而前六次结果没人看。
 */
export function queueWaitMs(delay: QueueDelay, customMs: number, argLen: number): number {
  if (delay === "immediate") return 0;
  if (delay === "custom") return Math.max(0, Math.min(customMs || 0, 1000));
  return argLen <= 1 ? 0 : 200;
}

// ── 「找不到文件」的定位 ────────────────────────────────────────────────────

/**
 * 把脚本里出现的相对路径（`./xxx` / `../xxx`）挑出来。
 *
 * 用途只有一个：脚本报「no such file or directory」时，拿这张单子去运行目录里
 * 逐个 stat，告诉用户**具体缺哪个**。解释器给的报错常常只有一句
 * 「Error: no such file or directory」，连路径都不带（txiki 就是这样），
 * 用户除了瞎试没有别的办法。
 *
 * 故意做得很笨：只认引号/空白包起来的 ./ 开头的连续非空白串。
 * 变量拼出来的路径（`$dir/index.js`）本来就静态看不出来，不去猜。
 */
export function relativePathsIn(script: string): string[] {
  const out: string[] = [];
  const re = /(^|[\s"'`(=])(\.{1,2}\/[^\s"'`)|;&<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(script || ""))) !== null) {
    const raw = m[2].replace(/[),;:]+$/, "");
    if (raw && !out.includes(raw)) out.push(raw);
  }
  return out;
}

/** 这条报错像不像「文件/命令找不到」。像的话才值得去 stat 一遍。 */
export function looksLikeMissingFile(out: string): boolean {
  return /no such file or directory|command not found|cannot find module|enoent/i.test(String(out || ""));
}
