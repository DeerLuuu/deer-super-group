# 历史对话轮次统一气泡 · 独立评审（t170）

- **对象**：PR #29 `feature/t168-chat-turn-history`，HEAD `a7a934e`（OPEN/MERGEABLE）；t169 验证报告
- **评审人**：aria（独立评审，未修改生产代码）
- **结论**：**needs_revision（不通过）**；2 个 blocker/high 级发现，其余为低优先。

## 1. 命令结果

在 `branches/t168-chat-turn-history` 复跑：

- `pnpm typecheck`：exit 0
- `pnpm build`：exit 0（406 modules；js 1,220.34 kB/gzip 334.14；css 243.95 kB；main 1.5 MB、preload 11.7 kB）
- `pnpm test`：exit 0（50 文件 / 550 用例；projection 10、service 3、memo 4）

worktree clean；PR #29 OPEN/MERGEABLE；未直接改 main。PR 只涉及 t168 chat turn 相关文件，无无关重构。

## 2. Blocking findings

### F1（high）`getChatTurns` 并非只读：缺失 Router 时会创建 agent

`src/kernel/service.ts:710` 无条件调用 `ensureRouter(workspaceId)`；`ensureRouter` 在没有 Router 时执行 `store.createAgent(...)`。因此一次“只读”历史查询可能写入 `agents` 表，违反设计 §7.1/AC-08 的只读投影保证（即使 `agentId` 已显式传入也会发生）。t169 未覆盖“无 Router workspace”用例。

**Required fix**：`getChatTurns` 用 `listAgents(workspaceId).find(isRouter)` 或 `getAgent` 读取，不创建；无 Router 时返回稳定错误/空页。新增测试：无 Router workspace 调用后 agents 数量不变。

### F2（high）512 KB 响应上限未真正执行；截断后分页游标会跳过被裁轮次

`src/kernel/chatTurnProjection.ts:414-458`：

- 单轮分支只裁 step/tool value/arguments，**未裁 `userMessage.content`、未裁 reasoning 段数量/总量**；一个 user 消息或大量 reasoning/tool 段仍可让响应超过 `CHAT_TURNS_RESPONSE_MAX`（512 KiB），与 AC-04“HTTP/IPC 不返回超限”不符。
- `nextBefore` 在 `turns = turns.slice(-limit)` 后、响应容量裁掉更早整轮**之前**计算；若响应超限删除了更早 turn，返回的 `nextBefore` 指向已删除的 turn，下一次 `before` 会跳过这些 turn，历史无法完整回放。
- `chatTurnProjection.test.ts` 没有 `CHAT_TURNS_RESPONSE_MAX` 用例；t169 报告称“响应大小/文本截断有测试”，实际只有 content/reasoning/tool 字段截断测试。

**Required fix**：在裁剪后重算 `nextBefore`（指向当前返回的最早 turn）；对 user content、reasoning 总量和工具数量/负载做硬上限并置 `truncated`；补充 >512 KiB 单轮及“截断后继续 before 不丢轮次”测试。

## 3. 低优先发现

- **L1**：`chatTranslationMemo.clear()` 只清 Map，不使在途请求失效；旧 workspace 的请求 resolve 后仍会 `remember` 回 cache（`src/kernel/chatTranslationMemo.ts:53`）。建议 generation token；翻译设置变更也应清 cache（设计 §5.4），当前仅 workspace 切换清。
- **L2**：历史 `ChatTurnHistoryReasoning` 默认 `open=true`（`src/App.tsx:5111`）；展开 step 即翻译该 step 全部 reasoning，而非严格“思考块展开才翻译”。与 t169 V4 一致，需按产品口径改为默认折叠或明确 step 级懒翻译。
- **L3**：没有 `ChatTurnHistory.test.tsx`/App DOM 测试；历史气泡、done 后 live 去重、懒翻译次数仅有代码+截图+单测证据（t169 V1）。设计 §6 曾列出该 UI 测试文件。
- **L4**：跨 workspace 拒绝只有代码，没有显式另一 workspace agent 请求测试（t169 V2）；建议补。

## 4. 通过项

- 投影分组/多 assistant/step 升序/callId 配对/孤立 result synthetic/旧 step0/message.reasoning 降级/去重：项目测试 10 项通过。
- `chat:turns` IPC、默认 20/最大 40 turns、200 messages、2000 events、字段截断、`before`/`hasMore`、不进 snapshot：代码与 3 项 service 测试成立（F2 的响应总量/游标边界除外）。
- UI 历史同泡、history process 默认折叠、工具中文名、live/history 分离、懒翻译缓存/失败保留原文：代码 + t168 截图 + memo 4 项测试成立。
- 无 schema 变更、无无关重构；typecheck/build/test 全绿。

## 5. 建议（t170）

先修 F1/F2（含测试），再补 L1/L2 口径与 L3/L4 测试；PR #29 暂不合并。

---

## 6. t173 复审（t172 repair-round-2）

- **对象**：PR #29 HEAD `1bac577`（OPEN/MERGEABLE；worktree clean）
- **结论**：**PASS**（t170 F1/F2 已修复，无 blocker）
- **命令**：typecheck 0；build 0（406 modules；js 1,220.64 kB/gzip 334.23；css 243.95 kB；main 1.5 MB/preload 11.7 kB）；test 0（51 files / 560 tests）
- **t170 F1 已修**：`getChatTurns` 不再 `ensureRouter`；无 Router 稳定抛 `router not found`，不创建 agent；补 agents 数量不变与跨 workspace 测试。
- **t170 F2 已修**：用户内容/思考总量、单轮总 content/reasoning、工具数上限；响应裁剪后重算 `nextBefore`/`hasMore`；补 >512 KiB 单轮及 before 不丢轮次测试。
- **t170 L1–L3 已处理**：memo generation、设置指纹/关闭设置页 clear、历史 process/step/思考默认 closed、`chatTurnUi` 3 项 UI 交互测试。
- **残余低优先（不阻塞）**：
  - `chatTranslationMemo.prime` 未带 generation（仅旧 live 翻译 promise 可能在 clear 后回填）；
  - `capTurnBudget` 在 `turns.slice(-limit)` 之前对 allTurns 执行，未返回的旧轮截断可能让页面 `truncated=true`（保守标记）；
  - UI 测试为 react-test-renderer，无完整 App DOM e2e。

**复审判定**：F1/F2 代码、测试与验证报告一致，PR #29 可进入集成/合并流程。
