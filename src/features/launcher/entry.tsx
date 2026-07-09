// 快捷入口浮层窗入口。
import { Launcher } from "./Launcher";
import { mountApp } from "../../i18n/bootstrap";

void mountApp(document.getElementById("launcher-root")!, <Launcher />);
