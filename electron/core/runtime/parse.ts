// 运行时探测的**纯解析层**：只做「字符串 → 结构」，不碰文件系统、不起子进程。
//
// 单独拆一层的理由：探测本身全是 IO（跑 java_home、扫目录、读 realpath），在 CI 里跑不了；
// 而真正容易错的恰恰是解析 —— 各家命令的输出格式五花八门，还会随版本变。
// 把解析摘出来之后这些格式全都能用真实样本钉住（见 tests/runtime.test.ts）。
//
// 设计与取舍见 doc/运行时环境-设计与待办.md。

/** 支持的运行时种类。一期只有这两个（Node / Flutter 见文档二期）。 */
export type RuntimeKind = "java" | "python";

/** 一个「装在机器上的运行时」。同一个物理安装只出现一次（按 realpath 去重）。 */
export interface Install {
  id: string;
  kind: RuntimeKind;
  version: string;
  raw: string;
  home: string;
  bin: string;
  vendor: string;
  arch: string;
  source: string;
  managed: boolean;
}

/** 「当前生效的是哪个」。刻意是多条而不是单值 —— 命令行与构建工具的答案经常不一样。 */
export interface Active {
  who: string;
  installId: string;
  reason: string;
  path: string;
}

/** 一条诊断。fix 是给用户自己去终端执行的命令，Umbra 不代跑。 */
export interface Issue {
  code: string;
  level: "error" | "warn" | "info";
  title: string;
  detail: string;
  fix: string;
}

export interface ManagerInfo { name: string; version: string; path: string }

export interface RuntimeScan {
  kind: RuntimeKind;
  installs: Install[];
  actives: Active[];
  issues: Issue[];
  managers: ManagerInfo[];
  aliases: Record<string, string>;
  pathDirs: string[];
  scannedAt: number;
  elapsedMs: number;
  /** 哪些探测超时/失败了。**必须显示** —— 静默少一条比报错更坏。 */
  partial: string[];
}

// ── 版本号 ────────────────────────────────────────────────────────────────────

// 从一行文本里抠出版本号。各家的格式差别很大：
//   Java   openjdk version "21.0.5" 2024-10-15        → 引号里
//   Java 8 java version "1.8.0_432"                    → 带下划线的 build 号
//   Python Python 3.12.4                               → 空格后
//   Python Python 3.13.0rc1                            → 带预发布后缀
// 统一只取「数字.数字[.数字]」这一段，后缀（_432 / rc1）丢给 raw 保留。
const VER = /(\d+(?:\.\d+){0,2})/;

/**
 * 从一个 token 里抠出规范化的版本号。取不到返回空串。
 *
 * 所有拿到版本号的路径都必须过这里 —— 一开始 java_home 的解析直接调 normalizeVersion，
 * 结果 `1.8.0_432` 这个 token 因为带后缀匹配不上归一规则，同一个 JDK 在
 * 「java -version」和「java_home -V」两条路径下显示成 8 和 1.8.0_432 两个样子。
 */
export function numericVersion(token: string): string {
  const m = VER.exec(token || "");
  return m ? normalizeVersion(m[1]) : "";
}

/** 从命令输出里取版本号。取不到返回空串（调用方据此判定探测失败，不要伪造一个 0.0.0）。 */
export function parseVersion(out: string): string {
  const first = (out || "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
  // 引号里的优先（Java 的 `openjdk version "21.0.5"`）：行尾还有个发布日期 2024-10-15，
  // 不先看引号会把日期的 2024 当成版本号。
  const q = /"([^"]+)"/.exec(first);
  return numericVersion(q ? q[1] : first);
}

/** Java 8 及更早的 `1.8.0` 归一成 `8`：用户认的是「Java 8」，没人说「Java 1.8」。 */
export function normalizeVersion(v: string): string {
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(v);
  if (m) return m[2] && m[2] !== "0" ? `${m[1]}.0.${m[2]}` : m[1];
  return v;
}

/** 版本号比较（降序排列用）。段数不同时缺的段当 0；非数字段当 0，不抛。 */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 稳定 id：kind + 真实路径。刷新后不变，UI 的展开态/选中态才不会跳。 */
export function installId(kind: RuntimeKind, realPath: string): string {
  let h = 0;
  const s = `${kind}:${realPath}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${kind}-${(h >>> 0).toString(36)}`;
}

// ── Java：/usr/libexec/java_home -V ───────────────────────────────────────────

// 苹果官方的枚举方式，输出长这样（注意它走 **stderr**）：
//
//   Matching Java Virtual Machines (3):
//       21.0.5 (arm64) "Eclipse Adoptium" - "OpenJDK 21.0.5" /Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home
//       17.0.9 (arm64) "Azul Systems, Inc." - "Zulu 17.46.19" /Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home
//       1.8.0_432 (x86_64) "Oracle Corporation" - "Java SE 8" /Library/Java/JavaVirtualMachines/jdk1.8.0_432.jdk/Contents/Home
//   /Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home
//
// 最后一行是「默认 JDK」，不是列表项 —— 解析时必须靠「行里有版本号和括号架构」来认，
// 不能靠缩进（不同系统版本的缩进对不齐）。
const JVM_LINE = /^\s*(\S+)\s+\(([^)]+)\)\s+"([^"]*)"\s*-\s*"([^"]*)"\s+(\/.+?)\s*$/;

export interface JvmEntry { version: string; arch: string; vendor: string; name: string; home: string; raw: string }

/** 解析 `java_home -V` 的输出。认不出的行一律跳过（宁可少一条也不要造假数据）。 */
export function parseJavaHomeList(out: string): JvmEntry[] {
  const rows: JvmEntry[] = [];
  for (const line of (out || "").split("\n")) {
    const m = JVM_LINE.exec(line);
    if (!m) continue;
    rows.push({
      // 走 numericVersion 而不是 normalizeVersion：这里的 token 可能是 `1.8.0_432`，
      // 带后缀匹配不上归一规则，直接归一会让同一个 JDK 在两条探测路径下显示成两个样子。
      version: numericVersion(m[1]),
      arch: m[2].trim(),
      vendor: m[3].trim(),
      name: m[4].trim(),
      home: m[5].trim(),
      raw: line.trim(),
    });
  }
  return rows;
}

/** Java 厂商名太长，列表里放不下。归一成短名，认不出就原样截断。 */
export function shortVendor(vendor: string, name = ""): string {
  const s = `${vendor} ${name}`.toLowerCase();
  if (s.includes("adoptium") || s.includes("temurin")) return "Temurin";
  if (s.includes("azul") || s.includes("zulu")) return "Zulu";
  if (s.includes("oracle")) return "Oracle";
  if (s.includes("amazon") || s.includes("corretto")) return "Corretto";
  if (s.includes("graal")) return "GraalVM";
  if (s.includes("microsoft")) return "Microsoft";
  if (s.includes("homebrew") || s.includes("openjdk.org")) return "OpenJDK";
  if (s.includes("jetbrains")) return "JetBrains";
  if (s.includes("sap")) return "SapMachine";
  return vendor.trim().slice(0, 14);
}

// ── Python：pyenv ─────────────────────────────────────────────────────────────

// `pyenv versions` 的输出：
//   * system (set by /Users/sam/.pyenv/version)
//     3.11.9
//     3.12.4 (set by /Users/sam/proj/.python-version)
// 星号标当前。括号里的「set by」只出现在当前那一行。
const PYENV_ROW = /^(\*?)\s*([^\s(]+)\s*(?:\(set by (.+)\))?\s*$/;

export interface PyenvVersion { name: string; active: boolean; setBy: string }

/** 解析 `pyenv versions`。`system` 也是一个合法版本名，不要过滤掉。 */
export function parsePyenvVersions(out: string): PyenvVersion[] {
  const rows: PyenvVersion[] = [];
  for (const line of (out || "").split("\n")) {
    const s = line.trimEnd();
    if (!s.trim()) continue;
    const m = PYENV_ROW.exec(s.trim());
    if (!m || !m[2]) continue;
    rows.push({ name: m[2], active: m[1] === "*", setBy: (m[3] || "").trim() });
  }
  return rows;
}

// `pyenv version` 的输出（官方描述："along with information on how it was set"）：
//   3.12.4 (set by /Users/sam/proj/.python-version)
//   3.11.9 (set by PYENV_VERSION environment variable)
// 「谁定的」这一句是整个功能最值钱的信息，单独解析。
const PYENV_CUR = /^\s*(\S+)\s*(?:\(set by (.+)\))?\s*$/;

/** 解析 `pyenv version` → 当前版本 + 是谁定的。 */
export function parsePyenvCurrent(out: string): { version: string; setBy: string } {
  const first = (out || "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
  const m = PYENV_CUR.exec(first);
  if (!m) return { version: "", setBy: "" };
  return { version: m[1] || "", setBy: (m[2] || "").trim() };
}

/** 把 pyenv 的 setBy 文案翻成中文（原文是英文，直接摆给小白看不友好）。 */
export function explainSetBy(setBy: string): string {
  if (!setBy) return "";
  if (/PYENV_VERSION/.test(setBy)) return "环境变量 PYENV_VERSION";
  if (/\.python-version$/.test(setBy)) return `版本文件 ${setBy}`;
  if (/\/version$/.test(setBy)) return `全局默认（${setBy}）`;
  return setBy;
}

// ── Python：uv ────────────────────────────────────────────────────────────────

// `uv python list` 的输出（列是「标识  路径」，路径可能是 <download available> 表示没装）：
//   cpython-3.13.1-macos-aarch64-none    /Users/sam/.local/share/uv/python/cpython-3.13.1-.../bin/python3
//   cpython-3.12.8-macos-aarch64-none    <download available>
// 只要**已装**的（路径以 / 开头）。
export interface UvPython { key: string; version: string; path: string }

export function parseUvPythonList(out: string): UvPython[] {
  const rows: UvPython[] = [];
  for (const line of (out || "").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    const parts = s.split(/\s+/);
    if (parts.length < 2) continue;
    const key = parts[0];
    const p = parts[parts.length - 1];
    if (!p.startsWith("/")) continue;                 // <download available> 之类
    const m = /-(\d+(?:\.\d+){1,2})-/.exec(key) || VER.exec(key);
    if (!m) continue;
    rows.push({ key, version: normalizeVersion(m[1]), path: p });
  }
  return rows;
}

// ── pip 归属 ──────────────────────────────────────────────────────────────────

// `pip -V` 的输出固定是这个形状：
//   pip 24.0 from /usr/lib/python3/dist-packages/pip (python 3.11)
//   pip 24.2 from /opt/homebrew/lib/python3.12/site-packages/pip (python 3.12)
// 我们要的就是 from 后面那个路径 —— 判断「pip3 和 python3 是不是同一套」靠它。
const PIP_FROM = /\bfrom\s+(.+?)\s+\(python\s/;

/**
 * 从 `pip -V` 的输出里取出 pip 包所在的目录。取不到返回空串。
 *
 * 为什么不比 sys.prefix：一开始是拿 `python3 -c 'print(sys.prefix)'` 和「pip 路径去掉
 * site-packages 后缀」比，结果 Debian 系用的是 **dist-packages** 不是 site-packages，
 * 后缀剥不掉 → 前缀永远不相等 → 每台 Debian/Ubuntu 机器都误报一条 P5。
 * 直接比两个 pip 的 from 路径没有这个问题：同一个 pip 就是同一个路径，跟发行版无关。
 */
export function parsePipFrom(out: string): string {
  const m = PIP_FROM.exec(out || "");
  return m ? m[1].trim() : "";
}

// ── Python 安装来源归类 ───────────────────────────────────────────────────────

/**
 * 按 bin 的真实路径判定这个 Python 是哪来的。
 *
 * 为什么需要它：`uv python list` **会把系统自带的 Python 也列出来**（在这台容器上它报了
 * /usr/bin/python3.11 ~ 3.13）。照单全收就会把系统的 Python 标成「uv 装的、由 uv 管着」——
 * 用户看到会以为能用 uv 去切它们。所以谁列出来的不重要，**路径**才是来源的真相。
 */
export function pythonSource(bin: string, uvDir: string, pyenvRoot: string): { source: string; managed: boolean } {
  if (uvDir && bin.startsWith(uvDir)) return { source: "uv", managed: true };
  if (pyenvRoot && bin.startsWith(pyenvRoot)) return { source: "pyenv", managed: true };
  if (bin.startsWith("/Library/Frameworks/Python.framework/")) return { source: "framework", managed: false };
  if (/(^|\/)(mini|ana)(conda|forge)\d*\//.test(bin)) return { source: "conda", managed: false };
  if (bin.startsWith("/opt/homebrew/") || bin.includes("/Cellar/") || bin.startsWith("/usr/local/Cellar")) return { source: "homebrew", managed: false };
  if (bin.startsWith("/usr/bin/") || bin.startsWith("/bin/")) return { source: "system", managed: false };
  return { source: "path", managed: false };
}

// ── shell 别名 ────────────────────────────────────────────────────────────────

// `zsh -ic 'alias'` 的输出，每行 `name=value`，value 可能带引号：
//   python='/usr/bin/python3'
//   ll='ls -lah'
// 只保留和本语言相关的（全量别名动辄上百条，摆出来是噪音）。
const ALIAS_LINE = /^([A-Za-z_][\w.-]*)=(.*)$/;

/** 解析别名输出，只留 keys 里点名的那些（前缀匹配，如 python 命中 python3）。 */
export function parseAliases(out: string, keys: string[]): Record<string, string> {
  const hit: Record<string, string> = {};
  for (const line of (out || "").split("\n")) {
    const m = ALIAS_LINE.exec(line.trim());
    if (!m) continue;
    const name = m[1];
    if (!keys.some((k) => name === k || name.startsWith(k))) continue;
    let v = m[2].trim();
    // 去掉最外层引号；内部的 '\'' 还原成 '
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1).replace(/'\\''/g, "'");
    }
    hit[name] = v;
  }
  return hit;
}

// ── PATH ─────────────────────────────────────────────────────────────────────

/** 拆 PATH 成目录数组，去掉空段但**保留重复**（重复本身是要诊断的病）。 */
export function splitPath(p: string): string[] {
  return (p || "").split(":").filter((x) => x.length > 0);
}

/** PATH 里重复出现的目录（按首次出现顺序，每个只报一次）。 */
export function dupDirs(dirs: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const d of dirs) {
    if (seen.has(d)) dup.add(d);
    seen.add(d);
  }
  return [...dup];
}

/** 在 a 里、不在 b 里的目录。用来对比「登录 shell 的 PATH」和「Umbra 的 PATH」。 */
export function pathDiff(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return [...new Set(a.filter((d) => !set.has(d)))];
}

// ── 去重与排序 ────────────────────────────────────────────────────────────────

/**
 * 按 realpath 去重，保留**先出现**的那条。
 *
 * 顺序即优先级：调用方先塞 L1（管理器给的，知道「谁定的」），再塞 L2（扫目录），
 * 最后塞 L3（扫 PATH 兜底）。同一个物理安装被多层命中时留住信息最全的那条。
 */
export function dedupeInstalls(list: Install[]): Install[] {
  const seen = new Set<string>();
  const out: Install[] = [];
  for (const i of list) {
    const key = i.bin || i.home;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

/** 版本降序（新的在上）；版本相同时按来源名排，保证顺序稳定不抖。 */
export function sortInstalls(list: Install[]): Install[] {
  return [...list].sort((a, b) => cmpVersion(b.version, a.version) || a.source.localeCompare(b.source));
}
