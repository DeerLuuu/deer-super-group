# 看门狗与成本系统设计（t134）

- **任务**：t134 — 设计：看门狗与成本系统（完整 DESIGN §7.4 / §7.6 实现基线）
- **日期**：2026-11-10
- **作者**：sol（系统工程师 · 信息架构）
- **状态**：t141 修订版（落实 t137 findings）；设计提案；仍未修改代码
- **依据**：`DESIGN.md` §7.4、§7.6、§7.2、§9、§10；`docs/team/execution-kernel-design.md`（t67/t76）、`docs/team/execution-kernel-implementation.md`（t68/t83/t90/t94）、`docs/team/git-parallel-design.md`、`docs/team/memory-system-design.md`、当前 `src/kernel/`、`src/git/`、`src/memory/`、`src/RunPanel.tsx`、`src/RunHistory.tsx`、`src/App.tsx`
- **当前基线**：t68 内核（事件/状态机/调度/租约/恢复）已合并；t69 调度 UI、Git 并行、记忆系统已合入 main；PR #2 已合并。本设计在其上增量实现，不重写内核。

---

## 0. 决策摘要（TL;DR）

| 主题 | 决策 |
|---|---|
| 角色 | 看门狗是**观察者 + 控制器**，不拥有 Task/Run 状态；所有状态变更调用内核命令，不直接改内核表 |
| 两层“心跳” | **L1 内核租约**（60s，进程存活/ fencing）；**L2 看门狗活动心跳**（step/tool/assistant/diff 等活动，语义进度）。心跳定时器本身不算进展 |
| 巡检 | 单任务 **5min** 活动检查（warning/nudge）；**10min** 无活动视为卡死；**15min** 全局巡检（循环/无进展/错误连击/成本/配额）；另有 60s 看门狗 tick |
| 信号 | 心跳超时、任务超时、重复工具签名、无文件变更、错误连击、token 燃烧、429/quota、deadman |
| 干预阶梯 | 提醒（nudge，不计自动次数，最多 3 次）→ 暂停+checkpoint（计数）→ 切换 fallback 模型（计数）→ 换成员（计数）→ 人工升级；**每任务最多 2 次自动干预**（计数档），耗尽必须人工 |
| 暂停语义 | 不新增 Task 状态：Task 保持 `queued` + hold 标记 + `nextRunAt` 远未来；工作区级问题同时暂停 scheduler；人工 `releaseHold`/`resume` 恢复 |
| 模型切换 | 先捕获 handoff（摘要+diff stat/patch+下一步），再 abort 旧 Run；新 Run attempt+1、`modelProfileId` 覆盖、`handoffId` 注入；lease/fencing 与 t68/t90/t94 一致 |
| 成本账本 | ModelProfile 增加输入/输出/缓存价格；每个 Run 一条 **final** ledger + 可选 provisional；`Run.costUsd` 为最终值；价格快照随 Run 保存 |
| 预算 | task 总预算 / agent 日预算 / workspace 日预算（可选 global）；软阈值 80% 警告，硬阈值 100% 暂停+hold；默认**不设预算=不限制**，避免迁移后阻塞 |
| 降级链 | 每 Agent/Workspace 有序 `modelProfileId[]`；429/quota 立即冷却当前 provider/model 并切下一个；本轮最多 2 次自动切换 |
| 审计 | 所有信号/干预/暂停/恢复/fallback/成本入账/预算超限写事件 + 查询表；不输出秘密/完整 prompt |
| UI | Dock「看门狗」面板（默认关闭）+ 任务详情告警条 + Run 历史 handoff/fallback 行 + 顶栏预算条 + 设置「看门狗与成本」；ARIA/窄窗/reduced-motion |
| 迁移 | watchdog 独立 `watchdog_schema=1` + 增量表/列；不改主 `user_version`；历史 Run 不回填成本（标记 legacy unknown） |
| 非目标 | 自动修代码/自动合并、云网关计费对账、多用户审批、分布式看门狗、ML 异常检测、UI 重构 |

**不变量（实现与测试必须成立）**

- **INV-1**：看门狗不直接 UPDATE `tasks/runs`；暂停/切换/中止必须走内核命令，事件顺序与内核一致。
- **INV-2**：handoff 必须在旧 Run 被 abort/fence 之前生成并持久化；旧 Run 之后的结果不得覆盖新 Run（`run.result_discarded` 兜底）。
- **INV-3**：成本 ledger 的 final 行每个 Run 最多一条；重复入账幂等；`Run.costUsd` 与 final ledger 一致。
- **INV-4**：预算硬阈值检查在 Run 启动前与每个活动心跳至少各一次；同一 task 不会在超限后悄悄启动新 Run。
- **INV-5**：同一任务自动干预计数只增不减，达到 2 后只能人工恢复；提醒不计入但最多 3 次。
- **INV-6**：429/quota 不在同一 provider/model 原样重试；切换必须记录 from/to/冷却。
- **INV-7**：所有阈值、预算、价格均来自持久设置或默认值；测试可用 fake clock 确定性复现。
- **INV-8**：看门狗自身 tick 写入 `watchdog_state.last_tick_at`；超过 2×巡检间隔未更新 → deadman 告警（启动/下一次 tick 检测）。
- **INV-9**：事件是审计事实源；watchdog/cost 查询表是 **durable cache**，不承诺完整事件重放（t157 降级）；表可做 schema 修复/校验，但不得出现“有事件无记录”的静默丢失而不告警。
- **INV-10**：不读取/不记录敏感文件内容；handoff diff 走 Git 只读命令 + 敏感路径过滤，凭据永不入事件。

---

## 1. 目标、非目标与术语

### 1.1 目标

1. **兜底可靠性**：卡死、循环、无进展、错误连击、配额错误、token 燃烧在造成不可逆损失前被发现并处理。
2. **可干预**：提醒→暂停→fallback→换成员→人工的阶梯可控、可审计、可恢复；每任务最多 2 次自动干预。
3. **交接不丢上下文**：模型/成员切换前生成摘要 + diff + 下一步，新 Run 可继续；abort/lease/fencing 与内核完全一致。
4. **成本可见/可控**：模型价格、Run 记账、任务/成员/日预算、超限暂停、降级链；预算事件可审计。
5. **UI 可操作**：看门狗面板、任务详情告警、Run handoff/fallback、预算条；键盘/ARIA/窄窗。
6. **可测试**：fake clock、故障注入、预算边界、无进展/循环、人工升级；与内核心跳/租约事件契约确定。
7. **实现基线**：完整（非 MVP）设计，含文件级影响、迁移、阶段、AC、非目标与风险。

### 1.2 非目标（显式）

| 非目标 | 说明 |
|---|---|
| 自动修复代码 / 自动合并 PR | 看门狗只暂停/切换/升级；不替 Agent 改代码，不进入 Git 合并队列 |
| 云网关/供应商账单对账 | 只按 profile 价格和 token 估算，不做发票级对账、汇率换算 |
| 自动发现/抓取供应商价格 | 价格由设置/模型 profile 配置；P2 可接价格目录 |
| 多用户预算审批/RBAC | 单用户本地应用；审批属于后续多用户系统 |
| 自动修改权限/审批策略 | 看门狗不改变 `permission`、不批准高风险工具 |
| 分布式/多进程看门狗 | 单主进程；deadman 只做本地检测 |
| ML/统计异常检测 | 规则 + 滑动窗口 + 阈值；不做模型训练 |
| UI 重构/新顶层导航 | 只增 Dock「看门狗」面板、告警条、预算条、设置区 |
| 自动裁决 review/merge | review/merge 仍由人/现有门禁 |
| 历史 Run 精确重算成本 | 迁移后旧 Run 标记 `legacy_unknown`，不回溯改写 |

### 1.3 术语

- **活动事件（activity）**：step、tool_call、tool_result、assistant、diff、checkpoint、summary 等语义事件；区别于 L1 heartbeat。
- **L1 heartbeat**：内核 `heartbeatAt/leaseExpiresAt`，用于进程存活和 fencing，60s TTL；**不作为进展**。
- **L2 activity heartbeat**：看门狗记录的最后有意义活动时间。
- **Nudge**：向当前 Run 注入一条提醒/纠偏系统消息，不改变状态。
- **Hold**：Task 仍 `queued` 但被看门狗/预算挂起，调度器不启动；人工释放。
- **Handoff**：切换前持久化的上下文包（摘要、diff、下一步、模型/成员信息）。
- **Ledger**：成本账本；final 行是 Run 的最终成本；provisional 单行是 active Run 的估算，参与 `spentForBudget` 的 active 项，final 入账后去重。
- **Fallback chain**：模型降级顺序。
- **Deadman**：看门狗自身停止心跳的检测。

---

## 2. 现状审计（HEAD 实读）

### 2.1 已有能力（可复用）

| 能力 | 现状 | 复用方式 |
|---|---|---|
| 内核生命周期 | `ExecutionKernel`：Run started/heartbeat/checkpoint/waiting/resumed/completed/failed/cancelled；lease 60s；watchdog 本地租约；`run.result_discarded`（t90/t94） | 看门狗通过命令/事件接入，不重复实现生命周期 |
| 事件存储 | EventV2、seq、幂等、zod 注册（t83）、分页重建 | watchdog/cost 事件入同一事件日志；新增独立 registry |
| 调度/暂停 | `pauseScheduler/resumeScheduler`、`getScheduler`；queued hold 可用 `nextRunAt` | 暂停/恢复复用；hold 新增内核命令 |
| Run 字段 | `tokenIn/tokenOut/costUsd/heartbeatAt/lease*/checkpoint*/modelProfileId/sandboxId` | costUsd 目前恒 0；账本补齐 |
| Hook | `KernelHooks.beforeStart/onRunFinished`；Git `beforeStart` 已注入 | 增加 activity/heartbeat 观察 hook + 预算 beforeStart 组合 |
| 执行器 | `AppService.executeRunCore`：循环 step、工具审批、15s 心跳、summary | 增加 usage/activity 上报、handoff 注入、model override |
| Git | `GitService.beforeStart/finalizeRun`、worktree/branch/PR、diff 只读、fencing | handoff diff、切换前后 worktree 释放；不绕过 Git lease |
| 记忆 | `TaskSummary`（changes/files/tests/decisions/risks/openQuestions）、summaries 查询 | handoff 复用 summary；不重复生成 |
| UI | t69 `RunPanel/RunHistory`、任务详情、scheduler 栏、Dock panel registry、SettingsView | 增量加 watchdog 面板/告警/预算/fallback 行 |
| 审批 | t58 高风险审批、waiting_human、一次性 requestId | 429/预算/危险操作不批准；只告警/暂停 |

### 2.2 缺口（本设计补齐）

| 缺口 | 说明 |
|---|---|
| W1 信号引擎 | 无活动/循环/无进展/错误连击/token 速率/配额检测 |
| W2 干预编排 | 无暂停 hold、fallback、换成员、人工升级与计数 |
| W3 交接 | 无 handoff artifact/diff/下一步/新 Run 注入 |
| W4 成本 | ModelProfile 无价格；Run.costUsd 恒 0；无 ledger |
| W5 预算 | 无 task/agent/day 预算与超限暂停 |
| W6 降级链 | 无 fallback 配置/冷却/审计 |
| W7 UI/API | 无 watchdog 快照/告警/干预/预算条/面板 |
| W8 deadman | 无看门狗自监控 |
| W9 测试 | 无 fake clock/故障注入/预算边界/循环/升级测试 |

### 2.3 与内核的关键边界

- 内核负责 **Run 生命周期、lease、fencing、终止状态**；看门狗只做决策与调用命令。
- 内核 L1 watchdog 在 **60s** 无租约心跳时 abort/fail（已有）；看门狗 L2 的 5/10/15min 是**语义活动**，不是替代 L1。
- 内核 `Run.status` 已有 `waiting_human`；看门狗暂停不新增 Run 状态，使用 Task hold + scheduler pause。
- 内核 `Task.status` 保持 8 态；hold 是调度属性，不是第 9 态；释放后从 `queued` 启动，避免状态机变更。

---

## 3. 架构

### 3.1 进程与组件

```
Electron main
  AppService
    Store (SQLite event log + kernel tables)
    ExecutionKernel  ← commands/events/hooks
    GitService       ← worktree/diff/fencing
    MemoryRuntime    ← TaskSummary
    WatchdogService  ← 本设计
      SignalDetector (pure)
      InterventionController
      HandoffBuilder
      CostService / BudgetService
      WatchdogStore (watchdog_schema 表)
      PatrolLoop (60s tick / 5min task / 15min full)
    CostLedger (watchdog store)
    watchdog event listener ← Store.onEvent（COMMIT 后）
```

**依赖方向**：`WatchdogService → {Store, ExecutionKernel 命令, GitService 只读, MemoryRuntime 只读}`；内核**不**依赖 WatchdogService（仅通过 hooks 回调，可空）；UI 只经 IPC 查询/命令。

### 3.2 启动顺序

1. `Store` 迁移（kernel v2 已完成，watchdog_schema 增量）。
2. `GitService`/`MemoryRuntime` 构造。
3. `ExecutionKernel` 构造（恢复租约/孤儿；t68/t94）。
4. `WatchdogService` 构造：
   - 加载设置/价格/预算/fallback；
   - 检查 deadman（上次 tick 间隔）；
   - 订阅 `Store.onEvent`（COMMIT 后）；
   - 启动 60s 定时器（`.unref()`）；首次延迟 1s；
   - 不阻塞主进程启动。
5. UI 首次 `getWatchdogSnapshot`；事件刷新。

关闭：`WatchdogService.close()` 清定时器/取消订阅；不 abort Run（由内核关闭流程负责），但写 `watchdog.stopped` 审计。

### 3.3 事件流（正常）

```
kernel run.step/tool/assistant（service 上报 activity）
  → WatchdogService.recordActivity（内存/投影）
  → detector 评估（增量 + 5min/15min 扫描）
  → 命中：watchdog.signal 事件 + alert 投影
  → 阶梯决策：
      nudge → kernel.injectNudge(runId,...)
      pause → HandoffBuilder → kernel.interruptRun(...)
      fallback → HandoffBuilder → kernel.interruptRun+new Run model override
      member → HandoffBuilder → kernel.reassign+interrupt
      human → hold + scheduler pause + critical alert
  → kernel 执行 abort/fail/queued/nextRunAt；lease/fencing 保证旧 Run 不写
  → UI 事件刷新
```

### 3.4 时钟分层

| 时钟 | 默认 | 用途 | 数据源 |
|---|---|---|---|
| L1 lease | 60s | 进程存活/fencing；超时 abort+fail(LEASE_EXPIRED) | 内核 `leaseExpiresAt/heartbeatAt` |
| Watchdog tick | 60s | 增量检测、deadman 更新、预算检查 | `clock.now()` |
| 单任务活动检查 | 5min | 无有意义活动 → 警告/nudge；10min → 暂停 | 最后 activity 时间 |
| 全局巡检 | 15min | 全量循环/无进展/错误/成本/配额 | 事件+投影 |
| Provider 冷却 | 5min 或 resetAt | 429/quota 后不再选该 provider/model | provider 错误事件 |
| 日预算周期 | 本地 00:00 | 日预算重置/查询 | `period_day`（本地时区） |

**关键澄清**：Service 的 15s `heartbeat()` 只续 lease，不刷新 L2 activity；否则卡死 executor 会被误认为活跃。L2 只认 `activity` 事件（step/tool/assistant/diff/summary）。

---

## 4. 检测信号

### 4.1 信号目录

| 信号 | 默认阈值 | 证据 | 阶梯起点 |
|---|---|---|---|
| `heartbeat_stale` | 10min 无 activity（L2）；L1 60s 由内核处理 | 最后 activity、run.started、事件 seq | pause（可先 nudge） |
| `task_timeout` | 5min 无 activity 检查；10min 硬超时（`waiting_human` 除外，见 §11.4） | 同上 | nudge→pause |
| `repeat_tool` | 同签名 ≥3 次/10min，或同文件写 ≥4 次且无 diff | tool_call 参数 hash、diff | nudge→pause |
| `no_progress` | ≥3 步或 8min 无写/commit/diff/task.complete | activity + Git diff/文件事件 | nudge→pause |
| `error_streak` | 连续 3 次工具/模型失败 | tool.result ok=false、run.failed | fallback→member |
| `token_burn` | >120k tokens/5min 或预计成本 >剩余预算 50% | heartbeat token、ledger | nudge/警告；硬预算 pause |
| `provider_quota` | 429 / insufficient_quota / code 1308 | provider 错误事件 | fallback（跳过 nudge/pause） |
| `budget_soft` | 任务/成员/日预算 ≥80% | ledger | info/warn 告警 |
| `budget_hard` | ≥100% | ledger + 预检查 | pause/hold + 人工 |
| `deadman` | last_tick 超过 2×tick（默认 2min） | watchdog_state | critical |
| `watchdog_loop` | 同一 alert 重复触发/无状态变化 | intervention 历史 | 直接 human |

### 4.2 活动模型

```ts
type ActivityKind =
  | "run.started" | "step" | "tool_call" | "tool_result"
  | "assistant" | "diff" | "checkpoint" | "summary" | "waiting_human";

interface RunActivity {
  runId: string;
  taskId: string;
  agentId: string;
  kind: ActivityKind;
  at: string;
  seq: number;           // 内核事件 seq（若有）
  toolName?: string;
  toolSignature?: string; // 规范化 name+args hash
  ok?: boolean;
  progress?: boolean;     // 写/commit/diff/task.complete
  tokenIn?: number;
  tokenOut?: number;
  modelProfileId?: string;
}
```

- 由 `RunExecutionContext.activity(kind,payload)` 上报；内核 `KernelHooks.onRunActivity` 转发（同步、<1ms，只入内存队列/轻表）。
- `heartbeat` 只用于 L1 与 token 速率采样；不能刷新 activity。
- 事件监听器仍从 `run.*`/`tool.*` 补充（防止 executor 未及时上报）；以 `seq` 去重。

### 4.3 循环/重复签名算法

```
signature = sha1(normalizedToolName + ":" + stableStringify(args, truncate 2KB))
window = 10min
if count(signature) >= 3 && no progress since first occurrence:
   repeat_tool
if writesToSameFile >= 4 && diff unchanged:
   repeat_tool(file=...)
```

- 参数规范化：路径相对 workspace、去掉时间戳/随机 id、截断长文本；不记录敏感参数（值 hash/长度）。
- 仅统计 **agent 工具调用**；用户手动操作/看门狗命令不计。
- N 可按 agent/workspace 配置；默认 3。

### 4.4 无进展

- progress 定义：成功 `fs.write/fs.edit`、`shell` 写入、Git commit、diff 变化、`task.complete`、`summary` 保存、`run.checkpoint`（含实质 step）。
- 连续 3 个 `run.step` 或 8min 无 progress → `no_progress` warning；15min 仍无 → pause。
- 若 Git diff 不可用（非 Git 工作区），用工具事件 + 文件 mtime 采样（只读 stat，不读内容）。

### 4.5 错误连击与 429/quota

- 归一化错误：`PROVIDER_QUOTA`（429/insufficient_quota/code 1308）、`PROVIDER_AUTH`、`PROVIDER_NETWORK`、`TOOL_TRANSIENT`、`TOOL_DENIED`、`INTERNAL`。
- 连续 3 次非 `TOOL_DENIED` 失败 → fallback；`TOOL_DENIED` 不切换模型（需要权限/人）。
- 429：记录 `provider, model, resetAt`（从响应头或默认 5min），当前 provider/model 冷却；立即 fallback；若链空 → human。
- 同一 provider 连续 2 次 429 → 整个 provider 冷却（不按 model 逐个撞）。

### 4.6 token 燃烧

- 采样 heartbeat 的 tokenIn/out 与最终 ledger；窗口 5min，阈值 `watchdog.tokenBurnPer5m` 默认 120k。
- 预计 Run 成本 = 当前 token × 价格 + 剩余 maxOutput 估算；> task 剩余预算 50% → warning；hard 由预算服务处理。
- 不使用 token 速率直接 fail；先 nudge/pause。

### 4.7 巡检调度

- `PatrolLoop`：
  - 每 60s：检查 active runs 的 5min 检查点、deadman、预算 soft/hard、provider 冷却；
  - 每 15min：全量扫描 active/queued/recent（循环、错误连击、无进展、跨任务成本）；
  - 启动时：一次全量 + deadman；
  - 事件触发：`run.started/heartbeat/failed`、`provider.error`、`cost.recorded` 增量评估（合并 250ms 防抖）。
- `clock` 注入；测试手动 `service.tick(now)`/`patrol(now)`，不依赖真实定时器。
- 单飞：`ticking` 标志；上一个 tick 未结束则合并下一次。
- 线程/主进程阻塞：定时器延迟检测；`last_tick_at` 写入 SQLite，deadman 以“实际 tick 间隔 / 事件循环延迟”判断。

### 4.8 deadman switch

- `watchdog_state.last_tick_at` 每 tick 更新（同事务写 `watchdog.tick` 事件节流）。
- 启动时：若存在 active Run 且 `now - last_tick_at > 2×patrolInterval` → `watchdog.deadman` critical + 暂停 scheduler + 告警；不自动杀 Run（留给内核 lease）。
- 运行中：renderer 每 30s 调 `getWatchdogHealth`；若 IPC 超时/`lastTickAt` 过旧，显示“看门狗无响应”横幅；主进程恢复后自动清理 stale 状态。
- 看门狗不能监控自己的完全冻结（同进程限制）；**限制写入文档**，P2 可外置 supervisor。

---

## 5. 干预阶梯

### 5.1 阶梯

| 级别 | 动作 | 计数 | 默认触发 | 恢复 |
|---|---|---|---|---|
| L0 | observe/record | 否 | 所有信号 | 自动 |
| L1 | nudge（注入提醒） | 否（最多 3 次/任务） | 5min 无活动、轻度循环、token 预警 | 自动；有进展即停 |
| L2 | pause + checkpoint + hold | **是（+1）** | 10min 无活动、循环持续、无进展、预算 hard | 人工 `releaseHold`/`resume` |
| L3 | fallback model | **是（+1）** | 429/quota、错误连击、L2 后仍无进展 | 新 Run 自动继续；失败则升级 |
| L4 | switch member | **是（+1）** | L3 无可用模型/仍失败、成员能力/权限问题 | 新 Run；失败则人工 |
| L5 | human escalation | 终止自动 | 自动次数≥2、所有 fallback 失败、危险/权限、deadman | 人工处理 |

- **自动干预计数**：L2/L3/L4 每执行一次 `autoInterventions++`；达到 **2** 后**禁止 nudge 与 L2/L3/L4**，任何新信号只产生 critical alert + human，不再自动动作。L1 单独计数（最多 3），不计入 2，但仅在 `autoInterventions < 2` 时可用（F4）。
- 阶梯不要求逐级走完；信号直接匹配 L3/L4（如 429）可跳级，但仍计数。
- 同一任务同一信号 15min 内去重；同一任务多信号合并为一个 intervention 计划，避免叠加。

### 5.2 动作定义

#### L1 nudge

- 内核命令：`injectNudge(runId, text)`（新增；写入 Run 事件/队列，下一次 LLM 调用前注入 system/user 提醒）。
- 内容模板：指出信号（重复工具/无进展/预算），要求“先总结当前状态与下一步，再做一次最小进展”；不包含敏感数据。
- 频率：同 Run 每 5min 最多 1 次，每任务最多 3 次；若期间出现 progress，计数不增加/提前停止。
- 审计：`watchdog.nudged {runId,taskId,signal,attempt}`。

#### L2 pause + checkpoint + hold

- 步骤（严格顺序）：
  1. `HandoffBuilder.build(runId, reason)`（只读事件/Git diff/summary）→ 持久化 handoff；
  2. `kernel.interruptRun(runId, {code:"WATCHDOG_PAUSED", retryable:true, handoffId, retryDelayMs: holdMs})`：
     - CAS `lease_owner + active status`；abort controller；`failRun` 写 `run.failed(WATCHDOG_PAUSED)`；
     - Task `running → queued`（内核现有重试路径），设置 `nextRunAt=now+hold`；
     - 写 `watchdog.paused` + `kernel.*` 事件；**hold reason/scope 只写 `watchdog_holds`，不新增/写入 kernel task 列**；
  3. 若 workspace 级（预算/多任务循环）：`kernel.pauseScheduler(workspaceId, "watchdog")`；
  4. `WatchdogService.holdTask` → `watchdog_holds(taskId, reason='watchdog', scope='task')` + critical/warning alert；hold 表是唯一原因源；
  5. 旧 executor 后续结果由 lease/fencing/`result_discarded` 丢弃；不得覆盖。
- checkpoint：内核 `checkpoint` 回调在 abort 前由执行器写；若来不及，handoff 里的 lastEventSeq + diff 仍可用；UI 显示“checkpoint 可能不完整”。
- 释放：人工在面板点“恢复任务” → 只删除当前 reason 的 `watchdog_holds` 行；若没有其他 active hold，再 `kernel.releaseTaskHold(taskId)` 清 `nextRunAt`；否则保持 queued/nextRunAt；写 `watchdog.resumed`。不自动重试直到人确认（预算/循环）。
- Task 详情展示 hold 时按优先级 `escalation > budget > watchdog` 派生文本；**该优先级只用于展示，不写 kernel task 列**（F3）。

#### L3 fallback model

- 选链：workspace/agent fallback chain 中跳过冷却/不可用/同模型；要求目标 model profile 存在、provider 可用。
- 顺序：
  1. HandoffBuilder.build（reason=`fallback`）；
  2. `kernel.interruptRun(runId, {code:"WATCHDOG_MODEL_SWITCH", retryable:true, handoffId, nextModelProfileId})`；
  3. Task queued（attempt+1），下一次 `startRun` 使用 `modelProfileId` override；executor 读取 `run.modelProfileId ?? agent.model`；system prompt 注入 handoff；
  4. 写 `run.model_fallback {from,to,provider,reason,handoffId}` + alert info。
- 不允许在同一 Run 内改 model 字段（Run 快照不可变）；新 Run 是唯一方式。
- 若新模型也失败：按 fallback chain 下一项（计入自动次数；最多 2 次）；全部失败 → L5。

#### L4 switch member

- 选成员：同 workspace、非 Router、offline 排除、权限满足、无活跃 Run、能力标签可选（P1）。
- 顺序：handoff → `kernel.reassignTask(taskId,nextAgentId,{reason})` + `interruptRun`（或先 interrupt 再 reassign，在一条命令事务内）；
- 新 Run 由新 owner 执行；旧成员不保留活跃 Run；handoff model 可保持不变；写 `watchdog.member_switched`。
- 换成员不绕过 Git lease/worktree；旧 worktree 由 Git finalize/新 Run beforeStart 处理；handoff 的 diff 已捕获。

#### L5 human escalation

- 条件：`autoInterventions >= 2`、fallback 链耗尽、quota 全 provider、deadman、危险权限/审批、重复同一干预无效果。
- 动作：`pauseScheduler(workspace, "watchdog")` + task hold + `watchdog.escalated` critical + UI 顶部/任务详情横幅 + 系统通知（可选）。
- 不得自动恢复；人工必须：
  - `ackAlert`（确认）→ `releaseHold` / 调整预算/模型 → `resumeScheduler`；
  - 或 `cancelTask`。
- 审计保留完整证据链：signal → intervention(s) → handoff → escalation → human action。

### 5.3 自动计数与重置

- 存 **watchdog 自有表** `watchdog_task_state`（auto_interventions/nudge_count）与 `watchdog_interventions`；以 `watchdog.*` 事件为准，表是投影；**不写 kernel task 列**，kernel rebuild 不会重置计数。
- 新 Task =0；**人工恢复/重置**可归零（默认“恢复并重置”需显式选择，避免循环任务无限自动）；不因普通 retry/done 自动归零。
- L1 nudge 计数独立 `nudge_count`，最多 3；仅在 `autoInterventions < 2` 时可用；达到 2 后 nudge 也禁止（F4）。
- 同一任务并发信号只允许一个进行中的 intervention；用 `watchdog_interventions.status=in_progress` 唯一约束防叠加。

---

## 6. 交接与模型/成员切换

### 6.1 Handoff 记录

```ts
interface RunHandoff {
  id: string;                 // hof_...
  workspaceId: string;
  taskId: string;
  runId: string;              // 旧 Run
  attempt: number;
  reason: "pause" | "fallback" | "member_switch" | "manual";
  summary: string;            // 结构化摘要，<=2k chars
  nextStep: string;           // 下一步，<=500 chars
  files: string[];            // 变更文件（相对路径，<=50）
  diffStat: string;           // git diff --stat，<=8KB
  diffRef: string | null;     // userData/handoffs/<id>.patch（完整 patch；DB 只存引用）
  lastEventSeq: number;
  fromModelProfileId: string | null;
  toModelProfileId: string | null;
  fromAgentId: string;
  toAgentId: string | null;
  createdAt: string;
  expiresAt: string | null;   // 默认 7 天清理
}
```

- 存储：`run_handoffs` 表（摘要/引用）+ `userData/handoffs/<id>.patch`（diff 全文，权限 0600；敏感路径已过滤）。
- 事件：`run.handoff_created {handoffId,runId,taskId,reason,files,diffStatHash}`；不写完整 diff。
- 大小限制：patch ≤256KB；超过记录“diff 过大，见 Git 分支”+ stat。

### 6.2 生成算法

```
build(runId, reason):
  run/task/agent = store
  events = listEventsForTask(taskId)（最近 200 条）
  summary = memory.latestSummary(taskId)（若有）
  git = GitService.getTaskVcs(taskId)/worktree
  diff:
    cwd = run.sandboxId startsWith "git:" ? slice : workspace.path
    if git repo: git diff --stat + git diff --name-status + git diff --unified=3
    else: tool 事件中的写文件 + mtime 变化（不读内容）
  files = 变更文件（cap 50，过滤敏感路径）
  summaryText = 结构化：
    - goal/acceptance
    - 已完成（summary.changes/files/tests）
    - 当前错误/信号
    - diff stat
    - 下一步（从最后 tool/assistant/下一步模板推导）
  nextStep = 明确单步动作（不写“继续”）
  persist + event
```

- **不调用当前模型**生成摘要（可能卡死/烧钱）；P1 可选“模型自摘要”，但必须先有确定性 fallback。
- 失败容错：Git diff 失败 → stat 空 + 文件列表来自事件；summary 缺失 → 从任务/事件构造；handoff 失败 → 不允许切换，转 human（避免丢上下文）。
- 隐私：过滤 `permission.isSensitivePath`；不读 `.env/.ssh/...`；事件不含密钥；diff 中疑似 token 用 `[REDACTED]` 替换。

### 6.3 新 Run 注入

- 新 Run 的 system prompt 增加：
  ```
  ## HANDOFF (watchdog)
  Previous run: ...; reason: ...
  Goal/acceptance: ...
  Completed: ...
  Files/diff stat: ...
  Next step: ...
  Rules: continue from next step; verify before editing; do not repeat finished work.
  ```
- Token 上限：handoff 段 ≤1500 tokens；超出用摘要+diff 引用（模型可 `fs.read` worktree 文件，但需权限）。
- 新 Run `handoffId`/`fallbackFromRunId` **只写入 `run.started` 事件 payload**（供投影/UI/审计查询），不新增 kernel run 列；RunDetail 从事件与 `run_handoffs` 关联读取。

### 6.4 abort / lease / fencing 一致性

- 切换前必须：
  1. handoff 持久化；
  2. 确认当前 Run 仍是 active 且由当前内核实例持有（watchdog 不持有 lease；通过 `interruptRun` 内核命令校验 `lease_owner`，不要在 watchdog 侧硬编码 owner）；
  3. 内核 `interruptRun` CAS `lease_owner + status` 成功；否则写 `run.result_discarded` 并放弃本次切换（不抢租约）。
- abort 后旧 executor：
  - 若有结果写入 → `completeRun/failRun` CAS 失败 → `run.result_discarded`（t90/t94）；
  - Git finalize 旧 Run 使用 Git lease/fencing，不允许旧 owner 覆盖；
  - 新 Run attempt+1；旧 handoff 只读。
- 不直接 `controller.abort()` 从 watchdog 侧绕过内核；统一走 `interruptRun`，确保事件/投影/activeRuns 清理一致。
- 与 `kernel.recover`/租约：若切换时旧 Run 已经过期/被恢复，Watchdog 读到的 active 状态失效 → 取消本次干预，记录 `watchdog.intervention_skipped {reason:"stale_run"}`。

---

## 7. 成本账本

### 7.1 价格模型

- `ModelProfile` 增加（可选、向后兼容）：

```ts
interface ModelPricing {
  currency: "USD";
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
  reasoningPer1M?: number;
  source: "manual" | "catalog";
  version: string; // 价格版本（内容 hash/日期）
}
// ModelProfile.pricing?: ModelPricing | null
```

- 未配置价格：`pricing=null`，成本记为 **unknown**（ledger `cost_usd=0, pricing_known=false`）；不阻塞预算（默认），UI 提示“未配置价格，预算不生效（可配置严格模式）”。
- 价格是 **快照**：Run 开始时把 `pricing` 写入 `price_snapshot`；同一 Run 内价格变更不追溯（下一 Run 用新价）。
- 计费：
  ```
  cost = tokenIn/1e6 * inputPrice
       + tokenOut/1e6 * outputPrice
       + cachedInput/1e6 * cachedInputPrice (若 provider 返回缓存)
  ```
- 精度：内部整数 micro-USD（1e-6 USD）避免浮点误差；展示 4 位小数；DB 存 REAL + micro 字段（或整数 micro）。
- 汇率：仅 USD；不做换算。
- Full Throttle：提高 maxOutput/steps，不改变价格；预算仍生效。

### 7.2 Ledger

```ts
interface CostLedgerEntry {
  id: string;
  workspaceId: string;
  taskId: string;
  runId: string;
  agentId: string;
  modelProfileId: string | null;
  modelId: string | null;
  providerId: string | null;
  priceSnapshot: ModelPricing | null;
  pricingKnown: boolean;
  tokenIn: number;
  tokenOut: number;
  cachedTokenIn: number;
  costMicroUsd: number;
  costUsd: number;
  kind: "provisional" | "final" | "adjustment";
  periodDay: string;      // local YYYY-MM-DD
  createdAt: string;
  metadata?: Record<string, unknown>;
}
```

- 唯一约束：`(run_id, kind)`；**每个 Run 至多一条 provisional（heartbeat 原位更新）、一条 final**；adjustment 仅 P2 且需独立 idempotencyKey。
- 写入时机：
  - **provisional**：heartbeat 每 ≥30s 计算当前累计成本（token 来自 service activity/heartbeat），原位 upsert 单行；仅用于 UI 与 `spentForBudget` 的 active 部分。
  - **final**：监听 `run.completed/failed/cancelled` 事件（COMMIT 后）读取 Run 最终 token/price snapshot；在**同一 `Store.withTransaction`** 内 upsert final ledger、更新 `runs.cost_usd`、追加 `cost.recorded`（幂等键 `cost:{runId}:final`）。启动/关闭时对“终态 Run 无 final ledger”做一次 reconciliation 重试；不允许事件有而账本无。
  - **adjustment**：人工修正/供应商对账补差（P2），不参与 final 唯一行。
- 幂等：final 以 `run_id+kind` 唯一；重复事件返回已有行；`cost.recorded` 事件 idempotencyKey `cost:{runId}:final`。
- 汇总：
  - Task 展示成本 = 该 task 所有 final 成本（含被取消/失败 Run）；
  - Agent 日成本 / Workspace 日成本 = 当日 final；
  - **`spentForBudget` = final + active provisional + reservation**；final 入账后从 provisional 项移除，避免同一 token 双计；provisional 不是 final，但参与 active 预算检查（F2）。
  - 预算查询与活动检查统一使用 `spentForBudget`，不得仅用 final；`reservation` 公式见 §8.2。
- 历史 Run：迁移后无 ledger；`runs.cost_usd` 保持 0，UI 标 `legacy_unknown`；不回溯按当前价重算（避免伪造历史）。
- 失败/取消：失败 Run 也计费（已消耗 token）；取消同理；未产生 usage 记 0。

### 7.3 事件

| 事件 | payload |
|---|---|
| `cost.recorded` | runId/taskId/agentId/model/costUsd/micro/kind/priceVersion |
| `cost.provisional` | runId/tokens/estimate（节流） |
| `cost.budget_warning` | scope/spent/limit/ratio |
| `cost.budget_exceeded` | scope/spent/limit/ratio/action |
| `cost.budget_hold` / `cost.budget_released` | task/scope/reason |
| `cost.price_changed` | profile/version/old/new（审计） |
| `provider.quota_error` | provider/model/code/resetAt |
| `provider.cooldown_started/ended` | provider/resetAt |

事件 schemaVersion=2，watchdog 自有 zod registry（见 §10.3）；不写入内核 `KERNEL_EVENT_TYPES` 的强 schema（避免内核耦合），但同一事件表/seq。

### 7.4 模型降级链

```ts
interface FallbackChain {
  workspaceId: string;
  agentId: string | null; // null=workspace 默认
  models: string[];       // modelProfileId 有序
  maxSwitches: number;    // 默认 2
  onQuota: boolean;       // 429 自动
  onErrors: boolean;
}
```

- 解析顺序：agent 链 > workspace 链 > 空（不降级）。
- 选择：跳过当前 model、**同时命中 `(provider,model)` 与 `(provider,'*')` 两级冷却**、不存在的 profile、provider disabled；保留权限不变。
- 冷却：`provider_cooldowns(provider, model, until, reason)`；429 默认 5min 或 resetAt；同日多次 429 指数退避（5/10/20min，上限 1h）；**provider 级 429 写 `model='*'`，model 级写具体 model；选择/清理/过期必须同时处理两级**；过期行由 patrol 清理（F7）。
- 降级记录：`run.model_fallback` + intervention；UI Run 历史显示“fallback from X → Y（原因）”。
- Router/评审模型：不在本系统自动改；只对执行 Worker Run 生效；后续可配置角色链。

---

## 8. 预算

### 8.1 范围与默认

| 范围 | 默认 | 设置键 | 作用 |
|---|---|---|---|
| Task 总预算 | 未设置（不限） | `budget.taskUsd` 或按 task | 单任务所有 Run |
| Agent 日预算 | 未设置 | `budget.agentDailyUsd`（per agent 可覆盖） | 成员当天 |
| Workspace 日预算 | 未设置 | `budget.workspaceDailyUsd` | 工作区当天 |
| Global 日预算 | 未设置 | `budget.globalDailyUsd`（P1） | 全应用 |
| Soft ratio | 0.8 | `budget.softRatio` | 警告 |
| Hard action | pause | `budget.hardAction = pause|stop` | 暂停 hold / 直接失败 |

- 预算 0/空 = 不限制；迁移默认不阻塞。团队可按需启用。
- 日周期：本地时区 `YYYY-MM-DD`；用 `periodKey(now)` 查询；跨日首次使用写 `cost.budget_period_reset`（可选）。
- 预算严格模式 `budget.strict`：价格未知时是否阻止（默认 false）。

### 8.2 检查点

1. **Run 启动前**：`KernelHooks.beforeStart` 组合 Git admission + BudgetService：
   - `spentForBudget = final + active provisional + reservation`（见下）；`reservation` 包含现有 active Run 的剩余输出预留 + 本次待启动 Run 的预留；
   - `reservationForRun = max(0, maxOutputTokens - tokenOut) × outputPrice / 1e6`（micro-USD；价格未知时 non-strict 记 0；`budget.strict=true` 时 prestart deny/人工）；
   - `spentForBudget >= limit` → deny；任务保持 queued；`budgetHold`（nextRunAt 远未来 + `watchdog_holds`）+ `cost.budget_exceeded` + alert；不创建 Run、不消耗 attempt；
   - `spentForBudget >= soft` → warning（不阻止）。
2. **活动心跳**（每 ≥30s / 每 step）：BudgetService 用同一 `spentForBudget`（final + active provisional + 剩余 reservation）检查；hard → L2 pause；soft → warning；final 入账后从 active 项移除，避免双计。
3. **Run 结束**：final ledger 入账（与 `runs.cost_usd`/`cost.recorded` 同事务）；若超 hard，后续启动被预检查拦截。
4. **人工调整预算**：`setBudget` 写 `cost.budget_changed`；可 `releaseHold`。

### 8.3 超限动作

- Task 预算 hard：暂停该 task（hold，不改变其它任务）；写 critical alert；人工提高预算或取消。
- Agent/Workspace/Global 日预算 hard：暂停 **workspace scheduler** + 当前运行 Run（L2 pause）；hold 相关 queued tasks；人工提高预算/等次日 → resume。
- `hardAction=stop`：Run 失败 `BUDGET_EXHAUSTED`（不可重试），Task failed；用于严格团队策略；默认 pause。
- 不允许自动“先花超再暂停”；启动前拦截优先；Run 内一步可能少量超调（记录，提示）。

### 8.4 预算事件/审计

- 每次 warning/hard 只写一次 per scope+period+level（去重）；恢复/调整写事件。
- UI 预算条显示 `spent/limit`（当日/任务），超 soft 黄色、hard 红色；`role=progressbar`。
- 账本与预算查询不依赖 UI 状态。

---

## 9. 数据模型与迁移

> 表放在主 `deer.db`（与事件/Run 同库，便于跨表查询），但由 `WatchdogStore` 管理；`watchdog_schema` 独立版本，**不修改内核 `user_version`**。

### 9.1 DDL

```sql
CREATE TABLE IF NOT EXISTS watchdog_schema (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchdog_state (
  workspace_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_tick_at TEXT,
  last_patrol_at TEXT,
  deadman_at TEXT,
  paused_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchdog_alerts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,          -- info|warning|critical
  status TEXT NOT NULL DEFAULT 'open', -- open|acked|resolved
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acked_at TEXT,
  resolved_at TEXT,
  actor TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_watchdog_alert_open
  ON watchdog_alerts(dedupe_key) WHERE status='open';

CREATE TABLE IF NOT EXISTS watchdog_interventions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  level TEXT NOT NULL,             -- nudge|pause|fallback|member|human
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  auto_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'started', -- started|applied|skipped|failed
  handoff_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_watchdog_intervention_active
  ON watchdog_interventions(task_id) WHERE status='started';

CREATE TABLE IF NOT EXISTS watchdog_task_state (
  workspace_id TEXT NOT NULL,
  task_id TEXT PRIMARY KEY,
  auto_interventions INTEGER NOT NULL DEFAULT 0,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchdog_holds (
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  reason TEXT NOT NULL,            -- watchdog|budget|escalation
  scope TEXT NOT NULL,             -- task|agent|workspace|global
  created_at TEXT NOT NULL,
  released_at TEXT,
  released_by TEXT,
  PRIMARY KEY(task_id, reason, scope)
);
CREATE INDEX IF NOT EXISTS idx_watchdog_holds_active
  ON watchdog_holds(task_id) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS run_handoffs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  next_step TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  diff_stat TEXT NOT NULL DEFAULT '',
  diff_ref TEXT,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  from_model_profile_id TEXT,
  to_model_profile_id TEXT,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model_profile_id TEXT,
  model_id TEXT,
  provider_id TEXT,
  price_snapshot TEXT,
  pricing_known INTEGER NOT NULL DEFAULT 0,
  token_in INTEGER NOT NULL DEFAULT 0,
  token_out INTEGER NOT NULL DEFAULT 0,
  cached_token_in INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  period_day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cost_run_final
  ON cost_ledger(run_id) WHERE kind='final';
CREATE UNIQUE INDEX IF NOT EXISTS ux_cost_run_kind
  ON cost_ledger(run_id, kind) WHERE kind IN ('provisional','final');
CREATE INDEX IF NOT EXISTS idx_cost_workspace_day
  ON cost_ledger(workspace_id, period_day);
CREATE INDEX IF NOT EXISTS idx_cost_agent_day
  ON cost_ledger(agent_id, period_day);

CREATE TABLE IF NOT EXISTS budget_limits (
  scope TEXT NOT NULL,             -- task|agent|workspace|global
  scope_id TEXT NOT NULL,          -- taskId/agentId/workspaceId/'*'
  limit_micro_usd INTEGER NOT NULL DEFAULT 0,
  soft_ratio REAL NOT NULL DEFAULT 0.8,
  hard_action TEXT NOT NULL DEFAULT 'pause', -- pause|stop
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope, scope_id)
);

CREATE TABLE IF NOT EXISTS provider_cooldowns (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL DEFAULT '*',
  until TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(provider_id, model_id)
);
```

增量列：**无**。hold/counter 只存 `watchdog_holds`/`watchdog_task_state`；handoff/fallback 通过 `run_handoffs` 表与 `run.started` 事件 payload 追溯；调度器只使用 kernel 既有 `Task.nextRunAt`（由 hold 命令设置），不新增 kernel task/run 列（F1）。

### 9.2 迁移步骤（watchdog_schema 1）

1. 检查 `watchdog_schema` 是否存在/版本；已 ≥1 跳过。
2. 单事务：创建表/索引；插入 `version=1`；**不 ALTER kernel tasks/runs**。
3. 种子默认设置（不覆盖已有）：`watchdog.enabled=true`、阈值、`budget.*=0`、fallback 空。
4. 不回填历史 Run 成本；`watchdog_task_state` 对新 Task 默认 0；不重写 kernel 行。
5. 失败：回滚；应用可启动（看门狗禁用并提示），不影响内核；写 `watchdog.migration_failed` 事件/日志。
6. 重复启动幂等。

> 为什么不用内核 `user_version`：内核 v2 迁移已固定；watchdog 是可选上层，独立版本可单独回滚/升级，避免阻塞内核启动。

### 9.3 投影与重建

- 事件为审计事实源（`watchdog.signal/nudged/paused/resumed/escalated/alert_acknowledged`、`run.handoff_created`、`run.model_fallback`、`run.member_switched`、`cost.recorded/budget_*`），但 **t157 起 watchdog/cost 表降级为 durable cache**：`WatchdogStore.rebuild()` 只做 schema 修复/计数校验，不做完整事件重放；数据修复依赖备份/迁移，缺失时显式告警而不伪造。
- **kernel rebuild**：watchdog 不新增 kernel task/run 列；Task 的 hold 仅由既有 `nextRunAt`（kernel 事件）表达，`watchdog_holds` 为原因源；handoff/fallback 在 `run_handoffs` + `run.started` 事件。kernel rebuild 只能重放 kernel 事件，不得 reset 计数或把 hold 当成无 hold；启动后需核对 active holds 与 nextRunAt。
- 一致性校验：active interventions 数、open alerts、ledger final 数、hold 数、`watchdog_task_state` 与 events 计数；异常写 `watchdog.rebuild_mismatch`。schema 被删除/损坏时重建空表并记录 `repaired/missing`，业务数据不伪造。

---

## 10. API / IPC / UI

### 10.1 服务 API（主进程）

```ts
interface WatchdogServiceApi {
  getSnapshot(workspaceId: string): WatchdogSnapshot;
  getCosts(workspaceId: string, query?: CostQuery): CostSnapshot;
  getRunHandoff(workspaceId: string, runId: string): RunHandoff | null;
  ackAlert(workspaceId: string, alertId: string, actor?: string): WatchdogResult<WatchdogAlert>;
  resolveAlert(workspaceId: string, alertId: string, actor?: string): WatchdogResult<WatchdogAlert>;
  releaseTaskHold(workspaceId: string, taskId: string, actor?: string): WatchdogResult<void>;
  setBudget(input: SetBudgetInput): WatchdogResult<BudgetSnapshot>;
  setFallbackChain(input: SetFallbackChainInput): WatchdogResult<FallbackChain>;
  getHealth(): WatchdogHealth;
  tick(now?: number): void;      // 测试/维护；生产定时器
  patrol(now?: number): void;
}
```

```ts
interface WatchdogSnapshot {
  workspaceId: string;
  enabled: boolean;
  deadman: boolean;
  pausedBy: "watchdog" | "budget" | null;
  health: { lastTickAt: string | null; lastPatrolAt: string | null; stale: boolean };
  alerts: WatchdogAlert[];
  interventions: WatchdogIntervention[];
  holds: TaskHold[];
  budgets: BudgetSnapshot;
  fallback: FallbackChain;
  updatedAt: string;
}
```

- 命令走现有 `KernelResult` 风格；错误码 `WATCHDOG_DISABLED | NOT_FOUND | CONFLICT | INVALID_INPUT`。
- **所有查询/命令必须带 workspaceId 并由服务端反查 handoff/alert/hold/task 的 workspace，不匹配返回 NOT_FOUND**；handoff/alert/hold 不接受裸 ID 跨 workspace 访问；不暴露 prompt/secret（F8）。
- 事件刷新沿用 `app:event`；renderer 防抖刷新 snapshot + 本地即时更新 aria-live。

### 10.2 IPC / preload

| 通道 | 方向 | 入参 | 返回 |
|---|---|---|---|
| `watchdog:getSnapshot` | invoke | workspaceId | `WatchdogResult<WatchdogSnapshot>` |
| `watchdog:getCosts` | invoke | workspaceId, query? | `WatchdogResult<CostSnapshot>` |
| `watchdog:getHandoff` | invoke | workspaceId, runId | `WatchdogResult<RunHandoff|null>` |
| `watchdog:ackAlert` | invoke | workspaceId, alertId | `WatchdogResult<WatchdogAlert>` |
| `watchdog:resolveAlert` | invoke | workspaceId, alertId | `WatchdogResult<WatchdogAlert>` |
| `watchdog:releaseHold` | invoke | workspaceId, taskId | `WatchdogResult<void>` |
| `watchdog:setBudget` | invoke | SetBudgetInput | `WatchdogResult<BudgetSnapshot>` |
| `watchdog:setFallback` | invoke | SetFallbackChainInput | `WatchdogResult<FallbackChain>` |
| `watchdog:health` | invoke | — | `WatchdogHealth` |
| `app:event` | main→renderer | 既有 `EventRecord` | — |

- preload `DeerApi` 增加方法；main `ipcMain.handle` 校验参数（zod）与 workspace 权限（handoff/alert/hold/task 均反查 workspaceId）；`contextIsolation` 不变。
- 事件名/类型在 `src/shared/watchdog.ts`（新）导出，main/preload 共用。

### 10.3 事件类型与 schema

`src/watchdog/events.ts` 独立 registry（zod strictObject + 60KB 上限；schemaVersion=2）：

```
watchdog.tick | watchdog.signal | watchdog.nudged | watchdog.paused | watchdog.resumed
watchdog.escalated | watchdog.alert_acknowledged | watchdog.intervention_skipped
watchdog.deadman | watchdog.migration_failed | watchdog.rebuild_mismatch
run.handoff_created | run.model_fallback | run.member_switched
cost.provisional | cost.recorded | cost.budget_warning | cost.budget_exceeded
cost.budget_hold | cost.budget_released | cost.budget_changed
provider.quota_error | provider.cooldown_started | provider.cooldown_ended
```

- 通过 `Store.appendEvent({schemaVersion:2,...})`；append 前自查 registry（与 t83 内核 schema 分离）。
- `watchdog.signal` payload：kind/severity/taskId/runId/evidence（摘要）/window；不含完整工具参数。
- 事件是审计来源；UI 只读摘要。

### 10.4 UI 信息架构

**A. 顶栏预算条**

- 侧栏/顶栏状态区增加 `BudgetChip`：`$spent / $limit`（未设置显示“预算未设置”），软/硬颜色 + 图标；点击打开看门狗面板“成本”区。
- `role="status"`、`aria-live="polite"`（超阈值/暂停 assertive）；`aria-label="今日预算已用 X%，$spent/$limit"`；键盘可聚焦；窄窗只显示“$spent”+图标。

**B. Dock「看门狗」面板**

- `panelRegistry` 新增 `watchdog` key：title“看门狗”，routeTab `tasks`（或 null），minWidth 380/minHeight 320，`defaultClosed: true`（不改变默认布局）；从面板启动器/顶栏预算/任务告警打开。
- 三段：
  1. **Alerts**：open/acked/resolved 过滤；severity 图标+文本（非仅颜色）；任务/run 链接；ack/resolve 按钮；证据摘要可展开。
  2. **Interventions / Fallback**：按 task 时间线，级别、动作、原因、handoff 链接、auto index；进行中 spinner + aria-busy；人工升级横幅。
  3. **Costs**：预算条（task/agent/day）、最近 ledger、模型 fallback 记录、价格未知提示；设置入口。
- 空态：无告警“看门狗运行正常”；无预算“未设置预算”；无 fallback“未发生降级”。
- 键盘：Tab 顺序、上下选择、按钮 Enter/Space；面板滚动区 `tabindex=0`；`aria-live` 播报新 critical alert。

**C. 任务详情告警条**

- 在任务详情 Run 历史上方显示：
  - 当前信号/干预（如“看门狗已暂停：10 分钟无进展；handoff 已保存”），
  - `ack/resolve`、`恢复任务`（releaseHold）、`查看 handoff`、`取消任务`。
- `role="status"`（warning）/`role="alert"`（critical）；`aria-live`；不遮挡主要操作；窄窗换行。

**D. Run 历史/RunPanel**

- RunDetail：新增 cost、handoff、fallback from/to、intervention 标记；timeline 翻译 `run.handoff_created`/`run.model_fallback`/`cost.recorded`/`watchdog.*`。
- Run 列表行显示 fallback 图标/“暂停”标记；不改变现有选择/深链。
- 成本显示 `$x.xxxx`，unknown 显示“成本未知”。

**E. 设置「看门狗与成本」**

- 开关：启用看门狗；阈值（5/10/15min 数值，校验范围）；最大自动干预（固定显示 2，只读/可配？默认只读 2，防绕过）；预算（task/agent/day/global）、soft ratio、hard action；fallback chain 编辑器（有序、选择 model profile）；价格编辑（模型 profile 行）。
- 保存校验：非负、soft 0.1–1、fallback 不重复、模型存在；错误 `role=alert`；保存成功 toast/aria-live。
- 权限：仅人类 UI 可改；Agent 无工具可改预算/权限。

### 10.5 无障碍与窄窗

- 预算条：`role=progressbar` + `aria-valuenow/min/max/valuetext`；颜色之外有文字/图标。
- 告警：severity 文本+图标；`aria-live` 新 critical assertive、warning polite；不重复播报（去重）。
- 对话框（人工升级确认/预算调整）：`role=alertdialog`/`dialog`、焦点陷阱、Esc 关闭（取消）、初始焦点安全按钮。
- 键盘：所有操作可 Tab/Enter/Space；无 hover-only；`focus-visible` 2px。
- 窄窗：960/760 面板单列；预算 chip 缩为金额；长 diff/handoff 用 `<details>` 折叠；不横向溢出。
- reduced-motion：无动画/脉冲；spinner 可用静态“处理中”。

---

## 11. 与内核 / Git / 记忆 / 审批的契约

### 11.1 内核最小扩展（实现阶段）

| 扩展 | 目的 | 文件 |
|---|---|---|
| `KernelHooks.onRunActivity(info)` | 看门狗获取 step/tool/assistant/diff/usage 信号 | `src/kernel/execution/kernel.ts` |
| `KernelHooks.onRunHeartbeat(info)` | token/心跳采样（不刷新 L2 activity） | 同上 |
| `RunExecutionContext.activity(kind,payload)` | 执行器上报活动 | `src/kernel/execution/kernel.ts`、`service.ts` |
| `KernelCommands.interruptRun(runId,{code,retryable,handoffId,nextModelProfileId,holdMs})` | 原子 abort+fail/queue+hold；CAS/审计 | `kernel.ts` |
| `KernelCommands.holdTask/releaseTaskHold` | 任务挂起/恢复：只写 kernel 既有 `nextRunAt` 事件；hold reason/scope 在 `watchdog_holds`，不再加 kernel 列 | `kernel.ts` |
| `KernelCommands.reassignTask` | 换成员（ownerId + 事件） | `kernel.ts` |
| `KernelCommands.injectNudge` | L1 提醒（下次模型调用前注入） | `kernel.ts`、`loop.ts` |
| `Run.modelProfileId` 读取 override | fallback 新 Run 使用目标模型 | `service.ts` |
| `run.started` payload：handoffId/fallbackFromRunId | handoff/fallback 追溯；由事件重建，不加 kernel run 列 | `shared/types.ts`、`store` 事件 schema |
| `watchdog_task_state`（watchdog 表） | autoInterventions/nudge_count；kernel rebuild 不影响 | `src/watchdog/store.ts` |
| `tokens per step` usage 事件 | 成本/燃烧速率 | `loop.ts`、`service.ts` |

- 扩展保持内核不变量：所有状态写入仍 CAS + 事件 + 投影；看门狗不直接改 kernel 表。
- `interruptRun` 实现必须复用 t90/t94 的 `discardRun`/CAS 语义；旧 executor 结果被 `result_discarded`。
- `holdTask` 与调度：`tick` 只跳过 `next_run_at` 远未来的 Task；**不再依赖 `hold_reason` 列**；release 只在无其他 active `watchdog_holds` 时清 nextRunAt。
- `injectNudge` 不改变权限/工具；只插一条系统提醒；失败不阻断 Run。

### 11.2 Git

- handoff diff：在 **abort/finalize 之前**读取 `run.sandboxId` 对应 worktree 的 `git diff`；只读命令，限制 args（复用 `validateGitArgs`）。
- 旧 Run finalize 由内核 `onRunFinished`→GitService（现有）；handoff 已保存，worktree 删除不影响。
- 换成员/fallback 不绕过 Git lease/worktree；新 Run 的 Git beforeStart 重新分配；旧 worktree 由 finalize/reconcile。
- 敏感文件过滤：`permission.isSensitivePath`；diff 过大只存 stat + 引用；不提交 handoff 到仓库。

### 11.3 记忆

- Handoff 复用 `TaskSummary`（latest）与事件；不重复写 summaries；可选 `summary` 缺失时从事件构造。
- 不自动写黑板/备忘录（避免 noise）；人工可把 escalation/handoff 提升为 memo/decision（后续）。

### 11.4 审批/权限

- 429/预算/看门狗不自动批准高风险工具；`TOOL_DENIED` 不触发模型 fallback（应人改权限）。
- 暂停/中止不绕过 t58 审批：审批中的 Run 处于 `waiting_human`，L2 的 5min task_timeout/10min heartbeat_stale **不触发 nudge/pause**；等待进入时记录一次 activity，`waitingHumanGraceMs = max(2 × approvalTimeout, 240s)`（默认 240s，可配）后才产生 critical alert/human，仍不自动 pause；审批恢复后照常。补 KRN-07。
- Agent 无工具可改预算/fallback/watchdog 设置；仅 renderer IPC 人类操作。

---

## 12. 测试与验收

### 12.1 测试策略

- **单元/pure**：信号检测、循环签名、无进展、阈值边界、预算公式、价格精度、fallback 选择、dedupe。
- **fake clock**：`tick/patrol` 手动推进；5/10/15min、日边界、429 冷却、deadman；不依赖真实定时器。
- **故障注入**：executor 卡死/循环工具/无 diff/连续错误/429；Git diff 失败；handoff 写失败；预算超限；kill/lease 过期。
- **内核契约**：interruptRun/abort/lease/fencing/result_discarded；hold 不被调度；旧 executor 不覆盖新 Run；事件顺序。
- **UI**：RTL/现有测试；告警条/预算条 ARIA/键盘/窄窗；面板空态。
- **E2E**：mock provider + fake clock：卡死→nudge→pause+handoff→fallback→done；预算超限→hold→人工提高→resume；429→fallback；人工升级。

### 12.2 AC（编号；共 93 条 = 原 86 + t157 新增 3 + t161 新增 4）

#### 信号/巡检（WD）

| AC | 内容 |
|---|---|
| WD-01 | 60s tick、5min 单任务、15min 全量巡检可被 fake clock 驱动；无真实 timer 依赖 |
| WD-02 | 10min 无 activity → heartbeat_stale；有 activity 则不再命中 |
| WD-03 | 5min 无 activity → task_timeout warning/nudge；10min → pause |
| WD-04 | 同工具签名 3 次/10min → repeat_tool；参数规范化不影响不同工具 |
| WD-05 | 同文件写 4 次且 diff 未变 → repeat_tool/file |
| WD-06 | 3 步/8min 无 progress → no_progress；写文件/commit/task.complete 清除 |
| WD-07 | 连续 3 次失败 → error_streak；TOOL_DENIED 不计入模型 fallback |
| WD-08 | token > 阈值/5min → token_burn warning；预算 hard 另行处理 |
| WD-09 | 429/insufficient_quota/code1308 → provider_quota + 冷却；不发 nudge |
| WD-10 | deadman：last_tick 超过 2×间隔 → critical；renderer 显示 stale |
| WD-11 | 同一 alert 15min 去重；不同 task 不互相抑制 |
| WD-12 | 巡检单飞/防抖，不并发重复干预 |
| WD-13 | deadman：last_tick > 2×间隔 → critical + `watchdog.deadman`；fake clock 确定性测试；UI 显示 stale |

#### 干预（IN）

| AC | 内容 |
|---|---|
| IN-01 | L1 nudge 最多 3 次/任务，不计 auto；有 progress 停止；`autoInterventions>=2` 时禁止 nudge |
| IN-02 | L2 pause 生成 handoff、abort、queued+hold、nextRunAt；旧结果被丢弃 |
| IN-03 | L3 fallback 选择链中下一个模型；新 Run model override；attempt+1 |
| IN-04 | L4 换成员更新 owner、新 Run；旧成员无活跃 Run |
| IN-05 | autoInterventions 每次 L2/L3/L4 +1；达到 2 后禁止 nudge/L2-L4，只 human |
| IN-06 | 人工升级时 scheduler 暂停 + hold + critical alert；不自动恢复 |
| IN-07 | 同一 task 同时最多一个进行中 intervention |
| IN-08 | 人工 releaseHold 后 task 可启动；预算/循环未解决时仍被策略阻止 |
| IN-09 | 429 跳过 nudge/pause 直接 fallback；链空→human |
| IN-10 | 所有干预写 watchdog.* 事件 + 查询表；审计含 reason/from/to |
| IN-11 | budget hold + watchdog/escalation hold 同时存在时，release 只清当前 reason；最后一个 hold 才清 nextRunAt；释放其一仍不启动（t157 双 hold 测试） |
| IN-12 | 2 次自动干预后的信号矩阵：nudge/L2/L3/L4 均不执行，只 critical alert + human |

#### 交接（HO）

| AC | 内容 |
|---|---|
| HO-01 | Handoff 含 summary/nextStep/files/diffStat/lastEventSeq/model/agent |
| HO-02 | diff 从 Git worktree 读取，按路径先过滤敏感路径再拼接；`.env`/`.ssh` 等 tracked 变更只保留 `[REDACTED]`/stat，不落完整 patch；summary.files/assistant 文本过滤，≤256KB |
| HO-03 | handoff 在 abort 前持久化；失败则禁止切换→human |
| HO-04 | 新 Run 注入 handoff ≤1500 tokens；task acceptance 不丢 |
| HO-05 | 旧 Run 结果不能覆盖新 Run（lease/fencing/result_discarded） |
| HO-06 | handoff 事件不含密钥/完整 prompt；UI 只显示摘要 |
| HO-07 | handoff 过期清理（7 天）不影响审计事件 |
| HO-08 | 换成员/fallback 均生成 handoff；可查询 `getRunHandoff` |
| HO-10 | summaryLines/changes/openQuestions/nextStep 统一 redactSensitiveText；摘要含 `.env`/secret 测试 |

#### 成本（CO）

| AC | 内容 |
|---|---|
| CO-01 | token/价格计算精确到 micro-USD；展示 4 位小数 |
| CO-02 | 每个 Run 一条 final ledger；重复事件幂等 |
| CO-03 | Run.costUsd = final；失败/取消 Run 计费 |
| CO-04 | 价格快照随 Run；价格变更不追溯旧 Run |
| CO-05 | 未配置价格标记 unknown；预算默认不阻塞（strict 模式可配） |
| CO-06 | Task/Agent/Workspace 日汇总正确；跨日切换正确 |
| CO-07 | provisional 单行原位更新；参与 `spentForBudget` 的 active 项，final 入账后去重，不写 final |
| CO-08 | 历史 Run 不回填；UI 标记 legacy unknown |
| CO-09 | cost.recorded/budget_* 事件可审计/重建；final ledger + Run.costUsd 故障后 reconciliation |
| CO-10 | 缓存 token/ reasoning token（若提供）计入或显式忽略 |
| CO-11 | final ledger + runs.cost_usd + cost.recorded 同事务；崩溃/故障注入后 startup reconciliation 补齐，幂等 |

#### 预算/降级（BU）

| AC | 内容 |
|---|---|
| BU-01 | soft 80% 警告一次；hard 100% 暂停 |
| BU-02 | 启动前 deny：无新 Run/attempt，task queued+hold |
| BU-03 | 运行中 hard：暂停当前 Run；后续启动被拦截 |
| BU-04 | task/agent/workspace 三种 scope 独立生效；workspace 级暂停 scheduler |
| BU-05 | hardAction=stop：Run failed(BUDGET_EXHAUSTED)，Task failed |
| BU-06 | 人工提高预算 + releaseHold 后可恢复 |
| BU-07 | fallback chain 顺序/跳过冷却/同模型去重 |
| BU-08 | 429 冷却 5min/resetAt；provider 连续 2 次全 provider 冷却 |
| BU-09 | fallback 次数上限 2；链空→human |
| BU-10 | 预算/模型设置校验（非负/存在/不重复） |
| BU-11 | `spentForBudget = final + active provisional + reservation` 在 beforeStart/activity 使用；active Run 超支被拦截；final 后去重 |
| BU-12 | provider 级 429 写 `model='*'` 后所有 model 跳过；到期/清理恢复；同时检查 provider/model 两级 |
| BU-13 | provider 失败事件生成 `provider_quota` 信号并自动走既有 fallback：新 Run model override + handoff + 原 provider/model 冷却；429→fallback→新模型→冷却测试 |
| BU-14 | provider 5min 内 2 次失败写 `model='*'`；beforeStart 对冷却 model/provider 拒绝并 hold/alert，禁止内核 auto-retry 同 model；真实 429 两次→`*`、同 model 拦截测试 |
| BU-15 | fallback 链空/全部 cooling → escalate + escalation hold + critical alert，任务不自动重跑；链空/all cooling 测试 |

#### API/UI（UI/API）

| AC | 内容 |
|---|---|
| API-01 | getSnapshot/getCosts/getHandoff/ack/resolve/release/setBudget/setFallback 可用 |
| API-02 | workspace 隔离；错误码稳定；写命令审计 |
| API-03 | preload/main 类型与 ipc 声明一致；无未声明通道 |
| API-04 | 事件刷新后 snapshot 一致 |
| API-05 | getRunHandoff/ackAlert/resolveAlert/releaseTaskHold 均带 workspaceId 并反查校验；跨 workspace 拒绝 |
| UI-01 | 顶栏预算条显示 spent/limit，soft/hard 状态；aria progressbar |
| UI-02 | 任务详情告警条显示 signal/干预/handoff，支持 ack/release |
| UI-03 | Watchdog 面板 Alerts/Interventions/Costs 三段；空态/加载/错误 |
| UI-04 | RunHistory 显示 handoff/fallback/cost；timeline 翻译 |
| UI-05 | 设置看门狗阈值/预算/fallback/价格；校验错误 role=alert |
| UI-06 | 键盘可达、focus-visible、无 hover-only |
| UI-07 | aria-live 播报 critical/warning；不重复 |
| UI-08 | 960/760 窄窗不溢出；reduced-motion 无动画 |
| UI-09 | 人工升级 alertdialog/确认，Esc 取消不误恢复 |
| UI-10 | Watchdog 挂载 App/Dock 默认关闭；顶部预算条、任务详情告警条、RunHistory handoff 卡；按钮键盘可达；900/760 窄窗不溢出 |
| UI-11 | App/Dock 组件级渲染/交互（预算条、ack/release、RunHistory handoff）覆盖；完整 App DOM e2e 标 **P1 manual**，不冒充 UI 全通过 |

#### 内核契约/迁移/E2E（KRN/MG/E2E）

| AC | 内容 |
|---|---|
| KRN-01 | interruptRun 走 CAS/lease；旧 owner 结果 discarded |
| KRN-02 | hold task 不被调度；release 后按 ready/queued 规则启动 |
| KRN-03 | handoffId/model override 写入新 Run 事件；attempt+1 |
| KRN-04 | 看门狗不与内核 L1 watchdog 冲突；waiting_human 不被误判卡死 |
| KRN-05 | 看门狗关闭/异常不影响内核执行 |
| KRN-06 | kernel rebuild 后 active hold（nextRunAt）、autoInterventions、handoff/fallback 追溯保持；不得 reset/误恢复 |
| KRN-07 | waiting_human 5/10min 不触发 nudge/pause；grace 到期只 critical/human，恢复后正常 |
| MG-01 | watchdog_schema 幂等迁移；不改 kernel user_version |
| MG-02 | 表/列重复启动幂等；失败回滚且应用可用 |
| MG-03 | 旧 Run cost 不回填；UI legacy unknown |
| MG-04 | 默认设置不覆盖用户已有；预算默认 0 |
| MG-05 | watchdog tables 为 durable cache：kernel rebuild 不 reset 计数/hold；watchdog.rebuild 做 schema 修复/计数校验（不完整事件重放）；删除表后可重建空 schema 并记录 missing |
| E2E-01 | 卡死→nudge→pause+handoff→fallback→done（mock provider） |
| E2E-02 | 循环工具→重复检测→pause；人工 release 后正常 |
| E2E-03 | 预算硬限→hold→人工提高→resume→done |
| E2E-04 | 429→fallback→冷却→不再撞原 provider |
| E2E-05 | 自动干预 2 次→human；无第三次自动动作 |

### 12.3 验收映射（任务 7 项）

| 任务要求 | 章节/AC |
|---|---|
| 心跳/15min/5min 超时/卡死/循环/无进展/错误/token/429 | §4、WD-01..12 |
| 干预阶梯/最多 2 次 | §5、IN-01..12 |
| handoff 摘要+diff+下一步；abort/lease/fencing | §6、HO-01..08、KRN-01..07 |
| 成本账本/价格/Run/预算/降级/审计 | §7、§8、CO-01..11、BU-01..12 |
| UI/API/ARIA/窄窗 | §10、API-01..05、UI-01..09 |
| fake clock/故障注入/预算/循环/人工升级/内核契约 | §12、KRN-06/07、MG-05 |
| 文件影响/迁移/阶段/非目标/AC | §9、§13、§14、§12 |
| watchdog 状态与 kernel rebuild/rebuild 顺序 | §9.3、KRN-06、MG-05 |
| budget active provisional/reservation/final 去重 | §7.2、§8.2、BU-11、CO-07/11 |
| hold 多原因组合与释放 | §5.2、§9.1、IN-11 |
| waiting_human 豁免 | §11.4、KRN-07 |
| provider 两级冷却 | §7.4、BU-12 |
| 429 自动 fallback + 新模型 + 冷却测试 | §4.5、§5.1、BU-13、E2E-04 |
| 多 hold 释放/nextRunAt 边界 | §5.2、IN-11 |
| 敏感 diff（.env/.ssh tracked） | §6、HO-02 |
| deadman fake clock | §4.6、WD-10/WD-13 |
| provider 计数窗口/*/beforeStart 拦截 | §4.5、§5.1、BU-14 |
| fallback 空/全冷却 human hold | §4.5、BU-15 |
| summary/nextStep 脱敏 | §6、HO-10 |
| UI 挂载/键盘/900/760 窄窗 | §10、UI-01..11 |
| API workspace 隔离（handoff/alert/hold） | §10.1/10.2、API-05 |

---

## 13. 文件级影响面与阶段

### 13.1 新增

```
src/watchdog/types.ts           WatchdogSnapshot/Alert/Intervention/Handoff/Cost 类型
src/watchdog/events.ts          watchdog/cost 事件 registry（zod strict）
src/watchdog/store.ts           WatchdogStore（watchdog_schema/表/查询/重建）
src/watchdog/signals.ts         信号纯函数（签名/无进展/错误/燃烧）
src/watchdog/detector.ts        detector + 滑动窗口 + 阈值
src/watchdog/interventions.ts   阶梯/计数/hold/fallback/member 决策
src/watchdog/handoff.ts         HandoffBuilder（Git diff/summary/next step）
src/watchdog/cost.ts            价格/计费/ledger/finalization
src/watchdog/budget.ts          预算查询/检查/hold/事件
src/watchdog/service.ts         WatchdogService/PatrolLoop/API
src/watchdog/*.test.ts          signals/detector/interventions/handoff/cost/budget/kernel 契约
```

### 13.2 修改

```
src/kernel/execution/kernel.ts  activity/heartbeat hooks、interruptRun、hold/release（nextRunAt）、reassign、injectNudge、run.started payload
src/kernel/service.ts           组合 hooks、activity/usage、model override、handoff 注入、watchdog 构造/close
src/kernel/loop.ts              per-step usage/activity；nudge 注入点
src/kernel/store.ts             watchdog 独立迁移；不新增 Task/Run 列；Run 事件 schema 增加 handoff/fallback payload
src/shared/types.ts             ModelPricing、Watchdog/Cost 类型；Run handoff 从事件读取，不新增 hold/auto 列
src/shared/watchdog.ts          共享 DTO/错误码（或并入 types）
src/shared/ipc.ts               watchdog 通道
electron/main.ts                ipcMain handlers
electron/preload.ts             DeerApi
src/App.tsx                     预算条/任务告警/面板打开/设置入口
src/RunHistory.tsx              handoff/fallback/cost 行/事件翻译
src/RunPanel.tsx                watchdog 摘要/告警链接
src/SettingsView.tsx            看门狗与成本设置区
src/shell/dock/panelRegistry.ts watchdog 面板定义
src/styles.css                  budget/alert/panel/handoff 样式 + 窄窗
src/shared/copy.ts              signal/severity/action 文案
```

### 13.3 阶段

| 阶段 | 内容 | 验收 | 估算 |
|---|---|---|---|
| W0 基础 | 类型/事件/迁移/价格/ledger/预算表 | WD/MG/CO 基础 | 2–3d |
| W1 检测/巡检 | signals/detector/patrol/deadman/alert | WD-01..12 | 3d |
| W2 干预/交接 | hold/pause/fallback/member/handoff/nudge | IN/HO/KRN | 4d |
| W3 预算/降级 | budget checks/stop/冷却/设置校验 | BU/CO | 2–3d |
| W4 API/UI | snapshot/panel/alerts/budget/run UI/设置 | API/UI | 3–4d |
| W5 E2E/硬化 | fake clock/故障注入/E2E/性能/文档 | E2E/全量 | 2–3d |
| **合计** | 完整实现（非 MVP） | — | **16–20 人日（L）** |

### 13.4 迁移/上线

1. W0 迁移 additive；旧库启动自动建表/列；`watchdog.enabled` 默认 true 但预算 0（不阻塞）。
2. 看门狗失败/异常不阻止内核启动；UI 显示“看门狗不可用”，事件 `watchdog.migration_failed`。
3. 成本价格未配置时 UI 提示；不阻断执行。
4. 回滚：停止 WatchdogService + 保留表（不删数据）；内核命令扩展向后兼容（无 watchdog 时无调用）。
5. 观察指标：误报率、自动干预成功率、预算超限次数、handoff 恢复成功率、成本误差。

---

## 14. 风险与开放问题

### 14.1 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 误判打断正常长任务 | 体验/进度损失 | 5min 只 warning；10min 才 pause；可配置；nudge 优先；waiting_human 特殊处理 |
| R2 | 漏判卡死烧钱 | 成本/卡住 | L1 lease 60s 兜底 + L2 10min + 预算 hard |
| R3 | handoff 丢上下文 | 切换后重复/错误 | 确定性摘要 + diff + summary；handoff 失败禁止切换转人工 |
| R4 | 旧 executor 覆盖新 Run | 数据错乱 | 内核 CAS/lease/fencing/result_discarded（t90/t94）；切换前 handoff |
| R5 | 预算计算误差/价格未知 | 超支/误停 | micro-USD；价格快照；unknown 默认不阻塞可配 strict；预留检查 |
| R6 | 429 风暴 | 成本/失败 | 立即冷却 provider；指数退避；链空人工 |
| R7 | 看门狗自身挂 | 无人兜底 | deadman/last_tick；renderer stale 提示；L1 lease 仍工作；P2 外置 |
| R8 | 事件/表不一致 | 审计/查询错 | 事件事实源 + 可重建 + 启动抽样校验 |
| R9 | 干预循环 | 自行陷入 | 每任务 max 2 自动；同信号去重；人工升级 |
| R10 | 迁移冲突 | 启动失败 | watchdog 独立 schema；幂等；失败不阻塞内核 |
| R11 | diff 泄露敏感信息 | 安全 | sensitive path 过滤/redaction/大小限制/不入库密钥 |
| R12 | UI 信息过载 | 可用性 | 顶栏摘要 + 面板分层；critical 才弹窗；空态 |
| R13 | 与 Git lease 冲突 | worktree 错乱 | 不绕过 Git finalize/fencing；handoff 先生成 |
| R14 | 成本价格变更追溯 | 审计争议 | 快照 per Run；不重算历史 |

### 14.2 待拍板（Q）

| ID | 问题 | 建议 |
|---|---|---|
| Q1 | 默认阈值（5/10/15min、重复 3、错误 3、token 120k/5min） | 按建议；可设置 |
| Q2 | 预算默认值 | 全部 0（不限制），团队显式启用 |
| Q3 | hardAction 默认 pause/stop | pause（可恢复） |
| Q4 | 每任务自动干预 2 次是否包括 nudge | 不包括；nudge 最多 3 次且仅在 autoInterventions<2 时可用；达到 2 后 nudge/L2-L4 全部停止，只 human（F4） |
| Q5 | fallback 默认链 | 空；设置后生效 |
| Q6 | 价格未知是否阻止预算 | 默认不阻止；strict 可配 |
| Q7 | handoff 完整 diff 存文件/DB | 文件 + DB 引用；7 天清理 |
| Q8 | 看门狗面板位置 | Dock 默认关闭面板；顶栏预算打开 |
| Q9 | 日预算时区 | 本地时区；可后续工作区时区 |
| Q10 | 看门狗是否允许修改成员 | 仅自动换成员（有 handoff）；不自动改权限 |

### 14.3 明确非目标（再次）

自动修代码、自动合并、自动批准、云账单对账、价格自动抓取、多用户审批、分布式看门狗、ML 异常检测、UI 重构、历史成本重算。

---

## 附录 A：默认设置键

```
watchdog.enabled=true
watchdog.tickMs=60000
watchdog.taskCheckMs=300000
watchdog.stallMs=600000
watchdog.patrolMs=900000
watchdog.repeatToolCount=3
watchdog.sameFileWriteCount=4
watchdog.errorStreak=3
watchdog.tokenBurnPer5m=120000
watchdog.autoInterventionLimit=2
watchdog.nudgeLimit=3
watchdog.waitingHumanGraceMs=240000
budget.taskUsd=0
budget.agentDailyUsd=0
budget.workspaceDailyUsd=0
budget.globalDailyUsd=0
budget.softRatio=0.8
budget.hardAction=pause
budget.strict=false
fallback.maxSwitches=2
```

## 附录 B：事件 payload 示例

```json
// watchdog.signal
{"kind":"no_progress","severity":"warning","taskId":"task_1","runId":"run_1",
 "evidence":{"stepsWithoutProgress":3,"lastProgressSeq":42},"windowMs":480000}

// run.handoff_created
{"handoffId":"hof_1","runId":"run_1","taskId":"task_1","reason":"fallback",
 "files":["src/a.ts"],"diffStatHash":"...","fromModelProfileId":"p:m1","toModelProfileId":"p:m2"}

// cost.recorded
{"runId":"run_1","taskId":"task_1","agentId":"agent_1","kind":"final",
 "costUsd":0.0123,"costMicroUsd":12300,"pricingKnown":true,"priceVersion":"2026-11"}

// cost.budget_exceeded
{"scope":"task","scopeId":"task_1","spentUsd":2.01,"limitUsd":2,"ratio":1.005,"action":"pause"}
```

## 附录 C：当前代码锚点

- 内核 hooks/lease：`src/kernel/execution/kernel.ts` `KernelHooks`、`heartbeat`、`watchdogActiveRuns`、`casRunPatch`、`discardRun`。
- 执行器：`src/kernel/service.ts` `executeRunCore`（15s heartbeat、loop、summary）；`src/kernel/loop.ts`。
- Run/Task 字段：`src/shared/types.ts` `Run`、`ModelProfile`；`src/kernel/store.ts` runs/tasks 投影。
- UI：`src/RunPanel.tsx`、`src/RunHistory.tsx`、`src/App.tsx`（任务详情/scheduler/顶栏）、`src/SettingsView.tsx`、`src/shell/dock/panelRegistry.ts`、`src/shared/kernelUi.ts`。
- Git：`src/git/gitService.ts`（beforeStart/finalize/getTaskVcs）、`src/git/gitExec.ts`（diff 校验）。
- 记忆：`src/memory/service.ts`/`store.ts`（TaskSummary、search）。
- 审批：`src/kernel/permission.ts`、`src/kernel/tools.ts`、`docs/team/chat-controls-implementation.md`（t58）。

---

## 15. t141 修订记录（落实 t137）

> t137 findings：2 blocker（F1 kernel rebuild、F2 预算口径）+ 5 high/medium（F3–F8）+ AC 缺口（F9）。本版按下列方式修订；t141 复审通过后才启动实现。

| 编号 | t137 finding | 本版修订 |
|---|---|---|
| F1 | kernel rebuild 丢 watchdog 状态 | §5.2/§5.3/§9.1/§9.3/§11.1：hold/counter 只存 watchdog 表；不新增 kernel task/run 列；hold 用现有 `nextRunAt`，autoInterventions 在 `watchdog_task_state`；handoff/fallback 用 `run.started` 事件/`run_handoffs`；新增 KRN-06/MG-05 |
| F2 | 预算 final/provisional 矛盾 | §7.2/§8.2：统一 `spentForBudget = final + active provisional + reservation`；定义 reserve 公式、final 去重；更新 CO-07、新增 BU-11 |
| F3 | hold 不能组合 | §5.2/§9.1：`watchdog_holds` 主键 `(task_id, reason, scope)`；release 只清当前 reason，最后一个才清 nextRunAt；新增 IN-11 |
| F4 | nudge 与 max2 矛盾 | §5.1/§5.3/Q4：nudge 仅在 autoInterventions<2 时可用；达到 2 后禁止 nudge/L2–L4；新增 IN-12，更新 IN-01/IN-05 |
| F5 | waiting_human 无规则 | §4.1/§11.4：waiting_human 不参与 5/10min no-activity pause；`waitingHumanGraceMs` 默认 240s；新增 KRN-07 |
| F6 | final ledger 原子性未定 | §7.2：final ledger + `runs.cost_usd` + `cost.recorded` 同事务；startup reconciliation；provisional 单行原位更新；新增 CO-11 |
| F7 | provider 冷却未查 `*` | §7.4：选择同时检查 `(provider,model)` 与 `(provider,'*')`；`*` 插入/清理/过期；新增 BU-12 |
| F8 | API workspace 隔离 | §10.1/§10.2：handoff/alert/hold 方法增加 workspaceId/反查校验；新增 API-05 |
| F9 | AC 缺口/计数 | §12.2 共 **86 条**（原 77 + 9）；§12.3 增加 F1–F8 映射；新增 IN-11/IN-12、CO-11、BU-11/BU-12、API-05、KRN-06/KRN-07、MG-05 |

**实现顺序**：先补 kernel 最小扩展（activity/interrupt/hold/reassign/nudge）、watchdog 表/事件、fake clock 契约测试，再实现 detector/intervention/handoff/cost/budget，最后 UI。测试必须覆盖 F1 rebuild、F2 active 超支、F3 多 hold、F4 计数矩阵、F5 waiting_human、F6 final 故障注入、F7 provider `*`、F8 跨 workspace 拒绝。

---

## 16. t157 修复记录（round 2）

> t145 评审 needs_revision（2 high + 4 medium）后，t157 按下面方式修复；本版 AC 增为 89（新增 BU-13、WD-13、UI-10 并把 HO-02/IN-11 文本收紧）。

| Finding | 修复 |
|---|---|
| F1 high 敏感 diff 泄露 | handoff 先按路径过滤；`.env`/`.ssh` tracked 变更仅 `[REDACTED]`/stat，不落完整 patch；summary.files/assistant 文本过滤；补 tracked `.env`/`.ssh` 测试 |
| F2 high 429 无自动 fallback | provider 失败事件生成 `provider_quota` 信号，冷却原 provider/model，生成 handoff，调用 `retryTaskWithModel` 新 Run model override；补 429→fallback→新模型→冷却测试 |
| F3 high UI 未挂载 | `watchdog` 加入 Dock panelRegistry（默认关闭）、App 顶部预算条、任务详情告警条、RunHistory handoff 卡；styles 900/760/reduced-motion；补 panel registry/窄窗/ARIA 测试 |
| F4 medium release 释放全部 | release API 必须 `reason` 或 `all=true`；默认只释放当前 reason，最后一个 hold 才清 nextRunAt；补 budget+watchdog 双 hold 测试 |
| F5 medium rebuild 只计数 | 明确把 watchdog 表降级为 durable cache，修改 INV-9/MG-05/§9.3/AC；`WatchdogService.rebuild()` 做 schema 修复（删除表可重建空 schema）并记录 missing；补删除表测试 |
| F6 测试/AC | 增加 429/fallback、多 hold、敏感 diff、deadman、UI 挂载/窄窗测试；AC 增加 BU-13/WD-13/UI-10 |

---

## 17. t161 修复记录（round 3）

> t158 复审 needs_revision（2 high + 1 medium + low）后修复；AC 增为 93（BU-14/BU-15/HO-10/UI-11）。

| Finding | 修复 |
|---|---|
| F1 high provider 级冷却不存在 | `recordProviderFailureWindow` 按 provider/5min 计数，第 2 次写 `model='*'`；`beforeStart` 用 pending model/agent profile 检查 `(provider,model)` 与 `(provider,'*')`，冷却则 hold+critical 并拒绝启动；真实 429 两次→`*`、beforeStart 拦截测试 |
| F2 high 链空不 human | target=null → `escalate` + escalation hold + critical alert + pauseScheduler + holdTask；链空/all cooling 测试断言任务不自动重跑 |
| F3 medium UI 证据不足 | 新增 BudgetBar/AlertBanner 交互（ack/release）、RunHistory handoff、panelRegistry/900/760 组件测试；完整 App DOM e2e 明确标 P1 manual |
| F4 low summary 未全量脱敏 | summaryLines/changes/openQuestions/nextStep 统一 redactSensitiveText；summary 含 `.env`/secret 测试 |
| F5 测试缺口 | 补真实 429 两次、同 model 拦截、链空/all cooling、summary 脱敏、UI 交互测试 |

---

> **审查提示**：本设计覆盖 DESIGN §7.4/§7.6 及任务书 7 项要求；实现前请先裁决 §14.2 Q1–Q10（Q4 已明确 2 次后禁 nudge）。实现阶段必须先完成内核最小扩展（§11.1）与 fake-clock 契约测试，再接线 UI；t141 复审通过后才可拆分实现。
