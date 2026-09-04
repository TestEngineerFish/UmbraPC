// 周期记账（二期）：620px 弹窗 = 规则列表 + 新建/编辑（对齐 PC 稿 865–930 / 8373–8560）。
//
// 触发在服务端（拍板 D5）：这里只管规则的增删改停 —— 到点写流水、停机补记
// 都是服务端看门狗的事，本组件没有任何「生成」逻辑。
// 稿的五条硬规则（8373 的设计说明）全部落在交互文案里：金额存规则、到点直记
// 不弹确认、月末顺延不跳过、改规则只影响以后、停止和删除分开（删除也保留流水）。
//
// 编辑器一期照稿只有 每天/每周/每月/每年 四档（every_n 是服务端备用列，
// 「每 N 个」等设计补稿再放开）。批次 004 补上收入侧：编辑器顶部「记在哪边」
// 切换，切了整组换分类列表、不混排 —— 服务端只校 direction 本身合法，
// 「分类属于该方向」这道门就由这个选择器挡（界面上不存在混配的可达状态）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  deleteMoneyRecur, pauseMoneyRecur, putMoneyRecur,
  type MoneyCat, type MoneyRecur,
} from "../../services/server";
import { Modal, btn } from "../../components/ui";
import { DateTimeField } from "../../components/DateTimePicker";
import { askConfirm, showToast } from "../../components/overlay";
import { amountToCents, yuan } from "./moneyKit";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

/** 'YYYY-MM-DD' → 「9月5日」。 */
function shortDate(s: string): string {
  const p = s.split("-");
  return p.length === 3 ? `${Number(p[1])}月${Number(p[2])}日` : s;
}

function fullDate(s: string): string {
  const p = s.split("-");
  return p.length === 3 ? `${Number(p[0])}年${Number(p[1])}月${Number(p[2])}日` : s;
}

/** 规则的周期一句话。every_n > 1 界面还建不了，但服务端存在就要显示得出。 */
function cycleText(r: MoneyRecur): string {
  const day = Number(r.first_date.slice(8, 10));
  const mo = Number(r.first_date.slice(5, 7));
  const n = r.every_n;
  if (r.cycle === "day") return `${n > 1 ? `每 ${n} 天` : "每天"} ${r.time_hhmm}`;
  if (r.cycle === "week") return `${n > 1 ? `每 ${n} 周的周` : "每周"}${WEEK[Math.min(6, Math.max(0, r.week_day))]} ${r.time_hhmm}`;
  if (r.cycle === "year") return `${n > 1 ? `每 ${n} 年` : "每年"} ${mo}月${day}日 ${r.time_hhmm}`;
  return `${n > 1 ? `每 ${n} 个月` : "每月"} ${day} 号 ${r.time_hhmm}`;
}

/** 首次~结束（**含当天**）里最后一个应记日期；一笔都没有回 null。
 *  逐行对齐稿的 lastOccur（8381）—— 服务端 money_recur.last_occur_in_range
 *  是正本，这里只为保存前的当场拦截，服务端还有一道 400 兜底。 */
function lastOccur(cyc: string, first: string, end: string, week: number): string | null {
  const [fy, fm, fd] = first.split("-").map((x) => parseInt(x, 10));
  const [ey, em, ed] = end.split("-").map((x) => parseInt(x, 10));
  const F = new Date(fy, fm - 1, fd);
  const E = new Date(ey, em - 1, ed);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (E < F) return null;
  if (cyc === "day") return iso(E);
  if (cyc === "week") {
    const target = ((week || 0) + 1) % 7; /* 0=周一 → JS getDay 的 1；周日 6 → 0 */
    const d = new Date(E);
    for (let i = 0; i < 7; i++) {
      if (d.getDay() === target) return d >= F ? iso(d) : null;
      d.setDate(d.getDate() - 1);
    }
    return null;
  }
  if (cyc === "month") {
    let y = ey, m = em;
    for (let i = 0; i < 25; i++) {
      const dim = new Date(y, m, 0).getDate();
      const c = new Date(y, m - 1, Math.min(fd, dim));
      if (c <= E && c >= F) return iso(c);
      m--; if (m === 0) { m = 12; y--; }
    }
    return null;
  }
  for (let y = ey; y >= fy; y--) {
    const dim = new Date(y, fm, 0).getDate();
    const c = new Date(y, fm - 1, Math.min(fd, dim));
    if (c <= E && c >= F) return iso(c);
  }
  return null;
}

function todayIso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Draft = {
  id: string | null;
  name: string;
  amount: string;
  merchant: string;
  dir: "expense" | "income";
  cat: string;
  cycle: "day" | "week" | "month" | "year";
  weekDay: number;
  firstDate: string;
  time: string;
  endsOnDate: boolean;
  endDate: string;
  everyN: number;
  sub: string;
};

function draftOf(r: MoneyRecur | null): Draft {
  if (!r) {
    return {
      id: null, name: "", amount: "", merchant: "", dir: "expense", cat: "housing", cycle: "month",
      weekDay: 0, firstDate: todayIso(1), time: "09:00", endsOnDate: false,
      endDate: todayIso(365), everyN: 1, sub: "",
    };
  }
  return {
    id: r.id, name: r.name, amount: (r.cents / 100).toFixed(2), merchant: r.merchant,
    dir: r.direction, cat: r.cat, cycle: r.cycle, weekDay: r.week_day, firstDate: r.first_date,
    time: r.time_hhmm, endsOnDate: r.end_kind === "date",
    endDate: r.end_date || todayIso(365), everyN: r.every_n, sub: r.sub,
  };
}

export function RecurModal({ cats, rules, initialEditId, onClose, onChanged }: {
  cats: MoneyCat[];
  rules: MoneyRecur[];
  /** 从流水的「周期」徽章跳进来时直接落在这条规则的编辑态。 */
  initialEditId?: string | null;
  onClose: () => void;
  /** 任何写操作成功后调用 —— 规则和流水都可能变，父组件负责重拉。 */
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft | null>(() => {
    const r = initialEditId ? rules.find((x) => x.id === initialEditId) : null;
    return r ? draftOf(r) : null;
  });
  const [busy, setBusy] = useState(false);

  const live = rules.filter((r) => !r.paused && r.next_at_ms > 0).length;
  // 分类跟着「记在哪边」整组换（批次 004）：数据驱动，含兜底分类 —— 记一笔的
  // 选择器就是这个口径，周期编辑器没有理由更窄。
  const dirCats = cats.filter((c) => c.direction === (draft?.dir || "expense") && c.enabled);

  const set = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  /** 切方向：分类跳到那一侧第一个（服务端顺序，收入首个是「工资」——稿的默认），
   *  sub 清掉 —— 它挂在旧分类名下，跟过去就是脏数据。 */
  const switchDir = (d: "expense" | "income") => {
    const first = cats.find((c) => c.direction === d && c.enabled);
    set({ dir: d, cat: first ? first.slug : d === "income" ? "other_in" : "other", sub: "" });
  };

  // ── 编辑态的派生值（拦截与预览都要用，稿 8438 的同一批）
  const cents = draft ? amountToCents(draft.amount) : null;
  const lastAt = draft?.endsOnDate ? lastOccur(draft.cycle, draft.firstDate, draft.endDate, draft.weekDay) : null;
  const endBad = !!draft?.endsOnDate && !lastAt;
  const endBadText = !draft ? "" : draft.endDate < draft.firstDate
    ? t("money.recEndBeforeFirst", { first: fullDate(draft.firstDate) })
    : t("money.recEndNoDay", { first: fullDate(draft.firstDate), end: fullDate(draft.endDate) });

  const preview = (() => {
    if (!draft) return "";
    const d = Number(draft.firstDate.slice(8, 10));
    const mo = Number(draft.firstDate.slice(5, 7));
    const once = !!lastAt && lastAt === draft.firstDate;
    if (draft.endsOnDate && once) return t("money.recPrevOnce", { date: fullDate(draft.firstDate), time: draft.time });
    const tail = draft.endsOnDate
      ? (lastAt ? t("money.recPrevTailEnd", { date: fullDate(lastAt), time: draft.time }) : t("money.recPrevTailNone"))
      : t("money.recPrevTailForever");
    if (draft.cycle === "day") return t("money.recPrevDay", { time: draft.time, tail });
    if (draft.cycle === "week") return t("money.recPrevWeek", { week: WEEK[draft.weekDay], time: draft.time, tail });
    if (draft.cycle === "year") return t("money.recPrevYear", { month: mo, day: d, time: draft.time, tail });
    return t("money.recPrevMonth", { month: mo, day: d, time: draft.time, tail });
  })();

  const doSave = async () => {
    if (!draft || busy) return;
    if (!draft.name.trim()) { showToast(t("money.recNeedName"), { tone: "warn" }); return; }
    if (!cents) { showToast(t("money.recNeedAmount"), { tone: "warn" }); return; }
    if (endBad) { showToast(endBadText, { tone: "warn" }); return; }
    setBusy(true);
    const r = await putMoneyRecur(draft.id || crypto.randomUUID(), {
      name: draft.name.trim(),
      cents,
      direction: draft.dir,
      cat: draft.cat,
      sub: draft.sub,           // 编辑时保住原规则的 sub —— 表单没画不等于该抹掉
      merchant: draft.merchant.trim(),
      cycle: draft.cycle,
      every_n: draft.everyN,
      week_day: draft.weekDay,
      first_date: draft.firstDate,
      time_hhmm: draft.time,
      tz_offset_min: -new Date().getTimezoneOffset(),
      end_kind: draft.endsOnDate ? "date" : "never",
      end_date: draft.endsOnDate ? draft.endDate : "",
    });
    setBusy(false);
    if (!r) { showToast(t("money.saveFailed"), { tone: "warn" }); return; }
    showToast(draft.id ? t("money.recSavedEdit") : t("money.recSavedNew"), { tone: "ok" });
    setDraft(null);
    onChanged();
  };

  const doToggle = async (r: MoneyRecur) => {
    if (busy) return;
    setBusy(true);
    const ok = await pauseMoneyRecur(r.id, !r.paused);
    setBusy(false);
    showToast(ok ? (r.paused ? t("money.recResumed") : t("money.recPaused")) : t("money.saveFailed"),
      { tone: ok ? "ok" : "warn" });
    if (ok) onChanged();
  };

  const doDelete = async (r: MoneyRecur) => {
    // 稿 8547 的删除确认原话：已生成的流水留着不动 —— 那些是真花过的钱。
    const ok = await askConfirm({
      title: t("money.recDelTitle", { name: r.name }),
      message: t("money.recDelBody", { n: r.done_count }),
      confirmText: t("money.recDelConfirm"),
      danger: true,
    });
    if (!ok) return;
    const done = await deleteMoneyRecur(r.id);
    showToast(done ? t("money.recDeleted") : t("money.saveFailed"), { tone: done ? "ok" : "warn" });
    if (done) { setDraft(null); onChanged(); }
  };

  const field = "w-full px-[10px] py-[6px] border border-border rounded-[8px] bg-bg text-text text-[12.5px] outline-none focus:border-orange";
  const pill = (on: boolean) =>
    `px-[10px] py-[3px] rounded-[7px] text-[11.5px] border cursor-pointer whitespace-nowrap flex-none ${
      on ? "border-orange bg-orange-soft text-orange-text" : "border-border bg-card text-text hover:border-orange"}`;

  // ── 列表态
  if (!draft) {
    return (
      <Modal width={680} title={t("money.recTitle")} sub={t("money.recSub", { total: rules.length, live })}
        onClose={onClose}
        footer={
          <div className="flex items-center gap-[10px] w-full">
            <span className="flex-1 text-[11px] text-faint">{t("money.recFoot")}</span>
            <button className={btn("primary")} onClick={() => setDraft(draftOf(null))}>{t("money.recAdd")}</button>
          </div>
        }>
        {rules.length === 0 ? (
          <div className="py-[26px] text-center text-[12.5px] text-faint">{t("money.recEmpty")}</div>
        ) : rules.map((r) => (
          <div key={r.id}
            className={`flex items-center gap-[11px] px-[13px] py-[11px] border border-border-soft rounded-[10px] bg-bg ${r.paused ? "opacity-60" : ""}`}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-[7px]">
                <span className="text-[13px] font-semibold text-text truncate">{r.name}</span>
                <span className="flex-none px-[7px] py-[1px] rounded-full bg-chip text-muted text-[10.5px]">
                  {cats.find((c) => c.slug === r.cat)?.name || r.cat}
                </span>
              </div>
              <div className="mt-[3px] text-[11px] text-faint truncate">
                {cycleText(r)} · {r.done_count > 0
                  ? t("money.recHistory", { n: r.done_count, last: r.last_done_ms ? shortDate(new Date(r.last_done_ms).toISOString().slice(0, 10)) : "—" })
                  : t("money.recNoHistory")}
              </div>
            </div>
            <div className="flex-none text-right">
              <div className="text-[12.5px] font-semibold font-mono text-text">¥{yuan(r.cents)}</div>
              <div className={`text-[10.5px] ${r.paused || !r.next_at_ms ? "text-faint" : "text-orange-text"}`}>
                {r.paused ? t("money.recPausedTag") : r.next_at_ms ? t("money.recNext", { date: shortDate(r.next_date) }) : t("money.recEnded")}
              </div>
            </div>
            <div className="flex-none flex items-center gap-[5px]">
              <button className={pill(false)} onClick={() => setDraft(draftOf(r))}>{t("common.edit")}</button>
              <button className={pill(false)} onClick={() => void doToggle(r)}>
                {r.paused ? t("money.recResume") : t("money.recPause")}
              </button>
              <button className={`${pill(false)} !text-danger`} onClick={() => void doDelete(r)}>{t("common.delete")}</button>
            </div>
          </div>
        ))}
      </Modal>
    );
  }

  // ── 编辑态
  const dayOfFirst = Number(draft.firstDate.slice(8, 10));
  return (
    <Modal width={560} title={draft.id ? t("money.recEditTitle") : t("money.recNewTitle")}
      onClose={() => setDraft(null)}
      footer={
        <div className="flex items-center gap-[10px] w-full">
          <span className="flex-1 text-[11px] text-faint">
            {draft.id ? t("money.recEditHint") : t("money.recNewHint")}
          </span>
          <button className={btn("ghost")} onClick={() => setDraft(null)}>{t("common.cancel")}</button>
          <button className={btn("primary")} onClick={() => void doSave()}
            style={cents && draft.name.trim() && !endBad ? undefined : { opacity: 0.5 }}>
            {draft.id ? t("money.recSaveEdit") : t("money.recSaveNew")}
          </button>
        </div>
      }>
      {/* 记在哪边（批次 004）：形态对齐记一笔的方向切换，选中胶囊同分类/周期一套 */}
      <div>
        <div className="text-[11px] font-semibold text-faint mb-[5px]">{t("money.recDir")}</div>
        <div className="flex gap-[5px]">
          {([["expense", t("money.expense")], ["income", t("money.income")]] as const).map(([k, label]) => (
            <button key={k} className={pill(draft.dir === k)} onClick={() => switchDir(k)}>{label}</button>
          ))}
        </div>
        {draft.dir === "income" ? (
          <div className="mt-[5px] text-[11px] text-faint leading-[1.65]">{t("money.recDirIncomeHint")}</div>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-[10px]">
        <div>
          <div className="text-[11px] font-semibold text-faint mb-[4px]">{t("money.recName")}</div>
          <input className={field} value={draft.name} placeholder={t("money.recNamePh")}
            onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div>
          <div className="text-[11px] font-semibold text-faint mb-[4px]">{t("money.amount")}</div>
          <input className={field} value={draft.amount} placeholder="0.00" inputMode="decimal"
            onChange={(e) => set({ amount: e.target.value })} />
        </div>
      </div>
      <div>
        <div className="text-[11px] font-semibold text-faint mb-[4px]">{t("money.noteLabel")}</div>
        <input className={field} value={draft.merchant} placeholder={t("money.notePh")}
          onChange={(e) => set({ merchant: e.target.value })} />
      </div>
      <div>
        <div className="text-[11px] font-semibold text-faint mb-[5px]">{t("money.recCat")}</div>
        <div className="flex flex-wrap gap-[5px]">
          {dirCats.map((c) => (
            <button key={c.slug} className={pill(draft.cat === c.slug)} onClick={() => set({ cat: c.slug })}>
              {c.name}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="text-[11px] font-semibold text-faint mb-[5px]">{t("money.recCycle")}</div>
        <div className="flex gap-[5px]">
          {([["day", t("money.recDay")], ["week", t("money.recWeek")], ["month", t("money.recMonth")], ["year", t("money.recYear")]] as const).map(([k, label]) => (
            <button key={k} className={pill(draft.cycle === k)} onClick={() => set({ cycle: k })}>{label}</button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-[10px]">
        {/* 稿的 whenLabel 逻辑：每天 → 只问几点；每周 → 周几；每月/每年 → 从哪天开始。 */}
        {draft.cycle === "week" ? (
          <div>
            <div className="text-[11px] font-semibold text-faint mb-[4px]">{t("money.recWhichWeekday")}</div>
            <div className="flex flex-wrap gap-[4px]">
              {WEEK.map((w, i) => (
                <button key={w} className={pill(draft.weekDay === i)} onClick={() => set({ weekDay: i })}>周{w}</button>
              ))}
            </div>
          </div>
        ) : draft.cycle !== "day" ? (
          <div>
            <div className="text-[11px] font-semibold text-faint mb-[4px]">{t("money.recFirstDate")}</div>
            <DateTimeField kind="date" className="w-full" date={draft.firstDate}
              onCommit={({ date }) => set({ firstDate: date || draft.firstDate })} />
          </div>
        ) : null}
        <div>
          <div className="text-[11px] font-semibold text-faint mb-[4px]">
            {draft.cycle === "day" ? t("money.recTimeDaily") : t("money.recTime")}
          </div>
          {/* 分钟列步进 5（稿默认档）；老规则若存过非 5 倍数的分钟，当前值会按序插进列里。 */}
          <DateTimeField kind="time" className="w-full" time={draft.time} minuteStep={5}
            onCommit={({ time }) => set({ time: time || draft.time })} />
        </div>
      </div>
      {draft.cycle === "month" && dayOfFirst >= 29 ? (
        <div className="text-[11px] text-faint">{t("money.recMonthEndNote", { day: dayOfFirst })}</div>
      ) : null}
      <div className="grid grid-cols-2 gap-[10px]">
        <div>
          <div className="text-[11px] font-semibold text-faint mb-[4px]">{t("money.recEnd")}</div>
          <div className="flex gap-[5px]">
            <button className={pill(!draft.endsOnDate)} onClick={() => set({ endsOnDate: false })}>{t("money.recEndNever")}</button>
            <button className={pill(draft.endsOnDate)} onClick={() => set({ endsOnDate: true })}>{t("money.recEndOnDate")}</button>
          </div>
        </div>
        {draft.endsOnDate ? (
          <div>
            <div className="text-[11px] font-semibold text-faint mb-[4px]">{t("money.recEndDate")}</div>
            <DateTimeField kind="date" className="w-full" invalid={endBad} date={draft.endDate}
              onCommit={({ date }) => set({ endDate: date || draft.endDate })} />
          </div>
        ) : null}
      </div>
      {draft.endsOnDate ? (
        endBad
          ? <div className="text-[11px] text-danger font-semibold">{endBadText}</div>
          : <div className="text-[11px] text-faint">{t("money.recEndInclusive")}</div>
      ) : null}
      <div className="px-[11px] py-[9px] rounded-[8px] bg-chip text-[11.5px] text-muted">{preview}</div>
      {draft.id ? (
        <button className="self-start text-[11.5px] text-danger cursor-pointer bg-transparent border-none p-0"
          onClick={() => { const r = rules.find((x) => x.id === draft.id); if (r) void doDelete(r); }}>
          {t("money.recDelLink")}
        </button>
      ) : null}
    </Modal>
  );
}
