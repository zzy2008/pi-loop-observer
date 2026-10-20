import type { StoredEvent } from "../../src/model/index.js";

/** Event order is authoritative; monotonic time drives playback within an epoch. */
export function buildReplayTimeline(events: readonly StoredEvent[]) {
  const offsets: number[] = [];
  let duration = 0;
  let approximate = false;
  for (let i = 0; i < events.length; i++) {
    if (i > 0) {
      const previous = events[i - 1]!.observedAt;
      const current = events[i]!.observedAt;
      const sameClock =
        previous.clockId != null &&
        previous.clockId === current.clockId &&
        previous.monoMs != null &&
        current.monoMs != null;
      const delta = sameClock
        ? current.monoMs! - previous.monoMs!
        : current.wallMs - previous.wallMs;
      if (!sameClock || !Number.isFinite(delta) || delta < 0)
        approximate = true;
      duration += Number.isFinite(delta) ? Math.max(0, delta) : 0;
    }
    offsets.push(duration);
  }
  return { offsets, duration, approximate };
}

/** Include all events up to the playhead, including equal-timestamp events. */
export function replayIndex(offsets: readonly number[], position: number) {
  let low = 0,
    high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle]! <= position) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/** Replay execution windows, excluding capture lifetime and idle time between questions. */
export function buildQuestionReplayTimeline(
  events: readonly StoredEvent[],
  traceId?: string,
) {
  const windows: { id: string; start: number; end: number; closed: boolean }[] =
    [];
  let active: (typeof windows)[number] | undefined;
  events.forEach((event, index) => {
    if (event.fact.type === "input.applied") {
      const id = event.fact.traceId;
      const existing = windows.find((w) => w.id === id && !w.closed);
      active = existing ?? { id, start: index, end: index, closed: false };
      if (!existing) windows.push(active);
    }
    if (active && !active.closed && event.fact.type !== "capture.stopped") {
      active.end = index;
      if (event.fact.type === "run.settled") active.closed = true;
    }
  });
  const selected = windows.filter((w) => !traceId || w.id === traceId);
  const playable: StoredEvent[] = [],
    offsets: number[] = [];
  let duration = 0,
    approximate = false;
  for (const window of selected) {
    let anchor: StoredEvent | undefined;
    for (const event of events.slice(window.start, window.end + 1)) {
      // Archive/binding events are facts, not additional execution-clock samples.
      if (event.source !== "pi-import") {
        if (anchor) {
          const segment = buildReplayTimeline([anchor, event]);
          duration += segment.duration;
          approximate ||= segment.approximate;
        }
        anchor = event;
      }
      playable.push(event);
      offsets.push(duration);
    }
  }
  return { events: playable, offsets, duration, approximate };
}
