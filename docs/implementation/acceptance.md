# 首版实现与验收记录

日期：2026-10-04。项目：`pi-loop-observer@0.1.0`。实现工作由三个 GPT 6.1 sol 子 agent 分别承担模型/网页、采集/导入、存储/服务；主 agent 负责构建配置、交叉审阅、浏览器与打包集成验收。未执行 Git commit，未修改 `pi-learn`。

## 环境与范围

- macOS arm64，Node 24.18.1，pnpm 12.3.4，Pi `@earendil-works/pi-coding-agent@1.0.0`。
- Node 运行依赖：Hono 4.13.12、@hono/node-server 2.1.3、better-sqlite3 13.0.3；实际 SQLite 3.53.4。
- 网页：React 19.3.0、React Flow 12.12.0、Vite 8.3.2；TypeScript 7.0.2、Vitest 5.0.3、Playwright 1.63.0。
- 测试采用临时目录、人工会话、假模型流和工具。SDK 事件分发、会话 append、HTTP、SQLite、独立 Node 进程和浏览器均实际运行。未使用用户凭据、真实会话或付费模型。
- 版本已写入 package 与 pnpm-lock；Pi peer `*` 是宿主解析声明，不是全版本支持承诺。

## 已验证的完整链路

| 检查 | 证据 |
| --- | --- |
| 不打开网页也自动记录 | `observer-sdk.mjs` 通过真实 Pi SDK 加载构建后的 Adapter，session_start 启动独立服务；运行两轮模型和嵌套工具，尚未调用 `/obs`，浏览器打开次数为 0 |
| 原生事件与内容关联 | SDK 产生 44 条 Observer 事实、2 个 LLM 节点、2 个工具节点、3 个精确绑定、7 条原生归档；message_end 尚未 append，turn_end 明确 ID 均可读 |
| `/obs` 仅负责查看 | 单独调用已注册命令后只打开一次查看地址；不创建另一套采集 epoch |
| Pi 退出后查看 | SDK 子进程真正退出，父进程仍可通过独立服务 HTTP 读取相同 44 条事实；不依赖原进程内存 |
| 持久化与恢复 | 真实 SQLite 事务、ACK 重传、序号冲突/缺号回滚、数据库重开、超 JS 安全整数游标、固定高水位分页和 SSE 空档补发 |
| 服务生命期 | 并发 ensureService 复用一个脱离父进程的服务；失效启动锁恢复；服务重启保持 storeId；无租约时按宽限退出 |
| 观察失联 | 按 producer 隔离的 gap 持久保存；未结束调用标为中断、真实终点未知；重连与后续真实结束事实可恢复状态，并保留质量缺口 |
| 历史归档独立 | tarball 安装后 CLI 导入人工 Pi v3 JSONL；删除原文件，仍可读取已归档正文 |
| 发布文件完整 | 独立临时项目仅安装生产依赖，tarball CLI、SQLite schema、原生驱动、HTML/JS 静态资源均可运行 |
| 安装路径入口 | 修复 pnpm 符号链接导致 CLI / server 不执行 main 的问题；真实 Node 子进程通过符号链接路径启动验证 |

最终检查：类型检查与生产构建通过；Vitest 共 7 个测试文件、42 项测试通过；真实 Pi SDK 两个脚本、tarball 独立安装验收通过。

## 网页验收

Playwright 在 1440×1000、390×844、320×800 三种窗口上分别验证两条主路径，共 6 项测试：

1. 在浏览器未打开时录制完成，再打开历史；调用图、共享时间轴、详情、阶段回放和刷新可用，页面无横向溢出、重复节点或 JavaScript 异常。
2. 暂停回放后断网，后台继续提交事实，再恢复连接；暂停视图保持原事件前缀，回到实时后补齐且不重复。

移动端补充原生调用选择器和聚焦操作，能够直接选择失败工具查看详情，再以可读缩放聚焦节点。图控件使用深色高对比样式。桌面保持全图布局。

另外覆盖桌面连续刷新 3 次，每次跨多个 250ms 实时更新周期逐帧采样 800ms，隐藏帧为 0。该回归发现并修复了受控 React Flow 节点重建时丢失 measured 尺寸的问题。

阶段状态与回放使用同一个纯 reducer；精确 entryKey 可将实时和后导入节点合并，保留实测时序。分支使用原生条目父链过滤，不将消息父链冒充执行依赖。

## 规模检查

- 纯模型测试覆盖 300 个调用节点、5,000 条结构事实，实时前缀与回放使用相同归约规则。
- 隔离 SQLite 写入 5,000 条事实，每批不超过 128 条；重开后以每页 137 条、共 37 页核对全部 ID/seq，再重发确认不重复。
- 专项首次测量：写入 663ms，重开/读取/核对 54ms，总计 717ms。这是指定机器上的一次受控测量，不是 P95 延迟承诺，也没有完成 300 节点浏览器性能剖析。

## 可重复命令

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm test:compat
pnpm test:e2e
pnpm test:pack
```

测试脚本会先构建其需要的 Node 或网页产物，避免读到旧 dist。浏览器测试需要本机 Chrome；SDK 脚本可通过 `PI_OBSERVER_TEST_HOST` 指定已安装的 Pi 包。打包验收会执行 pnpm 安装，可通过 `PI_OBSERVER_TEST_REGISTRY` 临时指定镜像，不修改全局设置。

所有打包/进程验收会关闭自己创建的临时服务并删除临时数据。浏览器截图与失败 trace 在忽略目录 `test-results/`；已检查的界面快照另保存在 [实际桌面界面](screenshots/runtime-desktop.png)。

## 与完整设计的差异

这些项目仍未完成，不能因为主路径通过就标记整个设计清单全部完成：

- 无可靠输入消费 ID，因此 steer/followUp 的提交用途与实际消费不能总是精确绑定，消费归属标为 unclassified。
- 临时流式内容 preview 通道、大 payload staging 上传、服务日志轮转尚未实现。采集单 payload 默认 512 KiB，超限明确截断；初次挂接超大会话也可能触发有界队列缺口。
- 回放按固定阶段节奏推进，不模拟逐 token 和原始事件间隔；不同 clock domain 分开展示。
- 当前开发流程为修改源码 → build → 同源网页刷新；带鉴权的双端口 Vite HMR 代理尚未交付，没有保留不可用的 dev 脚本。
- Windows/Linux、真实 provider 重试和取消、复杂输入队列尚未做完整运行验收；不提供 provider attempt / 内部结果组装 / TTFT 的推测值。
- 未完成端到端状态延迟 P95 与 300 节点浏览器长任务 profiling。

详细 API、模块编写思路仍见[编码设计总览](README.md)；具体兼容性见[兼容性记录](compatibility.md)，持久化细节见[服务实现记录](runtime-notes.md)。
