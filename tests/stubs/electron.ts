// electron 的空壳：测试只覆盖纯逻辑，不会真调到这些 API。
// 有它是为了让 import 链能解析——主进程模块顶层 import { net } from "electron"，
// 少了它整个文件都加载不了，纯函数也一起测不了。
export const net = {
  fetch: () => Promise.reject(new Error("测试环境不发真实请求")),
};
export const app = { getPath: () => "/tmp" };
export const ipcMain = { handle: () => {}, on: () => {} };
export const clipboard = { readText: () => "", writeText: () => {} };
export const shell = { openPath: () => Promise.resolve("") };
export const systemPreferences = { canPromptTouchID: () => false };
export const safeStorage = { isEncryptionAvailable: () => false };
export const BrowserWindow = class {};
export const globalShortcut = { register: () => false, isRegistered: () => false };
export default { net, app, ipcMain, clipboard, shell, systemPreferences, safeStorage, BrowserWindow, globalShortcut };
