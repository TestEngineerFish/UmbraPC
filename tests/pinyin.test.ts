// 拼音搜索：候选串是否正确、会不会互相误伤、展开数有没有失控。
// 多音字是这块唯一的难点，用例基本都围着它转。
import { describe, expect, it } from "vitest";
import { hasHan, pinyinFull, pinyinFullVariants, pinyinInitials, pinyinVariants, withPinyin } from "../electron/core/launcher/pinyin";
import { anyStrongMatch, bestMatch } from "../electron/core/launcher/rank";

describe("拼音首字母", () => {
  it("逐字取主读音", () => {
    expect(pinyinInitials("企业微信")).toBe("qywx");
    expect(pinyinInitials("Umbra 助手")).toBe("umbra zs");
  });

  it("非汉字原样保留，中英混排不被切断", () => {
    expect(pinyinInitials("QQ音乐")).toBe("qqyl");
  });

  it("纯英文不生成别名（省得每个应用都多一条噪音）", () => {
    expect(hasHan("SourceTree")).toBe(false);
    expect(withPinyin(["SourceTree"])).toEqual(["SourceTree"]);
  });

  it("多音字展开成多条候选，用户想打的那条要在里面", () => {
    // 「乐」单字最常见读音是 lè，但「音乐」里是 yuè —— 用户打的是 wyyyy
    expect(pinyinVariants("网易云音乐")).toEqual(["wyyyl", "wyyyy"]);
    // 「厦」单字是 shà，「厦门」是 xià
    expect(pinyinVariants("厦门航空")).toEqual(["smhk", "xmhk"]);
  });

  it("单音字不展开，别白白多出候选", () => {
    expect(pinyinVariants("钉钉")).toEqual(["dd"]);
  });

  it("展开数封顶，长名字不会炸开", () => {
    expect(pinyinVariants("重庆银行有道词典百度网盘").length).toBeLessThanOrEqual(8);
  });

  it("原名 + 首字母候选 + 全拼候选一起返回，去重", () => {
    expect(withPinyin(["微信", "微信"])).toEqual(["微信", "wx", "ws", "weixin", "weishen"]);
  });
});

describe("全拼", () => {
  it("逐字拼成连写", () => {
    expect(pinyinFull("企业微信")).toBe("qiyeweixin");
    expect(pinyinFull("钉钉")).toBe("dingding");
  });

  it("多音字同样展开候选", () => {
    expect(pinyinFullVariants("网易云音乐")).toEqual(["wangyiyunyinle", "wangyiyunyinyue"]);
  });

  it("中英混排不被切断", () => {
    expect(pinyinFull("QQ音乐")).toBe("qqyinle");
  });
});

describe("拼音接进匹配之后", () => {
  const wecom = withPinyin(["企业微信", "WeCom", "WeWorkMac"]);
  const music = withPinyin(["网易云音乐"]);

  it.each(["qywx", "qy", "qiye", "qiyeweixin", "wecom", "we", "企业", "微信"])("企业微信 能被「%s」搜到", (q) => {
    expect(anyStrongMatch(q, wecom)).toBe(true);
    expect(bestMatch(q, wecom)).toBeGreaterThan(0);
  });

  it.each(["wyyyy", "wyyyl", "wy", "wangyi", "wangyiyunyinyue", "音乐"])("网易云音乐 能被「%s」搜到", (q) => {
    expect(anyStrongMatch(q, music)).toBe(true);
  });

  it("拼音别名不会让两个应用互相蹭上", () => {
    expect(anyStrongMatch("wyyyy", wecom)).toBe(false);
    expect(anyStrongMatch("qywx", music)).toBe(false);
  });

  it("加了拼音之后英文匹配没有退化", () => {
    const st = withPinyin(["SourceTree"]);
    expect(bestMatch("st", st)).toBeGreaterThan(bestMatch("st", music));
  });
});
