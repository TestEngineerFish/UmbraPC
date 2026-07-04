import zh from "../src/i18n/locales/zh-CN.json";
import en from "../src/i18n/locales/en.json";
import { DEFAULT_LOCALE, resolveLocale, type Locale } from "../src/i18n/locale";

const bundles: Record<Locale, Record<string, unknown>> = {
  "zh-CN": zh,
  en,
};

let current: Locale = DEFAULT_LOCALE;

export function setMainLocale(locale: string | Locale): Locale {
  current = resolveLocale(locale);
  return current;
}

export function getMainLocale(): Locale {
  return current;
}

function lookup(obj: Record<string, unknown>, path: string): string | undefined {
  const v = path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);
  return typeof v === "string" ? v : undefined;
}

function interpolate(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  return s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(params[k] ?? ""));
}

/** 主进程翻译（dialog / menu / Error.message 等）。 */
export function mt(key: string, params?: Record<string, string | number>, locale?: Locale): string {
  const loc = locale ?? current;
  const raw = lookup(bundles[loc], key) ?? lookup(bundles[DEFAULT_LOCALE], key) ?? key;
  return interpolate(raw, params);
}

export { resolveLocale, DEFAULT_LOCALE, type Locale };
