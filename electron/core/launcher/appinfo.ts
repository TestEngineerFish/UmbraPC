// 读 macOS 应用包里的名字（展示名 / 包名 / bundle id），不依赖任何外部命令。
//
// 为什么要自己读：应用包的**文件名和展示名经常不是一回事**。
// /Applications/企业微信.app 的 CFBundleDisplayName 是 WeCom，只按文件名搜就永远搜不到它。
// 之前试过用 mdls 批量取展示名，但那条路依赖 Spotlight 索引和 mdls 的输出格式，
// 在我这边没法验证，出问题还是静默失效（整张表变空 → 表现成「某些应用搜不到」，极难定位）。
// Info.plist 一定在包里、格式是公开的，读它是唯一稳的做法。
//
// Info.plist 绝大多数是**二进制 plist**（bplist00），所以这里带一个只够用的解析器：
// 只解顶层字典里那几个字符串键，不做通用 plist 支持。XML 格式的走正则。
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { withPinyin } from "./pinyin";

export interface BundleNames {
  display?: string;   // CFBundleDisplayName（Finder 显示的名字，优先取本地化版本）
  name?: string;      // CFBundleName（短名）
  id?: string;        // CFBundleIdentifier（com.tencent.WeWorkMac 这种，也值得参与搜索）
  aliases?: string[]; // 各语言 InfoPlist.strings 里的名字，全部参与搜索
}

const WANTED = ["CFBundleDisplayName", "CFBundleName", "CFBundleIdentifier"] as const;

// 本地化名字放在 Contents/Resources/<语言>.lproj/InfoPlist.strings 里，**会覆盖 Info.plist**。
// /Applications/企业微信.app 就是这样：文件名和 CFBundleExecutable 都是中文，
// 而 Finder / Spotlight 显示的 "WeCom" 来自 en.lproj/InfoPlist.strings。
// 只读 Info.plist 就永远拿不到 WeCom，打 wecom 自然搜不到。
// 这里把常见语言的都读进来当**搜索别名**——中英文哪个都能搜到，和 Spotlight 的表现一致。
// 顺序即优先级：靠前的先用作列表标题。
const LPROJ = ["Base.lproj", "en.lproj", "en-US.lproj", "English.lproj", "zh-Hans.lproj", "zh_CN.lproj", "zh-Hant.lproj"];

// ── 二进制 plist（bplist00）──────────────────────────────────────────────
// 结构：header(8) + 对象区 + 偏移表 + trailer(32)。
// trailer 末尾依次是 offsetSize(1) objectRefSize(1) numObjects(8) topObject(8) offsetTableOffset(8)。
function readBinaryPlistStrings(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  if (buf.length < 40 || buf.subarray(0, 6).toString("latin1") !== "bplist") return out;

  const trailer = buf.subarray(buf.length - 32);
  const offsetSize = trailer.readUInt8(6);
  const objectRefSize = trailer.readUInt8(7);
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const offsetTableOffset = Number(trailer.readBigUInt64BE(24));
  if (!offsetSize || !objectRefSize || numObjects <= 0) return out;
  if (offsetTableOffset + numObjects * offsetSize > buf.length) return out;

  const readSized = (at: number, size: number): number => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf.readUInt8(at + i);
    return v;
  };
  const offsetAt = (i: number): number => readSized(offsetTableOffset + i * offsetSize, offsetSize);

  // 对象头：高 4 位是类型，低 4 位是长度；长度为 0xF 时后面跟一个整型对象表示真实长度。
  const readLength = (at: number): { len: number; next: number } => {
    const low = buf.readUInt8(at) & 0x0f;
    if (low !== 0x0f) return { len: low, next: at + 1 };
    const intMarker = buf.readUInt8(at + 1);
    if ((intMarker & 0xf0) !== 0x10) return { len: 0, next: at + 2 };
    const size = 1 << (intMarker & 0x0f);
    return { len: readSized(at + 2, size), next: at + 2 + size };
  };

  const readString = (idx: number): string | null => {
    if (idx < 0 || idx >= numObjects) return null;
    const at = offsetAt(idx);
    if (at < 0 || at >= buf.length) return null;
    const type = buf.readUInt8(at) & 0xf0;
    const { len, next } = readLength(at);
    if (type === 0x50) return buf.subarray(next, next + len).toString("latin1");          // ASCII
    if (type === 0x60) return buf.subarray(next, next + len * 2).toString("utf16le").split("").length
      ? Buffer.from(buf.subarray(next, next + len * 2)).swap16().toString("utf16le")       // UTF-16BE
      : "";
    return null;
  };

  // 顶层必须是字典（0xD_）
  const topAt = offsetAt(topObject);
  if (topAt < 0 || topAt >= buf.length || (buf.readUInt8(topAt) & 0xf0) !== 0xd0) return out;
  const { len: count, next: keysAt } = readLength(topAt);
  const valsAt = keysAt + count * objectRefSize;
  if (valsAt + count * objectRefSize > buf.length) return out;

  for (let i = 0; i < count; i++) {
    const keyRef = readSized(keysAt + i * objectRefSize, objectRefSize);
    const key = readString(keyRef);
    if (!key || !(WANTED as readonly string[]).includes(key)) continue;
    const valRef = readSized(valsAt + i * objectRefSize, objectRefSize);
    const val = readString(valRef);
    if (val) out[key] = val;
  }
  return out;
}

// ── XML plist ──────────────────────────────────────────────────────────
function readXmlPlistStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of WANTED) {
    const m = text.match(new RegExp(`<key>${k}</key>\\s*<string>([\\s\\S]*?)</string>`));
    if (m) out[k] = m[1].trim();
  }
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

// .strings 有三种存法：二进制 plist / UTF-16 文本 / UTF-8 文本。三种都认。
function readStringsFile(buf: Buffer): Record<string, string> {
  if (buf.subarray(0, 6).toString("latin1") === "bplist") return readBinaryPlistStrings(buf);
  let text: string;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString("utf16le");
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) text = Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  else text = buf.toString("utf-8");
  const out: Record<string, string> = {};
  for (const k of WANTED) {
    // 形如：  "CFBundleDisplayName" = "WeCom";   （键的引号可有可无）
    const m = text.match(new RegExp(`"?${k}"?\\s*=\\s*"([^"]*)"\\s*;`));
    if (m) out[k] = m[1];
  }
  return out;
}

// 读一个 .app 的名字。读不到就返回空对象，调用方回落到文件名。
export async function readBundleNames(appPath: string): Promise<BundleNames> {
  const pick = (v?: string) => {
    const s = (v || "").trim();
    return s ? decodeEntities(s) : undefined;
  };

  let base: Record<string, string> = {};
  try {
    const buf = await fs.readFile(path.join(appPath, "Contents", "Info.plist"));
    base = buf.subarray(0, 6).toString("latin1") === "bplist"
      ? readBinaryPlistStrings(buf)
      : readXmlPlistStrings(buf.toString("utf-8"));
  } catch {
    /* 没有 Info.plist 就只靠本地化文件 / 文件名 */
  }

  // 各语言的本地化名字：全部收进别名，并按 LPROJ 的顺序挑一个当展示名。
  const aliases: string[] = [];
  let localized: string | undefined;
  const got = await Promise.all(LPROJ.map(async (lp) => {
    try {
      return readStringsFile(await fs.readFile(path.join(appPath, "Contents", "Resources", lp, "InfoPlist.strings")));
    } catch {
      return {} as Record<string, string>;   // 这个语言没有就跳过，失败是常态不是异常
    }
  }));
  for (const r of got) {
    for (const v of [pick(r.CFBundleDisplayName), pick(r.CFBundleName)]) {
      if (!v) continue;
      if (!localized) localized = v;
      if (!aliases.includes(v)) aliases.push(v);
    }
  }

  return {
    display: pick(base.CFBundleDisplayName) || localized,
    name: pick(base.CFBundleName),
    id: pick(base.CFBundleIdentifier),
    aliases,
  };
}

// 一个应用参与搜索的所有名字：文件名 + 展示名 + 短名 + 各语言本地化名 + bundle id 的后半段。
// bundle id 只取最后一段（com.tencent.WeWorkMac → WeWorkMac）：整串带着 com/inc 这些
// 通用词，几乎任何查询都能蹭上，反而制造噪音。
export function searchableNames(appPath: string, b: BundleNames): string[] {
  const file = path.basename(appPath).replace(/\.app$/i, "");
  const idTail = b.id ? b.id.split(".").pop() || "" : "";
  const all = [file, b.display || "", b.name || "", ...(b.aliases || []), idTail];
  // withPinyin 负责去重，并给含汉字的名字各补一条拼音首字母别名（企业微信 → qywx）。
  return withPinyin(all);
}
