// 截图标注 · 对象模型与常量。对象化架构：每个标注是带 id 的对象，存于数组（非位图涂改）。
export type Point = { x: number; y: number };
export type Tool = "rect" | "ellipse" | "arrow" | "pen" | "mosaic" | "text";
// 工具栏可选项：绘制工具 + 指针（框选/多选/移动，不产生对象）。
export type UITool = Tool | "select";

// BaseObj: id + 颜色 + 尺寸档位(0|1|2) + 旋转(弧度，绕包围盒中心)。
export interface BaseObj {
  id: string;
  kind: Tool;
  color: string;
  size: 0 | 1 | 2;
  rotation: number;
}
// rect/ellipse/arrow: from/to 两点；pen/mosaic: points 折线；text: at + 文本。
export interface ShapeObj extends BaseObj {
  kind: "rect" | "ellipse" | "arrow";
  from: Point;
  to: Point;
}
export interface PathObj extends BaseObj {
  kind: "pen" | "mosaic";
  points: Point[];
}
export interface TextObj extends BaseObj {
  kind: "text";
  at: Point; // 左上角
  value: string;
  fontSize: number; // 实际 px
  wrapWidth: number; // 折行宽度上限（新建时=到选区右缘；手柄拖宽后固化为该宽度）
  autoWidth?: boolean; // true=宽度随内容自适应（wrapWidth 仅作上限）；拖手柄改宽后置 false
}
export type Obj = ShapeObj | PathObj | TextObj;

export type Selection = { x: number; y: number; w: number; h: number };

// 三档线宽（rect/ellipse/arrow/pen 共用）。
export const LINE_WIDTHS = [2, 3, 5] as const;
// 马赛克三档笔刷粗细。
export const MOSAIC_WIDTHS = [14, 22, 34] as const;
// 文字三档字号预设。
export const FONT_SIZES = [14, 18, 26] as const;
// 三选颜色（红/黄/蓝）。
export const COLORS = ["#FF3B30", "#FFCC00", "#0A84FF"] as const;

export function lineWidthOf(size: 0 | 1 | 2): number {
  return LINE_WIDTHS[size];
}
export function mosaicWidthOf(size: 0 | 1 | 2): number {
  return MOSAIC_WIDTHS[size];
}

export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const TEXT_LINE_HEIGHT = 1.35;
// 自适应宽度文字的最小宽度（空文本时的光标位）。
export const TEXT_MIN_WIDTH = 26;
