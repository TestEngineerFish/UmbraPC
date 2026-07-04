// 剪贴板历史面板（React）。复用原有 CSS 类，逻辑与 vanilla 版一致。
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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
const api = (window as unknown as { umbraClip: ClipAPI }).umbraClip;

const CSS = `
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

const CATS: Category[] = ["all", "text", "image", "files", "favorite"];

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
function fileName(it: ClipItem, imageLabel: string): string {
  if (it.sourcePath) return it.sourcePath.split("/").pop() || it.sourcePath;
  return `${imageLabel}: ${it.preview}`;
}
const typeGlyph = (t: ClipType) => (t === "image" ? "🖼" : t === "files" ? "📄" : "✎");

export function Panel() {
  const { t } = useTranslation();
  const [items, setItems] = useState<ClipItem[]>([]);
  const [category, setCategory] = useState<Category>("all");
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; item: ClipItem } | null>(null);
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map());
  const [icons, setIcons] = useState<Map<string, string>>(new Map());

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const st = useRef({ items, category, keyword, selected });
  st.current = { items, category, keyword, selected };

  const load = useCallback(async (preserveId?: number) => {
    const s = st.current;
    const list = await api.list(s.category, s.keyword);
    setItems(list);
    setSelected((prev) => {
      if (preserveId != null) {
        const i = list.findIndex((x) => x.id === preserveId);
        return i >= 0 ? i : 0;
      }
      return prev >= list.length ? Math.max(0, list.length - 1) : prev;
    });
  }, []);

  // 初始 + 分类/搜索变化 → 重新拉取
  useEffect(() => {
    load();
  }, [category, keyword, load]);

  // 异步补缩略图（图像行）与来源应用图标
  useEffect(() => {
    let alive = true;
    (async () => {
      const th = new Map(thumbs);
      for (const it of items) if (it.type === "image" && !th.has(it.id)) th.set(it.id, await api.readImageDataUrl(it.id));
      if (alive) setThumbs(th);
      const ic = new Map(icons);
      for (const it of items) {
        const p = it.sourceAppPath;
        if (p && !ic.has(p)) ic.set(p, await api.getAppIcon(p));
      }
      if (alive) setIcons(ic);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // 选中项滚入视区
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".row.sel")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const paste = useCallback((it?: ClipItem) => {
    if (it) api.paste(it.id);
  }, []);

  // 键盘（document 级）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = st.current;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((p) => Math.min(s.items.length - 1, p + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((p) => Math.max(0, p - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        paste(s.items[s.selected]);
      } else if (e.key === "Escape") {
        api.hidePanel();
      } else if (/^[1-9]$/.test(e.key) && s.keyword === "") {
        e.preventDefault();
        const it = s.items[Number(e.key) - 1];
        if (it) paste(it);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paste]);

  // 历史变更 / 面板弹出
  useEffect(() => {
    const off1 = api.onHistoryChanged(() => load(st.current.items[st.current.selected]?.id));
    const off2 = api.onPanelShown(() => {
      setKeyword("");
      setCategory("all");
      setSelected(0);
      setTimeout(() => searchRef.current?.focus(), 0);
    });
    return () => {
      off1();
      off2();
    };
  }, [load]);

  // 关闭右键菜单
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menu]);

  return (
    <>
      <style>{CSS}</style>
      <div className="wrap">
        <div className="search">
          <input ref={searchRef} type="text" placeholder={t("clipboard.searchPh")} spellCheck={false} value={keyword} onChange={(e) => { setKeyword(e.target.value); setSelected(0); }} />
        </div>
        <div className="tabs">
          {CATS.map((c) => (
            <button key={c} className={`tab ${category === c ? "on" : ""}`} onClick={() => { setCategory(c); setSelected(0); }}>
              {t(`clipboard.${c}`)}
            </button>
          ))}
        </div>
        <div className="body">
          <div className="list" ref={listRef}>
            {items.length ? (
              items.map((it, i) => (
                <Row
                  key={it.id}
                  it={it}
                  index={keyword === "" && i < 9 ? i + 1 : ""}
                  sel={i === selected}
                  thumb={thumbs.get(it.id)}
                  icon={it.sourceAppPath ? icons.get(it.sourceAppPath) : undefined}
                  imageLabel={t("clipboard.image")}
                  onClick={() => setSelected(i)}
                  onDouble={() => paste(it)}
                  onMenu={(x, y) => { setSelected(i); setMenu({ x, y, item: it }); }}
                />
              ))
            ) : (
              <div className="empty">{t("clipboard.empty")}</div>
            )}
          </div>
          <div className="preview">
            <Preview item={items[selected]} appIcon={items[selected]?.sourceAppPath ? icons.get(items[selected]!.sourceAppPath!) : undefined} />
          </div>
        </div>
        <div className="hint">{t("clipboard.hint")}</div>
      </div>
      {menu ? <Menu menu={menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

function Row({ it, index, sel, thumb, icon, imageLabel, onClick, onDouble, onMenu }: { it: ClipItem; index: number | string; sel: boolean; thumb?: string; icon?: string; imageLabel: string; onClick: () => void; onDouble: () => void; onMenu: (x: number, y: number) => void }) {
  const { t } = useTranslation();
  let title: React.ReactNode;
  if (it.type === "image") {
    title = fileName(it, imageLabel);
  } else if (it.type === "files") {
    let names = it.preview;
    try {
      names = (JSON.parse(it.content) as string[]).map((p) => p.split("/").pop()).join(", ");
    } catch {
      /* preview */
    }
    title = names;
  } else {
    const c = colorOf(it.content);
    title = (
      <>
        {it.preview}
        {c ? <span className="swatch" style={{ background: c }} /> : null}
      </>
    );
  }
  const sub = it.type === "image" ? `${it.preview} · ${(it.size / 1024).toFixed(0)}KB` : it.type === "files" ? t("clipboard.fileCount", { count: it.size }) : it.sourceApp || t("clipboard.charCount", { count: it.size });
  return (
    <div className={`row ${sel ? "sel" : ""}`} onClick={onClick} onDoubleClick={onDouble} onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}>
      <span className="idx">{index}</span>
      {it.type === "image" ? (
        <img className="thumb" src={thumb || undefined} alt="" />
      ) : (
        <span className="ic">{icon ? <img src={icon} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt="" /> : typeGlyph(it.type)}</span>
      )}
      <div className="mid">
        <div className="ttl">{title}</div>
        <div className="sub">{sub}</div>
      </div>
      <span className={`star ${it.favorite ? "on" : ""}`}>★</span>
    </div>
  );
}

function Preview({ item, appIcon }: { item?: ClipItem; appIcon?: string }) {
  const { t } = useTranslation();
  const [imgUrl, setImgUrl] = useState("");
  const [fileThumbs, setFileThumbs] = useState<Record<number, string>>({});
  useEffect(() => {
    setImgUrl("");
    setFileThumbs({});
    if (!item) return;
    let alive = true;
    if (item.type === "image") api.readImageDataUrl(item.id).then((u) => alive && setImgUrl(u));
    else if (item.type === "files") {
      let paths: string[] = [];
      try {
        paths = JSON.parse(item.content);
      } catch {
        paths = [item.content];
      }
      paths.forEach((p, i) => {
        if (/\.(png|jpe?g|gif|bmp|webp)$/i.test(p)) api.readPathThumbnail(p).then((u) => alive && u && setFileThumbs((m) => ({ ...m, [i]: u })));
      });
    }
    return () => {
      alive = false;
    };
  }, [item]);

  if (!item) return <div className="empty">{t("clipboard.selectHint")}</div>;
  const meta = (
    <div className="pv-meta">
      {appIcon ? <img src={appIcon} alt="" /> : null}
      <span>{item.sourceApp || t("common.none")}</span>
      <span>·</span>
      <span>{item.type === "text" ? t("clipboard.charCount", { count: item.size }) : item.type === "image" ? item.preview : t("clipboard.fileCount", { count: item.size })}</span>
      <span>·</span>
      <span>{timeStr(item.lastUsedAt)}</span>
    </div>
  );

  if (item.type === "text") {
    const c = colorOf(item.content);
    return (
      <>
        <div className="pv-body">
          {c ? (
            <div style={{ marginBottom: 10 }}>
              <div style={{ width: "100%", height: 52, borderRadius: 8, border: "1px solid var(--border)", background: c }} />
              <div className="kv">
                <b>{c}</b>
              </div>
            </div>
          ) : null}
          <div className="pv-text">{item.content}</div>
        </div>
        {meta}
      </>
    );
  }
  if (item.type === "image") {
    return (
      <>
        <div className="pv-body">
          {imgUrl ? <img className="pv-img" src={imgUrl} alt="" /> : null}
          <div className="kv"><b>{fileName(item, t("clipboard.image"))}</b></div>
          <div className="kv">{t("clipboard.size")}：{item.preview}</div>
          <div className="kv">{t("clipboard.size")}：{(item.size / 1024).toFixed(1)} KB</div>
          {item.sourcePath ? <div className="kv">{t("clipboard.path")}：{item.sourcePath}</div> : null}
        </div>
        {meta}
      </>
    );
  }
  let paths: string[] = [];
  try {
    paths = JSON.parse(item.content);
  } catch {
    paths = [item.content];
  }
  return (
    <>
      <div className="pv-body">
        {paths.map((p, i) => (
          <div className="fileline" key={i}>
            <b>{p.split("/").pop() || p}</b>
            <div className="p">{p}</div>
            {fileThumbs[i] ? <img className="pv-img" src={fileThumbs[i]} style={{ maxHeight: 150, marginTop: 5 }} alt="" /> : null}
          </div>
        ))}
      </div>
      {meta}
    </>
  );
}

function Menu({ menu, onClose }: { menu: { x: number; y: number; item: ClipItem }; onClose: () => void }) {
  const { t } = useTranslation();
  const it = menu.item;
  const act = async (a: string) => {
    onClose();
    if (a === "copy") await api.copy(it.id);
    else if (a === "fav") {
      try {
        await api.setFavorite(it.id, !it.favorite);
      } catch (err) {
        alert((err as Error)?.message || t("clipboard.opFailed"));
      }
    } else if (a === "del") await api.remove(it.id);
  };
  return (
    <div className="menu" style={{ left: Math.min(menu.x, window.innerWidth - 150), top: Math.min(menu.y, window.innerHeight - 120) }} onClick={(e) => e.stopPropagation()}>
      <button onClick={() => act("copy")}>{t("clipboard.copy")}</button>
      <button onClick={() => act("fav")}>{it.favorite ? t("clipboard.unfavorite") : t("clipboard.favoriteItem")}</button>
      <button className="del" onClick={() => act("del")}>{t("clipboard.remove")}</button>
    </div>
  );
}

