# P1-5 任务头执行契约 + 任务/团队去重 · 最终集成验收（t340）

- **任务**：t340 — 集成验收 P1-5，最终集成 t337–t339
- **实现**：PR #50 / `feature/t337-execution-contract` @ `d86b89d`（base main `1e5f159`）
- **验证**：t338 独立验证 **PASS**（`docs/team/execution-contract-verification.md`）
- **评审**：t339 独立评审 **PASS**（`docs/team/execution-contract-review.md`）
- **PR**：[#50](https://github.com/DeerLuuu/deer-super-group/pull/50) — **MERGED（squash）**
- **合并提交**：`584d7cc`
- **实现文档**：`docs/team/execution-contract.md`
- **结论**：**PASS，已合并**；worktree 已清理，仅 main。

## 1. 结论

P1-5 已完成最终集成验收：

- **执行契约**：Task Workspace sticky 头新增 model/permission/FT/上下文 chips；契约投影仅 owner/agents/chatFullThrottle/trace，不猜未知状态：
  - 无 owner → 未分配；
  - owner 不存在 → 负责人不可用；
  - owner 无 model → 默认模型；
  - 无 permission → 未知；
  - FT 为会话级；
  - 上下文来自 trace。
- **跳转**：chips 只读；模型 → Settings「模型」；权限 → Team 并 `autoEditMemberId` 打开成员编辑（只触发一次）；原生 button 支持键盘/aria。
- **一致性**：Plan Draft 与 Task 头 owner 同源；Task FT 与 Chat composer 同用 `chatFullThrottle`；Chat composer 的 model/permission 是 Router 对话上下文，Task 头是任务 owner，语义边界已在文档标注。
- **去重**：Tasks/Team/Run 落同一 `selectedTaskId` + 单一 TasksView Task Workspace；成员 CRUD 仅在 Team；Settings 团队区只读默认模型 + 成员概览。
- **响应式**：1440/960/480 截图；480 `scrollWidth=480`，detail 398、chips 381；Dockview 窄窗宽度约束。
- 无 schema/权限/gate/任务状态机/数据层/依赖变更。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| 契约投影 owner/session/trace | `src/shell/executionContract.ts` | executionContract.test；t338 §契约；t339 |
| 四种 owner 状态不猜 | TaskContractChips | TaskContractChips.test；t338 |
| chips 只读/模型跳转 | TaskContractChips → Settings 模型 | t338/t339；App 级回归 |
| 权限 chip → Team 编辑 | `autoEditMemberId` 一次 | TeamDashboard.edit.test；t338 |
| Plan/Task owner 同源 | App selected task/owner 投影 | t338；t339 |
| Chat Router 语义边界 | Chat 面板标题/FT 会话级 | t338 N2；t339 |
| Tasks/Team/Run 去重 | selectedTaskId + 单一 TasksView | t338/t339 |
| 成员 CRUD 仅 Team | TeamDashboard；Settings 只读 | TeamDashboard.edit.test；t338 |
| 1440/960/480/aria | styles + 截图 | 480 scrollWidth=480；t338 |
| 无 schema/权限/gate/状态机/数据层 | diff 仅 UI/shell/tests/docs | PR diff；t338/t339 |

## 3. 独立复跑（合并后 main `584d7cc`）

工作目录：`S:\DeerSuperGroup`（仅 main）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；447 modules
                 # index 314.67 kB / gzip 93.81
                 # vendor-react 206.75 kB / gzip 64.81
                 # CSS index 129.63 kB / gzip 22.23
pnpm test -- --testTimeout=20000 --maxWorkers=2
                 # 120 files / 855 tests passed
```

> 默认 `pnpm test` 仍有既有 openai/watchdog/git 5s 并发 timeout；非本 PR 引入，CI 建议单独超时/串行。

## 4. 回归与范围

- **契约/跳转**：owner/session/trace 投影；model/permission/FT/上下文 chips；模型→Settings、权限→Team 编辑一次；键盘/aria 按钮；未知不猜。
- **一致性/去重**：Plan/Task owner 同源；Chat Router 与任务 owner 上下文分离；Tasks/Team/Run 同 `selectedTaskId`；成员 CRUD 仅 Team；Settings 只读团队概览。
- **响应式**：1440/960/480 截图；480 无横向，chips/detail 可读；Dockview 窄窗约束保持。
- **范围**：`src/App.tsx`、`TaskContractChips*`、`executionContract*`、`TeamDashboard*`、`SettingsView*`、`styles.css`、tests/docs；`src/SettingsView.test.tsx` 为测试-only 改动（无 Settings 生产逻辑扩大）。无 schema/权限/gate/任务状态机/数据层/依赖变更。
- **截图**：`docs/team/t337-execution-contract-1440.png`、`-960.png`、`-480.png`。

## 5. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #50 | MERGED（squash） |
| merge commit | `584d7cc` |
| main | `584d7cc`（+ 本报告提交） |
| 实现 worktree | 已移除（清理时终止遗留 t337-ui Electron） |
| 实现 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 合并后三命令 | typecheck 0 / build 0 / test 120 files/855 |

## 6. 遗留（P1 发布前可补，不阻塞）

1. **无 App 级 chip 全链路/键盘集成测试**：现为组件级 + 源路径覆盖（N1 medium）。
2. **Chat Router vs Task owner 语义**：文案/上下文边界已在文档标注，但无 UI 对照提示（N2 medium）。
3. **无 owner 权限 chip 仍可点**：无编辑对象时不产生操作，但可禁用（N3 low）。
4. **480 仅无 owner 截图**：有 owner/长 model/permission 的窄窗未逐屏（N4 low）。
5. **owner model 未与 settings 重校验**：契约不猜，但设置变更后的 owner model 一致性未重算（N5 low）。
6. **Settings 默认模型可编辑 vs 标题只读**：默认模型编辑仍属全局 Settings，成员表只读（N6 low）。
7. **既有 5s 并发 flake**：非本 PR；建议 CI 串行/提高慢测 timeout（N7 info）。

**最终结论：P1-5 PASS，PR #50 已 squash 合并到 main `584d7cc`；任务头执行契约 chips/跳转、Plan/Task owner 一致性、Tasks/Team/Run 去重与 Settings 只读团队概览均集成验证，1440/960/480/aria 无回归；无 schema/权限/gate/任务状态机/数据层变更；遗留仅发布前可补的 App 级 chip 测试/窄窗语义项。**
