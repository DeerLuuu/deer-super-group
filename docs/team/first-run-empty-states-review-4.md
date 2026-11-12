# P0-7 首用/恢复/空态 · 复审 round 4（t258）

- **对象**：PR #39 `feature/t247-first-run`，HEAD `7d79a1d`（OPEN/MERGEABLE）；t257 修复
- **评审人**：aria（独立复审，未修改生产代码）
- **基线**：main `6897784`；t256 finding（post-commit refresh 误判重复写）
- **结论**：**PASS（无 blocker）**；写提交/刷新拆分消除了 t256 的重复写路径。

## 1. 命令

在 `branches/t247-first-run` 复跑：

- `pnpm typecheck`：0
- `pnpm build`：0（427 modules；css258.43 kB/gzip31.64；js1,274.03 kB/gzip352.02；main1.5MB/preload11.9）
- `pnpm test`：最终 0（**85 文件/727 用例**）
  - 首次全量有既有 openai/watchdog 两个 5s timeout；未改代码复跑 85/727 全绿，与 t247/t255 记录的环境 flake 一致。

worktree clean；PR #39 OPEN/MERGEABLE；无 kernel/data-layer/gate 改动。

## 2. 逐项复核

### t256 F1（high）post-commit refresh 误判 — 已修

- `writeThenRefresh(write, afterCommit)`：只 `write` 成功后才执行刷新；`afterCommit` 抛错返回 `{value, postError}`，不把已提交写操作判失败。
- `handleCreateTask`：
  - `createTask` 成功即 committed；
  - refresh/loadTrace 失败只 pushToast「任务已创建，但刷新失败」，仍 return true；
  - `TaskComposeModal` 关闭，不保留已提交表单，避免用户重提重复。
- `handleSendMessage`：同语义；`MailboxComposeModal` 关闭，toast「邮件已发送，但刷新失败」。
- `writeThenRefresh` 测试：write 一次/refresh 抛错 → value 保留、postError；write 失败 → 不调用 afterCommit，异常上抛。
- `TaskComposeModal` / `MailboxComposeModal` 测试：write 成功 + refresh 抛错 → 关闭、write 1 次；write 失败 → 保留输入。
- **非幂等写不自动重试**：create/send 不挂 retryAction；只有 planConfirm 保留 idempotent 重试；generic ErrorRecoveryBar 显示“刷新/不会重发”。
- **结论**：t256 F1 的重复路径已消除；写失败/刷新的语义分离。

### F2/F3 复审

- **FirstRunCard**：展开外层 `role="region" aria-label="首用就绪"`；content `section#first-run-card-content`；toggle `aria-expanded`/`aria-controls`；测试断言 region。
- **retryActions**：源码 guard 现在还断言 `writeThenRefresh(`、`postError`、两条刷新失败 toast；Task/Mailbox/ writeThenRefresh 组件级测试覆盖实际路径。
- **960**：t253 重拍 main898 填满；旧 saved multi-group 为既有 P0-1。
- **Tasks 空态**：ghost 隐藏；非空 ghost aria secondary；Settings `initialSection` 关闭清空。
- **术语/gate**：ApprovalTerms + Task/Team/Git aria；gate 未改。

### 无回归

- Key 只查当前 provider；`No API key configured` / `API key is not configured` 匹配；双 provider 测试。
- 首用四项/唯一 primary/不弹 Modal；Chat/Team/Tasks/Memory/Mail 空态；1440/960 截图。
- 错误脱敏/单 primary；无敏感新增；无数据层/权限/状态机变更。
- 85/727 全绿。

## 3. 非阻塞观察

- **N1（low）**：`retryActions.test` 仍是源码字符串 guard；真正的 App 级 writeThenRefresh 组合由 `writeThenRefresh.test` + Task/Mailbox 组件测试覆盖，`handleCreateTask` 本身没有 App 实例测试。建议后续补 App 级 mock（不影响本次语义）。
- **N2（low）**：`TaskComposeModal`/`MailboxComposeModal` 的本地 double-submit 没有单独 `submitting` guard，依赖父级 busy prop；当前测试未覆盖极快双击。若要严格防双击，可加局部 guard。
- **N3（info）**：ErrorRecoveryBar 的“查看脱敏摘要”仍展开同一 summary，不提供原始详情/复制；安全取舍，文案已诚实。
- **N4（info）**：本环境首次全量 2 个既有 5s timeout；复跑全绿，建议 CI 仍保留宽限/单跑。

## 4. 判定

t256 F1 已通过 `writeThenRefresh` + form close + postError toast 修复；写失败保留表单、非幂等不自动重试、FirstRunCard region、retryActions 组件断言均成立；三命令 85/727、无 gate/数据层/权限改动。**PASS**，PR #39 可进入集成/合并流程；N1/N2/N3/N4 为 low/信息项。
