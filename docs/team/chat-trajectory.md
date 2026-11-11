# Chat / Trajectory（t175）

## 对话

参考 DSH 的对话视图，Router 面板顶部新增：

- `对话`：消息、工具调用过程、composer；
- `轨迹`：按时间排序的只读运行轨迹账本。

切换轨迹时加载账本；轨迹打开后自动跟随尾部。轨迹视图隐藏 composer，点击「对话」返回。

## 同一轮对话内的执行过程（t177）

当前轮次的 assistant 气泡内包含：

- 思考段（按 step）；
- 该 step 的工具调用/结果；
- 最终回复正文。

结构：

```text
[Router 气泡]
  执行过程
    step 1
      思考
      fs.list 参数/结果
    step 2
      思考
      fs.read 参数/结果
  最终 Markdown 回复
```

执行过程默认展开，可整体折叠；工具项仍可单独折叠。历史轮次在 Chat 中只保留最终回复，完整工具/思考分段在「轨迹」查看。

### 自动折叠与工具名称（t178）

- 工具调用：运行中自动展开；结果到达后自动折叠；
- 思考 step：运行中/当前 step 展开；step 结束（工具完成或最终回复结束）后自动折叠；
- 用户手动重新展开后不会被普通重渲染强制关闭；
- 工具显示中文名称 + 原始工具 id，例如 `读取文件 fs.read`、`执行命令 shell.run`；
- 轨迹中的工具标题同样使用中文名称，原始 id 保留在 `title` 提示中。

### 思考自动机翻（t179）

- 每个 step 的思考完成后，自动翻译为简体中文；
- 默认使用 **Bing Web Translator**：`bing.com/translator` 页面令牌 + `/ttranslatev3`，无需 API key；
- 优先 `cn.bing.com`，失败回退 `www.bing.com`；令牌过期/空响应会刷新一次；
- 按 900 字符切块，段落/句末优先；内存缓存最近 300 条；
- 已是中文的思考跳过翻译；
- 失败只显示“机翻失败”，不影响原文；
- 隐私：思考文本会发送到 Bing 翻译服务。

### 思考显示切换（t180）

思考块展开后，标题右侧显示 `原文 / 译文` 切换：

- 默认「译文」（翻译完成后）；未完成/失败/中文跳过时显示原文并提示状态；
- 切到「原文」看原始思考；
- 切换按钮只在思考块展开时显示；
- 每个思考段独立记忆自己的显示选择；
- 翻译完成后自动从原文切到译文，用户手动选择后保持。

## 轨迹账本

每条记录包含时间、类型、标题、状态和正文：

- 对话：用户 / 助手 / 系统摘要 / 上下文操作（来自 `chat_messages` 与 context 事件）；
- 思考：**每个模型 step 一条** `chat.reasoning` 事件，排在对应 step 的工具调用前；
  - 旧会话没有 reasoning 事件时，回退到 assistant 消息的 `reasoning`；
- 工具：`chat.tool_call` 参数与 `chat.tool_result` 结果/错误；均带 `step`；
- 同一秒内的事件按事件 `seq` 排序，保证「思考 → 工具调用 → 工具结果 → 下一次思考」的顺序。

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
