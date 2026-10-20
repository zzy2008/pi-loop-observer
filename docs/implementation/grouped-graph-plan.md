# 问题容器与时间轴优化（2026-10-19）

- Question作为React Flow父节点，内部Turn作为行容器，调用是Turn的子节点。问题标题不与调用共享一行；问题间距24px，Turn行间距12px。父节点先于子节点创建，使用parentId/extent。依据：[React Flow Sub Flows](https://reactflow.dev/learn/layouting/sub-flows)。
- 归属用包含关系表示；箭头只来自已保存relations。calls实线蓝色箭头，result-consumed绿色虚线箭头，sequence灰色点线。并排的工具不自动串成因果链。跨Turn连线走右侧沟槽，保留方向和关系标签。未采集的结果消费关系不根据位置推断。
- 折叠问题隐藏子树；折叠Turn只保留行摘要，并将跨行关系映射到可见节点。搜索与聚焦使用绝对坐标，实时状态更新不触发布局重排。
- Timeline每问模式：Turn去掉Q前缀；有Turn归属的调用显示C编号。总览与未知归属保留必要上下文；悬浮、搜索、详情保持全名。细圆角时间条按模型/工具区分，起点和耗时可见，未知时长不补造，选中/悬浮有行反馈。
- Header增加与主题一致的Pi标志、GitHub及文档图标；favicon使用同款蓝色，并跟随实际深浅主题。SVG本地内置，无外部图标请求。

## 完成与验证

- 已实现Question→Turn→Call的真实React Flow父子节点。Turn按行排布，宽度按最多可见调用计算；折叠自动重新计算容器高度，搜索/聚焦使用绝对边界。保留状态更新时布局稳定，空问题和未关联调用可见。
- 实线调用箭头与虚线结果箭头包含方向；跨行走右侧沟槽；同一目标的结果标签去重，保留每条实际关系。选中调用时强调与其相连的边。没有新增根据时间或位置推断的因果事实。
- Question标题区域限制宽度，手机折叠按钮在首屏可触达。Turn展开124px/折叠56px，行间12px，Question外间24px；调用240px桌面/230px手机×90px。
- Header与favicon采用蓝灰主题，本地SVG，无新依赖。favicon随实际浅/深主题变化，包括System模式的系统变更；增加缓存版本。320px外链以可访问图标入口显示，修复标签挤出左侧屏幕的问题。
- Timeline仅在每问上下文中去除重复前缀，完整编号保留在title/aria和详情；总览保留全名。细条按真实观察起终点定位；工具SDK执行耗时仍独立显示，未知时长仍明确未知。失败附叉号，运行态轻微变化尊重减少动画偏好。
- 类型检查、生产构建、5项布局单测、24项全量浏览器场景通过。截图审查后针对折叠/关系与时间轴反馈复验12项，针对Header窄屏边界和favicon再复验3项，全部通过。未执行commit/push。

截图均为合成数据：[桌面分组图](screenshots/v9-desktop-grouped-graph-dark.png) · [浅色分组图](screenshots/v9-desktop-grouped-graph-light.png) · [手机分组图](screenshots/v9-mobile-320-grouped-graph-dark.png) · [桌面时间轴](screenshots/v9-desktop-timeline-dark.png)。
