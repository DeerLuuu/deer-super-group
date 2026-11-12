# 辅助面板路由 / 可发现性 / 溢出（P1-3 / t319）

## 范围

- Context / Polls / Watchdog 增加 `#/context`、`#/polls`、`#/watchdog` 深链；Runs 继续复用 `#/tasks?r=`。
- 面板 launcher 分组 + 搜索；关闭后可从 launcher 恢复。
- 辅助面板内容 100% 滚动，960/480 单列可用；不新增数据源，不改权限/gate/kernel，保留现有深链/rail/Workflow。

## 路由

| hash | Dock 面板 | 说明 |
|---|---|---|
| `#/context` | `context` | 上下文 |
| `#/polls` | `polls` | 团队投票 |
| `#/watchdog` | `watchdog` | 看门狗/预算 |
| `#/tasks?r=` | `runs` | 既有 Run 深链保持 |
| `#/git` | `gitGraph` | 既有 Git 图深链保持 |
| `#/nope` | `tasks` | 无效路径 normalize 到 `#/tasks` |

- `openPanel` 仍是唯一入口：设置 tab → `buildHash` 写 hash；hashchange 走同一 `openPanel`。
- 关闭当前辅助面板后 Dock 激活相邻面板，`handleDockActivePanel` 将 tab/hash 同步到新的 active panel（运行时验证 context 关闭后 hash `#/watchdog`）。
- 前进/后退由 hashchange 恢复；初始 bootPanel 支持 context/polls/watchdog。
- `normalizeHash` 只处理显式 `#/…` 无效路径；空 hash 保持默认启动（chat）。

## Launcher

- `PANEL_LAUNCHER_GROUPS`：
  - 主面板：chat/tasks/team/mailbox/board
  - 辅助面板：context/polls/watchdog/runs
  - 工作流：planDraft/gitGraph/mergeQueue
- launcher 增加搜索框（按 title/key），显示分组标题、打开状态；无结果给 status。
- 原有 Chat/Tasks/Team/Workflow/NeedsMe 的 context/polls/watchdog 入口保留；关闭后可从 launcher 重新打开。
- 命令面板原有 panel actions 保留，不新增第二数据源。

## 溢出

- `.dock-panel-body` 已有 `height:100%; overflow:auto`。
- t319 对 context/polls/watchdog 增加 `overscroll-behavior:contain`；context/poll 根 `height:100%; min-height:0; max-height:100%`；watchdog 根 `min-height:100%`。
- 960 实测：context-body scrollHeight 788/client 478；watchdog body scrollHeight 2088/client 561；poll-list 内部 auto。
- 480 实测：context-body 788/187；watchdog body 2080/473；poll-list 189/137；`document.scrollWidth == 480`，无横向。
- 长 trace/diff 仍走各自既有滚动容器（`.trace` overflow auto、`.task-detail-panel` 等），本 PR 未改权限/执行内容。

## 测试 / 截图

- `deeplink.test.ts`：9 tab 解析、辅助面板 build/parse、无效 normalize、未知 fallback。
- `auxPanelRoutes.test.ts`：context/polls/watchdog route mapping、launcher 分组完整、搜索过滤。
- 运行时（真实 Electron + CDP）：
  - `#/context`/`#/polls`/`#/watchdog` reload 恢复；
  - `#/nope` normalize 到 `#/tasks`；
  - context 打开→polls→history.back 回 context；
  - launcher 搜索「上下文」只剩该项，点击后 hash `#/context`；
  - context 关闭后 hash 同步到下一 active panel。
- 截图：`docs/team/t319-aux-960.png`、`docs/team/t319-aux-480.png`、`docs/team/t319-launcher-960.png`。

## 风险 / 回滚

- 仅 UI 路由/launcher/CSS；无 schema/权限/gate/数据层变化。
- 隐藏辅助 tab 或回退 `RouteTabString`/launcher 分组即可回滚；无迁移。
- 既有 `#/tasks`、`#/git`、`#/settings` 深链契约保持。

- 1440 截图：`docs/team/t319-aux-1440.png`（context 552px 高、无横向）。
