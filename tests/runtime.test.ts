// 运行时探测的解析层与诊断层。
//
// 为什么这两层值得测、而 scan.ts 不测：探测本身全是 IO（跑 java_home、扫目录、读 realpath），
// 在 Linux CI 上根本没有 /Library/Java 和 ~/.pyenv；而真正容易错的恰恰是**解析** ——
// 各家命令的输出格式五花八门（Java 走 stderr、版本号在引号里、行尾还带发布日期），
// 且会随版本变。这里全用**真实样本**钉住。
//
// 诊断层同样是纯函数，每条规则用构造出来的场景钉住：诊断最怕「改了一条，另一条静悄悄失效」。
import { describe, expect, it } from "vitest";
import {
  cmpVersion, dedupeInstalls, dupDirs, explainSetBy, installId, normalizeVersion,
  parseAliases, parseJavaHomeList, parsePyenvCurrent, parsePyenvVersions, parseUvPythonList,
  numericVersion, parsePipFrom, parseVersion, pathDiff, pythonSource, shortVendor,
  sortInstalls, splitPath, type Install,
} from "../electron/core/runtime/parse";
import { diagnoseEnv, diagnoseJava, diagnosePython, sortIssues } from "../electron/core/runtime/diagnose";

// ── 版本号 ────────────────────────────────────────────────────────────────────

describe("parseVersion", () => {
  // 最容易栽的一条：`openjdk version "21.0.5" 2024-10-15` 行尾有个发布日期。
  // 不先看引号就会把 2024 当版本号 —— 而且它「看起来像个版本号」，肉眼审查也容易放过。
  it("Java 的版本在引号里，行尾的发布日期不能被当成版本", () => {
    expect(parseVersion('openjdk version "21.0.5" 2024-10-15')).toBe("21.0.5");
    expect(parseVersion('openjdk version "17.0.9" 2023-10-17\nOpenJDK Runtime Environment')).toBe("17.0.9");
  });

  it("Java 8 的 1.8.0_432 归一成 8（用户认的是「Java 8」）", () => {
    expect(parseVersion('java version "1.8.0_432"')).toBe("8");
    expect(normalizeVersion("1.8.0")).toBe("8");
    expect(normalizeVersion("1.8.0_432")).toBe("1.8.0_432");  // 带下划线的整串不动，交给 raw
  });

  it("Python 的版本在空格后", () => {
    expect(parseVersion("Python 3.12.4")).toBe("3.12.4");
    expect(parseVersion("Python 3.13.0rc1")).toBe("3.13.0");
    expect(parseVersion("Python 2.7.18")).toBe("2.7.18");
  });

  it("跳过前导空行，只看第一条非空行", () => {
    expect(parseVersion("\n\n  Python 3.11.9  \nPython 2.7")).toBe("3.11.9");
  });

  // 探测不到时必须返回空串。伪造一个 0.0.0 会让 UI 显示一个不存在的版本，
  // 比少一条更糟 —— 用户会去找那个版本装在哪。
  it("认不出就给空串，绝不伪造版本号", () => {
    expect(parseVersion("")).toBe("");
    expect(parseVersion("command not found: java")).toBe("");
  });
});

describe("cmpVersion", () => {
  it("按段比大小，段数不同时缺的段当 0", () => {
    expect(cmpVersion("21.0.5", "17.0.9")).toBeGreaterThan(0);
    expect(cmpVersion("3.12.4", "3.12.10")).toBeLessThan(0);   // 不能按字符串比，否则 4 > 10
    expect(cmpVersion("21", "21.0.0")).toBe(0);
    expect(cmpVersion("8", "21")).toBeLessThan(0);
  });
  it("非数字段当 0，不抛", () => {
    expect(() => cmpVersion("abc", "3.1")).not.toThrow();
    expect(cmpVersion("3.1", "abc")).toBeGreaterThan(0);
  });
});

describe("installId", () => {
  it("同一路径恒定、不同路径不同 —— 刷新后 UI 展开态才不跳", () => {
    const a = installId("java", "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java");
    expect(installId("java", "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java")).toBe(a);
    expect(installId("java", "/opt/homebrew/bin/java")).not.toBe(a);
    expect(installId("python", "/opt/homebrew/bin/java")).not.toBe(installId("java", "/opt/homebrew/bin/java"));
  });
});

// ── Java：java_home -V ────────────────────────────────────────────────────────

// 真实样本（苹果官方格式，注意它走 stderr，最后一行是「默认 JDK」不是列表项）
const JAVA_HOME_V = `Matching Java Virtual Machines (3):
    21.0.5 (arm64) "Eclipse Adoptium" - "OpenJDK 21.0.5" /Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home
    17.0.9 (arm64) "Azul Systems, Inc." - "Zulu 17.46.19" /Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home
    1.8.0_432 (x86_64) "Oracle Corporation" - "Java SE 8" /Library/Java/JavaVirtualMachines/jdk1.8.0_432.jdk/Contents/Home
/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home`;

describe("parseJavaHomeList", () => {
  const rows = parseJavaHomeList(JAVA_HOME_V);

  it("三个 JDK 都认出来了", () => {
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.version)).toEqual(["21.0.5", "17.0.9", "8"]);
  });

  // 这一条是重点：最后一行是「默认 JDK 的路径」，格式上和列表项完全不同（没有版本号和括号）。
  // 靠缩进区分是不可靠的（不同系统版本缩进对不齐），所以靠「有版本号 + 有括号架构」来认。
  it("末尾那行「默认 JDK 路径」不能被当成一个 JDK", () => {
    expect(rows.every((r) => r.arch.length > 0)).toBe(true);
    expect(rows.some((r) => r.home === r.version)).toBe(false);
  });

  it("架构、厂商、路径都取对了", () => {
    expect(rows[0].arch).toBe("arm64");
    expect(rows[2].arch).toBe("x86_64");
    expect(rows[0].home).toBe("/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home");
    expect(rows[0].vendor).toBe("Eclipse Adoptium");
  });

  it("空输入 / 没装 Java 时返回空数组", () => {
    expect(parseJavaHomeList("")).toEqual([]);
    expect(parseJavaHomeList("Unable to find any JVMs matching version \"(null)\".")).toEqual([]);
  });
});

describe("shortVendor", () => {
  it.each([
    ["Eclipse Adoptium", "OpenJDK 21.0.5", "Temurin"],
    ["Azul Systems, Inc.", "Zulu 17.46.19", "Zulu"],
    ["Oracle Corporation", "Java SE 8", "Oracle"],
    ["Amazon.com Inc.", "Corretto-17", "Corretto"],
    ["Homebrew", "OpenJDK 23", "OpenJDK"],
    ["GraalVM Community", "GraalVM CE 21", "GraalVM"],
  ])("%s → %s", (vendor, name, want) => {
    expect(shortVendor(vendor, name)).toBe(want);
  });

  it("认不出的厂商截断而不是丢掉 —— 列表里宁可显示个怪名字也别显示空白", () => {
    expect(shortVendor("Some Very Long Unknown Vendor Name Inc.")).toBe("Some Very Long");
  });
});

// ── Python：pyenv ─────────────────────────────────────────────────────────────

const PYENV_VERSIONS = `  system
  3.11.9
* 3.12.4 (set by /Users/sam/proj/.python-version)
  3.13.1
  miniforge3-24.3.0`;

describe("parsePyenvVersions", () => {
  const rows = parsePyenvVersions(PYENV_VERSIONS);

  it("全部版本 + 星号标当前", () => {
    expect(rows.map((r) => r.name)).toEqual(["system", "3.11.9", "3.12.4", "3.13.1", "miniforge3-24.3.0"]);
    expect(rows.filter((r) => r.active).map((r) => r.name)).toEqual(["3.12.4"]);
  });

  // system 是 pyenv 的合法版本名（表示「用系统那个」），过滤掉会让用户看不懂
  // 「为什么 pyenv versions 里有 system，Umbra 里没有」。
  it("system 也是一个合法版本名，不能过滤掉", () => {
    expect(rows.some((r) => r.name === "system")).toBe(true);
  });

  it("带走「谁定的」", () => {
    expect(rows.find((r) => r.active)?.setBy).toBe("/Users/sam/proj/.python-version");
  });
});

describe("parsePyenvCurrent", () => {
  it("拿到版本和「谁定的」—— 这是整个功能最值钱的一句信息", () => {
    expect(parsePyenvCurrent("3.12.4 (set by /Users/sam/proj/.python-version)"))
      .toEqual({ version: "3.12.4", setBy: "/Users/sam/proj/.python-version" });
    expect(parsePyenvCurrent("3.11.9 (set by PYENV_VERSION environment variable)"))
      .toEqual({ version: "3.11.9", setBy: "PYENV_VERSION environment variable" });
  });
  it("没有 set by 时也不崩", () => {
    expect(parsePyenvCurrent("3.12.4")).toEqual({ version: "3.12.4", setBy: "" });
    expect(parsePyenvCurrent("")).toEqual({ version: "", setBy: "" });
  });
});

describe("explainSetBy", () => {
  it("英文原文翻成中文（直接摆给小白看不友好）", () => {
    expect(explainSetBy("PYENV_VERSION environment variable")).toBe("环境变量 PYENV_VERSION");
    expect(explainSetBy("/Users/sam/proj/.python-version")).toBe("版本文件 /Users/sam/proj/.python-version");
    expect(explainSetBy("/Users/sam/.pyenv/version")).toBe("全局默认（/Users/sam/.pyenv/version）");
    expect(explainSetBy("")).toBe("");
  });
});

// ── Python：uv ────────────────────────────────────────────────────────────────

const UV_LIST = `cpython-3.13.1-macos-aarch64-none     /Users/sam/.local/share/uv/python/cpython-3.13.1-macos-aarch64-none/bin/python3
cpython-3.12.8-macos-aarch64-none     <download available>
cpython-3.11.11-macos-aarch64-none    /Users/sam/.local/share/uv/python/cpython-3.11.11-macos-aarch64-none/bin/python3
pypy-3.10.14-macos-aarch64-none       <download available>`;

describe("parseUvPythonList", () => {
  const rows = parseUvPythonList(UV_LIST);
  it("只要已装的（路径以 / 开头），<download available> 的要跳过", () => {
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.version)).toEqual(["3.13.1", "3.11.11"]);
  });
  it("路径取对了", () => {
    expect(rows[0].path).toBe("/Users/sam/.local/share/uv/python/cpython-3.13.1-macos-aarch64-none/bin/python3");
  });
  it("空输入不崩", () => {
    expect(parseUvPythonList("")).toEqual([]);
  });
});

// ── 别名 ─────────────────────────────────────────────────────────────────────

const ALIAS_OUT = `ll='ls -lah'
python='/usr/bin/python3'
pip='pip3'
gs='git status'
pyenv-which='pyenv which'
brewup='brew update && brew upgrade'
uv='uv --native-tls'
py='python3 -q'`;

describe("parseAliases", () => {
  const hit = parseAliases(ALIAS_OUT, ["python", "pip", "pyenv", "uv", "py"]);

  it("只留和本语言相关的（全量别名动辄上百条，摆出来是噪音）", () => {
    expect(Object.keys(hit).sort()).toEqual(["pip", "py", "pyenv-which", "python", "uv"]);
    expect(hit.ll).toBeUndefined();
    expect(hit.gs).toBeUndefined();
    expect(hit.brewup).toBeUndefined();
  });

  it("去掉最外层引号", () => {
    expect(hit.python).toBe("/usr/bin/python3");
    expect(hit.uv).toBe("uv --native-tls");
  });

  it("值里带单引号的能还原（shell 的 '\\'' 写法）", () => {
    expect(parseAliases(`x='it'\\''s'`, ["x"]).x).toBe("it's");
  });

  it("空输入 / 没有别名时返回空对象", () => {
    expect(parseAliases("", ["python"])).toEqual({});
  });
});

// ── PATH ─────────────────────────────────────────────────────────────────────

describe("PATH 处理", () => {
  it("拆分时丢掉空段，但**保留重复**（重复本身是要诊断的病）", () => {
    expect(splitPath("/a::/b:/a:")).toEqual(["/a", "/b", "/a"]);
    expect(splitPath("")).toEqual([]);
  });
  it("dupDirs 每个重复目录只报一次", () => {
    expect(dupDirs(["/a", "/b", "/a", "/c", "/a"])).toEqual(["/a"]);
    expect(dupDirs(["/a", "/b"])).toEqual([]);
  });
  it("pathDiff 给出「只在 a 里」的目录且去重", () => {
    expect(pathDiff(["/x", "/y", "/x"], ["/y"])).toEqual(["/x"]);
    expect(pathDiff(["/y"], ["/y"])).toEqual([]);
  });
});

// ── 去重与排序 ────────────────────────────────────────────────────────────────

const mk = (over: Partial<Install>): Install => ({
  id: "i", kind: "python", version: "3.12.0", raw: "", home: "/h", bin: "/h/bin/python3",
  vendor: "", arch: "", source: "path", managed: false, ...over,
});

describe("dedupeInstalls", () => {
  // 顺序即优先级：调用方先塞 L1（管理器给的，知道「谁定的」），最后塞 L3（扫 PATH 兜底）。
  // 如果保留后出现的那条，pyenv 提供的 managed=true 就会被 PATH 层的 managed=false 冲掉。
  it("同一个 realpath 只留**先出现**的那条（高层信息更全）", () => {
    const out = dedupeInstalls([
      mk({ bin: "/p/bin/python3", source: "pyenv", managed: true }),
      mk({ bin: "/p/bin/python3", source: "path", managed: false }),
      mk({ bin: "/other/bin/python3", source: "path" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].source).toBe("pyenv");
    expect(out[0].managed).toBe(true);
  });

  it("bin 和 home 都空的条目直接丢掉（不该出现，但别让它污染列表）", () => {
    expect(dedupeInstalls([mk({ bin: "", home: "" })])).toHaveLength(0);
  });
});

describe("sortInstalls", () => {
  it("版本降序；版本相同时按来源名排，顺序稳定不抖", () => {
    const out = sortInstalls([
      mk({ version: "3.11.9", bin: "/a", source: "pyenv" }),
      mk({ version: "3.13.1", bin: "/b", source: "uv" }),
      mk({ version: "3.11.9", bin: "/c", source: "homebrew" }),
    ]);
    expect(out.map((i) => `${i.version}/${i.source}`)).toEqual(["3.13.1/uv", "3.11.9/homebrew", "3.11.9/pyenv"]);
  });
});

// ── 诊断：Java ────────────────────────────────────────────────────────────────

const jdk = (version: string, arch = "arm64"): Install => ({
  id: `j-${version}`, kind: "java", version, raw: "", home: `/L/${version}`, bin: `/L/${version}/bin/java`,
  vendor: "Temurin", arch, source: "jvm-dir", managed: false,
});

describe("diagnoseJava", () => {
  const base = { installs: [jdk("21.0.5")], javaHome: "/L/21.0.5", javaHomeExists: true, javaHomeVersion: "21.0.5", cliVersion: "21.0.5" };

  it("一切正常时不报任何问题", () => {
    expect(diagnoseJava(base)).toEqual([]);
  });

  it("J5 一个 JDK 都没有 —— 且后面几条不再报（无从谈起）", () => {
    const out = diagnoseJava({ ...base, installs: [], javaHome: "" });
    expect(out.map((i) => i.code)).toEqual(["J5"]);
  });

  it("J1 JAVA_HOME 未设置：命令行正常、一构建就挂，所以是 warn 不是 error", () => {
    const out = diagnoseJava({ ...base, javaHome: "", javaHomeExists: false, javaHomeVersion: "" });
    expect(out.map((i) => i.code)).toEqual(["J1"]);
    expect(out[0].level).toBe("warn");
    expect(out[0].fix).toContain("java_home");
  });

  it("J2 JAVA_HOME 指向不存在的目录 → error（所有构建工具必挂）", () => {
    const out = diagnoseJava({ ...base, javaHome: "/gone", javaHomeExists: false, javaHomeVersion: "" });
    expect(out.map((i) => i.code)).toEqual(["J2"]);
    expect(out[0].level).toBe("error");
    expect(out[0].detail).toContain("/gone");
  });

  // macOS 的经典坑：/usr/bin/java 不看 JAVA_HOME，Maven 只认 JAVA_HOME。
  it("J3 命令行与 JAVA_HOME 版本不一致，且 fix 给的是主版本号", () => {
    const out = diagnoseJava({ ...base, installs: [jdk("21.0.5"), jdk("17.0.9")], javaHomeVersion: "17.0.9", cliVersion: "21.0.5" });
    expect(out.map((i) => i.code)).toEqual(["J3"]);
    expect(out[0].fix).toBe("export JAVA_HOME=$(/usr/libexec/java_home -v 21)");
  });

  // J1/J2/J3 是同一件事的三种状态，必须互斥 —— 同时报两条会让用户不知道先修哪个。
  it("J1 / J2 / J3 三者互斥", () => {
    for (const f of [
      { ...base, javaHome: "", javaHomeExists: false },
      { ...base, javaHome: "/gone", javaHomeExists: false },
      { ...base, javaHomeVersion: "17.0.9" },
    ]) {
      const codes = diagnoseJava(f).filter((i) => ["J1", "J2", "J3"].includes(i.code));
      expect(codes).toHaveLength(1);
    }
  });

  it("J3 在版本一致时不报（21 与 21.0.0 视为同一个）", () => {
    const out = diagnoseJava({ ...base, javaHomeVersion: "21.0.5", cliVersion: "21.0.5" });
    expect(out.map((i) => i.code)).not.toContain("J3");
  });

  it("J4 同时装了 arm64 与 x86_64 → info，并列出 Intel 的那些版本", () => {
    const out = diagnoseJava({ ...base, installs: [jdk("21.0.5", "arm64"), jdk("8", "x86_64")] });
    const j4 = out.find((i) => i.code === "J4");
    expect(j4?.level).toBe("info");
    expect(j4?.detail).toContain("8");
  });

  it("J4 只有一种架构时不报", () => {
    expect(diagnoseJava({ ...base, installs: [jdk("21.0.5", "arm64"), jdk("17.0.9", "arm64")] })
      .some((i) => i.code === "J4")).toBe(false);
  });
});

// ── 诊断：Python ──────────────────────────────────────────────────────────────

describe("diagnosePython", () => {
  const base = {
    installs: [mk({ version: "3.12.4", bin: "/opt/homebrew/bin/python3" })],
    python3Paths: ["/opt/homebrew/bin/python3"],
    python3Distinct: 1,
    activePath: "/opt/homebrew/bin/python3",
    pyenvDir: false, pyenvShimsOnPath: false,
    versionFile: "", versionFileWants: "", pyenvVersions: [],
    pipFromSelf: "/opt/homebrew/lib/python3.12/site-packages/pip",
    pipFromCmd: "/opt/homebrew/lib/python3.12/site-packages/pip",
  };

  it("一切正常时不报任何问题", () => {
    expect(diagnosePython(base)).toEqual([]);
  });

  it("P1 多个 python3：要列出全部并标出哪个生效", () => {
    const out = diagnosePython({
      ...base,
      python3Paths: ["/opt/homebrew/bin/python3", "/usr/bin/python3", "/x/python3"],
      python3Distinct: 3,
    });
    const p1 = out.find((i) => i.code === "P1");
    expect(p1?.title).toContain("3 个");
    expect(p1?.detail).toContain("← 生效的是这个");
    // 「生效的是这个」只能出现一次，否则用户不知道到底哪个算
    expect(p1!.detail.match(/← 生效的是这个/g)).toHaveLength(1);
  });

  it("P1 只有一个时不报", () => {
    expect(diagnosePython(base).some((i) => i.code === "P1")).toBe(false);
  });

  // 这条是为第三个**实测到的误报**加的回归测试：Debian 系的 /bin 是 /usr/bin 的符号链接，
  // whichAll 会同时返回 /usr/bin/python3 和 /bin/python3 —— 但它们是同一个文件。
  // 按路径条数判定就会报「有 2 个 python3 在抢」，而实际上一个都没在抢。
  it("P1 两条路径指向同一个文件时不报（符号链接不算独立的一份）", () => {
    expect(diagnosePython({
      ...base,
      python3Paths: ["/usr/bin/python3", "/bin/python3"],
      python3Distinct: 1,
    }).some((i) => i.code === "P1")).toBe(false);
  });

  it("P1 有真身也有链接时，标题按真身数、并说明有几个是链接", () => {
    const p1 = diagnosePython({
      ...base,
      python3Paths: ["/usr/bin/python3", "/bin/python3", "/opt/homebrew/bin/python3"],
      python3Distinct: 2,
    }).find((i) => i.code === "P1");
    expect(p1?.title).toContain("2 个");
    expect(p1?.detail).toContain("1 个是指向上面某一个的符号链接");
    // 三条路径都要列出来 —— 用户在终端 which -a 看到的就是三条
    for (const p of ["/usr/bin/python3", "/bin/python3", "/opt/homebrew/bin/python3"]) {
      expect(p1?.detail).toContain(p);
    }
  });

  // 这条是最有价值的诊断之一：用户以为在用 pyenv，实际一直用系统的，而且完全没有征兆。
  it("P2 装了 pyenv 但 shims 不在 PATH → error", () => {
    const out = diagnosePython({ ...base, pyenvDir: true, pyenvShimsOnPath: false });
    const p2 = out.find((i) => i.code === "P2");
    expect(p2?.level).toBe("error");
    expect(p2?.fix).toContain("pyenv init");
  });

  it("P2 shims 在 PATH 上时不报", () => {
    expect(diagnosePython({ ...base, pyenvDir: true, pyenvShimsOnPath: true })
      .some((i) => i.code === "P2")).toBe(false);
  });

  it("P3 生效的是系统 python3 → warn", () => {
    const out = diagnosePython({ ...base, activePath: "/usr/bin/python3", python3Paths: ["/usr/bin/python3"] });
    expect(out.find((i) => i.code === "P3")?.level).toBe("warn");
  });

  it("P3 只认 /usr/bin/python3 这个确切路径，Homebrew 的不能误报", () => {
    expect(diagnosePython(base).some((i) => i.code === "P3")).toBe(false);
    expect(diagnosePython({ ...base, activePath: "/usr/local/bin/python3" }).some((i) => i.code === "P3")).toBe(false);
  });

  it("P4 版本文件要一个没装的版本 → error", () => {
    const out = diagnosePython({
      ...base, versionFile: "/p/.python-version", versionFileWants: "3.10.0", pyenvVersions: ["3.12.4"],
    });
    const p4 = out.find((i) => i.code === "P4");
    expect(p4?.level).toBe("error");
    expect(p4?.fix).toBe("pyenv install 3.10.0");
  });

  it("P4 版本文件要的版本装了就不报", () => {
    expect(diagnosePython({
      ...base, versionFile: "/p/.python-version", versionFileWants: "3.12.4", pyenvVersions: ["3.12.4"],
    }).some((i) => i.code === "P4")).toBe(false);
  });

  it("P5 两个 pip 的 from 路径不同 → warn，且推荐 python3 -m pip", () => {
    const out = diagnosePython({
      ...base,
      pipFromSelf: "/opt/homebrew/lib/python3.12/site-packages/pip",
      pipFromCmd: "/usr/lib/python3/dist-packages/pip",
    });
    const p5 = out.find((i) => i.code === "P5");
    expect(p5?.level).toBe("warn");
    expect(p5?.fix).toContain("-m pip");
  });

  // 这条是为一个**实测到的误报**加的回归测试。
  // 原来的判定是「python3 的 sys.prefix」对比「pip 路径去掉 site-packages 后缀」，
  // 而 Debian/Ubuntu 用的是 **dist-packages** —— 后缀剥不掉，前缀永远不相等，
  // 于是每台 Debian 系机器都会莫名多一条 P5。在容器里跑真实 python3 时抓到的。
  it("P5 Debian 的 dist-packages 不能误报（两边其实是同一个 pip）", () => {
    const same = "/usr/lib/python3/dist-packages/pip";
    expect(diagnosePython({ ...base, pipFromSelf: same, pipFromCmd: same })
      .some((i) => i.code === "P5")).toBe(false);
  });

  it("P5 有一边探测失败时不报（不能拿空串去比）", () => {
    expect(diagnosePython({ ...base, pipFromSelf: "", pipFromCmd: "/usr/x/pip" }).some((i) => i.code === "P5")).toBe(false);
    expect(diagnosePython({ ...base, pipFromCmd: "" }).some((i) => i.code === "P5")).toBe(false);
  });
});

// ── 诊断：通用环境 ────────────────────────────────────────────────────────────

describe("diagnoseEnv", () => {
  it("E1 只在「登录 shell 有、Umbra 没有」时报，反向不报", () => {
    const out = diagnoseEnv({ ownDirs: ["/a"], shellDirs: ["/a", "/b"], partial: [] });
    expect(out.find((i) => i.code === "E1")?.detail).toContain("/b");
    // Umbra 自己多补的兜底目录（fixPath 干的）不是病，不该报
    expect(diagnoseEnv({ ownDirs: ["/a", "/x"], shellDirs: ["/a"], partial: [] })
      .some((i) => i.code === "E1")).toBe(false);
  });

  it("E1 拿不到登录 shell 的 PATH 时不报（空数组不是「差异很大」）", () => {
    expect(diagnoseEnv({ ownDirs: ["/a", "/b"], shellDirs: [], partial: [] })
      .some((i) => i.code === "E1")).toBe(false);
  });

  it("E2 PATH 有重复目录", () => {
    expect(diagnoseEnv({ ownDirs: ["/a", "/b", "/a"], shellDirs: [], partial: [] })
      .find((i) => i.code === "E2")?.detail).toContain("/a");
  });

  // partial 必须被报出来。静默少一条会让用户看到一份「看起来完整其实缺东西」的清单，
  // 那比报错更坏 —— 他会照着这份不全的清单去排查。
  it("E3 探测失败必须报出来，并带上失败原因", () => {
    const out = diagnoseEnv({ ownDirs: ["/a"], shellDirs: [], partial: ["pyenv versions：超时（2500ms）"] });
    const e3 = out.find((i) => i.code === "E3");
    expect(e3?.level).toBe("warn");
    expect(e3?.title).toContain("1 项");
    expect(e3?.detail).toContain("超时");
  });

  it("一切正常时一条都不报", () => {
    expect(diagnoseEnv({ ownDirs: ["/a", "/b"], shellDirs: ["/a", "/b"], partial: [] })).toEqual([]);
  });
});

describe("sortIssues", () => {
  it("坏的排最上面（error → warn → info），同级按 code 稳定排序", () => {
    const out = sortIssues([
      { code: "E1", level: "info", title: "", detail: "", fix: "" },
      { code: "P2", level: "error", title: "", detail: "", fix: "" },
      { code: "J1", level: "warn", title: "", detail: "", fix: "" },
      { code: "E2", level: "info", title: "", detail: "", fix: "" },
    ]);
    expect(out.map((i) => i.code)).toEqual(["P2", "J1", "E1", "E2"]);
  });
});

// ── numericVersion：两条探测路径必须给出同一个答案 ────────────────────────────
//
// 这条测试是为一个真实缺陷加的：java_home -V 的版本 token 是 `1.8.0_432`，
// 而 java -version 的输出是 `java version "1.8.0_432"`。前者一开始直接调 normalizeVersion
// （匹配不上带后缀的形式，原样返回 1.8.0_432），后者先被 VER 抠成 1.8.0 再归一成 8 ——
// 同一个 JDK 在两条路径下显示成两个样子，而且哪条生效取决于它先被哪一层探测到。
describe("numericVersion", () => {
  it("两条探测路径对同一个 JDK 给出同一个版本号", () => {
    expect(numericVersion("1.8.0_432")).toBe(parseVersion('java version "1.8.0_432"'));
    expect(numericVersion("1.8.0_432")).toBe("8");
    expect(numericVersion("21.0.5")).toBe(parseVersion('openjdk version "21.0.5" 2024-10-15'));
  });

  it("抠不出数字就给空串", () => {
    expect(numericVersion("")).toBe("");
    expect(numericVersion("unknown")).toBe("");
  });
});

// ── parsePipFrom ─────────────────────────────────────────────────────────────

describe("parsePipFrom", () => {
  it.each([
    ["pip 24.0 from /usr/lib/python3/dist-packages/pip (python 3.11)", "/usr/lib/python3/dist-packages/pip"],
    ["pip 24.2 from /opt/homebrew/lib/python3.12/site-packages/pip (python 3.12)", "/opt/homebrew/lib/python3.12/site-packages/pip"],
    ["pip 23.3.1 from /Users/sam/.pyenv/versions/3.11.9/lib/python3.11/site-packages/pip (python 3.11)", "/Users/sam/.pyenv/versions/3.11.9/lib/python3.11/site-packages/pip"],
  ])("%s", (out, want) => {
    expect(parsePipFrom(out)).toBe(want);
  });

  it("路径里带空格也要能取出来（贪婪到 ' (python ' 为止）", () => {
    expect(parsePipFrom("pip 24.0 from /Users/sam/My Env/lib/pip (python 3.12)")).toBe("/Users/sam/My Env/lib/pip");
  });

  it("取不到给空串（调用方据此沉默，不能拿空串去比）", () => {
    expect(parsePipFrom("")).toBe("");
    expect(parsePipFrom("command not found: pip3")).toBe("");
  });
});

// ── pythonSource ─────────────────────────────────────────────────────────────
//
// 这一组是为另一个**实测到的错误归因**加的：`uv python list` 会把**系统自带**的 Python
// 也列出来（容器里它报了 /usr/bin/python3.11~3.13）。照单全收就会把系统的 Python 标成
// 「uv 装的、由 uv 管着」，用户会以为能用 uv 去切它们。所以来源必须按**路径**判定，
// 而不是「谁列出来的就算谁的」。
describe("pythonSource", () => {
  const UV = "/Users/sam/.local/share/uv/python";
  const PYENV = "/Users/sam/.pyenv";

  it("uv 自己目录下的才算 uv 装的", () => {
    expect(pythonSource(`${UV}/cpython-3.13.1-macos-aarch64-none/bin/python3`, UV, PYENV))
      .toEqual({ source: "uv", managed: true });
  });

  it("uv 报出来的系统 Python 必须归到「系统自带」，且 managed=false", () => {
    expect(pythonSource("/usr/bin/python3.13", UV, PYENV)).toEqual({ source: "system", managed: false });
    expect(pythonSource("/bin/python3.11", UV, PYENV)).toEqual({ source: "system", managed: false });
  });

  it.each([
    [`${PYENV}/versions/3.12.4/bin/python3`, "pyenv", true],
    ["/Library/Frameworks/Python.framework/Versions/3.12/bin/python3", "framework", false],
    ["/opt/homebrew/bin/python3", "homebrew", false],
    ["/usr/local/Cellar/python@3.12/3.12.4/bin/python3", "homebrew", false],
    ["/Users/sam/miniconda3/envs/ml/bin/python3", "conda", false],
    ["/Users/sam/miniforge3/envs/ml/bin/python3", "conda", false],
    ["/Users/sam/custom/bin/python3", "path", false],
  ])("%s → %s (managed=%s)", (bin, source, managed) => {
    expect(pythonSource(bin, UV, PYENV)).toEqual({ source, managed });
  });

  // managed 决定 UI 上敢不敢显示「可以切换」（二期）。标错会让用户点了没反应。
  it("只有被管理器真正管着的才 managed=true", () => {
    const managed = [
      `${UV}/x/bin/python3`, `${PYENV}/versions/3.12.4/bin/python3`,
    ].map((b) => pythonSource(b, UV, PYENV).managed);
    const unmanaged = [
      "/usr/bin/python3", "/opt/homebrew/bin/python3",
      "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
    ].map((b) => pythonSource(b, UV, PYENV).managed);
    expect(managed).toEqual([true, true]);
    expect(unmanaged).toEqual([false, false, false]);
  });
});
