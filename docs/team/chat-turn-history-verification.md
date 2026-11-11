# 历史对话统一气泡验证报告（t172 repair-round-2）

- **任务**：t172 — repair-round-2（父任务 t168 / PR #29）
- **实现分支**：`feature/t168-chat-turn-history`
- **设计**：`docs/team/chat-turn-history-design.md`（t167）
- **实现说明**：`docs/team/chat-turn-history.md`
- **验证日期**：2026-11-11
- **最终基线**：`pnpm typecheck` 0、`pnpm build` 0（406 modules）、`pnpm test` 0（51 files / 560 tests）

---

## 1. 本轮修复的问题

| 轮次发现 | 修复 |
|---|---|
| `getChatTurns` 默认用 `ensureRouter`，无 Router 会创建 | 改用 `store.listAgents (isRouter)` / `getAgent`；无 Router 抛稳定 `router not found in workspace: <id>`，不创建；agent 不属于 workspace 抛 `agent not found in workspace` |
| 响应裁剪后 `nextBefore` 仍指向裁剪前首轮 | **先裁剪、后重算**；`hasMore` 覆盖响应裁剪；`before` 从当前最早返回 turn 继续，不丢被响应裁剪的旧轮 |
| 没有用户内容/思考总量、工具数量硬上限 | 新增单轮预算：用户 content 64KiB、用户 reasoning 8KiB、单轮总 content 128KiB、总 reasoning 64KiB、工具数 100；超限置 `turn.truncated` + `page.truncated` |
| “字段截断”和“响应总量上限”混在一起 | 本报告 §2/§3 分开；测试分别断言 |
| 翻译 memo `clear()` 后旧 pending 仍回写缓存 | generation token：`clear()` 递增；旧请求 resolve 只返回值，不回填/不删除新 pending；设置指纹变化与关闭设置页时清缓存 |
| 历史 step 展开即自动翻译 | 历史 process/step/思考全部默认 closed；展开 step 不翻译，展开「思考」才请求 |
| 缺 App 级折叠/live 去重/翻译测试 | 新增 `chatTurnUi.test.tsx`：折叠、step 展开不翻译、思考展开一次、失败降级、live 不挂历史气泡 |

## 2. 字段截断（field caps）

单轮预算在投影阶段执行；任何字段裁剪都置 `turn.truncated=true` 且 `page.truncated=true`：

| 字段 | 上限 | 行为 |
|---|---|---|
| user content | 64 KiB | 截断 + `turn.truncated` |
| user reasoning | 8,000 字符 | 截断 + `turn.truncated` |
| assistant content | 64 KiB | 截断 + `assistant.truncated`/`turn.truncated` |
| assistant reasoning 单段 | 8,000 字符 | `truncated` 标记 |
| 单轮总 content（user+assistants） | 128 KiB | 按顺序扣减，后续 assistant 截断 |
| 单轮总 reasoning | 64 KiB | 按 step 扣减 |
| 单轮工具数 | 100 | 保留前 100 个，其余移除并置 truncated |
| tool arguments/value | 4,000 字符（value JSON） | `tool.truncated` |

覆盖测试：`chatTurnProjection.test.ts`
- `caps user content/reasoning totals and tool count with truncated`
- `caps reasoning, tool payloads and assistant content with truncation flags`

## 3. 响应总量上限（response cap）

- 预算：**512 KiB**；估算包含 workspace/agent/turns/hasMore/nextBefore/truncated/version/generatedAt 元数据。
- 顺序：
  1. 先删更早的整轮，保留最新；
  2. 单轮仍超限：保留最近 3 个 step，清空 tool value、arguments 缩到 512 字符；
  3. 仍超限：删更早的 assistant；
  4. 每次裁剪 `truncated=true`。
- **nextBefore 在全部裁剪后重算**，指向当前最早返回 turn；`hasMore` 为 `hasEarlier || 响应裁掉了轮次`。
- 覆盖测试：
  - `keeps the full response under 512KiB for one oversized turn`：100 个大工具调用/结果，断言 `JSON.stringify(page) ≤ 512KiB`、`page.turns[0].truncated=true`。
  - `recomputes nextBefore after response trimming so before keeps older turns`：8 轮 × ~120KiB，断言 nextBefore 等于 `turns[0]` 且首位不是 q1。
  - `chatTurnService.test.ts` `keeps response trimming paginated: before returns the dropped older turns`：第一页响应裁剪后，`before=nextBefore` 的下一页包含被裁掉的 q1。
- 与字段截断区分：字段截断可能发生但响应仍 <512KiB；响应上限可能额外删除整轮/assistant，单独置 `truncated`。

## 4. 无 Router / 跨 workspace

- 无 Router workspace：`store.createWorkspace` 创建（不自动 ensureRouter），调用 `getChatTurns(ws)` 抛 `router not found in workspace`，调用前后 `listAgents(ws).length` 均为 0。
- 另一 workspace agent：`getChatTurns(ws1, router2.id)` 抛 `agent not found in workspace`。
- 测试：`chatTurnService.test.ts` 对应两例。

## 5. 翻译缓存 / generation token

- `chatTranslationMemo` 增加 generation：`clear()` 递增；clear 前发出的请求 resolve 后**不写缓存**，也不会删除 clear 后新请求的 pending。
- 设置变化：App 在 `translateHistoryText` 读取 `getTranslationSettings()` 指纹，变化时 clear；关闭设置页（可能改翻译）也 clear。
- 测试：`chatTranslationMemo.test.ts` 5 例，含 `ignores a pending request that resolves after clear`；服务端 `saveTranslationSettings` 仍会清 service 缓存。
- 历史翻译只在 `.chat-turn-reasoning-collapse` 的按钮打开时触发；step 展开不触发。

## 6. UI / live 去重

- 历史 process 默认 closed；step 默认 closed；工具默认 closed。
- `ChatTurnHistoryReasoning` 默认 `open=false`；按钮点击才请求翻译。
- `ChatView` 只对当前 live stream 渲染 live bubble；持久化 assistant 的 process 来自 `turnByAssistant`，不再附加 `chatTools`。
- 测试：`chatTurnUi.test.tsx`
  - 展开 process→step 不调用 translate；展开思考调用一次；关闭再展开仍只 1 次；译文显示。
  - 翻译失败保留原文并显示“机翻失败”。
  - 持久化 assistant + 残留 live tools（busy=false）只渲染 1 个历史 process，不出现“生成中”。
- 截图：`docs/team/t168-chat-history.png`（fixture Electron，刷新后同泡）。

## 7. 验证命令

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0
pnpm test        # exit 0

# 最终输出
406 modules transformed
dist/assets/index-BntbQ5aj.css   243.95 kB / gzip 29.33
dist/assets/index-DTqcc3AR.js  1,220.64 kB / gzip 334.23
dist-electron/main.cjs 1.5mb; preload.cjs 11.7kb
51 files / 560 tests passed
```

## 8. 遗留 / P1

- 事件无 schema 级 `turnId`，旧数据多 assistant 归属依赖时间窗口。
- 事件读取最近 2000 条；极端更早页只显示消息降级。
- 译文不持久化；翻译网络失败保留原文。
- 敏感值 redaction 独立立项；本期只做容量/响应上限。
- `cancelled` 无独立持久化事件，按 messages 降级。
