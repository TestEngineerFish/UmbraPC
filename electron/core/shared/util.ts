// 小工具：which 探测命令是否安装；run 跑子进程并捕获输出（带超时与逐行回调）。
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import * as path from "node:path";

// 在 PATH 中查找可执行文件，返回绝对路径或 null（对齐 Python shutil.which）。
export function which(cmd: string, pathStr?: string): string | null {
  const dirs = (pathStr || process.env.PATH || "").split(path.delimiter);
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

export interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export interface RunOpts {
  cwd?: string;
  timeoutMs?: number;
  onLine?: (line: string) => void;
  env?: Record<string, string>;  // 追加环境变量（并入 process.env）；工作流脚本注入变量用
  // 拿到子进程句柄：长任务（agent）需要在收工/退出时把它杀掉，
  // 否则会留下孤儿进程（上次那个等交互授权的 claude 就一直没死）。
  onSpawn?: (child: ChildProcess) => void;
  // 独立进程组：agent 这类会拉起后台服务（dev server）的命令要用，配合 killTree 整组带走。
  detached?: boolean;
}

// 以 argv 形式启动子进程（不经 shell），合并 stdout/stderr，带超时与逐行回调。
//
// 两个血泪教训（都来自 agent 任务卡死）：
//  1. **不能等 "close"**：close 要等 stdio **管道关闭**才触发。如果子进程留下了后台孙子进程
//     （比如 claude 起了个 http.server 给你预览），孙子继承了管道并一直攥着不放 ——
//     即使 claude 本人早就退出了，close 也永远不来，调用方就永远挂着。
//     正解：以 "exit"（进程真的退出了）为准，再给 stdio 一个很短的宽限期收尾。
//  2. **要能杀掉整个进程组**：只 kill 直接子进程，它拉起的后台服务会活下来继续占端口。
export function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: opts.detached ?? false, // 独立进程组 → 可以整组杀掉（见 killTree）
    });
    opts.onSpawn?.(child);
    let output = "";
    let timedOut = false;
    let buf = "";
    let done = false;

    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (buf.trim() && opts.onLine) opts.onLine(buf.trim());
      resolve({ code, output, timedOut });
    };

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      output += text;
      if (opts.onLine) {
        buf += text;
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const l of lines) if (l.trim()) opts.onLine(l.trim());
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, opts.timeoutMs);
    }

    let grace: NodeJS.Timeout | undefined;
    child.on("error", (err) => {
      output += `\n[启动失败] ${String(err)}`;
      finish(-1);
    });
    // 进程退出即算完事：再给 stdio 至多 1.5s 把剩余输出冲出来，
    // 之后不管管道是否还被孙子进程占着，都收工（否则就是上面第 1 条的永久挂起）。
    child.on("exit", (code) => {
      grace = setTimeout(() => finish(code), 1500);
      child.stdout?.once("end", () => finish(code));
    });
    child.on("close", (code) => finish(code));
  });
}

// 杀掉整棵进程树：detached 起的进程用负 pid 杀进程组，把它拉起的后台服务一并带走。
export function killTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return;
  try {
    process.kill(-child.pid, "SIGKILL"); // 进程组
  } catch {
    try {
      child.kill("SIGKILL"); // 不是进程组 leader 就只能杀自己
    } catch {
      /* ignore */
    }
  }
}
