# Pi Loop Observer

[English](README.md) · [试用反馈优化方案与验收](docs/implementation/usability-improvements.md)

Pi Agent 的本地图形观察器：扩展自动记录模型响应、工具执行和运行阶段，浏览器按 Prompt → Turn → LLM / Tool 展示调用图、时间轴和时间回放。网页关闭时继续记录，Pi 退出后仍能读取历史。

**当前状态：v0.2 可用性优化版。** 已接通 Pi 扩展、SQLite、本地独立服务、HTTP/SSE 和 React 网页。实际验证范围为 macOS arm64、Node 24.18.1、Pi 1.3.0；兼容性和当前限制见下文。项目独立于 `pi-learn`。

## 开始使用

```sh
pnpm install
pnpm build
```

在需要观察的工作目录启动 Pi，并加载构建后的扩展：

```sh
pi -e /absolute/path/to/pi-loop-observer/dist/adapter/index.js
```

扩展从 `session_start` 自动记录。在 Pi 中执行 `/obs` 打开当前会话网页；这个命令只打开界面。也可以按 Pi 的本地 package 安装方式安装本目录，manifest 已声明 `pi.extensions`。

Pi 退出后，在本项目目录查看历史：

```sh
pnpm open
# 等价于
node dist/cli/main.js open
```

仅输出一次性查看链接、不自动打开浏览器：

```sh
node dist/cli/main.js open --no-open
```

默认数据目录是 `~/.pi/loop-observer/`。使用 `PI_LOOP_OBSERVER_DIR` 或 CLI 的 `--data-dir` 指定独立目录；Pi 与查看入口须使用同一目录。没有采集者和查看者时，租约及宽限期结束后服务自动退出，SQLite 记录保留。

导入一个明确指定的原生 Pi v3 会话：

```sh
node dist/cli/main.js import /absolute/path/to/session.jsonl
```

导入记录提供内容与分支浏览；没有采集过的时间和阶段显示未知。坏行、不完整尾部或归档缺口会报告异常，不把导入结果当作完整实时记录。

Pi 管理的 package 目录不保证将 `pi-loop-observer` 加入 shell PATH，因此上面使用确定可用的 `node dist/cli/main.js` 入口。项目没有自动修改个人 Pi 配置。

## 已实现

- 官方事件采集、精确条目 ID 关联、嵌套工具关系；无浏览器也能自动录制。
- 有界发送队列、幂等重传、事务提交后 ACK；采集缺口明确记录。
- SQLite 事件和内容归档；全局十进制游标、固定高水位分页、SSE 断线补齐。
- 独立服务发现和启动、producer/viewer 租约、崩溃后的恢复与失联标记。
- Prompt / Turn 调用图、轮次折叠、同一时钟域的 SVG 时间轴、分页详情、原生分支内容过滤。
- 阶段前后跳转、播放、暂停、回到实时；暂停期间仍接收新记录，默认不展示未来内容。
- 桌面和 390px / 320px 移动布局；键盘选择和减少动画偏好。
- 本机回环监听、采集端私有凭证、一次性查看票据和只读网页。

## 可视化与检索

- **执行轨迹**：默认将紧凑层级行与每问瀑布图放在同一视图，显示耗时、轮次、模型与工具调用数。默认跟随最新问题，也可固定历史问题或查看全部；点击问题、轮次、调用即可查看详情，搜索命中后高亮并滚动定位。
- **分组调用图**：Question作为大容器，每个Turn独立一行，模型和工具在行内从左到右排列。已记录的调用与结果消费使用有方向的连线，跨Turn走行外沟槽；包含关系不代表执行依赖。支持问题/轮次折叠、双向平移、查看全图和聚焦调用。
- **稳定名称**：例如 `Q2.T3.C1`，附提问摘要、模型或工具名称、输入路径/命令摘要；筛选不重新编号，重名调用仍可区分。
- **每问计时**：默认每个问题自己的零点与比例尺，显示 Turn 和调用耗时；会话总览保留包括空闲间隔的总跨度。并发工具保留重叠区间，跨时钟域不强行相减。
- **时间单位与时间戳**：毫秒、秒、分钟、小时自动转换；详情提供起止时间及本地时区，未记录的历史时间保持未知。
- **搜索与定位**：支持当前回放前缀里的提问摘要、调用名称、模型、工具、ID、状态及可用输入摘要。搜索可跨问题，点击结果展开并定位；不搜索尚未回放到的未来记录，也不自动下载整个输出归档。
- **聚焦工作区**：执行轨迹、调用图、时间轴共享主区；轨迹详情在桌面旁栏、手机下方打开，保留轨迹上下文。问题选择与搜索常驻，分支、轮次和调用跳转收进筛选区。Header吸顶；轨迹行桌面34px、手机40px，图节点保留90px。
- **颜色主题**：默认System并实时跟随系统；手动选择深色、浅色或System后保存偏好。已有浏览器偏好继续保留。
- **Pi 1.3.0**：工具优先显示SDK提供的实际执行耗时，瀑布图仍使用观测起终点；明确记录取消状态。旧事实继续可读，不需要数据库迁移。
- **中英双语**：界面默认英文，Header 可切中文，浏览器保存偏好。真实提问和输出不翻译；GitHub 与文档入口位于 Header。

## 当前边界

- Pi 1.3.0 缺少可靠的输入消费 ID。提交的 steer/followUp 用途会记录，但实际消费归属保留 `unclassified`，尚不能完整实现设计中的精确归因；不靠相同文本或时间猜测。
- LLM 节点代表可观察的 assistant message，不等同于精确 HTTP request attempt；不声称识别内部“结果组装”或真实 TTFT。
- 历史回放按固定阶段节奏播放，可调速度；不做逐 token 或原始时间间隔播放。流式内容 preview 通道尚未实现，实时展示阶段与状态，最终内容在完成后归档。
- 单个采集 payload 默认上限 512 KiB，超限明确截断；大内容 staging 上传和初始大 session 的完整批次归档尚未完成。服务端已保存内容支持分页读取。
- 进程突然退出可能丢失未 ACK 的内存队尾；失联标记表示观察中断，不推断工具执行失败。服务日志尚未轮转。
- Windows/Linux、真实 provider 自动重试、复杂 steer/followUp 队列未完成运行验收。peer `*` 是 Pi 宿主解析约定，不表示支持所有版本。

## 开发与验收

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm test:compat
pnpm test:pack
```

浏览器验收使用本机 Chrome，临时数据目录和人工事件；不会加载个人 Pi session、凭据或调用付费模型。测试脚本会先构建所需产物。详细结果和可重复命令见 [首版验收记录](docs/implementation/acceptance.md)、[Pi 兼容性](docs/implementation/compatibility.md)、[服务实现记录](docs/implementation/runtime-notes.md)。

源码修改后运行 `pnpm build` 并刷新同源网页；带鉴权的 Vite 双端口 HMR 代理暂未提供。

若 npm 官方源在本机连接失败，可仅对本次安装指定镜像：`pnpm install --registry=https://registry.npmmirror.com`；无需修改全局配置。better-sqlite3 可能需要平台编译工具。

## 编码资料与文件职责

从 [编码设计总览](docs/implementation/README.md) 阅读原始设计契约；当前实现和设计差异以上述边界及验收记录为准。

| 目录                          | 职责                                               |
| ----------------------------- | -------------------------------------------------- |
| `src/model`                   | 共享事件契约、纯 reducer、投影与前缀回放           |
| `src/adapter`、`src/capture`  | Pi 事件适配、身份与阶段、内容快照、有界发送队列    |
| `src/importer`                | 原生 JSONL 和内存条目归档、修订与明确关联          |
| `src/recorder`                | SQLite 事务日志、内容分页、索引和投影重建          |
| `src/server`、`src/lifecycle` | HTTP/SSE、鉴权、独立进程和租约                     |
| `src/cli`                     | 独立历史查看与指定文件导入                         |
| `web/src`                     | 状态订阅、调用图、时间轴、详情和回放交互           |
| `test`                        | 领域、采集、存储、协议、真实进程、SDK 和浏览器验收 |

[需求设计](docs/design.md) · [技术栈](docs/tech-stack.md) · [调研](docs/research.md) · [pi-provider-trace 参考分析](docs/provider-trace-reference.md)

## 运行界面

[实际网页截图](docs/implementation/screenshots/v3-desktop-dark.png)使用人工验收记录，由真实构建页面渲染。

## 早期设计效果稿

`design/` 保留原交互效果稿和架构图，**使用模拟数据，不是运行中的观察器**。

```sh
pnpm preview
```

[交互稿](design/index.html) · [架构图](design/architecture.html) · [桌面稿](design/desktop.png) · [移动稿](design/mobile.png) · [架构 SVG](design/architecture.svg) · [架构 Mermaid](design/architecture.mmd)

回放按记录时间推进：1×对应实际经过时间，支持0.5×/2×、暂停和时间定位，仍可用阶段按钮跳转。跨时钟间隔会标记为近似时序。
