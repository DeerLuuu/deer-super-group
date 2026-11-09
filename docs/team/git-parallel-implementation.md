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
pnpm test        # 23 files / 330 tests passed（t104 基线 22/316；Git 专项 36 + GitPanels loading 3）
```

Git 专项覆盖：GitExec 白名单/脱敏/真实命令；迁移 6 列/旧库；CommitGuard；worktree 创建/容量/defer/`.deer-git` 回退/finalize/清理；MergeQueue 批准/一次合并/三种 mergeMethod/冲突/本地 ready/幂等 enqueue；admission；Manual/Local/async provider；bare remote push；enterprise REST（mock fetch）；waive；崩溃 reconcile；kernel run.started sandbox 一致性/容量 defer；abort+finalize；ChecksRunner 成功/失败；squash 内容校验；Git 事件 type/schema。全部零网络。

## 4. AC 映射（设计 §10 摘要）

| AC 组 | 状态 | 证据/备注 |
|-------|------|-----------|
| AC-WT-01/02/03 | 已实现 | degraded 回退、branch/worktree、attempt 复用；Git 测试 |
| AC-WT-04 | 已实现 | 3 槽容量 + kernel beforeStart defer（queued/attempt 0/无 Run）测试 |
| AC-WT-05/06/07 | failed | 创建失败清理、no_changes/commit、reconcile 已实现；崩溃进程级夹具仅 reconcile 层，未做 OS kill 级 |
| AC-WT-08/09/10/11/16 | passed | realpath/lstat + symlink/junction 逃逸测试（AC-WT-08）；exclude、冲突分支、`.deer-git` 回退/清理 |
| AC-WT-12/13/14/15 | passed | `scopePaths` 落库；AC-WT-13 cancel WIP/preserve 集成测试；AC-WT-14 stale reclaim（`git.worktree_reclaimed`）；AC-WT-15 busy defer |
| AC-GIT-01 | passed | 29 行表驱动（§5.2.1 #1–#29）+ 危险变体拒绝；`git.test.ts` t111 AC-GIT-01 |
| AC-GIT-02..13 | failed | commit/push/脱敏/无 shell/错误码与 PR-11 并发有测试；其余未逐条覆盖，真实 gh/企业 host 未集成 |
| AC-EVT-01/02/04/05 | passed | `emitGitEvent` 先 zod 校验再写 eventStore；34 type 注册 t68 registry；非法 payload 不落库测试 |
| AC-MQ-06 | passed | mergeQueue.recover merged/conflict/unknown 夹具；approval/waiver 清理；二次 recover 不重复 |
| AC-MQ-01..05/12 | failed | 队列/一次一个/checks/approved/merge 测试已有；未逐条覆盖 |
| AC-MQ-05/08/09/10/11/13 | failed | 冲突任务、waive、tree 校验、local/manual ready、head 变化 reset 有实现但未逐条测试 |
| AC-PR-11 | passed | B3 RepoLock/DB 唯一占位 + 并发 createPr 返回同一 PR |
| AC-PR-01..10 | failed | GitHub/Manual/Local、REST enterprise mock 有覆盖；真实网络/企业 host 未集成 |
| AC-MIG-01/05/06 | passed | 表创建/迁移/旧库升级；AC-MIG-06 测试 |
| AC-KRN-01..04/06/07 | passed | run.started sandbox、prepare cwd、defer、degraded、abort/finalize 测试 |
| AC-KRN-05 | passed（模拟） | stale owner token finalize 拒绝、reclaim/busy 夹具；真实 kill -9 级仍为模拟 |
| AC-KRN-08/AC-TYPE-01 | passed | `git.test.ts` 类型探针（prepare 含 agentId、Git/Kernel 类型互赋、TaskVcs/MergeQueueItem/RepoDiagnostics 字段快照） |
| UI/键盘/ARIA/窄屏 | passed（manual-only 细节见 §8） | t103 已挂载；t111 加 loading/aria-busy；SSR loading 测试 3 项；Esc/Tab/焦点环/窄屏用 mock fixture Electron 冒烟（手动例外） |

## 5. 遗留项 / 阻塞

1. **UI 挂载（已关闭）**：t103 已接入 App/TeamDashboard；t111 增加 loading/aria-busy，详见 §8。
2. **真实网络/企业 host（中）**：GitHub REST 用 mock fetch 验证 URL/解析；真实 gh、限流、企业 host 未集成测试。
3. **AC 逐条覆盖（中）**：t111 已补 AC-GIT-01 29 行、AC-WT-08/13/14/15、AC-MQ-06、AC-KRN-08/AC-TYPE-01；AC-GIT-02..13/AC-MQ-01..12 其余条目仍未逐条；OS kill 级真实进程夹具仍为模拟。
4. **事件注册（已关闭）**：`emitGitEvent` 已注册 34 个 Git type 到 t68 eventRegistry，所有 Git 写入点统一走 zod + schemaVersion=2。
5. **kernel 跨切面改动（流程）**：`src/kernel/execution/kernel.ts` 的 30 行 environment hook 不在 t102 原始 in-scope 列表，但为 run.started/投影一致所必需；请评审确认接受或调整 scope。
6. **local/manual verifyIntegrated（P1 降级）**：后端 `verifyIntegrated` 已有，但 t111 outOfScope 含 electron/shared IPC，无法为 UI 新增通道；本任务显式降级为 P1（接受记录见 §8.4），MergeQueueModal 对 local/manual ready 只展示说明。
7. **PR 并发幂等（已关闭）**：B3 用 RepoLock + DB 事务占位 + 唯一键，补并发 createPr 测试。
8. **合并锁（未完成）**：队列单进程一次一个；多实例/崩溃租约 fencing 仍未完整实现。

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
2. **组件内部 loading（已修复 t111）**：`TaskVcsPanel`/`MergeQueueModal` 首次加载显示 `role=status` + `aria-busy`，不再先显示空态；`GitPanels.test.tsx` SSR 覆盖初始 loading。
3. **无真实仓库/gh 端到端**：本次 mock fixture 验证 UI/IPC 形状；真实 Git 仓库、GitHub checks/PR、权限拒绝的端到端需 t104/集成环境验证。
4. **合并队列 local/manual verifyIntegrated（P1 降级）**：t111 outOfScope 含 electron/shared IPC，无法新增 UI 通道；显式列为 P1，MergeQueueModal 对 local/manual ready 展示说明，待后续 IPC 任务提供按钮。

## 8. t111 repair-round-2（B1–B4 / F5–F9）

> t104 findings：B1 worktree realpath、B2 Git 事件未接 t68 registry、B3 PR 非幂等、B4 G3 fencing 未完成；F5 AC 覆盖、F6 recover、F7 UI 测试/loading、F8 文档计数、F9 local/manual verifyIntegrated。t111 在 PR #4 内修复，仅改 `src/git/` 与本文档。

### 8.1 B1 realpath/lstat（AC-WT-08）

- `worktreeManager.ts` 新增 `validateWorktreePath(runtimeRoot,target)`：路径 resolve 后必须在 root 内；逐段 `lstat` 拒绝 symlink/junction；对已存在祖先做 `realpathSync.native` 并再次确认在 realRoot 内；root 自身为 symlink 也拒绝。
- `prepareSync` / `prepare`：创建前校验一次，`git worktree add` 后再次校验；reclaim/remove 前也校验，不安全路径标记 orphaned 且不执行删除。
- 测试：`validateWorktreePath` traversal；Windows junction/目录 symlink 指向 runtimeRoot 外时 `prepareSync` 返回 `GIT_PATH_ESCAPE`，外部目录未被触碰（AC-WT-08）。

### 8.2 B2 emitGitEvent + eventRegistry（AC-EVT-01/02/04/05）

- `events.ts` 新增 `registerGitEventTypes()`：把 34 个 `GIT_EVENT_TYPES` 的 zod schema 注册进 t68 `EVENT_REGISTRY`（运行时扩展，不改 `src/kernel/` 文件；`isKernelEventType` 可查到）。
- 新增 `emitGitEvent(store,input)`：先 `validateGitEvent`，再 `assertKernelEventPayload(type,payload,2)`，最后 `store.appendEvent({schemaVersion:2})`；所有 Git 写入点（`gitService.ts`、`mergeQueue.ts`、`worktreeManager.ts`）已替换，无 raw `store.appendEvent`。
- 修正实际 payload 与 schema 不一致：`git.commit_blocked` 补 files/errorCode；PR 失败走带 branch/remote 的 `git.push_failed`；merge checks 事件允许 runner summary 字符串；recover 冲突/未知补 blocked。
- 测试：34 type 注册可查；非法 `git.commit` payload 抛错且 events 表计数 0；合法事件 schema_version=2。

### 8.3 B3 PR 幂等（AC-PR-11/AC-GIT-12）

- `GitService` 新增 `prLock = new RepoLock()` 与 `ensurePullRequest()`：
  - `pr:<workspace>:<provider>:<task>` 锁串行化同一 PR 的 check/create/refresh/upsert；
  - `reservePr()` 用 `BEGIN IMMEDIATE` + `pr_records` 的 `(workspace,provider,task)` 唯一索引先占位（state=`creating`），跨进程冲突则回读；
  - 已有可用 PR 只 refresh 并写 `pr.updated`；新建写 `pr.created`；失败置 state=`failed` 允许重试；并发第二个调用返回同一 PR。
- finalize 的 autoCreatePr 与手动 `createPr` 统一走该 helper；不再有 check-then-create 分支。
- 测试：两个并发 `service.createPr(taskId)` 共用同一 context/provider，`createCalls=1`、两条结果同一 PR number、`pr_records` 只有 1 行。

### 8.4 B4 fencing token/run owner（AC-KRN-05/AC-WT-14/15）

- worktree lease token = `git-service:<runId>:<attempt>`，写入 `git_worktrees.lease_owner`；prepare/复用/接管时更新。
- `finalizeRun` 开始即校验：record 必须 active 且 `leaseOwner` 等于当前 runId/attempt 的 token；无 record 但同 task 已有其他 active run 时抛 `GIT_FENCING_STALE`；stale owner 在 commit/push/remove 前拒绝，`removeWorktree` 也接受 expected token。
- 测试：stale `leaseOwner` finalize 抛错且 worktree 仍 active；旧 run 在 reclaim 后 finalize 抛 `GIT_FENCING_STALE`；terminal stale reclaim 成功且 busy live run 返回 `GIT_WORKTREE_BUSY`（AC-WT-14/15）。

### 8.5 F5/F6 测试覆盖

- `AC-GIT-01`：29 行 argv 表驱动（rev-parse/remote/config/status/diff/log/show/cat-file/merge-base/patch-id/worktree/branch/check-ref-format/add/commit/format-patch/fetch/push/merge/merge-tree）+ 危险变体拒绝。
- `AC-TYPE-01`/`AC-KRN-08`：类型探针（prepare 含 agentId、Git/Kernel prepare 输入互赋、Git `PrepareRunResult` ok 赋给 kernel `RunEnvironment`、`GitRunEnvironmentProvider` 实现 `RunEnvironmentProvider`）+ `TaskVcs`/`MergeQueueItem`/`RepoDiagnostics` 字段快照测试。
- `AC-WT-13`：cancel 生成 `wip(task)` 本地 commit、默认移除 worktree；preserveWorktreeOnCancel=true 保留目录。
- `AC-MQ-06`：`mergeQueue.recover` 对 merging/updating：merged→merged+清 approval/waiver；conflicting→blocked+清理；provider unknown→blocked+清理；第二次 recover 不再处理，无重复 merge。
- **AC 映射**见 §4（已从「部分」更新为 passed/failed；仍未完成项保留真实网络/OS kill/其余 AC 逐条）。

### 8.6 F7 GitPanels loading + 测试/手动例外

- `TaskVcsPanel` 首次加载 `role=status`「加载 Git 状态…」+ `aria-busy`；`MergeQueueModal` 打开时「加载合并队列…」+ `aria-busy`；`GitSettingsPanel` 加载 `role=status`「加载中…」；不再先显示空态。
- 新增 `src/git/ui/GitPanels.test.tsx`（React SSR，不依赖 jsdom/RTL）：TaskVcsPanel 初始 loading 不显示空态；MergeQueueModal open/closed 与 loading；GitSettingsPanel 初始 loading。
- **manual-only 例外**：仓库未安装 jsdom/@testing-library，Esc/Tab 焦点环/焦点回焦/窄屏 class 不做 RTL；按 t103 mock fixture Electron 构建产物冒烟（`docs/team/t103-task-vcs.png`、`t103-git-settings.png`、`t103-merge-queue.png`）记录：打开/关闭、Esc 关闭队列、Ctrl+K 命令、980×735 窄窗、深链聚焦。该例外已在本节固定，后续若引入 RTL 再替换。

### 8.7 F8/F9

- F8：§3 已更新为 t111 实测 **23 files / 330 tests**（t104 基线 22/316；Git 专项 36 + GitPanels 3），并注明 Git 专项。
- F9：local/manual `verifyIntegrated` **P1 降级**。原因：t111 outOfScope 含 `electron/` 与 `src/shared/ipc.ts`，无法在不越界的情况下新增 `verifyIntegrated` IPC；真实调用后端已有但 UI 不提供按钮。MergeQueueModal 对 local/manual ready 展示说明，验收记录在本节与 §5.6；后续由独立 IPC/UI 任务提供。

### 8.8 验证

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 0 |
| `pnpm build` | ✅ 0（393 modules；css 202.22 kB / gzip 22.60；js 1,085.33 kB / gzip 298.16；electron main 1.1mb、preload 4.9kb） |
| `pnpm test` | ✅ 0（23 文件 / 330 用例；t111 新增 14：Git 11 + GitPanels 3；Git 专项 36） |

### 8.9 改动文件（t111）

```text
src/git/worktreeManager.ts   B1 realpath/lstat + fencing token + reclaimed event
src/git/events.ts            B2 emitGitEvent + 34 type registry + schema fixes
src/git/gitService.ts        B3 ensurePullRequest + B4 finalize fencing + payload fixes
src/git/mergeQueue.ts        B2 emit + F6 recover conflict/unknown cleanup
src/git/ui/GitPanels.tsx     F7 loading/aria-busy + local/manual P1 note
src/git/git.test.ts          B1–B4/F5/F6/AC tests
src/git/ui/GitPanels.test.tsx F7 SSR loading tests
docs/team/git-parallel-implementation.md
```

未改 `src/kernel/`、`electron/`、`src/SettingsView.tsx`、`src/memory/`、`dist*`。


