// Electron 主进程：开窗 + 任务执行器 + IPC。
// 设备 WebSocket 由渲染层(Chromium)承载（主进程网络在部分环境被代理/WAF RST）；
// 主进程只做能力探测与任务执行，经 IPC 与渲染层桥接。
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, shell, systemPreferences, Tray } from "electron";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { ConfigStore, UmbraConfig } from "./core/config";
import { TaskExecutor } from "./core/device/client";
import { requestStop } from "./core/computer";
import { initRpc } from "./core/shared/rpc";
import { isAppActivateSuppressed } from "./core/activation";
import { ClipboardManager } from "./core/clipboard";
import { ScreenshotManager } from "./core/screenshot";
import { LauncherManager } from "./core/launcher";
import { VaultManager } from "./core/vault";
import { NotifyManager } from "./core/notify";
import { registerRuntimeIpc } from "./core/runtime";
import { getMainLocale, resolveLocale, setMainLocale } from "./i18n";
import { cancelAgentTask, killAllAgentChildren } from "./core/providers/agent";

const DEV_URL = process.env.VITE_DEV_SERVER_URL || "";

// providers.json 模板（首次编辑时写入，含一个 ffmpeg 示例说明格式；JSON 不支持注释）。
const PROVIDERS_TEMPLATE = JSON.stringify(
  {
    providers: [
      {
        provider: "ffmpeg",
        display_name: "FFmpeg",
        detect: "ffmpeg",
        version_cmd: ["ffmpeg", "-version"],
        skills: {
          to_gif: {
            description: "把视频转成 GIF",
            params: { input: "输入视频路径", output: "输出 GIF 路径" },
            command: ["ffmpeg", "-y", "-i", "{input}", "{output}"],
            timeout: 600,
            confirm: false,
          },
        },
      },
    ],
  },
  null,
  2,
);

// 开机自启只在 macOS / Windows 上有实现；Linux 下 Electron 的 setLoginItemSettings 是空操作，
// 摆一个点了没反应的开关比不摆更糟，所以这里报不支持、界面上整行不出现。
function loginItemSupported(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

let store: ConfigStore;
let executor: TaskExecutor;
let clipboard: ClipboardManager;
let screenshot: ScreenshotManager;
let launcher: LauncherManager;
let vault: VaultManager;
let notify: NotifyManager;
let mainWindow: BrowserWindow | null = null; // 显式跟踪主窗口：剪贴板/截图的隐藏窗口会让 getAllWindows() 恒 >0，不能靠它判断
let tray: Tray | null = null;
let quitting = false; // true 时才真正退出（关窗默认只隐藏）

// 单实例锁：双开（打包版 + dev 版/双击两次）会造成 Dock 图标与托盘行为混乱、
// 两个设备引擎抢同一个 device_id 反复顶掉对方的 /ws/device 连接。
// 抢锁失败的实例立即退出；已有实例收到 second-instance 时唤起主窗口。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
}

// 截图与剪贴板共用 globalShortcut：任何一方改快捷键，都先全清再各自重注册，避免互相覆盖。
function reregisterShortcuts(): void {
  globalShortcut.unregisterAll();
  clipboard?.registerShortcut();
  screenshot?.registerShortcut();
  launcher?.registerShortcut();
  launcher?.registerWorkflowHotkeys();  // 工作流里的 Hotkey 触发
  vault?.registerShortcut();            // 保险箱唤起快捷键
}

// 打包后的 .app 只有极简 PATH（看不到 homebrew/nvm/npm 全局），导致 which(claude/codex/ffmpeg) 找不到。
// 读取用户登录 shell 的真实 PATH 合并进来，并兜底补常见目录，让 Provider 探测正常。
async function fixPath(): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const sh = process.env.SHELL || "/bin/zsh";
    const out = await new Promise<string>((resolve) => {
      execFile(sh, ["-ilc", 'echo -n "__UMBRA_PATH__:$PATH"'], { timeout: 5000 }, (_e, stdout) => resolve(stdout || ""));
    });
    const m = out.match(/__UMBRA_PATH__:(.*)/);
    if (m && m[1].trim()) process.env.PATH = m[1].trim();
  } catch {
    /* 用兜底目录 */
  }
  const home = process.env.HOME || "";
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", `${home}/.local/bin`, `${home}/.npm-global/bin`, `${home}/.bun/bin`];
  const cur = (process.env.PATH || "").split(":").filter(Boolean);
  for (const p of extra) if (p && !cur.includes(p)) cur.push(p);
  process.env.PATH = cur.join(":");
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#15110E",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 把执行器的进度/确认请求转发给渲染层，由渲染层经 /ws/device 上报服务端。
  const send = (channel: string, payload: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };
  executor.on("progress", (p) => send("umbra:task-progress", p));
  executor.on("confirm-request", (c) => send("umbra:task-confirm-request", c));

  // 让主进程能把需要 Chromium 网络的活（上传等）交给这个窗口的渲染层。
  initRpc(win.webContents);

  // 关窗默认只隐藏（macOS），应用继续后台跑（设备引擎/托盘/⌥Space 都还在）；
  // Alfred 式 Dock 策略：窗口收起时 Dock 图标一并隐藏，showMainWindow 唤起时再恢复——
  // 保证「窗口可见 ⇔ Dock 图标可见」的确定性行为。只有显式退出（quitting=true）才真正销毁。
  // 关掉了菜单栏图标就不能再「只隐藏」——那样应用既没窗口也没入口，成了只能强杀的幽灵。
  // 所以没有托盘时关窗就是真退出。
  win.on("close", (e) => {
    if (process.platform === "darwin" && !quitting && tray) {
      e.preventDefault();
      win.hide();
      app.dock?.hide();
    } else if (!tray) {
      quitting = true;
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  mainWindow = win;
  loadRenderer(win);
}

// 唤起主窗口：存在就显示+聚焦，销毁了就重建。
function showMainWindow(): void {
  // 每次唤起都强制恢复 Dock 图标（与关窗时的 dock.hide 配对）：
  // 无论图标因何丢失（关窗隐藏/系统怪象），唤起窗口即自愈。
  if (process.platform === "darwin") void app.dock?.show();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

// 销毁菜单栏图标（设置里关掉「菜单栏图标」时调用）。
function destroyTray(): void {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

// 菜单栏（状态栏）托盘图标：关窗后仍可从这里再次唤起。
function createTray(): void {
  if (tray) return;
  const loc = getMainLocale();
  const t = (zh: string, en: string) => (loc.startsWith("zh") ? zh : en);
  // 用空图标 + 标题文字，避免依赖打包资源；标题短，占位小。
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("Umbra");
  tray.setTitle("Umbra");
  const menu = Menu.buildFromTemplate([
    { label: t("显示主窗口", "Show Umbra"), click: () => showMainWindow() },
    { type: "separator" },
    { label: t("退出", "Quit"), click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => showMainWindow()); // 左键直接唤起（右键出菜单）
}

// dev：连 Vite（带重试）；否则加载打包好的 dist。
function loadRenderer(win: BrowserWindow): void {
  const distIndex = path.join(__dirname, "..", "dist", "index.html");
  if (DEV_URL) {
    const tryLoad = () => {
      win.loadURL(DEV_URL).catch(() => {});
    };
    win.webContents.on("did-fail-load", () => {
      if (!win.isDestroyed()) setTimeout(tryLoad, 1000);
    });
    tryLoad();
  } else {
    win.loadFile(distIndex).catch((e) => {
      console.error("加载 dist 失败，请先 npm run build（或用 npm run electron 自动构建）", e);
    });
  }
}

// 返回给界面的配置：隐藏 token 明文，仅暴露是否已设置。
function publicConfig(c: UmbraConfig) {
  return {
    // openAtLogin 现场读系统设置而不是存在自己的配置里：用户可能在系统「登录项」里直接删掉，
    // 存一份就会和系统对不上。Linux 上 Electron 不支持，直接报 false 并在界面上藏掉这一行。
    openAtLogin: loginItemSupported() ? app.getLoginItemSettings().openAtLogin : false,
    loginItemSupported: loginItemSupported(),
    trayEnabled: c.trayEnabled !== false,
    // 配置目录与日志目录：设置页「关于」里给一个「打开」按钮，排查问题时不用现问路径。
    userDataDir: app.getPath("userData"),
    logsDir: logsDir(),
    serverUrl: c.serverUrl,
    deviceId: c.deviceId,
    deviceName: c.deviceName,
    hasToken: Boolean(c.token),
    codingAllowExec: c.codingAllowExec,
    providersFile: c.providersFile,
    computerUseEnabled: c.computerUseEnabled,
    computerConfirm: c.computerConfirm,
    computerSkillPolicy: c.computerSkillPolicy || {},
    disabledProviders: c.disabledProviders || [],
    locale: resolveLocale(c.locale),
  };
}

// 读取 providers.json 里的自定义程序（统一成数组）。
async function readProvidersConfig(): Promise<any[]> {
  try {
    const raw = await fs.readFile(store.get().providersFile, "utf-8");
    const data = JSON.parse(raw);
    const arr = Array.isArray(data) ? data : data?.providers || [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function registerIpc(): void {
  ipcMain.handle("umbra:getConfig", () => publicConfig(store.get()));
  ipcMain.handle("umbra:setConfig", async (_e, patch: Partial<UmbraConfig>) => {
    if (patch.token === "" || patch.token === undefined) delete (patch as Record<string, unknown>).token;
    const prevLocale = resolveLocale(store.get().locale);
    await store.save(patch);
    // 重建能力注册表，让新配置（如电脑动作授权策略）对后续任务立即生效，无需重连。
    await executor.refreshRegistry().catch(() => undefined);
    const cfg = store.get();
    // 菜单栏图标即时生效：开就建、关就销毁。别等重启，用户点了开关就该看到状态栏的变化。
    if (patch.trayEnabled !== undefined) {
      if (cfg.trayEnabled !== false) createTray(); else destroyTray();
    }
    const nextLocale = resolveLocale(cfg.locale);
    if (patch.locale && nextLocale !== prevLocale) {
      setMainLocale(nextLocale);
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send("umbra:locale-changed", nextLocale);
      }
    }
    return publicConfig(cfg);
  });
  // 设备引擎（渲染层连 /ws/device）所需：注册信息、Provider 列表、执行、确认。
  ipcMain.handle("umbra:getRegisterInfo", () => executor.getRegisterInfo());
  ipcMain.handle("umbra:getProviders", () => executor.getProviders());
  // runTask 的失败是**正常业务回传**（执行轮探路：目录不存在/文件是二进制…都会失败后换路子），
  // 不能让 handler 直接 reject——Electron 会把每次 reject 打成吓人的
  // "Error occurred in handler" 控制台错误。包成 {__umbraErr} 返回，preload 侧再还原成 throw。
  ipcMain.handle("umbra:runTask", async (_e, taskId: string, provider: string, skill: string, params: Record<string, unknown>) => {
    try {
      return await executor.runTask(taskId, provider, skill, params);
    } catch (err) {
      return { __umbraErr: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("umbra:confirmResponse", (_e, taskId: string, approved: boolean) => {
    executor.confirmResponse(taskId, approved);
  });
  // 服务端 cancel_task → 设备收到 task_cancel → 杀掉正在跑这个任务的引擎进程。
  ipcMain.handle("umbra:cancelTask", (_e, taskId: string) => cancelAgentTask(taskId));

  // macOS 权限：读取真实授权状态。
  ipcMain.handle("umbra:getPermissions", () => {
    if (process.platform !== "darwin") return { accessibility: true, screen: "granted", microphone: "granted" };
    return {
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      screen: systemPreferences.getMediaAccessStatus("screen"),
      microphone: systemPreferences.getMediaAccessStatus("microphone"),
    };
  });
  // 开机自启：系统设置才是唯一真相，所以只写不读（读走 getConfig → publicConfig）。
  // openAsHidden 让它登录后静默启动，不弹窗糊在用户脸上。
  ipcMain.handle("umbra:setLoginItem", (_e, on: boolean) => {
    if (!loginItemSupported()) return false;
    app.setLoginItemSettings({ openAtLogin: Boolean(on), openAsHidden: true });
    return app.getLoginItemSettings().openAtLogin;
  });
  // computer-use 紧急停止（请求中止 operate 循环）。
  ipcMain.handle("umbra:computerStop", () => {
    requestStop();
  });
  // 打开 providers.json 供用户编辑（不存在则写入带示例的模板）。改完下次设备重连即生效。
  ipcMain.handle("umbra:openProvidersFile", async () => {
    const file = store.get().providersFile;
    try {
      await fs.access(file);
    } catch {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, PROVIDERS_TEMPLATE, "utf-8");
    }
    await shell.openPath(file);
    return file;
  });
  // 工作区「打开位置」：在 Finder/资源管理器里打开该目录（~ 展开为家目录）。
  // 返回 "" 表示成功；非空为错误信息（目录不存在等）。
  ipcMain.handle("umbra:openPath", async (_e, p: string) => {
    let target = String(p || "").trim();
    if (!target) return "empty";
    if (target === "~" || target.startsWith("~/")) {
      target = path.join(app.getPath("home"), target.slice(1));
    }
    return await shell.openPath(target);
  });

  // 按网址取一张图（通用图标选择器的「填网址」入口，2026-09-03 验收第二轮）。
  // 为什么在主进程：渲染层 fetch 第三方站点会撞 CORS，主进程的 net.fetch 没有这层限制。
  // 给的不是图片 URL（比如就填了个 github.com）时，退回去拿那个站的 favicon ——
  // 用户填网址十有八九就是想要「那个网站的图标」。返回 data URL；压缩交给渲染层的 canvas。
  ipcMain.handle("umbra:fetchImage", async (_e, url: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }> => {
    let raw = String(url || "").trim();
    if (!raw) return { ok: false, error: "网址是空的" };
    if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
    let u: URL;
    try { u = new URL(raw); } catch { return { ok: false, error: "网址格式不对" }; }
    const { httpFetch } = await import("./core/http");
    const grab = async (target: string): Promise<string | null> => {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        const r = await httpFetch(target, { signal: ctl.signal, headers: { "user-agent": "Mozilla/5.0 (Umbra)" } });
        clearTimeout(timer);
        const ct = r.headers.get("content-type") || "";
        if (!r.ok || !/^image\//i.test(ct)) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length || buf.length > 5 * 1024 * 1024) return null;   // 5MB 封顶，图标不该更大
        return `data:${ct.split(";")[0]};base64,${buf.toString("base64")}`;
      } catch { return null; }
    };
    // 依次试：网址本身 → 该站根目录的 favicon.ico → 两个公共 favicon 服务（国内外各一路兜底）。
    const candidates = [
      u.toString(),
      `${u.origin}/favicon.ico`,
      `https://icons.duckduckgo.com/ip3/${u.hostname}.ico`,
      `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=128`,
    ];
    for (const c of candidates) {
      const got = await grab(c);
      if (got) return { ok: true, dataUrl: got };
    }
    return { ok: false, error: "这个网址取不到图片（也没找到它的站点图标）" };
  });

  // 列一个目录的顶层内容（工作区详情页的「目录内容」）。
  // 只读顶层、不递归：这一栏是「让人认出这是哪个目录」，不是文件浏览器。
  // 返回排好序的前 limit 项（目录在前、再按名字）+ total 供「共 N 项」用；目录不存在返回 total=-1。
  ipcMain.handle("umbra:listDir", async (_e, p: string, limit = 5) => {
    let target = String(p || "").trim();
    if (!target) return { items: [], total: -1 };
    if (target === "~" || target.startsWith("~/")) target = path.join(app.getPath("home"), target.slice(1));
    try {
      const names = await fs.readdir(target, { withFileTypes: true });
      // 隐藏文件不列（.git / .DS_Store 之类占位没意义）。
      const visible = names.filter((d) => !d.name.startsWith("."));
      visible.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
      const take = visible.slice(0, Math.max(1, Number(limit) || 5));
      const items = await Promise.all(take.map(async (d) => {
        const full = path.join(target, d.name);
        // 目录不给大小（算目录体积要递归，这一栏不值得为它做 IO）。
        let size = -1;
        if (d.isFile()) {
          try { size = (await fs.stat(full)).size; } catch { /* 读不到就当未知 */ }
        }
        return { name: d.name, dir: d.isDirectory(), size };
      }));
      return { items, total: visible.length };
    } catch {
      return { items: [], total: -1 };   // 目录不存在 / 没权限：调用方按「读不到」展示
    }
  });

  // 渲染层（设备传输层）把每条日志也写进文件。
  ipcMain.handle("umbra:appendLog", (_e, line: string) => {
    appendLog(String(line || ""));
    return true;
  });

  // 日志页「打开日志文件夹」：直接打开今天的日志所在目录并选中文件。
  ipcMain.handle("umbra:openLogsFolder", async () => {
    const file = logFileOf();
    await fs.mkdir(logsDir(), { recursive: true });
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, "", "utf-8"); // 今天还没有日志：建个空的，免得打开个空目录
    }
    shell.showItemInFolder(file);
    return file;
  });

  // 能力页：启用/停用某程序（写 disabledProviders）。
  ipcMain.handle("umbra:setDisabled", async (_e, list: string[]) => {
    await store.save({ disabledProviders: Array.isArray(list) ? list : [] });
    return publicConfig(store.get());
  });
  // 能力页：读取/保存自定义程序（providers.json）。
  ipcMain.handle("umbra:getProvidersConfig", () => readProvidersConfig());
  ipcMain.handle("umbra:saveProvidersConfig", async (_e, providers: any[]) => {
    const file = store.get().providersFile;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ providers: Array.isArray(providers) ? providers : [] }, null, 2), "utf-8");
    return true;
  });
  // 录制快捷键期间：暂停全局快捷键（否则按下旧快捷键会触发对应功能，如又开始截图）。
  //
  // 同时关掉**应用菜单**的快捷键。macOS 上 Electron 会自动装一份默认菜单
  // （Cmd+Q 退出、Cmd+W 关窗、Cmd+H 隐藏、Cmd+A/C/V/Z…），录制时按这些组合
  // 会先被菜单吃掉：轻则录不进来，重则窗口直接关了、应用直接退了。
  // setIgnoreMenuShortcuts 让渲染层先拿到 keydown，录完再放回去。
  //
  // ⚠️ 治得了自家的，治不了别人的：第三方 App 注册的全局快捷键、以及系统级的
  // （Spotlight 的 Cmd+Space、切换应用的 Cmd+Tab）在更底层就被截走，
  // Electron 收不到 keydown。那类只能靠录完之后 checkAccel 的系统快捷键表来提示。
  ipcMain.handle("umbra:pauseShortcuts", () => {
    globalShortcut.unregisterAll();
    mainWindow?.webContents.setIgnoreMenuShortcuts(true);
  });
  ipcMain.handle("umbra:resumeShortcuts", () => {
    mainWindow?.webContents.setIgnoreMenuShortcuts(false);
    reregisterShortcuts();
  });
  // 打开系统设置 → 隐私与安全性 → 对应面板。
  ipcMain.handle("umbra:openPrivacy", (_e, target: string) => {
    const urls: Record<string, string> = {
      screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    };
    return shell.openExternal(urls[target] || urls.screen);
  });
}

app.whenReady().then(async () => {
  await fixPath(); // 先补全 PATH，之后 Provider 探测(which)才能找到 claude/codex/ffmpeg
  store = new ConfigStore(app.getPath("userData"));
  await store.load();
  if (!store.get().locale) {
    try {
      await store.save({ locale: resolveLocale(app.getLocale()) });
    } catch {
      await store.save({ locale: resolveLocale(null) });
    }
  }
  setMainLocale(resolveLocale(store.get().locale));
  executor = new TaskExecutor(store);
  registerIpc();
  // 运行时环境探测（只读）。放在 fixPath() 之后 —— 它要靠补全过的 PATH 才能找到
  // pyenv / uv 这些装在 homebrew 或 ~/.local/bin 下的管理器。
  registerRuntimeIpc();
  createWindow();
  if (store.get().trayEnabled !== false) createTray(); // 菜单栏常驻图标：关窗后仍可唤起
  pruneLogs();
  appendLog(`Umbra 启动 v${app.getVersion()} (${process.platform})`);

  // macOS Dock 图标：打包后由 .icns 提供；dev 下 Electron 用默认图标，
  // 这里显式设一下，免得开发时 Dock 上是个陌生的 Electron 图标。
  if (process.platform === "darwin" && app.dock) {
    const iconFile = path.join(__dirname, "..", "build", "icon.png");
    try {
      const img = nativeImage.createFromPath(iconFile);
      if (!img.isEmpty()) app.dock.setIcon(img);
    } catch {
      /* 找不到图标就用默认的 */
    }
  }

  // 剪贴板历史 + 截图：均复用主窗口的 preload；快捷键统一注册。
  const winOpts = {
    preloadPath: path.join(__dirname, "preload.cjs"),
    devUrl: DEV_URL,
    distDir: path.join(__dirname, "..", "dist"),
  };
  clipboard = new ClipboardManager(store, app.getPath("userData"), winOpts, reregisterShortcuts);
  screenshot = new ScreenshotManager(store, winOpts, reregisterShortcuts);
  // 快捷入口：复用剪贴板的存储实例（避免两份读写同一文件）。
  launcher = new LauncherManager(store, app.getPath("userData"), winOpts, reregisterShortcuts);
  // 快捷入口「发给秘书」：跳出主窗口聊天页并发送这条消息。
  // 批次 013 起消息是 { text, atts? }（atts = 面板已传好的图片 file_id），整个对象原样发给主窗口，
  // 主窗口 shell.ts 按有没有 atts 分流到 sendTextWithAtts / sendText。
  launcher.setChatSender((msg: { text: string; atts?: string[] }) => {
    showMainWindow();
    const w = mainWindow;
    if (w && !w.isDestroyed()) {
      const post = () => w.webContents.send("umbra:launcher-send-chat", msg);
      if (w.webContents.isLoading()) w.webContents.once("did-finish-load", post); else post();
    }
  });
  vault = new VaultManager(store, app.getPath("userData"), winOpts, { copyConceal: (t) => clipboard.writeConcealed(t) }, reregisterShortcuts);
  // 工作流配置项里的密钥存保险箱（W10）：launcher 先于 vault 建好，所以建完再回填。
  launcher.setVault(vault);

  // 提醒引擎。core/notify 早就写完（60s 扫描、系统通知、双向同步、IPC 都在），
  // 但这里一直没实例化、preload 也没暴露桥 —— 提醒页恒显示「没有注入提醒能力」
  // 的空态（用户验收点名）。两个回调都取**调用时**的 mainWindow：
  // 主窗口可能被关掉重建，捕获引用会发给一具死窗口。
  const sendToMain = (channel: string, ...args: unknown[]) => {
    const w = mainWindow;
    if (w && !w.isDestroyed()) {
      const post = () => w.webContents.send(channel, ...args);
      if (w.webContents.isLoading()) w.webContents.once("did-finish-load", post); else post();
    }
  };
  notify = new NotifyManager(store, app.getPath("userData"), {
    showMainWindow,
    // 点系统通知本体 → 唤起主窗口并把那条提醒的 id 递给渲染层（跳提醒页高亮）。
    openReminder: (id) => { showMainWindow(); sendToMain("notify:open", id); },
  }, () => sendToMain("notify:changed"));
  void notify.init();
  // 独立图片查看窗（批次 011）：所有窗口的「看大图」共用一扇，不遮任何界面。
  void import("./core/imageviewer").then((m) => m.registerImageViewer(winOpts));
  Promise.all([clipboard.init(), screenshot.init(), launcher.init(), vault.init()])
    .then(() => {
      reregisterShortcuts(); // 就绪后统一注册各自快捷键
      // 预热高频窗口：截图 / 剪贴板面板。它们的第一次唤起要现场建窗 + 加载页面 + 首帧，
      // 那一下的卡顿全在这里。空闲时提前把窗建好藏着，之后按快捷键就是纯 show()。
      setTimeout(() => {
        screenshot.warmup();
        clipboard.warmup();
      }, 1500);
    })
    .catch((e) => console.error("剪贴板/截图/快捷入口/保险箱初始化失败", e));

  // 点 Dock 图标：唤起主窗口（不能靠 getAllWindows().length===0 判断，
  // 剪贴板/截图的隐藏窗口会让它恒 >0）。
  // 悬浮面板自己 show() 时 macOS 也会激活 app 并触发这里，那种情况要跳过——
  // 否则会 dock.show() + 把主窗口拽到前台，既慢又抢走面板的键盘焦点。
  app.on("activate", () => {
    if (isAppActivateSuppressed()) return;
    showMainWindow();
  });
});


// ── 设备日志落盘 ────────────────────────────────────────────────────────────
// 日志此前只存在渲染层内存里：应用一关就没了，出问题也没法回溯（更没法发给别人看）。
// 现在按天写一个文件到 userData/logs，保留 7 天。
function logsDir(): string {
  return path.join(app.getPath("userData"), "logs");
}
function logFileOf(d = new Date()): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return path.join(logsDir(), `umbra-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.log`);
}
let logQueue: Promise<void> = Promise.resolve();
function appendLog(line: string): void {
  const ts = new Date().toISOString();
  // 串行追加：并发 appendFile 到同一文件会交错，日志会变得没法读。
  logQueue = logQueue
    .then(async () => {
      await fs.mkdir(logsDir(), { recursive: true });
      await fs.appendFile(logFileOf(), `[${ts}] ${line}\n`, "utf-8");
    })
    .catch(() => undefined);
}
// 清掉 7 天前的日志，别无限堆积。
async function pruneLogs(): Promise<void> {
  try {
    const dir = logsDir();
    const cutoff = Date.now() - 7 * 86400_000;
    for (const f of await fs.readdir(dir)) {
      if (!f.startsWith("umbra-") || !f.endsWith(".log")) continue;
      const st = await fs.stat(path.join(dir, f)).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fs.rm(path.join(dir, f), { force: true });
    }
  } catch {
    /* 目录还不存在 */
  }
}

// 显式退出前置标记，让 close 处理器放行真正销毁。
app.on("before-quit", () => {
  quitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  clipboard?.dispose();   // 停掉剪贴板历史的过期巡检定时器
  notify?.dispose();      // 停掉提醒的扫描/同步定时器
  // 带走还在跑的引擎进程（claude/codex）：否则会留下孤儿进程，
  // 下次同一工作区的任务会被永久堵在队列里。
  killAllAgentChildren();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
