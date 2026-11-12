# Router 推荐成员三入口 · 独立验证报告（t273）

- **任务**：t273 [verification] 独立验证 t272
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #42 `feature/t272-member-recommend`，HEAD `65d97b0`（OPEN/MERGEABLE；worktree `branches/t272-member-recommend`，clean）；未合并，未修改生产代码。
- **方法**：worktree 复跑三命令 + 读 shared/memberRecommendation schema、service.recommendMembers、TeamDashboard AgentDialog、App/IPC/测试 + 1440/960 截图。

---

## 1. 结论：**PASS（通过，无 blocker）**

- 新建成员 Modal 三 tabs（Router 推荐/自己设定/描述生成）；编辑已有成员不渲染 tablist，只用完整表单。
- 推荐严格 schema：顶层只 candidates、1–3、字段白名单、模型白名单、permission 固定 read_only；坏 JSON/未知字段/非法 model/错误 permission/候选重名/Router 名整份拒绝；0 候选返回 EMPTY，不 fallback/不伪造。
- mock/无模型 A/C 禁用并说明；空/超时/429/401 有 inline error + 重试/重新生成 + 手动 tab；不自动创建。
- 聘用显式“聘用→确认聘用”、编辑后预填、一次一个、双击 `hiringRef` 单飞；name/Router 阻断、role 冲突按设计 warning；刷新失败 `writeThenRefresh` committed 即返回 true，不重复提交。
- 新成员实际 permission=read_only（store 固定，CreateAgentInput 无 permission）；recommendMembers 不写 store，createAgent 是唯一创建入口。
- 1440/960 截图；键盘/aria 有 tablist/roving/箭头/Home/End、error/status、确认 group；无 gate/权限语义变更。
- 三命令：typecheck/build 0；plain 4 个既有 5s timeout；20s 超时 94 文件/757 全绿。

---

## 2. 命令（worktree HEAD `65d97b0`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 433 modules；css 259.61 kB (gzip 31.83)；js 1,290.62 kB (gzip 356.81)；electron main 1.5MB/preload 12.0kB |
| `pnpm test`（plain） | 1（既有 flake） | 4 个既有 5s timeout（openai/service mock/watchdog×2）；753/757 |
| `pnpm exec vitest run --testTimeout=20000` | **0** | 94 文件/757 用例全绿 |

---

## 3. 逐项

### 3.1 三 tabs/编辑仅手填（PASS，N1 low）

- `TeamDashboard` AgentDialog：`!agent` 时渲染 `role=tablist` 三 tab（router/manual/description），roving tabIndex + ArrowLeft/Right/Home/End；`agent` 非空时不渲染 tabs，只渲染完整表单。
- 默认：真实模型非 mock → Router 推荐；无模型/mock → 自己设定，A/C `aria-disabled` 并有 title。
- 测试：3 tabs、mock 禁用、无模型不切 Router、manual 表单仍可用；**N1 low**：编辑已有成员“无 tab”无显式组件断言，靠 `!agent` 条件。
- 描述 tab：1–2000 字符校验、生成/重新生成/清空；`mode=description` 测试通过。

### 3.2 严格 schema/白名单/read_only（PASS）

- `validateCandidateResponse`：
  - 顶层只 `candidates`；未知 key 拒绝；
  - 1–3；required name/role/responsibilities/reason/suggestedModelProfileId/permission/skills/risks；
  - 未知字段/错误类型/空白/超长拒绝；
  - name=Router（大小写不敏感）拒绝；候选间重名拒绝；
  - suggestedModelProfileId ∈ settings.models[].id 或 null；
  - permission 只接受 read_only；
  - skills/risks 数组上限；systemPrompt/persona/agentsMd 可选且上限。
- `parseCandidateResponse` 剥 fenced JSON；坏 JSON/schema 返回 false，无 fallback；0 candidates → ok+空数组由 service 映射 RECOMMEND_EMPTY。
- 测试 5 条覆盖 1–3/未知字段/permission/model/重名/Router/坏 JSON/prompt 不含 sk-/baseUrl/system prompt。
- **N2 low**：prompt 包含最近对话原文，若用户曾粘贴 secret 不在过滤范围；设计只承诺不传 Key/baseUrl/env/现有提示词。

### 3.3 mock/无模型/空/超时/错误状态（PASS，N3 medium 测试面）

- service：
  - `MOCK_UNSUPPORTED` 在调用 LLM 前返回，不伪造候选；
  - `NO_MODEL_CONFIGURED`（models=0）；`MODEL_NOT_CONFIGURED`（Router/default profile 不在 models）；
  - 20s AbortController → `RECOMMEND_TIMEOUT`；
  - 解析失败 → `RECOMMEND_INVALID_SCHEMA`；0 候选 → `RECOMMEND_EMPTY`；
  - provider 429/401/网络 → catch + `sanitizeErrorText` → `RECOMMEND_FAILED`。
- UI：`runRecommendation` 清候选、inline error、A 重试、C 重新生成、手动 tab 始终可用；`recommendationError` role=alert；不自动创建。
- 测试：mock 不伪造且不新增 agent；no-model 禁用；空/超时/429/401 **无直接 service/UI 测试**（N3 medium），代码路径存在。

### 3.4 聘用语义（PASS，N4 medium 测试面）

- 显式两步：卡内「聘用」→ 展开确认「确认聘用」；`hiringRef` 同步单飞 + button disabled，双击只调用一次（测试通过）。
- 一次一个：`confirmId` 单卡；hiring 期间所有确认按钮 disabled；无批量 API。
- 编辑后预填：`editCandidate` 填 name/role/model/systemPrompt/persona/agentsMd，切 manual；测试断言 name 预填。
- nameConflict：服务端按现有成员标 flag，UI 禁用聘用并提示改名；createAgent 再拒一次。
- roleConflict：按 t269 设计 §5“warning 允许”，UI 提示不阻断。
- Router name：schema 拒绝；nameConflict 双保险。
- 刷新失败：App `handleCreateAgent` 用 `writeThenRefresh`，postError 只 toast“已创建但刷新失败”并返回 true；Team 关闭 dialog，不允许重提；不重复。
- **N4 medium**：没有 UI 测试覆盖 nameConflict/roleConflict/refresh 失败/编辑已有成员无 tab；主要靠代码与已有 writeThenRefresh 测试。

### 3.5 permission read_only/createAgent 唯一（PASS）

- `CreateAgentInput` 无 permission；store.createAgent 固定 `permission: "read_only"`（Router 同）。
- 推荐 DTO permission 字面量 read_only；`candidateToDraft` 也固定 read_only；App 创建不传 permission。
- 新建手动表单不显示 permission select，只显示 read_only notice；编辑已有成员仍显示（现有语义）。
- recommendMembers 只 list/LLM/parse，不写 store；createAgent 唯一创建入口；无第二 agent 数据源。
- **N5 low**：权限实际 read_only 由 store 保证，但本轮没有新增 service 断言/回归；既有 store 逻辑可支撑。

### 3.6 1440/960/键盘/aria/范围（PASS，N6 low）

- 960 截图：Modal 三 tab 单行、无横向滚动；1440 截图存在；CSS 仅 modal/tabs/cards。
- tablist/tab/aria-selected/aria-controls/aria-disabled/roving tabIndex；loading role=status；error role=alert；confirm group aria-label；candidate buttons。
- 无 review/merge gate、权限语义、任务状态机、数据层/schema/迁移；recommendMembers 新 IPC 只读。
- **N6 low**：没有真实 Electron 候选卡→编辑→聘用全链路自动测；截图只展示空推荐态。

---

## 4. 发现（非阻塞）

| ID | 级别 | 发现 | 建议 |
|----|------|------|------|
| N1 | low | 编辑已有成员无 tab 仅靠 `!agent` 条件，无显式组件断言 | 补 edit dialog 无 tablist 测试 |
| N2 | low | prompt 含最近对话原文；若用户粘贴 secret 不在过滤范围 | 可选对 recentContext 做脱敏/截断 |
| N3 | medium | 空/超时/429/401 无直接 service/UI 测试；mock 与 no-model 有 | 补 fake client timeout/429/401/empty 测试 |
| N4 | medium | nameConflict/roleConflict/refresh 失败/编辑后聘用无 UI 测试 | 补 4 条交互回归 |
| N5 | low | 新成员 read_only 由 store 固定，无新 service 断言 | 补 createAgent 后 permission 断言 |
| N6 | low | 无真实 Electron 候选→编辑→聘用全链路自动测；截图空推荐态 | 发布前人工走查 |
| N7 | low | plain test 既有 5s flake；20s 757/757 | CI 单独超时/串行 |

---

## 5. 结论

**PASS**：三入口/编辑仅手填、严格 schema/模型白名单/read_only、mock/无模型禁用与手动 fallback、显式确认/编辑预填/单次/双击/name/Router 冲突/刷新失败不重复、实际 read_only 与 createAgent 唯一入口均成立；无 gate/权限语义/数据层变更；typecheck/build 0，20s test 94/757。N3/N4 为测试面补强，不阻塞 PR #42 进入评审/合并。

*本次验证仅新增本报告，未修改生产代码。*
