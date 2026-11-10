# 行级评审与合并门禁实现（t154 / t159 / t163）

- **任务**：t154 实现；t159 repair-round-2；**t163 repair-round-3** 门禁全状态/GitExec 安全参数/grid/unavailable/rollback/anchor fixtures
- **设计依据**：`docs/team/line-review-design.md`（t151 通过，1305 行；AC-RV-01..33）
- **分支/PR**：`feature/t154-line-review`；PR 见 `pnpm branch:finish t154-line-review` 输出（不自动合并）
- **范围**：新增 `src/review/`、IPC/preload/main、任务详情 UI、样式、测试、本文；`src/git/gitExec.ts` 仅扩展只读 diff/cat-file allowlist；未改 `src/kernel/`、`src/memory/`、`dist*`

## 1. 交付摘要

| 能力 | 实现 |
|------|------|
| review_schema | `ReviewStore.ensureSchema`：`review_schema` + config/targets/diff files/reviewers/threads/comments/decisions/reanchor log；v1 幂等 create-if-not-exists；不触碰 kernel/git schema |
| Diff | `ReviewDiffProvider` 复用 `src/git/gitExec.ts` 的 `GitExec`（只读 `rev-parse --verify`/`merge-base`/`diff --no-ext-diff --no-textconv --no-color --find-renames --unified=3`/`cat-file`；hooksPath + workspace realpath；输出统一 redactSecrets）；unified parser；文件/行分页；64KB/2000 行 per-file、5MB 总上限；二进制/LFS 标记 |
| SHA 绑定 | target `(task_id, head_sha, base_sha)`；`diff_hash`；base/head 变化生成新 target、旧 target stale |
| Rebase re-anchor | `anchor.ts`：old/new blob + 旧行 + ≤3 行上下文唯一匹配；rename patch fallback；重复上下文/del/rename 失败/二进制/超大 → `outdated`；线程迁移到新 target 并写 `review_reanchor_log` |
| 评论/线程 | 创建/回复/编辑软删/删除、open/resolved/outdated、severity、blocker；作者不能解决 blocker；blocker root 不可删除 |
| 评审人/decision | 默认本地 human `user`；author=`task.ownerId` Agent 快照；decision revision + `is_current` + `supersedes`；request_changes→approve/comment→approve 覆盖；remove/replace reviewer 使当前 decision 失效 |
| 模式/门禁 | `required/advisory/off`；P0 `required_approvals=1`；`assertMergeAllowed` 在 electron `git:merge-approve`/`git:merge-start` 前置；`assertQueueAllowed` 在 `git:merge-process` 前置（queued/waiting_checks/waiting_review/ready/merging/updating 逐项）；required fail-closed；advisory 警告；off 放行 |
| 可用性/回滚 | `review_config.unavailable_reason` 全局 fail-closed（required）; `rollback()` 置 off、清 unavailable、保留数据；**不自动 drop 表** |
| 配置变更 | `review.config_changed` + 危险模式切换 confirm；清 `approved_head_sha/checks_waived`、queue 回 `waiting_review`（仅当活动队列存在） |
| 通知 | `notifyAgent` 去重键 `recipient:target:head:event`；requested/decision/blocker/stale；local human 只 UI/Toast，agent owner 才 mailbox；sendMail 失败 catch 不阻断 |
| 安全 | 评论纯文本渲染（无 HTML/Markdown 注入）；diff 纯文本；GitExec/UI secret redact；diff.external/textconv 不执行测试；事件仅 id/actor/body_hash；越权 human-only |
| UI | 任务详情内 `ReviewSection`（不新增 Dock）：文件列表、unified diff grid（row/rowcount/rowindex/gridcell）、行评论、线程、blocker、评审/要求修改、评审人移除；roving tabIndex + ArrowUp/Down + Enter；200 行窗口；aria-live/alert；≤900/700px 单列/横向滚动 |
| 测试 | `src/review/{diff,anchor,service,diff.git}.test.ts` + `src/review/ui/ReviewSection.test.tsx`；全量 41 文件/492 用例（review 29） |

## 2. 文件

```
src/review/types.ts                 领域类型/错误
src/review/store.ts                 review_schema/DAO/事务/事件
src/review/diff.ts                  GitExec 只读 diff provider + unified parser
src/review/diff.git.test.ts         真实 git/GitExec diff + redaction/evil diff
src/git/gitExec.ts                  只读 diff/cat-file allowlist 扩展（安全参数/ref:path）
src/review/diff.test.ts             parser fixtures
src/review/anchor.ts / anchor.test  re-anchor 算法/日志 + fixtures
src/review/service.ts               target/thread/decision/reviewer/gate/config/notify
src/review/service.test.ts          运行时/门禁/通知/修订/queue gate
src/review/ui/ReviewSection.tsx     任务详情评审区
src/review/ui/ReviewSection.test.tsx SSR/交互/ARIA
src/shared/ipc.ts                   DeerApi review 方法
src/shared/deeplink.ts              `review=1` 解析/生成
electron/preload.ts                 review IPC 转发
electron/main.ts                    ReviewService 实例、review:*、merge gate 包装、PR event target
src/App.tsx                         任务详情挂载、taskReview 深链聚焦、命令面板 action
src/CommandPalette.tsx              当前任务行级评审命令
src/styles.css                      review 样式/窄屏/token
docs/team/line-review-implementation.md
```

## 3. 运行时接线与边界

- `electron/main.ts` 创建单例 `ReviewService`，依赖 `service.store`、`service.git.getTaskVcs`、workspace path、`sendMessage`、`postBoard`；不修改 `AppService`/`src/kernel`。
- 合并门禁：`git:merge-approve`、`git:merge-start` 先 `assertMergeAllowed(taskId)`；`git:merge-process` 先 `assertQueueAllowed(workspaceId)`，对 `queued/waiting_checks/waiting_review/ready/merging/updating` 队列项逐项校验当前 target/head/blocker/approval。required 失败时不进入 merging；advisory/off 按设计放行。仅扩展 `src/git/gitExec.ts` 只读 allowlist，不改 GitService/MergeQueue。
- target 创建：打开任务详情/评审 summary 或 merge gate 时懒创建；main 监听 `pr.created`/`pr.updated` 调用 `ensureTargetForPrEvent`（失败不阻断任务完成）；required merge 前 target 存在或 fail-closed。
- target 创建：打开任务详情/评审 summary 或 merge gate 时懒创建；同时 main 监听 `pr.created`/`pr.updated` 事件调用 `ensureTarget`（best-effort，失败不阻断任务完成）；required merge 前 target 已存在或 fail-closed。
- 迁移/回滚：`review_schema` v1 create-if-not-exists；不 drop/不重写 kernel/git 表；回滚用 `mode=off`（配置 API），数据保留可恢复；**workspace 创建时间晚于 review_schema applied_at → required**，既有 workspace 默认 `advisory`。
- P0 固定 1 个 human reviewer/approval；>1 未暴露 API（schema CHECK=1）；多 human 为 P1。

## 4. 安全

- 评论正文只入 `review_comments`；事件 payload 无正文（仅 id/actor/body_hash）；测试断言。
- UI 评论/diff 用 React text 渲染，不解析 HTML/Markdown；`redact()` 处理 `ghp_`/`github_pat_`/`Bearer`/`token=`。
- diff 命令复用 `GitExec`（只读 allowlist、hooksPath、workspace realpath）；`diff` 强制 `--no-ext-diff/--no-textconv/--no-color/--find-renames`，`cat-file` 支持安全 `ref:path`；输出统一 `redactSecrets`；生产代码无第二个裸 `execFile` git 入口（测试 fixture 除外）。
- 写操作 human-only；Agent 写入拒绝 `REVIEW_FORBIDDEN`；作者 Agent 不能批准/解决 blocker；remove/replace reviewer human-only。
- 大 diff 截断/分页/上限；UI 200 行窗口 + 300 行 IPC 页，加载更多。

## 5. 验证

工作目录：`S:\DeerSuperGroup\branches\t154-line-review`

```
pnpm typecheck   # exit 0
pnpm build       # exit 0；402 modules；js 1,187.25 kB / gzip 325.78；css 225.85 kB / gzip 26.37；electron main 1.3mb / preload 9.8kb
pnpm test        # exit 0；41 files / 492 tests
```

Review 专项 29：diff 4（含真实 GitExec/evil diff）、anchor 4（含真实 rename）、service 17、ReviewSection 2。

## 6. AC 映射

| AC | 状态 | 证据/说明 |
|----|------|-----------|
| AC-RV-01 schema/迁移 | passed | `ReviewStore.ensureSchema` v1 create-if-not-exists；service tests 创建目标/查询；无破坏性迁移 |
| AC-RV-02 advisory/new required | passed | 既有 workspace advisory（review_schema applied_at 之前）与新 workspace required；service test；required/advisory/off |
| AC-RV-03 target SHA/base/diff_hash | passed | target unique + service 测试 head/base 快照；base 前进生成新 target |
| AC-RV-04 head/base stale | passed | head/base 变化 test：旧 target stale、新 target |
| AC-RV-05 parser | passed | diff.test add/del/context/rename/binary；LFS 标记 |
| AC-RV-06 大 diff | passed | per-file truncation test；UI 200 行窗口/hasMore |
| AC-RV-07 thread/comments/JSON | passed | service 评论/编辑/删除/context JSON；事件正文断言 |
| AC-RV-08 severity/blocker | passed | blocker create + required gate test；作者/非 reviewer 限制 |
| AC-RV-09 blocker gate | passed | blocker → REVIEW_BLOCKED；resolve → approve |
| AC-RV-10 author/agent/comments | passed | 作者快照；Agent 写拒绝；人类 requester 默认可评 |
| AC-RV-11 revision/remove/replace | passed | decision revision、changes→approve、remove/replace service test；P0 fixed 1 |
| AC-RV-12 head 绑定 | passed | submit head 不匹配 REVIEW_STALE；head 变化旧 decision 失效 |
| AC-RV-13 merge approve 拒绝 | passed（边界） | electron IPC wrapper `assertMergeAllowed`；service gate test |
| AC-RV-14 Q5 独立 | passed | reviewer approve 只改 target；merge approval 不动 |
| AC-RV-15 checks+review | passed（边界） | review gate 覆盖 approve/start/process 全 active 队列状态（含 waiting_checks/queued）；checks 由 Git 既有逻辑负责，未改 GitService/MergeQueue |
| AC-RV-16 head/base 清批准 | passed（review 侧） | head/base 变化 target stale；config 清 merge_queue approved/checks test |
| AC-RV-17 reanchor outdated | passed | anchor unit；Service head/base change 调用 reanchor（失败→outdated） |
| AC-RV-18 unavailable fail-closed | passed | `review_config.unavailable_reason` 全局 required fail-closed；`rollback()` 清标记并置 off；测试覆盖 |
| AC-RV-19 events | passed | target/comment/edit/delete/decision/gate/config/author_unknown 事件；正文不入 payload |
| AC-RV-20 mailbox/recipient | passed | `notifyAgent` 去重键 recipient/target/head/event；requested/decision/blocker/stale；local human 无 mailbox 测试 |
| AC-RV-21 黑板摘要 | passed | `postBoard` reviews domain on target/decision |
| AC-RV-22 UI SSR | passed | ReviewSection SSR loading + 交互测试 |
| AC-RV-23 keyboard/ARIA | passed | `role=grid/row/gridcell` + aria-rowcount/rowindex + roving tabIndex/ArrowUp/Down/Enter；Modal/焦点沿用 |
| AC-RV-24 窄屏 | passed（CSS） | ≤900/700 单列/sticky/footer；无 hover-only |
| AC-RV-25 XSS/secret | passed | plain text + redact；GitExec redaction/evil diff test；无 raw HTML |
| AC-RV-26 大 diff UI | passed | parser/page 上限；UI 200 行窗口 + 分页/load more；grid rowcount |
| AC-RV-27 迁移/回滚 | passed（P0 边界） | create-if-not-exists + `rollback()` mode off/clear unavailable/数据保留；不自动 drop（明确边界） |
| AC-RV-28 deep link/no Dock | passed | `#/tasks?t=&review=1` 解析/生成/聚焦 + 命令面板 action；无 Dock |
| AC-RV-29 三命令 | passed | 492 tests / typecheck / build |
| AC-RV-30 author/requester | passed | target authorAgentId/requester；owner 缺失 author null + author_unknown |
| AC-RV-31 reanchor fixtures | passed | unique/duplicate/deleted/rename（真实 git）/base 前进；binary/超大 parser/limit |
| AC-RV-32 config mode switch | passed | confirm/清 approved/checks/waiting_review test；P0 仅模式切换 |

## 7. 已知边界/后续

1. gate 在 electron IPC 层包 `merge-approve`/`merge-start`/`merge-process`，未改 GitService/MergeQueue；`merge-process` 入口对 `queued/waiting_checks/waiting_review/ready/merging/updating` 队列项逐项 gate。`src/git/gitExec.ts` 仅扩展只读 allowlist。
2. target 懒创建 + `pr.created`/`pr.updated` best-effort 自动创建；PR event 失败不阻断任务完成，required merge 仍 fail-closed。
3. workspace 创建时间晚于 review_schema 时默认 required；既有 workspace advisory；P1 多 human/多 approvals 未实现。
4. UI 无独立配置面板（`saveReviewConfig` 仅 API）；评论无 Markdown（安全优先）/语法高亮；200 行窗口为轻量虚拟化，非完整 react-virtual；grid 的 rowcount/rowindex 与 roving 已实现。
5. 通知只发给 agent owner（human owner 不写 mailbox）；reviewer 通知以 owner 转发为主，完整 reviewer 收件人去重仍可扩展。
6. `review=1` 深链/命令面板已接入；无真实 Electron 截图（无头环境），证据为 SSR/交互/ARIA。
7. 构建 >500kB 警告为既有；无新增依赖。
8. reanchor rename detection 依赖 Git diff 默认配置；真实 rename fixture 已覆盖，文件删除/二进制/超大走 outdated/limit 边界。

## 8. t159 repair-round-2 记录

- **processQueue gate**：`git:merge-process` 前置 `assertQueueAllowed(workspaceId)`，对 active 队列项逐项校验 target/head/blocker/approval；approve/start 仍 `assertMergeAllowed`。service test `blocks processQueue for a ready item until required review passes` + queued/waiting_checks test。
- **GitExec**：`ReviewDiffProvider` 改走 `src/git/gitExec.ts` 的 `GitExec`（hooksPath、workspace realpath、只读 allowlist、统一 `redactSecrets`）；生产代码无第二个裸 `execFile` git 入口。`diff.git.test.ts` 真实 repo 断言 secret 被 redacted。
- **partial 闭合**：workspace 晚于 `review_schema` 创建默认 required；ReviewSection roving tabIndex + ArrowUp/Down/Enter + 200 行窗口；`#/tasks?t=&review=1` 解析/生成/聚焦 + CommandPalette「打开当前任务行级评审」；rename/base fixture；recipient 去重/失败不阻断；config rollback；PR created/updated best-effort `ensureTarget`。
- **仍未做/边界**：AC-RV-15 checks 仍由 Git 侧负责；真实 Electron 人工冒烟未执行。

## 9. t163 repair-round-3 记录

- **全状态 gate**：`assertQueueAllowed` 覆盖 queued/waiting_checks/waiting_review/ready/merging/updating；新增 queued/waiting_checks 不 merging 测试。
- **GitExec 安全参数**：allowlist 允许 `--no-ext-diff/--no-textconv/--no-color/--find-renames`，`cat-file` 支持安全 `ref:path`；ReviewDiffProvider 恢复这些参数；恶意 `diff.external`/`diff.evil.textconv` 不执行测试。
- **grid/ARIA**：ReviewSection diff 改为 `role=grid/row/gridcell` + `aria-rowcount/rowindex` + roving Arrow/Enter；200 行窗口性能口径与加载更多。
- **AC 闭合**：AC-RV-15/18/27/31 更新；`review_config.unavailable_reason` 全局 fail-closed + `rollback()`；真实 rename anchor 测试；PR event best-effort helper/test。
- **边界**：不自动 drop review 表（rollback 保留数据）；checks 仍由 Git 侧；真实 Electron 冒烟未执行。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
