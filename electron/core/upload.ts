// 把本机文件上传到服务端 /files/upload，返回下载链接。对齐 Python file_system/screenshot。
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface UploadResult {
  url: string;
  filename: string;
  file_id: string;
}

// httpBase 形如 https://host；token 可空。Electron 主进程(Node20)有全局 fetch/FormData/Blob。
export async function uploadFile(
  httpBase: string,
  token: string,
  filePath: string,
  filename?: string,
  contentType?: string,
): Promise<UploadResult> {
  const buf = await fs.readFile(filePath);
  const name = filename || path.basename(filePath);
  const fd = new FormData();
  const blob = new Blob([buf], contentType ? { type: contentType } : {});
  fd.append("file", blob, name);

  const headers: Record<string, string> = {};
  if (token) headers["X-Umbra-Token"] = token;

  const resp = await fetch(`${httpBase}/files/upload`, { method: "POST", body: fd, headers });
  if (!resp.ok) throw new Error(`上传失败 HTTP ${resp.status}`);
  const data = (await resp.json()) as { url: string; filename: string; file_id: string };
  return {
    url: `${httpBase}${data.url}`,
    filename: data.filename,
    file_id: data.file_id,
  };
}
