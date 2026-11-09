# 任务执行内核实现（t68 + t83 repair）

- **任务**：t68 — 实现：任务执行内核核心；t83 — repair-round-2（按 t70/t76 findings 修复）
- **模型路由**：`deepseek-official/deepseek-flash`（成员 sol）
- **分支 / worktree**：`feature/t68-execution-kernel` / `branches/t68-execution-kernel/`（基于 `origin/main` @ `494faef`，已同步最新 main）
- **设计依据**：`docs/team/execution-kernel-design.md`（t67 + t76 修订：Q1 4/1/1、T20–T22、迁移/版本、reviewPolicy、autoAdmit 等）
- **状态**：t83 修复完成，typecheck / build / test 全绿；PR #2 更新，待独立复审 → 集成（实现者不自我评审）
- **日期**：2026-11-10

---

## 1. 交付摘要

按 t67/t76 设计实现完整执行内核，而非最小串行版本：

| 能力 | 实现 |
|---|---|
| 事件唯一事实源 | `events` v2 列（schema_version/idempotency_key/correlation_id/causation_id/occurred_at/recorded_at）+ 全局 `seq` + 幂等唯一索引 + `withTransaction` 原子提交 + 提交后通知 |
| 事件校验 | 每个 `KERNEL_EVENT_TYPES` 注册 zod strictObject schema（版本 2、payload ≤64KB）；schemaVersion=2 内核事件在 append 前校验；未知类型/字段/非法值拒绝 |
| 投影重建 | `tasks` / `runs` 从事件重放；`kernel.legacy_snapshot` 基线支持旧库；**seq 游标分页**读取全部事件（不截断 2000）；`rebuildProjections()` + digest |
| Task 状态机 | 8 态（含 `queued`）+ 迁移表 T20/T21/T22 + `INVALID_TRANSITION` 拒绝 + 依赖满足/失败/取消传播 + 取消 |
| Run 生命周期 | `attempt` 单调、`(task_id,attempt)` 唯一、活跃 Run 部分唯一、lease owner/expiry、heartbeat、checkpoint、token/error/errorCode/retryable、fencing、重试新建 Run |
| Run watchdog | tick 检查本实例 active Run 的 heartbeatAt/leaseExpiresAt；running 过期 → abort + `run.failed(LEASE_EXPIRED)` + `kernel.recovered` 审计；waiting_human 过期 → lease keeper 续租 |
| review / waiting_human | `kernel.reviewPolicy=auto/required`；required 时 running→review→approve done / reject failed(REVIEW_REJECTED)；waiting_human 与 t58 审批联动（等待时进入、响应后 resumed，失败走 run.failed） |
| DAG 调度器 | 就绪队列（依赖全 done + nextRunAt 到期）、全局 4 / **工作区 1** / 成员 1 并发上限、优先级 + FIFO、暂停/恢复、取消、单飞 tick、CAS 防双启动、hook |
| 失败/恢复 | 错误分类、指数退避（确定性 jitter）、重试耗尽、启动恢复（租约过期/异主/孤儿/重复活跃/状态归一）、幂等恢复 |
| 迁移 | WAL checkpoint + `VACUUM INTO` 备份 + integrity_check；备份失败拒绝迁移；DDL/基线/归一/版本同事务，失败回滚且 `user_version=1` |
| 兼容 | `service.runTask` 保留为“入队 + 等待终态”；Router/成员/权限/审批/聊天行为不变；旧库增量迁移 |

**测试**：21 个测试文件、**279 个用例**（t68 内核 33 + t64 交互画布/既有 246）全绿。

---

## 2. 事件与投影

### 2.1 事件写入

`src/kernel/store.ts` + `src/kernel/execution/eventRegistry.ts`：

- `appendEventIdempotent(input)`：若 `idempotency_key` 已存在，返回原事件且 `created=false`，不重复写、不重复通知。
- `idempotency_key` 有部分唯一索引 `ux_events_idem`。
- `KERNEL_EVENT_TYPES` 共 29 类，每类注册 `{version:2, schema: zod strictObject, maxBytes:64KB}`；`assertKernelEventPayload` 校验类型/版本/大小/schema（拒绝未知字段、非法枚举、超长文本）。
- **版本策略（t83 F4）**：`events.schema_version` 新库/旧库默认 **1**；迁移回填旧事件 1；`Store.appendEvent` 旧调用默认 1；`Store.createTask/updateTask` 与内核 `appendEvent` 显式 **2**，并先经 schema 校验。
- `withTransaction(fn)`：`BEGIN IMMEDIATE`，事务内事件进入 `pendingEvents`，**COMMIT 后**按 seq 通知监听器；回滚清空事件与投影。
- `seq` 使用 SQLite `AUTOINCREMENT`，读取按 seq 升序；不假设无空洞。
- `listEventsAfter(afterSeq, limit)` 提供 seq 游标分页。

### 2.2 投影与重建

`src/kernel/execution/projections.ts`：

- `task.created`（payload 含完整 Task）→ upsert tasks；
- `task.status_changed {from,to,reason,patch}` → patch status/startedAt/endedAt/summary/attemptCount/blockedReason 等；
- `task.updated {patch}`、`task.blocked/unblocked`、`task.retry_scheduled/retry_exhausted`、`task.review_*`；
- `run.started`（payload 含完整 Run）→ upsert runs；
- `run.heartbeat/checkpoint/completed/failed/cancelled` → patch runs；
- `kernel.legacy_snapshot {entity,value}` → 旧库基线 upsert。
- `rebuildProjections(store)`：清空 tasks/runs，**按 seq 游标 500/页重放全部事件**（t83 F8），返回 digest；`projectionDigest` 可按 workspace 过滤。
- 显式边界：只重建 tasks/runs；agents/messages/board/settings 不是事件投影（保持原表）。

### 2.3 旧库迁移（v1 → v2）

`Store.migrateKernelSchema` + `Store.backupDatabase`：

1. 旧库（已有 `tasks`）且 `user_version < 2`：先把 `user_version` 钉在 **1**。
2. **备份（t83 F3）**：`PRAGMA wal_checkpoint(TRUNCATE)` + `VACUUM INTO '<db>.v1-backup'`（已存在则带时间戳），再打开备份执行 `PRAGMA integrity_check`；必须为 `ok`。备份路径记录在 `Store.lastBackupPath`。任何失败抛错，**不进入 DDL**，应用拒绝启动。
3. 单事务执行：补列（tasks 6/runs 14/events 6）、建 `scheduler_state/schema_migrations`、旧 Run attempt 编号 + 重复 active 归一（`DUPLICATE_ACTIVE`）、建索引、回填 `occurred_at/recorded_at=created_at`、每实体 `kernel.legacy_snapshot` 基线、`schema_migrations(2)`、`user_version=2`。
4. 任一步失败 → `ROLLBACK`，`user_version` 保持 1；应用拒绝启动并提示备份路径。
5. 旧事件保留只读，`schema_version=1`；新覆盖事件由内核显式写 2。

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
- **T22（t83 F7）**：`blocked(reasonA) → blocked(reasonB)` 只更新 `blockedReason`，不改状态；写 `task.blocked {reason, previousReason}` 审计事件，幂等键 `task:{id}:blocked:{reason}:{seq}`；不写 `task.status_changed`。
- 取消：ready/queued/running/review/blocked 均可取消；running 先写 Run `cancelled` 再 abort，Task → `cancelled`；下游按依赖刷新；重复取消幂等。
- **review**：`kernel.reviewPolicy=auto`（默认）直接 done；`required` 时 running→review，`reviewTask(approve)`→done、`reviewTask(reject)`→failed(REVIEW_REJECTED)，写 `task.review_requested/approved/rejected`。

---

## 4. Run 生命周期

`src/kernel/execution/kernel.ts`：

- 每次执行创建新 Run；`attempt = task.attemptCount + 1`；`(task_id, attempt)` 唯一；`retryOfRunId` 指向上一 Run。
- 活跃 Run 唯一：`ux_runs_active` 部分唯一索引（queued/running/waiting_human）。
- 字段：agent/modelProfileId/modelId/permissionSnapshot/sandboxId/startedAt/endedAt/heartbeatAt/leaseOwner/leaseExpiresAt/checkpointRef/checkpointStep/tokenIn/tokenOut/costUsd/errorCode/retryable/steps。
- 租约：owner=`instanceId:bootId`，TTL 60s；执行器 step/工具/独立 15s 心跳续租，`run.heartbeat` 事件 30s 节流。
- **CAS（t83 F2）**：heartbeat/checkpoint/waiting/resumed/终态统一 `UPDATE ... WHERE lease_owner=? AND status IN (...)`；旧 owner 写入被 fencing。
- **watchdog（t83 F2）**：每次 tick 检查本实例 active Run：
  - running 且 `heartbeatAt`/`leaseExpiresAt` 过期 → abort controller + `failRun`（`run.failed/LEASE_EXPIRED` + `kernel.recovered source=watchdog`）；
  - waiting_human 且过期 → 独立 lease keeper 续租（审批 120s > 租约 60s 不被回收）。
- checkpoint：每个 step 回调写 `checkpoints/<runId>.json`（有 dataDir 时）+ `run.checkpoint` 事件；当前只做元数据/交接，不做断点恢复。
- **waiting_human（t83 F5）**：t58 审批开始 → `enterWaitingHuman("risk_approval")`；审批返回 → `resumeFromHuman()`；等待期间 Task 保持 running、Run 保持活跃；拒绝/异常 → `run.failed`。
- 结束：
  - 成功：`run.completed` + Task `running → done`（或 review）；
  - 失败：`run.failed {errorCode,retryable}` + Task `running → queued`（可重试）或 `failed`；
  - 取消：`run.cancelled` + Task `cancelled`（Task 级取消）或 `failed(RUN_CANCELLED)`（Run 级取消）。
- fencing：结束写回时校验 `leaseOwner === 当前 owner`，旧租约结果丢弃。
- 防重复：`queued` CAS 到 `running` + 活跃唯一索引 + attempt 唯一 + 幂等键。

---

## 5. 调度器

- 就绪集合：`status='queued'`、`next_run_at` 到期、无活跃 Run、依赖全 done。
- **并发默认（t83 F1 / t76 Q1）**：全局 4 / **每工作区 1** / 每成员 1（`DEFAULT_KERNEL_LIMITS`，可 options 覆盖）。Git/worktree 隔离前工作区串行；>1 前必须加写租约/文件锁。
- 排序：`priority DESC, queued_at ASC, created_at ASC, id ASC`；同优先级 FIFO。
- 成员选择：任务 owner 优先，其次工作区内非 Router、非 offline、活跃数 < 上限的成员。
- 暂停/恢复：`scheduler_state(workspace_id,paused)` + `scheduler.paused/resumed` 事件；暂停不打断运行中 Run。
- 取消：queued/ready/blocked/review → cancelled；running → run cancelled + abort。
- 并发安全：tick 单飞（`ticking/tickAgain`）、命令互斥（同步事务）、启动前重读状态与 CAS、容量计数从 runs 投影实时查询；watchdog 在 tick 前执行。
- hooks：`beforeStart`（同步门禁，拒绝写 `scheduler.rejected`，默认放行）、`onRunFinished`（指标）；为后续预算/看门狗/评测预留。
- `getScheduler(workspaceId)`：paused/limits/各状态计数/活跃 Run/队列；`listRuns(taskId)`。

> 公平性实现为“优先级 + FIFO + 成员并发隔离”；t67 设计中的 5 分钟等待老化/严格轮转未实现（见 §11）。

---

## 6. 失败、重试与恢复

- 错误分类：错误对象可带 `code/retryable`；默认 `INTERNAL` 可重试；`aborted` 归 `USER_CANCELLED` 不重试；watchdog 覆盖 `LEASE_EXPIRED`。
- 自动重试：`retryable && attempt < maxAttempts`（默认 3，总尝试=首跑+2 重试）→ `run.failed`、Task `running → queued`、`task.retry_scheduled{nextRunAt}`；退避 `base * 2^(attempt-1)`，上限 5min，确定性 ±20% jitter；到点由 tick 启动新 attempt。
- 耗尽：Task `failed(failure_kind=retry_exhausted)`；人工 `retryTask` 可再次入队（`failed → queued`）。
- 崩溃/启动恢复：
  - 活跃 Run 租约过期、owner 异主 → `run.failed(LEASE_EXPIRED)`；Task 按 attempt 余额 → `queued` 或 `failed`；
  - 孤儿 Run（task 不存在/终态）→ `run.cancelled(ORPHANED)`；
  - 同 task 重复 active 在迁移/恢复中归一；
  - `running` 无活跃 Run 的 Task → `queued/failed`；`queued` 依赖不满足 → `blocked`；`blocked` 依赖变化 → T22 reason 更新或 `ready`；
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
- **t58 审批联动（t83 F5）**：auto_risk 的 `requestApproval` 包装为：`waitingHuman("risk_approval")` → 等待 t58 审批 → `finally resumeHuman()`；等待期间内核 watchdog 续租，审批超时/拒绝正常走 run.failed。
- 执行器增加独立 15s 心跳定时器，长模型调用不会因租约过期被误杀；内核 watchdog 仍兜底真正卡死的 executor。
- `getTaskTrace` 改为任务 + 其全部 Run 聚合事件（`store.listEventsForTask`），旧 `tool.call` 与新增 `run.*` 均可见。
- 任务状态展示：`copy.ts` 增加 `queued: "排队中"`；现有 UI 其他布局/筛选不动（t69 做调度栏/排队筛选/Run 历史）。
- 权限/审批：`ToolContext.permission` 注入方式不变；Router/成员/聊天/设置逻辑未改。

---

## 8. 文件

**新增**

```
src/kernel/execution/clock.ts          FakeClock / systemClock
src/kernel/execution/errors.ts         KernelError / 状态判断
src/kernel/execution/eventRegistry.ts  事件类型 + 逐类型 zod schema/版本/上限
src/kernel/execution/stateMachine.ts   8 态迁移表/依赖规则
src/kernel/execution/projections.ts    tasks/runs 投影 + 分页 rebuild + digest
src/kernel/execution/kernel.ts         执行内核（事件/调度/Run/重试/恢复/watchdog/review）
src/kernel/execution/kernel.test.ts    33 个确定性测试
```

**修改**

```
src/kernel/store.ts      v2 schema/迁移/备份/事务/幂等 append/listEventsAfter
src/kernel/service.ts    ExecutionKernel 接入；runTask 兼容；executeRun；审批 waiting_human；trace
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
pnpm test        # vitest run，21 文件 / 279 用例，exit 0
```

构建输出（已合并 t64 后的 main）：`dist/assets/index-Cj1A80OX.js 1,072.63 kB (gzip 294.96)`，CSS 198.12 kB，`dist-electron/main.cjs 1005.4 kB`。

### 9.1 内核测试矩阵（33 例）

| 区域 | 覆盖 |
|---|---|
| 状态机 | 合法/非法迁移、依赖 reason、矩阵 |
| 事件 | 幂等键、seq 单调、事务回滚、schemaVersion 1/2 |
| 事件 schema | 每类型注册、未知字段/非法枚举/空 id/超大 payload 拒绝 |
| 调度 | 全局/成员/工作区并发、暂停/恢复、取消、优先级、双 start 幂等 |
| 工作区隔离 | maxWorkspace=1、两个不同成员同文件串行（maxActiveWriters=1） |
| Run/重试 | attempt 递增、新 Run、retryOfRunId、退避、耗尽、手动重试 |
| 租约/心跳 | heartbeat/lease 更新、checkpoint 事件与文件 ref |
| watchdog | 假时钟 + 永不 resolve executor → abort + failed(LEASE_EXPIRED) + 审计 |
| waiting_human | 等待 >120s 不被回收、resume→done、失败→run.failed |
| review | required→review、approve→done、reject→failed(REVIEW_REJECTED) |
| 依赖传播 | 父失败→子 blocked(dependency_failed)、父重试成功→子 ready；父取消→子 dependency_cancelled |
| T22 | blocked reason 更新写 task.blocked、无 status_changed、幂等键格式 |
| 恢复 | 过期租约回收为 attempt 2、孤儿 Run cancelled |
| 重放 | 重建投影 digest = 实时 digest；>2000 事件分页重放（2105 条） |
| 迁移 | WAL 旧库备份可打开/integrity_check、备份失败拒绝迁移（user_version=1）、半迁移回滚、旧事件 schemaVersion=1/时间回填 |

原有测试（service/权限/审批/模型/Dock 星图/Markdown + t64 交互画布/提问 145 项）全部通过，Router/成员/权限/审批无回归。

---

## 10. 验收对照

### t68 acceptance

| 验收项 | 证据 |
|---|---|
| 事件 seq/幂等/投影重建；旧 workspace 可打开 | `kernel.test.ts` 事件组、重建组、迁移组；`Store` 迁移测试读旧 task/run |
| Task/Run 状态机、依赖失败/取消/重试、非法迁移拒绝 | 状态机组、依赖传播组、`INVALID_TRANSITION` 断言 |
| DAG 调度 ready 队列、全局/成员并发、暂停/恢复/取消、并发安全 | 调度组；CAS/单飞/唯一索引实现 |
| Run 租约/心跳/重试退避、attempt 幂等、孤儿回收 | Run 组、恢复组；attempt 唯一 + 幂等键 + fencing |
| 事件重放一致；确定性测试覆盖状态机/并发/重试/恢复 | rebuild digest；FakeClock + 受控 executor |
| 现有 Router/成员/权限/审批无回归；三命令通过 | 279/279；typecheck/build/test 均 exit 0 |
| worktree/PR，不直接改 main | `feature/t68-execution-kernel`；PR #2 |
| 实现文档 | 本文件 |

### t83 acceptance

| 验收项 | 证据 |
|---|---|
| maxWorkspace 默认 1；不同成员同文件串行；同步 t76 Q1/实现文档 | `DEFAULT_KERNEL_LIMITS.maxWorkspace=1`；测试 `maxActiveWriters=1`；本文 §5；t76 设计已为 4/1/1 |
| watchdog 检查本实例 heartbeat/lease，过期 abort+run.failed(LEASE_EXPIRED)+审计；假时钟/悬挂 executor 测试 | `watchdogActiveRuns`；测试组 “t83 watchdog and waiting_human” |
| 备份必须成功且可校验；失败拒绝迁移且 user_version=1；WAL/备份失败/半迁移测试 | `backupDatabase`（checkpoint + VACUUM INTO + integrity_check）；测试组 “migration backup fail-closed” 3 例 |
| schema_version 默认 1；旧事件 1；新内核 2；v1 fixture 断言 | 迁移列默认 1；`Store.appendEvent` 默认 1；`Store.createTask`/内核显式 2；备份测试断言 evt_old=1、occurred/recorded |
| reviewPolicy auto/required + review 操作；waiting_human 与 t58 联动；进入/批准/拒绝、resumed/failed 测试 | `reviewTask`、`enterWaitingHuman/resumeFromHuman`、service 审批包装；review/waiting 测试组 |
| 每个事件类型 zod schema（版本/上限），拒绝未知字段/非法值；malformed 测试 | `EVENT_REGISTRY` 29 类；`assertKernelEventPayload`；schema 测试组 |
| T22 task.blocked(reasonB) 不改状态 + 幂等键；事件审计断言 | `refreshDependentTasks`；T22 测试断言 task.blocked、无 status_changed、key 格式 |
| 分页重放全部事件（或显式失败）；>2000 重建测试 | `listEventsAfter` + `rebuildProjections` 游标；2105 事件测试 |

---

## 11. 已知边界与遗留（不阻塞本次修复，t69/后续处理）

1. **调度 UI/IPC 未接**：暂停/恢复/取消/重试/优先级目前只有 service/kernel 方法；任务页调度栏、queued 筛选、Run 历史、review 按钮属 t69。
2. **checkpoint 只落元数据**：无 message/tool 结果快照，不支持断点恢复；设计中的同模型恢复为 P2。
3. **公平性**：实现优先级 + FIFO + 每成员并发隔离；未实现 5 分钟老化/严格轮转（t76 仍保留此设计项）。
4. **人工重试上限**：`retryTask` 不设 10 次上限；自动重试受 maxAttempts 限制。
5. **投影范围**：agents/messages/board/settings 不参与事件重建（显式边界）；agent.status 仍由内核直接更新，未写 agent 事件。
6. **`Store.createRun/updateRun` 旧方法保留**：内核路径不再使用，仅为兼容旧调用；后续可移除/标注 deprecated。
7. **命令级 `commandId` 幂等未暴露 IPC**：内核已支持事件幂等键；命令层统一 commandId 在 t69 API 层接入。
8. **review/waiting_human 仅内核 + service 审批接线**：t69 需补 IPC/UI 与 review 操作入口；本任务未改 `electron/`/`App.tsx`。
9. **迁移备份失败不自动恢复**：失败时拒绝启动并保留 `user_version=1` 与备份路径；恢复由用户/后续迁移工具完成（DDL 已回滚）。
10. **事件归档/TTL 未做**：当前保留全部事件；量级监控与归档属后续。

---

## 12. 流程注记（工具链）

AGENTS §8 要求 `pnpm branch:start t68 execution-kernel`。任务开始时 `scripts/branch-worktree.mjs` 存在 bug：`run()` 对 `execFileSync(..., {stdio:"inherit"})` 的返回值为 `null` 调用 `.trim()`，`branch:start` 在 `syncBaseRef` 的 fetch 处崩溃（`TypeError: Cannot read properties of null (reading 'trim')`），`branch:sync/finish` 同样受影响。

本次采用等价手动流程（未修改工具脚本，避免混入无关改动）：

```
git fetch origin --prune
git worktree add -b feature/t68-execution-kernel branches/t68-execution-kernel origin/main
```

任务中途，main 上的 `15fa426 fix: handle inherited git output and resolve main worktree root` 修复了该脚本；本分支已 merge 最新 `origin/main`（含 7fb747a 记忆系统设计、t64 交互画布 PR #1，非本任务改动）。PR #2 由 `git push` + `gh pr create` 创建/更新；合并后可按 AGENTS §8 用 `pnpm branch:remove t68-execution-kernel` 清理。

---

## 13. 后续（t69 建议）

- 调度器 IPC/API：startTask/pause/resume/cancel/retry/listRuns/getScheduler/reviewTask + preload/main；
- 任务页调度栏（运行/排队计数、暂停恢复）、queued 筛选、Run 历史表、review 操作；
- reviewPolicy UI（auto/required 设置）、waiting_human 审批态展示；
- 优先级 API/UI；等待老化与轮转；
- 看门狗/预算 hook 实现（本任务已留接口）；
- 迁移失败的用户可见提示（备份路径/恢复指引）。
