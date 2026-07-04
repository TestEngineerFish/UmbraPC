// 剪贴板历史面板窗口入口。
import { createRoot } from "react-dom/client";
import { Panel } from "./ClipboardPanel";

createRoot(document.getElementById("clip-root")!).render(<Panel />);
