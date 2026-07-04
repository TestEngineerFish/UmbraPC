// 剪贴板历史面板窗口入口。
import { Panel } from "./ClipboardPanel";
import { mountApp } from "../../i18n/bootstrap";

void mountApp(document.getElementById("clip-root")!, <Panel />);
