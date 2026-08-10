// 快捷键录制的 UI 与行为 —— 六处入口共用这一份
// （剪贴板 / 常用语 / 截图 / 快捷入口 / 保险箱 / 工作流的 Hotkey 节点）。
//
// 纯逻辑（e.code → Accelerator、按平台显示）在 ./hotkey.ts，那边有单测。
// 这里只管三件事：挂监听、录制期间关掉全局快捷键、把三态画出来。
//
// ── 录制期间必须 pauseShortcuts ─────────────────────────────────────────────
// 不关的话，用户想录 Alt+Space，按下去先被**我们自己注册的**快捷入口截走，
// 弹出快捷入口面板，焦点跑了，录制自然也就录不成了 —— 表现正是「按了没反应」。
// 剪贴板/截图那条老路一直有这一步，另外两处一直没有，于是「有的页面能录、
// 有的不能」，还没人说得清区别在哪。现在统一在这里做。
//
// ⚠️ 治得了自家的，治不了别人的：第三方 App 和系统级快捷键（Spotlight 的
// Command+Space、切换应用的 Command+Tab）在更底层就被截走，Electron 收不到
// keydown，任何前端手段都录不到。这类只能靠录完之后主进程 checkAccel 的
// 系统快捷键表来提示，没法在录制阶段拦住。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import * as desktop from "../services/desktop";
import { displayAccel, readLayout, toAccelerator, type LayoutMap } from "./hotkey";

// 「当前有没有录制在进行」。给弹窗一类「按 Esc 关闭」的容器让路用 ——
// 捕获阶段的多个监听按注册先后触发，弹窗先挂上，录制时按 Esc 会先被弹窗吃掉、
// 直接把窗关了，而用户的本意只是取消这次录制。
// 用计数不用布尔：一个弹窗里可能摆两个录制框。
let recordingCount = 0;
export function isRecordingHotkey(): boolean {
  return recordingCount > 0;
}

/**
 * 录制一次快捷键。
 *
 * onCapture 拿到的是 Electron Accelerator（"Alt+Shift+V"）——**存这个值**，
 * 显示再用 displayAccel 转。onCancel 是按了 Esc 或再点一次按钮。
 */
export function useHotkeyRecorder(onCapture: (accel: string) => void) {
  const [recording, setRecording] = useState(false);
  // 用 ref 存回调：录制中父组件重渲染不该重挂监听（重挂那一瞬间的按键会漏）。
  const cb = useRef(onCapture);
  cb.current = onCapture;

  const start = useCallback(() => setRecording(true), []);
  const stop = useCallback(() => setRecording(false), []);

  useEffect(() => {
    if (!recording) return;
    let alive = true;
    let layout: LayoutMap = null;
    // 布局是异步读的，先挂监听再补上：手快的用户在这几毫秒里按下键也不会漏，
    // 只是那一次退回按 code 推断（非 QWERTY 布局才有区别）。
    void readLayout().then((m) => { if (alive) layout = m; });

    recordingCount++;
    desktop.pauseShortcuts();

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        // 光按 Esc = 取消；带修饰键的 Esc（如 ⌥⇧Esc）是用户真想录的键位。
        setRecording(false);
        return;
      }
      const acc = toAccelerator(e, layout);
      if (!acc) return;                       // 只按了修饰键 → 继续等
      cb.current(acc);
      setRecording(false);
    };

    window.addEventListener("keydown", onKey, true);
    return () => {
      alive = false;
      recordingCount--;
      window.removeEventListener("keydown", onKey, true);
      // 恢复全局快捷键。新键位如果已经保存，各自的 setShortcut 里已经注册过，
      // 这里再重注册一遍是幂等的（主进程 reregisterShortcuts 先全清再重来）。
      desktop.resumeShortcuts();
    };
  }, [recording]);

  return { recording, start, stop, toggle: () => setRecording((v) => !v) };
}

// 快捷键可用性检测的结果（主进程 electron/core/launcher/hotkey.ts 的返回形状）。
export interface AccelCheck { state: string; by?: string; message?: string }

/**
 * 三态录制按钮：空=虚线框，录制中=橙底+圆点，已录=chip 底等宽字。
 *
 * check：录到键位后拿去问主进程「这个键能用吗」。做成注入而不是在这里直接调 IPC，
 * 是为了让这一层保持纯展示 —— 它没有任何 window.umbraLauncher 依赖。
 */
export function HotkeyRecorder({ value, onChange, hint, check, labels }: {
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  check?: (accel: string) => Promise<AccelCheck>;
  /** 文案。不传就用工作流节点弹窗里的那套中文。 */
  labels?: Partial<Record<"pressing" | "empty" | "clear" | "hintRecording" | "hintDone" | "hintEmpty", string>>;
}) {
  const [chk, setChk] = useState<AccelCheck | null>(null);
  const { recording, start, stop } = useHotkeyRecorder(onChange);

  // 键位一变就重新检测。带 seq 防竞态：连续改两次时，先发的请求可能后回来，
  // 不管的话界面上会留着上一个键位的结论 —— 而且看起来完全像是当前键位的结论。
  const seq = useRef(0);
  useEffect(() => {
    if (!check || !value) { setChk(null); return; }
    const mine = ++seq.current;
    void check(value).then((r) => { if (seq.current === mine) setChk(r); })
      .catch(() => { /* 检测不了就不提示，别拦着用 */ });
  }, [value, check]);

  const L = {
    pressing: "按下快捷键…", empty: "设置快捷键", clear: "清除",
    // 录制中这句话要把「按了没反应」解释清楚：被系统或别的 App 占着的组合
    // （比如 Spotlight 的 ⌘Space）在更底层就被截走了，这里根本收不到按键，
    // 不说明的话用户只会以为是录制坏了，反复按同一个组合。
    hintRecording: "松手即录入，Esc 取消。被系统或别的应用占着的组合这里收不到，换一个就行。",
    hintDone: "点按钮可以重录。", hintEmpty: "至少要带一个修饰键。",
    ...labels,
  };
  const base = "flex-none whitespace-nowrap flex items-center gap-[7px] px-[13px] py-[6px] rounded-[8px] text-[12.5px]";

  return (
    <>
      <div className="flex items-center gap-[8px]">
        {recording ? (
          <button onClick={stop} className={`${base} border border-orange bg-orange-soft text-orange-text`}>
            <span className="w-[7px] h-[7px] rounded-full bg-orange flex-none" />{L.pressing}
          </button>
        ) : value ? (
          // 显示走 displayAccel：存的是 "Alt+Shift+V"，Mac 上要显示成 ⌥⇧V。
          <button onClick={start} className={`${base} border border-border bg-chip text-text font-mono`}>{displayAccel(value)}</button>
        ) : (
          <button onClick={start} className={`${base} border border-dashed border-border bg-transparent text-muted`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>{L.empty}
          </button>
        )}
        {value && !recording ? (
          <button onClick={() => onChange("")}
            className="flex-none whitespace-nowrap px-[11px] py-[6px] border border-border rounded-[8px] text-[12px] bg-transparent hover:border-danger hover:text-danger">{L.clear}</button>
        ) : null}
      </div>
      {/* 下面两块的样式是照 nodeform 的 Hint / Note 抄的。**故意重复而不是 import**：
          components/ 不该反过来依赖 features/。两边样式要一起改。 */}
      <div className="text-[11.5px] text-faint leading-[1.55] mt-[6px] [text-wrap:pretty]">
        {recording ? L.hintRecording : value ? <>{L.hintDone}{hint}</> : <>{L.hintEmpty}{hint}</>}
      </div>
      {/* system / taken / self / invalid 都是「按了不会触发」，红；common 是「能触发但会误伤」，黄 */}
      {!recording && chk && chk.state !== "free" && chk.message ? (
        <div className={`flex items-start gap-[9px] px-[11px] py-[9px] border rounded-[8px] mt-[6px] ${
          chk.state === "common"
            ? "border-warning bg-warning-soft text-warning"
            : "border-danger bg-danger-soft text-danger"}`}>
          <span className="flex-none flex pt-[1px]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.01" />
            </svg>
          </span>
          <div className="flex-1 min-w-0 text-[12px] leading-[1.65] text-text [text-wrap:pretty]">{chk.message}</div>
        </div>
      ) : null}
    </>
  );
}
