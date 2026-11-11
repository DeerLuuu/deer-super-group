# 对话取消/失败终态与重试 · 独立验证报告（t176）

- **任务**：t176 [verification] 独立验证 t175 取消/失败终态持久化、刷新恢复与安全重试
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-11
- **被验证对象**：PR #30 `feature/t175-chat-turn-terminal`，HEAD `6d4d36a`（OPEN/MERGEABLE；worktree `branches/t175-chat-turn-terminal`，clean）；未合并，未修改生产代码。
- **验证方式**：t175 worktree 独立复跑三命令 + 读实现/测试 + 查看 `docs/team/t175-chat-terminal.png` + 逐项状态机核对。

---

## 1. 结论：**PASS（通过，无 blocker）**

取消/错误/工具中取消终态、userMessageId 绑定、一 turn 一终态幂等、getChatTurns 终态/旧数据/workspace、历史/实时终态气泡、composer-only 重试与刷新恢复均成立；三命令 0/0/0（52 文件/576）。发现 4 项低优先边界，见 §5。

---

## 2. 命令结果（t175 worktree HEAD `6d4d36a`）

| 命令 | 退出码 | 关键结果 |
|------|--------|----------|
| `pnpm typecheck` | **0** | `tsc --noEmit` 无错误 |
| `pnpm build` | **0** | 406 modules；js 1,223.51 kB (gzip 335.10)；css 245.15 kB (gzip 29.52)；electron main 1.5mb、preload 11.7kb；>500kB 既有警告 |
| `pnpm test` | **0** | **52 文件 / 576 用例**全部通过；terminal service 7、projection 15、turn service 6、UI 8 |

---

## 3. 逐项验证

### 3.1 终态写入与 turn 绑定（PASS）

`chatTurnTerminalService.test.ts` 7 项全部通过：

- `persists a cancelled terminal after user message on cancel`：真实 SSE 流挂起 → `cancelChat` → assistant 不创建、turn.status=cancelled、terminal `{status:cancelled,code:ABORTED,retryable:true}`；`chat.turn_cancelled` 事件带 `userMessageId` 且 `terminalPersisted:true`。
- `persists a sanitized error terminal when the provider fails`：`sendChat` 异常 → `chat.turn_error`、error summary 不含 `sk-secret`、无 assistant。
- `records stage=tool and toolName when cancelled during a tool call`：工具中取消 stage=tool/toolName。
- `does not write a terminal for a successful assistant reply`：success 不写终态。
- `writes at most one terminal per userMessageId even on a cancel/error race`：共享 idempotencyKey，只 1 条。
- `keeps terminal events append-only through clear/compact without resurrecting orphan bubbles`：clear/compact 后旧 terminal 保留、orphan user 不清出假泡。
- `keeps the old terminal when a retry starts a new user/assistant turn`：retry 新 userMessageId，旧 terminal 不覆盖。

实现核对：`sendChat` 捕获 userMessageId/stage/lastTool；服务端先写 events 再 emit；payload ≤2KiB、message ≤500、code ≤64、tool ≤120，服务端 + 投影双重脱敏；unknown/no assistant 不伪造。

### 3.2 getChatTurns 终态/旧数据/workspace（PASS）

- `chatTurnProjection.test.ts` 15 项：cancelled/error terminal 投影；complete assistant 优先于 conflicting terminal；invalid terminal bindings 忽略；user-only 旧数据无 terminal → `pending + legacyUnresolved`；旧 step0/seq、callId、synthetic 保持。
- `chatTurnService.test.ts` 6 项：typed page/agent 校验；**agent from another workspace 拒绝**；分页/cursor；2000 process 事件窗口外的 terminal 独立 500 查询；terminal `userMessageId` 绑定；response trimming 后 `before` 仍能取回被裁旧 turn。
- 代码：`getChatTurns` workspace 必须存在、agent 同 workspace；messages/events/terminal 均 workspace 过滤；terminal 查询独立，不依赖 2000 process 窗口；`complete > terminal > pending`。

### 3.3 UI 终态气泡与重试（PASS）

`chatTurnUi.test.tsx` 8 项通过：

- `renders one historical terminal bubble, no assistant, and retry only calls prefill`：单终态泡、无 assistant、retry 只 prefill。
- `renders error alerts with sanitized summary, disables retry while busy, and dedupes live terminal`：错误 role=alert、脱敏、busy 禁用、live/durable 去重。
- `retry prefill never overwrites a different draft and never sends`：不覆盖草稿、不自动发送。
- `shows a live terminal before the durable turn page arrives`：先 live terminal，页面到位后不重复。
- `shows a legacy pending bubble for user-only old data without a terminal`：旧数据 pending 文案。
- 另有 process/step/thinking 懒翻译、失败回退、live tools 不挂历史泡等回归。

实现核对：历史/实时单终态气泡；取消 `role=status`、错误 `role=alert`；terminal 优先 live；retry 只 `setChatInput`+focus，不调用 `sendChat`/不创建消息；`clear/compact` 后不复活 orphan。

### 3.4 clear/compact、retry 成功、取消后重发、幂等（PASS）

- clear/compact：terminal 只追加、旧 terminal 保留；orphan user 不复活。
- retry 成功：新 userMessageId/新 assistant，旧 terminal 保留可查。
- 取消后重发：新 user message + 新 terminal，不重复旧 user。
- 并发/重复事件：共享 idempotencyKey，一个 userMessageId 最多一个 terminal；cancel/error race 测试只 1 条。
- 跨 workspace：service 显式拒绝另一 workspace agent；terminal/messages/events 均 workspace 过滤。

---

## 4. 回归

- t175 改动：`src/kernel/chatTurnProjection.ts`、`service.ts`/`store.ts`、shared/types、App/styles、tests/docs；未改 kernel 状态机/permissions/approval 语义。
- 52/576 全绿：Git 56、Review 29、Watchdog 23、Poll、Memory、Kernel 43、Canvas、Markdown、Deeplink、Permission/Approval；无回归。
- PR #30 单 feature 分支，worktree clean，未直接改 main。

---

## 5. 低优先发现（非阻塞）

| ID | 级别 | 发现 | 建议 |
|----|------|------|------|
| V1 | low | 终态事件为 zero-schema `chat.turn_cancelled/error`，不进入 t68 eventRegistry/`getTaskTrace`（设计有意）；事件重放/轨迹面板看不到终态类型 | P1 如接入 eventRegistry，需补 schema/版本；当前不影响 turn 投影 |
| V2 | low | terminal 独立查询上限 500 条；极长历史可能漏掉更老终态（P1 已声明） | 后续按需分页/加索引 |
| V3 | low | 无 retry relation 事件（P1 已声明）；只能靠新 turn 推断 | P1 可加 `chat.turn_retried` 或 relation 字段 |
| V4 | low | UI 验证为 `chatTurnUi` 组件级，非完整 App DOM/真实 Electron；无 Electron 截图 | 发布前补真机冒烟；组件测试已覆盖关键状态 |

工具/审批/权限语义未改，符合 t175 P1 边界；无安全发现（错误摘要脱敏测试通过）。

---

## 6. 结论

**PASS**：取消/异常/工具中取消终态写入与 userMessageId 绑定、getChatTurns 终态/旧数据/workspace、历史/实时单终态泡、composer-only 重试与刷新恢复均成立；三命令 0/0/0，52/576 全绿。PR #30 可进入后续评审/集成；V1–V4 为低优先边界。

*本次验证仅新增本报告，未修改生产代码。*
