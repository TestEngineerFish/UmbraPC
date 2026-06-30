// 桌面（Electron）集成门面：同步主进程配置 + 启动设备传输层（渲染层连 /ws/device）。
// 浏览器预览（无 window.umbra）下全部 no-op，聊天仍可用。
import { setServerUrl, setDeviceName, chatConn } from "./server";
import * as transport from "./device-transport";
import type { DeviceState, ProviderManifest } from "./device-transport";

export type { DeviceState, ProviderManifest };

interface PublicConfig {
  serverUrl: string;
  deviceId: string;
  deviceName: string;
  hasToken: boolean;
  codingAllowExec: "never" | "confirm" | "always";
  providersFile: string;
}
interface UmbraBridge {
  isDesktop: boolean;
  platform: string;
  getConfig(): Promise<PublicConfig>;
  setConfig(patch: Record<string, unknown>): Promise<PublicConfig>;
  getRegisterInfo(): Promise<{ deviceId: string; deviceName: string; platform: string; token: string; providers: ProviderManifest[] }>;
  getProviders(): Promise<ProviderManifest[]>;
  runTask(taskId: string, provider: string, skill: string, params: Record<string, unknown>): Promise<unknown>;
  confirmResponse(taskId: string, approved: boolean): Promise<void>;
  onTaskProgress(cb: (p: { taskId: string; message: string; extra: Record<string, unknown> }) => void): () => void;
  onConfirmRequest(cb: (c: { taskId: string; summary: string; detail: Record<string, unknown> }) => void): () => void;
}
declare global {
  interface Window {
    umbra?: UmbraBridge;
  }
}

let config: PublicConfig | null = null;

export const isDesktop = (): boolean => !!window.umbra?.isDesktop;
export const getDeviceState = (): DeviceState | null => (isDesktop() ? transport.getState() : null);
export const getDeviceLogs = (): string[] => transport.getLogs();
export const getDesktopConfig = (): PublicConfig | null => config;

// 启动：同步主进程配置（让聊天与设备指向同一服务端/设备名），再启动设备传输层。
export async function initDesktop(onUpdate: (kind: string) => void): Promise<void> {
  if (!isDesktop()) return;
  config = await window.umbra!.getConfig();
  setServerUrl(config.serverUrl);
  setDeviceName(config.deviceName);
  chatConn.reconnect();
  transport.start(onUpdate);
}

// 配置变更：存到主进程（token/devicename），刷新本地缓存，重连聊天与设备传输层。
export async function pushConfig(patch: Record<string, unknown>): Promise<void> {
  if (!isDesktop()) return;
  config = await window.umbra!.setConfig(patch);
  transport.reconnect();
}
