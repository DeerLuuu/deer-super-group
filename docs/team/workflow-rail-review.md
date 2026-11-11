# P0-3 WorkflowRail + NeedsMe · 独立评审（t224）

- **对象**：PR #36 `feature/t222-workflow-rail-needsme`，HEAD `0ec6539`（OPEN/MERGEABLE）；t222 + t226 修复
- **评审人**：aria（独立评审，未修改生产代码）
- **基线**：main `c60d30b`
- **结论**：**needs_revision（不通过）**；阶段投影/unknown/NeedsMe 去重主体成立，但 failed CTA 文案与动作不一致、TaskVcs enqueue 后 MergeQueue 投影不刷新。

## 1. 命令

在 `branches/t222-workflow-rail-needsme` 复跑：

- `pnpm typecheck`：0
- `pnpm build`：0（416 modules；css250.61 kB/gzip30.48；js1,244.45 kB/gzip342.30；main1.5MB/preload11.7）
- `pnpm test`：0（**67 文件/661 用例**；WorkflowRail 2、workflowData 7、useMergeQueue 2）

worktree clean；PR #36 OPEN/MERGEABLE；截图/metrics 存在；无 review/merge gate、权限、状态机或数据层改动。

## 2. 通过项

- `derivedWorkflow` 纯投影 tasks/runs/scheduler/mergeQueue；unknown/cancelled 无 CTA；done+null unknown、done+[] remember、done+pending deliver；未新增第二事实源（MergeQueue 只读 hook）。
- 六阶段、当前 `aria-current="step"`、唯一阶段 CTA、阶段点击复用现有面板/任务/评审/MergeQueue/board。
- NeedsMe 聚合 failed/blocked/review/merge/open alert/hard budget；按 id 去重、空态隐藏、budget alert 优先；listbox aria-controls/expanded、Arrow/Home/End、Esc 回焦由组件/单测覆盖。
- 1440/960 截图；rail 42px；Dock/⌘K/Alt/深链/Settings 无代码改动；全量 67/661 覆盖既有 deeplink/narrowWindow/Dock/权限/审批/执行/评审。
- 无越界；t226 的 null/[] 四态区分成立。

## 3. Blocking findings

### F1（high）failed 阶段 CTA 写“重试失败任务”，实际只打开任务页，不 retry

- `workflowData.ts:117-123`：failed task 返回 stage run、`cta.label="重试失败任务"`、`focusTaskId=failed.id`。
- `WorkflowRail.tsx:98` 当前阶段按钮点击把 stage/focusTaskId 交给 `onStage`。
- `App.tsx:2270-2288` 的 `handleWorkflowStage`：`case "run"` 只调用 `handleOpenTaskPage(taskId)` / `openPanel("tasks")`；`handleOpenTaskPage` 仅选中任务、加载 trace/runs、打开 Tasks，没有调用任何 retry API。
- 因此用户看到“重试失败任务”按钮，点了只是跳任务页，需要再找重试按钮；这违反验收“每阶段唯一 CTA 真实、可点、不误导”。t227 N1 已记录，但这是 P0-3 的主要 CTA，不能作为非阻塞遗留。

**Required fix**：二选一——(a) CTA 改为“查看失败任务”并明确是导航；或 (b) 真正调用现有 retry/task 重启入口（含确认/权限 gate）。补 App 级测试：点击 failed CTA → 期望 retry 调用，或显示准确导航文案；不要只测 `deriveWorkflow` 文案。

### F2（medium）TaskVcs enqueue 后 MergeQueue/NeedsMe 不刷新，交付阶段会短暂误报为“记忆/未知”

- `useMergeQueue.ts` 只在 mount、`refreshKey`（tasks.id:status 拼接）、`active`（MergeQueue modal 打开）时 reload；没有事件的 always-on 刷新。
- `GitPanels.tsx:92` 的“加入合并队列”直接 `window.deer.mergeEnqueue(taskId)`，没有回调/刷新 key；`TaskVcsPanel` 不通知 App。
- 结果：done 任务 + 已加载空队列 `[]` 时，TaskVcs enqueue 后 Workflow 仍停在 remember（错误地表示已交付），NeedsMe 也不出现 merge 项，直到打开 MergeQueue 或后续 task 状态变化。t222 文档 §6 也承认“未在 rail 内轮询”；t227 N2 记录了 TaskVcs enqueue 残余。

**Required fix**：`TaskVcsPanel` 暴露 `onEnqueued`/`onRefresh` 回调，App 调用 `loadMergeQueue`；或现有 app event 总线 emit 后 `refresh` 必含 queue reload；补单测（enqueue → reload → pending）。

### F3（medium）960 截图主区只占约 700/898，右侧 200px 空白，未达到“Dock 单栏填满”

`docs/team/t222-workflow-960.png`（960×800）中：侧栏 56、WorkflowRail 全宽，但对话面板从 x59 到约 x758，右侧约 200px 为空；960 single Dock 应使用 `window−56−6≈898`。这不是 rail 横向挤压，但 PR 的 960 验收视觉证据直接暴露了 Dock 单栏 group 未最大化（可能是从 1440 存档切 single 时 group 宽度保留 700；t212 `reconcileSingleLayout` 只移动 Team，未调整主组宽度/空组）。任务验收含“rail/Dock … 960 无冲突”，不能把该截图当作 960 通过证据。

**Required fix**：在 single 变体 reconcile/rebuild 时把主组尺寸设为实测 Dock 宽度或关闭空组；用默认/宽→窄存档重新生成 960 截图，确认对话/任务面板填满 898；若确认是既有 P0-1 bug，拆到独立 P0-1 repair，但 PR #36 的 960 证据需替换。

## 4. 非阻塞 findings

- **F4（low）**：`WorkflowRail.test.tsx` 仅 2 例，未测 failed CTA 的 App handler、NeedsMe 初始 focus/Esc/click outside/⌘K/Alt/深链；t227 N3 也记录 Esc/初始 focus 未直接测。建议补 App 级 stage/NeedsMe 导航测试。
- **F5（low）**：`useMergeQueue` reload 无 generation/abort，快速 workspace/task 切换时旧响应可能覆盖新 queue；建议加 request token（与 P0-2 focus 同类）。
- **F6（low）**：WorkflowRail 的 `NeedsMe` 点击外部关闭不恢复触发按钮焦点（Esc 有）；对键盘用户可用，但建议与 Escape 一致。
- **F7（low）**：`NeedsMe` 不聚合等待人工问答/待审批（文档已声明不在本任务范围），需要 P1 另评，不是本 PR blocker。

## 5. 判定

阶段 unknown/空态诚实、MergeQueue null/[] 四态、NeedsMe 去重与空态都已成立；但 failed CTA 是误导性主操作，TaskVcs enqueue 会让交付/NeedsMe 投影滞后，960 截图也未证明 Dock 填满。**needs_revision**；先修 F1/F2，替换 F3 证据，再提交复审。PR #36 暂不合并。
