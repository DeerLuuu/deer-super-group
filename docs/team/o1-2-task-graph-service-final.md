# O1-2 TaskGraphService 写路径与幂等 · 最终集成验收（t517）

- **任务**：t517 — 最终集成 O1-2（t502 实现 → t514 修复 → t515/t516 复验 → t524/t525 三轮修复/复审）
- **PR**：[#73](https://github.com/DeerLuuu/deer-super-group/pull/73) — **MERGED（squash）**
- **合并提交**：`15b7592`
- **实现文档**：`docs/team/o1-2-task-graph-service.md`
- **验证**：`docs/team/o1-2-task-graph-service-verification-2.md`（t515 PASS）
- **复审**：`docs/team/o1-2-task-graph-service-review-3.md`（t525 pass）
- **结论**：**PASS，已合并**；t502 worktree/branch 已清理；当前主工作区 + 其他任务 t526。

## 1. 幂等/写路径可追溯

### TaskGraphService / 事务

- 统一 owner/deps 写入；稳定 `TaskGraphError` code，校验存在性/同 workspace/自依赖/重复/环/≤100。
- owner/deps 同时写 relation + 旧列 + `task.owner_changed` / `task.dependencies_changed`（schemaVersion2）同事务；失败回滚；`task.updated` 不再承载 owner/deps。
- createTask / plan / confirmPlan 走服务；PlanDraft/router plan 单事务（tasks+owner+deps+priority+router.plan）。
- kernel reassignTask 走 TaskGraphService；Store.updateTask 的 owner/deps 走受控 graph 原语（兼容 out-of-scope git 调用）。
- deleteTask 有下游依赖时 `TASK_HAS_DEPENDENTS` 拒绝；planDraft non-null owner 持久化。

### 幂等 key / 回放

- owner：`from:to:vN`；deps：`hash(from):hash(to):vN`；status：`old:new:eventCount`（task 级 eventCount 版本）。
- A-B-A-B：owner/deps 各 4 真实事件、4 唯一 key；重复同值仍幂等；rebuild 后 relation/旧列/最终状态一致。
- `task.deleted` 加入 `KERNEL_EVENT_TYPES` / strict EVENT_REGISTRY；projection `applyTaskDeletedProjection` 删除 task/owner/dependency/run/summary；create→owner/deps→delete→rebuild 后 task=null、relation 无行、digest 一致、`task.deleted` 事件保留。
- rebuild 先清 relation 再清 tasks，不复活旧 task.created。

### git 写路径

- `gitService` conflict task create 走 `TaskGraphService.createTask`；merge-captain owner 走 `setOwner`。
- `git.test` 覆盖 merge-captain 的 ownerId/relation/`task.owner_changed`。
- 全仓生产代码 grep：无 service 外 owner/deps 直接 SQL；仅 store.ts 的受控 graph 原语。

## 2. 独立复跑（PR HEAD `90822d3`，已同步 main `444d39e`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；466 modules
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 177 files / 1173 tests passed
```

> plain 并行有既有 5s timeout；串行全绿。

## 3. gate/权限/调度不变；无新依赖

- PR diff：`src/kernel/{taskGraph,taskGraphService,store,service}.ts`、execution eventRegistry/projections/kernel、`src/git/gitService.ts` 与测试、docs；无 gate/权限/调度/IPC/schema version 变更。
- 无 package/lockfile/新依赖。
- 事件日志只增不删；review/merge gate、审批、权限路径未改。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #73 | MERGED（squash） |
| merge commit | `15b7592` |
| main | `15b7592` + 本报告提交 |
| t502 worktree | 已移除 |
| t502 branch | 已删除（local/remote） |
| 当前 worktree | 主工作区 + 其他任务 t526 |

## 5. 遗留（非阻塞）

1. `deleteTask` 的 `task.deleted` 仍 schemaVersion1；strict registry 尚未实际生效（payload/投影正确）（N1 medium）。
2. eventCount 依赖事件不清理；每写多 COUNT（N2/N3 low）。
3. git 仅 merge-captain 场景覆盖（N4 low）。
4. 无并发多进程测试（N5 low）。
5. 既有并行测试时序 timeout（N6 info；CI 串行）。

**最终结论：O1-2 PASS，PR #73 已 squash 合并 `15b7592`；TaskGraphService 统一写路径/事务/事件、A-B-A-B 幂等/rebuild、task.deleted 投影、PlanDraft 原子建图、git 写路径均集成验收；gate/权限/调度/IPC/schema 不变；无新依赖；遗留仅为 task.deleted schemaVersion、计数/并发深度项。**
