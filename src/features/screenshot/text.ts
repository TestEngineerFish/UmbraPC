// 文字折行/测量：canvas 渲染与编辑框共用同一折行函数，保证所见即所得。
import { TextObj, TEXT_LINE_HEIGHT, TEXT_MIN_WIDTH } from "./types";

const measureCanvas = document.createElement("canvas");
const measureCtx = measureCanvas.getContext("2d")!;

export const FONT_FAMILY = '-apple-system, "SF Pro Text", system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

function setFont(fontSize: number): void {
  measureCtx.font = `${fontSize}px ${FONT_FAMILY}`;
}

// 按 wrapWidth 折行（中英文按字符折行）。先按 \n 硬换行，再按宽度软换行。
export function wrapText(value: string, fontSize: number, wrapWidth: number): string[] {
  setFont(fontSize);
  const out: string[] = [];
  const hardLines = value.split("\n");
  for (const hard of hardLines) {
    if (hard === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const ch of hard) {
      const test = line + ch;
      if (measureCtx.measureText(test).width > wrapWidth && line !== "") {
        out.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    out.push(line);
  }
  return out;
}

export function lineHeightPx(fontSize: number): number {
  return fontSize * TEXT_LINE_HEIGHT;
}

// 最长行的实际像素宽。
export function measureLines(lines: string[], fontSize: number): number {
  setFont(fontSize);
  let w = 0;
  for (const ln of lines) w = Math.max(w, measureCtx.measureText(ln).width);
  return w;
}

// 文字对象包围盒尺寸（本地未旋转空间）。
// autoWidth：宽=内容实测宽（夹在 [TEXT_MIN_WIDTH, wrapWidth]），折行仍以 wrapWidth 为上限；
// 否则（手柄拖过宽度）：宽=wrapWidth。高按折行数。
export function textSize(obj: TextObj): { w: number; h: number } {
  const lines = wrapText(obj.value || " ", obj.fontSize, obj.wrapWidth);
  const h = Math.max(lineHeightPx(obj.fontSize), lines.length * lineHeightPx(obj.fontSize));
  if (!obj.autoWidth) return { w: obj.wrapWidth, h };
  const measured = Math.ceil(measureLines(lines, obj.fontSize)) + 2;
  return { w: Math.min(obj.wrapWidth, Math.max(TEXT_MIN_WIDTH, measured)), h };
}
