# pi-provider-trace 源码参考评估

调研日期：2026-10-03。参考仓库固定提交：[`2ec3fd46640c38bc81eeb766d29333f7cce853c3`](https://github.com/Dwsy/pi-provider-trace/tree/2ec3fd46640c38bc81eeb766d29333f7cce853c3)，提交时间 2026-08-16，包版本 0.1.1。本文基于只读源码检查，未安装运行参考扩展，未进行真实模型、断线或并发端到端验证。以下“风险”是从实现推导出的待验证行为。

## 结论

适合作为 Observer 的**信息分层、节点详情、事件归并、历史与实时同屏**参考；不宜直接照搬全局 fetch patch、关联算法、SSE 协议和服务生命周期。保持已选 TypeScript / React / Vite / React Flow / Hono / SQLite；命令统一为 **`/obs`**，只负责启动查看服务并打开页面，已启用扩展的会话从 session_start 自动记录，不以打开网页为前提。

## 1. Prompt → Turn → LLM / Tool / Message

README 声明桌面主路径为 Pi 会话 → Prompt/Turn 树 → 节点详情。源码确有 `buildSessionTree()`：`input` 开启 Prompt；`turn_start` 开启 Turn；HTTP exchange 成为 generation；`tool_call` / `tool_execution_start` 和结果通过 `toolCallId` 归并；消息事件形成 Message。可以借鉴这一层级，但这里的树是**前端从事件重建的执行分组**，不是 Pi 会话 `id/parentId` 分支树的直接投影。[README](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/README.zh-CN.md#web-ui)、[构树源码](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/public/js/model.js#L603-L860)

关联强度不同：工具使用明确的 `toolCallId`；Prompt ID 由时间戳生成；Turn ID 组合 Prompt ID 和 turnIndex；generation 按请求时间是否落在 Turn 窗口归入。后端 `exchangeId` 则取进程级 `activeExchangeId` 或 `mostRecentExchangeId`，不能据此声称已保证多个同时进行的请求精确归属。[Pi 事件归属](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/src/pi-events.ts#L482-L519)、[交换上下文](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/src/http-exchange-context.ts#L1-L24)、[时间窗口归并](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/public/js/model.js#L611-L675)

`input` 一律开新 Prompt；未见构树时区分 steer “提交”和“应用”、followUp 新 trace 的处理。我们的既定语义不能照搬这个分组条件。工具节点 Map 以 toolCallId 为键，建议我们进一步以 session/run 作用域限定 ID，并保留 entryId/branchId 与执行 span 的显式映射。[输入分组源码](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/public/js/model.js#L676-L701)

界面有折叠 Prompt/Turn、详情页签、跟随最新节点；timeline 是带时间戳的事件列表。已检查的源码未实现我们的“整个问题共享时间轴 + 并行泳道 + 拖动阶段回放”，不能把现有 timeline 等同于完整回放能力。[树界面](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/public/js/view.js#L335-L440)、[时间线界面](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/public/js/view.js#L1017-L1034)

## 2. JSONL 持久记录与内存流式状态

低频事实（request / response_meta / pi_event / llm_usage / error）和最终 `stream_result` 同步追加 JSONL；`stream_update` 与旧格式 `sse_line` 明确不落盘。内存 Map 保存尚未结束的累计文本/推理快照，结束时删除。流式增量最多约每 50ms 发布一次；正常结束和读流异常均尝试写入最终快照。[写盘契约](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/src/logger.ts#L168-L220)、[节流和最终结果](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/src/trace-fetch.ts#L26-L115)

因此历史重开能恢复最终结果及已记录生命周期，但不能恢复每个文本增量；进程在流结束前崩溃时，纯内存部分可能丢失。`appendFileSync` catch 会静默吞掉写盘错误，当前没有持久化确认和可见失败状态；这是实现事实，不应把“调用了 append”理解为完整耐久性保证。[Logger](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/src/logger.ts#L168-L218)

适合借鉴“事实落盘、频繁预览合并”的边界。我们的阶段回放必须把状态迁移、工具开始/结束、输入应用、取消和中断等作为持久事件；文本预览可节流或仅保存完成结果，不宣称 token 级回放。以 Pi JSONL 作为内容与分支来源，SQLite 保存补充时序、关联、索引及归档所需的标准化内容；不要仅保存文件路径，以免源会话删除后历史详情失效。导入和采集两条路径应按身份去重，避免重复归档。

## 3. 历史加载与 SSE 衔接：需改造

前端切换会话先建立 EventSource，再并发请求 history/metrics；history 返回 durable records + live snapshots。SSE 连接时也发送活跃快照，之后推送内存发布的记录。[加载顺序](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/public/js/main.js#L302-L370)、[历史/SSE 后端](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/src/web-ui.ts#L360-L407)

有部分保护：stream_update 使用 eventCount 拒绝过旧/重复增量；request 按 exchange ID 存入 Map。但是 `pi_event` 直接 push，没有 event ID 去重；history 与实时流重叠时可能重复；history 与 live 顺序混合时也没有统一版本水位。内存 piEvents 超过 3000 会截到最近 2500，不能据此重建完整长会话。[ingestRecord](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/public/js/model.js#L131-L174)

SSE 仅发送 `data:`，没有 `id:`；服务端未处理 Last-Event-ID/afterSeq，客户端 onopen 仅更新连接状态。EventSource 自动重连并不等于可靠补齐：断开期间已完成且从 live Map 移除的调用，重连后可能缺失，需要重载历史才能恢复。[SSE 广播](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/src/web-ui.ts#L60-L70)、[EventSource 客户端](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/public/js/api.js#L67-L80)

历史接口最多 5000 条，底层只读日志末尾 8 MiB；部分首行会丢弃，JSON 破损行会跳过。`tailJsonl` 丢弃 reader 的 truncated 标志，因此 history 返回值不能明确告知客户端截断原因。适合保护内存，但不符合完整问题回放所需的可分页历史契约。[有界读取](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/src/observability/read-session-log.ts#L5-L44)、[tailJsonl](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/src/observability/read-session-log.ts#L91-L99)

建议我们采用 `{eventId, sessionId, runId, seq, schemaVersion}`，事件先提交持久存储再通知；历史返回明确 highWatermark，SSE 从该水位之后补发并持续订阅；客户端按 ID 幂等归并，以 seq 排序。对于流式临时预览使用独立 previewVersion，重连可用当前快照覆盖，不混进 durable seq。回放内容不完整时明确呈现缺口。

## 4. 启停与独立历史查看

默认关闭；`pi --trace` 或 `/trace on` 开启抓取并启动 UI；`/trace ui` 只启动 UI；`/trace off` 停抓取、UI 可继续；`session_shutdown` 停止 UI 和抓取。源码是在扩展所在 Pi 进程通过 node:http 创建 server，没有进程分离。[命令和生命周期](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/src/index.ts#L115-L201)、[服务启动](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/src/web-ui.ts#L437-L488)

`/trace ui` 可以在 Pi 内查看已有日志；但 package.json 未定义独立 bin，不能据此说 Pi 退出后已有正式独立查看命令。端口占用时可探测复用另一个 Trace UI，但没有当前进程向那个服务器的跨进程事件转发路径；订阅仅是本进程 Set，所以“复用端口”不等于多 Pi 进程的实时汇聚。[package.json](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/package.json)、[端口复用](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/src/web-ui.ts#L452-L479)、[进程内发布订阅](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/src/logger.ts#L51-L106)

我们继续执行已确认的 B 方案：扩展自动记录，记录不依赖前端；`/obs` 打开网页；另有独立查看服务入口，可在 Pi 未运行时读取历史。若采用独立记录/查询进程，要显式处理记录进程连接、写入确认、异常重启和闲时退出；不要继承它的同进程生命周期。

## 5. 不把 fetch patch 作为 Observer 必需项

参考项目确实覆盖 `globalThis.fetch`，使用 URL 启发式选取请求，并 `response.body.tee()` 后读取一个分支、将另一个分支包装成新 Response 返回；卸载时恢复保存的 fetch。其目标是 HTTP wire 观测，与我们的调用层可视化范围不同。[fetch 实现](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/src/trace-fetch.ts#L117-L218)

README 的“官方不能观察 Provider 返回流”是该项目的设计背景，不能当成当前 Pi 能力结论。本机 Pi 1.0.0 types.d.ts 已有 `provider_stream_event`，描述为 Pi 归一化前的**解析后 Provider 事件**；另有 message_update / tool_execution_update。它不等于原始 HTTP 字节/原始 SSE 行。主任务已按当前官方固定提交交叉核对。[当前 Pi 扩展类型](https://github.com/earendil-works/pi/blob/a276dabe57911253350bffb93cb7d7aff6a73261/packages/coding-agent/src/core/extensions/types.ts)、[参考项目原始主张](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/README.zh-CN.md#为什么需要-hackpatch-globalthisfetch)

建议首版只用官方生命周期和消息/工具事件，必要时补 parsed provider 事件；明确每种指标的可测边界。首 token 时间要指明是哪个观察层的 first event，不能冒充精确网络 TTFT；没有直接事件支持的“结果组装阶段”不虚构。只有将来明确增加底层传输诊断时，才单独评估网络层采集。

## 6. 许可证和真实技术栈

- MIT，Copyright 2026 Dwsy。实际复制其代码/实质部分时保留版权和许可文本；仅借鉴交互与架构时记录来源。[LICENSE](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/LICENSE)
- 后端 TypeScript + Node 内置 http/fs，JSONL 和 registry JSON；package 没有 Hono、SQLite 等运行依赖。Node 要求 >=20，Pi peer >=0.52.0；声明兼容范围不是当前所有 Pi 版本已运行验证的证据。[package.json](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/package.json)、[HTTP 服务](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/src/web-ui.ts#L1-L47)
- 前端原生 JavaScript ES Modules + HTML/CSS，直接 DOM 渲染，不是 React/React Flow/Vite；测试脚本使用 Bun 与 Node。[模块说明](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/public/js/README.md)、[DOM 渲染](https://github.com/Dwsy/pi-provider-trace/blob/2ec3fd46640c38bc81eeb766d29333f7cce853c3/public/js/view.js#L335-L440)

## 建议实施顺序

1. 定义 Pi session entry 与 run/turn/LLM/tool span 的关联，固定 steer/followUp 和分支语义。
2. 自动采集关键生命周期、持久化、异常中断标记；用关闭浏览器仍可记录作为验收。
3. 实现带水位、幂等和断线补发的历史/实时 API；支持完整问题的分页读取。
4. React Flow 执行图 + 共享时间轴，沿用可折叠 Prompt/Turn 和选中节点详情交互。
5. 用同一纯 reducer 消费历史前缀与实时增量，实现阶段回放；验收乱序、重复、重连、崩溃、steer/followUp、会话切换，避免只验证理想路径。
