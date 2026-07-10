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
  // 录制快捷键期间暂停/恢复全局快捷键
  pauseShortcuts: () => ipcRenderer.invoke("umbra:pauseShortcuts"),
  resumeShortcuts: () => ipcRenderer.invoke("umbra:resumeShortcuts"),
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
  onLocaleChanged: (cb: (locale: string) => void) => {
    const l = (_e: unknown, locale: string) => cb(locale);
    ipcRenderer.on("umbra:locale-changed", l);
    return () => ipcRenderer.removeListener("umbra:locale-changed", l);
  },
  // 快捷入口「发给秘书」：跳聊天页并发送这条消息。
  onLauncherSendChat: (cb: (text: string) => void) => {
    const l = (_e: unknown, text: string) => cb(text);
    ipcRenderer.on("umbra:launcher-send-chat", l);
    return () => ipcRenderer.removeListener("umbra:launcher-send-chat", l);
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
  setAutoPaste: (on: boolean) => ipcRenderer.invoke("clip:setAutoPaste", on),
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

// 快捷入口桥（浮层搜索窗渲染层用）。
contextBridge.exposeInMainWorld("umbraLauncher", {
  query: (q: string) => ipcRenderer.invoke("launcher:query", q),
  run: (id: string, mod?: string) => ipcRenderer.invoke("launcher:run", id, mod || ""),
  sendAssistant: (text: string) => ipcRenderer.invoke("launcher:sendAssistant", text),
  hide: () => ipcRenderer.invoke("launcher:hide"),
  getSettings: () => ipcRenderer.invoke("launcher:getSettings"),
  setEnabled: (enabled: boolean) => ipcRenderer.invoke("launcher:setEnabled", enabled),
  setShortcut: (acc: string) => ipcRenderer.invoke("launcher:setShortcut", acc),
  setFolders: (folders: unknown) => ipcRenderer.invoke("launcher:setFolders", folders),
  setScripts: (scripts: unknown) => ipcRenderer.invoke("launcher:setScripts", scripts),
  setYoudao: (appKey: string, secret: string) => ipcRenderer.invoke("launcher:setYoudao", appKey, secret),
  getWorkflows: () => ipcRenderer.invoke("launcher:getWorkflows"),
  setWorkflows: (workflows: unknown) => ipcRenderer.invoke("launcher:setWorkflows", workflows),
  openWorkflowEditor: () => ipcRenderer.invoke("launcher:openWorkflowEditor"),
  fileIcon: (p: string) => ipcRenderer.invoke("launcher:fileIcon", p),
  getPhrases: () => ipcRenderer.invoke("launcher:getPhrases"),
  setPhrases: (phrases: unknown) => ipcRenderer.invoke("launcher:setPhrases", phrases),
  resize: (h: number) => ipcRenderer.invoke("launcher:resize", h),
  pickPath: () => ipcRenderer.invoke("launcher:pickPath"),
  pickApp: () => ipcRenderer.invoke("launcher:pickApp"),
  onShown: (cb: () => void) => {
    const l = () => cb();
    ipcRenderer.on("launcher:shown", l);
    return () => ipcRenderer.removeListener("launcher:shown", l);
  },
});

// 密码保险箱桥。
contextBridge.exposeInMainWorld("umbraVault", {
  openWindow: () => ipcRenderer.invoke("vault:openWindow"),
  status: () => ipcRenderer.invoke("vault:status"),
  setup: (mp: string) => ipcRenderer.invoke("vault:setup", mp),
  unlock: (mp: string, sk?: string) => ipcRenderer.invoke("vault:unlock", mp, sk),
  quickUnlock: () => ipcRenderer.invoke("vault:quickUnlock"),
  biometricAvailable: () => ipcRenderer.invoke("vault:biometricAvailable"),
  enableQuickUnlock: () => ipcRenderer.invoke("vault:enableQuickUnlock"),
  disableQuickUnlock: () => ipcRenderer.invoke("vault:disableQuickUnlock"),
  lock: () => ipcRenderer.invoke("vault:lock"),
  copy: (text: string) => ipcRenderer.invoke("vault:copy", text),
  setShortcut: (acc: string) => ipcRenderer.invoke("vault:setShortcut", acc),
  exportBackup: () => ipcRenderer.invoke("vault:exportBackup"),
  exportPlain: () => ipcRenderer.invoke("vault:exportPlain"),
  importPick: () => ipcRenderer.invoke("vault:importPick"),
  importApply: (mp?: string, sk?: string) => ipcRenderer.invoke("vault:importApply", mp, sk),
  generatePassword: (opts: unknown) => ipcRenderer.invoke("vault:generatePassword", opts),
  listVaults: () => ipcRenderer.invoke("vault:listVaults"),
  addVault: (name: string, owner: string, icon: string) => ipcRenderer.invoke("vault:addVault", name, owner, icon),
  updateVault: (id: string, patch: unknown) => ipcRenderer.invoke("vault:updateVault", id, patch),
  deleteVault: (id: string) => ipcRenderer.invoke("vault:deleteVault", id),
  listTypes: (vid: string) => ipcRenderer.invoke("vault:listTypes", vid),
  addType: (vid: string, name: string, icon: string) => ipcRenderer.invoke("vault:addType", vid, name, icon),
  updateType: (vid: string, tid: string, patch: unknown) => ipcRenderer.invoke("vault:updateType", vid, tid, patch),
  deleteType: (vid: string, tid: string) => ipcRenderer.invoke("vault:deleteType", vid, tid),
  reorderTypes: (vid: string, ids: string[]) => ipcRenderer.invoke("vault:reorderTypes", vid, ids),
  listItems: (vid: string) => ipcRenderer.invoke("vault:listItems", vid),
  getItem: (vid: string, iid: string) => ipcRenderer.invoke("vault:getItem", vid, iid),
  addItem: (vid: string, init: unknown) => ipcRenderer.invoke("vault:addItem", vid, init),
  updateItem: (vid: string, item: unknown) => ipcRenderer.invoke("vault:updateItem", vid, item),
  deleteItem: (vid: string, iid: string) => ipcRenderer.invoke("vault:deleteItem", vid, iid),
  moveItem: (vid: string, iid: string, tid: string) => ipcRenderer.invoke("vault:moveItem", vid, iid, tid),
  addAttachment: (vid: string, iid: string, name: string, mime: string, dataB64: string) => ipcRenderer.invoke("vault:addAttachment", vid, iid, name, mime, dataB64),
  readAttachment: (vid: string, aid: string) => ipcRenderer.invoke("vault:readAttachment", vid, aid),
  deleteAttachment: (vid: string, iid: string, aid: string) => ipcRenderer.invoke("vault:deleteAttachment", vid, iid, aid),
  search: (q: string, vid?: string) => ipcRenderer.invoke("vault:search", q, vid),
  setAutoLock: (min: number) => ipcRenderer.invoke("vault:setAutoLock", min),
});

// 大字显示浮层桥。
contextBridge.exposeInMainWorld("umbraLarge", {
  ready: () => ipcRenderer.invoke("largetype:ready"),
  rendered: () => ipcRenderer.invoke("largetype:rendered"),
  close: () => ipcRenderer.invoke("largetype:close"),
  onText: (cb: (text: string) => void) => {
    const l = (_e: unknown, text: string) => cb(text);
    ipcRenderer.on("largetype:text", l);
    return () => ipcRenderer.removeListener("largetype:text", l);
  },
});

// 截图桥（覆盖窗渲染层与设置页共用）。
contextBridge.exposeInMainWorld("umbraShot", {
  getCapture: () => ipcRenderer.invoke("screenshot:getCapture"),
  ready: () => ipcRenderer.invoke("screenshot:ready"),
  cancel: () => ipcRenderer.invoke("screenshot:cancel"),
  finish: (dataUrl: string) => ipcRenderer.invoke("screenshot:finish", dataUrl),
  save: (dataUrl: string) => ipcRenderer.invoke("screenshot:save", dataUrl),
  setInputMode: (active: boolean) => ipcRenderer.invoke("screenshot:setInputMode", active),
  pin: (dataUrl: string, selection: unknown) => ipcRenderer.invoke("screenshot:pin", dataUrl, selection),
  ocr: (dataUrl: string) => ipcRenderer.invoke("screenshot:ocr", dataUrl),
  translate: (dataUrl: string) => ipcRenderer.invoke("screenshot:translate", dataUrl),
  getSettings: () => ipcRenderer.invoke("screenshot:getSettings"),
  setEnabled: (enabled: boolean) => ipcRenderer.invoke("screenshot:setEnabled", enabled),
  setShortcut: (acc: string) => ipcRenderer.invoke("screenshot:setShortcut", acc),
  setGlmKey: (key: string) => ipcRenderer.invoke("screenshot:setGlmKey", key),
  onSession: (cb: (data: { dataUrl: string; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number }) => void) => {
    const l = (_e: unknown, data: any) => cb(data);
    ipcRenderer.on("screenshot:session", l);
    return () => ipcRenderer.removeListener("screenshot:session", l);
  },
});

// 贴图窗口桥。
contextBridge.exposeInMainWorld("umbraSticker", {
  getImage: () => ipcRenderer.invoke("stickers:getImage"),
  move: (x: number, y: number) => ipcRenderer.invoke("stickers:move", x, y),
  setScale: (scale: number) => ipcRenderer.invoke("stickers:setScale", scale),
  showMenu: () => ipcRenderer.invoke("stickers:showMenu"),
  close: () => ipcRenderer.invoke("stickers:close"),
});
