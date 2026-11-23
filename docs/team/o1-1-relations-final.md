# O1-1 任务关系表 v3 · 最终集成验收（t501）

- **任务**：t501 — 最终集成 O1-1（t498 实现 → t499 PASS → t500 review）
- **PR**：[#72](https://github.com/DeerLuuu/deer-super-group/pull/72) — **MERGED（squash）**
- **合并提交**：`81f437a`
- **实现文档**：`docs/team/o1-1-task-relations.md`
- **验证**：`docs/team/o1-1-task-relations-verification.md`（t499 PASS）
- **复审**：`docs/team/o1-1-task-relations-review.md`（t500 pass）
- **结论**：**PASS，已合并**；t498 worktree/branch 已清理，`git worktree list` 仅主工作区。

## 1. 迁移/回填/双读可追溯

`src/kernel/store.ts`：

- `PRAGMA foreign_keys=ON`；v3 新增 `task_owners` / `task_dependencies` / `schema_migrations`，含字段、索引、FK、CHECK、`user_version=3`。
- v2→v3：`backupDatabase`（记录 `lastBackupPath`）→ `BEGIN IMMEDIATE` 建表/回填/`foreign_key_check`/设置 version → COMMIT；失败 ROLLBACK、关闭连接、拒绝启动。
- 回填：owner 同 workspace；deps 合法数组/目标存在/同 workspace/拒绝自依赖/重复/环/>100；ordinal 保留。
- 备份不可写 fail-closed；迁移异常回滚后 `user_version=2` 且无 relation 表。
- 双读：`getTask/listTasks` relation-first；relation 表缺失时回退旧列。现有 create/update 同步 relation 镜像，旧列继续写。
- 删除保护：`deleteAgent` FK cascade；`deleteTask` 有下游依赖时 restrict/保护。

测试覆盖（`store.v3.test.ts` 11 例）：schema/FK/索引/version；v2 fixture 备份与回填；坏 JSON/跨 workspace/缺失/自依赖/重复/超100/环 fail-closed；备份不可写；迁移异常回滚；relation-first/旧列回退；create/update 同步；deleteAgent cascade/deleteTask 下游保护。

## 2. 独立复跑（PR HEAD `a5f33a6`，main `91adc34`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；466 modules
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 173 files / 1131 tests passed
```

> plain 并行有既有 5s timeout；串行全绿。

## 3. gate/权限/事件不变；无新依赖

- PR diff 仅 `src/kernel/store.ts`、`store.v3.test.ts`、两个既有测试 version 断言、文档；无 scheduler/UI 写路径改动。
- review/merge gate、权限/审批、事件日志路径未修改；无 IPC/schema 外部契约变更；无新依赖/package/lockfile。
- 旧列继续镜像写入，O1-2 前保持兼容；O1-1 不含写入侧跨 workspace/环/超100 校验（review N1 medium，留给 O1-2 TaskGraphService）。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #72 | MERGED（squash） |
| merge commit | `81f437a` |
| main | `81f437a` + 本报告提交 |
| t498 worktree | 已移除 |
| t498 branch | 已删除（local/remote） |
| 当前 worktree | 仅主工作区 |

## 5. 遗留（非阻塞）

1. 写入侧跨 workspace/环/超100 校验由 O1-2 TaskGraphService 统一边界（N1 medium）。
2. v1 旧库迁移可能经历两次备份（N2 low）。
3. relation 缺失回退为合成测试，未做真实 App 冒烟（N3/N4 low）。
4. 既有并行测试时序 timeout（N5 info；CI 串行）。

**最终结论：O1-1 PASS，PR #72 已 squash 合并 `81f437a`；v3 schema/备份/回填/fail-closed/relation-first 双读/删除保护均集成验收；review/merge gate、权限、事件日志不变；无新依赖；遗留仅为 O1-2 写入边界与环境项。**
