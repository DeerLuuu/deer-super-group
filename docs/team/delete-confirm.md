# 删除任务 / 删除成员与二级确认（t167）

## 功能

- 任务详情新增「删除任务」；团队页成员行新增「删除」。
- 两个入口都先展示影响面，再进入**第二次确认**：必须逐字输入任务标题/成员名称，最后按钮才可用。
- 关闭、Esc、backdrop 都走同一条关闭路径；确认按钮在输入匹配前保持 disabled。

## 删除任务语义

- 允许删除：`ready / blocked / review / done / failed / cancelled`。
- 拒绝：`queued / running / waiting_human`，或仍有排队/运行中的 Run；先取消任务。
- 拒绝：仍被其他任务依赖；先解除依赖，避免产生不可恢复的 DAG。
- 事务内清理：
  - `runs`、`summaries`；
  - 评审投影（`review_targets` / threads / comments / decisions / reviewers / diff files / reanchor log）；
  - `tasks` 投影。
- 保留：`events` 事件日志（追加 `task.deleted`）；邮件/黑板引用不强制清理。

## 删除成员语义

- Router 不能删除。
- 有排队/运行中的 Run 时拒绝。
- 成员归属任务在同一事务内 `owner_id = NULL`，UI 提示会变为未分配；不静默改所有者。
- 历史聊天、邮件、备忘录与事件保留；追加 `agent.deleted` 事件。

## API / IPC

- `window.deer.deleteTask(taskId): Promise<DeleteTaskResult>`
- `window.deer.deleteAgent(agentId): Promise<DeleteAgentResult>`
- 主进程：`task:delete`、`agent:delete`。

## 可用性与测试

- `DangerConfirmModal` 用 `portal` 到 `body`，避免 Dock 面板 transform 导致弹窗被裁剪。
- 服务层测试 `src/kernel/delete.test.ts`：
  - 删除成员任务转未分配 + 事件；
  - 拒绝 Router；
  - 拒绝活跃 Run；
  - 删除任务清理 Run/摘要并保留事件；
  - 拒绝活跃 Run/被依赖。
- UI 截图人工验证：任务删除 step1/step2、成员删除 step1/step2。

## 边界

- 不自动删除远端分支/worktree；删除已完成任务前仍应按 Git 流程清理。
- 事件日志保留；投影删除后不可从事件重建该任务。
