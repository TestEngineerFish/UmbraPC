// 工作流可视化编辑器（类 Alfred Workflow）。独立窗口：左工作流列表 / 中可拖拽画布 / 右节点面板。
// 画布：节点按下任意处拖动、单击选中(Delete 删)、双击配置、右键菜单；端口拉线连接；
// 连线徽章：单击选中、双击切换修饰键、右键删除；Cmd+Z 撤销；滚轮/按钮缩放；空白拖拽平移（无限画布）。
import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import {
  IconAlert, IconBell, IconBook, IconBranch, IconBug, IconBulb, IconCalc, IconCalendar, IconChat, IconCheck,
  IconChevronDown, IconChevronRight, IconClip, IconClock, IconCloud, IconCode, IconCommand, IconCopy, IconDice,
  IconDots, IconDownload,
  IconExternal, IconEye,
  IconFit, IconMinus,
  IconEyeOff, IconFile, IconFilter, IconFlow, IconFolder, IconGear, IconGlobe, IconGrid, IconInfinity, IconKeyboard,
  IconLink, IconList, IconMusic, IconPanel, IconPlay, IconPlus, IconRedo, IconRefresh, IconRocket,
  IconRuler, IconScissors, IconSearch, IconTag, IconTarget, IconTerminal, IconText, IconTrash, IconUndo,
  IconVolume, IconWindow, IconX,
} from "../../components/icons";
import {
  Blank, BTN_SEC, CardList, CELL, CELL_MONO, CheckRow, Code, CodeRow, Dlg, FLD, FLD_MONO, Fold, Hint,
  HotkeyField, Note, PickField, Pill, Row, RowTable, Sec, sameConfig,
} from "./nodeform";
import type { DlgWidth } from "./nodeform";
import { ContextMenu } from "./menu";
import type { MenuItem } from "./menu";

// 对象清单里每一项的图标：统一是 icons.tsx 里那套线性图标组件（只吃 size，颜色跟父级 color 走）。
type IconComp = ComponentType<{ size?: number }>;

// disabled：临时停用（E6）。触发器停用=整条链路唤不起来；其它节点停用=旁路，入参原样往下传。
export interface WFNode { id: string; type: string; x: number; y: number; config: Record<string, unknown>; disabled?: boolean }
// fromPort：从上游节点的哪个出口引出。""=默认/唯一出口；"r0".."rN"=Conditional 第 N 条规则命中；
// "else"=Conditional 兜底；"error"=Run Script 失败出口（onError=branch 时才有）。
export interface WFConn { from: string; to: string; mod?: string; fromPort?: string }
// 配置项声明（W10）：把工作流里要人填的东西抬到一张表单上。值仍旧落在 variables[key]，
// 所以脚本里照样 {var:key} 取；password 类型例外 —— variables[key] 存的是 vault://... 引用，
// 明文在密码保险箱里，执行时主进程现取。
export interface WFConfigField {
  key: string; label: string;
  type: "text" | "password" | "file" | "select" | "checkbox";
  default?: string; help?: string; options?: string[];
}
export interface WF { id: string; name: string; icon?: string; desc?: string; enabled: boolean; config?: WFConfigField[]; variables?: Record<string, string>; nodes: WFNode[]; connections: WFConn[] }

// 调试轨迹（W8）：结构与主进程 electron/core/launcher/trace.ts 一一对应，改一边要同步另一边。
export interface TraceStep {
  seq: number; nodeId: string; type: string; arg: string; vars: Record<string, string>;
  outArg: string; outPort: string; ms: number;
  feedback?: string; error?: string; stdout?: string; stderr?: string; exitCode?: number;
  skipped?: boolean; stopped?: boolean;
}
export interface TraceRun {
  id: string; wfId: string; wfName: string; trigger: string; arg: string; at: number; ms: number; steps: TraceStep[];
}

// 预制件（E3）：把选中的一组节点连同它们之间的连线整块存下来，之后在任何工作流里一键落地。
// 节点坐标以组内左上角为原点，落地时再整体平移到落点；节点 id 落地时重新生成，所以这里存的是「模板」。
export interface WFPrefab { id: string; name: string; nodes: WFNode[]; connections: WFConn[]; createdAt: number }

interface LauncherAPI {
  getWorkflows(): Promise<WF[]>; setWorkflows(w: WF[]): Promise<void>;
  // E3：预制件是全局的（不属于某条工作流），单独一份配置。
  getPrefabs(): Promise<WFPrefab[]>; setPrefabs(p: WFPrefab[]): Promise<void>;
  pickPath(): Promise<string>; pickApp(): Promise<string>; fileIcon(p: string): Promise<string>;
  getTrace(wfId?: string): Promise<TraceRun[]>; clearTrace(): Promise<void>;
  // 顶栏「运行」：带参手动跑一条工作流。nodeId 留空 = 自动挑第一个可用触发器。
  runWorkflow(wfId: string, nodeId: string, arg: string): Promise<{ ok: boolean; from: string; feedback: string; error: string }>;
  onTrace(cb: (r: TraceRun) => void): () => void;
  // W10：把配置项里的密钥交给密码保险箱，拿回一条 vault://... 引用存进工作流。
  setWfSecret(ref: string, title: string, value: string): Promise<{ ok: boolean; ref?: string; error?: string }>;
  vaultUnlocked(): Promise<boolean>;
  checkAccel(accel: string): Promise<{ state: string; by?: string; message?: string }>;
  // 打开这条工作流自己的目录：脚本节点的默认 cwd 就是它，随行的可执行文件/资源都放在里面。
  openWorkflowDir(wfId: string): Promise<{ ok: boolean; dir: string; error: string }>;
}
const api = (window as unknown as { umbraLauncher: LauncherAPI }).umbraLauncher;

const NODE_W = 252;   // 节点卡片宽度（对齐设计稿）
// 节点最小高度（框选命中判定 + 适应画布的包围盒用；多出口节点会更高但不影响判定）。
// 88 = 头部 42 + 正文两行键值行（上下 8px 内边距 + 两行 15px + 行距 3px）+ 分隔线。
// 正文从一行文字改成两行键值行时跟着加了 14 —— 不改的话卡片底部那一截框选选不中。
const NODE_H = 88;
const PORT_Y = 21;    // 端口的垂直位置：卡片头部的竖直中线（1px 描边 + 9px 内边距 + 22px 图标的一半）
const PORT_GAP = 20;   // 多出口节点：相邻两个输出端口的垂直间距
const MODS = ["", "cmd", "alt", "ctrl", "shift"];
const MOD_LABEL: Record<string, string> = { "": "↵", cmd: "⌘↵", alt: "⌥↵", ctrl: "⌃↵", shift: "⇧↵" };
const WORLD_W = 4000, WORLD_H = 3000;
// 右侧对象库的开合状态（记在本地，跟着人走而不是跟着工作流走）。
const LS_LIB = "umbra.wf.lib";
// 顶栏连体图标条里单个按钮的公共类名。分隔线（border-r）与选中态背景在使用处按需拼，
// 因为「有右边线 / 没右边线」和「橙底 / 透明底」都属于同类工具类，靠 className 顺序覆盖不了。
const TB = "w-8 h-[30px] flex-none flex items-center justify-center bg-transparent";
// 工作流列表每行第二行的说明文字：几个节点 + 靠什么触发。
// 触发方式取第一个 trigger.* 节点，一条工作流通常只有一个；一个都没有时说清楚「还没有触发器」。
const TRIGGER_SHORT: Record<string, string> = {
  "trigger.keyword": "关键词", "trigger.hotkey": "热键", "trigger.always": "每次输入",
  "trigger.universal": "选中即用",
};
function wfMeta(w: WF): string {
  const t = w.nodes.find((n) => n.type.startsWith("trigger."));
  return `${w.nodes.length} 个节点 · ${t ? TRIGGER_SHORT[t.type] || "触发器" : "无触发器"}`;
}

// 对象清单：分组和命名对齐 Alfred，方便从 Alfred 迁过来的人直接照着找。
// ── 明确不做、已从对象库移除的 Alfred 对象 ────────────────────────────────────
// 这些曾经以置灰占位的形式列在下面，2026-07 决定移除。理由集中记在这里，
// 免得将来只看到「Alfred 有而我们没有」就当成漏项又加回去。想翻案时先读这一段。
//
//   Snippet 片段触发     打字触发：在任意输入框敲一段缩写就跑工作流，不弹面板。
//                        要全局按键监听（逐个读系统里每一次按键）才能判断缩写。
//                        实现形状和键盘记录器一样，而我们还存着密码保险箱 ——
//                        要做得先定清楚监听范围、密码框里停不停、这段代码怎么让人信得过。
//   File Action 文件动作  它是**扩展点**：把工作流挂进「选中文件后弹出的动作清单」。
//                        我们没有那张清单，所以不是这个触发器难做，而是它要挂的东西不存在。
//                        最接近的是 trigger.universal 把抓取源设成「选中的文件路径」。
//   Contact Action        同上，挂在「联系人查看器」上。那个功能我们整个没有，也不打算做。
//   External 外部调用     给别的程序留一个可被调用的入口（Alfred 走 AppleScript）。
//   Call External Trigger 从一条工作流跳去触发另一条，是 External 的配套。
//                        这两个的意图会被「把工作流做成设备能力、与技能同级」覆盖掉，
//                        而那条路（走设备技能派发）在入口形状、鉴权、参数传递上都更清楚。
//                        引擎侧的 runFromEditor(wfId, nodeId, arg) 已经是那个形状了。
//                        真要做时按设备能力来设计，别照抄 Alfred 的 External。
//   Remote 远程触发       手机端点一下触发桌面。等可信设备网络那一期，届时和上面一条同源。
//   Automation Task       调用预置的系统自动化任务包。我们用「设备技能」对应，不另做一个。
//
// 移除的是**占位符，不是能力** —— 这七个从来没有引擎分支，删掉不影响任何已有功能。
// 现在对象库里**每一项都能用**。曾经的置灰占位机制（soon 标记 + 「待实现」徽章）
// 随上面那七项一起撤掉了。撤而不留，是因为一旦没有任何项在用它，那几个分支就再也不会
// 被执行，而不执行的代码会随周边改动悄悄烂掉 —— 这轮改版就动过对象库的样式。
// 将来真要再摆占位项，把标记加回来大约十行：CatItem 加字段、对象库按它置灰、
// nodeRows 给它一行「暂未实现」。别为了「以后可能用」把死代码留在这儿。
// hint 是悬停说明，写清楚这个对象干什么、有什么代价。
interface CatItem { type: string; label: string; icon: IconComp; hint?: string }
// 导出给测试遍历用（见 nodeRows 上面那句）。
export const CATALOG: { cat: string; icon: IconComp; items: CatItem[] }[] = [
  { cat: "触发 Triggers", icon: IconKeyboard, items: [
    { type: "trigger.keyword", label: "Keyword 关键词", icon: IconKeyboard },
    { type: "trigger.hotkey", label: "Hotkey 全局热键", icon: IconCommand },
    // 注意别把它当成 Alfred 的 Fallback Search —— Fallback 是「本地一条结果都没搜到时才冒出来」，
    // 我们这个是**每次查询都无条件跑一遍并把结果并进列表**，触发时机完全不同。
    // 名字也别叫 Fallback，写过 Alfred 工作流的人会照着 Fallback 的时机去设计，然后发现对不上。
    { type: "trigger.always", label: "Always 每次输入都跑", icon: IconInfinity, hint: "任意输入都会跑一遍下游的输入节点（计算器、单位换算这类），结果并入普通搜索。不是「搜不到才兜底」，是每次都并入。" },
    { type: "trigger.universal", label: "Universal Action 选中即用", icon: IconTarget },
  ] },
  { cat: "输入 Inputs", icon: IconFilter, items: [
    { type: "input.scriptfilter", label: "Script Filter 脚本过滤器", icon: IconSearch },
    { type: "input.listfilter", label: "List Filter 列表过滤器", icon: IconList },
    { type: "input.codec", label: "编解码", icon: IconCode },
    { type: "input.calc", label: "计算器", icon: IconCalc },
    { type: "input.units", label: "单位换算", icon: IconRuler },
    { type: "input.filefilter", label: "File Filter 文件过滤器", icon: IconFolder, hint: "按关键词、目录范围和文件类型搜本地文件并列出来。macOS 走 Spotlight，其余平台需限定目录。" },
    { type: "input.appsfilter", label: "Running Apps 运行中应用", icon: IconWindow, hint: "列出当前在跑的应用，回车切换或退出。仅 macOS。" },
    { type: "input.dict", label: "Dictionary 词典查询", icon: IconBook, hint: "把输入送进 macOS 的词典 App 查词。仅 macOS。" },
  ] },
  { cat: "工具 Utilities", icon: IconGear, items: [
    { type: "utility.args", label: "Args & Vars 改参数/设变量", icon: IconTag },
    { type: "utility.conditional", label: "Conditional 条件分流", icon: IconBranch },
    { type: "utility.transform", label: "Transform 大小写/编解码", icon: IconText },
    { type: "utility.replace", label: "Replace 查找替换", icon: IconRefresh },
    { type: "utility.delay", label: "Delay 延时", icon: IconClock },
    { type: "utility.debug", label: "Debug 调试打点", icon: IconBug },
    { type: "utility.split", label: "Split Arg 拆分参数", icon: IconScissors },
    { type: "utility.join", label: "Join Args 合并参数", icon: IconLink },
    { type: "utility.junction", label: "Junction 汇流点", icon: IconBranch, hint: "纯理线用的中转点，只影响连线走向不改数据。" },
    { type: "utility.filter", label: "Filter 过滤", icon: IconFilter, hint: "条件不满足就整条中断（Conditional 的单出口版）。" },
    { type: "utility.fileconditional", label: "File Conditional 文件条件", icon: IconFolder, hint: "按扩展名 / 是不是目录 / 名字包含什么来分流，多出口。" },
    { type: "utility.dialog", label: "Dialog Conditional 对话框", icon: IconAlert, hint: "弹个系统消息框问一句，按用户点了哪个按钮走不同出口。最多三个按钮。" },
    { type: "utility.random", label: "Random 随机值", icon: IconDice, hint: "生成随机数 / UUID / 随机串，写进参数或变量。" },
    { type: "utility.jsonconfig", label: "JSON Config 配置", icon: IconFile, hint: "用一段 JSON 一次性设置多个变量。" },
    { type: "utility.hide", label: "隐藏主面板", icon: IconEyeOff, hint: "执行到这里先把快捷入口面板收起来再继续（新窗口就不会被它挡住）。" },
    { type: "utility.show", label: "显示主面板", icon: IconEye, hint: "把快捷入口面板重新唤起，和「隐藏主面板」配套。" },
  ] },
  { cat: "动作 Actions", icon: IconRocket, items: [
    { type: "action.launch", label: "Launch Apps / Files 启动", icon: IconRocket },
    { type: "action.openfile", label: "Open File 打开文件/书签", icon: IconFolder },
    { type: "action.openurl", label: "Open URL 打开网址", icon: IconGlobe },
    { type: "action.script", label: "Run Script 执行脚本", icon: IconTerminal },
    { type: "action.copy", label: "Copy to Clipboard 复制", icon: IconCopy },
    { type: "action.paste", label: "粘贴到前台", icon: IconClip },
    { type: "action.assistant", label: "发给秘书", icon: IconChat },
    { type: "action.inspiration", label: "记为灵感", icon: IconBulb },
    { type: "action.ask_assistant", label: "问秘书（等回复）", icon: IconChat },
    { type: "action.create_task", label: "建任务", icon: IconCalendar },
    { type: "action.device_skill", label: "设备技能派发", icon: IconCloud },
    { type: "action.reveal", label: "Reveal in Finder 在文件管理器中显示", icon: IconSearch, hint: "在系统文件管理器里定位并选中这个文件（不打开它）。" },
    { type: "action.terminal", label: "Terminal Command 终端命令", icon: IconTerminal, hint: "把命令打进终端窗口里、看着它跑。要拿命令的输出请用 Run Script —— 终端在另一个进程里，我们取不到它的输出。仅 macOS。" },
    { type: "action.browse", label: "Browse in Terminal 在终端中打开目录", icon: IconTerminal, hint: "在终端里打开这个目录；给的是文件就取它所在的目录。仅 macOS。" },
    { type: "action.websearch", label: "Web Search 网页搜索", icon: IconGlobe, hint: "拿参数去搜索引擎搜一下。默认 Google，可改成 Bing/百度/GitHub 等，也可自己填地址模板。" },
    { type: "action.filebuffer", label: "File Buffer 文件暂存区", icon: IconGrid, hint: "把文件先攒起来，攒够了一次性交给下游。只在内存里，退出即清空。" },
    { type: "action.applescript", label: "Run AppleScript", icon: IconTerminal, hint: "跑一段 AppleScript，可拿回它的返回值。仅 macOS。" },
  ] },
  { cat: "自动化 Automations", icon: IconClock, items: [
    { type: "automation.shortcut", label: "Run Shortcut 运行快捷指令", icon: IconGear, hint: "调用「快捷指令」App 里的一条指令，可传入参数、取回结果。需 macOS 12+。" },
    { type: "automation.system", label: "System Command 系统命令", icon: IconCommand, hint: "锁屏、睡眠、屏保、清废纸篓这类系统操作。仅 macOS。" },
    { type: "automation.music", label: "Music Command 音乐控制", icon: IconMusic, hint: "控制「音乐」App：播放/暂停、切歌、音量、看当前播放。仅 macOS。" },
  ] },
  { cat: "输出 Outputs", icon: IconBell, items: [
    { type: "output.notify", label: "Post Notification 系统通知", icon: IconBell },
    { type: "output.largetype", label: "Large Type 大字显示", icon: IconBook },
    { type: "output.textview", label: "Text View 文本视图", icon: IconFile },
    { type: "output.writefile", label: "Write Text File 写文本文件", icon: IconDownload },
    { type: "output.keycombo", label: "Dispatch Key Combo 发送按键", icon: IconKeyboard, hint: "向前台应用发一组按键。需要辅助功能权限。" },
    { type: "output.speak", label: "Speak 朗读", icon: IconVolume, hint: "用系统语音把文本念出来（macOS 的 say / Windows 的 SAPI），不用装任何东西。" },
    { type: "output.sound", label: "Play Sound 播放提示音", icon: IconMusic, hint: "播一段提示音，用来给长链路收个尾。不填路径就用系统自带的提示音。" },
  ] },
];
const TYPE_META: Record<string, { label: string; icon: IconComp; kind: string }> = {};
for (const g of CATALOG) for (const it of g.items) TYPE_META[it.type] = { label: it.label, icon: it.icon, kind: it.type.split(".")[0] };

// 节点类型前缀的中文名。弹窗副标题是「分类 · 一句话」，分类就取这里。
export const KIND_LABEL: Record<string, string> = {
  trigger: "触发器", input: "输入", utility: "工具", action: "动作", automation: "自动化", output: "输出",
};
// 弹窗头部副标题：每种节点一句话，说**它到底干什么**，不是把标题换个说法重念一遍。
// 约束是「一行放得下」——溢出会被省略号截掉，所以宁可短。
// 对象库里的 hint 是另一回事：那是「要不要选它」的说明，可以长；这里是「已经选了，它做什么」。
export const NODE_SUB: Record<string, string> = {
  "trigger.keyword": "在快捷入口敲这个词就跑起来",
  "trigger.hotkey": "任何应用里按下都能启动这条工作流",
  "trigger.always": "每次输入都跑一遍，结果并入普通搜索",
  "trigger.universal": "按热键抓走当前选区，拿它当参数开跑",

  "input.scriptfilter": "跑一段脚本，把它吐的 JSON 变成结果列表",
  "input.listfilter": "维护一张固定列表，按输入过滤后给出结果",
  "input.codec": "做 Unicode / URL / Base64 编解码",
  "input.calc": "输入算式即时求值，回车复制结果",
  "input.units": "输入换算式即时换算，回车复制结果",
  "input.filefilter": "按名字和类型找本机文件，选中把路径传给下游",
  "input.appsfilter": "列出正在跑的应用，选中切换或退出它",
  "input.dict": "把输入当一个词，回车在系统词典里打开",

  "utility.args": "改写传给下游的参数，或追加一组变量",
  "utility.conditional": "从上往下匹配，命中第一条就走那个出口",
  "utility.transform": "对参数或某个变量做一次文本变换",
  "utility.replace": "在参数或变量里做字符串 / 正则替换",
  "utility.delay": "在这里停一会儿再往下走",
  "utility.debug": "往调试抽屉打一行点，不影响链路",
  "utility.split": "把一条参数拆成多条，或拆成一组变量",
  "utility.join": "把上游拆出来的多条参数并回一条",
  "utility.junction": "纯理线的中转点，数据原样透传",
  "utility.filter": "任一条规则命中才放行，否则中断链路",
  "utility.fileconditional": "按路径特征分流：扩展名、是不是目录、名字里有什么",
  "utility.dialog": "弹个框问一句，按点了哪个按钮分流",
  "utility.random": "生成一个随机值，写进参数或某个变量",
  "utility.jsonconfig": "用一段 JSON 设变量、改参数、改下游节点配置",
  "utility.hide": "先把快捷入口面板收起来，再继续跑下游",
  "utility.show": "把快捷入口面板重新唤起来",

  "action.launch": "启动一批应用或文件",
  "action.openfile": "用系统默认应用（或指定应用）打开文件",
  "action.openurl": "打开一个网址",
  "action.script": "在本机执行一段脚本，标准输出传给下游",
  "action.copy": "把上游参数写进系统剪贴板",
  "action.paste": "把上游参数直接粘到前台应用里",
  "action.assistant": "把上游参数发到聊天页给秘书，不等回复",
  "action.inspiration": "把上游参数记成一条灵感",
  "action.ask_assistant": "问秘书并等回复，回复继续传给下游",
  "action.create_task": "把上游参数变成一条任务交给秘书",
  "action.device_skill": "把一个技能派发到指定设备上执行",
  "action.reveal": "在文件管理器里定位并选中这个文件",
  "action.terminal": "把命令打进终端窗口里，看着它跑",
  "action.browse": "在终端里打开这个目录",
  "action.websearch": "拿参数去搜索引擎搜一下",
  "action.filebuffer": "把文件先攒起来，攒够了一次交给下游",
  "action.applescript": "跑一段 AppleScript，可以拿回它的返回值",

  "automation.shortcut": "调用「快捷指令」App 里的一条指令",
  "automation.system": "锁屏、睡眠、屏保这类系统操作",
  "automation.music": "控制「音乐」App：播放、切歌、音量",

  "output.notify": "弹一条系统通知",
  "output.largetype": "把内容放大居中显示在半透明浮层里",
  "output.textview": "把内容显示在文本视图窗口里",
  "output.writefile": "把内容写成文件，最终路径传给下游",
  "output.keycombo": "向前台应用发一组按键",
  "output.speak": "用系统语音把文本念出来",
  "output.sound": "播一段提示音",
};
// 弹窗宽度：默认 440（纯表单单列）。这里只登记要加宽的那些。
// md=560：有脚本编辑区或内嵌两列表格；lg=720：一行三列以上的表格编辑器。
export const DLG_WIDTH: Record<string, DlgWidth> = {
  "input.scriptfilter": "md", "action.script": "md", "action.applescript": "md",
  "action.terminal": "md", "utility.jsonconfig": "md", "utility.args": "md",
  "utility.conditional": "md", "utility.filter": "md", "utility.fileconditional": "md",
  "input.filefilter": "md", "action.device_skill": "md",
  "input.listfilter": "lg",
};
// 画布配色：设计规范里画布是全局唯一硬编码深色的地方（深浅色主题切换时它不变），
// 所以这些值不走 CSS 变量，集中放这一处，改配色只动这个对象。
const CV = {
  bg: "#151310",              // 画布底
  node: "#232019",            // 节点卡片底
  nodeOff: "#1F1C18",         // 停用节点的卡片底（比正常再暗一档）
  nodeBorder: "#383229",      // 节点描边
  nodeOffBorder: "#3D372E",   // 停用节点的虚线描边
  nodeLine: "#332E26",        // 节点头部与内容之间的分隔线
  wire: "#4E463C",            // 连线
  port: "#5B5347",            // 端口（默认/兜底出口）
  chip: "rgba(35,32,25,.92)", // 浮层（缩放胶囊、底部信息条、连线徽章）的底色
  text: "#EDEAE3",
  muted: "#9A938A",
  faint: "#6E675E",
  dim: "#C9C3B8",             // 浮层里的正文（比 text 稍收敛）
  orange: "#E8590C",
  orangeText: "#F0A878",
  danger: "#E0675C",
};
// 画布浮层（缩放胶囊 / 选区信息 / 快捷键条）的公共外观，三处一致。
const CV_FLOAT = { background: CV.chip, border: `1px solid ${CV.nodeBorder}`, borderRadius: 9 };
// 缩放胶囊里单个按钮的类名（颜色在使用处走内联样式，因为画布配色不走 CSS 变量）。
const ZB = "w-8 h-[26px] flex-none flex items-center justify-center bg-transparent hover:bg-[rgba(255,255,255,.07)]";
// 画布快捷键：底部条只露前四条，其余进「全部快捷键」弹窗；两处同一份数据，不会各说一套。
const CANVAS_KEYS: { key: string; label: string }[] = [
  { key: "/", label: "搜对象" },
  { key: "⌘Z", label: "撤销" },
  { key: "⌘D", label: "停用" },
  { key: "⇧拖", label: "框选" },
  { key: "⇧⌘Z", label: "重做" },
  { key: "⌘A", label: "全选节点" },
  { key: "⌘点击", label: "加选 / 减选" },
  { key: "Delete", label: "删除选中的节点或连线" },
  { key: "双击节点", label: "配置这个节点" },
  { key: "双击空白", label: "在落点处搜对象" },
  { key: "⇧1", label: "适应画布" },
  { key: "⇧0", label: "复位视图（100%）" },
  { key: "⌘/⌃+滚轮", label: "缩放" },
  { key: "拖空白", label: "平移画布" },
  { key: "拖端口", label: "连线到另一个节点" },
  { key: "右键", label: "添加对象 / 对齐 / 存预制件" },
];

// 节点按大类着色：画布是全局唯一硬编码深色的地方，所以这套颜色也直接写死，不走 CSS 变量。
// bg 是头部图标方块的底色，fg 是图标本身的颜色，label 是头部右侧那颗小徽章的文字。
// 六个大类各给一个色相，都在 #232019 底上验过对比度。
const KIND_STYLE: Record<string, { label: string; bg: string; fg: string }> = {
  trigger:    { label: "触发",   bg: "rgba(232,89,12,.18)",  fg: "#F0A878" },
  input:      { label: "输入",   bg: "rgba(56,132,199,.22)", fg: "#7FB3DF" },
  utility:    { label: "工具",   bg: "rgba(139,92,246,.20)", fg: "#B39DF3" },
  action:     { label: "动作",   bg: "rgba(15,118,110,.22)", fg: "#34B5A6" },
  automation: { label: "自动化", bg: "rgba(79,184,201,.20)", fg: "#4FB8C9" },
  output:     { label: "输出",   bg: "rgba(180,83,9,.24)",   fg: "#D98A29" },
};
// 拍平的对象清单（E1 搜索面板用）：分类信息一并带上，搜索时把分类名也算进匹配范围。
// 只收已实现的 —— 搜索面板和右键菜单是「直接添加」的入口，置灰项混进去只会白点一下。
const ALL_ITEMS: { type: string; label: string; icon: IconComp; cat: string }[] =
  CATALOG.flatMap((g) => g.items.map((it) => ({ type: it.type, label: it.label, icon: it.icon, cat: g.cat })));
// 右键菜单用的「分类 → 已实现对象」清单（空分类直接不出现）。
// total 一并带上：右键菜单的分类行按设计稿显示「已实现/总数」，让菜单本身也是一张能力地图。
const ADD_GROUPS: { cat: string; icon: IconComp; items: CatItem[]; total: number }[] =
  CATALOG.map((g) => ({ cat: g.cat, icon: g.icon, items: g.items, total: g.items.length }));

function defaultConfig(type: string): Record<string, unknown> {
  switch (type) {
    case "trigger.keyword": return { keyword: "kw", arg: "optional", title: "", withSpace: true };
    case "trigger.hotkey": return { accelerator: "" };
    case "trigger.universal": return { accelerator: "", source: "auto" };
    case "input.scriptfilter": return { script: "", cwd: "", alfredFilters: false, debounceMs: 0 };
    case "input.listfilter": return { items: [{ title: "示例项", subtitle: "", arg: "" }], match: "word", learn: true };
    case "input.codec": return { mode: "unicode" };
    case "action.script": return { script: "", cwd: "", language: "bash", output: "none", onError: "stop" };
    case "action.applescript": return { script: "", output: "replace", onError: "stop" };
    case "automation.shortcut": return { name: "", input: true, output: "none", wait: true };
    case "automation.system": return { command: "lock", confirm: false };
    case "output.notify": return { title: "", text: "", ifEmpty: "skip" };
    case "output.keycombo": return { accelerator: "", hideFirst: true, delayMs: 180, repeat: 1 };
    case "utility.args": return { argMode: "keep", text: "{query}", vars: {} };
    case "utility.conditional": return { rules: [{ subject: "{query}", op: "contains", value: "", ci: true }] };
    case "utility.transform": return { target: "", mode: "upper" };
    case "utility.replace": return { target: "", find: "", to: "", regex: false, ci: false };
    case "utility.delay": return { seconds: 1 };
    case "utility.dialog": return { title: "确定要继续吗？", text: "", buttons: ["取消", "继续"], defaultIndex: 1, cancelIndex: 0, kind: "warning" };
    case "utility.debug": return { text: "{query}", after: "pass", clear: false };
    case "utility.split": return { with: "comma", custom: "", trim: true, discardEmpty: false, output: "vars", prefix: "split" };
    case "utility.join": return { with: "newline", custom: "" };
    case "output.writefile": return { path: "", content: "{query}", ifExists: "overwrite", uuid: false, mkdirs: true, allowEmpty: false };
    case "action.ask_assistant": return { prompt: "{query}", title: "", show: true };
    case "action.create_task": return { text: "{query}", prefix: "帮我建个任务：" };
    case "action.device_skill": return { device: "", provider: "", skill: "", params: "" };
    case "output.textview": return { title: "", markdown: true, append: false };
    case "action.openurl": return { url: "{query}", browser: "" };
    case "action.openfile": return { path: "{query}", app: "" };
    case "action.launch": return { paths: [], toggleVisibility: false };
    case "action.terminal": return { command: "{query}", app: "Terminal" };
    case "action.websearch": return { engine: "google", query: "{query}", custom: "", browser: "" };
    case "output.speak": return { text: "{query}", voice: "", rate: 0, wait: false };
    case "output.sound": return { path: "", system: "Glass" };
    default: return {};
  }
}
// 对话框的按钮清单。**主进程 electron/core/launcher/workflow.ts 里有一份一模一样的**。
//
// 为什么宁可抄一份也不 import 那边的：那个模块顶层 import 了 node:fs / node:path /
// 整个执行引擎，拖进渲染层包既跑不起来也白胖一大截。而这里需要的只是十行纯逻辑。
// 代价是两份可能走岔 —— 出口是按下标编号的（b0/b1/b2），两边对按钮个数的理解差一个，
// 连线就接到别的分支上去了。所以 tests/dialog.test.ts 拿一组配置把两份实现逐个对过，
// 走岔了测试当场就红。别把这段改成「差不多就行」。
const DIALOG_MAX_BUTTONS = 3;
export function dialogButtons(config: Record<string, unknown>): string[] {
  const raw = Array.isArray(config.buttons) ? (config.buttons as unknown[]) : [];
  const list = raw.slice(0, DIALOG_MAX_BUTTONS).map((b, i) => String(b ?? "").trim() || `按钮${i + 1}`);
  return list.length ? list : ["取消", "确定"];
}

// 节点的输出端口清单：默认只有一个匿名出口；Conditional 按规则条数出 r0…rN 再加一个 else；
// Run Script 选了「失败走分支」时，成功口之外再多一个 error 口。端口顺序即画布上从上到下的顺序。
export function outPorts(n: WFNode): { port: string; label: string }[] {
  // 文件条件和普通条件的出口结构完全一样（每条规则一个口 + 一个「否则」），
  // 只是规则比的东西不同，所以这里合在一起处理。
  if (n.type === "utility.conditional" || n.type === "utility.fileconditional") {
    const rules = Array.isArray(n.config.rules) ? (n.config.rules as { label?: string }[]) : [];
    // 出口名留空就退回「规则N」—— 名字是可选的，没填也得有个能指认的标签。
    const list = rules.map((r, i) => ({ port: `r${i}`, label: String(r?.label || "").trim() || `规则${i + 1}` }));
    list.push({ port: "else", label: "否则" });
    return list;
  }
  // 对话框：每个按钮一个出口，标签就是按钮文字。按钮个数由引擎那份 dialogButtons 说了算 ——
  // 两边各算一遍的话，差一个按钮就会把连线接到别的分支上。
  if (n.type === "utility.dialog") {
    return dialogButtons(n.config).map((b, i) => ({ port: `b${i}`, label: b }));
  }
  if (n.type === "action.script" && String(n.config.onError || "stop") === "branch") {
    return [{ port: "", label: "成功" }, { port: "error", label: "失败" }];
  }
  return [{ port: "", label: "" }];
}
// 出口在清单里的序号（用于算端口坐标）。找不到（比如规则删少了）就退回第一个口。
const portIndex = (n: WFNode, port?: string): number => {
  const i = outPorts(n).findIndex((p) => p.port === (port || ""));
  return i < 0 ? 0 : i;
};

const uid = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const clone = <T,>(w: T): T => JSON.parse(JSON.stringify(w));

// ── 对象面板（E1）：可搜索的节点清单 ──
// 双击画布空白、或按 / 、\ 唤起；↑↓ 选择、回车添加；⌥回车 额外把新节点接到当前选中节点后面。
function Palette({ canConnect, onPick, onClose }: { canConnect: boolean; onPick: (type: string, connect: boolean) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const kw = q.trim().toLowerCase();
  const list = kw ? ALL_ITEMS.filter((it) => `${it.label} ${it.type} ${it.cat}`.toLowerCase().includes(kw)) : ALL_ITEMS;
  const sel = Math.min(idx, Math.max(0, list.length - 1));
  const listRef = useRef<HTMLDivElement>(null);
  // 选中项滚进可视区（键盘连按时不至于选到看不见的地方）。
  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(list.length - 1, i + 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); return; }
    if (e.key === "Enter" && list[sel]) { e.preventDefault(); onPick(list[sel].type, e.altKey && canConnect); onClose(); }
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-start justify-center pt-[14vh]" onMouseDown={onClose}>
      <div className="w-[440px] bg-card border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex-none flex items-center gap-[9px] px-[14px] py-3 border-b border-border">
          <span className="flex-none text-faint"><IconSearch size={14} /></span>
          <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }} onKeyDown={onKey}
            placeholder="搜索对象…（↑↓ 选择 · 回车添加 · ⌥回车 接到选中节点后）"
            className="flex-1 min-w-0 bg-transparent border-none outline-none text-[13px]" />
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto p-2 flex flex-col gap-px">
          {list.map((it, i) => (
            <button key={it.type} data-i={i} onMouseEnter={() => setIdx(i)}
              onClick={(e) => { onPick(it.type, e.altKey && canConnect); onClose(); }}
              className={`w-full flex items-center gap-[9px] px-2 py-1.5 rounded-lg text-left text-[12.5px] ${
                i === sel ? "bg-orange-soft text-orange-text font-semibold" : "bg-transparent"}`}>
              <span className={`w-5 h-5 flex-none flex items-center justify-center rounded-md ${i === sel ? "text-orange-text" : "text-muted"}`}><it.icon size={14} /></span>
              <span className="flex-1 min-w-0 truncate">{it.label}</span>
              <span className={`flex-none whitespace-nowrap text-[10.5px] font-normal ${i === sel ? "text-orange-text" : "text-faint"}`}>{it.cat}</span>
            </button>
          ))}
          {!list.length ? <div className="px-4 py-6 text-center text-[12px] text-muted">没有匹配「{q.trim()}」的对象</div> : null}
        </div>
      </div>
    </div>
  );
}

// ── 右侧对象库（布局参考 Alfred 的 Objects 面板）──
// 默认收起（顶栏「对象库」按钮切换），画布因此能占满整个宽度；需要挑对象时再拉出来。
// 分组可逐个折叠，顶部一个搜索框 + 全部展开/全部折叠两个箭头。
// 每个分类右侧的数字是这一类有几个对象；悬停某一项能看到它的说明。
// 对象库。**点击不再加节点** —— 点击是「选中并展开它的说明」，再点一次收起。
// 加节点只有一条路：拖到画布上。这样「点」和「拖」各司其职，不会点一下就多出个节点。
function ObjectLibrary({ prefabs, canAdd, onDragItem, onPrefab, onDelPrefab, onClose }: {
  prefabs: WFPrefab[]; canAdd: boolean;
  /** 按下条目：交给上层判断这是点击还是拖拽（移动超过阈值才算拖） */
  onDragItem: (type: string, e: React.MouseEvent) => void;
  onPrefab: (p: WFPrefab) => void; onDelPrefab: (p: WFPrefab) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  // 展开说明的那一个。同一时刻只有一个 —— 全展开会把列表拉得很长，反而找不到东西。
  const [sel, setSel] = useState("");
  // 折叠状态：key 是分类名（"预制件" 单独一个 key），true = 收起。默认全展开。
  const [fold, setFold] = useState<Record<string, boolean>>({});
  const kw = q.trim().toLowerCase();
  // 搜索时忽略折叠状态：既然在找东西，就把命中的都摊开。
  const groups = CATALOG.map((g) => ({
    cat: g.cat,
    items: kw ? g.items.filter((it) => `${it.label} ${it.type} ${g.cat}`.toLowerCase().includes(kw)) : g.items,
  })).filter((g) => g.items.length > 0);
  const setAll = (v: boolean) => setFold(Object.fromEntries([...CATALOG.map((g) => g.cat), "预制件"].map((c) => [c, v])));
  const hidden = (cat: string) => !kw && fold[cat];

  // 分组头：展开时给一块浅色底 + 描边计数胶囊，收起时整行淡下去 —— 一眼能看出哪些组是开着的。
  const head = (open: boolean) => `w-full flex items-center gap-[7px] px-2 py-1.5 rounded-[7px] ${
    open ? "bg-chip text-text" : "bg-transparent text-muted"} hover:bg-hover`;
  const countPill = (open: boolean) => `flex-none whitespace-nowrap text-[10px] tabular-nums px-1.5 py-px rounded-full text-faint border ${
    open ? "bg-card border-border" : "bg-transparent border-transparent"}`;
  // 组内条目：靠左边一条竖线归拢在分组下面（Alfred 的 Objects 面板也是这个层次感）。
  const nest = "flex flex-col gap-px mt-[3px] mb-2 ml-[15px] pl-[9px] border-l border-border";
  // 预制件那一行还是老样式（它的点击行为是「落地到画布中央」，和节点条目不是一回事）。
  const row = "w-full flex items-center gap-[9px] px-2 py-1.5 rounded-[7px] text-[12px] text-left";

  // 节点条目。透明边框是**占位**：选中时要描一圈橙边，没有这层占位边框会让整行跳 1px。
  //
  // 顺带记一笔：设计规范里还有「待实现」这一态（条目置灰 cursor:default、hover 无反馈、
  // 标题右侧一个 1px 描边的圆角徽标、10px --faint）。对象库里现在每一项都能用，
  // 那一态没有任何条目会进，所以不写成分支 —— 真要再摆占位项时照这段描述加回来即可。
  const item = (on: boolean) => [
    "w-full flex flex-col items-start gap-[5px] px-[8px] py-[6px] rounded-[7px] text-[12px]",
    "border border-solid",
    on ? "border-orange bg-orange-soft text-orange-text font-semibold"
       : "border-transparent bg-transparent text-text font-normal hover:bg-hover",
  ].join(" ");
  const itemIcon = (on: boolean) =>
    `w-[20px] h-[20px] flex-none rounded-[5px] flex items-center justify-center ${
      on ? "bg-[rgba(232,89,12,.14)] text-orange-text" : "bg-transparent text-muted"}`;

  return (
    <div className="w-[272px] flex-none border-l border-border bg-card flex flex-col min-h-0">
      <div className="flex-none flex flex-col gap-[9px] p-3 border-b border-border-soft">
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 flex items-center gap-[7px] bg-bg border border-border rounded-lg px-[9px] py-[5px]">
            <span className="flex-none text-faint"><IconSearch size={12} /></span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索对象"
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-[12px]" />
          </div>
          <button className="w-[26px] h-[26px] flex-none flex items-center justify-center bg-transparent border border-border rounded-[7px] text-muted hover:bg-hover" title="全部展开" onClick={() => setAll(false)}><IconChevronDown size={13} /></button>
          <button className="w-[26px] h-[26px] flex-none flex items-center justify-center bg-transparent border border-border rounded-[7px] text-muted hover:bg-hover" title="全部折叠" onClick={() => setAll(true)}><IconChevronRight size={13} /></button>
          <button className="w-[26px] h-[26px] flex-none flex items-center justify-center bg-transparent border border-border rounded-[7px] text-muted hover:bg-hover" title="收起对象库" onClick={onClose}><IconX size={13} /></button>
        </div>
        <div className="text-[11px] text-faint leading-[1.5]">拖到画布上放置 · 点一下看它做什么</div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {/* 预制件（E3）：点一下就落在画布中央，右键菜单里也有一份。和对象分组同一套外观。 */}
        {prefabs.length ? (
          <div className="mb-1">
            <button className={head(!hidden("预制件"))} onClick={() => setFold((f) => ({ ...f, 预制件: !f["预制件"] }))}>
              <span className="flex-none transition-transform" style={{ transform: hidden("预制件") ? "rotate(0deg)" : "rotate(90deg)" }}><IconChevronRight size={11} /></span>
              <span className="flex-1 min-w-0 text-left text-[12px] font-semibold truncate">预制件</span>
              <span className={countPill(!hidden("预制件"))}>{prefabs.length}</span>
            </button>
            {hidden("预制件") ? null : (
              <div className={nest}>
                {prefabs.map((p) => (
                  <div key={p.id} className="group flex items-center gap-1">
                    <button disabled={!canAdd} title={`落地到画布中央（${p.nodes.length} 个节点）`} onClick={() => onPrefab(p)}
                      className={`${row} flex-1 min-w-0 bg-transparent hover:bg-hover disabled:opacity-40`}>
                      <span className="w-5 h-5 flex-none flex items-center justify-center rounded-[5px] text-muted"><IconGrid size={14} /></span>
                      <span className="flex-1 min-w-0 truncate">{p.name}</span>
                    </button>
                    <button className="flex-none bg-transparent text-danger opacity-0 group-hover:opacity-100" title="删除这个预制件" onClick={() => onDelPrefab(p)}><IconTrash size={12} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
        {groups.map((g) => {
          const open = !hidden(g.cat);
          return (
            <div key={g.cat} className="mb-1">
              <button className={head(open)} onClick={() => setFold((f) => ({ ...f, [g.cat]: !f[g.cat] }))}>
                <span className="flex-none transition-transform" style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}><IconChevronRight size={11} /></span>
                <span className="flex-1 min-w-0 text-left text-[12px] font-semibold truncate">{g.cat}</span>
                <span className={countPill(open)}>{g.items.length}</span>
              </button>
              {open ? (
                <div className={nest}>
                  {g.items.map((it) => {
                    const on = sel === it.type;
                    return (
                      <button key={it.type} disabled={!canAdd}
                        title={it.hint || it.type}
                        onMouseDown={(e) => onDragItem(it.type, e)}
                        onClick={() => setSel(on ? "" : it.type)}
                        className={`${item(on)} disabled:opacity-40`}>
                        <span className="flex items-center gap-[9px] w-full">
                          <span className={itemIcon(on)}><it.icon size={14} /></span>
                          <span className="flex-1 min-w-0 text-left truncate whitespace-nowrap">{it.label}</span>
                        </span>
                        {/* 说明只在选中时出现。左边距 29px = 图标 20 + 间距 9，和标题左缘对齐。
                            字重/颜色要显式写回来 —— 选中态的容器是 600 字重 + 橙字，说明不该跟着变。 */}
                        {on ? (
                          <span className="pl-[29px] text-[11px] leading-[1.6] font-normal text-muted text-left [text-wrap:pretty]">
                            {NODE_SUB[it.type] ? `${NODE_SUB[it.type]}。` : it.type}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
        {!groups.length ? <div className="py-6 text-center text-[12px] text-muted">没有匹配「{q.trim()}」的对象</div> : null}
      </div>
    </div>
  );
}

// ── 调试抽屉（W8）：左侧最近若干次运行，右侧该次运行的逐节点轨迹 ──
// 点某一步会在画布上选中对应节点，方便「看到哪步出错就跳到哪个节点」。
function DebugDrawer({ runs, nodeLabel, onPickNode, onClear, onClose }: {
  runs: TraceRun[]; nodeLabel: (id: string, type: string) => string;
  onPickNode: (id: string) => void; onClear: () => void; onClose: () => void;
}) {
  const [curRun, setCurRun] = useState<string>("");
  const [openStep, setOpenStep] = useState<number | null>(null);
  const run = runs.find((r) => r.id === curRun) || runs[0];
  const time = (ts: number) => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });

  return (
    <div className="h-[240px] flex-none border-t border-border bg-card flex flex-col">
      <div className="flex-none flex items-center gap-2 px-3 py-1.5 border-b border-border-soft">
        <b className="flex-none whitespace-nowrap text-[12.5px]">调试</b>
        <span className="flex-1 min-w-0 truncate text-[11px] text-faint">最近 {runs.length} 次执行 · 点某一步可跳到对应节点（变量里疑似密钥的值已打码）</span>
        <button className="flex-none whitespace-nowrap text-[11.5px] text-muted bg-transparent border border-border rounded-md px-2 py-[3px] hover:bg-hover" onClick={onClear}>清空</button>
        <button className="flex-none whitespace-nowrap text-[11.5px] text-muted bg-transparent border border-border rounded-md px-2 py-[3px] hover:bg-hover" onClick={onClose}>收起</button>
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="w-[190px] flex-none border-r border-border overflow-y-auto">
          {runs.map((r) => (
            <button key={r.id} onClick={() => { setCurRun(r.id); setOpenStep(null); }}
              className={`w-full text-left px-3 py-1.5 text-[11.5px] border-b border-border-soft ${run?.id === r.id ? "bg-orange-soft text-orange-text" : "bg-transparent hover:bg-hover"}`}>
              <div className="flex items-center gap-1.5">
                <span className="flex-none font-mono text-muted">{time(r.at)}</span>
                <span className="flex-1 min-w-0 truncate">{r.trigger}</span>
                <span className="flex-none whitespace-nowrap text-muted">{r.ms}ms</span>
              </div>
              <div className="text-faint truncate">{r.wfName} · {r.steps.length} 步{r.arg ? ` · ${r.arg.slice(0, 16)}` : ""}</div>
            </button>
          ))}
          {!runs.length ? <div className="px-3 py-4 text-[11.5px] text-muted leading-[1.6]">还没有执行记录。<br />在启动器里跑一次这个工作流试试。</div> : null}
        </div>
        <div className="flex-1 min-w-0 overflow-y-auto">
          {run?.steps.map((s) => (
            <div key={s.seq} className="border-b border-border-soft">
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-left bg-transparent hover:bg-hover"
                onClick={() => { setOpenStep(openStep === s.seq ? null : s.seq); onPickNode(s.nodeId); }}>
                <span className="w-[18px] flex-none text-faint font-mono">{s.seq}</span>
                <span className="flex-1 min-w-0 truncate">{nodeLabel(s.nodeId, s.type)}</span>
                {/* 状态徽章沿用全局语义：灰=旁路、红=终止/异常、灰底=出口名。 */}
                {s.skipped ? <span className="flex-none whitespace-nowrap text-[10px] text-muted bg-chip rounded-full px-1.5">已停用 · 旁路</span> : null}
                {s.stopped ? <span className="flex-none whitespace-nowrap text-[10px] text-danger bg-danger-soft rounded-full px-1.5">终止</span> : null}
                {s.error ? <span className="flex-none whitespace-nowrap text-[10px] text-danger bg-danger-soft rounded-full px-1.5">异常</span> : null}
                {s.outPort ? <span className="flex-none whitespace-nowrap text-[10px] text-muted bg-chip rounded-full px-1.5">出口 {s.outPort}</span> : null}
                <span className="flex-none whitespace-nowrap text-faint font-mono">{s.ms}ms</span>
                <span className="flex-none text-faint">{openStep === s.seq ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}</span>
              </button>
              {openStep === s.seq ? (
                <div className="px-3 pb-2 text-[11px] text-muted grid gap-1">
                  <Field label="入参" v={s.arg} />
                  <Field label="出参" v={s.outArg} />
                  <Field label="变量" v={Object.entries(s.vars).map(([k, v]) => `${k}=${v}`).join("  ") } />
                  {s.feedback ? <Field label="提示" v={s.feedback} /> : null}
                  {s.stdout ? <Field label={`输出${s.exitCode !== undefined ? `（退出码 ${s.exitCode}）` : ""}`} v={s.stdout} /> : null}
                  {s.stderr ? <Field label="stderr" v={s.stderr} danger /> : null}
                  {s.error ? <Field label="异常" v={s.error} danger /> : null}
                </div>
              ) : null}
            </div>
          ))}
          {run && !run.steps.length ? <div className="px-3 py-4 text-[11.5px] text-muted">这次运行没有执行到任何节点。</div> : null}
          {!run ? <div className="px-3 py-4 text-[11.5px] text-muted">左侧选择一次运行查看轨迹。</div> : null}
        </div>
      </div>
    </div>
  );
}
// 轨迹详情里的一行「标签 + 值」，值用等宽字体、保留换行、可选中复制。
function Field({ label, v, danger }: { label: string; v: string; danger?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="w-[54px] shrink-0 text-right">{label}</span>
      <span className={`flex-1 min-w-0 font-mono whitespace-pre-wrap break-all select-text ${danger ? "text-danger" : "text-text"}`}>{v || "—"}</span>
    </div>
  );
}

// embedded=true：嵌在主窗口「工具 → 工作流编排」右侧，占满父容器而不是整屏，
// 右上角按钮从「完成」换成「独立窗口」（onPopout）——内嵌时没有窗口可关。
export function WorkflowEditor({ onClose, embedded, onPopout }: { onClose?: () => void; embedded?: boolean; onPopout?: () => void }) {
  const [wfs, setWfs] = useState<WF[]>([]);
  const [curId, setCurId] = useState<string>("");
  const [editNode, setEditNode] = useState<string | null>(null);
  const [showVars, setShowVars] = useState(false);
  const [showCfg, setShowCfg] = useState(false);   // W10 配置面板
  // dark：菜单开在深色画布上时用画布那套硬编码配色；title：面板顶部的分区小标题。
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; dark?: boolean; title?: string } | null>(null);
  const [selNode, setSelNode] = useState<string | null>(null);
  // E4 多选：selNode 仍是「主选中」（配置/停用等单节点操作看它），selSet 是整个选区。
  // 两者不互斥 —— 框选出一组时 selSet 有值，单击一个节点时两者都指向它。
  const [selSet, setSelSet] = useState<string[]>([]);
  // E4 框选中的矩形（世界坐标）。null = 当前没在框选。
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [selConn, setSelConn] = useState<number | null>(null);
  // E3 预制件：全局共用一份，进编辑器时拉一次。
  const [prefabs, setPrefabs] = useState<WFPrefab[]>([]);
  // 存预制件时的命名框（Electron 里没有 window.prompt，只能自己弹一个）。
  const [naming, setNaming] = useState<{ ids: string[]; name: string } | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);
  // E1 对象面板：非 null 表示打开，值是新节点要落在画布上的世界坐标。
  const [palette, setPalette] = useState<{ x: number; y: number } | null>(null);
  // 右侧对象库：默认收起（Alfred 的布局也是这样），画布先占满宽度，要挑对象时再拉出来。
  // 开合状态记在 localStorage 里，免得每次进来都要重开一次。
  const [lib, setLib] = useState<boolean>(() => localStorage.getItem(LS_LIB) === "1");
  useEffect(() => { localStorage.setItem(LS_LIB, lib ? "1" : "0"); }, [lib]);
  // W8 调试抽屉：runs 只保留当前工作流的记录（主进程侧留最近 N 次全量）。
  const [drawer, setDrawer] = useState(false);
  // 顶栏「运行」：现填的参数（相当于用户在快捷入口里输入的那段），以及一次运行的进行中标志。
  const [runArg, setRunArg] = useState("");
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<TraceRun[]>([]);
  // 顶栏一闪而过的提示（导入导出结果），比 alert 温和。
  const [note, setNote] = useState("");
  // 左侧工作流列的搜索词（名称 + 描述里搜）。只影响列表显示，不动选中项。
  const [wfQ, setWfQ] = useState("");
  // 「全部快捷键」弹窗（底部快捷键条右侧那个入口）。
  const [showKeys, setShowKeys] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const wfsRef = useRef(wfs); wfsRef.current = wfs;
  const undoRef = useRef<WF[][]>([]);
  // 重做栈：撤销时把「撤销前的样子」压进来，任何新改动都把它清空（分叉了就没有重做可言）。
  // 只活在渲染进程内存里 —— 撤销栈本身也不落盘，重开编辑器两者一起归零，语义一致。
  const redoRef = useRef<WF[][]>([]);
  // 两个栈的深度镜像成 state，只为了让顶栏按钮能真的 disabled（ref 变化不触发重渲染）。
  const [hist, setHist] = useState({ u: 0, r: 0 });
  const syncHist = useCallback(() => setHist({ u: undoRef.current.length, r: redoRef.current.length }), []);
  const panRef = useRef(pan); panRef.current = pan;
  const scaleRef = useRef(scale); scaleRef.current = scale;
  const curIdRef = useRef(curId); curIdRef.current = curId;
  const selSetRef = useRef(selSet); selSetRef.current = selSet;
  const prefabsRef = useRef(prefabs); prefabsRef.current = prefabs;

  useEffect(() => { void api.getWorkflows().then((w) => { setWfs(w); setCurId(w[0]?.id || ""); }); }, []);
  // 内嵌那份要防「同时开着独立窗口编辑」：所有改动都是即时落盘的，这里没有未保存状态，
  // 所以主窗口重新拿到焦点时直接重拉一遍，免得内嵌这份停在旧数据上、下一笔编辑把别处的改动盖回去。
  // 选中的工作流不动；撤销栈里的快照对应的是旧数据，一并丢掉。
  useEffect(() => {
    if (!embedded) return;
    const refresh = () => { void api.getWorkflows().then((w) => { setWfs(w); undoRef.current = []; redoRef.current = []; syncHist(); }); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [embedded]);
  // 预制件（E3）：全局的，和当前选哪条工作流无关，进来拉一次就够。
  useEffect(() => { void api.getPrefabs().then((p) => setPrefabs(Array.isArray(p) ? p : [])).catch(() => setPrefabs([])); }, []);
  const cur = wfs.find((w) => w.id === curId);
  // 搜索后的工作流列表。搜索词为空就是全量，不做任何排序改动（顺序是用户自己排的）。
  const wfKw = wfQ.trim().toLowerCase();
  const wfList = wfKw ? wfs.filter((w) => `${w.name} ${w.desc || ""}`.toLowerCase().includes(wfKw)) : wfs;

  // 提示文案 2.5 秒后自动消失。
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(""), 2500); return () => clearTimeout(t); }, [note]);

  // 调试轨迹：进来先拉一次历史，之后订阅主进程推送（只看当前工作流的记录）。
  useEffect(() => {
    if (!curId) { setRuns([]); return; }
    let alive = true;
    void api.getTrace(curId).then((r) => { if (alive) setRuns(r); });
    const off = api.onTrace((r) => { if (r.wfId === curIdRef.current) setRuns((prev) => [r, ...prev].slice(0, 20)); });
    return () => { alive = false; off(); };
  }, [curId]);

  // 提交（带撤销快照）。
  const commit = useCallback((next: WF[], pushUndo = true) => {
    if (pushUndo) {
      undoRef.current.push(clone(wfsRef.current)); if (undoRef.current.length > 60) undoRef.current.shift();
      redoRef.current = [];   // 新改动即分叉，原来的重做路径作废
      syncHist();
    }
    setWfs(next); void api.setWorkflows(next);
  }, [syncHist]);
  const updateCur = useCallback((fn: (w: WF) => WF, pushUndo = true) => {
    if (!curIdRef.current) return;
    commit(wfsRef.current.map((w) => (w.id === curIdRef.current ? fn(w) : w)), pushUndo);
  }, [commit]);
  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(clone(wfsRef.current)); syncHist();
    setWfs(prev); void api.setWorkflows(prev);
  }, [syncHist]);
  // 重做：与 undo 完全对称，把状态从重做栈搬回来、当前状态压回撤销栈。
  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(clone(wfsRef.current)); syncHist();
    setWfs(next); void api.setWorkflows(next);
  }, [syncHist]);

  // 工作流增删
  const newWf = () => {
    const id = uid();
    const wf: WF = { id, name: "新工作流", icon: "🧩", desc: "", enabled: true, variables: {},
      nodes: [{ id: "n1", type: "trigger.keyword", x: 80, y: 140, config: defaultConfig("trigger.keyword") }], connections: [] };
    commit([...wfsRef.current, wf]); setCurId(id); setSelNode(null); setSelConn(null); setSelSet([]);
  };
  const delWf = (id: string) => { commit(wfsRef.current.filter((w) => w.id !== id)); if (curId === id) setCurId(""); };

  // 导出（W9）：统一信封 {umbraWorkflows:1, exportedAt, workflows:[…]}，单个/全部共用一种格式。
  const exportWfs = (list: WF[], filename: string) => {
    if (!list.length) { setNote("没有可导出的工作流"); return; }
    const body = JSON.stringify({ umbraWorkflows: 1, exportedAt: new Date().toISOString(), workflows: list }, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNote(`已导出 ${list.length} 个工作流`);
  };
  // 导入（W9）：兼容「信封 / 裸数组 / 单个工作流对象」三种写法；id 撞车的自动换新 id，不覆盖已有的。
  const importFile = async (f: File) => {
    let list: WF[] = [];
    try {
      const data = JSON.parse(await f.text()) as unknown;
      const box = data as { workflows?: unknown; nodes?: unknown };
      list = (Array.isArray(data) ? data : Array.isArray(box.workflows) ? box.workflows : box.nodes ? [data] : []) as WF[];
    } catch { setNote("导入失败：不是合法的 JSON"); return; }
    const valid = (list || []).filter((w) => w && typeof w === "object" && Array.isArray(w.nodes)).map((w) => ({
      ...w, icon: w.icon || "🧩", enabled: w.enabled !== false, variables: w.variables || {},
      nodes: w.nodes.map((n) => ({ ...n, config: (n.config || {}) as Record<string, unknown> })),
      connections: Array.isArray(w.connections) ? w.connections : [],
    }));
    if (!valid.length) { setNote("导入失败：文件里没有工作流"); return; }
    const exist = new Set(wfsRef.current.map((w) => w.id));
    const fresh = valid.map((w) => (exist.has(w.id) || !w.id ? { ...w, id: uid(), name: `${w.name || "工作流"}（导入）` } : w));
    commit([...wfsRef.current, ...fresh]);
    setCurId(fresh[0].id);
    setNote(`已导入 ${fresh.length} 个工作流`);
  };

  // 节点增删改
  // connectFrom：⌥ 添加（E2）时的上游节点 id —— 新节点自动接到它的默认出口后面，并顺势排在它右边。
  // 返回新节点的 id：拖拽落地后要立刻打开它的配置弹窗，得知道开哪个。
  const addNode = (type: string, x?: number, y?: number, connectFrom?: string): string | null => {
    if (!cur) return null;
    const src = connectFrom ? cur.nodes.find((n) => n.id === connectFrom) : undefined;
    const n: WFNode = {
      id: uid(), type,
      x: x ?? (src ? src.x + NODE_W + 60 : 300), y: y ?? (src ? src.y : 160),
      config: defaultConfig(type),
    };
    updateCur((w) => ({
      ...w, nodes: [...w.nodes, n],
      connections: src ? [...w.connections, { from: src.id, to: n.id, mod: "", fromPort: "" }] : w.connections,
    }));
    setSelNode(n.id);
    return n.id;
  };
  const insertAfter = (n: WFNode, type: string) => {
    const nn: WFNode = { id: uid(), type, x: n.x + NODE_W + 60, y: n.y, config: defaultConfig(type) };
    updateCur((w) => ({ ...w, nodes: [...w.nodes, nn], connections: [...w.connections, { from: n.id, to: nn.id, mod: "" }] }));
  };
  const delNode = (id: string) => { updateCur((w) => ({ ...w, nodes: w.nodes.filter((n) => n.id !== id), connections: w.connections.filter((c) => c.from !== id && c.to !== id) })); setSelNode(null); setSelSet([]); };
  // 批量删除选区（E4）：组内组外只要沾边的连线一并清掉，不留半截线。
  const delNodes = (ids: string[]) => {
    const s = new Set(ids);
    updateCur((w) => ({ ...w, nodes: w.nodes.filter((n) => !s.has(n.id)), connections: w.connections.filter((c) => !s.has(c.from) && !s.has(c.to)) }));
    setSelNode(null); setSelSet([]);
  };
  // 对齐 / 等距（E4）：只改选区里节点的坐标，连线自己跟着端口走。
  // 节点等宽等高，所以「右对齐」「底对齐」直接取最大 x/y 即可，不必再算包围盒。
  const alignSel = (how: "left" | "right" | "top" | "bottom" | "hspace" | "vspace") => {
    const ids = selSetRef.current;
    if (ids.length < 2) return;
    updateCur((w) => {
      const set = new Set(ids);
      const picked = w.nodes.filter((n) => set.has(n.id));
      if (picked.length < 2) return w;
      const pos = new Map(picked.map((n) => [n.id, { x: n.x, y: n.y }]));
      if (how === "left" || how === "right") {
        const v = how === "left" ? Math.min(...picked.map((n) => n.x)) : Math.max(...picked.map((n) => n.x));
        for (const p of pos.values()) p.x = v;
      } else if (how === "top" || how === "bottom") {
        const v = how === "top" ? Math.min(...picked.map((n) => n.y)) : Math.max(...picked.map((n) => n.y));
        for (const p of pos.values()) p.y = v;
      } else {
        // 等距：首尾两个节点位置不动，中间的按序号均分间距。
        const hor = how === "hspace";
        const sorted = picked.slice().sort((a, b) => (hor ? a.x - b.x : a.y - b.y));
        const a0 = hor ? sorted[0].x : sorted[0].y;
        const a1 = hor ? sorted[sorted.length - 1].x : sorted[sorted.length - 1].y;
        const step = (a1 - a0) / (sorted.length - 1);
        sorted.forEach((n, i) => { const p = pos.get(n.id)!; if (hor) p.x = a0 + step * i; else p.y = a0 + step * i; });
      }
      return { ...w, nodes: w.nodes.map((n) => (pos.has(n.id) ? { ...n, ...pos.get(n.id)! } : n)) };
    });
  };

  // ── 预制件（E3）──
  const savePrefabs = (next: WFPrefab[]) => { setPrefabs(next); void api.setPrefabs(next); };
  // 真正落盘：命名框确认后调用。坐标归一到组内左上角，只带上组内部的连线（跨出选区的线不带走）。
  const savePrefab = (ids: string[], name: string) => {
    const w = wfsRef.current.find((x) => x.id === curIdRef.current);
    if (!w) return;
    const set = new Set(ids);
    const picked = w.nodes.filter((n) => set.has(n.id));
    if (!picked.length) return;
    const ox = Math.min(...picked.map((n) => n.x)), oy = Math.min(...picked.map((n) => n.y));
    savePrefabs([...prefabsRef.current, {
      id: uid(), name,
      nodes: clone(picked).map((n) => ({ ...n, x: n.x - ox, y: n.y - oy })),
      connections: clone(w.connections.filter((c) => set.has(c.from) && set.has(c.to))),
      createdAt: Date.now(),
    }]);
    setNote(`已存为预制件「${name}」`);
  };
  // 落地：节点 id 全部重发一遍（同一预制件可以在一条工作流里放很多次），连线按新旧 id 映射重连。
  const placePrefab = (p: WFPrefab, px: number, py: number) => {
    if (!curIdRef.current || !p.nodes.length) return;
    const map = new Map<string, string>();
    const nodes = clone(p.nodes).map((n) => { const id = uid(); map.set(n.id, id); return { ...n, id, x: Math.max(0, px + n.x), y: Math.max(0, py + n.y) }; });
    const conns = p.connections.filter((c) => map.has(c.from) && map.has(c.to)).map((c) => ({ ...c, from: map.get(c.from)!, to: map.get(c.to)! }));
    updateCur((w) => ({ ...w, nodes: [...w.nodes, ...nodes], connections: [...w.connections, ...conns] }));
    setSelSet(nodes.map((n) => n.id)); setSelNode(nodes[0]?.id || null); setSelConn(null);
    setNote(`已落地「${p.name}」`);
  };
  // 停用/启用节点（E6）：连线一概保留，执行时被旁路，随时可以再打开。
  const toggleDisabled = (id: string) => updateCur((w) => ({ ...w, nodes: w.nodes.map((n) => (n.id === id ? { ...n, disabled: !n.disabled } : n)) }));
  // 保存节点配置：顺手清掉「出口已经不存在了」的连线（比如 Conditional 删了一条规则、
  // 或 Run Script 把「失败走分支」关掉），免得画布上留着连到空气的线。
  const setNodeConfig = (id: string, config: Record<string, unknown>) => updateCur((w) => {
    const nodes = w.nodes.map((n) => (n.id === id ? { ...n, config } : n));
    const changed = nodes.find((n) => n.id === id);
    const alive = new Set((changed ? outPorts(changed) : []).map((p) => p.port));
    return { ...w, nodes, connections: w.connections.filter((c) => c.from !== id || alive.has(c.fromPort || "")) };
  });

  // ── 从对象库拖到画布 ────────────────────────────────────────────────────────
  //
  // 用指针事件自己实现，不用 HTML5 的 drag & drop，两个原因：
  //   · 要让跟着鼠标走的是一张**长得像画布节点的卡片**。HTML5 的拖影是元素快照，
  //     样式改不动、各平台渲染还不一样，做不出「拖的就是那张卡片」的感觉。
  //   · 画布上拖节点、拉线、框选本来就都是指针事件，多一套 DnD 只会多一套坑。
  //
  // 点击加节点的老行为要保住，所以按住不动不算拖 —— 移动超过阈值才进入拖拽态，
  // 在阈值内松手仍然当成一次点击（含 ⌥ 点击接到选中节点后面）。
  const [libDrag, setLibDrag] = useState<{ type: string; x: number; y: number; over: boolean } | null>(null);
  // 按下时先记住起点和类型，够不上阈值就不动声色。
  const libArm = useRef<{ type: string; sx: number; sy: number } | null>(null);
  const DRAG_START = 4;   // 像素。再小会把手抖判成拖拽，再大会让轻拖没反应
  // 卡片相对光标的偏移：让光标「捏着」卡片左上角附近，而不是压在卡片正中间遮住图标。
  const DRAG_GRAB = 14;

  const armDrag = (type: string, e: React.MouseEvent) => {
    if (!cur || e.button !== 0) return;
    libArm.current = { type, sx: e.clientX, sy: e.clientY };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const a = libArm.current;
      if (a && !libDrag) {
        if (Math.abs(e.clientX - a.sx) + Math.abs(e.clientY - a.sy) < DRAG_START) return;
        setLibDrag({ type: a.type, x: e.clientX, y: e.clientY, over: overCanvas(e.clientX, e.clientY) });
        return;
      }
      if (libDrag) setLibDrag({ ...libDrag, x: e.clientX, y: e.clientY, over: overCanvas(e.clientX, e.clientY) });
    };
    const up = (e: MouseEvent) => {
      const a = libArm.current;
      libArm.current = null;
      if (!libDrag) return;                       // 没进入拖拽态：交给按钮自己的 onClick
      setLibDrag(null);
      if (!overCanvas(e.clientX, e.clientY)) return;   // 松在画布外 = 放弃，不加节点
      // 落点取卡片左上角，和拖拽时看到的位置一致 —— 所见即所得，别让节点跳到别处
      const w = toWorld(e.clientX - DRAG_GRAB, e.clientY - DRAG_GRAB);
      const id = addNode(a?.type || libDrag.type, Math.round(w.x), Math.round(w.y));
      // 落地即打开配置弹窗：拖一个节点过来，下一步几乎总是要配它
      if (id) setEditNode(id);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !libDrag) return;
      e.preventDefault(); e.stopPropagation();
      libArm.current = null;
      setLibDrag(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", key, true);
    };
  });

  // 光标在画布范围内吗（拖拽落点判定用）。
  const overCanvas = (cx: number, cy: number): boolean => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return false;
    return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
  };

  // 坐标：屏幕 → 世界
  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const px = clientX - (rect?.left ?? 0), py = clientY - (rect?.top ?? 0);
    return { x: (px - panRef.current.x) / scaleRef.current, y: (py - panRef.current.y) / scaleRef.current };
  };

  // 画布中心的世界坐标：键盘唤起对象面板（E1）时，新节点就落在视野中间。
  const canvasCenter = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return toWorld((rect?.left ?? 0) + (rect?.width ?? 800) / 2, (rect?.top ?? 0) + (rect?.height ?? 500) / 2);
  };

  // 交互指针：拖节点 / 拉线 / 平移
  // group：跟着主拖动节点一起走的其它选区节点（E4），不含主节点本身。
  const drag = useRef<{ id: string; ox: number; oy: number; moved: boolean; group: string[]; snap: WF[] } | null>(null);
  const link = useRef<{ from: string; port: string } | null>(null);
  const panning = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  // E4 框选：起点 + 当前点，都是世界坐标。
  const marq = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [linkPos, setLinkPos] = useState<{ x: number; y: number } | null>(null);

  const onNodeDown = (e: React.MouseEvent, n: WFNode) => {
    if ((e.target as HTMLElement).closest("[data-port]")) return;
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey) {
      // ⌘/⌃ 点击 = 把节点加入/移出选区（E4），不进入拖动。
      setSelSet((s) => (s.includes(n.id) ? s.filter((x) => x !== n.id) : [...s, n.id]));
      setSelNode(n.id); setSelConn(null);
      return;
    }
    const w = toWorld(e.clientX, e.clientY);
    const set = selSetRef.current;
    // 拖的是选区里的节点 → 整组一起搬；拖的是选区外的节点 → 当作重新选它，旧选区作废。
    const inSel = set.includes(n.id);
    if (!inSel && set.length) setSelSet([]);
    drag.current = { id: n.id, ox: w.x - n.x, oy: w.y - n.y, moved: false, group: inSel ? set.filter((x) => x !== n.id) : [], snap: clone(wfsRef.current) };
  };
  const onPortDown = (e: React.MouseEvent, n: WFNode, port: string) => { link.current = { from: n.id, port }; setLinkPos(toWorld(e.clientX, e.clientY)); e.stopPropagation(); e.preventDefault(); };
  const onNodeUp = (n: WFNode) => {
    if (link.current && link.current.from !== n.id) {
      // 同一「出口 + 修饰键 + 目标」只允许一条连线，重复拉线视为无操作。
      const { from, port } = link.current;
      updateCur((w) => (w.connections.some((c) => c.from === from && c.to === n.id && (c.mod || "") === "" && (c.fromPort || "") === port)
        ? w
        : { ...w, connections: [...w.connections, { from, to: n.id, mod: "", fromPort: port }] }));
    }
    link.current = null; setLinkPos(null);
  };
  const onCanvasDown = (e: React.MouseEvent) => {
    // 右键只为唤菜单，不该顺手清掉选区 —— 否则「框选一组再右键对齐」永远选不中。
    if (e.button !== 0) { setMenu(null); return; }
    setSelNode(null); setSelConn(null); setEditNode(null); setMenu(null);
    if (e.shiftKey && cur) {
      // ⇧+拖空白 = 框选（E4）；不按 ⇧ 仍然是平移，保住原来的手感。
      const w = toWorld(e.clientX, e.clientY);
      marq.current = { x0: w.x, y0: w.y, x1: w.x, y1: w.y };
      setMarquee({ ...marq.current });
      return;
    }
    setSelSet([]);
    panning.current = { sx: e.clientX, sy: e.clientY, ox: panRef.current.x, oy: panRef.current.y };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (drag.current) {
        const d = drag.current; d.moved = true;
        const w = toWorld(e.clientX, e.clientY);
        const x = Math.max(0, w.x - d.ox), y = Math.max(0, w.y - d.oy);
        setWfs((prev) => prev.map((wf) => {
          if (wf.id !== curIdRef.current) return wf;
          // 整组位移（E4）：位移量取主节点这一帧真正移动的距离，其余选区节点照搬同一个 dx/dy。
          const base = wf.nodes.find((n) => n.id === d.id);
          const dx = x - (base?.x ?? x), dy = y - (base?.y ?? y);
          const grp = new Set(d.group);
          return { ...wf, nodes: wf.nodes.map((n) => (n.id === d.id ? { ...n, x, y }
            : grp.has(n.id) ? { ...n, x: Math.max(0, n.x + dx), y: Math.max(0, n.y + dy) } : n)) };
        }));
      } else if (link.current) {
        setLinkPos(toWorld(e.clientX, e.clientY));
      } else if (marq.current) {
        const w = toWorld(e.clientX, e.clientY);
        marq.current.x1 = w.x; marq.current.y1 = w.y;
        setMarquee({ ...marq.current });
      } else if (panning.current) {
        const p = panning.current;
        setPan({ x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) });
      }
    };
    const up = () => {
      if (drag.current) {
        const d = drag.current;
        if (d.moved) { undoRef.current.push(d.snap); redoRef.current = []; syncHist(); void api.setWorkflows(wfsRef.current); }
        else { setSelNode(d.id); setSelConn(null); if (!d.group.length) setSelSet([]); }  // 未移动=单击选中
        drag.current = null;
      }
      if (link.current) { link.current = null; setLinkPos(null); }
      if (marq.current) {
        // 框选结束（E4）：矩形和节点矩形有交叠就算选中（不要求整块框进去，手感更松快）。
        const m = marq.current; marq.current = null; setMarquee(null);
        const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
        const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
        const wf = wfsRef.current.find((w) => w.id === curIdRef.current);
        const hit = (wf?.nodes || []).filter((n) => n.x < x1 && n.x + NODE_W > x0 && n.y < y1 && n.y + NODE_H > y0).map((n) => n.id);
        setSelSet(hit); setSelNode(hit.length === 1 ? hit[0] : null);
      }
      panning.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  // 缩放：ctrl/⌘+滚轮(触控板捏合)缩放；普通滚轮平移。
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      const wx = (cx - panRef.current.x) / scaleRef.current, wy = (cy - panRef.current.y) / scaleRef.current;
      const ns = Math.min(2.5, Math.max(0.3, scaleRef.current * (e.deltaY < 0 ? 1.1 : 0.9)));
      setPan({ x: cx - wx * ns, y: cy - wy * ns }); setScale(ns);
    } else {
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }
  };
  const zoomBy = (f: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const cx = (rect?.width ?? 800) / 2, cy = (rect?.height ?? 500) / 2;
    const wx = (cx - panRef.current.x) / scaleRef.current, wy = (cy - panRef.current.y) / scaleRef.current;
    const ns = Math.min(2.5, Math.max(0.3, scaleRef.current * f));
    setPan({ x: cx - wx * ns, y: cy - wy * ns }); setScale(ns);
  };
  // 适应画布（⇧1）：把所有节点的外接矩形连同一圈留白缩到刚好看得见，节点少时不放大过头（上限 1×）。
  // 一个节点都没有就直接复位，免得对着空画布算出一个奇怪的缩放。
  const fitView = useCallback(() => {
    const wf = wfsRef.current.find((w) => w.id === curIdRef.current);
    const ns = wf?.nodes || [];
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!ns.length || !rect) { setScale(1); setPan({ x: 0, y: 0 }); return; }
    const PAD = 48;
    const x0 = Math.min(...ns.map((n) => n.x)), x1 = Math.max(...ns.map((n) => n.x + NODE_W));
    const y0 = Math.min(...ns.map((n) => n.y)), y1 = Math.max(...ns.map((n) => n.y + NODE_H));
    const s = Math.min(1, Math.max(0.3, Math.min((rect.width - PAD * 2) / (x1 - x0), (rect.height - PAD * 2) / (y1 - y0))));
    setScale(s);
    setPan({ x: (rect.width - (x1 - x0) * s) / 2 - x0 * s, y: (rect.height - (y1 - y0) * s) / 2 - y0 * s });
  }, []);

  // 连线徽章操作
  const cycleMod = (i: number) => updateCur((w) => { const conns = w.connections.slice(); const c = conns[i].mod || ""; conns[i] = { ...conns[i], mod: MODS[(MODS.indexOf(c) + 1) % MODS.length] as WFConn["mod"] }; return { ...w, connections: conns }; });
  const delConn = (i: number) => { updateCur((w) => ({ ...w, connections: w.connections.filter((_, j) => j !== i) })); setSelConn(null); };

  // 键盘：Delete 删选中；⌘Z 撤销 / ⇧⌘Z（或 ⌘Y）重做；/ 或 \ 唤起对象面板（E1）；⌘D 停用/启用选中节点（E6）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        if (selNode) { e.preventDefault(); toggleDisabled(selNode); }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        // ⌘A 全选当前工作流的节点（E4）。
        const wf = wfsRef.current.find((w) => w.id === curIdRef.current);
        if (!wf) return;
        e.preventDefault(); setSelSet(wf.nodes.map((n) => n.id)); setSelConn(null);
        return;
      }
      if (e.key === "Escape") {
        // Esc 逐层退出：先关快捷键弹窗，再清选区。
        if (showKeys) { e.preventDefault(); setShowKeys(false); return; }
        if (selSet.length) { e.preventDefault(); setSelSet([]); return; }
      }
      // ⇧1 适应画布 / ⇧0 复位视图（和缩放胶囊、右键菜单里的是同两个动作）。
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && (e.key === "!" || e.key === "1")) { e.preventDefault(); fitView(); return; }
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && (e.key === ")" || e.key === "0")) { e.preventDefault(); setScale(1); setPan({ x: 0, y: 0 }); return; }
      if ((e.key === "/" || e.key === "\\") && !e.metaKey && !e.ctrlKey) {
        if (!curIdRef.current) return;
        e.preventDefault(); setPalette(canvasCenter());
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        // 选区里有多个节点时删整组（E4），否则还是删单个。
        if (selSet.length > 1) { e.preventDefault(); delNodes(selSet); }
        else if (selNode) { e.preventDefault(); delNode(selNode); }
        else if (selConn !== null) { e.preventDefault(); delConn(selConn); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selNode, selConn, selSet, undo, redo, fitView, showKeys]);

  const node = (id: string) => cur?.nodes.find((n) => n.id === id);
  // 端口坐标：入口固定在头部；出口按端口序号逐个下移，多出口节点因此有一列端口。
  const anchor = (n: WFNode, side: "in" | "out", port?: string) =>
    ({ x: n.x + (side === "out" ? NODE_W : 0), y: n.y + PORT_Y + (side === "out" ? portIndex(n, port) * PORT_GAP : 0) });

  // 分类行右侧的「已实现/总数」，和对象库里的计数一个含义。
  const addSubmenu = (px: number, py: number): MenuItem[] => ADD_GROUPS.map((g) => ({
    label: g.cat, icon: <g.icon size={14} />, count: `${g.items.length}/${g.total}`,
    sub: g.items.map((it) => ({ label: it.label, icon: <it.icon size={14} />, onClick: () => addNode(it.type, px, py) })),
  }));
  // 画布通用动作：不依赖点在哪儿、也不依赖选了什么，所以单独一段。
  const canvasActions = (): MenuItem[] => [
    { sep: true },
    { label: "全选节点", icon: <IconList size={14} />, keyHint: "⌘A", onClick: () => { const wf = wfsRef.current.find((w) => w.id === curIdRef.current); if (wf) { setSelSet(wf.nodes.map((n) => n.id)); setSelConn(null); } } },
    { label: "适应画布", icon: <IconGrid size={14} />, keyHint: "⇧1", onClick: fitView },
    { label: "复位视图", icon: <IconRefresh size={14} />, keyHint: "⇧0", onClick: () => { setScale(1); setPan({ x: 0, y: 0 }); } },
  ];
  // 预制件相关的菜单项（E3）：落地到指定世界坐标 + 删除。没有预制件时整段不出现。
  const prefabMenu = (px: number, py: number): MenuItem[] => (prefabs.length ? [
    { sep: true },
    { label: "落地预制件", icon: <IconGrid size={14} />, sub: prefabs.map((p) => ({ label: `${p.name}（${p.nodes.length} 节点）`, icon: <IconGrid size={14} />, onClick: () => placePrefab(p, px, py) })) },
    { label: "删除预制件", icon: <IconTrash size={14} />, sub: prefabs.map((p) => ({ label: p.name, icon: <IconGrid size={14} />, danger: true, onClick: () => { savePrefabs(prefabsRef.current.filter((x) => x.id !== p.id)); setNote(`已删除预制件「${p.name}」`); } })) },
  ] : []);
  // 选区相关的菜单项（E4/E3）：两个以上节点才有意义。
  const selMenu = (): MenuItem[] => (selSetRef.current.length >= 2 ? [
    { sep: true },
    { label: `对齐这 ${selSetRef.current.length} 个节点`, icon: <IconGrid size={14} />, sub: [
      { label: "左对齐", onClick: () => alignSel("left") },
      { label: "右对齐", onClick: () => alignSel("right") },
      { label: "顶对齐", onClick: () => alignSel("top") },
      { label: "底对齐", onClick: () => alignSel("bottom") },
      { sep: true },
      { label: "水平等距", onClick: () => alignSel("hspace") },
      { label: "垂直等距", onClick: () => alignSel("vspace") },
    ] },
    { label: `把选中的 ${selSetRef.current.length} 个存为预制件…`, icon: <IconGrid size={14} />, onClick: () => setNaming({ ids: selSetRef.current.slice(), name: `节点组 ${selSetRef.current.length} 个` }) },
    { label: `删除选中的 ${selSetRef.current.length} 个节点`, icon: <IconTrash size={14} />, danger: true, onClick: () => delNodes(selSetRef.current.slice()) },
  ] : []);
  const openCanvasMenu = (e: React.MouseEvent) => {
    if (!cur) return;
    e.preventDefault(); const w = toWorld(e.clientX, e.clientY);
    setMenu({ x: e.clientX, y: e.clientY, dark: true, title: "添加对象",
      items: [...addSubmenu(w.x, w.y), ...prefabMenu(w.x, w.y), ...selMenu(), ...canvasActions()] });
  };
  const openNodeMenu = (e: React.MouseEvent, n: WFNode) => {
    e.preventDefault(); e.stopPropagation(); setSelNode(n.id); setSelConn(null);
    // 右键的是选区外的节点 → 视为重新选它，菜单也只对它生效。
    if (!selSetRef.current.includes(n.id)) { setSelSet([]); selSetRef.current = []; }
    setMenu({ x: e.clientX, y: e.clientY, dark: true, items: [
      { label: "配置节点…", icon: <IconGear size={14} />, onClick: () => setEditNode(n.id) },
      { label: "在其后插入", icon: <IconPlus size={14} />, sub: ADD_GROUPS.map((g) => ({ label: g.cat, icon: <g.icon size={14} />, sub: g.items.map((it) => ({ label: it.label, icon: <it.icon size={14} />, onClick: () => insertAfter(n, it.type) })) })) },
      { label: n.disabled ? "启用节点 ⌘D" : "停用节点 ⌘D", icon: n.disabled ? <IconEye size={14} /> : <IconEyeOff size={14} />, onClick: () => toggleDisabled(n.id) },
      { label: "存为预制件…", icon: <IconGrid size={14} />, onClick: () => setNaming({ ids: [n.id], name: TYPE_META[n.type]?.label || "节点" }) },
      { sep: true },
      { label: "删除节点", icon: <IconTrash size={14} />, danger: true, onClick: () => delNode(n.id) },
      ...selMenu(),
    ] });
  };

  // 打开当前工作流自己的目录：脚本节点默认就在这里跑，随行的 runtime/、index.js 之类放进去即可写相对路径。
  // 顶栏直接给了按钮（高频），所以「⋯」菜单里不再重复放一份。
  const openWfDir = () => {
    if (!curIdRef.current) return;
    void (async () => {
      const rr = await api.openWorkflowDir(curIdRef.current);
      if (!rr?.ok) setNote(`打开目录失败：${rr?.error || "未知错误"}`);
    })();
  };

  // 顶栏「运行」：把现填的参数喂给工作流跑一遍。
  // 选中了某个节点就从那个节点跑（方便只调一段链路），没选就让主进程挑第一个可用触发器。
  // 跑完自动把调试抽屉拉出来 —— 手动运行的唯一目的就是看轨迹，还要再点一下才看得到很蠢。
  const runNow = async () => {
    if (!cur || running) return;
    setRunning(true);
    try {
      const r = await api.runWorkflow(cur.id, selNode || "", runArg);
      setDrawer(true);
      setNote(r.ok ? (r.feedback || "已运行 ✓") : `运行失败：${r.error}`);
    } catch (e) {
      setNote(`运行失败：${String(e).replace("Error: ", "")}`);
    } finally {
      setRunning(false);
    }
  };

  // 顶栏「⋯」菜单：低频操作都收在这里（变量表、导入导出、启用停用、复位视图）。
  // 菜单往按钮左下角贴（按钮本身在最右边，直接按 x=rect.left 会把菜单甩出窗口）。
  const openMoreMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = [];
    if (cur) {
      items.push({ label: "变量表…", icon: <IconTag size={14} />, onClick: () => setShowVars(true) });
      items.push({ sep: true });
    }
    // 导入导出（W9）：走浏览器的文件选择/下载，不额外开主进程通道。
    items.push({ label: "导入 JSON…", icon: <IconDownload size={14} />, onClick: () => fileRef.current?.click() });
    if (cur) items.push({ label: "导出当前工作流", icon: <IconExternal size={14} />, onClick: () => exportWfs([cur], `${cur.name || "workflow"}.json`) });
    items.push({ label: "导出全部工作流", icon: <IconGrid size={14} />, onClick: () => exportWfs(wfs, "umbra-workflows.json") });
    items.push({ sep: true });
    if (cur) items.push({ label: cur.enabled === false ? "启用这条工作流" : "停用这条工作流", icon: cur.enabled === false ? <IconCheck size={14} /> : <IconEyeOff size={14} />, onClick: () => updateCur((w) => ({ ...w, enabled: w.enabled === false })) });
    items.push({ label: "复位视图", icon: <IconRefresh size={14} />, onClick: () => { setScale(1); setPan({ x: 0, y: 0 }); } });
    setMenu({ x: Math.max(8, r.right - 200), y: r.bottom + 6, items });
  };

  return (
    <div className={`flex flex-col ${embedded ? "h-full" : "h-screen"} bg-bg text-text`}>
      {/* 顶栏 52px（对齐设计稿）：左边一块身份信息 —— 橙底图标方块 + 名称 + 启停徽章 + 描述，
          右边一组连体图标按钮（撤销/重做 · 调试/对象库/更多），低频操作仍收在「⋯」菜单里。
          画布缩放在画布自己的右上角浮层，顶栏因此一行放得下，内嵌到主窗口右侧也不挤。 */}
      <div className="h-[52px] flex-none flex items-center gap-[10px] px-[14px] border-b border-border bg-card">
        {cur ? (<>
          {/* 图标方块：留空时显示线性占位图标，输入框透明地盖在上面，点一下就能改。 */}
          <span className="relative w-7 h-7 flex-none rounded-lg bg-orange-soft text-orange-text flex items-center justify-center">
            {cur.icon ? null : <IconFlow size={15} />}
            <input value={cur.icon || ""} onChange={(e) => updateCur((w) => ({ ...w, icon: e.target.value }))} maxLength={2} title="图标（留空显示默认图标）"
              className="absolute inset-0 w-full h-full bg-transparent border-none outline-none text-center text-[15px] leading-none" />
          </span>
          <span className="flex flex-col gap-px min-w-0">
            <span className="flex items-center gap-[7px]">
              {/* 名称做成无边框输入：平时就是一行标题，点上去才是可编辑的。 */}
              <input value={cur.name} onChange={(e) => updateCur((w) => ({ ...w, name: e.target.value }))} placeholder="名称"
                className="w-[150px] flex-none bg-transparent border-none outline-none text-[14px] font-semibold" />
              {cur.enabled === false
                ? <span className="flex-none whitespace-nowrap px-[7px] py-px rounded-full bg-chip text-muted text-[10.5px] font-semibold">已停用</span>
                : <span className="flex-none whitespace-nowrap px-[7px] py-px rounded-full bg-success-soft text-success text-[10.5px] font-semibold">已启用</span>}
              <button className="flex-none whitespace-nowrap text-[11px] text-muted bg-transparent hover:text-orange-text" title="配置项：给使用者填的表单（密钥进保险箱）" onClick={() => setShowCfg(true)}>配置工作流…</button>
            </span>
            <input value={cur.desc || ""} onChange={(e) => updateCur((w) => ({ ...w, desc: e.target.value }))}
              className="bg-transparent border-none outline-none text-[11px] text-faint" placeholder="加一句描述…" />
          </span>
        </>) : <span className="text-[12.5px] text-muted whitespace-nowrap">← 左侧新建或选择一个工作流</span>}
        <span className="flex-1" />
        {note ? <span className="text-[11.5px] text-orange flex-none whitespace-nowrap">{note}</span> : null}
        <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importFile(f); }} />
        {/* 运行：一个参数输入框 + 一个运行按钮。参数等价于用户在快捷入口里输入的那段，
            跑的是「回车」分支，走的和真实触发同一条执行路径，所以轨迹可以直接当真。 */}
        {cur ? (
          <div className="flex-none flex items-center bg-bg border border-border rounded-lg overflow-hidden">
            <input value={runArg} onChange={(e) => setRunArg(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void runNow(); }}
              placeholder="运行参数（可留空）"
              title="相当于在快捷入口里输入的那段文字，下游用 {query} 取它"
              className="w-[150px] h-[30px] flex-none bg-transparent border-none outline-none px-[10px] text-[12px] font-mono" />
            <button
              className={`${TB} border-l border-border ${running ? "text-faint" : "text-orange-text hover:bg-orange-soft"}`}
              disabled={running}
              title={selNode ? "从选中的节点开始跑（回车分支）" : "从第一个触发器开始跑（回车分支）"}
              onClick={() => void runNow()}
            ><IconPlay size={14} /></button>
          </div>
        ) : null}
        {/* 连体图标条：整条一个外框，按钮之间用发丝线分隔，最后一个不带右边线。 */}
        <div className="flex-none flex items-center bg-bg border border-border rounded-lg overflow-hidden">
          <button className={`${TB} border-r border-border ${hist.u ? "text-muted hover:bg-hover" : "text-faint"}`} disabled={!hist.u} title="撤销 ⌘Z" onClick={() => { if (hist.u) undo(); }}><IconUndo size={15} /></button>
          <button className={`${TB} border-r border-border ${hist.r ? "text-muted hover:bg-hover" : "text-faint"}`} disabled={!hist.r} title="重做 ⇧⌘Z" onClick={() => { if (hist.r) redo(); }}><IconRedo size={15} /></button>
          <button className={`${TB} border-r border-border ${cur ? "text-muted hover:bg-hover" : "text-faint"}`} disabled={!cur} title="打开这条工作流的目录（脚本节点默认就在这里跑）" onClick={openWfDir}><IconFolder size={15} /></button>
          <button className={`${TB} border-r border-border ${drawer ? "bg-orange-soft text-orange-text" : "text-muted hover:bg-hover"}`} title="调试：最近若干次执行的逐节点轨迹" onClick={() => setDrawer((v) => !v)}><IconBug size={15} /></button>
          <button className={`${TB} border-r border-border ${lib ? "bg-orange-soft text-orange-text" : "text-muted hover:bg-hover"}`} title="对象库（右侧面板）" onClick={() => setLib((v) => !v)}><IconPanel size={15} /></button>
          <button className={`${TB} text-muted hover:bg-hover`} title="更多" onClick={openMoreMenu}><IconDots size={15} /></button>
        </div>
        {embedded ? (
          <button className="flex-none w-[30px] h-[30px] flex items-center justify-center bg-card border border-border rounded-lg text-muted hover:bg-hover" title="在独立窗口里打开编辑器（画布更大）" onClick={() => onPopout?.()}><IconExternal size={15} /></button>
        ) : (
          <button className="flex-none whitespace-nowrap text-[12.5px] px-[13px] py-[6px] bg-orange hover:bg-orange-deep text-white rounded-lg font-semibold" onClick={() => onClose?.()}>完成</button>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 左：工作流列 200px（对齐设计稿）。头部一行标题 + 新建，下面一个搜索框；
            列表每行是「图标方块 + 名称/说明两行 + 启停圆点」，删除按钮悬停才露出来。 */}
        <div className="w-[200px] flex-none border-r border-border bg-card flex flex-col min-h-0">
          <div className="flex-none flex flex-col gap-[9px] px-3 pt-[13px] pb-[10px] border-b border-border-soft">
            <div className="flex items-center justify-between gap-2">
              <span className="flex-none whitespace-nowrap text-[12.5px] font-semibold">工作流</span>
              <button className="flex-none whitespace-nowrap flex items-center gap-1 px-2 py-[3px] rounded-[7px] border border-border bg-transparent text-muted text-[11.5px] hover:border-orange hover:text-orange-text" onClick={newWf}>
                <IconPlus size={11} />新建
              </button>
            </div>
            <div className="flex items-center gap-[7px] bg-bg border border-border rounded-lg px-[9px] py-[5px]">
              <span className="flex-none text-faint"><IconSearch size={12} /></span>
              <input value={wfQ} onChange={(e) => setWfQ(e.target.value)} placeholder="搜索工作流"
                className="flex-1 min-w-0 bg-transparent border-none outline-none text-[12px]" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-px">
            {wfList.map((w) => {
              const sel = w.id === curId;
              return (
                <div key={w.id} onClick={() => { setCurId(w.id); setSelNode(null); setSelConn(null); setSelSet([]); }}
                  className={`group flex items-center gap-[9px] px-2 py-[7px] rounded-lg cursor-pointer text-[12.5px] ${sel ? "bg-orange-soft text-orange-text font-semibold" : "hover:bg-hover"}`}>
                  <span className={`w-6 h-6 flex-none rounded-md flex items-center justify-center text-[13px] ${sel ? "bg-orange-soft text-orange-text" : "text-muted"}`}>
                    {w.icon || <IconFlow size={13} />}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className={`block truncate ${w.enabled === false ? "line-through" : ""}`}>{w.name}</span>
                    <span className="block mt-px text-[10.5px] font-normal text-faint truncate">{wfMeta(w)}</span>
                  </span>
                  {/* 启停指示：启用是实心绿点，停用是空心圈 —— 和徽章语义一套（绿=在线，灰=未启用）。 */}
                  <span className={`w-1.5 h-1.5 flex-none rounded-full ${w.enabled === false ? "border-[1.5px] border-border" : "bg-success"}`} />
                  <button className="flex-none text-danger bg-transparent opacity-0 group-hover:opacity-100" title="删除这条工作流" onClick={(e) => { e.stopPropagation(); delWf(w.id); }}><IconTrash size={12} /></button>
                </div>
              );
            })}
            {!wfs.length ? <div className="px-2 py-3 text-[11.5px] text-muted leading-[1.6]">还没有工作流，点右上角「新建」开一条。</div> : null}
            {wfs.length && !wfList.length ? <div className="px-2 py-3 text-[11.5px] text-muted leading-[1.6]">没有匹配「{wfQ}」的工作流。</div> : null}
          </div>
        </div>

        {/* 中：画布。整块深色是硬编码的，不随主题变 —— 设计规范里画布是唯一这么做的地方。 */}
        <div ref={canvasRef} className="relative flex-1 min-w-0 overflow-hidden"
          style={{ background: CV.bg, backgroundImage: "radial-gradient(rgba(255,255,255,.075) 1px,transparent 1px)", backgroundSize: `${18 * scale}px ${18 * scale}px`, backgroundPosition: `${pan.x}px ${pan.y}px`, cursor: "grab" }}
          onMouseDown={onCanvasDown} onContextMenu={openCanvasMenu} onWheel={onWheel}
          onDoubleClick={(e) => { if (cur) setPalette(toWorld(e.clientX, e.clientY)); }}>
          {/* 拖着对象经过画布时给一圈橙边：告诉用户「松手就落在这儿」。不吃鼠标事件。 */}
          {libDrag?.over ? (
            <div className="absolute inset-0 pointer-events-none z-[5]"
              style={{ boxShadow: `inset 0 0 0 2px ${CV.orange}`, background: "rgba(232,89,12,.06)" }} />
          ) : null}
          {!cur ? <div className="absolute inset-0 flex items-center justify-center text-[13px] text-white/40">新建或选择一个工作流</div> : null}
          {cur ? (
            <div className="absolute top-0 left-0" style={{ width: WORLD_W, height: WORLD_H, transform: `translate(${pan.x}px,${pan.y}px) scale(${scale})`, transformOrigin: "0 0" }}>
              <svg className="absolute top-0 left-0 pointer-events-none" width={WORLD_W} height={WORLD_H}>
                {cur.connections.map((c, i) => {
                  const a = node(c.from), b = node(c.to); if (!a || !b) return null;
                  const p1 = anchor(a, "out", c.fromPort), p2 = anchor(b, "in");
                  const d = `M ${p1.x} ${p1.y} C ${p1.x + 60} ${p1.y}, ${p2.x - 60} ${p2.y}, ${p2.x} ${p2.y}`;
                  // 选中的连线不是简单换个颜色：底下那条实线照旧，上面再叠一条橙色流动虚线，
                  // 这样既看得出选中、也看得出走向（动画在 index.css 的 umdash）。
                  return (
                    <g key={i}>
                      <path d={d} fill="none" stroke={selConn === i ? CV.orange : CV.wire} strokeWidth={1.6} />
                      {selConn === i ? <path d={d} fill="none" stroke={CV.orange} strokeWidth={1.6} strokeDasharray="4 10" style={{ animation: "umdash .9s linear infinite" }} /> : null}
                    </g>
                  );
                })}
                {link.current && linkPos ? (() => { const a = node(link.current.from); if (!a) return null; const p1 = anchor(a, "out", link.current.port); return <path d={`M ${p1.x} ${p1.y} C ${p1.x + 60} ${p1.y}, ${linkPos.x - 60} ${linkPos.y}, ${linkPos.x} ${linkPos.y}`} fill="none" stroke={CV.orange} strokeWidth={1.6} strokeDasharray="4 4" />; })() : null}
              </svg>
              {cur.connections.map((c, i) => {
                const a = node(c.from), b = node(c.to); if (!a || !b) return null;
                const p1 = anchor(a, "out", c.fromPort), p2 = anchor(b, "in");
                const ports = outPorts(a);
                const portTag = ports.length > 1 ? `${ports[portIndex(a, c.fromPort)]?.label || ""} ` : "";
                return (
                  <button key={`b${i}`} title="单击选中 · 双击切换分支 · 右键删除"
                    onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setSelConn(i); setSelNode(null); }}
                    onDoubleClick={(e) => { e.stopPropagation(); cycleMod(i); }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); delConn(i); }}
                    className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md text-[10.5px] px-[6px] py-px border font-mono whitespace-nowrap"
                    style={{ left: (p1.x + p2.x) / 2, top: (p1.y + p2.y) / 2,
                      background: selConn === i ? CV.orange : CV.chip, color: selConn === i ? "#fff" : CV.text,
                      borderColor: selConn === i ? CV.orange : CV.nodeBorder }}>{portTag}{MOD_LABEL[c.mod || ""]}</button>
                );
              })}
              {cur.nodes.map((n) => {
                const meta = TYPE_META[n.type] || { label: n.type, icon: IconFile, kind: "action" };
                const kind = KIND_STYLE[meta.kind] || { label: "对象", bg: "rgba(255,255,255,.06)", fg: CV.muted };
                // 主选中和框选中的节点边框一样高亮（E4）；单击/框选出来的手感因此一致。
                const sel = selNode === n.id || selSet.includes(n.id);
                const ports = outPorts(n);
                // 端口比节点本身高时把节点撑高，避免端口飘到卡片外面。
                const minH = Math.max(NODE_H, PORT_Y + (ports.length - 1) * PORT_GAP + 16);
                return (
                  <div key={n.id} className="absolute rounded-[11px] select-none cursor-grab active:cursor-grabbing"
                    style={{ left: n.x, top: n.y, width: NODE_W, minHeight: minH,
                      background: n.disabled ? CV.nodeOff : CV.node, color: CV.text,
                      // 选中用 1.5px 描边 + 一圈淡橙光晕（设计规范：选中节点 1.5px，其余一律 1px）。
                      border: `${sel ? 1.5 : 1}px ${n.disabled ? "dashed" : "solid"} ${sel ? CV.orange : n.disabled ? CV.nodeOffBorder : CV.nodeBorder}`,
                      boxShadow: sel ? "0 0 0 4px rgba(232,89,12,.14)" : undefined,
                      opacity: n.disabled ? 0.75 : 1 }}
                    onMouseDown={(e) => onNodeDown(e, n)} onMouseUp={() => onNodeUp(n)}
                    onDoubleClick={(e) => { e.stopPropagation(); setEditNode(n.id); }} onContextMenu={(e) => openNodeMenu(e, n)}>
                    <div className="flex items-center gap-[9px] px-[11px] py-[9px] rounded-t-[10px]"
                      style={{ borderBottom: `1px solid ${n.disabled ? CV.nodeOffBorder : CV.nodeLine}`,
                        background: n.disabled ? "transparent" : sel ? "rgba(232,89,12,.10)" : "rgba(255,255,255,.03)" }}>
                      <span className="w-[22px] h-[22px] flex-none rounded-md flex items-center justify-center"
                        style={{ background: n.disabled ? "rgba(255,255,255,.05)" : kind.bg, color: n.disabled ? CV.faint : kind.fg }}>
                        <meta.icon size={13} />
                      </span>
                      <b className="flex-1 min-w-0 text-[12.5px] font-semibold truncate" style={{ color: n.disabled ? CV.muted : CV.text }}>{meta.label}</b>
                      {/* 头部右侧那颗小徽章：停用时说「已停用」，否则说这是哪一类对象。 */}
                      <span className="flex-none whitespace-nowrap px-[6px] py-px rounded-full text-[10px]"
                        style={{ background: "rgba(255,255,255,.07)", color: n.disabled ? CV.faint : CV.muted }}>
                        {n.disabled ? "已停用" : kind.label}
                      </span>
                    </div>
                    {/* 正文：键值行（对齐设计稿）。左侧 52px 固定宽的字段名，右侧值；
                        mono 的值套一个等宽底框——路径、脚本、键位这类要逐字看清的东西，
                        混在正文字体里一个下划线和一个连字符看着是一样的。 */}
                    <div className="px-[11px] py-[8px] flex flex-col gap-[3px]">
                      {nodeRows(n).map((r, ri) => (
                        <div key={ri} className="flex items-baseline gap-[7px]">
                          <span className="w-[52px] flex-none whitespace-nowrap text-[10.5px]"
                            style={{ color: n.disabled ? CV.faint : CV.faint }}>{r.k}</span>
                          <span className={`flex-1 min-w-0 truncate text-[11px] ${r.mono ? "font-mono px-[5px] py-px rounded-[5px]" : ""}`}
                            style={{
                              color: n.disabled ? CV.faint : (r.mono ? CV.dim : CV.muted),
                              background: r.mono && !n.disabled ? CV.bg : undefined,
                            }}>{r.v}</span>
                        </div>
                      ))}
                    </div>
                    {/* 端口 9px + 2px 画布底色描边，看着像「嵌」在卡片边上。入口在左，出口在右侧竖着排。
                        配色表达「接没接上」：已连线橙色、空着灰色，失败出口固定红色 —— 多出口节点漏接哪一路一眼看得出。 */}
                    <span data-port className="absolute w-[9px] h-[9px] rounded-full" style={{ left: -5, top: PORT_Y - 4, border: `2px solid ${CV.bg}`,
                      background: cur.connections.some((c) => c.to === n.id) ? CV.orange : CV.port }} />
                    {ports.map((p, pi) => (
                      <span key={p.port || "def"} data-port className="absolute w-[9px] h-[9px] rounded-full cursor-crosshair" title={p.label || "出口"}
                        style={{ right: -5, top: PORT_Y + pi * PORT_GAP - 4, border: `2px solid ${CV.bg}`,
                          background: p.port === "error" ? CV.danger
                            : cur.connections.some((c) => c.from === n.id && (c.fromPort || "") === p.port) ? CV.orange : CV.port }}
                        onMouseDown={(e) => onPortDown(e, n, p.port)} />
                    ))}
                    {ports.length > 1 ? ports.map((p, pi) => (
                      <span key={`lb${p.port}`} title={p.label}
                        className="absolute text-[9.5px] whitespace-nowrap pointer-events-none overflow-hidden text-ellipsis max-w-[120px]"
                        style={{ left: NODE_W + 9, top: PORT_Y + pi * PORT_GAP - 7, color: CV.faint }}>{p.label}</span>
                    )) : null}
                  </div>
                );
              })}
              {/* 框选矩形（E4）：只是个视觉反馈，不吃鼠标事件。 */}
              {marquee ? (
                <div className="absolute border border-orange bg-orange/10 pointer-events-none rounded-sm"
                  style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1),
                    width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />
              ) : null}
            </div>
          ) : null}
          {/* 缩放胶囊：只跟画布有关，所以贴在画布右上角而不是顶栏。左右两个步进 + 中间百分比（点=复位）+ 适应画布。 */}
          {cur ? (
            <div className="absolute right-4 top-[14px] flex items-center overflow-hidden" style={CV_FLOAT} onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
              <button className={ZB} style={{ color: CV.dim }} title="缩小" onClick={() => zoomBy(0.9)}><IconMinus size={13} /></button>
              <span className="flex-none px-1 min-w-[42px] text-center text-[11.5px] tabular-nums" style={{ color: CV.dim }}>{Math.round(scale * 100)}%</span>
              <button className={ZB} style={{ color: CV.dim }} title="放大" onClick={() => zoomBy(1.1)}><IconPlus size={13} /></button>
              <span className="w-px h-4 flex-none" style={{ background: CV.nodeBorder }} />
              <button className={ZB} style={{ color: CV.dim }} title="适应画布 ⇧1" onClick={fitView}><IconFit size={13} /></button>
              <button className={ZB} style={{ color: CV.dim }} title="复位视图 ⇧0（100%）" onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }}><IconRefresh size={13} /></button>
            </div>
          ) : null}
          {/* 画布底部一条：左边是「当前选了什么 · 一共多少」，右边是四个高频快捷键 + 全部快捷键入口。
              原来那一长串提示文字撤了 —— 一行塞十几条谁也不会读，进弹窗看反而清楚。 */}
          {cur ? (
            <div className="absolute left-4 right-4 bottom-[14px] flex items-center gap-[10px]" onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2 min-w-0 flex-[0_1_auto] overflow-hidden px-[11px] py-[6px]" style={CV_FLOAT}>
                <span className="w-1.5 h-1.5 flex-none rounded-full" style={{ background: selSet.length || selNode ? CV.orange : CV.port }} />
                <span className="text-[11.5px] whitespace-nowrap overflow-hidden text-ellipsis" style={{ color: CV.dim }}>
                  {selSet.length > 1 ? `已选中 ${selSet.length} 个节点 · ` : selNode ? "已选中 1 个节点 · " : selConn !== null ? "已选中 1 条连线 · " : ""}
                  {cur.nodes.length} 节点 · {cur.connections.length} 连线
                </span>
              </div>
              <span className="flex-1" />
              <div className="flex items-center gap-2 flex-none whitespace-nowrap px-[9px] py-[5px]" style={CV_FLOAT}>
                {CANVAS_KEYS.slice(0, 4).map((k) => (
                  <span key={k.key} className="flex-none flex items-center gap-[5px]">
                    <span className="font-mono text-[10.5px] rounded px-[5px] py-px" style={{ background: "rgba(255,255,255,.07)", color: CV.dim }}>{k.key}</span>
                    <span className="text-[10.5px]" style={{ color: CV.muted }}>{k.label}</span>
                  </span>
                ))}
                <button className="flex-none whitespace-nowrap ml-0.5 bg-transparent text-[10.5px]" style={{ color: CV.orangeText }} onClick={() => setShowKeys(true)}>全部快捷键</button>
              </div>
            </div>
          ) : null}
          {/* 全部快捷键：和底部那条同一份数据（CANVAS_KEYS），不会两处各说一套。 */}
          {showKeys ? (
            <div className="absolute inset-0 z-[40] bg-black/50 flex items-center justify-center"
              onMouseDown={(e) => { e.stopPropagation(); setShowKeys(false); }}
              onWheel={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
              <div className="w-[420px] max-h-[calc(100%-32px)] flex flex-col rounded-xl overflow-hidden"
                style={{ background: CV.node, border: `1px solid ${CV.nodeBorder}` }} onMouseDown={(e) => e.stopPropagation()}>
                <div className="flex-none flex items-center gap-2 px-4 py-[13px]" style={{ borderBottom: `1px solid ${CV.nodeLine}` }}>
                  <span className="flex-1 min-w-0 whitespace-nowrap text-[13px] font-semibold" style={{ color: CV.text }}>画布快捷键</span>
                  <button className="w-6 h-6 flex-none flex items-center justify-center rounded-md bg-transparent" style={{ color: CV.muted }} title="关闭" onClick={() => setShowKeys(false)}><IconX size={13} /></button>
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-2 pb-[14px]">
                  {CANVAS_KEYS.map((k) => (
                    <div key={k.key} className="flex items-center gap-3 py-1.5" style={{ borderBottom: `1px solid ${CV.nodeLine}` }}>
                      <span className="flex-none font-mono text-[11px] rounded px-1.5 py-0.5 min-w-[78px] text-center" style={{ background: "rgba(255,255,255,.07)", color: CV.dim }}>{k.key}</span>
                      <span className="flex-none whitespace-nowrap text-[12px]" style={{ color: CV.muted }}>{k.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* 右：对象库（默认收起，顶栏 ▤ 按钮切换） */}
        {lib ? (
          <ObjectLibrary prefabs={prefabs} canAdd={!!cur}
            onDragItem={armDrag}
            onPrefab={(p) => { const c = canvasCenter(); placePrefab(p, c.x, c.y); }}
            onDelPrefab={(p) => { savePrefabs(prefabs.filter((x) => x.id !== p.id)); setNote(`已删除预制件「${p.name}」`); }}
            onClose={() => setLib(false)} />
        ) : null}
      </div>

      {drawer ? (
        <DebugDrawer runs={runs}
          nodeLabel={(id, type) => { const n = cur?.nodes.find((x) => x.id === id); return `${TYPE_META[type]?.label || type}${n ? ` · ${nodeSummary(n)}` : "（节点已删除）"}`; }}
          onPickNode={(id) => { setSelNode(id); setSelConn(null); }}
          onClear={() => { void api.clearTrace(); setRuns([]); }}
          onClose={() => setDrawer(false)} />
      ) : null}

      {palette ? (
        <Palette canConnect={!!selNode}
          onPick={(type, connect) => addNode(type, palette.x, palette.y, connect && selNode ? selNode : undefined)}
          onClose={() => setPalette(null)} />
      ) : null}
      {/* 拖拽中跟着光标走的卡片。长得和画布上的节点一样（同一套硬编码深色），
          并按当前缩放同步缩放 —— 所见即所得：看到多大、落下去就是多大。
          缩放下限 0.5，缩得太小就认不出拖的是什么了。 */}
      {libDrag ? (() => {
        const meta = TYPE_META[libDrag.type] || { label: libDrag.type, icon: IconFile, kind: "action" };
        const kind = KIND_STYLE[meta.kind] || { label: "对象", bg: "rgba(255,255,255,.06)", fg: CV.muted };
        const k = Math.max(0.5, scale);
        return (
          <div className="fixed pointer-events-none z-[80]"
            style={{ left: libDrag.x - DRAG_GRAB, top: libDrag.y - DRAG_GRAB, width: NODE_W,
              transform: `scale(${k})`, transformOrigin: "0 0", opacity: libDrag.over ? 1 : 0.55 }}>
            <div className="rounded-[11px] overflow-hidden"
              style={{ background: CV.node, color: CV.text, border: `1px solid ${CV.nodeBorder}`,
                boxShadow: "0 12px 32px rgba(0,0,0,.5)" }}>
              <div className="flex items-center gap-[9px] px-[11px] py-[9px]"
                style={{ borderBottom: `1px solid ${CV.nodeLine}`, background: "rgba(255,255,255,.03)" }}>
                <span className="w-[22px] h-[22px] flex-none rounded-md flex items-center justify-center"
                  style={{ background: kind.bg, color: kind.fg }}><meta.icon size={13} /></span>
                <span className="flex-1 min-w-0 truncate text-[12.5px] font-semibold">{meta.label}</span>
                <span className="flex-none text-[10px] px-1.5 py-px rounded-full"
                  style={{ background: kind.bg, color: kind.fg }}>{kind.label}</span>
              </div>
              <div className="px-[11px] py-[9px] text-[11px]" style={{ color: CV.faint }}>
                {libDrag.over ? "松手放在这里" : "拖到画布上松手"}
              </div>
            </div>
          </div>
        );
      })() : null}

      {/* 找不到那个节点就不渲染：拖拽落地是「加节点 + 开弹窗」两个 setState，
          万一将来被拆到不同的批次里，这里的非空断言会直接把编辑器打崩。 */}
      {editNode && cur?.nodes.some((n) => n.id === editNode) ? (
        <NodeConfig node={cur.nodes.find((n) => n.id === editNode)!} onClose={() => setEditNode(null)}
          onSave={(cfg) => { setNodeConfig(editNode, cfg); setEditNode(null); }}
          onDelete={() => { delNode(editNode); setEditNode(null); }} />
      ) : null}
      {showCfg && cur ? (
        <ConfigEditor wf={cur} onClose={() => setShowCfg(false)}
          onSave={(fields, vals) => { updateCur((w) => ({ ...w, config: fields, variables: vals })); setShowCfg(false); }} />
      ) : null}

      {naming ? (
        <PrefabNamer init={naming.name} count={naming.ids.length}
          onClose={() => setNaming(null)}
          onOk={(name) => { savePrefab(naming.ids, name); setNaming(null); }} />
      ) : null}

      {showVars && cur ? (
        <VarsEditor vars={cur.variables || {}} onClose={() => setShowVars(false)} onSave={(v) => { updateCur((w) => ({ ...w, variables: v })); setShowVars(false); }} />
      ) : null}
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} dark={menu.dark} title={menu.title} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

// Split / Join 的分隔符选项：键与引擎 delimOf() 认的值一一对应，改这里记得两边一起改。
const DELIM_LABEL: Record<string, string> = { comma: "逗号", space: "空格", tab: "制表符", newline: "换行", custom: "自定义" };
// Transform 节点的变换方式中文名。原来卡片上直接显示 mode 的英文值（upper/urlencode…），
// 和别处都用中文对不上，顺手补齐。键要和 NodeConfig 里那个下拉的 option 值一一对应。
// 音乐控制的命令名。键要和主进程 workflow.ts 里 MUSIC_CMDS 的键一一对应 ——
// 两处对不上时卡片会显示原始键名（不至于崩，但一眼能看出是谁漏了）。
// 文件类别的中文名。键要和主进程 filesearch.ts 里 KIND_UTI 的键一一对应。
// 系统命令的中文名。键要和主进程 workflow.ts 里 SYSTEM_CMDS 的键一一对应。
const SYSTEM_LABEL: Record<string, string> = {
  lock: "锁定屏幕", sleep: "睡眠", screensaver: "启动屏保",
  emptytrash: "清空废纸篓", hideothers: "隐藏其它应用", logout: "注销当前用户",
};
const FILE_KIND_LABEL: Record<string, string> = {
  any: "全部", folder: "文件夹", image: "图片", audio: "音频",
  movie: "视频", pdf: "PDF", text: "文本", archive: "压缩包",
};
const MUSIC_LABEL: Record<string, string> = {
  playpause: "播放 / 暂停", play: "播放", pause: "暂停",
  next: "下一首", previous: "上一首", volume: "设置音量", now: "当前播放",
};
// 搜索引擎的显示名。键要和主进程 workflow.ts 里 SEARCH_ENGINES 的键一一对应；
// custom 只在这边有，主进程那边是靠 config.custom 走的另一条分支。
const SEARCH_ENGINE_LABEL: Record<string, string> = {
  google: "Google", bing: "Bing", duckduckgo: "DuckDuckGo",
  baidu: "百度", github: "GitHub", wikipedia: "维基百科", custom: "自定义地址",
};
// 变换方式的中文名。键要和主进程 workflow.ts 里 transformText() 的 case 一一对应 ——
// 原来这里写的是 base64/unbase64/json/unjson，实际取值却是 base64encode/base64decode，
// 结果卡片上直接露出英文 mode 值。改键名时两处要一起改。
const TRANSFORM_LABEL: Record<string, string> = {
  upper: "全部大写", lower: "全部小写", title: "首字母大写", trim: "去掉首尾空白",
  urlencode: "URL 编码", urldecode: "URL 解码",
  base64encode: "Base64 编码", base64decode: "Base64 解码",
  reverse: "反转字符串", deaccent: "去掉重音符号", alnum: "只留字母数字",
};
// Run Script 的语言名。键要和主进程 workflow.ts 里 SCRIPT_LANGS 的键一一对应。
const SCRIPT_LANG_LABEL: Record<string, string> = {
  bash: "bash", zsh: "zsh", python3: "Python 3", ruby: "Ruby", node: "Node.js", osascript: "AppleScript",
};

// 条件类节点在卡片上怎么写「出口」这一行。
// 起了名字的出口直接把名字列出来 —— 卡片上能看见「打开网址 / 查快递 / 否则」时，
// 不点开弹窗就知道这个分支节点在分什么，这正是出口命名的意义所在。
// 名字太多放不下就退回计数，别把卡片撑破。
function exitsLabel(rules: { label?: string }[]): string {
  if (!rules.length) return "只有「否则」";
  const named = rules.map((r) => String(r?.label || "").trim()).filter(Boolean);
  if (named.length === rules.length) {
    const joined = `${named.join(" / ")} / 否则`;
    if (joined.length <= 24) return joined;
  }
  return `${rules.length} 个 + 否则`;
}

// 节点卡片正文的一行。k=字段名，v=值，mono=用等宽字 + 底框显示。
// mono 留给「要逐字看清」的东西：路径、脚本、网址、键位、分隔符 —— 混在正文字体里
// 一个下划线和一个连字符看着是一样的。
export interface SumRow { k: string; v: string; mono?: boolean }

// 取值，空则回落到占位文案（占位一律说清「没设」，不要显示空白让人以为是渲染坏了）。
function val(v: unknown, empty: string): string {
  const s = String(v ?? "").trim();
  return s || empty;
}
// 截断长文本。卡片只有 252px 宽，再长也看不全，不如早点收住。
function cut(s: string, n = 30): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}
// 分隔符的显示名：自定义时把用户填的那串原样显示出来（空格/换行看不见，用记号代替）。
function delim(kind: string, custom: string): string {
  if (kind === "custom") return val(custom, "（未填）");
  return DELIM_LABEL[kind || "comma"] || kind;
}

// 节点卡片正文：按类型给出「字段名 : 值」的键值行（最多两行，卡片放不下更多）。
// 对象库里 55 种全部登记在册；万一遇到没登记的类型（比如从别处导入的工作流带来的），
// 走最后的兜底分支，字段名是「未登记」。
// 每一条都只描述**这个节点自己配了什么**，不复述类型名——类型名已经在卡片标题上了。
// 导出是给 tests/nodeSummary.test.ts 用的：55 种节点逐个跑一遍，防止新加对象忘了补摘要。
export function nodeRows(n: WFNode): SumRow[] {
  const c = n.config as Record<string, string>;
  const cfg = n.config as Record<string, unknown>;
  switch (n.type) {
    // ── 触发器 ──────────────────────────────────────────────────────────────
    case "trigger.keyword": return [
      { k: "关键词", v: val(c.keyword, "未设"), mono: true },
      { k: "参数", v: c.arg === "none" ? "不带参数" : `${c.arg === "required" ? "必填" : "可选"}${cfg.withSpace === false ? " · 紧贴关键词" : ""}` },
    ];
    case "trigger.hotkey": return [
      { k: "快捷键", v: val(c.accelerator, "未录制"), mono: true },
      { k: "参数", v: "当前剪贴板文本" },
    ];
    case "trigger.always": return [
      { k: "触发", v: "任意输入都尝试" },
      { k: "结果", v: "并入普通搜索" },
    ];
    case "trigger.universal": return [
      { k: "快捷键", v: val(c.accelerator, "未录制"), mono: true },
      { k: "抓取", v: c.source === "files" ? "选中的文件路径" : c.source === "text" ? "选中的文本" : "文本或文件（自动）" },
    ];

    // ── 输入 ────────────────────────────────────────────────────────────────
    case "input.scriptfilter": return [
      { k: "脚本", v: cut(val(c.script, "未设脚本")), mono: true },
      Number(c.debounceMs) > 0
        ? { k: "防抖", v: `停手 ${Number(c.debounceMs)}ms 后才跑` }
        : c.cwd ? { k: "目录", v: cut(String(c.cwd)), mono: true }
                : { k: "过滤", v: c.alfredFilters ? "由 Umbra 按输入过滤" : "脚本自己过滤" },
    ];
    case "input.listfilter": return [
      { k: "列表", v: `${((cfg.items as unknown[]) || []).length} 项` },
      { k: "匹配", v: c.match === "none" ? "不过滤" : c.match === "contains" ? "任意位置包含" : "词首匹配" },
    ];
    case "input.codec": return [
      { k: "类型", v: { url: "URL", base64: "Base64" }[c.mode || "unicode"] || "Unicode" },
      { k: "方向", v: "按输入自动判断编/解码" },
    ];
    case "input.appsfilter": return [
      { k: "列出", v: "当前在跑、有界面的应用" },
      { k: "回车", v: String(c.action || "switch") === "quit" ? "退出这个应用" : "切换到这个应用" },
    ];
    case "utility.hide": return [
      { k: "动作", v: "收起快捷入口面板" },
      { k: "焦点", v: "还给刚才那个应用" },
    ];
    case "utility.show": return [
      { k: "动作", v: "重新唤起快捷入口面板" },
      { k: "配套", v: "和「隐藏主面板」成对用" },
    ];
    case "output.keycombo": {
      const rep = Math.trunc(Number(c.repeat ?? 1)) || 1;
      return [
        { k: "按键", v: `${val(c.accelerator, "未录键位")}${rep > 1 ? ` ×${rep}` : ""}`, mono: true },
        { k: "发送前", v: cfg.hideFirst === false ? "不收起面板" : "先收起面板" },
      ];
    }
    case "automation.system": return [
      { k: "命令", v: SYSTEM_LABEL[String(c.command || "lock")] || String(c.command) },
      { k: "执行前", v: cfg.confirm === true ? "弹确认框（防误触）" : "直接执行" },
    ];
    case "input.filefilter": {
      const scopes = String(c.scopes || "").split("\n").map((x) => x.trim()).filter(Boolean);
      const exts = String(c.exts || "").trim();
      return [
        { k: "范围", v: scopes.length === 1 ? cut(scopes[0], 24) : scopes.length ? `${scopes.length} 个目录` : "全盘（仅 macOS）", mono: scopes.length === 1 },
        { k: "类型", v: exts ? cut(exts, 22) : FILE_KIND_LABEL[String(c.kind || "any")] || "全部" },
      ];
    }
    case "utility.fileconditional": {
      const rules = (cfg.rules as { label?: string }[]) || [];
      return [
        { k: "规则", v: rules.length ? `${rules.length} 条` : "未设规则" },
        { k: "出口", v: exitsLabel(rules) },
      ];
    }
    case "action.reveal": return [
      { k: "定位", v: cut(val(c.path, "{query}"), 26), mono: true },
      { k: "行为", v: "选中它，不打开" },
    ];
    case "action.browse": return [
      { k: "目录", v: cut(val(c.path, "{query}"), 26), mono: true },
      { k: "用什么开", v: val(c.app, "Terminal") },
    ];
    case "action.filebuffer": {
      const mode = String(c.mode || "add");
      return [
        { k: "动作", v: mode === "list" ? "取出全部交给下游" : mode === "clear" ? "清空暂存区" : "把路径收进暂存区" },
        mode === "list"
          ? { k: "取完", v: cfg.clearAfter === false ? "保留暂存区" : "清空暂存区" }
          : { k: "来源", v: cut(val(c.path, "{query}"), 22), mono: true },
      ];
    }
    case "input.dict": return [
      { k: "查询", v: "把输入当作要查的词" },
      { k: "回车", v: "在词典 App 中打开" },
    ];
    case "input.calc": return [
      { k: "输入", v: "算式，如 3*4+2" },
      { k: "回车", v: "复制结果" },
    ];
    case "input.units": return [
      { k: "输入", v: "换算，如 10km to mi" },
      { k: "回车", v: "复制结果" },
    ];

    // ── 工具 ────────────────────────────────────────────────────────────────
    case "utility.args": {
      const mode = c.argMode || "keep";
      const vars = Object.keys((cfg.vars as Record<string, string>) || {}).length;
      return [
        mode === "set" ? { k: "参数", v: cut(val(c.text, "{query}"), 22), mono: true }
                       : { k: "参数", v: mode === "clear" ? "清空" : "沿用上游" },
        { k: "变量", v: vars ? `${vars} 个` : "未设" },
      ];
    }
    case "utility.conditional": {
      const rules = (cfg.rules as { op?: string; label?: string }[]) || [];
      return [
        { k: "规则", v: rules.length ? `${rules.length} 条` : "未设规则" },
        { k: "出口", v: exitsLabel(rules) },
      ];
    }
    case "utility.transform": return [
      { k: "作用于", v: c.target ? `变量 ${c.target}` : "参数 arg" },
      { k: "方式", v: TRANSFORM_LABEL[c.mode || "upper"] || String(c.mode) },
    ];
    case "utility.replace": return [
      { k: c.regex ? "正则" : "查找", v: cut(val(c.find, "未设"), 22), mono: true },
      { k: "替换为", v: cut(val(c.to, "（空）"), 22), mono: true },
    ];
    case "utility.dialog": {
      const btns = dialogButtons(cfg);
      return [
        { k: "问句", v: cut(val(c.title, "未填问句"), 26) },
        { k: "按钮", v: `${btns.join(" / ")}（${btns.length} 个出口）` },
      ];
    }
    case "utility.delay": return [
      { k: "等待", v: `${Number(c.seconds || 0)} 秒` },
      { k: "期间", v: c.text ? cut(String(c.text), 20) : "不提示" },
    ];
    case "utility.debug": return [
      { k: "打点", v: cut(val(c.text, "{query}"), 24), mono: true },
      { k: "记录", v: c.clear ? "执行到这里先清空" : "追加到调试抽屉" },
    ];
    case "utility.split": return [
      { k: "分隔符", v: delim(c.with || "comma", c.custom), mono: c.with === "custom" },
      { k: "输出", v: c.output === "args" ? "逐条执行下游" : `变量 ${val(c.prefix, "split")}1…` },
    ];
    case "utility.junction": return [
      { k: "作用", v: "纯理线，不改数据" },
      { k: "出口", v: "原样传给下游" },
    ];
    case "utility.filter": {
      const rules = (cfg.rules as unknown[]) || [];
      return [
        { k: "规则", v: rules.length ? `${rules.length} 条（任一命中即放行）` : "未设 · 全部放行" },
        { k: "不满足时", v: "中断这条链路" },
      ];
    }
    case "utility.random": {
      const mode = String(c.mode || "range");
      const shape = mode === "uuid" ? "UUID"
        : mode === "hex" ? `十六进制 ${Number(c.length || 8)} 位`
        : mode === "str" ? `随机串 ${Number(c.length || 8)} 位`
        : mode === "list" ? `列表随机取一项（${String(c.list || "").split("\n").filter((x) => x.trim()).length} 项）`
        : `${Number(c.min ?? 1)} – ${Number(c.max ?? 100)}`;
      return [
        { k: "生成", v: shape },
        { k: "写入", v: c.target ? `变量 ${c.target}` : "参数 arg" },
      ];
    }
    case "utility.jsonconfig": {
      const raw = String(c.json || "").trim();
      let keys = 0;
      let wrapped: Record<string, unknown> | null = null;
      try {
        const o = raw ? JSON.parse(raw) : null;
        if (o && typeof o === "object" && !Array.isArray(o)) {
          const w = (o as Record<string, unknown>).alfredworkflow;
          if (w && typeof w === "object" && !Array.isArray(w)) wrapped = w as Record<string, unknown>;
          keys = Object.keys(wrapped ? (wrapped.variables as object) || {} : o).length;
        }
      } catch { keys = -1; }   // 填了但解不出来：直接在卡片上说清楚，别等运行才报错
      // 包裹写法能同时改 arg 和下游节点的配置，这两件事比「设了几个变量」重要得多，优先显示。
      const extra = wrapped
        ? [wrapped.arg !== undefined ? "改参数" : "", wrapped.config ? "改下游配置" : ""].filter(Boolean).join(" · ")
        : "";
      return [
        { k: "变量", v: keys < 0 ? "JSON 不合法" : keys ? `${keys} 个` : "未填" },
        { k: extra ? "还会" : "值里", v: extra || "可用 {query} / {var:名称}" },
      ];
    }
    case "utility.join": return [
      { k: "分隔符", v: delim(c.with || "newline", c.custom), mono: c.with === "custom" },
      { k: "输入", v: "上游拆出来的多条参数" },
    ];

    // ── 动作 ────────────────────────────────────────────────────────────────
    case "action.launch": {
      const paths = (cfg.paths as string[]) || [];
      return [
        { k: "目标", v: paths.length ? `${paths.length} 个 App/文件` : "未选择" },
        paths.length === 1 ? { k: "路径", v: cut(String(paths[0]), 26), mono: true }
                           : { k: "已在前台", v: c.toggleVisibility ? "再按一次隐藏" : "照常置前" },
      ];
    }
    case "action.openfile": return [
      { k: "路径", v: cut(val(c.path, "{query}"), 26), mono: true },
      { k: "用什么打开", v: val(c.app, "系统默认") },
    ];
    case "action.openurl": return [
      { k: "网址", v: cut(val(c.url, "{query}"), 30), mono: true },
      { k: "打开方式", v: val(c.browser, "默认浏览器") },
    ];
    case "action.script": {
      const lg = String(c.language || "bash");
      return [
        { k: SCRIPT_LANG_LABEL[lg] || lg, v: cut(val(c.script, "未设脚本")), mono: true },
        c.cwd ? { k: "目录", v: cut(String(c.cwd), 26), mono: true }
              : { k: "失败时", v: c.onError === "continue" ? "忽略继续" : c.onError === "branch" ? "走失败出口" : "停止链路" },
      ];
    }
    case "action.applescript": return [
      { k: "脚本", v: cut(val(c.script, "未设脚本")), mono: true },
      { k: "返回值", v: c.output === "replace" ? "作为参数传给下游" : c.output === "copy" ? "复制到剪贴板" : "忽略" },
    ];
    case "automation.shortcut": return [
      { k: "快捷指令", v: cut(val(c.name, "未填名称"), 24) },
      { k: "输入", v: `${cfg.input === false ? "不传（空输入）" : "上游参数 {query}"}${cfg.wait === false && c.output !== "replace" ? " · 不等它跑完" : ""}` },
    ];
    case "automation.music": {
      const key = String(c.command || "playpause");
      const label = MUSIC_LABEL[key] || key;
      return [
        { k: "动作", v: key === "volume" ? `${label} ${Number(cfg.volume ?? 50)}` : label },
        { k: "目标", v: "「音乐」App（仅 macOS）" },
      ];
    }
    case "action.terminal": return [
      { k: "命令", v: cut(val(c.command, "{query}"), 26), mono: true },
      { k: "终端", v: `${val(c.app, "Terminal")}（输出取不回来）` },
    ];
    case "action.websearch": {
      const key = String(c.engine || "google");
      return [
        { k: "引擎", v: SEARCH_ENGINE_LABEL[key] || key },
        key === "custom"
          ? { k: "地址", v: cut(val(c.custom, "未填地址"), 26), mono: true }
          : { k: "搜什么", v: cut(val(c.query, "{query}"), 26), mono: true },
      ];
    }
    case "action.copy": return [
      { k: "内容", v: "上游参数 {query}", mono: true },
      { k: "去向", v: "系统剪贴板" },
    ];
    case "action.paste": return [
      { k: "内容", v: "上游参数 {query}", mono: true },
      { k: "去向", v: "前台应用（需辅助功能权限）" },
    ];
    case "action.assistant": return [
      { k: "内容", v: "上游参数 {query}", mono: true },
      { k: "去向", v: "聊天页发给秘书，不等回复" },
    ];
    case "action.inspiration": return [
      { k: "内容", v: "上游参数 {query}", mono: true },
      { k: "去向", v: "记为一条灵感" },
    ];
    case "action.ask_assistant": return [
      { k: "提问", v: cut(val(c.prompt, "{query}"), 26), mono: true },
      { k: "回复", v: c.show ? "弹窗展示" : "作为参数传给下游" },
    ];
    case "action.create_task": return [
      { k: "任务", v: cut(val(c.text, "{query}"), 26) },
      { k: "执行设备", v: val(c.device, "由服务端挑") },
    ];
    case "action.device_skill": return [
      { k: "技能", v: `${val(c.provider, "?")}.${val(c.skill, "?")}`, mono: true },
      { k: "设备", v: val(c.device, "自动挑一台在线的") },
    ];

    // ── 输出 ────────────────────────────────────────────────────────────────
    case "output.notify": return [
      { k: "标题", v: cut(val(c.title, "（用工作流名）"), 24) },
      { k: "正文", v: `${cut(val(c.text, "上游参数 {query}"), 18)}${c.ifEmpty === "show" ? " · 空也弹" : " · 空则跳过"}` },
    ];
    case "output.largetype": return [
      { k: "内容", v: "上游参数 {query}", mono: true },
      { k: "形式", v: "半透明浮层大字" },
    ];
    case "output.textview": return [
      { k: "标题", v: val(c.title, "（无）") },
      { k: "写入", v: `${c.append ? "追加" : "覆盖"}${c.markdown ? " · Markdown" : ""}` },
    ];
    case "output.writefile": return [
      { k: "文件", v: cut(val(c.path, "未设文件名"), 26), mono: true },
      { k: "已存在时", v: { append: "追加到末尾", prepend: "插到开头", skip: "跳过", unique: "另存新名" }[String(c.ifExists || "overwrite")] || "覆盖" },
    ];
    case "output.speak": return [
      { k: "念什么", v: cut(val(c.text, "{query}"), 26), mono: true },
      { k: "声音", v: `${val(c.voice, "系统默认")}${c.wait ? " · 念完再往下" : ""}` },
    ];
    case "output.sound": return [
      { k: "声音", v: c.path ? cut(String(c.path), 26) : `系统提示音 ${val(c.system, "Glass")}`, mono: !!c.path },
      { k: "时机", v: "不等它放完，直接往下走" },
    ];

    // 兜底：类型不在上面（理论上不会发生，除非新加了对象忘了补这里）。
    // 字段名用「未登记」而不是「类型」——它同时是 tests/nodeSummary.test.ts 判定
    // 「有人漏写了摘要」的标志位，和正常分支的字段名撞名就判不出来了。
    default: return [{ k: "未登记", v: TYPE_META[n.type]?.label || n.type, mono: true }];
  }
}

// 一行版摘要：调试抽屉的标题这类只能塞一行文字的地方用，直接把键值行拼起来。
function nodeSummary(n: WFNode): string {
  return nodeRows(n).map((r) => `${r.k} ${r.v}`).join(" · ");
}

// Launch 目标列表。没有「加一条」按钮 —— 空行对这个节点没意义（路径得先选出来），
// 所以添加入口是下面两个「选 App / 选文件」，选完直接成行。
function LaunchList({ paths, onChange }: { paths: string[]; onChange: (p: string[]) => void }) {
  const [icons, setIcons] = useState<Record<string, string>>({});
  useEffect(() => {
    for (const p of paths) if (!(p in icons)) void api.fileIcon(p).then((d) => setIcons((m) => ({ ...m, [p]: d || "" })));
  }, [paths]);
  return (
    <RowTable<string>
      rows={paths} onChange={onChange}
      cols={[{ label: "路径", cls: "flex-1 min-w-0" }]}
      emptyText="还没有目标。用下面两个按钮挑一个 App 或文件。"
      cell={(p, i) => [
        <div key="p" className="flex items-center gap-[8px]">
          <span className="w-[18px] h-[18px] flex-none flex items-center justify-center">
            {icons[p] ? <img src={icons[p]} className="w-[16px] h-[16px]" alt="" /> : <span className="text-[12px]">📄</span>}
          </span>
          <input className={`${CELL_MONO} flex-1 min-w-0`} value={p}
            onChange={(e) => onChange(paths.map((x, j) => (j === i ? e.target.value : x)))} />
        </div>,
      ]}
      extra={
        <div className="flex gap-[8px] px-[10px] py-[8px] border-t border-border-soft">
          <button className={BTN_SEC} onClick={async () => { const a = await api.pickApp(); if (a) onChange([...paths, `/Applications/${a}.app`]); }}>选 App</button>
          <button className={BTN_SEC} onClick={async () => { const p = await api.pickPath(); if (p) onChange([...paths, p]); }}>选文件</button>
        </div>
      }
    />
  );
}

// ── Conditional 规则表 ──
// 一行一条规则，顺序即出口顺序（第 1 行 → r0 口，以此类推）；判断在引擎侧由 matchRule 执行。
// label：这条规则对应的出口在画布上显示成什么。留空时退回「规则N」。
// 出口名是**给读画布的人看的**：一条工作流拉了五条线出去，端口边上写「打开网址」「查快递」
// 远比「规则1」「规则2」有用 —— 后者还得点开弹窗才知道是什么。
export interface Rule { subject?: string; op?: string; value?: string; ci?: boolean; label?: string }
const RULE_OPS: { v: string; t: string }[] = [
  { v: "contains", t: "包含" }, { v: "not_contains", t: "不包含" },
  { v: "is", t: "等于" }, { v: "is_not", t: "不等于" },
  { v: "starts_with", t: "开头是" }, { v: "ends_with", t: "结尾是" },
  { v: "is_empty", t: "为空" }, { v: "is_not_empty", t: "不为空" },
  { v: "gt", t: "大于" }, { v: "gte", t: "≥" }, { v: "lt", t: "小于" }, { v: "lte", t: "≤" },
  { v: "matches", t: "正则匹配" }, { v: "not_matches", t: "正则不匹配" },
];
// 这两个判断只看被判断对象本身，不需要填比较值。
const NO_VALUE_OPS = ["is_empty", "is_not_empty"];
// exits=true 时每条规则多一行「走出口」——条件分支的每条规则各对应画布上一个出口，
// 名字要能填；过滤节点只有「放行/不放行」，没有出口可命名，多这一行只会让人以为它有分支。
function RulesEditor({ rules, onChange, exits }: { rules: Rule[]; onChange: (r: Rule[]) => void; exits?: boolean }) {
  const setAt = (i: number, patch: Partial<Rule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <CardList<Rule>
      rows={rules} onChange={onChange} addLabel="加一条规则"
      blank={() => ({ subject: "{query}", op: "contains", value: "", ci: true })}
      emptyText={exits ? "还没有规则。加一条之后，节点上会多出一个对应的出口。" : "还没有规则。一条都不配 = 不过滤，全部放行。"}
      tail={exits ? (
        <div className="flex items-center gap-[9px] px-[11px] py-[9px] border border-border-soft rounded-[8px] bg-rail">
          <Pill dim>兜底</Pill>
          <span className="flex-1 min-w-0 text-[12px] text-muted leading-[1.6] [text-wrap:pretty]">都没命中时走「否则」出口。这一条不能删，也不用配。</span>
        </div>
      ) : null}
      card={(r, i) => (<>
        <div className="flex items-center gap-[8px] flex-wrap">
          <Pill>{i + 1}</Pill>
          <input className={`${CELL_MONO} flex-1 basis-[150px] min-w-[110px]`} value={r.subject ?? "{query}"} placeholder="{query}"
            onChange={(e) => setAt(i, { subject: e.target.value })} />
          <select className={`${CELL} w-[110px] flex-none`} value={r.op || "contains"} onChange={(e) => setAt(i, { op: e.target.value })}>
            {RULE_OPS.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
          </select>
          {NO_VALUE_OPS.includes(r.op || "contains")
            ? <span className="flex-1 basis-[120px] text-[12px] text-faint">无需比较值</span>
            : <input className={`${CELL_MONO} flex-1 basis-[120px] min-w-[90px]`} value={r.value ?? ""} placeholder="比较值"
                onChange={(e) => setAt(i, { value: e.target.value })} />}
          <label className="flex items-center gap-[6px] flex-none whitespace-nowrap text-[12px] text-muted cursor-pointer">
            <input type="checkbox" className="accent-orange w-[13px] h-[13px] m-0" checked={r.ci === false}
              onChange={(e) => setAt(i, { ci: !e.target.checked })} />区分大小写
          </label>
        </div>
        {exits ? (
          <div className="flex items-center gap-[8px]">
            <span className="flex-none whitespace-nowrap text-[12px] text-muted">走出口</span>
            <input className={`${CELL} flex-1 min-w-0`} value={r.label ?? ""} placeholder={`留空显示「规则${i + 1}」`}
              onChange={(e) => setAt(i, { label: e.target.value })} />
          </div>
        ) : null}
      </>)}
    />
  );
}

// ── 文件条件的规则表 ──
// 字段刻意和 Conditional 的规则表不一样：那边比的是文本内容，这边比的是「这个路径是什么」。
// 混用一套字段只会让人配错（在文件条件里填一个「包含」然后期待它比文件内容）。
export interface FileRule { op?: string; value?: string; ci?: boolean; label?: string }
const FILE_OPS: { v: string; t: string; needValue: boolean }[] = [
  { v: "ext_in", t: "扩展名属于", needValue: true },
  { v: "is_dir", t: "是文件夹", needValue: false },
  { v: "is_file", t: "是文件", needValue: false },
  { v: "not_exists", t: "路径不存在", needValue: false },
  { v: "name_contains", t: "文件名包含", needValue: true },
  { v: "path_contains", t: "完整路径包含", needValue: true },
];
function FileRulesEditor({ rules, onChange }: { rules: FileRule[]; onChange: (r: FileRule[]) => void }) {
  const setAt = (i: number, patch: Partial<FileRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <CardList<FileRule>
      rows={rules} onChange={onChange} addLabel="加一条规则"
      blank={() => ({ op: "ext_in", value: "", ci: true })}
      emptyText="还没有规则。加一条之后，节点上会多出一个对应的出口。"
      tail={
        <div className="flex items-center gap-[9px] px-[11px] py-[9px] border border-border-soft rounded-[8px] bg-rail">
          <Pill dim>兜底</Pill>
          <span className="flex-1 min-w-0 text-[12px] text-muted leading-[1.6] [text-wrap:pretty]">都没命中时走「否则」出口。这一条不能删，也不用配。</span>
        </div>
      }
      card={(r, i) => {
        const op = FILE_OPS.find((o) => o.v === (r.op || "ext_in"));
        return (<>
          <div className="flex items-center gap-[8px] flex-wrap">
            <Pill>{i + 1}</Pill>
            <select className={`${CELL} w-[130px] flex-none`} value={r.op || "ext_in"} onChange={(e) => setAt(i, { op: e.target.value })}>
              {FILE_OPS.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
            </select>
            {op?.needValue ? (<>
              <input className={`${CELL_MONO} flex-1 basis-[150px] min-w-[110px]`} value={r.value ?? ""}
                placeholder={r.op === "ext_in" ? "png, jpg, pdf" : "要比的文本"} onChange={(e) => setAt(i, { value: e.target.value })} />
              <label className="flex items-center gap-[6px] flex-none whitespace-nowrap text-[12px] text-muted cursor-pointer">
                <input type="checkbox" className="accent-orange w-[13px] h-[13px] m-0" checked={r.ci === false}
                  onChange={(e) => setAt(i, { ci: !e.target.checked })} />区分大小写
              </label>
            </>) : <span className="flex-1 text-[12px] text-faint">无需比较值</span>}
          </div>
          <div className="flex items-center gap-[8px]">
            <span className="flex-none whitespace-nowrap text-[12px] text-muted">走出口</span>
            <input className={`${CELL} flex-1 min-w-0`} value={r.label ?? ""} placeholder={`留空显示「规则${i + 1}」`}
              onChange={(e) => setAt(i, { label: e.target.value })} />
          </div>
        </>);
      }}
    />
  );
}

// ── 简易键值表（Args & Vars 节点用来设置变量）──
// 不自己存 rows：直接由 config.vars 这个对象派生。原来存了一份本地 rows，
// 结果「弹窗取消」之后本地 rows 还留着上次编辑的内容，再打开就对不上了。
function KVEditor({ kv, onChange }: { kv: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const rows = Object.entries(kv || {}).map(([k, v]) => ({ k, v: String(v) }));
  // 空名字的行不写进配置，但要留在界面上 —— 刚点「加一个变量」时名字本来就是空的，
  // 立刻被过滤掉的话新行会当场消失。所以用一份「界面上的行」补足。
  const [extraRows, setExtra] = useState<{ k: string; v: string }[]>([]);
  const all = [...rows, ...extraRows];
  const push = (rs: { k: string; v: string }[]) => {
    const named = rs.filter((r) => r.k.trim());
    const o: Record<string, string> = {};
    for (const r of named) o[r.k.trim()] = r.v;
    setExtra(rs.filter((r) => !r.k.trim()));
    onChange(o);
  };
  return (
    <RowTable<{ k: string; v: string }>
      rows={all} onChange={push} blank={() => ({ k: "", v: "" })} addLabel="加一个变量"
      cols={[{ label: "变量名", cls: "flex-1 basis-[180px] min-w-0" }, { label: "值", cls: "flex-1 basis-[240px] min-w-0" }]}
      emptyText="还没有变量。加一个之后，下游节点就能用 {var:名称} 取到它。"
      cell={(r, i) => [
        <input key="k" className={CELL_MONO} value={r.k} placeholder="变量名"
          onChange={(e) => push(all.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />,
        <input key="v" className={CELL} value={r.v} placeholder="值（可用 {query}）"
          onChange={(e) => push(all.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />,
      ]}
    />
  );
}

// ── 节点配置弹窗 ──
// 节点配置弹窗。外壳与表单原语在 ./nodeform，这里只负责「哪个节点摆哪些字段」。
//
// 版式照 ClaudeDesign 上那份稿子：标签左置定宽 110px、说明跟在控件下方、长说明收进折叠区、
// 底栏固定「删除节点 · 取消 · 保存」。改动只在按保存后才落到工作流，关掉前会问一句。
function NodeConfig({ node, onSave, onClose, onDelete }: {
  node: WFNode;
  onSave: (c: Record<string, unknown>) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const [c, setC] = useState<Record<string, unknown>>({ ...node.config });
  const meta = TYPE_META[node.type] || { label: node.type, icon: IconFile, kind: "" };
  const set = (k: string, v: unknown) => setC((p) => ({ ...p, [k]: v }));
  const s = (k: string, d = "") => String(c[k] ?? d);
  const sub = `${KIND_LABEL[meta.kind] || ""} · ${NODE_SUB[node.type] || meta.label}`;

  return (
    <Dlg width={DLG_WIDTH[node.type] || "sm"} icon={meta.icon} title={meta.label} sub={sub}
      dirty={!sameConfig(c, node.config)} onClose={onClose} onSave={() => onSave(c)} onDelete={onDelete}>

      {/* ── 触发器 ────────────────────────────────────────────────────────── */}
      {node.type === "trigger.keyword" ? (<>
        <Row label="关键词"><input className={FLD_MONO} value={s("keyword")} onChange={(e) => set("keyword", e.target.value)} placeholder="yd" /></Row>
        <Row label="参数">
          <select className={FLD} value={s("arg", "optional")} onChange={(e) => set("arg", e.target.value)}>
            <option value="none">无参数（仅关键词）</option><option value="optional">可选参数</option><option value="required">必填参数</option>
          </select>
        </Row>
        <Row label="显示标题" last={s("arg", "optional") === "none"}>
          <input className={FLD} value={s("title")} onChange={(e) => set("title", e.target.value)} placeholder="可选，留空用工作流名" />
        </Row>
        {s("arg", "optional") !== "none" ? (
          <CheckRow last checked={c.withSpace !== false} onChange={(v) => set("withSpace", v)}>
            关键词和参数之间要有空格
            <Hint>关掉后参数紧贴关键词也认 —— <Code>cal2+2</Code>、<Code>tr你好</Code> 这类计算/转换关键词几乎都要关掉它。</Hint>
          </CheckRow>
        ) : null}
      </>) : null}

      {node.type === "trigger.hotkey" ? (
        <Row label="全局快捷键" top last>
          <HotkeyField value={s("accelerator")} onChange={(v) => set("accelerator", v)} check={api.checkAccel}
            hint="触发时把当前剪贴板文本作为参数，跑「回车」分支。" />
        </Row>
      ) : null}

      {node.type === "trigger.universal" ? (<>
        <Row label="全局快捷键" top>
          <HotkeyField value={s("accelerator")} onChange={(v) => set("accelerator", v)} check={api.checkAccel} />
        </Row>
        <Row label="抓什么" last>
          <select className={FLD} value={s("source", "auto")} onChange={(e) => set("source", e.target.value)}>
            <option value="auto">自动（有文件用文件，否则用文本）</option><option value="text">只要选中的文本</option><option value="files">只要选中的文件路径</option>
          </select>
        </Row>
        <Fold title="它是怎么抓到选区的">
          按下快捷键时先模拟一次 ⌘C 抓走当前选区，再把它当参数跑「回车」分支；抓完会把原来的剪贴板还回去。<br />
          下游还能用 <Code>{"{var:selection_type}"}</Code>（text/files）和 <Code>{"{var:selection_files}"}</Code>（每行一个路径）分开处理。<br />
          需要在「系统设置 → 隐私与安全性 → 辅助功能」里给 Umbra 授权，否则抓不到选区。
        </Fold>
      </>) : null}

      {node.type === "trigger.always" ? (
        <Blank>无需关键词，任意输入都会尝试运行下游的输入节点（计算器、单位换算这类），结果并入普通搜索。<br />
          注意它<b>不是</b>「搜不到才兜底」——每次查询都会跑一遍，所以下游的输入节点自己要能对不相干的输入返回空。</Blank>
      ) : null}

      {/* ── 输入 ──────────────────────────────────────────────────────────── */}
      {node.type === "input.scriptfilter" ? (<>
        <Row label="脚本" top>
          <textarea className={`${FLD_MONO} h-[90px] resize-y`} value={s("script")} onChange={(e) => set("script", e.target.value)} placeholder={`./runtime/txiki ./index.js "$1"`} />
          <Hint>stdout 返回 Alfred 风格 JSON（<Code>{"{items:[…]}"}</Code>），<Code>$1</Code> 是当前输入。</Hint>
        </Row>
        <Row label="运行目录"><input className={FLD_MONO} value={s("cwd")} onChange={(e) => set("cwd", e.target.value)} placeholder="可选，支持 ~；留空=工作流自己的目录" /></Row>
        <Row label="防抖" top>
          <input type="number" className={`${FLD_MONO} w-[150px]`} value={s("debounceMs", "0")} onChange={(e) => set("debounceMs", e.target.value)} />
          <Hint>毫秒，0=每敲一下就跑。不设的话打一个七字的词就是七个进程 —— 脚本一慢就把机器拖住，而前六次的结果压根没人看。脚本要联网或要跑一会儿的建议填 150–300，上限 1000。</Hint>
        </Row>
        <CheckRow last checked={!!c.alfredFilters} onChange={(v) => set("alfredFilters", v)}>由 Umbra 按输入过滤结果（否则脚本自己过滤）</CheckRow>
      </>) : null}

      {node.type === "input.listfilter" ? (<>
        <Row label="匹配方式" last>
          <select className={FLD} value={s("match", "word")} onChange={(e) => set("match", e.target.value)}>
            <option value="word">词首匹配（标题/副标题里任一词以输入开头）</option>
            <option value="contains">任意位置包含</option>
            <option value="none">不过滤（整表全部给出）</option>
          </select>
        </Row>
        <CheckRow last checked={c.learn !== false} onChange={(v) => set("learn", v)}>参与使用频率学习（常选的项会被顶到前面）</CheckRow>
        <Sec title="列表" note="拖动左侧手柄调序 · 右键行内菜单删除" />
        <ListRowsEditor rows={(c.items as ListRow[]) || []} onChange={(r) => set("items", r)} />
        <Fold title="这个节点怎么用">
          不用写脚本的 Script Filter：维护一张固定列表，按输入过滤后作为结果给出。选中某项时，它的「参数」会作为 arg 传给下游。<br />
          「参数」一栏支持 <Code>{"{query}"}</Code> / <Code>{"{var:名称}"}</Code> 等占位符；图标一栏填 emoji 或图片文件的绝对路径。
        </Fold>
      </>) : null}

      {node.type === "input.codec" ? (
        <Row label="编解码类型" top last>
          <select className={FLD} value={s("mode", "unicode")} onChange={(e) => set("mode", e.target.value)}>
            <option value="unicode">Unicode</option><option value="url">URL</option><option value="base64">Base64</option>
          </select>
          <Hint>编还是解按输入自动判断，不用分成两个节点。</Hint>
        </Row>
      ) : null}

      {node.type === "input.calc" || node.type === "input.units" ? (
        <Blank>{node.type === "input.calc" ? "输入算式即时求值（如 3*4+2）。" : "输入换算式即时换算（如 10km to mi、72f to c）。"}回车复制结果。无配置项。</Blank>
      ) : null}

      {node.type === "input.filefilter" ? (<>
        <Row label="关键词"><input className={FLD_MONO} value={s("keyword")} onChange={(e) => set("keyword", e.target.value)} placeholder="{query}" /></Row>
        <Row label="搜索目录" top>
          <textarea className={`${FLD_MONO} h-[70px] resize-y`} value={s("scopes")} onChange={(e) => set("scopes", e.target.value)} placeholder={"~/Documents\n~/Downloads"} />
          <Hint>一行一个，支持 ~。留空=全盘（仅 macOS 支持）。</Hint>
        </Row>
        <Row label="文件类型">
          <select className={FLD} value={s("kind", "any")} onChange={(e) => set("kind", e.target.value)}>
            <option value="any">全部</option><option value="folder">文件夹</option><option value="image">图片</option>
            <option value="audio">音频</option><option value="movie">视频</option><option value="pdf">PDF</option>
            <option value="text">文本</option><option value="archive">压缩包</option>
          </select>
        </Row>
        <Row label="扩展名" top>
          <input className={FLD_MONO} value={s("exts")} onChange={(e) => set("exts", e.target.value)} placeholder="png, jpg" />
          <Hint>可选，逗号分隔。和上面的类型是「且」的关系。</Hint>
        </Row>
        <Row label="最少几个字" last>
          <input type="number" className={`${FLD_MONO} w-[150px]`} value={s("minChars", "2")} onChange={(e) => set("minChars", e.target.value)} />
        </Row>
        <Fold title="搜索是怎么做的 · 选中之后能接什么">
          <b>macOS 走 Spotlight</b>（系统索引，全盘也很快，还认它索引到的各种元数据）；其它平台没有这套索引，退回「在指定目录里现走一遍」，所以<b>必须填搜索目录</b>，而且只走有限层数、有访问量上限 —— 现走全盘会把主进程卡住。<br />
          选中一条时把<b>绝对路径</b>传给下游，最常接的是「打开文件」「在文件管理器中显示」「在终端中打开」。⌘Y 可以直接预览选中的文件。
        </Fold>
      </>) : null}

      {node.type === "input.appsfilter" ? (<>
        <Row label="选中之后" last>
          <select className={FLD} value={s("action", "switch")} onChange={(e) => set("action", e.target.value)}>
            <option value="switch">切换到这个应用</option><option value="quit">退出这个应用</option>
          </select>
        </Row>
        <Fold title="为什么只列有界面的应用">
          <b>仅 macOS。</b>后台守护、输入法、菜单栏代理有几十个，混进来会把列表淹掉，而你想切换/退出的永远是有窗口的那些。<br />
          不接下游时回车按上面这个设置执行；接了下游就按下游走（这时参数是应用名）。
        </Fold>
      </>) : null}

      {node.type === "input.dict" ? (<>
        <Row label="副标题" top last>
          <input className={FLD} value={s("hint")} onChange={(e) => set("hint", e.target.value)} placeholder="在词典中查这个词" />
          <Hint>可选。不接下游时回车直接开词典；接了下游就按下游走（这时参数是那个词本身）。</Hint>
        </Row>
        <Fold title="为什么不直接把释义显示出来">
          取释义要调系统的 DictionaryServices 框架，我们这边（Node 主进程）没有可靠的调用途径。与其塞一个半残的假释义，不如老实把词送进词典 App —— 那本来也是查完词要去的地方。<b>仅 macOS。</b>
        </Fold>
      </>) : null}

      {/* ── 工具 ──────────────────────────────────────────────────────────── */}
      {node.type === "utility.args" ? (<>
        <Row label="传给下游">
          <select className={FLD} value={s("argMode", "keep")} onChange={(e) => set("argMode", e.target.value)}>
            <option value="keep">原样透传上游参数</option><option value="set">用下面的模板改写</option><option value="clear">清空参数</option>
          </select>
        </Row>
        {s("argMode", "keep") === "set" ? (
          <Row label="参数模板" top last>
            <input className={FLD_MONO} value={s("text")} onChange={(e) => set("text", e.target.value)} placeholder="{query}" />
            <Hint>留空则等同于原样透传。</Hint>
          </Row>
        ) : null}
        <Sec title="变量" note="对本节点之后的下游可见" />
        <KVEditor kv={(c.vars as Record<string, string>) || {}} onChange={(v) => set("vars", v)} />
        <Fold title="可用占位符" count="5 个" open>
          <CodeRow code="{query}">上游节点传来的参数</CodeRow>
          <CodeRow code="{var:名称}">上面表里的变量</CodeRow>
          <CodeRow code="{clipboard}">剪贴板当前内容</CodeRow>
          <CodeRow code="{date}">日期，默认 YYYY-MM-DD，可写 {"{date:YYYY年MM月DD日 ddd}"}</CodeRow>
          <CodeRow code="{random}">随机数，可写 {"{random:1-100}"} / {"{random:uuid}"} / {"{random:hex8}"}</CodeRow>
          <div className="text-[11.5px] text-faint mt-[8px]">工作流里所有文本框通用，不只是这个节点。</div>
        </Fold>
      </>) : null}

      {node.type === "utility.conditional" ? (<>
        <Sec title="规则" note="从上往下匹配，命中第一条就走那个出口" />
        <RulesEditor exits rules={(c.rules as Rule[]) || []} onChange={(r) => set("rules", r)} />
        <Hint>出口没连线时链路自然结束。出口名会直接显示在画布上节点的端口边。</Hint>
      </>) : null}

      {node.type === "utility.filter" ? (<>
        <Sec title="规则" note="任一条命中即放行" />
        <RulesEditor rules={(c.rules as Rule[]) || []} onChange={(r) => set("rules", r)} />
        <Hint>一条都不中就中断这条链路，下游不再执行。一条规则都不配 = 不过滤（全部放行）。</Hint>
      </>) : null}

      {node.type === "utility.fileconditional" ? (<>
        <Row label="判定哪个路径" top last>
          <input className={FLD_MONO} value={s("path")} onChange={(e) => set("path", e.target.value)} placeholder="{query}" />
          <Hint>留空=上游参数。</Hint>
        </Row>
        <Sec title="规则" note="命中第一条就走那个出口" />
        <FileRulesEditor rules={(c.rules as FileRule[]) || []} onChange={(r) => set("rules", r)} />
        <Hint>只看<b>路径本身</b>（扩展名、是不是目录、名字里有什么），不读文件内容 —— 读内容既慢又要权限，按类型分流用不着。</Hint>
      </>) : null}

      {node.type === "utility.transform" ? (<>
        <Row label="作用对象" top>
          <input className={FLD_MONO} value={s("target")} onChange={(e) => set("target", e.target.value)} placeholder="变量名，留空则改参数" />
          <Hint>留空=作用于参数 arg。</Hint>
        </Row>
        <Row label="变换方式" last>
          <select className={FLD} value={s("mode", "upper")} onChange={(e) => set("mode", e.target.value)}>
            <option value="upper">全部大写</option><option value="lower">全部小写</option><option value="title">首字母大写</option>
            <option value="trim">去掉首尾空白</option><option value="urlencode">URL 编码</option><option value="urldecode">URL 解码</option>
            <option value="base64encode">Base64 编码</option><option value="base64decode">Base64 解码</option>
            <option value="reverse">反转字符串</option><option value="deaccent">去掉重音符号（café → cafe）</option>
            <option value="alnum">只留字母数字（去标点空格）</option>
          </select>
        </Row>
        <Fold title="几个容易踩的细节">
          「反转」按字符算，emoji 和生僻字不会被劈成两半变乱码。<br />
          「只留字母数字」认中文和各国文字，不是只留 ASCII —— 只留 ASCII 会把中文内容清空，那是个静悄悄的数据丢失。
        </Fold>
      </>) : null}

      {node.type === "utility.replace" ? (<>
        <Row label="作用对象" top>
          <input className={FLD_MONO} value={s("target")} onChange={(e) => set("target", e.target.value)} placeholder="变量名，留空则改参数" />
          <Hint>留空=作用于参数 arg。</Hint>
        </Row>
        <Row label="查找"><input className={FLD_MONO} value={s("find")} onChange={(e) => set("find", e.target.value)} /></Row>
        <Row label="替换为"><input className={FLD_MONO} value={s("to")} onChange={(e) => set("to", e.target.value)} /></Row>
        <CheckRow checked={!!c.regex} onChange={(v) => set("regex", v)}>按正则表达式</CheckRow>
        <CheckRow last checked={!!c.ci} onChange={(v) => set("ci", v)}>忽略大小写</CheckRow>
      </>) : null}

      {node.type === "utility.delay" ? (
        <Row label="延时秒数" top last>
          <input className={`${FLD_MONO} w-[150px]`} type="number" min={0} max={60} step={0.5} value={Number(c.seconds ?? 1)} onChange={(e) => set("seconds", Number(e.target.value))} />
          <Hint>上限 60 秒 —— 再长的等待应该拆成两条工作流，不然一条链路会挂在这里让人以为卡死了。</Hint>
        </Row>
      ) : null}

      {node.type === "utility.debug" ? (<>
        <Row label="打点文本" top>
          <textarea className={`${FLD_MONO} h-[70px] resize-y`} value={s("text")} onChange={(e) => set("text", e.target.value)} placeholder="{query}" />
          <Hint>可用 <Code>{"{query}"}</Code>、<Code>{"{var:名称}"}</Code>、<Code>{"{variables}"}</Code>（全部变量转储）。</Hint>
        </Row>
        <Row label="打完之后" last>
          <select className={FLD} value={s("after", "pass")} onChange={(e) => set("after", e.target.value)}>
            <option value="pass">把入参原样传给下游（默认）</option>
            <option value="replace">把打点文本作为下游参数</option>
          </select>
        </Row>
        <CheckRow last checked={!!c.clear} onChange={(v) => set("clear", v)}>
          执行到这里时先清空本工作流的调试记录
          <Hint>文本会出现在顶栏「调试」抽屉里这个节点下面，和脚本输出同一个位置。变量名里带 key/token/password 这类词的值会自动打码。</Hint>
        </CheckRow>
      </>) : null}

      {node.type === "utility.split" ? (<>
        <Row label="按什么拆">
          <div className="flex gap-[8px]">
            <select className={FLD} value={s("with", "comma")} onChange={(e) => set("with", e.target.value)}>
              <option value="comma">逗号 ,</option><option value="space">空格</option><option value="tab">制表符 Tab</option><option value="newline">换行</option>
              <option value="custom">自定义…</option>
            </select>
            {s("with", "comma") === "custom" ? (
              <input className={FLD_MONO} value={s("custom")} onChange={(e) => set("custom", e.target.value)} placeholder="如 ; 或 \n" />
            ) : null}
          </div>
        </Row>
        <CheckRow checked={c.trim !== false} onChange={(v) => set("trim", v)}>去掉每一项两端的空白</CheckRow>
        <CheckRow checked={!!c.discardEmpty} onChange={(v) => set("discardEmpty", v)}>丢掉空项</CheckRow>
        <Row label="输出方式" top last={s("output", "vars") === "args"}>
          <select className={FLD} value={s("output", "vars")} onChange={(e) => set("output", e.target.value)}>
            <option value="vars">写成变量（参数原样传给下游）</option>
            <option value="args">作为参数列表（下游逐条执行一遍）</option>
          </select>
          {s("output", "vars") === "args" ? (
            <Hint>下游会按拆出的每一项各跑一遍，串行且保持原顺序；末端接一个「Join 合并参数」就能再并回一条。一次最多 200 项，超出部分会被丢弃。</Hint>
          ) : null}
        </Row>
        {s("output", "vars") !== "args" ? (
          <Row label="变量前缀" top last>
            <input className={FLD_MONO} value={s("prefix")} onChange={(e) => set("prefix", e.target.value)} placeholder="split" />
            <Hint>拆出的项写成 <Code>{`{var:${s("prefix", "split") || "split"}1}`}</Code>、<Code>{`{var:${s("prefix", "split") || "split"}2}`}</Code>…
              另有 <Code>{`{var:${s("prefix", "split") || "split"}Count}`}</Code> 记总项数；参数本身不变。</Hint>
          </Row>
        ) : null}
      </>) : null}

      {node.type === "utility.join" ? (
        <Row label="用什么连接" top last>
          <div className="flex gap-[8px]">
            <select className={FLD} value={s("with", "newline")} onChange={(e) => set("with", e.target.value)}>
              <option value="comma">逗号 ,</option><option value="space">空格</option><option value="tab">制表符 Tab</option><option value="newline">换行</option>
              <option value="custom">自定义…</option>
            </select>
            {s("with", "newline") === "custom" ? (
              <input className={FLD_MONO} value={s("custom")} onChange={(e) => set("custom", e.target.value)} placeholder="如 ; 或 \n" />
            ) : null}
          </div>
          <Hint>把上游「Split 拆分参数（参数列表）」扇出的多条参数收集起来，等最后一项到齐后连成一条再往下传。上游不是这种扇出时（只有单项），入参原样透传。</Hint>
        </Row>
      ) : null}

      {node.type === "utility.dialog" ? (<>
        <Row label="问句" top>
          <input className={FLD} value={s("title")} onChange={(e) => set("title", e.target.value)} placeholder="确定要继续吗？" />
          <Hint>消息框里的主文案。可用 <Code>{"{query}"}</Code> 把上游参数带进去。留空用工作流名。</Hint>
        </Row>
        <Row label="说明" top>
          <textarea className={`${FLD} h-[60px] resize-y`} value={s("text")} onChange={(e) => set("text", e.target.value)}
            placeholder="可选，写在问句下面的小字" />
        </Row>
        <Row label="图标" last>
          <select className={FLD} value={s("kind", "none")} onChange={(e) => set("kind", e.target.value)}>
            <option value="none">无</option><option value="info">信息</option>
            <option value="warning">警告</option><option value="error">错误</option>
          </select>
        </Row>
        <Sec title="按钮" note={`${dialogButtons(c).length} / ${DIALOG_MAX_BUTTONS} · 顺序即出口顺序`} />
        <RowTable<string>
          rows={(Array.isArray(c.buttons) ? (c.buttons as string[]) : [])}
          onChange={(b) => set("buttons", b)}
          blank={dialogButtons(c).length < DIALOG_MAX_BUTTONS ? () => "" : undefined}
          addLabel="加一个按钮"
          cols={[{ label: "按钮文字", cls: "flex-1 min-w-0" }]}
          emptyText="没配按钮时用默认的「取消 / 继续」两个。"
          cell={(b, i) => [
            <input key="b" className={CELL} value={b} placeholder={`按钮${i + 1}`}
              onChange={(e) => set("buttons", (c.buttons as string[]).map((x, j) => (j === i ? e.target.value : x)))} />,
          ]}
        />
        <Row label="默认按钮" top>
          <select className={FLD} value={String(c.defaultIndex ?? dialogButtons(c).length - 1)} onChange={(e) => set("defaultIndex", Number(e.target.value))}>
            {dialogButtons(c).map((b, i) => <option key={i} value={i}>{b}</option>)}
          </select>
          <Hint>回车直接选它。</Hint>
        </Row>
        <Row label="取消按钮" top last>
          <select className={FLD} value={String(c.cancelIndex ?? 0)} onChange={(e) => set("cancelIndex", Number(e.target.value))}>
            {dialogButtons(c).map((b, i) => <option key={i} value={i}>{b}</option>)}
          </select>
          <Hint>按 Esc 或点关闭，等同于点了它。</Hint>
        </Row>
        <Note>调整按钮顺序会跟着改出口顺序 —— 已经连好的线还挂在原来的位置上，换过顺序记得回画布上核对一遍。</Note>
        <Fold title="几个刻意定下来的规则">
          <b>弹框前会先收起快捷入口面板。</b>面板是常驻最前的浮层，不收的话消息框会被它盖住 ——
          于是弹了一个看不见的框在等人点，链路卡住而界面上毫无迹象。<br />
          <b>最多三个按钮</b>（和 Alfred 一致）：macOS 的消息框超过三个会改成竖排堆叠，又难看又分不清默认键。<br />
          <b>Esc 等同于点「取消按钮」那一路</b>。系统消息框只回一个按钮下标，分辨不出「按了 Esc」和「点了取消」——
          与其猜，不如把规则定死。想让「取消」什么都不做，就把那个出口空着不连线。<br />
          下游可以用 <Code>{"{var:dialog_button}"}</Code> 拿到用户点的按钮文字；参数本身原样透传。
        </Fold>
      </>) : null}
      {node.type === "utility.junction" ? (
        <Blank>纯理线用的中转点：多条连线先并到这里，再从这里出一条到下游，画布上就不用画一把交叉的线。<br />
          参数、变量、出口一律原样透传，它不改任何数据，也没有配置项。</Blank>
      ) : null}

      {node.type === "utility.random" ? (<>
        <Row label="生成什么">
          <select className={FLD} value={s("mode", "range")} onChange={(e) => set("mode", e.target.value)}>
            <option value="range">整数（指定范围）</option><option value="uuid">UUID</option>
            <option value="hex">十六进制串</option><option value="str">字母数字随机串</option>
            <option value="list">从列表里随机取一项</option>
          </select>
        </Row>
        {s("mode", "range") === "list" ? (
          <Row label="列表" top>
            <textarea className={`${FLD} h-[80px] resize-y`} value={s("list")} onChange={(e) => set("list", e.target.value)} placeholder={"面\n饭\n沙拉"} />
            <Hint>一行一项，支持占位符，所以列表本身也能是动态的。</Hint>
          </Row>
        ) : null}
        {s("mode", "range") === "range" ? (
          <Row label="范围">
            <div className="flex items-center gap-[8px]">
              <input type="number" className={FLD_MONO} value={String(c.min ?? 1)} onChange={(e) => set("min", e.target.value)} />
              <span className="flex-none text-[12px] text-faint">到</span>
              <input type="number" className={FLD_MONO} value={String(c.max ?? 100)} onChange={(e) => set("max", e.target.value)} />
            </div>
          </Row>
        ) : null}
        {["hex", "str"].includes(s("mode", "range")) ? (
          <Row label="长度">
            <input type="number" className={`${FLD_MONO} w-[150px]`} value={String(c.length ?? 8)} onChange={(e) => set("length", e.target.value)} />
          </Row>
        ) : null}
        <Row label="写到哪里" top last>
          <input className={FLD_MONO} value={s("target")} onChange={(e) => set("target", e.target.value)} placeholder="变量名，留空则改参数" />
          <Hint>和占位符 <Code>{"{random}"}</Code> 是同一套实现。只想在某个文本里插一个随机数的话直接写占位符更省事；这个节点适合「先生成、后面多处引用」。</Hint>
        </Row>
      </>) : null}

      {node.type === "utility.jsonconfig" ? (<>
        <Row label="JSON" top last>
          <textarea className={`${FLD_MONO} h-[110px] resize-y`} value={s("json")} onChange={(e) => set("json", e.target.value)}
            placeholder={'{\n  "api": "https://example.com",\n  "keyword": "{query}"\n}'} />
          <Hint>最外层是一个对象，键=变量名。一次设置多个变量，省得摆一排「参数与变量」。</Hint>
        </Row>
        <Fold title="包裹写法：改参数、改下游节点配置">
          除了上面这种裸对象，还认 Alfred 的包裹写法：<br />
          <Code>{'{"alfredworkflow":{"arg":…,"variables":{…},"config":{…}}}'}</Code><br />
          其中 <Code>config</Code> 会<b>临时改写紧接着的下游节点</b>的配置字段（比如按变量决定「打开网址」去哪个地址）—— 这才是它叫 Config 的由来。只对这一次执行生效，不会写回保存的配置，也只往下影响一层。
        </Fold>
        <Fold title="解析与替换的顺序">
          值里可以用 <Code>{"{query}"}</Code> / <Code>{"{var:名称}"}</Code> 等占位符，替换在<b>解析之后</b>做，所以值里带引号和换行都不会撑坏 JSON。<br />
          值不是字符串时（数字、布尔、嵌套对象）会转成字符串存 —— 变量表只存字符串。<br />
          JSON 不合法会中断链路并提示，不会带着半份变量往下跑。
        </Fold>
      </>) : null}

      {node.type === "utility.hide" ? (
        <Blank>执行到这里先把快捷入口面板收起来，再继续跑下游。<br />
          典型用法：下游要打开一个窗口或者发按键，不先收面板的话，新窗口会被面板挡住、按键也会发给面板自己。<br />
          收起时会把焦点还给刚才那个应用。无配置项。</Blank>
      ) : null}

      {node.type === "utility.show" ? (
        <Blank>把快捷入口面板重新唤起，和「隐藏主面板」配套用：中间去干点活，干完把面板叫回来接着挑下一项。<br />
          重新唤起的是空的搜索框（不恢复上一次的输入）。无配置项。</Blank>
      ) : null}

      {/* ── 动作 ──────────────────────────────────────────────────────────── */}
      {node.type === "action.launch" ? (<>
        <CheckRow last checked={!!c.toggleVisibility} onChange={(v) => set("toggleVisibility", v)}>切换可见性：若某 App 已在前台则隐藏它</CheckRow>
        <Sec title="要启动的 App / 文件" note="双击某行编辑路径" />
        <LaunchList paths={(c.paths as string[]) || []} onChange={(p) => set("paths", p)} />
      </>) : null}

      {node.type === "action.openfile" ? (<>
        <Row label="路径" top>
          <PickField mono value={s("path")} onChange={(v) => set("path", v)} onPick={async () => { const p = await api.pickPath(); if (p) set("path", p); }}
            placeholder="{query} 或固定路径（支持 ~）" />
          <Hint>多行路径会逐个打开 —— 上游接「文件暂存区」取出模式时给的就是多行。</Hint>
        </Row>
        <Row label="用哪个应用" top last>
          <PickField value={s("app")} onChange={(v) => set("app", v)} onPick={async () => { const a = await api.pickApp(); if (a) set("app", a); }}
            placeholder="留空=系统默认应用" btn="选 App" />
          <Hint>指定了应用时多个文件会用一条命令一起打开，不会开出好几个实例。</Hint>
        </Row>
      </>) : null}

      {node.type === "action.openurl" ? (<>
        <Row label="网址" top>
          <input className={FLD_MONO} value={s("url")} onChange={(e) => set("url", e.target.value)} placeholder="https://example.com/?q={query}" />
          <Hint><Code>{"{query}"}</Code> 是上游参数。</Hint>
        </Row>
        <Row label="用哪个浏览器" last>
          <PickField value={s("browser")} onChange={(v) => set("browser", v)} onPick={async () => { const a = await api.pickApp(); if (a) set("browser", a); }}
            placeholder="留空=系统默认" />
        </Row>
      </>) : null}

      {node.type === "action.script" ? (<>
        <Row label="语言">
          <select className={FLD} value={s("language", "bash")} onChange={(e) => set("language", e.target.value)}>
            <option value="bash">bash</option><option value="zsh">zsh</option>
            <option value="python3">Python 3</option><option value="ruby">Ruby</option>
            <option value="node">Node.js</option><option value="osascript">AppleScript（osascript）</option>
          </select>
        </Row>
        <Row label="脚本" top>
          <textarea className={`${FLD_MONO} h-[88px] resize-y`} value={s("script")} onChange={(e) => set("script", e.target.value)} placeholder={`say "$1"`} />
          <Hint>上游参数写作 <Code>{"{query}"}</Code>，也能从 <Code>$1</Code> / 环境变量 <Code>query</Code> 取。</Hint>
        </Row>
        <Row label="运行目录">
          <PickField mono value={s("cwd")} onChange={(v) => set("cwd", v)} onPick={async () => { const p = await api.pickPath(); if (p) set("cwd", p); }}
            placeholder="留空=工作流自己的目录" btn="选目录" />
        </Row>
        <Row label="stdout 处理">
          <select className={FLD} value={s("output", "none")} onChange={(e) => set("output", e.target.value)}>
            <option value="none">忽略（继续传给下游）</option><option value="copy">复制到剪贴板</option>
          </select>
        </Row>
        <Row label="脚本失败时" last>
          <select className={FLD} value={s("onError", "stop")} onChange={(e) => set("onError", e.target.value)}>
            <option value="stop">停止这条链路（默认）</option>
            <option value="continue">忽略错误继续往下走</option>
            <option value="branch">走「失败」出口（节点上会多一个红色端口）</option>
          </select>
        </Row>
        <Fold title="各语言怎么取参数 · shebang 为什么会报错">
          bash/zsh 用 <Code>$1</Code>，Python 用 <Code>sys.argv[1]</Code>，Ruby 用 <Code>ARGV[0]</Code>，Node 用 <Code>process.argv[1]</Code>。环境变量 <Code>query</Code> 在哪种语言里都读得到。<br />
          脚本首行的 shebang 和这里选的语言不一致时会直接报错停下 —— bash 会把 <Code>#!/usr/bin/env python3</Code> 当注释忽略，然后拿 bash 去解释 Python，报出来的错完全指不到真正的原因。<br />
          脚本还可以输出 Alfred 风格的 JSON（<Code>{"{alfredworkflow:{arg,variables}}"}</Code>）来改写下游参数与变量。
        </Fold>
      </>) : null}

      {node.type === "action.applescript" ? (<>
        <Row label="脚本" top>
          <textarea className={`${FLD_MONO} h-[110px] resize-y`} value={s("script")} onChange={(e) => set("script", e.target.value)}
            placeholder={'tell application "Finder" to activate'} />
          <Hint>可用 <Code>{"{query}"}</Code> / <Code>{"{var:名称}"}</Code>。</Hint>
        </Row>
        <Row label="返回值">
          <select className={FLD} value={s("output", "replace")} onChange={(e) => set("output", e.target.value)}>
            <option value="replace">作为参数传给下游（默认）</option>
            <option value="none">忽略（参数原样传给下游）</option>
            <option value="copy">复制到剪贴板</option>
          </select>
        </Row>
        <Row label="脚本失败时" last>
          <select className={FLD} value={s("onError", "stop")} onChange={(e) => set("onError", e.target.value)}>
            <option value="stop">停止这条链路（默认）</option><option value="continue">忽略错误继续往下走</option>
          </select>
        </Row>
        <Fold title="几个实现上的取舍">
          <b>仅 macOS</b>，别的平台上会直接提示不可用并停下，不会静默什么都不做。<br />
          脚本经标准输入送给 osascript，所以正文里带引号、换行、中文都没问题。超时 20 秒 —— AppleScript 要么秒回，要么就是弹了个框在等人。<br />
          返回值为空时会保留原参数：AppleScript 很多时候本来就不返回东西，冲成空串会让下游莫名其妙拿不到值。
        </Fold>
      </>) : null}

      {node.type === "action.terminal" ? (<>
        <Row label="命令" top>
          <textarea className={`${FLD_MONO} h-[70px] resize-y`} value={s("command")} onChange={(e) => set("command", e.target.value)} placeholder={"cd ~/Downloads && ls -la"} />
          <Hint><Code>{"{query}"}</Code> 是上游参数。</Hint>
        </Row>
        <Row label="用哪个终端" last>
          <select className={FLD} value={s("app", "Terminal")} onChange={(e) => set("app", e.target.value)}>
            <option value="Terminal">Terminal（系统自带）</option><option value="iTerm">iTerm</option>
          </select>
        </Row>
        <Note>下游收到的是<b>透传的上游参数</b>，不是命令的输出 —— 终端在另一个进程里，我们取不到它的输出。要拿输出请用「跑脚本」。</Note>
        <Fold title="为什么只支持这两个终端">
          「把命令打进终端窗口」在不同终端里要用各自的 AppleScript 方言，没法一套通吃。Terminal 是系统自带（一定有），iTerm 是最常见的替代品。填别的会明确报错，而不是静默开一个空窗口。<b>仅 macOS。</b>
        </Fold>
      </>) : null}

      {node.type === "action.websearch" ? (<>
        <Row label="搜索引擎">
          <select className={FLD} value={s("engine", "google")} onChange={(e) => set("engine", e.target.value)}>
            <option value="google">Google（默认）</option><option value="bing">Bing</option>
            <option value="duckduckgo">DuckDuckGo</option><option value="baidu">百度</option>
            <option value="github">GitHub</option><option value="wikipedia">维基百科</option>
            <option value="custom">自定义地址…</option>
          </select>
        </Row>
        {s("engine", "google") === "custom" ? (
          <Row label="地址模板" top>
            <input className={FLD_MONO} value={s("custom")} onChange={(e) => set("custom", e.target.value)} placeholder="https://example.com/search?q={query}" />
            <Hint>必须含 <Code>{"{query}"}</Code> 占位符，否则搜什么都跳同一个页面。</Hint>
          </Row>
        ) : null}
        <Row label="搜什么" top>
          <input className={FLD_MONO} value={s("query")} onChange={(e) => set("query", e.target.value)} placeholder="{query}" />
          <Hint>可以拼前后缀，比如 <Code>{"{query} language:ts"}</Code>。关键词会自动做 URL 编码，中文和空格都不用自己处理。</Hint>
        </Row>
        <Row label="用哪个浏览器" top last>
          <PickField value={s("browser")} onChange={(v) => set("browser", v)} onPick={async () => { const a = await api.pickApp(); if (a) set("browser", a); }}
            placeholder="留空=系统默认" />
          <Hint>引擎是挂在这个节点上的，不是全局设置 —— 一条工作流搜 GitHub、另一条搜百度是常态。</Hint>
        </Row>
      </>) : null}

      {node.type === "action.reveal" ? (
        <Row label="要定位的路径" top last>
          <PickField mono value={s("path")} onChange={(v) => set("path", v)} onPick={async () => { const p = await api.pickPath(); if (p) set("path", p); }}
            placeholder="{query} 或固定路径（支持 ~）" />
          <Hint>在系统文件管理器里把窗口开到它所在的位置并选中它 —— <b>不打开文件本身</b>。路径不存在时会明确报错，不会静默打开一个空窗口。</Hint>
        </Row>
      ) : null}

      {node.type === "action.browse" ? (<>
        <Row label="要打开的目录">
          <PickField mono value={s("path")} onChange={(v) => set("path", v)} onPick={async () => { const p = await api.pickPath(); if (p) set("path", p); }}
            placeholder="{query} 或固定路径（支持 ~）" />
        </Row>
        <Row label="用哪个终端" top last>
          <input className={FLD} value={s("app")} onChange={(e) => set("app", e.target.value)} placeholder="Terminal（也可填 iTerm、Warp…）" />
          <Hint><b>仅 macOS。</b>给的是文件就自动取它所在的目录 —— 说「在终端里打开这个」时想要的几乎总是所在目录，拿文件路径当工作目录只会失败。</Hint>
        </Row>
      </>) : null}

      {node.type === "action.filebuffer" ? (<>
        <Row label="这个节点做什么" last={s("mode", "add") === "clear"}>
          <select className={FLD} value={s("mode", "add")} onChange={(e) => set("mode", e.target.value)}>
            <option value="add">收：把上游的路径攒进暂存区</option>
            <option value="list">取：把攒的全部交给下游（换行分隔）</option>
            <option value="clear">清空暂存区</option>
          </select>
        </Row>
        {s("mode", "add") === "add" ? (
          <Row label="收哪些路径" top last>
            <input className={FLD_MONO} value={s("path")} onChange={(e) => set("path", e.target.value)} placeholder="{query}" />
            <Hint>多条用换行分隔。收之前会确认文件真的在，不存在的会被跳过并报出数量。</Hint>
          </Row>
        ) : null}
        {s("mode", "add") === "list" ? (
          <CheckRow last checked={c.clearAfter !== false} onChange={(v) => set("clearAfter", v)}>取出后清空暂存区</CheckRow>
        ) : null}
        <Fold title="暂存区存在哪、活多久">
          按「工作流 + 节点」分桶，<b>只在内存里，退出即清空</b> —— 它是「这几分钟挑几个文件一起处理」的临时篮子，不是长期收藏夹。重复路径会自动去重，最多攒 200 个。<br />
          典型用法：一个工作流按「收」把文件一个个加进来，另一个工作流按「取」一次性处理掉。
        </Fold>
      </>) : null}

      {node.type === "action.ask_assistant" ? (<>
        <Row label="发给秘书的" top>
          <textarea className={`${FLD} h-[70px] resize-y`} value={s("prompt")} onChange={(e) => set("prompt", e.target.value)} placeholder="{query}" />
          <Hint><Code>{"{query}"}</Code> 是上游参数。秘书的回复会作为参数继续传给下游节点。</Hint>
        </Row>
        <Row label="文本视图标题"><input className={FLD} value={s("title")} onChange={(e) => set("title", e.target.value)} placeholder="可选，如「秘书」" /></Row>
        <CheckRow last checked={c.show !== false} onChange={(v) => set("show", v)}>打开文本视图展示（等待期间显示加载动画）</CheckRow>
      </>) : null}

      {node.type === "action.create_task" ? (<>
        <Row label="任务内容" top>
          <textarea className={`${FLD} h-[60px] resize-y`} value={s("text")} onChange={(e) => set("text", e.target.value)} placeholder="{query}" />
          <Hint><Code>{"{query}"}</Code> 是上游参数。</Hint>
        </Row>
        <Row label="前缀" top last>
          <input className={FLD} value={s("prefix")} onChange={(e) => set("prefix", e.target.value)} placeholder="帮我建个任务：" />
          <Hint>服务端目前没有独立的建任务接口，这里是「发给秘书 + 建任务前缀」的薄封装，真正建任务由秘书调工具完成。</Hint>
        </Row>
      </>) : null}

      {node.type === "action.device_skill" ? (<>
        <Row label="设备 ID" top>
          <input className={FLD_MONO} value={s("device")} onChange={(e) => set("device", e.target.value)} placeholder="留空自动选择" />
          <Hint>留空=自动挑一台有该技能的在线设备。</Hint>
        </Row>
        <Row label="技能">
          <div className="flex items-center gap-[8px]">
            <input className={FLD_MONO} value={s("provider")} onChange={(e) => set("provider", e.target.value)} placeholder="provider，如 pc" />
            <span className="flex-none text-[12px] text-faint">.</span>
            <input className={FLD_MONO} value={s("skill")} onChange={(e) => set("skill", e.target.value)} placeholder="skill 名" />
          </div>
        </Row>
        <Row label="参数" top last>
          <textarea className={`${FLD_MONO} h-[70px] resize-y`} value={s("params")} onChange={(e) => set("params", e.target.value)} placeholder={`{"text": "{query}"}`} />
          <Hint>JSON。<Code>{"{query}"}</Code> / <Code>{"{var:名称}"}</Code> 会按 JSON 字符串转义后插入。执行结果作为参数继续传给下游；派发失败会中止链路。</Hint>
        </Row>
      </>) : null}

      {/* ── 自动化 ────────────────────────────────────────────────────────── */}
      {node.type === "automation.shortcut" ? (<>
        <Row label="快捷指令名称" top>
          <input className={FLD} value={s("name")} onChange={(e) => set("name", e.target.value)} placeholder="例如：整理下载文件夹" />
          <Hint>要和「快捷指令」App 里完全一致。</Hint>
        </Row>
        <Row label="它的输出" last={String(c.output || "none") === "replace"}>
          <select className={FLD} value={s("output", "none")} onChange={(e) => set("output", e.target.value)}>
            <option value="none">忽略（参数原样传给下游）</option><option value="replace">作为参数传给下游</option>
          </select>
        </Row>
        <CheckRow last={s("output", "none") === "replace"} checked={c.input !== false} onChange={(v) => set("input", v)}>把上游参数作为输入传给它</CheckRow>
        {s("output", "none") !== "replace" ? (
          <CheckRow last checked={c.wait !== false} onChange={(v) => set("wait", v)}>
            等它跑完再继续
            <Hint>不勾就是发出去立刻往下走，适合要跑好几分钟的整理类指令。</Hint>
          </CheckRow>
        ) : null}
        <Fold title="传参方式与几个边界">
          <b>需要 macOS 12 及以上</b>（用系统自带的 shortcuts 命令），找不到该命令时会明确提示。<br />
          参数经标准输入传入、结果从标准输出取回，不落临时文件。超时 2 分钟 —— 快捷指令可能真要跑一会儿。<br />
          不勾「传入输入」时连输入通道都不开：有些快捷指令收到空输入会走另一条分支。<br />
          要拿返回值就必须等，所以选了「作为参数传给下游」时「等它跑完」这个开关不出现 —— 否则会拿到一个空参数还以为成功了。
        </Fold>
      </>) : null}

      {node.type === "automation.system" ? (<>
        <Row label="命令" last>
          <select className={FLD} value={s("command", "lock")} onChange={(e) => set("command", e.target.value)}>
            <option value="lock">锁定屏幕</option><option value="sleep">睡眠</option>
            <option value="screensaver">启动屏保</option><option value="emptytrash">清空废纸篓</option>
            <option value="hideothers">隐藏其它应用</option><option value="logout">注销当前用户</option>
          </select>
        </Row>
        <CheckRow last checked={c.confirm === true} onChange={(v) => set("confirm", v)}>执行前弹确认框</CheckRow>
        {["logout", "emptytrash"].includes(s("command", "lock")) && c.confirm !== true ? (
          <Note>这一条不可逆，而绑了热键之后最容易误触。建议勾上确认框 —— 点「取消」算正常结束，不报错。</Note>
        ) : null}
        <Fold title="为什么没有关机和重启">
          <b>仅 macOS。</b>关机重启这类工作流误触的代价太大，刻意没有收录。<br />
          「清空废纸篓」本身还会再弹一次系统自己的确认框，不会无声删掉东西。
        </Fold>
      </>) : null}

      {node.type === "automation.music" ? (<>
        <Row label="动作" last={s("command", "playpause") !== "volume"}>
          <select className={FLD} value={s("command", "playpause")} onChange={(e) => set("command", e.target.value)}>
            <option value="playpause">播放 / 暂停</option><option value="play">播放</option><option value="pause">暂停</option>
            <option value="next">下一首</option><option value="previous">上一首</option>
            <option value="volume">设置音量</option>
            <option value="now">当前播放（把「歌名 — 歌手」传给下游）</option>
          </select>
        </Row>
        {s("command", "playpause") === "volume" ? (
          <Row label="音量" last>
            <input type="number" className={`${FLD_MONO} w-[150px]`} value={String(c.volume ?? 50)} onChange={(e) => set("volume", e.target.value)} placeholder="0–100" />
          </Row>
        ) : null}
        <Fold title="失败时会看到什么">
          <b>仅 macOS</b>，控制的是系统「音乐」App。最常见的失败是音乐 App 没开着 —— 这时会把系统原话带出来，不自己编一句模糊的提示。
        </Fold>
      </>) : null}

      {/* ── 输出 ──────────────────────────────────────────────────────────── */}
      {node.type === "output.notify" ? (<>
        <Row label="标题" top>
          <input className={FLD} value={s("title")} onChange={(e) => set("title", e.target.value)} placeholder="{query} / 固定文字都行" />
          <Hint>留空=用工作流名。</Hint>
        </Row>
        <Row label="正文" top>
          <textarea className={`${FLD} h-[60px] resize-y`} value={s("text")} onChange={(e) => set("text", e.target.value)} placeholder="{query}" />
          <Hint>留空=直接用上游参数。</Hint>
        </Row>
        <Row label="正文为空时" top last>
          <select className={FLD} value={s("ifEmpty", "skip")} onChange={(e) => set("ifEmpty", e.target.value)}>
            <option value="skip">不弹通知（默认）</option><option value="show">照样弹一个空通知</option>
          </select>
          <Hint>上游脚本没输出、条件没命中却接了通知 —— 这时弹一个什么都没有的框最招人烦，所以默认跳过。跳过算正常结束，链路继续往下走。</Hint>
        </Row>
      </>) : null}

      {node.type === "output.textview" ? (<>
        <Row label="标题" last><input className={FLD} value={s("title")} onChange={(e) => set("title", e.target.value)} placeholder="可选，留空用工作流名" /></Row>
        <CheckRow checked={c.markdown !== false} onChange={(v) => set("markdown", v)}>按 Markdown 渲染</CheckRow>
        <CheckRow last checked={!!c.append} onChange={(v) => set("append", v)}>追加到已有内容（流式续写，不清屏）</CheckRow>
      </>) : null}

      {node.type === "output.writefile" ? (<>
        <Row label="文件名 / 路径" top>
          <input className={FLD_MONO} value={s("path")} onChange={(e) => set("path", e.target.value)} placeholder="notes-{date}.md" />
          <Hint>支持 ~ 与 <Code>{"{query}"}</Code>、<Code>{"{date}"}</Code> 等占位符。填相对路径就写到本工作流的 data 目录里（脚本读得到，整包拷走时也跟着走）；要放别处就写绝对路径。</Hint>
        </Row>
        <Row label="内容" top>
          <textarea className={`${FLD_MONO} h-[70px] resize-y`} value={s("content")} onChange={(e) => set("content", e.target.value)} placeholder="{query}" />
        </Row>
        <Row label="已存在时" last>
          <select className={FLD} value={s("ifExists", "overwrite")} onChange={(e) => set("ifExists", e.target.value)}>
            <option value="overwrite">覆盖</option><option value="append">追加到末尾</option>
            <option value="prepend">插到开头（新的在上面）</option>
            <option value="unique">另存为 名称-1.后缀</option><option value="skip">什么都不做</option>
          </select>
        </Row>
        <CheckRow checked={!!c.uuid} onChange={(v) => set("uuid", v)}>文件名后加一段 UUID（每次都是新文件）</CheckRow>
        <CheckRow checked={c.mkdirs !== false} onChange={(v) => set("mkdirs", v)}>自动创建中间目录</CheckRow>
        <CheckRow last checked={!!c.allowEmpty} onChange={(v) => set("allowEmpty", v)}>
          允许写空文件（不勾则内容为空时中止）
          <Hint>写完后，最终的绝对路径会作为参数传给下游 —— 接「打开文件」或「复制」就顺手了。</Hint>
        </CheckRow>
      </>) : null}

      {node.type === "output.keycombo" ? (<>
        <Row label="要发送的键位" top>
          <input className={FLD_MONO} value={s("accelerator")} onChange={(e) => set("accelerator", e.target.value)} placeholder="Command+Shift+K" />
          <Hint>写法和别处录快捷键一样。功能键直接写名字：Return / Tab / Space / Escape / Delete / 方向键 / F1–F12。</Hint>
        </Row>
        <Row label="连按几次" last={c.hideFirst === false}>
          <input type="number" className={`${FLD_MONO} w-[150px]`} value={String(c.repeat ?? 1)} onChange={(e) => set("repeat", e.target.value)} />
        </Row>
        {c.hideFirst !== false ? (
          <Row label="收起后等" top last>
            <input type="number" className={`${FLD_MONO} w-[150px]`} value={String(c.delayMs ?? 180)} onChange={(e) => set("delayMs", e.target.value)} />
            <Hint>毫秒。留给系统把焦点真正交还给前台应用的时间，不等的话按键会打空。</Hint>
          </Row>
        ) : null}
        <CheckRow last checked={c.hideFirst !== false} onChange={(v) => set("hideFirst", v)}>发送前先收起面板（建议开着）</CheckRow>
        <Fold title="权限、以及为什么默认要先收面板">
          <b>需要「辅助功能」权限</b>，没授权时会明确报出来，不会静默失败。<br />
          不收起面板的话，按键会发给面板自己而不是你以为的那个应用。<br />
          「连按几次」用来做 Tab 缩进三级、方向键连走这类，上限 20 次 —— 模拟按键发不出去时没有回执，发几百次只会让人以为死机了。
        </Fold>
      </>) : null}

      {node.type === "output.speak" ? (<>
        <Row label="念什么" top>
          <textarea className={`${FLD} h-[60px] resize-y`} value={s("text")} onChange={(e) => set("text", e.target.value)} placeholder="{query}" />
          <Hint><Code>{"{query}"}</Code> 是上游参数。</Hint>
        </Row>
        <Row label="音色" top>
          <input className={FLD} value={s("voice")} onChange={(e) => set("voice", e.target.value)} placeholder="如 Tingting / Samantha" />
          <Hint>可选，仅 macOS。在终端跑 <Code>say -v ?</Code> 能看全表。</Hint>
        </Row>
        <Row label="语速" top last>
          <input type="number" className={`${FLD_MONO} w-[150px]`} value={String(c.rate ?? 0)} onChange={(e) => set("rate", e.target.value)} />
          <Hint>0=系统默认。取值 50–500，超出会被夹回来。</Hint>
        </Row>
        <CheckRow last checked={!!c.wait} onChange={(v) => set("wait", v)}>
          念完再往下走
          <Hint>默认不等 —— 念一长段时不该把整条链路卡在这儿。macOS 用系统自带的 say，Windows 用 SAPI，两边都不用装东西；Linux 上会明确提示不可用。</Hint>
        </CheckRow>
      </>) : null}

      {node.type === "output.sound" ? (<>
        <Row label="系统提示音" top>
          <select className={FLD} value={s("system", "Glass")} onChange={(e) => set("system", e.target.value)}>
            {["Glass", "Ping", "Pop", "Purr", "Submarine", "Basso", "Blow", "Bottle", "Frog", "Funk", "Hero", "Morse", "Sosumi", "Tink"].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <Hint>macOS 自带，在 <Code>/System/Library/Sounds</Code> 里。不填下面的文件时用这个。</Hint>
        </Row>
        <Row label="自定义声音" top last>
          <PickField mono value={s("path")} onChange={(v) => set("path", v)} onPick={async () => { const p = await api.pickPath(); if (p) set("path", p); }}
            placeholder="可选，支持 ~" />
          <Hint>文件不存在时会明确报错停下，而不是静悄悄地什么都没响（那种最难查）。</Hint>
        </Row>
        <Fold title="它永远不等声音放完">
          macOS 用 afplay，Windows 用 SoundPlayer，<b>一律不等它放完</b> —— 提示音的意义就是不打断流程。
        </Fold>
      </>) : null}

      {["action.copy", "action.paste", "action.assistant", "action.inspiration", "output.largetype"].includes(node.type) ? (
        <Blank>{node.type === "output.largetype"
          ? "把上游内容放大居中显示在半透明浮层里。"
          : "此动作无需额外配置，直接使用上游传入的内容（arg）。"}</Blank>
      ) : null}
    </Dlg>
  );
}

// ── List Filter 的列表编辑（E?）：一行一项，支持 CSV 批量导入 ──
// CSV 解析自己写：只需要认「逗号分隔 + 双引号包裹（内部 "" 转义）+ 换行」这几样，
// 为这点需求引一个库不划算。返回二维数组，空行跳过。
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = (text || "").replace(/\r\n?/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); cell = ""; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

interface ListRow { title?: string; subtitle?: string; arg?: string; icon?: string }

function ListRowsEditor({ rows, onChange }: { rows: ListRow[]; onChange: (r: ListRow[]) => void }) {
  const [csv, setCsv] = useState("");
  const [importing, setImporting] = useState(false);
  const setAt = (i: number, k: keyof ListRow, v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const doImport = (replace: boolean) => {
    // 每行按 [标题, 副标题, 参数, 图标] 取，只有一列时参数留空（执行时自动回落成标题）。
    const parsed = parseCsv(csv).map((r) => ({ title: (r[0] || "").trim(), subtitle: (r[1] || "").trim(), arg: (r[2] || "").trim(), icon: (r[3] || "").trim() }))
      .filter((r) => r.title || r.arg);
    if (!parsed.length) return;
    onChange(replace ? parsed : [...rows, ...parsed]);
    setCsv(""); setImporting(false);
  };
  return (
    <RowTable<ListRow>
      rows={rows} onChange={onChange} blank={() => ({ title: "", subtitle: "", arg: "" })} addLabel="加一项"
      scroll="max-h-[260px] overflow-y-auto"
      cols={[
        { label: "图标", cls: "w-[40px] flex-none" },
        { label: "标题", cls: "flex-1 min-w-0" },
        { label: "副标题", cls: "flex-1 min-w-0" },
        { label: "参数", cls: "flex-1 min-w-0" },
      ]}
      emptyText="还没有条目。加一条之后，这个节点才会出结果。"
      cell={(r, i) => [
        <input key="i" className={`${CELL} text-center px-[4px]`} value={String(r.icon || "")} onChange={(e) => setAt(i, "icon", e.target.value)} placeholder="🔹" />,
        <input key="t" className={CELL} value={String(r.title || "")} onChange={(e) => setAt(i, "title", e.target.value)} />,
        <input key="s" className={CELL} value={String(r.subtitle || "")} onChange={(e) => setAt(i, "subtitle", e.target.value)} />,
        <input key="a" className={CELL_MONO} value={String(r.arg || "")} onChange={(e) => setAt(i, "arg", e.target.value)} placeholder="留空=用标题" />,
      ]}
      extra={
        <div className="border-t border-border-soft px-[10px] py-[8px]">
          <button className="text-[12px] text-muted bg-transparent hover:text-orange-text" onClick={() => setImporting((v) => !v)}>
            {importing ? "收起 CSV 导入" : "CSV 批量导入…"}
          </button>
          {importing ? (<>
            <textarea className={`${CELL_MONO} h-[84px] resize-y mt-[8px]`} value={csv} onChange={(e) => setCsv(e.target.value)}
              placeholder={"每行一项：标题,副标题,参数,图标（后三列可省）\n含逗号的字段用双引号包起来"} />
            <div className="flex gap-[8px] mt-[8px]">
              <button className={BTN_SEC} disabled={!csv.trim()} onClick={() => doImport(false)}>追加导入</button>
              <button className={BTN_SEC} disabled={!csv.trim()} onClick={() => doImport(true)}>替换全部</button>
            </div>
          </>) : null}
        </div>
      }
    />
  );
}

// ── 预制件命名框（E3）──
// Electron 渲染进程里 window.prompt 不可用，只能自己弹一个。回车确认、Esc 取消。
function PrefabNamer({ init, count, onOk, onClose }: { init: string; count: number; onOk: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(init);
  const ok = () => { const v = name.trim(); if (v) onOk(v); };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div className="w-[380px] bg-card border border-border rounded-2xl p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="font-semibold text-[14px] mb-1">存为预制件</div>
        <div className="text-[11.5px] text-muted mb-3">把这 {count} 个节点和它们之间的连线整块存下来，之后在任何工作流里一键落地（跨出选区的连线不会带走）。</div>
        <input autoFocus className="w-full bg-bg border border-border rounded-lg px-[10px] py-[7px] text-[13px] outline-none"
          value={name} placeholder="预制件名称" onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); ok(); } else if (e.key === "Escape") { e.preventDefault(); onClose(); } }} />
        <div className="flex justify-end gap-2 mt-5">
          <button className="px-[14px] py-[7px] border border-border rounded-lg text-[12.5px]" onClick={onClose}>取消</button>
          <button className="px-[14px] py-[7px] bg-orange text-white rounded-lg text-[12.5px] font-semibold" disabled={!name.trim()} onClick={ok}>保存</button>
        </div>
      </div>
    </div>
  );
}

// ── 工作流变量编辑（可存密钥）──
// 和节点弹窗共用一套壳：宽度 560、底栏确认制、有改动时关掉先问一句。
function VarsEditor({ vars, onSave, onClose }: { vars: Record<string, string>; onSave: (v: Record<string, string>) => void; onClose: () => void }) {
  const [rows, setRows] = useState<{ k: string; v: string }[]>(Object.entries(vars).map(([k, v]) => ({ k, v })));
  // 手动「临时显形」的行下标：只影响当前这次弹框，关掉再打开又变回密文。
  // 存的是名字而不是下标 —— 拖动调序之后下标会串，显形的就变成另一行了。
  const [shown, setShown] = useState<Set<string>>(new Set());
  const secret = (k: string) => /key|secret|token|pass/i.test(k);
  const toggle = (k: string) => setShown((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const asObj = (rs: { k: string; v: string }[]) => {
    const o: Record<string, string> = {};
    for (const r of rs) if (r.k.trim()) o[r.k.trim()] = r.v;
    return o;
  };
  return (
    <Dlg width="md" icon={IconTag} title="工作流变量" sub="注入脚本环境变量，可存 appKey / secret 等密钥"
      dirty={!sameConfig(asObj(rows), vars)} onClose={onClose} onSave={() => onSave(asObj(rows))}>
      <div className="pt-[13px]">
        <RowTable<{ k: string; v: string }>
          rows={rows} onChange={setRows} blank={() => ({ k: "", v: "" })} addLabel="加一行"
          cols={[{ label: "名称", cls: "flex-1 basis-[160px] min-w-0" }, { label: "值", cls: "flex-1 basis-[260px] min-w-0" }]}
          emptyText="还没有变量。脚本里用 {var:名称} 或直接读同名环境变量。"
          cell={(r, i) => [
            <input key="k" className={CELL_MONO} value={r.k} placeholder="名称"
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />,
            <div key="v" className="flex items-center gap-[6px]">
              <input className={`${CELL_MONO} flex-1 min-w-0`} value={r.v} placeholder="值"
                type={secret(r.k) && !shown.has(r.k) ? "password" : "text"}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
              {/* 只有被判定为密钥的行才需要显隐切换；其余行本来就是明文 */}
              {secret(r.k) ? (
                <button className="w-[22px] flex-none flex justify-center text-muted hover:text-text"
                  title={shown.has(r.k) ? "隐藏" : "显示"} onClick={() => toggle(r.k)}>
                  {shown.has(r.k) ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                </button>
              ) : <span className="w-[22px] flex-none" />}
            </div>,
          ]}
        />
        <Hint>名字里带 key / secret / token / pass 的行会自动按密文显示。仅存在本地，不上传。</Hint>
      </div>
    </Dlg>
  );
}

// ── 工作流配置项（W10 Configuration 分层）──
// 设计稿把它拆成两张表，这个拆分是有意义的：
//   上表「声明」是**作者视角** —— 这条工作流对外暴露哪些可填项（键名/显示名/类型/默认值/说明）；
//   下表「取值」是**使用者视角** —— 在这台机器上这些项各填什么。
// 原来两者挤在同一行里（上半行声明、下半行填值），结果是「改结构」和「填值」两种完全不同的
// 操作混在一起，谁也看不清自己在改哪一层。
// 值统一写回 variables，脚本里 {var:键名} 照旧。password 类型的值不进工作流 JSON：
// 保存时先塞进密码保险箱，variables 里只留 vault://... 引用。
function ConfigEditor({ wf, onSave, onClose }: {
  wf: WF;
  onSave: (fields: WFConfigField[], vals: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [fields, setFields] = useState<WFConfigField[]>(() => (wf.config || []).map((f) => ({ ...f })));
  const [vals, setVals] = useState<Record<string, string>>(() => ({ ...(wf.variables || {}) }));
  // 密钥输入框里新敲的明文（还没存进保险箱）。undefined = 没动过，保持原引用。
  const [pw, setPw] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [unlocked, setUnlocked] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const check = () => void api.vaultUnlocked().then(setUnlocked).catch(() => setUnlocked(false));
  useEffect(check, []);

  const patch = (i: number, p: Partial<WFConfigField>) => setFields(fields.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const setVal = (k: string, v: string) => setVals({ ...vals, [k]: v });
  const named = fields.filter((f) => f.key.trim());
  // 有没有真要写进保险箱的密钥。只有这时保险箱锁着才是**阻塞性**问题 ——
  // 只改声明不填密钥的话，锁着也能正常保存，不该拿一个红条吓人。
  const needVault = named.some((f) => f.type === "password" && pw[f.key]);

  // 保存：先把改过的密钥逐个存进保险箱换回引用，任何一步失败就整体中止（不留半截状态）。
  const save = async () => {
    setBusy(true); setErr("");
    const list = named.map((f) => ({ ...f, key: f.key.trim(), label: (f.label || "").trim() || f.key.trim() }));
    const v = { ...vals };
    for (const f of list) {
      const plain = pw[f.key];
      if (f.type !== "password" || plain === undefined) continue;
      if (!plain) { delete v[f.key]; continue; }                      // 清空 = 解除绑定（保险箱里那条记录留着，用户自己去删）
      const old = String(v[f.key] || "");
      const r = await api.setWfSecret(old.startsWith("vault://") ? old : "", `${wf.name} · ${f.label}`, plain);
      if (!r.ok || !r.ref) { setErr(r.error || "存入保险箱失败"); setBusy(false); return; }
      v[f.key] = r.ref;
    }
    setBusy(false);
    onSave(list, v);
  };

  const dirty = JSON.stringify(fields) !== JSON.stringify(wf.config || [])
    || !sameConfig(vals, wf.variables || {})
    || Object.values(pw).some(Boolean);

  return (
    <Dlg width="lg" icon={IconGear} title="工作流配置项" sub="上表定义这条工作流对外暴露什么，下表填这台机器上的值"
      dirty={dirty} onClose={onClose} onSave={() => { if (!busy) void save(); }}>

      <Sec title="声明 · 作者填" note={`${named.length} 项`} />
      <RowTable<WFConfigField>
        rows={fields} onChange={setFields} blank={() => ({ key: "", label: "", type: "text" })} addLabel="加一项"
        cols={[
          { label: "键名", cls: "flex-1 basis-[120px] min-w-0" },
          { label: "显示名", cls: "flex-1 basis-[110px] min-w-0" },
          { label: "类型", cls: "w-[92px] flex-none" },
          { label: "默认值", cls: "flex-1 basis-[130px] min-w-0" },
          { label: "说明", cls: "flex-1 basis-[150px] min-w-0" },
        ]}
        emptyText="还没有配置项。加一条之后，这条工作流就有了对外可填的参数。"
        cell={(f, i) => [
          <input key="k" className={CELL_MONO} value={f.key} placeholder="键名" onChange={(e) => patch(i, { key: e.target.value })} />,
          <input key="l" className={CELL} value={f.label} placeholder="显示名" onChange={(e) => patch(i, { label: e.target.value })} />,
          <select key="t" className={CELL} value={f.type} onChange={(e) => patch(i, { type: e.target.value as WFConfigField["type"] })}>
            <option value="text">文本</option><option value="password">密钥</option><option value="file">路径</option>
            <option value="select">下拉</option><option value="checkbox">开关</option>
          </select>,
          // 密钥不设默认值（默认的密钥没有意义，还容易被顺手写进导出文件）；
          // 下拉的这一格改填候选项 —— 没有候选项的下拉是个空壳，比默认值重要。
          f.type === "password"
            ? <span key="d" className="text-[11.5px] text-faint">不设默认值</span>
            : f.type === "select"
              ? <input key="d" className={CELL} value={(f.options || []).join(",")} placeholder="候选项，逗号分隔"
                  onChange={(e) => patch(i, { options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
              : <input key="d" className={CELL} value={f.default || ""} placeholder="默认值" onChange={(e) => patch(i, { default: e.target.value })} />,
          <input key="h" className={CELL} value={f.help || ""} placeholder="可选" onChange={(e) => patch(i, { help: e.target.value })} />,
        ]}
      />

      <Sec title="取值 · 这台机器上生效" note={named.length ? undefined : "先在上表加一项"} />
      {named.map((f) => {
        const bound = String(vals[f.key] || "").startsWith("vault://");
        return (
          <Row key={f.key} label={f.label || f.key} top={!!f.help}>
            {f.type === "password" ? (
              <div className="flex items-center gap-[6px]">
                <input className={`${FLD} flex-1 min-w-0`} type={shown.has(f.key) ? "text" : "password"} value={pw[f.key] ?? ""}
                  placeholder={bound ? "已存入保险箱（留空=不改，输入=覆盖）" : "输入后保存即存进保险箱"}
                  onChange={(e) => setPw({ ...pw, [f.key]: e.target.value })} />
                <button className="w-[22px] flex-none flex justify-center text-muted hover:text-text"
                  title={shown.has(f.key) ? "隐藏" : "显示"}
                  onClick={() => setShown((s) => { const n = new Set(s); if (n.has(f.key)) n.delete(f.key); else n.add(f.key); return n; })}>
                  {shown.has(f.key) ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                </button>
              </div>
            ) : f.type === "checkbox" ? (
              <label className="flex items-center gap-[8px] text-[12.5px] text-muted cursor-pointer">
                <input type="checkbox" className="accent-orange w-[14px] h-[14px] m-0"
                  checked={(vals[f.key] ?? f.default ?? "") === "1"} onChange={(e) => setVal(f.key, e.target.checked ? "1" : "")} />
                开启时值为 1，关闭时为空
              </label>
            ) : f.type === "select" ? (
              <select className={FLD} value={vals[f.key] ?? f.default ?? ""} onChange={(e) => setVal(f.key, e.target.value)}>
                <option value="">（未选）</option>
                {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.type === "file" ? (
              <PickField value={vals[f.key] ?? ""} onChange={(v) => setVal(f.key, v)} mono
                onPick={async () => { const p = await api.pickPath(); if (p) setVal(f.key, p); }} placeholder={f.default ? `默认：${f.default}` : "路径"} />
            ) : (
              <input className={FLD} value={vals[f.key] ?? ""} placeholder={f.default ? `默认：${f.default}` : "值"} onChange={(e) => setVal(f.key, e.target.value)} />
            )}
            {f.help ? <Hint>{f.help}</Hint> : null}
          </Row>
        );
      })}

      {/* 保险箱锁着只在「真要写密钥」时才是阻塞性的，所以红条也只在那时出现 */}
      {!unlocked && needVault ? (
        <Note kind="danger">
          密码保险箱锁着，密钥类型的值现在存不进去。去主窗口解锁保险箱后，点这里重新检查。
          <button className="ml-[8px] underline bg-transparent text-danger" onClick={check}>重新检查</button>
        </Note>
      ) : null}
      {!unlocked && !needVault ? (
        <Note>密码保险箱当前是锁定的：改声明、填普通值都不受影响，只有新填的密钥要先解锁才存得进去。</Note>
      ) : null}
      {err ? <Note kind="danger">{err}</Note> : null}
      {busy ? <Hint>正在存入保险箱…</Hint> : null}

      <Fold title="这些值最后去了哪">
        填出来的值按 <Code>{"{var:键名}"}</Code> 或同名环境变量注入，和「工作流变量」是同一套通道。<br />
        「密钥」类型的值只存进密码保险箱，工作流 JSON（含导出文件）里只有一条 <Code>vault://</Code> 引用，不含明文。<br />
        清空一个已绑定的密钥等于解除绑定 —— 保险箱里那条记录会留着，要彻底删得去保险箱里删。
      </Fold>
    </Dlg>
  );
}
