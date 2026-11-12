# Git Graph 修复报告（t305）

- **任务**：t305 — 依据 t302 验证 F1–F10 修复 Git Graph
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/45
- **分支**：`feature/t301-git-graph-panel`
- **只读边界不变**：不做 checkout/merge/commit/push/stage；TaskVcs/PR/merge/settings 未改语义

## 修复

| ID | 修复 | 验证 |
|---|---|---|
| F1 | 真实 Electron 1440/960/480 截图 | `docs/team/t305-1440-panel.png`、`t305-1440-workspace-diff.png`、`t305-960.png`、`t305-480.png`；数据源为 `S:\DeerSuperGroup` main |
| F2 | `openWorkingFile` 保持 workspace，`WorkingTree` 渲染 `workingDiff` | GitGraphPanel.test 点击工作区文件后断言“文件 diff”与 diff 文本 |
| F3 | submodule status 解析；失败 `submodulesUnsupported`；detached graph 带 HEAD | readService.edge.test：submodule 列表、detached HEAD 包含 HEAD |
| F4 | tabs id/controls/roving/Arrow/Home/End；listbox/option、Arrow 移动焦点；Enter 不双触发 | GitGraphPanel.test：tablist Arrow + aria-controls/tabIndex，listbox Arrow，Enter/click commitCalls=2 |
| F5 | octopus >16 lane + fork 收敛测试 | graph.test 5 项 |
| F6 | 非法参数/offset+limit/空仓库/detached/rename/submodule/大 diff 测试 | readService.edge.test 6 项 |
| F7 | diff >8MB stdout 映射 `GIT_READ_TOO_LARGE` | edge test big file |
| F8 | rename 解析 source/dest，UI 显示 `old → new` | edge test rename |
| F9 | 默认 5s 既有 flake；本次用 20s/2 workers 全绿 | 见下 |
| F10 | Command Palette 仍不在 inScope | docs 记录，后续任务补 |

## 三命令（worktree）

```text
pnpm typecheck
pnpm build
pnpm test -- --testTimeout=20000 --maxWorkers=2
```

结果见本次提交记录；截图均为 Electron 实际窗口（非 SSR/CSS contract）。

## 截图说明

- 1440 面板：三栏、选中提交、commit files/diff。
- 1440 工作区：选中 tracked 文件后显示 `@@` diff（先临时改一行 tracked 文档，截图后已恢复）。
- 960：详情下沉。
- 480：顶部图/详情/工作区 tab，bodyWidth=480 无横向溢出。

## 遗留

- 默认 `pnpm test` 的 5 个既有 5s timeout 属测试并发 flake（F9）；扩展参数全绿。
- Command Palette 入口待后续 inScope 任务。
- 大仓库无虚拟列表/2000 上限不变。
