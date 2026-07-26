// 工具 → 密码保险箱：把保险箱界面直接铺在主窗口右侧（不再是「打开保险箱」按钮 + 默认弹独立窗口）。
// 和「工作流编排」同一套路：选中左侧导航就能用，需要更大画面 / 多屏摆放时再从顶栏的独立窗口按钮拉出去。
// 顶栏只放跟「承载方式」有关的两样东西：唤起快捷键（属于主窗口这边的设置，保险箱内部不管它）
// 和独立窗口入口；保险箱自身的逻辑一概不动，全部由 VaultApp 负责。
// 快捷键的录制框、冲突检测都复用 hotkeys.tsx，和设置页总览共用同一份数据源。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { btnGhost, toAccelerator } from "../../components/ui";
import { IconWindow } from "../../components/icons";
import { HotkeyButton, HotkeyConflictBanner, useHotkeyConflict } from "./hotkeys";
import { VaultApp } from "../vault/VaultApp";
import { vaultApi } from "./bridges";

// 保险箱唤起键的出厂值。重置按钮与初始态都用它，避免两处各写一遍。
const DEFAULT_SHORTCUT = "Command+Alt+P";

export function VaultTool() {
  const { t } = useTranslation();
  const api = vaultApi();
  const [shortcut, setShortcut] = useState(DEFAULT_SHORTCUT);
  const [recording, setRecording] = useState(false);
  const conflict = useHotkeyConflict("vault", shortcut);

  useEffect(() => { void api.status().then((s) => setShortcut(s.shortcut || "")); }, []);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setRecording(false); return; }
      const acc = toAccelerator(e); if (!acc) return;
      setShortcut(acc); void api.setShortcut(acc); setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* 顶栏：唤起快捷键 + 独立窗口入口。高度和保险箱自己的顶栏（50px）对齐 */}
      <div className="h-[50px] shrink-0 flex items-center gap-[8px] px-[16px] border-b border-border bg-card">
        <span className="flex-none whitespace-nowrap text-[12.5px] text-muted">{t("settings.vaultShortcut")}</span>
        {/* HotkeyButton 自带 flex-1，外面套一层定宽壳，免得它在顶栏里一路撑开 */}
        <div className="w-[152px] flex-none flex">
          <HotkeyButton recording={recording} value={shortcut} onClick={() => setRecording(true)} />
        </div>
        <button className={btnGhost} onClick={() => { setShortcut(DEFAULT_SHORTCUT); void api.setShortcut(DEFAULT_SHORTCUT); }}>{t("common.reset")}</button>
        {conflict ? <HotkeyConflictBanner owner={conflict} /> : null}
        <div className="flex-1" />
        <button
          className="w-[28px] h-[28px] flex-none inline-flex items-center justify-center border border-border bg-bg text-text rounded-[8px] cursor-pointer hover:border-orange hover:text-orange-text"
          title={t("settings.vaultOpen")}
          onClick={() => void api.openWindow()}
        ><IconWindow size={14} /></button>
      </div>
      {/* 保险箱本体：填满剩下的高度，深浅色跟随主窗口 */}
      <div className="flex-1 min-h-0">
        <VaultApp embedded />
      </div>
    </div>
  );
}
