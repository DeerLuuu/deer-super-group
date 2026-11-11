# Dock 最大分栏设置 · 独立评审（t210）

- **评审对象**：t208 实现 / t209 验证 / PR #34
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/34
- **Head**：`c951d75`（base `fc4cbd3`），OPEN / MERGEABLE / worktree clean
- **评审范围**：13 文件 diff；只读评审，未修改生产代码
- **结论**：**PASS**。无 blocker；4 条低优先建议（N1–N4）不阻塞合并。

---

## 1. 独立验证

在 `branches/t208-dock-max-groups` worktree 独立运行，未使用 t208 的结论替代：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **0** |
| `pnpm build` | **0**（Vite + electron main/preload 完成；main 1.5MB / preload 11.7kB） |
| `pnpm test` | **0**；**63 文件 / 640 用例**全部通过 |

补充检查：`git diff --check fc4cbd3..HEAD` 无输出；`git status --short` 为空；PR `MERGEABLE`。

---

## 2. 验收逐项

### 2.1 LayoutSettings 默认/范围/clamp/持久化

- `LayoutSettings { maxDockGroups }`、`MIN=2`、`MAX=8`、`DEFAULT=6`（`src/shared/types.ts:572-596`）。
- `normalizeMaxDockGroups`：非有限数 → 6；有限数四舍五入并 clamp 2–8（`types.ts:585-590`）。
- `LlmSettings.layout` 可选；`LlmSettingsInfo.layout` 由 store 返回（`types.ts:608-627`）。
- Store：新增 `layout.settings` JSON key；`getLlmSettings` 每次 `normalizeLayoutSettings`；`saveLlmSettings` 仅在 `settings.layout !== undefined` 时写，旧调用保留现值（`src/kernel/store.ts:2618-2624`、`2659-2665`）。
- 测试：默认6；8/99/1 clamp；文件 store 重开保持7；非数字→6；省略 layout 保留7（`src/kernel/layoutSettings.test.ts:1-71`）。
- 判断：**通过**。全局设置（非 per-workspace）与文档声明一致；未引入 schema migration。

### 2.2 Settings 入口清晰

- `SettingsSection` 新增 `interface`；导航顺序模型 → 界面 → 翻译 → Git → 插件 → MCP → Skills → 团队（`src/SettingsView.tsx:14-31`）。
- 界面段有“最大分栏数”下拉（2–8，默认标记）、范围/即时生效/既有分栏保留说明、独立“保存界面设置”和保存状态（`SettingsView.tsx:727-780`）。
- App 设置 Modal 描述同步加入“界面”（`src/App.tsx:3011-3017`）。
- 设置截图：`docs/team/t208-settings-interface-6.png`（当前6）、`...-8.png`（保存8）；metrics 记录 default6→saved8→reload8→restore6（`docs/team/t208-settings-metrics.json`）。
- 判断：**通过**。入口可发现；保存反馈在本段内；截图与 metrics 一致。

### 2.3 DockShell 动态上限：鼠标/键盘/通知

- `DockShell` 新增必填 `maxGroups`，App 传 `snapshot.settings.layout?.maxDockGroups ?? 6`（`src/App.tsx:2684-2690`）。
- `effectiveMaxDockGroups` 统一 normalize；`canAddDockGroup(current, max)` 为 `current < max`；`dockGroupLimitMessage` 用当前值（`src/shell/dock/dockGroups.ts:1-18`）。
- 鼠标：`onWillDrop` 对非 center drop 调 `canAddDockGroup`，拒绝时 `preventDefault` + 当前上限通知（`DockShell.tsx:543-555`）。
- 键盘：`moveActivePanel` 无相邻组时同一 `canAddDockGroup` 判断，通知当前上限（`DockShell.tsx:478-488`）。
- 即时生效：`groupLimitRef` 每 render 更新；`maxGroups` 不在 `dockWidth`/`workspaceId`/variant effect 依赖中，未触发 `rebuild`（`DockShell.tsx:156-160`、`279-295`）。所以设置保存后只改上限，不重置布局。
- 判断：**通过**。鼠标/键盘共用 helper，通知文案与当前值一致。

### 2.4 6/7/2/8 边界与即时生效

- `dockGroups.test.ts`：默认6；5→6 允许、6→7 拒绝；8 允许、8→9 拒绝；2 时 2→3 拒绝（`src/shell/dock/dockGroups.test.ts:1-36`）。
- SettingsView 测试：界面→选8→保存，payload `layout.maxDockGroups===8`，dirty 清零、显示已保存（`src/SettingsView.test.tsx:160-197`）。
- Store 测试覆盖 7 持久化/重开、旧调用保留。
- 判断：**通过**。功能边界由纯函数 + 持久化 + UI 三层覆盖。

### 2.5 Dock/深链/快捷键/窄窗/权限无回归

- Diff 仅 13 文件：types/store/SettingsView/App/DockShell + 2 个新 helper/test + 3 个测试 + docs/screenshots。
- 未改 `electron/`、权限/审批/执行/调度/Git/记忆/评审；未改 Dock 存档 schema `deer.dock.v1`、深链、快捷键、`selectVariant`/single/Team within 逻辑。
- 现有 640 用例全绿，包括 dock layout/窄窗/深链/权限/审批/执行相关回归。
- 判断：**通过**，无越界改动。

### 2.6 命令与无越界

- 三命令均独立 exit 0（见 §1）。
- 无生产代码之外的无关重构；docs/截图/测试属于该功能必要证据。
- 判断：**通过**。

---

## 3. 低优先建议（不阻塞）

### N1 · low · DockShell 文件头注释仍写“最多 4 组”

- **证据**：`src/shell/dock/DockShell.tsx:54` 仍写“鼠标拖拽与键盘同样受最多 4 组约束”。
- **影响**：后续维护者可能误以为硬编码上限仍是 4；功能已是默认 6/2–8。
- **建议**：改为“受可配置 maxGroups（默认 6，2–8）约束”。
- **成本**：S。

### N2 · low · 缺少 DockShell 组件级“设置变化不 rebuild”测试

- **证据**：`dockGroups.test.ts` 只测 helper；`DockShell` 的 ref 更新/不 rebuild、鼠标/键盘分支没有组件级断言。t209 报告 N5 也记录了这一点。
- **影响**：未来若把 `maxGroups` 加入变体 effect，单测不会阻止布局被重置。
- **建议**：增加 DockShell 测试（mock dockview api）断言 maxGroups 变化只更新 ref、不调用 `api.clear/addPanel`。
- **成本**：S–M。

### N3 · low · 空字符串会 clamp 到 2，而不是回默认 6

- **证据**：`normalizeMaxDockGroups("")`：`Number("")=0` → clamp 2（`src/shared/types.ts:585-590`）；测试只覆盖 `"nope"`/`"abc"`。
- **影响**：设置 UI 的 select 不会产生空串，但外部/旧数据/表单异常值会得到 2 而不是默认 6，语义上“非法值回默认”不一致。
- **建议**：trim 后空串视为非数字回 6；补一条边界测试。
- **成本**：S。

### N4 · low · 达到上限的拒绝通知使用 success toast

- **证据**：DockShell 的 `notify(dockGroupLimitMessage(...))` 由 App 的 `onNotify` 接到 `pushToast({kind:"success"})`（`src/App.tsx` DockShell `onNotify`；`DockShell.tsx:486`、`553`）。
- **影响**：用户拒绝拆分时看到绿色成功提示，与“未执行”语义不符。
- **建议**：DockShell `onNotify` 增加 kind，或把上限拒绝文案标为 warning/info。
- **成本**：S。

> 以上 N1–N4 均不影响功能正确性、边界、持久化或回归；不建议因此阻塞 t208 合并。

---

## 4. 证据索引

- `src/shared/types.ts:572-627` LayoutSettings/normalize/LlmSettings
- `src/kernel/store.ts:2618-2665` 持久化读取/保存
- `src/SettingsView.tsx:14-31`、`727-780`、`src/App.tsx:3011-3026` 设置入口/保存
- `src/shell/dock/dockGroups.ts:1-18`、`src/shell/dock/DockShell.tsx:156-160`、`478-488`、`543-555` 动态上限
- `src/kernel/layoutSettings.test.ts`、`src/shell/dock/dockGroups.test.ts`、`src/SettingsView.test.tsx`
- `docs/team/t208-settings-interface-6.png`、`...-8.png`、`docs/team/t208-settings-metrics.json`
- PR #34 body / t209 验证报告（作为交叉材料，不替代本次独立命令）

## 5. 结论

**verdict: pass**。t208 的默认值、范围/clamp、持久化、Settings 入口、DockShell 鼠标/键盘动态上限、即时生效与无重置均符合契约；独立复跑 typecheck/build/test 全绿，无越界或 blocker。建议后续以 N1–N4 作为小型清理，不阻塞合并。
