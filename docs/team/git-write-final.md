# Git 写闭环 G1 · 最终集成验收（t355）

- **任务**：t355 — 最终集成 G1：stage / unstage / commit / .gitignore / 首提引导
- **集成人**：sol
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/53（**MERGED**；head `0e2abd4`；squash merge `c8f254f`）
- **基线**：main `889555c`；合并后 main `c8f254f`
- **结论**：**PASS**。写闭环、首提引导、.gitignore 预览/仅追加、三档截图/走查证据全部落地；不覆盖文件、无 push、rename 双检、symlink/junction 防护、审计通过；现有 Git/权限/gate 无回归；PR 已合并、worktree/branch 清理。

---

## 0. 验收摘要

| 验收项 | 结论 |
|---|---|
| 写闭环/引导/.gitignore 可追溯 | **PASS**：t352 实现 → t389 证据 → t395 安全修复 → t396/t397 复审 PASS |
| 独立三命令 | **PASS**：typecheck 0；build 0（448 modules）；test extended 124 文件/890 |
| 不覆盖/无 push/guard/审计 | **PASS**：唯一本地写；rename old+new guard；symlink/junction 拒绝；4 审计事件 |
| 现有 Git/权限无回归 | **PASS**：全量套件；无 schema/权限/gate/依赖变更 |
| 最终文档 + PR/合并/worktree | **PASS**：本文件；PR #53 MERGED `c8f254f`；worktree/branch 清理 |

---

## 1. 追溯链

| 阶段 | 任务/产物 | 结论 |
|---|---|---|
| 实现 | t352 PR #53 | 5 写 IPC、UI 工作区 stage/commit、.gitignore、首提引导、4 审计事件 |
| 证据补齐 | t389 | 真实 Electron 1440/960/480 截图；normal 22/22、unborn 10/10 走查 |
| 安全修复 | t395 | rename old+new CommitGuard；.gitignore lstat/realpath/symlink 防护 |
| 复审 | t396 / t397 | t396 外层 status 误写为 failed，实际 verdict/output 为 pass；t397 evidence_note 更正并正式 PASS |
| 集成 | t355（本文件） | PASS、合并、清理 |

---

## 2. 写通道与面板行为

| 通道 | 行为 | 边界 |
|---|---|---|
| `git:stage` | `git add -- <paths>` | paths 1..500；`isReadPath` + resolve 后仍在 root；无 `add .`/`-A` |
| `git:unstage` | `git reset -- <paths>` | 仅 `-- <paths>`；无 `--hard`/commit 形态 |
| `git:commit-create` | `git commit --no-verify -m <title>` | 只提交 staged；CommitGuard 前置；`git:commit` 已占用，命名偏差已文档化 |
| `git:ignore-preview` | 读现有 `.gitignore`，计算缺失模板行 | 只读；>256KB 拒绝预览；Modal 声明仅追加/不覆盖 |
| `git:ignore-apply` | 仅追加缺失行（必要时补换行） | 写前 lstat/realpath 再校验；幂等；不覆盖既有内容 |

- 工作区 tab：staged / 未暂存 / 未跟踪 / 冲突分组；单行 checkbox、全选、批量 stage/unstage；提交框标题必填、正文可选、仅提交 staged、无暂存禁用。
- CommitGuard 拒绝 inline `role=alert`；空仓库首次提交三步引导（repo 探测完成后才显示，避免 loading 闪烁）。
- `.gitignore` 工具按钮 → 预览 Modal → 追加缺失行；应用后作为未跟踪文件出现；无 remote/push/worktree 操作。
- 顶部 badge 从「只读」变为「本地可写」；footer 明示「本地提交 · 无 push」。

---

## 3. 安全验收

- **无 push/remote/force**：新增 5 通道均为本地；`reset` 仅 `-- <paths>` unstage；`commit` 仅 `--no-verify -m`；任务级 finalize 的既有 push 路径未改。
- **不覆盖**：`.gitignore` 只追加缺失行；提交不修改工作区文件；stage/unstage 只操作索引；不删除/覆盖现有文件。
- **路径双校验**：`isReadPath` 拒绝绝对路径/`..`/`.git/**`；`path.resolve` 后必须仍在仓库根内；`GitExec` argv 白名单只接受受控 `add --`/`reset --` 形态。
- **CommitGuard rename 双检**：`parseStagedPaths` 对 R/C 返回 oldPath+newPath；`checkPaths` 对两者去重后全部检查；真实测试 `.env → app.txt`、`.ssh/id_rsa → safe.txt` 均拒绝且 HEAD 不变；安全 rename 记录 old/new。
- **.gitignore 链接逃逸**：`inspectIgnoreTarget` 用 `lstat` 拒绝 symlink/junction/非普通文件；`realpath` 必须位于仓库根；preview 与 apply 都校验，apply 写前再校验；真实 symlink/junction/dangling target 测试失败且外部 sentinel 不变。
- **并发/审计**：`graphWriteLock`（RepoLock）按 workspace 串行；4 事件 `git.staged`/`git.unstaged`/`git.committed`/`git.ignore_updated` 经 eventRegistry zod 校验；审计失败不回滚已成功的本地写。
- **Modal.tsx**：仅增加 `typeof document === "undefined"` 守卫用于 node 测试渲染，DOM 行为零变化（t352 已披露；集成复核无生产语义变化）。

---

## 4. 三档截图 / 走查

真实 Electron/CDP 证据（PR 内 14 张）：

| 场景 | 1440 | 960 | 480 |
|---|---|---|---|
| 工作区写 UI | `t352-1440-write-ui.png` | `t352-960-write-ui.png` | `t352-480-write-ui.png` |
| 空仓库首提引导 | `t352-1440-first-commit.png` | `t352-960-first-commit.png` | `t352-480-first-commit.png` |
| .gitignore Modal | `t352-1440-ignore-modal.png` | `t352-960-ignore-modal.png` | `t352-480-ignore-modal.png` |

补充：`t352-1440-guard-blocked.png`、`t352-1440-committed.png`、`t352-1440-ignore-applied.png`、`t352-1440-unborn-committed.png`、`t352-1440-ignore-modal-unborn.png`。

走查 JSON：

- `docs/team/t389-walkthrough-normal.json`：**22/22 PASS**（勾选→stage→提交→HEAD 更新→guard inline→.gitignore Modal/Esc→键盘批量→unstage→ignore apply）。
- `docs/team/t389-walkthrough-unborn.json`：**10/10 PASS**（空仓库首提三步引导、空仓库 .gitignore、首提后图出现提交）。

集成目视复核：1440 写 UI/首提/Modal 可读；960 单列；480 单列无横向溢出；CTA/复选框/提交框/Modal 可达。

---

## 5. 验证命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：448 modules；index 315.15 kB / gzip 93.91；GitGraphPanel 26.39 kB / gzip 8.18；CSS 130.68 / gzip 22.37；main 1.6MB/preload 13.4 |
| `pnpm test` 裸跑 | 既有 service/watchdog/git 5s 并发 timeout |
| `pnpm test -- --testTimeout=20000 --maxWorkers=2` | **exit 0**：**124 文件 / 890 用例** |

> 5s timeout 为既有机器负载/并发 flake；串行/扩展全量通过（t397 同记录）。

---

## 6. 回归/范围

- 全量 124 文件/890 用例通过：Git Graph、Git 初始化、TaskVcs、PR、merge queue、review/gate、Settings、rail/Workflow/NeedsMe、Dock/窄窗。
- 无新依赖、无权限/gate/数据 schema 变更；任务级 Git 流程（worktree/fencing/finalize/push/PR/merge）语义未改。
- `git.staged/unstaged/committed/ignore_updated` 为 workspace 聚合审计事件；事件目录 35→39。
- 新增辅助脚本 `scripts/gitwrite-cdp.mjs`、`scripts/seedGitwriteFixture.test.ts` 仅用于证据复现，不进入生产运行路径。
- 偏差：写通道命名 `git:commit-create`（`git:commit` 已被只读详情占用），文档已说明，无语义歧义。

---

## 7. 非阻塞项

| ID | 内容 | 来源 |
|---|---|---|
| N1 | 真实并发窗口/GUI 手工冒烟需人工按 `git-write.md §7` 再走查 | t352/t389 |
| N2 | 默认并行测试偶发 5s timeout（串行/扩展全绿） | 既有环境 |
| N3 | `scripts/gitwrite-cdp.mjs` 为本地证据脚本，不纳入产品构建 | t389 |
| N4 | t396 状态误写已由 t397 evidence_note 更正，不影响代码/评审结论 | t397 |

---

## 8. 合并 / 清理

- PR #53 **squash merged** → main `c8f254f`。
- worktree `branches/t352-git-write-evidence` 删除。
- local/remote `feature/t352-git-write` 删除。
- `git worktree list` 仅主 worktree。

---

## 9. 最终 AC

| AC | 证据 | 结论 |
|---|---|---|
| 写闭环/引导/.gitignore 可追溯 | t352/t389/t395/t397 + §2–4 | PASS |
| 独立三命令 | typecheck 0 / build 0 / extended 124/890 | PASS |
| 不覆盖/无 push/guard/审计 | §3；真实 rename/symlink 测试；4 审计事件 | PASS |
| Git/权限无回归 | 全量套件；无 schema/权限/gate 变更 | PASS |
| 最终文档 + PR/合并/worktree | 本文件；PR #53 MERGED `c8f254f`；cleanup | PASS |

**集成结论：PASS，可交付。**
