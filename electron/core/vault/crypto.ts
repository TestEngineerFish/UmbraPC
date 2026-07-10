// 密码保险箱 加密内核（零知识 / 2SKD）。仅依赖 node:crypto，纯函数、可单测。
// 密钥层级：AUK = HKDF( scrypt(主密码,盐) ∥ SecretKey ) → AUK 包装每个 VaultKey → VaultKey(AES-256-GCM) 加密条目。
// 认证：authHash = HKDF(AUK,"auth")，服务器仅存 SHA256(authHash) 作 verifier，验证登录但推不出 AUK。
import * as crypto from "node:crypto";

// scrypt 参数：N=2^15, r=8, p=1 ≈ 32MB 工作内存（memory-hard）；预留升级 Argon2id。
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 };
const AES = "aes-256-gcm";
const IV_LEN = 12;

export function randomBytes(n: number): Buffer { return crypto.randomBytes(n); }
export function randomSalt(): Buffer { return crypto.randomBytes(16); }

// ── RFC4648 Base32（无填充，用于 Secret Key 的人类可抄写编码）──
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch); if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

// Secret Key：版本前缀 U1 + 16 字节随机（Base32），按 5 字符分组便于抄写。如 U1-ABCDE-FGHIJ-…
export function generateSecretKey(): string {
  const body = base32Encode(crypto.randomBytes(16)); // 26 chars
  return "U1-" + (body.match(/.{1,5}/g) || []).join("-"); // 如 U1-ABCDE-FGHIJ-…
}
export function decodeSecretKey(sk: string): Buffer {
  const clean = sk.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const body = clean.startsWith("U1") ? clean.slice(2) : clean; // 去版本前缀
  const buf = base32Decode(body);
  return buf.subarray(0, 16);
}

const PBKDF2_ITER = 600_000; // 与 iOS(CommonCrypto) 一致，保证跨平台派生同一密钥
function scrypt(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(Buffer.from(password, "utf8"), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
}
function pbkdf2(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(Buffer.from(password, "utf8"), salt, PBKDF2_ITER, 32, "sha256");
}
function hkdf(ikm: Buffer, salt: Buffer, info: string, len = 32): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf8"), len));
}

// 账户解锁密钥 AUK（主密码 + Secret Key 双密钥派生，2SKD）。
// kdf 默认 pbkdf2（iOS 原生可复现，跨端同步用）；scrypt 仅为兼容旧本地库（会自动迁移到 pbkdf2）。
export function deriveAUK(masterPassword: string, secretKey: string, salt: Buffer, kdf: "pbkdf2" | "scrypt" = "pbkdf2"): Buffer {
  const pwKey = kdf === "scrypt" ? scrypt(masterPassword, salt) : pbkdf2(masterPassword, salt);
  const sk = decodeSecretKey(secretKey);                 // 16B，设备端高熵
  return hkdf(Buffer.concat([pwKey, sk]), salt, "umbra-vault-auk-v1", 32);
}

// 认证：authHash 交服务器比对；服务器只存 verifier=SHA256(authHash)，无法反推 AUK。
export function authHash(auk: Buffer, salt: Buffer): string { return hkdf(auk, salt, "umbra-vault-auth-v1", 32).toString("hex"); }
export function verifierOf(authHashHex: string): string { return crypto.createHash("sha256").update(Buffer.from(authHashHex, "hex")).digest("hex"); }

// ── AES-256-GCM：blob = "v1:ivB64:tagB64:ctB64" ──
export function aesEncrypt(key: Buffer, plaintext: Buffer): string {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv(AES, key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  const tag = c.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}
export function aesDecrypt(key: Buffer, blob: string): Buffer {
  const [v, ivB, tagB, ctB] = blob.split(":");
  if (v !== "v1") throw new Error("未知密文版本");
  const d = crypto.createDecipheriv(AES, key, Buffer.from(ivB, "base64"));
  d.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([d.update(Buffer.from(ctB, "base64")), d.final()]); // 篡改/错误密钥会抛错
}

// ── 二进制附件加解密（图片/文件）：密文布局 = iv(12) ∥ tag(16) ∥ ct，直接存字节不转 base64 ──
export function aesEncryptBytes(key: Buffer, plaintext: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv(AES, key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
export function aesDecryptBytes(key: Buffer, blob: Buffer): Buffer {
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + 16);
  const ct = blob.subarray(IV_LEN + 16);
  const d = crypto.createDecipheriv(AES, key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]); // 篡改/错误密钥抛错
}

// 包装/解包密钥（对原始密钥字节做 GCM）。
export function wrapKey(auk: Buffer, keyBytes: Buffer): string { return aesEncrypt(auk, keyBytes); }
export function unwrapKey(auk: Buffer, blob: string): Buffer { return aesDecrypt(auk, blob); }

// 条目 JSON 加解密（用 VaultKey）。
export function encryptJSON(vaultKey: Buffer, obj: unknown): string { return aesEncrypt(vaultKey, Buffer.from(JSON.stringify(obj), "utf8")); }
export function decryptJSON<T = unknown>(vaultKey: Buffer, blob: string): T { return JSON.parse(aesDecrypt(vaultKey, blob).toString("utf8")) as T; }

export function newVaultKey(): Buffer { return crypto.randomBytes(32); }

// ── 密码生成器 ──
export interface GenOpts { length?: number; lower?: boolean; upper?: boolean; digits?: boolean; symbols?: boolean; readable?: boolean }
export function generatePassword(opts: GenOpts = {}): string {
  const o = { length: 20, lower: true, upper: true, digits: true, symbols: true, readable: false, ...opts };
  let lower = "abcdefghijklmnopqrstuvwxyz", upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", digits = "0123456789", symbols = "!@#$%^&*()-_=+[]{};:,.?";
  if (o.readable) { // 去除易混淆字符
    lower = lower.replace(/[loi]/g, ""); upper = upper.replace(/[LOI]/g, ""); digits = digits.replace(/[01]/g, ""); symbols = "!@#$%^&*-_=+";
  }
  const sets: string[] = [];
  if (o.lower) sets.push(lower);
  if (o.upper) sets.push(upper);
  if (o.digits) sets.push(digits);
  if (o.symbols) sets.push(symbols);
  if (!sets.length) sets.push(lower);
  const all = sets.join("");
  const len = Math.max(4, Math.min(o.length, 128));
  const chars: string[] = [];
  for (const s of sets) chars.push(s[crypto.randomInt(s.length)]);           // 保证每类至少一个
  while (chars.length < len) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; } // Fisher–Yates 洗牌
  return chars.join("");
}
