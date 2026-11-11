# WorkflowRail 常驻阶段条 + NeedsMe 汇总（t222 / P0-3）

- **任务**：t222 — 用现有 task/run/review/merge/watchdog 状态投影常驻工作流与“需要我处理”
- **依据**：`docs/team/ux-audit-final.md` P0-3、bb-98
- **分支**：`feature/t222-workflow-rail-needsme`（基于 main `c60d30b`）
- **范围**：`src/App.tsx`、`src/styles.css`、`src/shell/`、`src/shared/`、`docs/team/`
- **不做**：不改 review/merge gate、权限、任务状态机；不新增第二套任务/事件事实源。

---

## 1. 目标与交互

### 1.1 WorkflowRail

主区顶部常驻一条轻量阶段条（固定约 42px，不打开新弹窗）：

```text
讨论 → 计划 → 运行 → 评审 → 交付 → 记忆            需要我处理 3
```

- 六阶段常驻；当前阶段高亮 `aria-current="step"`，并使用现有状态派生出的唯一 CTA 文案。
- 每个阶段可直接点击跳转：
  - 讨论 → `chat`
  - 计划/运行 → `tasks`（有 focusTask 时选中）
  - 评审 → `tasks` + ReviewSection focus
  - 交付 → 现有 MergeQueue modal
  - 记忆 → `board`
- `unknown` 不伪造阶段：不高亮、不显示 CTA，只显示“阶段未知”。
- 全部入口复用 `openPanel`/`handleOpenTaskPage`/`handleOpenTaskReview`/`handleOpenMergeQueue`，不新增面板或路由。
- 顶部 rail 仍保留；WorkflowRail 是工作区内的阶段投影，不替代 PrimaryRail/Dock。

### 1.2 NeedsMe

- rail 右侧显示 `需要我处理 N`，仅 N>0 时出现；空态不占主界面。
- 点击打开列表（`role=listbox`），每条显示标题 + 简短原因；点击定位：
  - failed/blocked/review → 选中对应 task，打开 Tasks；review 使用现有 Review focus
  - merge → 现有 MergeQueue modal
  - alert/budget → 现有 watchdog 面板
- 不新增事实源：所有条目直接从 `snapshot.tasks` / `taskRuns` / `scheduler` / 现有 MergeQueue API / `watchdogSnapshot` 投影；不写回，不创建事件。
- 去重：任务按 `task:<kind>:<id>`，merge 按 `merge:<id>`，alert 按 `alert:<id>`，budget 固定 `budget:workspace`；同一 id 只出现一次。
- 预算：只有 `workspaceDay.ratio >= 1` 且没有 open budget alert 时生成一条，避免和 budget alert 重复。

---

## 2. 阶段派生规则（纯函数 `src/shell/workflowData.ts`）

优先级（用户现在最可能需要的阶段）：

1. **run**：有 running/queued/failed/blocked task，或 scheduler active/queue，或 active run；
2. **review**：存在 `status=review` task；
3. **deliver**：现有 MergeQueue 中有活动项（queued/waiting_checks/waiting_review/ready/updating/merging/blocked/failed）；
4. **plan**：有 `status=ready` task；
5. **remember**：有 `status=done` task；
6. **discuss**：没有任何 task（空工作区）；
7. **unknown**：有 task 但没有可安全推断的 active/ready/done 状态（例如只有 cancelled）。

`unknown` 返回 `cta:null`；`deriveNeedsMe` 空输入返回 `[]`，不渲染空 NeedsMe。MergeQueue 未加载（undefined）时不推断“待合并”。

---

## 3. 实现

| 文件 | 内容 |
|---|---|
| `src/shell/workflowData.ts` | `WORKFLOW_STAGES`、`deriveWorkflow`、`deriveNeedsMe`；纯投影/去重 |
| `src/shell/WorkflowRail.tsx` | 六阶段 nav、当前 CTA、NeedsMe 列表；只在空态隐藏 badge |
| `src/App.tsx` | 计算 projection/needs；MergeQueue API 只读加载；阶段/NeedsMe 定位 handler；rail 渲染在 `<main>` 顶部 |
| `src/styles.css` | `.workflow-rail` 固定高度、横向滚动、NeedsMe popover；1440/960 自适应 |

---

## 4. 验证

新增测试：

- `src/shell/workflowData.test.ts`（4）：阶段派生（discuss/plan/run/review/deliver/remember）、failed→run、cancelled→unknown 且无 CTA、NeedsMe 聚合/去重/空态/预算。
- `src/shell/WorkflowRail.test.tsx`（2）：六阶段、当前 `aria-current` + CTA、阶段点击回调、NeedsMe 展开/点击定位、unknown 无假 CTA、空 NeedsMe 无按钮。

回归：
```text
pnpm typecheck   # exit 0
pnpm build       # exit 0（415 modules；css 250.61 kB/gzip 30.48；js 1,242.92 kB/gzip 341.84）
pnpm test -- --testTimeout=10000  # exit 0（66 files / 656 tests）
```

> 注：仓库既有 watchdog 的 429 用例在默认 5s 全量并发下会偶发超时（单文件/单独用例均通过）；本轮用 `--testTimeout=10000` 完成 656/656 全绿，未改 watchdog 实现/测试。

---

## 5. 1440 / 960 截图

- `docs/team/t222-workflow-1440.png`：1440×900；六阶段常驻，当前“讨论”高亮，NeedsMe 计数 12（来自现有 watchdog alerts），PrimaryRail/Dock/Team 均保留。
- `docs/team/t222-workflow-960.png`：960×800；阶段条仍在顶部且不挤压主区，rail 折叠图标栏、Dock 单栏布局正常。

截图用当前 app + 现有 fixture（无任务、12 个 watchdog 告警）生成；NeedsMe 计数与顶部 watchdog 告警一致，证明没有第二套事实源。

---

## 6. 限制 / 后续

- 当前 stage 不区分“同一工作区多个并行任务”的细粒度：rail 只显示一个代表阶段与一个 focus task；完整列表仍在 Tasks/Runs。
- MergeQueue 通过现有 API 只读加载，未在 rail 内轮询；打开 MergeQueue/任务刷新时更新。
- NeedsMe 目前不聚合“等待人工问答/待审批”等 interactive 队列（这些仍由现有 Modal/状态负责），避免在本任务扩大范围。
- 未改 review/merge gate、权限、任务状态机、内核调度；无数据迁移。

---

## 7. 与既有入口的兼容

- 保留 Dock tabs/拆分、PrimaryRail、▦ 面板启动器、⌘K、Alt+1–6、深链、Settings。
- WorkflowRail 不注册全局快捷键，不拦截 Esc/Tab/Ctrl+K；NeedsMe popover Esc 只关闭自身。
- 960 下阶段 hint 收起、rail 横向滚动；主区/Dock 不因 rail 产生横向裁切。
