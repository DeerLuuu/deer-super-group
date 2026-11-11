# 历史对话轮次统一气泡实现（t168）

- **任务**：t168 — 实现历史对话轮次统一气泡（turn process 投影 + UI 回放）
- **设计来源**：`docs/team/chat-turn-history-design.md`（t167）
- **实现者**：ren
- **范围**：`src/App.tsx`、`src/kernel/`、`src/shared/types.ts`、`src/shared/ipc.ts`、`electron/main.ts`、`electron/preload.ts`、`src/styles.css`、`docs/team/`
- **基线**：t167 §13 Captain 裁决（2026-11-11）

---

## 1. 交付摘要

刷新/重开对话后，历史 assistant 消息不再只剩最终文本：

- 服务层只读投影 `getChatTurns` 以 user/assistant 消息为骨架，按 assistant 和 step 归组 `chat.reasoning` / `chat.tool_call` / `chat.tool_result`；
- 每个 assistant 的 `steps[]` 含思考分段、call/result 配对、工具中文名可用的原始 name、时间/seq 顺序与旧数据降级标记；
- 独立 IPC `chat:turns` + preload `getChatTurns`，按需加载最近 20 轮（最大 40），不进 snapshot；
- Chat 视图把历史 assistant 渲染为与实时一致的结构：默认折叠的「执行过程」→ 可展开 step → 思考/工具 → 最终回复；
- 历史思考仅在展开 step 时懒翻译；复用现有 `translateText` 设置，支持原文/译文；实时翻译文本进入 renderer 会话缓存，历史按文本命中复用，合并并发请求；
- 旧数据没有 step/seq 时归 step 0；没有过程事件时只显示最终回复；`message.reasoning` 作为带「旧数据」标识的单段降级；
- 当前 live 轮次仍由实时气泡渲染；`done/cancelled/error` 清空 live process 并重载 turns，避免与历史重复。

## 2. 文件与 API

```text
src/shared/types.ts                  ChatTurn*/ChatTurnHistoryPage/Options + 容量语义
src/kernel/chatTurnProjection.ts     buildChatTurns 纯投影 + chatTurnSteps 映射 + 容量常量
src/kernel/chatTurnProjection.test.ts
src/kernel/chatTranslationMemo.ts     renderer 会话翻译缓存（去重/prime/clear）
src/kernel/chatTranslationMemo.test.ts
src/kernel/chatTurnService.test.ts
src/kernel/store.ts                  listChatMessagesPage + listRecentChatEvents
src/kernel/service.ts                getChatTurns(workspaceId, agentId?, options)
src/shared/ipc.ts                    DeerApi.getChatTurns
electron/main.ts                     chat:turns handler
electron/preload.ts                  getChatTurns
src/App.tsx                          chatTurns 加载/映射、历史气泡、懒翻译 cache、live 去重
src/styles.css                       history process/step 折叠与窄窗
docs/team/chat-turn-history.md        本文件
```

### `getChatTurns`

```ts
getChatTurns(
  workspaceId: string,
  agentId?: string,
  options?: {
    limit?: number;          // 1..40，默认 20
    before?: string | null;  // base64url(createdAt|userMessageId)
    includeTools?: boolean;  // 默认 true
    includeReasoning?: boolean; // 默认 true
  },
): ChatTurnHistoryPage
```

- 默认 agent 为 Router；agent 必须属于 workspace，否则稳定报错 `agent not found in workspace`。
- 消息读取窗口 200 条，事件窗口最近 2000 条；`before` 只向更早翻页，`hasMore`/`nextBefore` 由服务端计算。
- 投影不写事件/表，不改 `ChatEvent` 必填字段，不进入 `getSnapshot`；`getChatTrajectory` 保留为全量审计账本。

### 容量

| 字段 | 上限 |
|---|---|
| turns | 默认 20 / 最大 40 |
| assistant content | 64 KiB |
| reasoning 单段 | 8,000 字符 |
| tool arguments/value | 4,000 字符（value 按 JSON 序列化） |
| 响应总量 | 512 KiB（超出先裁更早整轮并置 `truncated`） |

超限字段返回省略号并带 `truncated` 标记；不会静默截断。

## 3. 投影规则

1. user 开启 turn；assistant 归属最近 user；无 user 的 assistant 为 `orphan:<assistantMessageId>`（只保留消息，不接收事件）。
2. 事件归属：
   - 未来可选 `assistantMessageId`/`turnId` 优先；
   - 否则按 `[user.createdAt, nextUser.createdAt)` 时间窗口 + 同 agent；
   - 同一 user 多个 assistant 时按 assistant `createdAt` 边界切分；
   - 最后 assistant 后的迟到事件给 5s grace；仍归属不了的事件丢弃并保留在 trajectory（不伪造气泡）。
3. step：
   - `step` 非法/缺失归 0，并置 `legacy.stepFallback`；
   - reasoning 按 seq/时间排序；call 按 `callSeq`；result 挂到同 `callId` 的 call；
   - 无 callId 用 `synthetic:<seq>`；孤立 result 生成 `synthetic=true` 的工具；
   - 有 reasoning 事件时忽略 `message.reasoning`；无事件时才降级为 step 0、`source="message"`、`legacy.reasoningFromMessage=true`；
   - 无 result 的历史 call 在已完成 assistant 中为 `unknown`，不显示“运行中”。

## 4. UI 行为

- 每个 assistant 消息以 `messageId` 查 `chatTurnsByAssistant`；命中则渲染历史 process，且不再渲染 `ChatMessageReasoning`（避免双份）。
- 历史 process 默认关闭；step 和工具默认折叠；step 按钮带 `aria-expanded`，工具用原生 `<details>`；窄窗 900px 允许换行，不横向溢出。
- 工具名复用现有 `TOOL_LABELS` 中文映射；原始 id 以 mono muted 展示；参数/结果沿用 `formatToolPayload`。
- 历史翻译：
  - 展开 step 才挂载 reasoning 块，首次展开调用 `window.deer.translateText`；
  - `translateHistoryText` 以文本 hash 命中 renderer 会话缓存；并发请求用 pending Map 合并；
  - 实时段完成翻译后写入同一文本缓存，`done → loadChat` 后历史段不再打翻译接口；
  - 译文只在 renderer 内存 + service 现有缓存，不持久化；原文/译文切换复用 `ChatReasoningBlock`。
- 实时去重：
  - 实时气泡仅由当前 `stream/reasoning/chatTools/chatReasoningSegments` 生成；
  - 不再把 live process 挂到最后一条已持久化 assistant；
  - `done/cancelled/error` 清空 live 数组并 `loadChat()`，历史 process 由 turns 接管。

## 5. 旧数据与边界

| 形态 | 行为 |
|---|---|
| 只有 user/assistant 消息 | 只显示最终回复；有 `message.reasoning` 时显示单段「思考 · 旧数据」 |
| 有 reasoning 事件 | 按 step 分段；忽略 message.reasoning |
| 无 step/seq 旧事件 | 全归 step 0，保留 seq 顺序，`legacy.stepFallback` |
| 有 call 无 result | 已完成轮次显示 `unknown`；不显示运行中 |
| 有 result 无 call | synthetic 工具，保留结果/错误 |
| orphan 事件 | 不进 Chat 气泡；trajectory 仍可查看 |
| 无 assistant 的 user | 用户消息正常显示，无伪造 assistant 气泡 |
| turns 加载失败 | 只降级为 `message.reasoning`，不阻断消息/上下文；toast 一次 |

## 6. 验证

在 `branches/t168-chat-turn-history` 执行：

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0（406 modules；css 243.95 kB / gzip 29.33；js 1,220.34 kB / gzip 334.14；main 1.5mb、preload 11.7kb）
pnpm test        # exit 0（50 files / 550 tests）
```

专项：

- `src/kernel/chatTurnProjection.test.ts`：10 个投影用例（单轮/多 step、多 assistant、无 step、callId synthetic、孤立 result、orphan、message.reasoning 降级/去重、分页、容量截断、include 开关、UI step 映射）。
- `src/kernel/chatTranslationMemo.test.ts`：4 个翻译缓存用例（并发/重复去重、实时 prime 复用、失败不缓存/clear、容量上限）。
- `src/kernel/chatTurnService.test.ts`：3 个服务用例（类型/agent 校验、before/hasMore/工具归属、非法游标）。
- 全量 50 files / 550 tests 通过；原有 Chat trajectory/context/translate 测试不回归。

## 7. UI 证据

`docs/team/t168-chat-history.png`（Electron fixture，2026-11-11）：刷新后历史 assistant 在同一气泡内显示「执行过程（2 步 · 3 次工具 · 历史记录）」；展开 step 后可见思考分段、`fs.read` / `git.status` 中文名与参数/结果，最终回复在 process 之后。

## 8. 已知限制 / 后续

- P1：事件没有 schema 级 `turnId`，多 assistant + 晚到事件仍依赖时间窗口；后续可选 additive payload，不改变本期。
- P1：事件读取窗口 2000 条；极端长会话更早页可能只有消息降级（不伪造过程）。
- P1：译文不持久化，重启后首次展开重新翻译；Bing/模型翻译网络失败只保留原文。
- 不含敏感值 redaction（独立立项）；历史工具参数/结果只做容量截断。
- `cancelled` 轮次无独立持久化事件，按现有 messages 降级；不伪造 cancelled 状态。
- 未改 `src/kernel/execution`、工具权限、审批、调度语义；回滚只需删除 `chat:turns` 调用与历史 process 渲染，无数据迁移。
