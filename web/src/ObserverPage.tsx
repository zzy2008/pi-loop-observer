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
import { TraceView } from "./TraceView";
import { Details } from "./DetailsPanel";
import "./motion.css";
import { useTimeLabels } from "./useTimeLabels";
import { AppIcon } from "./AppIcon";
import { useTimedReplay } from "./useTimedReplay";
import { formatDuration } from "./timing";
export function Observer({
  sessionKey,
  sessionControl,
}: {
  sessionKey: string;
  sessionControl?: React.ReactNode;
}) {
  const { language, t } = useI18n();
  const [query, setQuery] = useState("");
  const store = useMemo(() => createSessionStore(sessionKey), [sessionKey]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [connection, setConnection] = useState("loading");
  const [selected, setSelected] = useState<string>();
  const [traceId, setTraceId] = useState<string | undefined>("__latest");
  const [branchLeafId, setBranchLeafId] = useState<string | null | undefined>();
  const [panel, setPanel] = useState("trace");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const filters = useRef<HTMLDetailsElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const replayTraceId =
    traceId === "__latest"
      ? Object.values(snapshot.live.traces).at(-1)?.id
      : traceId;
  const playback = useTimedReplay(store, snapshot, replayTraceId);
  const axisView = useMemo(
    () => project(snapshot.live, { branchLeafId }),
    [snapshot.live, branchLeafId],
  );
  const { playing, speed } = playback;
  const timeLabel = useTimeLabels(playing);
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
      now:
        snapshot.mode !== "live"
          ? playback.now
          : latest
            ? {
                ...latest,
                monoMs: latest.monoMs === null ? null : latest.monoMs + elapsed,
              }
            : undefined,
    });
  }, [snapshot.visible, snapshot.mode, tick, playback.position]);
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
      now:
        snapshot.mode !== "live"
          ? playback.now
          : latest
            ? {
                ...latest,
                monoMs: latest.monoMs === null ? null : latest.monoMs + elapsed,
              }
            : undefined,
    });
  }, [snapshot.visible, snapshot.mode, branchLeafId, tick, playback.position]);
  const resolvedTraceId =
    traceId === "__latest" ? branchView.traces.at(-1)?.id : traceId;
  const filteredView = useMemo(
    () =>
      resolvedTraceId
        ? {
            ...branchView,
            traces: branchView.traces.filter((x) => x.id === resolvedTraceId),
            turns: branchView.turns.filter(
              (x) => x.traceId === resolvedTraceId,
            ),
            spans: branchView.spans.filter(
              (x) => x.traceId === resolvedTraceId,
            ),
          }
        : branchView,
    [branchView, resolvedTraceId],
  );
  const matches = searchVisibleCalls(
    query.trim() ? view.spans : filteredView.spans,
    display,
    query,
    language,
  );
  const canReplay =
    playback.duration > 0 &&
    snapshot.events.some((e) => e.source === "pi-live");
  const choose = (id: string) => {
    const span = view.spans.find((s) => s.id === id);
    if (query.trim() && span) {
      setTraceId(span.traceId);
      setBranchLeafId(null);
    }
    if (filters.current) filters.current.open = false;
    setSelected(id);
    setInspectorOpen(true);
  };
  const toggleTurn = (id: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const stops = playback.events.filter((e) =>
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
    const event =
      direction > 0
        ? stops.find((e) => BigInt(e.cursor) > BigInt(snapshot.visible.cursor))
        : [...stops]
            .reverse()
            .find((e) => BigInt(e.cursor) < BigInt(snapshot.visible.cursor));
    if (event) playback.seekEvent(playback.events.indexOf(event));
    else if (playing) playback.pause();
  };
  return (
    <>
      <div className="session-context">
        {sessionControl}
        <header className="run-header">
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
                : t("Inactive", "未采集")}
            </span>
            <span>
              {t("Active calls:", "活动调用：")} {view.active.length}
            </span>
          </div>
        </header>
      </div>
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
      <div className="observer-tools">
        <label>
          {t("Question", "问题")}{" "}
          <select
            aria-label={t("Select question", "选择问题")}
            value={traceId ?? ""}
            onChange={(e) => {
              setTraceId(e.target.value || undefined);
              setSelected(undefined);
              setInspectorOpen(false);
            }}
          >
            <option value="__latest">
              {t("Follow latest question", "跟随最新问题")}
            </option>
            <option value="">{t("All questions", "全部问题")}</option>
            {view.traces.map((trace) => (
              <option key={trace.id} value={trace.id}>
                {nameOf(display, trace.id, trace.label)}
              </option>
            ))}
          </select>
        </label>
        <div className="search-controls" data-searching={Boolean(query.trim())}>
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
      </div>
      <details className="observer-filters" ref={filters}>
        <summary>{t("View filters", "筛选与定位")}</summary>
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
            <button onClick={() => setInspectorOpen(true)}>
              {t("View selected details", "查看所选详情")}
            </button>
          )}
        </div>
      </details>
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
      <div className="workspace-heading">
        <h2>{t("Session activity", "会话活动")}</h2>
        <nav
          className="mobile-tabs"
          aria-label={t("Workspace views", "工作区视图")}
        >
          {[
            ["trace", t("Trace", "执行轨迹")],
            ["graph", t("Call graph", "调用图")],
            ["timeline", t("Timeline", "时间轴")],
          ].map(([key, label]) => (
            <button
              key={key}
              className={panel === key && !inspectorOpen ? "active" : ""}
              aria-pressed={panel === key}
              onClick={() => {
                setPanel(key);
                setInspectorOpen(false);
              }}
            >
              {label}
            </button>
          ))}
          {selected && (
            <button
              aria-pressed={inspectorOpen}
              onClick={() => setInspectorOpen(!inspectorOpen)}
            >
              {t("Details", "详情")}
            </button>
          )}
        </nav>
      </div>
      <div
        className={`workspace ${inspectorOpen ? "with-inspector" : ""}`}
        data-view={panel}
        data-motion={
          playing
            ? "replay"
            : snapshot.mode === "live" && connection === "connected"
              ? "live"
              : "paused"
        }
      >
        <div className={`trace-wrap panel ${panel === "trace" ? "shown" : ""}`}>
          <TraceView
            axisView={snapshot.mode !== "live" ? axisView : undefined}
            animateTime={
              playing ||
              (snapshot.mode === "live" && connection === "connected")
            }
            view={filteredView}
            display={display}
            selected={selected}
            onSelect={choose}
            collapsed={collapsed}
            onToggleTurn={toggleTurn}
          />
        </div>
        <main className={`graph panel ${panel === "graph" ? "shown" : ""}`}>
          <Graph
            animateTime={
              playing ||
              (snapshot.mode === "live" && connection === "connected")
            }
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
        <div className={`detail-wrap panel ${inspectorOpen ? "shown" : ""}`}>
          <div className="inspector-heading">
            <span>{t("Call details", "调用详情")}</span>
            <button
              onClick={() => setInspectorOpen(false)}
              aria-label={t("Close details", "关闭详情")}
            >
              {t("Close", "关闭")}
            </button>
          </div>
          <Details
            display={display}
            span={view.spans.find((s) => s.id === selected)}
            entity={
              view.traces.find((x) => x.id === selected) ??
              view.turns.find((x) => x.id === selected)
            }
            relatedSpans={view.spans.filter(
              (x) => x.traceId === selected || x.turnId === selected,
            )}
            onSelect={choose}
            sessionKey={sessionKey}
            cursor={snapshot.visible.cursor}
          />
        </div>
        <div
          className={`timeline-wrap panel ${panel === "timeline" ? "shown" : ""}`}
        >
          <Timeline
            axisView={snapshot.mode !== "live" ? axisView : undefined}
            animateTime={
              playing ||
              (snapshot.mode === "live" && connection === "connected")
            }
            view={filteredView}
            display={display}
            selected={selected}
            onSelect={choose}
            collapsed={collapsed}
          />
        </div>
      </div>
      <footer className="replay" aria-label={t("Time replay", "时间回放")}>
        <span className="replay-label">
          {replayTraceId
            ? t("Question replay", "问题回放")
            : t("All questions · idle skipped", "全部问题 · 跳过空闲")}
        </span>
        <button
          onClick={() => {
            playback.followLive();
          }}
          className={snapshot.mode === "live" ? "active" : ""}
        >
          {t("Back to live", "回到实时")}
        </button>
        <button
          className="replay-icon-button"
          onClick={() => step(-1)}
          disabled={!canReplay}
          aria-label={t("Previous stage", "上一阶段")}
          title={t("Previous stage", "上一阶段")}
        >
          <AppIcon name="previous" />
        </button>
        <button
          className="replay-icon-button replay-toggle"
          aria-label={playing ? t("Pause", "暂停") : t("Play", "播放")}
          title={playing ? t("Pause", "暂停") : t("Play", "播放")}
          onClick={() => {
            if (playing) playback.pause();
            else {
              const first =
                snapshot.mode === "live"
                  ? playback.events.findIndex(
                      (e) =>
                        e.fact.type === "input.applied" &&
                        (!resolvedTraceId ||
                          e.fact.traceId === resolvedTraceId),
                    )
                  : undefined;
              playback.play(first == null ? undefined : Math.max(0, first));
            }
          }}
          disabled={!canReplay}
        >
          <AppIcon name={playing ? "pause" : "play"} />
        </button>
        <button
          className="replay-icon-button"
          onClick={() => step(1)}
          disabled={!canReplay}
          aria-label={t("Next stage", "下一阶段")}
          title={t("Next stage", "下一阶段")}
        >
          <AppIcon name="next" />
        </button>
        <select
          aria-label={t("Replay speed", "回放速度")}
          value={speed}
          onChange={(e) => playback.setSpeed(Number(e.target.value))}
        >
          <option value=".5">0.5×</option>
          <option value="1">1×</option>
          <option value="2">2×</option>
        </select>
        <input
          aria-label={t("Replay position", "回放时间")}
          type="range"
          min="0"
          max={playback.duration}
          step="any"
          value={
            snapshot.mode === "live" ? playback.duration : playback.position
          }
          aria-valuetext={`${formatDuration(snapshot.mode === "live" ? playback.duration : playback.position, language)} / ${formatDuration(playback.duration, language)}`}
          disabled={!canReplay}
          onChange={(e) => {
            playback.seekTime(Number(e.target.value));
          }}
        />
        <span>
          {snapshot.mode === "live" ? "LIVE" : t("Replay", "回放")} ·{" "}
          {timeLabel(
            "playhead",
            snapshot.mode === "live" ? playback.duration : playback.position,
          )}{" "}
          / {formatDuration(playback.duration, language)}
          {playback.approximate && (
            <small
              title={t(
                "Clock changes use wall-clock gaps; backward timestamps are clamped.",
                "跨时钟使用墙上时钟间隔，回退时间戳按零间隔处理。",
              )}
            >
              {" "}
              · {t("Approximate timing", "近似时序")}
            </small>
          )}
        </span>
        {!canReplay && (
          <small>
            {t(
              "This recording has no timed live events; content browsing is available",
              "此记录缺少可计时的实时事件，仅支持内容浏览",
            )}
          </small>
        )}
      </footer>
    </>
  );
}
