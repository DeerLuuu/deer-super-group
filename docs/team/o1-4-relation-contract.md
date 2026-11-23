# O1-4：task graph contract（删旧列/JSON）

- **任务**：t544 — O1-4（ARCH §2.5 contract）
- **范围**：v3→v4 删除 `tasks.owner_id`/`tasks.depends_on`；只读 `task_owners`/`task_dependencies`；删除旧 JSON 解析/回退与 `Store.updateTask({dependsOn})` 兼容；提供回滚脚本/文档。不改 gate/权限/事件/schema 以外的数据源，无新依赖。
- **结论**：v4 schema 与 relation-only 读写落地；旧列仅在 v2→v3 expand 迁移中读取，v4 完成后不再存在。

## 1. Schema v4

- `Store` 新建库直接使用无旧列的 `tasks` schema；v2 旧库仍经 v2→v3 回填 relation，再执行 v3→v4 contract。
- v3→v4：`ALTER TABLE tasks DROP COLUMN depends_on` / `owner_id`（若存在）；`PRAGMA user_version=4`；`schema_migrations` 记录 4；`PRAGMA foreign_key_check` 为空；失败 ROLLBACK、连接关闭、拒绝启动。
- 迁移前自动 `backupDatabase()`；`lastBackupPath` 指向 pre-contract v3 备份，回滚必须使用该备份。
- `getTask`/`listTasks`/`listQueuedTasks` 只查 relation；`toTask` 不再解析旧 JSON；`insertTaskProjection`/projection replay 不再写旧列。
- `Store.updateTask` 只接受普通 task 字段；owner/deps 只能走 `TaskGraphService`（`createTask`/`setOwner`/`setDependencies`）。
- `deleteAgent` 只查 `task_owners`；`deleteTask` 下游保护只查 `task_dependencies`；scheduler/UI/PlanDraft 使用 relation-first DTO。
- `src/memory/store.ts` 仅两处 legacy 查询（summary agent fallback）改为 `task_owners`；这是 v4 删除列后的必要 consumer 兼容，不改 memory schema/功能。

## 2. 回滚（必须恢复备份）

v4 后旧代码不能读库；回滚不是 revert 代码后继续使用当前 DB，而是：

1. 停止 DeerSuperGroup。
2. 找到 v3→v4 迁移前自动备份（`deer.db.v1-backup*` 中最新、`lastBackupPath` 记录；也可用发布前手工备份）。
3. 用脚本恢复到当前 DB：
   ```bash
   node scripts/restore-task-graph-backup.mjs <backup.db> <data-dir>/deer.db
   ```
   默认要求 backup `user_version=3`、现有 target `user_version=4`；受控演练可加 `--force`。
4. 脚本校验备份/恢复库的 integrity_check + foreign_key_check，先把原目标复制为 `deer.db.before-restore-<timestamp>`，恢复失败会回写原目标。
5. 启动回滚版本的代码；v3 旧列/relation 双读可用。

> contract 后不承诺旧代码读 v4；不要只 revert O1-4 代码后保留 v4 DB。

## 3. 测试边界

- v2 fixture 经 v3 回填到 v4：relation 快照正确、`owner_id`/`depends_on` 列消失、`foreign_key_check=[]`、pre-contract 备份存在且仍为 v3 形态。
- v2 bad JSON/跨 workspace/环/缺失/自依赖/重复/超限：v3 expand fail-closed，user_version=2、无 relation 表。
- v3→v4：旧列删除、relation 保留、pre-contract 备份仍为 v3 形态；`foreign_key_check=[]`。
- v1 legacy snapshot：旧列存在时 snapshot 保留 raw owner/deps；v1→v4→rebuild 后 relation/digest 一致。
- scheduler `listQueuedTasks` 批量覆盖 `dependsOn` relation。
- v4 中途失败（legacy index 阻止 DROP）：ROLLBACK 后 user_version=3/旧列保留/连接可重新打开。
- 真实 v4 自动 backup 经 restore 脚本恢复成功；backup v3/target v4 默认校验与 `--force` 覆盖。
- relation-only CRUD/scheduler/delete/PlanDraft/星图/审批回归；全量串行测试 180 文件/1211 用例通过。
- 源码 grep：生产代码除 v2→v3 迁移 backfill 与 v4 DROP 语句外无旧列/旧 JSON 读写；UI/scheduler 无 raw legacy。
- 回滚脚本语法/帮助与备份恢复路径（`scripts/restore-task-graph-backup.test.ts`）。

## 4. 命令

```text
pnpm typecheck
pnpm build
pnpm test -- --testTimeout=30000 --maxWorkers=1
```

基线：typecheck 0；build 0（468 modules，index 381.85 kB/gzip 113.81）；串行 test 180 文件/1211 用例全绿。
