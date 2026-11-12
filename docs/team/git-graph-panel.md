# 只读 Git Graph 面板（t301）

- **任务**：t301 — 按 t300 设计实现只读版本图
- **分支**：`feature/t301-git-graph-panel`
- **范围**：`src/git/`、`src/App.tsx`、`src/shell/`、`src/shared/`、`electron/main.ts`、`electron/preload.ts`、docs/team/
- **只读**：不提供 checkout/merge/commit/push/stage；现有 TaskVcs/PR/merge queue/settings 不变
- **不新增** primary tab；`#/git` 作为只读深链，Dock 面板默认关闭

## 1. 读取 API（六组）

| Channel | 参数 | 返回 |
|---|---|---|
| `git:repo` | workspaceId | `GitResult<GitReadRepo>`：root/head/branch/detached/ahead/behind/shallow/bare/remote(脱敏)/gitVersion |
| `git:graph` | workspaceId + `{limit 1..500, offset 0..2000, ref?}` | `GitResult<GitGraphPage>`：commits、parents、refs、graphVersion、hasMore/nextOffset、lane layout |
| `git:refs` | workspaceId + `limit 1..500` | `GitResult<GitRefsSnapshot>`：local/remote/tags/head + sha/upstream |
| `git:status` | workspaceId | `GitResult<GitWorkingStatus>`：staged/unstaged/untracked/conflicts |
| `git:commit` | workspaceId + sha | `GitResult<GitCommitDetail>`：metadata/parents/refs/changed files/stats/diff |
| `git:diff` | workspaceId + `{scope working/staged/commit, sha?, path?, context 0..20, maxBytes 4K..1M}` | `GitResult<GitDiffPage>` |

- IPC 参数在 `electron/main.ts` 用 zod `.strict()` 校验（workspaceId、limit/offset、ref、sha、path、context/maxBytes）；未知字段拒绝。
- `GitReadService` 复用 `GitExec`（execFile、argv allowlist、hooksPath、timeout/maxBuffer、`redactSecrets`），无 shell；graph 20s/8MB、status 8s/4MB、diff 15s/8MB、detail 10s/4MB。
- 错误码：`GIT_READ_NOT_REPO/NOT_ROOT/NO_COMMITS/BAD_PARAM/BAD_REF/BAD_PATH/REF_NOT_FOUND/TIMEOUT/TOO_LARGE/DIFF_BINARY/DIFF_SUBMODULE/DEGRADED/INTERNAL`；失败不伪装空数组。

## 2. 图算法

`src/git/graph.ts` 纯函数 `layoutGraph`：

- newest→oldest；首 parent 沿当前 lane；merge parent 分配/复用其他 lane；fork 新 lane；merge 收敛最左。
- 缺失 parent 记为 `openEdges: missing-parent`，不伪造提交。
- 最多 16 lane；超限折叠并标 `truncatedLanes`；颜色 0–9。
- 分页追加后前端重新 layout（`GitGraphPanel.loadMore`），保持 lane 连续。

## 3. UI

`src/git/ui/GitGraphPanel.tsx`：

- 顶部：repo 路径/当前分支/ahead-behind/只读/刷新/引用栏开关。
- 左栏：筛选、local/remote/tags/head 引用 + worktree 列表（path/branch/bare/detached，来自 `git worktree list --porcelain`）；点击按 ref 重新加载。
- 中栏：SVG lane 装饰（`aria-hidden`）+ 提交 DOM 列表（button row、`aria-selected`、Arrow/Home/End/Enter）；500/页、最多 2000、加载更早。
- 右栏：commit metadata/refs/changed files/diff/复制 SHA；工作区 tab 展示 staged/unstaged/untracked/conflicts 与文件 diff。
- 响应式：1440 三栏；≤960 详情下沉；≤720 顶部“图/详情/工作区”tab 单栏。
- 空/错误：`role=status/alert`、重试；失败保留已有内容。

## 4. 入口

- Sidebar 操作区「版本图」按钮（secondary tool，不改变 PrimaryRail 五入口）。
- `PANEL_LAUNCHER_KEYS` 面板启动器。
- Task VCS「在版本图中查看」（传当前任务入口）。
- `#/git` 深链；不新增 primary tab。
- Command Palette 入口因 `src/CommandPalette.tsx` 不在本任务 inScope 内，未纳入本 PR；后续任务补。

## 5. 测试

- `src/git/graph.test.ts`：线性/merge/fork/openEdges/octopus >16 lane。
- `src/git/readService.git.test.ts`：真实临时 repo 覆盖 repo/graph/refs/status/commit/diff（不写工作区）。
- `src/git/readService.edge.test.ts`：非法 sha/path/ref、offset+limit、空仓库、detached HEAD、rename、submodule、大 diff too_large。
- `src/git/ui/GitGraphPanel.test.tsx`：无 bridge 降级、只读 shell、工作区文件选中后显示 diff、tablist/listbox 键盘与 aria、Enter 不双触发。
- `src/shared/deeplink.test.ts`：`#/git` 解析与 build 往返。
- 回归：现有 Git/PR/merge queue/TaskVcs 测试、panelHost deps、CommandPalette/rail。

## 5.1 t305 修复

- F2：`openWorkingFile` 保持 workspace 视图；`WorkingTree` 渲染 `workingDiff`，文件选中后显示“文件 diff”。
- F3：`status.submodules` 解析 `git submodule status --recursive`；失败时 `submodulesUnsupported`；detached HEAD graph 额外带 `HEAD`。
- F4：tabs `id/aria-controls/roving tabIndex/Arrow/Home/End`；提交列表 `role=listbox` + `option`，Arrow/Home/End 移动焦点，Enter 只由原生按钮触发一次。
- F5/F6：octopus >16 lane、fork 收敛、API 边界/空仓库/detached/rename/submodule/大 diff 测试。
- F7：diff stdout 超 8MB 映射 `GIT_READ_TOO_LARGE`；F8 rename 显示 `old → new`。
- F10：Command Palette 入口仍不在 inScope，docs 明确后续补。

## 6. 降级

非 git/非 root → `GIT_READ_NOT_REPO/NOT_ROOT` 显式错误；空/unborn → `NO_COMMITS`；bare/shallow/detached 在 repo 信息中标记；二进制/子模块 diff 返回 metadata + `reason`，不展示 hunk；大 diff 截断 `maxBytes` 或 `GIT_READ_TOO_LARGE`；大提交/工作区文件上限截断。

## 7. 真实 Electron 截图

在 Electron 45 / 1440×920 实际窗口中抓取（数据源：本仓库 main）：

- [1440 面板 + 选中提交](t305-1440-panel.png)：三栏、lane、提交详情/diff。
- [1440 工作区文件 diff](t305-1440-workspace-diff.png)：选中 tracked 文件后显示 `@@` diff。
- [960 布局](t305-960.png)：详情下沉。
- [480 布局](t305-480.png)：图/详情/工作区 tab、无横向溢出（bodyWidth=480）。

## 8. 限制/P1

- 不做写操作（checkout/merge/commit/push/stage）与多选提交操作。
- graph 只读 `--all`/单 ref，跨 ref 过滤在 UI 端；无 commit 搜索后端。
- 大仓库/长历史分页上限 2000；无虚拟列表（设计 P1）。
- 工作区文件 size/binary 未逐文件探测；二进制以 diff 判断为主。
- Command Palette 入口待后续 inScope 任务补。
