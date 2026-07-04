// 截图覆盖窗入口。
import { App } from "./ScreenshotApp";
import { mountApp } from "../../i18n/bootstrap";

void mountApp(document.getElementById("shot-root")!, <App />);
