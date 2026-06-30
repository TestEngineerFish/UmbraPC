// 把本机文件上传到服务端 /files/upload，返回下载链接。
// 注意：主进程 Node 网络在部分环境被代理/WAF RST，因此实际请求交给渲染层(Chromium)执行（见 rpc.ts）。
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { askRenderer } from "./rpc";

export interface UploadResult {
  url: string;
  filename: string;
  file_id: string;
}

// httpBase 形如 https://host；token 可空。读取文件后交渲染层用 Chromium fetch 上传。
export async function uploadFile(
  httpBase: string,
  token: string,
  filePath: string,
  filename?: string,
  contentType?: string,
): Promise<UploadResult> {
  const buf = await fs.readFile(filePath);
  const name = filename || path.basename(filePath);
  return askRenderer<UploadResult>("upload", {
    serverUrl: httpBase,
    token,
    filename: name,
    contentType: contentType || "",
    dataBase64: buf.toString("base64"),
  });
}
