# MF1-2 面板边界测试 + import 白名单 + chunk budget · 最终集成验收（t583）

- **任务**：t583 — 最终集成 MF1-2（t580 实现 → t581 PASS → t582 review）
- **PR**：[#86](https://github.com/DeerLuuu/deer-super-group/pull/86) — **MERGED（squash）**
- **合并提交**：`1356367`
- **ADR**：`docs/team/adr-mf1-2-panel-boundary.md`
- **验证**：`docs/team/panel-boundary-verification.md`（t581 PASS）
- **复审**：`docs/team/panel-boundary-review.md`（t582 pass）
- **结论**：**PASS，已合并**；t580 worktree/branch 已清理；当前主工作区 + 其他任务 t576/t584。

## 1. 边界/chunk 可追溯

- 7 个 lazy panel root 与 `PANEL_LOADERS` 对齐；transitive import 禁止 `kernel/review/watchdog/memory/electron`；memory 仅允许 type-only types；`shared` 12 项显式白名单；禁止跨 panel；panel 不反向 import App/DockTree/DockShell/panelManifest/panelLoaders。
- 依赖方向：App 运行时 panel 仅经 `PANEL_LOADERS`（SettingsView type-only 允许）；manifest 只经 loader map；仅 panelLoaders 动态 import panel 入口。
- `panelChunkBudget.ts`：记录 7 个 chunk 基线/阈值；测试 exact pass、over-budget fail；ADR 记录基线、35% headroom。
- ADR：`docs/team/adr-mf1-2-panel-boundary.md` — 编译期 manifest/动态 import/无运行时 federation、触发条件、回滚。

## 2. 独立复跑（PR HEAD `eb82e66`，已同步 main `0a8d88f`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；471 modules；205ms
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 182 files / 1236 tests passed
```

> plain 并行有既有 5s timeout；串行全绿。

## 3. 无业务/依赖变更

- PR 仅 3 文件：`panelBoundary.test.ts`、`panelChunkBudget.ts`、ADR（+416 行）；无生产业务代码变更。
- 无 package/lockfile/新依赖；无权限/gate/schema/IPC/事件变更。
- chunk 实际：Settings 26.18 / Team 46.38 / Memory 30.48 / Poll 16.47 / Plan 8.92 / GitGraph 52.13 / Merge 8.75kB，均 ≤ budget。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #86 | MERGED（squash） |
| merge commit | `1356367` |
| main | `1356367` + 本报告提交 |
| t580 worktree | 已移除 |
| t580 branch | 已删除（local/remote） |
| 当前 worktree | 主工作区 + 其他任务 t576/t584 |

## 5. 遗留（非阻塞）

1. 边界图仅覆盖 7 lazy root；eager/submodule 未覆盖（N1 medium）。
2. 边界扫描为静态正则，非 AST（N2 medium）。
3. chunk budget 为静态表，不直接读 build 输出（N3 low）。
4. 既有并行测试时序 timeout（N4 info）。

**最终结论：MF1-2 PASS，PR #86 已 squash 合并 `1356367`；7 lazy root 边界/transitive 白名单/memory type-only/shared 12/跨 panel/方向、chunk budget 7 项/35% headroom、ADR 均集成验收；仅 tests/docs/budget，无业务/权限/gate/schema/IPC/新依赖；遗留仅为 eager/静态扫描/动态预算项。**
