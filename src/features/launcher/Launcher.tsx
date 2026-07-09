// 快捷入口浮层搜索窗（React）。搜索框 + 结果列表 + 键盘导航。自带 CSS（透明浮层窗）。
import { useCallback, useEffect, useRef, useState } from "react";

interface LauncherResult {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;      // data URL / emoji
  source: string;
  score: number;
}
interface LauncherAPI {
  query(q: string): Promise<LauncherResult[]>;
  run(id: string): Promise<string>;
  sendAssistant(text: string): Promise<string>;
  hide(): Promise<void>;
  resize(h: number): Promise<void>;
  onShown(cb: () => void): () => void;
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

  // 唤起时：清空、聚焦。
  useEffect(() => {
    const off = api.onShown(() => {
      setQ(""); setResults([]); setSel(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    });
    setTimeout(() => inputRef.current?.focus(), 30);
    return off;
  }, []);

  // 防抖查询。
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const r = await api.query(q);
      setResults(r);
      setSel(0);
    }, 120);
    return () => window.clearTimeout(timer.current);
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

  const runAt = useCallback(async (i: number) => {
    const r = results[i];
    if (!r) return;
    const msg = await api.run(r.id);
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
        // ⌘↵：把输入框里的文字直接发给秘书（跳聊天页），不依赖搜索结果。
        if (q.trim()) { void api.sendAssistant(q.trim()); void api.hide(); }
      } else {
        void runAt(sel);  // ↵：执行选中结果的主动作
      }
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
            placeholder="搜索应用、文件夹、剪贴板…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            autoFocus
          />
          <span className="hint">↵ 打开 · ⌘↵ 发给秘书 · esc 关闭</span>
        </div>
        {results.length ? (
          <div className="list" ref={listRef}>
            {results.map((r, i) => (
              <div key={r.id} className={`row ${i === sel ? "sel" : ""}`} onMouseMove={() => setSel(i)} onClick={() => runAt(i)}>
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
