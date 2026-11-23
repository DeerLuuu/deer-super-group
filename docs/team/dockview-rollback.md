# DW1 回滚：dockview 默认 + 保留 v2 opt-in（t584）

## 1. 决策

用户反馈自研 DockTree 交互整体退步（只能左右/不能上下/拖拽落点不稳），要求默认恢复旧 dockview 交互。Captain 后续修订目标：**dockview 恢复默认；自研 DockTree/v2 代码保留为显式 opt-in，不删除**；v2 可加载/切回，不破坏 v1 默认。

本 PR 最终状态：

- **默认**：dockview 8.9.0 + 旧 `DockShell`（`deer.dock.v1` store）；
- **opt-in**：DockTree/v2 + `deer.dock.layout.v2`，由 `dockEngine` 显式启用；
- 非 Dock 功能 O1 / RC1 / MF1 / G2 / D1 / G11 / G12 / G14 保留。

## 2. Revert 链与恢复

按逆序 revert 四个合并提交（`-m 1`）：

1. `0bb59c7` DW1-4（移除 dockview）
2. `84b0f55` DW1-3（DockTree v2）
3. `2eaa789` DW1-2（reducer/controller shadow）
4. `c9f81c8` DW1-1（layout model）

冲突仅 `panelRegistry.ts` 头部：保留 MF1 `PANEL_MANIFEST_INDEX` 派生，同时恢复 v1 `DockStore`/`LAYOUT_KEYS`。

随后从历史/主线恢复 v2 artifacts 作为 opt-in（`DockTree/Group/Sash/DropZone/DockShellV2`、`layoutModel/ops`、`dockLayout.css`、v2 tests），不设默认；`DockShell` 使用引擎分派：

```
getDockEngine() === "v2" ? DockShellV2 : DockShellLegacy
```

`dockEngine` 默认 **dockview**；`VITE_DOCK_ENGINE=v2` 或 `localStorage["deer.dock.engine"]="v2"` 启用 v2；切回 `dockview` 即恢复默认。

## 3. 默认/opt-in 行为与证据

### 默认 dockview

- 恢复 `dockview-core@8.9.0` / `dockview-react@8.9.0` + lockfile、旧 `DockShell`、v1 `deer.dock.v1.<workspaceId>`、legacy CSS。
- 真实 Electron 1440：`.dv-shell=true`、`.docktree-root=false`；v1 key 存在。
- 拖拽任务→底部创建上下 split；邮箱→右侧创建左右 split；dockview native drop zones 覆盖 center/left/right/above/below。
- Sash 两轴真实拖动：底部组宽 592/592→640/544；上下高 428/428→464/392，松手保持。
- 关闭活动 tab 6→5；`#/tasks` 重开 5→6；deep link/Alt+2 active 任务；关闭全部→watermark「恢复默认布局」→groups 2/tabs 5/active 对话+团队；reload v1 布局恢复。
- 截图：`t584-dockview-1440.png`（初始）、`t584-dock-fourway-1440.png`（split）、`t584-dock-{1440,960,480}.png`（三档，`scrollWidth===innerWidth`）。

### v2 opt-in（保留）

- `dockEngine` 默认 dockview；切 `deer.dock.engine="v2"` 后 reload：`.dv-shell=false`、`.docktree-root=true`，v2 store 出现，2 groups；再切回 dockview reload 恢复旧 renderer。
- 截图：`t584-v2-optin-1440.png`、`t584-v2-optin-960.png`；记录 `t584-engine-walkthrough.json`。
- v2 代码/测试保留，未删除；v1 默认不被 v2 opt-in 破坏。

## 4. 验证/构建

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 0 |
| `pnpm build` | 0；**830 ms**；index **394.85 kB / gzip 117.38**；vendor-dockview **414.89/97.22**；CSS **153.32/26.08** |
| `pnpm test -- --max-workers=1 --testTimeout=20000` | **183 文件 / 1238 用例全绿**（269.73s） |
| `pnpm build:compiler` | 0；index **443.68/140.10**（RC1 全 renderer 仍可用） |

- 默认 build/test 不编译；compiler 仍独立命令。
- 非 Dock：MF1 panel manifest、O1 关系读路径、G2/D1/G11/G12/G14 全量测试通过；无 kernel/memory/review/watchdog/electron 改动。
- RC1 boundary 保留；DockShell + v2 高风险文件均 `"use no memo"`，kernel/electron 排除持续有效。
- 无手工 memo 删除；无 runtime 新依赖（dockview 是恢复既有依赖）；无 schema/DB/权限/gate/IPC 变更。

## 5. 风险与回滚

- 默认 bundle 恢复 dockview，并保留 v2 opt-in 代码，index 较纯 v2 回滚态增加；这是保留双引擎的成本。
- v1/v2 store 并存：默认只读 v1；v2 仅在 opt-in 时读写。不迁移/不删除旧 key。
- 若 v2 opt-in 导致问题，删除 `deer.dock.engine` 或设 `"dockview"` 即回旧交互，无需数据迁移。
- 再次移除 dockview 属后续独立任务，不在本 PR。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
