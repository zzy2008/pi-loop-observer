import type { Projection } from "../../src/model/index.js";
import type { Language } from "./timing";
export type DisplayIndex = {
  names: Record<string, string>;
  summaries: Record<string, string>;
};
export function textSummary(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value))
    return value
      .map((v) =>
        typeof v === "object" &&
        v !== null &&
        "type" in v &&
        v.type === "text" &&
        "text" in v
          ? textSummary(v.text)
          : "",
      )
      .filter(Boolean)
      .join(" ");
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const key of ["message", "content", "text"]) {
      const text = textSummary(o[key]);
      if (text) return text;
    }
  }
  return "";
}
export function inputSummary(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const key of ["path", "file_path", "query", "command", "pattern"])
      if (typeof o[key] === "string") return `${key}: ${textSummary(o[key])}`;
  }
  return "";
}
const short = (s: string) => (s.length > 90 ? `${s.slice(0, 87)}…` : s);
export function buildDisplayIndex(
  view: Projection,
  language: Language = "en",
  payloads: Readonly<Record<string, unknown>> = {},
): DisplayIndex {
  const names: Record<string, string> = {},
    summaries: Record<string, string> = {};
  const question = language === "zh" ? "用户问题" : "Question";
  view.traces.forEach((trace, i) => {
    const summary =
      textSummary(trace.contentRef ? payloads[trace.contentRef] : undefined) ||
      (/^(用户问题|历史问题)$/.test(trace.label) ? question : trace.label);
    summaries[trace.id] = summary;
    names[trace.id] = `Q${i + 1} · ${short(summary)}`;
    const turns = view.turns.filter((t) => t.traceId === trace.id);
    turns.forEach((turn, j) => {
      const prefix = `Q${i + 1}.T${j + 1}`;
      names[turn.id] =
        `${prefix} · ${language === "zh" ? "轮次" : "Turn"} ${j + 1}`;
      view.spans
        .filter((s) => s.turnId === turn.id)
        .forEach((span, k) => {
          const summary = inputSummary(
            span.inputRef ? payloads[span.inputRef] : undefined,
          );
          summaries[span.id] = summary;
          const label =
            span.kind === "llm"
              ? span.model ||
                (language === "zh" ? "模型响应" : "Model response")
              : span.name;
          names[span.id] =
            `${prefix}.C${k + 1} · ${label}${summary ? ` · ${short(summary)}` : ""}`;
        });
    });
    view.spans
      .filter((s) => s.traceId === trace.id && !names[s.id])
      .forEach((s, k) => {
        names[s.id] = `Q${i + 1}.C${k + 1} · ${s.model || s.name}`;
      });
  });
  view.spans
    .filter((s) => !names[s.id])
    .forEach((s, i) => {
      names[s.id] = `C${i + 1} · ${s.model || s.name}`;
    });
  return { names, summaries };
}
export const nameOf = (
  display: DisplayIndex | undefined,
  id: string,
  fallback: string,
) => display?.names[id] ?? fallback;

/** Human-readable labels inside known containers; canonical names remain unchanged. */
export function scopedName(
  label: string,
  language: Language,
  scope: { question?: boolean; turn?: boolean } = {},
): string {
  const parts = /^(?:(Q\d+)\.)?(?:T(\d+)(?:\.C(\d+))?|C(\d+)) · (.*)$/.exec(
    label,
  );
  if (!parts) return label;
  const [, question, turn, nestedCall, directCall, description] = parts;
  const call = nestedCall ?? directCall;
  const prefix = [
    question && !scope.question ? question : undefined,
    turn && (!scope.turn || !call)
      ? `${language === "zh" ? "轮次" : "Turn"} ${turn}`
      : undefined,
    call ? `${language === "zh" ? "调用" : "Call"} ${call}` : undefined,
  ].filter(Boolean);
  // Turn rows already carry their complete type and number in the prefix.
  if (call || !/^(?:Turn|轮次) \d+$/.test(description!))
    prefix.push(description);
  return prefix.join(" · ");
}
