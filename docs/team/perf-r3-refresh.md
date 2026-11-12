# P0-8 R3：刷新去重 / 事件驱动刷新（RefreshCoordinator）

- **任务**：t282 — R3 刷新降噪（不混入 R1/R2 面板改造）
- **设计基线**：`docs/team/perf-isolation-design.md` §PR R3
- **基线 main**：`29d33fa`（R1/R2 已合入；t275 集成后）
- **分支**：`feature/t282-perf-r3-refresh`
- **结论**：新增 RefreshCoordinator；App event → domain、120ms coalesce、单飞 in-flight/generation、seq gap full refresh、失败有限 backoff；移除 watchdog 15s 与 mergeQueue 隐藏 5s 常驻轮询；隐藏 mergeQueue 保留 last-good/stale，watchdog 初始 + 事件加载。

---

## 1. 目标与链路

R3 之前：

```text
app event → 220ms debounce → refresh() 无条件
  → getSnapshot + scheduler + watchdog snapshot + watchdog costs + mergeQueue
  + (selectedTask) trace + runs   // 固定 5–7 IPC
隐藏时 mergeQueue 5s / watchdog 15s 仍在轮询
```

R3 之后：

```text
EventRecord(seq,type)
  → RefreshCoordinator: seq/dup/gap + event→domain + 120ms coalesce
  → onFlush({domains|full,generation})
  → App refreshDomains 只读 dirty domains
  → 同一 React 批次 setSnapshot/scheduler/watchdog/mergeQueue/runs
  → rail/WorkflowRail/NeedsMe 与 panel 读同一 snapshot
```

---

## 2. RefreshCoordinator

文件：`src/shell/refreshCoordinator.ts`

- **事件→域**（`domainsForEventType`）：
  - `task.*` → snapshot + scheduler + runs
  - `scheduler.*` → snapshot + scheduler
  - `run.completed|failed|cancelled` → runs + snapshot + scheduler
  - 其他 `run.*` → runs
  - `merge.*` / `git.*` → mergeQueue + snapshot
  - `watchdog.*` → watchdog
  - `agent.*` / `mailbox.*` / `board.*` / `memory.*` / `approval.*` → snapshot
  - `chat.*` → 空（ChatLiveBridge 处理，不触发 snapshot/5–7 IPC）
- **120ms coalesce**：同一窗口内 domain 合并一次 flush；默认 `coalesceMs=120` 可配置。
- **单飞 in-flight + generation**：flush 期间到达的事件进入下一批（`pendingWhileInFlight`），不会并发；每次 flush `generation++`，供 App 忽略旧响应。
- **seq**：`seq <= lastSeq` 忽略（重复/乱序）；`seq !== lastSeq+1`（已有 seq 后）→ `full=true` + 全域一次 full refresh；首次事件只按自身域处理（初始 snapshot 已由启动加载）。
- **失败/backoff**：flush reject 后最多 `maxRetries=3` 次，指数 120→240→480ms；超过上限 `stale=true` + `onStale`，不再无限重试；成功清 stale。
- **重连/漏事件**：`invalidateAll()` 强制一次全域 full refresh；App 监听 `online` 与 `visibilitychange(visible)` 调用。
- **dispose/reset**：工作区切换 reset seq/pending/in-flight；卸载 dispose。

---

## 3. App 接入

文件：`src/App.tsx`

- `refreshDomains(workspaceId, domains)`：按域读取，不再每次固定 5–7 IPC。
  - `snapshot` → `getSnapshot`；
  - `scheduler` → `loadScheduler(..., true)`；
  - `watchdog` → `loadWatchdog`（last-good；失败不清旧值）；
  - `mergeQueue` → `loadMergeQueue`；
  - `runs`/`trace` + selectedTask → trace/runs。
- `refresh(workspaceId)` 保留为显式用户操作的 full refresh（ALL domains）。
- `RefreshCoordinator` 挂在 App 顶层 `onEvent`；不再有 220ms 本地 timer、15s watchdog interval。
- `refreshStale`：协调器超过重试上限时显示“实时刷新暂不可用，显示上次成功数据”，不把旧 snapshot 清空。
- 事件批次中的 snapshot/scheduler/watchdog/mergeQueue 更新由同一回调触发；rail/Workflow/NeedsMe 仍从 App snapshot 派生，无第二数据源。

### 3.1 MergeQueue

`src/shell/useMergeQueue.ts`：

- **删除隐藏 5s 背景轮询**；`active`（Modal 打开）仍 2s 短轮询。
- 事件驱动：App coordinator 的 `merge.*`/`git.*` 域调用 `reload()`。
- 失败保留 last-good，`stale` 标记；首次失败仍为 unknown(null)，不伪造空。
- `requestRef` 继续保证旧响应不覆盖新状态。

### 3.2 Watchdog

- 删除 15s 常驻 interval，仅工作区切换/首屏加载一次。
- `watchdog.*` 事件触发 `loadWatchdog`；失败保留旧 snapshot/costs。
- 手动 ack/resolve/release 仍调用 `refreshWatchdog`。

---

## 4. 测试

- `src/shell/refreshCoordinator.test.ts`（5 例）：
  - 事件→域映射 + 120ms burst 合并；
  - duplicate/out-of-order 忽略、seq gap → full；
  - in-flight 单飞 + 期间事件下一批；
  - 失败 backoff/上限 stale、不无限重试；
  - invalidateAll 全量。
- `src/shell/useMergeQueue.test.tsx`（4 例）：
  - last-good + stale；
  - active 2s 轮询；
  - inactive 无背景 interval；
  - 旧响应忽略。
- 既有 t175/terminal/permission/watchdog/UI 套件回归。

### 4.1 命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **0** |
| `pnpm build` | **0**：434 modules；js 1,294.09 kB / gzip 358.00；css 259.61 / gzip 31.83；electron main 1.5MB/preload 12.0kB |
| `pnpm test` | **0**：97 文件 / 771 用例（最终全量；高并发下既有 5s timeout 重跑） |

> 1440/960：R3 无 CSS/布局改动，既有窄窗/Dock 截图矩阵不受影响。

---

## 5. 明确不做 / 风险

- 不做 R1/R2 重写、Monaco/虚拟列表/React Compiler/微前端/新状态库。
- 不修改权限/gate/数据层/任务状态机；不改 event emit schema。
- 风险：外部 Git/队列变化若没有事件，隐藏 MergeQueue 可能延迟到下一次事件/打开 Modal；active Modal 仍 2s 轮询，打开面板时会 reload。设计 §9 已记录该开放问题。
- 风险：seq gap 会全域 refresh；极高频事件已被 120ms 合并，不会无限 IPC。
- 回滚：revert 本 PR 恢复 220ms refresh 与 15s/5s 轮询；不涉及 DB/IPC schema。
