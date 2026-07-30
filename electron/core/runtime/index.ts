// 运行时环境的 IPC 注册。只读能力，所以只有一个 handle。
//
// 刻意**不做缓存**：用户点刷新就是想要现在的实况（他很可能刚在终端里装了个新版本切回来看）。
// 缓存要等到文件系统监听做完再加（见 doc/运行时环境-设计与待办.md 二期）。
import { ipcMain } from "electron";
import { scanRuntime } from "./scan";
import type { RuntimeKind } from "./parse";

const KINDS: RuntimeKind[] = ["java", "python"];

export function registerRuntimeIpc(): void {
  // 失败不 reject：Electron 会为未捕获的 handler 异常刷一堆 "Error occurred in handler" 日志，
  // 而这里任何一步失败都不该让整页白屏 —— 返回一个只带 partial 的空结果，UI 照样能显示原因。
  ipcMain.handle("runtime:scan", async (_e, kind: string) => {
    const k = (KINDS as string[]).includes(kind) ? (kind as RuntimeKind) : "python";
    try {
      return await scanRuntime(k);
    } catch (err) {
      return {
        kind: k, installs: [], actives: [], issues: [], managers: [], aliases: {}, pathDirs: [],
        scannedAt: Date.now(), elapsedMs: 0,
        partial: [`扫描失败：${String(err).replace("Error: ", "").slice(0, 200)}`],
      };
    }
  });
}
