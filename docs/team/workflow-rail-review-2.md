# P0-3 WorkflowRail + NeedsMe · 复审 round 2（t229）

- **对象**：PR #36 `feature/t222-workflow-rail-needsme`，HEAD `d60479f`（OPEN/MERGEABLE）；t228 修复
- **评审人**：aria（独立复审，未修改生产代码）
- **基线**：main `c60d30b`；t224 findings（F1 failed CTA、F2 enqueue stale、F3 960 blank、F4–F7）
- **结论**：**PASS（无 blocker）**；t228 代码/测试修复成立，保留 3 条 low 观察。

## 1. 命令

在 `branches/t222-workflow-rail-needsme` 复跑：

- `pnpm typecheck`：0
- `pnpm build`：0（416 modules；css250.61 kB/gzip30.48；js1,244.92 kB/gzip342.40；main1.5MB/preload11.7）
- `pnpm test`：0（**68 文件/667 用例**；WorkflowRail 3、workflowData 7、useMergeQueue 4、DockShell 4、workflowStageNavigation 2）

worktree clean；PR #36 OPEN/MERGEABLE；无 gate/权限/状态机/数据层改动。

## 2. 逐项复核

### F1（high）failed CTA 误导 — 已修

- `workflowData.ts` failed 阶段 CTA 改为 **“查看失败任务”**，不再假装一键 retry。
- 新增 `workflowStageNavigation(stage, taskId)` 纯合同（`App.tsx` 导出）；`handleWorkflowStage` 使用同一映射，避免文案/行为漂移。
- 测试：failed CTA 文案 + `{panel:"tasks",taskId:"f1"}`；review-blocked 仍进入 `review` focus；discuss/deliver/remember 映射既有 surface。
- failed 仍两步（查看任务页再重试），但文案已诚实对应导航，符合 t224 要求二选一。

### F2（medium）TaskVcs enqueue stale — 已修

- `useMergeQueue` 增加请求 token；旧 workspace/key 响应不会覆盖新状态。
- active（MergeQueue modal 打开）2s 短轮询；非 active 5s 背景轮询，覆盖 TaskVcs enqueue/approve/start/waive 没有 App callback 的变化。
- 测试：active poll、background enqueue、stale response ignored。
- 残余 latency ≤5s（背景轮询），不再是无限期 stale；符合“无 callback 时最终收敛”的 P0-3 要求。

### F3（medium）960 主区空白 — 已修

- `reconcileSingleLayout` 新增 `dockWidth`：single 下把主组 `setSize({width: measuredDockWidth})`；Team 右组仍先收敛为 main tab。
- `DockShell` rebuild 传入 `measureDockWidth()`；新增 fake API 测试。
- `t222-workflow-960.png` 重拍：主区填满 960（侧栏折叠 56 + Dock 898），无右侧 200px 空白；WorkflowRail 仍全宽。

### F4–F7 处理

- F5：NeedsMe `aria-controls`/`aria-expanded`、Arrow/Home/End、Esc/点击外部回焦；测试。
- F4/F6：App 阶段导航合同 + rail failed CTA 测试；`WorkflowRail.test` 3 例。
- F7：interactive/approval 聚合明确留 P1；不冒充本任务范围。
- `useMergeQueue` 5s 背景轮询、token；`DockShell` single 宽度；`WorkflowRail` 点击外部 focus。

### 无回归

- 阶段 unknown/空态诚实：unknown/cancelled 无 CTA；done+null unknown、done+[] remember、done+pending deliver。
- NeedsMe failed/blocked/review/merge/alert/budget 聚合、id 去重、budget alert 优先、空态隐藏。
- 六阶段/`aria-current`；rail 42px；Dock/⌘K/Alt/深链/Settings 保留；960 screenshot 主区填满。
- 全量 68/667；无权限/审批/状态机/数据层改动；无越界。

## 3. 非阻塞观察

- **N1（low）**：TaskVcs enqueue 现在最多 5s 背景轮询后可见；若产品要求“点击加入队列即刷新”，后续可加 `onEnqueued` 显式 callback，不影响当前验收。
- **N2（low）**：`WorkflowRail.test` 仍主要覆盖渲染/CTA/Arrow；`Esc`、点击外部回焦、NeedsMe 初始 focus 没有直接测试（代码存在）。建议发布前补一条 App/组件交互测试。
- **N3（low）**：点击 popover 外时 `pointerdown` 先 `needsButtonRef.focus()`，随后浏览器可能再把焦点给被点击控件；对键盘可用，但真实 Electron 建议冒烟。

## 4. 判定

t224 的 F1/F2/F3 已修复；F4–F7 按范围处理；三命令 68/667 全绿、960 截图填满、无 state/gate/权限回归。**PASS**，PR #36 可进入集成/合并；N1–N3 为 low 后续/冒烟项，不阻塞。
