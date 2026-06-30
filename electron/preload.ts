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
