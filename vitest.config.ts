// 单元测试配置。测试跑在 node 环境里，只覆盖**纯逻辑**：排序内核、拼音、
// 连接配置、节点摘要这类不碰 DOM 的东西。
//
// 为什么不上 jsdom：组件渲染的测试价值远低于维护成本（这些页面改版很频繁），
// 而上面那几块逻辑一旦错了很难靠肉眼发现——排序权重、多音字展开、配置真源，
// 都是「看着没问题、实际结果不对」的类型。要测组件时再单独引 jsdom 不迟。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 主进程代码 import 了 electron，测试里不会真跑到那些分支，给个空壳挡住解析。
    alias: { electron: new URL("./tests/stubs/electron.ts", import.meta.url).pathname },
  },
});
