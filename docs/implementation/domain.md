# 领域模型与事件契约

返回[设计总览](README.md)。本页定义跨进程与跨前端复用的 Interface；类型示意属于拟实现的 Observer 契约，不是 Pi 原生 API。

## 1. 实体与粒度

| 实体 | 意义 | 身份 / 约束 |
| --- | --- | --- |
| Session | Pi 会话记录所属容器 | `sessionKey` 是数据源命名空间与 Pi sessionId 的组合；无会话文件也要有身份 |
| BranchSelection | 当前选择的历史分支 | 记录 `oldLeafId/newLeafId`；Pi 没有需假定存在的固定 branchId |
| Producer | 一次采集器实例 | 每次启动/reload 生成新 UUID；不要使用 PID 作为持久身份 |
| Run | 一次底层 agent_start/end 活动 | Producer 内递增或 UUID；与用户问题不要求一对一 |
| Trace / Prompt | 用户视角的一次问题 | 普通输入或 followUp 被应用后建立；steer 附着现有 trace |
| Turn | 一轮 assistant 及相关工具执行 | 由 Run + turnIndex 定位；turnIndex 可能在下一个 Run 重置 |
| LLM Span | 一次可观察的 assistant 响应生成 | 每次 assistant message_start 建节点；明确标记观察层为 assistant-message |
| Tool Span | 一次工具执行 | toolCallId 必须放在 session/producer/run 或模型响应作用域下 |
| Message / Payload | 输入、输出、thinking、参数、结果 | 作为节点详情，不额外计成一次 LLM 调用 |
| SourceEntry | Pi 原始会话条目归档 | sessionKey + entryId + revisionHash |
| Binding | SourceEntry 与运行实体的明确关联 | 独立追加事件；不得静默改写旧事件 |

**调用层限制**：assistant 响应通常对应模型调用，但不保证等于底层每次 HTTP 尝试。首版展示可证实的响应节点；没有 request ID 的自动重试/嵌套请求，不应按相邻 provider hook 强行拼装 span。详情标明观测粒度，后续可在明确身份下增加 attempt 子层。

## 2. 三种关系分别保存

1. 会话父链：`sourceEntry.parentId`，用于历史分支与上下文导航。
2. 包含关系：trace → turn → span，用于折叠和分组。
3. 执行关系：assistant 发出 toolCall、toolResult 被后续 assistant 消费。需要事件/内容证据。

工具 A 与工具 B 连续写入会话，不代表 A → B 依赖。并行由实际时间区间与调度证据表达；仅有历史条目时标为同轮工具，不能伪造重叠时间。

## 3. 身份、顺序、时间

### 身份与双序号

- `eventId`：Observer 生成的不变 UUID，重试不得换 ID。
- `producerSeq`：同 Producer 的持久事件顺序，发送前最终确定，从 1 开始。
- `cursor`：SQLite 提交后分配的全库递增序号，用于查询/SSE；线上传十进制字符串，避免 JS 64 位整数精度问题。
- `sessionKey`：所有 HTTP/SSE 事件都带；会话切换必须切换上下文，不能修改待发送旧事件的 sessionKey。
- `spanId`：Observer 身份，sourceEntryKey 是其可选关联。后补关联不能让同一次调用显示成两个节点。

`producerSeq` 不和 `cursor` 混用。按 session 过滤后的 cursor 不连续是正常现象；不能把跳号视为丢事件。同 Producer seq 应连续，服务发现缺号要求重传或明确 gap 声明。

### 两类时间

```ts
type Cursor = string; // 十进制非负整数；比较时使用 BigInt

type ObservedTime = {
  wallMs: number;
  monoMs: number | null;
  clockId: string | null; // 同一采集 epoch 的单调时钟域
};
```

- 精确持续时间仅对相同 clockId 的 start/end 相减。
- wallMs 用于跨来源显示和排序提示，不保证跨进程精确同步。
- 服务另存 receivedAt；网络接收时间不能当成工具执行时间。
- 导入旧会话只有条目时间时，保存 `timingQuality: 'unknown'`，不能用相邻条目差推算持续时间。
- 服务重启确认缺失的终点可记录“发现中断时间”，但不作为已测量的执行结束时间。
- 同时有多个时钟域的 trace 分段展示，或标注估算；不得静默生成精确共享耗时。

## 4. 标准事件信封

```ts
type EventDraft = {
  schemaVersion: 1;
  eventId: string;
  producerId: string;
  producerSeq: number;
  sessionKey: string;
  source: 'pi-live' | 'pi-import' | 'observer';
  observedAt: ObservedTime;
  refs: {
    runId?: string;
    traceId?: string;
    turnId?: string;
    spanId?: string;
    sourceEntryId?: string;
    toolCallId?: string;
  };
  fact: Fact; // 以下事件表对应的判别联合
};
type StoredEvent = EventDraft & { cursor: Cursor; receivedAt: number };
```

`refs` 表示事件产生时已知的关联，可以缺省；后续增加 `entity.bound`。不能在写入后修改原 refs 来改变过去回放时的已知信息。

建议 Fact 判别表：

| type | 最小 payload | 归约行为 |
| --- | --- | --- |
| `capture.started` | reason、capabilities、leafId | 新建采集 epoch 与质量说明 |
| `input.submitted` | submissionId、mode、contentRef | 记录排队/待关联，不提前启动执行 |
| `input.applied` | submissionId 可空、traceId、entryId 可空、kind | 确认问题起点或 steer 生效；无证据 kind=unclassified |
| `run.started` / `run.ended` | runId；end outcome 可空 | 底层活动分段，不直接封闭用户 trace |
| `turn.started` / `turn.ended` | turnId、runId、turnIndex | 更新 turn 生命周期 |
| `span.started` | spanId、kind、name、scope、timingBasis | 建立活动节点 |
| `span.stage_changed` | spanId、stage、contentIndex 可空 | 保存可回放的阶段边界 |
| `span.ended` | spanId、outcome、contentRef 可空 | 关闭活动节点，连接最终内容 |
| `message.finalized` | messageKey、role、contentRef、sourceKind | 保存完整结果；工具执行结果与最终会话结果可区分 |
| `entry.archived` | sourceEntryKey、parentId、revisionHash、contentRef | 保存历史内容与父链 |
| `entity.bound` | canonicalSpanId、entryKey、aliasSpanId 可空、evidence | 关联归档条目；折叠重复节点但保留来源 |
| `relation.observed` | from、to、relationKind、evidence | 增加有根据的执行关系 |
| `branch.selected` | oldLeafId、newLeafId | 切换视图分支；不删除离开分支 |
| `run.settled` | runId 可空、outcomeKnown | 标记没有自动后续工作，完成符合条件的 trace |
| `capture.gap` | scope、reason、lostSeqRange 可空、counts | 数据质量降级，不伪造执行失败 |
| `capture.stopped` | reason、clean | 结束采集者；仍活动 span 按证据标记中断/未知 |

实际类型应把 started/ended、role、内容结构写成判别联合，不用任意 `Record<string, any>` 代替所有事件。schemaVersion=1 的未知事实类型应保留并告知不支持，不能直接丢弃后显示“记录完整”。

## 5. 状态与质量分开

```ts
type SpanState = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
type Stage = 'awaiting-output' | 'thinking-output' | 'text-output' | 'tool-args-output' | 'tool-running';
type Quality = { timing: 'measured' | 'partial' | 'unknown'; gaps: string[]; association: 'exact' | 'unresolved' };
```

- 状态终结时不以 preview 更新倒退成 running；迟到的更正通过明确事实处理。
- 一个 assistant 响应可以交替输出 thinking/text/tool-args；按 contentIndex 保存区块进度，阶段标签表示可观察输出，不表示模型内部推理步骤。
- 顶部当前活动是 span 集合；不能只保留最后一个事件。
- 等待用户是 run/工具上的活动标记，优先使用 ui_prompt_start/end 的证据。嵌套 prompt 没有 ID 时使用计数与配对规则，缺失则显示未知。
- 工具失败不自动让 trace 失败；后续模型可能成功处理。trace 结论依赖最终消息和 settled/明确取消证据。
- 历史 toolResult 可以证明工具结果成功/失败，但未必有可测时长；质量可同时为 unknown。

## 6. Model Module

```ts
interface ModelInterface {
  reduce(state: SessionState, event: StoredEvent): SessionState;
  project(state: SessionState, selection: ViewSelection): TraceView;
}
```

Implementation：

1. state 用 session、traces、turns、spans、entries、bindings、relations 的索引 Map 组织，持久 DTO 用可序列化数组/对象。
2. reducer 按已提交 cursor 顺序处理。网络去重在 Client/Recorder 完成；reducer 对重复结束等语义仍要有确定行为。
3. 结束先于开始时创建不完整实体；后续开始若确实可对应，补充信息但保留观察缺口。
4. source entry 晚到后，用 binding 归并 provisional 节点与 imported 节点。binding 必须明确 canonicalSpanId；旧 ID 进入 alias 表，选择状态通过 alias 迁移。
5. 不读 Date.now、DOM、磁盘。运行中时长由 `project(state, {now})` 接收时钟；replay 使用固定游标时间。
6. 不把最终字段直接填进所有历史状态。只有相应 fact 已被回放，才能显示这些字段。
7. `reduce(prefix)` 是测试主入口；固定样例运行两遍必须得到相同状态。

## 7. 内容及回放可见性

内容块归档为 Payload，至少携带 mimeType、byteLength、sha256、encoding、完整性与来源。对于工具大输出，界面摘要截断和存储截断分开；如实际丢弃了尾部，必须记录 `truncated=true` 和缺失原因。

首版保存最终正文/工具结果与阶段事实，流式文字预览为临时数据。历史回放到“输出中”时，只承诺展示输出中状态；最终正文只有完成事件之后才自动可见。若用户主动查看完成后详情，使用单独模式和醒目标识。

内容后续被其他 Pi 扩展改写时，`tool_execution_end` 观察值与 session 最终值可能不同。默认“会话最终内容”，必要时另列“执行时结果”；禁止静默覆盖原观察事实。

## 8. 能力声明

`capture.started` / 导入摘要携带 capabilities，例如 `observedStages`、`turnEntryBinding`、`inputAttribution`、`providerAttemptIdentity`、`clockDomains`。字段描述证据范围，不用一个笼统 `complete=true` 代表所有能力。

旧会话通常有内容但没有 observedStages；有 turn_end 条目 ID 的路径可精确绑定；providerAttemptIdentity 默认 unavailable。inputAttribution 在 P0 通过哪些输入场景就声明哪些场景，未通过者保持 unresolved。前端据此决定是否展示耗时、阶段回放和输入生效位置。

## 9. 领域测试

- 两轮 LLM、两并行工具、一失败恢复；实体数、关系、耗时与活动集合准确。
- 同名工具多次执行、不同 session 相同 toolCallId、run 重置 turnIndex 不串线。
- 重复、迟到、缺失开始、取消、采集重启；质量与执行结果分离。
- 旧会话导入无耗时；关联后不重复节点；Pi 源文件删除后详情仍可读。
- replay 前缀不出现未来节点/内容；实时和完整重放投影相同。
