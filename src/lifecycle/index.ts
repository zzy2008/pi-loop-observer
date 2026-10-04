import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  open,
  stat,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EventBatch, AppendAck } from "../recorder/index.js";
export interface ServiceHandle {
  url: string;
  token: string;
  instanceId: string;
  storeId: string;
  dataDir: string;
  protocolVersion: 1;
  pid?: number;
}
export interface ProducerLease {
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}
export const dataDirectory = (override?: string) =>
  resolve(
    override ??
      process.env.PI_LOOP_OBSERVER_DIR ??
      resolve(homedir(), ".pi/loop-observer"),
  );
export async function privateRequest(
  handle: ServiceHandle,
  path: string,
  init: RequestInit = {},
) {
  const response = await fetch(handle.url + path, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(5000),
    headers: {
      Authorization: `Bearer ${handle.token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok)
    throw new Error(`Observer ${response.status}: ${await response.text()}`);
  return response;
}
async function discover(dataDir: string): Promise<ServiceHandle | undefined> {
  try {
    const handle = JSON.parse(
      await readFile(resolve(dataDir, "runtime.json"), "utf8"),
    ) as ServiceHandle;
    if (
      handle.protocolVersion !== 1 ||
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(handle.url)
    )
      return;
    const response = await privateRequest(handle, "/internal/health", {
      signal: AbortSignal.timeout(700),
    });
    const health = (await response.json()) as {
      instanceId: string;
      storeId: string;
    };
    if (
      health.instanceId === handle.instanceId &&
      health.storeId === handle.storeId
    )
      return handle;
  } catch {
    /* A stale registry is not a running service. */
  }
  return;
}
export async function ensureService(
  options: { dataDir?: string; serverEntry?: string; timeoutMs?: number } = {},
): Promise<ServiceHandle> {
  const dataDir = dataDirectory(options.dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (options.timeoutMs ?? 15000);
  const lock = resolve(dataDir, "startup.lock");
  const owner = {
    pid: process.pid,
    ownerId: randomUUID(),
    createdAt: Date.now(),
  };
  while (Date.now() < deadline) {
    const existing = await discover(dataDir);
    if (existing) return existing;
    let acquired = false;
    try {
      await mkdir(lock);
      acquired = true;
      await writeFile(resolve(lock, "owner.json"), JSON.stringify(owner), {
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const previous = JSON.parse(
          await readFile(resolve(lock, "owner.json"), "utf8"),
        ) as typeof owner;
        let alive = true;
        try {
          process.kill(previous.pid, 0);
        } catch {
          alive = false;
        }
        if (!alive && Date.now() - previous.createdAt > 1000) {
          const stale = lock + "." + randomUUID();
          await rename(lock, stale);
          await rm(stale, { recursive: true, force: true });
        }
      } catch {
        const info = await stat(lock).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > 30000) {
          const stale = lock + "." + randomUUID();
          await rename(lock, stale)
            .then(() => rm(stale, { recursive: true, force: true }))
            .catch(() => {});
        }
      }
    }
    if (acquired) {
      try {
        const again = await discover(dataDir);
        if (again) return again;
        const log = await open(resolve(dataDir, "service.log"), "a", 0o600);
        const entry =
          options.serverEntry ??
          fileURLToPath(new URL("../server/main.js", import.meta.url));
        const child = spawn(process.execPath, [entry], {
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          env: { ...process.env, PI_LOOP_OBSERVER_DIR: dataDir },
        });
        child.on("error", () => {});
        child.unref();
        await log.close();
        while (Date.now() < deadline) {
          const handle = await discover(dataDir);
          if (handle) return handle;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error("Observer startup timed out; inspect service.log");
      } finally {
        try {
          const current = JSON.parse(
            await readFile(resolve(lock, "owner.json"), "utf8"),
          ) as typeof owner;
          if (current.ownerId === owner.ownerId)
            await rm(lock, { recursive: true, force: true });
        } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Observer startup lock timed out");
}
export async function acquireProducer(
  handle: ServiceHandle,
  identity: { producerId: string; sessionKey: string },
): Promise<ProducerLease> {
  await privateRequest(handle, "/internal/producers", {
    method: "POST",
    body: JSON.stringify(identity),
  });
  const path = "/internal/producers/" + encodeURIComponent(identity.producerId);
  return {
    heartbeat: async () => {
      await privateRequest(handle, path + "/heartbeat", { method: "POST" });
    },
    release: async () => {
      await privateRequest(handle, path, { method: "DELETE" });
    },
  };
}
export async function appendBatch(
  handle: ServiceHandle,
  batch: EventBatch,
  signal?: AbortSignal,
): Promise<AppendAck> {
  return (await (
    await privateRequest(handle, "/internal/events/batch", {
      method: "POST",
      body: JSON.stringify(batch),
      signal,
    })
  ).json()) as AppendAck;
}
export async function openViewer(
  handle: ServiceHandle,
  selection: { sessionKey?: string } = {},
): Promise<{ url: string }> {
  const { ticket } = (await (
    await privateRequest(handle, "/internal/viewer-ticket", {
      method: "POST",
      body: "{}",
    })
  ).json()) as { ticket: string };
  return {
    url:
      handle.url +
      "/?" +
      new URLSearchParams(
        selection.sessionKey ? { sessionKey: selection.sessionKey } : {},
      ).toString() +
      "#ticket=" +
      encodeURIComponent(ticket),
  };
}
export async function writeRuntime(handle: ServiceHandle) {
  await mkdir(handle.dataDir, { recursive: true, mode: 0o700 });
  const temp = resolve(handle.dataDir, "runtime." + handle.instanceId + ".tmp");
  await writeFile(temp, JSON.stringify(handle), { mode: 0o600 });
  await rename(temp, resolve(handle.dataDir, "runtime.json"));
}
export async function removeRuntime(handle: ServiceHandle) {
  try {
    const current = JSON.parse(
      await readFile(resolve(handle.dataDir, "runtime.json"), "utf8"),
    ) as ServiceHandle;
    if (current.instanceId === handle.instanceId)
      await rm(resolve(handle.dataDir, "runtime.json"));
  } catch {}
}
export class LeaseRegistry {
  private expiryListeners = new Set<(id: string) => void>();
  onExpire(listener: (id: string) => void) {
    this.expiryListeners.add(listener);
    return () => this.expiryListeners.delete(listener);
  }
  sweep() {
    const now = this.now();
    for (const [id, lease] of this.leases)
      if (!lease.connections && lease.expires <= now) {
        this.leases.delete(id);
        for (const listener of this.expiryListeners) listener(id);
      }
  }
  private leases = new Map<string, { expires: number; connections: number }>();
  private emptySince: number | null = null;
  constructor(
    public ttlMs = 30000,
    public idleGraceMs = 60000,
    private now = () => Date.now(),
  ) {}
  touch(id: string, ttl = this.ttlMs) {
    const prev = this.leases.get(id);
    this.leases.set(id, {
      expires: this.now() + ttl,
      connections: prev?.connections ?? 0,
    });
    this.emptySince = null;
  }
  release(id: string) {
    this.leases.delete(id);
  }
  connect(id: string) {
    this.touch(id, 120000);
    this.leases.get(id)!.connections++;
    return () => {
      const lease = this.leases.get(id);
      if (lease) {
        lease.connections = Math.max(0, lease.connections - 1);
        lease.expires = this.now() + 120000;
      }
    };
  }
  shouldStop() {
    const now = this.now();
    this.sweep();
    if (this.leases.size) {
      this.emptySince = null;
      return false;
    }
    this.emptySince ??= now;
    return now - this.emptySince >= this.idleGraceMs;
  }
}
