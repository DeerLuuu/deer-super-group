# 对话上下文命令（t170）

## 使用方式

对话输入框支持两个斜杠命令，也可用标题栏按钮：

| 命令 | 按钮 | 行为 |
|---|---|---|
| `/clear` / `/清空` | 清空 | 删除当前 Router 对话消息、画布索引与提问；事件日志保留 |
| `/compact` / `/压缩` | 压缩 | 保留最近 8 条，较早消息合并为一条 `system` 摘要 |

- `/clear` 有消息时会二次确认；运行中对话需先停止。
- 输入框 placeholder 与底部提示直接展示命令。
- 压缩摘要以 System 气泡显示，并在下一次发送时并入 system 上下文，不会被当作普通 user turn。

## 实现

- Store：
  - `clearChatContext(workspaceId, agentId)` 事务清理 `chat_messages`、`chat_artifacts`、`chat_questions`，写 `chat.context_cleared`。
  - `compactChatContext(workspaceId, agentId, 8)` 删除较早消息，插入 createdAt 早于最近窗口的 system 摘要，写 `chat.context_compacted`。
- Service：
  - `clearChatContext(workspaceId)` / `compactChatContext(workspaceId)`；
  - 运行中拒绝；
  - `sendChat` 把 system 摘要并到顶部 system prompt，只把 user/assistant 作为对话 turn。
- IPC/preload：`chat:clear-context`、`chat:compact-context`。
- UI：ChatView 标题栏「压缩 / 清空」，输入框命令提示；App 拦截命令并刷新对话。

## 测试

- `src/kernel/chatContext.test.ts`：
  - 清空消息并记录事件；
  - 压缩 12 条为 8 条 + system 摘要，摘要排在最近消息之前；
  - 消息不足时 no-op。
- `pnpm typecheck` / `pnpm build` / `pnpm test`。

## 边界

- 压缩是本地抽取式摘要（近期目标/助手结论），不额外调用模型；不改变任务/内核上下文。
- 画布/提问清空是删除索引；事件审计保留。
