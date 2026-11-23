# DW1-1：Dock 布局模型 + 默认布局 + 属性测试（t506）

- **实现**：mika（GLM 5.3）· 依据 `docs/team/architecture-batch-v2.md` §3.3（t497 定稿）
- **状态**：纯数据层，不接 UI；DockShell/dockview 未动；无运行时行为变化；无新依赖。
- **文件**：`src/shell/dock/layoutModel.ts`（新增）、`src/shell/dock/layoutModel.test.ts`（新增）、本文档。

## 1. 模型（layoutModel.ts）

- **类型**：`LayoutSplit | LayoutGroup` 树、`DockLayout {schema:"deer.dock.layout", version:2, variant, root}`；panel 全局唯一（`PanelKey` 复用 panelRegistry）。
- **约束常量**：`MIN_GROUPS=2 / MAX_GROUPS=8 / DEFAULT_MAX_GROUPS=6`；`effectiveMaxDockGroups(maxGroups, variant)`（single 恒 1，其余默认 6、clamp 2–8）；`groupMinWidth/Height` 取组内面板最大 `PANEL_DEFS.min*`。
- **validate**（从不抛错，返回 `ValidationIssue[]`）：空 root/空组、未知/重复 panel、active 越界、split children<2、sizes 长度不匹配、NaN/负数权重、权重和≤0、组数超限、节点 id 重复——12 个错误码全覆盖（测试逐项断言）。
- **normalize**（幂等）：空组删除、single-child split 折叠、sizes 修复为正数且和=1（含舍入残差补偿到最大权重）、active 不在组内回退首 panel、未知 panel 剔除、节点 id 保留（仅同次遍历内冲突才重编，保证调用方可依赖 id 稳定性）、全空树回退单 chat 组。
- **默认布局**：`defaultLayout(variant)`——wide/medium/narrow 主组（chat+MAIN_GROUP_ORDER+settings）+ team 右分栏（权重 VARIANT_WEIGHTS 58/42、56/44、52/48）；single 全部同组（team 是 tab）；defaultClosed 面板不进入；`defaultLayoutForWidth(dockWidth, windowWidth)` 复用 selectVariant 判档（含 t194 窗口 ≤960/single、Dock<920/single 语义）。
- **操作**（供 property tests 驱动；DW1-2 reducer 将以同语义复用）：`openPanelInLayout / activatePanelInLayout / closePanelInLayout（settings 拒绝）/ splitPanelInLayout（超组数拒绝）/ resizeSplitInLayout（和恒 1）/ movePanelInLayout（center 并入 + edge 拆分）`；`layoutEquivalent` 结构比较。

## 2. 属性测试（layoutModel.test.ts，20 用例）

- **单元**（10）：常量 clamp、组最小尺寸、四变体默认布局结构/权重/tab、defaultClosed 排除、断点判档、validate 12 错误码逐项、normalize 修复/幂等/全空回退、open/close/split/resize/move 语义。
- **property**（7+3）：确定性 PRNG（mulberry32，5 seeds × 260 ops = **1300 次随机操作 ≥ 1000**），每步后断言不变量：validate 空、panel 唯一、组数 1..limit、每个 split sizes 正数/和=1/长度一致、normalize 幂等；另有「随机重启等价」（操作序列后 normalize 双跑结构一致，5×260）。
- **边界回归**（1）：源码扫描（去注释）确认无 `localStorage` / `deer.dock.state` / dockview import——**不读 v1、不接 UI** 的机器证明。

## 3. 验证

`pnpm typecheck` 0；`pnpm build` 0；`pnpm test`（serial）全绿（新增 20 用例）。见 PR checks。

## 4. 范围与移交

- 不改 DockShell/UI、不删 dockview、不读/不写任何 localStorage key（v2 key `deer.dock.layout.v2.<ws>` 归 DW1-2 persistence）。
- DW1-2（command reducer + persistence v2 + PanelHost 接线测试）可直接复用本模块的 validate/normalize 与操作语义；`reduceDock(layout, command, context)` 建议包装本文件的 `*InLayout` 纯函数并补 effects。

## 5. 已知边界

- normalize 对「原树已有重复 id」的重编只保证本次输出唯一，不保证跨调用稳定（重复 id 本身是非法输入）。
- resize 的 0.01–0.98 clamp 是模型级；像素级 min-width 约束在渲染层（DW1-3）执行。
