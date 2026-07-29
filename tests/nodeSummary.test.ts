// 节点卡片摘要：对象库里 62 种节点逐个跑一遍。
// 这份测试的真正价值是**防漏**——新加一个对象却忘了补摘要时，它会落到兜底分支，
// 卡片上只剩一个类型名，肉眼很难发现；这里直接判死。
import { describe, expect, it, vi } from "vitest";

// WorkflowEditor 顶层要读 window.umbraLauncher（拿 IPC 桥）和 localStorage（记面板开合），
// node 环境里都没有。摘要函数是纯的，用不到它们，给个壳让 import 链能过。
vi.stubGlobal("window", { umbraLauncher: {} });
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const { CATALOG, nodeRows } = await import("../src/features/launcher/WorkflowEditor");

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
  "action.script": { script: 'say "$1"', onError: "branch" },
  "action.ask_assistant": { prompt: "帮我总结 {query}", show: true },
  "action.create_task": { text: "做个日报", device: "pc-1" },
  "action.device_skill": { provider: "system", skill: "write_file", device: "pc-1" },
  "output.textview": { title: "结果", append: true, markdown: true },
  "output.writefile": { path: "~/out/报告.md", ifExists: "append" },
};

const ALL = CATALOG.flatMap((g) => g.items.map((i) => ({ type: i.type, soon: !!i.soon })));

describe("对象库覆盖", () => {
  it("62 种节点，30 种置灰、32 种可添加", () => {
    expect(ALL.length).toBe(62);
    expect(ALL.filter((x) => x.soon).length).toBe(30);
  });

  it.each(ALL.map((x) => [x.type, x.soon] as [string, boolean]))("%s 的摘要成形", (type, soon) => {
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
      // 可添加的类型不许落到兜底分支（兜底那一行的字段名是「未登记」）
      if (!soon) expect(rs[0].k).not.toBe("未登记");
      // 置灰的类型统一走「暂未实现」
      else expect(rs[0].k).toBe("状态");
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
});

describe("排版约束", () => {
  it.each([
    ["action.openfile", "路径"],
    ["action.openurl", "网址"],
    ["trigger.hotkey", "快捷键"],
    ["action.script", "脚本"],
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
