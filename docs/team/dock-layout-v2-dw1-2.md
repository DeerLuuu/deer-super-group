# DW1-2：命令 reducer + v2 持久化 + 接线测试（t526）

- **实现**：mika（GLM 5.3）· 依据 `docs/team/architecture-batch-v2.md` §3.4/§3.5
- **状态**：纯数据层（reducer/persistence/parity 测试），不接新 DockTree 渲染器（DW1-3）；dockview 运行不受影响；无新依赖。
- **文件**：`src/shell/dock/layoutOps.ts`（新增）、`src/shell/dock/layoutOps.test.ts`（新增，21 用例）、本文档。

## 1. 命令 reducer（layoutOps.ts）

- **`reduceDock(layout, command, context) -> { layout, effects }`**（纯函数）：
  - 命令矩阵：`open`（cause 信号）/ `close` / `activate` / `move`（center+edge）/ `split` / `resize` / `dragDrop`（center→move center，edge→move edge）/ `reset`（当前变体或指定变体回默认）；
  - **守卫**：未知 panel notify 拒绝；`close` 不可关闭面板（settings）运行时拒绝 + notify（旧 renderer「关闭按钮隐藏」语义等价）；panel/target 缺失 no-op（复用 DW1-1 双守卫）；超组数 split/move-edge 拒绝 + notify（与 onWillDrop 语义一致）；
  - **出口不变量**：每个命令 → clampGroups → normalize → `validateLayout` 恒空（开发期断言，违反即 throw）；
  - **effects** 只有信号：`persist`（400ms debounce 由宿主做）/ `notify`（提示文案）/ `activatedPanel`（激活回调）——不做 DOM；
  - **引用稳定**：no-op 命令返回原 layout 引用（宿主可直接短路）。

## 2. v2 持久化

- **key**：`deer.dock.layout.v2.<workspaceId>`（`v2StorageKey`）；**不读、不迁移 v1 `deer.dock.state` / `deer.dock.v1.*`**（源码扫描测试机器证明）；
- **`loadV2Store`**：schema/version/variants 结构校验 + 每个 variant 布局 `validateLayout`；损坏/超限（64KB）/版本不符/结构非法 → 删除 key 返回 null（调用方回默认）；
- **`saveV2Store`**：序列化前 64KB 上限；失败/不可用返回 false 不抛错；
- **`clearV2Store`**：reset all；
- **降级**：localStorage 不可用（node/SSR）→ safeStorage 返回 null，读写静默降级（测试覆盖）。

## 3. maxGroups 裁剪（N1 遗留项落地）

- **`clampGroups(layout, maxGroups)`**：组数超限时从最深边缘组开始，面板按 tab 顺序并入 active group（center 语义），循环直到 ≤ limit；panel 不丢失、validate 恒空；默认布局（≤2 组）天然不触发；
- 断点（wide/medium/narrow/single）沿用 `panelRegistry.selectVariant`，本模块零阈值变更；
- **`switchVariant(store, current, next)`**：保存当前变体 → 恢复目标变体 v2 存档（clamp 后）或默认。

## 4. 接线 / fake renderer parity

- fake renderer 把布局树渲染为纯文本快照（`group(id): tab|tab*` + split axis/sizes），parity 测试断言新模型操作与旧 dockview 布局语义的关键行为一致：open 已存在激活、close 删组、move center 并入（右分栏组消失）、split 新组、reset 回默认快照逐字节相等、settings 不可关闭 = 旧「按钮隐藏」；
- **PanelHost/面板内容不改**：DW1-3 渲染器接入时用 `reduceDock` 作为唯一状态源 + effects 驱动持久化/通知；`DockShell` 现行 dockview 路径未动。

## 5. 验证

`pnpm typecheck` 0；`pnpm build` 0；serial `pnpm test` 全绿（新增 21 用例：命令矩阵 11 + 裁剪 2 + 持久化 5 + 变体切换 1 + parity 2）。见 PR checks。

## 6. 范围与移交

- 未接新 DockTree 渲染器（DW1-3）；未改 DockShell/dockview 运行路径；package.json 无变更；
- DW1-3 接入点：`reduceDock` 为唯一命令入口（`DockShell.onReady/键盘/拖放 → reduceDock → setState + effects.persist → saveV2Store`）；`switchVariant` 用于宽度断点切换（保存旧变体 + 恢复新变体）；
- DW1-1 遗留 N1（normalize 不降 >maxGroups）已由 `clampGroups` 在 reducer 出口解决；N2（seed env）仍未做（DW1-3 测试基建）。

## 7. t530 修复记录（repair-round-2，mika / GLM 5.3）

t527 验证 F1–F5 修复，同一 PR #77 分支：

- **F1（blocker）真实接线**：
  - `useDockLayoutController`（layoutOps.ts）：v2 布局状态控制器——init 从 loadV2Store/defaultLayout；`dispatch` 是 v2 命令**唯一入口**（reduceDock）；effects.persist → 400ms debounce `saveV2Store`；effects.notify → onNotify；effects.activatedPanel → onActivePanelChange；`setVariant`（switchVariant + 立即持久化）；卸载 flush（React 19 严格模式安全）。
  - `DockShell.tsx` 真实消费：DockHandle 五个命令（openPanel/closeActivePanel/resetLayout/resetAllLayouts/moveActivePanel）在执行 dockview legacy 行为的**同时** `v2DispatchRef.current(dispatch)` —— shadow-sync 模式：渲染不变（dockview legacy 默认，零回归），v2 存档随操作逐步构建，为 DW1-3 切换准备数据。React 接线测试 2 用例（react-test-renderer + IS_REACT_ACT_ENVIRONMENT）：dispatch→activate/notify 回调 + debounce 后 v2 store 写入含 gitGraph；setVariant 双变体持久化。
- **F2 生产轻量不变量**：`assertLightweightInvariants`（panel 唯一 + 组数 + sizes 有限，O(panels+groups)）生产也执行；完整 validateLayout 仅 dev（性能考虑）。
- **F3 variant 一致性**：loadV2Store 校验 `layout.variant === variants key`，不一致按损坏处理（删除 key 回 null）；+1 测试。
- **F4 字节长度**：`byteLength`（TextEncoder UTF-8）用于 64KB 读写上限。
- **F5 switchVariant 归属**：返回 `{ layout, store, savedPrevious }`——持久化归属明确为调用方；controller 的 setVariant 内部完成 store 更新（含新变体）+ saveV2Store。
- **真实 Electron/CDP 走查（scripts/t530-cdp.mjs + t530-walkthrough.json，ALL PASS）**：
  - 三档 1440/960/480 截图（t530-dock-{1440,960,480}.png）+ 每档 scrollWidth 无溢出；
  - 交互：侧栏「任务」「记忆」nav 点击 → DockHandle.openPanel → v2 dispatch open → **v2 store 实际写入**（keys=["deer.dock.layout.v2.ws_…"]，schema=deer.dock.layout version=2，variants=["wide"]）；
  - Ctrl+Alt+W close dispatch；v1 key 由 legacy 路径管理，v2 路径不读写（不迁移验证）；
  - 复用真实 deer.db 用户数据（隔离 userData 副本）驱动非空 shell。
- 验证：typecheck 0 / build 0 / serial test 全绿（layoutOps 24 用例，+3）。
