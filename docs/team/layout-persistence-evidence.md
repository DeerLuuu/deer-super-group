# 布局持久化证据（t458）

## 1. 真实 Electron 窗口状态

使用隔离 userData（临时目录，复制现有 `deer.db/git.db`）启动 `dist-electron/main.cjs`：

1. 首次启动设置窗口 `x=120, y=80, width=1200, height=800`，等待去抖后关闭；`window-state.json`：
```json
{"x":120,"y":80,"width":1200,"height":800,"maximized":false}
```
2. 重新启动同一 userData：
```text
RESTORED {"x":120,"y":80,"width":1200,"height":800} maximized=false
```
3. 最大化后关闭：
```json
{"x":120,"y":80,"width":1200,"height":800,"maximized":true}
```
4. 再次启动：
```text
RESTORED {"x":-8,"y":24,"width":3456,"height":1424} maximized=true
```
（最大化时 `getBounds()` 为屏幕工作区；normal bounds 仍为 1200×800，供 unmaximize 使用。）

截图：

- `t458-restart-restored.png`：重启后 1200×800 窗口内容（实际截图 1184×761，Electron 帧扣除）。
- `t458-layout-1440.png` / `t458-layout-960.png` / `t458-layout-480.png`：同一恢复实例的 1440/960/480 CDP 视口（480 使用 Emulation，不冒充真实窗口最小宽）。

## 2. 单元/集成测试

- `electron/windowState.test.ts`：secondary restore、maximized normal bounds、missing/malformed/too-small/offscreen/display-unplugged/no-display、跨屏标题栏可达、读写/坏 JSON。
- `src/shared/layoutPersistence.test.ts`：稳定键、last workspace 恢复/stale/空 list/trim/清除/不可用 storage。
- `src/shell/lastWorkspaceApp.test.tsx`：真实 App boot 选 saved workspace；stale 回退首个并清键。
- `src/shell/dock/panelRegistry.test.ts`：Dock layout/activePanel workspace 键 round-trip；corrupt/oversized 回默认并清理。
- 既有 sidebar/task/Git split/Dock 测试保持通过。

## 3. 键审计

| Key | 恢复点 |
|---|---|
| `window-state.json` | main `createWindow` 前 normalize |
| `deer.lastWorkspaceId` | App boot `listWorkspaces` 后 |
| `deer.sidebarWidth` / `deer.sidebarCollapsed` | App sidebar state 初始化 |
| `deer.taskListWidth` / `deer.taskListCollapsed` | TasksView 初始化 |
| `deer.dock.v1.<workspaceId>` | DockShell variant store |
| `deer.git.workspaceHeight.<workspaceId>` | GitGraphPanel mount（G9） |

无旧格式迁移；读到非法/缺字段直接默认，不写回旧格式。

## 4. t479 四类 split + last workspace 重启 e2e

隔离 userData `%TEMP%/t458-e2e-userdata`，使用 `scripts/layout-persistence-e2e-wrapper.cjs`（真实 Electron 启动/关闭；原生目录选择器为可自动化而 stub 到 `%TEMP%/t458-ws-b`，renderer 点击与 service `openWorkspace` 是真实路径）。窗口 outer 实际 `1440×900`（content 1424×861，Electron 帧扣除）；480 明确使用 CDP Emulation，不冒充真实最小窗口。

完整步骤与数值见 `layout-persistence-e2e.json`：

- 侧栏：键盘 ArrowRight×3 → `deer.sidebarWidth=298`；点击折叠 → `deer.sidebarCollapsed=1`；关闭/重启后同值，展开读回 aria 298。
- 任务列表：创建 fixture task → 选中 → ArrowLeft×3 → `deer.taskListWidth=291`；点击收起 → `deer.taskListCollapsed=1`；重启后同值，展开读回 aria 291 后再收起。
- Git：版本图打开 → `deer.git.workspaceHeight.ws_mwf3obyy_f6afa67c4d=332`；重启后重新打开版本图，separator aria=332。
- Dock：拖动 sash → 581/555；关闭版本图 tab → activePanel=`tasks`、views=`[tasks,team]`；重启后同 activePanel/views/sizes。
- last workspace：真实点击「切换工作区」（stub picker 指向 ws-b）→ lastWorkspaceId=`ws_mwf3obyy_f6afa67c4d`；关闭/重启 title=`t458-ws-b · 任务`，boot 到 ws-b。stale 回退由 `lastWorkspaceApp.test.tsx`/`layoutPersistence.test.ts` 覆盖。

截图：`t458-e2e-before-1440.png`（改值后、Git 打开）、`t458-e2e-restored-1440.png`（重启后、侧栏/任务折叠、Dock tasks 激活）、`t458-e2e-git-1440.png`（重启后重新打开 Git，高度 332）；`t458-e2e-git-960.png`、`t458-e2e-git-480.png`（960/480 CDP 视口）。

## 5. 命令

```text
pnpm typecheck
pnpm build
pnpm test -- --testTimeout=20000 --maxWorkers=2
```
