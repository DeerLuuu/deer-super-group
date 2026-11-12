# 对话面板成员切换（G7 / t424）

## 范围

- Chat 顶部成员切换：Router + 非 Router 成员；标题、权限、模型、满血模式、placeholder、空态、assistant 名称随选中 agent。
- 成员会话独立加载 messages / turns / trajectory / context / questions；切换不 abort 后台流，草稿/忙态/live tail 按 agent 隔离。
- Team 成员卡「对话」入口 + `#/chat?agent=<agentId>` 深链；无效/已删除 agent 回退 Router 并清理 hash。
- Router-only：`/clear`、`/compact`、`/team`、从对话规划、提问/画布/交互协议；成员对话禁用并说明，不 ingest。
- 无 schema、无新 IPC 通道、无新依赖、不改权限/gate。

## 后端

- `AppService.sendChat(workspaceId, agentId, content)` / `cancelChat(workspaceId, agentId)`：显式 agent；不保留旧签名。
- abort key `${workspaceId}:${agentId}`；同 agent 单飞，不同 agent 可并行；`clear/compact/answerChatQuestion` 只检查 Router key。
- 选中 agent 的 `model`/`permission`/`fullThrottle` 生效；工具 registry 共用，`permission`/`runId`/`agentId` 来自该 agent。
- Router 分支保持 buildRouterSystemPrompt + compact summaries + recent canvases + INTERACTIVE_PROMPT_V1 + ingest。
- 成员分支使用 `buildAgentSystemPrompt(agent, workspace)`（身份/角色/systemPrompt/persona/agentsMd/权限规则），不注入 Router team/tasks、交互协议、画布/提问、压缩摘要；不调用 `ingestAssistantInteractive`。
- 事件 user/assistant/trajectory/terminal 全部写入选中 agent；`ChatEvent.agentId` 路由到 per-agent live store。

## 前端

- `AgentSwitcher`：combobox/listbox、Router 置顶、当前项 aria-selected、ArrowUp/Down/Home/End、Enter/Space、Esc 关闭回焦、外部点击关闭、`aria-activedescendant`；480 全宽 popover。
- App 状态：`chatAgentId` + `chatAgentIdRef`；`chatBusyByAgent`、`chatFullThrottleByAgent`、`chatDraftsRef`、`chatLiveStoresRef`；切换时保存当前 draft、清空旧视图、恢复新 draft，后台流继续写入原 store。
- `ChatLiveBridge` 接收 stores Map，按 `event.agentId` 分发；settle 只清对应 agent busy。
- 切换加载：messages/turns/context/questions 按 agent；member 不请求 questions；请求 seq + agent id 双重守卫，防止 A 慢响应覆盖 B。
- Team 成员行新增「对话」按钮（aria-label `打开 <name> 的对话`）。
- 成员 hash：`#/chat?agent=<id>`（可与 `task=` 共存）；Router 不写 agent 参数；无效 agent 回退并 `history.replaceState`。
- `/clear` `/compact` `/team` 在成员对话：header 按钮 disabled + title、composer 说明、命令菜单空态、发送拦截 toast；不会清空/压缩成员消息或调用推荐。
- 成员对话 settings：模型/权限/FT 控制条作用于选中 agent；`/team` 推荐入口隐藏/禁用。

## 测试

- `chatAgentService.test`：成员发送归属、事件/消息 agentId、无 questions/artifacts ingest；Router clear/compact 不清成员历史；无效 agent；abort key 隔离 + cancel。
- `chatAgentPrompt.test`：成员 prompt 含身份/指令，不含 INTERACTIVE_PROMPT_V1/deer-canvas/deer-question/Router 规划。
- `chatAgent.test`：Router fallback/options/abort key/Router-only 命令边界。
- `AgentSwitcher.test`：listbox/aria/keyboard/Esc。
- `ChatLiveBridge.test`：事件只分发到对应 agent store。
- `chatAgentSwitchApp.test`：`#/chat?agent=` 深链加载成员、发送到成员、切换 Router/成员、draft 按 agent 保留。
- `chatTurnUi.test`：成员标题/placeholder/disabled Router-only 控件/命令空态/切换回调。
- `TeamDashboard.edit.test`：成员卡「对话」入口。
- `deeplink.test`：agent 参数解析/构建。

## 截图（真实 Electron/CDP）

| 截图 | 尺寸 | 内容 |
|---|---|---|
| `docs/team/t424-chat-1440.png` | 1440×1000 | 成员对话 + 切换器 + Team「对话」入口 |
| `docs/team/t424-chat-960.png` | 960×1000 | 960 成员对话 |
| `docs/team/t424-chat-480.png` | 480×900 | 480 成员对话，无横向溢出 |
| `docs/team/t424-switch-1440.png` | 1440×1000 | 成员 listbox 展开 |

执行签名：2026-11-13 05:12 +08:00 / ren / Electron + CDP / workspace 按钮工厂（Router + 代码分析员）。

## 已知边界

- 草稿仅 session 内存；刷新丢失（设计明确，不写 localStorage）。
- 成员对话不提供提问/画布/规划，这是 Router-only 产品边界。
- 成员历史/终端按现有 DB 的 agent_id 查询；无 schema/迁移。
- 本轮未做 per-agent scroll 位置保持，切回默认最新（设计 P1）。
