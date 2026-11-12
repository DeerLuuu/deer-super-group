# P1-3 辅助面板路由/可发现性/溢出 · 最终集成验收（t322）

- **任务**：t322 — 集成验收 P1-3，最终集成 t319–t321
- **实现**：t319 `feature/t319-aux-panel-routes` @ `97a8ec8`
- **验证**：t320 独立验证 **PASS**（`docs/team/aux-panel-routes-verification.md`）
- **评审**：t321 独立评审 **PASS**（`docs/team/aux-panel-routes-review.md`）
- **PR**：[#47](https://github.com/DeerLuuu/deer-super-group/pull/47) — **MERGED（squash）**
- **合并提交**：`7c46007`
- **实现文档**：`docs/team/aux-panel-routes.md`
- **结论**：**PASS，已合并**；worktree 已清理，仅 main。

## 1. 结论

辅助面板 P1-3 已完成最终集成验收：

- `context` / `polls` / `watchdog` 具备独立 hash 深链（`#/context`、`#/polls`、`#/watchdog`），`parseHash`/`buildHash`/`normalizeHash` 与 `routeTabFromPanel` 一致；`#/nope` 归一到 `#/tasks`，`#/router` 别名保留。
- hashchange/前进后退/reload 能恢复 panel；tab 变更写 history，选中 replaceState；Dock active 邻居/关闭同步 hash；既有 `#/tasks?t=`、`#/tasks?r=`、`#/git`、`#/settings`、`#/merge` 保持。
- Launcher 分主面板/辅助/工作流三组，覆盖全部 `PANEL_LAUNCHER_KEYS`；支持 title/key 搜索、无结果 status、点击 `openPanel`；关闭后可从 launcher 恢复；既有 Chat/Tasks/Team/Workflow/NeedsMe 入口保留。
- context/polls/watchdog 在 960/480 单列可滚动，无横向；1440/960/480 截图与 launcher-960 截图齐备。
- 无新数据源/API/权限/gate/kernel/依赖变更；rail/Workflow 未改。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| context/polls/watchdog 深链 | `src/shared/deeplink.ts` ROUTE_TABS/parse/build/normalize | deeplink 测试；t320 §3.1；t321 PASS |
| 初始/运行中 hash 归一 | App 初始 replaceState + hash effect | t320/t321 |
| hashchange 恢复 panel | `onHashChange` setTab + `dock.openPanel` | t320 §3.1；t321 |
| 关闭/邻居同步 hash | `handleDockActivePanel` | t320 §3.1；t321 |
| Launcher 分组/搜索/恢复 | `PANEL_LAUNCHER_GROUPS`、搜索、`openPanel` | auxPanelRoutes 测试；t320 §3.2；t321 |
| 辅助面板溢出 | styles.css aux body/root 100%、overflow-y auto | 960/480 metrics；t320 §3.3；t321 |
| 既有深链/rail/Workflow | 未改相关代码 | deeplink 测试保持；t320/t321 |
| 范围 | 无 data/权限/gate/kernel/依赖 | PR diff；t320/t321 |

## 3. 独立复跑（合并后 main `7c46007`）

工作目录：`S:\DeerSuperGroup`（仅 main）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；441 modules
                 # css 266.96 kB / gzip 33.30
                 # js 1,321.43 kB / gzip 365.49
                 # electron main 1.6 MB / preload 12.6 KB
pnpm test -- --testTimeout=20000 --maxWorkers=2
                 # 112 files / 834 tests passed
```

> 默认 `pnpm test` 仍有既有 openai/watchdog/git 5s 并发 timeout；均为既有 flake，不是本 PR 引入。CI 应使用单独超时/串行配置（t320 已记录）。

## 4. 三档与入口证据

- 1440：`docs/team/t319-aux-1440.png`（context 552px 高、无横向）。
- 960：`docs/team/t319-aux-960.png`（context body scrollHeight/client 788/478；watchdog 2088/561）。
- 480：`docs/team/t319-aux-480.png`（context 788/187；watchdog 2080/473；poll-list 189/137；`document.scrollWidth == 480`）。
- Launcher 960：`docs/team/t319-launcher-960.png`（分组/搜索「上下文」仅 context）。
- 运行时走查（t319/t320）：`#/context`/`#/polls`/`#/watchdog` reload 恢复；`#/nope` 归一；context→polls→back 恢复；context 关闭后 hash 同步邻居 panel。

## 5. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #47 | MERGED（squash） |
| merge commit | `7c46007` |
| main | `7c46007`（+ 本报告提交） |
| 实现 worktree | 已移除（清理时终止遗留 t319-ui Electron） |
| 实现 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 合并后三命令 | typecheck 0 / build 0 / test 112 files/834 |

## 6. 遗留（P1 发布前可补，不阻塞）

1. **App 级路由自动化**：刷新/前进后退/关闭 hash 同步主要为 deeplink 单测 + Electron 走查；`onHashChange` 未显式 `setActivePanelKey`，依赖 Dock open 回调（N1 medium）。
2. **watchdog/polls 960/480 截图**只有 metrics，未逐屏截图；长 diff/trace 未单独走查（N2 medium）。
3. **Launcher 真实点击/480 截图**未入自动测试（N3 low）。
4. **无效 hash 运行中归一**未单测（N4 low）。
5. **context 注释旧**：`PanelDef` 注释仍写 context 不进 hash（N5 low）。
6. **既有 5s 并发 flake**：非本 PR；建议 CI 串行/提高慢测 timeout（N6 info）。

**最终结论：P1-3 PASS，PR #47 已 squash 合并到 main `7c46007`，辅助面板深链/launcher/溢出在 1440/960/480 与既有入口均无回归，无新数据源/权限/gate 变更；遗留仅为发布前可补的自动化/截图深度项。**
