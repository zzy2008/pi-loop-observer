# 时间条与耗时不匹配修复（2026-10-19）

## 复现和根因

1. 浏览器先载入已结束的970ms模型调用，再追加后续工具与第二轮事件，使坐标轴范围扩展。每个动画帧比较条形实际像素宽度和`970 / 当前时间范围 × 绘图区宽度`。两个视图均失败：Trace约469px、Timeline约137px的最大误差。只在测试页面禁用几何过渡后，两项测试通过，确认刻度立即更新而条形仍沿旧比例过渡是根因。
2. 使用观测区间900ms、Pi SDK执行耗时125ms的调用渲染两个视图。条形覆盖900ms，旧标签却是125ms。组件回归测试失败，确认计时口径混用。

复现命令：`pnpm exec playwright test -g 'bar geometry stays' --project=desktop`；标签回归：`pnpm exec vitest run test/unit/display-timing.test.ts -t 'labels time bars'`。

## 修改

- 删除条形的left/x、width、末端cx几何过渡以及对应的速度CSS变量。坐标轴、条形和数字原子更新；保留流光、轮廓流动、呼吸点及减少动态效果支持。
- Trace和Timeline统一使用`timeBarDuration`显示观测区间耗时。`timeBarDescription`明确区分观测耗时与SDK执行耗时；原始事件、SDK数值和详情不变。
- 回归逐帧检查两个视图在时间范围扩展时的比例，容许1.5px浏览器绘制误差，并覆盖桌面、390px和320px宽度。
- 修正旧折叠测试对过时SVG坐标的断言，改为验证指定调用确实被折叠；已有时间范围断言保留。

## 范围

本次修复时间条几何比例与标签一致性。后续用户确认还涉及播放速度，已另行修复为[按记录时间回放](recorded-time-replay.md)。实时条形表示已观测时间区间，不是任务完成百分比。
