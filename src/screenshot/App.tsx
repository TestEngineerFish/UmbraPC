// 截图覆盖窗（React）· 无感打开 + 框选 + 六种工具(对象化) + 选中/移动/手柄缩放·旋转 + 文字(IME) + 马赛克 + 复制/保存。
import { useCallback, useEffect, useRef, useState } from "react";
import { Obj, Point, Selection, Tool, TextObj, COLORS, FONT_SIZES, uid } from "./types";
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
type GestureMode = "none" | "select" | "draw" | "move" | "scale" | "rotate" | "endpoint";

interface TextEdit {
  id: string;
  at: Point;
  value: string;
  fontSize: number;
  wrapWidth: number;
  rotation: number;
  color: string;
  isNew: boolean;
  orig?: TextObj; // 再编辑时的原对象（Esc 还原）
}

export function App() {
  const [imgSrc, setImgSrc] = useState("");
  const [tool, setTool] = useState<Tool>("rect");
  const [colorIdx, setColorIdx] = useState(0);
  const [sizeIdx, setSizeIdx] = useState<0 | 1 | 2>(1);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [objects, setObjects] = useState<Obj[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("wait");
  const [editing, setEditing] = useState<TextEdit | null>(null);
  const [result, setResult] = useState<{ loading: boolean; title: string; text: string; error?: string } | null>(null);

  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mosaicBaseRef = useRef<HTMLCanvasElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const sampleRef = useRef<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; ratio: number } | null>(null);
  const cursorRef = useRef<Point>({ x: 0, y: 0 });

  const g = useRef<{
    mode: GestureMode;
    start: Point;
    last: Point;
    selStart: Point;
    draft: Obj | null;
    moveId: string | null;
    handle: HandleId | null;
    scaleSnap: ScaleSnap | null;
    rotSnap: { center: Point; offset: number } | null;
    clickTargetId: string | null;
  }>({ mode: "none", start: { x: 0, y: 0 }, last: { x: 0, y: 0 }, selStart: { x: 0, y: 0 }, draft: null, moveId: null, handle: null, scaleSnap: null, rotSnap: null, clickTargetId: null });

  const st = useRef({ tool, colorIdx, sizeIdx, selection, objects, selectedId, phase, editing, result });
  st.current = { tool, colorIdx, sizeIdx, selection, objects, selectedId, phase, editing, result };

  // ── 会话 ──
  const startSession = useCallback((cap: CaptureData) => {
    setPhase("wait");
    setSelection(null);
    setObjects([]);
    setSelectedId(null);
    setEditing(null);
    g.current.mode = "none";
    g.current.draft = null;
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

    const opts = { mosaicBase: mosaicBaseRef.current };
    for (const o of st.current.objects) {
      if (st.current.editing && o.id === st.current.editing.id) continue; // 正在编辑的文字用输入框显示
      drawObj(ctx, o, opts);
    }
    if (g.current.draft) drawObj(ctx, g.current.draft, opts);

    // 选中对象：包围盒 + 手柄
    const selObj = st.current.objects.find((o) => o.id === st.current.selectedId);
    if (selObj && !st.current.editing) drawSelection(ctx, selObj);
  }, []);

  function drawSelection(ctx: CanvasRenderingContext2D, obj: Obj) {
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
  }, [selection, objects, selectedId, phase, editing, redraw]);

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
    if (s.phase !== "annotate") return;

    // 1) 手柄（仅对已选中对象）
    const selObj = s.objects.find((o) => o.id === s.selectedId);
    if (selObj) {
      const h = hitHandle(selObj, p);
      if (h) {
        if (h === "rot") {
          g.current.mode = "rotate";
          g.current.rotSnap = rotateStart(selObj, p);
        } else if (h === "p1" || h === "p2") {
          g.current.mode = "endpoint";
          g.current.handle = h;
          g.current.moveId = selObj.id;
        } else {
          g.current.mode = "scale";
          g.current.scaleSnap = scaleStart(selObj, h);
        }
        g.current.moveId = selObj.id;
        g.current.last = p;
        attach();
        return;
      }
    }

    // 2) 命中对象 → 选中
    const hit = hitObject(s.objects, p);
    if (hit) {
      // 已选中同一文字再单击 → 进入编辑
      if (hit.kind === "text" && hit.id === s.selectedId) {
        startEditText(hit);
        return;
      }
      setSelectedId(hit.id);
      setTool(hit.kind);
      g.current.clickTargetId = hit.id;
      g.current.mode = "move";
      g.current.moveId = hit.id;
      g.current.last = p;
      attach();
      return;
    }

    // 3) 空白
    const inside = s.selection && pointInSel(p, s.selection);
    if (!inside) {
      setSelectedId(null);
      return;
    }
    if (s.tool === "text") {
      placeText(p);
      return;
    }
    setSelectedId(null);
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
    if (gm === "select") {
      g.current.last = p;
      redraw();
    } else if (gm === "draw" && g.current.draft) {
      const d = g.current.draft;
      if (d.kind === "pen" || d.kind === "mosaic") d.points.push(p);
      else (d as { to: Point }).to = p;
      redraw();
    } else if (gm === "move" && g.current.moveId) {
      const dx = p.x - g.current.last.x;
      const dy = p.y - g.current.last.y;
      g.current.last = p;
      setObjects((prev) => prev.map((o) => (o.id === g.current.moveId ? translateObj(o, dx, dy) : o)));
    } else if (gm === "scale" && g.current.scaleSnap) {
      const next = applyScale(g.current.scaleSnap, p);
      setObjects((prev) => prev.map((o) => (o.id === g.current.moveId ? next : o)));
    } else if (gm === "rotate" && g.current.rotSnap && g.current.moveId) {
      const cur = st.current.objects.find((o) => o.id === g.current.moveId);
      if (cur) {
        const next = applyRotate(cur, p, g.current.rotSnap);
        setObjects((prev) => prev.map((o) => (o.id === g.current.moveId ? next : o)));
      }
    } else if (gm === "endpoint" && g.current.handle && g.current.moveId) {
      const cur = st.current.objects.find((o) => o.id === g.current.moveId);
      if (cur) {
        const next = applyEndpoint(cur, g.current.handle, p);
        setObjects((prev) => prev.map((o) => (o.id === g.current.moveId ? next : o)));
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
    } else if (gm === "draw" && g.current.draft) {
      const d = g.current.draft;
      g.current.draft = null;
      const b = localBBox(d);
      const meaningful = d.kind === "pen" || d.kind === "mosaic" ? d.points.length > 1 : b.w > 3 || b.h > 3;
      if (meaningful) setObjects((prev) => [...prev, d]);
      else redraw();
    }
    g.current.scaleSnap = null;
    g.current.rotSnap = null;
    g.current.handle = null;
  }

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
    const wrapWidth = Math.max(60, sel.x + sel.w - p.x - 4);
    setSelectedId(null);
    setEditing({ id: uid(), at: p, value: "", fontSize: FONT_SIZES[s.sizeIdx], wrapWidth, rotation: 0, color: COLORS[s.colorIdx], isNew: true });
    shot.setInputMode(true);
  }
  function startEditText(obj: TextObj) {
    setSelectedId(null);
    setObjects((prev) => prev.filter((o) => o.id !== obj.id));
    setEditing({ id: obj.id, at: obj.at, value: obj.value, fontSize: obj.fontSize, wrapWidth: obj.wrapWidth, rotation: obj.rotation, color: obj.color, isNew: false, orig: obj });
    shot.setInputMode(true);
  }
  function commitText() {
    const ed = st.current.editing;
    if (!ed) return;
    shot.setInputMode(false);
    setEditing(null);
    const value = ed.value.replace(/\s+$/g, "");
    if (!value) return; // 清空=删除
    const obj: TextObj = { id: ed.id, kind: "text", color: ed.color, size: 0, rotation: ed.rotation, at: ed.at, value: ed.value, fontSize: ed.fontSize, wrapWidth: ed.wrapWidth };
    setObjects((prev) => [...prev.filter((o) => o.id !== ed.id), obj]);
  }
  function cancelText() {
    const ed = st.current.editing;
    if (!ed) return;
    shot.setInputMode(false);
    setEditing(null);
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
      if (e.key === "Escape") {
        e.preventDefault();
        if (s.result) setResult(null);
        else if (s.selectedId) setSelectedId(null);
        else if (s.phase === "annotate") {
          setSelection(null);
          setObjects([]);
          setSelectedId(null);
          setPhase("select");
        } else shot.cancel();
      } else if ((e.key === "Delete" || e.key === "Backspace") && s.selectedId) {
        e.preventDefault();
        setObjects((prev) => prev.filter((o) => o.id !== s.selectedId));
        setSelectedId(null);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        setObjects((prev) => prev.slice(0, -1));
        setSelectedId(null);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C") && s.phase === "select") {
        // 取色：复制光标处颜色 HEX
        e.preventDefault();
        const c = cursorRef.current;
        navigator.clipboard.writeText(sampleColor(c.x, c.y));
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
    setResult({ loading: true, title: "OCR 文字识别", text: "" });
    const r = await shot.ocr(url);
    setResult({ loading: false, title: "OCR 文字识别", text: r.ok ? r.text || "" : "", error: r.ok ? undefined : r.error || "识别失败" });
  }
  async function doTranslate() {
    const url = compositeClean();
    if (!url) return;
    setResult({ loading: true, title: "翻译", text: "" });
    const r = await shot.translate(url);
    setResult({ loading: false, title: "翻译", text: r.ok ? r.translation || "" : "", error: r.ok ? undefined : r.error || "翻译失败" });
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

  // 面板改颜色/尺寸 → 同时作用于选中对象
  function applyColor(i: number) {
    setColorIdx(i);
    const id = st.current.selectedId;
    if (id) setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, color: COLORS[i] } : o)));
  }
  function applySize(i: 0 | 1 | 2) {
    setSizeIdx(i);
    const id = st.current.selectedId;
    if (!id) return;
    setObjects((prev) =>
      prev.map((o) => {
        if (o.id !== id) return o;
        if (o.kind === "text") return { ...o, fontSize: FONT_SIZES[i] };
        return { ...o, size: i };
      }),
    );
  }

  // ── 渲染 ──
  const TOOLS: { key: Tool; label: string }[] = [
    { key: "rect", label: "▭" },
    { key: "ellipse", label: "◯" },
    { key: "arrow", label: "↗" },
    { key: "pen", label: "✎" },
    { key: "mosaic", label: "▦" },
    { key: "text", label: "T" },
  ];

  return (
    <div style={{ width: "100vw", height: "100vh", overflow: "hidden" }}>
      {imgSrc ? <img ref={imgRef} src={imgSrc} onLoad={onImgLoad} draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} alt="" /> : null}
      <canvas ref={canvasRef} onMouseDown={onCanvasDown} onDoubleClick={onCanvasDbl} style={{ position: "absolute", inset: 0, cursor: phase === "select" ? "crosshair" : "default" }} />
      {(phase === "select" || phase === "annotate") && (selection || g.current.mode === "select") ? <SizeBadge get={() => (g.current.mode === "select" ? currentSel() : selection)} /> : null}
      {phase === "select" ? <Magnifier getCursor={() => cursorRef.current} sample={() => sampleRef.current} colorAt={sampleColor} /> : null}
      {editing ? <TextEditor edit={editing} onChange={(v) => setEditing((e) => (e ? { ...e, value: v } : e))} onBlurCommit={commitText} taRef={textAreaRef} /> : null}
      {phase === "annotate" && selection ? (
        <Toolbar
          sel={selection}
          tool={tool}
          colorIdx={colorIdx}
          sizeIdx={sizeIdx}
          tools={TOOLS}
          onTool={setTool}
          onColor={applyColor}
          onSize={applySize}
          onUndo={() => setObjects((p) => p.slice(0, -1))}
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
function ResultPanel({ sel, data, onClose }: { sel: Selection; data: { loading: boolean; title: string; text: string; error?: string }; onClose: () => void }) {
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
          <button style={{ ...plain, width: "auto", padding: "2px 8px", fontSize: 12 }} onClick={() => navigator.clipboard.writeText(data.text)}>复制全部</button>
        ) : null}
        <button style={{ ...plain, width: "auto", padding: "2px 8px", fontSize: 14 }} onClick={onClose}>✕</button>
      </div>
      <div style={{ padding: 12, maxHeight: 260, overflow: "auto", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", userSelect: "text" }}>
        {data.loading ? <span style={{ color: "#aaa" }}>识别中…</span> : data.error ? <span style={{ color: "#FF6961" }}>{data.error}</span> : data.text ? data.text : <span style={{ color: "#aaa" }}>未识别到文字</span>}
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
        <div style={{ color: "#aaa", marginTop: 2, fontSize: 10 }}>Press ⌘+C 复制颜色</div>
      </div>
    </div>
  );
}

// 文字编辑框（旋转用 CSS transform 同角度；字符折行与 canvas 一致）
function TextEditor({ edit, onChange, onBlurCommit, taRef }: { edit: TextEdit; onChange: (v: string) => void; onBlurCommit: () => void; taRef: React.RefObject<HTMLTextAreaElement> }) {
  const h = textSize({ id: edit.id, kind: "text", color: edit.color, size: 0, rotation: 0, at: edit.at, value: edit.value || " ", fontSize: edit.fontSize, wrapWidth: edit.wrapWidth }).h;
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
        width: edit.wrapWidth,
        height: Math.max(edit.fontSize * 1.35, h),
        transform: `rotate(${edit.rotation}rad)`,
        transformOrigin: `${edit.wrapWidth / 2}px ${h / 2}px`,
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
function Toolbar(props: {
  sel: Selection;
  tool: Tool;
  colorIdx: number;
  sizeIdx: 0 | 1 | 2;
  tools: { key: Tool; label: string }[];
  onTool: (t: Tool) => void;
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
  const { sel, tool } = props;
  const gap = 10;
  const barW = 430;
  let top = sel.y + sel.h + gap;
  const above = top + 100 > window.innerHeight;
  if (above) top = Math.max(gap, sel.y - 104);
  const left = Math.min(Math.max(gap, sel.x), window.innerWidth - barW - gap);

  const isText = tool === "text";
  const isMosaic = tool === "mosaic";

  return (
    <div style={{ position: "absolute", left, top, zIndex: 10 }} onMouseDown={(e) => e.stopPropagation()}>
      <div style={bar}>
        {props.tools.map((t) => (
          <button key={t.key} title={t.key} style={toolBtn(tool === t.key)} onClick={() => props.onTool(t.key)}>
            {t.label}
          </button>
        ))}
        <span style={sepV} />
        <button style={plain} title="撤销" onClick={props.onUndo}>↶</button>
        <button style={plain} title="OCR 文字识别" onClick={props.onOcr}>字</button>
        <button style={plain} title="翻译" onClick={props.onTranslate}>译</button>
        <button style={plain} title="贴图钉桌面" onClick={props.onPin}>📌</button>
        <button style={plain} title="取消" onClick={props.onCancel}>✕</button>
        <button style={plain} title="保存" onClick={props.onSave}>⇩</button>
        <button style={{ ...plain, color: "#34C759" }} title="完成/复制" onClick={props.onFinish}>✓</button>
      </div>
      <div style={panel}>
        {isText ? (
          FONT_SIZES.map((fs, i) => (
            <button key={fs} onClick={() => props.onSize(i as 0 | 1 | 2)} style={fontBtn(props.sizeIdx === i)}>
              <span style={{ fontSize: 10 + i * 4 }}>A</span>
            </button>
          ))
        ) : (
          [0, 1, 2].map((i) => (
            <button key={i} onClick={() => props.onSize(i as 0 | 1 | 2)} style={dotBtn(props.sizeIdx === i)}>
              <span style={{ display: "block", width: (isMosaic ? 6 : 4) + i * 3, height: (isMosaic ? 6 : 4) + i * 3, borderRadius: isMosaic ? 2 : "50%", background: props.sizeIdx === i ? "#fff" : "#bbb" }} />
            </button>
          ))
        )}
        <span style={sepV} />
        {COLORS.map((c, i) => (
          <button key={c} onClick={() => props.onColor(i)} style={swatch(c, props.colorIdx === i)} />
        ))}
      </div>
    </div>
  );
}

// ── 样式 ──
const bar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, background: "#2b2b2e", borderRadius: 9, padding: "5px 8px", boxShadow: "0 6px 20px rgba(0,0,0,.35)" };
const panel: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, background: "#2b2b2e", borderRadius: 9, padding: "6px 8px", marginTop: 6, boxShadow: "0 6px 20px rgba(0,0,0,.35)", width: "fit-content" };
const sepV: React.CSSProperties = { width: 1, height: 18, background: "#4a4a4e", margin: "0 3px" };
function toolBtn(active: boolean): React.CSSProperties {
  return { width: 30, height: 28, borderRadius: 6, border: "none", cursor: "pointer", fontSize: 15, background: active ? "#0A84FF" : "transparent", color: "#fff" };
}
const plain: React.CSSProperties = { width: 30, height: 28, borderRadius: 6, border: "none", cursor: "pointer", fontSize: 15, background: "transparent", color: "#fff" };
function swatch(c: string, active: boolean): React.CSSProperties {
  return { width: 20, height: 20, borderRadius: "50%", border: active ? "2px solid #fff" : "2px solid transparent", background: c, cursor: "pointer", padding: 0 };
}
function dotBtn(active: boolean): React.CSSProperties {
  return { width: 26, height: 26, borderRadius: 6, border: "none", background: active ? "#4a4a4e" : "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" };
}
function fontBtn(active: boolean): React.CSSProperties {
  return { minWidth: 26, height: 26, borderRadius: 6, border: "none", background: active ? "#4a4a4e" : "transparent", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" };
}
