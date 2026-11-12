# Router 推荐成员 / 手动设定 / 描述生成 · 需求与交互设计

- **状态**：需求设计，未写生产代码
- **任务**：t269
- **基线**：main `00bf167`（P0-7 已合入；P0-8 R1 已完成；R2 面板渲染隔离在独立分支）
- **范围**：Team 页「新建成员」Modal；复用现有 `Agent` / `createAgent` / Router LLM；不新增 agent 数据源
- **不做**：不改 Agent 数据表、权限/审批/gate 语义；不做批量招聘事务；不做成员市场/远程模板；不新增 Dock 面板

---

## 0. 结论先行（需要确认的默认）

1. **同一 Modal 三个入口**：`Router 推荐` / `自己设定` / `描述生成`；编辑已有成员时**不显示三个 tab**，仍用现有完整表单（避免把“编辑”变成推荐流）。
2. **推荐只读、绝不自动创建**：`recommendMembers` 只返回候选 DTO；`createAgent` 仍是唯一创建入口；用户必须点「聘用」→「确认聘用」或「编辑后聘用」→「创建成员」。
3. **一次只聘一个**：多候选人视为备选；P0 不做多选批量。批量会引入部分成功/重名/权限回滚和第二个事务 API，收益低、风险高。
4. **新成员实际权限永远 read_only**：候选的 permission 只作为展示/解释；`createAgent` 不接受 permission，store 默认 read_only；创建后可在现有编辑表单调整。Router 不能通过推荐直接提权。
5. **模型必须是已配置 `settings.models` 中的 profile**：候选的 `suggestedModelProfileId` 由服务端白名单校验；无模型或 `mock` 模式不生成候选（不伪造）。手动 tab 保留现有 createAgent 规则（显式模型必须在列表，空 = 默认模型），不新增行为限制。
6. **严格 JSON + 服务端重校验**：候选 1–3 个，`additionalProperties:false`；非法 JSON/超 schema 整体失败，不 fallback、不伪造候选。
7. **不泄漏**：prompt 不包含 provider Key/baseUrl、现有成员 systemPrompt/persona/AGENTS.md、环境变量；候选只显示允许字段；错误摘要沿用共享脱敏。
8. **R2 兼容**：三个 tab 都封装在现有 `AgentDialog` 内，TeamDashboard 只传 snapshot/busy/onCreate；R2 的 panel 渲染隔离不改变此边界，不新增 Dock/路由/事实源。

---

## 1. 现状盘点

### 1.1 当前新建成员 Modal（TeamDashboard）

`src/TeamDashboard.tsx`：

- `TeamDashboard` 内部 `dialog: {agent: Agent|null}|null`；`openAgentDialog(null)` 打开新建。
- `AgentDialog`（约 506 行）字段：
  - `name`、`role`（默认 `engineer`）、`model`（`snapshot.settings.models` 选择；空 = 默认模型）
  - `systemPrompt`（默认工程师提示）、`persona`、`agentsMd`
  - 编辑已有成员时才显示 `permission` select；新建时只显示 notice“新成员默认 read_only，创建后可在编辑中调整”。
- 提交：`onSubmit({name, role, model, systemPrompt, persona, agentsMd, permission})`；新建时 `TeamDashboard.submitAgent` 调 `onCreate(draft)` 后关闭 dialog。
- **当前没有推荐/描述生成**；Modal 是唯一入口；没有第二个 agent 状态源。

### 1.2 createAgent 链路

```text
TeamDashboard AgentDialog
  → onCreate(AgentDraft)
  → App.handleCreateAgent(input)   // 只传 name/role/model/systemPrompt/persona/agentsMd
  → IPC task?（实际 agent:create）
  → AppService.createAgent(input)
      ├─ 校验 name.trim() 非空
      ├─ 按 name 大小写不敏感查重 → “member already exists”
      ├─ model 存在时必须能在 settings.models 找到（id 或 modelId）→ 归一为 profile.id
      └─ store.createAgent({...})
          └─ permission 固定 "read_only"; isRouter=false; status=idle
  → App.refresh + toast「已创建成员」
```

要点：

- `CreateAgentInput` **没有 permission**；新成员权限只能 read_only；这是现有安全语义，设计不修改。
- `createAgent` **不是批量 API**；每次一个；重名由服务端拒绝。
- 没有 idempotency key；双击/重复提交需靠 UI 单飞 + 服务端重名拒绝。
- `handleCreateAgent` 当前 create 后 `refresh`；本设计复跑 P0-7 的 `writeThenRefresh` 语义：**创建成功即 committed，刷新失败不得让用户以为没建**。

### 1.3 Router / LLM 可复用入口

- Router 对话：`AppService.chat` 使用 `ensureRouter`、`resolveModelProfile(settings, router.model)`、`createLlmClientForModel`；`buildRouterSystemPrompt` 只含 workspace overview、成员 name/role、任务 title/status，不含成员 systemPrompt/Key。
- Planner：`AppService.plan` 已有 `ROUTER_PLANNER` 严格 JSON 模式（但会直接创建任务，不能复用其写操作）；本设计只复用 **LLM client/模型解析/严格 JSON 思路**，不复用写路径。
- 模型配置：`LlmSettings.models/providers/settings.mock`；`resolveModelProfile`；provider key 由 `resolveApiKey`/env 处理，**不进入推荐上下文**。
- 推荐入口应使用 **Router 当前有效模型**（与 Chat 一致；无 Router 时用 settings.model），而不是无约束地取任意 provider。

### 1.4 现状缺口

- 新建成员只能手填，用户不知道缺什么角色/模型；
- 没有团队缺口/任务上下文驱动的建议；
- 没有描述生成的严格 JSON schema/失败语义；
- 不能一键把候选带入完整表单；
- 权限/模型/重名/双击/刷新失败没有统一招聘语义；
- 不能把“推荐”误做成自动创建或第二套 agent 数据源。

---

## 2. 三入口设计

### 2.1 入口位置

- Team 页头「+ 新建成员」/成员空态「新建成员」/命令面板“新建成员”都打开同一个 `AgentDialog`（agent=null）。
- `AgentDialog` 标题 `新建成员`，下方 `role="tablist"`：
  - `Router 推荐`
  - `自己设定`
  - `描述生成`
- **默认 tab**：
  - 若 `settings.models.length>0 && !settings.mock` → `Router 推荐`；
  - 否则 → `自己设定`，A/C 显示不可用原因（无模型/Mock）。
- **编辑已有成员**：不渲染 tablist，直接显示现有完整表单；候选推荐不参与编辑。

### 2.2 A. Router 推荐（team-gap）

不自动在打开 Modal 时调用（避免每次打开都消耗 LLM）；A tab 显示：

```text
让 Router 根据当前工作区、任务缺口和现有团队推荐 1–3 位成员。
[让 Router 推荐]   （primary；无模型/Mock 时禁用并说明）
```

点击后 loading skeleton（最多 3 卡），成功渲染 1–3 张候选卡；失败/空/超时 inline。

候选卡字段：

| 字段 | 展示 | 来源/限制 |
|---|---|---|
| `name` | 名称 | LLM；服务端 trim/长度/唯一性校验 |
| `role` | 角色 | LLM；与已有 role 相同只 warning |
| `responsibilities` | 职责 | LLM；≤500 字符 |
| `reason` | 推荐理由 | LLM；≤500 字符 |
| `suggestedModelProfileId` | 建议模型 | 必须是 `settings.models[].id` 或 null；null = 默认模型 |
| `permission` | 权限 | 固定 `read_only`（候选不能建议提权） |
| `skills` | 技能 | 0–8 个短标签 |
| `risks` | 风险 | 0–6 条；高风险需在卡上可见 |
| `systemPrompt/persona/agentsMd` | 详情（默认折叠） | 可选；仅用于“编辑后聘用”预填，不是现有成员提示词 |

卡操作：

- **聘用**：卡内展开确认区（不是立即创建）：
  - 显示最终 `name/role/model/permission=read_only`；
  - `确认聘用` primary；`编辑后聘用` → 切到 B tab 预填；
  - 确认后才调 `createAgent`。
- **编辑后聘用**：切 B tab，预填候选全部字段；用户自行修改后按现有「创建成员」提交。
- **重新推荐**：清空当前候选（未创建的），再次调用；不保留旧卡混排。
- **取消**：关闭 Modal/切 tab 不创建；已有输入按 dirty guard 确认。

### 2.3 B. 自己设定（现有完整表单）

保留现状字段：

- name、role、model（已配置模型列表）、systemPrompt、persona、agentsMd；
- 新建不显示 permission select，显示 read_only notice；
- 编辑已有成员仍显示 permission select（现有语义）；
- **模型/重名校验沿用现有 createAgent 语义**（显式模型必须在 settings.models；空 = 默认；重名拒绝）；
- 提交按钮 `创建成员`/`保存成员`，失败保留表单，成功后关闭/刷新；
- 候选“编辑后聘用”只预填字段，不改变这个表单的提交路径。

### 2.4 C. 描述生成

```text
描述你需要的成员（必填，1–2000 字符）
[例如：需要一个负责前端可访问性与响应式回归的 QA，熟悉键盘/读屏，权限先只读]
[生成候选]   [清空]
```

- 描述原样作为 LLM user 输入，不做模型侧改写；UI 显示剩余字符数。
- 空/全空白：inline error，不发请求；>2000：inline error，不截断。
- 生成结果与 A 使用同一 `MemberCandidate[]` schema/卡片/聘用流程。
- `重新生成` 覆盖当前候选（未创建）；失败保留描述。
- 描述可能含敏感内容：它会进入 LLM（与 Chat 一致），但不会写入任务/agent/日志；UI 不持久化。

---

## 3. 推荐 schema、prompt 与模型/失败语义

### 3.1 严格 JSON schema

服务端只接受：

```json
{
  "candidates": [
    {
      "name": "string",
      "role": "string",
      "responsibilities": "string",
      "reason": "string",
      "suggestedModelProfileId": "string|null",
      "permission": "read_only",
      "skills": ["string"],
      "risks": ["string"],
      "systemPrompt": "string?",
      "persona": "string?",
      "agentsMd": "string?"
    }
  ]
}
```

约束：

- `candidates` 数量 **1–3**；空数组合法（表示“没有足够信息/不推荐”），但 UI 显示空态，不补默认候选。
- 每个候选 `name/role/responsibilities/reason` 必填非空；name ≤64、role ≤48、responsibilities/reason ≤500；skills ≤8（每条 ≤64）、risks ≤6（每条 ≤160）；systemPrompt ≤4000、persona ≤2000、agentsMd ≤2000。
- `suggestedModelProfileId` 必须 ∈ `settings.models[].id` 或 null；**模型 label 由服务端映射，绝不接受 provider/baseUrl/key**。
- `permission` 只接受 `read_only`；其他值整份 schema 无效（不静默改）。
- `additionalProperties:false`；未知字段（`apiKey`、`baseUrl`、`isRouter`、`provider` 等）拒绝整份响应。
- 候选 name 在候选内唯一（大小写不敏感）；不得是 `Router`（大小写不敏感）；不得与现有 workspace member 重名——服务端最终创建时还会拒一次。
- 候选 role 与现有成员相同：**warning**，允许（团队可有多名 engineer）；不自动改名。
- 服务端不信任 `permission`/`model`/`systemPrompt` 写入；只把合法值映射到现有 `createAgent`；permission 实际由 store 固定 read_only。

### 3.2 推荐上下文（只传必要事实）

发送给 Router LLM 的 user 上下文：

- workspace name/path/overview；
- 现有成员 **name/role/model label**（不传 systemPrompt/persona/AGENTS.md）；
- tasks `title/status/ownerName`（不传 trace/tool 输出/验收长文全文）；
- 最近 Chat 摘要/最近 8 条消息（若当前窗口有；不传 system compaction 以外的隐藏内容）；
- 允许模型列表 `label + profile id`（不传 provider key/baseUrl/env）；
- 允许权限固定 `read_only`；
- mode（team-gap 或 description；description 原文）；
- 明确的输出 schema/数量/长度/禁用字段；
- 不传 `store` 内部事件/Key/系统提示。

### 3.3 Prompt 约束（建议原文）

System：

```text
ROUTER_MEMBER_RECOMMENDER
You are Router, the coordinator of DeerSuperGroup.
You only propose candidate team members. You do not create, modify or delete anything.
Return JSON only, no markdown, no prose, matching the provided schema exactly.
Use only the supplied workspace/team/task/context facts. Do not invent tasks, members, keys or URLs.
Recommend 1-3 non-Router members. If there is not enough information, return {"candidates":[]}.
Never output API keys, tokens, Authorization headers, provider base URLs, environment variables,
or the system prompts/personas/AGENTS.md of existing members.
permission is always "read_only"; do not propose privilege changes.
suggestedModelProfileId must be one of ALLOWED_MODEL_IDS or null.
Keep responsibilities/reason concrete and short; list skills and risks honestly.
```

User 结构：

```text
WORKSPACE: ...
OVERVIEW: ...
TEAM:
- name (role, model label)
TASKS:
- title [status] owner
RECENT_CONTEXT:
...
MODE: team-gap | description
DESCRIPTION: ...            (仅 C)
ALLOWED_MODEL_IDS: [...]
ALLOWED_PERMISSION: read_only
SCHEMA: {...}
```

- 模型：使用 Router 当前有效模型；`settings.mock=true` → **不生成**，返回 `MOCK_UNSUPPORTED`（错误提示“Mock 模式不提供真实推荐，请手填或切换模型”），不伪造候选。
- `settings.models.length===0` → `NO_MODEL_CONFIGURED`；A/C 禁用，提供去设置。
- 超时：服务端 20s AbortController；`RECOMMEND_TIMEOUT`。
- 坏 JSON/超 schema/未知字段：`RECOMMEND_INVALID_SCHEMA`，整份丢弃，不部分采用、不 fallback 模板。
- LLM 网络/429/401：复用现有错误摘要/脱敏；UI inline + 重试；不自动重试。
- **空结果**：`candidates:[]` → `RECOMMEND_EMPTY` 状态；UI“Router 没有给出候选”，提供重新描述/手动；**不自动生成默认成员**。
- 解析/校验失败不写日志原文；只记录 code、候选数量、耗时、model label。

### 3.4 API 面

```ts
type MemberRecommendationMode = "team-gap" | "description";

interface RecommendMembersRequest {
  workspaceId: string;
  mode: MemberRecommendationMode;
  description?: string; // description mode only, 1-2000
  constraints?: {
    teamSize?: number;  // optional hint; UI may omit
    roles?: string[];   // optional hint
  };
}

interface MemberCandidate {
  candidateId: string;      // server/renderer ephemeral; not persisted
  name: string;
  role: string;
  responsibilities: string;
  reason: string;
  suggestedModelProfileId: string | null;
  suggestedModelLabel: string | null;
  permission: "read_only";
  skills: string[];
  risks: string[];
  systemPrompt?: string;
  persona?: string;
  agentsMd?: string;
}

interface RecommendMembersResult {
  candidates: MemberCandidate[];
  generatedAt: string;
  modelLabel: string;
  context: { memberCount: number; taskCount: number; hasDescription: boolean };
}
```

- **新增只读** `recommendMembers`；不新增 `hire`/batch API。
- 创建仍用现有 `createAgent`；`CreateAgentInput` 不变（无 permission）。
- 不新增 agent 表/列/事件事实源；候选 DTO 只在服务端响应和 renderer 内存中存在。
- IPC：`agent:recommend`；service `recommendMembers` 不调用 `store.createAgent`/事件。

---

## 4. 聘用语义（一次一个）

### 4.1 单次聘用

- 候选卡是**备选**，不是批量：一次只允许一个 `确认聘用`。
- 确认后调用现有 `createAgent`（name/role/model/systemPrompt/persona/agentsMd）；实际 permission=read_only。
- 成功后 refresh/关闭/ toast「已聘用 X」；候选/描述不清空到其他候选（关闭 Modal）。
- 创建失败（重名/模型/其他）：无成员；候选卡保留，inline error；用户可编辑/重试；不自动重试。
- 刷新失败：沿用 `writeThenRefresh` 语义——创建已 committed 就关闭并 toast「已创建，但刷新失败」，不允许重提造成重复。
- **P0 不做多选批量**；若未来需要批量，另立任务设计**一次事务 + per-item 结果**，不在本设计偷偷引入。

### 4.2 重名/重角色/Router 冲突

- **name 大小写不敏感**与现有成员或 Router 相同：硬错误；不能聘用；候选卡置灰 + “改名后聘用”；服务端 `createAgent` 再拒一次。
- **role 与现有 role 相同**：warning（允许），显示“已有多名同角色成员”；不自动改名。
- **Router**：候选不会被生成为 Router；name=Router / role=coordinator 仅作 warning；`isRouter` 从不由候选设置；不能通过推荐替换/删除 Router。
- **候选间重名**：整个响应 schema 失败（或服务端剔除重复候选并警告？本设计选**整份拒绝**，避免用户看到两个同名候选）。
- **不自动后缀**（`Builder2`）——改名必须用户显式编辑。

### 4.3 模型/权限

- 模型必须已配置：
  - candidate `suggestedModelProfileId` 在白名单内，服务端归一为 `profile.id`；
  - null 表示默认模型；若默认模型不可解析 → `MODEL_NOT_CONFIGURED`，不能聘用；
  - 无配置模型 → A/C 禁用，指向 Settings；**B 保留现有 createAgent 规则**（显式模型必须在列表，空用默认），不额外改手动创建语义。
- **permission=read_only**：
  - 新成员表单没有权限选择（现状）；
  - 候选的 permission 只显示；不传入 createAgent；
  - 创建后在现有成员编辑中才能提权；UI 明确“推荐不能提权”。
- 模型 label 显式显示；不得回退到不同 provider 的 key。

### 4.4 双击/幂等

- 本地 `hiring` ref/状态：确认按钮在请求期间 disabled + aria-busy；第二次 click/Enter 忽略。
- 服务端以 name 唯一性兜底：第一次成功后第二次会得到 `member already exists`，不会产生两个成员。
- 不自动挂 retryAction；失败由用户手动再确认。
- 成功后关闭 Modal，不保留可再次点击的确认按钮。

---

## 5. UI/UX

### 5.1 Modal 结构

```text
新建成员（Modal）
  [Router 推荐] [自己设定] [描述生成]     ← role=tablist；编辑已有成员不显示
  ┌──────────────────────────────────┐
  │ A: 说明/推荐按钮/加载/候选卡/空/错 │
  │ B: 现有完整表单                    │
  │ C: 描述 textarea + 生成/重生成     │
  └──────────────────────────────────┘
  footer sticky：取消 | 主操作（B 创建；A 卡内确认；C 卡内确认）
```

- 编辑已有成员：只显示 B，无 tab；避免“编辑也推荐”的误解。
- A/B/C 切换保留各自本地草稿（同一 Modal 内 state；切走不丢）。
- 关闭/dirty guard：B 有输入、C 有描述、A 已生成候选或确认中，均需 confirm；取消不写。
- 初始焦点：tab 选中项；A 成功后 focus 第一张候选卡；错误 focus error summary；应聘确认 focus `确认聘用`。
- 1440/960：
  - 1440 候选卡双列（1–3 张自适应；至少 340px/张）；
  - 960 单列，卡内字段堆叠，footer sticky，无横向滚动；
  - Modal 内部 `overflow:auto`；不新增 Dock/宽度列。

### 5.2 状态与文案

| 状态 | 表现 |
|---|---|
| A 初始 | 说明 + `让 Router 推荐`（禁用原因：Mock / 无模型） |
| loading | 1–3 个骨架卡，`aria-busy=true`，`role=status`“Router 正在推荐…” |
| 成功 | 候选卡 + `重新推荐` + 卡内 `聘用/编辑后聘用` |
| empty | “Router 没有给出候选。可以重新描述目标，或自己设定成员。” + 手填/描述/重试；不伪造 |
| error | inline 脱敏摘要 + `重试`；`MODEL_NOT_CONFIGURED` 给“去设置模型” |
| C 空描述/超长 | inline error；生成按钮 disabled；不请求 |
| hiring | 当前卡确认区 busy；其他卡/生成禁用 |
| success | 关闭 Modal + toast「已聘用」；刷新；不自动继续推荐 |
| failure | 卡保留，inline error；不自动重试；可编辑/重试 |

- **不自动创建**：所有创建路径都必须经过 `确认聘用` 或 B 的 `创建成员` 按钮。
- **不伪造**：空/失败不生成模板候选；不把现有成员改个名当推荐。

### 5.3 候选卡详情

- 头部：name + role + 建议模型 + read_only chip；
- 职责/推荐理由；
- skills chips；risks（高风险用 warning 样式，不用颜色单独表达）；
- `详情` 展开 systemPrompt/persona/AGENTS.md（只读；编辑后聘用时预填）；
- 操作：`聘用`（展开确认）/`编辑后聘用`；确认区显示 read_only 说明和“创建后可在成员编辑中调整”。

### 5.4 与 R2 后 TeamDashboard 的兼容

- 三 tab 全在现有 `AgentDialog` 内，TeamDashboard 继续拥有 `dialog` 状态和 `onCreate/onUpdate` 回调；不新增 Agent 列表/选择源。
- R2 把 Chat/Team 面板渲染隔离，不改变 `AgentDialog` 的 props 边界；实现时不把推荐状态放进 TeamDashboard 全局，避免第二次全树刷新。
- 不新增 PanelKey/rail/route；TeamDashboard 布局不变，只在 Modal 内部滚动。

---

## 6. 文件面（实现切片，不在本任务写代码）

```text
src/shared/types.ts              MemberRecommendationMode/MemberCandidate/Request/Result
src/shared/ipc.ts                agent:recommend
electron/main.ts                 handle("agent:recommend")
electron/preload.ts              recommendMembers
src/kernel/memberRecommendation.ts  schema/prompt/parse/validate（纯函数）
src/kernel/service.ts            recommendMembers：ensureRouter + LLM，无 store 写
src/TeamDashboard.tsx            AgentDialog 三 tab、候选卡、聘用确认；编辑仍完整表单
src/App.tsx                      handleRecommendMembers；handleCreateAgent 复用 writeThenRefresh
src/styles.css                   tab/候选卡/960/1440
tests                            schema、service、UI、聘用、并发/失败
docs/team/router-member-recommendation-design.md
```

**不新增**：agent 表/字段/迁移、`recommended_agents` 表、批量 hire API、第二个 Router、独立成员市场/panel。

---

## 7. 测试计划

### 7.1 纯函数/schema

- 合法 1–3 候选；4 个 → invalid；空数组 → empty（不是 fallback）。
- 缺字段/错类型/未知字段/错误 permission/非法 model ID → 整份拒绝。
- name=Router、候选间重名、空白 name/role、超长字段 → 拒绝/明确 issue。
- description 空/全空白/2000+/正常 → 空/超长错误/可生成。
- schema 不含 key/baseUrl/isRouter；prompt 不出现现有 systemPrompt/persona/AGENTS.md。

### 7.2 service/LLM

- mock → `MOCK_UNSUPPORTED`，不调用 client/不返回假候选。
- 无 models → `NO_MODEL_CONFIGURED`，不返回假候选。
- timeout → `RECOMMEND_TIMEOUT`；invalid JSON → `RECOMMEND_INVALID_SCHEMA`；empty → empty state。
- 成功：返回 candidates；**agents 数量/事件/任务不变**；不写 store；不调用 createAgent。
- 模型 label/ID 全部来自 settings；provider key/baseUrl 不进入 prompt（spy/string 断言）。
- 推荐不自动重试；上层手动重试。

### 7.3 聘用/权限

- direct hire `确认聘用` → createAgent 调用一次；permission 实际 read_only（store 默认）；model profile 正确。
- 编辑后聘用 → B 预填；提交仍走 createAgent；permission read_only。
- name 冲突（大小写不敏感）→ 无成员；服务端拒绝；候选卡可编辑。
- role 冲突 → warning 但可聘；Router/name Router → 拒绝。
- 双击确认 → 单次调用；第二次成功前 disabled；服务端重名兜底。
- create 失败 → 无成员、表单/卡保留、无自动 retry。
- create 成功 + refresh 抛错 → 关闭 + postError toast，只一条成员（复用 writeThenRefresh 语义）。
- 无模型/模型非法 → 禁用/error；不自动改模型。

### 7.4 UI/无障碍/回归

- 三 tab role=tablist/tab/tabpanel；Arrow/Home/End；焦点；错误 summary；aria-busy；960 单列/1440 双列；无横向。
- A 初始/loading/empty/error/retry；C 空/超长/重生成；B 现有表单。
- 取消/关闭 dirty guard；切换 tab 保留各自输入；成功关闭。
- 编辑已有成员没有推荐 tab；现有手动创建/编辑/删除/权限流程回归。
- R2 下 TeamDashboard panel 隔离不影响 modal；不新增 agent 源/事件。
- 键盘完成 A 推荐→编辑→确认/B 手填/C 描述→生成→聘用；读屏有候选字段/错误/状态。
- 现有 createAgent 重名/模型校验测试保持。

### 7.5 手工/真实 Electron

- 1440/960 各一次 A/B/C；加载/空/超时（mock）截图。
- 真实 workspace + 已配置模型（或 mock 下确认禁用 A/C）；候选→编辑→聘用→Team 列表刷新。
- 重名/无模型/双击确认/刷新失败各一次；无重复成员。
- 不泄漏检查：推荐请求 payload/日志/UI 不含 key、baseUrl、现有成员系统提示。

---

## 8. 验收标准（AC）

| ID | 验收 |
|---|---|
| AC-01 | 新建成员 Modal 有三个入口 A/B/C；编辑已有成员仍只有完整手动表单 |
| AC-02 | A 能从 workspace/team/task/chat 事实返回 1–3 候选；每卡含 name/role/职责/reason/model/permission=read_only/skills/risks |
| AC-03 | B 保留现有全部字段；C 描述空/超长有 inline error，正常可生成同 schema 候选 |
| AC-04 | 严格 JSON + 服务端校验；坏 JSON/未知字段/非法 model/错误 permission 整份拒绝，无 fallback/假候选 |
| AC-05 | Mock/无模型/超时/空结果有明确状态；不自动创建、不伪造默认成员 |
| AC-06 | 聘用必须显式确认；支持编辑后聘用；一次一个；多候选只是备选，无批量 |
| AC-07 | 新成员权限实际 read_only；候选不能提权；创建后仅现有编辑可调整 |
| AC-08 | 重名/Router name/角色冲突/模型未配置按 §4 处理；失败无成员、双击不重复 |
| AC-09 | 创建成功刷新失败不重复；表单/卡失败保留；无自动 retry |
| AC-10 | 不新增 agent 表/字段/事实源；createAgent 仍是唯一创建入口；无批量 API |
| AC-11 | Prompt/请求/日志/UI 不泄露 Key/baseUrl/现有 systemPrompt/persona/AGENTS.md |
| AC-12 | 1440/960、键盘/aria、R2 TeamDashboard 兼容；现有手动创建/编辑/权限回归 |
| AC-13 | 测试计划覆盖 schema/mock/model/timeout/empty/duplicate/double/cancel/refresh；仅新增设计文档 |

---

## 9. 风险与回滚

| 风险 | 影响 | 缓解/回滚 |
|---|---|---|
| LLM 幻觉/伪造成员 | 用户聘用到不存在的能力 | 严格 schema + 1–3 + 空结果不 fallback + 编辑/确认；不自动创建 |
| prompt injection（描述/上下文） | 泄漏或越权建议 | 严格 JSON、无工具、权限固定 read_only、输出字段白名单、服务端重校验；用户确认 |
| 泄露 Key/系统提示 | 安全 | 不传 provider key/baseUrl/env、不传现有 agent systemPrompt/persona/AGENTS.md；错误脱敏；UI 不展示隐藏提示 |
| 重名/双击/重复创建 | 团队重复成员 | UI 单飞 + 服务端 name 唯一 + 确认关闭；不做批量 |
| create 成功 refresh 失败 | 用户以为失败重试重复 | writeThenRefresh：创建 committed 即关闭 + postError toast；不自动 retry |
| 模型未配置/Mock | 假推荐或失败 | A/C 禁用并解释；B 指向 Settings；mock 不伪造候选 |
| 960/Modal 空间不足 | 可读性/操作 | 单列、内部滚动、sticky footer、卡片折叠详情；不新增 Dock 宽度 |
| R2 性能改动耦合 | TeamDashboard 回归 | tab 留在 AgentDialog，TeamDashboard 仅 props；不新建 Agent 状态源 |
| 成本/延迟 | 每次推荐 LLM 调用 | 仅点击时请求；20s timeout；空/失败不自动重试；可手填 |
| 权限被推荐绕过 | 安全 | permission 固定 read_only，createAgent 无 permission 参数；不自动提权 |

**回滚**：

- UI 隐藏 A/C tab，只保留 B；`agent:recommend` 可停用；现有手动创建/编辑/删除不变。
- 无 schema/agent 数据迁移；候选 DTO 只在内存/响应；回滚不影响已有成员。
- 若 R2 改版冲突，AgentDialog 作为独立子组件迁移，不改变本设计的 API/权限语义。

---

## 10. 需要确认的默认

1. **单次聘用**：P0 一次一个，不做批量；多候选是备选。
2. **A 默认 tab**：有真实模型且非 mock 时默认 A；否则默认 B。
3. **候选 permission**：严格只允许 `read_only`，不从候选提权。
4. **Mock**：不生成推荐；A/C 禁用，B 保留。
5. **候选 systemPrompt/persona/AGENTS.md**：允许生成但默认折叠，仅在编辑后聘用预填；不展示现有成员提示。
6. **模型白名单**：只能选 `settings.models`；无模型时不能推荐/聘用。
7. **角色冲突**：warning 允许；name/Router 冲突阻断。
8. **批量**：明确 P1 另评，需事务 + per-item 结果；本设计不偷偷支持。
