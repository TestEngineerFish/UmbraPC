// 多屏统一口径（任务 #61 · 设计草案《电脑操控优化》§3.5「坐标一致性」）。
//
// 病根：截屏用 `screencapture` 的默认屏、点击换算用 nut-js 的主屏宽高 ——
// 多屏下这可能根本不是同一块屏（外接屏当主屏时尤甚）：视觉模型看着 A 屏的截图
// 给出归一化坐标，鼠标却按 B 屏的尺寸落点，整段操控全部点偏。
//
// 口径：**截屏与点击换算都锚定「鼠标所在的那块屏」**。operate 闭环里这天然自洽 ——
// 每次点击后鼠标就停在目标屏上，下一轮截图自动跟着同一块屏；首轮截的是用户
// 正在用的屏（鼠标在哪屏就截哪屏），比盲目截主屏更符合预期。
// 草案原方案是「截图带回 display 信息、点击透传同一块屏」——那要在 operate 协议里
// 加字段并改服务端循环；共同锚点（光标）达成同一个目标且零协议改动，故以此落地
// （已知边界：截图与点击之间用户把鼠标甩去另一块屏，会偏一次，下一轮自愈）。
//
// 实现要点：放弃 `screencapture -D 序号`（它的屏序与 Electron 显示器列表的顺序
// 无从对应，映射错了比不修还糟），改用 `-R x,y,w,h` 按**全局逻辑坐标矩形**截 ——
// 与 Electron display.bounds 同一坐标系，零映射；Retina 下 -R 收逻辑点、出全分辨率
// 图，归一化坐标(0-1000)与分辨率无关，两头都不受缩放影响。
// electron 走惰性 import：这个文件被 vitest 直接引（纯函数部分），顶层 import
// electron 会让 node 环境的测试当场炸掉（computer.ts 全文件同一风格）。

export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/// 鼠标所在显示器的 bounds（全局逻辑坐标；主屏原点 (0,0)，副屏可为负/超宽）。
export async function cursorDisplayBounds(): Promise<DisplayRect> {
  const { screen } = await import("electron");
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
}

/// 归一化坐标(0-1000，相对一块屏的截图) → 全局逻辑坐标。
/// 越界值收敛到边缘（视觉模型偶尔给 1003 这种越界值，点到隔壁屏比收边更糟）；
/// NaN 原样传染出去，交给调用方的参数校验兜底报错。
export function normToGlobal(b: DisplayRect, nx: number, ny: number): { x: number; y: number } {
  const cx = Math.min(1000, Math.max(0, nx));
  const cy = Math.min(1000, Math.max(0, ny));
  return {
    x: b.x + Math.round((b.width * cx) / 1000),
    y: b.y + Math.round((b.height * cy) / 1000),
  };
}

/// screencapture 的参数组：锚定鼠标所在屏（-R 全局矩形）。
/// Electron screen 模块不可用时（理论上只有 app ready 前）回退整参数 ——
/// 宁可退回旧行为（默认屏）也别让截屏整个挂掉。
export async function screencaptureArgs(outfile: string): Promise<string[]> {
  try {
    const b = await cursorDisplayBounds();
    return ["-x", "-R", `${b.x},${b.y},${b.width},${b.height}`, outfile];
  } catch {
    return ["-x", outfile];
  }
}
