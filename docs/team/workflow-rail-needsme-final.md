# WorkflowRail + NeedsMe 最终集成验收（t225）

- **任务**：t225 — 集成验收 P0-3：WorkflowRail + NeedsMe
- **实现链**：t222 实现 → t226 四态/刷新修复 → t227 独立复验 → t228 repair-round-2 → t229 review pass
- **PR**：[#36](https://github.com/DeerLuuu/deer-super-group/pull/36) — **MERGED（squash）**
- **合并提交**：`c439c48`（2026-11-12）
- **实现文档**：`docs/team/workflow-rail-needsme.md`
- **验证/复验/评审**：`workflow-rail-needsme-verification.md`、`workflow-rail-needsme-reverification.md`、`workflow-rail-review.md`、`workflow-rail-review-2.md`
- **结论**：**PASS，可交付**；PR 已合并，t222 worktree/branch 已清理。

## 1. 结论

P0-3 WorkflowRail + NeedsMe 已完成最终集成验收：

- **六阶段常驻**：讨论 → 计划 → 运行 → 评审 → 交付 → 记忆；主区顶部轻量阶段条，不另开弹窗。
- **唯一 CTA**：当前阶段 `aria-current="step"` + 一个主操作；`unknown` 明确显示未知，不伪造阶段/CTA。
- **纯投影**：`deriveWorkflow` 只读 tasks/runs/scheduler/mergeQueue，优先级 `run > review > deliver > plan > remember > discuss > unknown`；不写事实、不新增第二事实源。
- **NeedsMe 聚合**：failed/blocked/review 任务、活动 MergeQueue、open watchdog alert、hard budget；rail badge + popover；`task:/merge:/alert:/budget:` 去重；空态不渲染，定位到任务/评审/队列/看门狗。
- **MergeQueue 四态**：`null`=未加载/失败、`[]`=已知空、`pending`、`merged`；done+null→unknown、done+[]→remember、done+pending→deliver；NeedsMe 在 null 时不推断。
- **刷新**：active 2s / 非 active 5s 背景轮询；approve/start/waive/enqueue 后收敛；请求 token 只接纳最新响应。
- **可访问性**：NeedsMe `aria-expanded/controls`、listbox Arrow/Home/End、Esc/outside 回焦；rail CTA 键盘/点击合同。
- **无回归**：rail 一级入口、Dock tabs/split、⌘K、Alt+1–6、深链、权限/审批/状态机均保留；1440/960 截图与测量通过。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| 六阶段/顺序 | `src/shell/workflowData.ts` `deriveWorkflow`；`WorkflowRail.tsx` | `workflowData.test.ts` 7 例；`WorkflowRail.test.tsx` 3 例 |
| 当前阶段 `aria-current` + 唯一 CTA | WorkflowRail step 按钮 + `workflowStageNavigation` | WorkflowRail 测试；App 级合同测试；t229 review |
| unknown 不伪造 | `deriveWorkflow` unknown + 空 CTA | `unknown shows no fake CTA...` |
| CTA 映射（讨论/计划/运行/评审/交付/记忆） | `workflowStageNavigation.ts` + App handlers | workflowStageNavigation 2 例；t229 验收 |
| failed/review-blocked/blocked CTA | App `workflowStageNavigation`；“查看失败任务”/“去评审”/“处理阻塞” | WorkflowRail 合同；t228 F1 修复 |
| NeedsMe 聚合/去重 | `workflowData.ts` needsMe | workflowData 7 例；去重 key |
| NeedsMe 定位 | App handlers → task/review/queue/watchdog | WorkflowRail 3 例；t227 |
| 空态不渲染 | `needs.length === 0` 不挂控件 | `unknown/empty NeedsMe adds no control` |
| MergeQueue 四态 | `useMergeQueue.ts` `MergeQueueItem[] | null` | useMergeQueue 4 例：null/[]/pending/stale |
| done + null/[]/pending | `deriveWorkflow` 分支 | workflowData 7 例；t227/t228 |
| active 2s / background 5s 刷新 | `useMergeQueue` poll + request token；open/close/refresh/tasks | useMergeQueue 4 例 |
| NeedsMe aria/键盘/回焦 | WorkflowRail popover | WorkflowRail 测试；t228 F5 |
| 无第二事实源 | 只读投影；不写 store/事件 | diff 无 service/store/事件写入；t229 |
| 1440/960 布局 | WorkflowRail + DockShell single reconcile | `t222-workflow-1440.png`、`t222-workflow-960.png`；t228 F3 |
| 无 rail/Dock/⌘K/Alt/深链/权限回归 | 未改 route/权限/gate | primaryRail 10、narrowWindow 28、DockShell 4、deeplink 17、permission 44、approval 9/2、review 17 |

## 3. 独立验证（合并后 main）

工作目录：`S:\DeerSuperGroup`（main `c439c48`；worktree 仅 main）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；416 modules
                 # js 1,244.92 kB / gzip 342.40
                 # css 250.61 kB / gzip 30.48
                 # electron main 1.5 MB / preload 11.7 KB
pnpm test        # exit 0；68 files / 667 tests
```

> 说明：PR worktree 与合并后 main 本次均一次全量通过 68/667；此前 t222/t226/t227 环境负载下出现过既有 openai/watchdog/git 5s timeout，隔离/延长时间后全绿。该 flake 与本功能无因果关系，保留为 P1 测试稳定性项。

## 4. 1440/960 与 NeedsMe 验收

1. **1440**：`t222-workflow-1440.png` — 六阶段条 + 当前阶段 CTA + NeedsMe badge；主区不被挤压。
2. **960**：`t222-workflow-960.png` — single 布局主区填满；阶段条横向可读，无右侧空白/裁切。
3. **CTA 合同**：failed→“查看失败任务”（不假装一键 retry）；review-blocked→“去评审”；blocked→“处理阻塞”；plan/deliver/remember/unknown 各有明确落点。
4. **NeedsMe 合同**：badge 计数、popover listbox、Arrow/Home/End、Esc/outside 回焦、点击定位；空态不挂控件。
5. **MergeQueue 四态**：测试覆盖 `pending → [] → null`，stale response 被丢弃；active 2s / background 5s；TaskVcs enqueue/approve/start/waive 均能收敛。
6. **无第二事实源**：`deriveWorkflow`/`needsMe` 是纯函数投影，不写 store/event；没有新增面板/快捷键/路由。
7. **回归**：primaryRail 10、narrowWindow 28、DockShell 4、deeplink 17、permission 44、approval 9/2、review 17 全绿。

## 5. 范围/兼容性检查

- PR #36 合并 18 文件：`src/App.tsx`、`src/shell/{WorkflowRail,workflowData,useMergeQueue,workflowStageNavigation}*`、`src/shell/dock/DockShell.tsx`、`styles.css`、docs/截图。
- **无** `src/kernel/`、data store/事件写入、git/memory/review/electron 改动；无权限/审批/状态机语义改动。
- WorkflowRail 复用现有 `openPanel`/chat/tasks/review/board/MergeQueue 路由；不新增第二套 panel 状态。
- 合并前 PR #36 OPEN/MERGEABLE/CLEAN，head `5776103`（含 t227/t229 报告）；合并后 main `c439c48`；t222 worktree 已移除，branch 已删除。
- 当前 main 有 4 个与 t225 无关的未跟踪 docs（dock-max-groups、narrow-window 系列，属其他任务）；t225 未删除/修改它们。

## 6. 遗留项（P1/低优先，不阻塞）

1. **5s 背景刷新延迟**：非 active 队列最多 5s 才收敛；如需更实时可评估 push/事件驱动（t229 N1）。
2. **NeedsMe Esc/outside/初始 focus**：有组件/合同测试，缺真实 Electron 冒烟（t229 N2/N3）。
3. **failed CTA 两步**：打开失败任务再重试，非一键 retry；设计有意避免误重试，后续可评估“确认后 retry”一步。
4. **interactive/approval 队列聚合**：本轮未纳入 NeedsMe，留 P1（t228 F7）。
5. **测试稳定性**：openai/watchdog/git 既有 5s timeout；建议统一提高慢测 timeout 或拆分 fake clock。

## 7. 合并/清理状态

| 项 | 状态 |
|----|------|
| PR #36 | MERGED（squash） |
| 实现 head / 文档 head | `d60479f` / `5776103` |
| merge commit | `c439c48` |
| main | `c439c48`（+ 本报告提交） |
| t222 worktree | 已移除（`pnpm branch:remove t222-workflow-rail-needsme`） |
| t222 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 最终三命令 | typecheck 0 / build 0 / test 68 files/667 |

**最终结论：PASS；六阶段 WorkflowRail、唯一 CTA、NeedsMe 聚合/定位、MergeQueue 四态与 1440/960 回归均已完成集成。残余均为 P1 测试稳定性/真机冒烟项，不阻塞交付。**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
