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

## 4. 命令

```text
pnpm typecheck
pnpm build
pnpm test -- --testTimeout=20000 --maxWorkers=2
```
