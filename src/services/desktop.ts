// 桌面（Electron）集成门面：同步主进程配置 + 启动设备传输层（渲染层连 /ws/device）。
// 浏览器预览（无 window.umbra）下全部 no-op，聊天仍可用。
import { setServerUrl, setDeviceName, chatConn } from "./server";
import * as transport from "./deviceTransport";
import { initRpcHost } from "./rpcHost";
import type { DeviceState, ProviderManifest } from "./deviceTransport";

export type { DeviceState, ProviderManifest };

interface PublicConfig {
  serverUrl: string;
  deviceId: string;
  deviceName: string;
  hasToken: boolean;
  codingAllowExec: "never" | "confirm" | "always";
  providersFile: string;
  computerUseEnabled: boolean;
  computerConfirm: boolean;
  disabledProviders: string[];
}

// providers.json 里的一条自定义程序。
export interface CustomProviderCfg {
  provider: string;
  display_name?: string;
  detect?: string;
  version_cmd?: string[];
  skills?: Record<string, { description?: string; params?: Record<string, string>; command?: string[]; timeout?: number; confirm?: boolean }>;
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
  getPermissions(): Promise<{ accessibility: boolean; screen: string }>;
  openPrivacy(target: string): Promise<unknown>;
  computerStop(): Promise<unknown>;
  pauseShortcuts(): Promise<void>;
  resumeShortcuts(): Promise<void>;
  openProvidersFile(): Promise<string>;
  setDisabled(list: string[]): Promise<PublicConfig>;
  getProvidersConfig(): Promise<CustomProviderCfg[]>;
  saveProvidersConfig(providers: CustomProviderCfg[]): Promise<boolean>;
  onRpc(cb: (msg: { id: string; method: string; args: unknown }) => void): () => void;
  sendRpcResult(id: string, ok: boolean, result: unknown, error?: string): void;
}

export interface Permissions {
  accessibility: boolean;
  screen: string;
}
declare global {
  interface Window {
    umbra?: UmbraBridge;
  }
}

let config: PublicConfig | null = null;
let perms: Permissions = { accessibility: false, screen: "not-determined" };
let customProviders: CustomProviderCfg[] = [];

export const isDesktop = (): boolean => !!window.umbra?.isDesktop;
export const getDeviceState = (): DeviceState | null => (isDesktop() ? transport.getState() : null);
export const getDeviceLogs = (): string[] => transport.getLogs();
export const getDesktopConfig = (): PublicConfig | null => config;
export const getCustomProviders = (): CustomProviderCfg[] => customProviders;
export const isProviderDisabled = (name: string): boolean => !!config?.disabledProviders?.includes(name);

// 切换某程序启用/停用，然后让设备重新注册（registry 据此增删可用性）。
export async function setProviderEnabled(name: string, enabled: boolean): Promise<void> {
  if (!isDesktop()) return;
  const cur = new Set(config?.disabledProviders || []);
  if (enabled) cur.delete(name);
  else cur.add(name);
  config = await window.umbra!.setDisabled([...cur]);
  transport.reconnect();
}

// 读取 / 保存自定义程序（providers.json），保存后让设备重新读取。
export async function reloadCustomProviders(): Promise<CustomProviderCfg[]> {
  if (isDesktop()) customProviders = await window.umbra!.getProvidersConfig();
  return customProviders;
}
export async function saveCustomProviders(list: CustomProviderCfg[]): Promise<void> {
  if (!isDesktop()) return;
  await window.umbra!.saveProvidersConfig(list);
  customProviders = list;
  transport.reconnect();
}
export const getPermissions = (): Permissions => perms;

// 刷新 macOS 权限状态缓存。
export async function refreshPermissions(): Promise<Permissions> {
  if (!isDesktop()) return perms;
  perms = await window.umbra!.getPermissions();
  return perms;
}

// 打开系统设置对应隐私面板。
export function openPrivacy(target: string): void {
  if (isDesktop()) window.umbra!.openPrivacy(target);
}

// computer-use 紧急停止。
export function computerStop(): void {
  if (isDesktop()) window.umbra!.computerStop();
}

// 录制快捷键期间暂停/恢复全局快捷键（避免按下旧快捷键触发功能）。
export function pauseShortcuts(): void {
  if (isDesktop()) window.umbra!.pauseShortcuts();
}
export function resumeShortcuts(): void {
  if (isDesktop()) window.umbra!.resumeShortcuts();
}

// 打开 providers.json 供用户编辑（系统默认编辑器）。
export function openProvidersFile(): void {
  if (isDesktop()) window.umbra!.openProvidersFile();
}

// 启动：同步主进程配置（让聊天与设备指向同一服务端/设备名），再启动设备传输层。
export async function initDesktop(onUpdate: (kind: string) => void): Promise<void> {
  if (!isDesktop()) return;
  initRpcHost(); // 注册渲染层 RPC（替主进程上传等）
  config = await window.umbra!.getConfig();
  setServerUrl(config.serverUrl);
  setDeviceName(config.deviceName);
  chatConn.reconnect();
  await refreshPermissions().catch(() => {});
  await reloadCustomProviders().catch(() => {});
  transport.start(onUpdate);
}

// 配置变更：存到主进程（token/devicename），刷新本地缓存，重连聊天与设备传输层。
export async function pushConfig(patch: Record<string, unknown>): Promise<void> {
  if (!isDesktop()) return;
  config = await window.umbra!.setConfig(patch);
  transport.reconnect();
}
