// 「工具」模块：把原先堆在设置页里的桌面小工具独立成一级导航，每个功能一个二级页。
// 二级页按能力可用性动态出现（Web 端没有 preload 桥时整块不显示）。
import { useState } from "react";
import type { ComponentType, SVGProps } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardTool } from "./ClipboardTool";
import { ScreenshotTool } from "./ScreenshotTool";
import { LauncherTool } from "./LauncherTool";
import { WorkflowTool } from "./WorkflowTool";
import { PhrasesTool } from "./PhrasesTool";
import { VaultTool } from "./VaultTool";
import { hasClip, hasShot, hasLauncher, hasVault } from "./bridges";
import { IconClip, IconShot, IconRocket, IconFlow, IconPhrase, IconLock } from "../../components/icons";

// 二级页标识。
type ToolKey = "clipboard" | "screenshot" | "launcher" | "workflow" | "phrases" | "vault";

// 二级目录的分组标识：目录项按这个分三段展示，避免六个功能平铺成一长条看不出主次。
type GroupKey = "common" | "auto" | "security";

// 分组的展示顺序与标题词条。顺序即渲染顺序，整组的项都不可用时该组自动不出现。
const GROUPS: { key: GroupKey; labelKey: string }[] = [
  { key: "common", labelKey: "tools.groupCommon" },
  { key: "auto", labelKey: "tools.groupAuto" },
  { key: "security", labelKey: "tools.groupSecurity" },
];

// 二级目录清单：labelKey 复用设置页原有词条，avail 决定是否显示。
// icon 是线性描边图标（描边取 currentColor，选中/未选中不用各配一套颜色）。
// full=true 的页自己铺满右侧（工作流编辑器、密码保险箱就是这种），不套「窄栏 + 标题头」的常规排版。
// wide=true 的页把内容栏从 740 放宽到 820：常用语是一张多列表格，740 下关键词和内容会挤在一起。
const ITEMS: { key: ToolKey; group: GroupKey; labelKey: string; descKey: string; icon: ComponentType<Omit<SVGProps<SVGSVGElement>, "width" | "height"> & { size?: number }>; avail: boolean; full?: boolean; wide?: boolean }[] = [
  { key: "clipboard", group: "common", labelKey: "settings.clipboard", descKey: "tools.clipboardDesc", icon: IconClip, avail: hasClip },
  { key: "screenshot", group: "common", labelKey: "settings.screenshot", descKey: "tools.screenshotDesc", icon: IconShot, avail: hasShot },
  { key: "launcher", group: "common", labelKey: "settings.launcher", descKey: "tools.launcherDesc", icon: IconRocket, avail: hasLauncher },
  { key: "workflow", group: "auto", labelKey: "settings.launcherWorkflows", descKey: "tools.workflowDesc", icon: IconFlow, avail: hasLauncher, full: true },
  { key: "phrases", group: "auto", labelKey: "settings.phrases", descKey: "tools.phrasesDesc", icon: IconPhrase, avail: hasLauncher, wide: true },
  { key: "vault", group: "security", labelKey: "settings.vault", descKey: "tools.vaultDesc", icon: IconLock, avail: hasVault, full: true },
];

export function Tools() {
  const { t } = useTranslation();
  const items = ITEMS.filter((i) => i.avail);
  const [cur, setCur] = useState<ToolKey>(items[0]?.key || "clipboard");
  const active = items.some((i) => i.key === cur) ? cur : items[0]?.key;
  const meta = items.find((i) => i.key === active);
  const HeadIcon = meta?.icon;

  if (!items.length) {
    return (
      <div className="h-full flex items-center justify-center text-[13px] text-muted">{t("common.desktopOnly")}</div>
    );
  }

  return (
    <div className="h-full flex min-h-0">
      {/* 二级目录：常驻左侧。底色用 --rail 比主内容区略沉一点，和深色的一级侧边栏区分开 */}
      <nav className="w-[190px] shrink-0 border-r border-border bg-rail flex flex-col min-h-0">
        <div className="flex items-baseline justify-between p-[14px_14px_10px]">
          <span className="text-[14px] font-semibold">{t("nav.tools")}</span>
          <span className="text-[11px] text-faint">{t("tools.count", { n: items.length })}</span>
        </div>
        <div className="flex-1 overflow-y-auto p-[0_8px_12px]">
          {GROUPS.map((g) => {
            const rows = items.filter((i) => i.group === g.key);
            if (!rows.length) return null;
            return (
              <div key={g.key} className="mb-[12px]">
                <div className="text-[10.5px] font-semibold tracking-[.06em] text-faint p-[0_8px_6px]">{t(g.labelKey)}</div>
                <div className="flex flex-col gap-px">
                  {rows.map((i) => {
                    const on = active === i.key;
                    const Icon = i.icon;
                    return (
                      <button
                        key={i.key}
                        onClick={() => setCur(i.key)}
                        title={t(i.descKey)}
                        className={`w-full text-left flex items-center gap-[9px] p-[6px_8px] rounded-[8px] text-[12.5px] cursor-pointer transition-colors ${on ? "bg-orange-soft text-orange-text font-semibold" : "text-text hover:bg-hover"}`}
                      >
                        <span className={`w-[22px] h-[22px] rounded-[6px] flex items-center justify-center shrink-0 ${on ? "bg-orange text-white" : "bg-chip text-muted"}`}>
                          <Icon size={14} />
                        </span>
                        <span className="truncate flex-1 min-w-0">{t(i.labelKey)}</span>
                        {/* 选中项行尾的橙点：底色是浅橙时对比度不强，靠这一点补一个明确的「就是它」 */}
                        {on ? <span className="w-[5px] h-[5px] rounded-full bg-orange shrink-0" /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </nav>

      {/* 铺满型的二级页（工作流编辑器、密码保险箱）自己管布局：不加内边距、不加标题头，直接给满整块 */}
      {meta?.full ? (
        <div className="flex-1 min-w-0 min-h-0">
          {active === "workflow" ? <WorkflowTool /> : null}
          {active === "vault" ? <VaultTool /> : null}
        </div>
      ) : (
        <div id="scroll-main" className="flex-1 min-w-0 overflow-y-auto p-[22px_26px]">
          <div className={`${meta?.wide ? "max-w-[820px]" : "max-w-[740px]"} flex flex-col gap-[16px]`}>
            <div className="flex items-start gap-[12px]">
              <span className="w-[36px] h-[36px] rounded-[9px] flex items-center justify-center flex-none bg-orange-soft text-orange-text">
                {HeadIcon ? <HeadIcon size={18} /> : null}
              </span>
              <div className="min-w-0">
                <h1 className="m-0 text-[16px] font-semibold leading-tight">{t(meta?.labelKey || "nav.tools")}</h1>
                <div className="text-[12.5px] text-muted mt-[2px]">{t(meta?.descKey || "")}</div>
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
