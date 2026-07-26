// 工具 → 截图：开关、截图快捷键、翻译用的 GLM Key。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import * as legacy from "../../app/shell";
import * as desktop from "../../services/desktop";
import { Toggle, RowsCard, SettingRow, Panel, Pill, btnGhost, btnPrimary, inputHotkey } from "../../components/ui";
import { HotkeyButton, HotkeyConflictBanner, useHotkeyConflict } from "./hotkeys";
import { shotApi } from "./bridges";

export function ScreenshotTool() {
  const { t } = useTranslation();
  const api = shotApi();
  const shot = legacy.getShotState();
  const [glmKey, setGlmKey] = useState("");
  // 屏幕录制授权状态：截图能不能真的截到画面全看它，所以直接摆在开关旁边而不是藏进设置页。
  const [screen, setScreen] = useState(desktop.getPermissions().screen);
  const conflict = useHotkeyConflict("shot", shot.shortcut);

  // 进页面刷一次真实授权状态（用户可能刚在系统设置里授完权就切回来）。
  useEffect(() => { void desktop.refreshPermissions().then((p) => setScreen(p.screen)).catch(() => {}); }, []);

  const granted = screen === "granted";

  return (
    <>
      <RowsCard>
        <SettingRow label={t("settings.shotEnable")}>
          <div className="flex-1 min-w-0 flex items-center gap-[8px]">
            {granted ? (
              <Pill tone="success" dot>{t("common.granted")}</Pill>
            ) : (
              <>
                <Pill tone="warning" dot>{t("tools.permScreenNeed")}</Pill>
                <button
                  className="flex-none whitespace-nowrap text-[12px] text-orange-text bg-transparent border-none cursor-pointer p-0"
                  onClick={() => { desktop.openPrivacy("screen"); }}
                >
                  {t("common.goAuthorize")}
                </button>
              </>
            )}
          </div>
          <Toggle on={shot.enabled} onClick={() => legacy.toggleShotEnabled()} />
        </SettingRow>
        <SettingRow label={t("settings.shotShortcut")}>
          <div className="flex-1 min-w-0 flex items-center gap-[8px]">
            <HotkeyButton recording={shot.recording} value={shot.shortcut} onClick={() => legacy.beginShortcutRecording("shot")} />
            <button className={btnGhost} onClick={async () => { await api.setShortcut("Command+Control+A"); await legacy.loadShotSettings(); }}>
              {t("common.reset")}
            </button>
          </div>
        </SettingRow>
      </RowsCard>

      {conflict ? <HotkeyConflictBanner owner={conflict} /> : null}

      {/* OCR 在本机跑，只有整图翻译要联网调模型，所以 Key 是可选项而不是必填。 */}
      <Panel title={t("tools.shotOcrTitle")} hint={t("tools.shotOcrHint")} stack>
        <div className="flex items-center gap-[14px]">
          <div className="w-[120px] flex-none whitespace-nowrap text-[13px]">{t("settings.translateKey")}</div>
          <div className="flex-1 min-w-0 flex items-center gap-[8px]">
            <input
              type="password"
              value={glmKey}
              onChange={(e) => setGlmKey(e.target.value)}
              placeholder={shot.hasGlmKey ? t("settings.glmKeySet") : t("settings.glmKeyHint")}
              className={inputHotkey}
            />
            {/* 空输入时按钮是真禁用，不是只把颜色压暗 */}
            <button
              className={btnPrimary}
              disabled={!glmKey.trim()}
              onClick={() => { if (!glmKey.trim()) return; legacy.setShotGlmKey(glmKey); setGlmKey(""); }}
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      </Panel>
    </>
  );
}
