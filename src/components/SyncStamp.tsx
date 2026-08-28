// 「↻ 3 分钟前同步」—— 刷新按钮和同步状态**长在一起**的那一小块，提醒页 / 常用语共用。
//
// 为什么合成一个组件：验收时两处都被指出「按钮在最右、文字在最左，两头各摆一半」；
// 而且文字要自己往上走（靠 useNow 心跳），文案要中英随 i18n，这些只该写一遍。
// 各模块的「上次同步时刻」仍然由各自的主进程状态记着（提醒 / 常用语 / 保险箱各一份），
// 这里只负责**显示**——统一的是格式与心跳，不是把三份状态硬并成一个。
import { useTranslation } from "react-i18next";

import { RefreshButton } from "./ui";
import { formatAgo, useNow } from "../services/relativeTime";

/** 各模块同步状态的公共形状（NotifySyncState / PhraseSyncState 都长这样）。 */
export interface SyncStampState {
  /** 是否配好了服务器地址与 token。没配就直说，别让用户对着一个不动的按钮猜。 */
  configured: boolean;
  /** 正在同步。 */
  syncing?: boolean;
  /** 上次**成功**同步的时刻，0 = 从没成功过。 */
  lastAt: number;
  /** 上次失败原因，空串 = 没失败。 */
  lastError?: string;
  /** 「没配服务器」时的替代文案。不传用通用的「未配置服务器，仅本机」。 */
  offText?: string;
}

export function SyncStamp({ state, onSync, spinning, title }: {
  state: SyncStampState | null;
  onSync: () => void | Promise<unknown>;
  /** 外部已有的刷新态（比如主进程回的 syncing）。 */
  spinning?: boolean;
  title?: string;
}) {
  const { t } = useTranslation();
  const now = useNow();

  let label = "";
  if (state) {
    if (!state.configured) label = state.offText || t("common.syncOff");
    else if (state.syncing) label = t("common.syncing");
    else if (state.lastError) label = t("common.syncFailed", { err: state.lastError });
    else if (!state.lastAt) label = t("common.syncNever");
    else label = t("common.syncedAgo", { when: formatAgo(state.lastAt, now) });
  }

  // 失败态文案变红：状态不能只靠颜色，所以前面还有「同步失败：」四个字，颜色只是加强。
  const tone = state?.lastError && state.configured ? "text-danger" : "text-muted";
  return (
    <div className="flex items-center gap-[4px] flex-none">
      <RefreshButton onClick={onSync} spinning={spinning || !!state?.syncing} title={title || t("common.syncNow")} />
      <span className={`text-[11.5px] ${tone} whitespace-nowrap`} title={state?.lastError || undefined}>{label}</span>
    </div>
  );
}
