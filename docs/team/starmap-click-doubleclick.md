# t419 · G6 星图单击浮窗、双击进入任务

- **实现**：lin（GLM 席位）
- **分支/PR**：feature/t419-starmap-click-doubleclick
- **用户要求**：星图任务单击只弹详细浮窗、不跳转；双击才进入对应任务（任务工作区）。
- **验证**：typecheck 0 · build 0 · test serial **961/961 全绿**（首轮 1 个 openai 集成 flake，孤立重跑 24/24 过，二轮全绿）· 真实 Electron CDP 走查 **11/11**。

## 1. 行为变化

| 交互 | 旧行为 | 新行为 |
|---|---|---|
| 单击节点 | `onSelect` → App `handleOpenTaskWorkspace` → **立即跳任务页** | 仅选中（高亮 + C12 `?t=` 深链参数）+ 打开非模态概览浮窗；**面板/路由不切换** |
| 双击节点 | `onOpen` → 打开聊天上下文 | **进入任务工作区**（`onOpenTaskPage` → `handleOpenTaskWorkspace(id,"team")`），浮窗关闭 |
| Ctrl/Cmd+Enter | `onOpen`（聊天） | **与双击等价**（任务工作区） |
| 普通 Enter | 原生按钮语义 | 不变（不导航） |
| 浮窗「打开会话」 | 聊天上下文 | **不变**（`onOpen`） |
| 浮窗「在任务页打开」 | 任务页 | **不变**（`onOpenTaskPage`） |
| 浮窗「居中/聚焦/复制 ID」 | — | 不变 |

## 2. 文件与交互映射

- `src/App.tsx`（team 面板布线）：`selectedTaskId={null}` → 真实 `selectedTaskId`；`onSelectTask` 由「跳任务页」改为「仅 `setSelectedTaskId` + `loadTrace`」。副作用：底部任务概览恢复显示选中任务（此前恒空）、成员过滤清选中的既有逻辑恢复生效。
- `src/TaskStarMap.tsx`（节点按钮）：双击与 Ctrl/Cmd+Enter 从 `onOpen`（聊天）改调 `onOpenTaskPage`（任务工作区）；`aria-label` 追加「单击查看概览，双击打开任务」；新增 `title` 悬停提示。单击路径（`onSelect` + `openPopover`）与浮窗动作不变。
- `src/TaskStarMap.click.test.tsx`（新增，6 用例）：单击选中+浮窗且不调 onOpen/onOpenTaskPage；双击 onOpenTaskPage 且浮窗关闭、不进聊天；Ctrl+Enter 等价、普通 Enter 不导航；浮窗两动作各自正确；aria-label/title 提示；TeamDashboard 布线（单击只 onSelectTask）。
- `scripts/seedT419Fixture.test.ts`（新增，env-gated）：播种工作区 + 成员 + A→B→C 依赖链任务。
- `scripts/t419-cdp.mjs`（新增）：真实 Electron + CDP 走查驱动。

## 3. 真实 Electron 走查（11/11，docs/team/t419-walkthrough.json）

- 团队面板星图 3 节点依赖链渲染；节点 aria 提示；
- 单击「铺设基础接口」→ 浮窗打开、hash `#/team → #/team?t=t419-a`（C12 选中参数，面板未切换）；
- 浮窗含「打开会话 / 在任务页打开」；Esc 关闭；
- 双击「补充集成测试」→ `#/tasks?t=t419-b` 进入任务工作区；
- 节点可聚焦，Ctrl+Enter 同样进入任务页；
- 960/480 无横向溢出。

截图：`t419-1440-popover.png`（单击浮窗）、`t419-1440-after-doubleclick.png`（双击后任务页）、`t419-960-starmap.png`、`t419-480-starmap.png`。

## 4. 边界与已知项

- 不改 C14「在星图中定位」、过滤/聚焦/图例/键盘基线；聊天入口（浮窗「打开会话」、任务页「查看上下文」）不变。
- `?t=` 深链参数随单击更新属 C12 既有设计（选中可分享），面板不切换即满足「不跳转」。
- 首轮全量 1 个 `openai.test.ts` 集成用例 flake（需本地 endpoint/时序），孤立重跑通过；watchdog 1 例同型；已在多轮任务报告记录为既有基线。

## 5. 回滚

仅 3 处行为改动集中在 `App.tsx` team 布线与 `TaskStarMap.tsx` 节点双击/键盘分支；revert 该 commit 即恢复旧行为（单击跳任务页、双击进聊天）。
