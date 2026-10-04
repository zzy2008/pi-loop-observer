# 网页、图形与回放模块

返回[总览](README.md)。本页把既有设计效果稿细化为 React + Vite + React Flow 的实现方案。所有组件与类型均为待实现草案。

## 1. 页面与交互结构

```text
App
├─ SessionPicker             会话目录、搜索、归档质量
└─ ObserverPage
   ├─ RunHeader              问题、连接/采集状态、当前活动集合
   ├─ TraceNavigator         问题与 turn 导航、当前分支
   ├─ GraphView              调用图；窄屏时独占主区域
   ├─ DetailsPanel           节点输入/输出/事件；窄屏抽屉或独立页
   ├─ TimelineView           统一时间轴、并发泳道
   └─ ReplayControls         Live、暂停、阶段前后、速度、游标
```

上方区分“agent 状态”“采集状态”“网页连接状态”。网页断线只能显示网页断线；采集服务不可达不能直接显示 agent 执行失败。

当前会话入口从 `/obs` 带 sessionKey；独立 `open` 默认会话目录。SessionPicker 只查询目录与摘要，选中后才装载结构事件；大段正文只在详情读取。选中历史分支不会向 Pi 发送 `/tree` 操作，只改变 Observer 自己的视图。

## 2. Browser Client Module

### Interface

```ts
interface ObserverClient {
  openSession(sessionKey: string, signal: AbortSignal): Promise<SessionBootstrapResult>;
  subscribe(sessionKey: string, after: Cursor, handlers: StreamHandlers): () => void;
  loadDetails(query: NodeDetailsQuery, signal: AbortSignal): Promise<NodeDetails>;
}
```

Implementation 分在 client/api.ts、bootstrap.ts、stream.ts，组件不直接 new EventSource 或 fetch。

### 装载流程

1. app bootstrap 交换网页 ticket、建立查看租约，移除地址中的 ticket。
2. SessionPicker 选中目标会话，创建本次 loadGeneration 和 AbortController。
3. 固定 bootstrap watermark，分批读取并归约事件，更新载入进度。
4. 完成历史页后，从 watermark 接续 SSE。事实先进入 store，再由 React 订阅视图变化。
5. session 切换时 abort 历史/详情请求、关闭旧 SSE；所有异步完成回调检查 generation，避免旧请求覆盖新页面。
6. SSE 断线提示重连；重新订阅使用最后已应用的 durable cursor。服务重启且地址/ticket失效时展示重新启动/打开入口提示，不假装网页能唤醒已退出的 Node 进程。

API 层把 code/retryable 转成可操作状态。错误展示不覆盖已经载入的历史图。数据库重置或切换导致 storeId 改变时清空旧 cursor 并重新 bootstrap，不能把另一数据库的游标套上去。

## 3. State Module：事实与界面状态分离

```ts
type ViewState = {
  sessionKey?: string;
  traceId?: string;
  branchLeafId?: string;
  selectedNodeId?: string;
  collapsedTurnIds: ReadonlySet<string>;
  mode: 'live' | 'paused' | 'replay';
  replayCursor?: Cursor;
  followViewport: boolean;
  activeMobilePanel: 'graph' | 'timeline' | 'details';
};
interface SessionStore {
  ingest(events: readonly StoredEvent[]): void;
  getSnapshot(): SessionSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
```

- SessionStore 存最新已确认事实的状态；ViewStore 存选择、缩放、折叠、游标等 UI 偏好。
- Live preview 单独 Map，按 spanId + previewVersion 合并；不写入历史事实数组，不改变 durable cursor。
- React 用 useSyncExternalStore 订阅。`getSnapshot` 在没有变化时必须返回相同引用；不要每次调用都构造新对象。
- reducer 对未变化实体保留引用；Graph 的 nodes/edges 由结构版本与相关节点版本派生，避免每个文字增量重建全图。
- 客户端忽略已应用 cursor/eventId 的重复事实，并检查 same-ID 不同内容异常；网络到达顺序异常时重新拉取缺口，不自行猜排序。
- 首版先保持少量 store，按模块暴露 selector；确有性能热点再增加每节点订阅。避免把后端派生状态、组件 local state 与另一套全局状态混成三个事实来源。

React 对 external store 的快照约定见[官方文档](https://react.dev/reference/react/useSyncExternalStore)。

## 4. Graph Module

### 对外 Interface

```ts
type GraphViewProps = {
  graph: GraphProjection;
  selection?: string;
  collapsedTurns: ReadonlySet<string>;
  onSelect(id: string): void;
  onToggleTurn(id: string): void;
  onUserViewportChange(): void;
};
```

graph 是纯 view-model，不直接含 Pi 对象、数据库行或 HTTP 请求。node-types.tsx 中声明 LlmNode、ToolNode、TurnSummary、InputMarker；组件只负责呈现与选择。

### 节点与连线

- 节点显示名称、状态、可测耗时和简短摘要。颜色、文字、图标共同表达状态。
- 普通 LLM/工具节点首版固定或有限高度，全文放详情；避免流式正文撑高节点导致整个图抖动。
- 关系类型包括 calls、result-consumed、sequence、contains；视觉可以简化，但数据不合并成无差别箭头。
- assistant 正文属于该 LLM 节点；同一正文如在 Message 视图展示，标为消息内容，不能再次累计成模型调用。
- 只有 completed turn 可自动折叠；失败/运行中节点始终有可发现入口。折叠摘要含 LLM数、工具数、失败数、质量标记。
- 原始 session 父链提供分支导航，不能直接当作工具执行图布局的边。

### Layout Module 的编写思路

Interface：`layout(graph, {orientation, collapsed, previousPositions}) -> LayoutResult`，纯函数，不操作 React Flow 实例。

1. 按 trace/turn 的稳定创建顺序分层；每 turn 安排 assistant 层、工具层、后续关系出口。
2. 工具按声明顺序优先，缺失时按首次观察顺序及稳定 ID 排序；不能按完成先后移动已有工具。
3. 同轮并行工具分泳道，后续 assistant 使用共同出口连接。未知并发关系可同组显示，但不标为已测并发。
4. 固定卡片尺寸与间距计算初始位置；新节点追加，保留既有节点位置。
5. 仅结构变化、折叠、方向切换触发布局。状态/文本 delta 只改 node.data。
6. 已完成 turn 折叠为摘要节点时保留其锚点；展开后恢复缓存位置。
7. 桌面优先横向推进，窄屏用纵向推进。方向变化是显式重布局，保留选中节点并将其移入视口。

React Flow 提供节点/边与视口交互，自动布局需要独立实现。[自定义节点](https://reactflow.dev/learn/customization/custom-nodes)、[布局说明](https://reactflow.dev/learn/layouting/layouting)

### 交互

首次载入可 fitView 一次；之后只在用户点击“回到实时”或主动定位时调整视口。拖动/缩放即关闭自动跟随。点击时间条选中对应节点，调用图只按明确定位请求滚动，不抢占用户操作。

只读图禁用连线创建、节点删除和任意修改关系；允许平移缩放。nodeTypes/edgeTypes 与回调保持稳定引用。对大量节点先采用折叠和局部更新，性能实测后再启用可见区域裁剪。[性能建议](https://reactflow.dev/learn/advanced-use/performance)

## 5. Timeline Module

### Interface 与数据

`buildTimeline(trace, {cursorTime, clockDomain, collapsedTurns}) -> {domain, lanes, spans, markers}`。

每个 span 至少包含 id、label、start、end或running、timingQuality。时间轴与图共享同一 spanId 选择状态。

### 比例尺和并发

```ts
const x = (timeMs - domainStartMs) * pixelsPerMs;
const width = Math.max(minVisibleWidth, (endMs - startMs) * pixelsPerMs);
```

`minVisibleWidth` 只保证可点选，tooltip 显示真实耗时，不能把最小绘制宽度当真实比例。不同任务全部使用同一 domain/pixelsPerMs。未知时间的节点放在“未记录时序”列表，不分配假条长。

泳道按节点/turn 稳定分配。工具区间重叠时并排呈现，不能把 completed tools 按耗时排序替代时间轴。父 turn 展示总跨度；统计工具累计时长与 wall elapsed 分开，重叠区间不能重复累加到总执行时间。

### 运行中时钟

采集到的 mono start/end 用于最终测量。Live 时从最近可信采集时间锚点推进 UI 时钟，单独标识运行中的估算值；网络延迟/睡眠后重新校准，不覆盖最终测量事实。网页本地 performance.now 与 producer monoMs 不能直接相减。

多个 clockId 的历史显示独立时间段和质量标记。replay 的运行条结束位置固定为游标时间，暂停后不能继续增长。

### SVG 实现

分开渲染 ticks、lane labels、span bars、markers、playhead。刻度按缩放级别选择间隔；pointer 坐标转换需考虑 scrollLeft、容器边距和 SVG viewBox。

Live 跟随采用稳定比例尺滚动窗口，避免每次增加总时长都压缩整个图。用户拖动时间轴后停止跟随，保留窗口。键盘左右移动阶段，Home/End 到范围两端；所有鼠标交互提供键盘路径。

## 6. Details Module

### 组成

Overview（状态/质量/计时依据）、Input、Output、Events、Source。LLM 提供模型及可用 usage；Tool 提供名称、参数、结果与错误。来源明确区分实时观察值与会话最终值。

### 编写步骤

1. 选择 nodeId 后请求 `details?asOf=<cursor>`，缓存键必须包含 session/node/cursor或内容版本。
2. 若在加载期间选中另一个节点，取消旧请求；返回值检查当前 selection。
3. 正文按需请求分页；只渲染当前页或窗口，不把数 MiB JSON直接塞进 DOM。
4. 字段未知显示“未记录”；执行内容不完整显示存储 truncation，不能仅用 UI ellipsis 掩盖丢失。
5. 普通历史视图默认只显示游标当时已知内容。显式点击“查看完成后详情”使用独立模式，固定标签提醒不代表当时状态。
6. Markdown 安全渲染，不执行 HTML、脚本或工具输出中的命令；复制按钮复制明确标示的内容范围。

缓存归属于 session，切换会话释放旧的 preview 和未完成请求；最终归档 payload 可按 content hash 复用，但权限仍按会话/节点检查。

## 7. Replay Module

### Interface

```ts
interface ReplayController {
  seek(cursor: Cursor): Promise<void>;
  step(direction: -1 | 1): Promise<void>;
  play(speed: number): void;
  pause(): void;
  followLive(): void;
}
```

### 事件前缀算法

- `liveState` 持续消费所有新事实；`replayState` 只消费到目标 cursor 的事实。拖动回放不关闭 SSE。
- 按 session 的 durable cursor 建索引。阶段停靠点包括 span start/stage/end、输入应用、缺口、trace/run 边界；preview 不进入停靠点。
- 时间轴上的时间先转换到选定 clock domain 的阶段，再映射到 cursor。晚到关联或导入事实仍按获知顺序生效，不按旧 wallTime 偷插到过去。
- 初版 seek 从初始 state reduce 到目标 cursor；fixture 到 5000 个结构事件若不达标，再增加每 200 个事实的内存 checkpoint。checkpoint 必须含 reducerVersion/session/throughCursor，与当前事件集匹配。
- 向前可增量归约，向后从最近合法 checkpoint 重建。缓存只优化速度，结果必须与从零重放一致。
- play 用 requestAnimationFrame 驱动显示时钟，并按 speed 推进已记录阶段；pause 取消动画。可在后续增加“跳过空闲”，不能偷偷改变原始计时。
- 历史导入若只有内容顺序，没有阶段时间，界面提供内容浏览而禁用带真实时间含义的回放；不要播放导入操作耗时冒充 agent 耗时。

### 性能和资源

一次拖动使用 request ID 防止旧 seek 结果覆盖新游标。拖动事件可按帧合并，最终落点必须准确。首版不立即引入 Web Worker；实测 seek 阻塞界面后再把同一个纯 reducer 移入 Worker。

历史 event cache 可限制内存，缺失前缀从后端按固定 through 分页恢复；不得以清空缓存代替完整历史。离开 session 时 cancel RAF、dispose subscription、释放相关缓存。

## 8. 响应式与可访问性

- 建议 1100px 以上图+详情双栏，768–1099px 详情抽屉，767px 以下 graph/timeline/details 单面板切换；具体断点跟设计稿实测调整。
- 320px/390px 宽度下输入内容可换行，页面无整体横向溢出；图内部允许有明确边界的平移。
- drawer 打开时管理焦点、Esc 关闭、关闭后还原到来源节点；键盘可选择节点、切换阶段、返回实时。
- aria-live 仅播报重要状态转移，不逐 token 播报。减少动画偏好下关闭脉冲/自动平移，保留状态文字。
- 与现有效果稿沿用 CSS variables（背景/边框/活动/失败/文字）及统一间距。颜色不能是唯一状态编码。

## 9. 前端验收入口

Graph/Timeline 用固定 view-model 的组件 fixture；Client/Store 用可控 HTTP/SSE fixture；端到端用真实本地 Recorder 与假模型事件源。

验收：选择联动、折叠不改变统计、长正文不挤压图、后台录制后首次打开完整、回放不泄露未来正文、断线恢复去重、查看历史不抢视口、窄屏可完成全部核心操作。
