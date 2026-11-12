# P0-8 R3 复验：代际/错误回传/notify（t287）

- **任务**：t287 [verification] 独立复验 t286
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #43 `feature/t282-perf-r3-refresh`，HEAD `1f81d2a`（OPEN/MERGEABLE；worktree `branches/t282-perf-r3-refresh`，clean）；未合并，未修改生产代码。
- **方法**：worktree 复跑三命令 + 读 RefreshCoordinator/App refreshDomains/loaders/useMergeQueue/appRefreshIntegration.test + 逐路径核对。

---

## 1. 结论：**PASS（通过，无 blocker）**

t283 的 F1/F2/F3/F4/F5/F6 已修：

- **generation/token**：App `refreshTokenRef`；`onFlush` 传 generation/lastSeq；`refreshDomains(workspaceId, domains, token)` 先设 snapshot 并 `isCurrent()` 校验 token + workspace；scheduler/watchdog/mergeQueue/runs/trace 全部 `guard`；旧响应返回不发 setState；`reset` generation++ 失效旧 in-flight。
- **域失败回传**：所有域 `strict:true` 并 await（`Promise.all`）；loadScheduler/loadRuns/loadTrace 抛错；loadWatchdog strict 不再吞；loadMergeQueue strict 抛错；`onFlush` 仅在 await 成功后清 stale；失败保留 last-good。
- **notify**：不再 reset failures/stale；stale 后事件不触发新 flush；离线风暴 20 events attempts 仍 2、最终 stale；`invalidateAll` 可恢复。
- **run.started**：映射 runs+snapshot+scheduler。
- **App 集成**：appRefreshIntegration.test 3 例（burst 合并、旧响应丢弃、域失败 stale/last-good）通过。
- 三命令：typecheck/build 0；plain 98 文件/776 用例全绿（最终重跑），extended 20s/2 workers 776 全绿。
- 无权限/gate/数据层/schema/状态机/R1/R2 重写；无 CSS/布局变化。

残留 N1/N2 为 manual refresh 与 stale 提示的边界，不阻塞 R3 合同。

---

## 2. 命令（worktree HEAD `1f81d2a`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 434 modules；css 259.61 kB (gzip 31.83)；js 1,295.30 kB (gzip 358.32)；electron main 1.5MB/preload 12.0kB |
| `pnpm test`（plain 最终） | **0** | 98 文件/776 用例全绿 |
| `pnpm exec vitest run --testTimeout=20000 --maxWorkers=2` | **0** | 98/776 全绿 |

---

## 3. 逐项

### 3.1 generation/lastSeq/旧响应/切换/reset（PASS）

- App `onFlush` 接收 `{domains, generation, lastSeq}`；`refreshDomains` 带 token；`isCurrent = token===refreshTokenRef.current && snapshotRef.current?.workspace.id===workspaceId`。
- snapshot `getSnapshot` 后 `isCurrent` 才 setSnapshot；失败仅当 current 时 throw。
- scheduler/watchdog/mergeQueue/runs/trace 都带 `{strict:true, guard:isCurrent}`；旧响应 guard false 直接 return。
- `reset` 清 timer/pending/inFlight/pendingWhileInFlight/full/lastSeq/failures/stale + generation++；旧 onFlush resolves 后 generation 不匹配，不再成批/排下一批。
- **N3 low**：App 同时保存 `refreshGenerationRef`/`refreshLastSeqRef`，但运行时不读取；实际守卫是 token，字段冗余。
- **N1 medium**：manual `refresh()` 只递增 token，不参与 coordinator generation；若 manual full refresh 与 onFlush 重叠，coordinator onFlush 仍以“成功”清 stale，manual 若失败不会进入 backoff。

### 3.2 域失败 backoff/stale/不自吞（PASS）

- `refreshDomains` 构造 jobs 并 `await Promise.all`；所有 loaders strict：
  - `loadScheduler` result false → set error + throw；
  - `loadRuns` strict result false → throw；
  - `loadTrace` catch → throw；
  - `loadWatchdog` Promise.all 后 strict 检查 snapshot/costs，异常/失败 throw，不再自吞；
  - `loadMergeQueue` catch 保留 last-good/stale 并 strict throw。
- `onFlush` 只在全部 await 成功后 `setRefreshStale(false)`；失败由 coordinator catch 进入 failures/backoff；last-good 不重写。
- **N2 low**：单次 batch 内一个域失败时，其他已成功域可能已更新，属“部分成功 + 整体 stale”，可接受但可进一步按域收敛。

### 3.3 notify/风暴/有限退避（PASS）

- `notify` 不再重置 failures/stale；stale 后直接 return（仍更新 lastSeq），不排新 flush。
- `refreshCoordinator.test` 新增离线 20 events：attempts 仍 2、stale 1 次；`invalidateAll` 恢复。
- **N1** 同 manual refresh token 边界；不影响事件风暴合同。

### 3.4 run.started/App 集成（PASS）

- `domainsForEventType("run.started")` = runs+snapshot+scheduler（终态 run 同样）。
- `appRefreshIntegration.test` 3 例：
  - burst 单组 IPC；
  - 旧 snapshot response 在 token 失效后丢弃，最终 version=2；
  - scheduler 域失败 → coordinator stale，snapshot last-good version=7 保留。
- **N4 low**：集成测试用 fake IPC 复刻 App pipeline，非真实 App mount；但覆盖关键代际/失败路径。

### 3.5 无重复 IPC/范围/UI（PASS，N5/N6 low）

- burst 120ms 合并、单飞；useMergeQueue hidden 5s 删除、active 2s 保留、last-good/stale；watchdog 15s 移除。
- 无权限/gate/数据层/schema/任务状态机/R1/R2 重写；无 CSS/布局变化，1440/960 沿用既有矩阵（N5 low：无新截图）。
- 三命令：plain 与 extended 均 776 全绿（N6 low：高并发裸跑仍可能触发既有 5s flake）。

---

## 4. 发现（非阻塞）

| ID | 级别 | 发现 | 建议 |
|----|------|------|------|
| N1 | medium | manual `refresh()` 只递增 token，不进入 coordinator generation；与 onFlush 重叠时 coordinator 仍可能以成功清 stale，manual 失败无 backoff；manual 成功后也不主动清 `refreshStale` | manual refresh 也走 coordinator 或显式清 stale/失败回传；补重叠测试 |
| N2 | low | 单次 batch 部分域成功、部分失败时，已成功域已 setState；整体标 stale | 可接受；如需严格原子可按域暂存 |
| N3 | low | `refreshGenerationRef`/`refreshLastSeqRef` 保存但未读取 | 删除或用于日志/断言 |
| N4 | low | appRefreshIntegration 是 fake pipeline，不是真实 App mount | 补真实 App 集成测试 |
| N5 | low | 无新 1440/960 截图；无 CSS 变更 | 评审前人工抽查 |
| N6 | low | plain 高并发仍有既有 openai/watchdog 5s flake | CI 单独超时/串行 |

---

## 5. 结论

**PASS**：t283 的旧响应覆盖、域失败自吞、notify 重置失败、run.started 缺域、reset 不清 in-flight 均已修复；App 级 burst/旧响应/域失败集成测试通过；三命令最终 98/776 全绿；无 R1/R2/权限/gate/数据层变更。N1/N2 为 manual refresh 边界，不阻塞 PR #43 进入评审/合并。

*本次验证仅新增本报告，未修改生产代码。*
