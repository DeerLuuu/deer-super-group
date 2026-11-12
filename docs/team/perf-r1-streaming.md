# P0-8 R1：流式隔离（ChatLiveStore / Bridge / Tail）

- **任务**：t260 implementation — R1 流式隔离（captain 收窄：本 PR 只做 R1；R2 面板隔离、R3 刷新降噪另行拆任务）
- **设计基线**：`docs/team/perf-isolation-design.md` §PR R1
- **基线分支**：main `6b8e729`（t250 集成后；含 rail/WorkflowRail/Task Workspace）
- **分支**：`feature/t260-perf-isolation`
- **结论**：token/tool/reasoning 已移出 App 到 external store；App、Dock 其他 panel、rail/WorkflowRail/NeedsMe **不因 token 重渲染**；历史消息与 terminal 保持；tool/terminal/thinking/取消/错误语义保留。R2 的 renderPanel/context 重构与 R3 的 RefreshCoordinator **不在本 PR**。

---

## 1. 问题与目标

R1 之前：

```text
chat delta
  → App setChatStream(...)        // App 52 useState 之一
  → App 全量 render
  → DockShell 新 renderPanel 函数 identity
  → 已挂载 chat/tasks/team 全部重 render
  → ChatView map 全部 messages + 重新 parse Markdown
```

R1 之后：

```text
main chat event
  → ChatLiveBridge（effect-only，不 setState）
  → ChatLiveStore（external store，纯 reducer）
  → ChatLiveTail（唯一完整 state 订阅者）重 render
  → ChatView 不订阅 stream/tools；只订阅低频 terminals Map
  → App / Dock / rail / WorkflowRail / NeedsMe 不 render
```

---

## 2. 实现结构

| 文件 | 作用 |
|---|---|
| `src/shared/chatLive.ts` | `ChatLiveState`、pure `reduceChatLive`（delta/reasoning/segment/tool/result/done/cancel/error）、translation reducer；无 IPC/React |
| `src/shell/chat/chatLiveStore.ts` | `ChatLiveStore`：subscribe/getSnapshot/dispatch/reset/clearLive/beginTranslation；`useChatLiveState`、`useChatLiveTerminals` |
| `src/shell/chat/ChatLiveBridge.tsx` | 顶层 `onChatEvent` 桥；按 workspace 过滤；不持有 React state；done/cancel/error 只回调 settled |
| `src/App.tsx` | 删除 5 个 live useState + `onChatEvent` effect + 旧 translation effect；Bridge 挂 App 根；ChatView 接收 `liveStore`；`ChatLiveTail` 只订阅 store |
| `src/shell/chat/chatLiveStore.test.ts` | store 订阅/workspace/reset/terminal/translation 单测 |
| `src/shared/chatLive.test.ts` | reducer 状态保留矩阵单测 |
| `src/shell/chat/chatLiveIsolation.test.tsx` | 150 条历史 + 6 个 sibling panel + 20 token 的 render count |
| `src/shell/chat/chatViewIsolation.test.tsx` | 实际 `ChatView` + 150 条历史 + 20 token 的 render count |

### 2.1 状态保留矩阵

| 事件 | store 行为 | UI/语义 |
|---|---|---|
| `delta` | `stream += text` | 只 ChatLiveTail |
| `reasoning` | `reasoning += text` | 只 ChatLiveTail |
| `reasoning_segment` | 追加 segment（`live-<step>-<seq>` 稳定 id），清 live reasoning | thinking step 保留；翻译只请求一次 |
| `tool_call` | 按 callId upsert，status=running | 工具行保留 |
| `tool_result` | 按 callId 更新 ok/error/value/error，保留 arguments/step | 结果/错误保留；遗漏 tool_call 也能落结果 |
| `done` | 清 stream/reasoning/segments/tools；terminals 不动 | settled done；sendChat finally 仍 loadChat |
| `cancelled` / `error` | 先按 userMessageId 写 terminal，再清 live | 终态气泡/重试由历史 terminal 路径显示 |
| workspace switch | `reset` 清 live+terminals+translation 请求 | 不串工作区 |
| new turn / clear / compact | `clearLive` 清 live，保留 terminal 历史 | 与旧行为一致 |

> `terminals` 只在 done/cancel/error 变化，且 `clearLive` 不删除；`useChatLiveTerminals` 的 Map identity 在 token 期间不变，所以历史列表不因 delta 重渲染。

### 2.2 thinking/翻译

- `ChatReasoningSegment` 的 `status` + `translation` 仍在 store；`ChatLiveTail` 对每个 loading 段调用一次 `beginTranslation`，成功后 `setTranslation`，失败 `setTranslationError`。
- 使用既有 `translateHistoryText`（含 settings fingerprint + `historyTranslationMemo`），与历史懒翻译共享缓存。
- 与旧实现差异：聊天面板关闭时不再对不可见的 live segment 发起翻译；重新打开时历史仍按懒加载翻译；不改变已持久化语义。

---

## 3. Render / refresh 基线

### 3.1 可复现测试

`src/shell/chat/chatLiveIsolation.test.tsx`：

- fixture：150 条历史消息、6 个 sibling panel（memo）、1 个 live child；
- 20 个 delta，每个在 `act` 中 dispatch；
- 断言：parent / History / SiblingPanels 各 **1 次 render**（初始后不再 render）；live child **≥20 次 commit**；最终 stream 长度 20。

`src/shell/chat/chatViewIsolation.test.tsx`：

- 真实 `ChatView`（150 条 fixture messages）+ `ChatLiveStore`；
- 20 个 delta 后 `ChatViewProbe` 仍 **1 次 render**，live tail 文本出现。

> 测试不依赖真实 Electron；是 render-count/Profiler 等价断言。R1 无 CSS/布局改动，故 1440/960 既有截图与布局矩阵不受影响；未新造视觉基线。真实 Electron 长对话回放仍建议评审阶段按发布检查表抽查。

### 3.2 命令基线（分支最终代码）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **0** |
| `pnpm build` | **0**：430 modules；js 1,277.06 kB / gzip 353.00；css 258.43 / gzip 31.64；electron main 1.5MB/preload 11.9kB |
| `pnpm test` | **0**：89 文件 / 740 用例 |

> 说明：分支包含 t260 前的 rail/Workflow/Task Workspace 等既有代码，故文件/用例数高于 t259 设计时基线；新增 R1 单测/回归均通过。

---

## 4. 回归与语义

- `ChatView` 生产路径只传 `liveStore`；旧 fixture 的 `tools/reasoningSegments/liveTerminals/stream/reasoning` 仍作为**可选兼容 props**，仅在没有 store 的旧测试路径使用；生产不读取这些 props。
- `ChatBubble`/`ChatTurnProcess`/`ChatReasoningBlock` 复用原 UI，工具/思考/终端呈现不变。
- `done/cancel/error` 的 `loadChat` 仍由 `sendChatText` 的 `finally` 负责（与旧 finally 一致）；Bridge 只 `setChatBusy(false)`/错误提示，不新增第二路数据读取。
- terminal 按 `userMessageId` 保留；不伪造 completed/error。
- 未改 `src/kernel/execution/`、`src/git/`、`src/memory/`、`src/review/`、`src/watchdog/`、`electron/`；无权限/gate/数据层改动。
- 取消/错误/长历史：`chatLive.test.ts` reducer + 既有 `chatTurnUi`/terminal 套件全绿。

---

## 5. 已知边界 / 非本 PR

| 项 | 状态 |
|---|---|
| R2 面板 renderPanel/context/stable callbacks | **未做**；拆 t26x，另行任务 |
| R3 RefreshCoordinator / seq gap / 隐藏轮询 | **未做**；拆 t26x，另行任务 |
| 历史 Markdown parse 缓存/memo | R2/后续；R1 通过 App 不 render 避免 token 触发历史 parse |
| 150 条“加载更早” cursor | P1-2，未做 |
| Monaco/虚拟列表/React Compiler/微前端 | 不做 |
| 真实 Electron 1440/960 视觉回归 | 无布局改动；沿用既有窄窗截图；发布前人工抽查 |

---

## 6. 验证命令

```bash
pnpm typecheck
pnpm build
pnpm test
```

分支实测：typecheck 0 / build 0（430 modules）/ test 89 文件 740 用例通过。

## 7. 文件范围

- 新增：`src/shared/chatLive.ts`、`src/shared/chatLive.test.ts`、`src/shell/chat/chatLiveStore.ts`、`src/shell/chat/chatLiveStore.test.ts`、`src/shell/chat/ChatLiveBridge.tsx`、`src/shell/chat/chatLiveIsolation.test.tsx`、`src/shell/chat/chatViewIsolation.test.tsx`、本文件。
- 修改：`src/App.tsx`。
- 未改：`electron/`、`src/kernel/`、`src/git/`、`src/memory/`、`src/review/`、`src/watchdog/`、`src/styles.css`。

## 8. 回滚

R1 是独立提交/PR；回滚只需 revert 本 PR，App 旧 live state 与 onChatEvent 路径整体恢复，不涉及 DB/IPC/schema。R2/R3 未混入。
