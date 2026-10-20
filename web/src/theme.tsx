import { useEffect, useState } from "react";
import { useI18n } from "./i18n";

type ThemePreference = "dark" | "light" | "system";
const storageKey = "pi-loop-observer-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "dark" || saved === "light" || saved === "system")
      return saved;
  } catch {
    /* Storage may be unavailable in private or restricted contexts. */
  }
  return "system";
}
function applyTheme(preference: ThemePreference) {
  const theme =
    preference === "system" ? (media.matches ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = theme;
  const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (favicon) favicon.href = `/favicon-${theme}.svg?v=2`;
}
const initialPreference = readPreference();
applyTheme(initialPreference);

export function ThemeSelector() {
  const { t } = useI18n();
  const [preference, setPreference] =
    useState<ThemePreference>(initialPreference);
  useEffect(() => {
    applyTheme(preference);
    const handleChange = () => applyTheme(preference);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [preference]);
  return (
    <select
      aria-label={t("Color theme", "颜色主题")}
      value={preference}
      onChange={(event) => {
        const next = event.target.value as ThemePreference;
        setPreference(next);
        try {
          localStorage.setItem(storageKey, next);
        } catch {
          /* Preference still applies in memory. */
        }
      }}
    >
      <option value="system">{t("System", "跟随系统")}</option>
      <option value="dark">{t("Dark", "深色")}</option>
      <option value="light">{t("Light", "浅色")}</option>
    </select>
  );
}
