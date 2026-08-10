// 全局快捷键的冲突检测。
//
// ── 为什么不能只靠 globalShortcut.register 的返回值 ──────────────────────────
// 直觉上「注册一下，成功就是没被占」应该够了。实际不够，而且差得很远：
//   · macOS 上注册 Command+Space 通常**返回 true**，但按下去永远是 Spotlight ——
//     系统级快捷键在更底层就被截走了，Electron 根本收不到。于是用户配了一个
//     「注册成功」的快捷键，按下去毫无反应，还完全不知道为什么。这是最糟的一类失败：
//     没有任何报错，只是不工作。
//   · 反过来，注册失败也不一定是被别人占了 —— 有可能是我们自己刚注册过。
// 所以这里是两条证据合起来判断：
//   1. 一张**已知系统快捷键表**（下面这张），管住 register 探测不出来的那类；
//   2. register 探测，管住第三方应用占用的那类。
// 两条都过不了才算「可用」。表肯定列不全，但列出来的每一条都是实打实会静默失效的。
//
// 这个模块本身不 import electron：表和归一化是纯逻辑，能单测；
// 真正要探测时由调用方把 globalShortcut 传进来。

// 修饰键的规范顺序。归一化时按这个顺序排，"Shift+Command+K" 和 "Command+Shift+K"
// 才会被认成同一个键 —— 否则查表和比对全都会漏。
const MOD_ORDER = ["Command", "Control", "Alt", "Shift"] as const;

// 各种写法 → 规范名。Electron 自己也认多种别名，我们在比对前先统一。
const MOD_ALIAS: Record<string, string> = {
  command: "Command", cmd: "Command", super: "Command", meta: "Command",
  commandorcontrol: "Command", cmdorctrl: "Command",
  control: "Control", ctrl: "Control",
  alt: "Alt", option: "Alt", opt: "Alt",
  shift: "Shift",
};

// 主键的别名。方向键和空格写法最杂，统一到 Electron 的写法上。
const KEY_ALIAS: Record<string, string> = {
  esc: "Escape", escape: "Escape",
  enter: "Return", return: "Return",
  space: "Space", spacebar: "Space",
  del: "Delete", delete: "Delete", backspace: "Backspace",
  up: "Up", down: "Down", left: "Left", right: "Right",
  arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right",
  tab: "Tab", plus: "Plus",
  // 下面这些是录制器（src/components/hotkey.ts 的 CODE_KEY）会吐出来的，
  // 这张表不认的话，用户明明按了 Home，界面上却报「键位写法不对」。
  // 两张表要一起改。
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", insert: "Insert",
  numadd: "numadd", numsub: "numsub", nummult: "nummult",
  numdiv: "numdiv", numdec: "numdec",
};

export interface Accel {
  mods: string[];
  key: string;
  /** 规范写法，用来查表与相互比对 */
  id: string;
}

// 把用户录到的键位串归一化。认不出来时返回 null（调用方据此报「键位不合法」）。
export function parseAccel(raw: string): Accel | null {
  const parts = String(raw || "").split("+").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const mods: string[] = [];
  let key = "";
  for (const p of parts) {
    const m = MOD_ALIAS[p.toLowerCase()];
    if (m) { if (!mods.includes(m)) mods.push(m); continue; }
    if (key) return null;                       // 出现了第二个主键：不是合法组合
    const k = KEY_ALIAS[p.toLowerCase()];
    if (k) { key = k; continue; }
    if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(p)) { key = p.toUpperCase(); continue; }
    if (/^num[0-9]$/i.test(p)) { key = p.toLowerCase(); continue; }   // 小键盘数字，Electron 写成 num0~num9
    // 单字符主键**必须是可打印 ASCII**。Electron 的 Accelerator 只认 ASCII 键名，
    // 非 ASCII 注册不上 —— 而 register() 未必报错，于是用户得到一个「看着设好了、
    // 按下去没反应」的快捷键。旧版录制器在 Mac 上录 Option+Shift+V 存的正是 "◊"
    // （Option 会改 e.key），这里拦下来，界面才会提示他重录一次。
    if (/^[\x21-\x7E]$/.test(p)) { key = p.toUpperCase(); continue; }
    return null;
  }
  if (!key) return null;
  mods.sort((a, b) => MOD_ORDER.indexOf(a as never) - MOD_ORDER.indexOf(b as never));
  return { mods, key, id: [...mods, key].join("+") };
}

// 系统已经占着的组合。value 是「谁占着」，直接显示给用户看。
// 只收录**按下去会被系统截走、我们完全收不到**的那些 —— 这类的表现是「静默失效」，
// 没有这张表用户就只能自己瞎试。
const SYSTEM_MAC: Record<string, string> = {
  "Command+Space": "聚焦搜索（Spotlight）",
  "Command+Alt+Space": "访达搜索窗口",
  "Control+Space": "切换输入法",
  "Control+Alt+Space": "切换输入法（上一个）",
  "Command+Tab": "切换应用",
  "Command+Shift+Tab": "切换应用（反向）",
  "Command+Shift+3": "截取整个屏幕",
  "Command+Shift+4": "截取选定区域",
  "Command+Shift+5": "截屏与录屏工具",
  "Command+Control+Q": "锁定屏幕",
  "Command+Alt+Escape": "强制退出",
  "Control+Up": "调度中心",
  "Control+Down": "应用窗口",
  "Control+Left": "切到左边的桌面",
  "Control+Right": "切到右边的桌面",
  "Command+Control+F": "全屏切换",
  "Command+Alt+D": "显示/隐藏程序坞",
};

const SYSTEM_WIN: Record<string, string> = {
  "Alt+Tab": "切换窗口",
  "Control+Alt+Delete": "安全选项",
  "Control+Shift+Escape": "任务管理器",
  "Alt+F4": "关闭窗口",
  "Control+Alt+Tab": "切换窗口（保持）",
};

// 不是系统占用，但几乎每个应用都在用。抢了能抢到，代价是你在**任何**应用里
// 按这个键都会跑工作流而不是它原本的功能 —— 比如抢了 Command+Q 之后就退不掉应用了。
// 单列一档而不是混进上面那张表：这类是「能用但你多半会后悔」，不是「用不了」。
const COMMON_MAC: Record<string, string> = {
  "Command+Q": "退出应用", "Command+W": "关闭窗口", "Command+C": "复制", "Command+V": "粘贴",
  "Command+X": "剪切", "Command+Z": "撤销", "Command+A": "全选", "Command+S": "保存",
  "Command+F": "查找", "Command+N": "新建", "Command+T": "新建标签页", "Command+P": "打印",
};
const COMMON_WIN: Record<string, string> = {
  "Control+C": "复制", "Control+V": "粘贴", "Control+X": "剪切", "Control+Z": "撤销",
  "Control+A": "全选", "Control+S": "保存", "Control+F": "查找", "Control+N": "新建",
  "Control+W": "关闭标签页", "Control+P": "打印",
};

export type AccelState =
  | "free"        // 可用
  | "invalid"     // 键位本身不合法（没有修饰键、或解析不出来）
  | "system"      // 系统占着，按下去收不到
  | "common"      // 能抢，但会打断日常操作
  | "self"        // Umbra 自己在别处已经用了这个键
  | "taken";      // 别的应用占着（注册探测失败）

export interface AccelCheck { state: AccelState; by?: string; }

// 只查表、不做注册探测的那一半。纯函数，可单测。
export function checkAccelTable(raw: string, platform: string = process.platform): AccelCheck {
  const a = parseAccel(raw);
  if (!a) return { state: "invalid", by: "键位写法不对" };
  // 功能键可以单独用（F1–F24 本来就不是打字用的）；其余必须带修饰键，
  // 否则等于把这个字母键在全系统范围内征用了，正常打字都会触发工作流。
  if (!a.mods.length && !/^F\d+$/.test(a.key)) return { state: "invalid", by: "至少要带一个修饰键" };
  const mac = platform === "darwin";
  const sys = (mac ? SYSTEM_MAC : SYSTEM_WIN)[a.id];
  if (sys) return { state: "system", by: sys };
  const common = (mac ? COMMON_MAC : COMMON_WIN)[a.id];
  if (common) return { state: "common", by: common };
  return { state: "free" };
}

// 探测的三态。self 必须和 taken 分开：Electron 的 register 对「自己已经注册过的键」
// 同样返回 false，混作一谈的话，我们会把自家快捷入口的键报成「被别的应用占用」，
// 用户照着提示去别处找占用方，永远找不到。
export type ProbeResult = "free" | "self" | "taken";

// 完整检测：先查表，表里没有再做一次注册探测。
// probe 由调用方注入（主进程传 globalShortcut 的包装），这样本模块不必 import electron。
// **探测注册完必须立刻注销** —— 留着的话用户还在配置界面上试键位，就已经把键抢过来了。
export function checkAccel(raw: string, probe: (id: string) => ProbeResult, platform: string = process.platform): AccelCheck {
  const table = checkAccelTable(raw, platform);
  if (table.state !== "free") return table;
  const a = parseAccel(raw)!;
  const p = probe(a.id);
  if (p === "free") return { state: "free" };
  if (p === "self") return { state: "self", by: "Umbra 自己" };
  return { state: "taken", by: "另一个应用" };
}

// 给界面用的一句话。措辞上刻意区分「不会触发」和「能触发但会打断别的事」——
// 这两件事的处理方式完全不同，混成一句「快捷键冲突」等于什么都没说。
export function accelMessage(r: AccelCheck, accel: string): string {
  switch (r.state) {
    case "invalid": return `${r.by || "键位不合法"}。`;
    case "system": return `${accel} 被系统占用（${r.by}），这条工作流不会被触发。换一个组合，或去系统设置里让出这个键。`;
    case "taken": return `${accel} 已经被${r.by || "别的程序"}占用，这条工作流不会被触发。`;
    case "self": return `${accel} 在 Umbra 里已经用在别处了（快捷入口、截屏、剪贴板或另一条工作流）。两处不能用同一个键。`;
    case "common": return `${accel} 是「${r.by}」的常用键。抢得到，但之后在任何应用里按它都会跑这条工作流。`;
    default: return "";
  }
}
