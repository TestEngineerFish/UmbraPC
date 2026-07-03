// 截图标注 · 绘制（CSS px 坐标系；导出合成用同一 drawObj 保证所见即所得）。
import { Obj, Point, lineWidthOf, mosaicWidthOf } from "./types";
import { objCenter } from "./geometry";
import { wrapText, lineHeightPx, FONT_FAMILY } from "./text";

export interface DrawOpts {
  mosaicBase?: HTMLCanvasElement | null; // 像素化底图，作为马赛克 pattern
}

export function drawObj(ctx: CanvasRenderingContext2D, obj: Obj, opts?: DrawOpts): void {
  ctx.save();
  // 绕包围盒中心旋转（对象几何存未旋转坐标，旋转在渲染时施加）
  if (obj.rotation) {
    const c = objCenter(obj);
    ctx.translate(c.x, c.y);
    ctx.rotate(obj.rotation);
    ctx.translate(-c.x, -c.y);
  }
  ctx.strokeStyle = obj.color;
  ctx.fillStyle = obj.color;
  ctx.lineWidth = lineWidthOf(obj.size);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  switch (obj.kind) {
    case "rect": {
      const x = Math.min(obj.from.x, obj.to.x);
      const y = Math.min(obj.from.y, obj.to.y);
      ctx.strokeRect(x, y, Math.abs(obj.to.x - obj.from.x), Math.abs(obj.to.y - obj.from.y));
      break;
    }
    case "ellipse": {
      const cx = (obj.from.x + obj.to.x) / 2;
      const cy = (obj.from.y + obj.to.y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(obj.to.x - obj.from.x) / 2, Math.abs(obj.to.y - obj.from.y) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "arrow":
      drawArrow(ctx, obj.from, obj.to, lineWidthOf(obj.size));
      break;
    case "pen":
      if (obj.points.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(obj.points[0].x, obj.points[0].y);
        for (let i = 1; i < obj.points.length; i++) ctx.lineTo(obj.points[i].x, obj.points[i].y);
        ctx.stroke();
      }
      break;
    case "mosaic":
      drawMosaic(ctx, obj.points, mosaicWidthOf(obj.size), opts?.mosaicBase);
      break;
    case "text":
      drawText(ctx, obj.value, obj.at, obj.fontSize, obj.wrapWidth, obj.color);
      break;
  }
  ctx.restore();
}

function drawArrow(ctx: CanvasRenderingContext2D, from: Point, to: Point, lw: number): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = 8 + lw * 2.2;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 7), to.y - head * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 7), to.y - head * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

function drawMosaic(ctx: CanvasRenderingContext2D, points: Point[], brush: number, base?: HTMLCanvasElement | null): void {
  if (points.length < 1) return;
  ctx.save();
  ctx.lineWidth = brush;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const pattern = base ? ctx.createPattern(base, "no-repeat") : null;
  ctx.strokeStyle = pattern || "rgba(120,120,120,0.9)";
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 1) ctx.lineTo(points[0].x + 0.01, points[0].y); // 单点也涂一小块
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
  ctx.restore();
}

function drawText(ctx: CanvasRenderingContext2D, value: string, at: Point, fontSize: number, wrapWidth: number, color: string): void {
  ctx.save();
  ctx.font = `${fontSize}px ${FONT_FAMILY}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = color;
  const lines = wrapText(value, fontSize, wrapWidth);
  const lh = lineHeightPx(fontSize);
  lines.forEach((ln, i) => ctx.fillText(ln, at.x, at.y + i * lh + (lh - fontSize) / 2));
  ctx.restore();
}

// 生成全屏像素化底图（缩小 dividerX 倍再放大，关闭平滑）。CSS px 分辨率，供马赛克 pattern 用。
export function buildMosaicBase(img: HTMLImageElement, cssW: number, cssH: number, factor = 12): HTMLCanvasElement {
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round(cssW / factor));
  small.height = Math.max(1, Math.round(cssH / factor));
  const sctx = small.getContext("2d")!;
  sctx.drawImage(img, 0, 0, small.width, small.height);
  const big = document.createElement("canvas");
  big.width = cssW;
  big.height = cssH;
  const bctx = big.getContext("2d")!;
  bctx.imageSmoothingEnabled = false;
  bctx.drawImage(small, 0, 0, cssW, cssH);
  return big;
}
