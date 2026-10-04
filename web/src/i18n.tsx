import React, { createContext, useContext, useEffect, useState } from "react";
export type Language = "en" | "zh";
const Context = createContext<{
  language: Language;
  setLanguage: (value: Language) => void;
  t: (en: string, zh: string) => string;
}>({ language: "en", setLanguage: () => {}, t: (en) => en });
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => {
    try {
      return localStorage.getItem("pi-loop-observer-language") === "zh"
        ? "zh"
        : "en";
    } catch {
      return "en";
    }
  });
  useEffect(() => {
    document.documentElement.lang = language;
    try {
      localStorage.setItem("pi-loop-observer-language", language);
    } catch {}
  }, [language]);
  return (
    <Context.Provider
      value={{
        language,
        setLanguage,
        t: (en, zh) => (language === "zh" ? zh : en),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export const useI18n = () => useContext(Context);
export function errorMessage(error: unknown, language: Language): string {
  const value = (
    error instanceof Error ? error.message : String(error)
  ).replace(/^Error: /, "");
  const translate = (en: string, zh: string) => (language === "zh" ? zh : en);
  const fixed: Record<string, string> = {
    "采集结束，执行终点未记录":
      "Recording ended; the execution endpoint was not recorded",
    "同一事件身份返回了不同内容，请重新加载会话":
      "An event identity returned conflicting content. Reload this session.",
    "事件顺序异常，请重新加载会话":
      "Event order is invalid. Reload this session.",
  };
  if (fixed[value]) return language === "zh" ? value : fixed[value];
  if (value === "viewer-ticket-expired")
    return translate(
      "Viewer ticket expired. Run /obs again.",
      "查看凭证已失效，请重新执行 /obs",
    );
  if (value.startsWith("request-failed:"))
    return translate(
      `Request failed (${value.split(":")[1]}).`,
      `服务请求失败 (${value.split(":")[1]})`,
    );
  if (value.includes("Failed to fetch") || value.includes("NetworkError"))
    return translate(
      "Unable to connect to the local observer.",
      "无法连接本地观察器。",
    );
  return value;
}
