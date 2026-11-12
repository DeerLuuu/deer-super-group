# 首次提交引导卡移除 G10 · 最终集成验收（t439）

- **任务**：t439 — 最终集成 G10：首次提交引导卡移除
- **集成人**：sol
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/63（**MERGED**；head `05e6788`；squash merge `5bb7852`）
- **基线**：main `1a18bcb`（PR base）；合并时 main `8aae91a`；合并后 main `5bb7852`
- **结论**：**PASS**（按用户/Captain 的“直接删除”口径）。首次提交引导卡 JSX/文案/CSS/`isFirstCommit` prop 全部删除，无关闭按钮/无隐藏持久化状态；空仓库暂存/提交/忽略/刷新控件保留；G1/三档无回归；PR 已合并、本任务 worktree/branch 清理。

---

## 0. 验收摘要

| 验收项 | 结论 |
|---|---|
| 隐藏/持久化可追溯 | **PASS（口径说明）**：不是“隐藏按钮+持久化”，而是按用户要求直接删除；无隐藏状态/无 localStorage key 可追溯，删除本身可追溯（t436/t437/t438） |
| 独立三命令 | **PASS**：typecheck 0；build 0（458 modules）；clean main serial 145 文件/995 |
| G1/三档无回归 | **PASS**：G1 控件/写路径未改；1440/960/480 截图；walkthrough 三档无卡片/无横向 |
| 最终文档 + PR/合并/worktree | **PASS**：本文件；PR #63 MERGED `5bb7852`；本任务 worktree/branch 清理 |

---

## 1. 追溯链

| 阶段 | 任务/产物 | 结论 |
|---|---|---|
| 实现 | t436 PR #63 | 删除 `.git-first-commit` JSX、`isFirstCommit`、CSS；测试更新 |
| 验证 | t437 `git-first-commit-removed-verification.md` | PASS；附合同冲突说明 |
| 评审 | t438 `git-first-commit-removed-review.md` | pass（按 Captain 直接删除口径） |
| 集成 | t439（本文件） | PASS、合并、清理 |

---

## 2. 移除 / 控件保留

- `GitGraphPanel.tsx`：
  - 删除 `.git-first-commit` 整块 JSX（三步说明）；
  - 删除 `WorkingTree` 的 `isFirstCommit` prop 及调用点；
  - 无关闭按钮、无 localStorage 隐藏 key/状态。
- `gitGraph.css`：删除 `.git-first-commit` 与 `.git-first-commit strong` 规则；无死 CSS。
- `GitGraphPanel.test.tsx`：删除失效 guide 用例；空仓库测试断言：
  - 无「首次提交」文案；
  - 「尚无提交」空态仍存在；
  - 「提交（0 个文件）」保持 disabled。
- 空仓库仍保留：
  - staged/unstaged 分组、暂存/取消、全选/批量；
  - 提交标题/正文/提交按钮；
  - `生成 .gitignore`、刷新；
  - G1 CommitGuard/写锁/审计/错误重试。

---

## 3. G1 / 三档

真实 Electron 空仓库截图：

- `docs/team/t436-first-commit-removed-1440.png`：工作区 staged/unstaged、提交框、`.gitignore`，无首提卡；
- `docs/team/t436-first-commit-removed-960.png`：960 工作区，无卡片；
- `docs/team/t436-first-commit-removed-480.png`：480 三 tab/工作区，无卡片、无横向。

`docs/team/t436-walkthrough.json`：三档 `.git-first-commit=0`、无「首次提交」/三步说明、controls/workspace 存在、`scrollWidth=innerWidth`。

- G1 写通道/IPC/CommitGuard/工作区内容未改；仅 UI/CSS/测试/docs。
- 无 schema/权限/gate/依赖变更。

---

## 4. 验证命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：458 modules；index 334.73 kB / gzip 99.83；GitGraphPanel 47.30 / gzip 13.40；GitGraph CSS 19.95 / gzip 4.28；main 1.6MB/preload 13.5 |
| `pnpm test`（PR worktree，2 workers） | **exit 0**：144 文件/992 用例 |
| `pnpm test -- --testTimeout=20000 --maxWorkers=1`（干净 detached main） | **exit 0**：145 文件/995 用例（含已合并 G8） |

> 主工作区有并行 t443 worktree，默认 Vitest 会扫入 `branches/**`；集成使用干净 detached main checkout。主工作区 `.gitignore`/`.npmrc` 等本地修改为其他任务，本任务未提交。

---

## 5. 非阻塞项

| ID | 内容 |
|---|---|
| N1 medium | 旧 contract 写「关闭按钮/按 workspace 持久化」，与用户/Captain「直接删除」冲突；本实现按直接删除，无隐藏状态可持久化。建议归档合同文案口径 |
| N2 low | walkthrough `noGuide:false` 字段名与语义略拗口；不影响断言 |
| N3 low | 无独立键盘截图；G1/键盘测试保持 |
| N4 low | 主工作区并行 worktree 导致默认 test 污染；干净 checkout 全绿 |

---

## 6. 合并 / 清理

- PR #63 **squash merged** → main `5bb7852`。
- `pnpm branch:remove` 因 node_modules 锁失败；已 `git worktree remove --force branches/t436-git-first-commit-removed` + `git branch -D feature/t436-git-first-commit-removed` 完成清理。
- remote `feature/t436-git-first-commit-removed` 已删除。
- 集成临时 clean checkout 删除。
- `git worktree list`：主 worktree + 其他任务 t443；本任务清理完成。

---

## 7. 最终 AC

| AC | 证据 | 结论 |
|---|---|---|
| 隐藏/持久化可追溯 | 直接删除（无隐藏状态/持久化），t436/t437/t438 | PASS（口径说明） |
| 独立三命令 | typecheck 0 / build 0 / clean 145/995 | PASS |
| G1/三档无回归 | G1 控件未改；三档截图/无卡片/无横向 | PASS |
| 最终文档 + PR/合并/worktree | 本文件；PR #63 MERGED `5bb7852`；本任务 cleanup | PASS |

**集成结论：PASS，可交付。**
