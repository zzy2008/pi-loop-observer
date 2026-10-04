import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ProjectedSpan, Projection } from "../../src/model/index.js";
import { statusLabel, qualityLabel } from "./presentation";
import { useI18n, errorMessage } from "./i18n";
import { usePayloadSummaries, searchVisibleCalls } from "./usePayloadSummaries";
import { buildDisplayIndex, nameOf } from "./display-model";
import { project } from "../../src/model/index.js";
import { createSessionStore } from "./store";
import { openSession, subscribe } from "./client";
import { Graph } from "./GraphView";
import { Timeline } from "./TimelineView";
import { Details } from "./DetailsPanel";
export function Observer({ sessionKey }: { sessionKey: string }) {
  const { language, t } = useI18n();
  const [query, setQuery] = useState("");
  const store = useMemo(() => createSessionStore(sessionKey), [sessionKey]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [connection, setConnection] = useState("loading");
  const [selected, setSelected] = useState<string>();
  const [traceId, setTraceId] = useState<string>();
  const [branchLeafId, setBranchLeafId] = useState<string | null | undefined>();
  const [panel, setPanel] = useState("graph");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [tick, setTick] = useState(0);
  const anchor = useRef({ cursor: "0", local: 0 });
  useEffect(() => {
    const controller = new AbortController();
    let close = () => {};
    openSession(sessionKey, controller.signal, store.ingest)
      .then((after) => {
        if (!controller.signal.aborted)
          close = subscribe(sessionKey, after, store.ingest, setConnection);
      })
      .catch((error) => {
        if (!controller.signal.aborted) store.error(String(error));
      });
    return () => {
      controller.abort();
      close();
      store.dispose();
    };
  }, [sessionKey, store]);
  useEffect(() => {
    anchor.current = { cursor: snapshot.live.cursor, local: performance.now() };
  }, [snapshot.live.cursor]);
  useEffect(() => {
    if (snapshot.mode !== "live") return;
    const timer = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(timer);
  }, [snapshot.mode]);
  const view = useMemo(() => {
    const latest = snapshot.visible.events.at(-1)?.observedAt;
    const elapsed =
      snapshot.mode === "live"
        ? Math.max(0, performance.now() - anchor.current.local)
        : 0;
    return project(snapshot.visible, {
      branchLeafId: null,
      now: latest
        ? {
            ...latest,
            monoMs: latest.monoMs === null ? null : latest.monoMs + elapsed,
          }
        : undefined,
    });
  }, [snapshot.visible, snapshot.mode, tick]);
  const payloads = usePayloadSummaries(
    sessionKey,
    snapshot.visible.cursor,
    view,
  );
  const display = useMemo(
    () => buildDisplayIndex(view, language, payloads),
    [view, language, payloads],
  );
  const branchView = useMemo(() => {
    const latest = snapshot.visible.events.at(-1)?.observedAt;
    const elapsed =
      snapshot.mode === "live"
        ? Math.max(0, performance.now() - anchor.current.local)
        : 0;
    return project(snapshot.visible, {
      branchLeafId,
      now: latest
        ? {
            ...latest,
            monoMs: latest.monoMs === null ? null : latest.monoMs + elapsed,
          }
        : undefined,
    });
  }, [snapshot.visible, snapshot.mode, branchLeafId, tick]);
  const filteredView = useMemo(
    () =>
      traceId
        ? {
            ...branchView,
            traces: branchView.traces.filter((x) => x.id === traceId),
            turns: branchView.turns.filter((x) => x.traceId === traceId),
            spans: branchView.spans.filter((x) => x.traceId === traceId),
          }
        : branchView,
    [branchView, traceId],
  );
  const matches = searchVisibleCalls(
    query.trim() ? view.spans : filteredView.spans,
    display,
    query,
    language,
  );
  const index = snapshot.events.findIndex(
    (e) => e.cursor === snapshot.visible.cursor,
  );
  const canReplay = snapshot.events.some(
    (e) => e.source === "pi-live" && e.fact.type === "span.stage_changed",
  );
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      const next = snapshot.events.find(
        (e) =>
          BigInt(e.cursor) > BigInt(snapshot.visible.cursor) &&
          [
            "span.started",
            "span.stage_changed",
            "span.ended",
            "input.applied",
            "capture.gap",
            "run.started",
            "run.ended",
            "run.settled",
          ].includes(e.fact.type),
      );
      if (next) store.seek(next.cursor);
      else setPlaying(false);
    }, 600 / speed);
    return () => clearTimeout(timer);
  }, [playing, index, snapshot.events, speed, store]);
  const choose = (id: string) => {
    const span = view.spans.find((s) => s.id === id);
    if (query.trim() && span) {
      setTraceId(span.traceId);
      setBranchLeafId(null);
    }
    setSelected(id);
    setPanel("details");
  };
  const stops = snapshot.events.filter((e) =>
    [
      "span.started",
      "span.stage_changed",
      "span.ended",
      "input.applied",
      "capture.gap",
      "run.started",
      "run.ended",
      "run.settled",
    ].includes(e.fact.type),
  );
  const step = (direction: number) => {
    setPlaying(false);
    const event =
      direction > 0
        ? stops.find((e) => BigInt(e.cursor) > BigInt(snapshot.visible.cursor))
        : [...stops]
            .reverse()
            .find((e) => BigInt(e.cursor) < BigInt(snapshot.visible.cursor));
    if (event) store.seek(event.cursor);
  };
  return (
    <>
      <header className="run-header">
        <div>
          <small>{t("Read-only local observer", "只读本地观察器")}</small>
          <h1>Pi Loop Observer</h1>
        </div>
        <div className="status">
          <span>
            {connection === "connected"
              ? t("Connected", "已连接")
              : connection === "reconnecting"
                ? t("Disconnected; reconnecting", "网页连接中断，正在重连")
                : connection === "invalid-events"
                  ? t(
                      "Invalid event data; refresh to reload",
                      "事件格式异常，请刷新重新载入",
                    )
                  : t("Loading history", "载入历史")}
          </span>
          <span>
            {t("Capture:", "采集：")}{" "}
            {view.capturing
              ? t("Recording", "进行中")
              : t("Stopped / not started", "已结束 / 未启动")}
          </span>
          <span>
            {t("Active calls:", "活动调用：")} {view.active.length}
          </span>
        </div>
      </header>
      {snapshot.error && (
        <p className="warning" role="alert">
          {errorMessage(snapshot.error, language)}
        </p>
      )}
      {view.gaps.map((g) => (
        <p className="warning" key={qualityLabel(g, language)}>
          {t("Recording gap:", "记录缺口：")} {qualityLabel(g, language)}
        </p>
      ))}
      <nav className="trace-nav">
        <select
          aria-label={t("History branch", "历史分支")}
          value={branchLeafId === null ? "all" : (branchLeafId ?? "current")}
          onChange={(e) =>
            setBranchLeafId(
              e.target.value === "all"
                ? null
                : e.target.value === "current"
                  ? undefined
                  : e.target.value,
            )
          }
        >
          <option value="current">
            {t("Current branch", "当前分支")} (
            {snapshot.visible.leafId ?? t("Not recorded", "未记录")})
          </option>
          <option value="all">{t("All records", "全部记录")}</option>
          {Object.keys(snapshot.visible.entries)
            .filter(
              (key) =>
                !Object.values(snapshot.visible.entries).some(
                  (entry) =>
                    entry.parentId &&
                    (key === entry.parentId ||
                      key === `${sessionKey}:${entry.parentId}`),
                ),
            )
            .map((key) => (
              <option key={key} value={key}>
                {t("Historical leaf", "历史叶节点")} {key.split(":").at(-1)}
              </option>
            ))}
        </select>
        <label>
          {t("Question", "问题")}{" "}
          <select
            aria-label={t("Select question", "选择问题")}
            value={traceId ?? ""}
            onChange={(e) => setTraceId(e.target.value || undefined)}
          >
            <option value="">{t("All questions", "全部问题")}</option>
            {view.traces.map((trace) => (
              <option key={trace.id} value={trace.id}>
                {nameOf(display, trace.id, trace.label)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Turn", "轮次")}{" "}
          <select
            aria-label={t("Navigate to turn", "定位轮次")}
            value=""
            onChange={(e) => {
              if (e.target.value)
                setCollapsed((old) => {
                  const next = new Set(old);
                  next.has(e.target.value)
                    ? next.delete(e.target.value)
                    : next.add(e.target.value);
                  return next;
                });
            }}
          >
            <option value="">
              {t("Expand or collapse a turn", "展开或折叠轮次")}
            </option>
            {filteredView.turns.map((turn) => (
              <option key={turn.id} value={turn.id}>
                {nameOf(display, turn.id, turn.id)} ·{" "}
                {collapsed.has(turn.id)
                  ? t("Expand", "展开")
                  : t("Collapse", "折叠")}
              </option>
            ))}
          </select>
        </label>
      </nav>
      <div className="search-controls">
        <label htmlFor="call-search">{t("Search", "搜索")}</label>
        <input
          id="call-search"
          aria-label={t("Search current session", "搜索当前会话")}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t(
            "Name, model, tool, status or ID",
            "名称、模型、工具、状态或 ID",
          )}
        />
        {query && (
          <button onClick={() => setQuery("")}>
            {t("Clear search", "清除搜索")}
          </button>
        )}
        <span role="status" data-testid="search-count">
          {matches.length} {t("matching calls", "个匹配调用")}
        </span>
      </div>
      <div className="call-picker">
        <label htmlFor="call-picker">{t("Select call", "选择调用")}</label>
        <select
          id="call-picker"
          aria-label={t("Select call", "选择调用")}
          value={matches.some((x) => x.id === selected) ? selected : ""}
          onChange={(e) => {
            if (e.target.value) choose(e.target.value);
          }}
        >
          <option value="">
            {t("Select a call to view details", "选择调用查看详情")}
          </option>
          {matches.map((span) => (
            <option key={span.id} value={span.id}>
              {nameOf(display, span.id, span.name)} ·{" "}
              {statusLabel(span.state, language)}
            </option>
          ))}
        </select>
        {selected && (
          <button onClick={() => setPanel("details")}>
            {t("View selected details", "查看所选详情")}
          </button>
        )}
      </div>
      {query.trim() && (
        <div className="search-results" data-testid="search-results">
          {matches.length ? (
            matches.map((span) => (
              <button key={span.id} onClick={() => choose(span.id)}>
                {nameOf(display, span.id, span.name)}
              </button>
            ))
          ) : (
            <p>
              {t(
                "No calls match this search in the visible replay history.",
                "当前可见回放记录中没有匹配调用。",
              )}
            </p>
          )}
        </div>
      )}
      <nav className="mobile-tabs">
        {[
          ["graph", t("Call graph", "调用图")],
          ["timeline", t("Timeline", "时间轴")],
          ["details", t("Details", "详情")],
        ].map(([key, label]) => (
          <button
            key={key}
            className={panel === key ? "active" : ""}
            onClick={() => setPanel(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="workspace">
        <main className={`graph panel ${panel === "graph" ? "shown" : ""}`}>
          <Graph
            view={filteredView}
            display={display}
            selected={selected}
            onSelect={choose}
            collapsed={collapsed}
            onToggleTurn={(id) =>
              setCollapsed((old) => {
                const next = new Set(old);
                next.has(id) ? next.delete(id) : next.add(id);
                return next;
              })
            }
          />
          {!view.spans.length && (
            <div className="empty">
              {t("No calls recorded in this session", "此会话尚无调用记录")}
            </div>
          )}
          {collapsed.size > 0 && (
            <div className="collapsed-note">
              {t(
                `${collapsed.size} turns collapsed; select a summary to inspect calls`,
                `已折叠 ${collapsed.size} 个轮次；可点击摘要查看调用`,
              )}
            </div>
          )}
        </main>
        <div
          className={`detail-wrap panel ${panel === "details" ? "shown" : ""}`}
        >
          <Details
            display={display}
            span={view.spans.find((s) => s.id === selected)}
            sessionKey={sessionKey}
            cursor={snapshot.visible.cursor}
          />
        </div>
        <div
          className={`timeline-wrap panel ${panel === "timeline" ? "shown" : ""}`}
        >
          <Timeline
            view={filteredView}
            display={display}
            selected={selected}
            onSelect={choose}
            collapsed={collapsed}
          />
        </div>
      </div>
      <footer className="replay">
        <button
          onClick={() => {
            setPlaying(false);
            store.followLive();
          }}
          className={snapshot.mode === "live" ? "active" : ""}
        >
          {t("Back to live", "回到实时")}
        </button>
        <button onClick={() => step(-1)} disabled={!canReplay}>
          {t("Previous stage", "上一阶段")}
        </button>
        <button
          onClick={() => {
            if (snapshot.mode === "live") step(-1);
            setPlaying(!playing);
          }}
          disabled={!canReplay}
        >
          {playing ? t("Pause", "暂停") : t("Play", "播放")}
        </button>
        <button onClick={() => step(1)} disabled={!canReplay}>
          {t("Next stage", "下一阶段")}
        </button>
        <select
          aria-label={t("Replay speed", "回放速度")}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        >
          <option value=".5">0.5×</option>
          <option value="1">1×</option>
          <option value="2">2×</option>
        </select>
        <input
          aria-label={t("Replay position", "阶段游标")}
          type="range"
          min="0"
          max={Math.max(0, snapshot.events.length - 1)}
          value={Math.max(0, index)}
          disabled={!canReplay}
          onChange={(e) => {
            setPlaying(false);
            const event = snapshot.events[Number(e.target.value)];
            if (event) store.seek(event.cursor);
          }}
        />
        <span>
          {snapshot.mode === "live" ? "LIVE" : t("Replay", "历史阶段")} ·{" "}
          {snapshot.visible.cursor}
        </span>
        {!canReplay && (
          <small>
            {t(
              "This recording has no live stages; content browsing is available",
              "此记录缺少实时阶段，仅支持内容浏览",
            )}
          </small>
        )}
      </footer>
    </>
  );
}
