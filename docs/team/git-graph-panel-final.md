# Git Graph 只读面板 · 最终集成验收（t304）

- **任务**：t304 — 集成验收 Git Graph 只读面板
- **集成人**：sol
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/45（**MERGED**；head `afec4b8`；squash merge `3cc88a5`）
- **基线**：main `034b673`；合并后 main `3cc88a5`
- **结论**：**PASS**。六只读通道、三栏/图/lane/降级、入口与深链已落地；只读边界无写路径；1440/960/480 真实 Electron 截图通过；三命令独立复跑通过；PR 已合并，worktree/branch 已清理。

---

## 0. 验收摘要

| 验收项 | 结论 |
|---|---|
| 六通道/三栏/lane/降级/入口可追溯 | **PASS**：t301 实现 + t305/t307 修复 + t308 复验；六 IPC + panel；设计 t300 |
| 独立三命令 | **PASS**：typecheck 0；build 0（440 modules）；test extended 107 文件/816 |
| 只读无写，Git/rail/Workflow 无回归 | **PASS**：无 checkout/merge/commit/push/stage；TaskVcs/PR/merge/settings/rail/Workflow 套件绿 |
| 1440/960/480 | **PASS**：真实 Electron 截图 t305-1440/960/480 + workspace diff；480 无横向 |
| 最终文档 | **PASS**：本文件 |
| PR/合并/worktree | **PASS**：PR #45 MERGED；worktree/local+remote branch 已清理 |

---

## 1. 追溯链

| 阶段 | 任务/产物 | 结论 |
|---|---|---|
| 设计 | t300 `docs/team/git-graph-panel-design.md` | 只读 IA、六 API、lane、降级、测试计划 |
| 实现 | t301 PR #45 | 六 API、graph lane、GitGraphPanel、入口/深链 |
| 修复 1 | t305 | 真实三档截图、workspace diff、submodule/detached、tabs/listbox、API 边界 |
| 修复 2 | t307 | untracked `--no-index` diff、loadCommit 代际、500/2000/1MB/timeout、480 diff |
| 复验 | t308 `git-graph-panel-verification-3.md` | PASS；N1–N6 非阻塞 |
| 评审 | t303 `git-graph-panel-review.md` | pass，无 blocker |
| 集成 | t304（本文件） | PASS、合并、清理 |

---

## 2. 六只读通道与实现

| Channel | 参数/返回 | 实现 |
|---|---|---|
| `git:repo` | workspaceId → `GitReadRepo`（root/head/branch/detached/ahead/behind/shallow/bare/remote 脱敏） | `GitService.readRepo` → `GitReadService.repoInfo` |
| `git:graph` | limit/offset/ref → `GitGraphPage`（commits/parents/refs/graphVersion） | `readGraph` + `graph.ts` lane |
| `git:refs` | limit → local/remote/tags/head | `readRefs` |
| `git:status` | workspaceId → staged/unstaged/untracked/conflicts/submodules | `readStatus` |
| `git:commit` | sha → metadata/parents/refs/changed files/stats/diff | `readCommit`（show 语义） |
| `git:diff` | scope working/staged/commit、sha/path/context/maxBytes | `readDiff`；untracked 用 `--no-index` |

- 主进程 `electron/main.ts` 对六通道做 zod strict + workspaceId 校验；preload 仅暴露六个方法。
- `GitExec` allowlist 只新增只读形状：`log --parents/--topo-order/--max-count`、`for-each-ref`、`rev-list --left-right --count`、`status --porcelain=v2`、`diff --no-index/-- path`、`show --name-status`、`submodule status --recursive`；写命令未放宽。
- 所有调用 `execFile` 无 shell；graph/status/diff 有明确 timeout/maxBuffer；`redactSecrets` 保留；repo root 校验。
- 错误码：`GIT_READ_NOT_REPO/NOT_ROOT/NO_COMMITS/BAD_PARAM/BAD_REF/BAD_PATH/REF_NOT_FOUND/TIMEOUT/TOO_LARGE/DIFF_BINARY/DIFF_SUBMODULE/DEGRADED/INTERNAL`。

---

## 3. UI / 图 / 降级

- Dock panel `gitGraph`（默认关闭，`onlyWhenVisible`）；顶部 repo/分支/ahead-behind/只读/刷新/引用栏；左栏 refs + worktrees；中栏 SVG lane + DOM 提交 listbox；右栏 commit/diff；工作区 tab。
- lane：首 parent 沿 lane、merge/fork、openEdges、16 lane 上限、500/页、2000 总；分页追加重算。
- 降级：非 git/非 root、空/unborn、bare、shallow、detached、submodule、binary、大 diff、超时；错误与截断显式，不伪造空。
- 入口：Sidebar「版本图」、面板启动器、Task VCS「在版本图中查看」、`#/git` 深链；不新增 PrimaryRail 第五入口。
- **P1**：Command Palette 入口未纳入（`src/CommandPalette.tsx` 不在实现任务 inScope；t303 已记录，非阻塞）。设计 t300 曾列该入口，后续任务补。

---

## 4. 只读 / 回归核对

- `GitGraphPanel`/`readService` 无 `checkout/merge/commit/push/stage` 调用；按钮只有刷新/筛选/复制/跳转。
- `GitExec` diff 未放宽写命令；`TaskVcsPanel` 只新增只读「在版本图中查看」；PR/merge queue/settings 未改语义。
- 全量 107 文件/816 用例通过；TaskVcs/PR/merge/settings/rail/Workflow/panelHost 既有套件无回归。
- 无新增依赖、权限/gate/数据层/任务状态机改动。

---

## 5. 三档视觉

真实 Electron 1440×920 / 960 / 480（数据源本仓库 main）：

- `t305-1440-panel.png`：三栏 + lane + commit detail/diff。
- `t305-1440-workspace-diff.png`：选中 tracked 文件显示 `@@` diff。
- `t305-960.png`：详情下沉。
- `t305-480.png`：图/详情/工作区 tab，bodyWidth=480，无横向溢出。
- `t307-480-workspace-diff.png`：480 工作区文件 diff。

集成目视复核：1440 三栏可读；960 详情下沉；480 tab 单栏、提交行可滚动、无页面横向滚动。

---

## 6. 验证命令

### PR head / merged main

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：440 modules；js 1,314.16 kB / gzip 363.64；css 264.19 / gzip 32.91；electron main 1.6MB、preload 12.6kB |
| `pnpm test` | 裸跑 5 个既有 5s timeout（service/watchdog） |
| `pnpm test -- --testTimeout=20000 --maxWorkers=2` | **exit 0**：**107 文件 / 816 用例** |

> 5s timeout 为既有测试并发 flake（t308/t303 同样记录），扩展全量通过；非 Git Graph 回归。

---

## 7. 非阻塞项

| ID | 内容 | 状态 |
|---|---|---|
| P1-1 | Command Palette「打开版本图」入口未纳入 | 后续 inScope 任务补；Sidebar/launcher/TaskVcs/#git 已有入口 |
| N1 | `openWorkingFile` 无代际，快速点两文件旧 diff 可覆盖 | low；组件/后续 |
| N2 | loadMore 无 token | low |
| N3 | untracked 工作区 UI 截图缺失 | low；API/组件已覆盖 |
| N4 | bare 仅 repoInfo/timeout fake | low |
| N5 | 100% 真实 OS/DPR2 未测，480 CSS 视口已验收 | low |
| N6 | 既有 5s flake | 环境 |

---

## 8. 合并 / 清理

- PR #45 **squash merged** → main `3cc88a5`。
- worktree `branches/t301-git-graph-panel` 删除。
- local/remote `feature/t301-git-graph-panel` 删除。
- `git worktree list` 仅主 worktree；最终报告本文件。

---

## 9. 最终 AC

| AC | 证据 | 结论 |
|---|---|---|
| 六通道/三栏/lane/降级/入口可追溯 | §2–3、t301/t305/t307/t308/t303 | PASS |
| 独立三命令 | typecheck 0 / build 0 / extended 107/816 | PASS |
| 只读无写，Git/rail/Workflow 无回归 | §4；全量套件 | PASS |
| 1440/960/480 | §5 真实 Electron 图 | PASS |
| 最终文档 | 本文件 | PASS |
| PR/合并/worktree | PR #45 MERGED `3cc88a5`；worktree/branch 清理 | PASS |

**集成结论：PASS，可交付。**
