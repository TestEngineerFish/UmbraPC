import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zh from "./locales/zh-CN.json";
import en from "./locales/en.json";
import { DEFAULT_LOCALE, localeToHtmlLang, resolveLocale, type Locale } from "./locale";

export { DEFAULT_LOCALE, SUPPORTED_LOCALES, resolveLocale, localeToHtmlLang, type Locale } from "./locale";

let ready = false;
const listeners = new Set<() => void>();

export function subscribeLocale(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(): void {
  listeners.forEach((cb) => cb());
}

export async function initI18n(locale?: string | null): Promise<Locale> {
  const resolved = resolveLocale(locale);
  if (!ready) {
    await i18n.use(initReactI18next).init({
      resources: { "zh-CN": { translation: zh }, en: { translation: en } },
      lng: resolved,
      fallbackLng: DEFAULT_LOCALE,
      interpolation: { escapeValue: false },
      returnEmptyString: false,
    });
    ready = true;
  } else if (i18n.language !== resolved) {
    await i18n.changeLanguage(resolved);
  }
  document.documentElement.lang = localeToHtmlLang(resolved);
  return resolved;
}

export async function changeLocale(locale: string | Locale): Promise<Locale> {
  const resolved = resolveLocale(locale);
  await initI18n(resolved);
  notify();
  return resolved;
}

export async function detectLocale(): Promise<Locale> {
  try {
    const umbra = (window as unknown as { umbra?: { isDesktop?: boolean; getConfig?: () => Promise<{ locale?: string }> } }).umbra;
    if (umbra?.isDesktop && umbra.getConfig) {
      const cfg = await umbra.getConfig();
      if (cfg.locale) return resolveLocale(cfg.locale);
    }
  } catch {
    /* ignore */
  }
  try {
    return resolveLocale(navigator.language);
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** 供 vanilla TS（shell / chat）使用的翻译函数。 */
export function t(key: string, params?: Record<string, string | number>): string {
  return i18n.t(key, params);
}

export default i18n;
