# P1-7：重面板懒加载与 vendor 拆分（t323）

- **任务**：t323 — 第二批性能 R4：重面板 React.lazy、Suspense fallback、vendor 拆分
- **基线**：main `b1b939d`（t322 后）
- **分支**：`feature/t323-lazy-panels`
- **结论**：低频重面板已拆为 lazy chunks；vendor（dockview/react/markdown/zod）独立；入口 JS **1,320.16 kB → 308.23 kB**（gzip 365.15 → 91.84 kB）。Chat/Dock/rail/Workflow/NeedsMe 仍同步首屏；Team 为默认可见右侧面板，其 45.61 kB 独立 lazy chunk 在 entry 后加载（Captain t327 裁决接受）；深链/恢复直接打开懒面板；失败有错误态+重试。

---

## 1. 实现

### 1.1 懒加载面板

新增 `src/shell/LazyPanel.tsx`：

- `React.lazy(load)` + `Suspense`；fallback 是 panel 内骨架（`role=status`、`aria-busy`），`min-height:320px`（480 下 240px），不改变 Dock panel 高度。
- `LazyPanelBoundary` 捕获 chunk/渲染错误：显示“{label}加载失败”+重试；重试通过 `attempt` 重新创建 lazy 组件（不是复用已拒绝的 lazy 缓存）；不泄漏路径/凭据。
- 只替换“何时加载组件”，不改变任何 props、数据源、callbacks、权限/gate/数据语义。

| Panel | 懒加载 | 最终 chunk（raw / gzip） |
|---|---|---|
| SettingsView | 是 | 21.81 kB / 6.28 kB |
| TeamDashboard | 是 | 45.61 kB / 14.36 kB |
| MemoryWorkbench | 是 | 29.54 kB / 8.20 kB |
| PollPanel | 是 | 16.45 kB / 5.37 kB |
| GitGraphPanel | 是 | 14.34 kB / 4.98 kB |
| MergeQueuePanel | 是 | 6.76 kB / 2.31 kB |
| PlanDraftPanel | 是 | 8.94 kB / 3.26 kB |
| WatchdogPanel | 否（t327 F2：`BudgetBar`/`WatchdogAlertBanner`/`WatchdogPanel` 同模块静态 import，dynamic import 无效；已删除假 LazyPanel，直接同步渲染） | 合并入 entry；模块仅 7.8 kB |
| MailboxView | 否（App 内部组件；不在本次拆文件范围） | entry |

### 1.2 vendor 拆分（vite.config.ts）

`build.rollupOptions.output.manualChunks`：

- `vendor-dockview`：dockview-core/dockview-react；
- `vendor-react`：react/react-dom/scheduler；
- `vendor-markdown`：react-markdown/remark/rehype/unified/micromark 等；
- `vendor-zod`：zod；
- 应用 entry 保留 Chat/Dock/rail/Workflow/NeedsMe 与壳层。

### 1.3 构建结果

```text
dist/assets/index-Ctcr_PJw.js             308.23 kB │ gzip: 91.84 kB   ← 原 1,320.16 / 365.15
dist/assets/vendor-dockview-CPJUTaAw.js   414.89 kB │ gzip: 97.22 kB
dist/assets/vendor-react-BUpqyDsC.js      206.75 kB │ gzip: 64.81 kB
dist/assets/vendor-markdown-DT2bv0Jw.js   164.39 kB │ gzip: 49.32 kB
dist/assets/vendor-zod-CE2qNZLN.js         87.21 kB │ gzip: 24.79 kB
dist/assets/TeamDashboard-CvV5yvPW.js      45.61 kB │ gzip: 14.36 kB
dist/assets/MemoryWorkbench-B_ju8en5.js    29.54 kB │ gzip:  8.19 kB
dist/assets/SettingsView-bHEIGeZI.js       21.81 kB │ gzip:  6.28 kB
dist/assets/PollPanel-C_2phCwh.js          16.45 kB │ gzip:  5.36 kB
dist/assets/GitGraphPanel-B2toSzge.js      14.34 kB │ gzip:  4.98 kB
dist/assets/PlanDraftPanel-DtSNNPHb.js      8.94 kB │ gzip:  3.26 kB
dist/assets/MergeQueuePanel-CEp9MZQK.js     6.76 kB │ gzip:  2.30 kB
dist/assets/index-Bz-h_nEd.css             128.37 kB │ gzip: 22.01 kB
dist/assets/vendor-dockview-DxqvY0f4.css   136.04 kB │ gzip: 10.89 kB
```

- `entry` 从 1,320.16 kB 降到 **308.23 kB（-76.7%）**；gzip 从 365.15 → **91.84 kB**。
- 首屏加载 vendor + Chat 壳 + 默认可见 Team 的独立 chunk（Captain t324/t327 裁决：Team 45.61 kB lazy chunk 在 entry 后加载可接受；首屏目标不是“Team 不加载”，而是 entry 只含 Chat/Dock/rail/Workflow/NeedsMe + Team 独立 chunk）。
- Watchdog 不参与懒加载：t327 F2 发现它与首屏 `BudgetBar`/`WatchdogAlertBanner` 同模块静态 import，dynamic import 无效（INEFFECTIVE_DYNAMIC_IMPORT）；已删除假 LazyPanel，直接同步渲染，避免假优化。
- 不新增依赖、不做微前端/React Compiler。

---

## 2. Suspense / 错误 / 深链

- fallback：panel 内骨架 + `role=status`/`aria-busy`，`min-height` 避免 Dock 跳动；480 下 240px。
- 失败：`LazyPanelBoundary` 显示错误 + 重试；不影响其他 panel；错误细节不写 UI。
- 深链/恢复：`openPanel`/Dock 恢复仍先创建 PanelHost，再由 `LazyPanel` 加载；`#/git`、`#/merge`、`#/settings`、`#/tasks?merge=1` 的解析/打开流程不变；懒加载期间显示 skeleton，不白屏。
- pending 面板在 chunk 未完成时仍可再次操作；React.lazy 由浏览器缓存 chunk，打开后复用。

---

## 3. 回归

- Chat/Dock/rail/Workflow/NeedsMe：不在 lazy 面板内，首屏同步；R1/R2/R3 既有测试通过。
- Settings/Team/Memory/Poll/GitGraph/MergeQueue/PlanDraft：props/数据源/callbacks 原样，仅加载边界替换。
- `panelHost`/`panelDeps`/Dock 布局/窄窗/深链/权限/gate 未改；MergeQueue 的确认 Modal 与 mergeStart gate 不变。
- 480/960/1440：无布局/CSS 结构改写；fallback 采用 min-height + 响应式（480 240px），三档 fallback 截图见 §4；既有三档截图/布局测试继续通过。

---

## 4. 测试

- `src/shell/LazyPanel.test.tsx`：
  1. deferred loader → 先显示 `role=status` skeleton，再加载 panel；
  2. chunk reject → 错误态 + 重试；重试重新调用 loader 并成功（不复用失败缓存）。
- `src/shell/lazyPanelsApp.test.tsx`（t327 F3，App 级）：
  1. `#/git` 深链 → App bootPanel → PanelHost → LazyPanel fallback；gate 释放后显示真实懒面板；
  2. 懒面板渲染失败 → App 内 LazyPanelBoundary 错误态 → 点击重试 → 成功；不是只测 LazyPanel 单测。
- 既有 `src/shared/deeplink.test.ts` 覆盖 `#/git`、`#/merge`、`#/settings?git=1`；`src/shell/mergeQueueApp.test.tsx` 覆盖 App 级 `openPanel`/Dock close/reopen。
- 1440/960/480 fallback 截图（真实 Chromium 渲染构建产物 CSS；fixture 仅含 LazyPanel fallback 结构，不含业务数据）：
  - [t327-1440-fallback.png](t327-1440-fallback.png)
  - [t327-960-fallback.png](t327-960-fallback.png)
  - [t327-480-fallback.png](t327-480-fallback.png)
- 全量：`pnpm test -- --testTimeout=20000 --maxWorkers=2` → **114 文件 / 838 用例** 全绿。

---

## 5. 命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **0** |
| `pnpm build` | **0**：443 modules；入口 308.23 kB/gzip 91.84；见 §1.3 |
| `pnpm test -- --testTimeout=20000 --maxWorkers=2` | **0**：114 文件/838 用例（最终复跑） |
| `pnpm test` 裸跑 | 既有 service/watchdog 5s 并发 flake，不归因本 PR |

---

## 6. 风险 / 回滚

| 风险 | 缓解 |
|---|---|
| 懒加载首次打开延迟 | skeleton 占位 + 浏览器 chunk 缓存；低频面板不阻塞首屏 |
| chunk 加载失败 | ErrorBoundary + 重试；不影响其他 panel |
| 深链打开时 chunk pending | Suspense fallback 保持 panel 高度；Dock 恢复后加载 |
| vendor 拆分手动规则漏包 | 只拆 node_modules 已知域；未匹配依赖自动留在 entry；build 检查 chunk 列表 |
| 旧 Dock 存档不含新 panel key | 默认关闭/恢复逻辑不变；旧存档忽略未知 key |
| 回滚 | 移除 `LazyPanel` 包装/恢复静态 import，删除 manualChunks；不涉及数据/存储迁移 |

## 7. 明确不做

- 不做 React Compiler/微前端/新状态库；不引入未批准依赖。
- 不改 UI 视觉/数据语义/权限/gate/任务状态机。
- Watchdog 与 Mailbox 本次不拆（Watchdog 与首屏预算条同模块且仅 7.8 kB；Mailbox 为 App 内部组件，超出本次拆文件范围），后续可单独拆。

## 8. 文件范围（实际）

- 新增：`src/shell/LazyPanel.tsx`、`src/shell/LazyPanel.test.tsx`、`docs/team/lazy-panels.md`。
- 修改：`src/App.tsx`（8 个面板改为 LazyPanel）、`src/styles.css`（fallback/error）、`vite.config.ts`（manualChunks）。
- 未改：kernel/electron/permissions/gate/data store；无新依赖。
