// 工具 → 工作流编排：从「快捷入口」里独立出来的二级页。
// 独立的理由：工作流是自成体系的编辑器（触发/输入/动作/输出 + 变量 + 预制件），
// 只是「恰好也能被快捷入口唤起」，塞在快捷入口的开关下面会让人以为它只是个附属选项。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card, btnPrimary } from "../../components/ui";
import { launcherApi } from "./bridges";

export function WorkflowTool() {
  const { t } = useTranslation();
  const api = launcherApi();
  const [wfCount, setWfCount] = useState(0);

  useEffect(() => {
    const refresh = () => void api.getWorkflows().then((w) => setWfCount(w.length));
    refresh();
    window.addEventListener("focus", refresh); // 从编辑器窗口切回时刷新计数
    return () => window.removeEventListener("focus", refresh);
  }, []);

  return (
    <Card title={t("settings.launcherWorkflows")}>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[12.5px] text-muted">{t("settings.launcherWorkflowsCount", { count: wfCount })}</span>
        <button className={btnPrimary} onClick={() => void api.openWorkflowEditor()}>
          {t("settings.launcherWorkflowsOpen")}
        </button>
      </div>
      <div className="text-[11.5px] text-muted leading-relaxed">{t("settings.launcherWorkflowsHint")}</div>
    </Card>
  );
}
