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
  - `task.owner_changed`：`{taskId, from, to, assignedBy, reason}`；幂等键 `task:<id>:owner:<from|none>:<to|none>:v<eventCount>`（版本保证 A→B→A→B 四次真实变更都落库；失败重试/重复同值仍幂等）。
  - `task.dependencies_changed`：`{taskId, from[], to[], reason}`；幂等键 `task:<id>:deps:<hash(from)>:<hash(to)>:v<eventCount>`。
- `task.updated` 不再承载 owner/deps（普通 UI patch 继续）；`task.created` 保留完整快照。
- 事件注册表新增 `task.owner_changed`/`task.dependencies_changed`/`task.deleted` zod strict schema；`task.deleted` 投影会删除 task/owner/dependency/run/summary 行，重建时不会把已删除任务从旧 task.created 复活。
- projection replay 增加 owner/deps 事件处理，并清除/重建 relation 行；`rebuildProjections` 先清 relation 再清 tasks，避免 RESTRICT。
- `gitService` 的 conflict task create/merge-captain owner 写入改走 `TaskGraphService`；全仓无 service 外 owner/deps SQL。

## 3. PlanDraft / router plan

- `confirmPlan`：外层 `withTransaction` 内用 `TaskGraphService.createTask`（owner）+ `setDependencies`（draft id→task id）+ priority + `router.plan` 幂等事件；任一失败整批回滚。
- `plan`（Router 生成计划）：同样包单事务，任务/依赖/`router.plan` 一起提交；不再逐个 `createTask` 后再 update deps。
- owner/deps 校验失败会回滚整批，不留下任务/边/事件。

## 4. 测试

`src/kernel/taskGraphService.test.ts`（11 例）：

- create owner/deps + 旧列/relation 镜像/事件；
- setOwner/setDeps 幂等、事件顺序、`task.updated` 不含 owner/deps；
- A→B→A→B owner/deps 四次真实变更均保留，`rebuildProjections` 后 relation/旧列/最终状态一致；
- owner 缺失/跨 workspace、依赖缺失/跨 workspace/自依赖/重复/环校验及回滚；
- 组合 graph patch 后段失败时 owner 回滚；
- >100 依赖失败；
- 依赖满足/回退时 ready/blocked 状态 reset；
- `TASK_HAS_DEPENDENTS` deleteTask 拒绝；
- rebuildProjections 后 relation 可从事件恢复；
- create→owner/deps→delete→rebuildProjections：task=null、relation 无行、digest 不计数、task.deleted 事件保留；
- kernel/service/git 源无直接 owner/deps SQL（git 走 TaskGraphService）。

`src/git/git.test.ts` 新增 conflict task merge-captain owner 经 TaskGraphService 的测试；`src/kernel/planDraft.test.ts` 8 例新增 non-null owner 持久化。全量 174 文件/1144 用例通过。

## 5. 命令

```text
pnpm typecheck
pnpm build
pnpm test -- --testTimeout=30000 --maxWorkers=1
```
