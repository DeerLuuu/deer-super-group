# t360（D1）：大 diff 搜索与 trace 全量分页

- **任务**：t360 实现 D1（在 G4/t404 diff 查看器上扩展，不重写查看器）
- **分支**：`feature/t360-diff-trace-paging`（worktree 开发，PR 流程，未改 main）
- **日期**：2026-11-16（Asia/Shanghai）

## 1. 变更内容

| 文件 | 变更 |
|---|---|
| `src/git/ui/gitDiffSearch.ts`（新增） | 纯函数：`lineMatches`/`unifiedRowMatches`/`sideRowMatches`（大小写不敏感子串）、`filterUnifiedHunks`（仅保留命中行、空 hunk 隐藏）、`filterSideRows`（旧/新任一侧命中保留）、`splitHighlight`（`<mark>` 分段高亮，多处命中）、`matchStats`（命中行数/总次数）、`nextMatchIndex`（Enter/Shift+Enter 循环） |
| `src/git/ui/GitDiffViewer.tsx` | 启用预留搜索框（原 disabled 占位）：输入即过滤+高亮、命中计数（`i/N 行 · M 处`，aria-live）、无结果态（`无匹配` + 底部「没有匹配」）、Enter/Shift+Enter 跳转（scrollIntoView+focus）、清空恢复；统一/并排视图均生效；搜索模式强制展开 hunk 并绕过 400 行渲染窗口（只渲染命中行，无虚拟列表库）；无命中文件整体隐藏。新增 `onLoadFull`/`fullLoading` props：截断文件显示「加载完整 diff」**两步确认**（第二次点击才触发，提示「展示上限 1MB；管道上限 8MB，超限返回 TOO_LARGE」） |
| `src/git/ui/GitGraphPanel.tsx` | `openWorkingFile` 记录 diff 来源（scope/path）；`loadFullFileDiff` 按同文件以 `context: 20 / maxBytes: 1_048_576` 重取（IPC zod 上限 1MB；`git show/diff` stdout 8MB 管道上限，超限服务端返回 `GIT_READ_TOO_LARGE` → 现有 error role=alert 展示，不卡顿） |
| `src/App.tsx` | trace 分页：`dedupeBySeq` 去重 → 类型过滤 → `latestPage`（默认最新 100 条）；「加载更早」每次 +100（`growLimit`），prepend 后 `useLayoutEffect` 恢复滚动位置；类型 `<select>`（`traceTypeOptions` 频次降序 + 计数）；过滤模式下行可点击/Enter/Space 跳回完整 trace 对应事件（`data-trace-seq` 定位 + focus）；`traceLoadFailed` + 「重新加载」失败重试；任务切换重置分页/过滤 |
| `src/shell/tracePaging.ts`（新增） | 纯函数：`dedupeBySeq`/`filterTraceEvents`/`traceTypeOptions`/`latestPage`/`growLimit`/`pageLabel` |
| `src/git/ui/gitWorkingDiff.css`、`src/styles.css` | 搜索计数样式（含 `is-empty` 警示色）、`diff-hit` 高亮（token 色）、行 focus-visible；trace-head flex-wrap + 过滤 select + `trace-jump-row`（可点击/focus-visible）+ `trace-more` |

## 2. 设计要点

- **IPC/事件 schema 零变更**：`getTaskTrace(taskId)` 契约不变（≤2000 条一次返回），分页在渲染侧按 seq 游标推进；`gitDiff` 只用已有 `context`/`maxBytes` 参数（zod 上限 1MB），未改校验。
- **大 diff 不卡顿**：搜索统计对全量行计算（纯函数，20k 行毫秒级），渲染仅命中行；`加载完整 diff` 两步确认防误触；8MB 管道超限走既有 `GIT_READ_TOO_LARGE` 错误态（`role=alert`），主进程 `maxBuffer` 保护不阻塞。
- **aria**：搜索框 aria-label；计数 `role=status aria-live=polite`；过滤 select aria-label；跳转行 `role=button` + aria-label + tabIndex + focus-visible；「加载更早」aria-label 含当前/总数。

## 3. 测试（新增 28 例，全部通过）

- `gitDiffSearch.test.ts`（13）：匹配/高亮切分/统计/循环索引/escape；统一与并排过滤（空 hunk/文件隐藏）；**20k 行量化**（过滤后命中行与统计一致，20 < N < 200）。
- `tracePaging.test.ts`（8）：seq 去重、类型过滤、类型选项频次、latestPage 窗口、growLimit 步长、pageLabel 口径。
- `GitDiffViewer.test.tsx`（+7）：输入即过滤（含文件级隐藏）/命中计数/高亮；无结果态与清空恢复；Enter/Shift+Enter 索引循环；并排视图过滤高亮；两步确认回调路径；TOO_LARGE 错误态 role=alert；20k 行组件级 DOM 收敛（20 < 渲染行 < 200，含 diff-hit）。

## 4. 验证

- `pnpm typecheck` 0；`pnpm build` 0。
- `pnpm test --no-file-parallelism`：**161 文件 / 1074 用例全部通过**（含全部既有 GitDiffViewer/GitGraphPanel/trace 相关用例无回归）。

## 5. 边界与后续

- trace 服务端游标分页（`listEventsForTask` 带 beforeSeq）留待后续——当前 2000 条上限下客户端分页已满足「不截断丢失」。
- 过滤跳转的 `requestAnimationFrame` 定位在 test-renderer 环境为空操作（真实浏览器生效）；滚动保持依赖 `.trace` 容器 scrollTop（DOM 环境）。
- 截图：本任务以组件级测试为主要证据（无 Electron 真机环境）；后续评审可按 t452 模式补真实 Electron 三档截图。
