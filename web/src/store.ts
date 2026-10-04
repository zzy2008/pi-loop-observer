import {
  compareCursor,
  initialState,
  reduce,
  replay,
  type Cursor,
  type SessionState,
  type StoredEvent,
} from "../../src/model/index.js";
export type Snapshot = {
  live: SessionState;
  visible: SessionState;
  mode: "live" | "paused";
  events: readonly StoredEvent[];
  error?: string;
};
export function createSessionStore(sessionKey: string) {
  let snapshot: Snapshot = {
    live: initialState(sessionKey),
    visible: initialState(sessionKey),
    mode: "live",
    events: [],
  };
  const identities = new Map<string, string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((fn) => fn());
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ingest: (events: readonly StoredEvent[]) => {
      let live = snapshot.live;
      const fresh: StoredEvent[] = [];
      for (const event of events) {
        const fingerprint = JSON.stringify(event);
        const old = identities.get(event.eventId);
        if (old) {
          if (old !== fingerprint) {
            snapshot = {
              ...snapshot,
              error: "同一事件身份返回了不同内容，请重新加载会话",
            };
            notify();
            return;
          }
          continue;
        }
        if (compareCursor(event.cursor, live.cursor) <= 0) {
          snapshot = { ...snapshot, error: "事件顺序异常，请重新加载会话" };
          notify();
          return;
        }
        identities.set(event.eventId, fingerprint);
        live = reduce(live, event);
        fresh.push(event);
      }
      if (!fresh.length) return;
      snapshot = {
        ...snapshot,
        live,
        visible: snapshot.mode === "live" ? live : snapshot.visible,
        events: [...snapshot.events, ...fresh],
      };
      notify();
    },
    seek: (cursor: Cursor) => {
      snapshot = {
        ...snapshot,
        mode: "paused",
        visible: replay(snapshot.events, cursor),
      };
      notify();
    },
    followLive: () => {
      snapshot = { ...snapshot, mode: "live", visible: snapshot.live };
      notify();
    },
    error: (error: string) => {
      snapshot = { ...snapshot, error };
      notify();
    },
    dispose: () => listeners.clear(),
  };
}
