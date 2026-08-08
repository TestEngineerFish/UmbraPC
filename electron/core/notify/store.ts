// 提醒的本地落盘。JSON 文件，不用 sqlite —— 同 clipboard/store.ts 的理由：
// 数据量很小（几百条封顶），JSON 完全够用，且规避 better-sqlite3 的原生编译。
//
// **这是缓存，不是真相**：服务端才是。断网时读它写它，联网后按 updatedAtMs 合并。
// 但也正因为如此，不能因为拉不到服务端就让提醒功能整个不能用 —— 提醒是离线属性
// 最强的功能，没网也得到点响。
import fs from "node:fs";
import path from "node:path";

import type { Reminder, ReminderTomb } from "./types";

// 落盘的元信息：上次拉取的水位线 + 本机已经弹过的幂等键。
interface NotifyMeta {
  // 服务端上一次回的 synced_at_ms，下次当 since 用。
  lastSyncMs: number;
  // 幂等键 → 弹出时刻。防同一条重复弹（重启、休眠补扫、扫描周期抖动）。
  fired: Record<string, number>;
}

export class NotifyStore {
  private dir: string;
  private itemsFile: string;
  private tombsFile: string;
  private metaFile: string;

  constructor(userData: string) {
    this.dir = path.join(userData, "notify");
    this.itemsFile = path.join(this.dir, "reminders.json");
    this.tombsFile = path.join(this.dir, "tombs.json");
    this.metaFile = path.join(this.dir, "meta.json");
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      /* 建不了目录就退化成纯内存，不该让整个 App 起不来 */
    }
  }

  // 读一个 JSON 文件，任何异常都退回默认值 —— 文件损坏不该让提醒页白屏。
  private read<T>(file: string, fallback: T): T {
    try {
      const raw = fs.readFileSync(file, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private write(file: string, value: unknown): void {
    try {
      fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
    } catch (e) {
      console.error("[notify] 写盘失败：", file, e);
    }
  }

  loadItems(): Reminder[] {
    const list = this.read<Reminder[]>(this.itemsFile, []);
    return Array.isArray(list) ? list.slice().sort((a, b) => a.atMs - b.atMs) : [];
  }

  saveItems(items: Reminder[]): void {
    this.write(this.itemsFile, items.slice().sort((a, b) => a.atMs - b.atMs));
  }

  /** 还没推上去的删除。断网删的那条要留着，联网后补推，否则别的端永远看得见它。 */
  loadTombs(): ReminderTomb[] {
    const list = this.read<ReminderTomb[]>(this.tombsFile, []);
    return Array.isArray(list) ? list : [];
  }

  saveTombs(tombs: ReminderTomb[]): void {
    this.write(this.tombsFile, tombs);
  }

  private loadMeta(): NotifyMeta {
    const m = this.read<NotifyMeta>(this.metaFile, { lastSyncMs: 0, fired: {} });
    return { lastSyncMs: Number(m.lastSyncMs) || 0, fired: m.fired || {} };
  }

  get lastSyncMs(): number {
    return this.loadMeta().lastSyncMs;
  }

  set lastSyncMs(v: number) {
    const m = this.loadMeta();
    m.lastSyncMs = v;
    this.write(this.metaFile, m);
  }

  loadFired(): Record<string, number> {
    return this.loadMeta().fired;
  }

  saveFired(fired: Record<string, number>): void {
    const m = this.loadMeta();
    m.fired = fired;
    this.write(this.metaFile, m);
  }
}
