// 工具 → 剪贴板历史：开关、唤起快捷键、回车自动粘贴、分类保留时长、清空历史。
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import * as legacy from "../../app/shell";
import { Card, Row, Toggle, btnGhost } from "../../components/ui";
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
    <Card title={t("settings.clipboard")}>
      <Row label={t("settings.clipEnable")}>
        <span className="flex-1 text-[12px] text-muted">{t("settings.clipEnableDesc", { status: clip.enabled ? t("common.enabled") : t("settings.clipHistoryKept") })}</span>
        <Toggle on={clip.enabled} onClick={() => legacy.toggleClipEnabled()} />
      </Row>
      <Row label={t("settings.clipShortcut")}>
        <button onClick={() => legacy.beginShortcutRecording("clip")} className={`flex-1 text-left border rounded-lg px-[11px] py-[7px] text-[13px] font-mono bg-bg text-text ${clip.recording ? "border-orange" : "border-border"}`}>
          {clip.recording ? t("settings.pressShortcut") : clip.shortcut}
        </button>
        <button className={btnGhost} onClick={async () => { await api.setShortcut("Command+Shift+V"); await legacy.loadClipSettings(); }}>
          {t("common.reset")}
        </button>
      </Row>
      <Row label={t("settings.clipAutoPaste")}>
        <span className="flex-1 text-[12px] text-muted">{t("settings.clipAutoPasteDesc")}</span>
        <Toggle on={autoPaste} onClick={() => { const n = !autoPaste; setAutoPaste(n); void api.setAutoPaste(n); }} />
      </Row>
      {/* 分类保留时长：每类一个开关 + 一个时长下拉，关掉即永久保留（收藏项永远不过期）。 */}
      <div className="pt-1 flex flex-col gap-[10px]">
        <div className="text-[13px] text-muted">{t("settings.clipKeep")}</div>
        {KEEP_ROWS.map((r) => {
          const hours = keep[r.key];
          return (
            <div key={r.key} className="flex items-center gap-[14px] pl-[6px]">
              <span className="w-[114px] text-[12.5px] shrink-0">{t(r.labelKey)}</span>
              <Toggle on={hours > 0} onClick={() => patchKeep({ [r.key]: hours > 0 ? 0 : DEFAULT_KEEP_HOURS } as Partial<ClipKeep>)} />
              <select
                className="border border-border bg-bg text-text rounded-lg px-[9px] py-[6px] text-[12.5px] disabled:opacity-40"
                disabled={hours <= 0}
                value={hours > 0 ? hours : DEFAULT_KEEP_HOURS}
                onChange={(e) => patchKeep({ [r.key]: Number(e.target.value) } as Partial<ClipKeep>)}
              >
                {KEEP_OPTIONS.map((h) => (
                  <option key={h} value={h}>{t(`settings.clipKeep_${h}`)}</option>
                ))}
              </select>
              <span className="text-[11.5px] text-muted">{hours > 0 ? "" : t("settings.clipKeepForever")}</span>
            </div>
          );
        })}
        <div className="text-[11.5px] text-muted pl-[6px]">{t("settings.clipKeepHint")}</div>
      </div>
      <Row label={t("settings.clipClear")}>
        <span className="flex-1 text-[12px] text-muted">{t("settings.clipClearDesc")}</span>
        <button className="px-[13px] py-[6px] border border-danger text-danger bg-transparent rounded-lg text-[12.5px]" onClick={() => legacy.clearClipHistory()}>
          {t("settings.clipClearBtn")}
        </button>
      </Row>
      {/* 收藏永不过期，也不会被「清空历史」带走，所以单给一个清空出口。 */}
      <Row label={t("settings.clipClearFav")}>
        <span className="flex-1 text-[12px] text-muted">{t("settings.clipClearFavDesc")}</span>
        <button
          className="px-[13px] py-[6px] border border-danger text-danger bg-transparent rounded-lg text-[12.5px]"
          onClick={() => { if (confirm(t("settings.clipClearFavConfirm"))) void api.clearFavorites(); }}
        >
          {t("settings.clipClearFavBtn")}
        </button>
      </Row>
    </Card>
  );
}
