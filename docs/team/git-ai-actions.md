# Git × AI 联动（G2 / t368）

## 范围

- **生成 PR 描述**：Task Workspace Git tab（TaskVcsPanel）与 Git Graph「AI PR 描述」区，成员选择 + 一键生成；草稿标题/正文可编辑、填入 PR 表单、复制、重新生成、失败重试。
- **生成合并说明**：MergeQueue 确认 Modal 内成员选择 + 一键生成；说明可编辑，生成不阻塞确认按钮。
- **合并通知**：mergeStart 成功（state=merged）后向所选成员发邮箱报告；复用任务线程（refs/threadId），失败显示重试且不改变合并结果；默认收件人 localStorage 记忆。
- 所有进外部模型的自由文本经 t280 `sanitizeErrorText` 脱敏（sk-/Bearer/Authorization/Cookie/token/URL/provider body 等）并 cap；Mock/无模型禁用并说明。
- 不改 review/merge gate、权限、状态机；只新增只读/生成 IPC 和审计事件。

## 数据流

```text
TaskVcsPanel / GitGraphPanel / MergeQueuePanel
  → window.deer.gitGeneratePrDraft | gitGenerateMergeDraft
  → AppService.generateGitAiDraft
      task + TaskVcs + GitService.readDiff(commit, headSha, 160KB)
      → sanitize/cap every field
      → selected member model + member.systemPrompt + Git AI system prompt
      → JSON {title, body} parse + cap
      → audit git.ai_pr_draft / git.ai_merge_draft
  → MergeQueue confirm
      → existing mergeStart (unchanged gate)
      → on merged: window.deer.gitNotifyMerge
      → AppService.notifyMerge
          selected member, existing task refs thread (or merge:<taskId>)
          → store.addMessage(kind=report)
          → audit git.merge_notified
      → failure: inline role=alert + 重试通知 (merge result already returned)
```

## IPC / 类型

`src/shared/gitAi.ts`：

- `GitAiDraftRequest`（workspaceId/agentId/kind/taskId?/headSha?）
- `GitAiDraftResponse`（ok/draft/agentName/modelLabel/generatedAt 或错误 code/message/retryable）
- `GitMergeNotifyRequest/Response`
- zod strict：`gitAiDraftRequestSchema`、`gitCreatePrDraftSchema`、`gitMergeNotifySchema`
- `GIT_AI_LIMITS`：promptText 4k、diff 16k、title 120、body 12k、notice 4k

DeerApi：

- `gitGeneratePrDraft(input)` → `git:ai-pr-draft`
- `gitGenerateMergeDraft(input)` → `git:ai-merge-draft`
- `gitNotifyMerge(input)` → `git:merge-notify`
- `gitCreatePr(taskId, {title?, body?})`（旧无 draft 调用保持默认任务标题/描述）

## 安全 / 脱敏

- `sanitizeGitAiText` 复用 `sanitizeErrorText`，对任务标题/描述、成员 systemPrompt、PR/merge 摘要、diff 摘要逐字段脱敏/cap；`buildGitAiMessages` 再次脱敏，JSON 作为 user message。
- 输出解析只接受 `{title,body}`（或标题/正文 fallback），`capLooseText` 二次 cap；不把模型输出当命令执行。
- 只调用人类 preload；不注册 Agent tool，不触发 Git 写操作；`gitCreatePr` 仍受既有分支/provider/gate；`mergeStart` 原样。
- 通知正文也走 `sanitizeGitAiText`；邮件只落本地 store/线程，不发外部网络。

## UI

- TaskVcsPanel：成员下拉 + `生成 PR 描述` + 可编辑草稿（标题/正文）+ `填入 PR 表单`/`复制`/`重新生成` + 错误重试；PR 表单标题/正文直接用于创建 PR；Mock/无模型按钮 disabled 并显示原因。
- Git Graph：新增可折叠「AI PR 描述」区（当前 head/选中 commit），成员+生成+草稿+复制/重试。
- MergeQueue 确认 Modal：AI 合并说明 + 可编辑 `合并说明` + `合并后通知成员` 下拉；确认合并仍调用原 mergeStart；成功后通知，失败在队列面板显示 `合并通知失败` + retry，不阻塞/不回滚合并。
- 收件人记忆 key `deer.git.merge.notifyAgent.<workspaceId>`；成员记忆 key `deer.git.ai.agent.<workspaceId>.<kind>`。
- 1440/960/480：草稿控件 flex 折行，480 全宽；原生 select/textarea/button，`aria-label`；错误 `role=alert`，通知结果 `role=status`。

## 审计

- `git.ai_pr_draft` / `git.ai_merge_draft`：workspaceId、taskId|null、agentId、model、title（不含正文/secret）。
- `git.merge_notified`：workspaceId、taskId、agentId、messageId、threadId。
- 事件走既有 Git event registry（新增 3 个类型），失败静默不影响已完成的生成/合并。

## 测试

- `src/shared/gitAi.test.ts`（3）：脱敏/cap、prompt 不含 secret、JSON/plain 解析、长草稿 cap。
- `src/kernel/gitAiService.test.ts`（4）：真实本地 SSE 模型生成 + 捕获 outbound 断言 secret 不出站 + 审计；Mock 禁用；通知落线程/审计；无效收件人失败。
- `src/git/ui/GitAiDraft.test.tsx`（2）：生成/编辑/填入/复制；Mock 禁用说明。
- `src/git/ui/MergeQueuePanel.test.tsx`（8，新增 1）：生成合并说明、填入、mergeStart、通知失败、重试、localStorage 记忆。
- `src/git/ui/GitPanels.test.tsx` / `GitGraphPanel.test.tsx`：既有 VCS/Graph 无回归。

## 真实截图

| 截图 | 尺寸 | 内容 |
|---|---|---|
| `docs/team/t368-git-ai-1440.png` | 1440×1000 | Task Git tab AI PR 描述/成员/PR 表单 |
| `docs/team/t368-git-ai-960.png` | 960×900 | 960 折行 |
| `docs/team/t368-git-ai-480.png` | 480×900 | 480 单列、无横向 |
| `docs/team/t368-merge-ai-1440.png` | 1424×881 | Merge confirm AI 合并说明/通知成员 |

真实 Electron + 隔离 userData/CDP；种子 task_vcs/merge_queue 仅用于截图（临时 userData，不进仓库 DB）。1440 截图内容区 1424×881 已披露；960/480 为 CDP emulation。

## 已知边界

- AI 仍是人类触发；不自动执行 PR 创建/合并/通知。
- 模型不可用/Mock 时禁用；不伪造草稿。
- 无新增依赖；通知线程复用既有 `threadId`，无 schema 迁移。
- 生成基于任务/commit diff 摘要（cap 16KB），不是完整 2MB diff；大 diff 由既有 diff 分页/完整加载负责。
- PR 创建使用现有 provider/gate；本功能不改变 review/merge 状态机。

验证：typecheck 0；build 0（466 modules）；serial test 172 files / 1119 tests。
