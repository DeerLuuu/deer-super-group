# 窄窗 Dock 自适应（P0-1）实现与验证

- **任务**：t194 `[implementation]` 实现 P0-1：窄窗 Dock 自适应（single + 侧栏折叠 + Team within）
- **依据**：`docs/team/ux-audit-final.md` §5.1 P0-1；`docs/team/ux-audit-layout.md` F03；`docs/team/ux-audit-feasibility.md` §5 布局约束
- **基线**：main `3596f17`（t193 P0-6 集成完成后的最新 main）
- **分支**：`feature/t194-narrow-window-layout`
- **范围**：`src/shell/dock/`、`src/App.tsx`、`src/TeamDashboard.tsx`（仅相关 CSS）、`src/styles.css`、本文档；未改 kernel/git/memory/review/watchdog/electron/shared
- **结论**：960 / 900 / 760 三档默认 single，`#/team` 以主组 tab 打开（不再 right split），侧栏窄窗自动折叠且手动展开保持；960/900/760 截图无横向裁切，1440/1100 维持原有变体行为。

---

## 1. 问题与目标

审计发现（`ux-audit-layout.md` F03、`ux-audit-final.md` P0-1）：

- 1100 默认窗口/960+窄侧栏下，Tasks 主区被 Team 右组压到低于 `minWidth=560`；
- 960 侧栏折叠后 Dock≈896，按「Dock 宽度」旧规则会选 narrow（760–900），Team 仍强制 right split；`#/team` 在 narrow/single 仍被右侧分栏裁切；
- 侧栏自动折叠依赖 `max-width:1100` 媒体查询，与 Dock 变体判定分离；手动展开后若宽度观察器再次触发会覆盖用户选择。

本任务只解决 **≤960 布局结构**，不改数据层、权限/审批/设置/评审语义。

## 2. 实现

### 2.1 变体判定：窗口宽度参与 + Tasks/Team 最小宽度守卫

`src/shell/dock/panelRegistry.ts`：

```ts
selectVariant(dockWidth, windowWidth = Infinity):
  windowWidth <= 960                        → "single"
  dockWidth < 920 (Tasks 560 + Team 360)    → "single"   // 非 single 无法同时容纳两栏
  dockWidth >= 1100                         → "wide"
  otherwise                                 → "medium"
```

- **960/900/760 一律 single**：即使侧栏折叠后 Dock 变宽（960 窗折叠后 ≈904），也不会回到 narrow/medium 的 right split。
- **非 single 最小和校验**：`MIN_SPLIT_DOCK_WIDTH = TASKS_MIN_WIDTH(560) + TEAM_MIN_WIDTH(360) = 920`；低于 920 自动 single，避免 Tasks 主区 <560。
- **1440/1100 不变**：1440 窗侧栏 250 → Dock 1190 → wide；1100 窗沿用既有侧栏自动折叠（56）→ Dock 1044 → medium。
- 旧 `narrow`（760–900）在当前「Tasks 始终存在」前提不再可达；类型与权重保留仅用于恢复旧布局存档。

`src/shell/dock/DockShell.tsx`：

- 新增 `windowWidth` prop 与 `windowWidthRef`；变体 effect 依赖 `[dockWidth, windowWidth]`；
- `ensurePanel` 使用 `panelInsertDirection(variant, key)`：**single 下 Team 一律 within（主组 tab）**，非 single 才 right；
- 非 single 默认布局给 Team 右组设置宽度时预留 Tasks 主组 560：`teamWidth = max(360, min(weightWidth, dockWidth - 560))`；
- 恢复旧 single 存档时 `reconcileSingleLayout`：若 Team 仍在独立右组，则关闭并重新以 within 打开（保持激活状态），避免老布局继续裁切。

### 2.2 侧栏：窄窗自动折叠 + 手动展开保持 + 可读宽度钳制

`src/shell/dock/narrowWindow.ts`（纯函数，供 App/DockShell 共用）：

- `clampSidebarWidth(width, windowWidth)`：普通宽度 180–480；**窗口 ≤960 时上限 = max(180, windowWidth − 560)**，保证 Dock ≥ Tasks 560 可读宽度；
- `shouldAutoCollapseSidebar(prev, next)`：初始窄窗折叠一次；只有 `prev > 1100 && next <= 1100` 的宽→窄边沿折叠；
- `sidebarMaxWidth` / `isNarrowWindow` 等常量。

`src/App.tsx`：

- 新增 `viewportWidth` 状态（resize 监听）+ `prevViewportWidthRef`；用 `shouldAutoCollapseSidebar` 替换原 `matchMedia` 逻辑——**窄窗内手动展开后继续 resize 不再折叠**；
- 侧栏折叠初始值：`localStorage collapsed || window.innerWidth <= 1100`（避免首帧闪开）；
- 渲染宽度用 `clampSidebarWidth(sidebarWidth, viewportWidth)`，**不覆写 localStorage 保存宽度**：760 窗手动展开显示 200px，回到 1440 恢复原 250/480；
- 拖拽 resizer 同样走 `clampSidebarWidth`；双击恢复默认 250（窄窗下显示上限）；
- 向 `DockShell` 传入 `windowWidth={viewportWidth}`。

### 2.3 内容可读（CSS）

`src/styles.css` 追加：

- `.dock-panel-body[data-panel="tasks"]` 设为 inline-size 容器 `tasks-panel`；
- `@container tasks-panel (max-width: 640px)`：Tasks 从「列表 + resizer + 详情」三列改为**单列三行**——调度栏 / 限高任务列表 / 详情占剩余高度；隐藏 resizer，避免 560px 下横向挤压；
- `@container team (max-width: 620px)`：Team 从「成员列 + 星图」改为纵向（成员限高、星图全宽、任务摘要不限高），避免窄主组裁切。

## 3. 宽度矩阵与行为

| 窗口 | 侧栏 | Dock 近似 | 变体 | Team 位置 | 证据 |
|---|---|---|---|---|---|
| 1440×900 | 展开 250 | ≈1190 | wide | 右组（42%） | `docs/team/t194-wide-1440-team.png` |
| 1100×760 | 自动折叠 56 | ≈1044 | medium | 右组（44%） | 既有行为保持（本任务未改阈值） |
| 960×700 | 自动折叠 56 | ≈904 | **single** | within tab（`#/team`） | `t194-narrow-960-{chat,team,tasks}.png` |
| 900×700 | 自动折叠 56 | ≈844 | **single** | within tab | `t194-narrow-900-{chat,team,tasks}.png` |
| 760×700 | 自动折叠 56 | ≈704 | **single** | within tab | `t194-narrow-760-{chat,team,tasks}.png` |
| 760×700 + 手动展开 | 200（钳制） | ≈560 | single | within tab | `t194-narrow-760-tasks-expanded.png`（Tasks 已切单列） |

- 960/900/760 截图均为 Edge headless（真实 renderer + dockview CSS，mock workspace：1 Router + 3 tasks；非 Electron 真机），侧栏均为折叠态、无 Team 右组，`#/team` 在主组 tab 内全宽显示；
- 760 手动展开截图由 mock 页自动点击 `.sidebar-toggle` 得到：侧栏 200px、Dock≈560，Tasks 触发 `@container tasks-panel (max-width:640px)` 单列；证明「手动展开不被折叠覆盖 + 560 最小可读宽度」同时成立。

## 4. 测试

新增 `src/shell/dock/narrowWindow.test.ts`（19 例）：

- `selectVariant`：960/900/760（侧栏折叠后 904/844/704）均 single；960 + Dock 1200 仍 single；非 single 最小和 920；1440 wide、1100 medium；
- `panelInsertDirection`：single Team/所有面板 within；wide/medium/narrow Team right；
- `clampSidebarWidth` / `sidebarMaxWidth`：760→200、900→340、960→400、1440→480；任意窄窗 `window − clamp ≥560`；宽窗恢复 480；
- `shouldAutoCollapseSidebar`：初始窄窗 true、宽窗 false、宽→窄边沿 true、窄内 resize/手动展开 false。

验证命令（在 worktree 内）：

```bash
pnpm typecheck        # exit 0
pnpm build            # exit 0；dist js 1,230.14 kB / gzip 337.94；css 246.17 kB / gzip 29.72
pnpm test             # 结果见任务 output（全量测试）
```

## 5. 边界与后续

- **侧栏自动折叠阈值仍为 1100**（沿用既有行为，b908d1a 的 C09）；single 阈值是 960。>960 但手动展开侧栏使 Dock<920 时，本任务会按最小和守卫降为 single（这是对「Tasks 560 + Team 360」不变式的保护，不是回到旧 narrow）。
- **旧布局存档**：single 右组 Team 会在恢复时收敛为 tab；Dock 存档仍按 workspace×variant 分开保存（deep link、快捷键、Modal/权限语义未改）。
- 未执行真实 Electron 960/900/760 人工冒烟（本环境无窗口）；截图使用 Edge headless + mock `window.deer`，验证的是真实 renderer/布局而非 Electron 启动链。发布前建议在 Electron 用真实 workspace 复核三档 + 200% zoom。
- Team `@container` 620/700 规则只调布局，不改变 TeamDashboard 数据/交互；`src/TeamDashboard.tsx` 无逻辑改动（由 `src/styles.css` 的 team 容器查询覆盖）。
- settings/review/kernel/git/memory/watchdog 均未改动。
