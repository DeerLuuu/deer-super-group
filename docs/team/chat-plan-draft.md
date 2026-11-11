# Chat → Plan Draft 可编辑 DAG（t231 / P0-4）

- **任务**：t231 — 按 t230 设计与 Captain 裁决实现可编辑 Plan Draft
- **分支**：`feature/t231-plan-draft`（基于 main `53862c9`）
- **范围**：`src/App.tsx`、`src/styles.css`、`src/shell/`、`src/shared/planDraft.ts`、`src/shared/ipc.ts`、`src/kernel/service.ts`、`electron/main.ts`、`electron/preload.ts`、`docs/team/`
- **不做**：不改 review/merge gate、权限、任务状态机；不新增 PlanDraft 表/第二任务源；不自动运行/自动分配成员。

---

## 1. 用户流程

```text
Chat 输入目标（或已有最近 user message）
  → 「从这段对话规划」
  → 捕获 PlanSource（goal + 当前对话 + system 摘要 + workspace overview）
  → 打开 planDraft Dock 面板
  → previewPlan（只读 LLM/parse/validate）
  → 编辑任务/验收/依赖/owner/优先级/风险/unknown
  → 就地校验（环/缺失依赖/空标题/无 owner/空验收/超限）
  → 确认创建（单事务 DAG；高风险需 ack）
  → 进入 Tasks（不自动运行）
```

确认前 **不创建 task/run、不 append router.plan、不 refresh、不选任务、不 toast “已规划”**。

## 2. Captain 裁决落地

| 裁决 | 实现 |
|---|---|
| 逐任务 model/permission/FT | 只读契约 chip，由 owner 派生；本批不做逐任务编辑，留 P1-5 |
| owner 可空 | 校验为 warning，确认可继续；Tasks 中显示未分配，不自动选人 |
| 空验收 | warning + 明显提示，不阻塞 |
| Source 12k | `PlanSource.characterCount > 12000` → `SOURCE_TOO_LARGE`，阻断 preview；不静默截断；面板显示字符数与 digest |
| 草案不持久化 | React session state；关闭/取消即清空；无 PlanDraft 表 |
| High risk | `hasHighRiskTask`（删除/迁移/权限/密钥等）需勾选 ack；服务端再次检查 |
| 最多 12 任务 | `PLAN_MAX_TASKS=12`，超限 error，添加按钮禁用 |
| 原子/幂等 | `confirmPlan` 在 `store.withTransaction` 创建整张 DAG；`plan.confirm:<idempotencyKey>` 事件幂等；失败回滚 |
| 入口 | Chat「从这段对话规划」→ `planDraft` Dock 面板，非 Modal；确认后开 Tasks |
| 复用现有 | 同一 `ROUTER_PLANNER`/tasks 表/`router.plan` 事件；legacy `plan` 保留 |

## 3. 数据与 API

### 3.1 类型/纯校验 `src/shared/planDraft.ts`

- `PlanSource` / `PlanDraftTask` / `PlanDraft` / `PlanIssue` / `ConfirmPlanRequest`；
- `planDigest`（FNV-1a，仅用于 UI/idempotency 指纹）；
- `planSourceIssues`（空/超限）；
- `validatePlanDraft`（空 plan/空标题/优先级/owner warning/缺失 owner/空验收 warning/重复标题 warning/自依赖/缺失依赖/环/任务数）；
- `parsePlanDraft`（容错代码围栏 JSON；坏 JSON 抛 `PLAN_UNPARSEABLE`，不 fallback 单任务）；
- `planDraftFingerprint`（source digest + tasks；用于确认 idempotency key）；
- `planContractForTask`（owner → model/permission chip）；
- `hasHighRiskTask`。

### 3.2 服务端

- `AppService.previewPlan(workspaceId, source)`：只读 LLM + parse + validate；source 错误直接返回，无 store 写。
- `AppService.confirmPlan(request)`：重新校验；高风险 ack；事务内创建全部 task、写入 dependsOn/priority/owner，append 幂等 `router.plan`；重复 key 返回已有 tasks + `alreadyConfirmed:true`；失败回滚。
- IPC：`plan:preview` / `plan:confirm`；preload `previewPlan` / `confirmPlan`；legacy `router:plan` 保留。

### 3.3 UI

- `PlanDraftPanel`：来源摘要（消息数/字符数/digest/摘要）、任务卡（标题/描述/验收/owner/优先级/依赖/风险/unknown/契约 chip）、上移/下移/删除/添加、就地 issue、高风险 ack、取消/重新生成/确认。
- `planDraft` PanelKey 注册为 Dock 面板（defaultClosed），不新增路由/宽度列；1440 主组 tab、960 单栏。
- App：Chat 按钮捕获 source → preview；编辑重算 issues；确认 single-flight + 稳定 idempotency key；成功后刷新 Tasks、选中首任务、关闭草案；取消清空。

---

## 4. 验证

新增测试：
- `src/shared/planDraft.test.ts`（4）：source digest/空/12k、parse/坏 JSON、环/缺失/自依赖/owner/验收 warning、fingerprint 稳定性。
- `src/kernel/planDraft.test.ts`（4）：preview 成功零任务/事件副作用；source 超限零任务副作用；confirm 创建 DAG/owner/priority/deps + 同 key replay；cycle/高风险 ack 无写。
- `src/shell/PlanDraftPanel.test.tsx`（2）：来源/契约/添加/确认/取消；高风险/错误禁用确认。
- `src/kernel/chatTurnUi.test.tsx` 新增 Chat 规划入口点击测试。

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0（418 modules；css 253.49 kB/gzip 30.93；js 1,257.86 kB/gzip 346.39）
pnpm test -- --testTimeout=10000  # exit 0（71 files / 678 tests）
```

## 5. 1440 / 960 截图

- `docs/team/t231-plan-draft-1440.png`：Chat 入口 → planDraft Dock tab；2 个任务、来源 13 条消息/5972 字符/digest、owner warning、依赖、契约 chip、底部确认。
- `docs/team/t231-plan-draft-960.png`：960 单栏；任务卡单列、依赖/owner/优先级可编辑，底部 sticky 确认；不新增横向列。

截图使用 mock LLM fixture（确定性 2 任务）生成；真实 preview 仍走现有 provider。

---

## 6. 限制 / 后续

- 逐任务 model/permission/FT override 按裁决留 P1-5；当前 chip 只读来源契约。
- Source digest 由 UI 捕获；服务端请求只带 digest（无聊天正文）用于事件/幂等标识，完整 source 不落库。
- 高风险检测是启发式（删除/迁移/权限/密钥等关键词），最终 gate 仍由现有权限/审批负责。
- 草案无本地持久化；刷新/关闭即丢失，符合本批裁决。
- 未改 review/merge gate、权限、任务状态机、调度；无 schema 迁移/第二任务源。
