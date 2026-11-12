# 工作区双列表 + Diff 查看器 G4 · 最终集成验收（t404）

- **任务**：t404 — 最终集成 G4：Git 工作区双列表 + Diff 查看器增强
- **集成人**：sol
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/56（**MERGED**；head `6d8daae`；squash merge `11d3e78`）
- **基线**：main `e2ac41a`；合并后 main `11d3e78`（已包含 mailbox #55 的 `4fc63b8`）
- **结论**：**PASS**。双列表、diff 行号/配色/hunk/折叠/并排/大 diff/状态全部落地；短高 1372×328 修复并截图；三档/键盘/aria 通过；G1 写操作、刷新、懒加载、`#/git` 无回归；无新依赖；PR 已合并、worktree/branch 清理。

---

## 0. 验收摘要

| 验收项 | 结论 |
|---|---|
| 双列表/diff/三档/aria 可追溯 | **PASS**：t400 设计 → t401 实现 → t407/t411/t413 修复 → t412 PASS → t414 review pass |
| 独立三命令 | **PASS**：typecheck 0；build 0（454 modules）；main-only test 133 文件/939；PR 分支 128/912 |
| G1/刷新/入口无回归 | **PASS**：PR 仅 UI/CSS/test/docs；G1 handlers/IPC 未改；全量 main-only 套件 |
| 无新依赖 | **PASS**：package.json 无变更；仅新增 UI 组件/CSS/纯函数 |
| 最终文档 + PR/合并/worktree | **PASS**：本文件；PR #56 MERGED `11d3e78`；本任务 worktree/branch 清理 |

---

## 1. 追溯链

| 阶段 | 任务/产物 | 结论 |
|---|---|---|
| 设计 | t400 `docs/team/git-working-diff-design.md` | 双列表 38/62、段 tabs、diff 行号/并排/大 diff/状态 |
| 实现 | t401 PR #56 | GitDiffViewer、双列表、480 段 tabs、行号/折叠/并排 |
| 加固 | t407 | 大 diff、工作区布局、状态截图 |
| 短高 | t411 | `@container git-panel (max-height:560px)`；1372×328 截图/DOM metrics |
| 修复 | t413 | SideHunkBlock 共用 large 阈值/400 side rows/批；side gridcell/aria |
| 验证 | t412 `git-working-diff-verification-3.md` | PASS；N1–N5 |
| 复审 | t414 `git-working-diff-review-2.md` | pass；无 blocker |
| 集成 | t404（本文件） | PASS、合并、清理 |

---

## 2. 工作区双列表

- 1440/960：左列上下 **已暂存 / 未暂存·未跟踪** 双段，独立滚动、段头固定；38/62 比例、6px `role=separator` 可拖拽 + Arrow/Home；空段紧凑、另一段占满。
- 段头：全选/取消、批量 `+`/`−`；行 checkbox/逐文件 diff；冲突/子模块摘要保留；footer 显示已暂存 N 文件。
- 480/短高：明确降级为工作区 tab 内「已暂存 / 未暂存」段 tabs；高度过小时隐藏历史、保留筛选和工作区；不伪造双段同屏。
- G1 写语义不变：`git:stage`/`git:unstage`/`git:commit-create`/`git:ignore-*` handlers、CommitGuard、写锁、审计、首提引导均未改。

---

## 3. Diff 查看器

- 文件头：path/status/+N/−N、复制路径、换行、搜索槽（D1 预留 disabled）。
- 统一 diff：旧/新行号、`+` 绿/`−` 红、hunk 头、未变更块折叠。
- 并排：宽≥560 启用；旧/新两列对齐；窄窗自动 unified，480 强制 unified；960/480 side toggle disabled 截图。
- 大 diff：>1200 行或 >512KB 默认折叠 hunk；单 hunk 每批最多 400 side rows（继续加载）；test 20k 行 0→400 rows/1600 gridcell、字符串节点<10k。
- 状态：binary/submodule/truncated/loading/empty/error 显式；1MB 上限/hunk 批渲染；行可聚焦、`role=row`/`tabIndex`/`aria-label`；side 四列 `role=gridcell`、容器 `role=table`。
- 短高：`@container git-panel (max-height:560px)` 隐藏历史、段头 22px、段高 47px、行 24px、footer 可见；1372×328 DOM metrics 无重叠、`scrollWidth=innerWidth`、操作列 24px。

---

## 4. 三档 / 键盘 / aria 证据

真实 Electron/CDP 截图（PR 内）：

- `t401-git-diff-1440.png`：统一 diff；`t401-git-side-1440.png`：并排 diff；
- `t401-git-diff-960.png`：960 布局；`t401-git-working-480.png`：480 段 tabs；
- `t401-git-diff-480.png`：480 统一 diff；
- `t411-short-1372x328.png` / `t411-short-workarea-close-1372x328.png` / `t411-short-diff-1372x328.png`；
- `t411-tab-focus-1372x328.png`（行 focus outline）、`t411-side-disabled-960.png`、`t411-side-disabled-480.png`；
- t407 大 diff/工作区 1440/960/480 补充。

- Tab 从 diff 行1→2：`role=row`、`tabIndex=0`、`aria-label`，outline 2px；side gridcell 四类 aria；480 tablist/段 tabs 可操作。
- 短高证据为 **固定面板容器 1372×328**（Electron 窗口最小高度限制；t411/t412 已披露 N1），非 OS 窗口；用户截图尺寸对齐。

---

## 5. 验证命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：454 modules；index 324.91 kB / gzip 96.88；GitGraphPanel 45.66 kB / gzip 12.90；GitGraph CSS 19.51 / gzip 4.21；main 1.6MB/preload 13.4 |
| `pnpm test`（当前主工作区原始） | 当前主工作区有并行 t415 worktree，默认扫描到 `branches/t415-*` 测试导致 8 个无关失败；非本 PR 回归 |
| `pnpm test -- --testTimeout=20000 --maxWorkers=2`（干净 detached checkout，无 branches） | **exit 0**：**133 文件 / 939 用例**（包含 main 的 mailbox #55；本任务独立临时 worktree 已删除） |
| PR head 测试 | 128 文件/912（G4 分支基线） |

> 原始 `pnpm test` 的失败来自并行工作树测试被 Vitest 默认 glob 扫入（`branches/t415-*`），与 G4 无关；在无 `branches/` 的干净 detached checkout 中全绿。CI/无并行 worktree 环境不会出现该污染。

---

## 6. 回归 / 范围

- PR 改动 10 个实现/测试文件 + 22 份 docs（21 张截图 + 1 份说明）：GitDiffViewer、GitGraphPanel UI、gitWorkingDiff.css、gitWorkingLayout、CSS/test；**无 IPC/electron/service/data schema**。
- G1 五通道/CommitGuard/写锁/审计/首提、GitInit、.gitignore、`#/git`、Command Palette、LazyPanel、RefreshCoordinator 未改。
- 无 package.json/依赖变化；无权限/gate 变化。
- main-only 全量包含 Git/G1/GitInit/TaskVcs/PR/merge/review/Settings/rail/Workflow/NeedsMe/Dock/窄窗/mailbox。
- 已知：`changedPaths` 概念 inScope 为空；实际只改 Git UI/CSS/test/docs，已核对。

---

## 7. 非阻塞项

| ID | 内容 |
|---|---|
| N1 medium | 短高 1372×328 为固定面板容器（Electron 窗口最小高度），非 OS 窗口；已披露 |
| N2 low | `buildSideBySide` 折叠时仍计算 full side（性能，20k 测试通过） |
| N3 low | 搜索槽 disabled，D1 后续接入 |
| N4 low | 短高 metrics 无 JSON/读屏；固定容器走查 |
| N5 medium | 并行 t415 worktree 使当前工作区原始 `pnpm test` 扫描到无关测试；干净 checkout 全绿 |

---

## 8. 合并 / 清理

- PR #56 **squash merged** → main `11d3e78`（包含 mailbox #55 `4fc63b8`）。
- worktree `branches/t401-git-working-diff` 删除。
- local/remote `feature/t401-git-working-diff` 删除。
- `git worktree list`：主 worktree + 其他任务 t415 worktree（非本任务）；本任务 worktree 已清理。

---

## 9. 最终 AC

| AC | 证据 | 结论 |
|---|---|---|
| 双列表/diff/三档/aria 可追溯 | t400–t414 + §2–4 | PASS |
| 独立三命令 | typecheck 0 / build 0 / main-only 133/939 | PASS |
| G1/刷新/入口无回归 | §6；PR 无 IPC/service 变更；main-only 套件 | PASS |
| 无新依赖 | package.json 无变更 | PASS |
| 最终文档 + PR/合并/worktree | 本文件；PR #56 MERGED `11d3e78`；本任务 cleanup | PASS |

**集成结论：PASS，可交付。**
