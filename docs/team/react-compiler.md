# RC1-0 React Compiler spike + renderer build boundary（t510）

## 1. 结论

在 Vite 8.3.6 + React 19.3.1 + `@vitejs/plugin-react` 5.1.2 下，React Compiler **可用**，但 RC1-0 只做边界准备与单组件 spike，**不改生产组件、不改变默认构建语义**：

- 新增固定 devDependency：`babel-plugin-react-compiler@1.0.0`，**MIT**，unpacked **3,880,402 bytes（约 3.88 MB）**，无运行时依赖；
- 只允许 `src/shell/SkipLink.tsx` 一个非关键组件；kernel/review/watchdog/memory/shared/electron/scripts/tests 全部排除；
- `pnpm build` 默认 **不启用**编译器（基线不变）；`pnpm build:compiler` 通过 `RC1_COMPILER=1` 显式复现 spike；
- 默认 `pnpm test` 不编译；`pnpm test:compiler` 通过 `VITEST_REACT_COMPILER=1` 定向编译 SkipLink；
- 无 DB schema/事件/权限/IPC/runtime 依赖变更。

## 2. 依赖与许可证

| 项 | 值 |
|---|---|
| package | `babel-plugin-react-compiler` |
| version | **1.0.0**（package.json 固定精确版本） |
| license | **MIT** |
| unpacked size | **3,880,402 bytes**（`pnpm view ... dist.unpackedSize`） |
| dependency | `@babel/types ^7.26.0`（dev 工具链） |
| runtime | **无**（devDependency；不引入 `react-compiler-runtime`） |

## 3. 编译边界

`src/shell/reactCompilerBoundary.ts`（纯配置，不进入 renderer runtime）：

- allowlist：`src/shell/SkipLink.tsx`；
- exclude：`electron/`、`scripts/`、`src/kernel/`、`src/review/`、`src/watchdog/`、`src/memory/`、`src/shared/`、`dist/`、`dist-electron/`、`node_modules/`、`**/*.test.*`、`**/__tests__/**`；
- `isReactCompilerBuild`：默认 `false`；`RC1_COMPILER=1` 且 `command=build` 才启用；`VITEST`/`NODE_ENV=test` 强制关闭；`VITEST_REACT_COMPILER=1` 是独立定向测试开关；
- `reactCompilerPluginOptions.sources` 是文件级最终 guard，防止 Vite 把插件应用到 allowlist 外；
- `scripts/build-electron.mjs` 完全未接入 Babel/Compiler；boundary test 读取脚本断言无 `babel-plugin-react-compiler`/`reactCompilerBoundary`。

Vite 配置：

- `pnpm build` / `vite build`：`react()` 默认，无 Babel compiler；
- `pnpm build:compiler`：`cross-env RC1_COMPILER=1 vite build && pnpm build:electron`；
- `pnpm test`：Vitest 的 Vite 配置 branch 检测 `VITEST`，不加载插件；
- `pnpm test:compiler`：`cross-env VITEST_REACT_COMPILER=1 vitest run ...` 定向验证 SkipLink + boundary。

## 4. Spike 量化

仅编译 `src/shell/SkipLink.tsx`，生产源码未改动。记录见 `docs/team/rc1-build-metrics.json`。

| 指标 | 默认 build（无 compiler） | `build:compiler` | 变化 |
|---|---:|---:|---:|
| 总耗时（本机 warm） | **1018 ms** | **2357 ms** | +1339 ms |
| Vite renderer build | **242 ms** | **1570 ms** | +1328 ms |
| `index` | 369,017 B / gzip 109.84 kB | 369,147 B / gzip 109.92 kB | **+130 B** |
| `vendor-react` | 206,755 B / gzip 64.81 kB | 206,922 B / gzip 64.91 kB | **+167 B** |
| CSS | 150,017 B / gzip 25.44 kB | 150,017 B / gzip 25.44 kB | 0 |
| renderer sourcemap | 关闭（既有配置） | 关闭（未改） | 无变化 |

- 输出 hash：默认 `index-fKm9xc49.js` / `vendor-react-BUpqyDsC.js`；compiler `index-DckQwIra.js` / `vendor-react-Bcerwr7Q.js`。
- compiler runtime 由 React 19 目标承载，未新增 runtime package；Electron main/preload 输出与耗时未受 compiler 影响（esbuild 独立构建）。
- 单组件 Babel pass 的固定开销明显（约 +1.3s），这是 RC1-1 扩大 allowlist 前需要继续量化的成本；本 PR 不因此开启默认编译。

## 5. 验证

- `pnpm typecheck` → **0**
- `pnpm build` → **0**（默认基线；index 369.01 kB / gzip 109.84，CSS 150.01/gzip 25.44）
- `pnpm build:compiler` → **0**（compiler 输出如上）
- `pnpm test -- --max-workers=1 --testTimeout=20000` → **174 文件 / 1136 用例全绿**
- `pnpm test:compiler` → **2 文件 / 6 用例全绿**
- 边界测试 `src/shell/reactCompilerBoundary.test.ts`：版本/许可证、默认测试不编译、allowlist/exclude、kernel/electron/scripts 排除、Electron 构建脚本无 compiler。
- 无生产组件 `"use memo"`/`"use no memo"` 改动；未删除手工 memo；无业务逻辑变更。

## 6. 回滚

1. `pnpm build` 保持默认不编译；无需回滚生产语义；
2. 删除 `build:compiler` / `test:compiler` scripts；
3. 删除 `babel-plugin-react-compiler` devDependency（`pnpm remove -D`）；
4. 删除 `reactCompilerBoundary.ts`/test 与 `vite.config.ts` Babel wiring；
5. `pnpm install && pnpm build && pnpm test` 回到基线。

无 schema/DB/事件/权限/IPC 迁移；`dist`/`dist-electron` 重新生成即可。

## 7. 后续（非本 PR）

- RC1-1：annotation 试点 3–5 个非 Dock 组件，验证 effect/closure/focus 行为与 render 计数；
- RC1-2：`src/shell/**` + `src/git/ui/**` infer 白名单/opt-out；
- RC1-3：DW1-4 后全 renderer；RC1-4：门禁/清理。本 PR 不改生产组件，不提前完成这些阶段。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
