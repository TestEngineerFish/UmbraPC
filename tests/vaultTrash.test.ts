// 保险箱回收站的三态判定。
//
// 为什么单独钉这一块：它决定「用户还能不能把删掉的密码找回来」。判错的方式很安静 ——
// 把一条还能恢复的记录当成已彻底删除，界面上就什么都不显示，用户不会收到任何提示，
// 只会以为东西没了。而这条判定又**没有第二个标记位兜底**（刻意的，见 trash.ts 的注释），
// 全靠「内容还在不在」，所以每一种内容形态都要各点一次名。
import { describe, expect, it } from "vitest";
import { TRASH_KEEP_MS, isExpired, isTrashed, leftDays, trashStateOf } from "../electron/core/vault/trash";

type Fake = { deleted?: boolean; blocks: unknown[]; attachments: unknown[] };
const mk = (o: Partial<Fake> = {}): Fake => ({ blocks: [], attachments: [], ...o });
const block = { id: "b1", type: "secret", data: {} };
const att = { id: "a1", name: "x.png", mime: "image/png", size: 1, addedAt: 0 };

describe("三态判定", () => {
  it("没置 deleted 就是正常记录", () => {
    expect(trashStateOf(mk({ blocks: [block] }) as never)).toBe("live");
    // 内容空的正常记录也还是正常记录 —— 判据只在 deleted=true 之后才看内容
    expect(trashStateOf(mk() as never)).toBe("live");
  });

  it("deleted + 还有 block → 在回收站里，能恢复", () => {
    expect(trashStateOf(mk({ deleted: true, blocks: [block] }) as never)).toBe("trashed");
    expect(isTrashed(mk({ deleted: true, blocks: [block] }) as never)).toBe(true);
  });

  it("deleted + 只剩附件 → 也算在回收站里", () => {
    // 一条只放了图片/文件、没有任何 block 的记录（比如扫描件）同样要能恢复。
    // 只看 blocks 会把它判成已彻底删除。
    expect(trashStateOf(mk({ deleted: true, attachments: [att] }) as never)).toBe("trashed");
  });

  it("deleted + 内容全空 → 已彻底删除", () => {
    expect(trashStateOf(mk({ deleted: true }) as never)).toBe("purged");
    expect(isTrashed(mk({ deleted: true }) as never)).toBe(false);
  });

  it("**旧版本客户端删的**（清空内容、只留标题）判成已彻底删除", () => {
    // 混版本同步期间会真实出现：旧版本的 tombstone 会当场清掉 blocks/attachments/tags，
    // 只保留 title。那种记录确实什么都恢复不出来 ——
    // 列进回收站给个「恢复」按钮，点完得到一条空壳，比根本不显示更糟。
    const fromOldClient = { deleted: true, title: "旧公司 VPN", blocks: [], attachments: [] };
    expect(trashStateOf(fromOldClient as never)).toBe("purged");
  });

  it("blocks / attachments 缺字段时不炸", () => {
    // 同步进来的数据不一定长得规矩，判定挂掉会连累整个列表渲染不出来。
    expect(trashStateOf({ deleted: true } as never)).toBe("purged");
  });
});

describe("倒计时", () => {
  const now = 1_700_000_000_000;

  it("刚删完显示满 30 天（向上取整，不是 29）", () => {
    expect(leftDays(now, now)).toBe(30);
  });

  it("过了 23 天还剩 7 天 —— 正好是稿里转 warning 的那一档", () => {
    expect(leftDays(now - 23 * 86400000, now)).toBe(7);
  });

  it("差几小时不算少一天（向上取整）", () => {
    expect(leftDays(now - 3600_000, now)).toBe(30);
  });

  it("过期未清的回 0，不回负数", () => {
    // 界面上「还剩 -3 天」是在把实现细节漏给用户看。
    expect(leftDays(now - TRASH_KEEP_MS - 5 * 86400000, now)).toBe(0);
    expect(leftDays(now - TRASH_KEEP_MS, now)).toBe(0);
  });
});

describe("到期判定", () => {
  const now = 1_700_000_000_000;

  it("满 30 天当天就算到期", () => {
    expect(isExpired(now - TRASH_KEEP_MS, now)).toBe(true);
  });

  it("差一毫秒都不算", () => {
    // 清理是不可逆的，边界宁可晚一轮也不要早一轮。
    expect(isExpired(now - TRASH_KEEP_MS + 1, now)).toBe(false);
  });

  it("刚删的不算", () => {
    expect(isExpired(now, now)).toBe(false);
  });
});

describe("常量", () => {
  it("保留期就是 30 天 —— 跟服务端那套（提醒的墓碑）是同一个数", () => {
    expect(TRASH_KEEP_MS).toBe(30 * 24 * 3600 * 1000);
  });
});
