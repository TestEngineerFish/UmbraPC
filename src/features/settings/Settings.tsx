// 设置页（React + Tailwind）。受控输入，不再整页重建 → 根治失焦 / 滚动跳顶。
// 业务逻辑复用 server.ts / desktop.ts 与 main.ts 导出的处理器。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { chatConn, getServerUrl, getDeviceName, getAllowDeviceSend, setAllowDeviceSend, getAutoApproveOperate, setAutoApproveOperate } from "../../services/server";
import * as desktop from "../../services/desktop";
import * as legacy from "../../app/shell";
import { SUPPORTED_LOCALES, type Locale } from "../../i18n/locale";
import { changeLocale } from "../../i18n";

const hasClip = typeof (window as unknown as { umbraClip?: unknown }).umbraClip !== "undefined";
const hasShot = typeof (window as unknown as { umbraShot?: unknown }).umbraShot !== "undefined";
const hasLauncher = typeof (window as unknown as { umbraLauncher?: unknown }).umbraLauncher !== "undefined";

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
  const [allowDeviceSend, setAllowDeviceSendState] = useState(getAllowDeviceSend());
  const [autoApprove, setAutoApproveState] = useState(getAutoApproveOperate());
  const [skillPolicy, setSkillPolicy] = useState<Record<string, "allow" | "deny">>(
    desktop.getDesktopConfig()?.computerSkillPolicy || {},
  );

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
              <div className="text-[13.5px]">{t("chat.allowDeviceSend")}</div>
              <div className="text-[11.5px] text-muted mt-px">{t("chat.allowDeviceSendHint")}</div>
            </div>
            <Toggle
              on={allowDeviceSend}
              onClick={() => {
                const next = !allowDeviceSend;
                setAllowDeviceSend(next);
                setAllowDeviceSendState(next);
              }}
            />
          </div>
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
interface LauncherAPI {
  getSettings(): Promise<{ enabled: boolean; shortcut: string; folders: LauncherFolder[]; registered: boolean }>;
  setEnabled(enabled: boolean): Promise<void>;
  setShortcut(acc: string): Promise<{ ok: boolean }>;
  setFolders(folders: LauncherFolder[]): Promise<void>;
}
function LauncherCard() {
  const { t } = useTranslation();
  const api = (window as unknown as { umbraLauncher: LauncherAPI }).umbraLauncher;
  const [enabled, setEnabled] = useState(true);
  const [shortcut, setShortcut] = useState("Alt+Space");
  const [folders, setFolders] = useState<LauncherFolder[]>([]);
  const [draft, setDraft] = useState<LauncherFolder>({ name: "", path: "", app: "" });

  useEffect(() => { void api.getSettings().then((s) => { setEnabled(s.enabled); setShortcut(s.shortcut); setFolders(s.folders || []); }); }, []);

  const saveFolders = (list: LauncherFolder[]) => { setFolders(list); void api.setFolders(list); };
  const addFolder = () => {
    if (!draft.path.trim()) return;
    saveFolders([...folders, { name: draft.name.trim() || draft.path.trim(), path: draft.path.trim(), app: draft.app?.trim() || "" }]);
    setDraft({ name: "", path: "", app: "" });
  };

  const inputCls = "border border-border rounded-lg px-[10px] py-[6px] text-[12.5px] bg-bg text-text";
  return (
    <Card title={t("settings.launcher")}>
      <Row label={t("settings.launcherEnable")}>
        <span className="flex-1 text-[12px] text-muted">{t("settings.launcherEnableDesc")}</span>
        <Toggle on={enabled} onClick={() => { const n = !enabled; setEnabled(n); void api.setEnabled(n); }} />
      </Row>
      <Row label={t("settings.launcherShortcut")}>
        <input value={shortcut} onChange={(e) => setShortcut(e.target.value)} placeholder="Alt+Space" className={`flex-1 ${inputCls} font-mono`} />
        <button className="px-[13px] py-[6px] border border-border bg-card text-text rounded-lg text-[12.5px]" onClick={() => void api.setShortcut(shortcut.trim())}>
          {t("common.save")}
        </button>
      </Row>
      <div className="pt-2">
        <div className="text-[12.5px] font-semibold mb-2">{t("settings.launcherFolders")}</div>
        <div className="flex flex-col gap-1.5 mb-2">
          {folders.length ? folders.map((f, i) => (
            <div key={i} className="flex items-center gap-2 text-[12.5px] bg-bg border border-border rounded-lg px-[10px] py-[7px]">
              <span className="font-medium">{f.name}</span>
              <span className="text-muted truncate flex-1">{(f.app ? `↳ ${f.app} · ` : "") + f.path}</span>
              <button className="text-danger text-[12px]" onClick={() => saveFolders(folders.filter((_, j) => j !== i))}>{t("common.delete")}</button>
            </div>
          )) : <div className="text-[12px] text-muted">{t("settings.launcherFoldersEmpty")}</div>}
        </div>
        <div className="flex items-center gap-1.5">
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("settings.launcherFolderName")} className={`w-[110px] ${inputCls}`} />
          <input value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} placeholder={t("settings.launcherFolderPath")} className={`flex-1 ${inputCls} font-mono`} />
          <input value={draft.app} onChange={(e) => setDraft({ ...draft, app: e.target.value })} placeholder={t("settings.launcherFolderApp")} className={`w-[130px] ${inputCls}`} />
          <button className="px-[12px] py-[6px] bg-orange text-white rounded-lg text-[12.5px] font-semibold" onClick={addFolder}>{t("common.add")}</button>
        </div>
      </div>
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
