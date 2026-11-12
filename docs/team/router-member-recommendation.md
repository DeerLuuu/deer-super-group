# Router 推荐成员 / 手动设定 / 描述生成（t272 实现）

## 范围

- 新建成员 Modal 内三个入口：`Router 推荐` / `自己设定` / `描述生成`；编辑已有成员只保留完整手动表单，不显示推荐 tab。
- 只读推荐 `recommendMembers` 返回候选 DTO；**createAgent 仍是唯一创建入口**。没有自动创建、没有批量聘用、没有第二个 agent 数据源。
- 新成员实际权限始终 `read_only`（store 固定）；候选 permission 只展示，不能在推荐中提权；创建后走现有成员编辑提权。
- 模型只允许 `settings.models`；mock/无模型禁用 A/C，无模型不能聘用；不改 review/merge gate、权限语义、任务状态机。

## 入口与默认

| 场景 | 行为 |
|---|---|
| 有真实模型且非 mock | 默认 `Router 推荐` |
| 无模型 / mock | 默认 `自己设定`；A/C `aria-disabled` 并说明原因 |
| 编辑成员 | 不显示 tab，只显示现有表单 |
| A 推荐 | 点击才请求，不自动请求；loading/空/错误 inline；空不补默认候选 |
| C 描述生成 | 描述 1–2000；空/超长 inline error，不请求；重生成覆盖未创建候选 |
| 聘用 | 卡内展开确认；一次一个；双击由 `hiringRef` + disabled 单飞；失败保留候选/表单；成功关闭 |

## 严格 schema

服务端 `parseCandidateResponse`：

- 顶层仅 `candidates`；未知 key 整份拒绝。
- 1–3 个候选；0 个 → `RECOMMEND_EMPTY`，不 fallback。
- 必填 name/role/responsibilities/reason；未知字段、错误 permission、非法 model、候选重名、Router 名都整份拒绝。
- `suggestedModelProfileId` 必须 ∈ `settings.models[].id` 或 null；label 由服务端映射。
- skills ≤8、risks ≤6；systemPrompt/persona/agentsMd 可选且默认折叠，只在“编辑后聘用”预填。
- 候选 name 与现有成员冲突：服务端标 `nameConflict`，UI 禁用聘用并提示改名；最终 createAgent 再拒一次。role 冲突标 warning，允许聘用。

## 服务端

- `AppService.recommendMembers` 不写 store、不调用 createAgent。
- mock → `MOCK_UNSUPPORTED`；无模型 → `NO_MODEL_CONFIGURED`；无 Router 有效模型 → `MODEL_NOT_CONFIGURED`。
- 20s AbortController → `RECOMMEND_TIMEOUT`；坏 JSON/schema → `RECOMMEND_INVALID_SCHEMA`；网络错误摘要脱敏。
- Prompt 只含 workspace/team name-role-model label/tasks/最近对话/模型白名单；不含 Key/baseUrl/env/现有 systemPrompt/persona/AGENTS.md。
- `createAgent` 增加无模型拒绝；新成员仍固定 read_only；`App.handleCreateAgent` 使用 `writeThenRefresh`：创建 committed 即返回 true/关闭，刷新失败只 toast，不重复提交。

## 文件

- `src/shared/types.ts`：DTO/响应类型
- `src/shared/memberRecommendation.ts`：schema/prompt/解析/错误文案
- `src/kernel/service.ts`：`recommendMembers`
- `src/shared/ipc.ts`、`electron/main.ts`、`electron/preload.ts`：`agent:recommend`
- `src/TeamDashboard.tsx`：三 tabs/候选卡/确认/描述生成
- `src/App.tsx`：`handleRecommendMembers`、`handleCreateAgent` committed 语义
- `src/styles.css`：tabs/cards/960 单列
- 测试：schema、UI、service mock

## 测试

- `memberRecommendation.schema.test.ts`：1–3/空/未知字段/permission/model/重名/Router/坏 JSON/prompt 无密钥。
- `memberRecommendation.test.tsx`：默认 tab、mock 禁用、候选渲染、显式确认、双击、编辑预填、描述生成、无模型。
- `service.test.ts`：mock 不伪造候选且不新增 agent。
- 组件/类型/构建/全量测试命令见 PR。

## 风险 / 回滚

- LLM 幻觉由严格 schema + 显式确认 + 服务端 createAgent 校验兜底；空/失败不伪造。
- 无 schema/DB 迁移；回滚可隐藏 A/C tab、停用 `agent:recommend`，现有手动创建/编辑不变。
- 960 单列、Modal 内部滚动，不改变 Dock 宽度。

## 截图

- 1440：`docs/team/t272-member-recommend-1440.png`
- 960：`docs/team/t272-member-recommend-960.png`

截图从真实 Electron + 现有工作区打开「新建成员」；默认 Router 推荐 tab，960 下 modal 无横向滚动、tab 保持单行。

## t278 补强

- recentContext 每条复用 `sanitizeErrorText(500)` 后再进 provider prompt；覆盖 `sk-live-*`、Bearer、Authorization、Cookie、token/secret/password/client_secret/accessToken/private_key、URL query、内部 URL、provider body；单条 cap 500、最多 8 条。
- 推荐失败补充 `RECOMMEND_RATE_LIMITED`（429/限额）、`RECOMMEND_AUTH_FAILED`（401/认证）；timeout/empty 保持明确 code。
- 服务测试断言 429/401/timeout/empty 不新增 agent；UI 测试断言限流/认证/超时/空状态与重试/手动 fallback。
- 编辑已有成员组件测试：无 tabs/推荐 CTA，仅手动表单。
- 推荐/手动聘用均提交 permission=read_only；`CreateAgentInput` 无 permission 字段（`@ts-expect-error` guard），service 对运行时夹带 permission 仍固定 read_only。

## t280 补强

- Prompt 所有自由文本统一 `sanitizeErrorText` + 字段级 cap：workspace name/path/overview、成员 name/role/model label、任务 title/description/status/owner、最近上下文、描述、模型 id/label；任务 description 纳入上下文。
- schema/service 测试用 overview、任务标题、任务 description、描述、最近消息分别注入 `sk-live-*`/Bearer，断言 provider prompt 不含原文。
- IPC `agent:create` 边界使用 `stripCreateAgentPermission` 只保留固定字段，permission/isRouter 等未知字段被丢弃；service 仍对夹带 permission 固定 read_only；测试覆盖 helper 与 service。
