# P0-4 复审 round-2：Chat→Plan Draft（t238 / t237）

- **评审人**：ivy
- **基线**：`main 53862c9`；PR #37 / `feature/t231-plan-draft` HEAD `1912e06`
- **本次复审**：t237 repair-round-2（draft session、preview gate、source metrics、owner/orphan、a11y）
- **三命令**：typecheck 0 / build 0（419 modules；css 253.49 kB/gzip30.93；js 1,260.95 kB/gzip347.56）/ test 0（73 files / 690 tests）
- **结论**：**needs_revision**；1 blocker + 2 high/medium + 2 medium/low。t237 修复了 F1–F6 的大部分，但 PlanDraftPanel 的 focus effect 在普通编辑时抢焦点，以及编辑 goal 直接清空 draft，仍是主路径阻断。

---

## 1. 已验证的 t237 修复

- **Draft session**：取消有确认；Dock 关闭保留草案并加入 launcher；入口替换确认；deep-link/workspace 切换确认；workspace reset 清 plan 状态；`PANEL_LAUNCHER_KEYS` 含 planDraft。
- **Preview gate**：`openPlanDraft` 始终 invalidate；晚到响应 token 丢弃；goal/重新生成/取消/invalid 均失效。
- **Source metrics**：`planSourceMetrics` 从 goal/messages/summary/overview 重算 characterCount/digest；`SOURCE_COUNT_MISMATCH`/`SOURCE_DIGEST_MISMATCH`/`SOURCE_TOO_LARGE` 在 preview/confirm 零写；伪造 count/digest 测试通过。
- **Owner/orphan**：Router owner 改为 `TASK_OWNER_ROUTER` warning；`TASK_ORPHAN` warning；测试覆盖。
- **a11y/ack**：ack 随 draft/source 变化重置；issues 加 `aria-live`；任务标题有 `aria-describedby`；首 draft/增删移动 focus 逻辑；测试 5 项。
- **零副作用/事务/幂等**：preview 只读；confirm 事务、owner/priority/deps、同 key replay、create/append 失败回滚、cycle/high-risk 零写均通过。
- **无第二数据源**：仍复用 tasks/router.plan；无 PlanDraft 表；未改 gate/权限/状态机。

---

## 2. Findings

### F1 · PlanDraftPanel 每次普通编辑都把焦点抢回首标题（blocker / P0）

**问题**：`PlanDraftPanel` 的 focus effect 依赖 `draft?.tasks`（数组引用）：
```ts
useEffect(() => {
  const pending = pendingFocusRef.current;
  if (pending) { ... return; }
  if (!busy && draft?.tasks.length) firstTitleRef.current?.focus();
}, [busy, draft?.source.digest, draft?.tasks]);
```
`patchTask` 每次 onChange 都 `onDraftChange({ ...draft, tasks: draft.tasks.map(...) })`，产生新的 tasks 数组；effect 随即执行，`pendingFocusRef` 为空时把焦点移到**第一个任务标题**。因此：
- 在描述/验收/owner/priority/风险/unknown/依赖里输入一个字符，焦点跳回首标题；
- 用户无法连续编辑非标题字段；键盘/读屏主路径被直接破坏；
- 现有测试只验证“draft 到达时聚焦首标题”，没有验证普通输入保持焦点。

**证据**：`src/shell/PlanDraftPanel.tsx:59-74`（effect）、`:63-70`（patchTask 新数组）、`:199-210`（任务标题 ref）；测试 `PlanDraftPanel.test.tsx` 只有 draft 到达 focus 断言。
**影响**：AC-03/AC-11（可编辑/纯键盘主路径）不成立。
**验收句**：**在任意非标题字段（描述/验收/owner/priority/风险/unknown/依赖）连续输入时焦点保持在当前字段；只有 draft 首次到达、增删/移动目标时才显式移动焦点；补输入保持焦点的组件测试。**

### F2 · 编辑 goal 立即清空已编辑 draft，无确认（high / P1）

**问题**：PlanDraftPanel 的 goal textarea 每次 onChange 调用 `onGoalChange`；App 的 `handlePlanGoalChange`：
```ts
const next = planSourceFromChat(goal);
setPlanSource(next);
setPlanDraft(null);      // 直接丢弃所有任务编辑
setPlanIssues(...);
setPlanError(null);
invalidatePlanPreview();
```
用户修改目标时，已编辑的任务标题/描述/验收/依赖/owner/priority 会立即消失，没有“重新生成会丢弃草案”的确认；也没有保留旧 draft 供“确认旧源”的选择。设计 §6/§8.3 要求 source 变化先提示/确认，确认旧源或重新生成。

**证据**：`src/App.tsx:1997-2002`；`src/shell/PlanDraftPanel.tsx:118-124`（goal onChange 直接上调）。
**影响**：AC-03/AC-07/AC-11；用户主路径改目标即丢草稿。
**验收句**：**goal 修改不得静默丢弃已编辑 draft：应先提示“重新生成会丢弃”并允许取消，或保留 draft/禁用确认直到显式重新生成；补 goal 修改不丢 draft 的交互测试。**

### F3 · Router owner 在 PlanDraftPanel 无法选择（medium / P2）

**问题**：t237 校验已把 Router owner 改为 `TASK_OWNER_ROUTER` warning，但 PlanDraftPanel 的 owner select 仍 `agents.filter(agent => !agent.isRouter)`；只有当前 draft 已经是 Router owner 时才追加一个只读 option（`if (task.ownerId && ...isRouter)`）。从 owner=null 的用户无法主动选 Router，设计“Router warning 允许”的交互没有闭环。

**证据**：`src/shell/PlanDraftPanel.tsx:249-264`；`src/shared/planDraft.ts:199-213`（validator warning）。
**验收句**：**PlanDraftPanel 的 owner select 与 validator 一致：Router 可作为可见选项并显示“不建议”warning，或明确文档/AC 改为禁止；补 owner=Router 的 UI 测试。**

### F4 · confirm 按钮无 aria-describedby 关联 issues（low/medium / P3–P2）

**问题**：t237 给任务标题加了 `aria-describedby`，但 confirm 按钮 disabled 时没有关联 `plan-draft-global-issues` 或对应错误摘要。读屏用户聚焦 disabled confirm 时听不到“为什么不能确认”；t237 文档声称 issues live/describedby，但只覆盖标题。
**证据**：`src/shell/PlanDraftPanel.tsx:344-349`（confirm 无 aria-describedby）、`:355-368`（global issues id 已存在）。
**验收句**：**confirm 按钮在 disabled 时通过 aria-describedby 指向当前错误摘要；错误/警告变化可被播报，且不依赖视觉色。**

### F5 · ack 随每次任务编辑重置（low / P3）

**问题**：`useEffect(() => setAck(false), [draft?.source.digest, draft?.tasks])` 对每次 `patchTask` 新数组都重置高风险确认。安全上可接受，但用户勾选 ack 后编辑任一任务（描述/验收）就需重新勾选；与“确认的是当前 draft 版本”一致，但应在 UI 明确提示，否则容易被误认为控件失效。
**证据**：`src/shell/PlanDraftPanel.tsx:59-64`；t237 未在 ack label 旁提示“编辑后需重新确认”。
**验收句**：**ack 重置时给用户可见提示（或只在 source/draft fingerprint 改变时重置，并解释）；补 ack 重置的交互文案测试。**

---

## 3. 验收映射

| 验收 | 结果 | 说明 |
|---|---|---|
| 零副作用/带入/取消/幂等 | failed | preview/confirm 事务/幂等通过；F1 编辑抢焦点、F2 goal 修改丢 draft 使“可编辑带入”不成立 |
| 依赖/owner/验收/契约校验 | failed | 环/孤立/Router warning 在 validator 通过；F3 UI 无法选择 Router |
| Confirm 复用现有 API，无第二数据源 | passed | 复用 tasks/router.plan；无 PlanDraft 表 |
| 失败/部分失败语义 | passed | create/append 注入回滚；cycle/high-risk/source 零写 |
| rail/Dock/深链/960/aria 无回归 | failed | 入口/960/Dock close/preserve 通过；F1/F4 keyboard/aria；F2 goal 丢 draft |
| 三命令 | passed | 0/0/0；73/690 |
| 无越界 | passed | 未改 gate/权限/状态机；planDraft 链路为主 |

---

## 4. 结论

t237 已把 session gate、source 重算、owner/orphan、ack/issues live 等修复到位，主路径比 t233 明显改善。但 **F1 是 blocker**：普通编辑时焦点被抢回首标题，用户无法完成非标题字段编辑；**F2 是 high**：编辑 goal 直接清空已编辑 draft，无确认。两者均直接违反“可编辑/带入/取消”验收，建议修复 F1/F2 并对 F3/F4 做小修后进入下一轮复审。
