// 工具 → 密码保险箱：把保险箱界面直接铺在主窗口右侧（不再是「打开保险箱」按钮 + 默认弹独立窗口）。
// 和「工作流编排」同一套路：选中左侧导航就能用，需要更大画面 / 多屏摆放时再从顶栏的「⧉」拉到独立窗口。
// 顶栏只放跟「承载方式」有关的两样东西：唤起快捷键（属于主窗口这边的设置，保险箱内部不管它）
// 和独立窗口入口；保险箱自身的逻辑一概不动，全部由 VaultApp 负责。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { btnGhost, toAccelerator } from "../../components/ui";
import { VaultApp } from "../vault/VaultApp";
import { vaultApi } from "./bridges";

export function VaultTool() {
  const { t } = useTranslation();
  const api = vaultApi();
  const [shortcut, setShortcut] = useState("Command+Alt+P");
  const [recording, setRecording] = useState(false);

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
      {/* 顶栏：唤起快捷键 + 独立窗口入口 */}
      <div className="shrink-0 flex items-center gap-[8px] px-[16px] py-[9px] border-b border-border bg-card">
        <span className="text-[12.5px] text-muted shrink-0">{t("settings.vaultShortcut")}</span>
        <button
          onClick={() => setRecording(true)}
          className={`border rounded-lg px-[11px] py-[5px] text-[12.5px] font-mono bg-bg text-text cursor-pointer ${recording ? "border-orange" : "border-border"}`}
        >
          {recording ? t("settings.pressShortcut") : (shortcut || t("common.none"))}
        </button>
        <button className={btnGhost} onClick={() => { setShortcut("Command+Alt+P"); void api.setShortcut("Command+Alt+P"); }}>{t("common.reset")}</button>
        <div className="flex-1" />
        <button
          className="w-[27px] h-[27px] border border-border rounded-lg text-text cursor-pointer"
          title={t("settings.vaultOpen")}
          onClick={() => void api.openWindow()}
        >⧉</button>
      </div>
      {/* 保险箱本体：填满剩下的高度，深浅色跟随主窗口 */}
      <div className="flex-1 min-h-0">
        <VaultApp embedded />
      </div>
    </div>
  );
}
