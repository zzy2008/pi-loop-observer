import type { EventDraft, Fact, PayloadInput } from "../../src/model/index.js";
/** Synthetic questions are one hour apart, with overlapping same-name tools. */
export function multiQuestionFixture(
  sessionKey = "fixture/multi-question",
  turnsPerQuestion = 12,
) {
  const producerId = sessionKey + ":producer";
  const events: EventDraft[] = [];
  const payloads: PayloadInput[] = [];
  let runId = "",
    traceId = "",
    turnId = "";
  const add = (fact: Fact, time: number, refs: EventDraft["refs"] = {}) => {
    events.push({
      schemaVersion: 1,
      eventId: producerId + ":" + (events.length + 1),
      producerId,
      producerSeq: events.length + 1,
      sessionKey,
      source: "pi-live",
      observedAt: {
        wallMs: 1791072000000 + time,
        monoMs: time,
        clockId: "multi-clock",
      },
      refs: {
        ...(runId ? { runId } : {}),
        ...(traceId ? { traceId } : {}),
        ...(turnId ? { turnId } : {}),
        ...refs,
      },
      fact,
    });
  };
  const payload = (id: string, value: unknown) => {
    payloads.push({
      payloadId: sessionKey + ":" + id,
      mimeType: "application/json",
      encoding: "utf8",
      data: JSON.stringify(value),
      source: "pi-live",
      completeness: { truncated: false },
    });
    return sessionKey + ":" + id;
  };
  add(
    {
      type: "capture.started",
      reason: "fixture",
      capabilities: { observedStages: true },
    },
    0,
  );
  for (let q = 1; q <= 2; q++) {
    runId = `multi-run-${q}`;
    traceId = `multi-question-${q}`;
    turnId = "";
    const base = (q - 1) * 3600000;
    add({ type: "run.started", runId }, base);
    add(
      {
        type: "input.applied",
        traceId,
        kind: "normal",
        label: "用户问题",
        contentRef: payload(`prompt-${q}`, {
          role: "user",
          content: [
            {
              type: "text",
              text:
                q === 1
                  ? "Investigate search configuration"
                  : "Review API retries",
            },
          ],
        }),
      },
      base + 1,
    );
    for (let t = 1; t <= turnsPerQuestion; t++) {
      turnId = `multi-q${q}-turn${t}`;
      const time = base + (t - 1) * 6000 + 10;
      add({ type: "turn.started", turnId, runId, turnIndex: t - 1 }, time);
      const llm = `multi-q${q}-t${t}-llm`,
        first = `multi-q${q}-t${t}-read1`,
        second = `multi-q${q}-t${t}-read2`;
      add(
        {
          type: "span.started",
          spanId: llm,
          kind: "llm",
          name: "模型响应",
          model: "fixture-model",
          timingBasis: "observed",
        },
        time + 10,
        { spanId: llm },
      );
      add(
        { type: "span.stage_changed", spanId: llm, stage: "text-output" },
        time + 100,
        { spanId: llm },
      );
      add(
        { type: "span.ended", spanId: llm, outcome: "completed" },
        time + 1600,
        { spanId: llm },
      );
      for (const [index, id] of [first, second].entries()) {
        add(
          {
            type: "span.started",
            spanId: id,
            kind: "tool",
            name: "read",
            timingBasis: "observed",
            inputRef: payload(`q${q}-t${t}-args${index}`, {
              path: `src/q${q}/turn-${t}-${index}.ts`,
            }),
          },
          time + 1700 + index * 100,
          { spanId: id },
        );
        add(
          {
            type: "relation.observed",
            from: llm,
            to: id,
            relationKind: "calls",
            evidence: "fixture tool declaration",
          },
          time + 1701 + index * 100,
        );
      }
      add(
        { type: "span.ended", spanId: first, outcome: "completed" },
        time + 2900,
        { spanId: first },
      );
      add(
        {
          type: "span.ended",
          spanId: second,
          outcome: t === 2 ? "failed" : "completed",
        },
        time + 3400,
        { spanId: second },
      );
      add({ type: "turn.ended", turnId, runId, turnIndex: t - 1 }, time + 3500);
    }
    add({ type: "run.ended", runId }, base + turnsPerQuestion * 6000);
    add(
      { type: "run.settled", runId, outcomeKnown: false },
      base + turnsPerQuestion * 6000 + 1,
    );
  }
  add(
    { type: "capture.stopped", reason: "fixture complete", clean: true },
    3600000 + turnsPerQuestion * 6000 + 2,
  );
  return { sessionKey, producerId, events, payloads };
}
