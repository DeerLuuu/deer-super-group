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

## 7. t103 UI 挂载（PR #4 内）

> 依赖 t102 的 Git 后端/IPC 与 t96 的 `src/git/ui/GitPanels.tsx`。t103 只做挂载、路由/命令与样式，不改 `src/git/`、`src/SettingsView.tsx`、`electron/`、`src/kernel/`。

### 7.1 入口映射

| 入口 | 位置 | 行为 |
|---|---|---|
| 任务 VCS | 任务页详情 `#task-git-section` | 内联 `TaskVcsPanel`（按 taskId 重挂载，避免切换任务时显示旧数据）；分支/基线/Head/PR/Checks/合并/降级原因；创建 PR、加入合并队列、清理 worktree |
| 设置 Git 区 | App 设置 Modal 内 `#settings-git`（`SettingsView` 之后） | `GitSettingsPanel`：模式/Provider/基线/容量/checks/审批/自动合并/mergeMethod；不展示 token 输入；`git=1` 深链滚动并聚焦该区 |
| 合并队列 | App 级 `MergeQueueModal`；团队进度头「合并队列」；命令面板 | 串行队列、批准/合并/豁免 checks（原因 ≥8 字）；Esc/Tab trap 由组件提供 |
| 命令面板 | `CommandPalette` 新增「Git」组 | 打开合并队列 / 打开 Git 设置 / 打开当前任务 Git 状态（无任务时回退首个任务并提示） |
| 团队页 | 进度头「合并队列」+ 选中任务「Git 状态」 | 前者打开队列；后者跳到任务页并聚焦 VCS 区 |

### 7.2 深链（C12 扩展）

`src/shared/deeplink.ts` 新增（保持既有 `t/task/m/b` 兼容）：

- `#/tasks?t=<taskId>&vcs=1`：任务页 + 聚焦 Git 区；
- `#/tasks?t=<taskId>&merge=1` / `#/team?t=<taskId>&merge=1`：打开合并队列，保留任务/团队上下文；
- `#/settings?git=1`：打开设置 Modal 并聚焦 Git 区。

`buildHash` 仅在对应 tab 写入：`vcs` 仅 tasks、`merge` tasks/team、`git` settings；关闭 Modal/离开页面时自动移除。`parseHash` 的 `merge/git/vcs` 布尔值默认为 false，旧深链不受影响。`deeplink.test.ts` 增加解析/生成/往返/非 1 值不误开用例。

### 7.3 IPC / 安全复核

- 复用 t96 已接线的 13 个 `git:*` 通道（`src/shared/ipc.ts` / `electron/preload.ts` / `electron/main.ts`）；本任务未改 electron 文件。
- `getTaskVcs/getGitSettings/mergeQueue` 返回类型不含 token；`GitSettings` 无 token 字段；`GitSettingsPanel` 无 token 输入框；`git:open-pr` 仅接受 `https:` 并走 `shell.openExternal`，非法 URL 返回 null。
- `TaskVcsPanel` 请求失败以 `role=alert` 展示主进程错误（mock 验证 `permission denied`）；空 VCS 显示「尚未产生 Git 提交」，队列为空显示「队列为空」，设置加载显示「加载中…」。

### 7.4 无障碍/窄屏/回归

- `MergeQueueModal` 自带 `role=dialog`、`aria-modal`、Esc、Tab 焦点环；Task VCS/设置区为具名 section；设置 Modal 复用 C25 `Modal` 焦点陷阱。
- 深链焦点使用 `scrollWithin` 只滚动最近面板（避免 `scrollIntoView` 把整个窗口带偏），目标 `tabIndex=-1` 接收焦点。
- 窄 Dock：任务 Git 区 `dl` auto-fit、按钮换行；队列 Modal `min(720px,96vw)` + 720px 以下全宽；设置 Git 区 auto-fit；未新增 Dock 面板。
- 与 t69 冲突策略：t69 仍 OPEN；本次在 t96 现有 App 上做加法式挂载，待 t69 合入 main 后 `branch:sync` 解冲突，不提前合并 t69。
- 非本任务范围：`SettingsView` 不改，因此设置内 Git 区位于设置主体下方而非新增左侧导航项；如需独立「Git」设置 tab，需另开任务改 SettingsView。

### 7.5 验证（t96 worktree，PR #4）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 0 |
| `pnpm build` | ✅ 0（393 modules；css 202.22 kB / gzip 22.60；js 1,084.68 kB / gzip 297.95；electron main 1.1mb、preload 4.9kb） |
| `pnpm test` | ✅ 0（22 文件 / 316 用例；新增 deeplink Git 路由用例，Git 专项 25 项与内核基线全绿） |

Mock fixture Electron 构建产物冒烟（`window.deer` mock，不连接真实仓库）：

- `#/tasks?t=t1&vcs=1`：任务详情 Git 状态、PR/Checks/合并、动作按钮渲染；`VCS_ERROR` 实测 `permission denied` 以 alert 展示；`VCS_EMPTY` 实测空 VCS 文案；
- `#/settings?git=1`：设置 Modal 打开并滚动/聚焦 `#settings-git`，Git 表单可编辑；
- `#/tasks?merge=1`：合并队列 Modal 打开；Esc 关闭验证 `QUEUE_OPEN=true` → `QUEUE_CLOSED=true`；
- Ctrl/⌘+K：命令面板「Git」组存在三项命令；窄窗 980×735 任务 Git 区可用。

截图：[t103-task-vcs.png](t103-task-vcs.png)、[t103-git-settings.png](t103-git-settings.png)、[t103-merge-queue.png](t103-merge-queue.png)。

### 7.6 遗留

1. **t69 合并后 sync**（流程）：本次基于 t96 当前 App 挂载，t69 合入后需解 App/TeamDashboard/CommandPalette/deeplink/styles 冲突并复跑三命令。
2. **组件内部 loading**：`TaskVcsPanel`/`MergeQueueModal` 首次加载期间先显示空态（组件在 `src/git/`，t103 out of scope 未改）；`GitSettingsPanel` 有「加载中…」。如需 skeleton，另开组件修复任务。
3. **无真实仓库/gh 端到端**：本次 mock fixture 验证 UI/IPC 形状；真实 Git 仓库、GitHub checks/PR、权限拒绝的端到端需 t104/集成环境验证。
4. **合并队列 local/manual verifyIntegrated**：沿用 t96 遗留，UI 未提供该按钮。

