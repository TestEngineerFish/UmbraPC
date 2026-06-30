// 渲染层 RPC 宿主：替主进程执行需要 Chromium 网络的请求（用 window.fetch，能穿透代理/WAF）。
// 目前支持：upload（把主进程给的文件字节上传到 /files/upload）。

interface UploadArgs {
  serverUrl: string;
  token: string;
  filename: string;
  contentType: string;
  dataBase64: string;
}

async function uploadInRenderer(a: UploadArgs): Promise<{ url: string; filename: string; file_id: string }> {
  const bin = atob(a.dataBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const fd = new FormData();
  fd.append("file", new Blob([bytes], a.contentType ? { type: a.contentType } : {}), a.filename);
  const headers: Record<string, string> = {};
  if (a.token) headers["X-Umbra-Token"] = a.token;
  const resp = await fetch(`${a.serverUrl}/files/upload`, { method: "POST", body: fd, headers });
  if (!resp.ok) throw new Error("上传失败 HTTP " + resp.status);
  const data = (await resp.json()) as { url: string; filename: string; file_id: string };
  return { url: `${a.serverUrl}${data.url}`, filename: data.filename, file_id: data.file_id };
}

// 注册 RPC 处理器（桌面态）。
export function initRpcHost(): void {
  if (!window.umbra?.onRpc) return;
  window.umbra.onRpc(async (msg) => {
    try {
      let result: unknown;
      if (msg.method === "upload") result = await uploadInRenderer(msg.args as UploadArgs);
      else throw new Error("unknown rpc method: " + msg.method);
      window.umbra!.sendRpcResult(msg.id, true, result);
    } catch (e) {
      window.umbra!.sendRpcResult(msg.id, false, null, e instanceof Error ? e.message : String(e));
    }
  });
}
