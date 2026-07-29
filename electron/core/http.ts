// 主进程统一的 HTTP 出口。**主进程里不要再用 Node 全局的 fetch**，一律走这里。
//
// 起因（2026-07-29 实测）：Node 的 fetch（undici 实现）**完全不认系统代理**，
// DNS 也是自己在本机解。用户挂着 VPN / 代理时，本机 DNS 被代理软件接管，
// 服务端域名会解到 127.0.0.1（实测就是），于是主进程发出去的请求全部打在本地某个
// 监听上，TLS 握手被 RST —— 界面上看到的就是「同步失败：fetch failed · ECONNRESET」。
// 而渲染层的请求走 Chromium，域名由代理远端解析，一切正常。这就是「聊天、灵感列表都
// 能用，偏偏常用语同步不行」的全部原因：**它们根本不是同一个网络栈**。
//
// Electron 的 net.fetch 用的是和渲染层同一套 Chromium 网络栈：系统代理、DNS、
// 证书链、PAC 脚本行为全都一致。API 形状与标准 fetch 相同，AbortSignal 也照常支持。
//
// 注意：net.fetch 必须在 app ready 之后调用（目前所有调用方都在 ready 之后）。
import { net } from "electron";

// 用 Parameters/ReturnType 转发签名，避免主进程 tsconfig 没开 DOM lib 时对不上类型。
export function httpFetch(...args: Parameters<typeof net.fetch>): ReturnType<typeof net.fetch> {
  return net.fetch(...args);
}
