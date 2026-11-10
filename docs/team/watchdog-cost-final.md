# 看门狗与成本系统 · 集成验收报告（t146）

- **任务**：t146 [integration] 集成验收：看门狗与成本（in scope：`src/`、`docs/team/`；out of scope：`dist/`、`dist-electron/`）
- **集成人**：max（QA / Release Reviewer，DeepSeek 替代 vale；模型路由 `deepseek-official/deepseek-flash`）
- **日期**：2026-11-10
- **评审链**：t144 实现 → t145 **needs_revision**（6 findings：handoff 敏感 diff、429 fallback、UI、hold 释放、rebuild）→ t157 repair-2 → t161 repair-3（provider cooldown/chain empty）→ t165 repair（provider failure window/retry 异常）→ **t166 review-round-3 verdict=pass**。
- **PR**：**#9** `feature/t144-watchdog-cost` → `main`，**MERGED**（merge commit `9a78a0d`，mergedAt 2026-11-10T00:38:19Z），由集成轮在 t166 pass 后执行 `gh pr merge 9 --squash`；未直接 push main。
- **清理**：`branches/t144-watchdog-cost` worktree 已按 Captain 指示移除（`pnpm branch:remove`），main 工作树干净。
- **验证**：main `9a78a0d` 实跑 `pnpm typecheck` / `pnpm build` / `pnpm test`；watchdog 23 专项 + 全量 42 文件/515 用例全绿。

---

## 1. 最终结论（4/4 通过）

| 验收点 | 结果 | 依据 |
|--------|------|------|
| t145 pass，t144 PR 已合并 | ✅ | t145 首轮 needs_revision；t157/t161/t165 修复后 **t166 review-round-3 pass**（最终独立评审门禁，与 t145 同一任务链）；PR #9 **MERGED** `9a78a0d`，main `bc9d05e→9a78a0d` |
| watchdog/cost 全链路可追溯 | ✅ | `src/watchdog/{signals,service,cost,handoff,store,events}.ts` + `src/shared/watchdog.ts` + IPC/preload/main + UI；23 个 watchdog 测试覆盖 hold/rebuild、handoff、预算、fallback/429、UI |
| typecheck/build/test 全绿 | ✅ | main `9a78a0d`：typecheck 0；build 0（403 modules，js 1,195.89 kB/gzip 328.03，css 228.53 kB/gzip 26.78，electron main 1.5mb/preload 10.8kb）；test 0（42 文件/515 用例） |
| `docs/team/watchdog-cost-final.md` 交付 | ✅ | 本文件 |

---

## 2. 评审/修复/合并流转

| 阶段 | 结果 |
|------|------|
| t144（sol，实现） | watchdog_schema 10 表、信号/干预、handoff、预算/成本、API/UI 基础；PR #9 open；473 tests |
| t145（复审） | **needs_revision**：F1 handoff 敏感 diff、F2 429 无自动 fallback、F3 UI 未挂载/窄窗、F4 hold 释放过宽、F5 rebuild 无事件重放等 6 findings |
| t157（repair-2） | 敏感 diff 按路径拆分/redact；429 → provider_quota + 冷却 + handoff + 新模型 Run；UI 挂载/ARIA/窄窗；hold reason 释放；rebuild schema repair；479 tests |
| t161（repair-3） | provider 级冷却/两次 429 `*`；链空全冷却 escalate；summary 脱敏；UI 证据；483 tests |
| t165（repair） | 成功 Run 重置 provider failure window；外部 recordProviderQuota；retryTaskWithModel 异常保留 handoff/escalation；同步 main review 冲突无标记；515 tests |
| t166（复审） | **pass**：F1–F3 修复、t161 通过项无回归；worktree clean、PR #9 mergeable |
| t146（集成） | 合并 PR #9 → `9a78a0d`；main 三命令；清理 t144 worktree；本报告 |

> **说明**：t145 是首轮评审（failed），最终门禁以 t166 review-round-3 **pass** 为准；没有绕过 repair/review 链。PR #9 合并前已同步 main（含 Poll/Review 等），mergeState CLEAN。

---

## 3. 交付映射（最终 main）

| 区域 | 文件/证据 | 交付要点 |
|------|-----------|----------|
| 状态/表 | `src/watchdog/store.ts` | 独立 `watchdog_schema` + 10 表；不新增/不写 kernel tasks/runs 列；hold 主键 `(task_id,reason,scope)`；durable cache/rebuild 语义 |
| 信号/干预 | `src/watchdog/signals.ts`、`service.ts` | L2 activity、5/10/15min、deadman、repeat/no_progress/error/token/waiting grace；nudge→pause+handoff+hold→fallback→switch member→human；autoInterventions≥2 禁自动（含 nudge） |
| Handoff | `src/watchdog/handoff.ts` | 摘要/files/diff stat/patch 引用/next step；先持久化/事件再 interruptRun；新 Run `run.started` 带 handoffId；敏感路径 .env/.ssh 只 [REDACTED]/safe stat |
| 预算/成本 | `src/watchdog/cost.ts`、`src/shared/models.ts` | ModelProfile 价格快照；final/provisional ledger（micro-USD/幂等）；final + `Run.costUsd` + `cost.recorded` 同事务；final+provisional+reservation 口径；task/agent/workspace/global soft/hard；启动前拦截/运行中暂停 |
| 降级/429 | `src/watchdog/service.ts` | fallback 链；provider/model 两级冷却；真实 429 两次写 provider `*`；链空/all cooling escalate + hold + critical + pauseScheduler；成功 Run 重置 failure window；retryTaskWithModel 异常保留 handoff |
| API/IPC | `src/shared/watchdog.ts`、`src/shared/ipc.ts`、electron main/preload | snapshot/costs/handoff/ack/resolve/releaseHold/setBudget/setFallback/health；workspace 反查/隔离；主进程 guard |
| UI | `src/watchdog/WatchdogPanel.tsx`、`src/App.tsx`、`src/RunHistory.tsx`、`src/shell/dock/panelRegistry.ts` | Dock watchdog 面板（默认关闭）、预算条、告警 banner、RunHistory handoff 卡；ARIA progressbar/alert/aria-live；900/760 窄窗；面板注册表/命令入口 |
| 内核集成 | `src/kernel/execution/kernel.ts`、`loop.ts`、`service.ts` | beforeStart 冷却/预算检查、hold/nextRunAt、run.started handoffId、CAS/lease/fencing 复用；不改变内核核心状态机 |
| 测试 | `src/watchdog/watchdog.test.tsx`（23 项） | stale pause+handoff+rebuild、max2、final/provisional 预算、敏感 diff、切换成员、429/fallback/两级冷却、链空、成功重置、retry 异常、workspace 隔离、UI |
| 文档 | `docs/team/watchdog-cost-implementation.md` | 实现/验证/边界/回滚；§7.3–7.5 修复记录 |

---

## 4. 最终验证（main `9a78a0d`）

### 4.1 三命令

| 命令 | 结果 | 关键输出 |
|------|------|----------|
| `pnpm typecheck` | ✅ 0 | `tsc --noEmit` 无错误 |
| `pnpm build` | ✅ 0 | 403 modules；js 1,195.89 kB (gzip 328.03)；css 228.53 kB (gzip 26.78)；electron main 1.5mb、preload 10.8kb；>500kB 警告（既有） |
| `pnpm test` | ✅ 0 | **42 文件 / 515 用例** 全部通过；watchdog 23，Review/Git/Poll/Memory/Kernel/Canvas 等既有全绿 |

### 4.2 全链路核对

- **hold/rebuild**：stale Run pause；handoff 在 run.failed 前写入；kernel rebuild 后 hold/auto/handoff 仍保留；schema 删除/损坏 repair 测试。
- **handoff**：摘要/patch 不泄露 .env/.ssh；先持久化再 abort；新 Run model override/handoffId。
- **预算**：final/provisional/reservation 计算；final 与 Run.costUsd/event 同事务；preStart hard budget 拒绝；soft 预算告警/暂停。
- **降级/429**：429→fallback→新模型；两次真实 429→provider `*`；同 model/provider beforeStart 拦截；链空/all cooling→escalation hold + critical；成功 Run 重置 failure window；retry 异常保留 handoff。
- **UI/ARIA/窄窗**：Dock watchdog 面板默认关闭；预算条/告警条/RunHistory handoff；progressbar/alert/aria-live；900/760 单列；组件测试。
- **回归**：42/515 包含 Git（56）、Review（29）、Poll、Memory、Kernel（43）、Canvas、Markdown、Deeplink、Permission/Approval；未发现副作用。
- **worktree/PR**：PR #9 MERGED；t144 worktree 已清理；main clean。

### 4.3 已知边界（Captain 已接受，不阻塞）

1. **完整 App DOM e2e / 真实 Electron 截图**：P1 manual；本环境无浏览器/窗口，组件测试 + 原生 ARIA/focus-visible 语义替代；发布前建议真机冒烟。
2. **价格/阈值设置页**：后续 UI 任务；当前 API/config 已具备。
3. **429 不强行创建新 Run**：遵守内核策略，只记录冷却/handoff；不绕过 scheduler。
4. **构建 >500kB**：js 1,195.89 kB（gzip 328.03），既有累积，建议后续 code-split。

---

## 5. 文件与变更记录

- **PR #9（已合并）**：24 文件、+6,087/−32；新增 `src/watchdog/` 8 文件、`src/shared/watchdog.ts`、UI/panelRegistry/styles、kernel loop/service/eventRegistry、IPC/preload/main、设计/实现文档；未改 `dist/`、`dist-electron/`。
- **t146**：新增 `docs/team/watchdog-cost-final.md`（本报告）；未修改生产代码。
- **合并**：PR #9 `9a78a0d`；main `bc9d05e→9a78a0d`；`branches/t144-watchdog-cost` 已清理。
- **评审链**：t144 → t145 needs_revision → t157 → t161 → t165 → **t166 pass** → t146 merge/integration。

---

*本报告为 t146 集成验收交付；4/4 通过，无 blocker。*
