# RC1-4 React Compiler 稳定化 + 回滚演练（t572）

## 1. 冻结配置

| 项 | 固化值 |
|---|---|
| package | `babel-plugin-react-compiler` **1.0.0**（devDependency，固定版本） |
| license | **MIT** |
| 体积 | unpacked **3,880,402 bytes**（约 3.88 MB；dev 工具链） |
| runtime | **无**（不引入 `react-compiler-runtime`） |
| allowlist | `src/` 下所有 renderer `.tsx` |
| 排除 | kernel/review/watchdog/memory/shared/electron/scripts/dist/tests/非 `.tsx` |
| 默认 build | `pnpm build`：**不加载 compiler** |
| 默认 test | `pnpm test`：**不编译** |
| compiler build | `pnpm build:compiler`：`RC1_COMPILER=1 RC1_MODE=infer`（renderer only） |
| compiler test | `pnpm test:compiler`：`VITEST_REACT_COMPILER=1 RC1_MODE=infer`，renderer tests |
| Electron | `scripts/build-electron.mjs` 独立 esbuild，不引入 Babel/Compiler |

配置入口：`vite.config.ts` + `src/shell/reactCompilerBoundary.ts`；边界测试 `src/shell/reactCompilerBoundary.test.ts` 持续断言 allowlist/排除/默认关闭。

## 2. 高风险 opt-out（19 个，均保留）

RC1-2 的 11 个 + RC1-3 新增 8 个：
`SeparatorControl`、`ErrorRecoveryBar`、`FirstRunCard`、`ChatLiveBridge`、`MemoryWorkbench`、`PlanDraftPanel`、`PollPanel`、`GitDiffViewer`、`GitGraphPanel`、`MergeQueuePanel`、`GitAiDraft`、`App`、`LazyPanel`、`PanelHost`、`DockShellV2`、`DockTree`、`DockGroup`、`DockSash`、`DockDropZone`。

理由：焦点/键盘/pointer、effect/store 生命周期、异步大状态、merge gate/审计、Dock 布局命令/拖放、renderer 根状态。全部保留显式 `"use no memo"`，不清理试点 directives（没有等价/性能证明，按任务 §3 不清理）。

## 3. 回滚演练（已执行）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 1 | 不设置 `RC1_COMPILER`/`RC1_MODE` | default build 路径 |
| 2 | `pnpm build` | **907 ms**（Vite 216 ms）；index 384.02 kB / gzip 114.36；vendor-react 210.54/65.71；CSS151.25/25.70 |
| 3 | `pnpm typecheck` | 0 |
| 4 | `pnpm test -- --max-workers=1 --testTimeout=20000` | **180 文件 / 1226 用例全绿**（292.79s） |
| 5 | `pnpm build:compiler` 对照 | **5782 ms**（Vite 4700 ms）；index 432.50/136.92；vendor-react 210.71/65.81；CSS 不变 |
| 6 | `pnpm test:compiler` | **87 文件 / 440 用例全绿** |

结论：默认 build/test 与 compiler build 共用同一源码，回滚仅需保持 compiler 环境变量未设置（或移除脚本/配置），无需删除手工 memo、无需数据/DB/权限/迁移。默认产物与 RC1-3 基线一致（index 384.02 / gzip 114.36）。

硬回滚（必要时）：`pnpm remove -D babel-plugin-react-compiler` → 删除 `build:compiler`/`test:compiler` scripts → 删除 `src/shell/reactCompilerBoundary.ts`/test 与 `vite.config.ts` 的 Babel wiring → `pnpm install && pnpm build && pnpm test`。无 runtime 依赖，故无需移除运行时包；手工 memo 全部保留。

## 4. 构建/测试门禁

| 层 | 命令 | 预期 |
|---|---|---|
| 类型 | `pnpm typecheck` | 0 |
| 默认构建 | `pnpm build` | 0；无 compiler；index 384.02/114.36 |
| 默认测试 | `pnpm test`（CI flake 时 `-- --max-workers=1 --testTimeout=20000`） | 180/1226 |
| compiler 构建 | `pnpm build:compiler` | 0；index 432.50/136.92 |
| compiler 定向测试 | `pnpm test:compiler` | 87/440 |
| 边界 | `npx vitest run src/shell/reactCompilerBoundary.test.ts` | 默认关闭/kernel/electron/exclude/opt-out |

持续门禁：boundary test 在默认测试中运行；kernel/electron 排除由 `shouldCompileReactFile` + `scripts/build-electron.mjs` 独立构建保证。CI 建议分层：default test/build（无 compiler）、compiler build/test（显式）、serial extended（本仓既有 flake）。

## 5. 验证

- `pnpm typecheck` → 0
- `pnpm build` → 0（rollback 907ms；index384.02/114.36）
- `pnpm test` serial → 180 文件/1226 全绿（292.79s；plain 现有 5s flake，按既有 serial 门禁）
- `pnpm build:compiler` → 0（5782ms；index432.50/136.92）
- `pnpm test:compiler` → 87 文件/440 全绿

机器可读记录：`docs/team/rc1-4-rollback-metrics.json`。

## 6. 风险/非目标

- 全量 compiler build 耗时/包体成本已在 RC1-3 记录，本 PR 不优化、不宣称性能提升。
- 不移除手工 memo；不清理 19 个 no-memo；不改变业务/API/状态机/权限/gate/schema/IPC。
- 回滚是无数据迁移的构建回退；`dist`/`dist-electron` 重新生成即可。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
