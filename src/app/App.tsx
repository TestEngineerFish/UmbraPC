// 主窗口根组件：React 接管根节点，托管 legacy 标题栏/侧边栏(shell)，各页面为 React 组件；仅聊天页走 LegacyHost 挂载。
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import * as legacy from "./shell";
import type { Nav } from "./shell";
import { Settings } from "../features/settings/Settings";
import { Logs } from "../features/logs/Logs";
import { Realtime } from "../features/realtime/Realtime";
import { Tasks } from "../features/tasks/Tasks";
import { Inspirations } from "../features/inspiration/Inspirations";
import { Abilities } from "../features/abilities/Abilities";
import { subscribeLocale } from "../i18n";

// 把 legacy 生成的 HTML 挂进一个 div，挂载后还原滚动位置 / 触发回调（如挂载聊天子树）。
function LegacyHost({ html, onMounted, style }: { html: string; onMounted?: () => void; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = el.querySelector<HTMLElement>("#scroll-main")?.scrollTop;
    el.innerHTML = html;
    if (prev != null) {
      const s = el.querySelector<HTMLElement>("#scroll-main");
      if (s) s.scrollTop = prev;
    }
    onMounted?.();
  });
  return <div ref={ref} style={style} />;
}

export function App() {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [nav, setNav] = useState<Nav>(legacy.getNav());

  useEffect(() => {
    legacy.setBridge(() => bump(), (n) => setNav(n));
    legacy.initLegacy();
    return subscribeLocale(() => bump());
  }, []);

  const dark = legacy.isDark();
  return (
    <div className="umbra-root" data-theme={dark ? "dark" : "light"} data-nav={nav} style={{ height: "100vh", display: "flex", flexDirection: "column", position: "relative" }}>
      {/* 标题栏宿主用 block（非 flex），让内部 titlebar 撑满宽度，其 flex:1 spacer 才能把主题/连接推到右侧 */}
      <LegacyHost html={legacy.titlebar()} style={{ flex: "none" }} />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* display:flex 让内部 nav 拉伸到全高，底部设备信息才能 flex:1 顶到底 */}
        <LegacyHost html={legacy.sidebar()} style={{ display: "flex", flex: "none" }} />
        <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: "var(--bg)", position: "relative" }}>
          {nav === "settings" ? (
            <Settings />
          ) : nav === "logs" ? (
            <Logs />
          ) : nav === "realtime" ? (
            <Realtime />
          ) : nav === "tasks" ? (
            <Tasks />
          ) : nav === "inspiration" ? (
            <Inspirations />
          ) : nav === "abilities" ? (
            <Abilities />
          ) : (
            <LegacyHost
              html={legacy.currentScreen()}
              style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
              onMounted={() => {
                if (legacy.getNav() === "chat") {
                  const r = document.getElementById("chatroot");
                  if (r) legacy.mountChat(r);
                }
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}
