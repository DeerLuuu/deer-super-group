# 星图单击/双击 G6 · 最终集成验收（t422）

- **任务**：t422 — 最终集成 G6：星图单击浮窗 / 双击进入任务
- **集成人**：sol
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/59（**MERGED**；head `fe2f49c`；squash merge `c32eeed`）
- **基线**：main `42d2ffd`；合并后 main `c32eeed`
- **结论**：**PASS**。单击只选中+概览浮窗、不跳转；双击/Ctrl+Enter 进入任务工作区；浮窗两动作不变；过滤/定位/aria/三档无回归；PR 已合并、worktree/branch 清理。

---

## 0. 验收摘要

| 验收项 | 结论 |
|---|---|
| 单击/双击/键盘可追溯 | **PASS**：t419 实现 → t420 PASS → t421 review pass |
| 独立三命令 | **PASS**：typecheck 0；build 0（455 modules）；clean main serial 137 文件/961 |
| 过滤/定位/aria/三档无回归 | **PASS**：CDP 11/11、1440 实际截图、960/480 no-overflow；N3 记录截图局限 |
| 最终文档 + PR/合并/worktree | **PASS**：本文件；PR #59 MERGED `c32eeed`；本任务 worktree/branch 清理 |

---

## 1. 追溯链

| 阶段 | 任务/产物 | 结论 |
|---|---|---|
| 实现 | t419 PR #59 | 单击只 `onSelect`+popover；双击/Ctrl+Enter `onOpenTaskPage`；6 单测；CDP 11/11 |
| 验证 | t420 `starmap-click-doubleclick-verification.md` | PASS；N1–N5 |
| 评审 | t421 `starmap-click-doubleclick-review.md` | pass；无 blocker |
| 集成 | t422（本文件） | PASS、合并、清理 |

---

## 2. 行为核对

| 交互 | 实现 | 证据 |
|---|---|---|
| 单击节点 | `onSelect` 只更新 `selectedTaskId` + `loadTrace`（C12 `?t=` 选中参数），打开概览浮窗；**不调用** `handleOpenTaskWorkspace`/`onOpenTaskPage`，面板不切换 | CDP hash `#/team` → `#/team?t=t419-a`，非 `#/tasks`；`t419-1440-popover.png` |
| 双击节点 | `closePopover(false)` + `onOpenTaskPage(task)` → App `handleOpenTaskWorkspace(id,"team")` | CDP `#/tasks?t=t419-b`；`t419-1440-after-doubleclick.png` |
| Ctrl/Cmd+Enter | 与双击等价 `onOpenTaskPage` | CDP 11/11；单测 |
| 普通 Enter | 不导航（原生按钮语义） | 单测 |
| 浮窗「打开会话」 | 原 `onOpen`（聊天上下文）不变 | 单测 + 浮窗 DOM |
| 浮窗「在任务页打开」 | 原 `onOpenTaskPage` 不变 | 单测 + 浮窗 DOM |
| 浮窗居中/聚焦/复制 ID | 未改 | 单测/CDP |

- App team 布线：`selectedTaskId` 传真实值（此前 null），单击在团队面板恢复任务选中/概览；不再误跳任务页。
- `TaskStarMap` aria-label 追加「单击查看概览，双击打开任务」，title 同提示；节点可聚焦，Esc 关闭浮窗并回焦。

---

## 3. 三档 / aria / 回归

- 1440：`t419-1440-popover.png`（单击浮窗）、`t419-1440-after-doubleclick.png`（双击后任务页）。
- 960/480：`t419-960-starmap.png`、`t419-480-starmap.png`；CDP `no-overflow-960/480` 均 `scrollWidth<=viewport`。
  - **证据局限（N3）**：960 截图捕获于 Team 懒加载 skeleton 阶段；480 截图星图节点在可视区下方未完整入镜。三档布局/无横向由 CDP metrics + 既有星图布局/测试覆盖，不是新布局改动；集成不伪造节点已入镜。
- 过滤/成员过滤/定位（C14）/图例/首次加载/键盘基线未改；节点可聚焦；浮窗 actions 与 Esc 行为保留。
- 无 schema/IPC/权限/依赖变更；改动仅 `App.tsx`、`TaskStarMap.tsx`、测试、CDP/seed 脚本、docs/截图。

---

## 4. 验证命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：455 modules；index 328.12 kB / gzip 97.88；TeamDashboard 46.45 / gzip 14.58；CSS 133.61 / gzip 22.77；main 1.6MB/preload 13.4 |
| `pnpm test`（PR worktree，2 workers） | **exit 0**：137 文件/961 用例 |
| `pnpm test -- --testTimeout=20000 --maxWorkers=1`（干净 detached main） | **exit 0**：137 文件/961 用例 |

> 干净 checkout 首次全量出现 `readService.edge.test` 偶发 `git add` 环境失败；单测重跑与完整串行重跑均 13/13、137/961 全绿，判定为环境 flake，不是 G6 回归。主工作区有并行 t432 worktree，默认 test 会扫入 `branches/**`；集成用干净 checkout。

---

## 5. 非阻塞项

| ID | 内容 |
|---|---|
| N1 medium | 无过滤后焦点回焦/过滤状态专项断言；以既有测试 + CDP 走查覆盖 |
| N2 low | CDP 双击为合成 `dblclick`，非真实鼠标双击 |
| N3 medium | 960 截图在 Team 懒加载 skeleton、480 星图节点未完整入镜；仅 CDP no-overflow + 既有布局 |
| N4 low | C12 `?t=` 选中参数的口径未单独产品确认 |
| N5 low | 主工作区并行 worktree 导致默认 test 污染；干净 checkout 全绿 |

---

## 6. 合并 / 清理

- PR #59 **squash merged** → main `c32eeed`。
- worktree `branches/t419-starmap-click-doubleclick` 删除。
- local/remote `feature/t419-starmap-click-doubleclick` 删除。
- 集成临时 clean checkout 删除。
- `git worktree list`：主 worktree + 其他任务 t432 worktree；主工作区另有其他任务未跟踪 docs 与 `.gitignore` 本地修改，本任务未触碰/未提交。

---

## 7. 最终 AC

| AC | 证据 | 结论 |
|---|---|---|
| 单击/双击/键盘可追溯 | t419/t420/t421 + §2 | PASS |
| 独立三命令 | typecheck 0 / build 0 / clean 137/961 | PASS |
| 过滤/定位/aria/三档无回归 | CDP 11/11、1440 截图、960/480 no-overflow；N3 记录 | PASS |
| 最终文档 + PR/合并/worktree | 本文件；PR #59 MERGED `c32eeed`；本任务 cleanup | PASS |

**集成结论：PASS，可交付。**
