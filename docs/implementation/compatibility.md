# Pi 兼容性证据

## Pi 1.3.0 升级验证

验证日期：2026-10-18，Node v24.18.1，开发依赖固定为 `@earendil-works/pi-coding-agent@1.3.0`。执行 `pnpm test:compat`，使用真实 SDK、隔离临时目录和人工 streamFunction；没有真实模型或收费 provider 请求。脚本为 `test/compatibility/pi-1.3.0.mjs`、`observer-sdk.mjs` 与 `observer-cancel-sdk.mjs`。

- SDK 实际发送 `tool_execution_end.durationMs`（包括合法的零值），采集为可选 `span.ended.durationMs`，模型存为 `executionDurationMs`，工具投影优先使用这项实际执行耗时。观察起终点仍保留，供时间轴使用。负数、NaN、Infinity 不接受。
- SDK 实际发送 `agent_settled.aborted:false`，采集保存显式布尔值并设 `outcomeKnown:true`；取消的 `true` 已由真实 SDK 的 `session.abort()` 覆盖，合成 stream 等待 AbortSignal 后返回 aborted；旧宿主缺字段由单元测试覆盖。`aborted:false` 只代表没有取消，不表示所有工具或模型都成功。
- 老事实没有新增字段时继续使用同一 clock domain 的观察耗时；JSONL 导入及缺乏时间证据的历史仍为 unknown，不补造 SDK 耗时或取消状态。无需数据库迁移。
- Pi 1.2 的 `before_agent_start` 返回联合类型不影响当前扩展：当前未订阅该事件。现有事件绑定、嵌套工具和独立持久服务路径继续经过实际 SDK 验证。

`observer-cancel-sdk.mjs` 在单独临时目录与 SDK 子进程运行取消场景，得到 21 条事实、1 个 cancelled LLM span、5 条归档。SDK 发出 `agent_settled.aborted:true`，Observer 持久事实包含 `outcomeKnown:true` 与 `aborted:true`；HTTP 读取并重放得到 `Trace.aborted=true`，SDK 进程退出后再次读取持久历史并重放仍通过。该场景不改变正常完成路径的 44 条事实验收。

以下保留首版 1.0.0 的历史验收记录；其中关于 run.settled 缺少结果的描述适用于旧宿主和旧事实。

## 首版 Pi 1.0.0 兼容性证据

验证日期：2026-10-04。实际宿主 `@earendil-works/pi-coding-agent@1.0.0`；macOS，Node v24.18.1。只读取安装包源码/类型，所有运行测试使用临时 cwd、临时 agentDir、内存 SessionManager、人工消息及工具。没有读取用户 session 或凭据，没有真实 LLM / HTTP provider 请求。

首版验收使用的命令（脚本现已升级为 `pi-1.3.0.mjs`，当前请执行 `pnpm test:compat`）：

```sh
pnpm exec vitest run test/unit/capture.test.ts test/unit/adapter.test.ts
node test/compatibility/pi-1.0.0.mjs
```

兼容性脚本默认解析项目安装的宿主，也允许 `PI_OBSERVER_TEST_HOST=/absolute/pi-coding-agent` 指向特定已安装包。脚本在 SDK agent 上替换 `streamFunction`，临时 runtime 的 `hasConfiguredAuth` 返回 true，仅绕过假 provider 的凭据预检；流、内容、工具结果全部是人工 fixture。SDK 实际执行事件 dispatch 和会话 append。结尾释放 SDK 并删除临时目录。

| 范围                                        | 结论        | 实际证据与首版行为                                                                                                                                                                                                                |
| ------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主循环顺序                                  | tested      | input → agent_start → turn_start → system/user start/end → assistant start/update/end → tools → turn_end → 下一轮 → agent_end → agent_settled。turn_start 早于 user start，模型在 span.started 后补 turn 的 trace 归属。          |
| 消息 append 顺序                            | tested      | assistant message_end 回调内 `getEntries()` 不含相同消息；turn_end 的 messageEntryId/toolResultEntryIds 全部 `getEntry()` 可读。message_end 不猜最后 entry。                                                                      |
| 最终条目绑定                                | tested      | assistant 使用唯一 turn 响应候选和 messageEntryId；工具取条目 role 与 toolCallId，测试打乱结果 ID 顺序仍正确绑定。执行结果与最终会话归档各自保留。                                                                                |
| 嵌套工具                                    | tested      | outer fixture 通过 ctx.executeTool 调 inner，tool_execution_start/end、tool_call/tool_result 实际携带 parentToolCallId=outer-call。嵌套节点记录执行关系；不虚构普通源条目。                                                       |
| 输入 ID                                     | unsupported | 公共 input keys 为 type/text/images/source/streamingBehavior，无 inputId 或稳定消费身份。submission 保留提交用途；applied 一律 unclassified，不用文本猜 steer/followUp。历史按原生 user 父链建立内容分组，归属仍标 unclassified。 |
| 同文排队、transform/handled、撤回、队列续行 | unknown     | 首版不声称精确归因。需要上游提供 submission/consumed-input ID 和稳定用途/撤回事实，才能准确表达 steer 附着及 followUp 新问题。                                                                                                    |
| provider_stream_event                       | unknown     | 声明/源码存在，但假 streamFunction 绕过 provider，所以本次没有验证真实 provider 路径。首版不依赖 provider hook，无 request-attempt 身份。                                                                                         |
| 取消、自动重试、reload 中断                 | partial     | 单元测试验证 stop 和会话 epoch 资源边界；没有运行真实 provider 重试路径。run.settled 没有 outcome，outcomeKnown=false。采集停止只中断未结束节点。                                                                                 |
| 队列/ACK                                    | tested      | 12 个模块行为测试包含不可变重传、确认丢失、单 inflight、有界溢出 gap、循环 payload 不影响 Pi。ACK 前不删除队列；close 取消 HTTP signal，flush 定时器释放。进程崩溃仍会丢未确认内存队尾。                                          |
| 自动记录/服务断线                           | tested      | adapter fixture 无浏览器时自动送批次；/obs 不重复 epoch。append 失败后重新 ensureService 并按原 ID 重传。storeId 变化停止旧 outbox，新 producerSeq=1，显式 gap 标明旧队尾与旧 ACK 数量。                                          |
| JSONL 导入                                  | tested      | v3 header、半行延迟、增量重读去重、修订保留、missing parent、工具 ID 明确关系。未知版本返回 unsupported-version。只打开显式选择的文件，不扫描用户目录。导入节点 timingBasis=unknown，无精确 duration。                            |

归档内容有显式 byte 限额，超过 512 KiB 的单个源 payload 保存截断标记及原因。首版没有实现大 payload 分块归档。队列容量默认 8 MiB；已接受 durable 事件不为腾空间而删除，拒绝事实最终转换为 capture.gap。归档初始超大 session 可能降级，不能报告完整记录。

`open [--data-dir path] [--session key] [--no-open]` 启动独立服务并打印一次性 ticket URL；`import <session.jsonl> [--data-dir path]` 向服务真实提交归档，通过 durable ACK 后报告。导入坏行/不完整尾部/缺父/队列拒绝会产生非零退出状态。CLI 退出释放 producer lease，不关闭独立服务。

## 实际构建产物接入 SDK 的主路径验收

执行 `pnpm build`，随后 `node test/compatibility/observer-sdk.mjs`。脚本启动独立 SDK 子进程，Pi 1.0.0 的实际扩展 factory 加载 `dist/adapter/index.js`，用隔离 agentDir/dataDir 和人工 streamFunction 执行两轮响应及 outer→inner 工具调用。运行期间没有浏览器，没有执行 `/obs`；结束后通过官方扩展 runner 发 `session_shutdown`，观察器完成持久 ACK 后，HTTP 查询实际独立服务/SQLite。

本次实际结果：44 条事实、2 个 LLM span、2 个 tool span、3 个明确 entry binding、7 条原生条目归档，所有执行 span 为 completed，耗时来自同一 clock domain 的实测起终点。嵌套工具关系来自公共 parentToolCallId。归档默认详情取会话最终内容，同时保留 message_end/tool_execution_end 的执行时快照。随后才执行 `/obs`，mock 浏览器打开计数恰为 1。

SDK 子进程 dispose 后真正退出；父进程再次通过认证 HTTP 读取到相同 44 条事实，并确认 capture.stopped 留存，证明服务及已确认历史不依赖 Pi 进程存活。测试最后只终止属于自身隔离 dataDir 的服务 PID，并删除临时目录。此验证没有使用真实模型、用户会话或凭据。

验收期间发现并修复当前分支叶节点停留在 session_start 初始位置的问题：现在 turn_end 在归档明确条目父链后，读取公共 getLeafId() 追加 branch.selected，模型的分支过滤能显示当前已持久化响应。实际 SDK 全链路验证没有重复导入当前实时 span。
