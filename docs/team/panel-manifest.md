# MF1-1：编译期 PanelManifest + loader 映射（t568）

- **任务**：t568（MF1-1）
- **分支**：`feature/t568-panel-manifest`
- **基线**：main `9198614`（DW1-4/PR #82 已合并）
- **范围**：`src/shell/panel/panelManifest.ts`、`src/shell/panel/panelLoaders.ts`、`src/shell/dock/panelRegistry.ts`、`src/App.tsx`、测试/文档
- **不涉及**：kernel/memory/review/watchdog/electron 生产代码、schema/IPC/权限/gate、新依赖、运行时微前端

## 1. 单一来源

新增 `src/shell/panel/panelManifest.ts`：

```ts
interface PanelManifest extends PanelDef {
  version: 1;
  group: "work" | "team" | "git" | "aux" | "settings";
  icon: string;
  loader:
    | { kind: "lazy"; load: () => Promise<{ default: ComponentType<any> }> }
    | { kind: "eager"; component: string };
  capabilities: { reads: string[]; writes: string[]; requiresPermission?: string };
}
```

- `PANEL_MANIFESTS` 是唯一手工来源，包含 key/version/title/group/icon/loader/routeTab/renderer/minWidth/minHeight/closable/defaultGroup/defaultClosed/capabilities。
- `panelRegistry.PANEL_DEFS` 由 `PANEL_MANIFEST_INDEX` 派生，保持原 `PanelDef` 形状与对象顺序；`MAIN_GROUP_ORDER`/variant/routeTab 工具不变。
- `indexPanelManifests` 拒绝重复 key；`getPanelManifest("unknown")` 返回 null，未知 key 不会进入注册表。

## 2. loader 映射

`src/shell/panel/panelLoaders.ts`：

- 只收敛 **现有动态 import**：settings/team/board/polls/planDraft/gitGraph/mergeQueue；与旧 App 常量语义一致。
- manifest 为每个 lazy panel 保存 `{kind:"lazy", load}`；eager panel 保存 `{kind:"eager", component}`，仍由 App 同步 switch 渲染。
- `App.tsx` 的 `load*Panel` 常量改为 `PANEL_LOADERS.*` 别名；无第二份 loader 定义，Vite 仍按原有面板产生独立 chunk。
- 不引入 module federation/remoteEntry/iframe/运行时配置 fetch。

## 3. 行为不变

- 14 个 PanelKey 的 title/routeTab/minWidth/minHeight/renderer/closable/defaultGroup/defaultClosed 与旧 `PANEL_DEFS` 逐字段一致（manifest 完整性测试 + 现有布局/深链/命令测试）。
- 深链/命令/快捷键/错误边界/权限入口未改；App 的 `renderPanelContent` 分支保持不变。
- 面板 capability 只是 manifest 描述/未来边界测试输入，不作为授权来源；真实权限仍走既有 permission/IPC。

## 4. 测试

新增 `src/shell/panel/panelManifest.test.ts`（3 用例）：

1. 每个 `PANEL_DEFS` key 都有 manifest，且 title/group/icon/loader/尺寸齐全；派生 def 与 manifest 字段一致。
2. 重复 key 抛出 `duplicate panel manifest`；未知 panel 返回 null。
3. manifest lazy 集合与 `PANEL_LOADERS` 完全一致；实际 `await` gitGraph/mergeQueue loader 返回组件函数。

补充：`electron/console/consoleWiring.test.ts` 的 console 注册断言从 `panelRegistry.ts` 指向新的 manifest 单一来源（测试-only 跟随移动，无生产 electron 改动）。

## 5. 三档 / 构建

- 三档截图：`docs/team/t568-1440.png`、`t568-960.png`、`t568-480.png`（CDP 1440×1000/960×900/480×900，dpr1；组数 2/2/1，根无横向）。
- build：**471 modules**；index `385.86 kB / gzip 114.91`；CSS `151.25 kB`；原 lazy panel chunk 仍在（GitGraph/MergeQueue/PlanDraft/Poll/Settings/Memory/Team）。
- 与 before（469 modules，index 383.86/gzip114.29）相比仅 manifest/loader 模块增量，无新依赖/远程代码。

## 6. 验证

```text
pnpm typecheck  # exit 0
pnpm build      # exit 0（471 modules）
pnpm test -- --testTimeout=20000 --maxWorkers=1 --no-file-parallelism
                # 181 files / 1229 tests passed（serial）
```

## 7. 回滚

删除 `panelManifest.ts`/`panelLoaders.ts`，把 `panelRegistry.PANEL_DEFS` 恢复为旧对象、App 恢复 `load*` 常量即可；无数据/事件/权限迁移。MF1-2（边界/import 白名单/chunk budget）留后续 PR。
