# R1 流式隔离最终集成验收（t263）

- **任务**：t263 — 集成验收 P0-8：流式/面板/刷新隔离（R1）
- **实现链**：t259 设计 → t260 R1 实现 → t264 独立复验 → t262 review pass
- **PR**：[#40](https://github.com/DeerLuuu/deer-super-group/pull/40) — **MERGED（squash）**
- **合并提交**：`b82ca51`（2026-11-12）
- **实现文档**：`docs/team/perf-r1-streaming.md`；设计 `perf-isolation-design.md`
- **验证/评审**：`perf-r1-streaming-verification.md`、`perf-r1-streaming-verification-2.md`；t262 review pass
- **结论**：**PASS（R1 合同），可交付**；PR 已合并，t260 worktree/branch 已清理。

## 1. 结论

P0-8 的 **R1 流式隔离**已完成最终集成验收：

- **外部 live store**：新增 `ChatLiveStore`（external store + pure reducer）、`ChatLiveBridge`（effect-only 接收 `onChatEvent`，不 setState）、`ChatLiveTail`（唯一完整 live state 订阅者）。
- **App 隔离**：App 删除 `chatStream/chatReasoning/chatTools/chatReasoningSegments/liveTerminals` 五个 useState 与旧 `onChatEvent`/translation effect；ChatView 只通过 `useChatLiveTerminals` 订阅低频 terminal Map。
- **语义保留**：delta/reasoning/segment/tool_call/tool_result/done/cancel/error 全部保留；terminal 按 userMessageId；thinking 翻译每段一次，复用 historyTranslationMemo；tool/terminal/取消/错误语义不变。
- **基线**：150 历史消息 + 6 sibling panel + 20 token → parent/History/SiblingPanels 各 1 次 render，live child ≥20；真实 ChatView 150 messages + 20 token → ChatViewProbe 仍 1 次 render。
- **边界**：本 PR **只做 R1**；R2（renderPanel/context 重构）、R3（RefreshCoordinator/刷新去重）未混入；无权限/gate/数据层/CSS/布局改动。
- **兼容**：ChatView 保留可选 legacy props 仅给既有 fixture；生产只传 liveStore；live translation 仅在 ChatView 挂载时进行，历史仍懒加载；done/cancel/error 的 loadChat 仍由 sendChatText finally 负责。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| live 状态移出 App | `src/shell/chat/chatLiveStore.ts`；`App.tsx` 删除 5 个 useState | chatLiveStore 4 例；t264 §1 |
| 事件桥接不 setState | `src/shell/chat/ChatLiveBridge.tsx` effect-only | chatLiveStore/chatLive 测试；t264 |
| 唯一完整订阅者 | `ChatLiveTail`（App 内） | chatLiveIsolation 1 例；t264 |
| token/tool/reasoning 语义 | `src/shared/chatLive.ts` pure reducer | chatLive 7 例；chatLiveStore 4 例 |
| terminal Map | `useChatLiveTerminals`；ChatView 只订阅 terminal | chatViewIsolation 1 例；t264 |
| 150 历史/6 panel/20 delta | `chatLiveIsolation.test.tsx` synthetic fixture | parent/History/SiblingPanels 各 1；live child ≥20 |
| 真实 ChatView 150+20 | `chatViewIsolation.test.tsx` | ChatViewProbe 1 render |
| thinking 翻译一次 | historyTranslationMemo 复用 | chatLive reducer tests；t264 |
| done/cancel/error | reducer/store + sendChatText finally | chatLive tests；旧 chatTurnUi/terminal 绿 |
| R2/R3 未混入 | diff 无 renderPanel/context/RefreshCoordinator | `git diff --name-only` 9 文件 |
| 无权限/gate/数据层/CSS | diff 无相关文件 | 89/740 回归；t262 review |

## 3. 独立验证（合并后 main）

工作目录：`S:\DeerSuperGroup`（main `b82ca51`；worktree 仅 main）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；430 modules
                 # js 1,277.06 kB / gzip 353.00
                 # css 258.43 kB / gzip 31.64
                 # electron main 1.5 MB / preload 11.9 KB
pnpm test        # exit 0；89 files / 740 tests
```

> 说明：PR worktree 与合并后 main 本次均一次全量通过 89/740；此前轮次出现既有 openai 5s timeout，隔离/延长时间后全绿。该 flake 与本功能无因果关系，保留为 P1 测试稳定性项。

## 4. 长历史/6 面板/取消/错误/1440/960 证据

1. **synthetic fixture**：150 历史消息 + 6 sibling panel + 20 token delta；parent/History/SiblingPanels 各 1 次 render，live child ≥20。
2. **真实 ChatView**：150 messages + 20 token；ChatViewProbe 1 次 render，历史 Markdown 不随 token 重解析。
3. **状态语义**：delta/reasoning/segment/tool_call/tool_result/done/cancel/error 全 reducer 覆盖；terminal 按 userMessageId 保留；thinking 翻译每段一次。
4. **取消/错误**：旧 chatTurnUi/terminal service 测试全绿；done/cancel/error 的 loadChat 仍由 sendChatText finally 负责。
5. **1440/960**：本 PR 无 CSS/布局改动，沿用既有 1440/960 布局截图；rail/Workflow/NeedsMe/Dock 未改。
6. **R2/R3 边界**：diff 仅 App/shared/chatLive/shell/chat/tests/docs；无 renderPanel/context 重构、无 RefreshCoordinator。
7. **无回归**：primaryRail 10、WorkflowRail 3、narrowWindow 28、DockShell 4、deeplink 17、permission 44、approval 9/2、review 17 全绿。

## 5. 范围/兼容性检查

- PR #40 合并 12 文件：`src/App.tsx`、`src/shared/{chatLive,chatLive.test}`、`src/shell/chat/{ChatLiveBridge,chatLiveStore,chatLiveIsolation,chatLiveStore.test,chatViewIsolation}`、docs/实现文档。
- **无** `src/kernel/`、data store/事件、git/memory/review gate、权限/任务状态机改动；无 CSS/布局改动；无新依赖。
- `ChatView` legacy props 仅用于既有 fixture，生产只传 liveStore；历史翻译仍懒加载。
- 合并前 PR #40 OPEN/MERGEABLE/CLEAN，head `e4ea327`（含 t264/t262 报告）；合并后 main `b82ca51`；t260 worktree 已移除，branch 已删除。
- 当前 main 有 4 个与 t263 无关的未跟踪 docs（dock-max-groups、narrow-window 系列，属其他任务）；t263 未删除/修改它们。

## 6. 遗留项（P1/低优先，不阻塞）

1. **synthetic panel 未挂真实 Dock/rail/Workflow/NeedsMe**（t264 N1）：render isolation 由合成 sibling 验证，真实全 UI fixture 可后续补。
2. **ChatLiveTail 全 UI 集成 fixture 缺失**（N2）：App 内订阅路径有单测，缺完整 App DOM。
3. **无 R1 专属截图**（N3）：本 PR 无布局/CSS 改动，沿用既有截图；性能证据以 render count/测试为准。
4. **legacy props 仅 fixture**（N4）：生产不传，后续可删除兼容层。
5. **既有 openai/watchdog 5s flake**（N5）：建议统一提高慢测 timeout 或拆分 fake clock。
6. **R2/R3 后续**：面板 renderPanel/context 重构、RefreshCoordinator/刷新去重按 t259 另行排期，不在本 PR。

## 7. 合并/清理状态

| 项 | 状态 |
|----|------|
| PR #40 | MERGED（squash） |
| 实现 head / 文档 head | `983a528` / `e4ea327` |
| merge commit | `b82ca51` |
| main | `b82ca51`（+ 本报告提交） |
| t260 worktree | 已移除（`pnpm branch:remove t260-perf-isolation`） |
| t260 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 最终三命令 | typecheck 0 / build 0 / test 89 files/740 |

**最终结论：PASS（R1）；Chat live 状态外置、App/history/sibling 不再随 token 重渲染，状态/取消/错误语义保留；R2/R3 未混入。残余为 P1 测试/真机 fixture 项，不阻塞交付。**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
