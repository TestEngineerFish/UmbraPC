// 任务执行器（主进程）。
// 注意：因为 Electron 主进程的网络栈(BoringSSL)在部分环境会被代理/WAF RST，
// 设备 WebSocket 已改由渲染层(Chromium)承载（见 src/device-transport.ts）。
// 主进程只负责：探测 Provider、执行技能、执行前确认——通过 IPC 与渲染层桥接。
import { EventEmitter } from "node:events";
import { ConfigStore } from "./config";
import { buildRegistry } from "./providers";
import { Manifest, Registry } from "./registry";

export interface RegisterInfo {
  deviceId: string;
  deviceName: string;
  platform: string;
  token: string;
  providers: Manifest[];
}

export class TaskExecutor extends EventEmitter {
  private registry: Registry | null = null;
  private pendingConfirms = new Map<string, (approved: boolean) => void>();

  constructor(private store: ConfigStore) {
    super();
  }

  // 重建注册表（每次刷新可用性 / providers.json）。
  async refreshRegistry(): Promise<Registry> {
    this.registry = await buildRegistry(this.store.get());
    return this.registry;
  }

  async getProviders(): Promise<Manifest[]> {
    const r = this.registry || (await this.refreshRegistry());
    return r.providers();
  }

  // 渲染层连上 /ws/device 后用它拼 register 报文。
  async getRegisterInfo(): Promise<RegisterInfo> {
    const cfg = this.store.get();
    const providers = await (await this.refreshRegistry()).providers();
    return {
      deviceId: cfg.deviceId,
      deviceName: cfg.deviceName,
      platform: process.platform,
      token: cfg.token,
      providers,
    };
  }

  // 执行一个任务，返回结果或抛错。进度/确认请求通过事件发给渲染层转发到服务端。
  async runTask(taskId: string, provider: string, skill: string, params: Record<string, unknown>): Promise<unknown> {
    const r = this.registry || (await this.refreshRegistry());
    const handler = r.getHandler(provider);
    if (!handler) throw new Error(`本设备没有该程序：${provider}`);

    const report = async (message: string, extra?: Record<string, unknown>) => {
      this.emit("progress", { taskId, message, extra: extra || {} });
    };
    const confirm = (summary: string, detail?: Record<string, unknown>): Promise<boolean> => {
      const cfg = this.store.get();
      return new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (v: boolean) => {
          if (done) return;
          done = true;
          this.pendingConfirms.delete(taskId);
          resolve(v);
        };
        this.pendingConfirms.set(taskId, finish);
        this.emit("confirm-request", { taskId, summary, detail: detail || {} });
        setTimeout(() => finish(false), cfg.confirmTimeout * 1000);
      });
    };

    return handler(skill, params, report, confirm);
  }

  // 用户对"执行前确认"的回应（由渲染层从 /ws/device 收到后转交）。
  confirmResponse(taskId: string, approved: boolean): void {
    const fn = this.pendingConfirms.get(taskId);
    if (fn) fn(approved);
  }
}
