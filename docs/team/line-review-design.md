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
| D-R6 | **作者严格 = `task.ownerId` 且仅当它是 Agent**；作者不能批准自己的变更；**人类 requester/提交者不是作者，自评是显式例外**；Agent 不能批准/开 blocker/resolve blocker；人类评审人必须属于同一 workspace | P0 人类治理；单用户应用默认本地人类 `user` 为评审人 |
| D-R7 | **默认 rollout：已有 workspace 迁移为 `advisory`，新建 workspace 为 `required`**；UI 显式提示，可切换 | 不突然阻断既有合并；团队模式推荐 required，新项目默认强制 |
| D-R8 | **不新增 Dock 面板**；评审区嵌在任务详情，panel key 仍为 `tasks`；深链 `#/tasks?t=&review=1` | DESIGN §8 右栏/任务详情；C09 六 tab 约束；减少布局回归 |
| D-R9 | **diff 解析/缓存放在主进程**；渲染层只拿分页后的行和线程，不把整仓库 patch 过 IPC | 大 diff、安全边界、主进程可取 git 数据；渲染层保持轻量 |
| D-R10 | **review 表独立 `review_schema`**，不修改 kernel/Git schema；配置 1:1 workspace | 与 Git `git_schema`/memory `memory_schema` 同模式；迁移可独立回滚 |
| D-R11 | **head 变化使旧 decision 失效**；线程自动 re-anchor，不能确定时 `outdated` 且 blocker 仍需人工确认 | 防止旧批准合并新提交；不丢评论、不静默放行 blocker |
| D-R12 | **人类可显式关闭门禁**（`review.mode=off`）或配置 required；P0 不做“行级评审豁免合并”的隐形通道。P1 才考虑 captain override + 审计 | 保留逃生口，但必须显式、可审计，不能成为 Agent 路径 |
| D-R13 | **decision 是“每 reviewer/head 的最新值 + 追加修订历史”**；新 decision 覆盖当前值但不删除旧行；`request_changes→approve`、`comment→approve` 均允许；reviewer 可移除/替换并使其当前 decision 失效 | 评审意见会变化；不能把旧 `changes_requested` 永久锁死，也不能静默丢历史 |
| D-R14 | **作者严格定义为 `task.ownerId` 且仅当它是 Agent**；target 快照 `authorAgentId`；人类提交者/requester 不是作者，可评审；ownerId 缺失时作者为 null，人类可评、Agent 不可决定 | 单用户应用没有多账号；必须防止 Agent 自批，同时避免把人类提交者误判为作者 |
| D-R15 | **P0 禁止 Agent 写评论**（含 advisory）；Agent 只有只读 summary/threads 工具；不引入 `allow_agent_comments` 开关 | 评审治理是人类职责；降低权限/注入面；P1 再评估 suggestion-only |
| D-R16 | **P0 不提供 review waiver**；`review.mode=off` 是配置回滚，不是 waived 状态；`MergeQueueItem.review` 不出现 `waived` | 避免“豁免评审”的隐形合并通道；checks waiver 与本门禁无关 |

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
- **P0 的 `required_approvals` 固定为 1**（单一本地 human）；多 human reviewer/多 approvals 属 P1，不进入 P0 API/UI/AC。

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
  required_approvals INTEGER NOT NULL DEFAULT 1 CHECK (required_approvals = 1), -- P0 固定 1；P1 放宽
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
  author_agent_id TEXT,                         -- task.ownerId 仅当 owner 是 Agent；人类/缺失为 NULL
  requester_id TEXT NOT NULL,                   -- 发起评审的 human/agent（不是作者）
  requester_kind TEXT NOT NULL,                 -- human | agent
  provider TEXT NOT NULL,                       -- github | manual | local
  pr_number INTEGER,
  pr_url TEXT,
  base_branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,                       -- merge-base / base head at creation
  head_sha TEXT NOT NULL,
  merge_base_sha TEXT NOT NULL,
  diff_hash TEXT NOT NULL,                      -- sha256(canonical patch)
  status TEXT NOT NULL,                         -- pending|approved|changes_requested|stale|unavailable
  required_approvals INTEGER NOT NULL DEFAULT 1 CHECK (required_approvals = 1), -- P0 固定 1
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
  status TEXT NOT NULL,                         -- requested|approved|changes_requested|removed
  assigned_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  removed_at TEXT,
  removed_reason TEXT,
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
  context_before TEXT NOT NULL DEFAULT '[]',   -- JSON string array，≤3 行，每行 ≤500 字
  context_after TEXT NOT NULL DEFAULT '[]',    -- JSON string array，≤3 行，每行 ≤500 字
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
  revision INTEGER NOT NULL DEFAULT 1,           -- 同 target/reviewer/head 递增
  is_current INTEGER NOT NULL DEFAULT 1,         -- 仅最新修订参与 gate
  supersedes_id TEXT,                            -- 被覆盖的旧 decision id
  invalidated_at TEXT,
  invalidated_reason TEXT,                       -- head_changed|reviewer_removed|config_changed
  client_request_id TEXT,                        -- 幂等提交 id
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_decision_current
  ON review_decisions(target_id, reviewer_id, head_sha) WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_review_decision_history
  ON review_decisions(target_id, reviewer_id, head_sha, revision DESC);
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
- `author_agent_id`：创建 target 时从 `task.ownerId` 快照，**仅当 owner 是 Agent**；人类 owner 或 ownerId 缺失时为 `NULL`。作者校验只比较 `reviewer_id == author_agent_id`，不推断邮箱 sender；人类 requester/提交者可评审。迁移时回填已有 target；ownerId 缺失记 `review.author_unknown` 警告，人类仍可评，Agent 决策一律拒绝（P0 本来也不允许）。
- `requester_id`/`requester_kind`：发起评审的人/Agent；用于通知/审计，不参与作者判定。人类 requester 不因此成为作者，可自评。
- `diff_hash`：对文件列表 + patch 规范化后的 SHA-256；线程/decision 冗余保存，检测错配。
- `blocker_count`：`severity='blocker' AND status IN ('open','outdated')` 的数量；outdated blocker 仍计（见 §6.4）。
- `status`：`approved` 需所有 required approvals 且 0 blocker；`changes_requested` 任一 reviewer 当前 `request_changes`；`stale` head/base 变化或无法 reanchor；`unavailable` diff 失败。P0 **没有 `waived`**；关闭门禁用 `review.mode=off`。
- `review_decisions`：**追加修订**。同一 reviewer/head 每次提交插入新行 `revision+1`，旧行 `is_current=0`；只把 `is_current=1` 参与 gate/计数。`supersedes_id` 指旧行，`invalidated_reason` 记录 head_changed/reviewer_removed/config_changed；历史永不删除。
- 评论正文是事实源；事件/邮箱/黑板只带 id/摘要。`body_hash` 用于审计完整性，不用于内容回放。
- `review_reviewers.reviewer_id`：本地人类固定 `user`；Agent 可 `agent:<id>` 但 P0 只能 `advisory` 且**只读**，不能评论/决定。`removed` reviewer 保留行，`removed_at/reason` 审计；移除后其当前 decision 失效。
- `context_before/context_after`：TEXT 存 **JSON 字符串数组**（不是 JSONB），store 层 `JSON.stringify`/`JSON.parse`；解析失败回退 `[]`，写入前 clamp ≤3 行、每行 ≤500 字。用于 re-anchor 唯一匹配。
- 索引支持：按 target 拉线程、按 blocker 查询、按 reviewer 找待办；所有查询 `workspace_id` 过滤（owner 隔离）。

### 4.3 事务边界

- `createThread`：thread + first comment + event outbox 同一事务；失败全部回滚。
- `submitDecision`：校验 gate 条件 + decision + 当前值切换 + target 状态 + `review.decision` 事件同一事务；重复请求按 `client_request_id` 或 `(target,reviewer,head,revision)` 幂等返回旧记录；新修订覆盖 `is_current` 但不删除历史。
- `removeReviewer`/`replaceReviewer`：reviewer 状态 + 当前 decision 失效 + target 重算 + 事件同事务；移除 required reviewer 后 target 回到 pending，queue 回 `waiting_review`。
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

#### 5.5.1 可执行数据源

对每个旧线程：

1. 从 `review_threads` 取 `file_path/old_path`、`side`、`line_start/line_end`、`context_before/context_after`（JSON）、`anchor_head_sha`。
2. 用 `git diff --name-status -z -M <oldHead> <newHead>` 得到 rename/delete/type 映射；R/C 记录 old/new path；D 直接 outdated。
3. 读取旧/新文件完整文本（仅行号索引，不加载大文件全文到内存超过阈值）：
   - `git cat-file -p <oldHead>:<oldPath>`
   - `git cat-file -p <newHead>:<newPath>`
   - 二进制（NUL）或 > `maxReviewFileBytes`（默认 1 MB）→ `outdated("binary_or_too_large")`。
4. 用 `git diff -U3 <oldHead>..<newHead> -- <oldPath> <newPath>` 解析 hunk；hunk 的 old/new 起始行提供候选偏移。
5. 上下文：优先使用已存 `context_before/after`（≤3 行）；缺失时从旧 blob 取 `line_start` 前后各 3 行。

#### 5.5.2 算法伪代码

```ts
function reanchorThread(thread, oldHead, newHead): ReanchorResult {
  const map = renameMap(oldHead, newHead);           // git diff --name-status -z -M
  const newPath = map.newPath(thread.filePath, thread.oldPath);
  if (!newPath) return { result: "outdated", reason: "file_deleted" };

  const oldBlob = readBlob(oldHead, thread.oldPath ?? thread.filePath);
  const newBlob = readBlob(newHead, newPath);
  if (!oldBlob || !newBlob) return outdated("blob_missing");
  if (oldBlob.isBinary || newBlob.isBinary) return outdated("binary");
  if (oldBlob.tooLarge || newBlob.tooLarge) return outdated("too_large");

  // 1) 精确行 + 上下文在 new 完整文件中唯一匹配
  const oldLine = oldBlob.lines[thread.lineStart - 1];
  if (oldLine == null) return outdated("old_line_missing");
  const before = thread.contextBefore.length ? thread.contextBefore : oldBlob.lines.slice(max(0, thread.lineStart - 4), thread.lineStart - 1);
  const after = thread.contextAfter.length ? thread.contextAfter : oldBlob.lines.slice(thread.lineStart, thread.lineStart + 3);
  const candidates = [];
  for (let j = 0; j < newBlob.lines.length; j++) {
    if (newBlob.lines[j] !== oldLine) continue;
    if (!matchBefore(newBlob.lines, j, before)) continue;
    if (!matchAfter(newBlob.lines, j, after)) continue;
    candidates.push(j + 1);
  }
  if (candidates.length === 1) {
    return { result: "moved", line: candidates[0], reason: "unique_context" };
  }
  if (candidates.length > 1) return outdated("ambiguous_context");

  // 2) 提交级 hunk 偏移：旧行落在 -U3 hunk 的 context/add/del 范围
  const hunks = parseHunks(gitDiffUnified3(oldHead, newHead, oldPath, newPath));
  for (const hunk of hunks) {
    if (thread.lineStart < hunk.oldStart || thread.lineStart >= hunk.oldStart + hunk.oldCount) continue;
    const mapped = mapHunkLine(hunk, thread.lineStart); // context -> newStart + delta; add/del -> null
    if (mapped != null && newBlob.lines[mapped - 1] === oldLine) {
      return { result: "moved", line: mapped, reason: "hunk_offset" };
    }
    return outdated("line_changed");
  }
  return outdated("not_found");
}
```

- `unique_context` 优先于 hunk 偏移，避免“相邻多行相同”误映射。
- `mapHunkLine` 只对 **context 行**做偏移；旧行是 `-` 删除行 → `outdated("line_deleted")`；`+` 新增行不属于旧 anchor。
- 线程范围 `lineStart..lineEnd` 映射后必须连续且不越界；否则 outdated。
- 匹配是 **old head 线程 → new head**；base 前进（head 不变）同样执行，使用旧/新 target 的 diff/blob。
- 任何不确定（重复上下文、rename 目标歧义、二进制/大文件、文件删除、blob 缺失）→ `outdated`，不猜。

#### 5.5.3 失败分类

| 情况 | 结果 |
|------|------|
| 文件 rename，new 路径存在 | 按 new path 继续；identity 保留 |
| 文件删除 / 二进制 / >1MB / blob 缺失 | `outdated` |
| 旧行删除（`-`） | `outdated("line_deleted")` |
| 上下文重复（多个候选） | `outdated("ambiguous_context")` |
| hunk 映射越界/不连续 | `outdated("line_changed")` |
| 旧行在新文件原文唯一且上下文匹配 | `moved`（更新行/head/context） |
| head 不变、base 前进 | 对 oldTarget→newTarget 跑同一算法；decision 仍因 base 变化 stale |

#### 5.5.4 Fixtures（必须覆盖）

| fixture | 期望 |
|---------|------|
| rebase 后旧行下移 +2，上下文仍唯一 | `moved` +2 |
| rename `src/a.ts → src/b.ts` | 用 newPath，行不变/moved |
| base 前进但 head 不变 | 新 target；旧 decision stale；线程按新 diff re-anchor |
| 删除旧行（`-`） | `outdated("line_deleted")`，blocker 仍阻止 |
| 同文件相同上下文出现 2 次 | `outdated("ambiguous_context")`，不猜 |
| 文件删除 / 二进制 / >1MB | `outdated`，线程保留 |
| rebase 改了上下文但行号碰巧相同 | 不能只按行号；必须上下文/唯一匹配，否则 outdated |

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

| 操作 | 任务作者（Agent） | 人类 requester/提交者 | 分配评审人（human） | Merge captain（human） | 其他 human 成员 |
|------|-------------------|------------------------|----------------------|------------------------|-----------------|
| 查看 diff/线程 | ✅（只读 tool/摘要） | ✅（同 workspace） | ✅ | ✅ | ✅ |
| 新建评论/回复 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 新建 nit/suggestion/issue | ❌ | ✅ | ✅ | ✅ | ✅ |
| 编辑/软删自己的评论 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 删除他人评论/blocker 根评论 | ❌ | ❌ | ❌ | ✅（仅 captain，审计） | ❌ |
| 新建/升级 blocker | ❌ | ❌ | ✅ | ✅ | ❌ |
| 解决 blocker | ❌（防自解） | ❌（非 reviewer 不能解） | ✅（创建者/评审人） | ✅ | ❌ |
| 解决 nit/suggestion | ❌ | ✅（自己的线程） | ✅ | ✅ | ✅ |
| 提交 approve/request_changes | ❌ | ✅（被分配且非 Agent 作者） | ✅ | ✅ | ❌（未分配） |
| 修改 severity | ❌ | ❌ | ✅ | ✅ | ❌ |
| 分配/移除/替换 reviewer | ❌ | ❌ | ❌（需 captain） | ✅ | ❌ |

- **P0 禁止 Agent 评论**（D-R15）：Agent 作者/Agent advisory 均只读；`review_comments.author_kind` 保留 `agent` 仅用于历史/P1，P0 service 拒绝 `author_kind=agent` 写入（`REVIEW_FORBIDDEN`）。
- 作者严格定义为 `task.ownerId` 且仅当 owner 是 Agent；**人类 requester/提交者不是作者，自评是显式例外**。人类 requester/提交者被分配后可评审/评论；ownerId 缺失时 `author_agent_id=NULL`，人类可评、Agent 仍只读；审计 `review.author_unknown`。
- `review.mode=off` 时人类仍可只读/评论，但 UI 明示「当前评审不阻塞合并」；Agent 仍只读；`off` 不隐藏已有数据。

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

### 7.1 身份、作者与分配

- P0 人类身份：`reviewer_id='user'`（本地人类）；Agent 成员 `agent:<id>` 可被分配为 `advisory`，**只读**，不能评论/approve/blocker。P1 多用户 human id。
- **作者（author）= `task.ownerId` 且仅当 owner 是 Agent**；target 创建时快照到 `review_targets.author_agent_id`。人类 owner 或 ownerId 缺失时 `author_agent_id=NULL`：人类 requester/提交者可被分配评审，Agent 仍不能决定。服务端权限只基于该快照 + `reviewer_id`，不信任 UI/邮箱 sender。**本设计选择第二种方案**：不新增 `Task.createdBy`，作者定义严格绑定 ownerId Agent；`requester_id/requester_kind` 只在 target 快照发起人，不参与作者判定。
- 默认 reviewer：
  1. `review_config` 指定 human reviewer（P1 多用户）；
  2. `merge_captain` 若为 human；
  3. 本地 `user`。
- `review_reviewers` 由人类在评审面板/设置分配；事件 `review.requested`；重复分配幂等。`requester_id` 记录发起人，不参与作者判定。
- 无 reviewer 时 target 仍创建，gate 返回 `REVIEW_UNASSIGNED`，UI 引导分配；不自动批准。
- 移除/替换 reviewer 见 §7.5；移除后其当前 decision 失效，target 重算并回 `waiting_review`。

### 7.2 评审任务 vs review request

- **P0 不创建新的 Task**：Task schema 没有 review 类型/owner 评审字段；用 `review_targets` + `review_reviewers` 表示待办。避免任务状态机污染。
- UI 在任务详情/团队页显示 review 待办；邮箱 `kind=review`。
- P1 可选：为 reviewer 创建 `review` 类型 Task（需要 kernel schema 扩展，非本设计 P0）；或复用 `task.status=review` 但仅当 `kernel.reviewPolicy=required`，需明确不与行级 target 混淆。

### 7.3 决策与 Q5

- `submitReview({taskId,decision,notes,headSha,reviewer,clientRequestId})`：
  - 校验 target.headSha == headSha；否则 `REVIEW_STALE`。
  - **最新值语义**：同一 reviewer/head 的新 decision 总是追加 `revision+1`，旧行 `is_current=0`（保留历史）；旧 `request_changes`/`comment` 可被新 `approve` 覆盖，旧 `approve` 也可被新 `request_changes` 覆盖。只统计 `is_current=1` 的 decision。
  - `approve`：必须无 open/outdated blocker；所有 required reviewers 的**当前** decision 已 approve；写当前 decision + target status `approved`（若 required approvals 达标）；事件 `review.decision`（payload 含 `revision/supersedesId`）+ `review.approved`（达阈值时）。
  - `request_changes`：notes 必填；写当前 decision；target `changes_requested`；事件 `review.decision` + `review.changes_requested`（notes 正文入 decision 表，事件只存 notesHash）。
  - `comment`：不改变 target 状态，仅 decision 记录；后续 `approve` 可直接覆盖。
- 同一 reviewer 同 head 重复提交同值幂等（`client_request_id` 或 `(target,reviewer,head,revision)` 匹配，返回旧记录，不重复发事件）。
- **Q5**：
  - kernel review（任务完成）与 line review（合并前代码）独立；不自动同步。
  - 若 `kernel.reviewPolicy=required`，任务 owner 仍需 kernel approve；行级评审面板显示「任务评审：待/已通过」和「合并评审：…」，避免混淆。
  - `merge.approved` 的 actor 必须是 human merge captain/local user；reviewer 的 approve 不等于 merge approval；UI 需分别点击（或明确「评审通过」后合并按钮仍要求人工合并批准）。
  - 事件 `task.review_*` 与 `review.*`、`merge.*` 三套并存，审计可追溯。

### 7.4 审批计数、修订与门禁

- **P0 `required_approvals` 固定为 1**；schema `CHECK(required_approvals=1)`，API/config/UI 传 >1 返回 `REVIEW_LIMIT`（明确“P0 仅允许 1 个 human approval，多 approvals 属 P1”），不静默 clamp。只统计 `reviewer_kind=human`、`role IN ('reviewer','merge_captain')`、同 head、`is_current=1`、decision=approve。
- 多 human reviewer/多 approvals 是 P1；P0 只有本地 human `user`，因此 2 approvals 不可配置、不可验收。
- `changes_requested`：任一 required reviewer 的**当前** decision 为 request_changes ⇒ target `changes_requested`；该 reviewer 后续 `approve` 覆盖旧值后，target 重新计算；不要求删除旧 revision。
- `request_changes→approve`：旧 revision 保留 `is_current=0`，新 approve 当前化；blocker 仍须为 0；更新事件带 `revision/supersedesId`。
- `comment→approve`：comment 不阻塞；approve 覆盖 comment；审批计数只算 approve。
- `approve→request_changes`：反向覆盖，target 立即回 changes_requested，合并队列回 waiting_review。
- 移除/替换 reviewer：其当前 decision 设 `is_current=0`、`invalidated_reason='reviewer_removed'`；target 重算（不足 approvals → pending；有当前 changes → changes_requested）；queue 回 `waiting_review`。历史保留。
- 如果 reviewer 同时是作者（Agent）→ 分配拒绝；人类 requester 自评允许（因为 author 是 Agent 或 null）。
- 设置变更（模式降级/变更）不追溯旧 head 的 decision 历史，但必须清 merge approval/checks waive 并回 waiting_review（§10.5）。

### 7.5 Reviewer 移除/替换

- API：`removeReviewer({taskId, reviewerId, reason})`、`replaceReviewer({taskId, fromReviewerId, toReviewerId, role, reason})`。
- 权限：仅 Merge captain/human（服务端校验 workspace + human）；作者/Agent 不能调用；必须填 reason（≥8 chars）写审计。
- `removeReviewer`：
  1. reviewer 行置 `removed` + `removed_at/reason`（不删除）；
  2. 该 reviewer 当前 head 的 decisions 置 `is_current=0`、`invalidated_reason='reviewer_removed'`（历史保留）；
  3. target 重算 approvals/blockers/当前 changes；不足 required → `pending`（gate `REVIEW_UNASSIGNED` 或 `REVIEW_PENDING`）；
  4. queue 回 `waiting_review`；发 `review.reviewer_removed` + `merge.approval_reset`（若已批准）。
- `replaceReviewer`：同一事务内 remove old + assign new（role/reason）；旧 decision 全部失效，新 reviewer `requested`；通知新 reviewer；target 回 pending；不允许替换成 Agent 作 required reviewer。
- 不允许移除最后一个 required human 后自动批准；无 reviewer 就 `REVIEW_UNASSIGNED`，不合并。
- 测试：移除唯一 reviewer 后 gate 失败；替换后新 reviewer approve 才通过；旧 decision 不出现在当前计数但历史可查。

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
   - `ensureTarget` 发现 head/base 变 → stale 旧 target、reanchor、按 Git 既有规则清 `approved_head_sha`/`checks_waived`；队列回 waiting_review。
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

**不新增 FSM 状态**，复用 `waiting_review`；`MergeQueueItem.review` 从 string 扩展为枚举 `none|pending|approved|changes_requested|stale`（**无 `waived`**；checks waive 独立字段），并新增只读 `reviewTargetId`/`reviewBlockers`/`reviewApprovals`（可选，P0 计算摘要）。

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
- 配置变更（含 required→off/advisory、advisory→required、requiredApprovals 降低）**不在本节保留任何“不清空/建议”分支**，一律按 §10.5 执行：必须 confirm，清 `approved_head_sha`/`checks_waived`，queue 回 `waiting_review`，写 `review.config_changed` + `merge.approval_reset`；与 AC-RV-32 完全一致。

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
- 评审人条：显示已分配 reviewer（requested/approved/removed）和 required 数；人类可点「分配评审人」；captain 可「移除/替换」（Modal 填原因，确认后 decision 失效/队列回等待评审）。Agent advisory 只读，不显示评论/批准按钮。P0 单人类默认 `user` 已预分配，不强制弹窗。
- 决策展示：显示每个 reviewer 的**当前决策**（approve/request_changes/comment）与修订号；「历史」展开只读列表（旧 revision 保留）；新提交覆盖当前值，不删除历史。
- 大 diff：顶部提示「已截断，单文件展开」；文件级懒加载；虚拟列表。

### 9.3 组件

| 组件 | 说明 |
|------|------|
| `ReviewSection` | 加载 target/summary；tabs? 不新增页签，section 内文件树+diff+线程+footer |
| `ReviewHeader` | 状态、head/base、审批、blocker、deep link |
| `ReviewerBar` | reviewer 分配/状态/required 数/移除/替换；人类操作 |
| `ReviewFileTree` | 目录/文件、过滤、键盘 roving |
| `UnifiedDiff` | 虚拟化行、hunk、行号、评论按钮、线程插槽 |
| `ReviewThread` | 根评论/回复、severity、resolve/reopen、Markdown |
| `ReviewComposer` | 行内/线程回复；textarea + severity（reviewer）+ 提交/取消 |
| `ReviewDecisionBar` | approve/request changes；当前 decision/修订；历史；备注；disabled reason；Modal 确认 |
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
  authorAgentId: string | null; requesterId: string; requesterKind: "human"|"agent";
  provider: string; prNumber: number | null; prUrl: string | null;
  baseBranch: string; baseSha: string; headSha: string; mergeBaseSha: string;
  diffHash: string; status: "pending"|"approved"|"changes_requested"|"stale"|"unavailable";
  requiredApprovals: number; approvalCount: number; blockerCount: number;
  reviewers: ReviewReviewer[];
  createdAt: string; updatedAt: string;
}

export interface ReviewDecisionRecord {
  id: string; targetId: string; reviewerId: string; decision: ReviewDecision;
  headSha: string; revision: number; isCurrent: boolean; supersedesId: string | null;
  invalidatedReason: string | null; notes?: string; createdAt: string;
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
  decisions: ReviewDecisionRecord[];   // 按 reviewer/当前值 + 历史时间
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
editReviewComment(input: { taskId: string; commentId: string; body: string }): Promise<ReviewComment>;
deleteReviewComment(input: { taskId: string; commentId: string }): Promise<ReviewComment>;
getReviewDecisions(taskId: string): Promise<ReviewDecisionRecord[]>;
resolveReviewThread(input: { taskId: string; threadId: string; note?: string }): Promise<ReviewThread>;
reopenReviewThread(input: { taskId: string; threadId: string; note?: string }): Promise<ReviewThread>;
setReviewSeverity(input: { taskId: string; threadId: string; severity: ReviewSeverity }): Promise<ReviewThread>;
submitReviewDecision(input: {
  taskId: string; decision: ReviewDecision; headSha: string; notes?: string;
  clientRequestId?: string;
}): Promise<ReviewTarget>;
assignReviewer(input: { taskId: string; reviewerId: string; role: "reviewer"|"advisory" }): Promise<ReviewTarget>;
removeReviewer(input: { taskId: string; reviewerId: string; reason: string }): Promise<ReviewTarget>;
replaceReviewer(input: {
  taskId: string; fromReviewerId: string; toReviewerId: string;
  role: "reviewer"|"advisory"; reason: string;
}): Promise<ReviewTarget>;
ensureReviewTarget(taskId: string): Promise<ReviewTarget>;
getReviewConfig(workspaceId: string): Promise<ReviewConfig>;
saveReviewConfig(
  workspaceId: string,
  patch: Partial<ReviewConfig>,
  options?: { confirmResets?: boolean },
): Promise<ReviewConfig>;
```

- 全部校验 workspace/task 归属；review target 的 workspace 必须与 task 一致；拒绝跨 workspace。
- 读接口对同 workspace 成员开放；写/approve 按 §6.2；IPC 不返回 token/完整 patch 之外的内容。
- `getReviewDiff` 仅返回指定文件分页；`file` 缺省返回文件列表+第一个文件首屏；offset/limit clamp 1–500 行。
- `submitReviewDecision` 必须带 `headSha`，服务端与当前 target/queue 对比；不匹配 `REVIEW_STALE`。新 decision 覆盖旧当前值并保留历史；`clientRequestId` 幂等。
- `removeReviewer`/`replaceReviewer` 只允许 human merge captain（或配置的人类 owner），reason ≥8 chars，写 `review.reviewer_removed/replaced` 与 audit；移除后当前 decision 失效，target/queue 重算。
- `editReviewComment`/`deleteReviewComment`：仅评论作者 human（或 captain）可编辑/软删；Agent 一律拒绝；blocker 根评论不可删除；写 `review.comment_edited/deleted`（仅 id/actor/body_hash）。
- 保存配置：任何 required→advisory/off 或 requiredApprovals 降低，若存在已 `approved_head_sha/checks_waived` 的活动队列，必须 `confirmResets=true` 才执行；否则 `REVIEW_CONFIG_CONFIRM_REQUIRED`。

### 10.3 工具（Agent）

P0 只读（Agent 不能写评论；D-R15）：

```ts
review.summary(taskId) -> ReviewSummary（无评论正文，仅状态/count/head）
review.threads(taskId, {file?, status?}) -> 线程正文（同 workspace，Agent 只读）
```

- 不提供 comment/reply/approve/blocker/resolve/assign 工具；Agent 无法治理、不能写评论。
- 现有 `board.post`/`memo` 工具不变；review 摘要可被 Agent 读取。
- P1 才评估 `suggestion`-only 评论（需新增配置/UI/审计/AC），P0 不预留开关。

### 10.4 权限/错误

- `REVIEW_FORBIDDEN`：非 workspace 成员/作者 Agent 尝试 approve/blocker/comment；Agent 写入评论一律拒绝；`REVIEW_STALE`：head/base 不匹配；`REVIEW_BLOCKED`：未解决 blocker；`REVIEW_LIMIT`：超长/超量，或 P0 `required_approvals>1`；`REVIEW_NOT_FOUND`；`REVIEW_UNAVAILABLE`；`REVIEW_CONFIG_CONFIRM_REQUIRED`：降级配置未确认清批准。
- IPC 返回 `{ok,error}` 的 mutation 统一；读接口抛错由 UI `formatError`。
- 审计事件 idempotency key 示例：`review:thread:create:{target}:{hash}`、`review:decision:{target}:{reviewer}:{head}:{revision}`。

### 10.5 配置变更与强制清批准

- `saveReviewConfig` 统一写 `review.config_changed` 事件（workspace aggregate，payload 见 §11.1；author/actor 人类）。
- 危险变更：
  - `required → advisory/off`；
  - `required_approvals` 降低（P1；P0 固定 1，不可降低）；
  - `notify_mailbox`/`board_summary` 不触发清批准。
- 当危险变更影响存在 `approved_head_sha` 或 `checks_waived` 的活动队列项：
  - 必须 `confirmResets=true`（UI 确认 Modal，明示「将清除合并批准/checks 豁免并回等待评审」）；
  - 未确认 → `REVIEW_CONFIG_CONFIRM_REQUIRED`，不改配置；
  - 确认后同事务：清 `approved_head_sha`、`checks_waived`/waive 元数据（若属该 head）、队列回 `waiting_review`，写 `merge.approval_reset` + `review.config_changed`。
- required→off/advisory 后，review decisions 仍保留历史；gate 立即按新模式；不再要求 review。
- advisory→required **不保留旧批准**：同样要求显式确认并清 `approved_head_sha`，防止用旧批准绕过新门禁；P0 危险变更清单包含 advisory→required。
- 配置变更不影响已合并项；只影响 open/waiting_review/ready/updating 等活动项。
- 测试：required→off 清 approved/checks 并回 waiting_review；confirm 缺失拒绝；advisory→required 清旧批准；事件 audit。

---

## 11. 事件、审计、通知、邮箱/黑板

### 11.1 事件目录（新增；zod/schemaVersion=2）

| type | aggregate | payload（无正文） | 幂等键 |
|------|-----------|-------------------|--------|
| `review.target_created` | task | `{targetId,taskId,headSha,baseSha,diffHash}` | `review:target:{taskId}:{headSha}:{baseSha}` |
| `review.author_unknown` | task | `{targetId,taskId,ownerId,actor}` | `review:author-unknown:{targetId}` |
| `review.requested` | task | `{targetId,reviewerId,role}` | `review:req:{targetId}:{reviewerId}` |
| `review.thread_created` | task | `{targetId,threadId,filePath,lineStart,severity}` | `review:thread:{targetId}:{threadId}` |
| `review.comment_added` | task | `{targetId,threadId,commentId,authorId}` | `review:comment:{commentId}` |
| `review.comment_edited` | task | `{targetId,threadId,commentId,actorId,bodyHash}` | `review:comment-edit:{commentId}:{bodyHash}` |
| `review.comment_deleted` | task | `{targetId,threadId,commentId,actorId,bodyHash}` | `review:comment-delete:{commentId}:{deletedAt}` |
| `review.thread_resolved` | task | `{targetId,threadId,actor}` | `review:resolve:{threadId}:{at}` |
| `review.thread_reopened` | task | `{targetId,threadId,actor}` | `review:reopen:{threadId}:{at}` |
| `review.severity_changed` | task | `{targetId,threadId,from,to,actor}` | `review:sev:{threadId}:{at}` |
| `review.decision` | task | `{targetId,reviewerId,decision,headSha,revision,supersedesId,blockerCount,approvals}` | `review:decision:{targetId}:{reviewer}:{head}:{revision}` |
| `review.reviewer_removed` | task | `{targetId,reviewerId,actor,reason}` | `review:reviewer-remove:{targetId}:{reviewerId}:{at}` |
| `review.reviewer_replaced` | task | `{targetId,fromReviewerId,toReviewerId,actor,reason}` | `review:reviewer-replace:{targetId}:{from}:{to}:{at}` |
| `review.config_changed` | workspace | `{workspaceId,fromMode,toMode,fromApprovals,toApprovals,actor}` | `review:config:{workspaceId}:{at}` |
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
- 评论编辑/删除：`review.comment_edited` / `review.comment_deleted` payload 仅 id/actor/body_hash；`comment_added` 仍为创建事件。eventRegistry/AC-RV-19 必须覆盖这三个事件。

### 11.2 通知

- **recipient 解析**（先解析再发送）：
  - `recipient.kind=human`（本地 `user`/人类 owner/requester）→ **只走 UI badge/Toast/aria-live，不写邮箱**；本地人类没有 mailbox 身份。
  - `recipient.kind=agent`（agent owner/agent advisory reviewer）→ 仅当 `review.notify_mailbox=1` 且 Agent 有邮箱时写 mailbox；Agent 作者可收到 review 通知。
  - 混合事件分别处理；某类 recipient 解析为空时跳过，不报错。
- **邮箱**：
  - `review.requested` → 每个 required **agent** reviewer 一条 `MessageKind='review'`，subject `[评审] <task title> · <head7>`，body 摘要（无 diff/全文），refs `task:<id>`、`pr:<n>`、`review:<target>`；去重键 `recipientId:targetId:headSha:eventType`（含 recipient）。
  - `review.changes_requested` → Agent owner（若有邮箱）+ merge captain（human 走 UI）；阻塞摘要，不复制评论全文。
  - `review.approved` → Agent owner + merge captain（human UI）；`review.thread_created`（severity=blocker）→ Agent owner + reviewer（agent 才发信）；`review.stale` → agent reviewer/captain（human UI）。
  - **local human `user` 永不收到 mailbox**；用任务详情 badge/Toast。
- **黑板摘要**（可选，`review_config.board_summary=true`）：
  - target 进入 approved/changes_requested 时，向 `reviews` 域写一条 `decision`/`warning`，content 只含 task/head/决定/审批数/blocker 数/链接；refs 指向 target；不复制评论全文。
  - 通过 `MemoryService.postBoard(HUMAN)` 或当前 AppService.memory；避免直接写 memory 表。
- **去重/节流**：同 target/head/event/**recipient** 只发一次；outdated/stale 通知合并为一条；邮件正文脱敏（redactSecrets）。
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
| 作者自批 | 作者/Agent 不能 approve；required reviewer 必须显式分配；UI 服务端双重校验；作者快照 `authorAgentId` 防 owner 变化绕过 |
| Agent 评论/注入 | P0 禁止 Agent 写评论/回复/blocker；API/service 拒绝，工具只读；评论正文当 untrusted data |
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
3. **作者/requester 回填**：`author_agent_id = (task.ownerId 且 owner 是 Agent) ? ownerId : NULL`；`requester_id` 回填 `'user'`（若无历史 requester）；缺失 ownerId 写 `review.author_unknown` 审计但不阻断。已有 decision 回填 `revision=1,is_current=1`；旧 `context_*` NULL 转 `'[]'`；若历史数据意外有 `status='waived'`，迁移为 `pending` 并记警告（P0 不产生该状态）。
4. 不修改 `task_vcs`/`merge_queue` 现有列；`MergeQueueItem.review` 是 API 层扩展，旧 DB 行默认 `none`。
5. 旧事件 schemaVersion 保持 1；新事件 2；eventRegistry 注册（含 comment_edited/deleted、reviewer_removed/replaced、config_changed）。
6. 迁移失败：review unavailable；Git/任务/合并不受影响；`review.mode=required` 的 gate fail-closed；UI 显示错误与重试。
7. 备份：复用 Store `backupDatabase`/VACUUM；迁移前备份，保留恢复路径。

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
| AC-RV-03 | target 唯一 `(task,head,base)`；`base_sha/merge_base/diff_hash` 一致；重复 ensure 幂等；base 前进同 head 生成新 target 并 stale 旧 target；authorAgentId/requester 快照正确 | unit |
| AC-RV-04 | head/base 变化 → 旧 target stale、decision 失效、队列回 waiting_review、事件 `review.stale` | integration |
| AC-RV-05 | unified parser 覆盖 add/del/context/rename/delete/binary/LFS/`\ No newline` | unit |
| AC-RV-06 | 大 diff 截断/分页/总量限额；超限不阻塞主线程；UI 显示截断提示 | unit/integration |
| AC-RV-07 | 线程创建/回复/编辑软删/解决/重开；评论正文不入事件；`context_before/after` JSON 字符串 round-trip，malformed 回退 `[]`，≤3 行 clamp | unit |
| AC-RV-08 | severity：blocker 只能 reviewer/captain 创建/升级；作者不能降级 | unit |
| AC-RV-09 | 未解决 blocker（含 outdated）→ gate `REVIEW_BLOCKED`；解决后通过 | unit/integration |
| AC-RV-10 | 作者=task.ownerId Agent（仅 Agent）；人类 requester/提交者不是作者，**自评是显式例外**；Agent 作者不能 approve/解决 blocker/评论；越权返回 `REVIEW_FORBIDDEN` | unit |
| AC-RV-11 | **P0 required_approvals 固定为 1**；API/config/UI 传 >1 返回 `REVIEW_LIMIT` 且不写入；2 approvals 归 P1、不进入 P0 AC；approved 计数；`request_changes→approve`、`comment→approve` 覆盖当前值且历史保留；重复决策幂等；`removeReviewer` 令其当前 decision 失效、target/queue 回 waiting_review；`replaceReviewer` 后新 reviewer approve 才通过；旧 revision 可查但不计数 | unit/integration |
| AC-RV-12 | approve 绑 head；head 不匹配 `REVIEW_STALE`；旧 decision 不能用于新 head | unit |
| AC-RV-13 | mergeQueue.approve 在 required gate 未过时拒绝，不写 `approved_head_sha`、不发 `merge.approved` | integration |
| AC-RV-14 | gate pass + merge captain approve 后 `approved_head_sha=head`；reviewer approve 不写 merge approval（Q5） | integration |
| AC-RV-15 | checks+review 双门禁；checks pass 但 review blocked 不 merging；review pass 但 checks fail 不 merging | integration |
| AC-RV-16 | head/base 变化同时清 `approved_head_sha`/review decision/线程锚点；reanchor moved/outdated 正确 | integration |
| AC-RV-17 | reanchor 失败 → outdated；blocker 仍阻止；不自动 resolve | unit |
| AC-RV-18 | review unavailable 且 required → fail-closed `REVIEW_UNAVAILABLE`；advisory/off 不受影响 | integration |
| AC-RV-19 | 事件 zod/schemaVersion=2；`review.author_unknown`、`review.comment_added/edited/deleted`、`review.reviewer_removed/replaced`、`review.config_changed` 全部注册；非法 payload 不落库；事件无正文；audit 可查 | unit |
| AC-RV-20 | 邮箱：Agent recipient 才发信、local human 只 UI/Toast 不发 mailbox；requested/decision/blocker 去重键含 recipient+target+head+event、脱敏、refs 正确；notify 失败不阻断 | unit |
| AC-RV-21 | 黑板摘要：approved/changes_requested 写 decision/warning，仅摘要+refs，不复制全文 | integration |
| AC-RV-22 | UI SSR：header/文件树/diff/线程/footer/空态/错误/aria-live；无 Monaco bundle | SSR |
| AC-RV-23 | 键盘：行 roving/Arrow/Enter/Esc、文件树、线程、Modal 焦点归还；ARIA 断言 | component |
| AC-RV-24 | 窄屏（320/700/900）文件树/横向 diff/sticky footer；无 hover-only | component/manual |
| AC-RV-25 | Markdown XSS/HTML/链接/secret 脱敏；diff 纯文本渲染 | unit |
| AC-RV-26 | 大 diff 20k 行 UI 虚拟化；100k 拒绝/提示；解析时间目标 | integration/perf |
| AC-RV-27 | 迁移失败/回滚：review unavailable、off 恢复旧合并、备份可恢复 | integration |
| AC-RV-28 | 深链 `#/tasks?t=&review=1`/命令面板；不新增 Dock panel；现有 tasks 面板不回归 | unit/manual |
| AC-RV-29 | Git/队列/任务既有测试全绿；`pnpm typecheck/build/test` | 三命令 |
| AC-RV-30 | 作者/requester 语义：作者严格 `task.ownerId` Agent；target 快照 authorAgentId/requesterId；人类 requester 不是作者且自评是显式例外；ownerId 缺失/迁移兼容；服务端拒绝 Agent 自批与 Agent 评论 | unit/integration |
| AC-RV-31 | reanchor fixtures：rebase 行移、base 前进、rename、删除行、重复上下文、二进制/超大、文件删除；唯一匹配 moved，否则 outdated；outdated blocker 仍阻断 | unit/integration |
| AC-RV-32 | 配置变更：required→off/advisory、requiredApprovals 降低、advisory→required 写 `review.config_changed`；未 confirm 拒绝；确认后清 approved_head_sha/checks_waived 并回 waiting_review；已合并项不受影响 | integration |
| AC-RV-33 | `review_decisions` 修订历史：同 reviewer/head 多次提交 revision 递增、旧行 is_current=0、partial unique 索引生效；当前计数/历史查询正确 | unit |

### 15.3 夹具

- `fixtures/review/`：临时 git repo 脚本（base/main、feature 分支、rename/delete/binary/large diff/rebase）；`review-patches/*.patch` 固定 parser 用例；`xss.md`；`large.diff` 生成器。
- **reanchor 专用 fixture**：`rebase-shift`（同一上下文整体 +2 行）、`base-advance`（head 不变、base 前进）、`deleted-line`（旧行 `-`）、`duplicate-context`（同 3 行上下文出现两次）、`rename`（a→b）、`binary`/`too-large`、`file-deleted`；每个 fixture 断言 moved/outdated 与 blocker 状态。
- **JSON/迁移 fixture**：`context_before/after` 正常/非法 JSON/超 3 行；旧 target 缺 `author_agent_id` 的回填与 `review.author_unknown` 事件（payload/幂等）。
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

### 17.2 P1/开放项（不影响 P0 当前默认）

1. **review.mode 默认**：本设计按 D-R7 执行（已有 advisory/新建 required）；是否统一所有 Git workspace 为 required 属 P1 产品决策，不阻塞 P0 默认实现。
2. **P1 多 human 身份/多 approvals**：P0 固定 `required_approvals=1` 且只有本地 human `user`；>1 明确 `REVIEW_LIMIT`，多 reviewer/邮箱映射归 P1，不进入 P0 AC。
3. **P1 增强**：Monaco split、GitHub 原生 review 导入、captain override、Agent suggestion-only 评论等，均不阻塞 P0。

### 17.2.1 本轮已处理（仍有 P1/开放项）

- **作者/requester（本轮关闭）**：**不新增 `Task.createdBy`**；作者严格=`task.ownerId` 且仅当它是 Agent；`requester_id/requester_kind` 快照仅用于审计/通知，不参与作者判定；人类 requester/提交者自评是显式例外；ownerId 缺失兼容见 D-R14/§4.2。
- **多 approvals（归 P1）**：P0 `required_approvals=1`，API/config/UI 传 >1 返回 `REVIEW_LIMIT`；AC-RV-11 不再要求 2 approvals。
- **outdated blocker**：继续阻断（D-R11），不自动 resolve；评审人确认/解决。
- **decision 修订**：最新值 + 历史（D-R13）；`request_changes→approve`/`comment→approve`/删除 reviewer 均有 AC-RV-11。
- **Agent 评论**：P0 禁止（D-R15）；工具只读；AC-RV-10。
- **waived**：P0 删除；`review.mode=off` 不等于 waived（D-R16）。
- **评论编辑/删除**：软删 + `review.comment_edited/deleted` 事件（AC-RV-19）。
- **配置降级**：`review.config_changed` + 强制清批准/checks waive + confirm（AC-RV-32）。
- **通知 recipient**：local human 只 UI/Toast；Agent 才 mailbox；去重含 recipient（AC-RV-20）。

### 17.3 决策记录

- 本设计继承 Git D13：行级评审接入同一 merge gate；`approved_head_sha` 不变。
- 继承 Q5：不复用 kernel review；独立审计。
- 继承 DESIGN §5.6/§8：Monaco 理想但 P0 用统一 diff；不新增 Dock panel。

---

## 18. 附录

### A. Re-anchor 算法

完整可执行伪代码、blob/hunk 数据源、失败分类与 fixtures 见 **§5.5.1–§5.5.4**（本节不再维护第二份实现，避免偏差）。不变量：

- 只用旧/新 commit 的 blob + `git diff -U3 oldHead..newHead`；不读 runtime worktree。
- 优先“旧行原文 + ≤3 行上下文在新文件唯一匹配”；重复上下文 → outdated，不按行号猜。
- 旧行删除/文件删除/rename 目标缺失/二进制/超大/blob 缺失 → outdated。
- 线程保留；`outdated` blocker 继续阻止合并；不自动 resolve。
- 每次映射写 `review_reanchor_log` + `review.reanchored` 事件；不改 resolved 状态。
- 不跨文件自动映射，除非 `--find-renames` 明确 old/new path；rename 需 unique new path。

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
- [x] decision 最新值/修订、request_changes→approve、comment→approve、remove/replace reviewer（§7.3/§7.4/§7.5/AC-RV-11）
- [x] 作者/requester 快照、ownerId 缺失迁移、Agent 不可评论（§4.2/§6.2/§7.1/§10.3/AC-RV-30）
- [x] 可执行 re-anchor 算法 + rebase/base 前进/删除/重复上下文 fixtures（§5.5/§15.3/AC-RV-31）
- [x] comment_edited/deleted、config_changed、reviewer_removed/replaced 事件（§11.1/AC-RV-19）
- [x] TEXT JSON parse/stringify、recipient 解析、配置强制清批准、删除 waived（§4.2/§10.5/§11.2/AC-RV-07/20/32）
- [x] 文件影响面/阶段/非目标（§16/§17）
- [x] 只读代码/文档，未改实现代码

## 20. t142/t147/t149 requirements 修订记录（本轮已处理，仍有开放项）

> 本节记录已落实项；**不代表全部关闭**。P1/开放项见 §17.2，不影响 P0 当前默认（单一 human、`required_approvals=1`、已有 workspace advisory/新建 required）。

| # | 审查项 | 修订 | 位置 |
|---|--------|------|------|
| 1 | decision 最新值/修订、覆盖历史、request_changes→approve/comment→approve、移除 reviewer | 追加修订 + `is_current` + 历史；`request_changes→approve`、`comment→approve` 允许；移除/替换 reviewer 使当前 decision 失效；AC-RV-11 覆盖 | §4.1/§4.2/§7.3/§7.4/§7.5/AC-RV-11 |
| 2 | 作者/createdBy/requester 与人类自评 | **不新增 `Task.createdBy`**；作者严格 = task.ownerId 且仅 Agent；target 快照 `author_agent_id`/`requester_id`；**requester 快照仅审计/通知，不参与作者判定**；人类 requester/提交者自评是显式例外；ownerId 缺失/迁移兼容；服务端按快照校验 | D-R14/§4.2/§6.2/§7.1/§14.1/AC-RV-30 |
| 3 | 可执行 re-anchor 算法 + fixtures | 旧/新 blob + `git diff -U3`；旧行+上下文唯一匹配优先；rename/delete/binary/超大/重复→outdated；rebase/base 前进/删除/重复 fixture | §5.5.1–§5.5.4/§15.3/AC-RV-31 |
| 4 | comment_edited/comment_deleted 事件 | 增加两事件（仅 id/actor/body_hash）并写 eventRegistry/AC-RV-19/fixtures；增加编辑/软删 API | §10.2/§11.1/§11.3/AC-RV-19 |
| 5 | P0 禁止 Agent 评论 | 矩阵删去 Agent 评论权限；工具只读；删 `allow_agent_comments`；AC-RV-10/§12 覆盖 | D-R15/§6.2/§10.3/§12/AC-RV-10 |
| 6 | removeReviewer/replaceReviewer IPC/权限/失效 | 新增 API + captain/human + reason + audit；旧 decision 失效、target/queue 回 waiting_review；测试 | §7.5/§10.2/§10.4/AC-RV-11 |
| 7 | TEXT 存 JSON/parse/fallback/≤3 行 | `context_before/after` 明确 JSON 字符串；store parse/stringify；失败回退 `[]`；clamp 3 行；round-trip AC | §4.1/§4.2/AC-RV-07 |
| 8 | recipient 解析/去重/local human 无邮箱 | local human 只 UI/Toast；Agent 才 mailbox；去重键含 recipient；补 local 无邮箱测试 | §11.2/AC-RV-20 |
| 9 | config_changed/降级清批准 | 新增 `review.config_changed`；required→off/advisory、approvals 降低、advisory→required 必须 confirm；清 approved_head_sha/checks_waived 回 waiting_review | §10.5/§11.1/AC-RV-32 |
| 10 | waived 状态 | P0 删除 `waived`；`review.mode=off` 不是 waived；gate/status/queue/type 同步移除；无 review waive 路径 | D-R16/§4.2/§8.3/§10.1/AC-RV-02 |
| 11 | §8.5 与 §10.5 配置行为不一致 | 删除“不清空/建议”旧段；§8.5 明确指向 §10.5：危险变更必须 confirm、清 approved_head_sha/checks_waived、回 waiting_review、写 config_changed/merge.approval_reset；与 AC-RV-32 一致 | §8.5/§10.5/AC-RV-32 |
| 12 | P0 多 approvals 不可执行 | P0 `required_approvals` 固定 1；schema CHECK/API/UI >1 → `REVIEW_LIMIT`；多 approvals 归 P1；AC-RV-11 删除 2 approvals | §1.2/§4.1/§7.4/AC-RV-11/§17.2 |
| 13 | `review.author_unknown` 无可注册事件 | §11.1 增加 task aggregate 事件（payload targetId/taskId/ownerId/actor、幂等键），AC-RV-19/夹具同步 | §11.1/AC-RV-19/§15.3 |
| 14 | D-R6/矩阵作者例外不明确 | D-R6 与 §6.2 明确作者=ownerId Agent；人类 requester/提交者不是作者，自评是显式例外；AC-RV-10/30 改为可判定断言 | D-R6/§6.2/AC-RV-10/AC-RV-30 |
| 15 | 开放项/“已关闭”措辞不一致 | §17.2 改为 P1/开放项且不影响 P0 默认；§17.2.1/§20 改为“本轮已处理，仍有开放项”；明确不新增 Task.createdBy | §17.2/§17.2.1/§20 |

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

