// React 根（Phase A）：React 接管主窗口根节点，托管现有 vanilla 渲染（标题栏/侧边栏/各页面）。
// 后续阶段逐页把内容替换成真正的 React 组件（先从设置页开始，根治整页重建导致的失焦/滚动跳顶）。
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as legacy from "./main";
import type { Nav } from "./main";
import { Settings } from "./screens/Settings";
import { Logs } from "./screens/Logs";
import { Realtime } from "./screens/Realtime";
import { Tasks } from "./screens/Tasks";
import { Abilities } from "./screens/Abilities";

// 把 vanilla 生成的 HTML 挂进一个 div，并在挂载后还原滚动位置 / 触发回调（如挂载聊天子树）。
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

function App() {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [nav, setNav] = useState<Nav>(legacy.getNav());

  useEffect(() => {
    legacy.setBridge(() => bump(), (n) => setNav(n));
    legacy.initLegacy();
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

createRoot(document.getElementById("app")!).render(<App />);
