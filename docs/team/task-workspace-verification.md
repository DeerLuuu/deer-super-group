# Task Workspace 5 tabs 与 sticky 动作 · 独立验证报告（t242）

- **任务**：t242 [verification] 独立验证 t241 P0-5
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #38 `feature/t241-task-workspace`，HEAD `debdebd`（OPEN/MERGEABLE；worktree `branches/t241-task-workspace`，clean）；未合并，未修改生产代码。
- **方法**：worktree 复跑三命令 + 读 taskWorkspaceData/Tabs/App/CSS/tests + 查看 1440/960 截图。

---

## 1. 结论：**PASS（通过，无 blocker）**

- 5 tabs：概览/运行/评审/Git/历史；当前任务内保留 tab、切换任务重置、深链默认概览；ARIA tablist/tab/tabpanel + roving tabindex + Arrow/Home/End。
- sticky 头：标题/状态/owner/priority/当前 Run；唯一 primary 按阶段映射 review/failed/done/running/queued/blocked conflict/blocked deps/ready/cancelled；Review/Merge/冲突/失败首屏可见。
- Tasks 与 Team 进入同一 Task Workspace；Team 旧 `.team-task-detail` 隐藏，头部「← 返回团队」；无重复可操作副本。
- 空任务/无 Run/无 Review/960 单列/横向不裁切；1440/960 截图成立。
- 未改 review/merge gate、权限、任务状态机、数据层；72→75 文件/698 用例全绿。
- 发现 2 项 medium + 3 项 low（§4），不阻塞本轮通过。

---

## 2. 命令（worktree HEAD `debdebd`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 421 modules；css 256.24 kB (gzip 31.34)；js 1,268.00 kB (gzip 349.62)；electron main 1.5MB/preload 11.9kB |
| `pnpm test` | **0** | **75 文件 / 698 用例**全绿；TaskWorkspaceTabs 1、taskWorkspaceData 3 |

---

## 3. 逐项

### 3.1 5 tabs/状态/深链/键盘/aria（PASS）

- `TASK_WORKSPACE_TABS` 恰好 5 项：overview/runs/review/git/history。
- `taskTab` 在 `TasksView` 内；`useEffect([selectedTask?.id])` 切换任务重置 overview；同一任务切换 tab 保持。
- 深链 `#/tasks?task=...` 选中任务后默认 overview（设计声明；tab 未写入 hash）。
- `TaskWorkspaceTabs`：`role=tablist`、每个 `role=tab`、`aria-selected`、`aria-controls`、roving `tabIndex`；ArrowLeft/Right/Home/End 由 `taskWorkspaceTabForKey` 计算并聚焦目标 tab；panel `role=tabpanel` + aria-labelledby + tabIndex。
- `TaskWorkspaceTabs.test` 断言 5 tab/选中/roving/click/End；data test 断言 Arrow/Home/End/wrap。**N3 low**：Tabs 组件测试只覆盖 End，Arrow/Home 仅在纯函数测；panel 聚焦未测。

### 3.2 sticky 头/唯一 primary（PASS，边界 N1）

- `.task-workspace-head` `position:sticky; top:0; z-index:4`；标题、状态、owner、priority、当前 Run 显示。
- `taskWorkspaceNext` 唯一映射：
  - review→review tab「去评审」；failed→retry「重试任务」；done→git「查看 Git / 合并」；queued/running→runs「查看运行」；cancelled→history「查看历史」；blocked conflict/merge→git「处理冲突」；blocked unfilledDeps→upstream「查看上游依赖」；ready→run「运行任务」。
  - `runWorkspacePrimary` 执行 start/retry/upstream/open tab；disabled 原因通过 `aria-describedby` + `role=status`。
- **N1 medium**：`blocked + failureKind=review_rejected` 未识别为 review，会落到默认「运行任务」；`taskWorkspaceNext` 只识别 blockedReason 含 conflict/merge 或 unfilledDeps，未用 `failureKind`。Review tab 仍可手动点，但“下一步首屏”在该用例不准确。

### 3.3 Review/Merge/冲突/失败首屏（PASS）

- review tab 含任务交付批准/拒绝 + ReviewSection；review 状态 primary 直接切 tab。
- done primary 切 Git（TaskVcsPanel：分支/PR/checks/merge enqueue）；merge queue 入口仍由 TaskVcs/团队/命令面板提供。
- blocked conflict primary 切 Git；blocked deps primary 选中首个未完成依赖；failed primary 走既有 retry 确认。
- 1440/960 截图显示 primary 与 tab 首屏；N1 为 review-rejected 边界。

### 3.4 Tasks/Team 统一/空态/960（PASS）

- `handleOpenTaskWorkspace(taskId, source)`：Tasks 传 "tasks"，Team `onSelectTask/onOpenTaskPage` 传 "team"；同一个 `TasksView`/Task Workspace 渲染；`workspaceSource` 仅用于「← 返回团队」和来源文案。
- `.team-task-detail { display:none }`：Team 旧详情副本不可操作；点击团队任务进入 Task Workspace；返回按钮 `openPanel("team")`。
- 空任务：无 selectedTask 时保留 EmptyState；无 Run→RunHistory 空态；无 Review→ReviewSection 空态/无评审 gate；960 tabs 横排可滚动、header wrap、无横向裁切（截图）。
- **N2 medium**：RunPanel 的 `onSelectTask` 只 setSelectedTaskId，未 set `taskWorkspaceSource`；若此前从 Team 进入过任务，再从 Runs 选任务，返回按钮可能仍显示「返回团队」。

### 3.5 gate/权限/状态机/数据层（PASS）

- 文件仅 App/shell TaskWorkspace/tests/styles/docs；未改 review/merge gate、权限、任务状态机、数据层/schema。
- 75/698 全绿；permission 44、approval 9/2、execution/kernel 43、review 17 全部通过。

---

## 4. 发现

| ID | 级别 | 发现 | 建议 |
|----|------|------|------|
| N1 | medium | blocked + review_rejected 未映射到 review primary；落到默认「运行任务」，与 t226 的 review-blocked 分类不一致 | `taskWorkspaceNext` 识别 failureKind/review blockedReason → review tab；补测试 |
| N2 | medium | RunPanel `onSelectTask` 未更新 `taskWorkspaceSource`；从 Team 后再从 Runs 选任务，返回来源可能错误 | onSelectTask 统一 `handleOpenTaskWorkspace(taskId, "tasks")` 或显式 source="tasks" |
| N3 | low | TaskWorkspaceTabs 组件测试仅覆盖 End；ArrowLeft/Right/Home 只在纯函数测；tabpanel 聚焦未测 | 补 2-3 条组件/键盘断言 |
| N4 | low | Team 详情用 CSS display:none 隐藏而非不渲染；DOM 仍有副本（不可操作） | 若需要减少 DOM，可在 Team 层条件不渲染 |
| N5 | low | 深链只到 task 默认 overview，tab 状态不入 hash；设计已声明可接受 | 后续如需要可加 `tab=` |

---

## 5. 结论

**PASS**：5 tabs/ARIA/键盘、sticky 唯一 primary、Review/Merge/冲突/失败首屏、Tasks/Team 统一、空态/960 均成立；未改 gate/权限/状态机/数据层；三命令 0/0/0，75/698。N1（review-rejected primary）建议后续修，不阻塞 PR #38 进入评审/合并流程。

*本次验证仅新增本报告，未修改生产代码。*
