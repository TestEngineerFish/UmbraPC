// 文本视图浮层：把长文摊在居中面板里显示，支持 Markdown 渲染、流式追加与等待动画。
// 空导出：让本文件成为「模块」而不是全局脚本，避免与 largetype-entry.ts 的同名顶层变量打架。
export {};

// 与大字显示（largetype）互补——那边是「一句话放到最大」，这边是「一整篇能读完」。
// 渲染范式相同：渲染层画好后回调 rendered()，主进程才把窗口显示出来，避免闪出上一次的内容。

// 一次展示请求（与主进程 TextViewPayload 对齐）。
interface TextPayload {
  text: string;
  title?: string;
  md?: boolean;        // 是否按 Markdown 渲染（默认是）
  append?: boolean;    // 追加到现有内容（流式续写）而不是整体替换
  loading?: boolean;   // 显示等待动画（等秘书回复时用）
}
interface TextAPI {
  ready(): Promise<TextPayload | null>;
  rendered(): Promise<void>;
  close(): Promise<void>;
  onData(cb: (p: TextPayload) => void): () => void;
}
const api = (window as unknown as { umbraText: TextAPI }).umbraText;

const style = document.createElement("style");
style.textContent = `
  /* 这个浮层永远是深色卡片，所以固定声明 color-scheme:dark：
     系统处在浅色时，原生滚动条/选中色会按浅色渲染，压在深底上是一道白杠。 */
  html,body{color-scheme:dark;margin:0;height:100%;background:transparent;overflow:hidden;
    font-family:-apple-system,"SF Pro Text",system-ui,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;}
  #text-root{position:fixed;inset:0;display:flex;flex-direction:column;padding:12px;box-sizing:border-box;}
  .card{flex:1;display:flex;flex-direction:column;min-height:0;border-radius:18px;overflow:hidden;
    background:rgba(24,20,17,.94);box-shadow:0 30px 90px rgba(0,0,0,.55);backdrop-filter:blur(14px);
    border:1px solid rgba(255,255,255,.10);}
  .bar{flex:none;display:flex;align-items:center;gap:10px;padding:12px 16px;
    border-bottom:1px solid rgba(255,255,255,.08);-webkit-app-region:drag;}
  .bar .ttl{flex:1;color:#F3EDE6;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .bar button{-webkit-app-region:no-drag;flex:none;border:0;cursor:pointer;color:#C9BFB4;font-size:12px;
    background:rgba(255,255,255,.08);border-radius:8px;padding:4px 10px;}
  .bar button:hover{background:rgba(255,255,255,.16);color:#fff;}
  .body{flex:1;min-height:0;overflow:auto;padding:18px 22px;color:#EDE5DC;font-size:14.5px;line-height:1.75;}
  .body::-webkit-scrollbar{width:9px;} .body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.20);border-radius:999px;}
  .body.plain{white-space:pre-wrap;word-break:break-word;}
  .body h1,.body h2,.body h3{color:#FFF6EA;margin:18px 0 8px;line-height:1.35;}
  .body h1{font-size:21px;} .body h2{font-size:18px;} .body h3{font-size:16px;}
  .body p{margin:9px 0;} .body ul,.body ol{margin:9px 0;padding-left:22px;} .body li{margin:3px 0;}
  .body a{color:#E8A87C;} .body strong{color:#FFF3E4;}
  .body blockquote{margin:10px 0;padding:2px 14px;border-left:3px solid rgba(232,168,124,.55);color:#CDBFB2;}
  .body hr{border:0;border-top:1px solid rgba(255,255,255,.10);margin:16px 0;}
  .body code{background:rgba(255,255,255,.09);padding:1.5px 5px;border-radius:5px;font-size:12.5px;
    font-family:"SF Mono",Menlo,Consolas,monospace;}
  .body pre{background:rgba(0,0,0,.42);border:1px solid rgba(255,255,255,.07);border-radius:10px;
    padding:12px 14px;overflow:auto;margin:11px 0;}
  .body pre code{background:none;padding:0;font-size:12.5px;line-height:1.6;}
  .body table{border-collapse:collapse;margin:11px 0;} .body th,.body td{border:1px solid rgba(255,255,255,.12);padding:6px 10px;}
  .dots{display:inline-flex;gap:5px;padding:4px 0;}
  .dots i{width:7px;height:7px;border-radius:50%;background:#E8A87C;animation:bl 1.1s infinite ease-in-out;}
  .dots i:nth-child(2){animation-delay:.16s;} .dots i:nth-child(3){animation-delay:.32s;}
  @keyframes bl{0%,80%,100%{opacity:.25;transform:translateY(0);}40%{opacity:1;transform:translateY(-3px);}}
  .hint{margin-top:12px;color:#9C9187;font-size:12px;}
`;
document.head.appendChild(style);

const root = document.getElementById("text-root")!;
root.innerHTML = `
  <div class="card">
    <div class="bar"><div class="ttl" id="tv-title">文本视图</div><button id="tv-close">关闭 Esc</button></div>
    <div class="body" id="tv-body"></div>
  </div>`;
const titleEl = document.getElementById("tv-title") as HTMLDivElement;
const bodyEl = document.getElementById("tv-body") as HTMLDivElement;
document.getElementById("tv-close")!.addEventListener("click", () => void api.close());

// 累积的原始文本（append 模式下需要保留历史，重新整篇渲染）。
let buffer = "";

// HTML 转义：所有正文内容都先转义，再由下面的 Markdown 规则生成受控标签，避免注入。
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 极简 Markdown → HTML：标题 / 列表 / 引用 / 分隔线 / 代码块 / 行内强调与代码 / 链接。
// 只覆盖秘书回复里高频出现的语法，不追求完备（复杂排版让用户去主窗口看）。
function md(src: string): string {
  const lines = esc(src).split(/\r?\n/);
  const out: string[] = [];
  let inCode = false, listType = "";
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = ""; } };
  for (const raw of lines) {
    const line = raw;
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      if (inCode) { out.push("</code></pre>"); inCode = false; }
      else { closeList(); out.push("<pre><code>"); inCode = true; }
      continue;
    }
    if (inCode) { out.push(line + "\n"); continue; }
    if (!line.trim()) { closeList(); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { closeList(); out.push("<hr/>"); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const q = line.match(/^\s*&gt;\s?(.*)$/);
    if (q) { closeList(); out.push(`<blockquote>${inline(q[1])}</blockquote>`); continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) { if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) { if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) out.push("</code></pre>");
  closeList();
  return out.join("");
}

// 行内规则：`代码` → **粗** → *斜* → [文字](链接)。代码先占位，避免代码里的星号被当强调。
function inline(s: string): string {
  const codes: string[] = [];
  let t = s.replace(/`([^`]+)`/g, (_m, c) => { codes.push(c); return `\u0000C${codes.length - 1}\u0000`; });
  t = t
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return t.replace(/\u0000C(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
}

// 画一屏内容：整体替换或追加，Markdown 或纯文本，末尾可挂等待动画。
function show(p: TextPayload): void {
  const text = String(p.text ?? "");
  buffer = p.append ? buffer + text : text;
  titleEl.textContent = p.title || "文本视图";
  const useMd = p.md !== false;
  bodyEl.className = useMd ? "body" : "body plain";
  const loading = p.loading
    ? `<div class="dots"><i></i><i></i><i></i></div><div class="hint">正在等待秘书回复…（Esc 关闭）</div>`
    : "";
  if (useMd) bodyEl.innerHTML = md(buffer) + loading;
  else bodyEl.innerHTML = `${esc(buffer)}${loading}`;
  // 流式追加时始终滚到底，让新内容始终可见。
  if (p.append) bodyEl.scrollTop = bodyEl.scrollHeight;
  void api.rendered();
}

api.onData(show);
void api.ready().then((p) => { if (p) show(p); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape") void api.close(); });
