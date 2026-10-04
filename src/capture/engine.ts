import { messageText } from "./text.js";
import { randomUUID } from "node:crypto";
import type { Fact, ObservedTime, Refs, Stage } from "../model/index.js";
import {
  SessionImporter,
  reconcileTurn,
  type SourceEntry,
} from "../importer/index.js";
import { CaptureQueue, type FlushReport } from "./queue.js";
import { snapshotPayload } from "./payload.js";
export type PiObservation = {
  type: string;
  message?: {
    role?: string;
    content?: unknown;
    stopReason?: string;
    model?: string;
    toolCallId?: string;
  };
  assistantMessageEvent?: { type: string; contentIndex?: number };
  turnIndex?: number;
  text?: string;
  streamingBehavior?: "steer" | "followUp";
  toolCallId?: string;
  parentToolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  messageEntryId?: string;
  toolResultEntryIds?: string[];
  oldLeafId?: string | null;
  newLeafId?: string | null;
};
export type CaptureOptions = {
  sessionKey: string;
  queue: CaptureQueue;
  getEntry: (id: string) => SourceEntry | undefined;
  getLeafId?: () => string | null;
  clock?: () => ObservedTime;
  leafId?: string;
  reason?: string;
};
/** Synchronous official-event state machine. Observer failures never affect agent control flow. */
export class CaptureEngine {
  private runId?: string;
  private traceId?: string;
  private continuationTraceId?: string;
  private turnId?: string;
  private assistant?: string;
  private turnAssistants: string[] = [];
  private tools = new Map<string, string>();
  private declaredTools = new Set<string>();
  private stages = new Map<string, string>();
  private stopped = false;
  private importer: SessionImporter;
  private clockId = randomUUID();
  private activeRun = false;
  constructor(private readonly options: CaptureOptions) {
    this.importer = new SessionImporter((item) => options.queue.offer(item));
    this.emit({
      type: "capture.started",
      reason: options.reason ?? "session_start",
      leafId: options.leafId,
      capabilities: {
        observedStages: true,
        turnEntryBinding: true,
        inputAttribution: [],
        providerAttemptIdentity: "unavailable",
        clockDomains: [this.clockId],
      },
    });
  }
  private now() {
    return (
      this.options.clock?.() ?? {
        wallMs: Date.now(),
        monoMs: performance.now(),
        clockId: this.clockId,
      }
    );
  }
  private refs(extra: Refs = {}): Refs {
    return {
      ...(this.runId ? { runId: this.runId } : {}),
      ...(this.traceId ? { traceId: this.traceId } : {}),
      ...(this.turnId ? { turnId: this.turnId } : {}),
      ...extra,
    };
  }
  private emit(fact: Fact, extra: Refs = {}, value?: unknown) {
    const payload = value === undefined ? undefined : snapshotPayload(value);
    const withContent = payload
      ? {
          ...fact,
          ...("contentRef" in fact ||
          fact.type === "span.ended" ||
          fact.type === "input.submitted" ||
          fact.type === "input.applied"
            ? { contentRef: payload.payloadId }
            : fact.type === "span.started"
              ? { inputRef: payload.payloadId }
              : {}),
        }
      : fact;
    return this.options.queue.offer({
      fact: withContent as Fact,
      observedAt: this.now(),
      refs: this.refs(extra),
      payloads: payload ? [payload] : [],
    });
  }
  private stage(spanId: string, stage: Stage, index?: number) {
    const key = stage + ":" + (index ?? "");
    if (this.stages.get(spanId) === key) return;
    this.stages.set(spanId, key);
    this.emit(
      {
        type: "span.stage_changed",
        spanId,
        stage,
        ...(index === undefined ? {} : { contentIndex: index }),
      },
      { spanId },
    );
  }
  archive(entries: readonly SourceEntry[]) {
    return this.importer.ingestEntries(
      { sessionKey: this.options.sessionKey },
      entries,
    );
  }
  accept(event: PiObservation): void {
    if (this.stopped) return;
    try {
      switch (event.type) {
        case "input":
          this.emit(
            {
              type: "input.submitted",
              submissionId: randomUUID(),
              mode: event.streamingBehavior ?? "normal",
            },
            {},
            { text: event.text ?? "" },
          );
          break;
        case "agent_start":
          // Pi emits agent_start → turn_start before new user messages. A continue
          // emits no user message: defer the prior question binding until assistant start.
          this.continuationTraceId = this.traceId;
          this.traceId = undefined;
          this.turnId = undefined;
          this.assistant = undefined;
          this.runId = randomUUID();
          this.activeRun = true;
          this.tools.clear();
          this.emit({ type: "run.started", runId: this.runId });
          break;
        case "turn_start":
          this.turnId = `${this.runId ?? "unknown"}:${event.turnIndex ?? 0}`;
          this.turnAssistants = [];
          this.assistant = undefined;
          this.tools.clear();
          this.declaredTools.clear();
          this.emit({
            type: "turn.started",
            turnId: this.turnId,
            runId: this.runId ?? "unknown",
            turnIndex: event.turnIndex ?? 0,
          });
          break;
        case "message_start":
          if (event.message?.role === "user") {
            // Public input events lack consumption IDs. Do not guess steer/followUp from text or position.
            this.traceId = randomUUID();
            this.continuationTraceId = undefined;
            this.emit(
              {
                type: "input.applied",
                traceId: this.traceId,
                kind: "unclassified",
                label: messageText(event.message).slice(0, 100) || "用户问题",
              },
              {},
              event.message,
            );
          } else if (event.message?.role === "assistant") {
            this.traceId ??= this.continuationTraceId;
            this.assistant = randomUUID();
            this.turnAssistants.push(this.assistant);
            this.emit(
              {
                type: "span.started",
                spanId: this.assistant,
                kind: "llm",
                name: "模型响应",
                scope: "assistant-message",
                timingBasis: "observed",
                model: event.message.model,
              },
              { spanId: this.assistant },
            );
            this.stage(this.assistant, "awaiting-output");
          }
          break;
        case "message_update":
          if (this.assistant) {
            const update = event.assistantMessageEvent;
            const type = update?.type ?? "";
            if (type.startsWith("thinking_"))
              this.stage(
                this.assistant,
                "thinking-output",
                update?.contentIndex,
              );
            else if (type.startsWith("text_"))
              this.stage(this.assistant, "text-output", update?.contentIndex);
            else if (type.startsWith("toolcall_"))
              this.stage(
                this.assistant,
                "tool-args-output",
                update?.contentIndex,
              );
          }
          break;
        case "message_end":
          if (event.message?.role === "assistant" && this.assistant) {
            if (Array.isArray(event.message.content))
              for (const block of event.message.content) {
                if (block?.type === "toolCall" && typeof block.id === "string")
                  this.declaredTools.add(block.id);
              }
            this.emit(
              {
                type: "span.ended",
                spanId: this.assistant,
                outcome:
                  event.message.stopReason === "error"
                    ? "failed"
                    : event.message.stopReason === "aborted"
                      ? "cancelled"
                      : "completed",
              },
              { spanId: this.assistant },
              event.message,
            );
            const payload = snapshotPayload(event.message);
            this.options.queue.offer({
              fact: {
                type: "message.finalized",
                messageKey: randomUUID(),
                role: "assistant",
                contentRef: payload.payloadId,
                sourceKind: "execution",
              },
              observedAt: this.now(),
              refs: this.refs({ spanId: this.assistant }),
              payloads: [payload],
            });
          }
          break;
        case "tool_execution_start":
          if (event.toolCallId) {
            const spanId = randomUUID();
            this.tools.set(event.toolCallId, spanId);
            this.emit(
              {
                type: "span.started",
                spanId,
                kind: "tool",
                name: event.toolName ?? "工具",
                timingBasis: "observed",
              },
              { spanId, toolCallId: event.toolCallId },
              event.args,
            );
            this.stage(spanId, "tool-running");
            const parent = event.parentToolCallId
              ? this.tools.get(event.parentToolCallId)
              : this.declaredTools.has(event.toolCallId)
                ? this.assistant
                : undefined;
            if (parent)
              this.emit({
                type: "relation.observed",
                from: parent,
                to: spanId,
                relationKind: "calls",
                evidence: event.parentToolCallId
                  ? "public parentToolCallId"
                  : "tool execution in assistant turn",
              });
          }
          break;
        case "tool_execution_end":
          if (event.toolCallId) {
            const spanId = this.tools.get(event.toolCallId);
            if (spanId)
              this.emit(
                {
                  type: "span.ended",
                  spanId,
                  outcome: event.isError ? "failed" : "completed",
                },
                { spanId, toolCallId: event.toolCallId },
                event.result,
              );
            else
              this.emit({
                type: "capture.gap",
                scope: "tool",
                reason: "tool result without observed start",
              });
          }
          break;
        case "turn_end": {
          const result = reconcileTurn(
            event,
            { getEntry: this.options.getEntry },
            this.turnAssistants.length === 1
              ? this.turnAssistants[0]
              : undefined,
            this.tools,
          );
          const ancestors = new Map(
            result.entries.map((entry) => [entry.id, entry]),
          );
          for (const entry of result.entries) {
            let parent = entry.parentId;
            const visited = new Set<string>();
            while (parent && !visited.has(parent)) {
              visited.add(parent);
              const ancestor = this.options.getEntry(parent);
              if (!ancestor) break;
              ancestors.set(ancestor.id, ancestor);
              parent = ancestor.parentId;
            }
          }
          this.importer.ingestEntries(
            { sessionKey: this.options.sessionKey },
            [...ancestors.values()],
            { liveBindings: result.bindings },
          );
          if (this.options.getLeafId)
            this.emit({
              type: "branch.selected",
              newLeafId: this.options.getLeafId(),
            });
          for (const warning of result.warnings)
            this.emit({
              type: "capture.gap",
              scope: "association",
              reason: warning,
            });
          this.emit({
            type: "turn.ended",
            turnId: this.turnId ?? "unknown",
            runId: this.runId ?? "unknown",
            turnIndex: event.turnIndex ?? 0,
          });
          break;
        }
        case "agent_end":
          if (this.runId) this.emit({ type: "run.ended", runId: this.runId });
          this.activeRun = false;
          break;
        case "agent_settled":
          this.emit({
            type: "run.settled",
            runId: this.runId,
            outcomeKnown: false,
          });
          break;
        case "session_tree":
          this.emit({
            type: "branch.selected",
            oldLeafId: event.oldLeafId,
            newLeafId: event.newLeafId ?? null,
          });
          break;
      }
    } catch (error) {
      try {
        this.emit({
          type: "capture.gap",
          scope: "adapter",
          reason: "observation failed: " + String(error),
        });
      } catch {
        /* Never let observer failures escape into Pi. */
      }
    }
  }
  recordGap(reason: string, counts?: Record<string, number>) {
    try {
      this.emit({ type: "capture.gap", scope: "producer", reason, counts });
    } catch {}
  }
  health() {
    return this.options.queue.health();
  }
  async stop(reason: string, deadlineMs = 2000): Promise<FlushReport> {
    if (!this.stopped) {
      this.emit({ type: "capture.stopped", reason, clean: !this.activeRun });
      this.stopped = true;
    }
    const result = await this.options.queue.flush(deadlineMs);
    this.options.queue.close();
    return result;
  }
}
