// 提醒与服务端的同步。形状照抄 launcher/phrases-sync.ts（已验证过的范式），
// 只把「全量往返」换成「since 增量 + 逐条 PUT」——提醒会长期累积几百条，
// 全量推不划算，而合并规则本身完全一致：逐条 last-write-wins + 删除墓碑。
//
// 发请求一律走 core/http.ts 的 httpFetch（Electron net.fetch），**不要用 Node 全局 fetch**：
// 后者不认系统代理，挂 VPN 时域名会被本机 DNS 解到 127.0.0.1，表现为「聊天能用、
// 偏偏同步不行」。详见那个文件的注释。
import { httpBase, type ConfigStore } from "../config";
import { httpFetch } from "../http";
import { MAX_ATTS, type Reminder, type ReminderAtt, type ReminderTomb } from "./types";

// 网络超时：同步是后台行为，卡太久不如早点放弃等下一轮。
const TIMEOUT_MS = 15_000;

// 服务端的线格式（snake_case）。**camelCase ↔ snake_case 的映射只在本文件做**，
// 别处一律用 Reminder（camelCase），改字段时只有这一处要跟着改。
interface WireReminder {
  id: string;
  text: string;
  note: string;
  at_ms: number;
  repeat_rule: string;
  custom_freq: string;
  custom_n: number;
  repeat_end_ms: number | null;
  ahead_minutes: number;
  done: boolean;
  source: string;
  tz: string;
  updated_at_ms: number;
  deleted: boolean;
  // 附件。**推送时永远带上这个键**（哪怕是 []）：服务端把「没这个键」当「没提附件、
  // 保留库里那份」，PC 想清空附件就必须明确发 []。
  atts?: WireAtt[];
}

interface WireAtt { file_id: string; label: string }

/** 服务端 → 本地的附件列表。file_id 空的丢掉、超上限截掉：这两种只可能是协议出了岔子，
 *  兜成保守值比让整条提醒解析失败强。 */
function attsFromWire(list: unknown): ReminderAtt[] {
  if (!Array.isArray(list)) return [];
  const out: ReminderAtt[] = [];
  for (const a of list as Partial<WireAtt>[]) {
    const fileId = String(a?.file_id || "").trim();
    if (fileId && !out.some((x) => x.fileId === fileId)) out.push({ fileId, label: String(a?.label || "") });
  }
  return out.slice(0, MAX_ATTS);
}

interface WireTomb { id: string; deleted_at_ms: number }
interface WireList { items: WireReminder[]; deleted: WireTomb[]; synced_at_ms: number }
interface WirePut { applied: boolean; reminder: WireReminder }

// 服务端 → 本地。枚举值直接透传：两端用的是同一套英文白名单，
// 出现别的值说明服务端改了协议，这里兜到最保守的默认而不是让整条烂掉。
function fromWire(w: WireReminder): Reminder {
  const rules = ["none", "daily", "weekly", "monthly", "weekday", "custom"];
  const freqs = ["hour", "day", "week", "month", "year"];
  const sources = ["manual", "chat", "task"];
  return {
    id: String(w.id),
    text: String(w.text || ""),
    note: String(w.note || ""),
    atMs: Number(w.at_ms) || 0,
    repeatRule: (rules.includes(w.repeat_rule) ? w.repeat_rule : "none") as Reminder["repeatRule"],
    customFreq: (freqs.includes(w.custom_freq) ? w.custom_freq : "day") as Reminder["customFreq"],
    customN: Math.max(1, Number(w.custom_n) || 1),
    repeatEndMs: w.repeat_end_ms === null || w.repeat_end_ms === undefined ? null : Number(w.repeat_end_ms),
    aheadMinutes: Number(w.ahead_minutes) || 0,
    done: Boolean(w.done),
    source: (sources.includes(w.source) ? w.source : "manual") as Reminder["source"],
    tz: String(w.tz || ""),
    updatedAtMs: Number(w.updated_at_ms) || 0,
    dirty: false,           // 服务端来的一定是「干净的」
    atts: attsFromWire(w.atts),
  };
}

// 本地 → 服务端。
function toWire(r: Reminder): WireReminder {
  return {
    id: r.id,
    text: r.text,
    note: r.note,
    at_ms: r.atMs,
    repeat_rule: r.repeatRule,
    custom_freq: r.customFreq,
    custom_n: Math.max(1, r.customN),
    repeat_end_ms: r.repeatEndMs,
    ahead_minutes: r.aheadMinutes,
    done: r.done,
    source: r.source,
    tz: r.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    updated_at_ms: r.updatedAtMs,
    deleted: false,
    atts: (r.atts || []).slice(0, MAX_ATTS).map((a) => ({ file_id: a.fileId, label: a.label || "" })),
  };
}

// 网络层失败往往只抛一句笼统的 "fetch failed"，真正原因藏在 error.cause 里。
// 不带出来的话界面上那句「同步失败：fetch failed」等于什么都没说。
function reason(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const c = (e as { cause?: unknown }).cause;
  if (c && typeof c === "object") {
    const extra = String((c as { code?: string }).code || "") || String((c as { message?: string }).message || "");
    if (extra) return `${e.message} · ${extra}`;
  }
  return e.message;
}

/** 拉增量的结果。失败时返回 null —— 别把「拉失败」和「服务端真的没有提醒」混成一个值。 */
export interface PullResult {
  items: Reminder[];
  tombs: ReminderTomb[];
  syncedAtMs: number;
}

export class NotifyApi {
  constructor(private cfg: ConfigStore) {}

  isConfigured(): boolean {
    const c = this.cfg.get();
    return Boolean(c.serverUrl && c.token);
  }

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", "X-Umbra-Token": this.cfg.get().token };
  }

  /** GET /reminders?since=…。失败抛异常，由调用方记进 state.lastError。 */
  async pull(since: number): Promise<PullResult> {
    const c = this.cfg.get();
    const resp = await httpFetch(`${httpBase(c)}/reminders?since=${since}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      // 带上响应体前一小段：404 的 detail、401 的鉴权提示都在里面，
      // 光一个状态码分不清「路由没上线」和「token 不对」。
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}${body ? ` · ${body.slice(0, 120)}` : ""}`);
    }
    const data = (await resp.json()) as WireList;
    return {
      items: (data.items || []).map(fromWire),
      tombs: (data.deleted || []).map((t) => ({ id: String(t.id), deletedAtMs: Number(t.deleted_at_ms) || 0 })),
      syncedAtMs: Number(data.synced_at_ms) || 0,
    };
  }

  /**
   * PUT /reminders/{id}。返回服务端采纳与否 + 它那边的最终值。
   * applied=false 表示「本地这版更旧、没采纳」，调用方要用回来的那份覆盖本地，
   * 否则会一轮一轮反复推一个必输的版本。
   */
  async put(r: Reminder): Promise<{ applied: boolean; reminder: Reminder }> {
    const c = this.cfg.get();
    const resp = await httpFetch(`${httpBase(c)}/reminders/${encodeURIComponent(r.id)}`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(toWire(r)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}${body ? ` · ${body.slice(0, 120)}` : ""}`);
    }
    const data = (await resp.json()) as WirePut;
    return { applied: Boolean(data.applied), reminder: fromWire(data.reminder) };
  }

  /**
   * DELETE /reminders/{id}?at_ms=…。
   * at_ms 是**本地实际删除的时刻**，离线补推时必须带上 —— 不带的话服务端按「现在」算，
   * 「两天前离线删的」会盖掉「昨天在手机上改的」，判反。
   */
  async remove(id: string, atMs: number): Promise<void> {
    const c = this.cfg.get();
    const resp = await httpFetch(
      `${httpBase(c)}/reminders/${encodeURIComponent(id)}?at_ms=${atMs}`,
      { method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}${body ? ` · ${body.slice(0, 120)}` : ""}`);
    }
  }
}

export { reason as syncFailureReason };
