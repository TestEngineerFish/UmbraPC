// 节点配置弹窗的两处「不测就一定会漏」的逻辑。
//
// 1. 副标题防漏：新加一个节点却忘了写副标题时，弹窗头部会变成「分类 · 类型名」，
//    看起来像正常的，肉眼很难发现 —— 和节点卡片摘要那套防漏是同一个道理。
// 2. 未保存判定：它决定「点遮罩会不会丢改动」。判错的两个方向都很难受 ——
//    判宽了每次关闭都弹一次确认，判窄了改动静默丢失。
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", { umbraLauncher: {} });
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const { CATALOG, NODE_SUB, KIND_LABEL, DLG_WIDTH } = await import("../src/features/launcher/WorkflowEditor");
const { sameConfig, dragTarget, reorder } = await import("../src/features/launcher/nodeform");

const ALL = CATALOG.flatMap((g) => g.items.map((i) => i.type));

describe("弹窗副标题", () => {
  it.each(ALL)("%s 有副标题", (type) => {
    expect(NODE_SUB[type]).toBeTruthy();
  });

  it("副标题不能只是把标题换个说法 —— 要说它干什么，且一行放得下", () => {
    for (const type of ALL) {
      const sub = NODE_SUB[type];
      expect(sub.length).toBeLessThanOrEqual(28);   // 再长就被省略号截掉了
      expect(sub).not.toContain("\n");
    }
  });

  it("每个分类前缀都有中文名", () => {
    for (const type of ALL) expect(KIND_LABEL[type.split(".")[0]]).toBeTruthy();
  });

  it("没有多余的副标题（删了节点却留着文案）", () => {
    for (const k of Object.keys(NODE_SUB)) expect(ALL).toContain(k);
  });

  it("宽度表里的键都是真的节点类型，值只有三档", () => {
    for (const [k, v] of Object.entries(DLG_WIDTH)) {
      expect(ALL).toContain(k);
      expect(["sm", "md", "lg"]).toContain(v);
    }
  });
});

describe("未保存判定", () => {
  it("一模一样 = 没改动", () => {
    expect(sameConfig({ a: "1", b: 2 }, { a: "1", b: 2 })).toBe(true);
  });

  it("键序不同不算改动 —— 否则点开又关上都会弹一次确认", () => {
    expect(sameConfig({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
  });

  it("值变了算改动", () => {
    expect(sameConfig({ a: "1" }, { a: "2" })).toBe(false);
  });

  it("多一个键、少一个键都算改动", () => {
    expect(sameConfig({ a: "1" }, { a: "1", b: "x" })).toBe(false);
    expect(sameConfig({ a: "1", b: "x" }, { a: "1" })).toBe(false);
  });

  it("undefined 和「没这个键」等价 —— 表单把字段清空后常留下 undefined", () => {
    expect(sameConfig({ a: "1", b: undefined }, { a: "1" })).toBe(true);
  });

  it("嵌套的数组/对象按内容比，不按引用", () => {
    expect(sameConfig({ r: [{ op: "is" }] }, { r: [{ op: "is" }] })).toBe(true);
    expect(sameConfig({ r: [{ op: "is" }] }, { r: [{ op: "contains" }] })).toBe(false);
  });

  it("false / 0 / 空串不能被当成「没值」", () => {
    expect(sameConfig({ a: false }, {})).toBe(false);
    expect(sameConfig({ a: 0 }, {})).toBe(false);
    expect(sameConfig({ a: "" }, {})).toBe(false);
  });
});

describe("表格行拖拽换位", () => {
  it("拖到自己身上不动", () => {
    expect(dragTarget(2, 2, true)).toBeNull();
    expect(dragTarget(2, 2, false)).toBeNull();
  });

  it("往下拖：过了目标行中线才换，否则会来回横跳", () => {
    expect(dragTarget(0, 3, false)).toBeNull();   // 刚进入第 3 行，还没过中线
    expect(dragTarget(0, 3, true)).toBe(3);
  });

  it("往上拖：还没过中线就换，过了反而不动（方向相反）", () => {
    expect(dragTarget(3, 0, true)).toBeNull();
    expect(dragTarget(3, 0, false)).toBe(0);
  });

  it("换位是「挪过去」不是「两两交换」—— 交换会把中间的顺序全打乱", () => {
    expect(reorder(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(reorder(["a", "b", "c", "d"], 0, 3)).toEqual(["b", "c", "d", "a"]);
    expect(reorder(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  });

  it("挪动不改变元素个数，也不丢元素", () => {
    const src = ["a", "b", "c", "d", "e"];
    for (let f = 0; f < src.length; f++) {
      for (let t = 0; t < src.length; t++) {
        const out = reorder(src, f, t);
        expect(out.length).toBe(src.length);
        expect([...out].sort()).toEqual([...src].sort());
      }
    }
  });

  it("一路往下拖能真的走到底 —— 每一步的落点接着当上一步的起点", () => {
    // 模拟把第 0 行一路拖到最后：每次 onChange 之后 from 变成 to，下一次从那里继续
    let rows = ["a", "b", "c", "d"];
    let f = 0;
    for (let i = 1; i < rows.length; i++) {
      const to = dragTarget(f, i, true);
      expect(to).toBe(i);
      rows = reorder(rows, f, to!);
      f = to!;
    }
    expect(rows).toEqual(["b", "c", "d", "a"]);
  });
});
