# RC1-4 Compiler 稳定化与回滚 · 最终集成验收（t575）

- **任务**：t575 — 最终集成 RC1-4（t572 实现 → t573 PASS → t574 review）
- **PR**：[#85](https://github.com/DeerLuuu/deer-super-group/pull/85) — **MERGED（squash）**
- **合并提交**：`60787da`
- **实现/指标**：`docs/team/react-compiler-stabilization.md`、`docs/team/rc1-4-rollback-metrics.json`
- **验证**：`docs/team/react-compiler-stabilization-verification.md`（t573 PASS）
- **复审**：`docs/team/react-compiler-stabilization-review.md`（t574 pass）
- **结论**：**PASS，已合并**；t572 branch/temp worktree 已清理；当前主工作区 + 其他任务 t576/t580/t584。

## 1. 配置/回滚可追溯

- compiler 冻结：`babel-plugin-react-compiler@1.0.0`，MIT，unpacked 3,880,402B，devDependency，**无 runtime 依赖**。
- allowlist：`src/` 下所有 renderer `.tsx`；排除 kernel/review/watchdog/memory/shared/electron/scripts/dist/tests/非 `.tsx`。
- 19 个高风险 opt-out 保留 `"use no memo"`；不清理试点 directives。
- 默认 `pnpm build`/`pnpm test` **不加载/不编译**；`build:compiler`/`test:compiler` 显式 `RC1_COMPILER=1 RC1_MODE=infer`；Electron 由独立 esbuild 构建，不引入 Babel。
- 持续门禁：typecheck / default build / default test（serial）/ build:compiler / test:compiler / boundary test；kernel/electron 排除由 `shouldCompileReactFile` + `build-electron.mjs` 保证。
- 回滚：soft = 不设环境变量走 default build；hard steps = remove devDependency + scripts + boundary/vite wiring + install/build/test；无手工 memo 删除、无数据/DB/权限迁移。

## 2. 独立复跑（PR HEAD `f28dbcb`）

> 集成期间 t572 的 branch worktree 被外部清理；本次从 PR HEAD 创建临时 detached worktree（代码树与 main 444cab1 仅差 2 个 docs）复跑，完成后已移除。

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；471 modules；197ms
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 181 files / 1229 tests passed（272.56s）
pnpm build:compiler   # exit 0
pnpm test:compiler    # 88 files / 443 tests passed（7.73s）
```

> plain 并行有既有 5s timeout；串行全绿。

## 3. 无 runtime/业务变更

- PR 仅 2 个 docs（+149 行）：`react-compiler-stabilization.md`、`rc1-4-rollback-metrics.json`。
- 无 `src/`/`electron/`/package/lock 变更；无 runtime/业务/API/状态机/手工 memo 删除。
- 无 schema/IPC/权限/gate/事件变更；无数据迁移。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #85 | MERGED（squash） |
| merge commit | `60787da` |
| main | `60787da` + 本报告提交 |
| t572 branch worktree | 外部已移除；临时 detached worktree 已移除 |
| t572 branch | 已删除（local） |
| 当前 worktree | 主工作区 + 其他任务 t576/t580/t584 |

## 5. 遗留（非阻塞）

1. docs 中 180/1226、index384.02/compiler432.50 与当前 181/1229、386.03/434.51 有差异；本次报告已按实测更新（N1 medium，仅文档口径）。
2. hard 回滚仅文档步骤，未实际演练（N2 low）。
3. PR 仅 docs（N3 low）。
4. 既有并行测试时序 timeout（N4 info）。

**最终结论：RC1-4 PASS，PR #85 已 squash 合并 `60787da`；compiler 配置冻结/allowlist/排除/19 no-memo/默认不编译/门禁/soft-hard 回滚均集成验收；默认/compiler 命令 181/1229 与 88/443 全绿；无 runtime/业务/数据迁移；遗留仅为文档计数与 hard 回滚演练项。**
