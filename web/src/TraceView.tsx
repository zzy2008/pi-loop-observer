import React, { useEffect, useRef, useMemo } from "react";
import type { Projection } from "../../src/model/index.js";
import { nameOf, scopedName, type DisplayIndex } from "./display-model";
import { useI18n } from "./i18n";
import { statusLabel } from "./presentation";
import {
  formatDuration,
  runningAxisRange,
  formatTimestamp,
  measureBoundary,
  timeBarDuration,
  timeBarDescription,
} from "./timing";
import { buildTraceLayout, spanInterval } from "./trace-layout";
import "./trace-view.css";
import { useTimeLabels } from "./useTimeLabels";
export function TraceView({
  view,
  axisView,
  animateTime = false,
  display,
  selected,
  onSelect,
  collapsed,
  onToggleTurn,
}: {
  view: Projection;
  axisView?: Projection;
  animateTime?: boolean;
  display: DisplayIndex;
  selected?: string;
  onSelect: (id: string) => void;
  collapsed: Set<string>;
  onToggleTurn: (id: string) => void;
}) {
  const { language, t } = useI18n();
  const timeLabel = useTimeLabels(animateTime);
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selected) return;
    const row = container.current?.querySelector<HTMLElement>(
      ".trace-row.is-selected",
    );
    if (!row) return;
    // Scroll only the enclosing trace viewport; live projection ticks do not rerun this effect.
    let viewport = container.current?.parentElement;
    while (viewport && viewport !== document.body) {
      const overflow = getComputedStyle(viewport).overflowY;
      if (
        (overflow === "auto" || overflow === "scroll") &&
        viewport.scrollHeight > viewport.clientHeight
      ) {
        const bounds = viewport.getBoundingClientRect();
        const target = row.getBoundingClientRect();
        const stickyAxisHeight = 30;
        if (target.top < bounds.top + stickyAxisHeight)
          viewport.scrollTop += target.top - bounds.top - stickyAxisHeight;
        else if (target.bottom > bounds.bottom)
          viewport.scrollTop += target.bottom - bounds.bottom;
        break;
      }
      viewport = viewport.parentElement;
    }
  }, [selected]);
  const groups = buildTraceLayout(view, collapsed);
  const axes = useMemo(
    () => (axisView ? buildTraceLayout(axisView, collapsed) : []),
    [axisView, collapsed],
  );
  for (const group of groups)
    for (const domain of group.domains) {
      const fixed = axes
        .find((g) => g.id === group.id)
        ?.domains.find((d) => d.clock === domain.clock);
      if (fixed) {
        domain.min = fixed.min;
        domain.range = fixed.range;
      } else if (
        animateTime &&
        group.spans.some((s) => s.state === "running")
      ) {
        domain.range = runningAxisRange(domain.range);
      }
    }
  return (
    <section
      ref={container}
      className="trace-view"
      aria-label={t("Trace waterfall", "调用瀑布图")}
    >
      {groups.map((group) => (
        <article
          className="trace-question"
          key={group.id}
          data-trace-id={group.id}
        >
          <header className="trace-heading">
            <button
              className="trace-question-title"
              onClick={() => onSelect(group.id)}
              title={nameOf(
                display,
                group.id,
                group.trace?.label ?? t("Unassigned calls", "未关联调用"),
              )}
            >
              {nameOf(
                display,
                group.id,
                group.trace?.label ?? t("Unassigned calls", "未关联调用"),
              )}
            </button>
            <time>{formatTimestamp(group.trace?.start, language)}</time>
          </header>
          <dl className="trace-stats">
            {[
              [
                t("Duration", "耗时"),
                timeLabel(
                  group.id + ":duration",
                  group.durationMs,
                  !!group.trace?.end,
                ),
              ],
              [t("Turns", "轮次"), group.turns.length],
              [
                t("Model calls", "模型调用"),
                group.spans.filter((s) => s.kind === "llm").length,
              ],
              [
                t("Tool calls", "工具调用"),
                group.spans.filter((s) => s.kind === "tool").length,
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {group.domains.map((domain) => (
            <div
              className="trace-domain"
              key={domain.clock ?? "unknown"}
              data-clock={domain.clock ?? "unknown"}
              data-range-min={domain.min}
              data-range-ms={domain.range}
            >
              <div className="trace-axis trace-grid">
                <span title={domain.clock ?? ""}>
                  {domain.clock
                    ? t("Observed clock", "观测时钟") +
                      (group.domains.length > 1 ? ` · ${domain.clock}` : "")
                    : t("Timing unknown", "时序未记录")}
                </span>
                <div className="trace-ticks">
                  {domain.clock &&
                    [0, 0.5, 1].map((r) => (
                      <span key={r}>
                        {r === 0
                          ? "0"
                          : formatDuration(r * domain.range, language)}
                      </span>
                    ))}
                </div>
                <span>{t("Duration", "耗时")}</span>
              </div>
              {domain.rows.map((row) => {
                const span = row.span;
                const label = nameOf(display, row.id, span?.name ?? row.id);
                const rowLabel = scopedName(label, language, {
                  question: !!group.trace,
                  turn:
                    !!span?.turnId &&
                    domain.rows.some((item) => item.turn?.id === span.turnId),
                });
                const interval = span && spanInterval(span);
                const state = span
                  ? statusLabel(span.state, language)
                  : collapsed.has(row.id)
                    ? t("Collapsed", "已折叠")
                    : t("Expanded", "已展开");
                const elapsed = span
                  ? (span.estimated ? (language === "zh" ? "约 " : "~ ") : "") +
                    timeLabel(
                      span.id,
                      interval ? interval.end - interval.start : null,
                      span.state !== "running",
                    )
                  : formatDuration(measureBoundary(row.turn!), language);
                return (
                  <div
                    className={`trace-row trace-grid ${span ? `trace-${span.kind} trace-${span.state}` : "trace-turn"} ${selected === row.id ? "is-selected" : ""}`}
                    key={row.id}
                    data-span-id={span?.id}
                    data-turn-id={row.turn?.id}
                  >
                    <div
                      className="trace-label"
                      style={{
                        paddingInlineStart: `${Math.min(row.depth, 4) * 12 + 4}px`,
                      }}
                    >
                      {row.turn && (
                        <button
                          className="trace-fold"
                          onClick={() => onToggleTurn(row.id)}
                          aria-expanded={!collapsed.has(row.id)}
                          aria-label={`${collapsed.has(row.id) ? t("Expand", "展开") : t("Collapse", "折叠")} ${label}`}
                        >
                          {collapsed.has(row.id) ? "▸" : "▾"}
                        </button>
                      )}
                      <button
                        className="trace-select"
                        onClick={() => onSelect(row.id)}
                        title={`${label} · ${state}`}
                        aria-label={`${label} · ${state}`}
                        aria-pressed={selected === row.id}
                      >
                        <span>{rowLabel}</span>
                        <small>{state}</small>
                      </button>
                    </div>
                    <button
                      className="trace-plot"
                      onClick={() => onSelect(row.id)}
                      aria-label={`${label} · ${state} · ${span ? timeBarDuration(span, language) : elapsed}`}
                      tabIndex={-1}
                    >
                      {interval && domain.clock ? (
                        <span
                          className="trace-bar"
                          style={{
                            left: `${Math.max(0, ((interval.start - domain.min) / domain.range) * 100)}%`,
                            width: `${Math.min(100, ((interval.end - interval.start) / domain.range) * 100)}%`,
                          }}
                        />
                      ) : span ? (
                        <span className="trace-no-time">
                          {t("Not recorded", "未记录")}
                        </span>
                      ) : null}
                    </button>
                    <span
                      className="trace-duration"
                      title={
                        span ? timeBarDescription(span, language) : elapsed
                      }
                    >
                      {span?.quality.timing === "unknown" &&
                      span.durationMs == null
                        ? "—"
                        : elapsed}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </article>
      ))}
      {!groups.length && (
        <p>{t("No questions recorded yet.", "暂无问题记录。")}</p>
      )}
    </section>
  );
}
