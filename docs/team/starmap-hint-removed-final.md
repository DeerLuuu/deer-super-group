# 星图提示条移除 G13 · 最终集成验收（t457）

- **任务**：t457 — 最终集成 G13：移除星图底部提示条
- **集成人**：sol
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/60（**MERGED**；head `2a73888`；squash merge `41554ce`）
- **基线**：main `0332b91`；合并后 main `41554ce`
- **结论**：**PASS**。`.star-hint` JSX/CSS 与 TeamDashboard 重复小字已彻底移除，无占位/死 CSS；`?` 帮助、`.sr-only`、画布快捷键/指针、G6 单击/双击/Ctrl+Enter/浮窗路径保留；三档无横向；PR 已合并、本任务 worktree/branch 清理。

---

## 0. 验收摘要

| 验收项 | 结论 |
|---|---|
| 移除/帮助保留可追溯 | **PASS**：t454 实现 → t455 PASS → t456 review pass |
| 独立三命令 | **PASS**：typecheck 0；build 0（455 modules）；clean main serial 137 文件/962 |
| G6/三档无回归 | **PASS**：G6 7 测试保持；1440/960/480 三档节点/无横向；CDP 14/14 |
| 最终文档 + PR/合并/worktree | **PASS**：本文件；PR #60 MERGED `41554ce`；本任务 worktree/branch 清理 |

---

## 1. 追溯链

| 阶段 | 任务/产物 | 结论 |
|---|---|---|
| 实现 | t454 PR #60 | `.star-hint` 整块 JSX + CSS 删除；TeamDashboard 重复小字删除；帮助保留 |
| 验证 | t455 `starmap-hint-removed-verification.md` | PASS；N1–N4 |
| 评审 | t456 `starmap-hint-removed-review.md` | pass；无 blocker |
| 集成 | t457（本文件） | PASS、合并、清理 |

---

## 2. 移除核对

- `TaskStarMap.tsx`：删除底部 `.star-hint` 整块 JSX；无空占位/空 div。
- `styles.css`：
  - 删除 `.star-hint` 完整规则（position/border/background/color/pointer-events 等）；
  - 删除 `.star-zoom, .star-hint` 组合选择器中的 `.star-hint`，只保留 `.star-zoom`；
  - 无遗留 `.star-hint`/旧文案（单测与 CDP 均验证）。
- `TeamDashboard.tsx`：删除星图标题旁重复的「拖动空白平移 · 滚轮缩放」小字；`TaskStarMap` 仍显示标题/任务数/全部任务。
- 保留：
  - `?` 帮助 button（`title="星图帮助"`）与帮助 Modal；
  - `.sr-only` 状态/图例辅助文本；
  - 画布拖拽/滚轮缩放/节点键盘/指针/G6 单击双击/Ctrl+Enter/浮窗路径；
  - 图例/首次引导/稀疏提示/归巢等既有 UI。

---

## 3. G6 / 三档 / 回归

- G6 单击/双击/Ctrl+Enter/浮窗全部保持；`TaskStarMap.click.test` 7 条 G6 相关测试通过。
- 新增断言：`.star-hint` 数量 0、旧完整文案不存在、`?` 帮助存在、`.sr-only` 存在；TeamDashboard 不再含重复平移/缩放小字。
- 真实 Electron/CDP 三档截图：
  - `docs/team/t454-starmap-1440.png`：1440 星图节点/图例/帮助 `?`，无底部提示条；
  - `docs/team/t454-starmap-960.png`：960 星图 3 节点、无横向；
  - `docs/team/t454-starmap-480.png`：480 星图、无横向、无提示条。
- `docs/team/t454-walkthrough.json`：**14/14 PASS**（三档 hints=0、dup=false、help/sr 保留、3 节点、无 overflow）。
- 无 schema/IPC/权限/依赖变更；改动仅 `TaskStarMap.tsx`、`TeamDashboard.tsx`、`styles.css`、测试/docs/截图。

---

## 4. 验证命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：455 modules；index 328.12 kB / gzip 97.88；TeamDashboard 46.20 / gzip 14.52；CSS 133.40 / gzip 22.74；main 1.6MB/preload 13.4 |
| `pnpm test`（PR worktree，2 workers） | **exit 0**：137 文件/962 用例 |
| `pnpm test -- --testTimeout=20000 --maxWorkers=1`（干净 detached main） | **exit 0**：137 文件/962 用例 |

> 主工作区有并行 t424/t432 worktree，默认 Vitest 会扫入 `branches/**`；集成使用干净 detached main checkout。主工作区 `.gitignore` 本地修改为其他任务，本任务未提交。

---

## 5. 非阻塞项

| ID | 内容 |
|---|---|
| N1 low | CDP 未直接按 `?` 键打开帮助 Modal；帮助 button/Modal 由单测/既有测试覆盖 |
| N2 low | 无 G6 CDP 复跑（G6 7 个组件测试保持通过） |
| N3 low | 960/480 help Modal 未单独截图 |
| N4 low | 主工作区并行 worktree 导致默认 test 污染；干净 checkout 全绿 |

---

## 6. 合并 / 清理

- PR #60 **squash merged** → main `41554ce`。
- worktree `branches/t454-starmap-hint-removed` 删除。
- local/remote `feature/t454-starmap-hint-removed` 删除（`branch:remove` 因本地 main `.gitignore` 脏状态未完成，PR 已合并后手动 `git branch -D`；远端已删）。
- 集成临时 clean checkout 删除。
- `git worktree list`：主 worktree + 其他任务 t424/t432 worktree；本任务清理完成。

---

## 7. 最终 AC

| AC | 证据 | 结论 |
|---|---|---|
| 移除/帮助保留可追溯 | t454/t455/t456 + §2–3 | PASS |
| 独立三命令 | typecheck 0 / build 0 / clean 137/962 | PASS |
| G6/三档无回归 | G6 测试、CDP 14/14、三档截图/无横向 | PASS |
| 最终文档 + PR/合并/worktree | 本文件；PR #60 MERGED `41554ce`；本任务 cleanup | PASS |

**集成结论：PASS，可交付。**
