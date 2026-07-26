// 工具 → 快捷入口：开关、唤起快捷键、工作流入口（打开编排编辑器）。
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
  const [wfCount, setWfCount] = useState(0);

  useEffect(() => {
    void api.getSettings().then((s) => { setEnabled(s.enabled); setShortcut(s.shortcut); });
    const refreshWf = () => void api.getWorkflows().then((w) => setWfCount(w.length));
    refreshWf();
    window.addEventListener("focus", refreshWf);  // 从编辑器窗口切回时刷新计数
    return () => window.removeEventListener("focus", refreshWf);
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
      <div className="pt-2">
        <div className="flex items-center gap-2 mb-1.5">
          <div className="text-[12.5px] font-semibold flex-1">{t("settings.launcherWorkflows")}</div>
          <span className="text-[11.5px] text-muted">{t("settings.launcherWorkflowsCount", { count: wfCount })}</span>
          <button className="px-[12px] py-[6px] bg-orange text-white rounded-lg text-[12.5px] font-semibold" onClick={() => void api.openWorkflowEditor()}>{t("settings.launcherWorkflowsOpen")}</button>
        </div>
        <div className="text-[11px] text-muted">{t("settings.launcherWorkflowsHint")}</div>
      </div>
    </Card>
  );
}
