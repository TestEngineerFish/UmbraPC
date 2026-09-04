// 回收站（总设置 → 数据 → 回收站）。批次 013 起**借 PageShell 的设置视图承载**：二级目录里点「回收站」，
// 内容区整体换成「返回设置 + 回收站」的子页（稿《PC 常用语与带图入口》05 节 / tokens.trashChat）——
// 页头副标题「N 项 · 30 天后自动清」+ 红描边「清空回收站」，第二行是类型芯片，内容按类型分组。
// 这个文件只出**数据 hook + 页头零件 + 内容区**三样，PageShell 由 Settings.tsx 拼。
//
// **界面一页，存储三套。** 这是这个页面唯一需要记住的事：
//   通用区（任务 / 灵感 / 提醒 / 流水 / 常用语）—— 存在服务端，走 /trash 三个接口
//   聊天消息                                —— 也在服务端，但另一张表（/messages/trash 一组接口）：
//                                              id 是整数、按会话分、附件是 file_id 数组，到期连附件文件一起清
//   保险箱区                                 —— 端到端加密，走 vault 的 IPC，服务端连它有几条都不知道
// 三区的条目合成同一种 Row，动作按 zone 拆开分别派发。
//
// 保险箱那一区**锁着时读不出标题**（没有密钥），只显示一个条数 ——
// 那个数字来自 vault status()，是上次解锁时记在本机 meta.json 里的明文数。
// 这不是「藏起来了」，是密码学事实：解不开就是解不开。
import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType, CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchTrash, restoreTrash, purgeTrash, purgeAllTrash,
  fetchMessageTrash, restoreMessage, purgeMessages, fetchAllDevices,
  type TrashKind, type TrashList, type TrashMessage, type TrashMessages,
} from "../../services/server";
import { hasLauncher, launcherApi, hasVault, vaultApi, type VaultTrashRow } from "../tools/bridges";
import { askConfirm, showToast } from "../../components/overlay";
import { btn, ConfirmDialog, ContextMenu, EmptyState, filterChip } from "../../components/ui";
import { Skeleton } from "../../components/layout";
import {
  IconAlert, IconBell, IconBulb, IconChat, IconImage, IconList, IconLock, IconPhrase, IconTrash, IconUndo, IconWallet,
} from "../../components/icons";

/** 页头第二行的类型芯片。顺序即渲染顺序；「全部」时各组也按这个顺序叠放。
 *  **没有工作区** —— 工作区没有回收站；常用语是批次 013 新进的（墓碑进回收站）。 */
export type TrashChip = "all" | "task" | "idea" | "reminder" | "money" | "phrase" | "chat";
const CHIPS: TrashChip[] = ["all", "task", "idea", "reminder", "money", "phrase", "chat"];
type GroupKey = Exclude<TrashChip, "all">;
const GROUPS: GroupKey[] = ["task", "idea", "reminder", "money", "phrase", "chat"];

/** 芯片与分组头共用的类型名。流水那一类分两个词：芯片 / 分组头叫「流水」（数据的名字），
 *  行里的来源列叫「记账」（模块的名字，沿用 trash.kind_money）—— 和记账页「记账 → 流水」同一套叫法。 */
const GROUP_LABEL: Record<GroupKey, string> = {
  task: "trash.kind_task", idea: "trash.kind_idea", reminder: "trash.kind_reminder",
  money: "trash.chipMoney", phrase: "trash.kind_phrase", chat: "trash.kind_chat",
};

type IconComp = ComponentType<{ size?: number; style?: CSSProperties }>;
// 通用区五类的图标。聊天消息：文字用 bubble 水平翻转、图片用 image（行里现取）；保险箱那一区统一用锁。
const KIND_ICON: Record<TrashKind, IconComp> = {
  idea: IconBulb, task: IconList, reminder: IconBell, money: IconWallet, phrase: IconPhrase,
};

// 行尾「找回」：稿是 26 高 / padding 0 11 / 11.5px 描边。kit 的 btn 只有 32 / 28 两档，这一档按稿写成字面量
// （Tailwind JIT 只认源码里的字面量，不能拼）。皮肤照 ghost：hover 只转描边与文字色；禁用态 --chip 底 + --faint 字。
const ROW_BTN =
  "flex items-center flex-none whitespace-nowrap h-[26px] px-[11px] rounded-[7px] border border-border bg-card text-text text-[11.5px] " +
  "cursor-pointer transition-colors duration-[130ms] ease-out hover:border-orange hover:text-orange-text " +
  "disabled:bg-chip disabled:text-faint disabled:border-transparent disabled:cursor-not-allowed " +
  "disabled:hover:bg-chip disabled:hover:text-faint disabled:hover:border-transparent";
const BTN_PRIMARY = btn("primary");

/** 三区合流之后的一行。key 全局唯一 —— 三区的 id 各自独立（消息是整数、任务是 uuid），光用 id 会撞。 */
interface Row {
  key: string;
  zone: "generic" | "vault" | "chat";
  /** 落在哪个分组（保险箱单列在最后，不在芯片里）。 */
  group: GroupKey | "vault";
  /** 显示文字：条目标题 / 消息单行预览 / 图片消息「图片 · N 张」。 */
  title: string;
  /** 会话名 / 来源列：秘书、设备名；通用区放类型（灵感 / 记账…），保险箱放条目类型（登录 / 安全笔记…）。 */
  source: string;
  leftDays: number;
  /** 聊天消息：图片消息（图标换 image，不翻转）。 */
  image?: boolean;
  kind?: TrashKind;            // generic 才有
  id?: string | number;        // generic 才有
  vaultId?: string;            // vault 才有
  itemId?: string;             // vault 才有
  msgId?: number;              // chat 才有
}

interface VaultState {
  /** 保险箱在这台机器上建过没有。没建过就整区不画。 */
  exists: boolean;
  unlocked: boolean;
  /** 锁着时也有值：来自 meta.json 里的明文数字。 */
  count: number;
  rows: VaultTrashRow[];
}
const NO_VAULT: VaultState = { exists: false, unlocked: false, count: 0, rows: [] };

const EMPTY_GENERIC: TrashList = { items: [], counts: { idea: 0, task: 0, reminder: 0, money: 0, phrase: 0 }, keep_days: 30 };
const EMPTY_MSGS: TrashMessages = { items: [], keep_days: 30, total_bytes: 0 };

/** 一次把三区都拉回来。设备会话名只有真有 device:<id> 的消息时才去拉一次设备清单
 *  （离线设备也在 /devices/all 里）；拉不到就显示 id —— 露个 id 比空白诚实。 */
interface Loaded { generic: TrashList; msgs: TrashMessages; vault: VaultState; devices: Record<string, string> }
async function loadAll(): Promise<Loaded> {
  const [generic, msgs, vault] = await Promise.all([fetchTrash(), fetchMessageTrash(), loadVault()]);
  const devices: Record<string, string> = {};
  if (msgs.items.some((m) => m.conversation.startsWith("device:"))) {
    for (const d of await fetchAllDevices()) devices[d.device_id] = d.device_name;
  }
  return { generic, msgs, vault, devices };
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

/** 常用语墓碑找回 / 彻底删除之后，PC 主进程那份常用语（快捷入口面板搜的就是它）要立刻跟上，
 *  不等下一轮定时同步 —— 否则会出现「回收站里已经找回了、面板里还搜不到」。没有桥（Web 构建）就算了。 */
async function syncPhrases(): Promise<void> {
  if (!hasLauncher) return;
  try { await launcherApi().phrasesSyncNow(); } catch { /* 同步失败下一轮定时同步会补上 */ }
}

/** 吐司 / 弹窗标题里的条目名：消息预览可能整段几百字，截到 24 字 —— 吐司是 nowrap 的，不截会拖出屏幕。 */
function short(s: string, n = 24): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 消息 → 行里的预览文字。图片消息写「图片 · N 张」；带附件的文字消息就写文字（换行替成空格，只给一行）；
 *  文字为空又带附件的（快捷入口「纯图交给秘书」那种）也按图片消息算。 */
function msgPreview(m: TrashMessage, t: (k: string, o?: Record<string, unknown>) => string): { title: string; image: boolean } {
  const text = m.content.replace(/\s+/g, " ").trim();
  const n = m.atts.length;
  if (m.kind === "image" || (!text && n > 0)) return { title: t("trash.imageMsg", { count: n || 1 }), image: true };
  return { title: text || t("common.none"), image: false };
}

/** 会话名：assistant → 「秘书」；device:<id> → 设备名，取不到就显示 id；别的原样。和聊天页 convLabel 同一套映射。 */
function convLabel(conv: string, devices: Record<string, string>, t: (k: string) => string): string {
  if (conv === "assistant") return t("chat.secretary");
  if (conv.startsWith("device:")) {
    const id = conv.slice("device:".length);
    return devices[id] || id;
  }
  return conv;
}

/** useTrashPage 交给 Settings.tsx 的东西：页头要 total / keepDays / purgeAll / canPurgeAll，
 *  芯片行与内容区各自是一个组件（TrashChips / TrashContent），拿着这个对象画。 */
export interface TrashPage {
  /** 三区总数（保险箱锁着时按 meta 里的数）：二级目录角标与页头副标题都用它。 */
  total: number;
  keepDays: number;
  /** 第一趟数据到了没有：没到之前内容区画骨架，不画空态。 */
  loaded: boolean;
  busy: boolean;
  chip: TrashChip;
  setChip: (c: TrashChip) => void;
  rows: Row[];
  vault: VaultState;
  /** 聊天消息那一区的合计（卡底「共 N 项 · 占用 X MB」）。 */
  msgs: TrashMessages;
  /** 正在二次确认「彻底删除」的那一行。 */
  purging: Row | null;
  restore: (r: Row) => Promise<void>;
  purge: (r: Row) => void;
  confirmPurge: () => Promise<void>;
  cancelPurge: () => void;
  purgeAll: () => Promise<void>;
  canPurgeAll: boolean;
  reload: () => Promise<void>;
}

/** 回收站的数据与动作，挂在 Settings 外层（PageShell 之上）：页头副标题 / 「清空回收站」/ 芯片 / 内容都要同一份数据，
 *  二级目录上那个「N 项」角标也是 —— 角标要在用户没点进回收站时就显示，所以**挂载就拉一次**；
 *  视图每次打开（open 翻成 true）再拉一次，别的设备删过一轮之后进来看到的才是新的。
 *  initialChip：聊天页 ⋯ 的「回收站」进来预选「聊天消息」（那是快捷方式，不是第二份界面）。 */
export function useTrashPage({ open, initialChip }: { open: boolean; initialChip?: string }): TrashPage {
  const { t } = useTranslation();
  const [chip, setChip] = useState<TrashChip>(() => (CHIPS.includes(initialChip as TrashChip) ? (initialChip as TrashChip) : "all"));
  const [data, setData] = useState<Loaded>({ generic: EMPTY_GENERIC, msgs: EMPTY_MSGS, vault: NO_VAULT, devices: {} });
  // 第一趟拉回来之前不算「空」：跳转直达时视图和数据同时起步，不挡一下会先闪一屏「回收站是空的」。
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [purging, setPurging] = useState<Row | null>(null);

  const reload = useCallback(async () => { setData(await loadAll()); setLoaded(true); }, []);
  const first = useRef(true);
  useEffect(() => {
    const isFirst = first.current;
    first.current = false;
    if (isFirst || open) void reload();
  }, [open, reload]);

  const { generic, msgs, vault, devices } = data;
  const rows: Row[] = [
    ...generic.items.map((x): Row => ({
      key: `generic:${x.kind}:${x.id}`, zone: "generic", group: x.kind, kind: x.kind, id: x.id,
      title: x.title, source: t(`trash.kind_${x.kind}`), leftDays: x.left_days,
    })),
    ...msgs.items.map((m): Row => {
      const p = msgPreview(m, t);
      return {
        key: `chat:${m.id}`, zone: "chat", group: "chat", msgId: m.id, image: p.image,
        title: p.title, source: convLabel(m.conversation, devices, t), leftDays: m.left_days,
      };
    }),
    ...vault.rows.map((x): Row => ({
      key: `vault:${x.vaultId}:${x.itemId}`, zone: "vault", group: "vault", vaultId: x.vaultId, itemId: x.itemId,
      title: x.title, source: x.from, leftDays: x.leftDays,
    })),
  ];
  // 锁着时用 meta 里的明文数字，解锁后用真实条数。
  const vaultCount = vault.unlocked ? vault.rows.length : vault.count;
  const serverCount = generic.items.length + msgs.items.length;
  const total = serverCount + vaultCount;

  /** 一行按 zone 派发。三区是三套存储，没有一次调用能同时办完。 */
  const dispatch = async (r: Row, what: "restore" | "purge"): Promise<number> => {
    if (r.zone === "chat") {
      const id = r.msgId as number;
      return what === "restore" ? restoreMessage(id) : purgeMessages([id]);
    }
    if (r.zone === "vault") {
      if (!hasVault) return 0;
      // 保险箱这一路可能抛「保险箱已锁定」（自动锁定刚好在这中间生效）。
      // 吞掉异常但**不把它算进成功数** —— 下面的吐司会因此说「没有条目被处理」，比假装成功要诚实。
      try {
        const e = [{ vaultId: r.vaultId as string, itemId: r.itemId as string }];
        return what === "restore" ? await vaultApi().restoreTrash(e) : await vaultApi().purgeTrash(e);
      } catch { return 0; }
    }
    const e = [{ kind: r.kind as TrashKind, id: r.id as string | number }];
    const n = what === "restore" ? await restoreTrash(e) : await purgeTrash(e);
    if (r.kind === "phrase") await syncPhrases();
    return n;
  };

  /** 找回也过一道确认（批次 004，文案照稿）。**非破坏性**确认 —— 确认键不走红：
   *  拦的不是危险，是「点错行」；正文顺带说清后果（回原位、统计跟着回来 / 回到原会话的原位置）。 */
  const restore = async (r: Row) => {
    const ok = await askConfirm({
      title: r.zone === "chat" ? t("trash.recoverMsgTitle") : t("trash.restoreOneTitle", { name: short(r.title) }),
      message: r.zone === "chat" ? t("trash.recoverMsgBody") : r.zone === "vault" ? t("trash.restoreBodyVault") : t("trash.restoreBody"),
      confirmText: t("trash.recover"),
    });
    if (!ok) return;
    setBusy(true);
    const n = await dispatch(r, "restore");
    setBusy(false);
    await reload();
    // 成了报名字；没成如实说 —— 比假装成功诚实。
    showToast(n ? t("trash.restoredOne", { name: short(r.title) }) : t("trash.nothingDone"), { tone: n ? "ok" : "warn" });
  };

  // 彻底删除：右键菜单进来，先开 480 二次确认（带 danger 横幅），确认了才真删。
  const purge = (r: Row) => setPurging(r);
  const cancelPurge = () => setPurging(null);
  const confirmPurge = async () => {
    const r = purging;
    if (!r) return;
    setBusy(true);
    const n = await dispatch(r, "purge");
    setBusy(false);
    setPurging(null);
    await reload();
    showToast(n ? t("trash.purged", { count: n }) : t("trash.nothingDone"), { tone: n ? "ok" : "warn" });
  };

  /** 清空 = 通用区 + 聊天消息一起清（两张表两个接口，并发发）。保险箱那一区服务端碰不到，
   *  稿里那句「保险箱那 N 项需要解锁后单独清，这里动不了」不是界面上的取舍，是事实。 */
  const purgeAll = async () => {
    if (!serverCount) return;
    const ok = await askConfirm({
      title: t("trash.purgeAllTitle"),
      message: vaultCount
        ? t("trash.purgeAllBodyWithVault", { count: serverCount, vault: vaultCount })
        : t("trash.purgeAllBody", { count: serverCount }),
      confirmText: t("trash.purgeAllConfirm"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    const hadPhrases = generic.items.some((x) => x.kind === "phrase");
    const [a, b] = await Promise.all([purgeAllTrash(), purgeMessages([], true)]);
    if (hadPhrases) await syncPhrases();
    setBusy(false);
    await reload();
    const n = a + b;
    showToast(n ? t("trash.purged", { count: n }) : t("trash.nothingDone"), { tone: n ? "ok" : "warn" });
  };

  return {
    total, keepDays: generic.keep_days, loaded, busy, chip, setChip, rows, vault, msgs, purging,
    restore, purge, confirmPurge, cancelPurge, purgeAll, canPurgeAll: serverCount > 0 && !busy, reload,
  };
}

/** 页头第二行：类型芯片（filterChip 的 sm 档，决策 D11）+ 右端一句「保险箱那一区要解锁后单独看」。
 *  芯片不带计数、不因为某类为空而藏起来 —— 稿上七颗常驻。 */
export function TrashChips({ page }: { page: TrashPage }) {
  const { t } = useTranslation();
  return (
    <>
      {CHIPS.map((c) => (
        <button key={c} className={filterChip(page.chip === c, "sm")} onClick={() => page.setChip(c)}>
          {c === "all" ? t("trash.chipAll") : t(GROUP_LABEL[c])}
        </button>
      ))}
      <span className="flex-1" />
      <span className="flex-none whitespace-nowrap text-[11px] text-faint">{t("trash.vaultAside")}</span>
    </>
  );
}

/** 内容区：padding 20/24/24、最宽 920，按类型分组。「全部」= 各组依次叠放，选了某芯片只显示那一组；组为空不画。
 *  保险箱那一区仍单列在最后（只在「全部」下出现）：解锁了才画标题与行，锁着只画「N 项 · 解锁后可查看 + 解锁保险箱」那块卡。 */
export function TrashContent({ page }: { page: TrashPage }) {
  const { t } = useTranslation();
  const { chip, rows, vault, total, keepDays, loaded, busy, msgs } = page;
  const vaultCount = vault.unlocked ? vault.rows.length : vault.count;

  // 首屏：三行骨架（不做动画，设计定）；刷新已有列表不换骨架。
  if (!loaded) return <Skeleton rows={3} />;
  if (!total) {
    return <EmptyState compact title={t("trash.emptyTitle")} body={t("trash.emptyBody", { days: keepDays })} />;
  }

  const groups = (chip === "all" ? GROUPS : [chip])
    .map((g) => ({ g, rows: rows.filter((r) => r.group === g) }))
    .filter((x) => x.rows.length > 0);
  const showVault = chip === "all" && hasVault && vault.exists && vaultCount > 0;
  const groupHead = (label: string, count: number, aside?: string) => (
    <div className="flex items-center gap-[8px] px-[2px]">
      <span className="flex-none whitespace-nowrap text-[11px] font-semibold tracking-[.06em] text-faint">{label}</span>
      <span className="flex-none whitespace-nowrap text-[11px] text-faint [font-variant-numeric:tabular-nums]">{t("trash.groupCount", { count })}</span>
      <span className="flex-1" />
      {aside ? <span className="flex-none whitespace-nowrap text-[11px] text-faint">{aside}</span> : null}
    </div>
  );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="p-[20px_24px_24px] max-w-[920px] flex flex-col gap-[18px]">
        {/* 选了某颗芯片但那一类是空的：不能留一块白，给一句话。整站空只在上面那个分支。 */}
        {!groups.length && !showVault ? <EmptyState compact title={t("trash.chipEmpty")} /> : null}

        {groups.map(({ g, rows: rs }) => (
          <section key={g} className="flex flex-col gap-[8px]">
            {groupHead(t(GROUP_LABEL[g]), rs.length, g === "chat" ? t("trash.chatGroupHint") : undefined)}
            <div className="bg-card border border-border rounded-[12px] overflow-hidden">
              {/* 行单独包一层，末行的 last:border-b-0 才不会被卡底那一行顶掉。 */}
              <div>
                {rs.map((r) => (
                  <TrashRow key={r.key} row={r} busy={busy} onRestore={() => void page.restore(r)} onPurge={() => page.purge(r)} />
                ))}
              </div>
              {g === "chat" ? (
                // 卡底一行：图片消息的去向 + 「共 N 项 · 占用 X MB」（total_bytes，MB 保留一位小数）。
                <div className="flex items-center gap-[10px] px-[14px] py-[10px] bg-bg">
                  <span className="flex-1 min-w-0 text-[11.5px] leading-[1.6] text-faint">{t("trash.chatFootNote")}</span>
                  <span className="flex-none whitespace-nowrap font-mono text-[11px] font-semibold text-faint">
                    {t("trash.chatFootStat", { count: msgs.items.length, mb: (msgs.total_bytes / 1048576).toFixed(1) })}
                  </span>
                </div>
              ) : null}
            </div>
          </section>
        ))}

        {showVault ? (
          <section className="flex flex-col gap-[8px]">
            {groupHead(t("trash.zoneVault"), vaultCount)}
            {vault.unlocked ? (
              <div className="bg-card border border-border rounded-[12px] overflow-hidden">
                {rows.filter((r) => r.zone === "vault").map((r) => (
                  <TrashRow key={r.key} row={r} busy={busy} onRestore={() => void page.restore(r)} onPurge={() => page.purge(r)} />
                ))}
              </div>
            ) : (
              <div className="bg-card border border-border rounded-[12px] px-[18px] py-[16px] flex items-center gap-[12px]">
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
          </section>
        ) : null}
      </div>

      {page.purging ? (
        <PurgeDialog row={page.purging} busy={busy} onConfirm={() => void page.confirmPurge()} onCancel={page.cancelPurge} />
      ) : null}
    </div>
  );
}

/** 卡内一行（tokens.trashChat.row）：44 高 / padding 0 14 / gap 11 ——
 *  26 图标块 · 内容单行省略 12.5px · 会话名 / 来源定宽 132 · 「还剩 N 天」等宽 74 · 行尾只有「找回」。
 *  没有多选勾选；彻底删除进右键菜单（破坏性项单独一组、放最后、红字 —— 右键菜单的硬规则）。 */
function TrashRow({ row, busy, onRestore, onPurge }: {
  row: Row; busy: boolean; onRestore: () => void; onPurge: () => void;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const Icon: IconComp = row.zone === "vault" ? IconLock
    : row.zone === "chat" ? (row.image ? IconImage : IconChat)
    : KIND_ICON[row.kind as TrashKind];
  // 稿：剩余 < 3 天转 --warning（批次 013 起各类统一成这一档，原来通用区是 ≤ 7 天）。
  // 这是**唯一**的紧迫信号，没有别的红点 / 角标，所以这一档不能省。
  const urgent = row.leftDays < 3;
  return (
    <div onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      className="flex items-center gap-[11px] h-[44px] px-[14px] border-b border-border-soft last:border-b-0 hover:bg-hover">
      <span className="w-[26px] h-[26px] flex-none rounded-[7px] bg-chip text-muted flex items-center justify-center">
        {/* 文字消息的气泡水平翻转（尾巴朝右 = 发出去的那一侧）；图片与其它类型不翻。 */}
        <Icon size={14} style={row.zone === "chat" && !row.image ? { transform: "scaleX(-1)" } : undefined} />
      </span>
      <span className="flex-1 min-w-0 truncate text-[12.5px]">{row.title}</span>
      <span className="w-[132px] flex-none truncate text-[11.5px] text-muted">{row.source}</span>
      <span className={`w-[74px] flex-none whitespace-nowrap font-mono text-[11px] font-semibold ${urgent ? "text-warning" : "text-faint"}`}>
        {t("trash.leftDays", { count: row.leftDays })}
      </span>
      <button className={ROW_BTN} disabled={busy} onClick={onRestore}>{t("trash.recover")}</button>
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { label: t("trash.recover"), icon: <IconUndo size={13} />, onClick: onRestore, disabled: busy },
          { divider: true },
          { label: t("trash.purge"), icon: <IconTrash size={13} />, danger: true, onClick: onPurge, disabled: busy },
        ]} />
      ) : null}
    </div>
  );
}

/** 彻底删除的 480 二次确认（稿 05 节右下）：标题 + 一块 danger 横幅（1px --danger + --danger-soft + 圆角 9 +
 *  padding 11/12，警示图标 + 11.5px --danger 正文）+ 实心红「彻底删除」—— 实心红只在这里。
 *  保险箱的条目换它自己那句：密文一并擦掉，其它设备下次同步后同样消失。 */
function PurgeDialog({ row, busy, onConfirm, onCancel }: {
  row: Row; busy: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      title={row.zone === "chat" ? t("trash.purgeMsgTitle") : t("trash.purgeItemTitle")}
      confirmText={t("trash.purgeConfirm")}
      danger busy={busy} onConfirm={onConfirm} onCancel={onCancel}
      message={
        <div className="flex gap-[9px] px-[12px] py-[11px] rounded-[9px] border border-danger bg-danger-soft">
          <IconAlert size={15} strokeWidth={1.9} className="flex-none mt-[1px] text-danger" />
          <span className="flex-1 min-w-0 text-[11.5px] leading-[1.65] text-danger [text-wrap:pretty]">
            {row.zone === "vault" ? t("trash.purgeBodyVault") : t("trash.purgeBanner")}
          </span>
        </div>
      }
    />
  );
}
