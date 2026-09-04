// 设置页（React + Tailwind）。受控输入，不再整页重建 → 根治失焦 / 滚动跳顶。
// 业务逻辑复用 server.ts / desktop.ts 与 main.ts 导出的处理器。
//
// 批次 012 起套页面骨架的 **T3 设置分组**：页头「设置」+ 190 二级目录 + 720 内容列。
// 属于具体功能的四个分区（权限 + 电脑操作授权 / 能力配置 / 聊天与助手 / 记账分类与色槽）
// 已搬去各自功能页的设置视图（见 sections.tsx 与各功能页），这里只留全局的：
// 通用 / 连接 / 设备与引擎 / 快捷键总览（中转页，冲突检查在全局做）/ 回收站 / 关于。
//
// 批次 013：回收站不再是二级目录里的一个内容面，而是**借 PageShell 的设置视图机制承载的子页** ——
// 二级目录里点「回收站」→ 内容区整体换成「返回设置 + 回收站」（页头副标题 / 红描边「清空回收站」/ 第二行类型芯片），
// 返回或 Esc 关视图时二级目录选回打开前那一项。数据 hook 挂在这一层（PageShell 之上），页头与内容才拿得到同一份。
import { useState, useEffect, useLayoutEffect, useRef } from "react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { chatConn, getServerUrl, getDeviceName } from "../../services/server";
import * as desktop from "../../services/desktop";
import * as legacy from "../../app/shell";
import { SUPPORTED_LOCALES, type Locale } from "../../i18n/locale";
import { changeLocale } from "../../i18n";
import { Toggle, RowsCard, SettingRow, RowHint, Pill, Segmented, ErrorCard, btnGhost, btnIcon, inputFlex, selectBox } from "../../components/ui";
import { PageShell, SettingsPage, SettingsSection, usePageSettings, type PageSettings, type SubNavGroup } from "../../components/layout";
import type { PillTone } from "../../components/ui";
import { OWNER_LABEL, normAcc, readHotkeys, type HotkeyOwner } from "../tools/hotkeys";
import { displayAccel } from "../../components/hotkey";
import { gotoTool } from "../tools/Tools";
import {
  IconSliders, IconPlug, IconCpu, IconKeyboard, IconInfo, IconCopy, IconCheck, IconTrash,
} from "../../components/icons";
import { TrashChips, TrashContent, useTrashPage } from "./Trash";

// 分页的标识。顺序即二级目录里的渲染顺序。
export type SecKey = "general" | "conn" | "device" | "keys" | "trash" | "about";

// 别处（聊天页 ⋯ 的「回收站」、快捷键归属跳转）要求「打开设置并落到某一子页」时，先把目标记在这里
// 再切一级导航 —— 和 Tools.gotoTool 同一套：Settings 是路由式挂载的，切页时组件重建，值取一次就清。
// trashChip：回收站子页要预选的类型芯片（聊天 ⋯ 进来预选「聊天消息」，那是快捷方式不是第二份界面）。
// 消费方是下面的 Settings：挂载时取一次，sec="trash" 就直接开回收站视图。
export interface SettingsJump { sec: SecKey; trashChip?: string }
let pendingJump: SettingsJump | null = null;
export function gotoSettings(sec: SecKey, opts?: { trashChip?: string }): void {
  pendingJump = { sec, trashChip: opts?.trashChip };
  legacy.goNav("settings");
}
export function takePendingSettingsJump(): SettingsJump | null {
  const j = pendingJump;
  pendingJump = null;
  return j;
}
type IconComp = ComponentType<{ size?: number }>;

// 二级目录的分组与条目。labelKey / descKey 走 i18n，icon 是线性描边图标。
const SEC_GROUPS: { labelKey: string; items: { key: SecKey; labelKey: string; icon: IconComp }[] }[] = [
  { labelKey: "settings.secGroupBasic", items: [
    { key: "general", labelKey: "settings.secGeneral", icon: IconSliders },
    { key: "conn", labelKey: "settings.secConn", icon: IconPlug },
    { key: "device", labelKey: "settings.secDevice", icon: IconCpu },
  ] },
  // 快捷键总览留在全局：它是中转页，冲突检查本来就该跨工具做；改键位去各工具自己的设置面。
  { labelKey: "settings.secGroupSecurity", items: [
    { key: "keys", labelKey: "settings.secKeys", icon: IconKeyboard },
  ] },
  { labelKey: "settings.secGroupData", items: [
    { key: "trash", labelKey: "settings.secTrash", icon: IconTrash },
  ] },
  { labelKey: "settings.secGroupOther", items: [
    { key: "about", labelKey: "settings.secAbout", icon: IconInfo },
  ] },
];

// 快捷键归属方 → 去哪儿改：常用语 / 保险箱是一级导航页，其余是「小工具」下的二级页。
const OWNER_TOOL: Record<HotkeyOwner, string> = {
  clip: "clipboard", phrases: "phrases", shot: "screenshot", launcher: "launcher", vault: "vault",
};
function goOwner(o: HotkeyOwner): void {
  if (o === "phrases") legacy.goNav("phrases");
  else gotoTool(OWNER_TOOL[o]);
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
  const { t } = useTranslation();
  // 跳转目标挂载时取一次（取了就清）。sec="trash" 时二级目录的当前项直接落在回收站上，
  // 下面的 useTrashPage 从第一次渲染起就是 open，数据只拉一趟；视图本身由 SettingsBody 挂载时打开。
  const [jump] = useState(() => takePendingSettingsJump());
  const [sec, setSec] = useState<SecKey>(jump?.sec || "general");
  // 回收站视图打开前二级目录停在哪一项：关视图（返回钮 / Esc）时选回去。跳转直达的情况没有「前一项」，回到通用。
  const prevSec = useRef<SecKey>(jump?.sec && jump.sec !== "trash" ? jump.sec : "general");
  const openTrash = () => {
    if (sec !== "trash") prevSec.current = sec;
    setSec("trash");
  };

  const trash = useTrashPage({ open: sec === "trash", initialChip: jump?.sec === "trash" ? jump.trashChip : undefined });
  // 回收站子页 = PageShell 的设置视图。**只在 sec 是回收站时才把 settings 交给 PageShell**：
  // 一交出去主视图页头就会长出齿轮（PageShell 见 settings 就画），而总设置页不该有齿轮 ——
  // 视图的打开由 SettingsBody 在 sec 变成 trash 之后的 layout effect 里调 openSettings()，抢在绘制前，齿轮不会闪出来。
  // 页头：标题「回收站」+ 返回「返回设置」+ 副标题「N 项 · 30 天后自动清」+ 红描边「清空回收站」（次级钮位，
  // 设置视图里没有主按钮）+ 第二行类型芯片；返回 / Esc → onExit 把二级目录选回上一项。
  const settings: PageSettings | undefined = sec === "trash" ? {
    title: t("settings.secTrash"),
    backLabel: t("trash.backToSettings"),
    subtitle: t("trash.headerSub", { count: trash.total, days: trash.keepDays }),
    secondary: [{ label: t("trash.purgeAll"), tone: "danger", disabled: !trash.canPurgeAll, onClick: () => void trash.purgeAll() }],
    secondRow: <TrashChips page={trash} />,
    content: <TrashContent page={trash} />,
    onExit: () => setSec(prevSec.current),
  } : undefined;

  return (
    <PageShell header={{ title: t("settings.title") }} settings={settings}>
      <SettingsBody sec={sec} setSec={setSec} onOpenTrash={openTrash} trashCount={trash.total} />
    </PageShell>
  );
}

// 页头之下的那一层：190 二级目录 + 720 内容列。拆成 PageShell 的子组件是因为 usePageSettings()
// 只在 PageShell 的 children 里拿得到 context —— 点「回收站」要靠它把设置视图打开。
function SettingsBody({ sec, setSec, onOpenTrash, trashCount }: {
  sec: SecKey;
  setSec: (k: SecKey) => void;
  onOpenTrash: () => void;
  /** 回收站三区总数（含聊天消息）：二级目录上那个「N 项」角标。 */
  trashCount: number;
}) {
  const { t, i18n } = useTranslation();
  const { openSettings } = usePageSettings();
  // sec 落到回收站 → 打开设置视图。用 layout effect：这一帧 PageShell 已经拿到 settings（context 里的 openSettings
  // 不再是空操作），又还没绘制，主视图页头那颗齿轮不会闪出来。跳转直达（挂载时 sec 就是 trash）也走这里。
  useLayoutEffect(() => {
    if (sec === "trash") openSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sec]);
  // 写完主进程配置后回读，需要显式触发一次重渲染（config 是模块级缓存，不是 state）。
  const [, bump] = useState(0);
  const [server, setServer] = useState(getServerUrl());
  const [token, setToken] = useState("");
  const [device, setDevice] = useState(getDeviceName());
  const [copied, setCopied] = useState(false);
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
  const cfg = desktop.getDesktopConfig();
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

  // 二级目录（190，tokens.pageTemplate.settings.subNav）：角标分两种语气 ——
  // 快捷键冲突 = 有事要你处理 → 红；回收站条数 = 只是个数字 → 中性。红色是稀缺资源。
  // 回收站条数来自外层的 useTrashPage（挂载就拉），用户没点进回收站时角标也在。
  const nav: SubNavGroup[] = SEC_GROUPS.map((g) => ({
    label: t(g.labelKey),
    items: g.items.map((i) => {
      const Icon = i.icon;
      const badge = i.key === "keys" && dupCount > 0
        ? <span className="px-[6px] rounded-full bg-danger-soft text-danger font-semibold">{dupCount}</span>
        : i.key === "trash" && trashCount > 0
          ? <span className="px-[6px] rounded-full bg-chip text-muted font-semibold">{t("trash.navBadge", { count: trashCount })}</span>
          : undefined;
      return { key: i.key, label: t(i.labelKey), icon: <Icon size={14} />, count: badge };
    }),
  }));

  return (
    // 「回收站」不是内容面，是子页：选它不换内容列，而是把设置视图打开（见 Settings 里 settings 的注释）。
    // 视图盖在整块内容区之上，sec 落在 trash 期间内容列里只留分区标题，看不见也不用画。
    <SettingsPage nav={nav} active={sec} onSelect={(k) => (k === "trash" ? onOpenTrash() : setSec(k as SecKey))}>
      <SettingsSection title={secTitle(sec)} desc={secDesc(sec)}>
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

        {sec === "keys" ? (<>
          {dupCount ? <ErrorCard variant="strip" title={t("settings.keysConflictBanner", { count: dupCount })} /> : null}
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
                    <button className="w-[56px] flex-none text-right text-[12px] whitespace-nowrap bg-transparent text-orange-text" onClick={() => goOwner(o)}>{t("settings.keysGo")}</button>
                  </div>
                );
              })}
            </section>
          )}
          <div className="text-[11.5px] text-faint leading-[1.7]">{t("settings.keysFootnote")}</div>
        </>) : null}

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
      </SettingsSection>
    </SettingsPage>
  );
}
