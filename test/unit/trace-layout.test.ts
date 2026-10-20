import { describe, expect, it } from "vitest";
import { buildTraceLayout, spanInterval } from "../../web/src/trace-layout";
import type { Projection, ProjectedSpan } from "../../src/model/index.js";
const call = (id: string, clock = "a", start = 0, end = 10): ProjectedSpan => ({
  id,
  producerId: "p",
  kind: "tool",
  name: "read",
  traceId: "q",
  turnId: "t",
  state: "completed",
  source: "pi-live",
  stages: [],
  quality: { timing: "measured", association: "exact", gaps: [] },
  start: { wallMs: start, monoMs: start, clockId: clock },
  end: { wallMs: end, monoMs: end, clockId: clock },
  durationMs: end - start,
  estimated: false,
});
const view = (spans: ProjectedSpan[]): Projection => ({
  sessionKey: "s",
  cursor: "0",
  spans,
  traces: [{ id: "q", label: "question", kind: "normal", settled: true }],
  turns: [{ id: "t", traceId: "q", index: 1, runId: "r", completed: true }],
  relations: [],
  active: [],
  gaps: [],
  capturing: false,
  capabilities: {},
});
describe("trace waterfall layout", () => {
  it("separates clock domains and retains unknown calls without fabricated timing", () => {
    const unknown = {
      ...call("unknown"),
      quality: { ...call("x").quality, timing: "unknown" as const },
    };
    const groups = buildTraceLayout(
      view([call("a"), call("b", "b", 1000, 1030), unknown]),
      new Set(),
    );
    expect(groups[0]!.domains.map((d) => [d.clock, d.min, d.range])).toEqual([
      ["a", 0, 10],
      ["b", 1000, 30],
      [null, 0, 1],
    ]);
    expect(groups[0]!.durationMs).toBeNull();
    expect(groups[0]!.domains[2]!.rows.some((r) => r.id === "unknown")).toBe(
      true,
    );
    expect(spanInterval(unknown)).toBeNull();
  });
  it("keeps complete ranges when turns are collapsed and prefers observed end over SDK duration", () => {
    const sdk = { ...call("sdk", "a", 10, 100), durationMs: 20 };
    const expanded = buildTraceLayout(
      view([call("first"), sdk]),
      new Set(),
    )[0]!;
    const collapsed = buildTraceLayout(
      view([call("first"), sdk]),
      new Set(["t"]),
    )[0]!;
    expect(expanded.domains[0]!.range).toBe(100);
    expect(collapsed.domains[0]!.range).toBe(expanded.domains[0]!.range);
    expect(collapsed.domains[0]!.rows.map((r) => r.id)).toEqual(["t"]);
    expect(spanInterval(sdk)?.end).toBe(100);
    expect(sdk.durationMs).toBe(20);
  });
  it("uses only explicit tool parent relations and keeps cycles and unassigned calls visible", () => {
    const p = view([
      call("child"),
      call("parent"),
      call("sibling"),
      { ...call("orphan"), traceId: undefined, turnId: undefined },
    ]);
    p.relations = [
      { from: "parent", to: "child", kind: "calls", evidence: "observed" },
    ];
    const groups = buildTraceLayout(p, new Set());
    expect(groups[0]!.domains[0]!.rows.map((r) => [r.id, r.depth])).toEqual([
      ["t", 0],
      ["parent", 1],
      ["child", 2],
      ["sibling", 1],
    ]);
    expect(groups[1]!.domains[0]!.rows[0]!.id).toBe("orphan");
    p.relations.push({
      from: "child",
      to: "parent",
      kind: "contains",
      evidence: "observed",
    });
    expect(
      buildTraceLayout(p, new Set())[0]!
        .domains[0]!.rows.filter((r) => r.span)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["child", "parent", "sibling"]);
  });
  it("uses a minimal range for zero duration and no domain for invalid endpoints", () => {
    expect(
      buildTraceLayout(view([call("zero", "a", 20, 20)]), new Set())[0]!
        .domains[0],
    ).toMatchObject({ min: 20, range: 1 });
    expect(
      spanInterval({ ...call("bad"), end: undefined, durationMs: null }),
    ).toBeNull();
  });
});
