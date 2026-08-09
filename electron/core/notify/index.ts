// 提醒模块的主进程侧：IPC、定时扫描、系统通知、角标。
//
// **到点触发全靠这里**：服务端只存不调度（没有 APNs 时它算出「到点了」也推不到
// 不在前台的端），所以每个客户端自己负责把本地那份扫出来并弹通知。
//
// 两条铁律（doc/提醒与定时任务-设计与待办.md，都是踩过的）：
//   1. **不给每条提醒挂 setTimeout**。Electron 的 Notification 没有 at/deliveryDate，
//      而 setTimeout 跨系统休眠不可靠 —— 用「持久化列表 + 60s 扫描 + 醒来补扫」。
//   2. **macOS 未签名的构建通知根本不显示**（还会发 failed 事件）。开发期验证必须走
//      `npm run dist:mac`，只跑 electron:dev 会让人以为代码写错了。
import { app, ipcMain, Notification, powerMonitor } from "electron";

import type { ConfigStore } from "../config";
import { NotifyStore } from "./store";
import { NotifyApi, syncFailureReason } from "./sync";
import { advance, mergeRemote, plan, pruneFired, pendingCount } from "./scanner";
import type { NotifySyncState, Reminder, ReminderTomb } from "./types";

// 扫描周期。60s 是「到点感觉准」与「别空转」的折中：提醒的心理预期是分钟级，
// 60s 的边界误差可以接受。**不要**为了更准就缩到几秒 —— 那是拿电池换心理安慰。
const SCAN_INTERVAL_MS = 60_000;

// 定时拉取间隔：别的端（手机）改了，这个周期内会看到。
const PULL_INTERVAL_MS = 5 * 60_000;

// 本地改动后延迟多久推送。连着改几条时合并成一次请求。
const PUSH_DEBOUNCE_MS = 3_000;

// 「再等一会儿」的默认分钟数。与 iOS 的通知动作保持一致。
const DEFAULT_SNOOZE_MIN = 10;

export interface NotifyDeps {
  /** 唤起主窗口（点通知本体时用）。 */
  showMainWindow: () => void;
  /** 让渲染层跳到某个页面 / 某条提醒（深链落点）。 */
  openReminder: (id: string) => void;
}

export class NotifyManager {
  private store: NotifyStore;
  private api: NotifyApi;
  private items: Reminder[] = [];
  private tombs: ReminderTomb[] = [];
  private state: NotifySyncState = { syncing: false, lastAt: 0, lastError: "", configured: false };
  private scanTimer: NodeJS.Timeout | undefined;
  private pullTimer: NodeJS.Timeout | undefined;
  private pushTimer: NodeJS.Timeout | undefined;
  /** 同步进行中又来了新请求 → 跑完补一轮，别把请求丢了（见 sync 的注释）。 */
  private resyncRequested = false;
  private onChanged: () => void;

  // onChanged：数据变化后回调，让渲染层刷新提醒列表。
  constructor(cfg: ConfigStore, userData: string, private deps: NotifyDeps, onChanged: () => void) {
    this.store = new NotifyStore(userData);
    this.api = new NotifyApi(cfg);
    this.onChanged = onChanged;
  }

  // 唯一初始化入口：读盘 → 注册 IPC → 起定时器 → 补扫一次。
  async init(): Promise<void> {
    this.items = this.store.loadItems();
    this.tombs = this.store.loadTombs();
    this.registerIpc();

    this.scanTimer = setInterval(() => this.tick(), SCAN_INTERVAL_MS);
    this.pullTimer = setInterval(() => { void this.sync(); }, PULL_INTERVAL_MS);

    // 休眠唤醒补扫：睡了一夜的话，这一下会把错过的按分级合并弹出来。
    // 没有它，setInterval 在休眠期间不走，醒来只会在下一个 60s 边界才想起来。
    powerMonitor.on("resume", () => {
      this.tick();
      void this.sync();
    });

    this.tick();
    void this.sync();
  }

  dispose(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.pullTimer) clearInterval(this.pullTimer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.scanTimer = undefined;
    this.pullTimer = undefined;
    this.pushTimer = undefined;
  }

  getState(): NotifySyncState {
    return { ...this.state, configured: this.api.isConfigured() };
  }

  list(): Reminder[] {
    return this.items.slice();
  }

  // ── 扫描与呈现 ──────────────────────────────────────────────────────

  /**
   * 一轮扫描：算出该弹什么 → 弹 → 推进重复提醒 → 落盘 → 刷角标。
   *
   * 分成「算」和「推进」两步是刻意的：算的时候用的是**推进前**的 atMs，
   * 所以幂等键是这一次计划时刻，重启后重算还是同一个键，不会重复弹。
   */
  private tick(): void {
    const now = Date.now();
    const fired = this.store.loadFired();
    const p = plan(this.items, now, fired);

    for (const occ of p.due) this.show(occ.reminder, occ.ahead);
    if (p.missed.length > 0) this.showDigest(p.missed.length);
    // stale 的什么都不弹，只在列表里显示为逾期 —— 三天前的提醒现在响没有意义。

    if (p.keys.length > 0) {
      const next = pruneFired({ ...fired }, now);
      for (const k of p.keys) next[k] = now;
      this.store.saveFired(next);
    }

    // 推进过点的重复提醒。一次可能跨过好几次（出差三天回来），
    // 但只推进不补通知 —— 这就是「重复提醒只补最近一次」。
    let moved = false;
    for (let i = 0; i < this.items.length; i++) {
      const adv = advance(this.items[i], now);
      if (!adv) continue;
      this.items[i] = {
        ...this.items[i],
        atMs: adv.atMs,
        done: adv.done,
        updatedAtMs: now,
        dirty: true,
      };
      moved = true;
    }
    if (moved) {
      this.store.saveItems(this.items);
      this.schedulePush();
      this.onChanged();
    }
    this.refreshBadge();
  }

  /** 弹一条系统通知。 */
  private show(r: Reminder, ahead: boolean): void {
    const title = ahead ? "快到了" : "提醒";
    const body = ahead ? `提前 ${r.aheadMinutes} 分钟：${r.text}` : (r.note ? `${r.text} · ${r.note}` : r.text);
    // actions 目前只有 macOS 真的会渲染按钮，Windows 会忽略 —— 忽略了也没关系，
    // 点通知本体进详情这条路在所有平台都通。
    const n = new Notification({
      title,
      body,
      actions: [
        { type: "button", text: "完成" },
        { type: "button", text: `再等 ${DEFAULT_SNOOZE_MIN} 分钟` },
      ],
    });
    n.on("click", () => {
      this.deps.showMainWindow();
      this.deps.openReminder(r.id);
    });
    n.on("action", (_e, index) => {
      if (index === 0) this.setDone(r.id, true);
      else this.snooze(r.id, DEFAULT_SNOOZE_MIN);
    });
    try {
      n.show();
    } catch {
      /* 没有通知权限 / 未签名构建收不到，静默忽略，别把主流程带崩 */
    }
  }

  /** 错过 15 分钟以上但还是今天的，合并成一条 —— 一开机糊十几条横幅是灾难。 */
  private showDigest(count: number): void {
    const n = new Notification({ title: "错过的提醒", body: `你有 ${count} 条错过的提醒` });
    n.on("click", () => {
      this.deps.showMainWindow();
      this.deps.openReminder("");
    });
    try {
      n.show();
    } catch {
      /* 同上 */
    }
  }

  /**
   * 刷未读角标。
   * macOS 用 Dock 角标；Windows 的 setOverlayIcon 需要一张真图标资源，
   * 现在托盘还是空图标 + 文字标题，先不做（列表里有数字，不至于看不见）。
   */
  private refreshBadge(): void {
    const n = pendingCount(this.items, Date.now());
    if (process.platform === "darwin" && app.dock) {
      try {
        app.dock.setBadge(n > 0 ? String(n) : "");
      } catch {
        /* 忽略 */
      }
    }
  }

  // ── 本地写操作 ──────────────────────────────────────────────────────

  /**
   * 本地写的统一收尾：盖时间戳、标 dirty、落盘、刷角标、排推送。
   * 所有增删改都走它 —— 少做一步就会出现「改了没同步」这类幽灵问题。
   */
  private commit(r: Reminder): void {
    const now = Date.now();
    const v: Reminder = { ...r, updatedAtMs: now, dirty: true };
    const i = this.items.findIndex((x) => x.id === v.id);
    if (i >= 0) this.items[i] = v; else this.items.push(v);
    this.items.sort((a, b) => a.atMs - b.atMs);
    this.store.saveItems(this.items);
    this.refreshBadge();
    this.schedulePush();
    this.onChanged();
  }

  save(r: Reminder): void {
    this.commit(r);
  }

  remove(id: string): void {
    this.items = this.items.filter((x) => x.id !== id);
    this.store.saveItems(this.items);
    // 删除也要留墓碑并推上去：只删本地的话，下次拉取又把它同步回来。
    this.tombs = [...this.tombs.filter((t) => t.id !== id), { id, deletedAtMs: Date.now() }];
    this.store.saveTombs(this.tombs);
    this.refreshBadge();
    this.schedulePush();
    this.onChanged();
  }

  setDone(id: string, done: boolean): void {
    const r = this.items.find((x) => x.id === id);
    if (!r) return;
    this.commit({ ...r, done });
  }

  /** 「再等 N 分钟」：从**现在**往后推，不是从原时间推 —— 原时间可能已经过去两小时了。 */
  snooze(id: string, minutes = DEFAULT_SNOOZE_MIN): void {
    const r = this.items.find((x) => x.id === id);
    if (!r) return;
    this.commit({ ...r, atMs: Date.now() + minutes * 60_000, done: false });
  }

  // ── 同步 ────────────────────────────────────────────────────────────

  private schedulePush(): void {
    if (!this.api.isConfigured()) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      void this.sync();
    }, PUSH_DEBOUNCE_MS);
  }

  /**
   * 先补推本地改动、再拉增量合并。
   *
   * 顺序不能反：先拉的话，紧接着的服务端旧值会盖掉本地还没推上去的修改。
   * 任何一步失败都**不动本地数据** —— 断网时提醒必须照常能用。
   */
  /**
   * 同步一轮。同步进行中再调**不会丢**——记一笔，等这轮跑完自动补跑。
   *
   * 原来是直接 `return false`。秘书在聊天里建提醒时，广播常常紧跟在别的同步
   * 后面到达，一丢就等于这条提醒要等下一轮定时拉（5 分钟）——而「5 分钟后
   * 提醒我」根本等不到。下拉刷新连点、启动与首次进页面撞一起也是同一个问题。
   */
  async sync(): Promise<boolean> {
    if (this.state.syncing) {
      this.resyncRequested = true;
      return false;
    }
    let ok = false;
    do {
      this.resyncRequested = false;
      ok = await this.syncOnce();
    } while (this.resyncRequested);
    return ok;
  }

  private async syncOnce(): Promise<boolean> {
    if (!this.api.isConfigured()) {
      this.state.lastError = "";
      return false;
    }
    this.state.syncing = true;
    try {
      // ① 补推删除。推成功才清墓碑，失败就留着下次再试。
      const stillPending: ReminderTomb[] = [];
      for (const t of this.tombs) {
        try {
          await this.api.remove(t.id, t.deletedAtMs);
        } catch {
          stillPending.push(t);
        }
      }
      if (stillPending.length !== this.tombs.length) {
        this.tombs = stillPending;
        this.store.saveTombs(this.tombs);
      }

      // ② 补推改动。
      for (const r of this.items.filter((x) => x.dirty)) {
        const resp = await this.api.put(r);
        const i = this.items.findIndex((x) => x.id === r.id);
        if (i < 0) continue;
        // applied=false → 服务端那份更新（别的端刚改过），用它覆盖本地，
        // 否则会一轮一轮反复推一个必输的版本。
        this.items[i] = resp.applied ? { ...this.items[i], dirty: false } : resp.reminder;
      }

      // ③ 拉增量并合并。
      const page = await this.api.pull(this.store.lastSyncMs);
      this.items = mergeRemote(this.items, page.items, page.tombs);
      this.store.lastSyncMs = page.syncedAtMs;
      this.store.saveItems(this.items);

      this.state.lastAt = Date.now();
      this.state.lastError = "";
      this.refreshBadge();
      this.onChanged();
      return true;
    } catch (e) {
      this.state.lastError = syncFailureReason(e);
      console.error("[notify] 同步失败：", this.state.lastError);
      return false;
    } finally {
      this.state.syncing = false;
    }
  }

  // ── IPC ─────────────────────────────────────────────────────────────

  private registerIpc(): void {
    // 失败一律不 reject：Electron 会为未捕获的 handler 异常刷一堆
    // "Error occurred in handler" 噪声日志，而这里任何一步失败都不该让整页白屏。
    ipcMain.handle("notify:list", async () => this.list());
    ipcMain.handle("notify:state", async () => this.getState());
    ipcMain.handle("notify:save", async (_e, r: Reminder) => {
      try {
        this.save(r);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });
    ipcMain.handle("notify:delete", async (_e, id: string) => {
      try {
        this.remove(String(id));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });
    ipcMain.handle("notify:setDone", async (_e, id: string, done: boolean) => {
      this.setDone(String(id), Boolean(done));
      return { ok: true };
    });
    ipcMain.handle("notify:snooze", async (_e, id: string, minutes: number) => {
      this.snooze(String(id), Number(minutes) || DEFAULT_SNOOZE_MIN);
      return { ok: true };
    });
    ipcMain.handle("notify:syncNow", async () => this.sync());
  }
}
