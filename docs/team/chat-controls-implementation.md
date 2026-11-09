# 对话控制条实现映射 · t53（权限 / 模型 / 满血模式 / mika）

- **实现人**：mika（Frontend Engineer: layout）
- **依据**：DESIGN.md §15（15.2 权限模式 / 15.3 自动风险投票 / 15.4 满血模式 / 15.5 控制条 / 15.6 API / 15.7 验收）
- **验证**：`pnpm typecheck` ✅ · `pnpm build` ✅ · `pnpm test` 58/58 ✅（新增 `src/kernel/permission.test.ts` 12 项：纯函数 9 + 执行层门禁 3）

## 改动文件
- `src/shared/types.ts`：`PermissionMode` 类型 + `Agent.permission` + `UpdateAgentInput.permission`
- `src/shared/copy.ts`：`PERMISSION_LABELS / PERMISSION_DESCRIPTIONS / PERMISSION_MODES`（中文文案单一来源）
- `src/kernel/permission.ts`（新增）：Tool Registry 风险标注（TOOL_RISK 17 工具）、只读 shell 白名单、`classifyRisk`（敏感路径→high、非只读 shell→high、工作区写→medium、读→low）、`policyCheck` 硬门禁、`FULL_THROTTLE_PROMPT`/`withFullThrottle`/`fullThrottleBudget`
- `src/kernel/tools.ts`：`ToolContext.permission`；`ToolRegistry.execute` 每次调用前硬门禁——拒绝写 `tool.denied` 事件并回给模型；auto_risk 低风险放行写 `permission.risk_vote(auto_allowed)`；中风险 `runQuickVote`（Router + 一名其他成员的**规则评审者**投票，多数放行，无 quorum 升级人类）；高风险 `human_confirm` 拒绝
- `src/kernel/store.ts`：agents 表 `permission` 列（新库默认 workspace_write 兼容存量；ALTER 迁移保留既有行为）、`createAgent` 新成员默认 **read_only**（§15.2 安全默认）、`updateAgent` 支持 permission
- `src/kernel/service.ts`：`updateAgent` 校验 + `agent.permission_changed`/`agent.model_changed` 专项审计事件；`setFullThrottle/isFullThrottle`（会话级 Set，不持久化）；`sendChat`/`runTask` 满血模式注入（system prompt + 输出翻倍/思考拉满/步数翻倍）与 `toolContext.permission` 传递
- `src/shared/ipc.ts` + `electron/preload.ts` + `electron/main.ts`：`setFullThrottle` IPC（`session:setFullThrottle`）
- `src/App.tsx`：ChatView 控制条 props 与 handlers（`handleChatControlUpdate` 失败保留原值 + toast；`handleFullThrottleChange`）；修 `handleUpdateAgent` 无 name 时的 toast 文案
- `src/styles.css`：`.chat-controls` 控制条（wrap、窄窗折行）、`.ft-badge` FULL THROTTLE 标识、focus-visible
- `src/kernel/service.test.ts`：端到端用例显式授予 Builder `workspace_write`（新默认 read_only 的语义更新）

## 验收项 → 实现

1. **控制条**：输入框下方 `[模型 ▾] [权限 ▾] [满血模式 ○]`；模型选项含 provider 名 +「默认模型」；权限四档带一句说明（title）；选中即生效 + toast。
2. **模型切换**：写入 Router 的 `Agent.model`（复用 updateAgent 校验在配置列表内）；`sendChat` 每次都 `resolveModelProfile(settings, router.model)` → 下一条消息实际使用新模型。
3. **权限持久化 + 硬门禁**：`Agent.permission` 入库；read_only 拒绝一切 write/shell 工具（含只读 shell——§15.2 表格 read_only 拒绝所有 shell）；workspace_write 拒绝非只读 shell（`pnpm install`/`rm`/`git push` 等不在白名单）、工作区内写放行（工具层另有 `resolveInside` 防路径逃逸，工作区外写入天然被拒）；full_access 全放行（高风险仍审计）。
4. **auto_risk**：低风险自动放行（审计 `permission.risk_vote/auto_allowed`）；中风险快速评审投票（2 名规则评审者：Router + 一名其他成员，多数放行，票数/决定入 `permission.risk_vote` 事件；无第二成员 → 无 quorum 升级人类拒绝）；高风险（非只读 shell、敏感路径写入）`human_confirm` 拒绝——Agent 无工具可自行放行。
5. **满血模式**：开启 → `withFullThrottle` 注入高预算/no-holds-barred 系统提示（明示「不改变工具权限」）+ 预算覆盖（maxOutputTokens×2、thinking=max、agent loop maxSteps×2）；面板头常驻 `FULL THROTTLE` 金色标识；不触碰 permission 字段、不自动批准任何工具、门禁逻辑对 FT 零感知（正交）。
6. **正交性**：权限检查在 `ToolRegistry.execute` 最前，与 FT 无交集——read_only + FT 仍拒绝写入（policyCheck 不读 FT 状态）；关闭 → `withFullThrottle` 不再拼接，注入即移除。
7. **审计与一致性**：`agent.permission_changed`/`agent.model_changed`/`session.full_throttle_changed`/`tool.denied`/`permission.risk_vote` 均写 events 表；权限/模型持久化于 agents 表，刷新后快照一致；FT 会话级不随启动恢复（§15.4 边界，有意为之）。
8. **窄窗/键盘/ARIA**：控制条 flex-wrap 窄窗折行不遮挡输入；原生 select/checkbox 键盘可达 + aria-label/aria-pressed + focus-visible；开关 title 提示「不改变工具权限」。
9. **Agent 不能自行开启 FT / 改权限**：无任何工具暴露 permission/FT 写路径；FT 仅 `session:setFullThrottle` IPC（renderer 用户操作）。
10. **验证**：typecheck 0 错误；build 成功（electron preload/main 重打包）；test 8 文件 58/58。

## 实现取舍（记录，供评审）
1. **§15.3 真·异步投票未做**：中风险「快速评审投票」用**规则评审者**（Router+1 成员的确定性规则投票，可审计可解释）同步完成，而非发起 LLM 异步 poll——P0 工具回路是同步的，异步投票需挂起/恢复机制；`permission.risk_vote` 事件结构已按 §15.6 预留 voters/votes/decision，后续可换真 poll。
2. **§15.2 「新成员默认 read_only」已遵循**，存量库迁移默认 workspace_write（保持既有团队行为不突变）；端到端测试相应更新为显式授权。
3. **read_only 拒绝所有 shell**（含只读命令）——严格按 §15.2 表格「拒绝所有 shell」；只读 shell 白名单仅用于 workspace_write/auto_risk-low。
4. **对话（Router chat）当前不执行工具**：sendChat 无工具回路，权限对 Router 立即生效于「任务执行成员」；控制条展示/切换/审计链路完整，Router 一旦接入工具即受同一门禁约束。
5. **模型下拉切换失败保留原值**：updateAgent 校验失败 → 快照未变 + 错误 toast，UI 回退由快照驱动。

---

## t58 修复记录：IF-05 高风险人工审批 + IF-08 敏感路径策略层（sol，2026-11-10）

- **修复人**：sol（DeepSeek 席位；模型路由 `deepseek-official/deepseek-flash`）
- **任务**：t58（repair；上游 t55 集成遗留 IF-05 / IF-08）
- **范围**：`src/`、`docs/team/`；未改 `dist/`、`dist-electron/`（build 产物仅本地验证）
- **验证**：`pnpm typecheck` ✅ 0 错误 · `pnpm build` ✅ 0（284 modules，js 904.68 kB / gzip 245.40 kB，electron main 863.2kb） · `pnpm test` ✅ 9 文件 95/95（新增 `approval.test.ts` 9 项 + `permission.test.ts` 25 项 IF-08 断言）

### IF-05：auto_risk 高风险 → 可操作的人类审批 UI（单次生效）

链路（主进程与 renderer 的边界）：

1. **触发**：`ToolRegistry.execute` 每次调用前 `policyCheck`；`auto_risk` + 高风险（敏感路径写 / 非只读 shell）→ `action: "human_confirm"`（`permission.ts`）。
2. **请求**：仅当 `agent.permission === "auto_risk"` 时，`service.runTask` 才向 `ToolContext` 注入 `requestApproval`（Agent 的工具参数里没有审批能力）；`service.requestRiskApproval` 生成一次性 `requestId`，写入内存 `pendingApprovals`，120s 定时器兜底，并推送给 renderer。
3. **IPC**：`electron/main.ts` → `risk:approval`；renderer `App.tsx` 订阅后入 FIFO 队列弹窗（风险等级/原因/成员/任务/工具/目标 + 批准/拒绝）；`electron/preload.ts` 暴露 `onRiskApproval` / `respondRiskApproval`；回执走 `risk:approval_response` → `service.respondRiskApproval`。
4. **一次性消费**：`respondRiskApproval(requestId, approved)` 只对存在且未超时的 requestId 生效；第二次调用返回 `false`（测试覆盖）。批准只影响当前这次工具调用，不写回 `Agent.permission`、不产生缓存批准。
5. **审计**：批准 → `permission.risk_vote { decision: "human_approved", result: "allowed", target, voters: ["human"] }`；拒绝 → `human_denied`；超时/无回调兜底 → `human_required`；拒绝/超时同时写 `tool.denied`（`tools.ts`）。
6. **UI 一致性**：App 用共享常量 `RISK_APPROVAL_TIMEOUT_MS`（`src/shared/approval.ts`，120s）在弹窗上自动超时收起并 toast；若回执返回 `false`（已超时/已消费）明确提示「审批已失效，操作未执行」，绝不误报成功；Esc/关闭 = 拒绝（安全默认）；刷新/重开会话时 renderer 队列清空，主进程 pending 到期按 `human_required` 解析，不残留批准。
7. **Agent 无自行批准路径**：工具清单中不存在审批/权限类工具（测试断言）；`requestApproval` 只能由主进程注入，回执只能来自 renderer IPC。

### IF-08：workspace_write / auto_risk 敏感路径统一拦截（按路径段，不依赖 basename）

- **策略层**（`src/kernel/permission.ts`）：`isSensitivePath` 按路径段匹配
  `.ssh/`、`.aws/`、`.gnupg/`、`.kube/`、`.docker/`、dotenv 族（`.env` / `.env.*` / `.envrc` / `.envrc.*`）、`id_rsa/id_dsa/id_ed25519/id_ecdsa` 前缀、`*.pem/*.key/*.p12/*.pfx/*.jks`、`credentials.json/known_hosts/authorized_keys/.netrc/.npmrc/.git-credentials/.pypirc`、`.git/hooks/`；
  Windows 反斜杠统一归一化。`workspace_write` 对敏感写入 **直接拒绝**；`auto_risk` 对敏感写入判 **high → 人类审批**；`full_access` 仍放行。
- **审计**：`full_access` 高风险放行时由 `ToolRegistry` 追加 `permission.risk_vote { decision: "full_access_allowed", result: "allowed" }`（此前只有 reason 文案、无事件）。
- **工具层纵深防御**：`fs.read` 用 `isSensitivePath` 拦截 `.ssh/config` 这类 basename 看不出的敏感文件（不再只靠 basename）；`fs.write` 的敏感路径在「无权限上下文 / read_only / workspace_write」下也做工具层拒绝，但 auto_risk（已获人类批准）与 full_access 放行由策略层/审批层裁决——避免工具层把已批准或 full_access 的调用误杀。
- **兼容**：组合 shell 黑名单（IF-01）未改动，`git status && git push` / `ls; rm -rf .` / 管道 / `$()` 仍判高风险（原测试保留）。

### 文件变更（t58，完整清单，跨 attempt 1–3）

> t58 的 structured `changedPaths`（attempt 3）只列了该 attempt 实际触碰的文件；下表补全 t58 三个 attempt 合计的真实改动文件与范围，供评审/集成按"完整集合"核对，而不是只看部分 changedPaths。

| 文件 | attempt | 说明 | t58 inScope |
|---|---|---|---|
| `src/shared/approval.ts`（新） | 3 | 主进程/renderer 共享 120s 审批超时常量 | ✅ `src/` |
| `src/shared/types.ts` | 1/2 | `RiskApprovalRequest`、`PermissionMode` 相关类型 | ✅ `src/` |
| `src/shared/ipc.ts` | 1/2 | `onRiskApproval` / `respondRiskApproval` IPC 面 | ✅ `src/` |
| `electron/preload.ts` | 1/2 | 暴露审批订阅/回执 API | ⚠️ **例外**：t58 契约为 `src/`、`docs/team/`；审批回执必须跨进程，故改动 `electron/`，需在评审/集成记录显式接受 |
| `electron/main.ts` | 1/2 | `risk:approval` 推送、`risk:approval_response` handler | ⚠️ **例外**：同上 |
| `src/styles.css` | 1/2 | `.risk-approval*` 审批弹窗样式 | ✅ `src/` |
| `src/kernel/permission.ts` | 1/2 + 3 | 敏感路径段判定、workspace_write 拒绝、auto_risk high | ✅ `src/` |
| `src/kernel/tools.ts` | 1/2 + 3 | 审批单次生效、human_approved/human_denied/human_required 审计、`full_access_allowed` 审计、工具层纵深防御 | ✅ `src/` |
| `src/kernel/service.ts` | 1/2 + 3 | `requestRiskApproval` / `respondRiskApproval` / pending 超时 | ✅ `src/` |
| `src/App.tsx` | 1/2 + 3 | 审批 FIFO 队列 + 弹窗 + 超时收起 | ✅ `src/` |
| `src/kernel/permission.test.ts` | 3（+t61） | IF-08 路径策略与 dotenv 族断言 | ✅ `src/` |
| `src/kernel/approval.test.ts`（新） | 3 | 审批生命周期测试 | ✅ `src/` |
| `docs/team/chat-controls-implementation.md` | 3（+t61） | 本修复记录 | ✅ `docs/team/` |

- **范围结论**：除 `electron/preload.ts`、`electron/main.ts` 两处 IPC 桥接外，其余改动均在 t58 契约的 `src/` / `docs/team/` 内。`dist/`、`dist-electron/` 未纳入改动范围（仅 build 命令本地生成，验证用）。
- **给评审/集成**：如需严格执行 t58 inScope，请在上述两处 IPC 文件上显式标注"例外接受（IF-05 跨进程必需）"，而不是把它们当作越界未披露改动；本表即完整披露依据。

### 验收项 → 证据

1. **IF-05 有可操作的人类批准/拒绝 UI**：`App.tsx` 审批 Modal（风险等级/成员/任务/工具/目标/原因 + 批准/拒绝），主进程 `risk:approval` ↔ renderer `risk:approval_response`；见 `approval.test.ts` 服务端回执用例。
2. **批准只对该次调用生效、拒绝/超时写 human_denied/human_required、Agent 无自行批准路径**：`approval.test.ts` 断言两次调用触发两次审批；`human_approved` / `human_denied` / `human_required` 事件；工具清单无审批工具。
3. **IF-08 策略层统一拦截敏感路径**：`permission.test.ts` 24 条敏感路径（含 `.ssh/config`、`.aws`、`.gnupg`、dotenv 族 `.env*/.envrc*`、私钥/PEM/KEY/P12、git hooks、Windows 路径）逐条断言 `workspace_write` 拒绝、`auto_risk` 升级 human_confirm；另有 dotenv 族专项用例（workspace_write 拒绝 `.envrc/.envrc.local`、auto_risk high/human_confirm、full_access 放行并写 `full_access_allowed`）；普通路径不受影响。
4. **full_access 仍放行并审计**：`approval.test.ts` 断言 `full_access` 写入 `secrets/.env.local` 成功且写 `full_access_allowed` 事件。
5. **IF-01 / FT 正交**：原组合 shell 测试全部保留通过；`approval.test.ts` 断言 `read_only` 写入仍拒绝、FT 预算对象不含 permission 字段。
6. **权限/风险事件与 UI 状态一致、刷新/重开会话不残留批准**：服务端 `pendingApprovals` 一次性消费 + 超时解析（测试）；renderer 队列内存态 + 超时自动收起 + `false` 回执提示；刷新后 renderer 无残余弹窗，主进程按 human_required 处理。
7. **三命令**：见文首验证行。

### 已知边界（不阻塞）

- 审批超时固定 120s（共享常量）；如需可配置，后续加设置项。
- 审批队列在 renderer 内 FIFO 串行展示；多个高风险调用并发时后到请求等待前一个处理（各自 120s 超时独立计时）。
- Router 对话仍不执行工具（t53 边界），审批链路只覆盖任务执行成员；Router 接入工具后复用同一门禁。
- 工具层 `fs.read` 对敏感路径一律拒绝（含 full_access），与 t53 的 secret 读取保护一致；如产品要求 full_access 可读 secret，需单独评审。
- 无 React 组件级自动化测试（项目暂无 React Testing Library 依赖）；审批弹窗交互列入人工冒烟：开启 auto_risk → 让成员执行一次敏感写入 → 弹窗出现 → 批准执行/拒绝不执行/等待 120s 超时收起。

### t61 补记：dotenv 族覆盖 + t58 实际改动文件/范围（2026-11-10）

- **dotenv 族**：`isSensitivePath` 的路径段规则从 `.env` / `.env.*` 扩展为 dotenv 族前缀（`.env` / `.env.*` / `.envrc` / `.envrc.*`），覆盖 `.envrc`、`.envrc.local`、`config/.envrc` 等 direnv 配置，避免"只覆盖 .env.* 而漏掉 .envrc"。
- **新增测试**（`src/kernel/permission.test.ts`）：
  - 敏感路径 `it.each` 增加 `.envrc` / `.envrc.local` / `config/.envrc`；
  - auto_risk 升级 human_confirm 的循环加入 `.envrc` / `.envrc.local`；
  - 专项用例：workspace_write 对 `.envrc/.envrc.local` 拒绝、auto_risk 判 high/human_confirm、full_access 放行，并通过 `ToolRegistry` 真实执行 `.envrc` 写入，断言 `permission.risk_vote { decision: "full_access_allowed", result: "allowed" }` 审计事件。
- **验证**：`pnpm typecheck` ✅ 0 · `pnpm build` ✅ 0（284 modules，dist js 904.68 kB / gzip 245.40 kB，electron main 863.2kb） · `pnpm test` ✅ 9 文件 **99/99**（`permission.test.ts` 44 项，含新增 dotenv 断言）。
- **范围与例外（承接 t58）**：t58 实际改动文件的完整清单见上方表格（含 `src/shared/types.ts`、`src/shared/ipc.ts`、`electron/preload.ts`、`electron/main.ts`、`src/styles.css`）；其中 `electron/preload.ts`、`electron/main.ts` 是 t58 `src/` inScope 的 **例外**（IF-05 审批必须跨进程），需在评审/集成记录中显式标注"例外接受（跨进程必需）"；t58 attempt 3 的 structured `changedPaths` 只列该 attempt 触碰的 8 个文件，完整集合以上表为准。t61 本身只改 `src/kernel/permission.ts`、`src/kernel/permission.test.ts`、本文件。


