# Git 面板 SourceTree 风格四区设计（t390 / G3）

- **任务**：t390（requirements）；仅设计，不写生产代码
- **视觉依据**：`docs/team/git-panel-sourcetree-reference.md`（原图路径见该文档 §0）
- **代码基线**：`main@608bffa`（t355 G1 已合并；当前 `GitGraphPanel` 43KB）
- **现状**：左 refs / 中 lane 图 / 右详情 / 底部工作区；1440 三栏、960 详情下沉、720 tabs
- **目标**：重排为「左仓库导航 + 右上历史表格 + 中间筛选条 + 右下暂存/未暂存 + 右下右 diff」四区
- **约束**：G1 写语义、现有 IPC/数据源、刷新协调器、懒加载、面板隔离、a11y、`#/git`、Command Palette 不变；不新增依赖，不引入 Monaco/虚拟列表
- **结论**：本设计可直接指导实现；有 2 个**数据缺口**必须显式处理（分支提交总数、stash），P0 用现有数据降级，不伪造。

---

## 1. 设计决策摘要

1. **四区而非三栏**：左导航 220px、右上历史 `1fr`、中间筛选 30px、底部工作区 300px；工作区内部 55/45 分「暂存区 / diff」。
2. **History 是主视图**：提交表格 + 彩色 lane 列；工作副本行固定置顶；提交详情不占独立右栏，改由右下 **Inspector** 按选择上下文显示（工作文件 diff / 提交详情）。
3. **选择模型统一**：`working copy`、`commit`、`working file` 三种 selection；选中提交时 Inspector 显示提交详情，选中工作文件时显示 diff；不再用三个 Dock tabs 表达选中。
4. **响应式按面板宽度**（`@container git-panel`），不是窗口：≥1100 四区；720–1099 左 nav + 历史/工作区上下；<720 三 tab（历史/工作区/Diff），左 nav 收进「导航」popover。
5. **G1 不变**：stage/unstage/commit/.gitignore 的 handler、IPC、CommitGuard、写锁、审计、空仓库首提、`git.staged` 等全部沿用；新布局只重排入口与展示。
6. **数据不伪造**：分支提交总数当前 `GitReadRef` 没有；P0 当前分支只显示 `repo.ahead/behind` 状态徽标，其他分支不显示数字；总数徽标列为 P1 只读数据扩展。stash 同样占位。

---

## 2. 信息架构与层级

```text
GitGraphPanel（orchestrator：workspace/api/state/write handlers；保持 lazy default export）
└─ GitSourceTreeLayout（container: git-panel）
   ├─ GitTopToolbar（跨整行，36px）
   │  ├─ 分支范围 select（所有分支/当前 ref）
   │  ├─ ☑ 显示远程分支
   │  ├─ 排序 select（日期/作者/拓扑；默认拓扑）
   │  ├─ Author Name 搜索（放大镜）
   │  ├─ 跳到…（commit ref/sha 选择器）
   │  └─ 刷新按钮（aria-label="刷新 Git 面板"）
   ├─ GitRefsSidebar（左，220px）
   │  ├─ 导航：文件状态 / History / Search（当前高亮）
   │  ├─ 搜索框（分支/标签/远程名过滤）
   │  ├─ 分支组（tree，展开/折叠；当前分支加粗+实心点+状态徽标）
   │  ├─ 标签组（默认折叠）
   │  ├─ 远程组（展开/折叠）
   │  ├─ 工作树（保留现有 worktree 信息）
   │  └─ 暂存 stash 组（占位：无数据时说明“待接入”，不伪造条目）
   ├─ GitHistoryTable（右上主区）
   │  ├─ 工作副本行（置顶）：未提交的更改 N / 当前时间
   │  ├─ 列头：描述 | 日期 | 作者 | 提交（lane 区无列头）
   │  ├─ GitLaneGraph（只读 SVG；默认拓扑顺序）
   │  └─ 历史行按钮（紧凑 22px；ref chips）
   ├─ GitFilterBar（中间，30px）
   │  ├─ “待定的文件 · 按状态排序”
   │  ├─ 视图切换：紧凑列表 / 详情列
   │  └─ 文件搜索（path/status）
   └─ GitWorkspace（底部，300px）
      ├─ GitWorkingPane（左 55%）
      │  ├─ 已暂存文件（N）：取消所有 / 取消选中
      │  ├─ 未暂存/未跟踪（N）：暂存所有 / 暂存选中
      │  ├─ GitFileList（每行状态图标 + path + +/- 按钮 + diff 选中）
      │  ├─ GitCommitBox（标题/正文/只提交已暂存 N 文件）
      │  └─ 冲突/子模块/截断/首提引导/写错误（保留现状）
      └─ GitInspector（右 45%）
         ├─ 工作文件：staged/working diff
         ├─ 提交：subject/body/files/stats/diff
         ├─ 空：Select a file/commit to view diff
         └─ binary/submodule/truncated 提示
```

**明确不在本设计内**：新增 push/remote/force；新增 Git 读 API；改 App/Dock/panelRegistry/deeplink/electron；改 G1 写语义；新增依赖或 Monaco。

---

## 3. 四区尺寸/断点

### 3.1 容器查询而非 viewport

现有 `GitGraphPanel` 位于 Dock 面板内，窗口 1440 时面板可能只有 800。实现必须：

```css
.git-graph-panel { container-type: inline-size; container-name: git-panel; }
```

布局以**面板内容宽度**为断点，避免窗口 1440 但面板很窄却按四区渲染。

### 3.2 1440 四区（面板 ≥1100px）

```css
.git-st-layout {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  grid-template-rows: 36px minmax(260px, 1fr) 30px 300px;
  grid-template-areas:
    "topbar topbar"
    "nav    history"
    "nav    filter"
    "nav    workspace";
  gap: 0 8px;
  height: 100%;
  min-height: 0;
}
```

| 区域 | 尺寸 | 关键规则 |
|---|---|---|
| TopToolbar | 36px，跨两列 | 控件紧凑；作者搜索宽 180–240；刷新在右；溢出时 `flex-wrap` 仅在 <1100 发生 |
| 左 Nav | 220px，跨三行 | 独立滚动；分支树每行 24px；当前分支加粗+圆点；搜索框占满栏宽 |
| 历史 | 高度 `1fr`（约 440–500，900 高时） | 表头 24px sticky；行高 22px；工作副本行置顶 sticky；lane 区 72px |
| 筛选条 | 30px | 横跨右列；不压缩历史/工作区 |
| 工作区 | 300px（min 280 / max 360） | 内部 `grid-template-columns: 55% 45%`；暂存区与 Inspector 各自滚动 |
| diff | 工作区右 45% | 固定区，不随历史选择改变宽高；空态居中 |

历史列宽（1440）：lane `72px`、描述 `minmax(160px,1fr)`、日期 `132px`、作者 `150px`、提交 `76px`；总宽不足时先省略日期，再省略作者。

### 3.3 960 历史/工作区上下（面板 720–1099px）

```css
@container git-panel (max-width: 1099px) {
  .git-st-layout {
    grid-template-columns: 180px minmax(0, 1fr);
    grid-template-rows: 32px minmax(220px, 1fr) 28px 280px;
    grid-template-areas:
      "topbar topbar"
      "nav    history"
      "nav    filter"
      "nav    workspace";
  }
  .git-st-workspace { grid-template-columns: minmax(0, 1fr) minmax(280px, 42%); }
  .git-st-col-date, .git-st-col-author { display: none; } /* 行 aria-label 保留 */
}
```

- 左导航保持可见（180px），便于分支切换；不把左导航变成 tab。
- 历史表格隐藏日期/作者列（保留 `aria-label`/tooltip），显示描述 + SHA + ref chips；lane 宽度 56。
- 工作区仍是 55/42（约 300/280），diff 最小 280；低于 280 时进入 480 tabs。

### 3.4 480 三 tab（面板 <720px）

```css
@container git-panel (max-width: 719px) {
  .git-st-layout { display: flex; flex-direction: column; }
  .git-st-nav { display: none; } /* 由“导航”按钮打开 popover */
  .git-st-tabs { display: flex; }
  .git-st-panel[hidden] { display: none; }
}
```

- Tab：**历史 / 工作区 / Diff**（`role=tablist`，roving tabindex、Home/End、Arrow）。
- 顶部 toolbar 保留刷新/作者搜索；分支范围、排序、视图切换收进 `⋯` overflow 菜单；左导航通过 `导航` 按钮打开 popover（包含分支/标签/远程/搜索/暂存占位）。
- 历史行只显示 lane（48px）+ 描述 + SHA；日期/作者放行 `aria-label`/展开详情；点击提交切到 Diff tab。
- 工作区 tab 内部：已暂存/未暂存上下滚动；提交框固定在底部；Diff tab 显示 Inspector。
- 480 仍保留 `#/git` 入口；tab 状态不写入 hash（P0）。

### 3.5 高度与滚动

- 所有区域 `min-height:0` + `overflow:auto`；历史/工作文件/Diff 三个独立滚动，禁止页面级横向滚动。
- 900 高：工作区 300；760 高：280；480 宽高 800：workspace tab 内滚动。
- 行高 22px，lane 节点 8px、线 1.5px；不随主题缩放改变几何。

---

## 4. 现有组件复用 / 搬移 / 改造清单

| 现有位置 | 处理 | 新组件/文件 | 说明 |
|---|---|---|---|
| `GitGraphPanel` 顶层（state/load/write/ignore） | **保留改造** | `GitGraphPanel.tsx` 变 orchestrator | 保留全部 API 调用、请求 token、`lastViewByWorkspace`、G1 handlers；只替换 JSX 布局，不复制 fetch |
| 顶部 header（`git-graph-top`） | 搬移+改造 | `GitHistoryToolbar.tsx` | 加分支范围/远程/排序/作者/跳到/刷新；移除“版本图”大标题改为工具栏（面板 tab 已有标题） |
| 左 refs list（`.git-graph-refs`） | 搬移+改造 | `GitRefsSidebar.tsx` | 分支树/标签/远程/工作树/stash；当前分支圆点+加粗；搜索过滤 refs；保留 `refFilter` 选择后 `load(ref)` |
| 中 commit list + lane SVG | 拆分 | `GitHistoryTable.tsx` + `GitLaneGraph.tsx` | 历史表格列、工作副本行、ref chips、lane 只读；保留 rowRefs/roving/listbox |
| 当前详情 aside | 改造 | `GitInspector.tsx` | 合并“提交详情 + 工作 diff”；按 selection 切换；不占独立第三栏 |
| 当前 `WorkingTree` | 拆分 | `GitWorkingPane.tsx` + `GitFileList.tsx` + `GitCommitBox.tsx` | 已暂存/未暂存纵向；逐文件 +/-；批量；提交框；首提/错误/冲突/子模块保留 |
| 当前 `DiffView` | 搬移 | `GitDiffView.tsx` | 工作/暂存/提交 diff 共用；binary/submodule/truncated 提示不变 |
| `.gitignore` Modal | **保留原样** | 仍在 `GitGraphPanel`/`GitWorkingPane` | 仅入口从工作区头部移到工作区工具栏；预览/追加逻辑不变 |
| `GitInitEmptyState` / `GitInitModal` | **保留** | 同文件/`GitInitModal` | 空仓库/无 repo 分支保持；不放进四区 |
| `GitCommitGuard` / `gitStage`/`gitUnstage`/`gitCreateCommit` | **不改** | — | 后端/语义/错误不变 |
| `lastViewByWorkspace` | 改造 | 内部 map | 3 个旧值 `graph/detail/workspace` 映射为 `history/diff/workspace`；旧面板重挂恢复视图不丢 |
| `gitGraph.css` | 重写/扩展 | `gitGraph.css`（保留文件名） | 旧 `.git-graph-*` 改为 `git-st-*`；保留必要的空态/init/write 样式；`gitGraphLayout.test` 更新断点断言 |
| `GitGraphPanel.test.tsx` | 更新 | 同文件 + 新组件测试 | 选择器从 tabs/三栏迁到四区；保留 G1/写/错误/首提/键盘回归 |

### 4.1 建议文件面（实现时）

```text
src/git/ui/GitGraphPanel.tsx            orchestrator + GitInitEmptyState + ignore modal
src/git/ui/GitSourceTreeLayout.tsx      顶层 grid + container query + 480 tabs
src/git/ui/GitHistoryToolbar.tsx        topbar
src/git/ui/GitRefsSidebar.tsx           左导航/树/搜索/stash placeholder
src/git/ui/GitHistoryTable.tsx          历史表格 + working copy row + ref chips
src/git/ui/GitLaneGraph.tsx             lane SVG（从现有提取）
src/git/ui/GitFilterBar.tsx             中间筛选条
src/git/ui/GitWorkingPane.tsx           底部工作区容器
src/git/ui/GitFileList.tsx              已暂存/未暂存文件段 + 批量/逐文件
src/git/ui/GitCommitBox.tsx             提交框（从 WorkingTree 提取）
src/git/ui/GitInspector.tsx             working/commit 上下文 + 空态
src/git/ui/GitDiffView.tsx              从现有 DiffView 提取
src/git/ui/gitSourceTree.ts             纯选择/分组/排序/过滤/键盘 helpers
src/git/ui/gitGraph.css                 重写布局，保留 init/write/diff 样式
src/git/ui/*.test.tsx                   新组件测试 + 更新 GitGraphPanel.test
src/git/ui/gitGraphLayout.test.ts       更新 1440/960/480 容器查询断言
```

- **不新增** `GitGraphPanel` 以外的 App 入口；`App.tsx` 的 `loadGitGraphPanel`、`openPanel("gitGraph")`、`LazyPanel` 不变。
- 文件可合并以减少 churn（例如 `GitFileList` 合并进 `GitWorkingPane`），但组件边界/职责不可合并成一个巨型文件。

---

## 5. 交互清单

### 5.1 选择模型

```ts
type GitSelection =
  | { kind: "working" }
  | { kind: "commit"; sha: string }
  | { kind: "file"; path: string; staged: boolean }
  | { kind: "none" };
```

| 动作 | 结果 |
|---|---|
| 点工作副本行 | `selection=working`；工作区高亮；480 切到工作区 tab；Inspector 清空/显示“选择文件查看 diff” |
| 点提交行 | `selection=commit`；`loadCommit(sha)`（现有 token 防竞态）；Inspector 显示详情；480 切到 Diff tab |
| 点工作文件行/`diff` | `selection=file`；调用现有 `gitDiff({scope: staged?"staged":"working", path})`；Inspector 显示 diff；480 切 Diff |
| 点分支/标签/远程 | 现有 `refFilter` + `load(ref)`；历史/工作副本保留；当前分支高亮 |
| 关闭/重挂面板 | `lastViewByWorkspace` 恢复 tab（480）或选中项（1440/960）；选中 sha 可保留在组件会话，不要求持久化 |

### 5.2 暂存/取消暂存/提交（G1 语义不变）

- 每个未暂存/未跟踪行：`+` 暂存；每个已暂存行：`-` 取消暂存；均调用现有 `api.gitStage/gitUnstage`，传单个 path。
- 段头批量：暂存所有（unstaged+untracked）、暂存选中；取消所有暂存、取消选中；与现有 `WorkingTree` 行为一致。
- 冲突/子模块不显示 +/-；`canWrite=false` 时禁用并说明。
- 提交框只提交 `status.staged`；标题必填 ≤100、正文 ≤5000、仅本地、无 push；`writeBusy` 禁用；CommitGuard 拒绝 inline（现有文案/错误码）。
- 首提引导（三步）保留在工作区顶部；`.gitignore` 预览/仅追加 Modal 保留。
- 写后刷新：现有 `runWrite` 成功后 `loadWorking()` + 可选 `load()`；不新增轮询；失败显示 inline error + 重试。
- 选择文件只预览，不自动暂存；勾选文件只选择，不自动提交。

### 5.3 过滤/排序/搜索

| 控件 | 作用域 | 实现（无新 API） |
|---|---|---|
| 顶部 `Author Name` | 已加载提交 | `commit.authorName` 子串，大小写不敏感 |
| 顶部排序 | 已加载提交 | `拓扑（默认，保持 lane）` / `日期新→旧` / `作者 A→Z`；非拓扑顺序时隐藏 lane 列并显示说明，禁止错位图线 |
| 顶部跳到… | 已加载 refs/commits | 选择 branch/tag/sha 后 `load(ref)` 或 `loadCommit(sha)`；不新增 Git 命令 |
| 左搜索 | 分支/标签/远程名 | 客户端过滤 refs 树；不触发 API |
| 中筛选 bar 文件搜索 | staged/unstaged/untracked/conflicts | path/status 子串；客户端 |
| 中排序 | 文件段 | `状态`（默认）/`路径`；仅影响显示顺序，不改变 stage 状态 |
| 中视图切换 | 工作区 | `紧凑列表`（单行）/`详情列`（状态+路径+大小/旧路径）；纯本地 state |

- **现有提交筛选**（SHA/subject）迁入顶部 `跳到…` 旁的筛选输入或左 Search 模式；保留状态 `filter`，不丢功能。
- 搜索只作用于已加载页；`加载更早提交` 保留；不宣称全仓搜索。

### 5.4 键盘

| 区域 | 键 | 行为 |
|---|---|---|
| 全局 | Tab/Shift+Tab | 工具栏 → 左树 → 历史 → 筛选 → 文件列表 → 提交框 → Diff；焦点可见 |
| 左树 | ↑/↓/←/→ | treeitem 移动/折叠展开；Enter 选中分支并加载 |
| 历史 | ↑/↓/Home/End/Enter | 保持现有 listbox roving；Enter 选提交；Space 也可选 |
| 文件行 | Space | 切换 checkbox |
| 文件行 | Enter | 预览 diff；`+`/`-` 按钮仅点击（不分配全局字母键，避免与既有快捷键冲突） |
| 提交框 | Ctrl/⌘+Enter | 提交（仅 staged 且标题非空） |
| 480 tabs | ←/→/Home/End | roving tab；Enter 激活 |
| Diff | PageUp/PageDown | 滚动 diff（原生滚动） |

- 焦点保持：暂存/取消暂存后回到同一文件行；行消失则回到同段下一个/段头。
- 所有图标按钮有 `aria-label`/title；状态图标不只靠颜色（文字/`aria-label`）。

### 5.5 深链 / Command Palette / 布局

- `#/git` 语义不变：`parseHash` → `gitGraph=true`；App `openPanel("gitGraph")`；`buildHash({gitGraph:true})` 输出 `#/git`。
- PanelKey `gitGraph`、标题「版本图」、`PANEL_DEFS`、`panelRegistry`、`LazyPanel`、`loadGitGraphPanel` **不改**；Command Palette 不新增/删除 Git 命令。
- 可选 P1：`#/git?sha=<sha>&path=<path>`；P0 不引入，避免改变现有深链/测试契约。
- 480 的 History/Workspace/Diff tab 状态不写 hash；重挂按 `lastViewByWorkspace` 恢复。
- Dock 布局/面板隔离/刷新协调器不改；Git 面板仍默认关闭，由面板启动器/任务 VCS/`#/git` 打开。

---

## 6. G1 / 刷新 / 懒加载不变式

### 6.1 写语义（必须逐条保持）

| 能力 | 现有语义 | 新布局 |
|---|---|---|
| stage | `gitStage(workspaceId, paths)`；路径白名单/只读校验/写锁/`git.staged` 审计 | 行 `+`/批量调用同一 handler；不自动 stage |
| unstage | `gitUnstage`；只暂存文件可取消；`git.unstaged` 审计 | 行 `-`/批量；不自动 commit |
| commit | `gitCreateCommit`；只提交 staged；标题/正文限制；CommitGuard 检查所有 staged（含 rename old+new）；仅本地 | 提交框调用同一 handler；无新参数 |
| .gitignore | preview/apply；仅追加；lstat/realpath 安全；Modal | 入口移动；Modal 逻辑/文案不变 |
| 空仓库 | 首提三步引导；init 引导 | 保留在工作区/空态 |
| 权限/审计 | 只本地；无 push/force；4 审计事件 | 不新增/删除事件 |

### 6.2 刷新/懒加载/隔离

- `GitGraphPanel` 仍由 `LazyPanel` 懒加载；默认导出/文件名不变；App 不改。
- 保留现有 `load()`（repo+graph+refs）、`loadCommit()` token、`loadMore()`、`loadWorking()`、`runWrite()` 的调用关系和错误处理；新组件只接收 props/callback。
- 选择 commit 仍触发一次 `gitCommit`；选择 working file 仍触发一次 `gitDiff`；不得因布局拆分重复请求。
- App 的 120ms refresh coordinator、refresh domains、Dock 面板隔离均不改；Git 面板不参与到新的轮询。
- 保留 `lastViewByWorkspace` 的每 workspace 视图记忆（旧三值映射新三 tab）。

---

## 7. A11y 基线

- 根 `section aria-label="版本图"`，`aria-busy={loading||busy}` 保留。
- 顶部 `role="toolbar"` + `aria-label="Git 工具栏"`；刷新按钮 `aria-label`。
- 左导航 `nav aria-label="Git 仓库导航"`；分支/标签/远程组 `role=tree`/`treeitem`，`aria-expanded`，当前分支 `aria-current="true"`，roving tabindex；搜索 `<input type=search aria-label>`。
- 历史：保留 `role=listbox` + `role=option` + `aria-activedescendant` + roving tabindex（避免破坏现有键盘/测试）；列头视觉表格但 `aria-hidden` 或关联 `aria-label`，行 `aria-label` 含 subject/date/author/sha；当前行 `aria-selected`。
- 工作文件：每段 `section aria-labelledby`；checkbox 有显式 `aria-label`（含 path）；批量按钮 `aria-label` 含数量；状态图标有文字/aria-label，颜色非唯一。
- 写反馈：`role=status`/`aria-live=polite`；错误 `role=alert`；首提 `role=note`。
- Diff：`role=region aria-label="文件差异"`，`tabIndex=0`；binary/submodule 提示可读。
- 480 tabs：`role=tablist`，`role=tab`，`aria-selected`，`aria-controls`，roving，Home/End/Arrow；面板 `role=tabpanel`。
- 焦点：Modal 复用现有 `Modal`；Stage/Unstage 后焦点保持；关闭 Modal 回焦；`prefers-reduced-motion` 下 lane/hover 不动画。

---

## 8. 测试计划

### 8.1 单元/纯函数

- `gitSourceTree.ts`：`GitSelection` 转换、ref 分组（local/remote/tag/head/worktree/stash）、当前分支判定、ref 搜索、文件排序/过滤、working copy count、键盘 next index。
- 现有 `graph.ts`/`layoutGraph` 不改；lane 行仍由 `GitGraphNode` 驱动。
- `gitGraphLayout.test.ts` 改为容器查询断言（≥1100/720–1099/<720 的 grid/rows），保留“无页面横向溢出”。

### 8.2 组件测试

| 文件 | 覆盖 |
|---|---|
| `GitRefsSidebar.test.tsx` | 当前分支加粗/圆点、徽标降级、折叠、搜索、tree 键盘、refFilter 回调 |
| `GitHistoryTable.test.tsx` | working copy 置顶/N、四列/隐藏列、lane SVG、ref chips、listbox roving/Enter、非拓扑排序隐藏 lane |
| `GitHistoryToolbar.test.tsx` | author/排序/跳到/刷新、480 overflow、aria |
| `GitFilterBar.test.tsx` | 文件 filter/sort/view、空态 |
| `GitWorkingPane.test.tsx` | 已暂存/未暂存分组、批量/逐文件 +/−、提交框、CommitGuard inline、首提、冲突/子模块、.gitignore 入口 |
| `GitInspector.test.tsx` | working file diff/staged diff/commit detail/空态/binary/truncated |
| `GitGraphPanel.test.tsx` | 选择联动、480 tabs、deep-link 默认、lazy 入口不变、无重复 fetch（mock call count）、G1 回归 |
| 现有 `GitGraphPanel.test.tsx` | 更新旧 tab/三栏选择器；保留 stale commit、first-commit、stage/commit/guard 用例 |

### 8.3 手动/Electron

- 1440×900、960×760、480×800 三档真实 Electron 截图；长分支名/长 subject/100+ 文件/2000 commits；空仓库/无 repo/冲突/二进制/大 diff；键盘-only；200% 缩放；reduced motion；`#/git` 冷启动和 Command Palette 入口。
- 记录 metrics：`scrollWidth <= clientWidth`、diff 区域高度、历史行高、首屏时间（不写死机器相关数字，记录样本）。
- PR 必须附三档截图或录屏；设计实施时不替代真机。

### 8.4 命令

```bash
pnpm typecheck
pnpm build
pnpm test
```

回归重点：现有 124 文件/890 用例（G1 基线）不得减少；新增测试按组件计。

---

## 9. 文件面与实施顺序

1. **Phase 1（结构）**：`gitSourceTree.ts` + `GitSourceTreeLayout` + 容器查询 CSS；现有内容先搬入四区（同行为），测试 tab/选择器更新。
2. **Phase 2（历史和左栏）**：`GitHistoryToolbar`/`GitRefsSidebar`/`GitHistoryTable`/`GitLaneGraph`；分支树/列/ref chips；现有 filter/refFilter 保留。
3. **Phase 3（工作区/Inspector）**：拆 `WorkingTree` 为 `GitWorkingPane`/`GitFileList`/`GitCommitBox`；提取 `GitDiffView`/`GitInspector`；G1 写测试全量回归。
4. **Phase 4（响应式/a11y）**：480 tabs/nav popover；960 列隐藏；焦点/ARIA/键盘；三档截图；文档。
5. **实现 PR 范围**：仅 `src/git/ui/` + 对应 tests + docs；不改 App/electron/kernel/panelRegistry/deeplink；不引入依赖。

**建议新增测试文件**：`gitSourceTree.test.ts`、`GitRefsSidebar.test.tsx`、`GitHistoryTable.test.tsx`、`GitHistoryToolbar.test.tsx`、`GitFilterBar.test.tsx`、`GitWorkingPane.test.tsx`、`GitInspector.test.tsx`；更新 `GitGraphPanel.test.tsx`/`gitGraphLayout.test.ts`。

---

## 10. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 43KB 单组件拆分造成行为回归 | 高 | Phase 1 先搬移不改变行为；G1 全部保留；每组件测试；全量 890 回归 |
| 分支提交总数无数据 | 视觉与参考不符 | P0 只显示 ahead/behind/当前分支状态；不伪造总数；P1 只读字段需单独决策 |
| Stash 无数据 | 参考左栏缺一块 | 占位组，明确“待接入”，不造假条目 |
| 非拓扑排序导致 lane 错位 | 误导历史 | 非拓扑排序隐藏 lane + 说明；默认拓扑 |
| 2000 commits/大文件列表性能 | 卡顿 | 保留分页/`加载更早`；CSS `content-visibility`/限制渲染窗口作为 P1；不新增虚拟库 |
| 480 左导航隐藏 | 发现性下降 | 顶部「导航」按钮 + popover；`#/git`/Command Palette 不变；Tab 顺序 |
| 960 列隐藏 | 作者/日期不可见 | 行 `aria-label`/tooltip；点击提交 Inspector 显示作者/日期；P1 可展开行 |
| CSS 旧 `.git-graph-*` 测试/样式冲突 | 回归 | 统一 `git-st-*` 前缀；更新 `gitGraphLayout.test`；保留 init/write/diff 样式 |
| 深链/面板标题改变 | 回归 | 不改 PanelKey/title/route；`#/git` 原样；Command Palette 无变更 |
| Diff 固定区挤压工作区 | 窄面板不可用 | 960 42% min280；<720 变 Diff tab；工作区 min0 滚动 |
| 写语义被新 UI 绕过 | 安全/数据 | 只调用现有 `gitStage/gitUnstage/gitCreateCommit/gitIgnore*`；CommitGuard 不变；审计不变 |

**回滚**：单 PR revert；无 schema/数据/IPC/存储变更；Dock 布局 localStorage 不受影响；旧 `GitGraphPanel` 恢复即回到三栏。无需迁移/清理。

---

## 11. 未决问题 / 数据缺口（需 Captain/评审确认）

1. **分支提交总数徽标**：当前 `GitReadRef` 无 total count，`gitRepo` 只有当前 ahead/behind。P0 将当前分支徽标定义为 `↑N ↓M`（可用时）或隐藏；若要参考图的 `2661` 总提交数，需要 P1 只读数据扩展（不改写通道/不新增依赖），不在本 UI PR 内。
2. **stash**：当前无 read API；P0 只做折叠占位，P1 接入 stash list/apply。
3. **星标收藏**：参考图有星标，当前无持久字段；P0 不做，避免新增存储。
4. **排序与 lane**：P0 仅在拓扑顺序显示 lane；日期/作者排序隐藏 lane；是否要“重排后仍画图”需要重新设计 lane 数据，成本 L。
5. **480 左导航**：采用 popover 还是第四 tab；本设计选 popover，保持三 tab。
6. **提交详情位置**：本设计放右下 Inspector；若评审要求独立右栏，会回到三栏，违背 SourceTree 目标。

---

## 12. 验收映射

| 验收 | 本设计落点 |
|---|---|
| 四区 IA/尺寸/断点 1440/960/480 | §2、§3（container query、grid 伪代码、尺寸表） |
| 组件复用/搬移/改造 | §4 矩阵 + 文件面 |
| 交互：选中/暂存/筛选/排序/搜索/键盘/深链 | §5 |
| G1/刷新/懒加载/a11y 不变式 | §6、§7、§5.5 |
| 测试计划/文件面/风险/回滚 | §8–§10 |
| 仅设计文档 | 本文件，无生产代码改动 |
