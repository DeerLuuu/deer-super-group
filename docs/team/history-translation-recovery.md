# 历史分页 / 翻译失败恢复 / 轮次失败重试（P1-2 / t329）

## 范围

- Chat 历史消息分页（最近 40 条起，每次 +40），loading/失败/重试/到底提示，加载更早后保持滚动位置。
- 历史 reasoning 翻译缓存复用 + 失败显示原文 + 单条重试；不自动无限重试。
- 失败/取消轮次沿用 t175 终态；重试只预填 composer，不插入重复用户消息。
- 翻译设置/目标语言指纹变化时清空历史译文缓存；不持久化译文。
- 不新增消息 schema/数据源/权限/gate/kernel。

## 历史分页

- `ChatView` 内部只渲染最近 `min(40, messages.length)` 条；顶部「加载更早」每次 +40。
- 记录加载前 `scrollHeight/scrollTop`，加载后用 `scrollTopAfterPrepend(prevTop, prevHeight, nextHeight)` 补偿，视口不跳。
- 按钮 loading `aria-busy`、失败 `加载失败…可重试`、全部加载后 `已到最早（N 条消息）`。
- 分页逻辑为 renderer 内存切片，不新增第二个数据源；现有 `listChat`/`getChatTurns` 仍为唯一事实源。
- 同时保留服务端 `getChatTurns` 分页：App `loadEarlierChatTurns` 以 `nextBefore` 拉取更早轮次并按 `turnId` 去重合并；失败显示 `historyError`，重试按钮复用。
- 消息不重复：切片按数组尾部，客户端去重只依赖现有 message id；turns 合并按 turnId。
- 上限：`visibleCount` clamp 到 `messages.length`；服务端 `hasMore=false` 时同样显示到底。

## 翻译缓存与失败

- `createChatTranslationMemo` 按文本内存缓存；并发同文本合并；失败不缓存，允许单条重试。
- `translateHistoryText` 读取 `getTranslationSettings()` 指纹：前后都非 null 且变化时 `historyTranslationMemo.clear()`；语义集中在 `translationCacheNeedsInvalidation`。
- `ChatTurnHistoryReasoning` / `ChatMessageReasoning` 共用 `translateHistoryText`；展开才翻译，不随滚动/重渲染重复请求。
- 失败时 `ChatReasoningBlock` 继续显示原文，提示「机翻失败，已显示原文」并提供「重试翻译」；只有用户点击才重试。
- 切换 workspace / 关闭设置时清缓存；译文不写入消息/agent/任务/日志。

## 失败/取消轮次

- `ChatTurnTerminalBubble` 显示 cancelled/error 终态、脱敏摘要、可重试状态；`onRetryTurn` 只调用 `retryComposerState` 预填，不发送、不插入消息。
- 历史回放读取持久化 terminal；`turnByAssistant`/`turnByUser` 只投影现有数据。
- 忙碌时重试按钮 disabled；同一 terminal 不重复渲染。

## 测试

- `chatViewIsolation.test`：150 条 fixture 初始只显示最近 40，连续加载到 150 后同时含 message 0/149；失败注入显示 `加载失败…可重试`；Home/End tabs。
- `chatTurnUi.test`：历史翻译失败显示原文+重试，translate 只调用一次；点击重试才第二次；terminal retry 只 prefill 不发送；实时 terminal 去重。
- `translationCache.test` / `chatTranslationMemo.test`：设置指纹失效语义、失败不缓存、clear 后旧 pending 不回填。
- `chatHistory.test`：滚动补偿与分页 clamp。
- 运行时 1440/960 截图见 PR；键盘/aria 由原生 button + aria-busy/live text 覆盖。

## 截图

- `docs/team/t329-history-translation-1440.png`
- `docs/team/t329-history-translation-960.png`

## 风险 / 回滚

- 仅 renderer 分页/翻译 UI/CSS；无 schema、IPC、kernel、权限/gate 变更。
- 回滚 `ChatView` 的 visible slice/加载按钮与重试按钮即可；消息数据不变。
- 服务端分页 API 已存在，未新增契约。

## t333 修复

- **F1 已挂载译文失效**：App 增加 `translationRevision`；翻译设置保存成功/设置指纹变化时 clear 并 bump。`ChatTurnHistoryReasoning`/`ChatMessageReasoning` 监听 revision：清除旧译文，展开状态重新请求新设置译文。`chatTurnUi` 新增 revision 0→1 后 translate 第二次调用断言。
- **F2 scrollTop 补偿**：`applyHistoryScrollPreservation(node, prev)` 直接设置真实滚动容器 `scrollTop`；`chatHistory.test` 用带 `scrollTop/scrollHeight` 的容器形状断言 120+300=420。
- **F3 server 分页失败不前进**：`loadEarlierChatTurns(): Promise<boolean>` 仅在成功时合并 nextBefore/turns；ChatView 先 await `onLoadEarlierHistory`，false/异常不增加 visible，显示「更早历史加载失败，可重试」，保留缓存/可见范围。`chatViewIsolation` 注入 false 分页断言 message 0 未出现且可重试。
- 1440/960 截图沿用 `t329-history-translation-1440/960.png`。
