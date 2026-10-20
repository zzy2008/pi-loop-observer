import React, { useState, useRef, useEffect } from "react";
import type { Projection, ProjectedSpan } from "../../src/model/index.js";
import { statusLabel } from "./presentation";
import {
  buildDisplayIndex,
  nameOf,
  scopedName,
  type DisplayIndex,
} from "./display-model";
import {
  observedEnd,
  runningAxisRange,
  timeBarDuration,
  timeBarDescription,
  formatDuration,
  formatTimestamp,
  measureInterval,
  measureBoundary,
  timelineRange,
  measureOverview,
} from "./timing";
import { useTimeLabels } from "./useTimeLabels";
import { useI18n } from "./i18n";
export function Timeline({
  view,
  axisView,
  animateTime = false,
  selected,
  onSelect,
  collapsed,
  display,
}: {
  view: Projection;
  axisView?: Projection;
  animateTime?: boolean;
  selected?: string;
  onSelect: (id: string) => void;
  collapsed: Set<string>;
  display?: DisplayIndex;
}) {
  const { language, t } = useI18n();
  const timeLabel = useTimeLabels(animateTime);
  const [overview, setOverview] = useState(false);
  const container = useRef<HTMLElement>(null);
  const [chartWidth, setChartWidth] = useState(1000);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setChartWidth(Math.max(680, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const labelWidth = 260;
  const plotWidth = chartWidth - labelWidth - 88;
  const labels = display ?? buildDisplayIndex(view, language);
  const groups = overview
    ? [
        {
          id: "overview",
          label: t(
            "Session overview (includes idle gaps)",
            "会话总览（包含空闲间隔）",
          ),
          spans: view.spans,
        },
      ]
    : view.traces.map((trace) => ({
        id: trace.id,
        label: nameOf(labels, trace.id, trace.label),
        spans: view.spans.filter((s) => s.traceId === trace.id),
      }));
  const localName = (id: string, fallback: string, call = false) => {
    const full = nameOf(labels, id, fallback);
    return scopedName(full, language, {
      question: !overview,
      turn: !overview && call,
    });
  };
  const unassigned = view.spans.filter(
    (s) => !s.traceId || !view.traces.some((trace) => trace.id === s.traceId),
  );
  if (!overview && unassigned.length)
    groups.push({
      id: "unassigned",
      label: t("Unassigned calls", "未关联调用"),
      spans: unassigned,
    });
  return (
    <section className="timeline" ref={container}>
      <h2>{t("Timeline", "时间轴")}</h2>
      <div>
        <button aria-pressed={!overview} onClick={() => setOverview(false)}>
          {t("Per question", "按问题")}
        </button>
        <button aria-pressed={overview} onClick={() => setOverview(true)}>
          {t("Session overview", "会话总览")}
        </button>
      </div>
      {groups
        .filter((g) => g.spans.length)
        .map((group) => {
          const interval = measureInterval(group.spans);
          const overviewInterval = measureOverview(group.spans, view.traces);
          const boundaryDuration = overview
            ? overviewInterval.observed
              ? null
              : overviewInterval.durationMs
            : measureBoundary(
                view.traces.find((trace) => trace.id === group.id) ?? {},
              );
          const summaryDuration = overview
            ? overviewInterval.durationMs
            : (boundaryDuration ?? interval.durationMs);
          const visible = group.spans.filter(
            (s) => !collapsed.has(s.turnId ?? ""),
          );
          const clocks = [
            ...new Set(
              group.spans
                .filter(
                  (s) =>
                    s.quality.timing !== "unknown" &&
                    s.start?.clockId &&
                    s.start.monoMs != null,
                )
                .map((s) => s.start!.clockId!),
            ),
          ];
          return (
            <div
              key={group.id}
              data-testid="question-timeline"
              data-trace-id={group.id}
              data-duration-ms={summaryDuration ?? "unknown"}
            >
              <h3>
                {group.label} ·{" "}
                {boundaryDuration == null && interval.estimated ? "≈ " : ""}
                {timeLabel(
                  group.id + ":summary",
                  summaryDuration,
                  !interval.estimated,
                )}
                {boundaryDuration === null
                  ? ` · ${t("Observed calls", "已观测调用区间")}`
                  : ""}
              </h3>
              {clocks.map((clock) => {
                const clockSpans = group.spans.filter(
                  (s) =>
                    s.start?.clockId === clock &&
                    s.start.monoMs != null &&
                    s.quality.timing !== "unknown",
                );
                const rows: ({ turnId: string } | { span: ProjectedSpan })[] =
                  [];
                const turns = [...new Set(clockSpans.map((s) => s.turnId))];
                for (const turnId of turns) {
                  if (turnId) rows.push({ turnId });
                  if (!turnId || !collapsed.has(turnId))
                    rows.push(
                      ...clockSpans
                        .filter((s) => s.turnId === turnId)
                        .map((span) => ({ span })),
                    );
                }
                const boundaries = overview
                  ? view.traces
                  : view.traces.filter((trace) => trace.id === group.id);
                const { min, range: measuredRange } =
                  timelineRange(
                    axisView
                      ? axisView.spans.filter(
                          (s) => overview || s.traceId === group.id,
                        )
                      : group.spans,
                    clock,
                    axisView
                      ? axisView.traces.filter(
                          (t) => overview || t.id === group.id,
                        )
                      : boundaries,
                  ) ?? timelineRange(group.spans, clock, boundaries)!;
                const range =
                  !axisView &&
                  animateTime &&
                  clockSpans.some((s) => s.state === "running")
                    ? runningAxisRange(measuredRange)
                    : measuredRange;
                const x = (ms: number) =>
                  labelWidth + ((ms - min) / range) * plotWidth;
                return (
                  <div className="timeline-scroll" key={clock}>
                    <svg
                      className="timeline-chart"
                      viewBox={`0 0 ${chartWidth} ${50 + rows.length * 40}`}
                      width={chartWidth}
                      height={50 + rows.length * 40}
                      style={{
                        width: chartWidth,
                        fontFamily: "var(--font-sans)",
                      }}
                      data-range-min={min}
                      data-range-ms={range}
                      role="img"
                      aria-label={`${group.label} · ${clock}`}
                    >
                      {[0, 0.25, 0.5, 0.75, 1].map((r) => (
                        <g key={r}>
                          <line
                            x1={labelWidth + r * plotWidth}
                            x2={labelWidth + r * plotWidth}
                            y1={28}
                            y2={50 + rows.length * 40}
                            stroke="var(--grid)"
                          />
                          <text
                            x={labelWidth + r * plotWidth}
                            y={20}
                            fill="var(--muted)"
                            fontSize="var(--font-caption)"
                            textAnchor={r === 1 ? "end" : "start"}
                          >
                            {formatDuration(r * range, language)}
                          </text>
                        </g>
                      ))}
                      {rows.map((row, i) => {
                        if ("turnId" in row) {
                          const id = row.turnId;
                          const boundary = measureBoundary(
                            view.turns.find((turn) => turn.id === id) ?? {},
                          );
                          const interval = measureInterval(
                            group.spans.filter((s) => s.turnId === id),
                          );
                          const label = `${localName(id, id)} · ${boundary == null && interval.estimated ? "≈ " : ""}${timeLabel(id + ":turn", boundary ?? interval.durationMs, boundary != null || !interval.estimated)}${boundary == null ? ` · ${t("Observed calls", "已观测调用区间")}` : ""}${collapsed.has(id) ? ` · ${t("Collapsed", "已折叠")}` : ""}`;
                          return (
                            <g key={`turn:${id}`} data-turn-id={id}>
                              <title>{nameOf(labels, id, id)}</title>
                              <rect
                                x="0"
                                y={32 + i * 40}
                                width={chartWidth}
                                height="34"
                                fill="var(--surface-raised)"
                              />
                              <text
                                x="8"
                                y={55 + i * 40}
                                fill="var(--muted)"
                                fontSize="var(--font-body)"
                                fontWeight="var(--weight-strong)"
                              >
                                {label}
                              </text>
                            </g>
                          );
                        }
                        const s = row.span;
                        const barX = x(s.start!.monoMs!);
                        const barWidth = Math.max(
                          4,
                          (((observedEnd(s) ?? s.start!.monoMs!) -
                            s.start!.monoMs!) /
                            range) *
                            plotWidth,
                        );
                        const color =
                          s.state === "failed"
                            ? "var(--danger)"
                            : s.kind === "llm"
                              ? "var(--node-llm)"
                              : "var(--node-tool)";
                        return (
                          <g
                            key={s.id}
                            className={`timeline-call ${selected === s.id ? "is-selected" : ""} ${s.state === "running" ? "is-running" : ""}`}
                            data-span-id={s.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`${nameOf(labels, s.id, s.name)} ${statusLabel(s.state, language)} ${(s.estimated ? (language === "zh" ? "约 " : "~ ") : "") + timeLabel(s.id, observedEnd(s) == null ? null : observedEnd(s)! - s.start!.monoMs!, s.state !== "running")}`}
                            onClick={() => onSelect(s.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onSelect(s.id);
                              }
                            }}
                          >
                            <rect
                              className="timeline-row-highlight"
                              x="0"
                              y={32 + i * 40}
                              width={chartWidth}
                              height="34"
                              rx="6"
                            />
                            <text
                              x="8"
                              y={55 + i * 40}
                              fill="var(--text)"
                              fontSize="var(--font-body)"
                            >
                              {localName(s.id, s.name, true).slice(0, 36)}
                            </text>
                            <line
                              x1={labelWidth}
                              x2={labelWidth + plotWidth}
                              y1={50 + i * 40}
                              y2={50 + i * 40}
                              stroke="var(--grid)"
                              strokeOpacity=".45"
                            />
                            <rect
                              className="timeline-duration-bar"
                              x={barX}
                              y={44 + i * 40}
                              width={barWidth}
                              height="12"
                              rx="6"
                              fill={color}
                              fillOpacity=".8"
                              stroke={selected === s.id ? "var(--text)" : color}
                              strokeWidth={selected === s.id ? 2 : 1}
                              strokeDasharray={
                                s.state === "running" ? "3 3" : undefined
                              }
                            />
                            {s.state === "running" && (
                              <>
                                <rect
                                  className="timeline-running-stream"
                                  x={barX}
                                  y={44 + i * 40}
                                  width={barWidth}
                                  height="12"
                                  rx="6"
                                  fill="none"
                                  stroke="var(--text)"
                                  strokeOpacity=".45"
                                  strokeWidth="1.5"
                                  strokeDasharray="4 12"
                                  aria-hidden="true"
                                />
                                <circle
                                  className="timeline-running-tip"
                                  cx={barX + barWidth}
                                  cy={50 + i * 40}
                                  r="3.5"
                                  fill={color}
                                  aria-hidden="true"
                                />
                              </>
                            )}
                            <circle
                              cx={barX + 2}
                              cy={50 + i * 40}
                              r="3"
                              fill={color}
                            />
                            <text
                              className="timeline-duration-label"
                              x={Math.min(chartWidth - 70, barX + barWidth + 8)}
                              y={54 + i * 40}
                              fill="var(--muted)"
                              fontSize="var(--font-caption)"
                            >
                              {s.state === "failed"
                                ? "× "
                                : s.state === "cancelled"
                                  ? "⊘ "
                                  : ""}
                              {(s.estimated
                                ? language === "zh"
                                  ? "约 "
                                  : "~ "
                                : "") +
                                timeLabel(
                                  s.id,
                                  observedEnd(s) == null
                                    ? null
                                    : observedEnd(s)! - s.start!.monoMs!,
                                  s.state !== "running",
                                )}
                            </text>
                            <title>{`${nameOf(labels, s.id, s.name)} · ${statusLabel(s.state, language)} · ${timeBarDescription(s, language)} · ${formatTimestamp(s.start, language)} → ${formatTimestamp(s.end, language)}`}</title>
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                );
              })}
              {visible
                .filter(
                  (s) =>
                    s.quality.timing === "unknown" ||
                    !s.start?.clockId ||
                    s.start.monoMs == null,
                )
                .map((s) => (
                  <button key={s.id} onClick={() => onSelect(s.id)}>
                    {localName(s.id, s.name, true)} ·{" "}
                    {t("Timing unknown", "时序未记录")}
                  </button>
                ))}
            </div>
          );
        })}
      {!view.spans.length && (
        <p>
          {t(
            "Select a question to inspect calls and timing.",
            "选择问题后查看调用与时序。",
          )}
        </p>
      )}
    </section>
  );
}
