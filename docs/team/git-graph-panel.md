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
- 左栏：筛选、local/remote/tags/head 引用；点击按 ref 重新加载。
- 中栏：SVG lane 装饰（`aria-hidden`）+ 提交 DOM 列表（button row、`aria-selected`、Arrow/Home/End/Enter）；500/页、最多 2000、加载更早。
- 右栏：commit metadata/refs/changed files/diff/复制 SHA；工作区 tab 展示 staged/unstaged/untracked/conflicts 与文件 diff。
- 响应式：1440 三栏；≤960 详情下沉；≤720 顶部“图/详情/工作区”tab 单栏。
- 空/错误：`role=status/alert`、重试；失败保留已有内容。

## 4. 入口

- Sidebar 操作区「版本图」按钮（secondary tool，不改变 PrimaryRail 五入口）。
- `PANEL_LAUNCHER_KEYS` 面板启动器。
- Command Palette Git 组「打开版本图」。
- Task VCS「在版本图中查看」（传当前任务入口）。
- `#/git` 深链；不新增 primary tab。

## 5. 测试

- `src/git/graph.test.ts`：线性/merge/fork/openEdges/16 lane。
- `src/git/readService.git.test.ts`：真实临时 repo 覆盖 repo/graph/refs/status/commit/diff（不写工作区）。
- `src/git/ui/GitGraphPanel.test.tsx`：无 bridge 降级、存在 bridge 的只读 shell。
- `src/shared/deeplink.test.ts`：`#/git` 解析与 build 往返。
- 回归：现有 Git/PR/merge queue/TaskVcs 测试、panelHost deps、CommandPalette/rail。

## 6. 降级

非 git/非 root → `GIT_READ_NOT_REPO/NOT_ROOT` 显式错误；空/unborn → `NO_COMMITS`；bare/shallow/detached 在 repo 信息中标记；二进制/子模块 diff 返回 metadata + `reason`，不展示 hunk；大 diff 截断 `maxBytes`；大提交/工作区文件上限截断。

## 7. 限制/P1

- 不做写操作（checkout/merge/commit/push/stage）与多选提交操作。
- graph 只读 `--all`/单 ref，跨 ref 过滤在 UI 端；无 commit 搜索后端。
- 大仓库/长历史分页上限 2000；无虚拟列表（设计 P1）。
- 工作区文件 size/binary 未逐文件探测；二进制以 diff 判断为主。
- UI 暂无真实 Electron 截图（构建/SSR/单测证据；发布前补 1440/960/480 真机）。
- 当前 CSS 断点：>960 三栏；≤960 详情下沉；≤720 顶部图/详情/工作区 tab；本次未用真机截图验证像素级布局。
