import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./tokens.css";
import "./style.css";
import "./theme.css";
import "./compact.css";
import { AppIcon } from "./AppIcon";
import { ThemeSelector } from "./theme";
import { Observer } from "./ObserverPage";
import { exchangeTicket, listSessions, type SessionSummary } from "./client";
import { I18nProvider, useI18n, errorMessage } from "./i18n";
function App() {
  const { language, setLanguage, t } = useI18n();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionKey, setSessionKey] = useState(
    new URL(location.href).searchParams.get("sessionKey") ?? "",
  );
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    exchangeTicket()
      .then(() => listSessions(controller.signal))
      .then((data) => {
        setSessions(data);
        // The recorder returns sessions newest-first; explicit session links take precedence.
        setSessionKey((current) => current || data[0]?.sessionKey || "");
        setReady(true);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e));
      });
    const heartbeat = setInterval(() => {
      void fetch("/api/viewers/heartbeat", {
        method: "POST",
        credentials: "same-origin",
      });
    }, 30000);
    return () => {
      controller.abort();
      clearInterval(heartbeat);
    };
  }, []);
  const sessionControl = (
    <div className="session-picker">
      <label>
        {t("Session", "会话")}{" "}
        <select
          aria-label={t("Select session", "选择会话")}
          value={sessionKey}
          onChange={(e) => setSessionKey(e.target.value)}
        >
          <option value="">
            {t("Select a recorded session", "选择历史会话")}
          </option>
          {sessions.map((s) => (
            <option key={s.sessionKey} value={s.sessionKey}>
              {s.label ?? s.sessionKey} ({s.eventCount ?? "—"}{" "}
              {t("events", "条")})
            </option>
          ))}
        </select>
      </label>
    </div>
  );
  return (
    <div className="app">
      <header className="product-header">
        <h1 className="brand-heading">
          <a className="brand" href="/">
            <AppIcon name="brand" />
            Pi Loop Observer
          </a>
        </h1>
        <nav aria-label={t("Product navigation", "产品导航")}>
          <a
            href="https://github.com/zzy2008/pi-loop-observer"
            aria-label="GitHub"
            title="GitHub"
            target="_blank"
            rel="noreferrer"
          >
            <AppIcon name="github" />
            <span className="nav-link-label">GitHub</span>
          </a>
          <a
            href="https://github.com/zzy2008/pi-loop-observer#readme"
            aria-label={t("Documentation", "文档")}
            title={t("Documentation", "文档")}
            target="_blank"
            rel="noreferrer"
          >
            <AppIcon name="docs" />
            <span className="nav-link-label">{t("Documentation", "文档")}</span>
          </a>
          <select
            aria-label={t("Language", "语言")}
            value={language}
            onChange={(e) => setLanguage(e.target.value as "en" | "zh")}
          >
            <option value="en">English</option>
            <option value="zh">中文</option>
          </select>
          <ThemeSelector />
        </nav>
      </header>
      {error && (
        <p className="warning" role="alert">
          {errorMessage(error, language)}
        </p>
      )}
      {ready && sessionKey ? (
        <Observer
          key={sessionKey}
          sessionKey={sessionKey}
          sessionControl={sessionControl}
        />
      ) : (
        <>
          {sessionControl}
          <div className="welcome">
            <h2>{t("Explore a session", "查看会话")}</h2>
            <p>
              {t(
                "Choose a session to explore calls, timing, and stage replay.",
                "选择会话，查看调用图、时序与阶段回放。",
              )}
            </p>
            <p>
              {t(
                "Run /obs in Pi to open the current session. Recording continues when the browser closes.",
                "Pi 中执行 /obs 可打开当前会话；记录在浏览器关闭时持续保存。",
              )}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
);
