// 常用语云端同步（phrases-sync.ts）：sam 实锤的「拖拽调序过几秒又变回去 / 落在中间位置」。
// 病根两处，这里各钉一条，外加「回包落后于本地不落地」：
//   ① 纯调序不盖 updatedAt → 服务端逐条 last-write-wins 全判「不比库里新」→ 旧顺序回灌；
//   ② 同步在飞时再来的推送被直接丢掉 → 那次改动没人再推，随后被在飞那轮的回包冲掉。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// httpFetch 走 electron net.fetch，测试里换成可控的假响应。
vi.mock("../electron/core/http", () => ({ httpFetch: vi.fn() }));

import { httpFetch } from "../electron/core/http";
import { PhraseSync, stampUpdated } from "../electron/core/launcher/phrases-sync";
import type { ConfigStore, Phrase } from "../electron/core/config";

const P = (id: string, name: string, updatedAt = 100): Phrase => ({ id, name, content: `c-${id}`, updatedAt });

describe("stampUpdated：内容或位置变了才盖时间戳", () => {
  it("纯调序：位置变了的条目盖新时间戳，没动的保留旧值（① 的修法）", () => {
    const prev = [P("a", "A"), P("b", "B"), P("c", "C"), P("d", "D")];
    const next = [prev[2], prev[0], prev[1], prev[3]]; // c 从第三挪到第一，a b 顺延，d 不动
    const out = stampUpdated(next, prev);
    expect(out.find((p) => p.id === "c")!.updatedAt).toBeGreaterThan(100);
    expect(out.find((p) => p.id === "a")!.updatedAt).toBeGreaterThan(100);
    expect(out.find((p) => p.id === "b")!.updatedAt).toBeGreaterThan(100);
    expect(out.find((p) => p.id === "d")!.updatedAt).toBe(100);
  });

  it("原样保存：一条都不盖 —— 否则本机每次保存都会无理由赢过别的设备", () => {
    const prev = [P("a", "A"), P("b", "B")];
    const out = stampUpdated([...prev], prev);
    expect(out.map((p) => p.updatedAt)).toEqual([100, 100]);
  });

  it("只改内容：只有那一条盖时间戳", () => {
    const prev = [P("a", "A"), P("b", "B")];
    const out = stampUpdated([prev[0], { ...prev[1], name: "B2" }], prev);
    expect(out[0].updatedAt).toBe(100);
    expect(out[1].updatedAt).toBeGreaterThan(100);
  });
});

// 一个能被测试控制「什么时候回包」的假 fetch。
function deferredFetch() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  const respond = (items: unknown[]) => resolve({ ok: true, json: async () => ({ items, deleted: [] }), text: async () => "" });
  return { promise, respond };
}

function fakeCfg(phrases: Phrase[]) {
  const state: Record<string, unknown> = { serverUrl: "http://x", token: "t", phrases, phrasesDeleted: [] };
  const save = vi.fn(async (patch: Record<string, unknown>) => { Object.assign(state, patch); });
  return { cfg: { get: () => state, save } as unknown as ConfigStore, save, state };
}

describe("PhraseSync：在飞与回包过时", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.mocked(httpFetch).mockReset(); });

  it("同步在飞时又来一次：不丢，飞完立刻再同步一轮（② 的修法）", async () => {
    const d1 = deferredFetch();
    const d2 = deferredFetch();
    vi.mocked(httpFetch).mockReturnValueOnce(d1.promise as never).mockReturnValueOnce(d2.promise as never);
    const { cfg } = fakeCfg([P("a", "A")]);
    const s = new PhraseSync(cfg, () => {});
    const first = s.sync();               // 在飞
    expect(await s.sync()).toBe(false);   // 第二次：记账，不丢
    d1.respond([{ id: "a", name: "A", content: "c-a", updatedAt: 100 }]);
    await first;
    expect(vi.mocked(httpFetch)).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);   // 飞完 300ms 后自动再来一轮
    expect(vi.mocked(httpFetch)).toHaveBeenCalledTimes(2);
    d2.respond([]);
  });

  it("请求在飞期间本地改过：这份回包不落地（否则把刚才的改动冲掉），并再同步一轮", async () => {
    const d1 = deferredFetch();
    const d2 = deferredFetch();
    vi.mocked(httpFetch).mockReturnValueOnce(d1.promise as never).mockReturnValueOnce(d2.promise as never);
    const { cfg, save, state } = fakeCfg([P("a", "A"), P("b", "B")]);
    const s = new PhraseSync(cfg, () => {});
    const first = s.sync();
    // 在飞期间用户调了序（IPC 落盘后 schedulePush）
    state.phrases = [P("b", "B", 999), P("a", "A", 999)];
    s.schedulePush();
    // 回包是旧顺序（服务端还没见过这次调序）
    d1.respond([{ id: "a", name: "A", content: "c-a", updatedAt: 100 }, { id: "b", name: "B", content: "c-b", updatedAt: 100 }]);
    await first;
    expect(save).not.toHaveBeenCalled();                 // 没被旧顺序冲掉
    expect((state.phrases as Phrase[])[0].id).toBe("b");
    await vi.advanceTimersByTimeAsync(3500);              // 飞完的补轮 + debounce 的那轮，总之要再推
    expect(vi.mocked(httpFetch).mock.calls.length).toBeGreaterThanOrEqual(2);
    d2.respond([]);
  });

  it("回包期间本地没改：正常整份落地", async () => {
    const d1 = deferredFetch();
    vi.mocked(httpFetch).mockReturnValueOnce(d1.promise as never);
    const { cfg, save } = fakeCfg([P("a", "A")]);
    const changed = vi.fn();
    const s = new PhraseSync(cfg, changed);
    const first = s.sync();
    d1.respond([{ id: "a", name: "A2", content: "c-a", updatedAt: 200 }]);
    expect(await first).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
