# 技术栈与运行方式

日期：2026-10-03。状态：选型记录；尚未安装正式依赖、实现采集链路或完成性能验收。现有网页仍为模拟数据效果稿。

## 编码指引

详细模块功能、Interface、Implementation 与测试入口见 [编码设计总览](implementation/README.md)。该文档集补充了 Pi session 条目关联、独立服务启动、幂等落盘、带游标 SSE、前端回放和发行产物；本页继续作为技术选型摘要。

## 访谈中已确认的约束

1. 没有需要沿用的前端框架，采用 React + TypeScript + Vite 方向。
2. 首版按一次问题数十到数百个调用节点验收；完成轮次可折叠。这不是历史记录保存数量的上限。
3. 已启用扩展的 Pi 会话自动采集，不以浏览器打开或 `/obs` 为前提。`/obs` 负责打开查看页面；无 Pi 进程时提供独立的历史查看启动入口。
4. 二次开发通过清晰模块、TypeScript 接口和修改源码实现；首版不提供动态插件加载协议。
5. 采用“记录持久保存、查看按需启动”。有采集者或网页查看者时保持服务运行；二者都消失并超过宽限期后退出。以后重新启动查看服务，读取已有磁盘记录。
6. 从扩展的 `session_start` 开始建立记录链路，关闭网页不停止采集，Pi 退出结束对应采集。扩展未启用期间的事件不补造；中途加载、reload 缺口及异常退出需要标记不完整。
7. 继续本地浏览器只读观察器路线，CLI 可视化暂不实施。

## 具体选型建议

以下是根据上述约束做出的工程选择，无需继续让用户逐个选择底层库。依赖精确版本在实现时通过兼容性验证后写入 pnpm lockfile。

| 层 | 选择 | 职责与原因 |
| --- | --- | --- |
| 包管理 | pnpm；单仓库、先用一个 package | 当前规模先通过目录与接口隔离模块。 |
| 语言 | TypeScript，strict | Pi 事件适配、服务、视图模型共享类型；进程与网络边界仍需运行时校验。 |
| 运行环境 | Node.js；首轮以本机 Node 24 环境验证 | Pi 扩展与服务共用生态。最低支持版本根据 Pi 与最终依赖联合验证后声明。 |
| 前端 | React + Vite | 组件化界面；生产发布预构建静态资源，由本地服务提供。 |
| 调用图 | React Flow（@xyflow/react） | 自定义节点、连线、选择、缩放和平移；作为只读图关闭连接编辑等能力。 |
| 图布局 | 独立的按 turn 分层、并行工具分支布局模块 | 针对已确认的主 loop 结构保持节点位置稳定；React Flow 不负责自动布局。 |
| 时间轴 | React + SVG | 共享时间比例尺绘制实际起止、并发和回放游标，便于与图联动。 |
| 界面样式 | CSS Modules + CSS variables | 沿用已确认效果稿的视觉语言，实现主题、窄屏布局和减少动画偏好。 |
| 状态 | 纯 TypeScript reducer + 外部 store；React 用 useSyncExternalStore 订阅 | 执行状态与 UI 选择/缩放/游标分别管理；实时与回放共用 reducer。 |
| 本地服务 | Node.js + Hono + @hono/node-server | 静态页面、采集入口、历史查询、详情和 SSE。 |
| 传输 | 扩展到服务：有界队列批量 HTTP；服务到网页：SSE；查询：HTTP | 采集者与浏览器连接分别管理；适合本机单向实时观察。 |
| 存储 | SQLite；驱动首选 better-sqlite3 | 事件追加写入、稳定游标、trace/span 索引及分页详情。驱动封装在 recorder 内。 |
| 测试 | Vitest + Playwright | 前者验证归约、记录恢复及协议；后者验证图与时间轴联动、回放、断线和窄屏。 |

## 关键实现边界

### 图、时间轴和状态

图只在结构变化时布局；文本增量只更新节点摘要或详情。首次定位、折叠和“回到实时”才按明确规则调整视口。数百节点需要实测，不把库的存在当作性能保证。

时间轴使用统一的单调时间基准。实时视图与回放视图分别维护事件游标和状态，回放期间仍继续接收及记录新事件。历史游标不能暴露未来才出现的节点或结果；最终详情若展示，必须清楚标为完成后信息。

布局与 React Flow 类型分离：领域层保存调用与关系，渲染层再转换成 nodes/edges。未来更换画布或扩展布局，不应改变存储格式和回放逻辑。

### 参考实现与 Pi 会话基础

以 [pi-provider-trace 源码分析](provider-trace-reference.md) 为参考，沿用当前 React/React Flow、Hono、SQLite 选型。该项目的原生 ES Modules 前端、JSONL 实现和 provider HTTP 拦截是其自身技术选择，不自动成为本项目依赖。

Pi 已有 session JSONL 可作为内容与分支的来源，Observer SQLite 保存归档后的必要内容、关联索引与补充时序。历史内容导入是独立 adapter：有调用内容但没有采集阶段时，仍可显示内容图，并标明缺失的时间与运行过程。归档内容独立于源文件路径，避免删除 Pi session 后 Observer 只剩失效引用。具体关联与重复内容去重需要实现验证。

默认图层采用 Prompt → Turn → LLM/Tool/Message；message 可呈现为模型节点详情，避免把模型响应与其正文计算为两次模型调用。图节点身份与时间轴 span 身份统一映射，最终结果不能泄露到过去的回放游标。

### 采集、持久化与恢复

Pi 扩展事件处理器只做必要的归一化和入队，网络与磁盘工作异步处理。HTTP 批次以 producer + seq 去重；服务持久化成功后才确认并发布对应 SSE 游标。进程意外退出可能丢失尚未确认的队尾，界面必须能表达采集缺口，不承诺无限缓冲或零丢失。

有界队列保留生命周期事件的优先级；高频内容增量可合并，但不能静默丢弃关键开始/结束边界。不能接收时明确记录或报告采集中断。

SQLite 驱动使用同步 API：批量短事务和有界分页查询在独立服务进程内执行，不放入 Pi 扩展回调。性能验证若发现影响 SSE 延迟，再将数据库操作迁入专用 worker。WAL 不会把同步 JavaScript 调用变成异步。

阶段事件与大段输入输出分表，详情按需读取。首版保持一种权威事件存储；JSONL 可作为后续导出格式。schemaVersion 与数据库迁移分别管理。

better-sqlite3 含原生模块；主要平台提供预编译包，但仍须验证目标 Node/平台的实际安装。打包时保留原生依赖，不能当作普通 JS 完全内联。若安装兼容性不满足要求，再在 recorder 边界内评估 node:sqlite 等替代；不自动要求用户安装编译工具。

### 生命周期：自动记录，按需查看

此决策替代此前“执行 `/obs` 才开始采集”的规则，也不采用机器启动后永久驻留的后台服务。

采集链路：Pi 会话启动且扩展已启用 → `session_start` 注册采集者并启动或连接记录服务 → 自动保存事件 → Pi 退出后冲刷队列并解除对应采集者租约。

查看链路：执行 `/obs` 或独立历史查看入口 → 启动或连接本地服务 → 打开网页 → 读取历史记录 → 若存在活动采集，再订阅持久化后的增量。

首版可以由同一个 Node 服务进程承载 Recorder 与 HTTP/SSE，模块职责分离即可。它因为采集需要而启动时不自动打开网页；Pi 全部退出后，因为历史查看需要也能单独启动。无需为此拆成两个常驻服务。

| 场景 | 行为 |
| --- | --- |
| Pi 活跃，没有浏览器 | 服务持续接收并落盘；无需渲染或向不存在的订阅者推送。 |
| Pi 活跃，打开浏览器 | 加载当前已持久化的历史，并从对应游标接续实时流。 |
| 关闭浏览器，Pi 仍活跃 | 继续采集，不能因无查看者而退出。 |
| Pi 已退出，浏览器仍打开 | 停止对应采集，服务保留历史查询与回放。 |
| 无采集者且无查看者 | 宽限期到期并完成必要写入后退出，记录不删除。 |
| 服务已退出，再次查看 | 独立启动入口重新提供网页和历史查询；不需要为查看历史发起模型调用。 |

建议的未来独立入口为 `pi-loop-observer open`：仅启动本地网页服务并打开历史界面，不提供终端可视化。该命令目前尚未实现。只打开旧的 localhost 地址不能唤醒已退出的服务。

服务启动前的早期事件进入有界队列；启动失败或队列溢出需显式报告记录缺口。不能为了启动采集资源在扩展 factory 中直接创建进程，应遵循 Pi 的 session 生命周期。重复 `/obs` 不增加采集监听；reload/session 切换要去重并按 session 身份隔离。

网页关闭检测使用租约/心跳与宽限期，容忍刷新、暂时断线和后台标签页节流。Pi 被强制终止时检测采集者租约失效，将未结束记录标记为不完整。存在采集者时绝不能根据网页连接状态清理服务。

历史加载和实时接续共享持久游标，避免“查询完成到订阅建立”之间漏事件；重连允许重复传输并按序号去重。查看与回放不能触发模型或工具执行。

只监听本机地址，使用受控的本地访问凭据。首版不自动删除历史，退出服务不等于删除数据；以后只有明确的清理操作或配置的保留策略才删除记录。

## 建议目录

```text
src/
  adapter/       # Pi 官方事件与 /obs 命令
  model/         # 事件契约、关联、reducer、回放
  recorder/      # SQLite、迁移、查询
  server/        # Hono、采集入口、SSE、静态资源
  lifecycle/     # 服务启动、发现、租约、退出
web/src/
  graph/         # React Flow 节点、边、独立布局
  timeline/      # SVG 时间轴与游标
  details/       # 节点输入输出
  state/         # 执行 store、视图状态
  styles/
test/fixtures/   # 可控事件与期望状态
```

现有 `design/` 保留作为设计参考。正式前端放入 `web/`，不要将模拟数据效果稿误标为已接入 Pi。

## 实施前必须完成的技术验证

1. 用本机 Pi 1.0.0 为起点固定实际源码/包基线，重核事件契约。旧调研的 0.85.1 结论不能直接当作新基线的运行证据。
2. 验证从未打开浏览器也能自动记录；退出 Pi 与服务后通过独立入口恢复历史；验证重复打开、reload、浏览器刷新、租约和最终退出。
3. 用假模型与可控工具产生两轮 LLM、并行工具、错误、取消和输入队列；验证官方事件与 trace 归属。
4. 验证 SQLite 驱动安装、数据库恢复、批量确认去重、SSE 按持久游标补齐。
5. 用数百节点及密集事件验证渲染、查询和阶段回放；检查窄屏及用户查看历史时视口不被抢夺。

本轮只完成技术方案文档，不安装依赖或生成正式代码。产品方向已足以进入上述技术验证，无需继续逐个询问基础库偏好。

## 官方参考

- [React Flow 自定义节点](https://reactflow.dev/learn/customization/custom-nodes)与[布局边界](https://reactflow.dev/learn/layouting/layouting)
- [Vite](https://vite.dev/guide/)、[React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)
- [Hono Node.js](https://hono.dev/docs/getting-started/nodejs)与[SSE helper](https://hono.dev/docs/helpers/streaming)
- [SQLite 使用场景](https://sqlite.org/whentouse.html)、[better-sqlite3 安装与 API](https://github.com/WiseLibs/better-sqlite3/blob/master/README.md)
- [Vitest](https://vitest.dev/guide/)、[Playwright](https://playwright.dev/docs/intro)
- [Pi 扩展生命周期](https://github.com/earendil-works/pi/blob/a276dabe57911253350bffb93cb7d7aff6a73261/packages/coding-agent/docs/extensions.md#respect-the-runtime-lifecycle)
