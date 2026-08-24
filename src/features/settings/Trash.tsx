// 回收站（设置 → 数据 → 回收站）。对齐 ClaudeDesign 的设置稿。
//
// **这一版只有「通用」区**（灵感 / 任务 / 提醒，都存在服务端）。
// 稿里还有一个「密码保险箱」区 —— 它端到端加密、条目只在本机、锁着时只给条数，
// 走的是完全另一套（vault 的 IPC，服务端连它有几条都不知道）。
// 按 doc/回收站-实现方案.md §7 的分步，那一区是第 4 步，不是这里漏了。
//
// 服务端合并规则：**操控记录在服务端就并进了 task**（任务列表里本来也是混着显示的），
// 所以这里的 kind 只有三种，界面上不会冒出「操控」这个用户没见过的词。
import { useCallback, useEffect, useState } from "react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchTrash, restoreTrash, purgeTrash, purgeAllTrash,
  type TrashItem, type TrashEntry, type TrashKind, type TrashList,
} from "../../services/server";
import { askConfirm, showToast } from "../../components/overlay";
import { btn, EmptyState, RefreshButton } from "../../components/ui";
import { IconBulb, IconList, IconBell, IconTrash } from "../../components/icons";

// 三类来源的图标。顺序即「通用」小标题后面那句 meta 的顺序。
const KIND_ICON: Record<TrashKind, ComponentType<{ size?: number }>> = {
  idea: IconBulb, task: IconList, reminder: IconBell,
};

// 行内的两个小按钮取 sm 档（稿里的 ghostS / dangerS）。写成常量而不是每行现算，
// 免得 Tailwind 的 JIT 扫不到 —— 它只认源码里的字面量。
const BTN_S = btn("ghost", "sm");
const BTN_DANGER_S = btn("danger", "sm");
const BTN_GHOST = btn("ghost");
const BTN_DANGER = btn("danger");

/** 条目的唯一键。三类数据的 id 各自独立（灵感是自增整数），光用 id 会撞。 */
const keyOf = (t: TrashItem) => `${t.kind}:${t.id}`;

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
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const d = await fetchTrash();
    setData(d);
    onChanged?.(d.items.length);
    // 刷新后把已经不在列表里的选中项摘掉 —— 别的设备删过一轮之后，
    // 留着一堆指向空气的选中项，点「恢复」会静悄悄什么都不发生。
    setPicked((prev) => {
      const alive = new Set(d.items.map(keyOf));
      return new Set([...prev].filter((k) => alive.has(k)));
    });
  }, [onChanged]);

  useEffect(() => { void reload(); }, [reload]);

  const items = data?.items || [];
  const counts = data?.counts || { idea: 0, task: 0, reminder: 0 };
  const keepDays = data?.keep_days ?? 30;

  const entriesOf = (list: TrashItem[]): TrashEntry[] => list.map((x) => ({ kind: x.kind, id: x.id }));
  const pickedItems = items.filter((x) => picked.has(keyOf(x)));

  const run = async (fn: () => Promise<number>, okKey: string) => {
    setBusy(true);
    const n = await fn();
    setBusy(false);
    await reload();
    setPicked(new Set());
    showToast(n ? t(okKey, { count: n }) : t("trash.nothingDone"), { tone: n ? "ok" : "warn" });
  };

  const doRestore = (list: TrashItem[]) => run(() => restoreTrash(entriesOf(list)), "trash.restored");

  const doPurge = async (list: TrashItem[]) => {
    if (!list.length) return;
    const ok = await askConfirm({
      title: list.length === 1
        ? t("trash.purgeOneTitle", { name: list[0].title })
        : t("trash.purgeManyTitle", { count: list.length }),
      message: t("trash.purgeBody"),
      confirmText: t("trash.purgeConfirm"),
      danger: true,
    });
    if (ok) await run(() => purgeTrash(entriesOf(list)), "trash.purged");
  };

  const doPurgeAll = async () => {
    if (!items.length) return;
    const ok = await askConfirm({
      title: t("trash.purgeAllTitle"),
      // 稿里这句点名了「保险箱那一区这里动不了」。即使本版还没画保险箱区，
      // 这句也照写 —— 它说的是服务端的真实能力边界，不是界面上有没有那一块。
      message: t("trash.purgeAllBody", { count: items.length }),
      confirmText: t("trash.purgeAllConfirm"),
      danger: true,
    });
    if (ok) await run(purgeAllTrash, "trash.purged");
  };

  if (!items.length) {
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
  const breakdown = (["idea", "task", "reminder"] as TrashKind[])
    .filter((k) => counts[k] > 0)
    .map((k) => t(`trash.kind_${k}`) + " " + counts[k])
    .join("、");

  return (
    <div className="flex flex-col gap-[14px]">
      {/* 计数行 + 批量操作条 + 清空 */}
      <div className="flex items-center gap-[9px] flex-wrap">
        <span className="flex-none whitespace-nowrap text-[12px] text-muted">
          {t("trash.countLine", { count: items.length })}
        </span>
        {pickedItems.length ? (
          <div className="flex items-center gap-[8px] flex-none">
            <span className="flex-none whitespace-nowrap text-[12px] font-semibold text-orange-text">
              {t("trash.selected", { count: pickedItems.length })}
            </span>
            <button className={BTN_GHOST} disabled={busy} onClick={() => void doRestore(pickedItems)}>
              {t("trash.restore")}
            </button>
            <button className={BTN_DANGER} disabled={busy} onClick={() => void doPurge(pickedItems)}>
              {t("trash.purge")}
            </button>
            <button className={BTN_GHOST} onClick={() => setPicked(new Set())}>
              {t("trash.clearSelection")}
            </button>
          </div>
        ) : null}
        <div className="flex-1" />
        <RefreshButton onClick={() => void reload()} />
        <button className={BTN_DANGER} disabled={busy} onClick={() => void doPurgeAll()}>
          {t("trash.purgeAll")}
        </button>
      </div>

      <div>
        <div className="flex items-center gap-[8px] mb-[7px]">
          <span className="flex-none text-[11px] font-semibold tracking-[.06em] text-faint">
            {t("trash.zoneGeneric")}
          </span>
          <span className="flex-none whitespace-nowrap text-[11px] text-faint">
            {t("trash.zoneMeta", { count: items.length, breakdown })}
          </span>
        </div>

        <div className="rounded-[11px] border border-border bg-card overflow-hidden">
          {items.map((it) => {
            const k = keyOf(it);
            const on = picked.has(k);
            const Icon = KIND_ICON[it.kind];
            // 稿：剩余 ≤ 7 天转 --warning。这是**唯一**的紧迫信号，
            // 没有别的红点/角标，所以这一档不能省。
            const urgent = it.left_days <= 7;
            return (
              <div key={k}
                onClick={() => setPicked((p) => {
                  const n = new Set(p);
                  if (n.has(k)) n.delete(k); else n.add(k);
                  return n;
                })}
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
                  <span className="text-[12.5px] truncate">{it.title}</span>
                  <span className="text-[11px] text-faint whitespace-nowrap">
                    {t("trash.rowMeta", { from: t(`trash.kind_${it.kind}`), when: when(it.deleted_at_ms) })}
                  </span>
                </div>
                <span className={`flex-none w-[78px] text-right text-[11.5px] whitespace-nowrap ${
                  urgent ? "text-warning" : "text-faint"}`}>
                  {t("trash.leftDays", { count: it.left_days })}
                </span>
                <button className={BTN_S} disabled={busy}
                  onClick={(e) => { e.stopPropagation(); void doRestore([it]); }}>
                  {t("trash.restore")}
                </button>
                <button className={BTN_DANGER_S} disabled={busy}
                  onClick={(e) => { e.stopPropagation(); void doPurge([it]); }}>
                  {t("trash.purge")}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="text-[11.5px] text-faint leading-[1.7]">{t("trash.footer")}</div>
    </div>
  );
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
    void fetchTrash().then((d) => { if (alive) setN(d.items.length); });
    return () => { alive = false; };
  }, []);
  return [n, setN];
}

export { IconTrash };
