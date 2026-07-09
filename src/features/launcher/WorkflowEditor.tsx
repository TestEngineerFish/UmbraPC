// 工作流可视化编辑器（类 Alfred Workflow）。全屏浮层：左工作流列表 / 中可拖拽画布 / 右节点面板。
// 画布：节点可拖动摆位、从输出端口拉线连接、连线徽章切换修饰键分支、双击节点配置。
import { useCallback, useEffect, useRef, useState } from "react";

export interface WFNode { id: string; type: string; x: number; y: number; config: Record<string, unknown> }
export interface WFConn { from: string; to: string; mod?: string }
export interface WF { id: string; name: string; icon?: string; enabled: boolean; variables?: Record<string, string>; nodes: WFNode[]; connections: WFConn[] }

interface LauncherAPI { getWorkflows(): Promise<WF[]>; setWorkflows(w: WF[]): Promise<void> }
const api = (window as unknown as { umbraLauncher: LauncherAPI }).umbraLauncher;

const NODE_W = 168;
const PORT_Y = 26;               // 端口/连线锚点相对节点顶部的 y
const MODS = ["", "cmd", "alt", "ctrl", "shift"]; // 徽章循环切换的修饰键
const MOD_LABEL: Record<string, string> = { "": "↵", cmd: "⌘↵", alt: "⌥↵", ctrl: "⌃↵", shift: "⇧↵" };

// 节点目录（右侧面板 + 默认配置）。
const CATALOG: { cat: string; items: { type: string; label: string; emoji: string }[] }[] = [
  { cat: "触发 Triggers", items: [
    { type: "trigger.keyword", label: "Keyword", emoji: "⌨️" },
    { type: "trigger.hotkey", label: "Hotkey", emoji: "⌘" },
  ] },
  { cat: "输入 Inputs", items: [
    { type: "input.scriptfilter", label: "Script Filter", emoji: "🔎" },
  ] },
  { cat: "动作 Actions", items: [
    { type: "action.script", label: "Run Script", emoji: "📜" },
    { type: "action.copy", label: "复制到剪贴板", emoji: "📋" },
    { type: "action.paste", label: "粘贴到前台", emoji: "📥" },
    { type: "action.openurl", label: "打开网址", emoji: "🔗" },
    { type: "action.openfile", label: "打开文件", emoji: "📂" },
    { type: "action.assistant", label: "发给秘书", emoji: "💬" },
    { type: "action.inspiration", label: "记为灵感", emoji: "💡" },
  ] },
  { cat: "输出 Outputs", items: [
    { type: "output.notify", label: "系统通知", emoji: "🔔" },
    { type: "output.largetype", label: "大字显示", emoji: "🅰️" },
  ] },
];
const TYPE_META: Record<string, { label: string; emoji: string; kind: string }> = {};
for (const g of CATALOG) for (const it of g.items) TYPE_META[it.type] = { label: it.label, emoji: it.emoji, kind: it.type.split(".")[0] };

const KIND_ACCENT: Record<string, string> = {
  trigger: "#8E44AD", input: "#2980B9", action: "#27AE60", output: "#E8590C",
};

function defaultConfig(type: string): Record<string, unknown> {
  switch (type) {
    case "trigger.keyword": return { keyword: "kw", arg: "optional", title: "" };
    case "trigger.hotkey": return { accelerator: "" };
    case "input.scriptfilter": return { script: "", cwd: "", alfredFilters: false };
    case "action.script": return { script: "", cwd: "", output: "none" };
    case "action.openurl": return { url: "{query}" };
    case "action.openfile": return { path: "{query}", app: "" };
    default: return {};
  }
}
const uid = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function WorkflowEditor({ onClose }: { onClose: () => void }) {
  const [wfs, setWfs] = useState<WF[]>([]);
  const [curId, setCurId] = useState<string>("");
  const [editNode, setEditNode] = useState<string | null>(null); // 配置弹窗的节点 id
  const [showVars, setShowVars] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => { void api.getWorkflows().then((w) => { setWfs(w); setCurId(w[0]?.id || ""); }); }, []);

  const cur = wfs.find((w) => w.id === curId);

  // 持久化：save=true 时落库（拖拽过程中只更新本地，mouseup 再落库）。
  const persist = useCallback((next: WF[], save = true) => {
    setWfs(next);
    if (save) void api.setWorkflows(next);
  }, []);
  const updateCur = useCallback((fn: (w: WF) => WF, save = true) => {
    setWfs((prev) => {
      const next = prev.map((w) => (w.id === curId ? fn(w) : w));
      if (save) void api.setWorkflows(next);
      return next;
    });
  }, [curId]);

  // ── 工作流增删改 ──
  const newWf = () => {
    const id = uid();
    const wf: WF = {
      id, name: "新工作流", icon: "🧩", enabled: true, variables: {},
      nodes: [{ id: "n1", type: "trigger.keyword", x: 60, y: 120, config: defaultConfig("trigger.keyword") }],
      connections: [],
    };
    persist([...wfs, wf]);
    setCurId(id);
  };
  const delWf = (id: string) => {
    const next = wfs.filter((w) => w.id !== id);
    persist(next);
    if (curId === id) setCurId(next[0]?.id || "");
  };

  // ── 节点增删改 ──
  const addNode = (type: string) => {
    if (!cur) return;
    const n: WFNode = { id: uid(), type, x: 260 + (cur.nodes.length % 3) * 30, y: 120 + (cur.nodes.length % 5) * 24, config: defaultConfig(type) };
    updateCur((w) => ({ ...w, nodes: [...w.nodes, n] }));
  };
  const delNode = (id: string) => updateCur((w) => ({
    ...w, nodes: w.nodes.filter((n) => n.id !== id),
    connections: w.connections.filter((c) => c.from !== id && c.to !== id),
  }));
  const setNodeConfig = (id: string, config: Record<string, unknown>) =>
    updateCur((w) => ({ ...w, nodes: w.nodes.map((n) => (n.id === id ? { ...n, config } : n)) }));

  // ── 拖动节点（header 拖拽）──
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const onNodeDown = (e: React.MouseEvent, n: WFNode) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = { id: n.id, dx: e.clientX - rect.left - n.x, dy: e.clientY - rect.top - n.y };
    e.preventDefault();
  };

  // ── 连线（端口拉线）──
  const link = useRef<{ from: string } | null>(null);
  const [linkPos, setLinkPos] = useState<{ x: number; y: number } | null>(null);
  const onPortDown = (e: React.MouseEvent, n: WFNode) => {
    link.current = { from: n.id };
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) setLinkPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    e.stopPropagation(); e.preventDefault();
  };
  const onNodeUp = (n: WFNode) => {
    if (link.current && link.current.from !== n.id) {
      const from = link.current.from;
      updateCur((w) => (
        w.connections.some((c) => c.from === from && c.to === n.id && (c.mod || "") === "")
          ? w
          : { ...w, connections: [...w.connections, { from, to: n.id, mod: "" }] }
      ));
    }
    link.current = null; setLinkPos(null);
  };

  // 全局 mousemove / mouseup：处理拖动与连线。
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (drag.current) {
        const d = drag.current;
        const x = Math.max(0, e.clientX - rect.left - d.dx);
        const y = Math.max(0, e.clientY - rect.top - d.dy);
        setWfs((prev) => prev.map((w) => (w.id === curId ? { ...w, nodes: w.nodes.map((n) => (n.id === d.id ? { ...n, x, y } : n)) } : w)));
      } else if (link.current) {
        setLinkPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }
    };
    const up = () => {
      if (drag.current) { drag.current = null; setWfs((prev) => { void api.setWorkflows(prev); return prev; }); } // 拖动结束落库
      if (link.current) { link.current = null; setLinkPos(null); }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [curId]);

  // 连线徽章：点击循环修饰键；右键删除。
  const cycleMod = (i: number) => updateCur((w) => {
    const conns = w.connections.slice();
    const cur = conns[i].mod || "";
    conns[i] = { ...conns[i], mod: MODS[(MODS.indexOf(cur) + 1) % MODS.length] as WFConn["mod"] };
    return { ...w, connections: conns };
  });
  const delConn = (i: number) => updateCur((w) => ({ ...w, connections: w.connections.filter((_, j) => j !== i) }));

  const node = (id: string) => cur?.nodes.find((n) => n.id === id);
  const anchor = (n: WFNode, side: "in" | "out") => ({ x: n.x + (side === "out" ? NODE_W : 0), y: n.y + PORT_Y });

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg/95 backdrop-blur-sm">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-card">
        <span className="text-[15px] font-semibold">工作流编排</span>
        {cur ? (
          <>
            <input value={cur.icon || ""} onChange={(e) => updateCur((w) => ({ ...w, icon: e.target.value }))}
              className="w-[38px] text-center bg-bg border border-border rounded-lg py-[5px] text-[15px]" maxLength={2} />
            <input value={cur.name} onChange={(e) => updateCur((w) => ({ ...w, name: e.target.value }))}
              className="w-[180px] bg-bg border border-border rounded-lg px-[10px] py-[6px] text-[13px]" />
            <button className="text-[12px] text-muted border border-border rounded-lg px-[10px] py-[6px]" onClick={() => setShowVars(true)}>变量</button>
            <label className="flex items-center gap-1.5 text-[12px] text-muted"><input type="checkbox" checked={cur.enabled !== false} onChange={(e) => updateCur((w) => ({ ...w, enabled: e.target.checked }))} />启用</label>
          </>
        ) : <span className="text-[12.5px] text-muted">左侧新建一个工作流</span>}
        <div className="flex-1" />
        <button className="text-[13px] px-[14px] py-[6px] border border-border rounded-lg" onClick={onClose}>完成</button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 左：工作流列表 */}
        <div className="w-[210px] border-r border-border bg-card flex flex-col">
          <div className="text-[12px] text-muted px-4 pt-3 pb-2">工作流</div>
          <div className="flex-1 overflow-y-auto">
            {wfs.map((w) => (
              <div key={w.id} onClick={() => setCurId(w.id)}
                className={`group flex items-center gap-2 px-4 py-2 cursor-pointer text-[13px] ${w.id === curId ? "bg-orange/10 border-r-2 border-orange" : ""}`}>
                <span className="text-[15px]">{w.icon || "🧩"}</span>
                <span className={`flex-1 truncate ${w.enabled === false ? "text-muted line-through" : ""}`}>{w.name}</span>
                <button className="text-danger text-[11px] opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); delWf(w.id); }}>删</button>
              </div>
            ))}
          </div>
          <button className="m-3 py-2 border border-dashed border-border rounded-lg text-[12.5px] text-muted" onClick={newWf}>＋ 新建工作流</button>
        </div>

        {/* 中：画布 */}
        <div ref={canvasRef} className="relative flex-1 overflow-hidden"
          style={{ background: "#22201D", backgroundImage: "radial-gradient(rgba(255,255,255,.06) 1px,transparent 1px)", backgroundSize: "22px 22px" }}
          onMouseDown={() => { setEditNode(null); }}>
          {!cur ? <div className="absolute inset-0 flex items-center justify-center text-[13px] text-white/40">新建或选择一个工作流</div> : null}
          {cur ? (
            <>
              {/* 连线层 */}
              <svg className="absolute inset-0 w-full h-full pointer-events-none">
                {cur.connections.map((c, i) => {
                  const a = node(c.from), b = node(c.to);
                  if (!a || !b) return null;
                  const p1 = anchor(a, "out"), p2 = anchor(b, "in");
                  const d = `M ${p1.x} ${p1.y} C ${p1.x + 60} ${p1.y}, ${p2.x - 60} ${p2.y}, ${p2.x} ${p2.y}`;
                  return <path key={i} d={d} fill="none" stroke="#6b645c" strokeWidth={2} />;
                })}
                {link.current && linkPos ? (() => {
                  const a = node(link.current.from); if (!a) return null;
                  const p1 = anchor(a, "out");
                  return <path d={`M ${p1.x} ${p1.y} C ${p1.x + 60} ${p1.y}, ${linkPos.x - 60} ${linkPos.y}, ${linkPos.x} ${linkPos.y}`} fill="none" stroke="#E8590C" strokeWidth={2} strokeDasharray="4 4" />;
                })() : null}
              </svg>
              {/* 连线徽章（可点击切换修饰键 / 右键删除）*/}
              {cur.connections.map((c, i) => {
                const a = node(c.from), b = node(c.to);
                if (!a || !b) return null;
                const p1 = anchor(a, "out"), p2 = anchor(b, "in");
                const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
                return (
                  <button key={`b${i}`} title="点击切换 回车/⌘/⌥ 分支，右键删除"
                    onClick={() => cycleMod(i)} onContextMenu={(e) => { e.preventDefault(); delConn(i); }}
                    className="absolute -translate-x-1/2 -translate-y-1/2 bg-[#413C36] text-[#EDEAE4] border border-[#55504a] rounded-md text-[11px] px-[6px] py-[1px]"
                    style={{ left: mx, top: my }}>{MOD_LABEL[c.mod || ""]}</button>
                );
              })}
              {/* 节点 */}
              {cur.nodes.map((n) => {
                const meta = TYPE_META[n.type] || { label: n.type, emoji: "🔹", kind: "action" };
                const accent = KIND_ACCENT[meta.kind] || "#888";
                return (
                  <div key={n.id} className="absolute rounded-xl border shadow-lg select-none"
                    style={{ left: n.x, top: n.y, width: NODE_W, background: "#2E2B27", borderColor: "#413C36", color: "#EDEAE4" }}
                    onMouseUp={() => onNodeUp(n)} onDoubleClick={() => setEditNode(n.id)} onMouseDown={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2 px-3 py-2 border-b cursor-move" style={{ borderColor: "#413C36" }} onMouseDown={(e) => onNodeDown(e, n)}>
                      <span className="w-[22px] h-[22px] rounded-md flex items-center justify-center text-[13px]" style={{ background: accent + "40" }}>{meta.emoji}</span>
                      <b className="text-[12.5px] flex-1 truncate">{meta.label}</b>
                      <button className="text-[12px] text-white/40 hover:text-danger" onClick={() => delNode(n.id)}>✕</button>
                    </div>
                    <div className="px-3 py-2 text-[11px] text-[#B8B1A7] truncate cursor-pointer" onClick={() => setEditNode(n.id)}>{nodeSummary(n)}</div>
                    {/* 输入端口（左）：连线落点靠 onMouseUp 命中整个节点，这里只做视觉标记 */}
                    <span className="absolute w-[11px] h-[11px] rounded-full" style={{ left: -6, top: PORT_Y - 5, background: "#8a827a", border: "2px solid #2E2B27" }} />
                    {/* 输出端口（右）：按下拉线 */}
                    <span className="absolute w-[11px] h-[11px] rounded-full cursor-crosshair" style={{ right: -6, top: PORT_Y - 5, background: "#8a827a", border: "2px solid #2E2B27" }}
                      onMouseDown={(e) => onPortDown(e, n)} />
                  </div>
                );
              })}
              <div className="absolute left-4 bottom-3 bg-black/40 text-white/70 text-[11px] px-3 py-1.5 rounded-full pointer-events-none">
                拖 header 摆位 · 拖右侧端口到另一节点连线 · 点连线徽章切分支(右键删) · 双击节点配置
              </div>
            </>
          ) : null}
        </div>

        {/* 右：节点面板 */}
        <div className="w-[186px] border-l border-border bg-card overflow-y-auto p-3">
          {CATALOG.map((g) => (
            <div key={g.cat}>
              <div className="text-[11px] text-muted mt-2 mb-1.5 first:mt-0">{g.cat}</div>
              {g.items.map((it) => (
                <button key={it.type} disabled={!cur} onClick={() => addNode(it.type)}
                  className="w-full flex items-center gap-2 px-2.5 py-2 mb-1.5 border border-border rounded-lg text-[12.5px] text-left disabled:opacity-40 hover:border-orange">
                  <span className="w-[20px] text-center">{it.emoji}</span>{it.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {editNode && cur ? (
        <NodeConfig node={cur.nodes.find((n) => n.id === editNode)!} onClose={() => setEditNode(null)}
          onSave={(cfg) => { setNodeConfig(editNode, cfg); setEditNode(null); }} />
      ) : null}
      {showVars && cur ? (
        <VarsEditor vars={cur.variables || {}} onClose={() => setShowVars(false)}
          onSave={(v) => { updateCur((w) => ({ ...w, variables: v })); setShowVars(false); }} />
      ) : null}
    </div>
  );
}

// 节点摘要（画布上一行简述）。
function nodeSummary(n: WFNode): string {
  const c = n.config as Record<string, string>;
  switch (n.type) {
    case "trigger.keyword": return `关键词「${c.keyword || "?"}」${c.arg === "none" ? "" : " · 带参"}`;
    case "trigger.hotkey": return c.accelerator || "未设快捷键";
    case "input.scriptfilter": return c.script ? c.script.slice(0, 40) : "未设脚本";
    case "action.script": return c.script ? c.script.slice(0, 40) : "未设脚本";
    case "action.openurl": return String(c.url || "{query}");
    case "action.openfile": return String(c.path || "{query}");
    default: return TYPE_META[n.type]?.label || n.type;
  }
}

// ── 节点配置弹窗 ──
function NodeConfig({ node, onSave, onClose }: { node: WFNode; onSave: (c: Record<string, unknown>) => void; onClose: () => void }) {
  const [c, setC] = useState<Record<string, unknown>>({ ...node.config });
  const [rec, setRec] = useState(false);
  const meta = TYPE_META[node.type] || { label: node.type, emoji: "🔹" };
  const set = (k: string, v: unknown) => setC((p) => ({ ...p, [k]: v }));
  const inp = "w-full bg-bg border border-border rounded-lg px-[10px] py-[7px] text-[12.5px] outline-none";
  const lab = "text-[11.5px] text-muted mb-1 block";

  // Hotkey 录制
  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setRec(false); return; }
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
      const mods: string[] = [];
      if (e.metaKey) mods.push("Command"); if (e.ctrlKey) mods.push("Control");
      if (e.altKey) mods.push("Alt"); if (e.shiftKey) mods.push("Shift");
      const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
      set("accelerator", [...mods, key].join("+")); setRec(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rec]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div className="w-[440px] bg-card border border-border rounded-2xl p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-4"><span className="text-[18px]">{meta.emoji}</span><span className="font-semibold text-[14px]">{meta.label}</span></div>
        <div className="flex flex-col gap-3">
          {node.type === "trigger.keyword" ? (<>
            <div><span className={lab}>关键词（在快捷入口输入触发）</span><input className={`${inp} font-mono`} value={String(c.keyword || "")} onChange={(e) => set("keyword", e.target.value)} placeholder="yd" /></div>
            <div><span className={lab}>参数</span>
              <select className={inp} value={String(c.arg || "optional")} onChange={(e) => set("arg", e.target.value)}>
                <option value="none">无参数（仅关键词）</option>
                <option value="optional">可选参数</option>
                <option value="required">必填参数</option>
              </select></div>
            <div><span className={lab}>显示标题（可选）</span><input className={inp} value={String(c.title || "")} onChange={(e) => set("title", e.target.value)} /></div>
          </>) : null}
          {node.type === "trigger.hotkey" ? (
            <div><span className={lab}>全局快捷键</span>
              <button onClick={() => setRec(true)} className={`${inp} text-left font-mono ${rec ? "border-orange" : ""}`}>{rec ? "按下快捷键…" : (String(c.accelerator || "") || "点击录制")}</button>
              <div className="text-[11px] text-muted mt-1">触发时把当前剪贴板文本作为参数，跑「回车」分支的动作。</div>
            </div>
          ) : null}
          {node.type === "input.scriptfilter" ? (<>
            <div><span className={lab}>脚本（stdout 返回 Alfred JSON：{"{items:[…]}"}，$1=输入）</span>
              <textarea className={`${inp} font-mono h-[90px] resize-y`} value={String(c.script || "")} onChange={(e) => set("script", e.target.value)} placeholder={`./runtime/txiki ./index.js "$1"`} /></div>
            <div><span className={lab}>运行目录 cwd（可选，支持 ~）</span><input className={`${inp} font-mono`} value={String(c.cwd || "")} onChange={(e) => set("cwd", e.target.value)} /></div>
            <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={!!c.alfredFilters} onChange={(e) => set("alfredFilters", e.target.checked)} />由 Umbra 按输入过滤结果（脚本不自行过滤时勾选）</label>
          </>) : null}
          {node.type === "action.script" ? (<>
            <div><span className={lab}>脚本（$1=上游 arg，变量注入 env）</span>
              <textarea className={`${inp} font-mono h-[80px] resize-y`} value={String(c.script || "")} onChange={(e) => set("script", e.target.value)} placeholder={`say "$1"`} /></div>
            <div><span className={lab}>运行目录 cwd（可选）</span><input className={`${inp} font-mono`} value={String(c.cwd || "")} onChange={(e) => set("cwd", e.target.value)} /></div>
            <div><span className={lab}>stdout 处理</span>
              <select className={inp} value={String(c.output || "none")} onChange={(e) => set("output", e.target.value)}>
                <option value="none">忽略</option><option value="copy">复制到剪贴板</option>
              </select></div>
          </>) : null}
          {node.type === "action.openurl" ? (
            <div><span className={lab}>网址（{"{query}"}=arg）</span><input className={`${inp} font-mono`} value={String(c.url || "")} onChange={(e) => set("url", e.target.value)} placeholder="https://example.com/?q={query}" /></div>
          ) : null}
          {node.type === "action.openfile" ? (<>
            <div><span className={lab}>路径（{"{query}"}=arg，支持 ~）</span><input className={`${inp} font-mono`} value={String(c.path || "")} onChange={(e) => set("path", e.target.value)} /></div>
            <div><span className={lab}>用哪个应用打开（可选）</span><input className={inp} value={String(c.app || "")} onChange={(e) => set("app", e.target.value)} placeholder="Visual Studio Code" /></div>
          </>) : null}
          {["action.copy", "action.paste", "action.assistant", "action.inspiration", "output.notify", "output.largetype"].includes(node.type) ? (
            <div className="text-[12px] text-muted">此动作无需额外配置，直接使用上游传入的内容（arg）。</div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button className="px-[14px] py-[7px] border border-border rounded-lg text-[12.5px]" onClick={onClose}>取消</button>
          <button className="px-[14px] py-[7px] bg-orange text-white rounded-lg text-[12.5px] font-semibold" onClick={() => onSave(c)}>保存</button>
        </div>
      </div>
    </div>
  );
}

// ── 工作流变量编辑（可存密钥）──
function VarsEditor({ vars, onSave, onClose }: { vars: Record<string, string>; onSave: (v: Record<string, string>) => void; onClose: () => void }) {
  const [rows, setRows] = useState<{ k: string; v: string }[]>(Object.entries(vars).map(([k, v]) => ({ k, v })));
  const inp = "bg-bg border border-border rounded-lg px-[9px] py-[6px] text-[12.5px] outline-none font-mono";
  const secret = (k: string) => /key|secret|token|pass/i.test(k);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div className="w-[460px] bg-card border border-border rounded-2xl p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="font-semibold text-[14px] mb-1">工作流变量</div>
        <div className="text-[11.5px] text-muted mb-3">注入脚本环境变量；可存 appKey / secret 等密钥（仅本地，不上传）。脚本里用 {"{var:名称}"} 或直接读同名环境变量。</div>
        <div className="flex flex-col gap-2 mb-3">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className={`${inp} w-[130px]`} value={r.k} placeholder="名称" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
              <input className={`${inp} flex-1`} type={secret(r.k) ? "password" : "text"} value={r.v} placeholder="值" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
              <button className="text-danger text-[12px]" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
        </div>
        <button className="text-[12.5px] text-muted border border-dashed border-border rounded-lg px-3 py-1.5" onClick={() => setRows([...rows, { k: "", v: "" }])}>＋ 加一行</button>
        <div className="flex justify-end gap-2 mt-5">
          <button className="px-[14px] py-[7px] border border-border rounded-lg text-[12.5px]" onClick={onClose}>取消</button>
          <button className="px-[14px] py-[7px] bg-orange text-white rounded-lg text-[12.5px] font-semibold"
            onClick={() => { const v: Record<string, string> = {}; for (const r of rows) if (r.k.trim()) v[r.k.trim()] = r.v; onSave(v); }}>保存</button>
        </div>
      </div>
    </div>
  );
}
