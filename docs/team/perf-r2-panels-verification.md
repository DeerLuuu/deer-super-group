# P0-8 R2 面板渲染隔离 · 独立验证报告（t266）

- **任务**：t266 [verification] 独立验证 t265 P0-8 R2
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #41 `feature/t265-perf-r2-panels`，HEAD `2bb859c`（OPEN/MERGEABLE；worktree `branches/t265-perf-r2-panels`，clean）；未合并，未修改生产代码。
- **方法**：worktree 复跑三命令 + 读 PanelHost/DockShell/App deps/panelHost.test/docs + 逐 panel 消费数据核对。

---

## 1. 结论：**BLOCKED（不通过，needs revision）**

PanelHost/Provider/DockShell 的渲染隔离主体成立：6 panel 合成 fixture 证明无关 provider render 不触发 panel、单域变化只 render 该 panel；renderRef facade/late mount 读最新；R2 未混入 R3。

但 **`mailbox` 的 domain deps 漏了 `snapshot.agents`，会真实陈旧**：

- `MailboxView` 的 `MailboxComposeModal` 用 `snapshot.agents.map(...)` 生成收件人（`App.tsx:5001`）。
- `panelDepsByKey.mailbox` 只有 `[snapshot.messages, busy, selectedMessageId, createIntent]`（`App.tsx:3224`）。
- 新增/更新/删除成员只改变 `snapshot.agents`，不改变 messages/busy/selected/createIntent；Provider 不会 bump mailbox version，PanelHost 不 render，用户在已打开的发邮件弹窗中看到**旧收件人列表**。
- `panelHost.test` 只测合成 deps 的 mailbox `[1]→[2]`，没有覆盖真实 `panelDepsByKey`，因此漏掉此依赖。

**F1 blocker**：R2 合同“各 panel 只在自身域变化时更新、数据不陈旧”不成立。修复只需把 `snapshot.agents` 加入 mailbox deps 并补一条成员变化回归。

---

## 2. 命令（worktree HEAD `2bb859c`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 431 modules；css 258.43 kB (gzip 31.64)；js 1,278.67 kB (gzip 353.73)；electron main 1.5MB/preload 11.9kB |
| `pnpm test`（plain） | **1** | 1 个既有 5s timeout：`openai.test`；741/742 |
| `pnpm exec vitest run --testTimeout=10000` | **0** | 90 文件/742 用例全绿 |

---

## 3. 逐项

### 3.1 6 panel render count（PASS）

- `panelHost.test` 挂载 chat/tasks/team/mailbox/board/runs 6 个 PanelHost：
  - 初次各 1 次；
  - provider 无关重渲染（deps 元素引用不变）→ 6 个仍 1；
  - mailbox deps `[1]→[2]` → mailbox 2、其余 1；
  - renderRef latest + late mount 读最新。
- **边界**：测试用合成 deps，不是真实 `panelDepsByKey`，所以无法发现 F1。

### 3.2 各 panel 仅自身域变化更新/数据不陈旧（FAIL）

- `PanelHost` 通过 `PanelVersionStore` 单 key 订阅；Provider 在 layout effect 比较 deps，只有引用变化才 bump。
- **chat**：messages/turns/questions/input/view/busy/trajectory/context/agents/settings/overview 覆盖；token 不进入 App（R1），不会 bump。
- **tasks**：tasks/agents/workspace/selectedTask/selectedTaskId/trace/busy/filter/createIntent/scheduler/runs/action/watchdog/source 覆盖。
- **team**：tasks/agents/runs/workspace/busy/scheduler/starmapFocus/createIntent 覆盖。
- **runs**：tasks/runs/agents/scheduler/runs/trace/selection/action/source 覆盖；
- **planDraft**：draft/source/issues/busy/error/confirming/agents 覆盖。
- **context**：context/contextTaskId。
- **mailbox**：messages/busy/selected/createIntent；**缺 `snapshot.agents`**（F1）。
- **board**：boardEntries/agents/selectedBoard/createIntent。
- **polls**：workspace.id/agents/pollIntent。
- **watchdog**：snapshot/costs/selectedTaskId。
- **settings**：settings。
- 结论：除 mailbox agents 外，未发现其他明显漏项；**mailbox 发件收件人列表会陈旧**。

### 3.3 Dock/深链/rail/Workflow/NeedsMe 联动（PASS，N2 证据）

- DockShell 移除 `renderPanel` prop/PanelContentContext；`DockPanelBody` 直接 `<PanelHost panelKey={api.id}>`；布局/拖动/tab/键盘/reset/single reconcile 逻辑未改。
- Dock 切换/打开面板：PanelHost 首次/late mount 用最新 `renderRef`，不依赖 version 初始 bump。
- 深链 task 选中 → `selectedTaskId/selectedTask` 进入 tasks deps；任务任务切换会 bump。
- rail/openPanel 原路径不变；WorkflowRail/NeedsMe 仍由 App snapshot 派生，无第二数据源。
- 现有 `DockShell.test`/primaryRail/workflow/NeedsMe 测试全绿；**N2 low**：没有新增真实 Dock/深链/rail 联动集成测试，主要靠代码与既有测试。

### 3.4 props/context/actions 稳定（PASS）

- Provider context value 固定在 ref（store + renderRef），不随 App render 变；PanelHost memo 入参只有 panelKey。
- Panel 内容/动作从同一 `renderRef` 读取最新 App closure；无第二份 panel 数据源。
- 本地滚动/展开/表单状态留在 panel 组件内部；version bump 同 component type，不重置子状态。
- **N3 low**：App 每次 render 仍构造新的 `panelDepsByKey` 对象/数组；sameDeps 按元素比较，功能正确，但每 render 有分配成本，可后续稳定化。

### 3.5 1440/960/范围/R3（PASS）

- 无 CSS/布局改动；Dock 宽度/960 单列规则未改，沿用既有截图（**N4 low**：无新截图）。
- PR 只改 App/DockShell/PanelHost/test/docs；未改 kernel/git/memory/review/watchdog/electron/styles；无权限/gate/数据层/schema/依赖变更。
- 未出现 RefreshCoordinator/seq gap/轮询等 R3 代码；R3 未混入。

### 3.6 三命令（FAIL，既有 flake）

- typecheck/build 0；plain test 1 个既有 openai 5s timeout（741/742）；extended 742/742。
- 任务要求三命令通过；plain 命令本身未绿（F5 low，非 R2 回归，但状态失败）。

---

## 4. 发现

| ID | 级别 | 发现 | Required fix |
|----|------|------|--------------|
| **F1** | **blocker** | mailbox deps 缺 `snapshot.agents`；MailboxComposeModal 收件人来自 snapshot.agents（App.tsx:5001），成员变化时面板不 rerender，收件人列表陈旧；panelHost.test 只测合成 deps，未覆盖真实 panelDepsByKey | `mailbox: [snapshot.messages, snapshot.agents, busy, selectedMessageId, createIntent]`；补“agents 变化→mailbox 重渲染/收件人更新”测试 |
| F2 | medium | panelHost.test 使用合成 deps，未验证 App 真实 `panelDepsByKey`；正是 F1 漏检原因 | 导出/注入真实 deps 或加 App 级 panel fixture |
| F3 | low | Dock/深链/rail/Workflow/NeedsMe 无新增集成测试；逻辑未改 | 补一条 Dock 切换 + 深链选中回归 |
| F4 | low | 无新 1440/960 截图；无 CSS 变更 | 评审前人工抽查或补截图 |
| F5 | low | plain test 既有 openai 5s timeout；extended 742/742 | CI 单独超时/串行 |

---

## 5. 结论

- PanelHost/Provider/DockShell 的 R2 性能隔离主体成立：6 panel 合成证据、renderRef facade、单域 bump、无 R2/R3 混入、无 gate/数据层变更。
- **F1 阻塞**：mailbox 真实 deps 漏 `snapshot.agents`，成员变化时发件收件人列表陈旧，违反“各 panel 只在自身域变化更新、数据不陈旧”。
- PR #41 需先修 F1（建议 F2 同批）后重验；本次未修改生产代码。

*本次验证仅新增本报告。*
