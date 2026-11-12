# 任务头执行契约 + 任务/团队去重（P1-5 / t337）

## 范围

- Task Workspace sticky 头在 owner/priority/当前 Run 旁展示只读执行契约：model / permission / Full Throttle / 上下文（trace 条数）。
- 契约来源仅为现有 `task.ownerId` → `snapshot.agents`、会话 `chatFullThrottle`、当前 `trace`；不新增数据源、不改 schema/权限/gate/任务状态机。
- 任务/团队/Run 仍共享唯一 `selectedTaskId` + 单一 Task Workspace；成员编辑只保留 Team；Settings 团队区明确只读默认模型与成员概览。

## 契约投影

`src/shell/executionContract.ts`：

| 字段 | 有 owner | owner 无 model | 无 owner | owner 不存在 |
|---|---|---|---|---|
| model | owner.model | 默认模型 | 未知 | 未知 |
| permission | raw + `PERMISSION_LABELS` | raw + label | 未知 | 未知 |
| FT | 会话开关（开启/关闭，标注会话级） | 同左 | 同左 | 同左 |
| context | trace N 条 / 无 trace | 同左 | 同左 | 同左 |

- 不猜测：无 owner 不显示默认模型；owner 不存在显示「负责人不可用/未知」。
- 只读：chips 不含输入控件；模型 chip 跳 Settings > 模型，权限 chip 跳 Team 并自动打开该成员编辑。

## 入口去重

- Tasks 列表选择 → `setSelectedTaskId` + trace/runs；Team 任务 → `handleOpenTaskWorkspace(taskId, "team")`；Run 面板打开任务页 → 同一 `handleOpenTaskWorkspace`。所有入口只更新唯一选中态，渲染同一 `TasksView` Task Workspace。
- Team 仅保留成员新建/编辑/删除；Settings → 团队仅默认模型 + 成员只读表，文案明确「成员…在团队页点击成员编辑；这里只设置默认模型」。
- 任务头权限 chip 新建 `memberEditTarget`，TeamDashboard 消费一次后清除，不新增第二套成员编辑状态。

## 响应式 / a11y

- chips `display:flex; flex-wrap:wrap`；960/480 自动换行，480 收紧 padding。
- 模型/权限为原生 button，`aria-label` 包含当前值和目标；只读字段为 span + title。
- 组容器 `role="group" aria-label="执行契约（只读）"`，键盘 Tab/Enter/Space 原生可用。

## 测试

- `executionContract.test`：known model/permission/FT/context、默认模型、无 owner/owner 不存在未知。
- `TaskContractChips.test`：只读 chips 文本、`aria-label`、模型/权限点击跳转、未知不猜默认模型。
- `SettingsView.test`：团队区只读文案，无新建/删除成员按钮。
- 截图：`docs/team/t337-execution-contract-1440.png`、`-960.png`、`-480.png`（若运行时无任务数据，契约测试仍覆盖投影；截图以实际任务头为准）。

## 风险 / 回滚

- 仅 renderer 展示 + 导航 + 一次成员编辑 target；无数据层/权限/gate/kernel 变更。
- 回滚 `executionContract.ts`/chips 与 `autoEditMemberId` 即恢复旧头部；任务/团队行为不变。

## 实测（t337）

- 1440/960：任务头 chips 单行/可换行，无横向溢出。
- 480：`@media (max-width:600px)` 约束 Dockview 内联宽度；任务详情 398px、chips 381px，`document.scrollWidth=480`，无横向裁切。
- 模型 chip → Settings > 模型（运行时验证 active section）；权限 chip → `#/team` 且 `autoEditMemberId` 只消费一次（无 owner 时仅打开 Team，不猜测成员）。
- 截图：`docs/team/t337-execution-contract-1440.png`、`-960.png`、`-480.png`。

- `TeamDashboard.edit.test`：`autoEditMemberId` 一次消费并打开指定成员「编辑成员」弹窗。
- 任务入口：Tasks 选择、Team `handleOpenTaskWorkspace(taskId,"team")`、Run `onOpenTaskPage` 均落同一 `TasksView` 选中态；无第二详情组件。
