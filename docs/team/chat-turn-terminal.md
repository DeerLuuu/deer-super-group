# 对话轮次终态（取消/失败）持久化与重试实现（t175）

- **任务**：t175 — 实现取消/失败轮次持久化、历史状态与重试
- **设计**：`docs/team/chat-turn-terminal-design.md`（t174，Captain 已确认口径）
- **分支**：`feature/t175-chat-turn-terminal`（基于 main `c8d241b`）
- **范围**：`src/App.tsx`、`src/kernel/`、`src/shared/types.ts`、`src/shared/ipc.ts`、`electron/main.ts`、`electron/preload.ts`、`src/styles.css`、`docs/team/`
- **零 schema**：复用 `events`；不新增表/列/IPC channel（`chat:turns` DTO additive）

---

## 1. 交付摘要

- `sendChat` 在 user message 落库后捕获 `userMessageId`，跟踪 `stage`（model/tool/approval/persist）与当前 tool。
- `cancelChat` 仍只 abort；`sendChat` catch 在 emit 实时事件前写持久化终态：
  - `chat.turn_cancelled` / `chat.turn_error`；
  - payload 绑定 `userMessageId` + `turnId=turn:<userMessageId>` + `agentId`；
  - `idempotencyKey=chat-turn-terminal:<userMessageId>`，cancelled/error 共用一个，保证一 turn 一终态；
  - message ≤500、code ≤64、tool name/callId ≤120、payload ≤2KiB；服务端与投影双重脱敏。
- `getChatTurns` 独立读取终态事件（默认 500 条），与 2000 条 process 事件合并去重；按 `userMessageId` 权威绑定。
- 状态优先级：`complete > terminal > pending`；无 assistant 且无 terminal 的旧数据为 `pending + legacyUnresolved`，不再判 `error`。
- `ChatTurn` 新增 `terminal/retryable/legacyUnresolved`；无 assistant turn 不丢 user message、不伪造 assistant。
- UI 新增 `ChatTurnTerminalBubble`：
  - 取消：`role=status` / `aria-live=polite`，标题「已取消」，阶段 + 工具中文名；
  - 错误：`role=alert` / `aria-live=assertive`，标题「回复失败」，code + 脱敏 message + 阶段；
  - 旧数据：`pending + legacyUnresolved` 显示「未完成（旧数据）」；
  - 历史/实时同一组件；历史 terminal 优先于 live terminal，防双气泡。
- 重试按钮只预填 composer + focus：不自动发送、不覆盖已有草稿、双击不产生新消息/事件；busy 时 disabled。
- clear/compact 删除消息后 terminal 变 orphan，投影忽略，不复活气泡。

## 2. 数据结构

`src/shared/types.ts`：

```ts
type ChatTurnTerminalStatus = "cancelled" | "error";
type ChatTurnStage = "model" | "tool" | "approval" | "persist" | "unknown";

interface ChatTurnTerminal {
  status; stage; code: string | null; message: string | null; at;
  retryable: boolean;
  tool: { callId; name; step: number | null } | null;
  source: "event";
}

interface ChatTurn {
  // existing...
  status: "complete" | "cancelled" | "error" | "pending";
  terminal: ChatTurnTerminal | null;
  retryable: boolean;
  legacyUnresolved?: boolean;
}
```

`ChatEvent.cancelled/error` 仅 additive 增加：

```ts
userMessageId?: string;
terminal?: ChatTurnTerminal;
terminalPersisted?: boolean;
```

事件仍是既有 events 表；不注册新的 Kernel zod 事件，不改变 renderer 事件名。

## 3. 写入与绑定

```text
sendChat:
  user = addChatMessage(user)            # userMessageId 已存在
  stage=model; activeTools={}; lastTool=null
  runAgentLoop:
    reasoning        -> stage=model（无 active tool）
    tool.call        -> stage=tool; activeTools.add; lastTool
    tool.result      -> activeTools.delete; 未 abort 时 stage=model/lastTool=null
    requestApproval  -> stage=approval（finally 未 abort 恢复）
  success:
    stage=persist; add assistant; ingest; emit done（不写 terminal）
  abort:
    persistTerminal(cancelled, stage, lastTool)
    emit cancelled { userMessageId, terminal, terminalPersisted }
  error:
    persistTerminal(error, stage, lastTool, sanitized error)
    emit error { ... }
```

- `appendEventIdempotent` 先写 DB，再 emit；重复取消/取消+错误竞态只保留最早一条。
- 写入失败：仍 emit 内存 terminal，`terminalPersisted=false`；刷新按旧数据 pending 降级，不伪造。
- 不写 `chat.turn_completed`；assistant 落库即 complete。

## 4. 投影与分页

- `getChatTurns` 合并 `listRecentChatEvents(2000)` 与 `listChatTurnTerminalEvents(500)`，按 event.id 去重，按 seq 排序。
- terminal 校验：type/status、`turnId === turn:userMessageId`、payload.agentId 与当前 agent 一致；不匹配忽略。
- terminal 计入 512KiB 响应预算；nextBefore/响应裁剪沿用 t172 逻辑。
- 旧 `user only` 无 terminal → `pending + legacyUnresolved`；空 assistant 无 terminal → `error, terminal=null, retryable=true`。

## 5. UI

- `ChatView` 新增 `turnByUser`、`liveTerminals`、`onRetryTurn`、`composerRef`。
- 每条 user message 后渲染终态气泡（若有 terminal / legacyUnresolved / 旧空 assistant error）：
  - 历史 terminal 存在时不显示 live；
  - complete turn 即使有审计 terminal 也不显示状态气泡；
  - 不创建 assistant 行。
- 重试：
  - `retryComposerState(current, retry)` 纯函数：空→填入；不同→保留并提示；相同→只提示；
  - App 只 setChatInput + focus + toast，不调用 sendChat；
  - `busy` 时按钮 disabled。
- 错误摘要来自 terminal，不使用全局 banner 作为唯一反馈；不显示 stack/provider body/tool args。

## 6. 测试与验证

新增/更新：
- `src/kernel/chatTurnProjection.test.ts`：cancelled/error 投影、无 assistant 不伪造、complete 优先、旧 pending、无效 user/turn/agent 绑定、错误脱敏。
- `src/kernel/chatTurnService.test.ts`：terminal 独立窗口（2001 process 后仍可读）、clear/compact orphan、跨 workspace/agent。
- `src/kernel/chatTurnTerminalService.test.ts`：真实 `sendChat` + 本地慢流服务取消写 cancelled；provider 失败写 error；工具中取消 stage/tool；idempotency 竞态；正常成功不写 terminal；clear/compact；retry 后旧终态保留。
- `src/kernel/chatTurnUi.test.tsx`：历史/实时终态气泡、ARIA、无 assistant、重试只预填、busy 禁用、live/history 去重、旧数据 pending、错误降级。
- 截图：`docs/team/t175-chat-terminal.png`（取消于工具阶段，历史气泡显示「已取消」/「工具执行中：读取文件」/「重试」）。
- 既有 51 files/560 tests 基线保持；本轮新增至 **52 files / 576 tests**。

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0（406 modules；css 245.15 kB / gzip 29.52；js 1,223.51 kB / gzip 335.10；main 1.5mb、preload 11.7kb）
pnpm test        # exit 0（52 files / 576 tests）
```

## 7. 风险 / P1 / 回滚

- P1：terminal 500 条窗口；极长历史更早 terminal 缺失时按 pending 降级。
- P1：无 `chat.turn_retry` 关系；“重试成功”以新 user/assistant 表达，旧终态保留。
- 工具/审批中取消的 stage 由 callback 跟踪；不改变工具/审批/权限语义。
- 不新增 schema/IPC channel；回滚只需停止 terminal 读取/UI，事件 append-only 保留。
