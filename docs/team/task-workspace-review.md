# P0-5 评审：Task Workspace 交付流水线（t243 / t241）

- **评审人**：ivy
- **基线**：`main 682ca60`；PR #38 / `feature/t241-task-workspace` HEAD `debdebd`
- **范围**：Task Workspace 5 tabs、sticky 唯一 primary、Review/Merge/冲突/失败首屏、Tasks/Team 统一、返回来源、深链/选中/tab 状态、960/1440、键盘/ARIA
- **方法**：静态代码 + 独立三命令；未修改生产代码
- **结论**：**needs_revision**；1 high + 1 medium + 3 low。5 tabs、ARIA/roving、sticky 头、Team 统一和 960 主路径成立，但 `blocked + review_rejected` 没有映射到 review 下一步，RunPanel 选中任务也不更新返回来源。

---

## 1. 独立验证

```text
pnpm typecheck  # exit 0
pnpm build      # exit 0（421 modules；css 256.24 kB/gzip31.34；js 1,268.00 kB/gzip349.62）
pnpm test       # exit 0（75 files / 698 tests）
```

- PR #38 OPEN / MERGEABLE；worktree clean。
- 已确认：5 tabs（overview/runs/review/git/history）、tablist/tab/tabpanel、roving tabIndex、Arrow/Home/End（data test + tabs click/End）；同任务保持、切换任务 `useEffect([selectedTask?.id])` 重置 overview；panel `tabIndex=0` 可聚焦；primary/review/git/runs/history click 能切 tab。
- 已确认：sticky 头标题/状态/owner/priority/current Run；唯一 `.task-workspace-primary`；更多/取消为 secondary；review/failed/done/running/queued/blocked conflict/blocked deps/ready/cancelled 映射；ReviewSection/TaskVcsPanel/RunHistory/历史接线。
- 已确认：Tasks/Team 共用 TasksView/Task Workspace；Team `selectedTaskId={null}` 旧详情 CSS `display:none`；Team 点击进入 `handleOpenTaskWorkspace(..., "team")` 并显示返回团队；960 截图/无横向裁切。
- 已确认：未改 gate/权限/状态机/数据层；PR 仅 App/Tabs/data/styles/tests/docs。

---

## 2. Findings

### F1 · `blocked + review_rejected` 没有 review primary（high / P1）

**问题**：`taskWorkspaceNext` 只处理 `blocked` 的 conflict（regex）和 `unfilledDeps>0`；其余 `blocked` 落到默认 `run`。当任务因交付评审被拒绝进入 `blocked` + `blockedReason=review_rejected` 时：
- sticky 唯一 primary 变成「运行任务」，而 `actionState.start.enabled=false` → 按钮禁用；
- 用户看不到「去评审/处理评审拒绝」，Review tab 仍在第 3 个 tab，需手动发现；
- ReviewSection 中已存在的 reject 线程/原因没有在首屏被定位，违反“Review/Merge/冲突/失败下一步首屏可见”。

**证据**：`src/shell/taskWorkspaceData.ts:42-118`（review/failed/done/running/cancelled/blocked conflict/blocked deps/default run）；`src/App.tsx:3918-3931` 使用该结果；`src/App.tsx:3955-3960` run primary 调 `onStartTask`；`src/shell/taskWorkspaceData.test.ts` 无 review_rejected 用例。t242 N1 已记录。

**验收句**：**`blocked + review_rejected` 的 sticky primary 必须是「去评审/处理评审拒绝」并定位 review tab；不得落 disabled 运行任务；补 taskWorkspaceData + App 映射测试。**

### F2 · RunPanel 选中任务不更新 taskWorkspaceSource（medium / P2）

**问题**：`case "runs"` 的 `RunPanel onSelectTask/onOpenRun` 只 `setSelectedTaskId/SelectedRunId` + loadTrace/Runs，没有设置 `taskWorkspaceSource`。若用户从 Team 打开 Runs 面板（或 source 仍为 `"team"`），在 RunPanel 切换到另一个任务后再进入 Task Workspace，顶部可能仍显示「← 返回团队」，返回到错误来源；Tasks 进入也应回到 Tasks。

**证据**：`src/App.tsx:3224-3238`（RunPanel onSelectTask/onOpenRun 无 setTaskWorkspaceSource）；`handleOpenTaskWorkspace`（`:2457`）才是 source 设置点；Team `onSelectTask` `:3195` 设置 team，Tasks 选择 `:3132` 设置 tasks。

**验收句**：**RunPanel 选中/打开任务时必须显式设定 taskWorkspaceSource（或按“当前入口”明确来源）；从 Team 打开的 Runs 再进 Task Workspace 返回 Team，从 Tasks 进入返回 Tasks，并有测试。**

### F3 · Tabs 组件测试只覆盖 End/focus（low / P3）

**问题**：`TaskWorkspaceTabs.test.tsx` 只测试 click + End；ArrowLeft/Right/Home 在 `taskWorkspaceData.test` 纯函数覆盖，但组件的 `onKeyDown`/`querySelector`/focus 行为只有 End 一次。Home/Arrow 在组件层没有断言，aria-controls/tabpanel 关联也没有组件 DOM 断言。

**证据**：`src/shell/TaskWorkspaceTabs.test.tsx:43-62`；`src/shell/taskWorkspaceData.test.ts:29-36`。

**验收句**：**补组件测试覆盖 ArrowLeft/ArrowRight/Home/End 的 onChange+focused tab，并断言 active tab 的 aria-controls 对应 tabpanel。**

### F4 · Team 旧详情 CSS 隐藏而非不渲染（low / P3）

**问题**：App 给 Team `selectedTaskId={null}`，但 `TeamDashboard` 仍保留旧 `team-task-detail` DOM；CSS `display:none` 隐藏。视觉/读屏已不可见，但保留了重复标题/ID/按钮的 dead DOM，后续选择或测试容易出现双实现漂移。

**证据**：`src/App.tsx:3185-3205`；`src/TeamDashboard.tsx:287-360`；`src/styles.css:7892`（team-task-detail display:none）。

**验收句**：**Team 旧详情在 t241 统一入口后应不渲染（或明确保留的兼容理由 + 单一来源 guard）；不得让隐藏 DOM 继续携带可交互控件/ID。**

### F5 · 深链不含 tab（low / P3）

**问题**：`#/tasks?t=<id>` 只恢复选中任务，不恢复 tab；刷新后固定回 overview。t242 N5 已记录。P0-5 验收提到“5 tabs/深链”，当前深链只验证任务，不验证 tab；对“从评审/运行回到同一 tab”的恢复是缺口。

**证据**：`src/App.tsx` task route 只 setSelectedTaskId；`taskTab` 由 `useEffect([selectedTask?.id])` 重置 overview；t242 N5。

**验收句**：**明确深链是否支持 tab；若支持，增加 `tab=` 参数并恢复/校验；若不支持，文档/测试明确只恢复任务且刷新重置 overview，避免验收歧义。**

---

## 3. 验收映射

| 验收 | 结果 | 说明 |
|---|---|---|
| 5 tabs/深链/键盘/aria 有证据 | passed | 5 tabs、tablist/tab/tabpanel、roving、Arrow/Home/End、focus 有证据；深链只恢复任务（F5 low） |
| sticky 下一步与 Review/Merge/冲突首屏 | failed | Review/Merge/冲突/失败主映射存在；F1 review_rejected 落 disabled run |
| Tasks/Team 统一、返回来源/空态/960 | failed | 统一入口/返回团队/空态/960 通过；F2 RunPanel source |
| gate/权限/状态机/数据层未改 | passed | 仅 UI 分区/术语；无 schema/data/gate 变化 |
| 三命令 | passed | typecheck/build/test 0/0/0；75/698 |
| 无越界 | passed | PR 限 App/Tabs/data/styles/tests/docs |
| verdict/findings | needs_revision | F1 high + F2 medium + F3–F5 low |

---

## 4. 结论

**needs_revision**。P0-5 的主结构（固定 5 tabs、sticky 唯一 primary、Tasks/Team 统一、960）已经成立，但 F1 让“评审被拒绝”这一关键交付阶段的首屏下一步错误/不可用，F2 让 RunPanel 入口的返回来源不可靠。建议修复 F1/F2 并补 F3 的键盘组件证据后进入下一轮复审；F4/F5 可作为同轮 low 清理或明确文档口径。
