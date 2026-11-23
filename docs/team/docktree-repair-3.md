# DW1-3 DockTree repair-round-3（t560 / t555 F1–F2）

- **分支**：`feature/t548-docktree-renderer`（PR #81）
- **范围**：`src/shell/dock/DockGroup.tsx`、`DockShellV2.tsx`、`dockLayout.css`、`docktreeInteraction.test.tsx`、本报告
- **不涉及**：kernel/memory/review/watchdog/electron、schema/IPC/权限/gate、依赖/package

## 修复

### 1. 鼠标关闭入口（t555 F1）

- 删除 tab 内的可点 ×；改为 group header 内 **tablist 外**原生 `<button class="docktree-group-close">`：
  - 关闭当前 active panel；
  - 原生 button 默认 Tab 可达、`aria-label=关闭<面板>`、`title` 提示；
  - active panel 不可关闭时（settings）不渲染；
  - Delete 键关闭路径保留。
- Tab 内不再渲染任何 close 外观的交互控件，避免误点。
- 测试：鼠标 click → `onPanelClose` 正好 1 次（chat）；Delete → 正好 1 次；两者分别覆盖。

### 2. 树结构相邻组（t555 F2）

新增导出纯函数 `findAdjacentPanelInLayout(layout,panel,direction)`：
- 从 root 递归定位 panel 的父链（每个 split + child index）；
- 只在**同轴** split 的 sibling 子树中找目标；
- 目标取 sibling 子树靠近边界的 group（right/below 取 start，left/above 取 end）；
- 无同轴 sibling 返回 null（调用方退回 split）。
- `DockShellV2.moveActivePanel` 使用该函数；补嵌套 `root horizontal [chat, vertical [tasks, team]]` 测试：
  - chat right → tasks；team left → chat；
  - tasks below → team；team above → tasks；
  - tasks right / team right / tasks above → null。

### 3. lazy-on-first-activate + keepalive

- `panelDefs[panel].renderer === "always"`：始终挂载（chat/tasks/mailbox/board/team 等）；
- `onlyWhenVisible`：首次激活时才挂载 PanelHost，之后使用 `mountedRef` keepalive，切走只 hidden 不卸载；
- 每个 tabpanel wrapper 始终存在（`aria-controls` 始终有效），未挂载的 wrapper `data-mounted="false"`。
- 测试：settings 初始 `data-mounted=false`，激活后 true，切回 chat 后仍 true。

### 4. DW1-4 清理边界

- 本 repair 只清理 DockGroup 内重复 close 与旧装饰；不删除 legacy/dockview。
- F5（v2 bundle 含 legacy）仍由 t556/DW1-4 删除 `DockShellLegacy`、`dockEngine`、v1 `panelRegistry` store、dockview 依赖与 vendor chunk；本 PR 不提前扩大范围。

## 验证

```text
pnpm typecheck  # exit 0
pnpm build      # exit 0（475 modules）
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                # 182 files / 1237 tests passed（serial，同步 main 后）
```

新增/更新 `src/shell/dock/docktreeInteraction.test.tsx` 共 9 用例（mouse close、Delete close、嵌套相邻、lazy/keepalive、aria/结构等）。完整串行结果见任务完成报告。

## 截图

| 文件 | 说明 |
|---|---|
| `docs/team/t560-close-1440.png` | v2 1440：各 group tablist 外独立关闭按钮 |
| `docs/team/t560-close-960.png` | v2 960：双组，关闭按钮 Tab 可达 |
| `docs/team/t560-close-480.png` | v2 480：单组，关闭按钮在 tablist 外右侧 |

真实 Electron + CDP；DOM 断言 `docktree-group-close` 的 `tabIndex=0`、`aria-label=关闭对话/关闭团队`；根 `scrollWidth` 等于视口。

## 遗留

- t556/DW1-4 删除 dockview/legacy/v1 适配后，本文件的 `DockShell` 类型入口与测试按最终导出收敛。
- lazy 实现仅对 `onlyWhenVisible` 首次激活挂载；`always` 面板仍按 panelRegistry 规则常驻。
