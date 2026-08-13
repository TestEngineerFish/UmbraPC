// 滚动长截图拼接内核的单测。这块是「看着没问题、实际结果不对」的典型：
// 少拼一段、多拼一段肉眼都很难第一时间发现，所以用「造一张虚拟长页面 → 按不同滚动方式喂帧
// → 拼出来的图必须和原页面逐字节相同」来钉死行为。
import { describe, it, expect } from "vitest";
import { BYTES_PER_PIXEL, ScrollStitcher, matchProbe, probeRowsFor, rowKeys } from "../electron/core/screenshot/scroll";

const WIDTH = 8; // 测试用的窄画面，一行 8 像素足够产生不同的行签名

/** 造一张「每行内容都不同」的虚拟长页面（BGRA），行号写进像素里便于比对。 */
function makePage(height: number, width = WIDTH, seed = 0): Uint8Array {
  const buf = new Uint8Array(width * height * BYTES_PER_PIXEL);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * BYTES_PER_PIXEL;
      buf[i] = (y + seed) & 0xff;
      buf[i + 1] = (y * 7 + x + seed) & 0xff;
      buf[i + 2] = (y * 13 + seed) & 0xff;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

/** 从长页面里裁出一屏（从第 offset 行起，共 height 行）。 */
function viewport(page: Uint8Array, offset: number, height: number, width = WIDTH): Uint8Array {
  const stride = width * BYTES_PER_PIXEL;
  return page.slice(offset * stride, (offset + height) * stride);
}

describe("rowKeys", () => {
  it("同一行内容相同则签名相同，不同则不同", () => {
    const page = makePage(4);
    const keys = rowKeys(page, WIDTH, 4);
    expect(new Set(keys).size).toBe(4); // 四行互不相同
    const again = rowKeys(page.slice(), WIDTH, 4);
    expect(Array.from(again)).toEqual(Array.from(keys));
  });
});

describe("matchProbe", () => {
  it("找到探针在新帧里的落点", () => {
    const page = makePage(40);
    const prev = rowKeys(viewport(page, 0, 10), WIDTH, 10);
    const next = rowKeys(viewport(page, 6, 10), WIDTH, 10);
    // 探针 = prev 底部 probe 行（页面第 10-probe … 9 行），在 next 里应落在 (10-probe)-6 处
    const probe = probeRowsFor(10);
    expect(matchProbe(prev, next, probe)).toBe(10 - probe - 6);
  });

  it("画面完全没动时落点就在原位", () => {
    const page = makePage(40);
    const keys = rowKeys(viewport(page, 3, 10), WIDTH, 10);
    const probe = probeRowsFor(10);
    expect(matchProbe(keys, rowKeys(viewport(page, 3, 10), WIDTH, 10), probe)).toBe(10 - probe);
  });

  it("内容整个换掉就找不到落点", () => {
    const a = rowKeys(makePage(10), WIDTH, 10);
    const b = rowKeys(makePage(10, WIDTH, 200), WIDTH, 10);
    expect(matchProbe(a, b, probeRowsFor(10))).toBe(-1);
  });

  it("有多处可匹配时取最靠下的那个（宁可少拼也不重复拼）", () => {
    // prev 底部探针是 [1,2]；next 里 [1,2] 出现两次，应取靠下的 index 2 而不是 0
    const prev = Uint32Array.from([9, 9, 1, 2]);
    const next = Uint32Array.from([1, 2, 1, 2]);
    expect(matchProbe(prev, next, 2)).toBe(2);
  });
});

describe("ScrollStitcher", () => {
  it("逐屏滚到底后拼出的长图与原页面逐字节相同", () => {
    const H = 20; // 一屏 20 行，探针 8 行 → 每次最多能滚 12 行
    const page = makePage(100);
    const st = new ScrollStitcher(WIDTH, H);
    for (let off = 0; off <= 77; off += 7) st.push(viewport(page, off, H)); // 每次滚 7 行
    st.push(viewport(page, 80, H)); // 滚到底（页面只剩 80 行可视位）
    expect(st.push(viewport(page, 80, H)).status).toBe("same"); // 到底后再抓：没有新内容
    const out = st.result();
    expect(out.height).toBe(100);
    expect(Array.from(out.data)).toEqual(Array.from(page));
    expect(st.gaps).toBe(0);
  });

  it("画面没动时不追加内容", () => {
    const page = makePage(60);
    const st = new ScrollStitcher(WIDTH, 20);
    expect(st.push(viewport(page, 0, 20)).status).toBe("first");
    const r = st.push(viewport(page, 0, 20));
    expect(r.status).toBe("same");
    expect(r.added).toBe(0);
    expect(st.rows).toBe(20);
  });

  it("滚过头先按失配丢帧，连续超过宽容次数才硬接并记断层", () => {
    const page = makePage(400);
    const st = new ScrollStitcher(WIDTH, 20, { missTolerance: 3 });
    st.push(viewport(page, 0, 20));
    expect(st.push(viewport(page, 200, 20)).status).toBe("miss");
    expect(st.push(viewport(page, 220, 20)).status).toBe("miss");
    const third = st.push(viewport(page, 240, 20));
    expect(third.status).toBe("gap");
    expect(third.added).toBe(20);
    expect(st.gaps).toBe(1);
    expect(st.rows).toBe(40);
  });

  it("甩过头之后画面停住，能重新咬合上（宽容次数内不会白丢内容）", () => {
    const page = makePage(200);
    const st = new ScrollStitcher(WIDTH, 20, { missTolerance: 5 });
    st.push(viewport(page, 0, 20));
    expect(st.push(viewport(page, 120, 20)).status).toBe("miss"); // 甩动中的一帧，对不上
    const back = st.push(viewport(page, 8, 20)); // 停住后落在合理位置
    expect(back.status).toBe("appended");
    expect(back.added).toBe(8);
    expect(st.gaps).toBe(0);
  });

  it("顶到行数上限就不再增长，并把 full 置起来", () => {
    const page = makePage(200);
    const st = new ScrollStitcher(WIDTH, 20, { maxRows: 30 });
    st.push(viewport(page, 0, 20));
    st.push(viewport(page, 10, 20)); // 本该追加 10 行，只收得下 10 行里的前 10 行 → 正好顶满
    expect(st.rows).toBe(30);
    expect(st.full).toBe(true);
    st.push(viewport(page, 20, 20));
    expect(st.rows).toBe(30);
  });

  it("帧尺寸对不上直接抛错（抓帧参数错了要立刻暴露）", () => {
    const st = new ScrollStitcher(WIDTH, 20);
    expect(() => st.push(new Uint8Array(10))).toThrow();
  });

  it("一帧都没喂时结果是空图", () => {
    const st = new ScrollStitcher(WIDTH, 20);
    const out = st.result();
    expect(out.height).toBe(0);
    expect(out.data.length).toBe(0);
  });
});

describe("probeRowsFor", () => {
  it("按帧高取比例并夹在上下限内，且不吃掉匹配窗口", () => {
    expect(probeRowsFor(1000)).toBe(200); // 正常一屏：取 20%
    expect(probeRowsFor(2000)).toBe(240); // 撞 PROBE_MAX
    expect(probeRowsFor(50)).toBe(20); // 想要 24 但 40% 只有 20，以 40% 为准
    expect(probeRowsFor(10)).toBe(4); // 极矮帧：仍留出 60% 的匹配窗口
  });
});
