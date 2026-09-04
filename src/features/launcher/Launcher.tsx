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
  // atts（批次 013）：面板已传好的图片 file_id（一期 1 张）。不传 = 纯文字。
  sendAssistant(text: string, atts?: string[]): Promise<string>;
  slashSend(kind: string, text: string, atts?: string[]): Promise<{ ok: boolean }>;
  assistantOnline(): Promise<boolean>;
  // 服务端地址 + 令牌：面板自己 POST /files/upload 用（见 uploadPanelImage）。
  getServerInfo(): Promise<{ serverUrl: string; token: string }>;
  hide(): Promise<void>;
  resize(h: number): Promise<void>;
  onShown(cb: (prefill: { q: string; caret?: "left" | "right" } | null) => void): () => void;
  quicklook(target: string): Promise<void>;
  onResults(cb: (payload: { q: string; results: LauncherResult[] }) => void): () => void;
}
const api = (window as unknown as { umbraLauncher: LauncherAPI }).umbraLauncher;

// 「/」功能菜单（批次 009，token launcherSlash）：一期写死四个；内容不直接调各功能的
// 添加接口，统一发给秘书整理后入库 —— 面板只负责「已交给秘书」这一下轻反馈。
// 工作流的 keyword 触发（yd hello 这种）是另一套，不进这个菜单；
// 和聊天输入条的「/」快捷输入面板同形不同事（那个直接调工具），两边不共享列表。
interface SlashFunc { k: string; label: string; sample: string; d: string }
const SLASH_FUNCS: SlashFunc[] = [
  { k: "insp", label: "灵感", sample: "/灵感 做个只给自己看的记账壁纸", d: "M9 18h6M10 21h4M12 3a6 6 0 0 1 3.6 10.8L15 18H9l-.6-4.2A6 6 0 0 1 12 3z" },
  { k: "money", label: "记账", sample: "/记账 午饭 32", d: "M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 10h16M9 15h2" },
  { k: "phrase", label: "常用语", sample: "/常用语 报销话术 <正文>", d: "M21 11.5a8.4 8.4 0 0 1-11.9 7.6L4 20l1-4.6A8.4 8.4 0 1 1 21 11.5z" },
  { k: "rem", label: "提醒", sample: "/提醒 明天十点打给张伟", d: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" },
];

// ── 带图交给秘书（批次 013，token launcherImage）─────────────────────────────
// 一期只收 **1 张**：拖进面板（整个 .box）或在输入框 ⌘V。图先由面板自己传到服务端拿 file_id，
// 再随 slashSend / sendAssistant 一起交给主进程 → 主窗口聊天页发一条 kind=text + atts 的消息。
// 面板里的图片状态：url 是本地预览（createObjectURL），fileId 是传成功后的服务端 id ——
// 留着它，离线重试时不用再传一遍同样的字节。
interface PanelAtt { file: File; url: string; fileId?: string }
// 单张上限（和服务端 / 聊天一致：10 MB）。超了直接拒收 —— 面板没有聊天那种「标红留条里」的余地。
const IMG_MAX_BYTES = 10 * 1024 * 1024;
// 字节 → 「1.2 MB」/「356 KB」（缩略条第二行）。
const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
// 动作口径（缩略条右侧第一行）：按 picked 的动作换词；没选动作 = 交给秘书时一起带上。
const ATT_COPY: Record<string, string> = { money: "这张图当凭证", rem: "这张图当附件", insp: "这张图当配图" };
// 落进哪里（输入行下方提示里的「记账 / 提醒 / 灵感」）。
const ATT_DEST: Record<string, string> = { money: "记账", rem: "提醒", insp: "灵感" };
// 吃不上图的动作：面板里只有「常用语」这一个 —— 不禁用发送、不吐掉图，
// 缩略条压暗 + 说清图会跟着消息发到聊天（用户已经选了这张图，替他决定「用不上就扔」比说清去向更冒犯）。
const attUnusable = (f: SlashFunc | null) => f?.k === "phrase";
// 输入行下方那句提示。带图时替换掉原来的 picked-note（按动作换词；无动作 / 常用语用短版）。
function attNote(f: SlashFunc | null): string {
  const dest = f ? ATT_DEST[f.k] : "";
  return dest
    ? `回车把这句话和这张图交给秘书，它先看图再落进「${dest}」。再拖一张进来会换掉这张。`
    : "回车把这句话和这张图交给秘书。再拖一张进来会换掉这张。";
}
// 传图：POST /files/upload（这条链路里唯一带鉴权的接口）。地址与令牌从主进程配置取 ——
// 面板窗口没有主窗口那套 desktop.ts 灌配置的流程，services/server 的 getServerUrl() 在这里
// 只会落到 localStorage / 默认值，拿不到用户真正配的地址。失败一律回 null = 离线态。
// 30s 超时：服务端不通时别让「上传中…」挂到 TCP 自己放弃。
async function uploadPanelImage(file: File): Promise<string | null> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), 30_000);
  try {
    const info = await api.getServerInfo();
    const base = String(info?.serverUrl || "").replace(/\/+$/, "");
    if (!base) return null;
    const headers: Record<string, string> = {};
    if (info.token) headers["X-Umbra-Token"] = info.token;
    const fd = new FormData();
    fd.append("file", file, file.name);
    const r = await fetch(`${base}/files/upload`, { method: "POST", body: fd, headers, signal: ctl.signal });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.file_id ? String(d.file_id) : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

// 面板**锁深色**、不跟系统浅深（批次 010 答复，token launcherSlash.theme）：
// 快捷入口和左侧导航（--nav 两种主题下都是深色）是同一类常驻壳层，不是内容区；
// 它又浮在任意桌面内容上，深底在浅深两种环境里都立得住，跟着系统翻反而会在
// 浅色下糊成一块白板。原来的浅色适配整段删除。
const CSS = `
:root{color-scheme:dark;--bg:rgba(30,27,24,.98);--card:#26221E;--border:#3A342E;--text:#F2EFEA;--muted:#A79E93;--orange:#E8590C;--sel:#3a2a1c;
  --slash-fg:#F0A878;--slash-chipbg:rgba(232,89,12,.2);--chipbg:#ffffff10;
  --ok-bg:rgba(58,132,86,.18);--ok-fg:#9FD6AE;
  --err-bg:rgba(198,64,42,.14);--err-bd:rgba(198,64,42,.38);--err-bd2:rgba(240,160,142,.5);--err-fg:#F0A08E;}
*{box-sizing:border-box;}
html,body{margin:0;height:100%;background:transparent;font-family:-apple-system,"SF Pro Text",system-ui,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;color:var(--text);}
.wrap{height:100vh;padding:10px;}
.box{position:relative;background:var(--bg);border:1px solid var(--border);border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.28);overflow:hidden;display:flex;flex-direction:column;}
/* 拖图悬停：整个 .box 都是落点，描边转橙告诉人「松手就收」。稿没画这一态，只做最轻的一笔。 */
.box.dragover{border-color:var(--orange);}
.search{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border);-webkit-app-region:drag;}
.search .q,.search .hint{-webkit-app-region:no-drag;}
.search .q{flex:1;border:none;outline:none;background:transparent;font-size:22px;color:var(--text);caret-color:var(--orange);}
.toast{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);background:var(--orange);color:#fff;font-size:12.5px;padding:6px 14px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.25);}
.search .q::placeholder{color:var(--muted);}
.hint{color:var(--muted);font-size:12px;white-space:nowrap;}
.list{overflow-y:auto;padding:6px;max-height:520px;}
.list:empty{display:none;}
.row{display:flex;align-items:center;gap:12px;padding:9px 12px;border-radius:10px;cursor:pointer;}
.row.sel{background:var(--sel);}
.ico{width:30px;height:30px;flex:none;display:flex;align-items:center;justify-content:center;font-size:20px;border-radius:7px;overflow:hidden;background:#ffffff10;}
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
/* ──「/」功能菜单（批次 009）。稿只画了深色面板的取值（#F0A878 等），本面板跟随系统
   浅深色，浅色态用同语义的浅色版（--slash-fg 等），深色态与稿一致。 */
.slash{padding:6px;}
.slash .cap{font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--muted);padding:2px 12px 6px;white-space:nowrap;}
.srow{display:flex;align-items:center;gap:9px;padding:7px 12px;border-radius:8px;cursor:pointer;}
.srow.sel{background:var(--sel);}
.srow .sbox{width:18px;height:18px;flex:none;border-radius:5px;display:flex;align-items:center;justify-content:center;background:var(--chipbg);color:var(--muted);}
.srow.sel .sbox{background:var(--slash-chipbg);color:var(--slash-fg);}
.srow .sname{flex:none;font-size:12.5px;font-weight:500;white-space:nowrap;}
.srow.sel .sname{color:var(--slash-fg);}
.srow .ssample{flex:1;min-width:0;font-size:10.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;}
.srow .spick{flex:none;font-size:10.5px;color:var(--slash-fg);white-space:nowrap;font-family:ui-monospace,Menlo,monospace;}
.chip{flex:none;display:flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:6px;background:var(--slash-chipbg);color:var(--slash-fg);font-size:12.5px;font-weight:600;white-space:nowrap;}
.chip svg{flex:none;}
.chip .arr{color:var(--slash-fg);opacity:.55;font-weight:400;}
.needbody{flex:none;font-size:11px;color:var(--slash-fg);white-space:nowrap;}
.picked-note{padding:8px 14px 10px;font-size:11px;line-height:1.7;color:var(--muted);text-wrap:pretty;}
/* ── 带图缩略条（批次 013，token launcherImage）：在输入行上方、.box 内。
   稿里面板卡自带 10 padding，这里没有，所以外面套一层 attwrap 给 10；条本身 0 2px 9px。
   缩略 64 / 圆角 9 / 1px #3D372E / × 17 —— 和聊天待发条同一套。稿的取值是写死的深色值，
   面板锁深色，直接照抄。可点的 × 补 no-drag（.search 那片是 drag 区，别让它顺手拖窗）。 */
.attwrap{padding:10px 10px 0;-webkit-app-region:no-drag;}
.att{display:flex;align-items:center;gap:10px;padding:0 2px 9px;}
.att.dim{opacity:.5;}
.att .thumb{position:relative;flex:none;width:64px;height:64px;border-radius:9px;overflow:hidden;display:block;background:rgba(255,255,255,.06);border:1px solid #3D372E;}
.att .thumb img{width:100%;height:100%;object-fit:cover;display:block;}
.att .rm{position:absolute;top:3px;right:3px;width:17px;height:17px;border:none;border-radius:999px;background:rgba(12,10,8,.74);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;-webkit-app-region:no-drag;}
.att .am{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;}
.att .ac{font-size:11.5px;color:#8A837A;line-height:1.6;}
.att .af{font:10.5px/1.6 ui-monospace,Menlo,monospace;color:#6E675E;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.att .au{flex:1;min-width:0;font-size:11.5px;color:#8A837A;line-height:1.65;text-wrap:pretty;}
/* 输入行下方的带图提示：稿是卡内 10 padding + 自身 7px 10px，这里用 margin 补出卡的那 10。 */
.att-note{margin:8px 10px 10px;padding:7px 10px;font-size:11px;line-height:1.7;color:#8A837A;text-wrap:pretty;}
.sent{margin:6px;display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:8px;background:var(--ok-bg);}
.sent .st{flex:none;font-size:12.5px;font-weight:600;color:var(--ok-fg);white-space:nowrap;}
.sent .ss{flex:1;min-width:0;font-size:10.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.offline{margin:6px;display:flex;flex-direction:column;gap:9px;padding:11px 12px;border-radius:9px;background:var(--err-bg);border:1px solid var(--err-bd);}
.offline .ot{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:var(--err-fg);white-space:nowrap;}
.offline .ob{font-size:11.5px;line-height:1.7;color:var(--text);opacity:.8;text-wrap:pretty;}
.offline .oa{display:flex;gap:7px;}
.offline .oa button{flex:none;padding:4px 11px;border:1px solid var(--err-bd2);background:transparent;color:var(--err-fg);border-radius:7px;font-size:11.5px;cursor:pointer;font-family:inherit;white-space:nowrap;}
.row.offdim{opacity:.42;}
.offbadge{flex:none;font-size:10px;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:1px 7px;white-space:nowrap;}
`;

export function Launcher() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<LauncherResult[]>([]);
  const [sel, setSel] = useState(0);
  const [toast, setToast] = useState("");
  // ──「/」功能菜单的状态 ────────────────────────────────────────────────
  // picked = 选中的功能（前缀收成胶囊，q 变成内容）；menuSel = 菜单选中行；
  // feedback：needBody（空内容回车，输入行右侧提示）/ sent（发出后闪一帧再收）/
  // offline（三段式错误卡，面板不收、内容留在输入框）。
  const [picked, setPicked] = useState<SlashFunc | null>(null);
  const [menuSel, setMenuSel] = useState(0);
  const [feedback, setFeedback] = useState<"" | "needBody" | "sent" | "offline">("");
  // 秘书可达性：菜单打开时探一次；「问秘书」兜底项离线转灰也读它。null = 还没探过。
  const [online, setOnline] = useState<boolean | null>(null);
  // ── 带图（批次 013）────────────────────────────────────────────────────
  // att = 面板里那一张图（一期只 1 张）；attRef 是同一份的即时视图，给异步发送链路和
  // onShown 这种不重新绑定的回调用。sending = 正在传图 / 发送（挡住重复回车、拖拽、× 删图）。
  const [att, setAtt] = useState<PanelAtt | null>(null);
  const attRef = useRef<PanelAtt | null>(null);
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);   // dragenter/leave 成对计数，直接布尔会被子元素抖没
  const slashMenu = !picked && q.startsWith("/");
  const slashFilter = slashMenu ? q.slice(1).trim() : "";
  const menuItems = slashMenu
    ? SLASH_FUNCS.filter((f) => !slashFilter || f.label.includes(slashFilter) || f.k.startsWith(slashFilter.toLowerCase()))
    : [];
  const slashActive = !!picked || slashMenu;
  // 「交给秘书」态：选了功能、菜单开着、或者带着一张图 —— 三种情况输入框里的字都是
  // 要发给秘书的内容，不是搜索词（普通查询停掉，结果列表不出）。
  const handoff = slashActive || !!att;

  // 换 / 清面板里的图：旧的预览 URL 要 revoke（一张 10 MB 的 blob 挂着不放白占内存）。
  // 只碰 ref 与 setter，所以 onShown 那种 [] 依赖的回调也能安全地用它。
  const putAtt = useCallback((next: PanelAtt | null) => {
    const prev = attRef.current;
    if (prev && prev !== next) URL.revokeObjectURL(prev.url);
    attRef.current = next;
    setAtt(next);
  }, []);
  const flash = (msg: string, ms = 1200) => { setToast(msg); window.setTimeout(() => setToast(""), ms); };
  // 收图（拖入 / ⌘V 共用）：只认 image/*；超 10 MB 拒收；已有一张就替换 + 吐司。
  // 一次拖多张只收第一张（一期 1 张）。发送中不收 —— 图正在传，换掉它会发出去不是这张。
  const takeFiles = (files: File[]) => {
    if (busy.current) return;
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) { if (files.length) flash("只收图片"); return; }
    const f = imgs[0];
    if (f.size > IMG_MAX_BYTES) { flash(`这张 ${fmtSize(f.size)}，超过单张 10 MB 上限`, 1600); return; }
    const replacing = !!attRef.current;
    putAtt({ file: f, url: URL.createObjectURL(f) });
    if (replacing) flash("已换成新的这张");
    else if (imgs.length > 1) flash("只收 1 张，收了第一张");
  };
  // 把面板里的图传上去拿 file_id（传过的直接复用）。[] = 没图；null = 传失败（当离线处理）。
  const ensureUploaded = async (): Promise<string[] | null> => {
    const a = attRef.current;
    if (!a) return [];
    if (a.fileId) return [a.fileId];
    const id = await uploadPanelImage(a.file);
    if (!id) return null;
    a.fileId = id;   // 就地记下：fileId 不参与渲染，不必换对象
    return [id];
  };
  // 离线态：上传失败 / 主进程探测不通都走这里。图留在面板状态里，重试不用重选。
  const goOffline = () => { setOnline(false); setFeedback("offline"); };

  const sendSlash = async (f: SlashFunc, text: string) => {
    const t = text.trim();
    // 带图时纯图允许发（「记一笔：」+ 一张小票就够秘书看图记账），没图才要求说点内容。
    if (!t && !attRef.current) { setFeedback("needBody"); return; }
    if (busy.current) return;
    busy.current = true; setSending(true);
    try {
      // 带图先探一下可达性：主进程 slashSend 反正要探（8s 缓存），探不通就别白传一张 10 MB 的图。
      if (attRef.current && !(await api.assistantOnline().catch(() => false))) { goOffline(); return; }
      const atts = await ensureUploaded();
      if (!atts) { goOffline(); return; }
      const r = await api.slashSend(f.k, t, atts.length ? atts : undefined).catch(() => ({ ok: false }));
      if (!r.ok) { goOffline(); return; }
      // 「已交给秘书」只闪一帧就收起 —— 收起动作本身就是反馈，面板里不画「已添加」（稿定）。
      setFeedback("sent");
      setTimeout(() => { void api.hide(); }, 600);
    } finally { busy.current = false; setSending(false); }
  };
  // 没选动作时的「发给秘书」（⌘↵；带图时回车也走这里）：有图先传图，传不上按离线处理；
  // 发出去后主进程自己收面板（sendAssistant 里 hide），这里再 hide 一次只是兜底。
  const sendPlain = async (text: string) => {
    const t = text.trim();
    if (!t && !attRef.current) return;
    if (busy.current) return;
    busy.current = true; setSending(true);
    try {
      const atts = await ensureUploaded();
      if (!atts) { goOffline(); return; }
      await api.sendAssistant(t, atts.length ? atts : undefined).catch(() => {});
      void api.hide();
    } finally { busy.current = false; setSending(false); }
  };
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
      setPicked(null); setMenuSel(0); setFeedback(""); setOnline(null);
      putAtt(null);   // 上一回合的图跟着输入一起清（文字都清了，图单独留着只会吓人一跳）
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
    return () => { off(); putAtt(null); };
  }, [putAtt]);

  // 拖图进面板：document 级把 dragover / drop 的默认行为掐掉，否则松手在 .box 之外
  // （wrap 那圈 10px 透明边）会让 Chromium 直接导航去打开那张图，面板页面就没了。
  useEffect(() => {
    const prevent = (e: DragEvent) => { e.preventDefault(); };
    document.addEventListener("dragover", prevent);
    document.addEventListener("drop", prevent);
    return () => {
      document.removeEventListener("dragover", prevent);
      document.removeEventListener("drop", prevent);
    };
  }, []);

  // 防抖查询。
  //
  // **带序号防乱序**：Script Filter 会起真进程，一次查询几百毫秒到几秒不等，
  // 快慢完全取决于脚本。慢的那一次要是后回来，就会把新词的结果盖掉 ——
  // 表现是「打完字之后列表跳回上一个词的结果」，甚至闪一条早就过期的报错。
  // 只认最后一次发出的那个请求。
  const qSeq = useRef(0);
  useEffect(() => {
    // 「交给秘书」态（菜单 / 已选功能 / 带图）不走普通查询：菜单是本地过滤的四项，
    // chip 态与带图态的 q 是要发给秘书的内容，拿去搜应用只会闪一堆无关结果。
    if (handoff) {
      ++qSeq.current;   // 作废在途的普通查询，别让它回来把菜单顶掉
      window.clearTimeout(timer.current);
      setResults([]);
      return;
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const mine = ++qSeq.current;
      const r = await api.query(q);
      if (qSeq.current !== mine) return;   // 已经有更新的查询发出去了，这一份作废
      ptr.current = null;
      setResults(r);
      setSel(0);
    // 防抖从 120 压到 60：主进程那头 Spotlight 已经改成后台补充（见 launcher/index.ts
    // searchApps），一次查询只剩内存匹配，再留 120ms 就纯粹是在等自己。
    // 60 仍然够把一串连击合并成一次查询（连打的键间隔通常 <50ms）。
    }, 60);
    return () => window.clearTimeout(timer.current);
  }, [q, handoff]);

  // 输入一变就清掉「说点内容」和离线卡（用户开始改了，旧反馈失效）；sent 不清 —— 马上要收起。
  // 换图 / 删图同理。
  useEffect(() => { setFeedback((f) => (f === "sent" ? f : "")); }, [q, picked, att]);
  // 菜单打开时探一次秘书可达性；「问秘书」兜底项出现时也探（离线转灰要用）。
  useEffect(() => {
    if (slashMenu || results.some((r) => r.source === "assistant")) {
      void api.assistantOnline().then(setOnline).catch(() => setOnline(false));
    }
  }, [slashMenu, results]);
  // 菜单过滤后选中行出界就拉回来。
  useEffect(() => { if (menuSel >= menuItems.length) setMenuSel(Math.max(0, menuItems.length - 1)); }, [menuItems.length, menuSel]);

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

  // 窗口贴合内容高度：搜索框 + 列表 / 菜单 / 反馈卡 / 缩略条（+ 内边距），消除空白/暗框。
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      // 直接量 .box 的内容高度：列表、slash 菜单、sent/offline 卡、带图缩略条谁在就算谁，
      // 不用每加一种内容就多一路手工累加（缩略是定死的 64×64，图还没加载完高度也是准的）。
      const bh = boxRef.current?.scrollHeight ?? 74;
      void api.resize(Math.ceil(bh + 22)); // 22 = wrap 上下 padding(20) + 边框(2)
    });
    return () => cancelAnimationFrame(id);
  }, [results, slashMenu, menuItems.length, picked, feedback, att, sending]);

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
    // ──「/」菜单态：↑↓ 在四项里选，回车 / Tab 选中（前缀收成胶囊，光标留在后面）。
    if (slashMenu) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMenuSel((s) => Math.min(s + 1, Math.max(0, menuItems.length - 1))); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setMenuSel((s) => Math.max(s - 1, 0)); }
      else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const f = menuItems[menuSel];
        if (f) { setPicked(f); setQ(""); setFeedback(""); }
      }
      else if (e.key === "Escape") { e.preventDefault(); void api.hide(); }
      return;
    }
    // ── 已选功能态：回车发给秘书；退格删空内容再退一次回菜单。
    if (picked) {
      if (e.key === "Enter") { e.preventDefault(); void sendSlash(picked, q); }
      else if (e.key === "Backspace" && q === "") { e.preventDefault(); setPicked(null); setQ("/"); setMenuSel(SLASH_FUNCS.findIndex((f) => f.k === picked.k)); }
      else if (e.key === "Escape") { e.preventDefault(); void api.hide(); }
      return;
    }
    // ── 带图、没选动作：面板已经是「交给秘书」态（结果列表不出），回车 / ⌘↵ 都是把话和图交给秘书。
    // 要挑动作就打「/」进菜单，图留着不动。
    if (att) {
      if (e.key === "Enter") { e.preventDefault(); void sendPlain(q); }
      else if (e.key === "Escape") { e.preventDefault(); void api.hide(); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, Math.max(0, results.length - 1))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey) {
        // ⌘↵：若选中的是带 cmd 分支的工作流结果 → 走该分支；否则把输入文字发给秘书。
        const r = results[sel];
        if (r?.mods?.includes("cmd")) void runAt(sel, "cmd");
        else if (q.trim()) void sendPlain(q);
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

  // ⌘V 粘图：剪贴板里有文件才接管（截图 / Finder 里复制的图），纯文字照常粘进输入框。
  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    takeFiles(files);
  };
  // 拖图：整个 .box 是落点。只对带文件的拖拽亮描边（拖一段文字进来不算）。
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");
  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = busy.current ? "none" : "copy";
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    takeFiles([...(e.dataTransfer?.files || [])]);
  };

  // 「问秘书」兜底项离线转灰（42% + 「离线」角标）不消失 —— 消失会让人以为功能没了（稿定）。
  const dimAssistant = (r: LauncherResult) => r.source === "assistant" && online === false;
  // 离线卡的「重试」：选了动作走 slashSend，否则走 sendAssistant（带图没选动作也会离线）。
  const retry = () => { if (picked) void sendSlash(picked, q); else void sendPlain(q); };

  return (
    <div className="wrap">
      <style>{CSS}</style>
      <div className={`box ${dragOver ? "dragover" : ""}`} ref={boxRef}
        onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        {att ? (
          <div className="attwrap">
            <div className={`att ${attUnusable(picked) ? "dim" : ""}`}>
              <span className="thumb">
                <img src={att.url} alt="" />
                <button className="rm" title="去掉这张" disabled={sending} onClick={() => { if (!busy.current) putAtt(null); }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              </span>
              {picked && attUnusable(picked) ? (
                <span className="au">「{picked.label}」用不上图片，图会跟着消息发到聊天</span>
              ) : (
                <div className="am">
                  <span className="ac">{picked ? ATT_COPY[picked.k] : "交给秘书时一起带上"}</span>
                  <span className="af">{att.file.name} · {fmtSize(att.file.size)}</span>
                </div>
              )}
            </div>
          </div>
        ) : null}
        <div className="search" ref={searchRef}>
          <span style={{ fontSize: 20 }}>🔍</span>
          {picked ? (
            <span className="chip">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={picked.d} /></svg>
              {picked.label}
              <span className="arr">›</span>
            </span>
          ) : null}
          <input
            ref={inputRef}
            className="q"
            value={q}
            placeholder={picked ? "要交给秘书的内容…" : att ? "要一起交给秘书的话（可不填）…" : "搜索应用、文件夹、常用语…"}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
            autoFocus
          />
          {feedback === "needBody" ? (
            <span className="needbody">说点内容，秘书才知道记什么</span>
          ) : (
            <span className="hint">
              {sending ? (att ? "正在上传图片…" : "正在发送…")
                : slashMenu ? "↵ 选中 · esc 关闭"
                : (picked || att) ? "↵ 交给秘书 · esc 关闭"
                : <>{results[sel]?.autocomplete ? "⇥ 补全 · " : ""}{results[sel]?.quicklook ? "⌘Y 预览 · " : ""}↵ 打开 · ⌘↵ 发给秘书 · esc 关闭</>}
            </span>
          )}
        </div>
        {slashMenu && menuItems.length ? (
          <div className="slash">
            <div className="cap">交给秘书整理后入库</div>
            {menuItems.map((f, i) => (
              <div key={f.k} className={`srow ${i === menuSel ? "sel" : ""}`}
                onMouseMove={(e) => { const prev = ptr.current; ptr.current = { x: e.clientX, y: e.clientY }; if (prev && (prev.x !== e.clientX || prev.y !== e.clientY)) setMenuSel(i); }}
                onClick={() => { setPicked(f); setQ(""); setFeedback(""); }}>
                <span className="sbox"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={f.d} /></svg></span>
                <span className="sname">{f.label}</span>
                <span className="ssample">{f.sample}</span>
                {i === menuSel ? <span className="spick">↩ 选中</span> : null}
              </div>
            ))}
          </div>
        ) : null}
        {picked && !feedback && !att ? (
          <div className="picked-note">回车把这句话交给秘书，由它整理字段后落进「{picked.label}」。退格删空内容再退一次，回到功能列表。</div>
        ) : null}
        {att && !feedback && !slashMenu ? (
          <div className="att-note">{attNote(picked)}</div>
        ) : null}
        {feedback === "sent" && picked ? (
          <div className="sent">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ok-fg)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M20 6 9 17l-5-5" /></svg>
            <span className="st">已交给秘书 · {picked.label}</span>
            <span className="ss">面板随即收起，整理结果在聊天里回你</span>
          </div>
        ) : null}
        {feedback === "offline" ? (
          <div className="offline">
            <div className="ot">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--err-fg)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M15 9l-6 6M9 9l6 6" /></svg>
              发不出去：没连上服务端
            </div>
            <div className="ob">秘书要走服务端通道，现在连不上。你打的内容还留在输入框里，不会丢。</div>
            {att ? <div className="ob">图还在本地，连上后重发不用重新选。</div> : null}
            <div className="oa">
              <button onClick={retry} disabled={sending}>重试</button>
              <button onClick={() => { void navigator.clipboard.writeText(q); flash("已复制内容", 900); }}>复制内容</button>
            </div>
          </div>
        ) : null}
        {!handoff && results.length ? (
          <div className="list" ref={listRef}>
            {results.map((r, i) => (
              <div key={r.id} className={`row ${i === sel ? "sel" : ""} ${r.wrap ? "wrap" : ""} ${dimAssistant(r) ? "offdim" : ""}`} onMouseMove={(e) => hover(i, e)} onClick={() => runAt(i)}>
                <span className="ico">
                  {r.icon && r.icon.startsWith("data:") ? <img src={r.icon} alt="" /> : <span>{r.icon || "•"}</span>}
                </span>
                <div className="meta">
                  <div className="title">{r.title}</div>
                  {r.subtitle ? <div className="sub">{r.subtitle}</div> : null}
                </div>
                {dimAssistant(r) ? <span className="offbadge">离线</span> : null}
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
