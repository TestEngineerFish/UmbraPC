// Electron 主进程：开窗 + 任务执行器 + IPC。
// 设备 WebSocket 由渲染层(Chromium)承载（主进程网络在部分环境被代理/WAF RST）；
// 主进程只做能力探测与任务执行，经 IPC 与渲染层桥接。
import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";
import { ConfigStore, UmbraConfig } from "./core/config";
import { TaskExecutor } from "./core/device-client";

const DEV_URL = process.env.VITE_DEV_SERVER_URL || "";

let store: ConfigStore;
let executor: TaskExecutor;

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
  };
}

function registerIpc(): void {
  ipcMain.handle("umbra:getConfig", () => publicConfig(store.get()));
  ipcMain.handle("umbra:setConfig", async (_e, patch: Partial<UmbraConfig>) => {
    if (patch.token === "" || patch.token === undefined) delete (patch as Record<string, unknown>).token;
    await store.save(patch);
    return publicConfig(store.get());
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
}

app.whenReady().then(async () => {
  store = new ConfigStore(app.getPath("userData"));
  await store.load();
  executor = new TaskExecutor(store);
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
