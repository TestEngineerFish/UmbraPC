// electron 的空壳：测试只覆盖纯逻辑，不会真调到这些 API。
// 有它是为了让 import 链能解析——主进程模块顶层 import { net } from "electron"，
// 少了它整个文件都加载不了，纯函数也一起测不了。
export const net = {
  fetch: () => Promise.reject(new Error("测试环境不发真实请求")),
};
export const app = { getPath: () => "/tmp" };
export const ipcMain = { handle: () => {}, on: () => {} };
export const clipboard = { readText: () => "", writeText: () => {} };
// 记下每一次 openExternal 的地址：网页搜索节点的价值全在「拼出来的地址对不对」，
// 不记下来就只能测报错分支，最该测的那条反而测不到。
export const openedUrls: string[] = [];
export const shell = {
  openPath: () => Promise.resolve(""),
  openExternal: (u: string) => { openedUrls.push(u); return Promise.resolve(); },
};
// 对话框要按下标返回「用户点了哪个按钮」。测试往 dialogPicks 里塞一个下标，
// 壳就按它回。不给就当点了第一个。
export const dialogPicks: number[] = [];
// 数一下弹了几次框。无头运行时对话框必须**压根不弹** —— 弹了就会一直挂着等人点，
// 而「挂住」在测试里表现为超时，不看这个计数就只能靠肉眼发现。
export const dialogCalls = { n: 0 };
export const dialog = {
  showMessageBox: (_opts: unknown) => {
    dialogCalls.n++;
    return Promise.resolve({ response: dialogPicks.length ? dialogPicks[0] : 0, checkboxChecked: false });
  },
};
export const systemPreferences = { canPromptTouchID: () => false };
export const safeStorage = { isEncryptionAvailable: () => false };
export const BrowserWindow = class {
  static getAllWindows(): unknown[] { return []; }
  isDestroyed(): boolean { return false; }
  isFocused(): boolean { return false; }
  isVisible(): boolean { return false; }
  show(): void {}
  focus(): void {}
  showInactive(): void {}
  hide(): void {}
};
export const globalShortcut = { register: () => false, isRegistered: () => false };
export default { net, app, ipcMain, clipboard, shell, dialog, systemPreferences, safeStorage, BrowserWindow, globalShortcut };
