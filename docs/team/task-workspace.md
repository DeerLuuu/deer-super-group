# Task Workspace（t241 / P0-5）

任务详情从长滚动改为固定 5-tab 交付流水线，并把当前阶段唯一下一步固定在 sticky 动作头。

## 1. 行为变化

- 任务选中后默认进入 **概览**；tab 状态在当前选中任务内保持，切换任务重置为概览。
- **深链不支持 tab**：`#/tasks` / `?task=` 只恢复选中任务，不携带 tab；刷新、重新进入或从 Runs/Team 打开都回概览（`TASK_WORKSPACE_INITIAL_TAB`，测试断言）。
- **仅一个 primary**：
  - review → 「去评审」（切到评审 tab）；
  - failed → 「重试任务」（新建 attempt，gate 不变）；
  - done → 「查看 Git / 合并」（切到 Git tab，含 PR/worktree/merge enqueue）；
  - queued/running → 「查看运行」（切到运行 tab）；
  - blocked + 冲突/merge → 「处理冲突」（切到 Git）；
  - blocked + 未完成依赖 → 「查看上游依赖」（定位首个未完成依赖）；
  - ready → 「运行任务」；cancelled → 「查看历史」。
- Sticky 头展示标题、状态、owner、priority、当前 Run；secondary 收敛为「更多」（定位/上下文/投票）＋必要「取消任务」。
- **Tasks 与 Team 统一**：Team 任务详情副本已从 TeamDashboard 删除（不是 display:none）；点击团队任务直接进入同一个 Task Workspace，头部提供「← 返回团队」。RunPanel 打开任务继承入口来源（Team→Runs→Task 返回团队；Tasks→Runs→Task 返回任务）。
- 5 tabs：
  - 概览：运行元数据 + 描述/验收/摘要 + 执行契约/来源；
  - 运行：RunHistory（Run 列表、当前 Run、停止/重试）；
  - 评审：任务交付批准/拒绝 + ReviewSection/diff；
  - Git：TaskVcsPanel（VCS/PR/worktree/merge enqueue）；
  - 历史：最近 Run + 分页 trace（现有 trace 渲染）。
- **不改** review/merge gate、权限、任务状态机、数据层；仅 UI 分区与术语。

## 2. 键盘 / ARIA

- `role=tablist` + 5 个 `role=tab`；roving `tabIndex`，ArrowLeft/Right/Home/End 切换并聚焦目标 tab。
- 每个 tab `aria-selected`/`aria-controls`；panel `role=tabpanel`/`aria-labelledby`，可聚焦。
- Sticky primary 的 disabled 原因通过 `aria-describedby` 引用 gate hint；下一步另有 `role=status`。

## 3. 文件

- `src/App.tsx`：TasksView 的 Task Workspace tabs/header；Team 点击统一入口；返回来源。
- `src/shell/TaskWorkspaceTabs.tsx`、`src/shell/taskWorkspaceData.ts`：5 tabs、键盘导航、唯一下一步映射。
- `src/styles.css`：sticky 头、tabs、1440/960、Team 去重。
- `docs/team/t241-task-workspace-1440.png` / `-960.png`。

## 4. 验证

```text
pnpm typecheck
pnpm build
pnpm test
```

新增测试：
- `src/shell/taskWorkspaceData.test.ts`：5 tabs、键盘 wrap/Home/End、review/failed/done/running/blocked conflict/upstream 唯一下一步。
- `src/shell/TaskWorkspaceTabs.test.tsx`：aria tab/tabpanel 关联、roving tabindex、click/End 键盘。

## 5. 降级

- 空任务：保留现有 EmptyState（规划/新建）。
- 无 Run：运行 tab 显示 RunHistory 空态；历史 tab 显示“还没有 Run”与 trace 空态。
- 无 Review：评审 tab 仍可进入，ReviewSection 呈现无评审空态；任务交付按钮按 gate disabled 并显示原因。
- 960：tabs 横向可滚动、header 动作 wrap，无横向裁切（截图）。

## 6. 回滚

- 删除 t241 提交即可恢复长滚动详情；无数据/schema/gate 迁移。
- Team 任务详情隐藏与 Tasks 入统一入口可单独回滚（CSS `.team-task-detail` 与 `handleOpenTaskWorkspace`）。
