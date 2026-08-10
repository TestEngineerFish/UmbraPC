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

// 确保目录存在并返回它。
//
// **data 和 cache 两个都要建**。它们是 alfred_workflow_data / alfred_workflow_cache
// 指向的目录，而 Alfred 是保证这两个目录存在的 —— 搬过来的脚本因此都直接往里写，
// 不会先 mkdir。少建一个的后果是脚本抛一句
//   `Error: no such file or directory`
// 而且**连路径都不带**（txiki 就是这样），从报错完全看不出是缺目录：
// 2026-08-10 搬有道翻译时在这上面卡了好几轮，最后是 ls 出来只有 data 才发现的。
export async function ensureWorkflowDir(configDir: string, wfId: string): Promise<string> {
  const dir = workflowDir(configDir, wfId);
  await fs.mkdir(path.join(dir, "data"), { recursive: true });
  await fs.mkdir(path.join(dir, "cache"), { recursive: true });
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
    // alfred_* 是**给从 Alfred 搬过来的脚本用的**，不是我们自己要用。
    // 现成的 Alfred 工作流几乎都会读这几个（拿 data 存配置、拿 cache 放中间文件、
    // 拿 bundleid 当缓存目录名），少一个就是一句 KeyError 而不是「功能少一点」。
    alfred_workflow_data: data,
    alfred_workflow_cache: cache,
    alfred_workflow_uid: wfId,
    alfred_workflow_name: wfName || "",
    // bundleid 在 Alfred 里是用户自己填的反向域名。我们没有这个字段，用工作流 id 顶上 ——
    // 脚本拿它当目录名/缓存键，唯一且稳定就够了，不需要真的长得像域名。
    alfred_workflow_bundleid: wfId,
    alfred_workflow_version: "1.0",
    alfred_workflow_description: "",
    // 我们不是 Alfred。**故意不谎报一个 Alfred 版本号** —— 脚本要是按版本号
    // 分支去调 Alfred 独有的东西（比如 AppleScript 控制 Alfred），谎报只会让它
    // 走进一条必然失败的路；给一个明显不是 Alfred 的值，它至少会走兜底分支。
    alfred_version: "0",
    alfred_version_build: "0",
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
