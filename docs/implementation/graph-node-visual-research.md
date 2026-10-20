# Graph 节点视觉差异化调研

调研日期：2026-10-18。范围：question / turn / llm / tool，90px 高横向卡片，深浅主题。先记录一手来源与设计建议，再在文末记录实现与验证。

## 已核实事实

- Langfuse 将 generation 定义为模型生成，tool 定义为函数或 API 等单次动作，span 为有持续时间的通用工作单元；类型用于提供上下文和过滤。它没有为本项目的 question、turn 定义标准颜色或图标。[Observation Types](https://langfuse.com/docs/observability/features/observation-types)
- Langfuse 的贡献指南明确把类型编码应用于图标、边框和填充：`--observation--line` 用于 ItemTypeIcon 和图节点，`--observation--fill` 用于图标底块和时间条；ObservationTree 的 generation/span/event 标签有不同颜色。成功、错误、警告使用独立状态 token。这是类型和状态分离的直接产品实现依据。[官方源码贡献指南](https://github.com/langfuse/langfuse/blob/main/CONTRIBUTING.md#colors)
- LangSmith 的数据结构分别提供 `run_type`（例如 llm、chain、tool）与 `status`（例如 error、pending、success）。因此“是什么步骤”和“执行得怎样”是两个维度。[Run data format](https://docs.langchain.com/langsmith/run-data-format)
- React Flow 支持 `colorMode` 的 light/dark/system，添加主题 class，允许 CSS 自定义节点外观；框架没有规定四类节点的视觉语义。[Theming](https://reactflow.dev/learn/customization/theming)
- React Flow 节点支持 ariaLabel / ariaRole；内含交互元素的自定义节点不宜把整个节点设为 button。[Node API](https://reactflow.dev/api-reference/types/node)、[Accessibility](https://reactflow.dev/learn/advanced-use/accessibility)
- WCAG 要求颜色不能成为唯一的信息区分方式，需可见文字、形状等线索；普通小字至少 4.5:1，理解内容所必需的图形或状态线索相对相邻背景至少 3:1。装饰性淡底无需一律达到 3:1，但承载含义的图标和选中轮廓需要核验。[Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)、[Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)、[Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)

## 本项目建议（设计推断，并非行业标准）

建议同时使用“固定类型图标 + 常驻文字标签 + 克制类型色 + 结构线索”。90px 高度、统一连接点和尺寸继续保持；使用不同轮廓细节而非大幅改变节点形状，减少布局和扫读负担。

| 类型 | 图标与文字 | 色相 | 辅助结构 |
| --- | --- | --- | --- |
| question | 气泡 / Question | 紫色 | 浅染底、较圆角，表达用户输入 |
| turn | 叠层 / Turn | 灰蓝 | 虚线轮廓，表达回合组织单元 |
| llm | 芯片 / LLM | 蓝色 | 左侧类型色条 |
| tool | 扳手 / Tool | 绿色 | 顶部类型色条 |

这些图标、颜色和条带位置是本项目的选择，不应宣称 Langfuse/LangSmith 使用相同映射。Turn 的虚线须始终与 Turn 标签同现，避免被理解为等待状态；绿色 Tool 不应兼任“成功”含义。

类型色保持稳定。状态在独立区域使用符号和文字：完成为中性勾，运行为琥珀进度符号，失败为红色叉；选中使用独立外轮廓。失败后仍保留原类型图标与色条，不能把全卡改红后丢失类型信息。若已有成功绿 badge，可局部保留，避免整卡绿色。

深浅主题以独立 CSS token 控制图标/色条、淡底、普通边框和状态：浅色使用较深图标加低饱和淡底；深色使用较亮图标加深色低饱和底。正文保持中性高对比；13/12px 小字不能依靠淡化来表达次要信息。具体色值须针对实际卡片背景计算对比，不以肉眼截图代替核验。

横向卡片优先两行：首行图标、类型标签和状态；第二行保留标题/摘要与必要指标，长内容省略并在详情展开。移动端允许画布平移缩放，详情面板收敛为单列，不能仅缩小文字获得空间。

## 验证重点

- 四种类型在同为 completed、running、failed 时仍能识别；灰度下通过图标和标签可分辨。
- 浅/深主题分别检查普通文字 ≥4.5:1、必要图标和选中标记 ≥3:1。
- 窄屏、长工具名、长摘要、键盘聚焦及节点选中时，90px 高度和连接点不跳动。
- SVG 装饰图标设置 aria-hidden；节点可访问名称包含类型、标题及状态，避免读屏只获得颜色信息。

## 实现与验证

已按上表落地四类节点的本地SVG图标、类型色和轮廓差异，无新增图标依赖。类型标签常驻，中英语言切换可用；状态独立使用符号和文字，失败不覆盖节点类型。保留90px高度、280px/230px宽度以及现有横向问题布局。选中使用外轮廓，读屏名称包含类型、标题和调用状态。

类型标签/图标采用以下独立主题变量；按sRGB相对亮度公式计算与对应卡片背景的对比度（Question包含9%染色底）：

| 类型 | 深色前景 / 对比度 | 浅色前景 / 对比度 |
| --- | --- | --- |
| Question | #bda4ef / 6.88:1 | #7350a5 / 5.41:1 |
| Turn | #a4b4ca / 8.27:1 | #536981 / 5.67:1 |
| LLM | #86b3ff / 8.22:1 | #285fa9 / 6.36:1 |
| Tool | #63c7a2 / 8.48:1 | #207657 / 5.54:1 |

类型检查、生产构建、24项浏览器场景通过，涵盖桌面和390px/320px手机、深浅主题、折叠、搜索定位、详情和回放。此对比度检查针对新增类型标签与图标，不等于整个应用的无障碍认证。

合成数据截图：[桌面深色](screenshots/v8-desktop-node-types-dark.png) · [桌面浅色](screenshots/v8-desktop-node-types-light.png) · [手机浅色](screenshots/v8-mobile-320-node-types-light.png)。
