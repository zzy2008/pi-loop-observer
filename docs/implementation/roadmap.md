# 编码顺序、打包与验收

返回[总览](README.md)。本页给出可以逐项完成的工作切片。尚未执行这些测试；勾选需附实际证据。

## 1. 先完成的兼容性验证（P0）

在隔离的临时 Pi 配置、临时工作目录和可控模型/工具上运行，不加载个人真实配置或发起付费模型请求。测试 fixture 只使用人工内容。

| 编号 | 验证项 | 需要得到的证据 | 未通过时的处理 |
| --- | --- | --- | --- |
| P0-1 | 支持版本 | 实际 Pi 包版本/来源 SHA、Node、OS、事件声明 | 宿主 peer 的解析范围与实际支持矩阵分开，不以 `*` 宣称全版本兼容 |
| P0-2 | 基本事件序列 | user→assistant→并行工具→assistant→settled 的完整事件顺序 | 适配实际生命周期后再写图形 |
| P0-3 | entry ID 关联 | turn_end 的 messageEntryId/toolResultEntryIds 能读到最终条目 | 降级未关联，记录最小接口缺口 |
| P0-4 | 输入用途 | 普通、steer、followUp、多条同文、变换/handled、撤回 | 不能唯一映射时保留 unclassified；不猜 |
| P0-5 | 重试与中断 | 自动续行、abort、reload、session 切换的实际边界 | 明确哪些阶段不可观测 |
| P0-6 | 新字段透传 | parentToolCallId、provider_stream_event 在目标运行路径的实际表现 | 首版保持主 loop，缺失字段不伪造 |
| P0-7 | 服务进程 | Pi 退出后服务仍能读历史；空闲后退出；双启动不重复 | 修进程/租约再承诺后台行为 |
| P0-8 | 数据库安装 | better-sqlite3 在目标 Node/OS 安装与读写通过 | 在 Recorder Interface 内更换 Adapter |

**发现的明确依据**：本机 Pi 1.0.0 `turn_end` 有最终条目 ID；`message_end` 的扩展 handler 先于会话 append。这可指导实现，但尚不替代所有异常路径的运行验证。

P0 交付 `docs/compatibility.md`，注明 tested / unsupported / unknown；记录测试结果而非只列计划。

## 2. 按可演示切片推进

| 阶段 | 要写的文件 / Module | 可展示结果 | 完成条件 |
| --- | --- | --- | --- |
| P1 领域闭环 | model + test/fixtures | 人工事件生成 trace/turn/span 结构 | 同一前缀实时与重放结果一致；未知时间不造值 |
| P2 持久链路 | recorder、schema/migrations、capture/queue | fixture→SQLite→重新打开仍可读 | 幂等、确认丢失重传、缺号、payload引用、事务失败通过 |
| P3 自动录制 | adapter、capture/engine、lifecycle、server/ingress | 没开网页也记录 Pi 假模型运行 | `/obs` 不启动第二套监听；退出/恢复/切换无串线 |
| P4 会话复用 | importer、reconcile | Pi 旧记录显示内容图，新记录关联时序 | 关联无重复节点，源文件删除后归档可读 |
| P5 浏览器读取 | web/client、stores、最小页面 | 历史载入后接续实时列表 | 快照空档、重连、重复事件不漏不重 |
| P6 图形联动 | graph、layout、timeline、details | 两轮 LLM与并发工具图+时间轴 | 稳定位置、真实比例、选择联动、失败可发现 |
| P7 回放与生命周期 | replay、viewer lease、CLI open | Pi 退出后独立查看与阶段回放 | 回放期间新数据仍入库；无未来信息泄漏 |
| P8 安装验收 | build、package、usage docs | 用户安装扩展后自动记录，执行 `/obs` 查看 | 从打包产物完成全流程，不依赖源码目录 |

P1 可在 P0 调研期间独立开发；P3 涉及具体 Pi 事件的部分必须以 P0 结果为准。不要先堆完整 UI 再发现输入/时间归属不可实现。

## 3. 最小样例：所有层使用同一份数据

建议 fixture `two-turn-parallel-tools`：

```text
0.0s  user message applied，trace T1
0.1s  turn 0；assistant A1 started
0.3s  A1 thinking output
1.0s  A1 tool arguments output
2.0s  A1 completed，声明 read R 和 bash B
2.1s  R started
2.2s  B started
3.0s  R completed
5.0s  B failed
5.1s  turn 0 ended，明确 entry IDs 绑定
5.2s  turn 1；assistant A2 started
5.5s  A2 text output
7.0s  A2 completed
7.1s  turn 1 ended；run ended；settled
```

可断言：2 个模型响应、2 个工具节点，工具区间有交叠；B 失败但整个问题可完成；3.5s 回放 R 已完成、B 活跃、A2 不存在；最终正文只能在相应完成事件之后默认可见。

另建 fixture：重复批次、确认丢失、迟到关联、同名工具、重复 toolCallId 跨 run、无 beginning、无 ending、import-only、branch-switch、no-session、handled input、两条同文 followUp、preview after completion、service restart。

## 4. 测试分层

### Vitest：模块 Interface

- model：纯 reducer、投影、alias 合并、前缀回放、不完整记录。
- layout/scale：给定节点与时间→稳定坐标；新增节点不移动无关节点；不同尺寸/窄屏不越界。
- queue：单个在途批次、相同 seq 内容不变、ACK 前不删除、限额内拒绝/报告 gap、退出 deadline。
- recorder：实际临时 SQLite 测事务、唯一约束、升级和崩溃恢复；不要只 mock SQL 字符串。
- importer：半行、坏行、缺父、未知版本、修订、增量、源文件删除。
- lifecycle：假时钟与假 launcher 证明租约/宽限期行为；再做真实进程验证脱离父进程。

### 集成：真实进程和 HTTP/SSE

给 service 注入 fixture capture，不启动真实模型。刻意控制 commit/ACK/read/subscribe 的交错，验证高水位协议；测试持久化后的进程退出与重新启动。多个 producer 应隔离，不需要构建多 agent 控制界面。

### Playwright：用户主路径

1. 浏览器关闭时录制完一个问题，之后首次打开能看到完整图。
2. 执行期间打开、刷新、断网后恢复，调用不重复且结果不缺失。
3. 选择图节点/时间条联动详情；折叠保持选择或跳到明确摘要。
4. 暂停回放后仍有真实事件入库，视口不跳、计时不前进；返回 Live 恢复最新。
5. 320/390/1280px 页面可完成选择、详情、回放和返回实时；键盘与减少动画偏好通过。
6. Pi 退出后网页继续看；网页关闭和宽限期结束后服务退出；独立 open 再看历史成功。

## 5. 可量化验收建议

固定测试机器、Node/浏览器版本及事件集。下列为首版目标，不是当前性能结论：

| 项目 | 初始目标 / 取样方式 |
| --- | --- |
| 规模 | 一个问题 300 调用节点；一个测试会话至少 5000 结构事实 |
| 状态延迟 | 本机受控场景事件生成→可见更新 P95 ≤500ms；时间测量须说明跨进程时钟方法 |
| 图稳定 | 连续文本 delta 不触发布局；只添加节点时既有无关节点位置不变 |
| 交互 | 300 节点选择、折叠、滚动无持续长任务；记录 profiler/trace，定位超过50ms的主线程工作 |
| 历史回放 | 每个选定阶段投影与该事件前缀归约结果相同；首次重建耗时单独记录 |
| 数据可靠性 | 所有已 ACK 的事件重启后可读；未 ACK 队尾丢失有质量标记，不声称零丢失 |
| 内容 | 大输出分页读取且完整性明确，正常切换节点能取消旧请求 |
| 资源 | 退出/切换后无遗留 SSE、RAF、定时器、producer 监听；服务无租约后按期退出 |

如同步 SQLite 批次造成 SSE 延迟，优先测事务规模/索引；仍不达标再引入 DB worker。如 reducer seek 超预算，再用 checkpoint/Worker；不要未测先增加所有并发层。

## 6. 打包与运行方案

### 构建产物

- `dist/adapter/index.js`：Pi 扩展入口，官方 Pi import 作为宿主依赖，不能把 Pi 全量打进包。
- `dist/server/main.js`：独立 Node 入口，运行 Hono/Recorder。
- `dist/cli/main.js`：`pi-loop-observer open` 启动入口；只负责发现/启动服务与打开浏览器。
- `dist/web/`：Vite 生成的静态资源，所有资源本地可用。
- migrations 与协议版本随包发布；better-sqlite3 原生依赖外置保留。

后端优先 `tsc` 编译为 Node ESM；前端用 Vite。扩展获取服务入口、静态资源路径使用 import.meta.url，不依赖用户 cwd。Node engines 在 P0 后设置到实际支持范围；Pi 宿主 peer 按其包文档声明，运行兼容性由能力检测与已验证版本矩阵限定。

本机 Pi 1.0.0 的 packages 文档支持 `pi.extensions`，并要求宿主提供的包放在 peerDependencies，不打包第二份 Pi。建议发布 manifest 的相关片段如下（不是完整 package.json，也不代表现有项目已配置）：

```json
{
  "name": "pi-loop-observer",
  "type": "module",
  "keywords": ["pi-package"],
  "files": ["dist"],
  "pi": { "extensions": ["./dist/adapter/index.js"] },
  "bin": { "pi-loop-observer": "./dist/cli/main.js" },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*" }
}
```

peer `*` 是遵循宿主依赖解析约定，不表示支持所有 Pi 版本；README 与运行检查必须写清实际验证范围。Hono、Node adapter、SQLite 驱动为独立服务的运行依赖；React/Vite 与类型/测试依赖按实际构建产物归类。migrations 也需复制到 dist，bin 加 Node shebang 并保证可执行权限。参考 [Pi packages](https://github.com/earendil-works/pi/blob/a276dabe57911253350bffb93cb7d7aff6a73261/packages/coding-agent/docs/packages.md)。

Pi 管理目录中的安装不保证把 bin 放进系统 PATH。开发时独立历史入口是 `node dist/cli/main.js open`；发行时应提供明确的启动脚本/本地快捷入口，或在已安装全局命令的环境使用 `pi-loop-observer open`，不能让用户误以为单独 `pi install` 后 shell 必然认识该命令。

发布前用隔离配置从 pack 的 tarball 安装，验证原生依赖、服务入口和静态资源都包含。

### 建议开发脚本（尚未写入当前 package.json）

| 脚本 | 行为 |
| --- | --- |
| `pnpm dev:server` | 本地开发记录/查询服务 |
| `pnpm dev:web` | Vite dev server；使用固定受控代理访问本机后端 |
| `pnpm typecheck` | 分别检查 Node 和浏览器 tsconfig |
| `pnpm test` | Vitest 模块/协议测试 |
| `pnpm test:e2e` | Playwright 可控服务 fixture |
| `pnpm build` | Node 编译、Vite 静态构建、资源复制 |
| `pnpm preview` | 保留现有效果稿预览语义，或在切换前清楚更新说明 |

开发双端口代理与生产同源 cookie 策略需分别测试；不能只因 dev 模式工作就认为打包页面能连上 SSE。

## 7. 编码时的完成定义

每个切片至少留下：对应 Module 的实现、通过 Interface 验证的必要测试、已知限制、可重复的演示命令。文档中的 DTO/SQL 示例先校验再实现，不把“写了接口”当作链路已打通。

完成首版前，README 必须区分正式运行、模拟效果稿和旧会话缺失时序三种情况。不要宣称恢复了未采集的阶段，或将 provider_trace 的网络指标直接标为我们的测量结果。
