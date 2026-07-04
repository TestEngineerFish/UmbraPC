export type Locale = "zh-CN" | "en";

export const DEFAULT_LOCALE: Locale = "zh-CN";
export const SUPPORTED_LOCALES: { value: Locale; labelKey: string }[] = [
  { value: "zh-CN", labelKey: "settings.langZh" },
  { value: "en", labelKey: "settings.langEn" },
];

/** 将系统/用户语言码规范为支持的语言；无法匹配时回退中文。 */
export function resolveLocale(raw?: string | null): Locale {
  if (!raw) return DEFAULT_LOCALE;
  const n = raw.trim().toLowerCase().replace("_", "-");
  if (!n) return DEFAULT_LOCALE;
  if (n.startsWith("zh")) return "zh-CN";
  if (n.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

export function localeToHtmlLang(locale: Locale): string {
  return locale === "en" ? "en" : "zh-CN";
}
