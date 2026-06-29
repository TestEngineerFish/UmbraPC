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

# 方式一：浏览器预览界面（最快看效果，无需 Electron）
npm run dev            # 打开 http://localhost:5173

# 方式二：桌面窗口（Electron）
npm run dev            # 先起 Vite（一个终端）
npm run electron       # 再起 Electron（另一个终端，加载 5173）

# 类型检查 / 打包
npm run typecheck
npm run build          # 产出 dist/，Electron 打包后加载它
```

技术栈：Electron + Vite + TypeScript（vanilla，无框架，和现有 Web 客户端一脉相承）。
界面在 `src/`（`main.ts` 渲染 + `styles.css` 令牌），桌面外壳在 `electron/`。

## 目录结构（现状）

```
UmbraPC/
├── package.json  tsconfig.json  vite.config.ts  index.html
├── electron/
│   ├── main.cjs       # 主进程：开发加载 Vite，打包加载 dist
│   └── preload.cjs    # 预留：把核心引擎安全暴露给渲染层
└── src/
    ├── styles.css     # 橙色系令牌 + 浅/深双模式 + 动画
    └── main.ts        # 渲染层：6 个页面 + 交互（依据 Claude Design 设计稿还原）
```

## 状态

- [x] 导入 Claude Design 设计稿（`Umbra Desktop.dc.html`）
- [x] Electron + Vite + TS 骨架
- [x] 界面还原：聊天 / 任务 / 能力 / 实时操作 / 日志 / 设置（含主题切换、lightbox、任务抽屉）
- [x] **聊天接真实 `/ws/chat`**：流式回复、工具轨迹、任务进度卡、执行前确认、完成通知、图片预览、跨端同步、`/history` 历史、自动重连
- [x] 设置：服务端地址 / Token / 设备名持久化（localStorage）+ 实时连接状态 + 保存重连
- [ ] 设备引擎（主进程）：`/ws/device` 注册 Provider + 任务执行 + 确认闸门 + 文件/截图（→ 任务/能力页接真实数据）
- [ ] providers.json 读写
- [ ] computer-use（Phase C）

### 连接层结构
- `src/server.ts`：配置（服务端/Token/设备名/clientId）+ `/ws/chat` 单例连接（指数退避重连）+ `/history` 拉取。
- `src/chat.ts`：聊天消息模型 + 渲染（驱动设计稿组件）+ 收发/确认/跨端。
- `src/main.ts`：外壳与其余页面；标题栏与设置页连接状态实时反映。

> 已接真实数据：**聊天**。任务 / 能力 / 实时操作页仍为示例数据，待设备引擎接入后变真实。
>
> 已知点：开发态浏览器预览（localhost:5173）跨域拉 `/history` 可能被 CORS 拦（聊天 WebSocket 不受影响，仍可正常收发）；服务端开启 CORS 或打包成桌面应用后历史即可加载。
