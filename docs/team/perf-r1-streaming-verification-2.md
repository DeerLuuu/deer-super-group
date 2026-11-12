# P0-8 R1 流式隔离 · 复验报告（t264）

- **任务**：t264 [verification] 按 R1 合同复验 t260；R2/R3 不作为本 PR 阻塞项
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #40 `feature/t260-perf-isolation`，HEAD `983a528`（OPEN/MERGEABLE；worktree `branches/t260-perf-isolation`，clean）；未合并，未修改生产代码。
- **方法**：worktree 复跑三命令 + 读 ChatLiveStore/Bridge/Tail/App/测试 + R1/R2/R3 文件范围核对 + 合成/真实 render count 复核。

---

## 1. 结论：**PASS（按 R1 合同通过，无 blocker）**

- token/tool/reasoning 已移出 App：ChatLiveStore external store + ChatLiveBridge effect-only + ChatLiveTail 唯一完整订阅；App/其他面板无 live setState。
- 合成 150 历史 + 6 sibling + 20 delta：parent/History/Siblings 各 1 次 render，live child ≥20；真实 ChatView + 150 messages + 20 delta：ChatViewProbe 1 次 render。
- reducer/store 覆盖 delta/reasoning/segment/tool_call/tool_result/done/cancelled/error、terminal 保留、翻译每段一次；旧 chatTurnUi/terminal 语义测试保持。
- 长历史/多面板 fixture、1440/960 无 CSS/布局改动；未混入 R2 renderPanel/Dock、R3 RefreshCoordinator；无权限/gate/数据层/依赖变更。
- 三命令最终全绿：typecheck 0、build 0（430 modules）、test 89 文件/740 用例；plain 首轮仅既有 openai 5s flake，单独复跑 740/740。

R2（面板/context）与 R3（刷新协调器/断线恢复）按 t259 设计另行排期，不是本 PR 的验收项；本报告只按 R1 合同判定。

---

## 2. 命令（worktree HEAD `983a528`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 430 modules；css 258.43 kB (gzip 31.64)；js 1,277.06 kB (gzip 353.00)；electron main 1.5MB/preload 11.9kB |
| `pnpm test`（plain 首轮） | 1（既有 flake） | 仅 `openai.test` 5s timeout；739/740 |
| `pnpm test`（单独复跑） | **0** | **89 文件 / 740 用例**全绿 |
| `pnpm exec vitest run --testTimeout=10000` | **0** | 89/740 全绿 |

---

## 3. 逐项（R1 合同）

### 3.1 每 token 仅 Chat 流式子树更新（PASS）

- `ChatLiveStore`：subscribe/getSnapshot/dispatch/reset/clearLive/beginTranslation；纯 reducer。
- `ChatLiveBridge`：effect-only `window.deer.onChatEvent`，不持有 React state；按 workspace 过滤；done/cancel/error 只回调 settled。
- `ChatLiveTail`：唯一 `useChatLiveState` 完整订阅；App 删除 5 个 live useState/onChatEvent/旧 translation effect。
- 证据：
  - `chatLiveIsolation.test`：150 历史 + 6 memo sibling + 20 delta，parent/History/SiblingPanels 各 1 render，live child ≥20，最终 stream 20。
  - `chatViewIsolation.test`：真实 ChatView + 150 messages + 20 delta，`ChatViewProbe` 1 render，live 文本出现。
- **N1 low**：synthetic Harness 只证明 memo siblings，未挂真实 Dock/PrimaryRail/WorkflowRail/NeedsMe；代码上 App 根无 token setState，任务允许合成证据，故非阻塞；建议后续补真实宿主 render counter/Profiler。

### 3.2 tool/terminal/thinking/segment/历史回放/取消/错误/结束/翻译（PASS，N2 low）

- reducer：delta/reasoning/segment 稳定 id、tool_call/tool_result upsert、tool_result 缺 call 也保留、done/cancel/error clears live + terminal by userMessageId、workspace 过滤。
- store：immutable snapshot/subscribe/reset/clearLive 保 terminal/translation once success/error。
- 旧 `chatTurnUi` 9、`chatTurnTerminalService` 8、`chatLive.test` 7、`chatLiveStore.test` 4 全绿；UI 复用 ChatBubble/ChatTurnProcess/ChatReasoningBlock。
- **N2 low**：新测试未直接渲染 ChatLiveTail 的 tool/terminal/thinking/cancel/error 全 UI 序列；语义由 reducer/store + 旧组件测试覆盖。建议补集成 fixture。

### 3.3 长历史/6 面板/1440/960（PASS，N3 low）

- 150 历史 + 6 sibling fixture 通过；真实 ChatView 150 历史稳定。
- 本 PR 无 CSS/布局改动（changed files 9 个，无 styles.css）；1440/960 现有布局不受影响。
- **N3 low**：未新增 R1 专属截图；无布局变更，沿用既有截图 + 人工抽查。

### 3.4 范围/R2/R3/权限/gate/数据层/依赖（PASS）

- changed files：App.tsx、shared/chatLive.ts(.test)、shell/chat/{ChatLiveBridge,chatLiveStore,isolation tests}、docs/team/perf-r1-streaming.md；无 electron/kernel/git/memory/review/watchdog/styles。
- 未出现 RefreshCoordinator/renderPanel/Dock PanelHost 等 R2/R3 代码；R2/R3 未混入。
- 无权限/gate/任务状态机/数据层/schema/依赖变更；未引入 Monaco/虚拟列表/React Compiler/微前端。
- 生产只传 liveStore；legacy props 仅兼容旧 fixture（N4 low）。

### 3.5 三命令/回归（PASS）

- typecheck/build 0；plain 首轮仅既有 openai 5s timeout，单独复跑 740/740；extended 740/740。
- permission 44、approval 9/2、execution 43、review 17、git 56 全绿；无新回归。

---

## 4. 发现（非阻塞）

| ID | 级别 | 发现 | 建议 |
|----|------|------|------|
| N1 | low | 每 token 的 sibling/panel 证据是合成 memo，不是真实 Dock/PrimaryRail/WorkflowRail/NeedsMe | 补真实宿主 render counter/Profiler |
| N2 | low | 新测试未直接覆盖 ChatLiveTail tool/terminal/thinking/cancel/error UI 序列；reducer/store + 旧组件测试覆盖 | 补真实 ChatLiveTail 集成 fixture |
| N3 | low | 无 R1 专属 1440/960 截图；无 CSS 改动 | 人工抽查或补截图 |
| N4 | low | ChatView 保留 legacy stream/tools/reasoning/terminals props（仅 fixture） | 生产路径已只传 liveStore；后续可清理 |
| N5 | low | plain test 既有 openai 5s 并发 flake；单独复跑 740/740 | CI 单独超时/串行 |

---

## 5. 结论

**PASS（R1 合同）**：流式状态已隔离到 external store + ChatLiveTail；每 token 不触发 App/Dock/rail/Workflow/NeedsMe 的 React state 更新；长历史/多面板/tool/terminal/thinking/终态/翻译语义保持；未混入 R2/R3，无权限/gate/数据层/依赖变更；三命令最终 0/0/0，89/740。

N1/N2 为证据面增强项，不阻塞 PR #40 作为 R1 独立 PR 进入评审/合并；R2/R3 需按 t259 另行实现和验收。

*本次验证仅新增本报告，未修改生产代码。*
