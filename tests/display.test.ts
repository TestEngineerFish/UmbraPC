// 多屏坐标换算（任务 #61）：normToGlobal 是截图↔点击对齐的关键一环，
// 换算错一个偏移量，操控就整段点偏 —— 纯函数钉死，别等实机才发现。
// 只测纯函数（cursorDisplayBounds/screencaptureArgs 要 electron 运行时，
// node 环境的 vitest 拉不起来；display.ts 因此把 electron 做成惰性 import）。
import { describe, expect, it } from "vitest";
import { normToGlobal } from "../electron/core/shared/display";

describe("normToGlobal 多屏坐标换算", () => {
  const primary = { x: 0, y: 0, width: 1728, height: 1117 };       // 主屏：原点 (0,0)
  const rightOf = { x: 1728, y: -363, width: 2560, height: 1440 }; // 右侧外接：x 有偏移、y 为负

  it("主屏：四角与中心", () => {
    expect(normToGlobal(primary, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(normToGlobal(primary, 1000, 1000)).toEqual({ x: 1728, y: 1117 });
    expect(normToGlobal(primary, 500, 500)).toEqual({ x: 864, y: 559 }); // round(558.5)=559
  });

  it("副屏：bounds 偏移（含负原点）必须算进去 —— 这正是当年只按主屏硬算点偏的地方", () => {
    expect(normToGlobal(rightOf, 0, 0)).toEqual({ x: 1728, y: -363 });
    expect(normToGlobal(rightOf, 500, 500)).toEqual({ x: 1728 + 1280, y: -363 + 720 });
    expect(normToGlobal(rightOf, 1000, 1000)).toEqual({ x: 1728 + 2560, y: -363 + 1440 });
  });

  it("越界归一化值收敛到边缘（视觉模型偶尔给 1003，收边总比点到隔壁屏强）", () => {
    expect(normToGlobal(primary, -20, 1003)).toEqual({ x: 0, y: 1117 });
  });

  it("NaN 原样传染，交给调用方的参数校验兜底", () => {
    const { x, y } = normToGlobal(primary, Number("abc"), 500);
    expect(Number.isNaN(x)).toBe(true);
    expect(Number.isNaN(y)).toBe(false);
  });
});
