import type { EventPage, StoredEvent } from "../../src/model/index.js";
export type SessionSummary = {
  sessionKey: string;
  eventCount?: number;
  updatedAt?: number;
  label?: string;
  lastCursor?: string;
};
export async function request<T>(
  url: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, { signal, credentials: "same-origin" });
  if (!response.ok) throw new Error(`request-failed:${response.status}`);
  return response.json() as Promise<T>;
}
export async function exchangeTicket() {
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const ticket = fragment.get("ticket");
  if (!ticket) return;
  const response = await fetch("/api/viewer/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("viewer-ticket-expired");
  fragment.delete("ticket");
  url.hash = fragment.toString();
  history.replaceState(null, "", url);
}
export async function listSessions(
  signal?: AbortSignal,
): Promise<SessionSummary[]> {
  const data = await request<{ sessions: SessionSummary[]; storeId: string }>(
    "/api/sessions",
    signal,
  );
  return data.sessions;
}
export async function openSession(
  sessionKey: string,
  signal: AbortSignal,
  onEvents: (events: StoredEvent[]) => void,
): Promise<string> {
  let after = "0";
  let through: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ sessionKey, after, limit: "500" });
    if (through) query.set("through", through);
    const page = await request<EventPage>(`/api/events?${query}`, signal);
    through = page.through;
    onEvents(page.events);
    after = page.nextAfter;
    if (page.done) return through;
  }
}
export function subscribe(
  sessionKey: string,
  after: string,
  onEvents: (events: StoredEvent[]) => void,
  onStatus: (status: string) => void,
) {
  const source = new EventSource(
    `/api/stream?${new URLSearchParams({ sessionKey, after })}`,
  );
  const consume = (event: MessageEvent<string>) => {
    try {
      const data = JSON.parse(event.data) as
        StoredEvent | { events: StoredEvent[] };
      onEvents("events" in data ? data.events : [data]);
    } catch {
      onStatus("invalid-events");
    }
  };
  source.onmessage = consume;
  source.addEventListener("fact", consume as EventListener);
  source.addEventListener("event", consume as EventListener);
  source.onopen = () => onStatus("connected");
  source.onerror = () => onStatus("reconnecting");
  return () => source.close();
}
export async function loadPayload(
  id: string,
  sessionKey: string,
  asOf: string,
  signal: AbortSignal,
  offset = 0,
) {
  return request<{
    data?: string;
    content?: string;
    mimeType?: string;
    encoding?: string;
    nextOffset?: number;
    done?: boolean;
    byteLength?: number;
    completeness?: { truncated: boolean; reason?: string };
  }>(
    `/api/payloads/${encodeURIComponent(id)}?${new URLSearchParams({ sessionKey, asOf, limit: "65536", offset: String(offset) })}`,
    signal,
  );
}
