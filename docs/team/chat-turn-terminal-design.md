# 对话轮次终态（取消/失败）持久化与重试 · 需求设计（t174）

- **任务**：t174 — 对话轮次终态（取消/失败）持久化与重试
- **阶段**：requirements / round 1
- **基线**：main `c8d241b`（已包含 t168 + t172 历史统一气泡、t170 清空/压缩）
- **范围**：仅新增本文档；不改 `src/`、`electron/`、`test` 或任何生产代码
- **结论**：采用**零 schema、事件为事实源**的最小模型；本轮不引入新表/新列，不改 `ChatMessage` 结构。

---

## 1. 目标与非目标

### 1.1 目标

1. 刷新/重开/切换工作区后，用户能看出每个 assistant 轮次发生了什么：完成、已取消、失败、未完成（旧数据）。
2. 取消或失败**不伪造 assistant 回复**，但保留用户消息、终态原因、发生阶段和可重试信息。
3. 历史状态气泡支持“重试”：**预填并聚焦 composer，不自动发送**；用户确认后才产生新请求。
4. 取消发生在工具调用/审批期间时，能显示阶段和工具名，而不是只把整轮静默丢掉。
5. 当前实时轮次与历史轮次使用同一终态语义，避免重复气泡/重复请求。

### 1.2 非目标（本期不做）

- 不实现“从任意 step 继续执行”或自动重放工具调用。
- 不把用户取消误报为错误，也不把旧数据猜测成取消/失败。
- 不新增 `chat_messages` 的 terminal 列、不新增 turn 表、不迁移旧消息。
- 不做跨会话的重试关系图；重试是新的用户消息/新 turn（见 §6.4）。
- 不改变 provider 错误重试策略、权限模式、审批语义、清空/压缩语义。
- 不持久化翻译或工具原始敏感值；本期只做终态摘要脱敏。

---

## 2. 当前实现盘点与缺口

### 2.1 当前写入顺序（main 基线）

以 `src/kernel/service.ts`、`src/kernel/chatTurnProjection.ts`、`src/kernel/store.ts`、`src/App.tsx` 为准：

`sendChat(workspaceId, content)`：

1. 校验非空、workspace、是否已有 `chatAborts` 锁；
2. 解析 Router、ModelProfile、provider、LLM client；
3. **先持久化 user message**（`store.addChatMessage({ role:"user" })`），此时 userMessageId 已存在；
4. 读取历史、构造 system/context，启动 `runAgentLoop`；
5. 实时回调只发送**临时 ChatEvent**（`delta/reasoning/reasoning_segment/tool_call/tool_result`），同时 best-effort 写 `chat.reasoning`/`chat.tool_call`/`chat.tool_result` 事件；
6. 成功时**再持久化 assistant message**，ingest 交互块，最后发 `done`；
7. 取消时 `cancelChat` 只 abort controller；`sendChat` catch 中若 `controller.signal.aborted` 仅发临时 `cancelled`，返回 `null`，**不写 assistant，也不写持久化终态**；
8. 非取消错误仅发临时 `error` 并重新 throw，**不写 assistant，也不写持久化终态**；
9. `finally` 释放 `chatAborts`。

`cancelChat(workspaceId)` 目前只 `controller.abort()`；不写事件、不生成 synthetic assistant。

`getChatTurns` 当前：

- 以 user/assistant 消息为骨架；事件只取 `chat.reasoning`/`chat.tool_call`/`chat.tool_result`，按 assistant 时间窗口归属；
- **没有终态事件输入**；
- `assistants.length===0 && user` 时直接返回 `status:"error"`（无法区分取消、失败、旧数据/仍在等待）；
- 没有 assistant 时，`buildChatTurns` 会丢弃该 turn 的 reasoning/tool 事件（当前 `if (... targetTurn.assistants.length===0) continue`）；
- 没有 error 摘要、terminal 字段、retryable；
- `ChatTurnStatus` 类型已包含 `"cancelled" | "error" | "pending"`，但 cancelled/pending 基本未产出。

UI 当前：

- `ChatEvent` 的 `cancelled/error` 只触发清空 live、`loadChat()` 和临时 error banner；
- 刷新后没有终态事件可恢复，只有一条 user message；error banner 消失；
- `ChatView` 只按消息渲染 user/assistant，没有 user-only 终态气泡；
- 没有重试入口。

### 2.2 缺口

| 缺口 | 当前后果 |
|---|---|
| user message 已持久化，但没有 userMessageId 返回/事件绑定 | 无法可靠把终态绑定到 turn；只能靠时间窗口 |
| 取消/失败没有持久化终态 | 刷新后不知道是取消、失败还是旧数据；错误摘要丢失 |
| 无 assistant 时 getChatTurns 一律 `error` | 取消 ≠ 失败 ≠ 旧数据 pending；误导 |
| 无 assistant 时丢弃 process 事件 | 工具中取消看不到阶段/工具名 |
| 无 retryable/error summary | 用户无法安全重试，可能重复提问 |
| ChatEvent 无 userMessageId | 实时终态无法与持久化 user message 对齐 |
| 终态若只依赖最近 2000 事件 | 工具事件风暴可能把终态挤出窗口，历史又变成 pending |

---

## 3. 设计决策

### 3.1 零 schema，事件为事实源

- 复用既有 `events` 表（`aggregate_type="chat"`, `aggregate_id=workspaceId`），不新增表/列/索引。
- 新增两个**持久化**事件类型：
  - `chat.turn_cancelled`
  - `chat.turn_error`
- 正常完成仍以 **assistant message** 为事实源；**不新增 `chat.turn_completed`**，避免重复。
- 终态事件是 append-only 审计 + `getChatTurns` 投影输入；不修改/删除 user/assistant 消息。

### 3.2 不伪造 assistant

取消/失败不创建 assistant message；`assistants=[]`。UI 用独立的**终态气泡**表达，不用 assistant bubble，不显示“Router 回复”或任何 synthetic final text。

### 3.3 绑定键

- **权威键**：`userMessageId`（`ChatMessage.id`，user 已先落库）。
- **turnId**：`turn:<userMessageId>`，仅作为稳定展示/投影键。
- 终态事件 payload 同时带 `agentId`；`aggregateId=workspaceId`。
- projection 只用 `userMessageId` 查找终态；**不再用时间窗口给终态事件找 user**。时间窗口仍仅用于旧 process 事件。
- `userMessageId`/`agentId` 与当前页面消息不匹配的事件忽略（保留在 trajectory/审计，不伪造）。

### 3.4 与现有 ChatEvent 的关系

`ChatEvent` 是**实时 renderer 通知**（不落库）；`chat.turn_*` 是**持久化事实**。两者不是替代关系：

- `ChatEvent` 继续保留 `cancelled`/`error`，新增可选字段：
  - `userMessageId?: Id`
  - `terminal?: ChatTurnTerminal`（同一份脱敏摘要）
  - `terminalPersisted?: boolean`
- 服务层在写持久化终态后，再 emit 对应 ChatEvent；UI 可用实时 terminal 立即画状态，刷新后由 `getChatTurns` 重建同一 terminal。
- **不要**把 `chat.turn_cancelled/error` 直接当 renderer 事件推送；renderer 仍消费既有 `ChatEvent` 名称，避免 IPC 行为分叉。
- `done` 不携带 terminal；assistant 落库即完成。

---

## 4. 终态事件数据模型

### 4.1 事件类型与 payload

```ts
type ChatTurnTerminalStatus = "cancelled" | "error";
type ChatTurnStage = "model" | "tool" | "approval" | "persist" | "unknown";

interface ChatTurnTerminalPayload {
  version: 1;
  userMessageId: Id;
  turnId: Id;              // turn:<userMessageId>
  agentId: Id;
  status: ChatTurnTerminalStatus;
  stage: ChatTurnStage;
  /** 规范化错误码，例如 PROVIDER_HTTP_429 / TOOL_ERROR / ABORTED；≤64 */
  code: string | null;
  /** 已脱敏、截断的用户可读摘要；≤500 字符 */
  message: string | null;
  /** 是否建议提供重试入口；不等于自动重试 */
  retryable: boolean;
  /** 发生阶段时的 step；未知为 null */
  step: number | null;
  /** 工具中取消/失败时的最后一个 tool call；否则 null */
  toolCallId: string | null;
  toolName: string | null;  // ≤120
  at: IsoDate;
}
```

事件：

```ts
{
  aggregateType: "chat",
  aggregateId: workspaceId,
  type: "chat.turn_cancelled" | "chat.turn_error",
  actor: "user" | "agent:Router",
  payload: ChatTurnTerminalPayload,
  idempotencyKey: `chat-turn-terminal:${userMessageId}`,
}
```

- `status` 与事件 type 必须一致；投影以 type 为准，status 冗余用于便捷读取。
- `turnId` 必须等于 `turn:<userMessageId>`；不一致的事件视为 invalid，不进入投影（审计保留）。
- `agentId` 必须匹配 user message 的 agentId；跨 workspace 不进入该 workspace 投影。

### 4.2 幂等与只写一次

- 统一使用 `appendEventIdempotent`，**cancelled/error 共用同一个 idempotencyKey**：`chat-turn-terminal:<userMessageId>`。唯一索引保证一个 turn 最多一个终态。
- 先写者生效；重复取消、取消与 error 竞态、IPC 重试都不会写第二条终态。
- `cancelChat` 重复 abort 不产生新事件；`sendChat` catch 只执行一次终态写入。
- 如果事件已存在，读取/返回已有事件，不覆盖；若已有终态与新状态冲突，记录 `chat.turn_terminal_conflict` 审计（可选、零 schema），投影仍取最早 terminal。

### 4.3 写入顺序（目标）

```text
sendChat:
  validate workspace / busy / model
  user = addChatMessage(user)                  # 已存在，保持
  stage = "model"; activeTools = {}; lastTool = null
  try:
    runAgentLoop(callbacks)
      on reasoning              -> stage=model
      on tool.call             -> stage=tool; activeTools.add; lastTool=...
      on tool.result           -> activeTools.delete; stage=activeTools.size?tool:model
      requestApproval          -> stage=approval
    assistant = addChatMessage(assistant)      # 成功后才有 assistant
    ingest...                                  # 失败不改变 done
    emit ChatEvent done                         # 无 terminal
  catch AbortError:
    terminal = persistTerminal("cancelled", stage, lastTool, error=null)
    emit ChatEvent cancelled { userMessageId, terminal, terminalPersisted }
    return null
  catch error:
    terminal = persistTerminal("error", stage, lastTool, sanitize(error))
    emit ChatEvent error { userMessageId, terminal, terminalPersisted }
    throw error
  finally:
    clear activeTools / release chatAborts
```

- 终态写入在 emit 之前；UI 看到实时事件时，DB 已有可刷新终态。
- `terminalPersistFailed`：`persistTerminal` 失败时仍 emit 实时 terminal，但标记 `terminalPersisted=false`；UI 显示“状态未能写入历史”的警告；刷新后按无终态旧数据降级，不伪造。
- **不要在 assistant 成功后写 terminal**；避免 complete 与 terminal 双事实。
- **不要在 user 落库前写 terminal**；没有 userMessageId 的终态无法绑定，直接丢弃/审计。

### 4.4 容量与脱敏

- terminal payload 总量 ≤2 KiB；`message` ≤500 字符、`code` ≤64、`toolName` ≤120；`toolCallId` ≤120。
- 只保存**错误摘要**：不保存 stack、provider 原始 body、请求 headers、user prompt、tool arguments、tool value、文件内容、baseUrl 查询参数中的 key。
- 服务端 `sanitizeTerminalError`：
  - 取 `error.code`/`error.name` → 规范化 `[A-Z0-9_.-]`；否则 `UNKNOWN`；
  - 取 `error.message`，去 ANSI/控制字符、折叠空白、截断 500；
  - 正则脱敏：`sk-...`、`Bearer ...`、`Authorization: ...`、`api[_-]?key=...`、`token=...`、`secret=...`、URL 中的 key/token 查询参数；替换为 `[REDACTED]`；
  - `retryable`：取消固定 true；错误由 `error.retryable === false`/已知永久错误码决定，默认 true；不因 UI 自动重试。
- 投影再做一次 cap/redaction（防御旧事件/手工导入），terminal summary 仍 ≤500。
- 终态事件不参与 `getChatTurns` 的 process 字段容量，但计入 512 KiB 响应总量。

### 4.5 终态事件读取（不依赖 2000 窗口）

当前 `getChatTurns` 只取最近 2000 条 chat 事件。工具/思考事件风暴可能把某 turn 的 terminal 挤出窗口。设计新增只读查询（零 schema）：

```ts
store.listChatTurnTerminalEvents(workspaceId, limit = 500): EventRecord[]
```

- SQL 语义：`aggregate_type='chat' AND aggregate_id=? AND type IN ('chat.turn_cancelled','chat.turn_error') ORDER BY seq DESC LIMIT 500`，返回升序。
- `getChatTurns` 合并 recent 2000 与上述 terminal 事件，按 `event.id` 去重；projection 按 `userMessageId` 绑定。
- 500 为**终态**窗口（远大于页面 40 turn 所需）；超过 500 条的极长历史为 P1，terminal 可缺失 → 该 turn 按旧数据 pending 降级，不伪造。
- 不新增 IPC 方法；`getChatTurns` 返回 page 形状不变，terminal 字段为 additive。

---

## 5. `getChatTurns` 返回模型

### 5.1 新增字段

```ts
interface ChatTurnTerminal {
  status: "cancelled" | "error";
  stage: ChatTurnStage;
  code: string | null;
  message: string | null;   // 已脱敏/≤500
  at: IsoDate;
  retryable: boolean;
  tool: { callId: string; name: string; step: number | null } | null;
  source: "event";
}

interface ChatTurn {
  // 既有字段...
  status: ChatTurnStatus;   // complete | cancelled | error | pending
  /** 仅 durable terminal；旧数据无 terminal 为 null */
  terminal: ChatTurnTerminal | null;
  /** 该 turn 是否可提供“重试”入口；完整回复为 false */
  retryable: boolean;
  /** 无 assistant 且无 terminal：旧数据/未完成，不再静默判 error */
  legacyUnresolved?: boolean;
}
```

`ChatAssistantTurn`/`ChatTurnStep` 结构不变；无 assistant 的 turn 不创建 synthetic assistant。

### 5.2 状态优先级

```text
1. 任一 assistant content 非空且 status=complete -> turn.status=complete
   （terminal 若存在仅作审计，不覆盖 complete；retryable=false）
2. 存在 terminal 事件 -> turn.status=terminal.status（cancelled/error）
3. assistants.length===0 && 无 terminal -> status=pending; legacyUnresolved=true
4. 有 assistant 但无 complete -> status=error（旧数据/空回复；terminal=null）
5. 其余 -> pending
```

- `terminal` 只由 `userMessageId` 绑定，**不按时间窗口**；找不到对应 user message 的 terminal 事件忽略。
- 有 assistant 的 turn：若 terminal 存在但与 complete 冲突，complete 优先（数据修复/竞态保护）；不覆盖正常回复。
- `endedAt`：有 assistant 取最后 assistant `createdAt`；否则有 terminal 取 `terminal.at`；否则 null。
- `retryable`：
  - complete → false；
  - terminal → terminal.retryable；
  - legacy unresolved/error → `Boolean(userMessage?.content.trim())`（可预填，但不自动发送）；
  - 无 user message → false。
- `terminal.code/message` 来自事件且经过投影 cap/脱敏；不要从 assistant content/异常栈临时推断。
- **旧数据**：
  - 只有 user、无 assistant、无 terminal → `pending + legacyUnresolved`，不判 error；
  - 有 assistant、无 terminal → 按 assistant 状态 complete/error；
  - 旧 assistant 空 content → error，`terminal=null`，retryable=true（旧数据降级）。
- **分页/响应容量**：terminal 字段计入 512 KiB；新增终态事件读取独立于 2000 process 窗口；`nextBefore` 仍由当前最早 turn 计算。

### 5.3 无 assistant turn 的 process

- 取消发生在工具调用时，终态事件 payload 的 `stage/toolCallId/toolName/step` 足以在状态气泡显示“工具执行中：读取文件 fs.read (step 2)”。
- 不把无 assistant 的 partial tool 事件强行拼造成 assistant steps（避免伪造回复）；完整 event 仍在 trajectory/审计可见。
- 若后续需要显示 partial tool 列表，作为 P2 additive 字段，不在本期实现。

---

## 6. UI 行为

### 6.1 历史 turn 渲染

`ChatView` 当前按消息列表渲染。新增：

- `turnByUserMessageId = Map<userMessageId, ChatTurn>`（来自 `chatTurns`），与现有 `turnByAssistant` 并存。
- 每个 **user message** 后渲染 `<ChatTurnTerminalBubble>`，仅在 `turn.terminal`（或 `legacyUnresolved`）存在时：
  - 历史 assistant 的 process 仍由 `turnByAssistant` 渲染；
  - 终态气泡**不替换** user message；
  - 终态气泡**不渲染 assistant 内容/头像**，使用 `role="status"`/`role="alert"` 的状态行。
- 无 assistant、无 terminal 的旧 turn：在 user 后显示低对比度“未完成（旧数据）”，不显示错误码；可选重试。
- 加载失败：沿用现有 `message.reasoning` 降级；不显示伪造终态。

### 6.2 终态气泡

```text
[! 已取消]  用户停止 · 模型回复中 / 工具执行中：读取文件 fs.read · 12:31
             [重试]

[! 回复失败]  PROVIDER_HTTP_429 · 请求过于频繁（已脱敏）
             阶段：模型回复 · 12:31
             [重试]
```

- 取消：`role="status"` + `aria-live="polite"`；标题“已取消”；stage 中文：
  - `model` → “模型回复中”
  - `tool` → `工具执行中${toolName ? `：${toolName}` : ""}`
  - `approval` → “等待审批”
  - `persist` → “保存回复中”
  - `unknown` → “执行中”
- 错误：`role="alert"` + `aria-live="assertive"`；标题“回复失败”；显示 code + message；错误摘要为空显示“未提供错误详情”；不显示 stack。
- 旧数据 unresolved：`role="status"`；标题“未完成（旧数据）”；无 error code；提示“该轮没有终态记录”。
- retry 按钮：
  - `disabled = !turn.retryable || chatBusy`；
  - `aria-label="重试这条消息"`；
  - 点击只触发 `onRetryTurn(turn.userMessage.content)`；**绝不直接调用 sendChat**。
  - live/history 同一组件，避免重复实现。

### 6.3 实时状态与去重

- 服务层 terminal 事件同时发既有 `ChatEvent.cancelled/error`，新增 `userMessageId` + `terminal`。
- `App` 保存 `liveTerminal: Map<userMessageId, ChatTurnTerminal>`：
  - 收到 cancelled/error 时设置；立即在最后 user 行后显示状态；
  - `done` 不产生 terminal；
  - `loadChat` 返回后，用 `chatTurns` 的 terminal 作为事实源；同一 `userMessageId` 的 live 项删除，防止双气泡；
  - live terminal 只在当前 workspace/agent 匹配时显示；切换工作区清空。
- **实时不重复**：live bubble 只在没有历史 terminal 时显示；历史 terminal 到达后由历史气泡接管。`ChatEvent` 不持久化，刷新后不可依赖。
- 当前 `ChatEvent cancelled/error` 清空 stream/reasoning/tools/segments 后 loadChat；保留。新增 terminal 字段不改变清空行为。

### 6.4 重试交互（推荐方案）

- 推荐：**历史/实时终态气泡的“重试”只预填 composer 并聚焦，不自动发送**。
- 点击：
  1. 若 `chatBusy`/`contextBusy`：不操作；
  2. 取 `turn.userMessage.content.trim()`；空则禁用；
  3. 若 composer 为空：填入原文；若 composer 已有不同内容：**不覆盖**，仅聚焦并提示“输入框已有内容，请确认后粘贴/替换”；若相同：仅聚焦；
  4. `pushToast({kind:"info", message:"已填入输入框，确认后发送"})`；
  5. `focus()` composer；不调用 `sendChat`、不写事件、不创建消息。
- 用户确认发送后，走既有 `sendChat`：
  - 新建 user message（同文）→ 新 turn；旧终态仍保留为历史事实；
  - 旧 turn 不复用、不改写；新 turn 成功后旧气泡仍可查看；
  - 不自动删除/隐藏旧 terminal，避免“重试即抹掉失败历史”。
- **幂等/防重复**：
  - 单击/双击重试只预填，不产生 message/event；
  - 发送按钮复用 `chatBusy` 和 service `chatAborts` 锁；不会并发创建两个请求；
  - 用户确认发送一次 = 一条新 user + 一次新 assistant（或新 terminal）；
  - 本期不持久化 `retryOf` 关系；若产品后续需要“已重试”标记，再以 additive `chat.turn_retry` 事件扩展（非本期 AC）。

### 6.5 错误摘要/可访问性

- 错误摘要用 terminal.message/code；不使用全局 error banner 作为唯一反馈（刷新会丢）。
- 全局 error banner 仍可显示一次（现有行为）；终态气泡持久展示。
- 错误气泡 `aria-live=assertive`，取消/旧数据 `polite`；不要把 `role=alert` 放到所有历史气泡上，避免重复播报。
- retry 按钮是原生 `<button>`，有 focus-visible，不自动抢焦点（用户点击/键盘触发除外）。

---

## 7. 状态机与边界

### 7.1 生命周期

```text
idle
  └─ sendChat 校验通过 + user 落库 → sending(userMessageId)
       ├─ model/tool/approval 活动 → running(stage)
       │    ├─ assistant 落库 → complete（无 terminal）
       │    ├─ controller.abort → cancelled(terminal) + ChatEvent
       │    └─ 非 abort 异常 → error(terminal) + ChatEvent + throw
       └─ user 落库前异常 → no turn（无 terminal）
```

- `complete` 只由 assistant content 非空的事实产生；不写 `chat.turn_completed`。
- `cancelled`/`error` 由 terminal 事件产生；同一个 userMessageId 最多一个。
- 旧数据/无 terminal 的 user-only turn：`pending + legacyUnresolved`，不参与终态推断。

### 7.2 刷新/重开

1. `getChatTurns` 读 messages + terminal events；
2. 每个 user 后若 terminal → 状态气泡；若 legacy unresolved → 旧数据提示；
3. 无 assistant/terminal 的 turn **不丢弃**（user message 保留，status pending）；
4. live terminal 清空，历史 terminal 接管；
5. 刷新不会重发请求，不会自动重试。

### 7.3 清空/压缩

- `clearChatContext`：删除当前 agent 的 chat_messages/artifacts/questions；事件日志保留。terminal 事件对已删除 user 的绑定变为 orphan，`getChatTurns` 忽略，绝不为已清空对话重造气泡。
- `compactChatContext`：删除较早消息并插入 system 摘要；被压缩掉的 user/turn 的 terminal 事件成为 orphan，忽略；保留在最近窗口的 canceled turn 仍显示终态。
- 清空/压缩在 `chatAborts` 运行时仍按当前逻辑拒绝（chat is already running）；用户需先取消，终态写入后再清空。
- 清空/压缩不删除 terminal 事件（append-only 审计）；也不因事件存在而复活消息。

### 7.4 工具中取消/失败

- `tool.call` 时 stage=tool、lastTool=call；`tool.result` 后 activeTools 移除，stage 回 model（lastTool 仅在 active 时用于显示）。
- 取消发生在 tool 执行中：terminal.stage=tool、toolCallId/toolName/step 写入；不创建 assistant；UI 显示“工具执行中：<中文名>”，可重试。
- 工具结果 late/after abort：不再写 terminal；late event 留在 trajectory；投影只因 userMessageId 绑定 terminal，不把它拼造 assistant。
- 审批中取消：stage=approval；terminal 仍无 assistant；不取消审批记录本身（审批超时/取消由原逻辑处理）。

### 7.5 错误与重试成功

```text
error terminal (user U1)
  └─ 用户点重试 → composer 预填（无新消息）
       └─ 用户发送 → user U2 + run
            ├─ 成功 → assistant A2 / U2 complete；U1 error terminal 保留
            └─ 失败 → U2 error terminal；U1 保留
```

- U1 终态是历史事实，不因 U2 成功而改写/删除。
- U2 不会自动带上 U1 的 assistant/上下文；沿用普通 sendChat 上下文。
- 不自动把 U1 标成“已重试”；本期无 retry relation 持久化。
- 重试一次失败后再次重试产生 U3；每个 user 消息独立终态，不互相覆盖。

### 7.6 取消/错误竞态

- `sendChat` catch 只处理一个分支；`cancelChat` 只 abort。
- terminal 共用 idempotencyKey；即使 cancel 后 error 也只有一个 terminal。
- 若 terminal 写入失败：实时 ChatEvent 仍显示，`terminalPersisted=false`；刷新按 legacy pending 降级，不猜测；记录一次 UI toast/审计（见风险 R1）。
- 若 user 消息写入成功、进程在 run 前崩溃：没有 terminal；旧数据 pending；不伪造成 error。
- 若 assistant 已写入、进程在 done 前崩溃：assistant complete，按 complete；无 terminal；安全。

### 7.7 旧数据

| 数据形态 | status | terminal | retryable | UI |
|---|---|---|---|---|
| user + assistant content | complete | null | false | 正常历史回复 |
| user + assistant 空 content | error | null | true | 旧失败气泡 |
| user only，无 terminal | pending | null | true（legacyUnresolved） | 未完成（旧数据） |
| user only + terminal cancelled | cancelled | event | true | 已取消 |
| user only + terminal error | error | event | 依 payload | 回复失败 |
| assistant + terminal（异常竞态） | complete 优先 | 保留审计 | false | 正常回复，不重复状态气泡 |

- 不根据旧代码的 `error`（user-only）推断历史是失败，因为旧版本取消也走同一形态。
- 旧 terminal 不在 2000 process 事件窗口时，按 pending/legacy 处理；不伪造。

### 7.8 跨 workspace/agent

- terminal event 的 aggregateId=workspaceId；payload.agentId 必须等于 user message agentId；
- `getChatTurns(workspaceId, agentId)` 只读该 workspace/agent；terminal 查询同 workspace 过滤；
- 其他 workspace/agent 的 terminal 不进入当前页；API 仍校验 agent 属于 workspace；
- 跨 workspace 测试：另一 workspace 的 user 消息 ID/terminal ID 不能重用/读取。

---

## 8. 测试计划

### 8.1 服务层终态投影（unit）

| ID | 场景 | 断言 |
|---|---|---|
| T-01 | user + cancelled terminal | status=cancelled；terminal 字段完整；无 assistant；retryable |
| T-02 | user + error terminal | status=error；code/message 脱敏截断；stage/tool 保留 |
| T-03 | user + terminal + assistant complete | complete 优先；不重复气泡；terminal 审计存在但不覆盖 |
| T-04 | user only 无 terminal | pending + legacyUnresolved；不判 error；user 不丢 |
| T-05 | 旧空 assistant 无 terminal | error；terminal=null；retryable |
| T-06 | terminal 事件重复/取消+error 竞态 | 只返回一个 terminal（最早）；事件只一条 |
| T-07 | terminal 被 2001 条 process 事件挤出 recent 窗口 | terminal 查询仍能绑定；状态不丢 |
| T-08 | terminal userMessageId 不存在/已清空 | 忽略；不造 turn/assistant |
| T-09 | 跨 workspace/agent terminal | 不进入当前页 |
| T-10 | terminal 计入 512KiB / nextBefore | 响应仍 ≤512KiB；分页不丢 |
| T-11 | 旧 step/sequence/process | 与 t168 既有投影不回归 |

### 8.2 sendChat/cancelChat 写入顺序（service）

| ID | 场景 | 断言 |
|---|---|---|
| T-12 | 正常成功 | user 先落库、assistant 后落库；无 terminal；done |
| T-13 | 模型阶段取消 | user 保留；assistant 不存在；terminal cancelled/stage=model；ChatEvent.userMessageId 正确 |
| T-14 | 工具阶段取消 | terminal stage=tool + toolName/callId；无 assistant；工具事件仍在 trajectory |
| T-15 | 审批阶段取消 | terminal stage=approval；无 assistant |
| T-16 | provider/异常失败 | terminal error；用户摘要已脱敏；无 assistant；throw 保留 |
| T-17 | 取消后再次取消/取消与错误竞态 | idempotencyKey 只一条 terminal；无重复事件 |
| T-18 | 取消/失败后刷新 | getChatTurns 返回 terminal；不是 pending；用户消息仍在 |
| T-19 | 重试成功 | 新 user/assistant；旧 terminal 保留；无自动重发 |
| T-20 | terminal 写入失败模拟 | ChatEvent 标记未持久化；刷新 legacy pending；UI 不伪终态 |
| T-21 | 清空/压缩 | terminal orphan 忽略；不复活消息；运行中仍拒绝 |

### 8.3 UI/刷新/重试（component/integration）

| ID | 场景 | 断言 |
|---|---|---|
| T-22 | 历史 canceled/error | 状态气泡出现在 user 后；无 assistant 气泡；ARIA role/live 正确 |
| T-23 | 刷新 | 状态/错误摘要/重试入口仍在 |
| T-24 | 实时 cancelled/error + loadChat | 只一个状态气泡（live 被历史接管）；无重复 |
| T-25 | 点重试 | composer 预填+focus；不发送、不写事件、不建消息 |
| T-26 | composer 已有不同内容 | 不覆盖；提示；仍聚焦 |
| T-27 | 双击重试/连点发送 | 不发生重复请求/重复 user；busy 期间禁用 |
| T-28 | 重试成功 | 旧终态保留、新完成 turn 显示；无自动二次发送 |
| T-29 | 旧数据无 terminal | 显示“未完成（旧数据）”；可重试但无错误码 |
| T-30 | 错误消息脱敏 | 不出现 key/token/stack；500 字符截断 |
| T-31 | 工具中取消 | 显示阶段/工具中文名；不显示“生成中”假状态 |

### 8.4 命令与回归

- `pnpm typecheck`、`pnpm build`、`pnpm test` 必须 0；目标新增测试不改变现有 51 files/560 tests 基线。
- `getChatTurns`/trajectory/context/clear/compact 既有测试不回归。
- 测试使用 fake clock/可控 AbortController/provider error；不依赖真实网络。
- 事件查询测试覆盖 terminal 与 process 事件混合、去重、500 上限、workspace 隔离。

---

## 9. 文件面（后续实现，不在本任务改）

| 文件 | 预期变化 |
|---|---|
| `src/shared/types.ts` | `ChatTurnTerminal`/stage/status；`ChatTurn.terminal/retryable/legacyUnresolved`；`ChatEvent` 可选 userMessageId/terminal |
| `src/kernel/service.ts` | sendChat 捕获 user id/stage；cancel/error 持久化 terminal；ChatEvent 带 terminal；getChatTurns 合并 terminal |
| `src/kernel/chatTurnProjection.ts` | terminal 绑定、状态优先级、错误 cap/脱敏、无 assistant 不丢弃 |
| `src/kernel/store.ts` | `listChatTurnTerminalEvents`（只读查询，零 schema） |
| `src/App.tsx` | turnByUser、terminal 气泡、live terminal、重试预填/focus |
| `src/styles.css` | 终态状态气泡、窄窗/键盘/focus-visible |
| `src/kernel/chatTurn*.test.ts(x)` | T-01…T-31 |
| `src/kernel/service.test.ts` / `chatContext.test.ts` | 写入顺序、清空/压缩/跨 workspace 回归 |
| `docs/team/chat-turn-terminal-design.md` | 本文 |

- **无 schema 迁移**；不改 `chat_messages`；不新增 IPC channel（`chat:turns` 继续返回扩展 DTO）。
- 若实现需要给 `ChatEvent` 加字段，属于 IPC 类型 additive，不改变现有 renderer 的事件名。
- 不改 permissions/approval/kernel scheduler。

---

## 10. 风险与缓解

| ID | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | terminal 事件写失败 | 刷新丢失终态 | 同步 `appendEventIdempotent`；失败时 ChatEvent 标记未持久化 + UI 警告；刷新按 legacy pending；测试模拟 DB 失败 |
| R2 | 取消/错误竞态 | 双 terminal | 共用 idempotencyKey；catch 单分支；重复测试 |
| R3 | stage 不准确 | 显示错误阶段 | 只以 tool.call/result、approval、persist 明确事件推进；未知显示“执行中”；不猜工具参数 |
| R4 | terminal 被 2000 process 窗口挤出 | 刷新 pending | 独立 terminal 查询（500）；测试 T-07 |
| R5 | 旧数据无终态 | 误判取消/失败 | pending + legacyUnresolved；不猜；UI 明示旧数据 |
| R6 | 清空/压缩产生 orphan terminal | 幽灵气泡 | projection 必须按当前 user message 过滤；测试 T-21 |
| R7 | 重试重复请求/消息 | 重复 turn | 仅预填；不自动 send；busy 锁；双击测试 |
| R8 | 错误摘要泄露密钥/stack | 安全/隐私 | 服务端脱敏 + cap；投影二次 cap；T-30 |
| R9 | terminal 与 assistant 双写 | 双气泡 | 正常完成不写 terminal；complete 优先；异常竞态测试 |
| R10 | 事件查询性能 | getChatTurns 变慢 | terminal 索引复用 events 现有索引；limit 500；只读 |
| R11 | 取消后仍收到 late tool | 假过程 | terminal 后忽略 late process；trajectory 保留审计 |
| R12 | 进程崩溃在 terminal 前 | 无法恢复终态 | 按旧数据 pending；不伪造；P1 可加 turnId 事件 |

---

## 11. 验收标准（AC）

- **AC-01**：`sendChat` 在 user 落库后捕获 `userMessageId`；取消/失败不创建 assistant message。
- **AC-02**：新增 `chat.turn_cancelled`/`chat.turn_error` 持久化事件，payload 含 userMessageId/turnId/agentId/status/stage/code/message/retryable/step/tool/at。
- **AC-03**：终态事件使用 shared idempotencyKey；一个 userMessageId 最多一个 terminal；重复取消/竞态不重复。
- **AC-04**：终态事件不新增 schema/表/列；事件走既有 `events` 表。
- **AC-05**：terminal 按 userMessageId 绑定，不按时间窗口；不匹配的消息/agent/workspace 被忽略。
- **AC-06**：`getChatTurns` 返回 `terminal`、`retryable`、`legacyUnresolved`；无 assistant 无 terminal 为 pending，不再判 error。
- **AC-07**：cancelled/error turn 刷新后仍有状态气泡、错误摘要（脱敏/≤500）、阶段和工具名。
- **AC-08**：旧数据无 terminal 不被猜测；无 assistant turn 不静默丢弃；旧空 assistant 仍 error。
- **AC-09**：取消发生在工具/审批中时，stage 与 toolName 正确；不伪造 assistant/工具结果。
- **AC-10**：UI 历史/实时只渲染一个终态气泡；live terminal 被历史 terminal 接管，无重复。
- **AC-11**：重试按钮只预填并聚焦 composer，不自动 send、不自动建消息/事件。
- **AC-12**：composer 非空时不覆盖；提示并聚焦；用户可取消。
- **AC-13**：双击重试/连续操作不产生重复 user/请求；busy 期禁用。
- **AC-14**：发送后新 user/assistant 或新 terminal；旧 terminal 保留，不自动改写。
- **AC-15**：清空/压缩后，已删除消息的 terminal 不产生幽灵气泡；运行中仍拒绝清空/压缩。
- **AC-16**：terminal 事件读取独立于 2000 process 窗口；工具风暴后终态仍可投影。
- **AC-17**：错误摘要脱敏 key/token/Authorization/URL 参数，不含 stack/provider body/tool args。
- **AC-18**：512 KiB 响应上限与 `nextBefore` 不因 terminal 字段回归。
- **AC-19**：跨 workspace/agent terminal 拒绝/隔离，不能读取他 workspace 状态。
- **AC-20**：测试覆盖 T-01…T-31；`pnpm typecheck`/`build`/`test` 全绿。

---

## 12. 实施顺序与回滚

1. 类型 + `store.listChatTurnTerminalEvents`（只读）。
2. `sendChat` user id/stage/terminal 写入 + ChatEvent 扩展。
3. projection terminal 绑定/状态优先级/脱敏。
4. UI 终态气泡 + 重试预填 + live 去重。
5. 测试 T-01…T-31；文档更新 implementation/verification。
6. 回滚：停用 terminal 读取/UI 仅按 assistant 状态；事件 append-only 保留但不影响旧 UI；无 schema 迁移。

## 13. 待确认（不阻塞本轮）

- `retryable=false` 的永久错误码清单（如配置缺失/权限拒绝）由实现按 provider 错误映射；默认 true。
- 是否在本期之后增加 `chat.turn_retry` 关系事件（“已重试”标记）；本期不做。
- terminal 事件 500 条窗口是否足够；P1 可提高到 1000 或按 turn 分页查询。
- 审批阶段 stage 的 hook 需要工具审批回调包装；实现时确认 `requestApproval` 包装不影响权限/超时语义。
