# RC1-0 React Compiler spike 与构建边界 · 最终集成验收（t513）

- **任务**：t513 — 最终集成 RC1-0（t510 实现 → t511 PASS → t512 review）
- **PR**：[#74](https://github.com/DeerLuuu/deer-super-group/pull/74) — **MERGED（squash）**
- **合并提交**：`9e94b45`
- **实现文档**：`docs/team/react-compiler.md`
- **指标**：`docs/team/rc1-build-metrics.json`
- **验证**：`docs/team/react-compiler-verification.md`（t511 PASS）
- **复审**：`docs/team/react-compiler-review.md`（t512 pass）
- **结论**：**PASS，已合并**；t510 worktree/branch 已清理；当前主工作区 + 其他任务 t502/t506。

## 1. 边界/测试隔离可追溯

- `babel-plugin-react-compiler@1.0.0` 为 **devDependency**（MIT，unpacked ~3.88MB），无运行时依赖。
- 仅 renderer build 在 `RC1_COMPILER=1` 时启用（`vite.config.ts` + `src/shell/reactCompilerBoundary.ts`）。
- allowlist 仅 `src/shell/SkipLink.tsx`；排除 `electron/`、`scripts/`、`src/kernel/`、`src/review/`、`src/watchdog/`、`src/memory/`、`src/shared/`、tests/spec，文件级 guard。
- 默认 `pnpm build`/`pnpm test` 不编译；`RC1_COMPILER=1 pnpm build:compiler`、`VITEST_REACT_COMPILER=1 pnpm test:compiler` 可复现。
- `scripts/build-electron.mjs` 完全独立，Electron 输出不受 compiler 影响。
- 回滚：移除 devDependency/plugin + 恢复 vite config；文档化。

## 2. 独立复跑（PR HEAD `362a60f`，main `82e54c4`）

```text
pnpm typecheck   # exit 0（7.35s）
pnpm build       # exit 0（本机 warm 0.87s；文档基线 1.02s）
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 174 files / 1136 tests passed（279s）
```

附加 compiler 边界命令：

```text
pnpm build:compiler   # exit 0（2.27s）
pnpm test:compiler    # 2 files / 6 tests passed（0.85s）
```

## 3. 无生产残留/无运行时依赖/gate 不变

- PR diff：`package.json`、`pnpm-lock.yaml`、`vite.config.ts`、`reactCompilerBoundary.ts/test`、docs；无生产组件代码改动（`SkipLink.tsx` 未改）。
- 仅新增 devDependency；默认产物 index 369.01kB/gzip109.84、CSS150.01/25.44 与基线一致；compiler 产物仅 +130B（vendor-react +167B），CSS/sourcemap/Electron 不变。
- 无 schema/IPC/权限/gate/审批/事件日志变更；权限模式与 review/merge gate 不受影响。
- 默认测试不加载 compiler plugin；测试隔离由 boundary 5 例 + `test:compiler` 6 例覆盖。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #74 | MERGED（squash） |
| merge commit | `9e94b45` |
| main | `9e94b45` + 本报告提交 |
| t510 worktree | 已移除 |
| t510 branch | 已删除（local/remote） |
| 当前 worktree | 主工作区 + 其他任务 t502/t506 |

## 5. 遗留（非阻塞）

1. 文档 build 时间（1018/2357ms）与本次 warm-run（873/2272ms）口径不同；均在秒级（N1 low）。
2. 回滚仅文档化，未实际演练（N2 low）。
3. 无 compiler 生成代码 diff 对比（N3 low）。
4. `test:compiler` 仅 2 文件/6 例（N4 low）。
5. 既有并行测试时序 timeout（N5 info；CI 串行）。

**最终结论：RC1-0 PASS，PR #74 已 squash 合并 `9e94b45`；Compiler 仅 devDependency、renderer build allowlist、kernel/electron/scripts/shared/tests 排除、默认 build/test 不编译、回滚文档化；无生产组件残留/运行时依赖/gate 权限变更；遗留仅为 timing/演练/覆盖深度项。**
