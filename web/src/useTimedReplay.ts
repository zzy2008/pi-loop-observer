import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { createSessionStore, Snapshot } from "./store";
import { buildQuestionReplayTimeline, replayIndex } from "./replay-clock";

type Store = ReturnType<typeof createSessionStore>;
export function useTimedReplay(
  store: Store,
  snapshot: Snapshot,
  traceId?: string,
) {
  const timeline = useMemo(
    () => buildQuestionReplayTimeline(snapshot.events, traceId),
    [snapshot.events, traceId],
  );
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, updateSpeed] = useState(1);
  const clock = useRef({ position: 0, local: 0, speed: 1, running: false });

  const apply = (value: number, local = performance.now()) => {
    const position = Math.min(timeline.duration, Math.max(0, value));
    const event = timeline.events[replayIndex(timeline.offsets, position)];
    if (event) {
      const current = store.getSnapshot();
      if (current.mode === "live" || current.visible.cursor !== event.cursor)
        store.seek(event.cursor);
    }
    clock.current.position = position;
    clock.current.local = local;
    setPosition(position);
    return position;
  };
  const sample = () => {
    const c = clock.current;
    const local = performance.now();
    const value = apply(
      c.position + (c.running ? Math.max(0, local - c.local) * c.speed : 0),
      local,
    );
    if (value >= timeline.duration) {
      c.running = false;
      setPlaying(false);
    }
  };
  const stop = () => {
    clock.current.running = false;
    setPlaying(false);
  };
  const pause = () => {
    sample();
    stop();
  };
  const seekTime = (value: number) => {
    stop();
    apply(value);
  };
  const seekEvent = (index: number) => {
    stop();
    const event = timeline.events[index];
    if (!event) return;
    const position = timeline.offsets[index]!;
    clock.current.position = position;
    clock.current.local = performance.now();
    setPosition(position);
    // Manual stepping preserves the exact event prefix, even for equal timestamps.
    store.seek(event.cursor);
  };
  const play = (fromIndex?: number) => {
    if (fromIndex != null) seekEvent(fromIndex);
    else if (clock.current.position >= timeline.duration) seekTime(0);
    clock.current.local = performance.now();
    clock.current.running = true;
    setPlaying(true);
  };
  const setSpeed = (speed: number) => {
    if (clock.current.running) sample();
    clock.current.speed = speed;
    updateSpeed(speed);
  };
  const followLive = () => {
    stop();
    store.followLive();
  };
  const resetScope = useEffectEvent(() => {
    stop();
    clock.current.position = 0;
    setPosition(0);
    if (store.getSnapshot().mode !== "live") apply(0);
  });
  useEffect(() => {
    resetScope();
  }, [traceId]);
  const onTick = useEffectEvent(sample);
  useEffect(() => {
    if (!playing) return;
    // Interpolate observed time, never future facts. Event reduction occurs only at boundaries.
    let frame = 0;
    const renderFrame = () => {
      onTick();
      if (clock.current.running) frame = requestAnimationFrame(renderFrame);
    };
    frame = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  let index = timeline.events.findIndex(
    (e) => e.cursor === snapshot.visible.cursor,
  );
  while (index >= 0 && timeline.events[index]!.source === "pi-import") index--;
  const latest = timeline.events[index]?.observedAt;
  const elapsed = Math.max(0, position - (timeline.offsets[index] ?? position));
  const now = latest
    ? {
        ...latest,
        wallMs: latest.wallMs + elapsed,
        monoMs: latest.monoMs == null ? null : latest.monoMs + elapsed,
      }
    : undefined;
  return {
    ...timeline,
    position,
    playing,
    speed,
    now,
    pause,
    play,
    seekTime,
    seekEvent,
    setSpeed,
    followLive,
  };
}
