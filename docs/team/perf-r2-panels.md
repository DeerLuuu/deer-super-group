# P0-8 R2：面板渲染隔离（PanelHost / domain version）

- **任务**：t265 implementation — R2 面板渲染隔离（按 t259 设计 §R2；本 PR 不混入 R3）
- **设计基线**：`docs/team/perf-isolation-design.md` §3/§PR R2
- **基线 main**：`00bf167`（t263 R1 集成后；R1 ChatLiveStore 已在 main）
- **分支**：`feature/t265-perf-r2-panels`
- **结论**：App→DockShell 的内联 `renderPanel` 与 `PanelContentContext` 已移除；Dock 内每个 panel 通过稳定 `PanelHost` + domain version 边界渲染，token/无关 App state 不再触发已挂载 panel；rail/WorkflowRail/NeedsMe 仍读 App 同一 snapshot，不引入第二数据源。

---

## 1. 问题与目标

R2 之前：

```text
App 任一 setState
  → App render 生成新的内联 renderPanel 箭头函数
  → DockShell 收到新 renderPanel prop
  → PanelContentContext.Provider value 变化
  → 所有 DockPanelBody consumer render
  → render(key) 重新生成 panel element
  → 已挂载/隐藏 always panel 全部 render
```

R2 之后：

```text
App state 变化
  → renderPanelContent 写入稳定 panelRenderRef（不作为 prop/context value）
  → PanelHostProvider 比较每个 panel 的 domain deps
  → 只有 deps 引用变化的 key bump version
  → 仅对应 PanelHost 重新读取 renderRef.current(key)
  → 其他 PanelHost/panel 不 render
```

> App 仍是唯一 snapshot/source；`renderPanelContent` 每次 App render 更新到 ref，PanelHost 只负责「何时 render」，不另存一份 panel 数据。

---

## 2. 实现

### 2.1 新文件

| 文件 | 作用 |
|---|---|
| `src/shell/panel/PanelHost.tsx` | `PanelHostProvider`（domain deps → version store）、`PanelHost`（memo + `useSyncExternalStore` 单 key 订阅）；renderRef 是稳定 facade |
| `src/shell/panel/panelHost.test.tsx` | 6 panel + 无关 provider render + 单 domain bump + renderRef/late mount 回归 |
| `docs/team/perf-r2-panels.md` | 本文件 |

### 2.2 DockShell

- 删除 `renderPanel` prop、`PanelContentContext`、`DockPanelBody` 的 Consumer。
- `DockPanelBody` 直接渲染 `<PanelHost panelKey={api.id} />`，外层 `.dock-panel-body` 属性不变。
- Dock tab/组/拖拽/键盘/布局持久化/窄窗逻辑不变；`PanelHost` 只是内容边界。
- `DockShell` 的布局/深链/选中/active 仍由原 `DockviewReact` 与 App 的 `DockHandle` 驱动。

### 2.3 App

- 删除 `<DockShell renderPanel={...}>`；原 switch 抽为 `renderPanelContent(key)`，只写入 `panelRenderRef.current`。
- `<DockShell>` 外包 `<PanelHostProvider renderRef={panelRenderRef} depsByKey={...}>`。
- panel 数据/actions 仍来自同一 App render；PanelHost 的 version 变化后读取最新 `renderRef`，因此不会出现 panel 单独维护快照的双源。
- rail、WorkflowRail、NeedsMe 继续由 App 的 `snapshot/tasks/runs/scheduler/mergeQueue/watchdog` 派生，和 panel 同批次。

### 2.4 Domain deps（panel key）

| Panel | 主要 deps（引用比较） |
|---|---|
| `chat` | messages / turns maps / questions / chat input/view/busy/trajectory / context / agents / settings / workspace overview |
| `tasks` | tasks/agents/workspace、selectedTask(+id)、trace、status filter、createIntent、scheduler/runs 状态、action 状态、watchdog alerts/handoffs、workspaceSource |
| `team` | tasks/agents/runs/workspace、busy、scheduler、starmapFocus、createIntent |
| `runs` | tasks/runs/agents、scheduler、runs/trace/selection、action busy、workspaceSource |
| `planDraft` | draft/source/issues/busy/error/confirming/agents |
| `context` | context、taskContext |
| `mailbox` | messages、busy、selectedMessageId、createIntent |
| `board` | boardEntries、agents、selectedBoard、createIntent |
| `polls` | workspace id、agents、pollIntent |
| `watchdog` | watchdog snapshot/costs、selectedTaskId |
| `settings` | snapshot.settings |

- deps 只在本次 App render 的元素引用变化时 bump；token 由 R1 external store 处理，不进入 App deps。
- 首次挂载不额外 bump（PanelHost 初次即用最新 renderRef）；隐藏/后挂载 panel 读取当前 version 和最新 renderRef。
- 本地筛选/滚动/展开仍留在 panel 组件内部；version bump 重渲染同一 component type，子树状态不重置。

### 2.5 Actions / 稳定边界

- panel 内容通过稳定 `panelRenderRef` 读取，不再把闭包函数作为 DockShell prop/context value；无关 App render 不会改变 PanelHost 的 props。
- provider/context value 固定（`store + renderRef`），provider 自身 re-render 不会改变 `PanelHost` 的 memo 输入。
- 面板动作仍调用 App 的 handler；在 domain 变化时读取最新 handler closure。Dock/rail 调用 `openPanel` 等原有路径不变。

---

## 3. 测试与基线

### 3.1 PanelHost 6-panel fixture

`src/shell/panel/panelHost.test.tsx`：

- 挂载 `chat/tasks/team/mailbox/board/runs` 6 个 PanelHost；
- 初次全部 render 1 次；
- provider 因 App 无关 state 重渲染（同一 deps 元素引用）→ 6 个 panel **均不 render**；
- 仅 `mailbox` deps 变化 → **mailbox 1→2，其余仍 1**；
- `renderRef` 指向最新 renderer；后挂载 panel 读取最新内容。

### 3.2 继承 R1 token 基线

R1（main）已有：

- 150 历史 + 6 sibling panel + 20 token：parent/history/siblings 各 1 次 render；
- 实际 ChatView 150 messages + 20 token：ChatViewProbe 1 次 render。

R2 新增的稳定 PanelHost 不把 token 写回 App；token 期间 `panelDepsByKey` 不变化，故不会 bump 任何 panel version。

### 3.3 命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **0** |
| `pnpm build` | **0**：431 modules；js 1,278.67 kB / gzip 353.73；css 258.43 / gzip 31.64；electron main 1.5MB/preload 11.9kB |
| `pnpm test` | **0**：90 文件 / 742 用例（最终全量；见下） |

> 本机并发负载下曾出现既有 `openai.test`/`watchdog` 5s timeout；单独运行通过，重跑全量通过。与 R2 无关。

### 3.4 Dock/深链/rail 回归

- DockShell 布局/拖拽/tab/键盘/reset/旧 single reconcile 测试保持；
- `routeTabFromPanel`/`PrimaryRail`/`openPanel`/deep link 未改逻辑；
- 选中任务仍由 App `selectedTaskId`/`selectedTask` 驱动，Tasks/Runs/Team 与 rail/Workflow 同 snapshot batch；
- 无 CSS/布局改动，1440/960 既有窄窗截图矩阵不受影响。

---

## 4. 风险 / 回滚

| 风险 | 处理 |
|---|---|
| deps 漏列导致 panel 不刷新 | deps 按 panel 消费 slice 显式列出；panel 动作/selection 也纳入；新增数据字段时需同步 deps；review 关注 Tasks/Team/Chat 关键路径 |
| 版本 bump 在 layout effect 后发生 | 面板内容多一次 React render（仅该域）；不产生双源，rail/Workflow 同一 commit 已更新 |
| actions 读取旧 closure | domain 变化后 PanelHost 用最新 renderRef；handler 多数走 refs；点击路径由现有测试/真实 Electron 回归 |
| Dock 内容边界引入挂载差异 | 不改变 `always`/`onlyWhenVisible` 生命周期与 DockPanelBody DOM；只替换内容注入方式 |
| 回滚 | revert 本 PR；DockShell 恢复 renderPanel prop，R1 独立保留；不涉及 DB/IPC/schema |

---

## 5. 明确不做

- R3 RefreshCoordinator / 事件去重 / 隐藏轮询 / seq gap：不在本 PR。
- 新的全局状态库 / Monaco / 虚拟列表 / React Compiler / 微前端：不做。
- 不改变权限/gate/数据层语义。

## 6. 文件范围

- 新增：`src/shell/panel/PanelHost.tsx`、`src/shell/panel/panelHost.test.tsx`、`docs/team/perf-r2-panels.md`。
- 修改：`src/App.tsx`、`src/shell/dock/DockShell.tsx`。
- 未改：`src/kernel/execution/`、`src/git/`、`src/memory/`、`src/review/`、`src/watchdog/`、`electron/`、`src/styles.css`。
