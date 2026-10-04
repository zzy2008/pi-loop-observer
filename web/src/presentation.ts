import type { ProjectedSpan } from "../../src/model/index.js";
import { formatDuration, type Language } from "./timing";
export const status: Record<string, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  unknown: "Unknown",
};
export const stage: Record<string, string> = {
  "awaiting-output": "Awaiting output",
  "thinking-output": "Thinking",
  "text-output": "Text output",
  "tool-args-output": "Tool arguments",
  "tool-running": "Tool running",
  "waiting-user": "Waiting for user",
};
const zhStatus: Record<string, string> = {
  running: "运行中",
  completed: "完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "记录中断",
  unknown: "未知",
};
const zhStage: Record<string, string> = {
  "awaiting-output": "等待输出",
  "thinking-output": "思考输出",
  "text-output": "文本输出",
  "tool-args-output": "工具参数输出",
  "tool-running": "工具执行",
  "waiting-user": "等待用户",
};
export const statusLabel = (value: string, language: Language = "en") =>
  (language === "zh" ? zhStatus : status)[value] ?? value;
export const stageLabel = (value: string, language: Language = "en") =>
  (language === "zh" ? zhStage : stage)[value] ?? value;
export const duration = (span: ProjectedSpan, language: Language = "en") =>
  `${span.estimated ? (language === "zh" ? "约 " : "~ ") : ""}${formatDuration(span.durationMs, language)}`;

export function qualityLabel(value:string, language:Language='en'):string {
  const labels:Record<string,[string,string]>={
    '缺失开始事件':['Start event missing','缺失开始事件'],
    '采集结束，执行终点未记录':['Recording ended; execution endpoint not recorded','采集结束，执行终点未记录'],
    observed:['Observed clock','观测时钟'], measured:['Measured','实测'],partial:['Partial','部分记录'],unknown:['Unknown','未知'],
  };
  if(labels[value]) return labels[value][language==='zh'?1:0];
  if(value.startsWith('不支持的事实类型：')) return language==='zh'?value:`Unsupported fact type: ${value.split('：')[1]}`;
  return value;
}
