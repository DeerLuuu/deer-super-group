# O1-3 调度/删除/UI relation 读路径 · 最终集成验收（t541）

- **任务**：t541 — 最终集成 O1-3（t538 实现 → t539 PASS → t540 review）
- **PR**：[#78](https://github.com/DeerLuuu/deer-super-group/pull/78) — **MERGED（squash）**
- **合并提交**：`cf14d08`
- **实现文档**：`docs/team/o1-3-relation-read-path.md`
- **验证**：`docs/team/o1-3-relation-read-path-verification.md`（t539 PASS）
- **复审**：`docs/team/o1-3-relation-read-path-review.md`（t540 pass）
- **结论**：**PASS，已合并**；t538 worktree/branch 已清理；当前主工作区 + 其他任务 t526。

## 1. 读路径可追溯

- `Store.getTask/listTasks` relation-first：v3 `task_owners` / `task_dependencies` 优先；relation 表缺失回退旧列（受控 fallback）。
- 新增 `Store.listQueuedTasks`：queued 任务按 priority/queued_at/created_at/id 排序；`owner` 从 `task_owners` 读取（旧 `owner_id` 仅在 relation 表缺失时回退）。
- `ExecutionKernel.getScheduler` 改走 `listQueuedTasks`，不再在 scheduler SQL 读取 `owner_id`。
- deleteTask 下游保护：旧 JSON `depends_on` 即使清空，仍按 relation 拒绝删除父任务；`TASK_HAS_DEPENDENTS` 保持。
- AppService snapshot / TaskStarMap / taskWorkspaceData / PlanDraftPanel 使用 relation-first Task DTO。
- `src/kernel/readPath.test.ts` 源码断言：`kernel.ts`、`service.ts`、`TaskStarMap.tsx`、`taskWorkspaceData.ts`、`PlanDraftPanel.tsx` 无 `owner_id`/`depends_on` 主读、无 legacy JSON depends 解析。

## 2. 独立复跑（PR HEAD `418f0a0`，main `37c8781`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；466 modules
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 178 files / 1177 tests passed
```

> plain 并行有既有 5s timeout；串行全绿。

## 3. 调度/删除/UI 无回归

- scheduler queue owner：relation owner 正确；旧 `owner_id` 为 NULL 但 relation 有值时仍读 relation。
- relation/旧列分叉：仍以 relation 为准（新增 store.v3 测试）。
- delete：旧 JSON 清空仍按 relation 拒绝；既有删除/审批/阻塞/依赖调度测试全绿。
- UI：snapshot/任务星图/任务工作区/PlanDraft 使用 DTO；readPath 源码扫描通过。
- gate/权限/事件/IPC/schema 未改；无新依赖/package/lockfile 变更。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #78 | MERGED（squash） |
| merge commit | `cf14d08` |
| main | `cf14d08` + 本报告提交 |
| t538 worktree | 已移除 |
| t538 branch | 已删除（local/remote） |
| 当前 worktree | 主工作区 + 其他任务 t526 |

## 5. 遗留（非阻塞）

1. `listQueuedTasks.dependsOn` 仍读旧列；scheduler 当前不消费，O1-4 清理（N1 medium）。
2. UI 仅源码边界断言，无渲染 e2e（N2 medium）。
3. relation 缺失回退测试仍偏少（N3 low）。
4. readPath 扫描未覆盖 App.tsx（N4 low）。
5. 既有并行测试时序 timeout（N5 info；CI 串行）。

**最终结论：O1-3 PASS，PR #78 已 squash 合并 `cf14d08`；relation-first getTask/listTasks/listQueuedTasks、scheduler 去 legacy owner_id、删除 relation 保护、UI DTO/readPath 边界均集成验收；gate/权限/事件/IPC/schema 不变；无新依赖；遗留仅为 dependsOn 旧列与 UI 深度证据项。**
