// 运行时探测的 **IO 层**冒烟测试：拿这台机器上真实存在的 python3 走一遍完整流程。
//
// 为什么值得单独测：parse.ts 的测试用的是我手抄的样本，样本抄错了测试照样绿。
// 这里跑的是**真命令的真输出** —— 它能抓住「样本和现实不一样」这类错误，
// 也能验证 whichAll / realpath 去重 / partial 收集这些纯 IO 逻辑真的能跑通。
//
// scan.ts 刻意不 import electron（只有 index.ts 那层才碰 ipcMain），所以在 vitest 里能直接跑。
// 这个约束本身也值得钉住 —— 见最后一条测试。
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { scanRuntime, whichAll } from "../electron/core/runtime/scan";
import { parseVersion } from "../electron/core/runtime/parse";

/** 这台机器上到底有没有 python3。没有就跳过依赖它的用例，而不是让测试红。 */
function realPython(): string {
  try {
    return execFileSync("python3", ["-V"], { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
  } catch { return ""; }
}
const PY_OUT = realPython();
const hasPy = PY_OUT.length > 0;

describe("whichAll", () => {
  it("能找到真实存在的命令，且返回的是绝对路径", () => {
    const hits = whichAll("sh");
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.startsWith("/")).toBe(true);
  });

  it("不存在的命令返回空数组（不是抛异常）", () => {
    expect(whichAll("umbra-definitely-not-a-real-command-9f3a")).toEqual([]);
  });

  // 现有的 which() 找到第一个就 return，这一层存在的全部理由就是「列出**所有**」——
  // 它是发现「PATH 上有三个 python3 在打架」的唯一手段。
  it("PATH 里有重复目录时同一个文件不会报两遍", () => {
    const dir = "/bin";
    const hits = whichAll("sh", `${dir}:${dir}:${dir}`);
    expect(hits).toEqual([...new Set(hits)]);
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it("按 PATH 顺序返回（第一个就是实际生效的那个）", () => {
    const hits = whichAll("sh", "/nonexistent:/bin:/usr/bin");
    if (hits.length > 1) expect(hits[0]).toBe("/bin/sh");
  });
});

describe("parseVersion 对真实输出", () => {
  it.runIf(hasPy)("认得出这台机器上 python3 -V 的真实输出", () => {
    const v = parseVersion(PY_OUT);
    // 只断言形状，不断言具体版本 —— 容器里的 Python 会随基础镜像变
    expect(v).toMatch(/^\d+\.\d+/);
    // 而且必须真的是从输出里抠的，不是碰巧
    expect(PY_OUT).toContain(v.split(".").slice(0, 2).join("."));
  });
});

describe("scanRuntime('python')", () => {
  it.runIf(hasPy)("跑通完整流程，并且找到至少一个 Python", async () => {
    const scan = await scanRuntime("python");
    expect(scan.kind).toBe("python");
    expect(scan.installs.length).toBeGreaterThan(0);
    expect(scan.elapsedMs).toBeGreaterThanOrEqual(0);
  }, 30000);

  it.runIf(hasPy)("每条 install 的字段都填了，版本号形状对", async () => {
    const scan = await scanRuntime("python");
    for (const i of scan.installs) {
      expect(i.id).toMatch(/^python-/);
      expect(i.version).toMatch(/^\d+\.\d+/);   // 绝不能出现空版本或伪造的 0.0.0
      expect(i.bin.startsWith("/")).toBe(true);
      expect(i.source.length).toBeGreaterThan(0);
    }
  }, 30000);

  // 去重是靠 realpath 的。容器里 /usr/bin/python3 通常是指向 python3.x 的符号链接，
  // 而 /usr/local/bin 里可能还有一个 —— 正好能验证「同一个物理文件只出现一次」。
  it.runIf(hasPy)("同一个物理安装只出现一次（realpath 去重真的生效）", async () => {
    const scan = await scanRuntime("python");
    const bins = scan.installs.map((i) => i.bin);
    expect(bins).toEqual([...new Set(bins)]);
    const ids = scan.installs.map((i) => i.id);
    expect(ids).toEqual([...new Set(ids)]);
  }, 30000);

  it.runIf(hasPy)("版本按降序排列", async () => {
    const scan = await scanRuntime("python");
    const nums = scan.installs.map((i) => i.version.split(".").map(Number));
    for (let k = 1; k < nums.length; k++) {
      const a = nums[k - 1], b = nums[k];
      const cmp = (a[0] || 0) - (b[0] || 0) || (a[1] || 0) - (b[1] || 0) || (a[2] || 0) - (b[2] || 0);
      expect(cmp).toBeGreaterThanOrEqual(0);
    }
  }, 30000);

  it.runIf(hasPy)("「当前生效」有一条，且带上了「为什么是它」", async () => {
    const scan = await scanRuntime("python");
    expect(scan.actives.length).toBeGreaterThan(0);
    for (const a of scan.actives) {
      expect(a.who.length).toBeGreaterThan(0);
      expect(a.reason.length).toBeGreaterThan(0);   // 不带原因的「当前版本」等于撒谎
      expect(a.path.startsWith("/")).toBe(true);
    }
  }, 30000);

  // partial 里的每一条都必须能说清是哪一步失败了 —— 这是它存在的意义。
  // Linux 容器里没有 pyenv / uv，所以这里大概是空的；有内容时也必须是可读的句子。
  it.runIf(hasPy)("partial 里的每条都说清了是哪一步失败", async () => {
    const scan = await scanRuntime("python");
    for (const p of scan.partial) {
      expect(p.length).toBeGreaterThan(4);
      expect(p).toContain("：");
    }
  }, 30000);

  // 诊断规则里凡是判定条件不成立的都不该报。容器里 pyenv 不存在，P2/P4 必须沉默 ——
  // 这类「不该出现的东西真的没出现」比「该出现的出现了」更难发现，所以显式钉住。
  it.runIf(hasPy)("没装 pyenv 时不报 P2 / P4", async () => {
    const scan = await scanRuntime("python");
    const codes = scan.issues.map((i) => i.code);
    expect(codes).not.toContain("P2");
    expect(codes).not.toContain("P4");
  }, 30000);

  it.runIf(hasPy)("每条诊断都有标题和说明，级别合法", async () => {
    const scan = await scanRuntime("python");
    for (const is of scan.issues) {
      expect(["error", "warn", "info"]).toContain(is.level);
      expect(is.title.length).toBeGreaterThan(0);
      expect(is.detail.length).toBeGreaterThan(0);
      expect(is.code).toMatch(/^[A-Z]\d+$/);
    }
  }, 30000);
});

describe("scanRuntime('java')", () => {
  // 容器里通常没有 Java。「没装」必须是一条正常结果（J5 提示怎么装），不是异常。
  it("没装 Java 时也要正常返回，并给出 J5 提示", async () => {
    const scan = await scanRuntime("java");
    expect(scan.kind).toBe("java");
    if (!scan.installs.length) {
      expect(scan.issues.map((i) => i.code)).toContain("J5");
      // 一个都没装时，JAVA_HOME 相关的几条不该同时冒出来刷屏
      const codes = scan.issues.map((i) => i.code);
      expect(codes).not.toContain("J1");
      expect(codes).not.toContain("J3");
    }
  }, 30000);
});

// 这条不是测功能，是钉住一个**架构约束**：scan.ts 一旦 import 了 electron，
// 上面所有 IO 测试会立刻全红（vitest 里没有 electron 运行时），
// 而那时候真正的错误信息会很难看懂。先在这里说清原因。
describe("架构约束", () => {
  it("scan.ts 不依赖 electron —— 所以上面这些 IO 测试能在 CI 里跑", async () => {
    const mod = await import("../electron/core/runtime/scan");
    expect(typeof mod.scanRuntime).toBe("function");
    expect(typeof mod.whichAll).toBe("function");
  });
});
