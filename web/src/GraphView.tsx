import React, { memo, useMemo, useRef, useState, useEffect } from "react";
import {
  ReactFlow,
  Background,
  BaseEdge,
  getSmoothStepPath,
  type EdgeProps,
  Position,
  MarkerType,
  PanOnScrollMode,
  type Node,
  type Edge,
  type ReactFlowInstance,
  type NodeChange,
} from "@xyflow/react";
import type { Projection } from "../../src/model/index.js";
import { GRAPH_COLUMN_GAP, layoutSpans } from "./graph-layout";
import { nameOf, scopedName, type DisplayIndex } from "./display-model";
import { formatDuration, formatTimestamp } from "./timing";
import { useI18n } from "./i18n";
import { useTimeLabels } from "./useTimeLabels";
import { statusLabel } from "./presentation";
import "./graph-v2.css";
// Long observed relationships pass above the lane instead of crossing intermediate cards.
function ObservedEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY } = props;
  const route = props.data?.route as
    { right: number; bottom: number; top: number } | undefined;
  const sameRow = Math.abs(sourceY - targetY) < 1;
  const detour = sameRow && Math.abs(targetX - sourceX) > GRAPH_COLUMN_GAP + 1;
  const [path, labelX, labelY] =
    !sameRow && route
      ? [
          `M ${sourceX} ${sourceY} L ${sourceX + 12} ${sourceY} L ${sourceX + 12} ${route.bottom} L ${route.right} ${route.bottom} L ${route.right} ${route.top} L ${targetX - 12} ${route.top} L ${targetX - 12} ${targetY} L ${targetX} ${targetY}`,
          (sourceX + route.right) / 2,
          route.bottom,
        ]
      : detour
        ? [
            `M ${sourceX} ${sourceY} L ${sourceX + 12} ${sourceY} L ${sourceX + 12} ${sourceY - 57} L ${targetX - 12} ${targetY - 57} L ${targetX - 12} ${targetY} L ${targetX} ${targetY}`,
            (sourceX + targetX) / 2,
            sourceY - 57,
          ]
        : getSmoothStepPath(props);
  return (
    <BaseEdge
      id={props.id}
      path={path}
      markerEnd={props.markerEnd}
      style={props.style}
      label={props.label}
      labelX={labelX}
      labelY={labelY}
      labelStyle={props.labelStyle}
      labelBgStyle={props.labelBgStyle}
    />
  );
}
const edgeTypes = { observed: ObservedEdge };

type NodeKind = "question" | "turn" | "llm" | "tool";
function NodeIcon({ kind }: { kind: NodeKind }) {
  const paths: Record<NodeKind, string> = {
    question:
      "M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z M7 8h10 M7 12h7",
    turn: "m12 3 9 5-9 5-9-5 9-5Z M3 12l9 5 9-5 M3 16l9 5 9-5",
    llm: "M7 7h10v10H7Z M10 10h4v4h-4Z M9 3v4 M15 3v4 M9 17v4 M15 17v4 M3 9h4 M3 15h4 M17 9h4 M17 15h4",
    tool: "M14 4a6 6 0 0 0-7 7L3 15a3 3 0 0 0 4 4l4-4a6 6 0 0 0 7-7l-4 4-4-4 4-4Z",
  };
  return (
    <svg
      className="observer-kind-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[kind]} />
    </svg>
  );
}
function StatusIcon({ state }: { state: string }) {
  const paths: Record<string, string> = {
    completed: "m4 8 3 3 5-6",
    running: "M8 3a5 5 0 1 1-5 5 M8 5v3l2 1",
    failed: "m5 5 6 6 M11 5l-6 6",
    cancelled: "M3 8a5 5 0 1 0 10 0 5 5 0 0 0-10 0 M5 11l6-6",
    interrupted: "M6 4v8 M10 4v8",
    unknown: "M6 5a2 2 0 1 1 3 2c-1 0-1 1-1 2 M8 12v.1",
  };
  return (
    <svg
      className="observer-status-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[state] ?? paths.unknown} />
    </svg>
  );
}

export const Graph = memo(function Graph({
  view,
  selected,
  onSelect,
  collapsed,
  onToggleTurn,
  display,
  animateTime = false,
}: {
  view: Projection;
  selected?: string;
  onSelect: (id: string) => void;
  collapsed: Set<string>;
  onToggleTurn: (id: string) => void;
  display?: DisplayIndex;
  animateTime?: boolean;
}) {
  const { language, t } = useI18n();
  const timeLabel = useTimeLabels(animateTime);
  const instance = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [questions, setQuestions] = useState<Set<string>>(new Set());
  // Preserve measured sizes across every live projection rebuild.
  const [measurements, setMeasurements] = useState<
    Map<string, { width: number; height: number }>
  >(new Map());
  const recordMeasurements = (changes: NodeChange[]) => {
    setMeasurements((previous) => {
      let next = previous;
      for (const change of changes) {
        if (change.type !== "dimensions" || !change.dimensions) continue;
        const old = previous.get(change.id);
        if (
          old?.width === change.dimensions.width &&
          old?.height === change.dimensions.height
        )
          continue;
        if (next === previous) next = new Map(previous);
        next.set(change.id, change.dimensions);
      }
      return next;
    });
  };
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width:767px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width:767px)");
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const call = view.spans.find((span) => span.id === selected);
    if (!call) return;
    const traceId = call.traceId ?? "unassigned";
    setQuestions((previous) => {
      if (!previous.has(traceId)) return previous;
      const next = new Set(previous);
      next.delete(traceId);
      return next;
    });
    if (call.turnId && collapsed.has(call.turnId)) onToggleTurn(call.turnId);
  }, [selected]);
  const structure = JSON.stringify([
    view.spans.map((s) => [s.id, s.traceId, s.turnId]),
    view.turns.map((s) => [s.id, s.traceId]),
    view.traces.map((s) => s.id),
  ]);
  const layout = useMemo(
    () =>
      layoutSpans(view, { collapsed, collapsedQuestions: questions, narrow }),
    [structure, collapsed, questions, narrow],
  );
  const toggleQuestion = (id: string) =>
    setQuestions((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const nodes: Node[] = layout.rows.map((row) => {
    const span = view.spans.find((s) => s.id === row.entityId);
    const turn = view.turns.find((s) => s.id === row.entityId);
    const trace = view.traces.find((s) => s.id === row.entityId);
    const calls = view.spans.filter((s) =>
      row.kind === "question"
        ? s.traceId === row.traceId
        : (s.turnId ?? `unassigned:${s.traceId ?? "unassigned"}`) ===
          row.turnId,
    );
    const closed =
      row.kind === "question"
        ? questions.has(row.entityId)
        : collapsed.has(row.entityId);
    const label = nameOf(
      display,
      row.entityId,
      span?.name ?? trace?.label ?? t("Unassigned turn", "未关联轮次"),
    );
    const timestamp = span?.start ?? calls.find((s) => s.start)?.start;
    const kind: NodeKind =
      row.kind === "call" ? (span?.kind ?? "tool") : row.kind;
    const kindLabel = {
      question: t("Question", "问题"),
      turn: t("Turn", "轮次"),
      llm: "LLM",
      tool: t("Tool", "工具"),
    }[kind];
    const accessibleLabel = `${kindLabel} · ${label}${span ? ` · ${statusLabel(span.state, language)}` : ""}`;
    return {
      id: row.id,
      ariaLabel: accessibleLabel,
      className: `observer-graph-card node-kind-${kind} ${row.kind !== "call" ? `graph-container ${closed ? "is-collapsed" : "is-expanded"}` : ""}`,
      parentId: row.parentId,
      extent: row.parentId ? "parent" : undefined,
      zIndex: row.kind === "question" ? 0 : row.kind === "turn" ? 1 : 2,
      position: layout.positions.get(row.id)!,
      data: {
        label:
          row.kind !== "call" ? (
            <div className={`observer-container-heading container-${row.kind}`}>
              <small className="observer-node-type">
                <NodeIcon kind={kind} />
                {kindLabel}
              </small>
              <strong title={label}>
                {row.kind === "turn"
                  ? scopedName(label, language, { question: true })
                  : label}
              </strong>
              <span className="container-summary">
                {calls.length} {t("calls", "个调用")} ·{" "}
                {row.kind === "question"
                  ? trace?.settled
                    ? t("Settled", "已结束")
                    : t("In progress", "进行中")
                  : turn?.completed
                    ? t("Completed", "完成")
                    : t("In progress", "进行中")}
              </span>
              <button
                className="nodrag nopan observer-node-toggle"
                aria-label={
                  closed ? t("Expand", "展开") : t("Collapse", "折叠")
                }
                aria-expanded={!closed}
                onClick={(event) => {
                  event.stopPropagation();
                  row.kind === "question"
                    ? toggleQuestion(row.entityId)
                    : onToggleTurn(row.entityId);
                }}
              >
                {row.kind === "turn" || narrow
                  ? closed
                    ? "▸"
                    : "▾"
                  : closed
                    ? t("Expand", "展开")
                    : t("Collapse", "折叠")}
              </button>
            </div>
          ) : (
            <div
              className={`observer-tree-node ${span?.state ?? "group"}`}
              tabIndex={span ? 0 : undefined}
              role={span ? "button" : undefined}
              aria-label={accessibleLabel}
              onKeyDown={(event) => {
                if (span && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(span.id);
                }
              }}
            >
              <div className="observer-node-heading">
                <small className="observer-node-type">
                  <NodeIcon kind={kind} />
                  {kindLabel}
                </small>
                {span && (
                  <span className={`observer-node-status status-${span.state}`}>
                    <StatusIcon state={span.state} />
                    {t(
                      (
                        {
                          running: "Running",
                          completed: "Completed",
                          failed: "Failed",
                          cancelled: "Cancelled",
                          interrupted: "Interrupted",
                          unknown: "Unknown",
                        } as const
                      )[span.state],
                      (
                        {
                          running: "运行中",
                          completed: "完成",
                          failed: "失败",
                          cancelled: "已取消",
                          interrupted: "记录中断",
                          unknown: "未知",
                        } as const
                      )[span.state],
                    )}
                  </span>
                )}
              </div>
              <strong title={label}>
                {scopedName(label, language, { question: true, turn: true })}
              </strong>
              <div className="observer-node-timing">
                <span
                  title={formatDuration(span?.durationMs ?? null, language)}
                >
                  {span?.estimated ? "≈ " : ""}
                  {timeLabel(
                    span?.id ?? row.id,
                    span?.durationMs ?? null,
                    span?.state !== "running",
                  )}
                </span>
                <small title={formatTimestamp(timestamp, language)}>
                  {timestamp
                    ? new Date(timestamp.wallMs).toLocaleTimeString(
                        language === "zh" ? "zh-CN" : "en-GB",
                      )
                    : t("Start not recorded", "起点未记录")}
                </small>
              </div>
            </div>
          ),
      },
      selected: row.entityId === selected,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      draggable: false,
      style: {
        width: layout.bounds.get(row.id)!.width,
        height: layout.bounds.get(row.id)!.height,
        padding: 0,
        borderRadius: "var(--node-radius)",
        background: "var(--node-background)",
        color: "var(--text)",
        borderColor:
          row.entityId === selected ? "var(--accent)" : "var(--node-border)",
      },
    };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const visibleId = (id: string) => {
    const span = view.spans.find((s) => s.id === id);
    if (span && questions.has(span.traceId ?? "unassigned"))
      return `prompt:${span.traceId ?? "unassigned"}`;
    if (
      span &&
      collapsed.has(span.turnId ?? `unassigned:${span.traceId ?? "unassigned"}`)
    )
      return `turn:${span.turnId ?? `unassigned:${span.traceId ?? "unassigned"}`}`;
    return id;
  };
  const edgeKeys = new Set<string>();
  const resultLabels = new Set<string>();
  const edges: Edge[] = view.relations.flatMap((relation) => {
    const source = visibleId(relation.from),
      target = visibleId(relation.to),
      id = `${source}:${target}:${relation.kind}`;
    if (
      source === target ||
      !ids.has(source) ||
      !ids.has(target) ||
      edgeKeys.has(id)
    )
      return [];
    edgeKeys.add(id);
    const duplicateResultLabel =
      relation.kind === "result-consumed" && resultLabels.has(target);
    if (relation.kind === "result-consumed") resultLabels.add(target);
    const from = layout.bounds.get(source)!;
    const to = layout.bounds.get(target)!;
    const fromRow = layout.rows.find((r) => r.id === source)!;
    const question = layout.bounds.get(`prompt:${fromRow.traceId}`)!;
    const color =
      relation.kind === "calls"
        ? "var(--node-llm)"
        : relation.kind === "result-consumed"
          ? "var(--node-tool)"
          : "var(--muted)";
    return [
      {
        id,
        source,
        target,
        type: "observed",
        zIndex: 3,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 16,
          height: 16,
        },
        data: {
          route: {
            right: question.x + question.width - 16,
            bottom: from.y + from.height + 10,
            top: to.y - 8,
          },
        },
        label: duplicateResultLabel
          ? undefined
          : t(
              (
                {
                  calls: "Calls",
                  "result-consumed": "Result consumed",
                  sequence: "Observed sequence",
                  contains: "Contains",
                } as const
              )[relation.kind],
              (
                {
                  calls: "调用",
                  "result-consumed": "结果输入",
                  sequence: "观测顺序",
                  contains: "包含",
                } as const
              )[relation.kind],
            ),
        labelStyle: {
          fill: "var(--muted)",
          fontSize: "var(--font-caption)",
          fontFamily: "var(--font-sans)",
        },
        labelBgStyle: { fill: "var(--surface)" },
        style: {
          stroke: color,
          strokeWidth:
            selected && (relation.from === selected || relation.to === selected)
              ? 2.5
              : 1.6,
          opacity:
            selected && relation.from !== selected && relation.to !== selected
              ? 0.4
              : 1,
          strokeLinejoin: "round",
          strokeDasharray:
            relation.kind === "calls"
              ? undefined
              : relation.kind === "result-consumed"
                ? "6 3"
                : "2 4",
        },
      },
    ];
  });
  const focus = () => {
    const call =
      view.spans.find((s) => s.id === selected) ??
      view.active[0] ??
      view.spans[0];
    const node = call
      ? nodes.find((n) => n.id === visibleId(call.id))
      : nodes[0];
    if (node)
      void instance.current?.setCenter(
        layout.bounds.get(node.id)!.x + layout.bounds.get(node.id)!.width / 2,
        layout.bounds.get(node.id)!.y + layout.bounds.get(node.id)!.height / 2,
        { zoom: 1, duration: 0 },
      );
  };
  useEffect(() => {
    if (!selected) return;
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [selected, questions, collapsed]);
  return (
    <>
      <div className="graph-tools observer-tree-tools" ref={toolbar}>
        <span>
          {t(
            "Question groups · one turn per row · arrows show recorded relationships",
            "问题容器 · 每个轮次一行 · 箭头表示已记录关系",
          )}
        </span>
        <div
          className="graph-edge-legend"
          aria-label={t("Relationship legend", "关系图例")}
        >
          <span className="legend-calls">{t("Calls", "调用")}</span>
          <span className="legend-result">
            {t("Result consumed", "结果输入")}
          </span>
        </div>
        <div className="graph-actions">
          <button
            aria-label={t(
              "Focus selected / active call",
              "聚焦所选 / 当前调用",
            )}
            onClick={() => {
              focus();
              if (narrow)
                toolbar.current?.parentElement?.scrollIntoView({
                  block: "center",
                  behavior: "instant",
                });
            }}
            disabled={!nodes.length}
          >
            {narrow
              ? t("Focus call", "聚焦调用")
              : t("Focus selected / active call", "聚焦所选 / 当前调用")}
          </button>
          <div
            className="graph-zoom"
            role="group"
            aria-label={t("Graph zoom", "画布缩放")}
          >
            <button
              aria-label={t("Zoom in", "放大")}
              title={t("Zoom in", "放大")}
              onClick={() => void instance.current?.zoomIn()}
            >
              +
            </button>
            <button
              aria-label={t("Zoom out", "缩小")}
              title={t("Zoom out", "缩小")}
              onClick={() => void instance.current?.zoomOut()}
            >
              −
            </button>
            <button
              aria-label={t("Fit graph", "查看全图")}
              title={t("Fit graph", "查看全图")}
              onClick={() =>
                void instance.current?.fitView({ padding: 0.15, maxZoom: 1 })
              }
            >
              ⤢
            </button>
          </div>
        </div>
      </div>
      <ReactFlow<Node, Edge>
        nodes={nodes.map((node) => ({
          ...node,
          measured: measurements.get(node.id),
        }))}
        edges={edges}
        edgeTypes={edgeTypes}
        onNodesChange={recordMeasurements}
        onNodeClick={(_, node) => {
          if (node.id.startsWith("prompt:")) toggleQuestion(node.id.slice(7));
          else if (node.id.startsWith("turn:")) onToggleTurn(node.id.slice(5));
          else onSelect(node.id);
        }}
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Free}
        zoomOnScroll={false}
        nodesDraggable={false}
        nodesConnectable={false}
        deleteKeyCode={null}
        onInit={(flow) => {
          instance.current = flow;
        }}
        defaultViewport={{ x: narrow ? 12 : 40, y: 24, zoom: 1 }}
        minZoom={0.05}
        maxZoom={2}
      >
        <Background color="var(--grid)" />
      </ReactFlow>
    </>
  );
});
