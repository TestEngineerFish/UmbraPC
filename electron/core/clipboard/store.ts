// 剪贴板历史存储层（JSON 落盘，无原生依赖）。
// 数据量很小（非收藏 ≤100 + 收藏 ≤100 + 磁盘 PNG），JSON 完全够用，且规避 better-sqlite3 的原生编译。
import { promises as fs } from "node:fs";
import * as fssync from "node:fs";
import * as path from "node:path";
import { mt, getMainLocale } from "../../i18n";

export type ClipType = "text" | "image" | "files";

export interface ClipItem {
  id: number;
  type: ClipType;
  content: string;      // 文本内容 / 图像PNG绝对路径 / 文件路径数组JSON
  preview: string;      // 文本前200字 / 图像"宽x高" / 文件名列表
  hash: string;
  favorite: boolean;
  size: number;         // 文本字符数 / 图像字节数 / 文件个数
  sourcePath?: string;  // 图片文件来源原路径
  sourceApp?: string;
  sourceAppPath?: string;
  lastUsedAt: number;   // 排序字段（毫秒）
  createdAt: number;
}

export const NON_FAV_LIMIT = 100;
export const FAV_LIMIT = 100;
export const FAV_LIMIT_MSG = () => mt("electron.favLimit", undefined, getMainLocale());

// "phrase" 是「常用语」虚拟分类：数据不在本 Store 里（存在 config.phrases），
// 由 ClipboardManager 在 IPC 层拦截并合成条目，这里只是让类型一致、list() 直接返回空。
export type ClipCategory = "all" | "text" | "image" | "files" | "favorite" | "phrase";

// 分类保留时长（小时，0=永久）。与 config.ClipKeep 同构，Store 层不依赖 config 模块。
export interface KeepHours {
  text: number;
  image: number;
  files: number;
}

// 图像 PNG 落盘目录 + 历史 JSON 文件都放在 userData/clipboard 下。
export class ClipStore {
  readonly dir: string;
  private file: string;
  private items: ClipItem[] = [];
  private seq = 0;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(userData: string) {
    this.dir = path.join(userData, "clipboard");
    this.file = path.join(this.dir, "history.json");
  }

  async load(): Promise<void> {
    try {
      fssync.mkdirSync(this.dir, { recursive: true });
    } catch {
      /* ignore */
    }
    try {
      const raw = await fs.readFile(this.file, "utf-8");
      const data = JSON.parse(raw);
      this.items = Array.isArray(data.items) ? data.items : [];
      this.seq = Number(data.seq) || this.items.reduce((m, it) => Math.max(m, it.id), 0);
    } catch {
      this.items = [];
      this.seq = 0;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const payload = JSON.stringify({ items: this.items, seq: this.seq });
      fs.mkdir(this.dir, { recursive: true })
        .then(() => fs.writeFile(this.file, payload, "utf-8"))
        .catch(() => {});
    }, 200);
  }

  imagePath(hash: string): string {
    return path.join(this.dir, `${hash}.png`);
  }

  getByHash(hash: string): ClipItem | undefined {
    return this.items.find((it) => it.hash === hash);
  }
  get(id: number): ClipItem | undefined {
    return this.items.find((it) => it.id === id);
  }

  // 查询：分类 + 关键词（匹配 preview / 文本 content），一律按 lastUsedAt DESC 排。
  // 收藏过的条目不再固定置顶——一旦收藏得多了，最上面永远是那几条老内容，
  // 刚复制的反而被挤到下面，历史面板就失去意义了。收藏只当标记和「收藏」分类的筛选依据。
  list(category: ClipCategory = "all", keyword = ""): ClipItem[] {
    if (category === "phrase") return [];
    const kw = keyword.trim().toLowerCase();
    let arr = this.items.slice();
    if (category === "favorite") arr = arr.filter((it) => it.favorite);
    else if (category !== "all") arr = arr.filter((it) => it.type === category);
    if (kw) {
      arr = arr.filter(
        (it) =>
          (it.preview || "").toLowerCase().includes(kw) ||
          (it.type === "text" && (it.content || "").toLowerCase().includes(kw)),
      );
    }
    arr.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    return arr;
  }

  // 新增一条（调用方保证 hash 未存在）。入库后执行容量清理，返回新条目。
  insert(it: Omit<ClipItem, "id" | "createdAt" | "lastUsedAt" | "favorite"> & { favorite?: boolean }): ClipItem {
    const now = Date.now();
    const item: ClipItem = { ...it, id: ++this.seq, favorite: it.favorite ?? false, createdAt: now, lastUsedAt: now };
    this.items.push(item);
    this.enforceLimit();
    this.scheduleSave();
    return item;
  }

  // 置顶：更新 lastUsedAt。
  touch(id: number): ClipItem | undefined {
    const it = this.get(id);
    if (it) {
      it.lastUsedAt = Date.now();
      this.scheduleSave();
    }
    return it;
  }

  setFavorite(id: number, favorite: boolean): ClipItem | undefined {
    const it = this.get(id);
    if (!it) return undefined;
    if (favorite && !it.favorite) {
      const favCount = this.items.filter((x) => x.favorite).length;
      if (favCount >= FAV_LIMIT) throw new Error(FAV_LIMIT_MSG());
    }
    it.favorite = favorite;
    it.lastUsedAt = Date.now();
    this.scheduleSave();
    return it;
  }

  // 删除单条：连带删除其独占的图像文件。
  remove(id: number): void {
    const idx = this.items.findIndex((it) => it.id === id);
    if (idx < 0) return;
    const [removed] = this.items.splice(idx, 1);
    this.gcImage(removed);
    this.scheduleSave();
  }

  // 清空非收藏（连带图像文件）。
  clearNonFavorite(): void {
    const keep: ClipItem[] = [];
    for (const it of this.items) {
      if (it.favorite) keep.push(it);
      else this.gcImage(it);
    }
    this.items = keep;
    this.scheduleSave();
  }

  // 只清空收藏（连带图像文件），非收藏的历史原样留着。
  // 单列一个方法而不是给 clearNonFavorite 加参数：收藏是用户手动挑出来的，
  // 误触代价比清历史大得多，调用点分开更不容易接错。返回删掉的条数。
  clearFavorites(): number {
    const keep: ClipItem[] = [];
    let n = 0;
    for (const it of this.items) {
      if (!it.favorite) keep.push(it);
      else { this.gcImage(it); n++; }
    }
    this.items = keep;
    if (n) this.scheduleSave();
    return n;
  }

  // 按分类保留时长清理过期条目（连带图像文件）。收藏项永不过期，keep=0 表示该分类永久保留。
  // 判定基准是 lastUsedAt 而不是 createdAt：一条老内容只要还在被反复粘贴，就说明它还有用。
  // 返回删掉的条数，调用方据此决定要不要广播刷新。
  gcExpired(keep: KeepHours): number {
    const now = Date.now();
    const expired = this.items.filter((it) => {
      if (it.favorite) return false;
      const hours = keep[it.type] || 0;
      return hours > 0 && now - it.lastUsedAt > hours * 3600_000;
    });
    for (const it of expired) {
      const idx = this.items.findIndex((x) => x.id === it.id);
      if (idx >= 0) {
        this.items.splice(idx, 1);
        this.gcImage(it);
      }
    }
    if (expired.length) this.scheduleSave();
    return expired.length;
  }

  // 非收藏超过上限时，按 lastUsedAt 升序删掉最旧的（连带图像）。
  private enforceLimit(): void {
    const nonFav = this.items.filter((it) => !it.favorite).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const overflow = nonFav.length - NON_FAV_LIMIT;
    for (let i = 0; i < overflow; i++) {
      const victim = nonFav[i];
      const idx = this.items.findIndex((it) => it.id === victim.id);
      if (idx >= 0) {
        this.items.splice(idx, 1);
        this.gcImage(victim);
      }
    }
  }

  // 若该图像文件没有其它条目引用，则删除磁盘文件。
  private gcImage(it: ClipItem): void {
    if (it.type !== "image") return;
    const file = it.content;
    if (!file || !file.startsWith(this.dir)) return;
    const stillUsed = this.items.some((x) => x.id !== it.id && x.type === "image" && x.content === file);
    if (!stillUsed) fs.rm(file, { force: true }).catch(() => {});
  }
}
