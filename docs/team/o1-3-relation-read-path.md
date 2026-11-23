# O1-3：调度/删除/UI 读路径切 relation

- **任务**：t538 — O1-3（ARCH §2.6 读路径切换）
- **范围**：scheduler 队列、deleteTask、AppService snapshot/UI DTO 主读 `task_owners`/`task_dependencies`；旧 `owner_id`/`depends_on` 仅在 relation 表缺失时由 Store 受控回退；不改 gate/权限/事件/schema version，不删旧列。
- **结论**：调度队列改走 `Store.listQueuedTasks`；Store 的 `getTask/listTasks/listQueuedTasks` relation-first；delete/UI 通过 DTO 读取；kernel/UI 不再直接读旧列。

## 1. 读路径

- `Store.getTask`：relation 表存在时覆盖 owner/deps，旧列仅 `toTask` 初始值/表缺失回退。
- `Store.listTasks`：一次 owner/dependency 关系查询；UI `AppService.getSnapshot` 与 TaskStarMap 使用该 DTO。
- `Store.listQueuedTasks`（O1-3 新增）：scheduler 队列按 status/priority 读取，owner 从 `task_owners` 覆盖；relation 表缺失才使用旧 `owner_id`。
- `ExecutionKernel.getScheduler` 改调 `listQueuedTasks`，不再直接 SQL 读 `tasks.owner_id`。
- `deleteTask` 继续通过 `listTasks` 依赖边检查下游；新增旧 JSON 被篡改仍以 relation 拒绝删除的回归。
- UI：TaskStarMap/任务列表/PlanDraft 面板使用 `Task` DTO（`ownerId`/`dependsOn`），无 raw JSON 解析。

## 2. 边界

- 保留 `tasks.owner_id`/`depends_on` 列与 `toTask` 回退函数，O1-4 contract 再删除。
- `src/memory/` 的旧列读取属于 out-of-scope 历史路径，本 PR 未改。
- 不改 review/merge gate、权限、事件类型/语义、IPC、schema version、依赖。

## 3. 测试

- `store.v3.test`：relation 与旧列故意分叉时 `getTask`/`listTasks`/`listQueuedTasks` 仍取 relation；relation 表缺失回退旧列。
- `kernel.test`：scheduler queue 的 owner 来自 relation（旧 owner 置空仍显示 relation owner）。
- `delete.test`：旧 `depends_on` 被清空但 relation 有下游时仍拒绝删除父任务。
- `readPath.test`：kernel/service/TaskStarMap/taskWorkspaceData/PlanDraftPanel 源码无 `owner_id`/`depends_on` 主读。
- 既有调度/阻塞/依赖顺序/删除/审批回归通过。
- 验证基线：typecheck 0；build 0（466 modules，index 369.06 kB/gzip 109.86）；串行 test 178 文件/1177 用例全绿。

## 4. 命令

```text
pnpm typecheck
pnpm build
pnpm test -- --testTimeout=30000 --maxWorkers=1
```
