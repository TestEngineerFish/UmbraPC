// 剪贴板轮询采集：800ms 读一次，类型判定 图像 > 文件 > 文本，去重后入库或置顶。
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ClipStore, ClipType, ClipItem } from "./store";
import { frontmostApp } from "./source-app";

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp)$/i;
const MAX_TEXT = 100_000;

function sha1(s: string | Buffer): string {
  return createHash("sha1").update(s).digest("hex");
}

// 解析剪贴板中的文件路径（mac / win）。
function readClipboardFiles(clipboard: Electron.Clipboard): string[] {
  try {
    if (process.platform === "darwin") {
      const buf = clipboard.readBuffer("NSFilenamesPboardType");
      if (buf && buf.length) {
        const xml = buf.toString("utf-8");
        const paths = [...xml.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]).filter((p) => p.startsWith("/"));
        if (paths.length) return paths;
      }
      const url = clipboard.read("public.file-url");
      if (url && url.startsWith("file://")) {
        try {
          return [decodeURIComponent(new URL(url).pathname)];
        } catch {
          return [];
        }
      }
    } else if (process.platform === "win32") {
      const buf = clipboard.readBuffer("FileNameW");
      if (buf && buf.length) {
        const s = buf.toString("utf16le").replace(/\0+$/g, "").trim();
        if (s) return [s];
      }
    }
  } catch {
    /* ignore */
  }
  return [];
}

type Descriptor = {
  hash: string;
  type: ClipType;
  // 仅在需要新增入库时调用（可能有落盘副作用），返回入库字段。
  build: () => Promise<Omit<ClipItem, "id" | "createdAt" | "lastUsedAt" | "favorite">>;
};

export class ClipWatcher {
  private timer: NodeJS.Timeout | null = null;
  private lastHash = "";
  private busy = false;

  constructor(private store: ClipStore, private onChange: () => void) {}

  start(intervalMs = 800): void {
    if (this.timer) return;
    this.prime().finally(() => {
      this.timer = setInterval(() => this.tick(), intervalMs);
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  running(): boolean {
    return this.timer !== null;
  }

  // 写回剪贴板前调用：同步 lastHash，避免把自己写回的内容当成新复制。
  noteWriteBack(hash: string): void {
    this.lastHash = hash;
  }

  // 启动时读一次，只设 lastHash，不入库（避免把启动前的存量记为新条目）。
  private async prime(): Promise<void> {
    try {
      const { clipboard } = await import("electron");
      const d = this.describe(clipboard);
      if (d) this.lastHash = d.hash;
    } catch {
      /* ignore */
    }
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const { clipboard } = await import("electron");
      const d = this.describe(clipboard);
      if (!d || d.hash === this.lastHash) return;
      this.lastHash = d.hash;

      const existing = this.store.getByHash(d.hash);
      if (existing) {
        this.store.touch(existing.id);
        this.onChange();
        return;
      }
      const fields = await d.build();
      const src = await frontmostApp();
      this.store.insert({ ...fields, sourceApp: src.name, sourceAppPath: src.path, sourcePath: fields.sourcePath });
      this.onChange();
    } catch {
      /* 单次失败不中断定时器 */
    } finally {
      this.busy = false;
    }
  }

  // 判定当前剪贴板内容，返回描述符（含 hash 与延迟构建器）；空内容返回 null。
  private describe(clipboard: Electron.Clipboard): Descriptor | null {
    const formats = clipboard.availableFormats();

    // 1) 图像（位图）——必须先于文件判定
    if (formats.some((f) => f.startsWith("image/"))) {
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        const png = img.toPNG();
        const { width, height } = img.getSize();
        const hash = sha1(png);
        return {
          hash,
          type: "image",
          build: async () => {
            const file = this.store.imagePath(hash);
            await fs.writeFile(file, png).catch(() => {});
            return { type: "image", content: file, preview: `${width}x${height}`, hash, size: png.length };
          },
        };
      }
    }

    // 2) 文件
    const files = readClipboardFiles(clipboard);
    if (files.length) {
      // 特例：单个图片文件 → 按图像入库，记录 sourcePath
      if (files.length === 1 && IMAGE_EXT.test(files[0])) {
        const src = files[0];
        return {
          hash: sha1("imgfile:" + src),
          type: "image",
          build: async () => {
            const { nativeImage } = await import("electron");
            const img = nativeImage.createFromPath(src);
            const hash = sha1("imgfile:" + src);
            const file = this.store.imagePath(hash);
            let preview = path.basename(src);
            let size = 0;
            if (!img.isEmpty()) {
              const png = img.toPNG();
              await fs.writeFile(file, png).catch(() => {});
              const s = img.getSize();
              preview = `${s.width}x${s.height}`;
              size = png.length;
              return { type: "image", content: file, preview, hash, size, sourcePath: src };
            }
            // 读不出图 → 退回文件条目
            return { type: "files", content: JSON.stringify([src]), preview, hash, size: 1, sourcePath: src };
          },
        };
      }
      const hash = sha1("files:" + JSON.stringify(files));
      return {
        hash,
        type: "files",
        build: async () => ({
          type: "files",
          content: JSON.stringify(files),
          preview: files.map((f) => path.basename(f)).join(", ").slice(0, 200),
          hash,
          size: files.length,
        }),
      };
    }

    // 3) 文本
    const text = clipboard.readText();
    if (text && text.trim()) {
      const content = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
      const hash = sha1("text:" + content);
      return {
        hash,
        type: "text",
        build: async () => ({ type: "text", content, preview: content.slice(0, 200), hash, size: content.length }),
      };
    }

    return null;
  }
}
