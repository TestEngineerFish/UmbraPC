// 提醒页：列表 + 新建/编辑弹窗。批次 012 起套页面骨架的 **T2 列表 + 弹窗**：
//   页头：「提醒 · N 条」+ 同步戳（SyncStamp）+ 主按钮「新建提醒」；
//   内容：ListModal 滚动容器，按分组（已过期 / 今天 / 明天 …）各一张 Group 卡，卡内逐行 GroupRow；
//   空态走通用 EmptyState；编辑 / 新建仍是 560 宽的 Modal，删除仍是 ConfirmDialog。
//
// 数据全在主进程（core/notify），这里只做展示与派发 —— 到点触发、同步、角标都不归渲染层管，
// 因为托盘常驻时主窗口可能根本没开着，逻辑放这里会整个失效。
//
// 与 iOS 保持一致的地方：分组口径（过期排最前）、重复规则的六个选项、
// 提前提醒的五个档位、「再等 10 分钟」。两端选项不一样会让人以为数据丢了。
//
// 纯逻辑（分组 / 文案 / 日期换算 / 默认值 / 校验）都在 reminderKit.ts，这里只管画。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ConfirmDialog, ContextMenu, EmptyState, ErrorCard, Modal, Pill, Segmented, btn, btnGhost, btnPrimary, field, select as selectCls,
  textarea as textareaCls,
} from "../../components/ui";
// 注意：本文件自己有一个 ReminderRow（原名 ListRow），和 layout 里的 ListRow 同名不同物 ——
// 这里只用 T2 的三件（ListModal / Group / GroupRow），不要把 layout 的 ListRow 引进来。
import { PageShell, ListModal, Group, GroupRow } from "../../components/layout";
import { DateTimeField } from "../../components/DateTimePicker";
import { IconImage, IconRepeat } from "../../components/icons";
import { ImageViewer, openInViewerWindow } from "../../components/ImageViewer";
import { SyncStamp } from "../../components/SyncStamp";
import { askConfirm, showToast } from "../../components/overlay";
import { fileUrl, uploadFile } from "../../services/server";
import { useNow } from "../../services/relativeTime";
import {
  hasNotify, notifyApi,
  type CustomFreq, type NotifySyncState, type Reminder, type ReminderAtt, type RepeatRule,
} from "./bridge";
import {
  AHEAD_OPTIONS, FREQ_LABELS, GROUP_ORDER, MAX_ATTS, NOTE_MAX, RULE_LABELS, TEXT_MAX,
  canSnooze, combineDateTime, dateLabel, defaultRepeatEnd, endOfDay, fromDateInput, groupOf,
  normalizeReminder, repeatEndError, repeatLabel, timeLabel, toDateInput, toTimeInput, validateReminder,
} from "./reminderKit";

// 新建时的默认提醒：默认定在一小时后的整点，比「此刻」更像用户想要的。
function blank(): Reminder {
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(0, 0, 0);
  return {
    id: newId(),
    text: "", note: "", atMs: d.getTime(),
    repeatRule: "none", customFreq: "day", customN: 1, repeatEndMs: null,
    aheadMinutes: 0, done: false, source: "manual",
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    updatedAtMs: 0, dirty: true, atts: [],
  };
}

function newId(): string {
  return `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 「再来一条」：拿一条已完成的提醒当模板起一条新的 —— 内容、备注、重复规则、提前量都照抄，
 * 时间回到默认（一小时后整点），结束日期按规则重新给默认。
 * **附件不抄**：文件 id 在服务端是「谁引用谁负责清」，两条提醒共用同一个 id，
 * 删其中一条就会把另一条的图也清掉。
 */
function cloneAsNew(r: Reminder): Reminder {
  const b = blank();
  const repeating = r.repeatRule !== "none";
  return {
    ...b,
    text: r.text, note: r.note,
    repeatRule: r.repeatRule, customFreq: r.customFreq, customN: r.customN,
    repeatEndMs: repeating && r.repeatEndMs !== null
      ? defaultRepeatEnd(r.repeatRule, r.customFreq, r.customN, b.atMs) : null,
    aheadMinutes: r.aheadMinutes,
  };
}

// 弹窗内输入框：弹窗自身就是 card 底，控件再铺 bg 会糊成一片（kit 的约定）。
const fieldCard = field("card");
const textareaCard = textareaCls("card");

export function Reminders() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Reminder[]>([]);
  const [state, setState] = useState<NotifySyncState | null>(null);
  const [editing, setEditing] = useState<Reminder | null>(null);
  // 弹窗是「新建」还是「编辑」。以前是拿 value.text 有没有内容判断的，
  // 于是新建时打下第一个字，标题当场从「新建提醒」跳成「编辑提醒」——
  // 内容有没有字和这条记录存不存在是两回事。
  const [creating, setCreating] = useState(false);
  // 保存失败的原因；空串 = 没失败。挂在这里而不是 Editor 内部，
  // 是因为真正知道成败的是 doSave，而 doSave 在这一层。
  const [saveErr, setSaveErr] = useState("");
  const [removing, setRemoving] = useState<Reminder | null>(null);
  const [syncing, setSyncing] = useState(false);
  // 30s 一跳的「现在」：分组（今天 / 明天）、「再等 10 分钟」该不该给，都跟着它走，
  // 页面开着跨过午夜也不会停在昨天的分组里。
  const now = useNow();

  const refresh = useCallback(async () => {
    if (!hasNotify) return;
    setItems(await notifyApi().list());
    setState(await notifyApi().state());
  }, []);

  useEffect(() => {
    void refresh();
    if (!hasNotify) return;
    // 主进程数据一变就重拉：本地改动、同步拉到手机上的修改、重复提醒被推进，都会触发。
    const off = notifyApi().onChanged(() => { void refresh(); });
    // 点系统通知本体进来 → 高亮那条（这里简单处理成滚动到列表顶部并刷新）。
    const offOpen = notifyApi().onOpen(() => { void refresh(); });
    return () => { off(); offOpen(); };
  }, [refresh]);

  // 按分组归拢，分组内按时间升序。过期的排最前 —— 它最需要被看见。
  const groups = useMemo(() => {
    const map = new Map<string, Reminder[]>();
    for (const r of items) {
      const g = groupOf(r, now);
      const arr = map.get(g) || [];
      arr.push(r);
      map.set(g, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.atMs - b.atMs);
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, rows: map.get(g) as Reminder[] }));
  }, [items, now]);

  if (!hasNotify) {
    // 空态要有文案，不留空白（交接说明的硬约束）。骨架起改走通用 EmptyState，页头照常给。
    return (
      <PageShell header={{ title: t("notify.title") }}>
        <EmptyState title={t("notify.desktopOnly")} body={t("notify.desktopOnlyBody")} />
      </PageShell>
    );
  }

  const doSync = async () => {
    setSyncing(true);
    try {
      const ok = await notifyApi().syncNow();
      await refresh();
      showToast(ok ? "已同步" : "同步失败", { tone: ok ? "ok" : "fail" });
    } finally {
      setSyncing(false);
    }
  };

  const doSave = async (r: Reminder) => {
    // 保存前最后一道闸（reminderKit.validateReminder）。控件各自挡过一遍，
    // 这里再查是因为「控件挡得住」和「状态里没有脏值」是两回事。
    const bad = validateReminder(r);
    if (bad) { setSaveErr(bad); return; }
    // save() 是有返回的：{ ok, error }。之前这里整个丢掉了 —— 服务端连不上也照样关窗、
    // 照样刷新，用户以为存成功了，其实什么都没存。存不上就把窗留着，内容不丢。
    //
    // 失败提示从吐司改成了**弹窗顶边的错误横幅**（稿 296-298）。吐司几秒就没了，
    // 而这条消息要一直挂着 —— 窗还开着、内容还在、等着你再点一次保存，
    // 提示消失了用户就只剩一个「不知道为什么没关」的窗口。
    setSaveErr("");
    const r2 = await notifyApi().save(normalizeReminder(r));
    if (!r2.ok) { setSaveErr(r2.error || "服务端没有响应"); return; }
    setEditing(null);
    await refresh();
    showToast("已保存", { tone: "ok" });
  };

  const openEditor = (r: Reminder, isNew: boolean) => {
    setCreating(isNew);
    setSaveErr("");
    setEditing({ ...r, atts: r.atts || [] });
  };

  // 裁定 8（tokens.pageTemplate.shared.emptyHeaderPrimary）：真空态时页头不渲染「新建提醒」，橙留给空态里那颗。
  // 本页没有搜索 / 筛选，也没有加载态与离线态（数据在主进程，list() 是一次 IPC，同步戳才管服务端连没连上），
  // 「真空」就是 groups 为空（= items 一条都没有），和下面画空态的判定用同一个值。
  // （叫 isBlank 不叫 blank：blank() 是上面那个新建提醒的默认值工厂。）
  const isBlank = groups.length === 0;

  return (
    <PageShell header={{
      title: t("notify.title"),
      subtitle: t("notify.countN", { n: items.length }),
      /* 同步戳进页头的状态槽：刷新按钮和「N 分钟前同步」长在一起（SyncStamp），
         原来一个在最左一个在最右，看起来像两件不相干的事。 */
      status: (
        <SyncStamp
          state={state ? { ...state, offText: "没配服务器地址或令牌，只在这台电脑上生效" } : null}
          spinning={syncing}
          onSync={doSync}
        />
      ),
      primary: isBlank ? undefined : { label: t("notify.newReminder"), onClick: () => openEditor(blank(), true) },
    }}>
      {/* 列表：T2 分组卡。分组头 = 分组名 + 条数，卡内逐行。 */}
      {isBlank ? (
        <EmptyState
          title={t("notify.empty")}
          body={t("notify.emptyBody")}
          actionLabel={t("notify.newReminder")}
          onAction={() => openEditor(blank(), true)}
        />
      ) : (
        <ListModal>
          {groups.map(({ group, rows }) => (
            <Group key={group} title={group} count={t("notify.countN", { n: rows.length })}>
              {rows.map((r) => (
                <ReminderRow key={r.id} r={r} group={group} now={now}
                  onRefresh={refresh}
                  onEdit={() => openEditor(r, false)}
                  onClone={() => openEditor(cloneAsNew(r), true)}
                  onRemove={() => setRemoving(r)} />
              ))}
            </Group>
          ))}
        </ListModal>
      )}

      {editing ? (
        <Editor value={editing} creating={creating} saveErr={saveErr} onRetry={() => setSaveErr("")}
          onChange={setEditing} onSave={doSave} onFail={setSaveErr}
          onClose={() => { setSaveErr(""); setEditing(null); }} />
      ) : null}

      {removing ? (
        <ConfirmDialog
          title={`删除「${removing.text}」？`}
          // 文案改于 2026-08-23（回收站）：原来写的是「删除后无法恢复」，
          // 而它现在**是可以恢复的** —— 进设置 → 数据 → 回收站，30 天内都在。
          // 「其它设备上的这条也会一并删掉」保留：那句仍然是真的，
          // 而且是这个删除跟本地删一条便签最不一样的地方，值得先说。
          message="删除后移入回收站，保留 30 天。其它设备上的这条也会一并删掉。"
          confirmText="移入回收站"
          danger
          onConfirm={async () => {
            const r = await notifyApi().remove(removing.id);
            setRemoving(null);
            await refresh();
            showToast(r.ok ? "已移入回收站 · 保留 30 天" : `删除失败：${r.error || "服务端没有响应"}`,
              { tone: r.ok ? "ok" : "fail" });
          }}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </PageShell>
  );
}

// 列表里的一行（原名 ListRow，改名是为了不和 layout 的 ListRow 撞名）。外壳是 T2 的 GroupRow
// （最小 52 高 / padding 11/14 / 行间发丝线 / hover 底），行内动作按钮用 sm 档（28）才装得进这一行。
// 动作按状态给：
//   待办 → [再等 10 分钟（只对今天及已过期的给）] [编辑]
//   已完成 → [再来一条] —— 完成的东西没有「编辑」，改它只会让历史记录对不上；
//   想再提醒一次就是一条新的。
// 「删除」不在行内（T2 规矩：行内不放删除，破坏性动作进右键菜单）—— 右键这一行。
function ReminderRow({ r, group, now, onRefresh, onEdit, onClone, onRemove }: {
  r: Reminder;
  group: string;
  now: number;
  onRefresh: () => Promise<void>;
  onEdit: () => void;
  onClone: () => void;
  onRemove: () => void;
}) {
  const rep = repeatLabel(r);
  const attN = (r.atts || []).length;
  const rowBtn = btn("ghost", "sm");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <GroupRow onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
      <button
        className="w-[17px] h-[17px] flex-none rounded-full border cursor-pointer bg-transparent"
        style={{
          borderColor: r.done ? "var(--success)" : "var(--border)",
          background: r.done ? "var(--success)" : "transparent",
        }}
        title={r.done ? "标回待办" : "标记完成"}
        onClick={async () => {
          const next = !r.done;
          await notifyApi().setDone(r.id, next);
          await onRefresh();
          // 完成态给一个 5 秒的撤销（稿要求）——「点错了一条提醒」是很常见的误操作，
          // 而这一下是可逆的，给回退比给确认弹窗合适得多。
          showToast(next ? "已完成" : "已标回待办", {
            tone: "ok",
            actionLabel: "撤销",
            onAction: async () => { await notifyApi().setDone(r.id, !next); await onRefresh(); },
          });
        }}
      />
      <div className="min-w-0 flex-1">
        <div
          className="text-[13px] text-text truncate"
          style={{ textDecoration: r.done ? "line-through" : "none", opacity: r.done ? 0.55 : 1 }}
        >
          {r.text}
        </div>
        {/* 第二行：时间 + 重复徽章 + 附件数 + 备注。重复原来只是时间后面拖一小段灰字，
            一眼看不出这条会反复响 —— 现在是「图标 + 文字」的橙软底徽章（状态不只靠颜色）。 */}
        <div className="flex items-center gap-[6px] mt-[3px] min-w-0">
          <span className="flex-none whitespace-nowrap text-[11.5px] text-muted">{timeLabel(r.atMs, now)}</span>
          {rep ? (
            <span className="inline-flex items-center gap-[3px] flex-none whitespace-nowrap px-[6px] h-[18px] rounded-full bg-orange-soft text-orange-text text-[10.5px] font-semibold"
              title={r.repeatEndMs !== null ? `重复到 ${dateLabel(r.repeatEndMs, now)} 为止` : "一直重复"}>
              <IconRepeat size={11} />
              {rep}
              {r.repeatEndMs !== null ? <span className="font-normal">· 到 {dateLabel(r.repeatEndMs, now)}</span> : null}
            </span>
          ) : null}
          {attN > 0 ? (
            <span className="inline-flex items-center gap-[3px] flex-none whitespace-nowrap px-[6px] h-[18px] rounded-full bg-chip text-muted text-[10.5px]"
              title={`${attN} 张附件`}>
              <IconImage size={11} />
              {attN}
            </span>
          ) : null}
          {r.note ? <span className="min-w-0 truncate text-[11.5px] text-muted">· {r.note}</span> : null}
        </div>
      </div>
      {group === "已过期" ? <Pill tone="danger">已逾期</Pill> : null}
      {r.dirty ? <Pill tone="warning">待同步</Pill> : null}
      {canSnooze(r, now) ? (
        <button
          className={rowBtn}
          onClick={async () => { await notifyApi().snooze(r.id, 10); await onRefresh(); showToast("已推迟 10 分钟", { tone: "ok" }); }}
        >
          再等 10 分钟
        </button>
      ) : null}
      {r.done
        ? <button className={rowBtn} title="照这条再建一条新的（附件不带）" onClick={onClone}>再来一条</button>
        : <button className={rowBtn} onClick={onEdit}>编辑</button>}
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          r.done
            ? { label: "再来一条", onClick: onClone }
            : { label: "编辑", onClick: onEdit },
          { divider: true },
          { label: "删除", danger: true, onClick: onRemove },
        ]} />
      ) : null}
    </GroupRow>
  );
}

// 新建时还没上传的图：先攒在本地，点保存才上传。url 是 ObjectURL，撤下时要 revoke。
interface PendingImg { key: string; file: File; url: string }

// 新建 / 编辑弹窗。字段与 iOS 详情页一一对应，少一个都会让两端看起来像两个功能。
function Editor({ value, creating, saveErr, onRetry, onChange, onSave, onFail, onClose }: {
  value: Reminder;
  /** 这次是新建还是编辑。**不要**改回拿 value.text 判断 —— 那会让新建时打下第一个字
   *  标题就跳成「编辑提醒」。内容有没有字和这条记录存不存在是两回事。 */
  creating: boolean;
  /** 上一次保存失败的原因；空串 = 没失败。 */
  saveErr: string;
  onRetry: () => void;
  onChange: (r: Reminder) => void;
  onSave: (r: Reminder) => void;
  /** 附件上传失败这类「还没到保存那一步」的失败，也走同一条横幅。 */
  onFail: (msg: string) => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<Reminder>) => onChange({ ...value, ...patch });
  const [pending, setPending] = useState<PendingImg[]>([]);
  const [uploading, setUploading] = useState(false);
  const [viewer, setViewer] = useState<{ src: string; alt: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 卸载时把 ObjectURL 全放掉，不然每开一次弹窗内存就多占几张图。
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => () => { pendingRef.current.forEach((p) => URL.revokeObjectURL(p.url)); }, []);

  const repeating = value.repeatRule !== "none";
  const attCount = (value.atts || []).length + pending.length;

  // 已存的 + 待上传的合成一组交给预览器，里面可以 ← → 切（通用预览器，第三轮验收）。
  const viewerItems = [
    ...(value.atts || []).map((a) => ({ src: fileUrl(a.fileId), alt: a.label || "图片" })),
    ...pending.map((p) => ({ src: p.url, alt: p.file.name })),
  ];
  // 批次 011：优先开独立图片窗 —— 编辑弹窗不被遮住，看着图还能继续填；
  // 没有桥（网页预览/测试）退回窗口内 overlay。
  const openImg = (src: string, alt: string) => {
    if (!openInViewerWindow(viewerItems, src)) setViewer({ src, alt });
  };
  const bad = validateReminder(value);
  // 结束日期那一行单独再算一次，错误就贴在它旁边（而不是只在底部）。
  const endBad = repeating ? repeatEndError(value) : "";

  /** 切重复规则：从不重复切到重复时结束日期保持「永不」；已经有结束日期的重新按新规则给默认。 */
  const setRule = (rule: RepeatRule) => {
    const patch: Partial<Reminder> = { repeatRule: rule };
    if (rule === "none") patch.repeatEndMs = null;
    else if (value.repeatEndMs !== null) patch.repeatEndMs = defaultRepeatEnd(rule, value.customFreq, value.customN, value.atMs);
    set(patch);
  };

  /** 收下一批图（拖入或选择）。只认 image/*；超过上限收前几张并说明 ——
   *  静默丢弃会让「我明明拖了 5 张」变成一个查不出的谜。 */
  const takeFiles = (files: FileList | File[]) => {
    const imgs = [...files].filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) { showToast("只收图片", { tone: "warn" }); return; }
    const room = MAX_ATTS - attCount;
    const use = imgs.slice(0, Math.max(0, room));
    if (imgs.length > room) showToast(`最多 ${MAX_ATTS} 张，多出来的没收`, { tone: "warn" });
    if (!use.length) return;
    setPending((p) => [...p, ...use.map((f) => ({ key: crypto.randomUUID(), file: f, url: URL.createObjectURL(f) }))]);
  };

  const dropPending = (key: string) => {
    setPending((p) => {
      const hit = p.find((x) => x.key === key);
      if (hit) URL.revokeObjectURL(hit.url);
      return p.filter((x) => x.key !== key);
    });
  };

  /** 摘掉一张已保存的图。真正的删除发生在保存那一刻（服务端按 atts 的差集清文件），
   *  所以这里过确认但不动网络；取消保存就什么都没发生。 */
  const dropSaved = async (a: ReminderAtt) => {
    const ok = await askConfirm({
      title: "移除这张附件？",
      message: "保存后这张图会从这条提醒上摘掉，服务端的文件也一起清。",
      confirmText: "移除",
      danger: true,
    });
    if (!ok) return;
    set({ atts: (value.atts || []).filter((x) => x.fileId !== a.fileId) });
  };

  /** 保存：先把攒着的图逐张传上去，全部成功才落提醒。哪张失败点名哪张 ——
   *  批量吞掉失败的话用户只会看到「怎么少了一张」。 */
  const save = async () => {
    if (bad) { onFail(bad); return; }
    let atts = value.atts || [];
    if (pending.length) {
      setUploading(true);
      try {
        for (const p of pending) {
          const up = await uploadFile(p.file);
          if (!up) {
            // 前面已经传上的先记进草稿：再点一次「保存」只补传剩下的，不会把同一张传两遍留孤儿文件。
            onChange({ ...value, atts });
            onFail(`附件「${p.file.name}」没传上（服务端没响应或没鉴权）`);
            return;
          }
          // 标签存**来源**不存文件名（批次 007 答复，tokens.attachment）：72 宽的标签条里
          // 文件名截成「IMG_2026…」没有信息量。PC 的来源只有文件一种；文件名留给预览器标题。
          atts = [...atts, { fileId: up.file_id, label: "文件图片" }];
          dropPending(p.key);
        }
      } finally {
        setUploading(false);
      }
    }
    onSave({ ...value, atts });
  };

  return (
    <Modal
      width={560}
      title={creating ? "新建提醒" : "编辑提醒"}
      onClose={onClose}
      footer={
        <>
          {/* 底栏左侧常驻一句校验结果：不合法时说清是哪一项，合法时空着。
              保存键跟着它禁用 —— 看起来禁用的按钮必须真的禁用。 */}
          <span className="flex-1 min-w-0 truncate text-[11.5px] text-danger">{bad && value.text.trim() ? bad : ""}</span>
          <button className={btnGhost} onClick={onClose}>取消</button>
          <button className={btnPrimary} disabled={!!bad || uploading} onClick={() => void save()}>
            {uploading ? "上传附件中…" : "保存"}
          </button>
        </>
      }
    >
      {/* 保存失败的横幅贴在弹窗顶边（稿 296-298）。三段式：
          发生了什么（没存上）→ 为什么（具体错误）→ 现在能做什么（再存一次）。
          留在这儿不自动消失 —— 窗还开着、内容还在，用户随时可以再点一次。 */}
      {saveErr ? (
        <ErrorCard
          variant="banner"
          title="没存上，内容都还留着"
          reason={`${saveErr}。改好或联网之后再点一次保存就行。`}
          actions={[{ label: "再存一次", kind: "primary", onClick: () => { onRetry(); void save(); } }]}
        />
      ) : null}
      <div className="flex flex-col gap-[10px]">
        <Row label="内容" top>
          <AutoTextarea
            value={value.text}
            max={TEXT_MAX}
            placeholder="要提醒你做什么"
            minRows={2}
            onChange={(v) => set({ text: v })}
          />
        </Row>
        <Row label="时间">
          {/* 自绘日期+时间字段（批次 007 稿）：业务上是同一个瞬间，合并成一个字段，
              浮层左日历右时间列、点「完成」一次落两段 —— 不会再出现「日期选了、时间 --:--」的半拉值。 */}
          <DateTimeField
            kind="datetime"
            className="flex-1 min-w-0"
            date={toDateInput(value.atMs)}
            time={toTimeInput(value.atMs)}
            onCommit={({ date, time }) => { const ms = combineDateTime(date, time); if (ms) set({ atMs: ms }); }}
          />
          <span className="flex-none whitespace-nowrap text-[11.5px] text-faint">{timeLabel(value.atMs)}</span>
        </Row>
        <Row label="重复">
          <select
            className={selectCls()}
            value={value.repeatRule}
            onChange={(e) => setRule(e.target.value as RepeatRule)}
          >
            {(Object.keys(RULE_LABELS) as RepeatRule[]).map((k) => (
              <option key={k} value={k}>{RULE_LABELS[k]}</option>
            ))}
          </select>
          {value.repeatRule === "custom" ? (
            <>
              <span className="text-[12.5px] text-muted flex-none whitespace-nowrap">每</span>
              <input
                className={`${fieldCard} w-[64px] flex-none`}
                type="number"
                min={1}
                value={value.customN}
                onChange={(e) => set({ customN: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
              />
              <select
                className={selectCls()}
                value={value.customFreq}
                onChange={(e) => set({ customFreq: e.target.value as CustomFreq })}
              >
                {(Object.keys(FREQ_LABELS) as CustomFreq[]).map((k) => (
                  <option key={k} value={k}>{FREQ_LABELS[k]}</option>
                ))}
              </select>
            </>
          ) : null}
        </Row>
        {repeating ? (
          <Row label="结束重复">
            {/* 「永不 / 到某天」二选一。选「到某天」当场给一个按规则算的默认日期（reminderKit.defaultRepeatEnd），
                所以永远不会出现空着的日期框；日期框只收合法日期，清空或乱填都保留上一个值。 */}
            <Segmented<"never" | "date">
              value={value.repeatEndMs === null ? "never" : "date"}
              options={[{ v: "never", label: "永不", tone: "neutral" }, { v: "date", label: "到某天", tone: "neutral" }]}
              onChange={(v) => set({
                repeatEndMs: v === "never" ? null
                  : defaultRepeatEnd(value.repeatRule, value.customFreq, value.customN, value.atMs),
              })}
            />
            {value.repeatEndMs !== null ? (
              <>
                <DateTimeField
                  kind="date"
                  className="w-[150px] flex-none"
                  invalid={!!endBad}
                  date={toDateInput(value.repeatEndMs)}
                  onCommit={({ date }) => { const ms = fromDateInput(date); if (ms) set({ repeatEndMs: endOfDay(ms) }); }}
                />
                <span className={`flex-1 min-w-0 truncate text-[11.5px] ${endBad ? "text-danger" : "text-faint"}`}>
                  {endBad || "含当天"}
                </span>
              </>
            ) : null}
          </Row>
        ) : null}
        <Row label="提前提醒">
          <select
            className={selectCls()}
            value={String(value.aheadMinutes)}
            onChange={(e) => set({ aheadMinutes: Number(e.target.value) || 0 })}
          >
            {AHEAD_OPTIONS.map((o) => (
              <option key={o.minutes} value={o.minutes}>{o.label}</option>
            ))}
          </select>
        </Row>
        <Row label="备注" top>
          <AutoTextarea
            value={value.note}
            max={NOTE_MAX}
            placeholder="可留空"
            minRows={2}
            onChange={(v) => set({ note: v })}
          />
        </Row>
        <Row label="附件" top>
          {/* 与记账同一形态：72 缩略 + 底部标签条 + 右上 ×，「加图」是虚线框，满了就收起。
              一期只收图片。新建时先攒本地，点保存才上传；编辑时摘图也要到保存才生效。 */}
          <div className="flex-1 min-w-0"
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); takeFiles(e.dataTransfer.files); }}>
            <div className="flex flex-wrap gap-[8px]">
              {(value.atts || []).map((a) => (
                <Thumb key={a.fileId} src={fileUrl(a.fileId)} label={a.label || "图片"}
                  onOpen={() => openImg(fileUrl(a.fileId), a.label || "图片")}
                  onRemove={() => void dropSaved(a)} />
              ))}
              {pending.map((p) => (
                // 标签条写来源（文件图片），文件名只进预览器标题（批次 007 答复）。
                <Thumb key={p.key} src={p.url} label="文件图片" pending
                  onOpen={() => openImg(p.url, p.file.name)}
                  onRemove={() => dropPending(p.key)} />
              ))}
              {attCount < MAX_ATTS ? (
                <button onClick={() => fileRef.current?.click()}
                  className="flex-none w-[72px] h-[72px] rounded-[9px] border border-dashed border-border bg-transparent text-muted cursor-pointer flex flex-col items-center justify-center gap-[4px] hover:border-orange hover:text-orange-text">
                  <IconImage size={18} />
                  <span className="text-[11px] font-semibold whitespace-nowrap">加图</span>
                </button>
              ) : null}
            </div>
            <div className="mt-[6px] text-[11px] text-faint leading-[1.65]">
              {attCount} / {MAX_ATTS} · 只收图片，拖进来也行{creating ? "，点保存才上传" : ""}
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
              onChange={(e) => { if (e.target.files) takeFiles(e.target.files); e.target.value = ""; }} />
          </div>
        </Row>
      </div>
      {/* 独立图片窗开不了时的回落形态（overlay）。 */}
      <ImageViewer src={viewer?.src || null} alt={viewer?.alt} onClose={() => setViewer(null)}
        items={viewerItems} />
    </Modal>
  );
}

// 一张缩略图：点开大图；右上 × 摘掉。pending 的（还没传）标签条带「待上传」。
function Thumb({ src, label, pending, onOpen, onRemove }: {
  src: string; label: string; pending?: boolean; onOpen: () => void; onRemove: () => void;
}) {
  return (
    <div className="relative flex-none w-[72px] h-[72px] rounded-[9px] border border-border bg-chip overflow-hidden">
      <button className="w-full h-full bg-transparent cursor-zoom-in p-0 block" title={label} onClick={onOpen}>
        <img src={src} alt={label} className="w-full h-full object-cover block" />
      </button>
      <div className="absolute left-0 right-0 bottom-0 px-[5px] py-[2px] bg-[rgba(11,10,9,.62)] text-white text-[10px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis pointer-events-none">
        {pending ? `待上传 · ${label}` : label}
      </div>
      <button
        className="absolute top-[3px] right-[3px] w-[19px] h-[19px] rounded-full bg-[rgba(11,10,9,.6)] text-white cursor-pointer flex items-center justify-center"
        title="移除" onClick={onRemove}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}

// 会跟着内容长高的多行框：最少 minRows 行、最多约 8 行，再多就滚；右下角还能手动拉。
// 字数快到上限（≥ 80%）时才显示计数 —— 常态下那个数字只是噪音。
// 计数在**框下右对齐**（批次 007 答复定稿，tokens.charCounter）：框内右下会和滚动条、
// 光标、滚到底的最后一行文字打架，框外一行不与内容争位，两端也就同一个位置。
function AutoTextarea({ value, max, placeholder, minRows, onChange }: {
  value: string; max: number; placeholder: string; minRows: number; onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 8 * 20 + 14)}px`;
  }, [value]);
  const near = value.length >= max * 0.8;
  return (
    <div className="flex-1 min-w-0">
      <textarea
        ref={ref}
        rows={minRows}
        maxLength={max}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.slice(0, max))}
        className={`${textareaCard} w-full`}
        style={{ minHeight: minRows * 20 + 14 }}
      />
      {near ? (
        <div className={`mt-[2px] text-right text-[11.5px] ${value.length >= max ? "text-danger" : "text-faint"}`}
          style={{ fontVariantNumeric: "tabular-nums" }}>
          {value.length} / {max}
        </div>
      ) : null}
    </div>
  );
}

// 弹窗里的一行：左侧定宽标签 + 右侧控件（与设置页的表单行同一形状）。
// top：多行控件（textarea / 附件区）标签要贴顶，不然标签浮在中间像掉了一行。
function Row({ label, top, children }: { label: string; top?: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex ${top ? "items-start" : "items-center"} gap-[10px]`}>
      <div className={`w-[76px] flex-none whitespace-nowrap text-[12.5px] text-muted ${top ? "pt-[7px]" : ""}`}>{label}</div>
      {children}
    </div>
  );
}
