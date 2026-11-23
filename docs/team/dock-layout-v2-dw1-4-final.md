# DW1-4 移除 dockview / 旧 v1 适配 · 最终集成验收（t559）

- **任务**：t559 — 最终集成 DW1-4（t556 实现 → t557 PASS → t562 修复 → t563 review）
- **PR**：[#82](https://github.com/DeerLuuu/deer-super-group/pull/82) — **MERGED（squash）**
- **合并提交**：`0bb59c7`
- **实现文档**：`docs/team/dockview-removal-final.md`
- **指标**：`docs/team/t556-bundle.json`
- **walkthrough**：`docs/team/t556-walkthrough.json`
- **验证**：`docs/team/dockview-removal-verification.md`（t557 PASS）
- **复审**：`docs/team/dockview-removal-review-2.md`（t563 pass）
- **结论**：**PASS，已合并**；t556 worktree/branch 已清理；当前仅主工作区。

## 1. dockview 移除可追溯

- `DockShell.tsx` 收敛为 DockHandle 契约 + 默认导出 `DockShellV2`；删除 DockShellLegacy/engine switch/reconcile/dockGroups。
- `panelRegistry` 删除 v1 DockStore/storageKey/loadStore/saveStore/clearStore；`layoutPersistence` 删除 dockPrefix。
- v1 `deer.dock.state` **不迁移、不删除**，保留为旧备份（清理计划见 `dw1-5-cleanup-plan.md`，2026-12-15 / 0.0.1 发布后 7 天复核）。
- `styles.css` 删除 legacy dock/dockview 主题/水印/响应式；vite 删除 vendor-dockview chunk。
- package/lock 删除 `dockview-core@8.9.0`、`dockview-react@8.9.0`。
- 保留 DockHandle 七方法、PanelHost/LazyPanel/错误边界/深链/快捷键/断点/2–8 组/懒加载语义；无新依赖/业务/gate/schema/IPC/权限变更。

## 2. 独立复跑（PR HEAD `ae43d2d`，main `7280d10`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；469 modules；无 vendor-dockview
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 180 files / 1226 tests passed
```

## 3. 三档/契约/回滚/包体

- CDP 1440/960/480：2/2/1 组、关闭按钮 2/2/1、`scrollWidth=viewport`、`dockview DOM=false`；深链 `#/git`/`#/tasks` 可见。
- v1 seed `keep-me` 启动/reload 保留；v2 store reload 保持；DockHandle.contract 七方法 open/getOpen/close/reset/resetAll/move/resize 测试通过。
- 真实回退演练：checkout `7280d10` 旧 package/lock/dock 文件 → `pnpm install` 恢复 dockview → build 475 modules + vendor-dockview 414,896B/136,041B → 回 HEAD → install/build 469 modules 无 vendor chunk。
- 新 dist **1,216,233B / 15 files** vs 旧 **1,766,950B / 17 files**（约 **-31.2%**）。
- 截图 t556-final 1440×1000/960×900/480×900 dpr1。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #82 | MERGED（squash） |
| merge commit | `0bb59c7` |
| main | `0bb59c7` + 本报告提交 |
| t556 worktree | 已移除（旧 t556 harness Electron 占用目录，已终止并删除） |
| t556 branch | 已删除（local） |
| 当前 worktree | 仅主工作区 |

## 5. 遗留（非阻塞）

1. 1440 截图夹具为 1440×1000（非 docs 原 1440×1000 之外的旧 3440×1385；已重截）（N1 low）。
2. v1 key 保留清理计划 2026-12-15（N2 low）。
3. 既有并行测试时序 timeout（N3 info）。

**最终结论：DW1-4 PASS，PR #82 已 squash 合并 `0bb59c7`；dockview/旧 v1 适配/依赖/样式/chunk 全部移除，默认 DockShellV2、DockHandle 契约、深链/快捷键/断点/2–8/lazy/error/v2 reload 均验收；包体 -31.2%；v1 key 保留、无新依赖/业务/gate/权限/schema/IPC；遗留仅为清理日期/截图夹具项。**
