# 评审：Router 推荐成员三入口（t274 / t272）

- **评审人**：ivy
- **基线**：`main 1287d9c`；PR #42 / `feature/t272-member-recommend` HEAD `65d97b0`
- **范围**：Router 推荐 / 自己设定 / 描述生成；推荐 schema、服务端重校验、模型白名单、read_only、聘用确认/编辑/单次/冲突/失败；createAgent 唯一入口；1440/960/aria
- **方法**：静态代码 + 独立命令；未修改生产代码
- **结论**：**needs_revision**；1 blocker + 1 medium + 2 low。三入口、严格 schema、只读创建、显式聘用主路径成立，但推荐 prompt 把未脱敏的最近聊天上下文发给 LLM，存在把用户 Secret/工具错误原文外发的隐私风险。

---

## 1. 独立验证

```text
pnpm typecheck  # exit 0
pnpm build      # exit 0（433 modules；css259.61 kB/gzip31.83；js1,290.62 kB/gzip356.81）
pnpm test       # exit 0（extended；94 files / 757 tests）
```

- plain `pnpm test` 触发既有 openai/watchdog×2 5s timeout（753/757）；extended 757/757，非本 PR。
- PR #42 OPEN/MERGEABLE；worktree clean。
- 已确认：Modal 三 tabs；编辑已有成员不显示 tabs（代码分支，N1 未显式断言）；推荐卡 name/role/职责/reason/model/read_only/skills/risks；默认 A 仅真实非 mock 模型；A/C 禁用原因。
- 已确认：严格 schema 顶层 candidates、1–3、字段白名单、模型白名单、permission read_only、重名/Router 名整份拒绝；0 候选 EMPTY；mock/no-model/坏 JSON 明确错误；recommendMembers 不写 store。
- 已确认：聘用先展开确认，确认才 createAgent；编辑预填手动表单；hiringRef 单飞；失败保留输入；writeThenRefresh 成功关闭、刷新失败不重提。
- 已确认：新成员 store 固定 read_only；CreateAgentInput 无 permission；createAgent 唯一入口；无新表/批量 API/gate 变更；1440/960 截图。

---

## 2. Findings

### F1 · 最近聊天上下文未脱敏直接进入推荐 prompt（blocker / P0）

**问题**：`recommendMembers` 从 Store 读取 Router 最近 8 条消息：
```ts
const history = router
  ? this.store.listChatMessages(input.workspaceId, router.id, 8)
  : [];
...
recentContext: history
  .filter((message) => message.role !== "system")
  .map((message) => ({ role: message.role, content: message.content })),
```
这些 content 原样进入 `buildMemberRecommendationUserPrompt` 并发送给外部 provider。用户在 Chat 中粘贴的 API Key、Authorization、私有 URL、provider 错误 body、工具错误原文都会被带到推荐请求；system prompt 中“Never output API keys”只能约束模型输出，**不能阻止输入被发送**。设计明确要求 prompt 不传 Key/baseUrl/env，但 recentContext 没有经过任何脱敏/cap。

**证据**：
- `src/kernel/service.ts:515-535`（history 读取）与 `:540-575`（recentContext 映射进 prompt）；
- `src/shared/memberRecommendation.ts` 的 `buildMemberRecommendationUserPrompt` 接收 recentContext；
- `memberRecommendation.schema.test.ts` 只测 schema；service test 只测 mock 不伪造，无 secret recentContext 用例；t273 N2 已记录。

**影响**：隐私/凭据外发；属于 P0-6 同级的 secret-boundary 缺口；AC 的“prompt 不含 Key/baseUrl/env”不成立。
**验收句**：**推荐 prompt 的 recentContext 必须先经过共享脱敏（至少覆盖 sk/Bearer/Authorization/Cookie/token/secret/password/client_secret/accessToken/private_key、URL query、内部 URL、provider body）并 cap；用含 `sk-live`/Bearer 的最近消息测试 provider 收到的 prompt 不含原文。**

### F2 · 超时/429/401/EMPTY 没有直接服务或 UI 测试（medium / P2）

**问题**：t273 N3 指出 timeout/429/401/empty 没有直接测试。当前 makeRecommendation 的错误路径：
- 20s AbortController timeout → `RECOMMEND_TIMEOUT`；
- 429/401 provider 错误 → `RECOMMEND_FAILED`；
- parse 0 candidates → `RECOMMEND_EMPTY`；
均只有静态代码分支，没有 mock provider 的 429/401/timeout/EMPTY 断言；UI retry/fallback 也只在描述生成/坏 JSON 的测试里出现。失败状态可能回归而不被发现。

**证据**：`service.ts` recommendMembers abort/try/catch；`memberRecommendation.test.tsx` 5 个用例未覆盖 429/401/timeout/empty；t273 N3。
**验收句**：**补 mock provider 的 timeout/Abort、429、401、0 candidate 四类测试，断言 code/错误文案/不写 store/不自动创建，以及 UI 重试与手动 fallback。**

### F3 · 编辑成员 tab 隔离无显式断言（low / P3）

**问题**：`AgentDialog` 代码在 `agent !== null` 时隐藏三 tabs，但 N1 只由人工/代码分支保证，没有“编辑已有成员不显示 A/C tab、不显示推荐 CTA”的组件断言；未来改动可能把推荐入口混入编辑。

**证据**：`TeamDashboard.tsx` AgentDialog 的 `agent ?` 分支；`memberRecommendation.test.tsx` 只测新建 tabs。
**验收句**：**补编辑已有成员的组件断言：tabs 不渲染、推荐/描述生成 CTA 不存在、只保留手动表单。**

### F4 · createAgent permission 契约缺显式断言（low / P3）

**问题**：新成员权限由 store 固定 read_only，但 N5 指出没有 `createAgent` 权限断言/负向测试；若未来 CreateAgentInput 增加 permission 或 store 默认变化，推荐/手动创建可能提权而测试不会拦截。

**证据**：`CreateAgentInput` 无 permission；`store.createAgent` 固定 `permission:"read_only"`；memberRecommendation 测试未断言。
**验收句**：**补 createAgent 后 agent.permission === "read_only" 的断言（推荐与手动两条路径），以及 CreateAgentInput 不接受 permission 的类型/运行时 guard。**

---

## 3. 验收映射

| 验收 | 结果 | 说明 |
|---|---|---|
| 三入口/编辑隔离/推荐卡 | passed | tabs/默认 tab/候选卡/编辑预填代码与 UI 测试；F3 为 low 断言缺口 |
| schema/白名单/read_only 安全 | failed | schema/模型白名单/read_only 通过；F1 recentContext 未脱敏外发 |
| 聘用确认/编辑/单次/冲突/失败 | passed | 两步确认、hiringRef、name/Router、writeThenRefresh；F2 为错误路径测试缺口 |
| 唯一 createAgent/无第二数据源/gate 未改 | passed | recommendMembers 不写 store；CreateAgentInput 无 permission；无 schema/表/gate 变更 |
| 三命令/aria/1440/960 | passed | extended 94/757；tabs/aria/status/alert；960 截图；plain 5s flake |
| verdict/findings | needs_revision | F1 blocker + F2 medium + F3/F4 low |

---

## 4. 结论

**needs_revision**。三入口、严格 schema、read_only 创建和显式聘用是成立的，但 F1 把未脱敏的最近聊天上下文（可能含用户 Secret/工具错误）直接发到外部模型，属于 P0 级隐私边界缺口；必须先修 F1，并补 F2 的错误路径测试。F3/F4 为 low 断言补强，可在同一 repair 处理。
