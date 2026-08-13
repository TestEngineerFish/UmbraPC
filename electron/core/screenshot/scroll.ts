// 滚动长截图 · 拼接内核（纯逻辑，不碰 electron / DOM，可直接跑单测）。
//
// 输入是一帧帧的**选区位图**（BGRA，宽度固定、高度固定），输出是去掉重叠后拼好的长图位图。
// 匹配方式：取上一帧底部的一条「探针」（连续若干行），在新帧里从下往上找它落在第几行；
// 探针下方剩下的部分就是这次滚出来的新内容。因此**不要求滚动步长精确**——
// 用户用鼠标滚轮手动滚，滚多滚少都行，只要每次别一口气滚过一屏（探针得还在画面里）。
//
// 为什么用「探针在新帧里找位置」而不是「上一帧尾部 vs 新帧头部」直接对齐：
// 网页常有吸顶导航栏，新帧的头几行永远是那条不动的导航，用头部对齐必然匹配失败；
// 探针法会自然把匹配点落到导航栏下面，导航栏也就不会被重复拼进长图。
// 反过来「吸底栏」这一版处理不了（探针本身就落在吸底栏上，会判成没滚动），
// 所以框选时要避开固定的底部栏——文档里已写明。

// 位图每像素字节数（Electron nativeImage.toBitmap() 给的是 BGRA）。
export const BYTES_PER_PIXEL = 4;

// 行签名的像素采样步长：每 N 个像素取一个参与哈希。
// 整行哈希在 4K 选区上每帧要过几十 MB，抽 4 倍之后一行仍有几百个采样点，
// 误判概率可以忽略，耗时却降一个量级（抓帧是 4Hz 的循环，省下的就是 CPU）。
export const SAMPLE_STEP = 4;

// 探针高度 = 帧高 × PROBE_RATIO，再夹到 [PROBE_MIN, PROBE_MAX] 行。
// 太短容易在重复纹理（表格线、纯色块）里误配；太长会吃掉可用的匹配窗口
// （用户一次最多能滚「帧高 − 探针高」，探针越高越容易一滚就脱靶）。
export const PROBE_RATIO = 0.2;
export const PROBE_MIN = 24;
export const PROBE_MAX = 240;

// 探针最多占帧高的比例。上面的 PROBE_MIN 是按正常一屏（几百上千行）定的，
// 帧很矮时它会反过来把匹配窗口压没，所以这里再兜一道硬上限。
export const PROBE_MAX_RATIO = 0.4;

// 连续多少帧匹配不上才认定「内容真的跳走了」，硬接一整帧并记一次断层。
// 给几帧宽容是因为用户甩一下滚轮时中间帧常常对不上，稍等一下画面停住就能重新咬合。
export const MISS_TOLERANCE = 6;

// 长图最大行数（物理像素）。信息流类页面可以无限滚，这里兜个底，
// 免得内存和后续 PNG 编码被拖垮。约等于 2x 屏下的十来屏。
export const MAX_ROWS = 20000;

// 单帧推进结果：
//   first    第一帧，整帧收下
//   appended 匹配上了，追加了 added 行新内容
//   same     匹配上了但没有新内容（用户没滚 / 已经到底）
//   miss     这一帧对不上（还在宽容次数内，先丢掉等下一帧）
//   gap      连续对不上超过宽容次数，硬接一整帧，长图这里会有断层
export type PushStatus = "first" | "appended" | "same" | "miss" | "gap";

export interface PushResult {
  status: PushStatus;
  added: number; // 本帧实际追加的像素行数
}

export interface StitcherOpts {
  probeRows?: number;     // 探针高度（行），默认按 probeRowsFor(frameHeight) 算
  maxRows?: number;       // 长图行数上限，默认 MAX_ROWS
  missTolerance?: number; // 连续失配宽容次数，默认 MISS_TOLERANCE
}

/** 按帧高算出合适的探针高度（行）：取帧高的 PROBE_RATIO，夹在下限/上限与「不超过帧高 40%」之间。 */
export function probeRowsFor(frameHeight: number): number {
  const hardMax = Math.max(1, Math.floor(frameHeight * PROBE_MAX_RATIO));
  const lo = Math.min(PROBE_MIN, hardMax);
  const hi = Math.min(PROBE_MAX, hardMax);
  const wanted = Math.round(frameHeight * PROBE_RATIO);
  return Math.max(1, Math.min(hi, Math.max(lo, wanted)));
}

/**
 * 把位图逐行压成 32 位签名（FNV-1a，按 step 个像素抽样，忽略 alpha 通道）。
 *
 * 只用于「两行是否相同」的快速判定：同一块画面上下平移时像素完全一致，
 * 抽样哈希相等即可认定同一行，不需要真的逐字节比。
 */
export function rowKeys(buf: Uint8Array, width: number, height: number, step = SAMPLE_STEP): Uint32Array {
  const stride = width * BYTES_PER_PIXEL;
  const byteStep = Math.max(1, step) * BYTES_PER_PIXEL;
  const keys = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    const base = y * stride;
    const end = base + stride;
    let h = 0x811c9dc5;
    for (let i = base; i + 2 < end; i += byteStep) {
      h = Math.imul(h ^ buf[i], 0x01000193);
      h = Math.imul(h ^ buf[i + 1], 0x01000193);
      h = Math.imul(h ^ buf[i + 2], 0x01000193);
    }
    keys[y] = h >>> 0;
  }
  return keys;
}

/**
 * 在新帧里找上一帧底部探针的落点。
 *
 * 探针 = prevKeys 的最后 probeRows 行。返回它在 nextKeys 里的起始行号，找不到返回 -1。
 * **从下往上扫**：画面里有大片纯色/重复纹理时会有多个位置都能对上，
 * 取最靠下的那个 = 认定滚得最少，宁可少拼一点也不要把重复内容拼两遍。
 */
export function matchProbe(prevKeys: Uint32Array, nextKeys: Uint32Array, probeRows: number): number {
  const prevH = prevKeys.length;
  const nextH = nextKeys.length;
  if (probeRows <= 0 || probeRows > prevH || probeRows > nextH) return -1;
  const from = prevH - probeRows;
  for (let p = nextH - probeRows; p >= 0; p--) {
    if (nextKeys[p] !== prevKeys[from]) continue; // 首行就不同，整段必然不同
    let ok = true;
    for (let i = 1; i < probeRows; i++) {
      if (nextKeys[p + i] !== prevKeys[from + i]) {
        ok = false;
        break;
      }
    }
    if (ok) return p;
  }
  return -1;
}

/**
 * 滚动长截图的拼接器：一帧帧喂进来（push），最后取拼好的整张位图（result）。
 *
 * 每帧尺寸必须一致（width × frameHeight，BGRA）；宽高来自框选区域的物理像素尺寸。
 * 状态都在实例里，一次滚动会话一个实例。
 */
export class ScrollStitcher {
  readonly width: number;
  readonly frameHeight: number;
  readonly probeRows: number;
  readonly maxRows: number;
  readonly missTolerance: number;

  // 已收下的像素行（按追加顺序切片保存，result() 时再拼成一块，避免每帧重新分配大 buffer）
  private chunks: Uint8Array[] = [];
  private rowCount = 0;
  private lastKeys: Uint32Array | null = null;
  private misses = 0;
  // 硬接过几次（长图在这些位置可能缺内容）。>0 就该提示用户滚慢点重来。
  private gapCount = 0;

  constructor(width: number, frameHeight: number, opts: StitcherOpts = {}) {
    if (width <= 0 || frameHeight <= 0) throw new Error(`帧尺寸非法：${width}×${frameHeight}`);
    this.width = width;
    this.frameHeight = frameHeight;
    this.probeRows = opts.probeRows ?? probeRowsFor(frameHeight);
    this.maxRows = opts.maxRows ?? MAX_ROWS;
    this.missTolerance = opts.missTolerance ?? MISS_TOLERANCE;
  }

  /** 已拼出的长图行数（像素）。 */
  get rows(): number {
    return this.rowCount;
  }

  /** 硬接次数：>0 说明中间有断层，长图可能缺内容。 */
  get gaps(): number {
    return this.gapCount;
  }

  /** 是否已经顶到行数上限（顶到就该停止会话了）。 */
  get full(): boolean {
    return this.rowCount >= this.maxRows;
  }

  /** 喂一帧选区位图，返回这帧的处理结果。帧字节数不足会抛错（尺寸对不上说明抓帧参数错了）。 */
  push(frame: Uint8Array): PushResult {
    const stride = this.width * BYTES_PER_PIXEL;
    const expected = stride * this.frameHeight;
    if (frame.length < expected) {
      throw new Error(`帧尺寸不符：期望 ${expected} 字节（${this.width}×${this.frameHeight}），实际 ${frame.length}`);
    }
    const keys = rowKeys(frame, this.width, this.frameHeight);

    if (!this.lastKeys) {
      const added = this.appendRows(frame, 0, this.frameHeight);
      this.lastKeys = keys;
      return { status: "first", added };
    }

    const p = matchProbe(this.lastKeys, keys, this.probeRows);
    if (p < 0) {
      this.misses++;
      if (this.misses < this.missTolerance) return { status: "miss", added: 0 };
      // 连着这么多帧都咬不上：内容是真的跳走了（滚太猛、换页、切了窗口）。
      // 硬接一整帧保证不丢内容，同时记一次断层，让上层提示用户。
      this.misses = 0;
      this.gapCount++;
      const added = this.appendRows(frame, 0, this.frameHeight);
      this.lastKeys = keys;
      return { status: "gap", added };
    }

    this.misses = 0;
    const newRows = this.frameHeight - (p + this.probeRows);
    if (newRows <= 0) return { status: "same", added: 0 }; // 没滚动 / 已到底：lastKeys 不用换
    const added = this.appendRows(frame, this.frameHeight - newRows, newRows);
    this.lastKeys = keys;
    return { status: "appended", added };
  }

  /** 取拼好的长图位图（BGRA）。没有任何帧时返回 0 高度。 */
  result(): { data: Uint8Array; width: number; height: number } {
    const stride = this.width * BYTES_PER_PIXEL;
    const out = new Uint8Array(stride * this.rowCount);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return { data: out, width: this.width, height: this.rowCount };
  }

  /** 从 frame 的第 fromRow 行起收下 count 行；顶到 maxRows 就只收得下多少算多少。 */
  private appendRows(frame: Uint8Array, fromRow: number, count: number): number {
    const stride = this.width * BYTES_PER_PIXEL;
    const take = Math.min(count, Math.max(0, this.maxRows - this.rowCount));
    if (take <= 0) return 0;
    this.chunks.push(frame.slice(fromRow * stride, (fromRow + take) * stride));
    this.rowCount += take;
    return take;
  }
}
