import { messageText } from "../capture/text.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { CaptureItem } from "../capture/queue.js";
import { snapshotPayload } from "../capture/payload.js";
export type SourceEntry = {
  id: string;
  parentId?: string | null;
  type: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    stopReason?: string;
    model?: string;
  };
  [key: string]: unknown;
};
export type ImportReport = {
  imported: number;
  skipped: number;
  badLines: number;
  incompleteTail: boolean;
  warnings: string[];
  status: "complete" | "unsupported-version" | "invalid-header";
  sessionKey?: string;
};
export type SessionIdentity = { sessionKey: string };
export const sourceEntryKey = (sessionKey: string, id: string) =>
  `${sessionKey}:${id}`;
export const importedSpanId = (sessionKey: string, id: string) =>
  "import:" +
  createHash("sha256").update(sourceEntryKey(sessionKey, id)).digest("hex");
/** Incremental revision archive. Does not infer durations from entry timestamps. */
export class SessionImporter {
  private revisions = new Set<string>();
  private entries = new Map<string, SourceEntry>();
  private traces = new Set<string>();
  private turns = new Set<string>();
  constructor(private readonly emit: (item: CaptureItem) => boolean | void) {}
  ingestEntries(
    session: SessionIdentity,
    entries: readonly SourceEntry[],
    options: { liveBindings?: ReadonlyMap<string, string> } = {},
  ): ImportReport {
    const report: ImportReport = {
      imported: 0,
      skipped: 0,
      badLines: 0,
      incompleteTail: false,
      warnings: [],
      status: "complete",
      sessionKey: session.sessionKey,
    };
    for (const entry of entries)
      this.entries.set(sourceEntryKey(session.sessionKey, entry.id), entry);
    for (const entry of entries) {
      const raw = JSON.stringify(entry);
      const revisionHash = createHash("sha256").update(raw).digest("hex");
      const key = sourceEntryKey(session.sessionKey, entry.id);
      const revision = key + ":" + revisionHash;
      if (this.revisions.has(revision)) {
        report.skipped++;
        continue;
      }
      const observedAt = {
        wallMs: Number.isFinite(Date.parse(entry.timestamp ?? ""))
          ? Date.parse(entry.timestamp!)
          : 0,
        monoMs: null,
        clockId: null,
      };
      const payload = snapshotPayload(entry, "pi-import");
      const refs = { sourceEntryId: entry.id };
      const accepted = this.emit({
        source: "pi-import",
        observedAt,
        refs,
        payloads: [payload],
        fact: {
          type: "entry.archived",
          sourceEntryKey: key,
          parentId: entry.parentId ?? null,
          revisionHash,
          contentRef: payload.payloadId,
          entryType: entry.type,
        },
      });
      if (accepted === false) {
        report.warnings.push("archive queue rejected " + entry.id);
        continue;
      }
      this.revisions.add(revision);
      report.imported++;
      if (
        entry.parentId &&
        !this.entries.has(sourceEntryKey(session.sessionKey, entry.parentId))
      )
        report.warnings.push("missing parent " + entry.parentId);
      let ancestor: SourceEntry | undefined = entry;
      const chain = new Set<string>();
      while (ancestor) {
        if (chain.has(ancestor.id)) {
          report.warnings.push("parent cycle " + entry.id);
          break;
        }
        chain.add(ancestor.id);
        ancestor = ancestor.parentId
          ? this.entries.get(
              sourceEntryKey(session.sessionKey, ancestor.parentId),
            )
          : undefined;
      }
      const message = entry.message;
      const live = options.liveBindings?.get(entry.id);
      if (entry.type !== "message" || !message) continue;
      if (message.role === "assistant" || message.role === "toolResult") {
        // Native parent chains group content by the nearest user input and assistant response;
        // this expresses inclusion only and never invents execution time or parallelism.
        let cursor: SourceEntry | undefined = entry;
        let user: SourceEntry | undefined;
        let assistantEntry: SourceEntry | undefined =
          message.role === "assistant" ? entry : undefined;
        const visited = new Set<string>();
        while (cursor && !visited.has(cursor.id)) {
          visited.add(cursor.id);
          if (cursor.message?.role === "user") {
            user = cursor;
            break;
          }
          if (!assistantEntry && cursor.message?.role === "assistant")
            assistantEntry = cursor;
          cursor = cursor.parentId
            ? this.entries.get(
                sourceEntryKey(session.sessionKey, cursor.parentId),
              )
            : undefined;
        }
        const traceId =
          "history-trace:" +
          createHash("sha256")
            .update(
              sourceEntryKey(session.sessionKey, user?.id ?? "unclassified"),
            )
            .digest("hex");
        const runId = "history-run:" + traceId;
        const turnId =
          "history-turn:" +
          sourceEntryKey(session.sessionKey, assistantEntry?.id ?? entry.id);
        if (!live && !this.traces.has(traceId)) {
          this.traces.add(traceId);
          const input = snapshotPayload(
            user?.message ?? { unclassified: true },
            "pi-import",
          );
          this.emit({
            source: "pi-import",
            observedAt,
            refs: { traceId },
            payloads: [input],
            fact: {
              type: "input.applied",
              traceId,
              kind: "unclassified",
              entryId: user?.id,
              contentRef: input.payloadId,
              label: user
                ? messageText(user.message).slice(0, 100) || "历史问题"
                : "历史内容（输入归属未知）",
            },
          });
        }
        if (!live && !this.turns.has(turnId)) {
          this.turns.add(turnId);
          this.emit({
            source: "pi-import",
            observedAt,
            refs: { traceId, turnId, runId },
            fact: { type: "turn.started", turnId, runId, turnIndex: 0 },
          });
          this.emit({
            source: "pi-import",
            observedAt,
            refs: { traceId, turnId, runId },
            fact: { type: "turn.ended", turnId, runId, turnIndex: 0 },
          });
        }
        const spanId = live ?? importedSpanId(session.sessionKey, entry.id);
        const spanRefs = {
          ...refs,
          ...(!live ? { traceId, turnId, runId } : {}),
          spanId,
          ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        };
        if (!live) {
          this.emit({
            source: "pi-import",
            observedAt,
            refs: spanRefs,
            fact: {
              type: "span.started",
              spanId,
              kind: message.role === "assistant" ? "llm" : "tool",
              name:
                message.role === "assistant"
                  ? "历史模型响应"
                  : (message.toolName ?? "历史工具"),
              timingBasis: "unknown",
              model: message.model,
            },
          });
          this.emit({
            source: "pi-import",
            observedAt,
            refs: spanRefs,
            fact: {
              type: "span.ended",
              spanId,
              outcome:
                message.isError || message.stopReason === "error"
                  ? "failed"
                  : message.stopReason === "aborted"
                    ? "cancelled"
                    : "completed",
              contentRef: payload.payloadId,
            },
          });
        }
        this.emit({
          source: "pi-import",
          observedAt,
          refs: spanRefs,
          fact: {
            type: "message.finalized",
            messageKey: key + ":" + revisionHash,
            role: message.role,
            contentRef: payload.payloadId,
            sourceKind: "session",
          },
        });
        if (
          !live &&
          message.role === "toolResult" &&
          assistantEntry &&
          message.toolCallId &&
          Array.isArray(assistantEntry.message?.content) &&
          assistantEntry.message.content.some(
            (block: any) =>
              block?.type === "toolCall" && block.id === message.toolCallId,
          )
        )
          this.emit({
            source: "pi-import",
            observedAt,
            refs: spanRefs,
            fact: {
              type: "relation.observed",
              from: importedSpanId(session.sessionKey, assistantEntry.id),
              to: spanId,
              relationKind: "calls",
              evidence:
                "native assistant toolCall ID and toolResult toolCallId",
            },
          });
        this.emit({
          source: "pi-import",
          observedAt,
          refs: spanRefs,
          fact: {
            type: "entity.bound",
            canonicalSpanId: spanId,
            entryKey: key,
            evidence: live
              ? "turn_end explicit entry ID"
              : "native session entry",
          },
        });
      }
    }
    return report;
  }
  async *importSession(input: {
    path: string;
    namespace?: string;
  }): AsyncGenerator<ImportReport> {
    let pending = Buffer.alloc(0);
    let header: { type?: string; version?: number; id?: string } | undefined;
    let sessionKey = "";
    const total: ImportReport = {
      imported: 0,
      skipped: 0,
      badLines: 0,
      incompleteTail: false,
      warnings: [],
      status: "complete",
    };
    for await (const chunk of createReadStream(input.path)) {
      pending = Buffer.concat([
        pending,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      let end: number;
      while ((end = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, end).toString("utf8").trim();
        pending = pending.subarray(end + 1);
        if (!line) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          total.badLines++;
          continue;
        }
        if (!header) {
          header = value as { type?: string; version?: number; id?: string };
          if (header?.type !== "session" || typeof header.id !== "string") {
            total.status = "invalid-header";
            yield total;
            return;
          }
          if (header.version !== 3) {
            total.status = "unsupported-version";
            yield total;
            return;
          }
          sessionKey = `${input.namespace ?? "pi"}:${header.id}`;
          total.sessionKey = sessionKey;
          continue;
        }
        const entry = value as SourceEntry;
        if (typeof entry.id !== "string" || typeof entry.type !== "string") {
          total.badLines++;
          continue;
        }
        const result = this.ingestEntries({ sessionKey }, [entry]);
        total.imported += result.imported;
        total.skipped += result.skipped;
        total.warnings.push(...result.warnings);
      }
      yield { ...total, warnings: [...total.warnings] };
    }
    total.incompleteTail = pending.length > 0;
    if (!header) total.status = "invalid-header";
    yield { ...total, warnings: [...total.warnings] };
  }
}
export function reconcileTurn(
  boundary: { messageEntryId?: string; toolResultEntryIds?: readonly string[] },
  manager: { getEntry(id: string): SourceEntry | undefined },
  assistantSpanId: string | undefined,
  tools: ReadonlyMap<string, string>,
): {
  entries: SourceEntry[];
  bindings: Map<string, string>;
  warnings: string[];
} {
  const entries: SourceEntry[] = [];
  const bindings = new Map<string, string>();
  const warnings: string[] = [];
  for (const id of [
    boundary.messageEntryId,
    ...(boundary.toolResultEntryIds ?? []),
  ]) {
    if (!id) continue;
    const entry = manager.getEntry(id);
    if (!entry || entry.type !== "message") {
      warnings.push("unresolved turn entry " + id);
      continue;
    }
    entries.push(entry);
    if (
      id === boundary.messageEntryId &&
      entry.message?.role === "assistant" &&
      assistantSpanId
    )
      bindings.set(id, assistantSpanId);
    else if (entry.message?.role === "toolResult" && entry.message.toolCallId) {
      const span = tools.get(entry.message.toolCallId);
      if (span) bindings.set(id, span);
    }
  }
  return { entries, bindings, warnings };
}
