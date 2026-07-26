// 工具 → 剪贴板历史：开关、唤起快捷键、回车自动粘贴、清空历史。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import * as legacy from "../../app/shell";
import { Card, Row, Toggle, btnGhost } from "../../components/ui";
import { clipApi } from "./bridges";

export function ClipboardTool() {
  const { t } = useTranslation();
  const api = clipApi();
  const clip = legacy.getClipState();
  const [autoPaste, setAutoPaste] = useState(false);

  useEffect(() => { void api.getSettings().then((s) => setAutoPaste(!!s.autoPaste)); }, []);

  return (
    <Card title={t("settings.clipboard")}>
      <Row label={t("settings.clipEnable")}>
        <span className="flex-1 text-[12px] text-muted">{t("settings.clipEnableDesc", { status: clip.enabled ? t("common.enabled") : t("settings.clipHistoryKept") })}</span>
        <Toggle on={clip.enabled} onClick={() => legacy.toggleClipEnabled()} />
      </Row>
      <Row label={t("settings.clipShortcut")}>
        <button onClick={() => legacy.beginShortcutRecording("clip")} className={`flex-1 text-left border rounded-lg px-[11px] py-[7px] text-[13px] font-mono bg-bg text-text ${clip.recording ? "border-orange" : "border-border"}`}>
          {clip.recording ? t("settings.pressShortcut") : clip.shortcut}
        </button>
        <button className={btnGhost} onClick={async () => { await api.setShortcut("Command+Shift+V"); await legacy.loadClipSettings(); }}>
          {t("common.reset")}
        </button>
      </Row>
      <Row label={t("settings.clipAutoPaste")}>
        <span className="flex-1 text-[12px] text-muted">{t("settings.clipAutoPasteDesc")}</span>
        <Toggle on={autoPaste} onClick={() => { const n = !autoPaste; setAutoPaste(n); void api.setAutoPaste(n); }} />
      </Row>
      <Row label={t("settings.clipClear")}>
        <span className="flex-1 text-[12px] text-muted">{t("settings.clipClearDesc")}</span>
        <button className="px-[13px] py-[6px] border border-danger text-danger bg-transparent rounded-lg text-[12.5px]" onClick={() => legacy.clearClipHistory()}>
          {t("settings.clipClearBtn")}
        </button>
      </Row>
    </Card>
  );
}
