# RC1-1 React Compiler annotation 试点 · 最终集成验收（t523）

- **任务**：t523 — 最终集成 RC1-1（t520 实现 → t521 PASS → t522 review）
- **PR**：[#76](https://github.com/DeerLuuu/deer-super-group/pull/76) — **MERGED（squash）**
- **合并提交**：`c81d913`
- **实现文档**：`docs/team/react-compiler-annotation.md`
- **指标**：`docs/team/t520-annotation-metrics.json`
- **walkthrough**：`docs/team/t520-annotation-walkthrough.json`
- **验证**：`docs/team/react-compiler-annotation-verification.md`（t521 PASS）
- **复审**：`docs/team/react-compiler-annotation-review.md`（t522 pass）
- **结论**：**PASS，已合并**；t520 worktree/branch 已清理；当前主工作区 + 其他任务 t502/t526。

## 1. 试点/性能可追溯

### 试点

显式 `"use memo"` 的 4 个非 Dock、非关键组件：

- `src/shell/SkipLink.tsx`
- `src/shell/ApprovalTerms.tsx`
- `src/shell/TaskContractChips.tsx`
- `src/shell/TaskWorkspaceTabs.tsx`

allowlist 精确扩为这 4 个；无 `"use no memo"`；annotation 模式默认；默认 `build`/`test` 仍不编译；`VITEST_REACT_COMPILER=1 test:compiler` 覆盖 6 文件/12 用例。

### 性能/产物

- 100 render：default **32.5ms** vs compiler **30.7ms**（单次）。
- app index 369.06→**370.58kB**、vendor-react +0.17kB、Vite 259→733ms、total 1038→1720ms；sourcemap/CSS 不变。
- 真实 Electron fixture 1440/960/480 无横向；ArrowRight overview→runs `aria-selected`/focus 正确。
- 截图：`t520-annotation-1440/960/480.png`、`t520-annotation-interaction-1440.png`。

## 2. 独立复跑（PR HEAD `9bd24b5`，已同步 main `6053efa`）

```text
pnpm typecheck   # exit 0（7.59s）
pnpm build       # exit 0（839ms warm；466 modules）
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 176 files / 1160 tests passed（285s）
pnpm build:compiler   # exit 0（1.41s）
pnpm test:compiler    # 6 files / 12 tests passed（0.97s）
```

> plain 并行有既有 5s timeout；串行全绿。

## 3. 无 runtime/业务变更

- PR diff：4 个试点组件各 +1 行 `"use memo"`、boundary/allowlist、pilot/compiler 测试、package 的 `test:compiler` 脚本、docs/screenshots；无 API/状态机/业务逻辑/手工 `memo` 删除。
- 无新增 runtime dependency（plugin 仍是 RC1-0 的 devDependency）；无 schema/IPC/权限/gate/事件变更。
- 默认产物/行为保持；compiler 仅显式开关；回滚文档化。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #76 | MERGED（squash） |
| merge commit | `c81d913` |
| main | `c81d913` + 本报告提交 |
| t520 worktree | 已移除 |
| t520 branch | 已删除（local/remote） |
| 当前 worktree | 主工作区 + 其他任务 t502/t526 |

## 5. 遗留（非阻塞）

1. 100 render 性能为单次采样，无可复现脚本（N1 medium）。
2. `TaskWorkspaceTabs` 轻交互是否属“非关键”可争议（N2 medium）。
3. fixture 非完整 App Dock（N3 medium）。
4. docs 中 175/1137 旧计数（N4 low）。
5. 回滚未实际演练（N5 low）。
6. 既有并行测试时序 timeout（N6 info）。

**最终结论：RC1-1 PASS，PR #76 已 squash 合并 `c81d913`；4 个显式 use memo 试点/allowlist/默认不编译/compiler 12 例/walkthrough/三档均集成验收；无 runtime/业务/API/状态机/手工 memo 变更；遗留仅为性能采样与 fixture 深度项。**
