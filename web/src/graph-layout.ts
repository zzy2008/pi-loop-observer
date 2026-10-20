import type { Projection } from "../../src/model/index.js";
export const GRAPH_NODE_HEIGHT = 90;
export const GRAPH_ROW_GAP = 12;
export const GRAPH_COLUMN_GAP = 56;
export const GRAPH_QUESTION_GAP = 24;
export type GraphRow = {
  id: string;
  kind: "question" | "turn" | "call";
  entityId: string;
  traceId?: string;
  turnId?: string;
  parentId?: string;
};
/** Parent-relative positions describe membership; only recorded relations become edges. */
export function layoutSpans(
  view: Projection,
  options: {
    collapsed?: ReadonlySet<string>;
    collapsedQuestions?: ReadonlySet<string>;
    narrow?: boolean;
  } = {},
) {
  const positions = new Map<string, { x: number; y: number }>();
  // Absolute bounds also support focus and edge routing through the group gutters.
  const bounds = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();
  const rows: GraphRow[] = [];
  const turns: string[] = [];
  const width = options.narrow ? 230 : 240;
  const lead = options.narrow ? 144 : 164;
  const add = (row: GraphRow, x: number, y: number, w: number, h: number) => {
    const parent = row.parentId ? bounds.get(row.parentId)! : { x: 0, y: 0 };
    positions.set(row.id, { x, y });
    bounds.set(row.id, {
      x: x + parent.x,
      y: y + parent.y,
      width: w,
      height: h,
    });
    rows.push(row);
  };
  const traces = [
    ...new Set([
      ...view.traces.map((t) => t.id),
      ...view.spans.map((s) => s.traceId ?? "unassigned"),
      ...view.turns.map((t) => t.traceId ?? "unassigned"),
    ]),
  ];
  let questionY = 0;
  for (const traceId of traces) {
    const promptId = `prompt:${traceId}`;
    const traceSpans = view.spans.filter(
      (s) => (s.traceId ?? "unassigned") === traceId,
    );
    const traceTurns = [
      ...new Set([
        ...view.turns
          .filter(
            (t) =>
              (t.traceId ?? "unassigned") === traceId ||
              traceSpans.some((s) => s.turnId === t.id),
          )
          .map((t) => t.id),
        ...traceSpans.map((s) => s.turnId ?? `unassigned:${traceId}`),
      ]),
    ];
    const closed = options.collapsedQuestions?.has(traceId);
    const lanes = traceTurns.map((id) => ({
      id,
      calls: options.collapsed?.has(id)
        ? []
        : traceSpans.filter(
            (s) => (s.turnId ?? `unassigned:${traceId}`) === id,
          ),
      height: options.collapsed?.has(id) ? 56 : 124,
    }));
    const laneWidth = Math.max(
      420,
      ...lanes.map(
        (lane) =>
          lead +
          lane.calls.length * (width + GRAPH_COLUMN_GAP) -
          (lane.calls.length ? GRAPH_COLUMN_GAP : 0) +
          16,
      ),
    );
    const questionWidth = closed ? 420 : laneWidth + 64;
    const questionHeight = closed
      ? 68
      : 64 +
        lanes.reduce((sum, lane) => sum + lane.height + GRAPH_ROW_GAP, 0) +
        4;
    add(
      { id: promptId, kind: "question", entityId: traceId, traceId },
      0,
      questionY,
      questionWidth,
      questionHeight,
    );
    if (!closed) {
      let y = 64;
      for (const lane of lanes) {
        turns.push(lane.id);
        const turnId = `turn:${lane.id}`;
        add(
          {
            id: turnId,
            kind: "turn",
            entityId: lane.id,
            traceId,
            turnId: lane.id,
            parentId: promptId,
          },
          16,
          y,
          laneWidth,
          lane.height,
        );
        lane.calls.forEach((span, index) =>
          add(
            {
              id: span.id,
              kind: "call",
              entityId: span.id,
              traceId,
              turnId: lane.id,
              parentId: turnId,
            },
            lead + index * (width + GRAPH_COLUMN_GAP),
            16,
            width,
            GRAPH_NODE_HEIGHT,
          ),
        );
        y += lane.height + GRAPH_ROW_GAP;
      }
    }
    questionY += questionHeight + GRAPH_QUESTION_GAP;
  }
  return { turns, positions, bounds, rows };
}
