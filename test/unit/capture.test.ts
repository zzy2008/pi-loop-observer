import { describe, it, expect } from "vitest";
import { CaptureQueue, type QueueBatch } from "../../src/capture/queue.js";
import { replay, type StoredEvent } from "../../src/model/index.js";
import { CaptureEngine } from "../../src/capture/engine.js";
import {
  SessionImporter,
  reconcileTurn,
  type SourceEntry,
} from "../../src/importer/index.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const time = { wallMs: 100, monoMs: 10, clockId: "fixture" };
const fact = { type: "run.started" as const, runId: "r" };
describe("durable bounded queue", () => {
  it("retains immutable events when ACK is lost and retransmits identical identity", async () => {
    const sent: QueueBatch[] = [];
    let attempts = 0;
    const queue = new CaptureQueue({
      producerId: "p",
      sessionKey: "s",
      autoFlushMs: 0,
      retryMs: 1,
      send: async (batch) => {
        sent.push(structuredClone(batch));
        if (attempts++ === 0) throw Error("lost ACK");
        return {
          producerId: "p",
          ackedThrough: batch.events.at(-1)!.producerSeq,
        };
      },
    });
    const input = { fact: { ...fact }, observedAt: { ...time } };
    queue.offer(input);
    input.fact.runId = "mutated";
    const report = await queue.flush(200);
    expect(sent.length).toBe(2);
    expect(sent[0]).toEqual(sent[1]);
    expect(sent[0]!.events[0]!.fact).toEqual(fact);
    expect(report.pending).toBe(0);
    queue.close();
  });
  it("keeps one inflight batch and reports overflow with contiguous seq", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sent: QueueBatch[] = [];
    const queue = new CaptureQueue({
      producerId: "p",
      sessionKey: "s",
      maxEvents: 3,
      autoFlushMs: 0,
      send: async (batch) => {
        sent.push(batch);
        await gate;
        return {
          producerId: "p",
          ackedThrough: batch.events.at(-1)!.producerSeq,
        };
      },
    });
    expect(queue.offer({ fact, observedAt: time })).toBe(true);
    expect(queue.offer({ fact, observedAt: time })).toBe(true);
    expect(queue.offer({ fact, observedAt: time })).toBe(false);
    const a = queue.flush(200);
    const b = queue.flush(200);
    await Promise.resolve();
    expect(sent.length).toBe(1);
    release();
    await Promise.all([a, b]);
    expect(sent.flatMap((x) => x.events).map((x) => x.producerSeq)).toEqual([
      1, 2, 3,
    ]);
    expect(sent.flatMap((x) => x.events).at(-1)?.fact.type).toBe("capture.gap");
    queue.close();
  });
});
describe("native archive and explicit reconciliation", () => {
  it("preserves revisions and missing parent quality, deduplicating repeated ingestion", () => {
    const items: any[] = [];
    const importer = new SessionImporter((item) => {
      items.push(item);
    });
    const entry: SourceEntry = {
      id: "a",
      parentId: "absent",
      type: "message",
      timestamp: "2026-01-01",
      message: { role: "assistant", content: [{ type: "text", text: "a" }] },
    };
    expect(
      importer.ingestEntries({ sessionKey: "s" }, [entry]).warnings,
    ).toContain("missing parent absent");
    expect(importer.ingestEntries({ sessionKey: "s" }, [entry]).skipped).toBe(
      1,
    );
    importer.ingestEntries({ sessionKey: "s" }, [
      { ...entry, message: { ...entry.message, content: "revision" } },
    ]);
    expect(items.filter((x) => x.fact.type === "entry.archived")).toHaveLength(
      2,
    );
    expect(
      items
        .filter((x) => x.fact.type === "span.started")
        .every((x) => x.fact.timingBasis === "unknown"),
    ).toBe(true);
    expect(items.every((x) => x.observedAt.monoMs === null)).toBe(true);
  });
  it("uses toolCallId rather than tool result array positions", () => {
    const entries: SourceEntry[] = [
      { id: "a", type: "message", message: { role: "assistant" } },
      {
        id: "b",
        type: "message",
        message: { role: "toolResult", toolCallId: "second" },
      },
      {
        id: "c",
        type: "message",
        message: { role: "toolResult", toolCallId: "first" },
      },
    ];
    const result = reconcileTurn(
      { messageEntryId: "a", toolResultEntryIds: ["b", "c"] },
      { getEntry: (id) => entries.find((x) => x.id === id) },
      "llm",
      new Map([
        ["first", "tool-1"],
        ["second", "tool-2"],
      ]),
    );
    expect([...result.bindings]).toEqual([
      ["a", "llm"],
      ["b", "tool-2"],
      ["c", "tool-1"],
    ]);
  });
  it("retains incomplete JSONL tail for the next incremental read and reports unknown version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "observer-import-"));
    try {
      const path = join(dir, "fixture.jsonl");
      const items: any[] = [];
      const importer = new SessionImporter((item) => {
        items.push(item);
      });
      const header = JSON.stringify({
        type: "session",
        version: 3,
        id: "fixture",
      });
      const entry = JSON.stringify({
        id: "e",
        type: "message",
        message: { role: "assistant", content: "synthetic" },
      });
      await writeFile(path, header + "\n" + entry.slice(0, 15));
      let progress: any;
      for await (const value of importer.importSession({ path }))
        progress = value;
      expect(progress.incompleteTail).toBe(true);
      expect(progress.imported).toBe(0);
      await writeFile(path, header + "\n" + entry + "\n");
      for await (const value of importer.importSession({ path }))
        progress = value;
      expect(progress.imported).toBe(1);
      for await (const value of importer.importSession({ path }))
        progress = value;
      expect(progress.skipped).toBe(1);
      await writeFile(
        path,
        JSON.stringify({ type: "session", version: 999, id: "fixture" }) + "\n",
      );
      for await (const value of importer.importSession({ path }))
        progress = value;
      expect(progress.status).toBe("unsupported-version");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
it("capture stage boundaries and binds final native entries without duplicate spans", async () => {
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
  const entry: SourceEntry = {
    id: "assistant-entry",
    type: "message",
    message: { role: "assistant", content: "final" },
  };
  const engine = new CaptureEngine({
    queue,
    sessionKey: "s",
    getEntry: (id) => (id === entry.id ? entry : undefined),
    clock: () => time,
  });
  engine.accept({ type: "input", text: "same", streamingBehavior: "followUp" });
  engine.accept({ type: "agent_start" });
  engine.accept({ type: "turn_start", turnIndex: 0 });
  engine.accept({
    type: "message_start",
    message: { role: "user", content: "same" },
  });
  engine.accept({ type: "message_start", message: { role: "assistant" } });
  engine.accept({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0 },
  });
  engine.accept({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0 },
  });
  engine.accept({
    type: "message_end",
    message: { role: "assistant", content: "final" },
  });
  engine.accept({ type: "turn_end", turnIndex: 0, messageEntryId: entry.id });
  engine.accept({ type: "agent_end" });
  engine.accept({ type: "agent_settled" });
  await engine.stop("quit");
  const events = batches.flatMap((x) => x.events);
  expect(events.filter((x) => x.fact.type === "span.started")).toHaveLength(1);
  expect(
    events.filter((x) => x.fact.type === "span.stage_changed"),
  ).toHaveLength(2);
  expect(
    events.find((x) => x.fact.type === "input.applied")?.fact,
  ).toMatchObject({ kind: "unclassified" });
  expect(
    events.find((x) => x.fact.type === "entity.bound")?.fact,
  ).toMatchObject({ evidence: "turn_end explicit entry ID" });
});
it("archives native question/turn inclusion and only explicit tool call dependencies", () => {
  const items: any[] = [];
  const importer = new SessionImporter((item) => {
    items.push(item);
  });
  const entries: SourceEntry[] = [
    {
      id: "user",
      type: "message",
      message: { role: "user", content: "synthetic question" },
    },
    {
      id: "assistant",
      parentId: "user",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call", name: "read", arguments: {} },
        ],
      },
    },
    {
      id: "result",
      parentId: "assistant",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        content: "synthetic result",
      },
    },
  ];
  importer.ingestEntries({ sessionKey: "s" }, entries);
  expect(items.filter((x) => x.fact.type === "input.applied")).toHaveLength(1);
  expect(items.filter((x) => x.fact.type === "turn.started")).toHaveLength(1);
  expect(items.filter((x) => x.fact.type === "relation.observed")).toHaveLength(
    1,
  );
  expect(
    items
      .filter((x) => x.fact.type === "span.started")
      .map((x) => x.refs.traceId)[0],
  ).toEqual(
    items
      .filter((x) => x.fact.type === "span.started")
      .map((x) => x.refs.traceId)[1],
  );
});
it("observer accepts cyclic source payloads without throwing into Pi", async () => {
  const queue = new CaptureQueue({
    producerId: "p",
    sessionKey: "s",
    autoFlushMs: 0,
    send: async (batch) => ({
      producerId: "p",
      ackedThrough: batch.events.at(-1)!.producerSeq,
    }),
  });
  const engine = new CaptureEngine({
    sessionKey: "s",
    queue,
    getEntry: () => undefined,
  });
  const message: any = { role: "user" };
  message.content = message;
  expect(() => engine.accept({ type: "message_start", message })).not.toThrow();
  await engine.stop("quit");
});

it("defers question binding across consecutive Pi runs, then reuses only a true continuation", async () => {
  const batches: QueueBatch[] = [];
  let tick = 0;
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
    clock: () => ({ wallMs: ++tick, monoMs: tick, clockId: "clock" }),
  });
  const start = () => {
    engine.accept({ type: "agent_start" });
    engine.accept({ type: "turn_start", turnIndex: 0 });
  };
  const user = (content: string) =>
    engine.accept({
      type: "message_start",
      message: { role: "user", content },
    });
  const assistant = () =>
    engine.accept({ type: "message_start", message: { role: "assistant" } });
  const end = () => {
    engine.accept({
      type: "message_end",
      message: { role: "assistant", content: "done" },
    });
    engine.accept({ type: "turn_end", turnIndex: 0 });
    engine.accept({ type: "agent_end" });
    engine.accept({ type: "agent_settled" });
  };
  start();
  user("first");
  assistant();
  end();
  start();
  await queue.flush(1000);
  let events = batches.flatMap((b) => b.events);
  const runs = events.filter((e) => e.fact.type === "run.started");
  expect(runs[1]!.refs.traceId).toBeUndefined();
  expect(runs[1]!.refs.turnId).toBeUndefined();
  expect(
    events.filter((e) => e.fact.type === "turn.started")[1]!.refs.traceId,
  ).toBeUndefined();
  user("second");
  await queue.flush(1000);
  events = batches.flatMap((b) => b.events);
  const toStored = () =>
    events.map((e, i) => ({
      ...e,
      cursor: String(i + 1),
      receivedAt: i,
    })) as StoredEvent[];
  const questions = events.filter((e) => e.fact.type === "input.applied");
  expect(questions[1]!.refs.traceId).not.toBe(questions[0]!.refs.traceId);
  expect(replay(toStored()).turns[questions[1]!.refs.turnId!]!.traceId).toBe(
    questions[1]!.refs.traceId,
  );
  assistant();
  end();
  start();
  assistant();
  await queue.flush(1000);
  events = batches.flatMap((b) => b.events);
  const calls = events.filter((e) => e.fact.type === "span.started");
  expect(calls[2]!.refs.traceId).toBe(questions[1]!.refs.traceId);
  expect(calls[2]!.refs.turnId).not.toBe(calls[1]!.refs.turnId);
  const continuing = replay(toStored());
  expect(continuing.traces[questions[1]!.refs.traceId!]!.end).toBeUndefined();
  expect(continuing.traces[questions[1]!.refs.traceId!]!.settled).toBe(false);
  expect(continuing.traces[questions[0]!.refs.traceId!]!.settled).toBe(true);
  end();
  await engine.stop("done");
});
