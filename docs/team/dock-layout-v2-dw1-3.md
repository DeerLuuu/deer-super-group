# DW1-3：自研 DockTree 渲染器 + 引擎开关（t548）

- **实现**：mika（GLM 5.3）· 依据 `docs/team/architecture-batch-v2.md` §3.4（t497 定稿）
- **状态**：v2 渲染器为默认引擎；旧 dockview renderer 保留不删（DW1-4 移除）；不改面板内容/业务/gate/权限；无新依赖。
- **文件**：`dockEngine.ts`（新）、`DockTree.tsx`（新）、`DockGroup.tsx`（新）、`DockSash.tsx`（新）、`DockDropZone.tsx`（新）、`DockShellV2.tsx`（新）、`dockLayout.css`（新）、`DockShell.tsx`（改：legacy 重命名 + 引擎开关分派）、`docktree.test.tsx`（新，16 用例）、`scripts/t548-cdp.mjs`（新）、本文档。

## 1. 渲染器组件

- **DockTree**：递归渲染 LayoutNode——split → flex 容器（axis 定向）+ 子 pane 按权重 flex；相邻 pane 之间插 DockSash；group → DockGroup。memo：layout 引用不变即跳过。
- **DockGroup**：tablist（tab 顺序 = group.panels）+ roving tabIndex（active 0 其余 -1）+ Arrow/Home/End/Delete 键盘；settings 无关闭按钮（closable=false）；PanelHost 只挂 active 面板（renderer/懒加载规则由 PanelHost 内部处理）；**PanelErrorBoundary** 错误边界（面板渲染异常显示内联 role=alert 错误，不拖垮整棵树）；tab HTML5 拖拽（application/x-deer-panel）。
- **DockSash**：role=separator + aria-orientation + tabIndex=0 可聚焦；方向键 ±0.02、Home/End ±0.5；指针拖动（pointer capture + 4px 阈值，与 §3.4 一致）；onResize 语义为权重 delta。
- **DockDropZone**：center = 合并 tab；edge（left/right/above/below）= 相对目标组拆分；dragover 高亮 20%/24% 区域。
- **DockShellV2**：DockHandle 与 legacy 同契约（App 零改动）——openPanel（anchor:chat）/getOpenPanelKeys/closeActivePanel（settings 拒绝）/resetLayout/resetAllLayouts/moveActivePanel（相邻 center / 无相邻 split）/resizeActiveGroup（祖先 split 权重）；t56 键盘改键全保留（Ctrl+Shift+Alt+方向、Ctrl+Shift+Alt+[]、Ctrl+Alt+W）；initialPanelKey 深链 IF-03；卸载 flush。

## 2. 引擎开关（dockEngine.ts）

- `DOCK_ENGINE` 编译期默认 **"v2"**；`VITE_DOCK_ENGINE=dockview` 构建覆盖；运行时 `localStorage["deer.dock.engine"]="dockview"` 可切回（失败回滚路径，DW1-4 前保留）；
- DockShell.tsx 默认导出改为 DockShellSwitch：v2 → DockShellV2，dockview → DockShellLegacy（原实现重命名，一字未改内部）；
- 旧 renderer 完整保留；App import 路径不变。

## 3. 功能对齐（16 测试 + 12 CDP 断言）

- 命令矩阵：open/anchor、close、activate、move、split、resize、dragDrop（center/edge）、reset 全部经 controller.dispatch（reduceDock 唯一入口）；
- 四断点：wide/medium/narrow 两组 + sash；single 单组无 sash（team 是 tab）；
- 2–8 组：reducer clampGroups + single 上限 1 拒绝；
- 懒加载：PanelHost 只挂 active（renderer 规则内部处理）；错误边界覆盖。

## 4. 真实 Electron/CDP 证据（t548-walkthrough.json，12/12 ALL PASS）

- v2 引擎默认激活（docktree-root 渲染，tabs=6，sash role=separator=1）；
- tab 点击激活（aria-selected true）、侧栏「记忆」nav 打开、Ctrl+Alt+W 关闭；
- **v2 store 实际写入**（deer.dock.layout.v2.ws_…）+ 刷新后恢复（docktree-root + store 键保留）；
- 三档 1440/960/480 截图（t548-v2-{1440,960,480}.png）+ 每档无横向溢出；
- **旧引擎可切回**：localStorage deer.dock.engine=dockview + reload → dockview 渲染（截图 t548-legacy-1440.png）；切回 v2 验证后复原。

## 5. 过程修复

- controller flush 增加 dirtyRef：首次 dispatch 后未到 debounce 即卸载（如 nav 切换重挂）不再丢持久化（CDP 复测确认 store 写入）。

## 6. 验证

typecheck 0 / build 0 / serial test 全绿（docktree 16 用例新增）。见 PR checks。

## 7. DW1-4 移交

- 默认已 v2；DW1-4 需删除 dockview 依赖/vendor chunk/v1 适配 + 全量回归 + 回滚演练（revert 本 PR + deer.dock.engine）；
- 遗留观察：resizeActiveGroup 的 delta/1000 换算是近似（像素级 min-width clamp 依赖 CSS flex-basis，未见裁切）；vertical split 的 moveAdjacent 近似按布局顺序（嵌套垂直 split 边缘场景可在 DW1-4 精化）。
