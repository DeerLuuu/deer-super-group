# Dock 最大分栏数：默认 6 且可在设置中调整（t208）

- **任务**：t208 `[implementation]` 将 Dock 最大分栏默认从 4 提升到 6，并支持设置 2–8、即时生效
- **基线**：main `fc4cbd3`（t197 P0-1 集成后）
- **分支**：`feature/t208-dock-max-groups`
- **范围**：LayoutSettings（types/store/service 经既有 settings IPC）、SettingsView「界面」分区、DockShell 动态上限、文档/截图
- **结论**：默认 6；设置可改 2–8；保存后即时生效、刷新保持、不重建当前布局；6/7 与 2/3 边界有测试；三命令全绿。

---

## 1. 现状与目标

- 原 `DockShell.MAX_GROUPS = 4` 为硬编码，鼠标拖拽拆分与键盘 `Ctrl+Shift+Alt+方向键` 在 4 组时拒绝。
- 用户要求：默认最大 **6** 组；设置中可改（范围 2–8），保存即时生效，不重置现有布局/深链/快捷键/窄窗行为。

## 2. 数据模型与持久化

`src/shared/types.ts`：

```ts
export interface LayoutSettings { maxDockGroups: number }
export const DEFAULT_LAYOUT_SETTINGS = { maxDockGroups: 6 };
export const MIN_MAX_DOCK_GROUPS = 2;
export const MAX_MAX_DOCK_GROUPS = 8;
export function normalizeMaxDockGroups(value): number; // 非法→6，越界 clamp 2–8
export function normalizeLayoutSettings(value): LayoutSettings;
```

- `LlmSettings.layout?: LayoutSettings`：旧调用不传时**保留**已保存值，不重置；
- `LlmSettingsInfo.layout?: LayoutSettings`：store 每次返回（旧快照缺失时 App/Settings 回退默认 6）。

`src/kernel/store.ts`：

- 新增 settings key `layout.settings`，JSON 存 `{ maxDockGroups }`；
- `getLlmSettings()` 读取并 `normalizeLayoutSettings`（缺失/损坏→6）；
- `saveLlmSettings()` 仅在 `settings.layout !== undefined` 时写入，保证旧调用（例如只看模型的调用方）不会覆盖布局设置；
- 全局持久化（不按 workspace），新工作区/旧工作区默认相同。

`src/kernel/service.ts` 沿用 `saveSettings()/getSettings()`；`src/shared/ipc.ts`、`electron/main.ts`、`electron/preload.ts` 的 `settings:get/save` 已透传 `LlmSettings` 对象，无需新增 IPC 通道。

## 3. 设置「界面」入口

`src/SettingsView.tsx`：

- 左侧新增 **界面** 分区（`SettingsSection = "interface"`，位于模型之后），hint「Dock 分栏与布局」；App 设置 Modal 描述同步加入「界面」。
- 内容：`最大分栏数` 下拉（2–8，标记默认 6）、说明「保存后立即生效，不会重置当前布局；已超过新上限的现有分栏会保留，只拒绝继续拆分」、独立的「保存界面设置」按钮与保存状态。
- layout 进入 dirty 指纹：修改即 dirty；保存 payload 携带 `layout: { maxDockGroups }`；保存成功更新 layout baseline 并清 dirty，失败保留草稿与 dirty（沿用 t190 行为）。

## 4. DockShell 动态上限

`src/shell/dock/dockGroups.ts`：

```ts
effectiveMaxDockGroups(value) // normalize 2–8
canAddDockGroup(currentGroups, maxGroups) // currentGroups < limit
dockGroupLimitMessage(maxGroups) // "最多 N 个分栏，请先拖回合并"
```

`src/shell/dock/DockShell.tsx`：

- props 新增 `maxGroups: number`；App 传 `snapshot.settings.layout?.maxDockGroups ?? 6`；
- `groupLimitRef` 每次渲染更新，`onWillDrop`（鼠标）与 `moveActivePanel`（键盘）统一用 `canAddDockGroup`；
- 通知文案用 `dockGroupLimitMessage` 的当前值；
- `maxGroups` 变化**不参与**变体/布局 effect，不触发 rebuild；只改上限，现有 Dock 布局、深链、快捷键、single/Team within/窄窗逻辑保持；
- 上限降低时已存在的分栏不关闭，只拒绝新增拆分（符合“不重置现有布局”）。

## 5. 行为矩阵

| maxDockGroups | 已有 5 组再拆 | 已有 6 组再拆 | 已有 7 组再拆 | 已有 8 组再拆 |
|---|---|---|---|---|
| 2（设置） | 拒绝（第 3 组起） | 拒绝 | 拒绝 | 拒绝 |
| 6（默认） | 允许（第 6 组） | 拒绝（第 7 组） | 拒绝 | 拒绝 |
| 8（设置） | 允许 | 允许 | 允许（第 8 组） | 拒绝（第 9 组） |

- `src/shell/dock/dockGroups.test.ts` 4 例：默认 6、clamp、6 允许/7 拒绝、8 允许、2 时第 3 组拒绝；
- `src/kernel/layoutSettings.test.ts` 4 例：fresh store 默认 6、8/99/1 clamp、文件 store 重开保持、非数字回 6、旧调用省略 layout 保留 7；
- `src/SettingsView.test.tsx` 新增 1 例：点击「界面」→ 选择 8 → 保存 → `onSave` payload `layout.maxDockGroups===8`、dirty 清零、显示「已保存」。

## 6. 真实 Electron 截图与持久化证据

真实 Electron app（worktree 构建）+ 真实 `按钮工厂` workspace DB，CDP 打开 设置→界面：

- `docs/team/t208-settings-interface-6.png`：默认「当前 6 栏」、下拉 6 栏（默认）；
- `docs/team/t208-settings-interface-8.png`：改为 8 并保存，显示「当前 8 栏」「已保存」；
- `docs/team/t208-settings-metrics.json`：
  - default：`layout.maxDockGroups=6`、select=6；
  - saved8：`layout.maxDockGroups=8`、select=8、`已保存`；
  - afterReload：仍为 8（刷新保持）；
  - restored6：截图后已恢复 6（避免污染开发 profile）。

截图是真实 Electron renderer/back‑end，不是 headless mock；Dock 多分栏的拖拽/键盘边界以 helper 单测 + 代码路径验证（当前 workspace 无 6–8 组需求，未人为制造多分栏截图）。

## 7. 验证

在 worktree `feature/t208-dock-max-groups`、最终代码执行：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **0** |
| `pnpm build` | **0**：js **1,233.53 kB / gzip 338.87**；css 246.17 / gzip 29.72；electron main 1.5MB、preload 11.7kB |
| `pnpm test` | **0**：**63 文件 / 640 用例**全绿（新增 dockGroups 4、layoutSettings 4、SettingsView +1） |

> 测试环境曾因残留 Electron/后台负载出现既有 watchdog 5s timing flake；关闭后全量 640/640 通过；单独运行该测试亦通过，非本功能回归。

## 8. 风险与回滚

- **风险**：LayoutSettings 为全局设置；降低上限不会关闭已有分栏，只拒绝新增拆分（用户意图保留）。旧调用省略 layout 时由 store 保留原值。
- **回滚**：revert 本 PR 单提交；settings key `layout.settings` 保留但不会被旧代码读取，无 schema 迁移/数据损坏风险。
- **不改**：权限/审批/内核/调度/Git/记忆/评审语义均未触碰；Dock 存档 schema 不变（`deer.dock.v1`）。

## 9. 改动文件

```text
src/shared/types.ts              LayoutSettings + normalize + LlmSettings(.layout)
src/kernel/store.ts              layout.settings 持久化、get/save、旧调用保留
src/SettingsView.tsx             界面分区、最大分栏数下拉、dirty/payload/保存
src/App.tsx                      Settings Modal 描述；DockShell maxGroups 传入
src/shell/dock/dockGroups.ts     上限纯函数
src/shell/dock/DockShell.tsx     maxGroups prop、动态鼠标/键盘上限与文案
src/shell/dock/dockGroups.test.ts
src/kernel/layoutSettings.test.ts
src/SettingsView.test.tsx
docs/team/dock-max-groups.md
docs/team/t208-settings-interface-{6,8}.png
docs/team/t208-settings-metrics.json
```
