# 对话初始底部 + 加载更早 + turn 刻度滚动条（t443 / G11）

- **任务**：t443 — 按 t442 设计实现对话滚动/历史加载/刻度条/最近 N 条设置。
- **分支**：`feature/t443-chat-scroll-turns`
- **范围**：ChatView/App、LayoutSettings/SettingsView、styles/tests/docs；不改 service/IPC/schema/权限。
- **状态**：实现完成，待独立评审/合并。

## 1. 初始底部 / 跟随规则

- ChatView 维护 `stickToBottomRef`：
  - 首次挂载、切换 agent、`historyLimit` 改变：重置为 `true` 并滚到 `scrollHeight`；
  - 发送（Ctrl+Enter / 发送按钮）先置 `true` 再发送，新消息跟随；
  - 用户上滚超过底部 96px：置 `false`，新消息/流式 token 不强制跳；
  - 回到近底部后自动恢复跟随。
- `ChatLiveTail` 的流式滚动改为只在 `stickToBottomRef.current` 时执行（原实现无条件跳底）；`ResizeObserver` 只刷新刻度，不强制滚动。
- 切换 agent 同时重置 `visibleMessageCount`、`nearTop`、刻度高亮。

## 2. 加载更早 / 视口锚点

- 顶部「加载更早」只在 `nearTop`（滚动到顶部 80px 内）或测试无 DOM 节点时显示；加载中显示 `加载更早…`，失败显示可重试错误。
- **server-only hasMore**：当 `visibleMessageCount === messages.length` 但 server `historyHasMore` 时，`onLoadEarlierHistory` 返回显式 `loadedCount`；ChatView 在 pending token 保护下只把 `visibleMessageCount` 增加 server 返回条数（`nextVisibleAfterServerLoad`），不读取裸 `messages.length`、不一次显示全部。`finally` 无条件清 `serverLoadStartRef`；server 空页/true/0 清 preserve；加载期间发送会因 `sendAndFollow` 置 following 而不使用旧视口锚点。
- 加载前记录 `{height, scrollTop}`，使用既有 `applyHistoryScrollPreservation` 补偿 `scrollTop`，不跳动。
- 无更早历史显示「已到最早（N 条消息）」。
- 分页大小改为设置项 `chatHistoryLimit`（20/40/80；0=全部），`nextVisibleMessageCount` 保留已显示条数。

## 3. 设置「对话显示最近 N 条」

- `LayoutSettings.chatHistoryLimit`（可选）：默认 40；选项 20/40/80/全部；`normalizeChatHistoryLimit` clamp 0/20–80，非法回 40。
- Settings → 界面设置新增 `<select aria-label="对话显示最近消息条数">`；保存即时写入 `layout.chatHistoryLimit`，并更新 baseline；App 将 normalize 后的值传入 ChatView，立即生效并滚到最新。
- 不做历史兼容迁移；旧设置 normalize 得到默认 40。

## 4. 漂浮 turn 刻度滚动条

- `.chat-scroll-rail` 放在 `.chat-tab-panel` 右侧，每页一个 user turn 一个 `.chat-scroll-tick`：
  - `top` 由 anchor `getBoundingClientRect` 相对滚动容器计算，`turnRailRatio` clamp 0–1；无布局时均分兜底。
  - 悬浮/`title`/`aria-label` 显示用户消息首行、时间、状态；状态映射为「待处理/处理中/已完成/失败/已取消」；点击 `jumpToTurn` 设置 `scrollTop`。
  - 当前视口 turn 高亮 `is-active`；`ArrowUp/ArrowDown` 在 rail 内移动焦点，`Enter` 跳转；`tabIndex` roving，`aria-label="对话轮次导航"`。
  - 位置使用 `contentRef` 独立 reference 的 rect 差归一化到首尾 0%/100%；无 content 时回退 `anchor/node + scrollTop`；切换 agent 重置 active 为最新 turn。
- 响应式：480px 及以下 `display:none`，不遮挡内容；1440/960 显示。
- 性能：scroll 处理通过 `requestAnimationFrame` 合并刷新；`ResizeObserver` 监听内容尺寸；无新增依赖。

## 5. 测试与验证

新增/更新：
- `src/shared/chatScrollTurns.test.ts`：默认 40 / clamp / 全部分支，初始与分页条数，刻度位置 clamp/均分、首尾 0/100 归一化、jump 首轮 0、状态中文映射。
- `src/shared/chatHistory.test.ts` 保持既有锚点/分页覆盖。
- `src/shell/chat/chatViewIsolation.test.tsx`：初始滚动到 `scrollHeight`、刻度导航；新增 server-only hasMore 追加 messages/rail 增加、`data-scroll-preserve=0`；既有加载更早/失败/不前进测试保留。
- `src/SettingsView.test.tsx`：界面设置保存 `chatHistoryLimit=80`。
- `src/App.tsx`：`dispatch` 未改；`ChatLiveTail` 仅在 stick 时跟随。

```text
pnpm typecheck   # 0
pnpm build       # 0；458 modules
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 147 files / 1006 tests passed
```

## 6. 三档真实截图

- `docs/team/t443-chat-1440.png`：Chat 初始贴底，右侧刻度 rail 可见，无横向溢出。
- `docs/team/t443-chat-960.png`：960 单栏 Chat + rail。
- `docs/team/t443-chat-480.png`：480 Chat，rail 隐藏不挡内容，无横向溢出。
- `docs/team/t443-top-1440.png`：滚到顶部，显示已到最早（当前工作区无更多历史）。

真实 Electron + 临时 userData；CDP 断言：初始 `scrollTop=scrollHeight`、1440/960/480 `scrollWidth===innerWidth`、480 rail `display:none`、刻度 top 归一化首尾 0%/100%、点击刻度 scrollTop 变化、`已到最早` 文本存在。性能证据见 `docs/team/chat-scroll-turns-performance.md`。

## 7. 风险/回滚

- 流式 token 跟随现在受用户上滚状态控制；用户回到底部后恢复。
- 刻度 rail 按当前已显示 user turn 生成；加载更早后增加刻度。
- 回滚：移除 `chatHistoryLimit`/ChatView 刻度与 stick 逻辑，恢复无条件底部跟随。

## 8. t475 repair round 3：server 分页状态机

- `loadEarlierHistory` 使用 `serverLoadTokenRef` pending token；`serverLoadStartRef` 只记录 `{token, previousLength}`。`finally` 无条件清 `serverLoadStartRef` 并结束 loading。
- **不再用 `messages.length` 增长判断 server 页**：删除旧 `messages.length` effect。server 分支仅信任 `onLoadEarlierHistory` 的显式 `loadedCount`；local 分页仍走 `nextVisibleMessageCount`。
- `onLoadEarlierHistory` 返回 `boolean | number`：数字为 server 返回的新消息条数（App 按 turn 去重后统计 user+assistants）；`false` 失败；`true`/`0`/仅 turn 元数据视为空页，不增加 visible、不残留 preserve 锚点。
- `visibleMessageCount` 仅按 server 返回条数增加（`nextVisibleAfterServerLoad(current, previousLength, loadedCount)`），不设置成 messages.length；本地隐藏历史保留。
- 加载期间发送：`sendAndFollow` 置 following，server 完成时不恢复旧锚点，视图保持底部；加载完成后再次发送仍贴底。
- 切换 agent/historyLimit：递增 token、清 `serverLoadStartRef`、清错误，旧 server 页的后到响应不会回写新会话。
- 失败/空页/reject 均清 `preserveScrollRef`，`data-scroll-preserve=0`。

### t475 测试

- `chatViewIsolation.test`：空 true 页后发送仍贴底；加载期间发送两条 + server 返回 20，visible 只从 40→60（不是 42/62 全量），user/assistant 行数 31/29，preserve 0；后续发送再次贴底；reject 清 preserve。
- `chatScrollTurns.test`：`nextVisibleAfterServerLoad` 前后长度/0 条分支。
- `chatSentTokens.test`：本地 OpenAI-compatible SSE 的真实 `AppService.sendChat` token 路径（非 store mock），3 段 delta 拼接 `你好，t475`；仅因外部模型环境不可用改用可控 SSE，不伪造外部模型。
- 既有 contentRef 0/100、jump 首轮 0、中文状态、t443 三档/性能测试保留。

### 验证

- typecheck 0
- build 0（458 modules）
- test 串行 148 files / 1011 tests（`--maxWorkers=2 --testTimeout=20000`）

