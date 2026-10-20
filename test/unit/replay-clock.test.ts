import { describe, expect, it } from "vitest";
import {
  buildReplayTimeline,
  buildQuestionReplayTimeline,
  replayIndex,
} from "../../web/src/replay-clock";
import { twoTurnFixture } from "../fixtures/two-turn";
import type { StoredEvent } from "../../src/model/index.js";
const events = (): StoredEvent[] =>
  twoTurnFixture().events.map((event, i) => ({
    ...event,
    cursor: String(i + 1),
    receivedAt: 0,
  }));
describe("recorded-time replay", () => {
  it("uses monotonic timestamps rather than event count or wall-clock adjustments", () => {
    const input = events().map((e, i) => ({
      ...e,
      observedAt: { ...e.observedAt, wallMs: i % 2 ? 0 : 100000 },
    }));
    const timeline = buildReplayTimeline(input);
    expect(timeline.approximate).toBe(false);
    expect(timeline.offsets).toEqual(input.map((e) => e.observedAt.monoMs));
    expect(input[replayIndex(timeline.offsets, 500)]!.fact.type).toBe(
      "span.stage_changed",
    );
    expect(input[replayIndex(timeline.offsets, 500)]!.observedAt.monoMs).toBe(
      200,
    );
    expect(input[replayIndex(timeline.offsets, 1000)]!.fact.type).toBe(
      "span.ended",
    );
  });
  it("preserves idle gaps and marks clock changes or backward timestamps as approximate", () => {
    const input = events().slice(0, 3);
    input[1]!.observedAt = {
      wallMs: input[0]!.observedAt.wallMs + 60000,
      monoMs: 0,
      clockId: "new-epoch",
    };
    input[2]!.observedAt = { ...input[1]!.observedAt, monoMs: -10 };
    expect(buildReplayTimeline(input)).toEqual({
      offsets: [0, 60000, 60000],
      duration: 60000,
      approximate: true,
    });
    expect(replayIndex([0, 60000, 60000], 59999)).toBe(0);
    expect(replayIndex([0, 60000, 60000], 60000)).toBe(2);
  });
  it("handles empty and equal-time records without inventing a playback delay", () => {
    expect(buildReplayTimeline([])).toEqual({
      offsets: [],
      duration: 0,
      approximate: false,
    });
    expect(replayIndex([], 0)).toBe(-1);
    expect(buildReplayTimeline(events().slice(0, 2)).offsets).toEqual([0, 0]);
    expect(replayIndex([0, 0, 100], 0)).toBe(1);
  });
});

it("does not count capture shutdown nine days after a settled question", () => {
  const input = events();
  input[input.length - 1]!.observedAt.monoMs! += 9 * 86400000;
  input[input.length - 1]!.observedAt.wallMs += 9 * 86400000;
  const timeline = buildQuestionReplayTimeline(input);
  expect(timeline.duration).toBeLessThan(4000);
});

it("replays each question independently and skips only the gap between questions", () => {
  const first = events();
  const second = events().map((e, i) => ({
    ...e,
    eventId: "q2-" + i,
    cursor: String(100 + i),
    observedAt: {
      ...e.observedAt,
      monoMs: e.observedAt.monoMs! + 3600000,
      wallMs: e.observedAt.wallMs + 3600000,
    },
    refs: { ...e.refs, traceId: "second" },
    fact:
      e.fact.type === "input.applied"
        ? { ...e.fact, traceId: "second" }
        : e.fact,
  }));
  expect(
    buildQuestionReplayTimeline([...first, ...second], "second").duration,
  ).toBe(3520);
  expect(buildQuestionReplayTimeline([...first, ...second]).duration).toBe(
    7040,
  );
  expect(buildQuestionReplayTimeline(first).events.at(-1)!.fact.type).toBe(
    "run.settled",
  );
});
