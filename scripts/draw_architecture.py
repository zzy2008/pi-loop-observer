"""Generate the editable architecture SVG using only Python's standard library."""
from pathlib import Path
from html import escape

root = Path(__file__).resolve().parents[1]
parts = ['''<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1050" viewBox="0 0 1440 1050" role="img" aria-labelledby="title description">
<title id="title">Pi Loop Observer 系统架构</title><desc id="description">Pi 官方事件经过适配、异步队列、本地持久化与 SSE，驱动共用状态模型的实时图形和历史回放。图形界面只读，不向 Pi 发出控制命令。</desc>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#9a92b6"/></marker></defs>
<style>text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;fill:#303344}.muted{fill:#7d8295}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.label{font-size:12px;letter-spacing:1.4px}.small{font-size:13px}.body{font-size:15px}.heading{font-size:18px;font-weight:600}.wire{fill:none;stroke:#9a92b6;stroke-width:1.6;marker-end:url(#arrow)}</style><rect width="1440" height="1050" fill="#f7f8fa"/>''']
def text(x,y,value,css='body',fill=None):
    attrs=f' class="{css}"'+(f' style="fill:{fill}"' if fill else '')
    parts.append(f'<text x="{x}" y="{y}"{attrs}>{escape(value)}</text>')
def rect(x,y,w,h,fill='#fff',stroke='#e1e4ed',radius=12):
    parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}"/>')
def path(d,label=None,x=0,y=0,dashed=False):
    parts.append(f'<path class="wire" d="{d}"'+(' stroke-dasharray="5 4"' if dashed else '')+'/>')
    if label:text(x,y,label,'small muted')
def box(x,y,w,h,title,lines=(),tag=None,accent=False):
    rect(x,y,w,h,'#f1edfc' if accent else '#fff','#cfc5ef' if accent else '#e1e4ed',9)
    if tag:text(x+17,y+25,tag,'label muted')
    top=y+(50 if tag else 30)
    text(x+17,top,title,'heading')
    for i,line in enumerate(lines):text(x+17,top+25+i*23,line,'small muted')

text(48,44,'PI LOOP OBSERVER / ARCHITECTURE','label muted')
text(48,92,'一份执行记录，驱动实时观察与历史回放','heading')
text(48,121,'独立扩展 · 本地优先 · 只读观察 · 阶段级回放','body muted')
rect(1163,68,228,32,'#eeeafa','#e4dcf5',6);text(1178,89,'设计方案 / 尚未接入真实 Pi','small', '#7868a5')

rect(48,172,330,612,'#f0f2f6','#e2e5ed',14)
rect(439,172,384,612,'#f0f2f6','#e2e5ed',14)
rect(884,172,508,612,'#f0f2f6','#e2e5ed',14)
text(69,205,'01  PI PROCESS','label muted');text(69,234,'在原有终端中工作','heading')
text(460,205,'02  LOCAL SERVICE','label muted');text(460,234,'记录事实，提供可恢复的数据流','heading')
text(905,205,'03  READ-ONLY BROWSER','label muted');text(905,234,'图形化理解一次执行','heading')

box(69,268,288,104,'Pi / Agent Loop',['用户输入、模型、工具、会话事件'],'EXISTING RUNTIME')
path('M 213 372 L 213 399','官方生命周期事件',225,391)
box(69,402,288,117,'事件适配器',['输入用途 / span 身份 / 事件序号','记录可观察阶段，不修改执行'],'EXTENSION')
path('M 213 519 L 213 548')
box(69,551,288,94,'有界异步队列',['合并高频增量，保留状态边界','故障不阻断 agent 主流程'])
text(69,689,'steer → 当前问题的介入标记','small muted')
text(69,717,'follow-up → 排队中的新问题','small muted')
text(69,745,'子 agent → 第一版作为工具节点','small muted')

box(460,268,342,94,'接收与校验',['幂等接收 / schema 版本','确认事件来源和序列'])
path('M 357 598 L 408 598 L 408 314 L 456 314','事件批次',384,582)
path('M 631 362 L 631 390')
box(460,393,342,105,'持久记录器',['追加事件日志 + 内容引用','大输入输出与事件索引分离'],'APPEND FIRST',True)
path('M 631 498 L 631 525')
box(460,528,342,84,'本地事件存储',['历史事实 / 游标 / 完整性标记'])
path('M 631 612 L 631 638')
box(460,641,342,99,'查询与订阅',['SSE：已持久化增量 + 断线补齐','HTTP：快照、历史、节点详情'])

box(905,268,466,116,'统一 Trace Model / Reducer',['同一组事件 + 同一游标 → 同一状态','问题 → turn → 调用节点 → 依赖边'],'SHARED MODEL',True)
path('M 802 688 L 851 688 L 851 326 L 901 326','快照 + 增量',835,579)
path('M 1138 384 L 1138 400 L 1017 400 L 1017 415')
path('M 1138 400 L 1258 400 L 1258 415')
box(905,418,225,113,'执行图',['每次调用独立节点','并行分支 / 当前活动'],'CALL GRAPH')
box(1146,418,225,113,'真实时间轴',['实际起止 / 重叠关系','阶段游标 / 耗时'],'TIMELINE')
path('M 1130 474 L 1142 474')
path('M 1017 531 L 1017 544 L 1090 544 L 1090 559')
path('M 1258 531 L 1258 544 L 1186 544 L 1186 559')
box(905,562,466,83,'节点详情',['输入 / 输出 / 可观察阶段 / 原始事件'])
box(905,672,466,68,'Live 跟随 / Replay 阶段回放',[])
path('M 1369 705 L 1381 705 L 1381 356 L 1374 356',dashed=True)

rect(48,820,1344,173,'#fff','#e1e4ed',12)
text(72,853,'OBSERVABILITY CONTRACT','label muted')
text(72,886,'执行语义','heading');text(72,915,'生成工具参数 ≠ 工具执行','body muted');text(72,943,'接到响应头 ≠ 模型请求完成','body muted')
text(519,886,'问题边界','heading');text(519,915,'提交与实际生效分别记录','body muted');text(519,943,'缺失、取消和失败分别展示','body muted')
text(966,886,'只读与回放','heading');text(966,915,'浏览器不控制 agent','body muted');text(966,943,'回放不重新调用模型或工具','body muted')
text(48,1025,'来源：docs/design.md · 2026-10-03','small muted');text(970,1025,'实线：事件与数据流     虚线：切换回放游标','small muted')
parts.append('</svg>')
(root/'design/architecture.svg').write_text('\n'.join(parts),encoding='utf-8')
