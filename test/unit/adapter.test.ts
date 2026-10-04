import { it, expect, vi } from "vitest";
import install from "../../src/adapter/index.js";
import { parseArgs } from "../../src/cli/main.js";
function fixture() {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const pi: any = {
    on: (name: string, fn: Function) => {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
      return () => {};
    },
    registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
  };
  const ctx: any = {
    sessionManager: {
      getSessionId: () => "synthetic",
      getLeafId: () => null,
      getEntry: () => undefined,
      getEntries: () => [],
    },
    ui: { notify: vi.fn() },
  };
  return {
    pi,
    ctx,
    commands,
    fire: async (name: string, event: any = { type: name }) => {
      for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
    },
  };
}
it("automatically records without browser and /obs reuses the same epoch", async () => {
  const f = fixture();
  const batches: any[] = [];
  const handle: any = {
    url: "http://127.0.0.1:12345",
    token: "fixture",
    instanceId: "fixture",
    storeId: "store",
    dataDir: "/tmp/fixture",
    protocolVersion: 1,
  };
  const release = vi.fn(async () => {});
  const ensure = vi.fn(async () => handle);
  const browser = vi.fn(async () => {});
  install(f.pi, {
    ensureService: ensure,
    acquireProducer: async () => ({ heartbeat: async () => {}, release }),
    appendBatch: async (_handle, batch) => {
      batches.push(batch);
      return {
        producerId: batch.producerId,
        ackedThrough: batch.events.at(-1)!.producerSeq,
        lastCursor: "1",
      };
    },
    openViewer: async () => ({ url: handle.url }),
    openBrowser: browser,
  });
  await f.fire("session_start");
  await f.fire("agent_start");
  await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0));
  expect(browser).not.toHaveBeenCalled();
  await f.commands.get("obs").handler("", f.ctx);
  expect(browser).toHaveBeenCalledOnce();
  expect(ensure).toHaveBeenCalledOnce();
  await f.fire("agent_end");
  await f.fire("session_shutdown", {
    type: "session_shutdown",
    reason: "quit",
  });
  expect(release).toHaveBeenCalledOnce();
  expect(
    batches
      .flatMap((x) => x.events)
      .some((x: any) => x.fact.type === "capture.stopped"),
  ).toBe(true);
});
it("reconnects after append failure with unchanged event identity", async () => {
  const f = fixture();
  const handle: any = {
    url: "http://127.0.0.1:12345",
    token: "fixture",
    instanceId: "fixture",
    storeId: "store",
    dataDir: "/tmp/fixture",
    protocolVersion: 1,
  };
  const ensure = vi.fn(async () => handle);
  const attempts: any[] = [];
  install(f.pi, {
    ensureService: ensure,
    acquireProducer: async () => ({
      heartbeat: async () => {},
      release: async () => {},
    }),
    appendBatch: async (_handle, batch) => {
      attempts.push(structuredClone(batch));
      if (attempts.length === 1) throw Error("service restarted");
      return {
        producerId: batch.producerId,
        ackedThrough: batch.events.at(-1)!.producerSeq,
        lastCursor: "1",
      };
    },
    openViewer: async () => ({ url: handle.url }),
    openBrowser: async () => {},
  });
  await f.fire("session_start");
  await vi.waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(2));
  expect(attempts[0]).toEqual(attempts[1]);
  expect(ensure.mock.calls.length).toBeGreaterThanOrEqual(2);
  await f.fire("session_shutdown", {
    type: "session_shutdown",
    reason: "quit",
  });
});
it("starts a new producer epoch with explicit gap after archive identity changes", async () => {
  const f = fixture();
  let store = "store-1";
  const handle = () => ({
    url: "http://127.0.0.1:12345",
    token: "fixture",
    instanceId: "fixture",
    storeId: store,
    dataDir: "/tmp/fixture",
    protocolVersion: 1 as const,
  });
  const batches: any[] = [];
  install(f.pi, {
    ensureService: async () => handle(),
    acquireProducer: async () => ({
      heartbeat: async () => {},
      release: async () => {},
    }),
    appendBatch: async (_handle, batch) => {
      batches.push(structuredClone(batch));
      if (store === "store-1") {
        store = "store-2";
        throw Error("archive replaced");
      }
      return {
        producerId: batch.producerId,
        ackedThrough: batch.events.at(-1)!.producerSeq,
        lastCursor: "1",
      };
    },
    openViewer: async () => ({ url: handle().url }),
    openBrowser: async () => {},
  });
  await f.fire("session_start");
  await vi.waitFor(() =>
    expect(batches.some((x) => x.storeId === "store-2")).toBe(true),
  );
  const next = batches.find((x) => x.storeId === "store-2");
  expect(next.producerId).not.toBe(batches[0].producerId);
  expect(next.events[0].producerSeq).toBe(1);
  expect(next.events.some((x: any) => x.fact.type === "capture.gap")).toBe(
    true,
  );
  await f.fire("session_shutdown", {
    type: "session_shutdown",
    reason: "quit",
  });
});
it("validates the CLI arguments", () => {
  expect(parseArgs(["open", "--session", "s", "--no-open"])).toMatchObject({
    command: "open",
    sessionKey: "s",
    noOpen: true,
  });
  expect(() => parseArgs(["import"])).toThrow();
  expect(() => parseArgs(["open", "--bad"])).toThrow();
  expect(() => parseArgs(["import", "file", "--session", "s"])).toThrow();
});
