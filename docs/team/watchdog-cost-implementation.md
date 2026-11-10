# 看门狗与成本系统实现（t144）

- **任务**：t144 — 实现：看门狗与成本系统（依据 t141 通过的 `watchdog-cost-design.md`）
- **模型路由**：`deepseek-official/deepseek-flash`（sol）
- **分支 / worktree**：`feature/t144-watchdog-cost` / `branches/t144-watchdog-cost/`（基于 `origin/main` @ `8adceaf`）
- **日期**：2026-11-10
- **状态**：实现完成，typecheck / build / test 全绿；PR 待独立评审 → 集成
- **设计依据**：`docs/team/watchdog-cost-design.md`（t134 + t141，86 条 AC）

---

## 1. 交付摘要

| 模块 | 实现 |
|---|---|
| 独立状态 | `watchdog_schema=1` + watchdog 表；**不新增/不写 kernel tasks/runs 列**；hold/count/handoff 在 watchdog 表 + 既有 `nextRunAt`/`run.started` payload，kernel rebuild 不丢 |
| L2 信号 | 活动状态机（last activity/progress、重复工具签名、错误连击、token 采样、waiting_human grace）；5min warning、10min stall、15min patrol、deadman |
| 干预 | nudge → pause+handoff+hold → fallback model → switch member → human；autoInterventions 达到 2 后**含 nudge 在内全部自动动作禁用**；多原因 hold；429/quota 冷却 |
| Handoff | 先生成 summary + Git diff stat/patch 引用 + next step 并持久化/发事件，再 `kernel.interruptRun` abort；新 Run `run.started` 带 handoffId，执行器注入 prompt |
| 成本 | ModelProfile 可选价格；final/provisional ledger（micro-USD/价格快照/幂等）；final + Run.costUsd + cost.recorded 同事务；预算 `final + active provisional + reservation` 口径 |
| 预算/降级 | task/agent/workspace 预算、soft/hard、pause/stop、启动前拦截、运行中 hard 暂停；fallback 链/provider-model 两级冷却 |
| API/IPC | Watchdog snapshot/costs/handoff/ack/resolve/releaseHold/setBudget/setFallback/health；main/preload/DeerApi |
| UI | 独立 `WatchdogPanel`/`BudgetBar`/`WatchdogAlertBanner`/`RunHandoffCard`（ARIA progressbar/alert/live、窄窗 class）；组件测试 |
| 测试 | watchdog 20 例 + 既有 463，共 **483**；fake clock/重建/预算/暂时租约/切换成员/UI/429 计数/冷却拦截/链空 |

**验证数字（本地 HEAD）**：

```
pnpm typecheck  # exit 0
pnpm build      # exit 0
pnpm test       # 37 files / 483 tests passed
```

构建（t157）：`dist/assets/index-BaHOCsV6.js 1,183.45 kB (gzip 324.87)`，CSS 225.28 kB；`dist-electron/main.cjs 1.4 MB`。

---

## 2. 数据模型与迁移

`src/watchdog/store.ts` 在**主 `deer.db`** 内创建独立 `watchdog_schema`，不修改 kernel `user_version`：

- `watchdog_state`（enabled/last_tick/last_patrol/deadman/paused_by）
- `watchdog_alerts`（open 去重唯一索引、acked/resolved）
- `watchdog_interventions`（task 级单 active 唯一索引）
- `watchdog_task_state`（`auto_interventions`/`nudge_count`）
- `watchdog_holds`（PK `(task_id, reason, scope)`，多原因可并存）
- `run_handoffs`（summary/next_step/files/diff_stat/diff_ref/last_event_seq/model/agent）
- `cost_ledger`（provisional/final，final 与 `(run_id,kind)` 唯一）
- `budget_limits`（scope/scopeId/limit/soft/hard_action）
- `provider_cooldowns`（provider/model 两级，`*` 通配）
- `watchdog_fallbacks`（workspace/agent 链）

迁移：schema 幂等创建 + `watchdog_schema(1)`；不 ALTER kernel 表；不回填历史成本；失败不阻塞 App（可禁用 watchdog）。t157 起 watchdog 表明确为 **durable cache**（INV-9/MG-05 已修订）：`WatchdogStore.rebuild()` 做 schema 修复/计数校验，**不清空**已有 hold/计数器/handoff；删除表后可重建空 schema 并记录 missing，不伪造业务数据。kernel `rebuildProjections()` 不会 reset watchdog 状态（测试覆盖）。

> 说明：设计 F1 要求不新增 kernel task/run 列，本实现遵守；hold 的调度效果由既有 `Task.nextRunAt` + kernel `holdTask/releaseTaskHold` 事件表达，原因在 `watchdog_holds`。

---

## 3. 内核最小扩展

`src/kernel/execution/kernel.ts`：

- `KernelHooks.onRunStarted/onRunActivity/onRunHeartbeat`；
- `RunExecutionContext.activity(kind,payload)`、`consumeNudges()`；
- `injectNudge(runId,text,reason)`：写入 `run.nudge` 事件 + 队列，loop 下一步注入 `[watchdog]` 消息；
- `interruptRun(runId,{code,message,retryable,retryDelayMs,nextModelProfileId,handoffId})`：abort + `failRun`（CAS/lease/fencing 复用 t68/t90/t94），可排队重试、写 model/handoff override；
- `holdTask(taskId,nextRunAt)`/`releaseTaskHold(taskId)`：只写既有 `nextRunAt` + `task.updated` 事件；不新增列；
- `reassignTask(taskId,agentId)`：owner 更新 + task.updated；
- `RunExecutionContext` nudge/activity 均不改变 Run 状态；
- `run.started` payload 可带 `handoffId`（事件契约扩展，非列）；`run.nudge` 加入 kernel 事件 registry/zod。

`src/kernel/loop.ts`：每步消费 nudge、每步上报累计 usage。
`src/kernel/service.ts`：组合 kernel hooks（budget 先于 Git beforeStart）、上报 activity/heartbeat、`run.modelProfileId` override、handoff prompt 注入、15s 租约心跳；AppService 暴露 watchdog API；close 关闭 watchdog。

> 兼容：无 watchdog 时 hooks 缺省/不阻断；`runTask`/scheduler/审批/权限/Git 行为不变。

---

## 4. 检测与干预

`src/watchdog/signals.ts`（纯函数）+ `service.ts`：

- 活动：step/tool_call/tool_result/assistant/usage/checkpoint；heartbeat 只采样 token，不刷新 L2 activity。
- 信号：heartbeat_stale（10min）、task_timeout（5min）、repeat_tool（同签名 3 次/同文件 4 次）、no_progress（≥3 步或 8min 无 progress）、error_streak（3 次）、token_burn（120k/5min）、waiting_human grace（240s，仅 critical 不 pause）、deadman（2×tick）。
- 巡检：`tick()` 60s（生产 timer，unref），`patrol()` 15min；fake clock 可手动驱动。
- 干预：
  - nudge：最多 3 次，不计 auto，5min 间隔；达到 auto=2 后禁止。
  - pause：**HandoffBuilder.build → run_handoffs + run.handoff_created → kernel.interruptRun(WATCHDOG_PAUSED) + hold + nextRunAt**；auto+1；alert。
  - fallback：选链中非当前/非冷却模型，handoff → interrupt(WATCHDOG_MODEL_SWITCH, override) → 新 Run；auto+1；`run.model_fallback`。
  - switch member：handoff → interrupt + reassignTask → 新 Run；auto+1；`run.member_switched`（已测试）。
  - human：hold escalation + pause scheduler + critical alert；auto 不变；不自动恢复。
- 预算：`beforeStart` 用 `CostService.checkBeforeStart`（hard 时 hold + `cost.budget_exceeded`，不创建 Run/不消耗 attempt）；活动心跳检查 hard，pause/stop；soft 写 warning 事件。
- 429/quota：从 `run.failed.errorCode` 归一化，写 provider quota/cooldown（provider/model 两级，5min/resetAt）；显式 `recordProviderQuota` 供适配器/测试。
- 去重：alerts 按 dedupe_key open 唯一；interventions task 单 active；handled bucket 防重复。

---

## 5. Handoff 与 fencing

`src/watchdog/handoff.ts`：

- 读取 task/run/agent、最近事件、`TaskSummary`；在 `run.sandboxId=git:<cwd>` 的 worktree 或 workspace 执行只读 `git diff --stat/name-status/unified=3`（3s timeout，敏感路径过滤，patch ≤256KB）。
- 生成 summary（goal/acceptance/completed/diff/nextStep）、files、diffStat；patch 写 `dataDir/handoffs/<id>.patch`（0600），DB 只存引用；`run_handoffs` + `run.handoff_created`。
- 顺序：**先 handoff 持久化，再 kernel.interruptRun**；测试断言 handoff event seq < run.failed seq。
- 新 Run：kernel `handoffId` override → `run.started` payload；service executor 读 handoff（`getRunHandoff`）注入 system prompt（≤2k diff stat，不内联全 patch）。
- 旧 Run：interrupt 复用 kernel `discardRun`/CAS/lease；旧结果 `run.result_discarded`；新 Run attempt+1；Git finalize 仍走原 lease/fencing。

---

## 6. 成本与预算

`src/watchdog/cost.ts` + `shared/types.ts`：

- `ModelProfile.pricing?`：input/output/cached/reasoning per 1M USD；`normalizeModelPricing` 保留设置；也可用 `watchdog.modelPricing` 设置 map（测试/兼容）。
- 计算 micro-USD（整数）→ USD 4 位；价格快照；未知价格 `pricingKnown=false`，默认不阻塞预算（设计 Q6 默认）。
- provisional：active Run 单行原位 upsert；每 heartbeat；
- final：`onRunFinished`/事件 listener 幂等；**同一事务**写 ledger final + `runs.cost_usd` + `cost.recorded`；删除 provisional；final unique。
- 预算口径：`spentForBudget = final + active provisional + reservation`；`reservation = (maxOutputTokens - tokenOut) × outputPrice`；`checkBeforeStart` 对 task/agent/workspace 依次检查；hard → deny/hold；活动 hard → pause/stop；soft warning。
- 历史 Run 不回填；ledger 只对 new final 记录。
- 降级链/冷却：`watchdog_fallbacks`；`provider_cooldowns` 同时检查 `(provider,model)` 与 `(provider,'*')`，过期清理。

---

## 7. API / IPC / UI

### 7.1 API/IPC

- `WatchdogService`：`getSnapshot/getCosts/getRunHandoff/ackAlert/resolveAlert/releaseTaskHold/setBudget/setFallbackChain/getHealth/tick/patrol/rebuild`。
- workspace 反查：alert/hold/handoff 全部带 workspaceId；跨 workspace NOT_FOUND（测试）。
- `src/shared/watchdog.ts` 类型 + `src/shared/ipc.ts` 方法；`electron/main.ts` 9 个 handle；`electron/preload.ts` DeerApi。`WatchdogResult` 业务失败不 reject。
- 事件：`watchdog.*`/`cost.*`/`provider.*`/`run.handoff_created`/`run.model_fallback`/`run.member_switched` 独立 zod registry（schemaVersion=2），不写入 kernel KERNEL_EVENT_TYPES。

### 7.2 UI

新增独立组件（`src/watchdog/WatchdogPanel.tsx`）：

- `BudgetBar`：`role=progressbar`、aria-valuenow/min/max/valuetext、soft/hard/unset 文本，颜色外有文本。
- `WatchdogAlertBanner`：critical `role=alert`/assertive，warning `role=status`/polite；确认/解决/恢复按钮。
- `WatchdogPanel`：Alerts / Interventions+Fallback / Costs 三段；空态、加载/错误由调用方；`aria-live`。
- `RunHandoffCard`：summary/next step/files/diff stat details。
- 窄窗：`.watchdog-topbar`/`.watchdog-panel` 在 900/760 断点收窄/换行；`prefers-reduced-motion` 关闭动画；按钮 `focus-visible`。
- **t157 UI 挂载**：`watchdog` 加入 Dock `panelRegistry`（默认关闭）；App 主区顶部预算条、任务详情告警条、RunHistory handoff 卡；修复了 t144 “只有组件无入口”的问题。

### 7.3 t157 round-2 修复（对应 t145 findings）

- **F1 敏感 diff**：handoff 按路径拆分；tracked `.env`/`.ssh` 只保留 `[REDACTED]`/safe stat，不落完整 patch；summary.files/assistant 文本过滤；测试覆盖。
- **F2 429**：失败事件生成 `provider_quota` 信号 → 冷却原 provider/model → handoff → `retryTaskWithModel` 新 Run model override；测试 429→fallback→新模型→冷却。
- **F3 UI**：Dock/顶部预算条/任务告警/RunHistory + styles 900/760/reduced-motion；补面板注册/ARIA/窄窗测试。
- **F4 release**：必须 `reason` 或 `all=true`；默认只释放当前 reason，最后一个 hold 才清 `nextRunAt`；双 hold 测试。
- **F5 rebuild**：表降级 durable cache，INV-9/MG-05/§9.3/AC 同步；`rebuild` 做 schema 修复（删除/损坏表重建空 schema 并记录 missing），不伪造数据。

### 7.4 t161 round-3 修复（对应 t158 findings）

- **F1 provider 级冷却**：`recordProviderFailureWindow` 持久化 provider/5min 计数；第 2 次写 `model='*'`；beforeStart 用 pending/agent profile 检查两级冷却，命中则 hold+critical 并拒绝启动；真实 429 两次→`*` + beforeStart 拦截测试。
- **F2 链空 human**：target=null → `escalate` + escalation hold + critical alert + scheduler pause + holdTask；链空/all cooling 测试断言不自动重跑。
- **F3 UI**：新增 BudgetBar/AlertBanner 交互（ack/release）、RunHistory handoff 组件测试、panel registry/900/760 断言；完整 App DOM e2e 标 P1 manual。
- **F4 summary 脱敏**：summaryLines/changes/openQuestions/nextStep 统一 `redactSensitiveText`；summary 含 `.env`/secret 测试。
- **F5 测试**：watchdog 20 例，新增真实 429 两次、同 model 拦截、链空/all cooling、summary 脱敏、UI 交互。

---

## 8. 文件

**新增**

```
src/watchdog/events.ts        watchdog/cost 事件 registry
src/watchdog/store.ts         watchdog_schema/表/查询/重建
src/watchdog/signals.ts       pure detector
src/watchdog/cost.ts          价格/ledger/预算/reservation
src/watchdog/handoff.ts       摘要+diff+nextStep
src/watchdog/service.ts       hooks/巡检/干预/API
src/watchdog/WatchdogPanel.tsx UI 组件
src/watchdog/watchdog.test.tsx 10 个测试
```

**修改**

```
src/shared/types.ts           ModelPricing/ModelProfile.pricing
src/shared/models.ts          normalize pricing
src/shared/watchdog.ts        shared DTO/API types
src/shared/ipc.ts             DeerApi watchdog methods
src/kernel/execution/kernel.ts hooks/activity/nudge/interrupt/hold/reassign/handoff
src/kernel/execution/eventRegistry.ts run.nudge/run.started handoffId
src/kernel/loop.ts            nudge consumption + per-step usage
src/kernel/service.ts         hooks/activity/heartbeat/model override/handoff prompt/API
electron/main.ts              watchdog IPC handlers
electron/preload.ts           watchdog API
docs/team/watchdog-cost-implementation.md
```

未改：`src/git/`、`src/memory/`、`src/TeamDashboard.tsx`、`dist/`、`dist-electron/`（构建产物未提交）。t157 新增改动：`src/App.tsx`、`src/RunHistory.tsx`、`src/shell/dock/panelRegistry.ts`、`src/styles.css`、`src/kernel/execution/kernel.ts`（retryTaskWithModel/release null）及 shared/service/handoff/store 修复。

---

## 9. 测试矩阵

| 区域 | 覆盖 |
|---|---|
| 信号 | stale/repeat/no-progress/error/token 组合；waiting_human grace 不误判 pause；deadman 2×tick |
| 干预 | stale pause 生成 handoff 且 handoff seq < run.failed；auto=2 禁 nudge/自动动作→human；switch member 新 Run |
| Handoff | 先持久化再 abort；handoff 查询/注入；workspace 隔离；tracked `.env`/`.ssh` 仅 redacted stat，不落 patch/assistant 文本 |
| 成本 | final ledger/Run.costUsd/$3 精确；provisional 单行→final 清理；reservation 参与 spent；价格未知 |
| 预算 | workspace $1 hard 阻止新 Run + budget hold + 不消耗 attempt；多 hold 只释放当前 reason |
| 降级 | 429→provider_quota→fallback 新 Run model override+handoff+冷却 |
| 重建 | kernel.rebuildProjections 后 hold/autoInterventions/handoff 保留；删除 watchdog 表后 rebuild 修复 schema |
| UI | 预算 progressbar/aria-valuenow、critical role=alert、确认/恢复按钮；panelRegistry 默认关闭 + 900/760 断点 |
| 既有回归 | 463 tests（Git/记忆/权限/审批/画布/调度/Poll 等）全绿；合计 483 |

---

## 10. 已知边界/后续

1. **UI 已接线**（t157）：Dock 面板默认关闭、顶部预算条、任务详情告警、RunHistory handoff；App 集成非 e2e 视觉回归，使用静态/组件断言。
2. **价格设置 UI**未接入 SettingsView；当前通过 `ModelProfile.pricing` 或 `watchdog.modelPricing` 设置 map 配置。
3. **fallback 实际模型切换**依赖 fallback 链已配置；默认空，不自动降级。
4. **令牌缓存/推理 token**：当前计入 input/output；provider 未提供缓存明细时 cached 为 0。
5. **provider 429 自动降级已实现**：生成 provider_quota 信号 + 冷却 + fallback 新 Run；链空/auto=2 时只冷却+human alert，不绕过内核策略。
6. **UI 窄窗/reduced-motion**：900/760 断点与 reduced-motion 已加在 `styles.css`；无浏览器视觉回归（vitest 静态断言）。
7. **watchdog 自身 deadman** 为本地 last_tick 检测（单进程限制）；外置 supervisor 属后续。
8. **预算 soft 仅 warning 事件/UI**，不自动暂停（hard 才暂停）。
9. **历史 Run 成本不回填**，UI 标 legacy unknown；ledger 仅新 Run。
10. **测试基线** 483（watchdog 20）；release 默认必须指定 reason，全部释放需 `all=true` 二次确认。

---

## 11. 验证命令

```
pnpm typecheck   # exit 0
pnpm build       # exit 0（js 1,183.45 kB gzip 324.87；css 225.28 kB；electron main 1.4 MB）
pnpm test        # exit 0（37 files / 483 tests）
```

（HEAD 以 PR 提交为准；同步 main 后若 CI 环境变化，以 PR 检查为准。）
