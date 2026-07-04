import { createRoot } from "react-dom/client";
import { App } from "./ScreenshotApp";

// 不用 StrictMode：截图交互大量依赖 ref/命中检测，避免开发期双调用带来的干扰
// （对象创建等副作用都在事件处理里，不在渲染中，符合文档 5.2 的约束）。
createRoot(document.getElementById("shot-root")!).render(<App />);
