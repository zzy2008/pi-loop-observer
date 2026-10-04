import { describe, expect, it } from "vitest";
import {
  SummaryCache,
  searchVisibleCalls,
} from "../web/src/usePayloadSummaries";
import type { ProjectedSpan } from "../src/model/index.js";
import { errorMessage } from "../web/src/i18n";

describe("input summary visibility", () => {
  it("reuses immutable inputs while hiding future and other-session refs", () => {
    const cache = new SummaryCache();
    cache.set("one", "input", { text: "question" });
    cache.set("one", "future", { text: "secret" });
    cache.set("two", "input", { text: "other session" });
    expect(cache.visible("one", ["input"])).toEqual({
      input: { text: "question" },
    });
    expect(cache.has("one", "input")).toBe(true);
    expect(cache.visible("one", [])).toEqual({});
    expect(cache.visible("two", ["future"])).toEqual({});
  });
  it("evicts old inputs at the capacity boundary", () => {
    const cache = new SummaryCache(2);
    cache.set("s", "a", 1);
    cache.set("s", "b", 2);
    cache.set("s", "c", 3);
    expect(cache.visible("s", ["a", "b", "c"])).toEqual({ b: 2, c: 3 });
  });
});
it("translates transport codes even after String(Error), preserves original errors", () => {
  expect(errorMessage("Error: request-failed:403", "en")).toBe(
    "Request failed (403).",
  );
  expect(errorMessage("Error: viewer-ticket-expired", "zh")).toContain("/obs");
  expect(errorMessage("user tool failed on original.txt", "zh")).toBe(
    "user tool failed on original.txt",
  );
});

it("finds another question using its summary without renumbering its call", () => {
  const spans = [
    { id: "call-a", traceId: "question-a", name: "read", state: "completed" },
    { id: "call-b", traceId: "question-b", name: "read", state: "completed" },
  ] as ProjectedSpan[];
  const display = {
    names: { "call-a": "Q1.T1.C1 read", "call-b": "Q2.T1.C1 read" },
    summaries: { "question-b": "repair the mobile layout" },
  };
  expect(
    searchVisibleCalls(spans, display, "mobile layout", "en").map((x) => x.id),
  ).toEqual(["call-b"]);
  expect(
    searchVisibleCalls(spans, display, "Q2.T1.C1", "en").map((x) => x.id),
  ).toEqual(["call-b"]);
  expect(
    searchVisibleCalls(spans.slice(0, 1), display, "mobile layout", "en"),
  ).toEqual([]);
});
