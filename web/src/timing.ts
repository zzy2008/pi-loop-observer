import type { ObservedTime, ProjectedSpan } from "../../src/model/index.js";
export type Language = "en" | "zh";
export function formatDuration(
  ms: number | null | undefined,
  language: Language = "en",
): string {
  if (ms == null || !Number.isFinite(ms))
    return language === "zh" ? "耗时未记录" : "Duration unknown";
  const value = Math.max(0, ms);
  const divisor =
    value < 1000 ? 1 : value < 60000 ? 1000 : value < 3600000 ? 60000 : 3600000;
  const unit =
    divisor === 1
      ? ["ms", "毫秒"]
      : divisor === 1000
        ? ["s", "秒"]
        : divisor === 60000
          ? ["min", "分钟"]
          : ["h", "小时"];
  // Truncate at the unit boundary so 999.99 ms never reads as 1000 ms.
  const scaled = Math.floor((value / divisor) * 100) / 100;
  return `${scaled.toLocaleString(language === "zh" ? "zh-CN" : "en-US", { maximumFractionDigits: 2 })} ${unit[language === "zh" ? 1 : 0]}`;
}
export function formatTimestamp(
  time: ObservedTime | number | undefined,
  language: Language = "en",
): string {
  const ms = typeof time === "number" ? time : time?.wallMs;
  if (ms == null || !Number.isFinite(ms))
    return language === "zh" ? "未记录" : "Not recorded";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    timeZoneName: "short",
  }).format(ms);
}
export function observedEnd(span: ProjectedSpan): number | null {
  if (
    span.quality.timing === "unknown" ||
    span.start?.monoMs == null ||
    !span.start.clockId
  )
    return null;
  if (span.end?.clockId === span.start.clockId && span.end.monoMs != null)
    return Math.max(span.start.monoMs, span.end.monoMs);
  return span.durationMs == null ? null : span.start.monoMs + span.durationMs;
}
export function measureInterval(spans: readonly ProjectedSpan[]) {
  const known = spans.filter(
    (s) =>
      s.quality.timing !== "unknown" &&
      s.start?.clockId &&
      s.start.monoMs != null &&
      observedEnd(s) != null,
  );
  const clocks = new Set(known.map((s) => s.start!.clockId));
  if (!known.length || known.length !== spans.length || clocks.size !== 1)
    return {
      durationMs: null,
      start: undefined,
      end: undefined,
      estimated: false,
    };
  const first = known.reduce((a, b) =>
    a.start!.monoMs! < b.start!.monoMs! ? a : b,
  );
  const last = known.reduce((a, b) =>
    observedEnd(a)! > observedEnd(b)! ? a : b,
  );
  return {
    durationMs: observedEnd(last)! - first.start!.monoMs!,
    start: first.start,
    end: last.end,
    estimated: known.some((s) => s.estimated),
  };
}

export function measureBoundary(entity: {
  start?: ObservedTime;
  end?: ObservedTime;
}) {
  const { start, end } = entity;
  return start?.clockId &&
    start.clockId === end?.clockId &&
    start.monoMs != null &&
    end.monoMs != null
    ? Math.max(0, end.monoMs - start.monoMs)
    : null;
}

/** Fixed clock-domain range, calculated from every call before collapse filtering. */
export function timelineRange(
  spans: readonly ProjectedSpan[],
  clockId: string,
  boundaries: readonly { start?: ObservedTime; end?: ObservedTime }[] = [],
) {
  const calls = spans.filter(
    (s) =>
      s.quality.timing !== "unknown" &&
      s.start?.clockId === clockId &&
      s.start.monoMs != null,
  );
  if (!calls.length) return null;
  const starts = boundaries
    .map((b) => b.start)
    .filter((t) => t?.clockId === clockId && t.monoMs != null);
  const ends = boundaries
    .map((b) => b.end)
    .filter((t) => t?.clockId === clockId && t.monoMs != null);
  const min = Math.min(
    ...starts.map((t) => t!.monoMs!),
    ...calls.map((s) => s.start!.monoMs!),
  );
  const max = Math.max(
    ...ends.map((t) => t!.monoMs!),
    ...calls.map((s) => observedEnd(s) ?? s.start!.monoMs!),
  );
  return { min, range: Math.max(1, max - min) };
}

export function measureOverview(
  spans: readonly ProjectedSpan[],
  boundaries: readonly { start?: ObservedTime; end?: ObservedTime }[],
) {
  const clocks = new Set(
    [
      ...spans.map((s) => s.start?.clockId),
      ...boundaries.flatMap((b) => [b.start?.clockId, b.end?.clockId]),
    ].filter(Boolean),
  );
  const complete =
    boundaries.length > 0 &&
    boundaries.every((b) => measureBoundary(b) != null);
  if (complete && clocks.size === 1) {
    const start = Math.min(...boundaries.map((b) => b.start!.monoMs!));
    const end = Math.max(...boundaries.map((b) => b.end!.monoMs!));
    return { durationMs: end - start, observed: false, estimated: false };
  }
  const interval = measureInterval(spans);
  return {
    durationMs: clocks.size > 1 ? null : interval.durationMs,
    observed: true,
    estimated: interval.estimated,
  };
}

/** Labels beside a bar must use exactly the observed interval that sets its width. */
export function timeBarDuration(
  span: ProjectedSpan,
  language: Language = "en",
): string {
  const end = observedEnd(span);
  const ms =
    end == null || span.start?.monoMs == null ? null : end - span.start.monoMs;
  const prefix =
    ms != null && span.estimated ? (language === "zh" ? "约 " : "~ ") : "";
  return prefix + formatDuration(ms, language);
}
export function timeBarDescription(
  span: ProjectedSpan,
  language: Language = "en",
): string {
  const observed = `${language === "zh" ? "观测耗时" : "Observed duration"}: ${timeBarDuration(span, language)}`;
  return span.executionDurationMs == null
    ? observed
    : `${observed} · ${language === "zh" ? "Pi 工具执行耗时" : "Pi tool execution"}: ${formatDuration(span.executionDurationMs, language)}`;
}

/** Expand a running axis only at readable boundaries instead of changing every frame. */
export function runningAxisRange(range: number): number {
  const value = Math.max(1000, range);
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].find((step) => step * power >= value)! * power;
}
