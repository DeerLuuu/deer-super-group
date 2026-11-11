# Chat / Trajectory（t175）

## 对话

参考 DSH 的对话视图，Router 面板顶部新增：

- `对话`：消息、工具调用过程、composer；
- `轨迹`：按时间排序的只读运行轨迹账本。

切换轨迹时加载账本；轨迹打开后自动跟随尾部。轨迹视图隐藏 composer，点击「对话」返回。

## 轨迹账本

每条记录包含时间、类型、标题、状态和正文：

- 对话：用户 / 助手 / 系统摘要 / 上下文操作（来自 `chat_messages` 与 context 事件）；
- 思考：助手消息的 `reasoning`，独立成行并排在对应回复前；
- 工具：`chat.tool_call` 参数与 `chat.tool_result` 结果/错误。

轨迹顶部提供分类过滤：

```text
全部 / 对话 / 思考 / 工具
```

三类行使用不同标记色：对话绿、思考紫、工具蓝。

工具调用与结果通过 callId 关联；工具调用在有结果后显示完成/失败，否则显示运行中。

## 实现

- `ChatTrajectoryEntry` 类型（含 `reasoning`）；
- `AppService.getChatTrajectory`：消息 + reasoning + 事件日志只读投影；
- `sendChat` 的 tool 事件同时写入 `events`（`chat.tool_call` / `chat.tool_result`），持久化后轨迹可回看；
- IPC/preload：`chat:trajectory`；
- App 状态 `chatView/chatTrajectory`；ChatView 新增 tab、`ChatTrajectoryPanel`；
- 轨迹账本 CSS 采用时间轴 + 记录卡片。

## 测试

- `chatContext.test.ts` 新增轨迹投影测试：消息与工具事件按时间排列，工具状态关联；
- typecheck/build/test。

## 边界

- 轨迹是只读投影，不写事件、不改变对话；
- 历史工具调用只有本次改动之后的事件会持久化；更早的工具过程只在实时 `chatTools` 中可见；
- 轨迹不替代任务 RunHistory；任务工具事件仍由内核事件流持久化。
