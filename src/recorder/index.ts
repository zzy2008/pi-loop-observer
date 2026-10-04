import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { replay, reduce } from "../model/index.js";
import type {
  Cursor,
  EventDraft,
  StoredEvent,
  PayloadInput,
  EventBatch,
  AppendAck,
  EventPage,
} from "../model/index.js";
export type { EventBatch, AppendAck, EventPage } from "../model/index.js";
export class ProtocolError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function parseCursor(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw new ProtocolError("cursor_invalid", "Invalid cursor");
  const n = BigInt(value);
  if (n > 9223372036854775807n)
    throw new ProtocolError("cursor_invalid", "Cursor exceeds SQLite range");
  return n;
}
function payloadIds(value: unknown): string[] {
  const out = new Set<string>();
  function visit(v: unknown) {
    if (!v || typeof v !== "object") return;
    if ("payloadId" in v && typeof v.payloadId === "string")
      out.add(v.payloadId);
    for (const [key, child] of Object.entries(v)) {
      if (
        (key === "contentRef" || key === "inputRef") &&
        typeof child === "string"
      )
        out.add(child);
      else visit(child);
    }
  }
  visit(value);
  return [...out];
}

function validateEvent(event: EventDraft) {
  if (
    !event ||
    typeof event !== "object" ||
    typeof event.eventId !== "string" ||
    typeof event.producerId !== "string" ||
    typeof event.sessionKey !== "string" ||
    !event.fact ||
    typeof event.fact !== "object" ||
    !event.refs ||
    typeof event.refs !== "object" ||
    !["pi-live", "pi-import", "observer"].includes(event.source) ||
    !event.observedAt ||
    !Number.isFinite(event.observedAt.wallMs) ||
    (event.observedAt.monoMs !== null &&
      !Number.isFinite(event.observedAt.monoMs)) ||
    (event.observedAt.clockId !== null &&
      typeof event.observedAt.clockId !== "string")
  )
    throw new ProtocolError("bad_request", "Invalid event envelope");
  if (
    "targetProducerId" in event.fact &&
    typeof event.fact.targetProducerId !== "string"
  )
    throw new ProtocolError("bad_request", "Invalid target producer");
  const required: Record<string, string[]> = {
    "capture.started": ["reason", "capabilities"],
    "input.submitted": ["submissionId", "mode"],
    "input.applied": ["traceId", "kind"],
    "run.started": ["runId"],
    "run.ended": ["runId"],
    "turn.started": ["turnId", "runId", "turnIndex"],
    "turn.ended": ["turnId", "runId", "turnIndex"],
    "span.started": ["spanId", "kind", "name", "timingBasis"],
    "span.stage_changed": ["spanId", "stage"],
    "span.ended": ["spanId", "outcome"],
    "message.finalized": ["messageKey", "role", "contentRef", "sourceKind"],
    "entry.archived": ["sourceEntryKey", "revisionHash", "contentRef"],
    "entity.bound": ["canonicalSpanId", "entryKey", "evidence"],
    "relation.observed": ["from", "to", "relationKind", "evidence"],
    "branch.selected": ["newLeafId"],
    "run.settled": ["outcomeKnown"],
    "capture.gap": ["scope", "reason"],
    "capture.stopped": ["reason", "clean"],
  };
  const fact = event.fact as unknown as Record<string, unknown>;
  const fields = required[String(fact.type)];
  if (!fields)
    throw new ProtocolError("unsupported_schema", "Unsupported fact type");
  for (const key of fields) {
    const v = fact[key];
    if (key === "capabilities") {
      if (!v || typeof v !== "object")
        throw new ProtocolError("bad_request", "Invalid capabilities");
    } else if (key === "clean" || key === "outcomeKnown") {
      if (typeof v !== "boolean")
        throw new ProtocolError("bad_request", "Invalid boolean field");
    } else if (key === "turnIndex") {
      if (!Number.isSafeInteger(v) || Number(v) < 0)
        throw new ProtocolError("bad_request", "Invalid turn index");
    } else if (key === "newLeafId" && v === null) {
    } else if (typeof v !== "string")
      throw new ProtocolError("bad_request", "Missing fact field " + key);
  }
  const allowed: Record<string, string[]> = {
    mode: ["normal", "steer", "followUp", "unclassified"],
    stage: [
      "awaiting-output",
      "thinking-output",
      "text-output",
      "tool-args-output",
      "tool-running",
      "waiting-user",
    ],
    timingBasis: ["observed", "unknown"],
    role: ["user", "assistant", "toolResult", "system"],
    sourceKind: ["execution", "session"],
    outcome: ["completed", "failed", "cancelled", "interrupted", "unknown"],
    relationKind: ["calls", "result-consumed", "sequence", "contains"],
  };
  for (const [key, values] of Object.entries(allowed))
    if (fact[key] !== undefined && !values.includes(String(fact[key])))
      throw new ProtocolError("bad_request", "Invalid fact " + key);
  if (
    fact.type === "span.started" &&
    !["llm", "tool"].includes(String(fact.kind))
  )
    throw new ProtocolError("bad_request", "Invalid span kind");
  if (
    fact.type === "input.applied" &&
    !["normal", "steer", "followUp", "unclassified"].includes(String(fact.kind))
  )
    throw new ProtocolError("bad_request", "Invalid input kind");
  for (const v of Object.values(event.refs))
    if (typeof v !== "string")
      throw new ProtocolError("bad_request", "Invalid refs");
}

export class Recorder {
  readonly db: Database.Database;
  readonly storeId: string;
  private listeners = new Set<() => void>();
  constructor(path: string) {
    this.db = new Database(path);
    this.db.defaultSafeIntegers(true);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    const exists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'")
      .get();
    if (!exists)
      this.db.transaction(() => {
        this.db.exec(
          readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
        );
        this.db
          .prepare("INSERT INTO schema_migrations VALUES (1, ?)")
          .run(Date.now());
        this.db
          .prepare("INSERT INTO store_metadata VALUES (1, ?, ?)")
          .run(randomUUID(), Date.now());
      })();
    const version = this.db
      .prepare("SELECT max(version) AS v FROM schema_migrations")
      .get() as { v: bigint };
    if (version.v !== 1n)
      throw new ProtocolError(
        "unsupported_schema",
        "Unsupported database schema",
      );
    this.storeId = (
      this.db.prepare("SELECT store_id FROM store_metadata").get() as {
        store_id: string;
      }
    ).store_id;
  }
  onCommit(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  getWatermark(): Cursor {
    return String(
      (
        this.db
          .prepare("SELECT coalesce(max(cursor),0) AS c FROM events")
          .get() as { c: bigint }
      ).c,
    );
  }
  registerProducer(producerId: string, sessionKey: string) {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO sessions(session_key,created_at,updated_at) VALUES (?,?,?)",
      )
      .run(sessionKey, now, now);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO producers(producer_id,session_key,state,last_seen_at) VALUES (?,?,'active',?)",
      )
      .run(producerId, sessionKey, now);
    const p = this.db
      .prepare(
        "SELECT session_key,last_acked_seq FROM producers WHERE producer_id=?",
      )
      .get(producerId) as { session_key: string; last_acked_seq: bigint };
    if (p.session_key !== sessionKey)
      throw new ProtocolError(
        "sequence_conflict",
        "Producer belongs to another session",
      );
    return Number(p.last_acked_seq);
  }
  appendBatch(batch: EventBatch): AppendAck {
    if (
      !batch ||
      typeof batch !== "object" ||
      typeof batch.producerId !== "string" ||
      !batch.producerId ||
      (batch.payloads !== undefined && !Array.isArray(batch.payloads))
    )
      throw new ProtocolError("bad_request", "Invalid batch");
    if (batch.protocolVersion !== 1)
      throw new ProtocolError("bad_request", "Unsupported protocol");
    if (batch.storeId !== this.storeId)
      throw new ProtocolError("store_changed", "Database identity changed");
    if (!Array.isArray(batch.events) || batch.events.length > 128)
      throw new ProtocolError("bad_request", "Invalid batch size");
    let inserted = false;
    const ack = this.db.transaction(() => {
      for (const p of batch.payloads ?? []) {
        if (
          !p ||
          typeof p.payloadId !== "string" ||
          typeof p.data !== "string" ||
          !["utf8", "base64"].includes(p.encoding) ||
          typeof p.mimeType !== "string" ||
          !p.completeness ||
          typeof p.completeness.truncated !== "boolean" ||
          Buffer.byteLength(p.data) > 16 * 1024 * 1024
        )
          throw new ProtocolError("bad_request", "Invalid payload");
        const bytes = Buffer.from(
          p.data,
          p.encoding === "base64" ? "base64" : "utf8",
        );
        const digest = createHash("sha256").update(bytes).digest("hex");
        const { data: _data, ...manifest } = p;
        const metadata = canonical(manifest);
        const old = this.db
          .prepare(
            "SELECT metadata_json,sha256 FROM payloads WHERE payload_id=?",
          )
          .get(p.payloadId) as
          { metadata_json: string; sha256: string } | undefined;
        if (old) {
          if (old.metadata_json !== metadata || old.sha256 !== digest)
            throw new ProtocolError(
              "sequence_conflict",
              "Payload is immutable",
            );
          continue;
        }
        this.db
          .prepare("INSERT INTO payloads VALUES (?,?,?,?,?,?,?)")
          .run(
            p.payloadId,
            digest,
            p.mimeType,
            bytes.length,
            p.completeness.truncated ? "truncated" : "complete",
            metadata,
            Date.now(),
          );
        for (
          let offset = 0, part = 0;
          offset < bytes.length;
          offset += 262144, part++
        )
          this.db
            .prepare("INSERT INTO payload_chunks VALUES (?,?,?)")
            .run(p.payloadId, part, bytes.subarray(offset, offset + 262144));
      }
      let last = 0;
      let cursor = "0";
      for (const event of batch.events) {
        validateEvent(event);
        if (
          event.schemaVersion !== 1 ||
          event.producerId !== batch.producerId ||
          !Number.isSafeInteger(event.producerSeq) ||
          event.producerSeq < 1 ||
          !event.eventId ||
          !event.sessionKey ||
          !event.fact ||
          !event.observedAt ||
          !Number.isFinite(event.observedAt.wallMs)
        )
          throw new ProtocolError("bad_request", "Invalid event envelope");
        for (const key of [
          "runId",
          "traceId",
          "turnId",
          "spanId",
          "toolCallId",
        ]) {
          const f = event.fact as unknown as Record<string, unknown>;
          const r = event.refs as Record<string, unknown>;
          if (f[key] !== undefined && r[key] !== undefined && f[key] !== r[key])
            throw new ProtocolError(
              "bad_request",
              "Inconsistent event identity",
            );
        }
        last = this.registerProducer(batch.producerId, event.sessionKey);
        const contentHash = hash(event);
        const old = this.db
          .prepare(
            "SELECT cursor,content_hash,event_id FROM events WHERE producer_id=? AND producer_seq=?",
          )
          .get(batch.producerId, event.producerSeq) as
          | { cursor: bigint; content_hash: string; event_id: string }
          | undefined;
        if (old) {
          if (
            old.content_hash !== contentHash ||
            old.event_id !== event.eventId
          )
            throw new ProtocolError(
              "sequence_conflict",
              "Sequence content changed",
            );
          cursor = String(old.cursor);
          continue;
        }
        if (event.producerSeq !== last + 1)
          throw new ProtocolError("sequence_gap", "Producer sequence gap", {
            expectedSeq: last + 1,
          });
        if (
          this.db
            .prepare("SELECT 1 FROM events WHERE event_id=?")
            .get(event.eventId)
        )
          throw new ProtocolError("sequence_conflict", "Event identity reused");
        const refs = payloadIds(event.fact);
        for (const id of refs)
          if (
            !this.db
              .prepare("SELECT 1 FROM payloads WHERE payload_id=?")
              .get(id)
          )
            throw new ProtocolError(
              "payload_missing",
              "Referenced payload not committed",
              { payloadId: id },
            );
        const result = this.db
          .prepare(
            "INSERT INTO events(event_id,producer_id,producer_seq,session_key,schema_version,kind,source,wall_ms,mono_ms,clock_id,received_at,refs_json,fact_json,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            event.eventId,
            event.producerId,
            event.producerSeq,
            event.sessionKey,
            event.schemaVersion,
            event.fact.type,
            event.source,
            event.observedAt.wallMs,
            event.observedAt.monoMs,
            event.observedAt.clockId,
            Date.now(),
            JSON.stringify(event.refs),
            JSON.stringify(event.fact),
            contentHash,
          );
        cursor = String(result.lastInsertRowid);
        for (const id of refs)
          this.db
            .prepare("INSERT INTO event_payloads VALUES (?,?)")
            .run(event.eventId, id);
        if (event.fact.type === "entry.archived") {
          const fact = event.fact;
          this.db
            .prepare(
              "INSERT OR IGNORE INTO source_entries VALUES (?,?,?,?,?,?,?)",
            )
            .run(
              event.sessionKey,
              fact.sourceEntryKey,
              fact.revisionHash,
              fact.parentId ?? null,
              fact.entryType ?? "unknown",
              fact.contentRef,
              parseCursor(cursor),
            );
        }
        if (event.fact.type === "entity.bound") {
          const fact = event.fact;
          this.db
            .prepare(
              "INSERT OR REPLACE INTO source_bindings VALUES (?,?,?,?,?)",
            )
            .run(
              event.sessionKey,
              fact.entryKey,
              fact.canonicalSpanId,
              JSON.stringify(fact.evidence),
              parseCursor(cursor),
            );
        }
        if (event.fact.type === "capture.stopped")
          this.db
            .prepare("UPDATE producers SET state='stopped' WHERE producer_id=?")
            .run(event.producerId);
        if (event.fact.type === "capture.gap" && event.fact.targetProducerId)
          this.db
            .prepare(
              "UPDATE producers SET state='disconnected' WHERE producer_id=?",
            )
            .run(event.fact.targetProducerId);
        last = event.producerSeq;
        this.db
          .prepare(
            "UPDATE producers SET last_acked_seq=?,last_seen_at=? WHERE producer_id=?",
          )
          .run(last, Date.now(), batch.producerId);
        this.db
          .prepare("UPDATE sessions SET updated_at=? WHERE session_key=?")
          .run(Date.now(), event.sessionKey);
        inserted = true;
      }
      if (inserted)
        for (const sessionKey of new Set(
          batch.events.map((e) => e.sessionKey),
        )) {
          const cached = this.db
            .prepare(
              "SELECT reducer_version,state_json,through_cursor FROM session_projections WHERE session_key=?",
            )
            .get(sessionKey) as
            | {
                reducer_version: bigint;
                state_json: string;
                through_cursor: bigint;
              }
            | undefined;
          if (!cached || cached.reducer_version !== 1n) {
            this.rebuildProjection(sessionKey);
            continue;
          }
          let state = JSON.parse(cached.state_json);
          let after = String(cached.through_cursor);
          const through = this.getWatermark();
          while (true) {
            const page = this.readPage({
              sessionKey,
              after,
              through,
              limit: 1000,
            });
            for (const event of page.events) state = reduce(state, event);
            after = page.nextAfter;
            if (page.done) break;
          }
          this.db
            .prepare(
              "INSERT OR REPLACE INTO session_projections VALUES (?,1,?,?)",
            )
            .run(sessionKey, parseCursor(after), JSON.stringify(state));
        }
      if (!batch.events.length) {
        const p = this.db
          .prepare("SELECT last_acked_seq FROM producers WHERE producer_id=?")
          .get(batch.producerId) as { last_acked_seq: bigint } | undefined;
        last = Number(p?.last_acked_seq ?? 0n);
      }
      const confirmed = this.db
        .prepare(
          "SELECT cursor FROM events WHERE producer_id=? AND producer_seq=?",
        )
        .get(batch.producerId, last) as { cursor: bigint } | undefined;
      return {
        producerId: batch.producerId,
        ackedThrough: last,
        lastCursor: confirmed ? String(confirmed.cursor) : cursor,
      };
    })();
    if (inserted)
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          /* Durable commit remains authoritative. */
        }
      }
    return ack;
  }
  readPage(q: {
    sessionKey: string;
    after: Cursor;
    through: Cursor;
    limit: number;
  }): EventPage {
    const after = parseCursor(q.after),
      through = parseCursor(q.through);
    if (through > parseCursor(this.getWatermark()))
      throw new ProtocolError(
        "cursor_invalid",
        "Cursor is beyond store watermark",
      );
    if (after > through)
      throw new ProtocolError("cursor_invalid", "after exceeds through");
    const limit = Math.min(1000, Math.max(1, Math.floor(q.limit)));
    if (!Number.isFinite(limit))
      throw new ProtocolError("bad_request", "Invalid page limit");
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE session_key=? AND cursor>? AND cursor<=? ORDER BY cursor LIMIT ?",
      )
      .all(q.sessionKey, after, through, limit + 1) as Record<
      string,
      unknown
    >[];
    const done = rows.length <= limit;
    const events = rows.slice(0, limit).map(
      (r) =>
        ({
          schemaVersion: Number(r.schema_version),
          eventId: r.event_id,
          producerId: r.producer_id,
          producerSeq: Number(r.producer_seq),
          sessionKey: r.session_key,
          source: r.source,
          observedAt: {
            wallMs: Number(r.wall_ms),
            monoMs: r.mono_ms === null ? null : Number(r.mono_ms),
            clockId: r.clock_id,
          },
          refs: JSON.parse(String(r.refs_json)),
          fact: JSON.parse(String(r.fact_json)),
          cursor: String(r.cursor),
          receivedAt: Number(r.received_at),
        }) as StoredEvent,
    );
    return {
      events,
      nextAfter: events.at(-1)?.cursor ?? q.after,
      through: q.through,
      done,
    };
  }
  listSessions() {
    return this.db
      .prepare(
        "SELECT session_key AS sessionKey,created_at AS createdAt,updated_at AS updatedAt,name,(SELECT count(*) FROM events WHERE events.session_key=sessions.session_key) AS eventCount FROM sessions ORDER BY updated_at DESC",
      )
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          ...r,
          createdAt: Number(r.createdAt),
          updatedAt: Number(r.updatedAt),
          eventCount: Number(r.eventCount),
        };
      });
  }
  readPayload(q: {
    payloadId: string;
    sessionKey: string;
    asOf: Cursor;
    offset?: number;
    limit?: number;
  }) {
    const asOf = parseCursor(q.asOf);
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM event_payloads ep JOIN events e ON ep.event_id=e.event_id WHERE ep.payload_id=? AND e.session_key=? AND e.cursor<=?",
        )
        .get(q.payloadId, q.sessionKey, asOf)
    )
      throw new ProtocolError(
        "payload_missing",
        "Payload not visible at requested cursor",
      );
    const r = this.db
      .prepare("SELECT * FROM payloads WHERE payload_id=?")
      .get(q.payloadId) as Record<string, unknown>;
    const offset = Math.max(0, q.offset ?? 0),
      limit = Math.min(262144, Math.max(1, q.limit ?? 65536));
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit))
      throw new ProtocolError("bad_request", "Invalid byte range");
    const chunks = this.db
      .prepare(
        "SELECT bytes FROM payload_chunks WHERE payload_id=? AND part>=? AND part<=? ORDER BY part",
      )
      .all(
        q.payloadId,
        Math.floor(offset / 262144),
        Math.floor((offset + limit - 1) / 262144),
      ) as { bytes: Buffer }[];
    const bytes = Buffer.concat(chunks.map((c) => c.bytes)).subarray(
      offset % 262144,
      (offset % 262144) + limit,
    );
    const metadata = JSON.parse(String(r.metadata_json));
    return {
      payloadId: q.payloadId,
      mimeType: r.mime_type,
      sha256: r.sha256,
      byteLength: Number(r.byte_length),
      completeness: metadata.completeness,
      encoding: "base64",
      data: bytes.toString("base64"),
      offset,
      nextOffset: offset + bytes.length,
      done: offset + bytes.length >= Number(r.byte_length),
    };
  }
  producerConnected(producerId: string) {
    this.db
      .prepare(
        "UPDATE producers SET state='active',last_seen_at=? WHERE producer_id=? AND state!='stopped'",
      )
      .run(Date.now(), producerId);
  }
  activeProducers() {
    return this.db
      .prepare(
        "SELECT producer_id AS producerId,session_key AS sessionKey FROM producers WHERE state='active' AND producer_id NOT LIKE 'observer-service:%'",
      )
      .all() as { producerId: string; sessionKey: string }[];
  }
  recordProducerDisconnect(producerId: string, instanceId: string) {
    const target = this.db
      .prepare("SELECT session_key,state FROM producers WHERE producer_id=?")
      .get(producerId) as { session_key: string; state: string } | undefined;
    if (!target || target.state !== "active") return;
    const observerId =
      "observer-service:" + instanceId + ":" + target.session_key;
    const seq = this.registerProducer(observerId, target.session_key) + 1;
    this.appendBatch({
      protocolVersion: 1,
      storeId: this.storeId,
      producerId: observerId,
      events: [
        {
          schemaVersion: 1,
          eventId: randomUUID(),
          producerId: observerId,
          producerSeq: seq,
          sessionKey: target.session_key,
          source: "observer",
          observedAt: { wallMs: Date.now(), monoMs: null, clockId: null },
          refs: {},
          fact: {
            type: "capture.gap",
            scope: "producer",
            targetProducerId: producerId,
            reason: "采集连接失联，执行终点未知",
          },
        },
      ],
    });
  }
  rebuildProjection(sessionKey: string) {
    let after = "0";
    const through = this.getWatermark();
    const events: StoredEvent[] = [];
    while (true) {
      const page = this.readPage({ sessionKey, after, through, limit: 1000 });
      events.push(...page.events);
      after = page.nextAfter;
      if (page.done) break;
    }
    const state = replay(events);
    if (events.length)
      this.db
        .prepare("INSERT OR REPLACE INTO session_projections VALUES (?,1,?,?)")
        .run(sessionKey, parseCursor(after), JSON.stringify(state));
    return state;
  }
  close() {
    this.listeners.clear();
    this.db.close();
  }
}
