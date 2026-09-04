// 常用语云端同步（多设备共用一份短语库）。
//
// 为什么放主进程：常用语存在 umbra-config.json 里，服务端 token 也在同一份配置里，
// 主进程本来就在直接发 HTTP（见 workflow.ts 的 askAssistant）。放这里不用把 token
// 递给渲染层，也不依赖主窗口开着——托盘常驻时照样同步。
// 发请求一律走 core/http.ts 的 httpFetch（Electron net.fetch），不要用 Node 全局 fetch，
// 原因见那个文件的注释（挂代理时后者会连不上）。
//
// 合并策略（用户确认）：**按条目合并 + 删除墓碑**，服务端逐条 last-write-wins。
// 整份覆盖在「两台机器各自新增一条」时会把先推的那条抹掉，用户会莫名其妙丢东西。
// 一次 POST 完成双向同步：推本地全量（含本地墓碑），服务端合并后回全量，本地整份落地。
//
// 注意：常用语在服务端是**明文存储**的（和密码保险箱不同，那个是端到端加密）。
// 真正的密钥类内容应该放保险箱，不要放常用语。
import { ConfigStore, httpBase, type Phrase, type PhraseTomb } from "../config";
import { httpFetch } from "../http";

// 网络超时：同步是后台行为，卡太久不如早点放弃等下一轮。
const TIMEOUT_MS = 15_000;
// 本地改动后延迟多久推送。用户连着改几条（拖拽调序尤其密集）时合并成一次请求。
const PUSH_DEBOUNCE_MS = 3_000;
// 定时拉取间隔：别的设备改了，这个周期内会看到。
const PULL_INTERVAL_MS = 5 * 60_000;

// 同步状态，给设置页显示「上次同步：X 分钟前 / 失败原因」。
export interface PhraseSyncState {
  syncing: boolean;
  lastAt: number;       // 上次成功同步的时间戳，0=从没成功过
  lastError: string;    // 上次失败原因，空串=没失败
  configured: boolean;  // 是否配好了服务器地址与 token
}

// 网络层失败时往往只抛一句笼统的 "fetch failed"，真正的原因（DNS 解不出 / 连不上 /
// 证书不认 / 连接超时）藏在 error.cause 里。不把它带出来的话，界面上那句
// 「同步失败：fetch failed」等于什么都没说 —— 这次的 ECONNRESET 就是靠它定位到
// 「域名被本机 DNS 劫持到 127.0.0.1」的（详见 core/http.ts 的说明）。
function reason(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const c = (e as { cause?: unknown }).cause;
  if (c && typeof c === "object") {
    const code = String((c as { code?: string }).code || "");
    const msg = String((c as { message?: string }).message || "");
    const extra = code || msg;
    if (extra) return `${e.message} · ${extra}`;
  }
  return e.message;
}

export class PhraseSync {
  private state: PhraseSyncState = { syncing: false, lastAt: 0, lastError: "", configured: false };
  private pushTimer: NodeJS.Timeout | undefined;
  private pullTimer: NodeJS.Timeout | undefined;
  private onChanged: () => void;
  // 本地改动计数：schedulePush 每次 +1。sync 发请求前记下当时的值，回包落地前再对一次 ——
  // 请求在飞期间本地又改过的话，这份回包已经落后于本地，整份落地会把刚才的改动冲掉
  //（实锤：拖拽调序两次，第二次落在第一次的回包里被冲回去，「一会儿又变回第五行」）。
  private localSeq = 0;
  // 同步在飞时又来了一次推送请求：记一笔，飞完立刻再来一轮。原来是直接丢掉（return false），
  // 丢掉的那次改动没有任何东西会再推它，直到用户下次改东西 —— 而在那之前它就被回包冲没了。
  private pendingPush = false;

  // onChanged：同步结果落地后回调，让各窗口刷新常用语列表。
  constructor(private cfg: ConfigStore, onChanged: () => void) {
    this.onChanged = onChanged;
  }

  getState(): PhraseSyncState {
    return { ...this.state, configured: this.isConfigured() };
  }

  private isConfigured(): boolean {
    const c = this.cfg.get();
    return Boolean(c.serverUrl && c.token);
  }

  // 启动：先同步一次，之后按周期拉。没配服务器就什么都不做（也不报错）。
  start(): void {
    if (this.pullTimer) clearInterval(this.pullTimer);
    this.pullTimer = setInterval(() => { void this.sync(); }, PULL_INTERVAL_MS);
    void this.sync();
  }

  dispose(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.pullTimer) clearInterval(this.pullTimer);
    this.pushTimer = undefined;
    this.pullTimer = undefined;
  }

  // 本地改动后调用：攒一小会儿再推，避免拖拽调序时一秒钟发好几次。
  schedulePush(): void {
    this.localSeq++;
    if (!this.isConfigured()) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => { this.pushTimer = undefined; void this.sync(); }, PUSH_DEBOUNCE_MS);
  }

  // 一次往返完成双向同步。返回是否成功；失败原因记在 state 里，不抛给调用方
  // （后台行为，弹窗打断用户不合适；设置页会显示上次失败原因）。
  async sync(): Promise<boolean> {
    if (this.state.syncing) {
      this.pendingPush = true;   // 飞完再来一轮，别丢（见字段注释）
      return false;
    }
    if (!this.isConfigured()) {
      this.state.lastError = "";
      return false;
    }
    this.state.syncing = true;
    try {
      const c = this.cfg.get();
      const seq0 = this.localSeq;   // 这份快照对应的本地版本
      const items = (c.phrases || []).map((p, i) => ({
        id: p.id,
        name: p.name || "",
        content: p.content || "",
        keyword: p.keyword || null,
        order: i,                       // 顺序就是数组下标，服务端跟着胜者走
        updatedAt: p.updatedAt || 0,
      }));
      // 标签清单（批次 012）整份带上，服务端按 updatedAt 整份 last-write-wins（清单小，不逐条合并）。
      // 本地从没设过清单（老配置）时不带：带一份 updatedAt=0 的空清单只会被服务端的赢回来，白发。
      const tags = c.phraseTags
        ? { names: c.phraseTags, updatedAt: c.phraseTagsUpdatedAt || 0 }
        : undefined;
      const resp = await httpFetch(`${httpBase(c)}/phrases/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Umbra-Token": c.token },
        body: JSON.stringify({ items, deleted: c.phrasesDeleted || [], ...(tags ? { tags } : {}) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) {
        // 带上响应体的前一小段：404 的 detail、401 的鉴权提示都在里面，
        // 光一个状态码分不清「路由没上线」和「token 不对」。
        const body = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}${body ? ` · ${body.slice(0, 120)}` : ""}`);
      }
      const data = await resp.json() as {
        items?: { id: string; name?: string; content?: string; keyword?: string; updatedAt?: number }[];
        deleted?: PhraseTomb[];
        tags?: { names?: string[]; updatedAt?: number };
      };
      // 服务端回的是合并后的全量，本地整份落地（顺序已按 order 排好）。
      const merged: Phrase[] = (data.items || []).map((x) => ({
        id: String(x.id),
        name: String(x.name || ""),
        content: String(x.content || ""),
        keyword: x.keyword ? String(x.keyword) : undefined,
        updatedAt: Number(x.updatedAt) || 0,
      }));
      if (this.localSeq !== seq0) {
        // 请求在飞期间本地又改过：回包落后于本地，不落地（落地=冲掉刚才的改动）。
        // 记一笔立刻再同步一轮，本地改动随下一轮推上去，那一轮的回包才是一致的。
        this.pendingPush = true;
        this.state.lastAt = Date.now();
        this.state.lastError = "";
        return true;
      }
      // 墓碑也以服务端为准：本地那份已经推上去合并过了，留着只会重复上报。
      // 标签清单同理：服务端回的是合并后的胜者（老服务端不回 tags → 本地那份原样保留）。
      const tagPatch = data.tags && Array.isArray(data.tags.names)
        ? { phraseTags: data.tags.names.map(String), phraseTagsUpdatedAt: Number(data.tags.updatedAt) || 0 }
        : {};
      await this.cfg.save({ phrases: merged, phrasesDeleted: data.deleted || [], ...tagPatch });
      this.state.lastAt = Date.now();
      this.state.lastError = "";
      this.onChanged();
      return true;
    } catch (e) {
      this.state.lastError = reason(e);
      console.error("[phrases] 同步失败：", this.state.lastError, e);
      return false;
    } finally {
      this.state.syncing = false;
      if (this.pendingPush) {
        this.pendingPush = false;
        setTimeout(() => { void this.sync(); }, RERUN_DELAY_MS);
      }
    }
  }
}

// 在飞期间攒下的推送，飞完隔多久再来一轮：给 IPC 落盘一点余量，不用长。
const RERUN_DELAY_MS = 300;

// 给一批常用语盖上改动时间戳：和上一份逐条比，**内容或位置**真变了的才更新 updatedAt。
// 不能无脑全盖 —— 那样任何一次保存都会让本机的所有条目在合并时「赢」过别的设备。
//
// 位置为什么算进去：服务端按条目 last-write-wins，顺序（order）跟着**胜者**走。
// 只比内容的话，纯调序一条都不盖时间戳 → 服务端逐条判「不比库里新」全部丢弃 →
// 回包按库里的旧顺序回来、整份落地 → 拖完过几秒又变回去（sam 实锤）。
// 部分条目恰好因为刚编辑过而时间戳更新，就只有它们赢了 —— 于是出现「落在中间某个位置」
// 那种既不是新序也不是旧序的排列。
export function stampUpdated(next: Phrase[], prev: Phrase[]): Phrase[] {
  const now = Date.now();
  const before = new Map(prev.map((p, i) => [p.id, { p, i }]));
  return next.map((p, i) => {
    const b = before.get(p.id);
    const same = b
      && (b.p.name || "") === (p.name || "")
      && (b.p.content || "") === (p.content || "")
      && (b.p.keyword || "") === (p.keyword || "")
      && b.i === i;
    return same ? { ...p, updatedAt: b.p.updatedAt || now } : { ...p, updatedAt: now };
  });
}

// 对比前后两份列表，算出被删掉的条目，追加成墓碑。
// 没有墓碑的话，这台机器删掉的条目会被别的设备一推又复活。
export function collectTombs(next: Phrase[], prev: Phrase[], existing: PhraseTomb[]): PhraseTomb[] {
  const now = Date.now();
  const alive = new Set(next.map((p) => p.id));
  const out = existing.filter((t) => !alive.has(t.id)); // 又被加回来的条目，墓碑要撤掉
  const known = new Set(out.map((t) => t.id));
  for (const p of prev) {
    if (!alive.has(p.id) && !known.has(p.id)) out.push({ id: p.id, deletedAt: now });
  }
  return out;
}
