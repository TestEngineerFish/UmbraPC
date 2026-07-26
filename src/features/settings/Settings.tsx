// 设置页（React + Tailwind）。受控输入，不再整页重建 → 根治失焦 / 滚动跳顶。
// 业务逻辑复用 server.ts / desktop.ts 与 main.ts 导出的处理器。
// 排版与「工具」下的二级页保持同一套：36px 标题图标 + RowsCard/SettingRow 的表单行 + Panel 的说明卡。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { chatConn, getServerUrl, getDeviceName, getAutoApproveOperate, setAutoApproveOperate, fetchProfile, saveProfile, resetProfile } from "../../services/server";
import * as desktop from "../../services/desktop";
import * as legacy from "../../app/shell";
import { SUPPORTED_LOCALES, type Locale } from "../../i18n/locale";
import { changeLocale } from "../../i18n";
import { Toggle, RowsCard, SettingRow, RowHint, Panel, Pill, Segmented, btnGhost, btnPrimary, btnDanger, inputFlex, selectBox } from "../../components/ui";
import type { PillTone } from "../../components/ui";
import { OWNER_LABEL, normAcc, readHotkeys, type HotkeyOwner } from "../tools/hotkeys";
import { gotoTool } from "../tools/Tools";
import { IconGear } from "../../components/icons";

// 快捷键归属方 → 「工具」下对应的二级页 key，点「去设置」直接跳到那一页去改。
// 常用语的快捷键在剪贴板那一页上（它是剪贴板面板的一个分类），所以两者都指向 phrases 自己的页。
const OWNER_TOOL: Record<HotkeyOwner, string> = {
  clip: "clipboard", phrases: "phrases", shot: "screenshot", launcher: "launcher", vault: "vault",
};

// 全局快捷键总览卡：只读地列出五处键位 + 标出重复，改键位一律跳去对应工具页。
// 数据走 hotkeys.tsx 的 readHotkeys / normAcc，和各工具页自己的冲突提示同源 ——
// 否则会出现「总览说不冲突、工具页横幅说冲突」这种自相矛盾。
function HotkeysCard() {
  const { t } = useTranslation();
  const [map, setMap] = useState<Partial<Record<HotkeyOwner, string>> | null>(null);
  // 进页面读一次就够：改键位要跳到工具页去改，改完回来时这个组件会重新挂载。
  useEffect(() => {
    let alive = true;
    void readHotkeys().then((m) => { if (alive) setMap(m); });
    return () => { alive = false; };
  }, []);

  const owners = Object.keys(OWNER_LABEL) as HotkeyOwner[];
  // 归一化后按键位分桶，桶里超过一个的就是重复。归一化过的空串表示「没设」，不参与比较。
  const bucket = new Map<string, HotkeyOwner[]>();
  for (const o of owners) {
    const n = normAcc(map?.[o] || "");
    if (!n) continue;
    bucket.set(n, [...(bucket.get(n) || []), o]);
  }
  const dupKeys = [...bucket.entries()].filter(([, os]) => os.length > 1);
  const dupOwners = new Set(dupKeys.flatMap(([, os]) => os));
  // 只在桌面端有桥的情况下才有东西可列；一条都读不到就给一句说明，不摆一张空表。
  const rows = map ? owners.filter((o) => map[o] !== undefined) : [];

  return (
    <Panel title={t("settings.hotkeys")} hint={t("settings.hotkeysHint")} stack>
      {map && !rows.length ? (
        <div className="text-[12.5px] text-muted">{t("settings.hotkeysEmpty")}</div>
      ) : (
        <>
          <div className="flex flex-col">
            {rows.map((o, i) => (
              <div key={o} className={`flex items-center gap-[12px] py-[10px] ${i < rows.length - 1 ? "border-b border-border-soft" : ""}`}>
                <div className="w-[120px] flex-none whitespace-nowrap text-[13px]">{t(OWNER_LABEL[o])}</div>
                <div className="flex-1 min-w-0 flex items-center gap-[8px]">
                  {map?.[o]
                    ? <Pill tone={dupOwners.has(o) ? "warning" : "neutral"} mono>{map[o]}</Pill>
                    : <span className="text-[12px] text-faint">{t("settings.hotkeysUnset")}</span>}
                  {dupOwners.has(o) ? <Pill tone="warning" dot>{t("settings.hotkeysConflict")}</Pill> : null}
                </div>
                <button className={btnGhost} onClick={() => gotoTool(OWNER_TOOL[o])}>{t("settings.hotkeysGoto")}</button>
              </div>
            ))}
          </div>
          {rows.length ? (
            dupKeys.length
              ? <div className="mt-[12px] text-[12px] text-warning">{t("settings.hotkeysConflictHint", { count: dupKeys.length })}</div>
              : <div className="mt-[12px] text-[12px] text-faint">{t("settings.hotkeysAllClear")}</div>
          ) : null}
        </>
      )}
    </Panel>
  );
}

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
    <Panel title={t("settings.profile")} hint={t("settings.profileHint")} stack>
      <textarea
        value={md}
        onChange={(e) => setMd(e.target.value)}
        placeholder={loaded ? "" : "…"}
        spellCheck={false}
        className="w-full h-[260px] border border-border bg-bg text-text rounded-[8px] px-[12px] py-[10px] text-[12.5px] leading-[1.7] outline-none resize-y font-mono"
      />
      <div className="flex items-center gap-2 justify-end mt-[12px]">
        <button className={btnDanger} disabled={busy} onClick={doReset}>{t("settings.profileReset")}</button>
        <button className={btnPrimary} disabled={busy || !loaded} onClick={doSave}>
          {saved ? t("settings.profileSaved") : t("settings.profileSave")}
        </button>
      </div>
    </Panel>
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
  // 连接类状态统一走徽章语义：在线绿、连接中橙、离线红。
  const connTone = (k: "online" | "connecting" | "offline"): PillTone => (k === "online" ? "success" : k === "connecting" ? "warning" : "danger");

  const codingModes = [t("settings.codingGenOnly"), t("settings.codingConfirm"), t("settings.codingDirect")];

  const onLocaleChange = (locale: Locale) => {
    void desktop.pushConfig({ locale }).then(() => changeLocale(locale));
  };

  return (
    <div id="scroll-main" className="h-full overflow-y-auto p-[22px_26px]">
      <div className="max-w-[740px] flex flex-col gap-[16px]">
        {/* 标题头与「工具」二级页同一套：36px 橙底圆角图标 + 标题 + 一句说明 */}
        <div className="flex items-start gap-[12px]">
          <span className="w-[36px] h-[36px] rounded-[9px] flex items-center justify-center flex-none bg-orange-soft text-orange-text">
            <IconGear size={18} />
          </span>
          <div className="min-w-0">
            <h1 className="m-0 text-[16px] font-semibold leading-tight">{t("settings.title")}</h1>
            <div className="text-[12.5px] text-muted mt-[2px]">{t("settings.desc")}</div>
          </div>
        </div>

        <RowsCard>
          <SettingRow label={t("settings.language")}>
            <RowHint />
            <select value={currentLocale} onChange={(e) => onLocaleChange(e.target.value as Locale)} className={selectBox}>
              {SUPPORTED_LOCALES.map(({ value, labelKey }) => (
                <option key={value} value={value}>{t(labelKey)}</option>
              ))}
            </select>
          </SettingRow>
        </RowsCard>

        <Panel title={t("settings.connection")}>
          <RowsCard>
            <SettingRow label={t("settings.serverUrl")}>
              <input value={server} onChange={(e) => setServer(e.target.value)} className={`${inputFlex} font-mono`} />
            </SettingRow>
            <SettingRow label={t("settings.token")}>
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={legacy.tokenPlaceholder()} className={`${inputFlex} font-mono tracking-widest`} />
            </SettingRow>
            <SettingRow label={t("settings.connStatus")}>
              <div className="flex-1 min-w-0"><Pill tone={connTone(cs)} dot>{csLabel}</Pill></div>
              <button className={btnGhost} onClick={() => legacy.applyConnection(server, token, device)}>
                {t("settings.saveReconnect")}
              </button>
            </SettingRow>
          </RowsCard>
        </Panel>

        {isDesk ? (
          <Panel title={t("settings.deviceEngine")}>
            <RowsCard>
              <SettingRow label={t("settings.engineStatus")}>
                <div className="flex-1 min-w-0"><Pill tone={connTone(engStatus)} dot>{engLabel}</Pill></div>
                <span className="flex-none whitespace-nowrap text-[12px] text-faint">{t("settings.checkLogs")}</span>
              </SettingRow>
              <SettingRow label={t("settings.availablePrograms")}>
                <RowHint>{t("settings.programCount", { count: ds ? ds.providers.filter((p) => p.available).length : 0 })}</RowHint>
              </SettingRow>
              <SettingRow label={t("settings.recentTask")}>
                <RowHint>{ds && ds.recentTasks[0] ? `${ds.recentTasks[0].provider}.${ds.recentTasks[0].skill} · ${ds.recentTasks[0].message}` : t("settings.noTask")}</RowHint>
              </SettingRow>
              <SettingRow label={t("settings.recentLogs")}>
                <div className="flex-1 min-w-0 text-[12px] text-muted font-mono break-all">{desktop.getDeviceLogs()[0] || t("settings.noLogs")}</div>
              </SettingRow>
            </RowsCard>
          </Panel>
        ) : null}

        <HotkeysCard />

        <Panel title={t("nav.chat")}>
          <RowsCard>
            <SettingRow label={t("settings.autoApproveOperate")}>
              <RowHint>{t("settings.autoApproveOperateHint")}</RowHint>
              <Toggle
                on={autoApprove}
                onClick={() => {
                  const next = !autoApprove;
                  setAutoApproveOperate(next);
                  setAutoApproveState(next);
                }}
              />
            </SettingRow>
          </RowsCard>
        </Panel>

        <ProfileCard />

        {isDesk && cuOn ? (
          <Panel title={t("settings.computerAuth")} hint={t("settings.computerAuthSub")} stack>
            <RowsCard>
              {([
                ["open_app", t("settings.skillOpenApp")],
                ["click", t("settings.skillClick")],
                ["type", t("settings.skillType")],
                ["key", t("settings.skillKey")],
                ["scroll", t("settings.skillScroll")],
              ] as const).map(([key, label]) => {
                const cur = (skillPolicy[key] || "ask") as "ask" | "allow" | "deny";
                const set = (v: "ask" | "allow" | "deny") => {
                  const next = { ...skillPolicy };
                  if (v === "ask") delete next[key];
                  else next[key] = v;
                  setSkillPolicy(next);
                  void desktop.pushConfig({ computerSkillPolicy: next });
                };
                return (
                  <SettingRow key={key} label={label}>
                    <RowHint />
                    <Segmented value={cur} onChange={set} options={[
                      { v: "ask", label: t("settings.policy_ask"), tone: "neutral" },
                      { v: "allow", label: t("settings.policy_allow"), tone: "accent" },
                      { v: "deny", label: t("settings.policy_deny"), tone: "danger" },
                    ]} />
                  </SettingRow>
                );
              })}
            </RowsCard>
          </Panel>
        ) : null}

        <Panel title={t("settings.device")}>
          <RowsCard>
            <SettingRow label={t("settings.deviceId")}>
              <div className="flex-1 min-w-0 text-[12.5px] font-mono break-all">{legacy.deviceIdLabel()}</div>
            </SettingRow>
            <SettingRow label={t("settings.deviceName")}>
              <input value={device} onChange={(e) => setDevice(e.target.value)} className={inputFlex} />
            </SettingRow>
          </RowsCard>
        </Panel>

        <Panel title={t("settings.permissions")} hint={t("settings.macos")}>
          <RowsCard>
            <PermRow title={t("settings.accessibility")} desc={t("settings.accessibilityDesc")} granted={perms.accessibility} onGrant={() => desktop.openPrivacy("accessibility")} />
            <PermRow title={t("settings.screenCapture")} desc={t("settings.screenCaptureDesc")} granted={perms.screen === "granted"} onGrant={() => desktop.openPrivacy("screen")} />
            <SettingRow label={t("settings.computerUse")}>
              <RowHint>{t("settings.computerUseDesc")}</RowHint>
              <Toggle on={cuOn} onClick={() => legacy.toggleComputerUse()} />
            </SettingRow>
          </RowsCard>
        </Panel>

        <Panel title={t("settings.capabilities")}>
          <RowsCard>
            <SettingRow label={t("settings.providersFile")}>
              <div className="flex-1 min-w-0 text-[12px] font-mono text-muted break-all">{cfg?.providersFile || t("common.desktopOnly")}</div>
              <button className={btnGhost} onClick={() => desktop.openProvidersFile()}>{t("settings.edit")}</button>
            </SettingRow>
            <SettingRow label={t("settings.codingPerm")}>
              <RowHint />
              <Segmented value={String(codingMode)} onChange={(v) => legacy.setCodingMode(Number(v))}
                options={codingModes.map((label, i) => ({ v: String(i), label }))} />
            </SettingRow>
          </RowsCard>
        </Panel>

        <Panel>
          <div className="flex items-center gap-[14px]">
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold">{t("settings.about")}</div>
              <div className="text-[12px] text-muted mt-[3px]">{t("settings.aboutDesc")}</div>
            </div>
            <button className={btnGhost}>{t("settings.checkUpdate")}</button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

// 权限行：左侧标签 + 中间说明 + 右侧「已授予」徽章或「待授权」徽章 + 去授权按钮。
// 走 SettingRow 是为了和同卡里其它行共用发丝线与标签宽度。
function PermRow({ title, desc, granted, onGrant }: { title: string; desc: string; granted: boolean; onGrant: () => void }) {
  const { t } = useTranslation();
  return (
    <SettingRow label={title}>
      <RowHint>{desc}</RowHint>
      {granted ? (
        <Pill tone="success">{t("common.granted")}</Pill>
      ) : (
        <>
          <Pill tone="warning" dot>{t("common.notGranted")}</Pill>
          <button className="flex-none whitespace-nowrap px-[13px] py-[6px] border border-warning text-warning bg-transparent rounded-[8px] text-[12.5px] font-semibold cursor-pointer hover:bg-warning hover:text-white" onClick={onGrant}>
            {t("common.goAuthorize")}
          </button>
        </>
      )}
    </SettingRow>
  );
}
