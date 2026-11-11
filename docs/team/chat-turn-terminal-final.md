# 对话取消/失败终态与重试最终集成验收（t178）

- **任务**：t178 — 集成验收：对话取消/失败终态与重试
- **需求设计**：`docs/team/chat-turn-terminal-design.md`（t174，596 行）
- **实现**：`docs/team/chat-turn-terminal.md`（t175）
- **独立验证**：`docs/team/chat-turn-terminal-verification.md`（t176，PASS）
- **独立评审**：t177 评审 r1，结论 **pass**（无 blocker/findings）
- **PR**：[#30](https://github.com/DeerLuuu/deer-super-group/pull/30) — **MERGED（squash）**
- **合并提交**：`f3737d9`（2026-11-11）
- **结论**：**PASS，可交付**；PR 已合并，t175 worktree/branch 已清理。

## 1. 结论

取消/失败轮次终态与安全重试已完成最终集成验收：

- `sendChat` 在 user 消息落库后捕获 `userMessageId`，取消/失败先写持久化事件再 emit；不伪造 assistant。
- 复用 `events` 表新增 `chat.turn_cancelled` / `chat.turn_error`（零 schema），`turnId=turn:<userMessageId>`、共享 `idempotencyKey`，一个 turn 最多一个终态；取消/错误竞态只 1 条。
- `getChatTurns` 状态优先级 `complete > terminal > pending`；无 assistant 且无 terminal 的旧数据为 `pending + legacyUnresolved`，不再静默 error；terminal 独立 500 条查询，不受 2000 process 事件窗口影响。
- 历史/实时 UI 单终态气泡：取消 `role=status`、错误 `role=alert`；错误摘要脱敏；无 assistant 不伪造；terminal 优先 live，刷新后仍可见。
- 重试只预填 composer + focus，不自动发送、不自动建消息/事件、不覆盖已有草稿、双击不重复、busy 禁用；retry 后旧 terminal 保留。
- clear/compact 后已删除消息的 terminal 只成为 orphan，不复活气泡；运行中仍拒绝清空/压缩。
- 未改权限、审批、内核调度、工具行为；旧数据降级可接受。

## 2. 需求→实现→验证追溯

| 需求/AC（设计 §11） | 实现落点 | 验证证据 |
|--------------------|----------|----------|
| AC-01 user 落库后捕获 userMessageId；取消/失败不创建 assistant | `src/kernel/service.ts` sendChat catch/finally、`src/shared/types.ts` ChatEvent additive | terminal-service 7 项：cancel/error 无 assistant；success 不写 |
| AC-02 新增 cancelled/error 事件与 payload | `service.ts` persistTerminal；payload userMessageId/turnId/agentId/status/stage/code/message/retryable/step/tool/at | terminal-service tests；projection 15 项 |
| AC-03 共享 idempotencyKey；一 userMessageId 一终态；竞态不重复 | `persistTerminal` 共用 key | `writes at most one terminal per userMessageId even on cancel/error race` |
| AC-04 零 schema（复用 events） | 无 schema/migration diff | `git diff` 检查；impl §2 |
| AC-05 按 userMessageId 绑定；不匹配消息/agent/workspace 忽略 | `chatTurnProjection.ts` terminal 匹配 | terminal-service workspace/agent 边界；projection invalid terminal |
| AC-06 `terminal/retryable/legacyUnresolved`；旧 user-only pending | `getChatTurns` + projection DTO | service 8 项：terminal/legacy/pending；projection |
| AC-07 刷新后状态泡、脱敏错误摘要、stage/tool | `ChatTurnTerminalBubble` + App | chatTurnUi 8 项；t176 §4 |
| AC-08 旧数据不猜测；无 assistant 不丢弃；旧空 assistant 仍 error | projection 状态优先级/legacy | projection 15 项 |
| AC-09 工具/审批中取消 stage 与 toolName 正确；不伪造结果 | sendChat activeTools/lastTool；stage | `records stage=tool and toolName when cancelled during a tool call` |
| AC-10 历史/实时单终态泡；live 被历史接管 | App terminal 去重 | chatTurnUi：one historical terminal / dedupe live terminal |
| AC-11 重试只预填 + focus，不自动发送/建消息 | App retry handler | chatTurnUi：retry only calls prefill；terminal-service no new messages |
| AC-12 composer 非空不覆盖 | App prefill guard | chatTurnUi prefill 断言 |
| AC-13 双击/连续操作不重复；busy 禁用 | retry busy/once | chatTurnUi disabled + prefill once |
| AC-14 重试新 turn；旧 terminal 保留 | service append-only | `keeps the old terminal when a retry starts a new user/assistant turn` |
| AC-15 clear/compact orphan 不复活；运行中拒绝 | store/service projection orphan filter | `keeps terminal events append-only through clear/compact...` |
| AC-16 terminal 读取独立于 2000 窗口 | store `listTerminalEvents` 500 | `reads terminal events outside the 2000 process window` |
| AC-17 摘要脱敏，无 stack/provider body/tool args | service sanitize + projection sanitize | terminal-service sanitized error；chatTurnUi alert summary |
| AC-18 512 KiB/nextBefore 不回归 | projection caps/trim | projection 15 项 caps/nextBefore |
| AC-19 跨 workspace/agent 拒绝/隔离 | service/store filters | service `rejects an agent from another workspace` |
| AC-20 测试 T-01..T-31；三命令全绿 | 52 文件/576 | 本报告 §3；t176/t177 |

## 3. 独立验证（合并后 main）

工作目录：`S:\DeerSuperGroup`（main `f3737d9`，worktree 仅 main，clean）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；406 modules
                 # js 1,223.51 kB / gzip 335.10
                 # css 245.15 kB / gzip 29.52
                 # electron main 1.5 MB / preload 11.7 KB
pnpm test        # exit 0；52 files / 576 tests
```

> 先移除已合并的 `t175-chat-turn-terminal` worktree，再在干净 main 复跑；避免 Vitest 从 `branches/` 重复收集测试。

## 4. 刷新/终态/重试验收证据

1. **终态写入**：`chatTurnTerminalService.test.ts` 7 项覆盖取消/提供方失败/工具中取消/成功不写/竞态单条/clear compact 追加/retry 旧终态保留。
2. **投影**：`chatTurnProjection.test.ts` 15 项覆盖 terminal 绑定、状态优先级、旧 user-only pending、invalid terminal、512KiB 裁剪与 nextBefore。
3. **服务**：`chatTurnService.test.ts` 8 项覆盖 typed page、分页、cursor、Router、跨 workspace、terminal 独立 500 查询。
4. **UI**：`chatTurnUi.test.tsx` 8 项覆盖单终态泡、取消 status/错误 alert、脱敏摘要、retry prefill+focus/不自动发送/不覆盖草稿/busy 禁用、live 去重、旧数据 pending。
5. **证据文档/截图**：`chat-turn-terminal-verification.md`（t176 PASS）、`t175-chat-terminal.png`、t177 review pass。
6. **限制**：无头环境未启动真实 Electron 做人工刷新；证据为组件测试 + 截图 + t176 独立验证，非完整 App DOM E2E（P1）。

## 5. 范围/兼容性检查

- PR #30 变更 14 文件（含 t176 verification 文档）：`src/App.tsx`、`src/kernel/{chatTurnProjection,service,store}.ts`、`src/shared/types.ts`、`src/styles.css`、docs/截图；无 `src/kernel/permission*`/`approval*`/`execution/`/scheduler/tool policy 改动。
- 零 schema：复用 `events` 表；无 migration/新表/新列；`getChatTurns` DTO additive。
- 旧数据：无 terminal 不猜测；user-only 为 pending + `legacyUnresolved`；旧空 assistant 仍 error；测试覆盖。
- 合并前 PR #30 OPEN/MERGEABLE，head `42d29a0`（含 t176 验证文档）；合并后 main `f3737d9`；t175 worktree 已移除，branch 已删除。
- 未直接修改 main 代码；合并通过 GitHub squash merge。

## 6. 遗留项（P1，不阻塞）

1. terminal 独立读取 500 条窗口；超出后更早终态可能不可见（P1）。
2. 无 retry relation 事件（P1，旧 terminal 保留且新 turn 独立）。
3. zero-schema 终态事件不进入 t68 eventRegistry/getTaskTrace（设计有意）。
4. 无完整 App DOM / 真实 Electron 刷新 E2E；发布前建议真机冒烟。
5. 错误摘要脱敏覆盖 key/token/Authorization/URL 参数；若后续新增 provider 错误形态需扩展。
6. 工具/审批/权限语义未改；工具中取消只记录 stage/toolName，不改变执行器语义。

## 7. 合并/清理状态

| 项 | 状态 |
|----|------|
| PR #30 | MERGED（squash） |
| 实现 head / docs head | `6d4d36a` / `42d29a0` |
| merge commit | `f3737d9` |
| main | `f3737d9`，工作树 clean |
| t175 worktree | 已移除（`pnpm branch:remove t175-chat-turn-terminal`） |
| t175 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 最终三命令 | typecheck 0 / build 0 / test 52 files/576 |

**最终结论：PASS；取消/失败终态持久化、刷新恢复与安全重试已完成集成。残余均为 P1 边界，不阻塞交付。**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
