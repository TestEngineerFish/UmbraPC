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
      // ⚠️ 这里以前回的是 `issues: []`，而上面那句注释写着「UI 照样能显示原因」——
      // 其实显示不了：界面只渲染 issues，partial 是通过 diagnoseEnv 转成 E3 才露面的，
      // 而走到这个 catch 说明 diagnoseEnv 压根没跑到。结果就是整页扫描炸了之后
      // 界面一片空白、一个字的原因都没有。所以这里自己把失败原因包成一条 issue。
      const reason = `扫描失败：${String(err).replace("Error: ", "").slice(0, 200)}`;
      return {
        kind: k, installs: [], actives: [], managers: [], aliases: {},
        pathDirs: [], appPathDirs: [], shellPathDirs: [],
        issues: [{
          code: "E0", level: "error" as const,
          title: "运行时扫描没能完成",
          detail: `${reason}\n下面的清单是空的，不代表你机器上没装 —— 是这次没扫成。`,
          fix: "",
        }],
        scannedAt: Date.now(), elapsedMs: 0,
        partial: [reason],
      };
    }
  });
}
