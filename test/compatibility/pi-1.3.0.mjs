import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
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
const cwd = await mkdtemp(join(tmpdir(), "observer-p0-"));
const agentDir = join(cwd, "config");
const settings = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});
const seen = [];
const checks = [];
const observer = (pi) => {
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
session.agent.streamFunction = () => {
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
  await session.prompt("synthetic input");
  assert(checks.some((x) => x.messageEndPersisted === false));
  assert(
    checks.filter((x) => x.resolvable !== undefined).every((x) => x.resolvable),
  );
  assert(checks.some((x) => x.parentToolCallId === "outer-call"));
  assert(checks.some((x) => x.inputKeys && !x.inputKeys.includes("inputId")));
  assert.equal(seen.at(-1), "agent_settled");
  assert(
    checks.some((x) => Number.isFinite(x.durationMs) && x.durationMs >= 0),
  );
  assert(checks.some((x) => x.aborted === false));
  console.log(JSON.stringify({ node: process.version, seen, checks }, null, 2));
} finally {
  session.dispose();
  await rm(cwd, { recursive: true, force: true });
}
