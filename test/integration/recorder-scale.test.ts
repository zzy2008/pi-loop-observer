import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Recorder } from "../../src/recorder/index.js";
import { createApp } from "../../src/server/app.js";
import { LeaseRegistry } from "../../src/lifecycle/index.js";
import { project, type EventDraft } from "../../src/model/index.js";
const draft = (seq: number): EventDraft => ({
  schemaVersion: 1,
  eventId: `scale-${seq}`,
  producerId: "scale",
  producerSeq: seq,
  sessionKey: "scale-session",
  source: "observer",
  observedAt: { wallMs: seq, monoMs: seq, clockId: "scale-clock" },
  refs: { runId: "scale-run" },
  fact: { type: seq % 2 ? "run.started" : "run.ended", runId: "scale-run" },
});
it("preserves all 5000 acknowledged facts through bounded batches, pagination and database reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "observer-scale-"));
  const path = join(dir, "db.sqlite");
  let r = new Recorder(path);
  const start = performance.now();
  try {
    const storeId = r.storeId;
    let ack = 0;
    for (let first = 1; first <= 5000; first += 128) {
      const events = Array.from(
        { length: Math.min(128, 5001 - first) },
        (_, offset) => draft(first + offset),
      );
      ack = r.appendBatch({
        protocolVersion: 1,
        storeId,
        producerId: "scale",
        events,
      }).ackedThrough;
    }
    const written = performance.now();
    expect(ack).toBe(5000);
    r.close();
    r = new Recorder(path);
    expect(r.storeId).toBe(storeId);
    expect(r.registerProducer("scale", "scale-session")).toBe(5000);
    const through = r.getWatermark();
    let after = "0",
      count = 0,
      pages = 0;
    while (true) {
      const page = r.readPage({
        sessionKey: "scale-session",
        after,
        through,
        limit: 137,
      });
      for (const event of page.events) {
        count++;
        expect(event.producerSeq).toBe(count);
        expect(event.eventId).toBe(`scale-${count}`);
      }
      after = page.nextAfter;
      pages++;
      if (page.done) break;
    }
    expect(count).toBe(5000);
    expect(after).toBe("5000");
    const retry = r.appendBatch({
      protocolVersion: 1,
      storeId,
      producerId: "scale",
      events: [draft(5000)],
    });
    expect(retry.ackedThrough).toBe(5000);
    expect(r.getWatermark()).toBe(through);
    const done = performance.now();
    console.log(
      JSON.stringify({
        benchmark: "recorder-5000-facts",
        node: process.version,
        facts: count,
        batchLimit: 128,
        pageLimit: 137,
        pages,
        writeMs: Math.round(written - start),
        reopenReadVerifyMs: Math.round(done - written),
        totalMs: Math.round(done - start),
      }),
    );
  } finally {
    r.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
it("reactivates a disconnected producer and restores only a genuinely observed terminal time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observer-reconnect-"));
  const r = new Recorder(join(dir, "db.sqlite"));
  let now = 0;
  const leases = new LeaseRegistry(30, 60, () => now);
  const runtime = createApp({
    recorder: r,
    token: "secret",
    instanceId: "instance",
    leases,
  });
  try {
    const start: EventDraft = {
      ...draft(1),
      refs: { spanId: "tool-1" },
      fact: {
        type: "span.started",
        spanId: "tool-1",
        kind: "tool",
        name: "bash",
        timingBasis: "observed",
      },
    };
    r.appendBatch({
      protocolVersion: 1,
      storeId: r.storeId,
      producerId: "scale",
      events: [start],
    });
    leases.touch("producer:scale");
    now = 31;
    leases.sweep();
    expect(r.rebuildProjection("scale-session").spans["tool-1"]!.state).toBe(
      "interrupted",
    );
    expect(r.activeProducers()).toEqual([]);
    const response = await runtime.app.request(
      "http://127.0.0.1:8000/internal/producers/scale/heartbeat",
      { method: "POST", headers: { authorization: "Bearer secret" } },
    );
    expect(response.status).toBe(200);
    expect(r.activeProducers()).toEqual([
      { producerId: "scale", sessionKey: "scale-session" },
    ]);
    const ended: EventDraft = {
      ...draft(2),
      refs: { spanId: "tool-1" },
      observedAt: { wallMs: 21, monoMs: 21, clockId: "scale-clock" },
      fact: { type: "span.ended", spanId: "tool-1", outcome: "completed" },
    };
    const next: EventDraft = {
      ...draft(3),
      refs: { spanId: "tool-2" },
      fact: {
        type: "span.started",
        spanId: "tool-2",
        kind: "tool",
        name: "read",
        timingBasis: "observed",
      },
    };
    r.appendBatch({
      protocolVersion: 1,
      storeId: r.storeId,
      producerId: "scale",
      events: [ended, next],
    });
    const state = r.rebuildProjection("scale-session");
    expect(state.spans["tool-1"]!.state).toBe("completed");
    expect(state.spans["tool-1"]!.end?.monoMs).toBe(21);
    expect(state.spans["tool-1"]!.quality.gaps.length).toBeGreaterThan(0);
    expect(
      project(state).spans.find((s) => s.id === "tool-1")!.durationMs,
    ).toBe(20);
    expect(state.spans["tool-2"]!.state).toBe("running");
  } finally {
    runtime.stopWatching();
    r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
