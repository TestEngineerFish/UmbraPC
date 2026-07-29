// 连接配置的唯一真源是主进程。这块出过一次真实故障（渲染层和主进程各存一份，
// 结果聊天连 A、主进程连 B），所以边界都要钉住：谁说了算、空值怎么办、旧数据清不清。
import { beforeEach, describe, expect, it, vi } from "vitest";

// server.ts 顶层就会读 localStorage / WebSocket，import 之前先把壳搭好。
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
});
vi.stubGlobal("WebSocket", class { close() {} addEventListener() {} });
vi.stubGlobal("window", globalThis);

const {
  adoptDesktopConfig, getClientId, getDeviceName, getServerUrl, hasToken, setDeviceName, setServerUrl,
} = await import("../src/services/server");

const DEFAULT = "https://umbra.tingyusha.xyz";

describe("浏览器预览（没有主进程）", () => {
  beforeEach(() => store.clear());

  it("回落默认地址", () => {
    expect(getServerUrl()).toBe(DEFAULT);
  });

  it("写地址会去掉结尾斜杠，并真的落到 localStorage", () => {
    setServerUrl("https://a.example.com/");
    expect(getServerUrl()).toBe("https://a.example.com");
    expect(store.get("umbra.serverUrl")).toBe("https://a.example.com");
  });

  it("没有主进程就谈不上令牌", () => {
    expect(hasToken()).toBe(false);
  });

  it("客户端 ID 自己生成一次，之后保持稳定", () => {
    const id = getClientId();
    expect(id.startsWith("pc-")).toBe(true);
    expect(getClientId()).toBe(id);
  });
});

describe("桌面端：主进程说了算", () => {
  beforeEach(() => {
    store.clear();
    store.set("umbra.serverUrl", "https://stale.example.com");
    store.set("umbra.token", "老版本残留的明文令牌");
  });

  it("接管之后一切以主进程为准，localStorage 里的旧值不再生效", () => {
    adoptDesktopConfig({ serverUrl: "https://b.example.com//", deviceId: "dev-123", deviceName: "书房 Mac", hasToken: true });
    expect(getServerUrl()).toBe("https://b.example.com");
    expect(getDeviceName()).toBe("书房 Mac");
    expect(hasToken()).toBe(true);
  });

  it("客户端 ID 直接用主进程的 deviceId（两边日志才对得上号）", () => {
    adoptDesktopConfig({ serverUrl: "https://b.example.com", deviceId: "dev-123", deviceName: "x", hasToken: false });
    expect(getClientId()).toBe("dev-123");
  });

  it("接管时清掉老版本残留的明文令牌", () => {
    adoptDesktopConfig({ serverUrl: "https://b.example.com", deviceId: "d", deviceName: "x", hasToken: true });
    expect(store.has("umbra.token")).toBe(false);
  });

  it("桌面端改地址只动镜像，不再往 localStorage 写第二份", () => {
    adoptDesktopConfig({ serverUrl: "https://b.example.com", deviceId: "d", deviceName: "x", hasToken: true });
    setServerUrl("https://c.example.com");
    expect(getServerUrl()).toBe("https://c.example.com");
    expect(store.get("umbra.serverUrl")).toBe("https://stale.example.com");
  });

  it("写配置之后的回灌能覆盖镜像", () => {
    adoptDesktopConfig({ serverUrl: "https://b.example.com", deviceId: "d", deviceName: "x", hasToken: true });
    adoptDesktopConfig({ serverUrl: "https://d.example.com", deviceId: "d", deviceName: "x", hasToken: false });
    expect(getServerUrl()).toBe("https://d.example.com");
    expect(hasToken()).toBe(false);
  });

  it("空值不会把配置抹掉", () => {
    adoptDesktopConfig({ serverUrl: "https://d.example.com", deviceId: "d", deviceName: "书房 Mac", hasToken: false });
    setServerUrl("   ");
    setDeviceName("");
    expect(getServerUrl()).toBe("https://d.example.com");
    expect(getDeviceName()).toBe("书房 Mac");
  });

  it("主进程给了空配置就回落默认，而不是变成空串", () => {
    adoptDesktopConfig({ serverUrl: "", deviceId: "", deviceName: "", hasToken: false });
    expect(getServerUrl()).toBe(DEFAULT);
    expect(getDeviceName()).toBe("此设备");
    expect(getClientId()).toBe("pc");
  });
});
