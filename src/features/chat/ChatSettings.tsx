// 聊天设置（批次 012 · 功能的设置回功能）：「聊天与助手」从总设置搬到聊天页。
// 聊天页是命令式 DOM（chat.ts），拿不到 PageShell 的设置视图，所以这一层由 App 挂成
// 覆盖在聊天页之上的 React 视图：页头（返回 + 「聊天设置」）+ T3 内容。退出走返回钮或 Esc。
// 内容就是抽好的 ChatSection（自动批准电脑操作 + 用户画像），逻辑一字不改。
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader, SettingsPage, SettingsSection } from "../../components/layout";
import { ChatSection } from "../settings/sections";

export function ChatSettingsOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-bg">
      <PageHeader title={t("chat.settingsTitle")} back={{ label: t("chat.backLabel"), onBack: onClose }} />
      <SettingsPage>
        <SettingsSection title={t("settings.secChat")} desc={t("settings.secChatDesc")}>
          <ChatSection />
        </SettingsSection>
      </SettingsPage>
    </div>
  );
}
