# 工具访问策略（t171）

## 目标

工具能否调用由**上下文策略 + 权限/审批**决定，而不是由成员角色决定。

- Router 与 worker 使用同一个 `ToolRegistry`；
- 所有工具调用经过 `ToolRegistry.execute` 的 permission/审批门禁；
- 角色不再决定「有没有工具」；
- Router 对话也能调用工具，权限默认沿用 Router 的 permission mode。

## 策略

```ts
type ToolPolicy = { mode: "chat" | "task"; taskId?: string | null }
```

- `chat`：没有任务投影，`task.complete` 不可用；其余工具按 permission/审批。
- `task`：完整工具集；`task.complete` 仅在有 taskId 时可用。
- `read_only / workspace_write / full_access / auto_risk` 的执行门禁仍在 `tools.ts` 的 `policyCheck` + 审批链，不因角色改变。

## 实现

- `src/kernel/tools.ts`
  - `ToolPolicy`、`toolAllowedByPolicy`；
  - `ToolRegistry.list(policy)` 过滤 schema；
  - `ToolRegistry.execute(..., policy)` 对不可用工具返回明确错误。
- `src/kernel/loop.ts`
  - `initialMessages`、`onTextDelta`、`onReasoningDelta`、`toolPolicy`；
  - 执行工具时传 policy。
- `src/kernel/service.ts`
  - Router `sendChat` 构建与 worker 相同的 registry/toolContext；
  - chat 使用 `mode:"chat"`，Router permission 作为执行权限；
  - system 摘要并入 system prompt；
  - `getContext` 工具列表使用 chat policy。
- Router 系统提示改为「工具由权限/工作区策略决定，不按角色」。

## 测试

- `src/kernel/toolPolicy.test.ts`：
  - chat 排除 task.complete；
  - task 有 taskId 才允许 task.complete；
  - schema 过滤 + 不可用工具执行拒绝。
- 全量 typecheck/build/test。

## Provider wire names（t172）

OpenAI-compatible provider 只接受 `^[a-zA-Z0-9_-]+$` 的 function name。
内部工具名保留点号（如 `fs.read`），发送前编码为 `fs__read`；模型返回的
tool call 名称在 `collectStream` 中解码回内部名再执行。

- `toWireMessage` 与 tools schema 使用 `encodeToolName`；
- tool call 解析后使用 `decodeToolName`；
- 覆盖测试断言所有内置工具编码后符合 provider pattern。

## 边界

- `task.complete` 仍只适用于任务上下文，这是上下文约束，不是角色约束。
- Chat 工具调用结果只回给模型；UI 目前只展示最终回复，不展示每个工具卡片。
- 审批仍由 `auto_risk` 人类回执链执行。
