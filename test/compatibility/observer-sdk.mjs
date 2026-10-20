import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const cancellation = process.env.PI_OBSERVER_TEST_CANCEL === "1";
// Parent checks the archive after the real SDK process has exited.
if (!process.env.PI_OBSERVER_SDK_WORKER) {
  const workspace = await mkdtemp(join(tmpdir(), "observer-sdk-process-"));
  let runtime;
  try {
    const { spawn } = await import("node:child_process");
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        env: {
          ...process.env,
          PI_OBSERVER_SDK_WORKER: "1",
          PI_OBSERVER_SDK_WORKSPACE: workspace,
        },
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(Error("SDK worker exited " + code)),
      );
    });
    const result = JSON.parse(
      await readFile(join(workspace, "worker-result.json"), "utf8"),
    );
    runtime = JSON.parse(
      await readFile(join(workspace, "observer-data/runtime.json"), "utf8"),
    );
    const health = await fetch(runtime.url + "/internal/health", {
      headers: { Authorization: "Bearer " + runtime.token },
    });
    assert.equal(health.status, 200);
    const lifecycle = await import("../../dist/lifecycle/index.js");
    const { url } = await lifecycle.openViewer(runtime, {
      sessionKey: result.sessionKey,
    });
    const ticket = decodeURIComponent(
      new URL(url).hash.slice("#ticket=".length),
    );
    const exchange = await fetch(runtime.url + "/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    assert.equal(exchange.status, 200);
    const cookie = exchange.headers.get("set-cookie").split(";")[0];
    const response = await fetch(
      runtime.url +
        "/api/sessions/" +
        encodeURIComponent(result.sessionKey) +
        "/events?after=0&limit=1000",
      { headers: { Cookie: cookie } },
    );
    assert.equal(response.status, 200);
    const { events } = await response.json();
    assert.equal(events.length, result.eventCount);
    assert(events.some((event) => event.fact.type === "capture.stopped"));
    if (cancellation) {
      const { replay } = await import("../../dist/model/index.js");
      assert(
        Object.values(replay(events).traces).some(
          (trace) => trace.aborted === true,
        ),
      );
    }
    console.log(
      JSON.stringify(
        {
          ...result,
          sdkProcessExited: true,
          historyReadableAfterSdkProcessExit: true,
        },
        null,
        2,
      ),
    );
  } finally {
    if (!runtime)
      try {
        runtime = JSON.parse(
          await readFile(join(workspace, "observer-data/runtime.json"), "utf8"),
        );
      } catch {}
    if (runtime?.pid) {
      try {
        process.kill(runtime.pid, "SIGTERM");
      } catch {}
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(runtime.pid, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await rm(workspace, { recursive: true, force: true });
  }
  process.exit(0);
}
const root =
  process.env.PI_OBSERVER_TEST_HOST ??
  join(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    "../..",
  );
const {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  ModelRuntime,
} = await import(root + "/dist/index.js");
const aiRoot = await import("node:fs/promises").then(async (fs) => {
  for (const path of [
    root + "/node_modules/@earendil-works/pi-ai",
    join(root, "../pi-ai"),
  ]) {
    try {
      await fs.access(path + "/dist/utils/event-stream.js");
      return path;
    } catch {}
  }
  throw Error("Cannot locate host pi-ai");
});
const { AssistantMessageEventStream } = await import(
  aiRoot + "/dist/utils/event-stream.js"
);
const cwd = process.env.PI_OBSERVER_SDK_WORKSPACE;
const agentDir = join(cwd, "config");
const settings = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});
const seen = [];
const checks = [];
const { default: installObserver } =
  await import("../../dist/adapter/index.js");
const lifecycle = await import("../../dist/lifecycle/index.js");
const modelContracts = await import("../../dist/model/index.js");
const dataDir = join(cwd, "observer-data");
let serviceHandle;
let browserOpens = 0;
let obsCommand;
let observerContext;
const observer = (pi) => {
  pi.on("session_start", (_event, ctx) => {
    observerContext = ctx;
  });
  installObserver(
    {
      ...pi,
      registerCommand(name, command) {
        if (name === "obs") obsCommand = command;
        pi.registerCommand(name, command);
      },
    },
    {
      ...lifecycle,
      ensureService: async () => {
        serviceHandle = await lifecycle.ensureService({ dataDir });
        return serviceHandle;
      },
      appendBatch: async (...args) => {
        try {
          return await lifecycle.appendBatch(...args);
        } catch (error) {
          console.error("fixture append failed:", String(error));
          throw error;
        }
      },
      openBrowser: async () => {
        browserOpens++;
      },
    },
  );
  pi.registerTool({
    name: "inner",
    label: "inner",
    description: "fixture inner",
    parameters: { type: "object", properties: {} },
    execute: async () => ({
      content: [{ type: "text", text: "inner result" }],
      details: {},
    }),
  });
  pi.registerTool({
    name: "outer",
    label: "outer",
    description: "fixture outer",
    parameters: { type: "object", properties: {} },
    execute: async (id, args, signal, update, ctx) => {
      await ctx.executeTool("inner", {});
      return { content: [{ type: "text", text: "outer result" }], details: {} };
    },
  });
  for (const type of [
    "input",
    "agent_start",
    "message_start",
    "message_update",
    "message_end",
    "turn_start",
    "turn_end",
    "tool_execution_start",
    "tool_execution_end",
    "tool_call",
    "tool_result",
    "agent_end",
    "agent_settled",
  ])
    pi.on(type, (e, ctx) => {
      if (e.parentToolCallId)
        checks.push({ nestedType: type, parentToolCallId: e.parentToolCallId });
      if (type === "tool_execution_end")
        checks.push({ durationMs: e.durationMs });
      if (type === "agent_settled") checks.push({ aborted: e.aborted });
      seen.push(type + (e.message ? ":" + e.message.role : ""));
      if (type === "input") checks.push({ inputKeys: Object.keys(e) });
      if (type === "message_end" && e.message.role === "assistant")
        checks.push({
          messageEndPersisted: ctx.sessionManager
            .getEntries()
            .some((x) => x.type === "message" && x.message === e.message),
        });
      if (type === "turn_end")
        checks.push({
          turnIds: [e.messageEntryId, ...e.toolResultEntryIds],
          resolvable: [e.messageEntryId, ...e.toolResultEntryIds].every(
            (id) => !!ctx.sessionManager.getEntry(id),
          ),
        });
    });
};
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager: settings,
  noContextFiles: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  extensionFactories: [{ path: "fixture-observer", factory: observer }],
});
await loader.reload();
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: null,
  modelsStorePath: join(agentDir, "models-cache.json"),
  allowModelNetwork: false,
  refreshOnCreate: false,
});
runtime.hasConfiguredAuth = () => true;
const model = {
  id: "fixture",
  name: "Fixture",
  api: "openai-completions",
  provider: "fixture",
  baseUrl: "http://invalid.local",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
};
const { session } = await createAgentSession({
  cwd,
  agentDir,
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager: settings,
  resourceLoader: loader,
  modelRuntime: runtime,
  model,
  tools: ["outer", "inner"],
});
await session.bindExtensions({ mode: "print" });
let call = 0;
let streamReady;
const ready = new Promise((resolve) => {
  streamReady = resolve;
});
session.agent.streamFunction = (_model, _context, options) => {
  const s = new AssistantMessageEventStream();
  const message = {
    role: "assistant",
    content:
      call++ === 0
        ? [{ type: "toolCall", id: "outer-call", name: "outer", arguments: {} }]
        : [{ type: "text", text: "fixture response" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: call === 1 ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
  if (cancellation) {
    const abort = () => {
      const error = {
        ...message,
        content: [],
        stopReason: "aborted",
        errorMessage: "synthetic cancellation",
      };
      s.push({ type: "error", reason: "aborted", error });
      s.end(error);
    };
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    streamReady();
    return s;
  }
  queueMicrotask(() => {
    s.push({ type: "start", partial: { ...message, content: [] } });
    s.push({ type: "text_start", contentIndex: 0, partial: message });
    s.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "fixture response",
      partial: message,
    });
    s.push({ type: "done", reason: "stop", message });
    s.end(message);
  });
  return s;
};
try {
  const pending = session.prompt("synthetic input");
  if (cancellation) {
    await ready;
    await session.abort();
  }
  await pending;
  if (cancellation) {
    assert(checks.some((x) => x.aborted === true));
    assert.equal(seen.at(-1), "agent_settled");
  } else {
    assert(checks.some((x) => x.messageEndPersisted === false));
    assert(
      checks
        .filter((x) => x.resolvable !== undefined)
        .every((x) => x.resolvable),
    );
    assert(checks.some((x) => x.parentToolCallId === "outer-call"));
    assert(checks.some((x) => x.inputKeys && !x.inputKeys.includes("inputId")));
    assert.equal(seen.at(-1), "agent_settled");
    assert(
      checks.some((x) => Number.isFinite(x.durationMs) && x.durationMs >= 0),
    );
    assert(checks.some((x) => x.aborted === false));
  }
  assert.equal(browserOpens, 0, "recording must not open a browser");
  // Finish the official shutdown callback, then query the still-independent service.
  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  assert(serviceHandle, "session_start launched the observer service");
  const selection = {
    sessionKey: "pi:" + session.sessionManager.getSessionId(),
  };
  const { url } = await lifecycle.openViewer(serviceHandle, selection);
  const ticket = new URL(url).hash.slice("#ticket=".length);
  const exchange = await fetch(serviceHandle.url + "/auth/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket: decodeURIComponent(ticket) }),
  });
  assert.equal(exchange.status, 200);
  const cookie = exchange.headers.get("set-cookie").split(";")[0];
  const response = await fetch(
    serviceHandle.url +
      "/api/sessions/" +
      encodeURIComponent(selection.sessionKey) +
      "/events?after=0&limit=1000",
    { headers: { Cookie: cookie } },
  );
  assert.equal(response.status, 200);
  const { events } = await response.json();
  const state = modelContracts.replay(events);
  const view = modelContracts.project(state);
  if (cancellation) {
    assert(
      events.some(
        (event) =>
          event.fact.type === "run.settled" &&
          event.fact.outcomeKnown &&
          event.fact.aborted === true,
      ),
    );
    assert.equal(view.traces.length, 1);
    assert.equal(view.traces[0].aborted, true);
    assert(view.spans.some((span) => span.state === "cancelled"));
  } else {
    assert.equal(view.spans.filter((span) => span.kind === "llm").length, 2);
    assert.equal(view.spans.filter((span) => span.kind === "tool").length, 2);
    assert(view.spans.every((span) => span.state === "completed"));
    assert(
      view.spans
        .filter((span) => span.kind === "tool")
        .every((span) => Number.isFinite(span.executionDurationMs)),
    );
    assert(
      events.some(
        (event) =>
          event.fact.type === "run.settled" &&
          event.fact.outcomeKnown &&
          event.fact.aborted === false,
      ),
    );
    assert(events.some((event) => event.fact.type === "capture.stopped"));
    assert.equal(
      events.filter((event) => event.fact.type === "entity.bound").length,
      3,
    );
    assert(view.spans.every((span) => span.quality.timing === "measured"));
    assert(
      view.relations.some(
        (edge) => edge.evidence === "public parentToolCallId",
      ),
    );
  }
  const archived = events.filter(
    (event) => event.fact.type === "entry.archived",
  );
  assert(archived.length >= (cancellation ? 2 : 4));
  await obsCommand.handler("", observerContext);
  assert.equal(browserOpens, 1);
  await writeFile(
    join(cwd, "worker-result.json"),
    JSON.stringify({
      node: process.version,
      eventCount: events.length,
      llmSpans: view.spans.filter((span) => span.kind === "llm").length,
      toolSpans: view.spans.filter((span) => span.kind === "tool").length,
      bindings: events.filter((event) => event.fact.type === "entity.bound")
        .length,
      ...(cancellation ? { aborted: true } : {}),
      browserOpens,
      independentServiceAfterSdkDispose: true,
      archivedEntries: archived.length,
      sessionKey: selection.sessionKey,
    }),
  );
} finally {
  session.dispose();
}
