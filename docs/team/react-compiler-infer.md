# RC1-2 React Compiler infer 白名单（t534）

## 1. 范围与边界

在 RC1-0/RC1-1 之上，对 **`src/shell/**` + `src/git/ui/**`** 的 `.tsx` 开启 compiler **infer**，但明确排除 Dock 重写/面板基础设施：

- 不编译：`src/shell/dock/**`（DW1-2/3 范围）、`src/shell/panel/PanelHost.tsx`、`src/shell/LazyPanel.tsx`、所有 `*.test.*`/`__tests__/**`；
- 不编译：kernel/review/watchdog/memory/shared/electron/scripts/dist，及所有非 `.tsx`；
- 默认 `pnpm build`/`pnpm test` 仍不编译；`pnpm build:compiler` 使用 `RC1_MODE=infer`，`pnpm test:compiler` 覆盖 shell+git UI 测试；
- 未删除任何手工 memo；无业务/API/状态机/权限/gate/schema/IPC/运行时依赖变更。

## 2. 高风险 opt-out（显式 `"use no memo"`）

以下行为敏感组件保留 compiler 边界但显式退出，理由为交互/effect/大状态或审计 gate：

| 文件 | 理由 |
|---|---|
| `src/shell/SeparatorControl.tsx` | pointer + Arrow/Home 键盘、焦点/宽度 live 调整 |
| `src/shell/ErrorRecoveryBar.tsx` | role=alert、retry/关闭/详情状态 |
| `src/shell/FirstRunCard.tsx` | onboarding 展开/收起与 primary action |
| `src/shell/chat/ChatLiveBridge.tsx` | store/订阅/effect 生命周期 |
| `src/shell/MemoryWorkbench.tsx` | 大量异步 tab/搜索/发布状态 |
| `src/shell/PlanDraftPanel.tsx` | 焦点、确认/取消、高风险 ack |
| `src/shell/PollPanel.tsx` | 异步投票/创建/关闭状态 |
| `src/git/ui/GitDiffViewer.tsx` | 大 diff/搜索/两步加载/焦点/键盘 |
| `src/git/ui/GitGraphPanel.tsx` | 图/工作区异步读取、splitter/焦点 |
| `src/git/ui/MergeQueuePanel.tsx` | merge gate/approval/head reset/通知审计 |
| `src/git/ui/GitAiDraft.tsx` | AI 草稿生成/脱敏/复制/重试 |

RC1-1 的 4 个试点（SkipLink/ApprovalTerms/TaskContractChips/TaskWorkspaceTabs）继续显式 `"use memo"`。

## 3. 构建/产物

| 指标 | 默认 build（无 compiler） | infer compiler build | 变化 |
|---|---:|---:|---:|
| 总耗时（本机 warm） | **1009 ms** | **3690 ms** | +2681 ms |
| Vite renderer | **238 ms** | **2690 ms** | +2452 ms |
| `index` | 381.92 kB / gzip 113.83 | 387.20 kB / gzip 116.42 | **+5.28 kB** |
| `vendor-react` | 206.75 kB / gzip 64.81 | 206.92 kB / gzip 64.91 | +0.17 kB |
| CSS | 150.01 kB / gzip 25.44 | 150.01 kB / gzip 25.44 | 0 |
| sourcemap | 关闭（既有） | 关闭（未改） | 无 |
| Electron main/preload | 既有 esbuild | 既有 esbuild（未接 compiler） | 无 |

- 主要 chunk 变化：`MemoryWorkbench` 30.52→35.56 kB、`GitGraphPanel` 52.17→58.99 kB、`PollPanel` 16.51→17.97 kB；其余 shell/git chunks 基本不变。
- 生成差异来自 infer 的自动 memo 代码；高风险组件的 no memo 限制生效（它们不因 directive 被自动改写；文件 chunk 仍可能因同文件其他内部函数/构建 hash 变化）。
- 无新增 runtime package；React 19 target 复用既有 runtime。

## 4. 单测 / 三档 / 交互 / 性能

- `pnpm test:compiler`：**80 文件 / 381 用例全绿**（shell+git UI 全量测试在 infer 编译下）。
- `pnpm test`：**179 文件 / 1206 用例全绿**（默认不编译）。
- 真实 Electron fixture（production 组件/CSS；shell 组件，不伪称完整 App Dock）：
  - 1440/960/480 三档 `scrollWidth===innerWidth`，无横向裁切；
  - ArrowRight：`overview → runs`，aria-selected/focus 正确；
  - 截图：`t534-infer-1440/960/480.png`，交互 `t534-infer-interaction-1440.png`。
- 100 次 render 基准（真实 Electron，fixture）：default 44 ms vs infer 49.4 ms（单次约 +12%）；重复采样范围 default 7.8–20 ms、compiler 12.8–25 ms，存在明显噪声/无稳定回归。记录为警告，不宣称性能提升；如后续持续回归则缩小 allowlist。
- 行为回归：shell/git UI 全量测试在 compiler 模式全绿；高风险组件 no memo 保持原语义；无手工 memo 删除。

## 5. 回滚

1. `RC1_COMPILER` 未设置 → 默认 build/test 基线；
2. 删除 11 处 `"use no memo"`（或保留作为文档），将 allowlist 收回到 RC1-1 的 4 个文件；
3. 删除 `build:compiler`/`test:compiler` 的 `RC1_MODE=infer` 参数，恢复 annotation；
4. 无需 DB/schema/权限/事件迁移；`dist` 重建。

## 6. 验证

- `pnpm typecheck` → 0
- `pnpm build` → 0（默认；381.92 kB/gzip113.83，CSS150.01/25.44）
- `pnpm test` → **179 文件 / 1206 用例全绿**（64.52s）
- `pnpm build:compiler` → 0（infer；387.20 kB/gzip116.42）
- `pnpm test:compiler` → **80 文件 / 381 用例全绿**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
