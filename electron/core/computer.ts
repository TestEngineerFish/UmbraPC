// computer Provider：GUI 自动化（高权限，默认关）。v0 仅原子动作 + operate 占位。
// 安全：总开关注册门禁 + 系统权限校验 + 应用黑名单 + 关键动作执行前确认。
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { httpBase, UmbraConfig } from "./config";
import { mt, getMainLocale } from "../i18n";
import { Confirm, Manifest, Registry, Report } from "./providers/registry";
import { uploadFile } from "./shared/upload";
import { run } from "./shared/util";

// 紧急停止标志：operate 循环（后续接入）会检查它；原子动作无循环可停。
let stopRequested = false;
export function requestStop(): void {
  stopRequested = true;
}
export function isStopRequested(): boolean {
  return stopRequested;
}

// 当前前台应用名（macOS）。
async function frontmostApp(): Promise<string> {
  if (process.platform !== "darwin") return "";
  const res = await run("osascript", ["-e", 'tell application "System Events" to name of first application process whose frontmost is true'], { timeoutMs: 4000 });
  return (res.output || "").trim();
}

function blacklisted(name: string, list: string[]): boolean {
  const n = (name || "").toLowerCase();
  return !!n && list.some((b) => b && n.includes(b.toLowerCase()));
}

// 屏幕录制权限（截图需要）。
async function requireScreen(): Promise<void> {
  if (process.platform !== "darwin") return;
  const { systemPreferences } = await import("electron");
  if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    throw new Error(mt("electron.screenPermDenied", undefined, getMainLocale()));
  }
}
// 辅助功能权限（点击/输入/按键/滚动需要；截图与打开应用不需要）。
async function requireAccessibility(): Promise<void> {
  if (process.platform !== "darwin") return;
  const { systemPreferences } = await import("electron");
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    throw new Error(mt("electron.accessibilityDenied", undefined, getMainLocale()));
  }
}

// 懒加载 nut.js（避免无界面环境在加载期就拉起原生库）。
async function loadNut(): Promise<any> {
  const nut: any = await import("@nut-tree-fork/nut-js");
  nut.mouse.config.autoDelayMs = 30;
  nut.keyboard.config.autoDelayMs = 20;
  return nut;
}

async function shoot(cfg: UmbraConfig): Promise<unknown> {
  const tmp = path.join(os.tmpdir(), `umbra-cu-${Date.now()}.png`);
  if (process.platform !== "darwin") throw new Error(mt("electron.platformUnsupported", { platform: process.platform }, getMainLocale()));
  const res = await run("screencapture", ["-x", tmp]);
  if (res.code !== 0) throw new Error(mt("electron.screenshotFailed", { detail: res.output.slice(-200) }, getMainLocale()));
  // 降采样到最长边 ~1440，控制体积（Retina 全屏原图数 MB，视觉模型有大小/分辨率限制）。
  // 归一化坐标(0-1000)与分辨率无关，缩放不影响点击定位。
  await run("sips", ["-Z", "1440", tmp]).catch(() => undefined);
  const up = await uploadFile(httpBase(cfg), cfg.token, tmp, "screen.png", "image/png");
  fs.unlink(tmp).catch(() => {});
  return up;
}

const KEYMAP: Record<string, string> = {
  cmd: "LeftCmd", command: "LeftCmd", ctrl: "LeftControl", control: "LeftControl",
  shift: "LeftShift", alt: "LeftAlt", option: "LeftAlt", opt: "LeftAlt",
  enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", tab: "Tab",
  space: "Space", delete: "Backspace", backspace: "Backspace",
  up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End",
};

async function doSkill(skill: string, params: Record<string, any>, cfg: UmbraConfig, report: Report, confirm: Confirm): Promise<unknown> {
  if (skill === "screenshot") {
    await requireScreen();
    return shoot(cfg);
  }

  if (skill === "open_app") {
    const app = String(params.app || "").trim();
    const url = String(params.url || "").trim();
    const loc = getMainLocale();
    if (!app) throw new Error(mt("electron.appMissing", undefined, loc));
    if (blacklisted(app, cfg.computerBlacklist)) throw new Error(mt("electron.blacklistApp", { app }, loc));
    const urlPart = url ? mt("electron.openAppWithUrl", { url }, loc) : "";
    if (cfg.computerConfirm && !(await confirm(mt("electron.openAppConfirm", { app, urlPart }, loc), { app, url: url || undefined }))) {
      throw new Error(mt("electron.userDenied", undefined, loc));
    }
    const args = url ? ["-a", app, url] : ["-a", app];
    const res = await run("open", args);
    if (res.code !== 0) throw new Error(mt("electron.openAppFailed", { detail: res.output.slice(-200) }, loc));
    await report(mt("electron.openedApp", { app, urlPart: url ? ` · ${url}` : "" }, loc), { progress: 1 });
    return { opened: app, url: url || undefined };
  }

  // 其余动作都作用于"当前前台应用"，先做黑名单校验。
  const front = await frontmostApp();
  if (blacklisted(front, cfg.computerBlacklist)) throw new Error(mt("electron.blacklistFront", { app: front }, getMainLocale()));

  if (skill === "operate") {
    throw new Error(mt("electron.operateUnsupported", undefined, getMainLocale()));
  }

  // 点击/输入/按键/滚动需要辅助功能权限。
  await requireAccessibility();
  const { mouse, keyboard, Point, Button, Key, screen } = await loadNut();

  if (skill === "click") {
    let x = Number(params.x);
    let y = Number(params.y);
    // 归一化坐标 nx/ny(0-1000，相对屏幕)→ 逻辑坐标。视觉模型输出的是归一化坐标，
    // 这样可避开 Retina 像素与逻辑点的缩放问题。
    if ((Number.isNaN(x) || Number.isNaN(y)) && params.nx != null && params.ny != null) {
      const w = await screen.width();
      const h = await screen.height();
      x = Math.round((w * Number(params.nx)) / 1000);
      y = Math.round((h * Number(params.ny)) / 1000);
    }
    if (Number.isNaN(x) || Number.isNaN(y)) throw new Error("click 需要 x,y 或 nx,ny(0-1000)");
    const btn = String(params.button || "left").toLowerCase();
    await mouse.setPosition(new Point(x, y));
    await mouse.click(btn === "right" ? Button.RIGHT : btn === "middle" ? Button.MIDDLE : Button.LEFT);
    const norm = params.nx != null ? ` [归一化 nx=${params.nx},ny=${params.ny}]` : "";
    await report(mt("electron.clickAt", { x, y, norm }, getMainLocale()), {});
    return { clicked: [x, y] };
  }

  if (skill === "type") {
    const text = String(params.text ?? "");
    if (!text) throw new Error("type 需要 text");
    const loc = getMainLocale();
    const appName = front || mt("electron.currentApp", undefined, loc);
    const displayText = `${text.slice(0, 40)}${text.length > 40 ? "…" : ""}`;
    if (cfg.computerConfirm && !(await confirm(mt("electron.typeConfirm", { app: appName, text: displayText }, loc), {}))) {
      throw new Error(mt("electron.userDenied", undefined, loc));
    }
    await keyboard.type(text);
    await report(mt("electron.typedChars", { count: text.length }, loc), {});
    return { typed: text.length };
  }

  if (skill === "key") {
    const keys: string[] = Array.isArray(params.keys) ? params.keys.map(String) : params.key ? [String(params.key)] : [];
    if (!keys.length) throw new Error("key 需要 keys 数组或 key");
    const mapped = keys.map((k) => Key[KEYMAP[k.toLowerCase()] || (k.length === 1 ? k.toUpperCase() : k)]).filter((v: unknown) => v !== undefined);
    const loc = getMainLocale();
    if (!mapped.length) throw new Error(mt("electron.keyUnknown", { keys: keys.join("+") }, loc));
    if (cfg.computerConfirm && !(await confirm(mt("electron.keyConfirm", { keys: keys.join(" + ") }, loc), {}))) {
      throw new Error(mt("electron.userDenied", undefined, loc));
    }
    await keyboard.pressKey(...mapped);
    await keyboard.releaseKey(...mapped);
    await report(mt("electron.keyPressed", { keys: keys.join("+") }, loc), {});
    return { key: keys };
  }

  if (skill === "scroll") {
    const amount = Number(params.amount ?? 5);
    const dir = String(params.direction || "down").toLowerCase();
    if (dir === "up") await mouse.scrollUp(amount);
    else if (dir === "left") await mouse.scrollLeft(amount);
    else if (dir === "right") await mouse.scrollRight(amount);
    else await mouse.scrollDown(amount);
    await report(mt("electron.scrolled", { dir, amount }, getMainLocale()), {});
    return { scrolled: dir, amount };
  }

  throw new Error(`computer 不支持技能：${skill}`);
}

const SKILLS: Manifest["skills"] = {
  operate: { description: "（v0 占位，未接决策引擎）给自然语言目标自主完成 GUI 操作", params: { goal: "目标描述", app: "可选，限定应用" } },
  open_app: { description: "打开/切换到某应用（可选同时打开网址）", params: { app: "应用名，如 Safari", url: "可选，要打开的网址" } },
  screenshot: { description: "截屏并返回图片链接", params: {} },
  click: { description: "在坐标点击", params: { x: "横坐标", y: "纵坐标", button: "left/right/middle，默认 left" } },
  type: { description: "向当前焦点输入文本", params: { text: "要输入的文本" } },
  key: { description: "按下（组合）键", params: { keys: "按键数组，如 [cmd, a]" } },
  scroll: { description: "滚动", params: { direction: "up/down/left/right", amount: "档数，默认 5" } },
};

// 注册 computer Provider（仅在总开关打开时；默认关 → 不注册 → AI 不可见不可用）。
export function registerComputer(r: Registry, cfg: UmbraConfig): void {
  if (!cfg.computerUseEnabled) return;
  const manifest: Manifest = {
    provider: "computer",
    display_name: "电脑操作",
    kind: "system",
    available: true,
    unavailable_reason: "",
    version: null,
    skills: SKILLS,
  };
  r.register(manifest, async (skill, params, report, confirm) => {
    stopRequested = false;
    return doSkill(skill, params as Record<string, any>, cfg, report, confirm);
  });
}
