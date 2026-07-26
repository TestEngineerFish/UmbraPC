// 工具 → 密码保险箱：打开独立保险箱窗口 + 唤起快捷键。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card, Row, btnGhost, toAccelerator } from "../../components/ui";
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
    <Card title={t("settings.vault")}>
      <Row label={t("settings.vaultOpenLabel")}>
        <span className="flex-1 text-[12px] text-muted">{t("settings.vaultDesc")}</span>
        <button className="px-[14px] py-[7px] bg-orange text-white rounded-lg text-[12.5px] font-semibold" onClick={() => void api.openWindow()}>{t("settings.vaultOpen")}</button>
      </Row>
      <Row label={t("settings.vaultShortcut")}>
        <button onClick={() => setRecording(true)} className={`flex-1 text-left border rounded-lg px-[11px] py-[7px] text-[13px] font-mono bg-bg text-text ${recording ? "border-orange" : "border-border"}`}>
          {recording ? t("settings.pressShortcut") : (shortcut || t("common.none"))}
        </button>
        <button className={btnGhost} onClick={() => { setShortcut("Command+Alt+P"); void api.setShortcut("Command+Alt+P"); }}>{t("common.reset")}</button>
      </Row>
    </Card>
  );
}
