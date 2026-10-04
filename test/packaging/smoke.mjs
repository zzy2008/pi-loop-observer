import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
const project = fileURLToPath(new URL("../..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "pi-obs-package-"));
const consumer = join(directory, "consumer");
const dataDir = join(directory, "data");
let runtime;
async function run(command, args, cwd = project) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const deadline = setTimeout(() => child.kill("SIGTERM"), 90000);
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(deadline);
      code === 0
        ? resolve(stdout.trim())
        : reject(
            new Error(`${command} failed (${code})\n${stdout}\n${stderr}`),
          );
    });
  });
}
try {
  await mkdir(consumer);
  await run("pnpm", ["pack", "--pack-destination", directory]);
  const tarball = (await readdir(directory)).find((name) =>
    name.endsWith(".tgz"),
  );
  assert(tarball, "pack produced tarball");
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "observer-package-smoke",
      private: true,
      type: "module",
    }),
  );
  await writeFile(
    join(consumer, "pnpm-workspace.yaml"),
    "packages:\n  - .\nautoInstallPeers: false\nallowBuilds:\n  better-sqlite3: true\n",
  );
  const installArgs = [
    "add",
    "file:" + join(directory, tarball),
    "--store-dir",
    join(project, ".pnpm-store"),
  ];
  if (process.env.PI_OBSERVER_TEST_REGISTRY)
    installArgs.push("--registry=" + process.env.PI_OBSERVER_TEST_REGISTRY);
  await run("pnpm", installArgs, consumer);
  const packageRoot = join(consumer, "node_modules/pi-loop-observer");
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(manifest.pi.extensions, ["./dist/adapter/index.js"]);
  const extension = await import(
    pathToFileURL(join(packageRoot, "dist/adapter/index.js")).href
  );
  assert.equal(typeof extension.default, "function");
  const cli = join(packageRoot, "dist/cli/main.js");
  const source = join(directory, "session.jsonl");
  await writeFile(
    source,
    [
      {
        type: "session",
        version: 3,
        id: "packed-fixture",
        cwd: "/synthetic",
        timestamp: new Date(0).toISOString(),
      },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: { role: "user", content: "包装验收" },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: new Date(2).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "打包后的历史详情" }],
          stopReason: "stop",
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  const imported = JSON.parse(
    await run(
      process.execPath,
      [cli, "import", source, "--data-dir", dataDir],
      consumer,
    ),
  );
  assert.equal(imported.status, "complete");
  assert.equal(imported.imported, 2);
  await rm(source);
  const viewerUrl = await run(
    process.execPath,
    [
      cli,
      "open",
      "--no-open",
      "--session",
      "pi:packed-fixture",
      "--data-dir",
      dataDir,
    ],
    consumer,
  );
  runtime = JSON.parse(await readFile(join(dataDir, "runtime.json"), "utf8"));
  assert.equal(new URL(viewerUrl).origin, runtime.url);
  const html = await (await fetch(runtime.url)).text();
  assert.match(html, /<div id="root"><\/div>/);
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch(runtime.url + asset)).status, 200);
  const ticket = new URLSearchParams(new URL(viewerUrl).hash.slice(1)).get(
    "ticket",
  );
  const exchange = await fetch(runtime.url + "/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  assert.equal(exchange.status, 200);
  const cookie = exchange.headers.get("set-cookie").split(";")[0];
  const eventsResponse = await fetch(
    runtime.url +
      "/api/events?sessionKey=pi%3Apacked-fixture&after=0&limit=1000",
    { headers: { cookie } },
  );
  assert.equal(eventsResponse.status, 200);
  const { events } = await eventsResponse.json();
  const entry = events.find(
    (event) =>
      event.fact.type === "entry.archived" && event.refs.sourceEntryId === "a1",
  );
  assert(entry);
  const query = new URLSearchParams({
    sessionKey: "pi:packed-fixture",
    asOf: events.at(-1).cursor,
  });
  const payloadResponse = await fetch(
    runtime.url + "/api/payloads/" + entry.fact.contentRef + "?" + query,
    { headers: { cookie } },
  );
  assert.equal(payloadResponse.status, 200);
  const payload = await payloadResponse.json();
  assert.match(
    Buffer.from(payload.data, "base64").toString(),
    /打包后的历史详情/,
  );
  console.log(
    JSON.stringify({
      node: process.version,
      tarballInstall: true,
      cliImport: true,
      sourceDeletedArchiveReadable: true,
      standaloneViewer: true,
      webAssets: true,
      events: events.length,
    }),
  );
} finally {
  if (!runtime)
    try {
      runtime = JSON.parse(
        await readFile(join(dataDir, "runtime.json"), "utf8"),
      );
    } catch {}
  if (runtime?.pid) {
    try {
      process.kill(runtime.pid, "SIGTERM");
    } catch {}
    for (let count = 0; count < 100; count++) {
      try {
        process.kill(runtime.pid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  await rm(directory, { recursive: true, force: true });
}
