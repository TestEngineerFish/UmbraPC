// 密码保险箱界面。视觉按 ClaudeDesign 稿；数据 / IPC 走真实后端，逻辑与旧版完全一致。
// 流程：初始化（创建主密码 → 保存 Secret Key）/ 解锁 / 身份库切换 / 分组可改名删除（右键菜单）/
// 列表搜索与多选 / 模块化控件详情（查看·编辑）/ 附件 / 密码生成器 / 深浅色切换。
// 两种承载方式：独立窗口（vault-entry）与嵌在主窗口「工具 → 密码保险箱」右侧（embedded）。
// 样式统一走 Tailwind + CSS 变量（vault-entry 已引入 index.css，独立窗口里同样生效）；
// inline style 只留给真正动态的值：右键菜单坐标、monogram 尺寸、强度条百分比、动画延迟。
import { useCallback, useEffect, useRef, useState } from "react";
import { formatAgo, useNow } from "../../services/relativeTime";
import type { ComponentType, CSSProperties, ReactNode, SVGProps } from "react";
import { Pill, btnGhost, btnPrimary, selectBox, fieldFlex, EmptyState } from "../../components/ui";
// 附件删除走全局的确认弹窗与吐司：保险箱自己那套 setConfirm / flash 挂在 Main 上，
// 而附件在组件树很深的 Gallery 里，够不着。overlay 是模块级单例，独立窗口也已经挂了 OverlayHost。
import { askConfirm, showToast } from "../../components/overlay";
import { ImageViewer } from "../../components/ImageViewer";
import { CAT_ICON, CAT_LABEL, PICK_ICONS } from "../money/moneyKit";
import { IconPickerPop, IconThumb, compressIcon, type IconOption } from "../../components/IconPicker";
import { useHotkeyRecorder } from "../../components/HotkeyRecorder";
import { displayAccel } from "../../components/hotkey";
import { useHotkeyConflict, OWNER_LABEL } from "../tools/hotkeys";
import {
  IconAlert, IconCheck, IconChevronDown, IconChevronRight, IconCloud, IconCopy, IconDice, IconDots,
  IconDownload, IconExternal, IconEye, IconEyeOff, IconFile, IconFolder, IconGrid, IconImage, IconKey,
  IconLock, IconPencil, IconPlus, IconRefresh, IconSearch, IconStar, IconTag,
  IconText, IconTouchId, IconTrash, IconUp, IconDown, IconUser, IconX, IconKeyboard, IconWindow,
} from "../../components/icons";

interface VaultInfo { id: string; name: string; owner: string; icon: string; order: number }
interface VType { id: string; name: string; icon: string; order: number }
interface Att { id: string; name: string; mime: string; size: number; addedAt: number }
interface Block { id: string; type: string; label?: string; data: Record<string, unknown> }
interface Item { id: string; typeId: string; title: string; icon?: string; favorite?: boolean; tags?: string[]; blocks: Block[]; attachments: Att[]; createdAt: number; updatedAt: number; revision: number }

// syncing / syncAt / syncError 是自动同步的实时状态（主进程内存里的，锁一次就清）。
interface VStatus { exists: boolean; unlocked: boolean; autoLockMin: number; quickUnlock: boolean; biometric: boolean; shortcut: string; syncConfigured: boolean; syncRev: number; syncing: boolean; syncAt: number; syncError: string }
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
  syncNow(): Promise<{ ok: boolean; rev: number; pulled: boolean }>;
  onSyncState(cb: (s: { syncing: boolean; lastAt: number; lastError: string; pulled: boolean }) => void): () => void;
  exportBackup(): Promise<{ ok: boolean; path?: string }>;
  exportPlain(): Promise<{ ok: boolean; path?: string }>;
  importPick(): Promise<{ ok: boolean; needPassword: boolean }>;
  importApply(vid: string, mp?: string, sk?: string): Promise<{ ok: boolean; added: number }>;
  downloadTemplate(kind: string): Promise<{ ok: boolean; path?: string }>;
  generatePassword(opts: unknown): Promise<string>;
  listVaults(): Promise<VaultInfo[]>;
  addVault(name: string, owner: string, icon: string): Promise<string>;
  updateVault(id: string, patch: { name?: string; icon?: string }): Promise<void>;
  deleteVault(id: string): Promise<void>;
  listTypes(vid: string): Promise<VType[]>;
  addType(vid: string, name: string, icon: string): Promise<string>;
  updateType(vid: string, tid: string, patch: Partial<VType>): Promise<void>;
  deleteType(vid: string, tid: string): Promise<void>;
  listItems(vid: string): Promise<Item[]>;
  addItem(vid: string, init: Partial<Item>): Promise<string>;
  updateItem(vid: string, item: Item): Promise<void>;
  deleteItem(vid: string, iid: string): Promise<void>;
  deleteItems(vid: string, ids: string[]): Promise<number>;
  moveItem(vid: string, iid: string, tid: string): Promise<void>;
  addAttachment(vid: string, iid: string, name: string, mime: string, dataB64: string): Promise<Att>;
  readAttachment(vid: string, aid: string): Promise<string>;
  deleteAttachment(vid: string, iid: string, aid: string): Promise<void>;
  // 「承载方式」相关：唤起快捷键与独立窗口。preload 里一直有，之前只有 VaultTool 在用，
  // 这个接口里没声明 —— 现在两个控件都收进保险箱自己的 ⋯ 菜单，就得在这儿声明。
  setShortcut(acc: string): Promise<void>;
  openWindow(): Promise<void>;
}
const api = (window as unknown as { umbraVault: VaultAPI }).umbraVault;

// 可添加的控件类型。图标一律用线性 outline（原先是彩色 emoji，跨平台字形与基线对不齐）。
type IconComp = ComponentType<Omit<SVGProps<SVGSVGElement>, "width" | "height"> & { size?: number }>;

// 分组 / 记录的图标（批次 009 定稿）：保险箱用**专属 16 个**（umbra-icons.json 的
// vaultSet，其中 10 个是这批新画的，group:"vault"）—— 餐饮 / 出行 / 工资挂在密码分组上
// 是错的语义，用户第一反应是自己点错了。语义名落 VType.icon / Item.icon；自定义图片存
// 压缩后的 data URL；显示与选择都走通用的 IconThumb / IconPickerPop（components/IconPicker）。
// d 是整段 svg 内部标记（这批图标带 circle/rect），照 icons.json 的 body 抄，别改画。
const VAULT_ICONS: IconOption[] = [
  { k: "key", label: "钥匙", d: '<path d="M7.5 12.9a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2M10.1 14 20 4.1M16.4 7.7l2.4 2.4M13.5 10.6l2.1 2.1"/>' },
  { k: "credit-card", label: "银行卡", d: '<path d="M4.5 5.5h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2M2.5 10h19M6 14.5h4"/>' },
  { k: "id-card", label: "证件", d: '<path d="M4.5 5h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2M8.6 9a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2M5.4 16.4c.5-1.4 1.8-2.2 3.2-2.2s2.7.8 3.2 2.2M15 9.6h4M15 13h3"/>' },
  { k: "wallet", label: "钱包", d: '<path d="M4 9.5h16a1.6 1.6 0 0 1 1.6 1.6v6.8A1.6 1.6 0 0 1 20 19.5H4a1.6 1.6 0 0 1-1.6-1.6v-6.8A1.6 1.6 0 0 1 4 9.5M6.4 9.5l9.2-4.8a1 1 0 0 1 1.4.5l1.4 3.3M17 14.6h.01"/>' },
  { k: "membership-card", label: "会员卡", d: '<path d="M4.5 5.5h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2M7.6 9.4l1.2 2.4 2.7.4-2 1.9.5 2.6-2.4-1.3-2.4 1.3.5-2.6-2-1.9 2.7-.4zM14.5 11.3h4.5M14.5 14.4h3"/>' },
  { k: "server", label: "服务器", d: '<path d="M5 4h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2M5 13h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2M6.8 7.5h.01M6.8 16.5h.01M10.5 7.5h3.5M10.5 16.5h3.5"/>' },
  { k: "wifi", label: "Wi-Fi", d: '<path d="M2.6 9.4a13.2 13.2 0 0 1 18.8 0M6.1 13.1a8.1 8.1 0 0 1 11.8 0M9.5 16.8a3.7 3.7 0 0 1 5 0M12 20.4h.01"/>' },
  { k: "cloud", label: "云服务", d: '<path d="M7.2 19a4.6 4.6 0 0 1-.6-9.1 6.1 6.1 0 0 1 11.6 1.5A4 4 0 0 1 17.4 19z"/>' },
  { k: "globe", label: "网站", d: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18"/>' },
  { k: "mail", label: "邮箱", d: '<path d="M4.5 5h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2M3.4 7.6 12 13.3l8.6-5.7"/>' },
  { k: "device-phone", label: "手机", d: '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M10.5 5.5h3"/>' },
  { k: "device-mac", label: "电脑", d: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M2 20h20"/>' },
  { k: "building", label: "机构", d: '<path d="M4 20.5V5a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 15 5v15.5M15 10h3.5A1.5 1.5 0 0 1 20 11.5v9M2.5 20.5h19M7.5 7.5h1M11 7.5h1M7.5 11.5h1M11 11.5h1M8.4 20.5V16h2.2v4.5"/>' },
  { k: "shield", label: "安全", d: '<path d="M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6z"/>' },
  { k: "lock", label: "密码", d: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>' },
  { k: "folder", label: "分组", d: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' },
];
// **显示解析**用大集：专属 16 个 + 记账那批（上一轮存量数据里可能已经挑了 gift / housing
// 这类语义名，换候选集不能让它们一夜之间变回 monogram）。**弹层候选**只传 VAULT_ICONS。
const RESOLVE_ICONS: IconOption[] = [
  ...VAULT_ICONS,
  ...PICK_ICONS.filter((o) => !VAULT_ICONS.some((v) => v.k === o.k)),
  ...Object.entries(CAT_LABEL)
    .filter(([k]) => CAT_ICON[k] && !VAULT_ICONS.some((v) => v.k === k))
    .map(([k, label]) => ({ k, label, d: CAT_ICON[k] })),
];
const randomGroupIcon = (used: string[]): string => {
  const free = VAULT_ICONS.filter((o) => !used.includes(o.k));
  const pool = free.length ? free : VAULT_ICONS;
  return pool[Math.floor(Math.random() * pool.length)].k;
};
const CTLS: { type: string; name: string; Icon: IconComp }[] = [
  { type: "account", name: "账号", Icon: IconUser },
  { type: "secret", name: "密文", Icon: IconKey },
  { type: "field", name: "字段", Icon: IconTag },
  { type: "text", name: "文本", Icon: IconText },
  { type: "images", name: "图片", Icon: IconImage },
  { type: "files", name: "文件", Icon: IconFile },
];
const TAG: Record<string, string> = { account: "账号", secret: "密文", text: "文本", field: "字段", images: "图片", files: "文件" };
const rid = (p = "") => p + Math.random().toString(36).slice(2, 10);
function newBlock(type: string): Block {
  const data: Record<string, unknown> = type === "account" ? { username: "", password: "", url: "", otp: false }
    : type === "images" || type === "files" ? { atts: [] } : { value: "" };
  // label 起手是**空的**，不是 TAG[type]。
  // 控件卡头上已经有一颗写着类型的胶囊（「账号」「密文」…），label 是**用户自己起的名字**
  // （「公司邮箱」「NAS 后台」这种）。初始化成和胶囊一样的字，查看态就并排出现两个「账号」。
  // 空着的话胶囊自己就够用了，用户想区分同类控件时再填。
  return { id: rid("b"), type, label: "", data };
}

// 只留关键帧与选区色：悬停/聚焦这些状态类已经全部由 Tailwind 的 hover: / focus: 变体接管。
const CSS = `
@keyframes vToastIn{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes vPop{from{opacity:0;transform:translateY(-4px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes vLockPulse{0%,100%{transform:scale(1);box-shadow:0 0 0 0 rgba(232,89,12,.28)}50%{transform:scale(1.03);box-shadow:0 0 0 14px rgba(232,89,12,0)}}
@keyframes vDetailIn{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
@keyframes vBlockIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.v-root ::selection{background:rgba(232,89,12,.22)}
`;

// ── 共用类名 ──
// 大号输入框（创建 / 解锁 / 弹窗），控件圆角统一 8px。
// 保险箱是独立窗口，整体字号比主窗大一档（输入 13.5 / 按钮 13.5），这一档**不在设计包里**，
// 是本模块自己的取舍，见交付清单。但聚焦态照设计硬规则补上：描边转橙 + 3px 橙软光环。
const vInput = "w-full border border-border bg-card text-text rounded-[7px] px-[12px] py-[9px] text-[13.5px] outline-none transition-[border-color,box-shadow] duration-[130ms] ease-out hover:border-orange focus:border-orange focus:shadow-[var(--focus-ring)]";
// 卡片内的小号输入框（详情编辑态）。
const vInputSm = "w-full border border-border bg-bg text-text rounded-[7px] px-[11px] py-[8px] text-[13px] outline-none transition-[border-color,box-shadow] duration-[130ms] ease-out hover:border-orange focus:border-orange focus:shadow-[var(--focus-ring)]";
// 整宽主按钮（创建 / 解锁 / 进入保险箱）。看起来禁用的一定真禁用，disabled 样式在这里一并声明。
const vBtnWide = "w-full inline-flex items-center justify-center gap-[6px] whitespace-nowrap px-[15px] py-[10px] bg-orange text-white border-none rounded-[7px] text-[13.5px] font-semibold cursor-pointer hover:bg-orange-deep disabled:bg-chip disabled:text-faint disabled:cursor-not-allowed disabled:hover:bg-chip disabled:hover:text-faint";
// 等分的次要按钮（Secret Key 页的复制 / 下载）。不能复用 btnGhost：它带 flex-none，和 flex-1 是同一个属性会互相盖。
const vBtnSplit = "flex-1 inline-flex items-center justify-center gap-[6px] whitespace-nowrap px-[12px] py-[7px] border border-border bg-card text-text rounded-[7px] text-[12.5px] cursor-pointer hover:border-orange hover:text-orange-text";
// 虚线的「新建」按钮（新建分组 / 添加控件 / 添加附件）。
// 主进程抛过来的错误经 IPC 会被套成 "Error invoking remote method 'vault:xxx': Error: 正文"。
// 界面上只该出现「正文」—— 前面那串是 Electron 的内部措辞，用户看不懂也不该看。
const ipcErr = (e: unknown): string =>
  String(e instanceof Error ? e.message : e)
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^Error:\s*/, "")
    .trim();

const vDash = "w-full inline-flex items-center justify-center gap-[6px] whitespace-nowrap border border-dashed border-border bg-transparent text-muted rounded-[7px] py-[8px] text-[12.5px] cursor-pointer hover:border-orange hover:text-orange-text";
// 纯文字的小按钮（多选、切换解锁方式这类）。
const vTextBtn = "flex-none whitespace-nowrap inline-flex items-center gap-[5px] bg-transparent border-none p-0 text-[11.5px] text-muted cursor-pointer hover:text-orange-text disabled:text-faint disabled:cursor-not-allowed disabled:hover:text-faint";
// 卡片内的图标小按钮（复制、显示密码、调序、删除控件）。
const vIconBtn = "w-[24px] h-[24px] flex-none inline-flex items-center justify-center bg-transparent border-none rounded-[7px] text-muted cursor-pointer hover:bg-hover hover:text-orange-text disabled:text-faint disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-faint";
// 菜单/下拉的浮层外壳。
const vPanel = "absolute z-40 bg-card border border-border rounded-[12px] p-[6px] shadow-[shadow:var(--shadow-floating)]";
// 分组小标题。
const vGroupHead = "text-[10.5px] font-semibold tracking-[.06em] text-faint px-[10px] pt-[4px] pb-[5px]";

// 密码强度：长度 8 / 12 / 16 各一分，再加「大小写混用」「含数字」「含符号」各一分。≥5 强，≥3 中，其余弱。
function pwStrength(p: string): { pct: number; label: string; bar: string; text: string } {
  let s = 0;
  if (p.length >= 8) s += 1;
  if (p.length >= 12) s += 1;
  if (p.length >= 16) s += 1;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s += 1;
  if (/\d/.test(p)) s += 1;
  if (/[^A-Za-z0-9]/.test(p)) s += 1;
  const pct = Math.round((s / 6) * 100);
  if (s >= 5) return { pct, label: "强", bar: "bg-success", text: "text-success" };
  if (s >= 3) return { pct, label: "中", bar: "bg-warning", text: "text-warning" };
  return { pct: Math.max(pct, 12), label: "弱", bar: "bg-danger", text: "text-danger" };
}

// 相对时间：一小时内按分钟，一天内按小时，一个月内按天，更早直接给日期。
function ago(ts: number): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 60000) return "刚刚";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

// 字母 monogram 方块：取名称首字符，替代原先的彩色 emoji。
// plain 走中性灰底（分组、类型这类次要对象），默认走浅橙底（记录、身份库）。
function Mono({ text, size = 34, radius = 10, font = 13, plain }: { text: string; size?: number; radius?: number; font?: number; plain?: boolean }) {
  return (
    <span
      className={`flex-none inline-flex items-center justify-center font-semibold select-none ${plain ? "bg-chip text-muted" : "bg-orange-soft text-orange-text"}`}
      style={{ width: size, height: size, borderRadius: radius, fontSize: font }}
    >
      {(text || "?").trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

// 居中模态外壳：点遮罩关闭，内容区阻止冒泡。宽度由调用方定（设计稿里 320 / 330 / 360 / 380 / 440 都有）。
function Modal({ width, onClose, children }: { width: number; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div
        className="bg-card border border-border rounded-[12px] p-[18px] shadow-[shadow:var(--shadow-floating)] max-h-[82vh] overflow-y-auto"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

// 危险操作确认弹窗。Electron 里 window.confirm 会阻塞渲染进程，所以一律自绘。
// 这里的「确认」是全局唯一允许用红色实心按钮的地方，其余危险操作都用红描边 + 悬停填红。
function ConfirmModal({ title, desc, okLabel, onOk, onClose }: { title: string; desc: string; okLabel: string; onOk: () => void; onClose: () => void }) {
  return (
    <Modal width={380} onClose={onClose}>
      <div className="flex items-start gap-[12px]">
        <span className="w-[36px] h-[36px] rounded-[9px] flex-none inline-flex items-center justify-center bg-danger-soft text-danger"><IconAlert size={18} /></span>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold">{title}</div>
          <div className="text-[12.5px] text-muted leading-[1.6] mt-[4px]">{desc}</div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-[8px] mt-[18px]">
        <button className={btnGhost} onClick={onClose}>取消</button>
        <button
          className="flex-none whitespace-nowrap px-[15px] py-[6px] bg-danger text-white border-none rounded-[8px] text-[12.5px] font-semibold cursor-pointer"
          onClick={onOk}
        >{okLabel}</button>
      </div>
    </Modal>
  );
}

// 深浅色跟随主窗口：全软件只有标题栏那一个主题入口，它把开关写在这个 localStorage key 上
// （见 app/shell.ts 的同名常量）。独立窗口（vault.html）与主窗口同源，读同一个 key 即可；
// storage 事件只在「别的窗口写入」时触发，正好用来实时跟随主窗口的切换。
// 这里刻意不 import shell.ts —— 那会把 chat / services 整条依赖拉进保险箱这个入口的 bundle。
const LS_THEME = "umbra.theme";

// 读取已持久化的外观偏好并解析成实际深浅（"system" 时看系统的 prefers-color-scheme）。
// storage 被禁或没有 matchMedia 时按浅色兜底，不让它抛出打断渲染。
function readDark(): boolean {
  try {
    const v = localStorage.getItem(LS_THEME);
    if (v === "dark") return true;
    if (v === "system") return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    return false;
  } catch { return false; }
}

export function VaultApp({ embedded = false }: { embedded?: boolean }) {
  const [dark, setDark] = useState(readDark);
  const [ready, setReady] = useState(false);
  const [st, setSt] = useState<VStatus>({ exists: false, unlocked: false, autoLockMin: 10, quickUnlock: false, biometric: false, shortcut: "", syncConfigured: false, syncRev: 0, syncing: false, syncAt: 0, syncError: "" });
  useEffect(() => { void api.status().then((s) => { setSt(s); setReady(true); }); }, []);
  const refresh = useCallback(async () => setSt(await api.status()), []);
  // 独立窗口时跟随主窗口的主题：storage 事件负责实时跟随，focus 兜底一次
  // （窗口被隐藏期间浏览器可能压掉事件）。嵌入主窗口时整棵树继承外层的 data-theme，什么都不用做。
  useEffect(() => {
    if (embedded) return;
    const sync = () => setDark(readDark());
    const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === LS_THEME) sync(); };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", sync);
    // 主窗口选了「跟随系统」时，本窗口也要跟着系统日夜走（storage 事件这时不会触发）。
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener("change", sync);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", sync);
      mq?.removeEventListener("change", sync);
    };
  }, [embedded]);

  return (
    // 嵌入时不自己声明 data-theme（继承主窗口的），高度也从整屏改成填满父容器。
    <div
      className="v-root bg-bg text-text text-[14px]"
      data-theme={embedded ? undefined : dark ? "dark" : "light"}
      style={{ height: embedded ? "100%" : "100vh" }}
    >
      <style>{CSS}</style>
      {!ready ? null : !st.exists ? <Setup onDone={refresh} />
        : !st.unlocked ? <Unlock onDone={refresh} st={st} />
          : <Main onLock={async () => { await api.lock(); await refresh(); }} st={st} onStatus={refresh} embedded={embedded} />}
    </div>
  );
}

// 未解锁的三个态（创建 / Secret Key / 解锁）共用的居中壳：
// 顶部一层极淡的橙色光晕把视线压到中间那一列。
function Center({ children }: { children: ReactNode }) {
  return (
    <div
      className="h-full flex items-center justify-center relative"
      style={{ background: "radial-gradient(90% 70% at 50% 8%, color-mix(in srgb, var(--orange-soft) 60%, var(--bg)) 0%, var(--bg) 60%)" }}
    >
      {children}
    </div>
  );
}

// 首次初始化：先创建主密码，成功后立刻展示 Secret Key（只显示这一次）。
// Touch ID 开关放在创建这一步：enableQuickUnlock 需要已解锁态，而 setup 成功后正好就是解锁态，
// 所以这里先用本地 wantBio 记住意愿，创建成功后再补一次调用。
function Setup({ onDone }: { onDone: () => Promise<void> }) {
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [err, setErr] = useState("");
  const [sk, setSk] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [wantBio, setWantBio] = useState(false);
  const [bioOk, setBioOk] = useState(false);
  // 机器不支持生物识别时整行不渲染，避免给一个点了没反应的开关。
  useEffect(() => { void api.biometricAvailable().then(setBioOk).catch(() => setBioOk(false)); }, []);

  const submit = async () => {
    if (p1.length < 6) return setErr("主密码至少 6 位");
    if (p1 !== p2) return setErr("两次输入不一致");
    setBusy(true);
    try {
      const r = await api.setup(p1);
      if (wantBio) { try { await api.enableQuickUnlock(); } catch { /* 用户取消授权：不影响创建结果，静默跳过 */ } }
      setSk(r.secretKey);
    } catch (e) { setErr(String(e).replace("Error: ", "")); } finally { setBusy(false); }
  };

  // 下载成 .txt：Secret Key 不会再显示第二次，给一个离线保存的出口。
  const dlKey = () => {
    const url = URL.createObjectURL(new Blob([sk], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "umbra-secret-key.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  if (sk) return (
    <Center>
      <div className="w-[460px] flex flex-col gap-[14px]">
        <div className="flex flex-col items-center gap-[12px]">
          <span className="w-[52px] h-[52px] rounded-[15px] flex-none inline-flex items-center justify-center bg-orange-soft text-orange-text"><IconKey size={24} /></span>
          <div className="text-center">
            <h1 className="m-0 text-[19px] font-semibold">保存你的 Secret Key</h1>
            <div className="text-[12.5px] text-muted leading-[1.7] mt-[6px]">换新设备登录时需要它 + 主密码。<br />请立即抄下 / 截图存好，它不会再次显示。</div>
          </div>
        </div>
        <div className="bg-card border border-border rounded-[12px] p-[16px] flex flex-col gap-[12px]">
          <div className="font-mono text-[14px] leading-[2] tracking-[.08em] text-center break-all bg-bg border border-border rounded-[8px] px-[12px] py-[10px]">{sk}</div>
          <div className="flex items-center gap-[8px]">
            <button className={vBtnSplit} onClick={() => void api.copy(sk)}><IconCopy size={13} />复制</button>
            <button className={vBtnSplit} onClick={dlKey}><IconDownload size={13} />下载 .txt</button>
          </div>
          <div className="text-[11.5px] text-faint leading-[1.7] pt-[12px] border-t border-border-soft">只存本机安全区，不上传服务器；与主密码一起才能解密数据。</div>
        </div>
        <label className="flex items-center gap-[9px] text-[12.5px] text-text cursor-pointer select-none">
          <input type="checkbox" className="w-[15px] h-[15px] flex-none accent-orange cursor-pointer" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span className="flex-none whitespace-nowrap">我已经把 Secret Key 保存到安全的地方</span>
        </label>
        {/* 看起来禁用的按钮必须真禁用：未勾选时 disabled，处理函数里再判一次 */}
        <button className={vBtnWide} disabled={!saved} onClick={() => { if (!saved) return; void onDone(); }}>我已保存，进入保险箱</button>
      </div>
    </Center>
  );

  const s = pwStrength(p1);
  return (
    <Center>
      <div className="w-[430px] flex flex-col gap-[14px]">
        <div className="flex flex-col items-center gap-[12px]">
          <span className="w-[52px] h-[52px] rounded-[15px] flex-none inline-flex items-center justify-center bg-orange-soft text-orange-text"><IconLock size={24} /></span>
          <div className="text-center">
            <h1 className="m-0 text-[19px] font-semibold">创建主密码</h1>
            <div className="text-[12.5px] text-muted leading-[1.7] mt-[6px]">零知识加密：主密码只有你知道，忘记将无法恢复。</div>
          </div>
        </div>
        <div className="bg-card border border-border rounded-[12px] p-[16px] flex flex-col gap-[12px]">
          <div className="flex flex-col gap-[9px]">
            <input className={vInput} type="password" value={p1} placeholder="设置主密码（≥6 位）" onChange={(e) => { setP1(e.target.value); setErr(""); }} />
            {p1 ? (
              <div className="flex items-center gap-[9px]">
                <div className="flex-1 min-w-0 h-[4px] rounded-full bg-track overflow-hidden">
                  <div className={`h-full rounded-full ${s.bar}`} style={{ width: `${s.pct}%` }} />
                </div>
                <span className={`flex-none whitespace-nowrap text-[11.5px] font-semibold ${s.text}`}>{s.label}</span>
              </div>
            ) : null}
          </div>
          <div className="relative">
            <input
              className={vInput}
              type="password"
              value={p2}
              placeholder="再输入一次"
              onChange={(e) => { setP2(e.target.value); setErr(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            />
            {/* 两次一致时右侧给个绿勾，省得用户自己核对 */}
            {p2 && p1 === p2 ? <span className="absolute right-[11px] top-1/2 -translate-y-1/2 text-success"><IconCheck size={15} /></span> : null}
          </div>
          {bioOk ? (
            <div className="flex items-center gap-[10px] pt-[12px] border-t border-border-soft">
              <span className="w-[28px] h-[28px] rounded-[8px] flex-none inline-flex items-center justify-center bg-chip text-muted"><IconTouchId size={15} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px]">启用 Touch ID 快速解锁</div>
                <div className="text-[11.5px] text-faint mt-[1px]">下次解锁可以不输主密码</div>
              </div>
              <button
                onClick={() => setWantBio(!wantBio)}
                title="启用 Touch ID 快速解锁"
                className={`w-[36px] h-[20px] flex-none rounded-full border-none cursor-pointer relative ${wantBio ? "bg-orange" : "bg-track"}`}
              >
                <span className="absolute top-[2px] w-[16px] h-[16px] rounded-full bg-white" style={{ left: wantBio ? 18 : 2 }} />
              </button>
            </div>
          ) : null}
        </div>
        <div className="flex items-start gap-[9px] bg-warning-soft text-warning rounded-[8px] px-[12px] py-[10px] text-[12px] leading-[1.7]">
          <span className="flex-none mt-[1px]"><IconAlert size={14} /></span>
          <span>主密码不保存、不上传，忘记后无法找回。</span>
        </div>
        {err ? <div className="flex items-center gap-[7px] bg-danger-soft text-danger rounded-[8px] px-[12px] py-[9px] text-[12px]"><span className="flex-none"><IconAlert size={14} /></span>{err}</div> : null}
        <button className={vBtnWide} disabled={busy || p1.length < 6 || p1 !== p2} onClick={() => void submit()}>{busy ? "创建中…" : "创建保险箱"}</button>
      </div>
    </Center>
  );
}

// 解锁态。支持三条路：Touch ID（进入即自动尝试一次）、主密码、换新设备时的主密码 + Secret Key。
function Unlock({ onDone, st }: { onDone: () => Promise<void>; st: VStatus }) {
  const [mp, setMp] = useState("");
  const [sk, setSk] = useState("");
  const [useSk, setUseSk] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const canBio = st.quickUnlock && st.biometric;
  // 验收 #2（2026-09-03）：Touch ID 解锁的底层一直都在（quickUnlock），但开关只藏在
  // 「创建时的勾选」和 ⚙︎ 菜单里，解锁页本身既不能开、也不说明为什么没有 —— 用户就会
  // 以为「不支持指纹」。现在：本机有 Touch ID 但还没启用时，解锁页直接给一个
  // 「这次解锁后启用 Touch ID」的勾（默认勾上），主密码通过就顺手把 AUK 存进 safeStorage，
  // 下次进来自动弹指纹。没有 Touch ID 的机器则明说。
  const [wantBio, setWantBio] = useState(true);
  const offerBio = st.biometric && !st.quickUnlock;
  const submit = async () => {
    setBusy(true);
    try {
      await api.unlock(mp, useSk ? sk : undefined);
      if (offerBio && wantBio) {
        try { await api.enableQuickUnlock(); showToast("已启用 Touch ID 快速解锁", { tone: "ok" }); }
        catch { /* 用户取消了系统授权：不影响这次解锁，下次还会再问 */ }
      }
      await onDone();
    }
    catch (e) { setErr(ipcErr(e)); } finally { setBusy(false); }
  };
  const touchId = async () => {
    setErr("");
    try { await api.quickUnlock(); await onDone(); }
    catch (e) {
      const m = ipcErr(e);
      // 用户自己点的「取消」不是错误：不弹红条，把光标交回主密码框就行。
      if (m.includes("TOUCHID_CANCELED")) return;
      setErr(m || "Touch ID 未通过");
    }
  };
  useEffect(() => { if (canBio) void touchId(); /* 进入即尝试 Touch ID */ }, []); // eslint-disable-line

  return (
    <Center>
      <div className="w-[380px] flex flex-col gap-[14px]">
        <div className="flex flex-col items-center gap-[13px]">
          <span
            className="w-[64px] h-[64px] rounded-[18px] flex-none inline-flex items-center justify-center bg-orange text-white"
            style={{ animation: "vLockPulse 2.6s ease-in-out infinite" }}
          ><IconLock size={28} /></span>
          <div className="text-center">
            <h1 className="m-0 text-[19px] font-semibold">保险箱已锁定</h1>
            <div className="text-[12.5px] text-muted leading-[1.7] mt-[6px]">输入主密码以解锁本地加密数据<br />主密码不保存、不上传，忘记无法找回</div>
          </div>
        </div>
        <div className="flex flex-col gap-[9px]">
          <input
            className={vInput}
            type="password"
            value={mp}
            autoFocus
            placeholder="主密码"
            onChange={(e) => { setMp(e.target.value); setErr(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          />
          {useSk ? (
            <input
              className={vInput}
              value={sk}
              placeholder="Secret Key（U1-…）"
              onChange={(e) => { setSk(e.target.value); setErr(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            />
          ) : null}
        </div>
        {err ? <div className="flex items-center gap-[7px] bg-danger-soft text-danger rounded-[8px] px-[12px] py-[9px] text-[12px]"><span className="flex-none"><IconAlert size={14} /></span>{err}</div> : null}
        <button className={vBtnWide} disabled={busy || !mp} onClick={() => void submit()}>{busy ? "解锁中…" : "解锁保险箱"}</button>
        {/* Touch ID 三态共用这一块 min-height:52px 的位置（批次 009 定稿）：切换时整页高度
            不动，锁图标和标题不跳。不可用态**顶替按钮的位置**而不是另加一行 —— 它是
            「为什么这里没有按钮」的答案，不是噪音。 */}
        <div className="min-h-[52px] flex flex-col justify-center gap-[6px]">
          {canBio ? (
            <>
              <button
                className="w-full inline-flex items-center justify-center gap-[7px] whitespace-nowrap px-[14px] py-[7px] border border-border bg-card text-text rounded-[8px] text-[12.5px] cursor-pointer hover:border-orange hover:text-orange-text"
                onClick={() => void touchId()}
              ><IconTouchId size={15} />用 Touch ID 解锁</button>
              <div className="text-center text-[11px] text-faint">进这一页会自动弹一次指纹；点了取消就用主密码，不算失败</div>
            </>
          ) : offerBio ? (
            // 左对齐、checkbox 在最左、允许折两行、不加指纹图标（上面按钮已承担这个语义）——
            // 380 宽里一行居中的长文案读起来像脚注，但它是个可操作的开关（稿定）。
            <label className="flex items-start gap-[8px] text-[12px] text-muted leading-[1.6] cursor-pointer select-none">
              <input type="checkbox" className="accent-[var(--orange)] mt-[3px] flex-none" checked={wantBio} onChange={(e) => setWantBio(e.target.checked)} />
              <span>这次解锁后启用 Touch ID 快速解锁。主密码通过就顺手启用，以后仍可以用主密码。</span>
            </label>
          ) : (
            <div className="flex items-center justify-center gap-[6px] text-[11.5px] text-faint">
              <IconTouchId size={13} />此设备当前没有可用的 Touch ID（外接键盘 / 合盖时也会不可用）
            </div>
          )}
        </div>
        <button className={`${vTextBtn} self-center`} onClick={() => { setUseSk(!useSk); setErr(""); }}>
          {useSk ? "← 本机解锁" : "换了新设备？输入 Secret Key"}
        </button>
        <div className="text-center text-[11px] text-faint">数据以 AES-256-GCM 本地加密 · 永不上传云端</div>
      </div>
    </Center>
  );
}

// 解锁后的主界面：顶栏 + 三栏（分组 196 / 列表 302 / 详情自适应）。
// 同步状态一句话。没配服务器就直说，别让用户对着一个不动的字猜。
// now 由调用方用 useNow() 给（30s 一跳），不然这行字只在状态变化时算一次，会永远停在「刚刚」。
function syncLabel(st: VStatus, now: number): string {
  if (!st.syncConfigured) return "未配置同步";
  if (st.syncing) return "同步中…";
  if (st.syncError) return `同步失败：${st.syncError}`;
  if (!st.syncAt) return "等待同步";
  return `${formatAgo(st.syncAt, now, "zh-CN")}同步`;
}

function Main({ onLock, st, onStatus, embedded }: { onLock: () => Promise<void>; st: VStatus; onStatus: () => Promise<void>; embedded: boolean }) {
  const now = useNow();
  // ── 唤起快捷键 / 独立窗口 ────────────────────────────────────────────────
  // 这两个控件原先在外面一层的 VaultTool 里，占了一条独立的 50px 顶栏 —— 于是主窗口里
  // 两条 50px 栏上下叠着，而稿（3660-3672）画的保险箱只有一条。
  //
  // 它们管的是「保险箱以什么方式承载」（全局唤起、拉到独立窗口），不是保险箱里的数据操作，
  // 设置一次基本就不再动 —— 正是溢出菜单该放的东西。收进 ⋯ 里，顶栏就回到稿的样子了。
  const shortcut = st.shortcut || "";
  const shortcutConflict = useHotkeyConflict("vault", shortcut);
  const { recording, start: startRecord } = useHotkeyRecorder((acc) => {
    void api.setShortcut(acc).then(onStatus);
  });
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
  const [manageOpen, setManageOpen] = useState(false);
  const [gearOpen, setGearOpen] = useState(false);
  const [imp, setImp] = useState({ open: false, mp: "", sk: "", err: "" });
  const [ctx, setCtx] = useState<{ open: boolean; x: number; y: number; itemId?: string }>({ open: false, x: 0, y: 0 });
  const [tctx, setTctx] = useState<{ open: boolean; x: number; y: number; typeId?: string }>({ open: false, x: 0, y: 0 });
  // 分组「换图标」弹层（验收 #3）：锚在右键位置。
  const [iconPop, setIconPop] = useState<{ x: number; y: number; type: VType } | null>(null);
  // 记录右键菜单里的「移动到…」是否已展开。默认收起，点一下才列出分组，
  // 免得分组一多菜单就被撑得老长。
  const [moveOpen, setMoveOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // 危险操作统一走自绘确认弹窗（Electron 里 window.confirm 会阻塞渲染进程）。
  const [confirm, setConfirm] = useState<{ title: string; desc: string; okLabel: string; run: () => Promise<void> } | null>(null);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(""), 1400); };
  const toggleCheck = (id: string) => setChecked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const exitSelect = () => { setSelecting(false); setChecked(new Set()); };

  useEffect(() => { void api.listVaults().then((v) => { setVaults(v); setVid(v[0]?.id || ""); }); }, []);
  const loadVault = useCallback(async (id: string) => {
    const [t, it] = await Promise.all([api.listTypes(id), api.listItems(id)]);
    setTypes(t); setItems(it);
  }, []);
  useEffect(() => { if (vid) void loadVault(vid); setSelecting(false); setChecked(new Set()); }, [vid, loadVault]);
  const refresh = useCallback(async () => { if (vid) await loadVault(vid); }, [vid, loadVault]);
  // 自动同步的状态广播：每次同步开始/结束都会来一条。pulled=true 说明本地数据被云端改过，
  // 列表要重拉一遍，否则用户看到的还是同步前那份。
  useEffect(() => {
    const off = api.onSyncState((s) => {
      void onStatus();
      if (s.pulled) void refresh();
    });
    // 低频轮询只为让「N 分钟前」自己往上走 —— 广播只在同步前后各来一次，光靠它这行字会停在原地。
    const timer = window.setInterval(() => { void onStatus(); }, 30_000);
    return () => { off(); window.clearInterval(timer); };
  }, [onStatus, refresh]);
  // 关菜单时把「移动到…」也收回去，下次右键重新从收起态开始。
  const closeMenus = () => { setIdOpen(false); setGearOpen(false); setMoveOpen(false); setCtx({ open: false, x: 0, y: 0 }); setTctx({ open: false, x: 0, y: 0 }); };

  const doExport = async (plain: boolean) => {
    setGearOpen(false);
    const r = plain ? await api.exportPlain() : await api.exportBackup();
    if (r.ok) flash(plain ? "已导出明文 JSON" : "已导出加密备份");
  };
  const doSync = async () => {
    setGearOpen(false);
    if (!st.syncConfigured) { flash("请先在 Umbra 设置里配置服务器地址与令牌"); return; }
    flash("同步中…");
    try {
      const r = await api.syncNow();
      await refresh(); await onStatus();
      flash(`已同步${r.pulled ? " · 已拉取云端更新" : ""}`);
    } catch (e) { flash(String(e).replace("Error: ", "")); }
  };
  const afterImport = async (a: { added: number }) => { setCat("all"); await refresh(); flash(`已导入 ${a.added} 条记录到当前身份库`); };
  const doImport = async () => {
    setGearOpen(false);
    try {
      const r = await api.importPick();
      if (!r.ok) return;
      if (r.needPassword) setImp({ open: true, mp: "", sk: "", err: "" });
      else await afterImport(await api.importApply(vid));
    } catch (e) { flash(String(e).replace("Error: ", "")); }
  };
  const applyImport = async () => {
    try {
      const a = await api.importApply(vid, imp.mp, imp.sk || undefined);
      setImp({ open: false, mp: "", sk: "", err: "" });
      await afterImport(a);
    } catch (e) { setImp((s) => ({ ...s, err: String(e).replace("Error: ", "") })); }
  };

  const cur = vaults.find((v) => v.id === vid);
  // 搜索只覆盖标题、标签、控件标签、账号名、网址与纯文本；密码 / 密文永不进入索引。
  const searchText = (it: Item) => {
    const p = [it.title, ...(it.tags || [])];
    it.blocks.forEach((b) => {
      if (b.label) p.push(b.label);
      if (b.type === "account") p.push(String(b.data.username || ""), String(b.data.url || ""));
      if (b.type === "text" || b.type === "field") p.push(String(b.data.value || ""));
    });
    it.attachments.forEach((a) => p.push(a.name));
    return p.join(" ").toLowerCase();
  };
  const visible = items.filter((it) => (cat === "all" || (cat === "fav" ? it.favorite : it.typeId === cat)) && (!q || searchText(it).includes(q.toLowerCase())));
  const allChecked = visible.length > 0 && visible.every((it) => checked.has(it.id));
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(visible.map((it) => it.id)));
  const batchDelete = () => {
    if (!checked.size) return;
    setConfirm({
      title: `删除选中的 ${checked.size} 条记录？`,
      desc: "删除后不可撤销，这些记录会从所有已同步的设备上移除。",
      okLabel: "删除记录",
      run: async () => {
        await api.deleteItems(vid, [...checked]);
        if (checked.has(selId)) setSelId("");
        exitSelect(); await refresh(); flash("已删除所选记录");
      },
    });
  };

  const sel = items.find((i) => i.id === selId) || null;
  const typeName = (id: string) => types.find((x) => x.id === id)?.name || "未分类";
  const counts: Record<string, number> = {};
  items.forEach((it) => { counts[it.typeId] = (counts[it.typeId] || 0) + 1; });
  const selectItem = (id: string) => { setSelId(id); setAutoEditId(null); closeMenus(); };
  const addRecord = async (title = "新记录") => {
    const typeId = types.find((t) => t.id === cat) ? cat : (types[0]?.id || "");
    const id = await api.addItem(vid, { typeId, title, blocks: [newBlock("account")] });
    await refresh(); setSelId(id); setAutoEditId(id);
  };
  const toggleFav = async (it: Item) => { await api.updateItem(vid, { ...it, favorite: !it.favorite }); await refresh(); };
  const doMove = async (iid: string, tid: string) => { await api.moveItem(vid, iid, tid); closeMenus(); await refresh(); flash(`已移动到「${typeName(tid)}」`); };
  const askDelete = (iid: string) => {
    closeMenus();
    setConfirm({
      title: "删除这条记录？",
      desc: "删除后不可撤销，该记录会从所有已同步的设备上移除。",
      okLabel: "删除记录",
      run: async () => { await api.deleteItem(vid, iid); if (selId === iid) setSelId(""); await refresh(); flash("记录已删除"); },
    });
  };
  const askDeleteType = (tid: string) => {
    closeMenus();
    setConfirm({
      title: `删除分组「${typeName(tid)}」？`,
      desc: "分组下的记录不会被删除，会保留在原处，可以重新移动到别的分组。",
      okLabel: "删除分组",
      run: async () => { await api.deleteType(vid, tid); if (cat === tid) setCat("all"); await refresh(); flash("分组已删除"); },
    });
  };
  const anyMenu = idOpen || gearOpen || ctx.open || tctx.open;
  const ctxItem = items.find((i) => i.id === ctx.itemId);
  const tctxType = types.find((t) => t.id === tctx.typeId);
  // 右键菜单跟随鼠标坐标，是这个文件里少数必须用 inline style 的地方。
  // 右键菜单定位：贴着鼠标，但不许越出窗口。点在下半屏时改成用 bottom 定位、向上生长，
  // 否则「移动到…」一展开就会被窗口底边切掉，露不出滚动条也就没法翻。
  const at = (x: number, y: number): CSSProperties => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.max(8, Math.min(x, vw - 212));
    return y > vh / 2
      ? { position: "fixed", left, bottom: Math.max(8, vh - y) }
      : { position: "fixed", left, top: y };
  };

  return (
    <div className="h-full flex flex-col relative overflow-hidden">
      {/* 顶栏 50px：身份、身份库切换、自动锁定提示、添加 / 锁定 / 更多 */}
      <header className="h-[50px] flex-none flex items-center gap-[10px] px-[16px] border-b border-border bg-card">
        <span className="w-[26px] h-[26px] rounded-[7px] flex-none inline-flex items-center justify-center bg-orange text-white"><IconLock size={14} /></span>
        <span className="flex-none whitespace-nowrap text-[14px] font-semibold">保险箱</span>
        <span className="w-px h-[18px] flex-none bg-border" />
        <div className="relative flex-none">
          <button
            onClick={() => { setGearOpen(false); setIdOpen(!idOpen); }}
            className="flex-none whitespace-nowrap inline-flex items-center gap-[7px] px-[10px] py-[5px] border border-border bg-bg text-text rounded-[8px] text-[12.5px] cursor-pointer hover:border-orange hover:text-orange-text"
          >
            <Mono text={cur?.name || "U"} size={18} radius={5} font={10} />
            {cur?.name || "身份库"}
            <IconChevronDown size={13} />
          </button>
          {idOpen ? (
            <div className={`${vPanel} left-0 top-[100%] mt-[6px] w-[240px]`} style={{ animation: "vPop .14s ease" }}>
              <div className={vGroupHead}>身份库</div>
              {vaults.map((v) => (
                <MenuItem
                  key={v.id}
                  icon={<Mono text={v.name} size={18} radius={5} font={10} plain />}
                  label={v.name}
                  hint={v.id === vid ? "当前" : undefined}
                  onClick={() => { setVid(v.id); setSelId(""); setCat("all"); setIdOpen(false); }}
                />
              ))}
              <div className="h-px bg-border-soft my-[5px]" />
              <MenuItem
                icon={<IconPlus size={14} />}
                label="新建身份库"
                onClick={async () => {
                  const id = await api.addVault("新身份库", "custom", "");
                  setVaults(await api.listVaults()); setVid(id); setSelId(""); setCat("all"); setIdOpen(false);
                }}
              />
              <MenuItem icon={<IconPencil size={14} />} label="管理身份库…" onClick={() => { setIdOpen(false); setManageOpen(true); }} />
              {st.biometric ? (
                <>
                  <div className="h-px bg-border-soft my-[5px]" />
                  <MenuItem
                    icon={<IconTouchId size={14} />}
                    label={st.quickUnlock ? "关闭 Touch ID 快速解锁" : "启用 Touch ID 快速解锁"}
                    onClick={async () => {
                      if (st.quickUnlock) await api.disableQuickUnlock(); else await api.enableQuickUnlock();
                      await onStatus(); setIdOpen(false);
                      flash(st.quickUnlock ? "已关闭 Touch ID" : "已启用 Touch ID 快速解锁");
                    }}
                  />
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <span className="flex-1" />
        <span className="flex-none whitespace-nowrap text-[11.5px] text-faint">{st.autoLockMin} 分钟无操作自动锁定</span>
        {/* 自动同步状态：改完自己会同步，这里只是让用户看得见它在动、失败了也知道 */}
        <span className={`flex-none whitespace-nowrap text-[11.5px] ${st.syncError ? "text-danger" : "text-faint"}`}
          title={st.syncError || undefined}>{syncLabel(st, now)}</span>
        <button className={btnPrimary} onClick={() => void addRecord()}><IconPlus size={13} className="inline-block align-[-2px] mr-[4px]" />添加记录</button>
        <button className={btnGhost} onClick={() => void onLock()}>锁定</button>
        <div className="relative flex-none">
          <button
            onClick={() => { setIdOpen(false); setGearOpen(!gearOpen); }}
            title="更多"
            className="w-[28px] h-[28px] flex-none inline-flex items-center justify-center border border-border bg-bg text-text rounded-[8px] cursor-pointer hover:border-orange hover:text-orange-text"
          ><IconDots size={14} /></button>
          {gearOpen ? (
            <div className={`${vPanel} right-0 top-[100%] mt-[6px] w-[232px]`} style={{ animation: "vPop .14s ease" }}>
              <MenuItem icon={<IconCloud size={14} />} label="立即同步" hint={st.syncConfigured ? undefined : "未配置"} onClick={() => void doSync()} />
              <div className="h-px bg-border-soft my-[5px]" />
              <MenuItem icon={<IconDownload size={14} />} label="导出加密备份" onClick={() => void doExport(false)} />
              <MenuItem icon={<IconDownload size={14} />} label="导出明文 JSON" onClick={() => void doExport(true)} />
              <MenuItem icon={<IconUp size={14} />} label="导入备份 · 数据" onClick={() => void doImport()} />
              <MenuItem
                icon={<IconFile size={14} />}
                label="下载导入模板 (CSV)"
                onClick={async () => { setGearOpen(false); await api.downloadTemplate("csv"); flash("已下载 CSV 导入模板"); }}
              />
              <div className="h-px bg-border-soft my-[5px]" />
              {/* 录制期间**不关菜单** —— 关掉的话用户就看不到「按下组合键…」这个提示，
                  会以为点了没反应。录到之后 useHotkeyRecorder 自己会停。 */}
              <MenuItem
                icon={<IconKeyboard size={14} />}
                label="唤起快捷键"
                hint={recording ? "按下组合键…" : shortcutConflict ? `与「${OWNER_LABEL[shortcutConflict]}」重复` : displayAccel(shortcut) || "未设置"}
                hintWarn={recording || !!shortcutConflict}
                onClick={startRecord}
              />
              {embedded ? (
                <MenuItem
                  icon={<IconWindow size={14} />}
                  label="在独立窗口打开"
                  onClick={() => { setGearOpen(false); void api.openWindow(); }}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        {/* 左栏 196：快速访问 + 分组。分组支持右键改名 / 删除 */}
        <nav className="w-[196px] flex-none border-r border-border bg-rail flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto p-[10px_8px]">
            <div className={vGroupHead}>快速访问</div>
            <NavRow label="全部" Icon={IconGrid} count={items.length} active={cat === "all"} onClick={() => setCat("all")} />
            <NavRow label="收藏" Icon={IconStar} count={items.filter((i) => i.favorite).length} active={cat === "fav"} onClick={() => setCat("fav")} />
            <div className={`${vGroupHead} mt-[10px]`}>分组</div>
            {types.map((t) => (renaming === t.id ? (
              <input
                key={t.id}
                className="w-full border border-orange bg-card text-text rounded-[8px] px-[9px] py-[6px] text-[12.5px] outline-none"
                defaultValue={t.name}
                autoFocus
                onBlur={async (e) => { await api.updateType(vid, t.id, { name: e.target.value.trim() || t.name }); setRenaming(null); await refresh(); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              />
            ) : (
              <NavRow
                key={t.id}
                label={t.name}
                iconValue={t.icon}
                mono={t.name}
                count={counts[t.id] || 0}
                active={cat === t.id}
                onClick={() => setCat(t.id)}
                onContextMenu={(e) => { e.preventDefault(); setTctx({ open: true, x: e.clientX, y: e.clientY, typeId: t.id }); }}
              />
            )))}
            <button
              className={`${vDash} mt-[8px]`}
              onClick={async () => {
                // 随机给一个图标（优先没被用过的），建完直接进改名态。
                const id = await api.addType(vid, "新分组", randomGroupIcon(types.map((t) => t.icon)));
                await refresh(); setRenaming(id);
              }}
            ><IconFolder size={13} />新建分组</button>
          </div>
        </nav>

        {/* 中栏 302：搜索 + 计数 / 多选 + 记录列表 */}
        <div className="w-[302px] flex-none border-r border-border bg-card flex flex-col min-h-0">
          <div className="flex-none p-[10px_12px_8px] flex flex-col gap-[8px]">
            <div className="relative">
              <span className="absolute left-[10px] top-1/2 -translate-y-1/2 text-faint"><IconSearch size={14} /></span>
              <input
                className="w-full border border-border bg-bg text-text rounded-[8px] pl-[31px] pr-[28px] py-[7px] text-[12.5px] outline-none focus:border-orange"
                value={q}
                placeholder="搜索名称、账号、网址…"
                onChange={(e) => setQ(e.target.value)}
              />
              {q ? (
                <button className={`${vIconBtn} absolute right-[3px] top-1/2 -translate-y-1/2`} title="清空搜索" onClick={() => setQ("")}><IconX size={13} /></button>
              ) : null}
            </div>
            <div className="flex items-center gap-[8px]">
              {selecting ? (
                <>
                  <label className="flex-none whitespace-nowrap inline-flex items-center gap-[6px] text-[11.5px] text-muted cursor-pointer select-none">
                    <input type="checkbox" className="w-[13px] h-[13px] flex-none accent-orange cursor-pointer" checked={allChecked} onChange={toggleAll} />
                    已选 {checked.size}
                  </label>
                  <span className="flex-1" />
                  <button className={vTextBtn} disabled={!checked.size} onClick={batchDelete}><IconTrash size={12} />删除</button>
                  <button className={vTextBtn} onClick={exitSelect}>完成</button>
                </>
              ) : (
                <>
                  <span className="flex-none whitespace-nowrap text-[11.5px] text-faint">共 {visible.length} 条</span>
                  <span className="flex-1" />
                  <button className={vTextBtn} disabled={!visible.length} onClick={() => setSelecting(true)}>多选</button>
                </>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-[0_8px_10px]">
            {visible.length ? visible.map((it) => {
              const on = it.id === selId;
              const acc = it.blocks.find((b) => b.type === "account");
              const sub = acc ? String(acc.data.username || "") : typeName(it.typeId);
              return (
                <div
                  key={it.id}
                  onClick={() => (selecting ? toggleCheck(it.id) : selectItem(it.id))}
                  onContextMenu={(e) => { e.preventDefault(); setCtx({ open: true, x: e.clientX, y: e.clientY, itemId: it.id }); }}
                  className={`flex items-center gap-[9px] px-[8px] py-[7px] rounded-[9px] cursor-pointer ${on ? "bg-orange-soft" : "hover:bg-hover"}`}
                >
                  {/* 勾选框是行内兄弟节点，不套在整行按钮里，点它不会连带选中这一行 */}
                  {selecting ? (
                    <input
                      type="checkbox"
                      className="w-[14px] h-[14px] flex-none accent-orange cursor-pointer"
                      checked={checked.has(it.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleCheck(it.id)}
                    />
                  ) : null}
                  <IconThumb value={it.icon} icons={RESOLVE_ICONS} size={30} radius={9} on={on}
                    fallback={<Mono text={it.title} size={30} radius={9} font={12} plain={!on} />} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-[13px] truncate ${on ? "font-semibold text-orange-text" : ""}`}>{it.title}</div>
                    <div className="text-[11px] text-faint truncate font-mono">{sub || "—"}</div>
                  </div>
                  {it.favorite ? <span className="flex-none text-orange"><IconStar size={13} /></span> : null}
                </div>
              );
            }) : (
              /* 空态走通用空态件（稿 3736 是「PC 空态」的 compact 档 + secondary 动作）。
                 之前是手抄的一份：40px 图标框 / 圆角 11，而组件（照稿）compact 档是 44px / 圆角 12。
                 搜索无结果时给「新建「xxx」」作为次动作 —— 稿里就是这么画的，搜不到往往
                 意味着这条还没存过。 */
              <div className="pt-[46px]">
                <EmptyState
                  compact
                  icon="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4"
                  title={q ? `没有匹配「${q}」的记录` : "这个分组还没有记录"}
                  body={q ? "密码与密文内容不参与搜索，可以试试名称、账号或网址" : "用右上角的「添加记录」新建一条"}
                  secondaryLabel={q ? `新建「${q}」` : undefined}
                  onSecondary={q ? () => void addRecord(q) : undefined}
                />
              </div>
            )}
          </div>
        </div>

        {/* 右栏：详情 */}
        <div className="flex-1 min-w-0 overflow-y-auto p-[20px_22px]">
          {sel ? (
            <Detail
              key={sel.id}
              item={sel}
              vid={vid}
              types={types}
              typeName={typeName}
              autoEdit={autoEditId === sel.id}
              flash={flash}
              onChange={refresh}
              onFav={() => void toggleFav(sel)}
              onDelete={() => askDelete(sel.id)}
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center gap-[10px]">
              <span className="w-[44px] h-[44px] rounded-[12px] flex-none inline-flex items-center justify-center bg-chip text-faint"><IconLock size={20} /></span>
              <div className="text-[13px] text-muted">从左侧选一条记录查看详情</div>
              <div className="text-[11.5px] text-faint">整条记录已 AES-256-GCM 本地加密</div>
            </div>
          )}
        </div>
      </div>

      {/* 任一菜单打开时铺一层透明遮罩接管点击，省得每个菜单各写一遍 document 监听 */}
      {anyMenu ? <div className="fixed inset-0 z-30" onMouseDown={closeMenus} onContextMenu={(e) => { e.preventDefault(); closeMenus(); }} /> : null}

      {/* 记录右键菜单 */}
      {ctx.open && ctxItem ? (
        <div className="z-40 bg-card border border-border rounded-[12px] p-[6px] shadow-[shadow:var(--shadow-floating)] w-[200px] max-h-[calc(100vh-16px)] overflow-y-auto" style={{ ...at(ctx.x, ctx.y), animation: "vPop .14s ease" }}>
          <MenuItem icon={<IconPencil size={14} />} label="编辑记录" onClick={() => { setSelId(ctxItem.id); setAutoEditId(ctxItem.id); closeMenus(); }} />
          <MenuItem icon={<IconStar size={14} />} label={ctxItem.favorite ? "取消收藏" : "加入收藏"} onClick={async () => { closeMenus(); await toggleFav(ctxItem); }} />
          <div className="h-px bg-border-soft my-[5px]" />
          {/* 「移动到…」默认收起，点开才列分组；分组多了列表自己滚，不撑爆菜单 */}
          <MenuItem
            icon={<IconFolder size={14} />}
            label="移动到…"
            trail={moveOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
            onClick={() => setMoveOpen((v) => !v)}
          />
          {moveOpen ? (
            types.length ? (
              <div className="max-h-[176px] overflow-y-auto">
                {types.map((t) => (
                  <MenuItem key={t.id} icon={<IconThumb value={t.icon} icons={RESOLVE_ICONS} size={18} radius={5} fallback={<Mono text={t.name} size={18} radius={5} font={10} plain />} />} label={t.name} hint={t.id === ctxItem.typeId ? "当前" : undefined} onClick={() => void doMove(ctxItem.id, t.id)} />
                ))}
              </div>
            ) : (
              <div className="px-[10px] py-[6px] text-[11.5px] text-faint">还没有分组，先在左栏新建一个</div>
            )
          ) : null}
          <div className="h-px bg-border-soft my-[5px]" />
          <MenuItem icon={<IconTrash size={14} />} label="删除记录" danger onClick={() => askDelete(ctxItem.id)} />
        </div>
      ) : null}

      {/* 分组右键菜单 */}
      {tctx.open && tctxType ? (
        <div className="z-40 bg-card border border-border rounded-[12px] p-[6px] shadow-[shadow:var(--shadow-floating)] w-[168px]" style={{ ...at(tctx.x, tctx.y), animation: "vPop .14s ease" }}>
          <MenuItem icon={<IconPencil size={14} />} label="重命名分组" onClick={() => { setRenaming(tctxType.id); closeMenus(); }} />
          <MenuItem icon={<IconGrid size={14} />} label="换图标…" onClick={() => { setIconPop({ x: tctx.x, y: tctx.y, type: tctxType }); closeMenus(); }} />
          <MenuItem icon={<IconTrash size={14} />} label="删除分组" danger onClick={() => askDeleteType(tctxType.id)} />
        </div>
      ) : null}

      {/* 分组「换图标」：通用 IconPickerPop（线性图标 + 自定义图片），锚定右键位置，选完即存。 */}
      {iconPop ? (
        <IconPickerPop
          x={iconPop.x} y={iconPop.y} title={iconPop.type.name} value={iconPop.type.icon} icons={VAULT_ICONS}
          onClose={() => setIconPop(null)}
          onPick={async (v) => {
            const tp = iconPop.type;
            await api.updateType(vid, tp.id, { icon: v }); await refresh();
            showToast(v ? `「${tp.name}」图标已换` : `「${tp.name}」已清除图标`, { tone: "ok" });
          }}
        />
      ) : null}

      {manageOpen ? (
        <VaultsManager
          vaults={vaults}
          vid={vid}
          onClose={() => setManageOpen(false)}
          reload={async () => setVaults(await api.listVaults())}
          onDeleted={(delId, remaining) => { if (delId === vid) { setVid(remaining[0]?.id || ""); setSelId(""); setCat("all"); } }}
          flash={flash}
        />
      ) : null}

      {imp.open ? (
        <Modal width={360} onClose={() => setImp({ open: false, mp: "", sk: "", err: "" })}>
          <div className="text-[14px] font-semibold">导入加密备份</div>
          <div className="text-[12px] text-muted leading-[1.7] mt-[6px]">输入备份对应的主密码解密（若换过 Secret Key 也一并填）。记录会追加到当前身份库，不覆盖现有数据。</div>
          <div className="flex flex-col gap-[9px] mt-[14px]">
            <input className={vInput} type="password" autoFocus value={imp.mp} placeholder="备份的主密码" onChange={(e) => setImp((s) => ({ ...s, mp: e.target.value, err: "" }))} />
            <input className={vInput} value={imp.sk} placeholder="Secret Key（可选）" onChange={(e) => setImp((s) => ({ ...s, sk: e.target.value, err: "" }))} />
          </div>
          {imp.err ? <div className="flex items-center gap-[7px] bg-danger-soft text-danger rounded-[8px] px-[12px] py-[9px] text-[12px] mt-[10px]"><span className="flex-none"><IconAlert size={14} /></span>{imp.err}</div> : null}
          <div className="flex items-center justify-end gap-[8px] mt-[16px]">
            <button className={btnGhost} onClick={() => setImp({ open: false, mp: "", sk: "", err: "" })}>取消</button>
            <button className={btnPrimary} disabled={!imp.mp} onClick={() => void applyImport()}>开始导入</button>
          </div>
        </Modal>
      ) : null}

      {confirm ? (
        <ConfirmModal
          title={confirm.title}
          desc={confirm.desc}
          okLabel={confirm.okLabel}
          onOk={() => { const run = confirm.run; setConfirm(null); void run(); }}
          onClose={() => setConfirm(null)}
        />
      ) : null}

      {toast ? (
        <div
          className="absolute bottom-[26px] left-1/2 z-[60] px-[18px] py-[9px] rounded-full text-[12.5px] text-white whitespace-nowrap"
          style={{ transform: "translateX(-50%)", background: "#17130f", animation: "vToastIn .18s ease" }}
        >{toast}</div>
      ) : null}
    </div>
  );
}

// 左栏的一行：线性图标（快速访问）/ 分组图标值（有 icon 的分组）/ 首字 monogram（老分组兜底）。
function NavRow({ label, Icon, iconValue, mono, count, active, onClick, onContextMenu }: {
  label: string; Icon?: IconComp; iconValue?: string; mono?: string; count: number; active: boolean;
  onClick: () => void; onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`w-full text-left flex items-center gap-[9px] px-[8px] py-[6px] rounded-[8px] text-[12.5px] cursor-pointer ${active ? "bg-orange-soft text-orange-text font-semibold" : "bg-transparent text-text hover:bg-hover"}`}
    >
      {Icon ? (
        <span className={`w-[22px] h-[22px] rounded-[6px] flex-none inline-flex items-center justify-center ${active ? "bg-orange text-white" : "bg-chip text-muted"}`}><Icon size={13} /></span>
      ) : <IconThumb value={iconValue} icons={RESOLVE_ICONS} size={22} radius={6} on={active}
             fallback={<Mono text={mono || label} size={22} radius={6} font={11} plain={!active} />} />}
      <span className="flex-1 min-w-0 truncate">{label}</span>
      <span className="flex-none whitespace-nowrap text-[11px] text-faint">{count}</span>
    </button>
  );
}

// 菜单/下拉里的一行。danger 用红字 + 红底悬停，不做红色实心（实心只留给确认弹窗的最终按钮）。
// hint 是右侧的一小段说明文字，trail 是右侧的节点（折叠箭头这种），两者可同时出现。
function MenuItem({ icon, label, hint, hintWarn, trail, danger, onClick }: { icon?: ReactNode; label: string; hint?: string; hintWarn?: boolean; trail?: ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left flex items-center gap-[9px] px-[10px] py-[6px] rounded-[8px] bg-transparent border-none text-[12.5px] cursor-pointer ${danger ? "text-danger hover:bg-danger-soft" : "text-text hover:bg-hover"}`}
    >
      {icon ? <span className="flex-none inline-flex items-center">{icon}</span> : null}
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {hint ? <span className={`flex-none whitespace-nowrap text-[11px] ${hintWarn ? "text-warning font-semibold" : "text-faint"}`}>{hint}</span> : null}
      {trail ? <span className="flex-none inline-flex items-center text-faint">{trail}</span> : null}
    </button>
  );
}

// 管理身份库：改名与删除。只能拿到当前身份库的记录数，所以这里不显示条数，不编造。
function VaultsManager({ vaults, vid, onClose, reload, onDeleted, flash }: {
  vaults: VaultInfo[]; vid: string; onClose: () => void; reload: () => Promise<void>;
  onDeleted: (id: string, remaining: VaultInfo[]) => void; flash: (m: string) => void;
}) {
  const [ask, setAsk] = useState<VaultInfo | null>(null);
  const del = async (v: VaultInfo) => {
    await api.deleteVault(v.id);
    const remaining = vaults.filter((x) => x.id !== v.id);
    await reload();
    onDeleted(v.id, remaining);
    flash("身份库已删除");
  };
  return (
    <>
      <Modal width={440} onClose={onClose}>
        <div className="text-[14px] font-semibold">管理身份库</div>
        <div className="text-[12px] text-muted mt-[5px]">改名直接编辑；删除会连同该库下的全部记录一起移除。</div>
        <div className="flex flex-col mt-[14px]">
          {vaults.map((v, i) => (
            <div key={v.id} className={`flex items-center gap-[10px] py-[10px] ${i === vaults.length - 1 ? "" : "border-b border-border-soft"}`}>
              <Mono text={v.name} size={30} radius={9} font={12} plain={v.id !== vid} />
              <input
                className={fieldFlex("bg")}
                defaultValue={v.name}
                onBlur={async (e) => {
                  const val = e.target.value.trim();
                  if (val && val !== v.name) { await api.updateVault(v.id, { name: val }); await reload(); }
                }}
              />
              {v.id === vid ? <span className="flex-none whitespace-nowrap text-[11px] text-orange-text">当前</span> : null}
              <button
                className="flex-none whitespace-nowrap inline-flex items-center gap-[5px] px-[10px] py-[6px] border border-danger bg-transparent text-danger rounded-[8px] text-[12px] cursor-pointer hover:bg-danger hover:text-white disabled:bg-chip disabled:text-faint disabled:border-transparent disabled:cursor-not-allowed disabled:hover:bg-chip disabled:hover:text-faint"
                disabled={vaults.length <= 1}
                title={vaults.length <= 1 ? "至少保留一个身份库" : "删除身份库"}
                onClick={() => { if (vaults.length <= 1) return; setAsk(v); }}
              ><IconTrash size={12} />删除</button>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-[8px] mt-[16px]">
          <button className={btnGhost} onClick={async () => { await api.addVault("新身份库", "custom", ""); await reload(); }}><IconPlus size={13} className="inline-block align-[-2px] mr-[4px]" />新建身份库</button>
          <button className={btnPrimary} onClick={onClose}>完成</button>
        </div>
      </Modal>
      {ask ? (
        <ConfirmModal
          title={`删除身份库「${ask.name}」？`}
          desc="该库下的全部记录会一并删除，且不可撤销。"
          okLabel="删除身份库"
          onOk={() => { const v = ask; setAsk(null); void del(v); }}
          onClose={() => setAsk(null)}
        />
      ) : null}
    </>
  );
}

// 记录详情。查看 / 编辑两态共用一套结构，编辑态改的是 draft 的副本，保存才落库。
function Detail({ item, vid, types, typeName, autoEdit, flash, onChange, onFav, onDelete }: {
  item: Item; vid: string; types: VType[]; typeName: (id: string) => string; autoEdit: boolean;
  flash: (m: string) => void; onChange: () => Promise<void>; onFav: () => void; onDelete: () => void;
}) {
  const [edit, setEdit] = useState(autoEdit);
  const [draft, setDraft] = useState<Item>(structuredClone(item));
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => { setDraft(structuredClone(item)); setEdit(autoEdit); }, [item, autoEdit]);

  const save = async () => { await api.updateItem(vid, draft); setEdit(false); await onChange(); flash("已保存"); };
  const setData = (bid: string, k: string, v: unknown) =>
    setDraft((d) => ({ ...d, blocks: d.blocks.map((b) => (b.id === bid ? { ...b, data: { ...b.data, [k]: v } } : b)) }));
  const setLabel = (bid: string, v: string) =>
    setDraft((d) => ({ ...d, blocks: d.blocks.map((b) => (b.id === bid ? { ...b, label: v } : b)) }));
  const delBlock = (bid: string) => setDraft((d) => ({ ...d, blocks: d.blocks.filter((b) => b.id !== bid) }));
  const moveBlock = (i: number, dir: number) => setDraft((d) => {
    const b = d.blocks.slice();
    const j = i + dir;
    if (j < 0 || j >= b.length) return d;
    [b[i], b[j]] = [b[j], b[i]];
    return { ...d, blocks: b };
  });
  const addBlock = (type: string) => { setDraft((d) => ({ ...d, blocks: [...d.blocks, newBlock(type)] })); setAddOpen(false); };
  const model = edit ? draft : item;

  // 记录图标（sam 第二轮）：编辑态点大图标开通用选择器（线性图标 / 上传 / 拖入 / 粘贴 / 网址），
  // 直接把图片拖到图标上也行；值随「保存」一起落库（item.icon）。
  const [iconPop, setIconPop] = useState<{ x: number; y: number } | null>(null);
  const [iconOver, setIconOver] = useState(false);
  const dropIcon = async (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) { showToast("只能用图片文件", { tone: "fail" }); return; }
    try { const v = await compressIcon(f); setDraft((d) => ({ ...d, icon: v })); }
    catch (e) { showToast(ipcErr(e), { tone: "fail" }); }
  };
  const bigIcon = <IconThumb value={model.icon} icons={RESOLVE_ICONS} size={40} radius={11}
    fallback={<Mono text={model.title} size={40} radius={11} font={16} />} />;

  return (
    <div className="max-w-[600px] flex flex-col gap-[16px]" style={{ animation: "vDetailIn .22s ease" }}>
      {/* 标题区。记录大图标的「可换」提示按批次 009 定稿：**不挂常驻角标**（40 上挂 16 的
          角标吃掉六分之一面积，还和图片内容打架）——编辑态常驻 1px 虚线描边当静态提示
          （和选择器落点同一套语言），hover 才压 rgba(0,0,0,.42) 遮罩 + 14 铅笔；
          图片拖上来时转 2px 橙描边 + 橙软底；查看态实线描边、不可点。 */}
      <div className="flex items-center gap-[12px]">
        {edit ? (
          <button
            className={`relative flex-none p-0 bg-transparent cursor-pointer rounded-[11px] overflow-hidden group/icon ${
              iconOver ? "border-2 border-orange bg-orange-soft" : "border border-dashed border-border"}`}
            title="换图标：点一下选，或把图片拖到这里"
            onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setIconPop({ x: r.left, y: r.bottom + 6 }); }}
            onDragEnter={(e) => { e.preventDefault(); setIconOver(true); }}
            onDragOver={(e) => { e.preventDefault(); }}
            onDragLeave={() => setIconOver(false)}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setIconOver(false); void dropIcon(e.dataTransfer.files[0]); }}
          >
            {bigIcon}
            <span className="absolute inset-0 hidden group-hover/icon:flex items-center justify-center bg-[rgba(0,0,0,.42)] text-white rounded-[10px]">
              <IconPencil size={14} />
            </span>
          </button>
        ) : (
          <span className="flex-none rounded-[11px] border border-border overflow-hidden">{bigIcon}</span>
        )}
        <div className="flex-1 min-w-0 flex flex-col gap-[5px]">
          {edit ? (
            <input className={vInput} value={draft.title} placeholder="记录名称" onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
          ) : (
            <div className="text-[17px] font-semibold truncate">{model.title}</div>
          )}
          <div className="flex items-center gap-[8px]">
            {edit ? (
              <select className={selectBox} value={draft.typeId} onChange={(e) => setDraft((d) => ({ ...d, typeId: e.target.value }))}>
                {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            ) : <Pill>{typeName(model.typeId)}</Pill>}
            <span className="flex-none whitespace-nowrap text-[11.5px] text-faint">上次更新 {ago(model.updatedAt)}</span>
          </div>
        </div>
        <button className={vIconBtn} title={model.favorite ? "取消收藏" : "加入收藏"} onClick={onFav}>
          <span className={model.favorite ? "text-orange" : ""}><IconStar size={16} /></span>
        </button>
        {edit ? (
          <button className={btnPrimary} onClick={() => void save()}>保存</button>
        ) : (
          <button className={btnGhost} onClick={() => setEdit(true)}><IconPencil size={13} className="inline-block align-[-2px] mr-[4px]" />编辑</button>
        )}
      </div>

      {/* 控件卡片 */}
      <div className="flex flex-col gap-[12px]">
        {model.blocks.map((b, i) => (
          <div key={b.id} style={{ animation: "vBlockIn .34s ease both", animationDelay: `${i * 55}ms` }}>
            <BlockCard
              block={b}
              idx={i}
              count={model.blocks.length}
              edit={edit}
              vid={vid}
              itemId={model.id}
              attMeta={model.attachments}
              flash={flash}
              onData={(k, v) => setData(b.id, k, v)}
              onLabel={(v) => setLabel(b.id, v)}
              onDel={() => delBlock(b.id)}
              onMove={(dir) => moveBlock(i, dir)}
              onAttAdded={(att) => setData(b.id, "atts", [...((b.data.atts as string[]) || []), att.id])}
              onAttRemoved={(aid) => setData(b.id, "atts", ((b.data.atts as string[]) || []).filter((x) => x !== aid))}
            />
          </div>
        ))}
        {edit ? <button className={vDash} onClick={() => setAddOpen(true)}><IconPlus size={13} />添加控件</button> : null}
      </div>

      <div className="flex items-center gap-[10px] pt-[4px]">
        <span className="flex-1 min-w-0 text-[11.5px] text-faint">整条记录已 AES-256-GCM 加密 · 密码 / 密文不进入搜索</span>
        {edit ? (
          <button
            className="flex-none whitespace-nowrap inline-flex items-center gap-[5px] px-[11px] py-[6px] border border-danger bg-transparent text-danger rounded-[8px] text-[12px] cursor-pointer hover:bg-danger hover:text-white"
            onClick={onDelete}
          ><IconTrash size={12} />删除记录</button>
        ) : null}
      </div>

      {iconPop ? (
        <IconPickerPop
          x={iconPop.x} y={iconPop.y} title={draft.title || "这条记录"} value={draft.icon} icons={VAULT_ICONS}
          onClose={() => setIconPop(null)}
          onPick={(v) => setDraft((d) => ({ ...d, icon: v }))}
        />
      ) : null}

      {addOpen ? (
        <Modal width={320} onClose={() => setAddOpen(false)}>
          <div className="text-[14px] font-semibold">添加控件</div>
          <div className="text-[12px] text-muted mt-[5px]">一条记录可以叠加任意多个控件。</div>
          <div className="grid grid-cols-2 gap-[8px] mt-[14px]">
            {CTLS.map((c) => (
              <button
                key={c.type}
                onClick={() => addBlock(c.type)}
                className="flex items-center gap-[9px] px-[11px] py-[10px] border border-border bg-card text-text rounded-[7px] text-[12.5px] cursor-pointer hover:border-orange hover:text-orange-text"
              >
                <span className="w-[26px] h-[26px] rounded-[7px] flex-none inline-flex items-center justify-center bg-chip text-muted"><c.Icon size={14} /></span>
                <span className="flex-none whitespace-nowrap">{c.name}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center justify-end mt-[14px]">
            <button className={btnGhost} onClick={() => setAddOpen(false)}>取消</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

// 单个控件卡：卡头（类型胶囊 + 名称 + 编辑态的调序 / 删除）+ 卡身（按类型渲染）。
function BlockCard({ block, idx, count, edit, vid, itemId, attMeta, flash, onData, onLabel, onDel, onMove, onAttAdded, onAttRemoved }: {
  block: Block; idx: number; count: number; edit: boolean; vid: string; itemId: string; attMeta: Att[];
  flash: (m: string) => void; onData: (k: string, v: unknown) => void; onLabel: (v: string) => void;
  onDel: () => void; onMove: (dir: number) => void; onAttAdded: (att: Att) => void; onAttRemoved: (aid: string) => void;
}) {
  const [reveal, setReveal] = useState(false);
  const [genFor, setGenFor] = useState<string | null>(null);
  const copy = (v: string, m: string) => { void api.copy(v); flash(m + " · 20s 后自动清除"); };
  const d = block.data;
  const mask = "•".repeat(10);
  const pwLine = (k: string, label: string) => {
    const val = String(d[k] || "");
    const s = pwStrength(val);
    return (
      <Row label={label}>
        {edit ? (
          <div className="flex items-center gap-[7px]">
            <input className={vInputSm} type={reveal ? "text" : "password"} value={val} onChange={(e) => onData(k, e.target.value)} />
            <button className={vIconBtn} title={reveal ? "隐藏" : "显示"} onClick={() => setReveal(!reveal)}>{reveal ? <IconEyeOff size={14} /> : <IconEye size={14} />}</button>
            <button className={vIconBtn} title="生成强密码" onClick={() => setGenFor(k)}><IconDice size={14} /></button>
          </div>
        ) : (
          <div className="flex items-center gap-[7px]">
            <span className="flex-1 min-w-0 font-mono text-[13px] truncate">{val ? (reveal ? val : mask) : "—"}</span>
            {val ? <Pill tone={s.label === "强" ? "success" : s.label === "中" ? "warning" : "danger"}>{s.label}</Pill> : null}
            <button className={vIconBtn} title={reveal ? "隐藏" : "显示"} onClick={() => setReveal(!reveal)}>{reveal ? <IconEyeOff size={14} /> : <IconEye size={14} />}</button>
            <button className={vIconBtn} title="复制" disabled={!val} onClick={() => copy(val, "已复制密码")}><IconCopy size={14} /></button>
          </div>
        )}
        {genFor === k ? (
          <PwGen onClose={() => setGenFor(null)} onPick={(p) => { onData(k, p); setGenFor(null); flash("已生成强密码"); }} />
        ) : null}
      </Row>
    );
  };

  return (
    <div className="border border-border rounded-[12px] overflow-hidden bg-card">
      <div className="flex items-center gap-[8px] px-[14px] py-[9px] bg-bg border-b border-border-soft">
        <Pill tone="accent">{TAG[block.type] || block.type}</Pill>
        {edit ? (
          <input
            className="flex-1 min-w-0 border border-border bg-card text-text rounded-[8px] px-[9px] py-[4px] text-[12.5px] outline-none focus:border-orange"
            value={block.label || ""}
            placeholder={`控件名称（选填，比如「公司${TAG[block.type] || ""}」）`}
            onChange={(e) => onLabel(e.target.value)}
          />
        ) : (
          // label 和左边那颗类型胶囊一字不差时不显示 —— 否则查看态是并排两个「账号」。
          // 这个判断不能只靠 newBlock 起手留空来解决：已经存在库里的记录，
          // label 早就被写成了 TAG[type]，那些数据还在。
          <span className="flex-1 min-w-0 truncate text-[12.5px] font-semibold">
            {block.label === (TAG[block.type] || "") ? "" : block.label}
          </span>
        )}
        {edit ? (
          <>
            <button className={vIconBtn} title="上移" disabled={idx === 0} onClick={() => onMove(-1)}><IconUp size={13} /></button>
            <button className={vIconBtn} title="下移" disabled={idx === count - 1} onClick={() => onMove(1)}><IconDown size={13} /></button>
            <button className={vIconBtn} title="删除控件" onClick={onDel}><IconTrash size={13} /></button>
          </>
        ) : null}
      </div>

      <div className="p-[6px_14px_10px]">
        {block.type === "account" ? (
          <>
            <Row label="用户名">
              {edit ? <input className={vInputSm} value={String(d.username || "")} onChange={(e) => onData("username", e.target.value)} />
                : (
                  <div className="flex items-center gap-[7px]">
                    <span className="flex-1 min-w-0 font-mono text-[13px] truncate">{String(d.username || "") || "—"}</span>
                    <button className={vIconBtn} title="复制" disabled={!d.username} onClick={() => copy(String(d.username || ""), "已复制用户名")}><IconCopy size={14} /></button>
                  </div>
                )}
            </Row>
            {pwLine("password", "密码")}
            <Row label="网址">
              {edit ? <input className={vInputSm} value={String(d.url || "")} placeholder="example.com" onChange={(e) => onData("url", e.target.value)} />
                : (
                  <div className="flex items-center gap-[7px]">
                    <span className="flex-1 min-w-0 font-mono text-[13px] truncate">{String(d.url || "") || "—"}</span>
                    {d.url ? (
                      <button
                        className={vIconBtn}
                        title="在浏览器打开"
                        onClick={() => { const u = String(d.url || ""); window.open(/^https?:/.test(u) ? u : "https://" + u); }}
                      ><IconExternal size={14} /></button>
                    ) : null}
                  </div>
                )}
            </Row>
            <Row label="两步验证" last>
              {edit ? (
                <label className="flex items-center gap-[8px] text-[12.5px] cursor-pointer select-none">
                  <input type="checkbox" className="w-[14px] h-[14px] flex-none accent-orange cursor-pointer" checked={!!d.otp} onChange={(e) => onData("otp", e.target.checked)} />
                  <span className="flex-none whitespace-nowrap">含两步验证 (2FA)</span>
                </label>
              ) : d.otp ? <Pill tone="success" dot>已启用两步验证 (2FA)</Pill> : <span className="text-[12.5px] text-faint">未启用</span>}
            </Row>
          </>
        ) : null}

        {block.type === "secret" ? pwLine("value", "密文") : null}

        {block.type === "field" ? (
          <Row label="内容" last>
            {edit ? <input className={vInputSm} value={String(d.value || "")} onChange={(e) => onData("value", e.target.value)} />
              : (
                <div className="flex items-center gap-[7px]">
                  <span className="flex-1 min-w-0 font-mono text-[13px] truncate">{String(d.value || "") || "—"}</span>
                  <button className={vIconBtn} title="复制" disabled={!d.value} onClick={() => copy(String(d.value || ""), "已复制内容")}><IconCopy size={14} /></button>
                </div>
              )}
          </Row>
        ) : null}

        {block.type === "text" ? (
          <div className="pt-[8px]">
            {edit ? (
              <textarea className={vInputSm} style={{ minHeight: 96 }} value={String(d.value || "")} onChange={(e) => onData("value", e.target.value)} />
            ) : (
              <div className="text-[13px] leading-[1.8]" style={{ whiteSpace: "pre-line" }}>{String(d.value || "") || <span className="text-faint">（空）</span>}</div>
            )}
          </div>
        ) : null}

        {block.type === "images" || block.type === "files" ? (
          <div className="pt-[8px]">
            <Gallery
              kind={block.type === "images" ? "image" : "file"}
              atts={(d.atts as string[]) || []}
              attMeta={attMeta}
              vid={vid}
              itemId={itemId}
              edit={edit}
              onAttAdded={onAttAdded}
              onAttRemoved={onAttRemoved}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// 卡片内的一行：左侧 110px 中文标签 + 右侧控件，行间发丝线，最后一行不画线。
function Row({ label, last, children }: { label: string; last?: boolean; children: ReactNode }) {
  return (
    <div className={`flex items-center gap-[10px] py-[9px] ${last ? "" : "border-b border-border-soft"}`}>
      <span className="w-[110px] flex-none whitespace-nowrap text-[12.5px] text-muted">{label}</span>
      <div className="flex-1 min-w-0 relative">{children}</div>
    </div>
  );
}

// 密码生成器。选项直接映射后端 GenOpts；小写字母始终保留，不给关掉的入口。
function PwGen({ onClose, onPick }: { onClose: () => void; onPick: (p: string) => void }) {
  const [len, setLen] = useState(20);
  const [upper, setUpper] = useState(true);
  const [digits, setDigits] = useState(true);
  const [symbols, setSymbols] = useState(true);
  const [readable, setReadable] = useState(false);
  const [pw, setPw] = useState("");
  const roll = useCallback(async () => {
    setPw(await api.generatePassword({ length: len, lower: true, upper, digits, symbols, readable }));
  }, [len, upper, digits, symbols, readable]);
  useEffect(() => { void roll(); }, [roll]);

  const opt = (label: string, on: boolean, set: (v: boolean) => void) => (
    <label className="flex items-center gap-[7px] text-[12.5px] cursor-pointer select-none">
      <input type="checkbox" className="w-[14px] h-[14px] flex-none accent-orange cursor-pointer" checked={on} onChange={(e) => set(e.target.checked)} />
      <span className="flex-none whitespace-nowrap">{label}</span>
    </label>
  );

  return (
    <Modal width={330} onClose={onClose}>
      <div className="text-[14px] font-semibold">生成密码</div>
      <div className="flex items-center gap-[8px] mt-[12px]">
        <span className="flex-1 min-w-0 font-mono text-[13.5px] break-all bg-bg border border-border rounded-[8px] px-[11px] py-[9px]">{pw}</span>
        <button className={vIconBtn} title="换一个" onClick={() => void roll()}><IconRefresh size={15} /></button>
      </div>
      <div className="flex items-center gap-[10px] mt-[14px]">
        <span className="flex-none whitespace-nowrap text-[12.5px] text-muted">长度 {len}</span>
        <input type="range" min={8} max={64} value={len} className="flex-1 min-w-0 accent-orange cursor-pointer" onChange={(e) => setLen(Number(e.target.value))} />
      </div>
      <div className="grid grid-cols-2 gap-[8px] mt-[12px]">
        {opt("大写字母", upper, setUpper)}
        {opt("数字", digits, setDigits)}
        {opt("符号", symbols, setSymbols)}
        {opt("避免易混字符", readable, setReadable)}
      </div>
      <div className="flex items-center justify-end gap-[8px] mt-[16px]">
        <button className={btnGhost} onClick={onClose}>取消</button>
        <button className={btnPrimary} disabled={!pw} onClick={() => onPick(pw)}>用这个</button>
      </div>
    </Modal>
  );
}

// 图片 / 文件附件。图片走缩略网格，文件走列表行；附件本体解密后是 data URL。
function Gallery({ kind, atts, attMeta, vid, itemId, edit, onAttAdded, onAttRemoved }: {
  kind: "image" | "file"; atts: string[]; attMeta: Att[]; vid: string; itemId: string; edit: boolean;
  onAttAdded: (att: Att) => void; onAttRemoved: (aid: string) => void;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (kind === "image") atts.forEach((aid) => {
      if (!urls[aid]) void api.readAttachment(vid, aid).then((u) => setUrls((m) => ({ ...m, [aid]: u }))).catch(() => {});
    });
  }, [atts, kind, vid, urls]);
  const nameOf = (aid: string) => attMeta.find((a) => a.id === aid)?.name || "文件";

  // 删附件。主进程 vault:deleteAttachment 一直存在、preload 也一直暴露着，
  // **但整个界面上一个调用点都没有** —— 也就是说加错一个附件之后就再也删不掉了。
  // 附件是加密存进保险箱的，删不掉意味着一份不该留的东西永远躺在里面。
  //
  // 走确认弹窗（决策 D24：不可撤销的破坏性操作要问一句）。这一下确实没有撤销：
  // 主进程是真的把密文从库里删掉，不进任何回收站。
  const delAtt = async (aid: string) => {
    const ok = await askConfirm({
      message: `删除附件「${nameOf(aid)}」？删除后无法恢复。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteAttachment(vid, itemId, aid);
    } catch (e) {
      // 删失败**不能**从界面上抹掉它 —— 抹掉了用户以为删干净了，其实还在库里。
      showToast(`删不掉：${String(e).replace("Error: ", "").slice(0, 80)}`, { tone: "fail" });
      return;
    }
    onAttRemoved(aid);
    showToast("已删除附件", { tone: "ok" });
  };
  // 一批文件进保险箱：文件选择框 / 拖进来 / 粘贴 三条路都汇到这里。
  // 图片块只收 image/*（拖一个 PDF 到图片区就当没拖，不报错也不收 —— 收错地方比不收更糟）。
  // 粘贴来的截图没有文件名（clipboard 给的是 image.png 这种占位名），补一个带时间的名字，
  // 不然三张截图全叫 image.png，列表里分不出谁是谁。
  const addFiles = async (list: FileList | File[]) => {
    let n = 0;
    for (const f of Array.from(list)) {
      if (kind === "image" && !f.type.startsWith("image/")) continue;
      const buf = await f.arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const name = f.name && f.name !== "image.png" ? f.name : `粘贴图片 ${new Date().toLocaleString("zh-CN", { hour12: false }).replace(/\//g, "-")}.png`;
      const att = await api.addAttachment(vid, itemId, name, f.type || "application/octet-stream", btoa(bin));
      onAttAdded(att);
      n++;
    }
    return n;
  };
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await addFiles(e.target.files || []);
    e.target.value = "";
  };

  // 拖拽（验收 #1，2026-09-03）：整块附件区都是落点，只在编辑态收。
  // dragenter/leave 成对计数 —— 子元素之间穿梭会连发 leave/enter，直接用布尔会闪。
  const [dragDepth, setDragDepth] = useState(0);
  const dragging = edit && dragDepth > 0;
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragDepth(0);
    if (!edit) return;
    void addFiles(e.dataTransfer.files).then((n) => {
      if (n) showToast(`已添加 ${n} 个附件`, { tone: "ok" });
      else if (kind === "image") showToast("这里只收图片", { tone: "fail" });
    });
  };

  // 粘贴（验收 #1）：截图 ⌘V 直接进图片块。监听挂在 document 上 —— 附件区不是可聚焦
  // 元素，paste 事件到不了它。一条记录可能同时有图片块和文件块，两个 Gallery 都在听：
  // 靠 pasteTargets 做一次分发（图片归图片块、其余归文件块），不然一张截图会被收两遍。
  // 选中态（sam 第二轮：粘贴前得知道贴到哪块）：编辑态的附件区可聚焦（点它任何地方，
  // 包括缩略图和「添加」钮，焦点都落进来），聚焦 = 选中，画一圈 --focus-ring；
  // 粘贴分发优先给选中的那块，其次才按「图片归图片块」的兜底规则。
  const [selected, setSelected] = useState(false);
  const selRef = useRef(false);
  selRef.current = selected;
  useEffect(() => {
    if (!edit) return;
    const target = { kind, take: (files: File[]) => addFiles(files), selected: () => selRef.current };
    pasteTargets.add(target);
    return () => { pasteTargets.delete(target); };
    // addFiles 每次渲染都是新函数，但只用到 kind/vid/itemId 这几个稳定值，按它们依赖即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit, kind, vid, itemId]);
  useEffect(() => { if (!edit) setSelected(false); }, [edit]);

  // 点缩略图看大图（验收 #1）：通用 ImageViewer，把本块所有已解密的图一并交给它，
  // 预览器里 ← → 就能在这一组里切（第二轮要求）。文件名进预览器标题。
  const [viewer, setViewer] = useState<{ src: string; alt: string } | null>(null);
  const viewerItems = atts.filter((aid) => urls[aid]).map((aid) => ({ src: urls[aid], alt: nameOf(aid) }));

  return (
    // 三态描边（批次 009 定稿，token attachmentZone）：平时透明（外层 BlockCard 已是
    // 1px --border + --card 的卡）；选中 = 1px --orange + --focus-ring（单靠 3px 橙软在
    // 白卡上读不出来，token 点名必须配 1px 橙描边）；拖入 = 2px --orange + 橙软底。
    // 圆角统一 12 跟卡片 —— 拖入时整块视觉尺寸不该变。
    <div
      tabIndex={edit ? 0 : -1}
      className={`flex flex-col gap-[9px] rounded-[12px] outline-none transition-[box-shadow] duration-[120ms] ${
        dragging ? "shadow-[shadow:0_0_0_2px_var(--orange)] bg-orange-soft"
        : selected ? "shadow-[shadow:0_0_0_1px_var(--orange),var(--focus-ring)]" : ""}`}
      onFocusCapture={() => { if (edit) setSelected(true); }}
      onBlurCapture={(e) => {
        // 焦点在本块内部挪动（缩略图 → 删除钮）不算离开；跑到外面才取消选中。
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) setSelected(false);
      }}
      onDragEnter={(e) => { if (!edit) return; e.preventDefault(); setDragDepth((d) => d + 1); }}
      onDragLeave={() => { if (edit) setDragDepth((d) => Math.max(0, d - 1)); }}
      onDragOver={(e) => { if (edit) e.preventDefault(); }}
      onDrop={onDrop}
    >
      {/* 区头右侧的提示行（稿定：不塞进 96 宽的钮里，会挤成三行）。选中态换这行文案；
          拖入时整行让位给描边，不抢注意力。 */}
      {edit && !dragging ? (
        <div className={`text-right text-[11px] ${selected ? "text-orange-text" : "text-faint"}`}>
          {selected ? "现在 ⌘V 会贴到这里"
            : `${atts.length ? `${atts.length} ${kind === "image" ? "张" : "个"} · ` : ""}拖入或 ⌘V 粘贴`}
        </div>
      ) : null}
      {kind === "image" ? (
        <div className="flex flex-wrap gap-[9px]">
          {atts.map((aid) => (
            // 编辑态时右上角浮一颗删除钮。只在编辑态出现 —— 查看态是「看」，
            // 一颗常驻的删除钮贴在缩略图上，划过去就容易点错。
            <div key={aid} className="relative w-[120px] h-[80px] flex-none group">
              <button
                className="w-full h-full rounded-[10px] overflow-hidden border border-border p-0 block cursor-zoom-in"
                style={urls[aid] ? { backgroundImage: `url(${urls[aid]})`, backgroundSize: "cover", backgroundPosition: "center" } : { background: "linear-gradient(135deg,#c7b8a3,#9a8b73)" }}
                title={nameOf(aid)}
                onClick={() => { if (urls[aid]) setViewer({ src: urls[aid], alt: nameOf(aid) }); }}
              />
              {edit ? (
                <button
                  className="absolute top-[4px] right-[4px] w-[22px] h-[22px] rounded-[6px] flex items-center justify-center border-none cursor-pointer bg-[rgba(21,17,14,.72)] text-white opacity-0 group-hover:opacity-100 transition-opacity duration-[130ms]"
                  title={`删除「${nameOf(aid)}」`}
                  onClick={() => void delAtt(aid)}
                ><IconTrash size={12} /></button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col">
          {atts.map((aid, i) => (
            <div key={aid} className={`flex items-center gap-[9px] py-[8px] ${i === atts.length - 1 ? "" : "border-b border-border-soft"}`}>
              <span className="w-[26px] h-[26px] rounded-[7px] flex-none inline-flex items-center justify-center bg-chip text-muted"><IconFile size={13} /></span>
              <span className="flex-1 min-w-0 truncate text-[12.5px]">{nameOf(aid)}</span>
              <button
                className={vIconBtn}
                title="导出"
                onClick={async () => { const u = await api.readAttachment(vid, aid); window.open(u); }}
              ><IconDownload size={14} /></button>
              {edit ? (
                <button className={vIconBtn} title={`删除「${nameOf(aid)}」`} onClick={() => void delAtt(aid)}>
                  <IconTrash size={14} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {!atts.length && !edit ? <div className="text-[12.5px] text-faint">（空）</div> : null}
      {edit ? (
        <>
          {/* 钮里只写「+ 添加图片」（稿定）：提示句在区头右侧，塞进钮里会挤成三行。 */}
          <button className={`${vDash} ${dragging ? "border-orange text-orange-text" : ""}`} onClick={() => fileRef.current?.click()}>
            <IconPlus size={12} />
            {dragging ? "松开就放进来" : kind === "image" ? "添加图片" : "添加文件"}
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={kind === "image" ? "image/*" : undefined}
            className="hidden"
            onChange={(e) => void onFile(e)}
          />
        </>
      ) : null}
      <ImageViewer src={viewer?.src || null} alt={viewer?.alt} items={viewerItems} onClose={() => setViewer(null)} />
    </div>
  );
}

// 粘贴分发（见 Gallery 里的说明）。document 级只装一个监听器：
// ① 有选中（聚焦）的附件块 → 全部交给它（图片块只收图片，贴了别的就提示）；
// ② 没有选中 → 剪贴板里有图片就交给正在编辑的图片块（有多个就第一个），没有图片块才落到
//    文件块；其余文件归文件块；
// ③ 剪贴板里没有文件（纯文本粘贴）→ 什么都不做，让输入框正常粘贴文字。
const pasteTargets = new Set<{ kind: "image" | "file"; take: (files: File[]) => Promise<number>; selected: () => boolean }>();
document.addEventListener("paste", (e) => {
  if (!pasteTargets.size) return;
  const files = Array.from(e.clipboardData?.files || []);
  if (!files.length) return;
  const list = [...pasteTargets];
  const chosen = list.find((t) => t.selected());
  if (chosen) {
    e.preventDefault();
    void chosen.take(files).then((n) => {
      if (n) showToast(`已粘贴 ${n} 个附件`, { tone: "ok" });
      else showToast(chosen.kind === "image" ? "这里只收图片" : "剪贴板里没有可用的文件", { tone: "fail" });
    });
    return;
  }
  const images = files.filter((f) => f.type.startsWith("image/"));
  const others = files.filter((f) => !f.type.startsWith("image/"));
  const imgTarget = list.find((t) => t.kind === "image");
  const fileTarget = list.find((t) => t.kind === "file");
  let taken = false;
  if (images.length && (imgTarget || fileTarget)) { void (imgTarget || fileTarget)!.take(images); taken = true; }
  if (others.length && fileTarget) { void fileTarget.take(others); taken = true; }
  if (taken) {
    e.preventDefault();   // 消费掉了就别再让输入框把文件名当文字贴进去
    showToast("已粘贴到附件", { tone: "ok" });
  }
});
