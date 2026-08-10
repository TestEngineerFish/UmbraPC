// 工具 → 快捷入口：开关、唤起快捷键。
// 工作流编排已拆成同级的独立二级页（WorkflowTool），这里不再挂它的入口。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Toggle, RowsCard, SettingRow, RowHint, Panel, btnGhost } from "../../components/ui";
import { useHotkeyRecorder } from "../../components/HotkeyRecorder";
import { HotkeyButton, HotkeyConflictBanner, useHotkeyConflict } from "./hotkeys";
import { IconSearch } from "../../components/icons";
import { launcherApi } from "./bridges";

// 面板预览里的三条示例结果：字母方块 + 名称 + 右侧类型。用 monogram 而不是彩色 emoji，
// 因为 emoji 在 Windows / macOS 上字形与基线都不一致，三条排下来会明显对不齐。
const PREVIEW_ROWS: { mono: string; name: string; typeKey: string; on?: boolean }[] = [
  { mono: "W", name: "umbra-iOS", typeKey: "settings.launcherWorkflows", on: true },
  { mono: "F", name: "~/Documents/umbra-iOS", typeKey: "tools.previewFolder" },
  { mono: "C", name: "umbra.tingyusha.xyz", typeKey: "settings.clipboard" },
];

export function LauncherTool() {
  const { t } = useTranslation();
  const api = launcherApi();
  const [enabled, setEnabled] = useState(true);
  const [shortcut, setShortcut] = useState("Alt+Space");
  const conflict = useHotkeyConflict("launcher", shortcut);
  // 录制统一走 useHotkeyRecorder：e.code 取主键、录制期间关掉全局快捷键
  // （不关的话按 Alt+Space 会先被快捷入口自己截走，根本录不进来）。
  const { recording, start } = useHotkeyRecorder((acc) => { setShortcut(acc); void api.setShortcut(acc); });

  useEffect(() => {
    void api.getSettings().then((s) => { setEnabled(s.enabled); setShortcut(s.shortcut); });
  }, []);

  return (
    <>
      <RowsCard>
        <SettingRow label={t("settings.launcherEnable")}>
          <RowHint>{t("settings.launcherEnableDesc")}</RowHint>
          <Toggle on={enabled} onClick={() => { const n = !enabled; setEnabled(n); void api.setEnabled(n); }} />
        </SettingRow>
        <SettingRow label={t("settings.launcherShortcut")}>
          <div className="flex-1 min-w-0 flex items-center gap-[8px]">
            <HotkeyButton recording={recording} value={shortcut} onClick={start} />
            <button className={btnGhost} onClick={() => { setShortcut("Alt+Space"); void api.setShortcut("Alt+Space"); }}>
              {t("common.reset")}
            </button>
          </div>
        </SettingRow>
      </RowsCard>

      {conflict ? <HotkeyConflictBanner owner={conflict} /> : null}

      {/* 面板预览：快捷入口弹框本身永远是深色的（浮在别的应用之上，跟随主题反而更扎眼），
          所以这块颜色是唯一硬编码的地方，不走 CSS 变量。 */}
      <Panel title={t("tools.launcherPreview")}>
        <div className="bg-[#1B1814] border border-[#332E26] rounded-[12px] p-[10px]">
          <div className="flex items-center gap-[9px] p-[7px_10px] bg-white/5 rounded-[8px]">
            <span className="flex-none flex text-[#8A837A]"><IconSearch size={14} /></span>
            <span className="text-[13px] text-[#EDEAE3]">umbra<span className="text-[#6E675E]">|</span></span>
          </div>
          <div className="flex flex-col gap-px mt-[8px]">
            {PREVIEW_ROWS.map((r) => (
              <div key={r.mono} className={`flex items-center gap-[9px] p-[6px_10px] rounded-[7px] ${r.on ? "bg-[rgba(232,89,12,.16)]" : ""}`}>
                <span className={`w-[18px] h-[18px] rounded-[5px] flex-none flex items-center justify-center text-[10px] font-bold ${r.on ? "bg-[rgba(232,89,12,.22)] text-[#F0A878]" : "bg-white/[.06] text-[#8A837A]"}`}>
                  {r.mono}
                </span>
                <span className={`flex-1 min-w-0 truncate text-[12px] ${r.on ? "text-[#F0A878]" : "text-[#D8D3CA]"}`}>{r.name}</span>
                <span className="flex-none whitespace-nowrap text-[10.5px] text-[#8A837A]">{t(r.typeKey)}</span>
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </>
  );
}
