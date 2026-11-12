# Git 工作区双列表 + Diff 查看器增强（t401 / G4）

## 范围

- 工作区左列：已暂存 / 未暂存·未跟踪上下两个独立滚动段，同屏可见；38/62 默认比例、6px 可拖拽分隔、段头固定、空段 32px 紧凑；480 降级为工作区 tab 内「已暂存 / 未暂存」段 tabs。
- Diff：文件头 path/status/+N−N/复制路径/换行；统一视图旧/新行号、+绿/−红、hunk 头、未变更块折叠；并排视图；binary/submodule/truncated/loading/empty 状态；D1 搜索槽 disabled。
- 兼容：G1 stage/unstage/commit/.gitignore/CommitGuard、GitInit、首提、#git、Command Palette、LazyPanel、刷新协调器、IPC/数据源不变。无新依赖、无 schema。

## 双列表

- `WorkingTree` 重构：`.git-ws-sections` 内两个 section；段头独立于 `.git-ws-section-list`（`overflow:auto`），实现视觉固定与独立滚动。
- 分隔条 `role="separator" aria-orientation="horizontal"`，`aria-valuemin=20`/`max=80`/`now=38`；拖拽更新比例，ArrowUp/Down ±5，Home 恢复 38/62。
- 空段 `.git-ws-section.is-empty` 固定 32px；另一段占满；两段均有文件才显示分隔条。
- 段头保留全选/批量暂存（`+ 暂存选中`）/取消暂存（`− 取消暂存选中`）；逐文件 `+`/`−`/`diff`。
- 文件行不伪造行级统计：`+`/`−` 是动作按钮；`GitWorkingFile` 没有 insertions/deletions。
- 提交框收窄为标题 + 提交按钮；正文折叠，保留原 placeholder/`aria-label="提交已暂存文件"`/只提交 staged 语义。
- 480：工作区 tab 内段 tabs（`role=tablist`），默认未暂存；选择文件自动切 Diff tab。

## Diff 查看器

- 新 `GitDiffViewer` 由现有 `GitDiffPage` 客户端解析，不新增 API：
  - `parseHunkHeader` 为每个 hunk 计算 old/new 起始行；每行给出 oldLine/newLine。
  - 文件头路径/状态/+N/−N/复制路径；工具栏统一/并排/换行 + D1 disabled 搜索槽。
  - 统一视图：`git-diff-row` grid（旧号/新号/sign/文本），`diff-add`/`diff-del` token 配色；hunk 头可折叠。
  - 未变更块：连续 context >6 折叠中间，显示「展开 N 行未变更内容」。
  - 大 diff：>1200 行或 >512KB 默认折叠 hunk，每 400 行分块「继续加载 hunk」。
  - 并排：`buildSideBySide` 将连续 −/+ 配对；内容宽 ≥560 可用，窄窗自动 unified；480 强制 unified。
  - 状态：binary/submodule/truncated/loading/empty/error 各有明确文案。
- `DiffView` 保持为薄包装，G1/G3 调用点不变。

## 测试

- `GitDiffViewer.test`：文件头/行号/配色/hunk/搜索槽/折叠展开/buildSideBySide/binary/truncated/empty/loading。
- `GitGraphPanel.test`：双段 `.git-ws-sections`/独立列表/separator 键盘比例/过滤空段紧凑；G1 stage/commit/guard/首提回归；480 段 tabs。
- `gitWorkingDiff.test`：双列表滚动、44/56、480 段 tabs、diff 行号/配色/并排 CSS。
- 保持 G1 全量测试与 `#/git` 入口。

## 截图（真实 Electron/CDP）

| 截图 | 分辨率 | 内容 |
|---|---|---|
| `docs/team/t401-git-diff-1440.png` | 1440×1000 | 双列表 + 统一 diff 行号 |
| `docs/team/t401-git-side-1440.png` | 1440×1000 | 并排 diff |
| `docs/team/t401-git-diff-960.png` | 960×1000 | 窄窗 unified、并排禁用 |
| `docs/team/t401-git-working-480.png` | 480×900 | 工作区段 tabs / 双列表降级 |
| `docs/team/t401-git-diff-480.png` | 480×900 | Diff tab unified |

执行签名：2026-11-13 01:45 +08:00，执行人 ren，Electron + CDP，workspace = `branches/t401-git-working-diff`。

## 人工冒烟清单

1. 1440 打开 `#/git`：双段同屏、独立滚动、段头计数/全选/批量可见；空段 32px。
2. 拖拽分隔条 / ArrowUp/Down / Home；比例变化且提交框不遮挡列表。
3. 勾选未暂存 → 暂存选中 → 左列移动；逐文件 +/− 生效。
4. 点文件 diff → 右栏出现文件头、行号、增删配色、hunk、折叠；换行可切换。
5. 1440 点并排 → 左右行配对；960/480 并排禁用并 unified。
6. 提交标题 + 提交 N 文件；正文展开/收起；无暂存/空标题禁用；CommitGuard inline。
7. 480 工作区 tab 段 tabs 切换；选中文件自动 Diff tab；无横向。
8. 空仓库首提、`.gitignore` 预览/追加、刷新/重挂恢复不变。

## 风险 / 回滚

- 仅 Git 面板 UI/CSS/测试/docs；无 IPC/schema/权限/G1 写语义变更。
- 回滚 `GitDiffViewer`/双列表 JSX/CSS 即恢复旧 WorkingTree/DiffView；handlers 未改。

## 已知边界

- 并排配对为客户端按 hunk 连续 −/+ 配对；复杂交叉修改可能一侧留空，不伪造行。
- 大 diff hunk 折叠阈值为 UI 启发式，不改变 IPC 的字节截断。
- D1 diff 搜索位置保留但本任务不实现。

## 验证

- `pnpm typecheck` 0
- `pnpm build` 0（452 modules）
- `pnpm test -- --testTimeout=20000 --maxWorkers=2` 0（128 files / 911 tests；默认并行既有 5s flake 不归因）

## t407 repair：大 diff 性能与交互证据

### F1 1MB / 20k 行性能

- **单测 fixture**：20,000 行纯新增、`bytes > 1MB`；折叠 hunk 默认渲染实测 **1.3 ms**，JS heap delta **1.9 MB**，HTML **1.4 KB**，DOM 行 **0**；点击 hunk 后严格 **400 行/批**上限。测试：`GitDiffViewer.test.tsx`（`[t407]` 日志）。
- **真实 Electron（1.24MB / 4177 行 IPC 截断文件）**：首次可见 hunk **146 ms**（MutationObserver 从点击到 hunk 插入），页面节点 **963**，JS heap **20 MB**；hunk 展开 400 行 **386 ms**，节点 2965，滚动不冻结。文件头显示 `4177 行 · 1239KB` 且明确「diff 已截断」。
- 大 diff 仍按 hunk 折叠 + 400 行分块；不新增 virtualization 依赖。

### F2 独立滚动 / 分隔条

- `data-git-section="staged|unstaged"` 两段独立 `overflow:auto`；真实 Electron 中未暂存 `scrollTop=200` 时已暂存保持 `0`，反向保持独立。
- `role=separator` 支持 pointerdown/move/up；真实拖动 40px / 127px 容器使 **38→69**；键盘 Arrow ±5、Home 38，20/80 clamp 单测覆盖（`gitWorkingLayout.test.ts`），`attachSectionDrag` 测试保证 pointerup 移除监听。

### F3 并排与状态

- `observeDiffWidth` 使用 ResizeObserver，宽 `<560` 自动 unified；`GitDiffViewer.test` 覆盖 559/560 边界、observer 注册/回调/disconnect。
- submodule、error、copy path、wrap、binary/truncated/empty/loading 均有断言。
- 960 真实截图：并排按钮 disabled、统一视图；1440 并排可用。

### F4 逐行 focus/aria

- 行 `role="row"`、`tabIndex=0`、`aria-label="旧行…，新行…，新增/删除/上下文：文本"`；数字单元格 `role=gridcell`。
- 真实 Electron：聚焦第一行后 `outline: 2px solid accent`，ArrowDown 移到下一行，aria-label 从新行 1→新行 2；Tab 可进入行，行可读。
- 截图：`t407-diff-focus-1440.png`。

### 布局复核修复（用户 1372×328 反馈）

- **已暂存文件可见**：修复两段 flex 收缩（首段 `flex: 0 0 ratio` + 非空段 `min-height: 58px`），实测已暂存 1 文件段 58px、文件行 24px 完整可见；未暂存 31 文件段独立滚动。
- **提交框 sticky footer**：`position: sticky; bottom: 0` + 背景/上边框；始终显示「已暂存 N 文件」，960/480 视口内可见。
- **section bar 层级**：段头（checkbox + 标题/计数 + 全选/批量）独立于文件列表；文件行只保留 badge/path + 操作。
- **行操作对齐**：`+`/`−`/`◫` 固定 24px 图标列，`title`/`aria-label` 完整；行 `flex-wrap: nowrap`，路径 flex 自适应，中间无空白。
- **标签收敛**：移除「待定的文件」文案，顶部仅保留「筛选」；工作区标题只保留一处。
- **无横向溢出**：1440/960/480 `scrollWidth` 分别等于视口宽。

### 新增截图

| 截图 | 分辨率 | 内容 |
|---|---|---|
| `docs/team/t407-big-diff-1440.png` | 1440×1000 | 1.24MB 截断大 diff 默认 hunk 折叠 |
| `docs/team/t407-big-diff-expanded-1440.png` | 1440×1000 | hunk 展开 400 行 |
| `docs/team/t407-diff-focus-1440.png` | 1440×1000 | 行 focus outline + aria |
| `docs/team/t407-big-diff-960.png` | 960×1000 | 960 大 diff unified、并排禁用 |
| `docs/team/t407-workarea-1440.png` | 1440×1000 | 双段同屏 + sticky footer |
| `docs/team/t407-workarea-960.png` | 960×1000 | 960 双段同屏 + sticky footer |
| `docs/team/t407-workarea-480.png` | 480×900 | 480 段 tabs + sticky footer |
| `docs/team/t407-workarea-close-1440.png` | 490×299 近景 | 已暂存 file 可见、行操作对齐 |
| `docs/team/t407-workarea-close-960.png` | 391×299 近景 | 960 双段/操作/提交框 |
| `docs/team/t407-workarea-close-480.png` | 386×390 近景 | 480 段 tabs/提交框 |

执行签名：2026-11-13 02:18 +08:00 / ren / Electron + CDP / 1440×1000、960×1000、480×900。

