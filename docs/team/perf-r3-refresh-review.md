# P0-8 R3 评审：刷新去重 / 事件驱动（t284 / t282）

- **评审人**：ivy
- **基线**：`main 29d33fa`；PR #43 / `feature/t282-perf-r3-refresh` HEAD `1f81d2a`
- **范围**：RefreshCoordinator 的 event→domain、coalesce、seq gap、generation/backoff/stale；隐藏轮询移除后的 watchdog/mergeQueue；Rail/Workflow/NeedsMe 一致性；R3 边界
- **方法**：静态代码 + 独立命令；未修改生产代码
- **结论**：**needs_revision**；1 blocker + 1 medium + 2 low。主协调器/代际/backoff 成立，但事件域映射漏了 `cost.*`、`provider.*`、`pr.*`、`run.handoff_created`；隐藏轮询移除后这些域没有可靠更新路径。

---

## 1. 独立验证

```text
pnpm typecheck  # exit 0
pnpm build      # exit 0（434 modules；js1,295.30 kB/gzip358.32；css259.61 kB/gzip31.83）
pnpm test       # plain 2 个既有 5s timeout（openai/watchdog）；t287 extended 98 文件/776
```

- PR #43 OPEN/MERGEABLE；worktree clean；head 1f81d2a。
- 已确认：event→domain 基础映射、120ms coalesce、in-flight 单飞、seq 重复/乱序忽略、gap→full、失败 120/240/480ms backoff + stale、invalidateAll、reset 失效旧 generation；`run.started` → runs+snapshot+scheduler；`task.review_*` 经 `task.*` 覆盖。
- 已确认：App onFlush 传 generation/lastSeq，refreshDomains 带 token，旧响应 `isCurrent` 丢弃；domain 失败 await/strict 抛回；成功才清 stale；last-good 保留。
- 已确认：watchdog 15s interval 与 mergeQueue 隐藏 5s 轮询删除；active mergeQueue 2s 保留；merge/git 事件 reload；1440/960 无 CSS 变更；R1/R2 未重写；无权限/gate/数据层变更。

---

## 2. Findings

### F1 · 事件域映射漏 cost/provider/pr/handoff，轮询移除后无更新路径（blocker / P0）

**问题**：`domainsForEventType` 只覆盖 `watchdog.*`、`git.*`/`merge.*`、`task.*`、`run.*`、`scheduler.*`、agent/mailbox/board/memory/approval。但事件目录还存在：
- `cost.recorded`、`cost.provisional`、`cost.budget_warning`、`cost.budget_exceeded`、`cost.budget_hold`、`cost.budget_released`、`cost.budget_changed`（watchdog/events.ts）；
- `provider.quota_error`、`provider.cooldown_started`、`provider.cooldown_ended`；
- `run.handoff_created`、`run.model_fallback`、`run.member_switched`；
- `pr.created`、`pr.updated`、`pr.closed`、`pr.merged`（git/events.ts）。

这些类型均不匹配现有前缀：
- `cost.*`/`provider.*` → `[]`，不会刷新 watchdog snapshot/costs；watchdog 15s interval 已删除，预算条、watchdog 面板与 provider cooldown 会一直显示旧值，直到其他 watchdog/task 事件或手动刷新。
- `run.handoff_created` → 只命中 `run.*` → 仅 runs；watchdog handoffs 不刷新。
- `pr.*` → `[]`，隐藏 MergeQueue 5s 已删除，外部 PR 变化不会触发 mergeQueue/snapshot；只能打开 Modal/等到 merge/git 事件。

这直接违反“轮询移除后有可靠事件更新路径”和“Rail/Workflow/NeedsMe/panel 不陈旧”。

**证据**：
- `src/shell/refreshCoordinator.ts` 的 `domainsForEventType`；
- `src/watchdog/events.ts` 的 `WATCHDOG_EVENT_TYPES`（cost/provider/run.handoff_created）；
- `src/git/events.ts` 的 `GIT_EVENT_TYPES`（pr.*）；
- `refreshCoordinator.test.ts` 只测 task/merge/watchdog/run/chat，无 cost/provider/pr/handoff 用例。

**验收句**：**补 `cost.*`/`provider.*` → watchdog（+snapshot 如 budget UI 依赖）；`run.handoff_created` → runs+watchdog；`pr.*` → mergeQueue+snapshot；并加映射/集成测试。若认为 cost 由 watchdog.tick 覆盖，必须有事件等价证明，不能留空。**

### F2 · manual refresh 绕过 coordinator，成功不清 stale、失败无 backoff（medium / P2）

**问题**：App 的 `refresh()` 直接 `refreshTokenRef++` + `refreshDomains(ALL)`，不走 RefreshCoordinator：
- 成功后没有 `setRefreshStale(false)`；stale banner 会继续显示“实时刷新暂不可用”，即使手动刷新已成功。
- 失败没有 coordinator 的 backoff/onStale，`void refresh(...)` 也没有统一错误处理；手动刷新失败可能无反馈或产生未处理 rejection。
- 手动刷新会递增 token，使 coordinator 的在途响应被丢弃，但 coordinator 仍可能按自身 generation 结算，语义不一致。

**证据**：`App.tsx:1152-1156` `refresh`；`App.tsx:3459` 手动按钮 `void refresh(...)`；`App.tsx:1360-1372` coordinator `onFlush/onStale`；t287 N1。
**验收句**：**手动刷新走 coordinator（或显式共享 token/generation/stale 状态）；成功清 stale，失败有错误反馈/backoff；不得让手动 token 与 coordinator generation 分离。**

### F3 · 隐藏 MergeQueue 的外部 PR 变化只靠打开 Modal（low / P3）

**问题**：`useMergeQueue` inactive 时只挂首次 reload，无轮询；`pr.*` 未映射（F1）时外部 PR 变化没有刷新路径。t282 风险段已承认“外部 Git/队列变化若无事件，隐藏 MergeQueue 可能延迟到下一次事件/打开 Modal”。这与“可靠更新路径”仍有差距，至少应把 `pr.*` 纳入或明确“隐藏面板允许延迟”的验收口径。

**证据**：`useMergeQueue.ts` inactive effect 无 interval；`domainsForEventType` 无 `pr.`；docs §风险。
**验收句**：**F1 修复 `pr.*` 后，隐藏态可接受“下一次事件/打开 Modal”；若仍不接受，需保留低频兜底或加 UI stale 提示。**

### F4 · 域部分成功但整体 stale 的语义未在界面区分（low / P3）

**问题**：一个 flush 中 snapshot 成功、scheduler/watchdog 失败时，Coordinator 整体失败并 stale；snapshot 已更新但 UI 只显示全局 stale，用户无法区分哪些面板是新、哪些是 last-good。t287 N2 已记录。
**验收句**：**至少在 stale notice/面板标注“部分域过期”，或在文档明确该全局语义；不得让 successful 域被错误标为 stale。**

---

## 3. 验收映射

| 验收 | 结果 | 说明 |
|---|---|---|
| 去重/不漏事件/seq gap 有证据 | passed | coalesce/单飞/重复/乱序/gap full/invalidateAll 测试通过 |
| 轮询移除后有可靠事件更新路径 | failed | F1 cost/provider/pr/handoff 无映射；watchdog 15s 与隐藏 merge 5s 已删 |
| Rail/Workflow/NeedsMe/panel 不陈旧 | failed | cost/provider 预算/watchdog、PR mergeQueue 可陈旧 |
| 无 R1/R2 混入/gate/权限/数据层 | passed | PR 仅 App/coordinator/mergeQueue/tests/docs；无 R1/R2、gate/权限/数据层 |
| 三命令 | passed（extended） | typecheck/build 0；plain 2 个既有 5s timeout；extended 776 全绿 |
| verdict/findings | needs_revision | F1 blocker + F2 medium + F3/F4 low |

---

## 4. 结论

**needs_revision**。RefreshCoordinator 本身的去重、单飞、seq gap、generation、backoff/stale 实现成立；R1/R2 边界也保持。但 F1 是真实的“事件空洞”：移除 watchdog 15s/隐藏 merge 5s 后，`cost.*`/`provider.*`/`pr.*`/`run.handoff_created` 没有进入协调器，预算、provider cooldown、watchdog handoff、外部 PR 队列会陈旧。先修 F1 并补映射测试；F2 手动刷新需共享 stale/generation 语义。F3/F4 可在同一轮或明确验收口径。
