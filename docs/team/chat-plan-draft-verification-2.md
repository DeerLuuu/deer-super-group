# P0-4 复验：所有规划入口与确认校验（t236）

- **任务**：t236 [verification] 独立复验 t235
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #37 `feature/t231-plan-draft`，HEAD `2dd9519`（OPEN/MERGEABLE；worktree `branches/t231-plan-draft`，clean）；未合并，未修改生产代码。
- **方法**：worktree 复跑三命令 + 读 App/PlanDraftPanel/shared/kernel/tests + 检查入口静态守卫 + 故障注入用例。

---

## 1. 结论：**PASS（通过，无 blocker）**

- Tasks 三处「规划任务」、Tasks autoOpen plan、WorkflowRail plan CTA、CommandPalette plan 均统一到 Plan Draft；App 不再有 `window.deer.plan`/RouterPlanModal/setPlanOpen 旧路径（`planEntryApp.test` 静态守卫）。
- 打开/编辑/取消 Plan Draft 零 task/run/router.plan；`previewPlan` 只读（kernel test tasks/events 不变）；确认前无 task。
- Draft 字段/依赖/owner/契约/增删排序、环/缺失/自依赖/空标题/无 owner/空验收校验通过。
- `confirmPlan` 单事务创建 DAG；source 12k/digest 校验；create 第二个失败、append 失败均回滚零增量；同 idempotency key 返回同 IDs；双击保护。
- PlanDraftPanel goal/aria-live/focus/error、previewToken 取消在途、`draft-N` 稳定 id 均有实现/测试；无 gate/权限/状态机变更。
- 三命令最终全绿（72 文件/684 用例）；首轮负载下 8 个既有 5s timeout，最终全量通过（N5）。

发现 2 项 medium + 3 项 low（§4），不阻塞本轮通过。

---

## 2. 命令（worktree HEAD `2dd9519`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 418 modules；css 253.49 kB (gzip 30.93)；js 1,257.79 kB (gzip 346.58)；electron main 1.5MB/preload 11.9kB |
| `pnpm test`（最终） | **0** | **72 文件 / 684 用例**全绿；planDraft 7、PlanDraftPanel 2、planEntryApp 2、workflowStageNavigation 2、CommandPalette 2 |
| `pnpm test`（首轮） | 1（环境 flake） | 8 个既有 5s timeout（openai/watchdog/git 等）；extended/最终全量 684/684 |

---

## 3. 逐项

### 3.1 入口统一/零副作用（PASS）

- `tasksAutoOpenAction("plan") === "planDraft"`；`workflowStageNavigation("plan") === {panel:"planDraft"}`；`CREATE_TARGET_TAB.plan="tasks"`；Tasks 三处按钮/autoOpen → `onPlanDraft`。
- `planEntryApp.test` 断言 App 源码不含 `window.deer.plan`、`RouterPlanModal`、`setPlanOpen(true)`，含 `onPlanDraft`；旧 Modal/handlePlan UI 已移除。
- `handlePlanDraftEntry` 只构建 source + 打开 panel；`previewPlan` 只读；kernel preview test tasks/events 计数不变；取消清空；无 task/run/router.plan。
- 任务页/Workflow/CommandPalette 入口在有 chat source 时 preview；无 source 时 panel 显示 goal 输入，用户编辑后再生成；无隐藏建单。

### 3.2 Draft/校验（PASS）

- PlanDraftPanel 可编辑 title/description/acceptance/depends/owner/priority/risks/unknowns；契约 chip 只读；增删/上下移；remove 清理依赖。
- `validatePlanDraft` 覆盖空 plan、空 title、priority、重复 title、空 acceptance、无 owner warning、owner 不存在、自依赖、缺失依赖、cycle；App 每次编辑重算；`canConfirm` 要求 errors=0 + 高风险 ack。
- source 空/超过 12k 阻断；UI 显示字符数/digest；kernel `confirmPlan` 再次检查 `planSourceIssues` + `source.digest===sourceDigest`。

### 3.3 确认/幂等/回滚（PASS）

- `confirmPlan` 事务内 `createTask` 全量、写 dependsOn/priority/owner、`appendEventIdempotent` `router.plan`；同 key 返回 existing tasks + `alreadyConfirmed`；双击/重复调用的同 IDs 测试通过。
- 故障注入：第二个 `createTask` 失败、最终 append 失败均断言 tasks 零增量；cycle/high-risk 未 ack 在事务前抛错、零写入。
- 成功后 App refresh/选首任务/关 planDraft/开 Tasks/toast；失败 planError 内联、草案保留。
- **未覆盖**：真实 IPC 超时/客户端取消的并发 confirm；N4 low。

### 3.4 aria/focus/cancel preview/id（PASS，边界 N3）

- PlanDraftPanel：goal textarea aria-label、source、`aria-live` status、error role=alert、issue 列表；首个 title focus effect（`busy=false && draft.tasks.length`）；`firstTitleRef`。
- `handleCancelPlan` 清 source/draft/issues/error + `planPreviewTokenRef.current +=1`；`loadPlanPreview` token 校验；goal 修改也 token++。
- `addTask` 用 `draft-N` 扫描避重；稳定 id。
- N3 low：issues 列表无 `aria-describedby`/aria-live；增删后 focus 统一回第一个 title（新任务不一定获得焦点）；依赖/排序无专门键盘 e2e。
- N4 low：`ack` 本地 state 不随 source/draft 变化重置；新草案高风险可能沿用旧勾选（confirm 仍服务端校验）。

### 3.5 兼容/范围（PASS）

- planDraft 注册 Dock 面板（defaultClosed、minWidth 560、routeTab null）；PrimaryRail 未新增；TABS 未变；Dock/WorkflowRail/CommandPalette 入口统一。
- PR #37 未改 review/merge gate、权限、任务状态机、Dock schema；72/684 全绿。
- PR HEAD `2dd9519`；worktree clean；OPEN/MERGEABLE。

---

## 4. 发现（非阻塞）

| ID | 级别 | 发现 | 建议 |
|----|------|------|------|
| N1 | medium | `openPlanDraft(preview=false)` 不递增 `planPreviewTokenRef`；若旧的 Chat preview 仍在途（随后清空 chat 再从 Tasks/Workflow 打开空 source），旧响应可能回填旧 draft，出现 source 与 draft 不一致，确认可建旧任务 | openPlanDraft 总是先 `planPreviewTokenRef++`/取消在途；补“旧 preview 晚到不覆盖新 entry”测试 |
| N2 | medium | `planSourceFromChat(goalOverride)` 用 `goalOverride?.trim() || chatInput...`，用户把 goal 清空时回退到 composer/最后 user，无法清空目标 | 区分 `goalOverride === undefined` 与空串；空串应保留空目标并显示 SOURCE_EMPTY |
| N3 | low | issues 无 aria-live/aria-describedby；增删任务后 focus 统一回首个 title；依赖/排序无键盘 e2e | 补 a11y/focus 回归 |
| N4 | low | `ack` 不随 draft/source 重置；新草案可能沿用旧高风险勾选 | draft/source 变化时 reset ack |
| N5 | low | 首轮默认 5s 全量出现 8 个既有 timeout，最终 684/684；非本功能 | CI 对脆弱测试单独超时/串行 |

---

## 5. 结论

**PASS**：t232 的 F1/F2 已修复——所有 UI 规划入口统一 Plan Draft，无旧直接建任务路径；source 12k/digest、事务回滚、幂等、double-click、aria/focus、previewToken、稳定 id 均有实现/测试；三命令最终全绿（72/684）。N1/N2 为边界健壮性改进，建议后续修复，不阻塞 PR #37 进入评审/合并流程。

*本次验证仅新增本报告，未修改生产代码。*
