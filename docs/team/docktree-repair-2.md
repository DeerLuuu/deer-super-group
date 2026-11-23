# DW1-3 DockTree 修复报告（t554 / t550 F1–F4）

- **任务**：t554 repair-round-2（承接 t550 review needs_revision）
- **分支**：`feature/t548-docktree-renderer`（PR #81）
- **范围**：`src/shell/dock/DockShellV2.tsx`、`DockGroup.tsx`、`DockTree.tsx`、`dockLayout.css`、新增交互测试与截图
- **不涉及**：kernel/memory/review/watchdog/electron、schema/IPC/权限/gate、依赖/package
- **结论**：F1–F4 修复；F5/F6 low 按原评审接受并补 legacy 960/480 对照。

## 修复内容

### F1 · active group / active panel 跟踪

`DockShellV2` 新增同步 ref + state：
- `onActivate(panel)` 立即记录 panel 所属组；
- controller `onActivatedPanel` 记录 reducer 激活结果；
- shell `onFocusCapture` / `onPointerDownCapture` 通过 `closest("[data-group]")` 记录最近聚焦组；
- 布局变化 effect 仅在 group 被关闭/断点切换后修正记录，不会覆盖用户刚聚焦的组；
- `closeActivePanel` / `moveActivePanel` / `resizeActiveGroup` 全部使用该组/该 panel，不再 `groups.find(g => g.active)`。

测试：team 组聚焦后 Ctrl+Alt+W → `onPanelClose("team")`；Ctrl+Alt+Shift+ArrowLeft → team 移入相邻组（组数 2→1）。

### F2 · close 只调用一次

- `DockGroup` 移除 `onPanelClose` prop 与所有调用；
- tab 的 `Delete` 只调 `onClose`，由 `DockShellV2.onClose` 统一调用 `onPanelClose` + dispatch；
- 全局 closeActivePanel 同理只调一次。
- 测试：Delete 关闭一次；`onClose` 调用次数 1。

### F3 · 非激活 PanelHost 保留挂载

- `DockGroup` 对组内每个 panel 都渲染 `tabpanel` + `PanelErrorBoundary` + `PanelHost`；
- 非激活使用原生 `hidden`，CSS `.docktree-panel[hidden]{display:none}`；切 tab 只切 hidden，不卸载实例，保留 chat 草稿/console 输入/滚动状态。
- 测试：切换 active tab 后所有 panel wrapper 仍存在；隐藏 panel 有 hidden 属性。

### F4 · tab a11y 结构

- 删除 tab 内嵌套 `role=button` close；改为 `aria-hidden` 非交互装饰 ×，提示“Delete 关闭…”；
- 关闭统一走 tab `Delete`（DockShellV2 统一 onPanelClose）或 Ctrl+Alt+W；
- 所有 tab 的 `aria-controls` 现在都指向真实存在的 tabpanel（非激活仅 hidden）。
- 测试：无 `docktree-tab-close role=button` / tabindex；aria-controls 的每个 id 均存在；Delete 只触发一次 onClose。

### F5 / F6

- F5（v2 bundle 仍含 legacy/dockview）为 DW1-4 前接受的 low，不扩大本 PR 范围。
- F6 已补 legacy 960/480 对照截图，并确认 v2/legacy 在 960/480 均可加载且无根级横向溢出。

## 验证

```text
pnpm typecheck  # exit 0
pnpm build      # exit 0（475 modules）
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                # 181 files / 1226 tests passed（serial）
```

新增 `src/shell/dock/docktreeInteraction.test.tsx` 5 用例：
1. team 焦点 + Ctrl+Alt+W close team；
2. team 焦点 + Ctrl+Alt+Shift+ArrowLeft 移动方向；
3. 所有 tabpanel 挂载/hidden/aria-controls 存在，close 非交互；
4. active tab 切换后 panel wrapper 保持；
5. Delete 关闭只调用一次。

## 截图

| 文件 | 说明 |
|---|---|
| `docs/team/t554-v2-960.png` | v2 960×900（单组） |
| `docs/team/t554-v2-480.png` | v2 480×900（单组） |
| `docs/team/t554-legacy-960.png` | legacy 960×900 对照 |
| `docs/team/t554-legacy-480.png` | legacy 480×900 对照 |

v2 480 内部 chat 表格可滚动属于面板内容既有行为；Dock 根 `documentElement.scrollWidth` = 480，无根级横向溢出。960/480 截图由真实 Electron + CDP 生成；截图前等待布局断点生效。

## 遗留 / 边界

- 关闭入口从 × 点击改为 `Delete`/Ctrl+Alt+W（按评审允许的“非交互装饰 + 键盘 Delete”方案）；后续如需鼠标关闭，应由 tab 外独立按钮/菜单提供，不能在 tab button 内嵌套。
- F5 待 DW1-4 删除 legacy 后自然清理。
- 无新依赖、schema、IPC、权限或 gate 变化。
