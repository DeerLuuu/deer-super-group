# DeerSuperGroup 设计草案

**一个本地优先的「Agent 团队工作区」**

> 人类给目标，Router 拆任务，成员在隔离工作区里并行开发，通过邮箱 / 黑板 / 备忘录共享上下文，由看门狗兜底，最后由人评审、合并。

---

## 1. 产品定位

**不是又一个 Coding Agent，而是 Coding Agent 之上的「团队层 / 调度层 / 评审层」。**

**产品层级：核心是「AI 团队工具」**——工作区、Router、成员、任务、隔离执行、评审、合并。**跨工作区经验网络是增强层**，不是主产品；团队工具即使没有网络也必须能独立跑通，网络只在多个工作区之间放大价值。

- 下层：Worker 可以是 Claude Code、Codex、DSH、OpenHands，甚至一个普通 LLM + 工具循环。
- 上层：任务图、邮箱、黑板、备忘录、看门狗、转述者、Git 流程、行级评审。
- 人类位置：从“每一步的操作员”变成“目标设定者 + 关键决策者 + 验收者”。

差异化不在“模型更强”，而在：

1. **可视化**：任务星图 + 执行片段 + 行级批注。
2. **组织记忆**：多领域黑板 + 成员备忘录 + 任务摘要索引。
3. **可靠性**：看门狗、检查点、模型降级、合并队列。
4. **可控性**：本地优先、沙箱隔离、权限策略、人工审批。

---

## 2. 核心闭环

```
用户
  │  自然语言目标
  ▼
转述者 Narrator ──► 意图卡（目标/约束/验收/未知项/假设）
  │  确认或补充
  ▼
Router ──► 提议任务（Task Proposal）
  │  人类批准 / 自动批准（可配置）
  ▼
任务 DAG ──► 就绪队列 ──► 成员（Worker）
  │                          │
  │                          ├─ 独立 worktree + 沙箱
  │                          ├─ 工具 / MCP / Skills
  │                          ├─ 邮箱 / 黑板 / 备忘录
  │                          └─ 执行片段（事件流）
  ▼
评审（人 + 评审 Agent）──► 修改 / 修复 ──► PR ──► 合并队列 ──► 主分支
  │
  ▼
任务摘要 ──► 索引（供后续任务检索）──► 备忘录 / 黑板
```

---

## 3. 架构原则

1. **一个事件日志，多个投影**
   所有消息、任务状态、工具调用、文件变更、评审意见都写成事件；邮箱、黑板、TODO、星图、执行片段都是事件日志的投影。这样天然获得审计、回放、调试、一致性。

2. **任务是一等公民**
   不是“聊天里顺便记一下”，而是有 ID、依赖、状态机、验收标准、工作区、分支、PR、摘要的实体。

3. **每个任务一个隔离工作区**
   `git worktree` + 独立进程/容器沙箱；同一成员同一时间只做一个任务；合并串行化。

4. **人负责决策与验收，系统负责调度与记忆**
   提案、合并、危险操作默认需要人确认；系统不替人做价值判断。

5. **Worker 可替换**
   用 Adapter 封装不同 harness（Claude Code / Codex / DSH / 自研），团队层不绑死某个模型或 CLI。

6. **默认安全**
   最小权限、秘密不进入提示词、不可信内容标记、危险工具审批、全量审计。

---

## 4. 系统架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        Desktop UI (React)                         │
│  Workspace │ Team │ Task Graph │ Mailbox │ Blackboard │ Review    │
└───────────────────────────────┬──────────────────────────────────┘
                                │ WebSocket / SSE + REST
┌───────────────────────────────▼──────────────────────────────────┐
│                     Local Daemon (Node/TS)                       │
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐  │
│  │ Orchestrator │   │ Event Store  │   │ Projections          │  │
│  │ DAG 调度器    │   │ SQLite WAL   │   │ tasks / messages /   │  │
│  │ 重试/取消     │   │ append-only  │   │ boards / todo / memo │  │
│  └──────┬───────┘   └──────────────┘   └──────────────────────┘  │
│         │                                                        │
│  ┌──────▼───────┐   ┌──────────────┐   ┌──────────────────────┐  │
│  │ Run Manager  │   │ Memory Svc   │   │ Git Service          │  │
│  │ + Watchdog   │   │ 摘要/索引/RAG │   │ worktree / PR / merge│  │
│  └──────┬───────┘   └──────────────┘   └──────────────────────┘  │
│         │                                                        │
│  ┌──────▼────────────────────────────────────────────────────┐   │
│  │ Worker Runtimes（每个成员、每个任务）                       │   │
│  │  Adapter: Claude Code / Codex / DSH / custom               │   │
│  │  Sandbox: process | container | cloud                      │   │
│  │  Tools: fs / shell / git / browser / MCP / Skills          │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

**技术默认建议**（可改）：

- UI：React + Vite + Tailwind；图用 React Flow / ELK；Diff 用 Monaco。
- 桌面：Tauri（轻）或 Electron（生态成熟）。
- Daemon：Node.js + TypeScript；SQLite（better-sqlite3）。
- 事件总线：进程内 EventEmitter + SQLite 持久化；云端再换 Postgres/Redis。
- Git：`simple-git` + GitHub/GitLab API；worktree。
- MCP：`@modelcontextprotocol/sdk`。
- 模型网关：OpenAI-compatible 适配器 + 配额/降级/成本账本。

---

## 5. 数据模型（核心）

### 5.1 事件（唯一事实源）

```ts
Event {
  id: string            // ulid
  seq: number           // 全局递增
  aggregateType: 'task' | 'run' | 'message' | 'board' | 'memo' | 'review' | 'agent'
  aggregateId: string
  type: string          // task.created / run.tool_call / message.sent ...
  actor: string         // user | agent:<id> | system
  payload: unknown
  createdAt: string
}
```

### 5.2 任务

```ts
Task {
  id: string
  title: string
  description: string
  acceptance: string[]        // 验收标准
  status: 'proposed' | 'approved' | 'ready' | 'running'
        | 'blocked' | 'review' | 'done' | 'failed' | 'cancelled'
  createdBy: string
  owner: string               // agent id
  dependsOn: string[]
  priority: number
  branch?: string
  worktree?: string
  prUrl?: string
  summaryId?: string
  createdAt: string
  startedAt?: string
  endedAt?: string
}
```

状态机：`proposed → approved → ready → running → review → done`，旁路 `blocked / failed / cancelled`。`proposed` 与 `review` 默认是人审点。

### 5.3 运行（一次执行尝试）

```ts
Run {
  id: string
  taskId: string
  agentId: string
  modelProfileId: string
  sandboxId: string
  status: 'queued' | 'running' | 'waiting_human'
        | 'completed' | 'failed' | 'cancelled'
  heartbeatAt: string
  tokenIn: number
  tokenOut: number
  costUsd: number
  checkpointRef?: string
  startedAt: string
  endedAt?: string
}
```

### 5.4 成员

```ts
Agent {
  id: string
  name: string
  role: string
  systemPrompt: string
  personaFile: string          // 人格文件路径
  agentsMd: string             // 该成员的 AGENTS.md
  modelProfileId: string
  fallbackModelIds: string[]
  sandboxPolicyId: string
  toolPolicy: Record<string, 'allow' | 'ask' | 'deny'>
  maxConcurrency: 1
  status: 'idle' | 'running' | 'blocked' | 'offline'
}
```

### 5.5 记忆

```ts
TaskSummary {
  taskId: string
  runId: string
  goal: string
  changes: string[]
  files: string[]
  tests: { command: string; status: 'passed' | 'failed' }[]
  decisions: string[]
  risks: string[]
  openQuestions: string[]
  nextSteps: string[]
  embedding: number[]          // 供检索
}

BlackboardEntry {
  id: string
  boardId: string              // frontend / backend / security / design ...
  author: string
  kind: 'fact' | 'decision' | 'question' | 'warning' | 'artifact' | 'link'
  content: string
  refs: string[]               // task / file / PR / URL
  confidence: 'low' | 'medium' | 'high'
  pinned: boolean
  ttlAt?: string
  status: 'active' | 'archived'
  createdAt: string
}

Memo {
  id: string
  agentId: string
  kind: 'lesson' | 'failure' | 'shortcut' | 'preference'
  content: string
  tags: string[]
  sourceTaskId?: string
  lastVerifiedAt?: string
  createdAt: string
}
```

### 5.6 评审

```ts
ReviewThread {
  id: string
  prUrl: string
  file: string
  line: number
  commitSha: string
  author: string
  body: string
  severity: 'nit' | 'suggestion' | 'issue' | 'blocker'
  status: 'open' | 'resolved' | 'outdated'
  replies: { author: string; body: string; createdAt: string }[]
}
```

### 5.7 消息（邮箱）

```ts
Message {
  id: string
  threadId: string
  from: string
  to: string[]
  kind: 'request' | 'report' | 'question' | 'decision' | 'artifact' | 'review'
  subject: string
  body: string
  attachments: { name: string; path: string }[]
  refs: string[]               // task / pr / file
  createdAt: string
}
```

---

## 6. 13 条想法的落地方案

| # | 想法 | 判断 | 关键设计 / 风险 |
|---|---|---|---|
| 1 | 选工作区 + 默认 Router + 可关闭概述 | 保留 | 概述做成缓存产物（repo map + 关键文件 + 命令），带失效策略；关闭后 Router 仍可按需读取 |
| 2 | 成员：系统提示词 / 模型 / AGENTS / 人格 / 邮箱 | 保留 | 配置版本化；模型 profile + 降级链；邮箱用 Message 表 + 线程；每成员工具策略 |
| 3 | 任务树/星图 + 执行片段 + 摘要索引 | **核心** | DAG 调度器；事件日志即执行片段；摘要带结构化字段 + embedding；先做列表/看板，星图后置 |
| 4 | 多领域专家黑板 + 时效性 | 保留但简化 | 条目原子化、带来源/置信度/TTL/pin；清理任务“提议归档 + 人确认”；避免变成聊天室 |
| 5 | 成员 TODO List | 保留但去重 | TODO 是任务 + 成员私有清单的投影，不要做第二个事实源 |
| 6 | 成员备忘录 | 保留 | 私有、可打标签、关联任务；任务开始时检索；可“提升到黑板”；带过期/复核 |
| 7 | 看门狗（15 分钟） | 保留但改造 | 心跳 + 事件触发 + 15 分钟全局巡检；卡死/循环/无进展/配额检测；干预阶梯；模型切换前必须 checkpoint |
| 8 | 转述者 | 保留但可选 | 输出结构化意图卡；最多 2—3 个问题；高置信度直接执行并记录假设；可合并为 Router 的一个模式 |
| 9 | Git 多分支 PR + 合并 | **核心且最难** | 每任务 worktree + 分支；PR；合并队列；冲突解决任务；保护主分支；默认人工批准合并 |
| 10 | MCP 接入 | 保留 | MCP client（stdio/SSE）；每成员 allowlist；OAuth；工具审批；未来可做 MCP server |
| 11 | Skills 系统 | 保留 | `skills/<name>/SKILL.md` + 脚本；渐进式加载；按成员分配；版本化 |
| 12 | 每成员独立沙箱 | 保留但分层 | `process / container / cloud` 三档；每成员策略；秘密注入；网络/资源限制 |
| 13 | 代码行级查看与批注 | **核心差异化** | Monaco diff + 行内评论 + 线程；绑定 commit SHA；rebase 后重新锚定；未解决 blocker 阻止合并 |

---

## 7. 关键难点与对策

### 7.1 并发写同一仓库

**问题**：多个成员同时改同一个仓库，冲突是常态，不是异常。

**对策**：
- 每任务一个 `git worktree` + 独立分支，物理隔离。
- 文件级“软所有权”：任务创建时声明预期修改范围；冲突时提示。
- **合并队列**：一次只合并一个 PR 到主分支；合并前跑 CI + 评审。
- **冲突解决任务**：合并失败自动生成一个 `resolve-conflict` 任务，指派给“合并队长”或人。
- 保护主分支：禁止直接 push；必须 PR；必须通过检查。

### 7.2 任务图与执行一致性

**问题**：任务状态、执行记录、邮箱、UI 多处写，容易不一致。

**对策**：
- 事件日志唯一事实源；所有投影可重建。
- 任务状态机严格校验；非法迁移拒绝。
- Run 幂等：同一任务同一 attempt 不重复执行；重试生成新 Run。
- 执行片段 = 按 `runId` 过滤事件；不需要单独存 trace。

### 7.3 记忆三层

**问题**：黑板/备忘录/摘要会互相污染，越用越乱。

**对策**：
- **工作记忆**：当前 Run 的上下文，任务结束即丢。
- **情节记忆**：TaskSummary + 执行片段，按任务/文件/时间索引。
- **语义记忆**：黑板（团队共享）+ 备忘录（成员私有）+ 仓库文档。
- 每条记忆带 `source / confidence / ttl / lastVerifiedAt`；检索时按“相关度 × 置信度 × 新鲜度”排序。
- 黑板清理：定时任务提议归档，人确认；pinned 永久保留；归档不删除。
- 备忘录过期：30 天未复核标记 stale；任务开始时只注入高置信度条目。

### 7.4 看门狗

**问题**：误判会打断正常工作；漏判会让任务卡死烧钱。

**对策**：
- 心跳：每次 LLM 调用/工具调用更新 `heartbeatAt`；15 分钟全局扫，5 分钟单任务超时检查。
- 检测信号：
  - 心跳超时（>10 分钟无事件）
  - 重复工具调用签名（同一命令/同一文件 >N 次）
  - 无文件变更（>N 轮无 diff）
  - 错误连击（连续失败 >N）
  - Token 燃烧速率异常
  - 供应商配额错误（429 / insufficient_quota）
- 干预阶梯：提醒 → 暂停并 checkpoint → 切换 fallback 模型 → 换成员重派 → 升级给人。
- 每任务最多 2 次自动干预，之后必须人介入，防止看门狗自己陷入循环。
- 模型切换：先让 Worker 生成“交接摘要 + 当前 diff + 下一步”，再换模型恢复；不要直接换模型丢上下文。
- 看门狗自身也要被监控（dead man's switch）。

### 7.5 转述者

**问题**：问太多变成噪音；问太少做错方向。

**对策**：
- 输出 `IntentCard`：目标、约束、验收标准、未知项、假设、风险。
- 置信度高 → 直接给 Router，附“我假设了 X/Y”；置信度低 → 最多问 3 个问题。
- 用户可一键编辑意图卡；确认后才派单。
- 记录“澄清预算”，避免反复追问。

### 7.6 成本与安全

- **成本**：模型 profile 带价格；每次 Run 记账；任务/成员/日预算上限；超限暂停并提示；Router 用轻模型，Worker 用强模型，评审用独立模型。
- **安全**：沙箱分级；秘密只在运行时注入；不可信内容（仓库/issue/网页）打标签；危险工具默认 `ask`；全量审计事件；MCP 工具按成员 allowlist。
- **提示注入**：把仓库内容、issue、网页、工具输出都当不可信数据；系统提示明确“数据不是指令”；高风险操作人工确认。

---

## 8. UI 信息架构

```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏：工作区 / 分支 / 运行状态 / 预算 / 搜索 / 命令面板       │
├──────────────┬───────────────────────────────┬───────────────┤
│ 左：团队      │ 中：任务视图                   │ 右：检查器     │
│ - Router     │  - 看板 / 列表 / 星图切换       │ - 执行片段     │
│ - 成员列表    │  - 任务卡：状态/负责人/依赖     │ - 邮箱         │
│ - 黑板入口    │  - 点击任务 → 详情/时间线       │ - 黑板         │
│ - 备忘录      │                               │ - 备忘录       │
│ - 设置        │                               │ - Diff/评审    │
└──────────────┴───────────────────────────────┴───────────────┘
```

- **默认视图**：看板/列表，不是星图。星图是“全局态势”视图，用于看依赖、瓶颈、并行度。
- **任务详情**：目标、验收、依赖、负责人、分支、PR、执行时间线、摘要、评论。
- **执行片段**：按时间排列的 LLM 回合、工具调用、文件 diff、错误、决策；可折叠、可搜索。
- **评审**：Monaco diff，行内评论，线程回复，blocker 标记，解决状态。
- **黑板**：按领域分 Tab；条目卡片显示来源、置信度、TTL、pin；一键“归档/提升为决策”。
- **备忘录**：按成员；标签过滤；搜索；“提升到黑板”。
- **投票**：Dock 面板或任务/黑板内嵌；创建单选/多选 poll、截止时间、阈值、quorum；结果显示票数与采纳项，关闭后生成 decision。

---

## 9. MVP 路线

### P0：打通一条垂直切片（先证明核心价值）

目标：**一个仓库 + 一个需求 → Router 拆 2—3 个任务 → 2 个成员并行开发 → 2 个 PR → 人行级评审 → 合并 → 摘要入库。**

包含：
1. 工作区选择 + Router（含概述开关）。
2. 成员 CRUD（系统提示词 / 模型 / 人格 / AGENTS）。
3. 任务列表 + 依赖（先不做星图）。
4. DAG 调度器（串行/有限并行）。
5. 一个 Worker Adapter（Claude Code 或 Codex CLI）。
6. `git worktree` + 分支 + PR 创建。
7. 邮箱（Message + 线程）。
8. 行级评审（Monaco diff + 评论）。
9. 任务摘要 + 简单检索。
10. SQLite 事件日志 + 基础审计。

### P1：团队感

- 任务星图 + 执行片段时间线。
- 备忘录。
- 看门狗（心跳 + 卡死/循环 + 配额降级）。
- 转述者（意图卡）。
- 多 Worker Adapter（Claude Code + Codex + DSH）。
- 模型 profile + 降级链 + 成本账本。
- 团队投票（Poll）：多选、阈值采纳、截止时间、quorum、黑板/任务联动。

### P2：组织记忆与规模化

- 多领域黑板 + TTL + 清理审批。
- MCP client + 每成员工具策略。
- Skills 系统。
- 沙箱分级（process/container/cloud）。
- 合并队列 + 冲突解决 Agent。
- TODO 视图。
- 多用户/权限/审计导出。

### P3：平台化

- 云端控制面 + 本地执行节点（存算分离）。
- 评测体系（任务成功率/回归率/成本）。
- 模板市场 / 团队模板。
- 对外 MCP Server / A2A 接入。

---

## 10. 成功指标

- 任务周期时间（创建 → 合并）
- 首次 PR 通过率 / 评审轮次
- 合并冲突率 / 冲突解决时间
- 人工干预次数（越少越好，但要有下限保障）
- 单任务 Token 成本 / 模型降级次数
- 测试通过率 / 回归率
- 看门狗误报率 / 漏报率
- 用户留存：每周活跃工作区数、任务完成数

---

## 11. 需要拍板的问题

1. **形态**：本地桌面 App（Tauri/Electron）+ 本地 daemon，还是 Web + 云端？
   - 建议：本地优先，云同步后置。
2. **技术栈**：TypeScript 全栈（推荐，和 MCP/DSH 生态一致），还是 Python 后端？
3. **Worker 策略**：包装 Claude Code / Codex / DSH 作为 Worker（推荐），还是自研 Agent Loop？
4. **和 DSH 的关系**：作为 DSH 的插件/上层应用，还是独立产品？
5. **单用户还是多用户**：建议先单用户本地，多用户后置。
6. **Git 托管**：先 GitHub，还是 GitLab/本地裸仓库也要支持？
7. **星图优先级**：是主视图还是辅助视图？建议先列表/看板，星图 P1。

---

## 12. 跨工作区 Router 经验网络（新增）

> 不是让 Router 互相聊天，而是让 Router 交换**结构化的经验卡**。

### 12.1 定位：联邦式案例推理

每个工作区是一个“案例库”，Router 是案例的提取者、检索者、回答者。交换的单位是**经验卡（ExperienceCard）**，不是原始对话、不是整段日志、不是代码。

四步循环（Case-Based Reasoning）：

```
Retrieve（本地/网络检索） → Reuse（复用） → Revise（本地验证/修正） → Retain（回写经验）
```

### 12.2 核心对象

```ts
WorkspaceProfile {
  workspaceId: string
  routerId: string
  tags: Tag[]                  // 技术栈/领域/架构/规范/问题签名/规模
  embedding: number[]          // README + manifests + 关键文档的向量
  stack: string[]              // language/framework/version
  domain: string[]             // ecommerce/fintech/devtools...
  conventions: string[]        // test/lint/ci/release
  visibility: 'private' | 'team' | 'public'
  updatedAt: string
}

Tag {
  key: string                  // stack.lang / domain / arch / convention / problem / scale
  value: string
  confidence: 'low' | 'medium' | 'high'
  source: 'manifest' | 'readme' | 'ci' | 'router' | 'user'
}

ExperienceCard {
  id: string
  authorRouterId: string
  workspaceTags: string[]
  problemSignature: string     // 错误签名/症状/任务类型
  symptoms: string
  rootCause: string
  solution: string
  applicability: string        // 适用边界（版本/框架/前提）
  evidence: string[]           // 命令、diff 摘要、测试结果（脱敏）
  confidence: 'low' | 'medium' | 'high'
  successCount: number
  failureCount: number
  status: 'active' | 'stale' | 'archived'
  createdAt: string
}

Question {
  id: string
  fromRouterId: string
  problem: string
  contextFingerprint: {
    stack: string[]
    versions: Record<string, string>
    errorSignature?: string
    tried: string[]
    constraints: string[]
  }
  visibility: 'team' | 'public'
  deadline?: string
}

Answer {
  id: string
  questionId: string
  fromRouterId: string
  experienceCardId?: string
  content: string
  confidence: 'low' | 'medium' | 'high'
  evidence: string[]
}

Feedback {
  answerId: string
  askingRouterId: string
  outcome: 'worked' | 'partial' | 'failed'
  note?: string
}
```

### 12.3 四条流程

**① 打标（Profile）**

- 触发：每日/每周定时，或 git 变更达到阈值。
- 输入：`package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml`、README、CI 配置、`AGENTS.md`、目录结构、依赖清单、最近任务类型。
- 输出：tags + embedding + stack/domain/conventions。
- **默认自动打标**：`source = manifest / readme / ci / router`，每条带 confidence；用轻量模型，缓存结果，不阻塞对话。
- **人工可介入**：新增 / 修改 / 删除 / 锁定标签；`locked` 标签不被自动扫描覆盖；人工标签权重高于自动标签；保留审计记录（谁、何时、为什么改）。
- 标签生命周期：`proposed → active → stale`；依赖/技术栈变化时重新评估；stale 标签不参与公网匹配。
- 隐私：只上传派生标签和向量，不上传源码；敏感标签（内部系统名、客户名）默认私有。

**② 提问（Ask）**

- 触发：本地检索失败、连续失败 N 次、阻塞超过 X 分钟、未知错误、架构决策、用户主动“问问别人”。
- 构造问题卡：症状、错误签名、栈与版本、已尝试、约束、期望的答案类型。
- 脱敏：路径、密钥、客户名、内部 URL。
- 选 top-K 相似 Router（K=3—5），异步提问，等待 30 秒—2 分钟；**不阻塞本地工作**。
- 限流：每任务最多问 1—2 次，避免把网络当拐杖。

**③ 回答（Answer）**

- 收到问题 → 在本地经验卡 / 任务摘要 / 备忘录中检索。
- 匹配度高于阈值才回答；否则明确说“没遇到过”。
- 回答必须包含：根因、方案、适用边界、证据、置信度。
- 不确认的不要编；不要把别的工作区的代码原样贴出。

**④ 回写（Feedback / Retain）**

- 提问方在本地验证后反馈 `worked / partial / failed`。
- 成功 → 提升经验卡权重；失败 → 记录 negative knowledge，避免别人再踩。
- 经验卡带 `lastVerifiedAt`；长期未验证标记 stale。

### 12.4 相似度与排序

```
score = w1 · tagJaccard
      + w2 · embeddingCosine
      + w3 · stackMatch
      + w4 · problemSignatureMatch
      + w5 · recency
      + w6 · authorReputation
      − penalty(stale / conflict / lowEvidence)
```

- Top-K 要有多样性：不要选 5 个一模一样的工作区。
- 经验卡按“相关度 × 置信度 × 新鲜度 × 成功率”排序。
- 冲突答案并列展示，由提问方本地验证裁决。

### 12.4.1 什么是“网络答案”

“网络答案”指：**提问方 Router 在本地解决不了时，向 Router 经验网络里的其它 Router 提问，对方基于自己工作区的经验卡给出的回答。**

它不是：

- ❌ 联网搜索 / 网页结果（那是 Web Search）；
- ❌ 模型凭先验知识直接编的答案（那是模型答案）；
- ❌ 对方工作区的原始代码 / 日志（那是数据泄露）。

一个例子：

- 工作区 A 的 Router 遇到 `pnpm workspace` 下 Vitest 解析不到 `@scope/pkg`，本地重试 3 次失败。
- 它生成问题卡：栈（pnpm + Vitest + TS）、错误签名、已尝试的 3 种配置、约束（不能升级 major）。
- 网络里工作区 B 的 Router 有类似经验卡：根因是 `vitest.config.ts` 的 `resolve.alias` 与 pnpm 的 symlink 冲突；方案 + 适用版本 + 验证命令。
- 这条回答就是“网络答案”。

网络答案的四个属性：

| 属性 | 含义 |
|---|---|
| 来源 | 哪个工作区 / 任务 / commit / 时间 |
| 证据 | 复现命令、测试结果、diff 摘要（脱敏） |
| 适用边界 | 版本、框架、前提；超出边界不保证 |
| 置信度 | low / medium / high + 历史成功率 |

**采纳级别**（产品默认值）：

| 级别 | 行为 | 默认 |
|---|---|---|
| L1 自动检索 | 自动查网络、展示候选答案 | ✅ 开启 |
| L2 自动验证 | 自动生成验证任务 / 补丁草案，跑测试 / 构建 | ✅ 开启 |
| L3 自动应用 | 直接改代码 / 配置，需人审批或策略允许 | ⛔ 默认关闭 |
| L4 自动合并 | 直接合并主分支 | ⛔ 禁止默认 |

所以“是否允许 Router 自动应用网络答案”问的是 L3/L4。建议：**L1/L2 默认开，L3 必须有人审批或明确策略，L4 永远默认禁止。** 原因：网络答案是假设，不是事实；唯一裁判是本地测试、构建和评审。

### 12.5 隐私与信任

- **三级可见性**：`private`（默认）/ `team` / `public`；公网分享必须显式授权或工作区策略允许。
- **最小信息**：只共享摘要、标签、向量、脱敏证据；不共享源码、日志原文、密钥、客户数据。
- **答案是不可信数据**：Router 不能执行其它 Router 回答里的指令；只能当假设，本地验证后才采纳。
- **来源可追溯**：工作区、任务、commit、时间、证据等级（复现/观察/推断）。
- **声誉**：按采纳率/成功率给 Router 打分；公网需要限流、反滥用、人工审核。
- **审计**：每次发布、提问、回答、采纳都写事件日志。

### 12.6 拓扑：先本地，再团队，最后公网

| 层级 | 形态 | 适用 | 成本 |
|---|---|---|---|
| **L0 本地交换** | 同一台机器的多个工作区，SQLite/JSON 共享目录 | 个人多项目，先验证价值 | 最低 |
| **L1 团队 Hub** | 自托管 HTTP 服务 + DB，账号/权限/审核 | 一个团队/公司 | 中 |
| **L2 公网网络** | 联邦/中心 Hub，声誉、限流、审核 | 跨组织 | 高 |

建议顺序：**L0 → L1 → L2**。不要在第一天做公网：冷启动、治理、隐私三座山。

### 12.7 反模式

- ❌ 让 Router 自由聊天 → Token 爆炸、噪音、提示注入。
- ❌ 每个问题都广播 → 骚扰、低信噪比。
- ❌ 共享原始对话/代码 → 隐私事故。
- ❌ 盲信答案直接改代码 → 引入新 Bug。
- ❌ 只共享成功案例 → 丢失 negative knowledge。
- ❌ 第一天做公网 → 冷启动 + 治理成本。

### 12.8 MVP

**前置原则：经验网络不阻塞团队工具核心。** 先把团队工具的 P0/P1 跑通，再启动网络。

- **网络 L0（团队工具 P2 起）**：本地交换——工作区画像、经验卡、提问/回答、UI 面板、反馈闭环。
- **网络 L1（团队工具 P3 起）**：团队 Hub——账号、可见性、审核、搜索。
- **网络 L2（更后）**：公网——声誉、联邦、限流、反滥用。

### 12.9 协议

- 传输：REST/JSON（本地可用 SQLite + 文件队列）；可选暴露为 MCP Server，让 Router 用工具调用。
- 消息：`profile.publish`、`profile.search`、`question.ask`、`question.answer`、`feedback.submit`、`experience.get`。
- 异步队列 + 幂等键 + schema 版本号；公网再加签名/鉴权。
- 未来可与 A2A 兼容，但不要让协议复杂度拖慢 P1。

---

## 14. 团队投票（Poll）

### 14.1 定位

团队投票把「会开完了，谁赞成？」从黑板里的非正式反应，升级为**可创建、可审计、可复现**的团队决策对象。它是黑板、任务摘要、会议流程的上层：

- 会议提案：N 条候选 → 多选投票 → 超过阈值采纳；
- Router 方案：多个拆解方案/优先级 → 投票；
- 任务决策：是否合并、是否回滚、是否进入下一阶段；
- 验收/评审：blocker 是否放行、版本是否发布；
- 未来：跨工作区经验卡/模板的采纳投票。

原则：**投票是决策工具，不是聊天投票器**。每个 poll 有明确问题、候选、 voters、截止时间和采纳规则；关闭后生成 decision 记录，不能静默改票。

### 14.2 数据模型

```text
polls
  id, workspace_id, scope (workspace|team|task|board), title, description
  mode (single|multi), max_selections, threshold_rule (>N|majority|percent)
  threshold_value, quorum, allow_abstain, anonymous
  status (draft|open|closed|expired), created_by, created_at, closes_at, closed_at
  decision_ref (board_entry_id | task_id | doc_path | null)

poll_options
  id, poll_id, label, description, source_type (board|task|manual|doc)
  source_id, sort_order

poll_ballots
  id, poll_id, voter_id, voter_type (agent|human), selections (JSON)
  submitted_at, updated_at
  UNIQUE(poll_id, voter_id)

poll_events（写事件日志，投影出上面三张表）
  poll.created / poll.opened / poll.voted / poll.closed / poll.expired / poll.decided
```

默认规则：

- 一个 voter 一个 ballot；关闭前可改票（保留 revision/event）；
- multi 模式最多选 `max_selections`，可配置为不限；
- 采纳规则默认 `>3`（绝对票数），也支持 majority / percent；
- 同票不自动裁决：触发 runoff 或由 facilitator 记录理由后拍板；
- quorum 未达到 → `insufficient_quorum`，不产生 decision；
- anonymous 只影响 UI 展示，审计日志仍保留 voter 身份（本地单用户/团队内部默认实名）。

### 14.3 API / IPC

```text
poll.create   { workspaceId, scope, title, description, mode, maxSelections,
                threshold, options[], closesAt?, anonymous? }
poll.list     { workspaceId, status? }
poll.get      { pollId }
poll.cast     { pollId, voterId, voterType, selections[] }
poll.close    { pollId, actor, reason? }
poll.read     { pollId }   // 结果 + 每项票数 + 是否达到阈值
```

校验：

- poll 必须 `open` 且在截止时间前；
- voter 必须属于当前 workspace/team；
- option 必须属于该 poll；multi 不超过 `max_selections`；
- 同一 voter 重复提交是改票，不是新增票；
- 关闭/过期后拒绝 cast；
- 只有创建者、facilitator 或 workspace admin 可关闭。

### 14.4 UI

- Dock 面板 `polls`（与对话/团队/任务/邮箱/黑板/设置并列；默认关闭，可从侧栏/命令面板打开）；
- 列表：草稿/进行中/已关闭/过期；显示问题、票数、截止倒计时、是否达到 quorum；
- 详情：候选卡片/复选框（multi）或单选；提交后显示「已投票，可改票」；结果条形图、每项票数、阈值线、弃权数；
- 创建弹窗：标题、说明、模式、最多选几项、阈值、截止时间、匿名、候选（从黑板条目/任务/手动添加）；
- 黑板条目/任务详情提供「发起投票」动作，自动带入 source；
- 关闭 poll 后生成 decision 条目，可一键把采纳项转成任务/黑板 decision；
- 状态反馈：投票成功/改票/关闭/过期/未达 quorum 用 toast + aria-live；
- 键盘：候选可 Tab/方向键选择，Ctrl/⌘+Enter 提交，Esc 关闭弹窗；结果表可读屏。

### 14.5 与现有模块的关系

- **黑板**：proposal 条目是候选来源；poll 结果是 decision 条目；不替代黑板，前者是讨论，后者是正式裁决。
- **任务**：poll 的 scope=task 时显示在任务详情；采纳项可创建/更新任务；任务摘要引用 poll id。
- **Router / 成员**：Router 可以起草 poll，但必须由人确认才 open；成员可按身份投票；人类与 Agent 的票在结果中区分 voter_type。
- **事件日志**：所有创建/投票/关闭写事件，支持回放和审计；投影表可重建。
- **导图/看板**：poll 的采纳项可作为星图/看板过滤条件或 task group，但 P0 不强行耦合。

### 14.6 路线图

**P0（MVP）**
1. SQLite 表 + 事件类型 + `poll.*` IPC；
2. 创建/列表/详情/投票/改票/关闭；
3. multi-select + `>N` 阈值 + 结果条 + 关闭后 decision；
4. 从黑板条目发起 poll；
5. 基础键盘/aria-live/toast。

**P1**
- 截止时间/过期、quorum、runoff、匿名展示、任务 scope、采纳项转任务；
- 与 Router 计划、任务验收联动；
- poll 模板（会议 5 选 3、发布 go/no-go）。

**P2**
- 跨工作区投票、权重/角色票、导出审计报告、公开分享只读结果。

### 14.7 验收标准（P0）

- 创建 16 个候选的多选 poll，8 个 voter 投票，结果正确统计，`>3` 的候选被标记采纳；
- 重复 cast 是改票，不产生重复 ballot；关闭后 cast 被拒绝；
- 关闭 poll 生成 decision 记录，黑板可查，事件日志可回放；
- 键盘可完成创建→投票→关闭；结果变化有 aria-live/toast；
- 刷新/重开应用后 poll 与 ballot 保留；
- 未达阈值/未达 quorum 不产生采纳项。

### 14.8 非目标（P0）

- 不做公开公投、区块链存证、加权/二次投票；
- 不做实时多人协同编辑（单机本地优先，后续 Hub 再扩展）；
- 不替代人的最终验收：poll 是决策输入，不是自动执行器。

---

## 15. 对话权限、模型切换与满血模式

### 15.1 目标

在对话输入框下方直接把「这个成员现在能做什么」和「用哪个模型」做成可见、可改、可审计的运行时控制，而不是让用户去设置页深处找：

- **权限**：仅查看 / 工作区内修改 / 完全权限 / 自动投票判断风险；
- **模型**：当前对话成员的模型可直接切换，下一条消息生效；
- **满血模式（Full Throttle）**：参考 `dsh-full-throttle` 插件——它是在 composer/系统提示中注入**高预算、no-holds-barred 指令**的开关，不是权限系统；本方案把它实现为会话级提示/预算覆盖，不改变工具权限。

### 15.2 权限模式

| 模式 | 允许 | 拒绝/需批准 | 默认 |
|---|---|---|---|
| `read_only` 仅查看 | 读文件、搜索、列目录、看任务/黑板/邮箱 | 所有写入、shell、git 变更、网络 | 新成员默认 |
| `workspace_write` 工作区内修改 | 工作区内文件写入/编辑、任务/黑板/邮箱写操作、受限只读 shell | 工作区外写入、git push、网络、危险 shell | 常规开发 |
| `full_access` 完全权限 | 全部工具，包括 shell、网络、git、任意路径 | 仅审计；高风险动作仍提示 | 手动开启 |
| `auto_risk` 自动投票判断风险 | 风险分级后自动放行低风险 | 中风险走快速评审投票；高风险需人类批准 | 可选 |

实现要求：

- Tool Registry 为每个工具标注 `risk`（read/write/shell/network/git）和所需最低权限；
- `Policy` 在每次工具调用前检查；拒绝写 `tool.denied` 事件并回给模型；
- `workspace_write` 的 shell 只能是受限/只读命令；任何可能越界的命令升级为审批；
- 权限变更写 `agent.permission_changed` 事件；对话页显示当前模式；
- 权限不是提示词约束，而是执行层硬门禁。

### 15.3 自动风险投票

`auto_risk` 的目标不是让模型自己给自己放行，而是把「是否允许这个动作」变成可审计的小型决策：

1. **风险分级**：规则引擎（路径、命令、目标、是否网络/删除/推送）+ 可选模型判断，输出 `low/medium/high`；
2. **low**：自动放行，记录理由；
3. **medium**：向 2–3 个评审者（Router + 任一成员 + 可选人类）发起快速 vote，超半数允许才执行；超时/无 quorum → 升级人类；
4. **high**：必须人类确认；不允许 Agent 投票自行放行；
5. **结果**：写 `permission.risk_vote` 事件，记录风险分、投票人、票数、决定、执行结果；
6. 同一动作重试不重复投票；被拒绝的动作不能靠重试绕过。

这复用第 14 节的 Poll 数据模型，但生成的是**动作级临时 poll**，不进入常规团队投票列表（可在审计中查看）。

### 15.4 满血模式（Full Throttle）

`dsh-full-throttle` 的本质是**系统提示注入**：一个 composer 开关，把高预算、no-holds-barred 的执行指令放进 system prompt，让模型用满预算、不因篇幅/成本自我收敛。它**不是** full access、不是自动批准、不是权限提升。

本项目的实现：

- **定义**：会话级提示/预算覆盖（`session.fullThrottle`），只影响模型行为与运行预算；
- **效果**：
  - 在 system prompt 注入 Full Throttle 段落：最大化推理与验证、不要为简短而省略、充分使用预算、优先完整交付；
  - 可提高本会话的 max steps / max output / 自动继续上限（执行层预算，不是权限）；
  - 不改 `Agent.permission`，不改变 `read_only` / `workspace_write` / `full_access` / `auto_risk` 的任何门禁；
  - 不自动批准工具，不绕过审批，不开放网络/shell；
- **交互**：
  - 输入框下方 `满血模式 (Full Throttle)` 开关，默认关闭；
  - 首次开启显示成本/延迟提示（非安全确认），会话内保持；关闭立即移除提示注入；
  - 顶部/输入框旁常驻 `FULL THROTTLE` 标识，避免误以为已提升权限；
- **边界**：
  - 仅 session 级，不写回 Agent 默认值，不随应用启动恢复；
  - Agent 不能自行开启；
  - 与权限模式正交：可以先 `read_only + Full Throttle`，读操作仍然只读；
  - 所有开启/关闭写 `session.full_throttle_changed` 事件；
  - 不改变“是否允许工具”的判断，只改变“用多大努力/预算做”。

### 15.5 对话输入框下方的控制条

```text
┌──────────────────────────────────────────────────────────────┐
│ [模型: deepseek-v4.1-flash ▾] [权限: 工作区内修改 ▾] [满血模式 ○] │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ 输入消息…                                          [发送] │ │
│ └──────────────────────────────────────────────────────────┘ │
│ 风险提示 / 待审批 / 投票状态（按需显示）                       │
└──────────────────────────────────────────────────────────────┘
```

- 模型下拉：列出已配置模型，切换当前对话成员 `Agent.model`，下一条消息使用新模型；显示 provider 名；
- 权限下拉：四模式，带一句说明；切换后立即生效，写事件；
- 满血模式开关：灰色默认；开启显示成本/延迟提示（不是权限确认）；开启后 `FULL THROTTLE` 标识；关闭移除提示注入；不改变权限下拉；
- 控制条只在对话页显示，不挤占消息区；窄窗可折成一行图标 + tooltip；
- 权限/模型变更用 toast 确认，失败保留原值。

### 15.6 API / 数据

```text
Agent.permission = "read_only" | "workspace_write" | "full_access" | "auto_risk"
Agent.model = ModelProfileId

agent.updatePermission { agentId, permission }
agent.updateModel      { agentId, modelProfileId }   // 复用现有 updateAgent
session.setFullThrottle { workspaceId, agentId, enabled } // 只注入提示/预算，不碰权限
risk.assess             { toolName, args, workspaceId }
risk.vote               { assessmentId, voters[], decision }
```

事件：`agent.permission_changed`、`agent.model_changed`、`session.full_throttle_changed`、`tool.denied`、`permission.risk_vote`。

### 15.7 验收标准（P0）

- 对话输入框下方可切换当前成员模型，下一条消息实际使用新模型；
- 四种权限模式可切换并持久化；`read_only` 下写文件/ shell 被硬拒绝，`workspace_write` 下工作区外写入被拒绝；
- `auto_risk` 对低风险自动放行，中风险发起投票，高风险必须人类确认；
- 满血模式开启后 system prompt 注入高预算指令，下一轮回答按 Full Throttle 行为执行；**不改变任何工具权限**，read_only 下仍拒绝写入；
- 满血模式可关闭并移除注入，`FULL THROTTLE` 标识同步消失；Agent 不能自行开启；
- 权限/模型/满血变更均写入事件日志，刷新后状态一致；
- 键盘/ARIA 可用；窄窗控制条不遮挡输入。

### 15.8 非目标（P0）

- 不做跨设备权限同步、组织级 RBAC、审计导出（P2）；
- 不让 Agent 修改自己的权限或开启满血模式；
- 不把 Full Throttle 当作权限提升、自动批准或 full access；
- 不用提示词替代执行层权限检查。

---

## 16. 一句话

**把“多个 Agent 并行干活”从演示变成可管理的工作流，靠的不是更多 Agent，而是：任务图、隔离工作区、事件日志、记忆分层、看门狗和人的验收。**

**而让多个工作区互相变聪明，靠的不是 Router 聊天，而是：可检索的经验卡、可验证的证据、可追溯的来源、可控的隐私。**
