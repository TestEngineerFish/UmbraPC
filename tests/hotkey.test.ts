// 快捷键录制与显示。
//
// 这一套的存在理由就是 2026-08-09 那两个截图：
//   · 在 Mac 上录 Option+Shift+V，界面上显示成「Alt+Shift+◊」；
//   · 录 Option+Shift+Space，主键整个是空的，主进程报「键位写法不对」。
// 两处都因为主键取的是 e.key —— 而 Option 在 macOS 上**会改变产生的字符**。
// 下面每条断言都对着一个具体的踩坑现场。
import { describe, expect, it } from "vitest";

import { displayAccel, mainKeyFromCode, toAccelerator } from "../src/components/hotkey";
import { parseAccel } from "../electron/core/launcher/hotkey";

// 造一个键盘事件。key 传的是「macOS 上按下这些修饰键之后真正产生的字符」，
// 正是老实现会拿去当主键的那个值 —— 所有断言都要证明我们不再看它。
function ev(code: string, mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {}, key = "") {
  return {
    code, key,
    metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift,
  } as KeyboardEvent;
}

describe("toAccelerator", () => {
  it("Option+Shift+V 录成 Alt+Shift+V，不是那个菱形", () => {
    // macOS 实测：Option+Shift+V 的 e.key 就是 "◊"。
    expect(toAccelerator(ev("KeyV", { alt: true, shift: true }, "◊"))).toBe("Alt+Shift+V");
  });

  it("Option+Shift+Space 录成 Alt+Shift+Space", () => {
    // e.key 是窄不换行空格（U+202F），肉眼看不见，老实现录出来主键是空的。
    expect(toAccelerator(ev("Space", { alt: true, shift: true }, " "))).toBe("Alt+Shift+Space");
  });

  it("修饰键顺序固定 Command→Control→Alt→Shift（和主进程 MOD_ORDER 一致）", () => {
    expect(toAccelerator(ev("KeyK", { shift: true, alt: true, ctrl: true, meta: true })))
      .toBe("Command+Control+Alt+Shift+K");
  });

  it("只按修饰键不算录完", () => {
    for (const c of ["ShiftLeft", "ControlRight", "AltLeft", "MetaLeft"]) {
      expect(toAccelerator(ev(c, { shift: true }))).toBeNull();
    }
  });

  it("常用主键都认得", () => {
    const cases: [string, string][] = [
      ["KeyA", "A"], ["Digit7", "7"], ["F5", "F5"], ["F12", "F12"],
      ["Enter", "Return"], ["Escape", "Escape"], ["Tab", "Tab"],
      ["ArrowUp", "Up"], ["ArrowRight", "Right"],
      ["Backspace", "Backspace"], ["Delete", "Delete"],
      ["Home", "Home"], ["PageDown", "PageDown"],
      ["Minus", "-"], ["Backquote", "`"], ["Slash", "/"],
      ["Numpad3", "num3"], ["NumpadAdd", "numadd"],
    ];
    for (const [code, want] of cases) {
      expect(mainKeyFromCode(code), code).toBe(want);
    }
  });

  it("不认识的键返回 null，不硬编一个", () => {
    expect(mainKeyFromCode("MediaPlayPause")).toBeNull();
    expect(mainKeyFromCode("")).toBeNull();
  });

  it("有键盘布局时按键帽上的字来（AZERTY 的物理 KeyQ 印的是 A）", () => {
    const layout = new Map([["KeyQ", "a"], ["Digit1", "&"]]);
    expect(mainKeyFromCode("KeyQ", layout)).toBe("A");
    expect(mainKeyFromCode("Digit1", layout)).toBe("&");
  });

  it("没有布局表时退回按 code 推断，而不是整个失败", () => {
    expect(mainKeyFromCode("KeyQ", null)).toBe("Q");
  });
});

describe("录制出来的键位，主进程必须认", () => {
  // 这条是**跨进程契约**：录制器能吐出来的每一种主键，parseAccel 都得解析得了，
  // 否则用户按下去就是一句「键位写法不对」，而他什么都没做错。
  it("CODE_KEY 覆盖的主键 parseAccel 全都解析得了", () => {
    const codes = [
      "KeyV", "Digit7", "F5", "F12", "Space", "Enter", "Escape", "Tab",
      "Backspace", "Delete", "Insert", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "Home", "End", "PageUp", "PageDown",
      "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash",
      "Semicolon", "Quote", "Comma", "Period", "Slash", "Backquote",
      "Numpad0", "Numpad9", "NumpadAdd", "NumpadSubtract", "NumpadMultiply",
      "NumpadDivide", "NumpadDecimal", "NumpadEnter",
    ];
    for (const code of codes) {
      const acc = toAccelerator(ev(code, { alt: true, shift: true }));
      expect(acc, code).not.toBeNull();
      expect(parseAccel(acc!), `${code} → ${acc}`).not.toBeNull();
    }
  });

  it("老实现录出来的那两个值都要被拒（两个截图的现场）", () => {
    // 截图 1：Option+Shift+Space。e.key 是个看不见的窄空格（U+202F），
    // split 之后被 trim 掉，主键整个没了 → 「键位写法不对」。这条本来就拒，是回归的锚。
    expect(parseAccel("Alt+Shift+\u202F")).toBeNull();
    // 截图 2：Option+Shift+V 存成了 "\u25CA"。这条**原来是放行的** —— 于是配置里躺着
    // 一个 Electron 根本注册不上的键，界面显示成菱形、按下去毫无反应。
    // 现在按「单字符必须是可打印 ASCII」拦住，用户至少能看到提示去重录。
    expect(parseAccel("Alt+Shift+\u25CA")).toBeNull();
  });

  it("正常的 ASCII 主键照旧放行（别把上面那条收得过头）", () => {
    for (const acc of ["Alt+Shift+V", "Command+K", "Alt+-", "Alt+/", "Alt+`", "Control+Alt+1"]) {
      expect(parseAccel(acc), acc).not.toBeNull();
    }
  });

  it("非 ASCII 布局退回物理键位，而不是录一个注册不上的键", () => {
    // 德语键盘 Minus 那个位置的键帽是 \u00DF。照搬会得到一个「看着设好了、按下去
    // 没反应」的快捷键，退回 "-" 至少是真能用的。
    expect(mainKeyFromCode("Minus", new Map([["Minus", "\u00DF"]]))).toBe("-");
  });
});

describe("displayAccel", () => {
  it("Mac 上用符号，且按 ⌃⌥⇧⌘ 的顺序重排", () => {
    expect(displayAccel("Alt+Shift+V", true)).toBe("⌥⇧V");
    expect(displayAccel("Command+Control+Alt+Shift+K", true)).toBe("⌃⌥⇧⌘K");
  });

  it("Mac 上不写 Alt —— 键帽上没有这个词，用户会去找一个不存在的键", () => {
    expect(displayAccel("Alt+Space", true)).not.toContain("Alt");
    expect(displayAccel("Alt+Space", true)).toBe("⌥Space");
  });

  it("Windows / Linux 保持文字写法", () => {
    expect(displayAccel("Alt+Shift+V", false)).toBe("Alt+Shift+V");
    expect(displayAccel("Command+K", false)).toBe("Win+K");
    expect(displayAccel("Control+Alt+Delete", false)).toBe("Ctrl+Alt+Delete");
  });

  it("认别名（Option / Cmd / CommandOrControl 都是合法写法）", () => {
    expect(displayAccel("Option+Shift+V", true)).toBe("⌥⇧V");
    expect(displayAccel("CmdOrCtrl+K", true)).toBe("⌘K");
  });

  it("Mac 上方向键、回车用符号", () => {
    expect(displayAccel("Command+Up", true)).toBe("⌘↑");
    expect(displayAccel("Command+Return", true)).toBe("⌘↩");
  });

  it("空值给空串，不给 undefined 之类会渲染成字面量的东西", () => {
    expect(displayAccel("")).toBe("");
  });

  it("认不出来的部分原样保留，不吞掉", () => {
    // 吞掉的话，用户看到的键位和实际存的对不上，比难看糟得多。
    expect(displayAccel("Alt+MediaPlayPause", false)).toBe("Alt+MediaPlayPause");
  });
});
