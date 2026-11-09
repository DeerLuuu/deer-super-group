# 任务执行内核实现（t68）

- **任务**：t68 — 实现：任务执行内核核心（事件/状态机/调度/重试/恢复）
- **模型路由**：`deepseek-official/deepseek-flash`（成员 sol）
- **分支 / worktree**：`feature/t68-execution-kernel` / `branches/t68-execution-kernel/`（从 `origin/main` @ `494faef` 起）
- **设计依据**：`docs/team/execution-kernel-design.md`（t67，main `494faef`）
- **状态**：实现完成，typecheck / build / test 全绿；待独立评审 → 集成（本任务不做自我评审）
- **日期**：2026-11-10

---

## 1. 交付摘要

按 t67 设计实现完整执行内核，而非最小串行版本：

| 能力 | 实现 |
|---|---|
| 事件唯一事实源 | `events` v2 列（schema_version/idempotency_key/correlation_id/causation_id/occurred_at/recorded_at）+ 全局 `seq` + 幂等唯一索引 + `withTransaction` 原子提交 + 提交后通知 |
| 投影重建 | `tasks` / `runs` 从事件重放；`kernel.legacy_snapshot` 基线支持旧库；`rebuildProjections()` + digest |
| Task 状态机 | 8 态（含 `queued`）+ 迁移表 + `INVALID_TRANSITION` 拒绝 + 依赖满足/失败/取消传播 + 取消 |
| Run 生命周期 | `attempt` 单调、`(task_id,attempt)` 唯一、活跃 Run 部分唯一、lease owner/expiry、heartbeat、checkpoint、token/error/errorCode/retryable、fencing、重试新建 Run |
| DAG 调度器 | 就绪队列（依赖全 done + nextRunAt 到期）、全局/工作区/成员并发上限、优先级 + FIFO、暂停/恢复、取消、单飞 tick、CAS 防双启动、`beforeStart`/`onRunFinished` hook |
| 失败/恢复 | 错误分类、指数退避（确定性 jitter）、重试耗尽、启动恢复（租约过期/异主/孤儿/重复活跃/状态归一）、幂等恢复 |
| 兼容 | `service.runTask` 保留为“入队 + 等待终态”；Router/成员/权限/审批/聊天行为不变；旧库增量迁移 |

**测试**：11 个测试文件、**121 个用例**（原有 101 + 新增 20 个确定性内核用例）全绿。

---

## 2. 事件与投影

### 2.1 事件写入

`src/kernel/store.ts`：

- `appendEventIdempotent(input)`：若 `idempotency_key` 已存在，返回原事件且 `created=false`，不重复写、不重复通知。
- `idempotency_key` 有部分唯一索引 `ux_events_idem`。
- 内核事件类型由 `src/kernel/execution/eventRegistry.ts` 登记；内核路径校验类型与 payload 对象形态，未知类型拒绝（旧工具/权限事件继续走宽松 `appendEvent`）。
- `withTransaction(fn)`：`BEGIN IMMEDIATE`，事务内事件进入 `pendingEvents`，**COMMIT 后**按 seq 通知监听器；回滚清空事件与投影。
- `seq` 使用 SQLite `AUTOINCREMENT`，读取按 seq 升序；不假设无空洞。

### 2.2 投影与重建

`src/kernel/execution/projections.ts`：

- `task.created`（payload 含完整 Task）→ upsert tasks；
- `task.status_changed {from,to,reason,patch}` → patch status/startedAt/endedAt/summary/attemptCount/blockedReason 等；
- `task.updated {patch}`、`task.blocked/unblocked`、`task.retry_scheduled/retry_exhausted`；
- `run.started`（payload 含完整 Run）→ upsert runs；
- `run.heartbeat/checkpoint/completed/failed/cancelled` → patch runs；
- `kernel.legacy_snapshot {entity,value}` → 旧库基线 upsert。
- `rebuildProjections(store)`：清空 tasks/runs，按 seq 重放全部内核事件，返回 digest；`projectionDigest` 可按 workspace 过滤，用于一致性检查。
- 显式边界：只重建 tasks/runs；agents/messages/board/settings 不是事件投影（保持原表）。

### 2.3 旧库迁移（v1 → v2）

`Store.migrateKernelSchema`：

1. 旧库（`sqlite_master` 已有 `tasks`）且 `user_version < 2`：`wal_checkpoint(FULL)` 后复制 `deer.db` → `deer.db.v1-backup`（失败不阻断，文档提示人工备份）。
2. 增量 `ALTER TABLE` 补列（tasks 6 列、runs 14 列、events 6 列），`CREATE TABLE scheduler_state/schema_migrations`。
3. 旧 Run 归一：按 `started_at,id` 为每个 task 编号 `attempt`；同 task 多个 active Run 保留最新，其余标记 `failed / DUPLICATE_ACTIVE`（保证部分唯一索引可建）。
4. 建内核索引（幂等/attempt 唯一/active 唯一/heartbeat）。
5. 为每个旧 task/run 写 `kernel.legacy_snapshot` 基线事件（幂等键 `legacy:snapshot:<entity>:<id>`），旧事件保留只读。
6. `user_version=2` + `schema_migrations(2)`。

新库同样补列/建表/索引，`user_version=2`，无基线事件。

---

## 3. Task 状态机

`src/kernel/execution/stateMachine.ts`：

- 8 态：`ready/queued/running/review/blocked/done/failed/cancelled`。
- 迁移表（允许）：
  - `ready → queued/blocked/cancelled`
  - `queued → running/ready/blocked/cancelled`
  - `running → done/review/failed/queued/cancelled`
  - `review → done/failed/cancelled`
  - `blocked → ready/cancelled`
  - `failed → queued/cancelled`
  - `done/cancelled` 终态。
- 非法迁移抛 `KernelError("INVALID_TRANSITION")`，不写状态事件、不改投影。
- 创建任务：依赖未满足 → `blocked(waiting_dependencies)`；全部 done → `ready`。
- 依赖刷新（`refreshDependentTasks`）：
  - 依赖 failed → 直接下游 `blocked(dependency_failed)`；
  - 依赖 cancelled → 下游 `blocked(dependency_cancelled)`；
  - 依赖重试/运行中 → 下游保持 `blocked(waiting_dependencies)`；
  - 依赖全部 done → 下游 `blocked → ready`。
- 取消：ready/queued/running/review/blocked 均可取消；running 先写 Run `cancelled` 再 abort，Task → `cancelled`；下游按依赖刷新；重复取消幂等。
- `review` 态在状态机中受支持，但本任务未接 reviewPolicy/review UI（见 §9）。

---

## 4. Run 生命周期

`src/kernel/execution/kernel.ts`：

- 每次执行创建新 Run；`attempt = task.attemptCount + 1`；`(task_id, attempt)` 唯一；`retryOfRunId` 指向上一 Run。
- 活跃 Run 唯一：`ux_runs_active` 部分唯一索引（queued/running/waiting_human）。
- 字段：agent/modelProfileId/modelId/permissionSnapshot/sandboxId/startedAt/endedAt/heartbeatAt/leaseOwner/leaseExpiresAt/checkpointRef/checkpointStep/tokenIn/tokenOut/costUsd/errorCode/retryable/steps。
- 租约：owner=`instanceId:bootId`，TTL 60s；心跳 15s 语义（执行器在 step 时调用），`run.heartbeat` 事件 30s 节流。
- checkpoint：每个 step 回调写 `checkpoints/<runId>.json`（有 dataDir 时）+ `run.checkpoint` 事件；当前只做元数据/交接，不做断点恢复。
- 结束：
  - 成功：`run.completed` + Task `running → done`（summary/endedAt）；
  - 失败：`run.failed {errorCode,retryable}` + Task `running → queued`（可重试）或 `failed`；
  - 取消：`run.cancelled` + Task `cancelled`（Task 级取消）或 `failed(RUN_CANCELLED)`（Run 级取消）。
- fencing：结束写回时校验 `leaseOwner === 当前 owner`，旧租约结果丢弃。
- 防重复：`queued` CAS 到 `running` + 活跃唯一索引 + attempt 唯一 + 幂等键。

---

## 5. 调度器

- 就绪集合：`status='queued'`、`next_run_at` 到期、无活跃 Run、依赖全 done。
- 并发默认：全局 4 / 每工作区 2 / 每成员 1（`DEFAULT_KERNEL_LIMITS`，可 options 覆盖）。
- 排序：`priority DESC, queued_at ASC, created_at ASC, id ASC`；同优先级 FIFO。
- 成员选择：任务 owner 优先，其次工作区内非 Router、非 offline、活跃数 < 上限的成员。
- 暂停/恢复：`scheduler_state(workspace_id,paused)` + `scheduler.paused/resumed` 事件；暂停不打断运行中 Run。
- 取消：queued/ready/blocked/review → cancelled；running → run cancelled + abort。
- 并发安全：tick 单飞（`ticking/tickAgain`）、命令互斥（同步事务）、启动前重读状态与 CAS、容量计数从 runs 投影实时查询。
- hooks：`beforeStart`（同步门禁，拒绝写 `scheduler.rejected`，默认放行）、`onRunFinished`（指标）；为后续预算/看门狗/评测预留。
- `getScheduler(workspaceId)`：paused/limits/各状态计数/活跃 Run/队列；`listRuns(taskId)`。

> 公平性实现为“优先级 + FIFO + 成员并发隔离”；t67 设计中的 5 分钟等待老化/严格轮转未实现（见 §9）。

---

## 6. 失败、重试与恢复

- 错误分类：错误对象可带 `code/retryable`；默认 `INTERNAL` 可重试；`aborted` 归 `USER_CANCELLED` 不重试。
- 自动重试：`retryable && attempt < maxAttempts`（默认 3）→ `run.failed`、Task `running → queued`、`task.retry_scheduled{nextRunAt}`；退避 `base * 2^(attempt-1)`，上限 5min，确定性 ±20% jitter；到点由 tick 启动新 attempt。
- 耗尽：Task `failed(failure_kind=retry_exhausted)`；人工 `retryTask` 可再次入队（`failed → queued`）。
- 崩溃/启动恢复：
  - 活跃 Run 租约过期、owner 异主 → `run.failed(LEASE_EXPIRED)`；Task 按 attempt 余额 → `queued` 或 `failed`；
  - 孤儿 Run（task 不存在/终态）→ `run.cancelled(ORPHANED)`；
  - 同 task 重复 active 在迁移/恢复中归一；
  - `running` 无活跃 Run 的 Task → `queued/failed`；`queued` 依赖不满足 → `blocked`；`blocked` 依赖变化 → reason 更新或 `ready`；
  - 恢复幂等，写 `kernel.recovered` 审计。

---

## 7. 服务/API 接入

`src/kernel/service.ts`：

- 构造时创建 `ExecutionKernel`，`executor` 即原 runTask 的执行段（构建 prompt/client/tools/权限/审批/FT，跑 `runAgentLoop`）。
- `runTask(taskId)` = 内核 `runTask`：入队 + 等待终态；失败抛错，保持旧 IPC/UI 兼容。
- 新增服务方法（内核命令，UI/IPC 在 t69 接入）：
  - `startTask / cancelTask / retryTask / cancelRun`
  - `pauseScheduler / resumeScheduler / getScheduler`
  - `listRuns / rebuildProjections`
- `getTaskTrace` 改为任务 + 其全部 Run 聚合事件（`store.listEventsForTask`），旧 `tool.call` 与新增 `run.*` 均可见。
- 任务状态展示：`copy.ts` 增加 `queued: "排队中"`；现有 UI 其他布局/筛选不动（t69 做调度栏/排队筛选/Run 历史）。
- 权限/审批：`ToolContext.permission`、`requestApproval` 注入方式不变；高风险审批仍走 t58 链路；Router/成员/聊天/设置逻辑未改。

---

## 8. 文件

**新增**

```
src/kernel/execution/clock.ts          FakeClock / systemClock
src/kernel/execution/errors.ts         KernelError / 状态判断
src/kernel/execution/eventRegistry.ts  内核事件类型登记/校验
src/kernel/execution/stateMachine.ts   8 态迁移表/依赖规则
src/kernel/execution/projections.ts    tasks/runs 投影 + rebuild + digest
src/kernel/execution/kernel.ts         执行内核（事件/调度/Run/重试/恢复）
src/kernel/execution/kernel.test.ts    20 个确定性测试
```

**修改**

```
src/kernel/store.ts      v2 schema/迁移/基线/事务/幂等 append/listEventsForTask
src/kernel/service.ts    ExecutionKernel 接入；runTask 兼容；executeRun；trace 聚合
src/shared/types.ts      TaskStatus +queued；RunStatus/Run 字段；SchedulerSnapshot；EventRecord v2
src/shared/copy.ts       queued 文案
```

未改 `electron/`、`App.tsx`、`styles.css`、`dist/`、`dist-electron/`（构建产物仅本地验证，gitignore）。

---

## 9. 验证

命令（worktree 内）：

```
pnpm typecheck   # tsc --noEmit，exit 0
pnpm build       # vite + build-electron，exit 0
pnpm test        # vitest run，11 文件 / 121 用例，exit 0
```

构建输出：`dist/assets/index-BPfzrDoA.js 906.56 kB (gzip 245.75)`，CSS 181.67 kB，`dist-electron/main.cjs 924.3 kb`。

### 9.1 新增测试矩阵（20 例）

| 区域 | 覆盖 |
|---|---|
| 状态机 | 合法/非法迁移、依赖 reason、矩阵 |
| 事件 | 幂等键、seq 单调、事务回滚（事件+投影都不落） |
| 调度 | 全局并发、成员并发、暂停/恢复、取消、优先级、双 start 幂等 |
| Run/重试 | attempt 递增、新 Run、retryOfRunId、退避、耗尽、手动重试 |
| 租约/心跳 | heartbeat/lease 更新、checkpoint 事件与文件 ref |
| 依赖传播 | 父失败 → 子 blocked(dependency_failed)、父重试成功 → 子 ready；父取消 → 子 dependency_cancelled |
| 恢复 | 过期租约回收为 attempt 2、孤儿 Run cancelled |
| 重放 | 重建投影 digest = 实时 digest |
| 迁移 | 旧 schema 库补列/基线/attempt、任务可读、备份文件存在 |

原有 101 个测试（service/权限/审批/模型/Dock 星图/Markdown）全部通过，Router/成员/权限/审批无回归。

---

## 10. 验收对照（t68 acceptance）

| 验收项 | 证据 |
|---|---|
| 事件 seq/幂等/投影重建；旧 workspace 可打开 | `kernel.test.ts` 事件组、重建组、迁移组；`Store` 迁移测试读旧 task/run |
| Task/Run 状态机、依赖失败/取消/重试、非法迁移拒绝 | 状态机组、依赖传播组、`INVALID_TRANSITION` 断言 |
| DAG 调度 ready 队列、全局/成员并发、暂停/恢复/取消、并发安全 | 调度组 5 例；CAS/单飞/唯一索引实现 |
| Run 租约/心跳/重试退避、attempt 幂等、孤儿回收 | Run 组、恢复组；attempt 唯一 + 幂等键 + fencing |
| 事件重放一致；确定性测试覆盖状态机/并发/重试/恢复 | rebuild digest 断言；FakeClock + 受控 executor；20 例 |
| 现有 Router/成员/权限/审批无回归；三命令通过 | 121/121；typecheck/build/test 均 exit 0 |
| worktree/PR，不直接改 main | `feature/t68-execution-kernel`；提交后 push + `gh pr create`（见 task output） |
| 实现文档 | 本文件 |

---

## 11. 已知边界与遗留（不阻塞 t68，t69/后续处理）

1. **调度 UI/IPC 未接**：暂停/恢复/取消/重试/优先级目前只有 service/kernel 方法；任务页调度栏、queued 筛选、Run 历史属 t69。`App.tsx` 未改，queued 任务在“全部”里可见但无独立筛选。
2. **review 流程未接**：8 态含 review，但无 `reviewPolicy`/批准拒绝命令/UI；Run 成功直接 done。t69 或后续评审门禁任务补齐。
3. **Run waiting_human 未使用**：高风险审批等待期间 Run 保持 running（执行器在活动 Run 集合内，租约回收会跳过自己）；待审批/恢复语义在 t58 已满足，但未映射 Run 状态。
4. **checkpoint 只落元数据**：无 message/tool 结果快照，不支持断点恢复；设计中的同模型恢复为 P2。
5. **事件 payload 校验**：只校验类型登记与对象形态，未为每个事件写 zod schema；后续可加。
6. **重建上限**：`rebuildProjections` 当前读取 `listEvents` 上限 2000 条事件；大数据量需分页（当前本地应用规模足够）。
7. **投影范围**：agents/messages/board/settings 不参与事件重建（显式边界）；agent.status 仍由内核直接更新，未写 agent 事件。
8. **公平性**：实现优先级 + FIFO + 每成员并发隔离；未实现 5 分钟老化/严格轮转。
9. **人工重试上限**：`retryTask` 不设 10 次上限；自动重试受 maxAttempts 限制。
10. **迁移备份失败不阻断**：复制 `.v1-backup` 失败时仅忽略（DDL 全部增量、不删除旧数据）；发布说明应提示人工备份。
11. **`Store.createRun/updateRun` 旧方法保留**：内核路径不再使用，仅为兼容旧调用；后续可移除/标注 deprecated。
12. **命令级 `commandId` 幂等未暴露 IPC**：内核已支持事件幂等键；命令层统一 commandId 在 t69 API 层接入。

---

## 12. 流程注记（工具链）

AGENTS §8 要求 `pnpm branch:start t68 execution-kernel`，但当前 `scripts/branch-worktree.mjs` 存在 bug：`run()` 对 `execFileSync(..., {stdio:"inherit"})` 的返回值为 `null` 调用 `.trim()`，`branch:start` 在 `syncBaseRef` 的 fetch 处崩（`TypeError: Cannot read properties of null (reading 'trim')`）。`branch:sync/finish` 同样受影响。

本次采用等价手动流程，未修改工具脚本（避免混入无关改动）：

```
git fetch origin --prune
git worktree add -b feature/t68-execution-kernel branches/t68-execution-kernel origin/main
```

建议后续单独修脚本（`run` 在 inherit 模式下不调用 `.trim()`），并单独提交工具修复 PR。PR 仍通过 push + `gh pr create` 手动创建（`branch:finish` 因同 bug 不可用）。

---

## 13. 后续（t69 建议）

- 调度器 IPC/API：startTask/pause/resume/cancel/retry/listRuns/getScheduler + preload/main；
- 任务页调度栏（运行/排队计数、暂停恢复）、queued 筛选、Run 历史表、review 操作；
- reviewPolicy + waiting_human 映射 + 审批/评审联动；
- 优先级 API/UI；等待老化与轮转；
- 事件 schema 逐类型校验与 rebuild 分页；
- 看门狗/预算 hook 实现（本任务已留接口）。
