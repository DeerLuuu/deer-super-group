# P0-8 R2 复验：mailbox agents 依赖与真实 deps（t271）

- **任务**：t271 [verification] 独立复验 t270
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #41 `feature/t265-perf-r2-panels`，HEAD `631ee42`（OPEN/MERGEABLE；worktree `branches/t265-perf-r2-panels`，clean）；未合并，未修改生产代码。
- **方法**：worktree 复跑三命令 + 读 panelDeps.ts/panelHost.test/App 调用 + 逐 panel deps 核对。

---

## 1. 结论：**PASS（通过，无 blocker）**

- t266 的 F1 已修：`buildPanelDeps` 的 mailbox deps 现包含 `agents`（`panelDeps.ts`）；`MailboxComposeModal` 收件人来自 agents，成员新增/修改/删除会 bump mailbox 并刷新收件人。
- t266 的 F2 已修：`panelDepsByKey` 抽为生产 `buildPanelDeps()`，App 调用；`panelHost.test` 使用真实 deps。
- 测试：messages-only → 仅 mailbox bump；agents 变化 → tasks/team/mailbox 按依赖 bump，chat/context/watchdog 不误触发；无关 deps 对象重渲染 → 6 panel 均不 render。
- Dock/深链/rail/Workflow/NeedsMe 逻辑未改；无 R3 混入；无权限/gate/数据层/CSS 改动；1440/960 沿用。
- 三命令：typecheck/build 0；plain test 仅既有 openai 5s timeout（741/742）；20s 超时全量 742/742。

---

## 2. 命令（worktree HEAD `631ee42`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 432 modules；css 258.43 kB (gzip 31.64)；js 1,280.49 kB (gzip 354.15)；electron main 1.5MB/preload 11.9kB |
| `pnpm test`（plain） | 1（既有 flake） | 1 个既有 openai 5s timeout；741/742 |
| `pnpm exec vitest run --testTimeout=20000` | **0** | 90 文件 / 742 用例全绿 |

---

## 3. 逐项

### 3.1 mailbox deps agents/收件人更新（PASS）

- `src/shell/panel/panelDeps.ts`：
  ```ts
  mailbox: [input.messages, input.busy, input.selectedMessageId, input.createIntent, input.agents]
  ```
- App 用 `buildPanelDeps` 生成 `panelDepsByKey`（`App.tsx:3144`），`agents: snapshot.agents`。
- `MailboxComposeModal` 的 recipients = `snapshot.agents.map(...)`（`App.tsx:5001`）；PanelHost version bump 后用最新 `renderRef` 重新渲染 MailboxView/Compose，收件人更新。
- **N1 low**：测试只断言 mailbox version bump（count 1→3），未直接渲染 Compose 收件人列表；但依赖链明确，属于测试面增强。

### 3.2 其他 panel 不误 rerender（PASS）

- `panelHost.test` 真实 deps fixture：
  - 初次：chat/tasks/team/mailbox/context/watchdog 各 1；
  - 无关 deps 对象重渲染：6 个均仍 1；
  - messages-only：mailbox 1→2，其余 1；
  - agents 新引用：tasks/team/mailbox 各 +1；chat（只依赖 chatRouter）、context、watchdog 不误触发。
- `mailbox` 断言 `deps.mailbox` 包含 `base.agents`。
- **N2 low**：测试未挂 runs/planDraft/board/polls/settings；这 5 个无本次改动，风险低。

### 3.3 真实 panelDepsByKey/无第二数据源（PASS）

- App 删除内联 `panelDepsByKey`，改用 `buildPanelDeps`；`PanelHostProvider` 接收同一对象，`PanelHost` 只按 key version 订阅。
- `renderPanelContent` 仍写入稳定 `panelRenderRef`；panel 数据/actions 来自同一 App render，无第二数据源。
- `panelDeps.ts` 生产实现可测试，避免 t266 的“合成 deps 漏检”问题。

### 3.4 Dock/深链/rail/Workflow/NeedsMe/范围（PASS，N3 low）

- 本次修复只改 deps/test；DockShell/PanelHost/App 行为未改（App 仅调用 buildPanelDeps）；Dock 切换/late mount/renderRef latest 继承 t265 测试。
- 深链 selectedTaskId、rail/openPanel、Workflow/NeedsMe 逻辑未改；既有 DockShell/primaryRail/workflow 测试全绿。
- 无 R3/RefreshCoordinator/轮询；无权限/gate/数据层/schema/CSS/依赖变更；1440/960 沿用。
- **N3 low**：没有新增 Dock/深链/rail 集成测试；依据既有测试与未改逻辑。

### 3.5 三命令（PASS，N4 low）

- typecheck/build 0；plain 仅 openai 5s timeout（741/742）；20s 超时 742/742。
- 既有 flake 非本 PR 回归；日志已在验证环境复现。

---

## 4. 发现（非阻塞）

| ID | 级别 | 发现 | 建议 |
|----|------|------|------|
| N1 | low | mailbox 测试只断言 version bump，未直接渲染 Compose 收件人列表 | 补一条 MailboxView+agents 变化 recipients 断言 |
| N2 | low | 真实 deps 测试只挂 6 panel；runs/planDraft/board/polls/settings 未入 fixture | 后续扩展 fixture |
| N3 | low | 无新增 Dock/深链/rail 集成测试 | 补一条联动回归 |
| N4 | low | plain test 存在既有 openai 5s 并发 flake；20s 742/742 | CI 单独超时/串行 |

---

## 5. 结论

**PASS**：t266 F1（mailbox agents）与 F2（真实 deps 测试）均已修复；其他 panel 不误触发、mailbox 域独立更新；Dock/深链/rail 未回退；无 R3/权限/gate/数据层变更；三命令最终 742 全绿（plain 既有 flake）。N1–N4 为非阻塞增强，不阻塞 PR #41 进入评审/合并。

*本次验证仅新增本报告，未修改生产代码。*
