// 工作流编排 独立窗口入口。
import { WorkflowEditor } from "./WorkflowEditor";
import "../../styles/index.css";
import { mountApp } from "../../i18n/bootstrap";

// 跟随系统浅/深色。
const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");

void mountApp(document.getElementById("workflow-root")!, <WorkflowEditor onClose={() => window.close()} />);
