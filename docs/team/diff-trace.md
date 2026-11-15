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

## 5. t485：真实 Electron/CDP 三档走查（替代「仅组件测试」口径）

本节取代上文「以组件级测试为主要证据（无 Electron 真机环境）」的旧口径——D1 已具备真实 Electron 三档证据。

**命令**：`pnpm build` → `D1_SEED_DB=<dir> D1_SEED_REPO=<dir> pnpm vitest run scripts/seedDiffTraceFixture.test.ts`（种子：任务 + 263 条 trace 事件 + git 仓库三类工作区文件）→ `T485_DB=<seed> node shot/electron-walk.cjs`（临时驱动，不入 PR；产物入 docs/team/）。

**截图索引（docs/team/）**：
- `t485-trace-1440.png`：任务历史 tab——trace 窗口/过滤/跳转/加载更早。
- `t485-diff-search-1440.png`：searchable.ts 搜索过滤 + 高亮 + 计数。
- `t485-bigdiff-confirm-1440.png`：big.txt 两步确认「加载完整 diff」。
- `t485-toolarge-1440.png`：huge.txt（8.3MB）→ GIT_READ_TOO_LARGE role=alert。
- `t485-git-960.png` / `t485-git-480.png`：960/480 档 Git 面板（480 无横向溢出）。
- 断言明细：`t485-walkthrough.json`（28 项 PASS：可见行数/命中数/scrollTop/focus data-trace-seq/尺寸）。

**走查结论（ALL PASS）**：trace 最新 100 窗口（visible=100 / 共 263）→ tool.call 过滤（52 条）→ 过滤行点击跳回 data-trace-seq=7 并 focus → 加载更早 100→200（scrollTop 保持、height 8332→16572）；diff 搜索真实键盘输入 token（10 mark 高亮 / 10 行 / 计数 1/10）→ Enter 循环（2/10）→ 无匹配态 → 清除恢复；并排在 1440 Dock pane<560 时自动 unified（disclosed，并排逻辑由组件测试覆盖）；big.txt 默认截断 → 两步确认 → 1MB 全量加载成功（截断横幅消失、展开后 400 行）；huge.txt TOO_LARGE role=alert 且面板存活（alive=true）。

**t485 顺带修复的三个真实缺陷（已入 PR）**：
1. `gitExec` maxBuffer 超限时 `err.stderr`（git CRLF 警告）掩盖 `err.message` 的 maxBuffer 信号 → 未跟踪超大文件 `--no-index` diff 被 noIndex(code=1) 成功语义吞掉、返回空 diff；修复后正确映射 `GIT_READ_TOO_LARGE`。
2. trace 过滤跳转用 `requestAnimationFrame` 可能早于 React 提交且目标 seq 可能在最新 100 窗口之外 → 改 pending-jump ref + `useLayoutEffect`，跳转时同时展开全量窗口；行 wrapper 常态 `tabIndex=-1` 保证可编程聚焦。
3. `readService.diff` 的 page 级 max-bytes 截断（单文件场景）现在也显示「加载完整 diff」（此前仅 `file.truncated`）；diff 读取错误（含 TOO_LARGE）内联进 DiffView `role=alert`，不再只进全局 banner。

## 6. t489 repair-round-2：并排命中统计 + 1440×900 补充

- **并排 stats/focus 修正**：此前 `matchStats` 以 unified 原始行为基准，并排视图下一行 SideRow 可同时含旧/新命中，Enter 循环的 total 与过滤后 DOM 行数不一致。新增 `sideMatchStats`（`gitDiffSearch.ts`）——并排模式命中统计以**过滤后的 SideRow 行数**为 hitRows、旧/新两侧命中次数之和为 totalMatches；`GitDiffViewer` 按 mode 分派（unified→matchStats / side→sideMatchStats），Enter 循环 total 与 DOM 行数严格一致。
- **测试**：`gitDiffSearch.test.ts` +3（old+new 同词一行计 1 hitRow/2 处、500 行 hitRows==filterSideRows.length 且 Enter 回绕、空查询）；`GitDiffViewer.test.tsx` +1（并排 old+new 同词组件级：过滤 SideRow=2、计数 1/2 行 · 3 处、Enter 0→1→回绕 0）。
- **1440×900 补充**：`t489-diff-search-1440x900.png` + `t489-walkthrough-1440x900.json`（真实 Electron，viewport 1440×900，真实键盘输入 token：marks=10、计数 1/10 行 · 10 处；并排按钮在该 Dock 布局下仍禁用——pane<560，与 §5 披露一致）。
- **后续（记录）**：真实 20k 行帧率/输入延迟量化（当前量化以 DOM 收敛行数与串行测试为准）。

## 7. 边界与后续

- trace 服务端游标分页（`listEventsForTask` 带 beforeSeq）留待后续——当前 2000 条上限下客户端分页已满足「不截断丢失」。
- 1440 Dock 双栏下 Git 面板 <560 宽时并排按钮禁用（自动 unified），属既有宽度断点；并排搜索已由组件测试覆盖，真实浏览器并排截图待面板更宽场景补充。
- 过滤跳转的滚动/聚焦依赖 `.trace` 容器（DOM 环境）；test-renderer 下为空操作。
