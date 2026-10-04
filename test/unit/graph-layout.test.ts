import { describe, expect, it } from "vitest";
import { layoutSpans } from "../../web/src/graph-layout";
import type { Projection, ProjectedSpan } from "../../src/model/index.js";
const fixture = (): Projection => {
  const turns = Array.from({ length: 24 }, (_, index) => ({
    id: `t${index}`,
    runId: "run",
    index,
    traceId: index < 12 ? "q1" : "q2",
    completed: true,
  }));
  const spans: ProjectedSpan[] = turns.flatMap((turn) =>
    Array.from({ length: 3 }, (_, i) => ({
      id: `${turn.id}c${i}`,
      producerId: "p",
      kind: i === 0 ? ("llm" as const) : ("tool" as const),
      name: "read",
      traceId: turn.traceId,
      turnId: turn.id,
      state: "completed" as const,
      stages: [],
      source: "pi-live" as const,
      quality: {
        timing: "unknown" as const,
        gaps: [],
        association: "exact" as const,
      },
      durationMs: null,
      estimated: false,
    })),
  );
  return {
    sessionKey: "s",
    cursor: "1",
    spans,
    traces: [
      { id: "q1", label: "question", kind: "normal", settled: true },
      { id: "q2", label: "question", kind: "normal", settled: true },
    ],
    turns,
    relations: [],
    active: [],
    gaps: [],
    capturing: false,
    capabilities: {},
  };
};
describe("vertical graph", () => {
  it("keeps 24 turns within fixed x bounds and non-overlapping rows", () => {
    const layout = layoutSpans(fixture());
    expect(Math.max(...[...layout.positions.values()].map((p) => p.x))).toBe(
      72,
    );
    const rows = [...layout.positions.values()];
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]!.y - rows[i - 1]!.y).toBeGreaterThanOrEqual(150);
    expect(layout.rows.slice(0, 6).map((r) => r.kind)).toEqual([
      "question",
      "turn",
      "call",
      "call",
      "call",
      "turn",
    ]);
  });
  it("collapses in place and continues with next question", () => {
    const layout = layoutSpans(fixture(), {
      collapsed: new Set(["t12"]),
      collapsedQuestions: new Set(["q1"]),
    });
    expect(layout.rows[0]!.id).toBe("prompt:q1");
    expect(layout.rows[1]!.id).toBe("prompt:q2");
    expect(layout.positions.has("t12c0")).toBe(false);
    expect(layout.positions.has("turn:t12")).toBe(true);
  });
  it("does not move on state, duration or label updates", () => {
    const view = fixture();
    const before = layoutSpans(view);
    view.spans = view.spans.map((s) => ({
      ...s,
      state: "running",
      durationMs: 123,
      name: "changed",
    }));
    expect(layoutSpans(view).positions).toEqual(before.positions);
  });
  it("uses compact mobile indentation", () =>
    expect(
      Math.max(
        ...[...layoutSpans(fixture(), { narrow: true }).positions.values()].map(
          (p) => p.x,
        ),
      ),
    ).toBe(36));
});
