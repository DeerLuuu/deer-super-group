# DW1-4：移除 legacy Dock / v1 适配 + 最终证据

> t562 修复：1440 截图改为真实 1440×1000/dpr1（clip）；补 DockHandle 七方法契约测试；在真实 checkout 演练 package/lock 恢复；DW1-5 清理计划明确 2026-12-15 期限。

- **任务**：t556（DW1-4）；t562 repair-round-2
- **分支**：`feature/t556-dockview-removal`
- **基线**：main `7280d10`（含 DW1-1/2/3、t560/t561）
- **范围**：`src/shell/dock/`、`src/shared/layoutPersistence.*`、`src/styles.css`、`vite.config.ts`、`package.json`/lock、相关测试/脚本/文档
- **不涉及**：kernel/memory/review/watchdog/electron、schema/IPC/权限/gate、面板业务内容

## 1. 删除 legacy renderer / v1 适配

- `DockShell.tsx` 收敛为稳定契约 + 默认导出 `DockShellV2`：
  - 删除 `DockShellLegacy`、`DockShellSwitch`、`reconcileSingleLayout`、dockview 组件/类型/import；
  - `DockHandle` 七个方法原样保留，App 零改动。
- 删除 `dockEngine.ts`（`DOCK_ENGINE`/localStorage 回滚开关）与对应测试；v2 是唯一默认且唯一 renderer。
- 删除 `dockGroups.ts`/测试（仅 legacy DockShell 使用）。
- `panelRegistry.ts` 删除 v1 `DockStore`/`storageKey`/`loadStore`/`saveStore`/`clearStore` 与 `LAYOUT_KEYS.dockPrefix`；`layoutPersistence` 只保留 sidebar/task/git/lastWorkspace key。
- 删除 legacy CSS：`.dock-shell`、`.dock-root`、dockview 主题、空布局水印、dockview 响应式规则；保留 `.dock-host` 与 `.dock-panel-body`（面板容器/测试契约仍使用）。
- `vite.config.ts` 删除 `vendor-dockview` manualChunk；`package.json` 删除 `dockview-core`/`dockview-react`，lock 更新后无该依赖。
- t530/t548 历史 CDP 脚本中的 legacy selector/engine 切换改为 v2-only；仓库运行时无 legacy import。

**v1 用户数据**：不迁移、不删除。CDP 预置 `deer.dock.v1.test-seed=keep-me`，启动和 reload 后仍为 `keep-me`；代码中没有 `deer.dock.state` / `deer.dock.v1.` 运行时访问（layoutOps 源码扫描断言保留）。

## 2. 回归覆盖

| 验收 | 证据 |
|---|---|
| 默认 v2 / 旧 renderer 删除 | `DockShell.tsx` 默认导出 `DockShellV2`，源码无 Legacy/Engine；`docktree.test` v2-only 源码断言 |
| DockHandle 契约不变 | 类型原样、App import 未改；新增 `DockHandle.contract.test.tsx` 覆盖七方法可调用；`lastWorkspaceApp` 等测试通过 |
| 深链 | CDP `#/git`/`#/tasks` 后 gitGraph/版本图 tab 可见，v2 store 写入 |
| 快捷键 | `docktreeInteraction` team focus Ctrl+Alt+W / 方向 / Delete；DockTree v2 key |
| 断点/组数 | CDP 1440:2 组、960:2 组、480:1 组；`scrollWidth=viewport`；2–8 组由 layout model/ops 测试覆盖 |
| 懒加载/keepalive | `DockGroup` always 常驻、onlyWhenVisible 首次激活挂载后 keepalive；`docktreeInteraction` data-mounted 测试 |
| 错误边界 | PanelErrorBoundary/DockTree 测试及既有 t548 覆盖保留 |
| 重启持久化 | CDP v2 store 写入 `deer.dock.layout.v2.<ws>`，reload 后 key/面板保持 |

## 3. 三档截图

| 文件 | 证据 |
|---|---|
| `docs/team/t556-final-1440.png` | **1440×1000、dpr=1**（CDP Emulation + clip），v2，无 dockview DOM |
| `docs/team/t556-final-960.png` | 960×900、dpr=1，v2，根无横向 |
| `docs/team/t556-final-480.png` | 480×900、dpr=1，v2 单组，根无横向 |

CDP `docs/team/t556-walkthrough.json`：`dockview=false`、1440/960/480 组数 2/2/1、关闭按钮 2/2/1、`scrollWidth` 等于视口、v1 seed 保留、v2 store reload 保持；JSON 新增 `devicePixelRatio:1` 与 `screenshots` 实际宽高（1440×1000/960×900/480×900），PNG header 独立复核。

## 4. 包体 / 回滚演练

- 新构建：**469 modules**；总 dist **1,216,233 bytes / 15 files**；index `383.86 kB / gzip 114.29`；CSS `151.25 kB`；无 `vendor-dockview` chunk。
- 回滚演练（重建旧版）：在临时 worktree `7280d10` 重新 `pnpm install` + `pnpm build`，得到 **475 modules**、总 dist **1,766,950 bytes / 17 files**、`vendor-dockview` JS **414.89 kB** + CSS **136.04 kB**；证明旧版可由 main commit + lock 重建，新分支删除包体约 550,717 bytes（约 31.2%）。
- **真实 checkout 演练（t562）**：在当前 t556 checkout 执行 `git checkout 7280d10 -- package.json pnpm-lock.yaml src/shell/dock src/styles.css vite.config.ts` → `pnpm install --ignore-scripts`（恢复 dockview-core/react）→ `pnpm build` 成功（475 modules，vendor-dockview 414896/136041 bytes）→ `git checkout HEAD --` 同路径 → `pnpm install --ignore-scripts` → build 成功（469 modules，无 vendor-dockview）。恢复后工作树仅保留 t562 证据改动。
- 回滚方式：revert 本 PR 并恢复 lockfile；v1 key 未删除，用户旧布局备份不丢；v2 store 损坏仍回默认并清理。

## 5. 验证

```text
pnpm typecheck  # exit 0
pnpm build      # exit 0（469 modules）
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                # 180 files / 1226 tests passed（serial）
```

（最终数字在 branch:sync 后复跑填入任务报告。）

## 6. 风险 / 遗留

- 删除 legacy 后无运行时切回 renderer 开关；回滚通过 revert + lockfile（架构 §3.8 约定）。
- `narrowWindow.ts` 仍保留 760 阈值与 sash 常量，供 dock 布局使用；非 legacy 适配。
- `t530/t548` CDP 脚本保留为历史证据，已改为 v2-only selector；不再执行 legacy 对照。
- **DW1-5 清理计划**：明确期限 **2026-12-15**（若 0.0.1 在此前发布则发布后 7 天内），详见 `docs/team/dw1-5-cleanup-plan.md`；v1 `deer.dock.state*` 在 t556/t562 保留，不在本次删除。
- 无新依赖、无业务/gate/schema/IPC/权限变更。
