#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ensureService,
  openViewer,
  acquireProducer,
  appendBatch,
} from "../lifecycle/index.js";
import { CaptureQueue } from "../capture/queue.js";
import { SessionImporter, type ImportReport } from "../importer/index.js";
const help = `Pi Loop Observer\n\n  open [--data-dir path] [--session key] [--no-open]\n  import <session.jsonl> [--data-dir path]\n\nopen starts or reuses the independent local viewer.\nimport archives the selected Pi v3 JSONL file; historical durations remain unknown.\n`;
export function parseArgs(args: string[]): {
  command: "open" | "import" | "help";
  dataDir?: string;
  sessionKey?: string;
  noOpen: boolean;
  path?: string;
} {
  if (!args.length || args[0] === "--help" || args[0] === "-h")
    return { command: "help", noOpen: false };
  const command = args[0];
  if (command !== "open" && command !== "import")
    throw Error("Unknown command: " + command);
  const result: {
    command: "open" | "import";
    dataDir?: string;
    sessionKey?: string;
    noOpen: boolean;
    path?: string;
  } = { command, noOpen: false };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--data-dir" || arg === "--session") {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw Error("Missing value for " + arg);
      if (arg === "--session") {
        if (command !== "open") throw Error("--session is only valid for open");
        result.sessionKey = value;
      } else result.dataDir = value;
    } else if (arg === "--no-open") {
      if (command !== "open") throw Error("--no-open is only valid for open");
      result.noOpen = true;
    } else if (!arg.startsWith("-") && command === "import" && !result.path)
      result.path = arg;
    else throw Error("Unknown argument: " + arg);
  }
  if (command === "import" && !result.path)
    throw Error("import requires a JSONL file path");
  return result;
}
export async function openBrowser(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "rundll32"
          : "xdg-open";
    const args =
      process.platform === "win32"
        ? ["url.dll,FileProtocolHandler", url]
        : [url];
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error("Browser opener exited " + code)),
    );
  });
}
async function readHeader(path: string) {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const header = JSON.parse(line) as {
        type?: string;
        version?: number;
        id?: string;
      };
      if (
        header.type !== "session" ||
        header.version !== 3 ||
        typeof header.id !== "string"
      )
        throw Error("Only native Pi session format v3 is supported");
      return header;
    }
    throw Error("Empty session file");
  } finally {
    lines.close();
    input.destroy();
  }
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  if (options.command === "help") {
    console.log(help);
    return;
  }
  if (options.command === "open") {
    const handle = await ensureService({ dataDir: options.dataDir });
    const { url } = await openViewer(handle, {
      sessionKey: options.sessionKey,
    });
    console.log(url);
    if (!options.noOpen)
      try {
        await openBrowser(url);
      } catch (error) {
        console.error(
          "Browser could not open; use the URL above. " + String(error),
        );
      }
    return;
  }
  const header = await readHeader(options.path!);
  const sessionKey = "pi:" + header.id;
  const producerId = randomUUID();
  const handle = await ensureService({ dataDir: options.dataDir });
  const lease = await acquireProducer(handle, { producerId, sessionKey });
  const heartbeat = setInterval(() => {
    void lease.heartbeat().catch(() => {});
  }, 5000);
  heartbeat.unref();
  const queue = new CaptureQueue({
    producerId,
    sessionKey,
    send: (batch) =>
      appendBatch(handle, {
        protocolVersion: 1,
        storeId: handle.storeId,
        ...batch,
      }),
  });
  const importer = new SessionImporter((item) => queue.offer(item));
  let report: ImportReport | undefined;
  try {
    for await (const progress of importer.importSession({
      path: options.path!,
    })) {
      report = progress; // Backpressure file ingestion at each byte chunk, unlike live Pi hooks.
      const flush = await queue.flush(5000);
      if (flush.timedOut)
        throw Error("Import archive acknowledgement timed out");
    }
    const flush = await queue.flush(5000);
    if (flush.timedOut || flush.lostCount)
      throw Error(
        "Import incomplete: " + JSON.stringify({ ...report, ...flush }),
      );
    console.log(JSON.stringify(report));
    if (
      report?.status !== "complete" ||
      report?.badLines ||
      report?.incompleteTail ||
      report?.warnings.length
    )
      process.exitCode = 1;
  } finally {
    queue.close();
    clearInterval(heartbeat);
    await lease.release().catch(() => {});
  }
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
