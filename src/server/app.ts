import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { getCookie, setCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import { Recorder, ProtocolError, parseCursor } from "../recorder/index.js";
import { LeaseRegistry } from "../lifecycle/index.js";
function parseJson(body: string) {
  try {
    return JSON.parse(body);
  } catch {
    throw new ProtocolError("bad_request", "Malformed JSON");
  }
}
export function createApp(options: {
  recorder: Recorder;
  token: string;
  instanceId: string;
  leases?: LeaseRegistry;
  origin?: () => string;
}) {
  const { recorder, token, instanceId } = options;
  const leases = options.leases ?? new LeaseRegistry();
  for (const producer of recorder.activeProducers())
    leases.touch("producer:" + producer.producerId);
  let degraded = false;
  const stopWatching = leases.onExpire((id) => {
    if (id.startsWith("producer:")) {
      try {
        recorder.recordProducerDisconnect(id.slice(9), instanceId);
        degraded = false;
      } catch {
        degraded = true;
        leases.touch(id, 1000);
      }
    }
  });
  const tickets = new Map<string, number>(),
    viewers = new Map<string, number>();
  const app = new Hono();
  app.onError((error, c) => {
    const protocol = error instanceof ProtocolError;
    const code = protocol ? error.code : "storage_unavailable";
    const status =
      code === "unauthorized"
        ? 401
        : code === "sequence_conflict" ||
            code === "sequence_gap" ||
            code === "store_changed"
          ? 409
          : protocol
            ? 400
            : 503;
    return c.json(
      {
        error: {
          code,
          message: protocol ? error.message : "Observer storage unavailable",
          retryable: !protocol,
          details: protocol ? error.details : undefined,
        },
      },
      status,
    );
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 16 * 1024 * 1024,
      onError: (c) =>
        c.json(
          {
            error: {
              code: "bad_request",
              message: "Request too large",
              retryable: false,
            },
          },
          413,
        ),
    }),
  );
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const expected = options.origin?.() ?? url.origin;
    if (url.hostname !== "127.0.0.1" || url.origin !== expected)
      throw new ProtocolError("unauthorized", "Invalid Host");
    const origin = c.req.header("origin");
    if (origin && origin !== expected)
      throw new ProtocolError("unauthorized", "Invalid Origin");
    if (c.req.path.startsWith("/internal/")) {
      if (origin || c.req.header("authorization") !== `Bearer ${token}`)
        throw new ProtocolError(
          "unauthorized",
          "Private producer authentication required",
        );
    } else if (
      c.req.path.startsWith("/api/") &&
      c.req.path !== "/api/viewer/exchange"
    ) {
      const viewer = getCookie(c, "observer_viewer");
      if (!viewer || (viewers.get(viewer) ?? 0) < Date.now())
        throw new ProtocolError(
          "unauthorized",
          "Viewer authentication required",
        );
      viewers.set(viewer, Date.now() + 86400000);
      leases.touch("viewer:" + viewer, 120000);
    }
    await next();
  });
  const health = () => ({
    instanceId,
    protocolVersion: 1,
    storeId: recorder.storeId,
    status: degraded ? "degraded" : "ready",
  });
  app.get("/health", (c) =>
    c.json({ instanceId, protocolVersion: 1, status: "ready" }),
  );
  app.get("/internal/health", (c) => c.json(health()));
  app.post("/internal/producers", async (c) => {
    const body = parseJson(await c.req.text()) as {
      producerId: string;
      sessionKey: string;
    };
    if (!body.producerId || !body.sessionKey)
      throw new ProtocolError("bad_request", "Missing producer identity");
    const ackedThrough = recorder.registerProducer(
      body.producerId,
      body.sessionKey,
    );
    recorder.producerConnected(body.producerId);
    leases.touch("producer:" + body.producerId);
    return c.json({ producerId: body.producerId, ackedThrough });
  });
  app.post("/internal/producers/:id/heartbeat", (c) => {
    recorder.producerConnected(c.req.param("id"));
    leases.touch("producer:" + c.req.param("id"));
    return c.json({ ok: true });
  });
  app.delete("/internal/producers/:id", (c) => {
    recorder.recordProducerDisconnect(c.req.param("id"), instanceId);
    leases.release("producer:" + c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/internal/events/batch", async (c) => {
    const body = await c.req.text();
    if (Buffer.byteLength(body) > 16 * 1024 * 1024)
      throw new ProtocolError("bad_request", "Batch too large");
    const ack = recorder.appendBatch(parseJson(body));
    recorder.producerConnected(ack.producerId);
    leases.touch("producer:" + ack.producerId);
    return c.json(ack);
  });
  app.post("/internal/viewer-ticket", (c) => {
    for (const [key, expires] of tickets)
      if (expires < Date.now()) tickets.delete(key);
    const ticket = randomUUID();
    tickets.set(ticket, Date.now() + 60000);
    leases.touch("pending-viewer:" + ticket, 60000);
    return c.json({ ticket });
  });
  const exchange = async (c: any) => {
    const { ticket } = parseJson(await c.req.text());
    const expiry = tickets.get(ticket);
    tickets.delete(ticket);
    if (!expiry || expiry < Date.now())
      throw new ProtocolError(
        "unauthorized",
        "Viewer ticket expired or consumed",
      );
    leases.release("pending-viewer:" + ticket);
    const viewer = randomUUID();
    viewers.set(viewer, Date.now() + 86400000);
    leases.touch("viewer:" + viewer, 120000);
    setCookie(c, "observer_viewer", viewer, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 86400,
    });
    return c.json({ storeId: recorder.storeId });
  };
  app.post("/auth/bootstrap", exchange);
  app.post("/api/viewer/exchange", exchange);
  app.post("/api/viewers/heartbeat", (c) => c.json({ ok: true }));
  app.get("/api/sessions", (c) =>
    c.json({ sessions: recorder.listSessions(), storeId: recorder.storeId }),
  );
  function checkStore(c: any) {
    if (c.req.query("storeId") && c.req.query("storeId") !== recorder.storeId)
      throw new ProtocolError("store_changed", "Database identity changed");
  }
  const page = (c: any) => {
    checkStore(c);
    const sessionKey = c.req.param("key") ?? c.req.query("sessionKey");
    if (!sessionKey) throw new ProtocolError("bad_request", "Missing session");
    return recorder.readPage({
      sessionKey,
      after: c.req.query("after") ?? "0",
      through: c.req.query("through") ?? recorder.getWatermark(),
      limit: Number(c.req.query("limit") ?? 256),
    });
  };
  app.get("/api/events", (c) => c.json(page(c)));
  app.get("/api/sessions/:key/events", (c) => c.json(page(c)));
  app.get("/api/sessions/:key/bootstrap", (c) => {
    const firstPage = page(c);
    return c.json({
      storeId: recorder.storeId,
      watermark: firstPage.through,
      firstPage,
    });
  });
  const stream = (c: any) => {
    checkStore(c);
    const sessionKey = c.req.param("key") ?? c.req.query("sessionKey");
    if (!sessionKey) throw new ProtocolError("bad_request", "Missing session");
    let after = c.req.header("last-event-id") ?? c.req.query("after") ?? "0";
    parseCursor(after);
    if (BigInt(after) > BigInt(recorder.getWatermark()))
      throw new ProtocolError(
        "cursor_invalid",
        "Cursor is beyond store watermark",
      );
    const viewer = getCookie(c, "observer_viewer")!;
    return streamSSE(c, async (s) => {
      let wake: (() => void) | undefined,
        closed = false;
      const unsubscribe = recorder.onCommit(() => wake?.());
      const disconnect = leases.connect("viewer:" + viewer);
      s.onAbort(() => {
        closed = true;
        wake?.();
      });
      try {
        while (!closed) {
          const p = recorder.readPage({
            sessionKey,
            after,
            through: recorder.getWatermark(),
            limit: 256,
          });
          if (p.events.length) {
            for (const e of p.events) {
              if (closed) break;
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  s.writeSSE({
                    event: "fact",
                    id: e.cursor,
                    data: JSON.stringify(e),
                  }),
                  new Promise<never>((_, reject) => {
                    timer = setTimeout(
                      () => reject(new Error("Slow viewer")),
                      5000,
                    );
                  }),
                ]);
              } finally {
                if (timer) clearTimeout(timer);
              }
              after = e.cursor;
            }
            continue;
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              wake = undefined;
              resolve();
            }, 1000);
            wake = () => {
              clearTimeout(timer);
              wake = undefined;
              resolve();
            };
          });
          if (!closed) await s.writeSSE({ event: "heartbeat", data: "{}" });
        }
      } finally {
        unsubscribe();
        disconnect();
      }
    });
  };
  app.get("/api/stream", stream);
  app.get("/api/sessions/:key/stream", stream);
  app.get("/api/payloads/:id", (c) => {
    checkStore(c);
    const sessionKey = c.req.query("sessionKey");
    if (!sessionKey) throw new ProtocolError("bad_request", "Missing session");
    return c.json(
      recorder.readPayload({
        payloadId: c.req.param("id"),
        sessionKey,
        asOf: c.req.query("asOf") ?? recorder.getWatermark(),
        offset: Number(c.req.query("offset") ?? 0),
        limit: Number(c.req.query("limit") ?? 65536),
      }),
    );
  });
  return { app, leases, stopWatching };
}
