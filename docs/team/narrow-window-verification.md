# 窄窗 Dock 自适应 · t214 修复与验证（repair-round-3）

- **任务**：t214 `[repair]` 窄窗 Dock 自适应 repair-round-3（基于 t212 / PR #33）
- **分支**：`feature/t194-narrow-window-layout`（同一 PR #33）
- **基线**：t212 HEAD `208e7d3`（main `3596f17`）
- **范围**：`src/shell/dock/narrowWindow.ts`、`docs/team/narrow-window-verification.md`；App/DockShell 的消费逻辑沿用 t212
- **结论**：t214 的 4 项 acceptance 均已落实；typecheck/build/test 全绿；真实 Electron expanded 序列截图已产出。

---

## 1. 上轮问题与修复

### 1.1 preferredWidth / displayedWidth 分离（acceptance-1）

**问题**：t194 在窄窗拖拽时直接把 clamp 后的宽度写入 `sidebarWidth`（preferred）并 `mouseup` 持久化，导致 760 拖拽后再回 1440 无法恢复用户原宽度。

**修复**（`narrowWindow.ts` + `App.tsx`）：

- 新增 `SidebarWidthState = { preferred, displayed }` 与纯函数：
  - `resizeSidebarWidth(state, windowWidth, requested)`：**宽窗改 preferred；窄窗只改 displayed**；
  - `commitSidebarWidth(state, windowWidth)`：窄窗返回 `persist:false`（不写 localStorage），宽窗才 `persist:true`；
  - `displayedSidebarWidth(state, windowWidth)`：宽窗永远用 preferred；窄窗用 displayed（缺省用 clamp(preferred)）；
  - `sidebarWidthStateForWindow`：离开窄窗时清 display override。
- App 的 `onMove` 只调用 `resizeSidebarWidth`；`onUp` 仅当 `commit.persist` 时写 `deer.sidebarWidth`；显式双击重置是唯一允许在窄窗写 preferred 的路径。
- 初始 `sidebarWidth` 仍是 localStorage 的 preferred；display 为会话内临时值，不覆写存档。

**测试**：`narrowWindow.test.ts` 的 `preferredWidth vs displayedWidth`：
- 1440 拖到 400 → preferred=400；760 拖到 480 → `{preferred:400, displayed:194}`；760 mouseup `persist:false`；回到 1440 → display=400；
- `760 拖拽 → 1440 恢复原值` 明确断言；
- 窄窗 display override 不泄漏到 wide 渲染。

### 1.2 宽度预算：6px resizer + 4px dock sash（acceptance-2）

**问题**：t194 只按 `window − sidebar` 计算，忽略了侧栏与 Dock 之间的 `.resizer`（6px），非 single 的 Tasks/Team 之间还有 dockview sash（4px），导致实际 main 少于 560。

**修复**（`narrowWindow.ts` / `DockShell.tsx`）：

- 新增常量：`SIDEBAR_RESIZER_WIDTH = 6`、`DOCK_SASH_WIDTH = 4`；
- `sidebarMaxWidth` **所有宽度**统一 `min(480, window − TASKS_MIN_WIDTH − SIDEBAR_RESIZER_WIDTH)`（1440→480、1000→434、960→394、900→334、760→194）；
- `MIN_SPLIT_DOCK_WIDTH = 560 + 4 + 360 = 924`；`selectVariant` 在 `window>960` 且 Dock<924 时强制 single；
- Team 右组宽度：`min(weightWidth, dockWidth − 560 − 4)`，下限 360；`ensurePanel` 新建右组同样处理；
- `defOptions` 的 single 面板最小宽：Dock≥560 时保持声明值（Tasks 560）；Dock<560 的极端场景（960 窗口 200% zoom → 480 CSS viewport，Dock≈418）才降到实际 Dock 宽，由容器查询单列降级（`effectivePanelMinWidth`）。

**测试**：
- 所有宽度 `sidebarMaxWidth = min(480, window−566)`：760/900/960 → 194/334/394，1000→434，1100/1440→480；1000 拖拽 clamp 到 434；960→1000 清 display 后 preferred clamp 到 434；
- `displayedSidebarWidth` 对 displayed 再 clamp：960(394)→900(334)→760(194)，外部传入 999 也按当前窗口 clamp；
- `MIN_SPLIT_DOCK_WIDTH=924`；`selectVariant(923,1200)=single`、`(924,1200)=medium`；`(920/1000)` 边界；
- 200% 481 CSS：Dock=418，`effectivePanelMinWidth(560,true,418)=418`；
- 全量单测见 §4。

### 1.3 resize 后 rebuild 时序（acceptance-3）

**问题**：窗口 resize 时 `windowWidth` 先变、`dockWidth` prop 仍可能是旧值（如 1440→960 时用 1190 建 single 布局），Team 宽度/变体可能用错宽度。

**修复**（`DockShell.tsx`）：

- Dock host 增加 `ref`，`measureDockWidth()` 优先读 `getBoundingClientRect().width`，仅在尚未布局（0）时退回 prop；
- 变体 effect 改为 **requestAnimationFrame 延迟一帧**：等浏览器/ResizeObserver 完成本次 resize 布局，再用 `measureDockWidth()` + 最新 `windowWidthRef` 计算 variant；不再使用可能滞后的 `dockWidth`；
- `buildDefaultLayout` / reset 布局使用实测宽度；Team 默认宽度/ensurePanel 右组也使用实测宽度。

**验证**：真实 Electron 过渡截图 + `t212-electron-metrics.json`：
- 1440×900（sidebar expanded，wide）→ 1100×760（sidebar collapsed，medium，Team 右组）→ 960×700（sidebar collapsed，single，Team 主组 tab）；
- 单元测试覆盖 1440/1100/960/900/760 的 variant 序列（1190→1038→898→838→698）。

### 1.4 旧 single 存档恢复（acceptance-4）

**问题**：旧版 single 存档可能把 Team 放在独立右组；t194 只在新开时 within，恢复旧布局仍 right split。

**修复**（`DockShell.tsx`）：

- 抽出可测试的 `reconcileSingleLayout(api, variant, addTeamToMain)`：single 且 team.group !== chat.group 时，记录 active、close team、以 within 重新添加、若原 active 是 team 再 setActive；非 single/same-group 不变。
- 恢复布局时 `ensurePanel(chat)` 后调用该函数；非 single 仍保证 team 右组。

**测试**：`DockShell.test.ts` 3 例：
1. 旧 single 右组 Team → 被 close，重新加到 main group（`team.group === mainGroup`，不等于 rightGroup），active 仍为 team（`setActive` 调用 1 次）；
2. 已在主组的 Team → 不重加、不抛错；
3. wide 变体 → 保持右组，不移动。

### 1.5 真实 Electron 复核（acceptance-5）

不使用 headless mock。本次通过 **真实 Electron 应用 + 真实 workspace DB**（`按钮工厂`，`%APPDATA%\deer-super-group\deer.db`）启动 worktree 构建，经 CDP（`--remote-debugging-port=9233`）设置 viewport 并截图：

- 应用路径：`S:\DeerSuperGroup\branches\t194-narrow-window-layout`（`dist/` 为本次修复构建）；
- 真实 workspace：`按钮工厂`（Z:\GodotProject\按钮工厂），DB 中真实的 Router/消息/看门狗告警；当前任务数为 0（所以 Team/Tasks 为空态，但仍是真实后端数据）；
- 截图尺寸/DPR/标题/sidebar class/横向溢出记录在 `docs/team/t212-electron-metrics.json`（15 张，全部 `overflowX:false`）；
- 1440/1100/960/900/760 × chat/team/tasks；200% 为默认 1440×900 窗口在 200% zoom 下的等价 CSS viewport **720×450 @DPR2**（Physical 1440×900），不是 mock。

截图清单：

| 场景 | 文件 |
|---|---|
| 1440 chat（wide） | `docs/team/t212-electron-1440-chat.png` |
| 1100 chat/team（medium，sidebar 自动折叠，Team 右组） | `t212-electron-1100-chat.png`、`t212-electron-1100-team.png` |
| 960 chat/team/tasks（single） | `t212-electron-960-{chat,team,tasks}.png` |
| 900 chat/team/tasks（single） | `t212-electron-900-{chat,team,tasks}.png` |
| 760 chat/team/tasks（single） | `t212-electron-760-{chat,team,tasks}.png` |
| 200%（720×450 CSS @2x） chat/team/tasks | `t212-electron-zoom200-{chat,team,tasks}.png` |

> 说明（t214 口径）：200% 截图**以默认 1440×900 窗口为准**，等价 720×450 CSS @DPR2；不是 headless mock。960 窗口@200%（480 CSS）低于 Tasks 560 物理最小宽，只保留 `effectivePanelMinWidth` 降级 + 容器查询并单测覆盖，**不作为 200% visual pass**；若要求 960@200% 仍 560，纳入 P1-4 a11y/字号任务处理。

## 2. 变体/侧栏/宽度矩阵（修复后）

| 窗口 | sidebar | Dock（含 6px resizer） | variant | Team | 截图/证据 |
|---|---|---|---|---|---|
| 1440 | expanded 250 | 1184 | wide | 右组 | 1440-chat |
| 1100 | auto collapsed 56 | 1038 | medium | 右组 | 1100-chat/team |
| 960 | auto collapsed 56 | 898 | single | within tab | 960-* |
| 900 | auto collapsed 56 | 838 | single | within tab | 900-* |
| 760 | auto collapsed 56 | 698 | single | within tab | 760-* |
| 760 + manual expand | 194（clamp） | **560** | single | within tab | t214-760-expanded-tasks |
| 900 + manual expand | 334（clamp） | **560** | single | within tab | t214-900-expanded-tasks |
| 960 + manual expand | 394（clamp） | **560** | single | within tab | t214-960-expanded-tasks |
| 1440 @200% | collapsed 56 | 658 | single | within tab | zoom200-*（默认窗口口径） |

### 2.1 t214 真实 Electron expanded 序列（acceptance-1/3）

在真实 Electron + `按钮工厂` workspace 上，将 preferred 设为 480，960 窗口手动展开后连续缩到 900→760；侧栏实时钳制为 **394→334→194**，Dock 始终 **560**，任务页无横向滚动：

| 请求窗口 | 实测 sidebar | 实测 Dock | 截图 |
|---|---|---|---|
| 960 | 394 | 560 | `t214-electron-960-expanded-tasks.png` |
| 900 | 334 | 560 | `t214-electron-900-expanded-tasks.png` |
| 760 | 194 | 560 | `t214-electron-760-expanded-tasks.png` |

`t214-electron-metrics.json` 记录每次 `innerWidth`、`sidebarWidth`、`dockWidth`、`sidebarClass`、`overflowX:false`。该序列证明：**narrow 下 displayed 会按新 window 的 sidebarMaxWidth 再 clamp**（不会保留上一档的 394），且手动展开在窄内 resize 不被自动折叠覆盖。

- 侧栏自动折叠仍只在初始窄窗/宽→窄边沿；手动展开后窄内 resize 不覆盖；保存的 preferred 在窄窗不被改写。
- `narrow-window-layout.md`（t194）中的 760→200 是旧值；本文件修正为 194（含 6px resizer）。

## 3. 改动文件

```text
src/App.tsx                         preferred/displayed 分离；resize 清 override；拖拽/提交/重置路径
src/shell/dock/narrowWindow.ts      SIDEBAR_RESIZER_WIDTH/DOCK_SASH_WIDTH/MIN_SPLIT=924；sidebar 状态纯函数；effectivePanelMinWidth
src/shell/dock/DockShell.tsx        host 实测宽度；rAF 延迟 rebuild；Team sash 预算；导出 reconcile + 调用；single minWidth 降级
src/shell/dock/narrowWindow.test.ts 28 例（preferred/display、所有宽度 sidebarMaxWidth、1000 拖拽、960→900→760、960→1000、200% fallback）
src/shell/dock/DockShell.test.ts    3 例（旧 single 恢复、已 within、wide 不移动）
docs/team/narrow-window-verification.md 本文档
docs/team/t212-electron-*.png       15 张真实 Electron 三档/200% 截图（t212）
docs/team/t212-electron-metrics.json 对应 viewport/DPR/title/sidebar/overflow 记录
docs/team/t214-electron-960/900/760-expanded-tasks.png  t214 expanded 序列（3 张）
docs/team/t214-electron-metrics.json t214 序列的 innerWidth/sidebarWidth/dockWidth
```

## 4. 验证

在 worktree `feature/t194-narrow-window-layout`、最终代码（HEAD 见任务 output）执行：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **0** |
| `pnpm build` | **0**：js **1,231.56 kB / gzip 338.31**；css 246.17 / gzip 29.72；electron main 1.5MB、preload 11.7kB |
| `pnpm test` | **0**：**61 文件 / 631 用例**全绿（narrowWindow 28 + DockShell 3；既有 permission/approval/kernel/git/review/watchdog/memory/canvas/deeplink 全绿） |

> 测试期间曾因同时运行额外 Electron 实例导致 git/kernel/watchdog 5s timeout 批量失败；关闭额外 Electron 后独立全量复跑 61/631 全绿，非代码回归。

## 5. 边界与遗留

- 200% zoom 的 960 窗口（480 CSS）无法同时满足 Tasks 560 物理最小宽；当前策略是 single 面板 minWidth 降级 + 容器查询，截图采用默认 1440 窗口的 200%。如产品要求 960@200% 仍 560，需 P1-4 a11y/字号任务统一处理。
- 截图通过 CDP `Emulation.setDeviceMetricsOverride` 设置 viewport；这是真实 Electron renderer/backend，但窗口 OS 尺寸未实际 resize（CDP viewport 等价）。Dock 逻辑按 `window.innerWidth` 响应，因此布局验证有效。
- 旧 single 存档恢复测试使用 fake dockview API（不启动真实 dockview），证明 close/add/active 语义；真实 Electron 冒烟用于页面布局。
- 窄窗拖拽→宽屏恢复由纯函数单测覆盖；CDP 截图未模拟鼠标拖拽（无交互注入），建议真机人工再走查一次拖拽手感。
