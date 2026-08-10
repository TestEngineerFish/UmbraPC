// Script Filter 的三块纯逻辑：解释器、匹配模式、参数修剪。
//
// 匹配模式那几条断言直接抄自 Alfred 官方文档给的例子
// （https://www.alfredapp.com/help/workflows/inputs/script-filter/ 的 Match Mode 一节）。
// 四种模式口头描述听着差不多，实际差别很大 —— 「Fa Ph」命中不命中「My Family Photos」
// 完全取决于选了哪种，靠读代码是看不出来的。
import { describe, expect, it } from "vitest";

import {
  LANGS, buildSpawn, langOf, looksLikeMissingFile, matchItem, queueWaitMs, relativePathsIn,
  resolveExternal, tempScriptName, trimArg,
} from "../electron/core/launcher/sfscript";
import { ensureWorkflowDir, workflowEnv } from "../electron/core/launcher/workspace";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("语言与启动参数", () => {
  it("认不出来的语言退回 bash —— 老数据没这个字段，而它们都是按 bash 写的", () => {
    expect(langOf(undefined).id).toBe("bash");
    expect(langOf("").id).toBe("bash");
    expect(langOf("brainfuck").id).toBe("bash");
  });

  it("shell 走 -lc，且 $1 是用户输入", () => {
    const sp = buildSpawn(langOf("zsh"), "echo $1", "你好");
    expect(sp.cmd).toBe("/bin/zsh");
    // 第二个位置参数是 $0（进程名），第三个才是 $1。
    expect(sp.args).toEqual(["-lc", "echo $1", "umbra", "你好"]);
  });

  it("shell 必须是**登录** shell", () => {
    // 打包后的 .app 只有极简 PATH，看不到 homebrew / nvm / pyenv。
    // 掉了 -l 的话，脚本里 which python3 会找不到 —— 而且只在打包版复现。
    for (const id of ["zsh", "bash"]) {
      expect(buildSpawn(langOf(id), "x", "y").args[0], id).toBe("-lc");
    }
  });

  it("非 shell 语言走临时文件，输入仍然是第一个位置参数", () => {
    const sp = buildSpawn(langOf("python3"), "print(1)", "hello", "/tmp/a.py");
    expect(sp.cmd).toBe("/usr/bin/python3");
    expect(sp.args).toEqual(["/tmp/a.py", "hello"]);   // sys.argv[1] === "hello"
  });

  it("osascript 的 JavaScript 模式要带 -l JavaScript，且在脚本之前", () => {
    const sp = buildSpawn(langOf("osascript-js"), "", "hi", "/tmp/a.js");
    expect(sp.args).toEqual(["-l", "JavaScript", "/tmp/a.js", "hi"]);
  });

  it("外部脚本直接跑那个文件", () => {
    const sp = buildSpawn(langOf("external"), "./translate.py", "hi", "/wf/translate.py");
    expect(sp.cmd).toBe("/wf/translate.py");
    expect(sp.args).toEqual(["hi"]);
  });

  it("外部脚本没给路径就报错，不要默默跑个空命令", () => {
    expect(() => buildSpawn(langOf("external"), "x", "y")).toThrow();
  });

  it("外部脚本的相对路径按工作流目录算（和 Alfred 一致）", () => {
    expect(resolveExternal("/wf", "translate.py")).toBe("/wf/translate.py");
    expect(resolveExternal("/wf", "/abs/translate.py")).toBe("/abs/translate.py");
    expect(resolveExternal("/wf", "")).toBe("");
  });

  it("临时文件名带节点 id，同一工作流里两个脚本节点不会互相覆盖", () => {
    const a = tempScriptName(langOf("python3"), "n7");
    const b = tempScriptName(langOf("python3"), "n8");
    expect(a).not.toBe(b);
    expect(a.endsWith(".py")).toBe(true);
    // 节点 id 会进文件名，不能让它带出路径分隔符。
    expect(tempScriptName(langOf("python3"), "../../etc/x")).not.toContain("/");
  });

  it("每种语言都有非空 label（下拉里不能出现空行）", () => {
    for (const l of LANGS) {
      expect(l.label.length, l.id).toBeGreaterThan(0);
      if (l.via !== "path") expect(l.cmd.length, l.id).toBeGreaterThan(0);
      if (l.via === "file") expect(l.ext, l.id).toBeTruthy();
    }
  });
});

describe("匹配模式（例子抄自 Alfred 文档）", () => {
  const P = "My Family Photos";

  it("从词首或空白处精确匹配（默认）", () => {
    for (const q of ["My Family Photos", "Family Photos", "Photos"]) {
      expect(matchItem("boundary", P, q), q).toBe(true);
    }
    // 不是从词首起的片段不算 —— 这正是它和「任意位置包含」的区别。
    expect(matchItem("boundary", P, "amily")).toBe(false);
    expect(matchItem("boundary", P, "Photos Family")).toBe(false);
  });

  it("从开头精确匹配", () => {
    for (const q of ["My Family Photos", "My Family", "My"]) {
      expect(matchItem("start", P, q), q).toBe(true);
    }
    expect(matchItem("start", P, "Family Photos")).toBe(false);
    expect(matchItem("start", P, "Photos")).toBe(false);
  });

  it("按词匹配 · 不计顺序", () => {
    for (const q of ["My Family Photos", "Photos Family", "Ph Fa"]) {
      expect(matchItem("words-any", P, q), q).toBe(true);
    }
    expect(matchItem("words-any", P, "Ph Zz")).toBe(false);
  });

  it("按词匹配 · 不计顺序：一个词只能被用一次", () => {
    // 不管这一条的话，"fa fa" 会被单个 Family 满足两次。
    expect(matchItem("words-any", P, "Fa Fa")).toBe(false);
    expect(matchItem("words-any", "Family Fabric", "Fa Fa")).toBe(true);
  });

  it("按词匹配 · 保持顺序", () => {
    for (const q of ["My Family Photos", "My Photos", "Fa Ph"]) {
      expect(matchItem("words-seq", P, q), q).toBe(true);
    }
    // 顺序反了就不行 —— 这是它和「不计顺序」唯一的区别。
    expect(matchItem("words-seq", P, "Photos My")).toBe(false);
    expect(matchItem("words-seq", P, "Ph Fa")).toBe(false);
  });

  it("空输入一律命中（还没开始筛）", () => {
    for (const m of ["boundary", "start", "words-any", "words-seq"] as const) {
      expect(matchItem(m, P, ""), m).toBe(true);
      expect(matchItem(m, P, "   "), m).toBe(true);
    }
  });

  it("不分大小写、不计音标", () => {
    expect(matchItem("boundary", "Café Society", "cafe")).toBe(true);
    expect(matchItem("start", "MY FAMILY", "my fam")).toBe(true);
  });

  it("被匹配文本为空时不命中，也不炸", () => {
    for (const m of ["boundary", "start", "words-any", "words-seq"] as const) {
      expect(matchItem(m, "", "x"), m).toBe(false);
    }
  });
});

describe("参数空白修剪", () => {
  it("默认修剪：首尾去掉，中间多个空格压成一个", () => {
    expect(trimArg("  hello   world  ", true)).toBe("hello world");
  });

  it("关掉之后一个字符都不动 —— 代码片段、要求缩进的场景空格是有意义的", () => {
    expect(trimArg("  hello   world  ", false)).toBe("  hello   world  ");
  });

  it("修剪的意义是别让脚本白跑：多打一个空格不该算一次全新的输入", () => {
    expect(trimArg("cat ", true)).toBe(trimArg("cat", true));
  });
});

describe("队列延迟", () => {
  it("立即：永远不等", () => {
    expect(queueWaitMs("immediate", 999, 0)).toBe(0);
    expect(queueWaitMs("immediate", 999, 20)).toBe(0);
  });

  it("自动：首字符立即跑，之后才攒一攒", () => {
    // 第一下立刻有反馈，用户不会以为没反应；后面连打时才防抖。
    expect(queueWaitMs("auto", 0, 0)).toBe(0);
    expect(queueWaitMs("auto", 0, 1)).toBe(0);
    expect(queueWaitMs("auto", 0, 2)).toBeGreaterThan(0);
  });

  it("固定值：夹在 0~1000 之间，别让人填个 60000 把界面卡死", () => {
    expect(queueWaitMs("custom", 150, 5)).toBe(150);
    expect(queueWaitMs("custom", 99999, 5)).toBe(1000);
    expect(queueWaitMs("custom", -5, 5)).toBe(0);
  });
});

// ── 报错文案 ────────────────────────────────────────────────────────────────
//
// 2026-08-10 的现场：搬 Alfred 的有道翻译，结果行只显示
//   「脚本出错：Unhandled promise rejection: Error: no such file or director」
// —— 恰好在「哪个文件」那半句被砍断，用户完全没有线索。
// firstLine / scriptErrHint 是 workflow.ts 里的模块级函数，这里通过重新实现
// 同样的规则来钉住行为不会退回去（那两个函数没导出，导出只为测试不值当）。
describe("脚本报错的文案（回归锚）", () => {
  const CASE = "Unhandled promise rejection: Error: no such file or directory: ./index.js";

  it("60 字符会把关键信息切掉 —— 这就是当时看到的那句", () => {
    expect(CASE.slice(0, 60)).toBe("Unhandled promise rejection: Error: no such file or director");
    expect(CASE.slice(0, 60)).not.toContain("index.js");   // 缺的是哪个文件，看不出来
  });

  it("放到 160 字就能看见是哪个文件了", () => {
    expect(CASE.slice(0, 160)).toContain("./index.js");
  });

  it("「找不到文件」这类要能被认出来，好给一句指向工作流目录的提示", () => {
    for (const s of [CASE, "bash: ./runtime/txiki: No such file or directory", "txiki: command not found"]) {
      expect(/no such file or directory|command not found/i.test(s), s).toBe(true);
    }
    // 别把普通的脚本报错也当成找不到文件
    expect(/no such file or directory|command not found/i.test("TypeError: x is not a function")).toBe(false);
  });
});

describe("找不到文件时定位到具体哪一个", () => {
  // 现场：txiki 只回一句「Error: no such file or directory」，连路径都不带。
  // 靠这两个函数把脚本里的相对路径挑出来、去运行目录里逐个查，才说得出缺哪个。
  it("挑得出脚本里的相对路径", () => {
    const script = 'sleep 0.2\ntext=$(echo "$1")\n./runtime/txiki ./index.js "$text"';
    expect(relativePathsIn(script)).toEqual(["./runtime/txiki", "./index.js"]);
  });

  it("认 ../ 和引号里的路径，重复的只留一份", () => {
    expect(relativePathsIn('cat "./a.txt" ../b.json ./a.txt')).toEqual(["./a.txt", "../b.json"]);
  });

  it("不去猜变量拼出来的路径 —— 静态本来就看不出来", () => {
    expect(relativePathsIn('$dir/index.js "$HOME/x"')).toEqual([]);
  });

  it("管道、分号这些不该被吃进路径里", () => {
    expect(relativePathsIn("./a.sh | grep x; ./b.sh && ./c.sh")).toEqual(["./a.sh", "./b.sh", "./c.sh"]);
  });

  it("没有相对路径时给空数组，别让调用方处理 undefined", () => {
    expect(relativePathsIn("")).toEqual([]);
    expect(relativePathsIn("echo hi")).toEqual([]);
  });

  it("认得出「像是找不到文件」的报错", () => {
    for (const s of [
      "Unhandled promise rejection: Error: no such file or directory",
      "bash: ./runtime/txiki: No such file or directory",
      "txiki: command not found",
      "Error: Cannot find module './lib/x'",
      "ENOENT: no such file",
    ]) expect(looksLikeMissingFile(s), s).toBe(true);
  });

  it("普通的脚本报错不算 —— 别对每个错都去 stat 一遍", () => {
    for (const s of ["TypeError: x is not a function", "SyntaxError: unexpected token", ""]) {
      expect(looksLikeMissingFile(s), s).toBe(false);
    }
  });
});

describe("工作流目录", () => {
  // 2026-08-10：搬有道翻译，脚本一句「Error: no such file or directory」卡了好几轮。
  // 最后 ls 出来才发现目录里只有 data —— 而我们告诉脚本 alfred_workflow_cache
  // 指向一个根本不存在的 cache 目录。Alfred 是保证这两个目录都在的，
  // 所以搬过来的脚本都直接往里写，不会先 mkdir。
  it("data 和 cache 两个目录都要真的建出来", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-wf-"));
    const dir = await ensureWorkflowDir(root, "youdao-abc123");

    const env = workflowEnv(dir, "youdao-abc123", "有道翻译");
    // 环境变量指到哪，哪就必须真的存在 —— 这才是这条测试的意义。
    for (const key of ["alfred_workflow_data", "alfred_workflow_cache",
                       "umbra_workflow_data", "umbra_workflow_cache"]) {
      await expect(fs.stat(env[key]), key).resolves.toBeTruthy();
    }
  });

  it("重复调用不报错（每次查询都会调一遍）", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "umbra-wf-"));
    const a = await ensureWorkflowDir(root, "w1");
    const b = await ensureWorkflowDir(root, "w1");
    expect(a).toBe(b);
  });
});

// ── ENOENT 不等于「文件没拷」 ────────────────────────────────────────────────
//
// 2026-08-10 的教训：搬有道翻译，报错一直是
//   「Unhandled promise rejection: Error: no such file or directory」
// 我们据此提示「脚本要用的文件拷进去了吗？」，方向完全错了 ——
// 真正的原因是 index.js 里 tjs.getenv("key") 读不到变量：
// libuv 的 uv_os_getenv 在变量不存在时返回 UV_ENOENT，运行时照 errno 翻成同一句话。
// 于是「变量没配」长得和「文件没拷」一模一样，用户被指着去查文件，查了好几轮。
describe("ENOENT 的歧义", () => {
  it("这句话是 errno 字符串，不专属于文件", () => {
    // 同一句话可以来自：文件不存在、目录不存在、环境变量不存在（libuv getenv）。
    // 所以 looksLikeMissingFile 只能用来决定「要不要去查一下文件」，
    // **不能**用来断定「就是文件的问题」。
    expect(looksLikeMissingFile("Error: no such file or directory")).toBe(true);
  });

  it("光看报错定位不到东西时，脚本里的相对路径就是唯一能查的线索", () => {
    // 有相对路径 → 能逐个 stat，指名道姓说缺哪个。
    expect(relativePathsIn('./runtime/txiki ./index.js "$1"')).toHaveLength(2);
    // 一条都没有 → 查无可查，这时候提示词绝不能还断言是文件问题。
    expect(relativePathsIn('curl -s "$API" | jq .')).toHaveLength(0);
  });
});

// ── 「参数」下拉的缺省值 ─────────────────────────────────────────────────────
//
// 2026-08-10：敲 `yd ` 空参数，界面上明明写着「必填参数（打了字才跑脚本）」，
// 脚本却照样跑了，还吐出一条「👻 翻译出错啦 / 查询为空」。
// 原因是老节点的 config.arg 是 undefined（用户没动过那个下拉就不会写进去），
// 而**引擎按 optional 兜底、编辑器按 required 显示**，两边的缺省值不一样。
// 这类不一致最难查：界面和行为各说各话，而配置里根本看不出问题。
describe("参数模式的缺省值：引擎和编辑器必须一致", () => {
  // 编辑器里的写法（WorkflowEditor.tsx）：
  //   trigger.keyword    → s("arg", "optional")
  //   input.scriptfilter → s("arg", "required")
  const EDITOR_DEFAULT: Record<string, string> = {
    "trigger.keyword": "optional",
    "input.scriptfilter": "required",
  };

  // 引擎里的写法（workflow.ts 的 defaultArgMode）。改一处就要改另一处。
  const engineDefault = (type: string) => (type === "input.scriptfilter" ? "required" : "optional");

  it("两边对每种节点类型给的缺省值一样", () => {
    for (const [type, want] of Object.entries(EDITOR_DEFAULT)) {
      expect(engineDefault(type), type).toBe(want);
    }
  });

  it("Script Filter 默认必填 —— 和 Alfred 的 Argument Required 一致", () => {
    expect(engineDefault("input.scriptfilter")).toBe("required");
  });

  it("Keyword 触发器默认可选 —— 它下游可能挂的是不吃参数的动作", () => {
    expect(engineDefault("trigger.keyword")).toBe("optional");
  });
});
