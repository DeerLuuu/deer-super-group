# DW1-3 新 DockTree 渲染器 · 最终集成验收（t551）

- **任务**：t551 — 最终集成 DW1-3（t548 实现 → t549 PASS → t554/t560 修复 → t561 review）
- **PR**：[#81](https://github.com/DeerLuuu/deer-super-group/pull/81) — **MERGED（squash）**
- **合并提交**：`84b0f55`
- **实现文档**：`docs/team/dock-layout-v2-dw1-3.md`
- **修复报告**：`docs/team/docktree-repair-2.md`、`docktree-repair-3.md`
- **验证**：`docs/team/dock-tree-renderer-verification.md`（t549 PASS）
- **复审**：`docs/team/dock-tree-renderer-review-3.md`（t561 pass）
- **结论**：**PASS，已合并**；t548 worktree/branch 已清理；当前仅主工作区。

## 1. 功能/开关可追溯

### 新 DockTree 渲染器（v2）

- `DockTree`：split/group 递归，sash 插入。
- `DockGroup`：tablist + roving tabindex + 键盘（Arrow/Home/End/Delete）+ 拖拽 + PanelHost active + PanelErrorBoundary；t554 改为所有 PanelHost 常挂载、非激活 tabpanel `hidden`，保留组件本地状态；t560 恢复 tablist 外原生关闭 button（tabIndex 0/aria-label），tab 内不再渲染可点 ×。
- `DockSash`：`role=separator` + 方向键 + 指针拖动 4px 阈值。
- `DockDropZone`：center/四向 edge；`findAdjacentPanelInLayout` 按 split 轴/父链求真正相邻组（嵌套 chat/tasks/team 测试）。
- `DockShellV2`：DockHandle 同契约 + t56 键盘 + 深链 + 断点；记录最近聚焦 activeGroup/activePanel，close/move/resize 使用该组。
- `dockLayout.css`：token-only。

### 引擎开关 / 回退

- `dockEngine`：编译期 `VITE_DOCK_ENGINE`、运行时 `localStorage["deer.dock.engine"]`；默认 **v2**，可强制 `dockview`。
- `DockShell.tsx` 引擎分派：legacy DockShell 重命名 `DockShellLegacy`，App 零改动；旧 dockview renderer 保留未删。
- t548 CDP 12/12：v2 默认激活/tabs6/sash/tab aria-selected/nav 打开/Ctrl+Alt+W 关闭/v2 store 写入+reload 恢复/三档无溢出/legacy 切换对照。
- t560 修复：鼠标关闭、真正相邻查找、onlyWhenVisible keepalive、tabpanel aria-controls；t560 close 三档截图。

## 2. 独立复跑（PR HEAD `e67c322`，main `af146cb`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；475 modules
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 182 files / 1237 tests passed
```

> plain 并行有既有 5s timeout；串行全绿。

## 3. 三档/aria/持久化/范围

- v2/legacy 1440/960/480 真实 Electron 截图无横向；960/480 v2 单组、close 可见。
- tablist roving/aria-selected/aria-controls；close 原生 button；sash separator；焦点/键盘。
- v2 store 写入/reload 恢复；legacy 切换对照；默认 v2 可切回。
- PR diff：4 新组件 + DockShellV2/dockEngine/DockShell 分派/CSS/tests/docs/CDP/截图；未删除 dockview、无 package/lockfile/新依赖。
- 无 gate/权限/schema/IPC/业务变更。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #81 | MERGED（squash） |
| merge commit | `84b0f55` |
| main | `84b0f55` + 本报告提交 |
| t548 worktree | 已移除（清理时发现旧 t560 harness Electron 占用目录，已终止并删除） |
| t548 branch | 已删除（local） |
| 当前 worktree | 仅主工作区 |

## 5. 遗留（非阻塞）

1. group 级 close UX 仅单面板按钮（N1 low）。
2. keepalive 组件资源占用（N2 low）。
3. v2 bundle 仍含 dockview/legacy（DW1-4 删除，N3 low）。
4. legacy 仅 1440 对照截图（N4 low）。
5. 既有并行测试时序 timeout（N5 info）。

**最终结论：DW1-3 PASS，PR #81 已 squash 合并 `84b0f55`；DockTree/Group/Sash/DropZone、DockShellV2、默认 v2 引擎开关/legacy 回退、三档/aria/持久化、t554/t560 修复均集成验收；dockview 保留、无新依赖/schema/权限；遗留仅为资源/旧引擎清理项。**
