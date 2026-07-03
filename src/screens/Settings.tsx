// 设置页（React + Tailwind）。受控输入，不再整页重建 → 根治失焦 / 滚动跳顶。
// 业务逻辑复用 server.ts / desktop.ts 与 main.ts 导出的处理器。
import { useState } from "react";
import { chatConn, getServerUrl, getDeviceName } from "../server";
import * as desktop from "../desktop";
import * as legacy from "../main";

const hasClip = typeof (window as unknown as { umbraClip?: unknown }).umbraClip !== "undefined";
const hasShot = typeof (window as unknown as { umbraShot?: unknown }).umbraShot !== "undefined";

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
  const [server, setServer] = useState(getServerUrl());
  const [token, setToken] = useState("");
  const [device, setDevice] = useState(getDeviceName());
  const [glmKey, setGlmKey] = useState("");

  const isDesk = desktop.isDesktop();
  const cs = chatConn.status as "online" | "connecting" | "offline";
  const ds = desktop.getDeviceState();
  const perms = desktop.getPermissions();
  const cfg = desktop.getDesktopConfig();
  const codingMode = legacy.getCodingMode();
  const cuOn = legacy.computerEnabled();
  const clip = legacy.getClipState();
  const shot = legacy.getShotState();

  const csLabel = cs === "online" ? "已连接" : cs === "connecting" ? "连接中…" : "未连接";
  const engStatus = (ds?.status || "offline") as "online" | "connecting" | "offline";
  const engLabel = engStatus === "online" ? "运行中" : engStatus === "connecting" ? "连接中…" : "未连接";

  return (
    <div id="scroll-main" className="h-full overflow-y-auto p-[18px_22px]">
      <h1 className="m-0 mb-4 text-[16px] font-semibold">设置</h1>
      <div className="flex flex-col gap-[14px] max-w-[680px]">
        {/* 连接 */}
        <Card title="连接">
          <Row label="服务端地址">
            <input value={server} onChange={(e) => setServer(e.target.value)} className={`${input} font-mono`} />
          </Row>
          <Row label="访问 Token">
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={legacy.tokenPlaceholder()} className={`${input} font-mono tracking-widest`} />
          </Row>
          <Row label="连接状态">
            <span className="inline-flex items-center gap-[7px] text-[13px]">
              <StatusDot kind={cs} />
              {csLabel}
            </span>
            <span className="flex-1" />
            <button className={btnGhost} onClick={() => legacy.applyConnection(server, token, device)}>保存并重连</button>
          </Row>
        </Card>

        {/* 设备引擎 */}
        {isDesk ? (
          <Card title="设备引擎">
            <Row label="引擎状态">
              <span className="inline-flex items-center gap-[7px] text-[13px]">
                <StatusDot kind={engStatus} />
                {engLabel}
              </span>
              <span className="flex-1" />
              <span className="text-[12px] text-muted">查看「日志」页排错</span>
            </Row>
            <Row label="可用程序">
              <span className="text-[13px]">{ds ? ds.providers.filter((p) => p.available).length : 0} 个</span>
            </Row>
            <Row label="任务">
              <span className="text-[12.5px] text-muted">{ds && ds.recentTasks[0] ? `${ds.recentTasks[0].provider}.${ds.recentTasks[0].skill} · ${ds.recentTasks[0].message}` : "暂无任务"}</span>
            </Row>
            <Row label="最近日志">
              <span className="text-[12px] text-muted font-mono flex-1 break-all">{desktop.getDeviceLogs()[0] || "（无日志）"}</span>
            </Row>
          </Card>
        ) : null}

        {/* 设备 */}
        <Card title="设备">
          <Row label="设备 ID">
            <span className="text-[13px] font-mono text-text">{legacy.deviceIdLabel()}</span>
          </Row>
          <Row label="设备名">
            <input value={device} onChange={(e) => setDevice(e.target.value)} className={input} />
          </Row>
        </Card>

        {/* 权限 */}
        <Card title="权限" sub="macOS">
          <PermRow title="辅助功能" desc="允许控制其它应用（点击、输入）" granted={perms.accessibility} onGrant={() => desktop.openPrivacy("accessibility")} />
          <PermRow title="屏幕录制" desc="用于截图与 computer-use 监看" granted={perms.screen === "granted"} onGrant={() => desktop.openPrivacy("screen")} />
          <div className="flex items-center gap-3 py-3">
            <div className="flex-1">
              <div className="text-[13.5px]">computer-use 总开关</div>
              <div className="text-[11.5px] text-muted mt-px">允许 AI 像人一样操作本机软件（默认关）</div>
            </div>
            <Toggle on={cuOn} onClick={() => legacy.toggleComputerUse()} />
          </div>
        </Card>

        {/* 能力配置 */}
        <Card title="能力配置">
          <Row label="providers.json">
            <span className="flex-1 text-[12px] font-mono text-muted break-all">{cfg?.providersFile || "（仅桌面应用可用）"}</span>
            <button className={btnGhost} onClick={() => desktop.openProvidersFile()}>编辑</button>
          </Row>
          <Row label="coding 权限">
            <div className="flex border border-border rounded-lg overflow-hidden">
              {["只生成", "执行前确认", "直接执行"].map((t, i) => (
                <button key={t} onClick={() => legacy.setCodingMode(i)} className={`px-[13px] py-1.5 text-[12.5px] ${i < 2 ? "border-r border-border" : ""} ${codingMode === i ? "bg-orange text-white font-semibold" : "bg-transparent text-text"}`}>
                  {t}
                </button>
              ))}
            </div>
          </Row>
        </Card>

        {/* 剪贴板历史 */}
        {hasClip ? (
          <Card title="剪贴板历史">
            <Row label="开启历史记录">
              <span className="flex-1 text-[12px] text-muted">后台监听剪贴板，{clip.enabled ? "已开启" : "已关闭（历史保留）"}</span>
              <Toggle on={clip.enabled} onClick={() => legacy.toggleClipEnabled()} />
            </Row>
            <Row label="面板快捷键">
              <button onClick={() => legacy.beginShortcutRecording("clip")} className={`flex-1 text-left border rounded-lg px-[11px] py-[7px] text-[13px] font-mono bg-bg text-text ${clip.recording ? "border-orange" : "border-border"}`}>
                {clip.recording ? "按下快捷键…（Esc 取消）" : clip.shortcut}
              </button>
            </Row>
            <Row label="清空历史">
              <span className="flex-1 text-[12px] text-muted">删除全部非收藏条目（收藏保留）</span>
              <button className="px-[13px] py-[6px] border border-danger text-danger bg-transparent rounded-lg text-[12.5px]" onClick={() => legacy.clearClipHistory()}>清空</button>
            </Row>
          </Card>
        ) : null}

        {/* 截图 */}
        {hasShot ? (
          <Card title="截图">
            <Row label="开启截图">
              <span className="flex-1 text-[12px] text-muted">{shot.enabled ? "已开启" : "已关闭（不注册快捷键）"}；需「屏幕录制」权限</span>
              <Toggle on={shot.enabled} onClick={() => legacy.toggleShotEnabled()} />
            </Row>
            <Row label="截图快捷键">
              <button onClick={() => legacy.beginShortcutRecording("shot")} className={`flex-1 text-left border rounded-lg px-[11px] py-[7px] text-[13px] font-mono bg-bg text-text ${shot.recording ? "border-orange" : "border-border"}`}>
                {shot.recording ? "按下快捷键…（Esc 取消）" : shot.shortcut}
              </button>
            </Row>
            <Row label="翻译 Key">
              <input type="password" value={glmKey} onChange={(e) => setGlmKey(e.target.value)} placeholder={shot.hasGlmKey ? "已设置（智谱 GLM）" : "智谱 GLM API Key（翻译用）"} className={`${input} font-mono`} />
              <button className={btnGhost} onClick={() => { legacy.setShotGlmKey(glmKey); setGlmKey(""); }}>保存</button>
            </Row>
          </Card>
        ) : null}

        {/* 关于 */}
        <section className="bg-card border border-border rounded-xl p-[16px_18px] flex items-center gap-[14px]">
          <div className="flex-1">
            <div className="font-semibold">关于</div>
            <div className="text-[12px] text-muted mt-[3px]">Umbra 桌面客户端 · v0.1.0 (electron)</div>
          </div>
          <button className={btnGhost}>检查更新</button>
        </section>
      </div>
    </div>
  );
}

function PermRow({ title, desc, granted, onGrant }: { title: string; desc: string; granted: boolean; onGrant: () => void }) {
  return (
    <div className="flex items-center gap-3 py-3 border-b border-border">
      <div className="flex-1">
        <div className="text-[13.5px]">{title}</div>
        <div className="text-[11.5px] text-muted mt-px">{desc}</div>
      </div>
      {granted ? (
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-success font-semibold">✓ 已授予</span>
      ) : (
        <>
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-warning font-semibold">
            <span className="w-[7px] h-[7px] rounded-full bg-warning" />未授予
          </span>
          <button className="px-3 py-[5px] border border-warning text-warning bg-transparent rounded-md text-[12px] font-semibold" onClick={onGrant}>去授权</button>
        </>
      )}
    </div>
  );
}
