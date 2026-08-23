// 提醒页：列表 + 新建/编辑弹窗。
//
// 数据全在主进程（core/notify），这里只做展示与派发 —— 到点触发、同步、角标都不归渲染层管，
// 因为托盘常驻时主窗口可能根本没开着，逻辑放这里会整个失效。
//
// 与 iOS 保持一致的地方：分组口径（过期排最前）、重复规则的六个选项、
// 提前提醒的五个档位、「再等 10 分钟」。两端选项不一样会让人以为数据丢了。
import { useCallback, useEffect, useMemo, useState } from "react";

import { ConfirmDialog, ErrorCard, Modal, Pill, RefreshButton, btnGhost, btnPrimary, inputFlex, selectBox } from "../../components/ui";
import { showToast } from "../../components/overlay";
import {
  AHEAD_OPTIONS, FREQ_LABELS, GROUP_ORDER, RULE_LABELS,
  fromLocalInput, groupOf, hasNotify, notifyApi, timeLabel, toLocalInput,
  type CustomFreq, type NotifySyncState, type Reminder, type RepeatRule,
} from "./bridge";

// 新建时的默认提醒：默认定在一小时后的整点，比「此刻」更像用户想要的。
function blank(): Reminder {
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(0, 0, 0);
  return {
    id: `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    text: "", note: "", atMs: d.getTime(),
    repeatRule: "none", customFreq: "day", customN: 1, repeatEndMs: null,
    aheadMinutes: 0, done: false, source: "manual",
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    updatedAtMs: 0, dirty: true,
  };
}

// 「3 分钟前同步过」这类相对时间。0 表示从没成功过。
function agoLabel(ms: number): string {
  if (!ms) return "还没同步过";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "刚刚同步";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前同步`;
  return `${Math.floor(s / 3600)} 小时前同步`;
}

export function Reminders() {
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
      const g = groupOf(r);
      const arr = map.get(g) || [];
      arr.push(r);
      map.set(g, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.atMs - b.atMs);
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, rows: map.get(g) as Reminder[] }));
  }, [items]);

  if (!hasNotify) {
    // 空态要有文案，不留空白（交接说明的硬约束）。
    return (
      <div className="p-5 text-[12.5px] text-muted">
        提醒需要桌面端支持，当前环境没有注入提醒能力。
      </div>
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
    if (!r.text.trim()) return;                 // 空内容不存，与 iOS 一致
    // save() 是有返回的：{ ok, error }。之前这里整个丢掉了 —— 服务端连不上也照样关窗、
    // 照样刷新，用户以为存成功了，其实什么都没存。存不上就把窗留着，内容不丢。
    //
    // 失败提示从吐司改成了**弹窗顶边的错误横幅**（稿 296-298）。吐司几秒就没了，
    // 而这条消息要一直挂着 —— 窗还开着、内容还在、等着你再点一次保存，
    // 提示消失了用户就只剩一个「不知道为什么没关」的窗口。
    setSaveErr("");
    const r2 = await notifyApi().save({ ...r, text: r.text.trim() });
    if (!r2.ok) { setSaveErr(r2.error || "服务端没有响应"); return; }
    setEditing(null);
    await refresh();
    showToast("已保存", { tone: "ok" });
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* 顶栏：标题 + 同步状态 + 操作 */}
      <div className="flex items-center gap-[10px] px-5 py-[14px] border-b border-border-soft">
        <div className="text-[14px] font-semibold text-text flex-none whitespace-nowrap">提醒</div>
        <div className="text-[11.5px] text-muted flex-none whitespace-nowrap">
          {state && !state.configured
            ? "没配服务器地址或令牌，只在这台电脑上生效"
            : state?.lastError
              ? `同步失败：${state.lastError}`
              : agoLabel(state?.lastAt || 0)}
        </div>
        <div className="flex-1" />
        <RefreshButton onClick={doSync} spinning={syncing} title="立即同步" />
        <button className={btnPrimary} onClick={() => { setCreating(true); setSaveErr(""); setEditing(blank()); }}>新建提醒</button>
      </div>

      {/* 列表 */}
      <div id="scroll-main" className="flex-1 min-h-0 overflow-auto px-5 py-4">
        {groups.length === 0 ? (
          <div className="text-[12.5px] text-muted py-8 text-center">
            还没有提醒。点右上角新建一条，到点会用系统通知叫你，也会同步到你的手机。
          </div>
        ) : (
          groups.map(({ group, rows }) => (
            <div key={group} className="mb-4">
              <div className="text-[11.5px] text-muted mb-[6px] px-[2px]">{group}</div>
              <div className="border border-border rounded-[12px] bg-card overflow-hidden">
                {rows.map((r, i) => (
                  <div
                    key={r.id}
                    className="flex items-center gap-[10px] px-[13px] py-[10px]"
                    style={{ borderTop: i === 0 ? "none" : "1px solid var(--border-soft)" }}
                  >
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
                        await refresh();
                        // 完成态给一个 5 秒的撤销（稿要求）——「点错了一条提醒」是很常见的误操作，
                        // 而这一下是可逆的，给回退比给确认弹窗合适得多。
                        showToast(next ? "已完成" : "已标回待办", {
                          tone: "ok",
                          actionLabel: "撤销",
                          onAction: async () => { await notifyApi().setDone(r.id, !next); await refresh(); },
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
                      <div className="text-[11.5px] text-muted truncate mt-[2px]">
                        {timeLabel(r.atMs)}
                        {r.repeatRule !== "none" ? ` · ${RULE_LABELS[r.repeatRule]}` : ""}
                        {r.note ? ` · ${r.note}` : ""}
                      </div>
                    </div>
                    {group === "已过期" ? <Pill tone="danger">已逾期</Pill> : null}
                    {r.dirty ? <Pill tone="warning">待同步</Pill> : null}
                    <button
                      className={btnGhost}
                      onClick={async () => { await notifyApi().snooze(r.id, 10); await refresh(); showToast("已推迟 10 分钟", { tone: "ok" }); }}
                    >
                      再等 10 分钟
                    </button>
                    <button className={btnGhost} onClick={() => { setCreating(false); setSaveErr(""); setEditing({ ...r }); }}>编辑</button>
                    <button className={btnGhost} onClick={() => setRemoving(r)}>删除</button>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {editing ? (
        <Editor value={editing} creating={creating} saveErr={saveErr} onRetry={() => setSaveErr("")}
          onChange={setEditing} onSave={doSave} onClose={() => { setSaveErr(""); setEditing(null); }} />
      ) : null}

      {removing ? (
        <ConfirmDialog
          title={`删除「${removing.text}」？`}
          message="删除后无法恢复，其它设备上的这条也会一并删掉。"
          confirmText="删除"
          danger
          onConfirm={async () => {
            const r = await notifyApi().remove(removing.id);
            setRemoving(null);
            await refresh();
            showToast(r.ok ? "已删除" : `删除失败：${r.error || "服务端没有响应"}`, { tone: r.ok ? "ok" : "fail" });
          }}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </div>
  );
}

// 新建 / 编辑弹窗。字段与 iOS 详情页一一对应，少一个都会让两端看起来像两个功能。
function Editor({ value, creating, saveErr, onRetry, onChange, onSave, onClose }: {
  value: Reminder;
  /** 这次是新建还是编辑。**不要**改回拿 value.text 判断 —— 那会让新建时打下第一个字
   *  标题就跳成「编辑提醒」。内容有没有字和这条记录存不存在是两回事。 */
  creating: boolean;
  /** 上一次保存失败的原因；空串 = 没失败。 */
  saveErr: string;
  onRetry: () => void;
  onChange: (r: Reminder) => void;
  onSave: (r: Reminder) => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<Reminder>) => onChange({ ...value, ...patch });
  return (
    <Modal
      width={520}
      title={creating ? "新建提醒" : "编辑提醒"}
      onClose={onClose}
      footer={
        <>
          <button className={btnGhost} onClick={onClose}>取消</button>
          <button className={btnPrimary} disabled={!value.text.trim()} onClick={() => onSave(value)}>保存</button>
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
          reason={`${saveErr}。联网之后再点一次保存就行。`}
          actions={[{ label: "再存一次", kind: "primary", onClick: () => { onRetry(); onSave(value); } }]}
        />
      ) : null}
      <div className="flex flex-col gap-[10px]">
        <Row label="内容">
          <input
            className={inputFlex}
            value={value.text}
            placeholder="要提醒你做什么"
            onChange={(e) => set({ text: e.target.value })}
          />
        </Row>
        <Row label="时间">
          <input
            className={inputFlex}
            type="datetime-local"
            value={toLocalInput(value.atMs)}
            onChange={(e) => set({ atMs: fromLocalInput(e.target.value) || value.atMs })}
          />
        </Row>
        <Row label="重复">
          <select
            className={selectBox}
            value={value.repeatRule}
            onChange={(e) => set({ repeatRule: e.target.value as RepeatRule })}
          >
            {(Object.keys(RULE_LABELS) as RepeatRule[]).map((k) => (
              <option key={k} value={k}>{RULE_LABELS[k]}</option>
            ))}
          </select>
          {value.repeatRule === "custom" ? (
            <>
              <span className="text-[12.5px] text-muted flex-none whitespace-nowrap">每</span>
              <input
                className="w-[64px] flex-none border border-border bg-bg text-text rounded-[8px] px-[9px] py-[7px] text-[12.5px] outline-none"
                type="number"
                min={1}
                value={value.customN}
                onChange={(e) => set({ customN: Math.max(1, Number(e.target.value) || 1) })}
              />
              <select
                className={selectBox}
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
        {value.repeatRule !== "none" ? (
          <Row label="结束重复">
            <input
              className={inputFlex}
              type="datetime-local"
              value={value.repeatEndMs ? toLocalInput(value.repeatEndMs) : ""}
              onChange={(e) => set({ repeatEndMs: fromLocalInput(e.target.value) || null })}
            />
            <span className="text-[11.5px] text-muted flex-none whitespace-nowrap">留空 = 永不结束</span>
          </Row>
        ) : null}
        <Row label="提前提醒">
          <select
            className={selectBox}
            value={String(value.aheadMinutes)}
            onChange={(e) => set({ aheadMinutes: Number(e.target.value) || 0 })}
          >
            {AHEAD_OPTIONS.map((o) => (
              <option key={o.minutes} value={o.minutes}>{o.label}</option>
            ))}
          </select>
        </Row>
        <Row label="备注">
          <input
            className={inputFlex}
            value={value.note}
            placeholder="可留空"
            onChange={(e) => set({ note: e.target.value })}
          />
        </Row>
      </div>
    </Modal>
  );
}

// 弹窗里的一行：左侧定宽标签 + 右侧控件（与设置页的表单行同一形状）。
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-[10px]">
      <div className="w-[76px] flex-none whitespace-nowrap text-[12.5px] text-muted">{label}</div>
      {children}
    </div>
  );
}
