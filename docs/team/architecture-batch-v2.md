# ARCH 架构定稿 v2：O1 / DW1 / RC1 / MF1

- **任务**：t497（ARCH 架构评审，G2 后重挂）
- **基线**：`main@d5a3ffc`（G2 / PR #71 已合并；`Git × AI` 生成/通知关闭）
- **性质**：只做架构设计，不改 `src/`、`electron/`、`dist/`、`dist-electron/`、`branches/`；本文件是后续实现的契约，不是实现记录
- **既有链**：旧 t372–t385 状态损坏，本定稿取代其设计结论；实现任务按本文 PR 拆分重新建链
- **硬约束**：
  1. 不破坏 **review / merge gate**、**权限模式/审批**、**事件日志** 的语义与审计；
  2. 不破坏现有 **PanelHost 面板隔离、LazyPanel 懒加载、Dock 的深链/Command Palette/面板最小尺寸**；
  3. **0.0.1 前不做历史兼容**：旧 Dock v1 布局、旧 task JSON/旧投影、旧编译产物、旧远端面板包均不承诺兼容；数据库只做一次内部迁移；
  4. O1 不新增对外 IPC；DW1/RC1/MF1 不新增权限、不新增后端事件；
  5. 每项都能单独 revert；迁移/持久化有明确回滚路径。

---

## 0. 决策摘要（TL;DR）

| 项 | 定稿决策 | 一句话理由 |
|---|---|---|
| **O1** | 任务 owner 与依赖从 `tasks.owner_id / tasks.depends_on(JSON)` 升级为 **`task_owners` + `task_dependencies` 关系表**；写入走统一 `TaskGraphService` 事务；事件新增 owner/dependency 专项类型；`tasks` 上的旧列在 expand/contract 完成后删除 | 现在 owner/deps 没有引用完整性、没有环校验、PlanDraft 分多次事务，图投影可能分叉；关系表 + 原子服务才能成为唯一事实源 |
| **DW1** | **自研 Dock 布局引擎**替换 `dockview-core/react`；稳定树模型（split/group）+ 纯命令 reducer；新持久化 `deer.dock.layout.v2.<workspaceId>`；**不迁移 v1 布局**，首次启动回默认 | 22KB `DockShell` + 库私有 JSON + 多档 variant 修补已难测试/回滚；自有模型可单测、可回滚、可解释 |
| **RC1** | React Compiler **分阶段、build-only、renderer-only** 接入；先 annotation 试点，再 infer 到 `shell/git/ui`，最后全 renderer；kernel/review/electron/scripts 排除；测试默认不编译，另设 compiler 构建/冒烟验证 | 编译器能减少手工 memo，但会重写 hook/memo 语义；必须限制边界和可回滚，且不能污染主进程与数据层 |
| **MF1** | **不引入运行时微前端**；采用“**编译期 Panel Manifest + 动态 import chunk + 面板边界契约**”的模块化单体。只有出现独立发布/独立团队/独立运行时需求时才启动 module federation 试点 | Electron 单应用、共享状态、preload/CSP/权限都在同一进程；运行时 federation 收益低、成本高，先用边界契约解决“面板独立构建”的可演进性 |
| **顺序** | Wave 1：O1-1、DW1-1、RC1-0（可并行）；Wave 2：O1-2、DW1-2、RC1-1；Wave 3：O1-3、DW1-3、RC1-2；Wave 4：O1-4、DW1-4、MF1-1/2、RC1-3；Wave 5：MF1-3（决策/试点）、RC1-4 | 数据层与 Dock 模型可并行；Dock 渲染器替换在模型稳定后；编译器全量在 Dock 重写后；面板 manifest 在 Dock 契约稳定后 |

**四个“不变量”**（所有 PR 的合并前置）：
1. review/merge gate 仍由既有 `ReviewService` / merge queue 判断，任何 owner/依赖/布局/编译/面板改动都不能绕过；
2. 权限模式与风险审批仍由 `PermissionMode`、agent 权限与 `requestApproval` 决定，owner 关系不授予权限；
3. 事件日志只追加不重写；O1 新增类型但保留既有 `task.*`/`review.*`/`merge.*`/`git.*` 类型和语义；
4. `PanelHost` 的面板隔离、`LazyPanel` 的懒加载、Dock 的 `openPanel`/深链/面板最小尺寸保持。

---

## 1. 基线与约束

### 1.1 当前代码事实

- `src/shared/types.ts` 的 `Task` 同时有 `ownerId: Id | null` 与 `dependsOn: Id[]`；`Task` 是 UI/调度/PlanDraft 共用的 DTO。
- `src/kernel/store.ts` 的 `tasks` 表是 `owner_id TEXT` + `depends_on TEXT NOT NULL DEFAULT '[]'`；没有 owner/dependency 关系表；`createTask` 只在创建时检查依赖是否已经 `done`，`updateTask` 只做相同的“已满足”检查，没有统一环校验/引用完整性。
- `src/kernel/service.ts` 的 `createPlan/applyPlan` 先逐个 `createTask`，再逐个 `updateTask({dependsOn})`；中途失败会留下部分任务/部分边。
- `src/kernel/execution/kernel.ts` 的调度器用 `blockedReasonFor(task, lookup)` / `dependenciesSatisfied` 读取任务 JSON 数组；`store.deleteTask` 单独扫描 `row.dependsOn.includes(id)` 阻止删父任务。
- `src/kernel/execution/eventRegistry.ts` 是 v2 事件 schema 白名单；现有 `task.created/updated/status_changed/blocked/unblocked` 已覆盖状态和普通 patch，但没有独立 owner/dependency 审计类型。
- `src/shell/dock/DockShell.tsx` 直接 import `dockview-react`，用 `api.toJSON()/fromJSON()` 持久化库私有结构；`panelRegistry.ts` 的 `DockStore` 是 `schema:"deer.dock.state", version:1`，`variants` 为 `wide|medium|narrow|single`，每个存在 `layout: unknown`；另有 `reconcileSingleLayout`、`panelInsertDirection`、`effectivePanelMinWidth`、`maxGroups` 等适配逻辑。
- `vite.config.ts` 只有 `@vitejs/plugin-react`，没有 React Compiler；`package.json` 的 `react`/`react-dom` 为 `^19.3.1`，Vite 8，`dockview-core/react` 固定 `8.9.0`。
- `src/shell/panel/PanelHost.tsx` 通过版本 store 隔离每个 panel 的 render，`src/shell/LazyPanel.tsx` 提供 Suspense/error boundary；`panelRegistry.ts` 已有 `PanelKey/title/component/minWidth/renderer/defaultClosed` 元数据；App 通过 `openPanel("gitGraph")` 等打开面板。
- G2 已新增 `git.ai_pr_draft`、`git.ai_merge_draft`、`git.merge_notified` 与 merge 通知，但明确“不改 review/merge gate、权限、状态机”；本文所有改动继续遵守。

### 1.2 非目标（全局）

- 不改 Git 写通道/G1、review/merge 状态机、合并队列的现有 gate；
- 不新增权限模式、不改变 `requestApproval` 超时/审批语义；
- 不让 Dock/Compiler/微前端直接访问 Node/Electron 主进程；
- 不引入远程代码执行、远程面板包或动态 `eval`；
- 不在本任务写生产代码或生成实现 PR。

---

## 2. O1：任务 owner 与依赖数据层统一

### 2.1 现状问题

1. **双源/弱约束**：`tasks.owner_id` 只是字符串列，`depends_on` 是 JSON 文本；没有 FK、唯一约束、同 workspace 校验，删除 agent/task 时依赖关系靠代码手工修补。
2. **图写入不原子**：`createTask` 先写入任务，依赖边要靠后续 `updateTask`；`createPlan/applyPlan` 的循环中失败会留下部分 DAG，`router.plan` 事件与任务图可能不一致。
3. **环/自依赖/跨 workspace** 没有统一拒绝点；`dependsOn` 可被任意 patch 写入。
4. **读路径分散**：UI、scheduler、PlanDraft、deleteTask 各自解析 `dependsOn` 数组；owner 展示和调度分别读取同一字段的不同路径。
5. **审计不足**：owner 变更和依赖变更只能落入 `task.updated` 通用 patch，难以做时间线/排障/权限审计；事件回放不能稳定区分“谁改了 owner/边”。

### 2.2 目标 / 非目标

**目标**
- 一个明确的 **Task 聚合边界**：owner 是“任务与 agent 的 0..1 关系”，dependency 是“任务到任务的有向无环边集”；
- 所有读写经统一 `TaskGraphService`/Store 事务；PlanDraft 一次性创建图；
- 强制同 workspace、存在性、无自依赖、无环、边数上限；删除任务时保护下游；
- owner/dependency 变更产生独立、可回放、可审计的事件；
- 保持 `Task` DTO 的对外字段 `ownerId`/`dependsOn`，避免 UI 与 IPC 语义变化。

**非目标**
- 不做多 owner/角色继承/ACL 系统；owner 仍是单值；
- 不改变 review/merge gate 的输入和结论；
- 不把 owner 当作权限来源；
- 不做历史 v1 JSON 的长期双读兼容（0.0.1 前允许一次内部迁移）；
- 不新增任务 IPC 通道。

### 2.3 数据模型

**目标 schema（v3；0.0.1 前一次迁移）**

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE task_owners (
  task_id    TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL,
  assigned_by TEXT NOT NULL          -- 'user' / 'system' / 'router' / 'watchdog'
);

CREATE TABLE task_dependencies (
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  ordinal             INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX idx_task_dependencies_parent ON task_dependencies(depends_on_task_id, task_id);
```

- `task_owners` 一行代表“当前 owner”；无行 = 未分配。历史通过事件日志查询，不增加 owner history 表。
- `ordinal` 保留依赖显示顺序；读 DTO 按 `ordinal, depends_on_task_id` 排序。
- `tasks.owner_id` / `tasks.depends_on` 在 expand 阶段保留为**兼容镜像**；contract 阶段重建 `tasks` 表并删除两列。
- `foreign_keys=ON` 必须在 Store 连接建立时开启；没有开启的旧连接视为实现缺陷。

**写入约束（Store/TaskGraphService 层）**

| 约束 | 规则 | 错误码/行为 |
|---|---|---|
| owner 存在 | `agents.id` 存在 | `TASK_OWNER_NOT_FOUND`，事务回滚 |
| owner 同 workspace | `agents.workspace_id = tasks.workspace_id` | `TASK_OWNER_WORKSPACE_MISMATCH` |
| owner 可分配 | 不限制 agent 角色/权限；不复制 permission | owner 仅执行归属；权限仍取 agent 当前 `permission` |
| 依赖存在 | 每个 id 存在且同 workspace | `TASK_DEPENDENCY_NOT_FOUND` / `TASK_DEPENDENCY_WORKSPACE_MISMATCH` |
| 自依赖 | 拒绝 | `TASK_DEPENDENCY_SELF` |
| 重复边 | 主键拒绝 | `TASK_DEPENDENCY_DUPLICATE` |
| 环 | 递归 CTE/DFS 检测 | `TASK_DEPENDENCY_CYCLE` |
| 边数 | 每任务 ≤ 100（可配置常量） | `TASK_DEPENDENCY_LIMIT` |
| 删除 | 有下游依赖时拒绝删除 | `TASK_HAS_DEPENDENTS`，保留现有行为 |
| 同事务 | owner + deps + status/blocked 投影 + 事件同一 `withTransaction` | 任一失败全回滚 |

**状态投影**：`blockedReason` 仍是任务状态字段/缓存，不是图的事实源；`TaskGraphService` 在边或依赖状态变化后重新计算受影响任务，值仍为 `waiting_dependencies` / `dependency_failed` / `dependency_cancelled` / `null`。调度器只消费 `Task` DTO，不解析 JSON。

**读模型**：
- `getTask/listTasks` 用 `LEFT JOIN task_owners` 和 `task_dependencies` 组装 `ownerId`/`dependsOn`；
- `Snapshot`/`Task` DTO 字段不变，UI/PlanDraft/StarMap 不需要改调用点；
- 不增加 `task graph` 专用 IPC；需要图查询时用已有 `getSnapshot`/`listTasks` 派生，后续若需要大规模图再单独设计只读查询。

### 2.4 事件模型

**保留的既有事件**：`task.created`、`task.updated`、`task.status_changed`、`task.blocked`、`task.unblocked`、`task.review_*`、`task.retry_*`、`task.cancelled` 的类型与语义不变；`task.created` 仍携带完整 task 快照（含 owner/deps），供旧投影消费。

**新增事件类型（v2 schema，additive）**：

```text
task.owner_changed
  payload: { taskId, from: string|null, to: string|null, assignedBy: string, reason: string }
  idempotencyKey: task:<taskId>:owner:<from-or-none>:<to-or-none>

task.dependencies_changed
  payload: { taskId, from: string[], to: string[], reason: string }
  idempotencyKey: task:<taskId>:deps:<hash(from)>:<hash(to)>
```

- 不用 `task.updated` 承载 owner/deps 变更，避免审计丢失；`task.updated` 继续用于标题/描述/acceptance/branch 等普通 patch。
- 事件与关系表写入同事务；`appendEventIdempotent` 已有幂等键机制直接复用；事件失败则关系不提交。
- 事件注册表新增两项 `assertKernelEventPayload` 校验；payload 限制在 `MAX_EVENT_PAYLOAD_BYTES`。
- **事件回放**：`task.created` + 新事件足以重建 owner/deps 快照；`task.dependencies_changed` 带完整 `from/to`，replay 不依赖“增量 delta”顺序。投影 digest 继续覆盖 tasks/relations。
- **事件日志兼容**：不重写/删除旧事件；旧 `task.created` 可由旧代码读取；新事件类型对旧读取方是未知类型（旧代码应忽略未知事件，若无则在本轮补齐“未知类型忽略并告警”）；G2 的 `git.*`/`merge.*`/`review.*` 完全不受影响。

### 2.5 迁移边界（0.0.1 前，不做历史兼容）

采用 **Expand → Migrate → Contract**，但只有一次内部 v3 迁移：

1. **Expand（O1-1）**：新建 relation 表；`PRAGMA user_version=3`；从 `owner_id` 回填 `task_owners`，从 `depends_on` JSON 回填 `task_dependencies`；保留旧列和旧读路径。迁移前 Store 自动备份（沿用现有 `lastBackupPath`），失败关闭连接、拒绝启动。
2. **Migrate（O1-2）**：所有写路径迁到 `TaskGraphService`；关系表 + 事件 + 旧列镜像同事务更新；读路径优先 relation，旧列仅作为回退；PlanDraft 一条事务建图。
3. **Contract（O1-4）**：删除旧列/旧 JSON 解析/旧 `updateTask({dependsOn})` 兼容分支；重建 `tasks` 表；只读 relation。此 PR 后旧代码/旧 DB 不保证可读，回滚必须恢复迁移备份（见 §2.9）。

**迁移校验**：
- owner 必须在同 workspace 的 agents 中存在；不存在则迁移失败（不静默清空，避免丢归属）；
- dependency JSON 必须是字符串数组，每个 id 存在且同 workspace；自依赖/重复/环/超限 → 迁移失败；
- 迁移失败输出 `task graph migration failed (user_version stays 2, backup: ...)`，不自动改库；这是 0.0.1 前的可接受失败面，发布前用全新 DB 验证。
- 迁移完成后 `PRAGMA foreign_keys` 校验 + `foreign_key_check` 作为测试断言。

### 2.6 读写、调度、PlanDraft 的联动

- **PlanDraft/applyPlan**：`createTasksFromPlan` 在单个事务内先分配任务 ID，再按 draft 索引插入依赖边；`router.plan` 事件也同事务 append；任何边失败整批回滚。`PlanTask.dependsOn` 仍是零基索引（UI 语义不变），只在提交时映射到 ID。
- **调度器**：`startTask`/`tick`/`blockedReasonFor` 继续读 DTO；`dependency_failed`/`dependency_cancelled`/`waiting_dependencies` 语义保持；不自动启动，不改变 review 状态机。
- **删除**：`deleteTask` 先检查 `task_dependencies` 下游；有则拒绝（与现状一致）；owner 行 cascade；不产生孤儿边。
- **UI**：`TaskStarMap`、`TasksView`、`PlanDraftPanel` 消费同一 DTO；不能各自维护 graph 副本。
- **review/merge**：review target 仍按 taskId/headSha；owner/deps 不参与 gate 的 approve/reject 计数，也不改变 `ReviewService.assertMergeAllowed/assertQueueAllowed`。

### 2.7 文件范围

- 改：`src/kernel/store.ts`（schema/迁移/读写/delete）、`src/kernel/service.ts`（Task/Plan 写入、reassign 路径）、`src/kernel/execution/kernel.ts`（scheduler/delete 读取）、`src/kernel/execution/eventRegistry.ts`（新事件校验）、`src/kernel/execution/projections.ts`（digest/回放适配）、`src/shared/types.ts`（仅 DTO 注释/类型，不改变字段）、`src/shared/planDraft.ts`（如需类型适配）。
- 读消费者如需适配：`src/shell/taskWorkspaceData.ts`、`src/TaskStarMap.tsx`、`src/shell/PlanDraftPanel.tsx`（只在 DTO 字段变化时；目标是不改）。
- 测试：`src/kernel/store.test.ts`、`src/kernel/service.test.ts`、`src/kernel/execution/kernel.test.ts`、`src/kernel/planDraft.test.ts`、`src/shared/planDraft.test.ts`、迁移/回滚专项测试。
- **不动**：`electron/`、`src/git/`、`src/review/`、`src/watchdog/`、`src/memory/`；不新增 IPC。

### 2.8 验收

1. 新建 DB 与 legacy v2 DB 都能迁移到 v3；迁移前后任务 owner/deps 快照一致；备份存在；坏数据迁移失败且不写半成品。
2. 所有约束有测试：owner 不存在/跨 workspace、依赖不存在/跨 workspace/自依赖/重复/环/超限、删除有下游。
3. `createPlan` 中途失败无部分任务/边/事件；幂等重放同一 plan key 结果一致（沿用现有 idempotency）。
4. 调度器前后行为一致：依赖未完成 blocked、依赖失败 `dependency_failed`、取消 `dependency_cancelled`、父重试成功后子恢复 ready。
5. 事件日志：新事件类型校验、幂等、同事务；旧事件可读；`task.updated` 不再承载 owner/deps；digest/回放可通过。
6. review/merge gate 测试全绿：review required/advisory/off、approval 绑定 head、merge approval reset、queue assert 均不改结论。
7. 权限：owner 变更不改变 agent permission；风险审批/`auto_risk` 行为不变。
8. 无新增 IPC、schema 以外无数据源；Task DTO 字段仍然向后兼容 UI。

### 2.9 风险 / 回滚

| 风险 | 级别 | 缓解 |
|---|---|---|
| v2→v3 迁移损坏/不可逆 | high | 自动备份、迁移前 `foreign_key_check`、失败拒绝启动；发布前用全新 DB 与 fixture 各跑一次 |
| 双写 relation + 旧列不一致 | high | O1-2 阶段同事务镜像 + digest 对比测试；O1-4 立即删除旧列，缩短窗口 |
| 环/跨 workspace 使旧数据无法迁移 | medium | 迁移失败报告精确 task/edge；不自动修复；发布前清理测试数据 |
| PlanDraft 原子化改变现有 UI 错误文案/重试 | medium | 保留 `router.plan`/applyPlan 返回结构；只改事务边界；补组件测试 |
| 调度器/删除路径遗漏 JSON 读 | medium | grep 全仓 `depends_on/dependsOn` 读点；加 lint/架构测试禁止在 kernel 读 JSON |
| review/merge gate 被新状态影响 | high | 不改 `ReviewService`/merge queue；E2E gate 测试作为合并门禁 |
| 旧事件消费者遇到新类型崩溃 | low | 投影只消费已知类型并忽略未知类型；事件注册表测试；事件日志不重写 |

**回滚**：
- O1-1（仅 expand）可代码 revert，v3 表/旧列共存，旧代码仍读旧列；
- O1-2 revert 时关系表仍在但旧列镜像仍写；需同时 revert 迁移或使用备份；
- O1-3 可 revert；
- **O1-4 contract 后必须用迁移前备份恢复 DB**，不承诺旧代码读 v3；这是 0.0.1 前“不做历史兼容”的明确代价。回滚脚本/文档必须在本项 PR 中提供。

### 2.10 PR 拆分与依赖

| PR | 内容 | 依赖 | 合并门禁 |
|---|---|---|---|
| **O1-1** | v3 schema、relation 表、backfill、备份/失败路径、只读双路径、迁移测试 | 无 | 迁移 fixture + foreign key/cycle 测试 |
| **O1-2** | `TaskGraphService`、owner/deps 写 API、事件、同事务镜像、PlanDraft 原子建图 | O1-1 | 事务回滚/幂等/事件测试 |
| **O1-3** | scheduler/delete/UI 读切 relation、grep 清理 JSON 读、调度回归 | O1-2 | 调度/删除/UI/审批回归 |
| **O1-4** | 删除旧列/旧 JSON 解析/兼容分支、重建 tasks、文档/回滚脚本 | O1-3 + 一次 green release | `foreign_key_check`、全量测试、gate 回归 |

> O1 的“0.0.1 前不做历史兼容”体现在：不实现旧 app 写新 v3、双格式长期保留、旧 JSON 回退；只在 O1-1/O1-2 的短窗口保留镜像，O1-4 立即 contract。

---

## 3. DW1：全量 Dock 重写（自研替换 dockview）

### 3.1 现状问题

1. **库私有布局模型**：`DockShell` 使用 `api.toJSON()` 保存 dockview 私有结构，`fromJSON` 直接恢复；布局 schema 不受本项目控制，升级/替换库需要黑盒回归。
2. **组件过大**：`DockShell.tsx` 约 23KB，包含初始化、variant 重排、single 修复、最大组限制、拖拽 onWillDrop、持久化、键盘；难以单测每个操作。
3. **适配补丁多**：`reconcileSingleLayout`、`panelInsertDirection`、`effectivePanelMinWidth`、t194/t208/t212 修复说明既有行为是围绕库的 API 形状生长的。
4. **测试依赖假 API**：Dock 行为测试大量 mock `DockviewApi`，无法证明纯布局语义（树结构、clamp、close 清理）本身正确。
5. **依赖成本**：`dockview-core/react@8.9.0` 固定版本，vendor chunk 单独拆包，CSS 由库提供；与 React 19/Compiler/Dock 新需求耦合。
6. **持久化版本单一**：`deer.dock.state` v1 按 workspace×四 variant 保存原始库 JSON，损坏/超限回默认，但没有可解释的迁移/回滚层。

### 3.2 目标 / 非目标

**目标**
- 用 **自有稳定布局树**（split/group）替换 dockview 作为唯一布局真相；
- 纯函数 reducer 覆盖 open/close/activate/move/split/resize/reset；
- 保持现有四档 `wide/medium/narrow/single`、面板最小尺寸、最大组数、设置不可关闭、PlanDraft 关闭回调、PanelHost 隔离、LazyPanel；
- 新持久化 `deer.dock.layout.v2`，明确校验/损坏回退/重置；
- 可测试、可回滚；移除 dockview 依赖和其 vendor chunk。

**非目标**
- 不改变面板清单/标题/路由（除移除 dockview 适配层需要的内部类型）；
- 不新增面板、不改变 panel 的权限/数据获取；
- 不实现 VSCode 级全部布局能力；保留当前允许的拖拽/关闭/重开/最大组约束；
- 不做 v1 布局历史迁移（0.0.1 前）；首个 v2 启动回默认布局。

### 3.3 布局模型（数据/UI 状态）

```ts
type DockVariant = "wide" | "medium" | "narrow" | "single";

type LayoutNode = LayoutSplit | LayoutGroup;

interface LayoutSplit {
  kind: "split";
  id: string;                    // 稳定 id，持久化/测试用
  axis: "horizontal" | "vertical";
  sizes: number[];               // 与 children 等长，flex 权重；UI clamp 到 min
  children: LayoutNode[];
}

interface LayoutGroup {
  kind: "group";
  id: string;
  panels: PanelKey[];            // 顺序 = tab 顺序，panel 全局唯一
  active: PanelKey | null;
}

interface DockLayout {
  schema: "deer.dock.layout";
  version: 2;
  variant: DockVariant;
  root: LayoutNode;
}

interface DockLayoutStore {
  schema: "deer.dock.layout";
  version: 2;
  updatedAt: string;
  variants: Partial<Record<DockVariant, DockLayout>>;
  activePanel: PanelKey | null;
}
```

**不变量**（每次 reducer 输出都校验）：
- 所有 `PanelKey` 最多出现一次；`active` 必须属于该 group 的 panels；空 group 必须被删除；single-child split 必须折叠；
- split 的 `children.length >= 2`，`sizes.length === children.length`，权重和 >0；
- group 数 ≤ `effectiveMaxDockGroups(maxGroups)`（沿用 2–8，默认 6）；
- 每个 panel/group/split 的尺寸下限来自 `PANEL_DEFS.minWidth/minHeight`；不可满足时优先降级布局，不产生负数/NaN；
- `settings` 不可关闭；`planDraft` 关闭前走 App 的 dirty 确认回调（现有 `onPanelClose`）。

**初始默认布局**（保持现有 UX）：
- `wide/medium/narrow`：主组 `chat` + MAIN_GROUP_ORDER tabs；`team` 右分栏，权重按现有 `VARIANT_WEIGHTS`（58/42、56/44、52/48），`team` 最小 360；
- `single`：全部面板在同一 group，`team` 作为 tab（不再单独 right split）；
- `context` 默认关闭；`runs`/`settings`/`polls`/`watchdog`/`planDraft`/`gitGraph`/`mergeQueue`/`console` 默认关闭，按深链/命令打开；
- 初始深链目标不在布局时，`openPanel` 插入当前 active group 并激活（保留 t52 IF-03）。

### 3.4 命令与渲染

```ts
type DockCommand =
  | { type: "open"; panel: PanelKey; cause: "nav" | "deep-link" | "command" | "restore" }
  | { type: "close"; panel: PanelKey }
  | { type: "activate"; panel: PanelKey }
  | { type: "move"; panel: PanelKey; target: PanelKey; position: "center" | "left" | "right" | "above" | "below" }
  | { type: "split"; panel: PanelKey; target: PanelKey; direction: "left" | "right" | "above" | "below" }
  | { type: "resize"; splitId: string; index: number; delta: number }
  | { type: "reset"; variant?: DockVariant | "all" };
```

- **纯函数**：`reduceDock(layout, command, context) -> { layout, effects }`；effects 只有持久化/通知/激活回调，不做 DOM。所有 reducer 有 property/table tests。
- **渲染器**：`DockShell` 变为受控容器；`DockTree` 递归渲染 split/group；`DockGroup` 渲染 tablist + panel host；`DockSash` 渲染分隔条（role=separator、键盘 + pointer）；`DockDropZone` 处理拖拽位置。
- **PanelHost**：不改版本 store；每个 group 的 active panel 和一个“always”面板按 `renderer` 规则挂载；`onlyWhenVisible` 只在 active 时渲染；隐藏面板不销毁 owner 数据。
- **键盘**：保留现有快捷键（Ctrl+Shift+Alt+方向键移动、`[`/`]` 调宽、Ctrl+Alt+W 关闭）；split sash Arrow/Home/End；tablist roving；焦点在关闭/移动后回到相邻 tab；保留 `aria-label`/title。
- **指针**：阈值（4px）后才进入 drag；drop 只在 group/edge 命中；`center` = 合并 tab，edge = split；达到 maxGroups 的非 center drop 拒绝 + toast，和现有 `onWillDrop` 语义一致。
- **variant 切换**：保存当前 variant 布局，加载目标 variant 的 v2 布局或默认；沿用 `selectVariant(dockWidth, windowWidth)`，不改变四档阈值。

### 3.5 持久化 / 事件模型

- 新 key：`deer.dock.layout.v2.<workspaceId>`；**不读、不迁移** `deer.dock.state` v1；首次 v2 默认布局；是否删除 v1 key 在 DW1-4 单独处理（默认保留，避免误删用户数据）。
- 写入：reducer 后 400ms debounce（保留现有节奏）；`saveStore` 序列化前校验 schema/版本/大小（沿用 64KB 上限）；写失败 toast，不影响操作。
- 读取：JSON/schema/结构不合法/超限 → 删除 v2 key、回默认并通知；不尝试 repair 未知结构。
- **事件日志**：布局属于 UI 状态，不写 kernel 事件；不改变 `EventRecord`/事件 registry。只使用本地持久化。
- **面板数据**：不缓存面板业务数据，不改变 IPC；各面板仍通过 App 的 render/`window.deer` 获取。
- **review/merge/权限**：布局只控制可见性；隐藏/重开面板不改变权限、不产生 approval、不影响 merge gate；`settings` 不可关闭且不是权限入口。

### 3.6 文件范围

- 新增：`src/shell/dock/layoutModel.ts`、`layoutOps.ts`、`layoutPersistence.ts`、`DockTree.tsx`、`DockGroup.tsx`、`DockSash.tsx`、`DockDropZone.tsx`、`dockLayout.css`、对应 tests。
- 改写：`src/shell/dock/DockShell.tsx`（降到编排/事件转发）、`src/shell/dock/panelRegistry.ts`（保留 `PANEL_DEFS`/variant 工具；移除 dockview 类型与 `DockStore` v1 兼容）、`src/shell/dock/DockShell.test.ts`、`narrowWindow`/`dockGroups` 适配。
- **不动**：`PanelHost.tsx`、`LazyPanel.tsx`、`src/App.tsx` 的公开 `DockHandle`/`openPanel` 调用、`panelRegistry` 的面板 key/title/routeTab。
- 依赖：`package.json` 移除 `dockview-core`、`dockview-react`；`vite.config.ts` 移除 vendor-dockview chunk；`pnpm-lock.yaml` 更新。
- 文档/截图：`docs/team/dock-layout-v2.md`（实现时）、三档截图、persistence evidence。

### 3.7 验收

1. **操作矩阵**：open（已存在/关闭/深链）、close（多 tab/单 tab/settings/PlanDraft dirty）、activate、move center、move edge、split、resize（鼠标/键盘）、max groups 拒绝、reset current/all。
2. **模型不变量**：property tests 随机命令序列不产生重复 panel/空 group/循环 split/NaN 权重；随机重启后结构等价。
3. **variant**：wide/medium/narrow/single 切换保留各自布局；single 下 team 是 tab；窄窗无横向溢出；1440/960/480 行为与现有截图基线一致。
4. **a11y**：tablist roving/ARIA、sash role=separator/valuenow/focus-visible、键盘关闭/移动/调宽、焦点恢复、reduced-motion。
5. **持久化**：合法 restore、损坏/超限/版本不符回默认并清理、64KB 上限、写失败提示、不读 v1。
6. **隔离/懒加载**：隐藏的 `onlyWhenVisible` 不 render；`always` 面板仍缓存；PanelHost 版本隔离测试保持；各 panel lazy 入口不变。
7. **无 dockview**：`rg "dockview" src package.json vite.config.ts` 为空（除 docs/ADR 历史说明）；build 无 vendor-dockview chunk。
8. **深链/Command**：`openPanel("gitGraph")`、`#/git`、Command Palette、DockHandle 由 App 调用全部回归。
9. **review/merge/权限**：无新的 gate/权限/事件代码；Dock 测试不调用 kernel 写。

### 3.8 风险 / 回滚

| 风险 | 级别 | 缓解 |
|---|---|---|
| 拖拽/嵌套 split 行为与库不一致 | high | 先做模型 property tests；DW1-3 用 `DockEngine` 常量/旧 renderer 双轨，截图对照 |
| 键盘/a11y 回退（dockview 有内置基线） | high | 独立 a11y 测试；焦点恢复用例；人工键盘走查 |
| 布局持久化损坏/旧 v1 用户失去布局 | medium | v2 新 key、v1 保留；不做历史迁移并明示；损坏回默认 |
| 最大组数/最小尺寸边界回归 | medium | 复用 `effectiveMaxDockGroups`/`effectivePanelMinWidth` 语义；随机树 clamp 测试 |
| PanelHost/懒加载被重写破坏 | high | PanelHost/LazyPanel 不改；Dock 只换 group host；隔离测试作为门禁 |
| 移除 dockview 后构建/样式差异 | medium | 先保留依赖到 DW1-3；DW1-4 最后删除；视觉截图门禁 |
| 大组件重写引入并发 stale state | medium | reducer + refs；关闭/切换取消 rAF；React 19 严格模式测试 |

**回滚**：
- DW1-1/2 是新增纯模型/测试，不影响运行时；
- DW1-3 用编译期 `DOCK_ENGINE = "v2" | "dockview"` 常量和旧 `DockShell` 分支；默认 v2，失败可切回；
- DW1-4 删除旧依赖后 revert 本 PR 并恢复 lockfile；v1 key 未删除，布局数据不丢（但 v1 只是旧布局的备份，不自动迁移）；
- 无 schema/权限/事件变更，回滚不涉及主进程。

### 3.9 PR 拆分与依赖

| PR | 内容 | 依赖 | 门禁 |
|---|---|---|---|
| **DW1-1** | layoutModel/types/normalize/property tests、默认布局生成（不接 UI） | 无 | 1000+ 随机操作不变量 |
| **DW1-2** | command reducer、persistence v2、fake renderer parity、PanelHost 接线测试 | DW1-1 | 操作矩阵/持久化测试 |
| **DW1-3** | 新 DockTree/Group/Sash/DropZone 渲染器，接 `DockEngine` 开关；保留旧 renderer | DW1-2 | 三档截图、a11y、隔离/懒加载 |
| **DW1-4** | 默认 v2、删除 dockview/旧 v1 适配/CSS/vendor chunk、最终证据 | DW1-3 | 无 dockview 引用、全量回归、回滚演练 |

> DW1 与 O1 只在 `App`/测试工具层可能触碰；数据层不交叉，可并行。DW1-3 是唯一高风险的渲染替换；DW1-4 必须等 DW1-3 至少一个 green release。

---

## 4. RC1：React Compiler 接入边界

### 4.1 现状问题

1. `package.json` 没有 React Compiler/Babel 插件；`vite.config.ts` 只有 `react()`，构建/测试均未编译。
2. 手动 memo 分布在各面板（`PanelHost`、Chat、Task、Git UI）；编译器会改变自动 memo 的插入点，可能改变闭包/引用语义和 effect 依赖行为。
3. 测试使用 `react-test-renderer` 和 Vitest；若全局启用编译器，测试代码/内核/脚本也会被编译，增加不可控变量。
4. Electron 的 main/preload 不经过 Vite renderer 构建；需要排除，不能把 React 插件误用于主进程。
5. 无“全量开启”与“定向 opt-out”的边界，也没有编译器单独的构建/回归门禁。

### 4.2 目标 / 非目标

**目标**
- 仅在 **renderer** 构建中启用 React Compiler；分阶段 annotation → infer；
- 建立明确的 include/exclude 边界，kernel/review/watchdog/memory/shared/electron/scripts/tests 不编译；
- 提供 `"use no memo"` 定向退出机制和白名单；
- 构建产物可验证、测试默认语义稳定；有构建时间/bundle/性能指标；
- 可一键回滚（移除插件/配置/依赖），不改数据/事件/权限。

**非目标**
- 不在本轮重写所有组件为编译器风格；
- 不删除所有手工 memo（只有证明等价后再清理）；
- 不把编译器用于 Electron main/preload、kernel、测试 runner、脚本；
- 不期待编译器自动修复性能问题；不改变 review/merge gate。

### 4.3 接入边界（关键决策）

**编译范围（build 时）**
- include：`src/**/*.tsx` 且属于 `src/shell/**`、`src/git/ui/**`、`src/**` 顶层 React 组件；实际用显式 allowlist 目录，避免误扫。
- exclude：`src/kernel/**`、`src/review/**`、`src/watchdog/**`、`src/memory/**`、`src/shared/**`（纯数据/无 React 组件）、`electron/**`、`scripts/**`、`**/*.test.*`、`**/__tests__/**`、`dist/**`。
- 主进程/electron 构建（`scripts/build-electron.mjs`）完全不接入 Babel 插件；preload 不编译。

**Vite 配置形态（实现时按插件 API 落地）**

```ts
// vite.config.ts（示意，版本在 RC1-0 spike 中锁定）
react({
  babel: {
    plugins: [
      ["babel-plugin-react-compiler", {
        target: "19",
        compilationMode: process.env.RC1_MODE === "annotation" ? "annotation" : "infer",
        sources: (filename: string) => /src[\\/](shell|git[\\/]ui)[\\/].*\.tsx$/.test(filename),
      }],
    ],
  },
})
```

- `RC1_MODE=annotation` 试点；默认构建逐步改 infer；测试默认 `VITEST` 下不加载插件。
- 不引入运行时 `react-compiler-runtime` 包；React 19 的 compiler runtime 为目标；若 spike 发现需要额外 runtime，必须单独评估，不能静默加依赖。

**阶段**
1. **RC1-0（边界/试点准备）**：加 dev dependency + 配置 + boundary test；只在本地 spike 编译 1 个非关键组件，确认 Vite/Vitest 行为；无生产源改动。
2. **RC1-1（annotation 试点）**：选 3–5 个组件（例如 `TaskStarMap`、一个纯展示 Chat 子组件、Git diff 行组件），显式 `"use memo"`；跑单测/性能/debug 对比。
3. **RC1-2（infer 局部）**：`src/shell/**` + `src/git/ui/**` infer；为已知高风险组件加 `"use no memo"`；保留测试基线。
4. **RC1-3（全 renderer）**：其余 `src/**/*.tsx`；清理试点 directives（仅当等价/性能证明）。
5. **RC1-4（清理/门禁）**：稳定配置、文档、回滚演练；不删除手工 memo，除非单独 PR。

### 4.4 数据/事件模型

- **数据**：无新增/修改 DB schema、无持久化格式、无迁移；编译器只改变构建产物（`dist` 不提交、不进入用户数据）。
- **事件**：无新增/修改事件类型；`use memo`/`use no memo` 只是源码 directive，不产生运行时事件；不改变 `EventRecord`、review/merge 事件或 G2 的 `git.*` 审计。
- **构建元数据**：`docs/team/rc1-build-metrics.json`（build 时间、主 chunk、试点 render 计数）是证据文件，不是应用数据/事件。
- **权限**：编译产物不携带权限快照；组件仍通过 App/preload 的既有调用获得权限。

### 4.5 构建/测试影响

| 方面 | 影响 | 处理 |
|---|---|---|
| 构建 | 额外 Babel pass；sourcemap/输出变化；HMR 首次变慢 | CI 记录 build 时间；RC1-0 量化；缓存 Babel |
| bundle | 可能略增/减少；memo cache 代码 | 记录主要 chunk 尺寸；不设硬性“必须变小”目标 |
| 测试 | 若全局编译，测试语义可能改变 | **测试默认关闭**；`VITEST_REACT_COMPILER=1` 定向跑编译器测试 |
| 测试覆盖 | 编译后 hook 顺序/闭包问题只在运行时暴露 | 关键面板 Electron/CDP 走查 + 组件测试；不依赖快照 |
| Electron | main/preload 不受影响 | build-electron 独立；边界测试断言无插件 |
| 依赖 | devDependency 增加；lockfile 变化 | RC1-0 单独 PR，审核许可证/大小 |

**验收测试**：
- `rc1-config.test.ts`：allowlist/exclude、`VITEST` 默认关闭、electron 构建不引用插件；
- `pnpm build` 成功且输出含编译器标记/或多阶段产物；`pnpm test` 不编译仍全绿；
- `RC1_MODE=annotation` 试点组件单测 + `VITEST_REACT_COMPILER=1` 编译器模式测试；
- 人工/CDP：Chat/任务/Git/Team 的关键交互、focus、effect、状态更新无回归；
- 记录编译前后 build 时间、主 chunk 尺寸、试点组件 render 次数（基准数据，不作为唯一门禁）。

### 4.6 兼容性

- **review/merge gate**：编译器不改变服务端/ReviewService/merge queue；只影响 renderer 组件的渲染实现，不新增 gate 输入。
- **权限**：不改 `PermissionMode`、`requestApproval`、IPC；组件仍通过 App/preload 调用。
- **事件日志**：无新增/修改事件；编译产物不是事件。
- **0.0.1**：不保留旧编译产物兼容；删除插件/重建即可；`dist` 不入库，无需迁移。

### 4.7 文件范围

- 改：`package.json`、`pnpm-lock.yaml`、`vite.config.ts`（或新建 `vite.react-compiler.ts`）、`vitest` 配置（若当前无独立文件，沿用 Vite 的 test 分支）、`docs/team/react-compiler.md`、`src/shell/...` 试点组件的 `"use memo"`/`"use no memo"` 指令（RC1-1 起）。
- 新增：`src/shell/reactCompilerBoundary.test.ts`（或 `scripts/compiler-boundary.test.ts`）、性能/构建记录 JSON。
- 不改：`electron/`、`src/kernel/`、`src/review/`、`src/watchdog/`、`src/memory/`、Git IPC。

### 4.8 验收

1. 构建只编译 renderer 允许目录；kernel/electron/scripts/tests 明确排除；测试有断言。
2. annotation 试点单测/真实面板交互通过；infer 阶段关键面板无行为差异（focus、effect、loading/error、键盘）。
3. `pnpm typecheck`、`pnpm build`、`pnpm test` 全绿；plain test 不因编译器引入新 flake。
4. 构建时间/chunk/render 基准记录；无静默新增 runtime 依赖（除已批准 compiler 插件）。
5. 回滚演练：移除插件/配置/依赖后构建/测试恢复基线。

### 4.9 风险 / 回滚

| 风险 | 级别 | 缓解 |
|---|---|---|
| 编译器改变 effect/闭包语义 | high | annotation 试点；逐目录 infer；`"use no memo"` 白名单；真实面板走查 |
| 测试/构建无编译导致“假绿” | medium | build 门禁 + `VITEST_REACT_COMPILER=1` 定向；边界测试 |
| 性能反而下降 | low | 只记录基准；不强制全量；按组件 opt-out |
| 与 DW1 重写冲突 | medium | RC1-1 只选非 Dock 组件；RC1-3 在 DW1-4 后；合并窗口协调 |
| 插件版本/React 19 兼容 | medium | RC1-0 spike 固定版本/许可证；不满足则暂缓 |
| 主进程被误编译 | high | 独立 build-electron + 边界测试；不把 plugin 加全局 Babel |

**回滚**：删除 `babel-plugin-react-compiler` devDependency、Vite Babel 配置、试点 directives/测试，重跑 build/test；无数据/DB/事件/权限变更；`dist` 重新生成即可。

### 4.10 PR 拆分与依赖

| PR | 内容 | 依赖 | 门禁 |
|---|---|---|---|
| **RC1-0** | 编译器 spike、devDependency、Vite 边界、boundary test、基准记录；无生产组件改动 | 无（与 O1/DW1 并行） | 插件不进入 kernel/electron；build/test 基线 |
| **RC1-1** | annotation 试点 3–5 个非 Dock 组件 + 性能/行为测试 | RC1-0 | 试点组件回归；无新增运行时依赖 |
| **RC1-2** | shell/git UI infer 白名单/opt-out | RC1-1、DW1-2（避免重写冲突） | a11y/交互/全量测试 |
| **RC1-3** | 全 renderer infer；可选清理试点 directives | RC1-2、DW1-4 | 三档截图/全量测试/基准 |
| **RC1-4** | 稳定配置、文档、回滚演练 | RC1-3 | 回滚可复现 |

---

## 5. MF1：微前端方案（面板独立构建/动态加载）或替代

### 5.1 现状问题

1. 所有面板都在同一 renderer bundle/同一个 React 树：`panelRegistry.PANEL_DEFS` 通过 `component` 字符串映射，`PanelHost` 用 App 注入的 `renderRef` 渲染；没有独立 panel package/remote entry。
2. 已有 **编译期动态 import**：`LazyPanel` 按面板拆 chunk，`loadGitGraphPanel` 等按需加载；已经获得“加载隔离/失败重试”，但没有明确的 panel manifest/边界契约。
3. 面板共享 App 的 `renderPanelContent`、`window.deer`、状态与样式；跨面板 import/隐式共享常见，独立构建会立刻暴露这些耦合。
4. Electron 是单应用、单 preload、单 CSP；运行时 module federation/iframe 会引入远程代码、版本偏差、IPC/权限重复与安全面。
5. 没有“面板独立发布”的产品需求；当前 8 人团队、同一仓库发布，独立部署收益不足。

### 5.2 目标 / 非目标

**目标**
- 明确 **Panel Module Contract**：面板可被识别、独立加载、独立测试、边界可检查；
- 保留并正式化现有动态 import/LazyPanel；编译期 manifest 由 panelRegistry 派生；
- 为未来独立构建预留接口，但 **0.0.1 前不引入运行时微前端**；
- 明确收益/成本/触发条件，避免“为了微前端而微前端”。

**非目标**
- 不引入 module federation/remoteEntry/iframe/webview；
- 不做独立部署/CDN/版本协商；
- 不改变面板权限/数据获取/IPC；
- 不复制 React runtime/CSS/状态库。

### 5.3 方案比较与决策

| 方案 | 收益 | 成本/风险 | 结论 |
|---|---|---|---|
| A. 运行时 Module Federation / 独立 remote entry | 独立发布、团队并行、故障隔离 | 两套 React/依赖、共享状态协议、CSS 隔离、preload/CSP/权限、版本偏差、测试/打包复杂 | **不采纳（0.0.1）** |
| B. iframe/webview 远程面板 | 强隔离 | Electron 安全/CSP、IPC 桥、焦点/快捷键、主题、可访问性、调试成本 | **不采纳** |
| C. 编译期 panel packages（monorepo 多 entry，build 时打包成 chunk） | 边界清晰、可独立测试/构建、仍单 runtime | 构建复杂度中等；仍有共享状态/样式契约 | **可选演进（触发条件见下）** |
| D. **模块化单体：编译期 manifest + 动态 import + PanelHost 契约（选定）** | 低复杂度、保留懒加载、可用边界测试获得大部分收益 | 非真正独立部署；依赖仓库内规范 | **0.0.1 采用** |

**采纳 D 的理由**：当前产品是单 Electron 应用，preload/安全/权限/主题/共享状态都在同一进程；独立发布没有用户价值，反而放大安全/版本成本。D 已通过 `LazyPanel` 获得加载隔离，补 manifest/边界即可支持未来拆分。

**触发重新评估 C/A 的条件（全部满足才启动）**：
1. 至少一个面板需要独立于主应用发布/回滚；
2. 面板团队独立且需要独立构建流水线；
3. 有稳定的 panel host/state/permission 协议和版本协商；
4. Electron CSP/preload/签名/完整性方案评审通过；
5. 有明确的性能/故障隔离收益指标。

### 5.4 数据/事件模型

- **Panel Manifest（编译期）**：

```ts
interface PanelManifest {
  key: PanelKey;
  version: 1;                       // 面板契约版本，不是应用版本
  title: string;
  load: () => Promise<{ default: ComponentType<PanelProps> }>; // 现有 LazyPanel loader
  capabilities: {
    reads: string[];                // 例如 "git.read"、"tasks.read"
    writes: string[];               // 例如 "git.write"（仍需 IPC/gate）
    requiresPermission?: PermissionMode;
  };
  minWidth: number;
  minHeight: number;
  renderer: "always" | "onlyWhenVisible";
}
```

- Manifest 由现有 `PANEL_DEFS` + `load*Panel` 映射生成（编译期常量）；**不包含远程 URL**；运行时只查表，不 fetch 配置。
- `PanelProps` 只暴露受控上下文（workspaceId、selection、onNavigate、refresh 版本）；面板不得直接 import `electron`、kernel、其他面板实现；写操作仍走 `window.deer` 的类型化 API。
- **事件日志**：不新增事件；面板加载/切换是 UI 行为，不写 kernel；渲染失败仍用 LazyPanel `role=alert`。
- **权限**：manifest 的 `requiresPermission` 只是 UI 提示/禁用依据，真实权限仍由 agent/permission + IPC 校验；不能作为授权来源。
- **review/merge gate**：面板无论独立与否，写路径仍调用现有 IPC → service → gate；MF1 不改 gate/状态机。

### 5.5 文件范围

- 改：`src/shell/dock/panelRegistry.ts`（导出 manifest/loader 映射）、`src/App.tsx`（loader 映射集中）、`src/shell/LazyPanel.tsx`（如需类型）、`src/shell/panel/PanelHost.tsx`（如契约 props 扩展）、`vite.config.ts`（chunk 断言/构建边界）、`docs/team/panel-contract.md`。
- 新增：`src/shell/panel/panelManifest.ts`、`panelBoundary.test.ts`（禁止 electron/kernel/跨面板 import）、chunk budget 测试/脚本。
- **不新增**：remote entry、iframe、module federation 依赖、权限/IPC。
- 可选 MF1-3 spike（不合并生产）：独立构建一个只读面板的 chunk，测量收益；结论写入 ADR。

### 5.6 验收

1. 每个 `PanelKey` 有 manifest/loader，`openPanel` 行为与当前一致；现有 LazyPanel 失败重试/隔离不变。
2. 边界测试：面板不 import `electron`/`src/kernel`/其他面板实现；无直接 `window.require`/Node API；只使用 `window.deer`。
3. `pnpm build` 仍按面板产生独立 chunk；chunk 总量/首屏不因 manifest 增加显著回归；记录 panel chunk size。
4. 无新增 runtime 远程代码/CSP/权限；review/merge gate/事件日志不变。
5. MF1-3 若做，报告明确“不进入生产”或触发条件复核；不通过则关闭。

### 5.7 风险 / 回滚

| 风险 | 级别 | 缓解 |
|---|---|---|
| 过度设计/阻塞交付 | medium | 0.0.1 只做 manifest + 边界，不做 remote |
| 边界测试误报 | low | 允许明确白名单；按 panel 配置 |
| 面板仍隐式共享 App state | medium | 契约 props 白名单 + 禁止跨面板 import；逐步迁移 |
| 未来独立构建需要重写 | medium | manifest/loader 抽象保留；届时评估 C/A |
| chunk 增多/首屏变慢 | low | 现有 lazy 已分 chunk；记录 size，不强制拆分更细 |

**回滚**：MF1-1/2 是 manifest/测试的增量，删除即可回到 `PANEL_DEFS` 直连；无数据/事件/权限迁移；MF1-3 永不进生产或在独立分支丢弃。

### 5.8 PR 拆分与依赖

| PR | 内容 | 依赖 | 门禁 |
|---|---|---|---|
| **MF1-1** | 编译期 `PanelManifest`/loader 映射、`panelRegistry` 适配；行为不变 | DW1-4（布局契约稳定） | 现有面板/懒加载回归 |
| **MF1-2** | 边界测试/import 白名单/chunk budget、ADR | MF1-1 | 无 electron/kernel/跨面板 import；build chunk 记录 |
| **MF1-3（可选）** | 独立构建只读 panel 的 spike，不合并生产；记录收益/成本 | MF1-2 + 触发条件 | 不作为发布门禁；无 remote 依赖 |

---

## 6. 与 review/merge gate、权限、事件日志的兼容矩阵

| 变更 | review/merge gate | 权限/审批 | 事件日志 | 数据/schema |
|---|---|---|---|---|
| **O1** | 不改 `ReviewService.evaluate/assertMergeAllowed/assertQueueAllowed`；owner/deps 不参与 gate 输入；review 状态机保持 | owner 只是归属；权限仍取 agent `permission`；不增加审批；`reviewTask` 仍 human-only | 新增 `task.owner_changed`/`task.dependencies_changed`（v2、additive）；既有事件类型/语义保留；append-only；新事件与 relation 同事务 | v3 relation 表；v2→v3 一次内部迁移；O1-4 删旧 JSON/列 |
| **DW1** | 不改 gate；隐藏/重开面板不产生 approval；settings 不可关闭不改变 gate | 布局只控制可见性；不扩大权限；不新增 IPC | 不新增事件；布局仅 localStorage v2 | 无 DB schema；v1 布局不迁移 |
| **RC1** | 不改 gate；编译器只影响 renderer 渲染 | 不改 permission/approval；组件仍走 App/preload | 无事件 | 无 DB；无持久化格式；dist 重建 |
| **MF1** | 面板仍通过原有 IPC/service/gate；manifest 不绕过 | `requiresPermission` 仅 UI 提示；真实权限由 agent/permission/IPC 校验 | 无事件 | 无 DB；manifest 编译期 |

**审查重点**：
- O1 的所有写路径必须经过同事务；任何 `db.prepare("UPDATE tasks SET ... depends_on")` 直写都视为违规（除 O1-1/O1-2 受控镜像代码）。
- DW1/RC1/MF1 的 PR 不得修改 `src/review/**`、`src/kernel/permission.ts`、`src/kernel/execution/stateMachine.ts`、`src/git/mergeQueue.ts`；若需要改，另立安全评审任务。
- G2 的 AI draft/merge notify 只读 `TaskVcs`/diff，不依赖 owner/deps；O1 改 DTO 字段来源不改变 G2 输入。
- review/merge 的 headSha 绑定、approval reset、human-only blocker 均保持。

---

## 7. 总 PR 顺序与依赖

```text
Wave 0（文档/基线，无代码）
  ADR（本文件） → 基线记录（typecheck/build/test）

Wave 1（可并行）
  O1-1  relation schema + backfill + read fallback
  DW1-1 layout model + default layout + property tests
  RC1-0 compiler spike + build boundary

Wave 2
  O1-2  TaskGraphService + events + plan transaction
  DW1-2 command reducer + persistence v2 + adapter
  RC1-1 annotation pilot（非 Dock 组件）

Wave 3
  O1-3  scheduler/delete/UI 切 relation
  DW1-3 new Dock renderer behind flag
  RC1-2 infer shell/git UI（DW1-2 后，避免重写冲突）

Wave 4
  O1-4  contract（删旧列/JSON）
  DW1-4  remove dockview/v1 cleanup
  MF1-1 manifest（DW1-4 后，布局/面板契约稳定）
  MF1-2  boundary/chunk gate（MF1-1 后）
  RC1-3  full renderer（DW1-4 后）

Wave 5
  MF1-3 optional federation spike（仅触发条件满足；不进生产）
  RC1-4  stabilization/rollback drill
```

**依赖图（硬边）**：

```text
O1-1 → O1-2 → O1-3 → O1-4
DW1-1 → DW1-2 → DW1-3 → DW1-4
RC1-0 → RC1-1 → RC1-2 → RC1-3 → RC1-4
DW1-4 → MF1-1 → MF1-2
DW1-4 → RC1-3（避免对刚重写的 Dock 组件重复编译改造）
O1-3 + DW1-3 + RC1-2 可在不同分支并行（Wave 3），但 O1-4/RC1-3 的合并需等各自前序 green
```

**合并门禁（每个 PR）**：
- `pnpm typecheck`、`pnpm build`、`pnpm test`；既有 5s 并发 flake 用 serial 或 `--testTimeout=20000 --maxWorkers=1` 记录，不新增基线失败；
- 目标项的自测矩阵（§2.8/§3.7/§4.8/§5.6）；
- 不修改 review/merge gate、permission、事件 registry 以外未经声明的语义；
- UI 项附 1440/960/480 真实 Electron 截图；数据/迁移项附 migration JSON/backup evidence；
- 每个 PR 体写清 changedPaths、回滚、未覆盖项。

---

## 8. 测试计划（汇总）

| 层 | 测试 |
|---|---|
| O1 迁移 | fresh v3、legacy v2→v3、坏 owner/环/跨 workspace 失败 + backup、`foreign_key_check`、重复迁移幂等 |
| O1 图/事务 | owner/dep CRUD 约束、并发 reassign、PlanDraft 中途失败回滚、delete 下游保护、scheduler blocked/retry 恢复、事件幂等/回放 |
| DW1 模型 | normalize/property（随机 1000 命令）、所有命令表驱动、max groups/min sizes、variant 切换、持久化损坏/超限、reset |
| DW1 渲染 | tablist/sash ARIA/键盘/焦点、拖拽 drop 中心/边、PanelHost 隔离、LazyPanel 失败重试、三档截图、无横向 |
| RC1 | boundary include/exclude、build annotation/infer、test 默认关闭、试点组件、compiled smoke、build/chunk/metrics、回滚演练 |
| MF1 | manifest 完整/唯一、loader 成功/失败、边界 import 禁止、chunk 预算、无 remote/CSP 变更 |
| 跨切 | review required/advisory/off、merge queue approval/head reset、permission/approval、事件旧类型可读；全量回归 |

建议 CI 分层：`test`（默认无编译器）、`build`（编译器 build）、`test:compiler`（定向，环境变量）、`test:serial`（本仓既有 flake）；Dock/数据迁移项要求真实 Electron/CDP 或最小复现 fixture。

---

## 9. 风险总表 / 回滚总表

| 项 | 最大风险 | 主回滚 |
|---|---|---|
| O1 | v2→v3 迁移 + 双写不一致 | 恢复迁移备份；O1-1/2 可代码 revert；O1-4 必须恢复 DB |
| DW1 | 拖拽/嵌套布局/a11y 回归 | DW1-3 保留旧 renderer 开关；DW1-4 整 PR revert + lockfile；v1 key 不删 |
| RC1 | 编译器行为/性能回归 | 删除插件/配置/依赖；dist 重建；无数据影响 |
| MF1 | 过度设计/边界误伤 | 删除 manifest/测试增量；无运行时/数据影响 |

**0.0.1 的“无历史兼容”承诺**：
- 旧 Dock v1 布局不迁移，回默认；用户可重新布局；
- O1 旧 JSON/task 投影在 contract 后不再读取；迁移只做一次，回滚靠备份；
- 旧编译产物不要求可复用；
- 不实现旧远端 panel manifest/remote entry 兼容。

---

## 10. 待确认问题（交由 Captain/架构评审）

1. O1 `task_dependencies` 是否保留 `ordinal`（显示顺序）还是按 task ID 排序即可？本设计选保留。
2. O1 migration 遇到坏数据是 **fail closed + backup** 还是清理可修复项？本设计选 fail closed（0.0.1 前）。
3. DW1 是否允许在 DW1-4 删除 `deer.dock.state` v1 key？本设计默认保留、只停止读取。
4. DW1 是否保留 `wide/medium/narrow/single` 四档，还是合并为响应式单一树？本设计保留四档以维持现状。
5. RC1 编译器版本与 annotation 试点组件清单，需要在 RC1-0 spike 后由实现/评审确认。
6. MF1 是否在 0.0.1 之后启动 C（编译期 panel packages）而没有独立发布需求？本设计暂不启动。
7. O1 是否需要新的只读任务图 IPC，还是 `getSnapshot` 足够？本设计不新增 IPC，后续按性能另议。

---

## 11. 验收映射

| 任务验收 | 本文落点 |
|---|---|
| 四项均有现状/目标/非目标/范围/风险/验收/回滚 | §2–§5 每项 2.1–2.10、3.1–3.9、4.1–4.10、5.1–5.8 |
| 每项 PR 拆分顺序与依赖 | §2.10、§3.9、§4.10、§5.8；总图 §7 |
| 明确不破坏 review/merge gate、权限、事件日志 | §6 矩阵 + §0 不变量 + 各兼容小节 |
| 文档落盘并回报关键决策 | `docs/team/architecture-batch-v2.md`（本文件）；完成 output 摘要 |
