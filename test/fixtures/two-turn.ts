import type { EventDraft, Fact, PayloadInput } from "../../src/model/index.js";
export function twoTurnFixture(
  sessionKey = "fixture/two-turn",
  producerId = "fixture-producer",
) {
  const payloads: PayloadInput[] = [
    {
      payloadId: "fixture-prompt",
      mimeType: "text/plain",
      encoding: "utf8",
      data: "检查项目并修复问题",
      source: "pi-live",
      completeness: { truncated: false },
    },
    {
      payloadId: "fixture-answer",
      mimeType: "text/plain",
      encoding: "utf8",
      data: "工具 A 失败，工具 B 完成；第二轮模型已处理错误并给出结果。",
      source: "pi-live",
      completeness: { truncated: false },
    },
  ];
  const events: EventDraft[] = [];
  const add = (fact: Fact, time: number, refs: EventDraft["refs"] = {}) =>
    events.push({
      schemaVersion: 1,
      eventId: `${producerId}-${events.length + 1}`,
      producerId,
      producerSeq: events.length + 1,
      sessionKey,
      source: "pi-live",
      observedAt: {
        wallMs: 1700000000000 + time,
        monoMs: time,
        clockId: "fixture-clock",
      },
      refs: { runId: "fixture-run", traceId: "fixture-trace", ...refs },
      fact,
    });
  add(
    {
      type: "capture.started",
      reason: "fixture",
      capabilities: {
        observedStages: true,
        providerAttemptIdentity: "unavailable",
        clockDomains: ["fixture-clock"],
      },
    },
    0,
  );
  add({ type: "run.started", runId: "fixture-run" }, 0);
  add(
    {
      type: "input.applied",
      traceId: "fixture-trace",
      kind: "normal",
      label: "双轮模型与并行工具",
      contentRef: "fixture-prompt",
    },
    10,
  );
  add(
    {
      type: "turn.started",
      turnId: "fixture-turn1",
      runId: "fixture-run",
      turnIndex: 0,
    },
    20,
    { turnId: "fixture-turn1" },
  );
  add(
    {
      type: "span.started",
      spanId: "fixture-llm1",
      kind: "llm",
      name: "LLM 1",
      timingBasis: "observed",
      inputRef: "fixture-prompt",
    },
    30,
    { turnId: "fixture-turn1", spanId: "fixture-llm1" },
  );
  add(
    {
      type: "span.stage_changed",
      spanId: "fixture-llm1",
      stage: "thinking-output",
    },
    200,
  );
  add(
    {
      type: "span.stage_changed",
      spanId: "fixture-llm1",
      stage: "tool-args-output",
    },
    700,
  );
  add(
    { type: "span.ended", spanId: "fixture-llm1", outcome: "completed" },
    1000,
  );
  add(
    {
      type: "span.started",
      spanId: "fixture-tool-a",
      kind: "tool",
      name: "bash",
      timingBasis: "observed",
    },
    1050,
    { turnId: "fixture-turn1", spanId: "fixture-tool-a" },
  );
  add(
    {
      type: "span.started",
      spanId: "fixture-tool-b",
      kind: "tool",
      name: "read",
      timingBasis: "observed",
    },
    1100,
    { turnId: "fixture-turn1", spanId: "fixture-tool-b" },
  );
  add(
    {
      type: "relation.observed",
      from: "fixture-llm1",
      to: "fixture-tool-a",
      relationKind: "calls",
      evidence: "fixture toolCallId",
    },
    1110,
  );
  add(
    {
      type: "relation.observed",
      from: "fixture-llm1",
      to: "fixture-tool-b",
      relationKind: "calls",
      evidence: "fixture toolCallId",
    },
    1120,
  );
  add(
    { type: "span.ended", spanId: "fixture-tool-a", outcome: "failed" },
    1800,
  );
  add(
    { type: "span.ended", spanId: "fixture-tool-b", outcome: "completed" },
    2200,
  );
  add(
    {
      type: "turn.ended",
      turnId: "fixture-turn1",
      runId: "fixture-run",
      turnIndex: 0,
    },
    2250,
    { turnId: "fixture-turn1" },
  );
  add(
    {
      type: "turn.started",
      turnId: "fixture-turn2",
      runId: "fixture-run",
      turnIndex: 1,
    },
    2300,
    { turnId: "fixture-turn2" },
  );
  add(
    {
      type: "span.started",
      spanId: "fixture-llm2",
      kind: "llm",
      name: "LLM 2",
      timingBasis: "observed",
    },
    2350,
    { turnId: "fixture-turn2", spanId: "fixture-llm2" },
  );
  add(
    {
      type: "relation.observed",
      from: "fixture-tool-a",
      to: "fixture-llm2",
      relationKind: "result-consumed",
      evidence: "fixture context",
    },
    2360,
  );
  add(
    {
      type: "relation.observed",
      from: "fixture-tool-b",
      to: "fixture-llm2",
      relationKind: "result-consumed",
      evidence: "fixture context",
    },
    2370,
  );
  add(
    {
      type: "span.stage_changed",
      spanId: "fixture-llm2",
      stage: "text-output",
    },
    2600,
  );
  add(
    {
      type: "span.ended",
      spanId: "fixture-llm2",
      outcome: "completed",
      contentRef: "fixture-answer",
    },
    3500,
  );
  add(
    {
      type: "turn.ended",
      turnId: "fixture-turn2",
      runId: "fixture-run",
      turnIndex: 1,
    },
    3510,
    { turnId: "fixture-turn2" },
  );
  add({ type: "run.ended", runId: "fixture-run", outcome: "completed" }, 3520);
  add({ type: "run.settled", runId: "fixture-run", outcomeKnown: true }, 3530);
  add(
    { type: "capture.stopped", reason: "fixture complete", clean: true },
    3540,
  );
  return { sessionKey, producerId, events, payloads };
}
