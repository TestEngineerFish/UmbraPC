// 设置页（React + Tailwind）。受控输入，不再整页重建 → 根治失焦 / 滚动跳顶。
// 业务逻辑复用 server.ts / desktop.ts 与 main.ts 导出的处理器。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { chatConn, getServerUrl, getDeviceName, getAutoApproveOperate, setAutoApproveOperate, fetchProfile, saveProfile, resetProfile } from "../../services/server";
import * as desktop from "../../services/desktop";
import * as legacy from "../../app/shell";
import { SUPPORTED_LOCALES, type Locale } from "../../i18n/locale";
import { changeLocale } from "../../i18n";
import { Card, Row, Toggle, StatusDot, input, btnGhost } from "../../components/ui";

// 用户画像卡：查看/编辑/重置服务端的 user_profile.md（秘书对用户的当前认知快照）。
// 画像由对话自动沉淀，可能积累错误——这里给用户直接改或一键重置的口子。
function ProfileCard() {
  const { t } = useTranslation();
  const [md, setMd] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void (async () => {
      setMd(await fetchProfile());
      setLoaded(true);
    })();
  }, []);
  const doSave = async () => {
    setBusy(true);
    const r = await saveProfile(md);
    if (r !== null) {
      setMd(r);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }
    setBusy(false);
  };
  const doReset = async () => {
    if (!window.confirm(t("settings.profileResetConfirm"))) return;
    setBusy(true);
    const r = await resetProfile();
    if (r !== null) setMd(r);
    setBusy(false);
  };
  return (
    <Card title={t("settings.profile")} sub={t("settings.profileHint")}>
      <textarea
        value={md}
        onChange={(e) => setMd(e.target.value)}
        placeholder={loaded ? "" : "…"}
        spellCheck={false}
        className="w-full h-[260px] border border-border bg-bg text-text rounded-lg px-[12px] py-[10px] text-[12.5px] leading-[1.7] outline-none resize-y font-mono"
      />
      <div className="flex items-center gap-2 justify-end">
        <button className={btnGhost} disabled={busy} onClick={doReset} style={{ color: "var(--danger)" }}>
          {t("settings.profileReset")}
        </button>
        <button
          disabled={busy || !loaded}
          onClick={doSave}
          className="px-[16px] py-[6px] rounded-lg text-[12.5px] font-semibold bg-orange text-white cursor-pointer"
        >
          {saved ? t("settings.profileSaved") : t("settings.profileSave")}
        </button>
      </div>
    </Card>
  );
}

export function Settings() {
  const { t, i18n } = useTranslation();
  const [server, setServer] = useState(getServerUrl());
  const [token, setToken] = useState("");
  const [device, setDevice] = useState(getDeviceName());
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

        <ProfileCard />

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
