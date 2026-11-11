# 窄窗 Dock 自适应 · 最终集成验收（t197 / P0-1）

- **任务**：t197 — 集成验收 P0-1：窄窗 Dock 自适应
- **集成人**：sol（Systems Engineer）
- **日期**：2026-11-12
- **基线**：main `f1f3f9a`（PR #33 squash merge 后；其 base `3596f17` 已包含 P0-6 / PR #32 的安全与 Modal 修复）
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/33（**MERGED**，head `6a32f27`，squash merge `f1f3f9a`）
- **结论**：**PASS**。P0-1 实现/验证/复审链路完整；三命令独立复跑全绿；960/900/760 真实 Electron 截图与 metrics 无横向溢出；侧栏折叠/手动展开/深链/Dock/快捷键/Modal/权限无回归。PR 已合并，worktree/branch 已清理。

---

## 0. 验收结论摘要

| 验收项 | 结论 |
|---|---|
| P0-1 实现/验证/评审可追溯 | **PASS**：t194 → t195 → t196（needs_revision F1/F2）→ t212 → t214 → t215（PASS）→ t197 |
| 独立 typecheck/build/test | **PASS**：0 / 0 / 61 文件 631 用例 |
| 960/900/760 截图与测试 | **PASS**：15 张 t212 真实 Electron + 3 张 t214 expanded + 11 张 t194；metrics `overflowX:false`；测试 narrowWindow 28 + DockShell 3 |
| 侧栏折叠/手动展开/宽屏恢复 | **PASS**：默认 auto collapsed 56；expanded 960/900/760 → 394/334/194，Dock 560；preferred 不在窄窗落盘 |
| 深链/Dock/快捷键/Modal/权限 | **PASS**：全量套件绿；变更未触及 `src/kernel`/`permission`/`approval`；t215 复验 |
| 最终文档 | **PASS**：本文件 |
| PR/合并/worktree | **PASS**：PR #33 MERGED；worktree 删除；local branch 删除 |

---

## 1. 追溯链（t194–t197）

| 阶段 | 任务/报告 | 结论/产物 |
|---|---|---|
| 实现 | t194（ray） | `selectVariant(dockWidth, windowWidth)` ≤960 强制 single；Team `within`；侧栏边沿自动折叠；tasks/team 容器查询；`narrowWindow.test` 19 例；11 张 Edge headless 截图 |
| 独立验证 | t195（noor） | 初版单栏/within/自动折叠通过；但只测纯函数，未覆盖 App 拖拽序列、未扣 6px resizer；为 t196 提供反向证据 |
| 首轮评审 | t196（aria） | **needs_revision**：F1 窄窗拖拽写回 preferred；F2 minWidth 漏算 6px resizer/sash；F3 resize 时序；F4 old single 存档；F5 证据限制 |
| repair-2 | t212（ray） | preferred/displayed 分离；`SIDEBAR_RESIZER_WIDTH=6`、`MIN_SPLIT=924`；Dock 实测宽度 + rAF；`reconcileSingleLayout` 3 例；真实 Electron 15 张截图/metrics |
| repair-3 | t214（ray） | displayed 防御性 clamp；全宽度预算 760/900/960/1000/1100/1440=194/334/394/434/480/480；960/900 expanded→760 序列；200% 口径明确 |
| 复审 | t215（aria） | **PASS**；仅 N1 证据口径/N2 CDP 真机手感两项 low，不阻塞 |
| 集成 | t197（sol） | 本文件；独立复跑三命令、截图目视复核、范围检查、合并/清理 |

> 全部实现/测试/评审报告：`narrow-window-layout.md`、`narrow-window-verification.md`、`narrow-window-review.md`、`narrow-window-review-2.md`、`narrow-window-review-3.md`。

---

## 2. PR / 基线 / 范围

- **PR #33**：`feature/t194-narrow-window-layout` → `main`，**MERGED**（squash commit `f1f3f9a`）。
- **提交链**：`3602cfe`（t194）→ `208e7d3`（t212）→ `6a32f27`（t214）；PR head 与 main squash 内容一致。
- **基线**：`3596f17` 已含 P0-6（PR #32，merge `d12d7ab`）的安全/Modal 修复；PR #33 的 merge-base = `3596f17`，无落后/无冲突。
- **PR diff 范围**（40 文件）：
  - 生产：`src/App.tsx`、`src/shell/dock/DockShell.tsx`、`src/shell/dock/narrowWindow.ts`、`src/shell/dock/panelRegistry.ts`、`src/styles.css`；
  - 测试：`narrowWindow.test.ts`（28）、`DockShell.test.ts`（3）；
  - 文档/截图：窄窗布局/验证/评审、t194/t212/t214 PNG 与 metrics。
- **未改**：`src/kernel/`、`src/git/`、`src/memory/`、`src/review/`、`electron/`（Dock 变体与侧栏是 renderer/UI 层）；权限/审批/执行语义无变化。

---

## 3. 独立命令复跑

### 3.1 PR head（worktree `branches/t194-narrow-window-layout` @ `6a32f27`）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：409 modules；js **1,231.56 kB / gzip 338.31**；css **246.17 kB / gzip 29.72**；electron main 1.5MB、preload 11.7kB |
| `pnpm test` | **exit 0**：**61 文件 / 631 用例**（narrowWindow 28 + DockShell 3；deeplink/Modal/permission/approval/kernel/git/review/watchdog/memory 等全绿） |

### 3.2 合并后 main（`f1f3f9a`，worktree 清理后）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：409 modules；js 1,231.56 kB/gzip 338.31；css 246.17/29.72 |
| `pnpm test` | **exit 0**：**61 文件 / 631 用例** |

> 说明：合并后第一次在 main 跑测试时，t194 worktree 仍存在，Vitest 把 `branches/t194-...` 的测试再次扫描进来（122 文件/1262 用例，重复资源导致 13 失败）；删除 worktree 后独立复跑 61/631 全绿。这不是代码回归，最终证据以 worktree 清理后的 main 为准。

---

## 4. P0-1 逐项落地核对

### 4.1 单栏 / Team within

- `selectVariant(dockWidth, windowWidth)`：窗口 ≤960 强制 `single`；非 single 需 Dock ≥ `MIN_SPLIT_DOCK_WIDTH=924`（Tasks 560 + sash 4 + Team 360），否则 single。
- `panelInsertDirection(single, team)` 在 single 返回 `within`；`DockShell` single 下所有面板 within；旧 single 右分栏由 `reconcileSingleLayout` 收敛到主组 tab（3 例测试）。
- 截图：`t212-electron-960/900/760-team.png` 显示 Team 作为主组 tab、无独立右栏；`t194-wide-1440-team.png` 保持 wide 右组。

### 4.2 侧栏折叠 / 手动展开 / 恢复

- 初始窄窗/宽→窄边沿自动折叠为 56px 图标 rail；窄内 resize 不覆盖手动展开。
- expanded 预算：`sidebarMaxWidth = min(480, max(180, window−560−6))` → 760/900/960/1000/1100/1440 = 194/334/394/434/480/480。
- preferred/displayed 分离：窄窗拖拽只改 displayed，`commitSidebarWidth` 返回 `persist:false`；离开窄窗恢复 preferred；960→900→760 expanded 实测 394→334→194，Dock 始终 560，`overflowX:false`。
- 截图/metrics：`t214-electron-{960,900,760}-expanded-tasks.png`、`t214-electron-metrics.json`。

### 4.3 Tasks minWidth / 容器查询

- 所有窗口扣除 `SIDEBAR_RESIZER_WIDTH=6`；非 single 另扣 `DOCK_SASH_WIDTH=4`；实际 Dock 读取 `getBoundingClientRect` + rAF 延后一帧，避免旧 `dockWidth` 重建。
- single 下 Tasks 560 声明宽度在正常窗口保持；960@200%（480 CSS）等极端场景用 `effectivePanelMinWidth` 降级 + `@container tasks-panel (max-width:640px)` 单列，避免横向裁切。
- 960/900/760 tasks 截图显示列表+详情均可读，无横向滚动；760 expanded 详情在 560 Dock 内滚动而非裁切。

### 4.4 旧布局/回归

- `reconcileSingleLayout`：旧 single right-split Team → 移入主组 tab；active 保持；wide/同组不动。
- 深链 `#/tasks`/`#/team`/`#/chat` 在 960/900/760 截图正常；Dock tab/快捷键/Modal/权限套件全绿。
- 与 P0-6 的 `Modal`/`root inert`/toast 层无冲突（PR base 包含 `d12d7ab`；变更未改 Modal）。

---

## 5. 三档截图与目视复核

### 5.1 文件清单

- **t212 真实 Electron（15）**：1440/1100/960/900/760 × chat/team/tasks + 200%（720×450 CSS @DPR2）chat/team/tasks；`t212-electron-metrics.json` 全部 `overflowX:false`。
- **t214 expanded（3）**：960/900/760 手动展开 tasks；`t214-electron-metrics.json` 记录 sidebar 394/334/194、dock 560、overflowX false。
- **t194 辅助（11）**：960/900/760 chat/team/tasks + 760 expanded + 1440 对照（Edge headless，作为补充基线）。

### 5.2 独立目视结果（本次集成）

- **960**：默认 sidebar 56、single；Team 为主组 tab；Tasks 列表+详情在 898 Dock 内并排可读；expanded 后 sidebar 394、main 560，任务详情仍可读，无横向裁切。
- **900**：默认 sidebar 56、single；expanded 334/main 560；Tasks 筛选 chips 换行但按钮可点，无横向滚动。
- **760**：默认 sidebar 56、single；expanded 194/main 560；Tasks 单列容器查询生效，详情纵向滚动，主操作（规划/新建/发送）可见；无横向滚动。
- **1440/1100**：wide/medium 与 Team 右组保持；1100 侧栏自动折叠、Dock 1038、medium 右组，与 t215 验算一致。
- **200%**：默认 1440×900 窗口的 720 CSS viewport 截图可读；960@200%（480 CSS）仅单测降级，不作为 visual pass。

### 5.3 N1（t215 low）复核

t215 观察到 t214 960/900 expanded 截图的侧栏“视觉约 196px”与 metrics 394/334 不一致。本次集成逐张目视并对照 metrics：

- 960 expanded 侧栏实际约占左侧 394px；900 expanded 约 334px；760 expanded 约 194px；
- `t214-electron-metrics.json` 的 `metrics.sidebarWidth` 分别为 394/334/194，`dockWidth=560`，与截图一致；
- `state.sidebarWidth:56/collapsed:true` 是截图前状态快照，不是截图实际 DOM 值；N1 为取证口径问题，**不构成视觉/代码缺陷**。
- 结论：N1 不阻塞；建议若再做报告截图，统一 `state` 与 `metrics` 采样时点（P1 manual）。

---

## 6. 回归与权限检查

- 全量 61/631 通过，覆盖：deeplink、DockShell、narrowWindow、Modal/modalStack/CommandPalette、permission（44）、approval（9+2）、execution（43）、Git/merge queue、memory、review、watchdog、canvas、chat 等。
- 变更文件不含 `src/kernel/`、`src/git/`、`src/memory/`、`src/review/`、`electron/`；无权限/审批/执行/调度/tool policy 改动。
- P0-6 安全/Modal 修复在 PR base `3596f17`（`d12d7ab`）之上；窄窗改动只影响 renderer 布局/侧栏/Dock，未触碰 secret sanitizer / Modal stack。
- PR #33 无冲突、squash merge 后 main clean。

---

## 7. 已知低优先/后续

| ID | 内容 | 处理 |
|---|---|---|
| N1 | t215 标注的 state/metrics 采样口径（已复核不阻塞） | 若重拍报告统一采样；非代码 |
| N2 | CDP viewport emulation，非 OS 物理 resize；鼠标拖拽手感未注入 | 发布前 Electron 真机拖拽/键盘冒烟（P1 manual） |
| N3 | 960@200%（480 CSS）低于 Tasks 560；当前 minWidth 降级 + 容器查询单测；视觉 pass 用 1440@200% | 若产品要求 960@200% 仍 560，纳入 P1-4 a11y/字号 |
| P1 | watchdog 历史 5s timing flake | 与本次无关；全量复跑绿，继续观察 |
| P1 | 旧 single 存档 reconcile 用 fake dockview API | 真实 Electron 冒烟已覆盖默认/截图；旧存档真实路径可后续 |

---

## 8. 合并与清理

- PR #33 **已 squash merge** 到 main，merge commit `f1f3f9a`。
- `branches/t194-narrow-window-layout` worktree 已删除。
- local branch `feature/t194-narrow-window-layout` 已删除（`pnpm branch:remove`）。
- remote branch `origin/feature/t194-narrow-window-layout` 已删除（PR squash merge 后清理）。
- 最终 main：`f1f3f9a` + 本文件提交；`git worktree list` 仅主 worktree。
- 交付报告：本文件 `docs/team/narrow-window-layout-final.md`。

---

## 9. 最终验收

| AC | 证据 | 结论 |
|---|---|---|
| P0-1 实现/验证/评审可追溯 | t194 → t195 → t196（F1/F2）→ t212 → t214 → t215 PASS → t197；报告链完整 | PASS |
| typecheck/build/test 独立通过 | PR head 与 clean main：0/0/61 files 631 tests；build 409 modules | PASS |
| 960/900/760 截图/测试 | 15+3+11 张；metrics overflowX=false；narrowWindow 28、DockShell 3；目视无裁切 | PASS |
| 侧栏/深链/Dock/权限无回归 | expanded 394/334/194、Dock 560；deeplink/modal/permission/approval/execution 全绿；无 kernel/permission diff | PASS |
| 最终文档 | 本文件 | PASS |
| PR/合并/worktree | PR #33 MERGED f1f3f9a；worktree/local branch 已清理 | PASS |

**集成结论：PASS，P0-1 可交付。**
