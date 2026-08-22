// 全局浮层宿主：吐司 + 确认弹窗。整个应用只挂一份（App 根节点）。
//
// 为什么要有这一层，两个具体的病：
//
//  1. **吐司组件早就按稿封好了，但零调用点。** 因为每个页面自己没法在页面外画一个 fixed 层
//     而互不打架 —— 保险箱和快捷入口于是各写了一份自己的 toast state，其余页面干脆不给反馈。
//     结果是提醒、灵感、聊天的写操作（完成/删除/清空/批准）**全程没有任何成功提示**。
//
//  2. **聊天是 vanilla 渲染层**（`mountChat` 挂进 App 的一个 ref），拿不到 React 组件，
//     所以那两处二次确认一直用的是 `window.confirm` —— 系统弹窗，跟设计稿完全两回事，
//     深色主题下也是一块白板。
//
// 一个模块级的小 store + 一个挂在根上的宿主，两个病一起治：任何地方（React 或 vanilla）
// 都能 `showToast()` / `askConfirm()`，后者返回 Promise<boolean>，vanilla 里也能 await。
import { useEffect, useState } from "react";
import { Toast, ConfirmDialog } from "./ui";
import type { ToastTone } from "./ui";

interface ToastReq {
  id: number;
  text: string;
  tone?: ToastTone;
  actionLabel?: string;
  onAction?: () => void;
  place?: "right" | "center";
}
interface ConfirmReq {
  id: number;
  title?: string;
  message: string;
  confirmText: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

let seq = 0;
let toastReq: ToastReq | null = null;
let confirmReq: ConfirmReq | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

/**
 * 弹一条吐司。同一时刻只留一条 —— 后来的顶掉前面的。
 *
 * 停留时长分两档：带动作的给 5 秒（稿里「已完成」那条的撤销就是 5s，太短点不到），
 * 不带动作的 2.2 秒。传 `sticky` 可以不自动消失（留给「正在…」这类要等结果的）。
 */
export function showToast(text: string, opts?: {
  tone?: ToastTone;
  actionLabel?: string;
  onAction?: () => void;
  place?: "right" | "center";
  sticky?: boolean;
}): void {
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  toastReq = { id: ++seq, text, tone: opts?.tone, actionLabel: opts?.actionLabel, onAction: opts?.onAction, place: opts?.place };
  const mine = toastReq.id;
  notify();
  if (opts?.sticky) return;
  toastTimer = setTimeout(() => {
    // 只清掉自己那条：这中间可能已经被新的顶掉了，那条不该被这个定时器带走。
    if (toastReq?.id === mine) { toastReq = null; notify(); }
    toastTimer = null;
  }, opts?.actionLabel ? 5000 : 2200);
}

export function hideToast(): void {
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  if (toastReq) { toastReq = null; notify(); }
}

/**
 * 走设计稿的二次确认弹窗，替代 `window.confirm`。返回 Promise<boolean>。
 *
 * 同一时刻只允许一个：新的请求会把旧的按「取消」结掉，**不会**让上一个 Promise 悬着不 resolve。
 */
export function askConfirm(req: { title?: string; message: string; confirmText: string; danger?: boolean }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (confirmReq) confirmReq.resolve(false);
    confirmReq = { id: ++seq, ...req, resolve };
    notify();
  });
}

function settle(ok: boolean): void {
  const r = confirmReq;
  confirmReq = null;
  notify();
  r?.resolve(ok);
}

export function OverlayHost() {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((x) => x + 1);
    subs.add(f);
    return () => { subs.delete(f); };
  }, []);

  return (
    <>
      {confirmReq ? (
        <ConfirmDialog
          key={confirmReq.id}
          title={confirmReq.title}
          message={confirmReq.message}
          confirmText={confirmReq.confirmText}
          danger={confirmReq.danger}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      ) : null}
      {toastReq ? (
        <Toast
          key={toastReq.id}
          text={toastReq.text}
          tone={toastReq.tone}
          place={toastReq.place}
          actionLabel={toastReq.actionLabel}
          onAction={toastReq.onAction ? () => { toastReq?.onAction?.(); hideToast(); } : undefined}
        />
      ) : null}
    </>
  );
}
