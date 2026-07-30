// 纯逻辑类工具节点的执行语义：Junction / Filter / Random / JSON Config。
//
// 测的是**跑一条真工作流**（runFromEditor → runNode），不是单独调私有函数 ——
// 这四个节点的行为一半在「它自己算出什么」，另一半在「链路要不要继续、变量有没有传下去」，
// 只测前者等于没测。链路末端挂一个 Debug 节点，它会把当时的参数写进轨迹，
// 于是「下游有没有跑到、拿到的参数是什么」都能从轨迹里读出来。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { WorkflowEngine } from "../electron/core/launcher/workflow";
import type { ConfigStore } from "../electron/core/config";
import { dialogPicks } from "./stubs/electron";

interface NodeDef { id: string; type: string; config?: Record<string, unknown> }

// 造一条「关键词触发 → …中间节点… → Debug」的工作流并跑一遍，返回这次运行的轨迹。
// Debug 节点的 stdout 就是它执行那一刻的参数，用来判断链路走没走到、参数变没变。
// 记录引擎对外部动作的调用（收起/唤起面板），供「隐藏/显示主面板」两个节点断言。
const calls = { hide: 0, show: 0 };
// 引擎会在这个目录下给每条工作流建自己的目录（脚本节点的 cwd 与 data 目录）。
const TMP_CFG_DIR = mkdtempSync(path.join(tmpdir(), "umbra-cfg-"));

async function runChain(middle: NodeDef[], arg = "输入") {
  calls.hide = 0;
  calls.show = 0;
  const nodes = [
    { id: "t", type: "trigger.keyword", x: 0, y: 0, config: { keyword: "k" } },
    ...middle.map((n) => ({ ...n, x: 0, y: 0, config: n.config || {} })),
    { id: "dbg", type: "utility.debug", x: 0, y: 0, config: { text: "{query}" } },
  ];
  const chain = ["t", ...middle.map((n) => n.id), "dbg"];
  const connections = chain.slice(0, -1).map((from, i) => ({ from, to: chain[i + 1], port: "" }));
  const wf = { id: "wf", name: "测试", enabled: true, nodes, connections };

  // dir 必须给：脚本类节点要先 ensureWorkflowDir 建工作流目录，缺了会直接抛异常，
  // 表现成「节点没跑、反馈是空串」，看不出真正的原因。
  const cfg = { dir: TMP_CFG_DIR, get: () => ({ launcherWorkflows: [wf] }) } as unknown as ConfigStore;
  const engine = new WorkflowEngine(cfg, {
    sendAssistant: () => {},
    hide: async () => { calls.hide++; },
    showLargeType: () => {},
    showPanel: async () => { calls.show++; },
    showTextView: () => {},
    getSecret: () => null,
  } as never);

  const r = await engine.runFromEditor("wf", "t", arg);
  const run = engine.trace.list("wf")[0];
  return {
    ok: r.ok,
    feedback: r.feedback,
    // 末端 Debug 有没有执行到 = 链路有没有走完
    reached: run.steps.some((s) => s.nodeId === "dbg"),
    // Debug 执行那一刻的参数
    finalArg: run.steps.find((s) => s.nodeId === "dbg")?.stdout ?? null,
    // 链路末端看到的变量表。轨迹里的 vars 是**入口处**的快照，所以一个节点自己写的变量
    // 要到下一个节点的步骤上才看得见 —— 读末端 Debug 的快照最省事，也最接近「下游拿到了什么」。
    varsAtEnd: () => run.steps.find((s) => s.nodeId === "dbg")?.vars || {},
    step: (id: string) => run.steps.find((s) => s.nodeId === id),
  };
}

describe("Junction 汇流点", () => {
  it("什么都不改，参数原样传给下游", async () => {
    const r = await runChain([{ id: "j", type: "utility.junction" }], "原样");
    expect(r.reached).toBe(true);
    expect(r.finalArg).toBe("原样");
  });
});

describe("Filter 过滤", () => {
  it("命中就放行", async () => {
    const r = await runChain([{
      id: "f", type: "utility.filter",
      config: { rules: [{ subject: "{query}", op: "contains", value: "急" }] },
    }], "这条很急");
    expect(r.reached).toBe(true);
  });

  it("不命中就中断，下游不执行", async () => {
    const r = await runChain([{
      id: "f", type: "utility.filter",
      config: { rules: [{ subject: "{query}", op: "contains", value: "急" }] },
    }], "这条很平常");
    expect(r.reached).toBe(false);
  });

  it("多条规则任一命中即放行", async () => {
    const r = await runChain([{
      id: "f", type: "utility.filter",
      config: { rules: [
        { subject: "{query}", op: "contains", value: "急" },
        { subject: "{query}", op: "starts_with", value: "报告" },
      ] },
    }], "报告：本周进展");
    expect(r.reached).toBe(true);
  });

  it("一条规则都没配 = 不过滤，全部放行", async () => {
    // 反过来（当成全拦）会让刚拖上画布还没配的节点把整条链路憋死，很难查
    const r = await runChain([{ id: "f", type: "utility.filter", config: {} }], "随便什么");
    expect(r.reached).toBe(true);
  });

  it("被过滤掉是正常结果，不该弹提示", async () => {
    const r = await runChain([{
      id: "f", type: "utility.filter",
      config: { rules: [{ subject: "{query}", op: "is", value: "对不上" }] },
    }], "x");
    expect(r.feedback).toBe("");
  });
});

describe("Random 随机值", () => {
  it("范围模式落在区间内", async () => {
    for (let i = 0; i < 20; i++) {
      const r = await runChain([{ id: "rd", type: "utility.random", config: { mode: "range", min: 5, max: 8 } }]);
      const n = Number(r.finalArg);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(8);
    }
  });

  it("最小最大写反了也认（省得对着空结果找半天）", async () => {
    const r = await runChain([{ id: "rd", type: "utility.random", config: { mode: "range", min: 9, max: 3 } }]);
    const n = Number(r.finalArg);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(9);
  });

  it("UUID 形状对", async () => {
    const r = await runChain([{ id: "rd", type: "utility.random", config: { mode: "uuid" } }]);
    expect(r.finalArg).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("十六进制串长度对", async () => {
    const r = await runChain([{ id: "rd", type: "utility.random", config: { mode: "hex", length: 12 } }]);
    expect(r.finalArg).toMatch(/^[0-9a-f]{12}$/i);
  });

  it("长度夹在 1..64，填个离谱的数不会炸", async () => {
    const r = await runChain([{ id: "rd", type: "utility.random", config: { mode: "hex", length: 99999 } }]);
    expect((r.finalArg || "").length).toBe(64);
  });

  it("指定了变量名就写变量，参数不动", async () => {
    const r = await runChain([{ id: "rd", type: "utility.random", config: { mode: "uuid", target: "rid" } }], "别动我");
    expect(r.finalArg).toBe("别动我");
    expect(r.varsAtEnd().rid).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
  });

  it("写进名字像密钥的变量时，调试轨迹里要打码", async () => {
    // 这条不是为 Random 写的，是顺手把「轨迹不泄密」这条守住 ——
    // 变量名含 key/token/password 之类的值在轨迹里必须是打码的，否则调试抽屉就是个泄密面。
    const r = await runChain([{ id: "rd", type: "utility.random", config: { mode: "hex", length: 16, target: "apiToken" } }]);
    expect(r.varsAtEnd().apiToken).toMatch(/\*/);
  });
});

describe("JSON Config", () => {
  it("一次设置多个变量", async () => {
    const r = await runChain([{
      id: "jc", type: "utility.jsonconfig",
      config: { json: '{"api":"https://example.com","kw":"固定值"}' },
    }]);
    expect(r.reached).toBe(true);
    const v = r.varsAtEnd();
    expect(v.api).toBe("https://example.com");
    expect(v.kw).toBe("固定值");
  });

  it("值里的占位符会被替换", async () => {
    const r = await runChain([{
      id: "jc", type: "utility.jsonconfig",
      config: { json: '{"kw":"搜索 {query}"}' },
    }], "关键词");
    expect(r.varsAtEnd().kw).toBe("搜索 关键词");
  });

  it("值里带引号和换行不会撑坏解析（替换是在 parse 之后做的）", async () => {
    const r = await runChain([{
      id: "jc", type: "utility.jsonconfig",
      config: { json: '{"t":"前 {query} 后"}' },
    }], '他说"你好"\n换行了');
    expect(r.varsAtEnd().t).toBe('前 他说"你好"\n换行了 后');
  });

  it("非字符串的值转成字符串（变量表只存字符串）", async () => {
    const r = await runChain([{
      id: "jc", type: "utility.jsonconfig",
      config: { json: '{"n":42,"b":true,"o":{"a":1}}' },
    }]);
    const v = r.varsAtEnd();
    expect(v.n).toBe("42");
    expect(v.b).toBe("true");
    expect(v.o).toBe('{"a":1}');
  });

  it("JSON 不合法就中断并提示，不带着半份变量往下跑", async () => {
    const r = await runChain([{ id: "jc", type: "utility.jsonconfig", config: { json: "{坏" } }]);
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("不是合法 JSON");
  });

  it("最外层不是对象也要拦住", async () => {
    const r = await runChain([{ id: "jc", type: "utility.jsonconfig", config: { json: '["a","b"]' } }]);
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("最外层");
  });

  it("没填就什么都不做，不算错", async () => {
    const r = await runChain([{ id: "jc", type: "utility.jsonconfig", config: { json: "  " } }], "透传");
    expect(r.reached).toBe(true);
    expect(r.finalArg).toBe("透传");
  });
});

// ── macOS 专属组 ────────────────────────────────────────────────────────────
// 真去跑 osascript / shortcuts 没法在 CI 里测（也不该测——那是在测系统），
// 所以这里守的是**两道门**：平台不对时必须明确报错而不是静默跳过，
// 以及配置不全时必须在动手之前就停下。「按了没反应」比「说清楚不支持」难查一百倍。
describe("macOS 专属组：平台守卫", () => {
  it.each([
    ["action.applescript", { script: 'tell application "Finder" to activate' }],
    ["automation.shortcut", { name: "某个快捷指令" }],
    ["automation.music", { command: "playpause" }],
  ])("%s 在非 macOS 上明确提示并中断", async (type, config) => {
    if (process.platform === "darwin") return;   // 真在 Mac 上跑测试时这条不适用
    const r = await runChain([{ id: "n", type, config }]);
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("macOS");
  });
});

describe("macOS 专属组：动手之前的配置校验", () => {
  // 把平台伪装成 macOS，好走到各自的参数校验分支（这些分支都在真正执行之前就返回了）
  const asMac = <T>(fn: () => Promise<T>) => async () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try { return await fn(); } finally { Object.defineProperty(process, "platform", real); }
  };

  it("AppleScript 脚本为空就停下", asMac(async () => {
    const r = await runChain([{ id: "n", type: "action.applescript", config: { script: "   " } }]);
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("脚本为空");
  }));

  it("快捷指令没填名称就停下", asMac(async () => {
    const r = await runChain([{ id: "n", type: "automation.shortcut", config: { name: "" } }]);
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("没填名称");
  }));

  it("音乐控制遇到未知命令就停下（而不是当成播放/暂停蒙一个）", asMac(async () => {
    const r = await runChain([{ id: "n", type: "automation.music", config: { command: "没这个命令" } }]);
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("未知命令");
  }));
});

// ── 文件能力组 ──────────────────────────────────────────────────────────────
describe("File Conditional 文件条件", () => {
  // 多出口节点在 runChain 里下游连的是默认口，所以直接看它选了哪个出口
  const portOf = async (rules: unknown[], arg: string) => {
    const r = await runChain([{ id: "fc", type: "utility.fileconditional", config: { rules } }], arg);
    return r.step("fc")?.outPort;
  };

  it("按扩展名命中第几条就走第几个出口", async () => {
    const rules = [{ op: "ext_in", value: "png, jpg" }, { op: "ext_in", value: "pdf" }];
    expect(await portOf(rules, "/x/a.png")).toBe("r0");
    expect(await portOf(rules, "/x/b.pdf")).toBe("r1");
  });

  it("全不中走「否则」", async () => {
    expect(await portOf([{ op: "ext_in", value: "png" }], "/x/c.txt")).toBe("else");
  });

  it("一条规则都没有时也走「否则」，不至于卡住", async () => {
    expect(await portOf([], "/x/a.png")).toBe("else");
  });

  it("扩展名比对忽略大小写（PNG 和 png 是一回事）", async () => {
    expect(await portOf([{ op: "ext_in", value: "png" }], "/x/A.PNG")).toBe("r0");
  });

  it("路径不存在这条判得出来", async () => {
    expect(await portOf([{ op: "not_exists" }], "/根本没有/这个/文件.txt")).toBe("r0");
  });

  it("文件名包含 / 完整路径包含是两回事", async () => {
    expect(await portOf([{ op: "name_contains", value: "报告" }], "/项目/报告.pdf")).toBe("r0");
    // 「项目」在目录名里，不在文件名里 —— 只有 path_contains 该命中
    expect(await portOf([{ op: "name_contains", value: "项目" }], "/项目/报告.pdf")).toBe("else");
    expect(await portOf([{ op: "path_contains", value: "项目" }], "/项目/报告.pdf")).toBe("r0");
  });
});

describe("File Buffer 文件暂存区", () => {
  // 暂存区挂在引擎实例上，跨节点共享 —— 所以要在**同一条链路**里先收后取
  const chain = (mode: string, extra: Record<string, unknown> = {}) =>
    ({ id: `fb_${mode}`, type: "action.filebuffer", config: { mode, ...extra } });

  // 收进去之前要校验文件真的在，所以这里必须用真文件，不能拿 /x/1.txt 这种假路径凑数
  let dir = "";
  let f1 = "";
  let f2 = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "umbra-fb-"));
    f1 = path.join(dir, "1.txt");
    f2 = path.join(dir, "2.txt");
    await writeFile(f1, "x");
    await writeFile(f2, "x");
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("收进去的路径会去重", async () => {
    const r = await runChain([
      { id: "a", type: "action.filebuffer", config: { mode: "add" } },
    ], `${f1}\n${f1}\n${f2}`);
    expect(r.feedback).toContain("2 个");
  });

  it("不存在的路径直接跳过，并把跳了几个说出来", async () => {
    const r = await runChain([
      { id: "a", type: "action.filebuffer", config: { mode: "add" } },
    ], `${f1}\n/根本没有/这个.txt`);
    expect(r.feedback).toContain("跳过 1 个");
  });

  it("全是不存在的路径时中断，不让幽灵路径躺进暂存区", async () => {
    const r = await runChain([
      { id: "a", type: "action.filebuffer", config: { mode: "add" } },
    ], "/根本没有/a.txt\n/根本没有/b.txt");
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("都不存在");
  });

  it("没有可收的路径时明确报错并中断", async () => {
    const r = await runChain([chain("add")], "   ");
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("没有可收的路径");
  });

  it("暂存区是空的时候取，要说清楚而不是给下游一个空串", async () => {
    const r = await runChain([chain("list")], "随便");
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("暂存区是空的");
  });

  it("清空永远成功，不管里面有没有东西", async () => {
    const r = await runChain([chain("clear")], "随便");
    expect(r.reached).toBe(true);
    expect(r.feedback).toContain("已清空");
  });
});

describe("Reveal / Browse 的路径守卫", () => {
  it("在文件管理器中显示：路径不存在时明确报错", async () => {
    const r = await runChain([{ id: "rv", type: "action.reveal", config: {} }], "/根本没有/这个.txt");
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("路径不存在");
  });

  it("在文件管理器中显示：没有路径时也不静默跳过", async () => {
    const r = await runChain([{ id: "rv", type: "action.reveal", config: { path: "" } }], "");
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("没有路径");
  });

  it("在终端中打开：非 macOS 上明确提示不可用", async () => {
    if (process.platform === "darwin") return;
    const r = await runChain([{ id: "br", type: "action.browse", config: {} }], "/tmp");
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("macOS");
  });
});

// ── 窗口系统组 ──────────────────────────────────────────────────────────────
describe("隐藏 / 显示主面板", () => {
  it("隐藏主面板真的去收面板了，并且链路继续", async () => {
    const r = await runChain([{ id: "h", type: "utility.hide" }], "透传");
    expect(calls.hide).toBeGreaterThan(0);
    expect(r.reached).toBe(true);
    expect(r.finalArg).toBe("透传");   // 它不改数据
  });

  it("显示主面板真的去唤起面板了", async () => {
    const r = await runChain([{ id: "s", type: "utility.show" }], "透传");
    expect(calls.show).toBeGreaterThan(0);
    expect(r.reached).toBe(true);
  });
});

describe("Dispatch Key Combo 发送按键", () => {
  it("没录键位就停下，不去乱按", async () => {
    const r = await runChain([{ id: "k", type: "output.keycombo", config: { accelerator: "" } }]);
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("没录键位");
  });

  it("默认会先收起面板 —— 不收的话按键发给的是面板自己", async () => {
    await runChain([{ id: "k", type: "output.keycombo", config: { accelerator: "Command+K", delayMs: 0 } }]);
    expect(calls.hide).toBeGreaterThan(0);
  });

  it("关掉「先收起面板」就真的不收", async () => {
    await runChain([{ id: "k", type: "output.keycombo", config: { accelerator: "Command+K", hideFirst: false } }]);
    expect(calls.hide).toBe(0);
  });

  it("发不出去时要把原因带出来（当前系统不支持 / 没有辅助功能权限）", async () => {
    if (process.platform === "darwin" || process.platform === "win32") return;
    const r = await runChain([{ id: "k", type: "output.keycombo", config: { accelerator: "Command+K", hideFirst: false } }]);
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("发送按键失败");
  });
});

describe("System Command 系统命令", () => {
  it("非 macOS 上明确提示并中断", async () => {
    if (process.platform === "darwin") return;
    const r = await runChain([{ id: "sc", type: "automation.system", config: { command: "lock" } }]);
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("macOS");
  });

  it("未知命令要停下，而不是蒙一个执行", async () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const r = await runChain([{ id: "sc", type: "automation.system", config: { command: "关机吧" } }]);
      expect(r.reached).toBe(false);
      expect(r.feedback).toContain("未知命令");
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  });
});

describe("Terminal Command 终端命令", () => {
  it("非 macOS 上明确提示并中断", async () => {
    if (process.platform === "darwin") return;
    const r = await runChain([{ id: "tm", type: "action.terminal", config: { command: "ls" } }]);
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("macOS");
  });

  it("命令为空就停下，不去开一个空终端窗口", async () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const r = await runChain([{ id: "tm", type: "action.terminal", config: { command: "  " } }]);
      expect(r.reached).toBe(false);
      expect(r.feedback).toContain("命令为空");
    } finally { Object.defineProperty(process, "platform", real); }
  });

  it("不认识的终端要明说不支持，而不是静默什么都不做", async () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const r = await runChain([{ id: "tm", type: "action.terminal", config: { command: "ls", app: "Warp" } }]);
      expect(r.reached).toBe(false);
      expect(r.feedback).toContain("不支持的终端");
    } finally { Object.defineProperty(process, "platform", real); }
  });
});

describe("Web Search 网页搜索", () => {
  // 每条用例前清一次，免得断言读到上一条留下的地址
  const opened = async (middle: NodeDef[], arg?: string) => {
    const { openedUrls } = await import("./stubs/electron");
    openedUrls.length = 0;
    const r = await runChain(middle, arg);
    return { ...r, urls: [...openedUrls] };
  };

  it("默认走 Google，关键词做 URL 编码", async () => {
    const r = await opened([{ id: "ws", type: "action.websearch" }], "企业微信 下载");
    expect(r.reached).toBe(true);
    expect(r.urls[0]).toBe("https://www.google.com/search?q=" + encodeURIComponent("企业微信 下载"));
  });

  it("换引擎就换地址，搜索词还能拼前后缀", async () => {
    const r = await opened([{
      id: "ws", type: "action.websearch",
      config: { engine: "github", query: "{query} language:ts" },
    }], "workflow");
    expect(r.urls[0]).toContain("github.com/search?q=");
    expect(r.urls[0]).toContain(encodeURIComponent("workflow language:ts"));
  });

  it("没有关键词就不搜 —— 否则跳到一个空搜索页，看着像搜过了", async () => {
    const r = await opened([{ id: "ws", type: "action.websearch" }], "");
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("没有关键词");
    expect(r.urls.length).toBe(0);
  });

  it("自定义地址少了占位符要拦下：不然搜什么都跳同一个页面", async () => {
    const r = await opened([{
      id: "ws", type: "action.websearch",
      config: { engine: "custom", custom: "https://example.com/" },
    }], "x");
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("占位符");
  });

  it("未知引擎要停下，不去蒙一个", async () => {
    const r = await opened([{ id: "ws", type: "action.websearch", config: { engine: "yahoo" } }], "x");
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("未知搜索引擎");
  });

  it("搜完继续往下走，参数不变（它是个动作，不是取数）", async () => {
    const r = await opened([{ id: "ws", type: "action.websearch" }], "原样");
    expect(r.finalArg).toBe("原样");
  });
});

describe("Speak 朗读 / Play Sound 提示音", () => {
  it("没内容就不念", async () => {
    const r = await runChain([{ id: "sp", type: "output.speak", config: { text: "" } }], "");
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("没有内容");
  });

  it("Linux 上明确说不可用，而不是静默无声", async () => {
    if (process.platform === "darwin" || process.platform === "win32") return;
    const r = await runChain([{ id: "sp", type: "output.speak" }], "念一句");
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("macOS");
    const s = await runChain([{ id: "sd", type: "output.sound" }]);
    expect(s.reached).toBe(false);
    expect(s.feedback).toContain("macOS");
  });

  it("声音文件不存在时报错停下 —— 静悄悄没响是最难查的那种", async () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const r = await runChain([{ id: "sd", type: "output.sound", config: { path: "/根本没有这个文件.aiff" } }]);
      expect(r.reached).toBe(false);
      expect(r.feedback).toContain("不存在");
    } finally { Object.defineProperty(process, "platform", real); }
  });
});

// ── 对照 Alfred 官方文档逐个核查后修掉的差异 ──────────────────────────────────
// 这一批的共同点是「不修也能跑，但跑出来的结果和用户预期不一样」，最值得用测试钉死。

describe("打开文件：多路径", () => {
  it("多行路径要逐条打开 —— File Buffer 取出的就是多行，两个节点天生要串在一起", async () => {
    const r = await runChain([{ id: "of", type: "action.openfile" }], "/tmp/a.txt\n/tmp/b.txt");
    expect(r.feedback).toContain("2 个");
  });

  it("一条路径时不报「已打开 N 个」，免得单条也啰嗦", async () => {
    const r = await runChain([{ id: "of", type: "action.openfile" }], "/tmp/a.txt");
    expect(r.feedback).not.toContain("个");
  });

  it("没有路径就停下，不去 open 一个空串", async () => {
    const r = await runChain([{ id: "of", type: "action.openfile", config: { path: "" } }], "");
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("没有路径");
  });
});

describe("系统通知：标题正文与空内容", () => {
  it("正文为空时默认跳过，但链路继续 —— 空通知最招人烦", async () => {
    const r = await runChain([{ id: "n", type: "output.notify" }], "");
    expect(r.reached).toBe(true);          // 跳过通知不等于中断链路
    expect(r.feedback).toContain("已跳过");
  });

  it("显式选了「空也弹」就照弹", async () => {
    const r = await runChain([{ id: "n", type: "output.notify", config: { ifEmpty: "show" } }], "");
    expect(r.feedback).not.toContain("已跳过");
  });

  it("通知不改参数，下游拿到的还是原来那条", async () => {
    const r = await runChain([{ id: "n", type: "output.notify", config: { title: "构建", text: "好了" } }], "原样");
    expect(r.finalArg).toBe("原样");
  });
});

describe("Run Script：语言选择", () => {
  it("选了不认识的语言要停下，而不是拿 bash 蒙一个", async () => {
    const r = await runChain([{ id: "s", type: "action.script", config: { script: "x", language: "perl" } }]);
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("不支持的脚本语言");
  });

  it("shebang 和下拉选的语言对不上时明确报错 —— bash 会把它当注释，然后报一个指不到原因的错", async () => {
    const r = await runChain([{
      id: "s", type: "action.script",
      config: { script: "#!/usr/bin/python3\nprint(1)", language: "bash" },
    }]);
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("一致");
  });

  it("env 后面那个词才是真正的解释器，一致时照常放行", async () => {
    const r = await runChain([{
      id: "s", type: "action.script",
      config: { script: "#!/usr/bin/env bash\necho hi", language: "bash" },
    }]);
    expect(r.reached).toBe(true);
  });

  it("env 形式的 shebang 也要能拦住 —— #!/usr/bin/env python3 是最常见的写法", async () => {
    const r = await runChain([{
      id: "s", type: "action.script",
      config: { script: "#!/usr/bin/env python3\nprint(1)", language: "bash" },
    }]);
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("一致");
  });

  it("Python 真的用 Python 跑，参数从 sys.argv[1] 进去", async () => {
    const r = await runChain([{
      id: "s", type: "action.script",
      config: { script: "import sys; print(sys.argv[1].upper())", language: "python3" },
    }], "hello");
    expect(r.finalArg).toBe("HELLO");
  });
});

describe("JSON Config：Alfred 包裹写法", () => {
  it("裸对象照旧当变量表（不能因为加了包裹写法就把简写弄坏）", async () => {
    const r = await runChain([
      { id: "j", type: "utility.jsonconfig", config: { json: '{"a":"1"}' } },
      { id: "d2", type: "utility.debug", config: { text: "{var:a}" } },
    ]);
    expect(r.step("d2")?.stdout).toBe("1");
  });

  it("包裹写法能改参数和变量", async () => {
    const r = await runChain([{
      id: "j", type: "utility.jsonconfig",
      config: { json: '{"alfredworkflow":{"arg":"新参数","variables":{"b":"2"}}}' },
    }], "旧参数");
    expect(r.finalArg).toBe("新参数");
    expect(r.varsAtEnd().b).toBe("2");
  });

  it("config 覆写只影响紧接着的下游节点，且不写回保存的配置", async () => {
    const r = await runChain([
      { id: "j", type: "utility.jsonconfig", config: { json: '{"alfredworkflow":{"config":{"text":"被覆写了"}}}' } },
      { id: "d2", type: "utility.debug", config: { text: "原配置" } },
      // 再下一层不该继续吃这份覆写 —— 覆写只走一层
      { id: "d3", type: "utility.debug", config: { text: "第二层" } },
    ]);
    expect(r.step("d2")?.stdout).toBe("被覆写了");
    expect(r.step("d3")?.stdout).toBe("第二层");
  });
});

describe("Transform 新增的三种变换", () => {
  // 节点 id 不能叫 "t" —— runChain 里的触发器就叫 t，撞了之后引擎按 id 找到的是触发器，
  // 这个节点根本不会执行，而测试会显示成「变换没生效」，非常难查。
  const tf = (mode: string, arg: string) =>
    runChain([{ id: "tf1", type: "utility.transform", config: { mode } }], arg).then((r) => r.finalArg);

  it("反转按字符算，emoji 不会被劈成两半", async () => {
    expect(await tf("reverse", "abc")).toBe("cba");
    expect(await tf("reverse", "a🎉b")).toBe("b🎉a");
  });

  it("去重音只掉记号，字母还在", async () => {
    expect(await tf("deaccent", "café naïve")).toBe("cafe naive");
  });

  it("只留字母数字要保住中文 —— 只留 ASCII 会把中文内容清空", async () => {
    expect(await tf("alnum", "a-b_c 1!")).toBe("abc1");
    expect(await tf("alnum", "报告：第 1 版")).toBe("报告第1版");
  });
});

describe("Random：从列表里取", () => {
  it("取到的一定是列表里的某一项", async () => {
    const r = await runChain([{
      id: "rd", type: "utility.random", config: { mode: "list", list: "面\n饭\n沙拉" },
    }]);
    expect(["面", "饭", "沙拉"]).toContain(r.finalArg);
  });

  it("列表空了要说清楚，不给下游一个空串", async () => {
    const r = await runChain([{ id: "rd", type: "utility.random", config: { mode: "list", list: "  \n " } }]);
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("列表是空的");
  });
});

describe("发送按键：连按次数", () => {
  it("次数被夹在 1..20，填 999 也不会真发 999 次", async () => {
    // 非 macOS 上第一次就发不出去，会中断——这里只验证它没有因为 999 而空转很久
    const r = await runChain([{
      id: "k", type: "output.keycombo", config: { accelerator: "Tab", hideFirst: false, repeat: 999 },
    }]);
    if (process.platform === "darwin" || process.platform === "win32") return;
    expect(r.reached).toBe(false);
    expect(r.feedback).toContain("发送按键失败");
  });
});

describe("系统命令：确认框", () => {
  it("没勾确认就不去弹框（勾了才弹，避免每次都打断）", async () => {
    if (process.platform === "darwin") return;
    const r = await runChain([{ id: "sc", type: "automation.system", config: { command: "lock" } }]);
    expect(r.feedback).toContain("macOS");   // 非 mac 上在平台守卫处就停了，说明没先去弹框
  });
});

describe("Dialog Conditional 对话框", () => {
  // 通用的 runChain 只会把连线挂在默认出口上，表达不了「从 b1 这个出口引出去」，
  // 所以这里自己搭链路。这也正好把最该测的东西测到了：**出口真的按按钮下标路由**。
  const run = async (pick: number, fromPort: string, config: Record<string, unknown>, arg = "透传") => {
    dialogPicks.length = 0;
    dialogPicks.push(pick);
    let hide = 0;
    const nodes = [
      { id: "t", type: "trigger.keyword", x: 0, y: 0, config: { keyword: "k" } },
      { id: "dlg", type: "utility.dialog", x: 0, y: 0, config },
      { id: "dbg", type: "utility.debug", x: 0, y: 0, config: { text: "{query}" } },
    ];
    const connections = [
      { from: "t", to: "dlg" },
      { from: "dlg", to: "dbg", fromPort },
    ];
    const wf = { id: "wf", name: "测试", enabled: true, nodes, connections };
    const cfg = { dir: TMP_CFG_DIR, get: () => ({ launcherWorkflows: [wf] }) } as unknown as ConfigStore;
    const engine = new WorkflowEngine(cfg, {
      sendAssistant: () => {}, hide: async () => { hide++; }, showLargeType: () => {},
      showPanel: async () => {}, showTextView: () => {}, getSecret: () => null,
    } as never);
    const r = await engine.runFromEditor("wf", "t", arg);
    const steps = engine.trace.list("wf")[0].steps;
    return {
      feedback: r.feedback,
      hide,
      dlg: steps.find((x) => x.nodeId === "dlg"),
      dbg: steps.find((x) => x.nodeId === "dbg"),
    };
  };

  it("点了第 N 个按钮就走第 N 个出口", async () => {
    expect((await run(1, "b1", { buttons: ["取消", "继续"] })).dlg?.outPort).toBe("b1");
    expect((await run(0, "b0", { buttons: ["取消", "继续"] })).dlg?.outPort).toBe("b0");
  });

  it("接在别的出口上的下游不会跑 —— 这才是「分流」的意思", async () => {
    const r = await run(0, "b1", { buttons: ["取消", "继续"] });   // 点了取消，线接在「继续」那口
    expect(r.dbg).toBeUndefined();
  });

  it("接在命中的出口上就会跑", async () => {
    expect((await run(1, "b1", { buttons: ["取消", "继续"] })).dbg).toBeTruthy();
  });

  it("按了哪个按钮写进变量，下游能读到", async () => {
    const r = await run(1, "b1", { buttons: ["取消", "继续"] });
    expect(r.dbg?.vars?.dialog_button).toBe("继续");
  });

  it("参数原样透传 —— 它是分流，不是取数", async () => {
    const r = await run(1, "b1", { buttons: ["取消", "继续"] }, "原样");
    expect(r.dbg?.stdout).toBe("原样");
  });

  it("弹框前先收起面板 —— 不收的话框会被常驻最前的浮层盖住，等于弹了个看不见的框", async () => {
    expect((await run(0, "b0", { buttons: ["好"] })).hide).toBeGreaterThan(0);
  });

  it("反馈里写清选了哪个，调试轨迹上一眼能看到", async () => {
    expect((await run(1, "b1", { buttons: ["取消", "删掉"] })).feedback).toContain("删掉");
  });

  it("不配按钮时按默认的两个走", async () => {
    const r = await run(1, "b1", {});
    expect(r.dlg?.outPort).toBe("b1");
    expect(r.dbg?.vars?.dialog_button).toBe("确定");
  });
});
