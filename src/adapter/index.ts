import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CaptureEngine, type PiObservation } from "../capture/engine.js";
import { CaptureQueue } from "../capture/queue.js";
import type { SourceEntry } from "../importer/index.js";
import {
  ensureService,
  acquireProducer,
  appendBatch,
  openViewer,
  type ProducerLease,
  type ServiceHandle,
} from "../lifecycle/index.js";
export type AdapterDependencies = {
  ensureService: typeof ensureService;
  acquireProducer: typeof acquireProducer;
  appendBatch: typeof appendBatch;
  openViewer: typeof openViewer;
  openBrowser: (url: string) => Promise<void>;
};
const openBrowser = (url: string) =>
  new Promise<void>((resolve, reject) => {
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
      code === 0 ? resolve() : reject(new Error("browser exited " + code)),
    );
  });
const defaults: AdapterDependencies = {
  ensureService,
  acquireProducer,
  appendBatch,
  openViewer,
  openBrowser,
};
type Epoch = {
  engine: CaptureEngine;
  queue: CaptureQueue;
  sessionKey: string;
  producerId: string;
  handle?: ServiceHandle;
  storeId?: string;
  lease?: ProducerLease;
  connecting?: Promise<ServiceHandle>;
  heartbeat?: ReturnType<typeof setInterval>;
  closing: boolean;
  ctx: ExtensionContext;
};
/** Pi package entry: public observation hooks never replace the terminal UI or agent controls. */
export default function install(
  pi: ExtensionAPI,
  deps: AdapterDependencies = defaults,
): void {
  let epoch: Epoch | undefined;
  let lastWarning = 0;
  const warn = (ctx: ExtensionContext, message: string) => {
    if (Date.now() - lastWarning < 10000) return;
    lastWarning = Date.now();
    try {
      ctx.ui.notify("Observer: " + message, "warning");
    } catch {}
  };
  const disconnect = (current: Epoch) => {
    if (current.heartbeat) clearInterval(current.heartbeat);
    current.heartbeat = undefined;
    current.handle = undefined;
    const lease = current.lease;
    current.lease = undefined;
    return lease;
  };
  const connect = (current: Epoch): Promise<ServiceHandle> => {
    if (current.handle) return Promise.resolve(current.handle);
    if (current.connecting) return current.connecting;
    current.connecting = (async () => {
      const handle = await deps.ensureService();
      if (current.closing) throw new Error("Capture epoch closed");
      if (current.storeId && current.storeId !== handle.storeId) {
        const oldHealth = current.engine.health();
        current.closing = true;
        current.queue.close();
        disconnect(current);
        if (epoch === current) {
          start(
            current.ctx,
            "archive-store-replaced",
            `Observer archive changed; prior timing epoch is unavailable`,
            {
              unackedFacts: oldHealth.pending,
              previousAckedFacts: oldHealth.ackedThrough,
            },
          );
        }
        throw new Error(
          "Observer archive changed; recording resumed in a new epoch",
        );
      }
      const lease = await deps.acquireProducer(handle, {
        producerId: current.producerId,
        sessionKey: current.sessionKey,
      });
      if (current.closing) {
        await lease.release();
        throw new Error("Capture epoch closed");
      }
      current.storeId = handle.storeId;
      current.handle = handle;
      current.lease = lease;
      current.heartbeat = setInterval(() => {
        void lease.heartbeat().catch((error) => {
          disconnect(current);
          warn(current.ctx, "连接中断，将自动重连：" + String(error));
        });
      }, 5000);
      current.heartbeat.unref();
      return handle;
    })().finally(() => {
      current.connecting = undefined;
    });
    return current.connecting;
  };
  const finish = async (current: Epoch, reason: string) => {
    try {
      await current.engine.stop(reason, 2000);
    } finally {
      current.closing = true;
      const lease = disconnect(current);
      try {
        await lease?.release();
      } catch {}
    }
  };
  const start = (
    ctx: ExtensionContext,
    reason = "session_start",
    gap?: string,
    counts?: Record<string, number>,
  ) => {
    const producerId = randomUUID();
    const sessionKey = "pi:" + ctx.sessionManager.getSessionId();
    let current: Epoch;
    const queue = new CaptureQueue({
      producerId,
      sessionKey,
      send: async (batch, signal) => {
        try {
          const handle = await connect(current);
          return await deps.appendBatch(
            handle,
            { protocolVersion: 1, storeId: handle.storeId, ...batch },
            signal,
          );
        } catch (error) {
          disconnect(current);
          warn(ctx, "自动记录暂不可用，将重试：" + String(error));
          throw error;
        }
      },
    });
    const engine = new CaptureEngine({
      sessionKey,
      queue,
      reason,
      leafId: ctx.sessionManager.getLeafId() ?? undefined,
      getLeafId: () => ctx.sessionManager.getLeafId(),
      getEntry: (id) =>
        ctx.sessionManager.getEntry(id) as SourceEntry | undefined,
    });
    current = { engine, queue, sessionKey, producerId, closing: false, ctx };
    epoch = current;
    if (gap) engine.recordGap(gap, counts);
    try {
      engine.archive(ctx.sessionManager.getEntries() as SourceEntry[]);
    } catch (error) {
      engine.recordGap("initial archive failed: " + String(error));
    }
    void connect(current).catch((error) =>
      warn(ctx, "自动记录连接暂不可用：" + String(error)),
    );
    return current;
  };
  pi.on("session_start", (_event, ctx) => {
    if (epoch) void finish(epoch, "replaced");
    try {
      start(ctx);
    } catch (error) {
      warn(ctx, "启动采集失败：" + String(error));
    }
  });
  pi.on("session_shutdown", async (event) => {
    const current = epoch;
    epoch = undefined;
    if (current)
      try {
        await finish(current, event.reason);
      } catch (error) {
        warn(current.ctx, "退出归档未完成：" + String(error));
      }
  });
  // Callback work is synchronous. No network waits or control return values.
  for (const name of [
    "input",
    "agent_start",
    "agent_end",
    "agent_settled",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "session_tree",
  ] as const) {
    pi.on(name as "message_update", (event) => {
      epoch?.engine.accept(event as unknown as PiObservation);
    });
  }
  pi.on("session_compact", (_event, ctx) => {
    try {
      epoch?.engine.archive(ctx.sessionManager.getEntries() as SourceEntry[]);
    } catch (error) {
      epoch?.engine.recordGap("compaction archive failed: " + String(error));
    }
  });
  pi.registerCommand("obs", {
    description: "打开当前会话的执行观察器",
    handler: async (_args, ctx) => {
      try {
        const handle = epoch
          ? await connect(epoch)
          : await deps.ensureService();
        const { url } = await deps.openViewer(handle, {
          sessionKey:
            epoch?.sessionKey ?? "pi:" + ctx.sessionManager.getSessionId(),
        });
        try {
          await deps.openBrowser(url);
        } catch {
          try {
            ctx.ui.notify("Observer: 请在浏览器打开 " + url, "warning");
          } catch {}
        }
      } catch (error) {
        warn(ctx, "打开失败：" + String(error));
      }
    },
  });
}
