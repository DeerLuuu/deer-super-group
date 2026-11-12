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
- 加载前记录 `{height, scrollHeight}`，使用既有 `applyHistoryScrollPreservation` 补偿 `scrollTop`，不跳动。
- 无更早历史显示「已到最早（N 条消息）」。
- 分页大小改为设置项 `chatHistoryLimit`（20/40/80；0=全部），`nextVisibleMessageCount` 保留已显示条数。

## 3. 设置「对话显示最近 N 条」

- `LayoutSettings.chatHistoryLimit`（可选）：默认 40；选项 20/40/80/全部；`normalizeChatHistoryLimit` clamp 0/20–80，非法回 40。
- Settings → 界面设置新增 `<select aria-label="对话显示最近消息条数">`；保存即时写入 `layout.chatHistoryLimit`，并更新 baseline；App 将 normalize 后的值传入 ChatView，立即生效并滚到最新。
- 不做历史兼容迁移；旧设置 normalize 得到默认 40。

## 4. 漂浮 turn 刻度滚动条

- `.chat-scroll-rail` 放在 `.chat-tab-panel` 右侧，每页一个 user turn 一个 `.chat-scroll-tick`：
  - `top` 由 anchor `getBoundingClientRect` 相对滚动容器计算，`turnRailRatio` clamp 0–1；无布局时均分兜底。
  - 悬浮/`title`/`aria-label` 显示用户消息首行、时间、状态；点击 `jumpToTurn` 设置 `scrollTop`。
  - 当前视口 turn 高亮 `is-active`；`ArrowUp/ArrowDown` 在 rail 内移动焦点，`Enter` 跳转；`tabIndex` roving，`aria-label="对话轮次导航"`。
  - 切换 agent 重置 active 为最新 turn。
- 响应式：480px 及以下 `display:none`，不遮挡内容；1440/960 显示。
- 性能：scroll 处理通过 `requestAnimationFrame` 合并刷新；`ResizeObserver` 监听内容尺寸；无新增依赖。

## 5. 测试与验证

新增/更新：
- `src/shared/chatScrollTurns.test.ts`：默认 40 / clamp / 全部分支，初始与分页条数，刻度位置 clamp/均分。
- `src/shared/chatHistory.test.ts` 保持既有锚点/分页覆盖。
- `src/shell/chat/chatViewIsolation.test.tsx`：新增初始滚动到 `scrollHeight`、刻度导航存在/首条 title；既有加载更早/失败/不前进测试保留。
- `src/SettingsView.test.tsx`：界面设置保存 `chatHistoryLimit=80`。
- `src/App.tsx`：`dispatch` 未改；`ChatLiveTail` 仅在 stick 时跟随。

```text
pnpm typecheck   # 0
pnpm build       # 0；458 modules
pnpm test -- --testTimeout=20000 --maxWorkers=1
                 # 146 files / 1001 tests passed
```

## 6. 三档真实截图

- `docs/team/t443-chat-1440.png`：Chat 初始贴底，右侧刻度 rail 可见，无横向溢出。
- `docs/team/t443-chat-960.png`：960 单栏 Chat + rail。
- `docs/team/t443-chat-480.png`：480 Chat，rail 隐藏不挡内容，无横向溢出。
- `docs/team/t443-top-1440.png`：滚到顶部，显示已到最早（当前工作区无更多历史）。

真实 Electron + 临时 userData；CDP 断言：初始 `scrollTop=scrollHeight`、1440/960/480 `scrollWidth===innerWidth`、480 rail `display:none`、刻度 top 按 turn 实际位置分别约 1/10/23/26/42/56/70/73/86%、点击刻度 scrollTop 变化、`已到最早` 文本存在。

## 7. 风险/回滚

- 流式 token 跟随现在受用户上滚状态控制；用户回到底部后恢复。
- 刻度 rail 按当前已显示 user turn 生成；加载更早后增加刻度。
- 回滚：移除 `chatHistoryLimit`/ChatView 刻度与 stick 逻辑，恢复无条件底部跟随。
