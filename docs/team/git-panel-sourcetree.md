# Git 面板 SourceTree 风格四区实现（t391 / G3）

## 范围

- 将 `GitGraphPanel` 重排为 SourceTree 风格四区：左仓库导航、右上历史表格、中间筛选条、右下工作区（暂存/未暂存 + 固定 Diff Inspector）。
- 保持 G1 写闭环：stage/unstage/commit/.gitignore、CommitGuard、写锁、审计、空仓库首提、刷新协调器、懒加载、面板隔离、IPC/数据源全部不改。
- 不新增依赖；不引入 Monaco/虚拟列表；`#/git`、Command Palette、PanelKey/title 不变。

## 四区

### 左仓库导航（220px；960 180px）

- 导航：文件状态/History、工作区变更、Search。
- 搜索分支/标签/远程。
- 分支组（`kind=local`）当前分支加粗 + 实心圆点 + ahead/behind 徽标；提交总数因 `GitReadRef` 无字段，不伪造（title 说明待只读扩展）。
- 标签、远程、HEAD、工作树组；Stash 占位「待接入」。
- 480 下导航收起为「导航」popover。

### 历史表格

- 列：lane、描述、日期、作者、提交；紧凑 22px 行高。
- 工作副本「未提交的更改 N」固定置顶（N = staged + unstaged + untracked）。
- 彩色 lane SVG；refs 徽标；点行选中提交并更新 Inspector。
- 顶部 toolbar：分支范围、排序（拓扑/日期）、Author Name 搜索、跳到提交、刷新。
- 960 隐藏日期/作者列（行 `aria-label` 保留完整信息）。

### 筛选条

- 「待定的文件 · 按状态排序」；文件路径/状态排序；紧凑列表；文件搜索。
- 过滤同时作用于已暂存/未暂存两段。

### 工作区 + Diff

- 已暂存 / 未暂存·未跟踪两段纵向；全选、批量暂存/取消暂存、逐文件 checkbox + diff。
- 提交框保持只提交已暂存 N 文件；CommitGuard inline；首提三步引导保留。
- 固定 Inspector：选中工作文件显示 diff；选中提交显示 subject/files/stats/diff；空态文案。
- 480 三 tab：历史 / 工作区 / Diff（roving tabindex，沿用 `onTabKey`）。

## 响应式

- container query `git-panel`：≥1100 四区 220px nav + 1fr；720–1099 nav 180 + 隐藏日期/作者；<720 三 tab、nav popover。
- 所有区域 `min-height:0` + 独立滚动；480 无页面级横向。

## 已知数据缺口

- 分支提交总数：`GitReadRef` 无字段，当前分支只显示 ahead/behind（title 说明）；不伪造 2661 等数字。
- Stash：无只读 API，占位「待接入」。
- 星标：P0 不做。

## 测试

- `GitGraphPanel.test`：四区 shell（导航/分支/标签/远程/Stash）、历史四列、工作副本、Author 搜索、文件过滤、已暂存/未暂存。
- `gitGraphLayout.test`：旧三栏契约保持；`gitSourceTree.test`：新 container breakpoints、固定 diff。
- G1 原有 stage/unstage/commit/guard/首提测试全部保留并通过。

## 人工冒烟清单

1. 1440 打开 `#/git`：左导航/分支/标签/远程/Stash、历史四列、工作副本、筛选条、工作区/diff 可见。
2. 960：左 nav 180，历史隐藏日期/作者；筛选/工作区/diff 不横向。
3. 480：三 tab 切换；导航 popover 可开；工作区可暂存/取消暂存，diff tab 显示选中文件；无横向。
4. 勾选未暂存文件 → 暂存选中 → 状态移入已暂存；勾选已暂存 → 取消暂存。
5. 填写标题 → 提交（N 文件）；无暂存/空标题禁用；CommitGuard 拒绝 inline。
6. 点击工作文件 diff → Inspector；点击提交 → 提交详情。
7. 刷新/重挂面板后工作区选中上下文与视图恢复（t389 行为）。
8. 空仓库首提引导 + 生成 .gitignore 预览/仅追加仍可用。

## 截图

- `docs/team/t391-git-panel-1440.png`
- `docs/team/t391-git-panel-960.png`
- `docs/team/t391-git-panel-480.png`

真实 Electron/CDP，workspace = 本 worktree；1440 全宽四区、960 收窄、480 tab。

## 风险 / 回滚

- 仅 Git 面板 UI/CSS + 测试；无 IPC/schema/命令/权限/gate 变更。
- 回滚 `GitGraphPanel` 布局与 `gitSourceTree.css` 即恢复旧三栏；G1 handlers 未改。
