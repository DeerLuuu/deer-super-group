# Dock v2 parity（回滚后重挂）· 最终集成验收（t603）

- **任务**：t603 — 最终集成 Dock v2 parity（t600 实现 → t601 PASS → t602 review）
- **PR**：[#88](https://github.com/DeerLuuu/deer-super-group/pull/88) — **MERGED（squash）**
- **合并提交**：`02ce11c`
- **实现文档**：`docs/team/v2-parity.md`
- **五向证据**：`docs/team/t600-parity-walkthrough.json`、`docs/team/t576-layout-walkthrough.json`
- **验证/复审**：`docs/team/dock-v2-parity-verification.md`（t601 PASS）、`dock-v2-parity-review.md`（t602 pass）
- **Parity 结论**：**交互/几何/持久化 PASS；默认保持 dockview，不切换 v2。**
- **默认切换结论**：**需 Captain/用户产品确认后再做；本任务不切换。**

## 1. 交互/三档可追溯

### 五向 drop

- `dropPosition.ts` 纯函数：距四边 ≤25% 取最近一侧；对角线归一化；四边都不近返回 center。
- 删除四层 `DockDropZone` overlay；目标组 `dragover` 只显示一个 `.docktree-drop-position.active.<position>`；dragstart 不显示源提示，dragend 清除。
- 真实 Electron/CDP：left/right 2→3 horizontal、above/below 2→3 vertical、center 2→2（团队组新增对话），**directionCorrect 5/5，failures 空**。

### sash / panel

- `DockSash` 双轴 pointer + 4px 阈值 + Arrow/Home/End；双击 reset。
- 实测垂直 475.78/475.78→535.5/416.06（sizes 0.5/0.5→0.562762/0.437238）；键盘 0.58/0.42→0.60/0.40；双击恢复。
- panel 根 CSS `flex:1 1 auto; width/height:100%`；chat/tasks/board/team 三档内容宽度比例 ≥95%（多数 1.0；board 480 为 96.4%）。

### 三档 / 引擎

- 1440/960/480：v2 与 dockview 均为 2/1/1 组、根无横向（scrollWidth=视口）。
- 默认 `dockview=true / docktree=0`；`deer.dock.engine=v2` opt-in 后反转；旧引擎保留、不删除。
- v2 store 写回/重载正常；无新依赖/业务/gate/schema/IPC/权限变更。

## 2. 独立复跑（PR HEAD `108bcca`，main `1d84756`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；477 modules；vendor-dockview 414.89/136.04 保留
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 185 files / 1251 tests passed
```

## 3. 默认 dockview / 旧引擎保留

- `dockEngine` 默认 `dockview`；`VITE_DOCK_ENGINE` / localStorage 仅显式 opt-in v2。
- `DockShellLegacy`、dockview 依赖、vendor-dockview chunk 均保留。
- 非 Dock 代码未改；PR 仅 `src/shell/dock/` + parity scripts/docs。

## 4. Parity 结论（明确）

| 维度 | 结论 |
|---|---|
| 五向拖放 | PASS |
| 单侧落点/overlay | PASS |
| 双轴 sash/键盘/双击 | PASS |
| 面板内容撑满 | PASS（≥95%） |
| 三档几何/无横向 | PASS |
| 持久化/引擎切换 | PASS |
| **默认 tab 集** | **不一致：v2 主组含 settings（6）vs 清空 v1 fixture 的 dockview 默认 5 tabs** |
| **默认切换** | **不做**；需产品确认 v2 是否隐藏 settings，Captain/用户确认后再切 |

## 5. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #88 | MERGED（squash） |
| merge commit | `02ce11c` |
| main | `02ce11c` + 本报告提交 |
| t600 worktree | 已移除（旧 t600 harness Electron 占用，已终止） |
| t600 branch | 已删除（local/remote） |
| 当前 worktree | 主工作区 + 其他任务 t576 |

## 6. 遗留（非阻塞）

1. v2 默认 settings tab（6）vs dockview 5；默认切换前需产品决策（N1 medium）。
2. center 阈值/单提示细节（N2 low）。
3. CDP 截图为 dpr1/视口尺寸，非原生窗口（N3 low）。
4. 双击 sash reset 影响整布局（既有设计，N4 low）。
5. 既有并行测试时序 timeout（N5 info）。

**最终结论：Dock v2 parity PASS，PR #88 已 squash 合并 `02ce11c`；五向/单侧落点/双轴 sash/键盘/双击/panel 撑满/三档/持久化全部 parity 通过；默认保持 dockview，v2 仅 opt-in，旧引擎保留；默认切换因 tab 集差异需 Captain/用户确认，不在本任务切换。**
