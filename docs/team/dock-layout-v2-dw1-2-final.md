# DW1-2 命令 reducer + v2 持久化 + PanelHost 接线 · 最终集成验收（t533）

- **任务**：t533 — 最终集成 DW1-2（t526 实现 → t530 真实接线 → t531 PASS → t542 修复 → t543 review）
- **PR**：[#77](https://github.com/DeerLuuu/deer-super-group/pull/77) — **MERGED（squash）**
- **合并提交**：`2eaa789`
- **实现文档**：`docs/team/dock-layout-v2-dw1-2.md`
- **验证**：`docs/team/dock-layout-reducer-verification-2.md`（t531 PASS）
- **复审**：`docs/team/dock-layout-reducer-review-2.md`（t543 pass）
- **结论**：**PASS，已合并**；t526 worktree/branch 已清理；当前主工作区 + 其他任务 t544。

## 1. 接线/effects/v2 可追溯

### 纯 reducer / 持久化

- `src/shell/dock/layoutOps.ts`：`reduceDock` 8 类命令矩阵（open/close/activate/move/split/resize/reset/...）+ 守卫；出口 `clampGroups→normalize→validate` 恒空断言；no-op 引用稳定；`clampGroups` 超限降组不丢 panel。
- v2 持久化 `deer.dock.layout.v2.<ws>`：64KB（UTF-8 byteLength）上限、损坏回默认、无 localStorage 降级；不读 v1、不迁移。
- `switchVariant` 断点切换（wide/medium/narrow/single）；t542 修复 `resetAll` 清其他 variant、open anchor=chat、move 相邻 activePanel center target / 无相邻 split、controller variant effect。

### 真实接线

- `useDockLayoutController`（在 layoutOps 内）作为 v2 唯一状态源：init loadV2Store/default；`dispatch` 唯一入口；effects debounce persist / notify / activate。
- `DockShell` 真实 import controller；DockHandle 五命令执行时**同步 shadow dispatch** 到 reduceDock；dockview 仍负责渲染（DW1-3 才切换），默认行为零回归。
- t530 修复：生产轻量 invariant（panel 唯一、组数、sizes 有限）；variant/key 一致校验；UTF-8 64KB；switchVariant 持久化归属明确。
- 真实 Electron/CDP 13/13：三档 1440/960/480 无溢出；导航点击后 v2 store 实际写入（schema/version/variants）；Ctrl+Alt+W close；v1 不迁移。

## 2. 独立复跑（PR HEAD `c91add9`，main `53b4164`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；468 modules
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 179 files / 1205 tests passed
```

> plain 并行有既有 5s timeout；串行全绿。

## 3. 无回归/无依赖

- PR diff：`layoutOps.ts/test`、`DockShell.tsx`、`layoutModel.ts`、DW1-2 文档/CDP 脚本/三档截图；无新渲染器、未删除 dockview、未改 App/PanelHost 外层。
- dockview legacy 渲染保持；DockHandle 只增加 shadow dispatch。
- 无新依赖/package/lockfile；无 schema/IPC/权限/gate/事件变更；v1 布局不读取/不迁移。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #77 | MERGED（squash） |
| merge commit | `2eaa789` |
| main | `2eaa789` + 本报告提交 |
| t526 worktree | 已移除 |
| t526 branch | 已删除（local/remote） |
| 当前 worktree | 主工作区 + 其他任务 t544 |

## 5. 遗留（非阻塞）

1. DockShell 级 move 行为仍以 legacy 走查为主（N1 low）。
2. `resetAll` 双 clear（controller + DockShell）可收敛（N2 low）。
3. variant 初始化/effect 双路径（N3 low）。
4. adjacent active 为空边界（N4 low）。
5. PanelHost/App 外层未改（N5 low）。
6. 既有并行测试时序 timeout（N6 info）。

**最终结论：DW1-2 PASS，PR #77 已 squash 合并 `2eaa789`；命令 reducer/守卫/裁剪、v2 持久化/64KB/降级、switchVariant/resetAll、controller effects、DockShell 真实 shadow dispatch、三档/CDP v2 store 写入均集成验收；dockview 渲染保留、无新依赖/schema/权限；遗留仅为边界测试深度项。**
