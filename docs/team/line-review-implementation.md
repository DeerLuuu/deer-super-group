# 行级评审与合并门禁实现（t154）

- **任务**：t154 — 实现：行级评审与合并门禁
- **设计依据**：`docs/team/line-review-design.md`（t151 通过，1305 行；AC-RV-01..33）
- **分支/PR**：`feature/t154-line-review`；PR 见 `pnpm branch:finish t154-line-review` 输出（不自动合并）
- **范围**：新增 `src/review/`、IPC/preload/main、任务详情 UI、样式、测试、本文；**未修改** `src/git/`、`src/kernel/`、`src/memory/`、`dist*`

## 1. 交付摘要

| 能力 | 实现 |
|------|------|
| review_schema | `ReviewStore.ensureSchema`：`review_schema` + config/targets/diff files/reviewers/threads/comments/decisions/reanchor log；v1 幂等 create-if-not-exists；不触碰 kernel/git schema |
| Diff | `ReviewDiffProvider`：只读 `git rev-parse`/`merge-base`/`diff --no-ext-diff --no-textconv --find-renames -U3`/`cat-file`；unified parser；文件/行分页；64KB/2000 行 per-file、5MB 总上限；二进制/LFS 标记 |
| SHA 绑定 | target `(task_id, head_sha, base_sha)`；`diff_hash`；base/head 变化生成新 target、旧 target stale |
| Rebase re-anchor | `anchor.ts`：old/new blob + 旧行 + ≤3 行上下文唯一匹配；重复上下文/del/rename 失败/二进制/超大 → `outdated`；head 变化时旧 target 线程重锚定并写 `review_reanchor_log` |
| 评论/线程 | 创建/回复/编辑软删/删除、open/resolved/outdated、severity、blocker；作者不能解决 blocker；blocker root 不可删除 |
| 评审人/decision | 默认本地 human `user`；author=`task.ownerId` Agent 快照；decision revision + `is_current` + `supersedes`；request_changes→approve/comment→approve 覆盖；remove/replace reviewer 使当前 decision 失效 |
| 模式/门禁 | `required/advisory/off`；P0 `required_approvals=1`；`assertMergeAllowed` 在 electron `git:merge-approve`/`git:merge-start` 前置；required fail-closed；advisory 警告；off 放行 |
| 配置变更 | `review.config_changed` + 危险模式切换 confirm；清 `approved_head_sha/checks_waived`、queue 回 `waiting_review`（仅当活动队列存在） |
| 通知 | 评审创建/决定：人类只 UI/Toast；agent owner 通过 mailbox 摘要；黑板 `reviews` 摘要；事件不含评论正文 |
| 安全 | 评论纯文本渲染（无 HTML/Markdown 注入）；diff 纯文本；secret redact；事件仅 id/actor/body_hash；越权 human-only |
| UI | 任务详情内 `ReviewSection`（不新增 Dock）：文件列表、unified diff、行评论按钮、线程、blocker、评审/要求修改、评审人移除；aria-live/alert/role=list；≤900/700px 单列/横向滚动 |
| 测试 | `src/review/{diff,anchor,service}.test.ts` + `src/review/ui/ReviewSection.test.tsx`，17 条；全量 40 文件/480 用例 |

## 2. 文件

```
src/review/types.ts                 领域类型/错误
src/review/store.ts                 review_schema/DAO/事务/事件
src/review/diff.ts                  git diff provider + unified parser
src/review/anchor.ts                re-anchor 算法/日志
src/review/service.ts               target/thread/decision/reviewer/gate/config
src/review/ui/ReviewSection.tsx     任务详情评审区
src/review/*.test.ts                后端测试
src/review/ui/ReviewSection.test.tsx SSR/交互/ARIA
src/shared/ipc.ts                   DeerApi review 方法
electron/preload.ts                 review IPC 转发
electron/main.ts                    ReviewService 实例、review:*、merge gate 包装
src/App.tsx                         任务详情挂载 ReviewSection
src/styles.css                      review 样式/窄屏/token
docs/team/line-review-implementation.md
```

## 3. 运行时接线与边界

- `electron/main.ts` 创建单例 `ReviewService`，依赖 `service.store`、`service.git.getTaskVcs`、workspace path、`sendMessage`、`postBoard`；不修改 `AppService`/`src/kernel`。
- 合并门禁：`git:merge-approve`、`git:merge-start` 先 `assertMergeAllowed(taskId)`；required 模式失败时不写 `approved_head_sha`；advisory/off 按设计放行。`src/git` 未改动，避免与 t98 的 Git 模块冲突；`mergeProcess` 依赖 Git 既有 head 变化清批准逻辑。
- target 为**懒创建**：打开任务详情/评审 summary 或调用 merge gate 时创建；没有 PR/head 时返回 `REVIEW_TARGET_MISSING`/UI 空态。
- 迁移/回滚：`review_schema` v1 create-if-not-exists；不 drop/不重写 kernel/git 表；回滚用 `mode=off`（配置 API），数据保留可恢复；现有 workspace 默认 `advisory`（避免突然阻断），新建/团队可切 `required`。
- P0 固定 1 个 human reviewer/approval；>1 未暴露 API（schema CHECK=1）；多 human 为 P1。

## 4. 安全

- 评论正文只入 `review_comments`；事件 payload 无正文（仅 id/actor/body_hash）；测试断言。
- UI 评论/diff 用 React text 渲染，不解析 HTML/Markdown；`redact()` 处理 `ghp_`/`github_pat_`/`Bearer`/`token=`。
- diff 命令只读、`--no-ext-diff/--no-textconv/--no-color`、禁 shell；路径来自 task_vcs/PR，不执行仓库 hooks。
- 写操作 human-only；Agent 写入拒绝 `REVIEW_FORBIDDEN`；作者 Agent 不能批准/解决 blocker；remove/replace reviewer human-only。
- 大 diff 截断/分页/上限；UI 最多 300 行/页，加载更多。

## 5. 验证

工作目录：`S:\DeerSuperGroup\branches\t154-line-review`

```
pnpm typecheck   # exit 0
pnpm build       # exit 0；402 modules；js 1,184.98 kB / gzip 325.20；css 225.85 kB / gzip 26.37；electron main 1.3mb / preload 9.8kb
pnpm test        # exit 0；40 files / 480 tests
```

Review 专项 17：diff 3、anchor 3、service 9、ReviewSection 2。

## 6. AC 映射

| AC | 状态 | 证据/说明 |
|----|------|-----------|
| AC-RV-01 schema/迁移 | passed | `ReviewStore.ensureSchema` v1 create-if-not-exists；service tests 创建目标/查询；无破坏性迁移 |
| AC-RV-02 advisory/new required | partial | config 默认 advisory；required/advisory/off service test；新 workspace required 由集成层设置（当前统一默认 advisory） |
| AC-RV-03 target SHA/base/diff_hash | passed | target unique + service 测试 head/base 快照；base 前进生成新 target |
| AC-RV-04 head/base stale | passed | head 变化 test：旧 target stale、新 target |
| AC-RV-05 parser | passed | diff.test add/del/context/rename/binary；LFS 标记 |
| AC-RV-06 大 diff | passed | per-file truncation test；UI 分页/hasMore |
| AC-RV-07 thread/comments/JSON | passed | service 评论/编辑/删除/context JSON；事件正文断言 |
| AC-RV-08 severity/blocker | passed | blocker create + required gate test；作者/非 reviewer 限制 |
| AC-RV-09 blocker gate | passed | blocker → REVIEW_BLOCKED；resolve → approve |
| AC-RV-10 author/agent/comments | passed | 作者快照；Agent 写拒绝；人类 requester 默认可评 |
| AC-RV-11 revision/remove/replace | passed | decision revision、changes→approve、remove/replace service test；P0 fixed 1 |
| AC-RV-12 head 绑定 | passed | submit head 不匹配 REVIEW_STALE；head 变化旧 decision 失效 |
| AC-RV-13 merge approve 拒绝 | passed（边界） | electron IPC wrapper `assertMergeAllowed`；service gate test |
| AC-RV-14 Q5 独立 | passed | reviewer approve 只改 target；merge approval 不动 |
| AC-RV-15 checks+review | partial | review gate 在 merge approve/start；checks 仍由 Git 既有逻辑负责；未改 src/git |
| AC-RV-16 head/base 清批准 | passed（review 侧） | head 变化 target stale；config 清 merge_queue approved/checks test |
| AC-RV-17 reanchor outdated | passed | anchor unit；Service head change 调用 reanchor（失败→outdated） |
| AC-RV-18 unavailable fail-closed | partial | target missing/required gate fail；UI error；无全局 review unavailable 降级标志 |
| AC-RV-19 events | passed | target/comment/edit/delete/decision/gate/config 事件；正文不入 payload |
| AC-RV-20 mailbox/recipient | partial | agent owner mailbox、human UI；reviewer 通知仅目标创建时；完整去重未做 |
| AC-RV-21 黑板摘要 | passed | `postBoard` reviews domain on target/decision |
| AC-RV-22 UI SSR | passed | ReviewSection SSR loading + 交互测试 |
| AC-RV-23 keyboard/ARIA | partial | 原生 button/textarea/aria-live/alert/list；无 roving Arrow 实现 |
| AC-RV-24 窄屏 | passed（CSS） | ≤900/700 单列/sticky/footer；无 hover-only |
| AC-RV-25 XSS/secret | passed | plain text + redact；无 raw HTML |
| AC-RV-26 大 diff UI | partial | parser/page 上限；UI 300 行分页；未做虚拟列表 |
| AC-RV-27 迁移/回滚 | partial | create-if-not-exists + mode off；无 drop/回滚 API |
| AC-RV-28 deep link/no Dock | partial | 不新增 Dock；无 `review=1` 深链（ReviewSection 常驻任务详情） |
| AC-RV-29 三命令 | passed | 480 tests / typecheck / build |
| AC-RV-30 author/requester | passed | target authorAgentId/requester；owner 缺失 author null + author_unknown |
| AC-RV-31 reanchor fixtures | partial | unique/duplicate/deleted unit；未覆盖 rename/base 前进 fixture |
| AC-RV-32 config mode switch | passed | confirm/清 approved/checks/waiting_review test；P0 仅模式切换 |

## 7. 已知边界/后续

1. `src/git` out of scope：review gate 在 electron IPC 层包 `merge-approve/merge-start`，未改 GitService/MergeQueue；`mergeProcess` 依赖既有 `approved_head_sha`/head reset。若后续把 gate 下沉到 GitService，可删除 IPC 包装重复。
2. target 懒创建，不在 PR event 自动创建；未打开评审就 merge required 会 `REVIEW_TARGET_MISSING`（UI 引导打开）。
3. 新 workspace 未自动写 `required`（当前统一 advisory），需在 workspace 创建流程/设置中切换；P1 多 human/多 approvals 未实现。
4. UI 无配置面板；`saveReviewConfig` 仅 API；评论无 Markdown（安全优先）、无语法高亮、无虚拟列表。
5. 通知去重/完整 reviewer 邮箱未实现；board 摘要使用 legacy `postBoard`。
6. ReviewSection 未加 `review=1` 深链/命令面板；任务详情常驻已满足入口。
7. 构建 >500kB 警告为既有；无新增依赖。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
