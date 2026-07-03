// 日志页（React + Tailwind）。桌面态展示设备引擎真实日志。
import * as desktop from "../desktop";

export function Logs() {
  const lines = desktop.getDeviceLogs();
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between px-[22px] py-[14px] border-b border-border shrink-0 gap-3">
        <h1 className="m-0 text-[16px] font-semibold">日志</h1>
        <button className="flex items-center gap-1.5 px-3 py-1.5 border border-border bg-card text-text rounded-lg text-[12.5px] cursor-pointer">打开日志文件夹</button>
      </div>
      <div className="flex-1 overflow-y-auto px-[22px] py-[14px] font-mono text-[12px] leading-[1.95] min-h-0">
        {lines.length ? (
          lines.map((l, i) => (
            <div key={i} className="text-text break-all">
              {l}
            </div>
          ))
        ) : (
          <div className="text-muted">暂无设备引擎日志（等待连接/注册）…</div>
        )}
      </div>
    </div>
  );
}
