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
import {
  addMoneyAtt, deleteMoneyAtt, fileUrl, saveMoneyEntry, uploadFile,
  type MoneyAtt, type MoneyCat, type MoneyEntry,
} from "../../services/server";
import { Modal, ErrorCard, btn } from "../../components/ui";
import { askConfirm, showToast } from "../../components/overlay";
import { DateTimeField } from "../../components/DateTimePicker";
import { ImageViewer, openInViewerWindow } from "../../components/ImageViewer";
// 日期换算（ms ↔ 'YYYY-MM-DD'/'HH:mm'）的唯一出处在 notify/reminderKit（纯函数层，带 vitest），
// 跨功能引用刻意为之 —— 再抄一份就会两处漂移。
import { combineDateTime, toDateInput, toTimeInput } from "../notify/reminderKit";
import { amountToCents, catIcon, catColor, isExpr, tzOffsetMin, yuan } from "./moneyKit";
import type { MoneyDraft } from "./Money";

const BTN_GHOST = btn("ghost");
const BTN_PRIMARY = btn("primary");

/** 数字键与运算符：标准计算器布局（数字 3 列 + 运算符 1 列）。 */
const KEY_ROWS: string[][] = [
  ["7", "8", "9", "+"],
  ["4", "5", "6", "-"],
  ["1", "2", "3", "×"],
  ["0", ".", "⌫", "÷"],
];


export function AddEntry({ cats, entries, initial, draft, onClose, onSaved }: {
  cats: MoneyCat[];
  /** 本月流水，只用来算「最近用过」的分类。 */
  entries: MoneyEntry[];
  /** 传了就是编辑：id / 来源 / 导入批次这些身份字段原样保留，只改内容。 */
  initial: MoneyEntry | null;
  /** 新建时的预填草稿（批次 013：识图确认卡「改成手动填」/ 识不出「手动填一笔」带过来）。
   *  draft.atts 是已上传好的原图 file_id，保存成功后挂到这笔账上。initial 有值时忽略。 */
  draft?: MoneyDraft | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  // 草稿只在新建时起作用（编辑一笔已有的账，身份字段和内容都以 initial 为准）。
  // 缺的字段走默认：方向默认支出；分类沿用手记的默认「餐饮」，收入方向取该方向第一个可用分类
  // （弹窗随草稿在分类表到位前就开了，取不到就落「其他」，和 switchDir 同一兜底）；时间默认现在。
  const d = initial ? null : draft || null;
  const [amount, setAmount] = useState(initial ? (initial.cents / 100).toFixed(2) : d?.cents ? (d.cents / 100).toFixed(2) : "");
  const [dir, setDir] = useState<"expense" | "income">(initial?.direction || d?.direction || "expense");
  const [cat, setCat] = useState(initial?.cat || d?.cat || (
    d?.direction === "income" ? (cats.find((c) => c.direction === "income" && c.enabled)?.slug || "other_in") : "food"));
  const [sub, setSub] = useState(initial?.sub || d?.sub || "");
  const [note, setNote] = useState(initial?.merchant || d?.merchant || "");
  const [atMs, setAtMs] = useState(initial?.at_ms || d?.at_ms || Date.now());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /** 附件本地态：initial 是快照，删掉一张后要立刻从界面消失。 */
  const [atts, setAtts] = useState<MoneyAtt[]>(initial?.atts || []);
  /** 草稿带来的图（批次 013）：已经在服务端了（聊天里传的原图），但账还没落库、没地方挂 ——
   *  先在附件区预览出来，保存成功后逐张 addMoneyAtt 挂上。挂过一次就清空，「保存并继续」的下一笔不再带。 */
  const [draftAtts, setDraftAtts] = useState<{ file_id: string; label: string }[]>(d?.atts || []);
  /** 新建这一笔时先攒在本地的图（账还没落库，服务端没地方挂）——
   *  保存成功后逐张上传挂接。url 是 ObjectURL，撤下时要 revoke，不然内存一直占着。 */
  const [pending, setPending] = useState<{ key: string; file: File; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 图片预览：通用 ImageViewer，已挂接的 + 待上传的合成一组，预览器里可以左右切。
  const [viewer, setViewer] = useState<string | null>(null);
  const viewerItems = [
    ...atts.map((a) => ({ src: fileUrl(a.file_id), alt: a.origin ? t("money.attOrigin") : a.label })),
    ...draftAtts.map((a) => ({ src: fileUrl(a.file_id), alt: a.label })),
    ...pending.map((p) => ({ src: p.url, alt: p.file.name })),
  ];
  // 批次 011：优先开独立图片窗 —— 记账弹窗不被遮住，对着凭证还能继续填数；
  // 没有桥（网页预览/测试）退回窗口内 overlay。
  const openImg = (src: string) => { if (!openInViewerWindow(viewerItems, src)) setViewer(src); };

  useEffect(() => { amountRef.current?.focus(); }, []);

  // 草稿里的分类要等分类表到位才核得了（弹窗随草稿在 Money 页挂载那一刻就开，cats 还是空的）：
  // 识图猜的 slug 不在该方向的可用分类里（猜错方向 / 分类已停用 / 服务端换过名）就退回该方向
  // 第一个可用分类 —— 不核的话格子里没有选中项，保存却会写出一条方向和分类打架的流水。
  // 只核这一次；之后用户自己选的不动。编辑态（initial）不核：历史流水指向停用分类是合法的。
  const draftCatChecked = useRef(!d);
  useEffect(() => {
    if (draftCatChecked.current || !cats.length) return;
    draftCatChecked.current = true;
    if (cats.some((c) => c.slug === cat && c.direction === dir && c.enabled)) return;
    const first = cats.find((c) => c.direction === dir && c.enabled);
    if (first) { setCat(first.slug); setSub(""); }
  }, [cats, cat, dir]);

  // ── 附件（批次 004 正式形态：一笔最多 4 张，拖进来或点「加图」）─────────────
  // 草稿带来的图也占名额：保存后它们就是这笔账的附件。
  const attCount = atts.length + draftAtts.length + pending.length;
  const attRoom = attCount < 4;

  /** 编辑态：立刻上传 + 挂接（账已存在）。逐张来，哪张失败点名哪张 ——
   *  批量吞掉失败的话用户只会看到「怎么少了一张」。 */
  const uploadTo = async (entryId: string, files: File[]) => {
    setUploading(true);
    let latest: MoneyAtt[] | null = null;
    for (const f of files) {
      const up = await uploadFile(f);
      // 标签存来源不存文件名（批次 007 答复，tokens.attachment；存量老标签照旧显示）。
      const added = up ? await addMoneyAtt(entryId, up.file_id, "文件图片") : null;
      if (!added) { showToast(t("money.attUploadFailed", { name: f.name }), { tone: "warn" }); continue; }
      latest = added;   // 服务端回全量列表，直接对齐，不自己 push
    }
    setUploading(false);
    if (latest) setAtts(latest);
  };

  /** 收下一批图（拖入或选择）。只认 image/*；超过 4 张收前几张并说明 ——
   *  静默丢弃会让「我明明拖了 5 张」变成一个查不出的谜。 */
  const takeFiles = (files: FileList | File[]) => {
    const imgs = [...files].filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    const room = 4 - attCount;
    const use = imgs.slice(0, Math.max(0, room));
    if (imgs.length > room) showToast(t("money.attFull"), { tone: "warn" });
    if (!use.length) return;
    if (initial) {
      void uploadTo(initial.id, use);
    } else {
      setPending((p) => [...p, ...use.map((f) => ({ key: crypto.randomUUID(), file: f, url: URL.createObjectURL(f) }))]);
    }
  };

  const dropPending = (key: string) => {
    setPending((p) => {
      const hit = p.find((x) => x.key === key);
      if (hit) URL.revokeObjectURL(hit.url);
      return p.filter((x) => x.key !== key);
    });
  };

  const cents = amountToCents(amount);
  const expr = isExpr(amount);
  const dirCats = cats.filter((c) => c.direction === dir && c.enabled);
  // 最近用过（批次 003 定稿）：本月流水里同方向、按时间新→旧去重取 3 个；
  // 该方向还没记过时用分类表前几个兜底 —— 行为稳定，切方向不再时有时无。
  // （iOS 那条「分类总数 ≤3 整行不显示」的规则 PC 不适用：两个方向的分类都多于 3。）
  const recent: string[] = [];
  for (const e of entries) {
    if (e.direction !== dir || recent.includes(e.cat)) continue;
    if (!dirCats.some((c) => c.slug === e.cat)) continue;
    recent.push(e.cat);
    if (recent.length >= 3) break;
  }
  for (const c of dirCats) {
    if (recent.length >= 3) break;
    if (!recent.includes(c.slug)) recent.push(c.slug);
  }
  // 子类从服务端来（第二批落库，随分类下发）—— 本地硬编码的 SUBS 表已删：
  // 留着它，用户在 iOS 加的子类这里永远看不见。
  const subs = cats.find((c) => c.slug === cat)?.subs || [];

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
    const eid = initial?.id || crypto.randomUUID();
    const r = await saveMoneyEntry({
      id: eid,
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
    if (!r) { setBusy(false); setFailed(true); return; }   // 稿：内容都还在，联网后再点一次保存
    // 草稿带来的图（批次 013，聊天里已经传上服务端的原图）此刻才有地方挂：逐张 addMoneyAtt 挂到这笔账上。
    // 挂失败吐司点名那张、不阻断 —— 账已经记上了；挂过一次就清空，「保存并继续」的下一笔不再带。
    if (draftAtts.length) {
      let latest: MoneyAtt[] | null = null;
      for (const a of draftAtts) {
        // copy=true：这张是聊天消息的文件，让服务端复制一份挂上（两边各归各删）。
        const added = await addMoneyAtt(eid, a.file_id, a.label, true);
        if (!added) { showToast(t("money.attAttachFailed", { name: a.label }), { tone: "warn" }); continue; }
        latest = added;   // 服务端回全量列表，直接对齐
      }
      setDraftAtts([]);
      if (latest) setAtts(latest);
    }
    // 新建时攒下的图此刻才有地方挂：账落库了，逐张上传 + 挂接。
    // 挂失败只影响那张图（有点名吐司），账本身已经记上 —— 不因图把整次保存判失败。
    if (pending.length) {
      await uploadTo(eid, pending.map((p) => p.file));
      pending.forEach((p) => URL.revokeObjectURL(p.url));
      setPending([]);
    }
    setBusy(false);
    onSaved();
    if (andNext) {
      // 保存并继续：清金额和备注，方向/分类/时间留着 —— 连着记几笔外卖时
      // 这三样十有八九不变，清掉反而每笔都要重选。附件是上一笔的，一并清。
      setAmount("");
      setNote("");
      setSub("");
      setAtts([]);
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
    <Modal width={560} title={initial ? t("money.editTitle") : t("money.addTitle")} onClose={onClose}
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
        {/* 自绘 datetime 字段（通用组件 DateTimeField）：全站最后一个原生 datetime-local
            在这儿，2026-08-28 换装 —— 记一笔的「什么时候」也是一个瞬间、一个字段，
            与提醒/iOS 记一笔同一形态。原来的「友好文案按钮 → 原生框」两态收成一个字段。 */}
        <DateTimeField
          kind="datetime"
          className="w-[176px] flex-none"
          date={toDateInput(atMs)}
          time={toTimeInput(atMs)}
          onCommit={({ date, time }) => { const ms = combineDateTime(date, time); if (ms) setAtMs(ms); }}
        />
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
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={catIcon(slug, c.icon)} /></svg>
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
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={catIcon(c.slug, c.icon)} /></svg>
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

      {/* 附件（批次 004 正式形态）：缩略 72 圆角 9 + 底部标签条 + 非原图右上 ×，
          「加图」是 72×72 虚线框（满 4 张就收起，不给禁用态），拖进来也行。
          原始截图 = 凭证，不给删除键；新建时的图先攒本地，保存成功后才上传挂接。 */}
      <div
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); takeFiles(e.dataTransfer.files); }}>
        <div className="flex items-baseline gap-[8px] mb-[6px]">
          <span className="flex-none text-[11px] font-semibold tracking-[.06em] text-faint whitespace-nowrap">{t("money.attsLabel")}</span>
          <span className="flex-none text-[10.5px] text-faint whitespace-nowrap">{attCount} / 4</span>
          {uploading ? <span className="flex-none text-[10.5px] text-faint whitespace-nowrap">{t("money.attUploading")}</span> : null}
        </div>
        <div className="flex flex-wrap gap-[8px]">
          {atts.map((a) => (
            <div key={a.file_id} className="relative flex-none w-[72px] h-[72px] rounded-[9px] border border-border bg-chip overflow-hidden">
              {/* 原来是 <a target=_blank> 在新窗口开原图 —— 现在和提醒 / 保险箱一样走通用
                  ImageViewer（sam 第二轮：图片预览要一个通用弹框，能左右切）。 */}
              <button className="w-full h-full p-0 block bg-transparent border-none cursor-zoom-in"
                title={a.origin ? t("money.attOrigin") : a.label}
                onClick={() => openImg(fileUrl(a.file_id))}>
                <img src={fileUrl(a.file_id)} alt={a.label} className="w-full h-full object-cover" />
              </button>
              <div className="absolute left-0 right-0 bottom-0 px-[5px] py-[2px] bg-[rgba(11,10,9,.62)] text-white text-[10px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">
                {a.origin ? t("money.attOrigin") : (a.label || t("money.attImage"))}
              </div>
              {!a.origin && initial ? (
                <button
                  className="absolute top-[3px] right-[3px] w-[19px] h-[19px] rounded-full bg-[rgba(11,10,9,.6)] text-white cursor-pointer flex items-center justify-center"
                  title={t("common.delete")}
                  onClick={async () => {
                    const ok = await askConfirm({
                      title: t("money.attDelTitle"),
                      message: t("money.attDelBody"),
                      confirmText: t("common.delete"),
                      danger: true,
                    });
                    if (!ok) return;
                    const done = await deleteMoneyAtt(initial.id, a.file_id);
                    showToast(done ? t("money.attDeleted") : t("money.saveFailed"), { tone: done ? "ok" : "warn" });
                    if (done) setAtts((cur) => cur.filter((x) => x.file_id !== a.file_id));
                  }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              ) : null}
            </div>
          ))}
          {/* 草稿带来的图（批次 013）：已在服务端、账还没落库。标签条写「保存后挂上」，不给 × ——
              它是识图那笔的凭证，和原始截图同一待遇（真要不要，保存后在编辑态里摘）。 */}
          {draftAtts.map((a) => (
            <div key={a.file_id} className="relative flex-none w-[72px] h-[72px] rounded-[9px] border border-border bg-chip overflow-hidden">
              <button className="w-full h-full p-0 block bg-transparent border-none cursor-zoom-in" title={a.label} onClick={() => openImg(fileUrl(a.file_id))}>
                <img src={fileUrl(a.file_id)} alt={a.label} className="w-full h-full object-cover" />
              </button>
              <div className="absolute left-0 right-0 bottom-0 px-[5px] py-[2px] bg-[rgba(11,10,9,.62)] text-white text-[10px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">
                {t("money.attAfterSave")}
              </div>
            </div>
          ))}
          {pending.map((p) => (
            <div key={p.key} className="relative flex-none w-[72px] h-[72px] rounded-[9px] border border-border bg-chip overflow-hidden">
              <button className="w-full h-full p-0 block bg-transparent border-none cursor-zoom-in" title={p.file.name} onClick={() => openImg(p.url)}>
                <img src={p.url} alt={p.file.name} className="w-full h-full object-cover" />
              </button>
              <div className="absolute left-0 right-0 bottom-0 px-[5px] py-[2px] bg-[rgba(11,10,9,.62)] text-white text-[10px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">
                {p.file.name}
              </div>
              <button
                className="absolute top-[3px] right-[3px] w-[19px] h-[19px] rounded-full bg-[rgba(11,10,9,.6)] text-white cursor-pointer flex items-center justify-center"
                title={t("common.delete")} onClick={() => dropPending(p.key)}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
          ))}
          {attRoom ? (
            <button onClick={() => fileRef.current?.click()}
              className="flex-none w-[72px] h-[72px] rounded-[9px] border border-dashed border-border bg-transparent text-muted cursor-pointer flex flex-col items-center justify-center gap-[4px] hover:border-orange hover:text-orange-text">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5.5" width="17" height="13" rx="3" /><path d="M7 15l3.5-4 3 3.5 2-2L18 15" /></svg>
              <span className="text-[11px] font-semibold whitespace-nowrap">{t("money.attAdd")}</span>
            </button>
          ) : null}
        </div>
        <div className="mt-[6px] text-[11px] text-faint leading-[1.65]">
          {atts.some((a) => a.origin) ? t("money.attOriginHint") : t("money.attHint")}
        </div>
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
          onChange={(e) => { if (e.target.files) takeFiles(e.target.files); e.target.value = ""; }} />
      </div>
      <ImageViewer src={viewer} items={viewerItems} onClose={() => setViewer(null)} />
    </Modal>
  );
}
