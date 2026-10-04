import type { Projection } from "../../src/model/index.js";
export type GraphRow = {
  id: string;
  kind: "question" | "turn" | "call";
  entityId: string;
  traceId?: string;
  turnId?: string;
};
/** Depth-first rows have bounded indentation; ordering does not assert execution order. */
export function layoutSpans(
  view: Projection,
  options: {
    collapsed?: ReadonlySet<string>;
    collapsedQuestions?: ReadonlySet<string>;
    narrow?: boolean;
  } = {},
) {
  const positions = new Map<string, { x: number; y: number }>();
  const rows: GraphRow[] = [];
  const turns: string[] = [];
  const indent = options.narrow ? 18 : 36;
  const add = (row: GraphRow, depth: number) => {
    positions.set(row.id, { x: depth * indent, y: rows.length * 150 });
    rows.push(row);
  };
  const traces = [
    ...new Set([
      ...view.traces
        .filter(
          (t) =>
            view.spans.some((s) => s.traceId === t.id) ||
            view.turns.some((turn) => turn.traceId === t.id),
        )
        .map((t) => t.id),
      ...view.spans.map((s) => s.traceId ?? "unassigned"),
    ]),
  ];
  for (const traceId of traces) {
    add(
      { id: `prompt:${traceId}`, kind: "question", entityId: traceId, traceId },
      0,
    );
    if (options.collapsedQuestions?.has(traceId)) continue;
    const traceSpans = view.spans.filter(
      (s) => (s.traceId ?? "unassigned") === traceId,
    );
    const traceTurns = [
      ...new Set([
        ...view.turns
          .filter(
            (t) =>
              t.traceId === traceId ||
              traceSpans.some((s) => s.turnId === t.id),
          )
          .map((t) => t.id),
        ...traceSpans.map((s) => s.turnId ?? `unassigned:${traceId}`),
      ]),
    ];
    for (const turnId of traceTurns) {
      turns.push(turnId);
      add(
        {
          id: `turn:${turnId}`,
          kind: "turn",
          entityId: turnId,
          traceId,
          turnId,
        },
        1,
      );
      if (options.collapsed?.has(turnId)) continue;
      for (const span of traceSpans.filter(
        (s) => (s.turnId ?? `unassigned:${traceId}`) === turnId,
      ))
        add(
          { id: span.id, kind: "call", entityId: span.id, traceId, turnId },
          2,
        );
    }
  }
  return { turns, positions, rows };
}
