# R2 面板渲染隔离最终集成验收（t268）

- **任务**：t268 — 集成验收 P0-8 R2：面板渲染隔离
- **实现链**：t265 R2 实现 → t270 mailbox deps 修复 → t271 独立复验 → t276 repair-round-2 → t277 review pass
- **PR**：[#41](https://github.com/DeerLuuu/deer-super-group/pull/41) — **MERGED（squash）**
- **合并提交**：`255821b`（2026-11-12）
- **实现文档**：`docs/team/perf-r2-panels.md`
- **验证/评审**：`perf-r2-panels-verification.md`、`perf-r2-panels-verification-2.md`、`perf-r2-panels-review.md`
- **结论**：**PASS（R2 合同），可交付**；PR 已合并，t265 worktree/branch 已清理。

## 1. 结论

P0-8 的 **R2 面板渲染隔离**已完成最终集成验收：

- **删除 renderPanel prop/PanelContentContext**：DockShell 不再通过内联 `renderPanel` 渲染；`DockPanelBody` 直接渲染稳定 `PanelHost`。
- **PanelHostProvider**：按 panel domain deps 比较并 bump version；`PanelHost` memo + `useSyncExternalStore` 单 key 订阅；App 原 switch 抽为 `renderPanelContent` 写入稳定 `panelRenderRef`。
- **无第二数据源**：panel 数据/actions 仍来自同一 App render；`panelDepsByKey` 覆盖 chat/tasks/team/runs/planDraft/context/mailbox/board/polls/watchdog/settings。
- **真实 deps**：`buildPanelDeps()` 从 snapshot 派生；mailbox 含 agents（收件人列表），team 含 settings（成员模型下拉），messages-only 只 bump mailbox，agents 变化 bump tasks/team/mailbox，chat/context/watchdog 不误触发。
- **基线**：6 panel 初次各 1 次 render；无关 provider 重渲染后仍 1；mailbox 单域变化→mailbox 2、其余 1；真实 DockPanelBody fixture board bump 只重绘 board（1→2），context 保持 1；rail/Workflow/NeedsMe snapshot probe 引用不变。
- **边界**：仅 R2；R3/RefreshCoordinator/轮询未混入；无 kernel/git/memory/review/watchdog/electron/CSS/权限/gate/数据层改动；Dock/深链/rail/Workflow/NeedsMe 逻辑未变，1440/960 无布局变化。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| 删除 renderPanel/PanelContentContext | `src/App.tsx`；`DockShell.tsx` | DockShell 4 例；t271 |
| 稳定 PanelHost | `src/shell/panel/PanelHost.tsx` | panelHost 4 例 |
| panel domain deps/bump | `panelDeps.ts` `buildPanelDeps` | panelHost 4；t270/t276 |
| mailbox 收件人 agents | `buildPanelDeps.mailbox` 含 agents | t270 F1；t271 |
| team 模型 settings | `buildPanelDeps.team` 含 settings | t276；teamDashboardModel 1 |
| 6 panel 初次各 1 | panelHost.test | 6-panel baseline |
| 无关状态不 render | panelHost/Provider | 全 1；t276 |
| messages-only 仅 mailbox | panelHost 真实 deps | mailbox 2，其余 1 |
| agents 变化 tasks/team/mailbox | panelHost 真实 deps | 按依赖 bump；chat/context/watchdog 不触发 |
| settings-only team/settings | panelHost 真实 deps | team/settings bump；context/watchdog 不 bump |
| runs/board/polls/planDraft 本域 | panelHost 真实 deps | 各自 bump；无关不变 |
| DockPanelBody/rail 一致 | `dockPanelBody.test.tsx` | board bump 只重绘 board；rail 引用不变 |
| R1 token 隔离保持 | chatLiveIsolation/chatViewIsolation | 740→746 全绿 |
| R3 未混入 | diff 无 RefreshCoordinator/轮询 | 8 文件；t277 |
| 无 gate/权限/数据层/CSS | diff 无相关文件 | 92/746 回归；t277 |

## 3. 独立验证（合并后 main）

工作目录：`S:\DeerSuperGroup`（main `255821b`；worktree 仅 main）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；432 modules
                 # js 1,280.50 kB / gzip 354.15
                 # css 258.43 kB / gzip 31.64
                 # electron main 1.5 MB / preload 11.9 KB
pnpm test        # 默认 5s 超时下 openai 用例 flake；20s 超时 92 files / 746 tests 全绿
```

> 说明：PR worktree 默认 5s 首轮也出现既有 openai/watchdog 5s timeout；`--testTimeout=20000` 后 92/746 全绿。该 flake 与本功能无因果关系（t277/t271 同口径），保留为 P1 测试稳定性项。

## 4. 6 panel/1440/960/Dock/深链/rail/Workflow/NeedsMe 证据

1. **6 panel baseline**：panelHost 6 个 panel 初次各 1 次 render；无关 provider 重渲染后仍各 1。
2. **单域 bump**：mailbox 单域变化→mailbox 2、其余 1；runs/board/polls/planDraft 各自本域 bump；context/watchdog 保持 1。
3. **agents/settings**：agents 变化按依赖 bump tasks/team/mailbox，chat/context/watchdog 不误触发；settings-only bump team/settings。
4. **真实 DockPanelBody**：board deps bump 只重绘 board（1→2），context 保持 1；rail/Workflow/NeedsMe snapshot 引用不变。
5. **R1 保持**：20 token delta 不重渲染 App/history/sibling；chatLiveIsolation/ChatView isolation 继续通过。
6. **Dock/深链/rail/Workflow**：Dock 切换/深链/选中任务/rail/Workflow/NeedsMe 逻辑未改；1440/960 无 CSS/布局变化，沿用既有布局截图。
7. **无回归**：primaryRail 10、WorkflowRail 3、narrowWindow 28、DockShell 4、deeplink 17、permission 44、approval 9/2、review 17 全绿。

## 5. 范围/兼容性检查

- PR #41 合并 11 文件：`src/App.tsx`、`src/shell/dock/DockShell.tsx`、`src/shell/panel/{PanelHost,panelDeps,panelHost.test,dockPanelBody.test,teamDashboardModel.test}`、docs。
- **无** `src/kernel/`、data store/事件、git/memory/review/watchdog/electron、CSS/权限/gate/数据层改动；无 R3/RefreshCoordinator/轮询。
- panel 数据/actions 仍来自同一 App render；renderRef 仅存稳定渲染函数，不引入第二数据源。
- 合并前 PR #41 OPEN/MERGEABLE/CLEAN，head `74cc2fa`（含 t271/t277 报告）；合并后 main `255821b`；t265 worktree 已移除，branch 已删除。
- 当前 main 有 5 个与 t268 无关的未跟踪 docs（dock-max-groups、narrow-window 系列、router-member 设计，属其他任务）；t268 未删除/修改它们。

## 6. 遗留项（P1/低优先，不阻塞）

1. **最小 Dock fixture 非真实 Dock**：t276 的 DockPanelBody fixture 只覆盖 board/context 最小路径，不是完整 Dock（t277 low）。
2. **6 panel 真实 fixture 范围有限**：panelHost 挂 6 panel；完整 10 面板/真实布局仍需集成冒烟。
3. **mailbox recipients 未直接渲染断言**：deps 已含 agents，MailboxComposeModal recipients 由 agents 派生；t271 N1。
4. **无 R2 专属截图**：本 PR 无 CSS/布局变化，沿用 1440/960 既有截图；性能证据为 render count。
5. **既有 openai/watchdog 5s flake**：默认 5s 下偶发；建议统一提高慢测 timeout 或拆分 fake clock。
6. **R3 后续**：RefreshCoordinator/刷新去重/隐藏轮询按 t259 另行排期。

## 7. 合并/清理状态

| 项 | 状态 |
|----|------|
| PR #41 | MERGED（squash） |
| 实现 head / 文档 head | `8a8f622` / `74cc2fa` |
| merge commit | `255821b` |
| main | `255821b`（+ 本报告提交） |
| t265 worktree | 已移除（`pnpm branch:remove t265-perf-r2-panels`） |
| t265 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 最终三命令 | typecheck 0 / build 0 / test 92 files/746（20s 超时） |

**最终结论：PASS（R2）；PanelHost/Provider/renderRef 面板隔离、真实 deps 与 6 panel 单域 bump 已完成集成；R1 保持、R3 未混入。残余为 P1 测试/真实 Dock fixture 项，不阻塞交付。**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
