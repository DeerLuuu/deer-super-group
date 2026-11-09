# 权限安全补丁 · 最终集成验收报告（t60）

- **场次**：对话权限、模型切换与满血模式（DESIGN §15）的后续安全补丁｜2026-11-10
- **任务**：t60 [integration] 集成验收（in scope：`src/`、`docs/team/`；out of scope：`dist/`、`dist-electron/`）
- **集成人**：max（QA / Release Reviewer — GLM 席位 vale 的 DeepSeek 替代；模型路由 `deepseek-official/deepseek-flash`）
- **输入**：
  - 实现/修复：t58（sol，attempt 3）IF-05 高风险人工审批 UI + IF-08 敏感路径策略层；t61（sol）repair-round-2
  - 评审：t59（aria）首轮 **needs_revision**（F1 medium / F2 low）→ t61 修复 → t62（aria）复审 **verdict=pass**
  - 设计：`DESIGN.md` §15（15.2 权限 / 15.3 auto_risk / 15.4 Full Throttle / 15.6 API / 15.7 验收）
  - 修复记录：`docs/team/chat-controls-implementation.md`（t58 记录 + t61 补记）
- **验证**：`pnpm typecheck` / `pnpm build` / `pnpm test`（3 命令实跑，见 §4）+ 独立策略探针 + 新增端到端审批回归（`src/kernel/approval-wiring.test.ts`，2 项）

---

## 1. 最终结论

| 验收点 | 结果 | 依据 |
|--------|------|------|
| t59 评审通过（经修复） | ✅ | t59 首轮 needs_revision（F1 dotenv `.envrc` 漏拦 / F2 changedPaths 记录不一致）→ t61 修复 → **t62 verdict=pass、4/4 acceptance passed**；t60 依赖 t62。t62 同时显式接受 t58 的 `electron/preload.ts`、`electron/main.ts` 跨进程例外 |
| 高风险人工审批 UI 可用，批准单次生效，拒绝/超时审计完整 | ✅ | `App.tsx:1339–1406` 审批 Modal（风险等级/成员/任务/工具/目标/原因 + 批准/拒绝，Esc=拒绝）；`service.ts:498–554` 一次性 requestId + 120s 超时；仅 `auto_risk` 注入回调（`service.ts:828–837`）；`tools.ts:123–170` 写 `human_approved` / `human_denied` / `human_required` + `tool.denied`；`approval.test.ts` 9 项 + 新增 `approval-wiring.test.ts` 2 项（真实接线） |
| 敏感路径策略层拦截生效，full_access 仍放行并审计 | ✅ | `permission.ts:91–139` 按路径段覆盖 `.ssh/.aws/.gnupg/.kube/.docker`、dotenv 族 `.env/.env.*/.envrc/.envrc.*`、私钥/PEM/KEY/P12/PFX/JKS、credentials/known_hosts/authorized_keys/.netrc/.npmrc/.git-credentials/.pypirc、`.git/hooks/`；`workspace_write` 拒绝（`permission.ts:185–196`）、`auto_risk` 判 high→人类审批、`full_access` 放行；`tools.ts:196–203` 补 `full_access_allowed` 审计 |
| IF-01 组合 shell 拦截不回退；read_only+FT 仍拒绝写入 | ✅ | `permission.ts:67–78` 组合语法黑名单保留；探针 10 条攻击命令全部判高风险、6 条合法只读命令放行；`permission.test.ts:240–252` 原用例通过；FT 仅提示/预算（`permission.ts:241–272`），`policyCheck` 无 FT 参数、`tools.ts` 零 FT 引用；read_only+FT 写入仍 `denied`（探针 + `permission.test.ts:378–401`） |
| 与 Dock/对话/任务/设置链路无回归 | ✅ | 10 文件 / 101 用例全过（deeplink 13、星图 5、任务 E2E 7、Markdown 2、模型 8+10）；typecheck/build 0；t58/t61 完整改动文件表不含 Dock/deeplink/星图/设置模块；`App.tsx:1159–1168` Dock 渲染、`:2641–2689` 对话控制条、`TeamDashboard.tsx:536–556` 成员权限选择均在位 |
| typecheck / build / test 全部通过 | ✅ | 最终 exit 0/0/0（§4）：typecheck 无错误；build 0（最终 285 modules）、js 904.48 kB（gzip 245.32 kB）；test 10 文件 101/101 |
| `docs/team/chat-controls-permission-final.md` 输出修复与验证摘要 | ✅ | 本文件 |

**额外说明**：
- 本轮**未修改任何生产代码**；仅新增 1 个集成回归测试文件 + 本报告。t58/t61 的修复在最终代码中复核成立。
- t59 的 F1 与 F2 均经 t61 修复并在 t62 复验；t60 未发现新的阻断缺陷（§6 记录 8 项非阻断观察与后续项）。
- t58 文档声明的 `electron/preload.ts`、`electron/main.ts` 属 `src/, docs/team/` 契约例外（高风险审批必须跨进程 IPC）；t61 已在文档完整披露，t62 已接受，本集成轮再次确认该例外**仅限审批 IPC 桥接**，无其他越界改动。

---

## 2. 交付与实现映射

| 区域 | 文件 / 行 | 交付要点 |
|------|-----------|----------|
| 风险分级/策略 | `src/kernel/permission.ts:148–156`（classifyRisk）、`:168–237`（policyCheck） | 敏感写→high、非只读 shell→high、其余写→medium、读→low；四档权限硬门禁 |
| 敏感路径判定 | `src/kernel/permission.ts:91–139` | 按路径段匹配（含 Windows `\` 归一化），不依赖 basename；dotenv 族含 `.envrc/.envrc.local` |
| 只读 shell 黑名单 | `src/kernel/permission.ts:34–78` | 白名单前缀 + 组合语法黑名单（`; & \| < > \`` 换行 `$`）+ 词边界（`lsof` 不命中 `ls`） |
| 审批生命周期 | `src/kernel/service.ts:498–554` | `requestRiskApproval` 一次性 requestId、内存 `pendingApprovals`、120s 超时、监听推送；`respondRiskApproval` 一次性消费（二次/超时后返回 false） |
| 审批注入边界 | `src/kernel/service.ts:815–838` | 仅 `agent.permission === "auto_risk"` 才注入 `ToolContext.requestApproval`；Agent 工具清单无审批/权限工具 |
| 执行层门禁 | `src/kernel/tools.ts:108–204` | 每次 `execute` 前 `policyCheck`；`human_confirm` → 人类审批（`:123–170`）；拒绝/超时写 `tool.denied`；低风险 `auto_allowed`；`full_access` 高风险审计（`:196–203`） |
| 审批 IPC | `src/shared/ipc.ts:44–48`、`electron/preload.ts:40–48`、`electron/main.ts:127–133` | `risk:approval` 推送 / `risk:approval_response` 回执；preload 暴露 `onRiskApproval`、`respondRiskApproval` |
| 审批 UI | `src/App.tsx:133–136`（FIFO 队列）、`:410–466`（订阅/超时/回执）、`:1339–1406`（Modal） | 风险/成员/任务/工具/目标/原因；批准/拒绝；Esc/关闭/遮罩=拒绝（安全默认）；120s 自动收起并 toast；回执 `false` 提示「审批已失效，操作未执行」 |
| 共享超时 | `src/shared/approval.ts:1–8` | 主进程与 renderer 共用 `RISK_APPROVAL_TIMEOUT_MS = 120_000`，避免「主进程已拒绝但 UI 仍可批准」 |
| 工具层纵深防御 | `src/kernel/tools.ts:428–434`（fs.read）、`:459–473`（fs.write） | fs.read 按敏感路径拒绝；fs.write 在「无权限/read_only/workspace_write」下拒绝敏感路径，auto_risk（已批准）/full_access 交由策略层与审批层裁决 |
| 类型/样式 | `src/shared/types.ts:28–43`；`src/styles.css`（`.risk-approval` 弹窗样式） | `RiskApprovalRequest`；审批弹窗样式 |
| 测试 | `src/kernel/permission.test.ts`（44 项）、`src/kernel/approval.test.ts`（9 项）、`src/kernel/approval-wiring.test.ts`（2 项，t60 新增） | 策略矩阵/审批生命周期/端到端接线 |
| 文档 | `docs/team/chat-controls-implementation.md`（t58/t61 记录）、本文件 | 实现与验证摘要 |

---

## 3. 评审与修复流转

| 阶段 | 结果 |
|------|------|
| t58（sol，attempt 3） | IF-05 审批链路（主进程 requestId/120s、renderer 弹窗、IPC、单次消费、三类审计）；IF-08 敏感路径按路径段拦截 + `full_access_allowed` 审计；95/95 测试 |
| t59（aria，评审 1） | **needs_revision**：F1（medium）`isSensitivePath` 漏 `.envrc/.envrc.local`，`workspace_write` 放行、`auto_risk` 仅 medium 投票；F2（low）t58 最终 changedPaths 未列 electron IPC/types/ipc/styles，与文档记录不一致 |
| t61（sol，repair 2） | F1：dotenv 族改为 `.env / .env.* / .envrc / .envrc.*`（`permission.ts:104–113`），补 `.envrc/.envrc.local/config/.envrc` 断言与 full_access 真实执行 + 审计用例；F2：文档补跨 attempt 1–3 完整文件表并披露 electron 两文件为 inScope 例外；99/99 测试 |
| t62（aria，评审 2） | **verdict=pass**：F1/F2 均已修复，4/4 acceptance passed；显式接受 `electron/*` 跨进程例外；三命令实跑 0/0/0（99/99） |
| t60（max，集成） | 复核最终代码 + 独立探针 + 三命令；未发现阻断缺陷；新增审批端到端回归 2 项；本报告 |

**t58 例外接受记录**：`electron/main.ts`、`electron/preload.ts` 是 IF-05 审批跨进程 IPC 的必需改动（t58 契约为 `src/`、`docs/team/`）。t61 已在实现文档完整列出全部跨 attempt 文件，t62 明确接受；本集成轮按同一结论记录为「例外接受（跨进程必需）」，不视为未披露越界。

---

## 4. 最终验证（实跑）

### 4.1 三条命令（实跑）

| 命令 | 结果 | 退出码 | 关键输出 |
|------|------|--------|----------|
| `pnpm typecheck` | ✅ | 0 | `tsc --noEmit` 无错误输出 |
| `pnpm build` | ✅ | 0 | 首轮（基线 294090d + t60 测试，无并行 UI 提交）：284 modules、`css 42.29 kB (gzip 8.46)`、`js 904.68 kB (gzip 245.40)`；最终轮（HEAD `d4c2a1d`）：285 modules、`css 179.55 kB (gzip 19.22)`、`js 904.48 kB (gzip 245.32)`；electron `main.cjs 863.2kb` / `preload.cjs 2.9kb` 两轮一致；chunk >500 kB 警告（既有问题，非阻断） |
| `pnpm test` | ✅ | 0 | 多轮（含最终基线 `d4c2a1d`）均 **10 文件 / 101 用例**：permission 44、deeplink 13、model 10、approval 9、models 8、service 7、TaskStarMap 5、Markdown 2、approval-wiring 2、openai 1 |

**执行顺序与基线**：

1. t62 交付树（未加 t60 测试）：9 文件 / 99 用例全过（exit 0），与 t62 记录一致。
2. 新增 `approval-wiring.test.ts`（2 项）后：typecheck 0 / build 0（284 modules）/ test 0（10 文件 101 用例）。
3. 基线切换为 `d4c2a1d` 后复跑（HEAD + t60 新增文件）：typecheck 0 / build 0（285 modules）/ test 0（101 用例）—— 权限补丁结论不变。

`dist/`、`dist-electron/` 仅为 build 产物，未手工修改，属 out of scope。

### 4.2 并行基线变更说明（非 t60 变更）

验证期间基线由仓库维护者追加了三次**不属于 t60** 的提交（均不改动权限/审批代码）：

| 提交 | 内容 | 对构建的影响 |
|------|------|--------------|
| `87a94ca` | `DockShell.tsx` +1 行 `import "dockview-react/dist/styles/dockview.css"`（Dock 库样式）；`styles.css` +69 行团队面板 `@container` 规则 | 284 → 285 modules；CSS 42.29 → 179.12 kB |
| `4e23fdb` | 移除重复侧栏导航、以 Dock 为主导航（仅 `App.tsx` / `styles.css` 的导航与配套样式） | CSS 179.38、JS 904.29 kB |
| `d4c2a1d` | 星图图例折叠为紧凑浮层（`TaskStarMap.tsx` / `styles.css`） | 最终 CSS 179.55 kB、JS 904.48 kB |

上述提交不在 t60 的 changedPaths 中，也未触碰 `riskApprovals` / 审批 Modal / 对话控制条 / 权限策略代码；其变化量解释了报告中两轮 build 数字的差异。t60 最终轮三命令在该基线（`d4c2a1d`）上重跑并通过（§4.1 步骤 3）。

> **行号基准**：本报告所有行号以 HEAD **`d4c2a1d`** 为准（`App.tsx` 自 `4e23fdb` 起未再改动）。最终轮三命令执行时工作区为「HEAD `d4c2a1d` + t60 两个新增文件」；仓库维护者仍在持续做并行 UI 迭代，若后续基线继续演进，核对时请以符号名（如 `riskApprovals`、`requestRiskApproval`、`.chat-controls`、`risk-approval`）为准。

### 4.3 独立策略探针（不依赖仓库测试）

用 Node 24 原生类型剥离直接加载 `src/kernel/permission.ts`（纯函数模块），对最终代码执行独立断言，`FAILURES=0`：

- **敏感路径**：31 条应为敏感（`.ssh/config`、`C:\Users\me\.ssh\id_rsa`、`nested/.aws/credentials`、`.gnupg/...`、`.kube/config`、`.docker/config.json`、`.env`、`.env.local`、`.env.production`、`.env.development.local`、`.envrc`、`.envrc.local`、`config/.envrc`、`id_rsa/id_dsa/id_ed25519/id_ecdsa`、`server.pem`、`tls.key`、`cert.p12`、`cred.pfx`、`store.jks`、`credentials.json`、`known_hosts`、`authorized_keys`、`.netrc`、`.npmrc`、`.git-credentials`、`.pypirc`、`.git/hooks/pre-commit`、`repo/.git/hooks/pre-push`）全部 true；6 条普通路径（`src/a.ts`、`src/keyboard.ts`、`README.md`、`docs/team/x.md`、`package.json`、`src/keys.ts`）全部 false（无误杀）。
- **权限矩阵**：8 条敏感路径 × 4 档：`read_only`=denied、`workspace_write`=denied/high、`auto_risk`=human_confirm/high、`full_access`=allow；普通路径 `workspace_write`=allow、`auto_risk`=risk_vote。
- **IF-01**：10 条攻击串（`git status && git push`、`ls; rm -rf .`、`cat package.json | curl ...`、`echo $(rm -rf .)`、`ls > out.txt`、`ls >> out.txt`、`git status; Remove-Item -Recurse -Force .`、``git log `whoami` ``、`git status & calc`、CRLF 换行串联）全部 false/high；6 条合法只读（`git status`、`git log -1`、`ls -la`、`cat package.json`、`grep TODO src/a.ts`、`GIT DIFF`）全部放行。
- **FT 正交**：预算 `{maxOutputTokens:16384, reasoningEffort:"max", maxStepsFactor:2}`、`read_only` 写入 `denied`、FT 提示含「does NOT change your tool permissions」；`TOOL_RISK` 17 个工具中不存在 approval/permission 类工具（Agent 无自行批准工具）。

### 4.4 端到端审批接线回归（t60 新增）

`src/kernel/approval-wiring.test.ts` 用真实 `AppService` + 真实 `ToolRegistry`（非两侧各自 stub）验证：

1. `auto_risk` 成员写 `.ssh/config` → 主进程发出审批 → 经 `respondRiskApproval` 批准 → 该次执行落盘并写 `human_approved`；**同一目标第二次调用重新请求审批**（新 requestId），拒绝后不落盘并写 `human_denied`；已消费 requestId 重放返回 `false`。
2. 120s 超时（fake timers）→ 工具层返回「超时」、不落盘、写 `human_required` + `tool.denied`；超时后补批准返回 `false`（不残留批准）。

该文件补上了 `approval.test.ts` 分别测试「服务端生命周期」与「工具层 stub 回调」之间的接线空白，后续作为常驻回归保留。

---

## 5. 验收链路核对

### 5.1 高风险人工审批 UI 与单次生效
- **触发**：`auto_risk` + 敏感写/非只读 shell → `classifyRisk=high` → `policyCheck action=human_confirm`（`permission.ts:216–233`）。
- **请求**：`service.runTask` 仅在 `agent.permission === "auto_risk"` 时注入 `requestApproval`（`service.ts:828–837`），`requestRiskApproval` 生成一次性 `requestId`、登记 120s 定时器并推送给 renderer 监听器（`:507–544`）。
- **UI**：renderer 订阅 `risk:approval` → FIFO 队列（后到不覆盖先到，`App.tsx:133–136/410–419`）→ Modal 展示风险等级/成员/任务/工具/目标/原因；「批准（仅本次）」「拒绝」；Esc/关闭/遮罩走 `onClose`=拒绝（`Modal.tsx:76–104`，安全默认）。
- **单次生效**：`respondRiskApproval` 只对存在且未超时的 requestId 生效，立即删除 pending 并 resolve；第二次回执返回 `false`（`service.ts:547–554`；`approval.test.ts:219–229`；`approval-wiring.test.ts` 两次调用断言）。批准不写回 `Agent.permission`、不缓存、不跨调用复用。
- **UI 一致性**：共享 120s 常量做弹窗倒计时自动收起 + toast（`App.tsx:421–439`）；回执 `false`（超时/已消费）提示「审批已失效（超时或已处理），操作未执行」，**不误报成功**（`:441–466`）；刷新/重开队列清空，主进程按 `human_required` 兜底，不残留批准。
- **Agent 无自行批准路径**：工具清单无审批/权限工具（探针；`approval.test.ts:179–183`）；`requestApproval` 只能由主进程注入，回执只来自 renderer IPC。

### 5.2 敏感路径策略层 + full_access 放行审计
- **策略层**（`permission.ts:91–139`）：按路径段判定，覆盖任务要求的 `.ssh/.aws/.gnupg/.env*/私钥/git hooks`，并额外覆盖 `.kube/.docker`、`.netrc/.npmrc/.git-credentials/.pypirc`、`known_hosts/authorized_keys/credentials.json`、`*.p12/*.pfx/*.jks`；Windows 反斜杠归一化。
- **四档行为**：`workspace_write` 直接拒绝（reason 明示可切 full_access 并留审计）；`auto_risk` 判 high → 人类审批；`read_only` 拒绝；`full_access` 放行并写 `full_access_allowed`（`tools.ts:196–203`，`permission.test.ts:306–362` 真实执行 `.envrc` 断言审计）。
- **纵深防御**：fs.read 对敏感路径一律拒绝（含 full_access，沿用 t53 secret 读取保护）；fs.write 在无权限/read_only/workspace_write 下拒绝，auto_risk（已批准）与 full_access 放行由策略层裁决，避免把已批准调用误杀（`tools.ts:428–473`）。
- **t61 修复复核**：`.envrc`、`.envrc.local`、`config/.envrc` 均 sensitive=true、`workspace_write` 拒绝、`auto_risk`=human_confirm(high)；普通 `src/a.ts` 不受影响（探针 + 测试）。

### 5.3 IF-01 组合 shell 拦截
- 只读 shell 白名单仍是前缀匹配，但任何 `; & | < > \`` 换行 `$` 组合语法直接判 false → high（`permission.ts:61–78`）；前缀落在词边界（`lsof` 不命中 `ls`）。
- 回归证据：`permission.test.ts:240–252` 原 5 条攻击断言保留通过；探针扩展 10 条（含 PowerShell `;`、反引号、CRLF）全部拦截；`workspace_write` 对组合命令拒绝、`auto_risk` 判 human_confirm。**IF-01 未回退**。

### 5.4 read_only + Full Throttle 正交
- FT 只做两件事：注入高预算提示（`withFullThrottle`，明示不改变工具权限）与预算覆盖（输出×2 / 思考 max / 步数×2，`permission.ts:241–272`）；`policyCheck` 签名无 FT 参数，`tools.ts` 全文零 FT 引用（grep 复核），门禁只读 `ctx.permission`。
- 证据：探针 `policyCheck("read_only","fs.write") = denied`；`permission.test.ts:378–401` 断言注入文本/预算/关闭即移除；`approval.test.ts:185–203` 断言 FT 预算对象不含 permission、敏感路径在 auto_risk 下仍 human_confirm、FT 不自动批准。**read_only+FT 仍拒绝写入**。

### 5.5 与 Dock / 对话 / 任务 / 设置链路无回归
- **Dock**：`App.tsx:1159–1168` DockShell 渲染与 `renderPanel` 分发保持；t58/t61 完整改动文件表不含 `src/shell/dock/*`；Dock 的 6 视图/持久化/深链测试（deeplink 13 + 星图 5）全过。
- **对话**：控制条仍在 ChatView（`App.tsx:2641–2689`，模型/权限/满血模式）；审批 Modal 位于 App 根节点（`:1339–1406`），不进入 dock 面板；流式/停止/上下文/C14 链路未改。
- **任务**：`runTask` 继续传 `toolContext.permission`，`service.test.ts` 7 项（含任务端到端）通过；高风险审批只覆盖任务执行成员（Router chat 仍不执行工具，t53 既有边界）。
- **设置**：`SettingsView` 未改；成员编辑弹窗权限选择仍在（`TeamDashboard.tsx:536–556`）；t58/t61 对 Dock/星图/设置/侧栏代码零改动（当前工作区另有并行 UI 改动，见 §4.2，不属 t60 判定范围）。
- **构建**：typecheck 0 + build 0（最终 285 modules）证明新增审批 UI/IPC 与既有渲染树、preload/main 打包兼容。

### 5.6 审计事件矩阵（最终代码）

| 场景 | `permission.risk_vote.decision` | 其他事件 |
|------|--------------------------------|----------|
| auto_risk 低风险自动放行 | `auto_allowed`（result=allowed） | — |
| auto_risk 中风险投票放行 | `approved`（result=allowed，voters/votes） | — |
| auto_risk 中风险无 quorum / 拒绝 | `human_required` / `rejected`（result=denied） | `tool.denied` |
| auto_risk 高风险人类批准 | `human_approved`（result=allowed，voters=["human"]） | — |
| auto_risk 高风险人类拒绝 | `human_denied`（result=denied） | `tool.denied` |
| auto_risk 高风险超时/无回调 | `human_required`（result=denied） | `tool.denied` |
| full_access 高风险放行 | `full_access_allowed`（result=allowed） | — |
| workspace_write 敏感写 / read_only 写入 | 无 risk_vote（仅策略拒绝） | `tool.denied` |

---

## 6. 集成发现

### 6.1 阻断缺陷
**无**。t58/t61 的 IF-05、IF-08、IF-01、FT 正交在最终代码中全部成立；三命令与独立探针均通过，未修改生产代码。

### 6.2 本轮补充（非生产代码）
| 编号 | 类型 | 内容 | 处理 |
|------|------|------|------|
| T60-01 | 测试缺口 | `approval.test.ts` 分别覆盖「服务端审批生命周期」与「工具层 stub 回调」，但两者真实接线的端到端路径无测试 | 新增 `src/kernel/approval-wiring.test.ts`（2 项：批准单次生效/第二次重请求/拒绝、超时 human_required+tool.denied），最终 101/101 |

### 6.3 非阻断观察（记录，供后续专项）

| 编号 | 严重度 | 观察 | 证据/位置 | 建议 |
|------|--------|------|-----------|------|
| O1 | 中低 | `fs.search` 仍可读取 `.ssh/.env` 等敏感文件（策略层把搜索归为 low/read；工具层仅 fs.read/fs.write 做敏感路径拦截） | `tools.ts:481–518`（walkFiles 读出后直接匹配）；t62 亦记录 | 下一轮安全专项：fs.search 跳过 `isSensitivePath` 命中的文件，或复用 fs.read 门禁 |
| O2 | 中低 | `resolveInside` 未对 root/target 做 `realpath`，工作区内 symlink 可指向工作区外，路径策略可被绕过 | `tools.ts:329–339`；t62 亦记录 | 安全专项：写入/读取前 `fs.realpath` 后重新校验前缀 |
| O3 | 低（UX） | 切换工作区时 renderer 审批队列未主动清空（服务端 120s 超时兜底，不会残留批准） | `App.tsx` 工作区切换路径未重置 `riskApprovals`；t62 记录 | 切工作区时清空队列并 toast 提示 |
| O4 | 低（安全加固） | 敏感清单未含 `.git/config`、`.gitattributes`（可配置 git filter/hooksPath 间接触发命令执行）；且只读 shell 前缀未审计可写/可执行参数（如 `git diff --output=file`、`find -delete`、`rg --pre`） | `permission.ts:91–139`、`:34–78`；属 t53/t55 既有语义 | 下一轮安全专项评估：扩展 `.git` 配置文件拦截 + shell 参数白名单 |
| O5 | 低 | 审批超时固定 120s（共享常量），不可配置 | `src/shared/approval.ts` | 后续加设置项或按成员/工具覆盖 |
| O6 | 低（验证） | 无 React 组件级/Playwright 测试：审批弹窗的 DOM 交互（FIFO 队列、Esc/遮罩拒绝、超时收起、失效回执提示）仅有人工冒烟 | 项目无 RTL/Playwright 依赖 | 引入测试库后补组件测试；当前以人工冒烟兜底（§7） |
| O7 | 信息 | Router 对话仍不执行工具，审批只覆盖任务执行成员 | `service.ts` sendChat 无工具回路（t53 边界） | Router 接入工具后复用同一门禁，无需另建审批链路 |
| O8 | 信息 | `fs.read` 对敏感路径一律拒绝（含 full_access），与 t53 secret 读取保护一致 | `tools.ts:428–434` | 若产品要求 full_access 可读 secret，需单独评审 |

---

## 7. 限制与人工冒烟

- 无 Playwright/e2e、无 RTL：真实 Electron 窗口内的审批弹窗交互、IPC 往返、Dock 拖动等仍以人工冒烟为准；本验收以「最终代码走查 + 单测/端到端回归 + 独立探针 + 三命令 + DESIGN 对照」为证据。
- **人工冒烟（12 项）**：
  1. 将成员权限设为 `auto_risk`，让其执行一次敏感写入（如 `fs.write .ssh/config`）→ 审批弹窗出现，显示风险等级/成员/任务/工具/目标/原因。
  2. 点「批准（仅本次）」→ 文件落盘、toast 成功、事件 `human_approved`；同一目标再次操作 → **再次弹窗**（不缓存批准）。
  3. 点「拒绝」或 Esc/关闭/点遮罩 → 不落盘、toast 拒绝、事件 `human_denied` + `tool.denied`。
  4. 弹窗出现后等待 120s 不操作 → 弹窗自动收起 + 超时提示、事件 `human_required`；之后再点已失效的批准不会成功。
  5. 两个高风险并发 → FIFO 依次展示（后到不覆盖先到），各自独立 120s 计时。
  6. 弹窗打开期间刷新页面 → 无残留批准；主进程按超时拒绝。
  7. `workspace_write` 成员写 `.env`、`.ssh/config`、`.envrc`、`.envrc.local`、`.git/hooks/pre-commit` → 全部拒绝；写 `src/a.ts` → 允许。
  8. `full_access` 成员写 `.ssh/config` → 成功，并产生 `full_access_allowed` 审计事件。
  9. `read_only` + 满血模式开启 → 写入/shell 仍被拒绝；无审批弹窗、无自动批准。
  10. 组合 shell：`git status && git push`、`ls; rm -rf .`、`cat x | curl ...`、`echo $(rm -rf .)`、`ls > out.txt` 在 workspace_write/auto_risk 下全部拒绝。
  11. Dock：对话面板内控制条、任务/团队/星图面板拖动/关闭重开/持久化不受审批 Modal 影响；Modal/Toast/深链无回归。
  12. 关闭主窗口时若有待审批请求：主进程按超时兜底（human_required），不静默放行。

---

## 8. 后续项

1. **安全专项（优先）**：O1 `fs.search` 敏感文件过滤、O2 `resolveInside` realpath、O4 `.git/config`/`.gitattributes` 与 shell 参数审计。
2. **审批 UX/可配置**：O3 切换工作区清空审批队列；O5 超时可配置；考虑审批提醒（非模态入口）避免用户不在对话页时错过 120s。
3. **测试基线**：引入 RTL/Playwright 后补审批弹窗组件级测试（O6），把 §7 的人工项逐步自动化。
4. **文档语义**：在帮助/README 明确「Router 对话不执行工具」「审批仅对单次调用生效」「fs.read 敏感文件一律拒绝」（O7/O8）。

---

## 9. 文件清单与变更记录

- **t60 新增**：
  - `docs/team/chat-controls-permission-final.md`（本报告）
  - `src/kernel/approval-wiring.test.ts`（2 项端到端审批回归）
- **t60 未修改**：任何生产代码（`src/**` 非测试文件、`electron/**`、`dist/**`、`dist-electron/**` 均未由 t60 改动；build 产物仅本地验证）。
- **并行基线变更（非 t60）**：提交 `87a94ca`（Dock 库样式 + 团队面板 `@container`）、`4e23fdb`（移除重复侧栏导航、Dock 作为主导航）、`d4c2a1d`（星图图例折叠浮层）由仓库维护者完成（仅涉及 `DockShell.tsx`、`App.tsx`、`TaskStarMap.tsx`、`styles.css`）；均不属 t60 changedPaths，t60 未修改这些文件，也未触碰权限/审批代码。
- **上游变更（t58/t61，已在最终树中复核）**：`src/kernel/permission.ts`、`src/kernel/tools.ts`、`src/kernel/service.ts`、`src/App.tsx`、`src/shared/types.ts`、`src/shared/ipc.ts`、`src/shared/approval.ts`、`src/styles.css`、`electron/main.ts`、`electron/preload.ts`、`src/kernel/permission.test.ts`、`src/kernel/approval.test.ts`、`docs/team/chat-controls-implementation.md`（完整清单见该文档 t58 表格）。
- **变更记录**：
  - t58：IF-05 审批 UI + IF-08 敏感路径策略层（95/95）
  - t59：needs_revision（F1 dotenv / F2 文档范围）
  - t61：F1/F2 修复（99/99）
  - t62：verdict=pass（4/4 acceptance，接受 electron IPC 例外）
  - t60：集成复核 + 独立探针 + 三命令 0/0/0（10 文件 101/101）+ 新增端到端回归 2 项
