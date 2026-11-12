# R3 刷新去重/事件驱动最终集成验收（t285）

- **任务**：t285 — 集成验收 P0-8 R3：刷新去重/事件驱动
- **实现链**：t282 R3 实现 → t286 generation/错误回传修复 → t287 独立复验 → t288 手动刷新/stale 修复 → t290 markRecovered/调用方修复 → t291 review pass
- **PR**：[#43](https://github.com/DeerLuuu/deer-super-group/pull/43) — **MERGED（squash）**
- **合并提交**：`210dae4`（2026-11-12）
- **实现文档**：`docs/team/perf-r3-refresh.md`
- **验证/评审**：`perf-r3-refresh-verification.md`、`perf-r3-refresh-verification-2.md`、`perf-r3-refresh-review.md`、`perf-r3-refresh-review-2.md`
- **结论**：**PASS（R3 合同），可交付**；PR 已合并，t282 worktree/branch 已清理。

## 1. 结论

P0-8 的 **R3 刷新去重/事件驱动**已完成最终集成验收：

- **RefreshCoordinator**：事件→域（task/scheduler/run/merge/git/watchdog/agent/mailbox/board）、120ms coalesce、单飞 in-flight/generation、seq gap→full、失败最多 3 次指数 backoff + stale、invalidateAll、markRecovered。
- **App 接线**：`onEvent` → Coordinator；`refreshDomains` 只读 dirty 域；删除 220ms timer、watchdog 15s interval；online/visibility 一次 full；stale 提示标注具体域。
- **隐藏轮询移除**：`useMergeQueue` 删除隐藏 5s 轮询（active 2s 保留）；merge/git 事件 reload；失败保留 last-good + stale；成功才清 stale。
- **代际隔离**：App refreshToken/generation/lastSeq；旧 snapshot/域响应在 token 变后丢弃；reset/工作区切换失效旧代际；旧 finally 不排批次。
- **手动刷新**：侧栏刷新/Settings Reload/错误恢复 Retry 统一 `handleManualRefresh`；成功 `markRecovered` 清 stale/failures/backoff，失败 setError+toast 并 invalidateAll；不推进 generation/lastSeq（JSDoc 明确）。
- **事件映射**：cost/provider→watchdog+snapshot；run.handoff_created→runs+watchdog；pr→mergeQueue+snapshot；run.started→runs+snapshot+scheduler。
- **边界**：仅 R3；无 R1/R2、权限/gate/数据层/任务状态机改动；无 CSS/布局变化（1440/960 矩阵不变）。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| 事件→域映射 | `refreshCoordinator.ts` mapping；App onEvent | refreshCoordinator 7；appRefreshIntegration 6；t288 |
| 120ms coalesce/单飞 | Coordinator flush/pending/in-flight | coordinator 7（burst） |
| seq gap→full | Coordinator lastSeq | coordinator 7；t286 |
| 代际/token | App refreshToken/generation/lastSeq；isCurrent | appRefreshIntegration（旧响应丢弃）；t286/t287 |
| 失败 backoff/stale | Coordinator attempt/backoff；域 strict await | integration scheduler 失败→stale；t286 |
| 成功清 stale | Coordinator markRecovered/成功路径 | t290 test；t291 review |
| invalidateAll/reset | reset 清 pending/in-flight/timer | coordinator 7；t286 |
| 手动 refresh | `handleManualRefresh`；markRecovered | appRefreshIntegration 6；t290 |
| 删除 220ms/watchdog 15s | App diff | t282/t286；grep/diff |
| 隐藏 mergeQueue 轮询 | `useMergeQueue` 删除 inactive poll，active 2s | useMergeQueue 4（no inactive poll/last-good） |
| run.started 映射 | runs+snapshot+scheduler | mapping/integration；t288 |
| staleDomains 文案 | onStale domains；data-stale-domains | t288；App integration |
| Rail/Workflow/NeedsMe/panel 不陈旧 | 同一 snapshot 批次 + domain bump | R2 panelHost；Workflow 3；NeedsMe 合同 |
| 无 R1/R2/gate/权限/数据层 | diff 无相关文件 | 98/779；t291 |
| 1440/960 | 无布局/CSS 变化 | 沿用既有矩阵 |

## 3. 独立验证（合并后 main）

工作目录：`S:\DeerSuperGroup`（main `210dae4`；worktree 仅 main）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；434 modules
                 # js 1,296.18 kB / gzip 358.63
                 # css 259.61 kB / gzip 31.83
                 # electron main 1.5 MB / preload 12.0 KB
pnpm test        # --testTimeout=20000 --maxWorkers=2
                 # 98 files / 779 tests 全绿
```

> 说明：默认 5s 高并发下 openai/watchdog 偶发 5s timeout/ECONNRESET（既有 flake）；PR worktree 与合并后 main 使用 20s/2 workers 均 98/779 全绿。该 flake 与 R3 无因果关系，保留为 P1 测试稳定性项。

## 4. 任务/队列/告警/rail/Workflow/panel 证据

1. **burst/单飞**：appRefreshIntegration 覆盖 burst 单组 IPC、旧响应丢弃、域失败 stale；coordinator 7 覆盖 coalesce/in-flight/seq gap/backoff/invalidateAll。
2. **域失败**：scheduler/watchdog/mergeQueue/runs/trace strict+await；失败进 backoff/stale，last-good 保留；成功才清 stale。
3. **notify/stale**：notify 不重置 failures/stale；20 events 风暴 attempts 仍 2、最终 stale；invalidateAll 可恢复。
4. **manual refresh**：成功 markRecovered，下一条事件继续 flush；失败 setError+toast 并 invalidateAll；不推进 generation/lastSeq。
5. **mergeQueue**：inactive 不 poll；active 2s；merge/git 事件 reload；失败 last-good+stale；旧响应丢弃。
6. **run.started/映射**：runs+snapshot+scheduler；cost/provider/pr/handoff 固定域映射。
7. **rail/Workflow/NeedsMe/panel**：同一 snapshot 批次；R2 PanelHost domain deps 保持；Workflow 3、panelHost 4 全绿。
8. **1440/960/权限/gate**：无 CSS/布局改动，1440/960 沿用；权限模式/approval/review gate 未改。

## 5. 范围/兼容性检查

- PR #43 合并 11 文件：`src/App.tsx`、`src/shell/{refreshCoordinator,appRefreshIntegration.test,refreshCoordinator.test}`、`useMergeQueue.ts/test`、docs。
- **无** kernel/data store/事件 schema、git/memory/review/watchdog/electron、权限/gate/任务状态机改动；无 R1/R2 混入；无新依赖。
- 无新数据源：Coordinator 只消费现有 `app:event`/seq，域读取仍走现有 IPC；last-good 保留不伪造新数据。
- 合并前 PR #43 OPEN/MERGEABLE/CLEAN，head `7699444`（含 t287/t291 报告）；合并后 main `210dae4`；t282 worktree 已移除，branch 已删除。
- 当前 main 有 4 个与 t285 无关的未跟踪 docs（dock-max-groups、narrow-window 系列，属其他任务）；t285 未删除/修改它们。

## 6. 遗留项（P1/低优先，不阻塞）

1. **手动刷新 generation**：手动 refresh 不推进 generation/lastSeq（JSDoc 明确），旧 in-flight 仍可能被丢弃/覆盖；后续可统一 token 语义。
2. **部分域成功整体 stale**：一个域失败会使整体 stale；可细分“部分可用”提示（N2）。
3. **generation/lastSeq refs 未读**：当前仅写入/传递，未消费用于 UI 诊断（N3）。
4. **集成测试 fake IPC**：appRefreshIntegration 为 fake IPC；真实 Electron/网络断线演练仍需发布前冒烟（N4）。
5. **无 R3 专属截图**：无 CSS/布局变化，沿用既有矩阵（N5）。
6. **既有 5s flake**：openai/watchdog 默认 5s 偶发；建议统一提高慢测 timeout 或拆分 fake clock（N6）。

## 7. 合并/清理状态

| 项 | 状态 |
|----|------|
| PR #43 | MERGED（squash） |
| 实现 head / 文档 head | `6cc3783` / `7699444` |
| merge commit | `210dae4` |
| main | `210dae4`（+ 本报告提交） |
| t282 worktree | 已移除（`pnpm branch:remove t282-perf-r3-refresh`） |
| t282 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 最终三命令 | typecheck 0 / build 0 / test 98 files/779（20s/2 workers） |

**最终结论：PASS（R3）；RefreshCoordinator 事件驱动、coalesce/单飞/代际/seq gap/backoff/stale、隐藏轮询移除与手动 refresh 恢复均已完成集成；R1/R2 保持、无 gate/权限/数据层变更。残余为 P1 测试/真实断线冒烟项，不阻塞交付。**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
