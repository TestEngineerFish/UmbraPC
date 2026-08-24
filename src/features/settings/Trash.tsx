// 回收站（设置 → 数据 → 回收站）。对齐 ClaudeDesign 的设置稿。
//
// **界面一页，存储两套。** 这是这个页面唯一需要记住的事：
//   通用区（灵感 / 任务 / 提醒）—— 存在服务端，走 /trash 三个接口
//   保险箱区                   —— 端到端加密，走 vault 的 IPC，服务端连它有几条都不知道
// 两区的条目在同一个多选集合里，批量操作时按 zone 拆开分别派发。
//
// 保险箱那一区**锁着时读不出标题**（没有密钥），只显示一个条数 ——
// 那个数字来自 vault status()，是上次解锁时记在本机 meta.json 里的明文数。
// 这不是「藏起来了」，是密码学事实：解不开就是解不开。
import { useCallback, useEffect, useState } from "react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchTrash, restoreTrash, purgeTrash, purgeAllTrash,
  type TrashEntry, type TrashKind, type TrashList,
} from "../../services/server";
import { hasVault, vaultApi, type VaultTrashRow } from "../tools/bridges";
import { askConfirm, showToast } from "../../components/overlay";
import { btn, EmptyState, RefreshButton } from "../../components/ui";
import { IconBulb, IconList, IconBell, IconLock, IconTrash, IconWallet } from "../../components/icons";

// 四类来源的图标。保险箱那一区统一用锁。
const KIND_ICON: Record<TrashKind, ComponentType<{ size?: number }>> = {
  idea: IconBulb, task: IconList, reminder: IconBell, money: IconWallet,
};

// 行内的两个小按钮取 sm 档（稿里的 ghostS / dangerS）。写成常量而不是每行现算，
// 免得 Tailwind 的 JIT 扫不到 —— 它只认源码里的字面量。
const BTN_S = btn("ghost", "sm");
const BTN_DANGER_S = btn("danger", "sm");
const BTN_GHOST = btn("ghost");
const BTN_DANGER = btn("danger");
const BTN_PRIMARY = btn("primary");

/** 两区合流之后的一行。key 全局唯一 —— 两区的 id 各自独立，光用 id 会撞。 */
type Row = {
  key: string;
  zone: "generic" | "vault";
  title: string;
  from: string;
  deletedAtMs: number;
  leftDays: number;
  kind?: TrashKind;            // generic 才有
  id?: string | number;        // generic 才有
  vaultId?: string;            // vault 才有
  itemId?: string;             // vault 才有
};

interface VaultState {
  /** 保险箱在这台机器上建过没有。没建过就整区不画。 */
  exists: boolean;
  unlocked: boolean;
  /** 锁着时也有值：来自 meta.json 里的明文数字。 */
  count: number;
  rows: VaultTrashRow[];
}
const NO_VAULT: VaultState = { exists: false, unlocked: false, count: 0, rows: [] };

/** 删除时刻 → 「今天 14:02」「昨天 22:10」「8月17日」。
 *
 *  没复用 shell.fmtListTime：那个在「今天」时只回 HH:MM，而这里的文案是
 *  「今天 14:02 删除」——少了「今天」两个字就读不通了。 */
function useWhen() {
  const { t } = useTranslation();
  return (ms: number) => {
    if (!ms) return "";
    const d = new Date(ms);
    const now = new Date();
    const sod = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((sod(now) - sod(d)) / 86400000);
    const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (days <= 0) return t("time.todayAt", { time: hm });
    if (days === 1) return t("time.yesterdayAt", { time: hm });
    if (d.getFullYear() === now.getFullYear()) {
      return t("time.monthDay", { month: d.getMonth() + 1, day: d.getDate() });
    }
    return t("time.yearMonthDay", { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() });
  };
}

/** onChanged：条数变了要通知外面 —— 二级目录上那个「N 项」角标归设置页管，
 *  不同步的话会出现「页面上写着空的、旁边角标还挂着 15 项」。 */
export function Trash({ onChanged }: { onChanged?: (n: number) => void }) {
  const { t } = useTranslation();
  const when = useWhen();
  const [data, setData] = useState<TrashList | null>(null);
  const [vault, setVault] = useState<VaultState>(NO_VAULT);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [d, v] = await Promise.all([fetchTrash(), loadVault()]);
    setData(d);
    setVault(v);
    onChanged?.(d.items.length + (v.unlocked ? v.rows.length : v.count));
    // 刷新后把已经不在列表里的选中项摘掉 —— 别的设备删过一轮之后，
    // 留着一堆指向空气的选中项，点「恢复」会静悄悄什么都不发生。
    const alive = new Set([
      ...d.items.map((x) => `generic:${x.kind}:${x.id}`),
      ...v.rows.map((x) => `vault:${x.vaultId}:${x.itemId}`),
    ]);
    setPicked((prev) => new Set([...prev].filter((k) => alive.has(k))));
  }, [onChanged]);

  useEffect(() => { void reload(); }, [reload]);

  const generic: Row[] = (data?.items || []).map((x) => ({
    key: `generic:${x.kind}:${x.id}`, zone: "generic", kind: x.kind, id: x.id,
    title: x.title, from: t(`trash.kind_${x.kind}`),
    deletedAtMs: x.deleted_at_ms, leftDays: x.left_days,
  }));
  const vaultRows: Row[] = vault.rows.map((x) => ({
    key: `vault:${x.vaultId}:${x.itemId}`, zone: "vault", vaultId: x.vaultId, itemId: x.itemId,
    title: x.title, from: x.from, deletedAtMs: x.deletedAtMs, leftDays: x.leftDays,
  }));

  const counts = data?.counts || { idea: 0, task: 0, reminder: 0, money: 0 };
  const keepDays = data?.keep_days ?? 30;
  // 锁着时用 meta 里的明文数字，解锁后用真实条数。
  const vaultCount = vault.unlocked ? vaultRows.length : vault.count;
  const total = generic.length + vaultCount;
  const allRows = [...generic, ...vaultRows];
  const pickedRows = allRows.filter((r) => picked.has(r.key));

  /** 一批行按 zone 拆开分别派发。两区是两套存储，没有一次调用能同时办完。 */
  const dispatch = async (rows: Row[], what: "restore" | "purge"): Promise<number> => {
    const g: TrashEntry[] = rows.filter((r) => r.zone === "generic")
      .map((r) => ({ kind: r.kind as TrashKind, id: r.id as string | number }));
    const v = rows.filter((r) => r.zone === "vault")
      .map((r) => ({ vaultId: r.vaultId as string, itemId: r.itemId as string }));
    let n = 0;
    if (g.length) n += what === "restore" ? await restoreTrash(g) : await purgeTrash(g);
    if (v.length && hasVault) {
      // 保险箱这一路可能抛「保险箱已锁定」（自动锁定刚好在这中间生效）。
      // 吞掉异常但**不把它算进成功数** —— 下面的吐司会因此说「没有条目被处理」，
      // 比假装成功要诚实。
      try {
        n += what === "restore" ? await vaultApi().restoreTrash(v) : await vaultApi().purgeTrash(v);
      } catch { /* 锁定或 IPC 失败：当作没处理 */ }
    }
    return n;
  };

  const run = async (fn: () => Promise<number>, okKey: string) => {
    setBusy(true);
    const n = await fn();
    setBusy(false);
    await reload();
    setPicked(new Set());
    showToast(n ? t(okKey, { count: n }) : t("trash.nothingDone"), { tone: n ? "ok" : "warn" });
  };

  const doRestore = (rows: Row[]) => run(() => dispatch(rows, "restore"), "trash.restored");

  const doPurge = async (rows: Row[]) => {
    if (!rows.length) return;
    const ok = await askConfirm({
      title: rows.length === 1
        ? t("trash.purgeOneTitle", { name: rows[0].title })
        : t("trash.purgeManyTitle", { count: rows.length }),
      // 保险箱的条目多一句：它的密文会一起擦掉，其它设备下次同步后同样消失。
      message: rows.some((r) => r.zone === "vault") ? t("trash.purgeBodyVault") : t("trash.purgeBody"),
      confirmText: t("trash.purgeConfirm"),
      danger: true,
    });
    if (ok) await run(() => dispatch(rows, "purge"), "trash.purged");
  };

  const doPurgeAll = async () => {
    if (!generic.length) return;
    const ok = await askConfirm({
      title: t("trash.purgeAllTitle"),
      // 稿里这句点名了「保险箱那 N 项需要解锁后单独清，这里动不了」——
      // 那不是界面上的取舍，是服务端确实碰不到那一区。
      message: vaultCount
        ? t("trash.purgeAllBodyWithVault", { count: generic.length, vault: vaultCount })
        : t("trash.purgeAllBody", { count: generic.length }),
      confirmText: t("trash.purgeAllConfirm"),
      danger: true,
    });
    if (ok) await run(purgeAllTrash, "trash.purged");
  };

  const toggle = (k: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });

  const row = (r: Row) => {
    const on = picked.has(r.key);
    const Icon = r.zone === "vault" ? IconLock : KIND_ICON[r.kind as TrashKind];
    // 稿：剩余 ≤ 7 天转 --warning。这是**唯一**的紧迫信号，
    // 没有别的红点/角标，所以这一档不能省。
    const urgent = r.leftDays <= 7;
    return (
      <div key={r.key} onClick={() => toggle(r.key)}
        className={`flex items-center gap-[10px] px-[13px] py-[10px] border-t border-border-soft cursor-pointer ${
          on ? "bg-orange-soft" : "hover:bg-hover"}`}>
        <span className={`w-[15px] h-[15px] flex-none rounded-[4px] flex items-center justify-center ${
          on ? "bg-orange border border-orange" : "border-[1.5px] border-border"}`}>
          {on ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff"
              strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 13l4 4L19 7" />
            </svg>
          ) : null}
        </span>
        <span className="w-[28px] h-[28px] flex-none rounded-[8px] bg-chip text-muted flex items-center justify-center">
          <Icon size={15} />
        </span>
        <div className="flex-1 min-w-0 flex flex-col gap-[2px]">
          <span className="text-[12.5px] truncate">{r.title}</span>
          <span className="text-[11px] text-faint whitespace-nowrap">
            {t("trash.rowMeta", { from: r.from, when: when(r.deletedAtMs) })}
          </span>
        </div>
        <span className={`flex-none w-[78px] text-right text-[11.5px] whitespace-nowrap ${
          urgent ? "text-warning" : "text-faint"}`}>
          {t("trash.leftDays", { count: r.leftDays })}
        </span>
        <button className={BTN_S} disabled={busy}
          onClick={(e) => { e.stopPropagation(); void doRestore([r]); }}>
          {t("trash.restore")}
        </button>
        <button className={BTN_DANGER_S} disabled={busy}
          onClick={(e) => { e.stopPropagation(); void doPurge([r]); }}>
          {t("trash.purge")}
        </button>
      </div>
    );
  };

  if (!total) {
    // compact 档最接近稿（图标 40 / 标题 13.5px），外面再补 14px 上下
    // 凑到稿里的 44px 内边距。非 compact 档没有上下 padding，塞进卡里会贴边。
    return (
      <div className="rounded-[11px] border border-border bg-card py-[14px]">
        <EmptyState compact title={t("trash.emptyTitle")} body={t("trash.emptyBody", { days: keepDays })} />
      </div>
    );
  }

  // 「通用」小标题后面那句：N 项 · 灵感 2、任务 2、提醒 1。
  // 只列条数不为 0 的那几类 —— 稿上是三类都有的示例，实际全写出来会有一串「提醒 0」。
  const breakdown = (["idea", "task", "reminder", "money"] as TrashKind[])
    .filter((k) => counts[k] > 0)
    .map((k) => t(`trash.kind_${k}`) + " " + counts[k])
    .join("、");

  return (
    <div className="flex flex-col gap-[14px]">
      {/* 计数行 + 批量操作条 + 清空 */}
      <div className="flex items-center gap-[9px] flex-wrap">
        <span className="flex-none whitespace-nowrap text-[12px] text-muted">
          {t("trash.countLine", { count: total })}
        </span>
        {pickedRows.length ? (
          <div className="flex items-center gap-[8px] flex-none">
            <span className="flex-none whitespace-nowrap text-[12px] font-semibold text-orange-text">
              {t("trash.selected", { count: pickedRows.length })}
            </span>
            <button className={BTN_GHOST} disabled={busy} onClick={() => void doRestore(pickedRows)}>
              {t("trash.restore")}
            </button>
            <button className={BTN_DANGER} disabled={busy} onClick={() => void doPurge(pickedRows)}>
              {t("trash.purge")}
            </button>
            <button className={BTN_GHOST} onClick={() => setPicked(new Set())}>
              {t("trash.clearSelection")}
            </button>
          </div>
        ) : null}
        <div className="flex-1" />
        <RefreshButton onClick={() => void reload()} />
        <button className={BTN_DANGER} disabled={busy || !generic.length} onClick={() => void doPurgeAll()}>
          {t("trash.purgeAll")}
        </button>
      </div>

      {/* ── 通用区 ── */}
      {generic.length ? (
        <div>
          <div className="flex items-center gap-[8px] mb-[7px]">
            <span className="flex-none text-[11px] font-semibold tracking-[.06em] text-faint">
              {t("trash.zoneGeneric")}
            </span>
            <span className="flex-none whitespace-nowrap text-[11px] text-faint">
              {t("trash.zoneMeta", { count: generic.length, breakdown })}
            </span>
          </div>
          <div className="rounded-[11px] border border-border bg-card overflow-hidden">
            {generic.map(row)}
          </div>
        </div>
      ) : null}

      {/* ── 保险箱区 ── */}
      {hasVault && vault.exists && vaultCount > 0 ? (
        <div>
          <div className="flex items-center gap-[8px] mb-[7px]">
            <span className="flex-none text-[11px] font-semibold tracking-[.06em] text-faint">
              {t("trash.zoneVault")}
            </span>
            <span className="flex-none whitespace-nowrap text-[11px] text-faint">
              {t("trash.zoneVaultMeta", { count: vaultCount })}
            </span>
          </div>
          {vault.unlocked ? (
            <div className="rounded-[11px] border border-border bg-card overflow-hidden">
              {vaultRows.map(row)}
            </div>
          ) : (
            <div className="rounded-[11px] border border-border bg-card px-[18px] py-[16px] flex items-center gap-[12px]">
              <span className="w-[32px] h-[32px] flex-none rounded-[9px] bg-chip text-muted flex items-center justify-center">
                <IconLock size={16} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px]">{t("trash.vaultLocked", { count: vault.count })}</div>
                <div className="text-[11px] text-faint mt-[3px] leading-[1.6]">{t("trash.vaultLockedHint")}</div>
              </div>
              <button className={BTN_PRIMARY} onClick={() => void vaultApi().openWindow()}>
                {t("trash.unlockVault")}
              </button>
            </div>
          )}
        </div>
      ) : null}

      <div className="text-[11.5px] text-faint leading-[1.7]">{t("trash.footer")}</div>
    </div>
  );
}

/** 读保险箱那一区的状态。没装桥（Web 构建）或保险箱没建过 → 整区不画。
 *
 *  锁着时**不去调 listTrash**：主进程会直接抛「保险箱已锁定」，
 *  白白在控制台留一行红字。锁着时该显示的本来就只有 status 里那个数字。 */
async function loadVault(): Promise<VaultState> {
  if (!hasVault) return NO_VAULT;
  try {
    const s = await vaultApi().status();
    if (!s.exists) return NO_VAULT;
    if (!s.unlocked) return { exists: true, unlocked: false, count: s.trashCount || 0, rows: [] };
    const rows = await vaultApi().listTrash();
    return { exists: true, unlocked: true, count: rows.length, rows };
  } catch {
    return NO_VAULT;
  }
}

/** 二级目录上那个「N 项」角标的总数。
 *
 *  在**设置页外层**拉一次：角标要在用户没点进回收站时就显示，不能等页面挂载。
 *  返回 setter 一并交给 <Trash onChanged>，页面里删完/恢复完角标跟着变 ——
 *  不然会出现「页面上写着空的、旁边角标还挂着 15 项」。 */
export function useTrashCount(): [number, (n: number) => void] {
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    void Promise.all([fetchTrash(), loadVault()]).then(([d, v]) => {
      if (alive) setN(d.items.length + (v.unlocked ? v.rows.length : v.count));
    });
    return () => { alive = false; };
  }, []);
  return [n, setN];
}

export { IconTrash };
