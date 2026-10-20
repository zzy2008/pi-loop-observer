/** Pure, append-only observation model shared by capture, recorder and browser. */
export type Cursor = string;
export type Source = "pi-live" | "pi-import" | "observer";
export type ObservedTime = {
  wallMs: number;
  monoMs: number | null;
  clockId: string | null;
};
export type Refs = {
  runId?: string;
  traceId?: string;
  turnId?: string;
  spanId?: string;
  sourceEntryId?: string;
  toolCallId?: string;
};
export type PayloadInput = {
  payloadId: string;
  mimeType: string;
  encoding: "utf8" | "base64";
  data: string;
  source: Source;
  completeness: { truncated: boolean; reason?: string };
};
export type PayloadRef = string;
export type SpanState =
  "running" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown";
export type Stage =
  | "awaiting-output"
  | "thinking-output"
  | "text-output"
  | "tool-args-output"
  | "tool-running"
  | "waiting-user";
export type Capabilities = {
  observedStages?: boolean;
  turnEntryBinding?: boolean;
  inputAttribution?: string[];
  providerAttemptIdentity?: "unavailable" | "available";
  clockDomains?: string[];
};
export type Fact =
  | {
      type: "capture.started";
      reason: string;
      capabilities: Capabilities;
      leafId?: string;
    }
  | {
      type: "input.submitted";
      submissionId: string;
      mode: "normal" | "steer" | "followUp" | "unclassified";
      contentRef?: PayloadRef;
    }
  | {
      type: "input.applied";
      submissionId?: string;
      traceId: string;
      entryId?: string;
      kind: "normal" | "steer" | "followUp" | "unclassified";
      contentRef?: PayloadRef;
      label?: string;
    }
  | { type: "run.started"; runId: string }
  | { type: "run.ended"; runId: string; outcome?: SpanState }
  | {
      type: "turn.started" | "turn.ended";
      turnId: string;
      runId: string;
      turnIndex: number;
    }
  | {
      type: "span.started";
      spanId: string;
      kind: "llm" | "tool";
      name: string;
      scope?: string;
      timingBasis: "observed" | "unknown";
      inputRef?: PayloadRef;
      model?: string;
    }
  | {
      type: "span.stage_changed";
      spanId: string;
      stage: Stage;
      contentIndex?: number;
    }
  | {
      type: "span.ended";
      spanId: string;
      outcome: Exclude<SpanState, "running">;
      contentRef?: PayloadRef;
      /** Public SDK tool execution duration, when supplied by the host. */
      durationMs?: number;
    }
  | {
      type: "message.finalized";
      messageKey: string;
      role: "user" | "assistant" | "toolResult" | "system";
      contentRef: PayloadRef;
      sourceKind: "execution" | "session";
    }
  | {
      type: "entry.archived";
      sourceEntryKey: string;
      parentId?: string | null;
      revisionHash: string;
      contentRef: PayloadRef;
      entryType?: string;
    }
  | {
      type: "entity.bound";
      canonicalSpanId: string;
      entryKey: string;
      aliasSpanId?: string;
      evidence: string;
    }
  | {
      type: "relation.observed";
      from: string;
      to: string;
      relationKind: "calls" | "result-consumed" | "sequence" | "contains";
      evidence: string;
    }
  | {
      type: "branch.selected";
      oldLeafId?: string | null;
      newLeafId: string | null;
    }
  | {
      type: "run.settled";
      runId?: string;
      outcomeKnown: boolean;
      aborted?: boolean;
    }
  | {
      type: "capture.gap";
      scope: string;
      reason: string;
      targetProducerId?: string;
      lostSeqRange?: [number, number];
      counts?: Record<string, number>;
    }
  | { type: "capture.stopped"; reason: string; clean: boolean };
export type EventDraft = {
  schemaVersion: 1;
  eventId: string;
  producerId: string;
  producerSeq: number;
  sessionKey: string;
  source: Source;
  observedAt: ObservedTime;
  refs: Refs;
  fact: Fact;
};
export type StoredEvent = EventDraft & { cursor: Cursor; receivedAt: number };
export type Quality = {
  timing: "measured" | "partial" | "unknown";
  gaps: string[];
  association: "exact" | "unresolved";
};
export type Span = {
  id: string;
  producerId: string;
  kind: "llm" | "tool";
  name: string;
  traceId?: string;
  turnId?: string;
  runId?: string;
  state: SpanState;
  start?: ObservedTime;
  end?: ObservedTime;
  stage?: Stage;
  stages: { stage: Stage; at: ObservedTime; cursor: Cursor }[];
  inputRef?: PayloadRef;
  inputCursor?: Cursor;
  outputRef?: PayloadRef;
  outputCursor?: Cursor;
  executionDurationMs?: number;
  source: Source;
  entryKey?: string;
  model?: string;
  quality: Quality;
};
export type Trace = {
  start?: ObservedTime;
  end?: ObservedTime;
  id: string;
  label: string;
  kind: string;
  contentRef?: PayloadRef;
  settled: boolean;
  aborted?: boolean;
};
export type Turn = {
  start?: ObservedTime;
  end?: ObservedTime;
  id: string;
  runId: string;
  index: number;
  traceId?: string;
  completed: boolean;
};
export type Relation = {
  from: string;
  to: string;
  kind: "calls" | "result-consumed" | "sequence" | "contains";
  evidence: string;
};
export type SessionState = {
  sessionKey: string;
  cursor: Cursor;
  spans: Record<string, Span>;
  traces: Record<string, Trace>;
  turns: Record<string, Turn>;
  entries: Record<
    string,
    { parentId?: string | null; revisionHash: string; contentRef: PayloadRef }
  >;
  aliases: Record<string, string>;
  relations: Relation[];
  gaps: string[];
  capabilities: Capabilities;
  leafId?: string | null;
  capturing: boolean;
  producers: Record<string, boolean>;
  events: StoredEvent[];
};
export type ViewSelection = {
  traceId?: string;
  branchLeafId?: string | null;
  now?: ObservedTime;
  cursor?: Cursor;
  collapsedTurnIds?: ReadonlySet<string>;
};
export type ProjectedSpan = Span & {
  durationMs: number | null;
  estimated: boolean;
};
export type Projection = {
  sessionKey: string;
  cursor: Cursor;
  spans: ProjectedSpan[];
  traces: Trace[];
  turns: Turn[];
  relations: Relation[];
  active: ProjectedSpan[];
  gaps: string[];
  capturing: boolean;
  capabilities: Capabilities;
};
export function compareCursor(a: Cursor, b: Cursor): number {
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}
export function initialState(sessionKey = ""): SessionState {
  return {
    sessionKey,
    cursor: "0",
    spans: {},
    traces: {},
    turns: {},
    entries: {},
    aliases: {},
    relations: [],
    gaps: [],
    capabilities: {},
    capturing: false,
    producers: {},
    events: [],
  };
}
function blankSpan(id: string, event: StoredEvent): Span {
  return {
    id,
    producerId: event.producerId,
    kind: "llm",
    name: "未关联调用",
    ...event.refs,
    state: "unknown",
    stages: [],
    source: event.source,
    quality: {
      timing: "unknown",
      gaps: ["缺失开始事件"],
      association: "unresolved",
    },
  };
}
export function reduce(
  previous: SessionState,
  event: StoredEvent,
): SessionState {
  if (previous.sessionKey && previous.sessionKey !== event.sessionKey)
    throw new Error("Session identity mismatch");
  if (compareCursor(event.cursor, previous.cursor) <= 0) return previous;
  const state = {
    ...previous,
    sessionKey: event.sessionKey,
    cursor: event.cursor,
    events: [...previous.events, event],
  };
  const fact = event.fact;
  const changeSpan = (id: string, update: (span: Span) => Span) => {
    const canonical = state.aliases[id] ?? id;
    state.spans = {
      ...state.spans,
      [canonical]: update(
        state.spans[canonical] ?? blankSpan(canonical, event),
      ),
    };
  };
  switch (fact.type) {
    case "capture.started":
      state.producers = { ...state.producers, [event.producerId]: true };
      state.capturing = true;
      state.capabilities = fact.capabilities;
      state.leafId = fact.leafId;
      break;
    case "input.applied":
      state.traces = {
        ...state.traces,
        [fact.traceId]: {
          ...state.traces[fact.traceId],
          id: fact.traceId,
          start:
            state.traces[fact.traceId]?.start ??
            (event.source === "pi-import" ? undefined : event.observedAt),
          label: fact.label ?? state.traces[fact.traceId]?.label ?? "用户问题",
          kind: fact.kind,
          contentRef: fact.contentRef ?? state.traces[fact.traceId]?.contentRef,
          settled: false,
        },
      };
      if (event.refs.turnId && state.turns[event.refs.turnId])
        state.turns = {
          ...state.turns,
          [event.refs.turnId]: {
            ...state.turns[event.refs.turnId]!,
            traceId: fact.traceId,
          },
        };
      break;
    case "turn.started":
    case "turn.ended":
      state.turns = {
        ...state.turns,
        [fact.turnId]: {
          id: fact.turnId,
          start:
            state.turns[fact.turnId]?.start ??
            (fact.type === "turn.started" && event.source !== "pi-import"
              ? event.observedAt
              : undefined),
          end:
            fact.type === "turn.ended" && event.source !== "pi-import"
              ? event.observedAt
              : state.turns[fact.turnId]?.end,
          runId: fact.runId,
          index: fact.turnIndex,
          traceId: event.refs.traceId ?? state.turns[fact.turnId]?.traceId,
          completed: fact.type === "turn.ended",
        },
      };
      break;
    case "span.started":
      if (event.refs.traceId && state.traces[event.refs.traceId]?.settled)
        state.traces = {
          ...state.traces,
          [event.refs.traceId]: {
            ...state.traces[event.refs.traceId]!,
            settled: false,
            end: undefined,
          },
        };

      if (
        event.refs.turnId &&
        event.refs.traceId &&
        state.turns[event.refs.turnId]
      )
        state.turns = {
          ...state.turns,
          [event.refs.turnId]: {
            ...state.turns[event.refs.turnId]!,
            traceId: event.refs.traceId,
          },
        };
      changeSpan(fact.spanId, (old) => ({
        ...old,
        id: fact.spanId,
        kind: fact.kind,
        name: fact.name,
        traceId: event.refs.traceId ?? old.traceId,
        turnId: event.refs.turnId ?? old.turnId,
        runId: event.refs.runId ?? old.runId,
        start: event.observedAt,
        state: old.end ? old.state : "running",
        inputRef: fact.inputRef,
        inputCursor: fact.inputRef ? event.cursor : old.inputCursor,
        model: fact.model,
        quality: {
          ...old.quality,
          timing:
            fact.timingBasis === "unknown"
              ? "unknown"
              : old.end
                ? "partial"
                : "partial",
          gaps: old.end ? old.quality.gaps : [],
          association: event.refs.sourceEntryId
            ? "exact"
            : old.quality.association,
        },
      }));
      break;
    case "span.stage_changed":
      changeSpan(fact.spanId, (old) => ({
        ...old,
        stage: fact.stage,
        stages: [
          ...old.stages,
          { stage: fact.stage, at: event.observedAt, cursor: event.cursor },
        ],
      }));
      break;
    case "span.ended":
      changeSpan(fact.spanId, (old) => ({
        ...old,
        end: event.source === "pi-import" ? undefined : event.observedAt,
        state: fact.outcome,
        executionDurationMs:
          old.kind === "tool" &&
          event.source !== "pi-import" &&
          typeof fact.durationMs === "number" &&
          Number.isFinite(fact.durationMs) &&
          fact.durationMs >= 0
            ? fact.durationMs
            : undefined,
        outputRef: fact.contentRef ?? old.outputRef,
        outputCursor: fact.contentRef ? event.cursor : old.outputCursor,
        quality: {
          ...old.quality,
          timing:
            old.start?.clockId &&
            old.start.clockId === event.observedAt.clockId &&
            old.start.monoMs !== null &&
            event.observedAt.monoMs !== null &&
            event.source !== "pi-import"
              ? "measured"
              : "unknown",
        },
      }));
      break;
    case "message.finalized":
      if (event.refs.spanId)
        changeSpan(event.refs.spanId, (old) => ({
          ...old,
          outputRef: fact.contentRef,
          outputCursor: event.cursor,
        }));
      break;
    case "entry.archived":
      state.entries = {
        ...state.entries,
        [fact.sourceEntryKey]: {
          parentId: fact.parentId,
          revisionHash: fact.revisionHash,
          contentRef: fact.contentRef,
        },
      };
      break;
    case "entity.bound": {
      const requestedId =
        state.aliases[fact.canonicalSpanId] ?? fact.canonicalSpanId;
      const requested =
        state.spans[requestedId] ?? blankSpan(requestedId, event);
      const existing = Object.values(state.spans).find(
        (span) => span.id !== requestedId && span.entryKey === fact.entryKey,
      );
      const canonical =
        existing?.source === "pi-live" && requested.source !== "pi-live"
          ? existing
          : requested;
      const imported = canonical.id === requestedId ? existing : requested;
      const explicit = fact.aliasSpanId
        ? state.spans[state.aliases[fact.aliasSpanId] ?? fact.aliasSpanId]
        : undefined;
      state.spans = {
        ...state.spans,
        [canonical.id]: {
          ...canonical,
          entryKey: fact.entryKey,
          inputRef:
            canonical.inputRef ?? imported?.inputRef ?? explicit?.inputRef,
          outputRef:
            canonical.outputRef ?? imported?.outputRef ?? explicit?.outputRef,
          inputCursor:
            canonical.inputCursor ??
            imported?.inputCursor ??
            explicit?.inputCursor,
          outputCursor:
            canonical.outputCursor ??
            imported?.outputCursor ??
            explicit?.outputCursor,
          quality: { ...canonical.quality, association: "exact" },
        },
      };
      state.aliases = { ...state.aliases };
      for (const aliasId of [imported?.id, fact.aliasSpanId, requestedId])
        if (aliasId && aliasId !== canonical.id) {
          delete state.spans[aliasId];
          state.aliases[aliasId] = canonical.id;
          for (const [id, target] of Object.entries(state.aliases))
            if (target === aliasId) state.aliases[id] = canonical.id;
        }
      break;
    }
    case "relation.observed":
      if (
        !state.relations.some(
          (r) =>
            r.from === fact.from &&
            r.to === fact.to &&
            r.kind === fact.relationKind,
        )
      )
        state.relations = [
          ...state.relations,
          {
            from: fact.from,
            to: fact.to,
            kind: fact.relationKind,
            evidence: fact.evidence,
          },
        ];
      break;
    case "branch.selected":
      state.leafId = fact.newLeafId;
      break;
    case "run.settled": {
      const ids = new Set(
        Object.values(state.spans)
          .filter((s) => !!fact.runId && s.runId === fact.runId)
          .map((s) => s.traceId),
      );
      if (event.refs.traceId) ids.add(event.refs.traceId);
      state.traces = Object.fromEntries(
        Object.entries(state.traces).map(([id, t]) => [
          id,
          ids.has(id)
            ? {
                ...t,
                settled: true,
                ...(typeof fact.aborted === "boolean"
                  ? { aborted: fact.aborted }
                  : {}),
                end:
                  event.source !== "pi-import" &&
                  (event.refs.traceId === id ||
                    (!!fact.runId &&
                      Object.values(state.spans).some(
                        (s) => s.traceId === id && s.runId === fact.runId,
                      )))
                    ? event.observedAt
                    : t.end,
              }
            : t,
        ]),
      );
      break;
    }
    case "capture.gap":
      if (fact.targetProducerId) {
        state.producers = {
          ...state.producers,
          [fact.targetProducerId]: false,
        };
        state.capturing = Object.values(state.producers).some(Boolean);
      }
      state.gaps = [...state.gaps, fact.reason];
      state.spans = Object.fromEntries(
        Object.entries(state.spans).map(([id, s]) => [
          id,
          s.state === "running" &&
          (!fact.targetProducerId || s.producerId === fact.targetProducerId)
            ? {
                ...s,
                state: fact.targetProducerId ? "interrupted" : s.state,
                quality: {
                  ...s.quality,
                  timing: fact.targetProducerId ? "unknown" : s.quality.timing,
                  gaps: [...s.quality.gaps, fact.reason],
                },
              }
            : s,
        ]),
      );
      break;
    default:
      if (!["input.submitted", "run.started", "run.ended"].includes(fact.type))
        state.gaps = [...state.gaps, `不支持的事实类型：${fact.type}`];
      break;
    case "capture.stopped":
      state.producers = { ...state.producers, [event.producerId]: false };
      state.capturing = Object.values(state.producers).some(Boolean);
      state.spans = Object.fromEntries(
        Object.entries(state.spans).map(([id, s]) => [
          id,
          s.state === "running" && s.producerId === event.producerId
            ? {
                ...s,
                state: "interrupted",
                quality: {
                  ...s.quality,
                  gaps: [...s.quality.gaps, "采集结束，执行终点未记录"],
                },
              }
            : s,
        ]),
      );
      break;
  }
  return state;
}
export function replay(
  events: readonly StoredEvent[],
  cursor?: Cursor,
): SessionState {
  return events.reduce(
    (state, event) =>
      cursor && compareCursor(event.cursor, cursor) > 0
        ? state
        : reduce(state, event),
    initialState(events[0]?.sessionKey),
  );
}
export function project(
  state: SessionState,
  selection: ViewSelection = {},
): Projection {
  const leaf =
    selection.branchLeafId === undefined
      ? state.leafId
      : selection.branchLeafId;
  const path = new Set<string>();
  const entryKey = (id: string) =>
    state.entries[id]
      ? id
      : state.entries[`${state.sessionKey}:${id}`]
        ? `${state.sessionKey}:${id}`
        : id;
  let current = leaf ? entryKey(leaf) : undefined;
  while (current && !path.has(current)) {
    path.add(current);
    const parent = state.entries[current]?.parentId;
    current = parent ? entryKey(parent) : undefined;
  }
  const spans = Object.values(state.spans)
    .filter(
      (s) =>
        (!selection.traceId || s.traceId === selection.traceId) &&
        (!leaf || !s.entryKey || path.has(s.entryKey)),
    )
    .map((s) => {
      const endpoint = s.end ?? selection.now;
      const measured =
        s.quality.timing !== "unknown" &&
        s.start?.clockId &&
        endpoint?.clockId === s.start.clockId &&
        s.start.monoMs !== null &&
        endpoint.monoMs !== null;
      return {
        ...s,
        durationMs:
          s.executionDurationMs ??
          (measured ? Math.max(0, endpoint!.monoMs! - s.start!.monoMs!) : null),
        estimated: !s.end && !!measured,
      };
    });
  const ids = new Set(spans.map((s) => s.id));
  return {
    sessionKey: state.sessionKey,
    cursor: state.cursor,
    spans,
    traces: Object.values(state.traces),
    turns: Object.values(state.turns),
    relations: state.relations
      .map((r) => ({
        ...r,
        from: state.aliases[r.from] ?? r.from,
        to: state.aliases[r.to] ?? r.to,
      }))
      .filter((r) => ids.has(r.from) && ids.has(r.to)),
    active: spans.filter((s) => s.state === "running"),
    gaps: state.gaps,
    capturing: state.capturing,
    capabilities: state.capabilities,
  };
}
export type EventPage = {
  events: StoredEvent[];
  through: Cursor;
  nextAfter: Cursor;
  done: boolean;
};
export type EventBatch = {
  protocolVersion: 1;
  storeId: string;
  producerId: string;
  events: EventDraft[];
  payloads?: PayloadInput[];
};
export type AppendAck = {
  producerId: string;
  ackedThrough: number;
  lastCursor: Cursor;
};
