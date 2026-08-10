// 快捷入口浮层搜索窗（React）。搜索框 + 结果列表 + 键盘导航。自带 CSS（透明浮层窗）。
import { useCallback, useEffect, useRef, useState } from "react";

interface LauncherResult {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;      // data URL / emoji
  source: string;
  score: number;
  mods?: string[];    // 工作流结果的修饰键分支（如 ["cmd"]）
  autocomplete?: string;  // Tab 补全时写回输入框的完整查询词
  quicklook?: string;     // ⌘Y 预览的 URL 或文件路径
  wrap?: boolean;         // 这一行完整显示、允许换行（报错行）
}
interface LauncherAPI {
  query(q: string): Promise<LauncherResult[]>;
  run(id: string, mod?: string): Promise<string>;
  sendAssistant(text: string): Promise<string>;
  hide(): Promise<void>;
  resize(h: number): Promise<void>;
  onShown(cb: (prefill: { q: string; caret?: "left" | "right" } | null) => void): () => void;
  quicklook(target: string): Promise<void>;
  onResults(cb: (payload: { q: string; results: LauncherResult[] }) => void): () => void;
}
const api = (window as unknown as { umbraLauncher: LauncherAPI }).umbraLauncher;

const CSS = `
:root{--bg:rgba(246,245,242,.98);--card:#FFF;--border:#E6E3DC;--text:#1F2320;--muted:#6B716B;--orange:#E8590C;--sel:#FFF1E6;}
*{box-sizing:border-box;}
html,body{margin:0;height:100%;background:transparent;font-family:-apple-system,"SF Pro Text",system-ui,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;color:var(--text);}
.wrap{height:100vh;padding:10px;}
.box{position:relative;background:var(--bg);border:1px solid var(--border);border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.28);overflow:hidden;display:flex;flex-direction:column;}
.search{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border);-webkit-app-region:drag;}
.search .q,.search .hint{-webkit-app-region:no-drag;}
.search .q{flex:1;border:none;outline:none;background:transparent;font-size:22px;color:var(--text);}
.toast{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);background:var(--orange);color:#fff;font-size:12.5px;padding:6px 14px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.25);}
.search .q::placeholder{color:var(--muted);}
.hint{color:var(--muted);font-size:12px;white-space:nowrap;}
.list{overflow-y:auto;padding:6px;max-height:520px;}
.list:empty{display:none;}
.row{display:flex;align-items:center;gap:12px;padding:9px 12px;border-radius:10px;cursor:pointer;}
.row.sel{background:var(--sel);}
.ico{width:30px;height:30px;flex:none;display:flex;align-items:center;justify-content:center;font-size:20px;border-radius:7px;overflow:hidden;background:#0000000a;}
.ico img{width:30px;height:30px;object-fit:contain;}
.meta{flex:1;min-width:0;}
.title{font-size:14.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sub{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;}
/* 报错行完整显示。报错的价值全在细节里（哪个文件、哪一行），
   省略号一截等于什么都没说；而正常结果保持单行，列表才扫得快。
   word-break:break-all 是给长路径用的 —— 不加的话一整条绝对路径会顶破宽度。 */
.row.wrap{align-items:flex-start;}
.row.wrap .title,.row.wrap .sub{white-space:pre-wrap;overflow:visible;text-overflow:clip;word-break:break-all;line-height:1.5;}
.row.wrap .ico,.row.wrap .num{margin-top:2px;}
.num{color:var(--muted);font-size:11px;border:1px solid var(--border);border-radius:5px;padding:1px 6px;}
.empty{color:var(--muted);text-align:center;padding:26px 10px;font-size:13px;}
@media (prefers-color-scheme:dark){:root{--bg:rgba(30,27,24,.98);--card:#26221E;--border:#3A342E;--text:#F2EFEA;--muted:#A79E93;--sel:#3a2a1c;}.ico{background:#ffffff10;}}
`;

export function Launcher() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<LauncherResult[]>([]);
  const [sel, setSel] = useState(0);
  const [toast, setToast] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  // 鼠标悬停接管选中项 —— 但必须是「指针真的动了」才算。
  //
  // 有两种情况浏览器会派发 mousemove 而指针一动没动：面板刚弹出来（列表出现在光标底下）、
  // 按方向键时 scrollIntoView 让行滑过光标。这两种都不该改选中项：
  // 前者会让「默认选中第一个」当场失效（光标正好压在第三行，高亮就跑到第三行），
  // 后者会把键盘刚选好的那一项抢回鼠标那儿。
  //
  // 做法：记住上一次的指针坐标。每次结果变化就把基准清掉，之后**第一个** mousemove
  // 只用来记坐标、不改选中；再来的 mousemove 坐标真变了才接管。
  // 清基准放在 setResults 之前（而不是 results 的 useEffect 里）—— useEffect 在绘制之后跑，
  // 而那个假 mousemove 是布局一变就派发的，顺序赌不起。
  const ptr = useRef<{ x: number; y: number } | null>(null);
  const hover = (i: number, e: React.MouseEvent) => {
    const prev = ptr.current;
    ptr.current = { x: e.clientX, y: e.clientY };
    if (!prev || (prev.x === e.clientX && prev.y === e.clientY)) return;
    setSel(i);
  };

  // 唤起时：清空、聚焦。
  useEffect(() => {
    const off = api.onShown((prefill) => {
      ptr.current = null;
      setResults([]); setSel(0);
      // Hotkey 的「打开快捷入口」会带一段预填内容（下游节点的关键词 + 参数）。
      // 普通唤起 prefill 是 null，照旧清空。
      const q0 = prefill?.q || "";
      setQ(q0);
      setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        // 光标位置：caret="left" 停在最前面（关键词在后、内容在前的写法要用它），
        // 否则停在末尾，直接接着打就行 —— 这才是「按下快捷键就能开始输入」的手感。
        const at = prefill?.caret === "left" ? 0 : q0.length;
        try { el.setSelectionRange(at, at); } catch { /* 老环境不支持就算了 */ }
      }, 30);
    });
    setTimeout(() => inputRef.current?.focus(), 30);
    return off;
  }, []);

  // 防抖查询。
  //
  // **带序号防乱序**：Script Filter 会起真进程，一次查询几百毫秒到几秒不等，
  // 快慢完全取决于脚本。慢的那一次要是后回来，就会把新词的结果盖掉 ——
  // 表现是「打完字之后列表跳回上一个词的结果」，甚至闪一条早就过期的报错。
  // 只认最后一次发出的那个请求。
  const qSeq = useRef(0);
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const mine = ++qSeq.current;
      const r = await api.query(q);
      if (qSeq.current !== mine) return;   // 已经有更新的查询发出去了，这一份作废
      ptr.current = null;
      setResults(r);
      setSel(0);
    }, 120);
    return () => window.clearTimeout(timer.current);
  }, [q]);

  // Script Filter 的 rerun（W3）：主进程到点自动重查后推新结果过来。
  // 只有查询词还是当前这个才替换列表，避免用户已经改词了还被旧词的结果覆盖；
  // 选中项不重置，免得列表刷新时把用户的光标顶回第一行。
  useEffect(() => {
    return api.onResults((p) => {
      if (p.q !== q.trim()) return;
      ptr.current = null;
      setResults(p.results);
    });
  }, [q]);

  // 选中项滚动到可见。
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(".row.sel");
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // 窗口贴合内容高度：搜索框 + 列表内容（+ 内边距），消除空白/暗框。
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const sh = searchRef.current?.offsetHeight ?? 58;
      const lh = results.length ? (listRef.current?.scrollHeight ?? 0) : 0;
      void api.resize(Math.ceil(sh + lh + 22)); // 22 = wrap 上下 padding(20) + 边框(2)
    });
    return () => cancelAnimationFrame(id);
  }, [results]);

  const runAt = useCallback(async (i: number, mod = "") => {
    const r = results[i];
    if (!r) return;
    const msg = await api.run(r.id, mod);
    // 有提示文案（复制/脚本等静默动作）→ 弹 toast 反馈后再关闭；否则窗口已由主进程隐藏。
    if (msg) { setToast(msg); setTimeout(() => { setToast(""); void api.hide(); }, 850); }
  }, [results]);

  const onKey = (e: React.KeyboardEvent) => {
    // 输入法组词中（拼音待选未确认）：回车/方向键只用于确认候选，不触发执行/导航。
    if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, Math.max(0, results.length - 1))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey) {
        // ⌘↵：若选中的是带 cmd 分支的工作流结果 → 走该分支；否则把输入文字发给秘书。
        const r = results[sel];
        if (r?.mods?.includes("cmd")) void runAt(sel, "cmd");
        else if (q.trim()) { void api.sendAssistant(q.trim()); void api.hide(); }
      } else if (e.altKey) {
        const r = results[sel];
        if (r?.mods?.includes("alt")) void runAt(sel, "alt");  // ⌥↵：工作流 alt 分支
      } else {
        void runAt(sel);  // ↵：执行选中结果的主动作
      }
    }
    else if (e.key === "Tab") {
      // Tab 补全（W3 的 autocomplete）：把选中项声明的查询词写回输入框，接着往下钻。
      e.preventDefault();
      const r = results[sel];
      if (r?.autocomplete) setQ(r.autocomplete);
    }
    else if (e.metaKey && e.key.toLowerCase() === "y") {
      // ⌘Y 预览（W3 的 quicklookurl）：交给系统默认程序打开，面板保持展开。
      e.preventDefault();
      const r = results[sel];
      if (r?.quicklook) void api.quicklook(r.quicklook);
    }
    else if (e.key === "Escape") { e.preventDefault(); void api.hide(); }
    else if (e.metaKey && e.key >= "1" && e.key <= "9") { e.preventDefault(); void runAt(Number(e.key) - 1); }
  };

  return (
    <div className="wrap">
      <style>{CSS}</style>
      <div className="box">
        <div className="search" ref={searchRef}>
          <span style={{ fontSize: 20 }}>🔍</span>
          <input
            ref={inputRef}
            className="q"
            value={q}
            placeholder="搜索应用、文件夹、常用语…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            autoFocus
          />
          {/* 提示只在选中项真支持时才显示 Tab/⌘Y，避免一行塞满用不上的快捷键。 */}
          <span className="hint">
            {results[sel]?.autocomplete ? "⇥ 补全 · " : ""}
            {results[sel]?.quicklook ? "⌘Y 预览 · " : ""}
            ↵ 打开 · ⌘↵ 发给秘书 · esc 关闭
          </span>
        </div>
        {results.length ? (
          <div className="list" ref={listRef}>
            {results.map((r, i) => (
              <div key={r.id} className={`row ${i === sel ? "sel" : ""} ${r.wrap ? "wrap" : ""}`} onMouseMove={(e) => hover(i, e)} onClick={() => runAt(i)}>
                <span className="ico">
                  {r.icon && r.icon.startsWith("data:") ? <img src={r.icon} alt="" /> : <span>{r.icon || "•"}</span>}
                </span>
                <div className="meta">
                  <div className="title">{r.title}</div>
                  {r.subtitle ? <div className="sub">{r.subtitle}</div> : null}
                </div>
                {i < 9 ? <span className="num">⌘{i + 1}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
        {toast ? <div className="toast">{toast}</div> : null}
      </div>
    </div>
  );
}
