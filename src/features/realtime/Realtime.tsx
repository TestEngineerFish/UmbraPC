// 实时操作页（React + Tailwind）。桌面态：computer-use 开关/权限状态 + 原子动作历史。
import { useTranslation } from "react-i18next";
import * as desktop from "../../services/desktop";
import { chatConn } from "../../services/server";
import * as legacy from "../../app/shell";

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

function StopButton() {
  const { t } = useTranslation();
  return (
    <button
      onClick={() => {
        desktop.computerStop();
        chatConn.sendOperateStop();
      }}
      className="flex items-center gap-[7px] px-[15px] py-[7px] border-[1.5px] border-danger text-danger bg-danger-soft rounded-lg text-[13px] font-bold cursor-pointer"
    >
      {t("realtime.emergencyStop")}
    </button>
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

  if (!enabled) {
    return (
      <div className="h-full overflow-y-auto p-[18px_22px]">
        <div className="flex items-center justify-between mb-4">
          <h1 className="m-0 text-[16px] font-semibold">{t("realtime.title")}</h1>
        </div>
        <div className="flex flex-col items-center justify-center gap-3 text-muted h-[380px]">
          <span className="w-[54px] h-[54px] rounded-[14px] bg-card border border-border flex items-center justify-center text-[22px]">🖥</span>
          <div className="text-[14px]">{t("realtime.notEnabled")}</div>
          <button onClick={() => legacy.navigate("settings")} className="px-[15px] py-[7px] bg-orange text-white rounded-lg text-[13px] font-semibold cursor-pointer">{t("realtime.goSettings")}</button>
        </div>
      </div>
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
    <div className="h-full overflow-y-auto p-[18px_22px]">
      <div className="flex items-center justify-between mb-4">
        <h1 className="m-0 text-[16px] font-semibold">{t("realtime.title")}</h1>
        <StopButton />
      </div>

      {!permOk ? (
        <div className="bg-warning-soft border border-warning rounded-[10px] p-[12px_15px] mb-4 flex items-center gap-2.5">
          <span className="w-[7px] h-[7px] rounded-full bg-warning" />
          <span className="text-[13px] text-warning flex-1">{t("realtime.permIncomplete", { missing: missingPerms })}</span>
          <button onClick={() => legacy.navigate("settings")} className="px-3 py-[5px] border border-warning text-warning bg-transparent rounded-md text-[12px] font-semibold cursor-pointer">{t("common.goAuthorize")}</button>
        </div>
      ) : null}

      <div className="bg-card border border-border rounded-[10px] p-[14px_16px] mb-[18px]">
        {running ? (
          <div className="text-[12px] text-orange-text flex items-center gap-1.5">
            <span className="w-[7px] h-[7px] rounded-full bg-orange" />
            {t("realtime.executing")}
          </div>
        ) : (
          <div className="text-[13px] text-muted">{t("realtime.idleHint")}</div>
        )}
      </div>

      <div className="text-[12px] text-muted font-semibold mb-[9px]">{t("realtime.history")}</div>
      <div className="bg-card border border-border rounded-[10px] overflow-hidden">
        {acts.length ? (
          acts.map((a, i) => (
            <div key={i} className={`p-[10px_14px] ${i < acts.length - 1 ? "border-b border-border" : ""} ${a.status === "running" ? "bg-orange-soft" : ""}`}>
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
          ))
        ) : (
          <div className="p-4 text-muted text-[12.5px]">{t("realtime.noHistory")}</div>
        )}
      </div>
    </div>
  );
}
