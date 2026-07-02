// 剪贴板历史面板（独立无边框窗口渲染层）。纯 DOM，无框架，走 window.umbraClip IPC。
export {}; // 使本文件成为模块（下方 declare global 需要）
type ClipType = "text" | "image" | "files";
interface ClipItem {
  id: number;
  type: ClipType;
  content: string;
  preview: string;
  hash: string;
  favorite: boolean;
  size: number;
  sourcePath?: string;
  sourceApp?: string;
  sourceAppPath?: string;
  lastUsedAt: number;
  createdAt: number;
}
type Category = "all" | "text" | "image" | "files" | "favorite";

interface ClipAPI {
  list(category: Category, keyword: string): Promise<ClipItem[]>;
  copy(id: number): Promise<boolean>;
  paste(id: number): Promise<boolean>;
  setFavorite(id: number, favorite: boolean): Promise<boolean>;
  remove(id: number): Promise<boolean>;
  clear(): Promise<boolean>;
  readImageDataUrl(id: number): Promise<string>;
  readPathThumbnail(p: string): Promise<string>;
  getAppIcon(p: string): Promise<string>;
  hidePanel(): Promise<boolean>;
  onHistoryChanged(cb: () => void): () => void;
  onPanelShown(cb: () => void): () => void;
}
declare global {
  interface Window {
    umbraClip: ClipAPI;
  }
}
const api = window.umbraClip;

// ── 主题 & 样式 ──
const style = document.createElement("style");
style.textContent = `
:root{--bg:#F6F5F2;--card:#FFFFFF;--border:#E6E3DC;--text:#1F2320;--muted:#6B716B;--orange:#E8590C;--orange-soft:#FFF1E6;--chip:#F0EEEA;--sel:#FFF1E6;}
*{box-sizing:border-box;}
html,body{margin:0;height:100%;background:transparent;font-family:-apple-system,"SF Pro Text",system-ui,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;color:var(--text);}
#clip-root{height:100vh;}
.wrap{height:100vh;display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--border);border-radius:14px;overflow:hidden;}
.search{display:flex;align-items:center;gap:8px;padding:11px 14px;-webkit-app-region:drag;}
.search input{flex:1;-webkit-app-region:no-drag;border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:9px;padding:8px 11px;font-size:13px;outline:none;}
.tabs{display:flex;gap:6px;padding:0 14px 9px;-webkit-app-region:drag;}
.tab{-webkit-app-region:no-drag;border:1px solid var(--border);background:var(--card);color:var(--muted);border-radius:999px;padding:4px 13px;font-size:12px;cursor:pointer;}
.tab.on{background:var(--orange);border-color:var(--orange);color:#fff;font-weight:600;}
.body{flex:1;display:flex;min-height:0;border-top:1px solid var(--border);}
.list{width:300px;overflow-y:auto;border-right:1px solid var(--border);padding:6px;}
.row{display:flex;gap:9px;align-items:flex-start;padding:8px 9px;border-radius:9px;cursor:pointer;}
.row.sel{background:var(--sel);}
.row .idx{width:16px;font-size:11px;color:var(--muted);text-align:center;flex:none;padding-top:2px;}
.row .ic{width:22px;height:22px;border-radius:6px;flex:none;object-fit:cover;background:var(--chip);display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--muted);overflow:hidden;}
.row .mid{flex:1;min-width:0;}
.row .ttl{font-size:12.5px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-all;}
.row .sub{font-size:10.5px;color:var(--muted);margin-top:2px;}
.row .star{flex:none;color:var(--orange);font-size:12px;padding-top:2px;opacity:0;}
.row .star.on{opacity:1;}
.row .thumb{width:40px;height:40px;border-radius:6px;object-fit:cover;border:1px solid var(--border);flex:none;}
.swatch{display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid var(--border);vertical-align:-1px;margin-left:5px;}
.preview{flex:1;min-width:0;display:flex;flex-direction:column;padding:14px;overflow:hidden;}
.pv-body{flex:1;overflow:auto;}
.pv-text{white-space:pre-wrap;word-break:break-all;font-size:13px;line-height:1.6;}
.pv-img{max-width:100%;max-height:230px;border-radius:8px;border:1px solid var(--border);}
.pv-meta{border-top:1px solid var(--border);padding-top:9px;margin-top:9px;font-size:11px;color:var(--muted);display:flex;align-items:center;gap:7px;flex-wrap:wrap;}
.pv-meta img{width:16px;height:16px;border-radius:4px;}
.kv{font-size:11.5px;color:var(--muted);margin-top:5px;}
.kv b{color:var(--text);font-weight:600;}
.hint{border-top:1px solid var(--border);padding:7px 14px;font-size:11px;color:var(--muted);text-align:center;}
.empty{color:var(--muted);text-align:center;padding:40px 10px;font-size:13px;}
.menu{position:fixed;z-index:99;background:var(--card);border:1px solid var(--border);border-radius:9px;padding:5px;box-shadow:0 8px 24px rgba(0,0,0,.18);min-width:130px;}
.menu button{display:block;width:100%;text-align:left;border:none;background:transparent;color:var(--text);padding:7px 11px;font-size:12.5px;border-radius:6px;cursor:pointer;}
.menu button:hover{background:var(--chip);}
.menu button.del{color:#B42318;}
.fileline{font-size:12px;margin-bottom:8px;}
.fileline .p{color:var(--muted);font-size:10.5px;word-break:break-all;}
`;
document.head.appendChild(style);

const root = document.getElementById("clip-root")!;
root.innerHTML = `
<div class="wrap">
  <div class="search"><input id="q" type="text" placeholder="搜索剪贴板历史…" spellcheck="false" /></div>
  <div class="tabs" id="tabs">
    <button class="tab on" data-cat="all">全部</button>
    <button class="tab" data-cat="text">文本</button>
    <button class="tab" data-cat="image">图像</button>
    <button class="tab" data-cat="files">文件</button>
    <button class="tab" data-cat="favorite">收藏</button>
  </div>
  <div class="body">
    <div class="list" id="list"></div>
    <div class="preview" id="preview"></div>
  </div>
  <div class="hint">Enter/双击 粘贴 · 1-9 快选 · ↑↓ 移动 · 右键菜单 · Esc 关闭</div>
</div>`;

const qEl = document.getElementById("q") as HTMLInputElement;
const listEl = document.getElementById("list")!;
const previewEl = document.getElementById("preview")!;
const tabsEl = document.getElementById("tabs")!;

let items: ClipItem[] = [];
let category: Category = "all";
let keyword = "";
let selected = 0;
const iconCache = new Map<string, string>();

const esc = (s: string) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

function colorOf(text: string): string | null {
  const t = (text || "").trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t)) return t;
  if (/^rgba?\([\d.,\s%]+\)$/i.test(t) && t.length < 40) return t;
  if (/^hsla?\([\d.,\s%]+\)$/i.test(t) && t.length < 40) return t;
  return null;
}
function timeStr(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fileName(it: ClipItem): string {
  if (it.sourcePath) return it.sourcePath.split("/").pop() || it.sourcePath;
  return `图像: ${it.preview}`;
}
function typeGlyph(t: ClipType): string {
  return t === "image" ? "🖼" : t === "files" ? "📄" : "✎";
}

async function refresh(preserveId?: number): Promise<void> {
  items = await api.list(category, keyword);
  if (preserveId != null) {
    const i = items.findIndex((x) => x.id === preserveId);
    selected = i >= 0 ? i : 0;
  } else if (selected >= items.length) {
    selected = Math.max(0, items.length - 1);
  }
  renderList();
  renderPreview();
}

function renderList(): void {
  if (!items.length) {
    listEl.innerHTML = `<div class="empty">暂无历史</div>`;
    return;
  }
  listEl.innerHTML = items
    .map((it, i) => {
      const num = keyword === "" && i < 9 ? i + 1 : "";
      let title: string;
      let thumb = "";
      if (it.type === "image") {
        title = esc(fileName(it));
        thumb = `<img class="thumb" data-thumb="${it.id}" alt="" />`;
      } else if (it.type === "files") {
        let names = it.preview;
        try {
          const arr = JSON.parse(it.content) as string[];
          names = arr.map((p) => p.split("/").pop()).join(", ");
        } catch {
          /* use preview */
        }
        title = esc(names);
      } else {
        const c = colorOf(it.content);
        title = esc(it.preview) + (c ? `<span class="swatch" style="background:${esc(c)}"></span>` : "");
      }
      const sub =
        it.type === "image"
          ? `${esc(it.preview)} · ${(it.size / 1024).toFixed(0)}KB`
          : it.type === "files"
            ? `${it.size} 个文件`
            : it.sourceApp
              ? esc(it.sourceApp)
              : `${it.size} 字符`;
      const icon = thumb || `<span class="ic" data-icon="${esc(it.sourceAppPath || "")}">${typeGlyph(it.type)}</span>`;
      return `<div class="row ${i === selected ? "sel" : ""}" data-i="${i}">
        <span class="idx">${num}</span>
        ${icon}
        <div class="mid"><div class="ttl">${title}</div><div class="sub">${sub}</div></div>
        <span class="star ${it.favorite ? "on" : ""}">★</span>
      </div>`;
    })
    .join("");
  // 异步补图标与缩略图
  fillThumbs();
}

async function fillThumbs(): Promise<void> {
  for (const el of Array.from(listEl.querySelectorAll<HTMLImageElement>("img[data-thumb]"))) {
    const id = Number(el.dataset.thumb);
    const url = await api.readImageDataUrl(id);
    if (url) el.src = url;
  }
  for (const el of Array.from(listEl.querySelectorAll<HTMLElement>(".ic[data-icon]"))) {
    const p = el.dataset.icon || "";
    if (!p) continue;
    let url = iconCache.get(p);
    if (url === undefined) {
      const fetched = await api.getAppIcon(p);
      iconCache.set(p, fetched);
      url = fetched;
    }
    if (url) el.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover" alt="" />`;
  }
}

async function renderPreview(): Promise<void> {
  const it = items[selected];
  if (!it) {
    previewEl.innerHTML = `<div class="empty">选择一个条目查看</div>`;
    return;
  }
  const metaIcon = it.sourceAppPath ? (iconCache.get(it.sourceAppPath) ?? "") : "";
  const meta = `<div class="pv-meta">${metaIcon ? `<img src="${metaIcon}" alt="" />` : ""}<span>${esc(it.sourceApp || "未知来源")}</span><span>·</span><span>${it.type === "text" ? it.size + " 字符" : it.type === "image" ? it.preview : it.size + " 个文件"}</span><span>·</span><span>${timeStr(it.lastUsedAt)}</span></div>`;

  if (it.type === "text") {
    const c = colorOf(it.content);
    const colorBlock = c ? `<div style="margin-bottom:10px;"><div style="width:100%;height:52px;border-radius:8px;border:1px solid var(--border);background:${esc(c)}"></div><div class="kv"><b>${esc(c)}</b></div></div>` : "";
    previewEl.innerHTML = `<div class="pv-body">${colorBlock}<div class="pv-text">${esc(it.content)}</div></div>${meta}`;
  } else if (it.type === "image") {
    const url = await api.readImageDataUrl(it.id);
    previewEl.innerHTML = `<div class="pv-body">
      ${url ? `<img class="pv-img" src="${url}" alt="" />` : ""}
      <div class="kv"><b>${esc(fileName(it))}</b></div>
      <div class="kv">尺寸：${esc(it.preview)}</div>
      <div class="kv">大小：${(it.size / 1024).toFixed(1)} KB</div>
      ${it.sourcePath ? `<div class="kv">位置：${esc(it.sourcePath)}</div>` : ""}
    </div>${meta}`;
  } else {
    let paths: string[] = [];
    try {
      paths = JSON.parse(it.content);
    } catch {
      paths = [it.content];
    }
    previewEl.innerHTML = `<div class="pv-body" id="pv-files"></div>${meta}`;
    const box = document.getElementById("pv-files")!;
    box.innerHTML = paths
      .map((p, i) => `<div class="fileline"><b>${esc(p.split("/").pop() || p)}</b><div class="p">${esc(p)}</div>${/\.(png|jpe?g|gif|bmp|webp)$/i.test(p) ? `<img class="pv-img" data-fthumb="${i}" style="max-height:150px;margin-top:5px" alt="" />` : ""}</div>`)
      .join("");
    for (const el of Array.from(box.querySelectorAll<HTMLImageElement>("img[data-fthumb]"))) {
      const url = await api.readPathThumbnail(paths[Number(el.dataset.fthumb)]);
      if (url) el.src = url;
      else el.remove();
    }
  }
}

function select(i: number): void {
  if (!items.length) return;
  selected = Math.max(0, Math.min(items.length - 1, i));
  Array.from(listEl.querySelectorAll<HTMLElement>(".row")).forEach((el, idx) => el.classList.toggle("sel", idx === selected));
  const sel = listEl.querySelector<HTMLElement>(".row.sel");
  sel?.scrollIntoView({ block: "nearest" });
  renderPreview();
}

async function doPaste(it: ClipItem | undefined): Promise<void> {
  if (!it) return;
  await api.paste(it.id); // 主进程会隐藏面板并尝试模拟粘贴；失败则仅复制
}

// ── 事件 ──
qEl.addEventListener("input", () => {
  keyword = qEl.value;
  selected = 0;
  refresh();
});

tabsEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>(".tab");
  if (!btn) return;
  category = btn.dataset.cat as Category;
  Array.from(tabsEl.querySelectorAll(".tab")).forEach((t) => t.classList.toggle("on", t === btn));
  selected = 0;
  refresh();
});

listEl.addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".row");
  if (row) select(Number(row.dataset.i));
});
listEl.addEventListener("dblclick", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".row");
  if (row) doPaste(items[Number(row.dataset.i)]);
});
listEl.addEventListener("contextmenu", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".row");
  if (!row) return;
  e.preventDefault();
  select(Number(row.dataset.i));
  openMenu(e.clientX, e.clientY, items[selected]);
});

function closeMenu(): void {
  document.querySelector(".menu")?.remove();
}
function openMenu(x: number, y: number, it: ClipItem): void {
  closeMenu();
  const m = document.createElement("div");
  m.className = "menu";
  m.style.left = Math.min(x, window.innerWidth - 150) + "px";
  m.style.top = Math.min(y, window.innerHeight - 120) + "px";
  m.innerHTML = `<button data-a="copy">复制</button><button data-a="fav">${it.favorite ? "取消收藏" : "收藏"}</button><button class="del" data-a="del">删除</button>`;
  m.addEventListener("click", async (e) => {
    const a = (e.target as HTMLElement).dataset.a;
    closeMenu();
    if (a === "copy") await api.copy(it.id);
    else if (a === "fav") {
      try {
        await api.setFavorite(it.id, !it.favorite);
      } catch (err) {
        alert((err as Error)?.message || "操作失败");
      }
    } else if (a === "del") await api.remove(it.id);
  });
  document.body.appendChild(m);
}
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".menu")) closeMenu();
});

// 键盘：document 级，避免焦点在列表/空白处失效。
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    select(selected + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    select(selected - 1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    doPaste(items[selected]);
  } else if (e.key === "Escape") {
    api.hidePanel();
  } else if (/^[1-9]$/.test(e.key) && keyword === "") {
    // 搜索框为空时数字快选
    e.preventDefault();
    const idx = Number(e.key) - 1;
    if (items[idx]) doPaste(items[idx]);
  }
});

// 历史变更 → 保持当前选中项刷新。
api.onHistoryChanged(() => {
  const id = items[selected]?.id;
  refresh(id);
});
// 面板弹出 → 重置搜索/分类、聚焦搜索、刷新。
api.onPanelShown(() => {
  keyword = "";
  qEl.value = "";
  category = "all";
  Array.from(tabsEl.querySelectorAll(".tab")).forEach((t) => t.classList.toggle("on", (t as HTMLElement).dataset.cat === "all"));
  selected = 0;
  refresh().then(() => qEl.focus());
});

refresh();
