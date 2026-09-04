// 「工具」模块：把原先堆在设置页里的桌面小工具独立成一级导航，每个功能一个二级页。
// 二级页按能力可用性动态出现（Web 端没有 preload 桥时整块不显示）。
// 批次 012 起套页面骨架：小工具 = 页头「小工具」+ T3（190 二级目录 + 720 内容列）；
// 运行时环境 = 页头 + T4 容器；工作流 / 保险箱是 T5 全铺工作台，自己管内容区。
// 常用语已升为一级导航（features/phrases），不再挂在这里。
import { useState } from "react";
import type { ComponentType, SVGProps } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardTool } from "./ClipboardTool";
import { ScreenshotTool } from "./ScreenshotTool";
import { LauncherTool } from "./LauncherTool";
import { WorkflowTool } from "./WorkflowTool";
import { VaultTool } from "./VaultTool";
import { RuntimeTool } from "./RuntimeTool";
import { hasClip, hasShot, hasLauncher, hasVault, hasRuntime } from "./bridges";
import * as legacy from "../../app/shell";
import { IconClip, IconShot, IconRocket, IconFlow, IconLock, IconCpu } from "../../components/icons";
import { PageShell, SettingsPage, SettingsSection, Dashboard } from "../../components/layout";

// 二级页标识。
type ToolKey = "clipboard" | "screenshot" | "launcher" | "workflow" | "vault" | "runtime";

// 二级目录的分组标识：目录项按这个分三段展示，避免六个功能平铺成一长条看不出主次。
type GroupKey = "common" | "auto" | "security" | "env";

// 分组的展示顺序与标题词条。顺序即渲染顺序，整组的项都不可用时该组自动不出现。

// 二级目录清单：labelKey 复用设置页原有词条，avail 决定是否显示。
// icon 是线性描边图标（描边取 currentColor，选中/未选中不用各配一套颜色）。
// full=true 的页自己铺满右侧（工作流编辑器、密码保险箱就是这种），不套「窄栏 + 标题头」的常规排版。
// wide=true 的页把内容栏从 740 放宽到 820：常用语是一张多列表格，740 下关键词和内容会挤在一起。
const ITEMS: { key: ToolKey; group: GroupKey; labelKey: string; descKey: string; icon: ComponentType<Omit<SVGProps<SVGSVGElement>, "width" | "height"> & { size?: number }>; avail: boolean; full?: boolean; wide?: boolean }[] = [
  { key: "clipboard", group: "common", labelKey: "settings.clipboard", descKey: "tools.clipboardDesc", icon: IconClip, avail: hasClip },
  { key: "screenshot", group: "common", labelKey: "settings.screenshot", descKey: "tools.screenshotDesc", icon: IconShot, avail: hasShot },
  { key: "launcher", group: "common", labelKey: "settings.launcher", descKey: "tools.launcherDesc", icon: IconRocket, avail: hasLauncher },
  { key: "workflow", group: "auto", labelKey: "settings.launcherWorkflows", descKey: "tools.workflowDesc", icon: IconFlow, avail: hasLauncher, full: true },
  { key: "vault", group: "security", labelKey: "settings.vault", descKey: "tools.vaultDesc", icon: IconLock, avail: hasVault, full: true },
  // 运行时环境：一张卡片列一个语言，内容比常用语还宽（版本 + 厂商 + 架构 + 来源 + 路径 五列），所以走 wide。
  { key: "runtime", group: "env", labelKey: "tools.runtime", descKey: "tools.runtimeDesc", icon: IconCpu, avail: hasRuntime, wide: true },
];

// 「小工具」那一项下面的三个子页。工作流 / 保险箱 / 运行时环境**不在这里** ——
// 它们各自是一级导航项，进去就铺满，没有二级目录。常用语批次 012 起也是一级导航。
const SMALL_TOOLS: ToolKey[] = ["clipboard", "screenshot", "launcher"];

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

  if (!meta) {
    return (
      <PageShell header={{ title: t("nav.tools") }}>
        <div className="flex-1 flex items-center justify-center text-[13px] text-muted">{t("common.desktopOnly")}</div>
      </PageShell>
    );
  }

  // 铺满型（T5）：工作流编辑器 / 密码保险箱自己管整块内容区（含它们的页头）。
  if (meta.full) {
    return (
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {active === "workflow" ? <WorkflowTool /> : null}
        {active === "vault" ? <VaultTool /> : null}
      </div>
    );
  }

  // 运行时环境（T4）：页头 + 仪表盘容器，卡片由 RuntimeTool 自己画。
  if (active === "runtime") {
    return (
      <PageShell header={{ title: t(meta.labelKey), subtitle: t(meta.descKey) }}>
        <Dashboard><RuntimeTool /></Dashboard>
      </PageShell>
    );
  }

  // 小工具（T3）：190 二级目录只列剪贴板 / 截图 / 快捷入口三页。
  const subNav = [{
    label: t("tools.count", { n: railItems.length }),
    items: railItems.map((i) => { const Icon = i.icon; return { key: i.key, label: t(i.labelKey), icon: <Icon size={14} /> }; }),
  }];
  return (
    <PageShell header={{ title: t("nav.tools"), subtitle: t(meta.labelKey) }}>
      <SettingsPage nav={subNav} active={active} onSelect={(k) => setCur(k as ToolKey)}>
        <SettingsSection title={t(meta.labelKey)} desc={t(meta.descKey)}>
          {active === "clipboard" ? <ClipboardTool /> : null}
          {active === "screenshot" ? <ScreenshotTool /> : null}
          {active === "launcher" ? <LauncherTool /> : null}
        </SettingsSection>
      </SettingsPage>
    </PageShell>
  );
}
