# 内容 / 术语 / 空态 / 模型配置（P1-6 / t341）

## 术语（主界面用户语言，技术原文保留 tooltip/详情）

| 原词 | 主界面 | 技术原文保留 |
|---|---|---|
| Run 历史 | 运行记录 | `title="Run 历史"`、数据/事件仍为 Run |
| 运行中的 Run | 正在执行的任务 | 详情仍显示 Run 字段 |
| checks | 检查 | 合并队列 `checks` tooltip |
| quorum | 投票门槛 | 数据字段 `poll.quorum` 不变 |
| blocker | 阻塞项 | 评审数据/事件不变 |
| decision | 采纳结果 | Poll 数据字段不变 |

覆盖：任务头/删除确认/取消 title、团队运行入口、RunPanel/RunHistory/SchedulerBar、PollPanel、MergeQueuePanel、CommandPalette hints。

## 记忆三 tab

- 黑板：团队共享长期记忆，发布事实/决策/警告/产物，任务完成后沉淀。
- 备忘录：成员私有经验，教训/失败/捷径，复盘个人方法。
- 归档审批：处理 TTL/陈旧下线提案，批准前确认过时。
- 每个 tab 顶部 `memory-tab-help`（`role=note aria-live=polite`）解释“做什么/何时用”。
- 空态 CTA：黑板 `+ 发布记忆条目`；备忘录 `新建备忘录`/`去黑板发布`；归档 `去黑板查看条目`。
- 搜索无结果保留清空/换关键词提示。

## 模型配置 5 分钟路径

Settings → 模型：

1. 供应商：选择/添加。
2. Key：API Key 或环境变量（高级折叠）。
3. 模型：`测试连接并获取模型` → 添加模型。
4. 保存：默认模型 + 保存；inline 错误 + `role=alert`。

- `validateModelSetup` 校验供应商名称/Base URL/至少一个模型/默认模型；`aria-invalid` 标记必填。
- 高级环境变量收进原生 `<details>`，默认折叠；不改 `LlmSettings` schema。
- 空模型表 CTA `测试连接并获取模型`。

## 空态

- 记忆三 tab 均有 CTA。
- RunPanel 无活跃执行：`去任务页运行`。
- 其他主界面既有 EmptyState 保持（Tasks/Team/MergeQueue/Poll 等）。

## 测试 / 截图

- `MemoryWorkbench.test`：三 tab 名称 + 黑板说明 + help 文案。
- `PollPanel.test`：达到/未达投票门槛。
- `KernelRuntimeUi.test`：运行记录标题仍可读。
- `SettingsView.test`：`validateModelSetup`、5 分钟路径、高级折叠、inline 必填错误阻止保存。
- `CanvasArtifact.test`：新 CSS 无裸颜色。
- 截图：`docs/team/t341-model-path-1440.png`、`t341-memory-960.png`（运行后补）。

## 风险 / 回滚

- 仅 UI 文案/布局/CSS/校验前置；无 schema/权限/gate/数据层/依赖变更。
- 回滚文案/CSS/`validateModelSetup` 即恢复；配置 payload 字段不变。

## t345 修复

- **F1 残留术语**：App 取消任务/执行确认、取消 toast、删除 toast、当前执行、最近执行；RunPanel 空态/读取失败/详情 aria；RunHistory 取消执行、执行事件、加载/失败、取消 hint；ReviewSection「阻断项」；技术原文保留在 title（Run 历史 / blocker / checks）。
- **F2 校验**：`validateModelSetup(..., allowMissingKey)` 增加 API Key/环境变量必填；默认模型必须显式选择（select 占位「请选择默认模型」，不再自动回退 models[0]）；API Key 与默认模型 select `aria-invalid`。
- **保存范围**：模型保存仅校验模型分区；界面/ Git 等保存调用 `save({validateModels:false})`，不会被模型未配置误阻塞；测试断言 inline 错误阻止模型保存但界面保存仍可调用 onSave。
- **F3 截图**：`docs/team/t341-memory-1440.png`、`docs/team/t341-model-path-960.png`（替换旧尺寸）。
- 无 schema/数据层变更。
