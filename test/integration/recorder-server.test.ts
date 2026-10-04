import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recorder } from "../../src/recorder/index.js";
import { createApp } from "../../src/server/app.js";
import { LeaseRegistry } from "../../src/lifecycle/index.js";
import type { EventDraft } from "../../src/model/index.js";
const event = (seq: number, p = "p"): EventDraft => ({
  schemaVersion: 1,
  eventId: p + seq,
  producerId: p,
  producerSeq: seq,
  sessionKey: "s",
  source: "observer",
  observedAt: { wallMs: seq, monoMs: seq, clockId: "clock" },
  refs: {},
  fact: { type: "run.started", runId: "run" + seq },
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "observer-test-"));
  const r = new Recorder(join(dir, "db.sqlite"));
  return {
    r,
    done: () => {
      r.close();
      rmSync(dir, { recursive: true, force: true });
    },
    batch: (events: EventDraft[]) => ({
      protocolVersion: 1 as const,
      storeId: r.storeId,
      producerId: events[0]!.producerId,
      events,
    }),
  };
}
describe("durable recorder", () => {
  it("commits before notifications, retries unchanged, rejects conflicts and gaps atomically", () => {
    const f = fixture();
    try {
      let notifications = 0;
      f.r.onCommit(() => {
        notifications++;
        expect(f.r.getWatermark()).toBe("2");
      });
      const ack = f.r.appendBatch(f.batch([event(1), event(2)]));
      expect(ack.ackedThrough).toBe(2);
      expect(f.r.appendBatch(f.batch([event(1), event(2)]))).toEqual(ack);
      expect(notifications).toBe(1);
      expect(() =>
        f.r.appendBatch(
          f.batch([{ ...event(2), fact: { type: "run.ended", runId: "r" } }]),
        ),
      ).toThrow("Sequence content changed");
      expect(() => f.r.appendBatch(f.batch([event(3), event(5)]))).toThrow(
        "sequence gap",
      );
      expect(f.r.getWatermark()).toBe("2");
    } finally {
      f.done();
    }
  });
  it("freezes pagination watermark while other producers append, persists restart and rebuilds projection", () => {
    const f = fixture();
    try {
      f.r.appendBatch(f.batch([event(1), event(2)]));
      const w = f.r.getWatermark();
      const first = f.r.readPage({
        sessionKey: "s",
        after: "0",
        through: w,
        limit: 1,
      });
      f.r.appendBatch(f.batch([event(1, "q")]));
      const second = f.r.readPage({
        sessionKey: "s",
        after: first.nextAfter,
        through: w,
        limit: 1,
      });
      expect(second.events.map((e) => e.cursor)).toEqual(["2"]);
      expect(second.done).toBe(true);
      expect(f.r.rebuildProjection("s").cursor).toBe("3");
    } finally {
      f.done();
    }
  });
  it("rolls back payload references and enforces content visibility", () => {
    const f = fixture();
    try {
      const e = {
        ...event(1),
        fact: {
          type: "message.finalized" as const,
          messageKey: "m",
          role: "assistant" as const,
          contentRef: "payload",
          sourceKind: "session" as const,
        },
      };
      expect(() => f.r.appendBatch(f.batch([e]))).toThrow("Referenced payload");
      expect(f.r.getWatermark()).toBe("0");
      f.r.appendBatch({
        ...f.batch([e]),
        payloads: [
          {
            payloadId: "payload",
            mimeType: "text/plain",
            encoding: "utf8",
            data: "你好",
            source: "observer",
            completeness: { truncated: false },
          },
        ],
      });
      expect(() =>
        f.r.readPayload({ payloadId: "payload", sessionKey: "s", asOf: "0" }),
      ).toThrow("not visible");
      expect(
        Buffer.from(
          f.r.readPayload({ payloadId: "payload", sessionKey: "s", asOf: "1" })
            .data,
          "base64",
        ).toString(),
      ).toBe("你好");
    } finally {
      f.done();
    }
  });
});
describe("server security and leases", () => {
  it("requires private credentials, exchanges ticket once and isolates origins", async () => {
    const f = fixture();
    try {
      const { app } = createApp({
        recorder: f.r,
        token: "secret",
        instanceId: "instance",
      });
      const req = (path: string, init?: RequestInit) =>
        app.request("http://127.0.0.1:8123" + path, init);
      expect((await req("/api/sessions")).status).toBe(401);
      const ticket = (await (
        await req("/internal/viewer-ticket", {
          method: "POST",
          headers: { authorization: "Bearer secret" },
        })
      ).json()) as { ticket: string };
      const exchange = () =>
        req("/api/viewer/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ticket),
        });
      const response = await exchange();
      expect(response.status).toBe(200);
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      expect((await req("/api/sessions", { headers: { cookie } })).status).toBe(
        200,
      );
      expect((await exchange()).status).toBe(401);
      expect(
        (
          await req("/api/sessions", {
            headers: { cookie, origin: "https://evil.example" },
          })
        ).status,
      ).toBe(401);
    } finally {
      f.done();
    }
  });
  it("keeps connected viewer alive and expires disconnected producers after grace", () => {
    let now = 0;
    const leases = new LeaseRegistry(30, 60, () => now);
    leases.touch("p");
    now = 31;
    expect(leases.shouldStop()).toBe(false);
    now = 92;
    expect(leases.shouldStop()).toBe(true);
    const disconnect = leases.connect("viewer");
    now = 999999;
    expect(leases.shouldStop()).toBe(false);
    disconnect();
    now += 120001;
    expect(leases.shouldStop()).toBe(false);
    now += 61;
    expect(leases.shouldStop()).toBe(true);
  });
});

describe("real HTTP SSE recovery", () => {
  it("replays commits made between the frozen history snapshot and SSE subscription", async () => {
    const { startService } = await import("../../src/server/main.js");
    const dir = mkdtempSync(join(tmpdir(), "observer-http-"));
    const service = await startService({ dataDir: dir });
    const abort = new AbortController();
    try {
      const r = service.recorder;
      const batch = (seq: number) => ({
        protocolVersion: 1 as const,
        storeId: r.storeId,
        producerId: "p",
        events: [event(seq)],
      });
      r.appendBatch(batch(1));
      const watermark = r.getWatermark();
      r.appendBatch(batch(2));
      const auth = { authorization: `Bearer ${service.handle.token}` };
      const ticket = (await (
        await fetch(service.handle.url + "/internal/viewer-ticket", {
          method: "POST",
          headers: auth,
        })
      ).json()) as { ticket: string };
      const exchange = await fetch(service.handle.url + "/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ticket),
      });
      const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
      const response = await fetch(
        service.handle.url + `/api/stream?sessionKey=s&after=${watermark}`,
        { headers: { cookie }, signal: abort.signal },
      );
      const reader = response.body!.getReader();
      let content = "";
      const timer = setTimeout(() => abort.abort(), 3000);
      while (!content.includes("id: 2")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        content += new TextDecoder().decode(chunk.value);
      }
      clearTimeout(timer);
      expect(content).toContain("id: 2");
      expect(content).not.toContain("id: 1");
      r.appendBatch(batch(3));
      while (!content.includes("id: 3")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        content += new TextDecoder().decode(chunk.value);
      }
      expect(content).toContain("id: 3");
      abort.abort();
      await reader.cancel().catch(() => {});
    } finally {
      abort.abort();
      await service.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
it("rejects malformed enum and non-finite times without advancing acknowledgment", () => {
  const f = fixture();
  try {
    expect(() =>
      f.r.appendBatch(
        f.batch([
          {
            ...event(1),
            fact: {
              type: "span.started",
              spanId: "x",
              kind: "bogus",
              name: "x",
              timingBasis: "observed",
            } as any,
          },
        ]),
      ),
    ).toThrow("Invalid span kind");
    expect(() =>
      f.r.appendBatch(
        f.batch([
          {
            ...event(1),
            observedAt: { wallMs: NaN, monoMs: null, clockId: null },
          },
        ]),
      ),
    ).toThrow("Invalid event envelope");
    expect(f.r.getWatermark()).toBe("0");
    expect(() =>
      f.r.readPage({
        sessionKey: "s",
        after: "0",
        through: "9007199254740993",
        limit: 1,
      }),
    ).toThrow("beyond store");
  } finally {
    f.done();
  }
});
it("retains bigint cursor precision beyond JavaScript safe integers", () => {
  const f = fixture();
  try {
    f.r.appendBatch(f.batch([event(1)]));
    f.r.db
      .prepare("UPDATE sqlite_sequence SET seq=? WHERE name='events'")
      .run(9007199254740992n);
    f.r.appendBatch(f.batch([event(2)]));
    expect(f.r.getWatermark()).toBe("9007199254740993");
    expect(
      f.r.readPage({
        sessionKey: "s",
        after: "1",
        through: f.r.getWatermark(),
        limit: 1,
      }).events[0]!.cursor,
    ).toBe("9007199254740993");
  } finally {
    f.done();
  }
});

describe("persistent producer disconnection", () => {
  it("expires only the silent producer and preserves unknown end times after reopening", () => {
    const dir = mkdtempSync(join(tmpdir(), "observer-loss-"));
    const path = join(dir, "db.sqlite");
    let r = new Recorder(path);
    const makeSpan = (producerId: string): EventDraft => ({
      ...event(1, producerId),
      refs: { spanId: producerId + "-span" },
      fact: {
        type: "span.started",
        spanId: producerId + "-span",
        kind: "tool",
        name: "bash",
        timingBasis: "observed",
      },
    });
    let now = 0;
    const leases = new LeaseRegistry(30, 60, () => now);
    try {
      for (const producerId of ["silent", "healthy"])
        r.appendBatch({
          protocolVersion: 1,
          storeId: r.storeId,
          producerId,
          events: [makeSpan(producerId)],
        });
      const runtime = createApp({
        recorder: r,
        token: "secret",
        instanceId: "instance",
        leases,
      });
      now = 20;
      leases.touch("producer:healthy");
      now = 31;
      leases.sweep();
      let state = r.rebuildProjection("s");
      expect(state.spans["silent-span"]!.state).toBe("interrupted");
      expect(state.spans["silent-span"]!.end).toBeUndefined();
      expect(state.spans["silent-span"]!.quality.timing).toBe("unknown");
      expect(state.spans["healthy-span"]!.state).toBe("running");
      const watermark = r.getWatermark();
      leases.sweep();
      expect(r.getWatermark()).toBe(watermark);
      runtime.stopWatching();
      r.close();
      r = new Recorder(path);
      state = r.rebuildProjection("s");
      expect(state.spans["silent-span"]!.state).toBe("interrupted");
      expect(state.spans["silent-span"]!.end).toBeUndefined();
    } finally {
      r.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("allows recovery grace on service restart and does not mark cleanly stopped producer lost", () => {
    const f = fixture();
    let now = 0;
    const leases = new LeaseRegistry(30, 60, () => now);
    try {
      f.r.appendBatch(f.batch([event(1)]));
      f.r.appendBatch({
        protocolVersion: 1,
        storeId: f.r.storeId,
        producerId: "clean",
        events: [
          {
            ...event(1, "clean"),
            fact: { type: "capture.stopped", reason: "quit", clean: true },
          },
        ],
      });
      const runtime = createApp({
        recorder: f.r,
        token: "secret",
        instanceId: "restarted",
        leases,
      });
      now = 29;
      leases.sweep();
      expect(f.r.getWatermark()).toBe("2");
      now = 31;
      leases.sweep();
      const facts = f.r.readPage({
        sessionKey: "s",
        after: "2",
        through: f.r.getWatermark(),
        limit: 20,
      }).events;
      expect(facts).toHaveLength(1);
      expect(facts[0]!.fact).toMatchObject({
        type: "capture.gap",
        targetProducerId: "p",
      });
      expect(f.r.activeProducers()).toEqual([]);
      runtime.stopWatching();
    } finally {
      f.done();
    }
  });
});
