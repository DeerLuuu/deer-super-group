# 任务执行内核 · 调度与运行可观测 UI（t69）

- **任务**：t69 — 实现：任务执行内核的调度与运行可观测 UI
- **模型路由**：`deepseek-official/deepseek-flash`（成员 ren）
- **分支 / worktree**：`feature/t69-execution-kernel-ui` / `branches/t69-execution-kernel-ui/`（基于 `origin/main` @ `24ba09a`，PR #2 合并后的内核）
- **设计依据**：`docs/team/execution-kernel-design.md`（t67 + t76：Q1 4/1/1、Q4 queued 可见、Q5 任务页调度栏、Q11 默认自动入队=false）、t68 实现文档与 service API、Dock/Modal/Toast/C12 现有结构
- **状态**：实现完成；typecheck / build / test 全绿；待独立评审 → 集成（本任务不做自我评审）
- **日期**：2026-11-10

---

## 1. 交付摘要

在 t68 内核（事件/状态机/调度器/Run 生命周期/恢复）之上补齐**可观测与可操作**的前端层，不修改 `src/kernel/`：

| 能力 | 实现 |
|---|---|
| 调度快照 | `getScheduler` IPC → `SchedulerBar`：运行中/排队、并发上限 tooltip、暂停/恢复、暂停原因、队列展开、loading/error + 重试 |
| 任务状态 | 任务列表新增 `queued` 过滤（共 8 态全部可筛）、attempt/优先级/排队时长、blocked/failed/queued/running 行内提示 |
| 任务操作 | 运行（入队）/重试/取消/批准/拒绝；全部走 `KernelResult`；确认弹窗 + 禁用原因 + toast + inline `role=alert` |
| Run 历史 | 任务详情 Run 区：attempt 倒序、状态/成员/耗时/token/errorCode；选中 Run 展示 attempt/lease/heartbeat/token/error/checkpoint/steps 与事件时间线 |
| Run 面板 | 新增 Dock「运行」面板（默认关闭）：调度摘要 + 活跃 Run + 队列 + 当前任务 Run 历史 + Run 详情/时间线；任务页/团队页/运行面板共享选中与深链 |
| 团队页 | 进度条新增「排队中」段、图例/卡片、`运行中 N · 排队 M` 状态与「运行面板」入口；选中任务「运行详情」直达 |
| 星图 | `queued`（+`cancelled`）状态徽章/筛选/图例/节点色；文案与状态 token 单一来源 |
| 深链 | `#/tasks?t=<taskId>&r=<runId>`；仅在 Run 面板激活时写 `r`，前进/后退/刷新恢复；不破坏 C12 既有 `#/tasks?t=`、`#/team?t=` 等 |
| 无障碍 | 调度栏/Run 行/浮层操作均为原生按钮；`role=alert` 错误；`KernelAnnouncer` 用 `role=status aria-live=polite` 播报任务/Run/调度变化；reduced-motion 关闭骨架动画 |
| 语义 | 任务状态用 `--status-*` token + 中文徽章；Run 状态使用独立 `run-status-*`（completed ≠ done），文字+颜色双编码 |

**边界**：不修改 `src/kernel/`；插件/MCP/Skills、watchdog 预算面板不在本任务；review 仅在 `kernel.reviewPolicy=required` 时出现。

---

## 2. 数据与 IPC（KernelResult）

`src/shared/ipc.ts` 新增（preload/main 对齐）：

```ts
startTask(taskId): Promise<KernelResult<Task>>
cancelTask(taskId): Promise<KernelResult<Task>>
retryTask(taskId): Promise<KernelResult<Task>>
reviewTask(taskId, decision, options): Promise<KernelResult<Task>>
cancelRun(runId): Promise<KernelResult<Run>>
listRuns(taskId): Promise<KernelResult<Run[]>>
getScheduler(workspaceId): Promise<KernelResult<SchedulerSnapshot>>
pauseScheduler(workspaceId, reason?): Promise<KernelResult<SchedulerSnapshot>>
resumeScheduler(workspaceId): Promise<KernelResult<SchedulerSnapshot>>
```

- `electron/main.ts` 新增 `handleKernel`：成功 `{ok:true,value}`；`KernelError.code` 原样透传，非内核异常归 `INTERNAL`；**不抛裸错误**。
- `electron/preload.ts` 仅做类型化通道转发。
- 渲染层 `unwrapKernel` 抛出带 `code` 的 `KernelUiError`，`KERNEL_ERROR_LABEL` 把稳定错误码翻译成中文前缀；**不解析 message**。
- 未扩展 `Snapshot.runs/scheduler`（t68 service 未填这两个字段，且 `src/kernel/` 为 t69 out-of-scope）：调度/运行数据通过独立查询 + `app:event` 220ms 防抖刷新获取，避免双份状态源。
- 渲染层每次内核动作后 `refresh`：snapshot + scheduler + 当前任务 Run 静默刷新；不要求用户手动刷新。

**IPC 文件范围例外**：t69 的 IPC 必须在 `electron/main.ts` / `electron/preload.ts` 接线（与 t58 同类跨进程例外一致），其余改动均在 `src/`、`docs/team/`；未改 `dist/`、`dist-electron/`、`src/kernel/`。

---

## 3. 任务页

### 3.1 调度栏（任务面板头部，非新 tab）

- 显示运行中 Run（scheduler.activeRuns）/排队数（scheduler.counts.queued）、`全局 4 · 每工作区 1 · 每成员 1`（t76 Q1）。
- 暂停/恢复：暂停经确认弹窗；运行中 Run 继续、队列不启动；操作 toast + `KernelAnnouncer` 播报。
- 队列可展开：标题/负责人/优先级/已等时长；键盘可聚焦；点击选中任务。
- 状态：首屏 skeleton；读取失败 `role=alert` + 重试；不阻塞任务列表。

### 3.2 任务列表

- 过滤：`全部 / 排队中 / 进行中 / 等待依赖 / 待运行 / 评审中 / 已交付 / 失败 / 已取消`（8 态 + all），计数来自 `statusCounts`。
- 行内：状态徽章（颜色+中文）、负责人、`尝试 N/3`（>3 显示 N 次）、依赖数、创建时间；queued/blocked/failed/running 增加语义提示（已等多久、阻塞原因、失败分类、第几次执行）。

### 3.3 任务详情

- 操作按状态约束（`taskActionState`）：
  - 运行：ready 或依赖已完成的 blocked；无成员/queued/running/review/done/failed 禁用并给 `title` 原因；默认手动入队（Q11）。
  - 重试：仅 failed；新建 attempt。
  - 取消：done/cancelled 之外；运行中的 Run 会被中止，确认弹窗说明下游影响。
  - 批准/拒绝：仅 review；拒绝必须填写备注；走 `reviewTask`。
- 运行信息网格：尝试、优先级、入队、开始/结束、阻塞/失败原因、依赖（未完成数）。
- 下一步解释：blocked 列出上游任务（可点击跳转）；failed 指向重试；queued 说明工作区串行；running 指向 Run 历史；review 说明 reviewPolicy。
- Run 历史（见 §4）与原有 trace 并存；trace 事件用中文类型标签与 `tone-*` 颜色。
- 错误：`role=alert` inline；toast error；aria-live 播报；确认弹窗复用 C25 Modal（Esc/焦点陷阱/回焦）。

---

## 4. Run 历史与时间线

`src/RunHistory.tsx`：

- 列表按 attempt 倒序；每行：`#attempt`、Run 状态徽章（文字+颜色）、成员、开始、耗时、token（入/出）、errorCode；行是原生 button，`aria-pressed`。
- 选中 Run 展示：
  - attempt、成员、model、权限、开始/结束、耗时、心跳（相对时间）、lease owner/到期、token（入/出）、steps、checkpoint step/ref、cost、errorCode；
  - error 详情（`role=alert`）、retryable；
  - 时间线只取 `aggregateId === runId` 的事件（不把任务级 tool 事件错配到 Run），显示时间/中文事件类型/actor/一行摘要。
- 三态：skeleton「正在加载 Run 记录…」；error `role=alert` + 重试；空态「还没有执行记录」。
- 操作：取消活跃 Run（确认）、失败任务重试、在 Run 面板打开；SSR 测试覆盖字段/空态/加载态。

`src/shared/kernelUi.ts` 提供纯函数：时间/耗时/attempt/token 格式化、`runTimelineEvents`、`eventTypeLabel`/`eventSummary`/`eventTone`、任务操作 gate、下一步解释、scheduler 摘要、aria 播报 diff。全部有单测。

---

## 5. Run Dock 面板（与设计 §9.5 的差异说明）

t67 设计 §9.5 写「Dock 布局不变；调度栏在 TasksView 内，不新增面板」，但本任务 contract 明确要求「任务页、团队页、Run 面板之间的联动与深链；窄 Dock 面板可用」。实现取折中：

- `panelRegistry` 新增 `runs` 面板：**defaultClosed=true**，默认布局/新建工作区布局不变；可由面板启动器、命令面板「打开 运行面板」、任务页「运行详情」、团队页「运行面板」打开。
- `routeTab = "tasks"`：打开时路由仍为任务；`r` 参数负责 Run 选中深链。
- 面板内：调度摘要 + 活跃 Run + 队列 + 当前任务 Run 历史 + 选中 Run 详情/时间线；任务/会话/任务页互跳；窄面板通过 `@container (max-width: 640px)` 改为上下堆叠。
- 该面板是任务域的子视图，不是新顶层 tab，默认不占布局，因此不改变设计 §9.5 的默认布局承诺。

---

## 6. 团队页 / 星图 / 跨页

- 团队总进度：新增 `queued` 段、图例、卡片；`运行中 N · 排队 M` 或「调度已暂停」；「运行面板」入口；选中任务「运行详情」打开 Run 面板并选中该任务。
- 星图：`queued` 状态进入筛选、图例、节点色（中性 slate，`--status-queued`）；`cancelled` 也补齐筛选/图例/颜色；不改变既有布局/交互。
- 跨页选中：App 级 `selectedTaskId`/`selectedRunId` 由任务页、团队页、Run 面板共享；任务页/团队页选择任务时清空 Run 选择，Run 面板内选择 Run 不改变任务选中。
- 深链：`parseHash` 增加 `run`（`r`）；`buildHash` 仅在 tasks 且 Run 面板激活时写 `r`；`onHashChange` 打开 Runs 面板并恢复选中；C12 既有深链测试更新且仍全绿。

---

## 7. 无障碍与键盘

- 所有操作是原生 `button`；Run 行/队列项/任务行可 Tab 聚焦；确认弹窗复用 `Modal`（Esc、焦点陷阱、回焦、`role=dialog`）。
- `KernelAnnouncer`：视觉隐藏 `role=status aria-live=polite aria-atomic=true`，播报任务状态变化（≤3 条）、Run 状态变化、调度暂停/恢复与运行/排队计数变化；首次快照不播报，避免刷屏。
- 错误区域 `role=alert`；暂停原因 `role=status`。
- `prefers-reduced-motion: reduce` 关闭 Run 历史骨架动画；未新增持续动画。
- 颜色只作为第二通道：任务/ Run 均有中文文字；`queued`/`cancelled` 使用独立 token 与文字。

---

## 8. 文件变更

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/SchedulerBar.tsx` | 新增 | 调度栏：计数/上限/暂停恢复/队列/三态 |
| `src/RunHistory.tsx` | 新增 | Run 列表、详情字段、事件时间线、空/加载/错误态 |
| `src/RunPanel.tsx` | 新增 | Dock 运行面板（调度+活跃/队列+历史+详情） |
| `src/KernelAnnouncer.tsx` | 新增 | aria-live 状态播报 |
| `src/shared/kernelUi.ts` | 新增 | 纯视图逻辑（时间/attempt/事件摘要/gate/scheduler/播报 diff） |
| `src/shared/kernelUi.test.ts` | 新增 | 16 项纯函数测试 |
| `src/KernelRuntimeUi.test.tsx` | 新增 | SchedulerBar/RunHistory SSR 4 项 |
| `src/App.tsx` | 修改 | scheduler/runs/run 选中状态、IPC 动作、确认弹窗、调度栏/Run 历史/面板接入、深链、播报 |
| `src/TeamDashboard.tsx` | 修改 | queued 统计/进度段/图例/卡片、运行面板入口、详情运行入口 |
| `src/TaskStarMap.tsx` | 修改 | queued/cancelled 筛选与图例 |
| `src/shared/ipc.ts` | 修改 | 9 个 KernelResult 命令/查询类型 |
| `src/shared/copy.ts` | 修改 | Run 状态/阻塞原因/失败分类/内核错误码单一映射 |
| `src/shared/deeplink.ts` + test | 修改 | `r=` 深链解析/生成/往返测试 |
| `src/shell/dock/panelRegistry.ts` / `DockShell.tsx` | 修改 | `runs` 面板注册（default closed）与深链补开 |
| `src/CommandPalette.tsx` | 修改 | 「打开 运行面板」命令 |
| `src/styles.css` | 修改 | 调度/Run/面板/token/窄面板/reduced-motion 样式（token 或 color-mix，无裸色） |
| `electron/main.ts` / `electron/preload.ts` | 修改 | 内核 IPC 接线（跨进程例外，已在 §2 说明） |
| `docs/team/execution-kernel-ui.md` | 新增 | 本文件 |

未改：`src/kernel/**`、`dist/**`、`dist-electron/**`。

---

## 9. 验证

最终在 `branches/t69-execution-kernel-ui/` 运行（结果以本文件提交前一次为准）：

| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm typecheck` | ✅ exit 0 | `tsc --noEmit` 无错误 |
| `pnpm build` | ✅ exit 0 | 397 modules；dist css 210.21 kB / gzip 23.81 kB；js 1,116.56 kB / gzip 307.11 kB；electron main 1009.6 kB、preload 4.5 kB |
| `pnpm test` | ✅ exit 0 | **23 文件 / 311 用例**（原 307 + 新增 kernelUi 16 + Run/Scheduler SSR 4；其中 t68 内核 289、t64 交互画布等基线全绿） |

测试重点：`src/shared/kernelUi.test.ts` 覆盖时间/attempt/操作 gate/下一步/调度摘要/Run 时间线/事件摘要/深链；`src/KernelRuntimeUi.test.tsx` 覆盖调度栏暂停/错误态、Run 历史字段/时间线/空态/加载态；`deeplink.test.ts` 覆盖 `r=` 往返且原有用例不回归。

### Mock fixture 视觉冒烟（本次已执行）

在无真实工作区数据的环境下，用 Electron + `window.deer` mock fixture 渲染 **构建产物**（`dist/index.html`），验证：

- `#/tasks?t=t1`：调度栏、queued 过滤/计数、任务详情（下一步/运行信息/取消任务）正常渲染；
- 任务详情滚动到底：Run 历史字段（attempt/lease/heartbeat/token/error/checkpoint）与事件时间线正常渲染；
- `#/tasks?t=t1&r=r1`：自动打开 Runs 面板并选中 Run，hash 保持 `r=r1`；截图为构建产物实际渲染（fixture 数据，非真实内核执行）。

截图（`docs/team/`）：

- [t69-task-scheduler.png](t69-task-scheduler.png)
- [t69-run-history.png](t69-run-history.png)
- [t69-run-panel.png](t69-run-panel.png)

> 该冒烟证明布局/渲染/深链接线，不替代真实内核端到端操作；真实 Electron 窗口下的操作冒烟仍按上方 11 项清单由 t71 执行。

### 人工冒烟清单（需有窗口环境，t71 评审可执行）

1. 任务页首屏：调度栏出现「运行中 0 · 排队 0」，无 console 错误。
2. 选一个 ready 任务 → 运行任务：toast「已入队」；状态徽章 queued；调度栏排队+1；无需手动刷新。
3. 运行中：Run 历史出现 running/心跳/token；等待事件推进后自动更新。
4. 失败（mock 模型返回错误）：失败原因、失败分类、Run 错误码/可重试；重试确认 → 新 attempt。
5. 运行中取消（任务级/Run 级）：确认弹窗 → 状态 cancelled/failed；下游依赖刷新。
6. 暂停调度 → 队列任务不启动；恢复 → 继续；aria-live（读屏）播报。
7. 任务详情「运行详情」→ Run 面板打开并选中任务；选中 Run 后 URL `#/tasks?t=...&r=...`；刷新/后退恢复。
8. 团队页：排队段/卡片与「运行面板」入口；选中任务可进运行详情。
9. 窄 Dock（拖窄运行面板/任务面板）：调度栏换行、Run 面板上下堆叠、无横向溢出。
10. 纯键盘：Tab 到调度按钮/队列项/Run 行；Enter 触发；Esc 关确认/浮层；焦点环可见。
11. reduced-motion 开启：Run 骨架无动画。

> 无头环境限制：本次以 typecheck/build/单测与静态渲染验证为主；第 9 节人工冒烟需在有窗口的 Electron 环境执行，t71 评审请按清单核对。

---

## 10. 已知边界 / 后续

- **调度器状态数据来源**：未扩展 `Snapshot`（内核 out-of-scope）；`getScheduler/listRuns` 独立查询 + 事件刷新。后续若 t68 把 scheduler/runs 放入 Snapshot，可移除独立查询，UI 无需改。
- **命令幂等**：t68 service 尚未暴露 `commandId`；本 UI 未做命令级幂等（t67 AC-API-02 属内核后续）。按钮 disabled + 内核状态校验兜底。
- **review**：仅 `reviewPolicy=required` 时出现批准/拒绝；默认 auto 不出现。review 备注必填仅在拒绝，符合设计 Q2。
- **优先级**：本任务只展示 priority；修改优先级（`setTaskPriority`）未接 IPC/UI，留待后续。
- **Run 面板**：默认关闭且不进入默认布局；若产品希望默认可见，只需把 `defaultClosed` 去掉并将 `runs` 加入默认组顺序（一行改动）。
- **任务级 trace 与 Run 级事件的边界**：Run 时间线只显示 `aggregateId=runId` 的事件；tool/assistant 任务级事件仍在任务 trace，避免错配。后续可在事件 payload 补 `runId` 做精确归集。
- **手动编辑 run 优先级/预算/看门狗**：属 t70+ 系统范围，本任务不实现。
- **无头环境人工冒烟**：见 §9；t71 评审应在有窗口环境执行，若发现视觉/焦点问题由本人后续修复。

## 11. t107 修复记录（repair-round-2，mika / GLM-5.3）

依据 t71 评审 F1–F7 在同一 worktree/PR 内修复，commit `ede4654`（已推送 origin/feature/t69-execution-kernel-ui，PR #5）。

| Finding | 修复 | 证据 |
|---|---|---|
| F1 恢复调度无二次确认 | ConfirmIntent 增加 `resume`；`handleRequestResumeScheduler` 统一 setPendingConfirm({kind:"resume"})（三处入口：SchedulerBar/RunPanel/任务页经 onResume 传入）；确认后执行 resumeScheduler；文案抽为纯函数 `kernelConfirmCopy`（含 resume，非危险样式） | kernelUi.test「kernelConfirmCopy：resume 有独立文案且 danger=false」 |
| F2 缺 Electron 手测/交互断言 | 无窗口环境不可跑 §9 清单 → 补 RunPanel/RunHistory/SchedulerBar SSR 交互断言 + 深链集成测试（窄容器 run-panel-body、错误态 role=alert、disabled 按钮、#/tasks?t=&r= 解析） | KernelRuntimeUi.test「t107 SSR 交互断言」4 条 |
| F3 操作按钮条件渲染 | 任务页与 RunPanel 的 运行/重试/批准/拒绝/取消 全部常驻渲染：disabled={!gate.enabled||busy} + title 原因 + aria-describedby 指向可见 inline 提示（task-action-hint / run-panel-action-hint）；RunDetail 取消 Run 同样常驻 + disabled + 原因 | KernelRuntimeUi.test F3 两条（failed 任务下按钮全在、hint 存在、非运行 Run disabled+原因） |
| F4 tone 映射缺失 | eventTone：task.review_rejected→error；run.cancelled/task.cancelled（含 cancelled 子串）→warn | kernelUi.test「关键事件 tone」9 断言 |
| F5 Announcer 新增 id 不播报、activeRuns 未纳入 | taskStatusAnnouncements/runStatusAnnouncements 对 previous 中不存在的新 id 以「新任务…/…新增（状态）」播报（首次快照 previous=null 仍不播报）；KernelAnnouncer 用 useMemo 合并 展示 Runs ∪ scheduler.activeRuns 后做 diff | kernelUi.test「任务/Run 新增 id 播报」+ 既有首次快照用例更新（c 为新增→3 条，第 3 条含「新任务」） |
| F6 评审备注 autoFocus | KernelConfirmModal 改传 Modal `initialFocusRef={notesRef}`（textarea ref），移除 autoFocus | App.tsx KernelConfirmModal（结构变更；焦点行为由 Modal first-focus 保证） |
| F7 队列容器条件渲染致 aria-controls 悬空 | SchedulerBar 队列容器在 queued>0 且非 compact 时始终渲染，关闭时 `hidden={!queueOpen}`；aria-controls 指向的 id 恒存在 | KernelRuntimeUi.test F7（html 匹配 `id="scheduler-queue"` 且 hidden 属性存在） |

**验证（worktree 实跑，commit ede4654）**：`pnpm typecheck` 0；`pnpm build` 0；`pnpm test` 23 文件 / **318 用例全过**（t107 新增 kernelUi 4 用例 + KernelRuntimeUi SSR 4 用例；既有「任务状态变化播报」用例按 F5 行为更新）。提交流程：pnpm branch:sync（Already up to date）→ push（306c7c0..ede4654）。

**t72 前证据**：本节表格即 F1–F7 → 修复/测试映射；无法在本环境执行有窗口 Electron §9 清单，SSR+深链断言按验收第二条的替代路径提供证据，剩余真机手测项仍见 §10 人工冒烟清单。
