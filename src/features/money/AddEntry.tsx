// 记一笔 / 编辑这一笔（520px 弹窗，对齐稿 1013–1108）。
//
// 金额框直接吃算式（258/3），求值在 moneyKit.ts 的 amountToCents，闸门也在那边。
// （moneyKit 原名 money.ts —— 和 Money.tsx 只差大小写，Mac 的文件系统不分大小写，
// rollup 会把 `./Money` 解析到 money.ts 头上直接构建失败。同目录里**不要**再建
// 与组件文件同名仅大小写不同的文件。）
// 保存 = PUT /money/entries/{id}，id 客户端生成 —— 编辑与新建走同一条路，
// 服务端按 updated_at_ms 逐条 last-write-wins。
//
// 与稿的一处刻意偏离：稿的小键盘把 12 个数字键和 4 个运算符**顺排进同一个
// 4 列网格**，出来的布局是「7 8 9 4 / 5 6 1 2 / …」—— 4 挨着 9，肌肉记忆全废。
// 这里按标准计算器排：左边 3 列数字（789/456/123/0.⌫），右边一列运算符。
// 已记进回流台账（实现侧偏离，要稿知道）。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { saveMoneyEntry, type MoneyCat, type MoneyEntry } from "../../services/server";
import { Modal, ErrorCard, btn } from "../../components/ui";
import { amountToCents, catIcon, catColor, isExpr, SUBS, tzOffsetMin, yuan } from "./moneyKit";

const BTN_GHOST = btn("ghost");
const BTN_PRIMARY = btn("primary");

/** 数字键与运算符：标准计算器布局（数字 3 列 + 运算符 1 列）。 */
const KEY_ROWS: string[][] = [
  ["7", "8", "9", "+"],
  ["4", "5", "6", "-"],
  ["1", "2", "3", "×"],
  ["0", ".", "⌫", "÷"],
];

/** at_ms → 「今天 14:32」/「8月19日 14:32」。 */
function useFmtAt() {
  const { t } = useTranslation();
  return (ms: number) => {
    const d = new Date(ms);
    const now = new Date();
    const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return t("time.todayAt", { time: hm });
    return t("time.monthDayAt", { month: d.getMonth() + 1, day: d.getDate(), time: hm });
  };
}

/** Date → datetime-local 的取值（本地时区，分钟精度）。 */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function AddEntry({ cats, entries, initial, onClose, onSaved }: {
  cats: MoneyCat[];
  /** 本月流水，只用来算「最近用过」的分类。 */
  entries: MoneyEntry[];
  /** 传了就是编辑：id / 来源 / 导入批次这些身份字段原样保留，只改内容。 */
  initial: MoneyEntry | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const fmtAt = useFmtAt();
  const [amount, setAmount] = useState(initial ? (initial.cents / 100).toFixed(2) : "");
  const [dir, setDir] = useState<"expense" | "income">(initial?.direction || "expense");
  const [cat, setCat] = useState(initial?.cat || "food");
  const [sub, setSub] = useState(initial?.sub || "");
  const [note, setNote] = useState(initial?.merchant || "");
  const [atMs, setAtMs] = useState(initial?.at_ms || Date.now());
  const [timeOpen, setTimeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => { amountRef.current?.focus(); }, []);

  const cents = amountToCents(amount);
  const expr = isExpr(amount);
  const dirCats = cats.filter((c) => c.direction === dir && c.enabled);
  // 最近用过：本月流水里同方向、按时间新→旧去重后的前三个分类。
  // 没记过账时整行不出现 —— 空荡荡的「最近用过」只是在提醒用户他没用过。
  const recent: string[] = [];
  for (const e of entries) {
    if (e.direction !== dir || recent.includes(e.cat)) continue;
    if (!dirCats.some((c) => c.slug === e.cat)) continue;
    recent.push(e.cat);
    if (recent.length >= 3) break;
  }
  const subs = SUBS[cat] || [];

  /** 切方向要把分类切到那一侧的第一个 —— 支出选着「餐饮」切到收入，
   *  分类栏里根本没有这一项，保存会写出一条方向和分类打架的流水。 */
  const switchDir = (d: "expense" | "income") => {
    setDir(d);
    const first = cats.find((c) => c.direction === d && c.enabled);
    setCat(first ? first.slug : d === "income" ? "other_in" : "other");
    setSub("");
  };

  const press = (k: string) => {
    if (k === "⌫") setAmount((a) => a.slice(0, -1));
    else setAmount((a) => a + k);
    amountRef.current?.focus();
  };

  const doSave = async (andNext: boolean) => {
    if (!cents || busy) return;
    setBusy(true);
    setFailed(false);
    const r = await saveMoneyEntry({
      id: initial?.id || crypto.randomUUID(),
      cents,
      direction: dir,
      cat,
      sub,
      merchant: note.trim(),
      at_ms: atMs,
      tz_offset_min: tzOffsetMin(),
      src: initial?.src || "manual",
      rule_id: initial?.rule_id || "",
      batch_id: initial?.batch_id || "",
      order_no: initial?.order_no || "",
      updated_at_ms: Date.now(),
    });
    setBusy(false);
    if (!r) { setFailed(true); return; }   // 稿：内容都还在，联网后再点一次保存
    onSaved();
    if (andNext) {
      // 保存并继续：清金额和备注，方向/分类/时间留着 —— 连着记几笔外卖时
      // 这三样十有八九不变，清掉反而每笔都要重选。
      setAmount("");
      setNote("");
      setSub("");
      setFailed(false);
      amountRef.current?.focus();
    } else {
      onClose();
    }
  };

  const pillCls = (on: boolean) =>
    `flex-none whitespace-nowrap px-[11px] py-[4px] rounded-full text-[11.5px] cursor-pointer border ${
      on ? "border-orange bg-orange-soft text-orange-text" : "border-border bg-transparent text-muted hover:border-orange"}`;

  return (
    <Modal width={520} title={initial ? t("money.editTitle") : t("money.addTitle")} onClose={onClose}
      footer={<>
        <span className="flex-1 min-w-0 text-[11px] text-faint">{t("money.addFootHint")}</span>
        <button className={BTN_GHOST} onClick={onClose}>{t("common.cancel")}</button>
        <button className={BTN_GHOST} disabled={!cents || busy} onClick={() => void doSave(true)}>{t("money.saveNext")}</button>
        <button className={BTN_PRIMARY} disabled={!cents || busy} onClick={() => void doSave(false)}>{t("money.save")}</button>
      </>}>

      {failed ? (
        <ErrorCard variant="strip" title={t("money.saveFailed")}
          actions={[{ label: t("common.retry"), onClick: () => void doSave(false) }]} />
      ) : null}

      {/* 金额 + 小键盘 */}
      <div className="flex gap-[14px] items-start">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-semibold tracking-[.06em] text-faint mb-[5px]">{t("money.amount")}</div>
          <input ref={amountRef} value={amount} onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void doSave(false); }}
            placeholder={t("money.amountPh")}
            className="w-full px-[12px] py-[9px] border border-border rounded-[9px] bg-bg text-text text-[22px] font-semibold font-mono outline-none focus:border-orange" />
          <div className="flex items-center gap-[8px] mt-[5px] min-h-[16px]">
            {expr && cents ? (
              <span className="flex-none text-[12px] text-orange-text font-mono">= ¥{yuan(cents)}</span>
            ) : null}
            {expr && !cents && amount.trim() ? (
              <span className="flex-none text-[11.5px] text-danger">{t("money.exprBad")}</span>
            ) : null}
          </div>
        </div>
        <div className="flex-none w-[196px]">
          <div className="text-[11px] font-semibold tracking-[.06em] text-faint mb-[5px]">{t("money.keypad")}</div>
          <div className="grid grid-cols-4 gap-[5px]">
            {KEY_ROWS.flat().map((k) => (
              <button key={k} onClick={() => press(k)}
                className={`h-[34px] border border-border rounded-[8px] text-[14px] font-mono cursor-pointer hover:border-orange hover:text-orange-text ${
                  "+-×÷".includes(k) ? "bg-rail text-muted" : "bg-card text-text"}`}>
                {k}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 方向 + 时间 */}
      <div className="flex items-center gap-[12px] flex-wrap">
        <span className="flex-none text-[11px] font-semibold tracking-[.06em] text-faint">{t("money.direction")}</span>
        <div className="flex-none flex border border-border rounded-[8px] overflow-hidden">
          <button onClick={() => switchDir("expense")}
            className={`flex-none whitespace-nowrap px-[15px] py-[5px] text-[12.5px] cursor-pointer border-r border-border ${
              dir === "expense" ? "bg-orange text-white font-semibold" : "bg-transparent text-text"}`}>
            {t("money.expense")}
          </button>
          {/* 收入选中态用绿 —— 稿就是这么定的：方向是少数用颜色分正负语义的地方 */}
          <button onClick={() => switchDir("income")}
            className={`flex-none whitespace-nowrap px-[15px] py-[5px] text-[12.5px] cursor-pointer ${
              dir === "income" ? "bg-success text-white font-semibold" : "bg-transparent text-text"}`}>
            {t("money.income")}
          </button>
        </div>
        <span className="flex-1" />
        <span className="flex-none text-[11px] font-semibold tracking-[.06em] text-faint">{t("money.time")}</span>
        {timeOpen ? (
          <input type="datetime-local" value={toLocalInput(atMs)} autoFocus
            onChange={(e) => { const v = new Date(e.target.value).getTime(); if (!isNaN(v)) setAtMs(v); }}
            onBlur={() => setTimeOpen(false)}
            className="flex-none px-[9px] py-[4px] border border-border rounded-[8px] bg-card text-text text-[12px] outline-none focus:border-orange" />
        ) : (
          <button onClick={() => setTimeOpen(true)}
            className="flex-none whitespace-nowrap px-[11px] py-[4px] border border-border rounded-[8px] bg-transparent text-text text-[12px] cursor-pointer hover:border-orange hover:text-orange-text">
            {fmtAt(atMs)}
          </button>
        )}
      </div>

      {/* 分类 */}
      <div>
        {recent.length ? (
          <div className="flex items-center gap-[8px] mb-[7px] flex-wrap">
            <span className="flex-none text-[11px] font-semibold tracking-[.06em] text-faint">{t("money.recentCats")}</span>
            {recent.map((slug) => {
              const c = dirCats.find((x) => x.slug === slug);
              if (!c) return null;
              return (
                <button key={slug} onClick={() => { setCat(slug); setSub(""); }}
                  className={`${pillCls(cat === slug)} flex items-center gap-[6px]`}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={catIcon(slug)} /></svg>
                  {c.name}
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="grid grid-cols-5 gap-[6px]">
          {dirCats.map((c) => {
            const on = cat === c.slug;
            return (
              <button key={c.slug} onClick={() => { setCat(c.slug); setSub(""); }}
                className={`flex flex-col items-center justify-center gap-[5px] h-[62px] rounded-[10px] text-[11.5px] cursor-pointer border ${
                  on ? "border-orange bg-orange-soft text-orange-text" : "border-border bg-card text-text hover:border-orange"}`}>
                <span className="flex" style={{ color: on ? "var(--orange-text)" : catColor(c.slot) }}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={catIcon(c.slug)} /></svg>
                </span>
                <span className="whitespace-nowrap">{c.name}</span>
              </button>
            );
          })}
        </div>
        {subs.length ? (
          <div className="flex flex-wrap gap-[5px] mt-[8px] pt-[8px] border-t border-border-soft">
            <span className="flex-none self-center whitespace-nowrap text-[11px] text-faint">{t("money.subLabel")}</span>
            {subs.map((s) => (
              <button key={s} onClick={() => setSub(sub === s ? "" : s)} className={pillCls(sub === s)}>{s}</button>
            ))}
          </div>
        ) : null}
      </div>

      {/* 备注（= 服务端的 merchant，拍板 D1：商家和备注一个字段） */}
      <div>
        <div className="text-[11px] font-semibold tracking-[.06em] text-faint mb-[5px]">{t("money.noteLabel")}</div>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("money.notePh")}
          className="w-full px-[11px] py-[7px] border border-border rounded-[8px] bg-bg text-text text-[12.5px] outline-none focus:border-orange" />
      </div>
    </Modal>
  );
}
