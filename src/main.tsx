// 主窗口入口。
import { App } from "./app/App";
import "./styles/index.css";
import { mountApp } from "./i18n/bootstrap";

void mountApp(document.getElementById("app")!, <App />);
