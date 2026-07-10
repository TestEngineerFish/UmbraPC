// 密码保险箱 独立窗口入口。
import { VaultApp } from "./VaultApp";
import "../../styles/index.css";
import { mountApp } from "../../i18n/bootstrap";

const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");

void mountApp(document.getElementById("vault-root")!, <VaultApp />);
