// 小工具：which 探测命令是否安装；run 跑子进程并捕获输出（带超时与逐行回调）。
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import * as path from "node:path";

// 在 PATH 中查找可执行文件，返回绝对路径或 null（对齐 Python shutil.which）。
export function which(cmd: string): string | null {
  const dirs = (process.env.PATH || "").split(path.delimiter);
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
}

// 以 argv 形式启动子进程（不经 shell），合并 stdout/stderr，带超时与逐行回调。
export function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    let buf = "";

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
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      output += `\n[启动失败] ${String(err)}`;
      resolve({ code: -1, output, timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}
