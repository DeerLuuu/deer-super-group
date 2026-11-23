# MF1-1 编译期 PanelManifest + loader 映射 · 最终集成验收（t571）

- **任务**：t571 — 最终集成 MF1-1（t568 实现 → t569 PASS → t570 review）
- **PR**：[#84](https://github.com/DeerLuuu/deer-super-group/pull/84) — **MERGED（squash）**
- **合并提交**：`a8b3564`
- **实现文档**：`docs/team/panel-manifest.md`
- **验证**：`docs/team/panel-manifest-verification.md`（t569 PASS）
- **复审**：`docs/team/panel-manifest-review.md`（t570 pass）
- **结论**：**PASS，已合并**；t568 worktree/branch 已清理；当前主工作区 + 其他任务 t572/t576。

## 1. manifest/行为可追溯

- 新增 `src/shell/panel/panelManifest.ts`：PanelManifest（version/group/icon/loader/capabilities + PanelDef 元数据）、`PANEL_MANIFESTS` **14/14 PanelKey 单一来源**、`indexPanelManifests`（重复 key 抛错）、`getPanelManifest`（未知 null）。
- 新增 `src/shell/panel/panelLoaders.ts`：现有 **7 个 lazy 动态 import 唯一表**（settings/team/board/polls/planDraft/gitGraph/mergeQueue）；eager 面板用 `kind=eager` descriptor，不新增 chunk/远程加载。
- `panelRegistry.PANEL_DEFS` 改为从 `PANEL_MANIFEST_INDEX` 派生，保留 `PanelDef`/`MAIN_GROUP_ORDER`/variant/routeTab 工具与 Object 顺序。
- `App.tsx` 的 `load*Panel` 常量改为 `PANEL_LOADERS.*` 别名；LazyPanel 语义不变。
- 新增 `panelManifest.test`（完整性/重复/未知/lazy loader）；electron console wiring 保留断言跟随 manifest（仅测试改动，无生产 electron）。
- 深链/命令/快捷键/错误边界/默认布局测试保持；CDP 1440/960/480 组数 2/2/1、根无横向。

## 2. 独立复跑（PR HEAD `b557681`，已同步 main `69c1e78`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；471 modules；lazy chunks 保留
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                 # 181 files / 1229 tests passed
```

> plain 并行有既有 5s timeout；串行全绿。

## 3. 无新依赖/业务变更

- PR diff：manifest/loaders/tests、panelRegistry 派生、App 别名、electron 测试断言、docs/screenshots。
- 无新依赖/package/lockfile；无业务逻辑/API/状态机变更；无 schema/IPC/权限/gate/事件变更。
- 无运行时微前端/iframe/module federation；仅编译期 manifest + 现有动态 import。

## 4. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #84 | MERGED（squash） |
| merge commit | `a8b3564` |
| main | `a8b3564` + 本报告提交 |
| t568 worktree | 已移除 |
| t568 branch | 已删除（local/remote） |
| 当前 worktree | 主工作区 + 其他任务 t572/t576 |

## 5. 遗留（非阻塞）

1. `capabilities` 仅 metadata，未执行授权/能力检查（N1 low）。
2. App 直接消费 `PANEL_LOADERS`（无中间抽象）（N2 low）。
3. CDP 尺寸为 1440×1000/960×900/480×900（N3 low）。
4. 既有并行测试时序 timeout（N4 info）。

**最终结论：MF1-1 PASS，PR #84 已 squash 合并 `a8b3564`；14/14 PanelManifest 单一来源、7 lazy loader 唯一表、PANEL_DEFS 派生、App 别名、深链/命令/快捷键/错误边界/CDP 2/2/1 均集成验收；无新依赖/运行时微前端/业务/gate/权限/schema/IPC；遗留仅为 capabilities/抽象与 fixture 项。**
