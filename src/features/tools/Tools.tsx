// 「工具」模块：把原先堆在设置页里的桌面小工具独立成一级导航，每个功能一个二级页。
// 二级页按能力可用性动态出现（Web 端没有 preload 桥时整块不显示）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardTool } from "./ClipboardTool";
import { ScreenshotTool } from "./ScreenshotTool";
import { LauncherTool } from "./LauncherTool";
import { WorkflowTool } from "./WorkflowTool";
import { PhrasesTool } from "./PhrasesTool";
import { VaultTool } from "./VaultTool";
import { hasClip, hasShot, hasLauncher, hasVault } from "./bridges";

// 二级页标识。
type ToolKey = "clipboard" | "screenshot" | "launcher" | "workflow" | "phrases" | "vault";

// 二级目录清单：labelKey 复用设置页原有词条，avail 决定是否显示。
// emoji + accent 是这一项的视觉身份：图标底色用 accent 的低透明度，选中时整行铺橙、图标底转白。
// full=true 的页自己铺满右侧（工作流编辑器就是这种），不套「窄栏 + 标题头」的常规排版。
const ITEMS: { key: ToolKey; labelKey: string; descKey: string; emoji: string; accent: string; avail: boolean; full?: boolean }[] = [
  { key: "clipboard", labelKey: "settings.clipboard", descKey: "tools.clipboardDesc", emoji: "📋", accent: "#2980B9", avail: hasClip },
  { key: "screenshot", labelKey: "settings.screenshot", descKey: "tools.screenshotDesc", emoji: "📸", accent: "#8E44AD", avail: hasShot },
  { key: "launcher", labelKey: "settings.launcher", descKey: "tools.launcherDesc", emoji: "🚀", accent: "#E8590C", avail: hasLauncher },
  { key: "workflow", labelKey: "settings.launcherWorkflows", descKey: "tools.workflowDesc", emoji: "🧩", accent: "#27AE60", avail: hasLauncher, full: true },
  { key: "phrases", labelKey: "settings.phrases", descKey: "tools.phrasesDesc", emoji: "💬", accent: "#0E9AA7", avail: hasLauncher },
  { key: "vault", labelKey: "settings.vault", descKey: "tools.vaultDesc", emoji: "🔐", accent: "#B7791F", avail: hasVault, full: true },
];

export function Tools() {
  const { t } = useTranslation();
  const items = ITEMS.filter((i) => i.avail);
  const [cur, setCur] = useState<ToolKey>(items[0]?.key || "clipboard");
  const active = items.some((i) => i.key === cur) ? cur : items[0]?.key;
  const meta = items.find((i) => i.key === active);

  if (!items.length) {
    return (
      <div className="h-full flex items-center justify-center text-[13px] text-muted">{t("common.desktopOnly")}</div>
    );
  }

  return (
    <div className="h-full flex min-h-0">
      {/* 二级目录：常驻左侧。带图标块，和深色的一级侧边栏区分开 */}
      <nav className="w-[204px] shrink-0 border-r border-border bg-card p-[16px_12px] flex flex-col gap-[3px] overflow-y-auto">
        <div className="px-[10px] pb-[12px] text-[11.5px] text-muted font-semibold tracking-wide uppercase">{t("nav.tools")}</div>
        {items.map((i) => {
          const on = active === i.key;
          return (
            <button
              key={i.key}
              onClick={() => setCur(i.key)}
              title={t(i.descKey)}
              className={`w-full text-left flex items-center gap-[10px] px-[10px] py-[8px] rounded-[10px] cursor-pointer transition-colors ${on ? "bg-orange text-white" : "text-text hover:bg-chip"}`}
            >
              <span
                className="w-[28px] h-[28px] rounded-[8px] flex items-center justify-center text-[15px] shrink-0"
                style={{ background: on ? "rgba(255,255,255,.22)" : `${i.accent}1F` }}
              >
                {i.emoji}
              </span>
              <span className={`text-[13px] truncate ${on ? "font-semibold" : ""}`}>{t(i.labelKey)}</span>
            </button>
          );
        })}
      </nav>

      {/* 铺满型的二级页（工作流编辑器、密码保险箱）自己管布局：不加内边距、不加标题头，直接给满整块 */}
      {meta?.full ? (
        <div className="flex-1 min-w-0 min-h-0">
          {active === "workflow" ? <WorkflowTool /> : null}
          {active === "vault" ? <VaultTool /> : null}
        </div>
      ) : (
        <div id="scroll-main" className="flex-1 min-w-0 overflow-y-auto p-[22px_26px]">
          <div className="max-w-[700px] flex flex-col gap-[16px]">
            <div className="flex items-center gap-[12px]">
              <span
                className="w-[40px] h-[40px] rounded-[11px] flex items-center justify-center text-[21px] shrink-0"
                style={{ background: `${meta?.accent || "#888"}1F` }}
              >
                {meta?.emoji}
              </span>
              <div className="min-w-0">
                <h1 className="m-0 text-[17px] font-semibold leading-tight">{t(meta?.labelKey || "nav.tools")}</h1>
                <div className="text-[12px] text-muted mt-[3px]">{t(meta?.descKey || "")}</div>
              </div>
            </div>
            {active === "clipboard" ? <ClipboardTool /> : null}
            {active === "screenshot" ? <ScreenshotTool /> : null}
            {active === "launcher" ? <LauncherTool /> : null}
            {active === "phrases" ? <PhrasesTool /> : null}
          </div>
        </div>
      )}
    </div>
  );
}
