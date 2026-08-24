// 保险箱回收站的**纯判定**：一条记录处在删除的哪一态、还剩几天。
//
// 单独一个文件是为了能测 —— 这里没有 electron、没有 fs、没有密钥，
// 拿几个假 Item 就能把三态判全（同 runtime/scan.ts 刻意不 import electron 的做法）。
// 这块逻辑值得钉死：它决定「用户还能不能把删掉的密码找回来」，
// 判错一次的后果是把还能恢复的条目当成已彻底删除、从界面上抹掉。
import type { Item } from "./types";

/** 回收站保留期。跟服务端那套（提醒的 TOMBSTONE_KEEP_MS）取同一个 30 天 ——
 *  一个产品里不该有两种「保留多久」，用户记不住哪个是哪个。 */
export const TRASH_KEEP_MS = 30 * 24 * 3600 * 1000;

/** 删除的三态。**一个 deleted 标志位表示两种删除**，靠内容还在不在区分。
 *
 *  为什么不加第二个字段：iOS 的 VItem 是 Swift Codable 结构体，解码时会丢掉
 *  不认识的字段、编码时也不会再吐出来。只要有一端还是旧版本，新加的字段就会在
 *  下一次同步里被抹平 —— 那条已删除的记录会在**所有设备上原地复活**。
 *  复用 deleted 则天然兼容：旧版本看见 deleted=true 就照旧隐藏，行为是对的。 */
export type TrashState = "live" | "trashed" | "purged";

export function trashStateOf(it: Pick<Item, "deleted" | "blocks" | "attachments">): TrashState {
  if (!it.deleted) return "live";
  // 内容还在 → 还能恢复。这条同时把两种「恢复不出东西」的情况判成 purged：
  //   ① 本端彻底删除过的（内容擦干净了）
  //   ② **旧版本客户端删的** —— 它会当场清空 blocks/attachments，只留标题。
  //      这条尤其重要：那种记录确实什么都恢复不出来，列进回收站给个「恢复」按钮，
  //      点完只会得到一条空壳，比根本不显示更糟。
  const hasContent = (it.blocks?.length || 0) > 0 || (it.attachments?.length || 0) > 0;
  return hasContent ? "trashed" : "purged";
}

/** 在回收站里、还能恢复。 */
export function isTrashed(it: Pick<Item, "deleted" | "blocks" | "attachments">): boolean {
  return trashStateOf(it) === "trashed";
}

/** 还剩几天。
 *
 *  **向上取整**：删完当天就该显示「还剩 30 天」而不是 29。
 *  过期但还没被清理扫到的回 0，不回负数 —— 界面上「还剩 -3 天」
 *  是在把实现细节漏给用户看。 */
export function leftDays(deletedAtMs: number, nowMs: number, keepMs = TRASH_KEEP_MS): number {
  const left = deletedAtMs + keepMs - nowMs;
  return left <= 0 ? 0 : Math.ceil(left / 86400000);
}

/** 到期了没（该被彻底删除了）。 */
export function isExpired(deletedAtMs: number, nowMs: number, keepMs = TRASH_KEEP_MS): boolean {
  return nowMs - deletedAtMs >= keepMs;
}
