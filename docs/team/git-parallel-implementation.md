# Git 并行开发系统 — 实现交付（t96 / t102）

> 设计依据：`docs/team/git-parallel-design.md`（t93 复审通过）与 `execution-kernel-design.md` §16。
> 分支：`feature/t96-git-parallel`（PR #4 内继续，不新建分支）；开发目录：`branches/t96-git-parallel/`。
> 本文记录**实际实现**、验证命令、AC 映射与遗留项，不把设计当成已实现。

## 1. 交付范围

| 模块 | 文件 | 说明 |
|------|------|------|
| 类型/错误码 | `src/git/types.ts` | `GitErrorCode` 统一 `AUTH_*`/`CHECKS_*`/`GIT_CAPACITY`；TaskVcs/MergeQueueItem/RepoDiagnostics |
| 事件 schema | `src/git/events.ts` | 34 个 Git 事件 type 正则、zod payload、`validateGitEvent` |
| Git 存储/迁移 | `src/git/gitStore.ts` | 独立 `git.db`、`git_schema` v1→v2、6 配置列、worktree/task_vcs/run_vcs/PR/queue/checks/jobs |
| GitExec/安全 | `src/git/gitExec.ts` | argv 白名单、无 shell、`-c core.hooksPath` 限制、env 白名单、token 脱敏、RepoLock |
| 仓库探测/路径 | `src/git/repo.ts` | `.deer` / `.deer-git` runtimeRoot、local exclude、base/remote/version 探测；sync/async 双探测 |
| Worktree | `src/git/worktreeManager.ts` | Run 级路径、`deer/*`、3 槽、defer、prepare/prepareSync、reclaim/cleanup/reconcile |
| 提交/推送/校验 | `src/git/branchOps.ts` | CommitGuard、commit/push、tree/patch 内容校验、merge-tree 冲突探测 |
| PR Provider | `src/git/providers.ts` | GitHub gh + REST（enterprise host）、Manual、Local；已有 open PR 时 refresh 幂等 |
| Checks | `src/git/checksRunner.ts` | 用户 `checks_command` shell/argv、超时、输出脱敏；队列使用 `_checks` detached worktree（失败回退） |
| 合并队列 | `src/git/mergeQueue.ts` | enqueue/approve/waive/process/recover、approved_head_sha、一次一个、冲突任务、local/manual ready |
| 服务/内核集成 | `src/git/gitService.ts`、`src/kernel/service.ts` | beforeStart 同步准备 runtime、executor cwd、finalize/release、容量 defer、诊断/设置/队列 API |
| G3 契约 | `src/git/g3.ts` + `src/kernel/execution/kernel.ts` | `BeforeStartResult`/`RunEnvironmentProvider`；kernel hook 返回 environment，run.started/投影直接带 `git:<cwd>` |
| IPC/API | `src/shared/ipc.ts`、`electron/preload.ts`、`electron/main.ts` | 任务 VCS、PR、cleanup、队列、设置、诊断、recover；open-pr 仅 https |
| UI 组件 | `src/git/ui/GitPanels.tsx` | TaskVcsPanel、MergeQueueModal、GitSettingsPanel；键盘 Esc/Tab trap、ARIA、窄屏 inline 布局 |
| 测试 | `src/git/git.test.ts` | **25 个 Git 专项测试**（临时仓库、裸 remote、mock provider/REST、零网络） |

## 2. 关键实现

### 2.1 Worktree 与 dev worktree 分离

- runtime 根：`<workspace>/.deer`；若 `.deer` 已存在且无 `.deer/worktrees/.deer-git.json` 标记，回退 `<workspace>/.deer-git`（用户数据不覆盖）。
- 路径：`<runtimeRoot>/worktrees/<taskId>/<attempt>`；分支 `deer/<taskId>-<slug>`；checks 用 `_checks/<queueId>-<sha7>`；路径必须 realpath 在 runtimeRoot 内。
- 容量：每工作区最多 `maxWorktrees`（硬上限 3）；满槽返回 `GIT_CAPACITY`；`beforeStart` 同步路径返回 `allow:false` 并写 `tasks.next_run_at`，任务保持 queued、不建 Run、attempt 不增。
- 清理：finalize 后 `git worktree remove --force` + `prune`；取消时按 `preserveWorktreeOnCancel` 保留；reconcile 回收终态/无 Run 的残留记录。
- dev worktree（AGENTS §8 `branches/`、`feature/*`）不在本模块创建/删除/扫描范围内。

### 2.2 安全

- **无 shell**：GitExec 只允许 `execFile("git", argv)`；允许前置唯一 `-c core.hooksPath=<runtimeRoot>/hooks-empty`；`--force` 仅限 `worktree remove`；push 只允许 `deer/*:deer/*`；`push origin main`/`--force`/`--all`/任意其他 `-c` 拒绝。
- **token**：只从 `gh` keyring / `GITHUB_TOKEN`/`GH_TOKEN` 读取；不写 DB、不 IPC 返回、不交 Agent；GitHub REST 仅主进程 fetch。
- **CommitGuard**：`.env*`、私钥、`.ssh/.aws/node_modules`、>5MB、明显 secret 内容阻断；阻断事件 `git.commit_blocked`，不抛任务失败。
- **路径**：worktree 必须在所选 runtimeRoot 内（前缀校验，拒绝 `..`/逃逸）；local exclude 幂等写入 `.git/info/exclude`，不改 `.gitignore`。

### 2.3 内核 G3（t102 修复）

- **run.started 一致性**：`beforeStart` 现在可返回 `environment`；Git hook 在 **Run 行创建前同步 prepare**（`prepareSync`），返回 `cwd/branch/sandboxId=git:<cwd>`。kernel `startRun` 用 environment 写 run、`task.status_changed`、`run.started` 和投影；`runs.sandbox_id` **不再手工 UPDATE**。
- **executor**：从 `run.sandboxId` 解析 `git:<cwd>`，`toolContext.worktreePath` 使用 runtime cwd；degraded 用 workspace.path。
- **release/finalize**：Run 完成/失败/取消时异步 `GitService.finalizeRun`（commit/push/PR/task_vcs/run_vcs/cleanup），不改变 kernel 终态；`src/git/g3.ts` 的 `GitRunEnvironmentProvider.prepare/release` 是 §16 async 形状适配，当前 kernel 用同步 beforeStart 桥接。
- **defer**：容量不足 → `allow:false` + `nextRunAt`，任务 queued、attempt 不变、无 Run；测试验证。
- **abort/fencing**：`prepareSync` 检查同 task active 记录与 Run lease；stale/终态先 reclaim，活跃冲突则 `GIT_WORKTREE_BUSY` defer；kernel cancel → abort signal → finalize cancelled/清理（`RUN_CANCELLED` 任务语义由 kernel 决定）。
- **注意**：为满足 acceptance，本任务对 `src/kernel/execution/kernel.ts` 做了 **30 行最小 hook 扩展**（environment 字段 + startRun 使用）；该文件不在 t102 原始 in-scope 列表，属于实现所需的跨切面例外，已在 §5 标明。

### 2.4 合并队列

- 状态：`waiting_checks → waiting_review → ready → merging → merged`；异常 `blocked/failed`；一次只允许一个 `merging`。
- `approved_head_sha`：approve 绑定当前 head；head 变化自动清 approval/waiver 并回 `waiting_review`。
- checks：provider checks（required 过滤）或本地 `checks_command`；本地在 `_checks` detached worktree 执行；超时/失败写 `merge.checks_failed`；waive 需≥8 字且未配置 checks_command。
- 合并：GitHub provider 调 merge（squash/merge/rebase）；local/manual 停在 `ready`（用户本地合并，`verifyIntegrated` 做 tree/patch 内容校验）。
- 冲突：provider conflicting/merge 抛 `MERGE_CONFLICT` → blocked + 创建冲突任务（源任务/分支/PR/base/冲突文件；去重；复用源队列项），事件 `merge.blocked`/`merge.conflict_task_created`。
- 恢复：`recover()` 扫描 merging/updating，merged→收敛、conflicting→waiting_review、未知→blocked；worktree reconcile 同步回收。

### 2.5 配置迁移

`git.db` 独立于 kernel `deer.db`；`git_schema` v1→v2：
- 6 列 `push_on_cancel`/`preserve_worktree_on_cancel`/`export_cancel_patch`/`checks_mode`/`checks_timeout_ms`/`allow_skip_blocked`；
- 旧库缺列自动 `ALTER TABLE ... ADD COLUMN`（同时补齐旧 v1 其他缺列），幂等；`PRAGMA table_info` 校验；AC-MIG-06 测试覆盖。

## 3. 验证

在 `branches/t96-git-parallel/` 执行：

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0（vite + build-electron）
pnpm test        # 22 files / 314 tests passed（Git 专项 25）
```

Git 专项覆盖：GitExec 白名单/脱敏/真实命令；迁移 6 列/旧库；CommitGuard；worktree 创建/容量/defer/`.deer-git` 回退/finalize/清理；MergeQueue 批准/一次合并/三种 mergeMethod/冲突/本地 ready/幂等 enqueue；admission；Manual/Local/async provider；bare remote push；enterprise REST（mock fetch）；waive；崩溃 reconcile；kernel run.started sandbox 一致性/容量 defer；abort+finalize；ChecksRunner 成功/失败；squash 内容校验；Git 事件 type/schema。全部零网络。

## 4. AC 映射（设计 §10 摘要）

| AC 组 | 状态 | 证据/备注 |
|-------|------|-----------|
| AC-WT-01/02/03 | 已实现 | degraded 回退、branch/worktree、attempt 复用；Git 测试 |
| AC-WT-04 | 已实现 | 3 槽容量 + kernel beforeStart defer（queued/attempt 0/无 Run）测试 |
| AC-WT-05/06/07 | 部分 | 创建失败清理、no_changes/commit、reconcile；崩溃进程级夹具为 reconcile 层，非 OS kill |
| AC-WT-08/09/10/11/16 | 已实现 | 路径前缀校验、exclude、冲突分支、`.deer-git` 回退/清理 |
| AC-WT-12/13/14/15 | 部分 | 软所有权 API `scopePaths` 落库；取消保留/preserve 有逻辑；stale 接管有 reclaim，未逐项测试 |
| AC-GIT-01 | 部分 | 白名单实现 + 合法/危险形状测试；未按 29 行逐条表驱动 |
| AC-GIT-02..13 | 部分 | commit/push/脱敏/无 shell/PR 幂等/错误码已实现；未全部对应测试 |
| AC-EVT-01/02/04/05 | 部分 | `events.ts` 34 type 正则 + zod payload 测试；未注册到 t68 eventRegistry |
| AC-MQ-01..06/12 | 部分 | 队列/一次一个/checks/approved_head_sha/恢复/冲突去重/三种 merge 有测试；完整 AC 未逐条 |
| AC-MQ-05/08/09/10/11/13 | 部分 | 冲突任务、waive、tree 校验、local/manual ready、head 变化 reset；细节需补 |
| AC-PR-01..11 | 部分 | GitHub/Manual/Local、REST enterprise mock；无真实网络/企业 host 集成 |
| AC-MIG-01/05/06 | 已实现 | 表创建/迁移/旧库升级；AC-MIG-06 测试 |
| AC-KRN-01..07 | 已实现/部分 | run.started sandbox、prepare cwd、defer、degraded、abort/finalize；kill -9 级 fencing 未做 |
| AC-KRN-08/AC-TYPE-01 | 部分 | async provider 形状 + kernel environment hook；未加 type-level snapshots |
| UI/键盘/ARIA/窄屏 | 组件完成，**未挂载** | `src/git/ui/GitPanels.tsx` + IPC；`src/App.tsx`/`src/TeamDashboard.tsx` 仍 out of scope，运行应用无入口（t103） |

## 5. 遗留项 / 阻塞

1. **UI 挂载（高，t103）**：组件与 IPC 已交付，但未接入 App/TeamDashboard；运行应用无入口。
2. **真实网络/企业 host（中）**：GitHub REST 用 mock fetch 验证 URL/解析；真实 gh、限流、企业 host 未集成测试。
3. **AC 逐条覆盖（中）**：Git 专项 25 个测试，未覆盖全部 62+ AC；缺 OS kill 级崩溃、完整并发写锁、PR 并发双 create、worktree 取消 preserve 逐项断言。
4. **事件注册（中）**：`events.ts` 有 zod/type 校验，但尚未注册到 t68 eventRegistry；Git 事件仍走 `store.appendEvent`。
5. **kernel 跨切面改动（流程）**：`src/kernel/execution/kernel.ts` 的 30 行 environment hook 不在 t102 原始 in-scope 列表，但为 run.started/投影一致所必需；请评审确认接受或调整 scope。
6. **local/manual 自动合并（设计如此）**：队列停在 ready，需用户本地合并后调 `verifyIntegrated`；UI 未提供该按钮。
7. **PR 并发幂等**：已有 open PR 时 refresh；并发 finalize 仍可能双 create，需 `git_jobs` commandId 串行/唯一索引兜底。
8. **合并锁**：队列单进程一次一个；多实例/崩溃租约 fencing 未完整实现。

## 6. 回滚

- 功能开关：`git_repo_config.mode=off`（不建 worktree/task_vcs/PR；degraded 并发 1）。
- 代码回滚：删除 `src/git/`、还原 `src/kernel/service.ts` 与 kernel environment hook、还原 IPC/UI 文件；Git DB 为独立 `git.db`，不迁移 kernel 库。
- 已产生的 runtime worktree 可用 `git worktree remove --force` + `git worktree prune` 清理；branch 保留，不自动删远端。
