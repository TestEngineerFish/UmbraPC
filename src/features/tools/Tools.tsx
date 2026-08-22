// 「工具」模块：把原先堆在设置页里的桌面小工具独立成一级导航，每个功能一个二级页。
// 二级页按能力可用性动态出现（Web 端没有 preload 桥时整块不显示）。
import { useState } from "react";
import type { ComponentType, SVGProps } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardTool } from "./ClipboardTool";
import { ScreenshotTool } from "./ScreenshotTool";
import { LauncherTool } from "./LauncherTool";
import { WorkflowTool } from "./WorkflowTool";
import { PhrasesTool, PhrasesSyncStatus } from "./PhrasesTool";
import { VaultTool } from "./VaultTool";
import { RuntimeTool } from "./RuntimeTool";
import { hasClip, hasShot, hasLauncher, hasVault, hasRuntime } from "./bridges";
import * as legacy from "../../app/shell";
import { IconClip, IconShot, IconRocket, IconFlow, IconPhrase, IconLock, IconCpu } from "../../components/icons";

// 二级页标识。
type ToolKey = "clipboard" | "screenshot" | "launcher" | "workflow" | "phrases" | "vault" | "runtime";

// 二级目录的分组标识：目录项按这个分三段展示，避免六个功能平铺成一长条看不出主次。
type GroupKey = "common" | "auto" | "security" | "env";

// 分组的展示顺序与标题词条。顺序即渲染顺序，整组的项都不可用时该组自动不出现。
const GROUPS: { key: GroupKey; labelKey: string }[] = [
  { key: "common", labelKey: "tools.groupCommon" },
  { key: "auto", labelKey: "tools.groupAuto" },
  { key: "security", labelKey: "tools.groupSecurity" },
  { key: "env", labelKey: "tools.groupEnv" },
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
  // 运行时环境：一张卡片列一个语言，内容比常用语还宽（版本 + 厂商 + 架构 + 来源 + 路径 五列），所以走 wide。
  { key: "runtime", group: "env", labelKey: "tools.runtime", descKey: "tools.runtimeDesc", icon: IconCpu, avail: hasRuntime, wide: true },
];

// 「小工具」那一项下面的四个子页。工作流 / 保险箱 / 运行时环境**不在这里** ——
// 它们各自是一级导航项，进去就铺满，没有二级目录（稿 5626 的 smallTools 就是这四个）。
const SMALL_TOOLS: ToolKey[] = ["clipboard", "screenshot", "launcher", "phrases"];

// 一级导航取值 → 固定进哪个子页。这三项是一对一的，不给用户在二级目录里切。
const NAV_TOOL: Partial<Record<string, ToolKey>> = { flow: "workflow", vault: "vault", runtime: "runtime" };

// 别处（设置页的快捷键总览）要求「跳到某个工具的详情页」时，先把目标记在这里再切一级导航。
// 用模块级变量而不是 props/context：Tools 是路由式挂载的，切页时组件重建，
// 值取一次就清掉——否则下次手点进「小工具」还会被弹回上次跳转的那一页。
let pendingTool: ToolKey | null = null;
export function gotoTool(key: string): void {
  const k = key as ToolKey;
  pendingTool = k;
  // 三个独立成一级导航的，直接切到对应的导航项；其余走「小工具」。
  const nav = (Object.keys(NAV_TOOL) as string[]).find((n) => NAV_TOOL[n] === k);
  legacy.goNav((nav || "tools") as legacy.Nav);
}
function takePendingTool(): ToolKey | null {
  const k = pendingTool;
  pendingTool = null;
  return k;
}

export function Tools() {
  const { t } = useTranslation();
  const nav = legacy.getNav();
  // 被一级导航锁定的子页（工作流 / 保险箱 / 运行时）：不给二级目录，也不记忆上次停在哪。
  const locked = NAV_TOOL[nav];
  const items = ITEMS.filter((i) => i.avail);
  // 二级目录只列小工具那四个。
  const railItems = items.filter((i) => SMALL_TOOLS.includes(i.key));
  const [cur, setCur] = useState<ToolKey>(() => takePendingTool() || railItems[0]?.key || "clipboard");
  const active = locked && items.some((i) => i.key === locked)
    ? locked
    : railItems.some((i) => i.key === cur) ? cur : railItems[0]?.key;
  const meta = items.find((i) => i.key === active);
  const HeadIcon = meta?.icon;

  if (!meta) {
    return (
      <div className="h-full flex items-center justify-center text-[13px] text-muted">{t("common.desktopOnly")}</div>
    );
  }

  return (
    <div className="h-full flex min-h-0">
      {/* 二级目录**只在「小工具」这一项下出现**（稿 5934 的 showToolRail）。
          工作流 / 保险箱 / 运行时是各自独立的一级导航项，进去直接铺满 ——
          之前这条侧栏是常驻的，导致保险箱页在主窗口里有两条 50px 顶栏叠着。 */}
      {locked ? null : (
      <nav className="w-[190px] shrink-0 border-r border-border bg-rail flex flex-col min-h-0">
        <div className="flex items-center justify-between gap-2 p-[14px_14px_10px]">
          <span className="flex-none whitespace-nowrap text-[14px] font-semibold">{t("nav.tools")}</span>
          <span className="flex-none whitespace-nowrap text-[11px] text-faint">{t("tools.count", { n: railItems.length })}</span>
        </div>
        <div className="flex-1 overflow-y-auto p-[0_8px_12px]">
          {GROUPS.map((g) => {
            const rows = railItems.filter((i) => i.group === g.key);
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
                        className={`w-full text-left flex items-center gap-[9px] p-[6px_8px] rounded-[8px] text-[12.5px] cursor-pointer transition-colors ${on ? "bg-orange-soft text-orange-text font-semibold" : "bg-transparent text-text hover:bg-hover"}`}
                      >
                        <span className={`w-[22px] h-[22px] rounded-[6px] flex items-center justify-center flex-none ${on ? "bg-orange text-white" : "text-muted"}`}>
                          <Icon size={14} />
                        </span>
                        <span className="truncate flex-1 min-w-0">{t(i.labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </nav>
      )}

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
              {/* 标题行右上角的页面级动作位：目前只有常用语用到（同步状态 + 立即同步）。
                  放这儿而不是塞进列表头，是因为它管的是整页数据，不属于某一张卡片。 */}
              <div className="flex-1" />
              {active === "phrases" ? <div className="flex-none self-center"><PhrasesSyncStatus /></div> : null}
            </div>
            {active === "clipboard" ? <ClipboardTool /> : null}
            {active === "screenshot" ? <ScreenshotTool /> : null}
            {active === "launcher" ? <LauncherTool /> : null}
            {active === "phrases" ? <PhrasesTool /> : null}
            {active === "runtime" ? <RuntimeTool /> : null}
          </div>
        </div>
      )}
    </div>
  );
}
