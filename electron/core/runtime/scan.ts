// 运行时探测的 **IO 层**：跑命令、扫目录、读 realpath。解析一律交给 parse.ts。
//
// 探测分三层（doc/运行时环境-设计与待办.md §3）：
//   L1 问管理器（java_home / pyenv / uv）—— 最准，因为它知道「谁定的」
//   L2 扫已知目录 —— 管理器没装时的主力
//   L3 扫 PATH 上**所有**同名可执行文件 —— 兜底，也是「多个 python3 打架」的唯一发现手段
// 后塞的不覆盖先塞的（dedupeInstalls 保留先出现的），所以调用顺序就是优先级。
import { existsSync, readdirSync, realpathSync, statSync, accessSync, constants, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { run } from "../shared/util";
import {
  type Install, type Issue, type ManagerInfo, type RuntimeKind, type RuntimeScan,
  type Active,
  dedupeInstalls, explainSetBy, installId, normalizeVersion, parseAliases, parseJavaHomeList,
  parsePipFrom, parsePyenvCurrent, parsePyenvVersions, parseUvPythonList, parseVersion,
  pythonSource, shortVendor, sortInstalls, splitPath,
} from "./parse";
import { diagnoseEnv, diagnoseJava, diagnosePython, sortIssues } from "./diagnose";

// 单条探测命令的超时。这些都是「问一句版本」的轻命令，2.5 秒不回就是环境有问题，
// 继续等只会让整个页面卡住 —— 超时会记进 partial 显式告诉用户。
const PROBE_MS = 2500;
// 交互式 shell 要 source 用户完整的 rc 文件，慢得多，单独给一个宽限。
const SHELL_MS = 4000;

/** PATH 上**所有**叫 cmd 的可执行文件（现有的 which 只给第一个）。顺序即 PATH 顺序。 */
export function whichAll(cmd: string, pathStr?: string): string[] {
  const dirs = splitPath(pathStr || process.env.PATH || "");
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const full = path.join(dir, cmd);
    if (seen.has(full)) continue;      // PATH 里有重复目录时别报两遍同一个文件
    seen.add(full);
    try {
      accessSync(full, constants.X_OK);
      statSync(full);                  // 排掉指向已删除目标的断链符号链接
      hits.push(full);
    } catch { /* 这个目录里没有 */ }
  }
  return hits;
}

/** realpath，失败就原样返回（断链、权限不足时不要把整次扫描搞崩）。 */
function real(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** 目录下的一级子目录名。目录不存在返回空数组 —— 「没装」是常态不是错误。 */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch { return []; }
}

/** 探测上下文：收集 partial（失败项）并统一跑命令。 */
class Probe {
  readonly partial: string[] = [];
  /** 跑一条命令拿 stdout+stderr。失败/超时都记进 partial 并返回空串。 */
  async out(label: string, cmd: string, args: string[], ms = PROBE_MS): Promise<string> {
    try {
      const r = await run(cmd, args, { timeoutMs: ms });
      if (r.timedOut) { this.partial.push(`${label}：超时（${ms}ms）`); return ""; }
      // 注意 java_home -V 走 stderr，而 run() 的 output 是 stdout+stderr 合并的 —— 正好。
      // 非零退出码不一定是错（java_home 找不到指定版本时也返回非零），所以照样把输出给出去。
      return r.output || "";
    } catch (e) {
      this.partial.push(`${label}：${String(e).replace("Error: ", "").slice(0, 80)}`);
      return "";
    }
  }
}

/**
 * 登录 shell 的真实 PATH 与相关别名。
 *
 * 为什么要单独跑一次交互式 shell：macOS 的 GUI 程序不继承登录 shell 的 PATH
 * （main.ts 的 fixPath 已经因为这个问题存在了），而**别名只存在于交互式 shell 里** ——
 * `-i` 是拿别名的唯一办法，任何子进程都看不到别人的别名。
 *
 * 代价要认：`-i` 会执行用户完整的 rc 文件，可能慢、可能有副作用。所以给了 4 秒上限，
 * 失败就当没有，绝不重试。
 */
export async function readShellEnv(aliasKeys: string[]): Promise<{ pathDirs: string[]; aliases: Record<string, string>; err: string }> {
  if (process.platform === "win32") return { pathDirs: [], aliases: {}, err: "" };
  const sh = process.env.SHELL || "/bin/zsh";
  // 两样东西一次问完：起一个交互式 shell 就要几百毫秒，问两次是纯浪费。
  // 用不会出现在正常输出里的哨兵切分，免得被 rc 文件自己打印的东西干扰。
  const script = 'echo "__UMBRA_P__:$PATH"; echo "__UMBRA_A__"; alias 2>/dev/null';
  const out = await new Promise<string>((resolve) => {
    try {
      execFile(sh, ["-ilc", script], { timeout: SHELL_MS, maxBuffer: 1 << 20 }, (_e, stdout) => resolve(stdout || ""));
    } catch { resolve(""); }
  });
  if (!out) return { pathDirs: [], aliases: {}, err: `读不到登录 shell（${sh}）的环境` };
  const pm = /__UMBRA_P__:(.*)/.exec(out);
  const ai = out.indexOf("__UMBRA_A__");
  return {
    pathDirs: pm ? splitPath(pm[1].trim()) : [],
    aliases: ai >= 0 ? parseAliases(out.slice(ai + "__UMBRA_A__".length), aliasKeys) : {},
    err: "",
  };
}

// ── Java ─────────────────────────────────────────────────────────────────────

const JVM_DIRS = ["/Library/Java/JavaVirtualMachines", "/System/Library/Java/JavaVirtualMachines"];

async function scanJava(p: Probe, pathDirs: string[]): Promise<{ installs: Install[]; actives: Active[]; issues: Issue[]; managers: ManagerInfo[] }> {
  const raw: Install[] = [];
  const managers: ManagerInfo[] = [];

  // ── L1：/usr/libexec/java_home -V（苹果官方枚举，输出走 stderr）
  if (process.platform === "darwin" && existsSync("/usr/libexec/java_home")) {
    const out = await p.out("java_home -V", "/usr/libexec/java_home", ["-V"]);
    for (const e of parseJavaHomeList(out)) {
      const bin = real(path.join(e.home, "bin", "java"));
      raw.push({
        id: installId("java", bin), kind: "java", version: e.version, raw: e.raw,
        home: e.home, bin, vendor: shortVendor(e.vendor, e.name), arch: e.arch,
        source: e.home.includes("/.sdkman/") ? "sdkman" : e.home.startsWith("/opt/homebrew") || e.home.startsWith("/usr/local/Cellar") ? "homebrew" : "jvm-dir",
        managed: e.home.includes("/.sdkman/"),
      });
    }
  }

  // ── L2：扫标准 JVM 目录 + SDKMAN。java_home 认不出的（手动解压的 JDK）在这里补上。
  const dirs = [...JVM_DIRS, path.join(os.homedir(), ".sdkman/candidates/java")];
  for (const d of dirs) {
    for (const name of subdirs(d)) {
      const home = existsSync(path.join(d, name, "Contents/Home"))
        ? path.join(d, name, "Contents/Home")
        : path.join(d, name);
      const javaBin = path.join(home, "bin", "java");
      if (!existsSync(javaBin)) continue;
      const bin = real(javaBin);
      if (raw.some((i) => i.bin === bin)) continue;
      const out = await p.out(`${name} 的版本`, javaBin, ["-version"]);
      const version = parseVersion(out);
      if (!version) continue;
      raw.push({
        id: installId("java", bin), kind: "java", version, raw: (out.split("\n")[0] || "").trim(),
        home, bin, vendor: shortVendor(out), arch: /x86_64|amd64/i.test(out) ? "x86_64" : "",
        source: d.includes(".sdkman") ? "sdkman" : "jvm-dir",
        managed: d.includes(".sdkman"),
      });
    }
  }

  // ── L3：PATH 上所有的 java
  for (const hit of whichAll("java", pathDirs.join(":"))) {
    const bin = real(hit);
    if (raw.some((i) => i.bin === bin)) continue;
    const out = await p.out(`${hit} 的版本`, hit, ["-version"]);
    const version = parseVersion(out);
    if (!version) continue;
    raw.push({
      id: installId("java", bin), kind: "java", version, raw: (out.split("\n")[0] || "").trim(),
      home: path.dirname(path.dirname(bin)), bin, vendor: shortVendor(out), arch: "",
      source: "path", managed: false,
    });
  }

  const installs = sortInstalls(dedupeInstalls(raw));

  // ── 「当前生效」：命令行的 java 与 JAVA_HOME 是两个独立答案
  const actives: Active[] = [];
  const cliJava = whichAll("java", pathDirs.join(":"))[0] || "";
  let cliVersion = "";
  if (cliJava) {
    const rp = real(cliJava);
    // macOS 的 /usr/bin/java 是个转发器，它自己去挑 JDK —— 所以要真跑一次才知道是哪个版本。
    cliVersion = parseVersion(await p.out("java -version", cliJava, ["-version"]));
    const hit = installs.find((i) => i.bin === rp) || installs.find((i) => i.version === cliVersion);
    actives.push({
      who: "终端里的 java", installId: hit?.id || "", path: cliJava,
      reason: cliJava === "/usr/bin/java" ? "系统转发器自动挑最新的 JDK" : "PATH 第一个匹配",
    });
  }
  const javaHome = process.env.JAVA_HOME || "";
  const javaHomeExists = !!javaHome && existsSync(javaHome);
  let javaHomeVersion = "";
  if (javaHomeExists) {
    const hb = real(path.join(javaHome, "bin", "java"));
    const hit = installs.find((i) => i.bin === hb);
    javaHomeVersion = hit?.version || parseVersion(await p.out("JAVA_HOME 的版本", path.join(javaHome, "bin", "java"), ["-version"]));
    actives.push({ who: "Maven / Gradle", installId: hit?.id || "", path: javaHome, reason: "环境变量 JAVA_HOME" });
  } else if (javaHome) {
    actives.push({ who: "Maven / Gradle", installId: "", path: javaHome, reason: "环境变量 JAVA_HOME（目录不存在）" });
  }

  if (existsSync(path.join(os.homedir(), ".sdkman"))) managers.push({ name: "SDKMAN", version: "", path: path.join(os.homedir(), ".sdkman") });
  if (existsSync(path.join(os.homedir(), ".jenv"))) managers.push({ name: "jenv", version: "", path: path.join(os.homedir(), ".jenv") });

  const issues = diagnoseJava({ installs, javaHome, javaHomeExists, javaHomeVersion, cliVersion });
  return { installs, actives, issues, managers };
}

// ── Python ───────────────────────────────────────────────────────────────────

async function scanPython(p: Probe, pathDirs: string[]): Promise<{ installs: Install[]; actives: Active[]; issues: Issue[]; managers: ManagerInfo[] }> {
  const raw: Install[] = [];
  const managers: ManagerInfo[] = [];
  const home = os.homedir();
  const pyenvRoot = process.env.PYENV_ROOT || path.join(home, ".pyenv");
  const pyenvDir = existsSync(pyenvRoot);
  let pyenvVersions: string[] = [];
  let pyenvSetBy = "";
  let pyenvCurrent = "";

  // ── L1：pyenv。它是唯一会告诉你「当前版本是谁定的」的工具（官方描述原话）。
  const pyenvBin = whichAll("pyenv", pathDirs.join(":"))[0] || (pyenvDir ? path.join(pyenvRoot, "bin/pyenv") : "");
  if (pyenvBin && existsSync(pyenvBin)) {
    const ver = parseVersion(await p.out("pyenv --version", pyenvBin, ["--version"]));
    managers.push({ name: "pyenv", version: ver, path: pyenvRoot });
    pyenvVersions = parsePyenvVersions(await p.out("pyenv versions", pyenvBin, ["versions"]))
      .map((v) => v.name).filter((n) => n !== "system");
    const cur = parsePyenvCurrent(await p.out("pyenv version", pyenvBin, ["version"]));
    pyenvCurrent = cur.version;
    pyenvSetBy = cur.setBy;
    for (const name of pyenvVersions) {
      const bin = real(path.join(pyenvRoot, "versions", name, "bin/python3"));
      if (!existsSync(bin)) continue;
      raw.push({
        id: installId("python", bin), kind: "python", version: normalizeVersion(name), raw: name,
        home: path.join(pyenvRoot, "versions", name), bin, vendor: "", arch: "",
        source: "pyenv", managed: true,
      });
    }
  } else if (pyenvDir) {
    // 目录在但命令调不到 —— 这本身就是 P2 要报的病，别当成「没装 pyenv」。
    managers.push({ name: "pyenv", version: "", path: pyenvRoot });
    pyenvVersions = subdirs(path.join(pyenvRoot, "versions"));
  }

  // ── L1：uv（Python 圈正在从 pyenv 往它迁）
  //
  // 坑：`uv python list` **会把系统自带的 Python 也列出来**（在 Linux 容器上实测它报了
  // /usr/bin/python3.11 ~ 3.13）。所以「uv 列出来的」≠「uv 装的」——
  // 一律标成 source=uv/managed=true 会让用户以为这些能用 uv 切换。来源按**路径**判定。
  const uvDir = process.env.UV_PYTHON_INSTALL_DIR || path.join(home, ".local/share/uv/python");
  const uvBin = whichAll("uv", pathDirs.join(":"))[0] || "";
  if (uvBin) {
    managers.push({ name: "uv", version: parseVersion(await p.out("uv --version", uvBin, ["--version"])), path: uvBin });
    for (const u of parseUvPythonList(await p.out("uv python list", uvBin, ["python", "list"]))) {
      const bin = real(u.path);
      if (raw.some((i) => i.bin === bin)) continue;
      const src = pythonSource(bin, uvDir, pyenvRoot);
      raw.push({
        id: installId("python", bin), kind: "python", version: u.version, raw: u.key,
        home: path.dirname(path.dirname(bin)),
        bin, vendor: "", arch: "", source: src.source, managed: src.managed,
      });
    }
  }

  // ── L2：python.org 安装包 + Homebrew + conda
  const l2: { dir: string; source: string; rel: string }[] = [
    { dir: "/Library/Frameworks/Python.framework/Versions", source: "framework", rel: "bin/python3" },
    { dir: path.join(home, "miniconda3/envs"), source: "conda", rel: "bin/python3" },
    { dir: path.join(home, "anaconda3/envs"), source: "conda", rel: "bin/python3" },
  ];
  for (const spec of l2) {
    for (const name of subdirs(spec.dir)) {
      if (name === "Current") continue;      // Framework 下的 Current 是指向别的版本的符号链接
      const binPath = path.join(spec.dir, name, spec.rel);
      if (!existsSync(binPath)) continue;
      const bin = real(binPath);
      if (raw.some((i) => i.bin === bin)) continue;
      const out = await p.out(`${name} 的版本`, binPath, ["-V"]);
      const version = parseVersion(out);
      if (!version) continue;
      raw.push({
        id: installId("python", bin), kind: "python", version, raw: (out.split("\n")[0] || "").trim(),
        home: path.join(spec.dir, name), bin, vendor: "", arch: "", source: spec.source, managed: false,
      });
    }
  }

  // ── L3：PATH 上所有的 python3。这一层是发现「多个 python3 打架」的唯一手段。
  const python3Paths = whichAll("python3", pathDirs.join(":"));
  for (const hit of python3Paths) {
    const bin = real(hit);
    if (raw.some((i) => i.bin === bin)) continue;
    const out = await p.out(`${hit} 的版本`, hit, ["-V"]);
    const version = parseVersion(out);
    if (!version) continue;
    const src = pythonSource(bin, uvDir, pyenvRoot);
    raw.push({
      id: installId("python", bin), kind: "python", version, raw: (out.split("\n")[0] || "").trim(),
      home: path.dirname(path.dirname(bin)), bin, vendor: "", arch: "", source: src.source, managed: src.managed,
    });
  }

  const installs = sortInstalls(dedupeInstalls(raw));

  // ── 「当前生效」
  const actives: Active[] = [];
  const activeHit = python3Paths[0] || "";
  const activePath = activeHit ? real(activeHit) : "";
  if (activeHit) {
    const hit = installs.find((i) => i.bin === activePath);
    // pyenv 生效时 PATH 上第一个是 shim，真正的版本由 pyenv 的 setBy 决定 —— 那句话比 PATH 更有信息量。
    const viaShim = activeHit.includes("/shims/");
    actives.push({
      who: "终端里的 python3",
      installId: hit?.id || (viaShim && pyenvCurrent ? installs.find((i) => i.version === normalizeVersion(pyenvCurrent))?.id || "" : ""),
      path: activeHit,
      reason: viaShim && pyenvSetBy ? `pyenv shim → ${explainSetBy(pyenvSetBy)}` : "PATH 第一个匹配",
    });
  }

  // ── .python-version：从当前用户主目录往上找不到意义，从 cwd 往上找才对齐 pyenv 的行为
  let versionFile = "";
  let versionFileWants = "";
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    const f = path.join(dir, ".python-version");
    if (existsSync(f)) {
      versionFile = f;
      try { versionFileWants = (readFileSync(f, "utf-8").split("\n")[0] || "").trim(); } catch { /* 读不了就当没有 */ }
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }

  // ── pip3 和 python3 是不是同一套（P5）
  // 直接比两个 pip 的 from 路径，不比 sys.prefix —— Debian 系用 dist-packages 而不是
  // site-packages，按前缀比会在每台 Ubuntu 上误报（实测过，见 parsePipFrom 的注释）。
  let pipFromSelf = "";
  let pipFromCmd = "";
  if (activeHit) {
    pipFromSelf = parsePipFrom(await p.out("python3 -m pip", activeHit, ["-m", "pip", "-V"]));
    const pip = whichAll("pip3", pathDirs.join(":"))[0];
    if (pip) pipFromCmd = parsePipFrom(await p.out("pip3 的归属", pip, ["-V"]));
  }

  const shimsDir = path.join(pyenvRoot, "shims");
  const issues = diagnosePython({
    installs, python3Paths,
    // 去符号链接后还剩几个真身：Debian 的 /bin 是 /usr/bin 的链接，
    // 光数路径会把一个 python 数成两个（实测误报过）。
    python3Distinct: new Set(python3Paths.map(real)).size,
    activePath, pyenvDir,
    pyenvShimsOnPath: pathDirs.includes(shimsDir),
    versionFile, versionFileWants, pyenvVersions, pipFromSelf, pipFromCmd,
  });
  return { installs, actives, issues, managers };
}

// ── 对外入口 ──────────────────────────────────────────────────────────────────

/** 每个语言相关的别名前缀（全量别名动辄上百条，只留有关的）。 */
const ALIAS_KEYS: Record<RuntimeKind, string[]> = {
  java: ["java", "javac", "mvn", "gradle", "jenv", "sdk"],
  python: ["python", "py", "pip", "pyenv", "uv", "conda", "venv", "activate"],
};

/**
 * 扫一个运行时。**每个语言独立调用**（UI 上一个语言一张卡、各自一个刷新按钮）——
 * Java 扫得快、Python 慢得多，让快的等慢的没有道理。
 */
export async function scanRuntime(kind: RuntimeKind): Promise<RuntimeScan> {
  const t0 = Date.now();
  const p = new Probe();
  const ownDirs = splitPath(process.env.PATH || "");

  const shell = await readShellEnv(ALIAS_KEYS[kind]);
  if (shell.err) p.partial.push(shell.err);
  // 探测用的 PATH 取两者的并集（Umbra 自己的在前）：只用 Umbra 的会漏掉终端里才有的版本，
  // 只用 shell 的又会漏掉 fixPath 补的兜底目录。差异本身由 E1 报给用户。
  const probeDirs = [...new Set([...ownDirs, ...shell.pathDirs])];

  const r = kind === "java" ? await scanJava(p, probeDirs) : await scanPython(p, probeDirs);
  const env = diagnoseEnv({ ownDirs, shellDirs: shell.pathDirs, partial: p.partial });

  return {
    kind,
    installs: r.installs,
    actives: r.actives,
    issues: sortIssues([...r.issues, ...env]),
    managers: r.managers,
    aliases: shell.aliases,
    // 三个都回：并集是「探测用了哪些目录」，另两个是界面要分开展示的两份原始清单。
    // 以前只回并集，结果「Umbra 看到的」和「终端里有的」在界面上根本分不开 ——
    // 而这两者的差异恰恰是运行时问题里最常见的那一类。
    pathDirs: probeDirs,
    appPathDirs: ownDirs,
    shellPathDirs: shell.pathDirs,
    scannedAt: Date.now(),
    elapsedMs: Date.now() - t0,
    partial: p.partial,
  };
}
