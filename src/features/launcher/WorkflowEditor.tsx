// 工作流可视化编辑器（类 Alfred Workflow）。独立窗口：左工作流列表 / 中可拖拽画布 / 右节点面板。
// 画布：节点按下任意处拖动、单击选中(Delete 删)、双击配置、右键菜单；端口拉线连接；
// 连线徽章：单击选中、双击切换修饰键、右键删除；Cmd+Z 撤销；滚轮/按钮缩放；空白拖拽平移（无限画布）。
import { useCallback, useEffect, useRef, useState } from "react";

export interface WFNode { id: string; type: string; x: number; y: number; config: Record<string, unknown> }
// fromPort：从上游节点的哪个出口引出。""=默认/唯一出口；"r0".."rN"=Conditional 第 N 条规则命中；
// "else"=Conditional 兜底；"error"=Run Script 失败出口（onError=branch 时才有）。
export interface WFConn { from: string; to: string; mod?: string; fromPort?: string }
export interface WF { id: string; name: string; icon?: string; desc?: string; enabled: boolean; variables?: Record<string, string>; nodes: WFNode[]; connections: WFConn[] }

interface LauncherAPI {
  getWorkflows(): Promise<WF[]>; setWorkflows(w: WF[]): Promise<void>;
  pickPath(): Promise<string>; pickApp(): Promise<string>; fileIcon(p: string): Promise<string>;
}
const api = (window as unknown as { umbraLauncher: LauncherAPI }).umbraLauncher;

const NODE_W = 168;
const PORT_Y = 26;
const PORT_GAP = 20;   // 多出口节点：相邻两个输出端口的垂直间距
const MODS = ["", "cmd", "alt", "ctrl", "shift"];
const MOD_LABEL: Record<string, string> = { "": "↵", cmd: "⌘↵", alt: "⌥↵", ctrl: "⌃↵", shift: "⇧↵" };
const WORLD_W = 4000, WORLD_H = 3000;

const CATALOG: { cat: string; items: { type: string; label: string; emoji: string }[] }[] = [
  { cat: "触发 Triggers", items: [
    { type: "trigger.keyword", label: "Keyword", emoji: "⌨️" },
    { type: "trigger.hotkey", label: "Hotkey", emoji: "⌘" },
    { type: "trigger.always", label: "始终触发（无关键词）", emoji: "♾️" },
  ] },
  { cat: "输入 Inputs", items: [
    { type: "input.scriptfilter", label: "Script Filter", emoji: "🔎" },
    { type: "input.translate", label: "有道翻译", emoji: "🌐" },
    { type: "input.codec", label: "编解码", emoji: "🔡" },
    { type: "input.calc", label: "计算器", emoji: "🔢" },
    { type: "input.units", label: "单位换算", emoji: "📐" },
  ] },
  { cat: "工具 Utilities", items: [
    { type: "utility.args", label: "Args & Vars（改参数/设变量）", emoji: "🏷️" },
    { type: "utility.conditional", label: "Conditional（条件分流）", emoji: "🔀" },
    { type: "utility.transform", label: "Transform（大小写/编解码）", emoji: "🔠" },
    { type: "utility.replace", label: "Replace（查找替换）", emoji: "🔁" },
    { type: "utility.delay", label: "Delay（延时）", emoji: "⏱️" },
  ] },
  { cat: "动作 Actions", items: [
    { type: "action.launch", label: "Launch Apps / Files", emoji: "🚀" },
    { type: "action.openfile", label: "Open File（打开文件/书签）", emoji: "📂" },
    { type: "action.openurl", label: "打开网址", emoji: "🔗" },
    { type: "action.script", label: "Run Script", emoji: "📜" },
    { type: "action.copy", label: "复制到剪贴板", emoji: "📋" },
    { type: "action.paste", label: "粘贴到前台", emoji: "📥" },
    { type: "action.assistant", label: "发给秘书", emoji: "💬" },
    { type: "action.inspiration", label: "记为灵感", emoji: "💡" },
    { type: "action.ask_assistant", label: "问秘书（等回复）", emoji: "🤖" },
    { type: "action.create_task", label: "建任务", emoji: "🗓️" },
    { type: "action.device_skill", label: "设备技能派发", emoji: "🛰️" },
  ] },
  { cat: "输出 Outputs", items: [
    { type: "output.notify", label: "系统通知", emoji: "🔔" },
    { type: "output.largetype", label: "大字显示", emoji: "🅰️" },
    { type: "output.textview", label: "文本视图（长文/Markdown）", emoji: "📄" },
  ] },
];
const TYPE_META: Record<string, { label: string; emoji: string; kind: string }> = {};
for (const g of CATALOG) for (const it of g.items) TYPE_META[it.type] = { label: it.label, emoji: it.emoji, kind: it.type.split(".")[0] };
const KIND_ACCENT: Record<string, string> = { trigger: "#8E44AD", input: "#2980B9", utility: "#B7791F", action: "#27AE60", output: "#E8590C" };

function defaultConfig(type: string): Record<string, unknown> {
  switch (type) {
    case "trigger.keyword": return { keyword: "kw", arg: "optional", title: "" };
    case "trigger.hotkey": return { accelerator: "" };
    case "input.scriptfilter": return { script: "", cwd: "", alfredFilters: false };
    case "input.codec": return { mode: "unicode" };
    case "action.script": return { script: "", cwd: "", output: "none", onError: "stop" };
    case "utility.args": return { argMode: "keep", text: "{query}", vars: {} };
    case "utility.conditional": return { rules: [{ subject: "{query}", op: "contains", value: "", ci: true }] };
    case "utility.transform": return { target: "", mode: "upper" };
    case "utility.replace": return { target: "", find: "", to: "", regex: false, ci: false };
    case "utility.delay": return { seconds: 1 };
    case "action.ask_assistant": return { prompt: "{query}", title: "", show: true };
    case "action.create_task": return { text: "{query}", prefix: "帮我建个任务：" };
    case "action.device_skill": return { device: "", provider: "", skill: "", params: "" };
    case "output.textview": return { title: "", markdown: true, append: false };
    case "action.openurl": return { url: "{query}" };
    case "action.openfile": return { path: "{query}", app: "" };
    case "action.launch": return { paths: [], toggleVisibility: false };
    default: return {};
  }
}
// 节点的输出端口清单：默认只有一个匿名出口；Conditional 按规则条数出 r0…rN 再加一个 else；
// Run Script 选了「失败走分支」时，成功口之外再多一个 error 口。端口顺序即画布上从上到下的顺序。
function outPorts(n: WFNode): { port: string; label: string }[] {
  if (n.type === "utility.conditional") {
    const rules = Array.isArray(n.config.rules) ? (n.config.rules as unknown[]) : [];
    const list = rules.map((_, i) => ({ port: `r${i}`, label: `规则${i + 1}` }));
    list.push({ port: "else", label: "否则" });
    return list;
  }
  if (n.type === "action.script" && String(n.config.onError || "stop") === "branch") {
    return [{ port: "", label: "成功" }, { port: "error", label: "失败" }];
  }
  return [{ port: "", label: "" }];
}
// 出口在清单里的序号（用于算端口坐标）。找不到（比如规则删少了）就退回第一个口。
const portIndex = (n: WFNode, port?: string): number => {
  const i = outPorts(n).findIndex((p) => p.port === (port || ""));
  return i < 0 ? 0 : i;
};

const uid = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const clone = (w: WF[]): WF[] => JSON.parse(JSON.stringify(w));

// ── 右键菜单（多级子菜单）──
interface MenuItem { label?: string; emoji?: string; onClick?: () => void; sub?: MenuItem[]; danger?: boolean; sep?: boolean }
function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="bg-card border border-border rounded-lg shadow-2xl py-1 min-w-[190px]">
      {items.map((it, i) => it.sep ? <div key={i} className="h-px bg-border my-1" /> : (
        <div key={i} className="relative" onMouseEnter={() => setOpen(it.sub ? i : null)}>
          <button className={`w-full text-left px-3 py-1.5 text-[12.5px] flex items-center gap-2 hover:bg-orange/10 ${it.danger ? "text-danger" : ""}`}
            onClick={() => { if (it.sub) return; it.onClick?.(); onClose(); }}>
            <span className="w-4 text-center">{it.emoji || ""}</span>
            <span className="flex-1">{it.label}</span>
            {it.sub ? <span className="text-muted">›</span> : null}
          </button>
          {it.sub && open === i ? <div className="absolute left-full top-0 -mt-1 ml-0.5"><MenuList items={it.sub} onClose={onClose} /></div> : null}
        </div>
      ))}
    </div>
  );
}
function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[70]" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div className="absolute" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}><MenuList items={items} onClose={onClose} /></div>
    </div>
  );
}

export function WorkflowEditor({ onClose }: { onClose: () => void }) {
  const [wfs, setWfs] = useState<WF[]>([]);
  const [curId, setCurId] = useState<string>("");
  const [editNode, setEditNode] = useState<string | null>(null);
  const [showVars, setShowVars] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selConn, setSelConn] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);

  const wfsRef = useRef(wfs); wfsRef.current = wfs;
  const undoRef = useRef<WF[][]>([]);
  const panRef = useRef(pan); panRef.current = pan;
  const scaleRef = useRef(scale); scaleRef.current = scale;
  const curIdRef = useRef(curId); curIdRef.current = curId;

  useEffect(() => { void api.getWorkflows().then((w) => { setWfs(w); setCurId(w[0]?.id || ""); }); }, []);
  const cur = wfs.find((w) => w.id === curId);

  // 提交（带撤销快照）。
  const commit = useCallback((next: WF[], pushUndo = true) => {
    if (pushUndo) { undoRef.current.push(clone(wfsRef.current)); if (undoRef.current.length > 60) undoRef.current.shift(); }
    setWfs(next); void api.setWorkflows(next);
  }, []);
  const updateCur = useCallback((fn: (w: WF) => WF, pushUndo = true) => {
    if (!curIdRef.current) return;
    commit(wfsRef.current.map((w) => (w.id === curIdRef.current ? fn(w) : w)), pushUndo);
  }, [commit]);
  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    setWfs(prev); void api.setWorkflows(prev);
  }, []);

  // 工作流增删
  const newWf = () => {
    const id = uid();
    const wf: WF = { id, name: "新工作流", icon: "🧩", desc: "", enabled: true, variables: {},
      nodes: [{ id: "n1", type: "trigger.keyword", x: 80, y: 140, config: defaultConfig("trigger.keyword") }], connections: [] };
    commit([...wfsRef.current, wf]); setCurId(id); setSelNode(null); setSelConn(null);
  };
  const delWf = (id: string) => { commit(wfsRef.current.filter((w) => w.id !== id)); if (curId === id) setCurId(""); };

  // 节点增删改
  const addNode = (type: string, x?: number, y?: number) => {
    if (!cur) return;
    const n: WFNode = { id: uid(), type, x: x ?? 300, y: y ?? 160, config: defaultConfig(type) };
    updateCur((w) => ({ ...w, nodes: [...w.nodes, n] }));
    setSelNode(n.id);
  };
  const insertAfter = (n: WFNode, type: string) => {
    const nn: WFNode = { id: uid(), type, x: n.x + NODE_W + 60, y: n.y, config: defaultConfig(type) };
    updateCur((w) => ({ ...w, nodes: [...w.nodes, nn], connections: [...w.connections, { from: n.id, to: nn.id, mod: "" }] }));
  };
  const delNode = (id: string) => { updateCur((w) => ({ ...w, nodes: w.nodes.filter((n) => n.id !== id), connections: w.connections.filter((c) => c.from !== id && c.to !== id) })); setSelNode(null); };
  // 保存节点配置：顺手清掉「出口已经不存在了」的连线（比如 Conditional 删了一条规则、
  // 或 Run Script 把「失败走分支」关掉），免得画布上留着连到空气的线。
  const setNodeConfig = (id: string, config: Record<string, unknown>) => updateCur((w) => {
    const nodes = w.nodes.map((n) => (n.id === id ? { ...n, config } : n));
    const changed = nodes.find((n) => n.id === id);
    const alive = new Set((changed ? outPorts(changed) : []).map((p) => p.port));
    return { ...w, nodes, connections: w.connections.filter((c) => c.from !== id || alive.has(c.fromPort || "")) };
  });

  // 坐标：屏幕 → 世界
  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const px = clientX - (rect?.left ?? 0), py = clientY - (rect?.top ?? 0);
    return { x: (px - panRef.current.x) / scaleRef.current, y: (py - panRef.current.y) / scaleRef.current };
  };

  // 交互指针：拖节点 / 拉线 / 平移
  const drag = useRef<{ id: string; ox: number; oy: number; moved: boolean; snap: WF[] } | null>(null);
  const link = useRef<{ from: string; port: string } | null>(null);
  const panning = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [linkPos, setLinkPos] = useState<{ x: number; y: number } | null>(null);

  const onNodeDown = (e: React.MouseEvent, n: WFNode) => {
    if ((e.target as HTMLElement).closest("[data-port]")) return;
    e.stopPropagation();
    const w = toWorld(e.clientX, e.clientY);
    drag.current = { id: n.id, ox: w.x - n.x, oy: w.y - n.y, moved: false, snap: clone(wfsRef.current) };
  };
  const onPortDown = (e: React.MouseEvent, n: WFNode, port: string) => { link.current = { from: n.id, port }; setLinkPos(toWorld(e.clientX, e.clientY)); e.stopPropagation(); e.preventDefault(); };
  const onNodeUp = (n: WFNode) => {
    if (link.current && link.current.from !== n.id) {
      // 同一「出口 + 修饰键 + 目标」只允许一条连线，重复拉线视为无操作。
      const { from, port } = link.current;
      updateCur((w) => (w.connections.some((c) => c.from === from && c.to === n.id && (c.mod || "") === "" && (c.fromPort || "") === port)
        ? w
        : { ...w, connections: [...w.connections, { from, to: n.id, mod: "", fromPort: port }] }));
    }
    link.current = null; setLinkPos(null);
  };
  const onCanvasDown = (e: React.MouseEvent) => {
    setSelNode(null); setSelConn(null); setEditNode(null); setMenu(null);
    panning.current = { sx: e.clientX, sy: e.clientY, ox: panRef.current.x, oy: panRef.current.y };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (drag.current) {
        const d = drag.current; d.moved = true;
        const w = toWorld(e.clientX, e.clientY);
        const x = Math.max(0, w.x - d.ox), y = Math.max(0, w.y - d.oy);
        setWfs((prev) => prev.map((wf) => (wf.id === curIdRef.current ? { ...wf, nodes: wf.nodes.map((n) => (n.id === d.id ? { ...n, x, y } : n)) } : wf)));
      } else if (link.current) {
        setLinkPos(toWorld(e.clientX, e.clientY));
      } else if (panning.current) {
        const p = panning.current;
        setPan({ x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) });
      }
    };
    const up = () => {
      if (drag.current) {
        const d = drag.current;
        if (d.moved) { undoRef.current.push(d.snap); void api.setWorkflows(wfsRef.current); }
        else { setSelNode(d.id); setSelConn(null); }  // 未移动=单击选中
        drag.current = null;
      }
      if (link.current) { link.current = null; setLinkPos(null); }
      panning.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  // 缩放：ctrl/⌘+滚轮(触控板捏合)缩放；普通滚轮平移。
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      const wx = (cx - panRef.current.x) / scaleRef.current, wy = (cy - panRef.current.y) / scaleRef.current;
      const ns = Math.min(2.5, Math.max(0.3, scaleRef.current * (e.deltaY < 0 ? 1.1 : 0.9)));
      setPan({ x: cx - wx * ns, y: cy - wy * ns }); setScale(ns);
    } else {
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }
  };
  const zoomBy = (f: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const cx = (rect?.width ?? 800) / 2, cy = (rect?.height ?? 500) / 2;
    const wx = (cx - panRef.current.x) / scaleRef.current, wy = (cy - panRef.current.y) / scaleRef.current;
    const ns = Math.min(2.5, Math.max(0.3, scaleRef.current * f));
    setPan({ x: cx - wx * ns, y: cy - wy * ns }); setScale(ns);
  };

  // 连线徽章操作
  const cycleMod = (i: number) => updateCur((w) => { const conns = w.connections.slice(); const c = conns[i].mod || ""; conns[i] = { ...conns[i], mod: MODS[(MODS.indexOf(c) + 1) % MODS.length] as WFConn["mod"] }; return { ...w, connections: conns }; });
  const delConn = (i: number) => { updateCur((w) => ({ ...w, connections: w.connections.filter((_, j) => j !== i) })); setSelConn(null); };

  // 键盘：Delete 删选中；Cmd+Z 撤销。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selNode) { e.preventDefault(); delNode(selNode); }
        else if (selConn !== null) { e.preventDefault(); delConn(selConn); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selNode, selConn, undo]);

  const node = (id: string) => cur?.nodes.find((n) => n.id === id);
  // 端口坐标：入口固定在头部；出口按端口序号逐个下移，多出口节点因此有一列端口。
  const anchor = (n: WFNode, side: "in" | "out", port?: string) =>
    ({ x: n.x + (side === "out" ? NODE_W : 0), y: n.y + PORT_Y + (side === "out" ? portIndex(n, port) * PORT_GAP : 0) });

  const addSubmenu = (px: number, py: number): MenuItem[] => CATALOG.map((g) => ({ label: g.cat, sub: g.items.map((it) => ({ label: it.label, emoji: it.emoji, onClick: () => addNode(it.type, px, py) })) }));
  const openCanvasMenu = (e: React.MouseEvent) => { if (!cur) return; e.preventDefault(); const w = toWorld(e.clientX, e.clientY); setMenu({ x: e.clientX, y: e.clientY, items: addSubmenu(w.x, w.y) }); };
  const openNodeMenu = (e: React.MouseEvent, n: WFNode) => {
    e.preventDefault(); e.stopPropagation(); setSelNode(n.id); setSelConn(null);
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: "配置节点…", emoji: "⚙️", onClick: () => setEditNode(n.id) },
      { label: "在其后插入", emoji: "➕", sub: CATALOG.map((g) => ({ label: g.cat, sub: g.items.map((it) => ({ label: it.label, emoji: it.emoji, onClick: () => insertAfter(n, it.type) })) })) },
      { sep: true },
      { label: "删除节点", emoji: "🗑", danger: true, onClick: () => delNode(n.id) },
    ] });
  };

  const inp = "bg-bg border border-border rounded-lg px-[10px] py-[6px] text-[13px] outline-none";

  return (
    <div className="flex flex-col h-screen bg-bg text-text">
      {/* 顶栏 */}
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-border bg-card">
        <span className="text-[14px] font-semibold shrink-0">工作流编排</span>
        {cur ? (<>
          <input value={cur.icon || ""} onChange={(e) => updateCur((w) => ({ ...w, icon: e.target.value }))} className={`w-[40px] text-center ${inp} text-[15px]`} maxLength={2} title="图标" />
          <input value={cur.name} onChange={(e) => updateCur((w) => ({ ...w, name: e.target.value }))} className={`w-[150px] ${inp}`} placeholder="名称" />
          <input value={cur.desc || ""} onChange={(e) => updateCur((w) => ({ ...w, desc: e.target.value }))} className={`flex-1 ${inp} text-[12.5px]`} placeholder="描述（可选）" />
          <button className="text-[12px] text-muted border border-border rounded-lg px-[10px] py-[6px] shrink-0" onClick={() => setShowVars(true)}>变量</button>
          <label className="flex items-center gap-1.5 text-[12px] text-muted shrink-0"><input type="checkbox" checked={cur.enabled !== false} onChange={(e) => updateCur((w) => ({ ...w, enabled: e.target.checked }))} />启用</label>
        </>) : <span className="flex-1 text-[12.5px] text-muted">← 左侧新建或选择一个工作流</span>}
        <div className="flex items-center gap-1 shrink-0 text-muted">
          <button className="w-[26px] h-[26px] border border-border rounded-lg" title="撤销 ⌘Z" onClick={undo}>↶</button>
          <button className="w-[26px] h-[26px] border border-border rounded-lg" title="缩小" onClick={() => zoomBy(0.9)}>－</button>
          <span className="text-[11px] w-[38px] text-center">{Math.round(scale * 100)}%</span>
          <button className="w-[26px] h-[26px] border border-border rounded-lg" title="放大" onClick={() => zoomBy(1.1)}>＋</button>
          <button className="w-[26px] h-[26px] border border-border rounded-lg" title="复位" onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }}>⤢</button>
        </div>
        <button className="text-[13px] px-[16px] py-[6px] bg-orange text-white rounded-lg font-semibold shrink-0" onClick={onClose}>完成</button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 左：工作流列表 */}
        <div className="w-[210px] border-r border-border bg-card flex flex-col">
          <div className="text-[12px] text-muted px-4 pt-3 pb-2">工作流</div>
          <div className="flex-1 overflow-y-auto">
            {wfs.map((w) => (
              <div key={w.id} onClick={() => { setCurId(w.id); setSelNode(null); setSelConn(null); }}
                className={`group flex items-center gap-2 px-4 py-2 cursor-pointer text-[13px] ${w.id === curId ? "bg-orange/10 border-r-2 border-orange" : ""}`}>
                <span className="text-[15px]">{w.icon || "🧩"}</span>
                <span className={`flex-1 truncate ${w.enabled === false ? "text-muted line-through" : ""}`}>{w.name}</span>
                <button className="text-danger text-[11px] opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); delWf(w.id); }}>删</button>
              </div>
            ))}
            {wfs.length === 0 ? <div className="px-4 py-3 text-[12px] text-muted">还没有工作流，点下方新建。</div> : null}
          </div>
          <button className="m-3 py-2 rounded-lg text-[12.5px] font-semibold text-orange border border-orange/40 hover:bg-orange/10" onClick={newWf}>＋ 新建工作流</button>
        </div>

        {/* 中：画布 */}
        <div ref={canvasRef} className="relative flex-1 overflow-hidden"
          style={{ background: "#22201D", backgroundImage: "radial-gradient(rgba(255,255,255,.06) 1px,transparent 1px)", backgroundSize: `${22 * scale}px ${22 * scale}px`, backgroundPosition: `${pan.x}px ${pan.y}px`, cursor: "grab" }}
          onMouseDown={onCanvasDown} onContextMenu={openCanvasMenu} onWheel={onWheel}>
          {!cur ? <div className="absolute inset-0 flex items-center justify-center text-[13px] text-white/40">新建或选择一个工作流</div> : null}
          {cur ? (
            <div className="absolute top-0 left-0" style={{ width: WORLD_W, height: WORLD_H, transform: `translate(${pan.x}px,${pan.y}px) scale(${scale})`, transformOrigin: "0 0" }}>
              <svg className="absolute top-0 left-0 pointer-events-none" width={WORLD_W} height={WORLD_H}>
                {cur.connections.map((c, i) => {
                  const a = node(c.from), b = node(c.to); if (!a || !b) return null;
                  const p1 = anchor(a, "out", c.fromPort), p2 = anchor(b, "in");
                  return <path key={i} d={`M ${p1.x} ${p1.y} C ${p1.x + 60} ${p1.y}, ${p2.x - 60} ${p2.y}, ${p2.x} ${p2.y}`} fill="none" stroke={selConn === i ? "#E8590C" : "#6b645c"} strokeWidth={selConn === i ? 3 : 2} />;
                })}
                {link.current && linkPos ? (() => { const a = node(link.current.from); if (!a) return null; const p1 = anchor(a, "out", link.current.port); return <path d={`M ${p1.x} ${p1.y} C ${p1.x + 60} ${p1.y}, ${linkPos.x - 60} ${linkPos.y}, ${linkPos.x} ${linkPos.y}`} fill="none" stroke="#E8590C" strokeWidth={2} strokeDasharray="4 4" />; })() : null}
              </svg>
              {cur.connections.map((c, i) => {
                const a = node(c.from), b = node(c.to); if (!a || !b) return null;
                const p1 = anchor(a, "out", c.fromPort), p2 = anchor(b, "in");
                const ports = outPorts(a);
                const portTag = ports.length > 1 ? `${ports[portIndex(a, c.fromPort)]?.label || ""} ` : "";
                return (
                  <button key={`b${i}`} title="单击选中 · 双击切换分支 · 右键删除"
                    onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setSelConn(i); setSelNode(null); }}
                    onDoubleClick={(e) => { e.stopPropagation(); cycleMod(i); }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); delConn(i); }}
                    className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-md text-[11px] px-[6px] py-[1px] border ${selConn === i ? "bg-orange text-white border-orange" : "bg-[#413C36] text-[#EDEAE4] border-[#55504a]"}`}
                    style={{ left: (p1.x + p2.x) / 2, top: (p1.y + p2.y) / 2 }}>{portTag}{MOD_LABEL[c.mod || ""]}</button>
                );
              })}
              {cur.nodes.map((n) => {
                const meta = TYPE_META[n.type] || { label: n.type, emoji: "🔹", kind: "action" };
                const accent = KIND_ACCENT[meta.kind] || "#888";
                const sel = selNode === n.id;
                const ports = outPorts(n);
                // 端口比节点本身高时把节点撑高，避免端口飘到卡片外面。
                const minH = Math.max(66, PORT_Y + (ports.length - 1) * PORT_GAP + 16);
                return (
                  <div key={n.id} className="absolute rounded-xl border shadow-lg select-none cursor-grab active:cursor-grabbing"
                    style={{ left: n.x, top: n.y, width: NODE_W, minHeight: minH, background: "#2E2B27", borderColor: sel ? "#E8590C" : "#413C36", boxShadow: sel ? "0 0 0 2px rgba(232,89,12,.5)" : undefined, color: "#EDEAE4" }}
                    onMouseDown={(e) => onNodeDown(e, n)} onMouseUp={() => onNodeUp(n)} onDoubleClick={() => setEditNode(n.id)} onContextMenu={(e) => openNodeMenu(e, n)}>
                    <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: "#413C36" }}>
                      <span className="w-[22px] h-[22px] rounded-md flex items-center justify-center text-[13px]" style={{ background: accent + "40" }}>{meta.emoji}</span>
                      <b className="text-[12.5px] flex-1 truncate">{meta.label}</b>
                    </div>
                    <div className="px-3 py-2 text-[11px] text-[#B8B1A7] truncate">{nodeSummary(n)}</div>
                    <span data-port className="absolute w-[11px] h-[11px] rounded-full" style={{ left: -6, top: PORT_Y - 5, background: "#8a827a", border: "2px solid #2E2B27" }} />
                    {ports.map((p, pi) => (
                      <span key={p.port || "def"} data-port className="absolute w-[11px] h-[11px] rounded-full cursor-crosshair" title={p.label || "出口"}
                        style={{ right: -6, top: PORT_Y + pi * PORT_GAP - 5, background: p.port === "error" ? "#C0392B" : p.port === "else" ? "#7f8c8d" : "#8a827a", border: "2px solid #2E2B27" }}
                        onMouseDown={(e) => onPortDown(e, n, p.port)} />
                    ))}
                    {ports.length > 1 ? ports.map((p, pi) => (
                      <span key={`lb${p.port}`} className="absolute text-[9px] whitespace-nowrap pointer-events-none" style={{ left: NODE_W + 9, top: PORT_Y + pi * PORT_GAP - 7, color: "#8a827a" }}>{p.label}</span>
                    )) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          {cur ? <div className="absolute left-4 bottom-3 bg-black/40 text-white/70 text-[11px] px-3 py-1.5 rounded-full pointer-events-none">拖节点摆位 · 单击选中(Delete 删) · 双击配置 · 右键菜单 · 端口拉线 · ⌘Z 撤销 · ⌘/⌃+滚轮缩放 · 拖空白平移</div> : null}
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
        <NodeConfig node={cur.nodes.find((n) => n.id === editNode)!} onClose={() => setEditNode(null)} onSave={(cfg) => { setNodeConfig(editNode, cfg); setEditNode(null); }} />
      ) : null}
      {showVars && cur ? (
        <VarsEditor vars={cur.variables || {}} onClose={() => setShowVars(false)} onSave={(v) => { updateCur((w) => ({ ...w, variables: v })); setShowVars(false); }} />
      ) : null}
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

function nodeSummary(n: WFNode): string {
  const c = n.config as Record<string, string>;
  switch (n.type) {
    case "trigger.keyword": return `关键词「${c.keyword || "?"}」${c.arg === "none" ? "" : " · 带参"}`;
    case "trigger.hotkey": return c.accelerator || "未设快捷键";
    case "trigger.always": return "任意输入都尝试";
    case "input.scriptfilter": return c.script ? c.script.slice(0, 40) : "未设脚本";
    case "input.codec": return `编解码：${c.mode || "unicode"}`;
    case "input.calc": return "计算表达式";
    case "input.units": return "单位换算";
    case "input.translate": return "有道翻译（密钥在变量）";
    case "action.script": return c.script ? c.script.slice(0, 40) : "未设脚本";
    case "action.openurl": return String(c.url || "{query}");
    case "action.openfile": return String(c.path || "{query}");
    case "action.launch": { const p = (n.config.paths as string[]) || []; return p.length ? `${p.length} 个 App/文件` : "未选择 App/文件"; }
    case "utility.args": return c.argMode === "set" ? `参数改为「${String(c.text || "").slice(0, 16)}」` : c.argMode === "clear" ? "清空参数" : "沿用参数 · 可设变量";
    case "utility.conditional": { const r = (n.config.rules as unknown[]) || []; return `${r.length} 条规则 · 多出口`; }
    case "utility.transform": return `${c.target ? `变量 ${c.target}` : "参数"} → ${c.mode || "upper"}`;
    case "utility.replace": return c.find ? `「${c.find}」→「${c.to || ""}」` : "未设查找内容";
    case "utility.delay": return `等待 ${Number(c.seconds || 0)} 秒`;
    case "action.ask_assistant": return String(c.prompt || "{query}").slice(0, 28);
    case "action.create_task": return String(c.text || "{query}").slice(0, 28);
    case "action.device_skill": return `${c.provider || "?"}.${c.skill || "?"}${c.device ? ` @${c.device}` : " @自动"}`;
    case "output.textview": return `文本视图${c.append ? " · 追加" : ""}`;
    default: return TYPE_META[n.type]?.label || n.type;
  }
}

// Launch 目标列表：左图标 + 路径（默认只读，双击可编辑）。
function LaunchList({ paths, onChange }: { paths: string[]; onChange: (p: string[]) => void }) {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<number | null>(null);
  useEffect(() => {
    for (const p of paths) if (!(p in icons)) void api.fileIcon(p).then((d) => setIcons((m) => ({ ...m, [p]: d || "" })));
  }, [paths]);
  const setAt = (i: number, v: string) => onChange(paths.map((x, j) => (j === i ? v : x)));
  return (
    <div className="flex flex-col gap-1.5">
      {paths.map((p, i) => (
        <div key={i} className="flex items-center gap-2 bg-bg border border-border rounded-lg px-[8px] py-[6px]">
          <span className="w-[20px] h-[20px] flex items-center justify-center shrink-0">{icons[p] ? <img src={icons[p]} className="w-[18px] h-[18px]" alt="" /> : <span className="text-[13px]">📄</span>}</span>
          {editing === i ? (
            <input autoFocus defaultValue={p} onBlur={(e) => { setAt(i, e.target.value.trim()); setEditing(null); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              className="flex-1 bg-transparent border-b border-orange text-[12px] font-mono outline-none" />
          ) : (
            <span className="flex-1 truncate text-[12px] font-mono cursor-text" title="双击编辑" onDoubleClick={() => setEditing(i)}>{p}</span>
          )}
          <button className="text-danger text-[12px]" onClick={() => onChange(paths.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div className="flex gap-1.5">
        <button className="px-[10px] py-[6px] border border-border rounded-lg text-[12px]" onClick={async () => { const a = await api.pickApp(); if (a) onChange([...paths, `/Applications/${a}.app`]); }}>＋ 选 App</button>
        <button className="px-[10px] py-[6px] border border-border rounded-lg text-[12px]" onClick={async () => { const p = await api.pickPath(); if (p) onChange([...paths, p]); }}>＋ 选文件</button>
      </div>
    </div>
  );
}

// ── Conditional 规则表 ──
// 一行一条规则，顺序即出口顺序（第 1 行 → r0 口，以此类推）；判断在引擎侧由 matchRule 执行。
export interface Rule { subject?: string; op?: string; value?: string; ci?: boolean }
const RULE_OPS: { v: string; t: string }[] = [
  { v: "contains", t: "包含" }, { v: "not_contains", t: "不包含" },
  { v: "is", t: "等于" }, { v: "is_not", t: "不等于" },
  { v: "starts_with", t: "开头是" }, { v: "ends_with", t: "结尾是" },
  { v: "is_empty", t: "为空" }, { v: "is_not_empty", t: "不为空" },
  { v: "gt", t: "大于" }, { v: "gte", t: "≥" }, { v: "lt", t: "小于" }, { v: "lte", t: "≤" },
  { v: "matches", t: "正则匹配" }, { v: "not_matches", t: "正则不匹配" },
];
// 这两个判断只看被判断对象本身，不需要填比较值。
const NO_VALUE_OPS = ["is_empty", "is_not_empty"];
function RulesEditor({ rules, onChange }: { rules: Rule[]; onChange: (r: Rule[]) => void }) {
  const inp = "bg-bg border border-border rounded-lg px-[8px] py-[5px] text-[12px] outline-none";
  const setAt = (i: number, patch: Partial<Rule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2">
      {rules.map((r, i) => (
        <div key={i} className="border border-border rounded-lg p-2 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted w-[38px] shrink-0">出口{i + 1}</span>
            <input className={`${inp} flex-1 font-mono`} value={r.subject ?? "{query}"} placeholder="{query}" onChange={(e) => setAt(i, { subject: e.target.value })} />
            <button className="text-danger text-[12px] px-1" title="删除这条规则" onClick={() => onChange(rules.filter((_, j) => j !== i))}>✕</button>
          </div>
          <div className="flex items-center gap-1.5">
            <select className={`${inp} w-[104px] shrink-0`} value={r.op || "contains"} onChange={(e) => setAt(i, { op: e.target.value })}>
              {RULE_OPS.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
            </select>
            {NO_VALUE_OPS.includes(r.op || "contains") ? <span className="flex-1 text-[11px] text-muted">（无需比较值）</span>
              : <input className={`${inp} flex-1 font-mono`} value={r.value ?? ""} placeholder="比较值" onChange={(e) => setAt(i, { value: e.target.value })} />}
            <label className="flex items-center gap-1 text-[11px] text-muted shrink-0"><input type="checkbox" checked={r.ci !== false} onChange={(e) => setAt(i, { ci: e.target.checked })} />忽略大小写</label>
          </div>
        </div>
      ))}
      <button className="text-[12.5px] text-muted border border-dashed border-border rounded-lg px-3 py-1.5"
        onClick={() => onChange([...rules, { subject: "{query}", op: "contains", value: "", ci: true }])}>＋ 加一条规则</button>
    </div>
  );
}

// ── 简易键值表（Args & Vars 节点用来设置变量）──
function KVEditor({ kv, onChange }: { kv: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const [rows, setRows] = useState<{ k: string; v: string }[]>(Object.entries(kv || {}).map(([k, v]) => ({ k, v: String(v) })));
  const inp = "bg-bg border border-border rounded-lg px-[8px] py-[5px] text-[12px] outline-none font-mono";
  // 每次编辑都立刻回吐给父级：空名字的行会被忽略，不写进配置。
  const push = (rs: { k: string; v: string }[]) => {
    setRows(rs);
    const o: Record<string, string> = {};
    for (const r of rs) if (r.k.trim()) o[r.k.trim()] = r.v;
    onChange(o);
  };
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input className={`${inp} w-[110px]`} value={r.k} placeholder="变量名" onChange={(e) => push(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
          <input className={`${inp} flex-1`} value={r.v} placeholder="值（可用 {query}）" onChange={(e) => push(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
          <button className="text-danger text-[12px]" onClick={() => push(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="text-[12px] text-muted border border-dashed border-border rounded-lg px-2.5 py-1" onClick={() => push([...rows, { k: "", v: "" }])}>＋ 加一个变量</button>
    </div>
  );
}

// ── 节点配置弹窗 ──
function NodeConfig({ node, onSave, onClose }: { node: WFNode; onSave: (c: Record<string, unknown>) => void; onClose: () => void }) {
  const [c, setC] = useState<Record<string, unknown>>({ ...node.config });
  const [rec, setRec] = useState(false);
  const meta = TYPE_META[node.type] || { label: node.type, emoji: "🔹" };
  const set = (k: string, v: unknown) => setC((p) => ({ ...p, [k]: v }));
  const inp = "w-full bg-bg border border-border rounded-lg px-[10px] py-[7px] text-[12.5px] outline-none";
  const lab = "text-[11.5px] text-muted mb-1 block";

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
                <option value="none">无参数（仅关键词）</option><option value="optional">可选参数</option><option value="required">必填参数</option>
              </select></div>
            <div><span className={lab}>显示标题（可选）</span><input className={inp} value={String(c.title || "")} onChange={(e) => set("title", e.target.value)} /></div>
          </>) : null}
          {node.type === "trigger.hotkey" ? (
            <div><span className={lab}>全局快捷键</span>
              <button onClick={() => setRec(true)} className={`${inp} text-left font-mono ${rec ? "border-orange" : ""}`}>{rec ? "按下快捷键…" : (String(c.accelerator || "") || "点击录制")}</button>
              <div className="text-[11px] text-muted mt-1">触发时把当前剪贴板文本作为参数，跑「回车」分支的动作。</div>
            </div>
          ) : null}
          {node.type === "trigger.always" ? (
            <div className="text-[12px] text-muted">无需关键词，任意输入都会尝试运行下游输入节点（如计算器/单位换算），结果并入普通搜索。</div>
          ) : null}
          {node.type === "input.scriptfilter" ? (<>
            <div><span className={lab}>脚本（stdout 返回 Alfred JSON：{"{items:[…]}"}，$1=输入）</span>
              <textarea className={`${inp} font-mono h-[90px] resize-y`} value={String(c.script || "")} onChange={(e) => set("script", e.target.value)} placeholder={`./runtime/txiki ./index.js "$1"`} /></div>
            <div><span className={lab}>运行目录 cwd（可选，支持 ~）</span><input className={`${inp} font-mono`} value={String(c.cwd || "")} onChange={(e) => set("cwd", e.target.value)} /></div>
            <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={!!c.alfredFilters} onChange={(e) => set("alfredFilters", e.target.checked)} />由 Umbra 按输入过滤结果</label>
          </>) : null}
          {node.type === "input.codec" ? (
            <div><span className={lab}>编解码类型</span>
              <select className={inp} value={String(c.mode || "unicode")} onChange={(e) => set("mode", e.target.value)}>
                <option value="unicode">Unicode</option><option value="url">URL</option><option value="base64">Base64</option>
              </select></div>
          ) : null}
          {node.type === "input.calc" || node.type === "input.units" ? (
            <div className="text-[12px] text-muted">{node.type === "input.calc" ? "输入算式即时求值（如 3*4+2）。" : "输入换算（如 10km to mi、72f to c）。"}回车复制结果。</div>
          ) : null}
          {node.type === "input.translate" ? (
            <div className="text-[12px] text-muted">有道翻译：输入词句返回译文/释义（回车复制）。密钥在顶栏「变量」里填 <code>youdaoAppKey</code> / <code>youdaoSecret</code>。</div>
          ) : null}
          {node.type === "action.script" ? (<>
            <div><span className={lab}>脚本（$1=上游 arg，变量注入 env）</span>
              <textarea className={`${inp} font-mono h-[80px] resize-y`} value={String(c.script || "")} onChange={(e) => set("script", e.target.value)} placeholder={`say "$1"`} /></div>
            <div><span className={lab}>运行目录 cwd（可选）</span><input className={`${inp} font-mono`} value={String(c.cwd || "")} onChange={(e) => set("cwd", e.target.value)} /></div>
            <div><span className={lab}>stdout 处理</span>
              <select className={inp} value={String(c.output || "none")} onChange={(e) => set("output", e.target.value)}>
                <option value="none">忽略（继续传给下游）</option><option value="copy">复制到剪贴板</option>
              </select></div>
            <div><span className={lab}>脚本失败时</span>
              <select className={inp} value={String(c.onError || "stop")} onChange={(e) => set("onError", e.target.value)}>
                <option value="stop">停止这条链路（默认）</option>
                <option value="continue">忽略错误继续往下走</option>
                <option value="branch">走「失败」出口（节点上会多一个红色端口）</option>
              </select>
              <div className="text-[11px] text-muted mt-1">脚本还可以输出 Alfred 风格的 JSON（{"{alfredworkflow:{arg,variables}}"}）来改写下游参数与变量。</div>
            </div>
          </>) : null}
          {node.type === "action.openurl" ? (
            <div><span className={lab}>网址（{"{query}"}=arg）</span><input className={`${inp} font-mono`} value={String(c.url || "")} onChange={(e) => set("url", e.target.value)} placeholder="https://example.com/?q={query}" /></div>
          ) : null}
          {node.type === "action.openfile" ? (<>
            <div className="text-[11.5px] text-muted">打开上游传入的文件/文件夹；下方可设固定路径（书签）与用哪个应用打开。</div>
            <div className="flex gap-1.5"><input className={`flex-1 ${inp} font-mono`} value={String(c.path || "")} onChange={(e) => set("path", e.target.value)} placeholder="{query} 或固定路径（支持 ~）" />
              <button className="px-[10px] border border-border rounded-lg text-[12px]" onClick={async () => { const p = await api.pickPath(); if (p) set("path", p); }}>选择</button></div>
            <div className="flex gap-1.5"><input className={`flex-1 ${inp}`} value={String(c.app || "")} onChange={(e) => set("app", e.target.value)} placeholder="用哪个应用打开（可选）" />
              <button className="px-[10px] border border-border rounded-lg text-[12px]" onClick={async () => { const a = await api.pickApp(); if (a) set("app", a); }}>选择 App</button></div>
          </>) : null}
          {node.type === "action.launch" ? (<>
            <span className={lab}>要启动的 App / 文件（双击某行编辑路径）</span>
            <LaunchList paths={(c.paths as string[]) || []} onChange={(p) => set("paths", p)} />
            <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={!!c.toggleVisibility} onChange={(e) => set("toggleVisibility", e.target.checked)} />切换可见性：若某 App 已在前台则隐藏它</label>
          </>) : null}
          {node.type === "utility.args" ? (<>
            <div><span className={lab}>参数如何处理</span>
              <select className={inp} value={String(c.argMode || "keep")} onChange={(e) => set("argMode", e.target.value)}>
                <option value="keep">沿用上游参数</option><option value="set">用下面的模板改写</option><option value="clear">清空参数</option>
              </select></div>
            {String(c.argMode || "keep") === "set" ? (
              <div><span className={lab}>新参数模板（{"{query}"}=上游参数，{"{var:名称}"}=变量）</span>
                <input className={`${inp} font-mono`} value={String(c.text || "")} onChange={(e) => set("text", e.target.value)} placeholder="{query}" /></div>
            ) : null}
            <div><span className={lab}>设置变量（对本节点之后的下游可见）</span>
              <KVEditor kv={(c.vars as Record<string, string>) || {}} onChange={(v) => set("vars", v)} /></div>
          </>) : null}
          {node.type === "utility.conditional" ? (<>
            <div className="text-[11.5px] text-muted">从上往下逐条判断，命中哪条就走哪个出口；全不中走「否则」。出口没连线时链路自然结束。</div>
            <RulesEditor rules={(c.rules as Rule[]) || []} onChange={(r) => set("rules", r)} />
          </>) : null}
          {node.type === "utility.transform" ? (<>
            <div><span className={lab}>作用对象（留空=作用于参数 arg）</span>
              <input className={`${inp} font-mono`} value={String(c.target || "")} onChange={(e) => set("target", e.target.value)} placeholder="变量名，留空则改参数" /></div>
            <div><span className={lab}>变换方式</span>
              <select className={inp} value={String(c.mode || "upper")} onChange={(e) => set("mode", e.target.value)}>
                <option value="upper">全部大写</option><option value="lower">全部小写</option><option value="title">首字母大写</option>
                <option value="trim">去掉首尾空白</option><option value="urlencode">URL 编码</option><option value="urldecode">URL 解码</option>
                <option value="base64encode">Base64 编码</option><option value="base64decode">Base64 解码</option>
              </select></div>
          </>) : null}
          {node.type === "utility.replace" ? (<>
            <div><span className={lab}>作用对象（留空=作用于参数 arg）</span>
              <input className={`${inp} font-mono`} value={String(c.target || "")} onChange={(e) => set("target", e.target.value)} placeholder="变量名，留空则改参数" /></div>
            <div><span className={lab}>查找</span><input className={`${inp} font-mono`} value={String(c.find || "")} onChange={(e) => set("find", e.target.value)} /></div>
            <div><span className={lab}>替换为</span><input className={`${inp} font-mono`} value={String(c.to || "")} onChange={(e) => set("to", e.target.value)} /></div>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={!!c.regex} onChange={(e) => set("regex", e.target.checked)} />按正则表达式</label>
              <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={!!c.ci} onChange={(e) => set("ci", e.target.checked)} />忽略大小写</label>
            </div>
          </>) : null}
          {node.type === "utility.delay" ? (
            <div><span className={lab}>延时秒数（上限 60 秒）</span>
              <input className={inp} type="number" min={0} max={60} step={0.5} value={Number(c.seconds ?? 1)} onChange={(e) => set("seconds", Number(e.target.value))} /></div>
          ) : null}
          {node.type === "action.ask_assistant" ? (<>
            <div><span className={lab}>发给秘书的内容（{"{query}"}=上游参数）</span>
              <textarea className={`${inp} h-[70px] resize-y`} value={String(c.prompt || "")} onChange={(e) => set("prompt", e.target.value)} placeholder="{query}" /></div>
            <div><span className={lab}>文本视图标题（可选）</span><input className={inp} value={String(c.title || "")} onChange={(e) => set("title", e.target.value)} placeholder="秘书" /></div>
            <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={c.show !== false} onChange={(e) => set("show", e.target.checked)} />打开文本视图展示（等待期间显示加载动画）</label>
            <div className="text-[11px] text-muted">秘书的回复会作为参数继续传给下游节点。</div>
          </>) : null}
          {node.type === "action.create_task" ? (<>
            <div><span className={lab}>任务内容（{"{query}"}=上游参数）</span>
              <textarea className={`${inp} h-[60px] resize-y`} value={String(c.text || "")} onChange={(e) => set("text", e.target.value)} placeholder="{query}" /></div>
            <div><span className={lab}>发给秘书时加的前缀</span><input className={inp} value={String(c.prefix ?? "")} onChange={(e) => set("prefix", e.target.value)} placeholder="帮我建个任务：" /></div>
            <div className="text-[11px] text-muted">说明：服务端目前没有独立的建任务接口，这里是「发给秘书 + 建任务前缀」的薄封装，真正建任务由秘书调工具完成。</div>
          </>) : null}
          {node.type === "action.device_skill" ? (<>
            <div><span className={lab}>设备 ID（留空=自动挑一台有该技能的在线设备）</span>
              <input className={`${inp} font-mono`} value={String(c.device || "")} onChange={(e) => set("device", e.target.value)} placeholder="留空自动选择" /></div>
            <div className="flex gap-1.5">
              <div className="flex-1"><span className={lab}>provider</span><input className={`${inp} font-mono`} value={String(c.provider || "")} onChange={(e) => set("provider", e.target.value)} placeholder="如 pc" /></div>
              <div className="flex-1"><span className={lab}>skill</span><input className={`${inp} font-mono`} value={String(c.skill || "")} onChange={(e) => set("skill", e.target.value)} placeholder="技能名" /></div>
            </div>
            <div><span className={lab}>参数（JSON，{"{query}"} / {"{var:名称}"} 会按 JSON 字符串转义后插入）</span>
              <textarea className={`${inp} font-mono h-[70px] resize-y`} value={String(c.params || "")} onChange={(e) => set("params", e.target.value)} placeholder={`{"text": "{query}"}`} /></div>
            <div className="text-[11px] text-muted">执行结果会作为参数继续传给下游节点；派发失败会中止这条链路。</div>
          </>) : null}
          {node.type === "output.textview" ? (<>
            <div><span className={lab}>标题（可选，留空用工作流名）</span><input className={inp} value={String(c.title || "")} onChange={(e) => set("title", e.target.value)} /></div>
            <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={c.markdown !== false} onChange={(e) => set("markdown", e.target.checked)} />按 Markdown 渲染</label>
            <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={!!c.append} onChange={(e) => set("append", e.target.checked)} />追加到已有内容（流式续写，不清屏）</label>
          </>) : null}
          {["action.copy", "action.paste", "action.assistant", "action.inspiration", "output.notify", "output.largetype"].includes(node.type) ? (
            <div className="text-[12px] text-muted">{node.type === "output.largetype" ? "大字显示：把上游内容放大居中显示在半透明浮层里。" : "此动作无需额外配置，直接使用上游传入的内容（arg）。"}</div>
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
