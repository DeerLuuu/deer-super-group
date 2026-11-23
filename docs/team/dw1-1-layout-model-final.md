# DW1-1 Dock 布局模型 · 最终集成验收（t509）

- **任务**：t509 — 最终集成 DW1-1（t506 实现 → t507 PASS → t518 修复 → t519 review）
- **PR**：[#75](https://github.com/DeerLuuu/deer-super-group/pull/75) — **MERGED（squash）**
- **合并提交**：`c9f81c8`
- **实现文档**：`docs/team/dock-layout-v2-dw1-1.md`
- **验证**：`docs/team/dock-layout-model-verification.md`（t507 PASS）
- **复审**：`docs/team/dock-layout-model-review-2.md`（t519 pass）
- **结论**：**PASS，已合并**；t506 worktree/branch 已清理；当前主工作区 + 其他任务 t502/t520。

## 1. 模型/属性测试可追溯

`src/shell/dock/layoutModel.ts`（纯数据层）：

- `DockLayout` v2：split/group 树、panel、active、sizes；`validate` 覆盖空组/重复 panel/未知 panel/active 越界/split<2/sizes 长度/NaN/负 size/超组数/重复 id，及专用 `E_SCHEMA_MISMATCH`（t518 移除 `E_NOT_CLOSEABLE`，closable 归 close 运行时）。
- `normalize`：空组删除/single-child 折叠/sizes 归一/active 回退/未知剔除/全空回退；**id 稳定**（同次遍历冲突才重编）；幂等，且 normalize→validate 恒空（t518 增加脏树双跑契约）。
- 默认布局：wide/medium/narrow 主组 + team 右分栏（0.58/0.42、0.56/0.44、0.52/0.48）、single 同组 team/settings；defaultClosed 排除；`defaultLayoutForWidth` 断点正确。
- 6 个纯操作：`movePanelInLayout` 开头 `findGroupOf(panel)/findGroupOf(target)` 双守卫，缺失时 no-op（5 条快照测试）；resize/close/open/active 等；`effectiveMaxDockGroups` 2–8 默认 6、single 恒 1。
- 边界：**不 import DockShell/dockview，不读 v1 `deer.dock.state`，无 localStorage**（源码扫描断言）；未接 UI、未删 dockview、无新依赖/schema/IPC/权限。

### 属性测试

- 5 seeds × 260 = **1300 次随机操作**（≥1000）不变量；
- 5 × 260 重启等价；
- 固定 seed 可复现；总计 20 用例（后续修复 +3 = 23 相关断言）全绿。

## 2. 独立复跑（PR HEAD `810902e`，main `9349d00`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；466 modules
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 175 files / 1159 tests passed
```

> plain 并行有既有 5s timeout；串行全绿。

## 3. 范围/边界

- PR diff 仅 `src/shell/dock/layoutModel.ts`、`layoutModel.test.ts`、`docs/team/dock-layout-v2-dw1-1.md`（3 files，+1237）。
- 无 package/lockfile/dockview/UI/App/Settings 改动；未接 UI、未读 v1、未删除 dockview。
- 无 schema/IPC/权限/gate/事件变更；无新依赖。
- t518 修复：move 双守卫、`E_SCHEMA_MISMATCH`、normalize→validate 恒空；模型/默认/property/重启等价保持。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #75 | MERGED（squash） |
| merge commit | `c9f81c8` |
| main | `c9f81c8` + 本报告提交 |
| t506 worktree | 已移除 |
| t506 branch | 已删除（local/remote） |
| 当前 worktree | 主工作区 + 其他任务 t502/t520 |

## 5. 遗留（非阻塞）

1. `normalize` 不主动降 >maxGroups；DW1-2 需带 maxGroups validate/裁剪（N1 low）。
2. 属性测试 seed 无 env 记录（N2 low）。
3. 既有并行测试时序 timeout（N3 info；CI 串行）。

**最终结论：DW1-1 PASS，PR #75 已 squash 合并 `c9f81c8`；v2 布局模型/默认布局/validate/normalize 幂等/id 稳定/1300 property 操作/重启等价/边界（不接 UI、不读 v1、不依赖 dockview）均集成验收；无新依赖/schema/IPC/权限；遗留仅为 DW1-2 的 maxGroups 裁剪与测试环境项。**
