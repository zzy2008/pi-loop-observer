import { expect, it } from "vitest";
import { CaptureQueue, type QueueBatch } from "../../src/capture/queue.js";
import { CaptureEngine } from "../../src/capture/engine.js";
import { project, replay, type StoredEvent } from "../../src/model/index.js";

it.each([true, false, undefined])(
  "preserves public aborted=%s without guessing old run outcome",
  async (aborted) => {
    const batches: QueueBatch[] = [];
    const queue = new CaptureQueue({
      producerId: "p",
      sessionKey: "s",
      autoFlushMs: 0,
      send: async (batch) => {
        batches.push(batch);
        return {
          producerId: "p",
          ackedThrough: batch.events.at(-1)!.producerSeq,
        };
      },
    });
    let monoMs = 0;
    const engine = new CaptureEngine({
      queue,
      sessionKey: "s",
      getEntry: () => undefined,
      clock: () => ({ wallMs: 1000, monoMs: ++monoMs, clockId: "fixture" }),
    });
    engine.accept({ type: "agent_start" });
    engine.accept({
      type: "message_start",
      message: { role: "user", content: "fixture" },
    });
    engine.accept({ type: "tool_execution_start", toolCallId: "t" });
    engine.accept({
      type: "tool_execution_end",
      toolCallId: "t",
      durationMs: 42.5,
    });
    engine.accept({ type: "agent_end" });
    engine.accept({ type: "agent_settled", aborted });
    await engine.stop("fixture");
    const events = batches
      .flatMap((batch) => batch.events)
      .map((e, i) => ({
        ...e,
        cursor: String(i + 1),
        receivedAt: 1000,
      })) as StoredEvent[];
    const settled = events.find((e) => e.fact.type === "run.settled")!.fact;
    expect(settled).toMatchObject({
      outcomeKnown: typeof aborted === "boolean",
    });
    const view = project(replay(events));
    expect(view.traces[0]!.aborted).toBe(aborted);
    expect(view.spans[0]!.durationMs).toBe(42.5);
    expect(view.spans[0]!.executionDurationMs).toBe(42.5);
    const legacy = events.map((e) =>
      e.fact.type === "span.ended"
        ? { ...e, fact: { ...e.fact, durationMs: undefined } }
        : e,
    );
    expect(project(replay(legacy)).spans[0]!.durationMs).toBe(2);
    const imported = legacy.map((e) => ({
      ...e,
      source: "pi-import" as const,
    }));
    expect(project(replay(imported)).spans[0]!.durationMs).toBeNull();
  },
);

it.each([-1, NaN, Infinity])(
  "rejects invalid SDK tool duration %s",
  async (durationMs) => {
    const batches: QueueBatch[] = [];
    const queue = new CaptureQueue({
      producerId: "p",
      sessionKey: "s",
      autoFlushMs: 0,
      send: async (batch) => {
        batches.push(batch);
        return {
          producerId: "p",
          ackedThrough: batch.events.at(-1)!.producerSeq,
        };
      },
    });
    const engine = new CaptureEngine({
      queue,
      sessionKey: "s",
      getEntry: () => undefined,
    });
    engine.accept({ type: "tool_execution_start", toolCallId: "t" });
    engine.accept({ type: "tool_execution_end", toolCallId: "t", durationMs });
    await engine.stop("fixture");
    const fact = batches
      .flatMap((b) => b.events)
      .find((e) => e.fact.type === "span.ended")!.fact;
    expect(fact).not.toHaveProperty("durationMs");
  },
);
