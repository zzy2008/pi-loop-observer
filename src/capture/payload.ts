import { createHash } from "node:crypto";
import type { PayloadInput, Source } from "../model/index.js";
export function snapshotPayload(
  value: unknown,
  source: Source = "pi-live",
  maxBytes = 512 * 1024,
): PayloadInput {
  let data: string;
  try {
    data = JSON.stringify(value) ?? "null";
  } catch {
    data = JSON.stringify({
      unavailable: true,
      reason: "value is not JSON serializable",
    });
    return {
      payloadId: createHash("sha256")
        .update(source + "\0" + data)
        .digest("hex"),
      mimeType: "application/json",
      encoding: "utf8",
      data,
      source,
      completeness: {
        truncated: true,
        reason: "non-serializable source value",
      },
    };
  }
  let truncated = false;
  if (Buffer.byteLength(data) > maxBytes) {
    data = Buffer.from(data).subarray(0, maxBytes).toString("utf8");
    truncated = true;
  }
  return {
    payloadId: createHash("sha256")
      .update(source + "\0" + data)
      .digest("hex"),
    mimeType: truncated ? "text/plain" : "application/json",
    encoding: "utf8",
    data,
    source,
    completeness: {
      truncated,
      ...(truncated ? { reason: "capture payload byte limit" } : {}),
    },
  };
}
