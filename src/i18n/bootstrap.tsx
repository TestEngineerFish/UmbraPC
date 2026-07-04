import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { createRoot, type Root } from "react-dom/client";
import i18n, { changeLocale, detectLocale, initI18n } from "./index";

/** 初始化 i18n 并挂载 React 根（各 Vite 入口共用）。 */
export async function mountApp(el: HTMLElement, app: ReactElement): Promise<Root> {
  await initI18n(await detectLocale());
  const umbra = (window as unknown as { umbra?: { onLocaleChanged?: (cb: (locale: string) => void) => () => void } }).umbra;
  umbra?.onLocaleChanged?.((locale) => {
    void changeLocale(locale);
  });
  const root = createRoot(el);
  root.render(<I18nextProvider i18n={i18n}>{app}</I18nextProvider>);
  return root;
}
