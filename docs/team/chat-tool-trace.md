# Chat 工具调用过程（t173）

## 目标

Router 对话中的工具调用不再只在后台执行，而是在对话内实时展示，接近 DSH 的工具过程视图。

## 展示

- 工具调用区位于对话消息下方，标题「工具调用」；
- 每次调用显示：
  - 工具名（`fs.list`、`fs.read`、`shell.run` 等）；
  - 参数 JSON；
  - 状态：运行中 / 完成 / 失败；
  - 返回值 JSON（截断到 4000 字符）；失败显示错误；
- 每个工具可折叠；运行中/错误默认展开；
- 工具调用过程随对话状态实时更新，完成后保留到下一次发送或清空/压缩上下文。

## 实现

- `ChatEvent` 新增 `tool_call` / `tool_result`；
- `sendChat` 的 `runAgentLoop` 注入 `onEvent`，把 `tool.call`/`tool.result` 转成 chat 事件；
- App 维护 `chatTools` 状态，按 callId 合并调用与结果；
- ChatView 渲染 `chat-tool-trace`，参数/结果 JSON 本地格式化、截断；
- 工具名经 t172 wire 编解码后，UI 显示内部名。

## 边界

- 工具过程是实时会话状态，刷新/重开应用后不保留；任务 Run 的工具过程仍由 RunHistory/trace 持久化。
- 不在 UI 中执行任何工具；权限/审批仍在服务端。
