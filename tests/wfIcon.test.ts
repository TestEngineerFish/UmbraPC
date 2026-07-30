// 工作流身份信息（图标 / 名字）里唯一有分支的那点逻辑。
//
// WF 上有两个图标字段：icon 是自定义图片（dataURL 或本地路径，主进程给快捷入口结果用的
// 也是它），ic 是内置线性图标的 key。hasImg 决定「这条工作流该画图片还是画线性图标」，
// 判错的两个方向都很难看：把 emoji / 内置 key 当图片走 <img> 会渲染成红叉，
// 把真图片当 key 走 WF_ICON_MAP 又会静默退化成默认的流程图标。
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", { umbraLauncher: {} });
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const { hasImg, WF_ICONS } = await import("../src/features/launcher/WorkflowEditor");

describe("hasImg", () => {
  it.each([
    "data:image/png;base64,iVBORw0KGgo=",
    "/Users/sam/Pictures/a.png",
    "./icon.png",
    "C:/Users/sam/a.png",
    "file:///tmp/a.png",
  ])("%s 是图片", (v) => expect(hasImg(v)).toBe(true));

  // 内置 key、旧数据里的 emoji、空值都不是图片。
  // emoji 这一条特别重要：第一版头部是个 maxLength=2 的 emoji 输入框，
  // 老工作流的 icon 里存的就是 "🧩" 这种，绝不能被当成路径塞进 <img>。
  it.each(["", undefined, null, "script", "folder", "🧩", "🚀", "工作流"])(
    "%s 不是图片",
    (v) => expect(hasImg(v as string | undefined)).toBe(false),
  );
});

describe("WF_ICONS", () => {
  it("key 不重复 —— 重了的话图标网格里会有两格同时高亮", () => {
    const keys = WF_ICONS.map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // 弹窗里的网格是一行 12 个 26px 方块（含 4px 间隙）塞在 460px 弹窗里，
  // 数量再涨就会换行 —— 换行本身没坏处，但这条测试是提醒改了数量记得看一眼排版。
  it("有 12 个内置图标，每个都带组件", () => {
    expect(WF_ICONS).toHaveLength(12);
    for (const { key, Icon } of WF_ICONS) {
      expect(key).toMatch(/^[a-z]+$/);
      expect(typeof Icon).toBe("function");
    }
  });
});
