# 行级评审与合并门禁设计（o2）

- **任务**：t135 — 设计：行级评审与合并门禁
- **状态**：设计基线（P0 可实现）；只读代码/文档，本任务不改代码
- **依据**：`DESIGN.md` §5.6 评审、§7.1 并发写同一仓库、§8 UI 信息架构、§9 P0 第 8 条；`docs/team/git-parallel-design.md`（t129 通过，PR #4 已合并）；`docs/team/execution-kernel-design.md` §13 reviewPolicy；`docs/team/memory-system-design.md`；`docs/team/dock-layout-design.md`
- **前置**：t98 Git 合并队列/PR/checks 已合并（main `f2ed9c8`）；t123 记忆工作台已合并；t72 内核 review UI 已合并
- **本文结论**：P0 用统一 diff 渲染（不引入 Monaco），评论/blocker 作为独立 `review_*` 持久层；行级评审是 **merge gate 的前置门禁**，不替换 kernel review，也不替换 `approved_head_sha`。评审决策、线程、diff 全部绑定不可变 head SHA；head 变化即失效并重新锚定。

---

## 0. 结论摘要（DEC-R）

| # | 决策 | 理由 |
|---|------|------|
| D-R1 | **P0 不引入 Monaco**，用统一 diff + 自研行渲染；Monaco 仅在 P1 作为可选 lazy split view | 当前包 1.16 MB gzip，Monaco 增加数 MB + worker/CSP 复杂度；评审是读+评论，不需要编辑器能力。保留 P1 适配层 |
| D-R2 | **review target 绑定不可变 `(base_sha, head_sha, diff_hash)`**；diff 从 git commit 读取，不依赖 runtime worktree | worktree finalize 后会删除；PR/合并队列以 commit SHA 为事实；避免未提交内容进入评审 |
| D-R3 | **行级评审独立于 kernel review**（Q5）：`review_decision` 与 `merge.approved` 是两套审计；前者是后者的前置门禁 | kernel review 是任务完成语义；行级评审是代码质量/合并语义；二者可分别配置，不能互相冒充 |
| D-R4 | **blocker 未解决阻止合并**；`review.mode=required` 时 merge queue 无法进入 merging | DESIGN 要求；advisory 模式仅警告，off 保留旧行为 |
| D-R5 | **评论正文只存事实表，不写事件 payload**；事件只含 id/枚举/计数/hash | 避免正文进入事件回放/日志；审计可追溯 |
| D-R6 | **作者不能批准自己的变更**；Agent 不能批准/开 blocker/resolve blocker；人类评审人必须属于同一 workspace | P0 人类治理；单用户应用默认本地人类 `user` 为评审人 |
| D-R7 | **默认 rollout：已有 workspace 迁移为 `advisory`，新建 workspace 为 `required`**；UI 显式提示，可切换 | 不突然阻断既有合并；团队模式推荐 required，新项目默认强制 |
| D-R8 | **不新增 Dock 面板**；评审区嵌在任务详情，panel key 仍为 `tasks`；深链 `#/tasks?t=&review=1` | DESIGN §8 右栏/任务详情；C09 六 tab 约束；减少布局回归 |
| D-R9 | **diff 解析/缓存放在主进程**；渲染层只拿分页后的行和线程，不把整仓库 patch 过 IPC | 大 diff、安全边界、主进程可取 git 数据；渲染层保持轻量 |
| D-R10 | **review 表独立 `review_schema`**，不修改 kernel/Git schema；配置 1:1 workspace | 与 Git `git_schema`/memory `memory_schema` 同模式；迁移可独立回滚 |
| D-R11 | **head 变化使旧 decision 失效**；线程自动 re-anchor，不能确定时 `outdated` 且 blocker 仍需人工确认 | 防止旧批准合并新提交；不丢评论、不静默放行 blocker |
| D-R12 | **人类可显式关闭门禁**（`review.mode=off`）或配置 required；P0 不做“行级评审豁免合并”的隐形通道。P1 才考虑 captain override + 审计 | 保留逃生口，但必须显式、可审计，不能成为 Agent 路径 |

---

## 1. 目标、非目标与术语

### 1.1 目标

1. 在任务详情展示某任务 PR 的 **commit-bound diff**，支持文件树、统一 diff、行选择、行内评论和线程回复。
2. 评论线程有 `severity`（nit/suggestion/issue/blocker）、`open/resolved/outdated`、解决人/时间；**任何未解决 blocker 阻止合并**。
3. 评审人独立批准/要求修改；评审决策绑定 head SHA；与 Git PR、`merge_queue`、checks、`approved_head_sha` 契约一致。
4. 评论/决策持久化、审计、权限、通知；与邮箱、黑板摘要联动；不泄露 token/私密内容。
5. UI 在任务详情内完成 Diff/评审，不新增 Dock 面板；键盘/ARIA/窄屏可用，非 hover-only。
6. 大 diff/HTML 注入/迁移/回滚/性能有明确边界与验收。

### 1.2 非目标（P0）

- 不在应用内编辑代码、不 apply suggestion、不做 inline code suggestion。
- 不做 Monaco 编辑器/多光标/语法高亮全量；P1 可选。
- 不自动用模型生成评审意见或自动批准。
- 不双向同步 GitHub/GitLab 原生 inline comments（P1 只读导入可选）。
- 不做多 PR/stacked diff、跨仓库 diff、非 Git provider 的 diff API。
- 不把行级评论写进 kernel task schema；不改 `src/kernel/` 的 review 状态机。
- 不做多人类账号/SSO；P0 以本地人类 `user` + Agent 成员为身份模型，P1 扩展多用户。

### 1.3 术语

| 术语 | 含义 |
|------|------|
| Review target | 任务在某 PR/head/base 上的一次评审对象；唯一键 `(task_id, head_sha, base_sha)` |
| Diff | `merge-base(base, head)..head` 的 unified patch（按文件分页缓存） |
| Thread | 绑定文件/行/head 的评论线程，含一条根评论 + replies |
| Blocker | `severity=blocker` 且 `status=open` 的线程；合并门禁硬条件 |
| Review decision | 人类评审人对 target/head 的 `approve`/`request_changes`，绑定 head SHA |
| Merge approval | 合并队列的人工批准，落 `approved_head_sha`；与 review decision 独立 |
| Gate | `ReviewGate.evaluate(taskId, headSha)`：决定合并是否可继续 |
| Re-anchor | head 变化后，把旧线程从旧行映射到新 diff 的过程 |

---

## 2. 现状审计与契约

### 2.1 已有能力（main 实读）

| 层 | 现有实现 | 对本设计的约束 |
|----|----------|----------------|
| 任务/运行 | `Task.status` 含 `review`；`kernel.reviewPolicy=auto/required`；`reviewTask(approve/reject)` 写 `task.review_requested/approved/rejected` | 行级评审**复用 review 状态展示的位置**，但不改写 kernel 状态；kernel review 仍是任务完成门禁 |
| Git | `task_vcs`（branch/head_sha/pr）、`run_vcs`、`pr_records`、`merge_queue`、`merge_attempts`、`git_jobs`；`approved_head_sha`；队列 FSM `waiting_review/ready` | 行级评审在 `approve` 前评估；头变化沿用 `merge.approval_reset` 语义 |
| Diff | 无 diff 渲染/解析；GitExec 有 argv 白名单（`diff` 只允许只读形状） | 需新增 review 专用 diff 读取；扩白名单需安全评审 |
| 事件 | kernel eventRegistry + Git `events.ts`；Git 事件走 `emitGitEvent` | 新事件需 zod/schemaVersion；评论正文不入事件 |
| UI | 任务详情内联；`TaskVcsPanel` 已挂载；`Modal/Toast/Markdown/EmptyState` 可复用；Dock 六 tab | 不新增 panel；Review 区放在 VCS 下方；深链复用 `tasks` |
| 通知 | `sendMessage`（邮箱）、`MemoryService` 黑板、`Toast` | 复用；邮箱 `kind=review`；黑板摘要用 `decision/warning` |
| 记忆 | t123 MemoryRuntime/Board 已合并 | 评审摘要写黑板，不复制全文；评论仍以 review 表为事实源 |

### 2.2 现状缺口

1. 无 diff 解析、评论/线程/blocker 数据模型与 API。
2. `approved_head_sha` 只校验 merge 人工批准，不校验行级评审；checks 也不含 blocker。
3. 任务详情只显示 kernel review 的批准/拒绝，没有代码行级上下文。
4. 评论/决策无审计、无 head 绑定、无 rebase re-anchor。
5. 无 review 通知/黑板摘要；Agent 无 review 工具（P0 不需要）。
6. 没有 review 迁移/回滚/大 diff/HTML 注入测试。

### 2.3 与 Git 设计的关键契约

- **`approved_head_sha` 语义不变**：仍由人工合并批准写入；行级评审通过是写入前的必要条件（required 模式）。
- **checks 与 review 双门禁**：checks 全过 + review gate pass + 人工 `approved_head_sha`=当前 head + mergeable，才可 merging。
- **head 变化**：`pr.updated`/`git.pushed`/`merge.approval_reset` 触发 review target stale、线程 re-anchor、decision 失效；队列回 `waiting_review`。
- **Q5**：不把 `review_decision` 映射成 kernel `task.review_approved`；两个决定可分别记录，UI 明示「任务评审」与「合并评审」。
- **waive**：P0 不提供 `mergeWaiveReview`；只能把 `review.mode` 改为 `off`（配置权限 + 审计）或解决 blocker。P1 才做 captain override。

---

## 3. 总体架构

```
┌────────────────────────────────────────────────────────────────────┐
│ Renderer                                                           │
│  App task detail ── ReviewSection (Diff / Threads / Review footer) │
│         │ window.deer.review.*                                     │
├─────────┼──────────────────────────────────────────────────────────┤
│ Main / Electron                                                    │
│  IPC handlers → ReviewService                                      │
│    ├─ ReviewStore (review_schema, same SQLite DB)                  │
│    ├─ ReviewDiffProvider (GitExec read-only argv allowlist)        │
│    ├─ ReviewGate (used by GitService/MergeQueue)                   │
│    ├─ ReviewNotifier (mailbox + memory board summary)              │
│    └─ ReviewEventEmitter (kernel store events + zod)               │
├─────────┼──────────────────────────────────────────────────────────┤
│ Git layer                                                          │
│  task_vcs / pr_records / merge_queue / approved_head_sha           │
└────────────────────────────────────────────────────────────────────┘
```

### 3.1 模块职责

| 模块 | 职责 |
|------|------|
| `src/review/types.ts` | ReviewTarget/File/Thread/Comment/Decision/GateResult/错误码 |
| `src/review/store.ts` | `review_schema` 迁移、CRUD、事务、索引、审计事件 outbox |
| `src/review/diff.ts` | git diff 读取、unified parser、rename/binary/truncate、diff_hash |
| `src/review/anchor.ts` | 线程 anchor/re-anchor、outdated 判定 |
| `src/review/service.ts` | 创建 target、线程/评论/决策、权限、通知编排 |
| `src/review/gate.ts` | `evaluate`、approval 计数、blocker 查询、模式 |
| `src/review/notifications.ts` | 邮箱/黑板/去重 |
| `src/review/ui/*` | ReviewSection/DiffViewer/FileTree/ThreadList/Composer |
| Git 集成 | `GitService` 注入 gate；`mergeQueue.approve/process` 调 gate；`MergeQueueItem.review` 扩展 |
| IPC | `shared/ipc.ts` + preload + main handlers |
| App | 任务详情插槽、深链、Toast/Modal 复用；不新增 Dock panel |

### 3.2 写入路径

```
PR created / head changed
  → ReviewService.ensureTarget(taskId, headSha, baseSha)
  → diff provider computes merge-base + patch + diff_hash
  → store insert target/files
  → notify reviewer (mailbox / in-app)
  → user opens task detail → getReviewTarget/getReviewDiff/getThreads
  → create thread/comment (human)
  → resolve/reopen / add blocker
  → submit review decision (approve | request_changes)
  → event review.decision
  → merge queue approve/process calls ReviewGate.evaluate
  → gate pass → approved_head_sha=current head → merging
```

### 3.3 读取路径

- 任务详情只按需读取：target 摘要 → 文件列表 → 某文件 diff 分页 → 该文件线程。
- 不把 diff/评论塞入 `Snapshot`（避免每次事件刷新膨胀）；UI 用独立 review API + 事件前缀刷新。
- 合并队列只读 gate 结果摘要，不拉 diff。

---

## 4. 数据模型

### 4.1 独立 schema

`review_schema(version)` 与 `git_schema`、`memory_schema` 同模式；**不改 kernel `user_version`**。`REVIEW_SCHEMA_VERSION=1`。

```sql
CREATE TABLE IF NOT EXISTS review_schema (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS review_config (
  workspace_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'advisory',        -- required | advisory | off
  required_approvals INTEGER NOT NULL DEFAULT 1,
  allow_agent_comments INTEGER NOT NULL DEFAULT 0,
  notify_mailbox INTEGER NOT NULL DEFAULT 1,
  board_summary INTEGER NOT NULL DEFAULT 1,
  max_diff_bytes INTEGER NOT NULL DEFAULT 5242880,
  max_diff_lines INTEGER NOT NULL DEFAULT 100000,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_targets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  provider TEXT NOT NULL,                       -- github | manual | local
  pr_number INTEGER,
  pr_url TEXT,
  base_branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,                       -- merge-base / base head at creation
  head_sha TEXT NOT NULL,
  merge_base_sha TEXT NOT NULL,
  diff_hash TEXT NOT NULL,                      -- sha256(canonical patch)
  status TEXT NOT NULL,                         -- pending|approved|changes_requested|stale|waived|unavailable
  required_approvals INTEGER NOT NULL DEFAULT 1,
  blocker_count INTEGER NOT NULL DEFAULT 0,
  approval_count INTEGER NOT NULL DEFAULT 0,
  last_decision_id TEXT,
  stale_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, head_sha, base_sha)
);
CREATE INDEX IF NOT EXISTS idx_review_target_task ON review_targets(workspace_id, task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_target_pr ON review_targets(workspace_id, provider, pr_number, head_sha);

CREATE TABLE IF NOT EXISTS review_diff_files (
  target_id TEXT NOT NULL,
  file_index INTEGER NOT NULL,
  path TEXT NOT NULL,
  old_path TEXT,
  change_type TEXT NOT NULL,                    -- A|M|D|R|C|T|U
  is_binary INTEGER NOT NULL DEFAULT 0,
  is_lfs INTEGER NOT NULL DEFAULT 0,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  line_count INTEGER NOT NULL DEFAULT 0,
  patch_text TEXT,                              -- unified patch (possibly truncated)
  truncated INTEGER NOT NULL DEFAULT 0,
  file_hash TEXT NOT NULL,
  PRIMARY KEY(target_id, file_index)
);
CREATE INDEX IF NOT EXISTS idx_review_file_path ON review_diff_files(target_id, path);

CREATE TABLE IF NOT EXISTS review_reviewers (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,                    -- user | agent:<id>; P0 human only for decision
  reviewer_kind TEXT NOT NULL,                  -- human | agent
  role TEXT NOT NULL,                           -- reviewer | merge_captain | advisory
  status TEXT NOT NULL,                         -- requested|approved|changes_requested|abstained
  assigned_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  last_notified_at TEXT,
  UNIQUE(target_id, reviewer_id)
);
CREATE INDEX IF NOT EXISTS idx_review_reviewer_pending ON review_reviewers(reviewer_id, status, requested_at);

CREATE TABLE IF NOT EXISTS review_threads (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  old_path TEXT,
  side TEXT NOT NULL,                           -- new | old
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  anchor_head_sha TEXT NOT NULL,
  anchor_blob_sha TEXT,
  context_before TEXT,                          -- bounded 3 lines
  context_after TEXT,
  diff_hash TEXT NOT NULL,
  severity TEXT NOT NULL,                       -- nit|suggestion|issue|blocker
  status TEXT NOT NULL,                         -- open|resolved|outdated
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT,
  resolution_note TEXT,
  reanchored_at TEXT,
  outdated_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_threads_target ON review_threads(target_id, file_path, status, severity);
CREATE INDEX IF NOT EXISTS idx_review_threads_blockers ON review_threads(target_id, severity, status);

CREATE TABLE IF NOT EXISTS review_comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_kind TEXT NOT NULL,                    -- human|agent
  body TEXT NOT NULL,                           -- plain text markdown; max 10k
  body_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_comments_thread ON review_comments(thread_id, created_at);

CREATE TABLE IF NOT EXISTS review_decisions (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL,                       -- approve|request_changes|comment
  head_sha TEXT NOT NULL,
  blocker_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(target_id, reviewer_id, head_sha)
);
CREATE INDEX IF NOT EXISTS idx_review_decision_target ON review_decisions(target_id, head_sha, created_at DESC);

CREATE TABLE IF NOT EXISTS review_reanchor_log (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  from_head_sha TEXT NOT NULL,
  to_head_sha TEXT NOT NULL,
  from_line INTEGER NOT NULL,
  to_line INTEGER,
  result TEXT NOT NULL,                         -- moved|outdated|unchanged
  reason TEXT,
  created_at TEXT NOT NULL
);
```

### 4.2 字段语义

- `base_sha`：创建 target 时的 base 分支 head；`merge_base_sha`：`merge-base(base,head)`。diff 用 merge-base..head，避免把 base 前进误算成作者改动。
- `diff_hash`：对文件列表 + patch 规范化后的 SHA-256；线程/decision 冗余保存，检测错配。
- `blocker_count`：`severity='blocker' AND status IN ('open','outdated')` 的数量；outdated blocker 仍计（见 §6.4）。
- `status`：`approved` 需所有 required approvals 且 0 blocker；`changes_requested` 任一 reviewer request_changes；`stale` head 变化/无法 reanchor；`unavailable` diff 失败。
- 评论正文是事实源；事件/邮箱/黑板只带 id/摘要。`body_hash` 用于审计完整性，不用于内容回放。
- `review_reviewers.reviewer_id`：本地人类固定 `user`；Agent 可 `agent:<id>` 但 P0 只能 `advisory`/评论，不能决定。P1 多用户 id。
- 索引支持：按 target 拉线程、按 blocker 查询、按 reviewer 找待办；所有查询 `workspace_id` 过滤（owner 隔离）。

### 4.3 事务边界

- `createThread`：thread + first comment + event outbox 同一事务；失败全部回滚。
- `submitDecision`：校验 gate 条件 + decision + target 状态 + `review.decision` 事件同一事务；重复决策按 `(target,reviewer,head)` 幂等返回旧记录。
- `resolveThread`：thread 状态 + resolve 元数据 + event 同事务；blocker 计数重算。
- `ensureTarget`：diff 计算在事务外（可能慢）；写 target + files 在事务内；并发用 `UNIQUE(task_id,head_sha,base_sha)` + `INSERT OR IGNORE` 后读。
- 事件 outbox：若事件写入失败，事务回滚；**不允许评论落库但审计失败**（安全要求）。事件通过 `store.appendEvent` 在事务内排队，提交后通知 renderer（沿用 t68 `withTransaction` 机制）。

---

## 5. Diff 引擎

### 5.1 Monaco 取舍（D-R1）

| 方案 | 优点 | 成本/风险 | 结论 |
|------|------|-----------|------|
| Monaco editor/diff | 语法高亮、split、成熟 | 数 MB bundle + worker + CSP + Electron 资源路径；行内评论 API 仍要自建；与我们只读需求不匹配 | **P1 可选**；P0 不做 |
| 自研 unified diff | 体积小、可控、易虚拟化/ARIA、Markdown 安全 | 需 parser/高亮；功能有限 | **P0 采用** |
| 第三方轻量 diff viewer | 中等体积 | 依赖风险/评论锚点难控 | 不采用 |

- P0 渲染：`<table role="grid">` 或 `role="table"`，每行一个 `<tr>`；新增/删除/上下文行 class；行号 gutter；无语法高亮（P1 可接轻量 tokenizer，禁止 `dangerouslySetInnerHTML` 渲染原始 diff）。
- P1 Monaco：懒加载 `import()`，只在用户选择 split view 时加载；仍以 review 数据为事实，Monaco decoration 只做展示；保留 unified 作为窄屏/无障碍 fallback。P1 不阻塞 P0 验收。

### 5.2 读取命令（GitExec 扩展）

P0 新增 `ReviewDiffProvider`，只允许只读 argv：

```
git -c core.hooksPath=<runtimeRoot>/hooks-empty diff \
  --no-color --no-ext-diff --no-textconv \
  --find-renames --find-copies \
  --unified=3 <merge-base>..<head>
git -c ... rev-parse --verify <head>
git -c ... merge-base <base> <head>
git -c ... cat-file -p <ref>:<path>   # 仅必要行/锚点校验
git -c ... diff --name-status -z <base>..<head>
```

- 扩展现有 `validateGitArgs`（`src/git/gitExec.ts`）而非绕过；`--no-ext-diff/--no-textconv/--no-color` 必须启用，防止仓库配置执行外部 diff。
- 禁止 `--word-diff`、`--color`、任意 `-c`（hooksPath 例外）、`--output`、`--src-prefix` 等。
- 路径必须 realpath 在 runtimeRoot/仓库内；只读。
- 结果在 GitExec 中 `redactSecrets`；diff 可能含仓库内容，仅回主进程/受控 UI。

### 5.3 计算与缓存

1. 从 `task_vcs`/`pr_records`/queue 取 `head_sha`、`base_branch`；`base_sha=rev-parse(base_branch)`。
2. `merge_base=git merge-base base head`；若失败 → `REVIEW_BASE_UNKNOWN`，target `unavailable`。
3. `git diff merge-base..head`，按 `diff --git` 分割文件；解析 rename/binary/mode。
4. 规范化 patch（去除 index 行/时间戳；保留 `---/+++`、hunk、行内容），计算 `diff_hash`。
5. 按文件写 `review_diff_files`：`patch_text` 最大 64 KB/文件，行数最大 2000/文件；总 patch 5 MB/100k 行；超限 `truncated=1`，UI 显示「大 diff 截断，展开单文件」。
6. 二进制/LFS：`is_binary=1`，只显示路径/大小，不显示内容；`is_lfs=1` 不拉 LFS。
7. 缓存 key `(task,head_sha,diff_hash)`；同一 target 复用；合并/PR closed 后 30 天 GC。

**性能目标**：10k 行 diff 解析 <300ms（主进程），首屏 <500ms；100k 行拒绝整页，按文件懒加载；UI 虚拟化只渲染 ~100 行窗口。

### 5.4 Unified diff 解析算法

```
for line in patch.splitlines():
  if line starts "diff --git": start file; parse a/ b/ (rename)
  elif "new file mode": change_type=A
  elif "deleted file mode": change_type=D
  elif "rename from/to": change_type=R
  elif "Binary files": is_binary=true
  elif "--- " / "+++ ": old/new paths (strip a/, b/; /dev/null)
  elif "@@ -a,b +c,d @@": push hunk; parse old/new counters
  elif line starts "+" (not "+++"): new line; newLine++
  elif line starts "-" (not "---"): old line; oldLine++
  elif line starts " " or "\\ No newline": context
  else: file metadata (index/mode)
```

- 行对象：`{kind:'context'|'add'|'del', oldLine:number|null, newLine:number|null, text:string, hunkId}`。
- 不支持 combined diff（merge commit diffs）：target 仅接受普通 head PR；若 head 是 merge commit，用 first-parent? P0 拒绝并提示用 PR head。
- `diff --name-status -z` 用于文件级快速索引/rename 校验；解析 NUL 分隔（含 R/C 双路径）。

### 5.5 SHA 绑定与 rebase 重新锚定

- target 唯一 `(task_id,head_sha,base_sha)`；`base_sha`/`merge_base_sha` 变化也生成新 target（同一 head 但 base 前进时，diff 结果变化；若 base 变化但 head 不变，创建新 target 并标旧 target `stale`，避免“旧 base 的评审”被当作当前）。gate 必须同时匹配当前 head 与当前 base（或 base 的 merge-base），否则 `REVIEW_STALE`。
- base 变化也触发 `reanchorThreads(oldTarget,newTarget)`（文件内容可能因 merge-base 改变而移动）；旧 decision 全部失效，需重新评审。
- `ensureTarget` 检测 `task_vcs.head_sha` 与当前 target head 不一致：
  1. 旧 target `status='stale'`，`stale_reason='head_changed'`；
  2. 所有旧 decision 保留但不再参与 gate；
  3. 调用 `reanchorThreads(oldTarget,newTarget)`；
  4. 若 `review.mode=required`，队列回 `waiting_review`，事件 `review.stale` + `merge.approval_reset`（若已批准）。
- `reanchorThreads` 算法见附录 A；线程始终保留，`outdated` 不删除；blocker 在无法锚定时仍 `open/outdated` 并继续阻止合并（直到人类 resolve 或确认仍适用）。
- 不做跨 commit 的自动“解决”；避免静默丢失评论。

---

## 6. 线程 / 评论 / Blocker

### 6.1 线程模型

- 一个 thread 锚定一个文件 + `side`（new/old）+ 行范围；根评论 + replies；**只有一层回复**（P0），避免深层树；P1 可支持嵌套。
- 线程状态机：
  - `open`：有未解决评论（至少一条未删除 comment；根评论被删则保留占位）
  - `resolved`：人类 reviewer/captain 显式解决；记录 resolved_by/at/note
  - `outdated`：head 变化且无法可靠 re-anchor；不删除，不自动解决
  - `reopen`：从 resolved/outdated 回到 open，写事件
- 默认 severity：`suggestion`；`blocker` 只能由人类 reviewer/captain 创建或升级；作者不能把 blocker 降级/删除（只能回复）。
- 线程/评论长度：body 1–10,000 chars；每 target 最多 2,000 threads；每线程最多 100 comments；超过拒绝 `REVIEW_LIMIT`。
- 评论 edit/delete：soft delete（deleted_at/by），保留审计；blocker 根评论删除需 reviewer 权限，且线程转 issue? P0 禁止删除 blocker 根评论，只能 resolve。

### 6.2 权限矩阵

| 操作 | 任务作者（Agent/human） | 分配评审人（human） | Merge captain（human） | 其他成员 |
|------|--------------------------|----------------------|------------------------|----------|
| 查看 diff/线程 | ✅（同 workspace） | ✅ | ✅ | ✅ |
| 新建评论/回复 | ✅ | ✅ | ✅ | ✅（P0 同 workspace human） |
| 新建 nit/suggestion/issue | ✅ | ✅ | ✅ | ✅ |
| 新建/升级 blocker | ❌ | ✅ | ✅ | ❌ |
| 解决 blocker | ❌（防自解） | ✅（创建者/评审人） | ✅ | ❌ |
| 解决 nit/suggestion | ✅ | ✅ | ✅ | ✅ |
| 提交 approve/request_changes | ❌ | ✅ | ✅ | ❌（未分配） |
| 修改 severity | ❌ | ✅ | ✅ | ❌ |

- 作者是 Agent 时无 UI 身份，不能走 review API 的 human 路径；P0 Agent 只能通过只读 tool 看自己的 review 摘要（P1 可评论）。
- `review.mode=off` 时仍可写评论？设计允许只读/评论但 gate 不阻断；UI 明示「当前评审不阻塞合并」。`off` 不应隐藏已有数据。

### 6.3 Blocker 语义

- `open` 或 `outdated` 且 severity=blocker 计入 blocker_count；gate 失败 `REVIEW_BLOCKED`。
- 解决 blocker 必须 reviewer/captain，可附 note；解决后写 `review.thread_resolved`，重算 count。
- 任何 head 变化使旧 decision 失效；已解决的 blocker 保留历史，不自动重现。若同一问题在新 head 仍存在，评审人可 reopen/新建。
- 合并队列在 `waiting_review` 显示 `blockers=N`；不允许“先合并后补评审”。
- **不做** checks 式 `waiveReview`；P1 才考虑 captain override（re-authenticated human + reason + 事件 `review.overridden`），默认关闭。

### 6.4 Outdated 规则

- 线程 anchor 在旧 head 上；reanchor 成功 → 更新 line/head，状态不变（open/resolved）。
- 无法唯一匹配 → `outdated`，保存 `outdated_reason`（file_deleted/ambiguous_context/patch_unavailable）。
- `outdated` 的 blocker **仍阻止合并**（D-R11）：UI 显示「旧提交上的 blocker，需确认是否仍适用」；评审人可 resolve（说明已不存在）或 reopen 到新行（P1手动 re-anchor）。
- 不做自动 resolve，避免作者通过 rebase 清 blocker。

---

## 7. 评审人、评审任务与 Q5 独立批准

### 7.1 身份与分配

- P0 人类身份：`reviewer_id='user'`（本地人类）；Agent 成员 `agent:<id>` 可被分配为 `advisory`，不能 approve/blocker。
- 默认 reviewer：
  1. `review_config` 指定 human reviewer（P1 多用户）；
  2. `merge_captain` 若为 human；
  3. 本地 `user`。
- 作者/owner 是 Agent 或任务提交者，不能成为 required reviewer；`required_approvals` 默认 1。
- `review_reviewers` 由人类在评审面板/设置分配；事件 `review.requested`；重复分配幂等。
- 无 reviewer 时 target 仍创建，gate 返回 `REVIEW_UNASSIGNED`，UI 引导分配；不自动批准。

### 7.2 评审任务 vs review request

- **P0 不创建新的 Task**：Task schema 没有 review 类型/owner 评审字段；用 `review_targets` + `review_reviewers` 表示待办。避免任务状态机污染。
- UI 在任务详情/团队页显示 review 待办；邮箱 `kind=review`。
- P1 可选：为 reviewer 创建 `review` 类型 Task（需要 kernel schema 扩展，非本设计 P0）；或复用 `task.status=review` 但仅当 `kernel.reviewPolicy=required`，需明确不与行级 target 混淆。

### 7.3 决策与 Q5

- `submitReview({taskId,decision,notes,headSha,reviewer})`：
  - 校验 target.headSha == headSha；否则 `REVIEW_STALE`。
  - `approve`：必须无 open/outdated blocker；所有 required reviewers 的 decision 已 approve；写 decision + target status `approved`（若 required approvals 达标）；事件 `review.decision` + `review.approved`。
  - `request_changes`：notes 必填；写 decision；target `changes_requested`；事件 `review.decision` + `review.changes_requested`（notes 只存 hash，正文入 decision/comment 表）。
  - `comment`：不改变 target 状态，仅 decision 记录（可选）。
- 同一 reviewer 同 head 重复 submit 幂等（返回旧 decision，不重复发事件）。
- **Q5**：
  - kernel review（任务完成）与 line review（合并前代码）独立；不自动同步。
  - 若 `kernel.reviewPolicy=required`，任务 owner 仍需 kernel approve；行级评审面板显示「任务评审：待/已通过」和「合并评审：…」，避免混淆。
  - `merge.approved` 的 actor 必须是 human merge captain/local user；reviewer 的 approve 不等于 merge approval；UI 需分别点击（或明确「评审通过」后合并按钮仍要求人工合并批准）。
  - 事件 `task.review_*` 与 `review.*`、`merge.*` 三套并存，审计可追溯。

### 7.4 审批计数与门禁

- `required_approvals` 默认 1，可配置 1–3；只统计 `reviewer_kind=human`、`role IN ('reviewer','merge_captain')`、同 head、decision=approve。
- `changes_requested` 任一 required reviewer ⇒ target `changes_requested`；需该 reviewer 重新 approve 或 reviewer 被移除（移除需 captain + 审计）。
- 如果 reviewer 同时是作者（Agent）→ 分配拒绝。
- 设置变更（required_approvals 降低）不追溯旧 head；仅对当前 head 生效，事件审计。

---

## 8. 合并门禁契约

### 8.1 Gate 接口

```ts
export interface ReviewGateInput {
  workspaceId: string;
  taskId: string;
  headSha: string;
  baseSha?: string | null; // null 仅 local/manual；gate 仍核对 target.base_sha
}
export type ReviewGateResult =
  | { ok: true; mode: "off"|"advisory"|"required"; targetId: string|null; warnings?: string[] }
  | { ok: false; mode: "required"; targetId: string|null; code: ReviewGateErrorCode; reason: string; blockers: number; approvals: number; requiredApprovals: number };

export type ReviewGateErrorCode =
  | "REVIEW_UNAVAILABLE"
  | "REVIEW_TARGET_MISSING"
  | "REVIEW_UNASSIGNED"
  | "REVIEW_PENDING"
  | "REVIEW_BLOCKED"
  | "REVIEW_CHANGES_REQUESTED"
  | "REVIEW_STALE";
```

### 8.2 与 Git 合并队列的接入点

1. `GitService.approve(taskId)`：
   - 取 queue item；`gate = reviewGate.evaluate({taskId, headSha:item.headSha})`；
   - `mode=required && !gate.ok` → 抛 `MergeReviewError(code)`；不写 `approved_head_sha`、不发 `merge.approved`。
   - `mode=advisory` 且 gate fail → 允许批准但写 `reviewGateWarning` 到事件/队列 `lastError`（UI 警告）。
   - `mode=off` → 旧行为。
2. `MergeQueue.processItem`：
   - 每次 refresh 后、checks 通过后调用 gate；失败 → state `waiting_review`（pending/blocked）或 `blocked`（unavailable/changes）并写 `merge.review_blocked`；
   - 不允许仅凭旧 `approved_head_sha` 合并；`approved` 与当前 head 相等 + gate pass 才 merging。
3. `mergeStart(taskId)`：
   - 重新 gate；失败抛 `REVIEW_*`；不启动 merging。
4. `GitService.createPr/finalize`：
   - 创建/刷新 PR 后 `ensureTarget`；target 创建失败不阻断任务完成（review 显示 unavailable），但 required 模式下 merge 会失败关闭。
5. `pr.updated`/`git.pushed`/`merge.approval_reset`：
   - `ensureTarget` 发现 head 变 → stale 旧 target、reanchor、清 `approved_head_sha`（若 queue 已批准）、清 checks_waived? checks 逻辑保持；队列回 waiting_review。
6. `ReviewService.submitReview(approve)` 不直接合并；仅把 target 置 approved + 事件。合并仍需 queue 的 `approve/mergeStart`。

### 8.3 队列状态映射

| Review gate | queue 状态 | UI |
|-------------|------------|----|
| mode off / advisory pass | 保持 checks 后状态，可 ready | review 区显示「不阻塞」/警告 |
| required + no target | `waiting_review` | 「评审未创建」+ 重试 |
| required + unassigned | `waiting_review` | 「分配评审人」 |
| required + pending/approvals<required | `waiting_review` | 「待评审 N/M」 |
| required + changes_requested | `waiting_review` | 「要求修改」 |
| required + open/outdated blocker | `waiting_review`（或 `blocked`） | 「blocker N」 |
| required + stale/unavailable | `blocked` | 「评审过期/不可用」 |
| pass + no merge approval | `waiting_review` | 合并批准按钮 |
| pass + approved_head_sha=head | ready → merging | 合并 |

**不新增 FSM 状态**，复用 `waiting_review`；`MergeQueueItem.review` 从 string 扩展为枚举 `none|pending|approved|changes_requested|stale|waived`，并新增只读 `reviewTargetId`/`reviewBlockers`/`reviewApprovals`（可选，P0 计算摘要）。

### 8.4 错误码

新增 `GitErrorCode`（`src/git/types.ts`）：

```
REVIEW_UNAVAILABLE | REVIEW_TARGET_MISSING | REVIEW_UNASSIGNED
REVIEW_PENDING | REVIEW_BLOCKED | REVIEW_CHANGES_REQUESTED | REVIEW_STALE
```

IPC/UI 映射：

- `REVIEW_BLOCKED` → 队列项「N 个 blocker 未解决」，按钮「去评审」；
- `REVIEW_CHANGES_REQUESTED` → 「评审要求修改」；
- `REVIEW_STALE` → 「有新提交，旧批准/评审已失效」；
- `REVIEW_UNAVAILABLE` → 「评审不可用（已降级）」，提供重试/诊断；required 下不合并。

### 8.5 Q5 / approved_head_sha 不变量

- `approved_head_sha` 只能由 human merge captain 在 review gate pass 后写入；**reviewer approve 不写它**。
- `review_decisions.head_sha == approved_head_sha == queue.head_sha` 三者必须一致才 merging；head 变则全部失效。
- `merge.approved` 事件 payload 增加 `reviewTargetId`/`reviewDecisionIds`（只 id），保持旧字段；旧 UI 可忽略。
- 如果 review mode 从 required 改为 advisory/off，现有 approved_head_sha 不清空？改配置事件审计，gate 立即按新配置；已写入的批准仍绑定 head；P0 建议改配置后要求重新批准（事件 `merge.approval_reset`），避免用旧批准绕过新门禁。

---

## 9. UI / UX

### 9.1 位置与导航

- **任务详情**（`src/App.tsx` 的 `task-detail-panel`）在 `TaskVcsPanel` 下方新增 `<ReviewSection taskId>`；与 VCS 同一滚动容器，不新增 Dock panel（D-R8）。
- 如果任务无 PR/head：空态「运行完成后创建 PR，再开始评审」。
- 深链：`#/tasks?t=<taskId>&review=1`；App deeplink 新增 `taskReview` 布尔，聚焦首个 diff/评审区（类似 `vcs=1`）；不新增 hash tab。
- 命令面板：新增「打开当前任务评审」；不新增顶层 tab。
- 团队页任务卡/详情可显示 `review: blockers/pending` 徽标；点击进入任务详情评审区。

### 9.2 布局（宽屏）

```
┌ 评审：task title  [待评审 2 blockers] [评审人 user] [刷新] ┐
│ 目标 head a1b2c3 · base main · 决策: 待评审 · 审批 0/1    │
├──────────────┬─────────────────────────────────────────────┤
│ 文件 (12)     │  diff: src/foo.ts  +12 -3                    │
│ ▸ src/foo.ts │  10  10  context ...                         │
│ ▸ src/bar.ts │  11     + added line      [评论]             │
│              │  12     - removed line                       │
│              │  thread: ● blocker  [resolve] [reply]        │
├──────────────┴─────────────────────────────────────────────┤
│ [要求修改] [批准]  备注：____________________  (sticky)     │
└────────────────────────────────────────────────────────────┘
```

- 文件树：按目录分组，显示 changes/±；支持过滤（全部/有评论/blocker/二进制）。
- Diff：行号 + 状态 + 文本；行 hover/focus 显示「评论」按钮（**非 hover-only**：focus/always for active row）；点击行打开 composer。
- 线程：在行下展开或右侧列表；默认 inline 3 条，展开全部；resolved/outdated 折叠。
- 底部 sticky 评审栏：状态、blocker 数、审批计数、备注、按钮；窄屏仍 sticky。
- 顶部状态：target head/base/decision/approvals；head 变化显示 banner + 「重新评审」。
- 评审人条：显示已分配 reviewer（pending/approved）和 required 数；人类可点「分配评审人」打开 Modal 选择 workspace human/可选 advisory agent；分配/移除写审计，不改变已提交 decision 直到 head 变化。P0 单人类默认 `user` 已预分配，不强制弹窗。
- 大 diff：顶部提示「已截断，单文件展开」；文件级懒加载；虚拟列表。

### 9.3 组件

| 组件 | 说明 |
|------|------|
| `ReviewSection` | 加载 target/summary；tabs? 不新增页签，section 内文件树+diff+线程+footer |
| `ReviewHeader` | 状态、head/base、审批、blocker、deep link |
| `ReviewerBar` | reviewer 分配/状态/required 数；人类操作 |
| `ReviewFileTree` | 目录/文件、过滤、键盘 roving |
| `UnifiedDiff` | 虚拟化行、hunk、行号、评论按钮、线程插槽 |
| `ReviewThread` | 根评论/回复、severity、resolve/reopen、Markdown |
| `ReviewComposer` | 行内/线程回复；textarea + severity（reviewer）+ 提交/取消 |
| `ReviewDecisionBar` | approve/request changes；备注；disabled reason；Modal 确认 |
| `ReviewBadge` | 任务卡/队列显示 pending/blocked |

复用 `Modal`（提交确认/大文本）、`Markdown`（评论，`skipHtml`）、`Toast`（成功/失败）、`EmptyState`、`StatusBadge`；不新增第三方 UI 依赖。

### 9.4 键盘与 ARIA

- 三页签不适用于评审；评审区不是一个 tabpanel，而是任务详情 section。
- Diff：
  - 行容器 `role="row"`，行号/内容 `role="gridcell"`；可见窗口 `aria-rowcount` + `aria-rowindex`；一次只有当前行 tabindex=0（roving）。
  - `ArrowUp/Down` 移动当前行；`Enter` 打开评论；`Esc` 关闭 composer；`Tab` 在线程/按钮间正常。
  - 评论按钮常驻于当前行/聚焦行，非 hover-only。
- 文件树 `role="tree"`/treeitem，`ArrowLeft/Right` 折叠/展开，`Enter` 打开文件。
- 线程列表 `role="list"`/`listitem`；resolve/reopen 按钮有 `aria-pressed`/`aria-expanded`；severity 与状态文本双编码（不只颜色）。
- 评审状态 `role="status" aria-live="polite"`；错误 `role="alert"`；删除/恢复用确认 Modal，焦点归还。
- 评审按钮 disabled 时有可见原因 + `aria-describedby` 指向原因（沿用 t107 模式）。
- 评论 Markdown 外链 `target=_blank rel=noreferrer`；禁止 raw HTML；提及不加通知副作用。

### 9.5 窄屏

- ≤900px：文件树折叠为 `<select>` + 当前文件头；diff 横向滚动；线程在行下全宽。
- ≤700px：评审栏纵向堆叠；按钮全宽/两列；diff 字号/行高可读；不隐藏 blocker 计数。
- 不新增固定侧栏；不依赖 hover；`prefers-reduced-motion` 关闭动画。
- 最小宽度 320；Dock single 变体下仍可用（任务详情已有滚动）。

### 9.6 错误/空态/文案

| 场景 | 文案 | 操作 |
|------|------|------|
| 无 PR/head | 运行完成后创建 PR，再开始评审 | 查看 Git 状态 |
| review unavailable | 评审系统不可用（<code>） | 重试/查看日志 |
| target missing (required) | 评审未创建，合并已暂停 | 重试创建/打开诊断 |
| pending | 待评审：0/1 批准 | 分配评审人 |
| unassigned | 尚未分配评审人 | 分配 |
| blocked | N 个 blocker 未解决 | 跳到首个 blocker |
| changes requested | 评审要求修改 | 查看评论 |
| stale/head changed | 有新提交，旧评审已失效 | 重新评审 |
| diff truncated | 大 diff 已截断 | 单文件展开/下载? P1 |
| empty threads | 暂无评论 | 选择行评论 |
| comment fail | 保存失败（原因） | 保留草稿/重试 |
| forbidden | 当前身份不能执行该评审操作 | 切换/请求评审人 |

---

## 10. API / IPC / 工具

### 10.1 领域类型（`src/review/types.ts`）

```ts
export type ReviewMode = "required" | "advisory" | "off";
export type ReviewSeverity = "nit" | "suggestion" | "issue" | "blocker";
export type ReviewThreadStatus = "open" | "resolved" | "outdated";
export type ReviewDecision = "approve" | "request_changes" | "comment";

export interface ReviewTarget {
  id: string; workspaceId: string; taskId: string;
  provider: string; prNumber: number | null; prUrl: string | null;
  baseBranch: string; baseSha: string; headSha: string; mergeBaseSha: string;
  diffHash: string; status: "pending"|"approved"|"changes_requested"|"stale"|"waived"|"unavailable";
  requiredApprovals: number; approvalCount: number; blockerCount: number;
  reviewers: ReviewReviewer[];
  createdAt: string; updatedAt: string;
}

export interface ReviewFile { path: string; oldPath: string|null; changeType: string; isBinary: boolean; isLfs: boolean; additions: number; deletions: number; truncated: boolean; }

export interface ReviewLine { kind: "context"|"add"|"del"; oldLine: number|null; newLine: number|null; text: string; hunk: number; }

export interface ReviewDiffPage { targetId: string; file: ReviewFile; lines: ReviewLine[]; offset: number; total: number; hasMore: boolean; }

export interface ReviewComment { id: string; threadId: string; authorId: string; authorKind: "human"|"agent"; body: string; createdAt: string; editedAt: string|null; deletedAt: string|null; }

export interface ReviewThread {
  id: string; targetId: string; filePath: string; oldPath: string|null; side: "new"|"old";
  lineStart: number; lineEnd: number; severity: ReviewSeverity; status: ReviewThreadStatus;
  anchorHeadSha: string; contextBefore: string[]; contextAfter: string[];
  createdBy: string; createdAt: string; resolvedBy: string|null; resolvedAt: string|null; resolutionNote: string|null;
  outdatedReason: string|null; comments: ReviewComment[];
}

export interface ReviewSummary {
  target: ReviewTarget; mode: ReviewMode;
  gate: ReviewGateResult;
}
```

### 10.2 IPC（`shared/ipc.ts`）

```ts
getReviewSummary(taskId: string): Promise<ReviewSummary>;
getReviewDiff(input: { taskId: string; file?: string; offset?: number; limit?: number }): Promise<ReviewDiffPage>;
getReviewThreads(input: { taskId: string; file?: string; status?: ReviewThreadStatus | "all" }): Promise<ReviewThread[]>;
createReviewThread(input: {
  taskId: string; filePath: string; side: "new"|"old"; lineStart: number; lineEnd?: number;
  body: string; severity: ReviewSeverity;
}): Promise<ReviewThread>;
replyReviewThread(input: { taskId: string; threadId: string; body: string }): Promise<ReviewComment>;
resolveReviewThread(input: { taskId: string; threadId: string; note?: string }): Promise<ReviewThread>;
reopenReviewThread(input: { taskId: string; threadId: string; note?: string }): Promise<ReviewThread>;
setReviewSeverity(input: { taskId: string; threadId: string; severity: ReviewSeverity }): Promise<ReviewThread>;
submitReviewDecision(input: {
  taskId: string; decision: ReviewDecision; headSha: string; notes?: string;
}): Promise<ReviewTarget>;
assignReviewer(input: { taskId: string; reviewerId: string; role: "reviewer"|"advisory" }): Promise<ReviewTarget>;
ensureReviewTarget(taskId: string): Promise<ReviewTarget>;
getReviewConfig(workspaceId: string): Promise<ReviewConfig>;
saveReviewConfig(workspaceId: string, patch: Partial<ReviewConfig>): Promise<ReviewConfig>;
```

- 全部校验 workspace/task 归属；review target 的 workspace 必须与 task 一致；拒绝跨 workspace。
- 读接口对同 workspace 成员开放；写/approve 按 §6.2；IPC 不返回 token/完整 patch 之外的内容。
- `getReviewDiff` 仅返回指定文件分页；`file` 缺省返回文件列表+第一个文件首屏；offset/limit clamp 1–500 行。
- `submitReviewDecision` 必须带 `headSha`，服务端与当前 target/queue 对比；不匹配 `REVIEW_STALE`。

### 10.3 工具（Agent）

P0 只读：

```ts
review.summary(taskId) -> ReviewSummary（无评论正文，仅状态/count/head）
review.threads(taskId, {file?, status?}) -> 线程正文（同 workspace，Agent 只读；不暴露他人私有? review 评论是团队可见）
```

- 不提供 approve/blocker/resolve/assign 工具；Agent 无法治理。
- 现有 `board.post`/`memo` 工具不变；review 摘要可被 Agent 读取。
- P1 可允许 Agent 提交 `suggestion` 评论，但不可 blocker/approve。

### 10.4 权限/错误

- `REVIEW_FORBIDDEN`：非 workspace 成员/作者尝试 approve/blocker；`REVIEW_STALE`：head 不匹配；`REVIEW_BLOCKED`：未解决 blocker；`REVIEW_LIMIT`：超长/超量；`REVIEW_NOT_FOUND`；`REVIEW_UNAVAILABLE`。
- IPC 返回 `{ok,error}` 的 mutation 统一；读接口抛错由 UI `formatError`。
- 审计事件 idempotency key 示例：`review:thread:create:{target}:{hash}`、`review:decision:{target}:{reviewer}:{head}`。

---

## 11. 事件、审计、通知、邮箱/黑板

### 11.1 事件目录（新增；zod/schemaVersion=2）

| type | aggregate | payload（无正文） | 幂等键 |
|------|-----------|-------------------|--------|
| `review.target_created` | task | `{targetId,taskId,headSha,baseSha,diffHash}` | `review:target:{taskId}:{headSha}:{baseSha}` |
| `review.requested` | task | `{targetId,reviewerId,role}` | `review:req:{targetId}:{reviewerId}` |
| `review.thread_created` | task | `{targetId,threadId,filePath,lineStart,severity}` | `review:thread:{targetId}:{threadId}` |
| `review.comment_added` | task | `{targetId,threadId,commentId,authorId}` | `review:comment:{commentId}` |
| `review.thread_resolved` | task | `{targetId,threadId,actor}` | `review:resolve:{threadId}:{at}` |
| `review.thread_reopened` | task | `{targetId,threadId,actor}` | `review:reopen:{threadId}:{at}` |
| `review.severity_changed` | task | `{targetId,threadId,from,to,actor}` | `review:sev:{threadId}:{at}` |
| `review.decision` | task | `{targetId,reviewerId,decision,headSha,blockerCount,approvals}` | `review:decision:{targetId}:{reviewer}:{head}` |
| `review.approved` | task | `{targetId,headSha,approvals,requiredApprovals}` | `review:approved:{targetId}:{head}` |
| `review.changes_requested` | task | `{targetId,headSha,reviewerId,notesHash}` | `review:changes:{targetId}:{head}:{reviewer}` |
| `review.stale` | task | `{targetId,oldHeadSha,newHeadSha,reason}` | `review:stale:{targetId}:{newHead}` |
| `review.reanchored` | task | `{targetId,threadId,fromLine,toLine,result}` | `review:anchor:{threadId}:{head}` |
| `review.gate_blocked` | task | `{targetId,headSha,code,blockers,approvals}` | `review:gate:{targetId}:{head}:{code}` |
| `merge.review_passed` | task | `{queueId,targetId,headSha}` | `merge:review-pass:{queueId}:{head}` |
| `merge.review_blocked` | task | `{queueId,code,blockers}` | `merge:review-block:{queueId}:{head}:{code}` |

- 事件 payload 只 id/枚举/计数/hash；评论正文绝不入事件。
- 事件 schema 注册到 eventRegistry；非法 payload 拒绝落库；`schemaVersion=2`。
- 事件 `review.decision` 是 gate 审计；`merge.approved` 保持原语义并增加 target/decision id。
- 编辑/删除评论：事件 `review.comment_edited`/`review.comment_deleted`（payload id/actor/hash，正文不入）。

### 11.2 通知

- **邮箱**：
  - `review.requested` → 每个 required reviewer 一条 `MessageKind='review'`，subject `[评审] <task title> · <head7>`，body 摘要（无 diff/全文），refs `task:<id>`、`pr:<n>`、`review:<target>`；去重 `(target,reviewer,head,event)`。
  - `review.changes_requested` → 任务 owner/作者（若 Agent 有邮箱）+ merge captain；阻塞摘要，不复制评论全文（可选 ≤500 字摘录，需 UI 明示）。
  - `review.approved` → owner + merge captain；`review.thread_created`（severity=blocker）→ owner + captain + reviewer；`review.stale` → reviewer/captain。
  - Agent 作者可通过邮箱收到；本地 human 用 UI badge/Toast，不注入邮箱。
- **黑板摘要**（可选，`review_config.board_summary=true`）：
  - target 进入 approved/changes_requested 时，向 `reviews` 域写一条 `decision`/`warning`，content 只含 task/head/决定/审批数/blocker 数/链接；refs 指向 target；不复制评论全文。
  - 通过 `MemoryService.postBoard(HUMAN)` 或当前 AppService.memory；避免直接写 memory 表。
- **去重/节流**：同 target/head/event/recipient 只发一次；outdated/stale 通知合并为一条；邮件正文脱敏（redactSecrets）。
- **通知不改变 gate**：邮件/黑板失败不阻断评审；审计事件记录失败原因（无正文）。

### 11.3 审计与隐私

- 审计事件无评论正文；正文只在 `review_comments`，受 workspace 权限保护。
- 导出/日志：只导出 id/枚举/计数/hash；评论导出需显式人类操作，含 PII 提示。
- 删除评论软删，审计保留 id/actor/time/hash；blocker 根评论禁止删除。
- 事件 `review.*` 进入 `getTaskTrace`，UI 显示摘要（如「新增 blocker @src/foo.ts:12」），不展开正文。

---

## 12. 安全

| 威胁 | 对策 |
|------|------|
| 评论 HTML/XSS | 评论按 Markdown 渲染，`skipHtml`；禁止 `dangerouslySetInnerHTML`；链接仅 http(s)/mailto；测试注入 `<script>`/`<img onerror>` |
| diff 注入 | diff 当纯文本行渲染；不解析 HTML；行号/路径转义；路径限制仓库相对 |
| token/secret 泄露 | diff/评论显示前 `redactSecrets`（ghp_/github_pat/Bearer/URL credential/token=）；事件/邮件不含正文；UI 提示「已脱敏」 |
| 作者自批 | 作者/Agent 不能 approve；required reviewer 必须显式分配；UI 服务端双重校验 |
| 作者自解 blocker | 作者不能 resolve/降级 blocker；只有 reviewer/captain |
| rebase 清 blocker | outdated blocker 仍 blocking，不自动 resolve；head 变化 decision stale |
| 旧批准合并新提交 | review target/decision 绑 head；gate 验 head；merge API 带 approved_head_sha；Git 既有 reset |
| 越权读 | 所有查询 workspace 过滤；IPC 校验 task/review 归属；review 评论同 workspace 可见，私有 memo 不受影响 |
| 事件/日志泄露 | payload 仅 id/计数/hash；body_hash 用于完整性，不能还原正文 |
| 恶意仓库 config | diff 命令禁用 ext-diff/textconv；hooksPath 隔离；只读 argv 白名单 |
| 大 diff DoS | 文件/总量/行数上限、截断、虚拟化、分页；超限不阻塞主线程 |
| 通知钓鱼 | 邮件/黑板只带受控摘要+task/PR 链接；不把评论当指令；review 内容是 untrusted data |
| 评审不可用绕过 | required 模式 fail-closed；error `REVIEW_UNAVAILABLE`；UI 显式降级，不静默合并 |

---

## 13. 性能与容量

- **diff 读取**：主进程 `execFile` 只读；10k 行解析 <300ms；100k 行拒绝整页；单文件 patch 64KB/2000 行，总 5MB/100k 行。
- **IPC**：只传当前文件分页（≤500 行/次）；文件列表 summary；线程按 target/file/status 查询；不传完整 patch 给 renderer 除非单文件展开。
- **UI**：虚拟列表窗口 ~80–120 行；`requestIdleCallback`/分帧渲染；文件树/线程分页；大 diff 横幅。
- **DB**：索引见 §4.1；blocker/approval 聚合查询 O(index)；线程列表分页 100；评论分页 50。
- **缓存**：target/diff per head；GC 合并/PR closed/TTL 30 天；reanchor 只在 head change 触发一次，异步 job（不阻塞 UI；required gate 等待新 target）。
- **通知**：每 target/head 最多 O(reviewers) 封邮件；去重；不因每次 comment 发邮件（P0 只发 requested/decision/blocker）。
- **目标**：任务详情首屏 <500ms（缓存命中）；1000 文件/100k 行不冻结；大 diff 有明确提示。

---

## 14. 迁移、兼容、回滚

### 14.1 迁移

1. 启动时 `new ReviewStore(store, {schemaVersion:1})`：创建 `review_schema`/表/索引；在事务内。
2. 为已有 Git workspace 插入 `review_config(mode='advisory')`（D-R7）；新建 workspace 在创建路径插入 `mode='required'`。
3. 不修改 `task_vcs`/`merge_queue` 现有列；`MergeQueueItem.review` 是 API 层扩展，旧 DB 行默认 `none`。
4. 旧事件 schemaVersion 保持 1；新事件 2；eventRegistry 注册。
5. 迁移失败：review unavailable；Git/任务/合并不受影响；`review.mode=required` 的 gate fail-closed；UI 显示错误与重试。
6. 备份：复用 Store `backupDatabase`/VACUUM；迁移前备份，保留恢复路径。

### 14.2 兼容

- Git design 的 `approved_head_sha`/FSM 不变；新增 gate 调用点在 `approve/process/mergeStart`，旧 UI 不传 review 仍工作（advisory/off）。
- 任务详情新增 section；不改路由顶层 tab；`vcs=1` 深链保持，新增 `review=1`。
- 旧 queue 行 `review` 默认 `none`；Dashboard 无需迁移。
- 代码回滚：feature flag `review.mode=off`；删除 review 表/模块即可恢复到旧合并；不含 kernel 变更。
- 数据保留：关闭不删评论/决策；重新启用可继续（head 变化会 stale）。
- `review.mode=off` 时 UI 仍可只读已有 review，但不显示“可合并”误导；明确「评审不阻塞」。

### 14.3 回滚步骤

1. 设置 `review.mode=off`（人类，审计）。
2. 回滚代码/部署；`approved_head_sha` 行为恢复旧逻辑。
3. `review_schema` 表保留（数据可恢复）；30 天后可手动清理（先导出）。
4. 若迁移导致启动失败，使用迁移前备份恢复；不自动 drop。

---

## 15. 测试策略与 AC

### 15.1 分层

- **unit**：diff parser/rename/binary/truncate、anchor/reanchor、store CRUD/索引/事务、gate 计数、权限、事件 schema。
- **integration**：临时 git repo + bare remote；创建 target/评论/approve/head change；merge queue mock provider；checks；reanchor；DB 迁移 v0→v1。
- **UI**：SSR/React test renderer + mock window.deer；任务详情 ReviewSection、文件树、diff 行、线程、footer、错误/空态/ARIA/窄屏；无 Monaco。
- **security**：XSS payload、markdown、URL、token、越权、作者自批/自解、rebase 清 blocker。
- **performance**：20k/100k 行 fixture；首屏/解析/虚拟化；不阻塞测试。

### 15.2 AC

| ID | 验收 | 方式 |
|----|------|------|
| AC-RV-01 | `review_schema` 创建/迁移幂等；独立于 kernel/git schema；旧库升级不丢数据 | integration |
| AC-RV-02 | 已有 workspace 迁移 `advisory`，新建 `required`；off/advisory/required gate 行为分别正确 | unit/integration |
| AC-RV-03 | target 唯一 `(task,head,base)`；`base_sha/merge_base/diff_hash` 一致；重复 ensure 幂等；base 前进同 head 生成新 target 并 stale 旧 target | unit |
| AC-RV-04 | head 变化 → 旧 target stale、decision 失效、队列回 waiting_review、事件 `review.stale` | integration |
| AC-RV-05 | unified parser 覆盖 add/del/context/rename/delete/binary/LFS/`\ No newline` | unit |
| AC-RV-06 | 大 diff 截断/分页/总量限额；超限不阻塞主线程；UI 显示截断提示 | unit/integration |
| AC-RV-07 | 线程创建/回复/编辑软删/解决/重开；评论正文不入事件 | unit |
| AC-RV-08 | severity：blocker 只能 reviewer/captain 创建/升级；作者不能降级 | unit |
| AC-RV-09 | 未解决 blocker（含 outdated）→ gate `REVIEW_BLOCKED`；解决后通过 | unit/integration |
| AC-RV-10 | 作者不能 approve/解决 blocker；Agent 不能 approve/blocker；越权返回 `REVIEW_FORBIDDEN` | unit |
| AC-RV-11 | required_approvals=1/2；approved 计数、changes_requested 阻断、重复决策幂等 | unit |
| AC-RV-12 | approve 绑 head；head 不匹配 `REVIEW_STALE`；旧 decision 不能用于新 head | unit |
| AC-RV-13 | mergeQueue.approve 在 required gate 未过时拒绝，不写 `approved_head_sha`、不发 `merge.approved` | integration |
| AC-RV-14 | gate pass + merge captain approve 后 `approved_head_sha=head`；reviewer approve 不写 merge approval（Q5） | integration |
| AC-RV-15 | checks+review 双门禁；checks pass 但 review blocked 不 merging；review pass 但 checks fail 不 merging | integration |
| AC-RV-16 | head/base 变化同时清 `approved_head_sha`/review decision/线程锚点；reanchor moved/outdated 正确 | integration |
| AC-RV-17 | reanchor 失败 → outdated；blocker 仍阻止；不自动 resolve | unit |
| AC-RV-18 | review unavailable 且 required → fail-closed `REVIEW_UNAVAILABLE`；advisory/off 不受影响 | integration |
| AC-RV-19 | 事件 zod/schemaVersion=2；非法 payload 不落库；事件无正文；audit 可查 | unit |
| AC-RV-20 | 邮箱：requested/decision/blocker 去重、脱敏、refs 正确；notify 失败不阻断 | unit |
| AC-RV-21 | 黑板摘要：approved/changes_requested 写 decision/warning，仅摘要+refs，不复制全文 | integration |
| AC-RV-22 | UI SSR：header/文件树/diff/线程/footer/空态/错误/aria-live；无 Monaco bundle | SSR |
| AC-RV-23 | 键盘：行 roving/Arrow/Enter/Esc、文件树、线程、Modal 焦点归还；ARIA 断言 | component |
| AC-RV-24 | 窄屏（320/700/900）文件树/横向 diff/sticky footer；无 hover-only | component/manual |
| AC-RV-25 | Markdown XSS/HTML/链接/secret 脱敏；diff 纯文本渲染 | unit |
| AC-RV-26 | 大 diff 20k 行 UI 虚拟化；100k 拒绝/提示；解析时间目标 | integration/perf |
| AC-RV-27 | 迁移失败/回滚：review unavailable、off 恢复旧合并、备份可恢复 | integration |
| AC-RV-28 | 深链 `#/tasks?t=&review=1`/命令面板；不新增 Dock panel；现有 tasks 面板不回归 | unit/manual |
| AC-RV-29 | Git/队列/任务既有测试全绿；`pnpm typecheck/build/test` | 三命令 |

### 15.3 夹具

- `fixtures/review/`：临时 git repo 脚本（base/main、feature 分支、rename/delete/binary/large diff/rebase）；`review-patches/*.patch` 固定 parser 用例；`xss.md`；`large.diff` 生成器。
- 测试不访问网络：provider mock；邮件/黑板 mock；DB 临时目录；真实 GitExec 本地 bare remote。
- UI mock `window.deer.review.*`；SSR + react-test-renderer（现有依赖），不新增 jsdom/RTL。

---

## 16. 文件影响面、阶段与工作量

### 16.1 新增/修改文件

| 路径 | 变更 | 说明 |
|------|------|------|
| `src/review/types.ts` | 新增 | 类型/错误码/DTO |
| `src/review/store.ts` | 新增 | review_schema 迁移/DAO/事务 |
| `src/review/diff.ts` | 新增 | git diff/parse/hash/truncate |
| `src/review/anchor.ts` | 新增 | thread anchor/reanchor |
| `src/review/service.ts` | 新增 | target/thread/decision/permission |
| `src/review/gate.ts` | 新增 | ReviewGate |
| `src/review/notifications.ts` | 新增 | mailbox/board/dedupe |
| `src/review/events.ts` | 新增 | review event registry |
| `src/review/ui/ReviewSection.tsx` | 新增 | 任务详情评审区 |
| `src/review/ui/UnifiedDiff.tsx` | 新增 | 行渲染/虚拟化 |
| `src/review/ui/ReviewThread.tsx` | 新增 | 线程/评论 |
| `src/review/ui/ReviewDecisionBar.tsx` | 新增 | approve/request changes |
| `src/shared/ipc.ts`/`preload`/`main` | 改 | review IPC |
| `src/App.tsx` | 改 | 任务详情插槽、深链 `review=1`、Toast/Modal |
| `src/shared/deeplink.ts` | 改 | `taskReview` 参数/测试 |
| `src/shell/dock/panelRegistry.ts` | 不改（保持 tasks） | 明确无新 panel |
| `src/git/gitService.ts`/`mergeQueue.ts`/`types.ts`/`events.ts` | 改 | gate 接入、`MergeQueueItem.review` 扩展、merge review 事件 |
| `src/kernel/service.ts` | 改（最小） | 构造 ReviewService/Gate，传入 GitService；不改进程 review 状态机 |
| `src/styles.css` | 改 | review 样式/窄屏/token |
| `tests`/`fixtures/review/` | 新增 | 上述 AC |
| `docs/team/line-review-design.md` | 本文件 | 设计基线 |

> 若实现要改 `src/kernel/service.ts`，需在任务 scope 中显式声明；本设计不要求改 `src/kernel/execution/`、`store.ts`、memory。

### 16.2 阶段

| 阶段 | 内容 | 依赖 | 工作量 |
|------|------|------|--------|
| R0 | 本设计评审通过 | t98/t123 | 0.5 人日 |
| R1 | review schema/store + diff provider/parser + target/head binding | Git | 2 人日 |
| R2 | threads/comments/blocker + permissions + audit | R1 | 2 人日 |
| R3 | gate + Git queue/merge approval + Q5 契约 | R1/R2 | 1.5 人日 |
| R4 | UI ReviewSection/diff/thread/footer/ARIA/窄屏 | R1/R2 | 3 人日 |
| R5 | notifications/mailbox/board + migration/rollback + AC/tests | R3/R4 | 2 人日 |
| 合计 | P0 | | **≈11 人日** |

- P1：Monaco lazy split、suggestions/apply、GitHub inline review 导入/同步、多 reviewer 分配 UI、captain override、review task、性能优化。
- 可并行：R1/R4 UI 用 mock API；R2/R3 后端；但合并前必须统一 DTO。

### 16.3 非目标（再次）

- 不做代码编辑、自动应用建议、AI 自动评审/批准。
- 不做 GitHub/GitLab 原生行内评论双向同步（P1）。
- 不做多 PR/堆叠、跨仓库、非 Git 评审。
- 不新增 Dock 面板/顶层 tab；不替换 kernel review。
- 不引入新大依赖（Monaco 除外，P1 才评估）。

---

## 17. 风险、开放问题、决策记录

### 17.1 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| 默认 required 阻断既有合并 | 中 | D-R7 迁移 advisory；新 workspace required；UI 提示/设置 |
| 大 diff 卡 UI/主进程 | 中 | 截断/分页/虚拟化/上限；性能 AC |
| rebase 后评论漂移/blocker 丢失 | 高 | anchor/reanchor/outdated 仍 blocker；不自动 resolve；测试 |
| 旧批准合并新提交 | 高 | target/decision 绑 head；gate 验 head；复用 Git reset；AC-RV-04/12/16 |
| review 服务不可用导致无法合并 | 中 | fail-closed + 明确错误 + mode off 人类开关；不是静默放行 |
| 作者绕过 blocker | 高 | 作者不能 resolve/降级；权限服务端；audit |
| XSS/secret | 高 | skipHtml/纯文本 diff/redact/测试 |
| 通知风暴/重复 | 低 | 去重/节流；只关键事件 |
| 数据/迁移失败 | 中 | 独立 schema/备份/回滚；review unavailable 不破坏 Git |
| 与 kernel review UI 混淆 | 中 | 两个状态分开展示/Q5 文案；不自动同步 |

### 17.2 开放问题（需 Captain/设计裁决）

1. **review.mode 默认**：本设计 D-R7（已有 advisory/新建 required）是否接受？还是所有 Git workspace 默认 required？
2. **P0 reviewer 身份**：单用户应用是否固定 `user` 为 required reviewer，还是先支持 agent advisory + human local？本设计默认 local human。
3. **blocker outdated 是否继续阻断**：本设计选“是”（D-R11）；若团队更倾向不阻断，需要显式“仍适用”确认。
4. **是否 P0 支持多 required approvals**：本设计 API 支持 1–3，默认 1；UI 先 1。
5. **Q5 是否在 kernel review 与 line review 之间做联动**：本设计不自动联动；P1 可把 line approve 作为 kernel review 的提示。
6. **P0 是否允许评论编辑/删除**：本设计软删；blocker 根评论不可删除。
7. **review.mode=off 时是否仍显示 blocker**：本设计显示但标“不阻塞”。
8. **通知是否默认邮件**：本设计 requested/decision/blocker 默认邮件；可配置。
9. **P0 是否支持 GitHub 原生 review 导入**：本设计不做，P1。
10. **merge captain 与 reviewer 是否可为同一人**：允许（人类），但 reviewer 不能是 Agent 作者；若 captain 同时 reviewer，仍需两次独立操作（review approve + merge approve）。

### 17.3 决策记录

- 本设计继承 Git D13：行级评审接入同一 merge gate；`approved_head_sha` 不变。
- 继承 Q5：不复用 kernel review；独立审计。
- 继承 DESIGN §5.6/§8：Monaco 理想但 P0 用统一 diff；不新增 Dock panel。

---

## 18. 附录

### A. Re-anchor 算法

```
reanchorThreads(oldTarget, newTarget):
  oldDiff = files(oldTarget); newDiff = files(newTarget)
  for thread in open/resolved threads:
    oldFile = oldDiff[thread.filePath or oldPath]
    newFile = newDiff.byPath(thread.filePath) ?? newDiff.byOldPath(oldPath)
    if !newFile: mark outdated("file_deleted"); continue
    if thread.anchorHeadSha == newTarget.head: continue
    if !oldFile: mark outdated("old_diff_missing"); continue
    mapping = diffHunks(oldFile, newFile)  // old line -> new line
    if mapping has thread.lineStart:
       update lineStart/lineEnd/anchorHeadSha/context; result=moved
    else if uniqueContextMatch(newFile, contextBefore, contextAfter):
       update; result=moved
    else:
       mark outdated("ambiguous_context"); result=outdated
    append review_reanchor_log; emit review.reanchored
    // status unchanged; blocker remains blocking
```

- 唯一 context 匹配：3 行上下文（before/after）在 new file 中只出现一次；重复则 outdated。
- `resolved` 线程也 reanchor（保留历史），但不影响 gate；`outdated` blocker 继续 gate。
- 不做跨文件 rename 自动映射，除非 `--find-renames` 明确 old/new path。

### B. Diff 截断策略

| 层级 | 上限 | 超限行为 |
|------|------|----------|
| 单文件 patch | 64KB / 2000 行 | `truncated=1`，保留前 N 行；UI「展开」请求剩余分页（若可重新读取） |
| 单 target 总量 | 5MB / 100k 行 | target `unavailable`? 否：返回文件列表 + 部分文件；UI 提示；gate 仍可评审（若 target 可用） |
| 单文件二进制/LFS | 0 行 | 只显示路径/大小；不阻止评论（文件级评论 P1） |
| IPC 单次 | 500 行 | 分页 |

- 截断不影响 target/diff_hash（对完整 patch 计算）；UI 显示 `truncated` 与「评论仅对可见行」。
- 大 diff 仍允许 approve/blocker（评审人可选择文件），但必须看到至少文件列表/统计；P0 不强制逐行。

### C. API 错误示例

```json
{ "ok": false, "error": { "code": "REVIEW_BLOCKED", "message": "2 blocker threads unresolved" } }
```

```json
{ "ok": false, "error": { "code": "REVIEW_STALE", "message": "head changed: expected a1b2, got c3d4" } }
```

### D. UI 关键文案

- 「合并评审」不是「任务评审」；任务 review 状态由 kernel 控制。
- `blocker` 中文「阻断」；`nit`「小问题」；`suggestion`「建议」；`issue`「问题」。
- 不把评论内容当指令；diff 是 untrusted data（与 memory/context 原则一致）。

---

## 19. 交付检查清单

- [x] Monaco diff/统一 diff 取舍、SHA 绑定、rebase re-anchor（§5）
- [x] 行内评论/线程/解决/blocker、阻止合并（§6/§8）
- [x] 评审人/Q5 独立批准/PR/队列/checks/approved_head_sha 契约（§7/§8）
- [x] 持久化/审计/权限/通知/邮箱/黑板（§4/§11/§12）
- [x] UI 任务详情 Diff/评审/线程/键盘/ARIA/窄屏，不新增 Dock panel（§9）
- [x] 迁移/回滚/性能/安全/测试夹具/AC（§12–§15）
- [x] 文件影响面/阶段/非目标（§16/§17）
- [x] 只读代码/文档，未改实现代码

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

