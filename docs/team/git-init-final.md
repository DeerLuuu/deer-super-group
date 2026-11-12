# 一键初始化 Git 仓库 · 最终集成验收（t351）

- **任务**：t351 — 集成验收一键初始化 Git 仓库
- **集成人**：sol
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/52（**MERGED**；head `394d6a4`；squash merge `2c128b8`）
- **基线**：main `799866c`；合并后 main `2c128b8`
- **结论**：**PASS**。非 Git CTA → 确认 Modal → 仅 `git init` → 空仓库刷新 全链路落地；未 add/commit/.gitignore/remote；现有 Git/PR/merge/权限/gate 无回归；PR 已合并、worktree/branch 清理。

---

## 0. 验收摘要

| 验收项 | 结论 |
|---|---|
| CTA/确认/init/刷新/错误可追溯 | **PASS**：t347 设计 → t348 实现 → t349 PASS → t350 review pass |
| 独立三命令 | **PASS**：typecheck 0；build 0（448 modules）；test extended 122 文件/869 |
| 仅 init/不覆盖/不自动提交 | **PASS**：写通道仅 `git init --initial-branch=main`；无 add/commit/.gitignore/remote/worktree |
| 现有 Git/PR/merge/权限无回归 | **PASS**：全量套件；无 schema/权限/gate/依赖变更 |
| 新增最终文档 | **PASS**：本文件 |
| PR/合并/worktree | **PASS**：PR #52 MERGED `2c128b8`；worktree/local+remote branch 清理 |

---

## 1. 追溯链

| 阶段 | 任务/产物 | 结论 |
|---|---|---|
| 设计 | t347 `docs/team/git-init-design.md` | probe/init/安全/UI/测试计划 |
| 实现 | t348 PR #52 | `gitInit.ts`/probe/init/service/IPC/UI/空仓库语义 |
| 验证 | t349 `git-init-verification.md` | PASS；N1–N4 非阻塞 |
| 评审 | t350 `git-init-review.md` | pass；无 blocker |
| 集成 | t351（本文件） | PASS、合并、清理 |

---

## 2. CTA / 确认 / init / 刷新

- Git Graph 首次加载调用 `gitInitProbe`：
  - `ready` → 非 Git 空态 + **唯一** CTA「初始化 Git 仓库」；
  - 非 ready（已存在/嵌套/损坏/不可写/Git 缺失/版本低）→ 原因说明，无 CTA。
- 确认 Modal 展示：工作区路径、将创建 `<root>/.git`、默认分支 `main`（尚无提交）；明确声明：
  - 不修改现有文件；不执行 `git add`；不提交；不生成 `.gitignore`；不创建 remote/PR/worktree。
- 确认后调用 `git:init(workspaceId)`；服务端 Store 解析路径，`RepoLock` 串行，执行 `git init --initial-branch=main`（`execFile` 无 shell、20s、环境剔除 `GIT_DIR`）。
- 成功后清 `GitService.repoCache`，重新 probe/load；Graph 显示「main 尚无提交」，working tree 可查看 untracked 文件；**不自动创建首个提交**。
- 失败：Modal inline `role=alert` + 重试；`ALREADY_REPO` 关闭 Modal 并刷新正常 Graph；嵌套/不可写/Git 缺失不提供 init 重试。

---

## 3. 仅 init / 不覆盖 / 不自动提交

- `initializeGitRepo` 唯一执行的外部写命令是 `git init --initial-branch=main`；代码中无 `git add`、`commit`、`.gitignore`、remote/worktree 调用。
- 已存在 `.git`/父仓库/直接子仓库/损坏 `.git`/bare/不可写/Git 缺失/版本低均拒绝；不覆盖既有仓库。
- 失败不删除既有 `.git`；partial 保留并提示刷新/检查；不自动清理用户文件。
- `git:init` IPC 仅接受 `workspaceId`（zod strict）；不接收 path/ref/branch/init flags；路径由主进程 Store 决定。
- probe 零写；不创建 `.deer`；后续 `detectRepo` 运行时准备沿用既有读取行为。

---

## 4. 空仓库语义

- `readService.repoInfo` 对 unborn 返回 `headSha:null` + `branch:"main"`，不再直接 `NO_COMMITS`。
- `graph` 返回合法空页；UI 显示「main 尚无提交。工作区文件已就绪，但尚未创建首个提交。」
- `status` 可读取 init 后的 untracked 文件；working tree 可见，不提供 stage/commit 按钮。
- 首次提交/.gitignore 明确不在本批；后续 P1。

---

## 5. 1440 / 960 / 480 / aria

真实 Electron 截图（PR 内）：

- `t348-1440-cta.png`：1440 非 Git 空态 + CTA；
- `t348-1440-modal.png`：确认 Modal（路径/`.git`/main/不修改声明）；
- `t348-960-cta.png`：960 空态；
- `t348-480-cta.png`：480 空态，无横向溢出。

- Modal 初始焦点 Cancel；Tab/焦点陷阱/Esc/busy 禁用复用统一 `Modal`；CTA 原生 button；错误 `role=alert`，成功/空态 `role=status`。
- 集成目视复核：1440 卡片/Modal 居中可读，960/480 CTA 可达；480 无横向。
- **N2**：960/480 仅 CTA 截图，Modal/失败态未单独截图；真实键盘仅组件测试，非本轮真机走查（t349/t350 已记 medium 非阻塞）。

---

## 6. 验证命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：448 modules；index 315.09 kB / gzip 93.91；GitGraphPanel 17.96 kB / gzip 6.02；CSS 130.68 / gzip 22.37；main 1.6MB/preload12.8 |
| `pnpm test` 裸跑 | 既有 service/watchdog/git 5s 并发 timeout |
| `pnpm test -- --testTimeout=20000 --maxWorkers=2` | **exit 0**：**122 文件 / 869 用例** |

> 5s timeout 为既有测试并发 flake（t349/t350 同记录），扩展全量通过。

---

## 7. 回归/范围

- 全量 122 文件/869 用例通过：Git Graph、TaskVcs、PR、merge queue、review/gate、Settings、rail/Workflow/NeedsMe、Dock/窄窗。
- 无新依赖、无权限/gate/数据 schema 变更；未改现有 TaskVcs/PR/merge 写路径。
- `GitService` 只新增 `probeInit/init` 与 `initLock`；成功后清 `repoCache`；新增 `git.repo_initialized` 审计事件。
- 读取改动仅 unborn 支持（repoInfo/status/graph 空仓库），不改变已初始化仓库的提交/refs/diff 语义。

---

## 8. 非阻塞项

| ID | 内容 |
|---|---|
| N1 medium | 真实 Windows ACL 不可写/真实 timeout/并发/审计后端测试缺；UI timeout 为 mock，权限映射以 init stderr 兜底 |
| N2 medium | 960/480 缺 Modal/错误截图；无真实键盘走查 |
| N3 low | UI 测试 mock 数据，未在真实 Electron 操作 init 后 status |
| N4 low | 裸 `pnpm test` 既有 5s 并发 flake |

---

## 9. 合并 / 清理

- PR #52 **squash merged** → main `2c128b8`。
- worktree `branches/t348-git-init` 删除。
- local/remote `feature/t348-git-init` 删除。
- `git worktree list` 仅主 worktree。

---

## 10. 最终 AC

| AC | 证据 | 结论 |
|---|---|---|
| CTA/确认/init/刷新/错误可追溯 | t347–t350 + 本文件 §2–4 | PASS |
| 三命令 | typecheck 0 / build 0 / extended 122/869 | PASS |
| 仅 init/不覆盖/不自动提交 | §3；无 add/commit/.gitignore/remote | PASS |
| Git/PR/merge/权限无回归 | 全量套件；无 schema/权限/gate 变更 | PASS |
| 最终文档 | 本文件 | PASS |
| PR/合并/worktree | PR #52 MERGED `2c128b8`；cleanup | PASS |

**集成结论：PASS，可交付。**
