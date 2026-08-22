// 工作流编排 独立窗口入口。
import { WorkflowEditor } from "./WorkflowEditor";
import "../../styles/index.css";
import { mountApp } from "../../i18n/bootstrap";
import { OverlayHost } from "../../components/overlay";

// 跟随系统浅/深色。
const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");

void mountApp(document.getElementById("workflow-root")!, <><WorkflowEditor onClose={() => window.close()} />{/* 独立窗口也要挂一份浮层宿主 —— 它只在主窗口的 App 里挂了一份，
    这两个窗口是各自独立的 React 根，拿不到那一份。不挂的话 askConfirm 会静默失效。 */}<OverlayHost /></>);
