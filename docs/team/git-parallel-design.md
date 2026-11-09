# Git 并行开发系统设计（worktree / PR / 合并队列）

- **任务**：t73 — Git 并行开发系统设计（完整基线，不做最小实现）
- **作者**：kai（Documentation & Integration）
- **日期**：2026-11-10
- **状态**：设计提案，待 Captain 审批后按 §12 分阶段创建实现分支
- **依据**：
  - `DESIGN.md` §7.1（并发写同一仓库）、§9 P0 第 4–9 条（DAG、Worker、worktree/分支/PR、行级评审、摘要、事件日志）
  - `AGENTS.md` §4（质量门禁）、§8（worktree/PR 并发开发，最多 3 个 active worktree，`branches/` 为本地目录）
  - `docs/team/execution-kernel-design.md`（t68/t69 内核：Run 生命周期、KernelHooks、并发/租约/恢复、v2 迁移；明确 Git 为非目标但保留 `branch/worktree` 字段与 Run 结束钩子）
  - 当前代码：`src/kernel/{service,store,tools,loop}.ts`、`src/shared/{types,ipc,copy}.ts`、`electron/{main,preload}.ts`、`src/App.tsx`、`src/TeamDashboard.tsx`、`scripts/branch-worktree.mjs`
  - 团队裁决：`bb-87`（内核优先）、`bb-88`（Git 并行 + 记忆系统作为辅助系统；设计阶段不占 worktree）
- **范围**：只读代码/文档，本任务不改任何代码；产出本设计供 Captain 审查。

---

## 0. 决策摘要（TL;DR）

| # | 决策 | 说明 |
|---|------|------|
| D1 | **所有 Git 操作只在主进程执行** | `execFile("git", args)`，不经过 shell、不拼接命令字符串；renderer/Agent 只拿 DTO，不直接执行 Git |
| D2 | **Runtime worktree 按 Run 生命周期创建/销毁，Branch 按 Task 生命周期保留** | 每个 Task 一条分支 `deer/<taskId>-<slug>`；每次 Run 一个 worktree（重试复用分支重新 checkout）；合并/取消后清理分支 |
| D3 | **Worktree 路径 `<workspace>/.deer/worktrees/<taskId>/<attempt>`** | `.deer/` 已在本仓库 gitignore；对用户仓库通过 `.git/info/exclude` 追加（仅本地、不提交）保证不污染 `git status` |
| D4 | **每工作区最多 3 个 runtime worktree**（可配置 1–3，硬上限 3）；与 AGENTS §8 的 **dev worktree（`branches/`）互不计数** | dev worktree 是开发本产品用的 3 个槽；runtime worktree 是产品替用户任务隔离出的槽；路径/分支前缀/计数完全分离 |
| D5 | **与内核并发协作：内核负责调度，Git 负责资源准入** | 内核默认 global 4 / workspace 2 / member 1；Git 每工作区 3 槽 → 默认有效并发 `min(2,3)=2`；准入失败必须「延迟(defer)」而不是任务失败 |
| D6 | **无 Git / 非仓库 / 无权限 → degraded 模式回退 workspace.path** | 任务照常执行（不隔离），`branch/worktree=NULL`，写 `git.degraded` 事件 + UI 提示；修复后下次 Run 自动恢复隔离 |
| D7 | **PR Provider 抽象：GitHub（gh CLI 优先，REST 兜底）→ Manual（无 gh）→ Local（无 remote）** | 无 remote 时退化为「本地分支 + 人工合并确认」；无 gh 但有 remote 时生成 compare URL + 人工标记合并 |
| D8 | **分支保护：应用永不 push main、永不 force push、merge 只经 Provider** | `main` 只接收 PR 合并；本地模式只能 ff/人工合并；可选安装 pre-push guard（用户显式开启） |
| D9 | **合并队列：每仓库同一时刻只合并一个 PR；持久化 FSM + 幂等键** | 队列项带 headSHA/baseSHA；合并前校验 checks + 人工批准 + mergeable；失败/冲突自动创建 `resolve-conflict` 任务（按 PR+baseSHA 去重） |
| D10 | **Git 自己的数据表（`task_vcs`/`run_vcs`/`pr_records`/`merge_queue`/…），不改内核 `tasks`/`runs` 表结构** | 避免与 t68 的 v2 迁移冲突；现有 `task.branch/worktree` 只作为缓存/投影；Git 迁移独立、幂等、可回滚 |
| D11 | **Git finalize 是异步 job（outbox），不在内核 Run 结束路径里做网络/重 IO** | `onRunFinished` 只入队（快），后台 worker 做 commit/push/PR，失败重试不阻塞内核 |
| D12 | **Agent 在 P0 不获得任何 Git 写操作工具** | 防止绕过保护；系统在 Run 结束时统一 commit/push。未来 `git.commit` 工具需单独评审 |
| D13 | **P0 合并门禁 = checks + 人工批准；行级评审（o2）后续接入同一接口** | 不依赖未实现的 diff UI；GitHub reviewDecision 有则用，无则用应用内批准记录 |
| D14 | **Git 事件纳入内核事件注册表扩展** | 事件名/ payload 由 Git 模块注册；t68 未落地前用现有 `store.appendEvent`，落地后走 v2 eventStore + 幂等键 |
| D15 | **分阶段：G1 Git 核心 → G2 PR Provider → G3 内核集成 → G4 合并队列 → G5 UI/恢复** | G1/G2 与 t68 内核并行不阻塞；G3 在内核 API 冻结后接入 |

**非目标（P0，明确不做）**：行级 diff/评论 UI（o2 系统）、完整 CI Runner（只消费 checks 或跑一条用户配置命令）、GitLab/Bitbucket（Provider 接口预留，P0 仅 GitHub）、代码签名/标签/Release、submodule/LFS、交互式 rebase/force push、跨仓库 PR、组织级 RBAC/多用户审计、云端合并服务、Agent 自动批准合并、自动解决冲突（只生成冲突任务，由人或 Agent 在任务内解决）。

---

## 1. 目标、非目标与术语

### 1.1 目标（正式实现）

1. **隔离**：每个任务在独立分支 + 独立 worktree 中执行，物理隔离并发写；主工作区不被 Agent 修改。
   - 明确覆盖 **DESIGN §9 P0 第 6 条（git worktree + 分支 + PR 创建）** 与 **§7.1 全部对策**（worktree/软所有权/合并队列/冲突任务/main 保护）；行级评审属于 P0 第 7 条，由 o2 系统实现，本设计只定义接口与合并门禁消费方式（§5.4、§6.6）。
2. **可追溯**：任务 ↔ 分支 ↔ commit ↔ PR ↔ 合并 commit 全链路可查，全部落事件。
3. **可合并**：PR 创建、检查、批准、合并队列、冲突任务形成闭环；一次只合并一个，失败可恢复。
4. **不阻塞内核**：Git 资源不足时任务延迟排队；Git 故障不把任务判失败；内核调度与 Git 资源解耦。
5. **安全**：token 不落库/不落日志/不交给 Agent；命令白名单；敏感文件阻止提交；路径与 ref 校验。
6. **可验证**：临时仓库 + 裸仓库 + mock provider 的确定性测试覆盖冲突、幂等、并发、恢复。
7. **可降级**：非 Git 工作区、无 remote、无 gh auth、离线都能继续用任务执行，只是没有隔离/PR。

### 1.2 非目标（显式）

- 不做多用户/远程执行器/分布式 merge 服务（单机主进程）。
- 不做行级评审 UI（t73 只定义 `reviewDecision`/approval 接口，o2 落地后接入）。
- 不做企业级分支策略矩阵（只保护 base 分支 + PR 必需）。
- 不做自动冲突语义合并（只看 mergeable/merge-tree，冲突生成任务）。
- 不做 Git hook 生态/自定义 hook 执行（提交前扫描由应用完成）。
- 不改 `scripts/branch-worktree.mjs` 的 dev 流程（AGENTS §8 继续有效）。

### 1.3 术语

| 术语 | 含义 |
|------|------|
| **dev worktree** | 团队开发 DeerSuperGroup 自己用的 worktree，位于 `branches/<task-id>-<slug>/`，上限 3（AGENTS §8），由 `pnpm branch:*` 管理 |
| **runtime worktree** | 产品为「用户工作区里的任务 Run」创建的隔离 checkout，位于 `<workspace>/.deer/worktrees/...`，本设计主体 |
| **task branch** | 每个任务一条 `deer/<taskId>-<slug>`，任务结束后按状态保留/清理 |
| **base branch** | 合并目标，默认 `main`（可配置 `master` 或其他受保护分支） |
| **PR Provider** | 创建/查询/合并 PR 的抽象；GitHub / Manual / Local 三种实现 |
| **merge queue** | 每仓库串行合并队列；一次合并一个 PR |
| **merge captain** | 冲突任务默认负责人（配置：human 或某个成员） |
| **degraded mode** | Git 不可用时的回退模式：在 `workspace.path` 直接运行，无分支/PR |
| **VCS state** | 独立于 Task 状态的分支/PR 状态（none/branch/pushed/pr_open/…/merged） |

---

## 2. 现状审计（HEAD 实读）

### 2.1 现状

| 能力 | 当前状态 | 证据 |
|------|----------|------|
| Git 仓库 | ✅ 本项目已是 Git 仓库，remote `https://github.com/DeerLuuu/deer-super-group.git`，gh 2.87 已登录（keyring，ssh 协议） | `git remote -v` / `gh auth status` |
| Dev worktree 流程 | ✅ `scripts/branch-worktree.mjs`：`start/sync/finish/remove/list`；`MAX_WORKTREES=3`；`branches/` 本地目录（gitignore）；branch `feature/<task>-<slug>`；`start` 先 fetch 并从最新 `origin/main` 起步；提 PR 前必须 `branch:sync`（finish 拒绝落后 main）；finish 只 push + `gh pr create`，不自动合并；PR 按 `.github/pull_request_template.md`（最小功能/同步主分支/验证/风险回滚/截图） | `scripts/branch-worktree.mjs:6,58,86,109–145,172–236,263–282`、`AGENTS.md` §8、`.github/pull_request_template.md` |
| 当前 dev worktree | 1 个：`branches/t64-interactive-canvas`（feature/t64-interactive-canvas），剩余 2 个槽 | `git worktree list` |
| 任务字段 | ✅ `tasks.branch`、`tasks.worktree` 已存在但**未被真正使用**：`runTask` 把 `worktree` 写成 `workspace.path`、`branch` 写成假值 `deer/<taskId>` | `src/shared/types.ts:69–79`、`src/kernel/service.ts:795–801` |
| Run 字段 | 只有 status/error/token；无 worktree/branch/commit/PR 字段 | `src/kernel/store.ts:82–93`、`types.ts:81–93` |
| Git 工具 | 只有只读 `git.status` / `git.diff`（cwd = `ctx.worktreePath`） | `src/kernel/tools.ts:601–627` |
| 事件 | `store.appendEvent` 通用写入；无 Git/PR 事件类型；无幂等键（t68 v2 才加） | `store.ts:377–404` |
| PR/合并 | 无任何 PR/合并队列/冲突任务代码或表 | 全仓 grep 无 `merge_queue`/`pull request` |
| 内核 v2 | 设计中（t68/t69 pending）：明确 Git 为非目标，只保留 `branch/worktree` 字段与 `KernelHooks.onRunFinished`；Run 有 `sandboxId`、lease、恢复 | `execution-kernel-design.md:32,67,390–472,538–569` |
| 工作区 | `workspaces.path` 为用户选择的任意目录；`ToolContext.worktreePath` 目前 = workspace.path | `service.ts:815–818` |
| 安全 | 权限门禁已实现（read_only/workspace_write/full_access/auto_risk）；`shell.run` 可执行（受权限约束） | t55 集成报告 |
| `.gitignore` | 已忽略 `.deer/`、`branches/`、`*.db`、`.env*` 等 | `.gitignore` |

### 2.2 缺口 → 设计章节

| 缺口 | 影响 | 对应章节 |
|------|------|----------|
| 无 runtime worktree/分支创建 | 并发任务互相踩文件；无法并行 | §4 |
| `task.branch/worktree` 是假值 | UI/审计误导；重试无恢复点 | §4.3、§7.1 |
| 无 commit/push/PR | 交付物停留在本地工作区，无评审/合并 | §5 |
| 无合并队列/冲突任务 | 多 PR 无法安全落 main；冲突靠人工发现 | §6 |
| 无 Git 资源准入 | 内核并发（4/2/1）与 3 worktree 上限可能冲突 | §4.4、§7.3 |
| 无安全边界（token/路径/命令） | 凭据泄露、注入、误提交 | §8 |
| 无 Git 事件/审计 | 无法回放/排障/验收 | §7.2 |
| 无 UI 状态 | 用户不知道分支/PR/合并/冲突 | §9 |

---

## 3. 架构总览

### 3.1 进程与边界

```text
┌──────────────────────────── Renderer（React） ────────────────────────────┐
│ TasksView：任务详情 VCS 区 / 合并队列入口（Modal）/ 冲突任务展示            │
│ Settings：Git 区（provider/base/remote/checks/approval/maxWorktrees）      │
│ 只调用 window.deer.*（preload 白名单），不执行 git、不持有 token           │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │ IPC（typed, KernelResult 风格）
┌──────────────────────────────────▼────────────────────────────────────────┐
│ Main（Electron 主进程）                                                    │
│  GitService（门面）                                                        │
│   ├─ RepoLocator        workspace→git root / remote / base 探测            │
│   ├─ GitExec            execFile("git", argv)，超时/输出上限/脱敏/仓库锁    │
│   ├─ WorktreeManager    runtime worktree 创建/复用/回收/启动 reconcile      │
│   ├─ BranchService      task branch 创建/校验/删除；commit/push             │
│   ├─ CommitGuard        敏感文件/大小/忽略规则/提交前扫描                    │
│   ├─ ProviderRegistry   GitHub / Manual / Local（统一接口）                 │
│   ├─ PrService          create/refresh/checks/review/merge/close            │
│   ├─ MergeQueue         串行 FSM + 持久化 + 恢复（一次一个 PR）              │
│   ├─ ConflictTasks      冲突任务去重/创建/关联                               │
│   ├─ VcsJobWorker       outbox：commit/push/PR/refresh（异步重试）           │
│   └─ GitEvents          事件目录/幂等键/脱敏                                │
│  Kernel（t68/t69）：调度/Run/租约/恢复；通过 hooks 与 GitService 协作        │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │
                         SQLite（Git 自有表，§11.2）
```

**硬边界**：
- renderer 永远不接触文件系统/Git/token（与现有 IPC 一致）。
- Agent 的 `ToolContext.worktreePath` 指向 runtime worktree；P0 不提供 Git 写工具（D12）。
- 所有 Git 状态由 GitService 独占写入；Task 状态仍由 kernel 独占（§7.3）。
- 同一 time 只有一个 Git 写操作（每仓库一把进程内 `RepoLock`，跨进程用租约字段/stale 检测）。

### 3.2 数据流（Run 开始到合并）

```text
用户运行任务 / 调度器 startTask
  → Kernel: task queued → 选中执行者 → Run 创建
  → GitAdmission.tryAcquire(workspaceId, taskId, runId)
       ├─ 无槽位 → defer（retryAfterMs=15s；任务保持 queued，scheduler.deferred）
       └─ 有槽位 → prepareRun：
            repo 探测（缓存）→ 建/复用 task branch → git worktree add
            → 返回 {worktreePath, branch}
  → Kernel: toolContext.worktreePath = worktreePath；Agent loop 在隔离目录执行
  → Run 结束（completed/failed/cancelled）
  → Git.outbox.enqueue(finalizeRun{runId, taskId, status})
  → VcsJobWorker（后台串行）：
       有变更 → git add（CommitGuard）→ commit → push branch
       → 成功且 autoCreatePr → PrProvider.createPr → task_vcs 更新 → event
       → push/PR 失败 → 退避重试；任务状态不被 Git 失败改写
  → 人工在任务详情/队列里「批准合并」
  → MergeQueue.enqueue → worker：checks + mergeable + 一次一个 → merge
       ├─ 成功 → pr.merged / merge.merged → task_vcs=merged → 清理分支/worktree
       └─ 冲突/检查失败 → merge.blocked + 自动创建 resolve-conflict 任务（去重）
  → 冲突解决任务 Run（checkout 同一 task branch）→ 提交/推送 → 自动重新入队
```

### 3.3 组件职责（只列关键契约）

```ts
export interface GitService {
  diagnose(workspaceId: string): Promise<RepoDiagnostics>;
  getTaskVcs(taskId: string): Promise<TaskVcs | null>;
  createPr(taskId: string, opts?: { commandId?: string }): Promise<TaskVcs>;
  retryPush(taskId: string, opts?: { commandId?: string }): Promise<TaskVcs>;
  cleanup(taskId: string, opts?: { commandId?: string }): Promise<void>;
  approveMerge(taskId: string, opts: { commandId?: string; note?: string }): Promise<TaskVcs>;
  listQueue(workspaceId: string): Promise<MergeQueueSnapshot>;
  enqueue(taskId: string, opts?: { commandId?: string }): Promise<MergeQueueItem>;
  retryQueueItem(itemId: string, opts?: { commandId?: string }): Promise<MergeQueueItem>;
  cancelQueueItem(itemId: string, opts?: { commandId?: string }): Promise<MergeQueueItem>;
  openPrUrl(taskId: string): Promise<void>; // main 内校验+shell.openExternal
}
```

> 所有命令接受 `commandId`（幂等键），返回 `GitResult<T>`（成功值或错误码，§15.4）。

---

## 4. WorktreeManager

### 4.1 仓库探测与校验

`RepoLocator.detect(workspacePath)`：

1. `realpathSync(workspacePath)`；不存在/不可读 → `GIT_REPO_NOT_FOUND`（degraded）。
2. `git -C <path> rev-parse --show-toplevel`；根目录必须等于 realpath（工作区必须是仓库根；子目录暂不支持，报 `GIT_NOT_ROOT`）。
3. `git rev-parse --verify <base>`：base 分支存在；默认 `main`，可配置。
4. `git remote -v`：无 remote → `remoteKind="none"`（Local provider）。
5. `git --version` ≥ 2.36（`git worktree` 稳定）；冲突探测 `merge-tree --write-tree` 需要 ≥ 2.38，版本不足时只用 provider `mergeable` + 集成 worktree 试探合并（§6.5），不阻塞主流程。
6. 结果按 `(workspaceId, realpath)` 缓存 30s；工作区切换/设置变更失效。

失败不抛给任务：`mode="degraded"`，写 `git.degraded{reason}`，Run 回退 §7.4。

### 4.2 命名与路径

| 对象 | 规则 | 示例 |
|------|------|------|
| task branch | `deer/<taskId>-<slug>`；taskId 保留原样（`t73`/`task_xxx`），slug 由标题小写化、仅 `[a-z0-9-]`、≤40 字符、去首尾 `-`；重复追加 `-2` | `deer/t68-event-kernel` |
| runtime worktree | `<workspace>/.deer/worktrees/<taskId>/<attempt>`（attempt 从 1 开始） | `.../.deer/worktrees/t68/2` |
| conflict worktree | `<workspace>/.deer/worktrees/<taskId>/conflict-<conflictTaskId>` | `.../t68/conflict-t99` |
| checks worktree | `<workspace>/.deer/worktrees/_checks/<prNumber>-<headSHA7>`（只读校验，完成后删除） | `.../_checks/12-a1b2c3d` |
| 本地 exclude | 向 `<gitDir>/info/exclude` 幂等追加 `.deer/`（若已有则跳过）；**不修改 .gitignore、不提交** | — |

校验（写入前）：
- `path.resolve(worktreePath)` 必须在 `path.resolve(workspacePath, ".deer")` 下（含 `realpath`，禁止 symlink 逃逸）。
- branch 名匹配 `^deer/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$`，且不包含 `..`、`~`、`^`、`:`、`?`、`*`、`[`、`\`、空格、以 `-`/`.` 开头。
- Windows：路径长度 <240，避开保留名（CON/PRN/AUX…），使用 `\\?\` 长路径前缀仅在必要时。

### 4.3 生命周期（branch 持久、worktree 按 Run）

状态机（`git_worktrees.state`）：

```text
none → reserving → creating → ready → active → finalizing → removed
             │           │                     │
             └─ failed ──┘                     └─ orphaned（崩溃/回收）
```

| 阶段 | 动作 | 失败处理 |
|------|------|----------|
| reserving | 在 `git_worktrees` 插入 reservation（lease 60s），检查容量 | 无槽 → `GIT_CAPACITY`（defer） |
| creating | 若 branch 不存在：`git worktree add -b <branch> <path> <base>`；若已存在：`git worktree add <path> <branch>`（重试/冲突修复场景） | 清理半成品目录；`GIT_WORKTREE_FAILED`，defer/重试 |
| ready | 校验 HEAD == branch、工作区干净、`git status --porcelain` 空 | 失败 → 移除重建一次 |
| active | Agent loop 使用该目录；Run 心跳同时刷新 worktree lease | lease 过期由 reconcile 回收 |
| finalizing | commit/push（§5.3）；写 `run_vcs`/`task_vcs`；事件 | 保留目录并重试 job；超时标 orphaned |
| removed | `git worktree remove --force`（已提交后）→ `git worktree prune`；删除 reservation；事件 | 失败标 orphaned，下次 reconcile 处理 |

**重试策略**：同一 Task 的 attempt N+1 **复用 branch**（checkout 已有分支），worktree 重新创建；这样 Agent 重试能看到上次提交的历史，但不会继承未提交的半成品（崩溃场景见 §4.6）。

**合并后**：若 PR 已合并，删除 branch（本地 `git branch -D`，远端由 provider 决定是否删）；task_vcs 记录 merge commit。

**取消**：`cancelTask`/`cancelRun` → abort 后 finalize 策略见 §7.5（默认不 push 未完成改动，保留本地 commit 供人工查看，worktree 移除）。

### 4.4 并发上限与内核协作

| 资源 | 上限 | 说明 |
|------|------|------|
| Runtime worktree（每工作区） | **3**（默认；可配置 1–3；硬上限 3） | 本设计；超过 → admission defer |
| Runtime worktree（全局，跨工作区） | 不单独设限；受内核 global 并发 4 限制 + 磁盘保护（>10 告警） | 多个工作区各有 3 槽 |
| Dev worktree（AGENTS §8） | 3（`branches/`） | 与本系统**互不计数**；仅用于开发本产品 |
| Kernel 并发默认 | global 4 / workspace 2 / member 1 | `execution-kernel-design.md:508,1079` |

**生效并发**：每个工作区 `min(kernel.workspaceConcurrency=2, git.maxWorktrees=3, 成员=1)` = 2（默认）；全局 `min(4, 2×工作区数)`。因此默认不会打满 3 槽；3 槽是硬护栏，防配置/重试泄漏。

**与 t68 的契约（必须由内核实现，G3 验收）**：

1. **准入**：内核 `beforeStart` 调用 `GitAdmission.tryAcquire`；返回 `{allow:false, defer:true, retryAfterMs, reason:"GIT_CAPACITY"}` 时，任务回到 `queued`（`nextRunAt=now+retryAfterMs`），写 `scheduler.deferred`，**不得**写 `failed`。
2. **执行目录**：Run 启动前调用 `GitService.prepareRun({taskId,runId,attempt})` 得到 `{worktreePath, branch, mode}`；内核把它传给执行器与 `ToolContext.worktreePath`；`RunV2.sandboxId = "git:"+worktreePath`（degraded 时 `workspace:<id>`）。
3. **结束钩子**：`onRunFinished` 只做 `GitJob.enqueue(finalizeRun)`（DB 插入，<5ms），不等待 Git；保证内核终态及时。
4. **失败隔离**：Git 的 commit/push/PR 失败**不得**改变 Run/Task 终态，只更新 `task_vcs.error` 并重试。
5. **租约**：worktree reservation 带 `lease_owner/lease_expires_at`；内核恢复扫描时调用 `GitService.reconcile()` 回收 orphaned。

**若 t68 未按上述实现**（兼容回退，仅 G3 期间）：
- `service.runTask` 在创建 Run 前调 `GitService.prepareRun`（无槽则抛 `GIT_CAPACITY`，UI toast「等待工作树槽位」）；loop 用返回目录；`finally` 里 enqueue finalize。
- 该回退不能延迟排队，只能提示用户重试；因此 t68 合入后优先切换到正式 hooks。

### 4.5 清理与恢复

- **启动 reconcile**（`GitService.reconcile()`，应用启动 + 每 120s）：
  1. `git worktree list --porcelain` 与 `git_worktrees` 对账；
  2. 记录有目录无记录 → `git.worktree_orphaned`，尝试 finalize（见下）后移除；
  3. 记录有 reservation 无目录 → 释放；
  4. 目录存在但对应 Task/Run 已终态且超过 TTL（默认 24h，可配置）→ 强制 finalize/移除；
  5. 清理 `_checks` 中超过 1h 的目录。
- **崩溃 salvage**：Run 非终态但进程重启 → 内核 recovery 标 `LEASE_EXPIRED`；Git reconcile 对该 worktree 执行：
  1. `git status` 有改动 → `CommitGuard` 扫描后 `git add -A` + commit（message 标注 `wip(recovery)`）；
  2. push branch（若 autoPush 且 remote 可用），不创建 PR；
  3. 写 `git.worktree_recovered`；移除 worktree。
  4. Git 操作失败 → 保留目录 + `git.worktree_orphaned`，UI 可手动清理。
- **手动清理**：任务详情「清理工作树」/设置「诊断」提供；同一 Task 正在运行则拒绝。
- **不删除**：已推送的远端 branch（合并后可选删）、用户自己的 dev worktree、`branches/` 下任何内容。

### 4.6 与 AGENTS §8 dev worktree 的关系（必须写进文档/UI）

- 两套 worktree 用不同路径与分支前缀：dev `branches/<task>/` + `feature/*`；runtime `<workspace>/.deer/worktrees/` + `deer/*`。
- dev 流程的 `branch:start` 会先 fetch `origin/main` 并从最新 main 起步；提 PR 前执行 `branch:sync`（`branch:finish` 会拒绝尚未包含最新 main 的分支），冲突必须在 worktree 内解决后再提交；一个功能一个 PR、按 `.github/pull_request_template.md` 填写。runtime Git 系统不改变这些规则。
- `git worktree list` 会同时显示两者；`branch-worktree.mjs` 的 3 个上限只统计 `branches/` 下路径（脚本 `activeWorktrees()` 按前缀过滤），因此 runtime worktree 不会阻塞开发流程。
- 当 DeerSuperGroup 自身作为用户工作区（dogfood）时，`.deer/` 已被本仓 gitignore，且 local exclude 保证不污染；runtime 分支 `deer/*` 不会与 `feature/*` 冲突。
- 若用户仓库已有 `.deer` 目录用于别的用途：检测到非本系统标记（`.deer/worktrees/.deer-git.json` 版本文件缺失）→ 改用 `.deer-git/worktrees` 并提示；不覆盖用户目录。

---

## 5. Git 操作层

### 5.1 GitExec（唯一执行入口）

```ts
export interface GitResult<T> {
  ok: boolean;
  value?: T;
  errorCode?: GitErrorCode;
  message?: string;
  retryable?: boolean;
}

export interface GitExec {
  run(args: string[], opts?: {
    cwd?: string; timeoutMs?: number; maxBuffer?: number;
    env?: Record<string, string>; input?: string;
  }): Promise<GitOutput>; // {stdout, stderr, code}
}
```

规则：
- `execFile("git", args, {cwd, env, timeout, maxBuffer, windowsHide:true})`；**从不** `shell:true`，不把用户输入拼进字符串。
- 默认 `timeoutMs=30_000`（网络 push/fetch 120_000；merge 60_000）；`maxBuffer=4MB`；超时 kill 并返回 `GIT_TIMEOUT`（retryable）。
- env 白名单：`PATH/PATH/HOME/USERPROFILE/SystemRoot/ComSpec/TEMP/TMP/LANG/LC_ALL` + `GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`（读操作）、`GIT_SSH_COMMAND` 不覆盖；**不注入 token**（auth 由 gh/ssh/credential helper 处理）。
- 输出脱敏：`redactSecrets()` 作用于 stdout/stderr/错误消息（§8.1），再入事件/日志/UI。
- 每仓库 `RepoLock`：写操作串行；读操作可并行（但同一 worktree 的 add/remove 与 commit 也串行）。
- 所有命令先过 `validateGitArgs(args)` 白名单（§5.2），拒绝未知子命令/危险参数。

### 5.2 命令白名单（P0）

| 用途 | 允许的 argv 形状 | 备注 |
|------|------------------|------|
| 探测 | `rev-parse --show-toplevel|--verify|--abbrev-ref|--git-dir|--is-inside-work-tree`、`remote -v|get-url`、`--version` | 只读 |
| 状态 | `status --porcelain[=v1|v2]`、`diff [--cached|--name-only|--stat|--unified=N]`、`log -n N --format=...`、`show` | 只读 |
| worktree | `worktree add [-b <branch>] <path> <ref>`、`worktree list --porcelain`、`worktree remove [--force] <path>`、`worktree prune` | 路径/ref 校验 |
| branch | `branch --list <pattern>`、`branch -D <branch>`（仅 deer/*）、`checkout -b`（在 worktree add 内） | 禁止 `branch -f` 改 main |
| 提交 | `add -A`（受 CommitGuard）、`commit -m <msg> [--no-verify]`、`rev-parse HEAD` | message 由模板生成，控制字符清理 |
| 同步 | `fetch [origin <branch>]`、`push [-u] <remote> <branch>:<branch>`（branch 只能 deer/*）、`merge-base --is-ancestor` | push 前再校验目标 ≠ base |
| 合并 | `merge --ff-only <ref>`（仅本地/集成 worktree 校验）、`merge-tree --write-tree <base> <branch>`（冲突探测） | 不直接在用户主 checkout 执行 merge |
| 配置 | `config --get <key>`（读） | 不写 config；不 `config --global` |

**禁止**：`push origin main`/`push --force`/`push --all`/`push --mirror`、`reset --hard`、`clean -fdx`、`tag`、`submodule`、`filter-branch`、`rebase -i`、`cherry-pick`（P0）、任意 `-c`/`--exec`/`!` 参数。

### 5.3 分支与提交

- 创建：Run 开始前；branch 已存在则复用（重试/冲突修复）；不存在则从 base 创建（`worktree add -b`）。
- 提交：Run 结束（finalize job）：
  1. `git status --porcelain`；无改动 → 不 commit（事件 `git.no_changes`）。
  2. `CommitGuard.scan()`（§8.4）通过 → `git add -A` → `git commit -m "<type>(<task>): <title> [attempt N]"`。
  3. 记录 `commit_sha` 到 `run_vcs`/`task_vcs`，事件 `git.commit`。
  4. 保留 `git log -1 --format=%H` 作为 PR head。
- 提交身份：优先 repo 现有 `user.name/email`；缺失时设置 **仅本次命令** 的 `GIT_AUTHOR_NAME/EMAIL`/`GIT_COMMITTER_NAME/EMAIL`（`DeerSuperGroup Agent` / `agent@deer.local`），不写全局 config。
- 推送：`git push -u <remote> <branch>:<branch>`；目标必须是 `deer/*`；remote 名称从 repo 配置（默认 origin）；失败分类：网络（retryable）、认证（`GIT_PUSH_AUTH`，不重试）、非快进（`GIT_PUSH_REJECTED`，提示先同步 base 或冲突任务）。

### 5.4 PR Provider 抽象

```ts
export type PrState = "draft"|"open"|"closed"|"merged"|"unknown";
export interface PrInfo {
  provider: "github"|"manual"|"local";
  number: number | null;           // local/manual 可能为 null
  url: string | null;              // 只允许 https://<配置 host>/
  state: PrState;
  draft: boolean;
  headSha: string;
  baseBranch: string;
  mergeable: "mergeable"|"conflicting"|"unknown";
  checks: Array<{ name: string; status: "queued"|"in_progress"|"passed"|"failed"|"skipped"|"neutral"; url?: string }>;
  review: "approved"|"changes_requested"|"pending"|"none";
  mergedCommitSha: string | null;
  updatedAt: string;
}

export interface PrProvider {
  readonly id: "github" | "manual" | "local";
  detect(repo: RepoInfo): Promise<ProviderAvailability>; // auth/remote/host
  createPr(input: { repo: RepoInfo; head: string; base: string; title: string; body: string; draft?: boolean }): Promise<PrInfo>;
  refresh(repo: RepoInfo, pr: PrRef): Promise<PrInfo>;
  listChecks(repo: RepoInfo, pr: PrRef): Promise<PrInfo["checks"]>;
  merge(repo: RepoInfo, pr: PrRef, opts: { method: "squash"|"merge"|"rebase"; headSha: string }): Promise<PrInfo>;
  close(repo: RepoInfo, pr: PrRef): Promise<void>;
  currentUser(repo: RepoInfo): Promise<string | null>;
}
```

#### 5.4.1 GitHub Provider（首选）

- **认证**：优先 `gh auth status` + `gh auth token`（keyring，不落盘）；其次 `GITHUB_TOKEN`/`GH_TOKEN` 环境变量。两者都无 → `GITHUB_AUTH_MISSING`，降级 Manual。
- **读**：`gh api repos/{owner}/{repo}/pulls/{n}`、`.../pulls/{n}/checks`？检查用 `gh pr view <n> --json number,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,baseRefName,mergedAt,mergeCommit`（JSON 稳定）。
- **写**：`gh pr create --base <base> --head <branch> --title <t> --body-file <临时文件>`（body 写入 `.deer/tmp/*.md` 后删除，避免 stdin/参数注入）；`gh pr merge <n> --squash`（**不加 `--delete-branch`**，删除策略由应用按配置决定）；合并后用 `gh pr view --json mergedAt,mergeCommit` 验证。
- **PR body 模板**（运行时任务 PR，参考仓库 `.github/pull_request_template.md`）：Task ID、单一功能/变更摘要、验收项对照、checks 结果、风险与回滚、UI 变更截图（涉及 UI 时）；body 写临时文件后删除；**不含 token/敏感路径/文件内容**。
- **更新分支**：`gh pr update-branch <n>`（失败视为冲突/需人工）；不直接 rebase。
- **checks 映射**：`statusCheckRollup` 的 `conclusion`/`state` → passed/failed/pending；无 checks 时队列要求本地 checks 或人工确认（§6.6）。
- **限流**：403/429 读 `retry-after`；退避 1m/5m/15m，超过 3 次 → `PR_RATE_LIMITED`（队列等待，不失败）。
- **token 安全**：只在内存；`gh` 子进程不打印 token；错误消息脱敏；不写 renderer。

#### 5.4.2 Manual Provider（有 remote、无 gh auth）

- push 照常；PR 创建只生成 compare URL：`https://<host>/<owner>/<repo>/compare/<base>...<branch>?expand=1`。
- `pr_state="manual_pending"`；UI 显示「在浏览器创建 PR」+「标记为已合并（输入 merge commit SHA）」。
- 队列在该状态下等待人工操作；用户标记后校验：
  - `git fetch <remote> <base>`；
  - `git merge-base --is-ancestor <headSha> <remote>/<base>` 为真 → 认为 merged（记录 SHA）；否则拒绝。
- 不发网络 API（只 git fetch），无 token。

#### 5.4.3 Local Provider（无 remote）

- 只创建/保留本地分支；`pr_state="local"`。
- 「合并」= 人工在本地把分支合入 base；应用只能在**独立集成 worktree** 做 `merge-tree` 冲突预检，不能替用户改主 checkout。
- 校验合并：`git merge-base --is-ancestor <headSha> <localBase>`；用户点击「确认已本地合并」后执行该校验；通过 → merged，清理。
- 合并队列在 local 模式下为「待人工合并」列表，不自动 merge；冲突 → 生成冲突任务（在 task branch 上解决）。

#### 5.4.4 Provider 自动选择

```text
remote 存在?
 ├─ 否 → local
 └─ 是 → gh auth 可用? 
          ├─ 是 → github
          └─ 否 → manual（可配置强制 local）
```
配置 `git.provider = auto|github|manual|local`；`auto` 按上述；显式配置不可用时回退并在诊断/UI 标注原因。

### 5.5 分支保护与 main

- **应用级硬规则（所有 provider）**：
  1. 永不 `git push <remote> <base>`（含 `HEAD:main`、`main:main`）；
  2. 永不 `--force`/`--force-with-lease`；
  3. merge 只通过 provider API / 本地人工确认，不直接改 base ref；
  4. push 目标 branch 必须是 `deer/*`。
- **GitHub 分支保护探测**：读 `GET repos/{owner}/{repo}/branches/{base}/protection`（404 = 未保护）：
  - 未保护 → 诊断 warning（`GITHUB_BASE_UNPROTECTED`），UI 提示「建议在 GitHub 开启 main 保护」；不阻塞。
  - 已保护 → 记录 required checks/reviews 到 `repo_config`，队列按其校验。
- **本地 pre-push guard（可选，默认关闭）**：用户开启后写入 `.git/hooks/pre-push`（带标记、可卸载），拒绝向 base 推送；不改 `.gitconfig`。此项仅作为纵深防御，不能阻止 `full_access` shell 手动 push（文档明示）。
- **本地 main 更新**：合并后不自动 `git checkout main && pull`（用户可能正在工作）；UI 显示「本地 main 落后 N 个提交，请手动 pull」，提供复制命令。

### 5.6 仓库配置（每工作区）

新表 `git_repo_config`（1:1 workspace）：

| 字段 | 默认 | 说明 |
|------|------|------|
| `mode` | `auto` | `off|auto|github|manual|local`；`off` 时保持现状（无隔离） |
| `base_branch` | 自动探测 `main`/`master` | 必须存在 |
| `remote` | `origin` | 无 remote 时为空 |
| `provider` | `auto` | 见 §5.4.4 |
| `api_host` | `github.com` | 企业版可配（https） |
| `auto_create_pr` | `true` | Run 成功 push 后自动建 PR |
| `auto_push_wip` | `true` | 失败/取消时是否推送 WIP 分支（不建 PR） |
| `require_approval` | `true` | 合并前必须人工批准 |
| `checks_command` | 自动探测 | 本地 checks 命令（如 `pnpm typecheck && pnpm build && pnpm test`）；仅用户可配置 |
| `required_checks` | provider 自动 | 允许的 check 名称列表（空=全部 required） |
| `merge_method` | `squash` | `squash|merge|rebase`（GitHub 支持度不同） |
| `auto_merge` | `true` | 批准后是否自动入队/执行（false=手动点合并） |
| `max_worktrees` | `3` | 1–3，硬上限 3 |
| `merge_captain` | `human` | 冲突任务负责人（human 或 agentId） |

设置页 Git 区只暴露上述安全字段；**不提供 token 输入框**（token 只来自 gh/env）。

---

## 6. 合并队列

### 6.1 数据模型

```sql
-- Git 自有表（独立于 kernel v2；§11.2）
CREATE TABLE IF NOT EXISTS git_repo_config (
  workspace_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'auto',
  base_branch TEXT NOT NULL DEFAULT 'main',
  remote TEXT,
  provider TEXT NOT NULL DEFAULT 'auto',
  api_host TEXT NOT NULL DEFAULT 'github.com',
  auto_create_pr INTEGER NOT NULL DEFAULT 1,
  auto_push_wip INTEGER NOT NULL DEFAULT 1,
  require_approval INTEGER NOT NULL DEFAULT 1,
  checks_command TEXT,
  required_checks TEXT NOT NULL DEFAULT '[]',
  merge_method TEXT NOT NULL DEFAULT 'squash',
  auto_merge INTEGER NOT NULL DEFAULT 1,
  max_worktrees INTEGER NOT NULL DEFAULT 3,
  merge_captain TEXT NOT NULL DEFAULT 'human',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS git_worktrees (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,          -- 拥有该 worktree 的任务（冲突任务时为冲突任务 id）
  branch_task_id TEXT,            -- 实际 branch 所属任务（冲突解决时=源任务 id；普通=task_id）
  run_id TEXT,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  state TEXT NOT NULL,           -- reserving/creating/ready/active/finalizing/removed/orphaned
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_git_wt_active ON git_worktrees(task_id)
  WHERE state IN ('reserving','creating','ready','active','finalizing');
-- 同一 branch 同时只允许一个活跃 worktree（冲突任务与源任务互斥，防同分支并发写）
CREATE UNIQUE INDEX IF NOT EXISTS ux_git_wt_branch_active ON git_worktrees(workspace_id, branch)
  WHERE state IN ('reserving','creating','ready','active','finalizing');

CREATE TABLE IF NOT EXISTS task_vcs (
  task_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mode TEXT NOT NULL,             -- git/degraded/local
  branch TEXT,
  base_branch TEXT,
  head_sha TEXT,
  pr_provider TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  pr_state TEXT,                  -- none/draft/open/closed/merged/manual_pending/local
  checks_state TEXT,              -- none/pending/passed/failed
  review_state TEXT,              -- none/pending/approved/changes_requested
  merge_state TEXT,               -- none/queued/waiting/merging/merged/blocked/failed
  merge_commit_sha TEXT,
  conflict_task_id TEXT,
  target_task_id TEXT,            -- 冲突任务：被解决的源任务 id
  target_branch TEXT,             -- 冲突任务：源任务 branch
  scope_paths TEXT NOT NULL DEFAULT '[]', -- §7.7 软所有权：任务声明的预期修改范围
  error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_vcs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  worktree_path TEXT,
  branch TEXT,
  base_sha TEXT,
  commit_sha TEXT,
  pr_number INTEGER,
  mode TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pr_records (
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT,
  task_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  state TEXT NOT NULL,
  checks_json TEXT NOT NULL DEFAULT '[]',
  review_state TEXT,
  mergeable TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(provider, workspace_id, number)
);

CREATE TABLE IF NOT EXISTS merge_queue (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  pr_provider TEXT NOT NULL DEFAULT 'local',
  pr_number INTEGER,
  task_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT,
  state TEXT NOT NULL,            -- queued/waiting_checks/waiting_review/ready/updating/merging/merged/blocked/failed/cancelled
  position INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  approval_actor TEXT,
  approved_at TEXT,
  merge_commit_sha TEXT,
  conflict_task_id TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_merge_active ON merge_queue(workspace_id, pr_provider, pr_number)
  WHERE state IN ('queued','waiting_checks','waiting_review','ready','updating','merging');
-- local/manual 的 pr_number 可能为 NULL（SQLite 唯一索引不约束 NULL），用 task_id 兜底去重
CREATE UNIQUE INDEX IF NOT EXISTS ux_merge_active_task ON merge_queue(workspace_id, task_id)
  WHERE state IN ('queued','waiting_checks','waiting_review','ready','updating','merging');

CREATE TABLE IF NOT EXISTS merge_attempts (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL,
  pr_provider TEXT NOT NULL,
  pr_number INTEGER,
  head_sha TEXT NOT NULL,
  base_sha TEXT,
  state TEXT NOT NULL,            -- started/merged/blocked/failed/stale
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  source TEXT NOT NULL,           -- github/local
  head_sha TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,            -- queued/running/passed/failed/skipped
  detail TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS git_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- finalize_run/refresh_pr/update_branch/cleanup
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL,            -- pending/leased/done/failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_git_jobs_pending ON git_jobs(state, next_at);

CREATE TABLE IF NOT EXISTS git_schema (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

> 说明：Git 表全部 `CREATE TABLE IF NOT EXISTS` + `git_schema` 独立版本，不触碰 `PRAGMA user_version`（kernel v2 使用），避免迁移冲突。

### 6.2 队列 FSM

```text
(提交批准/自动入队)
   → queued
   → waiting_checks   （checks 未通过/未跑）
   → waiting_review   （require_approval 且未批准）
   → ready            （checks passed + approved + mergeable）
   → updating         （base 前进，update-branch）
   → merging          （provider merge API）
   → merged
        │
        ├─ 冲突/不可合并 → blocked + conflict task（去重）
        ├─ checks 失败   → failed（可重试）
        └─ 取消/关闭 PR  → cancelled
```

| 迁移 | 触发 | 动作/事件 |
|------|------|-----------|
| queued → waiting_checks | worker 取到 | 刷新 PR，读取 checks；`merge.checks_pending` |
| waiting_checks → waiting_review | checks 全 passed | 若 require_approval 且无批准 → 等待 |
| waiting_checks → failed | checks failed | `merge.checks_failed`；记录 check_runs；可重试 |
| waiting_review → ready | 用户批准（`approveMerge`） | 写 `merge.approved`（actor=user），`approved_at` |
| ready → updating | base 前进/需同步 | `gh pr update-branch` 或提示手动；冲突 → blocked |
| ready/updating → merging | mergeable + head 未变 | `merge.started`；lease |
| merging → merged | provider 返回 merged / discover merged | `merge.merged`；写 merge_commit_sha；task_vcs.merge_state=merged；清理 |
| merging → blocked | mergeable=conflicting / update 冲突 | `merge.blocked`；创建冲突任务 |
| merging → failed | 网络/限流/未知 | 退避重试（≤3）；仍失败 → failed，UI 可重试 |
| any → cancelled | 用户取消/PR closed/task cancelled | `merge.cancelled`；不删已合并状态 |

**硬约束**：
- 同一仓库同一时刻只有一个 `merging`（`RepoLock` + 队列 worker 单飞）。
- 一个 PR 同时最多一个活跃队列项（唯一索引）。
- 幂等键：`merge:{provider}:{workspace}:{pr}:{headSHA}`；合并前重新 `refresh()`，headSHA 变化 → 回 `waiting_checks`（防止合并未审查的提交）。
- 已合并检测：`pr.refresh()` 若 `state=merged` → 直接收敛，不重复 merge。
- 合并后：`task_vcs.merge_state=merged`，`task_vcs.head_sha=merge_commit_sha`，事件；不直接改 Task 状态（§7.3）。

### 6.3 入队与顺序

- 触发：用户在任务详情点「批准合并」→ 若 `auto_merge=true` 自动入队；否则入队但状态 `waiting_approval`（`require_approval=false` 时可直接 ready）。
- 资格：`task_vcs.pr_state=open`、branch `deer/*`、base=配置 base、非 draft（或允许 draft 由配置）、无已有活跃队列项。
- 排序：`position` 递增（FIFO）；同 Task 重试不重复占位；手动「插队」P0 不做。
- 一次一个：worker `tick()` 取 `state IN ('ready','waiting_checks','waiting_review','updating')` 中 position 最小且可推进的项；若队首阻塞（等人工），后面的项**不跳过**（保持顺序，避免饥饿/乱序合并）——可配置 `allow_skip_blocked=false` 默认。
- 重新入队：冲突任务完成/PR 更新/用户重试 → 保留原记录，`state=queued`，position 末尾（或原位置？P0 末尾，保证公平）。

### 6.4 合并流程（GitHub）

1. `refreshPr`：获取 state/mergeable/mergeStateStatus/headSHA/checks/review。
2. head 与队列记录不一致 → 更新 headSHA，重置 checks/review 状态（防止旧批准）。
3. 若 `mergeStateStatus=BEHIND` → `gh pr update-branch`（或提示手动）；更新后重新检查；冲突 → blocked。
4. checks：provider required checks 全 passed；本地 `checks_command`（若配置）在 `_checks` worktree 运行并通过（§6.6）。
5. review：`require_approval` → 应用内批准记录（P0）；若 provider reviewDecision=changes_requested → blocked。
6. merge：`merge_method` 调 provider；`headSha` 传参校验（GitHub API `sha` 参数）；成功后 refresh 验证 `mergedAt/mergeCommit`。
7. 收敛：`merge.merged`，写 merge_attempt，`task_vcs`，清理队列；可选删远端分支（配置，默认 false，GitHub 合并时可自动删）。
8. 失败：分类重试（网络/限流）；未知状态 → `blocked`（人工核对），绝不猜测成功。

### 6.5 冲突任务（resolve-conflict）

- **检测**：
  - provider `mergeable=conflicting` / `mergeStateStatus=DIRTY`；
  - `update-branch` 失败且 reason=conflict；
  - local/manual：`git merge-tree --write-tree <base> <head>` 返回非零/冲突标记。
- **创建（幂等）**：
  - 去重键 `(workspaceId, pr_provider, pr_number, base_sha)`；若已有未完成冲突任务 → 复用，不新建。
  - 任务字段：`title="解决合并冲突：<源任务标题>"`，`description` 含 PR 链接、branch、base、冲突文件列表（`git diff --name-only --diff-filter=U` 或 provider 返回）、解决命令提示；`acceptance=["冲突标记已清除","checks 通过","分支已推送"]`；`owner = merge_captain`（human → ownerId=null + UI 提示人工；agent → ownerId）；状态 `ready`；**不依赖源任务**（源任务已 done）。
  - 在 `task_vcs`（冲突任务）记录 `target_task_id=源任务`、`target_branch=源任务 branch`；`merge_queue.conflict_task_id` 回填。
  - 事件 `merge.conflict_task_created`；toast + 任务列表徽标「冲突」。
- **解决执行**：冲突任务的 Run 使用源任务的 branch（`WorktreeManager` 特例：checkout `deer/<sourceTaskId>`，worktree 路径 `.../<sourceTaskId>/conflict-<conflictTaskId>`），Agent 解决冲突、提交、推送；Run 结束 finalize 后自动 `merge_queue.retry`。
- **人工路径**：用户可忽略任务，直接在本地解决并推送；应用检测到 branch 更新（`pr.refresh` head 变化）→ 重新入队；冲突任务可手动取消。
- **上限**：同一 PR 最多 2 个并发冲突任务（避免刷任务）；超过 → 队列 `blocked` 等人工。

### 6.6 Checks

| 来源 | 读取 | 必需条件 |
|------|------|----------|
| GitHub | `statusCheckRollup`（check runs + commit statuses） | 配置 `required_checks`（空=全部）；`success`/`neutral` 通过，`failure`/`cancelled`/`timed_out` 失败；`pending` 等待 |
| 本地命令 | 用户配置 `checks_command`（如 `pnpm typecheck && pnpm build && pnpm test`） | 在 `_checks` worktree（checkout headSHA）执行；超时 30min；输出截断 64KB；env 白名单；结果写 `check_runs` |
| 人工 | 无 checks 来源 | 必须显式勾选「无 CI，确认人工审查」→ 事件 `merge.checks_waived{actor}`；默认不允许静默跳过 |

> `checks_command` 是用户配置的可信命令（等同用户在终端执行），不由 Agent/仓库文件注入；P0 不做沙箱。

### 6.7 幂等、重试、恢复

- 每个队列项的命令都带 `commandId`；同一 `commandId` 重复调用返回既有结果。
- merge 尝试键：`(queue_id, head_sha, base_sha)`；同一组合只发一次 merge API（进程内 + 持久化 attempt）。
- 重试：网络/限流/未知 → 指数退避（30s/2m/10m，≤3 次）；checks 失败 → 等用户修复/重新 push（不自动重跑无限次）。
- 重启恢复：启动时扫描 `state='merging'` 且 lease 过期 → `refreshPr`：
  - merged → 收敛为 merged；
  - open + mergeable → 回 `ready`（重新校验 head）；
  - open + conflicting → blocked + 冲突任务；
  - closed → cancelled；
  - 未知/网络失败 → `blocked`（`MERGE_UNKNOWN_STATE`），UI 人工核对，**不自动重试 merge**。
- 不重复合并：provider 已 merged 即收敛；本地用 `merge-base --is-ancestor` 校验。
- 队列 worker 单飞（`mergeTickRunning` 标志），tick 不重入；事件唤醒合并到下一 tick。

---

## 7. 任务 / 事件联动

### 7.1 数据字段（Git 自有表 + 现有缓存）

- `task.branch` / `task.worktree`：保留为**投影缓存**（UI/兼容），由 GitService 在 prepare/finalize 时更新；不再写假值（`git.mode=off` 时置 null）。
- 新 `task_vcs`（§6.1）：完整 VCS 状态；`run_vcs` 记录每个 Run 的 worktree/branch/base/commit。
- 新 `TaskVcs` 类型（shared/types）供 UI；不改变 `Task` 接口必填字段（兼容旧快照）。

```ts
export interface TaskVcs {
  taskId: string;
  mode: "git"|"degraded"|"local"|"off";
  branch: string | null;
  baseBranch: string | null;
  headSha: string | null;
  pr: null | { provider: string; number: number|null; url: string|null; state: string; checks: string; review: string };
  merge: { state: string; commitSha: string|null };
  conflictTaskId: string | null;
  targetTaskId?: string | null;   // 冲突任务：源任务
  targetBranch?: string | null;   // 冲突任务：源分支
  scopePaths?: string[];          // §7.7 软所有权（声明范围）
  errorCode: string | null;
  degradedReason: string | null;
  updatedAt: string;
}
```

### 7.2 事件目录（Git 注册到内核事件表）

| type | aggregate | payload（脱敏后） | 幂等键 |
|------|-----------|-------------------|--------|
| `git.repo_detected` | workspace | `{root, remote, baseBranch, provider}` | `git:repo:{ws}:{rootHash}` |
| `git.degraded` | workspace/task | `{reason, workspacePath}` | `git:degraded:{task}:{run}` |
| `git.worktree_created` | task | `{taskId, runId, path, branch}` | `git:wt:{runId}` |
| `git.worktree_removed` | task | `{taskId, runId, path, reason}` | `git:wt-rm:{runId}` |
| `git.worktree_orphaned` | task | `{taskId, path, reason}` | `git:wt-orphan:{path}:{mtime}` |
| `git.branch_created` | task | `{branch, base, baseSha}` | `git:branch:{task}:{attempt}` |
| `git.commit` | task/run | `{runId, branch, sha, files, insertions, deletions}` | `git:commit:{runId}` |
| `git.no_changes` | task/run | `{runId}` | `git:none:{runId}` |
| `git.scope_mismatch` | task/run | `{runId, files, scopePaths}` | `git:scope:{runId}` |
| `git.pushed` | task/run | `{runId, branch, remote, sha}` | `git:push:{runId}` |
| `git.push_failed` | task/run | `{runId, branch, errorCode, retryable}` | `git:push-fail:{runId}:{attempt}` |
| `pr.created` | task | `{provider, number, url, headSha, base}` | `pr:create:{task}:{headSha}` |
| `pr.updated` | task | `{number, state, headSha, mergeable, checks, review}` | `pr:update:{number}:{headSha}` |
| `pr.closed` | task | `{number, reason}` | `pr:close:{number}` |
| `pr.merged` | task | `{number, mergeCommitSha, headSha}` | `pr:merged:{number}` |
| `merge.enqueued` | task | `{queueId, position, taskId, pr}` | `merge:enqueue:{queueId}` |
| `merge.approved` | task | `{queueId, actor, note}` | `merge:approve:{queueId}:{headSha}` |
| `merge.checks_pending/failed` | task | `{queueId, checks}` | `merge:checks:{queueId}:{headSha}:{state}` |
| `merge.started` | task | `{queueId, attempt, headSha, baseSha}` | `merge:start:{queueId}:{attempt}` |
| `merge.merged` | task | `{queueId, mergeCommitSha}` | `merge:merged:{queueId}` |
| `merge.blocked` | task | `{queueId, reason, conflictTaskId?}` | `merge:blocked:{queueId}:{baseSha}` |
| `merge.failed` | task | `{queueId, errorCode, attempts}` | `merge:fail:{queueId}:{attempts}` |
| `merge.cancelled` | task | `{queueId, reason}` | `merge:cancel:{queueId}` |
| `merge.conflict_task_created` | task/workspace | `{queueId, conflictTaskId, sourceTaskId, pr}` | `merge:conflict:{pr}:{baseSha}` |
| `git.reconciled` | workspace | `{worktrees, queue, repaired}` | `git:reconcile:{bootId}` |

- **事件写入**：t68 合并前用 `store.appendEvent`（幂等键存 Git 表，重复 job 先查）；t68 后走 `eventStore.append({type, payload, idempotencyKey, correlationId})`，Git 注册 schema 到 eventRegistry（§12 文件）。
- **禁止**：token、完整 remote URL（含凭据）、文件内容、diff 全文入事件；只存计数/路径（workspace 相对）/SHA。

### 7.3 运行集成（与 t68/t69 的契约）

```ts
// 内核侧新增/确认的接口（G3 验收，写进 t68 实施）
export interface RunEnvironmentProvider {
  prepare(input: {
    workspaceId: string; taskId: string; runId: string; attempt: number;
  }): Promise<
    | { ok: true; cwd: string; branch: string | null; sandboxId: string; mode: "git"|"degraded" }
    | { ok: false; defer: true; retryAfterMs: number; reason: string }
    | { ok: false; defer: false; errorCode: string; message: string }
  >;
  release(input: { runId: string; status: "completed"|"failed"|"cancelled" }): Promise<void>;
}
```

- 内核在 Run 创建前调用 `prepare`；成功后 `toolContext.worktreePath = cwd`；`release` 只入队 finalize（不阻塞）。
- 如果内核不提供该接口：G3 在 `service.runTask` 外层用兼容包装（§4.4），但要求内核至少提供 `onRunFinished` 钩子（t68 已有设计）或 service 的 `finally`。
- **Task 状态不被 Git 改写**：Run completed → kernel 按 `reviewPolicy` 进入 done/review；PR 合并只是 `task_vcs.merge_state=merged`，UI 显示「已交付 · 已合并」。若 kernel `reviewPolicy=required`，行级评审后续可把「PR merge」作为 review approve 的触发之一（接口预留，不在 P0）。
- **合并批准 ≠ kernel review**：P0 使用独立的人工合并批准（`merge.approved`），避免与未实现的 review UI 耦合；文档/UI 明示。

### 7.4 Workspace 回退契约（degraded）

```ts
function resolveRunWorkspace(input: {
  workspace: Workspace; repo: RepoInfo | null;
}): { mode: "git"|"degraded"; worktreePath: string; branch: string | null; reason?: string } {
  if (!repo || !repo.ok) {
    return { mode: "degraded", worktreePath: input.workspace.path, branch: null, reason: repo?.reason ?? "no-git" };
  }
  return { mode: "git", worktreePath: /* worktree */, branch: /* branch */ };
}
```

- 触发 degraded：非 Git 仓库、工作区不是仓库根、git 缺失/版本低、权限拒绝、worktree 创建连续失败。
- degraded 行为：Run 直接在 `workspace.path` 执行（与今天一致）；`task.branch/worktree=NULL`；事件 `git.degraded`；任务详情显示「未隔离：非 Git 工作区」+「如何启用」帮助；不创建 PR/队列。
- 恢复：用户修复仓库/权限后，下一次 Run 自动重新探测并进入 git 模式；不补做旧 Run 的分支。
- **任务永不因 Git 不可用失败**（除非用户显式要求隔离模式 `requireIsolation=true`，P1）。

### 7.5 取消 / 失败 / 重试

| 场景 | 分支/worktree | PR/队列 | 任务 |
|------|---------------|---------|------|
| Run completed | commit（有改动）+ push；worktree remove | auto_create_pr → PR open | kernel done（或 review） |
| Run failed | 有改动且 auto_push_wip → commit `wip` + push（不建 PR）；否则丢弃未提交改动并 remove | 无 | kernel failed；可 retry |
| Run cancelled | 默认不 commit/push（配置 `push_on_cancel=false`），remove；保留 branch 供手动查看 | 若已有 PR → 保持 open，队列取消/暂停 | cancelled |
| 手动 retry | 复用 branch + 新 worktree（attempt+1）；上次 WIP 已 push 则基于 branch 继续 | PR 若存在则更新 head（checks 重新跑） | kernel queued |
| 删除任务 | 清理 worktree + 本地 branch；PR 关闭（配置 close_pr_on_delete=true，默认 true） | 队列项 cancelled | — |

### 7.6 启动恢复与一致性

- `GitService.reconcile()`（启动 + 60s 定时）：
  1. worktree 对账（§4.5）；
  2. `git_jobs` 恢复 pending/leased 过期 → 重新入队；
  3. `merge_queue` 修复（§6.7）；
  4. `task_vcs` 与 provider 对账（仅对 open PR，批量限 5 个/次，避免限流）；
  5. 事件 `git.reconciled`。
- 不变量：
  - 每 Task 最多 1 个活跃 worktree；
  - 每 PR 最多 1 个活跃队列项；
  - `merge_state=merged` ⇒ `merge_commit_sha` 非空且 provider/ancestor 校验通过；
  - `mode=git` 的 Run ⇒ `run_vcs.worktree_path` 非空；
  - 任何事件 payload 无 secret（§8）。

### 7.7 软所有权（DESIGN §7.1「文件级软所有权」）

- **声明**：任务创建/编辑可填 `scopePaths`（glob 列表，如 `src/shell/dock/**`、`docs/team/**`），存 `task_vcs.scope_paths`；P1 也可从任务描述里的 `Files:` 段落解析（只读提示，不改任务模型）。
- **使用（只提示，不硬拦）**：
  - Run finalize 后比较 changed files 与 scope；
  - 超出范围 → `git.scope_mismatch{files, scopePaths}` 事件 + 任务详情提示「本次改动超出声明范围」；
  - 合并冲突任务 description 附「本次冲突文件 / 源任务声明范围」，帮助 merge captain 判断；
  - 不因越界阻止提交/合并（DESIGN 用「提示」而非门禁）。
- **目的**：降低多任务并行时的语义冲突；范围声明后续可被 Router 规划自动生成（P2）。
- 验收：AC-WT-12（越界只提示、不拦截；事件包含文件列表）。

---

## 8. 安全

### 8.1 Token（最高优先级）

- **来源**：`gh auth token`（keyring）→ `GITHUB_TOKEN`/`GH_TOKEN` 环境变量；**不提供 UI 输入、不写 DB、不写日志、不写文件**。
- **使用**：只在主进程 GitHub Provider 的 HTTP 请求头/`gh` 子进程（gh 自己读 keyring；应用不把 token 传给 gh 参数）；REST 兜底时 token 放 `Authorization` 头，绝不进 URL。
- **脱敏**：所有进入事件/日志/错误/UI 的字符串过 `redactSecrets()`：
  - `gh[pousr]_[A-Za-z0-9]{20,}`、`github_pat_[A-Za-z0-9_]{20,}`、`Bearer\s+\S+`、`https://[^/\s]+:[^/\s]+@`、`token=[^&\s]+`。
- **测试**：构造含 token 的错误输出/URL，断言事件/返回 DTO 中不存在原文；`git remote -v` 含凭据时 UI 只显示 host/repo。
- **禁止**：token 经 IPC 到 renderer、写 `task_vcs.error`、进 commit message、进 Agent 上下文。

### 8.2 仓库与路径

- `realpath` 后必须等于 `workspace.path`（仓库根）；禁止软链逃逸。
- worktree/checkout 路径必须在 `<workspace>/.deer/worktrees` 内（realpath 校验）；拒绝 `..`、绝对路径、Windows 设备名、超过 240 字符。
- `.git/info/exclude` 追加前校验 `git rev-parse --git-path info/exclude` 路径在仓库内；只追加 `.deer/` 一行（幂等），不改用户 `.gitignore`。
- 不跟随 `.git` 文件指向的恶意 worktree（`git worktree` 自己校验；额外 `git rev-parse --git-common-dir` 校验）。

### 8.3 命令与注入

- `execFile` + argv 数组；**无 shell**；禁止 `shell:true`。
- 白名单校验（§5.2）：子命令 + 参数位置；ref/branch/path 必须匹配正则；PR 号整数；SHA `^[0-9a-f]{7,40}$`。
- 用户输入（任务标题/PR body/commit message）只作为**参数/ stdin**，不拼命令；控制字符/换行清理；commit message 截断 2000 字符。
- 超时 + 输出上限 + kill 子进程；禁止长驻交互（`GIT_TERMINAL_PROMPT=0`）。
- 网络：仅 `git fetch/push` 与 gh API；remote host 必须匹配配置 `api_host`/remote allowlist（防止把代码推到攻击者 host）；push 前 `git remote get-url` 校验。

### 8.4 敏感文件 / 提交前守卫

`CommitGuard.scan(worktreePath)`：

1. `git status --porcelain -z` 取待提交文件；`git diff --cached --name-only -z`.
2. 拒绝：
   - 路径命中 `.env*`（除 `.env.example`）、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`id_rsa*`、`id_ed25519*`、`credentials*`、`.ssh/**`、`.aws/**`、`.npmrc`（含 token 时）；
   - `node_modules/`、`.deer/`、`dist/`、`dist-electron/`、`*.db*`；
   - 单文件 >5MB 或二进制（`git diff --numstat` 为 `-`）；
   - 高置信 secret 正则（AWS key、GitHub token、私钥头、Slack token、OpenAI key 等）。
3. 命中 → **中止 commit**，`task_vcs.error_code=SECRET_BLOCKED`，事件 `git.commit_blocked{files, reason}`（不写文件内容），UI toast + 指引。
4. 不提供 `--force` 覆盖；用户必须自行处理（移出/加 ignore）后重试。
5. 提交前也检查 `branch` 不是 base、不是 `feature/*`（dev），防止误用。

### 8.5 PR / URL / 外链

- 只接受 `https://`（或配置的企业 host）PR URL；`openExternal` 在 main 校验 host 白名单，拒绝 `file:`/`javascript:`/任意 host。
- PR 标题/body 不含 token/敏感路径；body 模板只放任务标题、分支、commit 摘要。
- 合并 API 带 `headSha` 校验（GitHub `sha` 参数），防止合并未审查提交。

### 8.6 测试策略（无网络）

- 临时仓库：`mkdtemp` + `git init` + 本地 user config + 初始 commit。
- 裸仓库 remote：`git init --bare` + `git remote add origin <bare>`；测试 push/fetch/merge/冲突，无网络。
- Mock Provider：内存实现 `PrProvider`，模拟 open/merged/conflicting/checks 状态；测试队列 FSM。
- GitHub 集成测试默认跳过，仅 `DEER_GIT_E2E_GITHUB=1` 且显式仓库/分支时运行（只读或专用测试仓库；文档警告）。
- 安全测试：redaction fixtures、路径逃逸、branch 注入、敏感文件、`push main` 拦截。
- 测试数据/时钟注入：`Clock`/`RepoLock`/job worker 手动 tick，避免真实定时器。

---

## 9. UI / API

### 9.1 IPC / API 契约

```ts
// src/shared/ipc.ts 扩展（命名待实现确定，统一前缀）
interface DeerApi {
  // Git / VCS
  gitDiagnose(workspaceId: string): Promise<RepoDiagnostics>;
  getTaskVcs(taskId: string): Promise<TaskVcs | null>;
  gitCreatePr(taskId: string, commandId?: string): Promise<GitResult<TaskVcs>>;
  gitRetryPush(taskId: string, commandId?: string): Promise<GitResult<TaskVcs>>;
  gitCleanup(taskId: string, commandId?: string): Promise<GitResult<void>>;
  gitOpenPr(taskId: string): Promise<GitResult<void>>; // main 校验 + openExternal
  // Merge queue
  mergeQueue(workspaceId: string): Promise<MergeQueueSnapshot>;
  mergeEnqueue(taskId: string, commandId?: string): Promise<GitResult<MergeQueueItem>>;
  mergeApprove(taskId: string, commandId?: string, note?: string): Promise<GitResult<MergeQueueItem>>;
  mergeRetry(itemId: string, commandId?: string): Promise<GitResult<MergeQueueItem>>;
  mergeCancel(itemId: string, commandId?: string): Promise<GitResult<MergeQueueItem>>;
  // Git 设置
  getGitSettings(workspaceId: string): Promise<GitSettingsInfo>;
  saveGitSettings(workspaceId: string, settings: GitSettings): Promise<GitSettingsInfo>;
  gitInstallPrePushGuard(workspaceId: string, enabled: boolean): Promise<GitResult<void>>;
}
```

- IPC channels：`git:*`、`merge:*`，全部 `handle()` 包装错误为 `GitResult`；未声明通道不暴露（沿用现有 preload 白名单模式）。
- 快照扩展：`Snapshot` 增加 `taskVcs?: Record<string, TaskVcs>`（可选，避免破坏旧 renderer）；或任务详情按需 `getTaskVcs`（推荐，减少快照体积）。
- 所有 mutation 触发 `app:event`（既有 `onEvent`），UI 刷新队列/任务 VCS；无新轮询。

### 9.2 任务详情 VCS 区

位置：TasksView 任务详情头部下方（现状 `App.tsx:1787–1862` 区域），顺序：

```text
[VCS 区]
模式：Git 隔离（分支 deer/t68-event-kernel） | 未隔离（非 Git 工作区） [帮助]
分支：deer/t68-event-kernel  [复制]    base: main
提交：a1b2c3d  [复制]
PR：   #12 open · checks 2/3 · review pending   [打开 PR] [刷新]
合并：未合并（队列第 2 位） / 已合并（commit 9f8e7d6） / 冲突（任务 t99） [查看冲突任务]
操作：[创建 PR] [重试推送] [批准合并] [加入队列] [清理工作树]
```

- 状态徽标复用状态色 token；PR 状态变体（open/checks_failed/merged/conflict）用文案 + 图标 + 颜色双通道，不只颜色。
- 按钮：`aria-label`、`title` 说明禁用原因（如「需要先推送」「需先批准」「检查未通过」）；loading 时 `aria-busy`。
- 错误：`role=alert` + 代码 + 可复制详情（脱敏）；成功 toast（C26）。
- 复制：`navigator.clipboard` 失败 → 展开只读输入框手动复制（沿用现有复制模式）。
- 状态变化：`aria-live=polite` 播报「PR 已创建/检查失败/合并完成/冲突任务已创建」；reduced-motion 无动画。

### 9.3 合并队列（TasksView 头部入口 + Modal）

- 任务页头部（现有工具栏）新增按钮：`合并队列 <badge N>`（N=活跃项数）；`aria-label="打开合并队列，N 项"`。
- Modal（复用 C25 `Modal`）：
  - 标题「合并队列」+ 说明「同一时刻只合并一个 PR；按队列顺序」；
  - 列表（`role=table` 或 `<table>`）：位置、任务（标题/ID）、PR（#/链接）、checks（通过/失败/等待）、review、状态、冲突任务、操作（批准/重试/取消/打开 PR）；
  - 空态：「队列为空。任务完成后在详情里创建 PR 并批准合并。」；
  - 键盘：Tab 可达每个操作；Esc 关闭并回焦触发按钮；无 hover-only；`aria-live` 播报状态变化；长列表可滚动。
- 队列状态文案（copy.ts 单一来源）：排队中 / 等待检查 / 等待批准 / 就绪 / 更新 base / 合并中 / 已合并 / 冲突阻塞 / 失败 / 已取消。

### 9.4 冲突任务展示

- 任务列表/星图：冲突任务标题前缀 `解决合并冲突：`，徽标「冲突」（状态色橙/红 + 文案）；详情显示源任务/PR/冲突文件/解决指引。
- 合并队列项显示「冲突任务 t99 · 待解决」+ 跳转；解决并 push 后自动重试队列，UI toast。
- 冲突任务 owner：`merge_captain`（human → 显示「待人工/指派」；agent → 负责人）。

### 9.5 设置（Git 区）

- 每工作区（打开工作区后）显示：仓库路径（只读）、remote（host/repo，不显示凭据）、base branch、provider（auto/github/manual/local）、gh 认证状态（已登录/未登录）、分支保护状态（已保护/未保护警告）、auto PR / auto push WIP / require approval / auto merge / merge method / max worktrees（1–3）/ checks command（输入 + 探测建议）/ merge captain。
- 「诊断」按钮 → 显示 `RepoDiagnostics`（git 版本、root、worktrees、队列、最近错误、打开日志目录）；可复制。
- 不提供 token 输入；提供「如何登录 gh」帮助链接。
- 保存：校验 base 存在、maxWorktrees 1–3、checks command 长度 ≤500；失败 inline 错误 + 保留原值。

### 9.6 兼容与可达性

- 不新增 Dock 面板（§13 R13）；任务页头部/详情内部扩展，Dock 布局/deeplink 不变。
- 任务 ID/选中/C14 不变；星图/团队只读 `TaskVcs`（可选显示 PR 徽标，P1）。
- 键盘/ARIA：所有新控件原生 button/select/table；focus-visible；Modal 焦点陷阱由现有 Modal 保证；状态播报 `aria-live`；reduced-motion 不新增动画。
- 窄窗：VCS 区 wrap；队列 Modal 横向滚动或卡片化（<640px）。

---

## 10. 测试与验收

### 10.1 测试夹具与原则

- 纯确定性：临时目录 + 本地 git + 裸 remote；mock provider；手工 tick 队列；`Clock` 注入。
- 默认零网络；GitHub 集成测试用环境变量显式开启。
- 每个 AC 至少一个自动化测试（标注 `unit`/`integration`）；无法自动化的标注 `manual` 并给步骤。
- 测试命令：`pnpm typecheck` / `pnpm build` / `pnpm test`（新增测试文件加入 vitest）。

### 10.2 验收清单（AC）

#### Worktree / 分支（AC-WT）

| ID | 验收 | 方式 |
|----|------|------|
| AC-WT-01 | 非 Git 目录 → degraded：Run 在 workspace.path 执行，branch/worktree 为 null，写 `git.degraded`，任务不失败 | integration |
| AC-WT-02 | Git 仓库 → 创建 branch `deer/<task>-<slug>` + worktree `.deer/worktrees/<task>/1`；HEAD=分支；`git status` 干净 | integration |
| AC-WT-03 | 重试 attempt 2 复用 branch，worktree 路径 attempt=2，能看到 attempt 1 的 commit | integration |
| AC-WT-04 | 同一工作区第 4 个并发 prepare 被拒绝（`GIT_CAPACITY`），前 3 个正常；释放后可再获取 | integration |
| AC-WT-05 | worktree 创建失败（磁盘/权限）→ 清理半成品、defer/重试，不产生假分支 | unit/integration |
| AC-WT-06 | Run 正常结束 → commit + worktree 移除；无改动 → `git.no_changes` 且移除 | integration |
| AC-WT-07 | 模拟崩溃（进程重启）→ reconcile 回收；有改动 → wip commit + push（若开启），无改动 → 移除；事件 `git.reconciled` | integration |
| AC-WT-08 | 路径逃逸（`../`、symlink）被拒绝，不执行 git add/写入 | unit |
| AC-WT-09 | `.git/info/exclude` 幂等追加 `.deer/`，不修改 `.gitignore`，`git status` 不显示 runtime 文件 | integration |
| AC-WT-10 | 冲突任务检查出源任务 branch（`deer/<source>`），不创建新分支；解决后 push 到源 branch | integration |
| AC-WT-11 | pre-existing `.deer` 且无本系统标记 → 改用 `.deer-git/worktrees` 并提示，不覆盖用户数据 | unit |
| AC-WT-12 | 软所有权：改动超出 `scopePaths` 只写 `git.scope_mismatch` + 详情提示，不阻止 commit/合并；事件含文件列表 | integration |

#### Git 操作 / 安全（AC-GIT）

| ID | 验收 | 方式 |
|----|------|------|
| AC-GIT-01 | 命令全部走 argv 白名单；`push origin main` / `--force` / `push --all` 被拒绝（抛 `GIT_FORBIDDEN`），不执行 | unit |
| AC-GIT-02 | 分支名注入（`a;rm -rf`、`../`、`-x`）被拒绝；合法 slug 通过 | unit |
| AC-GIT-03 | 提交前扫描：`.env`/`id_rsa`/`*.pem`/node_modules/>5MB 阻止 commit，写 `git.commit_blocked`，不含文件内容 | unit |
| AC-GIT-04 | commit 身份：repo 有 user.name/email 时使用；缺失时用临时 env，不写全局 config | integration |
| AC-GIT-05 | push 非快进 → `GIT_PUSH_REJECTED`（retryable=false），不 force | integration |
| AC-GIT-06 | push 网络失败 → 重试 job（退避），任务状态不变 | integration |
| AC-GIT-07 | 所有输出/事件/错误经过脱敏：token fixture 不出现在事件 payload/DTO/日志 | unit |
| AC-GIT-08 | remote URL 含凭据 → UI/事件只显示 host/repo；openExternal 只允许 https + 配置 host | unit |
| AC-GIT-09 | `git` 不存在/版本过低 → degraded，不崩溃 | unit |
| AC-GIT-10 | 仓库不是根（子目录）→ `GIT_NOT_ROOT` degraded + 提示，不创建 worktree | integration |

#### PR Provider（AC-PR）

| ID | 验收 | 方式 |
|----|------|------|
| AC-PR-01 | Mock GitHub：createPr 返回 number/url/headSha；重复 commandId 幂等不重复建 | unit |
| AC-PR-02 | 无 remote → Local provider：不推送、pr_state=local；确认合并用 ancestor 校验 | integration |
| AC-PR-03 | 有 remote 无 gh auth → Manual：生成 compare URL；标记合并需 ancestor 校验，校验失败拒绝 | unit/integration |
| AC-PR-04 | GitHub 限流/403 → 退避重试，不把任务判失败；3 次后队列 blocked/waiting | unit（mock fetch/gh） |
| AC-PR-05 | mergeable=conflicting → 不调用 merge，转冲突流程 | unit |
| AC-PR-06 | 合并后 refresh 验证 mergeCommitSha；provider 已 merged 时收敛不重复 merge | unit |
| AC-PR-07 | PR URL 非白名单 host/非 https → 拒绝打开 | unit |
| AC-PR-08 | gh 输出含 token/敏感信息时 DTO 脱敏 | unit |

#### 合并队列（AC-MQ）

| ID | 验收 | 方式 |
|----|------|------|
| AC-MQ-01 | 每工作区一次只一个 merging；两个 ready 项串行，顺序按 position | integration |
| AC-MQ-02 | require_approval=true 未批准 → waiting_review，不合并；批准后 ready | integration |
| AC-MQ-03 | checks failed → failed（不合并），修复后重试；checks passed 才 ready | integration |
| AC-MQ-04 | headSHA 变化 → 重置 checks/review，不合并旧 head | unit |
| AC-MQ-05 | 冲突 → blocked + 冲突任务只创建一次（同 PR+baseSha 去重）；解决/更新后重新入队 | integration |
| AC-MQ-06 | merge API 超时后重启 → refresh 发现 merged 收敛；未知 → blocked，不二次 merge | integration |
| AC-MQ-07 | 重复 enqueue/approve/retry 幂等；唯一活跃索引拒绝重复项 | unit |
| AC-MQ-08 | 取消队列项 → 后续项继续；不删除已合并记录 | unit |
| AC-MQ-09 | 队首阻塞（等人工）→ 后续不跳过（默认）；配置允许时按序跳过（P1） | unit |
| AC-MQ-10 | 合并成功写 merge_merged + task_vcs.merged + merge_attempt；清理 branch/worktree | integration |
| AC-MQ-11 | 本地模式：队列为人工合并，ancestor 未满足 → 拒绝标记 merged | integration |
| AC-MQ-12 | 冲突任务上限 2，超过 → 队列 blocked，不刷任务 | unit |

#### 事件 / 任务联动（AC-EVT / AC-KRN）

| ID | 验收 | 方式 |
|----|------|------|
| AC-EVT-01 | 事件目录全量注册；payload schema 校验；无 token/内容泄露 | unit |
| AC-EVT-02 | 重复 job/命令不重复写事件（幂等键） | unit |
| AC-EVT-03 | 事件可按 task/workspace 回放，UI trace 可见（Git 事件进入 `getTaskTrace`） | integration |
| AC-KRN-01 | 内核 `prepareRun` 返回 worktree cwd；`toolContext.worktreePath` 指向它（mock loop 断言 fs 写入位置） | integration（依赖 t68） |
| AC-KRN-02 | 容量不足 → 任务 queued + `scheduler.deferred`，不 failed；槽释放后自动继续 | integration（依赖 t68） |
| AC-KRN-03 | `onRunFinished` 入队 <10ms，不被 Git 网络阻塞；Git 失败不影响 Run 终态 | integration |
| AC-KRN-04 | degraded 模式 Run 使用 workspace.path，内核无异常 | integration |
| AC-KRN-05 | 任务 cancelled/failed 时 worktree 回收，run_vcs 记录 mode/branch/commit | integration |

#### UI / 可达性（AC-UI）

| ID | 验收 | 方式 |
|----|------|------|
| AC-UI-01 | 任务详情显示模式/分支/base/commit/PR 状态/合并状态；degraded 显示原因与帮助 | manual + RTL/组件测试（若有） |
| AC-UI-02 | 合并队列 Modal：列表/空态/状态文案；键盘 Tab/Esc/回焦；aria-live 播报 | manual |
| AC-UI-03 | 所有按钮有 aria-label/title 禁用原因；错误 role=alert；复制失败回退输入框 | manual |
| AC-UI-04 | 冲突任务在任务列表/队列可见，跳转正确 | manual |
| AC-UI-05 | 设置 Git 区校验（maxWorktrees 1–3、base 存在）；保存失败保留原值 | manual/unit |
| AC-UI-06 | 窄窗（960/760）VCS 区与 Modal 不溢出/不遮挡；reduced-motion 无动画 | manual |
| AC-UI-07 | 不新增 Dock 面板；deeplink/C14/星图无回归 | integration/manual |

#### 迁移 / 恢复（AC-MIG）

| ID | 验收 | 方式 |
|----|------|------|
| AC-MIG-01 | 首次启动创建 Git 表（幂等）；重复启动无变更；`git_schema` 版本记录 | integration |
| AC-MIG-02 | 与 kernel v2 迁移共存：user_version 不被 Git 改动；两套迁移顺序任意 | integration |
| AC-MIG-03 | `git.mode=off` 时不创建 worktree/PR，行为与当前一致（runTask 不写假 branch） | integration |
| AC-MIG-04 | 回滚：关闭开关后不崩溃；Git 表保留；worktree 清理命令可用 | integration |

#### 端到端（AC-E2E，临时仓库 + 裸 remote + mock provider）

| ID | 验收 | 方式 |
|----|------|------|
| AC-E2E-01 | 两个任务并行：各自 branch/worktree；互不影响；各自 commit | integration |
| AC-E2E-02 | 两个 PR 入队：串行合并；第二个在第一个 merged 后合并；无重复/漏合并 | integration |
| AC-E2E-03 | 冲突路径：两分支改同一行 → 第二个 blocked + 冲突任务（一次）→ 解决 → 合并；事件链完整 | integration |
| AC-E2E-04 | 崩溃恢复：merge 中重启 → 不重复合并；worktree 回收；队列继续 | integration |

### 10.3 人工冒烟（真实 GitHub，可选）

1. 在个人测试仓库打开工作区 → 设置 base main → 运行一个改动文件的任务 → 任务详情出现 branch/commit/PR。
2. GitHub PR 页面 checks 等待→通过；应用队列状态同步；批准 → 合并 → 任务 VCS 显示 merged + merge commit。
3. 两任务同时运行 → 各自 worktree；合并第二个时若 base 前进 → update-branch 成功或冲突任务。
4. 关闭 gh 登录 → Manual provider 生成 compare URL；登录恢复后诊断正常。
5. 无 remote 本地仓库 → local 模式，无推送；确认合并后清理。
6. 运行中拔网 → push 失败重试；恢复后重试成功；任务状态不变。

### 10.4 测试命令

```bash
pnpm typecheck
pnpm build
pnpm test          # 新增 git/*.test.ts；默认无网络
# 可选真实 GitHub（专用测试仓库）：
DEER_GIT_E2E_GITHUB=1 pnpm test -- git-github
```

---

## 11. 文件级影响面与迁移

### 11.1 新增/修改文件

| 文件 | 动作 | 内容 | 阶段 |
|------|------|------|------|
| `src/kernel/git/types.ts` | 新增 | RepoInfo/PrInfo/TaskVcs/MergeQueueItem/GitErrorCode | G1 |
| `src/kernel/git/gitExec.ts` | 新增 | execFile 封装、白名单、超时、脱敏、RepoLock | G1 |
| `src/kernel/git/repoLocator.ts` | 新增 | 仓库/remote/base 探测、诊断、缓存 | G1 |
| `src/kernel/git/worktreeManager.ts` | 新增 | reservation、创建/复用/移除、容量、reconcile | G1 |
| `src/kernel/git/branchService.ts` | 新增 | 命名/校验/commit/push | G1 |
| `src/kernel/git/commitGuard.ts` | 新增 | 敏感文件/大小/secret 扫描 | G1 |
| `src/kernel/git/gitStore.ts` | 新增 | Git 表迁移与 DAO（`git_schema`） | G1 |
| `src/kernel/git/gitEvents.ts` | 新增 | 事件注册/幂等/脱敏包装 | G1 |
| `src/kernel/git/gitService.ts` | 新增 | 门面：prepare/finalize/cleanup/diagnose | G1/G3 |
| `src/kernel/git/providers/{types,github,manual,local,index}.ts` | 新增 | Provider 抽象与实现 | G2 |
| `src/kernel/git/prService.ts` | 新增 | PR 创建/刷新/checks/review/close | G2 |
| `src/kernel/git/mergeQueue.ts` | 新增 | 队列 FSM/worker/tick/恢复 | G4 |
| `src/kernel/git/conflictTasks.ts` | 新增 | 冲突去重/任务创建/关联 | G4 |
| `src/kernel/git/gitJobs.ts` | 新增 | outbox 队列 + worker | G1/G3 |
| `src/kernel/store.ts` | 改 | 初始化 Git 表（委托 gitStore）；appendEvent 兼容；不加 kernel 表列 | G1 |
| `src/kernel/service.ts` | 改 | 打开工作区时探测 Git；runTask 兼容包装（G3 前）；快照/命令委托 | G1/G3 |
| `src/shared/types.ts` | 改 | TaskVcs/MergeQueue/GitSettings/RepoDiagnostics（仅新增） | G1/G2 |
| `src/shared/ipc.ts` / `electron/preload.ts` / `electron/main.ts` | 改 | Git/merge/settings IPC + openExternal 白名单 | G1/G2 |
| `src/shared/copy.ts` | 改 | VCS/PR/队列/冲突文案与状态标签 | G4/G5 |
| `src/App.tsx` | 改 | 任务详情 VCS 区、队列 Modal、批准/重试/复制/打开 PR | G5 |
| `src/TeamDashboard.tsx` | 改 | 冲突任务徽标/PR 徽标（可选） | G5 |
| `src/styles.css` | 改 | VCS 区/队列表/徽标/窄窗 | G5 |
| `scripts/branch-worktree.mjs` | 不改 | dev 流程保持；仅在文档中说明与 runtime 的分离 | — |
| `.gitignore` / `.git/info/exclude` | 不改 / 运行时追加 | `.deer/` 已忽略；用户仓库通过 local exclude | G1 |
| `src/kernel/git/*.test.ts` | 新增 | §10 AC 对应测试（建议 6–8 文件） | G1–G4 |
| `docs/team/git-parallel-design.md` | 新增 | 本文件 | t73 |
| `docs/team/git-parallel-implementation.md` | 新增 | 实现映射/验证/偏差（实现阶段） | G1+ |

### 11.2 迁移策略（与 t68 解耦）

- **Git 表独立**：全部 `CREATE TABLE IF NOT EXISTS`；`git_schema(version)` 记录 1；**不使用** `PRAGMA user_version`（kernel v2 使用）。
- **不改 kernel 表**：`tasks`/`runs` 仅使用现有 `branch`/`worktree` 列作为缓存；VCS 详情在 `task_vcs`/`run_vcs`。若未来 kernel 增加字段，Git 可再迁移。
- **启动顺序**：store 构造时先跑 kernel v1/v2 schema，再跑 Git schema（幂等）；两者互不依赖。
- **功能开关**：`git_repo_config.mode` 默认 `auto`，但 G1 合并时默认 `off`（存量行为不变）；G2 完成后按工作区首次打开探测自动开启（`auto`），用户可关。
- **回滚**：老版本不认识 Git 表 → 忽略；关闭 `mode=off` 时无副作用；worktree 清理命令可在 UI/CLI 执行；分支保留不删。
- **数据兼容**：`Task.branch/worktree` 旧假值（`deer/<id>`/workspace.path）首次探测时清理为 null，写事件 `git.legacy_cleared`（不改变任务状态）。

### 11.3 迁移/实现顺序

1. G1：Git 核心（表、exec、repo、worktree、branch、guard、jobs、诊断）+ 单测；默认关闭。
2. G2：Provider（GitHub/Manual/Local）+ PR 服务 + 设置 UI/API。
3. G3：内核集成（t68 合并后）：prepareRun/capacity/onRunFinished；兼容包装可先上。
4. G4：合并队列 + 冲突任务 + 恢复；事件/审计。
5. G5：任务详情/队列 Modal/设置打磨 + 文档 + 集成验收。

---

## 12. 分阶段实施与工期

| 阶段 | 范围 | 依赖 | 预估 |
|------|------|------|------|
| **G0** | 本设计评审 + Captain 裁决 Q1–Q10 | t73 | 已完成 |
| **G1** | Git 表/迁移、GitExec 白名单、RepoLocator、WorktreeManager、BranchService、CommitGuard、git_jobs、诊断 API、单测（AC-WT/GIT 大部分） | 无（可与 t68 并行） | 3–4 人日 |
| **G2** | Provider 抽象 + GitHub/Manual/Local、PR 服务、设置（不含 UI 打磨）、mock/裸仓库测试（AC-PR） | G1 | 2–3 人日 |
| **G3** | 内核集成：`prepareRun`/容量 defer/`onRunFinished` 入队；service 兼容包装；Run 级 VCS 记录（AC-KRN） | t68 API 冻结（t69 前） | 2–3 人日 |
| **G4** | 合并队列 FSM/worker/恢复、冲突任务去重/创建、checks、事件（AC-MQ/EVT） | G2 + G3 | 3–4 人日 |
| **G5** | 任务详情 VCS 区、队列 Modal、设置/诊断、ARIA、文档、集成验收 | G1–G4 | 2–3 人日 |

**总计约 12–17 人日**（1 名工程师 + 独立评审/集成）。开发分支限制：AGENTS §8 最多 3 个 dev worktree；当前 t64 占 1，内核 t68/t69 与 Git/memory 需排期（建议：t64 合并后 t68 + Git-G1 + memory 占 3；t69/G2 随后）。G1/G2 不依赖内核，可先开一条实现分支（示例：`pnpm branch:start <impl-task-id> git-core`，start 会自动 fetch 最新 `origin/main`）；提 PR 前 `pnpm branch:sync <impl-task-id>-git-core`，一个功能一个 PR，按 PR 模板填写。

---

## 13. 风险与缓解

| # | 风险 | 影响 | 缓解 |
|---|------|------|------|
| R1 | 与 t68 内核接口未定/变更 | G3 延期 | 本设计先冻结 `RunEnvironmentProvider` 契约；G1/G2 独立；兼容包装兜底 |
| R2 | worktree 容量死锁（失败任务占槽） | 新任务无法运行 | runtime worktree 按 Run 销毁；启动 reconcile + TTL；admission defer 不失败 |
| R3 | Git 状态与 DB 发散（外部 merge/手工操作） | UI 错误/重复合并 | provider refresh 为准；ancestor 校验；事件对账；未知状态 blocked |
| R4 | token 泄露 | 安全事件 | 不落库/不 IPC/脱敏测试；仅 gh keyring/env；错误/日志统一 redact |
| R5 | 敏感文件误提交 | 泄露 | CommitGuard 阻断 + 测试；不提供 force |
| R6 | shell 注入/路径逃逸 | 任意命令执行 | execFile argv 白名单 + ref/path 校验 + realpath |
| R7 | 合并重复/漏合并 | 代码丢失/冲突 | 幂等键 + 唯一活跃索引 + provider 二次校验 + 单飞 |
| R8 | GitHub 限流/网络 | 队列停滞 | 退避 + blocked 可见 + 手动重试；不无限重试 |
| R9 | 无 checks 来源仍合并 | 质量风险 | 默认 require approval；无 checks 必须显式 waive 并审计；本地 checks 自动探测 |
| R10 | dev/runtime worktree 混淆 | 3 槽被误占/污染 | 路径/前缀/计数分离；文档 + 诊断显示两类 worktree；local exclude |
| R11 | 用户 full_access shell 手动 push main | 绕过保护 | 应用层不执行；可选 pre-push guard；文档明示局限 + 审计事件 |
| R12 | 冲突任务刷屏 | 任务列表噪声 | (PR,baseSHA) 去重 + 每 PR 最多 2 个 + 复用 |
| R13 | 大仓库 worktree 创建慢 | 每次 Run 延迟 | 异步 prepare + 超时；同一任务复用 branch；未来 worktree 池/浅克隆 |
| R14 | Windows 路径/CRLF/长路径 | 创建失败/差异 | 路径上限、保留名、`core.autocrlf` 读取、win32 测试 |
| R15 | 测试依赖真实网络/不稳定 | CI 抖动 | 临时仓库 + 裸 remote + mock provider；GitHub E2E 默认跳过 |
| R16 | 事件表膨胀（worktree/commit 高频） | DB 体积 | 只记关键事件；心跳/续租不写事件；监控 |

---

## 14. 待拍板决策（Q）

| ID | 问题 | 建议 | 影响 |
|----|------|------|------|
| Q1 | runtime worktree 生命周期：Run 级（推荐）还是 Task 级常驻？ | Run 级：branch 持久、worktree 随 Run 销毁，3 槽可调度；失败保留内容通过 WIP commit | 容量/恢复 |
| Q2 | 每工作区 runtime worktree 上限 3 是否合适？ | 是（与 AGENTS dev 3 槽分开）；默认内核 workspace 并发 2，3 为护栏 | 并发 |
| Q3 | GitHub Provider 用 gh CLI 还是 REST 为主？ | gh CLI 优先（keyring/已登录），REST 兜底（企业 host/无 gh） | 认证/依赖 |
| Q4 | 默认合并方式？ | `squash`（历史干净、冲突面小）；可配置 merge/rebase | 历史 |
| Q5 | 合并批准是否复用 kernel review？ | 不；独立 `merge.approved`（P0），o2 落地后再接 reviewDecision | 门禁语义 |
| Q6 | runtime worktree 位置？ | `<workspace>/.deer/worktrees` + `.git/info/exclude`（用户可见、易调试；不污染 git status） | 路径/可见性 |
| Q7 | 失败/取消是否 push WIP？ | 失败默认 push（可关），取消默认不 push；都不建 PR | 恢复/噪声 |
| Q8 | 冲突任务负责人？ | 默认 human（merge captain 可配 agent）；Agent 不自动批准合并 | 流程 |
| Q9 | 无 checks 时是否允许合并？ | 必须显式 waive + 事件；默认阻止 | 质量 |
| Q10 | 合并队列是否自动开始？ | 批准后自动入队执行；可配置手动 | 体验 |

---

## 15. 附录

### 15.1 关键类型（草案）

```ts
export type GitErrorCode =
  | "GIT_NOT_FOUND" | "GIT_REPO_NOT_FOUND" | "GIT_NOT_ROOT" | "GIT_VERSION_LOW"
  | "GIT_WORKTREE_LIMIT" | "GIT_WORKTREE_FAILED" | "GIT_WORKTREE_NOT_CLEAN"
  | "GIT_BRANCH_INVALID" | "GIT_BRANCH_EXISTS" | "GIT_COMMIT_BLOCKED"
  | "GIT_PUSH_REJECTED" | "GIT_PUSH_AUTH" | "GIT_PUSH_NETWORK" | "GIT_TIMEOUT"
  | "GIT_FORBIDDEN" | "GIT_PATH_ESCAPE" | "SECRET_BLOCKED"
  | "PR_AUTH_MISSING" | "PR_CREATE_FAILED" | "PR_RATE_LIMITED" | "PR_UNKNOWN_STATE"
  | "MERGE_CONFLICT" | "MERGE_CHECKS_FAILED" | "MERGE_REVIEW_REQUIRED"
  | "MERGE_UNKNOWN_STATE" | "MERGE_LOCKED" | "MERGE_CANCELLED" | "MERGE_LIMIT";

export interface RepoDiagnostics {
  workspaceId: string;
  workspacePath: string;
  mode: "git"|"degraded"|"off";
  root: string | null;
  gitVersion: string | null;
  remote: { name: string; host: string; repo: string } | null;
  baseBranch: string | null;
  provider: "github"|"manual"|"local"|"none";
  auth: { gh: boolean; env: boolean; user: string | null };
  protection: "protected"|"unprotected"|"unknown";
  worktrees: Array<{ path: string; branch: string; taskId: string; state: string }>;
  queue: { active: number; blocked: number; state: string };
  lastError: { code: string; message: string; at: string } | null;
}

export interface MergeQueueSnapshot {
  workspaceId: string;
  items: MergeQueueItem[];
  activeMerge: string | null;   // queueId
  updatedAt: string;
}
export interface MergeQueueItem {
  id: string;
  taskId: string;
  taskTitle: string;
  provider: string;
  prNumber: number | null;
  prUrl: string | null;
  state: string;
  position: number;
  headSha: string;
  checks: { state: string; summary: string };
  review: string;
  conflictTaskId: string | null;
  lastError: string | null;
  updatedAt: string;
}
```

### 15.2 分支/路径速查

| 场景 | branch | worktree |
|------|--------|----------|
| 普通任务 Run | `deer/<taskId>-<slug>` | `<ws>/.deer/worktrees/<taskId>/<attempt>` |
| 任务重试 | 同上（复用） | 同上 attempt+1 |
| 冲突解决 | `deer/<sourceTaskId>-<slug>`（源 branch） | `<ws>/.deer/worktrees/<sourceTaskId>/conflict-<taskId>` |
| checks | 只读 checkout headSha（detached） | `<ws>/.deer/worktrees/_checks/<pr>-<sha7>` |
| dev worktree（AGENTS） | `feature/<taskId>-<slug>` | `branches/<taskId>-<slug>` |

### 15.3 当前代码锚点（设计对照，非改动）

| 位置 | 内容 |
|------|------|
| `src/kernel/service.ts:760–801` | `runTask` 当前流程；假 `worktree=workspace.path`、`branch=deer/<id>`（G3 替换） |
| `src/kernel/service.ts:815–826` | `ToolContext`（workspacePath/worktreePath 当前相同） |
| `src/shared/types.ts:69–79` | Task.branch/worktree 字段 |
| `src/shared/types.ts:81–93` | Run 现状（无 VCS 字段） |
| `src/kernel/store.ts:64–105` | tasks/runs/events schema |
| `src/kernel/store.ts:377–404` | appendEvent（无幂等键） |
| `src/kernel/store.ts:717–782` | createRun/updateRun/listRuns |
| `src/kernel/tools.ts:601–627` | git.status / git.diff（只读） |
| `scripts/branch-worktree.mjs:6,58,86,109–145,172–236,263–282` | dev worktree 上限/命名/start+fetch/sync/finish/remove |
| `src/App.tsx:1787–1862` | 任务详情（VCS 区插入位置） |
| `src/TeamDashboard.tsx:237–298` | 团队任务详情（可选 PR 徽标） |
| `electron/main.ts:96–130` | IPC handler 模式 |
| `electron/preload.ts:15–58` | preload 白名单 |
| `.gitignore` | `.deer/`、`branches/` 已忽略 |
| `AGENTS.md` §8 | dev worktree 3 上限/PR 流程 |

### 15.4 参考

- `DESIGN.md` §7.1、§9 P0（worktree/分支/PR、行级评审、事件日志）
- `docs/team/execution-kernel-design.md`（Run 生命周期、hooks、恢复、迁移、并发）
- `AGENTS.md` §4、§8（质量门禁、worktree/PR 流程）
- Git worktree 文档：`git help worktree`；GitHub CLI `gh pr` / `gh api`
- 团队裁决：`bb-87`（内核优先）、`bb-88`（Git + 记忆系统）、`bb-83`（Dock 快捷键等无关项）

---

## 附：与其它系统的边界

| 系统 | 关系 |
|------|------|
| 任务执行内核（t68/t69） | 内核调度/Run/Task 状态；Git 提供执行目录与 VCS 副作用；通过 `RunEnvironmentProvider`/hooks/准入 defer 协作（§4.4、§7.3） |
| 行级评审（o2，后续） | Git 提供 PR head/branch/diff 数据与 `reviewDecision` 接口；o2 提供行内评论/blocker；合并队列消费其结论（§5.4、§6.6） |
| 记忆系统（t74） | 无共享表；Git 事件可作为记忆写入源（提交/合并摘要），由记忆系统订阅（不在本设计实现） |
| 看门狗/成本（未选中） | 读取 run/git 事件；不直接改 Git 状态；干预通过队列/任务命令 |
| Dock/星图/交互画布（t64） | 无代码交叉；仅任务详情 UI 扩展；冲突任务在星图显示为普通任务（可选徽标） |
| dev 分支流程（AGENTS §8） | 完全独立；本设计不改变 `pnpm branch:*` 脚本、3 dev worktree 上限、`branch:sync`/PR 模板/最小 PR 原则 |

---

*本文为设计基线，不含代码改动。Captain 审批后按 §12 创建实现分支；实现阶段需产出 `docs/team/git-parallel-implementation.md` 并附 AC 验证结果。*
