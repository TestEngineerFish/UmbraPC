// 功能页外壳：页头 + 内容区，外加「功能内设置」的视图切换（批次 012 · 骨架件第 05 节）。
//
// 点页头齿轮 → 内容区**整体**换成 T3 设置视图（不是弹窗、不是抽屉），页头左侧换成
// 返回钮 + 「{功能名}设置」，视图内没有齿轮、没有主按钮（改动即时生效，不出现「保存」）。
// 退出走返回钮或 Esc；切去别的功能再回来是主视图（页面卸载即忘），返回时恢复原来的
// 列表滚动位置与选中项 —— 所以主视图**不卸载**：设置态下用 visibility:hidden 藏起来
// （display:none 会把滚动位置归零；卸载会把选中项一起丢掉）。
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { PageHeader, type PageHeaderProps } from "./PageHeader";
import type { MenuAction } from "../ui";

export interface PageSettings {
  /** 设置视图页头标题，如「记账设置」。 */
  title: string;
  /** 返回钮 tooltip，如「返回记账」。 */
  backLabel: string;
  /** ⋯ 只在真有低频动作时留。 */
  more?: MenuAction[];
  /** 设置视图的内容（通常是 <SettingsPage>）。 */
  content: React.ReactNode;
}

// 内容区里也能打开 / 关闭设置视图（如空态的「去设置」按钮）：走这个 context，不用把回调层层传。
const ShellCtx = createContext<{ openSettings: () => void; closeSettings: () => void; inSettings: boolean } | null>(null);
export function usePageSettings() {
  return useContext(ShellCtx) || { openSettings: () => {}, closeSettings: () => {}, inSettings: false };
}

export function PageShell({ header, settings, children }: {
  header: Omit<PageHeaderProps, "onSettings" | "back">;
  settings?: PageSettings;
  children: React.ReactNode;
}) {
  const [inSettings, setInSettings] = useState(false);
  // Esc 退出设置视图。输入框里的 Esc 也算 —— 设计只说「返回钮或 Esc」，不分焦点在哪。
  useEffect(() => {
    if (!inSettings) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); setInSettings(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inSettings]);

  const ctx = useMemo(() => ({
    openSettings: () => { if (settings) setInSettings(true); },
    closeSettings: () => setInSettings(false),
    inSettings,
  }), [settings, inSettings]);

  return (
    <ShellCtx.Provider value={ctx}>
    <div className="flex-1 min-h-0 flex flex-col relative">
      {/* 主视图（页头 + 内容）常驻、几何不变；设置态下只是看不见（保住滚动位置与选中项）。 */}
      <div className={`flex-1 min-h-0 flex flex-col ${inSettings ? "invisible" : ""}`}>
        <PageHeader {...header} onSettings={settings ? () => setInSettings(true) : undefined} />
        {children}
      </div>
      {inSettings && settings ? (
        <div className="absolute inset-0 z-10 flex flex-col bg-bg">
          <PageHeader title={settings.title} back={{ label: settings.backLabel, onBack: () => setInSettings(false) }} more={settings.more} />
          <div className="flex-1 min-h-0 flex flex-col">{settings.content}</div>
        </div>
      ) : null}
    </div>
    </ShellCtx.Provider>
  );
}
