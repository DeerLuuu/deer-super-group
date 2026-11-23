# O1-2：TaskGraphService 写路径 + 事件 + PlanDraft 原子建图

- **任务**：t502 — O1-2（ARCH v2 §2.4/§2.6 migrate 阶段）
- **范围**：任务 owner/dependency 的唯一写边界、relation+旧列镜像+新增事件同事务、PlanDraft/router plan 原子建图；不改 scheduler/UI 读、review/merge gate、权限、IPC。
- **结论**：`TaskGraphService` + Store 受控 graph 写路径落地；事件与关系/镜像同事务；失败回滚；PlanDraft/router plan 单事务建图。

## 1. 写边界

`src/kernel/taskGraphService.ts`：

- `createTask(ownerId?, dependsOn?)`：校验 owner/deps 后创建 task（`task.created` 携带完整 owner/deps 快照）。
- `setOwner(taskId, ownerId, {assignedBy, reason, actor})`：校验同 workspace/存在性；更新 `task_owners` + `tasks.owner_id`；append `task.owner_changed`。
- `setDependencies(taskId, dependsOn, {reason, actor})`：校验同 workspace/存在性/自依赖/重复/环/≤100；更新 `task_dependencies` + `tasks.depends_on`；append `task.dependencies_changed`；按依赖状态重算 ready/blocked（`task.status_changed`）。
- `updateTask` 普通字段（标题/描述/status/branch 等）仍由 Store 处理；含 owner/deps 的 patch 由 Store 内部路由到同一 graph 原语，供旧调用方（如 out-of-scope git merge captain）保持受控镜像。

稳定错误码：`TASK_NOT_FOUND`、`TASK_OWNER_NOT_FOUND`、`TASK_OWNER_WORKSPACE_MISMATCH`、`TASK_DEPENDENCY_NOT_FOUND`、`TASK_DEPENDENCY_WORKSPACE_MISMATCH`、`TASK_DEPENDENCY_SELF`、`TASK_DEPENDENCY_DUPLICATE`、`TASK_DEPENDENCY_CYCLE`、`TASK_DEPENDENCY_LIMIT`、`TASK_HAS_DEPENDENTS`；均抛 `TaskGraphError.code`。

## 2. 同事务 / 事件

- `setOwner`/`setDependencies` 在 `Store.withTransaction` 内写 relation + 旧列 + 事件；失败整体 ROLLBACK（含 owner/deps/镜像/事件）。
- 新事件（schemaVersion=2）：
  - `task.owner_changed`：`{taskId, from, to, assignedBy, reason}`；幂等键 `task:<id>:owner:<from|none>:<to|none>`。
  - `task.dependencies_changed`：`{taskId, from[], to[], reason}`；幂等键 `task:<id>:deps:<hash(from)>:<hash(to)>`。
- `task.updated` 不再承载 owner/deps（普通 UI patch 继续）；`task.created` 保留完整快照。
- 事件注册表新增两类型 zod strict schema；`task.status_changed` 用于依赖变化后的 ready/blocked 重算。
- projection replay 增加 owner/deps 事件处理，并清除/重建 relation 行；`rebuildProjections` 先清 relation 再清 tasks，避免 RESTRICT。

## 3. PlanDraft / router plan

- `confirmPlan`：外层 `withTransaction` 内用 `TaskGraphService.createTask`（owner）+ `setDependencies`（draft id→task id）+ priority + `router.plan` 幂等事件；任一失败整批回滚。
- `plan`（Router 生成计划）：同样包单事务，任务/依赖/`router.plan` 一起提交；不再逐个 `createTask` 后再 update deps。
- owner/deps 校验失败会回滚整批，不留下任务/边/事件。

## 4. 测试

`src/kernel/taskGraphService.test.ts`（7 例）：

- create owner/deps + 旧列/relation 镜像/事件；
- setOwner/setDeps 幂等、事件顺序、`task.updated` 不含 owner/deps；
- owner 缺失/跨 workspace、依赖缺失/跨 workspace/自依赖/重复/环校验及回滚；
- 组合 graph patch 后段失败时 owner 回滚；
- >100 依赖失败；
- rebuildProjections 后 relation 可从事件恢复；
- kernel/service 源无直接 `UPDATE tasks SET owner_id/depends_on`。

既有 `planDraft.test`（7 例）覆盖 PlanDraft 失败回滚/幂等/环；`delete.test` 覆盖 owner cascade/依赖保护；`kernel.test` 覆盖调度语义。全量 174 文件/1138 用例通过。

## 5. 命令

```text
pnpm typecheck
pnpm build
pnpm test -- --testTimeout=30000 --maxWorkers=1
```
