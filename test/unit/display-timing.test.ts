import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TraceView } from "../../web/src/TraceView";
import { Timeline } from "../../web/src/TimelineView";
import { describe, expect, it } from "vitest";
import { buildDisplayIndex, textSummary } from "../../web/src/display-model";
import {
  formatDuration,
  formatTimestamp,
  measureInterval,
  measureBoundary,
  timelineRange,
  measureOverview,
} from "../../web/src/timing";
import {
  initialState,
  replay,
  type StoredEvent,
  project,
  type ProjectedSpan,
} from "../../src/model/index.js";
import { messageText } from "../../src/capture/text.js";
const span = (
  id: string,
  start: number,
  durationMs: number,
  clock = "clock",
): ProjectedSpan => ({
  id,
  producerId: "p",
  kind: "tool",
  name: "read",
  traceId: "q1",
  turnId: "t1",
  state: "completed",
  source: "pi-live",
  stages: [],
  quality: { timing: "measured", gaps: [], association: "exact" },
  start: { wallMs: start, monoMs: start, clockId: clock },
  end: {
    wallMs: start + durationMs,
    monoMs: start + durationMs,
    clockId: clock,
  },
  durationMs,
  estimated: false,
});
describe("display timing", () => {
  it("keeps observed positions separate from SDK execution duration", () => {
    const call = {
      ...span("sdk", 100, 900),
      durationMs: 125,
      executionDurationMs: 125,
    };
    expect(measureInterval([call]).durationMs).toBe(900);
    expect(timelineRange([call], "clock")).toEqual({ min: 100, range: 900 });
    expect(call.durationMs).toBe(125);
  });
  it("uses independent question ranges and wall-clock union for concurrent calls", () => {
    const first = [span("a", 0, 1000), span("b", 500, 1000)];
    const second = [span("c", 3600000, 20)];
    expect(measureInterval(first).durationMs).toBe(1500);
    expect(measureInterval(second).durationMs).toBe(20);
    expect(measureInterval([...first, ...second]).durationMs).toBe(3600020);
    expect(
      measureInterval([first[0]!, span("other", 3, 10, "other")]).durationMs,
    ).toBeNull();
    expect(
      measureInterval([
        { ...first[0]!, quality: { ...first[0]!.quality, timing: "unknown" } },
      ]).durationMs,
    ).toBeNull();
  });
  it("formats unit thresholds without rounded unit crossings", () => {
    expect(formatDuration(999.999)).toBe("999.99 ms");
    expect(formatDuration(1000)).toBe("1 s");
    expect(formatDuration(59999)).toBe("59.99 s");
    expect(formatDuration(60000)).toBe("1 min");
    expect(formatDuration(3600000, "zh")).toBe("1 小时");
    expect(formatTimestamp(undefined)).toBe("Not recorded");
    expect(formatTimestamp(0)).toBe(
      new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
        timeZoneName: "short",
      }).format(0),
    );
  });
  it("keeps full-prefix ordinal names when consumers filter, and never accesses future refs", () => {
    const view = project(initialState());
    view.traces = [
      {
        id: "q1",
        label: "用户问题",
        kind: "normal",
        settled: true,
        contentRef: "input",
      },
      { id: "q2", label: "用户问题", kind: "normal", settled: true },
    ];
    view.turns = [
      { id: "t1", runId: "r", index: 0, traceId: "q1", completed: true },
    ];
    view.spans = [span("a", 0, 1), span("b", 1, 1)];
    view.spans[1]!.inputRef = "tool";
    const names = buildDisplayIndex(view, "en", {
      input: {
        content: [
          { type: "text", text: "Fix this" },
          { type: "image", text: "hidden" },
        ],
      },
      tool: { path: "src/a.ts" },
      future: { text: "Do not leak" },
    });
    expect(names.names.q1).toBe("Q1 · Fix this");
    expect(names.names.q2).toBe("Q2 · Question");
    expect(names.names.b).toBe("Q1.T1.C2 · read · path: src/a.ts");
    expect(JSON.stringify(names)).not.toContain("Do not leak");
    expect(
      names.names[view.spans.filter((s) => s.id === "b")[0]!.id],
    ).toContain("C2");
    expect(
      messageText({
        content: [
          { type: "text", text: "one" },
          { type: "image" },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one two");
    expect(textSummary({ content: [{ type: "text", text: "one" }] })).toBe(
      "one",
    );
  });
});

describe("recorded execution boundaries", () => {
  it("retains true turn and question endpoints only after their prefix", () => {
    const event = (
      cursor: string,
      fact: StoredEvent["fact"],
      refs: StoredEvent["refs"],
      monoMs: number,
    ): StoredEvent => ({
      schemaVersion: 1,
      eventId: cursor,
      producerId: "p",
      producerSeq: Number(cursor),
      sessionKey: "s",
      source: "pi-live",
      observedAt: { wallMs: monoMs, monoMs, clockId: "clock" },
      refs,
      fact,
      cursor,
      receivedAt: monoMs,
    });
    const events = [
      event(
        "1",
        { type: "input.applied", traceId: "q", kind: "normal" },
        { traceId: "q" },
        0,
      ),
      event(
        "2",
        { type: "turn.started", turnId: "t", runId: "r", turnIndex: 0 },
        { traceId: "q" },
        10,
      ),
      event(
        "3",
        { type: "turn.ended", turnId: "t", runId: "r", turnIndex: 0 },
        { traceId: "q" },
        100,
      ),
      event(
        "4",
        { type: "run.settled", runId: "r", outcomeKnown: true },
        { traceId: "q" },
        150,
      ),
    ];
    const prefix = replay(events, "2");
    expect(prefix.traces.q!.end).toBeUndefined();
    expect(measureBoundary(prefix.turns.t!)).toBeNull();
    const final = replay(events);
    expect(measureBoundary(final.turns.t!)).toBe(90);
    expect(measureBoundary(final.traces.q!)).toBe(150);
    const imported = replay(
      events.map((e) => ({ ...e, source: "pi-import" as const })),
    );
    expect(measureBoundary(imported.traces.q!)).toBeNull();
  });
});

describe("stable timeline clock ranges", () => {
  const boundary = {
    start: { wallMs: 0, monoMs: 0, clockId: "clock" },
    end: { wallMs: 200, monoMs: 200, clockId: "clock" },
  };
  it("uses question endpoints instead of call envelopes and preserves idle time", () => {
    const calls = [span("early", 20, 10), span("late", 100, 30)];
    expect(timelineRange(calls, "clock", [boundary])).toEqual({
      min: 0,
      range: 200,
    });
    expect(timelineRange(calls, "clock")).toEqual({ min: 20, range: 110 });
    expect(measureBoundary(boundary)).toBe(200);
    expect(measureInterval(calls).durationMs).toBe(110);
  });
  it("uses whole-session boundaries while separating clock domains", () => {
    const calls = [
      span("a", 20, 10),
      span("b", 1000, 40),
      span("other", 5, 10, "other"),
    ];
    const second = {
      start: { wallMs: 900, monoMs: 900, clockId: "clock" },
      end: { wallMs: 1100, monoMs: 1100, clockId: "clock" },
    };
    expect(timelineRange(calls, "clock", [boundary, second])).toEqual({
      min: 0,
      range: 1100,
    });
    expect(timelineRange(calls, "other", [boundary, second])).toEqual({
      min: 5,
      range: 10,
    });
    expect(
      measureBoundary({
        start: boundary.start,
        end: { ...boundary.end, clockId: "other" },
      }),
    ).toBeNull();
    expect(
      timelineRange(
        [
          {
            ...calls[0]!,
            quality: { ...calls[0]!.quality, timing: "unknown" },
          },
        ],
        "clock",
      ),
    ).toBeNull();
  });
  it("uses only the replay prefix and estimates a live call endpoint", () => {
    const live = { ...span("live", 20, 80), end: undefined, estimated: true };
    expect(timelineRange([live], "clock", [{ start: boundary.start }])).toEqual(
      { min: 0, range: 100 },
    );
    expect(measureInterval([live]).estimated).toBe(true);
  });
});

it("keeps the SVG scale and turn headings when calls are collapsed", () => {
  const view = project(initialState());
  view.traces = [
    {
      id: "q1",
      label: "question",
      kind: "normal",
      settled: true,
      start: { wallMs: 0, monoMs: 0, clockId: "clock" },
      end: { wallMs: 200, monoMs: 200, clockId: "clock" },
    },
  ];
  view.turns = [
    { id: "t1", runId: "r", index: 0, traceId: "q1", completed: true },
    { id: "t2", runId: "r", index: 1, traceId: "q1", completed: true },
  ];
  view.spans = [
    span("early", 20, 10),
    { ...span("late", 100, 30), turnId: "t2" },
  ];
  const render = (collapsed: Set<string>) =>
    renderToStaticMarkup(
      React.createElement(Timeline, { view, collapsed, onSelect: () => {} }),
    );
  const expanded = render(new Set());
  const collapsed = render(new Set(["t2"]));
  for (const html of [expanded, collapsed]) {
    expect(html).toContain('data-range-min="0"');
    expect(html).toContain('data-range-ms="200"');
    expect(html).toContain('data-turn-id="t1"');
    expect(html).toContain('data-turn-id="t2"');
    expect(html).toContain("Observed calls");
  }
  expect(expanded).toContain('data-span-id="late"');
  expect(collapsed).not.toContain('data-span-id="late"');
  expect(collapsed).toContain("Collapsed");
  expect(expanded.indexOf('data-turn-id="t1"')).toBeLessThan(
    expanded.indexOf('role="button"'),
  );
});

it("includes a running later question past the previous question endpoint", () => {
  const first = {
    start: { wallMs: 0, monoMs: 0, clockId: "clock" },
    end: { wallMs: 200, monoMs: 200, clockId: "clock" },
  };
  const second = { start: { wallMs: 1000, monoMs: 1000, clockId: "clock" } };
  const calls = [
    span("first", 20, 20),
    { ...span("live", 1020, 50), end: undefined, estimated: true },
  ];
  expect(timelineRange(calls, "clock", [first, second])).toEqual({
    min: 0,
    range: 1070,
  });
  expect(measureOverview(calls, [first, second])).toEqual({
    durationMs: 1050,
    observed: true,
    estimated: true,
  });
  expect(
    measureOverview(calls, [
      first,
      { ...second, end: { wallMs: 1100, monoMs: 1100, clockId: "clock" } },
    ]),
  ).toEqual({ durationMs: 1100, observed: false, estimated: false });
  expect(
    measureOverview([span("other", 0, 10, "other")], [first]).durationMs,
  ).toBeNull();
});

it("labels time bars with the same observed duration used by their geometry", () => {
  const view = project(initialState());
  view.traces = [
    { id: "q1", label: "question", kind: "normal", settled: true },
  ];
  view.spans = [
    { ...span("sdk", 100, 900), durationMs: 125, executionDurationMs: 125 },
  ];
  const display = buildDisplayIndex(view, "en");
  const common = {
    view,
    display,
    collapsed: new Set<string>(),
    onSelect: () => {},
  };
  const trace = renderToStaticMarkup(
    React.createElement(TraceView, { ...common, onToggleTurn: () => {} }),
  );
  const timeline = renderToStaticMarkup(React.createElement(Timeline, common));
  expect(trace).toMatch(/class="trace-duration"[^>]*>900 ms<\/span>/);
  expect(timeline).toMatch(
    /class="timeline-duration-label"[^>]*>900 ms<\/text>/,
  );
  // The separately labelled SDK measurement must remain available.
  for (const html of [trace, timeline])
    expect(html).toContain("Pi tool execution: 125 ms");
});
