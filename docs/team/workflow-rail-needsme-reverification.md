# P0-3 复验：MergeQueue 四态与 Workflow/NeedsMe（t227）

- **任务**：t227 [verification] 独立复验 t226
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #36 `feature/t222-workflow-rail-needsme`，HEAD `0ec6539`（OPEN/MERGEABLE；worktree `branches/t222-workflow-rail-needsme`，clean）；未合并，未修改生产代码。
- **方法**：worktree 复跑三命令 + 读 workflowData/WorkflowRail/useMergeQueue/App/tests + 检查 gate 范围。

---

## 1. 结论：**PASS（通过，无 blocker）**

- **MergeQueue 四态**：`null`（未加载/失败）、`[]`（已知空）、pending、merged 已区分；`deriveWorkflow` 对 done+null 返回 `unknown`（不伪造记忆），done+[] 才 remember，done+pending 才 deliver；`deriveNeedsMe` 对 null 不推断 merge。
- **刷新**：`useMergeQueue(workspaceId, active, refreshKey)` 初始/失败 null；打开/关闭 MergeQueue、`refresh`、任务状态变化均 reload；队列 Modal active 时 2s 短轮询覆盖 approve/start/waive。
- **CTA**：failed→run/「重试失败任务」、review-blocked→review/「去评审」、普通 blocked→run/「处理阻塞」、review→review、deliver→merge、remember→board；unknown 无 CTA。
- **NeedsMe**：failed/blocked/review/merge/alert/budget 聚合、task:/merge:/alert:/budget 去重、budget alert 优先、空态不渲染；`aria-expanded/aria-controls`、listbox Arrow/Home/End/Esc、初始 focus；点击定位 task/review/queue/watchdog。
- 三命令最终全绿（67 文件/661 用例）；默认首轮有既有 5s flake，最终绿色（N4）。

发现 2 项 medium + 2 项 low（§4），无 blocker。

---

## 2. 命令（worktree HEAD `0ec6539`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 416 modules；css 250.61 kB (gzip 30.48)；js 1,244.45 kB (gzip 342.30)；electron main 1.5MB/preload 11.7kB |
| `pnpm test`（最终） | **0** | **67 文件 / 661 用例**全绿；workflowData 7、WorkflowRail 2、useMergeQueue 2 |
| `pnpm test`（首轮） | 1（环境 flake） | 4 个既有 5s timeout（watchdog 2、git 2）；extended timeout/最终全量 661/661 |

---

## 3. 逐项

### 3.1 MergeQueue 四态（PASS）

`useMergeQueue.ts`：

- `items` 类型 `MergeQueueItem[] | null`；初始 null；
- `reload` 成功 `setItems(queue.items)`（含 `[]`）；失败/无 API `setItems(null)`；
- `active` 时 2s interval；`refreshKey` 变化 reload。

`workflowData.ts`：

- done+`null` → `{stage:"unknown", cta:null, focusTaskId:null}`；
- done+`[]` → remember「去沉淀」；
- done+pending → deliver「去合并」；
- failed → run「重试失败任务」；review-blocked → review；blocked → run「处理阻塞」；unknown/cancelled 无 CTA。
- `deriveNeedsMe` 对 null 不添加 merge；`[]` 不添加；pending/blocked/failed queue 添加。

测试：`workflowData.test` 7 项、`useMergeQueue.test` 2 项（empty→pending→null、active poll/reload）通过。

### 3.2 刷新（PASS；残余见 N2）

`App.tsx`：

- `mergeQueueRefreshKey = tasks.map(id:status).join("|")`；`useMergeQueue(snapshot?.workspace.id, mergeQueueOpen, refreshKey)`；
- `refresh` 内 `void loadMergeQueue()`；`handleOpenMergeQueue` 内 load；MergeQueueModal onClose load；
- active 时 hook 2s 轮询；approve/start/waive 在 Modal 内由短轮询覆盖；关闭时再 load。
- **残余**：任务页 TaskVcsPanel 的「加入合并队列」是 queue change，但不在 Modal active 内，也未显式调用 App `loadMergeQueue`；若任务状态不变，Rail/NeedsMe 可能到下次打开/refresh 才更新（N2 medium）。
- 无第二事实源：hook 只是 API 快照；不写队列。

### 3.3 failed/blocked CTA（PASS，边界 N1）

- failed：stage run，label「重试失败任务」，focusTaskId=failed id；
- review-blocked（failureKind=review_rejected 或 blockedReason 含 review/评审）：stage review，「去评审」；
- 普通 blocked：stage run，「处理阻塞」；
- review task：stage review；deliver/remember/discuss/unknown 均已映射。
- **边界**：`handleWorkflowStage("run", taskId)` 只 `handleOpenTaskPage(taskId)`（任务详情），并未直接调用 `retryTask`；CTA 文案“重试失败任务”会先到任务页，再点「重试任务」。这是两步而非一键（N1 medium），但跳转目标/下一步明确，未伪造状态。

### 3.4 NeedsMe 键盘/aria（PASS，测试覆盖有限）

- `aria-expanded`、`aria-controls="workflow-needs-list"`；popover `role=listbox`、items `role=option`/`tabIndex=-1`/`aria-selected`；`aria-label`。
- ArrowUp/Down/Home/End 通过 `needsListNavigation` 移动 focus；Esc 关闭并回焦按钮；打开时 `activeIndex` focus 首项（`WorkflowRail.tsx:60-88`）。
- `WorkflowRail.test` 断言 aria-controls/expanded、ArrowDown 到第二项；`workflowData.test` 断言 Arrow/Home/End。Esc/初始 focus 无组件级断言（N3 low），实现路径成立。

### 3.5 兼容/范围/gate（PASS）

- WorkflowRail 在 main 顶部，不替代 PrimaryRail/Dock；未注册全局快捷键，不拦 Esc/Tab/⌘K；NeedsMe popover 只处理自身。
- 未改 deeplink/DockShell/权限/审批/任务状态机/review/merge gate；67/661 全绿（review 17、git 56、watchdog 23、permission 44、approval 9/2）。
- PR #36 HEAD `0ec6539`；worktree clean；仅 App/WorkflowRail/workflowData/useMergeQueue/tests/styles/docs，无 gate/权限变更。

---

## 4. 发现（非阻塞）

| ID | 级别 | 发现 | 建议 |
|----|------|------|------|
| N1 | medium | failed CTA「重试失败任务」实际 `handleWorkflowStage("run")` 只打开任务页，不直接 retry；需第二次点击「重试任务」 | 若要求一键，抽 `onStage("run", id, action)` 或 failed 分支调 `handleRequestRetry`；否则文案改「去处理失败」 |
| N2 | medium | TaskVcsPanel 的「加入合并队列」是队列变化，但 Modal 未 active 时无显式 App reload；Rail/NeedsMe 可能滞后 | `onEnqueued`/事件回调触发 `loadMergeQueue`，或把 refreshKey 纳入 VCS 状态 |
| N3 | low | WorkflowRail 测试未断言 Esc 回焦/初始 focus；只断言 ArrowDown/aria-controls | 补 2 条 a11y 断言 |
| N4 | low | 首轮默认 5s 全量出现 4 个既有 timeout（watchdog/git），最终 661/661；非本功能 | CI 单独超时/串行；不阻塞 |

---

## 5. 结论

**PASS**：t223 的 F1/F2 已修复——四态不伪造、不把 done 判成记忆、不漏 pending；打开/关闭/refresh/任务变化/active poll 刷新；failed/review-blocked/blocked CTA 分类与 NeedsMe 键盘/aria 成立；无 gate/权限/状态机变更。N1/N2 为体验/刷新一致性改进，建议后续处理，不阻塞 PR #36 进入评审/合并流程。

*本次验证仅新增本报告，未修改生产代码。*
