// 记账 · 分类与色槽（设置 → 记账，对齐稿 5272–5345）。
//
// 三条底层规则，全部来自服务端的约定：
//   ① slug 永不可改 —— 流水里存的是它，改名只改显示名，历史数据不动；
//   ② 色槽 1–7 彩色、0 中性灰，**唯一性由客户端维护**（服务端不做约束）：
//      抢别人的槽 = 两次 PATCH（先把旧主让到 0，再把自己设过去）；
//   ③ locked（其他/其他-收入）是兜底分类，不给「停用」按钮 —— 别的分类停用后
//      历史数据还有地方归，兜底自己没了就真的没地方了。
//
// 稿里的「另一台设备刚改过分类」冲突横幅这一版不做：多设备冲突的整体模型
// 还没拍板（05-记账全量 E15），单做一处会定下一个没经过深思的先例。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchMoneyCats, updateMoneyCat, type MoneyCat } from "../../services/server";
import { showToast } from "../../components/overlay";
import { Modal, EmptyState, btn } from "../../components/ui";
import { catColor, catIcon, catTint } from "../money/moneyKit";

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
      {/* 色槽占用一览 */}
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
      </div>

      {/* 分类表：支出在前、收入在后（服务端排好的顺序，别在这重排） */}
      <div className="bg-card border border-border rounded-[11px] overflow-hidden">
        <div className="flex items-center gap-[11px] px-[14px] py-[9px] bg-rail border-b border-border text-[10.5px] font-semibold tracking-[.06em] text-faint">
          <span className="w-[26px] flex-none" />
          <span className="flex-1 min-w-0">{t("money.thCat")}</span>
          <span className="w-[58px] flex-none">{t("money.catsThSlot")}</span>
          <span className="w-[70px] flex-none">{t("money.catsThSub")}</span>
          <span className="w-[150px] flex-none text-right">{t("money.catsThActions")}</span>
        </div>
        {cats.map((c) => (
          <div key={c.slug} className={`flex items-center gap-[11px] px-[14px] py-[9px] border-b border-border-soft last:border-b-0 hover:bg-hover ${c.enabled ? "" : "opacity-60"}`}>
            <span className="w-[26px] h-[26px] flex-none rounded-[7px] flex items-center justify-center"
              style={c.enabled
                ? { color: catColor(c.slot), background: catTint(c.slot) }
                : { color: "var(--faint)", background: "var(--chip)" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={catIcon(c.slug)} /></svg>
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
            <span className="w-[70px] flex-none text-[11px] text-faint whitespace-nowrap">
              {/* 子类数从服务端来（第二批落库；新增/编辑子类在 iOS 端，PC 管理界面缺稿已发设计） */}
              {t("money.subCount", { n: (c.subs || []).length })}
            </span>
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
        ))}
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
