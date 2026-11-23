# O1-4 任务关系 contract 删除与回滚 · 最终集成验收（t547）

- **任务**：t547 — 最终集成 O1-4（t544 实现 → t545 PASS → t552 修复 → t553 review）
- **PR**：[#79](https://github.com/DeerLuuu/deer-super-group/pull/79) — **MERGED（squash）**
- **合并提交**：`da071f1`
- **实现文档**：`docs/team/o1-4-relation-contract.md`
- **验证**：`docs/team/o1-4-relation-contract-verification.md`（t545 PASS）
- **复审**：`docs/team/o1-4-relation-contract-review-2.md`（t553 pass）
- **结论**：**PASS，已合并**；t544 worktree/branch 已清理；当前主工作区 + 其他任务 t548。

## 1. contract 删除可追溯

- fresh `tasks` schema 无 `owner_id` / `depends_on`；`user_version=4`、`schema_migrations=4`、`foreign_key_check=[]`。
- v2→v3 回填 relation，v3→v4 `DROP COLUMN`；迁移自动备份 pre-contract v3；备份不可写/迁移失败 fail-closed（ROLLBACK 后 `user_version=3`、旧列/索引保留、连接可重开）。
- `toTask` 不再解析旧 JSON/回退；`get/list/listQueued` relation-only；projection 不写旧列。
- `Store.updateTask` 删除 owner/deps 兼容；delete/scheduler/UI/PlanDraft/git 全走 TaskGraphService/relation。
- memory 两处 summary fallback 必要改读 `task_owners`。
- 旧列仅出现在迁移 DROP/backfill；生产读路径无旧列。
- 新增 `listQueuedTasks` 批量查询 `task_dependencies`，覆盖 dependsOn。

## 2. 回滚/恢复

- `scripts/restore-task-graph-backup.mjs`：校验 integrity/FK、安全副本、失败回写；默认 backup v3 / target v4 校验，支持 `--force`；不承诺旧代码读 v4，contract 后必须恢复 pre-contract v3 备份。
- 真实 v4 migration 自动 backup 经脚本恢复测试；失败保留安全副本。
- v1 snapshot：`seedLegacySnapshots` 在旧列存在时用 raw owner_id/depends_on 构造 legacy task snapshot；v1→v4→`rebuildProjections` 后 relation/digest 一致；projection upsert 改 `ON CONFLICT` 避免 FK RESTRICT。

## 3. 独立复跑（PR HEAD `735e825`，已同步 main `c2c3eba`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；468 modules
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 180 files / 1212 tests passed
```

> plain 并行有既有 5s timeout；串行全绿。

## 4. 回归/范围/gate

- scheduler/delete/PlanDraft/星图/审批/CRUD 全绿；scheduler queue 的 owner/dependsOn 均来自 relation。
- PR diff：store/projections/tests/memory/store/restore script/docs；无 gate/权限/事件/IPC/schema version 以外的业务变更；无新依赖/package。
- gate/权限/事件日志不变；旧列删除后 relation 为唯一事实源。

## 5. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #79 | MERGED（squash） |
| merge commit | `da071f1` |
| main | `da071f1` + 本报告提交 |
| t544 worktree | 已移除 |
| t544 branch | 已删除（local/remote） |
| 当前 worktree | 主工作区 + 其他任务 t548 |

## 6. 遗留（非阻塞）

1. v1 测试 fixture 含 v4 `task.created`，无法单独证明 `seedLegacySnapshots` 修复（N1 medium）。
2. restore 脚本不校验目标确为 v3（N2 low）。
3. v4 migration ROLLBACK 无 fault-injection（N3 low）。
4. 既有并行测试时序 timeout（N4 info）。

**最终结论：O1-4 PASS，PR #79 已 squash 合并 `da071f1`；fresh v4 无旧列、v2→v3→v4 backfill/DROP/FK/备份、relation-only 读、scheduler/delete/UI/PlanDraft/git、restore 脚本与 v1 snapshot 均集成验收；gate/权限/事件不变；无新依赖；遗留仅为 v1 fixture 证明深度/恢复演练项。**
