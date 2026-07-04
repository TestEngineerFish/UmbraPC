// 实时操作页（React + Tailwind）。桌面态：computer-use 开关/权限状态 + 原子动作历史。
import * as desktop from "../services/desktop";
import { chatConn } from "../services/server";
import * as legacy from "../app/shell";

const SKILL_LABEL: Record<string, string> = { click: "点击", type: "输入", key: "按键", scroll: "滚动", open_app: "打开应用", screenshot: "截图", operate: "自主操作" };
const statusColor = (s: string) => (s === "error" ? "text-danger" : s === "ok" ? "text-success" : "text-orange");
const statusDot = (s: string) => (s === "error" ? "bg-danger" : s === "ok" ? "bg-success" : "bg-orange");
const statusText = (s: string) => (s === "error" ? "失败" : s === "ok" ? "完成" : "进行中");

function StopButton() {
  return (
    <button
      onClick={() => {
        desktop.computerStop();
        chatConn.sendOperateStop();
      }}
      className="flex items-center gap-[7px] px-[15px] py-[7px] border-[1.5px] border-danger text-danger bg-danger-soft rounded-lg text-[13px] font-bold cursor-pointer"
    >
      ■ 紧急停止
    </button>
  );
}

export function Realtime() {
  const enabled = legacy.computerEnabled();

  if (!enabled) {
    return (
      <div className="h-full overflow-y-auto p-[18px_22px]">
        <div className="flex items-center justify-between mb-4">
          <h1 className="m-0 text-[16px] font-semibold">实时操作</h1>
        </div>
        <div className="flex flex-col items-center justify-center gap-3 text-muted h-[380px]">
          <span className="w-[54px] h-[54px] rounded-[14px] bg-card border border-border flex items-center justify-center text-[22px]">🖥</span>
          <div className="text-[14px]">computer-use 未开启</div>
          <button onClick={() => legacy.navigate("settings")} className="px-[15px] py-[7px] bg-orange text-white rounded-lg text-[13px] font-semibold cursor-pointer">去设置开启</button>
        </div>
      </div>
    );
  }

  const perms = desktop.getPermissions();
  const ds = desktop.getDeviceState();
  const acts = (ds?.recentTasks || []).filter((t) => t.provider === "computer");
  const running = acts.some((t) => t.status === "running");
  const permOk = perms.accessibility && perms.screen === "granted";

  return (
    <div className="h-full overflow-y-auto p-[18px_22px]">
      <div className="flex items-center justify-between mb-4">
        <h1 className="m-0 text-[16px] font-semibold">实时操作</h1>
        <StopButton />
      </div>

      {!permOk ? (
        <div className="bg-warning-soft border border-warning rounded-[10px] p-[12px_15px] mb-4 flex items-center gap-2.5">
          <span className="w-[7px] h-[7px] rounded-full bg-warning" />
          <span className="text-[13px] text-warning flex-1">
            权限不全：{perms.accessibility ? "" : "辅助功能 "}
            {perms.screen === "granted" ? "" : "屏幕录制 "}未授予，computer-use 无法执行
          </span>
          <button onClick={() => legacy.navigate("settings")} className="px-3 py-[5px] border border-warning text-warning bg-transparent rounded-md text-[12px] font-semibold cursor-pointer">去授权</button>
        </div>
      ) : null}

      <div className="bg-card border border-border rounded-[10px] p-[14px_16px] mb-[18px]">
        {running ? (
          <div className="text-[12px] text-orange-text flex items-center gap-1.5">
            <span className="w-[7px] h-[7px] rounded-full bg-orange" />
            正在执行电脑操作…
          </div>
        ) : (
          <div className="text-[13px] text-muted">当前没有进行中的电脑操作。v0 支持原子动作（点击/输入/按键/滚动/打开应用/截图）；operate 自主操作尚未接入决策引擎。</div>
        )}
      </div>

      <div className="text-[12px] text-muted font-semibold mb-[9px]">动作历史（最新在上）</div>
      <div className="bg-card border border-border rounded-[10px] overflow-hidden">
        {acts.length ? (
          acts.map((t, i) => (
            <div key={i} className={`p-[10px_14px] ${i < acts.length - 1 ? "border-b border-border" : ""} ${t.status === "running" ? "bg-orange-soft" : ""}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${statusDot(t.status)}`} />
                <span className="text-[13px] font-semibold">{SKILL_LABEL[t.skill] || t.skill}</span>
                <span className="text-[10.5px] text-muted font-mono">{t.skill}</span>
                <span className="flex-1" />
                <span className={`text-[11px] shrink-0 ${statusColor(t.status)}`}>{statusText(t.status)}</span>
                <span className="text-[11px] text-muted shrink-0">{new Date(t.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              </div>
              <div className={`text-[12.5px] leading-[1.55] break-words pl-[15px] ${t.status === "error" ? "text-danger" : "text-text"}`}>{t.message}</div>
            </div>
          ))
        ) : (
          <div className="p-4 text-muted text-[12.5px]">暂无动作记录</div>
        )}
      </div>
    </div>
  );
}
