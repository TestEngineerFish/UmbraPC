// Provider 注册表（设备 → 程序 → 技能）。与 Python umbra-client/capabilities 对齐。
export type Report = (message: string, extra?: Record<string, unknown>) => Promise<void>;
export type Confirm = (summary: string, detail?: Record<string, unknown>) => Promise<boolean>;
export type Handler = (skill: string, params: Record<string, unknown>, report: Report, confirm: Confirm) => Promise<unknown>;

export interface SkillSpec {
  description: string;
  params: Record<string, string>;
}
export interface Manifest {
  provider: string;
  display_name: string;
  kind: "program" | "system";
  available: boolean;
  unavailable_reason: string;
  version: string | null;
  skills: Record<string, SkillSpec>;
}

// 一个注册表实例聚合本机所有 Provider 的 manifest 与 handler。
export class Registry {
  private manifests = new Map<string, Manifest>();
  private handlers = new Map<string, Handler>();

  register(manifest: Manifest, handler: Handler): void {
    this.manifests.set(manifest.provider, manifest);
    this.handlers.set(manifest.provider, handler);
  }

  getHandler(provider: string): Handler | undefined {
    return this.handlers.get(provider);
  }

  providerNames(): string[] {
    return [...this.manifests.keys()].sort();
  }

  // 注册时上报给服务端的 manifest 列表。
  providers(): Manifest[] {
    return this.providerNames().map((n) => this.manifests.get(n)!);
  }
}
