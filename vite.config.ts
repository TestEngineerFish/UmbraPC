import { defineConfig } from "vite";

// 渲染层用 Vite 打包；Electron 主进程单独跑（electron/main.cjs）。
// base 用相对路径，便于 Electron 以 file:// 加载打包后的 dist。
export default defineConfig({
  base: "./",
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
