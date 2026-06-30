// 主进程 → 渲染层 RPC：让主进程把"需要 Chromium 网络"的活（如文件上传）交给渲染层做，
// 绕开主进程 Node 网络被代理/WAF RST 的问题（与设备 WS 走渲染层同理）。
import { ipcMain, WebContents } from "electron";

let target: WebContents | null = null;
let wired = false;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();

export function initRpc(wc: WebContents): void {
  target = wc;
  if (wired) return;
  wired = true;
  ipcMain.on("umbra:rpc-result", (_e, msg: any) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || "renderer rpc failed"));
  });
}

// 向渲染层发起一次 RPC，等待其结果。
export function askRenderer<T = any>(method: string, args: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!target) return reject(new Error("renderer 未就绪"));
    const id = Math.random().toString(36).slice(2);
    pending.set(id, { resolve, reject });
    target.send("umbra:rpc", { id, method, args });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("renderer rpc 超时"));
      }
    }, 60000);
  });
}
