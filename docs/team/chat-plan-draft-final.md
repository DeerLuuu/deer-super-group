# Chat→Plan Draft 可编辑 DAG 最终集成验收（t234）

- **任务**：t234 — 集成验收 P0-4：Chat→Plan Draft
- **实现链**：t230 设计 → t231 实现 → t235 入口/确认校验 → t236 独立复验 → t237 repair-round-2 → t239 repair-round-3 → t240 review pass
- **PR**：[#37](https://github.com/DeerLuuu/deer-super-group/pull/37) — **MERGED（squash）**
- **合并提交**：`6a1984a`（2026-11-12）
- **实现文档**：`docs/team/chat-plan-draft.md`；设计 `chat-plan-draft-design.md`
- **验证/评审**：`chat-plan-draft-verification.md`、`-verification-2.md`、`-review.md`、`-review-2.md`
- **结论**：**PASS，可交付**；PR 已合并，t231 worktree/branch 已清理。

## 1. 结论

P0-4 Chat→Plan Draft 已完成最终集成验收：

- **Chat 入口**：对话内「从这段对话规划」捕获 goal + 当前对话/composer/压缩摘要/overview，生成 source count/digest；超限/伪造在 preview+confirm 都零写。
- **Plan Draft Dock 面板**：非 Modal；显示 source/契约 chip；可编辑标题/描述/验收/依赖/owner/优先级/风险/unknown；增删/上移/下移；环/缺失/自依赖/空标题/无 owner/空验收就地提示。
- **零副作用 preview**：`previewPlan` 只读 planner/parse/validate；成功 preview 后 tasks/events 数量不变，确认前无 task/run。
- **确认事务/幂等**：`confirmPlan` 单事务创建整张 DAG（owner/deps/priority），`plan.confirm:<fingerprint>` 幂等；第二个 createTask 失败或 append 失败全回滚，tasks 零增量；cycle/high-risk 未 ack 零写。
- **取消/离开**：取消 discard、Dock close 保留 + launcher 恢复、entry replace/深链/workspace 切换统一确认；workspace reset 清空；晚到 preview 响应丢弃。
- **入口统一**：Tasks 三处规划/autoOpen、WorkflowRail plan、CommandPalette plan 全部到 Plan Draft；旧 `RouterPlanModal`/`window.deer.plan` UI 路径移除；不新增 PrimaryRail 入口。
- **无第二任务源**：复用现有 planner/parse、`tasks` 表、owner/priority/depends 列、`router.plan` 事件；无 PlanDraft 表/第二任务源；tasks.kernel 状态机/权限/review gate 未改。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| Chat 入口/ source 捕获 | `src/App.tsx`；`PlanDraftPanel`；`planDraftSession` | `chatTurnUi` 9 例（chat plan 入口）；`planEntryApp` 3 例；`PlanDraftPanel` 8 例 |
| source count/digest / 12k | `src/shared/planDraft.ts`；`kernel/service.ts` `previewPlan`/`confirmPlan` | shared 4 例；kernel planDraft 7 例（超限/伪造 digest 零写） |
| preview 零副作用 | `service.previewPlan` 只读 | kernel `previewPlan is read-only...`；tasks/events 数量不变 |
| 可编辑 DAG/校验 | `PlanDraftPanel.tsx`；shared validate | PlanDraftPanel 8 例（add/confirm/cancel、high-risk ack、issues describedby、focus） |
| 确认事务/回滚 | `service.confirmPlan` + `plan.confirm` 幂等 | kernel `creates a DAG once...`、`createTask fails midway`、`idempotency append fails` 零增量 |
| 同 key 重复确认 | `plan.confirm:<fingerprint>` + event 幂等 | kernel `replays the same key` 同 IDs/alreadyConfirmed |
| 环/高风险 ack | shared validate + kernel confirm | `rejects cycle/invalid... requires high-risk ack` |
| 取消/离开/恢复 | App `planDraftSession`、Dock close launcher | session 3 例；PlanDraftPanel 2 例；planEntryApp 3 例 |
| 入口统一 | App/WorkflowRail/CommandPalette/Tasks handlers | planEntryApp 3（无旧 UI 路径）；WorkflowRail/CommandPalette 测试 |
| focus/goal/owner/a11y | PlanDraftPanel；t239 | 首标题仅首次/重生成；patch 不抢焦；sourceChanged 禁 confirm；Router owner warning；describedby summary |
| 1440/960 | Plan Draft 两栏/单列 | `t231-plan-draft-1440.png`、`t231-plan-draft-960.png` |
| 无回归 | 不改 rail/Dock/深链/权限/gate | primaryRail 10、narrowWindow 28、DockShell 4、deeplink 17、permission 44、approval 9/2、review 17 |

## 3. 独立验证（合并后 main）

工作目录：`S:\DeerSuperGroup`（main `6a1984a`；worktree 仅 main）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；419 modules
                 # js 1,261.98 kB / gzip 347.94
                 # css 253.49 kB / gzip 30.93
                 # electron main 1.5 MB / preload 11.9 KB
pnpm test        # exit 0；73 files / 694 tests
```

> 说明：PR worktree 与合并后 main 本次均一次全量通过 73/694；此前轮次出现既有 openai/watchdog/git 5s timeout，隔离/延长时间后全绿。该 flake 与 Plan Draft 无因果关系，保留为 P1 测试稳定性项。

## 4. 1440/960、入口与零副作用证据

1. **1440**：`t231-plan-draft-1440.png` — Chat + Plan Draft 两栏，source/字符数/digest、契约 chip、任务编辑区可读。
2. **960**：`t231-plan-draft-960.png` — 单列布局，任务卡/确认区无横向裁切。
3. **入口统一**：Tasks 三处/autoOpen、WorkflowRail、CommandPalette 全部到 Plan Draft；`planEntryApp.test` 守卫旧 `RouterPlanModal`/`window.deer.plan` UI 路径不再出现。
4. **preview 零副作用**：成功 preview 后 tasks/events 数量不变；确认前无 task/run；取消/关闭不写 router.plan。
5. **确认幂等/回滚**：重复 key 同 IDs；第二个 createTask 失败、append 失败均 tasks 零增量；cycle/high-risk 未 ack 零写。
6. **source 伪造/超限**：undefined vs 空串、空 goal、服务端重算 count/digest、伪造/超限 preview+confirm 均零写。
7. **可访问性/焦点**：首标题仅 draft 首次/重新生成聚焦；普通 patch 不移动；增删移动消费 pendingFocus；confirm disabled 时 `aria-describedby=plan-draft-confirm-summary`；issues aria-live。
8. **无回归**：rail/Dock/⌘K/Alt/深链/Settings/权限/审批/review gate 均保留。

## 5. 范围/兼容性检查

- PR #37 合并 28 文件：`src/App.tsx`、`src/shell/{PlanDraftPanel,planDraftSession}*`、`src/shared/planDraft.ts`、`src/kernel/{service,planDraft.test}`、IPC/preload/main、Dock registry/shell、styles、tests、docs/截图。
- **无** review/merge gate、权限、任务状态机语义改动；`service.ts` 仅新增 plan draft preview/confirm 事务方法，复用 tasks 表与 router.plan 事件。
- 无 PlanDraft 表/第二任务源；legacy plan 保留但 UI 入口移除；tasks owner/priority/depends 复用既有列。
- 合并前 PR #37 OPEN/MERGEABLE/CLEAN，head `35504df`（含设计/验证/评审文档）；合并后 main `6a1984a`；t231 worktree 已移除，branch 已删除。
- 当前 main 有 4 个与 t234 无关的未跟踪 docs（dock-max-groups、narrow-window 系列，属其他任务）；t234 未删除/修改它们。

## 6. 遗留项（P1/低优先，不阻塞）

1. **真实 Electron 冒烟**：Dock close/深链/workspace 切换/outside focus 有 session/组件测试，但缺新增真机截图（t236/t239 残余）。
2. **Plan Draft 会话内恢复**：Dock close 保留草案，但应用重启不持久化；设计有意不做表，后续可评估会话存储。
3. **任务级契约 override**：owner/model/permission/FT/context/budget 目前只读 chip；任务级覆盖留 P1-5，避免假控件/数据层扩张。
4. **source/goal 边界**：超限 12k 阻断、空 goal SOURCE_EMPTY；更长对话需用户裁剪或后续摘要策略。
5. **既有 5s flake**：openai/watchdog/git 偶发；建议统一提高慢测 timeout 或拆分 fake clock。
6. **无完整 App DOM E2E**：PlanDraftPanel 用 react-test-renderer；发布前补真实 Chromium 冒烟。

## 7. 合并/清理状态

| 项 | 状态 |
|----|------|
| PR #37 | MERGED（squash） |
| 实现 head / 文档 head | `e29b604` / `35504df` |
| merge commit | `6a1984a` |
| main | `6a1984a`（+ 本报告提交） |
| t231 worktree | 已移除（`pnpm branch:remove t231-plan-draft`） |
| t231 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 最终三命令 | typecheck 0 / build 0 / test 73 files/694 |

**最终结论：PASS；Chat→Plan Draft 可编辑 DAG、零副作用 preview、事务/幂等/回滚确认、统一入口与 1440/960 回归均已完成集成。残余均为 P1 真机/持久化/契约覆盖项，不阻塞交付。**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
