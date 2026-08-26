// 记账 · 分类与色槽（设置 → 记账，对齐稿 5272–5345 + 批次 004 的子类管理/新增分类）。
//
// 三条底层规则，全部来自服务端的约定：
//   ① slug 永不可改 —— 流水里存的是它，改名只改显示名，历史数据不动；
//   ② 色槽 1–7 彩色、0 中性灰，**唯一性由客户端维护**（服务端不做约束）：
//      抢别人的槽 = 两次 PATCH（先把旧主让到 0，再把自己设过去）；
//   ③ locked（其他/其他-收入）是兜底分类，不给「停用」按钮 —— 别的分类停用后
//      历史数据还有地方归，兜底自己没了就真的没地方了。
//
// 批次 004 的两块新东西都贴着这张表做：
//   子类管理 —— 点行上的「N 个子类」**就地展开**，不再开一层弹窗；改名就地改、
//   重名当场红字、删除过二次确认。子类的正本在服务端（money_subs），这里每次
//   展开现拉带 used 的列表，写完重拉 —— 写接口的响应不带 used，拿去渲染会说谎。
//   新增分类 —— 标题行右侧的橙色主按钮开 480 弹窗。九个彩色槽已满，新分类一律
//   落中性灰（服务端 slot=0），想上色去「改色槽」从别的分类那儿要，不悄悄挤掉谁。
//
// 稿里的「另一台设备刚改过分类」冲突横幅这一版不做：多设备冲突的整体模型
// 还没拍板（05-记账全量 E15），单做一处会定下一个没经过深思的先例。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addMoneySub, createMoneyCat, deleteMoneySub, fetchMoneyCats, fetchMoneySubs,
  renameMoneySub, updateMoneyCat, type MoneyCat, type MoneySub,
} from "../../services/server";
import { askConfirm, showToast } from "../../components/overlay";
import { Modal, EmptyState, btn } from "../../components/ui";
import { catColor, catIcon, catTint, PICK_ICONS } from "../money/moneyKit";

const BTN_S = "flex-none whitespace-nowrap px-[9px] py-[3px] border border-border bg-transparent rounded-[7px] text-[11px] text-muted cursor-pointer hover:border-orange hover:text-orange-text";
const BTN_S_WARN = "flex-none whitespace-nowrap px-[9px] py-[3px] border border-border bg-transparent rounded-[7px] text-[11px] text-muted cursor-pointer hover:border-warning hover:text-warning";

export function MoneyCats() {
  const { t } = useTranslation();
  const [cats, setCats] = useState<MoneyCat[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<MoneyCat | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [slotFor, setSlotFor] = useState<MoneyCat | null>(null);
  /** 抢槽确认：目标槽被谁占着。null = 没在确认。 */
  const [grab, setGrab] = useState<{ slot: number; owner: MoneyCat } | null>(null);
  /** 子类管理：哪个分类的管理区展开着（同时只开一个，跟稿一致）。 */
  const [subOpen, setSubOpen] = useState<string | null>(null);
  /** 每个分类的子类列表缓存。undefined = 还没拉，null = 拉失败。 */
  const [subs, setSubs] = useState<Record<string, MoneySub[] | null>>({});
  /** 就地改名：正在改哪个（cat+原名）+ 输入框当前值。 */
  const [subEdit, setSubEdit] = useState<{ cat: string; name: string; val: string } | null>(null);
  /** 每个分类底部「加子类」输入框的草稿。 */
  const [subDraft, setSubDraft] = useState<Record<string, string>>({});
  /** 新增分类弹窗。 */
  const [newOpen, setNewOpen] = useState(false);
  const [newDir, setNewDir] = useState<"expense" | "income">("expense");
  const [newName, setNewName] = useState("");
  const [newIcon, setNewIcon] = useState(PICK_ICONS[0].k);

  const reload = useCallback(async () => {
    const r = await fetchMoneyCats(true);   // 停用的也要能看见、能开回来
    setCats(r);
    setFailed(r === null);
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const patch = async (slug: string, p: { name?: string; slot?: number; enabled?: boolean }): Promise<boolean> => {
    const r = await updateMoneyCat(slug, p);
    if (!r) showToast(t("money.catSaveFailed"), { tone: "warn" });
    return !!r;
  };

  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    if (ok) showToast(t("money.catSaved"), { tone: "ok" });
    await reload();
  };

  /** 给 cat 换到 slot。被占的槽先让旧主回中性灰再占过去 —— 顺序不能反：
   *  反过来会有一瞬间两家同槽，中间断掉的话图表里出现两个同色分类。
   *  现在这个顺序断掉最多是「旧主变灰、新主没接上」，下一次操作就能补救。 */
  const moveSlot = async (cat: MoneyCat, slot: number, owner: MoneyCat | null): Promise<boolean> => {
    if (owner && !(await patch(owner.slug, { slot: 0 }))) return false;
    return patch(cat.slug, { slot });
  };

  // ── 子类管理 ──────────────────────────────────────────────────────────────
  const loadSubs = useCallback(async (slug: string) => {
    const r = await fetchMoneySubs(slug);
    setSubs((m) => ({ ...m, [slug]: r }));
  }, []);

  const toggleSubs = (slug: string) => {
    setSubEdit(null);
    if (subOpen === slug) { setSubOpen(null); return; }
    setSubOpen(slug);
    // 每次展开都重拉：used 数会随记账变，缓存旧数会在删除确认里说错话。
    void loadSubs(slug);
  };

  /** 子类写操作的公共收尾：成功吐司 + 重拉这组子类（带 used）+ 重拉分类表（行上的
   *  「N 个子类」跟着变）。失败只吐司，展开区保持原样让用户重试。 */
  const subMutate = async (slug: string, fn: () => Promise<boolean>, okText: string): Promise<boolean> => {
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    if (!ok) { showToast(t("money.catSaveFailed"), { tone: "warn" }); return false; }
    showToast(okText, { tone: "ok" });
    await Promise.all([loadSubs(slug), reload()]);
    return true;
  };

  const saveSubRename = async () => {
    if (!subEdit) return;
    const { cat: slug, name } = subEdit;
    const v = subEdit.val.trim();
    if (!v || v === name) { setSubEdit(null); return; }
    if ((subs[slug] || []).some((s) => s.label === v)) return;   // 重名：红字已在界面上，按钮不干活
    setSubEdit(null);
    await subMutate(slug, () => renameMoneySub(slug, name, v), t("money.subRenamed", { name: v }));
  };

  const addSub = async (slug: string) => {
    const v = (subDraft[slug] || "").trim();
    if (!v || (subs[slug] || []).some((s) => s.label === v)) return;
    setSubDraft((m) => ({ ...m, [slug]: "" }));
    await subMutate(slug, () => addMoneySub(slug, v), t("money.subAdded", { name: v }));
  };

  /** 删子类：二次确认（删除一律要挡一道），文案照 iOS —— 有账在用要说清
   *  「它们不会变，只是以后记账选不到了」。 */
  const delSub = async (slug: string, s: MoneySub) => {
    const ok = await askConfirm({
      title: t("money.subDelTitle", { name: s.label }),
      message: s.used ? t("money.subDelBodyUsed", { n: s.used }) : t("money.subDelBody"),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    await subMutate(slug, () => deleteMoneySub(slug, s.label), t("money.subDeleted", { name: s.label }));
  };

  // ── 新增分类 ──────────────────────────────────────────────────────────────
  const newNameTrim = newName.trim();
  // 重名当场红字（服务端是全局查重：收入里也不许再来一个「餐饮」；停用的也算 ——
  // 服务端查的就是全表，这里的列表本来就带停用项）。
  const newDup = !!newNameTrim && !!cats?.some((c) => c.name === newNameTrim);
  const newOk = !!newNameTrim && !newDup && !busy;

  const doCreate = async () => {
    if (!newOk) return;
    setBusy(true);
    const r = await createMoneyCat(newNameTrim, newDir, newIcon);
    setBusy(false);
    if (!r) { showToast(t("money.catSaveFailed"), { tone: "warn" }); return; }
    setNewOpen(false);
    showToast(t("money.newCatDone", { name: newNameTrim }), { tone: "ok" });
    await reload();
  };

  if (failed) {
    return <EmptyState kind="offline" title={t("money.errTitle")} body={t("money.errBody")}
      actionLabel={t("common.retry")} onAction={() => void reload()} />;
  }
  if (!cats) {
    return <div className="h-[220px] bg-card border border-border rounded-[12px]" />;
  }

  const ownerOf = (slot: number): MoneyCat | null => cats.find((c) => c.slot === slot && c.enabled) || null;
  const grayNames = cats.filter((c) => c.slot === 0 && c.enabled).map((c) => c.name);
  // 彩色槽 1–7、9、10（批次 003 扩容：9=墨青、10=紫罗兰）；8 是中性灰不参与占用。
  const COLOR_SLOTS = [1, 2, 3, 4, 5, 6, 7, 9, 10];
  const freeSlots = COLOR_SLOTS.filter((n) => !ownerOf(n)).length;

  return (
    <div className="flex flex-col gap-[14px] max-w-[820px]">
      {/* 色槽占用一览 + 新增分类入口（批次 004：页面标题在 Settings 的 SecHead 里，
          按钮就近挂在第一行的右侧） */}
      <div className="flex items-center gap-[10px] px-[14px] py-[11px] bg-card border border-border rounded-[11px] flex-wrap">
        <span className="flex-none text-[12px] font-semibold whitespace-nowrap">{t("money.catsSlotUsage")}</span>
        <div className="flex-1 min-w-0 flex flex-wrap gap-[6px]">
          {COLOR_SLOTS.map((n) => {
            const o = ownerOf(n);
            return (
              <span key={n} className="flex items-center gap-[5px] px-[9px] py-[2px] rounded-full bg-chip text-[11px] whitespace-nowrap flex-none">
                <span className="w-[8px] h-[8px] rounded-full flex-none" style={{ background: `var(--c${n})` }} />
                {n} {o ? o.name : t("money.slotFree")}
              </span>
            );
          })}
          {grayNames.length ? (
            <span className="flex items-center gap-[5px] px-[9px] py-[2px] rounded-full bg-chip text-[11px] text-muted whitespace-nowrap flex-none">
              <span className="w-[8px] h-[8px] rounded-full flex-none bg-[var(--c8)]" />
              {t("money.catsGray")} {grayNames.join(" / ")}
            </span>
          ) : null}
        </div>
        <span className="flex-none text-[10.5px] text-faint whitespace-nowrap">
          {freeSlots ? t("money.catsSlotLeft", { n: freeSlots }) : t("money.catsSlotFull")}
        </span>
        <button
          className="flex-none flex items-center gap-[6px] px-[12px] py-[5px] rounded-[8px] bg-orange text-white text-[12px] font-semibold whitespace-nowrap cursor-pointer hover:bg-orange-deep"
          onClick={() => { setNewOpen(true); setNewDir("expense"); setNewName(""); setNewIcon(PICK_ICONS[0].k); }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          {t("money.newCatBtn")}
        </button>
      </div>

      {/* 分类表：支出在前、收入在后（服务端排好的顺序，别在这重排） */}
      <div className="bg-card border border-border rounded-[11px] overflow-hidden">
        <div className="flex items-center gap-[11px] px-[14px] py-[9px] bg-rail border-b border-border text-[10.5px] font-semibold tracking-[.06em] text-faint">
          <span className="w-[26px] flex-none" />
          <span className="flex-1 min-w-0">{t("money.thCat")}</span>
          <span className="w-[58px] flex-none">{t("money.catsThSlot")}</span>
          <span className="w-[82px] flex-none">{t("money.catsThSub")}</span>
          <span className="w-[150px] flex-none text-right">{t("money.catsThActions")}</span>
        </div>
        {cats.map((c) => {
          const open = subOpen === c.slug;
          const list = subs[c.slug];
          const draft = subDraft[c.slug] || "";
          const draftDup = !!draft.trim() && !!(list || []).some((s) => s.label === draft.trim());
          const canAdd = !!draft.trim() && !draftDup && !busy;
          return (
            <div key={c.slug}>
              <div className={`flex items-center gap-[11px] px-[14px] py-[9px] border-b border-border-soft hover:bg-hover ${c.enabled ? "" : "opacity-60"}`}>
                <span className="w-[26px] h-[26px] flex-none rounded-[7px] flex items-center justify-center"
                  style={c.enabled
                    ? { color: catColor(c.slot), background: catTint(c.slot) }
                    : { color: "var(--faint)", background: "var(--chip)" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={catIcon(c.slug, c.icon)} /></svg>
                </span>
                <span className="flex-1 min-w-0 flex items-center gap-[8px]">
                  <span className="w-[10px] h-[10px] flex-none rounded-full" style={{ background: c.enabled ? catColor(c.slot) : "var(--c8)" }} />
                  <span className="text-[12.5px] whitespace-nowrap">{c.name}</span>
                  {c.direction === "income" ? (
                    <span className="flex-none px-[7px] py-[1px] rounded-full bg-success-soft text-success text-[10px] whitespace-nowrap">{t("money.income")}</span>
                  ) : null}
                  {c.locked ? (
                    <span className="flex-none px-[7px] py-[1px] rounded-full bg-chip text-faint text-[10px] whitespace-nowrap">{t("money.lockedBadge")}</span>
                  ) : null}
                  {!c.enabled ? (
                    <span className="flex-none px-[7px] py-[1px] rounded-full bg-chip text-faint text-[10px] whitespace-nowrap">{t("money.disabledBadge")}</span>
                  ) : null}
                </span>
                <span className={`w-[58px] flex-none text-[11px] whitespace-nowrap ${c.slot ? "text-text" : "text-faint"}`}>
                  {c.slot ? t("money.slotN", { n: c.slot }) : t("money.slotGray")}
                </span>
                {/* 「N 个子类」是按钮不是数字（批次 004）：点了就地展开管理区 */}
                <button onClick={() => toggleSubs(c.slug)}
                  className={`w-[82px] flex-none flex items-center gap-[4px] py-[3px] pl-[7px] rounded-[7px] text-[11px] whitespace-nowrap cursor-pointer border ${
                    open ? "border-orange text-orange-text" : "border-transparent text-faint hover:border-orange hover:text-orange-text"}`}>
                  {t("money.subCount", { n: (c.subs || []).length })}
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                    className={`flex-none transition-transform ${open ? "rotate-90" : ""}`}><path d="M9 6l6 6-6 6" /></svg>
                </button>
                <span className="w-[150px] flex-none flex justify-end gap-[6px]">
                  <button className={BTN_S} disabled={busy} onClick={() => { setSlotFor(c); setGrab(null); }}>{t("money.actSlot")}</button>
                  <button className={BTN_S} disabled={busy} onClick={() => { setRenaming(c); setRenameVal(c.name); }}>{t("money.actRename")}</button>
                  {/* locked 是兜底分类，不给停用；停用可逆，所以不弹确认 */}
                  {c.locked ? null : c.enabled ? (
                    <button className={BTN_S_WARN} disabled={busy} onClick={() => void run(() => patch(c.slug, { enabled: false }))}>{t("money.actDisable")}</button>
                  ) : (
                    <button className={BTN_S} disabled={busy} onClick={() => void run(() => patch(c.slug, { enabled: true }))}>{t("money.actEnable")}</button>
                  )}
                </span>
              </div>

              {/* 就地展开的子类管理区（批次 004 稿：bg 底、左缩进对齐名字列） */}
              {open ? (
                <div className="flex flex-col gap-[9px] px-[14px] py-[11px] pb-[13px] pl-[51px] bg-bg border-b border-border-soft">
                  <div className="flex items-baseline gap-[9px]">
                    <span className="flex-none text-[10.5px] font-semibold tracking-[.06em] text-faint whitespace-nowrap">
                      {t("money.subAreaTitle", { name: c.name })}
                    </span>
                    <span className="flex-1 min-w-0 text-[10.5px] text-faint leading-[1.65]">{t("money.subAreaHint")}</span>
                  </div>

                  {list === undefined ? (
                    <span className="text-[11.5px] text-faint">{t("common.loading")}</span>
                  ) : list === null ? (
                    <span className="text-[11.5px] text-faint">{t("money.errTitle")}</span>
                  ) : list.length === 0 ? (
                    <span className="text-[11.5px] text-faint leading-[1.65]">{t("money.subAreaEmpty")}</span>
                  ) : (
                    <div className="flex flex-wrap gap-[7px]">
                      {list.map((s) => {
                        const editing = subEdit?.cat === c.slug && subEdit.name === s.label;
                        if (!editing) {
                          return (
                            <span key={s.label} className="flex-none flex items-center gap-[7px] h-[25px] pl-[10px] pr-[5px] border border-border rounded-full bg-card text-[11.5px] whitespace-nowrap">
                              {s.label}
                              <span className="text-[10px] text-faint">{s.used ? t("money.subUsed", { n: s.used }) : t("money.subUnused")}</span>
                              <button title={t("money.actRename")} disabled={busy}
                                className="flex-none w-[18px] h-[18px] flex items-center justify-center text-faint cursor-pointer hover:text-orange-text"
                                onClick={() => setSubEdit({ cat: c.slug, name: s.label, val: s.label })}>
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                              </button>
                              <button title={t("common.delete")} disabled={busy}
                                className="flex-none w-[18px] h-[18px] flex items-center justify-center text-faint cursor-pointer hover:text-danger"
                                onClick={() => void delSub(c.slug, s)}>
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                              </button>
                            </span>
                          );
                        }
                        const dup = !!subEdit && !!subEdit.val.trim()
                          && subEdit.val.trim() !== s.label
                          && list.some((x) => x.label === subEdit.val.trim());
                        return (
                          <span key={s.label} className="flex-none flex items-center gap-[6px] h-[25px] px-[4px] border border-orange rounded-full bg-card">
                            <input value={subEdit!.val} autoFocus
                              onChange={(e) => setSubEdit({ cat: c.slug, name: s.label, val: e.target.value })}
                              onKeyDown={(e) => { if (e.key === "Enter" && !dup) void saveSubRename(); if (e.key === "Escape") setSubEdit(null); }}
                              className="w-[78px] bg-transparent text-text text-[11.5px] outline-none px-[4px]" />
                            <button disabled={busy || dup} onClick={() => void saveSubRename()}
                              className={`flex-none h-[19px] px-[8px] rounded-full text-[10.5px] font-semibold whitespace-nowrap ${
                                dup ? "bg-chip text-faint cursor-not-allowed" : "bg-orange text-white cursor-pointer"}`}>
                              {t("money.subSave")}
                            </button>
                            <button onClick={() => setSubEdit(null)}
                              className="flex-none w-[18px] h-[18px] flex items-center justify-center text-faint cursor-pointer">
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                            </button>
                            {dup ? <span className="text-[10.5px] text-danger whitespace-nowrap pr-[4px]">{t("money.subDup", { name: subEdit!.val.trim() })}</span> : null}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  <div className="flex items-center gap-[7px]">
                    <input value={draft} placeholder={list?.length ? t("money.subAddPhMore") : t("money.subAddPh", { eg: c.direction === "income" ? t("money.subEgIncome") : t("money.subEgExpense") })}
                      onChange={(e) => setSubDraft((m) => ({ ...m, [c.slug]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter" && canAdd) void addSub(c.slug); }}
                      className="flex-none w-[180px] px-[10px] py-[5px] border border-border rounded-[7px] bg-card text-text text-[12px] outline-none focus:border-orange" />
                    <button disabled={!canAdd} onClick={() => void addSub(c.slug)}
                      className={`flex-none px-[12px] py-[5px] rounded-[7px] text-[12px] font-semibold whitespace-nowrap ${
                        canAdd ? "bg-orange text-white cursor-pointer" : "bg-chip text-faint cursor-not-allowed"}`}>
                      {t("money.subAddBtn")}
                    </button>
                    {draftDup ? (
                      <span className="flex-1 min-w-0 text-[11px] text-danger leading-[1.6]">{t("money.subDup", { name: draft.trim() })}</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* 改名弹窗 */}
      {renaming ? (
        <Modal width={400} title={t("money.renameTitle", { name: renaming.name })} onClose={() => setRenaming(null)}
          footer={<>
            <span className="flex-1 min-w-0 text-[11px] text-faint truncate">{t("money.renameHint")}</span>
            <button className={btn("ghost")} onClick={() => setRenaming(null)}>{t("common.cancel")}</button>
            <button className={btn("primary")} disabled={busy || !renameVal.trim()}
              onClick={() => { const c = renaming; setRenaming(null); void run(() => patch(c.slug, { name: renameVal.trim() })); }}>
              {t("common.save")}
            </button>
          </>}>
          <input value={renameVal} onChange={(e) => setRenameVal(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === "Enter" && renameVal.trim()) { const c = renaming; setRenaming(null); void run(() => patch(c.slug, { name: renameVal.trim() })); } }}
            className="w-full px-[11px] py-[7px] border border-border rounded-[8px] bg-bg text-text text-[12.5px] outline-none focus:border-orange" />
        </Modal>
      ) : null}

      {/* 新增分类弹窗（批次 004，480 宽）：记在哪边 / 名称 / 图标 / 实时预览 */}
      {newOpen ? (
        <Modal width={480} title={t("money.newCatTitle")} onClose={() => setNewOpen(false)}
          footer={<>
            <button className={btn("ghost")} onClick={() => setNewOpen(false)}>{t("common.cancel")}</button>
            <button disabled={!newOk} onClick={() => void doCreate()}
              className={`flex-none px-[16px] py-[6px] rounded-[8px] text-[12.5px] font-semibold whitespace-nowrap ${
                newOk ? "bg-orange text-white cursor-pointer" : "bg-chip text-faint cursor-not-allowed"}`}>
              {t("money.newCatCreate")}
            </button>
          </>}>
          <div className="flex items-center gap-[11px]">
            <span className="flex-none w-[52px] text-[11px] font-semibold tracking-[.06em] text-faint whitespace-nowrap">{t("money.newCatDir")}</span>
            <div className="flex-none flex gap-[3px] p-[3px] bg-chip rounded-full">
              {([["expense", t("money.expense")], ["income", t("money.income")]] as const).map(([k, label]) => (
                <button key={k} onClick={() => setNewDir(k)}
                  className={`flex-none h-[26px] px-[15px] rounded-full text-[12px] whitespace-nowrap cursor-pointer border ${
                    newDir === k ? "border-orange bg-orange-soft text-orange-text font-semibold" : "border-transparent bg-transparent text-muted hover:bg-hover"}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-[11px]">
            <span className="flex-none w-[52px] text-[11px] font-semibold tracking-[.06em] text-faint whitespace-nowrap">{t("money.newCatName")}</span>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus placeholder={t("money.newCatNamePh")}
              onKeyDown={(e) => { if (e.key === "Enter") void doCreate(); }}
              className="flex-1 min-w-0 px-[11px] py-[7px] border border-border rounded-[8px] bg-bg text-text text-[12.5px] outline-none focus:border-orange" />
          </div>
          {newDup ? (
            <div className="flex items-center gap-[7px] pl-[63px]">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round" className="flex-none"><circle cx="12" cy="12" r="9" /><path d="M12 8v4.5M12 16v.01" /></svg>
              <span className="flex-1 min-w-0 text-[11.5px] text-danger leading-[1.6]">{t("money.newCatDup", { name: newNameTrim })}</span>
            </div>
          ) : null}

          <div className="flex items-start gap-[11px]">
            <span className="flex-none w-[52px] pt-[8px] text-[11px] font-semibold tracking-[.06em] text-faint whitespace-nowrap">{t("money.newCatIcon")}</span>
            <div className="flex-1 min-w-0 flex flex-wrap gap-[7px]">
              {PICK_ICONS.map((o) => (
                <button key={o.k} title={o.label} onClick={() => setNewIcon(o.k)}
                  className={`w-[32px] h-[32px] flex-none flex items-center justify-center rounded-[8px] cursor-pointer border ${
                    newIcon === o.k ? "border-orange bg-orange-soft text-orange-text" : "border-border bg-card text-muted hover:border-orange"}`}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={o.d} /></svg>
                </button>
              ))}
            </div>
          </div>

          {/* 实时预览：新分类一律中性灰（服务端 slot=0），色槽满了不悄悄挤掉谁 */}
          <div className="flex gap-[11px] px-[12px] py-[11px] bg-rail border border-border rounded-[10px]">
            <span className="flex-none w-[30px] h-[30px] rounded-[8px] flex items-center justify-center"
              style={{ color: "var(--c8)", background: "color-mix(in srgb, var(--c8) var(--cat-tint), transparent)" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={PICK_ICONS.find((o) => o.k === newIcon)?.d || PICK_ICONS[0].d} /></svg>
            </span>
            <div className="flex-1 min-w-0 flex flex-col gap-[5px]">
              <div className="flex items-center gap-[8px]">
                <span className="flex-none text-[12.5px] font-semibold whitespace-nowrap">{newNameTrim || t("money.newCatPreviewName")}</span>
                <span className="flex-none px-[7px] py-[1px] rounded-full bg-chip text-faint text-[10px] whitespace-nowrap">
                  {newDir === "income" ? t("money.income") : t("money.expense")}
                </span>
                <span className="flex-none flex items-center gap-[5px] text-[11px] text-faint whitespace-nowrap">
                  <span className="w-[8px] h-[8px] rounded-full bg-[var(--c8)]" />{t("money.slotGray")}
                </span>
              </div>
              <span className="text-[11px] text-faint leading-[1.65]">{t("money.newCatSlotHint")}</span>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* 挑色槽弹窗：灰 + 七个槽，占用的槽标出现在的主人，点它进入抢槽确认 */}
      {slotFor ? (
        <Modal width={430} title={t("money.slotTitle", { name: slotFor.name })} onClose={() => { setSlotFor(null); setGrab(null); }}>
          {grab ? (
            <div className="flex flex-col gap-[10px]">
              <div className="text-[13.5px] font-semibold leading-[1.5]">
                {t("money.slotGrabTitle", { n: grab.slot, name: slotFor.name })}
              </div>
              <div className="text-[12.5px] leading-[1.7] text-muted">
                {t("money.slotGrabBody", { n: grab.slot, owner: grab.owner.name })}
              </div>
              <div className="flex items-center gap-[10px] px-[11px] py-[9px] bg-rail border border-border rounded-[9px]">
                <span className="flex items-center gap-[6px] flex-none text-[11.5px] whitespace-nowrap">
                  <span className="w-[9px] h-[9px] rounded-full flex-none" style={{ background: `var(--c${grab.slot})` }} />
                  {slotFor.name}
                </span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                <span className="flex items-center gap-[6px] flex-none text-[11.5px] text-muted whitespace-nowrap">
                  <span className="w-[9px] h-[9px] rounded-full flex-none bg-[var(--c8)]" />
                  {t("money.slotGrabLoser", { owner: grab.owner.name })}
                </span>
              </div>
              <div className="flex justify-end gap-[8px]">
                <button className={btn("ghost")} onClick={() => setGrab(null)}>{t("common.cancel")}</button>
                <button className={btn("primary")} disabled={busy}
                  onClick={() => { const c = slotFor, g = grab; setSlotFor(null); setGrab(null); void run(() => moveSlot(c, g.slot, g.owner)); }}>
                  {t("money.slotGrabConfirm")}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-[6px]">
              {[0, ...COLOR_SLOTS].map((n) => {
                const o = n ? ownerOf(n) : null;
                const mine = slotFor.slot === n;
                return (
                  <button key={n} disabled={busy}
                    onClick={() => {
                      if (mine) { setSlotFor(null); return; }
                      if (o) { setGrab({ slot: n, owner: o }); return; }
                      const c = slotFor;
                      setSlotFor(null);
                      void run(() => moveSlot(c, n, null));
                    }}
                    className={`flex items-center gap-[10px] px-[11px] py-[8px] rounded-[8px] border text-left cursor-pointer ${
                      mine ? "border-orange bg-orange-soft" : "border-border bg-transparent hover:border-orange"}`}>
                    <span className="w-[10px] h-[10px] flex-none rounded-full" style={{ background: n ? `var(--c${n})` : "var(--c8)" }} />
                    <span className="flex-none text-[12.5px] whitespace-nowrap">{n ? t("money.slotN", { n }) : t("money.slotGray")}</span>
                    <span className="flex-1 min-w-0 text-right text-[11.5px] text-faint truncate">
                      {mine ? t("money.slotMine") : o ? o.name : n ? t("money.slotFree") : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Modal>
      ) : null}
    </div>
  );
}
