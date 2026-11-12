# P1-7 重面板懒加载与 vendor 拆分 · 最终集成验收（t326）

- **任务**：t326 — 集成验收 P1-7，最终集成 t323–t325
- **实现**：PR #48 / `feature/t323-lazy-panels` @ `4ebc810`（base main `b1b939d`）
- **验证**：t328 独立验证 **PASS**（`docs/team/lazy-panels-verification-2.md`）
- **评审**：t325 独立评审 **PASS**（`docs/team/lazy-panels-review.md`）
- **PR**：[#48](https://github.com/DeerLuuu/deer-super-group/pull/48) — **MERGED（squash）**
- **合并提交**：`3641f6e`
- **实现文档**：`docs/team/lazy-panels.md`
- **结论**：**PASS，已合并**；worktree 已清理，仅 main。

## 1. 结论

P1-7 已完成最终集成验收：

- `LazyPanel`（React.lazy + Suspense skeleton + ErrorBoundary 重试）落地；Settings/Team/Memory/Poll/GitGraph/MergeQueue/PlanDraft 7 个重面板懒加载；Chat/Dock/rail/Workflow/NeedsMe 保持同步首屏。
- 深链/恢复路径 `#/git`、`#/merge`、`#/settings` 等保持；App 级测试覆盖 `#/git` fallback→loaded，以及面板渲染失败→错误态→重试成功。
- Watchdog 的假 LazyPanel/无效 dynamic import 已删除（与 BudgetBar/WatchdogAlertBanner 同模块，直接同步渲染）；Mailbox 在 App 内部，本次不拆，均已在文档记录。
- `vite.config.ts` manualChunks 拆 vendor-dockview/react/markdown/zod；无 INEFFECTIVE_DYNAMIC_IMPORT 警告、无新依赖。
- 1440/960/480 fallback 截图存在；480 骨架 min-height 240、无横向；真实 App 首屏 Chat/Dock/rail/Workflow/NeedsMe 回归 114/838 全绿。
- 无权限/gate/数据层变更；merge gate 与 merge queue 行为未改。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| LazyPanel/fallback/错误重试 | `src/shell/LazyPanel.tsx` | LazyPanel.test；t328；t325 PASS |
| 7 个重面板 lazy | App `lazy()` + PanelHost 渲染 | lazyPanelsApp.test；t328 |
| #git 深链 fallback | App + LazyPanel | lazyPanelsApp.test；t328 |
| 面板失败→错误态→重试 | LazyPanel ErrorBoundary | lazyPanelsApp.test；t328 |
| Watchdog 无效 lazy 清理 | App 直接渲染 WatchdogPanel | build 无 INEFFECTIVE；t328 |
| vendor 拆分 | `vite.config.ts` manualChunks | 构建 chunk 清单；t328/t325 |
| Chat/rail/Workflow/NeedsMe/Dock/窄窗 | 同步首屏未改 | 114/838 全绿；t328 |
| 无权限/gate/数据层 | diff 仅 App/LazyPanel/styles/vite/docs/tests | PR diff；t325/t328 |
| 1440/960/480 fallback | t327 截图 | 480 min 240 / 无横向；t328 |

## 3. 独立复跑（合并后 main `3641f6e`）

工作目录：`S:\DeerSuperGroup`（仅 main）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；443 modules
pnpm test        # --testTimeout=20000 --maxWorkers=2
                 # 114 files / 838 tests passed
```

构建体积（raw / gzip）：

```text
entry index-Ctcr_PJw.js          308.23 kB / 91.84 kB
vendor-dockview                  414.89 kB / 97.22 kB
vendor-react                     206.75 kB / 64.81 kB
vendor-markdown                  164.39 kB / 49.32 kB
vendor-zod                        87.21 kB / 24.79 kB
lazy TeamDashboard                45.61 kB / 14.36 kB
lazy MemoryWorkbench              29.54 kB /  8.19 kB
lazy SettingsView                 21.81 kB /  6.28 kB
lazy PollPanel                    16.45 kB /  5.36 kB
lazy GitGraphPanel                14.34 kB /  4.98 kB
lazy PlanDraftPanel                8.94 kB /  3.26 kB
lazy MergeQueuePanel               6.76 kB /  2.30 kB
```

> entry 从 `1,320.16 → 308.23 kB`（gzip `365.15 → 91.84`，raw -76.7%）。注意：vendor 仍为首屏加载，总首屏 JS 约 1,181 kB，整体约 -10%；entry 降幅不等于总首屏降幅（t325 N1）。

## 4. 回归与范围

- **通过**：Chat/Dock/rail/Workflow/NeedsMe 同步首屏；懒面板打开/关闭/恢复；`#/git`/`#/merge`/`#/settings` 深链；窄窗 960/480；权限模式/高风险审批；MergeQueue 确认 Modal 与 merge gate；既有 Git/PR/merge queue 测试。全量 114 files/838。
- **范围**：`src/App.tsx`、`src/shell/LazyPanel*`、`src/shell/lazyPanelsApp.test*`、`src/styles.css`、`vite.config.ts`、docs/截图；无 IPC/store/kernel/权限/gate/数据层/依赖变更。
- **降级**：skeleton 1440/960/480 可见；480 min-height 240、不横向溢出；chunk 失败显示错误态并可重试；`#/git` App 级测试覆盖 fallback/failure/retry。

## 5. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #48 | MERGED（squash） |
| merge commit | `3641f6e` |
| main | `3641f6e`（+ 本报告提交） |
| 实现 worktree | 已移除 |
| 实现 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 合并后三命令 | typecheck 0 / build 0 / test 114 files/838 |

## 6. 遗留（P1 发布前可补，不阻塞）

1. **entry 降幅≠总首屏降幅**：vendor 仍首屏，总 JS 约 -10%；如追求真实首屏收益，需进一步拆分/延迟 vendor（N1）。
2. **fallback 截图为 fixture**（真实构建 CSS/骨架结构，但非真实 App 业务数据）；发布前可补真实 App 三档截图（N2）。
3. **App 级深链仅 `#/git`**：`#/merge`/`#/settings` 仍为既有测试/走查（N3）。
4. **无真实 CLS 量化**：GitGraph min300 vs fallback 320 的布局跳动未测（N2/N4）。
5. **既有 5s 并发 flake**：openai/watchdog/git 等；非本 PR，建议 CI 串行/提高慢测 timeout。

**最终结论：P1-7 PASS，PR #48 已 squash 合并到 main `3641f6e`；重面板懒加载/fallback/失败重试/vendor 拆分落地，entry 308.23 kB（gzip 91.84），Chat/rail/Workflow/NeedsMe/Dock/窄窗/权限无回归；无新数据源/权限/gate 变更；遗留仅为发布前可补的 vendor 首屏与截图/CLS 深度项。**
