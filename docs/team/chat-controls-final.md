# 对话控制条与权限模型 · 集成验收报告（t55）

- **场次**：对话权限、模型切换与满血模式（DESIGN §15）｜2026-11-10
- **任务**：t55 [integrate] 集成验收（in scope：`src/`、`docs/team/`）
- **集成人**：kai（Documentation & Integration）
- **输入**：
  - 设计：`DESIGN.md` §15（15.2 权限 / 15.3 auto_risk / 15.4 Full Throttle / 15.5 控制条 / 15.6 API / 15.7 验收）
  - 实现：`docs/team/chat-controls-implementation.md`（t53 / mika，含 5 项实现取舍）
  - 评审：t54（noor）**verdict=pass**，8 条 acceptance 全 passed
- **验证**：`pnpm typecheck` / `pnpm build` / `pnpm test`，修复前基线 + 修复后最终各一轮，最终全部通过（测试 61/61，新增 3 项集成回归）

---

## 1. 最终结论

| 验收点 | 结果 | 依据 |
|--------|------|------|
| t54 评审通过 | ✅ | t54 `verdict=pass`，8/8 acceptance 全 passed（typecheck/test + 静态走查）；t53 三命令全过（build 已由实现轮验证） |
| 模型切换、四档权限、auto_risk、Full Throttle 提示注入均可用 | ✅ | 控制条模型/权限/FT 三控件（App:2531）→ updateAgent/sendChat 真实生效（service:368/407）；四档门禁（policyCheck:115）；auto_risk 三级（classifyRisk:95 + 投票:124）；FT 注入（permission:178 + service:391/754） |
| FT 不改变权限、不自动批准；read_only + FT 仍拒绝写入 | ✅ | FT 不进入门禁：`policyCheck` 签名无 FT、`ToolRegistry.execute` 只读 `ctx.permission`（tools:80）；read_only 写入/shell 拒绝有单测（permission.test:29/177）；FT 只拼 system prompt + 预算（service:391/410、754/778） |
| 权限/模型/FT 状态持久化，审计事件完整 | ✅（FT 按设计仅会话级） | `agents.permission/model` 入库 + 迁移（store:57/357/507）；事件 `agent.permission_changed`/`agent.model_changed`/`session.full_throttle_changed`/`tool.denied`/`permission.risk_vote`（service:307-324/467、tools:103/181/229）；**IF-02 补齐 approved/human_required 风险事件** |
| 与 Dock/对话/任务/设置链路无回归 | ✅ | 控制条位于 ChatView（dock panel 内），Dock 代码零改动；任务执行传 `toolContext.permission`（service:750），端到端用例显式授权后通过（service.test:204）；设置/成员弹窗仅新增权限选择（IF-04）；61/61 测试 |
| typecheck / build / test 全部通过 | ✅ | 最终 exit 0/0/0；build 283 modules、js 901.83 kB（gzip 244.67）；test 8 文件 61 用例（§4） |
| `docs/team/chat-controls-final.md` 输出实现与验证摘要 | ✅ | 本文件 |

**额外结论**：集成阶段发现并修复 **4 个缺陷**——IF-01 只读 shell 白名单可被 `&& / ; / \| / $( )` 绕过（高危，权限硬门禁失效）、IF-02 auto_risk 放行/高风险路径缺少 `permission.risk_vote` 审计事件、IF-03 切换工作区后服务端 FT 仍生效但 UI 标识归零、IF-04 新成员默认 read_only 却无任何 UI 可修改其权限（任务链路被堵）。另记录 8 项低优先级差异/后续项（§6）。

---

## 2. 交付与实现映射

| 区域 | 文件 / 行 | 交付要点 |
|------|-----------|----------|
| 控制条 UI | `src/App.tsx:2531`（`.chat-controls`）、`:2551` 权限、`:2569` 满血模式、`:2411` FULL THROTTLE 徽标、`:2421` 头部权限文案 | 输入框下方三控件；原生 select/checkbox + aria-label/aria-pressed/title + focus-visible；窄窗折行；busy 时禁用 |
| 控制条逻辑 | `src/App.tsx:600`（模型/权限）、`:630`（FT）、`:459`（切工作区清理 FT） | 写入当前 Agent（Router），失败保留原值 + toast；模型切换提示「下一条消息生效」；FT 开启提示成本/延迟 |
| 权限模型 | `src/shared/types.ts:22`（PermissionMode）、`:37`（Agent.permission）、`:269`（CreateAgentInput）、`:288`（UpdateAgentInput.permission）；`src/shared/copy.ts:50` | 四档中文标签/一句说明单一来源；新成员默认 read_only（安全默认） |
| 执行层门禁 | `src/kernel/permission.ts`（新增）：`:12` TOOL_RISK、`:61` / `:95` 白名单与分级、`:115` policyCheck、`:178` FT 提示、`:193` 预算 | 纯函数可测；`ToolRegistry.execute` 每次调用前检查（`tools.ts:80`）；拒绝写 `tool.denied` 并回给模型（tools:200） |
| auto_risk | `src/kernel/tools.ts:81`（投票分支）、`:124` runQuickVote、`:166` recordRiskDecision | 低风险自动放行 + `auto_allowed`；中风险 Router+1 成员规则评审，无 quorum 升级人类；高风险 human_required 拒绝；**风险决策均落事件** |
| Full Throttle | `src/kernel/service.ts:381` / `:737`（sendChat/runTask 注入）、`:462` setFullThrottle；`src/kernel/permission.ts:178/193` | 会话级 Set（`service.ts:147`），不持久化；只注入提示 + 预算（输出×2/思考 max/步数×2），不碰权限 |
| 持久化/审计 | `src/kernel/store.ts:57`（permission 列）、`:357`（存量迁移默认 workspace_write）、`:507`（新成员 read_only）、`:570`（updateAgent patch） | 权限/模型持久化；FT 按设计仅内存；事件入 events 表 |
| IPC | `src/shared/ipc.ts:42`、`electron/preload.ts:37`、`electron/main.ts:124` | 仅 `session:setFullThrottle` 暴露给 renderer，Agent 无工具可开启 |
| 成员权限编辑 | `src/TeamDashboard.tsx:20`（draft）、`:458`（state/dirty）、`:536`（编辑弹窗权限选择） | **IF-04 修复**：编辑成员可改四档权限；新建成员提示默认 read_only |
| 样式 | `src/styles.css:3245`（`.chat-controls`）、`:3283`（`.ft-badge`） | 折行、focus-visible、金色 FT 标识 |
| 测试 | `src/kernel/permission.test.ts`（15 项：纯函数 10 + 执行层 5）；`src/kernel/service.test.ts:204`（显式授权 workspace_write） | 门禁/分级/审计/FT 注入/预算；端到端任务在授权后通过 |

---

## 3. 评审与验证流转

| 阶段 | 结果 |
|------|------|
| t53（mika，实现） | 控制条、四档权限、执行层门禁、auto_risk、FT、事件与 IPC 全部落地；typecheck/build/test 58/58 全过；5 项取舍记录在实现文档 |
| t54（noor，评审） | **verdict=pass**：8 条 acceptance 全 passed（含 read_only/workspace_write 硬门禁、auto_risk 三级、FT 正交且不改权限、持久化/审计、ARIA）；命令 typecheck/test + 静态走查通过；非阻断观察：workspace_write 下敏感路径写入（见 IF-08） |
| t55（kai，集成） | 代码走查 + 两轮三命令；发现 4 个缺陷并修复（§6），新增 3 项回归测试；最终 61/61；本报告沉淀验收链路与后续项 |

**复核 t53 的 5 项取舍**：①中风险用规则评审者而非异步 poll（P0 同步回路限制，事件结构已预留）——合理；②存量迁移 workspace_write、新成员 read_only——合理且安全优先；③read_only 拒绝所有 shell（含只读）——严格按 §15.2 表格；④Router chat 当前不执行工具（权限对任务执行成员生效）——README/文档需说明；⑤模型切换失败保留原值（快照驱动回退）——与验收一致。

---

## 4. 最终验证（t55 实跑）

| 命令 | 结果 | 退出码 | 关键输出 |
|------|------|--------|----------|
| `pnpm typecheck` | ✅ | 0 | `tsc --noEmit` 无输出 |
| `pnpm build` | ✅ | 0 | 283 modules；`dist/index.html 0.40 kB`、`dist/assets/index-53uPXy7F.js 901.83 kB (gzip 244.67 kB)`、`index-CeOo109Z.css 42.07 kB (gzip 8.42 kB)`；electron `main.cjs 856.3kb`、`preload.cjs 2.4kb`；**chunk >500 kB 警告**（既有问题） |
| `pnpm test` | ✅ | 0 | **8 文件 / 61 用例**（3.47s）：permission 15（12 原有 + 3 集成回归）、deeplink 13、TaskStarMap 5、kernel model 10、openai 1、service 7、models 8、Markdown 2 |

**执行记录**：
1. 修复前基线（t53 产物）：0/0/0，58/58（`index-DtQeDsJs.js 901.11 kB`）。
2. 修复后最终轮（IF-01..IF-04）：0/0/0，**61/61**（`index-53uPXy7F.js 901.83 kB`）。
3. 无生成物手工修改；`dist/`、`dist-electron/` 仅作验证产物（out of scope）。

---

## 5. 验收链路核对

### 5.1 模型切换实际生效
- 控制条模型下拉列出 `snapshot.settings.models`（provider 名 + 模型 id +「默认模型」），值绑定 `routerAgent.model`（App:2531–2549）。
- 切换 → `handleChatControlUpdate` → `updateAgent` 校验模型在配置列表内（service:285–297），持久化并写 `agent.model_changed`（service:316–324）；失败 toast「已保留原值」（App:621–623）。
- 下一条消息：`sendChat` 每次重新 `resolveModelProfile(settings, router.model)` 并以其 `modelId` 发起流式请求（service:368–370、407–408）——不缓存模型，切换即时生效。
- 证据：`service.test.ts:115–153`（模型校验 + 非法模型抛错）；真实端点使用新模型属人工冒烟项（§7）。

### 5.2 四档权限与执行层硬门禁
- **UI**：四档 select 带中文标签与说明（App:2551–2567），写事件 + toast；busy 禁用；窄窗折行（styles:3245）。
- **持久化**：`agents.permission` 列（store:57）；存量库 ALTER 默认 `workspace_write` 保持旧行为（store:357–363）；新成员/ Router 默认 `read_only`（store:507–543）；`updateAgent` 校验非法档位并写 `agent.permission_changed`（service:300–324）。
- **门禁（非提示词）**：`ToolRegistry.execute` 在真正执行前检查（tools:79–108）；`policyCheck`（permission.ts:115–173）：
  - `read_only`：仅 read 工具（risk low）放行；一切 write/shell 拒绝；
  - `workspace_write`：工作区内写放行；非白名单 shell 拒绝；工作区外写由 `resolveInside` 二次拒绝（tools:240–251、359–376）；
  - `full_access`：全放行（高风险仅审计说明）；
  - `auto_risk`：见 5.3。
- **拒绝路径**：写 `tool.denied`（payload 含 permission/risk/reason/arguments 截断）并回给模型可读原因（tools:200–238）；测试 permission.test:29–42、177–204。

### 5.3 auto_risk 三档与审计
- **分级**（permission.ts:95–107）：read→low；敏感写/非只读 shell→high；其余写→medium。
- **low**：自动放行，写 `permission.risk_vote`（decision=auto_allowed，含 reason）（tools:99–108；测试 :60–70）。
- **medium**：发起快速评审投票（Router + 一名非 Router 成员；规则评审者：敏感写 reject，否则 approve；多数放行）；无 ≥2 评审者 → `human_required` 拒绝（tools:81–95、124–163；测试 :44–58、:72–123）。
- **high**：`human_confirm` 拒绝，Agent 无工具可自行放行（permission.ts:150–155）；**IF-02 修复**后写 `permission.risk_vote`（decision=human_required）（tools:91–96、166–198；测试 :125–174）。
- **结果**：approved/rejected/human_required/auto_allowed 均入事件表，含 tool/risk/voters/votes/decision/result（tools:166–198、229）。

### 5.4 Full Throttle：提示注入、预算、标识、正交
- **提示**：`withFullThrottle` 追加「FULL THROTTLE MODE ENABLED…does NOT change your tool permissions, does not auto-approve any tool」（permission.ts:178–192）；开启时注入 `sendChat`（service:391）与 `runTask`（service:754），关闭后下次调用不再拼接即移除。
- **预算**：输出 `maxOutputTokens×2`（上限见 IF-06）、`reasoningEffort=max`（thinking 开启时）、任务 loop `maxSteps×2`（permission.ts:193–214；service:410–413、777–783）。
- **标识**：ChatView 头部常驻 `FULL THROTTLE` 金色徽标（App:2411–2415），与头部权限文案并列；开关在控制条（App:2569–2578），开启 toast 明示成本/延迟且「不改变工具权限」（App:637–642）——覆盖 §15.4 首次开启提示。
- **正交**：FT 是 `(workspaceId, agentId)` 的会话级 Set（service:147/462–478），不写回 Agent；门禁代码只读 `ctx.permission`，`policyCheck` 无 FT 参数（permission.ts:115）——read_only + FT 仍拒绝写入；FT 不自动批准任何工具。
- **不可被 Agent 开启**：仅 renderer IPC `session:setFullThrottle`（ipc:42 / preload:37 / main:124），无工具暴露；关闭/重启后不恢复（§15.4 边界）。
- **切换工作区**：**IF-03 修复**后切换前清掉旧工作区 FT（App:459–495），避免服务端仍注入而 UI 归零。

### 5.5 持久化与审计事件
- **持久化**：`Agent.permission`、`Agent.model` 入库（store:57/570）；刷新/重启后 `getSnapshot`（service:339–350）返回一致状态，UI 绑定快照。**FT 按设计不持久化**（会话级 Set），重启或切工作区即失效——与 §15.4 一致。
- **事件**：
  - `agent.permission_changed`（from/to，service:307–315）
  - `agent.model_changed`（from/to，service:316–324）
  - `session.full_throttle_changed`（agentId/enabled，service:467–473）
  - `tool.denied`（permission/risk/reason/args，tools:200–238）
  - `permission.risk_vote`（auto_allowed / approved / rejected / human_required；含 voters/votes/decision/result，tools:99–108/166–198/229）
- **审计完整性修复（IF-02）**：原实现只在拒绝时写风险投票事件，中风险放行与高风险 human_required 缺失；现已补齐并有回归测试。

### 5.6 与 Dock/对话/任务/设置链路无回归
- **Dock**：控制条位于 ChatView（dock `chat` 面板，App:1107 起 renderPanel），Dock 相关模块本轮零改动；面板内滚动/折行正常（styles:3245 起，窄窗 wrap）。
- **对话**：模型/权限/FT 均绑定 Router；发送/停止、流式、上下文面板、C14 返回链路未变；控制条 busy 禁用避免并发切换。
- **任务**：`runTask` 构造 `toolContext.permission = agent.permission`（service:750），loop 每次工具调用走同一门禁（loop.ts:122）；端到端用例显式授予 Builder `workspace_write` 后通过（service.test:189–222），新成员默认 read_only 的语义已由测试固定。
- **设置**：模型列表/提供方配置未改动；成员编辑弹窗新增权限 select（IF-04），`updateAgent` 校验/事件复用既有链路；dirty 关闭确认包含权限变更。
- **其他**：侧栏/星图/Modal/Toast/深链零改动；测试 61/61（含 deeplink 13、星图 5）。

---

## 6. 集成发现与处理

### 已修复（代码变更，发生在 t54 之后，已披露）

| 编号 | 严重度 | 问题 | 修复 | 证据 |
|------|--------|------|------|------|
| IF-01 | **高（安全）** | 只读 shell 白名单是前缀匹配，`git status && git push`、`ls; rm -rf .`、`cat x \| curl` 等会被判为 low，从而在 `workspace_write` 与 `auto_risk` 低风险路径**直接执行任意命令**，违背 DESIGN §15.2「任何可能越界的命令升级为审批」 | `permission.ts:61–79`：新增组合语法黑名单（`; & \| < > \` 换行 $`）+ 词边界匹配（避免 `lsof` 命中 `ls`）；组合命令一律 false → 高风险 | permission.test:237–250（5 条组合语法 + workspace_write 拒绝 + auto_risk 判 high） |
| IF-02 | 中 | auto_risk 中风险**投票放行**与高风险 `human_confirm` 均未写 `permission.risk_vote`（仅拒绝路径写），审计不完整（§15.3 第 5 条） | `tools.ts:88–96` + `recordRiskDecision`（`:166–198`）：approved 记 voters/votes/decision/result=allowed；high 记 human_required/result=denied；与 `tool.denied` 并存 | permission.test:72–123（approved）、:125–174（human_required） |
| IF-03 | 中 | FT 为服务端会话 Set，切换工作区时 UI 重置但服务端仍生效 → 旧工作区下次对话**静默注入高预算提示且无 FT 标识** | `App.tsx:459–495`：切换前对旧 workspace/Router 调 `setFullThrottle(false)`，再刷新快照；失败不阻塞切换 | 代码走查（切工作区两入口均调用）；三命令通过 |
| IF-04 | **中高（产品闭环）** | 新成员默认 `read_only`，但全应用只有对话控制条能改 **Router** 权限；成员编辑弹窗无权限字段、`createAgent` 也不接受权限 → **新成员无法执行写任务且无 UI 可解**（任务链路实际被堵） | `TeamDashboard.tsx:20/458/536`：成员编辑弹窗新增四档权限选择（经既有 `updateAgent` 生效、写事件）；新建成员提示「默认仅查看，创建后可在成员编辑中调整」；`createAgent` 仍保持 read_only 安全默认 | 代码走查 + typecheck；service.test 既有授权路径不变 |

### 未修复（记录 / 后续项）

| 编号 | 严重度 | 问题 | 证据 | 建议 |
|------|--------|------|------|------|
| IF-05 | 中低 | 高风险 `human_confirm` 没有「批准」UI/流程：实际是硬拒绝 + 提示，人类只能改权限或手工执行，与 §15.3「必须人类确认」的字面流程有差距 | permission.ts:150–155；tools:91–96（human_required 事件） | 下一轮做一次性审批弹窗（批准后仅执行该动作，不升权限），或把措辞改为「需人工介入」 |
| IF-06 | 低 | FT 输出预算公式 `min(maxOutput×2, max(maxOutput, 1_000_000))`：当模型自身 maxOutput ≥ 1M 时结果不翻倍（其余 thinking/步数仍生效） | permission.ts:193–214；models 中 deepseek 系 maxOutput 接近 1M | 改为真正 ×2（或按 provider 上限单独配置），并在实现文档说明上限 |
| IF-07 | 低 | `auto_risk` 低风险读操作每次调用都写 `permission.risk_vote` 事件（读工具密集任务会放大事件表） | tools:99–108 | 改为按 run 聚合/采样，或仅在非 read 工具记录 |
| IF-08 | 低 | `workspace_write` 的策略层不拒绝敏感路径写（`classifyRisk=high` 但该档只拦 shell）；工具层 `DENIED_READ` 仅按 basename 拦 `.env/.env.local/.env.production/id_rsa/id_ed25519/credentials.json`，`.ssh/` 等其他敏感文件仍可写 | permission.ts:118–129；tools.ts:24/368–370 | 下一轮把敏感路径升级纳入 `workspace_write` 策略（与 t54 观察一并裁决） |
| IF-09 | 信息 | FT 键为 `(workspace, agent)`：Router 的 FT 不会传播给 worker 的任务执行（只影响 Router chat / Router 本人任务） | service:147/381/737 | 与「会话级」语义一致；若期望团队级 FT，需产品明确后改键 |
| IF-10 | 低 | 新建成员弹窗不能直接选权限（默认 read_only），需创建后再编辑 | TeamDashboard:536–556 | 下一轮加创建时权限选择（store/service 已支持 patch，仅需 createAgent 透传） |
| IF-11 | 低（验证） | t54 声称「read_only + FT 写入拒绝有单测」，但现有测试无 FT×权限组合专测（正交性由代码结构保证） | permission.test:252–276 仅测提示/预算 | 补一条「FT 开启时 policyCheck 不变」的回归或修正措辞 |
| IF-12 | 信息 | 中风险「快速评审」是确定性规则投票（Router+1 成员），非敏感工作区写恒 approve——`auto_risk` 中风险近似自动放行（P0 可审计降级） | tools:124–163；t53 取舍 #1 | 保持 P0；后续换真 poll 时复用 `permission.risk_vote` 结构 |

---

## 7. 限制与人工冒烟

- 无 Playwright/e2e：模型是否真的换成新端点模型、流式输出、真实 shell 拒绝的人工确认需手测；本验收以「代码路径 + 单测 + 三命令 + DESIGN 对照」为准。
- **人工冒烟（10 项）**：
  1. 控制条显示模型/权限/满血模式；窄窗折行不遮挡输入；键盘可达。
  2. 切换模型 → toast「下一条消息生效」；下一条回复确实由新模型产生（看 provider/日志）。
  3. 权限切 read_only → 运行需要写文件的任务：`tool.denied`、模型收到拒绝原因；切 workspace_write 后通过。
  4. workspace_write：非白名单 shell（`pnpm install`）拒绝；只读 shell（`git status`）放行；工作区外路径写入被 `resolveInside` 拒绝。
  5. auto_risk：低风险读放行 + auto_allowed 事件；中风险审批事件 approved（≥2 评审者）；删到只剩 1 名成员时中风险 human_required 拒绝。
  6. auto_risk 高风险（非只读 shell / 敏感写）→ human_required 拒绝，事件完整。
  7. FT 开启 → 徽标常驻 + 成本提示；read_only + FT 写仍拒绝；关闭 → 徽标消失、下一条不再注入。
  8. 重启应用：权限/模型保持；FT 关闭（不恢复）。切换工作区：旧工作区 FT 不残留（IF-03）。
  9. 成员编辑弹窗改权限（四档）→ 事件/刷新一致；新建成员默认 read_only + 提示；任务写操作在改权限后可用。
  10. Dock：对话面板内控制条与其他面板互不影响；Modal/Toast、侧栏、深链、星图无回归。

---

## 8. 后续项

1. **Captain 裁决**：IF-05（高风险人工批准流程）与 IF-08（workspace_write 敏感路径策略）建议下一轮评审排期。
2. **下一轮补齐**：IF-06 预算公式、IF-07 审计聚合、IF-10 创建时权限选择、IF-11 组合回归测试。
3. **产品语义**：IF-09（FT 团队级 vs 成员级）、IF-12（auto_risk 中风险规则投票）如需升级为真投票，复用现有事件结构即可。
4. **UI 文案**：Router chat 不执行工具（t53 取舍 #4）建议在控制条/帮助处加一句说明，避免用户误以为切换 Router 权限会立即影响任务执行成员。

---

## 9. 文件清单与变更记录

- **t53 新增/修改**：`src/kernel/permission.ts`（新增）、`src/shared/types.ts`、`src/shared/copy.ts`、`src/kernel/tools.ts`、`src/kernel/store.ts`、`src/kernel/service.ts`、`src/shared/ipc.ts`、`electron/preload.ts`、`electron/main.ts`、`src/App.tsx`、`src/styles.css`、`src/kernel/service.test.ts`、`src/kernel/permission.test.ts`（新增 12 项）
- **t55 集成修复**：`src/kernel/permission.ts`（IF-01）、`src/kernel/tools.ts`（IF-02）、`src/App.tsx`（IF-03）、`src/TeamDashboard.tsx`（IF-04）、`src/kernel/permission.test.ts`（+3 项回归）、`docs/team/chat-controls-final.md`（本文件）
- **生成物（不手工修改）**：`dist/`、`dist-electron/`
- **变更记录**：
  - t53：按 DESIGN §15 实现对话控制条/四档权限/auto_risk/FT（58 测试）
  - t54：评审 verdict=pass（8/8 acceptance）
  - t55：修复 IF-01（shell 组合绕过）、IF-02（风险审计缺口）、IF-03（FT 切工作区残留）、IF-04（成员权限编辑）；最终 61/61 三命令通过
