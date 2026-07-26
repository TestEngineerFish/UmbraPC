// 工具 → 快捷入口：开关、唤起快捷键。
// 工作流编排已拆成同级的独立二级页（WorkflowTool），这里不再挂它的入口。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card, Row, Toggle, toAccelerator } from "../../components/ui";
import { launcherApi } from "./bridges";

export function LauncherTool() {
  const { t } = useTranslation();
  const api = launcherApi();
  const [enabled, setEnabled] = useState(true);
  const [shortcut, setShortcut] = useState("Alt+Space");
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    void api.getSettings().then((s) => { setEnabled(s.enabled); setShortcut(s.shortcut); });
  }, []);

  // 录制快捷键：按下组合键即保存；Esc 取消。
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setRecording(false); return; }
      const acc = toAccelerator(e);
      if (!acc) return;
      setShortcut(acc); void api.setShortcut(acc); setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  return (
    <Card title={t("settings.launcher")}>
      <Row label={t("settings.launcherEnable")}>
        <span className="flex-1 text-[12px] text-muted">{t("settings.launcherEnableDesc")}</span>
        <Toggle on={enabled} onClick={() => { const n = !enabled; setEnabled(n); void api.setEnabled(n); }} />
      </Row>
      <Row label={t("settings.launcherShortcut")}>
        <button
          onClick={() => setRecording(true)}
          className={`flex-1 text-left border rounded-lg px-[11px] py-[7px] text-[13px] font-mono bg-bg text-text ${recording ? "border-orange" : "border-border"}`}
        >
          {recording ? t("settings.pressShortcut") : shortcut}
        </button>
        <button className="px-[13px] py-[6px] border border-border bg-card text-text rounded-lg text-[12.5px]" onClick={() => { setShortcut("Alt+Space"); void api.setShortcut("Alt+Space"); }}>
          {t("common.reset")}
        </button>
      </Row>
    </Card>
  );
}
