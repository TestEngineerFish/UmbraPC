// 「3 分钟前」这类相对时间的**唯一出处**，外加一个让它自己往上走的心跳 hook。
//
// 以前提醒页 / 常用语 / 保险箱各写了一份 agoLabel，而且都只在「数据变了」那一刻算一次 ——
// 页面不重渲染，那行字就永远停在「刚刚同步」（提醒页验收时被抓到的就是这个）。
// 修法不是给每处各加一个 setInterval，而是把「格式化」和「心跳」都收到这里：
// 谁要显示相对时间，用 useNow() 拿一个会跳的「现在」，再用 formatAgo() 算文案。
//
// 文案用浏览器内置的 Intl.RelativeTimeFormat 生成，中英文随 i18n 的语言走，
// 不用再手写「分钟前 / minutes ago」两套字符串（timeago.js / dayjs 那些库做的也是这件事，
// 但 Chromium 自带的 Intl 已经够用，没必要为一行字多拖一个依赖）。
import { useEffect, useState } from "react";
import i18n from "i18next";

// 心跳默认周期。相对时间的粒度是「分钟」，30s 一跳保证「1 分钟前」不会迟到超过半分钟；
// 再快只是白白重渲染。
const DEFAULT_TICK_MS = 30_000;

/**
 * 一个每隔 intervalMs 就变一次的「现在」。用它当依赖，相对时间才会自己往上走。
 * 只在挂载期间跳，卸载即停 —— 不会留下漏掉的定时器。
 */
export function useNow(intervalMs = DEFAULT_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * 「刚刚 / 3 分钟前 / 2 小时前 / 昨天 / 5 天前」。ms=0 或未来时刻都按「刚刚」处理 ——
 * 调用方自己决定 0 要不要换成「还没同步过」之类的专属文案（见 SyncStamp）。
 */
export function formatAgo(ms: number, now = Date.now(), locale = i18n.language || "zh-CN"): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  // numeric:"auto" 会把 -1 天说成「昨天」、0 秒说成「现在」；「现在」在同步语境里读起来怪，
  // 一分钟内统一用「刚刚」（各语言自己的说法由下面的 justNow 决定）。
  if (s < 60) return locale.startsWith("zh") ? "刚刚" : "just now";
  if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), "hour");
  return rtf.format(-Math.floor(s / 86400), "day");
}
