// 工具 → 剪贴板历史：开关、唤起快捷键、回车自动粘贴、分类保留时长、清空历史。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import * as legacy from "../../app/shell";
import { Toggle, RowsCard, SettingRow, RowHint, Panel, btnGhost, btnDanger, selectBox } from "../../components/ui";
import { HotkeyButton, HotkeyConflictBanner, useHotkeyConflict } from "./hotkeys";
import { clipApi, type ClipKeep } from "./bridges";

// 保留时长候选（小时）。0 = 永久，对应勾选框不勾。
const KEEP_OPTIONS = [24, 168, 720, 2160] as const;
// 勾上「限制保留时长」时的默认档：一周。
const DEFAULT_KEEP_HOURS = 168;
// 三个分类的展示顺序与词条。
const KEEP_ROWS: { key: keyof ClipKeep; labelKey: string }[] = [
  { key: "text", labelKey: "settings.clipKeepText" },
  { key: "image", labelKey: "settings.clipKeepImage" },
  { key: "files", labelKey: "settings.clipKeepFiles" },
];

export function ClipboardTool() {
  const { t } = useTranslation();
  const api = clipApi();
  const clip = legacy.getClipState();
  const [autoPaste, setAutoPaste] = useState(false);
  const [keep, setKeep] = useState<ClipKeep>({ text: 0, image: 0, files: 0 });
  const conflict = useHotkeyConflict("clip", clip.shortcut);

  useEffect(() => {
    void api.getSettings().then((s) => {
      setAutoPaste(!!s.autoPaste);
      if (s.keep) setKeep({ text: s.keep.text || 0, image: s.keep.image || 0, files: s.keep.files || 0 });
    });
  }, []);

  // 改一项即整体落盘（主进程收到后会立刻按新规则清一遍过期条目）。
  const patchKeep = (patch: Partial<ClipKeep>) => {
    const next = { ...keep, ...patch };
    setKeep(next);
    void api.setKeep(next);
  };

  return (
    <>
      <RowsCard>
        <SettingRow label={t("settings.clipEnable")}>
          <RowHint>{t("settings.clipEnableDesc", { status: clip.enabled ? t("common.enabled") : t("settings.clipHistoryKept") })}</RowHint>
          <Toggle on={clip.enabled} onClick={() => legacy.toggleClipEnabled()} />
        </SettingRow>
        <SettingRow label={t("settings.clipShortcut")}>
          <div className="flex-1 min-w-0 flex items-center gap-[8px]">
            <HotkeyButton recording={clip.recording} value={clip.shortcut} onClick={() => legacy.beginShortcutRecording("clip")} />
            <button className={btnGhost} onClick={async () => { await api.setShortcut("Command+Shift+V"); await legacy.loadClipSettings(); }}>
              {t("common.reset")}
            </button>
          </div>
        </SettingRow>
        <SettingRow label={t("settings.clipAutoPaste")}>
          <RowHint>{t("settings.clipAutoPasteDesc")}</RowHint>
          <Toggle on={autoPaste} onClick={() => { const n = !autoPaste; setAutoPaste(n); void api.setAutoPaste(n); }} />
        </SettingRow>
      </RowsCard>

      {conflict ? <HotkeyConflictBanner owner={conflict} /> : null}

      {/* 分类保留时长：每类一个开关 + 一个时长下拉，关掉即永久保留（收藏项永远不过期）。 */}
      <Panel title={t("settings.clipKeep")} hint={t("settings.clipKeepHint")}>
        <div className="flex flex-col gap-[8px]">
          {KEEP_ROWS.map((r) => {
            const hours = keep[r.key];
            return (
              <div key={r.key} className="flex items-center gap-[12px] bg-bg border border-border-soft rounded-[9px] p-[8px_12px]">
                <span className="w-[76px] flex-none whitespace-nowrap text-[12.5px]">{t(r.labelKey)}</span>
                <Toggle on={hours > 0} onClick={() => patchKeep({ [r.key]: hours > 0 ? 0 : DEFAULT_KEEP_HOURS } as Partial<ClipKeep>)} />
                {/* 关掉时下拉是禁用态，右边这句话补一个明确的「那到底留多久」 */}
                <span className="flex-1 min-w-0 text-[11.5px] text-faint">{hours > 0 ? "" : t("settings.clipKeepForever")}</span>
                <select
                  className={selectBox}
                  disabled={hours <= 0}
                  value={hours > 0 ? hours : DEFAULT_KEEP_HOURS}
                  onChange={(e) => patchKeep({ [r.key]: Number(e.target.value) } as Partial<ClipKeep>)}
                >
                  {KEEP_OPTIONS.map((h) => (
                    <option key={h} value={h}>{t(`settings.clipKeep_${h}`)}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      </Panel>

      <RowsCard>
        <SettingRow label={t("settings.clipClear")}>
          <RowHint>{t("settings.clipClearDesc")}</RowHint>
          <button className={btnDanger} onClick={() => legacy.clearClipHistory()}>{t("settings.clipClearBtn")}</button>
        </SettingRow>
        {/* 收藏永不过期，也不会被「清空历史」带走，所以单给一个清空出口。 */}
        <SettingRow label={t("settings.clipClearFav")}>
          <RowHint>{t("settings.clipClearFavDesc")}</RowHint>
          <button
            className={btnDanger}
            onClick={() => { if (confirm(t("settings.clipClearFavConfirm"))) void api.clearFavorites(); }}
          >
            {t("settings.clipClearFavBtn")}
          </button>
        </SettingRow>
      </RowsCard>
    </>
  );
}
