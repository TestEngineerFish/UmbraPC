// 剪贴板历史编排：面板窗口 + 采集器 + 全局快捷键 + IPC。
import * as path from "node:path";
import { ClipStore, ClipCategory, ClipItem } from "./store";
import { ClipWatcher } from "./watcher";
import { writeToClipboard, simulatePaste } from "./paste";
import { getAppIcon } from "./source-app";
import { ConfigStore, ClipKeep } from "../config";
import { suppressAppActivate } from "../activation";
import { accelProblem } from "../launcher/hotkey";

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp)$/i;
// 过期清理的巡检间隔：保留时长最细一档是 24 小时，半小时扫一次足够，也不会白烧 CPU。
const GC_INTERVAL_MS = 30 * 60 * 1000;

interface ManagerOpts {
  preloadPath: string;
  devUrl: string;
  distDir: string; // 打包后 dist 目录
}

export class ClipboardManager {
  private store: ClipStore;
  private watcher: ClipWatcher;
  private panel: Electron.BrowserWindow | null = null;
  // 打开面板前 Umbra 自身是否已在前台。false=用户在别的应用里（如 Finder/Chrome），
  // 关闭面板时需把焦点还给那个应用，而不是让 Umbra 主窗口抢到前台。
  private appWasActive = false;
  // 面板当前显示的分类：不同快捷键唤起同一个面板，只是默认落在不同分类上。
  private panelCategory: ClipCategory = "all";
  // 常用语没有数字 id，面板复用的是剪贴板那套按 id 操作的协议，
  // 所以给每条常用语分配一个稳定的负数「伪 id」（负数不会和真实历史条目撞）。
  private phrasePseudoId = new Map<string, number>();
  private phraseSeq = 0;
  private gcTimer: NodeJS.Timeout | null = null;

  // 常用语的标签清单（顺序 = 常用语设置里那份）。由 main.ts 在 launcher 建好后注入 ——
  // clipboard 比 launcher 先建，构造时还拿不到它；没注入就退化成不分组（全归「无标签」）。
  private phraseTagsFn: (() => string[]) | null = null;
  setPhraseTags(fn: () => string[]): void {
    this.phraseTagsFn = fn;
  }

  // reregister：截图与剪贴板共用 globalShortcut，改快捷键时由 main.ts 统一清理后各自重注册。
  constructor(private cfg: ConfigStore, userData: string, private opts: ManagerOpts, private reregister: () => void) {
    this.store = new ClipStore(userData);
    this.watcher = new ClipWatcher(this.store, () => this.broadcast("clipboard:history:changed"));
  }

  async init(): Promise<void> {
    await this.store.load();
    this.runGc();                                          // 启动即清一次（机器关机期间过期的那批）
    this.gcTimer = setInterval(() => this.runGc(), GC_INTERVAL_MS);
    if (this.cfg.get().clipboardEnabled) this.watcher.start();
    this.registerIpc();
    // 全局快捷键由 main.ts 统一注册（与截图共用 globalShortcut）。
  }

  // 退出时停掉巡检定时器。
  dispose(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.gcTimer = null;
  }

  // 执行一次过期清理；真删了东西才广播，避免无谓刷新。
  private runGc(): void {
    const keep = this.cfg.get().clipboardKeep;
    if (!keep) return;
    if (this.store.gcExpired(keep)) this.broadcast("clipboard:history:changed");
  }

  // 共享剪贴板存储给快捷入口 Launcher（同一实例，避免两份读写同一文件冲突）。
  getStore(): ClipStore {
    return this.store;
  }

  // 隐蔽写入剪贴板：写入后立刻把它设为监听基线 → 不进剪贴板历史（保险箱复制密码用）。
  async writeConcealed(text: string): Promise<void> {
    const { clipboard } = await import("electron");
    clipboard.writeText(text || "");
    await this.watcher.syncBaseline();
  }

  // ── 面板窗口 ──
  private async ensurePanel(): Promise<Electron.BrowserWindow> {
    if (this.panel && !this.panel.isDestroyed()) return this.panel;
    const { BrowserWindow } = await import("electron");
    const win = new BrowserWindow({
      width: 680,
      height: 520,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      fullscreenable: false,
      backgroundColor: "#00000000",
      webPreferences: { preload: this.opts.preloadPath, contextIsolation: true, nodeIntegration: false },
    });
    win.setAlwaysOnTop(true, "floating");
    // 在「当前所在的桌面/屏幕」直接显示，不跟随窗口原 Space（否则会跳屏）。
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.on("blur", () => this.hidePanel(false));
    win.webContents.on("before-input-event", (_e, input) => {
      if (input.type === "keyDown" && input.key === "Escape") this.hidePanel(true);
    });
    if (this.opts.devUrl) win.loadURL(`${this.opts.devUrl}/clipboard-panel.html`).catch(() => {});
    else win.loadFile(path.join(this.opts.distDir, "clipboard-panel.html")).catch(() => {});
    this.panel = win;
    return win;
  }

  // 预热：启动后就把面板窗建好并加载完页面（隐藏着）。
  // 否则第一次按快捷键要现场建窗 + 加载 HTML + 首帧渲染，肉眼可见地卡一下。
  async warmup(): Promise<void> {
    try {
      await this.ensurePanel();
    } catch {
      /* 预热失败不影响功能，下次唤起会重建 */
    }
  }

  // category 决定面板打开时默认停在哪个分类（剪贴板快捷键 → all，常用语快捷键 → phrase）。
  // 面板已经开着时：按的是同一把快捷键就收起；按的是另一把则原地切分类，不用先关再开。
  async togglePanel(category: ClipCategory = "all"): Promise<void> {
    const visible = !!this.panel && !this.panel.isDestroyed() && this.panel.isVisible();
    if (visible && this.panelCategory === category) {
      await this.hidePanel(true);
      return;
    }
    this.panelCategory = category;
    if (visible) this.panel!.webContents.send("clipboard:panel:shown", category);
    else await this.showPanel();
  }

  private async showPanel(): Promise<void> {
    const { BrowserWindow } = await import("electron");
    // 记录打开前 Umbra 是否已在前台（有窗口聚焦即为是）。
    this.appWasActive = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
    const win = await this.ensurePanel();
    // 每次唤起都重新定位到「光标所在屏幕」居中（不再只定位一次，否则会弹到上次/前台屏幕）。
    try {
      const { screen } = await import("electron");
      const pt = screen.getCursorScreenPoint();
      const disp = screen.getDisplayNearestPoint(pt);
      const wa = disp.workArea;
      const [w, h] = win.getSize();
      win.setPosition(Math.round(wa.x + (wa.width - w) / 2), Math.round(wa.y + (wa.height - h) / 2));
    } catch {
      win.center();
    }
    // show()/focus() 会顺带激活整个 app，触发 main.ts 的 app.on("activate")。
    // 那个回调是给「点 Dock 图标」用的，跑到这里只会 dock.show() + 把主窗口拽到前台抢焦点。
    suppressAppActivate();
    win.show();
    win.focus();
    win.webContents.send("clipboard:panel:shown", this.panelCategory);
  }

  // returnFocus=true 且打开面板前不在 Umbra 里时，隐藏整个 app，把焦点还给原应用
  // （否则 macOS 会把 Umbra 主窗口带到前台，粘贴也会落到主窗口而非原应用）。
  private async hidePanel(returnFocus = false): Promise<void> {
    // 顺序要紧：先 app.hide() 再 panel.hide()。反过来的话，面板一收起 macOS 就把同一个
    // app 的下一个窗口（主窗口）顶到前台，等 app.hide() 执行时主窗口已经画出来了，
    // 肉眼就是「闪一下主窗口再一起消失」。panel.hide() 仍要补一刀，
    // 否则 app 下次被唤起时这个面板会跟着一起回来。
    if (returnFocus && !this.appWasActive && process.platform === "darwin") {
      const { app } = await import("electron");
      app.hide();
    }
    if (this.panel && !this.panel.isDestroyed() && this.panel.isVisible()) this.panel.hide();
  }

  // ── 全局快捷键 ──（只注册自身，不 unregisterAll；清理由 main.ts 统一做）
  // 两把键指向同一个面板：clipboardShortcut 落在「全部」，phrasesShortcut 落在「常用语」。
  async registerShortcut(): Promise<void> {
    const { globalShortcut } = await import("electron");
    const bind = (acc: string, category: ClipCategory) => {
      if (!acc) return;
      // 先验一道：非 ASCII 的键位交给 Electron 会在原生层打一条 ERROR 再抛异常，
      // 日志一片红而用户只知道「按了没反应」。旧版录制器留下的 "Alt+Shift+◊" 就是这样。
      const bad = accelProblem(acc);
      if (bad) { console.warn(`[clipboard] 快捷键用不了（${bad}）：${acc} —— 去设置里重录一次`); return; }
      try {
        const ok = globalShortcut.register(acc, () => this.togglePanel(category));
        if (!ok) console.warn(`[clipboard] 快捷键注册失败（可能被占用）：${acc}`);
      } catch (e) {
        console.warn(`[clipboard] 快捷键注册异常：${acc}`, e);
      }
    };
    bind(this.cfg.get().clipboardShortcut || "Alt+V", "all");
    bind(this.cfg.get().phrasesShortcut || "", "phrase");
  }

  // ── 采集开关 / 快捷键 / 清空（供设置页调用）──
  async setEnabled(enabled: boolean): Promise<void> {
    await this.cfg.save({ clipboardEnabled: enabled });
    if (enabled) this.watcher.start();
    else this.watcher.stop();
  }
  async setShortcut(acc: string): Promise<{ ok: boolean }> {
    await this.cfg.save({ clipboardShortcut: acc });
    this.reregister();
    const { globalShortcut } = await import("electron");
    return { ok: globalShortcut.isRegistered(acc) };
  }
  // 常用语快捷键：同样打开剪贴板面板，只是默认停在「常用语」分类。
  async setPhrasesShortcut(acc: string): Promise<{ ok: boolean }> {
    await this.cfg.save({ phrasesShortcut: acc });
    this.reregister();
    const { globalShortcut } = await import("electron");
    return { ok: !acc || globalShortcut.isRegistered(acc) };
  }
  // 改保留时长后立刻按新规则清一遍，用户能马上看到效果。
  async setKeep(keep: ClipKeep): Promise<void> {
    await this.cfg.save({
      clipboardKeep: {
        text: Number(keep?.text) || 0,
        image: Number(keep?.image) || 0,
        files: Number(keep?.files) || 0,
      },
    });
    this.runGc();
  }

  // ── 常用语（虚拟分类）──
  // 常用语存在 config.phrases 里，不进剪贴板历史；这里把它包装成 ClipItem 交给同一个面板渲染。
  // 常用语条目。**按标签分组**（批次 013：和常用语页同一套规矩 —— 分组顺序跟标签清单走、
  // 「无标签」永远最后）：这里只负责排好序并给每条打上 group，插分组头是面板的事。
  // 搜索时照样分组：过滤完再排，空组自然不出现。
  private phraseItems(keyword = ""): ClipItem[] {
    const kw = keyword.trim().toLowerCase();
    const list = this.cfg.get().phrases || [];
    const now = Date.now();
    // 标签顺序 = 常用语设置里那份（配置在前、用到但没登记的 keyword 追加）；组内保持列表原顺序。
    const order = this.phraseTagsFn?.() || [];
    const rank = (tag: string) => {
      if (!tag) return order.length + 1;             // 「无标签」永远最后
      const i = order.indexOf(tag);
      return i >= 0 ? i : order.length;              // 清单里没有的（同步刚来的新标签）排在「无标签」之前
    };
    return list
      .filter((p) => {
        if (!kw) return true;
        return [p.name, p.content, p.keyword || ""].some((s) => (s || "").toLowerCase().includes(kw));
      })
      .map((p, i) => ({ p, i, tag: (p.keyword || "").trim() }))
      .sort((a, b) => (rank(a.tag) - rank(b.tag)) || (a.i - b.i))
      .map(({ p, tag }) => {
        let id = this.phrasePseudoId.get(p.id);
        if (id === undefined) {
          id = -++this.phraseSeq;
          this.phrasePseudoId.set(p.id, id);
        }
        return {
          id,
          type: "text" as const,
          content: p.content,
          preview: p.name || p.content.slice(0, 200),
          hash: `phrase:${p.id}`,
          favorite: false,
          size: p.content.length,
          // 分组头已经写着标签名了，行里不再重复一遍（原来借 sourceApp 显示的 `⌨ 关键词` 撤掉）。
          group: tag,
          lastUsedAt: now,
          createdAt: now,
        };
      });
  }

  // 伪 id → 常用语正文；不是常用语则返回 null。
  private phraseTextById(id: number): string | null {
    if (id >= 0) return null;
    for (const [pid, pseudo] of this.phrasePseudoId) {
      if (pseudo !== id) continue;
      const p = (this.cfg.get().phrases || []).find((x) => x.id === pid);
      return p ? p.content : null;
    }
    return null;
  }

  // 广播历史变更给所有窗口（面板 + 主窗口）。
  private async broadcast(channel: string, payload?: unknown): Promise<void> {
    const { BrowserWindow } = await import("electron");
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  }

  private async registerIpc(): Promise<void> {
    const { ipcMain, nativeImage } = await import("electron");

    ipcMain.handle("clip:list", (_e, category: ClipCategory, keyword: string) =>
      category === "phrase" ? this.phraseItems(keyword) : this.store.list(category, keyword),
    );

    ipcMain.handle("clip:copy", async (_e, id: number) => {
      // 常用语：直接写文本进剪贴板（会正常进历史，和手动复制一次是一样的）。
      const phrase = this.phraseTextById(id);
      if (phrase !== null) {
        const { clipboard } = await import("electron");
        clipboard.writeText(phrase);
        return true;
      }
      const it = this.store.get(id);
      if (!it) return false;
      this.watcher.noteWriteBack(it.hash);
      await writeToClipboard(it);
      // 关键：写回后按**剪贴板里实际是什么**重设基线。
      // 图片在 mac 上是以文件引用写回的，它的 hash 与原位图 hash 不同 ——
      // 只 noteWriteBack(原 hash) 的话，下一轮 tick 会把它当成新内容再插一条（重复历史）。
      await this.watcher.syncBaseline();
      this.store.touch(id);
      this.broadcast("clipboard:history:changed");
      return true;
    });

    ipcMain.handle("clip:paste", async (_e, id: number) => {
      // 常用语：写文本 → 收起面板还焦点 → 模拟粘贴（自动粘贴关掉时就只复制）。
      const phrase = this.phraseTextById(id);
      if (phrase !== null) {
        const { clipboard } = await import("electron");
        clipboard.writeText(phrase);
        await this.hidePanel(true);
        if (!this.cfg.get().clipboardAutoPaste) return false;
        await new Promise((r) => setTimeout(r, 180));
        return await simulatePaste();
      }
      const it = this.store.get(id);
      if (!it) return false;
      this.watcher.noteWriteBack(it.hash);
      await writeToClipboard(it);
      await this.watcher.syncBaseline(); // 同上：按实际写入的内容重设基线，避免重复入库
      this.store.touch(id);
      this.broadcast("clipboard:history:changed");
      await this.hidePanel(true); // 隐藏面板并把焦点还给原应用
      // 自动粘贴开关（默认关）：关时只复制，用户自行 Cmd+V。
      if (!this.cfg.get().clipboardAutoPaste) return false;
      await new Promise((r) => setTimeout(r, 180)); // 等焦点切换完成
      return await simulatePaste();
    });

    ipcMain.handle("clip:setFavorite", (_e, id: number, favorite: boolean) => {
      const it = this.store.setFavorite(id, favorite); // 超上限抛错 → 渲染层 catch 展示
      this.broadcast("clipboard:history:changed");
      return !!it;
    });

    ipcMain.handle("clip:remove", (_e, id: number) => {
      this.store.remove(id);
      this.broadcast("clipboard:history:changed");
      return true;
    });

    ipcMain.handle("clip:clear", () => {
      this.store.clearNonFavorite();
      this.broadcast("clipboard:history:changed");
      return true;
    });

    // 只清收藏：保留时长永远不会碰收藏项，所以攒久了得有个地方能一次性倒掉。
    ipcMain.handle("clip:clearFavorites", () => {
      const n = this.store.clearFavorites();
      if (n) this.broadcast("clipboard:history:changed");
      return n;
    });

    ipcMain.handle("clip:readImageDataUrl", (_e, id: number) => {
      const it = this.store.get(id);
      if (!it || it.type !== "image") return "";
      const img = nativeImage.createFromPath(it.content);
      if (img.isEmpty()) return "";
      return img.resize({ width: 320 }).toDataURL();
    });

    ipcMain.handle("clip:readPathThumbnail", (_e, p: string) => {
      if (!p || !IMAGE_EXT.test(p)) return "";
      const img = nativeImage.createFromPath(p);
      if (img.isEmpty()) return "";
      return img.resize({ width: 320 }).toDataURL();
    });

    ipcMain.handle("clip:getAppIcon", (_e, p: string) => getAppIcon(p));

    ipcMain.handle("clip:hidePanel", () => {
      this.hidePanel(true);
      return true;
    });

    // 设置页
    ipcMain.handle("clip:getSettings", () => ({
      enabled: this.cfg.get().clipboardEnabled,
      shortcut: this.cfg.get().clipboardShortcut,
      autoPaste: this.cfg.get().clipboardAutoPaste,
      keep: this.cfg.get().clipboardKeep,
      phrasesShortcut: this.cfg.get().phrasesShortcut,
    }));
    ipcMain.handle("clip:setEnabled", (_e, enabled: boolean) => this.setEnabled(!!enabled));
    ipcMain.handle("clip:setShortcut", (_e, acc: string) => this.setShortcut(acc));
    ipcMain.handle("clip:setAutoPaste", (_e, on: boolean) => this.cfg.save({ clipboardAutoPaste: !!on }));
    ipcMain.handle("clip:setKeep", (_e, keep: ClipKeep) => this.setKeep(keep));
    ipcMain.handle("clip:setPhrasesShortcut", (_e, acc: string) => this.setPhrasesShortcut(acc));
  }
}
