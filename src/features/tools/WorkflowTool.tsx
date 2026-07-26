// 工具 → 工作流编排：从「快捷入口」里独立出来的二级页。
// 独立的理由：工作流是自成体系的编辑器（触发/输入/动作/输出 + 变量 + 预制件），
// 只是「恰好也能被快捷入口唤起」，塞在快捷入口的开关下面会让人以为它只是个附属选项。
// 这里直接把编辑器铺在主窗口右侧（不再是「打开编辑器」按钮）——选中导航就能改图，
// 画布不够用时再从编辑器顶栏的「独立窗口」拉到单独的窗口里去。
import { WorkflowEditor } from "../launcher/WorkflowEditor";
import { launcherApi } from "./bridges";

export function WorkflowTool() {
  const api = launcherApi();
  return <WorkflowEditor embedded onPopout={() => void api.openWorkflowEditor()} />;
}
