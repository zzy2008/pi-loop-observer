import { useEffect, useMemo, useRef, useState } from "react";
import type { Projection, ProjectedSpan } from "../../src/model/index.js";
import { nameOf, type DisplayIndex } from "./display-model";
import { statusLabel } from "./presentation";
import type { Language } from "./i18n";
import { loadPayload } from "./client";

/** Immutable payloads are reusable, but only refs in the current prefix are exposed. */
export class SummaryCache {
  private values = new Map<string, unknown>();
  constructor(private capacity = 256) {}
  private key(session: string, id: string) {
    return `${session}\0${id}`;
  }
  has(session: string, id: string) {
    return this.values.has(this.key(session, id));
  }
  set(session: string, id: string, value: unknown) {
    const key = this.key(session, id);
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.capacity)
      this.values.delete(this.values.keys().next().value!);
  }
  visible(session: string, refs: readonly string[]): Record<string, unknown> {
    return Object.fromEntries(
      refs
        .filter((id) => this.has(session, id))
        .map((id) => [id, this.values.get(this.key(session, id))]),
    );
  }
}
export function usePayloadSummaries(
  sessionKey: string,
  cursor: string,
  view: Projection,
) {
  const refs = useMemo(
    () => [
      ...new Set(
        [
          ...view.traces.map((t) => t.contentRef),
          ...view.spans.map((s) => s.inputRef),
        ].filter((x): x is string => !!x),
      ),
    ],
    [view.traces, view.spans],
  );
  const signature = JSON.stringify(refs);
  const cache = useRef(new SummaryCache());
  const [revision, setRevision] = useState(0);
  // A cursor change with unchanged refs does not invalidate immutable inputs.
  // A refs change aborts old requests before starting at most three workers.
  useEffect(() => {
    const controller = new AbortController();
    let next = 0;
    const worker = async () => {
      while (!controller.signal.aborted && next < refs.length) {
        const id = refs[next++];
        if (cache.current.has(sessionKey, id)) continue;
        try {
          const page = await loadPayload(
            id,
            sessionKey,
            cursor,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          const text =
            page.encoding === "base64"
              ? new TextDecoder().decode(
                  Uint8Array.from(atob(page.data ?? ""), (c) =>
                    c.charCodeAt(0),
                  ),
                )
              : (page.data ?? "");
          let value: unknown = text;
          try {
            value = JSON.parse(text);
          } catch {}
          cache.current.set(sessionKey, id, value);
          setRevision((old) => old + 1);
        } catch {
          // Failed or cancelled requests are not cached; retry when visible refs change.
        }
      }
    };
    void Promise.all([worker(), worker(), worker()]);
    return () => controller.abort();
  }, [sessionKey, signature]);
  return useMemo(
    () => cache.current.visible(sessionKey, refs),
    [sessionKey, signature, revision],
  );
}

/** Search receives the entire replay prefix, independently of branch/question filters. */
export function searchVisibleCalls(
  spans: readonly ProjectedSpan[],
  display: DisplayIndex,
  query: string,
  language: Language,
) {
  const needle = query.trim().toLocaleLowerCase();
  return spans.filter((span) =>
    [
      nameOf(display, span.id, span.name),
      display.summaries[span.id],
      span.traceId ? display.names[span.traceId] : "",
      span.traceId ? display.summaries[span.traceId] : "",
      span.id,
      span.traceId,
      span.turnId,
      span.model,
      span.name,
      span.state,
      statusLabel(span.state, language),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle),
  );
}
