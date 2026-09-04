// 常用语（一级导航）。批次 013 正式稿：《PC 常用语与带图入口.dc.html》01–03 节 / tokens.phrasePage + phraseTags。
// 套页面骨架的 **T2 列表 + 弹窗**：
//   页头：「常用语 · N 条」+ 同步戳 + 主「新增短语」+ 齿轮（常用语设置）；没有第二行（几十条短语不值得一条搜索加筛选轨）；
//         没有值得放的低频动作，所以 ⋯ 不出；**一条都没有时主按钮不渲染**（裁定 8：橙留给空态里那颗）。
//   内容：按**标签**分组，分组顺序 = 设置里的标签顺序，「无标签」永远最后；卡内逐行（行取值见 PhraseRow）。
//         点行原地展开只读全文；hover 出铅笔进 560 编辑弹窗；复制常驻；删除 / 换标签只在右键菜单；
//         组内拖手柄调序（跨组不拖 —— 换标签走右键或编辑弹窗）。
//   新增 / 换标签：保存后落在**所属标签分组的第一行**（不是整页顶部——分好组了还往顶上塞会读成标签没生效），
//         --orange-soft 渐隐 1.2s，列表滚到那一行为止（nearest，不居中）；改了标签的那条从旧组消失、在新组高亮出现。
//   设置视图（T3，两组叠放）：见 PhrasesSettings。
//
// 触发词 → 标签（sam 定，一条一个）：数据上标签名就是 Phrase.keyword，老触发词自动成为标签；
// 编辑时只能从清单里**选**，要新标签去设置视图建（和记账分类同一个纪律）。
// 数据仍在主进程（umbra-config.json + 云端同步），这里只做展示与派发；删除走墓碑同步，这轮起服务端把它进回收站（30 天）。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ContextMenu, EmptyState, Modal, btn, select as selectCls, field, fieldLabel, textarea as textareaCls } from "../../components/ui";
import { PageShell, ListModal, Skeleton, useFlashId } from "../../components/layout";
import { askConfirm, showToast } from "../../components/overlay";
import { IconPhrase, IconTrash } from "../../components/icons";
import { displayAccel } from "../../components/hotkey";
import { launcherApi, hasLauncher, type Phrase } from "../tools/bridges";
import { PhraseRow } from "./PhraseRow";
import { PhrasesSettings } from "./PhrasesSettings";
import { FLIP_MS, GlyphCopy, GlyphPencil, SyncStatus, tagOf, usePhrasesShortcut } from "./shared";

/** 把 item 放到它所属标签分组的第一行：分组内按数组顺序画，所以挪到同标签的第一条之前就行；
 *  这个标签还没有别的短语时放哪都一样，放数组头。 */
function placeFirst(list: Phrase[], item: Phrase): Phrase[] {
  const rest = list.filter((p) => p.id !== item.id);
  const at = rest.findIndex((p) => tagOf(p) === tagOf(item));
  if (at < 0) rest.unshift(item); else rest.splice(at, 0, item);
  return rest;
}

export function Phrases() {
  const { t } = useTranslation();
  const api = launcherApi();
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  // 首趟 getPhrases 回来前是「还不知道有没有」：画骨架，不判空、不藏主按钮 —— 否则进页先闪一帧空态。
  const [loaded, setLoaded] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [modal, setModal] = useState<{ id: string | null; name: string; tag: string; content: string } | null>(null);
  const [retag, setRetag] = useState<{ id: string; tag: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [flashId, flash] = useFlashId();
  const [shortcut, setShortcut] = usePhrasesShortcut();
  const copyTimer = useRef<number | null>(null);
  // 最新的列表：拖拽落盘要读它，不能读渲染闭包里的 phrases —— dragover 里的 setPhrases 是连续事件优先级，
  // drop / dragend 跑到时那一步可能还没提交，闭包里的会比屏幕上少最后一步。每次渲染同步赋值，moveTo 里再抢先赋一次。
  const phrasesRef = useRef(phrases);
  phrasesRef.current = phrases;

  const reload = () => {
    void api.getPhrases().then((p) => setPhrases(p || [])).catch(() => {}).finally(() => setLoaded(true));
    void api.getPhraseTags().then((tg) => setTags(tg || []));
  };
  useEffect(() => {
    if (!hasLauncher) return;
    reload();
    // 云端同步改写了常用语 / 标签时跟着更新（别的设备改了这边要看得到）。
    const off = api.onPhrasesChanged(() => reload());
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current); }, []);

  // 落盘。主进程会盖改动时间戳、收集删除墓碑并排一次云端推送。
  const save = (list: Phrase[]) => { setPhrases(list); void api.setPhrases(list); };

  // 按标签分组：清单顺序在前，「无标签」永远最后；清单里没有但短语用到的标签也得有一组（老数据兜底）。
  const groups = useMemo(() => {
    const order = [...tags];
    for (const p of phrases) { const k = tagOf(p); if (k && !order.includes(k)) order.push(k); }
    const out: { tag: string; rows: Phrase[] }[] = order.map((tag) => ({ tag, rows: phrases.filter((p) => tagOf(p) === tag) }));
    const none = phrases.filter((p) => !tagOf(p));
    if (none.length) out.push({ tag: "", rows: none });
    return out.filter((g) => g.rows.length);
  }, [phrases, tags]);

  const openNew = () => setModal({ id: null, name: "", tag: "", content: "" });
  const openEdit = (p: Phrase) => setModal({ id: p.id, name: p.name, tag: p.keyword || "", content: p.content });

  // ── 组内拖拽调序（FLIP，沿用 011 那套；跨组不拖）──────────────────────────
  const [dragId, setDragId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const prevRects = useRef(new Map<string, DOMRect>());
  const orderDirty = useRef(false);
  const lockUntil = useRef(0);
  // 刚落组首的那条不参与 FLIP：稿说的是「从旧组消失、在新组高亮出现」，不是从旧组滑过去。
  const skipFlip = useRef<string | null>(null);
  const snapshot = () => {
    const m = new Map<string, DOMRect>();
    rowRefs.current.forEach((el, id) => m.set(id, el.getBoundingClientRect()));
    prevRects.current = m;
  };
  useLayoutEffect(() => {
    rowRefs.current.forEach((el, id) => {
      const before = prevRects.current.get(id);
      if (!before) return;
      const dy = before.top - el.getBoundingClientRect().top;
      if (!dy || id === dragId || id === skipFlip.current) return;
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => { el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(.2,.7,.3,1)`; el.style.transform = ""; });
    });
    prevRects.current.clear();
    skipFlip.current = null;
  }, [phrases, dragId]);
  const moveTo = (targetId: string, clientY: number) => {
    if (!dragId || dragId === targetId || Date.now() < lockUntil.current) return;
    const cur = phrasesRef.current;    // 同样读 ref：连着两次 dragover 之间可能还没重渲染
    const from = cur.findIndex((p) => p.id === dragId);
    const to = cur.findIndex((p) => p.id === targetId);
    if (from < 0 || to < 0) return;
    if (tagOf(cur[from]) !== tagOf(cur[to])) return;   // 跨组不拖
    const el = rowRefs.current.get(targetId);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    if (to > from ? clientY < mid : clientY > mid) return;
    lockUntil.current = Date.now() + FLIP_MS;
    snapshot();
    const list = cur.slice();
    const [it] = list.splice(from, 1);
    list.splice(to, 0, it);
    orderDirty.current = true;
    phrasesRef.current = list;      // 先于渲染记下来：紧接着的 drop / dragend 要落盘的就是它
    setPhrases(list);
  };
  // drop 与 dragend 都会到这里（drop 在前）：第一次把顺序落盘，第二次 orderDirty 已清，只是收尾。
  const endDrag = () => {
    setDragId(null);
    lockUntil.current = 0;
    if (orderDirty.current) { orderDirty.current = false; void api.setPhrases(phrasesRef.current); }
  };

  // ── 新增 / 换标签的落位：组首 + 高亮 1.2s + 滚到那一行 ──────────────────────
  const land = (list: Phrase[], item: Phrase) => {
    snapshot();                     // 让位的那些行 FLIP 过去
    skipFlip.current = item.id;
    save(placeFirst(list, item));
    flash(item.id);
  };
  useEffect(() => {
    if (!flashId) return;
    const el = rowRefs.current.get(flashId);
    if (!el) return;
    // 滚到那一行为止（nearest），不做居中滚动。
    el.scrollIntoView({ block: "nearest" });
    // --orange-soft 渐隐 1.2s：先满色停一小段再淡出。用 WAAPI 而不是切 class——切 class 要么淡入淡出各 1.2s，
    // 要么把行的 hover 过渡也拖到 1.2s；动画结束后底色回到 class 决定的 hover / 展开态。
    if (typeof el.animate !== "function") return;
    const soft = getComputedStyle(el).getPropertyValue("--orange-soft").trim() || "transparent";
    el.animate(
      [{ backgroundColor: soft, offset: 0 }, { backgroundColor: soft, offset: 0.25 }, { backgroundColor: "transparent", offset: 1 }],
      { duration: 1200, easing: "ease-out" },
    );
  }, [flashId]);

  // ── 编辑 / 新增弹窗 ────────────────────────────────────────────────────────
  const modalValid = !!modal && !!modal.name.trim() && !!modal.content.trim();
  const commitModal = () => {
    if (!modal || !modalValid) return;
    const kw = modal.tag.trim() || undefined;
    if (modal.id) {
      const prev = phrases.find((p) => p.id === modal.id);
      if (!prev) { setModal(null); return; }
      const next: Phrase = { ...prev, name: modal.name.trim(), content: modal.content, keyword: kw };
      // 换了标签：从旧组消失、在新组第一行高亮出现；只改名字或内容的原位不动。
      if (tagOf(prev) !== tagOf(next)) land(phrases, next);
      else save(phrases.map((p) => (p.id === modal.id ? next : p)));
    } else {
      const id = `ph${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      land(phrases, { id, name: modal.name.trim(), content: modal.content, keyword: kw });
    }
    setModal(null);
  };

  // ── 换标签（右键 → 480 弹窗）─────────────────────────────────────────────────
  const retagTarget = retag ? phrases.find((p) => p.id === retag.id) : undefined;
  const retagChanged = !!retag && !!retagTarget && tagOf(retagTarget) !== retag.tag.trim();
  const commitRetag = () => {
    if (!retag || !retagTarget) { setRetag(null); return; }
    if (retagChanged) land(phrases, { ...retagTarget, keyword: retag.tag.trim() || undefined });
    setRetag(null);
  };

  // ── 复制全文：行内钮 / 展开区的钮 / 右键都走这里；成功后行内钮换勾 2 秒 ────────
  const copy = async (p: Phrase) => {
    try { await navigator.clipboard.writeText(p.content); }
    catch { showToast(t("layout.copyFailed"), { tone: "fail" }); return; }
    setCopiedId(p.id);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopiedId(null), 2000);
    showToast(t("phrases.copiedFull", { name: p.name }), { tone: "ok" });
  };

  // ── 删除：二次确认走统一模板（这轮常用语真进回收站了）────────────────────────
  const askDelete = async (id: string) => {
    const p = phrases.find((x) => x.id === id);
    if (!p) return;
    const ok = await askConfirm({
      title: t("phrases.deleteTitle", { name: p.name }),
      message: t("phrases.deleteBody"),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    if (expanded === id) setExpanded(null);
    snapshot();
    save(phrases.filter((x) => x.id !== id));
    showToast(t("phrases.deleted"), { tone: "ok" });
  };

  const row = (p: Phrase) => (
    <PhraseRow key={p.id} p={p}
      open={expanded === p.id}
      copied={copiedId === p.id}
      dragging={dragId === p.id}
      rowRef={(el) => { if (el) rowRefs.current.set(p.id, el); else rowRefs.current.delete(p.id); }}
      drag={{
        // 只有手柄是拖拽源（PhraseRow 里 draggable 只挂在手柄上），所以到这里的一定是从手柄拖起来的。
        onStart: (e) => {
          lockUntil.current = 0; setDragId(p.id);
          e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", p.id);
          // 拖影用整行（此刻还没压淡，截下来的是正常态），偏移量按光标在行内的位置算，拖起来不跳。
          const el = rowRefs.current.get(p.id);
          if (el) { const r = el.getBoundingClientRect(); e.dataTransfer.setDragImage(el, e.clientX - r.left, e.clientY - r.top); }
        },
        onEnd: endDrag,
        onOver: (e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; moveTo(p.id, e.clientY); } },
        onDrop: (e) => { e.preventDefault(); endDrag(); },
      }}
      onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
      onEdit={() => openEdit(p)}
      onCopy={() => void copy(p)}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id: p.id }); }} />
  );

  if (!hasLauncher) {
    return (
      <PageShell header={{ title: t("nav.phrases") }}>
        <EmptyState title={t("common.desktopOnly")} />
      </PageShell>
    );
  }

  const menuTarget = menu ? phrases.find((x) => x.id === menu.id) : undefined;

  return (
    <PageShell
      header={{
        title: t("nav.phrases"),
        subtitle: t("phrases.countN", { n: phrases.length }),
        status: <SyncStatus />,
        // 裁定 8：一条都没有时主按钮不渲染，一页只留空态里那颗橙。首屏没回来前不算「没有」，主按钮照常在。
        primary: loaded && !phrases.length ? undefined : { label: t("tools.phraseNew"), onClick: openNew },
      }}
      settings={{
        title: t("phrases.settingsTitle"),
        backLabel: t("phrases.backLabel"),
        status: t("phrases.instant"),
        content: (
          <PhrasesSettings phrases={phrases} tags={tags}
            onTags={(next) => { setTags(next); void api.setPhraseTags(next); }} onPhrases={save}
            shortcut={shortcut} onShortcut={setShortcut} />
        ),
      }}>
      {!loaded ? (
        // 首屏骨架（通用件）：三行不动画，首趟数据回来就换成列表或空态。
        <Skeleton rows={4} />
      ) : phrases.length ? (
        <ListModal>
          {groups.map((g) => (
            // 分组头 = 标签名 11/600/.06em + 条数 11px tabular，padding 0 2px；头与卡 gap 7；卡 --card + 1px + 圆角 12。
            <section key={g.tag || "__none"} className="flex flex-col gap-[7px]">
              <div className="flex items-center gap-[8px] px-[2px]">
                <span className="flex-none text-[11px] font-semibold tracking-[.06em] text-faint whitespace-nowrap">{g.tag || t("phrases.untagged")}</span>
                <span className="flex-none text-[11px] text-faint whitespace-nowrap [font-variant-numeric:tabular-nums]">{t("phrases.tagCount", { n: g.rows.length })}</span>
              </div>
              <div className="bg-card border border-border rounded-[12px] overflow-hidden">
                {g.rows.map(row)}
              </div>
            </section>
          ))}
        </ListModal>
      ) : (
        // 空态（稿 01 节）：38 图标块 + 「还没有常用语」13/600 + 一句 12px --muted + 橙钮 28。快捷键文案取实际录制的键位。
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-[9px] text-center px-[18px]">
          <span className="w-[38px] h-[38px] flex-none rounded-[10px] bg-chip text-faint flex items-center justify-center"><IconPhrase size={19} /></span>
          <span className="text-[13px] font-semibold">{t("settings.phrasesEmpty")}</span>
          <span className="text-[12px] text-muted leading-[1.7] max-w-[360px]">{t("phrases.emptyBody", { key: displayAccel(shortcut) })}</span>
          <button className={`${btn("primary", "sm")} mt-[2px]`} onClick={openNew}>{t("tools.phraseNew")}</button>
        </div>
      )}

      {/* 编辑 / 新增弹窗（560 那档）：名称 + 标签（从清单里选）并排，内容 5 行；底部左侧一句提示 + 取消 / 保存。 */}
      {modal ? (
        <Modal width={560} title={modal.id ? t("tools.phraseEditTitle") : t("tools.phraseNew")}
          onClose={() => setModal(null)}
          footer={<>
            <span className="flex-1 min-w-0 text-[11px] text-faint leading-[1.6]">{t("phrases.pickTagHint")}</span>
            <button className={btn("ghost")} onClick={() => setModal(null)}>{t("common.cancel")}</button>
            <button className={btn("primary")} disabled={!modalValid} onClick={commitModal}>{t("common.save")}</button>
          </>}>
          <div className="flex gap-[12px]">
            <label className="flex flex-col gap-[6px]" style={{ flex: "1 1 220px", minWidth: 180 }}>
              <span className={fieldLabel}>{t("settings.phraseName")}</span>
              <input autoFocus value={modal.name} onChange={(e) => setModal({ ...modal, name: e.target.value })}
                placeholder={t("settings.phraseName")} className={`w-full ${field("card")}`} />
            </label>
            <label className="flex flex-col gap-[6px]" style={{ flex: "0 0 160px" }}>
              <span className={fieldLabel}>{t("phrases.tagLabel")}</span>
              <select value={modal.tag} onChange={(e) => setModal({ ...modal, tag: e.target.value })} className={`w-full ${selectCls()}`}>
                <option value="">{t("phrases.noTag")}</option>
                {tags.map((tg) => <option key={tg} value={tg}>{tg}</option>)}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-[6px]">
            <span className={fieldLabel}>{t("phrases.content")}</span>
            <textarea rows={5} value={modal.content} onChange={(e) => setModal({ ...modal, content: e.target.value })}
              placeholder={t("tools.phraseContentPh")} className={`w-full ${textareaCls("card")}`} />
          </label>
        </Modal>
      ) : null}

      {/* 换标签（480）：标签下拉 + 主钮「换标签」。选的还是原标签时按钮不亮。 */}
      {retag && retagTarget ? (
        <Modal width={480} title={t("phrases.retagTitle", { name: retagTarget.name })} onClose={() => setRetag(null)}
          footer={<>
            <span className="flex-1" />
            <button className={btn("ghost")} onClick={() => setRetag(null)}>{t("common.cancel")}</button>
            <button className={btn("primary")} disabled={!retagChanged} onClick={commitRetag}>{t("phrases.retag")}</button>
          </>}>
          <select autoFocus value={retag.tag} onChange={(e) => setRetag({ ...retag, tag: e.target.value })} className={`w-full ${selectCls()}`}>
            <option value="">{t("phrases.untagged")}</option>
            {tags.map((tg) => <option key={tg} value={tg}>{tg}</option>)}
          </select>
        </Modal>
      ) : null}

      {/* 右键菜单 168：编辑 ｜ 复制全文 ｜ 换标签 ｜ — ｜ 删除（红字）。 */}
      {menu && menuTarget ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { label: t("common.edit"), icon: <GlyphPencil size={13} />, onClick: () => openEdit(menuTarget) },
          { label: t("phrases.copyFull"), icon: <GlyphCopy size={13} />, onClick: () => { void copy(menuTarget); } },
          { label: t("phrases.retag"), icon: <IconPhrase size={13} />, onClick: () => setRetag({ id: menuTarget.id, tag: tagOf(menuTarget) }) },
          { divider: true },
          { label: t("common.delete"), danger: true, icon: <IconTrash size={13} />, onClick: () => { void askDelete(menuTarget.id); } },
        ]} />
      ) : null}
    </PageShell>
  );
}
