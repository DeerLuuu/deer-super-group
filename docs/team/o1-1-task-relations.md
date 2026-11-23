# O1-1：v3 任务关系表 + 回填 + 双读

- **任务**：t498 — 实现 O1-1（ARCH v2 §2 expand 阶段）
- **范围**：仅 `src/kernel/store.ts`、迁移/回读测试、文档；不改 scheduler/UI 写路径、review/merge gate、IPC、权限；无新依赖。
- **结论**：v3 relation schema、v2→v3 安全迁移/备份、owner/dependency 回填、失败回滚、relation-first 双读与旧列镜像落地。

## 1. v3 schema

连接建立后立即 `PRAGMA foreign_keys = ON`；`PRAGMA user_version=3`。

```sql
CREATE TABLE task_owners (
  task_id    TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL,
  assigned_by TEXT NOT NULL
);

CREATE TABLE task_dependencies (
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  ordinal             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX idx_task_dependencies_parent
  ON task_dependencies(depends_on_task_id, task_id);
```

`schema_migrations` 增加 version=3；旧 `tasks.owner_id/depends_on` 在 O1-1 保留为兼容镜像。

## 2. 迁移顺序（v2 → v3）

1. 若数据库已有 `tasks` 且 user_version<2，先执行既有 v1→v2 迁移（原有备份/失败 closed 逻辑不变）。
2. v3：`PRAGMA foreign_keys=ON` → `backupDatabase()`（沿用 `lastBackupPath`/`.v1-backup` 机制，同名已存在则追加时间戳）→ `BEGIN IMMEDIATE`。
3. 建 relation 表；从 tasks 回填：
   - owner 必须存在于 `agents` 且同 workspace，否则失败；
   - `depends_on` 必须是合法 JSON 字符串数组；每个依赖存在且同 workspace；拒绝自依赖、重复、环、>100；`ordinal` 保留顺序。
4. `schema_migrations(3)`、`user_version=3`；同事务内 `PRAGMA foreign_keys=ON` 校验 + `PRAGMA foreign_key_check` 无违规后 COMMIT。
5. 任一步失败：ROLLBACK，旧 tasks 完整；user_version 保持 2；错误 `task graph migration failed (user_version stays 2, backup: ...)`；构造器关闭连接、拒绝启动，不产生半成品。

## 3. 双读 / 写入镜像

- `getTask/listTasks`：v3 下以 `task_owners`/`task_dependencies` 为准；owner 无行 = null，依赖按 `ordinal, id` 排序。relation 表不可用时回退旧列（兼容旧读取路径）。
- 现有 `insertTaskProjection` / `updateTask({ownerId,dependsOn})` 在 Store 层同步 relation 镜像，旧列继续写；O1-2 的 TaskGraphService 可继承该事务路径。
- `deleteAgent` 由 FK `ON DELETE CASCADE` 清 owner 行；有下游的 `task_dependencies` 由 `ON DELETE RESTRICT` 保护（deleteTask 现有检查仍先给出用户可读错误）。
- Task DTO 字段 `ownerId/dependsOn` 不变，UI/scheduler 无需改调用点。

## 4. 测试

`src/kernel/store.v3.test.ts`（11 例）：

- v2 fixture→v3：表/索引/FK/user_version/foreign_keys/foreign_key_check、owner/deps 回填、旧列镜像、备份存在、owner/deps 行数；
- 写入镜像：create/update owner/deps 后 relation 与旧列一致，clear 后 relation 空；
- relation 表缺失时回退旧列；
- 坏 JSON、跨 workspace owner、owner 缺失、依赖缺失、自依赖、重复依赖、超 100、依赖环：迁移失败且 user_version 仍 2 / 无 relation 表；
- 备份不可写：fail-closed 且无 relation 表。

既有 migration/backup tests 更新 user_version 预期为 3；`src/memory/store.test.ts` 同步（该测试读取内核 schema 版本）。

## 5. 命令

```text
pnpm typecheck
pnpm build
pnpm test -- --testTimeout=30000 --maxWorkers=1
```
