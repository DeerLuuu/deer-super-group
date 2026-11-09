# DeerSuperGroup 任务执行内核与调度 UI · 最终集成报告（t72）

- **任务**：t72 `[integration]` 集成验收：任务执行内核与调度 UI
- **设计依据**：`docs/team/execution-kernel-design.md`（t67；t76/t79 修订：并发 4/1/1、迁移 fail-closed、G3 契约增补）
- **实现文档**：`docs/team/execution-kernel-implementation.md`（t68/t83/t90/t94）、`docs/team/execution-kernel-ui.md`（t69/t107/t113/t117/t121/t126/t130）
- **最终基线**：`main` = `5f48405`（2026-11-09T22:02:03Z，PR #5 squash 合并）
- **验收环境**：Windows / pnpm 12 / Node 24；无 Electron 窗口（视觉人工项单列）
- **结论**：**6/6 验收通过**（评审链 + PR 合并 + 全链路可追溯 + 调度 UI/ARIA + 回归 + 三命令 + 文档）

---

## 1. 验收结论（t72 acceptance 6/6）

| # | 验收项 | 结论 | 证据 |
|---|--------|------|------|
| 1 | t70/t71 均 pass，t68/t69 PR 已合并到 main | ✅ | 内核：t70 needs_revision（F1–F8）→ t83/t90/t94 修复 → **t95 复审 pass**；PR #2 合并 `24ba09a`（mergedAt 2026-11-09T20:45:41Z）。UI：t71 needs_revision（F1–F7）→ t107/t113/t117/t121/t126/t130 修复 → **t131 复审 pass**；PR #5 head `7aedd87`，`mergeStateStatus=CLEAN`，集成轮 squash 合并 `5f48405`。与 t64 先例（t65 needs_revision → t80/t81 pass → t66 集成）同一门禁口径。 |
| 2 | 事件/状态机/调度/重试/恢复在最终代码中可追溯 | ✅ | `src/kernel/execution/*` 全部在 main；事件注册表 30 类 + zod；8 态状态机；4/1/1 并发；租约/心跳/watchdog；5s×2ⁿ 退避与 attempt 幂等；恢复/重建；T22 blocked reason；迁移 fail-closed。`kernel.test.ts` **43 例**全绿（详见 §3、§4）。 |
| 3 | 调度 UI 与 Run 时间线可用，操作/错误/空态/ARIA 通过 | ✅ | `SchedulerBar`/`RunHistory`/`RunPanel`/`KernelAnnouncer` + `#/tasks?t=&r=` 深链在 main；`KernelRuntimeUi.test.tsx` **20 例** + `shared/kernelUi.test.ts` **19 例**覆盖调度栏运行/排队/暂停/恢复、错误态 `role=alert`+重试、Run 字段/时间线/空态/加载态、操作 disabled+`aria-describedby` 原因、确认 Modal、aria-live 播报、唯一 id、窄容器、深链（详见 §5）。无头环境限制见 §7。 |
| 4 | 现有 Router/成员/权限/审批/Dock/星图/画布无回归 | ✅ | main-only 全量 **28 文件 / 370 用例**全绿，含 permission 44、approval 9 + approval-wiring 2、service 7（含任务 E2E）、Markdown 2、deeplink 13、TaskStarMap 5、交互画布/提问 40+、记忆系统 20+。PR #5 仅改 UI/IPC/样式/深链，未触碰 `src/kernel/`、`src/git/`、`src/memory/`；PR #2 未改权限/审批语义（service 兼容包装）。 |
| 5 | `pnpm typecheck`、`pnpm build`、`pnpm test` 全部通过 | ✅ | main `5f48405`：exit 0 / 0 / 0（详见 §6）。 |
| 6 | `docs/team/execution-kernel-final.md` 记录实现映射、验证、遗留 | ✅ | 本文件。 |

---

## 2. 评审与合并链路

### 2.1 内核（t68 → t70/t84/t91 → t83/t90/t94 → t95）

| 轮次 | 任务 | 结论 | 关键输出 |
|------|------|------|----------|
| 首轮评审 | t70（aria） | **needs_revision** | F1 工作区并发默认 2 / F2 活动租约过期不回收 / F3 迁移备份失败被吞 / F4 旧事件 schemaVersion 默认 2 / F5 review/waiting_human 不可达 / F6 事件 payload 无逐类型 zod / F7 blockedReason 事件契约 / F8 rebuild 2000 上限 |
| 修复 1 | t83（sol） | completed | maxWorkspace=1 + 写隔离测试；watchdog abort + `LEASE_EXPIRED`；备份 checkpoint+VACUUM INTO+integrity_check，失败拒绝迁移；旧事件 schema_version=1；reviewPolicy/waiting_human；事件注册表 zod；T22 `task.blocked`；分页 rebuild |
| 复审 2 | t84（aria） | needs_revision | waiting_human/resumed 投影重放、CAS 失败 `run.result_discarded`、stale-owner 五类写 |
| 修复 2 | t90（sol） | completed | `run.waiting_human`/`run.resumed` 投影；`auditDiscarded` + 6 类 stale-owner CAS 审计测试 |
| 复审 3 | t91（aria） | needs_revision | stale-owner 只写审计不 abort 旧 executor |
| 修复 3 | t94（sol） | completed | `discardRun` 统一 abort + activeRuns 清理 + 审计；6 类参数化 + late-tool 无副作用 + foreign lease 一致性 |
| **终审** | **t95（aria）** | **pass** | 6 类 stale-owner 写均 abort/清理/审计；abort 后无工具副作用；未过期异主租约不抢占；289/289；PR #2 可进入集成 |

- **PR #2**：`feature/t68-execution-kernel` → `main`，squash 合并 `24ba09a`（2026-11-09T20:45:41Z），包含 12 文件 / +4,821 行（kernel execution、store/service/types/copy、实现文档）。

### 2.2 调度 UI（t69 → t71 → t107…t130 → t131）

| 轮次 | 任务 | 结论 | 关键输出 |
|------|------|------|----------|
| 首轮评审 | t71（ivy） | **needs_revision** | F1 恢复调度无二次确认 / F2 缺真机手测与 RunPanel 交互断言 / F3 不可用操作被隐藏 / F4 review_rejected tone / F5 新 Run/任务不播报 / F6 确认 textarea autoFocus / F7 aria-controls 悬空 |
| 修复 | t107（mika） | completed | resume 二次确认三入口统一；RunPanel/RunHistory/SchedulerBar SSR + 深链测试；操作常驻 disabled+title+aria-describedby；tone 补全；Announcer 新增 id 播报；`initialFocusRef`；队列容器 hidden 恒渲染 |
| 复审 | t108/t114/t118/t122/t127（ivy） | needs_revision（逐轮） | 持续发现 contextKey 重置吞播报、hidden CSS 被 display:grid 覆盖、重复 `useId`、act unmount、running 断言过宽等 |
| 修复 | t113/t117/t121/t126/t130（mika/ray） | completed | `.scheduler-queue[hidden]` 兜底；contextKey 独立 effect 静默重建基线（不吞播报）；rtr 组件级测试 + `IS_REACT_ACT_ENVIRONMENT`；scheduler 分帧用例；unmount 全部包 act + running 断言收紧「运行中 1 个」 |
| **终审** | **t131（ivy）** | **pass** | act 警告 0；running 断言可区分调度 running-count 与 Run 新增；paused/resume、任务/Run/workspace/message 用例无回归；PR #5 可进入集成 |

- **PR #5**：`feature/t69-execution-kernel-ui`，head `7aedd87`（9 commits），base `667a17c`；`mergeable=MERGEABLE`、`mergeStateStatus=CLEAN`；集成轮执行 `gh pr merge 5 --squash` → main `5f48405`（2026-11-09T22:02:03Z），26 文件 / +5,442 行。

> 说明：t70/t71 的原始任务记录保持 `failed`（首轮结论），其验收由后续修复链的 **t95 / t131 pass** 承接并完成合并，与 t64（t65 failed → t80/t81 pass → t66 集成）先例一致；t72 依赖中仅保留 t131，即取最新一轮复审 gate。

---

## 3. 最终代码映射（main `5f48405`）

### 3.1 内核

| 模块 | 文件 | 关键实现 |
|------|------|----------|
| 事件信封/注册表 | `src/kernel/execution/eventRegistry.ts` | EventV2（schema_version/idempotency_key/correlation/causation/occurred/recorded）；30 类事件 zod schema；`KERNEL_EVENT_SCHEMA_VERSION=2`；64KB payload 上限 |
| Task/Run 状态机 | `src/kernel/execution/stateMachine.ts` | 8 态迁移表；`INVALID_TRANSITION`；依赖 reason；review 语义 |
| 投影 | `src/kernel/execution/projections.ts` | task/run 投影、digest、按 seq 重放 |
| 内核 | `src/kernel/execution/kernel.ts` | 默认并发 4/1/1；ready 队列 + 优先级 + FIFO；pause/resume/cancel；单飞 tick + CAS；租约 60s/heartbeat 15s/watchdog；重试 5s×2ⁿ（上限 5min、jitter）；waiting_human/resume；reviewTask；`discardRun` stale-owner abort；`rebuildProjections` 分页 |
| 时钟/错误 | `clock.ts` / `errors.ts` | FakeClock 可测；KernelError 码表 |
| 迁移 | `src/kernel/store.ts` | v1→v2 增量 DDL；WAL checkpoint + backup + integrity_check；失败拒绝迁移（user_version=1）；旧事件 schema_version=1/时间回填；事件/投影/命令同事务 |
| 服务兼容 | `src/kernel/service.ts` | `runTask` 经内核入队并等待终态；`getTaskTrace` 聚合任务 + Run 事件；Router/成员/权限/审批/FT 行为不变 |

### 3.2 调度 UI / IPC

| 模块 | 文件 | 关键实现 |
|------|------|----------|
| 调度栏 | `src/SchedulerBar.tsx` | 运行中/排队、并发上限、暂停/恢复（确认）、暂停原因、队列展开（hidden 恒渲染 + useId）、loading/error（`role=alert`+重试） |
| Run 历史/时间线 | `src/RunHistory.tsx` | attempt 倒序、状态/成员/耗时/token/errorCode/心跳/租约/checkpoint；选中 Run 仅显示 `aggregateId=runId` 事件；空/加载/错误态 |
| Run 面板 | `src/RunPanel.tsx` | 默认关闭 Dock 面板：调度摘要 + 活跃 Run + 队列 + 当前任务 Run 历史 + 详情/时间线；操作常驻 disabled+原因 |
| 播报 | `src/KernelAnnouncer.tsx` | 任务/Run/调度变化 aria-live；首次挂载不播报；contextKey 切换静默重建基线；新增 id 播报 |
| 应用接线 | `src/App.tsx`、`TeamDashboard.tsx`、`TaskStarMap.tsx`、`CommandPalette.tsx`、`src/shell/dock/*` | 任务页调度/操作/确认；团队页 queued 段与入口；星图 queued/cancelled；Runs 面板注册（defaultClosed）；`#/tasks?t=&r=` 深链 |
| 纯函数/文案 | `src/shared/kernelUi.ts`、`src/shared/copy.ts`、`src/shared/deeplink.ts` | 操作 gate、attempt 文案、时间线摘要、调度摘要、确认文案、深链往返 |
| IPC | `electron/main.ts`、`electron/preload.ts`、`src/shared/ipc.ts` | `startTask/cancelTask/retryTask/reviewTask/listRuns/getScheduler/pauseScheduler/resumeScheduler` 等 KernelResult 通道；preload 只转发 |

---

## 4. 内核 AC 复核（t68/t83/t90/t94/t95）

| AC 组 | 结论 | 证据 |
|-------|------|------|
| AC-EV-01~09（事件/投影） | ✅ | 注册表 zod（未知类型/字段/枚举/超限拒绝）；seq 单调；幂等键；事务回滚；提交后通知；旧事件 1/新事件 2；correlation/causation；迁移测试断言 |
| AC-SM-01~13（Task 状态机） | ✅ | 8×8 矩阵/非法迁移；T22 原因更新写 `task.blocked` 且无 status_changed；依赖失败/取消传播；父重试成功子 ready；reviewPolicy auto/required |
| AC-RL-01~09（Run/租约） | ✅ | attempt 唯一递增；活跃唯一索引；心跳续租/30s 节流；checkpoint；waiting_human 与 t58 审批；CAS + `run.result_discarded`；stale-owner 6 类 abort；lease 过期 watchdog |
| AC-SC-01/02/05~12（调度） | ✅（SC-03/04 见 §7） | ready 集合；全局 4/工作区 1/成员 1；同文件串行；pause/resume/cancel；双 start 幂等；tick 单飞；beforeStart hook；计数从投影计算；autoAdmit 默认 false |
| AC-RC-01~08/10（失败/恢复） | ✅（RC-09 见 §7） | 可重试退避/耗尽/人工重试；崩溃租约回收；孤儿取消；重复活跃 Run 归一；恢复幂等；rebuild digest；blocked 下游自动 ready |
| AC-MG-01~08（迁移） | ✅ | v1 fixture 迁移+备份；任务归一；旧事件保留；重建一致；重复迁移幂等；备份失败拒绝且回滚；WAL integrity_check；schema_version/时间回填 |
| AC-API-01/03/05/06/07 | ✅（02/04 见 §7） | KernelResult 错误码；IPC 类型一致；暂停/恢复/取消/重试端到端；runTask 不绕过内核；命令+事件+投影同事务 |
| AC-E2E-01~05 | ⚠️ 见 §7 | 无独立 `kernel.e2e.test.ts`；调度/重试/恢复/依赖传播由 `kernel.test.ts` 分组覆盖，多任务 DAG 串行链路建议后续补端到端脚本 |

---

## 5. 调度 UI / ARIA / 窄 Dock 复核（t69/t107/t113/t117/t121/t126/t130/t131）

| 验收 | 结论 | 证据 |
|------|------|------|
| 调度/队列/Run/重试/阻塞状态可见、双编码 | ✅ | `KernelRuntimeUi.test` SchedulerBar 运行/排队、暂停原因；RunHistory attempt/状态/心跳/租约/token/错误；`kernelUi.test` 8 态计数、blocked 原因、failed 重试、queued 并发说明 |
| 实时更新无需刷新 | ✅ | `App.loadScheduler/loadRuns` + `onEvent` 220ms 防抖 refresh；`#/tasks?t=&r=` 深链集成测试 |
| 操作有确认/错误反馈/状态约束 | ✅ | retry/cancel/cancelRun/pause/resume/review 全部经 `KernelConfirmModal`（resume 由 t107 F1 补齐）；`kernelConfirmCopy` 纯函数测试；KernelResult 错误 + `role=alert` |
| Run 时间线字段完整 | ✅ | attempt/lease/heartbeat/token/error/checkpoint 字段；timeline 只取 `aggregateId=runId`；`kernelUi.test` timeline 1 例 |
| 失败/阻塞原因 + 下一步动作 | ✅ | `taskNextStep` 覆盖 blocked/failed/queued/running/review；任务页 inline hint; `kernelUi.test` 5 例 |
| 空态/错误态/加载态 | ✅ | SchedulerBar 错误态（role=alert+重试）、RunHistory 空态/加载态、RunPanel 空态；SSR 断言 |
| 键盘/ARIA/aria-live | ✅ | 原生 button/Modal；KernelAnnouncer 任务/Run/调度变化播报、contextKey 切 tab 后首个变化不吞、首次挂载静默；确认 Modal Esc/焦点陷阱/回焦（复用 Modal） |
| 窄 Dock / 无横向溢出 | ✅（自动证据） | `run-panel-body` 窄容器 SSR；container query 样式；`styles.css` 深链/队列/面板规则 |
| 现有 UI 无回归 | ✅ | main-only 28 文件/370 用例含 Dock/deeplink/星图/画布/Markdown 全绿 |
| 真机人工冒烟 | ⚠️ 见 §7 | 无窗口环境未执行 t71 11 项真机清单；t107 已补 SSR/深链自动证据替代 |

---

## 6. 三命令与回归矩阵（main `5f48405`）

### 6.1 命令

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | 0 | `tsc --noEmit` 无错误（main，含合并后的全部代码） |
| `pnpm build` | 0 | vite build + electron：`dist/assets/index-*.css` 210.30 kB（gzip 23.83 kB）、`index-*.js` 1,119.83 kB（gzip 308.13 kB）；`dist-electron/main.cjs` 1009.6 kB、`preload.cjs` 4.5 kB |
| `pnpm test` | 0 | 见下 |

### 6.2 测试计数

- **main-only 权威口径**：`cd S:\DeerSuperGroup && npx vitest run --dir src` → **28 文件 / 370 用例**全部通过；`not wrapped in act` 警告 **0**。
- **仓库根 `pnpm test`**：84 文件 / 1128 用例全部通过——包含 `branches/` 下 t69、t96 等 worktree 的测试（gitignore 目录但 vitest 仍扫描），与 t66 集成先例一致；`main-only` 为主要证据。
- 关键文件：`kernel.test.ts` 43、`KernelRuntimeUi.test.tsx` 20、`kernelUi.test.ts` 19、`permission.test.ts` 44、`approval.test.ts` 9 + `approval-wiring.test.ts` 2、`service.test.ts` 7、`deeplink.test.ts` 13、`TaskStarMap.test.ts` 5、画布/提问 40+、记忆 20+。

### 6.3 回归覆盖（main-only 28 文件）

- 内核：`src/kernel/execution/kernel.test.ts`
- 权限/审批：`permission.test.ts`、`approval.test.ts`、`approval-wiring.test.ts`
- 服务/模型：`service.test.ts`、`model.test.ts`、`openai.test.ts`
- 对话/画布/表单：`interactive.test.ts`、`kernel/interactive.test.ts`、`ChatContent.test.tsx`、`canvas/*.test.*`、`interactive/*.test.tsx`
- Dock/深链/星图/Markdown/模型列表/记忆：`deeplink.test.ts`、`TaskStarMap.test.ts`、`Markdown.test.tsx`、`models.test.ts`、`memory/*.test.ts`
- UI：`KernelRuntimeUi.test.tsx`、`shared/kernelUi.test.ts`

> 结论：Router/成员/权限/审批/Dock/星图/画布等既有能力测试全部通过；PR #5 未改内核/权限/审批文件，PR #2 未改变权限/审批语义（service 兼容包装 + 既有测试）。

---

## 7. 已知偏差、遗留与后续

### 7.1 设计 AC 未完全实现项（评审已接受，不阻塞集成）

1. **AC-API-02 命令级 `commandId` 幂等未暴露 IPC**：内核事件幂等键已实现；UI 以按钮 disabled + 内核状态校验兜底。后续在命令层统一 commandId。
2. **AC-SC-03 公平性老化（5min +1）与 AC-SC-04 严格成员轮转未实现**：已实现优先级 + FIFO + 每成员并发隔离；老化/轮转留作后续。
3. **AC-RC-02 人工重试总上限 10 未实现**：自动重试受 maxAttempts=3 约束；手动 retry 不封顶。
4. **checkpoint 仅元数据**：无 message/tool 结果快照，不支持断点恢复（设计 P2）。
5. **waiting_human 无专门 UI**：内核 + service 审批接线完成；UI 仅 `reviewPolicy=required` 的 review 按钮；waiting_human 入口未映射。
6. **AC-E2E-01~05 无独立 `kernel.e2e.test.ts`**：调度/重试/恢复/依赖传播由 `kernel.test.ts` 分组覆盖；多任务 DAG 端到端建议后续补自动化脚本。
7. **未实现事件归档/TTL**；投影范围不含 agents/messages/board/settings；agent.status 直接更新未写 agent 事件。
8. **Git 并行（PR #4）与 G3 `RunEnvironmentProvider` 尚未合并**：本集成仅覆盖内核 + 调度 UI；Git 集成由 t96/t102/t103 链路另行验收（t98）。

### 7.2 环境限制

- 本次无 Electron 窗口，未执行 t71 §9 的 11 项真机人工冒烟（运行/取消/重试/暂停/恢复、键盘焦点、窄 Dock、reduced-motion）。t107 已补 SchedulerBar/RunHistory/RunPanel SSR 交互断言 + 深链集成测试作为自动证据；截图仅 mock fixture（t69 文档 §9）。**发布前建议在真实 Electron 环境按清单补一次人工冒烟。**
- 主仓库 `pnpm test` 会扫描 `branches/` 下所有 worktree 测试；CI/验收应以 `--dir src`（或干净 checkout）为准。

### 7.3 后续项

1. t123/t124/t125：记忆系统工作台（独立链路，与本集成无耦合）。
2. t96/t102/t103/t98：Git 并行系统集成（含 G3 契约）；合并后需在最终 main 再跑一次三命令与回归。
3. 内核后续：命令级 commandId、checkpoint 恢复、公平性老化、事件归档/TTL、waiting_human UI、review 备注与审批 UI 统一。
4. UI 后续：真机人工冒烟、优先级编辑 IPC/UI、Run 面板默认布局选项、窄 Dock 实测。

---

## 8. 复现

```bash
cd S:\DeerSuperGroup
git log --oneline -2          # 5f48405 feat(ui): t69 ... (#5) / 667a17c ...
pnpm install                  # 需要 react-test-renderer@19.3.1（devDep）
pnpm typecheck                # exit 0
pnpm build                    # exit 0
npx vitest run --dir src      # 28 files / 370 tests（main-only）
pnpm test                     # 84 files / 1128 tests（含 branches/ worktree）
```

参考：
- 设计：`docs/team/execution-kernel-design.md` §4–§11、§16
- 内核实现：`docs/team/execution-kernel-implementation.md` §2–§11
- UI 实现：`docs/team/execution-kernel-ui.md` §3–§16
- 合并记录：PR #2（`24ba09a`，MERGED）、PR #5（`5f48405`，MERGED，head `7aedd87`）

---

> t72 集成验收完成：内核 + 调度 UI 已在 main `5f48405` 合并，三命令全绿，事件/状态/并发/重试/恢复/UI 全链路可追溯；§7 的 8 项偏差与真机人工冒烟为已披露遗留，不阻塞本次集成结论。
