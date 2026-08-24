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
  // runTask 的失败以 {__umbraErr} 结构化返回（主进程不 reject，避免 Electron 刷
  // "Error occurred in handler" 噪声日志）；这里还原成 throw，渲染层语义不变。
  runTask: async (taskId: string, provider: string, skill: string, params: Record<string, unknown>) => {
    const r = await ipcRenderer.invoke("umbra:runTask", taskId, provider, skill, params);
    if (r && typeof r === "object" && (r as { __umbraErr?: string }).__umbraErr) {
      throw new Error((r as { __umbraErr: string }).__umbraErr);
    }
    return r;
  },
  confirmResponse: (taskId: string, approved: boolean) => ipcRenderer.invoke("umbra:confirmResponse", taskId, approved),
  cancelTask: (taskId: string) => ipcRenderer.invoke("umbra:cancelTask", taskId),

  // macOS 权限
  getPermissions: () => ipcRenderer.invoke("umbra:getPermissions"),
  openPrivacy: (target: string) => ipcRenderer.invoke("umbra:openPrivacy", target),
  // 开机自启：只写；当前状态从 getConfig().openAtLogin 读（系统设置才是唯一真相）。
  setLoginItem: (on: boolean) => ipcRenderer.invoke("umbra:setLoginItem", on),
  openPath: (path: string) => ipcRenderer.invoke("umbra:openPath", path),
  // 列目录顶层内容（工作区详情页的「目录内容」栏）。
  listDir: (path: string, limit?: number) => ipcRenderer.invoke("umbra:listDir", path, limit),
  // computer-use 紧急停止
  computerStop: () => ipcRenderer.invoke("umbra:computerStop"),
  // 录制快捷键期间暂停/恢复全局快捷键
  pauseShortcuts: () => ipcRenderer.invoke("umbra:pauseShortcuts"),
  resumeShortcuts: () => ipcRenderer.invoke("umbra:resumeShortcuts"),
  // 打开 providers.json 供编辑
  openProvidersFile: () => ipcRenderer.invoke("umbra:openProvidersFile"),
  openLogsFolder: () => ipcRenderer.invoke("umbra:openLogsFolder"),
  appendLog: (line: string) => ipcRenderer.invoke("umbra:appendLog", line),
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
  clearFavorites: () => ipcRenderer.invoke("clip:clearFavorites"),
  readImageDataUrl: (id: number) => ipcRenderer.invoke("clip:readImageDataUrl", id),
  readPathThumbnail: (p: string) => ipcRenderer.invoke("clip:readPathThumbnail", p),
  getAppIcon: (p: string) => ipcRenderer.invoke("clip:getAppIcon", p),
  hidePanel: () => ipcRenderer.invoke("clip:hidePanel"),
  getSettings: () => ipcRenderer.invoke("clip:getSettings"),
  setEnabled: (enabled: boolean) => ipcRenderer.invoke("clip:setEnabled", enabled),
  setShortcut: (acc: string) => ipcRenderer.invoke("clip:setShortcut", acc),
  setAutoPaste: (on: boolean) => ipcRenderer.invoke("clip:setAutoPaste", on),
  setKeep: (keep: unknown) => ipcRenderer.invoke("clip:setKeep", keep),
  setPhrasesShortcut: (acc: string) => ipcRenderer.invoke("clip:setPhrasesShortcut", acc),
  onHistoryChanged: (cb: () => void) => {
    const l = () => cb();
    ipcRenderer.on("clipboard:history:changed", l);
    return () => ipcRenderer.removeListener("clipboard:history:changed", l);
  },
  // 参数是本次唤起要停留的分类（剪贴板快捷键 → all，常用语快捷键 → phrase）。
  onPanelShown: (cb: (category: string) => void) => {
    const l = (_e: unknown, category: string) => cb(category || "all");
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
  getWorkflows: () => ipcRenderer.invoke("launcher:getWorkflows"),
  setWorkflows: (workflows: unknown) => ipcRenderer.invoke("launcher:setWorkflows", workflows),
  openWorkflowEditor: () => ipcRenderer.invoke("launcher:openWorkflowEditor"),
  // 打开这条工作流自己的目录（随行脚本/可执行文件都放在里面）。
  openWorkflowDir: (wfId: string) => ipcRenderer.invoke("launcher:openWorkflowDir", wfId),
  // 预制件（E3）：存起来的节点组，可在任意工作流里一键落地。
  getPrefabs: () => ipcRenderer.invoke("launcher:getPrefabs"),
  setPrefabs: (prefabs: unknown) => ipcRenderer.invoke("launcher:setPrefabs", prefabs),
  // 工作流配置项里的密钥（W10）：明文交给密码保险箱，换回一条 vault://... 引用存进工作流。
  setWfSecret: (ref: string, title: string, value: string) => ipcRenderer.invoke("launcher:setWfSecret", ref, title, value),
  vaultUnlocked: () => ipcRenderer.invoke("launcher:vaultUnlocked"),
  // wfId/nodeId = 正在编辑的那个节点。主进程据此把「它自己占的键」排除掉，
  // 否则保存后再打开必然误报一句「已经用在别处了」。
  checkAccel: (accel: string, wfId?: string, nodeId?: string) =>
    ipcRenderer.invoke("launcher:checkAccel", accel, wfId, nodeId),
  // 工作流调试轨迹（编辑器底部调试抽屉）：拉最近若干次执行记录 / 清空 / 订阅新记录。
  // 编辑器顶栏「运行」：nodeId 留空则自动挑第一个可用触发器。
  runWorkflow: (wfId: string, nodeId: string, arg: string) => ipcRenderer.invoke("launcher:runWorkflow", wfId, nodeId, arg),
  getTrace: (wfId?: string) => ipcRenderer.invoke("launcher:getTrace", wfId || ""),
  clearTrace: () => ipcRenderer.invoke("launcher:clearTrace"),
  onTrace: (cb: (run: unknown) => void) => {
    const l = (_e: unknown, run: unknown) => cb(run);
    ipcRenderer.on("launcher:trace", l);
    return () => ipcRenderer.removeListener("launcher:trace", l);
  },
  // ⌘Y 预览（W3 的 quicklookurl）：把 URL/路径交给主进程用系统默认程序打开，面板不收起。
  quicklook: (target: string) => ipcRenderer.invoke("launcher:quicklook", target),
  // Script Filter 的 rerun（W3）：主进程到点自动重查后，把新结果推回来。
  onResults: (cb: (payload: { q: string; results: unknown[] }) => void) => {
    const l = (_e: unknown, payload: { q: string; results: unknown[] }) => cb(payload);
    ipcRenderer.on("launcher:results", l);
    return () => ipcRenderer.removeListener("launcher:results", l);
  },
  fileIcon: (p: string) => ipcRenderer.invoke("launcher:fileIcon", p),
  getPhrases: () => ipcRenderer.invoke("launcher:getPhrases"),
  setPhrases: (phrases: unknown) => ipcRenderer.invoke("launcher:setPhrases", phrases),
  // 常用语云端同步：手动触发 / 读状态 / 订阅同步后的变更（多设备共用一份短语库）。
  phrasesSyncNow: () => ipcRenderer.invoke("launcher:phrasesSyncNow"),
  phrasesSyncState: () => ipcRenderer.invoke("launcher:phrasesSyncState"),
  onPhrasesChanged: (cb: (list: unknown) => void) => {
    const h = (_e: unknown, list: unknown) => cb(list);
    ipcRenderer.on("launcher:phrases:changed", h);
    return () => ipcRenderer.removeListener("launcher:phrases:changed", h);
  },
  resize: (h: number) => ipcRenderer.invoke("launcher:resize", h),
  pickPath: () => ipcRenderer.invoke("launcher:pickPath"),
  pickApp: () => ipcRenderer.invoke("launcher:pickApp"),
  // prefill：Hotkey 节点的「打开快捷入口」会带一段预填内容过来（关键词 + 参数）。
  // 普通唤起是 null。
  onShown: (cb: (prefill: { q: string; caret?: "left" | "right" } | null) => void) => {
    const l = (_e: unknown, prefill: { q: string; caret?: "left" | "right" } | null) => cb(prefill || null);
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
  syncNow: () => ipcRenderer.invoke("vault:syncNow"),
  syncReset: () => ipcRenderer.invoke("vault:syncReset"),
  // 自动同步的状态广播。pulled=true 表示本地数据被云端改过，界面要重新拉一遍列表。
  onSyncState: (cb: (s: { syncing: boolean; lastAt: number; lastError: string; pulled: boolean }) => void) => {
    const l = (_e: unknown, s: { syncing: boolean; lastAt: number; lastError: string; pulled: boolean }) => cb(s);
    ipcRenderer.on("vault:syncState", l);
    return () => ipcRenderer.removeListener("vault:syncState", l);
  },
  setShortcut: (acc: string) => ipcRenderer.invoke("vault:setShortcut", acc),
  exportBackup: () => ipcRenderer.invoke("vault:exportBackup"),
  exportPlain: () => ipcRenderer.invoke("vault:exportPlain"),
  importPick: () => ipcRenderer.invoke("vault:importPick"),
  importApply: (vid: string, mp?: string, sk?: string) => ipcRenderer.invoke("vault:importApply", vid, mp, sk),
  downloadTemplate: (kind: string) => ipcRenderer.invoke("vault:downloadTemplate", kind),
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
  deleteItems: (vid: string, ids: string[]) => ipcRenderer.invoke("vault:deleteItems", vid, ids),
  moveItem: (vid: string, iid: string, tid: string) => ipcRenderer.invoke("vault:moveItem", vid, iid, tid),
  addAttachment: (vid: string, iid: string, name: string, mime: string, dataB64: string) => ipcRenderer.invoke("vault:addAttachment", vid, iid, name, mime, dataB64),
  readAttachment: (vid: string, aid: string) => ipcRenderer.invoke("vault:readAttachment", vid, aid),
  deleteAttachment: (vid: string, iid: string, aid: string) => ipcRenderer.invoke("vault:deleteAttachment", vid, iid, aid),
  search: (q: string, vid?: string) => ipcRenderer.invoke("vault:search", q, vid),
  setAutoLock: (min: number) => ipcRenderer.invoke("vault:setAutoLock", min),
  // 回收站（需要解锁；锁着时主进程直接抛「保险箱已锁定」）。
  // 条数不在这里 —— 它在 status() 里，因为锁着的时候也要显示。
  listTrash: () => ipcRenderer.invoke("vault:listTrash"),
  restoreTrash: (entries: { vaultId: string; itemId: string }[]) => ipcRenderer.invoke("vault:restoreTrash", entries),
  purgeTrash: (entries: { vaultId: string; itemId: string }[]) => ipcRenderer.invoke("vault:purgeTrash", entries),
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

// 文本视图浮层桥（长文/Markdown/流式追加，工作流的 output.textview 与 ask_assistant 用）。
contextBridge.exposeInMainWorld("umbraText", {
  ready: () => ipcRenderer.invoke("textview:ready"),
  rendered: () => ipcRenderer.invoke("textview:rendered"),
  close: () => ipcRenderer.invoke("textview:close"),
  onData: (cb: (p: unknown) => void) => {
    const l = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on("textview:data", l);
    return () => ipcRenderer.removeListener("textview:data", l);
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
  // 滚动长截图：start 之后主进程接管抓帧，进度/结果通过下面两个事件推回来。
  scrollStart: (selection: unknown) => ipcRenderer.invoke("screenshot:scrollStart", selection),
  scrollStop: (commit: boolean) => ipcRenderer.invoke("screenshot:scrollStop", commit),
  scrollAuto: (on: boolean) => ipcRenderer.invoke("screenshot:scrollAuto", on),
  onScrollProgress: (cb: (p: unknown) => void) => {
    const l = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on("screenshot:scrollProgress", l);
    return () => ipcRenderer.removeListener("screenshot:scrollProgress", l);
  },
  onScrollDone: (cb: (p: unknown) => void) => {
    const l = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on("screenshot:scrollDone", l);
    return () => ipcRenderer.removeListener("screenshot:scrollDone", l);
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

// 运行时环境（Java / Python 多版本）桥。只读能力，所以只有一个方法。
contextBridge.exposeInMainWorld("umbraRuntime", {
  scan: (kind: string) => ipcRenderer.invoke("runtime:scan", kind),
});
