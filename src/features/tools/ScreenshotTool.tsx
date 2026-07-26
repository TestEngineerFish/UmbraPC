// 工具 → 截图：开关、截图快捷键、翻译用的 GLM Key。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as legacy from "../../app/shell";
import { Card, Row, Toggle, input, btnGhost } from "../../components/ui";
import { shotApi } from "./bridges";

export function ScreenshotTool() {
  const { t } = useTranslation();
  const api = shotApi();
  const shot = legacy.getShotState();
  const [glmKey, setGlmKey] = useState("");

  return (
    <Card title={t("settings.screenshot")}>
      <Row label={t("settings.shotEnable")}>
        <span className="flex-1 text-[12px] text-muted">{t("settings.shotEnableDesc", { status: shot.enabled ? t("common.enabled") : t("settings.shotNoShortcut") })}</span>
        <Toggle on={shot.enabled} onClick={() => legacy.toggleShotEnabled()} />
      </Row>
      <Row label={t("settings.shotShortcut")}>
        <button onClick={() => legacy.beginShortcutRecording("shot")} className={`flex-1 text-left border rounded-lg px-[11px] py-[7px] text-[13px] font-mono bg-bg text-text ${shot.recording ? "border-orange" : "border-border"}`}>
          {shot.recording ? t("settings.pressShortcut") : shot.shortcut}
        </button>
        <button className={btnGhost} onClick={async () => { await api.setShortcut("Command+Control+A"); await legacy.loadShotSettings(); }}>
          {t("common.reset")}
        </button>
      </Row>
      <Row label={t("settings.translateKey")}>
        <input type="password" value={glmKey} onChange={(e) => setGlmKey(e.target.value)} placeholder={shot.hasGlmKey ? t("settings.glmKeySet") : t("settings.glmKeyHint")} className={`${input} font-mono`} />
        <button className={btnGhost} onClick={() => { legacy.setShotGlmKey(glmKey); setGlmKey(""); }}>
          {t("common.save")}
        </button>
      </Row>
    </Card>
  );
}
