import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 渲染层用 Vite 打包；Electron 主进程单独跑（electron/main.cjs）。
// base 用相对路径，便于 Electron 以 file:// 加载打包后的 dist。
// React 仅用于截图窗口（screenshot.html），其余入口为 vanilla TS。
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // 渲染入口：主窗口 + 剪贴板面板 + 截图窗口 + 贴图 + 快捷入口
      input: {
        main: "index.html",
        panel: "clipboard-panel.html",
        screenshot: "screenshot.html",
        sticker: "sticker.html",
        launcher: "launcher.html",
        workflow: "workflow.html",
        largetype: "largetype.html",
        vault: "vault.html",
      },
    },
  },
});
