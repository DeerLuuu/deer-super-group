# DW1 回滚：恢复 dockview 默认 + 五向拖拽 · 最终集成验收（t599）

- **任务**：t599 — 最终集成 DW1 回滚（t584 实现 → t592/t596 补证 → t597/t598 复验）
- **PR**：[#87](https://github.com/DeerLuuu/deer-super-group/pull/87) — **MERGED（squash）**
- **合并提交**：`e4b6d30`
- **实现文档**：`docs/team/dockview-rollback.md`
- **五向证据**：`docs/team/t592-fiveway-walkthrough.json`
- **合并后实测**：`docs/team/t599-postmerge-fourway.json` + `t599-postmerge-*.png`
- **验证/复审**：`docs/team/dockview-center-verification.md`、`dockview-center-review.md`
- **结论**：**PASS，已合并，应用已重建并恢复默认 dockview 布局**。

## 1. 回滚内容

- 默认恢复 dockview 8.9.0 + 旧 `DockShell` + v1 `deer.dock.state` / `LAYOUT_KEYS` + legacy CSS；`dockEngine` 默认 `dockview`。
- 恢复真实拖拽上下/左右 split、双轴 sash、关闭/重开、深链、Alt+2、重置、reload v1 布局恢复。
- v2 自研 DockTree/DockShellV2/layoutModel/ops/v2 store 代码与测试**保留**，通过 `VITE_DOCK_ENGINE` 或 `localStorage.deer.dock.engine=v2` opt-in；切回 dockview 后 v1 布局不被破坏。
- 非 Dock 功能保留：O1 relation、RC1 compiler、MF1 manifest、G2/D1/G11/G12/G14 等；PR 非 Dock 源码仅 `panelRegistry` 保留 manifest + 恢复 v1 store、`reactCompilerBoundary` +1 no-memo 行。

## 2. 五向拖拽证据（PR HEAD，修复后）

`t592-fiveway-walkthrough.json`（真实 Electron/CDP，1440×900）：

| 方向 | groups | panels | axis | 结果 |
|---|---|---|---|---|
| left | 1→2 | 任务左组、主组 692/692 | horizontal | directionCorrect |
| right | 2→3 | 团队 560 / 主组 464 / 任务 560 | horizontal | directionCorrect |
| above | 2→3 | 任务上 428 / 团队下 428 | vertical | directionCorrect |
| below | 2→3 | 团队上、任务下；reload 后 3 组/5 tabs | vertical | directionCorrect |
| center | 2→2 | 团队组 tabs [团队,任务]，无新组 | none | directionCorrect |

- 双轴 sash：垂直 692/692→740/644；水平 856/428/428→856/464/392。
- v1 reload 恢复；v2 opt-in `dockview=false/v2=true`，切回 `dockview=true/v2=false`。
- 960/480 单组 4 tabs、无横向；截图见 `docs/team/t592-*.png`。

## 3. 独立复跑（PR HEAD `855b3e6`，main `d25a480`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；477 modules；vendor-dockview 414.89kB/136.04kB
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 184 files / 1245 tests passed
pnpm build:compiler   # exit 0
```

## 4. 合并后重建 + 四向实测

- `git pull` 后 `pnpm build`：exit 0，1096ms；index 394.85kB/gzip117.38，vendor-dockview 恢复。
- 使用合并后 `dist` + 真实 Electron（CDP 9295，独立 userData）实测：
  - **left**：drag 成功，横向 split，`directionCorrect=true`（803/581→851/533）。
  - **right**：2→3 组，横向 split，任务独立右组，`true`。
  - **above**：2→3 组，纵向 split，任务上/团队下，`true`；水平 sash 856/428/428→856/464/392。
  - **below**：2→3 组，纵向 split，团队上/任务下；reload 后 3 组/5 tabs，`true`。
  - **center**：2→2，团队组 tabs 增加任务，无新组，`true`。
  - 1440/960/480：scrollWidth=innerWidth（1440/960/480），组数 2/1/1，tabs 5/4/4。
  - v2 opt-in 加载成功；切回 dockview 恢复默认。
- 证据：`t599-postmerge-fourway.json`、`t599-postmerge-{left,right,above,below,center,1440}.png`。

## 5. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #87 | MERGED（squash） |
| merge commit | `e4b6d30` |
| main | `e4b6d30` + 本报告提交 |
| t584 worktree | 已移除 |
| t584 branch | 已删除（local/remote） |
| 当前 worktree | 主工作区 + 其他任务 t576 |

## 6. 遗留（非阻塞）

1. center 的 `axis=null` 为“并入目标组”语义，字段本身正确（N1 low）。
2. CDP 截图 dpr=1 / 视口尺寸与原生窗口可能不同（N2 low）。
3. 既有并行测试时序 timeout（N3 info）。
4. dockview bundle 恢复为预期回滚结果，不属于包体回退缺陷。

**最终结论：DW1 回滚 PASS，PR #87 已 squash 合并 `e4b6d30`；dockview 默认/v1 布局/五向拖拽/双轴 sash/reload/v2 opt-in 均验收；合并后已重建应用并实测左右上下四向及 center，全部 directionCorrect、三档无横向；非 Dock 功能无回归；t584 worktree/branch 已清理。**
