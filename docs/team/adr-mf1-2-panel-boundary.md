# ADR MF1-2：面板边界、import 白名单与 chunk budget

- **状态**：Accepted（MF1-2，t580）
- **日期**：2026-11-24
- **关联**：MF1-1（编译期 PanelManifest，t571）、ARCH §5
- **范围**：只固化边界测试/预算/文档；无业务、权限、gate、schema、IPC、运行时依赖变更。

## Context

MF1 已决定 0.0.1 采用“模块化单体”：编译期 PanelManifest + 现有动态 `import()` + `PanelHost`/`LazyPanel` 契约，不引入运行时微前端。面板已经按 Vite 动态 import 拆成独立 chunk，但契约仍靠约定：面板模块可以无意中 import kernel/memory 服务端代码、跨面板 import，或把共享依赖膨胀成新的大 chunk。

需要把以下约束变成可执行门禁：

1. panel 懒加载模块只能依赖纯 UI/类型白名单；
2. 只有 loader map 动态 import 面板入口，面板不反向依赖 App/DockTree；
3. 每个 panel chunk 有基线/阈值，超限必须拆分或显式评审；
4. 运行时微前端的引入有明确触发条件，而不是顺手扩大依赖面。

## Decision

### 1. 面板边界白名单

- 懒加载入口（与 `PANEL_LOADERS` 一一对应）：
  - settings → `src/SettingsView.tsx`
  - team → `src/TeamDashboard.tsx`
  - board → `src/shell/MemoryWorkbench.tsx`
  - polls → `src/shell/PollPanel.tsx`
  - planDraft → `src/shell/PlanDraftPanel.tsx`
  - gitGraph → `src/git/ui/GitGraphPanel.tsx`
  - mergeQueue → `src/git/ui/MergeQueuePanel.tsx`
- 面板 transitive 相对 import **不得**进入 `src/kernel`、`src/review`、`src/watchdog`、`src/memory`、`src/electron`、`electron`。唯一例外是 `src/memory/types.ts` 的 **type-only** import（board 面板的纯类型契约）；value import 仍禁止。
- `src/shared` 只允许显式白名单：types/interactive/models/translation/copy/errorRedaction/gitAi/kernelUi/modalStack/memberRecommendation/poll/planDraft。新增 shared import 必须改白名单并评审。
- 懒加载 panel 之间不得直接相对 import；共享 UI（Modal/EmptyState/Markdown 等）仍可作为纯 UI 工具。
- panel 不得反向 import App、DockTree/DockShell、panelManifest/panelLoaders。
- App 可以用 panel 的 **type-only** export（当前 `SettingsSection`）；运行时 panel 值必须经 `PANEL_LOADERS`。
- 只有 `src/shell/panel/panelLoaders.ts` 可以动态 import 面板入口；其他源码不得出现第二份 loader。

门禁：`src/shell/panel/panelBoundary.test.ts` 扫描源码 import 图（含 type-only 标记）、动态 import、loader 映射、反向/跨面板/服务端目录。

### 2. Chunk budget

当前 Vite 构建的 lazy panel JS chunk 基线（minified bytes）：

| panel | baseline | budget |
|---|---:|---:|
| settings | 26,185 | 33,000 |
| team | 46,386 | 58,000 |
| board | 30,485 | 39,000 |
| polls | 16,473 | 21,000 |
| planDraft | 8,922 | 12,000 |
| gitGraph | 52,136 | 66,000 |
| mergeQueue | 8,756 | 11,800 |

- budget 约为基线 +25–35%，留出常规小改动空间；超限必须拆分或在本 ADR/测试中显式说明并更新阈值。
- `PANEL_CHUNK_BUDGET_BYTES` 位于 `src/shell/panel/panelChunkBudget.ts`；`checkPanelChunkBudget` 对超限返回 violations，测试用 exact-budget/over-budget 双向断言。
- 基线来自本次 `pnpm build`；记录构建模块数与主要 chunk 尺寸在 PR/报告。预算不引入运行时依赖，不是发布时动态配置。

### 3. 运行时微前端触发条件

继续不做 module federation / iframe / remote panel，除非以下条件**同时**满足：

1. 至少一个 panel 需要独立于主应用发布/回滚；
2. 该 panel 有独立团队/独立构建流水线；
3. 有明确的安全边界（CSP/remote origin/签名/权限）设计；
4. 收益（发布独立性）大于共享状态/版本兼容/安全复杂度。

触发时先做 MF1-3 spike（不进生产），测量收益/成本并更新 ADR；否则保持编译期 manifest + 动态 import。

## Consequences

- 面板间共享状态/样式仍通过现有 props/IPC；边界测试能提前发现“面板偷偷 import kernel/memory”或跨面板耦合。
- 新增 shared 纯工具需要白名单变更，增加少量评审成本，但避免把服务端代码打进 renderer panel chunk。
- chunk budget 是静态阈值，不承诺首屏指标；若 Vite 产物变化导致基线整体移动，按构建数据更新 ADR/阈值，不能静默放宽。
- 无运行时/数据/事件/权限变更；回滚只需删除本 ADR/测试/预算模块，不影响应用行为。

## Enforcement / rollback

- `pnpm test` 执行 `panelBoundary.test.ts`；`pnpm build` 后记录 panel chunk 尺寸。
- 回滚：删除 `panelBoundary.test.ts`、`panelChunkBudget.ts` 与 ADR；无生产代码/数据迁移。

## Verification

- `pnpm typecheck` — exit 0
- `pnpm build` — exit 0；**471 modules**；index `386.03 kB / gzip 114.91`；panel lazy chunks 与上表基线一致；无新依赖/无 remote/federation。
- `pnpm test -- --testTimeout=30000 --maxWorkers=1` — **182 文件 / 1236 用例**全绿；新增 `panelBoundary.test.ts` 7 例（边界/白名单/loader 方向/chunk baseline/over-budget）。
- 本 PR 仅新增测试、纯预算模块、ADR；未改 App/panel 业务、权限、gate、schema、IPC。
