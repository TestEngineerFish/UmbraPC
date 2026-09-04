// 从总设置页搬去各功能的四个分区（批次 012 · 功能的设置回功能）：
//   PermSection + OpsSection → 电脑操作页的「电脑操作设置」
//   CapSection → 能力页的「能力设置」
//   ChatSection → 聊天页 ⋯ 菜单的「聊天设置」
// 逻辑一字不改，只是从 Settings.tsx 里抽成组件，各功能页的设置视图（T3）直接摆进去。
// 总设置只留通用 / 连接 / 设备与引擎 / 快捷键总览 / 回收站 / 关于。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAutoApproveOperate, setAutoApproveOperate, fetchProfile, saveProfile, resetProfile } from "../../services/server";
import * as desktop from "../../services/desktop";
import * as legacy from "../../app/shell";
import { Toggle, RowsCard, SettingRow, RowHint, Pill, Segmented, ErrorCard, btnGhost, btnPrimary, btnDanger } from "../../components/ui";
import { askConfirm, showToast } from "../../components/overlay";

// 权限行：标签 + 说明 + 已授予/待授权徽章（+ 去授权按钮）。
function PermRow({ title, desc, granted, onGrant }: { title: string; desc: string; granted: boolean; onGrant: () => void }) {
  const { t } = useTranslation();
  return (
    <SettingRow label={title}>
      <RowHint>{desc}</RowHint>
      {granted ? (
        <Pill tone="success">{t("common.granted")}</Pill>
      ) : (<>
        <Pill tone="warning" dot>{t("common.notGranted")}</Pill>
        <button className="flex-none whitespace-nowrap px-[12px] py-[5px] border border-warning text-warning bg-transparent rounded-[7px] text-[12px] font-semibold cursor-pointer hover:bg-warning hover:text-white" onClick={onGrant}>
          {t("common.goAuthorize")}
        </button>
      </>)}
    </SettingRow>
  );
}

/** 系统权限三项 + 电脑操作总开关。 */
export function PermSection() {
  const { t } = useTranslation();
  const perms = desktop.getPermissions();
  const cuOn = legacy.computerEnabled();
  return (
    <RowsCard>
      <PermRow title={t("settings.accessibility")} desc={t("settings.accessibilityDesc")} granted={perms.accessibility} onGrant={() => desktop.openPrivacy("accessibility")} />
      <PermRow title={t("settings.screenCapture")} desc={t("settings.screenCaptureDesc")} granted={perms.screen === "granted"} onGrant={() => desktop.openPrivacy("screen")} />
      <PermRow title={t("settings.microphone")} desc={t("settings.microphoneDesc")} granted={perms.microphone === "granted"} onGrant={() => desktop.openPrivacy("microphone")} />
      <SettingRow label={t("settings.computerUse")}>
        <RowHint>{t("settings.computerUseDesc")}</RowHint>
        <Toggle on={cuOn} onClick={() => legacy.toggleComputerUse()} />
      </SettingRow>
    </RowsCard>
  );
}

/** 电脑操作授权：7 个技能各一档 询问 / 允许 / 禁止。 */
export function OpsSection() {
  const { t } = useTranslation();
  const cuOn = legacy.computerEnabled();
  const [skillPolicy, setSkillPolicy] = useState<Record<string, "allow" | "deny">>(
    desktop.getDesktopConfig()?.computerSkillPolicy || {},
  );
  return (<>
    {!cuOn ? (
      // 总开关没开的提醒：原来是设置页私有的 Banner，骨架件把它作废了 —— 统一走错误卡的横幅态（提醒级 warning）。
      <ErrorCard variant="strip" kind="warning" title={t("settings.cuOffBanner")}
        actions={[{ label: t("settings.cuOffGo"), onClick: () => legacy.toggleComputerUse() }]} />
    ) : null}
    <RowsCard>
      {([
        ["open_app", t("settings.skillOpenApp")],
        ["click", t("settings.skillClick")],
        ["type", t("settings.skillType")],
        ["key", t("settings.skillKey")],
        ["scroll", t("settings.skillScroll")],
        ["drag", t("settings.skillDrag")],
        ["screenshot", t("settings.skillScreenshot")],
      ] as const).map(([key, label]) => {
        const cur = (skillPolicy[key] || "ask") as "ask" | "allow" | "deny";
        const set = (v: "ask" | "allow" | "deny") => {
          const next = { ...skillPolicy };
          if (v === "ask") delete next[key]; else next[key] = v;
          setSkillPolicy(next);
          void desktop.pushConfig({ computerSkillPolicy: next });
        };
        return (
          <SettingRow key={key} label={label}>
            {/* 副文案是这一行对应的**真实技能名**：执行前确认卡和日志里出现的都是这个 key，
                对不上的话用户被弹了一次授权，回到设置页也不知道该改哪一行。
                「拖拽」额外带一句风险提示：它是唯一一个「一次误操作就能把文件拖进回收站 /
                改掉窗口布局」的动作。 */}
            <RowHint>
              <span className="font-mono text-[11.5px]">{key}</span>
              {key === "drag" ? <span className="text-warning"> — {t("settings.skillDragHint")}</span> : null}
            </RowHint>
            <Segmented value={cur} onChange={set} options={[
              { v: "ask" as const, label: t("settings.policy_ask"), tone: "neutral" },
              { v: "allow" as const, label: t("settings.policy_allow"), tone: "accent" },
              { v: "deny" as const, label: t("settings.policy_deny"), tone: "danger" },
            ]} />
          </SettingRow>
        );
      })}
    </RowsCard>
    <div className="flex items-center gap-[10px]">
      <span className="flex-1 min-w-0 text-[11.5px] text-faint">{t("settings.opsFootnote")}</span>
      {/* 「全部改为询问」= 清空策略表（ask 就是不写入这张表的默认档）。 */}
      <button className={btnGhost} onClick={() => { setSkillPolicy({}); void desktop.pushConfig({ computerSkillPolicy: {} }); }}>{t("settings.opsAllAsk")}</button>
    </div>
  </>);
}

/** 能力配置：providers.json 路径 + coding 执行权限三档。 */
export function CapSection() {
  const { t } = useTranslation();
  const cfg = desktop.getDesktopConfig();
  const codingMode = legacy.getCodingMode();
  return (
    <RowsCard>
      <SettingRow label={t("settings.providersFile")}>
        <div className="flex-1 min-w-0 font-mono text-[11.5px] text-muted truncate">{cfg?.providersFile || t("common.desktopOnly")}</div>
        <button className={btnGhost} onClick={() => desktop.openProvidersFile()}>{t("settings.edit")}</button>
      </SettingRow>
      <SettingRow label={t("settings.codingPerm")}>
        <RowHint>{t("settings.codingPermHint")}</RowHint>
        <Segmented value={String(codingMode)} onChange={(v) => legacy.setCodingMode(Number(v))}
          options={[t("settings.codingGenOnly"), t("settings.codingConfirm"), t("settings.codingDirect")].map((label, i) => ({ v: String(i), label }))} />
      </SettingRow>
    </RowsCard>
  );
}

/** 聊天与助手：自动批准电脑操作 + 用户画像。 */
export function ChatSection() {
  const { t } = useTranslation();
  const [autoApprove, setAutoApproveState] = useState(getAutoApproveOperate());
  return (<>
    <RowsCard>
      <SettingRow label={t("settings.autoApproveOperate")}>
        <RowHint>{t("settings.autoApproveOperateHint")}</RowHint>
        <Pill tone="danger">{t("settings.cautious")}</Pill>
        <Toggle on={autoApprove} onClick={() => { const next = !autoApprove; setAutoApproveOperate(next); setAutoApproveState(next); }} />
      </SettingRow>
    </RowsCard>
    <ProfileCard />
  </>);
}

// 用户画像卡：查看/编辑/重置服务端的 user_profile.md（秘书对用户的当前认知快照）。
// 画像由对话自动沉淀，可能积累错误——这里给用户直接改或一键重置的口子。
function ProfileCard() {
  const { t } = useTranslation();
  const [md, setMd] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void (async () => { setMd(await fetchProfile()); setLoaded(true); })();
  }, []);
  const doSave = async () => {
    setBusy(true);
    const r = await saveProfile(md);
    if (r !== null) { setMd(r); setSaved(true); setTimeout(() => setSaved(false), 1500); }
    setBusy(false);
  };
  const doReset = async () => {
    if (!await askConfirm({
      message: t("settings.profileResetConfirm"),
      confirmText: t("settings.profileReset"),
      danger: true,
    })) return;
    setBusy(true);
    const r = await resetProfile();
    // 重置是把助手对你的全部认知清成空白模板 —— 不给回执的话，界面上只是文本框变了内容，
    // 用户分不清「重置成功」和「加载失败被清空了」。
    if (r !== null) { setMd(r); showToast(t("settings.profileResetDone"), { tone: "ok" }); }
    setBusy(false);
  };
  return (
    <section className="bg-card border border-border rounded-[12px] p-[16px]">
      <div className="flex items-baseline gap-[8px] mb-[4px]">
        <span className="flex-none whitespace-nowrap text-[13px] font-semibold">{t("settings.profile")}</span>
      </div>
      <div className="text-[11.5px] text-muted mb-[11px] leading-[1.6]">{t("settings.profileHint")}</div>
      <textarea
        value={md}
        onChange={(e) => setMd(e.target.value)}
        placeholder={loaded ? "" : "…"}
        spellCheck={false}
        aria-label={t("settings.profileMono")}
        className="w-full h-[260px] border border-border bg-track text-text rounded-[9px] px-[13px] py-[11px] text-[12px] leading-[1.75] outline-none resize-y font-mono"
      />
      <div className="flex items-center gap-[10px] mt-[12px]">
        <span className="flex-1" />
        <button className={btnDanger} disabled={busy} onClick={doReset}>{t("settings.profileReset")}</button>
        <button className={btnPrimary} disabled={busy || !loaded} onClick={doSave}>
          {saved ? t("settings.profileSaved") : t("settings.profileSave")}
        </button>
      </div>
    </section>
  );
}
