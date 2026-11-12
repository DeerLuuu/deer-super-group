# P0-8 流式隔离 R1 · 独立验证报告（t261）

- **任务**：t261 [verification] 独立验证 t260 P0-8
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #40 `feature/t260-perf-isolation`，HEAD `983a528`（OPEN/MERGEABLE；worktree `branches/t260-perf-isolation`，clean）；未合并，未修改生产代码。
- **方法**：worktree 复跑三命令 + 读 ChatLiveStore/Bridge/Tail/App/测试/docs + 对照 t259 R1/R2/R3 设计。

---

## 1. 结论：**BLOCKED（不通过，needs revision）**

R1 流式隔离主体成立：token/tool/reasoning 移出 App，ChatLiveTail 独立订阅；实际 ChatView 150 历史 + 20 token 仅 1 次 render；App/其他 panel 没有 live setState。

但 **P0-8 的 R3 刷新隔离完全未进入 PR**（t260 自己声明只做 R1）：

- App 仍是 `onEvent → 220ms setTimeout → refresh`（`App.tsx:1265-1276`），**没有 RefreshCoordinator、domain/seq、in-flight/generation、120ms coalesce、dirty-only**；
- `refresh()` 直接 `await getSnapshot → setSnapshot`（`:1046-1049`），无请求序号/取消；基线 getSnapshot 147–237ms，220ms 窗口可不重叠也可能重叠，旧响应可覆盖新快照；
- 没有 seq gap/断线恢复/失败 backoff；`mergeQueue` 隐藏轮询、`watchdog` 15s 轮询未移除；
- 没有任何 refresh 去重/重复/漏刷新/断线测试。

因此 t261 验收项 3「刷新去重/合并；无重复/漏刷新；断线恢复」**失败**，P0-8 不能按完成验收。**F1 blocker**。

另：每 token 证据只有 synthetic sibling panels + 实际 ChatView；未测实际 Dock/rail/WorkflowRail/NeedsMe（F2 medium）。plain test 首轮 1 个既有 5s timeout（openai），extended 740/740（F5）。

---

## 2. 命令（worktree HEAD `983a528`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 430 modules；css 258.43 kB (gzip 31.64)；js 1,277.06 kB (gzip 353.00)；electron main 1.5MB/preload 11.9kB |
| `pnpm test`（plain） | **1** | 1 个既有 5s timeout：`openai.test`；739/740 |
| `pnpm exec vitest run --testTimeout=10000` | **0** | 89 文件/740 用例全绿 |

---

## 3. 逐项

### 3.1 每 token 仅 Chat 子树更新（PASS，证据边界 F2）

- `ChatLiveStore` external store；App 删除 5 个 live useState 与 onChatEvent；`ChatLiveBridge` effect-only；`ChatLiveTail` 唯一订阅完整 live state；`ChatView` 只订阅低频 terminals Map。
- `chatLiveIsolation.test`：150 历史 + 6 memo sibling + 20 delta → parent/History/SiblingPanels 各 1 render，live child ≥20；`chatViewIsolation.test`：真实 ChatView + 150 messages + 20 delta → ChatViewProbe 1 render，live tail 文本出现。
- **F2 medium**：synthetic Harness 只证明 memo siblings，不证明真实 Dock panel/PrimaryRail/WorkflowRail/NeedsMe；无 React Profiler 或 App 级 render counter。代码上 App 无 live setState，但验收要求点名这四个宿主。

### 3.2 面板/rail/Workflow/NeedsMe 不随 token rerender（PASS，F2 证据）

- App 根没有 token setState；`ChatLiveBridge` 不 setState；`ChatLiveTail` 在 ChatView 内；rail/Workflow/NeedsMe 只由 snapshot 派生。
- 但同 F2：没有实际组件级 render counter/Profiler 断言；如出现 Context/父 memo 漏点，测试无法发现。**建议补真实宿主 fixture**。

### 3.3 长历史/多面板/tool/terminal/thinking/取消/错误（PASS，F3 测试面）

- `shared/chatLive.test` 7、store 4：delta/reasoning/segment/tool_call/tool_result/done/cancelled/error、workspace 过滤、clearLive 保 terminal、每段 translation 一次。
- 实际 ChatView 150 历史 + 20 delta 稳定；旧 `chatTurnUi` 9 条仍绿。
- **F3 medium**：新测试未覆盖真实 ChatLiveTail 的 tool/terminal/thinking/取消/错误的 UI 集成；只测 reducer/store + 旧 fixture。功能未见回退，但证据面比 t260 输出声称窄。
- 1440/960：本 PR 无 CSS/布局改动，沿用既有截图；未新增 R1 视觉基线（F4 low）。

### 3.4 刷新去重/合并/断线恢复（FAIL）

- App 仍为 220ms debounce（`refreshTimer`），`refresh()` 无 in-flight/generation/seq；无 RefreshCoordinator、domain 分流、dirty-only、gap 检测、backoff、last-good/stale。
- t260 docs §5 明确 R3 **未做**；PR 文件也没有 RefreshCoordinator/相关测试。
- **无任何测试**覆盖 burst 合并、并发旧响应、seq gap、失败/断线恢复。
- **F1 blocker**：验收项 3 不成立；P0-8 不能整体通过。

### 3.5 范围/依赖/无未批准重写（PASS）

- PR 仅 App + shared/chatLive + shell/chat 新文件/tests/docs；未改 electron/kernel/git/memory/review/watchdog/styles；无权限/gate/数据层变更。
- 未引入 Monaco/虚拟列表/React Compiler/微前端；无双状态库；R2/R3 未混入（R3 缺失正是 blocker）。
- 未新增 npm 依赖。

---

## 4. 发现

| ID | 级别 | 发现 | Required fix |
|----|------|------|--------------|
| **F1** | **blocker** | R3 刷新隔离未实现：App 仍 220ms debounce + 无 in-flight/seq/generation/coalesce/dirty-only；无断线恢复；无 refresh 测试 | 按 t259 R3 实现 RefreshCoordinator（domain/seq gap/120ms coalesce/in-flight generation/dirty-only），移除隐藏轮询，补 burst/并发/失败/断线测试；或把 t261 验收明确收窄为 R1 |
| F2 | medium | 每 token 证据只有 synthetic siblings + ChatView；未测真实 Dock panel/PrimaryRail/WorkflowRail/NeedsMe，无 Profiler/App render counter | 补真实宿主 fixture 的 render count/Profiler；在 6 面板 + rail/Workflow/NeedsMe 上断言 token=0 rerender |
| F3 | medium | 新测试未覆盖 ChatLiveTail 的 tool/terminal/thinking/取消/错误 UI 集成，只测 reducer/store | 补真实 ChatLiveTail 事件序列/终端/翻译回归 |
| F4 | low | R1 无 CSS/布局改动，未新增 1440/960 截图；沿用既有截图 | 评审前人工抽查或补截图 |
| F5 | low | plain test 首轮 1 个既有 5s timeout（openai），extended 740/740 | CI 单独超时/串行 |

---

## 5. 结论

- R1 的 live store/bridge/tail/实际 ChatView 隔离成立；功能状态保留矩阵完整；三命令 extended 740 全绿。
- **F1 阻塞 P0-8 整体验收**：刷新隔离 R3 不在 PR 中，t261 验收项 3（去重/无重复/漏刷新/断线恢复）失败；F2/F3 证据面不足。
- PR #40 可作为 R1 独立评审/合并候选，但 P0-8 不能标记完成；需另建/排期 R3（及 R2）并重新验收。本次未修改生产代码。

*本次验证仅新增本报告。*
