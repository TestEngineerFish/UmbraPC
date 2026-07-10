// 密码保险箱 界面（独立窗口）。解锁/初始化 → 身份切换 / 可编辑类型 / 列表搜索 / 模块化控件详情(查看/编辑) / 附件 / 密码生成器。
import { useCallback, useEffect, useRef, useState } from "react";

interface VaultInfo { id: string; name: string; owner: string; icon: string; order: number }
interface VType { id: string; name: string; icon: string; order: number }
interface Att { id: string; name: string; mime: string; size: number; addedAt: number }
interface Block { id: string; type: string; label?: string; data: Record<string, unknown> }
interface Item { id: string; typeId: string; title: string; icon?: string; favorite?: boolean; tags?: string[]; blocks: Block[]; attachments: Att[]; createdAt: number; updatedAt: number; revision: number }

interface VaultAPI {
  status(): Promise<{ exists: boolean; unlocked: boolean; autoLockMin: number }>;
  setup(mp: string): Promise<{ secretKey: string }>;
  unlock(mp: string, sk?: string): Promise<boolean>;
  lock(): Promise<boolean>;
  generatePassword(opts: unknown): Promise<string>;
  listVaults(): Promise<VaultInfo[]>;
  addVault(name: string, owner: string, icon: string): Promise<string>;
  listTypes(vid: string): Promise<VType[]>;
  addType(vid: string, name: string, icon: string): Promise<string>;
  updateType(vid: string, tid: string, patch: Partial<VType>): Promise<void>;
  deleteType(vid: string, tid: string): Promise<void>;
  listItems(vid: string): Promise<Item[]>;
  getItem(vid: string, iid: string): Promise<Item | null>;
  addItem(vid: string, init: Partial<Item>): Promise<string>;
  updateItem(vid: string, item: Item): Promise<void>;
  deleteItem(vid: string, iid: string): Promise<void>;
  moveItem(vid: string, iid: string, tid: string): Promise<void>;
  addAttachment(vid: string, iid: string, name: string, mime: string, dataB64: string): Promise<Att>;
  readAttachment(vid: string, aid: string): Promise<string>;
  deleteAttachment(vid: string, iid: string, aid: string): Promise<void>;
  search(q: string, vid?: string): Promise<{ vaultId: string; itemId: string }[]>;
}
const api = (window as unknown as { umbraVault: VaultAPI }).umbraVault;

const CTLS: [string, string, string][] = [["account", "账号", "🔑"], ["text", "文本", "📝"], ["secret", "密文", "🔒"], ["field", "字段", "🔤"], ["images", "图片", "🖼️"], ["files", "文件", "📎"]];
const CTL_LABEL: Record<string, string> = { account: "账号", text: "文本", secret: "密文", field: "字段", images: "图片", files: "文件" };
const rid = (p = "") => p + Math.random().toString(36).slice(2, 10);
function newBlock(type: string): Block {
  const data: Record<string, unknown> = type === "account" ? { username: "", password: "", url: "", otp: false }
    : type === "images" || type === "files" ? { atts: [] } : { value: "" };
  return { id: rid("b"), type, label: CTL_LABEL[type], data };
}

export function VaultApp() {
  const [ready, setReady] = useState(false);
  const [st, setSt] = useState<{ exists: boolean; unlocked: boolean; autoLockMin: number }>({ exists: false, unlocked: false, autoLockMin: 10 });
  useEffect(() => { void api.status().then((s) => { setSt(s); setReady(true); }); }, []);
  const refreshStatus = useCallback(async () => setSt(await api.status()), []);

  if (!ready) return <div className="h-screen bg-bg" />;
  if (!st.exists) return <Setup onDone={refreshStatus} />;
  if (!st.unlocked) return <Unlock onDone={refreshStatus} />;
  return <Main onLock={async () => { await api.lock(); await refreshStatus(); }} />;
}

// ── 初始化 ──
function Setup({ onDone }: { onDone: () => void }) {
  const [p1, setP1] = useState(""); const [p2, setP2] = useState(""); const [err, setErr] = useState("");
  const [sk, setSk] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (p1.length < 6) return setErr("主密码至少 6 位");
    if (p1 !== p2) return setErr("两次输入不一致");
    setBusy(true);
    try { const r = await api.setup(p1); setSk(r.secretKey); } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  if (sk) return (
    <Screen title="🔑 保存你的 Secret Key" sub="换新设备登录时需要它 + 主密码。请立即抄下/截图存好，它不会再次显示。">
      <div className="font-mono text-[17px] tracking-wide bg-bg border border-border rounded-xl px-5 py-4 select-all text-center">{sk}</div>
      <div className="text-[12px] text-muted mt-3">Secret Key 只存在本机安全区，不上传服务器；与主密码一起才能解密你的数据。</div>
      <button className="btn-primary mt-5" onClick={onDone}>我已保存，进入保险箱</button>
    </Screen>
  );
  return (
    <Screen title="🔐 创建主密码" sub="零知识加密：主密码只有你知道，忘记将无法恢复。">
      <input type="password" className="inp" placeholder="设置主密码（≥6 位）" value={p1} onChange={(e) => { setP1(e.target.value); setErr(""); }} />
      <input type="password" className="inp mt-2" placeholder="再输入一次" value={p2} onChange={(e) => { setP2(e.target.value); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && submit()} />
      {err ? <div className="text-danger text-[12.5px] mt-2">{err}</div> : null}
      <button className="btn-primary mt-4" disabled={busy} onClick={submit}>{busy ? "创建中…" : "创建保险箱"}</button>
      <Styles />
    </Screen>
  );
}

// ── 解锁 ──
function Unlock({ onDone }: { onDone: () => void }) {
  const [mp, setMp] = useState(""); const [sk, setSk] = useState(""); const [useSk, setUseSk] = useState(false);
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await api.unlock(mp, useSk ? sk : undefined); await onDone(); }
    catch (e) { setErr(String(e).replace("Error: ", "")); } finally { setBusy(false); }
  };
  return (
    <Screen title="🔐 解锁保险箱" sub="输入主密码">
      <input autoFocus type="password" className="inp" placeholder="主密码" value={mp} onChange={(e) => { setMp(e.target.value); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && submit()} />
      {useSk ? <input type="text" className="inp mt-2 font-mono" placeholder="Secret Key（U1-…）" value={sk} onChange={(e) => setSk(e.target.value)} /> : null}
      {err ? <div className="text-danger text-[12.5px] mt-2">{err}</div> : null}
      <button className="btn-primary mt-4" disabled={busy} onClick={submit}>{busy ? "解锁中…" : "解锁"}</button>
      <button className="text-[12px] text-muted mt-3" onClick={() => setUseSk((v) => !v)}>{useSk ? "← 本机解锁" : "换了新设备？输入 Secret Key"}</button>
      <Styles />
    </Screen>
  );
}

function Screen({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="h-screen flex flex-col items-center justify-center bg-bg text-text px-6">
      <div className="w-[360px] flex flex-col items-center text-center">
        <div className="text-[20px] font-semibold mb-1">{title}</div>
        {sub ? <div className="text-[12.5px] text-muted mb-5 leading-relaxed">{sub}</div> : null}
        <div className="w-full">{children}</div>
      </div>
      <Styles />
    </div>
  );
}
function Styles() {
  return <style>{`
    .inp{width:100%;border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:12px;padding:11px 14px;font-size:14px;outline:none;}
    .inp:focus{border-color:var(--orange);}
    .btn-primary{width:100%;background:var(--orange);color:#fff;border:none;border-radius:12px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;}
    .btn-primary:disabled{opacity:.6;}
  `}</style>;
}

// ── 主界面 ──
function Main({ onLock }: { onLock: () => void }) {
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const [vid, setVid] = useState("");
  const [types, setTypes] = useState<VType[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [cat, setCat] = useState("all");           // all/fav/<typeId>
  const [q, setQ] = useState("");
  const [selId, setSelId] = useState("");
  const [toast, setToast] = useState("");
  const [vmenu, setVmenu] = useState(false);
  const [editingType, setEditingType] = useState<string | null>(null);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(""), 1400); };

  useEffect(() => { void api.listVaults().then((v) => { setVaults(v); setVid(v[0]?.id || ""); }); }, []);
  const loadVault = useCallback(async (id: string) => {
    const [t, it] = await Promise.all([api.listTypes(id), api.listItems(id)]);
    setTypes(t); setItems(it);
  }, []);
  useEffect(() => { if (vid) void loadVault(vid); }, [vid, loadVault]);
  const refresh = useCallback(async () => { if (vid) await loadVault(vid); }, [vid, loadVault]);

  const cur = vaults.find((v) => v.id === vid);
  const searchText = (it: Item) => {
    const p = [it.title, ...(it.tags || [])];
    it.blocks.forEach((b) => { if (b.label) p.push(b.label); if (b.type === "account") p.push(String(b.data.username || ""), String(b.data.url || "")); if (b.type === "text" || b.type === "field") p.push(String(b.data.value || "")); });
    it.attachments.forEach((a) => p.push(a.name));
    return p.join(" ").toLowerCase();
  };
  const visible = items.filter((it) => (cat === "all" || (cat === "fav" ? it.favorite : it.typeId === cat)) && (!q || searchText(it).includes(q.toLowerCase())));
  const sel = items.find((i) => i.id === selId) || null;
  const typeName = (id: string) => { const t = types.find((x) => x.id === id); return t ? `${t.icon} ${t.name}` : "📁 未分类"; };

  const addRecord = async () => {
    const typeId = /^t/.test(cat) || types.find((t) => t.id === cat) ? cat : (types[0]?.id || "");
    const id = await api.addItem(vid, { typeId, title: "新记录", icon: "🔐", blocks: [newBlock("account")] });
    await refresh(); setSelId(id);
  };
  const counts: Record<string, number> = {};
  items.forEach((it) => { counts[it.typeId] = (counts[it.typeId] || 0) + 1; });

  return (
    <div className="h-screen flex flex-col bg-bg text-text">
      {/* 顶栏 */}
      <div className="h-[52px] flex items-center gap-3 px-4 border-b border-border bg-card">
        <span className="font-bold text-[14px] flex items-center gap-2"><span className="w-[22px] h-[22px] rounded-[7px] bg-orange text-white flex items-center justify-center text-[13px]">🔐</span>保险箱</span>
        <div className="relative">
          <button className="flex items-center gap-2 border border-border rounded-[10px] px-[10px] py-[5px] text-[13px] bg-bg" onClick={() => setVmenu((v) => !v)}>
            <span>{cur?.icon}</span><span className="font-semibold">{cur?.name}</span><span className="text-muted">▾</span>
          </button>
          {vmenu ? (
            <div className="absolute top-[38px] left-0 z-20 bg-card border border-border rounded-xl shadow-2xl p-1.5 min-w-[180px]" onMouseLeave={() => setVmenu(false)}>
              {vaults.map((v) => (
                <div key={v.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] cursor-pointer hover:bg-orange/10" onClick={() => { setVid(v.id); setVmenu(false); setSelId(""); setCat("all"); }}>
                  <span>{v.icon}</span>{v.name}
                </div>
              ))}
              <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] cursor-pointer text-orange" onClick={async () => { const id = await api.addVault("新身份库", "custom", "👤"); setVaults(await api.listVaults()); setVid(id); setVmenu(false); }}>＋ 新建身份库</div>
            </div>
          ) : null}
        </div>
        <div className="flex-1" />
        <button className="bg-orange text-white rounded-[9px] px-3.5 py-[7px] text-[12.5px] font-semibold" onClick={addRecord}>＋ 添加记录</button>
        <button className="border border-border bg-bg text-muted rounded-[9px] px-3 py-[6px] text-[12.5px]" onClick={onLock}>🔒 锁定</button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 左：类型 */}
        <div className="w-[196px] border-r border-border bg-card flex flex-col">
          <div className="flex-1 overflow-auto p-2">
            <TypeRow icon="🗂️" name="全部" n={items.length} on={cat === "all"} onClick={() => setCat("all")} />
            <TypeRow icon="⭐" name="收藏" n={items.filter((i) => i.favorite).length} on={cat === "fav"} onClick={() => setCat("fav")} />
            {types.map((t) => editingType === t.id ? (
              <div key={t.id} className="flex items-center gap-2 px-2.5 py-1.5"><span>{t.icon}</span>
                <input autoFocus defaultValue={t.name} className="border border-orange rounded-md px-2 py-0.5 text-[12.5px] w-[110px] outline-none"
                  onBlur={async (e) => { await api.updateType(vid, t.id, { name: e.target.value.trim() || t.name }); setEditingType(null); await refresh(); }}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
              </div>
            ) : (
              <div key={t.id} className={`group flex items-center gap-2 px-2.5 py-2 rounded-[9px] text-[13px] cursor-pointer ${cat === t.id ? "bg-orange/10 text-orange font-semibold" : ""}`} onClick={() => setCat(t.id)}>
                <span>{t.icon}</span><span className="flex-1 truncate">{t.name}</span>
                <span className="text-muted text-[11px] group-hover:hidden">{counts[t.id] || ""}</span>
                <span className="hidden group-hover:flex gap-1">
                  <button className="text-muted text-[11px]" title="改名" onClick={(e) => { e.stopPropagation(); setEditingType(t.id); }}>✎</button>
                  <button className="text-danger text-[11px]" title="删除" onClick={async (e) => { e.stopPropagation(); await api.deleteType(vid, t.id); if (cat === t.id) setCat("all"); await refresh(); }}>🗑</button>
                </span>
              </div>
            ))}
          </div>
          <button className="m-2 py-2 rounded-[9px] border border-dashed border-border text-muted text-[12.5px]" onClick={async () => { const id = await api.addType(vid, "新类型", "📁"); await refresh(); setEditingType(id); }}>＋ 新建类型</button>
        </div>

        {/* 中：列表 */}
        <div className="w-[290px] border-r border-border flex flex-col">
          <div className="p-2.5 border-b border-border"><input className="w-full border border-border rounded-[10px] px-3 py-2 text-[13px] bg-bg outline-none" placeholder="搜索名称/账号/网址/文本…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="flex-1 overflow-auto">
            {visible.length ? visible.map((it) => {
              const acc = it.blocks.find((b) => b.type === "account");
              const sub = acc ? String(acc.data.username || "") : typeName(it.typeId);
              return (
                <div key={it.id} className={`flex items-center gap-3 px-3.5 py-2.5 cursor-pointer border-b border-border/60 ${it.id === selId ? "bg-orange/10" : ""}`} onClick={() => setSelId(it.id)}>
                  <span className="w-[34px] h-[34px] rounded-[9px] bg-bg flex items-center justify-center text-[18px]">{it.icon || "🔐"}</span>
                  <div className="min-w-0"><div className="text-[13.5px] font-semibold truncate">{it.title}</div><div className="text-[11.5px] text-muted truncate">{sub}</div></div>
                  {it.favorite ? <span className="ml-auto text-[#e0a83a]">⭐</span> : null}
                </div>
              );
            }) : <div className="text-muted text-[13px] text-center p-10">没有匹配的记录</div>}
          </div>
        </div>

        {/* 右：详情 */}
        <div className="flex-1 overflow-auto">
          {sel ? <Detail key={sel.id} vid={vid} item={sel} types={types} typeName={typeName} onChange={refresh} flash={flash} /> : <div className="text-muted text-[13px] text-center p-16">选择或新建一条记录</div>}
        </div>
      </div>
      {toast ? <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-[#17130f] text-white text-[12.5px] px-4 py-2 rounded-full">{toast}</div> : null}
    </div>
  );
}

function TypeRow({ icon, name, n, on, onClick }: { icon: string; name: string; n: number; on: boolean; onClick: () => void }) {
  return <div className={`flex items-center gap-2 px-2.5 py-2 rounded-[9px] text-[13px] cursor-pointer ${on ? "bg-orange/10 text-orange font-semibold" : ""}`} onClick={onClick}><span>{icon}</span><span className="flex-1">{name}</span><span className="text-muted text-[11px]">{n || ""}</span></div>;
}

// ── 详情（查看 / 编辑）──
function Detail({ vid, item, types, typeName, onChange, flash }: { vid: string; item: Item; types: VType[]; typeName: (id: string) => string; onChange: () => Promise<void>; flash: (m: string) => void }) {
  const [edit, setEdit] = useState(item.title === "新记录");
  const [draft, setDraft] = useState<Item>(structuredClone(item));
  const [move, setMove] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  useEffect(() => { setDraft(structuredClone(item)); setEdit(item.title === "新记录"); }, [item]);

  const save = async () => { await api.updateItem(vid, draft); setEdit(false); await onChange(); flash("已保存 ✓"); };
  const del = async () => { await api.deleteItem(vid, item.id); await onChange(); };
  const fav = async () => { const d = { ...item, favorite: !item.favorite }; await api.updateItem(vid, d); await onChange(); };
  const doMove = async (tid: string) => { await api.moveItem(vid, item.id, tid); setMove(false); await onChange(); flash("已移动"); };
  const setBlock = (bid: string, patch: Partial<Block>) => setDraft((d) => ({ ...d, blocks: d.blocks.map((b) => (b.id === bid ? { ...b, ...patch } : b)) }));
  const setData = (bid: string, k: string, v: unknown) => setDraft((d) => ({ ...d, blocks: d.blocks.map((b) => (b.id === bid ? { ...b, data: { ...b.data, [k]: v } } : b)) }));
  const delBlock = (bid: string) => setDraft((d) => ({ ...d, blocks: d.blocks.filter((b) => b.id !== bid) }));
  const moveBlock = (i: number, dir: -1 | 1) => setDraft((d) => { const b = d.blocks.slice(); const j = i + dir; if (j < 0 || j >= b.length) return d; [b[i], b[j]] = [b[j], b[i]]; return { ...d, blocks: b }; });
  const addBlock = (type: string) => { setDraft((d) => ({ ...d, blocks: [...d.blocks, newBlock(type)] })); setAddMenu(false); };

  const model = edit ? draft : item;
  return (
    <div className="p-5 max-w-[720px]">
      <div className="flex items-center gap-3 mb-1">
        {edit ? <input className="w-[46px] text-center border border-border rounded-lg py-1.5 text-[22px] bg-bg" maxLength={2} value={draft.icon || ""} onChange={(e) => setDraft({ ...draft, icon: e.target.value })} />
          : <span className="w-[50px] h-[50px] rounded-[14px] bg-orange/10 flex items-center justify-center text-[25px]">{item.icon || "🔐"}</span>}
        <div className="flex-1">
          {edit ? <input className="w-full text-[18px] font-semibold border border-border rounded-lg px-2 py-1 bg-bg" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            : <div className="text-[19px] font-semibold">{item.title}</div>}
          <div className="text-[12px] text-muted mt-1 flex items-center gap-2 relative">
            {typeName(item.typeId)}
            <button className="border border-border rounded-md px-1.5 py-0.5 text-[11px]" onClick={() => setMove((m) => !m)}>移动到…</button>
            {move ? <div className="absolute top-6 left-16 z-20 bg-card border border-border rounded-lg shadow-xl p-1 min-w-[140px]">{types.map((t) => <div key={t.id} className="px-2.5 py-1.5 rounded-md text-[12.5px] cursor-pointer hover:bg-orange/10" onClick={() => doMove(t.id)}>{t.icon} {t.name}</div>)}</div> : null}
          </div>
        </div>
        <button className="text-[16px]" title="收藏" onClick={fav}>{item.favorite ? "⭐" : "☆"}</button>
        {edit ? <button className="bg-orange text-white rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold" onClick={save}>保存</button>
          : <button className="border border-border rounded-lg px-3.5 py-1.5 text-[12.5px]" onClick={() => setEdit(true)}>✏️ 编辑</button>}
      </div>

      <div className="mt-4">
        {model.blocks.map((b, i) => <BlockCard key={b.id} vid={vid} itemId={item.id} block={b} edit={edit} idx={i} count={model.blocks.length}
          onLabel={(v) => setBlock(b.id, { label: v })} onData={(k, v) => setData(b.id, k, v)} onDel={() => delBlock(b.id)} onMove={(dir) => moveBlock(i, dir)}
          onAttAdded={(att) => { setData(b.id, "atts", [...((b.data.atts as string[]) || []), att.id]); }} flash={flash} />)}
      </div>

      {edit ? (
        <div className="relative">
          <div className="mt-2 border border-dashed border-border rounded-xl p-3 text-center text-muted text-[12.5px] cursor-pointer" onClick={() => setAddMenu((m) => !m)}>＋ 添加控件（账号 / 文本 / 密文 / 字段 / 图片 / 文件）</div>
          {addMenu ? <div className="absolute z-20 bg-card border border-border rounded-lg shadow-xl p-1 mt-1 flex flex-wrap gap-1 w-full">{CTLS.map((c) => <button key={c[0]} className="px-2.5 py-1.5 rounded-md text-[12.5px] hover:bg-orange/10" onClick={() => addBlock(c[0])}>{c[2]} {c[1]}</button>)}</div> : null}
        </div>
      ) : null}

      <div className="text-[11.5px] text-muted mt-5 flex items-center gap-3">
        <span>🔒 整条已 AES-256-GCM 加密 · 密码/密文不进搜索</span>
        {edit ? <button className="text-danger ml-auto" onClick={del}>删除记录</button> : null}
      </div>
    </div>
  );
}

// ── 单个控件卡片 ──
function BlockCard({ vid, itemId, block, edit, idx, count, onLabel, onData, onDel, onMove, onAttAdded, flash }: {
  vid: string; itemId: string; block: Block; edit: boolean; idx: number; count: number;
  onLabel: (v: string) => void; onData: (k: string, v: unknown) => void; onDel: () => void; onMove: (dir: -1 | 1) => void; onAttAdded: (att: Att) => void; flash: (m: string) => void;
}) {
  const [reveal, setReveal] = useState(false);
  const copy = (v: string) => { void navigator.clipboard?.writeText(v); flash("已复制 · 注意剪贴板安全"); };
  const gen = async (k: string) => { const p = await api.generatePassword({ length: 20 }); onData(k, p); flash("已生成强密码"); };
  const d = block.data;

  const head = (
    <div className="flex items-center gap-2 px-3.5 py-2 border-b border-border/70 bg-bg/40">
      <span className="text-[11px] text-orange bg-orange/10 rounded-md px-2 py-0.5 font-semibold">{CTL_LABEL[block.type] || block.type}</span>
      {edit ? <input className="text-[12.5px] font-semibold bg-transparent border-b border-transparent focus:border-orange outline-none" value={block.label || ""} onChange={(e) => onLabel(e.target.value)} placeholder="标签" />
        : <span className="text-[12.5px] font-semibold">{block.label}</span>}
      {edit ? <span className="ml-auto flex gap-1.5 text-muted">
        <button disabled={idx === 0} onClick={() => onMove(-1)} className="disabled:opacity-30">↑</button>
        <button disabled={idx === count - 1} onClick={() => onMove(1)} className="disabled:opacity-30">↓</button>
        <button className="text-danger" onClick={onDel}>🗑</button>
      </span> : null}
    </div>
  );

  return (
    <div className="border border-border rounded-[14px] bg-card mb-3 overflow-hidden">
      {head}
      <div className="p-3.5">
        {block.type === "account" ? (
          <div className="flex flex-col gap-0.5">
            <KV k="用户名" edit={edit} val={String(d.username || "")} onCh={(v) => onData("username", v)} onCopy={() => copy(String(d.username || ""))} />
            <KVpass k="密码" edit={edit} reveal={reveal} setReveal={setReveal} val={String(d.password || "")} onCh={(v) => onData("password", v)} onCopy={() => copy(String(d.password || ""))} onGen={() => gen("password")} />
            <KV k="网址" edit={edit} val={String(d.url || "")} onCh={(v) => onData("url", v)} onCopy={() => copy(String(d.url || ""))} />
            {edit ? <label className="flex items-center gap-2 text-[12px] text-muted mt-1"><input type="checkbox" checked={!!d.otp} onChange={(e) => onData("otp", e.target.checked)} />含两步验证 (2FA)</label> : null}
          </div>
        ) : null}
        {block.type === "secret" ? <KVpass k="" edit={edit} reveal={reveal} setReveal={setReveal} val={String(d.value || "")} onCh={(v) => onData("value", v)} onCopy={() => copy(String(d.value || ""))} onGen={() => gen("value")} /> : null}
        {block.type === "text" ? (edit ? <textarea className="w-full border border-border rounded-lg p-2 text-[13px] bg-bg h-[70px] resize-y" value={String(d.value || "")} onChange={(e) => onData("value", e.target.value)} /> : <div className="text-[13.5px] whitespace-pre-wrap leading-relaxed">{String(d.value || "")}</div>) : null}
        {block.type === "field" ? <KV k="" edit={edit} mono={false} val={String(d.value || "")} onCh={(v) => onData("value", v)} onCopy={() => copy(String(d.value || ""))} /> : null}
        {block.type === "images" ? <Gallery vid={vid} itemId={itemId} atts={(d.atts as string[]) || []} edit={edit} kind="image" onAttAdded={onAttAdded} onRemove={(aid) => onData("atts", ((d.atts as string[]) || []).filter((x) => x !== aid))} /> : null}
        {block.type === "files" ? <Gallery vid={vid} itemId={itemId} atts={(d.atts as string[]) || []} edit={edit} kind="file" onAttAdded={onAttAdded} onRemove={(aid) => onData("atts", ((d.atts as string[]) || []).filter((x) => x !== aid))} /> : null}
      </div>
    </div>
  );
}

function KV({ k, val, edit, mono = true, onCh, onCopy }: { k: string; val: string; edit: boolean; mono?: boolean; onCh: (v: string) => void; onCopy: () => void }) {
  if (edit) return <div className="flex items-center gap-2 py-1">{k ? <span className="w-[56px] text-[12px] text-muted">{k}</span> : null}<input className={`flex-1 border border-border rounded-md px-2 py-1 text-[13px] bg-bg ${mono ? "font-mono" : ""}`} value={val} onChange={(e) => onCh(e.target.value)} /></div>;
  if (!val) return null;
  return <div className="flex items-center gap-2 py-1.5 border-b border-border/40 last:border-0">{k ? <span className="w-[56px] text-[12px] text-muted">{k}</span> : null}<span className={`flex-1 text-[14px] truncate ${mono ? "font-mono" : ""}`}>{val}</span><button className="text-muted hover:text-orange" onClick={onCopy}>📋</button></div>;
}
function KVpass({ k, val, edit, reveal, setReveal, onCh, onCopy, onGen }: { k: string; val: string; edit: boolean; reveal: boolean; setReveal: (v: boolean) => void; onCh: (v: string) => void; onCopy: () => void; onGen: () => void }) {
  if (edit) return <div className="flex items-center gap-2 py-1">{k ? <span className="w-[56px] text-[12px] text-muted">{k}</span> : null}<input className="flex-1 border border-border rounded-md px-2 py-1 text-[13px] bg-bg font-mono" value={val} onChange={(e) => onCh(e.target.value)} /><button className="text-muted hover:text-orange text-[13px]" title="生成强密码" onClick={onGen}>🎲</button></div>;
  return <div className="flex items-center gap-2 py-1.5">{k ? <span className="w-[56px] text-[12px] text-muted">{k}</span> : null}<span className="flex-1 text-[14px] font-mono">{reveal ? val : "•".repeat(Math.min(12, val.length || 8))}</span><button className="text-muted hover:text-orange" onClick={() => setReveal(!reveal)}>{reveal ? "🙈" : "👁"}</button><button className="text-muted hover:text-orange" onClick={onCopy}>📋</button></div>;
}

// ── 图片/文件画廊 ──
function Gallery({ vid, itemId, atts, edit, kind, onAttAdded, onRemove }: { vid: string; itemId: string; atts: string[]; edit: boolean; kind: "image" | "file"; onAttAdded: (att: Att) => void; onRemove: (aid: string) => void }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [metas, setMetas] = useState<Record<string, Att>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    atts.forEach((aid) => {
      if (kind === "image" && !urls[aid]) void api.readAttachment(vid, aid).then((u) => setUrls((m) => ({ ...m, [aid]: u }))).catch(() => {});
    });
  }, [atts, kind, vid, urls]);
  const pick = () => fileRef.current?.click();
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      const buf = await f.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const att = await api.addAttachment(vid, itemId, f.name, f.type || "application/octet-stream", b64);
      setMetas((m) => ({ ...m, [att.id]: att }));
      onAttAdded(att);
    }
    e.target.value = "";
  };
  return (
    <div className="flex flex-wrap gap-2.5">
      {atts.map((aid) => kind === "image" ? (
        <div key={aid} className="relative w-[120px] h-[80px] rounded-[10px] overflow-hidden bg-bg border border-border flex items-center justify-center">
          {urls[aid] ? <img src={urls[aid]} className="w-full h-full object-cover cursor-pointer" onClick={() => urls[aid] && window.open(urls[aid])} alt="" /> : <span className="text-muted text-[11px]">解密中…</span>}
          {edit ? <button className="absolute top-1 right-1 bg-black/60 text-white rounded-full w-5 h-5 text-[11px]" onClick={() => onRemove(aid)}>✕</button> : null}
        </div>
      ) : (
        <div key={aid} className="flex items-center gap-2 border border-border rounded-lg px-2.5 py-1.5 text-[12.5px] bg-bg">
          <span>📄</span><span className="max-w-[160px] truncate">{metas[aid]?.name || "文件"}</span>
          <button className="text-muted hover:text-orange" title="导出" onClick={async () => { const u = await api.readAttachment(vid, aid); window.open(u); }}>⬇️</button>
          {edit ? <button className="text-danger" onClick={() => onRemove(aid)}>✕</button> : null}
        </div>
      ))}
      {edit ? <>
        <div className="w-[120px] h-[80px] rounded-[10px] border border-dashed border-border flex flex-col items-center justify-center text-muted text-[12px] cursor-pointer" onClick={pick}>＋<span className="text-[11px]">{kind === "image" ? "添加图片" : "添加文件"}</span></div>
        <input ref={fileRef} type="file" multiple accept={kind === "image" ? "image/*" : "*"} className="hidden" onChange={onFile} />
      </> : (atts.length === 0 ? <span className="text-muted text-[12px]">（空）</span> : null)}
    </div>
  );
}
