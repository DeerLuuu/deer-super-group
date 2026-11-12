# P0-8 R2 评审：面板渲染隔离（t267 / t265）

- **评审人**：ivy
- **基线**：`main 00bf167`；PR #41 / `feature/t265-perf-r2-panels` HEAD `631ee42`
- **范围**：PanelHost/Provider、panel domain deps、renderRef、Dock/PanelContentContext 移除、rail/Workflow/NeedsMe 共用 snapshot、R2 边界
- **方法**：静态代码 + 独立三命令；未修改生产代码
- **结论**：**needs_revision**；1 high + 2 low。R2 主边界成立，R1 token 隔离保持；但 `team` 面板 deps 漏 `settings`，Team 成员模型选择/标签会陈旧。

---

## 1. 独立验证

```text
pnpm typecheck  # exit 0
pnpm build      # exit 0（432 modules；css258.43 kB/gzip31.64；js1,280.49 kB/gzip354.15）
pnpm test       # exit 0（90 files / 742 tests）
```

- PR #41 OPEN/MERGEABLE；worktree clean。
- 已确认：App 不再向 DockShell 传 `renderPanel`；`PanelContentContext` 删除；DockPanelBody 直接渲染 `PanelHost`；Provider 按 key version store + `sameDeps` 比较；PanelHost memo + `useSyncExternalStore` 单 key。
- 已确认：`panelRenderRef.current = renderPanelContent` 在 App render 中更新；Provider layout effect 后 bump；late mount 读 latest；R1 token 测试仍过。
- 已确认：6 panel fixture 初次各 1 次；无关 deps 不 bump；messages 只 bump mailbox；agents bump tasks/team/mailbox；`panelHost.test` 使用生产 `buildPanelDeps`。
- 已确认：Dock/深链/rail/Workflow/NeedsMe 未改；无 R3/RefreshCoordinator/轮询/权限/gate/数据层/CSS 改动。

---

## 2. Findings

### F1 · `team` panel deps 漏 `settings`（high / P1）

**问题**：TeamDashboard 的成员模型标签与 AgentDialog 的模型下拉直接使用 `snapshot.settings.models/providers`：
- `TeamDashboard.tsx:526-527` 用 settings.models 解析成员 model；
- `TeamDashboard.tsx:597-600` 用 settings.models/providers 渲染 AgentDialog 模型下拉。
但 `buildPanelDeps` 的 `team` 数组（`src/shell/panel/panelDeps.ts:107-116`）只有 tasks/agents/runs/workspace/busy/scheduler/starmapFocus/createIntent，**没有 settings**。当 settings 的 models/providers 变化而 tasks/agents 等引用未变时，PanelHost 不会 bump team，Team 面板继续显示旧模型标签/旧下拉，用户在 Team→成员编辑里看不到新模型。

`panelHost.test` 的 fixture 有 settings，但测试只覆盖 messages/agents 变化，未覆盖 settings 变化；因此 t270 的“真实 deps”没有捕获该漏项。

**影响**：违反“面板只随自身域更新、无陈旧”的验收；Team 成员模型配置是真实数据消费，不是纯展示。
**验收句**：**settings.models/providers 变化时 team panel 必须 bump 并刷新成员模型标签/AgentDialog 下拉；panelHost test 用真实 buildPanelDeps 增加 settings-only 变化用例。**

### F2 · PanelHost 测试只挂 6 个 panel，未覆盖其余 domain（low / P3）

**问题**：`panelHost.test.tsx` 的 mounted 只有 chat/tasks/team/mailbox/context/watchdog；runs/board/polls/planDraft/settings 没有挂载断言，也没有 `buildPanelDeps` 对所有 panel 的 settings/workspace/selection 变化矩阵。R2 的 deps 表覆盖这些 panel，但测试未守住。

**证据**：`src/shell/panel/panelHost.test.tsx` 的 `mounted` 数组；`buildPanelDeps` 中 runs/board/polls/planDraft/settings 的定义无对应 render count 测试。
**验收句**：**至少为 runs/board/polls/planDraft 增加“本域变化 bump、其他域不 bump”的 fixture；settings 变化应同时覆盖 team（F1）与 settings 自身。**

### F3 · 无真实 Dock/rail/Workflow/NeedsMe 联动 fixture（low / P3）

**问题**：render isolation 使用纯 PanelHost + fixture，未挂真实 DockShell/rail/WorkflowRail/NeedsMe；N1/N3 只由静态边界与全量测试间接覆盖。对“rail/Workflow/NeedsMe 与 panel 同 snapshot/batch”没有直接 render/integration 断言。

**证据**：`panelHost.test.tsx` 直接 `<PanelHostProvider><PanelHost…/></...>`；`DockPanelBody`/DockShell 只在 DockShell 既有测试中覆盖；无 App+Dock 的 panel bump 集成。
**验收句**：**补一个真实 DockShell（或最小 DockPanelBody）集成 fixture，验证 panel deps bump 时只重绘目标 panel，同时 rail/Workflow/NeedsMe 仍读同一 snapshot（可用 render probe）。**

---

## 3. 验收映射

| 验收 | 结果 | 说明 |
|---|---|---|
| PanelHost/context/actions 边界可靠 | failed | Provider/version/renderRef/action latest 主路径通过；F1 team settings 漏 deps |
| 面板仅自身域更新，无陈旧/双源 | failed | messages/agents 分支正确；settings→team 会陈旧（F1） |
| rail/Workflow/NeedsMe 同步，Dock/深链无回退 | passed（代码/既有测试） | 同 App snapshot/renderRef；无 R3/轮询/权限/gate 改动；F3 为 low 集成证据 |
| 未混入 R3/gate/权限/数据层 | passed | PR 仅 App/Dock/PanelHost/deps/tests/docs |
| 三命令 | passed | 0/0/0；90/742 |
| 无越界 | passed | PR #41 OPEN/MERGEABLE；worktree clean；head 631ee42 |

---

## 4. 结论

**needs_revision**。R2 的 PanelHost/Provider/renderRef 边界和 6 panel 的单域 bump 已成立，R1 token 隔离未回退；但 **F1 是真实陈旧缺陷**：TeamDashboard 消费 settings.models/providers，而 team deps 没有 settings；settings 变化时 Team 面板不会刷新模型选择。建议补 team settings deps + panelHost settings 用例，并顺手补 F2/F3 的证据后复审。
