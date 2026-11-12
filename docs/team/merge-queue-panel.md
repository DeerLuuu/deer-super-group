# MergeQueue Dock 面板（t309 / P1-1）

- **任务**：t309 — 把 MergeQueue 从 Modal 改为可发现、可恢复的 Dock 面板；仅“确认合并”保留单次 Modal
- **范围**：`src/App.tsx`、`src/styles.css`、`src/shell/`、`src/git/ui/`、`docs/team/`
- **数据源**：沿用 `window.deer.mergeQueue` / `mergeApprove` / `mergeStart` / `mergeWaiveChecks` 与 `useMergeQueue`，未新增后端或第二数据源
- **gate**：不改 merge gate、权限、任务状态机

## 1. 面板

`src/git/ui/MergeQueuePanel.tsx`：

- 顶部：标题、只读说明、刷新；摘要 `共 / 可合并 / 等待 / 进行中`、stale 标记。
- 列表：任务标题/ID、provider/PR、branch、位置、checks、状态、lastError；冲突行显示 `conflictTaskId`。
- 操作：批准、合并…、豁免（原因 ≥8 字）、刷新、查看任务。
- 仅 **合并…** 打开一个 `Modal` 做单次确认（任务/分支/provider/checks/位置）；Modal 关闭不调用 `mergeStart`。
- 空队列、加载中、失败（action 错误保留 last-good）、冲突均有显式状态；`aria-label`/`aria-live`/`aria-current`。

## 2. 入口与恢复

- Sidebar 操作区「合并队列」（secondary rail 工具） + 面板启动器（`PANEL_LAUNCHER_KEYS`）。
- Team 的 `onOpenMergeQueue`、Workflow 的 deliver 阶段、NeedsMe 的 merge 项。
- 任务 Git tab 的「查看合并队列」。
- Command Palette 现有「打开合并队列」动作（修复前入口保留）。
- `#/merge` 或 `#/tasks?merge=1` 深链；`parseHash`/App 将 mergeQueue 标记打开 Dock 面板而非 Modal。
- 面板 `closable`，关闭后从启动器/rail 再次打开；默认布局不新增常驻 tab。

## 3. 布局与可访问性

- 1440：摘要 + 两列行（任务信息 / 操作）；≤960：单列、操作区下沉；≤720：紧凑、按钮换行、豁免输入整行。
- Modal 复用现有 `Modal`：Esc 关闭、Tab 焦点循环、关闭归还焦点；危险操作只在这里调用 `mergeStart`。
- `styles.css` 中 `.merge-queue-*` 与 `.merge-confirm-*`。

## 4. 测试

- `src/git/ui/MergeQueuePanel.test.tsx`：摘要/列表/刷新、合并确认 Modal、确认调用、批准/豁免、失败保留队列、空/加载/冲突、取消不合并。
- `src/git/ui/MergeQueueLayer.test.tsx`：确认 Modal 进入公共 modal stack；Esc 只关闭顶层；focus 归还；设置 Modal 不被误关。
- `src/shell/mergeQueuePanel.test.ts`：PanelKey/defaultClosed/closable、`mergeQueue` launcher、`?merge=1`、CSS 1440/960/720 contract。
- 现有 `parseHash` mergeQueue 测试、team/workflow/needsMe 投影、useMergeQueue token/stale 测试保持。
- 验证：typecheck 0；build 0（441 modules）；extended test 111 files/828 tests 全绿。

## 4.1 t313 复验修复

- F1：真实 Electron 截图（Electron 45 + CDP viewport）：[1440 列表](t313-1440-list.png)、[1440 确认 Modal](t313-1440-modal.png)、[960 单列](t313-960-list.png)、[480 单列](t313-480-list.png)、[1440 空队列](t313-1440-empty.png)。
- F2：`useMergeQueue` 增加 `error/loading`；`items=null && stale` 显示失败原因+重试，不再一直“加载中”；面板测试覆盖首次失败、重试和 action 失败保留队列。
- F3：`useMergeQueue` 测试覆盖首次失败→重试→关闭→重新 active 再加载；App source contract 断言 `openPanel("mergeQueue")` 与 `onPanelClose` 复位。
- F4：480 使用真实 480 viewport 截图（非 720 继承）。
- F5：摘要等待包含 `queued`；冲突数按 `conflictTaskId` 汇总，面板测试断言。

## 4.2 t315 复验修复

- F1：冲突态真实 Electron 截图 [960](t315-960-conflict.png)、[480](t315-480-conflict.png)；1440 列表（含冲突行）见 `t313-1440-list.png`。失败态由 `MergeQueuePanel.test` 与 `useMergeQueue.test` 覆盖（真实 IPC 失败无法在不破坏用户数据下稳定注入）。
- F2：新增 `MergeQueueRecovery.test`，对 sidebar/Team/launcher 按钮执行真实点击，关闭后三种入口均可恢复；hook/App 边界测试保留。
- F3：`openPanel("mergeQueue")` 直接 `setMergeQueueOpen(true)` 并 reload，不再只依赖 `activePanelKey` 变化；关闭经 `onPanelClose` 复位。
- F4：items 非空 + 刷新失败时显示 inline “最近刷新失败 + 重试”，测试覆盖。
- F5/F6：等待含 queued、冲突汇总保持不变；既有 flake 不归因。

## 4.2 t317 App 级恢复

- 新增 `src/shell/mergeQueueApp.test.tsx`：真实 App 壳（mock DockShell 暴露 openPanel/onPanelClose）中点击 sidebar「合并队列」→ mergeQueue 打开；点击 Dock X → onPanelClose 复位；再次点击 sidebar 重开；点击真实面板启动器菜单项再次打开。测试触及 App 的 mergeQueueOpen/activePanelKey/openPanel，不是本地 Harness 布尔。
- Team 入口由 App source contract + TeamDashboard onOpenMergeQueue 覆盖；launcher 为 App 真实菜单按钮。

## 5. 回归与限制

- 旧 `MergeQueueModal` 常驻入口已从 App 移除；`GitPanels` 中旧 Modal 实现删除，避免第二套队列 UI。
- 不改变 `mergeStart` 的 review/approve gate；面板只调用现有 API。
- 默认 `pnpm test` 的既有 5s 并发 flake 仍存在；使用 `--testTimeout=20000 --maxWorkers=2` 全绿。
- 未新增依赖/权限/gate/数据层。
