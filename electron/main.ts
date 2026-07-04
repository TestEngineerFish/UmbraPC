// Electron 主进程：开窗 + 任务执行器 + IPC。
// 设备 WebSocket 由渲染层(Chromium)承载（主进程网络在部分环境被代理/WAF RST）；
// 主进程只做能力探测与任务执行，经 IPC 与渲染层桥接。
import { app, BrowserWindow, globalShortcut, ipcMain, shell, systemPreferences } from "electron";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { ConfigStore, UmbraConfig } from "./core/config";
import { TaskExecutor } from "./core/device/client";
import { requestStop } from "./core/computer";
import { initRpc } from "./core/shared/rpc";
import { ClipboardManager } from "./core/clipboard";
import { ScreenshotManager } from "./core/screenshot";
import { resolveLocale, setMainLocale } from "./i18n";

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

let store: ConfigStore;
let executor: TaskExecutor;
let clipboard: ClipboardManager;
let screenshot: ScreenshotManager;

// 截图与剪贴板共用 globalShortcut：任何一方改快捷键，都先全清再各自重注册，避免互相覆盖。
function reregisterShortcuts(): void {
  globalShortcut.unregisterAll();
  clipboard?.registerShortcut();
  screenshot?.registerShortcut();
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

  loadRenderer(win);
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
    serverUrl: c.serverUrl,
    deviceId: c.deviceId,
    deviceName: c.deviceName,
    hasToken: Boolean(c.token),
    codingAllowExec: c.codingAllowExec,
    providersFile: c.providersFile,
    computerUseEnabled: c.computerUseEnabled,
    computerConfirm: c.computerConfirm,
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
    const cfg = store.get();
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
  ipcMain.handle("umbra:runTask", (_e, taskId: string, provider: string, skill: string, params: Record<string, unknown>) =>
    executor.runTask(taskId, provider, skill, params),
  );
  ipcMain.handle("umbra:confirmResponse", (_e, taskId: string, approved: boolean) => {
    executor.confirmResponse(taskId, approved);
  });

  // macOS 权限：读取真实授权状态。
  ipcMain.handle("umbra:getPermissions", () => {
    if (process.platform !== "darwin") return { accessibility: true, screen: "granted" };
    return {
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      screen: systemPreferences.getMediaAccessStatus("screen"),
    };
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
  ipcMain.handle("umbra:pauseShortcuts", () => {
    globalShortcut.unregisterAll();
  });
  ipcMain.handle("umbra:resumeShortcuts", () => {
    reregisterShortcuts();
  });
  // 打开系统设置 → 隐私与安全性 → 对应面板。
  ipcMain.handle("umbra:openPrivacy", (_e, target: string) => {
    const urls: Record<string, string> = {
      screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
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
  createWindow();

  // 剪贴板历史 + 截图：均复用主窗口的 preload；快捷键统一注册。
  const winOpts = {
    preloadPath: path.join(__dirname, "preload.cjs"),
    devUrl: DEV_URL,
    distDir: path.join(__dirname, "..", "dist"),
  };
  clipboard = new ClipboardManager(store, app.getPath("userData"), winOpts, reregisterShortcuts);
  screenshot = new ScreenshotManager(store, winOpts, reregisterShortcuts);
  Promise.all([clipboard.init(), screenshot.init()])
    .then(() => reregisterShortcuts()) // 两者就绪后统一注册各自快捷键
    .catch((e) => console.error("剪贴板/截图初始化失败", e));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
