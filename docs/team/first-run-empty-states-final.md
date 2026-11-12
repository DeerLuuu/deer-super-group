# 首用就绪 / 错误恢复 / 空态最终集成验收（t250）

- **任务**：t250 — 集成验收 P0-7：首用就绪、错误恢复与空态
- **实现链**：t247 实现 → t251 修复 Key/唯一 CTA → t252 独立复验 → t255/t257 写提交/刷新拆分 → t258 review pass
- **PR**：[#39](https://github.com/DeerLuuu/deer-super-group/pull/39) — **MERGED（squash）**
- **合并提交**：`cc9f0b8`（2026-11-12）
- **实现文档**：`docs/team/first-run-empty-states.md`
- **验证/评审**：`first-run-empty-states-verification.md`、`-verification-2.md`、`first-run-empty-states-review-4.md`
- **结论**：**PASS，可交付**；PR 已合并，t247 worktree/branch 已清理。

## 1. 结论

P0-7 首次使用与恢复体验已完成最终集成验收：

- **首用就绪**：从现有 snapshot 派生工作区/模型/Key/Mock/成员四项检查；未就绪显示 4 项清单 + 唯一 CTA（去设置模型/创建成员/开始对话）；Router 不计可执行成员；稍后折叠为 chip，不阻塞主界面。
- **错误恢复**：复用 `sanitizeErrorText` 分类 key/auth/quota/network/unknown；`ErrorRecoveryBar` 每类一个恢复动作（去设置/切模型/重试/详情）+ 关闭；`sk-*`/Bearer/Authorization 不泄漏。
- **写提交/刷新拆分**：`writeThenRefresh` 让 createTask/sendMessage 写成功即 committed；刷新/loadTrace 失败只提示“已创建/已发送，但刷新失败”，表单关闭；非幂等写不自动重试，避免重复创建/发送。
- **空态**：Chat=开始对话（聚焦 composer）；Team=仅 Router 时新建成员；Tasks=唯一新建任务；Memory/Mail 保留既有 CTA；不影响 WorkflowRail/NeedsMe。
- **术语**：任务交付批准/代码评审/合并确认在 aria+note 区分；review/merge gate 未改。
- **无新数据源/gate/权限/状态机变更**：全部复用现有 snapshot/task/run/review 状态。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| 首用四项检查/唯一 CTA | `src/shell/firstRunData.ts`；`FirstRunCard.tsx` | firstRunData 4 例；FirstRunCard 1 例；t252 |
| 未就绪 CTA（设置/成员/对话） | App `openSettingsSection`/openPanel | t251 SettingsView active=模型；t252 |
| Router 不计可执行成员 | firstRunData offline/Router 过滤 | firstRunData 4 例 |
| 错误分类 key/auth/quota/network | `errorRecovery.ts` | errorRecovery 3 例；真实 Key 文案 4 条 |
| 每类一个恢复动作 | `ErrorRecoveryBar.tsx` | ErrorRecoveryBar 3 例；t257 点击测试 |
| secret 脱敏 | shared `sanitizeErrorText` | errorRecovery 测试 sk-/Bearer；t252 |
| 写提交/刷新拆分 | `writeThenRefresh.ts`；Task/Mailbox compose | writeThenRefresh 2；TaskCompose 3；MailboxCompose 2 |
| 非幂等写不自动重试 | App writeThenRefresh/postError | retryActions 1；t258 |
| Chat 空态 | App Chat empty | 1440/960 截图；t252 |
| Team 空态（仅 Router） | TeamDashboard | t252；t245 修复 |
| Tasks 空态唯一 primary | App task detail | t251 静态 guard；t258 ghost 隐藏 |
| Memory/Mail 空态 | 既有 EmptyState | t252 回归 |
| 术语区分 | `ApprovalTerms.tsx` Review tab | ApprovalTerms 1；t252 |
| 1440/960 | FirstRun/空态布局 | `t247-first-run-1440.png`、`-960.png` |
| 无 gate/权限/状态机/数据层 | diff 无相关文件 | 85/727 回归；t258 review |

## 3. 独立验证（合并后 main）

工作目录：`S:\DeerSuperGroup`（main `cc9f0b8`；worktree 仅 main）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；427 modules
                 # js 1,274.03 kB / gzip 352.02
                 # css 258.43 kB / gzip 31.64
                 # electron main 1.5 MB / preload 11.9 KB
pnpm test        # exit 0；85 files / 727 tests
```

> 说明：PR worktree 与合并后 main 本次均一次全量通过 85/727；此前轮次出现既有 openai/watchdog 5s timeout，隔离/延长时间后全绿。该 flake 与本功能无因果关系，保留为 P1 测试稳定性项。

## 4. 1440/960、首用与恢复证据

1. **1440**：`t247-first-run-1440.png` — 4 项就绪清单 + 唯一 CTA，未阻塞主界面；错误恢复条与任务/对话可见。
2. **960**：`t247-first-run-960.png` — 单列布局，清单/CTA/空态无横向裁切。
3. **首用**：四项检查由 snapshot 派生；未就绪唯一 CTA；离线/Router 不算可执行成员；折叠 chip 保留入口。
4. **错误**：key/auth/quota/network/unknown 分类；每类一个恢复动作；真实 Key 文案（未配置/为空/missing/empty）→ 去设置 Key；sk-/Bearer 脱敏。
5. **写提交**：createTask/sendMessage 成功即 committed；refresh/loadTrace 失败只提示刷新失败，表单关闭；失败保留表单；非幂等写不自动重试。
6. **空态**：Chat/Team/Tasks/Memory/Mail 均有明确下一步；Tasks 详情唯一 primary 为“+ 新建任务”；Team 仅 Router 时新建成员。
7. **术语**：任务交付批准/代码评审/合并确认在 Review tab note+aria 区分，避免“批准”三义混淆。
8. **无回归**：primaryRail 10、WorkflowRail 3、narrowWindow 28、DockShell 4、deeplink 17、permission 44、approval 9/2、review 17 全绿；rail/Dock/⌘K/Alt/深链/Settings 保留。

## 5. 范围/兼容性检查

- PR #39 合并 26 文件：`src/App.tsx`、`src/TeamDashboard.tsx`、`src/SettingsView.test.tsx`、`src/shell/{firstRunData,errorRecovery,ErrorRecoveryBar,FirstRunCard,ApprovalTerms,writeThenRefresh,retryActions}*`、Task/Mailbox compose tests、styles、docs/截图。
- **无** `src/kernel/`、data store/事件、git/memory/review gate、权限/任务状态机改动；错误分类/首用检查均从现有 snapshot 派生，不新增数据源。
- Settings 打开模型分区为 UI 焦点；Settings 自身 dirty 守卫保留。
- 合并前 PR #39 OPEN/MERGEABLE/CLEAN，head `1142b87`（含 t252/t258 报告）；合并后 main `cc9f0b8`；t247 worktree 已移除，branch 已删除。
- 当前 main 有 4 个与 t250 无关的未跟踪 docs（dock-max-groups、narrow-window 系列，属其他任务）；t250 未删除/修改它们。

## 6. 遗留项（P1/低优先，不阻塞）

1. **真实 Electron 冒烟**：错误恢复/首用/960 键盘有组件/合同测试，缺新增真机截图；t258 N1 retryActions 仍偏静态 guard。
2. **compose 本地 double-submit**：依赖 busy/committed 状态，极端双击仍建议显式本地 guard（t258 N2）。
3. **错误分类边界**：未知英文变体（如新 provider 文案）可能落 unknown；需随 provider 补 fixture。
4. **术语 action aria**：note+aria 已区分三类批准；主按钮 aria 可进一步带作用域（t252 N4）。
5. **既有 5s flake**：openai/watchdog 偶发；建议统一提高慢测 timeout 或拆分 fake clock。
6. **无完整 App DOM E2E**：FirstRun/ErrorRecovery 以组件/纯数据测试为主；发布前补 Chromium 冒烟。

## 7. 合并/清理状态

| 项 | 状态 |
|----|------|
| PR #39 | MERGED（squash） |
| 实现 head / 文档 head | `7d79a1d` / `1142b87` |
| merge commit | `cc9f0b8` |
| main | `cc9f0b8`（+ 本报告提交） |
| t247 worktree | 已移除；清理时先终止占用路径的遗留 t253 Electron 冒烟进程，再由 `branch:remove` + 目录删除完成 |
| t247 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 最终三命令 | typecheck 0 / build 0 / test 85 files/727 |

**最终结论：PASS；首用就绪、错误恢复、写提交/刷新拆分、空态唯一 CTA 与术语区分均已完成集成。残余均为 P1 真机/测试稳定性/边界文案项，不阻塞交付。**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
