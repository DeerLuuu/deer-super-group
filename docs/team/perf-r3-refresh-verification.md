# P0-8 R3 刷新去重/事件驱动 · 独立验证报告（t283）

- **任务**：t283 [verification] 独立验证 t282
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #43 `feature/t282-perf-r3-refresh`，HEAD `65875fc`（OPEN/MERGEABLE；worktree `branches/t282-perf-r3-refresh`，clean）；未合并，未修改生产代码。
- **方法**：worktree 复跑三命令 + 读 RefreshCoordinator/App 接入/useMergeQueue/tests + 逐域路径核对。

---

## 1. 结论：**BLOCKED（不通过，needs revision）**

`RefreshCoordinator` 单元本身有 event→domain、120ms coalesce、seq gap、单飞、backoff 的骨架，隐藏 mergeQueue 5s 轮询也已删除；但 **App 接入没有真正落实 in-flight/generation/backoff/last-good**：

- **App 丢弃了 coordinator 的 generation**：`onFlush: async ({ domains })`（App.tsx:1292）只传 domains；`refreshDomains`（:1062）没有 request token/generation 检查；旧的 `getSnapshot`/domain 响应仍可覆盖新数据。
- **domains 读取是 fire-and-forget**：`refreshDomains` 只 await snapshot，`loadScheduler/loadWatchdog/loadMergeQueue/loadRuns` 全部 `void`（:1071-1079）；`onFlush` 在它们完成前即 resolve 并 `setRefreshStale(false)`（:1296）。
- 因此 watchdog/scheduler/mergeQueue/runs 的失败 **不会进入 coordinator 的 catch/backoff/stale**；`loadWatchdog` 自己 catch 且没有 stale 标记，协调器仍认为成功。
- **`notify` 每次事件重置 `failures=0`/`stale=false`**（refreshCoordinator.ts:91 附近）；离线时持续有事件会无限重试，永远不会进入 stale，违背“失败不无限重试”。
- **`reset()` 不清/不取消 in-flight**（:122-136）；工作区切换后旧 workspace 的在途 `refreshDomains` 仍可能 `setSnapshot(old)`，覆盖新工作区。
- `invalidateAll`（online/visibility）本身存在；mergeQueue 隐藏 5s 已删除、active 2s 保留，last-good/stale 在 hook 内；但以上全局刷新语义不满足 R3 合同。

**F1/F2/F3 阻塞**。三命令：typecheck/build 0；plain 3 个既有 5s timeout；20s/2 workers 771 全绿，测试绿不代表上述运行时缺口。

---

## 2. 命令（worktree HEAD `65875fc`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 434 modules；css 259.61 kB (gzip 31.83)；js 1,294.09 kB (gzip 358.00)；electron main 1.5MB/preload 12.0kB |
| `pnpm test`（plain） | 1（既有 flake） | openai + watchdog×2 5s timeout；768/771 |
| `pnpm exec vitest run --testTimeout=20000 --maxWorkers=2` | **0** | 97 文件/771 用例全绿 |

---

## 3. 逐项

### 3.1 coalesce/in-flight/generation/seq gap（FAIL）

- 单元测试通过：120ms burst 合并、duplicate/out-of-order 忽略、gap→full、单飞 pending、backoff/上限、invalidateAll。
- **但 App 不使用 `generation`/`lastSeq`**：`onFlush` 只取 domains；`refreshDomains` 无 token，任何旧 `getSnapshot` 响应都可 setSnapshot。
- 手动 refresh（按钮、写后刷新、首屏/工作区切换）与 coordinator flush 可并发；没有“旧响应忽略”。
- `reset()` 不清 in-flight；旧工作区请求可写回新 snapshot。
- **F1/F5**。

### 3.2 隐藏轮询/事件驱动/last-good/backoff（FAIL）

- `useMergeQueue`：隐藏 5s 轮询删除，active 2s 保留；last-good/stale 测试通过；merge/git 事件通过 refreshDomains 调 `loadMergeQueue`。
- App 删除 watchdog 15s interval；`watchdog.*` 事件触发 `loadWatchdog`。
- **失败路径不完整**：
  - `refreshDomains` 对 scheduler/watchdog/mergeQueue/runs 只 `void` 调用；异常在各自 load 内被吞，coordinator 捕获不到；
  - `loadWatchdog` catch 保留 last-good 但 **无 stale 状态**，`onFlush` 仍 `setRefreshStale(false)`；
  - `loadScheduler`/`loadRuns` 失败也不传播；
  - `RefreshCoordinator.notify` 每次事件清 failures/stale，事件风暴下无限重试。
- **F2/F3**，不满足“失败最多 3 次 backoff + stale、不无限重试”。

### 3.3 漏事件/断线恢复（部分 PASS，受 F1/F5 影响）

- `online`/`visibilitychange` → `invalidateAll()`（App.tsx:1304-1309），full 域；seq gap→full；`refreshCoordinatorRef.reset()` 工作区切换。
- 但 reset 不取消旧 in-flight；旧响应仍可能覆盖；generation 未用于丢弃旧响应。
- **F1/F5**。

### 3.4 Rail/Workflow/NeedsMe/panel 不陈旧（FAIL/边界）

- 事件域映射覆盖 task/scheduler/run/merge/git/watchdog/agent/mailbox/board，Rail/Workflow/NeedsMe 由 App snapshot/taskRuns/scheduler/mergeQueue/watchdog 派生，同批 setState。
- **`run.started` 只映射 runs**（refreshCoordinator.ts:33），不映射 snapshot/scheduler；kernel 通常还会发 task.status_changed，但映射本身不完整，若只收到 run.started，任务/rail/Workflow 可保持旧状态。
- 更关键的是 F2：watchdog/scheduler/runs 异步失败不会被标记 stale，UI 可能显示旧数据且不提示。
- **F4 medium + F2 blocker**。

### 3.5 无重复 IPC/权限/gate/数据层（PASS，F6 测试面）

- Coordinator burst 合并、单飞；useMergeQueue active/inactive 测试；无权限/gate/数据层/schema/任务状态机变更；R1/R2 未重写；无 CSS/布局变化。
- **F6 medium**：没有 App 级 event→IPC 集成测试（unit 只验证回调次数，不验证 refreshDomains 实际 IPC），generation/旧响应/工作区切换未覆盖。

### 3.6 三命令/1440/960（PASS，F7 测试 flake）

- typecheck/build 0；20s/2 workers 97/771；plain 3 个既有 5s timeout（openai/watchdog），非 R3 逻辑。
- 无 CSS/布局；1440/960 沿用既有矩阵。

---

## 4. 发现

| ID | 级别 | 发现 | Required fix |
|----|------|------|--------------|
| **F1** | **blocker** | App 丢弃 RefreshCoordinator 的 generation/lastSeq；refreshDomains 无 request token，旧响应可覆盖新 snapshot | onFlush 接收 generation 并传给 refreshDomains；每个域请求带 token/Abort，只有最新 generation 可 setState |
| **F2** | **blocker** | refreshDomains 对 scheduler/watchdog/mergeQueue/runs 全部 fire-and-forget；失败不进入 coordinator backoff/stale；onFlush 仍 setRefreshStale(false) | await/汇总所有域结果；失败抛回 coordinator；watchdog/scheduler 暴露 stale；不要在失败时清 stale |
| **F3** | **high** | RefreshCoordinator.notify 每次事件重置 failures/stale；离线事件风暴无限重试，永不 stale | 仅在成功 flush 后重置 failures/stale；新事件不重置失败计数（或按时间窗） |
| F4 | medium | `run.started` 仅映射 runs，不映射 snapshot/scheduler；依赖伴随 task.status_changed | run.started 至少加 snapshot/scheduler；补映射测试 |
| F5 | medium | reset 不清/取消 in-flight；工作区切换旧刷新可覆盖新 snapshot | reset 增加 generation invalidate/Abort；App 侧校验 workspace/generation |
| F6 | medium | 无 App 级 event→IPC/旧响应/工作区切换集成测试 | 补 App refresh 集成测试 |
| F7 | low | plain test 既有 5s flake；20s 全绿 | CI 单独超时/串行 |

---

## 5. 结论

- Coordinator 单元骨架、mergeQueue 隐藏轮询移除、事件→域映射有实现；但 **App 接入没有 generation 防护，域读取 fire-and-forget，失败不进入 backoff/stale，事件风暴重置失败计数**，R3 的 in-flight/backoff/last-good/断线一致性合同不成立。
- PR #43 需先修 F1/F2/F3（建议 F4/F5）、补 App 集成测试后重验；本次未修改生产代码。

*本次验证仅新增本报告。*
