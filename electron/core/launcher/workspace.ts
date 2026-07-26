// 工作流的独立工作目录。
// 每条工作流一个自己的文件夹（对齐 Alfred 的 workflows/user.workflow.XXX 结构），
// 脚本、随行的可执行文件、图标、缓存都放在里面。这样：
//   · 脚本可以写 ./runtime/txiki ./index.js 这种相对路径（执行时 cwd 就是本工作流目录）；
//   · 一条工作流连同它的附属文件可以整包拷走／备份，不会和别的工作流混在一起；
//   · 后续扩展（打包导出、随行二进制、私有缓存）都有地方落。
import { promises as fs } from "node:fs";
import * as path from "node:path";

// 所有工作流目录的根：<userData>/workflows
export function workflowsRoot(configDir: string): string {
  return path.join(configDir, "workflows");
}

// 目录名净化：正常情况下工作流 id 是我们自己生成的安全串，
// 但导入的 JSON 里 id 是外部来的，挡一道，免得 ../ 之类跑出根目录。
function safeId(id: string): string {
  const s = (id || "").replace(/[^\w.-]/g, "_").replace(/^\.+/, "_");
  return s || "unknown";
}

// 单条工作流的目录路径（不保证已存在）。
export function workflowDir(configDir: string, wfId: string): string {
  return path.join(workflowsRoot(configDir), safeId(wfId));
}

// 确保目录存在并返回它。data 子目录给脚本存自己的持久化数据（对齐 alfred_workflow_data 的用法）。
export async function ensureWorkflowDir(configDir: string, wfId: string): Promise<string> {
  const dir = workflowDir(configDir, wfId);
  await fs.mkdir(path.join(dir, "data"), { recursive: true });
  return dir;
}

// 注入给脚本的工作流环境变量。
// umbra_ 前缀是我们自己的一套；同时给一份 alfred_ 别名 —— 从 Alfred 搬过来的脚本
// 大多直接读 $alfred_workflow_data 这类变量，给了别名就不用逐行改脚本。
export function workflowEnv(dir: string, wfId: string, wfName: string): Record<string, string> {
  const data = path.join(dir, "data");
  const cache = path.join(dir, "cache");
  return {
    umbra_workflow_dir: dir,
    umbra_workflow_data: data,
    umbra_workflow_cache: cache,
    umbra_workflow_uid: wfId,
    umbra_workflow_name: wfName || "",
    alfred_workflow_data: data,
    alfred_workflow_cache: cache,
    alfred_workflow_uid: wfId,
    alfred_workflow_name: wfName || "",
  };
}

// 把节点里填的 cwd 解析成绝对路径：留空 = 工作流目录本身；
// 填了相对路径 = 相对工作流目录（而不是相对进程的当前目录，那个对用户毫无意义）。
export function resolveCwd(dir: string, raw: string, expand: (p: string) => string): string {
  const s = (raw || "").trim();
  if (!s) return dir;
  const p = expand(s);
  return path.isAbsolute(p) ? p : path.join(dir, p);
}
