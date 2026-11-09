# 任务执行内核设计（DAG / Run / 重试 / 并发 / 事件一致性）

- **任务**：t67（设计初稿）+ t76（requirements-round-2 修订；正式实现基线，非 MVP）
- **日期**：2026-11-10（t76 修订）
- **作者**：sol（t67 初稿）；aria（t76 修订，落实 t75 findings）
- **状态**：t76 修订版；待 requirements 复审通过后启动 t68 / t69
- **t76 修订记录**：见 §15（F1–F9 + Q1–Q11）
- **依据**：`DESIGN.md` §5.1–5.3、§7.2、§7.4、§7.6、§9、§10；当前 `src/kernel/{store,service,loop,tools,permission}.ts`、`src/shared/{types,ipc,copy}.ts`、`src/App.tsx`、`electron/{main,preload}.ts`、现有测试与实现文档
- **范围声明**：本文件只读代码/文档后产出设计，**未修改任何代码**；实现由 t68 / t69 承接，且各自仍需独立评审 → 集成（AGENTS.md §4）。

---

## 0. 决策摘要（TL;DR）

| 主题 | 决策 |
|---|---|
| 执行模型 | **单 Electron 主进程 + 单 Store（同步 SQLite）+ 单 SchedulerService**；异步执行、同步事务；v1 不支持多进程/分布式调度 |
| 事实源 | **事件日志唯一事实源**（`events` v2）；`tasks` / `runs` / `scheduler_state` / `agents.status` 是**可重建投影**；每次命令 = 一个 `BEGIN IMMEDIATE` 事务内的「事件 + 投影」原子写 |
| 事件 | 统一 `EventV2` 信封：`seq` 全局递增、`id`、`aggregate(Type/Id)`、`type`（注册表校验）、`actor`、`payload`、`schemaVersion`、`idempotencyKey`、`correlationId`、`causationId`、`occurredAt` |
| Task 状态 | 实现 **8 态**：`ready / queued / running / review / blocked / done / failed / cancelled`；`blocked` 带 `blockedReason`（等待依赖 / 依赖失败 / 依赖取消 / 人工阻塞）；非法迁移抛 `INVALID_TRANSITION` 且不写状态事件 |
| 任务创建 | 依赖未满足的任务创建即 `blocked(waiting_dependencies)`，依赖全部 done 自动 → `ready`（与现有「blocked=等待依赖」文案一致） |
| Run | 每次执行尝试一个 Run；`attempt` 单调递增；重试**新建 Run**（`retryOfRunId`），绝不复用；`(task_id, attempt)` 唯一；同一任务最多一个活跃 Run（部分唯一索引） |
| 租约 | Run 持 `lease_owner` + `lease_expires_at`；心跳 15s、租约 60s、tick 250ms；租约过期由恢复器回收 |
| 调度 | 有限并发：**全局 4 / 每工作区 1 / 每成员 1**（Git/worktree 隔离前工作区串行，可配；Q1）；就绪集合 = `ready` 且依赖全 done 且未到 `nextRunAt`；公平队列 = 优先级 + 入队时间 + 每成员轮转 + 等待老化 |
| 入队 | **默认手动入队**（`kernel.autoAdmit=false`，保留「运行任务」）；`ready→queued` 只由 startTask 或显式开启的自动策略触发（Q11） |
| 重试 | 可重试错误自动重试：**maxAttempts=3 表示总尝试（首跑 + 2 次重试）**、指数退避 5s×2ⁿ（上限 5min、±20% 抖动）；`failed → queued`；耗尽后 `failed(retry_exhausted)`；人工可随时 retry |
| 失败传播 | 依赖 `failed/cancelled` → 下游 `blocked(dependency_failed|cancelled)`，不自动 failed；依赖重试成功后自动解除 |
| 取消 | `cancelTask` 可从 ready/queued/running/review/blocked；running 先 abort → Run `cancelled` → Task `cancelled`；下游 → blocked；重复取消幂等 |
| 崩溃恢复 | 启动时迁移 → `recover()`：活跃 Run 租约不属于本实例或已过期 → Run `failed(LEASE_EXPIRED)`；按尝试策略把 Task 退回 `queued` 或 `failed`；清理孤儿/重复活跃 Run |
| API | 新增 `startTask/pauseScheduler/resumeScheduler/cancelTask/retryTask/cancelRun/getScheduler/listRuns/setTaskPriority`；`runTask` 保留为 `startTask` 的兼容别名（一阶段后废弃）；内核端点用 `KernelResult<T>` 包错误码 |
| UI | 任务页：queued 状态、排队/运行计数、暂停/恢复、Run 历史（attempt/状态/耗时/tokens/错误/重试/取消）、review 批准/拒绝；aria-live 播报调度与状态变化；不新增顶层入口 |
| 迁移 | `user_version 1→2`：先 WAL checkpoint/backup（校验可打开）→ 加列/索引 → 每聚合写 `kernel.legacy_snapshot` 基线事件 → 归一化历史状态 → 重建投影校验 → **全部成功后才写 `user_version=2`**；保留旧事件用于审计；失败自动恢复备份 |
| 交付拆分 | **t68**：事件内核 + 迁移 + 投影重建 + 状态机 + Run 生命周期/租约/心跳 + 恢复核心 + 单测/属性/迁移测试；**t69**：调度器 + 重试/退避 + 取消/暂停/优先级/公平 + API/IPC + UI + mock E2E（依赖 t68） |
| 非目标 | Git worktree/PR/合并队列、行级评审/Diff、看门狗完整实现、成本账本/预算定价、MCP/Skills/插件、跨工作区经验网络、多用户/权限、分布式/多进程调度、云沙箱、`proposed/approved` 人工前置态、任意 checkpoint 跨模型恢复、UI 重构 |

**内核不变量（实现与测试都必须成立）**

- **INV-1**：任一 Task 的当前状态 = 对该 Task 全部事件按 `seq` 顺序应用状态机的结果（投影重建一致）。
- **INV-2**：`running` 的 Task 恰好有一个 `running|waiting_human` 的 Run；`queued/ready/blocked/review/done/failed/cancelled` 的 Task 没有活跃 Run（review 的 Run 已 completed）。
- **INV-3**：`runs(task_id, attempt)` 唯一；`attempt` = 该 Task 已创建 Run 数，新增 Run 必须 `+1`。
- **INV-4**：所有状态写入都伴随事件；事件与投影在同一个 SQLite 事务内提交，崩溃后不出现「有事件无投影」或「有投影无事件」。
- **INV-5**：同一个 `idempotencyKey` 最多产生一个事件；重复命令返回原结果，不重复执行。
- **INV-6**：调度决策在事务内以「重读 + CAS」执行（`status='queued'` 才置 `running`），并发/IPC 重入不产生双 Run。
- **INV-7**：任务状态迁移必须命中迁移表；非法迁移被拒绝且不改变投影/不写状态事件。
- **INV-8**：Run 失败/取消/完成都写终态事件与 `endedAt`；不存在「静默消失」的 Run。
- **INV-9**：租约过期或进程重启后，原 Run 必被回收；不存在永久 `running` 的孤儿。
- **INV-10**：调度暂停只阻止新 Run 启动，不改变已在跑 Run 的租约心跳。
- **INV-11**：事件 `seq` 单调递增；消费方只按 `seq` 排序，不假设无空洞。
- **INV-12**：`blocked` 的下游任务不占用调度名额；依赖满足后由投影派生自动转 `ready`。

---

## 1. 目标、非目标与术语

### 1.1 目标（正式实现）

1. 事件日志成为唯一事实源，投影可随时重建，UI/API/Run 记录一致。
2. 严格 Task 状态机（含 queued / review / blocked 语义、依赖传播、取消）。
3. 完整 Run 生命周期（attempt、agent、token、error、checkpoint、heartbeat、lease、幂等、防重复执行）。
4. DAG 调度器：ready 集合、有限并发（全局/工作区/成员）、公平队列、优先级、暂停/恢复、取消、并发安全；为评测/预算/看门狗提供稳定接口。
5. 失败/恢复：依赖失败、超时、崩溃恢复、孤儿清理、租约回收、重试/退避、事件重放一致。
6. API/IPC/UI 契约与无障碍；状态机表驱动、并发/恢复、事件一致性 property test、迁移测试、mock 端到端。
7. 分阶段实施与文件级影响面，明确完整实现与非目标。

### 1.2 非目标（显式）

| 非目标 | 说明 |
|---|---|
| Git 并行开发（worktree/PR/合并队列/冲突解决） | DESIGN §7.1，后续独立系统；本内核只保留 `branch/worktree` 字段与 Run 结束钩子 |
| 行级评审与合并门禁（Monaco diff/行内评论/CI） | `review` 态只做「批准/拒绝」状态流转，不实现 diff UI |
| 看门狗完整实现 | 本内核提供心跳、租约、运行指标与 hook；检测/干预策略属下一系统 |
| 成本账本与预算定价 | Run 只记录 token/cost 字段与预算 hook；账本/降级链后续 |
| MCP / Skills / 插件平台 | 无工具面改动，权限门禁保持 t58 语义 |
| 跨工作区经验网络 | DESIGN §12，后续系统 |
| 多用户/权限/RBAC | 单用户本地应用 |
| 分布式/多进程调度、云沙箱 | v1 单主进程；事件/租约设计为未来留位，不实现 |
| `proposed / approved` 人工前置态 | DESIGN §5.2 预留，本内核 v1 不启用；创建即 ready/blocked |
| 任意 checkpoint 跨模型恢复 | 只做 checkpoint 落盘与事件；同模型同沙箱恢复列为 P2 |
| UI 大改版 | 只扩展任务页/调度栏/Run 历史；不新增顶层入口、不改 Dock 布局 |
| 事件归档/压缩/TTL | 保留全部事件；量级评估见 §13 |

### 1.3 术语

- **Command**：一次状态变更意图（startTask/cancel/…），带 `commandId`（幂等）。
- **Event**：已发生的状态事实；append-only。
- **Projection**：事件派生出的当前状态（tasks/runs/scheduler_state/agent status）。
- **Run**：一次执行尝试；Task 可有多个 Run（attempt 1..N）。
- **Lease**：Run 的 ownership 凭证（owner + expiry）；防重复执行与崩溃回收。
- **Ready set**：当前可被调度器启动的任务集合。
- **Waiting human**：Run 等待人类输入（高风险审批、review 决策等），不是 Task 状态。

---

## 2. 现状审计（HEAD 实读）

### 2.1 现状映射

| 能力 | 现状 | 位置/证据 | 缺口 |
|---|---|---|---|
| 事件日志 | `events(seq INTEGER PK AUTOINCREMENT, id UNIQUE, aggregate_type, aggregate_id, type, actor, payload, created_at)`；`appendEvent` 直接 INSERT 后同步通知监听器；`listEvents` 按 seq 升序 | `src/kernel/store.ts:95–105,377–446` | 无 schemaVersion / idempotencyKey / correlation / causation；无事务包装；类型无注册表校验 |
| 投影 | `tasks` / `runs` / `agents.status` 直接 UPDATE；`updateTask` 同时写投影并追加 `task.${status}` 动态事件 | `store.ts:64–93,671–713` | 投影与事件非原子；事件类型不规范；无法保证重建一致 |
| Task 状态 | 7 态（无 queued）；创建即 `ready`（即使依赖未完成）；状态直接字符串写入 | `src/shared/types.ts:60–68`；`store.ts:610–626` | 无状态机校验；依赖未满足也 ready；无 review 流转；无 blockedReason |
| Run | 4 态；字段只有 task/agent/status/error/时间/token；`createRun` 直接 running | `types.ts:86–98`；`store.ts:717–785` | 无 attempt/model/sandbox/heartbeat/lease/checkpoint/cost；失败不可重试 |
| 执行 | `service.runTask` 手动单任务：校验依赖/选成员/创建 Run/更新 Task/运行 loop/完成或失败；内存 `runningTasks` + `aborts` 防重复 | `service.ts:760–938` | 无队列/并发上限/公平/暂停/取消；多任务可并发但无成员级限制；崩溃后 running 残留 |
| Loop | `runAgentLoop` 顺序执行模型/工具，`onEvent` 上报；abort 抛错 | `src/kernel/loop.ts:37–147` | 无心跳/checkpoint；无运行时长上限；无结构化错误分类 |
| API/IPC | 仅 `runTask(taskId)`、`getTaskTrace(taskId)`；Snapshot 无 runs/scheduler | `src/shared/ipc.ts:29–31`；`service.ts:357–368` | 无调度/队列/Run 列表/重试/取消/暂停 |
| UI | 任务页：列表 + 详情 + trace；运行按钮在详情；过滤 7 态；无 queued/attempt/run 历史 | `src/App.tsx:613–617,1541–1548,1868–1918`；`copy.ts:8–16` | 无排队/调度可见性；无 Run 历史/重试/取消/review 操作 |
| 恢复 | `service.close()` abort 所有；启动无扫描 | `service.ts:201` | 崩溃后 Run 永久 running；无租约/孤儿清理 |
| 测试 | 10 个测试文件（kernel/service/model/permission/approval/…），权限/审批链完整 | `src/**/*.test.ts*` | 无状态机/调度/恢复/投影/迁移测试 |

### 2.2 缺口 → 设计章节映射

| 缺口 | 设计章节 |
|---|---|
| G1 事件信封/类型/校验/幂等 | §4 |
| G2 投影与重建、事务原子性 | §4.5–4.7 |
| G3 旧库迁移 | §10 |
| G4 8 态状态机/依赖/失败/取消 | §5 |
| G5 Run attempt/lease/heartbeat/checkpoint/幂等 | §6 |
| G6 调度器/并发/公平/暂停/优先级 | §7 |
| G7 重试/退避/崩溃恢复/孤儿 | §8 |
| G8 API/IPC/UI 与无障碍 | §9 |
| G9 验收/AC | §11 |
| G10 实施拆分/文件面 | §12 |

---

## 3. 架构总览

### 3.1 进程与并发模型

- **单主进程**：Electron main 持有唯一 `Store`（`node:sqlite` 的同步 `DatabaseSync`）与唯一 `SchedulerService`；renderer 只能经 IPC 发命令/查快照。
- **同步事务 + 异步执行**：所有命令、调度决策、状态迁移都是同步函数，在一个 SQLite 事务内完成；Run 的 LLM/工具执行是异步的，事务外进行，结束回调再开新事务写终态。
- **互斥**：JS 单线程 + 一个 `commandMutex`（promise 链）串行化所有 kernel 命令；调度 tick 与 IPC 命令共用该互斥；DB 使用 `BEGIN IMMEDIATE` + `busy_timeout=5000`。
- **多窗口/多实例**：v1 不支持（窗口单例）；若出现第二实例，`lease_owner` 不同会在恢复时回收，**禁止**同时运行两个调度器。设计保留未来多进程扩展点（lease/fencing/事件 seq），但明确非目标。

### 3.2 组件

```
src/kernel/
  eventRegistry.ts   // 事件类型枚举 + 每种 payload 的 zod schema + 版本/upcaster
  eventStore.ts      // append（校验/幂等/事务内）、list/replay、seq、idempotency 索引
  projections.ts     // tasks/runs/scheduler/agent 状态应用器 + rebuild + digest
  taskState.ts       // 状态机（8 态迁移表、guard、错误码）
  runLifecycle.ts    // Run 创建/租约/心跳/checkpoint/终态
  scheduler.ts       // tick、ready set、并发/公平/优先级/暂停/取消
  lease.ts           // owner/expiry 计算、心跳续租、过期检测
  recovery.ts        // 启动恢复、孤儿清理、租约回收、一致性检查
  checkpoint.ts      // checkpoint blob 读写（userData/checkpoints）
  kernel.ts          // 门面：命令/查询/快照；Service 只依赖它
  errors.ts          // KernelError/错误码
```

依赖方向：`service.ts → kernel.ts → {eventStore, taskState, runLifecycle, scheduler, recovery}`；`loop.ts` 只接收 heartbeat/checkpoint 回调，不感知 DB；`tools.ts` 的 `task.complete` 改为向 kernel 发完成命令（不再直接改状态）。

### 3.3 数据流（命令）

```
IPC/UI → KernelCommand → commandMutex
  → tx(BEGIN IMMEDIATE)
      validate (state machine/guard/idempotency/limits)
      append event(s) [idempotencyKey unique]
      apply projections (tasks/runs/scheduler_state/agent status)
    COMMIT
  → notify event listeners（renderer 刷新）
  → async side effects（启动/中止 Run、调度下一 tick）
```

### 3.4 数据流（执行）

```
Scheduler.tick → 选中 queued task
  → tx: task running + run(attempt=n, running, lease) + events(run.started, task.started)
  → 异步 Executor.run(run)
       loop step/tool → heartbeat(run, metrics) → tx: heartbeat_at + lease extend (+ run.heartbeat 事件节流)
       loop step → checkpoint → tx: checkpoint_ref + run.checkpoint
       审批等待 → run.waiting_human（独立 lease keeper 续租；120s 超时恢复）
  → 完成/失败/取消 → tx: run 终态 + task 终态/review/queued(retry) + events
  → 调度下一 tick（容量释放）
```

---

## 4. 事件日志（唯一事实源）

### 4.1 事件信封（v2）

```ts
export type AggregateType =
  | "workspace" | "agent" | "task" | "run" | "scheduler"
  | "message" | "board" | "memo" | "review";

export interface KernelEventV2 {
  /** 全局单调递增；SQLite AUTOINCREMENT，按 seq 排序，不假设无空洞 */
  seq: number;
  /** 事件 id：evt_<ulid-ish>，全局唯一 */
  id: string;
  aggregateType: AggregateType;
  aggregateId: string;
  /** 注册表校验的类型名，见 §4.2 */
  type: string;
  /** user | agent:<id> | system | human:<id>（本地用户固定 user） */
  actor: string;
  payload: Record<string, unknown>;
  /** payload 的 schema 版本；旧 v1 事件固定为 1，新 v2 事件写入时显式设为 2；upcaster 负责 1→2 */
  schemaVersion: number;
  /** 幂等键（可空）：唯一部分索引；重复 append 返回已有事件 */
  idempotencyKey: string | null;
  /** 关联命令/链路（如 task:task_x），用于排障与「一命令多事件」聚合 */
  correlationId: string | null;
  /** 直接原因事件 id（如 run.started 由 task.started 触发） */
  causationId: string | null;
  /** 业务发生时间（ISO）；与 recordedAt 区分（补录/重放） */
  occurredAt: string;
  /** 入库时间（ISO） */
  recordedAt: string;
}
```

**为什么保留 `occurredAt` 与 `recordedAt`**：崩溃恢复与补录会产生时间差；排序与审计以 `seq` 为准，时间仅用于 UI/看门狗。

### 4.2 事件类型目录（注册表）

> 写入前按注册表校验 payload；未知类型在 v2 写入路径**拒绝**（避免脏事件），读取路径**忽略未知类型**（向前兼容）。所有 payload schema 用现有 `zod` 实现。

| 聚合 | 事件 | payload（关键字段） | 由谁写 |
|---|---|---|---|
| workspace | `workspace.created` | name/path | Store |
| agent | `agent.created` / `agent.updated` / `agent.permission_changed` / `agent.status_changed` | agentId/patch/status | service/kernel |
| task | `task.created` | title/description/acceptance/dependsOn/priority/ownerId | kernel |
| task | `task.updated` | patch（title/description/acceptance/priority/ownerId） | kernel |
| task | `task.status_changed` | `from,to,reason,runId?`（**唯一状态变更事件**） | kernel |
| task | `task.blocked` / `task.unblocked` | reason（waiting_dependencies/dependency_failed/dependency_cancelled/manual） | kernel |
| task | `task.review_requested` / `task.review_approved` / `task.review_rejected` | runId/reviewer/notes | kernel |
| task | `task.retry_scheduled` | attempt/nextRunAt/errorCode | scheduler |
| task | `task.retry_exhausted` | attempts/lastErrorCode | scheduler |
| task | `task.cancelled` | reason（user/dependency/…）/abortedRunId | kernel |
| run | `run.started` | taskId/attempt/agentId/modelProfileId/sandboxId/leaseOwner | kernel |
| run | `run.heartbeat` | heartbeatAt/tokens（节流 30s） | executor |
| run | `run.checkpoint` | step/ref/tokenIn/tokenOut | executor |
| run | `run.waiting_human` | reason（risk_approval/review）/requestId | kernel |
| run | `run.resumed` | reason（approval/review） | kernel |
| run | `run.completed` | tokenIn/tokenOut/usage/steps/summaryId? | kernel |
| run | `run.failed` | errorCode/message/tokenIn/tokenOut/retryable | kernel |
| run | `run.cancelled` | reason/actor | kernel |
| scheduler | `scheduler.paused` / `scheduler.resumed` | actor/reason | kernel |
| scheduler | `scheduler.admitted` / `scheduler.rejected` | taskId/runId?/reason | scheduler |
| scheduler | `scheduler.tick` | counts/queueDepth（仅变化时写，节流） | scheduler |
| kernel | `kernel.legacy_snapshot` | 旧库投影基线（§10.4） | migration |
| kernel | `kernel.migrated` / `kernel.recovered` / `kernel.rebuild` | from/to、runIds、counts | kernel |
| kernel | `kernel.command_rejected` | command/errorCode（可选审计，不改变状态） | kernel |

**命名规则**：`<aggregate>.<past_tense_verb>`，全小写下划线；状态变更统一 `task.status_changed`（不再用 `task.done` 等动态名）。旧事件名通过 upcaster 映射（§10.5）。

### 4.3 seq 与顺序

- `events.seq INTEGER PRIMARY KEY AUTOINCREMENT`；写后 `lastInsertRowid` 作为 seq。
- 顺序保证：单进程单 Store + `BEGIN IMMEDIATE` 串行写；读取一律 `ORDER BY seq ASC`。
- 不保证无空洞（回滚可能消耗 AUTOINCREMENT）；消费方不得用 `seq + 1` 推断下一条。
- 多进程扩展（未来）：seq 由单写者分配或用全局逻辑时钟；本设计不做。

### 4.4 幂等键

- 对外命令：`commandId` 由 renderer 生成（`crypto.randomUUID()`），Kernel 在命令事务内先写/查 **`kernel_commands(command_id PRIMARY KEY, command_type, status, result_json, error_json, created_at, completed_at)`**；重复 commandId 直接返回首次结果（成功或失败），不重复执行、不重复写事件。
- 命令可以产生多个事件：**事件级 `idempotencyKey` 不得共用同一个 `cmd:{commandId}`**（否则唯一索引会在第二条事件冲突）；使用派生 key `cmd:{commandId}:{n}` 或 null，命令级幂等由 `kernel_commands` 保证。`correlationId` 统一写 `cmd:{commandId}`，用于把一命令多事件串起来。
- 内部关键动作也带幂等键：
  - 启动 Run：`run:{taskId}:attempt:{n}:started`
  - 状态迁移：`task:{taskId}:{from}->{to}:{seqOrRun}`（避免同一迁移双写）
  - 恢复：`recovery:{bootId}:{runId}:lease_expired`
  - 迁移基线：`legacy:snapshot:{aggregateType}:{aggregateId}`
- 表结构：`CREATE UNIQUE INDEX ux_events_idem ON events(idempotency_key) WHERE idempotency_key IS NOT NULL;`
- `appendEvent` 在事务内 `INSERT ... ON CONFLICT(idempotency_key) DO NOTHING`，冲突时读取已有事件返回，且**不再应用投影**；命令层已由 `kernel_commands` 命中时不应再进入 append。
- 失败命令也记录 `kernel_commands.status='failed' + error_json`；重试同一 commandId 返回原失败，不重新执行（需要重新执行时由 renderer 生成新 commandId）。

### 4.5 事务原子性

```ts
// Store/EventStore 提供唯一事务入口（同步；禁止 await）
withTransaction<T>(fn: (tx: Tx) => T): T {
  this.db.exec("BEGIN IMMEDIATE");
  try { const out = fn(tx); this.db.exec("COMMIT"); return out; }
  catch (e) { this.db.exec("ROLLBACK"); throw e; }
  finally { this.flushPendingListenersAfterCommit(); }
}
```

- 事件监听器（renderer 推送）**在 COMMIT 后**按 seq 顺序通知，避免「未提交事件被消费」。
- 禁止在事务内 await；异步执行结果一律回到命令层开新事务。
- `busy_timeout = 5000`；单进程下不预期锁冲突，但防御 WAL checkpoint/备份操作。

### 4.6 投影

| 投影 | 来源事件 | 字段 |
|---|---|---|
| `tasks` | task.created/updated/status_changed/blocked/unblocked/review_* | 现有字段 + priority/queued_at/blocked_reason/failure_kind/attempt_count/next_run_at |
| `runs` | run.* | 现有字段 + attempt/model_profile_id/model_id/sandbox_id/heartbeat_at/lease_owner/lease_expires_at/checkpoint_ref/cost_usd/error_code/retry_of_run_id |
| `agent_status` | agent.status_changed（或仍由 kernel 写 agents） | status |
| `scheduler_state` | scheduler.paused/resumed | workspace_id/paused/updated_at |
| `settings` | 非事件源（配置），变更可写 `workspace.updated` 审计事件 | 保持现状（显式边界） |

**投影规则**：

1. 每个投影应用函数必须是纯函数式「事件 → 状态更新」，不读其他投影（除任务依赖查询需要 tasks 投影；重建时按 seq 顺序自然满足）。
2. 应用函数必须幂等：同一事件重复应用结果不变（用于故障恢复/重放）。
3. `projection_version` 存 settings；版本变化触发重建（或拒绝启动并要求 rebuild）。
4. 重建：清空 tasks/runs/agent_status/scheduler_state → 从最小有效 seq 重放（迁移基线之后的 v2 事件；见 §10.4）→ 写 `kernel.rebuild` 事件（不参与投影）→ 校验 digest（tasks 数/状态计数/runs 数/活跃 Run 数）。

### 4.7 事件 schema 版本与 upcaster

- 每个类型注册 `{ currentVersion: 2, schema, upcast?: (payload, version) => payload }`（v2 事件）。
- 旧 v1 事件 version=1，读取时先在内存 upcast 到 2 再投影；**写回不修改历史**；新写入必须显式 `schemaVersion=2`（不依赖 DDL 默认值）。
- 新增字段必须给默认值；删除/重命名走新事件类型 + 迁移脚本，不做原地改写。

---

## 5. Task 状态机

### 5.1 状态语义（8 态）

| 状态 | 含义 | 是否可调度 | 是否有活跃 Run |
|---|---|---|---|
| `ready` | 依赖全部满足、可被调度（尚未入队或从 blocked/retry 回归） | ✅（入队） | ❌ |
| `queued` | 已入调度队列，等待并发/成员/工作区容量 | ✅（等待启动） | ❌ |
| `running` | 有活跃 Run 正在执行/等待人类 | ❌ | ✅ 恰好 1 |
| `review` | Run 成功完成，等待 review 决策（`reviewPolicy=required`） | ❌ | ❌（Run completed） |
| `blocked` | 不可运行：依赖未满足/依赖失败/依赖取消/人工阻塞 | ❌ | ❌ |
| `done` | 终态：Run 成功且（无 review 或 review 通过） | ❌ | ❌ |
| `failed` | 终态：Run 失败且重试耗尽/不可重试，或 review 拒绝 | ❌（可 retry） | ❌ |
| `cancelled` | 终态：用户/系统取消 | ❌ | ❌ |

> `proposed / approved`（DESIGN §5.2）为将来人审前置态，v1 不实现；创建任务直接进入 `ready` 或 `blocked(waiting_dependencies)`。

### 5.2 迁移表（唯一合法迁移）

| # | from → to | 触发 | 守卫 | 副作用/事件 |
|---|---|---|---|---|
| T1 | （创建）→ ready | createTask（依赖全满足） | 标题非空、依赖存在且无环 | task.created |
| T2 | （创建）→ blocked(waiting_dependencies) | createTask（依赖未满足） | 同上 | task.created + task.blocked |
| T3 | blocked → ready | 依赖全部 done | 依赖状态检查 | task.unblocked + status_changed |
| T4 | blocked(manual) → ready | 人工解除 | actor=user | task.unblocked |
| T5 | ready → queued | startTask / 调度自动入队（策略：手动/自动） | 依赖全 done、无活跃 Run | task.status_changed(queued) |
| T6 | queued → ready | 出队（暂停/手动移出/容量策略） | 无活跃 Run | task.status_changed(ready) |
| T7 | queued → running | Scheduler 启动 | 并发/成员/工作区限制满足；依赖仍满足；CAS queued→running | run.started + task.status_changed(running) |
| T8 | running → review | Run completed 且 reviewPolicy=required | Run completed、无 error | run.completed + task.review_requested + status_changed(review) |
| T9 | running → done | Run completed 且 reviewPolicy=auto | Run completed | run.completed + status_changed(done)、写 summary |
| T10 | running → failed | Run failed 且不可重试/重试耗尽 | Run 终态 failed | run.failed + status_changed(failed) |
| T11 | running → queued | 自动重试（可重试错误） | attempt < maxAttempts；退避到期 | run.failed + task.retry_scheduled + status_changed(queued) |
| T12 | running → cancelled | cancelTask（user/system） | abort 成功/无需 abort | run.cancelled + task.cancelled |
| T13 | review → done | review approve | reviewer 合法（user/agent policy） | task.review_approved + status_changed(done) |
| T14 | review → failed | review reject | 同上 | task.review_rejected + status_changed(failed, review_rejected) |
| T15 | review → cancelled | cancelTask | user/system | task.cancelled |
| T16 | failed → queued | retryTask（人工）/ 自动重试 | attempts < max（人工可无视） | task.retry_scheduled + status_changed(queued) |
| T17 | failed → cancelled | cancelTask | user | task.cancelled |
| T18 | ready/queued/blocked/review/running → cancelled | cancelTask | 见 §5.4 | 见 §5.4 |
| T19 | blocked(dependency_failed) → blocked(dependency_cancelled) | 上游由失败变取消 | 仅原因更新，不改变状态 | task.blocked(reason 更新，审计) |
| T20 | ready → blocked(manual) | 人工阻塞 | actor=user | task.blocked(manual) + task.status_changed(blocked) |
| T21 | queued → blocked(waiting_dependencies) | 调度启动前依赖失效 | 依赖未全 done | task.blocked(waiting_dependencies) + task.status_changed(blocked) |
| T22 | blocked(reasonA) → blocked(reasonB) | 依赖失败/取消原因变化（A/B ∈ waiting_dependencies / dependency_failed / dependency_cancelled） | 仍 blocked，仅原因变化 | task.blocked(reasonB)（不写 status_changed、不改状态；审计；幂等键 `task:{id}:blocked:{reasonB}:{seq}`） |

**非法迁移**（其余所有组合）→ `KernelError("INVALID_TRANSITION", {taskId, from, to, trigger})`；不写 `task.status_changed`，不改投影。是否写 `kernel.command_rejected` 由 `kernel.auditRejectedCommands` 设置控制（默认开，audit 用，不参与投影）。

### 5.3 依赖满足与失败传播

- **依赖检查**：`dependsOn` 在创建/更新时校验：所有 id 存在、属于同一工作区、无环（DFS/拓扑排序）；否则 `INVALID_DEPENDENCY`。
- **满足**：所有依赖 `status=done` → 当前任务可从 blocked 转 ready（T3）。
- **失败传播**：依赖 `failed` → 直接下游 `blocked(dependency_failed)`；依赖 `cancelled` → `blocked(dependency_cancelled)`。**不**自动把下游置 failed/cancelled（保留用户重试上游的机会）。若下游原本已 `blocked(waiting_dependencies)`，仅按 T22 更新 blockedReason，不改变状态、不重复写 status_changed。
- **原因更新**：`blocked(reasonA)` 因上游状态变化改 reasonB 时走 T22；写 `task.blocked(reasonB)` 审计事件，保留状态与活跃 Run（应为 0）不变；重复原因不重复写事件。
- **恢复**：依赖 retry 后 done → 触发下游 blocked→ready（T3）；若依赖 still failed → 保持 blocked。
- 传递性：只更新直接下游；更远下游本就 `blocked(waiting_dependencies)`，在每次依赖状态变化时重新评估，自然级联。
- 依赖不可在 running 之后修改（`task.updated` 拒绝 dependsOn 变更，返回 `DEPENDENCY_LOCKED`）；只允许在 ready/blocked 阶段调整。

### 5.4 取消语义

| 当前状态 | 行为 |
|---|---|
| ready | → cancelled（T18）；写 task.cancelled(reason) |
| queued | 从队列移除 → cancelled；不创建 Run |
| running | 找到活跃 Run → `abortController.abort()`；Run 终态 `cancelled`；Task → cancelled；Agent → idle |
| review | → cancelled；Run 保持 completed（历史保留） |
| blocked | → cancelled；后续依赖满足不再唤醒（状态终态） |
| done/failed/cancelled | 幂等：若已 cancelled 返回成功（`already_cancelled`）；否则 `INVALID_TRANSITION`（failed 允许 retry 但 cancel 也可：T17） |

- **下游**：被取消任务的下游 → `blocked(dependency_cancelled)`（T22/T3 路径），不会自动取消。
- **abort 竞争**：Run 可能已完成；事务内重读 Run 状态，若终态则不覆盖，仅把 Task 置 cancelled（若仍 running/review）或返回冲突；事件记录实际结果。
- **超时/租约回收**不是 cancel：Run failed(errorCode=RUN_TIMEOUT/LEASE_EXPIRED)，Task 按重试策略处理。

### 5.5 review 语义

- 配置：`settings["kernel.reviewPolicy"] = "auto" | "required"`，**默认 `auto`**（保持当前单用户自动完成体验；`required` 为团队协作模式）。Open Question Q2。
- `required` 时 Run 完成 → Task review；UI 显示批准/拒绝；reviewer actor 记录 `user` 或 `agent:<id>`（是否允许 agent 审批由 `kernel.reviewers` 配置，默认仅 user）。
- 拒绝 → failed(failure_kind=review_rejected)，可 retry（T16）；重试必须新建 Run。
- review 期间 Run 已 completed，不占调度名额；Task 不自动重试。

---

## 6. Run 生命周期

### 6.1 Run 模型（v2）

```ts
export type RunStatus =
  | "queued"          // 预留（未来分布式 executor）；v1 创建即 running 或 waiting_human
  | "running"
  | "waiting_human"   // 高风险审批 / review 决策等待（非 Task review）
  | "completed" | "failed" | "cancelled";

export interface RunV2 {
  id: string;
  taskId: string;
  attempt: number;                 // 1..N，同 Task 单调递增
  agentId: string;
  modelProfileId: string;
  modelId: string;
  permissionSnapshot: PermissionMode; // 运行开始时的权限，供审计（不随后续修改变化）
  sandboxId: string;               // v1 = workspace:<id>（无独立沙箱）
  status: RunStatus;
  errorCode: string | null;
  error: string | null;
  retryable: boolean;
  retryOfRunId: string | null;     // 非首次 attempt 时指向上一 Run
  startedAt: string;
  endedAt: string | null;
  heartbeatAt: string;
  leaseOwner: string;              // `${instanceId}:${bootId}`
  leaseExpiresAt: string;
  checkpointRef: string | null;    // userData/checkpoints/<runId>.json
  checkpointStep: number;
  tokenIn: number;
  tokenOut: number;
  costUsd: number;                 // 仅记录（v1 无定价表时为 0）
  steps: number;
  summaryId: string | null;
}
```

### 6.2 attempt 与幂等

- `attempt = task.attempt_count + 1`，在同一事务内 +1 并创建 Run；`UNIQUE(task_id, attempt)`。
- Run 创建幂等键 `run:{taskId}:attempt:{n}:started`；重复启动命令命中已有事件 → 返回现有 Run，不再执行。
- **禁止复用 Run**：重试/再次运行一律新 Run；`retryOfRunId` 指向上一次 attempt（第 1 次为 null）。
- 同一 Task 活跃 Run 唯一：`CREATE UNIQUE INDEX ux_runs_active ON runs(task_id) WHERE status IN ('queued','running','waiting_human');`
- `runTask` 兼容层：`startTask` + 等待首个 Run 终结（可选），内部不得绕过活跃唯一约束。

### 6.3 Run 状态迁移

| from → to | 触发 | 事件/条件 |
|---|---|---|
| （创建）→ running | Scheduler 启动 | run.started；lease 获取；Task queued→running |
| running → waiting_human | 高风险审批请求 / review 决策 | run.waiting_human；由独立 lease keeper 续租（不能依赖等待中的工具调用）；Task 保持 running |
| waiting_human → running | 人工批准/拒绝回执 | run.resumed（批准）或转 failed/cancelled（拒绝按错误码） |
| running → completed | Agent loop 正常结束（task.complete 或自然完成） | run.completed；Task → done/review |
| running → failed | 异常/超时/租约丢失/取消外的失败 | run.failed（errorCode/retryable） |
| running/waiting_human → cancelled | cancelTask/cancelRun | run.cancelled；abort 信号 |
| queued → cancelled | 预留状态取消 | run.cancelled |

- 终态（completed/failed/cancelled）不可再迁移；重复回执幂等返回。
- `waiting_human` 的 120s 审批超时由 Approval 服务（t58）解析：批准 → resumed；超时/拒绝 → failed(errorCode=RISK_DENIED/RISK_TIMEOUT，retryable=false) — 与现有工具层行为一致，但由 kernel 统一记录 Run 状态。**审批等待期间必须由独立 lease keeper 每 15s 续租（或把租约 TTL 调至 ≥ 审批超时 + 心跳间隔），否则 60s 租约会在 120s 审批完成前过期。**
- 所有 lifecycle 写（heartbeat/checkpoint/run.resumed/终态）必须在同一事务内执行租约 CAS：`WHERE id=? AND lease_owner=? AND status IN ('running','waiting_human')`；影响行数=0 表示已被回收/换主，执行器立即 abort 并写 `run.result_discarded`（不改变 Run 状态）。

### 6.4 租约（lease）

- `leaseOwner = "${instanceId}:${bootId}"`；`instanceId` 持久化随机值，`bootId` 每次启动新值。
- `leaseExpiresAt = now + 60s`；执行器每 15s（或每次 step/tool 调用）续租；**续租/心跳/checkpoint/终态全部使用 CAS（见 §6.6.4）**；CAS 失败 = 已被回收/换主 → 执行器立即停止并丢弃结果（fencing 语义）。
- 续租与心跳写在同一命令：`heartbeatAt` 更新投影 + 每 30s 写一次 `run.heartbeat` 事件（节流），租约延长不写事件（可审计可选）。`waiting_human` 期间由独立 lease keeper 执行同一 CAS 续租，不依赖工具调用。
- 回收：Scheduler/Recovery 扫描 `status IN ('running','waiting_human') AND lease_expires_at < now` → 视为丢失，进入 §8.4。

### 6.5 心跳与 checkpoint

- 心跳：Run 执行器在每次 LLM 调用前/工具调用前后更新；超时阈值：心跳 >10min 无变化 → 看门狗信号（本内核只暴露指标）。
- checkpoint：每个 step 结束写 `checkpointRef`（JSON：messages、step、tool results、usage），并写 `run.checkpoint` 事件（每个 step 一条；大 payload 只存引用）。用途：
  1. 崩溃后排障与消耗核对；
  2. 交接摘要（DESIGN §7.4 换模型前）；
  3. P2 同模型恢复（v1 非目标）。
- checkpoint 文件写入失败不阻断执行（记录 warning 事件/日志）。

### 6.6 防重复执行

1. 调度事务 CAS：`UPDATE tasks SET status='running' WHERE id=? AND status='queued'` 影响行数必须为 1。
2. 活跃 Run 部分唯一索引。
3. 幂等键 + `attempt` 唯一。
4. 租约 fencing：**所有 lifecycle 写**（heartbeat/checkpoint/resume/终态）必须 CAS `lease_owner` 与 `status`；不匹配则丢弃结果并记录 `run.result_discarded`（审计事件，不改变状态）。
5. 单进程互斥：kernel 命令串行化。

---

## 7. DAG 调度器

### 7.1 就绪集合

```
readySet(workspace, now) =
  tasks WHERE workspace_id = ?
    AND status = 'queued'
    AND (next_run_at IS NULL OR next_run_at <= now)
    AND NOT EXISTS 活跃 Run
    AND 所有 dependsOn 任务 status='done'
ORDER BY priority DESC, queued_at ASC, id ASC
```

- 依赖在入队后仍可能变化（上游 retry/fail）：调度启动前再次校验；不满足则 `queued → blocked(waiting_dependencies)` 并退出本次候选（防御性）。
- 手动 `startTask`：先做状态/依赖校验，然后 `ready → queued`（T5），立即触发 tick；不直接 running。
- **入队策略（Q11）**：默认手动（settings `kernel.autoAdmit=false`），只有 `startTask` 将 `ready→queued`；开启 `autoAdmit=true` 时，创建/解阻/重试后自动走同一 T5（依赖检查、事件、幂等键 `task:{id}:admit:{seq}`、`scheduler.admitted`）。自动策略与暂停/取消交互：暂停期间仍可入队但不出队；取消则移出队列；不得绕过 T5。

### 7.2 并发限制

| 维度 | 默认 | 配置键 | 说明 |
|---|---|---|---|
| 全局 | 4 | `kernel.maxGlobalRuns` | 整个应用跨工作区 |
| 每工作区 | 1 | `kernel.maxWorkspaceRuns`（可按工作区覆盖） | **v1 默认串行**：当前所有 Run 共享 workspace 路径，Git/worktree 隔离尚未实现；>1 前必须增加每工作区写租约/文件锁 |
| 每成员 | 1 | `Agent.maxConcurrency`（默认 1） | 成员串行，避免同一成员并发写冲突（不能替代跨成员隔离） |
| 每任务 | 1 | 硬约束（活跃 Run 唯一） | — |

- 启动前检查：全局活跃数 < 上限、工作区活跃数 < 上限、该成员活跃 Run 数 < `maxConcurrency`、成员状态非 offline。
- **工作区写安全**：v1 工作区并发固定 1；若未来开放 >1，必须先有 worktree/写租约/文件锁，并保证两个不同成员同时写同一文件时串行或拒绝（AC-SC-02）。
- 成员选择：任务 `ownerId` 优先；未指定时按「空闲成员 + 轮转」选择；无可用成员 → 任务留 queued，事件 `scheduler.rejected(reason=no_agent)`（节流，不刷屏）。
- 并发配置变更不打断运行中 Run，只影响后续启动。

### 7.3 公平队列与优先级

- 排序：`priority DESC` → `queued_at ASC` → `id ASC`。
- 每成员轮转：同一成员连续启动上限 1（即不会在有多成员空闲时连续抢占同一成员）；实现为「按成员分组，队首轮询」。
- 等待老化：排队超过 5 分钟，有效优先级 +1（最高 +5，仅调度排序用，不写回用户设置），防饿死。
- 优先级范围 0–100（默认 50；数字越大越先）；用户可在任务详情调整；plan 创建默认 50。
- 同优先级下 FIFO；调度器每次 tick 最多启动 `min(可用容量, 每 tick 上限)`（默认 2）个，避免 UI 突刺。

### 7.4 暂停 / 恢复

- `pauseScheduler(workspaceId)`：写 scheduler.paused 事件 + 投影；不再启动新 Run；已运行 Run 继续（§INV-10）；queued 保留。
- `resumeScheduler`：清除 paused，立即 tick。
- 可选 `pauseMode`（未来）：`drain`（默认，等运行结束）| `checkpoint`（通知执行器 checkpoint 后暂停）——v1 只实现 drain，checkpoint 模式显式非目标。
- 暂停期间 `startTask` 仍可入队；UI 显示「已暂停 · N 排队」。

### 7.5 取消

- `cancelTask` 见 §5.4；调度器中：
  - queued：移出队列（状态 cancelled），不创建 Run。
  - running：事务外 abort；执行器捕获 abort → Run cancelled（幂等）；若执行器无响应，租约到期由 Recovery 兜底。
- `cancelRun(runId)`：只取消 Run；若 Task 仍 running，Task 转 failed(errorCode=RUN_CANCELLED) 以免卡住（或按 retry 策略），设计选择：**Run 取消 → Task failed(retryable=true，可 retry)**，除非是 Task 级取消（此时 Task cancelled）。

### 7.6 并发安全

- **单一调度循环**：`Scheduler.tick()` 通过 `commandMutex` 串行；tick 不重入（`tickRunning` 标志），事件唤醒合并到下一 tick。
- **CAS**：选中后事务内重读 `task.status='queued'` 且无活跃 Run，再 update；失败跳过。
- **资源计数**：并发计数从 runs 投影实时查询（`SELECT count(*) WHERE status IN (...)`），不依赖内存计数，避免重启不一致。
- **锁顺序**：单事务单表顺序固定（tasks → runs → events），避免死锁（单连接无死锁，但保持一致）。
- **IPC 命令**：全部经 commandMutex；`commandId` 幂等；命令执行期间不 await 执行器。
- **时钟**：租约/退避使用 `Date.now()`；提供 `Clock` 注入以便测试；不依赖墙钟单调（租约比较用 epoch ms）。

### 7.7 与评测 / 预算 / 看门狗的接口

```ts
export interface KernelHooks {
  /** 启动前门禁（预算/评测/看门狗策略）；默认放行；抛出/超时视为拒绝 */
  beforeStart(ctx: {
    workspaceId: string; taskId: string; runId: string; agentId: string;
    attempt: number; priority: number;
  }): Promise<{ allow: boolean; reason?: string }>;

  /** 心跳时上报指标（预算/看门狗/评测采样） */
  onRunHeartbeat(info: {
    runId: string; taskId: string; agentId: string;
    heartbeatAt: string; steps: number; tokenIn: number; tokenOut: number;
    lastEventType?: string;
  }): void;

  /** Run 终结（成功/失败/取消） */
  onRunFinished(info: {
    runId: string; taskId: string; status: RunStatus;
    errorCode: string | null; tokenIn: number; tokenOut: number; durationMs: number;
  }): void;

  /** 调度 tick 统计（队列深度/暂停/容量），用于 UI/监控 */
  onSchedulerTick(stats: SchedulerStats): void;
}
```

- `beforeStart`：50ms 超时；超时/异常 → deny（fail-closed），写 `scheduler.rejected(reason=hook_error)`；**hook 返回后在同一事务内重新读取全局/工作区/成员活跃数并 CAS 启动**；期间容量被占满或调度暂停则跳过并写 `scheduler.rejected(reason=limit_reached|paused)`，不得超发。
- **G3 增补（t79）**：`beforeStart` 返回类型与 `RunEnvironmentProvider`（prepare/release）扩展见 **§16**；未吸收前保持本节原签名与工作区并发 1，Git G3 不开启。
- 预算：只读 run 的 token/cost 字段；超限由 hook deny 新启动；Run 内部预算（max tokens）沿用现有 profile/FT。
- 看门狗：读取 heartbeat/事件/run 指标；干预动作通过 `pauseScheduler`/`cancelRun`/`retryTask` 命令（不直接改 DB）。
- 评测：通过 events/结束指标采样；不在内核内实现评分。

---

## 8. 失败、重试与恢复

### 8.1 错误分类

| errorCode | 场景 | 可重试 | 默认处理 |
|---|---|---|---|
| `PROVIDER_NETWORK` | 网络/超时/5xx | ✅ | 自动重试 + 退避 |
| `PROVIDER_RATE_LIMIT` | 429/quota | ✅（长退避） | 自动重试；连续失败升级 |
| `PROVIDER_AUTH` | 401/403 | ❌ | failed；提示配置 |
| `MODEL_ERROR` | 模型返回异常 | ✅（有限） | 重试 1 次后失败 |
| `TOOL_TRANSIENT` | 工具临时失败 | ✅ | 重试 |
| `TOOL_DENIED` | 权限拒绝 | ❌ | failed（需要人改权限/审批） |
| `RISK_TIMEOUT` / `RISK_DENIED` | 高风险审批未通过 | ❌ | failed |
| `RUN_TIMEOUT` | 超过 maxRuntime | ✅ | 重试；连续超时升级 |
| `LEASE_EXPIRED` | 租约丢失/崩溃 | ✅ | 恢复时重排 |
| `BUDGET_EXHAUSTED` | 预算 hook 拒绝 | ❌ | failed，等人工 |
| `REVIEW_REJECTED` | review 拒绝 | ✅（人工） | 默认不自动重试，人工 retry |
| `USER_CANCELLED` | 用户取消 | ❌ | cancelled |
| `INTERNAL` | 未分类异常 | ✅（有限） | 重试 1 次后 failed |

- 错误码写入 Run `errorCode` 与 `run.failed` payload；`retryable` 字段决定自动重试。
- 模型/工具层抛出的原始错误在 `run.failed.error` 保留（截断 4KB）。

### 8.2 重试与退避

- 默认 `maxAttempts = 3`（配置 `kernel.maxAttempts`，**总尝试：首跑 + 2 次重试**）；人工 retry 可超过（标记 `manual_retry`，计为新 attempt，仍受全局尝试上限 `kernel.maxManualAttempts = 10`（总尝试）保护）。
- 自动重试仅当 `retryable && attempt < maxAttempts`（maxAttempts=3 时，attempt 1 失败后重试 2、attempt 2 失败后重试 3，第三次失败即耗尽）：
  - 写 `run.failed` → `task.retry_scheduled{attempt:n+1, nextRunAt}` → Task `queued`；
  - 退避：`delay = min(5s × 2^(attempt-1), 5min) × jitter(0.8–1.2)`；jitter 由 `hash(taskId + attempt)` 确定性生成，便于测试；
  - `nextRunAt` 到点前调度器不启动；到点后按正常队列排序。
- 重试耗尽：`run.failed` → `task.retry_exhausted` → Task `failed`；UI 显示可 retry。
- 手动 retry：`retryTask(taskId)`：failed → queued（attempt+1，nextRunAt=now），写 `task.retry_scheduled`；若任务仍在 running/review → 拒绝 `INVALID_TRANSITION`。

### 8.3 依赖失败传播（见 §5.3）

- 上游最终 failed：下游 blocked(dependency_failed)；不自动重试下游。
- 上游取消：下游 blocked(dependency_cancelled)。
- 上游 retry 成功：下游自动 ready（T3），无需人工解除。
- 若下游已 cancelled/done：不再改变。

### 8.4 崩溃恢复（启动时 `RecoveryService.recover()`）

执行顺序（每个 Run 一个事务）：

1. **迁移**：若 `user_version < 2`，先执行 §10 迁移（失败则拒绝启动，保留备份）。
2. **清理孤儿**：
   - `runs` 中 `task_id` 不存在或 Task 已处于终态但 Run 活跃 → Run `cancelled(ORPHANED)`；记录 `kernel.recovered`。
   - 同一 Task 多个活跃 Run（历史脏数据）→ 保留最新 attempt，其余 `cancelled(DUPLICATE_ACTIVE)`。
3. **租约回收**：`status IN ('running','waiting_human')` 且（`lease_owner != 当前 owner` 或 `lease_expires_at <= now`）：
   - Run → `failed(LEASE_EXPIRED, retryable=true)`；
   - Task：若 attempt < maxAttempts → `queued`（nextRunAt=now，event `task.retry_scheduled`）；否则 `failed`；
   - Agent：若该成员无其他活跃 Run → idle；
   - 写 `kernel.recovered {runId, taskId, action}`。
4. **状态归一**：
   - `running` 但无活跃 Run 的 Task → `queued`（若依赖仍满足且有尝试余额）或 `failed(INTERNAL)`；
   - `queued` 但依赖不满足 → `blocked(waiting_dependencies)`；
   - `blocked(dependency_*)` 的上游已 done → `ready`（触发依赖重算）。
5. **一致性自检**（dev/测试 & 启动抽样）：活跃 Run 数 = running Task 数；runs 与 tasks 状态映射一致；不一致写 `kernel.recovered {invariant}` 并修正（保守：保留事件，修正投影）。
6. **恢复完成事件**：`kernel.recovered {counts, durationMs}`；启动日志。
- **幂等**：恢复可重复执行；每步使用幂等键 `recovery:{bootId}:{runId}:{action}`；第二次运行无变化。
- **崩溃窗口**：事务提交前崩溃 → 事件/投影都未写，重试命令；提交后崩溃 → 恢复扫描处理；不允许半提交。
- **孤儿 worker**：v1 无独立 worker 进程；若未来有，`lease_owner` fencing + 定期心跳；本设计保留字段。

### 8.5 超时

| 超时 | 默认 | 行为 |
|---|---|---|
| Run 最大执行时长 | 30min | 执行器检查 `signal` + 定时器 → abort → Run failed(RUN_TIMEOUT, retryable) |
| 心跳超时（内核判定） | >90s 无心跳（≈6×15s） | Scheduler tick 回收租约（若本实例仍在跑则先 abort）；watchdog 可更早告警 |
| 租约 TTL | 60s | 恢复/调度判定过期 |
| 排队最长 | 不限，但老化提优先级 | — |
| 审批等待 | 120s（t58） | waiting_human → failed(RISK_TIMEOUT) |
| review 等待 | 不限（人工） | 不占容量；看门狗可提醒 |

### 8.6 事件重放后一致

- `rebuildProjections()` 从基线后事件重放，结果必须与当前投影逐字段一致（digest：tasks 状态计数、runs 计数/终态、活跃 Run 集合、attempt 最大值）。
- 属性测试（§11）：随机生成合法事件序列 → 投影 → 重建 → 相同。
- 恢复测试：构造「运行中崩溃」DB → recover → 重建 → 一致。

---

## 9. API / IPC / UI 契约

### 9.1 命令与查询（主进程）

```ts
// commands（全部经 commandMutex；带 commandId 幂等）
startTask(taskId: string, opts?: { commandId: string; priority?: number }): Promise<Task>;
cancelTask(taskId: string, opts: { commandId: string; reason?: string }): Promise<Task>;
retryTask(taskId: string, opts: { commandId: string; force?: boolean }): Promise<Task>;
setTaskPriority(taskId: string, priority: number, opts: { commandId: string }): Promise<Task>;
reviewTask(taskId: string, decision: "approve" | "reject", opts: { commandId: string; notes?: string; reviewer?: string }): Promise<Task>;
pauseScheduler(workspaceId: string, opts: { commandId: string; reason?: string }): Promise<SchedulerSnapshot>;
resumeScheduler(workspaceId: string, opts: { commandId: string }): Promise<SchedulerSnapshot>;
cancelRun(runId: string, opts: { commandId: string }): Promise<Run>;
listRuns(taskId: string): Promise<Run[]>;
getScheduler(workspaceId: string): Promise<SchedulerSnapshot>;
```

```ts
export interface SchedulerSnapshot {
  workspaceId: string;
  paused: boolean;
  limits: { maxGlobal: number; maxWorkspace: number; maxPerAgent: number };
  counts: {
    total: number; ready: number; queued: number; running: number;
    review: number; blocked: number; done: number; failed: number; cancelled: number;
  };
  activeRuns: RunSummary[];
  queue: Array<{ taskId: string; title: string; priority: number; queuedAt: string; ownerId: string | null }>;
  updatedAt: string;
}
```

- `runTask(taskId)`：保留兼容，内部 = `startTask` + 等待该 Task 首个 Run 终止（带超时/取消）；计划在 t69 完成后一版移除或标记 deprecated。
- 查询变 `Snapshot` 扩展：`runs: Run[]`（近 50 条）+ `scheduler: SchedulerSnapshot`；或独立查询，UI 通过事件刷新。设计采用**扩展 Snapshot + 事件刷新**（renderer 已有 onEvent 防抖刷新机制），避免多套状态源。

### 9.2 IPC / preload

| 通道 | 方向 | 入参 | 返回 |
|---|---|---|---|
| `kernel:startTask` | invoke | `{taskId, commandId, priority?}` | `KernelResult<Task>` |
| `kernel:cancelTask` | invoke | `{taskId, commandId, reason?}` | `KernelResult<Task>` |
| `kernel:retryTask` | invoke | `{taskId, commandId, force?}` | `KernelResult<Task>` |
| `kernel:reviewTask` | invoke | `{taskId, decision, commandId, notes?, reviewer?}` | `KernelResult<Task>` |
| `kernel:setTaskPriority` | invoke | `{taskId, priority, commandId}` | `KernelResult<Task>` |
| `kernel:pause` / `kernel:resume` | invoke | `{workspaceId, commandId, reason?}` | `KernelResult<SchedulerSnapshot>` |
| `kernel:cancelRun` | invoke | `{runId, commandId}` | `KernelResult<Run>` |
| `kernel:listRuns` | invoke | `{taskId}` | `KernelResult<Run[]>` |
| `kernel:getScheduler` | invoke | `{workspaceId}` | `KernelResult<SchedulerSnapshot>` |
| `app:event` | main→renderer | `KernelEventV2`（兼容 EventRecord 字段） | — |

```ts
export type KernelResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: KernelErrorCode; message: string; details?: unknown } };
```

- 错误码：`INVALID_TRANSITION | INVALID_DEPENDENCY | NOT_FOUND | CONFLICT | PAUSED | LIMIT_REACHED | IDEMPOTENT_REPLAY | INTERNAL`。
- `EventRecord` 对外保持兼容（新增字段可选），renderer `formatError` 继续工作；`KernelResult` 由 preload 透传，renderer helper `unwrap`。

### 9.3 事件与刷新

- 主进程：Store 事件 → `service.onEvent` → `win.webContents.send("app:event", event)`（现有链路）。
- renderer：收到事件后 220ms 防抖刷新 snapshot（现有机制），并本地即时更新关键状态（queued/running 计数、aria-live）。
- 事件量大时（tool.*）不做逐条 UI 渲染；任务详情 trace 仍按需拉取 `getTaskTrace`。

### 9.4 UI 契约（任务页 / 调度栏 / Run 历史 / review）

**任务列表**
- 状态过滤新增 `queued`（标签「排队中」），保留全部/进行中/等待依赖/待运行/评审中/已交付/失败/已取消。
- 行内显示：状态徽章、负责人、`attempt / max`（如 2/3）、优先级（可选）、排队时长（queued）。
- 空状态/错误沿用 C24/C26；无新增顶层入口。

**调度栏（任务面板头部，非新 tab）**
- 显示：`运行中 N / 排队 M`、暂停/恢复按钮、并发上限 tooltip、当前工作区暂停原因。
- 暂停/恢复按钮：`aria-pressed`/`aria-label`，操作后 toast + aria-live 播报「调度已暂停/恢复」。
- 队列可展开：列出 queued 任务（标题/优先级/等待时长/负责人），键盘可聚焦；不实现拖拽排序（优先级用详情下拉）。

**任务详情**
- Run 历史区：按 attempt 倒序列出 Run（attempt、状态、成员、开始/结束、耗时、tokens、errorCode、重试/取消按钮）；空态「还没有执行记录」。
- 操作：运行（queued 前）/取消/重试/调整优先级；review 状态显示「批准 / 拒绝（需备注）」。
- 执行 trace：沿用现有事件流；`runId` 过滤可选（P2）。
- 所有按钮：`aria-label`、disabled 原因通过 `title`；错误 `role=alert`；`aria-live` 播报状态变化（task.status_changed、scheduler.paused）。
- 键盘：Tab 可到达所有操作；Run 历史表语义（`table`/`role=table`，行可聚焦按钮）；无 hover-only 交互。
- reduced-motion：不新增动画；沿用现有 `prefers-reduced-motion` 规则。

**团队/星图**
- `queued` 状态色/标签加入 `copy.ts` 与 `StatusBadge`；星图节点 `queued` 用中性色 + 「排队」；进度条统计把 `queued` 计入「待运行」或单列（设计：单列「排队」段，避免与 ready 混淆）。
- 团队成员状态：Run 运行中 → running；无活跃 Run → idle；不因队列变化改变。

### 9.5 兼容性

- `deeplink` 不变（任务 id/选中不变）。
- Dock 布局不变；调度栏在 TasksView 内，不新增面板。
- 权限/审批：`waiting_human` 与 t58 审批链路一致；审批组件不变，Run 状态新增 waiting_human。
- Full Throttle：不感知内核状态；Run 启动时读取当前 FT/预算设置，行为不变。

---

## 10. 数据模型与迁移（v1 → v2）

### 10.1 新增/变更 DDL（摘要）

```sql
-- 版本（user_version 只在迁移全部成功后设置，见 §10.2；此处不得提前设置）
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kernel_commands (
  command_id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

-- 事件：新增列与幂等索引；旧事件 schema_version=1（新写入显式 2）
ALTER TABLE events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN idempotency_key TEXT;
ALTER TABLE events ADD COLUMN correlation_id TEXT;
ALTER TABLE events ADD COLUMN causation_id TEXT;
ALTER TABLE events ADD COLUMN occurred_at TEXT;      -- 迁移 UPDATE created_at
ALTER TABLE events ADD COLUMN recorded_at TEXT;      -- 迁移 UPDATE created_at
CREATE UNIQUE INDEX IF NOT EXISTS ux_events_idem
  ON events(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 任务投影扩展
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 50;
ALTER TABLE tasks ADD COLUMN queued_at TEXT;
ALTER TABLE tasks ADD COLUMN blocked_reason TEXT;
ALTER TABLE tasks ADD COLUMN failure_kind TEXT;
ALTER TABLE tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN next_run_at TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_ready ON tasks(workspace_id, status, next_run_at);

-- Run 扩展（attempt 唯一 + 活跃唯一 + 租约）
ALTER TABLE runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE runs ADD COLUMN model_profile_id TEXT;
ALTER TABLE runs ADD COLUMN model_id TEXT;
ALTER TABLE runs ADD COLUMN permission_snapshot TEXT;
ALTER TABLE runs ADD COLUMN sandbox_id TEXT;
ALTER TABLE runs ADD COLUMN retry_of_run_id TEXT;
ALTER TABLE runs ADD COLUMN heartbeat_at TEXT;
ALTER TABLE runs ADD COLUMN lease_owner TEXT;
ALTER TABLE runs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE runs ADD COLUMN checkpoint_ref TEXT;
ALTER TABLE runs ADD COLUMN checkpoint_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN error_code TEXT;
ALTER TABLE runs ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN steps INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_attempt ON runs(task_id, attempt);
CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_active
  ON runs(task_id) WHERE status IN ('queued','running','waiting_human');
CREATE INDEX IF NOT EXISTS idx_runs_heartbeat ON runs(status, heartbeat_at);

-- 调度状态
CREATE TABLE IF NOT EXISTS scheduler_state (
  workspace_id TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  updated_at TEXT NOT NULL
);
```

### 10.2 迁移步骤（v1 → v2）

> 实现在 `Store.migrate()`，在 Scheduler 启动前同步执行；**幂等**（以 `schema_migrations`/user_version 判定），失败则拒绝启动并保留备份。

1. **备份（WAL 安全）**：先 `PRAGMA wal_checkpoint(TRUNCATE)`，再用 SQLite backup API / `VACUUM INTO`（或同时复制 `deer.db` + `-wal`/`-shm`）生成 `deer.db.v1-<timestamp>.bak`；对备份执行 `PRAGMA integrity_check` 并尝试打开；记录大小与 SHA256。
2. **预检**：对原库 `PRAGMA integrity_check`；统计现有行数；若 `user_version >= 2` 直接返回。
3. **DDL/回填**：在单事务执行 §10.1 的 ALTER/CREATE；新列给默认值；`UPDATE events SET schema_version=1, occurred_at=created_at, recorded_at=created_at WHERE schema_version IS NULL OR occurred_at IS NULL`；旧行 `attempt_count = (SELECT COUNT(*) FROM runs WHERE task_id=t.id)`。事务内**不设置** user_version。
4. **基线事件**（迁移核心）：对每个 workspace/agent/task/run 写 `kernel.legacy_snapshot` 事件：
   - `aggregateType/Id` 对应实体；`payload = 投影当前值`（完整字段，JSON）；
   - 幂等键 `legacy:snapshot:{type}:{id}`；
   - 记录 `baseline_seq`（写入 `settings["kernel.baselineSeq"]`，按聚合存 map：`{"task":seq,...}`）；
   - 目的：不依赖旧事件的语义，就能从基线开始重建投影，避免为所有历史事件写 upcaster。
5. **状态归一**（同一事务）：
   - 依赖未全部 done 的 `ready` 任务 → `blocked(waiting_dependencies)`（写 `task.blocked`，reason）；
   - 依赖 failed/cancelled 的任务 → `blocked(dependency_failed|cancelled)`；
   - `running` 任务/`running` Run：保留，交由启动恢复 §8.4 处理（租约缺失 → failed/queued）；
   - Run `attempt`：按 `started_at, id` 给每个 task 的 runs 编号 1..N（`attempt_count` 同步）；
   - 旧 Run 无 heartbeat/lease：置 `lease_expires_at = 1970`（立即视为过期，由恢复处理）。
6. **旧事件保留**：不删除、不改写；`getTaskTrace` 仍可读；投影重建从基线开始（§4.6），旧事件仅审计/历史。
7. **重建校验**：在同一事务内 `rebuildProjections()`，与迁移前快照对比（tasks 状态计数、runs 计数/终态、活跃集合、attempt 最大值）；不一致则 ROLLBACK 并恢复备份，**不得留下半迁移库**。
8. **完成**：只有步骤 1–7 全部成功后才写 `kernel.migrated{from:1,to:2}`、`PRAGMA user_version=2`、`schema_migrations` 插入 2，然后 COMMIT；任何失败回滚事务/恢复备份，`user_version` 保持 1，应用拒绝启动并提示备份路径。

### 10.3 回滚

- 迁移前备份文件是唯一回滚依据；迁移事务失败自动 ROLLBACK；若事务已提交后才发现问题，用备份替换 DB（含 WAL checkpoint/关闭连接后恢复），并确保 `user_version` 回到 1；不得只删新列而保留半迁移数据。
- feature flag `kernel.v2`：迁移后默认启用；若关闭，旧代码路径不得与 v2 事件混写（v1 代码只读旧表；本设计不实现双写）。`user_version=2` 只在迁移成功提交后出现，禁止在 DDL 中提前写入。

### 10.4 重建时的事件边界

- `baselineSeq` 之前的事件：不参与投影重建（历史遗留语义不一致）；
- `baselineSeq` 之后的 v2 事件：按 seq 重放；
- 若用户手工删除基线事件：重建报错并提示从备份恢复（防止静默错乱）。

### 10.5 旧事件名 upcaster（只用于 trace/审计展示）

| 旧事件 | 映射 |
|---|---|
| `task.created` | 保持 |
| `task.ready/task.running/task.done/task.failed/task.blocked/task.review/task.cancelled` | `task.status_changed{from: unknown, to: <状态>}`（展示时 from 取前一条事件状态） |
| `run.started`（aggregate task） | `run.started`（aggregate run，id 从 payload.runId 取） |
| `run.completed` / `run.failed` | 同上 |
| `agent.permission_changed` / `agent.model_changed` / `session.full_throttle_changed` | 保持（非任务状态） |

- 旧事件不做物理改写；`rebuild` 跳过它们（基线之后才是权威）。
- 新代码只发 v2 事件；`Store.updateTask` 的旧「直接更新 + 动态事件」路径在 t68 删除/改为 kernel 命令。

---

## 11. 验收（AC）

> 每条 AC 必须可在 t68/t69 的测试/手工清单中复现；测试文件建议见 §12.2。`AC` 编号用于评审/集成映射。

### 11.1 事件与投影（t68）

| AC | 内容 | 验证 |
|---|---|---|
| AC-EV-01 | 所有写入事件通过注册表校验；未知类型拒绝写 | 单测：invalid type append 抛错 |
| AC-EV-02 | `seq` 严格递增，读取按 seq 排序 | 并发 append 测试 |
| AC-EV-03 | 相同 `idempotencyKey` 只产生一个事件，重复 append 返回原事件 | 单测 |
| AC-EV-04 | 命令重复执行（相同 commandId）返回首次结果，不重复执行 | 命令层测试 |
| AC-EV-05 | 事务内事件+投影原子提交；注入故障（throw）后二者都不落库 | 故障注入测试 |
| AC-EV-06 | 监听器仅在提交后收到事件 | 单测 |
| AC-EV-07 | schemaVersion 旧事件经 upcaster 投影正确；v1 fixture 的旧事件保持 schema_version=1 | 单测（fixture） |
| AC-EV-08 | 事件保留 correlation/causation，可追一命令多事件链路 | 集成测试 |
| AC-EV-09 | 迁移后旧事件 `schema_version=1`、`occurred_at/recorded_at=created_at`；新事件显式 schemaVersion=2 | 迁移测试 + upcaster 测试 |

### 11.2 Task 状态机（t68）

| AC | 内容 | 验证 |
|---|---|---|
| AC-SM-01 | 表驱动覆盖全部 8×8 状态组合，仅迁移表内允许 | 矩阵测试 |
| AC-SM-02 | 非法迁移抛 `INVALID_TRANSITION`，投影不变、无状态事件 | 单测 |
| AC-SM-03 | 创建时依赖未满足 → blocked(waiting_dependencies)；全部 done → ready | 单测 |
| AC-SM-04 | 依赖失败/取消 → 下游 blocked(对应 reason)，不自动 failed；blocked(waiting_dependencies)→blocked(dependency_*) 走 T22 仅改原因 | 单测（T22 + 原因） |
| AC-SM-05 | 依赖重试成功 → 下游自动 ready（blocked→ready）；T3 守卫只依赖全 done | 单测 |
| AC-SM-13 | T20 ready→blocked(manual)、T21 queued→blocked(waiting_dependencies)、T22 原因更新均按表写事件/幂等键，且不改活跃 Run | 表驱动单测 |
| AC-SM-06 | 创建时依赖成环/不存在 → `INVALID_DEPENDENCY` | 单测 |
| AC-SM-07 | `running` 不可编辑 dependsOn（DEPENDENCY_LOCKED） | 单测 |
| AC-SM-08 | 取消 ready/queued/running/review/blocked 全部路径正确；running 先 abort Run | 单测 |
| AC-SM-09 | 重复取消幂等；取消 done/failed 的语义符合表 | 单测 |
| AC-SM-10 | reviewPolicy=required：running→review→done/reject→failed | 单测 |
| AC-SM-11 | reviewPolicy=auto：running→done，无 review 事件 | 单测 |
| AC-SM-12 | 状态与 Run 不变量（INV-2/3）在随机事件序列后成立 | 属性测试 |

### 11.3 Run 生命周期（t68）

| AC | 内容 | 验证 |
|---|---|---|
| AC-RL-01 | Run attempt 从 1 递增，`(task,attempt)` 唯一；重试新建 Run、不复用 | 单测 |
| AC-RL-02 | 同一 Task 最多一个活跃 Run（DB 部分唯一索引拦截） | 单测 |
| AC-RL-03 | Run 启动写 started；结束写终态 + endedAt + token；不静默消失 | 单测 |
| AC-RL-04 | 心跳 15s 更新 heartbeatAt 并续租；run.heartbeat 节流 30s | 假时钟测试 |
| AC-RL-05 | 心跳/checkpoint/resume/终态全部使用 lease CAS；旧 owner 心跳/checkpoint/终态写入被拒并写 `run.result_discarded`；租约 60s 过期后结果被 fencing | 单测（假时钟） |
| AC-RL-06 | checkpoint 每 step 落盘并写 run.checkpoint；失败不阻断执行 | 单测 |
| AC-RL-07 | waiting_human 与 t58 审批一致：批准→resumed、超时/拒绝→failed；审批等待 >60s 期间由 lease keeper 续租、不被 Recovery 回收 | 集成测试（假时钟 >60s） |
| AC-RL-08 | Run 终态事件 payload 含 errorCode/retryable/token，UI 可据此展示 | 单测 |
| AC-RL-09 | 旧 owner 的 heartbeat/checkpoint 不延长租约、不覆盖新 Run；CAS 失败后执行器 abort | 单测（双 owner 模拟） |

### 11.4 调度器（t69）

| AC | 内容 | 验证 |
|---|---|---|
| AC-SC-01 | ready 集合正确（依赖全 done、无活跃 Run、nextRunAt 到期） | 单测 |
| AC-SC-02 | 全局并发 4 / 工作区 1 / 成员 1 生效；超限不启动；两个不同成员同时写同一文件时不得并发（工作区锁/串行） | 并发测试（mock executor + 文件写） |
| AC-SC-03 | 优先级 + FIFO 排序；老化 5min +1 优先级 | 单测 |
| AC-SC-04 | 每成员轮转，不连续抢占同一成员 | 单测 |
| AC-SC-05 | 暂停阻止新启动、运行中继续；恢复后继续调度 | 单测 |
| AC-SC-06 | 取消 queued 不创建 Run；取消 running abort + cancelled | 单测 |
| AC-SC-07 | 双击/重入 startTask 不产生双 Run（CAS/幂等） | 并发测试 |
| AC-SC-08 | 调度 tick 单飞、不重入；事件唤醒合并 | 单测 |
| AC-SC-09 | beforeStart hook 拒绝/超时 → 任务留 queued + scheduler.rejected；hook 延迟期间容量被占满或暂停 → 不启动 | 单测（可控延迟） |
| AC-SC-10 | 成员/工作区/全局计数从投影实时计算，重启后一致 | 集成测试 |
| AC-SC-11 | 默认 autoAdmit=false：ready 任务不会自动入队；startTask 才 ready→queued；暂停期间可入队但不出队 | 单测 |
| AC-SC-12 | autoAdmit=true 时创建/解阻/重试后自动走 T5；与暂停/取消交互符合 §7.1 | 单测 |

### 11.5 失败与恢复（t69，部分 t68）

| AC | 内容 | 验证 |
|---|---|---|
| AC-RC-01 | 可重试错误自动重试，attempt 递增、退避时间符合公式；maxAttempts=3 为总尝试（首跑 + 2 次重试） | 假时钟测试 |
| AC-RC-02 | 第三次 attempt 失败 → failed(retry_exhausted)；人工 retry 可再入队（总尝试上限 10） | 单测 |
| AC-RC-03 | 不可重试错误 → 直接 failed | 单测 |
| AC-RC-04 | 崩溃残留 running Run + 过期租约 → 启动恢复为 failed(LEASE_EXPIRED) + 任务 queued/failed | 恢复测试 |
| AC-RC-05 | 孤儿 Run（task 不存在/终态）→ cancelled(ORPHANED) | 恢复测试 |
| AC-RC-06 | 重复活跃 Run → 保留最新，其余 cancelled(DUPLICATE_ACTIVE) | 恢复测试 |
| AC-RC-07 | 恢复幂等：连续两次 recover 状态一致、无重复事件 | 恢复测试 |
| AC-RC-08 | 事件重建后与恢复后的投影一致（digest） | 属性/恢复测试 |
| AC-RC-09 | Run 超时（30min）→ failed(RUN_TIMEOUT, retryable) | 假时钟测试 |
| AC-RC-10 | blocked 下游在上游 retry 成功后自动 ready | 单测 |

### 11.6 迁移（t68）

| AC | 内容 | 验证 |
|---|---|---|
| AC-MG-01 | v1 fixture（含 tasks/runs/events/agents）迁移成功，备份存在 | 迁移测试 |
| AC-MG-02 | 迁移后任务状态归一（依赖未满足→blocked；running→待恢复） | 迁移测试 |
| AC-MG-03 | 旧事件保留可读；基线事件存在、幂等键唯一 | 迁移测试 |
| AC-MG-04 | 迁移后重建投影 = 迁移前快照（允许归一化差异清单） | 迁移测试 |
| AC-MG-05 | 重复迁移幂等（user_version=2 直接跳过） | 迁移测试 |
| AC-MG-06 | 迁移失败/重建失败：事务回滚或从备份恢复，DB 不会半改；重启后 `user_version` 仍为 1，应用拒绝启动并提示备份 | 迁移测试（故障注入/重启） |
| AC-MG-07 | WAL 安全备份：迁移前 checkpoint/backup API 生成的备份可 integrity_check 并可打开；失败可恢复 | 迁移测试（含 WAL 未 checkpoint 场景） |
| AC-MG-08 | 迁移后旧事件 `schema_version=1`、时间戳回填；新事件 schemaVersion=2（与 AC-EV-09 联动） | 迁移测试 |

### 11.7 API / UI（t69）

| AC | 内容 | 验证 |
|---|---|---|
| AC-API-01 | 所有 kernel 命令走 `KernelResult`，错误码稳定 | 单测 |
| AC-API-02 | 命令幂等（同一 commandId 重复）返回首次结果；多事件命令（startTask 等）不因事件级 idempotencyKey 唯一索引冲突；失败命令返回原失败 | 单测（多事件/成功/失败） |
| AC-API-03 | preload/main IPC 类型与 ipc.ts 一致，无未声明通道 | 类型检查/集成 |
| AC-API-04 | Snapshot 含 scheduler/runs，事件刷新后一致 | 集成测试 |
| AC-API-05 | 暂停/恢复/取消/重试/优先级命令端到端可用 | 集成测试 |
| AC-API-06 | `runTask` 兼容路径不绕过 kernel | 集成测试 |
| AC-API-07 | `kernel_commands` 与事件+投影同事务；重复/失败命令不重复写事件 | 单测 |
| AC-UI-01 | 任务列表显示 queued + `attempt/max`（maxAttempts=3，如 2/3）；过滤含全部 8 态 | 手工/组件测试 |
| AC-UI-02 | Run 历史展示 attempt/状态/耗时/tokens/错误/操作 | 手工 |
| AC-UI-03 | 调度栏显示运行/排队、可暂停/恢复，aria-live 播报 | 手工/可访问性检查 |
| AC-UI-04 | review 批准/拒绝可用，键盘可达，错误 role=alert | 手工 |
| AC-UI-05 | 键盘 Tab 可完成运行/取消/重试/暂停；无 hover-only | 手工 |
| AC-UI-06 | reduced-motion 无新增动画；窄窗不溢出 | 手工 |

### 11.8 端到端（t69）

| AC | 内容 | 验证 |
|---|---|---|
| AC-E2E-01 | mock 模型：3 任务 DAG（A→B→C）从 queued 依次运行到 done；顺序/依赖正确 | `kernel.e2e.test.ts` |
| AC-E2E-02 | 并发 2：两个不同工作区各 1 个无依赖任务并行启动；同工作区默认仍串行（工作区 1） | `kernel.e2e.test.ts` |
| AC-E2E-03 | 失败重试：mock 首次失败→第二次成功，attempt=2、事件完整 | 同上 |
| AC-E2E-04 | 崩溃恢复端到端：运行中重启服务→恢复后任务重排并完成 | 同上 |
| AC-E2E-05 | 取消端到端：running 取消→Run cancelled、Task cancelled、下游 blocked | 同上 |

### 11.9 测试实现建议

- **表驱动**：`taskState.test.ts` 生成 8×8 矩阵（合法/非法），断言结果与事件。
- **属性测试**：不新增依赖，用确定性 PRNG（seed 固定）生成 N 组随机合法命令序列，跑 kernel 后：①状态/不变量；②重建 = 投影；③重复 IdempotencyKey 不重复。若 t68 允许新增 `fast-check` devDependency，可用其 `fc.assert`（实现时决定，不改变设计）。
- **并发**：mock executor 用可控 Promise/假时钟；`maxGlobal=2` 下启动 5 个任务，断言活跃 ≤2；`pause` 后不再启动。
- **迁移**：fixture 用 SQL 直接构造 v1 schema 数据（或保存一份 v1 fixture DB 二进制到 `test/fixtures/`）。
- **端到端**：复用现有 mock 模型（`settings.mock=true`）与 service 测试基建；不依赖网络。

---

## 12. 分阶段实施与文件级影响面

### 12.1 阶段

| 阶段 | 内容 | 验收 | 估算 |
|---|---|---|---|
| **K0 事件内核** | EventV2 注册表/校验、append 幂等、事务封装、投影应用器、rebuild、迁移 v1→v2、基线事件、迁移/投影测试 | AC-EV-01..09、AC-MG-01..08 | 3–4 人日 |
| **K1 状态与 Run** | 8 态状态机、依赖/失败传播、取消、Run 模型/attempt/租约/心跳/checkpoint、恢复核心、命令门面 | AC-SM-01..13、AC-RL-01..09、AC-RC-04..08 | 3 人日 |
| **K2 调度器** | ready set、并发/公平/优先级/轮转、暂停/恢复、取消、tick 单飞、hooks | AC-SC-01..12 | 2–3 人日 |
| **K3 重试/恢复完善** | 错误分类、退避、重试耗尽、超时、恢复归一、fencing | AC-RC-01..03、09–10 | 1–2 人日 |
| **K4 API/IPC/UI** | 命令/查询、preload/main、Snapshot 扩展、任务页调度栏/Run 历史/review、copy/status、aria | AC-API-01..07、AC-UI-01..06 | 2–3 人日 |
| **K5 端到端/硬化** | mock E2E、性能/压力、文档、迁移演练 | AC-E2E-01..05 | 1–2 人日 |
| **合计** | 完整实现（非 MVP） | — | **12–17 人日（L）** |

### 12.2 建议任务拆分（t68 / t69）

**t68：执行内核基础（事件 / 状态机 / Run / 恢复核心）**
- 范围：K0 + K1；不含调度器循环、IPC/UI（保留现有手动 `runTask` 兼容路径，经 kernel 命令执行）；不含重试/退避（K3 随 t69）。
- 交付：EventV2、迁移、投影重建、8 态状态机、Run/attempt/lease/heartbeat/checkpoint、启动恢复（租约/孤儿）、单测/属性/迁移测试。
- 通过标准：AC-EV-01..09、AC-SM-01..13、AC-RL-01..09（租约/心跳/checkpoint）、AC-MG-01..08、AC-RC-04..08（核心恢复）；typecheck/build/test 全绿。
- 文件面：新增 `eventRegistry`/`eventStore`/`projections`/`taskState`/`runLifecycle`/`lease`/`checkpoint`/`recovery`/`kernel`/`errors`；改 `store.ts`、`service.ts`（runTask 委托）、`loop.ts`（heartbeat/checkpoint 回调）、`types.ts`；测试新增 6 个文件、更新 service 测试。

**t69：调度器 + 重试 + API/UI（依赖 t68）**
- 范围：K2 + K3 + K4 + K5；调度器、公平/并发/暂停/取消/优先级、错误分类/退避、IPC/preload、Snapshot、任务页调度栏/Run 历史/review、copy/status/星图 queued、mock E2E、文档。
- 通过标准：AC-SC-01..12、AC-RC-01..03/09–10、AC-API-01..07、AC-UI-01..06、AC-E2E-01..05；typecheck/build/test 全绿；人工冒烟清单（键盘/aria/窄窗）通过。
- 文件面：新增 `scheduler`/`hooks`；改 `service.ts`（快照/命令）、`shared/ipc.ts`、`electron/main.ts`、`electron/preload.ts`、`App.tsx`、`styles.css`、`shared/copy.ts`、`StatusBadge`/`TeamDashboard`/`TaskStarMap`（queued 显示）、现有测试。

> 拆分原则：t68 完成后内核可独立验证（无调度 UI 也能通过 mock 直接命令执行）；t69 只在其上加调度与界面，避免一个 PR 同时改事件模型和执行循环。两者均需独立评审 → 集成（t67 只做设计，不自我评审）。

### 12.3 文件级影响面

| 文件 | 动作 | 内容 | 任务 |
|---|---|---|---|
| `src/kernel/eventRegistry.ts` | 新增 | 事件类型枚举、payload schema（zod）、upcaster 表 | t68 |
| `src/kernel/eventStore.ts` | 新增 | append/幂等/list/replay、事务包装、监听器 after-commit | t68 |
| `src/kernel/projections.ts` | 新增 | tasks/runs/scheduler/agent 投影应用 + rebuild + digest | t68 |
| `src/kernel/taskState.ts` | 新增 | 8 态迁移表、guard、错误码 | t68 |
| `src/kernel/runLifecycle.ts` | 新增 | Run 创建/attempt/终态/fencing | t68 |
| `src/kernel/lease.ts` | 新增 | owner/expiry/续租/过期检测 | t68 |
| `src/kernel/checkpoint.ts` | 新增 | checkpoint 文件读写 | t68 |
| `src/kernel/recovery.ts` | 新增 | 启动恢复/孤儿/租约回收/归一 | t68 |
| `src/kernel/kernel.ts` | 新增 | 命令/查询门面、commandMutex、`kernel_commands` 幂等 | t68 |
| `src/kernel/errors.ts` | 新增 | KernelError/错误码 | t68 |
| `src/kernel/scheduler.ts` | 新增 | tick/ready/并发/公平/暂停/优先级 | t69 |
| `src/kernel/hooks.ts` | 新增 | KernelHooks 接口与默认实现 | t69 |
| `src/kernel/store.ts` | 改 | v2 schema/迁移、事务、append 委托、移除直接状态事件 | t68 |
| `src/kernel/service.ts` | 改 | 委托 kernel；快照扩展；cancel/pause/retry 命令；runTask 兼容 | t68/t69 |
| `src/kernel/loop.ts` | 改 | heartbeat/checkpoint 回调；超时检查 | t68 |
| `src/kernel/tools.ts` | 改 | `task.complete` → kernel 完成命令；权限行为不变 | t68 |
| `src/shared/types.ts` | 改 | TaskStatus + queued、Task/Run v2、SchedulerSnapshot、KernelResult | t68/t69 |
| `src/shared/ipc.ts` | 改 | kernel 命令/查询通道 | t69 |
| `src/shared/copy.ts` | 改 | queued 标签（排队中） | t69 |
| `electron/main.ts` / `preload.ts` | 改 | IPC handlers + preload API | t69 |
| `src/App.tsx` | 改 | 任务页调度栏/Run 历史/review/过滤/aria-live | t69 |
| `src/styles.css` | 改 | 调度栏/Run 表/queued 状态样式 | t69 |
| `src/TeamDashboard.tsx` / `TaskStarMap.tsx` / `StatusBadge.tsx` | 改 | queued 显示与统计 | t69 |
| `src/kernel/*.test.ts` | 新增/改 | 上述 AC 对应测试；现有 service/permission/approval 测试适配 | t68/t69 |
| `docs/team/execution-kernel-implementation.md` | 新增 | 实现映射/验证/偏差 | t68/t69 |

### 12.4 迁移与上线顺序

1. t68 合并：事件/迁移内核先上线，旧 UI 行为保持（runTask 兼容），迁移在首次启动执行；备份 + user_version 门禁。
2. t69 合并：调度器/UI 上线；`kernel.v2` 默认开启；发布说明记录「首次启动会迁移 DB，需备份」。
3. 若 t68 后需回滚：恢复备份 DB（v1），代码回退；不保留 v2 事件（避免混写）。
4. 监控：`kernel.recovered` 事件数、失败率、排队时长、活跃 Run 不变量告警。

---

## 13. 风险与缓解

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 事件/投影迁移出错 | 数据丢失/状态错乱 | 迁移前备份 + 事务 + 归一清单 + 重建 digest + 迁移测试；失败拒绝启动 |
| R2 | 投影与事件发散 | 状态不一致，UI 与执行错位 | 单事务、重建校验、dev 自检、属性测试；`kernel.rebuild` 诊断命令 |
| R3 | 调度并发竞态（双 Run） | 重复执行/双倍成本 | commandMutex + CAS + 部分唯一索引 + 幂等键 + lease fencing |
| R4 | SQLite 同步写阻塞主进程 | UI 卡顿 | 命令事务尽量小（不 await/不做 IO）；fs checkpoint 异步写；压测 tick 耗时 <5ms；必要时 WAL checkpoint 调优 |
| R5 | 崩溃恢复误判（租约时钟） | 任务被重排/中断 | 租约 60s ≫ 心跳 15s；fencing 丢弃旧结果；恢复幂等；可配置 |
| R6 | 重试风暴/成本 | 预算与噪声 | 指数退避 + jitter + maxAttempts；预算 hook fail-closed；看门狗后续 |
| R7 | 迁移后旧事件语义差异 | trace 误读 | 保留旧事件只读；upcaster 仅展示；基线事件作为重建起点；文档标注 |
| R8 | UI/无障碍回归 | 原有任务页功能坏 | 只扩展不重排；AC-UI 手工清单；aria-live/role；键盘遍历 |
| R9 | 影响 t58 审批（waiting_human） | 审批链路断裂 | Run waiting_human 与审批组件对接测试；审批超时→failed 映射；权限门禁不变 |
| R10 | 与 Dock/星图/状态文案不一致 | queued 显示缺失 | copy.ts 单源 + StatusBadge/星图/进度条同步；AC-UI-01 |
| R11 | 多窗口/多实例误用 | 双调度器 | v1 单实例；lease owner 不同时恢复回收；文档/启动检查（可选） |
| R12 | 测试不稳定（假时钟/并发） | CI 抖动 | Clock 注入；确定性 seeded jitter；避免真实定时器；E2E 用 mock |
| R13 | 范围膨胀（做进 Git/看门狗） | 交付延期 | §1.2 非目标 + t68/t69 边界；hook 只留接口 |
| R14 | 事件表膨胀 | DB 体积/查询慢 | 先监控；>100k 事件再评估归档（非目标）；索引按 aggregate/状态 |

---

## 14. 待拍板决策（Q）

| ID | 问题 | 建议 | 影响 |
|---|---|---|---|
| Q1 | 并发默认值（全局 4 / 工作区 1 / 成员 1）是否合适？ | **Git/worktree 隔离前：全局 4 / 工作区 1 / 成员 1**；>1 前必须加工作区写租约/文件锁；Git 落地后再评估工作区 2 | 吞吐与写冲突 |
| Q2 | `reviewPolicy` 默认 `auto` 还是 `required`？ | `auto`（保持单用户现有体验），团队模式再开 `required` | 完成语义/UI |
| Q3 | 自动重试默认几次、退避 5s×2ⁿ 是否合适？ | **maxAttempts=3 表示总尝试（首跑 + 2 次重试）**；退避 5s/10s、上限 5min；可配置 | 成本/恢复 |
| Q4 | `queued` 是否对用户可见（任务列表/星图/进度条）？ | 可见，单列排队 | UI 复杂度 |
| Q5 | 调度栏放任务页头部即可，还是独立 Dock 面板？ | 任务页头部（不新增入口）；后续可拖为面板 | UI 范围 |
| Q6 | `runTask` 兼容别名保留多久？ | t69 发布后一个版本；之后移除；明确等待超时/取消语义 | API 兼容 |
| Q7 | checkpoint 同模型恢复是否在 t69 后立刻做？ | 先只落盘/交接，恢复列 P2 | 实现量 |
| Q8 | 事件归档/TTL 是否本阶段做？ | 不做；先监控体积 | 存储 |
| Q9 | `review` 是否允许 Agent 审批？ | v1 仅 user；团队模式再开 | 权限产品语义 |
| Q10 | 迁移失败时的用户可见流程（拒绝启动 + 备份提示）？ | 是；设置页显示迁移状态/备份路径；WAL 安全备份 + `user_version` 保持 1 | 运维 |
| Q11 | 新任务是否自动入队（ready→queued）？ | **默认手动**（`kernel.autoAdmit=false`，保留「运行任务」）；团队模式可显式开自动 | 调度体验/成本 |

---

## 附录 A：事件目录速查（v2 写入）

```
workspace.created
agent.created | agent.updated | agent.permission_changed | agent.status_changed
task.created | task.updated | task.status_changed | task.blocked | task.unblocked
task.review_requested | task.review_approved | task.review_rejected
task.retry_scheduled | task.retry_exhausted | task.cancelled
run.started | run.heartbeat | run.checkpoint | run.waiting_human | run.resumed
run.completed | run.failed | run.cancelled
scheduler.paused | scheduler.resumed | scheduler.admitted | scheduler.rejected | scheduler.tick
kernel.legacy_snapshot | kernel.migrated | kernel.recovered | kernel.rebuild | kernel.command_rejected
message.sent（既有） | board.posted（既有） | memo.created（既有） | review.*（后续）
```

## 附录 B：Task 状态迁移矩阵（行=from，列=to；✅=允许）

| from\to | ready | queued | running | review | blocked | done | failed | cancelled |
|---|---|---|---|---|---|---|---|---|
| ready | — | ✅（T5） | ❌ | ❌ | ✅（manual） | ❌ | ❌ | ✅（T18） |
| queued | ✅（T6） | — | ✅（T7） | ❌ | ✅（依赖失效） | ❌ | ❌ | ✅（T18） |
| running | ❌ | ✅（T11 重试） | — | ✅（T8） | ❌ | ✅（T9） | ✅（T10） | ✅（T12） |
| review | ❌ | ❌ | ❌ | — | ❌ | ✅（T13） | ✅（T14） | ✅（T15） |
| blocked | ✅（T3/T4） | ❌ | ❌ | ❌ | — | ❌ | ❌ | ✅（T18） |
| done | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ | ❌ |
| failed | ❌ | ✅（T16） | ❌ | ❌ | ❌ | ❌ | — | ✅（T17） |
| cancelled | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — |

> `ready → blocked(manual)`（T20）、`queued → blocked(等待依赖)`（T21）与 `blocked(reasonA) → blocked(reasonB)`（T22，仅原因更新）已纳入迁移表；其余未列出组合一律 `INVALID_TRANSITION`。

## 附录 C：KernelError 码表

```
INVALID_TRANSITION     状态迁移不在表内
INVALID_DEPENDENCY     依赖不存在/跨工作区/成环
DEPENDENCY_LOCKED      running/终态任务禁止修改 dependsOn
NOT_FOUND              task/run/workspace 不存在
CONFLICT               CAS 失败/并发修改/已存在活跃 Run
PAUSED                 调度已暂停（startTask 仍可入队，此码用于拒绝直接启动）
LIMIT_REACHED          并发/成员/工作区限制（内部调度，不抛给 UI）
IDEMPOTENT_REPLAY      重复 commandId（返回首次结果，不是错误路径）
NO_AVAILABLE_AGENT     无可用成员（start 失败或留队）
HOOK_REJECTED          预算/看门狗/评测 hook 拒绝
INTERNAL               未分类
```

## 附录 D：迁移检查清单（实现时逐项勾）

- [ ] 备份 DB（先 WAL checkpoint / backup API，含 SHA256/大小，校验可打开）
- [ ] `PRAGMA integrity_check` 通过
- [ ] v2 DDL 全部幂等执行；**不提前设置 user_version**
- [ ] 旧事件 schema_version=1、occurred_at/recorded_at 回填 created_at
- [ ] 每实体基线事件（幂等键唯一）
- [ ] baselineSeq 写入 settings
- [ ] 任务状态归一（blocked/queue/attempt）
- [ ] 旧 Run attempt 编号
- [ ] 重建 digest = 迁移前快照（差异清单已审阅）
- [ ] 旧事件保留可读；新事件 v2
- [ ] `kernel.migrated` + **全部成功后才** user_version=2
- [ ] 迁移失败自动回滚/恢复备份、应用拒绝启动并提示备份；user_version 保持 1
- [ ] 重复启动幂等跳过
- [ ] 迁移测试 fixture 覆盖空库/单任务/多任务/脏状态

## 附录 E：当前代码锚点（设计对照，非改动）

- 事件/投影：`src/kernel/store.ts:36–176`（SCHEMA）、`:336–446`（Store/appendEvent/listEvents）、`:610–713`（createTask/updateTask）、`:717–785`（createRun/updateRun）
- 执行：`src/kernel/service.ts:149–150`（runningTasks/aborts）、`:760–938`（runTask 全链路）、`:357–368`（Snapshot）
- Loop：`src/kernel/loop.ts:37–147`
- 类型：`src/shared/types.ts:60–109`
- IPC：`src/shared/ipc.ts:23–50`
- UI：`src/App.tsx:613–617`（runTask）、`:1541–1548`（过滤）、`:1868–1918`（运行按钮/trace）
- 状态文案：`src/shared/copy.ts:8–16`
- 权限/审批：`src/kernel/permission.ts`、`src/kernel/tools.ts`、`docs/team/chat-controls-implementation.md`（t58）
- 现有测试：`src/kernel/{permission,approval,approval-wiring,service,model,openai}.test.ts`、`src/shared/{models,deeplink}.test.ts`、`src/{TaskStarMap,Markdown}.test.tsx`

---

## 15. t76 修订记录（2026-11-10）

> 本记录对应 t75 requirements 审查的 9 条 findings；本文件已按下列方式修订。t76 复审通过后 t68/t69 才启动。

| 编号 | t75 finding | 本文件修订 |
|---|---|---|
| F1 | 并发写隔离 | §0/§7.2 默认改为 **global 4 / workspace 1 / member 1**；工作区并发 >1 前必须加写租约/worktree；新增 AC-SC-02 跨成员同文件断言；Q1 裁决 |
| F2 | lease/fencing + waiting_human | §6.3/§6.4/§6.6 改为所有 lifecycle 写 CAS `lease_owner+status`；新增独立 lease keeper 续租 waiting_human；新增 AC-RL-05/07/09 假时钟用例 |
| F3 | 迁移原子性/版本/WAL 备份 | §10.1 删除提前 `user_version=2`；§10.2 改为 WAL checkpoint/backup API + 全部成功后才置版本；§10.3 回滚说明；AC-MG-06/07/08 |
| F4 | 旧事件 schemaVersion/时间 | §10.1 默认 schema_version=1；§10.2 回填 occurred_at/recorded_at；AC-EV-07/09、AC-MG-08 |
| F5 | 状态迁移表矛盾 | §5.2 新增 T20/T21/T22，修正 T19；§5.3 原因更新；同步附录 B 与 AC-SM-04/05/13 |
| F6 | 命令多事件幂等 | §4.4 改为 `kernel_commands` 命令记录表 + 派生事件 key `cmd:{id}:{n}`/correlationId；§10.1 新表；AC-API-02/07 |
| F7 | 自动入队策略 | §0/§7.1 新增 Q11：默认手动（autoAdmit=false），自动策略走同一 T5；AC-SC-11/12 |
| F8 | maxAttempts 语义 | §0/§8.2/Q3 明确 maxAttempts=3 = 总尝试（首跑+2 重试）；AC-UI-01 显示 2/3；AC-RC 同步 |
| F9 | beforeStart 容量复核 | §7.7 要求 hook 返回后同事务重查三项上限并 CAS；AC-SC-09 增加容量被占/暂停用例 |

**Q1–Q11 裁决（本文件生效）**：Q1 4/1/1（Git 隔离前）；Q2 auto；Q3 总尝试 3；Q4 queued 可见；Q5 任务页头部调度栏；Q6 runTask 兼容一版；Q7 checkpoint 先落盘/恢复 P2；Q8 不归档；Q9 仅 user review；Q10 失败拒绝启动+备份/迁移状态；Q11 默认手动入队（autoAdmit=false）。

---

> **审查提示**：本设计覆盖 DESIGN §5.2、§5.3、§7.2、§7.4 及任务书要求。实现前请先确认 §14 的 Q1–Q11 裁决；requirements 复审通过后 t68/t69 才启动。

---

## 16. G3 Git 集成契约增补（t79，对应 t77 F1）

> 本增补只约束「Git 并行开发（t73）的 G3 集成」，**不改变 §1–§15 的内核核心语义**。t68/t69 实现时必须吸收以下接口；未吸收前 Git G3 **不得开启隔离并发**。来源：t77 审查 F1（内核 defer/prepare 契约缺失）。

### 16.1 原则

- **并发默认不变**：仍为 §7.2 的 global 4 / **workspace 1** / member 1；只有 G3 落地且所有活跃 Run 都有隔离 worktree（`sandboxId=git:*`）+ 租约/写锁后，才允许评估 workspace 2。
- **准入失败不是任务失败**：Git 容量不足返回 defer；任务保持 `queued`、`nextRunAt` 重试，**不增 attempt、不创建 Run、绝不写 failed**。兼容包装也不得把 `GIT_CAPACITY` 抛成任务终态失败。
- **Git 不碰内核表**：Git 自有 `task_vcs/run_vcs/...` 与 `git_schema`；内核只调用接口，不读 Git 表。
- **Task/Run 终态仍由内核独占**；Git commit/push/PR 失败只写 `task_vcs.error`，不改 Run/Task 状态。

### 16.2 接口增补

```ts
export type BeforeStartResult =
  | { allow: true }
  | { allow: false; reason: string }                 // 本次跳过，任务保持 queued
  | { allow: false; defer: true; retryAfterMs: number; reason: "GIT_CAPACITY" }; // 延迟排队

export interface RunEnvironmentProvider {
  prepare(input: {
    workspaceId: string; taskId: string; runId: string; attempt: number; agentId: string;
  }): Promise<
    | { ok: true; cwd: string; branch: string | null; sandboxId: string; mode: "git"|"degraded" }
    | { ok: false; defer: true; retryAfterMs: number; reason: string }
    | { ok: false; defer: false; errorCode: string; message: string }
  >;
  release(input: { runId: string; status: "completed"|"failed"|"cancelled" }): Promise<void>;
}
```

- `KernelHooks.beforeStart` 返回类型扩展为 `BeforeStartResult`（原 `{allow,reason}` 是其子集）。
- **准入**：调度选中任务后调用 `beforeStart`；返回 `defer` → `Task.queued`、`nextRunAt=now+retryAfterMs`、写 `scheduler.deferred`；返回 `allow:false`（无 defer）→ 本次跳过、写 `scheduler.rejected`，任务仍 queued，不 failed。
- **准备**：准入通过后，内核生成临时 `runId`（UUID，尚未落 Run 行），在 **50ms hook 之外、Run 创建/启动前** 调 `RunEnvironmentProvider.prepare`；成功 → 创建 Run、`toolContext.worktreePath=cwd`、`RunV2.sandboxId=sandboxId`；`defer` → 回 queued（同上）；`ok:false,defer:false` → 若允许 degraded 则用 `workspace.path`（并发 1）继续，否则 `scheduler.rejected`/queued 等修复，**不 failed**。
- **结束**：Run 终态事务后调用 `release`；`release` 只向 Git outbox 入队 finalize（DB 插入，<5ms），不等待网络；不改变 Run 状态。
- **G3 验收**：`RunV2.sandboxId="git:<cwd>"`（degraded 为 `workspace:<id>`）；`AC-KRN-01/02/03/04/05/06/07` 由 Git 设计 §10 验收；t68 需新增单测覆盖 `beforeStart` defer/deny 与 prepare 失败路径（不得 failed）。

### 16.3 并发门禁

- 任一活跃 Run 为非隔离（degraded/off，`sandboxId` 不以 `git:` 开头）时，该工作区**强制并发 1**；第二个 Run 的准入返回 defer。
- 仅当所有活跃 Run 都有 `git:*` sandbox、Git worktree 租约/写锁就绪时，才允许把 `kernel.maxWorkspaceRuns` 升到 2（默认仍 1，需显式配置+租约断言）。
- G3 之前，t68 的并发保持 §7.2 的 1，不得提前开放。

### 16.4 迁移/兼容

- kernel v2 迁移不变（`user_version` 仍由内核管理）；Git 表独立 `git_schema`，**不读写 `user_version`**。
- `RunV2.sandboxId` 的 v1 值 `workspace:<id>` 对非 Git Run 保留；G3 时 Git Run 使用 `git:<worktree>`。
- 若 t68 已先行合并：补一次 hook 结果处理/注入 `RunEnvironmentProvider` 的增量迁移；未补前 Git 侧 G3 保持关闭，G1/G2 可独立推进。

> **t79 修订记录**：本 §16 由 t79 按 t77 F1 增补；与 `docs/team/git-parallel-design.md` §4.4/§7.3/§16 对齐。
