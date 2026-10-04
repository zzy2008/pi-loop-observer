import React, { useState } from "react";
import type { Projection, ProjectedSpan } from "../../src/model/index.js";
import { duration, statusLabel } from "./presentation";
import { buildDisplayIndex, nameOf, type DisplayIndex } from "./display-model";
import {
  formatDuration,
  formatTimestamp,
  measureInterval,
  measureBoundary,
  timelineRange,
  measureOverview,
} from "./timing";
import { useI18n } from "./i18n";
export function Timeline({
  view,
  selected,
  onSelect,
  collapsed,
  display,
}: {
  view: Projection;
  selected?: string;
  onSelect: (id: string) => void;
  collapsed: Set<string>;
  display?: DisplayIndex;
}) {
  const { language, t } = useI18n();
  const [overview, setOverview] = useState(false);
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
    <section className="timeline">
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
                {formatDuration(summaryDuration, language)}
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
                const { min, range } = timelineRange(
                  group.spans,
                  clock,
                  boundaries,
                )!;
                const x = (ms: number) => 260 + ((ms - min) / range) * 700;
                return (
                  <div className="timeline-scroll" key={clock}>
                    <svg
                      viewBox={`0 0 1000 ${50 + rows.length * 40}`}
                      data-range-min={min}
                      data-range-ms={range}
                      role="img"
                      aria-label={`${group.label} · ${clock}`}
                    >
                      {[0, 0.25, 0.5, 0.75, 1].map((r) => (
                        <g key={r}>
                          <line
                            x1={260 + r * 700}
                            x2={260 + r * 700}
                            y1={28}
                            y2={50 + rows.length * 40}
                            stroke="#31453d"
                          />
                          <text
                            x={260 + r * 700}
                            y={20}
                            fill="#9cb4a9"
                            fontSize="12"
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
                          const label = `${nameOf(labels, id, id)} · ${boundary == null && interval.estimated ? "≈ " : ""}${formatDuration(boundary ?? interval.durationMs, language)}${boundary == null ? ` · ${t("Observed calls", "已观测调用区间")}` : ""}${collapsed.has(id) ? ` · ${t("Collapsed", "已折叠")}` : ""}`;
                          return (
                            <g key={`turn:${id}`} data-turn-id={id}>
                              <rect
                                x="0"
                                y={32 + i * 40}
                                width="1000"
                                height="34"
                                fill="#172c24"
                              />
                              <text
                                x="8"
                                y={55 + i * 40}
                                fill="#b9d3c6"
                                fontSize="13"
                                fontWeight="600"
                              >
                                {label}
                              </text>
                            </g>
                          );
                        }
                        const s = row.span;
                        return (
                          <g
                            key={s.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`${nameOf(labels, s.id, s.name)} ${statusLabel(s.state, language)} ${duration(s, language)}`}
                            onClick={() => onSelect(s.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onSelect(s.id);
                              }
                            }}
                          >
                            <text
                              x="8"
                              y={55 + i * 40}
                              fill="#d8e6df"
                              fontSize="12"
                            >
                              {nameOf(labels, s.id, s.name).slice(0, 36)}
                            </text>
                            <rect
                              x={x(s.start!.monoMs!)}
                              y={38 + i * 40}
                              width={Math.max(
                                6,
                                ((s.durationMs ?? 0) / range) * 700,
                              )}
                              height="24"
                              rx="5"
                              fill={
                                s.state === "failed"
                                  ? "#dc877b"
                                  : s.state === "running"
                                    ? "#e2bc6c"
                                    : "#6acda0"
                              }
                              stroke={
                                selected === s.id ? "white" : "transparent"
                              }
                              strokeWidth="2"
                            />
                            <title>{`${nameOf(labels, s.id, s.name)} · ${duration(s, language)} · ${formatTimestamp(s.start, language)} → ${formatTimestamp(s.end, language)}`}</title>
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
                    {nameOf(labels, s.id, s.name)} ·{" "}
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
