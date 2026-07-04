// 能力页（React + Tailwind）。设备真实 Provider 卡片 + 启用开关 + 自定义程序增删改（含轻量覆盖）。
import { useState } from "react";
import * as desktop from "../services/desktop";
import * as legacy from "../app/shell";
import type { ProviderManifest, CustomProviderCfg } from "../services/desktop";

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

export function Abilities() {
  const [form, setForm] = useState<ProvForm>(CLOSED);
  const ds = desktop.getDeviceState();

  if (!desktop.isDesktop() || !ds) {
    return (
      <div className="h-full overflow-y-auto p-[18px_22px]">
        <h1 className="m-0 mb-4 text-[16px] font-semibold">能力</h1>
        <div className="text-muted p-10 text-center">设备引擎未就绪或暂无 Provider。</div>
      </div>
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

  return (
    <div className="h-full overflow-y-auto p-[18px_22px] relative">
      <div className="flex items-center justify-between mb-4 gap-3">
        <div className="flex items-baseline gap-2.5">
          <h1 className="m-0 text-[16px] font-semibold">能力</h1>
          <span className="text-[12px] text-muted">本机真实能力 · 设备 {ds.deviceName}</span>
        </div>
        <button onClick={openAdd} className="flex items-center gap-1.5 px-[13px] py-1.5 border border-border bg-card text-text rounded-lg text-[13px] cursor-pointer shrink-0">＋ 新增程序</button>
      </div>

      <div className="grid grid-cols-2 gap-[13px]">
        {ds.providers.map((m) => (
          <ProviderCard key={m.provider} m={m} onEdit={() => openEdit(m.provider)} />
        ))}
      </div>

      <div className="mt-3.5 text-[11.5px] text-muted">内置程序装了就自动可用；开关可停用不想让 AI 用的程序。自定义程序（providers.json）可编辑/删除，或点「新增程序」添加，无需手写 JSON。</div>

      {form.open ? <ProvModal form={form} setForm={setForm} onSave={save} onCancel={() => setForm(CLOSED)} /> : null}
    </div>
  );
}

function ProviderCard({ m, onEdit }: { m: ProviderManifest; onEdit: () => void }) {
  const enabled = !desktop.isProviderDisabled(m.provider);
  const cfgEntry = desktop.getCustomProviders().find((p) => p.provider === m.provider);
  const isCustom = hasCommandSkill(cfgEntry);
  const canEdit = m.kind === "program";
  const status = !enabled ? "已停用" : m.available ? (m.version ? `v${m.version}` : m.kind === "system" ? "系统内置" : "已就绪") : m.unavailable_reason || "不可用";

  return (
    <div className={`bg-card border border-border rounded-xl p-[15px] ${enabled && !m.available ? "opacity-70" : ""}`}>
      <div className="flex items-center gap-[11px] mb-3">
        <span className="w-[34px] h-[34px] rounded-[9px] bg-orange-soft text-orange-text flex items-center justify-center shrink-0">▤</span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold">
            {m.display_name || m.provider}
            {isCustom ? <span className="text-[10.5px] text-muted font-normal ml-1">自定义</span> : null}
          </div>
          <div className="text-[11.5px] text-muted">{status}</div>
        </div>
        <Toggle on={enabled} onClick={() => legacy.toggleProviderEnabled(m.provider)} />
      </div>
      <div className="flex flex-wrap gap-1.5 items-center">
        {Object.keys(m.skills || {}).map((s) => (
          <span key={s} className="px-[9px] py-[3px] rounded-full bg-chip text-[11.5px] text-muted font-mono">{s}</span>
        ))}
        {canEdit ? (
          <>
            <span className="flex-1" />
            <button onClick={onEdit} className="px-2.5 py-[3px] border border-border bg-transparent text-text rounded-md text-[11.5px] cursor-pointer">编辑</button>
            {isCustom ? <button onClick={() => legacy.deleteCustomProvider(m.provider)} className="px-2.5 py-[3px] border border-danger bg-transparent text-danger rounded-md text-[11.5px] cursor-pointer">删除</button> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`w-[36px] h-[21px] rounded-full p-[2px] flex shrink-0 transition-colors ${on ? "justify-end bg-orange" : "justify-start bg-border"}`}>
      <span className="w-[17px] h-[17px] rounded-full bg-white shadow" />
    </button>
  );
}

const inp = "w-full border border-border bg-bg text-text rounded-lg px-2.5 py-[7px] text-[13px] outline-none box-border";

function ProvModal({ form, setForm, onSave, onCancel }: { form: ProvForm; setForm: (f: ProvForm) => void; onSave: () => void; onCancel: () => void }) {
  const set = (patch: Partial<ProvForm>) => setForm({ ...form, ...patch });
  const setSkill = (i: number, patch: Partial<SkillForm>) => set({ skills: form.skills.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  return (
    <>
      <div onClick={onCancel} className="absolute inset-0 bg-black/30 z-30" />
      <div className="absolute top-0 right-0 bottom-0 w-[460px] bg-card border-l border-border z-[31] flex flex-col">
        <div className="flex items-center justify-between p-[15px_20px] border-b border-border">
          <div className="font-semibold text-[15px]">{form.original ? "编辑程序" : "新增程序"}</div>
          <button onClick={onCancel} className="border-0 bg-transparent text-muted cursor-pointer text-[20px] leading-none">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-[18px_20px]">
          {form.light ? <div className="text-[12px] text-muted bg-chip rounded-lg p-[9px_11px] mb-3.5 leading-[1.5]">内置程序：仅可覆盖显示名与检测命令，执行仍走内置逻辑（引擎选择 / 隔离目录等），因此不提供技能命令编辑。</div> : null}
          <label className="text-[12px] text-muted">程序标识（provider，英文小写）</label>
          <input value={form.provider} onChange={(e) => set({ provider: e.target.value })} readOnly={!!form.original} placeholder="如 ffmpeg" className={`${inp} my-[5px_0_12px] ${form.original ? "opacity-60" : ""}`} />
          <label className="text-[12px] text-muted">显示名</label>
          <input value={form.display_name} onChange={(e) => set({ display_name: e.target.value })} placeholder="如 FFmpeg" className={`${inp} my-[5px_0_12px]`} />
          <label className="text-[12px] text-muted">检测命令（可选，用 which 判断是否安装，留空视为始终可用）</label>
          <input value={form.detect} onChange={(e) => set({ detect: e.target.value })} placeholder="如 ffmpeg" className={`${inp} my-[5px_0_14px]`} />

          {!form.light ? (
            <>
              <div className="text-[12px] text-muted font-semibold mb-2">技能（命令用 {"{参数名}"} 占位，AI 只能填参数、不能改命令本身）</div>
              {form.skills.map((s, i) => (
                <div key={i} className="border border-border rounded-[10px] p-[11px] mb-[9px]">
                  <div className="flex justify-between items-center mb-[7px]">
                    <span className="text-[12px] text-muted font-semibold">技能 {i + 1}</span>
                    {form.skills.length > 1 ? <button onClick={() => set({ skills: form.skills.filter((_, j) => j !== i) })} className="border-0 bg-transparent text-danger cursor-pointer text-[12px]">删除</button> : null}
                  </div>
                  <input value={s.skill} onChange={(e) => setSkill(i, { skill: e.target.value })} placeholder="技能名，如 to_gif" className={`${inp} mb-1.5`} />
                  <input value={s.description} onChange={(e) => setSkill(i, { description: e.target.value })} placeholder="说明（给 AI 看的）" className={`${inp} mb-1.5`} />
                  <input value={s.command} onChange={(e) => setSkill(i, { command: e.target.value })} placeholder="命令模板(空格分隔)，如 ffmpeg -y -i {input} {output}" className={`${inp} font-mono mb-1.5`} />
                  <label className="flex items-center gap-1.5 text-[12px] text-muted">
                    <input type="checkbox" checked={s.confirm} onChange={(e) => setSkill(i, { confirm: e.target.checked })} />执行前需确认
                  </label>
                </div>
              ))}
              <button onClick={() => set({ skills: [...form.skills, { ...EMPTY_SKILL }] })} className="w-full p-2 border border-dashed border-border bg-transparent text-muted rounded-lg text-[12.5px] cursor-pointer">+ 添加技能</button>
            </>
          ) : null}
        </div>
        <div className="p-[14px_20px] border-t border-border flex gap-2.5 justify-end">
          <button onClick={onCancel} className="px-4 py-2 border border-border bg-transparent text-text rounded-lg text-[13px] cursor-pointer">取消</button>
          <button onClick={onSave} className="px-4 py-2 bg-orange text-white border-0 rounded-lg text-[13px] font-semibold cursor-pointer">保存</button>
        </div>
      </div>
    </>
  );
}
