// 截图标注 · 几何与变换：包围盒、旋转、手柄、缩放(穿零翻转)、旋转。
import { Obj, Point, Selection } from "./types";
import { textSize } from "./text";

export function rotate(v: Point, a: number): Point {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}
export function rotateAbout(p: Point, center: Point, a: number): Point {
  const r = rotate({ x: p.x - center.x, y: p.y - center.y }, a);
  return { x: center.x + r.x, y: center.y + r.y };
}
export function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}
export function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

// 本地（未旋转）包围盒。
export function localBBox(obj: Obj): Selection {
  if (obj.kind === "text") {
    const s = textSize(obj);
    return { x: obj.at.x, y: obj.at.y, w: s.w, h: s.h };
  }
  const pts = "points" in obj ? obj.points : [obj.from, obj.to];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
export function bboxCenter(b: Selection): Point {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}
export function objCenter(obj: Obj): Point {
  return bboxCenter(localBBox(obj));
}

// bbox 四角（本地）：0=tl 1=tr 2=br 3=bl。
export function bboxCorners(b: Selection): Point[] {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
}
const OPPOSITE = [2, 3, 0, 1];

export type HandleId = "tl" | "tr" | "br" | "bl" | "rot" | "p1" | "p2";
const CORNER_IDS: HandleId[] = ["tl", "tr", "br", "bl"];

// 手柄的世界坐标（含旋转）。箭头=两端点；其余=四角 + 顶部旋转手柄。
export function handlePoints(obj: Obj): { id: HandleId; p: Point }[] {
  if (obj.kind === "arrow") {
    return [
      { id: "p1", p: obj.from },
      { id: "p2", p: obj.to },
    ];
  }
  const b = localBBox(obj);
  const c = bboxCenter(b);
  const corners = bboxCorners(b).map((p) => rotateAbout(p, c, obj.rotation));
  const res: { id: HandleId; p: Point }[] = corners.map((p, i) => ({ id: CORNER_IDS[i], p }));
  // 旋转手柄：顶边中点向外 22px（沿旋转后的“上”方向）。
  const topMid = { x: b.x + b.w / 2, y: b.y };
  const up = rotateAbout({ x: topMid.x, y: topMid.y - 22 }, c, obj.rotation);
  res.push({ id: "rot", p: up });
  return res;
}

// 命中手柄（容差 9px）。
export function hitHandle(obj: Obj, pt: Point): HandleId | null {
  const TOL = 9;
  for (const h of handlePoints(obj)) {
    if (Math.hypot(pt.x - h.p.x, pt.y - h.p.y) <= TOL) return h.id;
  }
  return null;
}

// 旋转手柄的“连线圆点”起点（顶边中点，世界坐标），画连线用。
export function rotHandleAnchor(obj: Obj): Point {
  const b = localBBox(obj);
  const c = bboxCenter(b);
  return rotateAbout({ x: b.x + b.w / 2, y: b.y }, c, obj.rotation);
}

// ── 旋转 ──
export function rotateStart(obj: Obj, pt: Point): { center: Point; offset: number } {
  const center = objCenter(obj);
  const ang = Math.atan2(pt.y - center.y, pt.x - center.x);
  return { center, offset: obj.rotation - ang };
}
export function applyRotate(obj: Obj, pt: Point, s: { center: Point; offset: number }): Obj {
  const ang = Math.atan2(pt.y - s.center.y, pt.x - s.center.x);
  return { ...obj, rotation: ang + s.offset };
}

// ── 缩放（穿零翻转，锚点固化）──
export interface ScaleSnap {
  handle: HandleId;
  orig: Obj;
  center0: Point;
  storedAnchor: Point; // 本地：对角锚点
  draggedStored: Point; // 本地：被拖角
  anchorVisual: Point; // 世界：锚点视觉位置（固定）
  anchorOffsetKind: number; // 锚点是哪个角(0..3)，text 用
}

export function scaleStart(obj: Obj, handle: HandleId): ScaleSnap {
  const b = localBBox(obj);
  const corners = bboxCorners(b);
  const idx = CORNER_IDS.indexOf(handle);
  const anchorIdx = OPPOSITE[idx];
  const storedAnchor = corners[anchorIdx];
  const draggedStored = corners[idx];
  const center0 = bboxCenter(b);
  const anchorVisual = rotateAbout(storedAnchor, center0, obj.rotation);
  return { handle, orig: obj, center0, storedAnchor, draggedStored, anchorVisual, anchorOffsetKind: anchorIdx };
}

// 端点手柄（箭头）：直接把该端点移到指针。
export function applyEndpoint(obj: Obj, handle: HandleId, pt: Point): Obj {
  if (obj.kind !== "arrow") return obj;
  if (handle === "p1") return { ...obj, from: pt };
  if (handle === "p2") return { ...obj, to: pt };
  return obj;
}

export function applyScale(snap: ScaleSnap, pt: Point): Obj {
  const obj = snap.orig;
  const theta = obj.rotation;
  // 指针在“未旋转”局部帧、相对锚点的向量
  const d = rotate(sub(pt, snap.anchorVisual), -theta);
  const origVec = sub(snap.draggedStored, snap.storedAnchor);

  if (obj.kind === "text") {
    const newW = Math.max(20, Math.abs(d.x));
    const scaleY = Math.abs(origVec.y) < 1 ? 1 : Math.abs(d.y) / Math.abs(origVec.y);
    const newFont = Math.max(8, Math.min(400, obj.fontSize * scaleY));
    const nb = { x: 0, y: 0, w: newW, h: 0 };
    // 用新字号/宽度测高
    const probe = { ...obj, wrapWidth: newW, fontSize: newFont };
    nb.h = textSize(probe).h;
    // 求新的 at，使锚角固定在 anchorVisual
    const anchorOffset = bboxCorners({ x: 0, y: 0, w: nb.w, h: nb.h })[snap.anchorOffsetKind];
    const A = sub(anchorOffset, { x: nb.w / 2, y: nb.h / 2 });
    const rotA = rotate(A, theta);
    const at = sub(sub(snap.anchorVisual, { x: nb.w / 2, y: nb.h / 2 }), rotA);
    return { ...obj, at, wrapWidth: newW, fontSize: newFont, autoWidth: false }; // 手动拖宽 → 固化宽度
  }

  const sx = Math.abs(origVec.x) < 1e-3 ? 1 : d.x / origVec.x;
  const sy = Math.abs(origVec.y) < 1e-3 ? 1 : d.y / origVec.y;
  const scalePt = (p: Point): Point => ({
    x: snap.storedAnchor.x + (p.x - snap.storedAnchor.x) * sx,
    y: snap.storedAnchor.y + (p.y - snap.storedAnchor.y) * sy,
  });

  let scaled: Obj;
  if ("points" in obj) {
    scaled = { ...obj, points: obj.points.map(scalePt) };
  } else {
    scaled = { ...obj, from: scalePt(obj.from), to: scalePt(obj.to) };
  }
  // 平移补偿：让锚角视觉位置固定
  const nb = localBBox(scaled);
  const newCenter = bboxCenter(nb);
  const newAnchorVisual = rotateAbout(snap.storedAnchor, newCenter, theta);
  const t = sub(snap.anchorVisual, newAnchorVisual);
  return translateObj(scaled, t.x, t.y);
}

export function translateObj(obj: Obj, dx: number, dy: number): Obj {
  if (obj.kind === "text") return { ...obj, at: { x: obj.at.x + dx, y: obj.at.y + dy } };
  if ("points" in obj) return { ...obj, points: obj.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  return { ...obj, from: { x: obj.from.x + dx, y: obj.from.y + dy }, to: { x: obj.to.x + dx, y: obj.to.y + dy } };
}

// ── 世界包围盒 / 框选 ──
// 含旋转的轴对齐包围盒（世界坐标），用于矩形框选命中。
export function worldBBox(obj: Obj): Selection {
  const b = localBBox(obj);
  const c = bboxCenter(b);
  const pts = bboxCorners(b).map((p) => rotateAbout(p, c, obj.rotation));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
export function rectsIntersect(a: Selection, b: Selection): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

// 对象轮廓的世界坐标线段集（矩形=四条边、椭圆=多边形近似、箭头/画笔/马赛克=折线；文字无轮廓=实心块）。
function outlineSegments(obj: Obj): [Point, Point][] {
  const c = objCenter(obj);
  const R = (p: Point) => rotateAbout(p, c, obj.rotation);
  const chain = (pts: Point[]): [Point, Point][] => {
    const out: [Point, Point][] = [];
    for (let i = 1; i < pts.length; i++) out.push([pts[i - 1], pts[i]]);
    return out;
  };
  if (obj.kind === "rect") {
    const cs = bboxCorners(localBBox(obj)).map(R);
    return [
      [cs[0], cs[1]],
      [cs[1], cs[2]],
      [cs[2], cs[3]],
      [cs[3], cs[0]],
    ];
  }
  if (obj.kind === "ellipse") {
    const cx = (obj.from.x + obj.to.x) / 2;
    const cy = (obj.from.y + obj.to.y) / 2;
    const rx = Math.abs(obj.to.x - obj.from.x) / 2;
    const ry = Math.abs(obj.to.y - obj.from.y) / 2;
    const N = 48;
    const pts: Point[] = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push(R({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }));
    }
    return chain(pts);
  }
  if (obj.kind === "arrow") return [[R(obj.from), R(obj.to)]];
  if ("points" in obj) return chain(obj.points.map(R));
  return []; // text
}

function pointInRect(p: Point, r: Selection): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}
function segSeg(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (o: Point, p: Point, q: Point) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
// 线段与矩形是否相交（端点落入 或 与任一边相交）。
function segHitsRect(a: Point, b: Point, r: Selection): boolean {
  if (pointInRect(a, r) || pointInRect(b, r)) return true;
  const c = bboxCorners(r);
  for (let i = 0; i < 4; i++) if (segSeg(a, b, c[i], c[(i + 1) % 4])) return true;
  return false;
}

// 与框选矩形相交的对象（保持原 z 序）。
// 关键：矩形/椭圆按“描边”判定 —— 框选完全落在其内部（只圈住了里面的文字）时不会误选外框。
export function objectsInRect(objects: Obj[], rect: Selection): Obj[] {
  return objects.filter((o) => {
    if (o.kind === "text") return rectsIntersect(worldBBox(o), rect); // 文字=实心块
    const segs = outlineSegments(o);
    if (!segs.length) return rectsIntersect(worldBBox(o), rect);
    return segs.some(([a, b]) => segHitsRect(a, b, rect));
  });
}

// ── 截图区域（选区）二次调整：8 手柄缩放 + 边框拖移 ──
export type RegionHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const REGION_TOL = 8;

export function regionHandles(sel: Selection): { id: RegionHandle; p: Point }[] {
  const { x, y, w, h } = sel;
  const mx = x + w / 2;
  const my = y + h / 2;
  return [
    { id: "nw", p: { x, y } },
    { id: "n", p: { x: mx, y } },
    { id: "ne", p: { x: x + w, y } },
    { id: "e", p: { x: x + w, y: my } },
    { id: "se", p: { x: x + w, y: y + h } },
    { id: "s", p: { x: mx, y: y + h } },
    { id: "sw", p: { x, y: y + h } },
    { id: "w", p: { x, y: my } },
  ];
}
export function hitRegionHandle(sel: Selection, pt: Point): RegionHandle | null {
  for (const h of regionHandles(sel)) {
    if (Math.abs(pt.x - h.p.x) <= REGION_TOL && Math.abs(pt.y - h.p.y) <= REGION_TOL) return h.id;
  }
  return null;
}
// 指针是否落在选区边框上（用于整体拖移选区）。
export function onRegionBorder(sel: Selection, pt: Point): boolean {
  const t = 5;
  const inOuter = pt.x >= sel.x - t && pt.x <= sel.x + sel.w + t && pt.y >= sel.y - t && pt.y <= sel.y + sel.h + t;
  const inInner = pt.x >= sel.x + t && pt.x <= sel.x + sel.w - t && pt.y >= sel.y + t && pt.y <= sel.y + sel.h - t;
  return inOuter && !inInner;
}
const MIN_REGION = 8;
export function clampRegion(sel: Selection): Selection {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const w = Math.max(MIN_REGION, Math.min(sel.w, W));
  const h = Math.max(MIN_REGION, Math.min(sel.h, H));
  return { x: Math.max(0, Math.min(sel.x, W - w)), y: Math.max(0, Math.min(sel.y, H - h)), w, h };
}
export function applyRegionResize(base: Selection, id: RegionHandle, pt: Point): Selection {
  let x1 = base.x;
  let y1 = base.y;
  let x2 = base.x + base.w;
  let y2 = base.y + base.h;
  if (id.includes("n")) y1 = pt.y;
  if (id.includes("s")) y2 = pt.y;
  if (id.includes("w")) x1 = pt.x;
  if (id.includes("e")) x2 = pt.x;
  return clampRegion({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) });
}
export const REGION_CURSOR: Record<RegionHandle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

// 旋转感知命中检测：把指针逆旋转到对象局部空间再判。检测顺序由调用方保证（手柄 > 对象 > 空白）。
export function hitObject(objects: Obj[], pt: Point): Obj | null {
  const TOL = 6;
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    const c = objCenter(obj);
    const lp = rotateAbout(pt, c, -obj.rotation); // 逆旋转到局部
    if (hitLocal(obj, lp, TOL)) return obj;
  }
  return null;
}

function hitLocal(obj: Obj, p: Point, tol: number): boolean {
  if (obj.kind === "text") {
    const b = localBBox(obj);
    return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
  }
  if ("points" in obj) {
    const w = obj.kind === "mosaic" ? 14 : lineW(obj.size);
    for (let j = 1; j < obj.points.length; j++) if (distToSeg(p, obj.points[j - 1], obj.points[j]) <= tol + w) return true;
    return false;
  }
  if (obj.kind === "arrow") return distToSeg(p, obj.from, obj.to) <= tol + lineW(obj.size);
  if (obj.kind === "rect") return nearRectBorder(p, obj.from, obj.to, tol);
  return nearEllipse(p, obj.from, obj.to, tol);
}

function lineW(size: 0 | 1 | 2): number {
  return [2, 3, 5][size];
}
function distToSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function nearRectBorder(p: Point, from: Point, to: Point, tol: number): boolean {
  const x1 = Math.min(from.x, to.x);
  const x2 = Math.max(from.x, to.x);
  const y1 = Math.min(from.y, to.y);
  const y2 = Math.max(from.y, to.y);
  const insideX = p.x >= x1 - tol && p.x <= x2 + tol;
  const insideY = p.y >= y1 - tol && p.y <= y2 + tol;
  return ((Math.abs(p.x - x1) <= tol || Math.abs(p.x - x2) <= tol) && insideY) || ((Math.abs(p.y - y1) <= tol || Math.abs(p.y - y2) <= tol) && insideX);
}
function nearEllipse(p: Point, from: Point, to: Point, tol: number): boolean {
  const cx = (from.x + to.x) / 2;
  const cy = (from.y + to.y) / 2;
  const rx = Math.abs(to.x - from.x) / 2;
  const ry = Math.abs(to.y - from.y) / 2;
  if (rx < 1 || ry < 1) return false;
  const nx = (p.x - cx) / rx;
  const ny = (p.y - cy) / ry;
  return Math.abs(Math.hypot(nx, ny) - 1) * Math.min(rx, ry) <= tol;
}
