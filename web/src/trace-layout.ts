import type {
  Projection,
  ProjectedSpan,
  Trace,
  Turn,
} from "../../src/model/index.js";
import { measureBoundary } from "./timing";
export type TraceRow = {
  id: string;
  turn?: Turn;
  span?: ProjectedSpan;
  depth: number;
};
export type TraceDomain = {
  clock: string | null;
  min: number;
  range: number;
  rows: TraceRow[];
};
export type TraceGroup = {
  id: string;
  trace?: Trace;
  spans: ProjectedSpan[];
  turns: Turn[];
  domains: TraceDomain[];
  durationMs: number | null;
};
export function spanInterval(
  span: ProjectedSpan,
): { clock: string; start: number; end: number } | null {
  const start = span.start;
  if (
    span.quality.timing === "unknown" ||
    !start?.clockId ||
    start.monoMs == null ||
    !Number.isFinite(start.monoMs)
  )
    return null;
  const end =
    span.end?.clockId === start.clockId && span.end.monoMs != null
      ? span.end.monoMs
      : span.durationMs == null
        ? null
        : start.monoMs + span.durationMs;
  return end == null || !Number.isFinite(end)
    ? null
    : {
        clock: start.clockId,
        start: start.monoMs,
        end: Math.max(start.monoMs, end),
      };
}
export function buildTraceLayout(
  view: Projection,
  collapsed: ReadonlySet<string>,
): TraceGroup[] {
  const groups = view.traces.map((trace) => ({
    id: trace.id,
    trace,
    spans: view.spans.filter((s) => s.traceId === trace.id),
    turns: view.turns.filter((t) => t.traceId === trace.id),
  }));
  const unassigned = view.spans.filter(
    (s) => !groups.some((g) => g.id === s.traceId),
  );
  const input: {
    id: string;
    trace?: Trace;
    spans: ProjectedSpan[];
    turns: Turn[];
  }[] = groups;
  if (unassigned.length)
    input.push({ id: "unassigned", spans: unassigned, turns: [] });
  return input.map((group) => {
    const intervals = group.spans.map(spanInterval);
    const clocks = [...new Set(intervals.map((i) => i?.clock ?? null))];
    if (!clocks.length) clocks.push(null);
    const domains = clocks.map((clock) => {
      const timed = intervals.filter((i) => i && i.clock === clock);
      const boundary = group.trace;
      const starts = timed.map((i) => i!.start),
        ends = timed.map((i) => i!.end);
      if (
        clock &&
        boundary?.start?.clockId === clock &&
        boundary.start.monoMs != null
      )
        starts.push(boundary.start.monoMs);
      if (
        clock &&
        boundary?.end?.clockId === clock &&
        boundary.end.monoMs != null
      )
        ends.push(boundary.end.monoMs);
      const min = starts.length ? Math.min(...starts) : 0;
      const spans = group.spans.filter(
        (_, i) => (intervals[i]?.clock ?? null) === clock,
      );
      const rows: TraceRow[] = [];
      const turnIds = [
        ...new Set([
          ...group.turns
            .filter(
              (t) =>
                spans.some((s) => s.turnId === t.id) ||
                (!group.spans.some((s) => s.turnId === t.id) &&
                  clock === clocks[0]),
            )
            .map((t) => t.id),
          ...spans.map((s) => s.turnId).filter((id): id is string => !!id),
        ]),
      ];
      const append = (calls: ProjectedSpan[], depth: number) => {
        const parent = new Map<string, string>();
        for (const r of view.relations)
          if (
            (r.kind === "contains" || r.kind === "calls") &&
            calls.some((s) => s.id === r.from && s.kind === "tool") &&
            calls.some((s) => s.id === r.to && s.kind === "tool") &&
            r.from !== r.to &&
            !parent.has(r.to)
          )
            parent.set(r.to, r.from);
        const emitted = new Set<string>();
        const visit = (span: ProjectedSpan, level: number) => {
          if (emitted.has(span.id)) return;
          emitted.add(span.id);
          rows.push({ id: span.id, span, depth: level });
          calls
            .filter((s) => parent.get(s.id) === span.id)
            .forEach((s) => visit(s, level + 1));
        };
        calls.filter((s) => !parent.has(s.id)).forEach((s) => visit(s, depth));
        calls.forEach((s) => visit(s, depth));
      };
      for (const id of turnIds) {
        const turn =
          group.turns.find((t) => t.id === id) ??
          view.turns.find((t) => t.id === id);
        if (turn) rows.push({ id, turn, depth: 0 });
        if (!collapsed.has(id))
          append(
            spans.filter((s) => s.turnId === id),
            turn ? 1 : 0,
          );
      }
      append(
        spans.filter((s) => !s.turnId),
        0,
      );
      return {
        clock,
        min,
        range: Math.max(1, ends.length ? Math.max(...ends) - min : 1),
        rows,
      };
    });
    const boundaryDuration = measureBoundary(group.trace ?? {});
    const known =
      intervals.every(Boolean) &&
      intervals.length > 0 &&
      new Set(intervals.map((i) => i!.clock)).size === 1;
    return {
      ...group,
      domains,
      durationMs:
        boundaryDuration ??
        (known
          ? Math.max(...intervals.map((i) => i!.end)) -
            Math.min(...intervals.map((i) => i!.start))
          : null),
    };
  });
}
