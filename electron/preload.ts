// 预加载：把任务执行 + 配置能力暴露给渲染层（window.umbra）。
// 设备 WebSocket 在渲染层；这里只桥接「执行/确认/进度」与配置。
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("umbra", {
  isDesktop: true,
  platform: process.platform,
  getConfig: () => ipcRenderer.invoke("umbra:getConfig"),
  setConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke("umbra:setConfig", patch),

  // 设备引擎执行侧（渲染层连 /ws/device，执行交给主进程）
  getRegisterInfo: () => ipcRenderer.invoke("umbra:getRegisterInfo"),
  getProviders: () => ipcRenderer.invoke("umbra:getProviders"),
  runTask: (taskId: string, provider: string, skill: string, params: Record<string, unknown>) =>
    ipcRenderer.invoke("umbra:runTask", taskId, provider, skill, params),
  confirmResponse: (taskId: string, approved: boolean) => ipcRenderer.invoke("umbra:confirmResponse", taskId, approved),

  // macOS 权限
  getPermissions: () => ipcRenderer.invoke("umbra:getPermissions"),
  openPrivacy: (target: string) => ipcRenderer.invoke("umbra:openPrivacy", target),
  // computer-use 紧急停止
  computerStop: () => ipcRenderer.invoke("umbra:computerStop"),
  // 打开 providers.json 供编辑
  openProvidersFile: () => ipcRenderer.invoke("umbra:openProvidersFile"),
  // 能力页：启用/停用程序 + 自定义程序读写
  setDisabled: (list: string[]) => ipcRenderer.invoke("umbra:setDisabled", list),
  getProvidersConfig: () => ipcRenderer.invoke("umbra:getProvidersConfig"),
  saveProvidersConfig: (providers: unknown[]) => ipcRenderer.invoke("umbra:saveProvidersConfig", providers),

  // 主进程 RPC：渲染层替主进程做需要 Chromium 网络的活（如上传）
  onRpc: (cb: (msg: { id: string; method: string; args: unknown }) => void) => {
    const l = (_e: unknown, msg: any) => cb(msg);
    ipcRenderer.on("umbra:rpc", l);
    return () => ipcRenderer.removeListener("umbra:rpc", l);
  },
  sendRpcResult: (id: string, ok: boolean, result: unknown, error?: string) =>
    ipcRenderer.send("umbra:rpc-result", { id, ok, result, error }),

  // 主进程执行过程中回流的进度 / 确认请求
  onTaskProgress: (cb: (p: { taskId: string; message: string; extra: Record<string, unknown> }) => void) => {
    const l = (_e: unknown, p: any) => cb(p);
    ipcRenderer.on("umbra:task-progress", l);
    return () => ipcRenderer.removeListener("umbra:task-progress", l);
  },
  onConfirmRequest: (cb: (c: { taskId: string; summary: string; detail: Record<string, unknown> }) => void) => {
    const l = (_e: unknown, c: any) => cb(c);
    ipcRenderer.on("umbra:task-confirm-request", l);
    return () => ipcRenderer.removeListener("umbra:task-confirm-request", l);
  },
});

// 剪贴板历史桥（面板窗口与设置页共用）。
contextBridge.exposeInMainWorld("umbraClip", {
  list: (category: string, keyword: string) => ipcRenderer.invoke("clip:list", category, keyword),
  copy: (id: number) => ipcRenderer.invoke("clip:copy", id),
  paste: (id: number) => ipcRenderer.invoke("clip:paste", id),
  setFavorite: (id: number, favorite: boolean) => ipcRenderer.invoke("clip:setFavorite", id, favorite),
  remove: (id: number) => ipcRenderer.invoke("clip:remove", id),
  clear: () => ipcRenderer.invoke("clip:clear"),
  readImageDataUrl: (id: number) => ipcRenderer.invoke("clip:readImageDataUrl", id),
  readPathThumbnail: (p: string) => ipcRenderer.invoke("clip:readPathThumbnail", p),
  getAppIcon: (p: string) => ipcRenderer.invoke("clip:getAppIcon", p),
  hidePanel: () => ipcRenderer.invoke("clip:hidePanel"),
  getSettings: () => ipcRenderer.invoke("clip:getSettings"),
  setEnabled: (enabled: boolean) => ipcRenderer.invoke("clip:setEnabled", enabled),
  setShortcut: (acc: string) => ipcRenderer.invoke("clip:setShortcut", acc),
  onHistoryChanged: (cb: () => void) => {
    const l = () => cb();
    ipcRenderer.on("clipboard:history:changed", l);
    return () => ipcRenderer.removeListener("clipboard:history:changed", l);
  },
  onPanelShown: (cb: () => void) => {
    const l = () => cb();
    ipcRenderer.on("clipboard:panel:shown", l);
    return () => ipcRenderer.removeListener("clipboard:panel:shown", l);
  },
});
