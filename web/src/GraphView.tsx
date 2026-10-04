import React, { memo, useMemo, useRef, useState, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Position,
  PanOnScrollMode,
  type Node,
  type Edge,
  type ReactFlowInstance,
  type NodeChange,
} from "@xyflow/react";
import type { Projection } from "../../src/model/index.js";
import { layoutSpans } from "./graph-layout";
import { nameOf, type DisplayIndex } from "./display-model";
import { formatDuration, formatTimestamp } from "./timing";
import { useI18n } from "./i18n";
import "./graph-v2.css";
export const Graph = memo(function Graph({
  view,
  selected,
  onSelect,
  collapsed,
  onToggleTurn,
  display,
}: {
  view: Projection;
  selected?: string;
  onSelect: (id: string) => void;
  collapsed: Set<string>;
  onToggleTurn: (id: string) => void;
  display?: DisplayIndex;
}) {
  const { language, t } = useI18n();
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
    return {
      id: row.id,
      position: layout.positions.get(row.id)!,
      data: {
        label: (
          <div
            className={`observer-tree-node ${span?.state ?? "group"}`}
            tabIndex={span ? 0 : undefined}
            role={span ? "button" : undefined}
            aria-label={label}
            onKeyDown={(event) => {
              if (span && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                event.stopPropagation();
                onSelect(span.id);
              }
            }}
          >
            <small>
              {row.kind === "question"
                ? t("QUESTION", "问题")
                : row.kind === "turn"
                  ? "TURN"
                  : span?.kind === "llm"
                    ? "LLM"
                    : "TOOL"}
            </small>
            <strong title={label}>{label}</strong>
            {span ? (
              <>
                <span>
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
                  )}{" "}
                  · {span.estimated ? "≈ " : ""}
                  {formatDuration(span.durationMs, language)}
                </span>
                <small title={formatTimestamp(timestamp, language)}>
                  {timestamp
                    ? new Date(timestamp.wallMs).toLocaleTimeString(
                        language === "zh" ? "zh-CN" : "en-GB",
                      )
                    : t("Start not recorded", "起点未记录")}
                </small>
              </>
            ) : (
              <>
                <span>
                  {calls.length} {t("calls", "个调用")} ·{" "}
                  {row.kind === "question"
                    ? trace?.settled
                      ? t("Settled", "已稳定")
                      : t("In progress", "进行中")
                    : turn?.completed
                      ? t("Completed", "已结束")
                      : t("In progress", "进行中")}
                </span>
                <button
                  className="nodrag nopan"
                  aria-expanded={!closed}
                  onClick={(event) => {
                    event.stopPropagation();
                    row.kind === "question"
                      ? toggleQuestion(row.entityId)
                      : onToggleTurn(row.entityId);
                  }}
                >
                  {closed ? t("Expand", "展开") : t("Collapse", "折叠")}
                </button>
              </>
            )}
          </div>
        ),
      },
      selected: row.entityId === selected,
      sourcePosition: Position.Left,
      targetPosition: Position.Left,
      draggable: false,
      style: {
        width: narrow ? 230 : 280,
        height: 130,
        padding: 0,
        borderRadius: 10,
        background: "#14251f",
        color: "#eefaf3",
        borderColor:
          row.entityId === selected
            ? "#a2f9c6"
            : row.kind === "question"
              ? "#749d87"
              : "#466756",
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
    return [
      {
        id,
        source,
        target,
        type: "smoothstep",
        label: t(
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
        labelStyle: { fill: "#b7d4c4", fontSize: 10 },
        labelBgStyle: { fill: "#14251f" },
        style: { stroke: "#6f9981", strokeDasharray: "3 4", opacity: 0.7 },
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
        node.position.x + (narrow ? 115 : 140),
        node.position.y + 65,
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
            "Scroll to explore · connectors show observed relationships",
            "滚动查看 · 连线表示真实观测关系",
          )}
        </span>
        <button
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
          {t("Focus selected / active call", "聚焦所选 / 当前调用")}
        </button>
      </div>
      <ReactFlow<Node, Edge>
        nodes={nodes.map((node) => ({
          ...node,
          measured: measurements.get(node.id),
        }))}
        edges={edges}
        onNodesChange={recordMeasurements}
        onNodeClick={(_, node) => {
          if (node.id.startsWith("prompt:")) toggleQuestion(node.id.slice(7));
          else if (node.id.startsWith("turn:")) onToggleTurn(node.id.slice(5));
          else onSelect(node.id);
        }}
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Vertical}
        zoomOnScroll={false}
        nodesDraggable={false}
        nodesConnectable={false}
        deleteKeyCode={null}
        onInit={(flow) => {
          instance.current = flow;
        }}
        defaultViewport={{ x: narrow ? 12 : 40, y: 24, zoom: 1 }}
        minZoom={0.25}
        maxZoom={2}
      >
        <Background color="#30423c" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </>
  );
});
