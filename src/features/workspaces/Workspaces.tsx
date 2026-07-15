// 工作区页（React + Tailwind）：展示所有工作区（名字/路径/描述/任务数/来源/最后活动），
// 支持手动新增（可自定义路径）、编辑描述、移除（可勾选「同时移除文件」）。
// 工作区是服务端注册表（tasks 靠 project_id 引用），这里全部走 REST 读写。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchWorkspaces, createWorkspace, deleteWorkspace } from "../../services/server";
import type { Workspace } from "../../services/server";
import { getState } from "../../services/deviceTransport";

export function Workspaces() {
  const { t } = useTranslation();
  const [list, setList] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", dir: "", description: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // 移除弹框：{ws, purge}
  const [removing, setRemoving] = useState<Workspace | null>(null);
  const [purge, setPurge] = useState(false);

  async function load(spin = false) {
    if (spin) setRefreshing(true);
    const rows = await fetchWorkspaces();
    setList(rows);
    setLoading(false);
    if (spin) setRefreshing(false);
  }

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load(), 4000);
    return () => window.clearInterval(timer);
  }, []);

  async function submitAdd() {
    const name = form.name.trim();
    if (!name) return;
    const deviceId = getState().deviceId;
    if (!deviceId) { setErr(t("workspaces.notConnected")); return; }
    setBusy(true);
    setErr("");
    const r = await createWorkspace(name, deviceId, form.dir.trim() || undefined, form.description.trim() || undefined);
    setBusy(false);
    if ("error" in r) { setErr(r.error); return; }
    setAdding(false);
    setForm({ name: "", dir: "", description: "" });
    load();
  }

  async function openFolder(dir: string) {
    if (!window.umbra) { setErr(t("workspaces.openNonDesktop")); return; }
    const res = await window.umbra.openPath(dir);
    if (res) setErr(t("workspaces.openFailed", { reason: res }));  // "" = 成功；非空 = 错误
  }

  async function doRemove() {
    if (!removing) return;
    setBusy(true);
    const res = await deleteWorkspace(removing.id, purge);
    setBusy(false);
    setRemoving(null);
    setPurge(false);
    if (res && purge && res.purge_error) {
      // 记录被删了，但文件没删掉（设备离线等）——提示一下。
      setErr(t("workspaces.purgeFailed", { reason: res.purge_error }));
    }
    load();
  }

  const btn = "px-3 py-1.5 border border-border bg-card text-text rounded-lg text-[12.5px] cursor-pointer";
  const input = "w-full box-border border border-border bg-bg text-text rounded-lg px-3 py-2 text-[13px] outline-none";

  return (
    <div className="h-full overflow-y-auto p-[18px_22px]">
      <div className="flex items-center justify-between mb-4">
        <h1 className="m-0 text-[16px] font-semibold">{t("workspaces.title")}</h1>
        <div className="flex items-center gap-2">
          <button onClick={() => { setAdding(!adding); setErr(""); }} className={btn}>
            {adding ? t("common.cancel") : t("workspaces.add")}
          </button>
          <button onClick={() => load(true)} className={`flex items-center gap-1.5 ${btn}`}>
            <span className={refreshing ? "inline-block animate-spin" : ""}>↻</span>
            {refreshing ? t("common.refreshing") : t("common.refresh")}
          </button>
        </div>
      </div>

      {adding ? (
        <div className="mb-4 bg-card border border-border rounded-xl p-4 flex flex-col gap-2.5">
          <input className={input} placeholder={t("workspaces.namePlaceholder")}
            value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className={`${input} font-mono text-[12px]`} placeholder={t("workspaces.pathPlaceholder")}
            value={form.dir} onChange={(e) => setForm({ ...form, dir: e.target.value })} />
          <input className={input} placeholder={t("workspaces.descPlaceholder")}
            value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          {err ? <div className="text-[12px] text-danger">{err}</div> : null}
          <div className="flex gap-2 justify-end">
            <button onClick={() => setAdding(false)} className={btn}>{t("common.cancel")}</button>
            <button onClick={submitAdd} disabled={busy || !form.name.trim()}
              className={`px-3 py-1.5 rounded-lg text-[12.5px] font-semibold ${form.name.trim() ? "bg-orange text-white cursor-pointer" : "bg-chip text-muted cursor-not-allowed"}`}>
              {t("common.save")}
            </button>
          </div>
        </div>
      ) : null}

      {!adding && err ? <div className="mb-3 text-[12px] text-danger">{err}</div> : null}

      <div className="flex flex-col gap-2.5">
        {loading ? (
          <div className="text-muted text-[13px] py-8 text-center">{t("common.loading")}</div>
        ) : list.length ? (
          list.map((w) => (
            <div key={w.id} className="bg-card border border-border rounded-xl px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-semibold text-[14px] truncate">{w.name}</span>
                  <span className={`px-[8px] py-[1px] rounded-full text-[10.5px] shrink-0 ${w.origin === "manual" ? "bg-chip text-muted" : "bg-orange-soft text-orange-text"}`}>
                    {w.origin === "manual" ? t("workspaces.originManual") : t("workspaces.originAuto")}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {w.dir ? (
                    <button onClick={() => openFolder(w.dir!)} className="text-orange-text text-[12px]">
                      {t("workspaces.openFolder")}
                    </button>
                  ) : null}
                  <button onClick={() => { setRemoving(w); setPurge(false); }} className="text-danger text-[12px]">
                    {t("workspaces.remove")}
                  </button>
                </div>
              </div>
              {w.dir ? (
                <button onClick={() => openFolder(w.dir!)} title={t("workspaces.openFolder")}
                  className="mt-1 font-mono text-[11.5px] text-muted break-all text-left hover:text-orange-text cursor-pointer">
                  {w.dir}
                </button>
              ) : <div className="mt-1 text-[11.5px] text-muted">{t("workspaces.pathPending")}</div>}
              {w.description ? <div className="mt-1.5 text-[12.5px] text-text">{w.description}</div> : null}
              <div className="mt-1.5 text-[11.5px] text-muted">
                {t("workspaces.taskCount", { count: w.task_count })}
                {w.last_goal ? ` · ${t("workspaces.last")}: ${w.last_goal}` : ""}
              </div>
            </div>
          ))
        ) : (
          <div className="text-muted text-[13px] py-8 text-center">{t("workspaces.empty")}</div>
        )}
      </div>

      {removing ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setRemoving(null)}>
          <div className="bg-card border border-border rounded-xl p-5 w-[340px] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
            <div className="font-semibold text-[14px] mb-1">{t("workspaces.removeTitle")}</div>
            <div className="text-[12.5px] text-muted mb-3">{t("workspaces.removeHint", { name: removing.name })}</div>
            <label className="flex items-start gap-2 text-[12.5px] cursor-pointer mb-4">
              <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} className="mt-0.5" />
              <span>{t("workspaces.purgeLabel")}<span className="block text-[11px] text-muted mt-0.5">{t("workspaces.purgeHint")}</span></span>
            </label>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setRemoving(null)} className={btn}>{t("common.cancel")}</button>
              <button onClick={doRemove} disabled={busy}
                className="px-3 py-1.5 rounded-lg text-[12.5px] font-semibold bg-danger text-white cursor-pointer">
                {purge ? t("workspaces.confirmRemovePurge") : t("workspaces.confirmRemove")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
