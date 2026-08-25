// 记账的两张图：分类环形图 + 月度趋势柱状图。**手绘 canvas，不引 Chart.js** ——
// 一个环加一排柱，不值一个运行时依赖 + 一次 package-lock 三端同步的麻烦。
//
// 两条用血换来的规矩（验收第二轮的两个 bug）：
//
// 1. **canvas 不认识 CSS 变量**。fillStyle 塞 "var(--c1)" 这种字符串是非法值，
//    canvas 会原地保留上一次的颜色 —— 初始值是黑，于是整个环全黑。
//    所有进 canvas 的颜色都必须先过 resolveColor() 换成真实色值。
// 2. **重画必须挂依赖数组**。Chromium 在「内容从光标底下滚过」时会补发合成
//    mousemove 来刷 :hover —— 滚动经过图表 = 一串 mousemove = 一串 setTip
//    重渲染；effect 不挂依赖的话，每次重渲染都整张重画 + 重建 ResizeObserver，
//    滚到「月度趋势」那一段就一卡一卡（用户实测点名）。现在：数据变才重画，
//    悬停提示只在**命中的段变了**才 setState，滚动路过一次都不画。
//
// 主题切换：换肤是 App 根上的 React state，整棵子树会重渲染、segs/points 换新
// 引用、effect 跟着重跑 —— 正常路径够用。再补一个 MutationObserver 盯着最近的
// data-theme 属性，是给「子树被 memo 掉 / 独立窗口只改属性不重渲染」兜底的。
import { useEffect, useRef, useState } from "react";
import { yuan } from "./moneyKit";

/** 读 CSS 变量的当前值（跟着主题走）。在容器元素上读，拿到的就是生效值。 */
function cssVar(el: HTMLElement | null, name: string): string {
  if (!el) return "#888";
  return getComputedStyle(el).getPropertyValue(name).trim() || "#888";
}

/** 把 "var(--xx)" 解析成真实色值再交给 canvas；已经是真实色值的原样放行。 */
function resolveColor(el: HTMLElement | null, color: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(color.trim());
  return m ? cssVar(el, m[1]) : color;
}

/** 按设备像素比撑起画布，避免高分屏发糊。返回 CSS 像素下的宽高。 */
function fitCanvas(cv: HTMLCanvasElement): { w: number; h: number } {
  const w = cv.parentElement?.clientWidth || cv.clientWidth || 0;
  const h = cv.parentElement?.clientHeight || cv.clientHeight || 0;
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  cv.width = Math.max(1, Math.round(w * dpr));
  cv.height = Math.max(1, Math.round(h * dpr));
  const ctx = cv.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

/** 数据重画之外的两个重画时机：容器变尺寸、主题换肤。挂上并返回统一的清理函数。 */
function watchRedraw(cv: HTMLCanvasElement, draw: () => void): () => void {
  const ro = new ResizeObserver(draw);
  if (cv.parentElement) ro.observe(cv.parentElement);
  const themed = cv.closest("[data-theme]");
  const mo = new MutationObserver(draw);
  if (themed) mo.observe(themed, { attributes: true, attributeFilter: ["data-theme"] });
  return () => { ro.disconnect(); mo.disconnect(); };
}

interface Tip { x: number; y: number; text: string }

/** 悬停提示。绝对定位在图表容器里，夹在容器内不出界。 */
function TipBox({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="absolute z-10 pointer-events-none px-[9px] py-[4px] rounded-[7px] bg-card border border-border shadow-[var(--shadow-floating)] text-[11.5px] whitespace-nowrap"
      style={{ left: tip.x, top: tip.y, transform: "translate(-50%, -130%)" }}>
      {tip.text}
    </div>
  );
}

/** 提示只在「命中目标变了」才 setState —— 光标在同一段里挪动零重渲染。 */
function useTip(): [Tip | null, (t: Tip | null) => void] {
  const [tip, setTip] = useState<Tip | null>(null);
  const keyRef = useRef<string | null>(null);
  const show = (t: Tip | null) => {
    const key = t?.text ?? null;
    if (key === keyRef.current) return;
    keyRef.current = key;
    setTip(t);
  };
  return [tip, show];
}

export interface DonutSeg { label: string; cents: number; color: string }

/** 环形图。中心文字由外面叠（跟稿一样），这里只画环与承接悬停。 */
export function DonutChart({ segs }: { segs: DonutSeg[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [tip, showTip] = useTip();
  // 悬停命中要用到每段的角度区间，画的时候顺手存下来。
  const arcsRef = useRef<{ from: number; to: number; label: string; cents: number }[]>([]);

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const draw = () => {
      const { w, h } = fitCanvas(cv);
      const ctx = cv.getContext("2d");
      if (!ctx || !w || !h) return;
      ctx.clearRect(0, 0, w, h);
      const total = segs.reduce((n, s) => n + s.cents, 0);
      if (!total) return;
      const cx = w / 2, cy = h / 2;
      const r = Math.min(w, h) / 2 - 2;
      const inner = r * 0.68;                       // 稿：cutout 68%
      const border = cssVar(boxRef.current, "--card");
      let a = -Math.PI / 2;                          // 从 12 点方向起画
      arcsRef.current = [];
      for (const s of segs) {
        const sweep = (s.cents / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, a, a + sweep);
        ctx.arc(cx, cy, inner, a + sweep, a, true);
        ctx.closePath();
        // 段色是 "var(--cN)" —— 必须解析成真实色值，直接塞会整环全黑（见文件头）。
        ctx.fillStyle = resolveColor(boxRef.current, s.color);
        ctx.fill();
        // 段间 2px 的卡片色描边，跟稿的 borderWidth: 2 同款。
        ctx.strokeStyle = border;
        ctx.lineWidth = 2;
        ctx.stroke();
        arcsRef.current.push({ from: a, to: a + sweep, label: s.label, cents: s.cents });
        a += sweep;
      }
    };
    draw();
    return watchRedraw(cv, draw);
  }, [segs]);

  const onMove = (e: React.MouseEvent) => {
    const cv = cvRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const cx = rect.width / 2, cy = rect.height / 2;
    const r = Math.min(rect.width, rect.height) / 2 - 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < r * 0.68 || dist > r) { showTip(null); return; }
    // atan2 的角从 -π 起，画的时候从 -π/2 起 —— 归一到同一个圈再比对。
    let ang = Math.atan2(y - cy, x - cx);
    if (ang < -Math.PI / 2) ang += Math.PI * 2;
    const hit = arcsRef.current.find((s) => ang >= s.from && ang < s.to);
    if (!hit) { showTip(null); return; }
    // 提示钉在这一段的中点角上，不跟着光标跑 —— 光标在段内挪动就不触发重渲染。
    const mid = (hit.from + hit.to) / 2, rad = (r + r * 0.68) / 2;
    showTip({ x: cx + Math.cos(mid) * rad, y: cy + Math.sin(mid) * rad, text: `${hit.label} ¥${yuan(hit.cents)}` });
  };

  return (
    <div ref={boxRef} className="relative w-full h-full">
      <canvas ref={cvRef} className="block w-full h-full" onMouseMove={onMove} onMouseLeave={() => showTip(null)} />
      <TipBox tip={tip} />
    </div>
  );
}

export interface TrendPt { label: string; cents: number; current: boolean }

/** 月度趋势柱状图。稿的硬规则：只画支出一个序列、单一 Y 轴；
 *  当前月强调橙、其余中性灰；**柱顶只标当前月，其余悬停查看**。 */
export function TrendBars({ points }: { points: TrendPt[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [tip, showTip] = useTip();
  const barsRef = useRef<{ x: number; w: number; label: string; cents: number }[]>([]);

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const draw = () => {
      const { w, h } = fitCanvas(cv);
      const ctx = cv.getContext("2d");
      if (!ctx || !w || !h || !points.length) return;
      ctx.clearRect(0, 0, w, h);
      const el = boxRef.current;
      const padL = 40, padB = 20, padT = 16;
      const plotW = w - padL - 6, plotH = h - padT - padB;
      const max = Math.max(...points.map((p) => p.cents), 1);
      // Y 轴刻度：至多 4 条（稿 maxTicksLimit: 4），取「好看的」步长。
      const step = niceStep(max / 3);
      const top = Math.ceil(max / step) * step;
      ctx.strokeStyle = cssVar(el, "--border");
      ctx.fillStyle = cssVar(el, "--faint");
      ctx.font = "11px system-ui, sans-serif";
      ctx.lineWidth = 1;
      for (let v = 0; v <= top; v += step) {
        const y = padT + plotH - (v / top) * plotH + 0.5;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - 6, y);
        ctx.stroke();
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        // 金额刻度用「万」缩短（稿同款），避免六位数把 Y 轴挤没。
        ctx.fillText(v >= 1000000 ? `${v / 1000000}万` : String(Math.round(v / 100)), padL - 6, y);
      }
      // 柱宽按稿的 barPercentage 0.62 · categoryPercentage 0.86 折算。
      const slot = plotW / points.length;
      const bw = slot * 0.62 * 0.86;
      barsRef.current = [];
      points.forEach((p, i) => {
        const x = padL + slot * i + (slot - bw) / 2;
        const bh = (p.cents / top) * plotH;
        const y = padT + plotH - bh;
        ctx.fillStyle = p.current ? cssVar(el, "--orange") : cssVar(el, "--track");
        roundedRect(ctx, x, y, bw, Math.max(bh, p.cents > 0 ? 2 : 0), 4);
        ctx.fill();
        ctx.fillStyle = cssVar(el, "--faint");
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(p.label, x + bw / 2, padT + plotH + 5);
        if (p.current && p.cents > 0) {
          ctx.fillStyle = cssVar(el, "--text");
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.font = "600 11px system-ui, sans-serif";
          ctx.fillText(`¥${yuan(p.cents)}`, x + bw / 2, y - 3);
          ctx.font = "11px system-ui, sans-serif";
        }
        barsRef.current.push({ x, w: bw, label: p.label, cents: p.cents });
      });
    };
    draw();
    return watchRedraw(cv, draw);
  }, [points]);

  const onMove = (e: React.MouseEvent) => {
    const cv = cvRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const hit = barsRef.current.find((b) => x >= b.x && x <= b.x + b.w);
    if (!hit) { showTip(null); return; }
    // 位置由命中的柱决定（柱心 + 固定高度），同一根柱里挪光标不重渲染。
    showTip({ x: hit.x + hit.w / 2, y: 26, text: `${hit.label} ¥${yuan(hit.cents)}` });
  };

  return (
    <div ref={boxRef} className="relative w-full h-full">
      <canvas ref={cvRef} className="block w-full h-full" onMouseMove={onMove} onMouseLeave={() => showTip(null)} />
      <TipBox tip={tip} />
    </div>
  );
}

/** 1-2-5 序列里挑一个不小于 raw 的步长，刻度值才是整的。 */
function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  for (const m of [1, 2, 5, 10]) {
    if (m * mag >= raw) return m * mag;
  }
  return 10 * mag;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}
