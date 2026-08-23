// 设置页（React + Tailwind）。受控输入，不再整页重建 → 根治失焦 / 滚动跳顶。
// 业务逻辑复用 server.ts / desktop.ts 与 main.ts 导出的处理器。
//
// 结构对齐 ClaudeDesign 的设置稿：左侧 198px 二级目录（四个分组 / 九个分页），
// 右侧每页一个 17px 标题 + 一句说明 + 若干张卡，卡内是「110px 标签 + 说明 + 控件」的表单行。
// 和「工具」模块同形，两处的二级目录视觉完全一致。
import { useState, useEffect } from "react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { chatConn, getServerUrl, getDeviceName, getAutoApproveOperate, setAutoApproveOperate, fetchProfile, saveProfile, resetProfile } from "../../services/server";
import * as desktop from "../../services/desktop";
import * as legacy from "../../app/shell";
import { SUPPORTED_LOCALES, type Locale } from "../../i18n/locale";
import { changeLocale } from "../../i18n";
import { Toggle, RowsCard, SettingRow, RowHint, Pill, Segmented, btnGhost, btnPrimary, btnDanger, btnIcon, inputFlex, selectBox } from "../../components/ui";
import type { PillTone } from "../../components/ui";
import { askConfirm, showToast } from "../../components/overlay";
import { OWNER_LABEL, normAcc, readHotkeys, type HotkeyOwner } from "../tools/hotkeys";
import { displayAccel } from "../../components/hotkey";
import { gotoTool } from "../tools/Tools";
import {
  IconSliders, IconPlug, IconCpu, IconShield, IconKeyboard, IconMouse, IconChat, IconGrid, IconInfo,
  IconCopy, IconCheck, IconAlert,
} from "../../components/icons";

// 九个分页的标识。顺序即二级目录里的渲染顺序。
type SecKey = "general" | "conn" | "device" | "perm" | "keys" | "chat" | "ops" | "cap" | "about";
type IconComp = ComponentType<{ size?: number }>;

// 二级目录的分组与条目。labelKey / descKey 走 i18n，icon 是线性描边图标。
const SEC_GROUPS: { labelKey: string; items: { key: SecKey; labelKey: string; icon: IconComp }[] }[] = [
  { labelKey: "settings.secGroupBasic", items: [
    { key: "general", labelKey: "settings.secGeneral", icon: IconSliders },
    { key: "conn", labelKey: "settings.secConn", icon: IconPlug },
    { key: "device", labelKey: "settings.secDevice", icon: IconCpu },
  ] },
  { labelKey: "settings.secGroupSecurity", items: [
    { key: "perm", labelKey: "settings.secPerm", icon: IconShield },
    { key: "keys", labelKey: "settings.secKeys", icon: IconKeyboard },
    { key: "ops", labelKey: "settings.secOps", icon: IconMouse },
  ] },
  { labelKey: "settings.secGroupAssistant", items: [
    { key: "chat", labelKey: "settings.secChat", icon: IconChat },
    { key: "cap", labelKey: "settings.secCap", icon: IconGrid },
  ] },
  { labelKey: "settings.secGroupOther", items: [
    { key: "about", labelKey: "settings.secAbout", icon: IconInfo },
  ] },
];

// 快捷键归属方 → 「工具」下对应的二级页 key，点「前往」直接跳到那一页去改。
const OWNER_TOOL: Record<HotkeyOwner, string> = {
  clip: "clipboard", phrases: "phrases", shot: "screenshot", launcher: "launcher", vault: "vault",
};

// 每页顶部的标题块：17px 标题 + 一句说明。九页共用。
function SecHead({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <div className="text-[17px] font-semibold">{title}</div>
      <div className="text-[12.5px] text-muted mt-[3px]">{desc}</div>
    </div>
  );
}

// 一整块提示横幅（冲突警告、总开关未开这类）。tone 决定配色语义。
function Banner({ tone, children }: { tone: "danger" | "warning"; children: React.ReactNode }) {
  const skin = tone === "danger" ? "bg-danger-soft border-danger text-danger" : "bg-warning-soft border-warning text-warning";
  return (
    <div className={`flex items-center gap-[10px] rounded-[11px] border px-[14px] py-[12px] ${skin}`}>
      <span className="flex-none flex"><IconAlert size={15} /></span>
      <span className="flex-1 min-w-0 text-[12.5px] text-text">{children}</span>
    </div>
  );
}

// 把毫秒差说成人话（分 / 小时 / 天）。只给一个量级，设置页不需要「3 小时 12 分」这种精度。
function humanDur(ms: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const min = Math.floor(ms / 60000);
  if (min < 1) return t("settings.durJust");
  if (min < 60) return t("settings.durMin", { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("settings.durHour", { n: h });
  return t("settings.durDay", { n: Math.floor(h / 24) });
}

export function Settings() {
  const { t, i18n } = useTranslation();
  const [sec, setSec] = useState<SecKey>("general");
  // 写完主进程配置后回读，需要显式触发一次重渲染（config 是模块级缓存，不是 state）。
  const [, bump] = useState(0);
  const [server, setServer] = useState(getServerUrl());
  const [token, setToken] = useState("");
  const [device, setDevice] = useState(getDeviceName());
  const [autoApprove, setAutoApproveState] = useState(getAutoApproveOperate());
  const [copied, setCopied] = useState(false);
  const [skillPolicy, setSkillPolicy] = useState<Record<string, "allow" | "deny">>(
    desktop.getDesktopConfig()?.computerSkillPolicy || {},
  );
  // 快捷键总览的数据：进页面读一次；改键位要跳到工具页去改，回来时组件会重新挂载。
  const [keyMap, setKeyMap] = useState<Partial<Record<HotkeyOwner, string>> | null>(null);
  useEffect(() => {
    let alive = true;
    void readHotkeys().then((m) => { if (alive) setKeyMap(m); });
    return () => { alive = false; };
  }, []);

  const isDesk = desktop.isDesktop();
  const cs = chatConn.status as "online" | "connecting" | "offline";
  const ds = desktop.getDeviceState();
  const perms = desktop.getPermissions();
  const cfg = desktop.getDesktopConfig();
  const codingMode = legacy.getCodingMode();
  const cuOn = legacy.computerEnabled();
  const themePref = legacy.getThemePref();

  const currentLocale = (i18n.language || cfg?.locale || "zh-CN") as Locale;
  const csLabel = cs === "online" ? t("conn.online") : cs === "connecting" ? t("conn.connecting") : t("conn.offline");
  const engStatus = (ds?.status || "offline") as "online" | "connecting" | "offline";
  const engLabel = engStatus === "online" ? t("settings.engineRunning") : engStatus === "connecting" ? t("conn.connecting") : t("conn.offline");
  // 连接类状态统一走徽章语义：在线绿、连接中橙、离线红。
  const connTone = (k: "online" | "connecting" | "offline"): PillTone => (k === "online" ? "success" : k === "connecting" ? "warning" : "danger");

  // 快捷键冲突：归一化后按键位分桶，桶里超过一个的算重复。
  const owners = Object.keys(OWNER_LABEL) as HotkeyOwner[];
  const keyRows = keyMap ? owners.filter((o) => keyMap[o] !== undefined) : [];
  const bucket = new Map<string, HotkeyOwner[]>();
  for (const o of owners) {
    const n = normAcc(keyMap?.[o] || "");
    if (n) bucket.set(n, [...(bucket.get(n) || []), o]);
  }
  const dupOf = (o: HotkeyOwner): HotkeyOwner[] => {
    const n = normAcc(keyMap?.[o] || "");
    return n ? (bucket.get(n) || []).filter((x) => x !== o) : [];
  };
  const dupCount = [...bucket.values()].filter((os) => os.length > 1).length;

  const copyDeviceId = () => {
    void navigator.clipboard.writeText(legacy.deviceIdLabel()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const secTitle = (k: SecKey) => t(`settings.sec${k.charAt(0).toUpperCase()}${k.slice(1)}`);
  const secDesc = (k: SecKey) => t(`settings.sec${k.charAt(0).toUpperCase()}${k.slice(1)}Desc`);

  return (
    <div className="h-full flex min-h-0">
      {/* 二级目录：和「工具」那一列同一套外观（--rail 底、分组小标题、22px 图标块、橙底选中态）。 */}
      <nav className="w-[198px] flex-none border-r border-border bg-rail flex flex-col min-h-0">
        <div className="flex-none p-[14px_14px_10px] text-[14px] font-semibold">{t("settings.title")}</div>
        <div className="flex-1 overflow-y-auto p-[0_8px_12px]">
          {SEC_GROUPS.map((g) => (
            <div key={g.labelKey} className="mb-[12px]">
              <div className="text-[10.5px] font-semibold tracking-[.06em] text-faint p-[0_8px_6px]">{t(g.labelKey)}</div>
              <div className="flex flex-col gap-px">
                {g.items.map((i) => {
                  const on = sec === i.key;
                  const Icon = i.icon;
                  // 快捷键那一项在有冲突时挂一个红色计数徽章，不用点进去也知道有事。
                  const badge = i.key === "keys" && dupCount > 0 ? dupCount : 0;
                  return (
                    <button key={i.key} onClick={() => setSec(i.key)}
                      className={`w-full text-left flex items-center gap-[9px] p-[6px_8px] rounded-[8px] text-[12.5px] cursor-pointer transition-colors ${
                        on ? "bg-orange-soft text-orange-text font-semibold" : "bg-transparent text-text hover:bg-hover"}`}>
                      <span className={`w-[22px] h-[22px] rounded-[6px] flex items-center justify-center flex-none ${on ? "bg-orange text-white" : "text-muted"}`}>
                        <Icon size={14} />
                      </span>
                      <span className="flex-1 min-w-0 truncate">{t(i.labelKey)}</span>
                      {badge ? <span className="flex-none whitespace-nowrap px-[6px] rounded-full bg-danger-soft text-danger text-[10px] font-semibold">{badge}</span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </nav>

      <main id="scroll-main" className="flex-1 min-w-0 overflow-y-auto p-[22px_26px_40px]">
        <div className="max-w-[760px] flex flex-col gap-[16px]">
          <SecHead title={secTitle(sec)} desc={secDesc(sec)} />

          {sec === "general" ? (
            <RowsCard>
              <SettingRow label={t("settings.language")}>
                <RowHint>{t("settings.langHint")}</RowHint>
                <select value={currentLocale} onChange={(e) => { const l = e.target.value as Locale; void desktop.pushConfig({ locale: l }).then(() => changeLocale(l)); }} className={selectBox}>
                  {SUPPORTED_LOCALES.map(({ value, labelKey }) => <option key={value} value={value}>{t(labelKey)}</option>)}
                </select>
              </SettingRow>
              <SettingRow label={t("settings.appearance")}>
                <RowHint>{t("settings.appearanceHint")}</RowHint>
                <Segmented value={themePref} onChange={(v) => legacy.setThemePref(v)} options={[
                  { v: "light" as const, label: t("settings.appearanceLight") },
                  { v: "dark" as const, label: t("settings.appearanceDark") },
                  { v: "system" as const, label: t("settings.appearanceSystem") },
                ]} />
              </SettingRow>
              {/* 开机自启读的是系统「登录项」的真实状态；Linux 上 Electron 不支持，整行不出现。 */}
              {isDesk && cfg?.loginItemSupported ? (
                <SettingRow label={t("settings.bootLaunch")}>
                  <RowHint>{t("settings.bootLaunchHint")}</RowHint>
                  <Toggle on={!!cfg.openAtLogin} onClick={() => { void desktop.setLoginItem(!cfg.openAtLogin).then(() => bump((n) => n + 1)); }} />
                </SettingRow>
              ) : null}
              {isDesk ? (
                <SettingRow label={t("settings.tray")}>
                  <RowHint>{t("settings.trayHint")}</RowHint>
                  <Toggle on={cfg?.trayEnabled !== false} onClick={() => { void desktop.pushConfig({ trayEnabled: cfg?.trayEnabled === false }).then(() => bump((n) => n + 1)); }} />
                </SettingRow>
              ) : null}
            </RowsCard>
          ) : null}

          {sec === "conn" ? (
            <RowsCard>
              <SettingRow label={t("settings.serverUrl")}>
                <input value={server} onChange={(e) => setServer(e.target.value)} className={`${inputFlex} font-mono`} />
              </SettingRow>
              <SettingRow label={t("settings.token")}>
                <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={legacy.tokenPlaceholder()} className={`${inputFlex} font-mono tracking-widest`} />
              </SettingRow>
              <SettingRow label={t("settings.connStatus")}>
                <div className="flex-1 min-w-0"><Pill tone={connTone(cs)} dot>{csLabel}</Pill></div>
                <button className={btnGhost} onClick={() => legacy.applyConnection(server, token, device)}>{t("settings.saveReconnect")}</button>
              </SettingRow>
            </RowsCard>
          ) : null}

          {sec === "device" ? (<>
            <RowsCard>
              <SettingRow label={t("settings.deviceId")}>
                <div className="flex-1 min-w-0 text-[12.5px] font-mono break-all">{legacy.deviceIdLabel()}</div>
                <button className={btnIcon} title={t("settings.copyDeviceId")} onClick={copyDeviceId}>
                  {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                </button>
              </SettingRow>
              <SettingRow label={t("settings.deviceName")}>
                <input value={device} onChange={(e) => setDevice(e.target.value)} className={inputFlex} />
              </SettingRow>
            </RowsCard>
            {isDesk ? (
              <RowsCard>
                <SettingRow label={t("settings.engineStatus")}>
                  <div className="flex-1 min-w-0 flex items-center gap-[10px]">
                    <Pill tone={connTone(engStatus)} dot>{engLabel}</Pill>
                    {/* 延迟与心跳来自设备 WebSocket 的 heartbeat / heartbeat_ack 往返 ——
                        全应用只有这一处有真实往返数据（聊天那条 WS 没有 ping/pong 协议）。 */}
                    {engStatus === "online" ? (
                      <span className="flex-none whitespace-nowrap text-[11.5px] text-faint">
                        {ds?.registeredAt ? `${t("settings.registeredFor", { human: humanDur(Date.now() - ds.registeredAt, t) })} · ` : ""}
                        {ds?.latencyMs ? `${t("settings.latency", { ms: ds.latencyMs })} · ` : ""}
                        {ds?.lastHeartbeatAt ? t("settings.heartbeatAgo", { sec: Math.round((Date.now() - ds.lastHeartbeatAt) / 1000) }) : t("settings.heartbeatNone")}
                      </span>
                    ) : null}
                  </div>
                  <button className={btnGhost} onClick={() => legacy.goNav("logs")}>{t("settings.goLogs")}</button>
                </SettingRow>
                <SettingRow label={t("settings.availablePrograms")}>
                  {/* 可用程序改成 chips 逐个列出来，比只给一个数字有用得多。 */}
                  <div className="flex-1 min-w-0 flex items-center gap-[6px] flex-wrap">
                    {(ds?.providers || []).filter((p) => p.available).map((p) => <Pill key={p.provider}>{p.display_name || p.provider}</Pill>)}
                    {!(ds?.providers || []).some((p) => p.available) ? <span className="text-[12.5px] text-muted">{t("settings.noPrograms")}</span> : null}
                  </div>
                  <button className={btnGhost} onClick={() => legacy.goNav("abilities")}>{t("settings.goAbilities")}</button>
                </SettingRow>
                <SettingRow label={t("settings.recentTask")}>
                  <RowHint>{ds && ds.recentTasks[0] ? `${ds.recentTasks[0].provider}.${ds.recentTasks[0].skill} · ${ds.recentTasks[0].message}` : t("settings.noTask")}</RowHint>
                </SettingRow>
                <SettingRow label={t("settings.recentLogs")}>
                  {/* 日志行给一块 --track 底的等宽区，和周围的表单行区分开。 */}
                  <div className="flex-1 min-w-0 font-mono text-[11.5px] text-muted bg-track rounded-[7px] px-[10px] py-[7px] truncate">
                    {(() => { const l = desktop.getDeviceLogs()[0]; return l ? `${l.time}  ${l.msg}` : t("settings.noLogs"); })()}
                  </div>
                </SettingRow>
              </RowsCard>
            ) : null}
          </>) : null}

          {sec === "perm" ? (
            <RowsCard>
              <PermRow title={t("settings.accessibility")} desc={t("settings.accessibilityDesc")} granted={perms.accessibility} onGrant={() => desktop.openPrivacy("accessibility")} />
              <PermRow title={t("settings.screenCapture")} desc={t("settings.screenCaptureDesc")} granted={perms.screen === "granted"} onGrant={() => desktop.openPrivacy("screen")} />
              <PermRow title={t("settings.microphone")} desc={t("settings.microphoneDesc")} granted={perms.microphone === "granted"} onGrant={() => desktop.openPrivacy("microphone")} />
              <SettingRow label={t("settings.computerUse")}>
                <RowHint>{t("settings.computerUseDesc")}</RowHint>
                <Toggle on={cuOn} onClick={() => legacy.toggleComputerUse()} />
              </SettingRow>
            </RowsCard>
          ) : null}

          {sec === "keys" ? (<>
            {dupCount ? <Banner tone="danger">{t("settings.keysConflictBanner", { count: dupCount })}</Banner> : null}
            {keyMap && !keyRows.length ? (
              <RowsCard><SettingRow label={t("settings.secKeys")}><RowHint>{t("settings.hotkeysEmpty")}</RowHint></SettingRow></RowsCard>
            ) : (
              <section className="bg-card border border-border rounded-[12px] overflow-hidden">
                <div className="flex items-center gap-[12px] px-[15px] py-[9px] bg-bg border-b border-border-soft text-[11px] text-faint">
                  <span className="w-[150px] flex-none whitespace-nowrap">{t("settings.keysTableTool")}</span>
                  <span className="w-[130px] flex-none whitespace-nowrap">{t("settings.keysTableKey")}</span>
                  <span className="flex-1 min-w-0 whitespace-nowrap">{t("settings.keysTableState")}</span>
                  <span className="w-[56px] flex-none text-right whitespace-nowrap">{t("settings.keysTableGo")}</span>
                </div>
                {keyRows.map((o) => {
                  const dup = dupOf(o);
                  const acc = keyMap?.[o] || "";
                  return (
                    <div key={o} className="flex items-center gap-[12px] px-[15px] py-[10px] border-b border-border-soft last:border-b-0 hover:bg-hover">
                      <span className="w-[150px] flex-none truncate text-[12.5px]">{t(OWNER_LABEL[o])}</span>
                      <span className={`w-[130px] flex-none font-mono text-[12px] whitespace-nowrap ${acc ? "text-text" : "text-faint"}`}>{displayAccel(acc) || "—"}</span>
                      <span className={`flex-1 min-w-0 truncate text-[11.5px] ${dup.length ? "text-warning" : acc ? "text-success" : "text-faint"}`}>
                        {dup.length ? t("settings.keyStateDup", { owner: t(OWNER_LABEL[dup[0]]) }) : acc ? t("settings.keyStateOk") : t("settings.keyStateUnset")}
                      </span>
                      <button className="w-[56px] flex-none text-right text-[12px] whitespace-nowrap bg-transparent text-orange-text" onClick={() => gotoTool(OWNER_TOOL[o])}>{t("settings.keysGo")}</button>
                    </div>
                  );
                })}
              </section>
            )}
            <div className="text-[11.5px] text-faint leading-[1.7]">{t("settings.keysFootnote")}</div>
          </>) : null}

          {sec === "chat" ? (<>
            <RowsCard>
              <SettingRow label={t("settings.autoApproveOperate")}>
                <RowHint>{t("settings.autoApproveOperateHint")}</RowHint>
                <Pill tone="danger">{t("settings.cautious")}</Pill>
                <Toggle on={autoApprove} onClick={() => { const next = !autoApprove; setAutoApproveOperate(next); setAutoApproveState(next); }} />
              </SettingRow>
            </RowsCard>
            <ProfileCard />
          </>) : null}

          {sec === "ops" ? (<>
            {!cuOn ? (
              <Banner tone="warning">
                <span className="flex items-center gap-[10px]">
                  <span className="flex-1 min-w-0">{t("settings.cuOffBanner")}</span>
                  <button className="flex-none whitespace-nowrap px-[12px] py-[5px] border border-warning text-warning bg-transparent rounded-[7px] text-[12px] font-semibold cursor-pointer hover:bg-warning hover:text-white" onClick={() => legacy.toggleComputerUse()}>{t("settings.cuOffGo")}</button>
                </span>
              </Banner>
            ) : null}
            <RowsCard>
              {([
                ["open_app", t("settings.skillOpenApp")],
                ["click", t("settings.skillClick")],
                ["type", t("settings.skillType")],
                ["key", t("settings.skillKey")],
                ["scroll", t("settings.skillScroll")],
                ["drag", t("settings.skillDrag")],
                ["screenshot", t("settings.skillScreenshot")],
              ] as const).map(([key, label]) => {
                const cur = (skillPolicy[key] || "ask") as "ask" | "allow" | "deny";
                const set = (v: "ask" | "allow" | "deny") => {
                  const next = { ...skillPolicy };
                  if (v === "ask") delete next[key]; else next[key] = v;
                  setSkillPolicy(next);
                  void desktop.pushConfig({ computerSkillPolicy: next });
                };
                return (
                  <SettingRow key={key} label={label}>
                    {/* 副文案是这一行对应的**真实技能名**（稿 6026-6034 也给每行配了副文案）。
                        它不是装饰：执行前确认卡和日志里出现的都是这个 key，
                        对不上的话用户被弹了一次授权，回到设置页也不知道该改哪一行。
                        稿把 open_app 写成「open_app / activate」、click 写成「click / double_click」——
                        activate 和 double_click 在服务端与主进程里都不存在，是稿自己编的，
                        这里只写真实存在的那一个。
                        「拖拽」额外带一句风险提示：它是唯一一个「一次误操作就能把文件拖进
                        回收站/改掉窗口布局」的动作，而 settings.skillDragHint 这个 key
                        定义了却一直零引用，那句提示从来没露过面。 */}
                    <RowHint>
                      <span className="font-mono text-[11.5px]">{key}</span>
                      {key === "drag" ? <span className="text-warning"> — {t("settings.skillDragHint")}</span> : null}
                    </RowHint>
                    <Segmented value={cur} onChange={set} options={[
                      { v: "ask" as const, label: t("settings.policy_ask"), tone: "neutral" },
                      { v: "allow" as const, label: t("settings.policy_allow"), tone: "accent" },
                      { v: "deny" as const, label: t("settings.policy_deny"), tone: "danger" },
                    ]} />
                  </SettingRow>
                );
              })}
            </RowsCard>
            <div className="flex items-center gap-[10px]">
              <span className="flex-1 min-w-0 text-[11.5px] text-faint">{t("settings.opsFootnote")}</span>
              {/* 「全部改为询问」= 清空策略表（ask 就是不写入这张表的默认档）。 */}
              <button className={btnGhost} onClick={() => { setSkillPolicy({}); void desktop.pushConfig({ computerSkillPolicy: {} }); }}>{t("settings.opsAllAsk")}</button>
            </div>
          </>) : null}

          {sec === "cap" ? (
            <RowsCard>
              <SettingRow label={t("settings.providersFile")}>
                <div className="flex-1 min-w-0 font-mono text-[11.5px] text-muted truncate">{cfg?.providersFile || t("common.desktopOnly")}</div>
                <button className={btnGhost} onClick={() => desktop.openProvidersFile()}>{t("settings.edit")}</button>
              </SettingRow>
              <SettingRow label={t("settings.codingPerm")}>
                <RowHint>{t("settings.codingPermHint")}</RowHint>
                <Segmented value={String(codingMode)} onChange={(v) => legacy.setCodingMode(Number(v))}
                  options={[t("settings.codingGenOnly"), t("settings.codingConfirm"), t("settings.codingDirect")].map((label, i) => ({ v: String(i), label }))} />
              </SettingRow>
            </RowsCard>
          ) : null}

          {sec === "about" ? (
            <section className="bg-card border border-border rounded-[12px] p-[18px] flex items-center gap-[14px]">
              <span className="w-[44px] h-[44px] flex-none rounded-[12px] bg-orange text-white font-bold text-[20px] flex items-center justify-center">U</span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-semibold">{t("settings.aboutProduct")}</div>
                <div className="text-[11.5px] text-muted mt-[3px]">{t("settings.aboutVersion")} · {t("settings.aboutLatest")}</div>
              </div>
              <button className={btnGhost}>{t("settings.checkUpdate")}</button>
            </section>
          ) : null}
          {sec === "about" && isDesk ? (
            <RowsCard>
              <SettingRow label={t("settings.configDir")}>
                <div className="flex-1 min-w-0 font-mono text-[11.5px] text-muted truncate">{cfg?.userDataDir || ""}</div>
                <button className={btnGhost} onClick={() => desktop.openPath(cfg?.userDataDir || "")}>{t("settings.openDir")}</button>
              </SettingRow>
              <SettingRow label={t("settings.logsDir")}>
                <div className="flex-1 min-w-0 font-mono text-[11.5px] text-muted truncate">{cfg?.logsDir || ""}</div>
                <button className={btnGhost} onClick={() => desktop.openPath(cfg?.logsDir || "")}>{t("settings.openDir")}</button>
              </SettingRow>
            </RowsCard>
          ) : null}
        </div>
      </main>
    </div>
  );
}

// 权限行：标签 + 说明 + 已授予/待授权徽章（+ 去授权按钮）。
function PermRow({ title, desc, granted, onGrant }: { title: string; desc: string; granted: boolean; onGrant: () => void }) {
  const { t } = useTranslation();
  return (
    <SettingRow label={title}>
      <RowHint>{desc}</RowHint>
      {granted ? (
        <Pill tone="success">{t("common.granted")}</Pill>
      ) : (<>
        <Pill tone="warning" dot>{t("common.notGranted")}</Pill>
        <button className="flex-none whitespace-nowrap px-[12px] py-[5px] border border-warning text-warning bg-transparent rounded-[7px] text-[12px] font-semibold cursor-pointer hover:bg-warning hover:text-white" onClick={onGrant}>
          {t("common.goAuthorize")}
        </button>
      </>)}
    </SettingRow>
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
    void (async () => { setMd(await fetchProfile()); setLoaded(true); })();
  }, []);
  const doSave = async () => {
    setBusy(true);
    const r = await saveProfile(md);
    if (r !== null) { setMd(r); setSaved(true); setTimeout(() => setSaved(false), 1500); }
    setBusy(false);
  };
  const doReset = async () => {
    if (!await askConfirm({
      message: t("settings.profileResetConfirm"),
      confirmText: t("settings.profileReset"),
      danger: true,
    })) return;
    setBusy(true);
    const r = await resetProfile();
    // 重置是把助手对你的全部认知清成空白模板 —— 不给回执的话，界面上只是文本框变了内容，
    // 用户分不清「重置成功」和「加载失败被清空了」。
    if (r !== null) { setMd(r); showToast(t("settings.profileResetDone"), { tone: "ok" }); }
    setBusy(false);
  };
  return (
    <section className="bg-card border border-border rounded-[12px] p-[16px]">
      <div className="flex items-baseline gap-[8px] mb-[4px]">
        <span className="flex-none whitespace-nowrap text-[13px] font-semibold">{t("settings.profile")}</span>
      </div>
      <div className="text-[11.5px] text-muted mb-[11px] leading-[1.6]">{t("settings.profileHint")}</div>
      <textarea
        value={md}
        onChange={(e) => setMd(e.target.value)}
        placeholder={loaded ? "" : "…"}
        spellCheck={false}
        aria-label={t("settings.profileMono")}
        className="w-full h-[260px] border border-border bg-track text-text rounded-[9px] px-[13px] py-[11px] text-[12px] leading-[1.75] outline-none resize-y font-mono"
      />
      <div className="flex items-center gap-[10px] mt-[12px]">
        <span className="flex-1" />
        <button className={btnDanger} disabled={busy} onClick={doReset}>{t("settings.profileReset")}</button>
        <button className={btnPrimary} disabled={busy || !loaded} onClick={doSave}>
          {saved ? t("settings.profileSaved") : t("settings.profileSave")}
        </button>
      </div>
    </section>
  );
}
