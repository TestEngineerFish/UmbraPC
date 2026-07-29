// macOS 激活抑制窗口。
//
// 背景：main.ts 里有 `app.on("activate", () => showMainWindow())`，本意是「点 Dock 图标唤起主窗口」。
// 但 macOS 的 activate 不只在点 Dock 时触发 —— 悬浮面板（快捷入口 / 剪贴板 / 截图覆盖窗）
// 自己 show() + focus() 时会顺带激活整个 app，同样会触发它。结果是一连串问题：
//   · showMainWindow() 里的 app.dock.show() 是个不便宜的系统调用，卡在唤起面板的关键路径上；
//   · 主窗口被 show()+focus()，把键盘焦点从面板抢走（快捷入口为此加过 600ms 的 blur 忽略窗口）；
//   · 首次唤起还会顺带把主窗口整棵 React 树建出来渲染一遍，紧接着收起时 app.hide()
//     又要把这个刚画出来的窗口藏回去 —— 肉眼就是「转一秒菊花」。
//
// 所以面板在自己 show() 之前先打开这个抑制窗口，activate 回调在窗口期内直接跳过。
// 用时间窗而不是布尔量：activate 是异步送达的，show() 之后才到，拿不准具体在第几个 tick。
let suppressUntil = 0;

// 面板即将 show()/focus() 时调用。ms 覆盖 activate 送达的时间即可，不必长。
export function suppressAppActivate(ms = 800): void {
  suppressUntil = Date.now() + ms;
}

// activate 回调里调用：true 表示这次激活是面板自己带出来的，别去唤起主窗口。
export function isAppActivateSuppressed(): boolean {
  return Date.now() < suppressUntil;
}
