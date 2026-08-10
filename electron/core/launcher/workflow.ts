// 工作流执行引擎（类 Alfred Workflow）。
// 触发(Keyword/Hotkey) → 输入(Script Filter，跑脚本解析 Alfred JSON) → 修饰键分支 → 动作链(Action)。
// 与内置 provider 结果并存：本引擎只产出/执行「工作流」结果，LauncherManager 负责合并与分发。
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { ConfigStore, expandHome, httpBase, Workflow, WorkflowNode } from "../config";
import { httpFetch } from "../http";
import { run, which, type RunResult } from "../shared/util";
import { describe as describeFile, parseExts, searchFiles, type FileHit, type FileKind } from "./filesearch";
import { simulatePaste, simulateCopy, simulateKeyCombo } from "../clipboard/paste";
import { readClipboardFiles } from "../clipboard/watcher";
import { calc, convertUnits, unicodeTransform, urlTransform, base64Transform } from "./tools";
import { ensureWorkflowDir, workflowDir, workflowEnv, resolveCwd } from "./workspace";
import {
  buildSpawn, langOf, looksLikeMissingFile, matchItem, queueWaitMs, relativePathsIn,
  resolveExternal, tempScriptName, trimArg,
  type MatchMode, type QueueDelay,
} from "./sfscript";
import { TraceRecorder, maskSecret } from "./trace";
import type { TraceRun } from "./trace";

// 与 LauncherManager 的结果结构对齐（避免运行时循环依赖，仅类型引用）。
import type { LauncherResult } from "./index";

// run(token, mod) 的特殊返回：该修饰键没有连线分支 → 交回上层兜底（如「发给秘书」）。
// 用不可打印的 NUL 前缀，确保永远不会和真实的提示文案撞车。
export const NO_BRANCH = "\u0000NO_BRANCH";

// Alfred item（Script Filter 输出）关键字段。
interface AlfredMod { arg?: string; subtitle?: string; valid?: boolean; variables?: Record<string, string>; }
interface AlfredItem {
  title?: string; subtitle?: string; arg?: string | string[];
  icon?: { path?: string; type?: string };
  uid?: string; valid?: boolean; match?: string; autocomplete?: string;
  mods?: Record<string, AlfredMod>;
  text?: { copy?: string; largetype?: string };
  variables?: Record<string, string>;
  quicklookurl?: string;
}

// List Filter 节点里维护的一行。uid 只用于使用频率学习（不填就拿 title 当键）。
interface ListRow { title?: string; subtitle?: string; arg?: string; icon?: string; uid?: string }

// Script Filter 脚本输出的顶层结构（Alfred 约定）。
interface SFOutput {
  items?: AlfredItem[];
  variables?: Record<string, string>;                    // 本次会话变量：并进每个 item 的变量
  rerun?: number;                                        // 0.1~5 秒后自动再查一次
  cache?: { seconds?: number; loosereload?: boolean };   // 输出缓存
  skipknowledge?: boolean;                               // 本次结果不参与使用频率学习
}

// 一条工作流结果被选中时，run 需要的上下文。
interface ItemCtx {
  wfId: string;
  srcNodeId: string;               // 分支的发出节点（Script Filter 或 直连动作时的 Trigger）
  arg: string;                     // 该项默认 arg
  variables: Record<string, string>;
  valid: boolean;
  mods: Record<string, AlfredMod>; // item 级修饰键覆盖
  hintOnly?: boolean;              // 仅提示（如「需输入」），不可执行
}

// 文本视图（Text View）一次展示请求：title=标题栏文案，md=是否按 Markdown 渲染，
// append=追加到现有内容（流式续写）而不是整体替换，loading=显示等待动画（等秘书回复时用）。
export interface TextViewPayload {
  text: string;
  title?: string;
  md?: boolean;
  append?: boolean;
  loading?: boolean;
}

export interface WorkflowDeps {
  sendAssistant: (text: string) => void;         // 复用「发给秘书」链路
  hide: (returnFocus: boolean) => Promise<void>; // 关闭启动器
  // 重新唤起启动器面板（「显示主面板」节点用）。和 hide 配套：链路中间先收起面板去干活，
  // 干完再把面板叫回来接着挑下一项。
  // prefill：唤起时预先填进搜索框的内容（Hotkey 的「打开快捷入口」用）。
  // caret="left" 时光标停在最前面 —— Alfred 的做法，方便「关键词在后、内容在前」的写法。
  showPanel: (prefill?: { q: string; caret?: "left" | "right" }) => Promise<void>;
  showLargeType: (text: string) => void;         // 大字显示浮层
  showTextView: (p: TextViewPayload) => void;    // 文本视图浮层（可 Markdown、可流式追加）
  // 取密码保险箱里的明文（W10 的 password 配置项）。保险箱锁着/引用失效返回 null。
  // 主进程启动顺序上 launcher 先于 vault 建好，所以这里允许后置注入（缺省当作取不到）。
  getSecret?: (ref: string) => string | null;
}

// ── 一次执行的上下文：这次运行**有没有人在看** ────────────────────────────────
//
// 到目前为止工作流只有一条入口：人按了快捷键 / 在快捷入口挑了一项。所以引擎可以理直气壮地
// 去收面板、弹浮层、往前台应用里发按键 —— 反正屏幕前就坐着那个人。
//
// 接下来工作流要变成一项「设备能力」，可能由服务端远程调起。那时候屏幕前没人，
// 上面每一件事的含义都变了：收面板没有面板可收；弹一个大字浮层没人看见还挡住别人干活；
// 往前台应用里发按键更糟 —— 前台是哪个应用完全不确定，可能把内容打进别人正在写的邮件里。
//
// 所以把「碰界面」这件事收成两套上下文，而不是在十几个节点里各写一句 if：
//   ui       —— 有人在看：ui 面就是真正的 deps，行为和以前完全一样。
//   headless —— 没人在看：ui 面换成一个不碰界面的替身；展示类节点的内容改为**收集起来**
//               交回调用方；少数几个「必须有人在场」的节点直接拦下（见 HEADLESS_BLOCK）。
//
// 关键取舍：上下文是**按次运行**传下去的，不是引擎上的一个字段。一次远程调用和一次
// 本人操作完全可能在时间上交叠，字段会串味。
export type RunSurface = "ui" | "headless";

// 无人在看时，展示类节点收集下来的内容。调用方（将来的设备技能层）把它当返回值。
export interface RunOutput { kind: "largetype" | "textview"; title?: string; text: string }

export interface RunCtx {
  surface: RunSurface;
  /** 碰界面的那一面。ui 上下文里就是真 deps；headless 里是替身 */
  ui: WorkflowDeps;
  /** headless 时展示类节点的内容落在这里；ui 时始终为空 */
  outputs: RunOutput[];
}

// 无人在看时**必须拦下**的节点，值是拦下的理由（直接回给调用方，不用再翻代码猜）。
//
// 收录标准只有一条：**没人在场时它的后果不可预期或不可控**。
//   · paste / keycombo 往「当时的前台应用」里注入内容，而没人看着时前台是哪个完全不确定；
//   · dialog 要等人点按钮，而系统消息框不会超时，没人点就一直挂着。
// 反过来，openurl / launch / terminal / reveal 这些「让我的电脑去做件事」不在此列 ——
// 它们会抢焦点，但那正是远程调用想要的结果，拦掉等于把这个功能废掉一半。
// notify 也不拦：系统通知恰恰就是「人不在看应用时告诉他一声」的机制。
// 被拦节点的中文名。引擎侧本来没有标签表（标签在编辑器的 CATALOG 里），
// 这里只给被拦的这几个各留一个 —— 报错里写「utility.dialog」对用户毫无意义。
const BLOCKED_LABEL: Record<string, string> = {
  "action.paste": "粘贴到前台", "output.keycombo": "发送按键", "utility.dialog": "对话框",
};
const HEADLESS_BLOCK: Record<string, string> = {
  "action.paste": "模拟粘贴会把内容打进当时的前台应用，而没人看着时前台是哪个完全不确定",
  "output.keycombo": "模拟按键会发给当时的前台应用，没人看着时不该乱按",
  "utility.dialog": "对话框要等人点按钮，没人可问",
};

const SCRIPT_TIMEOUT = 20000;
// 「由 Umbra 过滤结果」时脚本输出的存活时长。不做成永久：脚本的数据也会变
// （汇率、待办列表），一直吃缓存比多跑一次更糟。10 秒足够覆盖「敲完一个词」这段。
const FILTER_SESSION_TTL = 10_000;
// 问秘书 / 设备派发走 HTTP，比本地脚本慢得多，单独给一个更长的超时。
const REMOTE_TIMEOUT = 120000;

// 日期时间占位符的格式化：只认这几个字段，够用且不用引第三方库。
//   YYYY 年 / MM 月 / DD 日 / HH 时(24) / mm 分 / ss 秒 / SSS 毫秒 / ddd 星期几（中文）
// 长的写在前面，避免 YYYY 被 YY 先吃掉一半。
function formatNow(fmt: string): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MM: p2(d.getMonth() + 1),
    DD: p2(d.getDate()),
    HH: p2(d.getHours()),
    mm: p2(d.getMinutes()),
    ss: p2(d.getSeconds()),
    SSS: String(d.getMilliseconds()).padStart(3, "0"),
    ddd: "日一二三四五六"[d.getDay()],
  };
  return (fmt || "").replace(/YYYY|SSS|ddd|YY|MM|DD|HH|mm|ss/g, (k) => map[k] ?? k);
}

// 随机占位符 {random[:参数]}：
//   （空）        0~999999 的整数
//   uuid         标准 UUID
//   N            0~N 的整数
//   A-B          A~B 的整数（闭区间）
//   hexN / strN  N 位十六进制 / N 位大小写字母数字串（上限 64）
function randomToken(param: string): string {
  const p = (param || "").trim().toLowerCase();
  const int = (min: number, max: number) => String(min + Math.floor(Math.random() * (max - min + 1)));
  if (!p) return int(0, 999999);
  if (p === "uuid") return randomUUID();
  const hex = p.match(/^hex(\d+)$/);
  if (hex) {
    const n = Math.min(64, Math.max(1, Number(hex[1])));
    return [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
  }
  const str = p.match(/^str(\d+)$/);
  if (str) {
    const n = Math.min(64, Math.max(1, Number(str[1])));
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return [...Array(n)].map(() => abc[Math.floor(Math.random() * abc.length)]).join("");
  }
  const range = p.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
  if (range) {
    const a = Number(range[1]); const b = Number(range[2]);
    return int(Math.min(a, b), Math.max(a, b));
  }
  const max = Number(p);
  return Number.isFinite(max) ? int(0, Math.max(0, Math.floor(max))) : "";
}

// 文件已存在且选了「另存新文件」时，在扩展名前加 -1、-2… 直到找到没被占用的名字。
async function uniquePath(p: string): Promise<string> {
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const cand = `${base}-${i}${ext}`;
    if (!(await fs.stat(cand).then(() => true).catch(() => false))) return cand;
  }
  return `${base}-${Date.now()}${ext}`;
}

// Split / Join 的分隔符：预置 comma / space / tab / newline，custom 用用户自己填的串。
// custom 里认 \n \t \\ 三种转义（面板上只有一个单行输入框，敲不了真的换行/制表符）。
function delimOf(kind: string, custom: string): string {
  switch (String(kind || "comma")) {
    case "space": return " ";
    case "tab": return "\t";
    case "newline": return "\n";
    case "custom":
      return String(custom || "").replace(/\\(.)/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "\\" ? "\\" : `\\${c}`));
    case "comma":
    default: return ",";
  }
}

// 按分隔符拆分。先把 \r\n / \r 归一成 \n，这样从 Windows / 网页复制来的文本也能正确按行拆；
// 分隔符为空（选了 Custom 却没填）时不拆，整条当成一项，免得静默变成逐字符拆开。
function splitBy(text: string, sep: string): string[] {
  const s = String(text ?? "").replace(/\r\n?/g, "\n");
  return sep ? s.split(sep) : [s];
}

// 扇出上下文：Split 以「参数列表」方式输出时，下游会被拆出的每一项各跑一遍，
// 这个对象贯穿这一批的所有项，让链路末端的 Join 知道「现在是第几项、一共几项、已经收了哪些」。
// bucket 挂在这一批上而不是引擎实例上，所以嵌套的 Split 与并发触发各收各的，互不串台。
interface FanCtx {
  index: number;                  // 当前是第几项（0 起）
  total: number;                  // 这一批共几项
  bucket: Map<string, string[]>;  // Join 节点 id → 该节点已收集到的参数
  parent: FanCtx | null;          // 外层扇出（Split 套 Split 时用；Join 合并完回到外层）
}

// 一次扇出最多跑多少项：Split 撞上一份大文本时（比如整个文件按行拆），
// 逐项串行跑几千遍会把链路拖到没反应，超出部分直接截断并在反馈里说明。
const MAX_FAN = 200;

// ── macOS 专属动作的公共部分 ─────────────────────────────────────────────────
// 这一组节点（AppleScript / 快捷指令 / 音乐控制 / 词典）都只在 macOS 上有对应物。
// 在别的平台上一律给一句明确的提示就停，**不要静默什么都不做** ——
// 「按了没反应」比「说清楚不支持」难查一百倍。
const MAC_ONLY = "这个节点只在 macOS 上可用";
// AppleScript / 音乐控制的超时。这类脚本要么秒回，要么就是弹了个对话框在等人 ——
// 等太久不如早点放手，链路卡死比脚本失败难查得多。
const APPLESCRIPT_TIMEOUT = 20_000;
// 快捷指令可能真的要跑一会儿（发消息、处理图片），给宽一些。
const SHORTCUT_TIMEOUT = 120_000;
// 朗读 / 提示音的超时。这两个都是「响一下」的事，卡住就没有意义了。
// Dialog Conditional 的按钮清单。**引擎和编辑器必须用同一份**：
// 出口是按下标编号的（b0/b1/b2），两边对按钮个数的理解差一个，连线就接到别的分支上去了。
// 所以这个函数导出给编辑器的 outPorts 直接用，而不是各算一遍。
// 空按钮名补成「按钮N」而不是丢掉 —— 丢掉会让下标错位，是同一类的坑。
export const DIALOG_MAX_BUTTONS = 3;
export function dialogButtons(config: Record<string, unknown>): string[] {
  const raw = Array.isArray(config.buttons) ? (config.buttons as unknown[]) : [];
  const list = raw.slice(0, DIALOG_MAX_BUTTONS).map((b, i) => String(b ?? "").trim() || `按钮${i + 1}`);
  return list.length ? list : ["取消", "确定"];
}

// 确认框等人点的时间。给足两分钟：弹出来时用户可能正被别的事岔开。
const CONFIRM_TIMEOUT = 120_000;
const SPEAK_TIMEOUT = 60_000;
const SOUND_TIMEOUT = 30_000;
// 单个暂存区最多攒多少个文件。攒到这个量还没处理，多半是忘了接 list/clear。
const FILE_BUFFER_MAX = 200;

// 网页搜索的引擎表。{q} 是**已 URL 编码**的查询词。
// 引擎挂在节点上而不是做成全局设置项 —— Alfred 也是这么摆的，而且一个工作流搜 GitHub、
// 另一个搜百度是常态，全局唯一反而不够用。
const SEARCH_ENGINES: Record<string, { label: string; url: string }> = {
  google: { label: "Google", url: "https://www.google.com/search?q={q}" },
  bing: { label: "Bing", url: "https://www.bing.com/search?q={q}" },
  duckduckgo: { label: "DuckDuckGo", url: "https://duckduckgo.com/?q={q}" },
  baidu: { label: "百度", url: "https://www.baidu.com/s?wd={q}" },
  github: { label: "GitHub", url: "https://github.com/search?q={q}" },
  wikipedia: { label: "维基百科", url: "https://zh.wikipedia.org/w/index.php?search={q}" },
};

// Run Script 支持的语言。每种语言「脚本怎么传、参数怎么传」都不一样，所以三件事一起登记：
//   cmd/args  —— 解释器和它读代码的开关（脚本正文紧跟在 args 后面作为一个整参数）
//   argv      —— 代码后面还要追加什么，才能让脚本里拿到上游参数
//   accepts   —— 这门语言认哪些 shebang 名字，用来拦「首行写 python、下拉选 bash」这种误配
// 各语言里取上游参数的写法：bash/zsh 用 $1，python 用 sys.argv[1]，ruby 用 ARGV[0]，
// node 用 process.argv[1]，osascript 用 on run argv。另外环境变量 query 一直都在，都能读。
const SCRIPT_LANGS: Record<string, { label: string; cmd: string; args: string[]; argv: (a: string) => string[]; accepts: string[] }> = {
  bash: { label: "bash", cmd: "bash", args: ["-lc"], argv: (a) => ["umbra", a], accepts: ["bash", "sh"] },
  zsh: { label: "zsh", cmd: "zsh", args: ["-lc"], argv: (a) => ["umbra", a], accepts: ["zsh"] },
  python3: { label: "Python 3", cmd: "python3", args: ["-c"], argv: (a) => [a], accepts: ["python3", "python"] },
  ruby: { label: "Ruby", cmd: "ruby", args: ["-e"], argv: (a) => [a], accepts: ["ruby"] },
  node: { label: "Node.js", cmd: "node", args: ["-e"], argv: (a) => [a], accepts: ["node"] },
  osascript: { label: "AppleScript（osascript）", cmd: "osascript", args: ["-e"], argv: (a) => [a], accepts: ["osascript"] },
};

// 「把命令打进终端窗口」在不同终端里要用各自的 AppleScript 方言，没法一套通吃。
// 只支持这两个：Terminal 是系统自带（一定有），iTerm 是最常见的替代品。
// 填别的终端会明确报「不支持」，而不是静默打开一个空窗口。
const TERMINAL_SCRIPTS: Record<string, (cmd: string) => string> = {
  Terminal: (cmd) => `tell application "Terminal"\n activate\n do script "${cmd}"\nend tell`,
  iTerm: (cmd) => `tell application "iTerm"\n activate\n set w to (create window with default profile)\n tell current session of w to write text "${cmd}"\nend tell`,
};
// AppleScript 字符串里要转义反斜杠和双引号，否则命令里带任何一个都会把脚本撑坏。
function escapeAppleString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// System Command 能做的事。只收录**说得清、后果明确**的那几个 ——
// 关机、重启这类不进来：工作流误触的代价太大，真要做也该走确认弹窗那条路。
// script 里的 osascript 都不需要额外权限（清废纸篓会弹系统自己的确认框）。
const SYSTEM_CMDS: Record<string, { label: string; mac: string; needsDarwin: true }> = {
  lock: { label: "锁定屏幕", mac: 'tell application "System Events" to keystroke "q" using {command down, control down}', needsDarwin: true },
  sleep: { label: "睡眠", mac: 'tell application "System Events" to sleep', needsDarwin: true },
  screensaver: { label: "启动屏保", mac: 'tell application "System Events" to start current screen saver', needsDarwin: true },
  emptytrash: { label: "清空废纸篓", mac: 'tell application "Finder" to empty trash', needsDarwin: true },
  hideothers: { label: "隐藏其它应用", mac: 'tell application "System Events" to set visible of (every process whose visible is true and frontmost is false) to false', needsDarwin: true },
  logout: { label: "注销当前用户", mac: 'tell application "System Events" to log out', needsDarwin: true },
};
function macOnly(): string | null {
  return process.platform === "darwin" ? null : MAC_ONLY;
}

// 列出当前在跑的、有界面的应用名。只取 background only = false 的那些 ——
// 后台守护/输入法/菜单栏代理有几十个，混进来会把列表淹掉，而用户要切的永远是有窗口的。
async function listRunningApps(): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  const r = await runAppleScript(
    'tell application "System Events" to get name of every process whose background only is false',
    6_000,
  );
  if (r.code !== 0) return [];
  // osascript 返回的是「A, B, C」这种逗号分隔的一行
  return r.output.split(",").map((s) => s.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

// 切换到某个应用，或退出它。名字里的引号要转义，否则 AppleScript 会被截断。
async function controlApp(name: string, quit: boolean): Promise<string> {
  const bad = macOnly();
  if (bad) return bad;
  const safe = name.replace(/["\\]/g, "\\$&");
  const r = await runAppleScript(`tell application "${safe}" to ${quit ? "quit" : "activate"}`, 8_000);
  if (r.code !== 0) return `${quit ? "退出" : "切换"}「${name}」失败：${r.output.trim().slice(0, 60)}`;
  return quit ? `已退出 ${name} ✓` : `已切换到 ${name} ✓`;
}

// 在系统词典里查一个词。dict:// 是 macOS 的词典 URL scheme，open 一下就会唤起词典 App。
async function openDictionary(word: string): Promise<string> {
  const bad = macOnly();
  if (bad) return bad;
  const { shell } = await import("electron");
  await shell.openExternal(`dict://${encodeURIComponent(word)}`);
  return "已在词典中打开 ✓";
}

// 跑一段 AppleScript。脚本从 stdin 送进 osascript，不走命令行参数 ——
// 脚本里带引号、换行、中文都很常见，拼进 -e 迟早出事。
async function runAppleScript(script: string, timeoutMs: number): Promise<RunResult> {
  return run("osascript", ["-"], { timeoutMs, stdin: script });
}

// 音乐控制：全部落到 Music.app 的 AppleScript 命令上。
// 只收录能一句话说清、且不带参数的那几个动作 —— 播放列表、曲库这类要先有 UI 才谈得上。
const MUSIC_CMDS: Record<string, { label: string; script: string }> = {
  playpause: { label: "播放 / 暂停", script: 'tell application "Music" to playpause' },
  play: { label: "播放", script: 'tell application "Music" to play' },
  pause: { label: "暂停", script: 'tell application "Music" to pause' },
  next: { label: "下一首", script: 'tell application "Music" to next track' },
  previous: { label: "上一首", script: 'tell application "Music" to previous track' },
  // 音量是 0–100 的整数，越界会被 Music 拒绝，所以在这边先夹一道
  volume: { label: "设置音量", script: 'tell application "Music" to set sound volume to %V%' },
  // 「当前播放什么」：拿回一行文本给下游用
  now: { label: "当前播放", script: 'tell application "Music" to if player state is playing then return (name of current track) & " — " & (artist of current track)' },
};

// ── 文件类节点的公共小工具 ──────────────────────────────────────────────────
// 路径存不存在。存在性判断一律走 stat 而不是 access：access 只看权限位，
// 对「符号链接指向的东西没了」这种情况会给出误判。
async function pathExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}
async function isDirectory(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}
// 把路径归到「一个目录」：本来就是目录就用它自己，是文件就取所在目录。
// 用户说「在终端里打开这个」时想要的几乎总是所在目录，拿文件路径当工作目录只会失败。
async function toDirectory(p: string): Promise<string | null> {
  if (!await pathExists(p)) return null;
  return (await isDirectory(p)) ? p : path.dirname(p);
}

// File Conditional 的单条规则。字段刻意和 Conditional 的规则表长得不一样 ——
// 那边比的是文本，这边比的是「这个路径是什么」，混用一套字段只会让人配错。
//   op: is_dir | is_file | not_exists | ext_in | name_contains | path_contains
//   value: ext_in 是逗号分隔的扩展名，其余是要比的文本
//
// exists 单独传进来而不是从 info 里推：describe() 只拆路径字符串，它没法知道盘上有没有这个东西。
// 早期版本拿 info.name 是否为空当「存在」，结果「路径不存在」这条永远判不出来（有名字≠有文件）。
function matchFileRule(rule: Record<string, unknown>, info: FileHit, exists: boolean): boolean {
  const op = String(rule.op || "ext_in");
  const value = String(rule.value ?? "").trim();
  const ci = rule.ci !== false;
  const norm = (s: string) => (ci ? s.toLowerCase() : s);
  switch (op) {
    case "is_dir": return exists && info.dir;
    case "is_file": return exists && !info.dir;
    case "not_exists": return !exists;
    case "name_contains": return !!value && norm(info.name).includes(norm(value));
    case "path_contains": return !!value && norm(info.path).includes(norm(value));
    case "ext_in":
    default: {
      const list = parseExts(value);
      return list.length ? list.includes(info.ext) : false;
    }
  }
}

// 这个节点是不是「关键词的拥有者」。
//
// Alfred 把关键词做在 Script Filter 自己身上；我们原来拆成了
// trigger.keyword → input.scriptfilter 两个节点。现在两种都认：
// Script Filter 只要自己填了关键词，就直接由它触发，不必再连一个触发器。
// **故意不做数据迁移** —— 已有工作流照旧走触发器那条路，一个字都不用改。
// 取第一条**有内容**的行，最多 160 字。
//
// 为什么不是 slice(0, 60)：脚本报错时最要紧的信息（哪个文件、哪一行）几乎都在
// 后半句。砍到 60 字会得到「no such file or director」这种半截话 —— 用户看不出
// 缺的是哪个文件，只能一遍遍瞎试。
// 为什么只取第一行：解释器的报错常带一长串调用栈，铺在结果行里既放不下也没用；
// 完整输出在调试抽屉里（stepEnd 已经把 stdout/stderr 原样记进去了）。
function firstLine(out: string): string {
  const line = String(out || "").split(/\r?\n/).map((x) => x.trim()).find(Boolean) || "";
  return line.length > 160 ? line.slice(0, 160) + "…" : line;
}

// 报错行的副标题。**「找不到文件」这一类单独给一句提示**：
// 从 Alfred 搬工作流时这是头号绊脚石 —— 脚本里的 ./runtime/xxx 是相对
// 「运行目录」（缺省就是工作流自己的目录）算的，而那个目录里通常还什么都没有，
// 用户得先把 Alfred 那边的文件拷进来。不说的话完全没有线索指向这件事。
function scriptErrHint(name: string, out: string, cwd: string): string {
  if (/no such file or directory/i.test(out) || /command not found/i.test(out)) {
    return `相对路径是相对 ${cwd} 算的 —— 脚本要用的文件拷进去了吗？`;
  }
  return `${name} · 工作流 · 完整输出见编辑器的调试抽屉`;
}

// 一次正在跑的 Script Filter。child 由 run() 的 onSpawn 回填。
interface SfRun {
  child?: import("node:child_process").ChildProcess;
  done: Promise<string | LauncherResult[]>;
  /** 被「杀掉上一次」的队列模式干掉了。这一轮的任何输出都不该再露面。 */
  killed?: boolean;
}

// 「参数」下拉没配时算哪一档。**和编辑器里的缺省显示一一对应**，
// 两边不一致的话，界面写着「必填」而引擎按「可选」跑，用户完全看不出为什么。
function defaultArgMode(type: string): string {
  return type === "input.scriptfilter" ? "required" : "optional";
}

function keywordOwner(n: WorkflowNode): boolean {
  if (n.type === "trigger.keyword") return true;
  return n.type === "input.scriptfilter" && !!String(n.config.keyword || "").trim();
}

export class WorkflowEngine {
  private ctx = new Map<string, ItemCtx>();  // token → 上下文（每次 query 重置）
  private seq = 0;
  // 调试轨迹：每次执行都往里记，工作流编辑器的调试抽屉从这里取（只在内存里留最近若干次）。
  readonly trace = new TraceRecorder();
  // Script Filter 输出缓存（W3 的 cache 字段）：键 = 工作流+节点+工作目录+参数+脚本正文。
  // 只在内存里放，进程退出即清空；最多 100 条，超了丢最旧的。
  private sfCache = new Map<string, { out: string; at: number; ttl: number; loose: boolean }>();
  // Script Filter 的防抖序号：每个节点一个自增号，等待期间号变了就说明用户又敲了新字符，
  // 这一次的结果已经没人要了，直接作废，不去起那个进程。
  private sfSeq = new Map<string, number>();
  // 正在跑的 Script Filter 进程（每节点一个）。队列模式要用：
  // terminate 靠 child 杀掉上一次，wait 靠 done 等它跑完。
  private sfRunning = new Map<string, SfRun>();
  // 本次查询命中的关键词。脚本要靠 alfred_workflow_keyword 拿到它 ——
  // 一个 Script Filter 挂多个关键词时，脚本得知道用户敲的是哪个（Alfred 有这个变量）。
  private curKeyword = "";
  // rerun（W3）：脚本要求过 N 秒自动再查一次。每次查询前清零，查完由上层 takeRerun() 取走并安排定时。
  private rerunAfter = 0;
  // 文件暂存区（File Buffer）：`工作流id:节点id` → 已攒的绝对路径。
  // 只在内存里，进程退出即清空 —— 它是「这几分钟挑几个文件一起处理」的临时篮子，
  // 不是长期收藏夹（那是书签该干的事）。
  private fileBuffers = new Map<string, string[]>();

  constructor(private cfg: ConfigStore, private deps: WorkflowDeps) {}

  // 有人在看：ui 面直接就是真 deps，行为和加这套上下文之前逐字一致。
  private uiCtx(): RunCtx {
    return { surface: "ui", ui: this.deps, outputs: [] };
  }

  // 没人在看：换一个不碰界面的替身。
  // 逐项说明为什么这么替，而不是笼统「都变空操作」：
  //   hide / showPanel  —— 没有面板可收也没有可唤起的，空操作即正确。
  //   showLargeType     —— 大字浮层没人看见，还会挡住别人正在干的事。内容收进 outputs。
  //   showTextView      —— 同上。它本来就是「把一段文本给人看」，收集起来交回调用方最贴近原意。
  //   sendAssistant     —— **不替**。它不是「显示」，是真把消息发给秘书，远程调起时照样该发。
  //   getSecret         —— 不替。取密钥和有没有人看无关。
  private headlessCtx(): RunCtx {
    const outputs: RunOutput[] = [];
    return {
      surface: "headless",
      outputs,
      ui: {
        sendAssistant: (t) => this.deps.sendAssistant(t),
        hide: async () => { /* 无面板可收 */ },
        showPanel: async () => { /* 无面板可唤起 */ },
        showLargeType: (text) => { outputs.push({ kind: "largetype", text }); },
        showTextView: (p) => { outputs.push({ kind: "textview", title: p.title, text: p.text }); },
        getSecret: (ref) => this.deps.getSecret?.(ref) ?? null,
      },
    };
  }

  private workflows(): Workflow[] {
    return (this.cfg.get().launcherWorkflows || []).filter((w) => w && w.enabled !== false);
  }
  private node(wf: Workflow, id: string): WorkflowNode | undefined {
    return wf.nodes.find((n) => n.id === id);
  }

  // 工作流的基础变量（W10 Configuration 分层的唯一出口）。三层叠加，后面的盖前面的：
  //   1) 配置项声明里的 default —— 作者给的兜底；
  //   2) variables 里使用者真正填的值；
  //   3) 值若是 vault://... 引用（password 类型），现场去保险箱取明文；取不到就留空串，
  //      让脚本自己报「没配密钥」，而不是把引用串当密码传下去。
  // 所有需要「工作流变量」的入口都走这里，避免有的地方解密了有的地方没解密。
  private baseVars(wf: Workflow): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of wf.config || []) if (f?.key && f.default !== undefined) out[f.key] = String(f.default);
    for (const [k, v] of Object.entries(wf.variables || {})) out[k] = String(v ?? "");
    for (const [k, v] of Object.entries(out)) {
      if (!v.startsWith("vault://")) continue;
      out[k] = this.deps.getSecret?.(v) ?? "";
    }
    return out;
  }
  // 从 nodeId 的指定「出口」沿指定修饰键分支发出的连线。
  // fromPort 缺省为 ""（默认出口）——旧数据没有这个字段，落在默认出口上，行为不变。
  private outConns(wf: Workflow, nodeId: string, mod: string, fromPort = "") {
    return (wf.connections || []).filter(
      (c) => c.from === nodeId && (c.mod || "") === mod && (c.fromPort || "") === fromPort,
    );
  }
  // 该发出节点上有哪些修饰键分支（供渲染层提示 ⌘ 分支存在）。
  private branchMods(wf: Workflow, nodeId: string): string[] {
    const s = new Set<string>();
    for (const c of wf.connections || []) if (c.from === nodeId && c.mod) s.add(c.mod);
    return [...s];
  }

  // 占位替换（工作流全局共用的一套动态占位符）：
  //   · {query}                 上游传下来的 arg
  //   · {var:name}              工作流变量（含配置项、Script Filter 输出的 variables）
  //   · {clipboard}             当前剪贴板文本
  //   · {date} / {date:格式}    日期，默认 YYYY-MM-DD
  //   · {time} / {time:格式}    时间，默认 HH:mm:ss
  //   · {random} / {random:参数} 随机数，见 randomToken()
  // 只跑一遍正则（而不是一个占位符一个 .replace 链下来）：
  // 剪贴板/变量里如果正好有 "{query}" 这样的字面量，不会被后一轮替换二次展开。
  // 认不出来的占位符原样留着 —— 脚本自己的模板语法不该被我们吃掉。
  private subst(tpl: string, arg: string, vars: Record<string, string>): string {
    return (tpl || "").replace(/\{(query|var|clipboard|date|time|random)(?::([^}]*))?\}/g, (m, name: string, param?: string) => {
      switch (name) {
        case "query": return param === undefined ? arg : m;
        case "var": return param === undefined ? m : (vars[param.trim()] ?? "");
        case "clipboard": return this.clipText();
        case "date": return formatNow(param || "YYYY-MM-DD");
        case "time": return formatNow(param || "HH:mm:ss");
        case "random": return randomToken(param || "");
        default: return m;
      }
    });
  }

  // 同步读剪贴板：subst 是同步方法（Conditional 规则求值等地方也在用），
  // 没有 await import("electron") 的机会，这里跟 loadIcon 一样走同步 require。
  private clipText(): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { clipboard } = require("electron") as typeof import("electron");
      return clipboard.readText() || "";
    } catch { return ""; }   // 非 Electron 环境（单测）当作空剪贴板
  }

  // 取走本次查询里脚本要求的自动重查间隔（秒，0 = 不需要）。取完即清零，避免重复安排。
  takeRerun(): number {
    const s = this.rerunAfter;
    this.rerunAfter = 0;
    return s;
  }

  // ── 查询：keyword 触发 → 产出结果（命中即独占返回）──
  async query(raw: string): Promise<LauncherResult[]> {
    this.ctx.clear();
    this.rerunAfter = 0;
    this.curKeyword = "";   // 上一次命中的关键词不能漏到这一次（脚本会读 alfred_workflow_keyword）
    const q = (raw || "").trim();
    if (!q) return [];
    for (const wf of this.workflows()) {
      // 被停用的触发器直接跳过：整条链路唤不起来（E6 节点禁用）。
      //
      // 关键词的拥有者有两种（**Script Filter 自带关键词是 Alfred 的形状**）：
      //   · trigger.keyword —— 老形状，关键词在上游触发器上，下游挂什么输入节点都行；
      //   · input.scriptfilter 自己填了关键词 —— 它就是自己的触发器，不用再连一个。
      // 两种并存、不做数据迁移：已有工作流一个字都不用改，新建的可以直接照 Alfred 摆。
      for (const trig of wf.nodes.filter((n) => keywordOwner(n) && !n.disabled)) {
        const kw = String(trig.config.keyword || "").trim();
        if (!kw) continue;
        // 缺省值**按节点类型分开**，必须和编辑器里那个下拉的缺省显示一致。
        // 老节点的 config.arg 是 undefined（用户没动过那个下拉就不会写进去），
        // 这时候引擎按 optional 走、界面却写着「必填参数」——
        // 于是敲个 `yd ` 空参数，界面说不会跑，脚本却跑了，还吐一条「查询为空」的报错。
        // Script Filter 跟 Alfred 一样默认 Argument Required；Keyword 触发器仍是可选。
        const argMode = String(trig.config.arg || defaultArgMode(trig.type)); // required | optional | none
        let arg = "";
        if (argMode === "none") {
          if (q.toLowerCase() !== kw.toLowerCase()) continue;
        } else {
          // withSpace（默认开）：关键词和参数之间要有空格。关掉后参数紧贴关键词也认 ——
          // 计算类关键词几乎都靠这个（cal2+2、tr你好），Alfred 也是把它做成开关而不是写死。
          const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = trig.config.withSpace === false
            ? new RegExp(`^${esc}([\\s\\S]*)$`, "i")
            : new RegExp(`^${esc}(?:\\s+([\\s\\S]+))?$`, "i");
          const m = q.match(re);
          if (!m) continue;
          // 空白修剪按节点的设置来（Alfred 的 Argument Whitespaces Trimming）。
          // 默认修剪：多打一个空格不该让脚本白跑一次（缓存键里带着 arg）。
          arg = trimArg(m[1] || "", trig.config.trimArg !== false);
          if (argMode === "required" && !arg) return [this.hintResult(wf, trig)]; // 提示待输入
        }
        this.curKeyword = kw;
        // 自带关键词的 Script Filter 就是自己的输入节点，不用顺着连线往下找。
        const target = trig.type === "input.scriptfilter"
          ? trig
          : this.outConns(wf, trig.id, "").map((c) => this.node(wf, c.to)).find(Boolean);
        const inputRes = target ? await this.runInput(wf, target, arg) : null;
        if (inputRes) {
          // Alfred 的 autocomplete 给的是「参数」部分，按 Tab 补全时要连关键词一起写回输入框。
          for (const r of inputRes) if (r.autocomplete) r.autocomplete = `${kw} ${r.autocomplete}`;
          return inputRes;
        }
        return [this.directResult(wf, trig, arg)]; // 直连动作
      }
    }
    return [];
  }

  // 「始终触发」工作流（无关键词，任意输入都尝试，如计算器/单位换算）：贡献到普通结果，不独占。
  async queryAlways(raw: string): Promise<LauncherResult[]> {
    this.rerunAfter = 0;
    this.curKeyword = "";   // 「始终触发」没有关键词，别让上一次的漏进来
    const q = (raw || "").trim();
    if (!q) return [];
    const out: LauncherResult[] = [];
    for (const wf of this.workflows()) {
      for (const trig of wf.nodes.filter((n) => n.type === "trigger.always" && !n.disabled)) {
        const target = this.outConns(wf, trig.id, "").map((c) => this.node(wf, c.to)).find(Boolean);
        const res = target ? await this.runInput(wf, target, q) : null;
        if (res) out.push(...res);
      }
    }
    return out;
  }

  // 输入节点分发 → 结果列表（非 input 节点返回 null，表示走「直连动作」）。
  private async runInput(wf: Workflow, node: WorkflowNode, arg: string): Promise<LauncherResult[] | null> {
    // 输入节点被停用 → 当作没有输入节点（走「直连动作」单条结果），执行时该节点也会被旁路。
    if (node.disabled) return null;
    switch (node.type) {
      case "input.scriptfilter": return this.runScriptFilter(wf, node, arg);
      case "input.listfilter": return this.runListFilter(wf, node, arg);
      case "input.codec": return this.runCodec(wf, node, arg);
      case "input.calc": return this.runCompute(wf, node, arg, "calc");
      case "input.units": return this.runCompute(wf, node, arg, "units");
      case "input.dict": return this.runDict(wf, node, arg);
      case "input.filefilter": return this.runFileFilter(wf, node, arg);
      case "input.appsfilter": return this.runRunningApps(wf, node, arg);
      default: return null;
    }
  }

  // 内置输入：List Filter —— 在节点里维护一张固定列表，按输入过滤后当结果给出来。
  // 和 Script Filter 的区别就是「不用写脚本」：菜单、预设、常用地址这类内容直接列进去。
  // 过滤规则（match）对齐 Alfred：
  //   word     = 从词首匹配（整条以输入开头，或任意一个空白分隔的词以输入开头）——默认
  //   contains = 任意位置包含
  //   none     = 不过滤，永远整表给出（配合上游关键词「无参数」用）
  private runListFilter(wf: Workflow, node: WorkflowNode, arg: string): LauncherResult[] {
    const rows = Array.isArray(node.config.items) ? (node.config.items as ListRow[]) : [];
    if (!rows.length) return [];
    const vars = this.baseVars(wf);
    const mode = String(node.config.match || "word");
    const q = (arg || "").trim().toLowerCase();
    const hit = (row: ListRow): boolean => {
      if (mode === "none" || !q) return true;
      const hay = `${row.title || ""} ${row.subtitle || ""}`.toLowerCase();
      if (mode === "contains") return hay.includes(q);
      return hay.split(/\s+/).some((w) => w.startsWith(q));
    };
    // 「参与使用频率学习」默认开：同一个关键词下常选的那项会被顶上来（靠 uid 记，不是靠位置）。
    const learn = node.config.learn !== false;
    const mods = this.branchMods(wf, node.id);
    const limit = Math.max(1, Math.min(Number(this.cfg.get().launcherMaxResults) || 12, 50));
    return rows.filter(hit).slice(0, limit).map((row, i) => {
      // 只有 arg 走占位替换：标题/副标题是给人看的，塞 {query} 会让过滤结果自相矛盾。
      const val = this.subst(String(row.arg ?? row.title ?? ""), arg, vars);
      const r = this.itemResult(wf, node.id, {
        title: String(row.title || val), subtitle: row.subtitle ? String(row.subtitle) : undefined,
        arg: val, uid: learn ? String(row.uid || row.title || i) : undefined,
      }, mods, { rank: i, noLearn: !learn });
      // 图标：带「/」的当文件路径去加载，否则当 emoji 直接用（列表里手写 emoji 是常态）。
      if (row.icon) r.icon = String(row.icon).includes("/")
        ? this.loadIcon(String(row.icon), wf.icon || "🧩", workflowDir(this.cfg.dir, wf.id))
        : String(row.icon);
      return r;
    });
  }

  // 内置输入：编解码（unicode / url / base64）。
  private runCodec(wf: Workflow, node: WorkflowNode, arg: string): LauncherResult[] {
    if (!arg) return [];
    const mode = String(node.config.mode || "unicode");
    const items = mode === "url" ? urlTransform(arg) : mode === "base64" ? base64Transform(arg) : unicodeTransform(arg);
    return items.map((it) => { const r = this.itemResult(wf, node.id, { title: it.value, subtitle: `${it.label} · 回车复制`, arg: it.value }, []); r.icon = wf.icon || "🔡"; r.score = 300; return r; });
  }
  // 内置输入：计算器 / 单位换算。
  private runCompute(wf: Workflow, node: WorkflowNode, arg: string, kind: "calc" | "units"): LauncherResult[] {
    if (kind === "calc") {
      const c = calc(arg);
      if (c === null) return [];
      const r = this.itemResult(wf, node.id, { title: `= ${c}`, subtitle: "计算结果 · 回车复制", arg: String(c) }, []);
      r.icon = wf.icon || "🔢"; r.score = 320; return [r];
    }
    const u = convertUnits(arg);
    if (!u) return [];
    const r = this.itemResult(wf, node.id, { title: u.title, subtitle: `${u.subtitle} · 回车复制`, arg: u.title }, []);
    r.icon = wf.icon || "📐"; r.score = 320; return [r];
  }

  // 内置输入：词典查询（macOS）。
  //
  // 只给一条「去词典里查这个词」的结果，**不内联释义**：拿到释义要调系统的
  // DictionaryServices 框架，Node 这边没有可靠的调用途径（osascript 拿不到，
  // 系统自带的 python3 也不一定有 pyobjc）。与其塞一个半残的假释义，不如老实
  // 把词送进词典 App —— 那本来就是用户查完词之后要去的地方。
  // 回车时若没接下游，run() 会走「节点自带默认动作」直接开词典。
  private runDict(wf: Workflow, node: WorkflowNode, arg: string): LauncherResult[] {
    const word = (arg || "").trim();
    if (!word || process.platform !== "darwin") return [];
    const r = this.itemResult(wf, node.id, {
      title: word,
      subtitle: `${String(node.config.hint || "在词典中查这个词")} · 回车打开词典`,
      arg: word,
      uid: "dict",   // 学习键固定：常用这条的人下次打首字母就该排在前面
    }, this.branchMods(wf, node.id));
    r.icon = wf.icon || "📖";
    r.score = 300;
    return [r];
  }

  // 内置输入：File Filter —— 按范围和类型搜本地文件，列成结果。
  // 检索本身在 filesearch.ts（macOS 走 Spotlight，其余走限定目录遍历），这里只管
  // 「怎么配」和「怎么显示」。选中一条时把**绝对路径**作为 arg 传给下游 ——
  // 下游最常接的是「打开文件」「在文件管理器中显示」「在终端中打开」，它们要的都是路径。
  private async runFileFilter(wf: Workflow, node: WorkflowNode, arg: string): Promise<LauncherResult[]> {
    const vars = this.baseVars(wf);
    const kw = this.subst(String(node.config.keyword || "{query}"), arg, vars).trim();
    // 要求至少有一个字：不设门槛的话，一进快捷入口就会拿空串去全盘搜。
    const min = Math.max(1, Number(node.config.minChars ?? 2));
    if (kw.length < min) return [];
    const scopes = String(node.config.scopes || "")
      .split("\n").map((x) => x.trim()).filter(Boolean);
    const hits = await searchFiles({
      keyword: kw,
      scopes,
      kind: (String(node.config.kind || "any") as FileKind),
      exts: parseExts(String(node.config.exts || "")),
      limit: Math.max(1, Math.min(Number(this.cfg.get().launcherMaxResults) || 12, 50)),
    });
    const mods = this.branchMods(wf, node.id);
    return hits.map((h, i) => {
      const r = this.itemResult(wf, node.id, {
        title: h.name,
        subtitle: h.path,
        arg: h.path,
        uid: h.path,             // 学习键用绝对路径：常开的那个文件下次会被顶上来
        quicklookurl: h.path,    // ⌘Y 直接预览，不用先打开
      }, mods, { rank: i });
      // 图标按真实文件取（loadIcon 认路径），取不到就退回工作流自己的图标
      r.icon = this.loadIcon(h.path, wf.icon || (h.dir ? "📁" : "📄"));
      return r;
    });
  }

  // 内置输入：Running Apps —— 列出当前在跑的应用，供切换或退出。
  //
  // 取列表走 System Events 的进程表，并且只要 `background only is false` 的 ——
  // 后台进程（各种守护、输入法、菜单栏代理）几十个，混进来只会把列表淹掉，
  // 而用户想切换/退出的永远是有窗口的那些。
  // 选中一条时 arg 是**应用名**；没接下游时由「节点自带默认动作」按配置切换或退出它。
  private async runRunningApps(wf: Workflow, node: WorkflowNode, arg: string): Promise<LauncherResult[]> {
    if (process.platform !== "darwin") return [];
    const names = await listRunningApps();
    if (!names.length) return [];
    const q = (arg || "").trim().toLowerCase();
    const hit = q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
    const quit = String(node.config.action || "switch") === "quit";
    const mods = this.branchMods(wf, node.id);
    const limit = Math.max(1, Math.min(Number(this.cfg.get().launcherMaxResults) || 12, 50));
    return hit.slice(0, limit).map((name, i) => {
      const r = this.itemResult(wf, node.id, {
        title: name,
        subtitle: quit ? "回车退出这个应用" : "回车切换到这个应用",
        arg: name,
        uid: name,   // 学习键用应用名：常切的那个下次会被顶上来
      }, mods, { rank: i });
      r.icon = wf.icon || (quit ? "🚪" : "🪟");
      return r;
    });
  }

  // 跑 Script Filter 脚本 → 解析 Alfred JSON → 结果列表。
  // 除 items 外，还认 Alfred 的三个顶层字段（W3 对齐）：
  //   · cache {seconds, loosereload}：同样的「脚本 + 参数」在 N 秒内直接复用上次输出，不再起进程；
  //     loosereload=true 时先返回旧的、同时后台重跑刷新缓存，下次查询就是新的；
  //   · rerun 0.1~5：让启动器过 N 秒自动再查一次（脚本产出「进行中」这类会变的结果时用）；
  //   · skipknowledge：本次结果不参与使用频率学习，完全按脚本给的顺序排。
  private async runScriptFilter(wf: Workflow, node: WorkflowNode, arg: string): Promise<LauncherResult[]> {
    const vars = this.baseVars(wf);
    const lang = langOf(node.config.lang);
    // 输入怎么进脚本（Alfred 的第二个下拉）：
    //   argv  —— 只作为位置参数传（$1 / sys.argv[1]）。**脚本正文一个字都不动**，
    //            里面写了 {query} 也当普通文本 —— Alfred 推荐这种，不用操心转义。
    //   query —— 把 {query} / {var:x} 直接替换进脚本正文。
    // 老节点没有这个字段：**默认 query**，保住它们原来的行为（以前是无条件替换）。
    // 新建节点时编辑器给 argv。
    const inputMode = String(node.config.inputMode || "query");
    const script = inputMode === "argv"
      ? String(node.config.script || "")
      : this.subst(String(node.config.script || ""), arg, vars);

    // cwd 缺省就是本工作流自己的目录 —— 脚本才能写 ./runtime/txiki ./index.js 这种相对路径。
    const dir = await ensureWorkflowDir(this.cfg.dir, wf.id);
    const cwd = resolveCwd(dir, String(node.config.cwd || ""), expandHome);
    const env: Record<string, string> = { ...workflowEnv(dir, wf.id, wf.name) };
    for (const [k, v] of Object.entries(vars)) env[k] = String(v ?? "");
    env.query = arg;
    // Alfred 的 Script Filter 专属变量：一个节点挂多个关键词时，脚本靠它知道用户敲的是哪个。
    if (this.curKeyword) env.alfred_workflow_keyword = this.curKeyword;

    // 「由 Umbra 过滤结果」勾上时，**脚本只跑一次**（Alfred 的原话就是这个意思：
    // 让 Alfred 来筛，而不是每多敲一个字符就重跑一遍脚本）。所以缓存键里不带 arg，
    // 脚本也拿不到 arg —— 它本来就该一次吐出全量结果。
    const filtersHere = !!node.config.alfredFilters;
    const scriptArg = filtersHere ? "" : arg;
    const key = `${wf.id}\n${node.id}\n${cwd || ""}\n${scriptArg}\n${lang.id}\n${script}`;

    const hit = this.sfCache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl * 1000) {
      // 缓存还新鲜：本次不起进程。loosereload 时顺手在后台重跑刷新缓存（不影响本次返回的内容）。
      if (hit.loose) void this.execScriptFilter(wf, node, scriptArg, script, lang, cwd, dir, env, vars, key).catch(() => {});
      return this.buildScriptFilter(wf, node, arg, hit.out);
    }
    // 队列延迟（Alfred 的 Queue Delay）：等待期间用户又敲了字就把这一次丢掉。
    // 由 Umbra 过滤时不需要延迟 —— 反正只跑一次，后续按键全走缓存。
    //
    // 老节点只有 debounceMs 这一个数字（这个节点早先的做法）。没写 queueDelay 时
    // 就按它来，别把用户特意调过的值悄悄换成「自动」。
    const legacyMs = Number(node.config.debounceMs ?? 0) || 0;
    const delay = String(node.config.queueDelay || (legacyMs > 0 ? "custom" : "auto")) as QueueDelay;
    const customMs = Number(node.config.queueDelayMs ?? 0) || legacyMs;
    const wait = filtersHere ? 0 : queueWaitMs(delay, customMs, arg.length);
    const seqKey = `${wf.id}\n${node.id}`;
    if (wait > 0) {
      const mine = (this.sfSeq.get(seqKey) || 0) + 1;
      this.sfSeq.set(seqKey, mine);
      await new Promise((r) => setTimeout(r, wait));
      if (this.sfSeq.get(seqKey) !== mine) return [];
    }
    // 队列模式（Alfred 的 Queue Mode）：
    //   terminate —— 把上一次还在跑的脚本杀掉再起新的（默认，输入中的结果本来就作废了）；
    //   wait      —— 等上一次跑完。脚本有副作用（写文件、发请求）时必须选这个。
    const queueMode = String(node.config.queueMode || "terminate");
    const prev = this.sfRunning.get(seqKey);
    if (prev) {
      if (queueMode === "wait") await prev.done.catch(() => {});
      else {
        // 标记之后再杀。**顺序不能反**：kill 之后 run() 会立刻带着残缺输出和
        // 非零退出码 resolve，那一路会去造一条「脚本出错」的报错卡 ——
        // 而这次运行是我们自己主动掐掉的，用户只是多打了一个字符。
        // 搬有道翻译时看到的「Exception ignored on flushing sys.stdout」就是这么来的：
        // 登录 shell 启动时跑的 python（conda 之类）被我们杀掉，临死前叫了一声，
        // 那声音被当成了脚本的输出。
        prev.killed = true;
        try { prev.child?.kill(); } catch { /* 已经退了 */ }
      }
    }
    // **先占位再起进程**：run() 里 spawn 是同步的，onSpawn 会在 execScriptFilter
    // 返回之前就回调。等拿到 promise 再 set 的话，那一下回调找不到自己的格子，
    // child 就永远是 undefined —— terminate 模式于是变成了静默的 no-op。
    const entry: SfRun = { done: Promise.resolve("") };
    this.sfRunning.set(seqKey, entry);
    entry.done = this.execScriptFilter(wf, node, scriptArg, script, lang, cwd, dir, env, vars, key, seqKey, entry);
    const r = await entry.done;
    return typeof r === "string" ? this.buildScriptFilter(wf, node, arg, r) : r;
  }

  // 真正起进程跑 Script Filter 脚本：成功返回 stdout，失败返回一条错误结果（外层原样透传给列表）。
  // 顺带记调试轨迹，并按脚本声明的 cache 写入缓存。
  private async execScriptFilter(
    wf: Workflow, node: WorkflowNode, arg: string, script: string,
    lang: ReturnType<typeof langOf>, cwd: string, dir: string,
    env: Record<string, string>, vars: Record<string, string>, key: string,
    seqKey?: string, entry?: SfRun,
  ): Promise<string | LauncherResult[]> {
    // 调试轨迹：Script Filter 在「查询」阶段就跑脚本，单独记成一次运行（W8 调试抽屉）。
    const tr = this.trace.begin(wf.id, wf.name, "Script Filter 查询", arg);
    const st = this.trace.stepStart(tr, node.id, node.type, arg, vars);
    const startedAt = Date.now();
    let stderr = "";
    let spawned = "";
    let res;
    try {
      // 非 shell 语言把脚本落成一个临时文件再跑。**不能拼进命令行参数**：
      // 脚本正文里必然有引号、换行、中文，拼进去迟早被截断，而且每种 shell
      // 的转义规则还不一样（AppleScript 上踩过这个）。
      let file: string | undefined;
      if (lang.via === "file") {
        file = path.join(os.tmpdir(), tempScriptName(lang, node.id));
        await fs.writeFile(file, script, "utf-8");
      } else if (lang.via === "path") {
        file = resolveExternal(dir, String(node.config.script || ""));
        if (!file) throw new Error("外部脚本没填路径");
      }
      const sp = buildSpawn(lang, script, arg, file);
      // 命令行和工作目录记进轨迹：排查「脚本找不到文件」时，第一个要排除的就是
      // 「是不是 cwd 不对」，而在此之前调试抽屉里根本看不到它。
      spawned = `${sp.cmd} ${sp.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
      res = await run(sp.cmd, sp.args, {
        timeoutMs: SCRIPT_TIMEOUT, cwd, env, onStderr: (c) => { stderr += c; },
        // 拿到子进程句柄，好让「终止上一次」的队列模式能真的杀掉它。
        onSpawn: (child) => { if (entry) entry.child = child; },
      });
    } catch (e) {
      this.trace.stepEnd(st, startedAt, { error: `脚本启动失败：${String(e)}`, stderr, cmd: spawned, cwd });
      this.trace.end(tr);
      this.clearRunning(seqKey, entry);
      return [this.errResult(wf.name, `脚本启动失败：${String(e).slice(0, 50)}`)];
    }
    this.clearRunning(seqKey, entry);
    // 这一轮已经被新的输入掐掉了 —— 残缺的输出和非零退出码都不作数，安静退场。
    // 不这么做的话，用户每多打一个字符就会闪一条「脚本出错」的红卡：
    // 那不是脚本的错，是我们自己按队列模式把它掐了。
    if (entry?.killed) {
      this.trace.stepEnd(st, startedAt, { outArg: "", stdout: "", stderr, feedback: "被新的输入取消" });
      this.trace.end(tr);
      return [];
    }
    const out = (res.output || "").trim();
    let data: SFOutput;
    try {
      data = JSON.parse(out) as SFOutput;
    } catch {
      // **报错要说清是哪个文件/哪一行**。原来一律砍到 60 字符，
      // 而路径恰恰在后半句 —— 「no such file or director」这种半截话
      // 等于什么都没说，用户只能一遍遍瞎试。
      const head = firstLine(out);
      const msg = res.code !== 0 ? `脚本出错：${head}` : `输出非 JSON：${head}`;
      // 「找不到文件」时**去运行目录里真查一遍**，指名道姓说缺哪个。
      // 解释器给的报错常常连路径都不带（txiki 就一句 no such file or directory），
      // 不查的话用户只能一个个试。只在出错这条路上做，正常查询不多花一次 I/O。
      const hint = looksLikeMissingFile(out)
        ? await this.missingFileHint(String(node.config.script || ""), cwd)
        : "";
      this.trace.stepEnd(st, startedAt, { outArg: out, stdout: out, stderr, exitCode: res.code ?? undefined, error: msg, cmd: spawned, cwd });
      this.trace.end(tr);
      return [this.errResult(wf.name, msg, hint || scriptErrHint(wf.name, out, cwd))];
    }
    this.trace.stepEnd(st, startedAt, { outArg: out, stdout: out, stderr, exitCode: res.code ?? undefined, cmd: spawned, cwd });
    this.trace.end(tr);
    // 缓存只在真跑过之后写：命中缓存的那条路径不刷新时间戳，免得缓存被无限续命。
    const sec = Number(data.cache?.seconds || 0);
    if (sec >= 1) this.putSfCache(key, out, Math.min(sec, 86400), data.cache?.loosereload === true);
    // 「由 Umbra 过滤结果」的**关键一步**：把这次输出存下来，后续按键才走得到缓存。
    // 不存的话每敲一个字符照样起一个进程 —— 那这个开关就只是换了个过滤器，
    // 而它真正的意义（Alfred 的原话）恰恰是「跑一次，剩下的交给我筛」。
    // 用短 TTL 不用永久：脚本的数据也会变（汇率、待办列表），一直不刷新反而更糟。
    else if (node.config.alfredFilters) this.putSfCache(key, out, FILTER_SESSION_TTL / 1000, false);
    return out;
  }

  // 脚本里写的相对路径，哪些在运行目录里根本不存在。返回一句能直接显示的话。
  // 全都在（或一条相对路径都没写）就返回空串，交给通用提示。
  private async missingFileHint(script: string, cwd: string): Promise<string> {
    const rels = relativePathsIn(script);
    const missing: string[] = [];
    for (const r of rels) {
      try { await fs.access(path.resolve(cwd, r)); } catch { missing.push(r); }
    }
    if (missing.length) return `运行目录里没有 ${missing.slice(0, 3).join("、")} —— 把 Alfred 那边的文件整包拷进去`;
    // 相对路径全都在，那这个 ENOENT 多半根本不是文件的事。
    //
    // **「no such file or directory」是 errno ENOENT 的标准字符串，不止用于文件。**
    // 最典型的一种：txiki / libuv 的 uv_os_getenv 读不到环境变量时返回 UV_ENOENT，
    // 运行时照 errno 翻成同一句话 —— 于是「变量没配」看着像「文件没拷」。
    // 2026-08-10 搬有道翻译时就是被这句话带偏了好几轮：脚本读的是 key/secret/platform，
    // 而变量表里配的是 youdaoAppKey/youdaoSecret，名字对不上。
    // 所以这里**不许说「文件拷进去了吗」** —— 已经查过了，文件都在。
    return "脚本里的相对路径都在。这句话是 errno ENOENT，不一定指文件 —— "
      + "也可能是脚本读了一个没配的环境变量（先对一下「变量表」里的名字）";
  }

  // 收尾时**只清掉自己那一格**：新的一轮可能已经把格子换掉了（terminate 模式下
  // 老的那次被杀掉、收尾晚于新的那次开跑），无条件 delete 会把新的一次误删。
  private clearRunning(seqKey?: string, entry?: SfRun): void {
    if (!seqKey || !entry) return;
    if (this.sfRunning.get(seqKey) === entry) this.sfRunning.delete(seqKey);
  }

  // 写 Script Filter 缓存，顺手把最旧的挤出去（上限 100 条）。
  private putSfCache(key: string, out: string, ttl: number, loose: boolean): void {
    this.sfCache.delete(key);
    this.sfCache.set(key, { out, at: Date.now(), ttl, loose });
    while (this.sfCache.size > 100) {
      const oldest = this.sfCache.keys().next().value;
      if (oldest === undefined) break;
      this.sfCache.delete(oldest);
    }
  }

  // 解析脚本输出 → 结果列表（缓存命中和真跑走的是同一段逻辑，保证两条路径表现一致）。
  private buildScriptFilter(wf: Workflow, node: WorkflowNode, arg: string, out: string): LauncherResult[] {
    let data: SFOutput;
    try {
      data = JSON.parse(out) as SFOutput;
    } catch {
      return [this.errResult(wf.name, `输出非 JSON：${firstLine(out)}`)];
    }
    // rerun：Alfred 限定 0.1~5 秒，超出范围就夹到边界，避免脚本写个 0.001 把 CPU 打满。
    const rr = Number(data.rerun || 0);
    if (rr > 0) this.rerunAfter = Math.min(5, Math.max(0.1, rr));
    let items = Array.isArray(data.items) ? data.items : [];
    // 「由 Umbra 过滤结果」：本地按 match（没有就退回 title）筛，规则照 Alfred 的四种匹配模式。
    // 默认「从词首或空白处精确匹配」—— 和 Alfred 的默认一致。
    // 原来写死的是「任意位置包含」，那个连 amily 都能命中 My Family Photos，太松。
    if (node.config.alfredFilters && arg) {
      const mode = String(node.config.matchMode || "boundary") as MatchMode;
      items = items.filter((it) => matchItem(mode, String(it.match || it.title || ""), arg));
    }
    const mods = this.branchMods(wf, node.id);
    // 取用上限跟随设置（launcherMaxResults），不再硬编码 12 条。
    const limit = Math.max(1, Math.min(Number(this.cfg.get().launcherMaxResults) || 12, 50));
    return items.slice(0, limit).map((it, i) => this.itemResult(wf, node.id, it, mods, {
      rank: i, noLearn: data.skipknowledge === true, baseVars: data.variables || {},
    }));
  }

  // Script Filter item → LauncherResult（缓存上下文）。
  // opts.rank：脚本给的原始次序 —— 分数按名次微降（160、159.9、159.8…），
  //   既保住脚本自己的排序，又让「使用频率加权」（一次 +25 起）能把常用项顶上来。
  //   以前所有工作流结果都写死 150，脚本排前排后完全体现不出来。
  // opts.noLearn：脚本声明了 skipknowledge，本次结果不参与频率学习。
  // opts.baseVars：脚本输出顶层 variables，作为每个 item 的基础变量（item 自己的同名键覆盖它）。
  private itemResult(
    wf: Workflow, srcNodeId: string, it: AlfredItem, mods: string[],
    opts: { rank?: number; noLearn?: boolean; baseVars?: Record<string, string> } = {},
  ): LauncherResult {
    const arg = Array.isArray(it.arg) ? it.arg.join("\n") : String(it.arg ?? it.title ?? "");
    const token = this.store({
      wfId: wf.id, srcNodeId, arg,
      variables: { ...(opts.baseVars || {}), ...(it.variables || {}) },
      valid: it.valid !== false, mods: it.mods || {},
    });
    const r: LauncherResult = {
      id: token, title: String(it.title ?? arg), subtitle: it.subtitle ? String(it.subtitle) : `${wf.name} · 回车执行`,
      icon: this.loadIcon(it.icon?.path, wf.icon || "🧩", workflowDir(this.cfg.dir, wf.id)), source: "workflow",
      score: opts.rank === undefined ? 150 : 160 - opts.rank * 0.1,
      action: { kind: "workflow", payload: { token } }, mods,
    };
    // uid：Alfred 用它记住「这个查询下你更常选哪一项」。token 每次查询都在变，
    // 拿它当学习键等于永远学不会，所以频率学习一律走 uid（脚本没给 uid 就不学）。
    if (it.uid && !opts.noLearn) r.learnId = `wf:${wf.id}:${srcNodeId}:${it.uid}`;
    if (opts.noLearn) r.noLearn = true;
    if (it.autocomplete) r.autocomplete = String(it.autocomplete);
    if (it.quicklookurl) r.quicklook = String(it.quicklookurl);
    return r;
  }

  // 直连动作（Keyword→Action，无 Script Filter）：单条结果。
  private directResult(wf: Workflow, trig: WorkflowNode, arg: string): LauncherResult {
    const mods = this.branchMods(wf, trig.id);
    const token = this.store({ wfId: wf.id, srcNodeId: trig.id, arg, variables: {}, valid: true, mods: {} });
    const title = String(trig.config.title || wf.name);
    return {
      id: token, title, subtitle: arg ? `输入：${arg.slice(0, 40)} · 回车执行` : `${wf.name} · 回车执行`,
      icon: wf.icon || "🧩", source: "workflow", score: 150,
      action: { kind: "workflow", payload: { token } }, mods,
      // 直连动作没有 uid 可用，但「工作流+触发器」本身就是稳定的一项，可以直接拿来学习。
      learnId: `wf:${wf.id}:${trig.id}`,
    };
  }

  // 「必填参数」但用户还没打字时占位的那一条。
  // 标题/副标题走节点自己的 Placeholder 配置（Alfred 的 Placeholder Title / Subtext），
  // 没配才退回工作流名 —— 一个只会显示工作流名的占位行等于什么都没说。
  private hintResult(wf: Workflow, trig: WorkflowNode): LauncherResult {
    const token = this.store({ wfId: wf.id, srcNodeId: trig.id, arg: "", variables: {}, valid: false, mods: {}, hintOnly: true });
    return {
      id: token,
      title: String(trig.config.title || wf.name),
      subtitle: String(trig.config.subtitle || "输入内容后回车…"),
      icon: wf.icon || "🧩", source: "workflow", score: 150, action: { kind: "workflow", payload: { token } },
      noLearn: true,   // 「请输入内容」只是占位提示，不该被记成一次使用
    };
  }
  private errResult(name: string, msg: string, detail?: string): LauncherResult {
    const token = this.store({ wfId: "", srcNodeId: "", arg: "", variables: {}, valid: false, mods: {}, hintOnly: true });
    return {
      id: token, title: msg, subtitle: detail || `${name} · 工作流`, icon: "⚠️", source: "workflow", score: 150,
      action: { kind: "workflow", payload: { token } }, noLearn: true,
      wrap: true,   // 报错要看全，别省那两行高度
    };
  }

  private store(c: ItemCtx): string {
    const token = `wf:${c.wfId}:${c.srcNodeId}:${this.seq++}`;
    this.ctx.set(token, c);
    return token;
  }

  // 图标：文件路径 → dataURL；否则用 emoji 兜底。
  // baseDir：**相对路径按它解析**。Alfred 的 item.icon.path 写的就是
  // "assets/translate.png" 这种相对工作流目录的路径 —— 不给基准目录的话，
  // nativeImage 会拿它去相对进程的当前目录找，必然找不到，于是所有结果都退回
  // 工作流的默认图标（那个绿色拼图）。搬有道翻译时就是这样，一整列全是拼图。
  private loadIcon(p: string | undefined, fallback: string, baseDir?: string): string {
    if (!p) return fallback;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { nativeImage } = require("electron") as typeof import("electron");
      const abs = expandHome(p);
      const full = path.isAbsolute(abs) || !baseDir ? abs : path.join(baseDir, abs);
      const img = nativeImage.createFromPath(full);
      if (!img.isEmpty()) return img.resize({ width: 32, height: 32 }).toDataURL();
    } catch { /* 加载失败用兜底 */ }
    return fallback;
  }

  // ── 执行：沿修饰键分支跑动作链 ──
  // 返回：提示文案（渲染层弹 toast）；NO_BRANCH=该修饰键无分支（上层兜底）。
  async run(token: string, mod: string): Promise<string> {
    const c = this.ctx.get(token);
    if (!c) return "";
    if (c.hintOnly || !c.valid) return c.hintOnly ? "" : "该项不可执行";
    const wf = this.workflows().find((w) => w.id === c.wfId);
    if (!wf) return "";
    const m = (mod || "").toLowerCase();
    const modData = c.mods[m];
    const arg = modData?.arg ?? c.arg;
    const vars = { ...this.baseVars(wf), ...c.variables, ...(modData?.variables || {}) };
    const conns = this.outConns(wf, c.srcNodeId, m);
    if (!conns.length) {
      if (m !== "") return NO_BRANCH;           // 修饰键无分支 → 上层兜底
      if (!arg) return "";
      // 回车且无下游：先看这个来源节点有没有「自带默认动作」，没有才退回复制 arg。
      // 目前只有词典查询一个（它单独存在就有意义，不该逼用户再挂一个「打开网址」）。
      const self = this.node(wf, c.srcNodeId);
      if (self?.type === "input.dict") return openDictionary(arg);
      if (self?.type === "input.appsfilter") {
        return controlApp(arg, String(self.config.action || "switch") === "quit");
      }
      const { clipboard } = await import("electron");
      clipboard.writeText(arg);
      return "已复制 ✓";
    }
    const visited = new Set<string>();
    // 调试轨迹：一次「选中结果并回车/修饰键执行」= 一条运行记录。
    const tr = this.trace.begin(wf.id, wf.name, m ? `${m} 分支` : "回车", arg);
    const rc = this.uiCtx();   // 人刚在快捷入口挑了一项，屏幕前一定有人
    let fb = "";
    try {
      for (const conn of conns) fb = (await this.runNode(wf, conn.to, arg, vars, visited, rc, tr)) || fb;
    } finally {
      this.trace.end(tr);   // 中途抛异常也要把已记录的步数留下，否则最需要看的那次反而丢了
    }
    return fb;
  }

  // 执行单个节点，随后把「输出 arg」传给所有下游（回车分支）——支持链式(a→b→c)与扇出(a→b, a→c)多节点参数传递。
  // varsIn 在入口处复制一份：本节点写入的变量对自己的下游可见，但不会污染兄弟分支。
  // tr：本次运行的调试轨迹（W8），一路往下传而不是存在实例上，避免并发执行互相串台。
  // fan：当前所处的扇出批次（上游有 Split 且走「参数列表」输出时才非空），同样一路往下传给 Join 用。
  // override：上游的 JSON Config 节点用 {"alfredworkflow":{"config":{…}}} 临时改写本节点的配置。
  // 只对**这一次执行**生效，所以是拷一份 node 再合并，绝不去动存着的那份配置。
  // rc：这次运行的上下文（有人在看 / 没人在看）。**必传**，不给默认值 ——
  // 给了默认值就等于「忘了传的地方悄悄当成有人在看」，而那正是会往用户前台应用里乱发按键的情形。
  private async runNode(wf: Workflow, nodeId: string, arg: string, varsIn: Record<string, string>, visited: Set<string>, rc: RunCtx, tr: TraceRun | null = null, fan: FanCtx | null = null, override: Record<string, unknown> | null = null): Promise<string> {
    if (visited.has(nodeId)) return "";  // 防环
    visited.add(nodeId);
    const stored = this.node(wf, nodeId);
    if (!stored) return "";
    const node = override ? { ...stored, config: { ...stored.config, ...override } } : stored;
    const vars = { ...varsIn };
    // 节点被停用（E6）→ 旁路：不执行自身逻辑，入参原样从默认出口继续往下传。
    if (node.disabled) {
      const skipAt = Date.now();
      const skipStep = this.trace.stepStart(tr, node.id, node.type, arg, vars);
      this.trace.stepEnd(skipStep, skipAt, { outArg: arg, skipped: true });
      let fb = "";
      for (const c of this.outConns(wf, nodeId, "", "")) {
        const r = await this.runNode(wf, c.to, arg, vars, visited, rc, tr, fan);
        if (r) fb = r;
      }
      return fb;
    }
    const { clipboard, Notification } = await import("electron");
    let feedback = "";
    let outArg = arg;   // 默认把 arg 原样传给下游
    let outPort = "";   // 从哪个出口往下继续（多出口节点会改写：conditional 的 r0/else、脚本失败的 error）
    let stop = false;   // 是否就此终止本条链路（不再往下游传）
    // JSON Config 用：要覆盖到下游节点配置上的字段（只影响紧接着的那一层）
    let cfgOverride: Record<string, unknown> | null = null;
    // Split / Join 用：fanItems 非空表示本节点要把下游按项逐条跑一遍；
    // hold=true 表示 Join 还没收齐、这一项到此为止；fanOut 是传给下游的扇出批次（Join 合并后回到外层）。
    let fanItems: string[] | null = null;
    let fanOut: FanCtx | null = fan;
    let hold = false;
    // 调试轨迹用：脚本类节点的输出与退出码，跑完一并写进这一步。
    let stdout: string | undefined;
    let stderr: string | undefined;
    let exitCode: number | undefined;
    const step = this.trace.stepStart(tr, node.id, node.type, arg, vars);
    const startedAt = Date.now();
    // 无人在看时的策略拦截。先记进轨迹再中断 —— 调用方和事后看记录的人都得能分清
    // 「被策略拦下」和「跑到一半没了」，后者是要去查 bug 的，前者是设计如此。
    if (rc.surface === "headless" && HEADLESS_BLOCK[node.type]) {
      const why = HEADLESS_BLOCK[node.type];
      this.trace.stepEnd(step, startedAt, { outArg: arg, error: `无人在看时不执行：${why}`, stopped: true });
      return `这条链路里的「${BLOCKED_LABEL[node.type] || node.type}」需要有人在场：${why}`;
    }
    try {
    switch (node.type) {
      // ── 工具：Args & Vars —— 改写下游 arg，并写入/覆盖变量（整个工作流的地基节点）──
      case "utility.args": {
        const mode = String(node.config.argMode || "keep");   // keep=沿用上游 | set=用模板改写 | clear=清空
        if (mode === "set") outArg = this.subst(String(node.config.text || ""), arg, vars);
        else if (mode === "clear") outArg = "";
        const kv = (node.config.vars || {}) as Record<string, string>;
        for (const [k, v] of Object.entries(kv)) {
          const key = String(k || "").trim();
          if (key) vars[key] = this.subst(String(v ?? ""), outArg, vars);
        }
        break;
      }

      // ── 工具：Conditional —— 逐条规则求值，命中第 i 条走 "r{i}" 出口，全不中走 "else" 出口 ──
      case "utility.conditional": {
        const rules = Array.isArray(node.config.rules) ? (node.config.rules as Record<string, unknown>[]) : [];
        let hit = -1;
        for (let i = 0; i < rules.length; i++) {
          if (this.matchRule(rules[i] || {}, arg, vars)) { hit = i; break; }
        }
        // 命中的出口若没连线，下面的循环取不到连线，链路自然终止——不会回退到默认出口。
        outPort = hit >= 0 ? `r${hit}` : "else";
        break;
      }

      // ── 工具：Transform —— 对 arg 或指定变量做大小写 / 编解码变换 ──
      case "utility.transform": {
        const target = String(node.config.target || "").trim();   // 空=作用于 arg，否则作用于该变量
        const done = this.transformText(target ? (vars[target] ?? "") : arg, String(node.config.mode || "upper"));
        if (target) vars[target] = done; else outArg = done;
        break;
      }

      // ── 工具：Replace —— 字符串 / 正则替换，可作用于 arg 或指定变量 ──
      case "utility.replace": {
        const target = String(node.config.target || "").trim();
        const src = target ? (vars[target] ?? "") : arg;
        const find = String(node.config.find || "");
        const to = String(node.config.to || "");
        let done = src;
        if (find) {
          // 非正则模式也走 RegExp（转义后），这样「忽略大小写」对两种模式都生效。
          const pattern = node.config.regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          try { done = src.replace(new RegExp(pattern, "g" + (node.config.ci ? "i" : "")), to); }
          catch { feedback = "替换失败：正则表达式不合法"; }
        }
        if (target) vars[target] = done; else outArg = done;
        break;
      }

      // ── 工具：Split 拆分参数 —— 把一条参数按分隔符拆成多条 ──
      // 两种输出方式：
      //   vars（变量）：拆出的项写成 {prefix}1..{prefix}N 加一个 {prefix}Count，arg 原样透传，链路仍是单条；
      //   args（参数列表）：下游按拆出的项逐条跑一遍（扇出），串行执行、保持原顺序，末端可用 Join 合回一条。
      case "utility.split": {
        const sep = delimOf(String(node.config.with || "comma"), String(node.config.custom || ""));
        let items = splitBy(arg, sep);
        if (node.config.trim !== false) items = items.map((s) => s.trim());   // 默认去掉每项两端空白
        if (node.config.discardEmpty) items = items.filter((s) => s !== "");  // 默认保留空项（和 Alfred 一致）
        if (items.length > MAX_FAN) {
          feedback = `拆出 ${items.length} 项，超出上限只取前 ${MAX_FAN} 项`;
          items = items.slice(0, MAX_FAN);
        }
        if (String(node.config.output || "vars") === "args") {
          fanItems = items;
          stdout = `拆出 ${items.length} 项，下游逐条执行`;
        } else {
          const prefix = String(node.config.prefix || "split").trim() || "split";
          for (let i = 0; i < items.length; i++) vars[`${prefix}${i + 1}`] = items[i];
          vars[`${prefix}Count`] = String(items.length);
          stdout = `拆出 ${items.length} 项 → ${prefix}1..${prefix}${items.length}`;
        }
        break;
      }

      // ── 工具：Join 合并参数 —— 把 Split 扇出的多条参数并回一条 ──
      // 不在扇出里（上游没接 Split，或 Split 走的是变量输出）时直接透传，和 Alfred「单项则原样通过」一致。
      // 在扇出里：前 N-1 项只往桶里收、不再往下走，最后一项把桶里的内容用分隔符连成一条交给下游。
      // 已知取舍：中途某一项被 Conditional 之类拦掉就不会进桶（那一项丢失）；若最后一项压根没走到这里，
      // 整批都不会输出。这是「按到达顺序收集」换来的简单，链路里有条件分支时要留意。
      case "utility.join": {
        if (!fan) { stdout = "不在拆分批次里，原样透传"; break; }
        const box = fan.bucket.get(node.id) || [];
        box.push(arg);
        fan.bucket.set(node.id, box);
        if (fan.index < fan.total - 1) {
          hold = true;
          stdout = `已收集 ${box.length}/${fan.total} 项，等后面的项`;
          break;
        }
        const sep = delimOf(String(node.config.with || "newline"), String(node.config.custom || ""));
        outArg = box.join(sep);
        fan.bucket.delete(node.id);
        fanOut = fan.parent;   // 合并完就不在这一批里了，回到外层扇出（没有外层则回到普通单条链路）
        stdout = `合并 ${box.length} 项`;
        break;
      }

      // ── 工具：Debug 打点 —— 往调试轨迹里写一行文本，链路本身照常往下走 ──
      // 文本走 stdout 字段，调试抽屉里就在这个节点下面显示，和脚本输出一个位置。
      case "utility.debug": {
        // 「清空本工作流的调试记录」：只清这条工作流之前的运行，本次运行还没入队，不受影响。
        if (node.config.clear) this.trace.clear(wf.id);
        const text = this.substDebug(String(node.config.text ?? "{query}"), arg, vars);
        stdout = text;
        // after=pass（默认）入参原样传给下游；after=replace 把打点文本当作下游 arg。
        if (String(node.config.after || "pass") === "replace") outArg = text;
        break;
      }

      // ── 工具：Junction 汇流点 —— 纯理线用，什么都不做 ──
      // 存在的意义只有一个：让多条连线先并到一个点上，再从这里出一条到下游，
      // 画布上不用画一把交叉的线。参数、变量、出口一律原样透传。
      case "utility.junction":
        break;

      // ── 工具：Filter 过滤 —— 条件不满足就整条中断（Conditional 的单出口版）──
      // 逐条判断，**任一命中即放行**；一条都不中就 stop，下游不再执行。
      // 没配规则时一律放行 —— 空规则当成「不过滤」，比当成「全拦」更符合直觉，
      // 也不会让刚拖上画布还没配的节点把整条链路憋死。
      case "utility.filter": {
        const rules = Array.isArray(node.config.rules) ? (node.config.rules as Record<string, unknown>[]) : [];
        if (rules.length) {
          const pass = rules.some((r) => this.matchRule(r || {}, arg, vars));
          if (!pass) {
            stop = true;
            feedback = "";   // 被过滤掉是正常结果，不弹提示（弹了反而像出错）
          }
        }
        break;
      }

      // ── 工具：Random 随机值 —— 生成随机数 / UUID / 随机串，写进 arg 或某个变量 ──
      // 复用占位符系统里的 randomToken()，两处行为天然一致：改一处就是改两处。
      case "utility.random": {
        const mode = String(node.config.mode || "range");
        let param = "";
        if (mode === "range") {
          // 顺序写反了（100-1）也认，省得用户对着一个空结果找半天。
          const a = Math.trunc(Number(node.config.min ?? 1));
          const b = Math.trunc(Number(node.config.max ?? 100));
          param = `${Math.min(a, b)}-${Math.max(a, b)}`;
        } else if (mode === "uuid") {
          param = "uuid";
        } else if (mode === "list") {
          // 从自填的列表里随机挑一项（一行一项）。占位符照常展开，所以列表本身也能是动态的。
          const items = this.subst(String(node.config.list || ""), arg, vars)
            .split("\n").map((x) => x.trim()).filter(Boolean);
          if (!items.length) { feedback = "随机值：列表是空的"; stop = true; break; }
          const picked = items[Math.floor(Math.random() * items.length)];
          const t = String(node.config.target || "").trim();
          if (t) vars[t] = picked; else outArg = picked;
          break;
        } else {
          // hex / str：长度夹在 1..64，太长没意义、也怕有人手滑填个几百万
          const len = Math.max(1, Math.min(64, Math.trunc(Number(node.config.length ?? 8)) || 8));
          param = `${mode}${len}`;
        }
        const value = randomToken(param);
        const target = String(node.config.target || "").trim();
        if (target) vars[target] = value; else outArg = value;
        break;
      }

      // ── 工具：JSON Config —— 用一段 JSON 一次性设置多个变量 ──
      // 先 parse 再对每个值做占位符替换（而不是先替换整段文本再 parse）：
      // 值里带引号或换行时，先替换会把 JSON 结构本身撑坏。
      // 值不是字符串的（数字/布尔/嵌套对象）一律转成字符串 —— 变量表只存字符串。
      case "utility.jsonconfig": {
        const raw = String(node.config.json || "").trim();
        if (!raw) break;   // 没填就什么都不做，不算错
        let parsed: unknown;
        try { parsed = JSON.parse(raw); }
        catch { feedback = "JSON Config：内容不是合法 JSON"; stop = true; break; }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          feedback = "JSON Config：最外层要是一个对象（{\"变量名\": \"值\"}）";
          stop = true;
          break;
        }
        // 两种写法都认：
        //   1. 裸对象 {"a":"1"} —— 每个键当一个变量（简写，最常用）
        //   2. Alfred 包裹 {"alfredworkflow":{"arg":..,"variables":{..},"config":{..}}}
        //      其中 config 覆盖**紧接着的下游节点**的配置字段 —— 这才是它叫 JSON Config 的由来：
        //      能在运行时改下游节点的设置（比如按变量决定 Open URL 打开哪个地址）。
        const wrapped = (parsed as Record<string, unknown>).alfredworkflow;
        if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
          const w = wrapped as Record<string, unknown>;
          if (typeof w.arg === "string") outArg = this.subst(w.arg, arg, vars);
          if (w.variables && typeof w.variables === "object" && !Array.isArray(w.variables)) {
            for (const [k, v] of Object.entries(w.variables as Record<string, unknown>)) {
              const key = k.trim();
              if (key) vars[key] = this.subst(typeof v === "string" ? v : JSON.stringify(v), arg, vars);
            }
          }
          if (w.config && typeof w.config === "object" && !Array.isArray(w.config)) {
            cfgOverride = {};
            for (const [k, v] of Object.entries(w.config as Record<string, unknown>)) {
              cfgOverride[k] = typeof v === "string" ? this.subst(v, arg, vars) : v;
            }
          }
          break;
        }
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          const key = k.trim();
          if (!key) continue;
          const text = typeof v === "string" ? v : JSON.stringify(v);
          vars[key] = this.subst(text, arg, vars);
        }
        break;
      }

      // ── 工具：Delay —— 等待若干秒再继续（上限 60 秒，避免卡死链路）──
      case "utility.delay": {
        const ms = Math.max(0, Math.min(Number(node.config.seconds || 0) * 1000, 60000));
        if (ms) await new Promise((r) => setTimeout(r, ms));
        break;
      }

      // ── Terminal Command —— 把命令**打进终端窗口**（区别于后台跑的 Run Script）──
      // Alfred 对这两个的分工说得很清楚：要拿命令的输出、或者不想开终端，就用 Run Script；
      // 这个节点是「我要看着它跑」。所以**下游收到的是透传的参数，不是终端的输出** ——
      // 终端里的东西在另一个进程里，我们根本拿不到。
      case "action.terminal": {
        const bad = macOnly();
        if (bad) { feedback = bad; stop = true; break; }
        const cmd = this.subst(String(node.config.command || "{query}"), arg, vars).trim();
        if (!cmd) { feedback = "终端命令：命令为空"; stop = true; break; }
        const app = String(node.config.app || "Terminal").trim() || "Terminal";
        const make = TERMINAL_SCRIPTS[app];
        if (!make) {
          feedback = `不支持的终端：${app}（只支持 Terminal 与 iTerm —— 别的终端要各自的 AppleScript 方言）`;
          stop = true; break;
        }
        const r = await runAppleScript(make(escapeAppleString(cmd)), APPLESCRIPT_TIMEOUT);
        if (r.code !== 0) {
          feedback = `打开终端失败：${r.output.trim().split("\n").pop()?.slice(0, 80) || `退出码 ${r.code}`}`;
          stop = true; break;
        }
        feedback = `已在 ${app} 中执行 ✓`;
        break;   // outArg 不动：下游拿到的是透传的参数
      }

      // ── Web Search —— 用选定的搜索引擎搜一下 ──
      case "action.websearch": {
        const q = this.subst(String(node.config.query || "{query}"), arg, vars).trim();
        if (!q) { feedback = "网页搜索：没有关键词"; stop = true; break; }
        const key = String(node.config.engine || "google");
        const tpl = key === "custom"
          ? String(node.config.custom || "").trim()
          : (SEARCH_ENGINES[key]?.url || "");
        if (!tpl) { feedback = key === "custom" ? "网页搜索：没填自定义地址" : `未知搜索引擎：${key}`; stop = true; break; }
        if (!tpl.includes("{q}") && !tpl.includes("{query}")) {
          feedback = "自定义地址里要有 {query} 占位符，否则搜什么都跳同一个页面";
          stop = true; break;
        }
        const url = tpl.replace(/\{q(uery)?\}/g, encodeURIComponent(q));
        const browser = String(node.config.browser || "").trim();
        const { shell } = await import("electron");
        if (browser) {
          // 指定了浏览器就用 open -a 交给它；没指定走系统默认浏览器
          const r = await run("open", ["-a", browser, url], { timeoutMs: 8_000 });
          if (r.code !== 0) { feedback = `用 ${browser} 打开失败：${r.output.trim().slice(0, 60)}`; stop = true; break; }
        } else {
          await shell.openExternal(url);
        }
        feedback = `已搜索「${q.slice(0, 20)}」✓`;
        break;
      }

      // ── Speak —— 把文本念出来 ──
      // macOS 用系统自带的 say，Windows 用 PowerShell 的 SAPI。两边都不用装东西。
      case "output.speak": {
        const text = this.subst(String(node.config.text || "{query}"), arg, vars).trim();
        if (!text) { feedback = "朗读：没有内容"; stop = true; break; }
        const wait = node.config.wait === true;   // 默认不等：念一长段时不该把链路卡住
        if (process.platform === "darwin") {
          const args: string[] = [];
          const voice = String(node.config.voice || "").trim();
          if (voice) args.push("-v", voice);
          const rate = Number(node.config.rate || 0);
          if (rate > 0) args.push("-r", String(Math.max(50, Math.min(rate, 500))));
          args.push(text);
          if (wait) {
            const r = await run("say", args, { timeoutMs: SPEAK_TIMEOUT });
            if (r.code !== 0) { feedback = `朗读失败：${r.output.trim().slice(0, 60)}`; stop = true; break; }
          } else {
            void run("say", args, { timeoutMs: SPEAK_TIMEOUT });
          }
        } else if (process.platform === "win32") {
          const safe = text.replace(/'/g, "''");
          const ps = `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${safe}')`;
          if (wait) await run("powershell", ["-NoProfile", "-Command", ps], { timeoutMs: SPEAK_TIMEOUT });
          else void run("powershell", ["-NoProfile", "-Command", ps], { timeoutMs: SPEAK_TIMEOUT });
        } else {
          feedback = "朗读只在 macOS 与 Windows 上可用";
          stop = true; break;
        }
        feedback = "已朗读 ✓";
        break;
      }

      // ── Play Sound —— 播一段提示音 ──
      // 不填路径时播系统提示音；填了就播那个文件。一律不等它放完（提示音的意义就是不打断流程）。
      case "output.sound": {
        const raw = this.subst(String(node.config.path || ""), arg, vars).trim();
        if (process.platform === "darwin") {
          const target = raw
            ? expandHome(raw)
            : `/System/Library/Sounds/${String(node.config.system || "Glass")}.aiff`;
          if (!await pathExists(target)) { feedback = `声音文件不存在：${target}`; stop = true; break; }
          void run("afplay", [target], { timeoutMs: SOUND_TIMEOUT });
        } else if (process.platform === "win32") {
          const target = raw ? expandHome(raw) : "";
          const ps = target
            ? `(New-Object Media.SoundPlayer '${target.replace(/'/g, "''")}').PlaySync()`
            : "[System.Media.SystemSounds]::Asterisk.Play()";
          void run("powershell", ["-NoProfile", "-Command", ps], { timeoutMs: SOUND_TIMEOUT });
        } else {
          feedback = "播放提示音只在 macOS 与 Windows 上可用";
          stop = true; break;
        }
        feedback = "已播放 ✓";
        break;
      }

      // ── 工具：Dialog Conditional —— 弹个框问一句，按点了哪个按钮分流 ──
      //
      // 用 Electron 自己的消息框，不走 AppleScript：两个平台一套代码，而且返回的是
      // 按钮下标，不用去解析 osascript 那串 "button returned:确定"（本地化一变就解析错）。
      //
      // 三件事是刻意这么定的：
      //   1. **弹框前先收起快捷入口面板**。面板是 alwaysOnTop floating，消息框会被它盖住 ——
      //      于是弹了一个看不见的框在那儿等人点，链路卡死而界面上毫无迹象。这是最难查的一类。
      //   2. **按钮最多三个**（和 Alfred 一致）。macOS 的消息框超过三个按钮会改成竖排堆叠，
      //      又难看又分不清哪个是默认键。
      //   3. **Esc 等同于点了「取消按钮」那一路**。Electron 的消息框只回一个按钮下标，
      //      分辨不出「按了 Esc」和「点了取消」；与其猜，不如把规则定死并写在界面上。
      case "utility.dialog": {
        const btns = dialogButtons(node.config);
        const title = this.subst(String(node.config.title || ""), arg, vars).trim() || wf.name;
        const detail = this.subst(String(node.config.text || ""), arg, vars).trim();
        const cancelId = Math.max(0, Math.min(Math.trunc(Number(node.config.cancelIndex ?? 0)) || 0, btns.length - 1));
        const defaultId = Math.max(0, Math.min(Math.trunc(Number(node.config.defaultIndex ?? btns.length - 1)) || 0, btns.length - 1));
        const kind = String(node.config.kind || "none");
        await rc.ui.hide(true);   // 见上面第 1 条：不收面板的话框会被盖住
        const { dialog } = await import("electron");
        const r = await dialog.showMessageBox({
          type: (["none", "info", "warning", "error"].includes(kind) ? kind : "none") as "none",
          title, message: title, detail: detail || undefined,
          buttons: btns, defaultId, cancelId,
          noLink: true,   // Windows 上别把按钮渲染成命令链接，那样和 macOS 差太远
        });
        const picked = btns[r.response] ?? btns[cancelId];
        vars.dialog_button = picked;          // 下游可以用 {var:dialog_button} 拿到按了哪个
        outPort = `b${r.response}`;
        feedback = `选择了「${picked}」`;
        break;
      }

      // ── 窗口：隐藏 / 显示主面板 ──
      // 「主面板」= 快捷入口那个浮层。链路中间先收起它去干活（不然新开的窗口会被它挡住），
      // 干完再叫回来接着挑下一项。hide 的 returnFocus=true：把焦点还给刚才那个应用。
      case "utility.hide":
        await rc.ui.hide(true);
        break;
      case "utility.show":
        await rc.ui.showPanel();
        break;

      // ── 窗口：Dispatch Key Combo —— 向前台应用发一组按键 ──
      // 键位串用应用里录快捷键的同一套格式（Command+Shift+K），用户不用再学一套写法。
      // 发之前默认先收起面板：不收的话按键会发给面板自己，而不是用户以为的那个应用。
      case "output.keycombo": {
        const accel = this.subst(String(node.config.accelerator || ""), arg, vars).trim();
        if (!accel) { feedback = "发送按键：没录键位"; stop = true; break; }
        if (node.config.hideFirst !== false) {
          await rc.ui.hide(true);
          // 给系统一点时间把焦点真正交还给前台应用，不等的话按键会打空
          await new Promise((r) => setTimeout(r, Math.max(0, Math.min(Number(node.config.delayMs ?? 180), 2000))));
        }
        // repeat：连按几次（Tab 缩进三级、方向键连走这类）。夹在 1..20，
        // 上限是防手滑 —— 模拟按键发不出去时没有回执，发几百次只会让人以为死机了。
        const times = Math.max(1, Math.min(Math.trunc(Number(node.config.repeat ?? 1)) || 1, 20));
        for (let i = 0; i < times; i++) {
          const k = await simulateKeyCombo(accel);
          if (!k.ok) { feedback = `发送按键失败：${k.error}`; stop = true; break; }
          if (i < times - 1) await new Promise((r) => setTimeout(r, 40));   // 连按之间留一点间隔，不然应用会漏收
        }
        if (stop) break;
        feedback = `已发送 ${accel}${times > 1 ? ` ×${times}` : ""} ✓`;
        break;
      }

      // ── 窗口：System Command —— 锁屏 / 睡眠 / 清废纸篓这类系统操作 ──
      case "automation.system": {
        const bad = macOnly();
        if (bad) { feedback = bad; stop = true; break; }
        const key = String(node.config.command || "lock");
        const cmd = SYSTEM_CMDS[key];
        if (!cmd) { feedback = `系统命令：未知命令 ${key}`; stop = true; break; }
        // 确认框：热键一按就注销、就清废纸篓，误触的代价太大且不可逆，所以给一个开关。
        // 用系统自己的 display dialog，取消时 osascript 返回非零 —— 直接当「用户不干了」处理，
        // 是正常退出而不是失败，所以不带错误文案。
        if (node.config.confirm === true) {
          const q = escapeAppleString(`确定要${cmd.label}吗？`);
          const ok = await runAppleScript(
            `display dialog "${q}" buttons {"取消", "确定"} default button "取消" with icon caution`,
            CONFIRM_TIMEOUT,
          );
          if (ok.code !== 0 || !/确定/.test(ok.output)) { feedback = "已取消"; stop = true; break; }
        }
        const r = await runAppleScript(cmd.mac, APPLESCRIPT_TIMEOUT);
        stdout = r.output;
        exitCode = r.code ?? undefined;
        if (r.code !== 0) {
          feedback = `${cmd.label}失败：${r.output.trim().split("\n").pop()?.slice(0, 80) || `退出码 ${r.code}`}`;
          stop = true; break;
        }
        feedback = `${cmd.label} ✓`;
        break;
      }

      // ── 文件：Reveal in Finder —— 在系统文件管理器里定位到这个文件 ──
      // 和「打开文件」的区别是它不打开文件本身，只是把窗口开到那个文件上并选中它。
      case "action.reveal": {
        const target = expandHome(this.subst(String(node.config.path || "{query}"), arg, vars) || arg);
        if (!target) { feedback = "在文件管理器中显示：没有路径"; stop = true; break; }
        if (!await pathExists(target)) { feedback = `路径不存在：${target}`; stop = true; break; }
        const { shell } = await import("electron");
        shell.showItemInFolder(target);
        feedback = "已在文件管理器中显示 ✓";
        break;
      }

      // ── 文件：Browse in Terminal —— 在终端里 cd 到这个目录 ──
      // 传进来的要是文件就取它所在的目录：用户说「在终端里打开这个」时，
      // 想要的几乎总是它所在的目录，而不是拿文件路径当工作目录（那会直接失败）。
      case "action.browse": {
        const bad = macOnly();
        if (bad) { feedback = bad; stop = true; break; }
        const raw = expandHome(this.subst(String(node.config.path || "{query}"), arg, vars) || arg);
        if (!raw) { feedback = "在终端中打开：没有路径"; stop = true; break; }
        const dir = await toDirectory(raw);
        if (!dir) { feedback = `路径不存在：${raw}`; stop = true; break; }
        const app = String(node.config.app || "Terminal").trim() || "Terminal";
        const r = await run("open", ["-a", app, dir], { timeoutMs: 8_000 });
        if (r.code !== 0) { feedback = `打开终端失败：${r.output.trim().slice(0, 80)}`; stop = true; break; }
        feedback = `已在 ${app} 中打开 ✓`;
        break;
      }

      // ── 文件：File Conditional —— 按文件类型 / 扩展名分流（Conditional 的文件版）──
      // 逐条判断，命中第 i 条走 "r{i}" 出口，全不中走 "else"，和 Conditional 一致。
      // 判定只看**路径本身**（扩展名、是不是目录、存不存在），不读文件内容 ——
      // 读内容既慢又要权限，而按类型分流这件事扩展名已经够用了。
      case "utility.fileconditional": {
        const target = expandHome(this.subst(String(node.config.path || "{query}"), arg, vars) || arg);
        const rules = Array.isArray(node.config.rules) ? (node.config.rules as Record<string, unknown>[]) : [];
        const exists = await pathExists(target);
        const info = describeFile(target, exists && await isDirectory(target));
        let hit = -1;
        for (let i = 0; i < rules.length; i++) {
          if (matchFileRule(rules[i] || {}, info, exists)) { hit = i; break; }
        }
        outPort = hit >= 0 ? `r${hit}` : "else";
        break;
      }

      // ── 文件：File Buffer 文件暂存区 —— 把文件攒起来，攒够了一次性交给下游 ──
      // 三个动作：add 收一条、list 把攒的全给下游（换行分隔）、clear 清空。
      // 暂存区按「工作流 + 节点」分桶存在内存里，进程退出即清空 ——
      // 它的用途是「这几分钟里挑几个文件一起处理」，不是长期收藏夹（那是书签该干的事）。
      case "action.filebuffer": {
        const key = `${wf.id}:${node.id}`;
        const mode = String(node.config.mode || "add");
        const buf = this.fileBuffers.get(key) || [];
        if (mode === "clear") {
          this.fileBuffers.delete(key);
          feedback = "暂存区已清空 ✓";
          break;
        }
        if (mode === "list") {
          if (!buf.length) { feedback = "暂存区是空的"; stop = true; break; }
          outArg = buf.join("\n");
          if (node.config.clearAfter !== false) this.fileBuffers.delete(key);
          break;
        }
        // add：把上游给的路径收进去（一次可以来多条，按换行拆）
        const incoming = (this.subst(String(node.config.path || "{query}"), arg, vars) || arg)
          .split("\n").map((x) => expandHome(x.trim())).filter(Boolean);
        if (!incoming.length) { feedback = "暂存区：没有可收的路径"; stop = true; break; }
        // 收之前先确认文件真的在：不校验的话，拼错的、已删掉的路径会一路躺到下游才炸，
        // 而暂存区里看着还是「已暂存 N 个」，最难查。
        const real: string[] = [];
        for (const p of incoming) if (await pathExists(p)) real.push(p);
        const missed = incoming.length - real.length;
        if (!real.length) { feedback = `暂存区：${missed} 个路径都不存在`; stop = true; break; }
        // 去重：同一个文件反复加没有意义，还会让下游重复处理
        const merged = [...new Set([...buf, ...real])].slice(0, FILE_BUFFER_MAX);
        this.fileBuffers.set(key, merged);
        feedback = `已暂存 ${merged.length} 个文件${missed ? `（跳过 ${missed} 个不存在的）` : ""}`;
        break;
      }

      // ── macOS 专属：Run AppleScript —— 跑一段 AppleScript ──
      // 脚本走 stdin 送进 osascript（不拼命令行），所以正文里带引号 / 换行 / 中文都没问题。
      // 占位符照常替换：脚本里可以直接写 {query} / {var:名称}。
      case "action.applescript": {
        const bad = macOnly();
        if (bad) { feedback = bad; stop = true; break; }
        const src = this.subst(String(node.config.script || ""), arg, vars);
        if (!src.trim()) { feedback = "AppleScript：脚本为空"; stop = true; break; }
        const r = await runAppleScript(src, APPLESCRIPT_TIMEOUT);
        stdout = r.output;
        exitCode = r.code ?? undefined;
        if (r.timedOut) { feedback = `AppleScript 超时（${APPLESCRIPT_TIMEOUT / 1000}s）`; stop = true; break; }
        if (r.code !== 0) {
          // osascript 把编译/运行错误写在 stderr，已并进 output —— 原样带给用户，别自己编。
          feedback = `AppleScript 失败：${r.output.trim().split("\n").pop()?.slice(0, 80) || `退出码 ${r.code}`}`;
          if (String(node.config.onError || "stop") !== "continue") stop = true;
          break;
        }
        // 脚本的返回值（osascript 打到 stdout 的那一行）按配置决定怎么处置。
        // 默认 replace，和 Run Script 保持一致 —— 两个语义相近的节点默认行为不一样，
        // 用户一定会被绊；Alfred 那边脚本类对象也统一是「输出即下游参数」。
        // 但返回值为空时保留原参数：AppleScript 很多时候本来就不返回东西，
        // 这时把 arg 冲成空串会让下游莫名其妙地拿不到值。
        const out = r.output.trim();
        const mode = String(node.config.output || "replace");
        if (mode === "replace") { if (out) outArg = out; }
        else if (mode === "copy") { clipboard.writeText(out); feedback = "已复制 ✓"; }
        break;
      }

      // ── macOS 专属：Run Shortcut —— 调用「快捷指令」App 里的一条快捷指令 ──
      // 用系统自带的 shortcuts CLI（macOS 12+）。参数经 stdin 传给快捷指令，
      // 结果从 stdout 收回来 —— 两头都用管道，省得为了传个字符串去落临时文件。
      case "automation.shortcut": {
        const bad = macOnly();
        if (bad) { feedback = bad; stop = true; break; }
        const name = this.subst(String(node.config.name || ""), arg, vars).trim();
        if (!name) { feedback = "快捷指令：没填名称"; stop = true; break; }
        if (!which("shortcuts")) {
          feedback = "找不到 shortcuts 命令（需要 macOS 12 及以上）";
          stop = true; break;
        }
        // -i - 表示从 stdin 读输入，-o - 表示把输出写到 stdout。
        // 明确不传输入时连 -i 都不给：有些快捷指令收到空输入会走另一条分支。
        const passArg = node.config.input !== false && !!arg;
        const args = ["run", name, ...(passArg ? ["-i", "-"] : []), "-o", "-"];
        // wait=false：发出去就往下走。要拿返回值就必须等，所以选了 replace 时忽略这个开关 ——
        // 否则会得到一个空 arg，而用户以为自己拿到了结果。
        const wantOut = String(node.config.output || "none") === "replace";
        if (node.config.wait === false && !wantOut) {
          void run("shortcuts", args, { timeoutMs: SHORTCUT_TIMEOUT, stdin: passArg ? arg : undefined });
          feedback = `已触发「${name}」（不等它跑完）`;
          break;
        }
        const r = await run("shortcuts", args, {
          timeoutMs: SHORTCUT_TIMEOUT,
          stdin: passArg ? arg : undefined,
        });
        stdout = r.output;
        exitCode = r.code ?? undefined;
        if (r.timedOut) { feedback = `快捷指令超时（${SHORTCUT_TIMEOUT / 1000}s）`; stop = true; break; }
        if (r.code !== 0) {
          feedback = `快捷指令失败：${r.output.trim().split("\n").pop()?.slice(0, 80) || `退出码 ${r.code}`}`;
          stop = true; break;
        }
        if (wantOut) outArg = r.output.trim();
        break;
      }

      // ── macOS 专属：Music Command —— 控制「音乐」App ──
      // 全部落到 Music.app 的 AppleScript 命令上（见 MUSIC_CMDS）。
      case "automation.music": {
        const bad = macOnly();
        if (bad) { feedback = bad; stop = true; break; }
        const key = String(node.config.command || "playpause");
        const cmd = MUSIC_CMDS[key];
        if (!cmd) { feedback = `音乐控制：未知命令 ${key}`; stop = true; break; }
        let src = cmd.script;
        if (key === "volume") {
          // 0–100 之外的值 Music 会直接拒绝，先夹住比让它报错友好
          const v = Math.max(0, Math.min(100, Math.trunc(Number(node.config.volume ?? 50)) || 0));
          src = src.replace("%V%", String(v));
        }
        const r = await runAppleScript(src, APPLESCRIPT_TIMEOUT);
        stdout = r.output;
        exitCode = r.code ?? undefined;
        if (r.code !== 0) {
          // 最常见的失败是「音乐 App 没开」——原样把系统的话带出来，比我瞎猜准
          feedback = `音乐控制失败：${r.output.trim().split("\n").pop()?.slice(0, 80) || `退出码 ${r.code}`}`;
          stop = true; break;
        }
        // 「当前播放」这条要把结果交给下游，其余动作不动参数
        if (key === "now") outArg = r.output.trim();
        else feedback = `${cmd.label} ✓`;
        break;
      }

      case "action.copy":
        clipboard.writeText(arg); feedback = "已复制 ✓"; break;
      case "action.paste":
        clipboard.writeText(arg);
        await rc.ui.hide(true);
        await new Promise((r) => setTimeout(r, 180));
        await simulatePaste();
        break;
      // 打开网址。可指定浏览器 —— 和「网页搜索」保持同一套字段，
      // 不然同一个应用里两个开网页的节点行为不一致，用户得记两套。
      case "action.openurl": {
        const url = this.subst(String(node.config.url || "{query}"), arg, vars) || arg;
        const br = String(node.config.browser || "").trim();
        const r = await run("open", br ? ["-a", br, url] : [url]);
        if (r.code !== 0 && br) { feedback = `用 ${br} 打开失败：${r.output.trim().slice(0, 60)}`; stop = true; break; }
        await rc.ui.hide(false); break;
      }
      // 打开文件：**按行拆**。上游是「文件暂存区」的取出模式时给的就是多行路径，
      // 这两个节点天生要串在一起用；不拆的话等于把一整段多行文本当成一个路径丢给 open，必然失败。
      case "action.openfile": {
        const paths = (this.subst(String(node.config.path || "{query}"), arg, vars) || arg)
          .split("\n").map((x) => expandHome(x.trim())).filter(Boolean);
        if (!paths.length) { feedback = "打开文件：没有路径"; stop = true; break; }
        const app = String(node.config.app || "");
        // 指定了应用就一条 open 带上全部路径（同一个 App 里一次开完，不会开出好几个实例）；
        // 没指定则逐个交给系统，各自按默认应用打开。
        if (app) await run("open", ["-a", app, ...paths]);
        else for (const p of paths) await run("open", [p]);
        await rc.ui.hide(false);
        feedback = paths.length > 1 ? `已打开 ${paths.length} 个 ✓` : "";
        break;
      }
      case "action.launch": {
        const paths = Array.isArray(node.config.paths) ? (node.config.paths as string[]) : [];
        const toggle = !!node.config.toggleVisibility;
        for (const raw of paths) {
          const ep = expandHome(String(raw || "").trim());
          if (!ep) continue;
          if (toggle && /\.app$/i.test(ep)) {
            const name = (ep.split("/").pop() || "").replace(/\.app$/i, "");
            const front = await run("osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true']);
            if (front.output.trim() === name) { await run("osascript", ["-e", `tell application "System Events" to set visible of process "${name}" to false`]); continue; }
          }
          await run("open", [ep]);
        }
        await rc.ui.hide(false); break;
      }
      case "action.script": {
        const script = this.subst(String(node.config.script || ""), arg, vars);
        // cwd 缺省 = 本工作流自己的目录；填了相对路径也按工作流目录解析。
        // 这样脚本里就能直接写 ./runtime/txiki ./index.js，随行文件跟着工作流走。
        const dir = await ensureWorkflowDir(this.cfg.dir, wf.id);
        const cwd = resolveCwd(dir, String(node.config.cwd || ""), expandHome);
        const env: Record<string, string> = { ...workflowEnv(dir, wf.id, wf.name) };
        for (const [k, v] of Object.entries(vars)) env[k] = String(v ?? "");
        env.query = arg;
        const langKey = String(node.config.language || "bash");
        const lang = SCRIPT_LANGS[langKey];
        if (!lang) { feedback = `不支持的脚本语言：${langKey}`; stop = true; break; }
        // shebang 和下拉选的语言对不上时**明确报错**，不硬跑。
        // 因为 bash 会把 `#!/usr/bin/env python3` 当成一行注释直接忽略，然后拿 bash 去解释 Python，
        // 报出来的错完全指不到真正的原因 —— 这是最费时间的一类误配。
        // 注意 `#!/usr/bin/env python3`：真正的解释器是 env **后面**那个词，
        // 只取第一段会得到 "env"，等于这道防线对最常见的写法失效。
        const toks = (/^#!\s*(.+)$/m.exec(script.trimStart())?.[1] || "").trim().split(/\s+/).filter(Boolean);
        let shebangName = (toks[0] || "").split("/").pop() || "";
        if (shebangName === "env") {
          shebangName = (toks.slice(1).find((t) => !t.startsWith("-")) || "").split("/").pop() || "";
        }
        if (shebangName && !lang.accepts.includes(shebangName)) {
          feedback = `脚本首行写的是 ${shebangName}，但语言选的是 ${lang.label} —— 改一处让它们一致`;
          stop = true; break;
        }
        let err = "";
        const res = await run(lang.cmd, [...lang.args, script, ...lang.argv(arg)], {
          timeoutMs: SCRIPT_TIMEOUT, cwd, env, onStderr: (c) => { err += c; },
        });
        const out = (res.output || "").trim();
        stdout = out; stderr = err; exitCode = res.code ?? undefined;   // 记进调试轨迹
        outArg = out;  // 脚本把 stdout 作为下游 arg
        if (res.code !== 0) {
          feedback = `脚本出错：${out.slice(0, 40) || "非零退出"}`;
          // onError：stop=终止链路（默认，出错就不该继续做后面的事）| continue=照常往下走 | branch=改走 error 出口
          const onError = String(node.config.onError || "stop");
          if (onError === "branch") outPort = "error";
          else if (onError !== "continue") stop = true;
          break;
        }
        // Alfred 包裹输出 {"alfredworkflow":{"arg":..,"variables":{..}}}：解析出来回写 arg 与变量。
        const wrapped = this.parseAlfredOutput(out);
        if (wrapped) {
          if (wrapped.arg !== undefined) outArg = wrapped.arg;
          for (const [k, v] of Object.entries(wrapped.variables || {})) vars[k] = v;
        }
        if ((node.config.output || "none") === "copy" && outArg) { clipboard.writeText(outArg); feedback = `已复制：${outArg.slice(0, 30)}`; }
        else feedback = "已执行 ✓";
        break;
      }
      case "action.assistant":
        rc.ui.sendAssistant(arg); break;
      case "action.inspiration":
        feedback = await this.postInspiration(arg); break;

      // ── 问秘书并等回复：回复文本作为下游 arg 继续传递（Umbra 差异化节点）──
      case "action.ask_assistant": {
        const content = this.subst(String(node.config.prompt || "{query}"), arg, vars).trim();
        if (!content) { feedback = "问秘书：内容为空"; stop = true; break; }
        const title = this.subst(String(node.config.title || ""), arg, vars) || "秘书";
        const show = node.config.show !== false;   // 默认开文本视图展示，等待期间显示 loading
        if (show) {
          rc.ui.showTextView({ text: content, title, md: true, loading: true });
          await rc.ui.hide(false);
        }
        const r = await this.askAssistant(content);
        if (r.error) {
          feedback = `问秘书失败：${r.error.slice(0, 40)}`;
          if (show) rc.ui.showTextView({ text: feedback, title, md: false });
          stop = true; break;
        }
        outArg = r.reply;
        if (show) rc.ui.showTextView({ text: r.reply, title, md: true });
        else feedback = "秘书已回复 ✓";
        break;
      }

      // ── 建任务：服务端没有独立的建任务路由，这里是「/web/message + 建任务前缀」的薄封装 ──
      case "action.create_task": {
        const body = this.subst(String(node.config.text || "{query}"), arg, vars).trim();
        if (!body) { feedback = "建任务：内容为空"; stop = true; break; }
        const prefix = String(node.config.prefix ?? "帮我建个任务：");
        const r = await this.askAssistant(`${prefix}${body}`);
        if (r.error) { feedback = `建任务失败：${r.error.slice(0, 40)}`; stop = true; break; }
        outArg = r.reply;
        feedback = "已交给秘书建任务 ✓";
        break;
      }

      // ── 设备技能派发：把参数交给某台在线设备的 provider.skill 执行，结果作为下游 arg ──
      case "action.device_skill": {
        const provider = String(node.config.provider || "").trim();
        const skill = String(node.config.skill || "").trim();
        if (!provider || !skill) { feedback = "设备技能：未填写 provider / skill"; stop = true; break; }
        let params: Record<string, unknown> = {};
        // 参数是一段 JSON 文本，占位符按 JSON 字符串转义后再插入，避免引号/换行把 JSON 打断。
        const rawParams = this.substJson(String(node.config.params || ""), arg, vars).trim();
        if (rawParams) {
          try { params = JSON.parse(rawParams) as Record<string, unknown>; }
          catch { feedback = "设备技能：参数不是合法 JSON"; stop = true; break; }
        }
        let device = String(node.config.device || "").trim();
        if (!device) {
          device = await this.pickDevice(provider, skill);   // 留空=自动挑一台有该技能的在线设备
          if (!device) { feedback = `没有在线设备提供 ${provider}.${skill}`; stop = true; break; }
        }
        const r = await this.dispatchDevice(device, provider, skill, params);
        if (r.error) { feedback = `派发失败：${r.error.slice(0, 40)}`; stop = true; break; }
        outArg = r.text;
        feedback = r.text ? `设备已执行：${r.text.slice(0, 30)}` : "设备已执行 ✓";
        break;
      }

      case "output.largetype":
        rc.ui.showLargeType(arg); await rc.ui.hide(false); break;

      // ── 文本视图：把长文摊在浮层里（可 Markdown、可追加），大字显示装不下时用 ──
      case "output.textview": {
        rc.ui.showTextView({
          text: arg,
          title: this.subst(String(node.config.title || ""), arg, vars) || wf.name,
          md: node.config.markdown !== false,
          append: !!node.config.append,
        });
        await rc.ui.hide(false);
        break;
      }

      // 系统通知：标题与正文都可自定义（留空各自回退到工作流名 / 上游参数）。
      // ifEmpty：正文为空时默认**不弹** —— 弹一个什么都没有的通知框是最招人烦的那种，
      // 而它恰恰最常见（上游脚本没输出、条件没命中却接了通知）。
      case "output.notify": {
        const nTitle = this.subst(String(node.config.title || ""), arg, vars).trim() || wf.name;
        const nBody = (node.config.text === undefined || node.config.text === ""
          ? arg
          : this.subst(String(node.config.text), arg, vars)).trim();
        if (!nBody && node.config.ifEmpty !== "show") { feedback = "通知：内容为空，已跳过"; break; }
        try { new Notification({ title: nTitle, body: nBody }).show(); } catch { /* 无通知权限忽略 */ }
        break;
      }

      // ── 输出：写文本文件 —— 把内容落到磁盘，并把「最终写入的绝对路径」作为下游 arg ──
      // 路径规则：~ 展开；绝对路径按填的走；相对路径落到本工作流的 data 目录
      //（脚本读得到 $alfred_workflow_data，工作流整包拷走时文件也跟着走）。
      case "output.writefile": {
        const rawPath = this.subst(String(node.config.path || ""), arg, vars).trim();
        const body = this.subst(String(node.config.content ?? "{query}"), arg, vars);
        if (!rawPath) { feedback = "写文件：没填文件名"; stop = true; break; }
        if (!body && !node.config.allowEmpty) { feedback = "写文件：内容为空（未勾选允许空文件）"; stop = true; break; }
        const dir = await ensureWorkflowDir(this.cfg.dir, wf.id);
        const ep = expandHome(rawPath);
        let target = path.isAbsolute(ep) ? ep : path.join(dir, "data", ep);
        // 加 UUID：加在扩展名之前，扩展名保住（notes.md → notes-3f2a….md）。
        if (node.config.uuid) {
          const ext = path.extname(target);
          target = `${target.slice(0, target.length - ext.length)}-${randomUUID()}${ext}`;
        }
        if (node.config.mkdirs) {
          try { await fs.mkdir(path.dirname(target), { recursive: true }); }
          catch (e) { feedback = `写文件：建目录失败 ${String(e).slice(0, 40)}`; stop = true; break; }
        }
        const exists = await fs.stat(target).then(() => true).catch(() => false);
        // 已存在时怎么办：overwrite=覆盖（默认）| append=追加到末尾 | prepend=插到开头
        //                | unique=另存 name-1.txt | skip=什么都不做
        const mode = String(node.config.ifExists || "overwrite");
        if (exists && mode === "skip") { outArg = target; feedback = "写文件：已存在，跳过"; break; }
        if (exists && mode === "unique") target = await uniquePath(target);
        try {
          if (exists && mode === "append") await fs.appendFile(target, body, "utf8");
          else if (exists && mode === "prepend") {
            // 没有「往文件头插」的系统调用，只能读回来重写。日志倒序这类场景就靠它。
            const old = await fs.readFile(target, "utf8").catch(() => "");
            await fs.writeFile(target, body + old, "utf8");
          } else await fs.writeFile(target, body, "utf8");
        } catch (e) { feedback = `写文件失败：${String(e).slice(0, 60)}`; stop = true; break; }
        outArg = target;   // 下游拿到的是绝对路径，接「打开文件」「复制」都顺手
        feedback = `已写入：${path.basename(target)} ✓`;
        break;
      }
    }
    } catch (e) {
      // 节点内部抛异常：先把这一步记进轨迹（否则调试抽屉里只会看到「跑到一半没了」），再原样抛出。
      this.trace.stepEnd(step, startedAt, { outArg: arg, error: String(e), stdout, stderr, exitCode });
      throw e;
    }
    this.trace.stepEnd(step, startedAt, { outArg, outPort, feedback, stopped: stop, stdout, stderr, exitCode });
    if (stop) return feedback;   // 链路被节点主动终止（脚本失败、远程调用失败等）
    if (hold) return feedback;   // Join 还没收齐，这一项到此为止，等这批的最后一项来了再往下走
    // Split（参数列表输出）：下游按拆出的每一项各跑一遍，串行且保序，方便脚本节点顺序处理。
    if (fanItems) {
      const ctx: FanCtx = { index: 0, total: fanItems.length, bucket: new Map(), parent: fan };
      for (let i = 0; i < fanItems.length; i++) {
        ctx.index = i;
        for (const c of this.outConns(wf, nodeId, "", outPort)) {
          // visited 传副本而不是同一个：对上游仍然防环，但下游节点允许每一项各执行一次。
          const fb = await this.runNode(wf, c.to, fanItems[i], vars, new Set(visited), rc, tr, ctx, cfgOverride);
          if (fb) feedback = fb;
        }
      }
      return feedback;
    }
    // 传给 outPort 出口上的所有下游（回车分支）——链式/扇出都把 arg 与变量继续传递。
    for (const c of this.outConns(wf, nodeId, "", outPort)) {
      const fb = await this.runNode(wf, c.to, outArg, vars, visited, rc, tr, fanOut, cfgOverride);
      if (fb) feedback = fb;
    }
    return feedback;
  }

  // Conditional 单条规则求值。subject 支持占位（缺省 {query}=上游 arg）；ci 缺省 true（忽略大小写）。
  private matchRule(rule: Record<string, unknown>, arg: string, vars: Record<string, string>): boolean {
    const op = String(rule.op || "contains");
    const ci = rule.ci !== false;
    const rawSubject = this.subst(String(rule.subject || "{query}"), arg, vars);
    const rawValue = this.subst(String(rule.value ?? ""), arg, vars);
    const subject = ci ? rawSubject.toLowerCase() : rawSubject;
    const value = ci ? rawValue.toLowerCase() : rawValue;
    const num = (s: string) => Number(String(s).replace(/,/g, "").trim());
    switch (op) {
      case "is": return subject === value;
      case "is_not": return subject !== value;
      case "contains": return subject.includes(value);
      case "not_contains": return !subject.includes(value);
      case "starts_with": return subject.startsWith(value);
      case "ends_with": return subject.endsWith(value);
      case "is_empty": return subject.trim() === "";
      case "is_not_empty": return subject.trim() !== "";
      case "gt": return num(subject) > num(value);
      case "gte": return num(subject) >= num(value);
      case "lt": return num(subject) < num(value);
      case "lte": return num(subject) <= num(value);
      case "matches":
      case "not_matches": {
        let ok = false;
        try { ok = new RegExp(rawValue, ci ? "i" : "").test(rawSubject); }
        catch { ok = false; }   // 正则写错当作不命中，不阻断链路
        return op === "matches" ? ok : !ok;
      }
      default: return false;
    }
  }

  // Transform 节点的文本变换实现。
  private transformText(src: string, mode: string): string {
    switch (mode) {
      case "upper": return src.toUpperCase();
      case "lower": return src.toLowerCase();
      case "title": return src.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
      case "trim": return src.trim();
      case "urlencode": return encodeURIComponent(src);
      case "urldecode": { try { return decodeURIComponent(src); } catch { return src; } }
      case "base64encode": return Buffer.from(src, "utf8").toString("base64");
      case "base64decode": { try { return Buffer.from(src, "base64").toString("utf8"); } catch { return src; } }
      // 反转按**码点**而不是 UTF-16 码元来拆：[...src] 会把 emoji、生僻字这类
      // 占两个码元的字符当一个整体，split("") 则会把它劈成两半变成乱码。
      case "reverse": return [...src].reverse().join("");
      // 去重音：先拆成「基字母 + 组合记号」（NFD），再把记号那一段删掉。café → cafe
      case "deaccent": return src.normalize("NFD").replace(/[̀-ͯ]/g, "");
      // 去掉非字母数字。\p{L}\p{N} 认中文和各国文字，不是只留 ASCII —— 只留 ASCII 的话
      // 中文内容会被清空，那是个静悄悄的数据丢失。
      case "alnum": return src.replace(/[^\p{L}\p{N}]+/gu, "");
      default: return src;
    }
  }

  // 占位替换（Debug 打点版）：在通用占位符之外多认一个 {variables} —— 当前全部变量的转储。
  // 顺序是「先通用替换、后展开 {variables}」：{variables} 不在通用占位符表里会原样留到最后一步，
  // 这样变量值里若正好写着 {query} 也不会被二次展开。疑似密钥按调试抽屉同一套规则打码。
  private substDebug(tpl: string, arg: string, vars: Record<string, string>): string {
    const done = this.subst(tpl, arg, vars);
    if (!done.includes("{variables}")) return done;
    const entries = Object.entries(vars);
    const dump = entries.length ? entries.map(([k, v]) => `${k} = ${maskSecret(k, String(v ?? ""))}`).join("\n") : "（无变量）";
    return done.replace(/\{variables\}/g, () => dump);
  }

  // 占位替换（JSON 版）：值按 JSON 字符串转义后插入，供「参数是一段 JSON 文本」的节点使用。
  private substJson(tpl: string, arg: string, vars: Record<string, string>): string {
    const esc = (v: string) => JSON.stringify(String(v ?? "")).slice(1, -1);
    return (tpl || "")
      .replace(/\{query\}/g, () => esc(arg))
      .replace(/\{var:([^}]+)\}/g, (_m, k) => esc(vars[String(k).trim()] ?? ""));
  }

  // 解析 Run Script 的 Alfred 包裹输出 {"alfredworkflow":{"arg":..,"variables":{..}}}。
  // 不是这个形状（普通 stdout）时返回 null，仍按「stdout 即 arg」处理。
  private parseAlfredOutput(out: string): { arg?: string; variables?: Record<string, string> } | null {
    const t = (out || "").trim();
    if (!t.startsWith("{") || !t.includes("alfredworkflow")) return null;
    try {
      const data = JSON.parse(t) as { alfredworkflow?: { arg?: unknown; variables?: Record<string, unknown> } };
      const w = data.alfredworkflow;
      if (!w || typeof w !== "object") return null;
      const arg = w.arg === undefined ? undefined : Array.isArray(w.arg) ? w.arg.join("\n") : String(w.arg);
      const variables: Record<string, string> = {};
      for (const [k, v] of Object.entries(w.variables || {})) variables[k] = String(v ?? "");
      return { arg, variables };
    } catch { return null; }
  }

  // 问秘书：走服务端 /web/message 完整链路，返回回复文本；出错时 error 有值。
  private async askAssistant(content: string): Promise<{ reply: string; error?: string }> {
    try {
      const c = this.cfg.get();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (c.token) headers["X-Umbra-Token"] = c.token;
      const resp = await httpFetch(`${httpBase(c)}/web/message`, {
        method: "POST", headers,
        body: JSON.stringify({ client_id: c.deviceId, content, node_id: c.deviceId }),
        signal: AbortSignal.timeout(REMOTE_TIMEOUT),
      });
      if (!resp.ok) return { reply: "", error: `HTTP ${resp.status}` };
      const data = await resp.json() as { reply?: string };
      return { reply: String(data.reply ?? "") };
    } catch (e) {
      return { reply: "", error: String(e) };
    }
  }

  // 按 provider.skill 自动挑一台在线设备（/devices/all 给的是规范化后的能力目录）。
  private async pickDevice(provider: string, skill: string): Promise<string> {
    try {
      const c = this.cfg.get();
      const headers: Record<string, string> = {};
      if (c.token) headers["X-Umbra-Token"] = c.token;
      const resp = await httpFetch(`${httpBase(c)}/devices/all`, { headers, signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return "";
      const list = await resp.json() as {
        device_id?: string; online?: boolean;
        providers?: { provider?: string; available?: boolean; skills?: { name?: string }[] }[];
      }[];
      for (const d of Array.isArray(list) ? list : []) {
        if (!d.online || !d.device_id) continue;
        const p = (d.providers || []).find((x) => x.provider === provider && x.available !== false);
        if (p && (p.skills || []).some((s) => s.name === skill)) return String(d.device_id);
      }
    } catch { /* 查不到就返回空，由调用方给出提示 */ }
    return "";
  }

  // 把技能派发给指定设备执行（服务端同步等结果）。
  private async dispatchDevice(deviceId: string, provider: string, skill: string, params: Record<string, unknown>): Promise<{ text: string; error?: string }> {
    try {
      const c = this.cfg.get();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (c.token) headers["X-Umbra-Token"] = c.token;
      const resp = await httpFetch(`${httpBase(c)}/devices/${encodeURIComponent(deviceId)}/dispatch`, {
        method: "POST", headers,
        body: JSON.stringify({ provider, skill, params }),
        signal: AbortSignal.timeout(REMOTE_TIMEOUT),
      });
      if (!resp.ok) return { text: "", error: `HTTP ${resp.status}` };
      const data = await resp.json() as { result?: unknown };
      const r = data.result;
      return { text: typeof r === "string" ? r : r === undefined || r === null ? "" : JSON.stringify(r) };
    } catch (e) {
      return { text: "", error: String(e) };
    }
  }

  private async postInspiration(raw: string): Promise<string> {
    const t = (raw || "").trim();
    if (!t) return "";
    try {
      const c = this.cfg.get();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (c.token) headers["X-Umbra-Token"] = c.token;
      const resp = await httpFetch(`${httpBase(c)}/inspirations`, { method: "POST", headers, body: JSON.stringify({ raw: t }) });
      return resp.ok ? "已记为灵感 ✓" : `记灵感失败：${resp.status}`;
    } catch (e) {
      return `记灵感失败：${String(e).slice(0, 40)}`;
    }
  }

  // ── Hotkey 触发：供 main.ts 在 reregisterShortcuts 里注册 ──
  hotkeys(): { accelerator: string; wfId: string; nodeId: string }[] {
    const out: { accelerator: string; wfId: string; nodeId: string }[] = [];
    for (const wf of this.workflows()) {
      for (const n of wf.nodes.filter((n) => n.type === "trigger.hotkey" && !n.disabled)) {
        const acc = String(n.config.accelerator || "").trim();
        if (acc) out.push({ accelerator: acc, wfId: wf.id, nodeId: n.id });
      }
    }
    return out;
  }
  // Hotkey 触发：arg = 当前剪贴板文本；沿该节点的回车分支执行动作链。
  // ── 从编辑器手动运行（顶栏「运行」按钮）──────────────────────────────────
  // 和快捷键/Universal 触发的区别只有入口：参数是用户在顶栏输入框里现填的，
  // 而不是从剪贴板或选区抓的。跑的仍然是「回车」分支，走同一条 runNode，
  // 所以调试抽屉里看到的轨迹和真实触发时完全一致 —— 这正是这个按钮的意义。
  //
  // nodeId 为空 = 让引擎自己挑入口：优先第一个**没被停用**的触发器节点。
  // 编辑器里选中了某个节点时会把它传进来，这样可以只跑链路的一段。
  // 返回 from 是为了让界面能说清「从哪个节点跑的」，跑完一脸茫然最难受。
  // 编辑器顶栏的「运行」按钮：人正看着编辑器，属于 ui 上下文。
  async runFromEditor(wfId: string, nodeId: string, arg: string): Promise<{ ok: boolean; from: string; feedback: string; error: string }> {
    const { outputs, ...rest } = await this.runEntry(wfId, nodeId, arg, this.uiCtx(), "手动运行");
    void outputs;   // ui 上下文里恒为空，不往外传，免得调用方以为有东西可读
    return rest;
  }

  // 无头运行：给将来「工作流作为设备能力」用。屏幕前没人，展示类节点的内容随返回值带回来。
  //
  // 有意和 runFromEditor 走同一条 runEntry —— 两条入口如果各写一遍找起点、连线、轨迹的逻辑，
  // 迟早会一边修了另一边没修，而「远程调用的行为和本地不一样」是最难复现的一类问题。
  async runHeadless(wfId: string, nodeId: string, arg: string): Promise<{ ok: boolean; from: string; feedback: string; error: string; outputs: RunOutput[] }> {
    return this.runEntry(wfId, nodeId, arg, this.headlessCtx(), "远程调用");
  }

  private async runEntry(wfId: string, nodeId: string, arg: string, rc: RunCtx, how: string): Promise<{ ok: boolean; from: string; feedback: string; error: string; outputs: RunOutput[] }> {
    const fail = (error: string) => ({ ok: false, from: "", feedback: "", error, outputs: rc.outputs });
    const wf = this.workflows().find((w) => w.id === wfId);
    if (!wf) return fail("工作流不存在");
    let start = nodeId ? wf.nodes.find((n) => n.id === nodeId) : undefined;
    if (nodeId && !start) return fail("选中的节点已不存在");
    if (!start) start = wf.nodes.find((n) => n.type.startsWith("trigger.") && !n.disabled);
    if (!start) return fail("这条工作流还没有可用的触发器节点");
    if (start.disabled) return fail("这个节点已停用");
    const conns = this.outConns(wf, start.id, "");
    if (!conns.length) return fail("这个节点的「回车」出口还没有连线");

    const vars = this.baseVars(wf);
    const visited = new Set<string>();
    // 轨迹里记清楚这次是怎么起来的（手动运行 / 远程调用），和真实触发区分开 ——
    // 事后看记录时最先要判断的就是「这次是谁点的」。
    const tr = this.trace.begin(wf.id, wf.name, how, arg);
    let feedback = "";
    try {
      for (const conn of conns) feedback = (await this.runNode(wf, conn.to, arg, vars, visited, rc, tr)) || feedback;
    } catch (e) {
      return { ok: false, from: start.id, feedback, error: String(e instanceof Error ? e.message : e), outputs: rc.outputs };
    } finally {
      // 中途抛异常也要把已记录的步数留下 —— 手动运行本来就多半是为了看它错在哪。
      this.trace.end(tr);
    }
    return { ok: true, from: start.id, feedback, error: "", outputs: rc.outputs };
  }

  async fireHotkey(wfId: string, nodeId: string): Promise<void> {
    const wf = this.workflows().find((w) => w.id === wfId);
    if (!wf) return;
    const node = this.node(wf, nodeId);
    const arg = await this.hotkeyArg(node);

    // 「打开快捷入口」（Alfred 的 Show Alfred）：不跑动作链，而是把面板叫出来、
    // 把内容预填进搜索框，剩下的交给正常的关键词匹配。
    //
    // **这是接 Script Filter 时唯一能用的模式**：Script Filter 要的是「用户边打边查」，
    // 而「传给工作流」那条路是一次性把 arg 灌下去就跑完 —— 对着一个要打字的节点，
    // 表现就是按了快捷键什么也没有（用户点名的那个现象）。
    if (String(node?.config.action || "pass") === "show") {
      const prefix = String(node?.config.prefix || "");
      // 前缀没填就去下游要一个关键词。**这一步 Alfred 没有**：它要求作者自己
      // 在前缀里把关键词打出来，填错了就是静默不匹配。我们知道自己连着谁，
      // 顺手补上更省事；作者填了前缀就以前缀为准，不去覆盖他的意图。
      const head = prefix || this.downstreamKeyword(wf, nodeId);
      const caret = String(node?.config.caret || "right") === "left" ? "left" : "right";
      await this.deps.showPanel({ q: `${head}${arg}`, caret });
      return;
    }

    const vars = this.baseVars(wf);
    const visited = new Set<string>();
    const tr = this.trace.begin(wf.id, wf.name, "快捷键", arg);
    try {
      for (const conn of this.outConns(wf, nodeId, "")) await this.runNode(wf, conn.to, arg, vars, visited, this.uiCtx(), tr);
    } finally {
      this.trace.end(tr);
    }
  }

  // Hotkey 的「参数」取自哪里（Alfred 的 Argument 下拉）。
  // **缺省是剪贴板**：这个节点原来写死读剪贴板，老节点没有这个字段，换缺省会把它们弄坏。
  private async hotkeyArg(node: WorkflowNode | undefined): Promise<string> {
    const src = String(node?.config.argSource || "clipboard");
    if (src === "none") return "";
    if (src === "text") return String(node?.config.argText || "");
    if (src === "selection") {
      const { text, files } = await this.grabSelection("auto");
      return text.trim() ? text : files.join("\n");
    }
    const { clipboard } = await import("electron");
    return clipboard.readText() || "";
  }

  // 下游那个输入节点的关键词（带上尾随空格，好让用户接着打参数）。
  // 找不到就返回空串 —— 那时面板只会预填参数本身，仍然比什么都不做强。
  private downstreamKeyword(wf: Workflow, nodeId: string): string {
    for (const conn of this.outConns(wf, nodeId, "")) {
      const n = this.node(wf, conn.to);
      const kw = String(n?.config.keyword || "").trim();
      if (kw) return n?.config.withSpace === false ? kw : `${kw} `;
    }
    return "";
  }

  // ── Universal Action 触发（W4）：把「当前选中的东西」喂给工作流 ──
  // 和 Hotkey 触发的区别：Hotkey 读的是剪贴板里已有的内容；Universal Action 会先模拟一次 ⌘C
  // 把前台应用的选区抓过来，用完再把原来的剪贴板还回去。
  universals(): { accelerator: string; wfId: string; nodeId: string }[] {
    const out: { accelerator: string; wfId: string; nodeId: string }[] = [];
    for (const wf of this.workflows()) {
      for (const n of wf.nodes.filter((n) => n.type === "trigger.universal" && !n.disabled)) {
        const acc = String(n.config.accelerator || "").trim();
        if (acc) out.push({ accelerator: acc, wfId: wf.id, nodeId: n.id });
      }
    }
    return out;
  }

  // 抓当前选区：模拟 ⌘C → 等剪贴板真的变了 → 读文本/文件路径 → 还原剪贴板。
  // 还原是为了不吞掉用户手里的复制内容；剪贴板历史 800ms 轮询一次，一般也来不及看见这一瞬间。
  // want：text=只要文本，files=只要文件路径，auto=有文件先用文件，否则用文本。
  private async grabSelection(want: string): Promise<{ text: string; files: string[] }> {
    const { clipboard } = await import("electron");
    // 先备份现场：文件 > 图片 > 纯文本，还原时按剪贴板里原本有的那种写回去。
    const prevText = clipboard.readText();
    let prevFiles: Buffer | null = null;
    try { const b = clipboard.readBuffer("NSFilenamesPboardType"); if (b && b.length) prevFiles = b; } catch { /* 非 mac 没这个类型 */ }
    let prevImg: Electron.NativeImage | null = null;
    if (!prevFiles) { try { const i = clipboard.readImage(); if (!i.isEmpty()) prevImg = i; } catch { /* 忽略 */ } }
    const before = `${prevText}\u0000${readClipboardFiles(clipboard).join("\u0000")}`;

    if (!(await simulateCopy())) return { text: "", files: [] };   // 没授权/不支持 → 抓不到
    // 等前台应用真的把选区写进剪贴板，最多等 600ms（每 60ms 看一眼）。
    let text = "", files: string[] = [];
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 60));
      const t = clipboard.readText(), f = readClipboardFiles(clipboard);
      if (`${t}\u0000${f.join("\u0000")}` !== before) { text = t; files = f; break; }
    }
    try {
      clipboard.writeText(prevText);
      if (prevFiles) clipboard.writeBuffer("NSFilenamesPboardType", prevFiles);
      else if (prevImg) clipboard.writeImage(prevImg);
    } catch { /* 还原失败不影响本次触发 */ }

    if (want === "files") return { text: files.join("\n"), files };
    if (want === "text") return { text, files: [] };
    return { text: files.length ? files.join("\n") : text, files };
  }

  // Universal Action 触发：arg = 选中的文本（或文件路径，一行一个）；
  // 额外注入 selection_type / selection_files 两个变量，脚本里可以据此分开处理。
  async fireUniversal(wfId: string, nodeId: string): Promise<void> {
    const wf = this.workflows().find((w) => w.id === wfId);
    if (!wf) return;
    const n = this.node(wf, nodeId);
    const { text, files } = await this.grabSelection(String(n?.config.source || "auto"));
    const arg = text.trim() ? text : files.join("\n");
    if (!arg) {
      // 抓不到就明说，别让用户对着没反应的快捷键猜。最常见的原因是没给辅助功能权限。
      try {
        const { Notification } = await import("electron");
        new Notification({ title: wf.name, body: "没抓到选中的内容（先选中一段文字/几个文件，并确认已给 Umbra 辅助功能权限）" }).show();
      } catch { /* 无通知权限忽略 */ }
      return;
    }
    const vars = this.baseVars(wf);
    vars.selection_type = files.length ? "files" : "text";
    vars.selection_files = files.join("\n");
    const visited = new Set<string>();
    const tr = this.trace.begin(wf.id, wf.name, "Universal Action", arg);
    try {
      for (const conn of this.outConns(wf, nodeId, "")) await this.runNode(wf, conn.to, arg, vars, visited, this.uiCtx(), tr);
    } finally {
      this.trace.end(tr);
    }
  }
}

// 迁移：把旧 launcherScripts 转成 Keyword+Run Script 工作流（幂等，一次性）。
export function migrateScriptsToWorkflows(cfg: ConfigStore): boolean {
  const c = cfg.get();
  if (c.launcherScriptsMigrated) return false;
  const scripts = c.launcherScripts || [];
  const wfs: Workflow[] = [...(c.launcherWorkflows || [])];
  scripts.forEach((s, i) => {
    const id = `migrated-${i}-${Date.now().toString(36)}`;
    const trig: WorkflowNode = {
      id: "n1", type: "trigger.keyword", x: 60, y: 140,
      config: { keyword: s.keyword || s.name, arg: s.needsInput ? "optional" : "none", title: s.name },
    };
    const act: WorkflowNode = {
      id: "n2", type: "action.script", x: 340, y: 140,
      config: { script: s.command, output: s.output || "copy" },
    };
    wfs.push({
      id, name: s.name, icon: s.icon || "📜", enabled: true, variables: {},
      nodes: [trig, act], connections: [{ from: "n1", to: "n2", mod: "" }],
    });
  });
  cfg.save({ launcherWorkflows: wfs, launcherScriptsMigrated: true });
  return true;
}

// 迁移 V2：文件夹书签 → Keyword+Open File 工作流（幂等）。
export function migrateFolders(cfg: ConfigStore): boolean {
  const c = cfg.get();
  if (c.launcherMigratedV2) return false;
  const wfs: Workflow[] = [...(c.launcherWorkflows || [])];
  // 文件夹书签
  (c.launcherFolders || []).forEach((f, i) => {
    const name = f.name || f.path.split("/").pop() || f.path;
    wfs.push({
      id: `folder-${i}-${Date.now().toString(36)}`, name, icon: "📁", enabled: true, variables: {},
      nodes: [
        { id: "n1", type: "trigger.keyword", x: 60, y: 140, config: { keyword: name, arg: "none", title: name } },
        { id: "n2", type: "action.openfile", x: 340, y: 140, config: { path: f.path, app: f.app || "" } },
      ],
      connections: [{ from: "n1", to: "n2", mod: "" }],
    });
  });
  cfg.save({ launcherWorkflows: wfs, launcherMigratedV2: true });
  return true;
}

// 种子：把内置工具（编解码/计算/换算）作为默认工作流写入（用户可编辑/删除）。幂等。
export function seedBuiltinTools(cfg: ConfigStore): boolean {
  const c = cfg.get();
  if (c.launcherToolsSeeded) return false;
  const wfs: Workflow[] = [...(c.launcherWorkflows || [])];
  const kw = (id: string, name: string, icon: string, keyword: string, inputType: string, mode?: string): Workflow => ({
    id: `builtin-${id}-${Date.now().toString(36)}`, name, icon, enabled: true, variables: {},
    nodes: [
      { id: "n1", type: "trigger.keyword", x: 60, y: 140, config: { keyword, arg: "required", title: name } },
      { id: "n2", type: inputType, x: 340, y: 140, config: mode ? { mode } : {} },
    ],
    connections: [{ from: "n1", to: "n2", mod: "" }],
  });
  const always = (id: string, name: string, icon: string, inputType: string): Workflow => ({
    id: `builtin-${id}-${Date.now().toString(36)}`, name, icon, enabled: true, variables: {},
    nodes: [
      { id: "n1", type: "trigger.always", x: 60, y: 140, config: {} },
      { id: "n2", type: inputType, x: 340, y: 140, config: {} },
    ],
    connections: [{ from: "n1", to: "n2", mod: "" }],
  });
  wfs.push(
    kw("uni", "Unicode 编解码", "🔡", "uni", "input.codec", "unicode"),
    kw("url", "URL 编解码", "🔗", "url", "input.codec", "url"),
    kw("b64", "Base64 编解码", "🔠", "b64", "input.codec", "base64"),
    always("calc", "计算器", "🔢", "input.calc"),
    always("units", "单位换算", "📐", "input.units"),
  );
  cfg.save({ launcherWorkflows: wfs, launcherToolsSeeded: true });
  return true;
}
