// 环境诊断：把探测结果里「不对的地方」翻成人话 + 一条能复制的命令。
//
// 纯函数，输入是已经探测好的事实，输出是 Issue[]。这样每条规则都能用构造出来的
// 场景钉住（见 tests/runtime.test.ts）——诊断规则最怕的就是「改了一条，另一条静悄悄失效」。
//
// 铁律：**只诊断，不修。** fix 字段是给用户自己去终端执行的，Umbra 不代跑。
// 理由见 doc/运行时环境-设计与待办.md §2：写坏用户的 shell 配置，他的终端会当场不能用，
// 而他不会怀疑是 Umbra 干的。
import type { Install, Issue } from "./parse";
import { cmpVersion, dupDirs, pathDiff } from "./parse";

/** Java 诊断的输入。全部是「已经查到的事实」，这一层不再做 IO。 */
export interface JavaFacts {
  installs: Install[];
  /** JAVA_HOME 环境变量的原始值，未设置为空串 */
  javaHome: string;
  /** JAVA_HOME 指向的目录是否真的存在 */
  javaHomeExists: boolean;
  /** JAVA_HOME 对应的版本（匹配不到已装列表则为空串） */
  javaHomeVersion: string;
  /** 终端里 `java` 实际会跑的版本 */
  cliVersion: string;
}

export function diagnoseJava(f: JavaFacts): Issue[] {
  const out: Issue[] = [];

  if (!f.installs.length) {
    out.push({
      code: "J5", level: "info",
      title: "没有检测到任何 JDK",
      detail: "这台机器上没装 Java。要装的话推荐 Temurin（免费、更新及时）。",
      fix: "brew install --cask temurin",
    });
    return out;   // 一个都没装，后面几条都无从谈起
  }

  if (!f.javaHome) {
    out.push({
      code: "J1", level: "warn",
      title: "JAVA_HOME 没有设置",
      detail: "java 命令本身照样能用（macOS 的 /usr/bin/java 会自己找最新的 JDK），"
        + "但 Maven 会报「The JAVA_HOME environment variable is not defined correctly」，Gradle 也会找不到 Java。"
        + "这就是它难查的原因：命令行一切正常，一构建就挂。",
      fix: 'echo \'export JAVA_HOME=$(/usr/libexec/java_home)\' >> ~/.zshrc',
    });
  } else if (!f.javaHomeExists) {
    out.push({
      code: "J2", level: "error",
      title: "JAVA_HOME 指向一个不存在的目录",
      detail: `JAVA_HOME 现在是 ${f.javaHome}，但这个目录已经没了 —— 大概是卸载过 JDK 但没改配置。`
        + "所有依赖 JAVA_HOME 的构建工具都会挂。",
      fix: 'export JAVA_HOME=$(/usr/libexec/java_home)   # 改掉 ~/.zshrc 里那一行',
    });
  } else if (f.javaHomeVersion && f.cliVersion && cmpVersion(f.javaHomeVersion, f.cliVersion) !== 0) {
    out.push({
      code: "J3", level: "warn",
      title: "命令行和构建工具用的不是同一个 JDK",
      detail: `终端里 java -version 是 ${f.cliVersion}，但 JAVA_HOME 指向 ${f.javaHomeVersion}。`
        + "macOS 上 /usr/bin/java 不看 JAVA_HOME（它自己找最新的），而 Maven / Gradle 只认 JAVA_HOME —— "
        + "两边就这么分叉了。编译和运行用不同版本很容易出「本地能跑、构建报错」这类怪事。",
      fix: `export JAVA_HOME=$(/usr/libexec/java_home -v ${f.cliVersion.split(".")[0]})`,
    });
  }

  const arches = new Set(f.installs.map((i) => i.arch).filter(Boolean));
  if (arches.has("arm64") && arches.has("x86_64")) {
    const intel = f.installs.filter((i) => i.arch === "x86_64").map((i) => i.version).join("、");
    out.push({
      code: "J4", level: "info",
      title: "同时装了 Apple 芯片版和 Intel 版的 JDK",
      detail: `x86_64（Intel）版本：${intel}。在 Apple 芯片的 Mac 上它们要经 Rosetta 转译，`
        + "性能有明显损失。如果不是为了兼容特定的旧依赖，用 arm64 版更好。",
      fix: "",
    });
  }

  return out;
}

/** Python 诊断的输入。 */
export interface PythonFacts {
  installs: Install[];
  /** PATH 上所有叫 python3 的可执行文件（按 PATH 顺序，第一个即生效的那个） */
  python3Paths: string[];
  /**
   * 上面那些**去掉符号链接之后**还剩几个不同的真身。
   *
   * P1 要报的是「多个不同的 Python 在抢」，而不是「同一个 Python 能从多个路径走到」。
   * Debian 系的 /bin 就是 /usr/bin 的符号链接，光看路径数会把一个 python 数成两个 ——
   * 实测在容器里就误报了。诊断一旦有噪音，用户就不会再信它。
   */
  python3Distinct: number;
  /** 生效的 python3 的 realpath */
  activePath: string;
  /** ~/.pyenv 目录是否存在（装了 pyenv） */
  pyenvDir: boolean;
  /** pyenv 的 shims 目录是否在 PATH 里（决定 pyenv 到底生不生效） */
  pyenvShimsOnPath: boolean;
  /** 当前目录（或上层）找到的 .python-version 文件路径，没有为空串 */
  versionFile: string;
  /** 该文件要求的版本 */
  versionFileWants: string;
  /** pyenv 已装的版本名列表（判断 versionFileWants 装没装） */
  pyenvVersions: string[];
  // 「pip3 和 python3 是不是同一套」用两个 pip 的 from 路径直接比，不比 sys.prefix ——
  // Debian 系是 dist-packages 而不是 site-packages，按前缀比会在每台 Ubuntu 上误报（见 parsePipFrom 注释）。
  /** `python3 -m pip -V` 报的 pip 目录，拿不到为空串 */
  pipFromSelf: string;
  /** `pip3 -V` 报的 pip 目录，拿不到为空串 */
  pipFromCmd: string;
}

export function diagnosePython(f: PythonFacts): Issue[] {
  const out: Issue[] = [];

  // 按「不同的真身」判定，不按路径条数 —— 否则 /bin → /usr/bin 这种符号链接会被数成两个。
  if (f.python3Distinct > 1) {
    const links = f.python3Paths.length - f.python3Distinct;
    out.push({
      code: "P1", level: "info",
      title: `PATH 上有 ${f.python3Distinct} 个不同的 python3`,
      detail: `按 PATH 顺序是：\n${f.python3Paths.map((p, i) => `${i + 1}. ${p}${i === 0 ? "   ← 生效的是这个" : ""}`).join("\n")}\n`
        + (links > 0 ? `（其中 ${links} 个是指向上面某一个的符号链接，不算独立的一份）\n` : "")
        + "PATH 里谁在前面谁生效。这是「我明明 pip install 了却 import 不到」的头号原因 —— "
        + "包装到了另一套 Python 里。",
      fix: "python3 -c 'import sys; print(sys.executable)'",
    });
  }

  if (f.pyenvDir && !f.pyenvShimsOnPath) {
    out.push({
      code: "P2", level: "error",
      title: "装了 pyenv，但它完全没生效",
      detail: "~/.pyenv 存在，可是它的 shims 目录不在 PATH 里 —— 说明 pyenv 的初始化没写进 shell 配置。"
        + "你以为在用 pyenv 管版本，实际一直在用系统那个。pyenv 里装的版本全都调不到。",
      fix: 'echo \'eval "$(pyenv init -)"\' >> ~/.zshrc',
    });
  }

  if (f.activePath === "/usr/bin/python3") {
    out.push({
      code: "P3", level: "warn",
      title: "生效的是系统自带的 python3",
      detail: "/usr/bin/python3 是 macOS 的命令行工具占位程序，不是给开发用的："
        + "首次运行可能弹出「安装命令行工具」的弹窗，而且往它装包会被系统保护挡住（externally-managed-environment）。"
        + "开发建议自己装一份（Homebrew / pyenv / uv 都行）。",
      fix: "brew install python@3.12",
    });
  }

  if (f.versionFile && f.versionFileWants && !f.pyenvVersions.includes(f.versionFileWants)) {
    out.push({
      code: "P4", level: "error",
      title: `版本文件要 ${f.versionFileWants}，但这个版本没装`,
      detail: `${f.versionFile} 指定了 ${f.versionFileWants}，pyenv 里找不到它。`
        + "在这个目录下所有 python 命令都会直接报错。",
      fix: `pyenv install ${f.versionFileWants}`,
    });
  }

  // 两边都拿到了才比。有一边探测失败就沉默 —— 拿空串去比会对每台机器都误报。
  if (f.pipFromSelf && f.pipFromCmd && f.pipFromSelf !== f.pipFromCmd) {
    out.push({
      code: "P5", level: "warn",
      title: "pip3 和 python3 不是同一套",
      detail: `python3 自带的 pip 在 ${f.pipFromSelf}，而 pip3 命令用的是 ${f.pipFromCmd}。`
        + "直接用 pip3 装的包，python3 里 import 不到 —— 它们装到了两个不同的地方。"
        + "永久的解法是改用 python3 -m pip，它保证用的是当前这个 python 自带的那个 pip。",
      fix: "python3 -m pip install <包名>",
    });
  }

  return out;
}

/** 与语言无关的环境诊断（PATH 本身的毛病 + 探测不完整）。 */
export function diagnoseEnv(opts: {
  /** Umbra 进程的 PATH 目录 */
  ownDirs: string[];
  /** 登录 shell 的真实 PATH 目录，拿不到给空数组 */
  shellDirs: string[];
  /** 探测失败/超时的项 */
  partial: string[];
}): Issue[] {
  const out: Issue[] = [];

  if (opts.shellDirs.length) {
    const onlyShell = pathDiff(opts.shellDirs, opts.ownDirs);
    if (onlyShell.length) {
      out.push({
        code: "E1", level: "info",
        title: "Umbra 看到的 PATH 和你终端里的不完全一样",
        detail: `只在终端 PATH 里、Umbra 看不到的目录：\n${onlyShell.join("\n")}\n`
          + "macOS 的图形界面程序不继承登录 shell 的 PATH，这是系统行为。"
          + "所以如果下面的清单和你在终端里 -V 的结果不一致，先看这里。",
        fix: "",
      });
    }
  }

  const dups = dupDirs(opts.ownDirs);
  if (dups.length) {
    out.push({
      code: "E2", level: "info",
      title: "PATH 里有重复目录",
      detail: `${dups.join("、")}\n重复本身不会出错，但通常说明 shell 配置被重复 source 了 —— `
        + "多半是同一段初始化写进了 .zshrc 和 .zprofile 两个文件。",
      fix: "",
    });
  }

  if (opts.partial.length) {
    out.push({
      code: "E3", level: "warn",
      title: `有 ${opts.partial.length} 项探测没完成，下面的清单可能不全`,
      detail: opts.partial.join("\n"),
      fix: "",
    });
  }

  return out;
}

/** 诊断排序：坏的在最上面。同级按 code 排，保证顺序稳定。 */
export function sortIssues(list: Issue[]): Issue[] {
  const rank = { error: 0, warn: 1, info: 2 } as const;
  return [...list].sort((a, b) => rank[a.level] - rank[b.level] || a.code.localeCompare(b.code));
}
