# Git 历史/工作区可拖拽分隔 G9 · 最终集成验收（t435）

- **任务**：t435 — 最终集成 G9：Git 历史/工作区可拖拽分隔
- **集成人**：sol
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/58（**MERGED**；head `8e01912`；squash merge `bb19421`）
- **基线**：main `0332b91`；合并后 main `bb19421`（含 t427/#61）
- **结论**：**PASS**。6px separator 的拖拽/clamp/键盘/双击恢复/持久化/隐藏态全部落地；G1 写操作/工作区内容未改；三档/短高无横向；PR 已合并、本任务 worktree/branch 清理。

---

## 0. 验收摘要

| 验收项 | 结论 |
|---|---|
| 拖拽/键盘/clamp/持久化可追溯 | **PASS**：t432 实现 → t452 修复 F1/F2/F3 → t453 PASS → t434 review pass |
| 独立三命令 | **PASS**：typecheck 0；build 0（458 modules）；clean main serial 144 文件/993 |
| G1/三档无回归 | **PASS**：G1 IPC/写路径未改；1440 wide、960、480、1372×328/560 真实截图；N1 记录默认 1440 宽度断点 |
| 最终文档 + PR/合并/worktree | **PASS**：本文件；PR #58 MERGED `bb19421`；本任务 worktree/branch 清理 |

---

## 1. 追溯链

| 阶段 | 任务/产物 | 结论 |
|---|---|---|
| 实现 | t432 PR #58 | `gitWorkspaceSplit.ts` 纯函数 + separator + CSS + 测试/截图 |
| 修复 | t452 | 双击恢复 300（移除 pointerdown preventDefault）；短高 DOM 证据；真实 Electron 截图 |
| 复验 | t453 `git-resizable-workspace-verification-2.md` | PASS；N1–N4 |
| 评审 | t434 `git-resizable-workspace-review.md` | pass；N1 medium 默认 1440 宽度断点 |
| 集成 | t435（本文件） | PASS、合并、清理 |

---

## 2. 交互契约

- 布局：`.git-st-layout` 行 `minmax(180px, 1fr) 30px 6px var(--git-workspace-h, 300px)`；History 与工作区之间插入 6px `.git-st-splitter`。
- 拖拽：pointer down + capture，实时高度 = `containerHeight - pointerY`，clamp 到 `[160, containerHeight - 216]`；结束持久化。
- 键盘：`role="separator"`、`tabIndex=0`、`aria-orientation=horizontal`、`aria-valuemin/max/now/valuetext`；ArrowUp +16 / ArrowDown −16 / Home 160 / End 容器最大；focus-visible 明显。
- 双击：恢复默认 300 并持久化；t452 根因是 pointerdown `preventDefault()` 抑制原生 dblclick，已删除；真实 CDP clickCount 1→2 验证 `aria-valuenow=300` + localStorage `300`。
- 持久化：key `deer.git.workspaceHeight.<workspaceId>`；非法值/NaN 回默认 300 并 clamp；容器 resize 时 ResizeObserver 重新 clamp。
- 隐藏态：容器宽 ≤719 进入三 tab 模式；高 ≤560 短高模式隐藏 history/splitter；1372×328/560 DOM 断言 splitter `display:none`、不可聚焦、workspace 存在。
- 既有 G1 stage/unstage/commit/.gitignore/CommitGuard/写锁/审计/工作区内容未改；仅 UI/CSS/纯函数/测试/docs。

---

## 3. 证据 / 三档

真实 Electron/CDP：

- `docs/team/t432/electron-wide-1440.png`（1440×900，Team 关闭使 Git 面板宽 >719，splitter 可见）；
- `electron-mid-960.png`（960×800）；
- `electron-mobile-480.png`（480×800，三 tab，splitter 隐藏）；
- `electron-short-1372x328.png` / `electron-short-1372x560.png`（短高，history/splitter 隐藏、workspace 保留）；
- `t452-electron-verify.json` 7/7 PASS（1440 splitter visible、End/max、真实 dblclick 300、960、480、short 两档）；`t432-verify.json` 覆盖拖拽/键盘/持久化。
- 文档 `git-resizable-workspace.md` 记录初始 269 与双击/短高修复。

**N1 medium（已知，非阻塞）**：默认 1440 双栏下 Git 主组约 666px，触发既有 `@container git-panel (max-width:719px)` 三 tab 断点，splitter 隐藏；需关闭 Team/最大化/更宽窗口才能拖拽。该断点为既有宽度策略，不是 G9 回归；t434 已记录，建议后续单独评审宽度断点或面板最大化。1440 宽截图按「关闭 Team 保证 splitter 可见」拍摄。

---

## 4. 验证命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：458 modules；index 334.50 kB / gzip 99.74；GitGraphPanel 47.82 / gzip 13.63；CSS 135.39 / gzip 23.09；main 1.6MB/preload 13.5 |
| `pnpm test`（PR worktree，2 workers） | **exit 0**：138 文件/976 用例 |
| `pnpm test -- --testTimeout=20000 --maxWorkers=1`（干净 detached main） | **exit 0**：144 文件/993 用例（含 t427/#61） |

> 主工作区有并行 t428 worktree，默认 Vitest 会扫入 `branches/**`；集成使用干净 detached main checkout。主工作区 `.gitignore`/`.npmrc` 等本地修改为其他任务，本任务未提交。

---

## 5. 非阻塞项

| ID | 内容 |
|---|---|
| N1 medium | 默认 1440 Dock Git ~666px 触发 ≤719 三 tab 断点，splitter 隐藏；需关闭 Team/最大化 |
| N2 low | 1440 宽截图非默认布局（Team 关闭）；已在截图/文档注明 |
| N3 low | 初始工作区高度 269（默认 300 读取后 clamp/布局导致），非持久化 bug |
| N4 low | pointercancel/每 move 不单独写 localStorage；仅提交时持久化 |
| N5 low | 主工作区并行 worktree 导致默认 test 污染；干净 checkout 全绿 |

---

## 6. 合并 / 清理

- PR #58 **squash merged** → main `bb19421`。
- worktree `branches/t432-git-resizable-workspace` 删除。
- local/remote `feature/t432-git-resizable-workspace` 删除。
- 集成临时 clean checkout 删除。
- `git worktree list`：主 worktree + 其他任务 t428 worktree；本任务清理完成。

---

## 7. 最终 AC

| AC | 证据 | 结论 |
|---|---|---|
| 拖拽/键盘/clamp/持久化可追溯 | t432/t452/t453/t434 + §2–3 | PASS |
| 独立三命令 | typecheck 0 / build 0 / clean 144/993 | PASS |
| G1/三档无回归 | G1 未改；真实 1440/960/480/1372 截图；N1 记录 | PASS |
| 最终文档 + PR/合并/worktree | 本文件；PR #58 MERGED `bb19421`；本任务 cleanup | PASS |

**集成结论：PASS，可交付。**
