// 全局快捷键的冲突检测。
//
// 这块最值得测的不是「能不能查到表」，而是**归一化**：Command+Shift+K 和
// Shift+Command+K 是同一个键，认不出来的话整张表形同虚设 —— 而且失败方式是
// 「什么都没提示」，用户配了个按下去没反应的键，永远不知道为什么。
import { describe, expect, it } from "vitest";
import { accelMessage, checkAccel, checkAccelTable, parseAccel } from "../electron/core/launcher/hotkey";

describe("键位归一化", () => {
  it("修饰键顺序不影响结果 —— 否则查表全漏", () => {
    expect(parseAccel("Shift+Command+K")?.id).toBe("Command+Shift+K");
    expect(parseAccel("Command+Shift+K")?.id).toBe("Command+Shift+K");
  });

  it("各种别名统一：Cmd/Meta/Super → Command，Ctrl → Control，Option/Opt → Alt", () => {
    expect(parseAccel("Cmd+K")?.id).toBe("Command+K");
    expect(parseAccel("Meta+K")?.id).toBe("Command+K");
    expect(parseAccel("Ctrl+K")?.id).toBe("Control+K");
    expect(parseAccel("Option+K")?.id).toBe("Alt+K");
    expect(parseAccel("Opt+K")?.id).toBe("Alt+K");
  });

  it("主键大小写统一", () => {
    expect(parseAccel("Command+k")?.id).toBe("Command+K");
  });

  it("方向键和空格的各种写法统一", () => {
    expect(parseAccel("Control+ArrowUp")?.id).toBe("Control+Up");
    expect(parseAccel("Control+up")?.id).toBe("Control+Up");
    expect(parseAccel("Command+spacebar")?.id).toBe("Command+Space");
    expect(parseAccel("Command+Esc")?.id).toBe("Command+Escape");
    expect(parseAccel("Command+Enter")?.id).toBe("Command+Return");
  });

  it("功能键认 F1–F24", () => {
    expect(parseAccel("F5")?.id).toBe("F5");
    expect(parseAccel("Command+F12")?.id).toBe("Command+F12");
    expect(parseAccel("F25")).toBeNull();
  });

  it("重复的修饰键只算一次", () => {
    expect(parseAccel("Command+Cmd+K")?.id).toBe("Command+K");
  });

  it("两个主键、空串、只有修饰键都判不合法", () => {
    expect(parseAccel("Command+K+J")).toBeNull();
    expect(parseAccel("")).toBeNull();
    expect(parseAccel("Command+Shift")).toBeNull();
    expect(parseAccel("Command+Nonsense")).toBeNull();
  });
});

describe("查表判定", () => {
  const mac = (a: string) => checkAccelTable(a, "darwin");
  const win = (a: string) => checkAccelTable(a, "win32");

  it("没有修饰键的字母键不许用 —— 否则正常打字都会触发工作流", () => {
    expect(mac("K").state).toBe("invalid");
    expect(mac("K").by).toContain("修饰键");
  });

  it("功能键可以单用（F1–F24 本来就不是打字用的）", () => {
    expect(mac("F5").state).toBe("free");
  });

  it("macOS 的系统键判出来，并说清是谁占的", () => {
    expect(mac("Command+Space")).toEqual({ state: "system", by: "聚焦搜索（Spotlight）" });
    expect(mac("Command+Shift+4").state).toBe("system");
    expect(mac("Control+Up").state).toBe("system");
  });

  it("系统键的判定同样吃归一化 —— 反着写也要认出来", () => {
    expect(mac("Space+Command").state).toBe("system");
    expect(mac("Shift+Command+4").state).toBe("system");
  });

  it("平台分开：Alt+Tab 在 Windows 上是系统键，在 macOS 上不是", () => {
    expect(win("Alt+Tab").state).toBe("system");
    expect(mac("Alt+Tab").state).toBe("free");
  });

  it("常用键单列一档：能抢，但会打断日常操作", () => {
    expect(mac("Command+Q")).toEqual({ state: "common", by: "退出应用" });
    expect(win("Control+C").state).toBe("common");
    // macOS 上的 Control+C 不是常用键（那边复制用 Command）
    expect(mac("Control+C").state).toBe("free");
  });

  it("正常组合放行", () => {
    expect(mac("Command+Alt+K").state).toBe("free");
    expect(mac("Control+Shift+U").state).toBe("free");
  });
});

describe("带探测的完整检测", () => {
  it("表里就判死的，压根不去探测 —— 系统键探测多半还会返回成功，反而误导", () => {
    let probed = false;
    const r = checkAccel("Command+Space", () => { probed = true; return "free"; }, "darwin");
    expect(r.state).toBe("system");
    expect(probed).toBe(false);
  });

  it("表里没有就看探测结果", () => {
    expect(checkAccel("Command+Alt+K", () => "free", "darwin").state).toBe("free");
    expect(checkAccel("Command+Alt+K", () => "taken", "darwin").state).toBe("taken");
  });

  it("「自己占的」和「别人占的」要分开 —— 混了的话用户会去别处找一个不存在的占用方", () => {
    const self = checkAccel("Command+Alt+K", () => "self", "darwin");
    expect(self.state).toBe("self");
    expect(accelMessage(self, "Command+Alt+K")).toContain("Umbra");
    const taken = checkAccel("Command+Alt+K", () => "taken", "darwin");
    expect(accelMessage(taken, "Command+Alt+K")).not.toContain("Umbra");
  });

  it("探测拿到的是归一化之后的键位，不是用户随手敲的那串", () => {
    let got = "";
    checkAccel("shift+cmd+j", (id) => { got = id; return "free"; }, "darwin");
    expect(got).toBe("Command+Shift+J");
  });
});

describe("提示语", () => {
  it("可用时不出提示", () => {
    expect(accelMessage({ state: "free" }, "Command+Alt+K")).toBe("");
  });

  it("「不会触发」和「会误伤」措辞要分开 —— 混成一句「快捷键冲突」等于什么都没说", () => {
    const sys = accelMessage({ state: "system", by: "聚焦搜索（Spotlight）" }, "Command+Space");
    expect(sys).toContain("不会被触发");
    const common = accelMessage({ state: "common", by: "退出应用" }, "Command+Q");
    expect(common).toContain("抢得到");
    expect(common).not.toContain("不会被触发");
  });

  it("提示语里带上具体键位和占用方，别只说「冲突」", () => {
    const m = accelMessage({ state: "system", by: "聚焦搜索（Spotlight）" }, "Command+Space");
    expect(m).toContain("Command+Space");
    expect(m).toContain("Spotlight");
  });
});
