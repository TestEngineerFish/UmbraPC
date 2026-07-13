// 设置页（React + Tailwind）。受控输入，不再整页重建 → 根治失焦 / 滚动跳顶。
// 业务逻辑复用 server.ts / desktop.ts 与 main.ts 导出的处理器。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { chatConn, getServerUrl, getDeviceName, getAutoApproveOperate, setAutoApproveOperate } from "../../services/server";
import * as desktop from "../../services/desktop";
import * as legacy from "../../app/shell";
import { SUPPORTED_LOCALES, type Locale } from "../../i18n/locale";
import { changeLocale } from "../../i18n";
import { type WF } from "../launcher/WorkflowEditor";

const hasClip = typeof (window as unknown as { umbraClip?: unknown }).umbraClip !== "undefined";
const hasShot = typeof (window as unknown as { umbraShot?: unknown }).umbraShot !== "undefined";
const hasLauncher = typeof (window as unknown as { umbraLauncher?: unknown }).umbraLauncher !== "undefined";
const hasVault = typeof (window as unknown as { umbraVault?: unknown }).umbraVault !== "undefined";

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="bg-card border border-border rounded-xl p-[16px_18px]">
      <div className="font-semibold mb-[14px]">
        {title}
        {sub ? <span className="text-[12px] text-muted font-normal ml-1.5">{sub}</span> : null}
      </div>
      <div className="flex flex-col gap-[13px]">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-[14px]">
      <label className="w-[120px] text-[13px] text-muted shrink-0">{label}</label>
      {children}
    </div>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`w-[38px] h-[22px] rounded-full p-[2px] flex shrink-0 transition-colors ${on ? "justify-end bg-orange" : "justify-start bg-border"}`}>
      <span className="w-[18px] h-[18px] rounded-full bg-white shadow" />
    </button>
  );
}

const input = "flex-1 border border-border bg-bg text-text rounded-lg px-[11px] py-[7px] text-[13px] outline-none";
const btnGhost = "px-[13px] py-[6px] border border-border bg-transparent text-text rounded-lg text-[12.5px] cursor-pointer";

function StatusDot({ kind }: { kind: "online" | "connecting" | "offline" }) {
  const color = kind === "online" ? "bg-success" : kind === "connecting" ? "bg-warning" : "bg-danger";
  return <span className={`w-2 h-2 rounded-full ${color}`} />;
}

export function Settings() {
  const { t, i18n } = useTranslation();
  const [server, setServer] = useState(getServerUrl());
  const [token, setToken] = useState("");
  const [device, setDevice] = useState(getDeviceName());
  const [glmKey, setGlmKey] = useState("");
  const [clipAutoPaste, setClipAutoPaste] = useState(false);
  const [autoApprove, setAutoApproveState] = useState(getAutoApproveOperate());
  const [skillPolicy, setSkillPolicy] = useState<Record<string, "allow" | "deny">>(
    desktop.getDesktopConfig()?.computerSkillPolicy || {},
  );
  useEffect(() => {
    if (!hasClip) return;
    void (window as unknown as { umbraClip?: { getSettings(): Promise<{ autoPaste?: boolean }> } }).umbraClip?.getSettings().then((s) => setClipAutoPaste(!!s.autoPaste));
  }, []);

  const isDesk = desktop.isDesktop();
  const cs = chatConn.status as "online" | "connecting" | "offline";
  const ds = desktop.getDeviceState();
  const perms = desktop.getPermissions();
  const cfg = desktop.getDesktopConfig();
  const codingMode = legacy.getCodingMode();
  const cuOn = legacy.computerEnabled();
  const clip = legacy.getClipState();
  const shot = legacy.getShotState();

  const currentLocale = (i18n.language || cfg?.locale || "zh-CN") as Locale;
  const csLabel = cs === "online" ? t("conn.online") : cs === "connecting" ? t("conn.connecting") : t("conn.offline");
  const engStatus = (ds?.status || "offline") as "online" | "connecting" | "offline";
  const engLabel = engStatus === "online" ? t("settings.engineRunning") : engStatus === "connecting" ? t("conn.connecting") : t("conn.offline");

  const codingModes = [t("settings.codingGenOnly"), t("settings.codingConfirm"), t("settings.codingDirect")];

  const onLocaleChange = (locale: Locale) => {
    void desktop.pushConfig({ locale }).then(() => changeLocale(locale));
  };

  return (
    <div id="scroll-main" className="h-full overflow-y-auto p-[18px_22px]">
      <h1 className="m-0 mb-4 text-[16px] font-semibold">{t("settings.title")}</h1>
      <div className="flex flex-col gap-[14px] max-w-[680px]">
        <Card title={t("settings.language")}>
          <Row label={t("settings.language")}>
            <select
              value={currentLocale}
              onChange={(e) => onLocaleChange(e.target.value as Locale)}
              className={`${input} cursor-pointer`}
            >
              {SUPPORTED_LOCALES.map(({ value, labelKey }) => (
                <option key={value} value={value}>
                  {t(labelKey)}
                </option>
              ))}
            </select>
          </Row>
        </Card>

        <Card title={t("settings.connection")}>
          <Row label={t("settings.serverUrl")}>
            <input value={server} onChange={(e) => setServer(e.target.value)} className={`${input} font-mono`} />
          </Row>
          <Row label={t("settings.token")}>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={legacy.tokenPlaceholder()} className={`${input} font-mono tracking-widest`} />
          </Row>
          <Row label={t("settings.connStatus")}>
            <span className="inline-flex items-center gap-[7px] text-[13px]">
              <StatusDot kind={cs} />
              {csLabel}
            </span>
            <span className="flex-1" />
            <button className={btnGhost} onClick={() => legacy.applyConnection(server, token, device)}>
              {t("settings.saveReconnect")}
            </button>
          </Row>
        </Card>

        {isDesk ? (
          <Card title={t("settings.deviceEngine")}>
            <Row label={t("settings.engineStatus")}>
              <span className="inline-flex items-center gap-[7px] text-[13px]">
                <StatusDot kind={engStatus} />
                {engLabel}
              </span>
              <span className="flex-1" />
              <span className="text-[12px] text-muted">{t("settings.checkLogs")}</span>
            </Row>
            <Row label={t("settings.availablePrograms")}>
              <span className="text-[13px]">{t("settings.programCount", { count: ds ? ds.providers.filter((p) => p.available).length : 0 })}</span>
            </Row>
            <Row label={t("settings.recentTask")}>
              <span className="text-[12.5px] text-muted">{ds && ds.recentTasks[0] ? `${ds.recentTasks[0].provider}.${ds.recentTasks[0].skill} · ${ds.recentTasks[0].message}` : t("settings.noTask")}</span>
            </Row>
            <Row label={t("settings.recentLogs")}>
              <span className="text-[12px] text-muted font-mono flex-1 break-all">{desktop.getDeviceLogs()[0] || t("settings.noLogs")}</span>
            </Row>
          </Card>
        ) : null}

        <Card title={t("nav.chat")}>
          <div className="flex items-center gap-3 py-1">
            <div className="flex-1">
              <div className="text-[13.5px]">{t("settings.autoApproveOperate")}</div>
              <div className="text-[11.5px] text-muted mt-px">{t("settings.autoApproveOperateHint")}</div>
            </div>
            <Toggle
              on={autoApprove}
              onClick={() => {
                const next = !autoApprove;
                setAutoApproveOperate(next);
                setAutoApproveState(next);
              }}
            />
          </div>
        </Card>

        {isDesk && cuOn ? (
          <Card title={t("settings.computerAuth")} sub={t("settings.computerAuthSub")}>
            {([
              ["open_app", t("settings.skillOpenApp")],
              ["click", t("settings.skillClick")],
              ["type", t("settings.skillType")],
              ["key", t("settings.skillKey")],
              ["scroll", t("settings.skillScroll")],
            ] as const).map(([key, label]) => {
              const cur = skillPolicy[key] || "ask";
              const set = (v: "ask" | "allow" | "deny") => {
                const next = { ...skillPolicy };
                if (v === "ask") delete next[key];
                else next[key] = v;
                setSkillPolicy(next);
                void desktop.pushConfig({ computerSkillPolicy: next });
              };
              return (
                <div key={key} className="flex items-center gap-3 py-1.5">
                  <span className="flex-1 text-[13.5px]">{label}</span>
                  <div className="flex border border-border rounded-lg overflow-hidden">
                    {(["ask", "allow", "deny"] as const).map((v, i) => (
                      <button
                        key={v}
                        onClick={() => set(v)}
                        className={`px-[11px] py-1.5 text-[12px] ${i < 2 ? "border-r border-border" : ""} ${cur === v ? (v === "deny" ? "bg-danger text-white" : v === "allow" ? "bg-orange text-white" : "bg-card text-text") + " font-semibold" : "bg-transparent text-text"}`}
                      >
                        {t(`settings.policy_${v}`)}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </Card>
        ) : null}

        <Card title={t("settings.device")}>
          <Row label={t("settings.deviceId")}>
            <span className="text-[13px] font-mono text-text">{legacy.deviceIdLabel()}</span>
          </Row>
          <Row label={t("settings.deviceName")}>
            <input value={device} onChange={(e) => setDevice(e.target.value)} className={input} />
          </Row>
        </Card>

        <Card title={t("settings.permissions")} sub={t("settings.macos")}>
          <PermRow title={t("settings.accessibility")} desc={t("settings.accessibilityDesc")} granted={perms.accessibility} onGrant={() => desktop.openPrivacy("accessibility")} />
          <PermRow title={t("settings.screenCapture")} desc={t("settings.screenCaptureDesc")} granted={perms.screen === "granted"} onGrant={() => desktop.openPrivacy("screen")} />
          <div className="flex items-center gap-3 py-3">
            <div className="flex-1">
              <div className="text-[13.5px]">{t("settings.computerUse")}</div>
              <div className="text-[11.5px] text-muted mt-px">{t("settings.computerUseDesc")}</div>
            </div>
            <Toggle on={cuOn} onClick={() => legacy.toggleComputerUse()} />
          </div>
        </Card>

        <Card title={t("settings.capabilities")}>
          <Row label={t("settings.providersFile")}>
            <span className="flex-1 text-[12px] font-mono text-muted break-all">{cfg?.providersFile || t("common.desktopOnly")}</span>
            <button className={btnGhost} onClick={() => desktop.openProvidersFile()}>
              {t("settings.edit")}
            </button>
          </Row>
          <Row label={t("settings.codingPerm")}>
            <div className="flex border border-border rounded-lg overflow-hidden">
              {codingModes.map((label, i) => (
                <button key={label} onClick={() => legacy.setCodingMode(i)} className={`px-[13px] py-1.5 text-[12.5px] ${i < 2 ? "border-r border-border" : ""} ${codingMode === i ? "bg-orange text-white font-semibold" : "bg-transparent text-text"}`}>
                  {label}
                </button>
              ))}
            </div>
          </Row>
        </Card>

        {hasClip ? (
          <Card title={t("settings.clipboard")}>
            <Row label={t("settings.clipEnable")}>
              <span className="flex-1 text-[12px] text-muted">{t("settings.clipEnableDesc", { status: clip.enabled ? t("common.enabled") : t("settings.clipHistoryKept") })}</span>
              <Toggle on={clip.enabled} onClick={() => legacy.toggleClipEnabled()} />
            </Row>
            <Row label={t("settings.clipShortcut")}>
              <button onClick={() => legacy.beginShortcutRecording("clip")} className={`flex-1 text-left border rounded-lg px-[11px] py-[7px] text-[13px] font-mono bg-bg text-text ${clip.recording ? "border-orange" : "border-border"}`}>
                {clip.recording ? t("settings.pressShortcut") : clip.shortcut}
              </button>
              <button className={btnGhost} onClick={async () => { await (window as unknown as { umbraClip: { setShortcut(a: string): Promise<unknown> } }).umbraClip.setShortcut("Command+Shift+V"); await legacy.loadClipSettings(); }}>
                {t("common.reset")}
              </button>
            </Row>
            <Row label={t("settings.clipAutoPaste")}>
              <span className="flex-1 text-[12px] text-muted">{t("settings.clipAutoPasteDesc")}</span>
              <Toggle on={clipAutoPaste} onClick={() => { const n = !clipAutoPaste; setClipAutoPaste(n); void (window as unknown as { umbraClip: { setAutoPaste(on: boolean): Promise<unknown> } }).umbraClip.setAutoPaste(n); }} />
            </Row>
            <Row label={t("settings.clipClear")}>
              <span className="flex-1 text-[12px] text-muted">{t("settings.clipClearDesc")}</span>
              <button className="px-[13px] py-[6px] border border-danger text-danger bg-transparent rounded-lg text-[12.5px]" onClick={() => legacy.clearClipHistory()}>
                {t("settings.clipClearBtn")}
              </button>
            </Row>
          </Card>
        ) : null}

        {hasShot ? (
          <Card title={t("settings.screenshot")}>
            <Row label={t("settings.shotEnable")}>
              <span className="flex-1 text-[12px] text-muted">{t("settings.shotEnableDesc", { status: shot.enabled ? t("common.enabled") : t("settings.shotNoShortcut") })}</span>
              <Toggle on={shot.enabled} onClick={() => legacy.toggleShotEnabled()} />
            </Row>
            <Row label={t("settings.shotShortcut")}>
              <button onClick={() => legacy.beginShortcutRecording("shot")} className={`flex-1 text-left border rounded-lg px-[11px] py-[7px] text-[13px] font-mono bg-bg text-text ${shot.recording ? "border-orange" : "border-border"}`}>
                {shot.recording ? t("settings.pressShortcut") : shot.shortcut}
              </button>
              <button className={btnGhost} onClick={async () => { await (window as unknown as { umbraShot: { setShortcut(a: string): Promise<unknown> } }).umbraShot.setShortcut("Command+Control+A"); await legacy.loadShotSettings(); }}>
                {t("common.reset")}
              </button>
            </Row>
            <Row label={t("settings.translateKey")}>
              <input type="password" value={glmKey} onChange={(e) => setGlmKey(e.target.value)} placeholder={shot.hasGlmKey ? t("settings.glmKeySet") : t("settings.glmKeyHint")} className={`${input} font-mono`} />
              <button className={btnGhost} onClick={() => { legacy.setShotGlmKey(glmKey); setGlmKey(""); }}>
                {t("common.save")}
              </button>
            </Row>
          </Card>
        ) : null}

        {hasLauncher ? <LauncherCard /> : null}

        {hasLauncher ? <PhrasesCard /> : null}

        {hasVault ? <VaultCard /> : null}

        <section className="bg-card border border-border rounded-xl p-[16px_18px] flex items-center gap-[14px]">
          <div className="flex-1">
            <div className="font-semibold">{t("settings.about")}</div>
            <div className="text-[12px] text-muted mt-[3px]">{t("settings.aboutDesc")}</div>
          </div>
          <button className={btnGhost}>{t("settings.checkUpdate")}</button>
        </section>
      </div>
    </div>
  );
}

// 快捷入口（Launcher）设置：开关 + 唤起快捷键 + 文件夹书签（用指定软件打开固定文件夹）。自足，直连 IPC。
interface LauncherFolder { name: string; path: string; app?: string }
interface LauncherScript { name: string; keyword?: string; command: string; icon?: string; needsInput?: boolean; output?: "copy" | "none" }
interface Phrase { id: string; name: string; content: string; keyword?: string }
interface LauncherAPI {
  getSettings(): Promise<{ enabled: boolean; shortcut: string; folders: LauncherFolder[]; scripts: LauncherScript[]; registered: boolean; youdaoConfigured: boolean }>;
  setEnabled(enabled: boolean): Promise<void>;
  setShortcut(acc: string): Promise<{ ok: boolean }>;
  setFolders(folders: LauncherFolder[]): Promise<void>;
  setScripts(scripts: LauncherScript[]): Promise<void>;
  setYoudao(appKey: string, secret: string): Promise<void>;
  pickPath(): Promise<string>;
  pickApp(): Promise<string>;
  getWorkflows(): Promise<WF[]>;
  setWorkflows(workflows: WF[]): Promise<void>;
  openWorkflowEditor(): Promise<void>;
  getPhrases(): Promise<Phrase[]>;
  setPhrases(phrases: Phrase[]): Promise<void>;
}

// 浏览器 KeyboardEvent → Electron Accelerator（如 ⌥Space → "Alt+Space"）。未按到主键返回 null。
function toAccelerator(e: KeyboardEvent): string | null {
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
  const mods: string[] = [];
  if (e.metaKey) mods.push("Command");
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  let key: string;
  if (e.key === " ") key = "Space";
  else if (e.key.startsWith("Arrow")) key = e.key.slice(5);
  else if (e.key.length === 1) key = e.key.toUpperCase();
  else key = e.key;
  return [...mods, key].join("+");
}

function LauncherCard() {
  const { t } = useTranslation();
  const api = (window as unknown as { umbraLauncher: LauncherAPI }).umbraLauncher;
  const [enabled, setEnabled] = useState(true);
  const [shortcut, setShortcut] = useState("Alt+Space");
  const [recording, setRecording] = useState(false);
  const [wfCount, setWfCount] = useState(0);

  useEffect(() => {
    void api.getSettings().then((s) => { setEnabled(s.enabled); setShortcut(s.shortcut); });
    const refreshWf = () => void api.getWorkflows().then((w) => setWfCount(w.length));
    refreshWf();
    window.addEventListener("focus", refreshWf);  // 从编辑器窗口切回时刷新计数
    return () => window.removeEventListener("focus", refreshWf);
  }, []);

  // 录制快捷键：按下组合键即保存；Esc 取消。
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setRecording(false); return; }
      const acc = toAccelerator(e);
      if (!acc) return;
      setShortcut(acc); void api.setShortcut(acc); setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  return (
    <Card title={t("settings.launcher")}>
      <Row label={t("settings.launcherEnable")}>
        <span className="flex-1 text-[12px] text-muted">{t("settings.launcherEnableDesc")}</span>
        <Toggle on={enabled} onClick={() => { const n = !enabled; setEnabled(n); void api.setEnabled(n); }} />
      </Row>
      <Row label={t("settings.launcherShortcut")}>
        <button
          onClick={() => setRecording(true)}
          className={`flex-1 text-left border rounded-lg px-[11px] py-[7px] text-[13px] font-mono bg-bg text-text ${recording ? "border-orange" : "border-border"}`}
        >
          {recording ? t("settings.pressShortcut") : shortcut}
        </button>
        <button className="px-[13px] py-[6px] border border-border bg-card text-text rounded-lg text-[12.5px]" onClick={() => { setShortcut("Alt+Space"); void api.setShortcut("Alt+Space"); }}>
          {t("common.reset")}
        </button>
      </Row>
      <div className="pt-2">
        <div className="flex items-center gap-2 mb-1.5">
          <div className="text-[12.5px] font-semibold flex-1">{t("settings.launcherWorkflows")}</div>
          <span className="text-[11.5px] text-muted">{t("settings.launcherWorkflowsCount", { count: wfCount })}</span>
          <button className="px-[12px] py-[6px] bg-orange text-white rounded-lg text-[12.5px] font-semibold" onClick={() => void api.openWorkflowEditor()}>{t("settings.launcherWorkflowsOpen")}</button>
        </div>
        <div className="text-[11px] text-muted">{t("settings.launcherWorkflowsHint")}</div>
      </div>
    </Card>
  );
}

function PhrasesCard() {
  const { t } = useTranslation();
  const api = (window as unknown as { umbraLauncher: LauncherAPI }).umbraLauncher;
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [draft, setDraft] = useState<{ name: string; keyword: string; content: string }>({ name: "", keyword: "", content: "" });
  const [editId, setEditId] = useState<string | null>(null);

  useEffect(() => { void api.getPhrases().then((p) => setPhrases(p || [])); }, []);
  const save = (list: Phrase[]) => { setPhrases(list); void api.setPhrases(list); };

  const add = () => {
    if (!draft.content.trim()) return;
    const p: Phrase = { id: `ph${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: draft.name.trim() || draft.content.trim().slice(0, 20), content: draft.content.trim(), keyword: draft.keyword.trim() || undefined };
    save([...phrases, p]);
    setDraft({ name: "", keyword: "", content: "" });
  };
  const update = (id: string, patch: Partial<Phrase>) => save(phrases.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir; if (j < 0 || j >= phrases.length) return;
    const list = phrases.slice(); [list[i], list[j]] = [list[j], list[i]]; save(list);
  };
  const inputCls = "border border-border rounded-lg px-[10px] py-[6px] text-[12.5px] bg-bg text-text";

  return (
    <Card title={t("settings.phrases")} sub={t("settings.phrasesSub")}>
      <div className="flex flex-col gap-1.5">
        {phrases.length ? phrases.map((p, i) => (
          <div key={p.id} className="flex items-center gap-2 bg-bg border border-border rounded-lg px-[10px] py-[7px]">
            <div className="flex flex-col leading-none mr-1">
              <button className="text-muted text-[10px] disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
              <button className="text-muted text-[10px] disabled:opacity-30" disabled={i === phrases.length - 1} onClick={() => move(i, 1)}>▼</button>
            </div>
            {editId === p.id ? (
              <div className="flex-1 flex items-center gap-1.5 flex-wrap">
                <input value={p.name} onChange={(e) => update(p.id, { name: e.target.value })} placeholder={t("settings.phraseName")} className={`w-[110px] ${inputCls}`} />
                <input value={p.keyword || ""} onChange={(e) => update(p.id, { keyword: e.target.value || undefined })} placeholder={t("settings.phraseKeyword")} className={`w-[90px] ${inputCls} font-mono`} />
                <input value={p.content} onChange={(e) => update(p.id, { content: e.target.value })} placeholder={t("settings.phraseContent")} className={`flex-1 min-w-[160px] ${inputCls}`} />
                <button className="px-[10px] py-[5px] bg-orange text-white rounded-lg text-[12px]" onClick={() => setEditId(null)}>{t("common.done")}</button>
              </div>
            ) : (
              <div className="flex-1 flex items-center gap-2 min-w-0 cursor-pointer" onClick={() => setEditId(p.id)}>
                <span className="font-medium text-[12.5px]">{p.name}</span>
                {p.keyword ? <span className="text-orange-text text-[11px]">{p.keyword}</span> : null}
                <span className="text-muted truncate flex-1 text-[11.5px]">{p.content}</span>
              </div>
            )}
            <button className="text-danger text-[12px]" onClick={() => save(phrases.filter((x) => x.id !== p.id))}>{t("common.delete")}</button>
          </div>
        )) : <div className="text-[12px] text-muted">{t("settings.phrasesEmpty")}</div>}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap pt-1">
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("settings.phraseName")} className={`w-[110px] ${inputCls}`} />
        <input value={draft.keyword} onChange={(e) => setDraft({ ...draft, keyword: e.target.value })} placeholder={t("settings.phraseKeyword")} className={`w-[90px] ${inputCls} font-mono`} />
        <input value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") add(); }} placeholder={t("settings.phraseContent")} className={`flex-1 min-w-[160px] ${inputCls}`} />
        <button className="px-[12px] py-[6px] bg-orange text-white rounded-lg text-[12.5px] font-semibold" onClick={add}>{t("common.add")}</button>
      </div>
      <div className="text-[11px] text-muted">{t("settings.phrasesHint")}</div>
    </Card>
  );
}

interface VaultBridge { openWindow(): Promise<void>; status(): Promise<{ shortcut: string }>; setShortcut(acc: string): Promise<{ ok: boolean }> }
function VaultCard() {
  const { t } = useTranslation();
  const api = (window as unknown as { umbraVault: VaultBridge }).umbraVault;
  const [shortcut, setShortcut] = useState("Command+Alt+P");
  const [recording, setRecording] = useState(false);
  useEffect(() => { void api.status().then((s) => setShortcut(s.shortcut || "")); }, []);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setRecording(false); return; }
      const acc = toAccelerator(e); if (!acc) return;
      setShortcut(acc); void api.setShortcut(acc); setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);
  return (
    <Card title={t("settings.vault")}>
      <Row label={t("settings.vaultOpenLabel")}>
        <span className="flex-1 text-[12px] text-muted">{t("settings.vaultDesc")}</span>
        <button className="px-[14px] py-[7px] bg-orange text-white rounded-lg text-[12.5px] font-semibold" onClick={() => void api.openWindow()}>{t("settings.vaultOpen")}</button>
      </Row>
      <Row label={t("settings.vaultShortcut")}>
        <button onClick={() => setRecording(true)} className={`flex-1 text-left border rounded-lg px-[11px] py-[7px] text-[13px] font-mono bg-bg text-text ${recording ? "border-orange" : "border-border"}`}>
          {recording ? t("settings.pressShortcut") : (shortcut || t("common.none"))}
        </button>
        <button className={btnGhost} onClick={() => { setShortcut("Command+Alt+P"); void api.setShortcut("Command+Alt+P"); }}>{t("common.reset")}</button>
      </Row>
    </Card>
  );
}

function PermRow({ title, desc, granted, onGrant }: { title: string; desc: string; granted: boolean; onGrant: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 py-3 border-b border-border">
      <div className="flex-1">
        <div className="text-[13.5px]">{title}</div>
        <div className="text-[11.5px] text-muted mt-px">{desc}</div>
      </div>
      {granted ? (
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-success font-semibold">✓ {t("common.granted")}</span>
      ) : (
        <>
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-warning font-semibold">
            <span className="w-[7px] h-[7px] rounded-full bg-warning" />
            {t("common.notGranted")}
          </span>
          <button className="px-3 py-[5px] border border-warning text-warning bg-transparent rounded-md text-[12px] font-semibold" onClick={onGrant}>
            {t("common.goAuthorize")}
          </button>
        </>
      )}
    </div>
  );
}
