# Chat → Plan Draft · 独立验证报告（t232）

- **任务**：t232 [verification] 独立验证 t231 P0-4 Chat→Plan Draft
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #37 `feature/t231-plan-draft`，HEAD `9603932`（OPEN/MERGEABLE；worktree `branches/t231-plan-draft`，clean）；未合并，未修改生产代码。
- **方法**：worktree 复跑三命令 + 读 shared/planDraft、kernel preview/confirm、PlanDraftPanel、App 入口 + 测试。

---

## 1. 结论：**BLOCKED（不通过，needs revision）**

Chat 新入口本身成立：捕获 goal/对话/摘要/overview，preview 只读，draft 可编辑/校验，confirm 单事务+幂等。但 **P0-4 的“确认前不创建任务”只覆盖 Chat 新入口，旧规划路径仍可绕过 draft 直接建任务**：

- Tasks 页三处「规划任务」仍 `setPlanOpen(true)` → `RouterPlanModal` → `onPlan={handlePlan}` → `window.deer.plan` 立即创建任务；
- WorkflowRail 的 plan CTA 由 `workflowStageNavigation("plan")` 返回 tasks，不打开 planDraft；
- CommandPalette/“＋新建→规划”仍走 `autoOpen="plan"` 的旧 RouterPlanModal。

t231 输出声称“WorkflowRail 计划 CTA、Tasks 旧规划按钮重定向”，但代码未实现。**F1/F2 为 blocker**；因此“打开/取消零 task/run 副作用”“统一确认入口”对全应用不成立。其余 draft/confirm/测试主体通过；三命令全绿（71/678）。

---

## 2. 命令（worktree HEAD `9603932`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 418 modules；css 253.49 kB (gzip 30.93)；js 1,257.86 kB (gzip 346.39)；electron main 1.5MB/preload 11.7kB |
| `pnpm test` | **0** | **71 文件 / 678 用例**全绿；planDraft 4、kernel planDraft 4、PlanDraftPanel 2、workflowStageNavigation 2 |

---

## 3. 逐项验证

### 3.1 Chat 入口/零副作用（部分 PASS，全局 FAIL）

Chat 路径：

- `handlePlanFromChat` 捕获 `goal=chatInput || lastUser`、非 system messages、system summary、overview；`buildPlanSource` 生成 digest/characterCount；`openPanel("planDraft")`；`loadPlanPreview`。
- `previewPlan` 只读：kernel test 成功 preview 后 tasks/events 数量不变；source 超限返回 issue、零 task。
- `handleCancelPlan` 清 source/draft/issues/error，不 createTask/run；`PlanDraftPanel` 打开/取消无可写路径。
- Chat 按钮 disabled 条件正确；source 超限/空源阻断。

**但旧路径仍可绕过（F1/F2）**：

- `TasksView` 三处 `setPlanOpen(true)`（`App.tsx:3851/3898/4012`）；
- `RouterPlanModal onPlan={onPlan}`（`:4313`），App 传 `onPlan={handlePlan}`（`:3019`）；
- `handlePlan` 直接 `window.deer.plan(...)`（`:1913`）→ 旧 API 立即创建 task，无 draft/确认。
- `WorkflowRail` plan CTA：`workflowStageNavigation` 对 plan 返回 `{panel:"tasks"}`（`App.tsx:281-292`），不打开 planDraft。
- `PlanDraftPanel` only Chat entry; old Tasks/Workflow/CommandPalette 仍暴露。

### 3.2 Draft 字段/依赖/owner/契约/增删排序（PASS）

- `PlanDraftPanel`：标题/描述/验收/owner/priority/risks/unknowns、dependencies checkbox、contract chip（owner model/permission 只读）、上移/下移/删除/添加。
- `addTask` 生成 draft id；`moveTask` 交换顺序（依赖按 ID，不受顺序影响）；`removeTask` 同时清理其他任务对它的依赖。
- `PlanDraftPanel.test` 覆盖 source/contract/add/confirm/cancel、高风险/错误禁用；无 owner warning/empty acceptance warning 由 shared validate 测试覆盖。
- owner 可空（warning），确认后 Tasks 未分配；空验收 warning，不阻断；契约 chip 只读，符合 t230 裁决。

### 3.3 校验（PASS）

- `validatePlanDraft`：空 plan、任务数>12、空 title、priority 非法、重复 title warning、空 acceptance warning、无 owner warning、owner 不存在 error、自依赖、缺失依赖、cycle；`hasCycle` DFS。
- shared test 覆盖 empty/cycle/missing/self/owner/acceptance；kernel confirm 再次校验 cycle/high-risk；UI `handlePlanDraftChange` 每次编辑重算 issues，`canConfirm` 要求 errors=0。
- 环/缺失/自依赖/空标题/无 owner 均就地显示；高风险 ack 阻断（服务端再次校验）。

### 3.4 确认一次创建/双击幂等/失败不部分写入（PASS，含 low caveat）

- `confirmPlan` 在 `store.withTransaction` 内 `createTask` 全部任务、写 dependsOn/priority/owner、`appendEventIdempotent` `router.plan`；任一 throw 回滚。
- 同 `idempotencyKey` 已有事件 → 返回同一 task IDs + `alreadyConfirmed:true`；kernel test 确认 tasks 数量不增加、IDs 相同。
- cycle/高风险未 ack 在写事务之前抛错，零写入；test 确认 tasks 数不变。
- 成功后 App `refresh`、选首任务、关 planDraft、开 tasks、toast；双击 `planConfirming` + 服务端 key 双重保护。
- **N4 low**：没有注入 createTask/append 失败的事务回滚测试；代码路径是 transaction，但未证明“部分写入不发生”的全故障面。

### 3.5 rail/Dock/deeplink/960/aria（部分 FAIL）

- `planDraft` 注册为 Dock 面板（defaultClosed、minWidth 560、routeTab null）；未新增 PrimaryRail 入口/宽度列；1440/960 截图显示 tab/单列。
- 但 **WorkflowRail plan CTA 不打开 planDraft**，仍回 Tasks；Tasks/CommandPalette 旧规划路径仍可用（F2），违反“计划入口统一到 draft”。
- `PlanDraftPanel` 是 section（非 Modal），有 aria-label/source/issues/role alert/status；输入有 label/aria-label，标题错误 `aria-invalid`；依赖 checkbox/owner select 原生可键盘。
- **N3 low**：issues 列表无 aria-live/aria-describedby；新增/删除后焦点未管理；PlanDraftPanel 测试只覆盖 add/confirm/high-risk，不覆盖依赖 checkbox/上下移/文本编辑的 aria/键盘负例。

### 3.6 范围/gate（PASS）

- PR #37 文件：shared/planDraft、kernel service、IPC/preload/main、App、PlanDraftPanel、panelRegistry、styles、tests/docs；未改 review/merge gate、权限、任务状态机、Dock schema。
- `previewPlan`/`confirmPlan` 使用现有 tasks 表/`router.plan` 事件；无 PlanDraft 表/第二任务数据源；legacy `router.plan` API 保留。
- 三命令 0/0/0，71/678；无 gate 回归。

---

## 4. 发现

| ID | 级别 | 发现 | Required fix |
|----|------|------|--------------|
| **F1** | **blocker** | 旧 Tasks 规划按钮仍 `setPlanOpen(true)` → RouterPlanModal → `handlePlan` → `window.deer.plan` 立即建任务，绕过 draft/确认；Chat 以外的入口零副作用不成立 | 所有 UI 规划入口统一到 `handlePlanFromChat`/planDraft；`handlePlan` 仅保留 legacy 非 UI 路径或删除；Tasks 按钮禁用/重定向；补“旧按钮不创建 task”测试 |
| **F2** | **high** | WorkflowRail plan CTA 由 `workflowStageNavigation` 返回 tasks，不打开 planDraft；CommandPalette plan 仍 autoOpen 旧 Modal；t231 声称的 redirect 未实现 | plan stage 返回 `planDraft`/`handlePlanDraft`；CommandPalette plan 改进入 planDraft；更新 workflowStageNavigation.test |
| F3 | medium | `previewPlan`/`confirmPlan` 的 source 只信任 UI 传入 digest/characterCount；服务端 confirm 不再校验 source 大小/空源；直接 IPC 可提交超限 source tasks | confirm 校验 sourceDigest/来源元数据或由服务端重新构造 source；补 IPC 边界测试 |
| F4 | medium | 无 createTask/append 失败的事务回滚故障注入测试；部分失败不发生仅由代码路径推断 | 注入 store 失败/事件冲突，断言 tasks/events 零增量 |
| F5 | low | PlanDraftPanel issues 无 aria-live/aria-describedby；新增/删除后焦点无管理；依赖/排序编辑无 a11y 回归 | 补 aria-live/describedby + focus；补依赖/上下移键盘测试 |
| F6 | low | `handleCancelPlan` 不取消在途 preview；cancel 后 preview resolve 仍可能回填 planDraft（面板已关，重新打开可见） | 加 request id/abort 或 cancel 后忽略结果 |
| F7 | low | addTask id 用 `Date.now` + index，快速添加可能重复；owner/empty acceptance 仅 warning（设计裁决） | 用递增 id；保持 warning 可接受 |

---

## 5. 结论

- Chat Plan Draft 的 source/preview/edit/validation/confirm/幂等主体成立；三命令全绿。
- **F1/F2 是 P0-4 的核心入口一致性 blocker**：Tasks/WorkflowRail/CommandPalette 仍可绕过 draft 直接建任务，违背“确认前不创建任务”和 t231 声明的重定向。
- PR #37 需 repair F1/F2（建议 F3/F4/F5 同批）后重验；本次未修改生产代码。

*本次验证仅新增本报告。*
