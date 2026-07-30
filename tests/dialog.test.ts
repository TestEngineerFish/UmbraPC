// Dialog Conditional 的按钮清单。
//
// 这份测试存在的唯一理由：dialogButtons 有**两份实现** ——
// 主进程一份（引擎按它编出口 b0/b1/b2），渲染层一份（画布按它画端口）。
// 不共用是因为主进程那个模块顶层 import 了 node:fs 和整个执行引擎，拖进渲染层包
// 既跑不起来也白胖一大截；而这里需要的只是十行纯逻辑。
//
// 代价就是两份可能走岔，而走岔的后果很难查：两边对按钮个数的理解差一个，
// 画布上连好的线就接到别的分支上去了，运行时既不报错也不崩，只是走错了路。
// 所以这里拿一组配置把两份实现逐个对过。
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", { umbraLauncher: {} });
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const main = await import("../electron/core/launcher/workflow");
const { dialogButtons: uiButtons, outPorts } = await import("../src/features/launcher/WorkflowEditor");

type Cfg = Record<string, unknown>;

// 覆盖到「会让两份实现走岔」的每一类输入：个数、空值、超限、类型不对。
const CASES: Cfg[] = [
  {},
  { buttons: [] },
  { buttons: ["确定"] },
  { buttons: ["取消", "继续"] },
  { buttons: ["取消", "跳过", "继续"] },
  { buttons: ["一", "二", "三", "四", "五"] },     // 超过上限
  { buttons: ["", ""] },                            // 全空
  { buttons: ["确定", "  "] },                      // 一半空
  { buttons: ["  留白  ", "继续"] },                // 带空白
  { buttons: [null, undefined, 42] },               // 类型不对
  { buttons: "不是数组" },
  { buttons: null },
];

describe("两份实现必须一致", () => {
  it.each(CASES.map((c) => [JSON.stringify(c), c] as [string, Cfg]))("%s", (_name, cfg) => {
    expect(uiButtons(cfg)).toEqual(main.dialogButtons(cfg));
  });

  it("上限也要一致", () => {
    expect(main.DIALOG_MAX_BUTTONS).toBe(3);
  });
});

describe("按钮清单本身的规则", () => {
  const btns = main.dialogButtons;

  it("不配按钮时给一对默认的，而不是空数组 —— 空数组等于一个出口都没有，节点就废了", () => {
    expect(btns({})).toEqual(["取消", "确定"]);
    expect(btns({ buttons: [] })).toEqual(["取消", "确定"]);
  });

  it("超过三个截掉多的（macOS 消息框超过三个会竖排堆叠）", () => {
    expect(btns({ buttons: ["一", "二", "三", "四"] })).toEqual(["一", "二", "三"]);
  });

  it("空按钮名补成「按钮N」而不是丢掉 —— 丢掉会让后面的下标全错位", () => {
    expect(btns({ buttons: ["", "继续"] })).toEqual(["按钮1", "继续"]);
    expect(btns({ buttons: ["取消", "   "] })).toEqual(["取消", "按钮2"]);
  });

  it("按钮名两端空白去掉", () => {
    expect(btns({ buttons: ["  确定  "] })).toEqual(["确定"]);
  });
});

describe("出口编号", () => {
  const ports = (cfg: Cfg) => outPorts({ id: "n", type: "utility.dialog", x: 0, y: 0, config: cfg } as never);

  it("一个按钮一个出口，标签就是按钮文字", () => {
    expect(ports({ buttons: ["取消", "继续"] })).toEqual([
      { port: "b0", label: "取消" },
      { port: "b1", label: "继续" },
    ]);
  });

  it("不配按钮时也有两个出口，不是一个匿名出口", () => {
    expect(ports({}).map((p) => p.port)).toEqual(["b0", "b1"]);
  });

  it("出口编号只跟位置有关，改按钮文字不会把连好的线弄断", () => {
    expect(ports({ buttons: ["甲", "乙"] }).map((p) => p.port))
      .toEqual(ports({ buttons: ["丙", "丁"] }).map((p) => p.port));
  });

  it("按钮从两个加到三个时，原有的 b0 / b1 不变 —— 加一个按钮不该动已连好的线", () => {
    const two = ports({ buttons: ["取消", "继续"] });
    const three = ports({ buttons: ["取消", "继续", "全部"] });
    expect(three.slice(0, 2)).toEqual(two);
  });

  it("和条件分支不共用一套端口名：dialog 用 b0…，conditional 用 r0… + else", () => {
    const cond = outPorts({ id: "n", type: "utility.conditional", x: 0, y: 0, config: { rules: [{}, {}] } } as never);
    expect(cond.map((p) => p.port)).toEqual(["r0", "r1", "else"]);
    expect(ports({ buttons: ["a", "b"] }).some((p) => p.port === "else")).toBe(false);
  });
});
