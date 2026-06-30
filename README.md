# UmbraPC

Umbra 私人 AI 助手的 **PC 桌面客户端**（macOS 优先，Electron + TypeScript）。与 `../Umbra`（服务端 + Web 调试页）同级，作为多端家族的一员（未来还有 UmbraWeb / UmbraiOS 等）。

> 设计稿来自 Claude Design（`Umbra Desktop.dc.html`，橙色系）。项目骨架将依据该设计稿生成。

## 它是什么

1. **聊天入口**：连服务端 `/ws/chat`，与其它端共享同一账号(同一 ASSIST_TOKEN)、同一会话，消息跨端实时同步。
2. **执行设备**：把本机能力（程序 → 技能：codex / claude_code / system / 配置的 CLI / computer-use）注册给服务端，由 AI 调用并实时回传进度。
3. **本机管理**：能力总览、任务/确认、系统权限、连接与设置。

## 与服务端的关系

- 服务端：`../Umbra/private_ai_assistant`（FastAPI，不变）。
- 协议：复用现有 `/ws/device`（注册 providers / 收任务 / 回结果·进度 / 执行前确认）与 `/ws/chat`、`/history`、`/capabilities`、`/jobs`、`/files`、`/llm/complete`、`/images/generate`。
- 现有 Python `../Umbra/umbra-client` 作为无界面 headless 客户端保留；UmbraPC 是带界面的 TS 实现，成为 PC 端主力。

## 计划结构（待生成）

```
UmbraPC/
├── package.json
├── electron/            # 主进程（窗口、IPC、系统权限、托盘、自启）
│   ├── main.ts
│   └── preload.ts
├── core/                # 核心引擎（TS）：WS 客户端、Provider 注册与执行、computer-use
│   ├── client.ts        # 连服务端、注册、收发任务、断线补报
│   ├── providers/       # system / codex / claude_code / 配置驱动
│   └── confirm.ts       # 执行前确认通道
├── renderer/            # 界面（依据 Claude Design 设计稿）
│   ├── index.html
│   ├── chat/ tasks/ capabilities/ computer/ logs/ settings/
│   └── styles（橙色系，浅/深模式）
└── shared/              # 协议类型、消息常量（后续可抽成跨端共享包）
```

## 运行（开发）

```bash
cd UmbraPC
npm install

# 方式一：浏览器预览界面（最快看效果，无需 Electron）。仅聊天接真实服务端；
# 设备引擎需 Node 能力（截图/子进程），只在 Electron 桌面应用里运行。
npm run dev            # 打开 http://localhost:5173

# 方式二：桌面窗口（Electron，含设备引擎）—— 自带界面，单条命令，无需 dev server
npm run electron       # 先 vite build + esbuild 打包主进程，再起 Electron（加载本地 dist）

# 方式三：桌面 + 热更新开发（改界面即时生效）
npm run dev            # 终端 A：起 Vite（5173）
npm run electron:dev   # 终端 B：起 Electron 并连 5173（带重试，dev server 稍晚也能连上）

# 类型检查 / 打包
npm run typecheck      # 渲染层 + 主进程两套 tsconfig
npm run build          # 产出 dist/（渲染层），Electron 打包后加载它
npm run build:electron # 单独打包主进程 → dist-electron/
```

技术栈：Electron + Vite + TypeScript（vanilla，无框架，和现有 Web 客户端一脉相承）。

**设备连接的特殊架构（重要）**：`/ws/device` 的 WebSocket 由**渲染层(Chromium)**承载（`src/device-transport.ts`），不是主进程。原因：Electron 主进程的 Node 网络栈(BoringSSL)在部分网络环境（系统代理/WAF）会被 RST，而渲染层的 Chromium 网络栈能正常穿透（聊天 `/ws/chat` 就是证据）。任务的**实际执行**（截图、子进程、文件、Provider 探测、确认闸门）仍在**主进程 Node**（`electron/core/`），渲染层与主进程通过 IPC 桥接：`getRegisterInfo` / `runTask` / `confirmResponse` / `task-progress` / `task-confirm-request`。

渲染层在 `src/`（`main.ts` 界面 + `chat.ts` 聊天 + `server.ts` 连接 + `device-transport.ts` 设备连接 + `desktop.ts` 桥接）；
任务执行器在 `electron/`（主进程 Node，esbuild 打包成 `dist-electron/*.cjs`）。

## 目录结构（现状）

```
UmbraPC/
├── package.json  tsconfig.json  tsconfig.electron.json  vite.config.ts  index.html
├── scripts/build-electron.mjs     # esbuild 打包主进程
├── electron/                      # 主进程（任务执行，TS）
│   ├── main.ts                    # 开窗 + 任务执行器 + IPC
│   ├── preload.ts                 # contextBridge 暴露 window.umbra
│   └── core/
│       ├── config.ts              # 配置（userData 持久化，可被环境变量覆盖）
│       ├── registry.ts            # Provider 注册表（设备→程序→技能）
│       ├── device-client.ts       # TaskExecutor：探测 Provider + 执行技能 + 确认闸门（无 WS）
│       ├── upload.ts util.ts      # 文件上传 / which+子进程
│       └── providers/             # system(截图·文件) / coding(codex·claude_code) / 配置驱动
└── src/                           # 渲染层（界面 + 网络）
    ├── styles.css  main.ts        # 令牌 + 6 个页面
    ├── chat.ts  server.ts         # 聊天 + /ws/chat 连接
    ├── device-transport.ts        # /ws/device 连接（Chromium）：注册/收任务/回传/确认/补报/心跳
    └── desktop.ts                 # 门面：配置同步 + 启动设备传输层
```

## 状态

- [x] 导入 Claude Design 设计稿（`Umbra Desktop.dc.html`）
- [x] Electron + Vite + TS 骨架
- [x] 界面还原：聊天 / 任务 / 能力 / 实时操作 / 日志 / 设置（含主题切换、lightbox、任务抽屉）
- [x] **聊天接真实 `/ws/chat`**：流式回复、工具轨迹、任务进度卡、执行前确认、完成通知、图片预览、跨端同步、`/history` 历史、自动重连
- [x] 设置：服务端地址 / Token / 设备名持久化（localStorage）+ 实时连接状态 + 保存重连
- [x] **设备引擎（主进程，TS）**：连 `/ws/device`、注册 Provider（system / codex / claude_code / providers.json）、收任务执行、回传进度/结果、执行前确认闸门、断线补报 + 心跳；截图 / 文件操作 / coding 已移植
- [x] 能力页（桌面态）展示本机真实 Provider；设置页显示设备引擎状态、coding 权限同步到引擎
- [x] providers.json 读取（不写代码即可登记可控程序与技能）
- [x] 任务页接真实数据（列表/详情走 /jobs，进入轮询，IM 风格时间，结果渲染）
- [x] 系统权限引导（macOS 辅助功能/屏幕录制，读真实状态 + 一键去授权）
- [x] **computer-use Phase C v0（原子动作骨架）**：`computer` Provider（默认关）— open_app/click/type/key/scroll/screenshot，nut.js 执行；安全：总开关 + 权限门禁 + 应用黑名单 + 关键动作确认 + 紧急停止；实时操作页接真实状态。`operate`（自主循环）留可插拔接口待接智谱
- [ ] computer-use Phase C+：`operate` 接决策引擎（智谱 CogAgent/GLM-4V，PC 本地直连）、实时截图监看、低层增强
- [ ] providers.json 内嵌编辑器

### 连接层结构
- `src/server.ts`：配置（服务端/Token/设备名/clientId）+ `/ws/chat` 单例连接（指数退避重连）+ `/history` 拉取。
- `src/chat.ts`：聊天消息模型 + 渲染（驱动设计稿组件）+ 收发/确认/跨端。
- `src/main.ts`：外壳与其余页面；标题栏与设置页连接状态实时反映。

> 已接真实数据：**聊天**（全端）、**能力页 + 设置页设备引擎状态**（桌面应用）。任务 / 实时操作页仍为示例数据，后续接入。
>
> 工作方式：在桌面应用里下达任务时，服务端 AI 看到本机在线、把子任务派发给设备引擎执行，进度/结果实时回到聊天页的任务卡（这条链路即"PC 作为执行设备"）。
>
> 已知点：开发态浏览器预览（localhost:5173）跨域拉 `/history` 可能被 CORS 拦（聊天 WebSocket 不受影响，仍可正常收发）；服务端开启 CORS 或打包成桌面应用后历史即可加载。
