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
const ITEMS: { key: ToolKey; labelKey: string; descKey: string; avail: boolean }[] = [
  { key: "clipboard", labelKey: "settings.clipboard", descKey: "tools.clipboardDesc", avail: hasClip },
  { key: "screenshot", labelKey: "settings.screenshot", descKey: "tools.screenshotDesc", avail: hasShot },
  { key: "launcher", labelKey: "settings.launcher", descKey: "tools.launcherDesc", avail: hasLauncher },
  { key: "workflow", labelKey: "settings.launcherWorkflows", descKey: "tools.workflowDesc", avail: hasLauncher },
  { key: "phrases", labelKey: "settings.phrases", descKey: "tools.phrasesDesc", avail: hasLauncher },
  { key: "vault", labelKey: "settings.vault", descKey: "tools.vaultDesc", avail: hasVault },
];

export function Tools() {
  const { t } = useTranslation();
  const items = ITEMS.filter((i) => i.avail);
  const [cur, setCur] = useState<ToolKey>(items[0]?.key || "clipboard");
  const active = items.some((i) => i.key === cur) ? cur : items[0]?.key;

  if (!items.length) {
    return (
      <div className="h-full flex items-center justify-center text-[13px] text-muted">{t("common.desktopOnly")}</div>
    );
  }

  return (
    <div className="h-full flex min-h-0">
      {/* 二级目录：常驻左侧，窄一档、无图标，和一级侧边栏区分开 */}
      <nav className="w-[150px] shrink-0 border-r border-border bg-card p-[14px_10px] flex flex-col gap-[2px] overflow-y-auto">
        <div className="px-[8px] pb-[10px] text-[12px] text-muted font-semibold">{t("nav.tools")}</div>
        {items.map((i) => (
          <button
            key={i.key}
            onClick={() => setCur(i.key)}
            className={`text-left px-[10px] py-[7px] rounded-lg text-[13px] cursor-pointer ${active === i.key ? "bg-orange text-white font-semibold" : "text-text hover:bg-chip"}`}
          >
            {t(i.labelKey)}
          </button>
        ))}
      </nav>
      <div id="scroll-main" className="flex-1 min-w-0 overflow-y-auto p-[18px_22px]">
        <div className="max-w-[680px] flex flex-col gap-[14px]">
          <div>
            <h1 className="m-0 text-[16px] font-semibold">{t(items.find((i) => i.key === active)?.labelKey || "nav.tools")}</h1>
            <div className="text-[12px] text-muted mt-[4px]">{t(items.find((i) => i.key === active)?.descKey || "")}</div>
          </div>
          {active === "clipboard" ? <ClipboardTool /> : null}
          {active === "screenshot" ? <ScreenshotTool /> : null}
          {active === "launcher" ? <LauncherTool /> : null}
          {active === "workflow" ? <WorkflowTool /> : null}
          {active === "phrases" ? <PhrasesTool /> : null}
          {active === "vault" ? <VaultTool /> : null}
        </div>
      </div>
    </div>
  );
}
