# G11 数百 turn 性能证据 + 滚动/rail 细节（t466）

- **任务**：t466 — 依据 t444 F1–F5 补齐 G11 性能/交互证据；修复分支 PR #64（`feature/t443-chat-scroll-turns`）。
- **基线**：`624aaf9`；本修复只改 App 渲染细节/测试/文档，不改 service/IPC/schema。
- **状态**：修复完成，待独立复审/合并。

## 1. F1 数百 turn 性能（通过）

### 1.1 300 turn / 600 消息夹具（Vitest + test renderer）

`chatViewIsolation.test.tsx` 新增 300 user turns（600 messages）夹具，`historyLimit=0` 全量渲染，测试内量化：

| 指标 | 实测 | 阈值 | 结论 |
|---|---:|---:|---|
| 首屏 render（含 300 刻度 + 600 消息 DOM） | **167 ms**（本轮；首轮 324 ms） | < 2500 ms | PASS |
| 60 次 scroll 事件 + rAF 合并 | **3 ms** | < 600 ms | PASS |
| DOM 节点数（test-renderer JSON type 节点） | **5148** | < 7000 | PASS |
| 初始滚动位置 | `scrollTop=scrollHeight` | 到底 | PASS |

> 口径：test renderer 非 Chromium layout；用相对阈值防止机器抖动，同时真实 Electron 数据见 1.2。

### 1.2 真实 Electron 大历史（600 消息种子 + 真实 SQLite）

临时 userData 副本的 `deer.db` 种子 600 条 Router 消息（300 user/300 assistant；另有原 17 条），真实 Electron/CDP：

| 指标 | 实测 |
|---|---|
| 服务端可加载上限 | `CHAT_TURNS_MESSAGE_LIMIT=200`，实际到 **100 turns（200 消息）**后 `hasMore=false` |
| 首屏 | 40 rows / 20 ticks；DOM 总节点 **852** |
| 首屏贴底 | `scrollTop 2374 + clientHeight 396 = scrollHeight 2770` |
| 100 次 scroll 事件（rAF 合并后） | **6.6 ms**；rail 仍 20 ticks；active 更新 |
| 全部历史 | 100 rows / **50 ticks**；DOM 总节点 **1330**；`scrollHeight 6933` |
| 大历史 rail 位置 | 顶部 `2%/4%/…`，底部 `…/91%/93%/95%/96%/98%` |

**说明**：真实 IPC 有 200 消息上限，故真实 Electron 大历史为 100 turns；300 turns 用同组件夹具覆盖。两者均未发现卡顿。

### 1.3 就地优化（不改行为）

- 刻度位置从 `getBoundingClientRect()` 改为 `anchor.offsetTop / scrollHeight`，避免每帧 300 次 layout 读取；
- `scheduleRailRefresh` 保持单 rAF 合并；
- rail 仅渲染当前已显示 user turn（`visibleMessages`），历史加载后增量；
- 无新依赖。

## 2. F2 上滚 + 流式 token（通过）

- **单测** `src/shell/chat/chatLiveTailFollow.test.tsx`：
  - `stickToBottomRef=false` 时 dispatch `delta` → `scrollTop` 保持 0；
  - 置 true 后 dispatch → `scrollTop = scrollHeight (1200)`。
- **真实 Electron/CDP**（注入 `ChatLiveStore.dispatch({type:"delta"})`，与真实流式 token 共用同 store/渲染路径）：
  - 滚到顶 `scrollTop=0`（height 7699/client396）；
  - 连续 8 个 delta 后 height 7838，`scrollTop` 仍 **0**，delta 7442；
  - 滚到底再 8 个 delta，height 7862，`scrollTop=7466`，底部差 **0**。
- 截图：`docs/team/t466-stream-up.png`（阅读态不被拉底，可见 rail/已到最早）。

## 3. F3 加载更早锚点（通过）

真实 Electron 大历史（40→80 rows）CDP：

| 阶段 | scrollTop | scrollHeight | rows | 顶部锚点 |
|---|---:|---:|---:|---|
| 加载前（贴顶） | 0 | 2827 | 40 | — |
| 点击加载更早后 | **2737** | **5508** | 80 | `perf turn 280: 请检查第 280 个工作区状态与预算。` |

- 高度增量 2681，scrollTop 增量 2737（含锚点补偿/边界），顶部锚点文本仍为加载前同一 turn（perf turn 280）。
- 已到最早：CDP `earliest=true`；按钮仅 nearTop 显示。

## 4. F4 Settings → Chat 即时生效（通过）

- `SettingsView.test.tsx`：界面设置选择 80，保存 payload `layout.chatHistoryLimit=80`。
- `chatViewIsolation.test.tsx`：同一 ChatView 从 `historyLimit=40` 更新到 80，标题即刻显示“已显示最近 80 条”，无需重挂载。
- normalize 默认 40/clamp 0、20–80 已由 `chatScrollTurns.test.ts` 覆盖。

## 5. F5 rail hover/键盘/current（通过）

真实 Electron/CDP（100 turns 大历史）：

- hover tick → 自定义 hint：`perf turn 275: … / 06:47:07 · 已完成`；
- focus tick → hint `perf turn 260…`，active 同步；
- ArrowDown → focus/active 移到下一 turn（`perf-msg-0520 → perf-msg-0522`）；
- 当前视口 turn 高亮 `is-active`；点击跳转既有。
- 首尾刻度实测 `0% / 100%`（默认 9 turns：0/11/27/30/49/64/81/84/100）。
- 截图：
  - `docs/team/t466-large-1440.png`（100 rows/50 ticks 大历史）
  - `docs/team/t466-large-960.png`
  - `docs/team/t473-rail-hover-1440.png`（hover hint，状态中文）
  - `docs/team/t473-rail-keyboard-1440.png`（键盘 focus/hint/current）

## 5.1 t473 repair-round-2 追加修复

- **加载更早 server-only**：新增 `serverLoadStartRef`；当 `visibleMessageCount === messages.length` 且 `historyHasMore` 时，点击加载更早会真正请求 server 页；`messages.length` 增长后 effect 自动把 `visibleMessageCount` 提升到新 `messages.length`，重新记录 preserve 并保持锚点；成功后 `preserveScrollRef=null`，后续发送 `stickToBottom` 仍生效。新增 `ServerPageProbe` 测试断言 rows/ticks 增加、`data-scroll-preserve=0`。
- **rail 位置**：使用 `contentRef` 独立 reference，`anchor.getBoundingClientRect().top - content.getBoundingClientRect().top` 归一化到首尾 `0%/100%`；fallback 用 `anchor/node + scrollTop`；`normalizeTurnRailRatio` 单测 0/0.5/1。jump 使用 `scrollTopForTurn`，首轮负值钳制 0（单测）。
- **状态中文**：`chatTurnStatusLabel` 映射 待处理/处理中/已完成/失败/已取消；aria/title/hint 全部使用中文（CDP 实测“已完成”）。
- **真实模型 token**：尝试真实 `window.deer.sendChat` 时环境模型配置返回 400（Router `reasoning_content` / 成员 `max_tokens` 配置），改用 `ChatLiveStore.dispatch` 同渲染路径验证；真实模型 token 作为后续环境修复项记录，不伪造成功。

## 6. 三命令

```text
pnpm typecheck   # 0
pnpm build       # 0；458 modules
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 147 files / 1006 tests passed
```

> F6 既有 5s flake 仍与本次无关；本次按验收要求串行/--no-file-parallelism。

## 7. 遗留

- 真实 IPC 的 200 消息上限导致真实 Electron 只能展示 100 turns；300 turns 用同组件夹具验证，若后续需要真实 300 turn 需单独调整 `src/kernel` 上限（本任务 out of scope）。
- 自定义 hint 为轻量 div（非 native title），hover/focus 截图可读；无 480 rail（按设计隐藏）。
