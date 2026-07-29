// 纯逻辑类工具节点的执行语义：Junction / Filter / Random / JSON Config。
//
// 测的是**跑一条真工作流**（runFromEditor → runNode），不是单独调私有函数 ——
// 这四个节点的行为一半在「它自己算出什么」，另一半在「链路要不要继续、变量有没有传下去」，
// 只测前者等于没测。链路末端挂一个 Debug 节点，它会把当时的参数写进轨迹，
// 于是「下游有没有跑到、拿到的参数是什么」都能从轨迹里读出来。
import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "../electron/core/launcher/workflow";
import type { ConfigStore } from "../electron/core/config";

interface NodeDef { id: string; type: string; config?: Record<string, unknown> }

// 造一条「关键词触发 → …中间节点… → Debug」的工作流并跑一遍，返回这次运行的轨迹。
// Debug 节点的 stdout 就是它执行那一刻的参数，用来判断链路走没走到、参数变没变。
async function runChain(middle: NodeDef[], arg = "输入") {
  const nodes = [
    { id: "t", type: "trigger.keyword", x: 0, y: 0, config: { keyword: "k" } },
    ...middle.map((n) => ({ ...n, x: 0, y: 0, config: n.config || {} })),
    { id: "dbg", type: "utility.debug", x: 0, y: 0, config: { text: "{query}" } },
  ];
  const chain = ["t", ...middle.map((n) => n.id), "dbg"];
  const connections = chain.slice(0, -1).map((from, i) => ({ from, to: chain[i + 1], port: "" }));
  const wf = { id: "wf", name: "测试", enabled: true, nodes, connections };

  const cfg = { get: () => ({ launcherWorkflows: [wf] }) } as unknown as ConfigStore;
  const engine = new WorkflowEngine(cfg, {
    sendAssistant: () => {},
    hide: async () => {},
    showLargeType: () => {},
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

  it("收进去的路径会去重", async () => {
    const r = await runChain([
      { id: "a", type: "action.filebuffer", config: { mode: "add" } },
    ], "/x/1.txt\n/x/1.txt\n/x/2.txt");
    expect(r.feedback).toContain("2 个");
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
