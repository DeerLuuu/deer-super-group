# 复审：Router 推荐成员三入口（t279 / t278）

- **评审人**：ivy
- **基线**：`main 1287d9c`；PR #42 / `feature/t272-member-recommend` HEAD `8a0f20f`
- **范围**：t278 对 t274 F1/F2/F3/F4 的修复；三入口、schema/白名单/read_only、聘用、唯一入口、prompt 安全
- **方法**：静态代码 + 独立命令；未修改生产代码
- **结论**：**needs_revision**；1 high + 2 low。recentContext 的脱敏与错误码修复成立，但推荐 prompt 仍把未脱敏的 `OVERVIEW`、任务标题和描述原文发送到外部模型。

---

## 1. 独立验证

```text
pnpm typecheck  # exit 0
pnpm build      # exit 0（433 modules；css259.61 kB/gzip31.83；js1,290.85 kB/gzip356.89）
pnpm test       # plain 762/765（3 个既有 5s timeout：openai/watchdog×2）；t278 extended 96/765
```

- PR #42 OPEN/MERGEABLE；worktree clean；head 8a0f20f。
- 已确认 t278 修复：
  - `recentContext` 每条 `sanitizeErrorText(...,500)`，最多 8 条；测试覆盖 sk-live/Bearer/token/URL query/内部 URL。
  - 429→`RECOMMEND_RATE_LIMITED`、401→`RECOMMEND_AUTH_FAILED`、timeout/empty 有 service/UI 测试；不写 store、不自动创建。
  - 编辑已有成员无推荐 tabs/CTA；推荐/手动 permission read_only；CreateAgentInput 无 permission；service 夹带 full_access 仍 read_only。
  - 三入口/候选卡/确认/双击/编辑预填/重名/Router/失败保留继续成立；无第二数据源/gate 变更；1440/960 截图。

---

## 2. Findings

### F1 · 推荐 prompt 仍包含未脱敏的 OVERVIEW / 任务标题 / DESCRIPTION（high / P1）

**问题**：t278 只对 `recentContext` 脱敏。`buildMemberRecommendationUserPrompt` 仍然直接拼接：
```ts
`OVERVIEW: ${input.overview ?? ""}`,
...
`- ${task.title} [${task.status}] ...`,
...
input.mode === "description" ? `DESCRIPTION: ${input.description ?? ""}` : "",
```
`recommendMembers` 将 `workspace.overview`、`tasks.map(task.title)`、`input.description` 原样传入。工作区 overview 可能来自用户/README/模型摘要，任务标题和描述也可能含 API Key、Bearer、内部 URL、provider body；这些内容同样会发送到外部推荐 provider。t274 F1 的“prompt 不含 Key/baseUrl/env”并未完全成立，只是把最近聊天这一路补上了。

**证据**：
- `src/shared/memberRecommendation.ts` 的 `buildMemberRecommendationUserPrompt`：`OVERVIEW`、`TASKS`、`DESCRIPTION` 均无 sanitize；
- `src/kernel/service.ts` recommendMembers 传入 `overview`、`tasks.title`、`description`；
- `memberRecommendation.service.test.ts` 只测 recentContext 的 secret 脱敏，没有 overview/task/description 用例。

**影响**：用户把 key 写进工作区 overview 或任务标题时，点击 Router 推荐仍会外发；安全边界不完整。
**验收句**：**对 prompt 中所有自由文本（workspaceName/path、overview、member name/role/model label、task title/owner、description、recentContext）统一走 sanitize/cap；补 overview/task title/description 含 `sk-live`/Bearer/内部 URL 的 provider prompt 断言。**

### F2 · 测试未覆盖 overview/task/description 的脱敏（low / P3）

**问题**：即使 F1 修复，现有 service test 只从 recentContext 注入 secret；overview、task title、description 的泄露路径没有测试，后续改动无法守住。
**证据**：`memberRecommendation.service.test.ts` 第 109 行起只测 recentContext；`memberRecommendation.schema.test.ts` 只测 schema。
**验收句**：**增加三个独立用例：overview 含 sk-live、任务标题含 Authorization、description 含内部 URL，断言 provider 收到的完整 prompt 均不含原文。**

### F3 · createAgent 的唯一权限边界仍依赖类型/服务层，缺少 IPC 入口负向测试（low / P3）

**问题**：t278 已证明 store 夹带 `permission:"full_access"` 仍 read_only，但 `recommendMembers` / 手动 createAgent 的 IPC `CreateAgentInput` 入口没有“未知字段/permission 越权”拒绝断言；如果未来 IPC 层把 permission 透传，当前测试只守住 store 最终值，不守住边界。
**证据**：`createAgentInput.test.ts` 仅 TS `@ts-expect-error` 与运行时属性存在；service test 只测 store 结果；`electron/preload.ts`/`ipc.ts` 无拒绝 permission 的测试。
**验收句**：**补 IPC/service 负向测试：payload 带 permission 被拒绝或忽略且创建仍 read_only；CreateAgentInput 类型不允许 permission。**（不要求改 public API，只补 guard 断言。）

---

## 3. 验收映射

| 验收 | 结果 | 说明 |
|---|---|---|
| 三入口/编辑隔离/推荐卡 | passed | tabs/默认 tab/候选卡/编辑预填通过；t278 已补编辑无 tabs |
| schema/白名单/read_only 安全 | failed | schema/模型白名单/read_only 通过；F1 prompt 其他自由文本未脱敏 |
| 聘用确认/编辑/单次/冲突/失败 | passed | 两步确认、hiringRef、429/401/timeout/empty、writeThenRefresh 通过 |
| 唯一 createAgent/无第二数据源/gate 未改 | passed | recommendMembers 不写 store；无新表/批量/gate；F3 为 low 边界测试 |
| 三命令/aria/1440/960 | passed | typecheck/build 0；extended 765；tabs/aria/status/alert；960 截图；plain 3 个既有 5s timeout |
| verdict/findings | needs_revision | F1 high + F2/F3 low |

---

## 4. 结论

**needs_revision**。t278 对 F1 recentContext、429/401、编辑 tabs、createAgent read_only 的修复有效，主流程可继续；但推荐 prompt 的其他自由文本仍原样外发，F1 只是部分修复。建议统一 sanitize/cap 所有 prompt 自由文本并补 F2 的测试；F3 作为 low 边界补强。修复后可进入下一轮复审。
