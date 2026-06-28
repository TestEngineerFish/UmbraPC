// 预加载脚本：以后把核心引擎（连服务端、Provider 执行、computer-use、
// 系统权限、打开文件夹等）通过 contextBridge 安全暴露给渲染层。
// 目前先占位，渲染层在浏览器/Electron 中都能跑（无该桥接时降级为纯界面）。
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("umbra", {
  platform: process.platform,
  // 预留：connect/registerProviders/onTask/sendResult/confirm/openLogsDir 等
});
