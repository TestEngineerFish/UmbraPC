// 全局快捷键的唯一数据源：五处快捷键（剪贴板 / 常用语 / 截图 / 快捷入口 / 保险箱）分散在各自的 preload 桥里，
// 这里统一读一遍并做归一化比较，好让「各工具详情页编辑」与「设置页总览+冲突检测」用同一份数据 —— 否则会出现
// 「横幅说冲突、表格里却不冲突」这种自相矛盾。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as legacy from "../../app/shell";
import { clipApi, launcherApi, vaultApi, hasClip, hasShot, hasLauncher, hasVault } from "./bridges";
import { IconAlert } from "../../components/icons";
import { displayAccel } from "../../components/hotkey";

// 快捷键的归属方。新增一处全局快捷键时，只需在这里、OWNER_LABEL 与 readHotkeys 各加一行。
export type HotkeyOwner = "clip" | "phrases" | "shot" | "launcher" | "vault";

// 归属方 → 展示名词条（复用各工具页已有的标题词条，避免同一功能两套叫法）。
export const OWNER_LABEL: Record<HotkeyOwner, string> = {
  clip: "settings.clipboard",
  phrases: "settings.phrases",
  shot: "settings.screenshot",
  launcher: "settings.launcher",
  vault: "settings.vault",
};

// 比较用的固定顺序：归一化后修饰键一律按 Command → Control → Alt → Shift 排列，
// 这样 "Alt+Command+V" 与 "Command+Alt+V" 会判成同一个键。
const MOD_ORDER = ["Command", "Control", "Alt", "Shift"];

// 当前是否 macOS：CommandOrControl 在 mac 上落到 Command，其余平台落到 Control，两边要按同一规则展开才能比。
const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent || "");

// Electron Accelerator 归一化：展开 CommandOrControl、统一 Cmd/Ctrl/Option 的别名、修饰键排序、主键大小写归一。
// 拿不到主键（只按了修饰键）时返回空串，调用方据此跳过比较。
export function normAcc(acc: string): string {
  if (!acc) return "";
  const mods: string[] = [];
  let key = "";
  for (const raw of acc.split("+")) {
    const part = raw.trim();
    if (!part) continue;
    const low = part.toLowerCase();
    if (low === "commandorcontrol" || low === "cmdorctrl") mods.push(IS_MAC ? "Command" : "Control");
    else if (low === "command" || low === "cmd" || low === "meta" || low === "super") mods.push("Command");
    else if (low === "control" || low === "ctrl") mods.push("Control");
    else if (low === "alt" || low === "option") mods.push("Alt");
    else if (low === "shift") mods.push("Shift");
    else key = part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  }
  if (!key) return "";
  return [...MOD_ORDER.filter((m) => mods.includes(m)), key].join("+");
}

// 汇总当前五处快捷键。每一处都单独 try/catch：某个桥没注入或调用失败时只是少一条，不该拖垮整个冲突检测。
export async function readHotkeys(): Promise<Partial<Record<HotkeyOwner, string>>> {
  const out: Partial<Record<HotkeyOwner, string>> = {};
  if (hasClip) {
    out.clip = legacy.getClipState().shortcut;
    try {
      const s = await clipApi().getSettings();
      if (s.phrasesShortcut) out.phrases = s.phrasesShortcut;
    } catch { /* 桥不可用时跳过 */ }
  }
  if (hasShot) out.shot = legacy.getShotState().shortcut;
  if (hasLauncher) {
    try { out.launcher = (await launcherApi().getSettings()).shortcut; } catch { /* 同上 */ }
  }
  if (hasVault) {
    try { out.vault = (await vaultApi().status()).shortcut; } catch { /* 同上 */ }
  }
  return out;
}

// 检测 self 这一处的键位 acc 是否和别处撞车，撞了返回对方的归属方，没撞返回 null。
// acc 变化时重读一次：用户刚在本页改完键，别处的值也可能因此需要重新比较。
export function useHotkeyConflict(self: HotkeyOwner, acc: string): HotkeyOwner | null {
  const [map, setMap] = useState<Partial<Record<HotkeyOwner, string>>>({});
  useEffect(() => {
    let alive = true;
    void readHotkeys().then((m) => { if (alive) setMap(m); });
    return () => { alive = false; };
  }, [acc]);
  const mine = normAcc(acc);
  if (!mine) return null;
  const hit = (Object.keys(OWNER_LABEL) as HotkeyOwner[]).find((o) => o !== self && normAcc(map[o] || "") === mine);
  return hit || null;
}

// 冲突提示横幅：橙色（待处理，不是错误——两个键都注册得上，只是系统里先注册的那个会赢）。
export function HotkeyConflictBanner({ owner }: { owner: HotkeyOwner }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-[8px] rounded-[9px] bg-warning-soft text-warning px-[12px] py-[8px] text-[12px] font-medium">
      <span className="flex-none flex"><IconAlert size={14} /></span>
      <span className="min-w-0">{t("tools.hotkeyConflict", { owner: t(OWNER_LABEL[owner]) })}</span>
    </div>
  );
}

// 快捷键采集框：看着像输入框，实际是按钮——点一下进入录制态，再按组合键即保存。
// 录制中整框转橙，比只换一句提示文案更容易被注意到。
export function HotkeyButton({ recording, value, onClick }: { recording: boolean; value: string; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      className={`flex-1 min-w-0 text-left border rounded-[8px] px-[11px] py-[7px] text-[12.5px] font-mono cursor-pointer bg-bg ${recording ? "border-orange text-orange-text" : "border-border text-text"}`}
    >
      {/* 存的是 Electron Accelerator（"Alt+Shift+V"），显示要按平台转 ——
          Mac 上没有叫 Alt 的键，用户会去找一个不存在的键帽。 */}
      {recording ? t("settings.pressShortcut") : displayAccel(value) || t("common.none")}
    </button>
  );
}
