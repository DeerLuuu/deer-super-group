# P0-8 流式 / 面板 / 刷新性能隔离设计（R1–R3）

- **任务**：t259 requirements — 依据 `docs/team/ux-audit-final.md` P0-8、`docs/team/ux-audit-shortlist.md` C9 与 t183 可行性报告，先设计性能改造，不写生产代码
- **基线**：main `6b8e729`（t250 集成后；t216/t219 rail、t222 WorkflowRail、t241 Task Workspace 均已在 main）
- **范围**：仅新增本设计文档；不改 `src/`、`electron/`、`dist/`、`dist-electron/` 或事件/消息/terminal/IPC 契约
- **结论**：按 R1 流式隔离 → R2 面板渲染隔离 → R3 刷新降噪拆为 3 个最小 PR（R2 可再分两次提交）；先保证「token 不惊动 App/其他面板」「事件 burst 不重复拉 5 路数据」「失败/漏事件不丢旧 UI」，R4 懒加载/vendor 拆分留到 P1-7。

---

## 0. TL;DR（给评审的 10 行结论）

1. 当前最贵的不是 bundle，而是 **App 单组件持有全部状态 + 每个 chat token 都 setState**：`chatStream/chatReasoning/chatTools/chatReasoningSegments` 都在 App（`src/App.tsx:401-408`），每个 `delta` 触发整棵 App 重渲染（`1435-1513`）。
2. Dock 面板内容通过 **内联 `renderPanel`** 注入（`src/App.tsx:3239`），`DockShell` 把该函数作为 `PanelContentContext.Provider value`（`src/shell/dock/DockShell.tsx:109-123,576`）；函数每次 App render 都是新 identity → 所有已挂载面板重渲染。
3. default 布局实际挂载了 **chat/tasks/team 三个 always 面板**；即使 tasks/team 隐藏 tab 也在渲染树里（`panelRegistry.ts` 的 `renderer: "always"`）。实测首屏 850 DOM 节点、1340 fiber。
4. 事件刷新：`onEvent` → 220ms debounce（`App.tsx:1276-1288`）→ `refresh()` 无条件拉 **snapshot + scheduler + watchdog snapshot + watchdog costs + mergeQueue +（选中任务时）trace + runs**（`App.tsx:1058-1072`），没有 in-flight/seq/请求代际保护。
5. 另外还有隐藏轮询：`useMergeQueue` 非 active 每 **5s**（active 2s，`src/shell/useMergeQueue.ts:39-51`）；watchdog 每 **15s**（`App.tsx:1131-1140`）。空闲时 UI 也在被这些读刷新。
6. Chat 历史没有 memo/parse 缓存：ChatView 每次渲染重新 map 全部消息，`ChatContent` 每次重新 `parseChatContent`（`src/ChatContent.tsx:62`），`Markdown` 没有 memo（`src/Markdown.tsx:4`）。
7. R1 目标：把 live turn 状态移出 App 到 **external store**，只让 `ChatLiveTail` 订阅；messages/trajectory 拆开；tool/reasoning/terminal 按 callId/step 保留。
8. R2 目标：稳定 `renderPanel`/DockShell props，Panel API 不再从 App 闭包注入；分域 React context + memo + 稳定 actions；panel 不随 token 重渲染，快照刷新只让 dirty 域消费者更新。
9. R3 目标：事件→domain 映射、seq gap 检测、单飞 coalesce、dirty-only 读取，取代 mergeQueue/watchdog 的无效轮询；失败保留 last-good，漏事件强制 full refresh。
10. R4（Monaco/虚拟列表/React Compiler/微前端/全量 Dock 重写/新状态库）明确不做；当前不在 R1–R3 内做「150 条加载更早」，它仍归 P1-2。

---

## 1. 现状盘点（可复核）

### 1.1 App 状态与渲染拓扑

| 观察 | 代码/测量 | 影响 |
|---|---|---|
| App 是 6,279 行单组件，52 个 `useState`、43 个 `useEffect` | `src/App.tsx` 实测 | 任意状态更新都会重跑 App 函数，所有内联派生/回调重新创建 |
| `chatStream/chatReasoning/chatTools/chatReasoningSegments/liveTerminals` 在 App | `App.tsx:401-408` | 每 token/工具事件触发 App 全量 render |
| `onChatEvent` 在 App 直接 setState | `App.tsx:1435-1513` | delta/reasoning/tool 事件全部走 App；done/cancel/error 还触发 `loadChat()` |
| `ChatView`/`ChatBubble`/`ChatTurnProcess` 均在 App 内且未 memo | `App.tsx:5379,6176,6395` | App render 时消息列表、live process 重新渲染 |
| `ChatContent` 每次 render 重新 parse；`Markdown` 无 memo | `src/ChatContent.tsx:62`；`src/Markdown.tsx:4` | 历史每条 assistant 消息每次 token 都可能重新 Markdown 解析（O(历史长度)） |
| `renderPanel` 为内联箭头函数 | `App.tsx:3239` | 每次 App render 新 identity；`DockShell` context value 变化 |
| `PanelContentContext.Provider value={renderPanel}` | `DockShell.tsx:576` | 所有 `DockPanelBody` consumer 更新；隐藏 tab 也重渲染 |
| default 面板挂载数 = chat/tasks/team 三个 always | `panelRegistry.ts`；CDP `.dock-panel-body` = `["chat","tasks","team"]` | 首屏即多渲染一个隐藏 TasksView + 星图 |
| `WorkflowRail`/`NeedsMe` 在 App shell 内从 snapshot/taskRuns/scheduler/mergeQueue/watchdog 派生 | `App.tsx:2926-2937,3168-3173` | 与 panel 必须共享同一 snapshot；R2 不能引入第二套数据源 |
| `rail`/`activePanelKey` 从现有 Dock/route 派生 | `App.tsx:2924-2925` 等 | R2 不新增面板状态，保持 rail/Workflow 一致 |

### 1.2 刷新区链路

**事件刷新（App）**

```text
service.emit / store event
  → electron main webContents.send("app:event", EventRecord)   (main.ts:136)
  → App onEvent(listener)                                      (App.tsx:1276-1283)
  → clearTimeout + setTimeout(220ms)                           (App.tsx:1278-1282)
  → refresh(workspaceId)                                       (App.tsx:1058)
      getSnapshot(workspaceId)          // full tasks/messages/board/settings
      loadScheduler(workspaceId, true)  // 1 IPC
      loadWatchdog(workspaceId)         // getWatchdogSnapshot + getWatchdogCosts = 2 IPC
      loadMergeQueue()                 // 1 IPC，即使 Modal 未开
      if selectedTask:
        loadTrace(taskId)              // 1 IPC，最多 2000 events
        loadRuns(taskId, true)          // 1 IPC
  → setSnapshot(...) + 各独立 setState
```

- 每次 burst 固定 **5 个 IPC**（snapshot + scheduler + watchdog×2 + mergeQueue），选中任务时 **7 个**。
- 220ms debounce 只合并「间隔 <220ms 的连续事件」；没有 **in-flight guard**，两个刷新可重叠，旧 snapshot 可能后到覆盖新值；没有 seq gap 检测。
- `EventRecord` 已带 `seq`、`aggregateType`、`type`、`payload`（`src/shared/types.ts:143+`），但 App 的 listener 忽略 payload，全部走全量 snapshot。
- `refresh()` 没有 try/catch：getSnapshot 失败会成为 unhandled rejection；没有 last-good/stale 状态。
- 当前 `getTaskTrace` 固定最多 2000 事件（`service.ts:2347`），每次 refresh 选中任务都重取。

**独立轮询（不在 App refresh 内，但同样造成渲染/读取）**

| 来源 | 频率 | 可见性 | 问题 |
|---|---|---|---|
| `useMergeQueue` 非 active | 5,000ms | 任意工作区存在就轮询 | Modal/队列面板未开也读；与 `refresh()` 的 `loadMergeQueue` 重复 |
| `useMergeQueue` active | 2,000ms | 队列 Modal 打开 | 打开期间可接受，但仍应与事件合并 |
| watchdog | 15,000ms | 始终 | 空闲时也拉 snapshot + costs |
| `PollPanel` 时钟 | 30,000ms | 仅挂载时（onlyWhenVisible） | 纯 UI 倒计时，不是数据轮询，保留 |
| `event→refresh` | 事件后 220ms | 任意事件 | 无 domain 过滤 |

### 1.3 流式/会话链路

```text
sendChat (App) → chat:send → service stream
  → chat:event IPC
  → App.onChatEvent:
       delta             → setChatStream(prev + text)       → App render
       reasoning         → setChatReasoning(prev + text)    → App render
       reasoning_segment → append segment(random id), reset reasoning → App render
       tool_call/result  → upsert chatTools by callId        → App render
       done              → clear live + loadChat()           → App render + 4 IPC
       cancelled/error   → terminal map + clear + loadChat()→ App render + 4 IPC
  → ChatView receives all live props
      → message map (每条 ChatBubble/ChatContent/Markdown)
      → live ChatBubble (stream/reasoning/process)
```

- `ChatContent` 历史路径每次 `parseChatContent`（`ChatContent.tsx:62`）；live path 也调用 `stripInteractiveForStreaming` 和 `Markdown`。没有 parse/markdown 缓存。
- `ChatTurnProcess` 每次 ChatView render 重新接收 tools/reasoning 数组；即使数组未变，也会随 stream 更新一起重渲染（未 memo）。
- `done/cancel/error` 都执行 `loadChat()`：`listChat 100 + getContext + getChatTurns(200 msgs/2000 events→20 turns) + questions`（`App.tsx:994-1012`；audit P2）。这是轮次结束成本，不是每 token；R1 不改契约，但要避免和 app event 刷新叠加。
- `getChatTurns` 有 userMessageId 绑定、terminal/幂等语义（t168/t172/t175）；R1 必须保留 `liveTerminals` 按 `userMessageId` 的 key，不伪造 completed/error。

### 1.4 面板渲染链路

```text
App render
  → renderPanel inline (new function)
  → DockShell re-render
  → PanelContentContext.Provider value={new function}
  → every DockPanelBody consumer re-render
  → render(key) switch
  → TasksView/TeamDashboard/ChatView/MailboxView/... all recreated props/elements
  → hidden tasks/team (always renderer) also render
```

- `PanelContentContext` 默认 `() => null`（`DockShell.tsx:109-111`），`DockPanelBody` 只负责取 render；没有 memo。
- `DockShell` 自身未 memo；App 任何 render 都会把新 `renderPanel`/`onActivePanelChange`/`onPanelClose`/`onNotify` 传入；`onActivePanelChange` 等即使内部用 ref，DockShell 仍会因 props 新 identity re-render。
- 面板内部状态（筛选、滚动、展开）大多在面板组件自身；R2 不改变 `always`/`onlyWhenVisible` 生命周期，避免改变面板本地状态语义。
- `TasksView`、`TeamDashboard` 等从 App 接收大量 inline 回调（`onSelect`, `onStartTask`, `onReviewTask`…）；这些回调每次 App render 新 identity，memo 单靠 `React.memo` 无法避免重渲染。

### 1.5 派生数据（rail/Workflow/NeedsMe）一致性

- `workflowProjection = deriveWorkflow({tasks, runs, scheduler, mergeQueue})`、`needsMe = deriveNeedsMe({tasks, mergeQueue, watchdog})` 在 App render 内计算（`App.tsx:2926-2937`）。
- 它们与 Tasks/Team panel 读的 snapshot/scheduler/mergeQueue 是同一份数据；R2 不能把这些投影搬到各 panel 私有 store，否则会出现 rail 与 panel 不一致。
- 事件刷新必须 **一个批次** 应用 snapshot/scheduler/watchdog/merge 结果，React 自动批处理（React 19）保证同一次 commit；避免「WorkflowRail 已显示完成，Tasks panel 仍是失败」的中间帧。
- R3 的 domain 过滤只决定 **取哪些域**，不改变 rail/Workflow 的输入源；所有域仍由同一个 `snapshot`/side state 供给。

### 1.6 可复现基线（本机 main 6b8e729）

**方法**：`pnpm build` 后用 Electron 打开本机 `按钮工厂` workspace，`--remote-debugging-port=9237`；通过 CDP 只读调用 App 的 preload API 与 DOM 查询。React commit hook 通过 `Page.addScriptToEvaluateOnNewDocument` 在 reload 前安装（不改源码）：

```js
// 仅用于测量；不进入生产代码
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  inject() { return 1; },
  onCommitFiberRoot(_id, root) {
    let fibers = 0;
    const stack = [root.current];
    while (stack.length) {
      const f = stack.pop(); if (!f) continue; fibers++;
      if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling);
    }
    window.__REACT_COMMITS.push({ t: performance.now(), fibers });
  },
};
```

| 指标 | 实测 |
|---|---|
| 视口 / DOM | 1424×881；850 nodes；3 个 `.dock-panel-body` = chat/tasks/team；5 个 Dock tab |
| 工作区规模（小样本） | tasks 0、mailbox 0、board 0、chat messages 13、chat turns 7；snapshot JSON **2,300 chars** |
| `getSnapshot` | 5 次 147–237ms（2.3KB；同一 remote 调用；不是 payload 大小主导） |
| `getWatchdogSnapshot` / `getWatchdogCosts` | 各 146–190ms；每次 refresh 同时调用两者 |
| `getScheduler` / `mergeQueue` / `listChat` | 0.1–0.8ms |
| `getChatTurns(limit 20)` | 3.1–4.0ms，7 turns / **85,235 chars** |
| React initial commits | 9 commits（含首屏/加载） |
| 空闲 10s（无输入） | **3 commits**；代码侧存在 mergeQueue 5s/watchdog 15s 定时器，但本次未逐事件归因，不能把 3 次都归给某个轮询 |
| 手动「刷新」一次 | **1 commit**；全树 1,340 fiber（commit-level 计数；生产 minified 名无法区分组件） |
| 小样本 longtask | 未捕获（workspace 太小；本次手动刷新未形成可归因负载）；不能代表 150 消息/2000 trace，必须用 fixture 补测 |

**基线限制与补救（R1/R2/R3 开工前必须做）**：

- 当前 workspace 是空任务/13 条消息，不能证明长历史/多面板；R1 PR 增加 **perf fixture**（不新增生产数据）：
  - 150 条 assistant/user chat 消息，其中 20 条含代码块；7–20 turns；200 个 tasks（含 20 个 failed/blocked、5 个 running）；60 条 mailbox；60 条 board；6 个面板（chat/tasks/team/board/mailbox/runs）同时挂载。
  - fixture 用 `react-test-renderer`/测试 DOM 渲染，记录 commit duration、render count、Markdown parse count；真实 Electron 用同一 workspace DB 副本或 test-only fixture app path。
- component-level render count 需要 React Profiler（`<Profiler>`/`onRender`）或 R1 的测试 store；本设计不以 commit-level 冒充 component-level。
- 复现脚本/命令见 §8 附录；所有数字只用于同一机器相对比较，不承诺跨机器绝对值。

---

## 2. R1：流式隔离（只更新 Chat streaming subtree）

### 2.1 目标

- `delta`、`reasoning`、`reasoning_segment`、`tool_call`、`tool_result` 只更新 **ChatLiveTail / 当前 live turn**；App、DockShell、Tasks/Team/Mailbox/Board 不 render。
- `messages`（已完成历史）、`trajectory` 与 live turn 分离；历史 Markdown 不因 token 重新 parse。
- 不丢 `tool`（callId 对应 arguments/result/error/status）、`terminal`（userMessageId 绑定）、`thinking/reasoning`（step/segment）状态。
- 保留 t168/t172/t175 契约：`done/cancel/error` 后仍用 `loadChat` 获取 userMessageId/terminal；不改变事件类型/IPC。

### 2.2 结构

```text
App (no chat live state)
  ├─ ChatView (memo boundary; no live state subscription)
  │   ├─ ChatHeader / controls (snapshot metadata; rerender only on inputs)
  │   ├─ ChatMessageList (memo; messages/history/questions/terminals snapshot)
  │   ├─ ChatLiveTail (subscribes ChatLiveStore; only this updates per delta)
  │   └─ ChatComposer (own input state; no App rerender per keystroke)
  └─ ChatLiveBridge (effect only; subscribes window.deer.onChatEvent; no React state)
        └─ chatLiveStore (external store, module singleton per workspace)
```

- `ChatLiveBridge` 挂在 App 顶层（chat panel 被关闭时仍能接收 done/cancel/error，不丢 terminal），只调用 `chatLiveStore.dispatch(event)`；事件更新 external store，不 setState App。
- `ChatLiveTail` 用 `useSyncExternalStore`（或 `useSyncExternalStoreWithSelector`）订阅 `{stream, reasoning, segments, tools, terminals}`；只有它的 React 子树更新。
- `ChatMessageList` 用 memo + stable props；`ChatBubble` / `ChatContent` / `Markdown` 加 `memo`/`useMemo` parse cache；历史消息内容不变时，token 不会重新解析 Markdown。
- `ChatLiveTail` 只渲染当前 live turn：
  - `ChatBubble` streaming content + `ChatTurnProcess`（reasoning/tools）。
  - `ChatLiveTail` 不渲染历史消息；历史消息在 `ChatMessageList`。
- `trajectory` 独立：`ChatTrajectoryPanel` 只在 `view==="trajectory"` 挂载/订阅；stream 不影响它。

### 2.3 Store 形状与 reducer

```ts
type ChatLiveState = {
  workspaceId: string | null;
  agentId: string | null;
  stream: string;
  reasoning: string;
  segments: ReasoningSegment[];       // id = `${step}:${ordinal}`，不使用 Date.now 随机
  tools: ChatToolTrace[];              // upsert by callId
  terminals: Map<string, ChatTurnTerminal>; // key = userMessageId
  phase: "idle" | "streaming" | "settled";
  lastEventAt: number;
};
```

| ChatEvent | reducer | 保留语义 |
|---|---|---|
| `delta` | `stream += text` | 只更新 live tail；不写 messages/history |
| `reasoning` | `reasoning += text` | 保持 reasoning 与 segment 的当前状态 |
| `reasoning_segment` | `segments.push({id: step:ordinal, text, status:"loading"})`; `reasoning=""` | id 稳定，避免重渲染 key 抖动；重新计算 ordinal 按 step |
| `tool_call` | upsert by `callId` with `arguments`, `status:"running"` | 保留旧 arguments；同一 call 重入幂等 |
| `tool_result` | upsert by `callId` with `value/error/status`, 保留 arguments | 不丢 tool detail；不因 snapshot refresh 清空 |
| `done` | `phase=settled`; clear stream/reasoning/segments/tools; `onSettled()` | `done.message` 可先触发一次 messages merge；随后 `loadChat` 仍为权威 |
| `cancelled/error` | 写 `terminals[userMessageId]`（若有）；清 live；`onSettled()` | terminal 按 userMessageId，保留历史状态；不伪造成功 |
| 新 turn/clear/compact/workspace switch | `reset(workspaceId)` | 切 workspace 不泄漏旧 stream；调用方重置 live terminal（仅按现有语义） |
| 其他事件 | ignore | 不扩大事件契约 |

**store 规则**：

- `dispatch` 只在 `event.workspaceId === store.workspaceId` 时生效；agentId 过滤 Router。
- `reasoning_segment` 的 id 用 step + 序号（store 内按 step 计数），不引入随机/时间，避免每次 render key 改变；如历史保留需要，仍由 `ChatTurnHistoryProcess` 投影，不把 live segment 写入 DB。
- `tool_call/result` upsert 保证同一 callId 只一项；这与现有 App 逻辑一致（`App.tsx:1455-1481`），但移出 App 后必须用不可变数组替换。
- `terminals` 是 `Map`，更新时创建新 Map（current code 同）；`ChatMessageList` 只在 terminal 变化时重渲染，不在 token 时更新。
- `done/cancel/error` 的 `loadChat` 从 App 移到 `onSettled` callback；callback ref 保证不因 App render 重建（Bridge 内 ref）。
- **不做**：不把 `messages` 写入 live store；不把 `busy` 每 token 写 App；不删除 `liveTerminals` 在 done 时（当前行为保留）。

### 2.4 Markdown / 历史缓存

- `ChatContent`：
  - 非 streaming 分支 `parseChatContent(content)` 用 `useMemo([content, messageId])` 或外层 memo 包裹；历史内容不变时复用 blocks。
  - streaming 分支 `stripInteractiveForStreaming` 用 useMemo；live content 只对当前 stream 解析，历史不参与。
- `Markdown`：`memo(({content}) => ...)`；复用现有 ReactMarkdown；如需要再在 `ChatContent` 内缓存 parse 结果，不引入新的 Markdown 库。
- `ChatBubble`：`memo`，props 只有变化才渲染；`process` 用 memoized 组件/元素，tools/segments 仅在事件时变。
- `ChatMessageList` 的 `messages.map` 每 commit 仍会执行（父 ChatView 若重渲染），但历史 ChatBubble memo 会 bail；更彻底：`ChatView` 不订阅 live store，父组件只在 messages/view/controls 变化时 render，live tail 独立更新。这样 token 时连 message map 都不会执行。
- `ChatLiveTail` 的 `ChatTurnProcess` 传入 tools/segments/stream；其内部按 step 分组可用 useMemo；确保工具/思考状态不在 stream 更新时丢失（数组不变引用，不让子组件重建状态）。

### 2.5 R1 验收与测试

- **render count（150-message fixture，React Profiler/`onRender`）**：
  - 20 次 `delta`：`App`、`DockShell`、`ChatView`（如果不订阅 live）、`ChatMessageList`、`TasksView`、`TeamDashboard`、`MailboxView`、`TaskStarMap` **0 render**；
  - `ChatLiveTail` 至少 1 次/批，最多 20 次（若按帧合并 token）；历史 `Markdown` parse 0 次；每帧只解析 live content。
  - 100 条历史消息 + 20k 字代码块续流：无 >50ms long task（测试环境记录），输入/滚动回归由真实 Electron 补充。
- **状态不丢**：单测构造事件序列 `reasoning → reasoning_segment → tool_call → tool_result → delta → done` 和 `cancelled/error`，断言 segments/tools 的 callId/arguments/status/error 保留；terminal 的 userMessageId 正确；完成/失败后仍有历史；不重复消息。
- **重开/切 panel**：chat tab 被关闭再打开/切 workspace，store reset 不泄漏旧 workspace；live tail 重挂载后历史仍来自 App messages，terminal 来自 store/历史。
- **契约**：不改 `ChatEvent` 类型；t168/t172/t175 的 projection/terminal 测试全绿；`typecheck/build/test`。
- **阈值**：App 在 token 事件下 render=0，是硬性；其他组件 render=0；live tail 每帧最多一次（16ms coalesce）。若批次延迟导致视觉卡顿，允许不合并但必须仍只动 live tail。

### 2.6 R1 风险/回滚

- 事件与 UI 状态不同步（tool result 找不到 callId、terminal 丢失）：store reducer 单测覆盖 upsert/清理/workspace reset；UI 不直接读 IPC。
- `ChatLiveBridge` 在 chat panel 关闭后仍订阅：内存/事件泄漏；在 App 顶层，workspace 切换时 reset；不依赖 ChatView 生命周期。
- done/cancel 与 loadChat 竞态：`onSettled` 用现有 requestId/`liveTerminals` 语义，保留「完成优先于 terminal」；不新造第二套消息状态。
- 回滚：revert R1 单提交即可；messages/turns/terminal 契约未变，旧 App 可继续跑。

---

## 3. R2：面板渲染隔离（stable render boundary）

### 3.1 目标

- token（R1 后不再触 App）不得触发任何 Dock panel render；
- snapshot/scheduler/watchdog/mergeQueue 更新只让相关面板/上下文消费者更新；
- 稳定 `DockShell` props/renderer identity，稳定 actions，避免每次 App render 重建元素/对象；
- rail/Workflow/NeedsMe 与 panel 使用同一数据源和同一批次，不出现不一致。

### 3.2 关键问题

当前 `renderPanel` 内联 + `PanelContentContext.Provider` 的链路使 App 的每个 setState 都等价于「所有已挂载面板重渲染」。只加 `React.memo(Panel)` 不够：父级仍会 `render(key)` 生成新 element/props；inline callbacks 也会破坏 memo。

### 3.3 架构：stable render + 分域 context

```text
App (state owner / actions owner)
  ├─ Snapshot providers (split):
  │    TasksContext, AgentsContext, MailboxContext, BoardContext,
  │    SchedulerContext, TaskDetailContext, WatchdogContext,
  │    PlanContext, UiSelectionContext
  ├─ PanelActionsContext (stable facade; refs to latest handlers)
  ├─ ChatLiveContext (external store; only ChatLiveTail subscribes)
  └─ DockShell (memo; props: workspaceId/dockWidth/windowWidth/maxGroups/initialPanelKey/stable callbacks)
        └─ stable panel components map (chat/tasks/team/...), no renderPanel prop
              └─ Panel components consume contexts; memo boundaries
```

**核心决定**：

1. **删除 App→DockShell 的 `renderPanel` 闭包**。`DockShell` 内部 `PANEL_COMPONENTS` 直接映射到稳定的 `PanelBody` wrappers；`PanelBody` 从 contexts 读数据/actions。这样 App state 不再生成新的 panel elements。
2. `DockShell` 用 `memo(forwardRef(...))` 或内部 memo；props 全部稳定：
   - `onActivePanelChange`、`onPanelClose`、`onNotify` 用 `useCallback`/ref facade；
   - `renderPanel` 移出（或保留为稳定 module-level 函数，不捕获 App state，推荐移除）。
3. App 在 **providers 之外** 只把稳定 callbacks/workspace 布局 props 传给 DockShell；panel data 通过 contexts 下发。
4. Context 值用 `useMemo` 按 slice identity；domain provider 只在该 slice 更新时改变：
   - `TasksContext = snapshot.tasks`；`AgentsContext = snapshot.agents`；`MailboxContext = snapshot.messages`；`BoardContext = snapshot.boardEntries`；`SettingsContext = snapshot.settings`。
   - `SchedulerContext = scheduler`；`TaskDetailContext = {selectedTask, trace, taskRuns, loading/errors}`；`WatchdogContext = {snapshot,costs,handoffs}`；`PlanContext`；`UiSelectionContext`（selected ids/create intents 等）。
   - 每个 provider 只在对应 state 变时生成新 value；不要把所有 state 打成一个 context。
5. **Panel actions**：`PanelActionsContext` 的值只创建一次，内部用 `actionsRef.current` 指向最新 App handlers：
   ```ts
   const actionsRef = useRef(actions);
   actionsRef.current = actions; // latest handlers, but context identity stable
   const facade = useMemo(() => ({
     selectTask: (id) => actionsRef.current.selectTask(id),
     startTask: (id) => actionsRef.current.startTask(id),
     ...
   }), []);
   ```
   panel 不接收 inline function props；memo 有效，且不会捕获 stale state。
6. **Memo boundaries**：
   - `memo(ChatView)` 不订阅 live store；`memo(ChatMessageList)`、`memo(ChatBubble)`、`memo(ChatContent)`、`memo(Markdown)`。
   - `memo(TasksView)`、`memo(TeamDashboard)`、`memo(TaskStarMap)`、`memo(MailboxView)`、`memo(MemoryWorkbench)`。
   - Context 消费者仍会按 context 更新；memo 只阻止无关父 render。
7. **保留 existing panel lifecycle**：不改变 `renderer: "always"|"onlyWhenVisible"`、默认布局、Dock 存档 schema、切换/重开行为；不将隐藏面板全部卸载（避免状态丢失）。
8. **数据一致性**：
   - `snapshot` 仍是单一事实源；rail/Workflow/NeedsMe 继续从 App 的 snapshot/scheduler/mergeQueue/watchdog 派生，panel 读同一份 slice；
   - 所有 domain setState 在同一事件批处理/同一 refresh batch 应用（R3），保证一次 commit 里任务状态、Workflow、NeedsMe 一致；
   - `deriveWorkflow/deriveNeedsMe` 只做纯投影，不缓存到 panel 私有状态；
   - panel 的本地筛选/滚动/展开状态保留；R2 不迁移为全局 store。

### 3.4 与 R1 的边界

- R1 已让 Chat live store 独立；R2 **不再**把 `chatStream` 放回 App。
- Chat panel 是 `always`；R2 的 `ChatView` 只订阅 messages/history/questions（低频），`ChatLiveTail` 订阅 live store；token 只走 live context。
- `busy` 用于 composer/controls（发送/停止），只开始/结束变化；留在 App 或 ChatPanel 本地均可，不参与 token。

### 3.5 R2 验收与测试

- **token**：20 deltas 后（R1 已保证 App 0；R2 再加）`TasksView`、`TeamDashboard`、`MailboxView`、`MemoryWorkbench`、`TaskStarMap`、`ChatMessageList` render count = 0；`DockShell` 0；panel mount count 不变。
- **snapshot domain**：只更新 `tasks` 时，TasksView/Workflow/NeedsMe 更新；Mailbox/Memory/Team（若未消费 tasks）不 render；更新 `scheduler` 只影响 Tasks/Runs/Workflow，不触发 Mailbox/Memory。
- **actions**：点击 Start/Review 等仍触发一次正确 handler；panel props 不因 App render 变化；按钮 disabled/loading 状态来自对应 context。
- **一致性**：同一 refresh batch 后，Tasks panel / WorkflowRail / NeedsMe 的 task status 集合一致；rail active 不变；Dock 布局/local panel state 不重置。
- **性能**：150 消息 + 6 panel fixture，snapshot 刷新 commit duration ≤ 16ms（不含 IPC；仅 React 工作）；token 期间无 panel render。
- **契约**：不改 t168/t172/t175；t216/t219 rail、t222 WorkflowRail、t241 Task Workspace 点击路径回归；`typecheck/build/test`。

### 3.6 R2 风险/回滚

- **高**：把 App 的 panel JSX/状态拆到 contexts 是高风险重构；必须行为等价测试（Task/Team/Chat/Plan/Git/Memory/Poll/Watchdog）和真实 Electron 截图。
- 回调 stale：actions ref facade 每次只读最新 ref；不要在 provider render 时调用 actions。
- Context 过粗：若把整个 snapshot 放一个 context，仍会让所有 panel 在 refresh 时重渲染；必须按 slice 拆分；R3 的 dirty slice merge 进一步减少。
- 面板重开/本地状态：不改变 always/onlyWhenVisible/生命周期；测试面板关闭重开、筛选保留。
- 回滚：R2 单提交/或两个可独立 revert 的提交（stable renderer + contexts）；回滚后 R1 仍可单独工作；Dock 存档不涉及。

---

## 4. R3：刷新降噪（event-driven + coalesce + last-good）

### 4.1 目标

- 事件 burst 合并为一次刷新，避免「每事件 5 路 IPC」与重叠覆盖；
- 用 `EventRecord` 的 `type/aggregateType/seq/payload` 做 **domain 过滤**：只拉需要域，未知/缺口全量；
- 移除隐藏的无效轮询：mergeQueue 5s、watchdog 15s 改为事件驱动 + 可见性/低频安全网；
- 失败保留 last-good，漏事件/seq gap/重连可恢复；不改变事件/消息/terminal/IPC 契约。

### 4.2 中央 RefreshCoordinator

新增纯模块（建议 `src/shell/refreshCoordinator.ts`，不依赖 React/store）：

```ts
export type RefreshDomain =
  | "snapshot" | "tasks" | "agents" | "mailbox" | "board" | "settings"
  | "scheduler" | "watchdog" | "mergeQueue" | "selectedTask" | "chat" | "plan";

export class RefreshCoordinator {
  private dirty = new Set<RefreshDomain>();
  private timer: number | null = null;
  private inFlight = false;
  private generation = 0;
  private lastSeq: number | null = null;
  queue(event: EventRecord, workspaceId: string): void;
  request(domains: RefreshDomain[], reason: "action"|"resume"|"gap"): void;
  flush(): Promise<RefreshResult>;
  status(): { stale: boolean; lastSuccessAt: number; lastError?: string };
}
```

**事件映射（默认规则）**

| Event type / aggregate | dirty domains | 说明 |
|---|---|---|
| `task.*`, `run.*`, `review.*` | `snapshot`, `scheduler`, `selectedTask`（若选中） | run 结束/失败会改变 task 状态；trace/runs 仅 selected |
| `merge.*`, `git.*`, `pr.*` | `mergeQueue`, `snapshot`（任务链接状态） | 不再无条件拉 mergeQueue |
| `agent.*`, `workspace.*` | `snapshot`, `agents` | 成员/工作区 |
| `message.*`, `mailbox.*` | `snapshot`, `mailbox` | mailbox 列表 |
| `board.*`, `memory.*` | `snapshot`, `board` | 记忆 |
| `settings.*`, `provider.*`, `model.*` | `snapshot`, `settings` | Settings 只影响 shell/chat controls |
| `watchdog.*`, `budget.*`, `alert.*` | `watchdog`, `scheduler` | 预算/告警 |
| `chat.*`, `assistant.*` | `chat`（仅结束态/必要） | live 走 `onChatEvent`；R3 不因 token 走 app event |
| 未知/无 mapping | `snapshot` + `scheduler` + `watchdog`（保守） | 首次/未知事件回退全量 |

> 映射是 **front-end 失效提示**，不直接修改 snapshot；最终数据仍由 `getSnapshot`/side API 返回，避免双写。

**Coalescing**：

1. 收到事件：检查 workspace；`seq <= lastSeq` 忽略重复；`lastSeq !== null && seq > lastSeq + 1` → 标 gap，强制 `snapshot` full。
2. 加入 dirty；若没有 timer，安排 **120ms** trailing flush（现在是 220ms；120ms 降低等待，事件 burst 仍合并）。
3. flush 时：
   - 若 `inFlight`，只保留 dirty + 标记 pending，不启动第二组 IPC；
   - `generation++`；`Promise.all` 取需要域（snapshot + conditional side reads）；
   - 结果经 `generation` 校验后 **一次 apply**（React 自动批处理）；旧响应丢弃；
   - 成功后更新 `lastSeq` 到触发事件最大 seq、清 dirty、`lastSuccessAt`；
   - 失败按 §4.4 处理，不推进 `lastSeq`（下一个事件会重试/补 gap）。
4. `action` 触发（writeThenRefresh）走同一 coordinator，`immediate` flush，避免「写操作 refresh + 事件 refresh」两份。
5. `resume/focus/visibilitychange`：如果 `now-lastSuccessAt > 30s` 或 gap，`request(["snapshot","scheduler","watchdog","mergeQueue"])`；恢复时先取一次 last-good，后台静默更新。

### 4.3 读取预算（每个 burst）

| 场景 | 当前 | R3 目标 |
|---|---|---|
| 普通 task/run 事件 | snapshot + scheduler + watchdog×2 + mergeQueue + trace + runs（5–7） | **1 snapshot**（+ selected task 的 runs/trace，仅当 selected 且相关）+ scheduler 仅当 task/run |
| watchdog/alert 事件 | 同 5–7 | watchdog×2；另 scheduler 仅当 alert 影响 task |
| merge/git/pr 事件 | 5–7 | mergeQueue；snapshot 仅当任务状态可能变 |
| chat 结束 | app event 5–7 + chat loadChat 4 | **chat loadChat 4**（app event 不触发 snapshot） |
| 未知/首次/断线恢复 | 5–7 | **full** 1 snapshot + all needed side reads（明确 reason） |
| 空闲 10s（无事件、无面板） | mergeQueue 2 + watchdog 0–1 | **0**；可见 MergeQueue 才 2s，watchdog topbar 才低频 safety |

### 4.4 失败、漏事件与恢复语义

| 场景 | 行为 |
|---|---|
| getSnapshot 失败 | 保留 last-good snapshot / derived；不 `setSnapshot(null)`；`stale=true` + `lastError`；用 ErrorRecoveryBar/inline retry（cooldown 一次），不重复 toast；retry 250/500/1000/2000ms（上限 5s），成功后清 stale |
| side read 失败（scheduler/watchdog/trace/runs/mergeQueue） | 只标对应域 error/unknown；不清 snapshot；不阻塞其它域；trace/runs 面板显示局部错误/最后数据 |
| 事件 seq gap | 标记 gap；强制 full `snapshot`，重置 dirty；失败则保留旧 UI，下一次事件/resume 再试 |
| 事件 channel 丢/窗口 reload | 初次 mount full；visibility/focus resume 超过 30s 或 gap full；不把「无事件」误判为空 |
| 事件重复/旧刷新结果 | `seq <= lastSeq` 忽略；`generation` 不匹配丢弃；React 一次 apply |
| 刷新请求重叠 | in-flight 合并 pending；最多一个 snapshot 在飞；不与 action refresh 并行 |
| 断线恢复 | recover 后 full refresh；`stale` 清除；长历史聊天以 `loadChat/getChatTurns` 重新对齐，不伪造 stream；若聊天事件丢失，保留历史并以 terminal 状态显示 |
| 轮询安全网 | mergeQueue 仅可见时 2s（当前），隐藏时移除 5s；可保留 **可见面板 30s** 低频繁安全网（需产品确认）；watchdog topbar 可见时 60s safety（替代 15s）；无面板时 0 |

### 4.5 轮询改造清单

- `src/shell/useMergeQueue.ts`：
  - active（Modal 打开）保留 2s（或合并到 coordinator 的 2s tick；避免双计时器）；
  - 非 active 删除 5s interval；由 `git/merge/pr` 事件 `invalidate`；如「外部队列变化无事件」风险，接受 **面板可见时 30s** safety，或由主进程在 enqueue 时 emit 事件（推荐；不改契约，只是已有事件源）。
  - 测试：fake timers 断言 hidden 0 次、active 2s、事件 invalidate 1 次。
- `src/App.tsx` watchdog 15s interval：
  - 删除常驻 interval；挂载/切 workspace 初载一次；`watchdog.* / budget.*` 事件刷新；
  - 仅 topbar 可见/预算告警时 60s safety；页面隐藏时暂停（`visibilitychange`）。
- `refresh()` 的 `loadMergeQueue()` 删除或改由 `mergeQueue` domain；`loadWatchdog` 不再每次 refresh 无条件调用。
- `trace/runs`：
  - 只有选中 task 且 `TaskDetail/任务面板可见` 或事件 aggregate 匹配 selected 时刷新；
  - `getTaskTrace` 仍最多 2000，R3 不实现分页（P1-2/P1-7）；避免每次 snapshot 重取。
- `getChatTurns`：
  - 只在 chat done/cancel/error/用户加载历史时调用；app event 不触发；R1 的 onSettled 已在结束后一次。
- `PollPanel` 30s 时钟保留（纯倒计时，不读数据）。
- `watchdog` 预算条初始值仍由初次 load 提供；事件驱动更新，避免 15s 轮询。

### 4.6 R3 验收与测试

- **计数测试（fake API + fake timers）**：
  - 20 个 task/run 事件在 500ms 内：getSnapshot 1 次；getScheduler ≤1（仅 task/run）；getWatchdog* 0；mergeQueue 0；trace/runs 仅在 selected 相关时各 ≤1。
  - 20 个 merge/pr 事件：mergeQueue 1 次，snapshot 0/1（按映射），trace/runs 0。
  - chat done：app `getSnapshot` 0；`loadChat` 1 次；后续 5s 内无重复。
  - 10s idle：getSnapshot 0，mergeQueue 0（隐藏），watchdog 0；active queue 2s/次，topbar 60s/次。
  - 事件 seq gap（last=10，收 12）：1 full snapshot；seq 重复/旧 generation：0 次应用。
- **失败测试**：getSnapshot reject → snapshot 保留、stale=true、retry 序列 ≤5；side read reject 不污染其它域；成功清 stale。
- **漏事件/恢复**：visibility resume >30s → full；同 workspace reload → full；事件 burst 与 action refresh 并发 → 1 在飞 + 1 pending，最多 2 个 snapshot，结果顺序正确。
- **UI 一致性**：refresh batch 后 TasksView/WorkflowRail/NeedsMe 同状态；rail active 不变；panel 不 remount。
- **回归**：t168/t172/t175 chat turns/terminal；t216/t219 rail；t222 Workflow；t241 Task Workspace；`typecheck/build/test`。
- **性能**：150 消息 + 6 面板 fixture，事件刷新 React commit ≤16ms；空闲 10s 0 数据读取/0 commit（除可见 UI 时钟）。

---

## 5. 验收指标（全局）

### 5.1 硬性指标

| 类别 | 指标 | 通过条件 |
|---|---|---|
| R1 流式 | App/DockShell/Panel render | 20 token 事件中全部 0；只 ChatLiveTail 更新 |
| R1 状态 | tool/terminal/reasoning | 事件序列单测无丢失；t168/t172/t175 全绿 |
| R1 历史 | Markdown parse | 历史消息在 token 期间 parse 0 次；live 1 次/帧 |
| R2 面板 | token 时 panel render | Tasks/Team/Mailbox/Board/Context 0；mount 数不变 |
| R2 一致性 | Workflow/NeedsMe/rail | 同一 snapshot batch；状态集合一致；active 不变 |
| R3 刷新 | burst IPC | 普通 burst 1 snapshot；不必要 side read 0；重叠请求 ≤2 |
| R3 空闲 | 隐藏轮询 | idle 10s 数据调用 0；可见异常队列/看门狗按明确安全网 |
| R3 恢复 | 失败/漏事件 | last-good 保留；gap 1 full；失败 backoff；无假空状态 |
| 全量 | 构建/测试 | typecheck/build/test 全绿；长历史/多面板/断线回归 |

### 5.2 基线对比表（实现后填）

| 指标 | 当前基线 | R1 后 | R2 后 | R3 后 |
|---|---|---|---|---|
| 20 token：App render | 20（每 delta 一次 App render） | 0 | 0 | 0 |
| 20 token：历史 Markdown parse | O(历史消息) × 20 | 0 | 0 | 0 |
| 1 次 refresh IPC | 5–7 | 5–7 | 5–7（panel 渲染隔离） | 1 snapshot + 必要 side reads |
| idle 10s commits / 读取 | 3 commits；mergeQueue 2 + watchdog 0–1 | 同 | 同 | 0 数据读取/0 commit（可见安全网除外） |
| 6 面板 + 150 消息 refresh commit | 待 fixture（不得跳过） | 待 fixture | 待 fixture；目标 ≤16ms React | 待 fixture |
| long task | 小样本 0；长历史未测 | 待 fixture | 待 fixture | 待 fixture |

> 表格中的「当前基线」只填已实测的 CDP 数据；未实测的写「待 fixture」，不在设计中伪造数字。实现 PR 的 verification 必须补测并填列。

---

## 6. 明确不做（本设计边界）

- 不做 Monaco、第三方虚拟列表库、React Compiler、微前端、全量 Dock/App 重写、替换为传统多页路由。
- 不新增全局状态库（Redux/Zustand/Jotai 等）；R2 用现有 React context/store primitives。
- 不改消息、ChatEvent、terminal、IPC、DB schema、permission/kernel 语义；不改 `always`/`onlyWhenVisible` 生命周期和 Dock 存档 schema。
- 不把 R1–R3 扩成 R4：懒加载/vendor 拆分/构建体积、trace 分页/虚拟化、星图 >150、Diff 虚拟化，均留 P1-7。
- 「150 条聊天可加载更早」仍属 P1-2（`getChatTurns`/listChat cursor）；R1–R3 只保证不回归，不在本设计实现加载更多。
- 不用乐观 UI 伪造 terminal/task 状态；失败和漏事件保留 last-good 并显式 stale。

---

## 7. 最小 PR 拆分 / 文件面 / 风险 / 回滚

### PR R1（流式隔离）

- **目标**：token 不再触发 App/其他 panel；历史 Markdown 不重解析；trajectory 独立。
- **文件面**：
  - 新增 `src/chat/chatLiveStore.ts`（reducer/store，无 React）
  - 新增 `src/chat/chatLiveStore.test.ts`、`src/chat/ChatLiveTail.test.tsx`
  - 新增 `src/chat/ChatLiveBridge.tsx`（订阅 `onChatEvent`，ref callback `onSettled`）
  - 新增/拆分 `src/chat/ChatLiveTail.tsx`、`src/chat/ChatMessageList.tsx`、`src/chat/ChatComposer.tsx`（若 ChatView 继续在 App，可先抽 live tail/message list）
  - `src/App.tsx`：删除 chat live state/onChatEvent；挂 Bridge；ChatView 改为 live tail/message list；保留 `busy/input/messages/turns` 权限
  - `src/ChatContent.tsx`、`src/Markdown.tsx`：memo/parse memo
  - 测试 fixture（150 messages） + `src/chat/*test*`
- **风险**：事件顺序 / terminal 丢失 / panel 重开 reset；**回滚**：R1 单独 revert；不涉及 DB/IPC。
- **验证**：token render count、tool/terminal/reasoning 状态单测、t168/t172/t175 回归、真实 Electron 长短对话。

### PR R2（面板隔离）

- **目标**：稳定 render boundary/context；panel 不随 token/无关域重渲染；rail/Workflow/NeedsMe 一致。
- **文件面**：
  - 新增 `src/shell/PanelContexts.tsx`（split contexts/selectors）
  - 新增 `src/shell/PanelHost.tsx`（stable panel wrappers/actions facade；从 App 的 renderPanel switch 迁出）
  - `src/shell/dock/DockShell.tsx`：移除 `renderPanel`/PanelContentContext；`memo`；props 稳定
  - `src/App.tsx`：providers；actions facade；删除 inline renderPanel；memo 边界
  - 面板组件（TasksView/TeamDashboard/MailboxView/MemoryWorkbench/TaskStarMap/ChatView 等）：memo + context hooks；本地状态/生命周期不变
  - 测试 `src/shell/panelIsolation.test.tsx`（token/domain render counts/一致性）
- **风险**：**高**（App 大拆/回调 stale/面板行为等价）；建议同一 PR 内分「stable renderer」「contexts+callbacks」两次提交，必要时拆 R2a/R2b 两个 PR。**回滚**：按提交 revert；R1 可独立保留。
- **验证**：6 panel fixture；所有面板动作路径；Dock/rail/Workflow/NeedsMe 一致性；真实 Electron 截图。

### PR R3（刷新降噪）

- **目标**：事件→domain、coalesce、seq/gap、last-good、去隐藏轮询。
- **文件面**：
  - 新增 `src/shell/refreshCoordinator.ts` + `refreshCoordinator.test.ts`（纯映射/批处理）
  - 新增 `src/shell/refreshScheduler.test.ts`（伪 timers/IPC 计数）
  - `src/App.tsx`：event listener→coordinator；`refresh` 改为 domain flush；删除 watchdog 15s；接入 stale/retry
  - `src/shell/useMergeQueue.ts`（+test）：隐藏 5s 移除；active 2s；事件 invalidate
  - 可能 `src/shell/useWatchdogRefresh.ts`（若抽 hook）
  - 不改 service/store 事件 emit；如需要主进程补 merge event，需另评审（不属最小 R3）
- **风险**：中（漏事件→数据陈旧；轮询移除导致队列延迟）；**回滚**：coordinator 单独 revert，恢复原 refresh/轮询；不涉及数据迁移。
- **验证**：burst 计数/失败/seq gap/resume；长任务事件；空闲；真实 Electron 队列/看门狗。

### 依赖顺序

```text
R1 (chat live store) ──→ R2 (stable render/contexts) ──→ R3 (refresh domains)
                                   └───────────────→ P1-2 long history/cursor
R3 可与 R2 并行，但 slice merge 依赖 R2 的 contexts；建议按 R1→R2→R3 合入。
```

- 每个 PR 独立可回滚；R2 最大风险，需独立 review/integration，不与 R1/R3 混在一个 PR。
- R3 先做只读计数测试，再做真实 Electron；不得用「测试通过」替代真实长任务/断线验证。

---

## 8. 附录：复现基线与测试协议

### 8.1 只读 API 基线

```bash
pnpm build
npx electron . --remote-debugging-port=9237
# 用 CDP Runtime.evaluate（只读）：
#   await window.deer.getSnapshot(workspaceId)
#   await window.deer.getWatchdogSnapshot(workspaceId)
#   await window.deer.getWatchdogCosts(workspaceId)
#   await window.deer.getChatTurns(workspaceId, routerId, {limit:20})
```

记录 `performance.now()` 前后差、JSON 长度、DOM 节点/panel 数；本设计记录的值见 §1.6。不要在基线阶段修改工作区数据。

### 8.2 React commit hook

```js
// CDP Page.addScriptToEvaluateOnNewDocument（reload 前）
window.__REACT_COMMITS = [];
Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
  configurable: true,
  value: {
    supportsFiber: true,
    inject() { return 1; },
    onCommitFiberRoot(_id, root) {
      let fibers = 0; const stack = [root.current];
      while (stack.length) { const f = stack.pop(); if (!f) continue; fibers++; if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling); }
      window.__REACT_COMMITS.push({ t: performance.now(), fibers });
    },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {}, checkDCE() {},
  },
});
```

- 生产包 minified，fiber type 名不可靠；该 hook 只用于 **commit 数/fiber 总量**，不能冒充组件级 render count。
- R1/R2 使用 React `Profiler`/`onRender` 或 test harness 计数；实现验证必须给出 App/Tasks/Team/ChatTail 的 render count。

### 8.3 Fixture（R1 PR 必须新增，不提交生产数据）

- chat：150 messages（20 条代码块）、7–20 turns、1 个长 tool trace（30 calls）；
- tasks：200（20 failed、10 blocked、5 running）、5 runs、trace 2,000；
- mailbox 60、board 60、6 个 Dock panel（chat/tasks/team/board/mailbox/runs）；
- 断言：R1/R2 token render counts；R3 burst IPC；long task/输入延迟；无消息/terminal 重复。
- 真实 Electron 用 workspace DB 副本或 test-only fixture 路径；不在生产 workspace 复制脏数据。

### 8.4 断线/漏事件演练

1. 运行长任务产生事件，断开 renderer（reload 或 kill webContents）后恢复；
2. 断言：last-good 保留、stale 提示、一次 full refresh 对齐、无重复消息/终态；
3. 模拟事件 seq gap / 丢失：注入 fake EventRecord 测试不推进 lastSeq、下一事件 full；
4. 刷新失败注入：getSnapshot reject，assert 旧 snapshot 不消失、retry backoff、成功后 stale 清除；
5. `typecheck/build/test` 全绿，长历史/多面板/chat 终态回归。

---

## 9. 待确认 / 开放问题（不阻塞本设计）

1. **token 合帧**：默认按 16ms 合并 delta（视觉上仍逐字增长，但每帧最多一次 commit）；若产品要求严格逐 token 动画，保留不合帧但必须只动 live tail。
2. **mergeQueue 隐藏期安全网**：推荐隐藏时 0 轮询、仅事件 invalidate；若外部队列变化没有事件，保留「面板可见时 30s」安全网还是补主进程 enqueue 事件，需实现时按实测决定。
3. **watchdog 60s safety**：顶栏/看门狗可见时 60s 低频替代 15s 常驻；预算显示容忍 60s 陈旧是否可接受需产品确认。
4. **R2 拆分粒度**：R2 高风险，建议同一 PR 内两次提交（stable renderer → contexts/actions）或拆 R2a/R2b；评审可要求拆。
5. **150 条加载更早**：不属于 R1–R3，仍由 P1-2 的 cursor/分页实现；R1–R3 验收只要求不回归。
6. **事件 source**：mergeQueue/Git 外部变化是否总能 emit 事件需在主进程/Git 侧核实；若不能，保留明确的可见安全网，不假装事件完备。

---

## 10. 参考

- `docs/team/ux-audit-final.md` P0-8（§5.1/§5.5/§6.2）
- `docs/team/ux-audit-shortlist.md` C9 / P0-8 / §9.2
- `docs/team/ux-audit-feasibility.md` §1–§3（P0 基线/R1–R12）
- `docs/team/ux-audit-layout.md` / `ux-audit-qa.md`（多面板/窄窗背景）
- t168/t172/t175 chat turn/terminal 契约；t216/t219 rail；t222 WorkflowRail；t241 Task Workspace
