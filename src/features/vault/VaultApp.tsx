// 密码保险箱 界面（独立窗口）。视觉按 ClaudeDesign 稿；数据/IPC 走真实后端。
// 初始化/解锁 → 身份切换 / 可编辑类型(右键菜单) / 列表搜索 / 模块化控件详情(查看/编辑) / 附件 / 密码生成器 / 深浅色切换。
import { CSSProperties, useCallback, useEffect, useRef, useState } from "react";

interface VaultInfo { id: string; name: string; owner: string; icon: string; order: number }
interface VType { id: string; name: string; icon: string; order: number }
interface Att { id: string; name: string; mime: string; size: number; addedAt: number }
interface Block { id: string; type: string; label?: string; data: Record<string, unknown> }
interface Item { id: string; typeId: string; title: string; icon?: string; favorite?: boolean; tags?: string[]; blocks: Block[]; attachments: Att[]; createdAt: number; updatedAt: number; revision: number }

interface VStatus { exists: boolean; unlocked: boolean; autoLockMin: number; quickUnlock: boolean; biometric: boolean; shortcut: string }
interface VaultAPI {
  status(): Promise<VStatus>;
  setup(mp: string): Promise<{ secretKey: string }>;
  unlock(mp: string, sk?: string): Promise<boolean>;
  quickUnlock(): Promise<boolean>;
  biometricAvailable(): Promise<boolean>;
  enableQuickUnlock(): Promise<boolean>;
  disableQuickUnlock(): Promise<boolean>;
  lock(): Promise<boolean>;
  copy(text: string): Promise<void>;
  exportBackup(): Promise<{ ok: boolean; path?: string }>;
  exportPlain(): Promise<{ ok: boolean; path?: string }>;
  importPick(): Promise<{ ok: boolean; needPassword: boolean }>;
  importApply(mp?: string, sk?: string): Promise<{ ok: boolean; added: number }>;
  generatePassword(opts: unknown): Promise<string>;
  listVaults(): Promise<VaultInfo[]>;
  addVault(name: string, owner: string, icon: string): Promise<string>;
  listTypes(vid: string): Promise<VType[]>;
  addType(vid: string, name: string, icon: string): Promise<string>;
  updateType(vid: string, tid: string, patch: Partial<VType>): Promise<void>;
  deleteType(vid: string, tid: string): Promise<void>;
  listItems(vid: string): Promise<Item[]>;
  addItem(vid: string, init: Partial<Item>): Promise<string>;
  updateItem(vid: string, item: Item): Promise<void>;
  deleteItem(vid: string, iid: string): Promise<void>;
  moveItem(vid: string, iid: string, tid: string): Promise<void>;
  addAttachment(vid: string, iid: string, name: string, mime: string, dataB64: string): Promise<Att>;
  readAttachment(vid: string, aid: string): Promise<string>;
  deleteAttachment(vid: string, iid: string, aid: string): Promise<void>;
}
const api = (window as unknown as { umbraVault: VaultAPI }).umbraVault;

const CTLS: [string, string, string][] = [["account", "账号", "👤"], ["secret", "密文", "🔑"], ["field", "字段", "🏷️"], ["text", "文本", "📝"], ["images", "图片", "🖼️"], ["files", "文件", "📎"]];
const TAG: Record<string, string> = { account: "账号", secret: "密文", text: "文本", field: "字段", images: "图片", files: "文件" };
const rid = (p = "") => p + Math.random().toString(36).slice(2, 10);
function newBlock(type: string): Block {
  const data: Record<string, unknown> = type === "account" ? { username: "", password: "", url: "", otp: false }
    : type === "images" || type === "files" ? { atts: [] } : { value: "" };
  return { id: rid("b"), type, label: TAG[type], data };
}

const CSS = `
@keyframes vToastIn{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes vPop{from{opacity:0;transform:translateY(-4px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes vLockPulse{0%,100%{transform:scale(1);box-shadow:0 0 0 0 rgba(232,89,12,.28)}50%{transform:scale(1.03);box-shadow:0 0 0 14px rgba(232,89,12,0)}}
@keyframes vDetailIn{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
@keyframes vBlockIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.v-root ::selection{background:rgba(232,89,12,.22)}
.v-root a{color:var(--orange-text);text-decoration:none}
.v-ho:hover{background:var(--orange-soft);color:var(--orange)}
.v-row:hover{background:var(--orange-soft)}
.v-item:hover{background:var(--orange-soft);transform:translateX(2px)}
.v-card:hover{box-shadow:0 6px 22px rgba(0,0,0,.09);transform:translateY(-1px)}
.v-btn:hover{filter:brightness(1.06)}
.v-lock:hover{border-color:var(--orange);color:var(--orange)}
.v-dash:hover{border-color:var(--orange);color:var(--orange)}
.v-inp:focus{border-color:var(--orange)}
.v-danger:hover{background:color-mix(in srgb,var(--danger) 14%,transparent)}
.v-scale:hover{transform:scale(1.2)}
`;

export function VaultApp() {
  const [theme, setTheme] = useState(() => (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const [ready, setReady] = useState(false);
  const [st, setSt] = useState<VStatus>({ exists: false, unlocked: false, autoLockMin: 10, quickUnlock: false, biometric: false, shortcut: "" });
  useEffect(() => { void api.status().then((s) => { setSt(s); setReady(true); }); }, []);
  const refresh = useCallback(async () => setSt(await api.status()), []);
  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  return (
    <div className="v-root" data-theme={theme} style={{ height: "100vh", background: "var(--bg)", color: "var(--text)", fontSize: 14, fontFamily: '-apple-system,"SF Pro Text",system-ui,"Segoe UI",Roboto,sans-serif' }}>
      <style>{CSS}</style>
      {!ready ? null : !st.exists ? <Setup onDone={refresh} theme={theme} onTheme={toggleTheme} />
        : !st.unlocked ? <Unlock onDone={refresh} st={st} theme={theme} onTheme={toggleTheme} />
          : <Main onLock={async () => { await api.lock(); await refresh(); }} st={st} onStatus={refresh} theme={theme} onTheme={toggleTheme} />}
    </div>
  );
}

function ThemeBtn({ theme, onTheme, style }: { theme: string; onTheme: () => void; style?: CSSProperties }) {
  return <button className="v-ho" onClick={onTheme} title="切换深浅色" style={{ border: "1px solid var(--border)", background: "var(--bg)", borderRadius: 8, width: 28, height: 24, fontSize: 13, cursor: "pointer", color: "var(--text)", ...style }}>{theme === "dark" ? "☀️" : "🌙"}</button>;
}

// ── 初始化 ──
function Setup({ onDone, theme, onTheme }: { onDone: () => void; theme: string; onTheme: () => void }) {
  const [p1, setP1] = useState(""); const [p2, setP2] = useState(""); const [err, setErr] = useState("");
  const [sk, setSk] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (p1.length < 6) return setErr("主密码至少 6 位");
    if (p1 !== p2) return setErr("两次输入不一致");
    setBusy(true);
    try { const r = await api.setup(p1); setSk(r.secretKey); } catch (e) { setErr(String(e).replace("Error: ", "")); } finally { setBusy(false); }
  };
  const inp: CSSProperties = { width: "100%", border: "1px solid var(--border)", background: "var(--card)", borderRadius: 12, padding: "12px 14px", fontSize: 15, color: "var(--text)", outline: "none" };
  return (
    <Center theme={theme} onTheme={onTheme}>
      {sk ? (
        <div style={{ width: 380, textAlign: "center", animation: "vDetailIn .4s ease" }}>
          <div style={pulseIcon}>🔑</div>
          <h1 style={h1}>保存你的 Secret Key</h1>
          <p style={sub}>换新设备登录时需要它 + 主密码。请立即抄下/截图存好，它不会再次显示。</p>
          <div style={{ marginTop: 18, fontFamily: "ui-monospace,Menlo,monospace", fontSize: 17, letterSpacing: ".06em", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 14px", userSelect: "all" }}>{sk}</div>
          <div style={{ ...sub, marginTop: 12 }}>只存本机安全区，不上传服务器；与主密码一起才能解密数据。</div>
          <button className="v-btn" style={{ ...btnPrimary, marginTop: 20 }} onClick={onDone}>我已保存，进入保险箱</button>
        </div>
      ) : (
        <div style={{ width: 360, textAlign: "center", animation: "vDetailIn .4s ease" }}>
          <div style={pulseIcon}>🔐</div>
          <h1 style={h1}>创建主密码</h1>
          <p style={sub}>零知识加密：主密码只有你知道，忘记将无法恢复。</p>
          <input className="v-inp" type="password" style={{ ...inp, marginTop: 22 }} placeholder="设置主密码（≥6 位）" value={p1} onChange={(e) => { setP1(e.target.value); setErr(""); }} />
          <input className="v-inp" type="password" style={{ ...inp, marginTop: 10 }} placeholder="再输入一次" value={p2} onChange={(e) => { setP2(e.target.value); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && submit()} />
          {err ? <div style={errStyle}>{err}</div> : null}
          <button className="v-btn" disabled={busy} style={{ ...btnPrimary, marginTop: 14, opacity: busy ? .6 : 1 }} onClick={submit}>{busy ? "创建中…" : "创建保险箱"}</button>
        </div>
      )}
    </Center>
  );
}

// ── 解锁 ──
function Unlock({ onDone, st, theme, onTheme }: { onDone: () => void; st: VStatus; theme: string; onTheme: () => void }) {
  const [mp, setMp] = useState(""); const [sk, setSk] = useState(""); const [useSk, setUseSk] = useState(false);
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const canBio = st.quickUnlock && st.biometric;
  const submit = async () => { setBusy(true); try { await api.unlock(mp, useSk ? sk : undefined); await onDone(); } catch (e) { setErr(String(e).replace("Error: ", "")); } finally { setBusy(false); } };
  const touchId = async () => { setErr(""); try { await api.quickUnlock(); await onDone(); } catch (e) { setErr(String(e).replace("Error: ", "") || "Touch ID 未通过"); } };
  useEffect(() => { if (canBio) void touchId(); /* 进入即尝试 Touch ID */ }, []); // eslint-disable-line
  const inp: CSSProperties = { width: "100%", border: "1px solid var(--border)", background: "var(--card)", borderRadius: 12, padding: "12px 14px", fontSize: 15, color: "var(--text)", outline: "none", textAlign: "center", letterSpacing: ".12em", fontFamily: "ui-monospace,Menlo,monospace" };
  return (
    <Center theme={theme} onTheme={onTheme}>
      <div style={{ width: 360, textAlign: "center", animation: "vDetailIn .4s ease" }}>
        <div style={{ ...pulseIcon, animation: "vLockPulse 2.6s ease-in-out infinite" }}>🔐</div>
        <h1 style={h1}>保险箱已锁定</h1>
        <p style={sub}>输入主密码以解锁本地加密数据<br />主密码不保存、不上传，忘记无法找回</p>
        <input className="v-inp" autoFocus type="password" style={{ ...inp, marginTop: 22 }} placeholder="主密码" value={mp} onChange={(e) => { setMp(e.target.value); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && submit()} />
        {useSk ? <input className="v-inp" type="text" style={{ ...inp, marginTop: 10, letterSpacing: ".04em" }} placeholder="Secret Key（U1-…）" value={sk} onChange={(e) => setSk(e.target.value)} /> : null}
        {err ? <div style={errStyle}>{err}</div> : null}
        <button className="v-btn" disabled={busy} style={{ ...btnPrimary, marginTop: 12, opacity: busy ? .6 : 1 }} onClick={submit}>{busy ? "解锁中…" : "解锁保险箱"}</button>
        {canBio ? <button className="v-lock" style={{ marginTop: 10, width: "100%", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", borderRadius: 12, padding: 11, fontSize: 13.5, fontWeight: 600, cursor: "pointer" }} onClick={touchId}>☝️ 使用 Touch ID 解锁</button> : null}
        <button style={{ marginTop: 16, background: "none", border: "none", color: "var(--muted)", fontSize: 11.5, cursor: "pointer" }} onClick={() => setUseSk((v) => !v)}>{useSk ? "← 本机解锁" : "换了新设备？输入 Secret Key"}</button>
        <div style={{ marginTop: 20, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, fontSize: 11.5, color: "var(--muted)" }}><span style={{ color: "var(--success)" }}>🔒</span> 数据以 AES-256-GCM 本地加密 · 永不上传云端</div>
      </div>
    </Center>
  );
}

function Center({ theme, onTheme, children }: { theme: string; onTheme: () => void; children: React.ReactNode }) {
  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", position: "relative", background: "radial-gradient(90% 70% at 50% 8%, color-mix(in srgb, var(--orange-soft) 60%, var(--bg)) 0%, var(--bg) 60%)" }}>
      <ThemeBtn theme={theme} onTheme={onTheme} style={{ position: "absolute", top: 14, right: 14 }} />
      {children}
    </div>
  );
}

const pulseIcon: CSSProperties = { width: 76, height: 76, borderRadius: 22, background: "var(--orange-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 36, margin: "0 auto" };
const h1: CSSProperties = { margin: "22px 0 0", fontSize: 20, fontWeight: 600, letterSpacing: "-.01em" };
const sub: CSSProperties = { margin: "8px 0 0", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 };
const btnPrimary: CSSProperties = { width: "100%", background: "var(--orange)", color: "#fff", border: "none", borderRadius: 12, padding: 12, fontSize: 14, fontWeight: 600, cursor: "pointer" };
const errStyle: CSSProperties = { color: "var(--danger)", fontSize: 12.5, marginTop: 10 };

// ── 主界面 ──
type Ctx = { open: boolean; x: number; y: number; itemId?: string };
type TCtx = { open: boolean; x: number; y: number; typeId?: string };

function Main({ onLock, st, onStatus, theme, onTheme }: { onLock: () => void; st: VStatus; onStatus: () => Promise<void>; theme: string; onTheme: () => void }) {
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const [vid, setVid] = useState("");
  const [types, setTypes] = useState<VType[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  const [selId, setSelId] = useState("");
  const [autoEditId, setAutoEditId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [idOpen, setIdOpen] = useState(false);
  const [gearOpen, setGearOpen] = useState(false);
  const [imp, setImp] = useState<{ open: boolean; mp: string; sk: string; err: string }>({ open: false, mp: "", sk: "", err: "" });
  const [ctx, setCtx] = useState<Ctx>({ open: false, x: 0, y: 0 });
  const [tctx, setTctx] = useState<TCtx>({ open: false, x: 0, y: 0 });
  const [renaming, setRenaming] = useState<string | null>(null);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(""), 1400); };

  useEffect(() => { void api.listVaults().then((v) => { setVaults(v); setVid(v[0]?.id || ""); }); }, []);
  const loadVault = useCallback(async (id: string) => { const [t, it] = await Promise.all([api.listTypes(id), api.listItems(id)]); setTypes(t); setItems(it); }, []);
  useEffect(() => { if (vid) void loadVault(vid); }, [vid, loadVault]);
  const refresh = useCallback(async () => { if (vid) await loadVault(vid); }, [vid, loadVault]);
  const closeMenus = () => { setIdOpen(false); setGearOpen(false); setCtx({ open: false, x: 0, y: 0 }); setTctx({ open: false, x: 0, y: 0 }); };
  const doExport = async (plain: boolean) => { setGearOpen(false); const r = plain ? await api.exportPlain() : await api.exportBackup(); if (r.ok) flash(plain ? "已导出明文 JSON" : "已导出加密备份 ✓"); };
  const doImport = async () => { setGearOpen(false); const r = await api.importPick(); if (!r.ok) return; if (r.needPassword) setImp({ open: true, mp: "", sk: "", err: "" }); else { const a = await api.importApply(); setVaults(await api.listVaults()); await refresh(); flash(`已导入 ${a.added} 个身份库`); } };
  const applyImport = async () => { try { const a = await api.importApply(imp.mp, imp.sk || undefined); setImp({ open: false, mp: "", sk: "", err: "" }); setVaults(await api.listVaults()); await refresh(); flash(`已导入 ${a.added} 个身份库`); } catch (e) { setImp((s) => ({ ...s, err: String(e).replace("Error: ", "") })); } };

  const cur = vaults.find((v) => v.id === vid);
  const searchText = (it: Item) => {
    const p = [it.title, ...(it.tags || [])];
    it.blocks.forEach((b) => { if (b.label) p.push(b.label); if (b.type === "account") p.push(String(b.data.username || ""), String(b.data.url || "")); if (b.type === "text" || b.type === "field") p.push(String(b.data.value || "")); });
    it.attachments.forEach((a) => p.push(a.name));
    return p.join(" ").toLowerCase();
  };
  const visible = items.filter((it) => (cat === "all" || (cat === "fav" ? it.favorite : it.typeId === cat)) && (!q || searchText(it).includes(q.toLowerCase())));
  const sel = items.find((i) => i.id === selId) || null;
  const typeName = (id: string) => { const t = types.find((x) => x.id === id); return t?.name || "未分类"; };
  const typeIcon = (id: string) => { const t = types.find((x) => x.id === id); return t?.icon || "📄"; };
  const counts: Record<string, number> = {}; items.forEach((it) => { counts[it.typeId] = (counts[it.typeId] || 0) + 1; });

  const selectItem = (id: string) => { setSelId(id); setAutoEditId(null); closeMenus(); };
  const addRecord = async () => {
    const typeId = types.find((t) => t.id === cat) ? cat : (types[0]?.id || "");
    const id = await api.addItem(vid, { typeId, title: "新记录", icon: "🔐", blocks: [newBlock("account")] });
    await refresh(); setSelId(id); setAutoEditId(id);
  };
  const toggleFav = async (it: Item) => { await api.updateItem(vid, { ...it, favorite: !it.favorite }); await refresh(); };
  const doMove = async (iid: string, tid: string) => { await api.moveItem(vid, iid, tid); closeMenus(); await refresh(); flash(`已移动到「${typeName(tid)}」`); };
  const doDelete = async (iid: string) => { await api.deleteItem(vid, iid); closeMenus(); if (selId === iid) setSelId(""); await refresh(); flash("记录已删除"); };
  const anyMenu = idOpen || gearOpen || ctx.open || tctx.open;

  const ctxItem = items.find((i) => i.id === ctx.itemId);
  const tctxType = types.find((t) => t.id === tctx.typeId);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {anyMenu ? <div onMouseDown={closeMenus} onContextMenu={(e) => { e.preventDefault(); closeMenus(); }} style={{ position: "fixed", inset: 0, zIndex: 30 }} /> : null}

      {/* 顶栏 */}
      <div style={{ height: 52, background: "var(--card)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, padding: "0 14px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={{ width: 24, height: 24, borderRadius: 7, background: "var(--orange)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>🔐</div><span style={{ fontWeight: 600, fontSize: 14.5 }}>保险箱</span></div>
        <div style={{ width: 1, height: 20, background: "var(--border)" }} />
        <div style={{ position: "relative" }}>
          <button className="v-lock" onClick={() => { setIdOpen((v) => !v); setCtx({ open: false, x: 0, y: 0 }); }} style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--border)", background: "var(--bg)", borderRadius: 10, padding: "5px 10px", fontSize: 13, color: "var(--text)", cursor: "pointer" }}>
            <span>{cur?.icon}</span><span style={{ fontWeight: 600 }}>{cur?.name}</span><span style={{ color: "var(--muted)", fontSize: 10 }}>▾</span>
          </button>
          {idOpen ? (
            <div style={{ position: "absolute", top: 40, left: 0, width: 210, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow)", padding: 6, zIndex: 40, animation: "vPop .12s ease" }}>
              {vaults.map((v) => (
                <div key={v.id} className={v.id === vid ? "" : "v-row"} onClick={() => { setVid(v.id); setIdOpen(false); setSelId(""); setCat("all"); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, fontSize: 13, cursor: "pointer", background: v.id === vid ? "var(--orange-soft)" : "transparent", color: v.id === vid ? "var(--orange)" : "var(--text)", fontWeight: v.id === vid ? 600 : 400 }}>{v.icon} {v.name}{v.id === vid ? <span style={{ marginLeft: "auto" }}>✓</span> : null}</div>
              ))}
              <div style={{ height: 1, background: "var(--border)", margin: "6px 4px" }} />
              <div className="v-row" onClick={async () => { const id = await api.addVault("新身份库", "custom", "👤"); setVaults(await api.listVaults()); setVid(id); setIdOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, fontSize: 13, color: "var(--muted)", cursor: "pointer" }}>＋ 新建身份库</div>
              {st.biometric ? <div className="v-row" onClick={async () => { if (st.quickUnlock) await api.disableQuickUnlock(); else await api.enableQuickUnlock(); await onStatus(); setIdOpen(false); flash(st.quickUnlock ? "已关闭 Touch ID" : "已启用 Touch ID 快速解锁"); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, fontSize: 13, cursor: "pointer" }}>☝️ Touch ID 快速解锁 <span style={{ marginLeft: "auto", color: "var(--orange)" }}>{st.quickUnlock ? "✓" : ""}</span></div> : null}
            </div>
          ) : null}
        </div>
        <div style={{ flex: 1 }} />
        <button className="v-btn" onClick={addRecord} style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", background: "var(--orange)", color: "#fff", border: "none", borderRadius: 10, padding: "7px 13px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}><span style={{ fontSize: 15, lineHeight: 1 }}>＋</span>添加记录</button>
        <button className="v-lock" onClick={onLock} style={{ whiteSpace: "nowrap", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", borderRadius: 10, padding: "7px 12px", fontSize: 13, cursor: "pointer" }}>🔒 锁定</button>
        <div style={{ position: "relative" }}>
          <button className="v-lock" onClick={() => { setGearOpen((v) => !v); setIdOpen(false); }} title="导入 / 导出" style={{ border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", borderRadius: 10, height: 30, width: 34, fontSize: 15, cursor: "pointer" }}>⋯</button>
          {gearOpen ? (
            <div style={{ position: "absolute", top: 38, right: 0, width: 200, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow)", padding: 6, zIndex: 40, animation: "vPop .12s ease" }}>
              <MenuItem onClick={() => doExport(false)}>💾 导出加密备份</MenuItem>
              <MenuItem onClick={() => doExport(true)}>📄 导出明文 JSON</MenuItem>
              <div style={{ height: 1, background: "var(--border)", margin: "4px 4px" }} />
              <MenuItem onClick={doImport}>📥 导入备份 / 数据</MenuItem>
            </div>
          ) : null}
        </div>
        <ThemeBtn theme={theme} onTheme={onTheme} style={{ height: 30, width: 32 }} />
      </div>

      {/* 三栏 */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* 左：类型 */}
        <div style={{ width: 196, background: "var(--card)", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", flexShrink: 0 }}>
          <div style={{ flex: 1, overflowY: "auto", padding: "10px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={groupHead}>快速访问</div>
            <TypeRow icon="🗂️" name="全部" count={items.length} sel={cat === "all"} onClick={() => setCat("all")} />
            <TypeRow icon="⭐" name="收藏" count={items.filter((i) => i.favorite).length} sel={cat === "fav"} onClick={() => setCat("fav")} />
            <div style={{ ...groupHead, paddingTop: 12 }}>类型</div>
            {types.map((t) => renaming === t.id ? (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px" }}>
                <span style={{ fontSize: 15, width: 18, textAlign: "center" }}>{t.icon}</span>
                <input autoFocus defaultValue={t.name} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  onBlur={async (e) => { await api.updateType(vid, t.id, { name: e.target.value.trim() || t.name }); setRenaming(null); await refresh(); }}
                  style={{ flex: 1, minWidth: 0, border: "1px solid var(--orange)", background: "var(--card)", borderRadius: 7, padding: "2px 7px", fontSize: 13, fontWeight: 600, color: "var(--text)", outline: "none" }} />
              </div>
            ) : (
              <div key={t.id} className={cat === t.id ? "" : "v-row"} onClick={() => setCat(t.id)} onContextMenu={(e) => { e.preventDefault(); setTctx({ open: true, x: e.clientX, y: e.clientY, typeId: t.id }); setIdOpen(false); }}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 9, fontSize: 13, cursor: "pointer", userSelect: "none", background: cat === t.id ? "var(--orange-soft)" : "transparent", color: cat === t.id ? "var(--orange)" : "var(--text)", fontWeight: cat === t.id ? 600 : 500 }}>
                <span style={{ fontSize: 15, width: 18, textAlign: "center" }}>{t.icon}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                <span style={{ fontSize: 11.5, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{counts[t.id] || ""}</span>
              </div>
            ))}
          </div>
          <div style={{ padding: 8, borderTop: "1px solid var(--border)" }}>
            <button className="v-dash" onClick={async () => { const id = await api.addType(vid, "新类型", "📁"); await refresh(); setRenaming(id); }} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, border: "1px dashed var(--border)", background: "transparent", color: "var(--muted)", borderRadius: 9, padding: 8, fontSize: 12.5, cursor: "pointer" }}>＋ 新建类型</button>
          </div>
        </div>

        {/* 中：列表 */}
        <div style={{ width: 290, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", flexShrink: 0, background: "var(--bg)" }}>
          <div style={{ padding: "12px 12px 8px" }}>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "var(--muted)" }}>🔍</span>
              <input className="v-inp" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名称/账号/网址…" style={{ width: "100%", border: "1px solid var(--border)", background: "var(--card)", borderRadius: 10, padding: "8px 12px 8px 32px", fontSize: 13, color: "var(--text)", outline: "none" }} />
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "2px 10px 12px", display: "flex", flexDirection: "column", gap: 3 }}>
            {visible.length ? visible.map((it) => {
              const acc = it.blocks.find((b) => b.type === "account");
              const isSel = it.id === selId;
              return (
                <div key={it.id} className="v-item" onClick={() => selectItem(it.id)} onContextMenu={(e) => { e.preventDefault(); setCtx({ open: true, x: e.clientX, y: e.clientY, itemId: it.id }); setIdOpen(false); }}
                  style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 10px", borderRadius: 11, cursor: "pointer", border: "1px solid " + (isSel ? "color-mix(in srgb,var(--orange) 22%,transparent)" : "transparent"), background: isSel ? "var(--orange-soft)" : "transparent" }}>
                  <div style={{ width: 34, height: 34, borderRadius: 10, background: "var(--orange-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>{it.icon || typeIcon(it.typeId)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</div>
                    <div style={{ fontSize: 11.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>{acc ? String(acc.data.username || "") : typeName(it.typeId)}</div>
                  </div>
                  {it.favorite ? <span style={{ fontSize: 12, color: "var(--orange)" }}>⭐</span> : null}
                  {isSel ? <span style={{ fontSize: 15, color: "var(--orange)", lineHeight: 1 }}>›</span> : null}
                </div>
              );
            }) : <div style={{ textAlign: "center", color: "var(--muted)", fontSize: 13, padding: "60px 20px", lineHeight: 1.7, animation: "vDetailIn .3s ease" }}><div style={{ fontSize: 30, opacity: .4 }}>🗒️</div>没有匹配的记录</div>}
          </div>
        </div>

        {/* 右：详情 */}
        <div style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
          {sel ? <Detail key={sel.id} vid={vid} item={sel} typeName={typeName} typeIcon={typeIcon} autoEdit={autoEditId === sel.id} onChange={refresh} onFav={() => toggleFav(sel)} onDelete={() => doDelete(sel.id)} flash={flash} />
            : <div style={{ textAlign: "center", color: "var(--muted)", fontSize: 13, padding: 80 }}>选择或新建一条记录</div>}
        </div>
      </div>

      {/* 记录右键菜单 */}
      {ctx.open && ctxItem ? (
        <div style={{ position: "fixed", left: ctx.x, top: ctx.y, width: 212, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow)", padding: 6, zIndex: 55, animation: "vPop .12s ease", fontSize: 13 }}>
          <div style={{ padding: "6px 10px 7px", fontWeight: 600, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ctxItem.title}</div>
          <div style={{ height: 1, background: "var(--border)", margin: "2px 4px 4px" }} />
          <MenuItem onClick={() => { setSelId(ctx.itemId!); setAutoEditId(ctx.itemId!); closeMenus(); }}>✏️ 编辑记录</MenuItem>
          <MenuItem onClick={() => { void toggleFav(ctxItem); closeMenus(); }}>⭐ {ctxItem.favorite ? "取消收藏" : "加入收藏"}</MenuItem>
          <div style={{ height: 1, background: "var(--border)", margin: "4px 4px" }} />
          <div style={{ padding: "4px 10px 3px", fontSize: 10.5, fontWeight: 600, letterSpacing: ".06em", color: "var(--muted)", textTransform: "uppercase" }}>移动到</div>
          {types.map((t) => <div key={t.id} className="v-ho" onClick={() => doMove(ctx.itemId!, t.id)} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 10px", borderRadius: 8, cursor: "pointer" }}><span style={{ width: 16, textAlign: "center" }}>{t.icon}</span><span style={{ flex: 1, whiteSpace: "nowrap" }}>{t.name}</span>{ctxItem.typeId === t.id ? <span style={{ color: "var(--orange)" }}>✓</span> : null}</div>)}
          <div style={{ height: 1, background: "var(--border)", margin: "4px 4px" }} />
          <div className="v-danger" onClick={() => doDelete(ctx.itemId!)} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 10px", borderRadius: 8, cursor: "pointer", color: "var(--danger)" }}>🗑 删除记录</div>
        </div>
      ) : null}

      {/* 类型右键菜单 */}
      {tctx.open && tctxType ? (
        <div style={{ position: "fixed", left: tctx.x, top: tctx.y, width: 172, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow)", padding: 6, zIndex: 55, animation: "vPop .12s ease", fontSize: 13 }}>
          <div style={{ padding: "6px 10px 7px", fontWeight: 600, fontSize: 12.5 }}>{tctxType.name}</div>
          <div style={{ height: 1, background: "var(--border)", margin: "2px 4px 4px" }} />
          <MenuItem onClick={() => { setRenaming(tctx.typeId!); closeMenus(); }}>✎ 改名</MenuItem>
          <div className="v-danger" onClick={async () => { await api.deleteType(vid, tctx.typeId!); if (cat === tctx.typeId) setCat("all"); closeMenus(); await refresh(); flash("类型已删除"); }} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 10px", borderRadius: 8, cursor: "pointer", color: "var(--danger)" }}>🗑 删除类型</div>
        </div>
      ) : null}

      {imp.open ? (
        <div style={{ position: "fixed", inset: 0, zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.4)" }} onMouseDown={() => setImp({ open: false, mp: "", sk: "", err: "" })}>
          <div style={{ width: 360, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 16, padding: 20, boxShadow: "var(--shadow)" }} onMouseDown={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>导入加密备份</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>输入备份对应的主密码解密（若换过 Secret Key 也一并填）。导入的库会作为新身份库追加，不覆盖现有数据。</div>
            <input autoFocus type="password" className="v-inp" placeholder="备份的主密码" value={imp.mp} onChange={(e) => setImp((s) => ({ ...s, mp: e.target.value, err: "" }))} onKeyDown={(e) => e.key === "Enter" && applyImport()} style={{ width: "100%", border: "1px solid var(--border)", background: "var(--bg)", borderRadius: 10, padding: "10px 12px", fontSize: 14, color: "var(--text)", outline: "none" }} />
            <input type="text" className="v-inp" placeholder="Secret Key（可选，U1-…）" value={imp.sk} onChange={(e) => setImp((s) => ({ ...s, sk: e.target.value }))} style={{ width: "100%", marginTop: 8, border: "1px solid var(--border)", background: "var(--bg)", borderRadius: 10, padding: "10px 12px", fontSize: 14, color: "var(--text)", outline: "none", fontFamily: "ui-monospace,Menlo,monospace" }} />
            {imp.err ? <div style={{ ...errStyle, textAlign: "left" }}>{imp.err}</div> : null}
            <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
              <button style={{ border: "1px solid var(--border)", background: "var(--card)", color: "var(--text)", borderRadius: 10, padding: "8px 14px", fontSize: 13, cursor: "pointer" }} onClick={() => setImp({ open: false, mp: "", sk: "", err: "" })}>取消</button>
              <button className="v-btn" style={{ background: "var(--orange)", color: "#fff", border: "none", borderRadius: 10, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }} onClick={applyImport}>导入</button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <div style={{ position: "absolute", bottom: 26, left: "50%", transform: "translateX(-50%)", background: "#17130f", color: "#fff", borderRadius: 999, padding: "9px 18px", fontSize: 13, boxShadow: "0 10px 30px rgba(0,0,0,.35)", zIndex: 60, animation: "vToastIn .18s ease", display: "flex", alignItems: "center", gap: 7 }}><span style={{ color: "#34B5A6" }}>✓</span>{toast}</div> : null}
    </div>
  );
}

const groupHead: CSSProperties = { fontSize: 10.5, fontWeight: 600, letterSpacing: ".08em", color: "var(--muted)", textTransform: "uppercase", padding: "4px 10px 5px" };
function TypeRow({ icon, name, count, sel, onClick }: { icon: string; name: string; count: number; sel: boolean; onClick: () => void }) {
  return <div className={sel ? "" : "v-row"} onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 9, fontSize: 13, cursor: "pointer", userSelect: "none", background: sel ? "var(--orange-soft)" : "transparent", color: sel ? "var(--orange)" : "var(--text)", fontWeight: sel ? 600 : 500 }}><span style={{ fontSize: 15, width: 18, textAlign: "center" }}>{icon}</span><span style={{ flex: 1 }}>{name}</span><span style={{ fontSize: 11.5, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{count || ""}</span></div>;
}
function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <div className="v-ho" onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 10px", borderRadius: 8, cursor: "pointer", whiteSpace: "nowrap" }}>{children}</div>;
}

// ── 详情 ──
function Detail({ vid, item, typeName, typeIcon, autoEdit, onChange, onFav, onDelete, flash }: {
  vid: string; item: Item; typeName: (id: string) => string; typeIcon: (id: string) => string; autoEdit: boolean; onChange: () => Promise<void>; onFav: () => void; onDelete: () => void; flash: (m: string) => void;
}) {
  const [edit, setEdit] = useState(autoEdit);
  const [draft, setDraft] = useState<Item>(structuredClone(item));
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => { setDraft(structuredClone(item)); setEdit(autoEdit); }, [item, autoEdit]);

  const save = async () => { await api.updateItem(vid, draft); setEdit(false); await onChange(); flash("已保存 ✓"); };
  const setData = (bid: string, k: string, v: unknown) => setDraft((d) => ({ ...d, blocks: d.blocks.map((b) => (b.id === bid ? { ...b, data: { ...b.data, [k]: v } } : b)) }));
  const delBlock = (bid: string) => setDraft((d) => ({ ...d, blocks: d.blocks.filter((b) => b.id !== bid) }));
  const moveBlock = (i: number, dir: -1 | 1) => setDraft((d) => { const b = d.blocks.slice(); const j = i + dir; if (j < 0 || j >= b.length) return d; [b[i], b[j]] = [b[j], b[i]]; return { ...d, blocks: b }; });
  const addBlock = (type: string) => { setDraft((d) => ({ ...d, blocks: [...d.blocks, newBlock(type)] })); setAddOpen(false); };

  const model = edit ? draft : item;
  return (
    <div>
      {/* header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "24px 26px 14px", animation: "vDetailIn .32s ease" }}>
        {edit ? <input value={draft.icon || ""} maxLength={2} onChange={(e) => setDraft({ ...draft, icon: e.target.value })} style={{ width: 50, height: 50, textAlign: "center", borderRadius: 14, background: "var(--orange-soft)", border: "1px solid var(--border)", fontSize: 24 }} />
          : <div style={{ width: 50, height: 50, borderRadius: 14, background: "var(--orange-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 25, flexShrink: 0 }}>{item.icon || typeIcon(item.typeId)}</div>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {edit ? <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} style={{ flex: 1, fontSize: 19, fontWeight: 600, border: "1px solid var(--border)", background: "var(--bg)", borderRadius: 8, padding: "3px 8px", color: "var(--text)", outline: "none" }} />
              : <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: "-.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</h1>}
            <button className="v-scale" onClick={onFav} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 2, color: "var(--orange)" }}>{item.favorite ? "⭐" : "☆"}</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 7 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "var(--muted)", background: "var(--bg)", border: "1px solid var(--border)", padding: "3px 9px", borderRadius: 7 }}>{typeIcon(item.typeId)} {typeName(item.typeId)}</span>
            <span style={{ fontSize: 11, color: "var(--muted)", opacity: .8 }}>右键列表可移动 / 删除</span>
          </div>
        </div>
        {edit ? <button className="v-btn" onClick={save} style={{ background: "var(--orange)", color: "#fff", border: "none", borderRadius: 10, padding: "7px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>保存</button>
          : <button className="v-btn" onClick={() => setEdit(true)} style={{ background: "var(--card)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 10, padding: "7px 16px", fontSize: 13, fontWeight: 500, cursor: "pointer", flexShrink: 0 }}>编辑</button>}
      </div>

      {/* blocks */}
      <div style={{ padding: "6px 26px 0" }}>
        {model.blocks.map((b, i) => (
          <div key={b.id} style={{ animation: "vBlockIn .34s ease both", animationDelay: `${i * 55}ms` }}>
            <BlockCard vid={vid} itemId={item.id} block={b} edit={edit} idx={i} count={model.blocks.length}
              onData={(k, v) => setData(b.id, k, v)} onDel={() => delBlock(b.id)} onMove={(dir) => moveBlock(i, dir)}
              onAttAdded={(att) => setData(b.id, "atts", [...((b.data.atts as string[]) || []), att.id])} attMeta={model.attachments} flash={flash} />
          </div>
        ))}

        {edit ? (
          <div style={{ position: "relative", marginBottom: 6 }}>
            <button className="v-dash" onClick={() => setAddOpen((v) => !v)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, border: "1px dashed var(--border)", background: "transparent", color: "var(--muted)", borderRadius: 12, padding: 12, fontSize: 13, cursor: "pointer" }}><span style={{ fontSize: 15 }}>＋</span> 添加控件</button>
            {addOpen ? (
              <div style={{ position: "absolute", bottom: 50, left: "50%", transform: "translateX(-50%)", width: 280, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 14, boxShadow: "var(--shadow)", padding: 8, zIndex: 40, animation: "vPop .12s ease", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                {CTLS.map((c) => <div key={c[0]} className="v-ho" onClick={() => addBlock(c[0])} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 10px", borderRadius: 9, fontSize: 13, cursor: "pointer" }}><span style={{ fontSize: 15 }}>{c[2]}</span>{c[1]}</div>)}
              </div>
            ) : null}
          </div>
        ) : null}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 2px 28px" }}>
          <div style={{ fontSize: 11.5, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}><span style={{ color: "var(--success)" }}>🔒</span> 整条记录已 AES-256-GCM 加密 · 密码 / 密文不进入搜索</div>
          {edit ? <button className="v-danger" onClick={onDelete} style={{ border: "none", background: "transparent", color: "var(--danger)", fontSize: 12.5, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, padding: "5px 8px", borderRadius: 8 }}>🗑 删除记录</button> : null}
        </div>
      </div>
    </div>
  );
}

// ── 单个控件卡片 ──
function BlockCard({ vid, itemId, block, edit, idx, count, onData, onDel, onMove, onAttAdded, attMeta, flash }: {
  vid: string; itemId: string; block: Block; edit: boolean; idx: number; count: number;
  onData: (k: string, v: unknown) => void; onDel: () => void; onMove: (dir: -1 | 1) => void; onAttAdded: (att: Att) => void; attMeta: Att[]; flash: (m: string) => void;
}) {
  const [reveal, setReveal] = useState(false);
  const copy = (v: string, m: string) => { void api.copy(v); flash(m + " · 20s 后自动清除"); };
  const gen = async (k: string) => { const p = await api.generatePassword({ length: 20 }); onData(k, p); flash("已生成强密码"); };
  const d = block.data;
  const mask = "•".repeat(10);
  const lab = (t: string) => <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 5, letterSpacing: ".03em" }}>{t}</div>;
  const inpS: CSSProperties = { width: "100%", border: "1px solid var(--border)", background: "var(--bg)", borderRadius: 10, padding: "9px 12px", fontSize: 14, color: "var(--text)", outline: "none", fontFamily: "ui-monospace,Menlo,monospace" };
  const icoBtn: CSSProperties = { cursor: "pointer", fontSize: 14, padding: 5, borderRadius: 7, color: "var(--muted)" };

  return (
    <div className="v-card" style={{ border: "1px solid var(--border)", borderRadius: 14, background: "var(--card)", marginBottom: 12, overflow: "hidden", transition: "box-shadow .2s ease, transform .2s ease" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 14px", background: "var(--bg)", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--orange)", background: "var(--orange-soft)", padding: "2px 8px", borderRadius: 6 }}>{TAG[block.type] || block.type}</span>
          <span style={{ fontSize: 13, color: "var(--muted)" }}>{block.label}</span>
        </div>
        {edit ? <div style={{ display: "flex", gap: 2 }}>
          <span className="v-ho" onClick={() => idx > 0 && onMove(-1)} style={{ ...icoBtn, fontSize: 13, opacity: idx === 0 ? .3 : 1 }}>↑</span>
          <span className="v-ho" onClick={() => idx < count - 1 && onMove(1)} style={{ ...icoBtn, fontSize: 13, opacity: idx === count - 1 ? .3 : 1 }}>↓</span>
          <span className="v-danger" onClick={onDel} style={{ ...icoBtn, color: "var(--danger)", fontSize: 12 }}>🗑</span>
        </div> : null}
      </div>
      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 13 }}>
        {block.type === "account" ? (<>
          <div>{lab("用户名")}{edit ? <input value={String(d.username || "")} onChange={(e) => onData("username", e.target.value)} style={inpS} />
            : <Row mono val={String(d.username || "")}><span className="v-ho" style={icoBtn} onClick={() => copy(String(d.username || ""), "用户名已复制")}>📋</span></Row>}</div>
          <div>{lab("密码")}{edit ? <div style={{ display: "flex", alignItems: "center", gap: 8 }}><input value={String(d.password || "")} onChange={(e) => onData("password", e.target.value)} style={{ ...inpS, flex: 1, letterSpacing: ".06em" }} /><span className="v-ho" title="生成强密码" onClick={() => gen("password")} style={{ cursor: "pointer", fontSize: 15, padding: 8, borderRadius: 9, border: "1px solid var(--border)", color: "var(--orange)", lineHeight: 1 }}>🎲</span></div>
            : <Row mono val={reveal ? String(d.password || "") : mask}><span className="v-ho" style={icoBtn} onClick={() => setReveal(!reveal)}>{reveal ? "🙈" : "👁"}</span><span className="v-ho" style={icoBtn} onClick={() => copy(String(d.password || ""), "密码已复制")}>📋</span></Row>}</div>
          <div>{lab("网址")}{edit ? <input value={String(d.url || "")} onChange={(e) => onData("url", e.target.value)} style={{ ...inpS, fontFamily: "inherit" }} />
            : (d.url ? <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ flex: 1, fontSize: 13.5, color: "var(--orange-text)" }}>{String(d.url)}</span><span className="v-ho" style={icoBtn} onClick={() => { const u = String(d.url); window.open(/^https?:/.test(u) ? u : "https://" + u); }}>↗</span></div> : <span style={{ color: "var(--muted)", fontSize: 13 }}>—</span>)}</div>
          {edit ? <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}><input type="checkbox" checked={!!d.otp} onChange={(e) => onData("otp", e.target.checked)} />含两步验证 (2FA)</label>
            : (d.otp ? <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--success)", background: "color-mix(in srgb,var(--success) 12%,transparent)", padding: "4px 9px", borderRadius: 7, alignSelf: "flex-start" }}>🔐 已启用两步验证 (2FA)</div> : null)}
        </>) : null}

        {block.type === "secret" ? (edit ? <div style={{ display: "flex", alignItems: "center", gap: 8 }}><input value={String(d.value || "")} onChange={(e) => onData("value", e.target.value)} style={{ ...inpS, flex: 1, letterSpacing: ".06em" }} /><span className="v-ho" title="生成" onClick={() => gen("value")} style={{ cursor: "pointer", fontSize: 15, padding: 8, borderRadius: 9, border: "1px solid var(--border)", color: "var(--orange)", lineHeight: 1 }}>🎲</span></div>
          : <Row mono val={reveal ? String(d.value || "") : mask}><span className="v-ho" style={icoBtn} onClick={() => setReveal(!reveal)}>{reveal ? "🙈" : "👁"}</span><span className="v-ho" style={icoBtn} onClick={() => copy(String(d.value || ""), "已复制")}>📋</span></Row>) : null}

        {block.type === "text" ? (edit ? <textarea value={String(d.value || "")} onChange={(e) => onData("value", e.target.value)} style={{ width: "100%", minHeight: 96, resize: "vertical", border: "1px solid var(--border)", background: "var(--bg)", borderRadius: 10, padding: "10px 12px", fontSize: 13.5, lineHeight: 1.6, color: "var(--text)", outline: "none", fontFamily: "inherit" }} />
          : <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.7, whiteSpace: "pre-line" }}>{String(d.value || "")}</p>) : null}

        {block.type === "field" ? (edit ? <input value={String(d.value || "")} onChange={(e) => onData("value", e.target.value)} style={inpS} />
          : <Row mono val={String(d.value || "")}><span className="v-ho" style={icoBtn} onClick={() => copy(String(d.value || ""), "已复制")}>📋</span></Row>) : null}

        {block.type === "images" || block.type === "files" ? <Gallery vid={vid} itemId={itemId} atts={(d.atts as string[]) || []} edit={edit} kind={block.type === "images" ? "image" : "file"} attMeta={attMeta} onAttAdded={onAttAdded} onRemove={(aid) => onData("atts", ((d.atts as string[]) || []).filter((x) => x !== aid))} /> : null}
      </div>
    </div>
  );
}

function Row({ val, mono, children }: { val: string; mono?: boolean; children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ flex: 1, fontSize: 14, fontFamily: mono ? "ui-monospace,Menlo,monospace" : "inherit", letterSpacing: mono ? ".02em" : undefined, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{val}</span>{children}</div>;
}

// ── 图片/文件画廊 ──
function Gallery({ vid, itemId, atts, edit, kind, attMeta, onAttAdded, onRemove }: { vid: string; itemId: string; atts: string[]; edit: boolean; kind: "image" | "file"; attMeta: Att[]; onAttAdded: (att: Att) => void; onRemove: (aid: string) => void }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (kind === "image") atts.forEach((aid) => { if (!urls[aid]) void api.readAttachment(vid, aid).then((u) => setUrls((m) => ({ ...m, [aid]: u }))).catch(() => {}); }); }, [atts, kind, vid, urls]);
  const nameOf = (aid: string) => attMeta.find((a) => a.id === aid)?.name || "文件";
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    for (const f of Array.from(e.target.files || [])) {
      const buf = await f.arrayBuffer(); let bin = ""; const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const att = await api.addAttachment(vid, itemId, f.name, f.type || "application/octet-stream", btoa(bin));
      onAttAdded(att);
    }
    e.target.value = "";
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", flexDirection: kind === "file" ? "column" : "row", gap: kind === "file" ? 8 : 10 }}>
      {atts.map((aid) => kind === "image" ? (
        <div key={aid} style={{ width: 120, height: 80, borderRadius: 10, background: urls[aid] ? "#0000" : "linear-gradient(135deg,#c7b8a3,#9a8b73)", position: "relative", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.06)", overflow: "hidden", display: "flex", alignItems: "flex-end", padding: 6 }}>
          {urls[aid] ? <img src={urls[aid]} onClick={() => window.open(urls[aid])} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", cursor: "pointer" }} alt="" /> : null}
          <span style={{ position: "relative", fontSize: 10, color: "rgba(255,255,255,.95)", background: "rgba(0,0,0,.35)", padding: "1px 6px", borderRadius: 5, maxWidth: 108, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nameOf(aid)}</span>
          {edit ? <span onClick={() => onRemove(aid)} style={{ position: "absolute", top: 5, right: 5, width: 20, height: 20, borderRadius: "50%", background: "rgba(0,0,0,.55)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, cursor: "pointer" }}>✕</span> : null}
        </div>
      ) : (
        <div key={aid} className="v-lock" style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border)", borderRadius: 10, padding: "9px 12px", background: "var(--bg)" }}>
          <span style={{ fontSize: 16 }}>📄</span><span style={{ flex: 1, fontSize: 13, fontFamily: "ui-monospace,Menlo,monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nameOf(aid)}</span>
          <span className="v-ho" title="导出" onClick={async () => { const u = await api.readAttachment(vid, aid); window.open(u); }} style={{ cursor: "pointer", fontSize: 13, padding: 4, borderRadius: 6, color: "var(--muted)" }}>⬇</span>
          {edit ? <span className="v-danger" onClick={() => onRemove(aid)} style={{ cursor: "pointer", fontSize: 12, padding: 4, borderRadius: 6, color: "var(--danger)" }}>✕</span> : null}
        </div>
      ))}
      {edit ? <>
        {kind === "image"
          ? <div className="v-dash" onClick={() => fileRef.current?.click()} style={{ width: 120, height: 80, borderRadius: 10, border: "1px dashed var(--border)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, color: "var(--muted)", fontSize: 11.5, cursor: "pointer" }}><span style={{ fontSize: 18 }}>＋</span>添加图片</div>
          : <div className="v-dash" onClick={() => fileRef.current?.click()} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px dashed var(--border)", borderRadius: 10, padding: "9px 12px", color: "var(--muted)", fontSize: 12.5, cursor: "pointer" }}>＋ 添加文件</div>}
        <input ref={fileRef} type="file" multiple accept={kind === "image" ? "image/*" : "*"} style={{ display: "none" }} onChange={onFile} />
      </> : (atts.length === 0 ? <span style={{ color: "var(--muted)", fontSize: 12 }}>（空）</span> : null)}
    </div>
  );
}
