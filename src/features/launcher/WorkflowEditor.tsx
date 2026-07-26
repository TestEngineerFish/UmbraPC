// 工作流可视化编辑器（类 Alfred Workflow）。独立窗口：左工作流列表 / 中可拖拽画布 / 右节点面板。
// 画布：节点按下任意处拖动、单击选中(Delete 删)、双击配置、右键菜单；端口拉线连接；
// 连线徽章：单击选中、双击切换修饰键、右键删除；Cmd+Z 撤销；滚轮/按钮缩放；空白拖拽平移（无限画布）。
import { useCallback, useEffect, useRef, useState } from "react";
import { IconBug, IconDots, IconExternal, IconFlow, IconPanel, IconPlus, IconRedo, IconSearch, IconTrash, IconUndo } from "../../components/icons";

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
export interface WFPrefab { id: string; name: string; icon?: string; nodes: WFNode[]; connections: WFConn[]; createdAt: number }

interface LauncherAPI {
  getWorkflows(): Promise<WF[]>; setWorkflows(w: WF[]): Promise<void>;
  // E3：预制件是全局的（不属于某条工作流），单独一份配置。
  getPrefabs(): Promise<WFPrefab[]>; setPrefabs(p: WFPrefab[]): Promise<void>;
  pickPath(): Promise<string>; pickApp(): Promise<string>; fileIcon(p: string): Promise<string>;
  getTrace(wfId?: string): Promise<TraceRun[]>; clearTrace(): Promise<void>;
  onTrace(cb: (r: TraceRun) => void): () => void;
  // W10：把配置项里的密钥交给密码保险箱，拿回一条 vault://... 引用存进工作流。
  setWfSecret(ref: string, title: string, value: string): Promise<{ ok: boolean; ref?: string; error?: string }>;
  vaultUnlocked(): Promise<boolean>;
  // 打开这条工作流自己的目录：脚本节点的默认 cwd 就是它，随行的可执行文件/资源都放在里面。
  openWorkflowDir(wfId: string): Promise<{ ok: boolean; dir: string; error: string }>;
}
const api = (window as unknown as { umbraLauncher: LauncherAPI }).umbraLauncher;

const NODE_W = 168;
const NODE_H = 66;     // 节点最小高度（框选命中判定用，多出口节点会更高但不影响判定）
const PORT_Y = 26;
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
  "trigger.keyword": "关键词", "trigger.hotkey": "热键", "trigger.always": "兜底触发",
  "trigger.universal": "选中即用", "trigger.snippet": "片段", "trigger.external": "外部调用",
  "trigger.remote": "远程", "trigger.fileaction": "文件动作", "trigger.contact": "联系人",
};
function wfMeta(w: WF): string {
  const t = w.nodes.find((n) => n.type.startsWith("trigger."));
  return `${w.nodes.length} 个节点 · ${t ? TRIGGER_SHORT[t.type] || "触发器" : "无触发器"}`;
}

// 对象清单：分组和命名对齐 Alfred，方便从 Alfred 迁过来的人直接照着找。
// soon=true 的项是「Alfred 有、我们还没实现」的对象 —— 照旧列在对象库里但置灰不可添加，
// 这样面板本身就是一张能力地图（哪些能用、哪些在路上一目了然），
// 补齐时只要写好 runNode 分支再把 soon 去掉即可，面板结构不用动。
// hint 是置灰项的悬停说明，写清楚「为什么还没做 / 打算怎么做」。
interface CatItem { type: string; label: string; emoji: string; soon?: boolean; hint?: string }
const CATALOG: { cat: string; items: CatItem[] }[] = [
  { cat: "触发 Triggers", items: [
    { type: "trigger.keyword", label: "Keyword 关键词", emoji: "⌨️" },
    { type: "trigger.hotkey", label: "Hotkey 全局热键", emoji: "⌘" },
    // 对应 Alfred 的 Fallback Search：主面板没匹配到结果时兜底，所以不再单列 Fallback 一项。
    { type: "trigger.always", label: "Fallback 始终触发", emoji: "♾️" },
    { type: "trigger.universal", label: "Universal Action 选中即用", emoji: "🎯" },
    { type: "trigger.snippet", label: "Snippet 片段触发", emoji: "✂️", soon: true, hint: "打字触发：输入约定的缩写就跑工作流。需要键盘监听，安全模型还没定，暂未实现。" },
    { type: "trigger.external", label: "External 外部调用", emoji: "📡", soon: true, hint: "给别的程序留一个可被调用的入口（命令行/URL Scheme）。等对外接口定稿后实现。" },
    { type: "trigger.remote", label: "Remote 远程触发", emoji: "📱", soon: true, hint: "手机端点一下触发桌面工作流。等可信设备网络那一期一起做。" },
    { type: "trigger.fileaction", label: "File Action 文件动作", emoji: "🗂️", soon: true, hint: "在文件管理器里选中文件后触发。要接系统的文件服务，暂未实现。" },
    { type: "trigger.contact", label: "Contact Action 联系人动作", emoji: "👤", soon: true, hint: "从通讯录联系人触发。我们暂时没有通讯录能力。" },
  ] },
  { cat: "输入 Inputs", items: [
    { type: "input.scriptfilter", label: "Script Filter 脚本过滤器", emoji: "🔎" },
    { type: "input.listfilter", label: "List Filter 列表过滤器", emoji: "📃" },
    { type: "input.codec", label: "编解码", emoji: "🔡" },
    { type: "input.calc", label: "计算器", emoji: "🔢" },
    { type: "input.units", label: "单位换算", emoji: "📐" },
    { type: "input.filefilter", label: "File Filter 文件过滤器", emoji: "📁", soon: true, hint: "按范围和类型搜本地文件并列出来。等本地索引能力就绪后实现。" },
    { type: "input.appsfilter", label: "Running Apps 运行中应用", emoji: "🪟", soon: true, hint: "列出当前运行的应用供切换/退出。要接系统窗口信息，暂未实现。" },
    { type: "input.dict", label: "Dictionary 词典查询", emoji: "📖", soon: true, hint: "查系统词典。macOS 专属能力，跨平台方案没定。" },
  ] },
  { cat: "工具 Utilities", items: [
    { type: "utility.args", label: "Args & Vars 改参数/设变量", emoji: "🏷️" },
    { type: "utility.conditional", label: "Conditional 条件分流", emoji: "🔀" },
    { type: "utility.transform", label: "Transform 大小写/编解码", emoji: "🔠" },
    { type: "utility.replace", label: "Replace 查找替换", emoji: "🔁" },
    { type: "utility.delay", label: "Delay 延时", emoji: "⏱️" },
    { type: "utility.debug", label: "Debug 调试打点", emoji: "🐞" },
    { type: "utility.split", label: "Split Arg 拆分参数", emoji: "✂️" },
    { type: "utility.join", label: "Join Args 合并参数", emoji: "🧷" },
    { type: "utility.junction", label: "Junction 汇流点", emoji: "⤵️", soon: true, hint: "纯理线用的中转点，只影响连线走向不改数据。" },
    { type: "utility.filter", label: "Filter 过滤", emoji: "🚦", soon: true, hint: "条件不满足就整条中断（Conditional 的单出口版）。" },
    { type: "utility.fileconditional", label: "File Conditional 文件条件", emoji: "🗃️", soon: true, hint: "按文件类型/扩展名分流。等 File Filter 一起做。" },
    { type: "utility.dialog", label: "Dialog Conditional 对话框", emoji: "❓", soon: true, hint: "弹个框问用户，按点了哪个按钮分流。UI 规范还没定。" },
    { type: "utility.random", label: "Random 随机值", emoji: "🎲", soon: true, hint: "生成随机数/UUID 塞进参数。" },
    { type: "utility.jsonconfig", label: "JSON Config 配置", emoji: "🧾", soon: true, hint: "用一段 JSON 一次性设置多个变量。" },
    { type: "utility.hide", label: "隐藏主面板", emoji: "🙈", soon: true, hint: "执行到这里先把主面板收起来再继续。等窗口控制接口补齐。" },
    { type: "utility.show", label: "显示主面板", emoji: "👁️", soon: true, hint: "把主面板重新唤起，和「隐藏主面板」配套。" },
  ] },
  { cat: "动作 Actions", items: [
    { type: "action.launch", label: "Launch Apps / Files 启动", emoji: "🚀" },
    { type: "action.openfile", label: "Open File 打开文件/书签", emoji: "📂" },
    { type: "action.openurl", label: "Open URL 打开网址", emoji: "🔗" },
    { type: "action.script", label: "Run Script 执行脚本", emoji: "📜" },
    { type: "action.copy", label: "Copy to Clipboard 复制", emoji: "📋" },
    { type: "action.paste", label: "粘贴到前台", emoji: "📥" },
    { type: "action.assistant", label: "发给秘书", emoji: "💬" },
    { type: "action.inspiration", label: "记为灵感", emoji: "💡" },
    { type: "action.ask_assistant", label: "问秘书（等回复）", emoji: "🤖" },
    { type: "action.create_task", label: "建任务", emoji: "🗓️" },
    { type: "action.device_skill", label: "设备技能派发", emoji: "🛰️" },
    { type: "action.reveal", label: "Reveal in Finder 在文件管理器中显示", emoji: "🔦", soon: true, hint: "在系统文件管理器里定位到这个文件。跨平台差异小，排在下一批。" },
    { type: "action.terminal", label: "Terminal Command 终端命令", emoji: "🖥️", soon: true, hint: "把命令送到系统终端里执行（区别于后台跑的 Run Script）。" },
    { type: "action.browse", label: "Browse in Terminal 在终端中打开目录", emoji: "📼", soon: true, hint: "在终端里 cd 到这个目录。和终端命令一起做。" },
    { type: "action.websearch", label: "Web Search 默认网页搜索", emoji: "🌐", soon: true, hint: "用默认搜索引擎搜关键词。等搜索引擎设置项落地。" },
    { type: "action.filebuffer", label: "File Buffer 文件暂存区", emoji: "🗄️", soon: true, hint: "把文件攒进暂存区再一起处理。需要先有文件暂存区这个概念。" },
    { type: "action.applescript", label: "Run AppleScript", emoji: "🍎", soon: true, hint: "macOS 专属脚本。跨平台上没有对应物，优先级低。" },
  ] },
  { cat: "自动化 Automations", items: [
    { type: "automation.task", label: "Automation Task 自动化任务", emoji: "⚙️", soon: true, hint: "调用预置的系统自动化任务包。我们打算用「设备技能」来对应，先占位。" },
    { type: "automation.shortcut", label: "Run Shortcut 运行快捷指令", emoji: "🔷", soon: true, hint: "调用系统快捷指令。macOS/iOS 专属。" },
    { type: "automation.system", label: "System Command 系统命令", emoji: "🖲️", soon: true, hint: "锁屏、睡眠、清废纸篓这类系统操作。要逐条对齐各平台实现。" },
    { type: "automation.music", label: "Music Command 音乐控制", emoji: "🎵", soon: true, hint: "控制音乐播放。我们暂时不碰媒体控制。" },
  ] },
  { cat: "输出 Outputs", items: [
    { type: "output.notify", label: "Post Notification 系统通知", emoji: "🔔" },
    { type: "output.largetype", label: "Large Type 大字显示", emoji: "🅰️" },
    { type: "output.textview", label: "Text View 文本视图", emoji: "📄" },
    { type: "output.writefile", label: "Write Text File 写文本文件", emoji: "💾" },
    { type: "output.keycombo", label: "Dispatch Key Combo 发送按键", emoji: "⌨️", soon: true, hint: "向前台应用发一组按键。要系统辅助功能权限。" },
    { type: "output.speak", label: "Speak 朗读", emoji: "🔊", soon: true, hint: "把参数念出来。等接系统 TTS。" },
    { type: "output.sound", label: "Play Sound 播放提示音", emoji: "🎧", soon: true, hint: "播一段提示音。" },
    { type: "output.exttrigger", label: "Call External Trigger 调用外部触发", emoji: "🔁", soon: true, hint: "从这条工作流跳去触发另一条工作流。等 External 触发做完配套。" },
  ] },
];
const TYPE_META: Record<string, { label: string; emoji: string; kind: string }> = {};
for (const g of CATALOG) for (const it of g.items) TYPE_META[it.type] = { label: it.label, emoji: it.emoji, kind: it.type.split(".")[0] };
const KIND_ACCENT: Record<string, string> = { trigger: "#8E44AD", input: "#2980B9", utility: "#B7791F", action: "#27AE60", output: "#E8590C", automation: "#16A085" };
// 拍平的对象清单（E1 搜索面板用）：分类信息一并带上，搜索时把分类名也算进匹配范围。
// 只收已实现的 —— 搜索面板和右键菜单是「直接添加」的入口，置灰项混进去只会白点一下。
const ALL_ITEMS: { type: string; label: string; emoji: string; cat: string }[] =
  CATALOG.flatMap((g) => g.items.filter((it) => !it.soon).map((it) => ({ type: it.type, label: it.label, emoji: it.emoji, cat: g.cat })));
// 右键菜单用的「分类 → 已实现对象」清单（空分类直接不出现）。
const ADD_GROUPS: { cat: string; items: CatItem[] }[] =
  CATALOG.map((g) => ({ cat: g.cat, items: g.items.filter((it) => !it.soon) })).filter((g) => g.items.length > 0);

function defaultConfig(type: string): Record<string, unknown> {
  switch (type) {
    case "trigger.keyword": return { keyword: "kw", arg: "optional", title: "" };
    case "trigger.hotkey": return { accelerator: "" };
    case "trigger.universal": return { accelerator: "", source: "auto" };
    case "input.scriptfilter": return { script: "", cwd: "", alfredFilters: false };
    case "input.listfilter": return { items: [{ title: "示例项", subtitle: "", arg: "" }], match: "word", learn: true };
    case "input.codec": return { mode: "unicode" };
    case "action.script": return { script: "", cwd: "", output: "none", onError: "stop" };
    case "utility.args": return { argMode: "keep", text: "{query}", vars: {} };
    case "utility.conditional": return { rules: [{ subject: "{query}", op: "contains", value: "", ci: true }] };
    case "utility.transform": return { target: "", mode: "upper" };
    case "utility.replace": return { target: "", find: "", to: "", regex: false, ci: false };
    case "utility.delay": return { seconds: 1 };
    case "utility.debug": return { text: "{query}", after: "pass", clear: false };
    case "utility.split": return { with: "comma", custom: "", trim: true, discardEmpty: false, output: "vars", prefix: "split" };
    case "utility.join": return { with: "newline", custom: "" };
    case "output.writefile": return { path: "", content: "{query}", ifExists: "overwrite", uuid: false, mkdirs: true, allowEmpty: false };
    case "action.ask_assistant": return { prompt: "{query}", title: "", show: true };
    case "action.create_task": return { text: "{query}", prefix: "帮我建个任务：" };
    case "action.device_skill": return { device: "", provider: "", skill: "", params: "" };
    case "output.textview": return { title: "", markdown: true, append: false };
    case "action.openurl": return { url: "{query}" };
    case "action.openfile": return { path: "{query}", app: "" };
    case "action.launch": return { paths: [], toggleVisibility: false };
    default: return {};
  }
}
// 节点的输出端口清单：默认只有一个匿名出口；Conditional 按规则条数出 r0…rN 再加一个 else；
// Run Script 选了「失败走分支」时，成功口之外再多一个 error 口。端口顺序即画布上从上到下的顺序。
function outPorts(n: WFNode): { port: string; label: string }[] {
  if (n.type === "utility.conditional") {
    const rules = Array.isArray(n.config.rules) ? (n.config.rules as unknown[]) : [];
    const list = rules.map((_, i) => ({ port: `r${i}`, label: `规则${i + 1}` }));
    list.push({ port: "else", label: "否则" });
    return list;
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

// ── 右键菜单（多级子菜单）──
interface MenuItem { label?: string; emoji?: string; onClick?: () => void; sub?: MenuItem[]; danger?: boolean; sep?: boolean }
function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="bg-card border border-border rounded-lg shadow-2xl py-1 min-w-[190px]">
      {items.map((it, i) => it.sep ? <div key={i} className="h-px bg-border my-1" /> : (
        <div key={i} className="relative" onMouseEnter={() => setOpen(it.sub ? i : null)}>
          <button className={`w-full text-left px-3 py-1.5 text-[12.5px] flex items-center gap-2 hover:bg-orange/10 ${it.danger ? "text-danger" : ""}`}
            onClick={() => { if (it.sub) return; it.onClick?.(); onClose(); }}>
            <span className="w-4 text-center">{it.emoji || ""}</span>
            <span className="flex-1">{it.label}</span>
            {it.sub ? <span className="text-muted">›</span> : null}
          </button>
          {it.sub && open === i ? <div className="absolute left-full top-0 -mt-1 ml-0.5"><MenuList items={it.sub} onClose={onClose} /></div> : null}
        </div>
      ))}
    </div>
  );
}
function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[70]" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div className="absolute" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}><MenuList items={items} onClose={onClose} /></div>
    </div>
  );
}

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
      <div className="w-[440px] bg-card border border-border rounded-xl shadow-2xl overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
        <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }} onKeyDown={onKey}
          placeholder="搜索对象…（↑↓ 选择 · 回车添加 · ⌥回车 接到选中节点后）"
          className="w-full bg-transparent px-4 py-3 text-[13px] outline-none border-b border-border" />
        <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
          {list.map((it, i) => (
            <button key={it.type} data-i={i} onMouseEnter={() => setIdx(i)}
              onClick={(e) => { onPick(it.type, e.altKey && canConnect); onClose(); }}
              className={`w-full flex items-center gap-2.5 px-4 py-2 text-left text-[12.5px] ${i === sel ? "bg-orange text-white" : ""}`}>
              <span className="w-[20px] text-center">{it.emoji}</span>
              <span className="flex-1 truncate">{it.label}</span>
              <span className={`text-[10.5px] ${i === sel ? "text-white/70" : "text-muted"}`}>{it.cat}</span>
            </button>
          ))}
          {!list.length ? <div className="px-4 py-6 text-center text-[12px] text-muted">没有匹配的对象</div> : null}
        </div>
      </div>
    </div>
  );
}

// ── 右侧对象库（布局参考 Alfred 的 Objects 面板）──
// 默认收起（顶栏「对象库」按钮切换），画布因此能占满整个宽度；需要挑对象时再拉出来。
// 分组可逐个折叠，顶部一个搜索框 + 全部展开/全部折叠两个箭头。
// 未实现的对象（CATALOG 里 soon=true）照样列出来但置灰，悬停能看到原因。
function ObjectLibrary({ prefabs, canAdd, onAdd, onPrefab, onDelPrefab, onClose }: {
  prefabs: WFPrefab[]; canAdd: boolean;
  onAdd: (type: string, alt: boolean) => void;
  onPrefab: (p: WFPrefab) => void; onDelPrefab: (p: WFPrefab) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
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

  return (
    <div className="w-[228px] border-l border-border bg-card flex flex-col min-h-0">
      <div className="flex items-center gap-1 px-2.5 pt-2.5 pb-2 border-b border-border">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 搜索对象"
          className="flex-1 min-w-0 bg-bg border border-border rounded-lg px-2 py-[5px] text-[12px] outline-none" />
        <button className="w-[22px] h-[22px] text-[11px] text-muted rounded hover:bg-orange/10" title="全部展开" onClick={() => setAll(false)}>⌄</button>
        <button className="w-[22px] h-[22px] text-[11px] text-muted rounded hover:bg-orange/10" title="全部折叠" onClick={() => setAll(true)}>⌃</button>
        <button className="w-[22px] h-[22px] text-[12px] text-muted rounded hover:bg-orange/10" title="收起对象库" onClick={onClose}>✕</button>
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 py-2">
        <div className="text-[10.5px] text-muted leading-[1.5] mb-2">点一下加到画布 · ⌥ 点击 = 接到选中节点后面</div>
        {/* 预制件（E3）：点一下就落在画布中央，右键菜单里也有一份。 */}
        {prefabs.length ? (
          <div>
            <button className="w-full flex items-center gap-1 text-[11px] text-muted mt-1 mb-1.5" onClick={() => setFold((f) => ({ ...f, 预制件: !f["预制件"] }))}>
              <span className="w-[10px] text-center">{hidden("预制件") ? "›" : "⌄"}</span>预制件
            </button>
            {hidden("预制件") ? null : prefabs.map((p) => (
              <div key={p.id} className="group flex items-center gap-1 mb-1.5">
                <button disabled={!canAdd} title={`落地到画布中央（${p.nodes.length} 个节点）`} onClick={() => onPrefab(p)}
                  className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-[7px] border border-border rounded-lg text-[12px] text-left disabled:opacity-40 hover:border-orange">
                  <span className="w-[18px] text-center shrink-0">{p.icon || "🧩"}</span>
                  <span className="truncate">{p.name}</span>
                </button>
                <button className="text-danger text-[11px] opacity-0 group-hover:opacity-100 shrink-0" onClick={() => onDelPrefab(p)}>删</button>
              </div>
            ))}
          </div>
        ) : null}
        {groups.map((g) => (
          <div key={g.cat}>
            <button className="w-full flex items-center gap-1 text-[11px] text-muted mt-2 mb-1.5" onClick={() => setFold((f) => ({ ...f, [g.cat]: !f[g.cat] }))}>
              <span className="w-[10px] text-center">{hidden(g.cat) ? "›" : "⌄"}</span>
              <span className="flex-1 text-left">{g.cat}</span>
              <span className="text-[10px] opacity-70">{g.items.filter((it) => !it.soon).length}/{g.items.length}</span>
            </button>
            {hidden(g.cat) ? null : g.items.map((it) => (
              <button key={it.type} disabled={!canAdd || !!it.soon}
                title={it.soon ? `暂未实现：${it.hint || ""}` : it.type}
                onClick={(e) => onAdd(it.type, e.altKey)}
                className={`w-full flex items-center gap-2 px-2.5 py-[7px] mb-1.5 border rounded-lg text-[12px] text-left ${
                  it.soon ? "border-dashed border-border text-muted opacity-55 cursor-not-allowed" : "border-border disabled:opacity-40 hover:border-orange"}`}>
                <span className={`w-[18px] text-center shrink-0 ${it.soon ? "grayscale" : ""}`}>{it.emoji}</span>
                <span className="flex-1 truncate">{it.label}</span>
                {it.soon ? <span className="text-[9px] px-1 rounded border border-border shrink-0">待实现</span> : null}
              </button>
            ))}
          </div>
        ))}
        {!groups.length ? <div className="py-6 text-center text-[12px] text-muted">没有匹配的对象</div> : null}
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
    <div className="h-[240px] shrink-0 border-t border-border bg-card flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
        <b className="text-[12.5px]">调试</b>
        <span className="text-[11px] text-muted flex-1">最近 {runs.length} 次执行 · 点某一步可跳到对应节点（变量里疑似密钥的值已打码）</span>
        <button className="text-[11.5px] text-muted border border-border rounded-md px-2 py-[3px]" onClick={onClear}>清空</button>
        <button className="text-[11.5px] text-muted border border-border rounded-md px-2 py-[3px]" onClick={onClose}>收起</button>
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="w-[190px] shrink-0 border-r border-border overflow-y-auto">
          {runs.map((r) => (
            <button key={r.id} onClick={() => { setCurRun(r.id); setOpenStep(null); }}
              className={`w-full text-left px-3 py-1.5 text-[11.5px] border-b border-border/50 ${run?.id === r.id ? "bg-orange/10" : ""}`}>
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-muted">{time(r.at)}</span>
                <span className="flex-1 truncate">{r.trigger}</span>
                <span className="text-muted">{r.ms}ms</span>
              </div>
              <div className="text-muted truncate">{r.wfName} · {r.steps.length} 步{r.arg ? ` · ${r.arg.slice(0, 16)}` : ""}</div>
            </button>
          ))}
          {!runs.length ? <div className="px-3 py-4 text-[11.5px] text-muted">还没有执行记录。<br />在启动器里跑一次这个工作流试试。</div> : null}
        </div>
        <div className="flex-1 min-w-0 overflow-y-auto">
          {run?.steps.map((s) => (
            <div key={s.seq} className="border-b border-border/50">
              <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-left"
                onClick={() => { setOpenStep(openStep === s.seq ? null : s.seq); onPickNode(s.nodeId); }}>
                <span className="w-[18px] text-muted font-mono">{s.seq}</span>
                <span className="flex-1 truncate">{nodeLabel(s.nodeId, s.type)}</span>
                {s.skipped ? <span className="text-[10px] text-muted border border-border rounded px-1">已停用·旁路</span> : null}
                {s.stopped ? <span className="text-[10px] text-danger border border-danger rounded px-1">终止</span> : null}
                {s.error ? <span className="text-[10px] text-danger">异常</span> : null}
                {s.outPort ? <span className="text-[10px] text-muted">出口 {s.outPort}</span> : null}
                <span className="text-muted font-mono">{s.ms}ms</span>
                <span className="text-muted">{openStep === s.seq ? "▾" : "▸"}</span>
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
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
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
  const [runs, setRuns] = useState<TraceRun[]>([]);
  // 顶栏一闪而过的提示（导入导出结果），比 alert 温和。
  const [note, setNote] = useState("");
  // 左侧工作流列的搜索词（名称 + 描述里搜）。只影响列表显示，不动选中项。
  const [wfQ, setWfQ] = useState("");
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
  const addNode = (type: string, x?: number, y?: number, connectFrom?: string) => {
    if (!cur) return;
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
      id: uid(), name, icon: TYPE_META[picked[0].type]?.emoji || "🧩",
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
      if (e.key === "Escape" && selSet.length) { e.preventDefault(); setSelSet([]); return; }
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
  }, [selNode, selConn, selSet, undo, redo]);

  const node = (id: string) => cur?.nodes.find((n) => n.id === id);
  // 端口坐标：入口固定在头部；出口按端口序号逐个下移，多出口节点因此有一列端口。
  const anchor = (n: WFNode, side: "in" | "out", port?: string) =>
    ({ x: n.x + (side === "out" ? NODE_W : 0), y: n.y + PORT_Y + (side === "out" ? portIndex(n, port) * PORT_GAP : 0) });

  const addSubmenu = (px: number, py: number): MenuItem[] => ADD_GROUPS.map((g) => ({ label: g.cat, sub: g.items.map((it) => ({ label: it.label, emoji: it.emoji, onClick: () => addNode(it.type, px, py) })) }));
  // 预制件相关的菜单项（E3）：落地到指定世界坐标 + 删除。没有预制件时整段不出现。
  const prefabMenu = (px: number, py: number): MenuItem[] => (prefabs.length ? [
    { sep: true },
    { label: "落地预制件", emoji: "🧩", sub: prefabs.map((p) => ({ label: `${p.name}（${p.nodes.length} 节点）`, emoji: p.icon || "🧩", onClick: () => placePrefab(p, px, py) })) },
    { label: "删除预制件", emoji: "🗑", sub: prefabs.map((p) => ({ label: p.name, emoji: p.icon || "🧩", danger: true, onClick: () => { savePrefabs(prefabsRef.current.filter((x) => x.id !== p.id)); setNote(`已删除预制件「${p.name}」`); } })) },
  ] : []);
  // 选区相关的菜单项（E4/E3）：两个以上节点才有意义。
  const selMenu = (): MenuItem[] => (selSetRef.current.length >= 2 ? [
    { sep: true },
    { label: `对齐这 ${selSetRef.current.length} 个节点`, emoji: "📐", sub: [
      { label: "左对齐", emoji: "⬅️", onClick: () => alignSel("left") },
      { label: "右对齐", emoji: "➡️", onClick: () => alignSel("right") },
      { label: "顶对齐", emoji: "⬆️", onClick: () => alignSel("top") },
      { label: "底对齐", emoji: "⬇️", onClick: () => alignSel("bottom") },
      { sep: true },
      { label: "水平等距", emoji: "↔️", onClick: () => alignSel("hspace") },
      { label: "垂直等距", emoji: "↕️", onClick: () => alignSel("vspace") },
    ] },
    { label: `把选中的 ${selSetRef.current.length} 个存为预制件…`, emoji: "🧩", onClick: () => setNaming({ ids: selSetRef.current.slice(), name: `节点组 ${selSetRef.current.length} 个` }) },
    { label: `删除选中的 ${selSetRef.current.length} 个节点`, emoji: "🗑", danger: true, onClick: () => delNodes(selSetRef.current.slice()) },
  ] : []);
  const openCanvasMenu = (e: React.MouseEvent) => {
    if (!cur) return;
    e.preventDefault(); const w = toWorld(e.clientX, e.clientY);
    setMenu({ x: e.clientX, y: e.clientY, items: [...addSubmenu(w.x, w.y), ...prefabMenu(w.x, w.y), ...selMenu()] });
  };
  const openNodeMenu = (e: React.MouseEvent, n: WFNode) => {
    e.preventDefault(); e.stopPropagation(); setSelNode(n.id); setSelConn(null);
    // 右键的是选区外的节点 → 视为重新选它，菜单也只对它生效。
    if (!selSetRef.current.includes(n.id)) { setSelSet([]); selSetRef.current = []; }
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: "配置节点…", emoji: "⚙️", onClick: () => setEditNode(n.id) },
      { label: "在其后插入", emoji: "➕", sub: ADD_GROUPS.map((g) => ({ label: g.cat, sub: g.items.map((it) => ({ label: it.label, emoji: it.emoji, onClick: () => insertAfter(n, it.type) })) })) },
      { label: n.disabled ? "启用节点 ⌘D" : "停用节点 ⌘D", emoji: n.disabled ? "▶️" : "⏸", onClick: () => toggleDisabled(n.id) },
      { label: "存为预制件…", emoji: "🧩", onClick: () => setNaming({ ids: [n.id], name: TYPE_META[n.type]?.label || "节点" }) },
      { sep: true },
      { label: "删除节点", emoji: "🗑", danger: true, onClick: () => delNode(n.id) },
      ...selMenu(),
    ] });
  };

  // 顶栏「⋯」菜单：低频操作都收在这里（变量表、工作流目录、导入导出、启用停用、复位视图）。
  // 菜单往按钮左下角贴（按钮本身在最右边，直接按 x=rect.left 会把菜单甩出窗口）。
  const openMoreMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = [];
    if (cur) {
      items.push({ label: "变量表…", emoji: "🏷️", onClick: () => setShowVars(true) });
      // 每条工作流一个独立目录：脚本节点默认就在这里跑，随行的 runtime/、index.js 之类放进去即可写相对路径。
      items.push({ label: "打开工作流目录", emoji: "📁", onClick: () => { void (async () => { const rr = await api.openWorkflowDir(cur.id); if (!rr?.ok) setNote(`打开目录失败：${rr?.error || "未知错误"}`); })(); } });
      items.push({ sep: true });
    }
    // 导入导出（W9）：走浏览器的文件选择/下载，不额外开主进程通道。
    items.push({ label: "导入 JSON…", emoji: "📥", onClick: () => fileRef.current?.click() });
    if (cur) items.push({ label: "导出当前工作流", emoji: "📤", onClick: () => exportWfs([cur], `${cur.name || "workflow"}.json`) });
    items.push({ label: "导出全部工作流", emoji: "📦", onClick: () => exportWfs(wfs, "umbra-workflows.json") });
    items.push({ sep: true });
    if (cur) items.push({ label: cur.enabled === false ? "启用这条工作流" : "停用这条工作流", emoji: cur.enabled === false ? "✅" : "⏸️", onClick: () => updateCur((w) => ({ ...w, enabled: w.enabled === false })) });
    items.push({ label: "复位视图", emoji: "⤢", onClick: () => { setScale(1); setPan({ x: 0, y: 0 }); } });
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
        {/* 连体图标条：整条一个外框，按钮之间用发丝线分隔，最后一个不带右边线。 */}
        <div className="flex-none flex items-center bg-bg border border-border rounded-lg overflow-hidden">
          <button className={`${TB} border-r border-border ${hist.u ? "text-muted hover:bg-hover" : "text-faint"}`} disabled={!hist.u} title="撤销 ⌘Z" onClick={() => { if (hist.u) undo(); }}><IconUndo size={15} /></button>
          <button className={`${TB} border-r border-border ${hist.r ? "text-muted hover:bg-hover" : "text-faint"}`} disabled={!hist.r} title="重做 ⇧⌘Z" onClick={() => { if (hist.r) redo(); }}><IconRedo size={15} /></button>
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
                  <span className={`w-6 h-6 flex-none rounded-md flex items-center justify-center text-[13px] ${sel ? "bg-orange-soft text-orange-text" : "bg-chip text-muted"}`}>
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

        {/* 中：画布 */}
        <div ref={canvasRef} className="relative flex-1 overflow-hidden"
          style={{ background: "#22201D", backgroundImage: "radial-gradient(rgba(255,255,255,.06) 1px,transparent 1px)", backgroundSize: `${22 * scale}px ${22 * scale}px`, backgroundPosition: `${pan.x}px ${pan.y}px`, cursor: "grab" }}
          onMouseDown={onCanvasDown} onContextMenu={openCanvasMenu} onWheel={onWheel}
          onDoubleClick={(e) => { if (cur) setPalette(toWorld(e.clientX, e.clientY)); }}>
          {!cur ? <div className="absolute inset-0 flex items-center justify-center text-[13px] text-white/40">新建或选择一个工作流</div> : null}
          {cur ? (
            <div className="absolute top-0 left-0" style={{ width: WORLD_W, height: WORLD_H, transform: `translate(${pan.x}px,${pan.y}px) scale(${scale})`, transformOrigin: "0 0" }}>
              <svg className="absolute top-0 left-0 pointer-events-none" width={WORLD_W} height={WORLD_H}>
                {cur.connections.map((c, i) => {
                  const a = node(c.from), b = node(c.to); if (!a || !b) return null;
                  const p1 = anchor(a, "out", c.fromPort), p2 = anchor(b, "in");
                  return <path key={i} d={`M ${p1.x} ${p1.y} C ${p1.x + 60} ${p1.y}, ${p2.x - 60} ${p2.y}, ${p2.x} ${p2.y}`} fill="none" stroke={selConn === i ? "#E8590C" : "#6b645c"} strokeWidth={selConn === i ? 3 : 2} />;
                })}
                {link.current && linkPos ? (() => { const a = node(link.current.from); if (!a) return null; const p1 = anchor(a, "out", link.current.port); return <path d={`M ${p1.x} ${p1.y} C ${p1.x + 60} ${p1.y}, ${linkPos.x - 60} ${linkPos.y}, ${linkPos.x} ${linkPos.y}`} fill="none" stroke="#E8590C" strokeWidth={2} strokeDasharray="4 4" />; })() : null}
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
                    className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-md text-[11px] px-[6px] py-[1px] border ${selConn === i ? "bg-orange text-white border-orange" : "bg-[#413C36] text-[#EDEAE4] border-[#55504a]"}`}
                    style={{ left: (p1.x + p2.x) / 2, top: (p1.y + p2.y) / 2 }}>{portTag}{MOD_LABEL[c.mod || ""]}</button>
                );
              })}
              {cur.nodes.map((n) => {
                const meta = TYPE_META[n.type] || { label: n.type, emoji: "🔹", kind: "action" };
                const accent = KIND_ACCENT[meta.kind] || "#888";
                // 主选中和框选中的节点边框一样高亮（E4）；单击/框选出来的手感因此一致。
                const sel = selNode === n.id || selSet.includes(n.id);
                const ports = outPorts(n);
                // 端口比节点本身高时把节点撑高，避免端口飘到卡片外面。
                const minH = Math.max(NODE_H, PORT_Y + (ports.length - 1) * PORT_GAP + 16);
                return (
                  <div key={n.id} className="absolute rounded-xl border shadow-lg select-none cursor-grab active:cursor-grabbing"
                    style={{ left: n.x, top: n.y, width: NODE_W, minHeight: minH, background: "#2E2B27",
                      borderColor: sel ? "#E8590C" : "#413C36", borderStyle: n.disabled ? "dashed" : "solid",
                      opacity: n.disabled ? 0.5 : 1,
                      boxShadow: sel ? "0 0 0 2px rgba(232,89,12,.5)" : undefined, color: "#EDEAE4" }}
                    onMouseDown={(e) => onNodeDown(e, n)} onMouseUp={() => onNodeUp(n)}
                    onDoubleClick={(e) => { e.stopPropagation(); setEditNode(n.id); }} onContextMenu={(e) => openNodeMenu(e, n)}>
                    <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: "#413C36" }}>
                      <span className="w-[22px] h-[22px] rounded-md flex items-center justify-center text-[13px]" style={{ background: accent + "40" }}>{meta.emoji}</span>
                      <b className="text-[12.5px] flex-1 truncate">{meta.label}</b>
                      {n.disabled ? <span className="text-[9.5px] px-1 rounded border border-[#55504a] text-[#B8B1A7] shrink-0">已停用</span> : null}
                    </div>
                    <div className="px-3 py-2 text-[11px] text-[#B8B1A7] truncate">{nodeSummary(n)}</div>
                    <span data-port className="absolute w-[11px] h-[11px] rounded-full" style={{ left: -6, top: PORT_Y - 5, background: "#8a827a", border: "2px solid #2E2B27" }} />
                    {ports.map((p, pi) => (
                      <span key={p.port || "def"} data-port className="absolute w-[11px] h-[11px] rounded-full cursor-crosshair" title={p.label || "出口"}
                        style={{ right: -6, top: PORT_Y + pi * PORT_GAP - 5, background: p.port === "error" ? "#C0392B" : p.port === "else" ? "#7f8c8d" : "#8a827a", border: "2px solid #2E2B27" }}
                        onMouseDown={(e) => onPortDown(e, n, p.port)} />
                    ))}
                    {ports.length > 1 ? ports.map((p, pi) => (
                      <span key={`lb${p.port}`} className="absolute text-[9px] whitespace-nowrap pointer-events-none" style={{ left: NODE_W + 9, top: PORT_Y + pi * PORT_GAP - 7, color: "#8a827a" }}>{p.label}</span>
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
          {/* 缩放控件从顶栏挪到画布右上角：它只跟画布有关，跟着画布走更顺手，顶栏也就腾出来了。 */}
          {cur ? (
            <div className="absolute right-3 top-3 flex items-center gap-0.5 bg-black/35 rounded-full px-1 py-0.5 text-white/75">
              <button className="w-[22px] h-[22px] rounded-full hover:bg-white/10 text-[13px]" title="缩小" onClick={() => zoomBy(0.9)}>－</button>
              <button className="text-[11px] px-1 min-w-[38px] text-center hover:text-white" title="复位（100%）" onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }}>{Math.round(scale * 100)}%</button>
              <button className="w-[22px] h-[22px] rounded-full hover:bg-white/10 text-[13px]" title="放大" onClick={() => zoomBy(1.1)}>＋</button>
            </div>
          ) : null}
          {cur ? <div className="absolute left-4 bottom-3 bg-black/40 text-white/70 text-[11px] px-3 py-1.5 rounded-full pointer-events-none">拖节点摆位 · 单击选中(Delete 删) · 双击配置 · ⌘D 停用 · ⇧拖空白框选 · ⌘点击加减选 · ⌘A 全选 · 右键菜单可对齐/存预制件 · 端口拉线 · 双击空白或 / 搜索对象 · ⌘Z 撤销 · ⌘/⌃+滚轮缩放 · 拖空白平移</div> : null}
          {/* 选区计数：多选时给个明确反馈，免得用户不确定手里攥着几个。 */}
          {selSet.length > 1 ? <div className="absolute right-4 bottom-3 bg-orange/80 text-white text-[11px] px-3 py-1.5 rounded-full pointer-events-none">已选中 {selSet.length} 个节点 · 右键可对齐/存为预制件</div> : null}
        </div>

        {/* 右：对象库（默认收起，顶栏 ▤ 按钮切换） */}
        {lib ? (
          <ObjectLibrary prefabs={prefabs} canAdd={!!cur}
            onAdd={(type, alt) => addNode(type, undefined, undefined, alt && selNode ? selNode : undefined)}
            onPrefab={(p) => { const c = canvasCenter(); placePrefab(p, c.x, c.y); }}
            onDelPrefab={(p) => { savePrefabs(prefabs.filter((x) => x.id !== p.id)); setNote(`已删除预制件「${p.name}」`); }}
            onClose={() => setLib(false)} />
        ) : null}
      </div>

      {drawer ? (
        <DebugDrawer runs={runs}
          nodeLabel={(id, type) => { const n = cur?.nodes.find((x) => x.id === id); return `${TYPE_META[type]?.emoji || "🔹"} ${TYPE_META[type]?.label || type}${n ? ` · ${nodeSummary(n)}` : "（节点已删除）"}`; }}
          onPickNode={(id) => { setSelNode(id); setSelConn(null); }}
          onClear={() => { void api.clearTrace(); setRuns([]); }}
          onClose={() => setDrawer(false)} />
      ) : null}

      {palette ? (
        <Palette canConnect={!!selNode}
          onPick={(type, connect) => addNode(type, palette.x, palette.y, connect && selNode ? selNode : undefined)}
          onClose={() => setPalette(null)} />
      ) : null}
      {editNode && cur ? (
        <NodeConfig node={cur.nodes.find((n) => n.id === editNode)!} onClose={() => setEditNode(null)} onSave={(cfg) => { setNodeConfig(editNode, cfg); setEditNode(null); }} />
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
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

// Split / Join 的分隔符选项：键与引擎 delimOf() 认的值一一对应，改这里记得两边一起改。
const DELIM_LABEL: Record<string, string> = { comma: "逗号", space: "空格", tab: "制表符", newline: "换行", custom: "自定义" };

function nodeSummary(n: WFNode): string {
  const c = n.config as Record<string, string>;
  switch (n.type) {
    case "trigger.keyword": return `关键词「${c.keyword || "?"}」${c.arg === "none" ? "" : " · 带参"}`;
    case "trigger.hotkey": return c.accelerator || "未设快捷键";
    case "trigger.universal": return `${c.accelerator || "未设快捷键"} · ${c.source === "files" ? "选中文件" : c.source === "text" ? "选中文本" : "文本/文件"}`;
    case "trigger.always": return "任意输入都尝试";
    case "input.scriptfilter": return c.script ? c.script.slice(0, 40) : "未设脚本";
    case "input.listfilter": { const rows = (n.config.items as unknown[]) || []; return `${rows.length} 项 · ${c.match === "none" ? "不过滤" : c.match === "contains" ? "包含匹配" : "词首匹配"}`; }
    case "input.codec": return `编解码：${c.mode || "unicode"}`;
    case "input.calc": return "计算表达式";
    case "input.units": return "单位换算";
    case "action.script": return c.script ? c.script.slice(0, 40) : "未设脚本";
    case "action.openurl": return String(c.url || "{query}");
    case "action.openfile": return String(c.path || "{query}");
    case "action.launch": { const p = (n.config.paths as string[]) || []; return p.length ? `${p.length} 个 App/文件` : "未选择 App/文件"; }
    case "utility.args": return c.argMode === "set" ? `参数改为「${String(c.text || "").slice(0, 16)}」` : c.argMode === "clear" ? "清空参数" : "沿用参数 · 可设变量";
    case "utility.conditional": { const r = (n.config.rules as unknown[]) || []; return `${r.length} 条规则 · 多出口`; }
    case "utility.transform": return `${c.target ? `变量 ${c.target}` : "参数"} → ${c.mode || "upper"}`;
    case "utility.replace": return c.find ? `「${c.find}」→「${c.to || ""}」` : "未设查找内容";
    case "utility.delay": return `等待 ${Number(c.seconds || 0)} 秒`;
    case "utility.debug": return String(c.text || "{query}").replace(/\s+/g, " ").slice(0, 28);
    case "utility.split": return `按${DELIM_LABEL[c.with || "comma"] || "自定义"}拆 · ${c.output === "args" ? "逐条执行" : `变量 ${String(c.prefix || "split")}1…`}`;
    case "utility.join": return `用${DELIM_LABEL[c.with || "newline"] || "自定义"}合并`;
    case "output.writefile": return c.path ? `写入 ${String(c.path).split("/").pop()}` : "未设文件名";
    case "action.ask_assistant": return String(c.prompt || "{query}").slice(0, 28);
    case "action.create_task": return String(c.text || "{query}").slice(0, 28);
    case "action.device_skill": return `${c.provider || "?"}.${c.skill || "?"}${c.device ? ` @${c.device}` : " @自动"}`;
    case "output.textview": return `文本视图${c.append ? " · 追加" : ""}`;
    default: return TYPE_META[n.type]?.label || n.type;
  }
}

// Launch 目标列表：左图标 + 路径（默认只读，双击可编辑）。
function LaunchList({ paths, onChange }: { paths: string[]; onChange: (p: string[]) => void }) {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<number | null>(null);
  useEffect(() => {
    for (const p of paths) if (!(p in icons)) void api.fileIcon(p).then((d) => setIcons((m) => ({ ...m, [p]: d || "" })));
  }, [paths]);
  const setAt = (i: number, v: string) => onChange(paths.map((x, j) => (j === i ? v : x)));
  return (
    <div className="flex flex-col gap-1.5">
      {paths.map((p, i) => (
        <div key={i} className="flex items-center gap-2 bg-bg border border-border rounded-lg px-[8px] py-[6px]">
          <span className="w-[20px] h-[20px] flex items-center justify-center shrink-0">{icons[p] ? <img src={icons[p]} className="w-[18px] h-[18px]" alt="" /> : <span className="text-[13px]">📄</span>}</span>
          {editing === i ? (
            <input autoFocus defaultValue={p} onBlur={(e) => { setAt(i, e.target.value.trim()); setEditing(null); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              className="flex-1 bg-transparent border-b border-orange text-[12px] font-mono outline-none" />
          ) : (
            <span className="flex-1 truncate text-[12px] font-mono cursor-text" title="双击编辑" onDoubleClick={() => setEditing(i)}>{p}</span>
          )}
          <button className="text-danger text-[12px]" onClick={() => onChange(paths.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div className="flex gap-1.5">
        <button className="px-[10px] py-[6px] border border-border rounded-lg text-[12px]" onClick={async () => { const a = await api.pickApp(); if (a) onChange([...paths, `/Applications/${a}.app`]); }}>＋ 选 App</button>
        <button className="px-[10px] py-[6px] border border-border rounded-lg text-[12px]" onClick={async () => { const p = await api.pickPath(); if (p) onChange([...paths, p]); }}>＋ 选文件</button>
      </div>
    </div>
  );
}

// ── Conditional 规则表 ──
// 一行一条规则，顺序即出口顺序（第 1 行 → r0 口，以此类推）；判断在引擎侧由 matchRule 执行。
export interface Rule { subject?: string; op?: string; value?: string; ci?: boolean }
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
function RulesEditor({ rules, onChange }: { rules: Rule[]; onChange: (r: Rule[]) => void }) {
  const inp = "bg-bg border border-border rounded-lg px-[8px] py-[5px] text-[12px] outline-none";
  const setAt = (i: number, patch: Partial<Rule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2">
      {rules.map((r, i) => (
        <div key={i} className="border border-border rounded-lg p-2 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted w-[38px] shrink-0">出口{i + 1}</span>
            <input className={`${inp} flex-1 font-mono`} value={r.subject ?? "{query}"} placeholder="{query}" onChange={(e) => setAt(i, { subject: e.target.value })} />
            <button className="text-danger text-[12px] px-1" title="删除这条规则" onClick={() => onChange(rules.filter((_, j) => j !== i))}>✕</button>
          </div>
          <div className="flex items-center gap-1.5">
            <select className={`${inp} w-[104px] shrink-0`} value={r.op || "contains"} onChange={(e) => setAt(i, { op: e.target.value })}>
              {RULE_OPS.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
            </select>
            {NO_VALUE_OPS.includes(r.op || "contains") ? <span className="flex-1 text-[11px] text-muted">（无需比较值）</span>
              : <input className={`${inp} flex-1 font-mono`} value={r.value ?? ""} placeholder="比较值" onChange={(e) => setAt(i, { value: e.target.value })} />}
            <label className="flex items-center gap-1 text-[11px] text-muted shrink-0"><input type="checkbox" checked={r.ci !== false} onChange={(e) => setAt(i, { ci: e.target.checked })} />忽略大小写</label>
          </div>
        </div>
      ))}
      <button className="text-[12.5px] text-muted border border-dashed border-border rounded-lg px-3 py-1.5"
        onClick={() => onChange([...rules, { subject: "{query}", op: "contains", value: "", ci: true }])}>＋ 加一条规则</button>
    </div>
  );
}

// ── 简易键值表（Args & Vars 节点用来设置变量）──
function KVEditor({ kv, onChange }: { kv: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const [rows, setRows] = useState<{ k: string; v: string }[]>(Object.entries(kv || {}).map(([k, v]) => ({ k, v: String(v) })));
  const inp = "bg-bg border border-border rounded-lg px-[8px] py-[5px] text-[12px] outline-none font-mono";
  // 每次编辑都立刻回吐给父级：空名字的行会被忽略，不写进配置。
  const push = (rs: { k: string; v: string }[]) => {
    setRows(rs);
    const o: Record<string, string> = {};
    for (const r of rs) if (r.k.trim()) o[r.k.trim()] = r.v;
    onChange(o);
  };
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input className={`${inp} w-[110px]`} value={r.k} placeholder="变量名" onChange={(e) => push(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
          <input className={`${inp} flex-1`} value={r.v} placeholder="值（可用 {query}）" onChange={(e) => push(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
          <button className="text-danger text-[12px]" onClick={() => push(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="text-[12px] text-muted border border-dashed border-border rounded-lg px-2.5 py-1" onClick={() => push([...rows, { k: "", v: "" }])}>＋ 加一个变量</button>
    </div>
  );
}

// ── 节点配置弹窗 ──
function NodeConfig({ node, onSave, onClose }: { node: WFNode; onSave: (c: Record<string, unknown>) => void; onClose: () => void }) {
  const [c, setC] = useState<Record<string, unknown>>({ ...node.config });
  const [rec, setRec] = useState(false);
  const meta = TYPE_META[node.type] || { label: node.type, emoji: "🔹" };
  const set = (k: string, v: unknown) => setC((p) => ({ ...p, [k]: v }));
  const inp = "w-full bg-bg border border-border rounded-lg px-[10px] py-[7px] text-[12.5px] outline-none";
  const lab = "text-[11.5px] text-muted mb-1 block";

  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setRec(false); return; }
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
      const mods: string[] = [];
      if (e.metaKey) mods.push("Command"); if (e.ctrlKey) mods.push("Control");
      if (e.altKey) mods.push("Alt"); if (e.shiftKey) mods.push("Shift");
      const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
      set("accelerator", [...mods, key].join("+")); setRec(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rec]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      {/* List Filter 一行要摆四个输入框，440px 挤不下，单独给它宽一点 */}
      <div className={`${node.type === "input.listfilter" ? "w-[620px]" : "w-[440px]"} max-h-[86vh] overflow-y-auto bg-card border border-border rounded-2xl p-5 shadow-2xl`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-4"><span className="text-[18px]">{meta.emoji}</span><span className="font-semibold text-[14px]">{meta.label}</span></div>
        <div className="flex flex-col gap-3">
          {node.type === "trigger.keyword" ? (<>
            <div><span className={lab}>关键词（在快捷入口输入触发）</span><input className={`${inp} font-mono`} value={String(c.keyword || "")} onChange={(e) => set("keyword", e.target.value)} placeholder="yd" /></div>
            <div><span className={lab}>参数</span>
              <select className={inp} value={String(c.arg || "optional")} onChange={(e) => set("arg", e.target.value)}>
                <option value="none">无参数（仅关键词）</option><option value="optional">可选参数</option><option value="required">必填参数</option>
              </select></div>
            <div><span className={lab}>显示标题（可选）</span><input className={inp} value={String(c.title || "")} onChange={(e) => set("title", e.target.value)} /></div>
          </>) : null}
          {node.type === "trigger.hotkey" ? (
            <div><span className={lab}>全局快捷键</span>
              <button onClick={() => setRec(true)} className={`${inp} text-left font-mono ${rec ? "border-orange" : ""}`}>{rec ? "按下快捷键…" : (String(c.accelerator || "") || "点击录制")}</button>
              <div className="text-[11px] text-muted mt-1">触发时把当前剪贴板文本作为参数，跑「回车」分支的动作。</div>
            </div>
          ) : null}
          {node.type === "trigger.universal" ? (<>
            <div><span className={lab}>全局快捷键</span>
              <button onClick={() => setRec(true)} className={`${inp} text-left font-mono ${rec ? "border-orange" : ""}`}>{rec ? "按下快捷键…" : (String(c.accelerator || "") || "点击录制")}</button></div>
            <div><span className={lab}>抓什么</span>
              <select className={inp} value={String(c.source || "auto")} onChange={(e) => set("source", e.target.value)}>
                <option value="auto">自动（有文件用文件，否则用文本）</option><option value="text">只要选中的文本</option><option value="files">只要选中的文件路径</option>
              </select></div>
            <div className="text-[11px] text-muted">按下快捷键时先模拟一次 ⌘C 抓走当前选区，再把它当参数跑「回车」分支；抓完会把原来的剪贴板还回去。
              下游还能用 {"{var:selection_type}"}（text/files）和 {"{var:selection_files}"}（每行一个路径）分开处理。
              需要在「系统设置 → 隐私与安全性 → 辅助功能」里给 Umbra 授权，否则抓不到选区。</div>
          </>) : null}
          {node.type === "trigger.always" ? (
            <div className="text-[12px] text-muted">无需关键词，任意输入都会尝试运行下游输入节点（如计算器/单位换算），结果并入普通搜索。</div>
          ) : null}
          {node.type === "input.scriptfilter" ? (<>
            <div><span className={lab}>脚本（stdout 返回 Alfred JSON：{"{items:[…]}"}，$1=输入）</span>
              <textarea className={`${inp} font-mono h-[90px] resize-y`} value={String(c.script || "")} onChange={(e) => set("script", e.target.value)} placeholder={`./runtime/txiki ./index.js "$1"`} /></div>
            <div><span className={lab}>运行目录 cwd（可选，支持 ~）</span><input className={`${inp} font-mono`} value={String(c.cwd || "")} onChange={(e) => set("cwd", e.target.value)} /></div>
            <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={!!c.alfredFilters} onChange={(e) => set("alfredFilters", e.target.checked)} />由 Umbra 按输入过滤结果</label>
          </>) : null}
          {node.type === "input.listfilter" ? (<>
            <div className="text-[11.5px] text-muted">不用写脚本的 Script Filter：在下面维护一张固定列表，按输入过滤后作为结果给出。选中某项时，它的「参数」会作为 arg 传给下游。</div>
            <ListRowsEditor rows={(c.items as ListRow[]) || []} onChange={(r) => set("items", r)} />
            <div><span className={lab}>匹配方式</span>
              <select className={inp} value={String(c.match || "word")} onChange={(e) => set("match", e.target.value)}>
                <option value="word">词首匹配（标题/副标题里任一词以输入开头）</option>
                <option value="contains">任意位置包含</option>
                <option value="none">不过滤（整表全部给出）</option>
              </select></div>
            <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={c.learn !== false} onChange={(e) => set("learn", e.target.checked)} />参与使用频率学习（常选的项会被顶到前面）</label>
            <div className="text-[11px] text-muted">「参数」一栏支持 {"{query}"} / {"{var:名称}"} 等占位符；图标一栏填 emoji 或图片文件的绝对路径。</div>
          </>) : null}
          {node.type === "input.codec" ? (
            <div><span className={lab}>编解码类型</span>
              <select className={inp} value={String(c.mode || "unicode")} onChange={(e) => set("mode", e.target.value)}>
                <option value="unicode">Unicode</option><option value="url">URL</option><option value="base64">Base64</option>
              </select></div>
          ) : null}
          {node.type === "input.calc" || node.type === "input.units" ? (
            <div className="text-[12px] text-muted">{node.type === "input.calc" ? "输入算式即时求值（如 3*4+2）。" : "输入换算（如 10km to mi、72f to c）。"}回车复制结果。</div>
          ) : null}
          {node.type === "action.script" ? (<>
            <div><span className={lab}>脚本（$1=上游 arg，变量注入 env）</span>
              <textarea className={`${inp} font-mono h-[80px] resize-y`} value={String(c.script || "")} onChange={(e) => set("script", e.target.value)} placeholder={`say "$1"`} /></div>
            <div><span className={lab}>运行目录 cwd（可选）</span><input className={`${inp} font-mono`} value={String(c.cwd || "")} onChange={(e) => set("cwd", e.target.value)} /></div>
            <div><span className={lab}>stdout 处理</span>
              <select className={inp} value={String(c.output || "none")} onChange={(e) => set("output", e.target.value)}>
                <option value="none">忽略（继续传给下游）</option><option value="copy">复制到剪贴板</option>
              </select></div>
            <div><span className={lab}>脚本失败时</span>
              <select className={inp} value={String(c.onError || "stop")} onChange={(e) => set("onError", e.target.value)}>
                <option value="stop">停止这条链路（默认）</option>
                <option value="continue">忽略错误继续往下走</option>
                <option value="branch">走「失败」出口（节点上会多一个红色端口）</option>
              </select>
              <div className="text-[11px] text-muted mt-1">脚本还可以输出 Alfred 风格的 JSON（{"{alfredworkflow:{arg,variables}}"}）来改写下游参数与变量。</div>
            </div>
          </>) : null}
          {node.type === "action.openurl" ? (
            <div><span className={lab}>网址（{"{query}"}=arg）</span><input className={`${inp} font-mono`} value={String(c.url || "")} onChange={(e) => set("url", e.target.value)} placeholder="https://example.com/?q={query}" /></div>
          ) : null}
          {node.type === "action.openfile" ? (<>
            <div className="text-[11.5px] text-muted">打开上游传入的文件/文件夹；下方可设固定路径（书签）与用哪个应用打开。</div>
            <div className="flex gap-1.5"><input className={`flex-1 ${inp} font-mono`} value={String(c.path || "")} onChange={(e) => set("path", e.target.value)} placeholder="{query} 或固定路径（支持 ~）" />
              <button className="px-[10px] border border-border rounded-lg text-[12px]" onClick={async () => { const p = await api.pickPath(); if (p) set("path", p); }}>选择</button></div>
            <div className="flex gap-1.5"><input className={`flex-1 ${inp}`} value={String(c.app || "")} onChange={(e) => set("app", e.target.value)} placeholder="用哪个应用打开（可选）" />
              <button className="px-[10px] border border-border rounded-lg text-[12px]" onClick={async () => { const a = await api.pickApp(); if (a) set("app", a); }}>选择 App</button></div>
          </>) : null}
          {node.type === "action.launch" ? (<>
            <span className={lab}>要启动的 App / 文件（双击某行编辑路径）</span>
            <LaunchList paths={(c.paths as string[]) || []} onChange={(p) => set("paths", p)} />
            <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={!!c.toggleVisibility} onChange={(e) => set("toggleVisibility", e.target.checked)} />切换可见性：若某 App 已在前台则隐藏它</label>
          </>) : null}
          {node.type === "utility.args" ? (<>
            <div><span className={lab}>参数如何处理</span>
              <select className={inp} value={String(c.argMode || "keep")} onChange={(e) => set("argMode", e.target.value)}>
                <option value="keep">沿用上游参数</option><option value="set">用下面的模板改写</option><option value="clear">清空参数</option>
              </select></div>
            {String(c.argMode || "keep") === "set" ? (
              <div><span className={lab}>新参数模板（{"{query}"}=上游参数，{"{var:名称}"}=变量）</span>
                <input className={`${inp} font-mono`} value={String(c.text || "")} onChange={(e) => set("text", e.target.value)} placeholder="{query}" /></div>
            ) : null}
            <div><span className={lab}>设置变量（对本节点之后的下游可见）</span>
              <KVEditor kv={(c.vars as Record<string, string>) || {}} onChange={(v) => set("vars", v)} /></div>
            <div className="text-[11px] text-muted leading-[1.7]">可用占位符（工作流里所有文本框通用）：<br />
              <span className="font-mono">{"{query}"}</span> 上游参数 · <span className="font-mono">{"{var:名称}"}</span> 变量 · <span className="font-mono">{"{clipboard}"}</span> 剪贴板<br />
              <span className="font-mono">{"{date}"}</span> 日期（默认 YYYY-MM-DD，可写 <span className="font-mono">{"{date:YYYY年MM月DD日 ddd}"}</span>）<br />
              <span className="font-mono">{"{time}"}</span> 时间（默认 HH:mm:ss，同样可自定义格式）<br />
              <span className="font-mono">{"{random}"}</span> 随机数（<span className="font-mono">{"{random:1-100}"}</span> 范围 · <span className="font-mono">{"{random:uuid}"}</span> · <span className="font-mono">{"{random:hex8}"}</span> · <span className="font-mono">{"{random:str6}"}</span>）
            </div>
          </>) : null}
          {node.type === "utility.conditional" ? (<>
            <div className="text-[11.5px] text-muted">从上往下逐条判断，命中哪条就走哪个出口；全不中走「否则」。出口没连线时链路自然结束。</div>
            <RulesEditor rules={(c.rules as Rule[]) || []} onChange={(r) => set("rules", r)} />
          </>) : null}
          {node.type === "utility.transform" ? (<>
            <div><span className={lab}>作用对象（留空=作用于参数 arg）</span>
              <input className={`${inp} font-mono`} value={String(c.target || "")} onChange={(e) => set("target", e.target.value)} placeholder="变量名，留空则改参数" /></div>
            <div><span className={lab}>变换方式</span>
              <select className={inp} value={String(c.mode || "upper")} onChange={(e) => set("mode", e.target.value)}>
                <option value="upper">全部大写</option><option value="lower">全部小写</option><option value="title">首字母大写</option>
                <option value="trim">去掉首尾空白</option><option value="urlencode">URL 编码</option><option value="urldecode">URL 解码</option>
                <option value="base64encode">Base64 编码</option><option value="base64decode">Base64 解码</option>
              </select></div>
          </>) : null}
          {node.type === "utility.replace" ? (<>
            <div><span className={lab}>作用对象（留空=作用于参数 arg）</span>
              <input className={`${inp} font-mono`} value={String(c.target || "")} onChange={(e) => set("target", e.target.value)} placeholder="变量名，留空则改参数" /></div>
            <div><span className={lab}>查找</span><input className={`${inp} font-mono`} value={String(c.find || "")} onChange={(e) => set("find", e.target.value)} /></div>
            <div><span className={lab}>替换为</span><input className={`${inp} font-mono`} value={String(c.to || "")} onChange={(e) => set("to", e.target.value)} /></div>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={!!c.regex} onChange={(e) => set("regex", e.target.checked)} />按正则表达式</label>
              <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={!!c.ci} onChange={(e) => set("ci", e.target.checked)} />忽略大小写</label>
            </div>
          </>) : null}
          {node.type === "utility.delay" ? (
            <div><span className={lab}>延时秒数（上限 60 秒）</span>
              <input className={inp} type="number" min={0} max={60} step={0.5} value={Number(c.seconds ?? 1)} onChange={(e) => set("seconds", Number(e.target.value))} /></div>
          ) : null}
          {node.type === "utility.debug" ? (<>
            <div><span className={lab}>打点文本（{"{query}"}=参数，{"{var:名称}"}=变量，{"{variables}"}=全部变量转储）</span>
              <textarea className={`${inp} font-mono h-[70px] resize-y`} value={String(c.text ?? "")} onChange={(e) => set("text", e.target.value)} placeholder="{query}" /></div>
            <div><span className={lab}>打完之后</span>
              <select className={inp} value={String(c.after || "pass")} onChange={(e) => set("after", e.target.value)}>
                <option value="pass">把入参原样传给下游（默认）</option>
                <option value="replace">把打点文本作为下游参数</option>
              </select></div>
            <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={!!c.clear} onChange={(e) => set("clear", e.target.checked)} />执行到这里时先清空本工作流的调试记录</label>
            <div className="text-[11px] text-muted">文本会出现在顶栏「🐞 调试」抽屉里这个节点下面，和脚本输出同一个位置。变量名里带 key/token/password 这类词的值会自动打码。</div>
          </>) : null}
          {node.type === "utility.split" ? (<>
            <div><span className={lab}>按什么拆</span>
              <div className="flex gap-2">
                <select className={inp} value={String(c.with || "comma")} onChange={(e) => set("with", e.target.value)}>
                  <option value="comma">逗号 ,</option><option value="space">空格</option><option value="tab">制表符 Tab</option><option value="newline">换行</option>
                  <option value="custom">自定义…</option>
                </select>
                {String(c.with || "comma") === "custom" ? (
                  <input className={`${inp} font-mono flex-1`} value={String(c.custom || "")} onChange={(e) => set("custom", e.target.value)} placeholder="如 ; 或 \n" />
                ) : null}
              </div></div>
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={c.trim !== false} onChange={(e) => set("trim", e.target.checked)} />去掉每一项两端的空白</label>
              <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={!!c.discardEmpty} onChange={(e) => set("discardEmpty", e.target.checked)} />丢掉空项</label>
            </div>
            <div><span className={lab}>输出方式</span>
              <select className={inp} value={String(c.output || "vars")} onChange={(e) => set("output", e.target.value)}>
                <option value="vars">写成变量（参数原样传给下游）</option>
                <option value="args">作为参数列表（下游逐条执行一遍）</option>
              </select></div>
            {String(c.output || "vars") === "args" ? (
              <div className="text-[11px] text-muted">下游会按拆出的每一项各跑一遍，串行且保持原顺序；末端接一个「Join 合并参数」就能再并回一条。一次最多 200 项，超出部分会被丢弃。</div>
            ) : (<>
              <div><span className={lab}>变量前缀</span>
                <input className={`${inp} font-mono`} value={String(c.prefix || "")} onChange={(e) => set("prefix", e.target.value)} placeholder="split" /></div>
              <div className="text-[11px] text-muted">拆出的项写成 <span className="font-mono">{`{var:${String(c.prefix || "split")}1}`}</span>、<span className="font-mono">{`{var:${String(c.prefix || "split")}2}`}</span>… 另有 <span className="font-mono">{`{var:${String(c.prefix || "split")}Count}`}</span> 记总项数；参数本身不变。</div>
            </>)}
          </>) : null}
          {node.type === "utility.join" ? (<>
            <div><span className={lab}>用什么连接</span>
              <div className="flex gap-2">
                <select className={inp} value={String(c.with || "newline")} onChange={(e) => set("with", e.target.value)}>
                  <option value="comma">逗号 ,</option><option value="space">空格</option><option value="tab">制表符 Tab</option><option value="newline">换行</option>
                  <option value="custom">自定义…</option>
                </select>
                {String(c.with || "newline") === "custom" ? (
                  <input className={`${inp} font-mono flex-1`} value={String(c.custom || "")} onChange={(e) => set("custom", e.target.value)} placeholder="如 ; 或 \n" />
                ) : null}
              </div></div>
            <div className="text-[11px] text-muted">把上游「Split 拆分参数（参数列表）」扇出的多条参数收集起来，等最后一项到齐后连成一条再往下传。上游不是这种扇出时（只有单项），入参原样透传。</div>
          </>) : null}
          {node.type === "output.writefile" ? (<>
            <div><span className={lab}>文件名 / 路径（支持 ~、{"{query}"}、{"{date}"} 等占位符）</span>
              <input className={`${inp} font-mono`} value={String(c.path || "")} onChange={(e) => set("path", e.target.value)} placeholder="notes-{date}.md" />
              <div className="text-[11px] text-muted mt-1">填相对路径就写到本工作流的 data 目录里（脚本读得到，整包拷走时也跟着走）；要放别处就写绝对路径。</div></div>
            <div><span className={lab}>内容（留空视为空文件）</span>
              <textarea className={`${inp} font-mono h-[70px] resize-y`} value={String(c.content ?? "")} onChange={(e) => set("content", e.target.value)} placeholder="{query}" /></div>
            <div><span className={lab}>文件已存在时</span>
              <select className={inp} value={String(c.ifExists || "overwrite")} onChange={(e) => set("ifExists", e.target.value)}>
                <option value="overwrite">覆盖</option><option value="append">追加到末尾</option>
                <option value="unique">另存为 名称-1.后缀</option><option value="skip">什么都不做</option>
              </select></div>
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={!!c.uuid} onChange={(e) => set("uuid", e.target.checked)} />文件名后加一段 UUID（每次都是新文件）</label>
              <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={c.mkdirs !== false} onChange={(e) => set("mkdirs", e.target.checked)} />自动创建中间目录</label>
              <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={!!c.allowEmpty} onChange={(e) => set("allowEmpty", e.target.checked)} />允许写空文件（不勾则内容为空时中止）</label>
            </div>
            <div className="text-[11px] text-muted">写完后，最终的绝对路径会作为参数传给下游 —— 接「打开文件」或「复制」就顺手了。</div>
          </>) : null}
          {node.type === "action.ask_assistant" ? (<>
            <div><span className={lab}>发给秘书的内容（{"{query}"}=上游参数）</span>
              <textarea className={`${inp} h-[70px] resize-y`} value={String(c.prompt || "")} onChange={(e) => set("prompt", e.target.value)} placeholder="{query}" /></div>
            <div><span className={lab}>文本视图标题（可选）</span><input className={inp} value={String(c.title || "")} onChange={(e) => set("title", e.target.value)} placeholder="秘书" /></div>
            <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={c.show !== false} onChange={(e) => set("show", e.target.checked)} />打开文本视图展示（等待期间显示加载动画）</label>
            <div className="text-[11px] text-muted">秘书的回复会作为参数继续传给下游节点。</div>
          </>) : null}
          {node.type === "action.create_task" ? (<>
            <div><span className={lab}>任务内容（{"{query}"}=上游参数）</span>
              <textarea className={`${inp} h-[60px] resize-y`} value={String(c.text || "")} onChange={(e) => set("text", e.target.value)} placeholder="{query}" /></div>
            <div><span className={lab}>发给秘书时加的前缀</span><input className={inp} value={String(c.prefix ?? "")} onChange={(e) => set("prefix", e.target.value)} placeholder="帮我建个任务：" /></div>
            <div className="text-[11px] text-muted">说明：服务端目前没有独立的建任务接口，这里是「发给秘书 + 建任务前缀」的薄封装，真正建任务由秘书调工具完成。</div>
          </>) : null}
          {node.type === "action.device_skill" ? (<>
            <div><span className={lab}>设备 ID（留空=自动挑一台有该技能的在线设备）</span>
              <input className={`${inp} font-mono`} value={String(c.device || "")} onChange={(e) => set("device", e.target.value)} placeholder="留空自动选择" /></div>
            <div className="flex gap-1.5">
              <div className="flex-1"><span className={lab}>provider</span><input className={`${inp} font-mono`} value={String(c.provider || "")} onChange={(e) => set("provider", e.target.value)} placeholder="如 pc" /></div>
              <div className="flex-1"><span className={lab}>skill</span><input className={`${inp} font-mono`} value={String(c.skill || "")} onChange={(e) => set("skill", e.target.value)} placeholder="技能名" /></div>
            </div>
            <div><span className={lab}>参数（JSON，{"{query}"} / {"{var:名称}"} 会按 JSON 字符串转义后插入）</span>
              <textarea className={`${inp} font-mono h-[70px] resize-y`} value={String(c.params || "")} onChange={(e) => set("params", e.target.value)} placeholder={`{"text": "{query}"}`} /></div>
            <div className="text-[11px] text-muted">执行结果会作为参数继续传给下游节点；派发失败会中止这条链路。</div>
          </>) : null}
          {node.type === "output.textview" ? (<>
            <div><span className={lab}>标题（可选，留空用工作流名）</span><input className={inp} value={String(c.title || "")} onChange={(e) => set("title", e.target.value)} /></div>
            <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={c.markdown !== false} onChange={(e) => set("markdown", e.target.checked)} />按 Markdown 渲染</label>
            <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={!!c.append} onChange={(e) => set("append", e.target.checked)} />追加到已有内容（流式续写，不清屏）</label>
          </>) : null}
          {["action.copy", "action.paste", "action.assistant", "action.inspiration", "output.notify", "output.largetype"].includes(node.type) ? (
            <div className="text-[12px] text-muted">{node.type === "output.largetype" ? "大字显示：把上游内容放大居中显示在半透明浮层里。" : "此动作无需额外配置，直接使用上游传入的内容（arg）。"}</div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button className="px-[14px] py-[7px] border border-border rounded-lg text-[12.5px]" onClick={onClose}>取消</button>
          <button className="px-[14px] py-[7px] bg-orange text-white rounded-lg text-[12.5px] font-semibold" onClick={() => onSave(c)}>保存</button>
        </div>
      </div>
    </div>
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
  const cell = "bg-bg border border-border rounded-md px-[7px] py-[5px] text-[12px] outline-none";
  const setAt = (i: number, k: keyof ListRow, v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  // 上移/下移：列表顺序就是结果顺序（没输入时整表按这个顺序出），所以得能调。
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const next = rows.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const doImport = (replace: boolean) => {
    // 每行按 [标题, 副标题, 参数, 图标] 取，只有一列时参数留空（执行时自动回落成标题）。
    const parsed = parseCsv(csv).map((r) => ({ title: (r[0] || "").trim(), subtitle: (r[1] || "").trim(), arg: (r[2] || "").trim(), icon: (r[3] || "").trim() }))
      .filter((r) => r.title || r.arg);
    if (!parsed.length) return;
    onChange(replace ? parsed : [...rows, ...parsed]);
    setCsv(""); setImporting(false);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1 text-[10.5px] text-muted px-[2px]">
        <span className="w-[34px] shrink-0">图标</span><span className="flex-1">标题</span><span className="flex-1">副标题</span><span className="flex-1">参数（留空=用标题）</span><span className="w-[54px] shrink-0" />
      </div>
      <div className="max-h-[220px] overflow-y-auto flex flex-col gap-1 pr-1">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-1 items-center">
            <input className={`${cell} w-[34px] text-center`} value={String(r.icon || "")} onChange={(e) => setAt(i, "icon", e.target.value)} placeholder="🔹" />
            <input className={`${cell} flex-1 min-w-0`} value={String(r.title || "")} onChange={(e) => setAt(i, "title", e.target.value)} />
            <input className={`${cell} flex-1 min-w-0`} value={String(r.subtitle || "")} onChange={(e) => setAt(i, "subtitle", e.target.value)} />
            <input className={`${cell} flex-1 min-w-0 font-mono`} value={String(r.arg || "")} onChange={(e) => setAt(i, "arg", e.target.value)} />
            <div className="w-[54px] shrink-0 flex gap-[2px] justify-end">
              <button className="w-[16px] text-[10px] text-muted hover:text-fg" title="上移" onClick={() => move(i, -1)}>↑</button>
              <button className="w-[16px] text-[10px] text-muted hover:text-fg" title="下移" onClick={() => move(i, 1)}>↓</button>
              <button className="w-[16px] text-[11px] text-muted hover:text-red-400" title="删除这一项" onClick={() => onChange(rows.filter((_, j) => j !== i))}>✕</button>
            </div>
          </div>
        ))}
        {!rows.length ? <div className="text-[11.5px] text-muted py-2">还没有条目，点下面「添加一项」或用 CSV 批量导入。</div> : null}
      </div>
      <div className="flex gap-2">
        <button className="px-[10px] py-[5px] border border-border rounded-lg text-[11.5px]" onClick={() => onChange([...rows, { title: "", subtitle: "", arg: "" }])}>＋ 添加一项</button>
        <button className="px-[10px] py-[5px] border border-border rounded-lg text-[11.5px]" onClick={() => setImporting((v) => !v)}>{importing ? "收起导入" : "CSV 批量导入…"}</button>
      </div>
      {importing ? (<>
        <textarea className="w-full bg-bg border border-border rounded-lg px-[10px] py-[7px] text-[12px] font-mono h-[84px] resize-y outline-none"
          value={csv} onChange={(e) => setCsv(e.target.value)}
          placeholder={'每行一项：标题,副标题,参数,图标（后三列可省）\n含逗号的字段用双引号包起来'} />
        <div className="flex gap-2">
          <button className="px-[10px] py-[5px] border border-border rounded-lg text-[11.5px]" disabled={!csv.trim()} onClick={() => doImport(false)}>追加导入</button>
          <button className="px-[10px] py-[5px] border border-border rounded-lg text-[11.5px]" disabled={!csv.trim()} onClick={() => doImport(true)}>替换全部</button>
        </div>
      </>) : null}
    </div>
  );
}

// ── 工作流变量编辑（可存密钥）──
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

function VarsEditor({ vars, onSave, onClose }: { vars: Record<string, string>; onSave: (v: Record<string, string>) => void; onClose: () => void }) {
  const [rows, setRows] = useState<{ k: string; v: string }[]>(Object.entries(vars).map(([k, v]) => ({ k, v })));
  // 手动「临时显形」的行下标：只影响当前这次弹框，关掉再打开又变回密文。
  const [shown, setShown] = useState<Set<number>>(new Set());
  const inp = "bg-bg border border-border rounded-lg px-[9px] py-[6px] text-[12.5px] outline-none font-mono";
  const secret = (k: string) => /key|secret|token|pass/i.test(k);
  const toggleShow = (i: number) =>
    setShown((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div className="w-[460px] bg-card border border-border rounded-2xl p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="font-semibold text-[14px] mb-1">工作流变量</div>
        <div className="text-[11.5px] text-muted mb-3">注入脚本环境变量；可存 appKey / secret 等密钥（仅本地，不上传）。脚本里用 {"{var:名称}"} 或直接读同名环境变量。</div>
        <div className="flex flex-col gap-2 mb-3">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className={`${inp} w-[130px]`} value={r.k} placeholder="名称" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
              <input className={`${inp} flex-1`} type={secret(r.k) && !shown.has(i) ? "password" : "text"} value={r.v} placeholder="值" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
              {/* 只有被判定为密钥的行才需要显隐切换；其余行本来就是明文 */}
              {secret(r.k) ? (
                <button className="text-muted text-[13px] leading-none w-[20px]" title={shown.has(i) ? "隐藏" : "显示"} onClick={() => toggleShow(i)}>
                  {shown.has(i) ? "🙈" : "👁"}
                </button>
              ) : (
                <span className="w-[20px]" />
              )}
              <button className="text-danger text-[12px]" onClick={() => { setRows(rows.filter((_, j) => j !== i)); setShown(new Set()); }}>✕</button>
            </div>
          ))}
        </div>
        <button className="text-[12.5px] text-muted border border-dashed border-border rounded-lg px-3 py-1.5" onClick={() => setRows([...rows, { k: "", v: "" }])}>＋ 加一行</button>
        <div className="flex justify-end gap-2 mt-5">
          <button className="px-[14px] py-[7px] border border-border rounded-lg text-[12.5px]" onClick={onClose}>取消</button>
          <button className="px-[14px] py-[7px] bg-orange text-white rounded-lg text-[12.5px] font-semibold"
            onClick={() => { const v: Record<string, string> = {}; for (const r of rows) if (r.k.trim()) v[r.k.trim()] = r.v; onSave(v); }}>保存</button>
        </div>
      </div>
    </div>
  );
}

// ── 工作流配置项（W10 Configuration 分层）──
// 上半张表是「作者视角」：声明有哪些配置项（键名/显示名/类型/默认值/说明）。
// 下半是「使用者视角」：直接在同一行把值填了。值统一写回 variables，脚本里 {var:键名} 照旧。
// password 类型的值不进工作流 JSON：保存时先塞进密码保险箱，variables 里只留 vault://... 引用。
function ConfigEditor({ wf, onSave, onClose }: {
  wf: WF;
  onSave: (fields: WFConfigField[], vals: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [fields, setFields] = useState<WFConfigField[]>(() => (wf.config || []).map((f) => ({ ...f })));
  const [vals, setVals] = useState<Record<string, string>>(() => ({ ...(wf.variables || {}) }));
  // 密钥输入框里新敲的明文（还没存进保险箱）。undefined = 没动过，保持原引用。
  const [pw, setPw] = useState<Record<string, string>>({});
  const [unlocked, setUnlocked] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.vaultUnlocked().then(setUnlocked).catch(() => setUnlocked(false)); }, []);

  const inp = "bg-bg border border-border rounded-lg px-[9px] py-[6px] text-[12.5px] outline-none";
  const patch = (i: number, p: Partial<WFConfigField>) => setFields(fields.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const setVal = (k: string, v: string) => setVals({ ...vals, [k]: v });

  // 保存：先把改过的密钥逐个存进保险箱换回引用，任何一步失败就整体中止（不留半截状态）。
  const save = async () => {
    setBusy(true); setErr("");
    const list = fields.filter((f) => f.key.trim()).map((f) => ({ ...f, key: f.key.trim(), label: (f.label || "").trim() || f.key.trim() }));
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

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div className="w-[620px] max-h-[80vh] overflow-auto bg-card border border-border rounded-2xl p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="font-semibold text-[14px] mb-1">工作流配置</div>
        <div className="text-[11.5px] text-muted mb-3 leading-[1.6]">
          声明这个工作流需要人填的东西，填出来的值同样按 {"{var:键名}"} / 同名环境变量注入。
          「密钥」类型的值只存进密码保险箱，工作流 JSON（含导出文件）里只有一条引用，不含明文。
        </div>
        {!unlocked ? (
          <div className="text-[11.5px] text-orange border border-orange/40 bg-orange/10 rounded-lg px-3 py-2 mb-3">
            密码保险箱当前是锁定的：可以照常改声明，但新填的密钥要先解锁保险箱才能保存。
          </div>
        ) : null}

        <div className="flex flex-col gap-2.5 mb-3">
          {fields.map((f, i) => {
            const bound = String(vals[f.key] || "").startsWith("vault://");
            return (
              <div key={i} className="border border-border rounded-xl p-2.5 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <input className={`${inp} w-[120px] font-mono`} value={f.key} placeholder="键名" onChange={(e) => patch(i, { key: e.target.value })} />
                  <input className={`${inp} w-[110px]`} value={f.label} placeholder="显示名" onChange={(e) => patch(i, { label: e.target.value })} />
                  <select className={`${inp} w-[86px]`} value={f.type} onChange={(e) => patch(i, { type: e.target.value as WFConfigField["type"] })}>
                    <option value="text">文本</option>
                    <option value="password">密钥</option>
                    <option value="file">路径</option>
                    <option value="select">下拉</option>
                    <option value="checkbox">开关</option>
                  </select>
                  <input className={`${inp} flex-1`} value={f.help || ""} placeholder="说明（可选）" onChange={(e) => patch(i, { help: e.target.value })} />
                  <button className="text-danger text-[12px] px-1" title="删除该配置项" onClick={() => setFields(fields.filter((_, j) => j !== i))}>✕</button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11.5px] text-muted w-[36px] shrink-0">值</span>
                  {f.type === "password" ? (
                    <input className={`${inp} flex-1`} type="password" value={pw[f.key] ?? ""}
                      placeholder={bound ? "已存入保险箱（留空=不改，输入=覆盖）" : "输入后保存即存进保险箱"}
                      onChange={(e) => setPw({ ...pw, [f.key]: e.target.value })} />
                  ) : f.type === "checkbox" ? (
                    <label className="flex items-center gap-1.5 text-[12px] text-muted flex-1">
                      <input type="checkbox" checked={(vals[f.key] ?? f.default ?? "") === "1"} onChange={(e) => setVal(f.key, e.target.checked ? "1" : "")} />
                      开启时值为 1，关闭时为空
                    </label>
                  ) : f.type === "select" ? (
                    <select className={`${inp} flex-1`} value={vals[f.key] ?? f.default ?? ""} onChange={(e) => setVal(f.key, e.target.value)}>
                      <option value="">（未选）</option>
                      {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input className={`${inp} flex-1`} value={vals[f.key] ?? ""} placeholder={f.default ? `默认：${f.default}` : "值"} onChange={(e) => setVal(f.key, e.target.value)} />
                  )}
                  {f.type === "file" ? (
                    <button className="px-[10px] py-[6px] border border-border rounded-lg text-[12px] shrink-0"
                      onClick={async () => { const p = await api.pickPath(); if (p) setVal(f.key, p); }}>选择</button>
                  ) : null}
                  {f.type === "select" ? (
                    <input className={`${inp} w-[180px] shrink-0`} value={(f.options || []).join(",")} placeholder="候选项，逗号分隔"
                      onChange={(e) => patch(i, { options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
                  ) : f.type !== "password" ? (
                    <input className={`${inp} w-[120px] shrink-0`} value={f.default || ""} placeholder="默认值"
                      onChange={(e) => patch(i, { default: e.target.value })} />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        <button className="text-[12.5px] text-muted border border-dashed border-border rounded-lg px-3 py-1.5"
          onClick={() => setFields([...fields, { key: "", label: "", type: "text" }])}>＋ 加一项</button>
        {err ? <div className="text-[12px] text-danger mt-3">{err}</div> : null}
        <div className="flex justify-end gap-2 mt-5">
          <button className="px-[14px] py-[7px] border border-border rounded-lg text-[12.5px]" onClick={onClose}>取消</button>
          <button className="px-[14px] py-[7px] bg-orange text-white rounded-lg text-[12.5px] font-semibold" disabled={busy} onClick={() => void save()}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
