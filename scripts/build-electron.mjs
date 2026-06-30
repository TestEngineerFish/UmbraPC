// 用 esbuild 把 Electron 主进程/预加载（TS）打包成 CJS 到 dist-electron/。
// 监听模式：node scripts/build-electron.mjs --watch
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // electron 由运行时提供；nut.js 含原生模块需从 node_modules 运行时加载（不打包）。
  external: ["electron", "bufferutil", "utf-8-validate", "@nut-tree-fork/nut-js"],
  sourcemap: true,
  logLevel: "info",
};

const targets = [
  { entryPoints: ["electron/main.ts"], outfile: "dist-electron/main.cjs" },
  { entryPoints: ["electron/preload.ts"], outfile: "dist-electron/preload.cjs" },
];

if (watch) {
  for (const t of targets) {
    const ctx = await esbuild.context({ ...common, ...t });
    await ctx.watch();
  }
  console.log("esbuild 监听中…");
} else {
  await Promise.all(targets.map((t) => esbuild.build({ ...common, ...t })));
  console.log("electron 打包完成 → dist-electron/");
}
