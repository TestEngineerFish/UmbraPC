// 通用「换图标 / 上传素材」控件（2026-09-03，sam 点名封装：换图和上传素材的逻辑
// 各处不要各写一遍）。一个值三种来源，调用方只拿到一个字符串：
//   · 线性图标：语义名（gift / housing / …），path 由调用方给的 icons 表解析；
//   · 自定义图片：data URL（本地上传 / 拖进来 / ⌘V 粘贴 / 填网址取回，一律先压成 ≤128px）；
//   · 空串：没有图标，调用方自己画兜底（首字 monogram 之类）。
// 存的是**值**不是路径 —— 语义名跨端同名可画（iOS 有同一批 path），data URL 自带内容。
//
// 两件组成：IconThumb 负责把值画出来（谁要显示图标都用它），IconPickerPop 是锚定弹层。
// 视觉按批次 009 定稿（token iconPicker / 稿「PC 图标选择器.dc.html」）：248 弹层、
// 6 列 32 网格、62 高落点三态、网址行 + 幽灵取回钮、头行右侧「清除」。
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { showToast } from "./overlay";

// d 既可以是纯 path 的 d 值（记账那批老图标），也可以是**整段 svg 内部标记**
// （保险箱 16 个专属图标带 <circle>/<rect>，见 umbra-icons.json 的 body）。
export interface IconOption { k: string; label: string; d: string }

// 统一成 svg 内部标记：纯 d 包一层 <path>。渲染走 innerHTML —— React 没法把
// 字符串标记当子元素，而图标表是我们自己从设计包抄的常量，不是用户输入，没有注入面。
const svgBody = (d: string): string => (d.trimStart().startsWith("<") ? d : `<path d="${d}"/>`);

/** 值的种类：image = data:/http(s) 的图片；line = 语义名；none = 空。 */
export function iconKind(v?: string): "none" | "line" | "image" {
  if (!v) return "none";
  return /^(data:|https?:\/\/)/i.test(v) ? "image" : "line";
}

/** 把一个值画成图标方块。找不到语义名 / 值为空 → 渲染 fallback（调用方给，通常是首字）。 */
export function IconThumb({ value, icons, size, radius, on, fallback, className, title }: {
  value?: string; icons?: IconOption[]; size: number; radius: number; on?: boolean;
  fallback: React.ReactNode; className?: string; title?: string;
}) {
  const kind = iconKind(value);
  const d = kind === "line" ? icons?.find((o) => o.k === value)?.d : undefined;
  if (kind === "image") {
    return (
      <span className={`flex-none inline-flex items-center justify-center overflow-hidden bg-chip ${className || ""}`}
        style={{ width: size, height: size, borderRadius: radius }} title={title}>
        <img src={value} alt="" draggable={false} className="w-full h-full object-cover" />
      </span>
    );
  }
  if (d) {
    return (
      <span className={`flex-none inline-flex items-center justify-center ${on ? "bg-orange text-white" : "bg-chip text-muted"} ${className || ""}`}
        style={{ width: size, height: size, borderRadius: radius }} title={title}>
        <svg width={Math.round(size * 0.6)} height={Math.round(size * 0.6)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: svgBody(d) }} />
      </span>
    );
  }
  return <>{fallback}</>;
}

// ── 图片压缩 ────────────────────────────────────────────────────────────────
// 图标只会以 ≤40px 显示，存原图（截图动辄几百 KB 到几 MB）纯属浪费，而且保险箱这种
// 会整库加密同步的地方，一张大图就把同步拖慢。规则：
//   · SVG 且 ≤12KB 原样存（矢量最清楚，压成位图反而糊）；
//   · 其它一律画进 canvas，长边压到 128，PNG；结果还 >24KB 就换 WebP 0.85，再不行长边 96。
const MAX_SIDE = 128;
const MAX_BYTES = 24 * 1024;
export async function compressIcon(src: Blob | string): Promise<string> {
  const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
  if (blob.type === "image/svg+xml" && blob.size <= 12 * 1024) {
    return await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(blob); });
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("这个文件不是能显示的图片"));
      i.src = url;
    });
    const draw = (side: number): HTMLCanvasElement => {
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c;
    };
    let c = draw(MAX_SIDE);
    let out = c.toDataURL("image/png");
    if (out.length > MAX_BYTES * 1.37) out = c.toDataURL("image/webp", 0.85);   // base64 膨胀 ~37%
    if (out.length > MAX_BYTES * 1.37) { c = draw(96); out = c.toDataURL("image/webp", 0.8); }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── 锚定弹层 ────────────────────────────────────────────────────────────────
export function IconPickerPop({ x, y, title, value, icons, allowImage = true, notePrefix, onPick, onClose }: {
  x: number; y: number; title: string; value?: string; icons?: IconOption[];
  /** 是否开放「用一张图片」那一段（上传 / 拖入 / 粘贴 / 网址）。 */
  allowImage?: boolean;
  /** 底部说明前面多写的一句（记账场景传「只换样子，名字和已记的账不动。」）。 */
  notePrefix?: string;
  onPick: (v: string) => void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pick = (v: string) => { onPick(v); onClose(); };

  const takeBlob = async (b: Blob) => {
    if (!b.type.startsWith("image/")) { showToast("只能用图片文件", { tone: "fail" }); return; }
    setBusy(true);
    try { pick(await compressIcon(b)); }
    catch (e) { showToast(String(e instanceof Error ? e.message : e), { tone: "fail" }); }
    finally { setBusy(false); }
  };
  const fromUrl = async () => {
    const u = url.trim();
    if (!u) return;
    setBusy(true);
    try {
      // 桌面端走主进程取（没有 CORS，还会退回站点 favicon）；浏览器预览只能直接 fetch 碰运气。
      type Fetched = { ok: boolean; dataUrl?: string; error?: string };
      const r: Fetched = window.umbra?.fetchImage
        ? await window.umbra.fetchImage(u)
        : await fetch(/^https?:\/\//i.test(u) ? u : "https://" + u)
          .then(async (x): Promise<Fetched> => ({ ok: x.ok, dataUrl: URL.createObjectURL(await x.blob()) }))
          .catch((): Fetched => ({ ok: false, error: "取不到" }));
      if (!r.ok || !r.dataUrl) { showToast(r.error || "这个网址取不到图片", { tone: "fail" }); return; }
      pick(await compressIcon(r.dataUrl));
    } catch (e) { showToast(String(e instanceof Error ? e.message : e), { tone: "fail" }); }
    finally { setBusy(false); }
  };

  // 弹层开着时 ⌘V：剪贴板里有图就直接用。挂 document —— 弹层里的输入框可能没焦点。
  useEffect(() => {
    if (!allowImage) return;
    const onPaste = (e: ClipboardEvent) => {
      const f = Array.from(e.clipboardData?.files || []).find((x) => x.type.startsWith("image/"));
      if (!f) return;
      e.preventDefault(); e.stopPropagation();
      void takeBlob(f);
    };
    // capture：要抢在保险箱附件区那个 document 级粘贴分发之前。
    document.addEventListener("paste", onPaste, true);
    return () => document.removeEventListener("paste", onPaste, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowImage]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 弹层贴着锚点，但不能出屏：右/下越界就往回挪（距边至少 8，token iconPicker.pop.anchor）。
  const W = 248;
  const left = Math.max(8, Math.min(x, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - 8 - (allowImage ? 330 : 170)));
  // 网格 6 列 × 32 方块 gap 6（稿定）：6×32 + 5×6 = 222 = 弹层 248 − 边框 2 − 内距 2×12。
  const cell = (on: boolean) =>
    `w-[32px] h-[32px] flex-none flex items-center justify-center rounded-[8px] cursor-pointer border ${
      on ? "border-orange bg-orange-soft text-orange-text" : "border-border bg-card text-muted hover:border-orange"}`;
  const hasImg = iconKind(value) === "image";
  const node = (
    <>
      <div className="fixed inset-0 z-[69]" onMouseDown={onClose} />
      <div className="fixed z-[70] bg-card border border-border rounded-[10px] px-[12px] pt-[9px] pb-[9px] shadow-[shadow:var(--shadow-floating)] text-text"
        style={{ left, top, width: W, WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <div className="flex items-baseline gap-[7px] px-[1px] pt-[1px] pb-[8px]">
          <span className="flex-none text-[10.5px] font-semibold tracking-[.06em] text-faint whitespace-nowrap">换图标</span>
          <span className="flex-1 min-w-0 text-[11px] text-text truncate">{title}</span>
          {/* 清除不算破坏性操作、不做二次确认 —— 它只是回落首字 monogram，不删数据（稿定）。 */}
          {value ? <button className="flex-none text-[11px] text-muted hover:text-orange-text bg-transparent border-none cursor-pointer p-0" onClick={() => pick("")}>清除</button> : null}
        </div>
        {icons?.length ? (
          <div className="grid grid-cols-6 gap-[6px]">
            {icons.map((o) => (
              <button key={o.k} title={o.label} disabled={busy} onClick={() => pick(o.k)} className={cell(value === o.k)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: svgBody(o.d) }} />
              </button>
            ))}
          </div>
        ) : null}
        {allowImage ? (
          <div className={`flex flex-col gap-[7px] ${icons?.length ? "mt-[10px] pt-[9px] border-t border-border-soft" : ""}`}>
            <div className="px-[1px] text-[10.5px] font-semibold tracking-[.06em] text-faint">用一张图片</div>
            {/* 落点三态（稿定）：平时虚线 --border；拖入 2px --orange + 橙软底；已有图左挂 22 缩略。 */}
            <button
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              onDragEnter={(e) => { e.preventDefault(); setOver(true); }}
              onDragOver={(e) => { e.preventDefault(); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void takeBlob(f); }}
              className={`w-full min-h-[62px] flex items-center justify-center gap-[9px] rounded-[9px] bg-transparent cursor-pointer px-[10px] ${
                over ? "border-2 border-orange bg-orange-soft" : "border border-dashed border-border hover:border-orange"}`}>
              {hasImg && !over ? (
                <img src={value} alt="" className="w-[22px] h-[22px] rounded-[6px] border border-border object-cover flex-none" />
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
                  className={`flex-none ${over ? "text-orange-text" : "text-muted"}`}><path d="M12 15V4M7 8l5-4 5 4M5 20h14" /></svg>
              )}
              <span className="flex flex-col items-start gap-[2px] min-w-0">
                <span className={`text-[12px] font-medium whitespace-nowrap ${over ? "text-orange-text" : "text-text"}`}>
                  {busy ? "处理中…" : over ? "松开就用这张" : hasImg ? "换一张图片" : "选一张图片"}
                </span>
                <span className={`text-[10.5px] whitespace-nowrap ${over ? "text-orange-text" : "text-faint"}`}>
                  {over ? "会压到 128px 以内" : "拖进来或 ⌘V 粘贴都行"}
                </span>
              </span>
            </button>
            <div className="flex items-center gap-[6px]">
              <input
                className="flex-1 min-w-0 border border-border bg-bg text-text rounded-[7px] px-[8px] py-[6px] text-[11.5px] outline-none focus:border-orange"
                value={url}
                placeholder="图片链接 / 网站地址"
                disabled={busy}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void fromUrl(); }}
              />
              <button disabled={busy || !url.trim()} onClick={() => void fromUrl()}
                className="flex-none whitespace-nowrap px-[9px] py-[6px] rounded-[7px] border border-border bg-transparent text-[11.5px] text-muted cursor-pointer hover:border-orange hover:text-orange-text disabled:text-faint disabled:cursor-not-allowed">取回</button>
            </div>
            <div className="px-[1px] text-[10.5px] text-faint leading-[1.6]">
              {notePrefix ? `${notePrefix} ` : ""}填图片链接直接取，填网站地址取它的图标；图片会压到 128px 以内再保存。
            </div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void takeBlob(f); e.target.value = ""; }} />
          </div>
        ) : notePrefix ? (
          <div className="px-[1px] pt-[8px] text-[10.5px] text-faint leading-[1.6]">{notePrefix}</div>
        ) : null}
      </div>
    </>
  );
  return createPortal(node, document.querySelector(".umbra-root") ?? document.body);
}
