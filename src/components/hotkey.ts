// 快捷键录制与显示 —— **全项目唯一实现**。
//
// 这之前有三份各写各的：`shell.ts` 的 beginShortcutRecording（剪贴板/截图）、
// `ui.tsx` 的 toAccelerator（快捷入口/常用语/保险箱）、`nodeform.tsx` 里
// HotkeyField 内联的一份（工作流 Hotkey 节点）。只有第一份是对的，后两份
// 都踩了下面第 ① 条，于是同一个动作在不同页面表现不一样。新加录制入口一律用这里。
//
// ── ① 主键必须从 e.code 取，绝不能用 e.key ────────────────────────────────
// `e.key` 是**按下这些修饰键之后实际产生的字符**。在 macOS 上 Option 会改字符：
//   Option+Shift+V     → e.key === "◊"          （界面上就显示成一个菱形）
//   Option+Shift+Space → e.key === " "（窄不换行空格，看不见）
// 于是存进配置的是 "Alt+Shift+◊"，主进程 parseAccel 认不出来 → 「键位写法不对」，
// 而用户明明按的是 V。`e.code` 是**物理键位**（KeyV / Space），不受修饰键影响。
//
// ── ② 但 e.code 是「QWERTY 上那个位置」，不是键帽上印的字 ──────────────────
// AZERTY 上按键帽 A 的键，e.code 是 "KeyQ"。所以拿到 code 之后再用
// `navigator.keyboard.getLayoutMap()` 翻成当前布局的实际字符 —— 这个 API
// 给的是**不带修饰键**的字符，正好是我们要的。取不到就退回按 code 推断
// （非 QWERTY 布局会略有偏差，但总比录出一个菱形强）。
//
// ── ③ 存储格式不变 ────────────────────────────────────────────────────────
// 落库/传给 globalShortcut 的一律是 Electron Accelerator（"Alt+Shift+V"）。
// 这里只负责「录成它」和「显示得像样」，两件事分开：显示层再花哨也别污染存储值，
// 主进程 hotkey.ts 的 parseAccel 只认 Accelerator。

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent || "");

/** code → 当前键盘布局上的字符。取不到布局时为 null（退回按 code 推断）。 */
export type LayoutMap = Map<string, string> | null;

/**
 * 读一次当前键盘布局。**在开始录制时调**，别在 keydown 里调——它是异步的。
 * 浏览器/系统不支持时返回 null，调用方照常工作。
 */
export async function readLayout(): Promise<LayoutMap> {
  try {
    const kb = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
    if (!kb?.getLayoutMap) return null;
    return await kb.getLayoutMap();
  } catch {
    return null;
  }
}

// 物理键 → Electron Accelerator 主键。这里列的每一个都是 parseAccel 认的写法
// （electron/core/launcher/hotkey.ts 的 KEY_ALIAS / 正则），改这张表要同步改那边。
const CODE_KEY: Record<string, string> = {
  Space: "Space",
  Enter: "Return", NumpadEnter: "Return",
  Escape: "Escape", Tab: "Tab",
  Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  // 标点：布局取不到时的兜底写法（美式布局的键帽字符）。
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
  // 小键盘。Electron 的写法是全小写的 num* 系列。
  NumpadAdd: "numadd", NumpadSubtract: "numsub",
  NumpadMultiply: "nummult", NumpadDivide: "numdiv", NumpadDecimal: "numdec",
};

/**
 * 物理键 code → Accelerator 主键。认不出来返回 null（这次按键不算录完，继续等）。
 *
 * 只按修饰键时 code 是 ShiftLeft / MetaRight 之类，一律返回 null ——
 * 「按住 Command 想想按哪个键」不该被当成录完了。
 */
export function mainKeyFromCode(code: string, layout?: LayoutMap): string | null {
  if (!code) return null;
  if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code)) return null;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;          // F1~F24 原样
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;

  const letter = /^Key([A-Z])$/.exec(code);
  const digit = /^Digit([0-9])$/.exec(code);
  if (letter || digit) {
    // 布局优先：AZERTY 上物理 KeyQ 的键帽是 A，用户想录的是他看见的那个字母。
    const ch = asciiOf(layout, code);
    if (ch) return ch;
    return letter ? letter[1] : digit![1];
  }

  const fixed = CODE_KEY[code];
  if (fixed) {
    // 标点也让布局说了算（法式键盘上 Semicolon 那个位置是 M）。
    if (fixed.length === 1) {
      const ch = asciiOf(layout, code);
      if (ch) return ch;
    }
    return fixed;
  }
  return null;
}

/**
 * 布局表里的字符，**只在它是可打印 ASCII 时才采用**。
 *
 * Electron 的 Accelerator 只认 ASCII 键名：德语键盘上 Minus 那个位置是 ß，
 * 照搬进去 globalShortcut 根本注册不上，用户会得到一个「看着像设好了、
 * 按下去没反应」的快捷键 —— 最难查的那一类。这时退回物理键位（Minus → "-"），
 * 至少是个真能注册的键。
 */
function asciiOf(layout: LayoutMap | undefined, code: string): string | null {
  const ch = layout?.get(code);
  if (!ch || ch.length !== 1) return null;
  if (!/^[\x21-\x7E]$/.test(ch)) return null;
  return ch.toUpperCase();
}

/**
 * 键盘事件 → Electron Accelerator。修饰键顺序固定成 Command→Control→Alt→Shift，
 * 跟主进程 hotkey.ts 的 MOD_ORDER 一致，两边比对才不会漏。
 *
 * 返回 null = 这次按键还不能收尾（只按了修饰键，或按了个认不出来的键）。
 * **不在这里校验「至少要有一个修饰键」**：那是能不能注册的问题，由主进程
 * checkAccel 统一判并给文案，录制层管录不管评。
 */
export function toAccelerator(e: KeyboardEvent, layout?: LayoutMap): string | null {
  const key = mainKeyFromCode(e.code, layout);
  if (!key) return null;
  const mods: string[] = [];
  if (e.metaKey) mods.push("Command");
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}

// ── 显示 ────────────────────────────────────────────────────────────────────
//
// 存的是 "Alt+Shift+V"，但 Mac 用户按的键帽上写的是 option，菜单里长这样：⌥⇧V。
// 在 Mac 上照搬 "Alt" 是错的（那是 Windows 的叫法），用户会去找一个不存在的键。

const MAC_MOD: Record<string, string> = {
  Command: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧",
};
// Windows / Linux 上的写法。Command 键在这些平台上是 Win / Super。
const PC_MOD: Record<string, string> = {
  Command: "Win", Control: "Ctrl", Alt: "Alt", Shift: "Shift",
};
// Apple 菜单里修饰键的固定顺序是 ⌃⌥⇧⌘，跟存储顺序不一样，显示时要重排。
const MAC_ORDER = ["Control", "Alt", "Shift", "Command"];
const PC_ORDER = ["Command", "Control", "Alt", "Shift"];

// 主键的符号写法。**只在 Mac 上用符号** —— Windows 用户看 ↩ ⌫ 反而认不出。
const MAC_KEY: Record<string, string> = {
  Return: "↩", Escape: "⎋", Tab: "⇥", Backspace: "⌫", Delete: "⌦",
  Up: "↑", Down: "↓", Left: "←", Right: "→",
  Space: "Space",   // ␣ 太生僻，还是写字
};

const MOD_ALIAS: Record<string, string> = {
  command: "Command", cmd: "Command", meta: "Command", super: "Command",
  commandorcontrol: "Command", cmdorctrl: "Command",
  control: "Control", ctrl: "Control",
  alt: "Alt", option: "Alt", opt: "Alt",
  shift: "Shift",
};

/**
 * Accelerator → 给人看的写法。Mac 出 `⌥⇧V`，其余平台出 `Alt+Shift+V`。
 *
 * 认不出来的部分原样保留：显示层遇到没见过的写法应该照实显示，
 * 而不是吞掉——吞掉之后用户看到的键位和实际存的对不上，比难看糟得多。
 */
export function displayAccel(acc: string, isMac: boolean = IS_MAC): string {
  if (!acc) return "";
  const mods: string[] = [];
  const rest: string[] = [];
  for (const raw of acc.split("+")) {
    const part = raw.trim();
    if (!part) continue;
    const m = MOD_ALIAS[part.toLowerCase()];
    if (m) { if (!mods.includes(m)) mods.push(m); } else rest.push(part);
  }
  const order = isMac ? MAC_ORDER : PC_ORDER;
  const table = isMac ? MAC_MOD : PC_MOD;
  const head = order.filter((m) => mods.includes(m)).map((m) => table[m]);
  const tail = rest.map((k) => (isMac ? MAC_KEY[k] : undefined) ?? k);
  // Mac 的修饰键符号连写不加号（⌥⇧V），键名之间仍要加号（⌥⇧+F1 反而难读，
  // 所以主键也直接连上）；其余平台一律加号。
  return isMac ? [...head, ...tail].join("") : [...head, ...tail].join("+");
}
