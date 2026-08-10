// 节点卡片摘要：对象库里 55 种节点逐个跑一遍。
// 这份测试的真正价值是**防漏**——新加一个对象却忘了补摘要时，它会落到兜底分支，
// 卡片上只剩一个类型名，肉眼很难发现；这里直接判死。
import { describe, expect, it, vi } from "vitest";
import { displayAccel } from "../src/components/hotkey";

// WorkflowEditor 顶层要读 window.umbraLauncher（拿 IPC 桥）和 localStorage（记面板开合），
// node 环境里都没有。摘要函数是纯的，用不到它们，给个壳让 import 链能过。
vi.stubGlobal("window", { umbraLauncher: {} });
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const { CATALOG, nodeRows, outPorts } = await import("../src/features/launcher/WorkflowEditor");

type Cfg = Record<string, unknown>;
const rows = (type: string, config: Cfg = {}) => nodeRows({ id: "n", type, x: 0, y: 0, config } as never);
const text = (type: string, config: Cfg = {}) => rows(type, config).map((r) => `${r.k}=${r.v}`).join(" | ");

// 每种类型一份「填满了」的配置，用来验证值真的被读出来（空配置走的是占位分支）。
const DEMO: Record<string, Cfg> = {
  "trigger.keyword": { keyword: "yd", arg: "required" },
  "trigger.hotkey": { accelerator: "Command+Alt+K" },
  "trigger.universal": { accelerator: "Command+Shift+U", source: "files" },
  "input.scriptfilter": { script: "./runtime/txiki ./index.js", cwd: "~/wf" },
  "input.listfilter": { items: [{}, {}, {}], match: "contains" },
  "input.codec": { mode: "base64" },
  "utility.args": { argMode: "set", text: "{query} 后缀", vars: { a: "1", b: "2" } },
  "utility.conditional": { rules: [{ op: "contains" }, { op: "is" }] },
  "utility.transform": { target: "name", mode: "urlencode" },
  "utility.replace": { find: "a_b", to: "c-d", regex: true },
  "utility.delay": { seconds: 3, text: "稍等" },
  "utility.debug": { text: "{var:x}", clear: true },
  "utility.split": { with: "custom", custom: "||", output: "args" },
  "utility.join": { with: "tab" },
  "action.launch": { paths: ["/Applications/企业微信.app"], toggleVisibility: true },
  "action.openfile": { path: "~/Desktop/a.txt", app: "TextEdit" },
  "action.openurl": { url: "https://example.com/?q={query}" },
  "action.script": { script: "print(1)", language: "python3", onError: "branch" },
  "action.ask_assistant": { prompt: "帮我总结 {query}", show: true },
  "action.create_task": { text: "做个日报", device: "pc-1" },
  "action.device_skill": { provider: "system", skill: "write_file", device: "pc-1" },
  "output.textview": { title: "结果", append: true, markdown: true },
  "output.writefile": { path: "~/out/报告.md", ifExists: "append" },
  "utility.filter": { rules: [{ op: "contains", value: "urgent" }] },
  "utility.random": { mode: "hex", length: 12, target: "token" },
  "utility.jsonconfig": { json: '{"api":"https://x","kw":"{query}"}' },
  "action.applescript": { script: 'tell application "Finder" to activate', output: "replace" },
  "automation.shortcut": { name: "整理下载文件夹", input: false, output: "replace" },
  "automation.music": { command: "volume", volume: 30 },
  "input.dict": { hint: "查一下" },
  "input.filefilter": { keyword: "{query}", scopes: "~/Documents", kind: "image", exts: "png, jpg" },
  "utility.fileconditional": { rules: [{ op: "ext_in", value: "png" }, { op: "is_dir" }] },
  "action.reveal": { path: "~/Desktop/a.txt" },
  "action.browse": { path: "~/Projects", app: "iTerm" },
  "action.filebuffer": { mode: "list", clearAfter: false },
  "input.appsfilter": { action: "quit" },
  "output.keycombo": { accelerator: "Command+Shift+K", hideFirst: false },
  "automation.system": { command: "emptytrash" },
  "utility.dialog": { title: "要删掉吗？", buttons: ["取消", "删掉"], defaultIndex: 1 },
  "action.terminal": { command: "cd ~/Downloads && ls -la", app: "iTerm" },
  "action.websearch": { engine: "github", query: "{query} language:ts", browser: "Safari" },
  "output.speak": { text: "跑完了", voice: "Tingting", rate: 220, wait: true },
  "output.sound": { system: "Submarine" },
};

const ALL = CATALOG.flatMap((g) => g.items.map((i) => i.type));

describe("对象库覆盖", () => {
  // 曾经有七个置灰占位项（Snippet / File Action / Contact Action / External /
  // Call External Trigger / Remote / Automation Task），2026-07 一并移除，
  // 连 soon 置灰机制也撤了。现在对象库里每一项都能加到画布上。
  it("55 种节点，全部可添加", () => {
    expect(ALL.length).toBe(55);
  });

  it("没有重复的类型 —— 重复会让对象库出现两行一样的东西，且 TYPE_META 只留后一条", () => {
    expect(new Set(ALL).size).toBe(ALL.length);
  });

  it.each(ALL)("%s 的摘要成形", (type) => {
    for (const cfg of [{}, DEMO[type] || {}]) {
      const rs = rows(type, cfg);
      expect(rs.length).toBeGreaterThan(0);
      // 卡片只放得下两行，超了会把布局撑坏
      expect(rs.length).toBeLessThanOrEqual(2);
      for (const r of rs) {
        expect(r.k).toBeTruthy();
        expect(r.v).toBeTruthy();
        expect(String(r.v)).not.toMatch(/undefined|NaN|\[object/);
      }
      // 一个都不许落到兜底分支（兜底那一行的字段名是「未登记」）
      expect(rs[0].k).not.toBe("未登记");
    }
  });
});

describe("值真的读进去了（不是永远显示占位）", () => {
  it("关键词与参数", () => {
    expect(text("trigger.keyword", DEMO["trigger.keyword"])).toContain("yd");
    expect(text("trigger.keyword", DEMO["trigger.keyword"])).toContain("必填");
    expect(text("trigger.keyword")).toContain("未设");
  });

  it("自定义分隔符原样显示，输出方式跟着 output 走", () => {
    const t = text("utility.split", DEMO["utility.split"]);
    expect(t).toContain("||");
    expect(t).toContain("逐条执行下游");
  });

  it("查找替换在正则模式下换字段名", () => {
    expect(text("utility.replace", DEMO["utility.replace"])).toContain("正则=");
  });

  it("变换方式显示中文而不是 mode 的英文值", () => {
    expect(text("utility.transform", DEMO["utility.transform"])).toContain("URL 编码");
  });

  it("计数类的值算对", () => {
    expect(text("utility.args", DEMO["utility.args"])).toContain("2 个");
    expect(text("input.listfilter", DEMO["input.listfilter"])).toContain("3 项");
  });

  it("设备技能拼成 provider.skill", () => {
    expect(text("action.device_skill", DEMO["action.device_skill"])).toContain("system.write_file");
  });

  it("过滤：没配规则时说清楚是「全部放行」，不是「全拦」", () => {
    expect(text("utility.filter")).toContain("全部放行");
    expect(text("utility.filter", DEMO["utility.filter"])).toContain("1 条");
  });

  it("随机值：形状和写入位置都要说清", () => {
    const t = text("utility.random", DEMO["utility.random"]);
    expect(t).toContain("十六进制 12 位");
    expect(t).toContain("变量 token");
    expect(text("utility.random")).toContain("1 – 100");
  });

  it("文件组：范围、类型、动作都要读出来", () => {
    const ff = text("input.filefilter", DEMO["input.filefilter"]);
    expect(ff).toContain("~/Documents");
    expect(ff).toContain("png, jpg");       // 填了扩展名就优先显示扩展名，比「图片」具体
    expect(text("input.filefilter", { kind: "movie" })).toContain("视频");
    expect(text("input.filefilter")).toContain("全盘");
    expect(text("utility.fileconditional", DEMO["utility.fileconditional"])).toContain("2 个 + 否则");
    expect(text("action.browse", DEMO["action.browse"])).toContain("iTerm");
    expect(text("action.filebuffer", DEMO["action.filebuffer"])).toContain("取出全部交给下游");
    expect(text("action.filebuffer", DEMO["action.filebuffer"])).toContain("保留暂存区");
    expect(text("action.filebuffer")).toContain("收进暂存区");
  });

  it("窗口系统组：键位、命令、切换还是退出都要读出来", () => {
    expect(text("input.appsfilter", DEMO["input.appsfilter"])).toContain("退出这个应用");
    expect(text("input.appsfilter")).toContain("切换到这个应用");
    const kc = text("output.keycombo", DEMO["output.keycombo"]);
    expect(kc).toContain("Command+Shift+K");
    expect(kc).toContain("不收起面板");
    expect(text("output.keycombo")).toContain("先收起面板");
    expect(text("output.keycombo")).toContain("未录键位");
    expect(text("automation.system", DEMO["automation.system"])).toContain("清空废纸篓");
    expect(text("automation.system")).toContain("锁定屏幕");
  });

  it("macOS 专属组：名称、返回值处理、动作都要读出来", () => {
    expect(text("action.applescript", DEMO["action.applescript"])).toContain("作为参数传给下游");
    expect(text("automation.shortcut", DEMO["automation.shortcut"])).toContain("整理下载文件夹");
    expect(text("automation.shortcut", DEMO["automation.shortcut"])).toContain("不传");
    expect(text("automation.music", DEMO["automation.music"])).toContain("设置音量 30");
    expect(text("automation.music")).toContain("播放 / 暂停");
  });

  it("终端命令：要把「输出取不回来」这句写在卡片上", () => {
    const t = text("action.terminal", DEMO["action.terminal"]);
    expect(t).toContain("iTerm");
    expect(t).toContain("输出取不回来");
    expect(text("action.terminal")).toContain("Terminal");
  });

  it("网页搜索：引擎显示中文名，自定义时改显示地址", () => {
    expect(text("action.websearch", DEMO["action.websearch"])).toContain("GitHub");
    expect(text("action.websearch", DEMO["action.websearch"])).toContain("language:ts");
    expect(text("action.websearch")).toContain("Google");                 // 不配时默认 Google
    expect(text("action.websearch", { engine: "custom" })).toContain("未填地址");
    expect(text("action.websearch", { engine: "custom", custom: "https://x/?q={query}" })).toContain("https://x");
  });

  it("朗读与提示音：音色、等不等、声音来源都要读出来", () => {
    const sp = text("output.speak", DEMO["output.speak"]);
    expect(sp).toContain("Tingting");
    expect(sp).toContain("念完再往下");
    expect(text("output.speak")).toContain("系统默认");
    expect(text("output.sound", DEMO["output.sound"])).toContain("Submarine");
    expect(text("output.sound")).toContain("Glass");                       // 不配时默认 Glass
    expect(text("output.sound", { path: "~/a.wav" })).toContain("~/a.wav");
  });

  it("JSON Config：不合法的 JSON 在卡片上就说，别等运行才报错", () => {
    expect(text("utility.jsonconfig", DEMO["utility.jsonconfig"])).toContain("2 个");
    expect(text("utility.jsonconfig", { json: "{坏" })).toContain("JSON 不合法");
    expect(text("utility.jsonconfig")).toContain("未填");
  });
});

describe("排版约束", () => {
  it.each([
    ["action.openfile", "路径"],
    ["action.openurl", "网址"],
    ["trigger.hotkey", "快捷键"],
    // Run Script 的字段名就是语言名（DEMO 里选的是 Python 3），不是固定的「脚本」
    ["action.script", "Python 3"],
  ])("%s 的「%s」走等宽底框", (type, key) => {
    expect(rows(type, DEMO[type] || {}).find((r) => r.k === key)?.mono).toBe(true);
  });

  it("超长值截断并加省略号，不把卡片撑爆", () => {
    const v = rows("action.openurl", { url: "https://example.com/" + "a".repeat(200) })
      .find((r) => r.k === "网址")!.v;
    expect(v.length).toBeLessThanOrEqual(40);
    expect(v.endsWith("…")).toBe(true);
  });
});

// 这一批是对着 Alfred 官方文档逐个对照后补上的差异修复，摘要要能看出新配置生效了。
describe("对照 Alfred 文档补的配置项，卡片上要看得见", () => {
  it("关键词：关掉「要有空格」时卡片要标出来，不然只能靠试", () => {
    expect(text("trigger.keyword", { keyword: "cal", arg: "optional", withSpace: false })).toContain("紧贴关键词");
    expect(text("trigger.keyword", { keyword: "cal", arg: "optional" })).not.toContain("紧贴");
    // 「不带参数」时空格开关没有意义，不该冒出来
    expect(text("trigger.keyword", { keyword: "cal", arg: "none", withSpace: false })).not.toContain("紧贴");
  });

  it("Run Script：字段名就是语言，一眼看出这段代码会被谁执行", () => {
    expect(text("action.script", { script: "print(1)", language: "python3" })).toContain("Python 3");
    expect(text("action.script", { script: "ls" })).toContain("bash");   // 不配时默认 bash
  });

  it("Script Filter：自带关键词时第一行就是关键词 —— 它自己就是触发器", () => {
    expect(text("input.scriptfilter", { keyword: "yd", script: "x" })).toContain("yd");
    // 没自带关键词的（靠上游触发器带进来）就先亮脚本
    expect(text("input.scriptfilter", { script: "translate.py" })).toContain("translate.py");
  });

  it("Script Filter：非默认语言要亮在卡片上 —— 拿 bash 去跑 python 是最难查的一类错", () => {
    expect(text("input.scriptfilter", { script: "x", lang: "python3", cwd: "~/a" })).toContain("python3");
    // 默认 bash 时不占那一行，让位给更有信息量的东西
    expect(text("input.scriptfilter", { script: "x", cwd: "~/a" })).toContain("~/a");
  });

  it("Script Filter：由谁过滤、用哪种匹配方式，卡片上看得见", () => {
    const t = text("input.scriptfilter", { script: "x", alfredFilters: true, matchMode: "words-any" });
    expect(t).toContain("Umbra");
    expect(t).toContain("不计顺序");
  });

  it("系统命令：有没有确认框要写在卡片上 —— 这是不可逆操作的唯一护栏", () => {
    expect(text("automation.system", { command: "logout", confirm: true })).toContain("弹确认框");
    expect(text("automation.system", { command: "logout" })).toContain("直接执行");
  });

  it("系统通知：标题正文都能配，空正文默认跳过", () => {
    const t = text("output.notify", { title: "构建完成", text: "{query}" });
    expect(t).toContain("构建完成");
    expect(t).toContain("空则跳过");
    expect(text("output.notify", { ifEmpty: "show" })).toContain("空也弹");
    expect(text("output.notify")).toContain("用工作流名");
  });

  it("发送按键：连按次数要显示，一次时不显示（省得每张卡片都挂个 ×1）", () => {
    expect(text("output.keycombo", { accelerator: "Tab", repeat: 3 })).toContain("×3");
    expect(text("output.keycombo", { accelerator: "Tab" })).not.toContain("×");
  });

  it("打开网址：指定了浏览器就显示浏览器名", () => {
    expect(text("action.openurl", { url: "https://x", browser: "Safari" })).toContain("Safari");
    expect(text("action.openurl", { url: "https://x" })).toContain("默认浏览器");
  });

  it("快捷指令：不等它跑完要标出来；但选了取返回值时这个标记不该出现", () => {
    expect(text("automation.shortcut", { name: "整理", wait: false })).toContain("不等它跑完");
    expect(text("automation.shortcut", { name: "整理", wait: false, output: "replace" })).not.toContain("不等");
  });

  it("写文件：四种已存在策略都要有中文名，不能露出英文值", () => {
    expect(text("output.writefile", { path: "a.md", ifExists: "prepend" })).toContain("插到开头");
    expect(text("output.writefile", { path: "a.md", ifExists: "unique" })).toContain("另存新名");
    expect(text("output.writefile", { path: "a.md" })).toContain("覆盖");
  });

  it("变换：Base64 的字段值原来会露出英文 mode 值，这里锁住", () => {
    expect(text("utility.transform", { mode: "base64encode" })).toContain("Base64 编码");
    expect(text("utility.transform", { mode: "reverse" })).toContain("反转字符串");
    expect(text("utility.transform", { mode: "alnum" })).toContain("只留字母数字");
  });

  it("随机值：列表模式要报出有几项", () => {
    expect(text("utility.random", { mode: "list", list: "面\n饭\n沙拉" })).toContain("3 项");
  });

  it("JSON Config：包裹写法能改参数和下游配置，这两件事比「设了几个变量」重要", () => {
    const wrapped = { json: '{"alfredworkflow":{"arg":"x","variables":{"a":"1"},"config":{"url":"https://y"}}}' };
    const t = text("utility.jsonconfig", wrapped);
    expect(t).toContain("改参数");
    expect(t).toContain("改下游配置");
    expect(t).toContain("1 个");        // variables 里的数量，不是最外层的键数
  });
});

// 出口命名：条件类节点的每条规则可以给自己的出口起名，名字直接显示在画布上的端口边。
// 这块的价值全在「名字有没有真的透到画布」和「没起名时退回什么」，所以两头都测。
describe("出口命名", () => {
  const cond = (rules: unknown[], type = "utility.conditional") =>
    outPorts({ id: "n", type, x: 0, y: 0, config: { rules } } as never);

  it("没起名时退回「规则N」，序号从 1 开始", () => {
    expect(cond([{}, {}]).map((p) => p.label)).toEqual(["规则1", "规则2", "否则"]);
  });

  it("起了名就用名字 —— 这是它存在的全部意义", () => {
    expect(cond([{ label: "打开网址" }, { label: "查快递" }]).map((p) => p.label))
      .toEqual(["打开网址", "查快递", "否则"]);
  });

  it("端口标识符不受名字影响 —— 改个名不能把已经连好的线弄断", () => {
    expect(cond([{ label: "甲" }, { label: "乙" }]).map((p) => p.port)).toEqual(["r0", "r1", "else"]);
    expect(cond([{}, {}]).map((p) => p.port)).toEqual(["r0", "r1", "else"]);
  });

  it("名字只填了空白等于没填", () => {
    expect(cond([{ label: "   " }]).map((p) => p.label)).toEqual(["规则1", "否则"]);
  });

  it("文件条件走同一套", () => {
    expect(cond([{ label: "图片" }], "utility.fileconditional").map((p) => p.label)).toEqual(["图片", "否则"]);
  });

  it("一条规则都没有时只剩「否则」", () => {
    expect(cond([]).map((p) => p.port)).toEqual(["else"]);
  });

  it("过滤节点没有多出口 —— 它只有放行/不放行，不该冒出「否则」", () => {
    expect(outPorts({ id: "n", type: "utility.filter", x: 0, y: 0, config: { rules: [{}, {}] } } as never).length).toBe(1);
  });
});

describe("出口名要透到节点卡片上", () => {
  it("全都起了名就把名字列出来，不点开弹窗也知道在分什么", () => {
    expect(text("utility.conditional", { rules: [{ label: "网址" }, { label: "快递" }] }))
      .toContain("网址 / 快递 / 否则");
  });

  it("只有一部分起了名就退回计数 —— 半截名字比计数更让人困惑", () => {
    expect(text("utility.conditional", { rules: [{ label: "网址" }, {}] })).toContain("2 个 + 否则");
  });

  it("名字太长放不下也退回计数，别把卡片撑破", () => {
    const long = [{ label: "这是一个特别长的出口名字" }, { label: "另一个同样很长的名字" }];
    expect(text("utility.conditional", { rules: long })).toContain("2 个 + 否则");
  });

  it("没有规则时说清楚只剩「否则」", () => {
    expect(text("utility.conditional")).toContain("只有「否则」");
    expect(text("utility.fileconditional")).toContain("只有「否则」");
  });
});

describe("对话框的卡片摘要", () => {
  it("按钮列出来，并且说清有几个出口 —— 出口数量是接线时最需要先知道的", () => {
    const t = text("utility.dialog", { title: "要删掉吗？", buttons: ["取消", "删掉"] });
    expect(t).toContain("要删掉吗？");
    expect(t).toContain("取消 / 删掉");
    expect(t).toContain("2 个出口");
  });

  it("不配按钮时显示默认的那两个，不是「未设」", () => {
    expect(text("utility.dialog")).toContain("取消 / 确定");
  });

  it("没填问句时说清楚", () => {
    expect(text("utility.dialog", { buttons: ["好"] })).toContain("未填问句");
  });
});

// ── Hotkey 的两种动作 ───────────────────────────────────────────────────────
//
// 2026-08-10：Hotkey 接 Script Filter，按下去毫无反应。
// 原因是这个节点只实现了 Alfred 的「Pass through to workflow」——
// 一次性把参数灌给下游就跑完。而 Script Filter 要的是「用户边打边查」，
// 对着一个等你打字的节点灌参数，表现就是什么都不发生。
// Alfred 的另一档叫 Show Alfred：把搜索框叫出来、预填好，剩下交给关键词匹配。
describe("Hotkey：按下之后干什么，卡片上要一眼看得出", () => {
  it("默认是「直接跑」，并标出参数取自哪里", () => {
    const t = text("trigger.hotkey", { accelerator: "Alt+Space" });
    expect(t).toContain("直接跑");
    expect(t).toContain("剪贴板");   // 老节点没有 argSource 字段，缺省就是剪贴板
  });

  it("选了「打开快捷入口」就显示它 —— 这是接 Script Filter 时唯一能用的模式", () => {
    expect(text("trigger.hotkey", { accelerator: "Alt+Space", action: "show" })).toContain("打开快捷入口");
  });

  it("填了预填前缀就一并显示", () => {
    expect(text("trigger.hotkey", { accelerator: "Alt+Space", action: "show", prefix: "yd " })).toContain("yd");
  });

  it("参数来源逐个都有中文名，不许漏出英文 id", () => {
    for (const [src, want] of [["selection", "选区"], ["text", "固定文本"], ["none", "无"]] as const) {
      expect(text("trigger.hotkey", { accelerator: "Alt+Space", argSource: src }), src).toContain(want);
    }
  });

  it("快捷键走 displayAccel 显示 —— Mac 上要出 ⌥Space，不能是 Alt+Space", () => {
    // 断言「和 displayAccel 的输出一致」而不是写死某个平台的样子：
    // 这个测试在 node 里跑（认不出 Mac），写死 ⌥ 会在 CI 上假红。
    expect(text("trigger.hotkey", { accelerator: "Alt+Space" })).toContain(displayAccel("Alt+Space"));
  });
});
