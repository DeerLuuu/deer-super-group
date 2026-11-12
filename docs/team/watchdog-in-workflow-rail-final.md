# 看门狗预算条并入顶部栏 G8 · 最终集成验收（t431）

- **任务**：t431 — 最终集成 G8：看门狗预算条并入顶部工作流栏
- **集成人**：sol
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/62（**MERGED**；head `1d204b1`；squash merge `8eadfc7`）
- **基线**：main `1a18bcb`；合并后 main `8eadfc7`
- **结论**：**PASS**。独立 `.watchdog-topbar` 行删除，预算/告警进入 `WorkflowRail`；点击/键盘/aria、三档折行、死 CSS 清理完成；watchdog 数据/事件/面板未改；PR 已合并、worktree/branch 清理。

---

## 0. 验收摘要

| 验收项 | 结论 |
|---|---|
| 独立行移除/顶部栏可用可追溯 | **PASS**：t428 实现 → t429 PASS → t430 review pass |
| 独立三命令 | **PASS**：typecheck 0；build 0（458 modules）；clean main serial 145 文件/996 |
| watchdog 数据/事件/面板无回归 | **PASS**：App 数据/加载/事件未改；点击 onOpen 打开 watchdog 面板；测试/截图 |
| 三档/a11y | **PASS**：1440/960/480 无横向；480 同 rail 折行约 71px；progressbar/aria-valuetext/告警 label/focus |
| 最终文档 + PR/合并/worktree | **PASS**：本文件；PR #62 MERGED `8eadfc7`；本任务 worktree/branch 清理 |

---

## 1. 追溯链

| 阶段 | 任务/产物 | 结论 |
|---|---|---|
| 实现 | t428 PR #62 | 删除独立 topbar；WorkflowRail optional watchdog；CSS 响应式/死 CSS |
| 验证 | t429 `watchdog-workflow-rail-verification.md` | PASS；N1–N4 |
| 评审 | t430 `watchdog-workflow-rail-review.md` | pass；无 blocker |
| 集成 | t431（本文件） | PASS、合并、清理 |

---

## 2. 独立行移除 / 顶部栏

- `App.tsx` 删除 `.watchdog-topbar` 整块 JSX 与 `BudgetBar` import；不再有独立的第二整行。
- `WorkflowRail` 新增可选 `watchdog`：
  - `spentUsd/limitUsd/ratio/softRatio/openAlerts/onOpen`；
  - 位于阶段条与「需要我处理」之间；
  - 无数据（`watchdogSnapshot=null`）不渲染该组，不占位。
- 预算点击、告警按钮点击均走 `openPanel("watchdog")`；告警按钮 `aria-label` 含未处理数量，`title` 同步。
- `BudgetBar` 原 progressbar/`aria-valuenow`/`aria-valuetext` 保留；`WorkflowRail` 组 `role=group aria-label="看门狗与今日预算"`；focus-visible 保留。
- 删除 `.watchdog-topbar` 相关媒体/reduced-motion 死 CSS；源码断言无 topbar。

---

## 3. 三档 / 数据回归

真实 Electron/CDP：

- `docs/team/t428-topbar-1440.png`：1440 顶部单行 rail，预算+告警+需要我处理同栏；
- `docs/team/t428-topbar-960.png`：960 隐藏预算长文字，无横向；
- `docs/team/t428-topbar-480.png`：480 同一 rail 折行约 71px，无独立第二行、无横向；
- `docs/team/t428-watchdog-open-1440.png`：点击打开 watchdog 面板。

- watchdog 数据/加载/刷新/事件域/面板未改；`getWatchdogSnapshot`/alert 操作/panel 保留；仅 UI 重组。
- 全量套件包含 watchdog service/UI、WorkflowRail、rail/needs、Chat/Dock 等。
- 无 schema/权限/gate/数据源/依赖变更；改动仅 `App.tsx`、`WorkflowRail.tsx`、CSS、测试/docs/截图。

---

## 4. 验证命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：458 modules；index 334.73 kB / gzip 99.83；TeamDashboard 46.43 / gzip 14.58；CSS 136.08 / gzip 23.18；main 1.6MB/preload 13.5 |
| `pnpm test`（PR worktree，2 workers） | **exit 0**：145 文件/996 用例 |
| `pnpm test -- --testTimeout=20000 --maxWorkers=1`（干净 detached main） | **exit 0**：145 文件/996 用例 |

> 主工作区有并行 t436 worktree，默认 Vitest 会扫入 `branches/**`；集成使用干净 detached main checkout。主工作区 `.gitignore`/`.npmrc` 等本地修改为其他任务，本任务未提交。

---

## 5. 非阻塞项

| ID | 内容 |
|---|---|
| N1 medium | 480 顶部 rail 折行约 71px（同栏单行，无独立第二行）；已截图为证 |
| N2 low | 无数据/事件专项测试；现有测试覆盖渲染/点击，事件域未改 |
| N3 low | 无 480 键盘截图；focus-visible/键盘由既有测试覆盖 |
| N4 low | 主工作区并行 worktree 导致默认 test 污染；干净 checkout 全绿 |

---

## 6. 合并 / 清理

- PR #62 **squash merged** → main `8eadfc7`。
- worktree `branches/t428-watchdog-workflow-rail` 删除。
- local/remote `feature/t428-watchdog-workflow-rail` 删除。
- 集成临时 clean checkout 删除。
- `git worktree list`：主 worktree + 其他任务 t436 worktree；本任务清理完成。

---

## 7. 最终 AC

| AC | 证据 | 结论 |
|---|---|---|
| 独立行移除/顶部栏可用可追溯 | t428/t429/t430 + §2–3 | PASS |
| 独立三命令 | typecheck 0 / build 0 / clean 145/996 | PASS |
| watchdog 数据/事件/面板无回归 | §3；数据/加载/事件未改；点击打开面板 | PASS |
| 三档/a11y | 1440/960/480 截图/无横向；progressbar/aria/focus | PASS |
| 最终文档 + PR/合并/worktree | 本文件；PR #62 MERGED `8eadfc7`；cleanup | PASS |

**集成结论：PASS，可交付。**
