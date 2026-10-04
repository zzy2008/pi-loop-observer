import { randomUUID } from "node:crypto";
import type {
  EventDraft,
  Fact,
  ObservedTime,
  PayloadInput,
  Refs,
  Source,
} from "../model/index.js";
export type CaptureItem = {
  fact: Fact;
  observedAt: ObservedTime;
  refs?: Refs;
  source?: Source;
  payloads?: PayloadInput[];
};
export type QueueBatch = {
  producerId: string;
  events: EventDraft[];
  payloads: PayloadInput[];
};
export type QueueAck = { producerId: string; ackedThrough: number };
export type FlushReport = {
  pending: number;
  ackedThrough: number;
  lostCount: number;
  timedOut: boolean;
};
export type QueueOptions = {
  producerId: string;
  sessionKey: string;
  send: (batch: QueueBatch, signal: AbortSignal) => Promise<QueueAck>;
  maxBytes?: number;
  maxEvents?: number;
  batchEvents?: number;
  batchBytes?: number;
  retryMs?: number;
  autoFlushMs?: number;
};
type Pending = { event: EventDraft; payloads: PayloadInput[]; bytes: number };
/** Owns immutable durable facts until the receiver acknowledges a committed prefix. */
export class CaptureQueue {
  private items: Pending[] = [];
  private bytes = 0;
  private seq = 0;
  private acked = 0;
  private lost = 0;
  private gapLost = 0;
  private inflight?: Promise<void>;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  private lastError?: string;
  constructor(private readonly options: QueueOptions) {
    if (options.autoFlushMs !== 0) {
      this.timer = setInterval(() => {
        void this.pump();
      }, options.autoFlushMs ?? 50);
      this.timer.unref();
    }
  }
  offer(item: CaptureItem): boolean {
    if (this.closed) return false;
    // Snapshot before returning to Pi; mutable message/payload references never enter the outbox.
    let copied: CaptureItem;
    try {
      copied = JSON.parse(JSON.stringify(item)) as CaptureItem;
    } catch {
      this.lost++;
      this.gapLost++;
      return false;
    }
    const candidate = this.prepare(copied, this.seq + 1);
    const reserve = Math.min(
      2048,
      Math.floor((this.options.maxBytes ?? 8 * 1024 * 1024) / 4),
    );
    if (
      this.items.length >= (this.options.maxEvents ?? 4096) - 1 ||
      this.bytes + candidate.bytes >
        (this.options.maxBytes ?? 8 * 1024 * 1024) - reserve ||
      candidate.bytes > (this.options.batchBytes ?? 1024 * 1024)
    ) {
      this.lost++;
      this.gapLost++;
      return false;
    }
    this.seq++;
    this.items.push(candidate);
    this.bytes += candidate.bytes;
    return true;
  }
  private prepare(item: CaptureItem, seq: number): Pending {
    const event: EventDraft = {
      schemaVersion: 1,
      eventId: randomUUID(),
      producerId: this.options.producerId,
      producerSeq: seq,
      sessionKey: this.options.sessionKey,
      source: item.source ?? "pi-live",
      observedAt: item.observedAt,
      refs: item.refs ?? {},
      fact: item.fact,
    };
    const payloads = item.payloads ?? [];
    return {
      event,
      payloads,
      bytes: Buffer.byteLength(JSON.stringify({ event, payloads })),
    };
  }
  private insertGap(): void {
    if (!this.gapLost) return;
    const gap = this.prepare(
      {
        fact: {
          type: "capture.gap",
          scope: "producer",
          reason: "bounded queue overflow",
          counts: { lostFacts: this.gapLost },
        },
        observedAt: { wallMs: Date.now(), monoMs: null, clockId: null },
        source: "observer",
      },
      this.seq + 1,
    );
    if (
      this.bytes + gap.bytes > (this.options.maxBytes ?? 8 * 1024 * 1024) ||
      this.items.length >= (this.options.maxEvents ?? 4096)
    )
      return;
    this.seq++;
    this.items.push(gap);
    this.bytes += gap.bytes;
    this.gapLost = 0;
  }
  private pump(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.closed) return Promise.resolve();
    this.insertGap();
    if (!this.items.length) return Promise.resolve();
    let bytes = 0;
    const selected: Pending[] = [];
    for (const item of this.items) {
      if (
        selected.length >= (this.options.batchEvents ?? 128) ||
        bytes + item.bytes > (this.options.batchBytes ?? 1024 * 1024)
      )
        break;
      selected.push(item);
      bytes += item.bytes;
    }
    if (!selected.length) return Promise.resolve();
    const batch = JSON.parse(
      JSON.stringify({
        producerId: this.options.producerId,
        events: selected.map((x) => x.event),
        payloads: selected.flatMap((x) => x.payloads),
      }),
    ) as QueueBatch;
    this.controller = new AbortController();
    this.inflight = (async () => {
      try {
        const ack = await this.options.send(batch, this.controller!.signal);
        const upper = selected.at(-1)!.event.producerSeq;
        if (
          ack.producerId !== this.options.producerId ||
          !Number.isSafeInteger(ack.ackedThrough) ||
          ack.ackedThrough < this.acked ||
          ack.ackedThrough > upper
        )
          throw new Error("Invalid durable acknowledgement");
        this.acked = ack.ackedThrough;
        while (this.items[0] && this.items[0].event.producerSeq <= this.acked) {
          this.bytes -= this.items.shift()!.bytes;
        }
        this.lastError = undefined;
      } catch (error) {
        this.lastError = String(error);
      } finally {
        this.inflight = undefined;
        this.controller = undefined;
      }
    })();
    return this.inflight;
  }
  async flush(deadlineMs = 2000): Promise<FlushReport> {
    const deadline = Date.now() + Math.max(0, deadlineMs);
    while (
      (this.items.length || this.gapLost) &&
      Date.now() < deadline &&
      !this.closed
    ) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.pump(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (this.lastError)
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(
              this.options.retryMs ?? 100,
              Math.max(0, deadline - Date.now()),
            ),
          ),
        );
    }
    return {
      ...this.health(),
      timedOut: !!(this.items.length || this.gapLost),
    };
  }
  health() {
    return {
      pending: this.items.length,
      ackedThrough: this.acked,
      lostCount: this.lost,
      degraded: !!this.lastError || this.lost > 0,
      lastError: this.lastError,
      bytes: this.bytes,
    };
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.controller?.abort();
  }
}
