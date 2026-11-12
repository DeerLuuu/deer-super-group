# G7 对话面板成员切换 · 最终集成验收（t427）

- **任务**：t427 — 集成验收 G7，最终集成 t423 设计 + t424 实现 + t425 验证 + t426 评审
- **实现**：PR #61 / `feature/t424-chat-agent-switch` @ `c93b8fb`（已同步 main `1f91d52`）
- **验证**：t425 独立验证 **PASS**（`docs/team/chat-agent-switch-verification.md`）
- **评审**：t426 评审 **PASS**（`docs/team/chat-agent-switch-review.md`）
- **PR**：[#61](https://github.com/DeerLuuu/deer-super-group/pull/61) — **MERGED（squash）**
- **合并提交**：`29ca7f7`
- **实现文档**：`docs/team/chat-agent-switch.md`
- **结论**：**PASS，已合并**；t424 worktree/branch 已清理，当前 main + 其他任务 t432 worktree。

## 1. 结论

G7 已完成最终集成验收：

- **切换查看/继续**：AgentSwitcher（combobox/listbox）Router 置顶、成员列表；切换后标题/placeholder/权限/模型/FT/消息/轮次/轨迹/上下文/提问/draft/busy/FT/liveStore 全部按 agent 隔离；切换不 abort 后台流。
- **发送归属**：`sendChat(ws, agentId, content)`/`cancelChat(ws, agentId)` 显式 agentId；service 校验 workspace、abort key `ws:agentId`；回复/事件/消息/terminal 全写 agentId；Router 对话不串成员消息。
- **Router-only 边界**：成员使用 `buildAgentSystemPrompt`，不注入 Router prompt/INTERACTIVE_PROMPT_V1/画布/提问 ingest；成员 `/clear`、`/compact`、`/team` 禁用并说明，发送入口拦截；clear/compact 只动 Router。
- **入口/深链**：Team 成员卡「对话」可打开；`#/chat?agent=` 深链，无效 agent 回退 Router；既有 `#/chat`、Command Palette、Dock 布局保持。
- **响应式/aria**：1440/960/480 真实 Electron 截图；AgentSwitcher 键盘/Esc/aria；480 无横向；成员空态/开始对话。
- **范围**：无 schema/新 IPC 创建通道/权限/gate/依赖变更；发送/取消 IPC 仅增加显式 agentId 参数（既有通道），无数据层变更。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| Router/成员切换 | AgentSwitcher + App selectedChatAgent | t424 截图/测试；t425/t426 |
| per-agent 消息/轮次/轨迹/上下文/提问/draft/busy/FT/live | App/chatLiveStore/ChatLiveBridge | chatAgentSwitchApp/AgentSwitcher/ChatLiveBridge 测试；t425 |
| 发送归属 agentId | service.sendChat/cancelChat + IPC/preload/main | chatAgentService.test；t425/t426 |
| abort 隔离 | abort key `ws:agentId` | service 测试；t425 |
| Router-only prompt/ingest | chatAgentPrompt + service 分支 | chatAgentPrompt.test；t425 |
| 成员命令禁用 | `/clear` `/compact` `/team` 拦截 | AgentSwitcher/App 测试；t425 |
| Team 入口/深链 | Team 对话框/`#chat?agent=` 无效回退 | t424 截图；t425 |
| 三档/aria | 1440/960/480 截图 + combobox/listbox | t424 截图；t426 |
| 无 schema/权限/gate | diff 仅 App/service/IPC 参数/UI/tests/docs | PR diff；t426 |

## 3. 独立复跑（同步后 PR worktree `4b933a7`）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；457 modules
                 # index 334.50 kB / gzip 99.74
                 # TeamDashboard 46.43 kB / gzip 14.58
                 # CSS 135.39 kB / gzip 23.09
pnpm test -- --testTimeout=20000 --maxWorkers=1
                 # 143 files / 978 tests passed
```

> 默认并行有既有 openai/watchdog 5s timeout；serial 全绿。t426 的 143/977 为同步前基线；同步后新增 starmap 测试使总数为 978。

## 4. 三档与入口

- `docs/team/t424-chat-1440.png`：成员对话 + 切换器。
- `docs/team/t424-chat-960.png`：960 单列无横向。
- `docs/team/t424-chat-480.png`：480 成员对话，输入/权限/模型可见。
- `docs/team/t424-switch-1440.png`：Router/成员切换列表（Router 置顶）。
- Team 成员卡「对话」、`#/chat?agent=`、无效回退 Router 由测试/截图覆盖。

## 5. 合并/清理状态

| 项 | 状态 |
|---|---|
| PR #61 | MERGED（squash） |
| merge commit | `29ca7f7` |
| main | `29ca7f7`（+ 本报告提交） |
| 实现 worktree | 已移除 |
| 实现 branch | 已删除（local/remote） |
| 当前其他 worktree | `t432-git-resizable-workspace`（其他任务，未触碰） |
| 合并后三命令 | 分支 143/978；main 合并代码 |

## 6. 遗留（非阻塞）

1. **turns/trajectory/context 逐项断言**：per-agent 行为有 App 级测试/走查，但未对每个切片做独立空/错误截图（N1 medium）。
2. **service model/permission/FT 断言**：成员 prompt 分支与发送归属已测，模型/权限/FT 的 service 级断言较少（N2 low）。
3. **480 listbox/成员输出协议文本**：480 截图未打开切换器；成员输出协议边界以测试为主（N3 low）。
4. **per-agent scroll**：切回成员滚动位置 P1 未做（N4 low）。
5. **既有 5s flake**：非本 PR；CI 建议串行/提高慢测 timeout（N5 info）。

**最终结论：G7 PASS，PR #61 已 squash 合并到 main `29ca7f7`；Router/成员切换、发送归属、Router-only 边界、Team 入口/深链与三档/aria 均集成验证；无 schema/权限/gate/新 IPC 创建通道变更；遗留仅发布前可补的逐切片断言/滚动深度项。**
