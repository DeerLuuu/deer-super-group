# P0-4 评审：Chat→Plan Draft（t233 / t231 + t235）

- **评审人**：ivy
- **基线**：`main 53862c9`；PR #37 / `feature/t231-plan-draft` HEAD `2dd9519`
- **范围**：Plan Source、Preview、PlanDraftPanel 编辑/校验、Confirm 事务/幂等、入口/Dock/960/aria、与现有 plan/createTask 的复用
- **方法**：当前 worktree 静态代码 + 定向阅读 + 独立三命令；未修改生产代码
- **结论**：**needs_revision**；6 项 findings（3 high、3 medium）。零副作用/事务回滚/幂等主路径成立，但 draft 生命周期与 source 边界仍有可导致“确认旧草案/无法恢复草案/绕过 source 上限”的缺口。

---

## 1. 独立验证

```text
pnpm typecheck  # exit 0
pnpm build      # exit 0（418 modules；css 253.49 kB / gzip 30.93；js 1,257.79 kB / gzip 346.58）
pnpm test       # exit 0（72 files / 684 tests）
```

- PR #37：OPEN / MERGEABLE；worktree clean。
- 测试命令未加 `--testTimeout=10000`；本次独立运行 684/684 通过。
- 代码范围：`shared/planDraft`、`kernel/service` preview/confirm、`PlanDraftPanel`、App 入口/状态、Dock panel、electron IPC、docs；未改 review/merge gate、权限、任务状态机。

**已确认通过**
- `previewPlan` 成功/失败均不创建 task、不写 `router.plan`；kernel test 对 tasks/events 数量断言。
- `confirmPlan` 在 Store 事务内创建整张 DAG；owner/priority/dependencies 正确；同 key 返回同 IDs/`alreadyConfirmed`；cycle/high-risk/空 source 零写；createTask 第二个失败、append 失败均回滚。
- 所有 UI 入口（Tasks 三处/autoOpen plan、WorkflowRail、CommandPalette plan）均进入 Plan Draft；App 无 `window.deer.plan`/`RouterPlanModal`/`setPlanOpen`。
- source 空/12k 阻断、digest 字段检查、PlanDraftPanel goal/aria-live/error role、首标题 focus、previewToken（preview=true/goal 修改/cancel）均有实现或测试。
- 无 PlanDraft 表/第二任务源；复用现有 tasks/router.plan 事件；960 CSS 单列与截图存在。

---

## 2. Findings

### F1 · Draft 生命周期缺少 dirty 守卫与恢复入口（high / P1）

**问题**：Plan Draft 是“会话内可恢复”的编辑面，但当前：
- `PlanDraftPanel` 的「取消」直接 `onCancel`；`handleCancelPlan` 立即清空 source/draft/issues 并打开 Chat，**没有 dirty 二次确认**；
- 从 Chat/Tasks/Workflow/CommandPalette 再次规划会调用 `openPlanDraft`，**直接 `setPlanDraft(null)` 覆盖已有编辑**；
- `planDraft` 不在 `PANEL_LAUNCHER_KEYS`，`routeTab: null`；Dock tab 关掉后，App 内存里即使还留着 draft，**没有可见入口重新打开**（Chat 入口/Tasks 入口都会重置 draft，而不是恢复）；设计要求的 Chat 摘要 card 未实现；
- `resetForWorkspace` 未清 `planSource/planDraft/planConfirmKeyRef`；切换 workspace 后旧草案仍留在内存，若面板仍可见/后续状态复用，存在跨 workspace 确认旧 source 的风险；
- `#/chat`/`#/tasks` 深链未对 dirty draft 做确认（设计 §8.3）。

**证据**：
- `src/shell/PlanDraftPanel.tsx:127-131`（取消直接 onCancel）
- `src/App.tsx:1974-1979`（openPlanDraft 直接清 draft）、`:2053-2060`（handleCancelPlan 无确认）、`:1510-1552`（resetForWorkspace 无 plan 清理）、`:153-164`（PANEL_LAUNCHER_KEYS 不含 planDraft）
- `src/shell/dock/panelRegistry.ts:149-159`（routeTab null、defaultClosed）
- 设计 `docs/team/chat-plan-draft-design.md` §4.2（取消/关闭 dirty 确认、关闭不丢草案）与 §8.3

**影响**：误点取消/关闭/再次规划会丢编辑；关闭后无法恢复；workspace 切换后旧草案可能被错误复用；这是 AC-07/AC-10 的缺口。

**验收句**：**有未确认编辑时，取消、Dock 关闭、入口重开、#/chat/#/tasks 深链与 workspace 切换都必须先确认丢弃或保留可恢复草稿；关闭 Dock 后必须有可见的恢复入口（launcher/Chat 摘要 card），且 workspace 切换不得复用旧 source。**

### F2 · `openPlanDraft(preview=false)` 未失效旧 preview（high / P1）

**问题**：`openPlanDraft` 在 `preview=false` 时不清 `planPreviewTokenRef`；若旧的 Chat preview 仍在途（例如随后 `/clear` 清空对话，再从 Tasks/Workflow 打开空 source，preview=false），旧响应仍会通过 token 校验并 `setPlanDraft(oldDraft)`。此时面板 source 是新的空 source，draft 是旧 source 的任务；`handleConfirmPlan` 使用 `planDraft.source`（旧）确认，用户可在“空来源”面板里创建上一段对话的任务。

**证据**：`src/App.tsx:1917-1946`（loadPlanPreview token 只在 preview 调用时递增）、`:1974-1979`（preview=false 不递增/token 不取消）；t236 N1 已记录同类风险，但未修复。

**验收句**：**每次 openPlanDraft（无论 preview true/false）都必须先使在途 preview 失效（token 递增/Abort），旧响应不得回填新面板；补“旧 preview 晚到不覆盖新 entry”的组件/集成测试。**

### F3 · Goal 清空回退 composer/最近 user（medium / P2）

**问题**：`planSourceFromChat(goalOverride)` 使用 `goalOverride?.trim() || chatInput.trim() || lastUser?.content || ""`。用户在 PlanDraftPanel 把目标清空时传 `""`，函数回退 composer 或最近 user；`goalSource` 仍标记 `"edited"`。用户无法清空目标，source 与用户当前编辑值不一致，也让“显式空目标 → SOURCE_EMPTY”的语义无法出现。

**证据**：`src/App.tsx:1950-1971`；`PlanDraftPanel.tsx:118-124`（goal textarea 直接 onGoalChange）。

**验收句**：**区分 goalOverride===undefined（未编辑，回退 composer/last user）与空串（用户显式清空，保留空 goal 并显示 SOURCE_EMPTY）；goalSource 不误标 edited；补空目标交互测试。**

### F4 · Confirm 服务端信任客户端 characterCount/digest（high / P1）

**问题**：`previewPlan`/`confirmPlan` 的 source 来自 renderer；`planSourceIssues` 直接使用 `source.characterCount`，`confirmPlan` 只比较 `input.source.digest === input.sourceDigest`，**不根据 source 内容重新计算**。因此：
- 可发送 >12k 的 messages，而把 `characterCount` 写成 1，绕过 source 上限进入 planner/confirm；
- 可修改 source 内容但保留 digest，`PLAN_SOURCE_CHANGED` 不触发；
- source 的“100% 带入 + 超限阻断”只在 UI 路径成立，服务端契约不成立。

**证据**：`src/shared/planDraft.ts:118-143`（planSourceIssues 读 characterCount）、`:132-143`（digest 由 build 计算但服务端不复算）；`src/kernel/service.ts:1941-1952`；测试 `src/kernel/planDraft.test.ts` 只手工设置 `characterCount: 12_001` 的 positive 路径，无伪造 count/digest negative。

**验收句**：**服务端必须从 source.goal/messages/summary/overview 重新计算 characterCount 与 planDigest；超限/内容变化在 preview 与 confirm 均零写拒绝，并补伪造 characterCount/旧 digest 的测试。**

### F5 · Owner Router 与孤立任务校验偏离设计（medium / P2）

**问题**：设计 §5 把 Router owner 定为 warning（允许但提示），AC-04 把“孤立”列为 warning；实现：
- `validatePlanDraft` 的 `ownerIds` 明确排除 `isRouter`，Router owner 得到 `TASK_OWNER_MISSING` **error**；PlanDraftPanel owner select 也过滤掉 Router，用户无法在 UI 选 Router；
- 没有孤立任务（无上游/下游）warning；`topologicalLayers` 也未实现；
- owner Router 的提示文案/契约 source 无法出现。

**证据**：`src/shared/planDraft.ts:182/199-202`；`src/shell/PlanDraftPanel.tsx` owner select 的 `filter(agent => !agent.isRouter)`；设计 §5 table `OWNER_ROUTER` warning。

**验收句**：**Router owner 必须按设计成为可见 warning（或明确变更设计并同步 docs/AC）；孤立任务给出 warning；owner select/校验与文档一致，并补对应测试。**

### F6 · 高风险 ack 不随 draft/source 重置；issues 无 live/focus 关联（medium / P2）

**问题**：
- `PlanDraftPanel` 的 `ack` 是本地 state，未随 `draft.source.digest`/tasks 变化重置。用户对旧高风险草案勾选“我已确认”，重新生成/导入新高风险草案后仍为 true，`canConfirm` 直接放行；服务端只收到 `ackHighRisk=true`，无法区分确认的是哪一版草案。
- issues `<ul>` 无 `aria-live`/`aria-describedby`，confirm 按钮 disabled 时未关联错误摘要；增删任务后焦点统一回首个 title，新任务不一定获得焦点（t236 N3/N4 已记录，未修）。

**证据**：`src/shell/PlanDraftPanel.tsx:51/56/336`（ack/useEffect）、`:270-280`（issues ul）、`:344-349`（confirm 按钮无 aria-describedby）；`src/App.tsx:2005-2012`（fingerprint 更新但不重置 ack）。

**验收句**：**高风险 ack 在 source digest 或 draft fingerprint 变化时重置；issues 变化通过 aria-live/aria-describedby 播报并关联 confirm；增删/移动后焦点落到新增或受影响任务。**

---

## 3. 验收映射

| 验收 | 结果 | 证据/缺口 |
|---|---|---|
| 零副作用/带入/取消/幂等 | failed | preview/confirm 主路径通过；F1 draft 生命周期、F2 旧 preview、F3 goal 清空破坏带入/取消一致性 |
| 依赖/owner/验收/契约校验 | failed | 环/缺失/空 title/priority 阻断；F5 Router owner/孤立任务偏离设计 |
| Confirm 复用现有 API，无第二数据源 | passed | tasks 表/router.plan/既有 owner/depends/priority；无 PlanDraft 表 |
| 失败/部分失败语义 | passed | createTask 第二个/append 失败均 tasks 零增量；cycle/high-risk 零写 |
| rail/Dock/深链/960/aria 无回归 | failed | 入口统一、960 截图、基础 aria 通过；F1 关闭后无恢复、深链无 dirty 确认；F6 a11y |
| 三命令 | passed | typecheck/build/test 0/0/0；72/684 |
| 无越界 | passed | 未改 gate/权限/状态机；改动集中于 planDraft 链路 + IPC/docs/tests |

---

## 4. 结论

**needs_revision**。核心设计（preview 只读、confirm 单事务、幂等、无第二事实源）已实现且测试扎实，但 F1/F2/F4 会分别导致 draft 丢失/无法恢复、旧草案误确认、source 上限与 digest 可绕过；F3/F5/F6 是带入/校验/a11y 的明确缺口。建议先修 F1–F4，再复审；F5/F6 可在同一 repair 或紧随的 P2 修复中处理。
