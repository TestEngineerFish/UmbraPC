// 能力页（React + Tailwind）。设备真实 Provider + 启用开关 + 自定义程序增删改（含轻量覆盖），逻辑不变。
// 批次 012 起套页面骨架的 **T1 列表 + 详情（卡片密度）**：
//   页头：「能力 · 本机真实能力 · 设备 xxx」+ 主按钮「新增程序」+ 齿轮 → 能力设置（T3，放 CapSection）
//   左列表 400：一列 Provider 卡（图标 / 名称 / 状态 / 启用开关 / 技能 chips），选中态由 ListCard 管
//   右详情常驻：选中一张看它的技能清单（名 + 说明 + 参数占位）与「编辑 / 删除」；编辑 / 新增自定义程序的
//   表单也在这一栏里 —— 原来的 460 右侧抽屉（遮罩 + 面板）作废，并入分栏。未选中时由 ListDetail 画占位。
//   原来滚动容器里的弱头（h1 + 灰字 + 「新增」小钮）一并上移到页头。
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as desktop from "../../services/desktop";
import * as legacy from "../../app/shell";
import type { ProviderManifest, CustomProviderCfg } from "../../services/desktop";
import { btn, chip, field, fieldLabel, Toggle, EmptyState } from "../../components/ui";
import { PageShell, ListDetail, CardList, ListCard, DetailHead, SectionHeader, SettingsPage, SettingsSection } from "../../components/layout";
import { CapSection } from "../settings/sections";
import { askConfirm, showToast } from "../../components/overlay";
import { IconBrackets, IconPrompt, IconVideo, IconMonitor, IconWindow, IconGrid } from "../../components/icons";

// provider → 图标。五张示例卡的取值照抄设计稿（1842 / 1856 / 1868 / 1882 / 1895）。
// 认不出来的（用户自己加的程序）落到通用的方块图标，**不留字符兜底** ——
// 之前所有卡共用一个「▤」，撞了「图标只用线性描边」这条硬规则。
const PROVIDER_ICON: Record<string, (p: { size?: number }) => JSX.Element> = {
  agent: IconBrackets,     // 编码代理（claude / codex 引擎）
  codex: IconPrompt,
  system: IconWindow,
  ffmpeg: IconVideo,
  computer: IconMonitor,   // 电脑操作
};
function providerIcon(provider: string) {
  return PROVIDER_ICON[provider] || IconGrid;
}

interface SkillForm {
  skill: string;
  description: string;
  command: string;
  confirm: boolean;
}
interface ProvForm {
  open: boolean;
  light: boolean;
  original: string | null;
  provider: string;
  display_name: string;
  detect: string;
  skills: SkillForm[];
}
const EMPTY_SKILL: SkillForm = { skill: "", description: "", command: "", confirm: false };
const CLOSED: ProvForm = { open: false, light: false, original: null, provider: "", display_name: "", detect: "", skills: [{ ...EMPTY_SKILL }] };

function hasCommandSkill(cfg?: CustomProviderCfg): boolean {
  return !!cfg && Object.values(cfg.skills || {}).some((s) => (s.command?.length ?? 0) > 0);
}

// 卡片副行与详情头副行共用的状态文案：停用 > 可用（版本 / 系统内置 / 已就绪）> 不可用原因。
type T = (k: string, o?: Record<string, unknown>) => string;
function providerStatus(m: ProviderManifest, enabled: boolean, t: T): string {
  return !enabled ? t("abilities.disabled") : m.available ? (m.version ? `v${m.version}` : m.kind === "system" ? t("abilities.systemBuiltin") : t("abilities.ready")) : m.unavailable_reason || t("abilities.unavailable");
}

export function Abilities() {
  const { t } = useTranslation();
  const [form, setForm] = useState<ProvForm>(CLOSED);
  // 列表里选中的 Provider（右侧看详情）。编辑态下高亮跟着表单走（form.original），新增时没有高亮。
  const [selected, setSelected] = useState<string | null>(null);
  const ds = desktop.getDeviceState();

  if (!desktop.isDesktop() || !ds) {
    return (
      <PageShell header={{ title: t("abilities.title") }}>
        <EmptyState title={t("abilities.notReady")} />
      </PageShell>
    );
  }

  const openAdd = () => setForm({ open: true, light: false, original: null, provider: "", display_name: "", detect: "", skills: [{ ...EMPTY_SKILL }] });
  const openEdit = (prov: string) => {
    const e = desktop.getCustomProviders().find((p) => p.provider === prov);
    if (e && hasCommandSkill(e)) {
      const skills = Object.entries(e.skills || {}).map(([k, v]) => ({ skill: k, description: v.description || "", command: (v.command || []).join(" "), confirm: !!v.confirm }));
      setForm({ open: true, light: false, original: prov, provider: e.provider, display_name: e.display_name || "", detect: e.detect || "", skills: skills.length ? skills : [{ ...EMPTY_SKILL }] });
    } else {
      const m = ds.providers.find((p) => p.provider === prov);
      setForm({ open: true, light: true, original: prov, provider: prov, display_name: e?.display_name || m?.display_name || "", detect: e?.detect || "", skills: [] });
    }
  };
  const save = () => {
    const provider = form.provider.trim();
    if (!provider) return;
    let entry: CustomProviderCfg;
    if (form.light) {
      entry = { provider, display_name: form.display_name.trim() || undefined, detect: form.detect.trim() || undefined };
    } else {
      const skills: CustomProviderCfg["skills"] = {};
      for (const s of form.skills) {
        const name = s.skill.trim();
        const cmd = s.command.trim();
        if (name && cmd) skills![name] = { description: s.description.trim(), params: {}, command: cmd.split(/\s+/), confirm: !!s.confirm };
      }
      if (Object.keys(skills!).length === 0) return;
      entry = { provider, display_name: form.display_name.trim() || undefined, detect: form.detect.trim() || undefined, skills };
    }
    legacy.saveCustomProviderEntry(entry, form.original);
    setForm(CLOSED);
  };

  // 选中项被删掉（或设备重注册后不在了）时退回占位，不留一个指向空的详情。
  const selM = selected ? ds.providers.find((p) => p.provider === selected) : undefined;
  // 裁定 8（tokens.pageTemplate.shared.emptyHeaderPrimary）：真空态时页头不渲染「新增程序」，橙留给空态里那颗。
  // 本页没有搜索 / 筛选，「一张卡都没有」只有一种来源要区分：providers 是设备引擎注册成功那一刻才填进来的
  // （deviceTransport：拿到注册信息 → 发 register → 服务端回 registered 才转 online），所以
  //   status 不是 online && 没 provider = 还没就绪 / 离线 —— 不是真空，主按钮照常在；
  //   status 是 online && 没 provider = 引擎注册了但一个 Provider 都没有 —— 真空，主按钮让给空态里那颗。
  const blank = ds.status === "online" && !ds.providers.length;

  return (
    <PageShell
      header={{
        title: t("abilities.title"),
        subtitle: t("abilities.deviceHint", { name: ds.deviceName }),
        // 表单开着时主按钮**不出现**：详情列里的「保存」就是这一页唯一的橙实心（骨架规矩：一页只准一颗），
        // 灰掉的主按钮也还是第二颗；原来的抽屉带遮罩，开着时本来就点不到「新增」。
        primary: form.open || blank ? undefined : { label: t("abilities.addProgram"), onClick: () => { setSelected(null); openAdd(); } },
      }}
      settings={{
        title: t("abilities.settingsTitle"),
        backLabel: t("abilities.backLabel"),
        content: (
          <SettingsPage>
            <SettingsSection title={t("settings.secCap")} desc={t("settings.secCapDesc")}>
              <CapSection />
            </SettingsSection>
          </SettingsPage>
        ),
      }}>
      <ListDetail
        listEmpty={!ds.providers.length}
        list={ds.providers.length ? (<>
          <CardList>
            {ds.providers.map((m) => (
              <ProviderCard key={m.provider} m={m}
                selected={form.open ? form.original === m.provider : selected === m.provider}
                // 点的正是在编辑的那张：什么都不做，别把写了一半的表单丢掉。
                onOpen={() => { if (form.open && form.original === m.provider) return; setForm(CLOSED); setSelected(m.provider); }} />
            ))}
          </CardList>
          <div className="px-[14px] pb-[14px] text-[11px] text-faint leading-[1.6]">{t("abilities.footer")}</div>
        </>) : (
          // 真空态（引擎在线但没 Provider）时「新增程序」从页头挪到这里（裁定 8）；没就绪 / 离线时不给 ——
          // 那时页头的主按钮还在。表单开着时也不给：详情列里的「保存」已经是这一页那颗橙。
          <EmptyState compact title={t("abilities.notReady")}
            actionLabel={blank && !form.open ? t("abilities.addProgram") : undefined}
            onAction={() => { setSelected(null); openAdd(); }} />
        )}
        detail={form.open ? (
          <ProvEditor form={form} setForm={setForm} onSave={save} onCancel={() => setForm(CLOSED)} />
        ) : selM ? (
          <ProviderDetail m={selM} onEdit={() => openEdit(selM.provider)} />
        ) : null}
      />
    </PageShell>
  );
}

// 列表里的一张 Provider 卡（卡片密度）。选中态照骨架件：1px --orange + --orange-soft。
function ProviderCard({ m, selected, onOpen }: { m: ProviderManifest; selected: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const enabled = !desktop.isProviderDisabled(m.provider);
  const isCustom = hasCommandSkill(desktop.getCustomProviders().find((p) => p.provider === m.provider));
  const Ico = providerIcon(m.provider);
  const skills = Object.keys(m.skills || {});

  return (
    <ListCard selected={selected} onClick={onOpen}>
      <div className={enabled && !m.available ? "opacity-70" : ""}>
        <div className="flex items-center gap-[11px]">
          <span className="w-[32px] h-[32px] rounded-[9px] bg-orange-soft text-orange-text flex items-center justify-center flex-none">
            <Ico size={17} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold truncate">
              {m.display_name || m.provider}
              {isCustom ? <span className="text-[10.5px] text-muted font-normal ml-1">{t("abilities.custom")}</span> : null}
            </div>
            <div className="text-[11.5px] text-muted truncate">{providerStatus(m, enabled, t)}</div>
          </div>
          {/* 开关是卡内动作，点它不算「看详情」—— 拦掉冒泡，别顺手把卡选中。 */}
          <span className="flex-none flex" onClick={(e) => e.stopPropagation()}>
            <Toggle on={enabled} onClick={() => legacy.toggleProviderEnabled(m.provider)} />
          </span>
        </div>
        {skills.length ? (
          <div className="flex flex-wrap gap-[6px] mt-[9px]">
            {skills.map((s) => <span key={s} className={`${chip()} font-mono`}>{s}</span>)}
          </div>
        ) : null}
      </div>
    </ListCard>
  );
}

// 右侧详情（只读）：详情头 = 图标 + 名称 + 「标识 · 状态」，右上角 编辑 / 删除（只有 program 类可编辑，
// 只有带命令技能的自定义程序可删 —— 和原来卡片上那两颗小钮的出现条件一字不差）；
// 下面按分区列技能：技能名等宽 + 参数占位 chips（悬停看参数说明）+ 说明文字。
function ProviderDetail({ m, onEdit }: { m: ProviderManifest; onEdit: () => void }) {
  const { t } = useTranslation();
  const enabled = !desktop.isProviderDisabled(m.provider);
  const cfgEntry = desktop.getCustomProviders().find((p) => p.provider === m.provider);
  const isCustom = hasCommandSkill(cfgEntry);
  const canEdit = m.kind === "program";
  const Ico = providerIcon(m.provider);
  const skills = Object.entries(m.skills || {});
  const name = m.display_name || m.provider;

  return (<>
    <DetailHead
      lead={<span className="w-[24px] h-[24px] rounded-[7px] bg-orange-soft text-orange-text flex items-center justify-center"><Ico size={14} /></span>}
      title={<>{name}{isCustom ? <span className="ml-[6px] text-[11px] text-muted font-normal">{t("abilities.custom")}</span> : null}</>}
      sub={<><span className="font-mono">{m.provider}</span> · {providerStatus(m, enabled, t)}</>}
      actions={canEdit ? (<>
        <button className={btn("ghost", "sm")} onClick={onEdit}>{t("common.edit")}</button>
        {isCustom ? (
          // 破坏性动作：描边红，放详情头（不进页头主按钮位）。
          <button className={btn("danger", "sm")} onClick={() => void askConfirm({
            message: t("abilities.deleteConfirm", { name }),
            confirmText: t("common.delete"),
            danger: true,
          }).then((ok) => { if (ok) { legacy.deleteCustomProvider(m.provider); showToast(t("abilities.deleted", { name }), { tone: "ok" }); } })}>{t("common.delete")}</button>
        ) : null}
      </>) : undefined}
    />
    {/* SectionHeader 自带 14 的横向内距，外层再给 6 → 和详情头的 20 对齐。 */}
    <div className="flex-1 min-h-0 overflow-y-auto p-[6px_6px_28px]">
      <SectionHeader count={skills.length}>{t("abilities.secSkills")}</SectionHeader>
      <div className="px-[14px]">
        {skills.length ? (
          <div className="bg-card border border-border rounded-[11px] px-[14px] max-w-[600px]">
            {skills.map(([k, s]) => {
              const params = Object.keys(s.params || {});
              return (
                <div key={k} className="py-[10px] border-b border-border-soft last:border-b-0">
                  <div className="flex flex-wrap items-center gap-[6px]">
                    <span className="text-[12.5px] font-medium font-mono mr-[2px]">{k}</span>
                    {params.map((p) => <span key={p} className={`${chip()} font-mono`} title={s.params[p]}>{`{${p}}`}</span>)}
                  </div>
                  {s.description ? <div className="text-[11.5px] text-muted mt-[3px] leading-[1.6]">{s.description}</div> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-[12.5px] text-muted">{t("common.none")}</div>
        )}
      </div>
    </div>
  </>);
}

// 走工厂：之前这行是自己拼的近似值（圆角 8、无 hover、**完全没有聚焦态**），
// 换成 field() 之后跟着设计稿走 —— 高 32 / 圆角 7 / 聚焦描边转橙 + 3px 橙软光环。
// 表单落在 --card 卡里，所以输入框用 --bg 底（kit 的规矩：卡里用 bg，弹窗里才用 card）。
const inp = `w-full ${field("bg")}`;

// 表单字段：统一的字段标签（kit.fieldLabel）+ 控件，竖排 5px 间距。
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-[5px]">
      <span className={fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

// 编辑 / 新增自定义程序的表单 —— 原来是 460 宽的右侧抽屉，现在是详情列里的常驻内容：
// 详情头放标题（编辑程序 / 新增程序）+ 取消 / 保存，下面滚动区铺表单（基本信息一张卡，技能逐张卡）。
function ProvEditor({ form, setForm, onSave, onCancel }: { form: ProvForm; setForm: (f: ProvForm) => void; onSave: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const set = (patch: Partial<ProvForm>) => setForm({ ...form, ...patch });
  const setSkill = (i: number, patch: Partial<SkillForm>) => set({ skills: form.skills.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  return (<>
    <DetailHead
      title={form.original ? t("abilities.editProgram") : t("abilities.addProgramTitle")}
      sub={form.original ? <span className="font-mono">{form.original}</span> : undefined}
      actions={<>
        <button className={btn("ghost", "sm")} onClick={onCancel}>{t("common.cancel")}</button>
        <button className={btn("primary", "sm")} onClick={onSave}>{t("common.save")}</button>
      </>}
    />
    <div className="flex-1 min-h-0 overflow-y-auto p-[16px_20px_28px]">
      <div className="max-w-[560px] flex flex-col gap-[14px]">
        {form.light ? <div className="text-[12px] text-muted bg-chip rounded-[8px] p-[9px_11px] leading-[1.5]">{t("abilities.builtinHint")}</div> : null}
        <div className="bg-card border border-border rounded-[12px] p-[16px] flex flex-col gap-[12px]">
          <Field label={t("abilities.providerId")}>
            <input value={form.provider} onChange={(e) => set({ provider: e.target.value })} readOnly={!!form.original} placeholder={t("abilities.providerIdPh")} className={`${inp} ${form.original ? "opacity-60" : ""}`} />
          </Field>
          <Field label={t("abilities.displayName")}>
            <input value={form.display_name} onChange={(e) => set({ display_name: e.target.value })} placeholder={t("abilities.displayNamePh")} className={inp} />
          </Field>
          <Field label={t("abilities.detectCmd")}>
            <input value={form.detect} onChange={(e) => set({ detect: e.target.value })} placeholder={t("abilities.detectCmdPh")} className={inp} />
          </Field>
        </div>

        {!form.light ? (
          <>
            <div className="text-[12px] text-muted font-semibold leading-[1.5]">{t("abilities.skills")}</div>
            {form.skills.map((s, i) => (
              <div key={i} className="bg-card border border-border rounded-[12px] p-[14px] flex flex-col gap-[8px]">
                <div className="flex justify-between items-center">
                  <span className={fieldLabel}>{t("abilities.skillN", { n: i + 1 })}</span>
                  {form.skills.length > 1 ? <button onClick={() => set({ skills: form.skills.filter((_, j) => j !== i) })} className="border-0 bg-transparent text-danger cursor-pointer text-[12px]">{t("common.delete")}</button> : null}
                </div>
                <input value={s.skill} onChange={(e) => setSkill(i, { skill: e.target.value })} placeholder={t("abilities.skillNamePh")} className={inp} />
                <input value={s.description} onChange={(e) => setSkill(i, { description: e.target.value })} placeholder={t("abilities.skillDescPh")} className={inp} />
                <input value={s.command} onChange={(e) => setSkill(i, { command: e.target.value })} placeholder={t("abilities.skillCmdPh")} className={`${inp} font-mono`} />
                <label className="flex items-center gap-[6px] text-[12px] text-muted cursor-pointer select-none">
                  <input type="checkbox" className="accent-orange" checked={s.confirm} onChange={(e) => setSkill(i, { confirm: e.target.checked })} />
                  {t("abilities.confirmBeforeRun")}
                </label>
              </div>
            ))}
            <button onClick={() => set({ skills: [...form.skills, { ...EMPTY_SKILL }] })} className="w-full h-[32px] border border-dashed border-border bg-transparent text-muted rounded-[8px] text-[12.5px] cursor-pointer hover:border-orange hover:text-orange-text">{t("abilities.addSkill")}</button>
          </>
        ) : null}
      </div>
    </div>
  </>);
}
