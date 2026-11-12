# 看门狗预算条并入顶部工作流栏（t428 / G8）

- **任务**：t428（attempt 2）— 把独立 `.watchdog-topbar` 行并入 `WorkflowRail` 顶部栏。
- **分支**：`feature/t428-watchdog-workflow-rail`
- **范围**：App/WorkflowRail/styles/tests/docs；不改 watchdog 数据加载/事件/面板，不改 schema/权限/gate。
- **状态**：实现完成，待独立评审/合并。

## 1. 结果

- 删除 App 中独立 `.watchdog-topbar` 整行（看门狗按钮 + BudgetBar + 告警 pill），App 不再导入 `BudgetBar`。
- `WorkflowRail` 新增可选 `watchdog`：
  ```ts
  { spentUsd, limitUsd, ratio, softRatio, openAlerts, onOpen }
  ```
  无数据时不渲染预算/告警；阶段条、未知状态、NeedsMe 保持原逻辑。
- 顶部栏一行：阶段条（可横向滚动，`flex:1 1 auto; min-width:0`）+ 今日预算 BudgetBar + 告警 pill + 需要我处理。
- 预算/告警点击都调用传入的 `onOpen()`（App 内仍为 `openPanel("watchdog")`）；BudgetBar 的 progressbar/aria-valuetext 原样保留，告警按钮有 `aria-label="打开看门狗，N 个未处理告警"`、`title`，原生 button 可 Tab/Enter/Space。
- 响应式：
  - ≥1101：预算金额/百分比/上限文字完整；
  - ≤1100：隐藏 `.watchdog-budget-text`，保留金额 label + 进度 + 告警；
  - ≤900：预算 track 56px；
  - ≤760：阶段 hint 隐藏、阶段最小宽 48、预算 track 44px、告警紧凑；仍为同一顶部栏，不出现独立第二整行。
- 清理 `.watchdog-topbar` / `.watchdog-topbar-open` / 900/760 topbar 媒体规则 / `.watchdog-topbar *` reduced-motion；保留 `.watchdog-budget` 供 watchdog 面板复用。
- 数据加载仍由 App 的 `loadWatchdog`/事件刷新驱动，`watchdogSnapshot` 仅投影为 rail 可选的展示字段；面板/审批/告警逻辑未改。

## 2. 测试

- `WorkflowRail.test.tsx`：
  - 无 watchdog 不渲染 progressbar/看门狗 group；
  - 有 watchdog 渲染 progressbar、预算按钮和告警按钮，两者点击均触发 `onOpen`。
- `workflowWatchdogRail.test.ts`：
  - App 无 `className="watchdog-topbar"`，有 `watchdog={`；
  - styles 无 `.watchdog-topbar`，有 `.workflow-watchdog`；
  - WorkflowRail `watchdog?` 可选、BudgetBar、告警 aria-label。
- 现有 WorkflowRail 阶段/NeedsMe 测试保持；全量 144 files/981。

```text
pnpm typecheck   # 0
pnpm build       # 0；458 modules
pnpm test -- --testTimeout=20000 --maxWorkers=1
                 # 145 files / 996 tests passed
```

> 默认并行仍有既有 5s flake；serial 全绿。

## 3. 三档截图

- `docs/team/t428-topbar-1440.png`：阶段条 + 预算 + 告警 32 + 需要我处理 32 一行；无 `.watchdog-topbar`。
- `docs/team/t428-topbar-960.png`：≤1100 预算文字隐藏，进度/金额/告警保留。
- `docs/team/t428-topbar-480.png`：阶段条、预算、告警、NeedsMe 同栏；`scrollWidth=480` 无横向溢出，rail 为单栏换行高度（~71px），无独立第二行。
- `docs/team/t428-watchdog-open-1440.png`：点击预算打开 watchdog 面板。

真实 Electron + 临时 userData 副本；CDP 断言 `topbar:false`、`progress:true`、`scrollWidth===innerWidth`（1440/960/480）。

## 4. 验证/回滚

- `pnpm typecheck` 0；`pnpm build` 0（458 modules）；serial test 145/996。
- 回滚：恢复 App `.watchdog-topbar` JSX/`BudgetBar` 导入，删除 WorkflowRail `watchdog` prop/CSS；watchdog 数据/面板不变。
- 已知非阻塞：480 顶部栏因控制项较多增高到约 71px（单栏内折行），仍无独立第二整行/横向溢出；真实数据预算未设置时显示“预算未设置”。
