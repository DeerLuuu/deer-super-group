# Dock 布局实现映射 · t50（VSCode 风格，对话/团队双主面板 / mika）

- **实现人**：mika（Frontend Engineer: layout）
- **依据**：`docs/team/dock-layout-design.md`（t49，选型 dockview-react 8.9.0 精确锁版本，已安装 dockview-core 8.9.0）
- **验证**：`pnpm typecheck` ✅ · `pnpm build` ✅ · `pnpm test` 46/46 ✅
- **改动**：新增 `src/shell/dock/panelRegistry.ts`、`src/shell/dock/DockShell.tsx`；改 `App.tsx`（dock 接线 + ChatView 上下文抽取）、`CommandPalette.tsx`（面板命令组）、`styles.css`（dock 主题）；`package.json`/`pnpm-lock.yaml`（依赖）

## 验收项 → 实现说明

### 1. 按设计选型实现（dockview-react 8.9.0）
- `DockShell.tsx` 封装 `<DockviewReact>`：App 不直接接触 dockview 类型，全部经受控 props / `DockHandle`（openPanel/closeActivePanel/resetLayout/resetAllLayouts/moveActivePanel/resizeActiveGroup）。
- 自定义 `defaultTabComponent`：settings 隐藏关闭按钮（§7.4 草稿保护），其余沿用库默认 tab（原生拖拽/关闭/roving tabindex/aria）。

### 2. 默认布局：对话与团队同时可见
- `buildDefaultLayout`：主组（chat 锚 + tasks/mailbox/board/settings tab）+ 团队右组（`direction: "right"`，按变体权重 58/42、56/44、52/48 设初始宽）；`single` 变体（dock<760）合并为单组 tab。
- 首帧激活面板 = 深链 tab（空 hash 默认 `#/tasks`，沿 C12 契约），对话/团队仍然同时可见。
- 变体按 `.dock-host` ResizeObserver 实测宽度选择（wide/medium/narrow/single），跨档切换：flush 旧变体存档 → 按新变体缓存/默认重建，保持激活面板。

### 3. 六视图 + 上下文面板；拖动/拆分/合并/调整/关闭重开
- 7 个单例面板（chat/team/context/tasks/mailbox/board/settings），注册表含 min 尺寸（420/360/280/560/480/360/560 宽）与 renderer（always / onlyWhenVisible）。
- tab 拖到组边缘拆分、拖入组合并、分栏拖动调整——dockview 原生；组上限 4（键盘移动路径强制，超限 toast 拒绝）。
- 关闭：tab × 或 Ctrl+Alt+W 或命令面板（settings 拒绝并提示）；重开走 `openPanel`（已有实例激活；不存在按默认落位：chat 组内 tab，team 右组）。
- 全部关闭 → 水印覆盖层「所有面板已关闭 + 打开对话 / 恢复默认布局」。

### 4. 布局持久化 + 恢复默认
- localStorage `deer.dock.v1.<workspaceId>`，版本化 `{schema:"deer.dock.state",version:1,variants:{...}}`，按变体分别记忆（layout=库 toJSON 快照 + activePanel）。
- 写入：`onDidLayoutChange` 400ms 防抖 + beforeunload/卸载/变体切换/工作区切换 flush；保存失败静默降级 + toast。
- 读取：schema/version/体积校验失败 → 删 key 回退默认；`fromJSON` try/catch 回退；restore 后 reconcile 必保 chat/team。
- 恢复：命令面板「恢复默认布局」（当前变体重建）/「重置所有布局」（确认后清 key）+ 水印按钮。

### 5. hash 深链 / 命令面板 / C14 / Modal·Toast / 侧栏导航
- hash：`onDidActivePanelChange → routeTab 派生 setTab`（context 面板不改 hash）；`hashchange → dockRef.openPanel(route.tab)`；写 hash 沿用现有 pushState/replaceState 逻辑与防环 guard（lastWrittenHashRef/lastTabRef）。deeplink 模块与 `deeplink.test.ts` 零改动（`#/router` 别名等契约保持）。
- 命令面板：新增「面板」组 8 项（打开上下文/关闭当前/移动当前面板×4/恢复默认布局/重置所有布局），footer 增补 Ctrl+Alt+方向键提示。
- C14：`openPanel` 统一入口——任务→星图定位（openPanel('team')+starmapFocus 双 rAF 居中不变）、对话「返回任务/团队」、任务页打开；Alt+1–6 改走 openPanel。
- Modal/Toast：全局层不变（挂在 shell，不受 dock 关闭影响）；dock 通知复用 ToastHost。
- 侧栏：6 导航 onClick → `openPanel`，`aria-current` 由派生 tab 驱动；折叠/Ctrl+B 不变。

### 6. 上下文面板抽取（§4.6A）
- ChatView 移除内嵌上下文列/拖拽分隔条/显隐切换（`deer.contextWidth`/`contextVisible` 不再读写）；头部「上下文」按钮 → `openPanel('context')`。
- `ContextPanel`（现有渲染）作为独立 dock 面板（默认关闭、renderer always、min 280×240）；任务上下文徽标/返回来源保留在 ChatView。

### 7. 窄窗与键盘/ARIA（t56 改键后）
- 窄窗：<760 single 变体（6 视图 tab 共存）；760–899 narrow 52/48；侧栏 ≤1100 自动折叠逻辑不变；窗口 minWidth 已降为 960（t56 F2），single 可达。
- 键盘：dockview 原生 tablist roving tabindex/focus-visible；**Ctrl+Shift+Alt+方向键**（相邻组合并/无相邻则拆分，4 组上限）、**Ctrl+Shift+Alt+[ / ]** 组宽 ∓/±80、Ctrl+Alt+W 关闭；Alt+1–6/Ctrl+K/Ctrl+B 不变（t56 F1 改键，原 Ctrl+Alt+方向键与 Windows 屏幕旋转/输入法冲突）。
- 鼠标拖拽与键盘同样受最多 4 组约束（onWillDrop 拒绝超额拆分并提示合并，t56 F3）。
- reduced-motion：dock 区域禁用过渡/动画（CSS 媒体查询）。

## 与设计的偏差（t56 修复后更新，裁决 bb-83）
1. **模块合并**：设计的 6 文件合并为 `panelRegistry.ts` + `DockShell.tsx`（spec/构建/持久化/命令集中在两文件，App 仍不接触 dockview 类型）；`dockTheme.css` 并入 styles.css。
2. **上下文打开规则简化**：§5.2 的「主组≥708 右侧拆分否则 tab」未做宽度探测——context 统一以 chat 组内 tab 打开（用户可拖出分栏）；设计已声明「二者语义二选一」。
3. **键盘 F6 / Ctrl+Shift+\\ 未实现**：MIT core 的组焦点 API 与 DOM 钩子未在本次封装；Tab/roving tabindex 已覆盖基本可达性。
4. **组约束重放（R6）**：panel 级 minimumWidth/Height 随布局持久化；group 级 `setConstraints` 未重放（v8 布局序列化已含 panel 约束，组级留待需要时补）。
5. **保存分档防抖**：structure/active 150ms 与 geometry 400ms 合一为统一 400ms（≤64KB 校验 + 损坏回退不变）。
6. **团队紧凑模式（§4.6B）**：<560 的成员 chips 化未实现——团队面板沿用现有 1100px 媒体查询布局，dock 下窄面板可横向滚动；紧凑模式建议下一轮（配合容器查询）。

## t56 修复记录（repair-round-2，裁决 bb-83）
- **F1 快捷键改绑**：移动/拆分 `Ctrl+Alt+方向键` → **`Ctrl+Shift+Alt+方向键`**；调宽 → **`Ctrl+Shift+Alt+[ / ]`**（缩小/放大，±80）；`Ctrl+Alt+W` 关闭保持。CommandPalette 移动命令 hint、footer 提示、DockShell 注释与帮助文案同步更新。冲突分析：`Ctrl+Alt+方向键` 是 Windows 显示驱动屏幕旋转热键与常见输入法冲突组合；新组合为三修饰键+方向/方括号，不属于 Windows/主流中文输入法（微软拼音/搜狗）系统级组合。运行环境无法交互冒烟输入法，该项列入人工冒烟清单（见下）。
- **F2 minWidth 1100→960**（`electron/main.ts:28`，minHeight 700 不变），single 变体（dock<760）可达。**两档算术冒烟**（dock 宽 = 窗口 − 侧栏 56 折叠 / 250 展开；断点 wide≥1100 / medium≥900 / narrow≥760 / single<760）：
  - 窗口 1100 + 折叠：dock=1044 → **medium**，主组 56%≈585 ≥ chat 420 ✓，团队 44%≈459 ≥ 360 ✓；
  - 窗口 1100 + 展开(250)：dock=842 → **narrow**，主组 52%≈438 ≥ 420 ✓，团队 48%≈404 ≥ 360 ✓（≤1100 侧栏自动折叠，此档仅手动拖宽侧栏时出现）；
  - 窗口 960 + 折叠：dock=904 → **medium**，主组 ≈506 ✓，团队 ≈398 ≥ 360 ✓；
  - 窗口 960 + 展开(250)：dock=710 → **single**（6 视图单组 tab），不再破约束。
  两档下变体选择与团队 ≥360 均成立（运行时实测属人工冒烟项；代码路径：App `.dock-host` ResizeObserver → selectVariant → DockShell 重建 + 团队组 setSize(max(360, …))）。
- **F3 组数上限（鼠标拖拽）**：`DockviewReact onWillDrop` 守卫——拆分型 drop（position ≠ center）在已满 4 组时 `preventDefault()` + toast「最多 4 个分栏，请先拖回合并」；center（并入现有组）放行；键盘/命令面板路径上限不变。**原偏差第 6 条（拖拽路径不设限）已撤销，属本轮修复而非降级**。
- 验证：`pnpm typecheck` ✅ / `pnpm build` ✅ / `pnpm test` 46/46 ✅。

## 冒烟提示（无 Playwright，DnD/输入法需手测）
默认双栏可见、tab 拖拽拆分/合并、分栏拖动、关闭重开、刷新恢复布局、`#/tasks?t=`/`#/chat?task=` 深链、Ctrl+K 面板命令、**Ctrl+Shift+Alt+方向键移动 / Ctrl+Shift+Alt+[ ] 调宽**、Alt+1–6、侧栏折叠后 dock 变体切换、960/1100 两档窗口实测、输入法激活下新组合无系统行为、拖拽第 5 组被拒提示。
