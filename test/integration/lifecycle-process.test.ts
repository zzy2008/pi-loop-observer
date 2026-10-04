import { it, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { ensureService, privateRequest } from "../../src/lifecycle/index.js";
import { Recorder } from "../../src/recorder/index.js";
it("symlink server starters recover a dead lock and share one detached instance; restart retains store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observer-process-"));
  const target = resolve("dist/server/main.js");
  expect(existsSync(target)).toBe(true);
  const entry = join(dir, "server-link.js");
  symlinkSync(target, entry);
  mkdirSync(join(dir, "startup.lock"));
  writeFileSync(
    join(dir, "startup.lock", "owner.json"),
    JSON.stringify({
      pid: 2147483647,
      ownerId: "dead",
      createdAt: Date.now() - 10000,
    }),
  );
  let pid: number | undefined;
  try {
    const [a, b] = await Promise.all([
      ensureService({ dataDir: dir, serverEntry: entry }),
      ensureService({ dataDir: dir, serverEntry: entry }),
    ]);
    pid = a.pid;
    expect(a.instanceId).toBe(b.instanceId);
    expect(pid).not.toBe(process.pid);
    expect((await privateRequest(a, "/internal/health")).status).toBe(200);
    process.kill(pid!, "SIGTERM");
    await new Promise((r) => setTimeout(r, 250));
    const c = await ensureService({ dataDir: dir, serverEntry: entry });
    pid = c.pid;
    expect(c.instanceId).not.toBe(a.instanceId);
    expect(c.storeId).toBe(a.storeId);
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 150));
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
it("reopens acknowledged SQLite facts with stable identity after writer closes", () => {
  const dir = mkdtempSync(join(tmpdir(), "observer-restart-"));
  let r = new Recorder(join(dir, "db"));
  try {
    const storeId = r.storeId;
    r.appendBatch({
      protocolVersion: 1,
      storeId,
      producerId: "p",
      events: [
        {
          schemaVersion: 1,
          eventId: "event",
          producerId: "p",
          producerSeq: 1,
          sessionKey: "s",
          source: "observer",
          observedAt: { wallMs: 0, monoMs: null, clockId: null },
          refs: {},
          fact: { type: "run.started", runId: "run" },
        },
      ],
    });
    r.close();
    r = new Recorder(join(dir, "db"));
    expect(r.storeId).toBe(storeId);
    expect(
      r.readPage({
        sessionKey: "s",
        after: "0",
        through: r.getWatermark(),
        limit: 10,
      }).events,
    ).toHaveLength(1);
  } finally {
    r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
