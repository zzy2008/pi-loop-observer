import { describe, expect, it } from "vitest";
import {
  GRAPH_NODE_HEIGHT,
  GRAPH_COLUMN_GAP,
  GRAPH_ROW_GAP,
  GRAPH_QUESTION_GAP,
  layoutSpans,
} from "../../web/src/graph-layout";
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
describe("question containers and turn lanes", () => {
  it("contains every turn and call, with siblings on one horizontal row", () => {
    const layout = layoutSpans(fixture());
    for (const row of layout.rows) {
      if (!row.parentId) continue;
      const box = layout.bounds.get(row.id)!;
      const parent = layout.bounds.get(row.parentId)!;
      expect(box.x).toBeGreaterThanOrEqual(parent.x);
      expect(box.y).toBeGreaterThanOrEqual(parent.y);
      expect(box.x + box.width).toBeLessThanOrEqual(parent.x + parent.width);
      expect(box.y + box.height).toBeLessThanOrEqual(parent.y + parent.height);
      expect(layout.rows.findIndex((r) => r.id === row.parentId)).toBeLessThan(
        layout.rows.indexOf(row),
      );
    }
    for (const turn of fixture().turns) {
      const calls = layout.rows
        .filter((r) => r.kind === "call" && r.turnId === turn.id)
        .map((r) => layout.bounds.get(r.id)!);
      expect(new Set(calls.map((b) => b.y)).size).toBe(1);
      for (let i = 1; i < calls.length; i++)
        expect(calls[i]!.x - calls[i - 1]!.x - calls[i - 1]!.width).toBe(
          GRAPH_COLUMN_GAP,
        );
    }
    const q1 = layout.bounds.get("prompt:q1")!,
      q2 = layout.bounds.get("prompt:q2")!;
    expect(q2.y - q1.y - q1.height).toBe(GRAPH_QUESTION_GAP);
    expect(
      layout.bounds.get("turn:t1")!.y - layout.bounds.get("turn:t0")!.y,
    ).toBe(124 + GRAPH_ROW_GAP);
    expect(layout.bounds.get("t0c0")!.height).toBe(GRAPH_NODE_HEIGHT);
  });
  it("collapses containers, recomputes height and retains later rows", () => {
    const full = layoutSpans(fixture());
    const layout = layoutSpans(fixture(), {
      collapsed: new Set(["t12"]),
      collapsedQuestions: new Set(["q1"]),
    });
    expect(layout.rows[1]!.id).toBe("prompt:q2");
    expect(layout.positions.has("t12c0")).toBe(false);
    expect(layout.bounds.get("turn:t12")!.height).toBe(56);
    expect(layout.bounds.get("prompt:q2")!.height).toBe(
      full.bounds.get("prompt:q2")!.height - 68,
    );
    expect(layout.bounds.get("prompt:q2")!.y).toBe(68 + GRAPH_QUESTION_GAP);
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
  it("keeps narrower mobile calls inside their turn", () => {
    const layout = layoutSpans(fixture(), { narrow: true });
    expect(layout.bounds.get("t0c0")!.width).toBe(230);
    expect(layout.positions.get("t0c0")!.x).toBe(144);
    expect(layout.rows.find((r) => r.id === "t0c0")!.parentId).toBe("turn:t0");
  });
  it("retains an empty question and unassigned calls", () => {
    const view = fixture();
    view.traces.push({
      id: "empty",
      label: "Empty",
      kind: "normal",
      settled: false,
    });
    view.spans.push({
      ...view.spans[0]!,
      id: "unassigned-call",
      traceId: undefined,
      turnId: undefined,
    });
    const layout = layoutSpans(view);
    expect(layout.positions.has("prompt:empty")).toBe(true);
    expect(layout.rows.find((r) => r.id === "unassigned-call")?.parentId).toBe(
      "turn:unassigned:unassigned",
    );
  });
});
