// 实时操作页（React + Tailwind）。桌面态：computer-use 开关/权限状态 + 原子动作历史。
// 批次 012 起套页面骨架的 **T4 仪表盘**：
//   页头：标题 + 副标题（已开启 / 已关闭）+ 齿轮 → 本页的「电脑操作设置」视图（T3：权限 + 电脑操作授权，
//         分区从总设置搬来，见 features/settings/sections.tsx）。
//   内容：Dashboard 滚动容器 → 权限不全的 warning 横幅 → StatusCard（状态点 + 「紧急停止」danger 钮，
//         破坏性动作不进页头主按钮位）→ 「历史」DashCard（行保留原样，没有历史用卡的 empty）。
//   未开启：通用 EmptyState，动作「去设置」直接打开本页设置视图（usePageSettings）；
//   权限不全的横幅第三段同样是「去设置」—— 总开关和权限都在本页设置视图的「权限」分区。
import { useTranslation } from "react-i18next";
import * as desktop from "../../services/desktop";
import { chatConn } from "../../services/server";
import * as legacy from "../../app/shell";
import { IconStop, IconMonitor } from "../../components/icons";
import { btnRow, EmptyState, ErrorCard } from "../../components/ui";
import { PageShell, usePageSettings, Dashboard, DashCard, StatusCard, SettingsPage, SettingsSection } from "../../components/layout";
import { PermSection, OpsSection } from "../settings/sections";

const SKILL_KEYS: Record<string, string> = {
  click: "realtime.skillClick",
  type: "realtime.skillType",
  key: "realtime.skillKey",
  scroll: "realtime.skillScroll",
  open_app: "realtime.skillOpenApp",
  screenshot: "realtime.skillScreenshot",
  operate: "realtime.skillOperate",
};
const statusColor = (s: string) => (s === "error" ? "text-danger" : s === "ok" ? "text-success" : "text-orange");
const statusDot = (s: string) => (s === "error" ? "bg-danger" : s === "ok" ? "bg-success" : "bg-orange");

// EmptyState 只收一条 path 字符串；这里抄的是 icons.tsx 里 IconMonitor 的那条（稿 1928 的 24px 显示器）。
const MONITOR_PATH = "M20.5 12.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h6M12.5 10.5 16 19.5l1.3-3.8 3.8-1.3z";

function StopButton() {
  const { t } = useTranslation();
  return (
    <button
      onClick={() => {
        desktop.computerStop();
        chatConn.sendOperateStop();
      }}
      // 破坏性动作 = kit 的 danger（描边红）。之前是一份私有的 1.5px 红描边 + 软底 + 粗体。
      className={btnRow("danger", "sm")}
    >
      {/* 稿 1921 是 14px 线性方块、描边 2.2；之前是把「■」拼在 i18n 文案里。 */}
      <IconStop size={14} />{t("realtime.emergencyStop")}
    </button>
  );
}

/** 电脑操作设置（T3）：权限三项 + 总开关，以及 7 个技能的授权档。两组以下不给二级目录。 */
function RealtimeSettings() {
  const { t } = useTranslation();
  return (
    <SettingsPage>
      <SettingsSection title={t("settings.secPerm")} desc={t("settings.secPermDesc")}>
        <PermSection />
      </SettingsSection>
      <SettingsSection title={t("settings.secOps")} desc={t("settings.secOpsDesc")}>
        <OpsSection />
      </SettingsSection>
    </SettingsPage>
  );
}

export function Realtime() {
  const { t } = useTranslation();
  const enabled = legacy.computerEnabled();

  const statusText = (s: string) => (s === "error" ? t("realtime.statusError") : s === "ok" ? t("realtime.statusOk") : t("realtime.statusRunning"));
  const skillLabel = (skill: string) => {
    const key = SKILL_KEYS[skill];
    return key ? t(key) : skill;
  };

  const settings = {
    title: t("realtime.settingsTitle"),
    backLabel: t("realtime.backLabel"),
    content: <RealtimeSettings />,
  };

  if (!enabled) {
    return (
      <PageShell header={{ title: t("realtime.title"), subtitle: t("realtime.statusOff") }} settings={settings}>
        {/* 未开启：通用空态（offline 档 = 警示色，「要你动手才能用」的语义）。
            总开关就在本页设置视图的「权限」分区 —— 动作按钮直接把设置视图打开（usePageSettings）。 */}
        <NotEnabledEmpty />
      </PageShell>
    );
  }

  const perms = desktop.getPermissions();
  const ds = desktop.getDeviceState();
  const acts = (ds?.recentTasks || []).filter((a) => a.provider === "computer");
  const running = acts.some((a) => a.status === "running");
  const permOk = perms.accessibility && perms.screen === "granted";

  const missingPerms = [
    !perms.accessibility ? t("realtime.permAccessibility") : "",
    perms.screen !== "granted" ? t("realtime.permScreen") : "",
  ].join("");

  return (
    <PageShell header={{ title: t("realtime.title"), subtitle: t("common.enabled") }} settings={settings}>
      <Dashboard>
        {/* 权限不全：错误卡的横幅态（提醒级 warning），第三段「去设置」打开本页设置视图。 */}
        {!permOk ? <PermStrip missing={missingPerms} /> : null}

        {/* 当前状态卡：状态点按总开关（走到这里一定是开着的）；执行中标题换成「正在执行…」。
            「紧急停止」是破坏性动作，放卡的动作位，不进页头。 */}
        <StatusCard
          dot="success"
          icon={<IconMonitor size={16} />}
          title={running ? t("realtime.executing") : t("common.enabled")}
          sub={running ? undefined : t("realtime.idleHint")}
          actions={<StopButton />}
        />

        {/* 历史：一张 DashCard，行保留原样（状态点 + 技能名 + 技能 key + 状态 + 时间 / 正文）。
            行用负边距顶到卡边，执行中那行的橙软底才能铺满整宽。 */}
        <DashCard title={t("realtime.history")} empty={!acts.length}>
          <div className="-mx-[17px] -mb-[15px] rounded-b-[11px] overflow-hidden flex flex-col">
            {acts.map((a, i) => (
              <div key={i} className={`p-[10px_17px] border-t border-border-soft ${a.status === "running" ? "bg-orange-soft" : ""}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${statusDot(a.status)}`} />
                  <span className="text-[13px] font-semibold">{skillLabel(a.skill)}</span>
                  <span className="text-[10.5px] text-muted font-mono">{a.skill}</span>
                  <span className="flex-1" />
                  <span className={`text-[11px] shrink-0 ${statusColor(a.status)}`}>{statusText(a.status)}</span>
                  <span className="text-[11px] text-muted shrink-0">{new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                </div>
                <div className={`text-[12.5px] leading-[1.55] break-words pl-[15px] ${a.status === "error" ? "text-danger" : "text-text"}`}>{a.message}</div>
              </div>
            ))}
          </div>
        </DashCard>
      </Dashboard>
    </PageShell>
  );
}

// 未开启态的空态：第三段是「去设置」—— 直接打开本页设置视图（context 来自 PageShell）。
function NotEnabledEmpty() {
  const { t } = useTranslation();
  const { openSettings } = usePageSettings();
  return (
    <EmptyState kind="offline" icon={MONITOR_PATH} title={t("realtime.notEnabled")}
      hint={t("realtime.enableHint")} actionLabel={t("realtime.goSettings")} onAction={openSettings} />
  );
}

// 权限不全：错误卡横幅态（提醒级 warning），第三段是可点的「去授权」→ 打开设置视图。
function PermStrip({ missing }: { missing: string }) {
  const { t } = useTranslation();
  const { openSettings } = usePageSettings();
  return (
    <ErrorCard variant="strip" kind="warning" title={t("realtime.permIncomplete", { missing })}
      reason={t("realtime.permHint")} actions={[{ label: t("realtime.goSettings"), onClick: openSettings }]} />
  );
}
