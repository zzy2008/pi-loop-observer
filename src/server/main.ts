import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Recorder } from "../recorder/index.js";
import { createApp } from "./app.js";
import {
  dataDirectory,
  writeRuntime,
  removeRuntime,
  type ServiceHandle,
} from "../lifecycle/index.js";
export async function startService(
  options: { dataDir?: string; port?: number; idleGraceMs?: number } = {},
) {
  const dataDir = dataDirectory(options.dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const recorder = new Recorder(resolve(dataDir, "observer.sqlite"));
  const token = randomUUID(),
    instanceId = randomUUID();
  let origin = "";
  const { app, leases, stopWatching } = createApp({
    recorder,
    token,
    instanceId,
    origin: () => origin,
  });
  if (options.idleGraceMs !== undefined)
    leases.idleGraceMs = options.idleGraceMs;
  const webRoot = fileURLToPath(new URL("../web/", import.meta.url));
  app.use("*", serveStatic({ root: webRoot }));
  app.get("*", serveStatic({ path: resolve(webRoot, "index.html") }));
  const server = serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: options.port ?? 0,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No listening address");
  origin = `http://127.0.0.1:${address.port}`;
  const handle: ServiceHandle = {
    url: origin,
    token,
    instanceId,
    storeId: recorder.storeId,
    dataDir,
    protocolVersion: 1,
    pid: process.pid,
  };
  await writeRuntime(handle);
  let stopped = false;
  const timer = setInterval(() => {
    if (leases.shouldStop()) void stop();
  }, 1000);
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    stopWatching();
    server.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await removeRuntime(handle);
    recorder.close();
  }
  return { handle, server, recorder, stop };
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const service = await startService();
  process.once("SIGTERM", () => void service.stop());
  process.once("SIGINT", () => void service.stop());
}
