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
import { ConfigStore } from "../config";

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
    return {
      exists: this.existsFile(), unlocked: this.unlocked, autoLockMin: this.meta?.autoLockMin ?? 10,
      quickUnlock: !!this.meta?.quickUnlockEnc, biometric: await this.biometricAvailable(),
      shortcut: this.cfg.get().vaultShortcut || "",
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
      v: 1, salt: b64(salt), verifier: verifierOf(authHash(auk, salt)),
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
    const auk = deriveAUK(masterPassword, secretKey, salt);
    if (verifierOf(authHash(auk, salt)) !== this.meta.verifier) throw new Error("主密码或 Secret Key 不正确");
    this.vaultKeys.clear(); this.vdata.clear();
    for (const v of this.meta.vaults) {
      const vk = unwrapKey(auk, v.keyWrapped);
      this.vaultKeys.set(v.id, vk);
      this.vdata.set(v.id, await this.loadVault(v.id, vk));
    }
    this.auk = auk;
    if (secretKeyOverride) { this.meta.secretKeyEnc = await this.encSecret(secretKey); await this.saveMeta(); } // 新设备：写入本机 keychain
    this.armAutoLock();
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
  private pendingImport: Record<string, unknown> | null = null;
  private async importPick(): Promise<{ ok: boolean; needPassword: boolean }> {
    if (!this.auk) throw new Error("保险箱已锁定");
    const { dialog } = await import("electron");
    const r = await dialog.showOpenDialog({ title: "导入备份 / 数据", properties: ["openFile"], filters: [{ name: "备份或 JSON", extensions: ["umbravault", "json"] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, needPassword: false };
    const file = JSON.parse(await fs.readFile(r.filePaths[0], "utf-8"));
    if (!["umbra-vault-backup-enc", "umbra-vault-plain", "umbra-vault-backup"].includes(file.kind)) throw new Error("无法识别的文件格式");
    this.pendingImport = file;
    return { ok: true, needPassword: file.kind === "umbra-vault-backup-enc" };
  }
  private async importApply(masterPassword?: string, secretKey?: string): Promise<{ ok: boolean; added: number }> {
    if (!this.auk || !this.meta) throw new Error("保险箱已锁定");
    const file = this.pendingImport; if (!file) throw new Error("请先选择文件");
    let bundle: { vaults: { name: string; owner?: string; icon?: string; types?: VaultType[]; items?: Item[]; attachments?: Record<string, string> }[] };
    if (file.kind === "umbra-vault-backup-enc") {
      if (!masterPassword) throw new Error("需要主密码");
      const salt = unb64(String(file.salt));
      const auk2 = deriveAUK(masterPassword, secretKey || await this.decSecret(this.meta.secretKeyEnc), salt);
      if (verifierOf(authHash(auk2, salt)) !== file.verifier) throw new Error("主密码或 Secret Key 不正确");
      bundle = JSON.parse(aesDecrypt(auk2, String(file.blob)).toString("utf8"));
    } else bundle = file as typeof bundle;
    const added = await this.mergeBundle(bundle);
    this.pendingImport = null;
    return { ok: true, added };
  }
  private async mergeBundle(bundle: { vaults: { name: string; owner?: string; icon?: string; types?: VaultType[]; items?: Item[]; attachments?: Record<string, string> }[] }): Promise<number> {
    if (!this.auk || !this.meta) throw new Error("保险箱已锁定");
    for (const bv of bundle.vaults || []) {
      const vk = newVaultKey();
      const info: VaultInfo = { id: rid("v"), name: `${bv.name}（导入）`, owner: bv.owner || "custom", icon: bv.icon || "📥", order: this.meta.vaults.length, keyWrapped: wrapKey(this.auk, vk) };
      this.meta.vaults.push(info); this.vaultKeys.set(info.id, vk);
      await fs.mkdir(this.attDir(info.id), { recursive: true });
      for (const [aid, data] of Object.entries(bv.attachments || {})) {
        await fs.writeFile(this.attFile(info.id, aid), aesEncryptBytes(vk, unb64(data)), { mode: 0o600 });
      }
      this.vdata.set(info.id, { types: bv.types && bv.types.length ? bv.types : defaultTypes(), items: bv.items || [] });
      await this.persistVault(info.id);
    }
    await this.saveMeta();
    return (bundle.vaults || []).length;
  }

  // ── IPC ──
  private async registerIpc(): Promise<void> {
    const { ipcMain } = await import("electron");
    const H = (name: string, fn: (...a: unknown[]) => unknown, needUnlock = true) =>
      ipcMain.handle(name, async (_e, ...args: unknown[]) => { if (needUnlock && !this.unlocked) throw new Error("保险箱已锁定"); this.touch(); return fn(...args); });

    ipcMain.handle("vault:openWindow", () => this.openWindow());
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
    H("vault:moveItem", (vid, iid, tid) => this.moveItem(String(vid), String(iid), String(tid)));

    H("vault:addAttachment", (vid, iid, name, mime, data) => this.addAttachment(String(vid), String(iid), String(name), String(mime), String(data)));
    H("vault:readAttachment", (vid, aid) => this.readAttachment(String(vid), String(aid)));
    H("vault:deleteAttachment", (vid, iid, aid) => this.deleteAttachment(String(vid), String(iid), String(aid)));

    H("vault:search", (q, vid) => this.search(String(q), vid ? String(vid) : undefined));
    H("vault:setAutoLock", (min) => this.setAutoLock(Number(min)));
    H("vault:copy", (text) => this.copy(String(text)));
    H("vault:enableQuickUnlock", () => this.enableQuickUnlock());
    H("vault:disableQuickUnlock", () => this.disableQuickUnlock());
    H("vault:exportBackup", () => this.exportBackup());
    H("vault:exportPlain", () => this.exportPlain());
    H("vault:importPick", () => this.importPick());
    H("vault:importApply", (mp, sk) => this.importApply(mp ? String(mp) : undefined, sk ? String(sk) : undefined));
    ipcMain.handle("vault:setShortcut", (_e, acc: string) => this.setShortcut(String(acc || "")));
  }
}
