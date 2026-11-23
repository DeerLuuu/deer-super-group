# RC1-2 React Compiler infer 白名单 · 最终集成验收（t537）

- **任务**：t537 — 最终集成 RC1-2（t534 实现 → t535 PASS → t536 review）
- **PR**：[#80](https://github.com/DeerLuuu/deer-super-group/pull/80) — **MERGED（squash）**
- **合并提交**：`53d5849`
- **实现文档**：`docs/team/react-compiler-infer.md`
- **指标**：`docs/team/t534-infer-metrics.json`
- **walkthrough**：`docs/team/t534-infer-walkthrough.json`
- **验证**：`docs/team/react-compiler-infer-verification.md`（t535 PASS）
- **复审**：`docs/team/react-compiler-infer-review.md`（t536 pass）
- **结论**：**PASS，已合并**；t534 worktree/branch 已清理；当前主工作区 + 其他任务 t544/t548。

## 1. infer/排除/行为可追溯

- infer allowlist：`src/shell/` + `src/git/ui/`；`RC1_MODE=infer` 由 `build:compiler` / `test:compiler` 使用。
- 显式排除：`src/shell/dock/`、`src/shell/panel/PanelHost.tsx`、`src/shell/LazyPanel.tsx`；固定前缀排除 tests/kernel/review/watchdog/memory/shared/electron/scripts/dist。
- 11 个高风险组件显式 `"use no memo"`（含 ErrorRecoveryBar/FirstRunCard/MemoryWorkbench/PlanDraftPanel/PollPanel/SeparatorControl/ChatLiveBridge/GitAiDraft/GitDiffViewer/GitGraphPanel/MergeQueuePanel），理由见 docs。
- 默认 `build`/`test` 不编译；compiler 构建/定向测试显式开关。
- 真实 Electron 1440/960/480 无横向；ArrowRight overview→runs `aria-selected`/focus 正确。
- 100 render：default 44ms vs infer 49.4ms（单次 +12%，重复采样噪声范围重叠；文档如实记录，不宣称提升）。

## 2. 独立复跑（PR HEAD `9925389`，main `445c04d`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；468 modules（268ms）
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 179 files / 1206 tests passed
pnpm build:compiler   # exit 0
pnpm test:compiler    # 80 files / 381 tests passed
```

> plain 并行有既有 5s timeout；串行全绿。

## 3. 无 runtime/手工 memo/依赖/业务变更

- PR diff：boundary/allowlist/guard、11 个组件各 +1 行 `"use no memo"`、package 构建/测试脚本、docs/截图；无手工 `memo` 删除、无业务/API/状态机/权限/gate 变更。
- 无新增 runtime dependency（仍是 RC1-0 的 devDependency）；无 schema/IPC。
- 默认产物 index 381.92kB/gzip113.83；compiler 387.20/116.42（+5.28kB index/+167B vendor）；CSS/sourcemap/Electron 不变。
- 回滚：删除 infer 开关/恢复脚本；文档化。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #80 | MERGED（squash） |
| merge commit | `53d5849` |
| main | `53d5849` + 本报告提交 |
| t534 worktree | 已移除 |
| t534 branch | 已删除（local/remote） |
| 当前 worktree | 主工作区 + 其他任务 t544/t548 |

## 5. 遗留（非阻塞）

1. compiler build 7.55s vs 文档 3.69s；100 render +12% 单次，需后续稳定基准（N1 medium）。
2. ConsolePanel/AgentSwitcher/TaskComposeModal/GitPanels 等未加 `"use no memo"`，需逐项评估（N2 medium）。
3. fixture 非完整 App Dock（N3 medium）。
4. docs timing 旧值（N4 low）。
5. 既有并行测试时序 timeout（N5 info）。

**最终结论：RC1-2 PASS，PR #80 已 squash 合并 `53d5849`；shell/git UI infer allowlist、Dock/PanelHost/LazyPanel 排除、11 个 use no memo、默认不编译、compiler 80/381、三档/ArrowRight 均集成验收；无 runtime/手工 memo/业务/权限变更；遗留仅为性能基准与覆盖范围项。**
