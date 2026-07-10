// 密码保险箱 管理器：加密存储 + 解锁会话 + 多身份库/类型/记录 CRUD + 附件 + 搜索 + IPC。
// 零知识：明文仅在本进程内存（解锁后）；落盘全部密文；主密码/Secret Key 不入日志、不持久化明文。
import * as path from "node:path";
import * as fssync from "node:fs";
import { promises as fs } from "node:fs";
import {
  randomBytes, randomSalt, generateSecretKey, deriveAUK, authHash, verifierOf,
  wrapKey, unwrapKey, newVaultKey, encryptJSON, decryptJSON, aesEncrypt, aesDecrypt, aesEncryptBytes, aesDecryptBytes,
  generatePassword, GenOpts,
} from "./crypto";
import { VaultMeta, VaultInfo, VaultType, VaultData, Item, Attachment } from "./types";
import { ConfigStore, httpBase } from "../config";

// 导入用的明文 bundle 结构（每个 vault 会作为新身份库追加）。
interface ImportBundle { vaults: { name: string; owner?: string; icon?: string; types?: VaultType[]; items?: Item[]; attachments?: Record<string, string> }[] }

const rid = (p = "") => p + randomBytes(9).toString("hex");
const b64 = (b: Buffer) => b.toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64");

function defaultTypes(): VaultType[] {
  return [
    { id: rid("t"), name: "登录", icon: "🔑", order: 0 },
    { id: rid("t"), name: "银行卡", icon: "💳", order: 1 },
    { id: rid("t"), name: "证件/文档", icon: "🪪", order: 2 },
    { id: rid("t"), name: "安全笔记", icon: "📝", order: 3 },
  ];
}

// 记录中哪些字段可进搜索（显式排除 password/secret/otp 等敏感值）。
function searchableText(it: Item): string {
  const parts: string[] = [it.title, ...(it.tags || [])];
  for (const b of it.blocks) {
    if (b.label) parts.push(b.label);
    const d = b.data || {};
    if (b.type === "account") parts.push(String(d.username || ""), String(d.url || ""));
    else if (b.type === "text" || b.type === "field") parts.push(String(d.value || ""));
    // secret / otp 的值不进索引
  }
  for (const a of it.attachments || []) parts.push(a.name);
  return parts.join(" ").toLowerCase();
}

interface WinOpts { preloadPath: string; devUrl: string; distDir: string }
interface VaultDeps { copyConceal?: (text: string) => Promise<void> } // 隐蔽写入剪贴板（不进历史）

export class VaultManager {
  private dir: string;
  private metaFile: string;
  private meta: VaultMeta | null = null;
  private auk: Buffer | null = null;                    // 解锁后驻留内存
  private vaultKeys = new Map<string, Buffer>();
  private vdata = new Map<string, VaultData>();
  private lockTimer?: NodeJS.Timeout;
  private clearTimer?: NodeJS.Timeout;                  // 剪贴板自动清除
  private win: Electron.BrowserWindow | null = null;

  constructor(private cfg: ConfigStore, userData: string, private opts: WinOpts, private deps: VaultDeps = {}, private reregister: () => void = () => {}) {
    this.dir = path.join(userData, "vault");
    this.metaFile = path.join(this.dir, "meta.json");
  }

  // 全局快捷键：唤起保险箱窗口（清理由 main.ts 统一做）。
  async registerShortcut(): Promise<void> {
    const acc = this.cfg.get().vaultShortcut;
    if (!acc) return;
    const { globalShortcut } = await import("electron");
    try { if (!globalShortcut.isRegistered(acc)) globalShortcut.register(acc, () => this.openWindow()); }
    catch (e) { console.warn(`[vault] 快捷键注册失败：${acc}`, e); }
  }
  private async setShortcut(acc: string): Promise<{ ok: boolean }> {
    await this.cfg.save({ vaultShortcut: acc || "" });
    this.reregister();
    const { globalShortcut } = await import("electron");
    return { ok: !acc || globalShortcut.isRegistered(acc) };
  }

  // 复制到剪贴板（隐蔽写入不进历史）+ 20s 后若未被覆盖则自动清空。
  private async copy(text: string): Promise<void> {
    const t = String(text || "");
    if (this.deps.copyConceal) await this.deps.copyConceal(t);
    else { const { clipboard } = await import("electron"); clipboard.writeText(t); }
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(async () => {
      const { clipboard } = await import("electron");
      if (clipboard.readText() === t) { if (this.deps.copyConceal) await this.deps.copyConceal(""); else clipboard.writeText(""); }
    }, 20_000);
  }

  // 独立窗口（带原生标题栏）。关闭时锁定（清内存密钥）。
  async openWindow(): Promise<void> {
    const { BrowserWindow } = await import("electron");
    if (this.win && !this.win.isDestroyed()) { this.win.show(); this.win.focus(); return; }
    const win = new BrowserWindow({
      width: 1080, height: 720, minWidth: 900, minHeight: 600, title: "密码保险箱",
      backgroundColor: "#15110E",
      webPreferences: { preload: this.opts.preloadPath, contextIsolation: true, nodeIntegration: false },
    });
    if (this.opts.devUrl) win.loadURL(`${this.opts.devUrl}/vault.html`).catch(() => {});
    else win.loadFile(path.join(this.opts.distDir, "vault.html")).catch(() => {});
    win.on("closed", () => { this.win = null; this.lock(); }); // 关窗即锁定
    this.win = win;
  }

  async init(): Promise<void> { await this.registerIpc(); }

  // ── 状态 / 会话 ──
  private existsFile(): boolean { return fssync.existsSync(this.metaFile); }
  get unlocked(): boolean { return !!this.auk; }
  private async loadMeta(): Promise<void> {
    if (this.meta) return;
    if (!this.existsFile()) return;
    this.meta = JSON.parse(await fs.readFile(this.metaFile, "utf-8"));
  }
  private async status() {
    await this.loadMeta();
    const c = this.cfg.get();
    return {
      exists: this.existsFile(), unlocked: this.unlocked, autoLockMin: this.meta?.autoLockMin ?? 10,
      quickUnlock: !!this.meta?.quickUnlockEnc, biometric: await this.biometricAvailable(),
      shortcut: c.vaultShortcut || "",
      syncConfigured: !!(c.serverUrl && c.token), syncRev: this.meta?.syncRev ?? 0,
    };
  }
  private async biometricAvailable(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    try { const { systemPreferences } = await import("electron"); return systemPreferences.canPromptTouchID(); } catch { return false; }
  }
  // 启用 Touch ID：把当前 AUK 用 safeStorage 存起来（解锁态下调用）。
  private async enableQuickUnlock(): Promise<boolean> {
    if (!this.auk || !this.meta) throw new Error("保险箱已锁定");
    this.meta.quickUnlockEnc = await this.encSecret(this.auk.toString("base64"));
    await this.saveMeta();
    return true;
  }
  private async disableQuickUnlock(): Promise<boolean> {
    if (!this.meta) return false;
    delete this.meta.quickUnlockEnc; await this.saveMeta(); return true;
  }
  // Touch ID 通过 → 解密 AUK → 校验 → 加载会话（免主密码）。
  private async quickUnlock(): Promise<boolean> {
    await this.loadMeta();
    if (!this.meta?.quickUnlockEnc) throw new Error("未启用 Touch ID");
    const { systemPreferences } = await import("electron");
    await systemPreferences.promptTouchID("解锁密码保险箱"); // 失败会抛错
    const auk = unb64(await this.decSecret(this.meta.quickUnlockEnc));
    if (verifierOf(authHash(auk, unb64(this.meta.salt))) !== this.meta.verifier) throw new Error("快速解锁校验失败，请用主密码");
    this.vaultKeys.clear(); this.vdata.clear();
    for (const v of this.meta.vaults) { const vk = unwrapKey(auk, v.keyWrapped); this.vaultKeys.set(v.id, vk); this.vdata.set(v.id, await this.loadVault(v.id, vk)); }
    this.auk = auk; this.armAutoLock();
    void this.autoPull();
    return true;
  }
  private armAutoLock(): void {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    const min = this.meta?.autoLockMin ?? 10;
    if (min > 0) this.lockTimer = setTimeout(() => this.lock(), min * 60_000);
  }
  private touch(): void { if (this.unlocked) this.armAutoLock(); }
  private lock(): void {
    this.auk = null; this.vaultKeys.clear(); this.vdata.clear();
    if (this.lockTimer) { clearTimeout(this.lockTimer); this.lockTimer = undefined; }
  }
  private requireKey(vaultId: string): Buffer {
    if (!this.auk) throw new Error("保险箱已锁定");
    const k = this.vaultKeys.get(vaultId);
    if (!k) throw new Error("身份库不存在");
    return k;
  }
  private data(vaultId: string): VaultData {
    const d = this.vdata.get(vaultId);
    if (!d) throw new Error("身份库未加载");
    return d;
  }

  // ── Secret Key 的设备端加密（safeStorage / 降级）──
  private async encSecret(s: string): Promise<string> {
    const { safeStorage } = await import("electron");
    if (safeStorage.isEncryptionAvailable()) return "os:" + b64(safeStorage.encryptString(s));
    return "raw:" + b64(Buffer.from(s, "utf8")); // 降级（无 OS 加密时；仅开发/无 keychain 环境）
  }
  private async decSecret(enc: string): Promise<string> {
    const { safeStorage } = await import("electron");
    if (enc.startsWith("os:")) return safeStorage.decryptString(unb64(enc.slice(3)));
    return unb64(enc.slice(4)).toString("utf8");
  }

  // ── 初始化（设置主密码，返回 Secret Key 供用户保存 Emergency Kit）──
  private async setup(masterPassword: string): Promise<{ secretKey: string }> {
    if (this.existsFile()) throw new Error("保险箱已初始化");
    if (!masterPassword || masterPassword.length < 6) throw new Error("主密码至少 6 位");
    const salt = randomSalt();
    const secretKey = generateSecretKey();
    const auk = deriveAUK(masterPassword, secretKey, salt);
    const vaultKey = newVaultKey();
    const vinfo: VaultInfo = { id: rid("v"), name: "我自己", owner: "self", icon: "🧑", order: 0, keyWrapped: wrapKey(auk, vaultKey) };
    this.meta = {
      v: 1, kdf: "pbkdf2", salt: b64(salt), verifier: verifierOf(authHash(auk, salt)),
      secretKeyEnc: await this.encSecret(secretKey), vaults: [vinfo], autoLockMin: 10, createdAt: Date.now(),
    };
    await fs.mkdir(this.dir, { recursive: true });
    await this.saveMeta();
    this.auk = auk; this.vaultKeys.set(vinfo.id, vaultKey);
    this.vdata.set(vinfo.id, { types: defaultTypes(), items: [] });
    await this.persistVault(vinfo.id);
    this.armAutoLock();
    return { secretKey };
  }

  // ── 解锁 ──
  private async unlock(masterPassword: string, secretKeyOverride?: string): Promise<boolean> {
    await this.loadMeta();
    if (!this.meta) throw new Error("保险箱未初始化");
    const salt = unb64(this.meta.salt);
    const secretKey = secretKeyOverride?.trim() || await this.decSecret(this.meta.secretKeyEnc);
    const kdf = (this.meta.kdf as "pbkdf2" | "scrypt") || "scrypt"; // 无 kdf 字段=旧 scrypt 库
    const auk = deriveAUK(masterPassword, secretKey, salt, kdf);
    if (verifierOf(authHash(auk, salt)) !== this.meta.verifier) throw new Error("主密码或 Secret Key 不正确");
    this.vaultKeys.clear(); this.vdata.clear();
    for (const v of this.meta.vaults) {
      const vk = unwrapKey(auk, v.keyWrapped);
      this.vaultKeys.set(v.id, vk);
      this.vdata.set(v.id, await this.loadVault(v.id, vk));
    }
    this.auk = auk;
    // 旧 scrypt 库 → 自动迁移到 pbkdf2（重派生 AUK 并重新包装各库密钥；数据文件不变）。为跨端同步准备。
    if (kdf !== "pbkdf2") {
      const newAuk = deriveAUK(masterPassword, secretKey, salt, "pbkdf2");
      for (const v of this.meta.vaults) { const vk = this.vaultKeys.get(v.id)!; v.keyWrapped = wrapKey(newAuk, vk); }
      this.meta.kdf = "pbkdf2";
      this.meta.verifier = verifierOf(authHash(newAuk, salt));
      delete this.meta.quickUnlockEnc; // 旧 AUK 的 Touch ID 凭据失效，需重新启用
      this.meta.syncRev = 0;           // 密文变了，云端需重新推
      this.auk = newAuk;
      await this.saveMeta();
    }
    if (secretKeyOverride) { this.meta.secretKeyEnc = await this.encSecret(secretKey); await this.saveMeta(); } // 新设备：写入本机 keychain
    this.armAutoLock();
    void this.autoPull();
    return true;
  }

  // ── 持久化 ──
  private async saveMeta(): Promise<void> {
    await fs.writeFile(this.metaFile, JSON.stringify(this.meta, null, 2), { mode: 0o600 });
  }
  private vaultFile(id: string): string { return path.join(this.dir, `v-${id}.enc`); }
  private async persistVault(id: string): Promise<void> {
    const vk = this.requireKey(id);
    await fs.writeFile(this.vaultFile(id), encryptJSON(vk, this.data(id)), { mode: 0o600 });
  }
  private async loadVault(id: string, vk: Buffer): Promise<VaultData> {
    try {
      const blob = await fs.readFile(this.vaultFile(id), "utf-8");
      const d = decryptJSON<VaultData>(vk, blob);
      return { types: d.types || defaultTypes(), items: d.items || [] };
    } catch { return { types: defaultTypes(), items: [] }; }
  }
  private attDir(vaultId: string): string { return path.join(this.dir, "att", vaultId); }
  private attFile(vaultId: string, attId: string): string { return path.join(this.attDir(vaultId), `${attId}.enc`); }

  // ── 身份库 ──
  private listVaults() {
    if (!this.meta) return [];
    return this.meta.vaults.slice().sort((a, b) => a.order - b.order)
      .map((v) => ({ id: v.id, name: v.name, owner: v.owner, icon: v.icon, order: v.order }));
  }
  private async addVault(name: string, owner: string, icon: string) {
    if (!this.auk || !this.meta) throw new Error("保险箱已锁定");
    const vk = newVaultKey();
    const v: VaultInfo = { id: rid("v"), name: name || "新身份库", owner: owner || "custom", icon: icon || "👤", order: this.meta.vaults.length, keyWrapped: wrapKey(this.auk, vk) };
    this.meta.vaults.push(v); this.vaultKeys.set(v.id, vk); this.vdata.set(v.id, { types: defaultTypes(), items: [] });
    await this.saveMeta(); await this.persistVault(v.id);
    return v.id;
  }
  private async updateVault(id: string, patch: Partial<VaultInfo>) {
    if (!this.meta) throw new Error("未初始化");
    const v = this.meta.vaults.find((x) => x.id === id); if (!v) throw new Error("不存在");
    if (patch.name !== undefined) v.name = patch.name;
    if (patch.icon !== undefined) v.icon = patch.icon;
    if (patch.owner !== undefined) v.owner = patch.owner;
    if (patch.order !== undefined) v.order = patch.order;
    await this.saveMeta();
  }
  private async deleteVault(id: string) {
    if (!this.meta) throw new Error("未初始化");
    if (this.meta.vaults.length <= 1) throw new Error("至少保留一个身份库");
    this.meta.vaults = this.meta.vaults.filter((v) => v.id !== id);
    this.vaultKeys.delete(id); this.vdata.delete(id);
    await this.saveMeta();
    await fs.rm(this.vaultFile(id), { force: true });
    await fs.rm(this.attDir(id), { recursive: true, force: true });
  }

  // ── 类型 ──
  private async addType(vaultId: string, name: string, icon: string) {
    const d = this.data(vaultId);
    const t: VaultType = { id: rid("t"), name: name || "新类型", icon: icon || "📁", order: d.types.length };
    d.types.push(t); await this.persistVault(vaultId); return t.id;
  }
  private async updateType(vaultId: string, typeId: string, patch: Partial<VaultType>) {
    const t = this.data(vaultId).types.find((x) => x.id === typeId); if (!t) throw new Error("类型不存在");
    Object.assign(t, patch); await this.persistVault(vaultId);
  }
  private async deleteType(vaultId: string, typeId: string) {
    const d = this.data(vaultId);
    for (const it of d.items) if (it.typeId === typeId) it.typeId = ""; // 移到未分类
    d.types = d.types.filter((t) => t.id !== typeId);
    await this.persistVault(vaultId);
  }
  private async reorderTypes(vaultId: string, orderedIds: string[]) {
    const d = this.data(vaultId);
    orderedIds.forEach((id, i) => { const t = d.types.find((x) => x.id === id); if (t) t.order = i; });
    d.types.sort((a, b) => a.order - b.order);
    await this.persistVault(vaultId);
  }

  // ── 记录 ──
  private listItems(vaultId: string) {
    return this.data(vaultId).items.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }
  private getItem(vaultId: string, itemId: string): Item | null {
    return this.data(vaultId).items.find((i) => i.id === itemId) || null;
  }
  private async addItem(vaultId: string, init: Partial<Item>) {
    const now = Date.now();
    const it: Item = {
      id: rid("i"), typeId: init.typeId || "", title: init.title || "未命名", icon: init.icon || "🔐",
      favorite: !!init.favorite, tags: init.tags || [], blocks: init.blocks || [], attachments: [],
      createdAt: now, updatedAt: now, revision: 1,
    };
    this.data(vaultId).items.push(it); await this.persistVault(vaultId); return it.id;
  }
  private async updateItem(vaultId: string, item: Item) {
    const d = this.data(vaultId);
    const idx = d.items.findIndex((i) => i.id === item.id); if (idx < 0) throw new Error("记录不存在");
    const prev = d.items[idx];
    d.items[idx] = { ...prev, ...item, attachments: prev.attachments, updatedAt: Date.now(), revision: prev.revision + 1 };
    await this.persistVault(vaultId);
  }
  private async deleteItem(vaultId: string, itemId: string) {
    const d = this.data(vaultId);
    const it = d.items.find((i) => i.id === itemId);
    if (it) for (const a of it.attachments) await fs.rm(this.attFile(vaultId, a.id), { force: true });
    d.items = d.items.filter((i) => i.id !== itemId);
    await this.persistVault(vaultId);
  }
  private async deleteItems(vaultId: string, ids: string[]) {
    const d = this.data(vaultId);
    const set = new Set(ids);
    for (const it of d.items) if (set.has(it.id)) for (const a of it.attachments) await fs.rm(this.attFile(vaultId, a.id), { force: true });
    d.items = d.items.filter((i) => !set.has(i.id));
    await this.persistVault(vaultId);
    return ids.length;
  }
  private async moveItem(vaultId: string, itemId: string, toTypeId: string) {
    const it = this.getItem(vaultId, itemId); if (!it) throw new Error("记录不存在");
    it.typeId = toTypeId; it.updatedAt = Date.now(); it.revision++;
    await this.persistVault(vaultId);
  }

  // ── 附件 ──
  private async addAttachment(vaultId: string, itemId: string, name: string, mime: string, dataB64: string) {
    const vk = this.requireKey(vaultId);
    const it = this.getItem(vaultId, itemId); if (!it) throw new Error("记录不存在");
    const bytes = unb64(dataB64);
    const att: Attachment = { id: rid("att"), name, mime, size: bytes.length, addedAt: Date.now() };
    await fs.mkdir(this.attDir(vaultId), { recursive: true });
    await fs.writeFile(this.attFile(vaultId, att.id), aesEncryptBytes(vk, bytes), { mode: 0o600 });
    it.attachments.push(att); it.updatedAt = Date.now(); it.revision++;
    await this.persistVault(vaultId);
    return att;
  }
  private async readAttachment(vaultId: string, attId: string): Promise<string> {
    const vk = this.requireKey(vaultId);
    const enc = await fs.readFile(this.attFile(vaultId, attId));
    const bytes = aesDecryptBytes(vk, enc);
    const att = this.findAtt(vaultId, attId);
    return `data:${att?.mime || "application/octet-stream"};base64,${b64(bytes)}`;
  }
  private findAtt(vaultId: string, attId: string): Attachment | undefined {
    for (const it of this.data(vaultId).items) { const a = it.attachments.find((x) => x.id === attId); if (a) return a; }
    return undefined;
  }
  private async deleteAttachment(vaultId: string, itemId: string, attId: string) {
    const it = this.getItem(vaultId, itemId); if (!it) throw new Error("记录不存在");
    it.attachments = it.attachments.filter((a) => a.id !== attId);
    // 从各控件的 atts 引用里移除
    for (const b of it.blocks) {
      const atts = (b.data?.atts as string[]) || null;
      if (Array.isArray(atts)) b.data.atts = atts.filter((x) => x !== attId);
    }
    it.updatedAt = Date.now(); it.revision++;
    await fs.rm(this.attFile(vaultId, attId), { force: true });
    await this.persistVault(vaultId);
  }

  // ── 搜索（跨库或指定库；不含密码/密文）──
  private search(query: string, vaultId?: string) {
    const q = (query || "").trim().toLowerCase(); if (!q) return [];
    const out: { vaultId: string; itemId: string; title: string; icon?: string; typeId: string }[] = [];
    const vids = vaultId ? [vaultId] : [...this.vdata.keys()];
    for (const vid of vids) {
      const d = this.vdata.get(vid); if (!d) continue;
      for (const it of d.items) if (searchableText(it).includes(q)) out.push({ vaultId: vid, itemId: it.id, title: it.title, icon: it.icon, typeId: it.typeId });
    }
    return out.slice(0, 50);
  }

  private async setAutoLock(min: number) {
    if (!this.meta) throw new Error("未初始化");
    this.meta.autoLockMin = Math.max(0, Math.min(min | 0, 240));
    await this.saveMeta(); this.armAutoLock();
  }

  // ── 端到端加密同步（服务器只存密文快照）──
  // 快照明文：各库信息(含 keyWrapped) + 每库 {types,items,附件字节 base64}。设备端密钥(secretKeyEnc/quickUnlockEnc)不上传。
  private async buildSnapshot(): Promise<Record<string, unknown>> {
    if (!this.meta) throw new Error("未初始化");
    const vaults = this.meta.vaults.map((v) => ({ id: v.id, name: v.name, owner: v.owner, icon: v.icon, order: v.order, keyWrapped: v.keyWrapped }));
    const data: Record<string, unknown> = {};
    for (const v of this.meta.vaults) {
      const d = this.vdata.get(v.id); const vk = this.vaultKeys.get(v.id); if (!d || !vk) continue;
      const attachments: Record<string, string> = {};
      for (const it of d.items) for (const a of it.attachments) {
        try { attachments[a.id] = b64(aesDecryptBytes(vk, await fs.readFile(this.attFile(v.id, a.id)))); } catch { /* 缺文件跳过 */ }
      }
      data[v.id] = { types: d.types, items: d.items, attachments };
    }
    return { v: 1, vaults, data };
  }
  // 网络请求委托给保险箱窗口的渲染层用 Chromium 发（主进程 undici 会被 Cloudflare 等按非浏览器 UA 重置连接）。
  private httpSeq = 0;
  private httpWaiters = new Map<string, (r: { ok: boolean; json?: Record<string, unknown>; error?: string }) => void>();
  private async httpVault(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const c = this.cfg.get();
    if (!c.serverUrl || !c.token) throw new Error("未配置服务器地址或令牌");
    if (!this.win || this.win.isDestroyed()) throw new Error("请在保险箱窗口内同步");
    const id = `h${this.httpSeq++}`;
    const r = await new Promise<{ ok: boolean; json?: Record<string, unknown>; error?: string }>((resolve) => {
      this.httpWaiters.set(id, resolve);
      this.win!.webContents.send("vault:http", { id, url: `${httpBase(c)}${path}`, method, token: c.token, body: body ? JSON.stringify(body) : null });
      setTimeout(() => { if (this.httpWaiters.has(id)) { this.httpWaiters.delete(id); resolve({ ok: false, error: "同步请求超时" }); } }, 25_000);
    });
    if (!r.ok) throw new Error(r.error || "同步请求失败");
    return { status: 200, json: r.json || {} };
  }
  // 上传本地快照（乐观并发）。返回 {ok} 或 {conflict, rev}。
  private async syncPush(force = false): Promise<{ ok: boolean; conflict?: boolean; rev?: number }> {
    if (!this.auk || !this.meta) throw new Error("保险箱已锁定");
    const record = JSON.stringify({ v: 1, kdf: this.meta.kdf || "pbkdf2", salt: this.meta.salt, verifier: this.meta.verifier, enc: aesEncrypt(this.auk, Buffer.from(JSON.stringify(await this.buildSnapshot()), "utf8")) });
    const r = await this.httpVault("PUT", "/vault/sync", { blob: record, baseRev: this.meta.syncRev ?? 0, deviceId: this.cfg.get().deviceId, force });
    if (r.json.ok) { this.meta.syncRev = Number(r.json.rev); await this.saveMeta(); return { ok: true, rev: this.meta.syncRev }; }
    if (r.json.conflict) return { ok: false, conflict: true, rev: Number(r.json.rev) };
    throw new Error(String(r.json.detail || `同步上传失败(${r.status})`));
  }
  // 拉取云端快照并合并（按条目 revision 取新；类型/库按 id 合并；不覆盖本地未同步改动）。
  private async syncPull(): Promise<{ pulled: boolean; rev?: number }> {
    if (!this.auk || !this.meta) throw new Error("保险箱已锁定");
    const r = await this.httpVault("GET", `/vault/sync?have_rev=${this.meta.syncRev ?? 0}`);
    if (!r.json.exists) return { pulled: false };
    const rev = Number(r.json.rev);
    if (rev === (this.meta.syncRev ?? 0) || !r.json.blob) return { pulled: false, rev };
    const record = JSON.parse(String(r.json.blob));
    if (record.verifier !== this.meta.verifier) throw new Error("云端数据的主密码/Secret Key 与本地不一致");
    const snap = JSON.parse(aesDecrypt(this.auk, String(record.enc)).toString("utf8")) as { vaults: VaultInfo[]; data: Record<string, { types: VaultType[]; items: Item[]; attachments: Record<string, string> }> };
    await this.mergeSnapshot(snap);
    this.meta.syncRev = rev; await this.saveMeta();
    return { pulled: true, rev };
  }
  private async mergeSnapshot(snap: { vaults: VaultInfo[]; data: Record<string, { types: VaultType[]; items: Item[]; attachments: Record<string, string> }> }): Promise<void> {
    if (!this.auk || !this.meta) throw new Error("保险箱已锁定");
    for (const rv of snap.vaults || []) {
      if (!this.meta.vaults.find((x) => x.id === rv.id)) {
        this.meta.vaults.push(rv);
        try { this.vaultKeys.set(rv.id, unwrapKey(this.auk, rv.keyWrapped)); } catch { /* 解包失败(密钥不符)跳过 */ }
      }
    }
    for (const [vid, rd] of Object.entries(snap.data || {})) {
      const vk = this.vaultKeys.get(vid); if (!vk) continue;
      const local = this.vdata.get(vid) || { types: [], items: [] };
      // 类型按 id 合并
      const tIds = new Set(local.types.map((t) => t.id));
      for (const t of rd.types || []) if (!tIds.has(t.id)) local.types.push(t);
      // 条目按 id 合并，revision 高者胜（相等按 updatedAt）
      const byId = new Map(local.items.map((it) => [it.id, it]));
      for (const rit of rd.items || []) {
        const cur = byId.get(rit.id);
        if (!cur || rit.revision > cur.revision || (rit.revision === cur.revision && rit.updatedAt > cur.updatedAt)) byId.set(rit.id, rit);
      }
      local.items = [...byId.values()];
      // 附件字节：写入本地（用目标库密钥重新加密）
      if (Object.keys(rd.attachments || {}).length) await fs.mkdir(this.attDir(vid), { recursive: true });
      for (const [aid, dataB64] of Object.entries(rd.attachments || {})) {
        if (!fssync.existsSync(this.attFile(vid, aid))) await fs.writeFile(this.attFile(vid, aid), aesEncryptBytes(vk, unb64(dataB64)), { mode: 0o600 });
      }
      this.vdata.set(vid, local);
      await this.persistVault(vid);
    }
    await this.saveMeta();
  }
  // 一键同步：先拉取合并，再上传；冲突则再拉再传（最多几次），最后必要时强制。
  private async syncNow(): Promise<{ ok: boolean; rev: number; pulled: boolean }> {
    if (!this.unlocked) throw new Error("保险箱已锁定");
    const pull = await this.syncPull();
    let push = await this.syncPush(false);
    for (let i = 0; i < 3 && push.conflict; i++) { await this.syncPull(); push = await this.syncPush(i === 2); } // 最后一次强制
    return { ok: true, rev: this.meta?.syncRev ?? 0, pulled: pull.pulled };
  }
  private async syncReset(): Promise<{ ok: boolean }> {
    await this.httpVault("DELETE", "/vault/sync");
    if (this.meta) { this.meta.syncRev = 0; await this.saveMeta(); }
    return { ok: true };
  }
  // 解锁后后台静默拉取（不打断用户；失败忽略）。
  private async autoPull(): Promise<void> {
    const c = this.cfg.get();
    if (!c.serverUrl || !c.token) return;
    try { await this.syncPull(); } catch { /* 静默 */ }
  }

  // ── 批量导入 / 导出 ──
  // 明文 bundle（含附件字节 base64）；导出时用当前 AUK 加密或明文落盘。
  private async buildBundle() {
    if (!this.meta) throw new Error("未初始化");
    const vaults = [];
    for (const v of this.meta.vaults) {
      const d = this.vdata.get(v.id); const vk = this.vaultKeys.get(v.id); if (!d || !vk) continue;
      const attachments: Record<string, string> = {};
      for (const it of d.items) for (const a of it.attachments) {
        try { attachments[a.id] = b64(aesDecryptBytes(vk, await fs.readFile(this.attFile(v.id, a.id)))); } catch { /* 缺文件跳过 */ }
      }
      vaults.push({ name: v.name, owner: v.owner, icon: v.icon, types: d.types, items: d.items, attachments });
    }
    return { kind: "umbra-vault-backup", v: 1, exportedAt: Date.now(), vaults };
  }
  // 导出加密备份（.umbravault）：用当前 AUK 加密，随文件存 salt+verifier，导入时凭 主密码+SecretKey 解。
  private async exportBackup(): Promise<{ ok: boolean; path?: string }> {
    if (!this.auk || !this.meta) throw new Error("保险箱已锁定");
    const bundle = await this.buildBundle();
    const file = { kind: "umbra-vault-backup-enc", v: 1, salt: this.meta.salt, verifier: this.meta.verifier, blob: aesEncrypt(this.auk, Buffer.from(JSON.stringify(bundle), "utf8")) };
    const { dialog } = await import("electron");
    const r = await dialog.showSaveDialog({ title: "导出加密备份", defaultPath: `umbra-vault-${new Date().toISOString().slice(0, 10)}.umbravault`, filters: [{ name: "Umbra 保险箱备份", extensions: ["umbravault"] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    await fs.writeFile(r.filePath, JSON.stringify(file), { mode: 0o600 });
    return { ok: true, path: r.filePath };
  }
  // 导出明文 JSON（不安全，仅供迁移/检视；含明文密码）。
  private async exportPlain(): Promise<{ ok: boolean; path?: string }> {
    if (!this.auk || !this.meta) throw new Error("保险箱已锁定");
    const bundle = await this.buildBundle();
    const { dialog } = await import("electron");
    const r = await dialog.showSaveDialog({ title: "导出明文 JSON（不加密）", defaultPath: `umbra-vault-plain-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    await fs.writeFile(r.filePath, JSON.stringify({ ...bundle, kind: "umbra-vault-plain" }, null, 2), { mode: 0o600 });
    return { ok: true, path: r.filePath };
  }
  // 导入：先选文件(importPick，缓存)，加密备份返回 needPassword=true；再 importApply(主密码+SecretKey)。
  // 支持：加密备份(.umbravault) / 明文 bundle JSON / CSV(按模板列)。
  private pendingImport: { mode: "enc" | "bundle"; file?: Record<string, unknown>; bundle?: ImportBundle } | null = null;
  private async importPick(): Promise<{ ok: boolean; needPassword: boolean }> {
    if (!this.auk) throw new Error("保险箱已锁定");
    const { dialog } = await import("electron");
    const r = await dialog.showOpenDialog({ title: "导入备份 / 数据", properties: ["openFile"], filters: [{ name: "备份 / JSON / CSV", extensions: ["umbravault", "json", "csv"] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, needPassword: false };
    const p = r.filePaths[0];
    const text = (await fs.readFile(p, "utf-8")).replace(/^﻿/, ""); // 去 BOM，避免首列表头匹配不上
    if (/\.csv$/i.test(p)) { this.pendingImport = { mode: "bundle", bundle: this.bundleFromCsv(text) }; return { ok: true, needPassword: false }; }
    let file: Record<string, unknown>;
    try { file = JSON.parse(text); } catch { this.pendingImport = { mode: "bundle", bundle: this.bundleFromCsv(text) }; return { ok: true, needPassword: false }; }
    if (file.kind === "umbra-vault-backup-enc") { this.pendingImport = { mode: "enc", file }; return { ok: true, needPassword: true }; }
    if (file.kind === "umbra-vault-plain" || file.kind === "umbra-vault-backup") { this.pendingImport = { mode: "bundle", bundle: file as unknown as ImportBundle }; return { ok: true, needPassword: false }; }
    throw new Error("无法识别的文件格式（请用导出的备份、或按模板的 CSV/JSON）");
  }
  private async importApply(vaultId: string, masterPassword?: string, secretKey?: string): Promise<{ ok: boolean; added: number }> {
    if (!this.auk || !this.meta) throw new Error("保险箱已锁定");
    this.requireKey(vaultId); // 目标身份库必须存在
    const pend = this.pendingImport; if (!pend) throw new Error("请先选择文件");
    let bundle: ImportBundle;
    if (pend.mode === "enc") {
      const file = pend.file!;
      if (!masterPassword) throw new Error("需要主密码");
      const salt = unb64(String(file.salt));
      const auk2 = deriveAUK(masterPassword, secretKey || await this.decSecret(this.meta.secretKeyEnc), salt);
      if (verifierOf(authHash(auk2, salt)) !== file.verifier) throw new Error("主密码或 Secret Key 不正确");
      bundle = JSON.parse(aesDecrypt(auk2, String(file.blob)).toString("utf8"));
    } else bundle = pend.bundle!;
    const added = await this.importInto(vaultId, bundle);
    this.pendingImport = null;
    return { ok: true, added };
  }

  // CSV → bundle（列名可中英；缺列按内容尽量映射）。整批作为一个新身份库导入。
  private bundleFromCsv(text: string): ImportBundle {
    const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim().length);
    if (!lines.length) throw new Error("CSV 为空");
    const cells = (line: string): string[] => {
      const out: string[] = []; let cur = ""; let q = false;
      for (let i = 0; i < line.length; i++) { const c = line[i];
        if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
        else if (c === ",") { out.push(cur); cur = ""; } else if (c === '"') q = true; else cur += c; }
      out.push(cur); return out;
    };
    const header = cells(lines[0]).map((h) => h.trim().toLowerCase());
    const col = (names: string[]) => { for (const n of names) { const i = header.indexOf(n.toLowerCase()); if (i >= 0) return i; } return -1; };
    // 列别名（中英/常见密码管理器导出的列名尽量兼容）。
    const ci = {
      type: col(["类型", "分类", "类别", "type", "folder", "category", "group"]),
      title: col(["名称", "标题", "平台", "站点", "网站", "title", "name", "服务", "service"]),
      user: col(["用户名", "账号", "账户", "帐号", "帐户", "邮箱", "登录名", "username", "login", "user", "email", "e-mail"]),
      pass: col(["密码", "口令", "password", "pass", "pwd"]),
      url: col(["网址", "链接", "地址", "url", "website", "site", "link", "网站地址"]),
      phone: col(["关联手机号", "手机号", "手机", "电话", "phone", "mobile", "tel"]),
      note: col(["备注", "说明", "描述", "notes", "note", "remark", "memo", "comment", "desc"]),
    };
    const at = (c: string[], i: number) => (i >= 0 ? (c[i] || "").trim() : "");
    const typeMap = new Map<string, VaultType>(); const types: VaultType[] = []; const items: Item[] = [];
    for (let r = 1; r < lines.length; r++) {
      const c = cells(lines[r]);
      const tname = at(c, ci.type) || "未分类";
      let t = typeMap.get(tname);
      if (!t) { t = { id: rid("t"), name: tname, icon: "📁", order: types.length }; typeMap.set(tname, t); types.push(t); }
      const now = Date.now();
      const phone = at(c, ci.phone);
      let url = at(c, ci.url);
      if (!url && /^https?:\/\//i.test(phone)) url = phone;                 // 手机号列里放的是链接 → 当网址
      const blocks = [{ id: rid("b"), type: "account", label: "登录信息", data: { username: at(c, ci.user), password: at(c, ci.pass), url, otp: false } as Record<string, unknown> }];
      const noteParts: string[] = [];
      const note = at(c, ci.note); if (note) noteParts.push(note);
      if (phone && phone !== url) noteParts.push(`关联手机号: ${phone}`);      // 手机号并入备注（账号控件无手机字段）
      if (noteParts.length) blocks.push({ id: rid("b"), type: "text", label: "备注", data: { value: noteParts.join("\n") } });
      items.push({ id: rid("i"), typeId: t.id, title: at(c, ci.title) || at(c, ci.user) || "未命名", icon: "🔐", favorite: false, tags: [], blocks, attachments: [], createdAt: now, updatedAt: now, revision: 1 });
    }
    return { vaults: [{ name: "导入的账号", owner: "custom", icon: "📥", types, items, attachments: {} }] };
  }

  // 下载导入模板（csv / json）。
  private async downloadTemplate(kind: string): Promise<{ ok: boolean; path?: string }> {
    const { dialog } = await import("electron");
    if (kind === "json") {
      const tpl = { kind: "umbra-vault-plain", v: 1, vaults: [{ name: "导入示例", icon: "📥", types: [{ id: "t1", name: "登录", icon: "🔑", order: 0 }], items: [{ id: "i1", typeId: "t1", title: "示例账号", icon: "🔐", favorite: false, tags: [], blocks: [{ id: "b1", type: "account", label: "登录信息", data: { username: "you@example.com", password: "改成你的密码", url: "example.com", otp: false } }, { id: "b2", type: "text", label: "备注", data: { value: "可选说明" } }], attachments: [], createdAt: 0, updatedAt: 0, revision: 1 }], attachments: {} }] };
      const r = await dialog.showSaveDialog({ title: "下载 JSON 导入模板", defaultPath: "umbra-导入模板.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (r.canceled || !r.filePath) return { ok: false };
      await fs.writeFile(r.filePath, JSON.stringify(tpl, null, 2), "utf8");
      return { ok: true, path: r.filePath };
    }
    const csv = "类型,名称,用户名,密码,网址,备注\n登录,示例-GitHub,you@example.com,把密码填这里,github.com,可选备注\n银行卡,示例-储蓄卡,6225********5678,取款密码,,预留手机 138****5678\n";
    const r = await dialog.showSaveDialog({ title: "下载 CSV 导入模板", defaultPath: "umbra-导入模板.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    await fs.writeFile(r.filePath, "﻿" + csv, "utf8"); // BOM 便于 Excel 正确显示中文
    return { ok: true, path: r.filePath };
  }
  // 合并进「当前身份库」：类型按名称去重合并，条目追加（重发 id 防碰撞），附件字节用目标库密钥重新加密。返回导入条目数。
  private async importInto(vaultId: string, bundle: ImportBundle): Promise<number> {
    const d = this.data(vaultId); const vk = this.requireKey(vaultId);
    let count = 0;
    for (const bv of bundle.vaults || []) {
      const nameToId = new Map<string, string>();
      for (const t of d.types) nameToId.set(t.name, t.id);
      const oldToNew = new Map<string, string>();
      for (const t of bv.types || []) {
        let tid = nameToId.get(t.name);
        if (!tid) { const nt: VaultType = { id: rid("t"), name: t.name, icon: t.icon || "📁", order: d.types.length }; d.types.push(nt); nameToId.set(nt.name, nt.id); tid = nt.id; }
        oldToNew.set(t.id, tid);
      }
      if (Object.keys(bv.attachments || {}).length) await fs.mkdir(this.attDir(vaultId), { recursive: true });
      for (const [aid, data] of Object.entries(bv.attachments || {})) {
        await fs.writeFile(this.attFile(vaultId, aid), aesEncryptBytes(vk, unb64(data)), { mode: 0o600 });
      }
      const now = Date.now();
      for (const it of bv.items || []) {
        d.items.push({ ...it, id: rid("i"), typeId: oldToNew.get(it.typeId) || "", updatedAt: now, revision: 1 });
        count++;
      }
    }
    await this.persistVault(vaultId);
    return count;
  }

  // ── IPC ──
  private async registerIpc(): Promise<void> {
    const { ipcMain } = await import("electron");
    const H = (name: string, fn: (...a: unknown[]) => unknown, needUnlock = true) =>
      ipcMain.handle(name, async (_e, ...args: unknown[]) => { if (needUnlock && !this.unlocked) throw new Error("保险箱已锁定"); this.touch(); return fn(...args); });

    ipcMain.handle("vault:openWindow", () => this.openWindow());
    // 渲染层回传网络请求结果（Chromium fetch 代主进程发的请求）。
    ipcMain.on("vault:httpResult", (_e, msg: { id: string; ok: boolean; json?: Record<string, unknown>; error?: string }) => {
      const w = this.httpWaiters.get(msg.id); if (w) { this.httpWaiters.delete(msg.id); w(msg); }
    });
    ipcMain.handle("vault:status", () => this.status());
    ipcMain.handle("vault:setup", (_e, mp: string) => this.setup(mp));
    ipcMain.handle("vault:unlock", (_e, mp: string, sk?: string) => this.unlock(mp, sk));
    ipcMain.handle("vault:quickUnlock", () => this.quickUnlock());
    ipcMain.handle("vault:biometricAvailable", () => this.biometricAvailable());
    ipcMain.handle("vault:lock", () => { this.lock(); return true; });
    ipcMain.handle("vault:generatePassword", (_e, opts: GenOpts) => generatePassword(opts || {}));

    H("vault:listVaults", () => this.listVaults());
    H("vault:addVault", (name, owner, icon) => this.addVault(String(name), String(owner), String(icon)));
    H("vault:updateVault", (id, patch) => this.updateVault(String(id), patch as Partial<VaultInfo>));
    H("vault:deleteVault", (id) => this.deleteVault(String(id)));

    H("vault:listTypes", (vid) => this.data(String(vid)).types.slice().sort((a, b) => a.order - b.order));
    H("vault:addType", (vid, name, icon) => this.addType(String(vid), String(name), String(icon)));
    H("vault:updateType", (vid, tid, patch) => this.updateType(String(vid), String(tid), patch as Partial<VaultType>));
    H("vault:deleteType", (vid, tid) => this.deleteType(String(vid), String(tid)));
    H("vault:reorderTypes", (vid, ids) => this.reorderTypes(String(vid), ids as string[]));

    H("vault:listItems", (vid) => this.listItems(String(vid)));
    H("vault:getItem", (vid, iid) => this.getItem(String(vid), String(iid)));
    H("vault:addItem", (vid, init) => this.addItem(String(vid), init as Partial<Item>));
    H("vault:updateItem", (vid, item) => this.updateItem(String(vid), item as Item));
    H("vault:deleteItem", (vid, iid) => this.deleteItem(String(vid), String(iid)));
    H("vault:deleteItems", (vid, ids) => this.deleteItems(String(vid), (ids as string[]) || []));
    H("vault:moveItem", (vid, iid, tid) => this.moveItem(String(vid), String(iid), String(tid)));

    H("vault:addAttachment", (vid, iid, name, mime, data) => this.addAttachment(String(vid), String(iid), String(name), String(mime), String(data)));
    H("vault:readAttachment", (vid, aid) => this.readAttachment(String(vid), String(aid)));
    H("vault:deleteAttachment", (vid, iid, aid) => this.deleteAttachment(String(vid), String(iid), String(aid)));

    H("vault:search", (q, vid) => this.search(String(q), vid ? String(vid) : undefined));
    H("vault:setAutoLock", (min) => this.setAutoLock(Number(min)));
    H("vault:copy", (text) => this.copy(String(text)));
    H("vault:syncNow", () => this.syncNow());
    H("vault:syncReset", () => this.syncReset());
    H("vault:enableQuickUnlock", () => this.enableQuickUnlock());
    H("vault:disableQuickUnlock", () => this.disableQuickUnlock());
    H("vault:exportBackup", () => this.exportBackup());
    H("vault:exportPlain", () => this.exportPlain());
    H("vault:importPick", () => this.importPick());
    H("vault:importApply", (vid, mp, sk) => this.importApply(String(vid), mp ? String(mp) : undefined, sk ? String(sk) : undefined));
    H("vault:downloadTemplate", (kind) => this.downloadTemplate(String(kind || "csv")));
    ipcMain.handle("vault:setShortcut", (_e, acc: string) => this.setShortcut(String(acc || "")));
  }
}
