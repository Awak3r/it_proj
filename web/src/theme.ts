import { useEffect } from "react";
type TelegramTheme = {
  initData?: string;
  themeParams?: Record<string, string>;
  colorScheme?: "light" | "dark";
  onEvent?: (name: string, fn: () => void) => void;
  offEvent?: (name: string, fn: () => void) => void;
};
export function useTelegramTheme() {
  useEffect(() => {
    const tg = window.Telegram?.WebApp as TelegramTheme | undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      document.documentElement.dataset.theme =
        (tg?.initData ? tg.colorScheme : undefined) ||
        (media.matches ? "dark" : "light");
      for (const key of [
        "bg_color",
        "secondary_bg_color",
        "text_color",
        "hint_color",
        "button_color",
        "button_text_color",
      ]) {
        const value = tg?.themeParams?.[key];
        const property = "--tg-theme-" + key.replaceAll("_", "-");
        if (tg?.initData && value && /^#[\da-f]{6}$/i.test(value))
          document.documentElement.style.setProperty(property, value);
        else document.documentElement.style.removeProperty(property);
      }
    };
    update();
    tg?.onEvent?.("themeChanged", update);
    media.addEventListener("change", update);
    return () => {
      tg?.offEvent?.("themeChanged", update);
      media.removeEventListener("change", update);
    };
  }, []);
}
