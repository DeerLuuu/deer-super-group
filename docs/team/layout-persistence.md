# 窗口与界面布局持久化（G14）

- **任务**：t458 — 窗口/工作区/所有可调布局持久化
- **范围**：窗口 bounds/maximized、上次工作区、Dock/侧栏/任务列表/Git 分隔；开发期无旧格式迁移。
- **结论**：窗口状态由主进程写入 userData，启动时经显示器/尺寸校验后恢复；上次工作区由 renderer localStorage 恢复；既有 split/Dock 键保持稳定；无新依赖/权限/DB schema。

---

## 1. 持久化键清单

| 键 | 存储 | 值/语义 | clamp / 回退 |
|---|---|---|---|
| `window-state.json` | Electron `app.getPath("userData")` | `{x,y,width,height,maximized}` | 尺寸 <960×700、非有限数、非法 JSON、标题栏不可达、显示器已拔 → 默认 1440×920 居中；maximized 只恢复 normal bounds |
| `deer.lastWorkspaceId` | renderer localStorage | 上次工作区 id | saved 不存在/空/超长 → 第一个 workspace，并删除 stale 键 |
| `deer.sidebarWidth` | localStorage | sidebar 首选宽度 | `clampSidebarWidth` 既有窄窗 clamp；非法值回默认 |
| `deer.sidebarCollapsed` | localStorage | `"1"`/`"0"` | 缺省 false |
| `deer.taskListWidth` | localStorage | 任务列表首选宽度 | `clampTaskListWidth` 既有 clamp；默认 380 |
| `deer.taskListCollapsed` | localStorage | `"1"`/`"0"` | 缺省 false |
| `deer.dock.v1.<workspaceId>` | localStorage | Dock `{schema:"deer.dock.state",version:1,variants}`，按 workspace×variant 存 dockview `toJSON` + activePanel | schema/version 不匹配/超 64KB/JSON 坏 → 删除并回默认布局 |
| `deer.git.workspaceHeight.<workspaceId>` | localStorage | Git history/workspace 分隔高度（G9） | 160..container−216；非法回 300；短高/≤719 隐藏 |

- 键常量集中在 `src/shared/layoutPersistence.ts`（Git split 键在该模块文档常量中，实际实现保持在 `src/git/ui/gitWorkspaceSplit.ts`，本任务不修改 src/git）。
- 不引入旧格式迁移；读不到/不合法即回退默认，不写回旧形态。

---

## 2. 恢复顺序

1. **主进程窗口**：`app.whenReady` 后读取 `window-state.json` → `screen.getPrimaryDisplay()` + 其他 displays 的 workArea → 校验/居中 → `new BrowserWindow({x,y,width,height})`；若 `maximized` 再 `maximize()`。
2. **窗口保存**：`resize/move/maximize/unmaximize/minimize` 去抖 400ms；`close` 立即同步写；`closed` 清定时器。最大化时保存 `getNormalBounds()`，避免下次 unmaximize 变成全屏尺寸。
3. **Renderer 启动**：`listWorkspaces()` → 读取/选择 last workspace（不存在则第一个并清 stale）→ `getSnapshot(id)` → 写入 last id。
4. **App/Dock**：DockShell 按当前 workspace 读 `deer.dock.v1.<id>` 对应 variant；侧栏/任务列表在组件初始化读 localStorage 并 clamp；Git 工作区分隔在 GitGraphPanel mount 读 `deer.git.workspaceHeight.<id>` 并 clamp。
5. **切换/打开工作区**：成功 `getSnapshot` 后写 `deer.lastWorkspaceId`；工作区切换重置 renderer 状态，但各布局键按新 workspace 独立恢复。

---

## 3. 安全 / 边界

- 窗口恢复只接受可见 display workArea 内的位置；标题栏至少 40px 垂直重叠、水平至少 160px 或窗口宽度；屏幕拔除/坐标越界回默认居中。
- 尺寸低于 960×700（窗口 minWidth/minHeight）回默认 1440×920；多显示器跨屏保留，只要标题栏可达。
- 窗口状态 JSON 读取失败/缺字段/NaN/字符串 → 默认；写入失败静默（不阻止应用退出）。
- last workspace 只接受 ≤200 字符；无效/不存在回退第一个并删除 stale key。
- 所有布局使用既有 clamp；不改变权限/数据/DB schema；不做历史迁移；无新依赖。

---

## 4. 重置方式

- 窗口：关闭应用，删除 `%APPDATA%/deer-super-group/window-state.json`（macOS/Linux 对应 userData），下次启动默认 1440×920 居中。
- 上次工作区：删除 `deer.lastWorkspaceId` 或切换一次工作区。
- 侧栏/任务列表：双击对应 separator / 折叠按钮重置，或删除对应 localStorage key。
- Git 分隔：双击 separator 恢复 300，或删除 `deer.git.workspaceHeight.<workspaceId>`。
- Dock：设置/面板「重置布局」走既有逻辑，或删除 `deer.dock.v1.<workspaceId>`。

---

## 5. 测试

- `electron/windowState.test.ts`：valid secondary、maximized normal bounds、missing/malformed/small/offscreen、拔屏、跨屏、no-display、读写/坏文件。
- `src/shared/layoutPersistence.test.ts`：稳定键、last workspace 恢复/stale/空列表/trim/清除/不可用 storage。
- `src/shell/lastWorkspaceApp.test.tsx`：真实 App boot 选 saved workspace；stale 回退第一个并清键。
- 既有：sidebar/task separator clamp、Dock store schema/variant、Git split 读取/clamp/隐藏。
- 三档截图/重启验证见 `docs/team/layout-persistence-evidence.md`（实现阶段产物）。

## 6. 命令

```text
pnpm typecheck
pnpm build
pnpm test -- --testTimeout=20000 --maxWorkers=2
```
