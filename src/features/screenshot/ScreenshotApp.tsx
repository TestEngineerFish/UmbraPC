// 截图覆盖窗（React）· 无感打开 + 框选(可二次调整) + 指针/六种工具(对象化) + 单选·框选多选 + 移动/缩放/旋转 + 复制粘贴 + 文字(IME) + 马赛克 + 保存。
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Obj, Point, Selection, UITool, TextObj, COLORS, FONT_SIZES, uid } from "./types";
import { drawObj, buildMosaicBase } from "./draw";
import {
  handlePoints,
  hitHandle,
  hitObject,
  localBBox,
  objCenter,
  rotateAbout,
  bboxCorners,
  translateObj,
  scaleStart,
  applyScale,
  applyEndpoint,
  rotateStart,
  applyRotate,
  rotHandleAnchor,
  objectsInRect,
  regionHandles,
  hitRegionHandle,
  onRegionBorder,
  applyRegionResize,
  clampRegion,
  REGION_CURSOR,
  RegionHandle,
  ScaleSnap,
  HandleId,
} from "./geometry";
import { textSize, FONT_FAMILY } from "./text";

interface CaptureData {
  dataUrl: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}
interface ShotAPI {
  getCapture(): Promise<CaptureData | null>;
  ready(): Promise<boolean>;
  cancel(): Promise<boolean>;
  finish(dataUrl: string): Promise<boolean>;
  save(dataUrl: string): Promise<string | null>;
  setInputMode(active: boolean): Promise<void>;
  ocr(dataUrl: string): Promise<{ ok: boolean; text?: string; error?: string }>;
  translate(dataUrl: string): Promise<{ ok: boolean; source?: string; translation?: string; error?: string }>;
  pin(dataUrl: string, selection: { x: number; y: number; w: number; h: number }): Promise<{ ok: boolean; error?: string }>;
  onSession(cb: (data: CaptureData) => void): () => void;
}
declare global {
  interface Window {
    umbraShot: ShotAPI;
  }
}
const shot = window.umbraShot;

type Phase = "wait" | "select" | "annotate";
// select=拉截图区域；region/regionMove=二次调整截图区域；marquee=框选多个对象。
type GestureMode = "none" | "select" | "draw" | "move" | "scale" | "rotate" | "endpoint" | "marquee" | "region" | "regionMove";

interface TextEdit {
  id: string;
  at: Point;
  value: string;
  fontSize: number;
  wrapWidth: number;
  autoWidth: boolean;
  rotation: number;
  color: string;
  isNew: boolean;
  orig?: TextObj; // 再编辑时的原对象（Esc 还原）
}

export function App() {
  const { t } = useTranslation();
  const [imgSrc, setImgSrc] = useState("");
  const [tool, setTool] = useState<UITool>("rect");
  const [colorIdx, setColorIdx] = useState(0);
  const [sizeIdx, setSizeIdx] = useState<0 | 1 | 2>(1);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [objects, setObjects] = useState<Obj[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("wait");
  const [editing, setEditing] = useState<TextEdit | null>(null);
  const [cursor, setCursor] = useState("crosshair");
  const [result, setResult] = useState<{ loading: boolean; title: string; text: string; error?: string; kind?: "ocr" | "translate" } | null>(null);

  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mosaicBaseRef = useRef<HTMLCanvasElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const sampleRef = useRef<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; ratio: number } | null>(null);
  const cursorRef = useRef<Point>({ x: 0, y: 0 });
  const clipRef = useRef<Obj[]>([]); // 图形剪贴板（复制/粘贴，仅本窗口内）
  const histRef = useRef<Obj[][]>([]); // 撤销栈（对象数组快照）

  const g = useRef<{
    mode: GestureMode;
    start: Point;
    last: Point;
    selStart: Point;
    draft: Obj | null;
    moveIds: string[];
    handle: HandleId | null;
    scaleSnap: ScaleSnap | null;
    rotSnap: { center: Point; offset: number } | null;
    regionHandle: RegionHandle | null;
    regionBase: Selection | null;
    marqueeBase: string[];
    snap: Obj[] | null; // 手势开始时的对象快照（首次真正改动时入撤销栈）
    pushed: boolean;
    textSnap: Obj[] | null;
  }>({
    mode: "none",
    start: { x: 0, y: 0 },
    last: { x: 0, y: 0 },
    selStart: { x: 0, y: 0 },
    draft: null,
    moveIds: [],
    handle: null,
    scaleSnap: null,
    rotSnap: null,
    regionHandle: null,
    regionBase: null,
    marqueeBase: [],
    snap: null,
    pushed: false,
    textSnap: null,
  });

  const st = useRef({ tool, colorIdx, sizeIdx, selection, objects, selectedIds, phase, editing, result });
  st.current = { tool, colorIdx, sizeIdx, selection, objects, selectedIds, phase, editing, result };

  // ── 撤销栈 ──
  function pushHist(snapshot?: Obj[]) {
    histRef.current.push(snapshot ?? st.current.objects);
    if (histRef.current.length > 60) histRef.current.shift();
  }
  function undo() {
    const prev = histRef.current.pop();
    if (!prev) return;
    setObjects(prev);
    setSelectedIds([]);
  }
  // 拖拽类手势：只有真的动了才记一步撤销。
  function markMutation() {
    if (g.current.pushed) return;
    pushHist(g.current.snap ?? st.current.objects);
    g.current.pushed = true;
  }

  // ── 会话 ──
  const startSession = useCallback((cap: CaptureData) => {
    setPhase("wait");
    setSelection(null);
    setObjects([]);
    setSelectedIds([]);
    setEditing(null);
    g.current.mode = "none";
    g.current.draft = null;
    histRef.current = [];
    clipRef.current = [];
    mosaicBaseRef.current = null;
    sampleRef.current = null;
    setImgSrc("");
    requestAnimationFrame(() => setImgSrc(cap.dataUrl));
  }, []);

  useEffect(() => {
    const off = shot.onSession(startSession);
    shot.getCapture().then((cap) => {
      if (cap) startSession(cap);
    });
    return off;
  }, [startSession]);

  const onImgLoad = useCallback(() => {
    if (!imgSrc || !imgRef.current) return;
    const img = imgRef.current;
    sizeCanvas();
    mosaicBaseRef.current = buildMosaicBase(img, window.innerWidth, window.innerHeight);
    // 取色采样画布（原始分辨率）
    const s = document.createElement("canvas");
    s.width = img.naturalWidth;
    s.height = img.naturalHeight;
    const sctx = s.getContext("2d", { willReadFrequently: true })!;
    sctx.drawImage(img, 0, 0);
    sampleRef.current = { canvas: s, ctx: sctx, ratio: img.naturalWidth / window.innerWidth };
    setPhase("select");
    shot.ready();
    requestAnimationFrame(redraw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgSrc]);

  function sampleColor(x: number, y: number): string {
    const s = sampleRef.current;
    if (!s) return "#000000";
    const px = Math.max(0, Math.min(s.canvas.width - 1, Math.round(x * s.ratio)));
    const py = Math.max(0, Math.min(s.canvas.height - 1, Math.round(y * s.ratio)));
    const d = s.ctx.getImageData(px, py, 1, 1).data;
    return "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  // 光标跟踪（放大镜/取色框用）
  useEffect(() => {
    const onMoveCursor = (e: MouseEvent) => {
      cursorRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("mousemove", onMoveCursor);
    return () => window.removeEventListener("mousemove", onMoveCursor);
  }, []);

  function sizeCanvas() {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(window.innerWidth * dpr);
    cv.height = Math.round(window.innerHeight * dpr);
    cv.style.width = window.innerWidth + "px";
    cv.style.height = window.innerHeight + "px";
    cv.getContext("2d")!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ── 绘制 ──
  const redraw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    const W = window.innerWidth;
    const H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);

    const sel = g.current.mode === "select" ? currentSel() : st.current.selection;
    if (sel) {
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, 0, W, H);
      ctx.clearRect(sel.x, sel.y, sel.w, sel.h);
      ctx.restore();
      ctx.strokeStyle = "#0A84FF";
      ctx.lineWidth = 1;
      ctx.strokeRect(sel.x + 0.5, sel.y + 0.5, Math.max(0, sel.w - 1), Math.max(0, sel.h - 1));
    }

    // 截图区域的 8 个调整手柄（标注阶段可二次改大小/位置）
    if (sel && st.current.phase === "annotate" && g.current.mode !== "marquee") drawRegionHandles(ctx, sel);

    const opts = { mosaicBase: mosaicBaseRef.current };
    for (const o of st.current.objects) {
      if (st.current.editing && o.id === st.current.editing.id) continue; // 正在编辑的文字用输入框显示
      drawObj(ctx, o, opts);
    }
    if (g.current.draft) drawObj(ctx, g.current.draft, opts);

    // 选中对象：单选=包围盒+手柄；多选=各自虚线框（不显示手柄）
    if (!st.current.editing) {
      const picked = st.current.objects.filter((o) => st.current.selectedIds.includes(o.id));
      if (picked.length === 1) drawSelection(ctx, picked[0], true);
      else for (const o of picked) drawSelection(ctx, o, false);
    }

    // 框选橡皮筋
    if (g.current.mode === "marquee") {
      const m = currentSel();
      ctx.save();
      ctx.fillStyle = "rgba(10,132,255,0.12)";
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.strokeStyle = "#0A84FF";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(m.x + 0.5, m.y + 0.5, Math.max(0, m.w - 1), Math.max(0, m.h - 1));
      ctx.restore();
    }
  }, []);

  // 选区 8 手柄（白底蓝边小方块）
  function drawRegionHandles(ctx: CanvasRenderingContext2D, sel: Selection) {
    ctx.save();
    for (const h of regionHandles(sel)) {
      ctx.beginPath();
      ctx.rect(h.p.x - 3.5, h.p.y - 3.5, 7, 7);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.strokeStyle = "#0A84FF";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSelection(ctx: CanvasRenderingContext2D, obj: Obj, withHandles: boolean) {
    const b = localBBox(obj);
    const c = objCenter(obj);
    const corners = bboxCorners(b).map((p) => rotateAbout(p, c, obj.rotation));
    ctx.save();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    if (!withHandles) {
      ctx.restore();
      return;
    }
    // 旋转手柄连线（非箭头）
    if (obj.kind !== "arrow") {
      const anchor = rotHandleAnchor(obj);
      const rot = handlePoints(obj).find((h) => h.id === "rot");
      if (rot) {
        ctx.beginPath();
        ctx.moveTo(anchor.x, anchor.y);
        ctx.lineTo(rot.p.x, rot.p.y);
        ctx.stroke();
      }
    }
    // 手柄圆点
    for (const h of handlePoints(obj)) {
      ctx.beginPath();
      ctx.arc(h.p.x, h.p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.strokeStyle = "#0A84FF";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  useEffect(() => {
    redraw();
  }, [selection, objects, selectedIds, phase, editing, redraw]);

  function currentSel(): Selection {
    const a = g.current.selStart;
    const b = g.current.last;
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }
  function pointInSel(p: Point, sel: Selection): boolean {
    return p.x >= sel.x && p.x <= sel.x + sel.w && p.y >= sel.y && p.y <= sel.y + sel.h;
  }

  // ── 指针 ──
  const pt = (e: MouseEvent | React.MouseEvent): Point => ({ x: e.clientX, y: e.clientY });

  // 复制一组对象（新 id + 偏移）。
  function cloneObjs(objs: Obj[], dx: number, dy: number): Obj[] {
    return objs.map((o) => translateObj({ ...o, id: uid() } as Obj, dx, dy));
  }
  function selectedObjs(): Obj[] {
    const s = st.current;
    return s.objects.filter((o) => s.selectedIds.includes(o.id));
  }

  const onCanvasDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const p = pt(e);
    const s = st.current;
    if (s.editing) {
      commitText();
      return;
    }
    if (s.phase === "select") {
      g.current.mode = "select";
      g.current.selStart = p;
      g.current.last = p;
      attach();
      return;
    }
    if (s.phase !== "annotate" || !s.selection) return;
    g.current.snap = s.objects;
    g.current.pushed = false;

    // 1) 对象手柄（仅单选时）
    const one = s.selectedIds.length === 1 ? s.objects.find((o) => o.id === s.selectedIds[0]) : null;
    if (one) {
      const h = hitHandle(one, p);
      if (h) {
        if (h === "rot") {
          g.current.mode = "rotate";
          g.current.rotSnap = rotateStart(one, p);
        } else if (h === "p1" || h === "p2") {
          g.current.mode = "endpoint";
          g.current.handle = h;
        } else {
          g.current.mode = "scale";
          g.current.scaleSnap = scaleStart(one, h);
        }
        g.current.moveIds = [one.id];
        g.current.last = p;
        attach();
        return;
      }
    }

    // 2) 截图区域手柄 → 二次调整大小
    const rh = hitRegionHandle(s.selection, p);
    if (rh) {
      g.current.mode = "region";
      g.current.regionHandle = rh;
      g.current.regionBase = s.selection;
      g.current.last = p;
      attach();
      return;
    }

    // 3) 命中对象 → 选中 / 多选切换 / 拖动（⌥ 拖动=复制）
    const hit = hitObject(s.objects, p);
    if (hit) {
      if (e.shiftKey) {
        setSelectedIds((prev) => (prev.includes(hit.id) ? prev.filter((i) => i !== hit.id) : [...prev, hit.id]));
        return;
      }
      // 已单选的文字再单击 → 进入编辑
      if (hit.kind === "text" && s.selectedIds.length === 1 && s.selectedIds[0] === hit.id) {
        startEditText(hit);
        return;
      }
      let ids = s.selectedIds.includes(hit.id) ? s.selectedIds : [hit.id];
      if (!s.selectedIds.includes(hit.id)) {
        setSelectedIds(ids);
        if (s.tool !== "select") setTool(hit.kind);
      }
      if (e.altKey) {
        // ⌥ 拖动 = 就地复制一份并拖动副本
        const copies = cloneObjs(s.objects.filter((o) => ids.includes(o.id)), 0, 0);
        pushHist(s.objects);
        g.current.pushed = true;
        ids = copies.map((o) => o.id);
        setObjects((prev) => [...prev, ...copies]);
        setSelectedIds(ids);
      }
      g.current.mode = "move";
      g.current.moveIds = ids;
      g.current.last = p;
      attach();
      return;
    }

    // 4) 截图区域边框 → 整体拖移区域
    if (onRegionBorder(s.selection, p)) {
      g.current.mode = "regionMove";
      g.current.regionBase = s.selection;
      g.current.start = p;
      g.current.last = p;
      attach();
      return;
    }

    // 5) 区域内空白
    if (!pointInSel(p, s.selection)) {
      setSelectedIds([]);
      return;
    }
    if (s.tool === "select") {
      // 指针工具：橡皮筋框选（⇧ 累加）
      g.current.mode = "marquee";
      g.current.selStart = p;
      g.current.last = p;
      g.current.marqueeBase = e.shiftKey ? s.selectedIds : [];
      if (!e.shiftKey) setSelectedIds([]);
      attach();
      return;
    }
    if (s.tool === "text") {
      placeText(p);
      return;
    }
    setSelectedIds([]);
    g.current.mode = "draw";
    g.current.start = p;
    g.current.last = p;
    g.current.draft = makeDraft(p);
    attach();
  };

  function makeDraft(p: Point): Obj {
    const s = st.current;
    const base = { id: uid(), color: COLORS[s.colorIdx], size: s.sizeIdx, rotation: 0 };
    if (s.tool === "pen") return { ...base, kind: "pen", points: [p] };
    if (s.tool === "mosaic") return { ...base, kind: "mosaic", points: [p] };
    return { ...base, kind: s.tool as "rect" | "ellipse" | "arrow", from: p, to: p };
  }

  function onMove(e: MouseEvent) {
    const p = pt(e);
    const gm = g.current.mode;
    if (gm === "select" || gm === "marquee") {
      g.current.last = p;
      redraw();
    } else if (gm === "region" && g.current.regionHandle && g.current.regionBase) {
      setSelection(applyRegionResize(g.current.regionBase, g.current.regionHandle, p));
    } else if (gm === "regionMove" && g.current.regionBase) {
      const b = g.current.regionBase;
      setSelection(clampRegion({ x: b.x + (p.x - g.current.start.x), y: b.y + (p.y - g.current.start.y), w: b.w, h: b.h }));
    } else if (gm === "draw" && g.current.draft) {
      const d = g.current.draft;
      if (d.kind === "pen" || d.kind === "mosaic") d.points.push(p);
      else (d as { to: Point }).to = p;
      redraw();
    } else if (gm === "move" && g.current.moveIds.length) {
      const dx = p.x - g.current.last.x;
      const dy = p.y - g.current.last.y;
      if (dx || dy) markMutation();
      g.current.last = p;
      const ids = g.current.moveIds;
      setObjects((prev) => prev.map((o) => (ids.includes(o.id) ? translateObj(o, dx, dy) : o)));
    } else if (gm === "scale" && g.current.scaleSnap) {
      markMutation();
      const next = applyScale(g.current.scaleSnap, p);
      setObjects((prev) => prev.map((o) => (o.id === next.id ? next : o)));
    } else if (gm === "rotate" && g.current.rotSnap && g.current.moveIds[0]) {
      const id = g.current.moveIds[0];
      const cur = st.current.objects.find((o) => o.id === id);
      if (cur) {
        markMutation();
        const next = applyRotate(cur, p, g.current.rotSnap);
        setObjects((prev) => prev.map((o) => (o.id === id ? next : o)));
      }
    } else if (gm === "endpoint" && g.current.handle && g.current.moveIds[0]) {
      const id = g.current.moveIds[0];
      const cur = st.current.objects.find((o) => o.id === id);
      if (cur) {
        markMutation();
        const next = applyEndpoint(cur, g.current.handle, p);
        setObjects((prev) => prev.map((o) => (o.id === id ? next : o)));
      }
    }
  }

  function onUp() {
    detach();
    const gm = g.current.mode;
    g.current.mode = "none";
    if (gm === "select") {
      const sel = currentSel();
      if (sel.w <= 3 || sel.h <= 3) return;
      setSelection(sel);
      setPhase("annotate");
    } else if (gm === "marquee") {
      const m = currentSel();
      const base = g.current.marqueeBase;
      if (m.w <= 2 && m.h <= 2) setSelectedIds(base);
      else {
        const hits = objectsInRect(st.current.objects, m).map((o) => o.id);
        setSelectedIds(Array.from(new Set([...base, ...hits])));
      }
      redraw();
    } else if (gm === "draw" && g.current.draft) {
      const d = g.current.draft;
      g.current.draft = null;
      const b = localBBox(d);
      const meaningful = d.kind === "pen" || d.kind === "mosaic" ? d.points.length > 1 : b.w > 3 || b.h > 3;
      if (meaningful) {
        pushHist(g.current.snap ?? st.current.objects);
        setObjects((prev) => [...prev, d]);
      } else redraw();
    }
    g.current.scaleSnap = null;
    g.current.rotSnap = null;
    g.current.handle = null;
    g.current.regionHandle = null;
    g.current.regionBase = null;
    g.current.snap = null;
    g.current.pushed = false;
  }

  // 悬停光标反馈（手柄/边框/对象）
  const onCanvasHover = (e: React.MouseEvent) => {
    const s = st.current;
    if (g.current.mode !== "none") return;
    if (s.phase !== "annotate" || !s.selection) {
      setCursor("crosshair");
      return;
    }
    const p = pt(e);
    const one = s.selectedIds.length === 1 ? s.objects.find((o) => o.id === s.selectedIds[0]) : null;
    if (one && hitHandle(one, p)) {
      setCursor("pointer");
      return;
    }
    const rh = hitRegionHandle(s.selection, p);
    if (rh) {
      setCursor(REGION_CURSOR[rh]);
      return;
    }
    if (hitObject(s.objects, p)) {
      setCursor("move");
      return;
    }
    if (onRegionBorder(s.selection, p)) {
      setCursor("move");
      return;
    }
    if (!pointInSel(p, s.selection)) setCursor("default");
    else setCursor(s.tool === "select" ? "default" : s.tool === "text" ? "text" : "crosshair");
  };

  const attached = useRef(false);
  function attach() {
    if (attached.current) return;
    attached.current = true;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
  function detach() {
    attached.current = false;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }

  // ── 文字 ──
  function placeText(p: Point) {
    const s = st.current;
    const sel = s.selection!;
    // wrapWidth = 到选区右缘（折行上限）；显示宽度随内容自适应（autoWidth）。
    const wrapWidth = Math.max(60, sel.x + sel.w - p.x - 4);
    g.current.textSnap = s.objects;
    setSelectedIds([]);
    setEditing({ id: uid(), at: p, value: "", fontSize: FONT_SIZES[s.sizeIdx], wrapWidth, autoWidth: true, rotation: 0, color: COLORS[s.colorIdx], isNew: true });
    shot.setInputMode(true);
  }
  function startEditText(obj: TextObj) {
    g.current.textSnap = st.current.objects;
    setSelectedIds([]);
    setObjects((prev) => prev.filter((o) => o.id !== obj.id));
    setEditing({ id: obj.id, at: obj.at, value: obj.value, fontSize: obj.fontSize, wrapWidth: obj.wrapWidth, autoWidth: obj.autoWidth !== false, rotation: obj.rotation, color: obj.color, isNew: false, orig: obj });
    shot.setInputMode(true);
  }
  function commitText() {
    const ed = st.current.editing;
    if (!ed) return;
    shot.setInputMode(false);
    setEditing(null);
    const snap = g.current.textSnap;
    g.current.textSnap = null;
    const value = ed.value.replace(/\s+$/g, "");
    if (!value) {
      if (!ed.isNew && snap) pushHist(snap); // 清空=删除，可撤销
      return;
    }
    if (snap) pushHist(snap);
    const obj: TextObj = { id: ed.id, kind: "text", color: ed.color, size: 0, rotation: ed.rotation, at: ed.at, value: ed.value, fontSize: ed.fontSize, wrapWidth: ed.wrapWidth, autoWidth: ed.autoWidth };
    setObjects((prev) => [...prev.filter((o) => o.id !== ed.id), obj]);
  }
  function cancelText() {
    const ed = st.current.editing;
    if (!ed) return;
    shot.setInputMode(false);
    setEditing(null);
    g.current.textSnap = null;
    if (ed.orig) setObjects((prev) => [...prev, ed.orig!]); // 还原
  }
  // 编辑时聚焦 + 贴底上移
  useEffect(() => {
    if (!editing) return;
    const t = setTimeout(() => textAreaRef.current?.focus(), 30);
    // 贴底上移
    const sel = st.current.selection;
    if (sel) {
      const h = textSize({ ...(editing as unknown as TextObj), kind: "text" }).h;
      if (editing.at.y + h > sel.y + sel.h - 4) {
        const ny = Math.max(sel.y + 4, sel.y + sel.h - 4 - h);
        if (Math.abs(ny - editing.at.y) > 0.5) setEditing((e) => (e ? { ...e, at: { x: e.at.x, y: ny } } : e));
      }
    }
    return () => clearTimeout(t);
  }, [editing]);

  // ── 复制 / 粘贴 / 再制 ──
  const PASTE_OFFSET = 14;
  function copySel() {
    const picked = selectedObjs();
    if (picked.length) clipRef.current = picked.map((o) => ({ ...o }) as Obj);
  }
  function pasteClip() {
    const src = clipRef.current;
    if (!src.length) return;
    const copies = cloneObjs(src, PASTE_OFFSET, PASTE_OFFSET);
    pushHist();
    setObjects((prev) => [...prev, ...copies]);
    setSelectedIds(copies.map((o) => o.id));
    clipRef.current = copies.map((o) => ({ ...o }) as Obj); // 连续粘贴逐次偏移
    setTool("select");
  }
  function duplicateSel() {
    const picked = selectedObjs();
    if (!picked.length) return;
    const copies = cloneObjs(picked, PASTE_OFFSET, PASTE_OFFSET);
    pushHist();
    setObjects((prev) => [...prev, ...copies]);
    setSelectedIds(copies.map((o) => o.id));
    setTool("select");
  }
  function deleteSel() {
    const s = st.current;
    if (!s.selectedIds.length) return;
    pushHist();
    setObjects((prev) => prev.filter((o) => !s.selectedIds.includes(o.id)));
    setSelectedIds([]);
  }

  // ── 键盘 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = st.current;
      if (s.editing) {
        if (e.key === "Escape") {
          e.preventDefault();
          cancelText();
        }
        return; // 其余交给输入框
      }
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        e.preventDefault();
        if (s.result) setResult(null);
        else if (s.selectedIds.length) setSelectedIds([]);
        else if (s.phase === "annotate") {
          setSelection(null);
          setObjects([]);
          setSelectedIds([]);
          histRef.current = [];
          setPhase("select");
        } else shot.cancel();
      } else if ((e.key === "Delete" || e.key === "Backspace") && s.selectedIds.length) {
        e.preventDefault();
        deleteSel();
      } else if (mod && (e.key === "a" || e.key === "A") && s.phase === "annotate") {
        e.preventDefault(); // 全选对象
        setSelectedIds(s.objects.map((o) => o.id));
        setTool("select");
      } else if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        undo();
      } else if (mod && (e.key === "c" || e.key === "C")) {
        if (s.phase === "annotate" && s.selectedIds.length) {
          e.preventDefault();
          copySel();
        } else if (s.phase === "select") {
          e.preventDefault(); // 取色：复制光标处颜色 HEX
          const c = cursorRef.current;
          navigator.clipboard.writeText(sampleColor(c.x, c.y));
        }
      } else if (mod && (e.key === "v" || e.key === "V") && s.phase === "annotate") {
        e.preventDefault();
        pasteClip();
      } else if (mod && (e.key === "d" || e.key === "D") && s.phase === "annotate" && s.selectedIds.length) {
        e.preventDefault();
        duplicateSel();
      } else if (e.key === "Enter" && s.phase === "annotate") {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 合成输出 ──
  function composite(): string | null {
    const img = imgRef.current;
    const sel = st.current.selection;
    if (!img || !sel) return null;
    const ratio = img.naturalWidth / window.innerWidth;
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(sel.w * ratio));
    out.height = Math.max(1, Math.round(sel.h * ratio));
    const octx = out.getContext("2d")!;
    octx.drawImage(img, sel.x * ratio, sel.y * ratio, sel.w * ratio, sel.h * ratio, 0, 0, out.width, out.height);
    octx.save();
    octx.scale(ratio, ratio);
    octx.translate(-sel.x, -sel.y);
    const opts = { mosaicBase: mosaicBaseRef.current };
    for (const o of st.current.objects) drawObj(octx, o, opts);
    octx.restore();
    return out.toDataURL("image/png");
  }
  // 仅裁剪原始画面（不含标注），供 OCR/翻译。
  function compositeClean(): string | null {
    const img = imgRef.current;
    const sel = st.current.selection;
    if (!img || !sel) return null;
    const ratio = img.naturalWidth / window.innerWidth;
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(sel.w * ratio));
    out.height = Math.max(1, Math.round(sel.h * ratio));
    out.getContext("2d")!.drawImage(img, sel.x * ratio, sel.y * ratio, sel.w * ratio, sel.h * ratio, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  }
  async function doOcr() {
    const url = compositeClean();
    if (!url) return;
    setResult({ loading: true, title: t("screenshot.ocrTitle"), text: "", kind: "ocr" });
    const r = await shot.ocr(url);
    setResult({ loading: false, title: t("screenshot.ocrTitle"), text: r.ok ? r.text || "" : "", error: r.ok ? undefined : r.error || t("screenshot.ocrError"), kind: "ocr" });
  }
  async function doTranslate() {
    const url = compositeClean();
    if (!url) return;
    setResult({ loading: true, title: t("screenshot.translateTitle"), text: "", kind: "translate" });
    const r = await shot.translate(url);
    setResult({ loading: false, title: t("screenshot.translateTitle"), text: r.ok ? r.translation || "" : "", error: r.ok ? undefined : r.error || t("screenshot.translateError"), kind: "translate" });
  }

  function finish() {
    if (st.current.editing) commitText();
    const url = composite();
    if (url) shot.finish(url);
    else shot.cancel();
  }
  function save() {
    if (st.current.editing) commitText();
    const url = composite();
    if (url) shot.save(url);
  }
  function pin() {
    if (st.current.editing) commitText();
    const url = composite();
    const sel = st.current.selection;
    if (url && sel) shot.pin(url, sel);
    else shot.cancel();
  }

  const onCanvasDbl = (e: React.MouseEvent) => {
    const s = st.current;
    if (s.phase !== "annotate") return;
    const hit = hitObject(s.objects, pt(e));
    if (hit && hit.kind === "text") startEditText(hit);
    else if (!hit) finish();
  };

  // 面板改颜色/尺寸 → 同时作用于所有选中对象
  function applyColor(i: number) {
    setColorIdx(i);
    const ids = st.current.selectedIds;
    if (!ids.length) return;
    pushHist();
    setObjects((prev) => prev.map((o) => (ids.includes(o.id) ? { ...o, color: COLORS[i] } : o)));
  }
  function applySize(i: 0 | 1 | 2) {
    setSizeIdx(i);
    const ids = st.current.selectedIds;
    if (!ids.length) return;
    pushHist();
    setObjects((prev) =>
      prev.map((o) => {
        if (!ids.includes(o.id)) return o;
        if (o.kind === "text") return { ...o, fontSize: FONT_SIZES[i] };
        return { ...o, size: i };
      }),
    );
  }

  // ── 渲染 ──
  return (
    <div style={{ width: "100vw", height: "100vh", overflow: "hidden" }}>
      <style>{TOOLBAR_CSS}</style>
      {imgSrc ? <img ref={imgRef} src={imgSrc} onLoad={onImgLoad} draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} alt="" /> : null}
      <canvas ref={canvasRef} onMouseDown={onCanvasDown} onMouseMove={onCanvasHover} onDoubleClick={onCanvasDbl} style={{ position: "absolute", inset: 0, cursor: phase === "select" ? "crosshair" : cursor }} />
      {(phase === "select" || phase === "annotate") && (selection || g.current.mode === "select") ? <SizeBadge get={() => (g.current.mode === "select" ? currentSel() : st.current.selection)} /> : null}
      {phase === "select" ? <Magnifier getCursor={() => cursorRef.current} sample={() => sampleRef.current} colorAt={sampleColor} /> : null}
      {editing ? <TextEditor edit={editing} onChange={(v) => setEditing((e) => (e ? { ...e, value: v } : e))} onBlurCommit={commitText} taRef={textAreaRef} /> : null}
      {phase === "annotate" && selection ? (
        <Toolbar
          sel={selection}
          tool={tool}
          colorIdx={colorIdx}
          sizeIdx={sizeIdx}
          onTool={setTool}
          onColor={applyColor}
          onSize={applySize}
          onUndo={undo}
          onCancel={() => shot.cancel()}
          onSave={save}
          onFinish={finish}
          onOcr={doOcr}
          onTranslate={doTranslate}
          onPin={pin}
        />
      ) : null}
      {result && selection ? <ResultPanel sel={selection} data={result} onClose={() => setResult(null)} /> : null}
    </div>
  );
}

// OCR/翻译结果面板（选区上方；加载/文本可选中/复制全部/错误/空）。
function ResultPanel({ sel, data, onClose }: { sel: Selection; data: { loading: boolean; title: string; text: string; error?: string; kind?: "ocr" | "translate" }; onClose: () => void }) {
  const { t } = useTranslation();
  const w = Math.max(280, Math.min(460, sel.w));
  const gap = 10;
  const panelH = 220;
  let top = sel.y - panelH - gap;
  if (top < gap) top = sel.y + sel.h + gap;
  const left = Math.min(Math.max(gap, sel.x), window.innerWidth - w - gap);
  return (
    <div style={{ position: "absolute", left, top, width: w, zIndex: 13, background: "#2b2b2e", color: "#fff", borderRadius: 10, boxShadow: "0 8px 26px rgba(0,0,0,.4)", overflow: "hidden" }} onMouseDown={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #3a3a3e", fontSize: 13, fontWeight: 600 }}>
        <span style={{ flex: 1 }}>{data.title}</span>
        {!data.loading && !data.error && data.text ? (
          <button style={{ border: "none", background: "transparent", color: "#fff", cursor: "pointer", padding: "2px 8px", fontSize: 12 }} onClick={() => navigator.clipboard.writeText(data.text)}>{t("common.copyAll")}</button>
        ) : null}
        <button style={{ border: "none", background: "transparent", color: "#fff", cursor: "pointer", padding: "2px 8px", fontSize: 14 }} onClick={onClose}>✕</button>
      </div>
      <div style={{ padding: 12, maxHeight: 260, overflow: "auto", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", userSelect: "text" }}>
        {data.loading ? <span style={{ color: "#aaa" }}>{data.kind === "translate" ? t("screenshot.translating") : t("screenshot.recognizing")}</span> : data.error ? <span style={{ color: "#FF6961" }}>{data.error}</span> : data.text ? data.text : <span style={{ color: "#aaa" }}>{t("screenshot.noText")}</span>}
      </div>
    </div>
  );
}

// 尺寸角标
function SizeBadge({ get }: { get: () => Selection | null }) {
  const [, force] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      force((n) => (n + 1) % 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const sel = get();
  if (!sel || sel.w < 1) return null;
  return (
    <div style={{ position: "absolute", left: sel.x, top: Math.max(2, sel.y - 22), background: "rgba(0,0,0,0.75)", color: "#fff", fontSize: 12, padding: "2px 7px", borderRadius: 4, zIndex: 11, pointerEvents: "none" }}>
      {Math.round(sel.w)} × {Math.round(sel.h)}
    </div>
  );
}

// 光标放大镜 + 取色信息框（微信截图式）：跟随光标，显示放大像素+十字线、LOC 坐标、HEX、复制提示。
function Magnifier({ getCursor, sample, colorAt }: { getCursor: () => Point; sample: () => { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; ratio: number } | null; colorAt: (x: number, y: number) => string }) {
  const { t } = useTranslation();
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setTick((n) => (n + 1) % 100000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const BOX = 120;
  const SRC = 15; // 采样源像素宽（放大 8x）
  const c = getCursor();
  const s = sample();
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !s) return;
    const ctx = cv.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, BOX, BOX);
    const px = c.x * s.ratio;
    const py = c.y * s.ratio;
    ctx.drawImage(s.canvas, px - SRC / 2, py - SRC / 2, SRC, SRC, 0, 0, BOX, BOX);
    // 十字线
    ctx.strokeStyle = "#39d353";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(BOX / 2, 0);
    ctx.lineTo(BOX / 2, BOX);
    ctx.moveTo(0, BOX / 2);
    ctx.lineTo(BOX, BOX / 2);
    ctx.stroke();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, c.x, c.y, s]);

  if (!s) return null;
  const hex = colorAt(c.x, c.y);
  const w = 128;
  const h = 200;
  let left = c.x + 16;
  let top = c.y + 16;
  if (left + w > window.innerWidth) left = c.x - w - 16;
  if (top + h > window.innerHeight) top = c.y - h - 16;
  return (
    <div style={{ position: "absolute", left, top, width: w, background: "#fbfbfb", borderRadius: 6, overflow: "hidden", boxShadow: "0 4px 16px rgba(0,0,0,.3)", zIndex: 20, pointerEvents: "none", fontSize: 11, color: "#333" }}>
      <canvas ref={cvRef} width={BOX} height={BOX} style={{ width: w, height: w, display: "block", background: "#fff" }} />
      <div style={{ padding: "6px 8px", lineHeight: 1.6 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "#999" }}>LOC</span>
          <span>{Math.round(c.x)}, {Math.round(c.y)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ color: "#999" }}>HEX</span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: hex, border: "1px solid #ccc", display: "inline-block" }} />
            {hex}
          </span>
        </div>
        <div style={{ color: "#aaa", marginTop: 2, fontSize: 10 }}>{t("screenshot.copyColorHint")}</div>
      </div>
    </div>
  );
}

// 文字编辑框（旋转用 CSS transform 同角度；字符折行与 canvas 一致）
// 宽度不再撑满选区：随内容实测宽增长（+光标余量），上限=wrapWidth（到选区右缘）。
function TextEditor({ edit, onChange, onBlurCommit, taRef }: { edit: TextEdit; onChange: (v: string) => void; onBlurCommit: () => void; taRef: React.RefObject<HTMLTextAreaElement> }) {
  const probe: TextObj = { id: edit.id, kind: "text", color: edit.color, size: 0, rotation: 0, at: edit.at, value: edit.value || " ", fontSize: edit.fontSize, wrapWidth: edit.wrapWidth, autoWidth: edit.autoWidth };
  const { w, h } = textSize(probe);
  const boxW = edit.autoWidth ? Math.min(edit.wrapWidth, w + Math.ceil(edit.fontSize * 0.6)) : edit.wrapWidth;
  return (
    <textarea
      ref={taRef}
      value={edit.value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlurCommit}
      onMouseDown={(e) => e.stopPropagation()}
      spellCheck={false}
      style={{
        position: "absolute",
        left: edit.at.x,
        top: edit.at.y,
        width: boxW,
        height: Math.max(edit.fontSize * 1.35, h),
        transform: `rotate(${edit.rotation}rad)`,
        transformOrigin: `${boxW / 2}px ${h / 2}px`,
        font: `${edit.fontSize}px ${FONT_FAMILY}`,
        lineHeight: 1.35,
        color: edit.color,
        caretColor: edit.color,
        background: "transparent",
        border: "1px dashed #fff",
        outline: "none",
        resize: "none",
        overflow: "hidden",
        padding: 0,
        margin: 0,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        zIndex: 12,
      }}
    />
  );
}

// 工具栏 + 二级面板
// SVG 图标（stroke=currentColor，随按钮颜色/主题变化）。
function Ic({ d, fill }: { d: string; fill?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {d.split("|").map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}
const TOOL_ICON: Record<UITool, React.ReactNode> = {
  select: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3l14 8.5-6.2 1.4L9.6 19 5 3z" />
    </svg>
  ),
  rect: <Ic d="M4 6.5h16v11H4z" />,
  ellipse: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />
    </svg>
  ),
  arrow: <Ic d="M6 18L18 6|10 6h8v8" />,
  pen: <Ic d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z" />,
  mosaic: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="4" width="7" height="7" rx="1" />
      <rect x="4" y="13" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
    </svg>
  ),
  text: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 5h14" />
      <path d="M12 5v14" />
    </svg>
  ),
};
const TOOL_ORDER: UITool[] = ["select", "rect", "ellipse", "arrow", "pen", "mosaic", "text"];
const TOOL_TIP_KEY: Record<UITool, string> = {
  select: "screenshot.toolSelect",
  rect: "screenshot.toolRect",
  ellipse: "screenshot.toolEllipse",
  arrow: "screenshot.toolArrow",
  pen: "screenshot.toolPen",
  mosaic: "screenshot.toolMosaic",
  text: "screenshot.toolText",
};

const ICON = {
  undo: <Ic d="M9 14 4 9l5-5|M4 9h11a5 5 0 1 1 0 10h-3" />,
  cancel: <Ic d="M18 6 6 18|M6 6l12 12" />,
  save: <Ic d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M7 10l5 5 5-5|M12 15V3" />,
  pin: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 4H16L15 7.5L18 15H6L9 7.5L8 4Z" />
      <path d="M12 15V21" />
    </svg>
  ),
  ocr: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <text x="12" y="12.5" textAnchor="middle" dominantBaseline="middle" fill="currentColor" stroke="none" fontSize="11" fontWeight="600" fontFamily="system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
        文
      </text>
    </svg>
  ),
  check: <Ic d="M20 6 9 17l-5-5" />,
};

function Toolbar(props: {
  sel: Selection;
  tool: UITool;
  colorIdx: number;
  sizeIdx: 0 | 1 | 2;
  onTool: (t: UITool) => void;
  onColor: (i: number) => void;
  onSize: (i: 0 | 1 | 2) => void;
  onUndo: () => void;
  onCancel: () => void;
  onSave: () => void;
  onFinish: () => void;
  onOcr: () => void;
  onTranslate: () => void;
  onPin: () => void;
}) {
  const { t } = useTranslation();
  const { sel, tool } = props;
  const sizeTip = [t("common.sizeSmall"), t("common.sizeMedium"), t("common.sizeLarge")] as const;
  const colorTip = [t("common.colorRed"), t("common.colorYellow"), t("common.colorBlue")] as const;
  const gap = 10;
  const barW = 500;
  let top = sel.y + sel.h + gap;
  const above = top + 100 > window.innerHeight;
  if (above) top = Math.max(gap, sel.y - 104);
  const left = Math.min(Math.max(gap, sel.x), window.innerWidth - barW - gap);

  const isText = tool === "text";
  const isMosaic = tool === "mosaic";

  return (
    <div style={{ position: "absolute", left, top, zIndex: 10 }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="tb-bar">
        {TOOL_ORDER.map((k) => (
          <button key={k} className={`tb-btn tb-tip ${tool === k ? "on" : ""}`} data-tip={t(TOOL_TIP_KEY[k])} onClick={() => props.onTool(k)}>
            {TOOL_ICON[k]}
          </button>
        ))}
        <span className="tb-sep" />
        <button className="tb-btn tb-tip" data-tip={t("screenshot.undo")} onClick={props.onUndo}>{ICON.undo}</button>
        <button className="tb-btn tb-tip" data-tip={t("screenshot.cancel")} onClick={props.onCancel}>{ICON.cancel}</button>
        <button className="tb-btn tb-tip" data-tip={t("screenshot.save")} onClick={props.onSave}>{ICON.save}</button>
        <button className="tb-btn tb-tip" data-tip={t("screenshot.pin")} onClick={props.onPin}>{ICON.pin}</button>
        <button className="tb-btn tb-tip" data-tip={t("screenshot.ocr")} onClick={props.onOcr}>{ICON.ocr}</button>
        <button className="tb-btn tb-tip tb-txt" data-tip={t("screenshot.translate")} onClick={props.onTranslate}>文A</button>
        <button className="tb-btn tb-tip tb-check" data-tip={t("screenshot.finish")} onClick={props.onFinish}>{ICON.check}</button>
      </div>
      <div className="tb-panel">
        {isText
          ? FONT_SIZES.map((fs, i) => (
              <button key={fs} className={`tb-font tb-tip ${props.sizeIdx === i ? "on" : ""}`} data-tip={t("screenshot.fontSize", { size: fs })} onClick={() => props.onSize(i as 0 | 1 | 2)}>
                <span style={{ fontSize: 11 + i * 4, lineHeight: 1 }}>A</span>
              </button>
            ))
          : [0, 1, 2].map((i) => (
              <button key={i} className={`tb-dot tb-tip ${props.sizeIdx === i ? "on" : ""}`} data-tip={`${isMosaic ? t("screenshot.mosaicSize") : t("screenshot.thickness")} · ${sizeTip[i]}`} onClick={() => props.onSize(i as 0 | 1 | 2)}>
                <span style={{ display: "block", width: (isMosaic ? 6 : 4) + i * 3, height: (isMosaic ? 6 : 4) + i * 3, borderRadius: isMosaic ? 2 : "50%", background: "currentColor" }} />
              </button>
            ))}
        <span className="tb-sep" />
        {COLORS.map((c, i) => (
          <button key={c} className={`tb-swatch tb-tip ${props.colorIdx === i ? "on" : ""}`} style={{ background: c }} data-tip={colorTip[i]} onClick={() => props.onColor(i)} />
        ))}
      </div>
    </div>
  );
}

// 主题感知样式：跟随系统浅/深色（prefers-color-scheme）。参考微信截图工具栏。
const TOOLBAR_CSS = `
:root{
  --tb-bg:#ffffff; --tb-fg:#3b3f45; --tb-sep:#e6e3dc; --tb-hover:#f1efeb;
  --tb-active-bg:#FFF1E6; --tb-active-fg:#E8590C; --tb-shadow:0 6px 22px rgba(0,0,0,.16);
  --tb-dot:#9aa0a6; --tb-dot-on:#E8590C;
}
@media (prefers-color-scheme: dark){
  :root{
    --tb-bg:#2b2b2e; --tb-fg:#e6e6ea; --tb-sep:#4a4a4e; --tb-hover:#3a3a3e;
    --tb-active-bg:rgba(232,89,12,.24); --tb-active-fg:#F5A66A; --tb-shadow:0 6px 22px rgba(0,0,0,.4);
    --tb-dot:#8a8f96; --tb-dot-on:#F5A66A;
  }
}
.tb-bar,.tb-panel{display:flex;align-items:center;gap:4px;background:var(--tb-bg);border-radius:11px;padding:5px 8px;box-shadow:var(--tb-shadow);}
.tb-panel{margin-top:8px;width:fit-content;gap:6px;}
.tb-sep{width:1px;height:20px;background:var(--tb-sep);margin:0 4px;}
.tb-btn{width:32px;height:30px;border-radius:8px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;background:transparent;color:var(--tb-fg);transition:background .12s,color .12s;}
.tb-btn:hover{background:var(--tb-hover);}
.tb-btn.on{background:var(--tb-active-bg);color:var(--tb-active-fg);}
.tb-btn.tb-txt{font-size:13px;font-weight:600;}
.tb-btn.tb-check{color:var(--tb-active-fg);}
.tb-btn.tb-check:hover{background:var(--tb-active-bg);}
.tb-dot,.tb-font{min-width:28px;height:28px;border-radius:7px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;background:transparent;color:var(--tb-dot);transition:background .12s;}
.tb-dot:hover,.tb-font:hover{background:var(--tb-hover);}
.tb-dot.on,.tb-font.on{background:var(--tb-active-bg);color:var(--tb-dot-on);}
.tb-swatch{width:20px;height:20px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0;box-shadow:0 0 0 1px rgba(0,0,0,.08) inset;}
.tb-swatch.on{border-color:var(--tb-fg);box-shadow:0 0 0 2px var(--tb-bg) inset;}
.tb-tip{position:relative;}
.tb-tip::after{
  content:attr(data-tip);position:absolute;left:50%;transform:translateX(-50%);
  padding:4px 8px;border-radius:6px;background:var(--tb-fg);color:var(--tb-bg);
  font-size:11px;line-height:1.3;white-space:nowrap;pointer-events:none;opacity:0;
  transition:opacity .12s;z-index:20;box-shadow:0 2px 8px rgba(0,0,0,.18);
}
.tb-bar .tb-tip::after{bottom:calc(100% + 6px);}
.tb-panel .tb-tip::after{top:calc(100% + 6px);}
.tb-tip:hover::after,.tb-tip:focus-visible::after{opacity:1;}
`;
