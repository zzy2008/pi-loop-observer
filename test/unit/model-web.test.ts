import { describe, expect, it } from "vitest";
import {
  initialState,
  project,
  reduce,
  replay,
  type Fact,
  type StoredEvent,
} from "../../src/model/index.js";
import { createSessionStore } from "../../web/src/store.js";
function event(
  cursor: number,
  fact: Fact,
  refs: StoredEvent["refs"] = {},
  source: StoredEvent["source"] = "pi-live",
): StoredEvent {
  return {
    schemaVersion: 1,
    eventId: `e${cursor}`,
    producerId: "fixture",
    producerSeq: cursor,
    sessionKey: "fixture/session",
    source,
    observedAt: {
      wallMs: 1000 + cursor * 100,
      monoMs: cursor * 100,
      clockId: "fixture-clock",
    },
    refs,
    fact,
    cursor: String(cursor),
    receivedAt: 2000 + cursor,
  };
}
const events = [
  event(1, {
    type: "input.applied",
    traceId: "q",
    kind: "normal",
    label: "可控问题",
  }),
  event(
    2,
    {
      type: "span.started",
      spanId: "llm1",
      kind: "llm",
      name: "LLM 1",
      timingBasis: "observed",
    },
    { traceId: "q", turnId: "turn1" },
  ),
  event(3, {
    type: "span.ended",
    spanId: "llm1",
    outcome: "completed",
    contentRef: "answer1",
  }),
  event(
    4,
    {
      type: "span.started",
      spanId: "tool-a",
      kind: "tool",
      name: "bash",
      timingBasis: "observed",
    },
    { traceId: "q", turnId: "turn1" },
  ),
  event(
    5,
    {
      type: "span.started",
      spanId: "tool-b",
      kind: "tool",
      name: "bash",
      timingBasis: "observed",
    },
    { traceId: "q", turnId: "turn1" },
  ),
  event(6, { type: "span.ended", spanId: "tool-a", outcome: "failed" }),
  event(7, { type: "span.ended", spanId: "tool-b", outcome: "completed" }),
  event(
    8,
    {
      type: "span.started",
      spanId: "llm2",
      kind: "llm",
      name: "LLM 2",
      timingBasis: "observed",
    },
    { traceId: "q", turnId: "turn2" },
  ),
  event(9, {
    type: "span.ended",
    spanId: "llm2",
    outcome: "completed",
    contentRef: "answer2",
  }),
];
describe("canonical model", () => {
  it("preserves simultaneous tools, independent identities and failure recovery", () => {
    expect(project(replay(events.slice(0, 5))).active.map((s) => s.id)).toEqual(
      ["tool-a", "tool-b"],
    );
    const view = project(replay(events));
    expect(view.spans).toHaveLength(4);
    expect(view.spans.find((s) => s.id === "tool-a")?.state).toBe("failed");
    expect(view.spans.find((s) => s.id === "llm2")?.state).toBe("completed");
    expect(view.spans.find((s) => s.id === "tool-a")?.durationMs).toBe(200);
    expect(view.traces[0].settled).toBe(false);
  });
  it("does not expose future output and is deterministic across complete replay", () => {
    const prefix = replay(events, "8");
    expect(prefix.spans.llm2.outputRef).toBeUndefined();
    expect(prefix.spans.llm2.state).toBe("running");
    expect(events.reduce(reduce, initialState())).toEqual(replay(events));
    const complete = replay(events);
    expect(reduce(complete, events[8]!)).toBe(complete);
  });
  it("does not invent imported duration or cross-clock duration", () => {
    const imported = [
      event(
        1,
        {
          type: "span.started",
          spanId: "old",
          kind: "tool",
          name: "read",
          timingBasis: "unknown",
        },
        {},
        "pi-import",
      ),
      event(
        2,
        { type: "span.ended", spanId: "old", outcome: "completed" },
        {},
        "pi-import",
      ),
    ];
    expect(project(replay(imported)).spans[0]?.durationMs).toBeNull();
    const end = event(2, {
      type: "span.ended",
      spanId: "x",
      outcome: "completed",
    });
    end.observedAt.clockId = "another";
    expect(
      project(
        replay([
          event(1, {
            type: "span.started",
            spanId: "x",
            kind: "tool",
            name: "x",
            timingBasis: "observed",
          }),
          end,
        ]),
      ).spans[0]?.durationMs,
    ).toBeNull();
  });
  it("merges explicit alias only after its binding prefix, preserving missing-start quality", () => {
    const start = event(1, {
      type: "span.ended",
      spanId: "provisional",
      outcome: "completed",
    });
    const imported = event(
      2,
      {
        type: "span.started",
        spanId: "imported",
        kind: "tool",
        name: "read",
        timingBasis: "unknown",
      },
      {},
      "pi-import",
    );
    const bind = event(3, {
      type: "entity.bound",
      canonicalSpanId: "provisional",
      aliasSpanId: "imported",
      entryKey: "entry",
      evidence: "toolCallId",
    });
    expect(project(replay([start, imported, bind], "2")).spans).toHaveLength(2);
    const merged = replay([start, imported, bind]);
    expect(project(merged).spans).toHaveLength(1);
    expect(merged.aliases.imported).toBe("provisional");
    expect(merged.spans.provisional.quality.gaps).toContain("缺失开始事件");
  });
  it("separates capture loss from execution failure", () => {
    const state = replay([
      events[1]!,
      event(3, { type: "capture.gap", scope: "queue", reason: "队列溢出" }),
      event(4, { type: "capture.stopped", reason: "shutdown", clean: false }),
    ]);
    expect(state.spans.llm1.state).toBe("interrupted");
    expect(state.spans.llm1.quality.gaps).toContain("队列溢出");
  });
});
describe("browser session store", () => {
  it("has referentially stable snapshots, deduplicates and ingests live while paused", () => {
    const store = createSessionStore("fixture/session");
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    store.ingest(events.slice(0, 5));
    store.seek("3");
    const paused = store.getSnapshot().visible;
    store.ingest(events.slice(4));
    expect(store.getSnapshot().visible).toBe(paused);
    expect(store.getSnapshot().live.cursor).toBe("9");
    expect(store.getSnapshot().events).toHaveLength(9);
    const before = store.getSnapshot();
    store.ingest(events);
    expect(store.getSnapshot()).toBe(before);
    store.followLive();
    expect(store.getSnapshot().visible).toBe(store.getSnapshot().live);
    store.dispose();
  });
});

describe("scale and isolation", () => {
  it("replays 5000 facts with 300 nodes and fixed layout without future content", () => {
    const facts: StoredEvent[] = [];
    for (let i = 0; i < 300; i++)
      facts.push(
        event(
          i + 1,
          {
            type: "span.started",
            spanId: `s${i}`,
            kind: i % 3 ? "tool" : "llm",
            name: "fixture",
            timingBasis: "observed",
          },
          { traceId: "scale", turnId: `t${Math.floor(i / 3)}` },
        ),
      );
    for (let i = 300; i < 5000; i++)
      facts.push(
        event(i + 1, {
          type: "span.stage_changed",
          spanId: `s${i % 300}`,
          stage: "text-output",
        }),
      );
    const start = performance.now();
    const state = replay(facts);
    expect(Object.keys(state.spans)).toHaveLength(300);
    expect(state.events).toHaveLength(5000);
    expect(project(state).active).toHaveLength(300);
    expect(performance.now() - start).toBeLessThan(2000);
  });
  it("limits producer loss to its own active spans and retains unknown endpoint", () => {
    const a = event(1, {
      type: "span.started",
      spanId: "a",
      kind: "tool",
      name: "a",
      timingBasis: "observed",
    });
    const b = event(2, {
      type: "span.started",
      spanId: "b",
      kind: "tool",
      name: "b",
      timingBasis: "observed",
    });
    b.producerId = "other";
    const state = replay([
      a,
      b,
      event(3, {
        type: "capture.gap",
        scope: "producer",
        reason: "producer expired",
        targetProducerId: "fixture",
      }),
    ]);
    expect(state.spans.a.state).toBe("interrupted");
    expect(state.spans.a.end).toBeUndefined();
    expect(state.spans.b.state).toBe("running");
  });
  it("routes late alias facts to canonical identity and settles only matching run", () => {
    const a = event(
      1,
      {
        type: "span.started",
        spanId: "a",
        kind: "llm",
        name: "a",
        timingBasis: "observed",
      },
      { traceId: "q1", runId: "r1" },
    );
    const b = event(
      2,
      {
        type: "span.started",
        spanId: "b",
        kind: "llm",
        name: "b",
        timingBasis: "observed",
      },
      { traceId: "q2", runId: "r2" },
    );
    const state = replay([
      event(1, { type: "input.applied", traceId: "q1", kind: "normal" }),
      { ...event(2, { type: "input.applied", traceId: "q2", kind: "normal" }) },
      { ...a, cursor: "3" },
      { ...b, cursor: "4" },
      event(5, {
        type: "entity.bound",
        canonicalSpanId: "a",
        aliasSpanId: "old",
        entryKey: "entry",
        evidence: "fixture",
      }),
      event(6, { type: "span.ended", spanId: "old", outcome: "completed" }),
      event(7, { type: "run.settled", runId: "r1", outcomeKnown: true }),
    ]);
    expect(state.spans.old).toBeUndefined();
    expect(state.spans.a.state).toBe("completed");
    expect(state.traces.q1.settled).toBe(true);
    expect(state.traces.q2.settled).toBe(false);
  });
});

describe("precise entry identity across reload", () => {
  for (const direction of ["live-first", "import-first"])
    it(`merges exact entry bindings ${direction} without replacing measured execution`, () => {
      const liveStart = event(1, {
        type: "span.started",
        spanId: "live",
        kind: "tool",
        name: "read",
        timingBasis: "observed",
      });
      const liveEnd = event(2, {
        type: "span.ended",
        spanId: "live",
        outcome: "completed",
        contentRef: "live-output",
      });
      const liveBind = event(3, {
        type: "entity.bound",
        canonicalSpanId: "live",
        entryKey: "same-entry",
        evidence: "entry ID",
      });
      const importedStart = event(
        4,
        {
          type: "span.started",
          spanId: "imported",
          kind: "tool",
          name: "read",
          timingBasis: "unknown",
        },
        {},
        "pi-import",
      );
      const importedEnd = event(
        5,
        {
          type: "span.ended",
          spanId: "imported",
          outcome: "completed",
          contentRef: "archived-output",
        },
        {},
        "pi-import",
      );
      const importedBind = event(
        6,
        {
          type: "entity.bound",
          canonicalSpanId: "imported",
          entryKey: "same-entry",
          evidence: "entry ID",
        },
        {},
        "pi-import",
      );
      const facts = (
        direction === "live-first"
          ? [
              liveStart,
              liveEnd,
              liveBind,
              importedStart,
              importedEnd,
              importedBind,
            ]
          : [
              importedStart,
              importedEnd,
              importedBind,
              liveStart,
              liveEnd,
              liveBind,
            ]
      ).map((e, i) => ({ ...e, cursor: String(i + 1) }));
      expect(project(replay(facts, "5")).spans).toHaveLength(2);
      const state = replay(facts);
      const view = project(state);
      expect(view.spans).toHaveLength(1);
      expect(view.spans[0].id).toBe("live");
      expect(view.spans[0].durationMs).toBe(100);
      expect(view.spans[0].outputRef).toBe("live-output");
      expect(state.aliases.imported).toBe("live");
    });
});

describe("history branches and capture epochs", () => {
  it("filters exact archived parent chains without dropping unresolved live spans", () => {
    const facts = [
      event(1, {
        type: "entry.archived",
        sourceEntryKey: "fixture/session:root",
        parentId: null,
        revisionHash: "r",
        contentRef: "r",
      }),
      event(2, {
        type: "entry.archived",
        sourceEntryKey: "fixture/session:left",
        parentId: "root",
        revisionHash: "l",
        contentRef: "l",
      }),
      event(3, {
        type: "entry.archived",
        sourceEntryKey: "fixture/session:right",
        parentId: "root",
        revisionHash: "r",
        contentRef: "r",
      }),
      event(4, {
        type: "span.started",
        spanId: "left",
        kind: "llm",
        name: "left",
        timingBasis: "unknown",
      }),
      event(5, {
        type: "entity.bound",
        canonicalSpanId: "left",
        entryKey: "fixture/session:left",
        evidence: "entry",
      }),
      event(6, {
        type: "span.started",
        spanId: "right",
        kind: "llm",
        name: "right",
        timingBasis: "unknown",
      }),
      event(7, {
        type: "entity.bound",
        canonicalSpanId: "right",
        entryKey: "fixture/session:right",
        evidence: "entry",
      }),
      event(8, {
        type: "span.started",
        spanId: "unknown",
        kind: "tool",
        name: "unknown",
        timingBasis: "observed",
      }),
      event(9, { type: "branch.selected", newLeafId: "left" }),
    ];
    const state = replay(facts);
    expect(project(state).spans.map((s) => s.id)).toEqual(["left", "unknown"]);
    expect(project(state, { branchLeafId: null }).spans).toHaveLength(3);
    expect(
      project(state, { branchLeafId: "right" }).spans.map((s) => s.id),
    ).toEqual(["right", "unknown"]);
  });
  it("stops one capture epoch without interrupting another producer", () => {
    const first = event(1, {
      type: "capture.started",
      reason: "fixture",
      capabilities: {},
    });
    const second = {
      ...event(2, {
        type: "capture.started",
        reason: "fixture",
        capabilities: {},
      }),
      producerId: "other",
    };
    const a = event(3, {
      type: "span.started",
      spanId: "a",
      kind: "tool",
      name: "a",
      timingBasis: "observed",
    });
    const b = {
      ...event(4, {
        type: "span.started",
        spanId: "b",
        kind: "tool",
        name: "b",
        timingBasis: "observed",
      }),
      producerId: "other",
    };
    const state = replay([
      first,
      second,
      a,
      b,
      event(5, {
        type: "capture.stopped",
        reason: "fixture stopped",
        clean: true,
      }),
    ]);
    expect(state.spans.a.state).toBe("interrupted");
    expect(state.spans.b.state).toBe("running");
    expect(state.capturing).toBe(true);
  });
  it("surfaces changed event identity instead of silently deduplicating", () => {
    const store = createSessionStore("fixture/session");
    store.ingest([events[0]!]);
    store.ingest([
      {
        ...events[0]!,
        fact: { type: "capture.stopped", reason: "modified", clean: true },
      },
    ]);
    expect(store.getSnapshot().error).toContain("身份");
    expect(store.getSnapshot().events).toHaveLength(1);
  });
});

describe("explicit agent stability", () => {
  it("settles a matching trace without inferring successful outcome", () => {
    const state = replay([
      event(1, {
        type: "input.applied",
        traceId: "known-trace",
        kind: "normal",
      }),
      event(2, {
        type: "input.applied",
        traceId: "other-trace",
        kind: "normal",
      }),
      event(
        3,
        {
          type: "span.started",
          spanId: "failed-tool",
          kind: "tool",
          name: "bash",
          timingBasis: "observed",
        },
        { traceId: "known-trace", runId: "settled-run" },
      ),
      event(4, {
        type: "span.ended",
        spanId: "failed-tool",
        outcome: "failed",
      }),
      event(5, {
        type: "run.settled",
        runId: "settled-run",
        outcomeKnown: false,
      }),
    ]);
    expect(state.traces["known-trace"].settled).toBe(true);
    expect(state.traces["other-trace"].settled).toBe(false);
    expect(state.spans["failed-tool"].state).toBe("failed");
    expect(state.traces["known-trace"]).not.toHaveProperty("outcome");
  });
});

it("settled without run identity closes only an explicitly referenced trace", () => {
  const state = replay([
    event(1, { type: "input.applied", traceId: "q1", kind: "normal" }),
    event(2, { type: "input.applied", traceId: "q2", kind: "normal" }),
    event(
      3,
      {
        type: "span.started",
        spanId: "a",
        kind: "llm",
        name: "a",
        timingBasis: "observed",
      },
      { traceId: "q1" },
    ),
    event(
      4,
      {
        type: "span.started",
        spanId: "b",
        kind: "llm",
        name: "b",
        timingBasis: "observed",
      },
      { traceId: "q2" },
    ),
    event(5, { type: "run.settled", outcomeKnown: false }, { traceId: "q1" }),
  ]);
  expect(state.traces.q1!.settled).toBe(true);
  expect(state.traces.q2!.settled).toBe(false);
  expect(state.traces.q2!.end).toBeUndefined();
  const unchanged = reduce(
    state,
    event(6, { type: "run.settled", outcomeKnown: false }),
  );
  expect(unchanged.traces.q2!.settled).toBe(false);
});
