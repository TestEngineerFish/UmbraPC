// 截图工具条图标的一条「不测就一定会再犯」的规则。
//
// ScreenshotApp 里的 Ic 组件是把 d 字符串按 "|" 拆成一个个**独立的** <path>，每段各自成 d。
// SVG 规定 d 必须以 moveto（M/m）起笔，否则整段是非法路径 —— 浏览器**静默不画**，
// 不报错、不警告、控制台干净。箭头图标就这么错了很久：写成 "M6 18L18 6|10 6h8v8"，
// 第二段（箭头那两笔）缺 M，于是工具条上只剩一根没头的斜杆，看着像「线段」工具。
//
// 这种错误肉眼极难发现（图标本来就小，少两笔不刺眼），所以用文本规则钉住：
// 直接扫源码里所有 <Ic d="…" /> 字面量，每一段都必须以 M/m 开头。
// 不导出 d 表来测，是因为一旦为了测试把常量导出去，下一个人照样可以在 JSX 里
// 内联一个新的 <Ic d="…"/> 绕过它 —— 扫源码才真的拦得住所有写法。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/features/screenshot/ScreenshotApp.tsx", import.meta.url));
const src = readFileSync(SRC, "utf8");

// 抓 <Ic d="…"，允许 d 之后还有别的属性（比如 fill）
const uses = [...src.matchAll(/<Ic\s+d="([^"]+)"/g)].map((m) => m[1]);

describe("Ic 图标的 d 字符串", () => {
  it("确实抓到了图标（正则失效时这条会先红，而不是让下面的断言空跑通过）", () => {
    expect(uses.length).toBeGreaterThanOrEqual(7);
  });

  it.each(uses)('"%s" 的每一段都以 moveto 起笔', (d) => {
    for (const seg of d.split("|")) {
      expect(seg.trim()).toMatch(/^[Mm]/);
    }
  });

  it("箭头图标必须是两段：斜杆 + 箭头（只剩一段就是那个老 bug 又回来了）", () => {
    const arrow = /arrow:\s*<Ic\s+d="([^"]+)"/.exec(src)?.[1];
    expect(arrow).toBeTruthy();
    expect(arrow!.split("|")).toHaveLength(2);
  });
});
