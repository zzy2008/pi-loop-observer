import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ProjectedSpan, Projection } from "../../src/model/index.js";
import {
  statusLabel,
  stageLabel,
  duration,
  qualityLabel,
} from "./presentation";
import { useI18n, errorMessage } from "./i18n";
import { nameOf, type DisplayIndex } from "./display-model";
import { formatTimestamp } from "./timing";
import { loadPayload } from "./client";
function PayloadView({
  id,
  sessionKey,
  cursor,
  empty,
}: {
  id?: string;
  sessionKey: string;
  cursor: string;
  empty: string;
}) {
  const { language, t } = useI18n();
  const [page, setPage] = useState<{
    text: string;
    next: number;
    done: boolean;
    truncated: boolean;
    error?: string;
  }>({ text: "", next: 0, done: true, truncated: false });
  const [offset, setOffset] = useState(0);
  const decoder = useRef(new TextDecoder());
  useEffect(() => {
    setOffset(0);
    setPage({ text: "", next: 0, done: true, truncated: false });
    decoder.current = new TextDecoder();
  }, [id, sessionKey, cursor]);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    loadPayload(id, sessionKey, cursor, controller.signal, offset)
      .then((payload) => {
        if (controller.signal.aborted) return;
        const bytes = Uint8Array.from(atob(payload.data ?? ""), (c) =>
          c.charCodeAt(0),
        );
        const text =
          payload.encoding === "base64"
            ? decoder.current.decode(bytes, { stream: !payload.done })
            : (payload.data ?? "");
        setPage((old) => ({
          text: offset === 0 ? text : old.text + text,
          next: payload.nextOffset ?? 0,
          done: payload.done ?? true,
          truncated: payload.completeness?.truncated ?? false,
        }));
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setPage((old) => ({ ...old, error: String(error) }));
      });
    return () => controller.abort();
  }, [id, sessionKey, cursor, offset]);
  return (
    <>
      {page.error && <p role="alert">{errorMessage(page.error, language)}</p>}
      {page.truncated && (
        <p className="warning">
          {t(
            "Stored content was truncated; the record is incomplete.",
            "存储内容已截断，记录不完整。",
          )}
        </p>
      )}
      <pre>{id ? page.text || t("Loading…", "载入中…") : empty}</pre>
      {!page.done && (
        <button onClick={() => setOffset(page.next)}>
          {t("Read next page (64 KiB)", "继续读取下一页（64 KiB）")}
        </button>
      )}
    </>
  );
}
export function Details({
  span,
  display,
  sessionKey,
  cursor,
}: {
  span?: ProjectedSpan;
  display: DisplayIndex;
  sessionKey: string;
  cursor: string;
}) {
  const { language, t } = useI18n();
  if (!span)
    return (
      <aside className="details">
        <h2>{t("Call details", "调用详情")}</h2>
        <p>
          {t(
            "Select a call node or time bar to inspect its record.",
            "点击调用节点或时间条查看记录。",
          )}
        </p>
      </aside>
    );
  return (
    <aside className="details">
      <small>
        {span.kind === "llm"
          ? t("Observation: assistant message", "观测粒度：assistant message")
          : t("Tool execution", "工具执行")}
      </small>
      <h2>{nameOf(display, span.id, span.name)}</h2>
      <dl>
        <dt>{t("Status", "状态")}</dt>
        <dd>{statusLabel(span.state, language)}</dd>
        <dt>{t("Duration", "耗时")}</dt>
        <dd>{duration(span, language)}</dd>
        <dt>{t("Start", "开始")}</dt>
        <dd>{formatTimestamp(span.start, language)}</dd>
        <dt>{t("End", "结束")}</dt>
        <dd>{formatTimestamp(span.end, language)}</dd>
        <dt>{t("Source", "来源")}</dt>
        <dd>{span.source}</dd>
        <dt>{t("Association", "关联")}</dt>
        <dd>
          {span.quality.association === "exact"
            ? t("Exact association", "精确关联")
            : t("Unassociated", "未关联")}
        </dd>
        <dt>{t("Model", "模型")}</dt>
        <dd>{span.model ?? t("Not recorded", "未记录")}</dd>
      </dl>
      {span.quality.gaps.map((g) => (
        <p className="warning" key={qualityLabel(g, language)}>
          {qualityLabel(g, language)}
        </p>
      ))}
      <h3>{t("Input", "输入")}</h3>
      <PayloadView
        key={`input-${span.id}-${span.inputRef}`}
        id={span.inputRef}
        sessionKey={sessionKey}
        cursor={span.inputCursor ?? cursor}
        empty={t("Not recorded", "未记录")}
      />
      <h3>{t("Output", "输出")}</h3>
      <PayloadView
        key={`output-${span.id}-${span.outputRef}`}
        id={span.outputRef}
        sessionKey={sessionKey}
        cursor={span.outputCursor ?? cursor}
        empty={t(
          "Final output is not yet recorded at this stage",
          "当前阶段尚未记录最终输出",
        )}
      />
      <h3>{t("Observed stages", "已观察阶段")}</h3>
      {span.stages.map((s, i) => (
        <p key={i}>
          {stageLabel(s.stage, language)} · {t("Cursor", "游标")} {s.cursor}
        </p>
      ))}
      <details>
        <summary>{t("Identity and provenance", "身份与来源")}</summary>
        <pre>
          {JSON.stringify(
            {
              id: span.id,
              traceId: span.traceId,
              turnId: span.turnId,
              runId: span.runId,
              entryKey: span.entryKey,
              quality: span.quality,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </aside>
  );
}
