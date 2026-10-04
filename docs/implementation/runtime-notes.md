# 首版运行时实现记录

实现模块：`src/recorder`、`src/server`、`src/lifecycle`。

- SQLite WAL/FULL、事务事件和payload归档；canonical信封hash校验，连续producerSeq，重复ACK，冲突/缺号整批回滚；cursor始终BigInt/十进制字符串。
- payload按256KiB块保存，metadata不复制正文；payload详情按session与asOf校验可见性，以base64字节分页，默认64KiB。
- 事实日志权威，source_entries/source_bindings/current projection同事务维护；投影按批增量归约，`rebuildProjection`从日志重建。
- SSE订阅先注册唤醒，按数据库cursor批量补发，1秒兜底；写入等待超过5秒关闭慢连接。事实只在commit后通知。
- loopback与同源检查，private bearer ingestion，一次票据URL fragment换HttpOnly SameSite=Strict cookie。网页无Pi控制接口。
- ensureService核对instanceId/storeId/private health，启动锁二次检查，独立Node子进程，0600 runtime，死进程锁恢复；有producer/viewer连接时保持，租约过期后idle grace退出。

接口：`ensureService({dataDir?,serverEntry?})`、`acquireProducer(handle,{producerId,sessionKey})`、`appendBatch(handle,batch,signal?)`、`openViewer(handle,{sessionKey?})`；openViewer生成URL，由调用方打开浏览器。

验证：隔离tmp目录内真实SQLite与HTTP/SSE、脱离父进程、并发双启动、死启动锁恢复、重启后storeId与已ACK事实保持、序号重试/冲突/缺号回滚、payload可见性、票据重用/跨来源拒绝、假时钟租约、超JS安全整数cursor，12项测试通过。

首版限制：独立大payload staging上传路由及preview临时通道尚未提供。小payload与事实可同批提交，上限16MiB；更大输入必须在采集层明确截断并标记完整性。协议不接受通过capture.gap跳过已分配producerSeq，数据库换新需要新producer epoch。服务日志尚未轮转。

Producer失联：server启动为持久active producer恢复短期租约；宽限后用Observer自己的producer追加带targetProducerId的capture.gap，并同事务标disconnected。只中断目标producer活动span，实际end保持未知，不推断工具failed；真实后续事件仍可确认结果。正常capture.stopped epoch不重复失联标记。

## 可重复规模验收

命令：`pnpm exec vitest run test/integration/recorder-scale.test.ts --reporter=verbose --disableConsoleIntercept`。

2026-10-04，本机Node v24.18.1，临时SQLite，5,000条run结构事实，每批最多128条；写入663ms，重开数据库并以137条/页读取37页、核对全部eventId/producerSeq及重发ACK共54ms，总计717ms。这是单次受控测试总耗时，不是端到端延迟或P95承诺，也不代表5,000个大型payload或调用节点的测量。

重连验收：同producer heartbeat把disconnected恢复active；新的span正常running；旧interrupted span收到真实span.ended后恢复completed，同clockId的真实起止计算耗时，保留失联gap质量记录。两项专项测试通过。
