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
- `pnpm build` 0（451 modules）
- `pnpm test -- --testTimeout=20000 --maxWorkers=2` 0（127 files / 902 tests；默认并行既有 5s flake 不归因）
