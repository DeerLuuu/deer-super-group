# 历史对话轮次统一气泡设计（t167）

- **任务**：t167 — 持久化统一对话轮次（历史工具/思考/回复同泡）
- **类型**：requirements / 设计（**不写生产代码**）
- **作者**：sol（Systems Engineer）
- **日期**：2026-11-11
- **范围**：`docs/team/`；不改 `src/`、`electron/`、`dist/`、`dist-electron/`、`branches/`
- **目标**：刷新/重开/切换工作区后，历史 assistant 轮次仍是一个完整气泡：思考分段、工具调用/结果、最终回复都在同一个 assistant bubble 中；历史 reasoning 可懒翻译并切换原文/译文。

---

## 0. 结论先行

当前缺口不是“没有事件”，而是：

1. **工具/思考事件有持久化，但没有 turn/message 归属键**；`chat.reasoning` / `chat.tool_call` / `chat.tool_result` 只带 `workspace/agent/step/callId`，消息表只有最终 assistant 文本。
2. **实时态只存在于 renderer 内存**（`chatTools` / `chatReasoningSegments`），`done` 后 `loadChat()` 只恢复 `chat_messages`，实时数组不会重建。
3. **现有 `getChatTrajectory` 是扁平账本**，不是“按 user→assistant 轮次、按 step 合并”的气泡投影；它可复用事件排序/callId 配对逻辑，但不能直接作为 UI bubble 数据源。

本设计新增**只读投影** `getChatTurns`：

- 以 `chat_messages` 的 user/assistant 消息为骨架；
- 以事件时间 + `seq` + 可选 `turnId/assistantMessageId` 为归属；
- 按 `step` 合并 reasoning 与 call/result；
- `callId` 配对；旧数据自动降级（message.reasoning / step 0 / synthetic tool）；
- 返回有容量边界的分页 DTO；不写入 snapshot，不改事件 schema；
- 历史气泡复用现有 `ChatTurnProcess` 的展示语义，但**历史默认折叠**，翻译只在展开时懒加载。

---

## 1. 当前数据盘点

### 1.1 持久化消息：`chat_messages`

`src/kernel/store.ts` 的建表与 `addChatMessage`：

```sql
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,          -- user | assistant | system
  content TEXT NOT NULL,
  reasoning TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
```

- `ChatMessage`（`src/shared/types.ts`）：`id/workspaceId/agentId/role/content/reasoning/createdAt`。
- `listChatMessages(workspaceId, agentId?, limit=100)` 按 `created_at DESC` 取最近 N 条后 reverse；`getChatTrajectory` 取 200 条。
- `sendChat` 先 `addChatMessage(role=user)`，生成完成后 `addChatMessage(role=assistant, content=result.text, reasoning=result.reasoning)`。
- **缺失字段**：没有 `turnId`、没有 assistant 消息的事件归属、没有 step/工具引用、没有消息状态（cancelled/error）。
- `system` 消息只用于 `/compact` 摘要；不参与普通 user→assistant 轮次。

### 1.2 持久化 chat 事件

`AppService.sendChat` 在 `runAgentLoop` 的 `onEvent` 中 best-effort 写入：

| 事件 | payload | 说明 |
|---|---|---|
| `chat.reasoning` | `{agentId, step, text≤8000}` | 每个模型 step 的思考；`t173` 增加 |
| `chat.tool_call` | `{agentId, callId, name, arguments≤8000, step}` | 工具调用 |
| `chat.tool_result` | `{agentId, callId, name, ok, value(limited), error, step}` | 工具结果 |
| `chat.context_cleared` | `{agentId, removedMessages, ...}` | 清空上下文审计 |
| `chat.context_compacted` | `{agentId, ...}` | 压缩上下文审计 |
| `chat.interactive_ingest_failed` | `{messageId, code}` | 画布/提问 ingest 失败审计 |

事件级公共字段：`seq`、`occurredAt`/`createdAt`、`aggregateType="chat"`、`aggregateId=workspaceId`、`actor="agent:Router"`。

**关键缺口**：事件 payload **没有** `turnId`、`userMessageId`、`assistantMessageId`。因此服务端无法仅凭事件精确判断“这条工具属于哪次 assistant 回复”，只能按时间窗口/agent 归属。

### 1.3 实时 ChatEvent（renderer 内存）

`ChatEvent`（`src/shared/types.ts`）包括：

- `delta`、`reasoning`（流式 token）
- `reasoning_segment`：`{step,text}`（t179 自动机翻来源）
- `tool_call` / `tool_result`：`{callId,name,arguments,ok,value,error,step?}`
- `done`：最终 `ChatMessage`
- `cancelled` / `error`

App 的内存状态（`src/App.tsx`）：

- `chatTools: ChatToolTrace[]`：按 `callId` 合并 call/result；
- `chatReasoningSegments: ChatReasoningSegment[]`：按 step 分段，带翻译状态/译文；
- `chatStream` / `chatReasoning`；
- `translationRequests: Set<string>`：每 segment 只翻译一次。

`done` 时 `setChatStream("")、setChatReasoning("")、setChatBusy(false)、loadChat()`；**没有把 `chatTools/chatReasoningSegments` 写入消息表，也没有调用按 assistant id 重建的 API**。下次刷新这些数组为空，所以只剩最终回复 +（单段）`chat_messages.reasoning`。

### 1.4 现有 UI 行为（t175/t177/t178/t183）

- **实时**：`ChatTurnProcess` 按 `step` 分组 `reasoningSegments + tools`，放在最后一个 assistant 气泡内；step/工具随运行展开，完成后自动折叠（t178）。
- **历史**：`ChatBubble` 只拿到 `message.reasoning`，通过 `ChatMessageReasoning` 展开时懒翻译（t183）；没有历史工具/分段思考。
- **轨迹 tab**：`getChatTrajectory` 返回扁平 `ChatTrajectoryEntry[]`，按时间 + seq 排序；t173 的 reasoning/tool 事件都在这里能看，但**不是 assistant bubble 结构**。
- `ChatTrajectoryEntry` 已有 `kind/title/detail/status/callId/step/seq`，证明“事件→可读条目”的投影可行；缺的是“轮次/消息归属 + step 合并 + 嵌套 DTO”。

### 1.5 当前为什么只在前端内存

| 环节 | 当前行为 | 结果 |
|---|---|---|
| 生成时 | `onEvent` 同时 emit ChatEvent + append chat.* 事件 | 实时 UI 有；事件库有，但无消息归属 |
| 工具/思考 | App 写 `chatTools/chatReasoningSegments` | 只在 renderer 内存 |
| 完成 | 只 `addChatMessage(assistant)`；`done` 清实时数组 | 消息表只有最终文本 + 整段 reasoning |
| 刷新 | `loadChat` 只 `listChatMessages` | 工具/分段思考消失 |
| 轨迹 | 扁平事件账本 | 能看过程，但不在气泡里，不能按 turn 回放 |

---

## 2. 设计原则与范围

### 2.1 原则

1. **只读投影优先**：不改 `chat_messages` schema、不改已有事件写入的必填字段；投影可随时重建。
2. **事件是过程事实源，消息是轮次骨架**：user/assistant 消息决定“泡”，事件填充“泡内过程”。
3. **向后兼容**：旧数据无 step/callId/事件时仍可显示至少最终回复 + reasoning。
4. **不把大 payload 塞进 snapshot**：新增独立 `chat:turns` 分页 API，默认最近 N 轮；snapshot 保持轻量。
5. **UI 单一 process 组件**：实时/历史使用同一套 step/tool 语义；历史默认折叠、翻译懒执行。
6. **可测试**：投影是纯函数（消息 + 事件 + 选项 → DTO），fake 时间/fixture 可确定性复现。

### 2.2 非目标

- 不把工具执行搬到 renderer；不改变权限/审批。
- 不重放/重跑历史工具；只读展示。
- 不实现跨工作区共享/多用户读模型。
- 不在本设计阶段新增生产代码或迁移。
- 不保证恢复“事件写入之前”的历史工具；旧数据只能降级。

---

## 3. Turn Process 投影

### 3.1 类型形状（建议放 `src/shared/chatTurns.ts`）

```ts
export type ChatTurnStatus =
  | "complete"    // 有 assistant，且有最终回复（旧数据降级也仍是 complete）
  | "cancelled"   // 有 user/assistant 但被取消（如可判定）
  | "error"       // 有 user 无 assistant/错误
  | "pending";    // 有 user 无 assistant（历史异常）

export interface ChatTurnReasoning {
  id: string;                 // 稳定：event.id:reasoning 或 message.id:reasoning
  step: number;               // 无 step 时 0
  text: string;
  seq?: number;
  /** event=chat.reasoning；message=旧 assistant.reasoning 降级 */
  source: "event" | "message";
}

export interface ChatTurnTool {
  callId: string;             // 缺省 synthetic:<seq>
  name: string;
  arguments: string;          // 已截断
  status: "running" | "ok" | "error" | "unknown";
  value?: unknown;            // 已截断
  error?: string;
  step: number;               // 缺省 0
  callSeq?: number;
  resultSeq?: number;
  synthetic?: boolean;        // 无 call 的孤立 result
  truncated?: { arguments?: boolean; value?: boolean };
}

export interface ChatTurnStep {
  step: number;
  reasoning: ChatTurnReasoning[];
  tools: ChatTurnTool[];
}

export interface ChatAssistantTurn {
  /** turnId + assistant message id，UI 以 messageId 合并到气泡 */
  id: string;                 // `${turnId}:assistant:${message.id}`
  messageId: string;
  content: string;
  reasoning: string;          // 原始 assistant.reasoning（legacy fallback）
  steps: ChatTurnStep[];
  status: ChatTurnStatus;
  legacy: {
    reasoningFromMessage: boolean;
    toolsMissing: boolean;
    stepFallback: boolean;
  };
  truncated: boolean;
}

export interface ChatTurn {
  /** 确定性：turn:<userMessageId>；无 user 时为 orphan:<assistantMessageId> */
  turnId: string;
  userMessage: ChatMessage | null;
  assistants: ChatAssistantTurn[];
  startedAt: string | null;
  endedAt: string | null;
  status: ChatTurnStatus;
}

export interface ChatTurnHistoryPage {
  workspaceId: string;
  agentId: string;
  turns: ChatTurn[];
  /** 是否还有更早轮次（用于「加载更早」） */
  hasMore: boolean;
  /** 不透明游标：`${createdAt}|${userMessageId}`，仅服务端解释 */
  nextBefore: string | null;
  /** 全局截断：任一 turn 有截断/页容量触顶 */
  truncated: boolean;
  /** 投影版本，便于 UI/回滚 */
  projectionVersion: 1;
  generatedAt: string;
}
```

`ChatTurnHistoryPage` 是 API 返回类型；单个 assistant 气泡的 `steps` 在 `assistants[]` 中。

### 3.2 分组键：user → assistant

**主分组键**：`userMessageId`。`turnId = "turn:" + userMessage.id`。

排序与归属算法（服务端）：

1. `messages = listChatMessages(workspaceId, agentId, messageLimit)`（默认 200，按 `created_at ASC, id ASC`）。
2. 按顺序遍历，遇到 `role=user` 开启新 turn；`role=system` 不开启 turn（作为上下文摘要，不展示为普通气泡）；`assistant` 归属到最近的 user；没有 user 的 assistant 使用 `orphan:<assistant.id>` turn。
3. 一个 user 后可能有多个 assistant（重试/多轮回复）：`assistants[]` 保留全部；每个 assistant 的 `messageId` 独立，UI 各自一个气泡。
4. **事件归属**（优先级从高到低）：
   - **P0 显式键（未来可选）**：事件 payload 的 `turnId` 或 `assistantMessageId` 存在且能在当前页匹配 → 直接归属。
   - **P1 时间窗口**：`[user.createdAt, nextUser.createdAt)`；仅匹配 `agentId` 相同的 chat 事件。
   - **P2 assistant 细分**：同一 user 有多个 assistant 时，按 assistant 的 `createdAt` 升序切分；事件时间 `<= assistant.createdAt` 归最近的前一个 assistant；晚于最后一个 assistant 且无下一个 user 的，允许 `lateGraceMs=5000` 内归最后一个 assistant。
   - **P3 丢弃**：无 user/assistant 可归属、超出窗口或超过 grace 的事件不进入 turn 投影；仍保留在扁平 trajectory 账本中（避免伪造气泡）。
5. `startedAt = user.createdAt`；`endedAt = 最后 assistant.createdAt`；无 assistant 时 `pending/error`。
6. `turn.status`：
   - 有 assistant 且 content 非空 → `complete`（旧数据即使只有 message.reasoning 也仍是 `complete`，降级信息放在 `assistant.legacy`）；
   - 有 user 无 assistant → `error`（但无错误事件时 UI 只能显示用户消息 + “未完成”）；
   - 取消事件当前不持久化，暂不单独判定 `cancelled`（P1 决策，见 §13）。

**为什么不只用时间戳**：同毫秒消息、时钟回拨、晚到事件都会误配；显式 `turnId` 是未来写入的最优键，时间窗口只作为旧数据兼容。本设计建议未来事件**附加** `turnId/assistantMessageId`（可选字段，不改必填 schema），但本阶段不依赖它。

### 3.3 step 合并

1. `step = Number.isFinite(payload.step) && payload.step >= 0 ? payload.step : 0`。
2. 每个 assistant 的所有 reasoning/tool 事件按 step 分组；step 升序。
3. 同一 step：
   - reasoning 按 `(occurredAt/createdAt, seq, id)` 升序；同一事件只保留一次；
   - call 按 `callSeq` 升序；
   - result 不单独成 step，挂到同 `callId` 的 call 上；
   - 若 result 无对应 call → synthetic tool（`status=ok/error`，`synthetic=true`，`callSeq=resultSeq`）。
4. 无事件、但 `message.reasoning` 非空时：生成 **单个 step 0** 的 `ChatTurnReasoning`（`source=message`，`legacy.reasoningFromMessage=true`）。
5. 有 reasoning 事件时，**忽略** `message.reasoning`，避免最终整段 reasoning 与分段事件重复。
6. 无 step 的旧事件全部归 step 0；保留它们之间的 seq 顺序，不强行拆分。

### 3.4 callId 配对

- `callId = String(payload.callId ?? "").trim()`。
- 非空：`callsByCallId` 保留第一个 call；后续同 callId call 视为重复（保留 `duplicateCalls` 诊断，UI 不重复渲染）。
- 空：`callId = "synthetic:" + event.seq`（每事件唯一），不与其他空 callId 合并。
- result：
  - 有 callId 且找到 call → 更新 tool 的 status/value/error/resultSeq；
  - 找不到 call → synthetic tool（不吞结果）；
  - 多个 result 同一 callId → 最后一次覆盖，`truncated/diagnostics` 记录重复（或保留第一条，设计选“最后一条”，符合实际重试覆盖）。
- 无 result 的 call：
  - turn 仍在进行/最后 assistant 未完成 → `running`；
  - turn 已完成 → `unknown`（不显示“运行中”误导）。
- 工具 `arguments` / `value` 只保留投影容量允许的部分；结果不反序列化失败时回退 `String`。

### 3.5 旧数据降级矩阵

| 旧数据形态 | 投影结果 | `legacy` 标记 |
|---|---|---|
| 只有 `chat_messages` user+assistant，无事件 | 1 个 user turn；assistant bubble 只有 content；若有 `reasoning` 则 step0 单段 | `reasoningFromMessage=true`, `toolsMissing=true`, `stepFallback=true` |
| 有 `chat.reasoning` 但无 step | step 0 reasoning 列表 | `stepFallback=true` |
| 有 call/result 但无 step | 全部 step 0，按 seq 排序 | `stepFallback=true` |
| 有 call 无 result（历史） | status=`unknown` | `toolsMissing=false` |
| 有 result 无 call | synthetic tool | `synthetic=true` |
| 旧 `chat_messages.reasoning` 有值且事件也有 reasoning | 事件胜出，message.reasoning 不重复 | `reasoningFromMessage=false` |
| 清空/压缩后消息已删、事件仍在 | 不进入 turns（无消息骨架）；轨迹仍可看 | 不入 bubble |
| 只有 user，无 assistant | turn status=`error/pending`，UI 显示用户消息与“未完成” | — |

### 3.6 投影伪代码

```text
buildChatTurns(messages, events, options):
  msgs = sort(messages by createdAt,id)
  evs = sort(events by eventTime,seq,id)
  turns = groupMessagesIntoUserTurns(msgs)   # system 不入 turn
  for event in evs:
    if event.agentId != requestedAgent: continue
    turn = findTurnByExplicitKey(event) or findTurnByTimeWindow(event)
    assistant = chooseAssistant(turn, event) or lastAssistant(turn)
    if turn == null or assistant == null: drop (trajectory only)
    if event.type == chat.reasoning:
      assistant.pendingReasoning.push({step,text,seq,id})
    if event.type == chat.tool_call:
      assistant.calls.set(callId, {name,args,step,seq})
    if event.type == chat.tool_result:
      attachOrSynthetic(assistant, callId, ...)
  for assistant:
    if reasoningEvents exist: steps = groupReasoningAndTools(assistant)
    else if assistant.message.reasoning: steps = [step0 message reasoning]
    else: steps = []
    mark legacy/truncated/status
  return paginate/sort turns
```

---

## 4. API / IPC 形状

### 4.1 服务层

```ts
getChatTurns(
  workspaceId: string,
  agentId?: string,
  options?: {
    limit?: number;          // 1..40，默认 20
    before?: string;         // 不透明游标；只返回更早轮次
    includeTools?: boolean;  // 默认 true
    includeReasoning?: boolean; // 默认 true
  },
): ChatTurnHistoryPage;
```

- workspace 校验：workspace 必须存在；`agentId` 必须属于该 workspace；否则抛稳定错误（沿用现有 service 的 workspace/agent 错误语义）。
- 默认 agent：Router（与 `listChat`/`getChatTrajectory` 一致）。
- **不进入 `getSnapshot`**：snapshot 保持轻量；UI 在 `loadChat` 后独立调用，失败不阻断消息渲染。
- 与 `getChatTrajectory` 共存：trajectory 保留扁平全量视图；`getChatTurns` 是气泡读模型。两者共享 `callId`/排序/旧数据规则。

### 4.2 容量边界

| 参数 | 默认 | 上限 | 说明 |
|---|---|---|---|
| `limit` turns | 20 | 40 | `clamp(limit,1,40)` |
| `messages` 读取 | 200 | 200 | 与 `getChatTrajectory` 对齐；超出由 `before` 分页 |
| `events` 读取 | 2000 | 2000 | 只查 `aggregateType=chat, aggregateId=workspaceId`，按 agent 过滤 |
| reasoning 单段 | 8,000 字符 | 8,000 | 与写入截断一致；超长 `truncated` |
| tool arguments | 4,000 字符 | 4,000 | 与 UI `formatToolPayload` 一致 |
| tool value | 4,000 字符（序列化后） | 4,000 | 超长标记 `truncated.value` |
| assistant content | 64KB | 64KB | 超长 `truncated=true`，UI 显示“内容已截断” |
| 响应总量 | 512KB | 512KB | 超出先裁旧 step 的 tool value/arguments，再裁 reasoning，最后标记；HTTP/IPC 不返回超限 |
| 游标 | — | — | `nextBefore = base64url(createdAt + "|" + userMessageId)`，只服务端解释 |

- `hasMore=true` 表示还有更早的 user turn（不是“还有更早事件”）。
- `truncated=true` 任一层截断即置位；UI 提供“内容已截断/加载更早”提示。
- 单轮 > 512KB 的极端情况：保留 assistant content 的前 64KB + 最近 3 个 step，其余丢弃并标记；不静默截断而不提示。

### 4.3 IPC / preload

- `src/shared/ipc.ts`：`getChatTurns(workspaceId, agentId?, options?) => Promise<ChatTurnHistoryPage>`。
- `electron/main.ts`：`handle("chat:turns", ...)`，参数校验在 service；不新增裸通道。
- `electron/preload.ts`：`getChatTurns: (...) => ipcRenderer.invoke("chat:turns", ...)`。
- **不修改 `ChatEvent` 现有必选字段**；未来可选 `turnId/assistantMessageId` 只作为 payload 附加。

### 4.4 示例返回（截断）

```json
{
  "workspaceId": "ws_1",
  "agentId": "agent_router",
  "turns": [
    {
      "turnId": "turn:chat_u1",
      "userMessage": {"id": "chat_u1", "role": "user", "content": "检查项目", "...": "..."},
      "assistants": [
        {
          "id": "turn:chat_u1:assistant:chat_a1",
          "messageId": "chat_a1",
          "content": "已检查，配置正常。",
          "reasoning": "",
          "status": "complete",
          "legacy": {"reasoningFromMessage": false, "toolsMissing": false, "stepFallback": false},
          "truncated": false,
          "steps": [
            {
              "step": 1,
              "reasoning": [{"id": "evt_1:reasoning", "step": 1, "text": "先看目录", "seq": 10, "source": "event"}],
              "tools": [{
                "callId": "call_1", "name": "fs.list", "arguments": "{\"path\":\".\"}",
                "status": "ok", "value": {"entries": 3}, "step": 1,
                "callSeq": 11, "resultSeq": 12
              }]
            }
          ]
        }
      ],
      "startedAt": "2026-11-11T02:00:00.000Z",
      "endedAt": "2026-11-11T02:00:05.000Z",
      "status": "complete"
    }
  ],
  "hasMore": false,
  "nextBefore": null,
  "truncated": false,
  "projectionVersion": 1,
  "generatedAt": "2026-11-11T02:00:06.000Z"
}
```

---

## 5. UI 设计

### 5.1 数据加载与合并

`App` 新增：

```ts
const [chatTurns, setChatTurns] = useState<ChatTurnHistoryPage | null>(null);
const chatTurnsByAssistant = useMemo(
  () => new Map(chatTurns?.turns.flatMap(t => t.assistants.map(a => [a.messageId, a])) ?? []),
  [chatTurns],
);
```

`loadChat` 并行请求：

```ts
const [messages, turnsPage, contextSnapshot] = await Promise.all([
  window.deer.listChat(...),
  window.deer.getChatTurns(workspaceId, router.id, { limit: 20 }),
  window.deer.getContext(...),
]);
setChatMessages(messages);
setChatTurns(turnsPage);
```

- `getChatTurns` 失败：只对对应气泡降级为 `message.reasoning`，不阻断消息/上下文；toast 一次，不每轮重试。
- `done` 后 `loadChat` 已包含 turns；不再需要单独 `loadChatTrajectory`（轨迹 tab 仍独立按需加载）。
- 切换 workspace/agent：清空 `chatTurns`，按 key 重新加载；避免旧 workspace assistant id 串泡。

### 5.2 气泡渲染：历史 vs 实时，绝不重复

规则（按 assistant message id 唯一）：

1. `historical = chatTurnsByAssistant.get(message.id)`。
2. 有 `historical`：该 `ChatBubble` 渲染 `process=<ChatTurnProcessView process={historical} variant="history"/>`；**不再**渲染 `ChatMessageReasoning`（避免 reasoning 双份），也不附实时 `processNode`。
3. 无 `historical` 且 `message.reasoning`：沿用现有 `ChatMessageReasoning` 懒翻译（旧数据降级）。
4. **实时气泡**只在当前生成中（`stream/reasoning/tools` 非空且 `chatBusy`）渲染：独立 streaming `ChatBubble`，process 用 `variant="live"`。`done`/`cancelled`/`error` 清空 `chatTools/chatReasoningSegments` 并 `loadChat`；不会把 live process 再挂到已持久化消息上。
5. 若 `done` 后 turns 尚未到达：持久化 assistant 只显示 `message.reasoning` 降级，**不**复用旧 live 数组；turns 到达后切换到完整 process（一次重渲染，不重复气泡）。
6. 当前代码的 `attachProcess`（把 live process 挂到最后 assistant）改为 **仅 live streaming bubble**；这是去重的关键。

### 5.3 统一 process 组件

复用/重构 `ChatTurnProcess`（`src/App.tsx`）为两层：

```ts
type ChatProcessViewData = {
  variant: "live" | "history";
  steps: Array<{
    step: number;
    reasoning: Array<{ id; step; text; status; translation? }>;
    tools: ChatToolTrace[];
  }>;
  liveReasoning?: string;
  busy: boolean;
};
```

- 实时：`steps` 来自 `chatReasoningSegments/chatTools`；默认展开，当前 step 运行中；t178 自动折叠保留。
- 历史：`steps` 来自 `ChatAssistantTurn.steps`；`<details>` 默认关闭，所有 step 默认关闭，工具默认关闭；只在用户展开时显示内容。
- 工具名：统一 `toolLabel(name)`（中文）+ 原始 id（`title`/muted）；参数/结果 `formatToolPayload` 截断；状态 `running/ok/error/unknown`。
- 历史右上角汇总：“N 步 · M 次工具 · 历史记录”；无 process 时不渲染空 `<details>`。
- 气泡最终回复始终显示在 process 之后（现有 `ChatBubble` 顺序），确保“同泡”；思考/工具不覆盖最终回复。
- 旧数据：若 `steps` 只有 `legacy.reasoningFromMessage`，历史 process 显示一个“历史思考（旧数据）”step；无工具。

### 5.4 历史思考懒翻译

目标：展开才翻译、每段只请求一次、不重复实时翻译。

数据键：

```ts
translationKey(segment) =
  segment.source === "event"
    ? `hist:${assistantMessageId}:${segment.id}`      // 稳定 event id
    : `hist:${assistantMessageId}:msg:${hash(text)}`;  // 旧 message reasoning
```

实现建议：

- `App` 维护 `translationCache = useRef<Map<string, {status; translation?}>>`（或提升到 `ChatView`），与现有 `translationRequests` 合并为一个 `TranslationStore`。
- 历史 `ChatReasoningBlock` 展开时才调用 `window.deer.translateText(segment.text)`；关闭/重开使用 cache，**不重复请求**。
- 实时：现有 segment 完成后翻译；翻译结果同时写入 cache，键为 `live:${textHash}`（或 `textHash` 规范化键）。
- 历史段查找 cache 顺序：
  1. 精确 `hist:` key；
  2. `textHash`（实时已翻译的同文本）→ 直接复用，**不再调用**；
  3. 未命中且展开 → 发起一次请求；`translationRequests` 防止并发重复。
- 设置：沿用 `TranslationSettings { enabled, provider, target }` 与 `translateText`（Bing/模型）；设置变更后清空 cache（与 service `saveTranslationSettings` 清 cache 对齐）。
- 显示：
  - 默认「译文」（有译文且与原文不同）；「原文 / 译文」切换复用现有 `ChatReasoningBlock`；
  - 中文/翻译失败/未展开：原文 + 状态（机翻失败/机翻中/旧数据）；
  - 翻译结果只作用于当前气泡段，不批量预取全历史（避免启动打 Bing）。
- **不重复实时**：`done` 前把 live 翻译写入 `textHash` 缓存；历史投影到达后按文本命中的段直接使用译文，不发起新请求。测试需断言 `translateText` 调用次数。

### 5.5 工具中文名与折叠

- `toolLabel` 映射保持单一事实源（现有 `TOOL_LABELS`）；历史/实时共用。
- 历史工具项：默认折叠；标题 `读取文件 fs.read`；展开显示参数、结果/错误；结果超 4,000 字符显示“…已截断”。
- 历史 step：默认折叠；点击整行展开/收起；键盘可用（`button` + `aria-expanded`，原生 `<details>`）。
- 窄窗 900/760：process 内 `pre` 最大宽 100%、`overflow:auto`；工具/step 行 `flex-wrap`；不横向溢出（沿用现有 CSS token，不新增裸颜色）。

---

## 6. 历史翻译与实时去重细节

### 6.1 请求状态机

```text
历史段未展开 -> 不请求
展开 -> cache hit(text/segment) -> 直接 done
       cache miss -> loading -> success(done, 写 cache) / error(保留原文)
关闭再展开 -> cache hit -> 不请求
实时段完成 -> 自动翻译 -> 写 textHash cache
done -> loadChat/getChatTurns -> 历史段命中 textHash -> 显示译文，不请求
```

### 6.2 键冲突/重复

- 同一 assistant 同一 step 可能有多个 reasoning 事件同文本（重复写入）：投影保留事件 id；翻译 cache 用 `assistantMessageId + event.id`，不会因同文本不同段误共享；`textHash` 只作为实时→历史复用，不用于不同段展示。
- 不同 assistant 同文本：`textHash` 可复用（翻译结果只依赖文本），但要避免译文串段；仅当 UI 请求同一文本时复用，渲染按段。
- 服务层已有模型翻译 200 条缓存；客户端仍按键去重，避免 IPC/Bing 请求。

### 6.3 不自动翻译历史

- 禁止在 `loadChat/getChatTurns` 后批量调用 `translateText`；仅 `ChatReasoningBlock` 的 `open=true` 触发。
- 历史 process 默认折叠 → 首次刷新不产生任何翻译请求。
- 若用户展开多个 step，按 segment 串行/并发上限 2，失败独立；不做全局重试风暴。

---

## 7. 迁移 / 兼容策略

### 7.1 本阶段：只读投影，无迁移

- 不改 `chat_messages` 列；不改已有事件必填 schema；不重写历史事件。
- `getChatTurns` 用现有消息+事件计算；`getChatTrajectory` 保留。
- 旧数据规则见 §3.5；旧工具缺失是**无法恢复**的边界，不伪造。
- 回滚：删 API/UI 调用即可；不产生新表/新列/新事件，事件库无写入。

### 7.2 建议的未来可选增量（不在本阶段实现）

为消除时间窗口歧义，在**新写入**的 chat 事件 payload 追加可选字段（不是必需）：

```jsonc
{
  "turnId": "chat_u1",              // user message id
  "assistantMessageId": "chat_a1"   // 生成完成后回填？若事件先于 message 不能写
}
```

- `turnId` 可在 `sendChat` 创建 user message 后立即已知，写入 reasoning/tool 事件；`assistantMessageId` 在最终 assistant 消息创建前未知，**不建议**强求；可用 `turnId` 足够把事件归到 user turn。
- 这是 **additive payload**，不改 SQL、不改 zod 必填；旧事件缺省走时间窗口。
- 若未来必须 `assistantMessageId`，可在 `done` 后写一条 `chat.turn_bound` 或 `chat_messages.turn_id`；需要 migration + rollback（先加 nullable 列，回填可选，读旧列 fallback），但**当前不启动**。

### 7.3 事件/消息生命周期

- `clearChatContext` 删除消息但事件保留：turn API 不返回 orphan 事件；轨迹仍显示（现有行为）。
- `compactChatContext` 删除旧消息并插入 system 摘要：旧事件变 orphan；turn API 不伪造气泡；system 摘要不进入 turn。
- 事件库保留策略若变化（裁剪/归档），投影自然降级为 message.reasoning；接口文档需注明“过程可缺失”。

---

## 8. 文件面（实现阶段）

### 8.1 新增

```text
src/shared/chatTurns.ts          ChatTurnHistoryPage/ChatTurn/ChatTurnStep/ChatTurnTool 类型 + 容量常量
src/kernel/chatTurnProjection.ts 纯函数 buildChatTurns / 分组 / step / callId / legacy / 截断
src/kernel/chatTurnProjection.test.ts
src/ChatTurnHistory.test.tsx     UI 重开/气泡/折叠/懒翻译/去重
```

### 8.2 修改

```text
src/kernel/service.ts             getChatTurns(workspaceId, agentId?, options)
src/shared/ipc.ts                 DeerApi.getChatTurns
electron/main.ts                  handle("chat:turns")
electron/preload.ts               getChatTurns
src/App.tsx                       chatTurns state/load/merge; ChatTurnProcess 统一 view; 历史翻译 cache; 实时/历史去重
src/styles.css                    history process/折叠/窄窗样式（复用 token）
docs/team/chat-turn-history-design.md  本文件
```

### 8.3 不改

- `src/kernel/store.ts` 的 `chat_messages` schema / `addChatMessage`（本阶段）；
- 现有 `ChatEvent` 必选字段；
- `getChatTrajectory` 行为；
- 任务 RunHistory / 内核事件。

---

## 9. 测试计划（可复现）

### 9.1 纯投影单测（`chatTurnProjection.test.ts`）

| Fixture | 断言 |
|---|---|
| 正常单 step | user→assistant；1 step；reasoning→call→result 顺序；tool status=ok；assistant content |
| 多 step（step1/2） | steps=[1,2]；每 step reasoning/tools 正确；callId 配对；最终回复在 assistant |
| 同一 user 两个 assistant | `assistants` 2 条，各自 messageId/steps；事件按 assistant 边界归属 |
| 无 step 旧事件 | 全部 step0；seq 顺序保持；`legacy.stepFallback=true` |
| 无 callId | 每个 call 独立 synthetic id；不跨事件误合并 |
| result 无 call | synthetic tool status=ok；`synthetic=true` |
| duplicate result | 最后一条生效；不产生重复 tool |
| 有 reasoning 事件 + message.reasoning | 事件胜出；不重复；`reasoningFromMessage=false` |
| 只有 message.reasoning | 单 step0 单段；`source=message`；tools=[] |
| 无 assistant | turn status=error/pending；不抛异常 |
| 事件早于 user / 晚于 next user / late grace | 早/晚丢弃；grace 内归属最后 assistant |
| clear/compact 后 | 消息删除后 turn 为空；orphan 事件不入 turn（轨迹仍可独立） |
| 分页/截断 | limit/40、before、hasMore、nextBefore；content/tool 截断标记；响应 ≤512KB |
| 跨 workspace/agent | service 层拒绝/不串数据 |

### 9.2 服务层集成（`chatContext.test.ts` 扩展）

- 写入 user/assistant 消息 + `chat.reasoning`/`chat.tool_call`/`chat.tool_result` 事件（occurredAt/step/callId），调用 `getChatTurns`，断言步骤和 callId。
- 写 25 轮，`limit=20` → 20 + hasMore/nextBefore；继续 before → 剩余 5。
- 旧数据：只有 messages/reasoning → legacy 投影。
- 跨 workspace agent 校验；`includeTools=false` 时 tools 空但步骤仍在。
- 性能：500 events/20 turns 在测试中完成（不设严格毫秒阈值，仅防超时）。

### 9.3 UI 测试（`ChatTurnHistory.test.tsx`）

1. **刷新/重开场景**：mock `listChat` + `getChatTurns` 返回 2 个 assistant turn；render `ChatView`；断言每个 assistant 气泡内包含 process、step、reasoning、工具、最终回复；旧数据 assistant 只有 final + reasoning fallback。
2. **实时→历史去重**：先挂 live process（stream/tools/reasoning），`done` 后 turns 到达；断言只有一个 assistant 气泡、process 不重复、live 数组被清空；历史 process 使用 turns。
3. **翻译懒加载**：历史 process 默认折叠 → `translateText` 0 次；点击第一段 → 1 次；关闭再展开 → 仍 1 次；第二段独立 1 次；切换原文/译文不重复请求。
4. **实时翻译复用**：live segment 翻译完成 → done/load turns 同文本历史段展开 → `translateText` 不增加（textHash cache）。
5. **工具/折叠**：历史工具显示中文名+raw id，默认折叠；展开显示参数/结果；step 展开/收起；`aria-expanded`。
6. **无障碍/窄窗**：`role=button`/`details`；900/760 静态 class/样式断言（CSS 无裸颜色）。
7. 失败降级：`getChatTurns` 抛错 → 消息仍显示，仅 reasoning fallback；翻译失败显示原文+“机翻失败”。

### 9.4 手动验证（P1 manual）

- Electron 真实运行：发一条带工具/多 step 的对话 → 刷新窗口 → 确认同泡恢复；展开思考触发一次翻译；关闭重开不重复网络请求。
- 旧工作区（只有 chat_messages）→ 打开只显示 final + 单段 reasoning，不显示空 process。
- 900/760 宽度下 process 不横向溢出。

### 9.5 三命令

实现阶段：`pnpm typecheck`、`pnpm build`、`pnpm test` 全绿；本设计阶段不运行代码命令（仅文档检查）。

---

## 10. 验收标准（AC）

- **AC-01**：刷新/重开后，有持久化事件的 assistant 轮次在同一 bubble 内显示 reasoning 分段 + tool call/result + 最终回复；不拆成多个消息。
- **AC-02**：投影按 `user→assistant` 分组；`step` 升序；同一 step 内 reasoning 在 call 前；callId 配对；无 result 的历史 call 显示 unknown 而非 running。
- **AC-03**：旧数据（无事件/无 step/无 callId）有确定性降级：message.reasoning 单段、step0、synthetic tool、不崩溃、不伪造工具。
- **AC-04**：`getChatTurns` 返回类型/容量边界明确；默认 20/最大 40/响应 512KB/字段截断；不进 snapshot；分页 before/hasMore 可用。
- **AC-05**：历史翻译只在展开时请求；每段一次；实时已翻译文本复用不重复请求；原文/译文切换可用；失败保留原文。
- **AC-06**：历史工具中文名 + 原始 id；历史 process/step/tool 默认折叠；实时行为不回归（t178 自动折叠）。
- **AC-07**：当前实时轮次与历史投影不重复；同一 assistant message id 只有一份 process。
- **AC-08**：无强制 schema 迁移；只读投影可回滚；旧事件/旧消息可读。
- **AC-09**：测试计划覆盖服务层投影 + UI 重开/翻译/去重 + 900/760；实现阶段三命令全绿。
- **AC-10**：文档明确回答“刷新后如何恢复完整 assistant 气泡”的数据来源、分组键、step 排序、callId 配对、旧数据降级。

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 无 turn/message 键，时间窗口误配（同毫秒/晚到事件） | 工具/思考挂错 assistant | 时间窗口 + seq + grace；未来写入可选 `turnId`；显式键优先；误配时宁可 drop 到轨迹，不伪造 |
| 事件 best-effort 丢失（try/catch） | 历史过程不完整 | fallback message.reasoning；UI 标注“历史记录不完整”；不阻塞聊天 |
| 事件量大/长历史 | API 慢、payload 大 | 默认 20 轮/200 msg/2000 events；cap 40/512KB；分页 before |
| 大工具结果/参数 | 气泡卡顿/IPC 大 | 4,000 字符截断 + `truncated`；content 64KB cap |
| 历史翻译重复打 Bing/模型 | 网络/费用/隐私 | 展开才请求；segment key + textHash cache；translationRequests 去重；settings disabled 时 translateText 直接返回原文 |
| 实时/历史双份 process | 气泡重复 | assistantMessageId 唯一；live 仅 streaming；done 清 live；历史优先 |
| 清空/压缩产生 orphan 事件 | 错误气泡 | 只以消息骨架建 turn；orphan 不入 bubble；轨迹保留 |
| 旧工作区无工具 | 用户误以为工具丢失 | legacy 标记 + “旧数据无工具记录”文案；不重放 |
| 隐私（工具参数可能含密钥） | 历史展示泄露 | 沿用现有事件存储边界；展示截断；未来可复用敏感值 redaction（独立任务），本设计不新增存储 |
| `getChatTurns` 失败 | 历史降级 | 不阻断消息；只显示 message.reasoning；toast 一次 |

---

## 12. 性能与容量

- 单次 `getChatTurns` 读取 200 messages + 2000 events；投影 O(events log events + messages)；20 turns 预期 < 100ms（本机 SQLite；实现后压测）。
- 不做 N+1：一次 `listChatMessages` + 一次 `listEvents`，纯内存分组。
- `listEvents` 现有 limit 参数即可，无需新表/索引；若 >2000 events，靠 `before` 分页，不一次全量。
- `getChatTurns` 独立 IPC，不进入 snapshot；刷新时与 `getContext` 并行。
- 事件查询结果不缓存（避免内存泄漏）；实现可加短期 per-workspace 缓存，但需在 `done`/clear/compact 失效，不建议首版做。

---

## 13. 待 Captain 裁决项

1. **分组键**：接受“未来事件可选 `turnId` + 旧数据时间窗口”的两层方案，还是要求现在就加 `chat_messages.turn_id` / `chat.turn_bound` 持久化锚点？（建议前者，零 schema；后者作为 Phase 2。）
2. **容量默认**：`limit=20/max=40`、content 64KB、总响应 512KB、tool 4K 是否接受？若历史会话很长，是否需要默认只加载最近 10 轮？
3. **多 assistant 同 user**：每个 assistant message 一个气泡（本设计）还是合并为一个 turn 气泡的多个 reply？建议每个 assistant 独立气泡，避免混淆。
4. **历史 process 默认折叠**：接受“历史默认全折叠，点开才翻译”，还是默认展开 step 但 reasoning 折叠？
5. **翻译缓存生命周期**：仅 renderer 会话内存 + service 已有 200 条缓存，不持久化译文，是否接受？（建议接受，避免隐私/存储。）
6. **orphan 事件**：turn API 丢弃无消息骨架的事件，只保留 trajectory；是否需要在 Chat 轨迹里标注“未归属”？建议仅 trajectory 显示。
7. **取消/错误轮次**：当前 ChatEvent `cancelled/error` 不持久化；是否在本期新增 `chat.turn_cancelled` 事件以显示“已取消”？建议本期只显示 user + pending，后续补事件。
8. **隐私**：历史工具参数/结果是否原样展示（现有 trajectory 已展示）？建议沿用 + 4K 截断，敏感值 redaction 单独任务。
9. **旧数据 reasoning 标签**：是否给 `source=message` 的降级思考加“旧数据”标识？建议加，避免误以为分段丢失。
10. **`getChatTrajectory` 去留**：保留扁平轨迹 tab 作为“全量审计”，`getChatTurns` 作为气泡读模型；是否合并为一个 API 的两种 `view`？建议保留两个 API，避免破坏现有轨迹。

---

## 14. 实现顺序（设计确认后）

1. 纯投影 `chatTurnProjection.ts` + 单测（无 UI/DB 变更）。
2. `getChatTurns` service + IPC/preload + 服务层集成测试。
3. App `chatTurns` 加载 + 历史气泡渲染 + 实时/历史去重。
4. 统一 process 组件 + 历史折叠/工具中文名。
5. 历史懒翻译 cache + 实时复用 + UI 测试。
6. 旧数据/分页/容量/失败降级 + 手动 Electron 验证。
7. 文档更新 + PR（最小改动，不改 schema）。

---

## 15. 附：当前 vs 目标

| 场景 | 当前 | 目标 |
|---|---|---|
| 实时生成 | 同泡（live process） | 保持 |
| 完成后刷新 | 只剩 final（+ message.reasoning） | 同泡：steps + tools + final |
| 历史思考 | 整段 reasoning 懒翻译 | 分段 reasoning 懒翻译、原文/译文 |
| 历史工具 | 只在轨迹 tab | 同泡内折叠工具（中文名） |
| 轨迹 | 扁平账本 | 保留，不替代气泡 |
| Snapshot | 不包含 chat 过程 | 仍不包含；新增独立分页 API |
| 旧数据 | 无工具/无分段 | legacy 降级，不伪造 |
