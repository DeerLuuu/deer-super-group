# Super Agent 与 Agent 工具全景

**截至 2026 年 11 月 9 日**

> 一句话：Super Agent 不是“更聪明的模型”，而是把**调度、记忆、并发、恢复**从人身上转移到系统身上的一类 Agent 系统。

---

## 0. 一页速览

- **狭义 Super-agent**：DeepSeek Harness 团队 2026 年 10 月 31 日公开的自主 Agent 架构与开源原型（`dsh-superagent-prototype`）。核心是 Router + Worker 双层、事件驱动、订阅直通、异步全双工、存算分离、Watchdog；目标是“尽可能少占用人的注意力，尽可能多给出价值”。
- **广义“超级智能体”**：面向开放域任务、能自主规划、调用工具、操作电脑、长时运行并交付成品的一类通用 Agent 产品，如 Manus、Genspark、ChatGPT Work、Claude、Gemini Agent、Comma、WorkBuddy、Kimi Work 等。
- **工具版图分五层**：编程 Agent、通用/办公 Agent、框架/SDK、多智能体协作、协议与基础设施。
- **竞争焦点**已从“模型能力”转向“入口 + 执行环境 + 组织方式 + 生态治理”。
- **没有全能冠军**：选工具的本质，是选“你的工作资产在哪里、任务有多长、权限有多敏感”。

---

## 1. Super Agent 是什么

### 1.1 狭义：DeepSeek 的 Super-agent 架构

2026 年 10 月 31 日，DeepSeek Harness 团队公开了下一代自主 Agent 架构 **Super-agent**，并同步开源研究原型 `deepseek-ai/dsh-superagent-prototype`（MIT，官方强调“不是正式产品”）。它要解决的不是“模型会不会写代码”，而是：

> 当一个人同时只能盯住 3—5 个活跃会话时，人的注意力成了整个 Agent 流程的瓶颈。

现有 Coding Agent 以单个 Session 为单位：你在群里定了方案 A，转头在 GitHub PR 评论里改成方案 B，两条信息落在两个会话里，得你自己搬上下文；开三个 Agent 并行，你就得在三个窗口之间串行切换。Super-agent 的思路是：**用户始终只跟一个入口打交道，会话怎么拆、上下文怎么同步、任务怎么并行，由系统在底层处理。**

它给系统定了四个特征：

| 特征 | 含义 |
|---|---|
| **连续** | 在 IM、GitHub 评论等熟悉界面里交互，跨渠道理解同一件事 |
| **高效** | 不用等上一个任务做完就能接新指令，多任务并行 |
| **主动** | 持续观察环境事件，值得处理就推进，不需要介入时保持安静 |
| **持久** | 始终在线，长期运行中出异常能自己恢复 |

支撑这四个特征的，是五个相互配合的机制（官方拆为五个模块，这里按“机制”归纳为六件事）：

1. **Router + Worker 双层架构**
   - Router 常驻，承接所有人类交互、维护全局上下文、负责任务分派；它不执行具体任务，甚至可以没有 Bash 工具，用较轻的模型即可。
   - Worker 上下文隔离，挂载完整执行工具，端到端负责一个任务；不直接对外说话，结果由 Router 统一回复；Worker 自己内部还可以再开 Subagent。
   - 关键区别：主 Agent + Subagent 里，主 Agent 要吃透任务、参与执行、拆步骤、汇总；Router 只“派整单”，每个任务由一个 Worker 从头跟到尾。

2. **事件驱动**
   - 群聊消息、PR 评论、CI 结果都是 Trigger。
   - 两级过滤：程序层 Fast Path 按来源、群组、白名单先筛掉大部分噪音；语义层 Slow Path 再把候选交给模型判断要不要行动。
   - 效果：没人 @ 它，它也可能自己发现“这个功能好像挂了”，复现、修复、提 PR。

3. **订阅与直通**
   - 一个 Worker 接手某个 PR 后，直接订阅这条 Thread；后续评论、CI 结果由程序直接送达它，不再经过 Router。
   - 订阅是多对多的：两个 Worker 订阅同一个 PR，能看到彼此的操作，自行发现冲突。
   - 实测可让 Router 少做约 30% 的判断，读缓存 Token 从 2,323 万降到 1,773 万（约省 37%）。

4. **上下文当缓存管**
   - 高频信息内联进上下文，长内容截断后留“续读入口”；每个对象内联下一跳 ID，Router 能从一条消息顺着 Thread、Worker Session 找回旧任务（链式召回）。
   - 团队的原话：“浪费上下文窗口，就是浪费模型的智能。”

5. **异步全双工**
   - 把派活、跑命令等耗时操作改成异步 `start()` / `stop()`：Router 派完活立即能听下一句；Worker 跑长测试时，PR 下有人留言照样能收到。
   - 后台跑任务、前台正常对话，两头同时进行。

6. **存算分离 + Watchdog**
   - Agent Loop 的计算放云端，会话状态单独存数据库，代码仓库和本地工具链留在用户机器上（每台机器只放一个很轻的小程序接收指令、执行、回传）。
   - 机器离线不丢任务；换一台开着的机器继续干；需要本机凭据/内网服务的任务，等机器上线再自动接上。
   - Watchdog 是一个独立会话的 Agent，定时巡检每个 Worker：除了接口报错，还判断有没有实质进展、有没有陷入无效循环、方向有没有跑偏，发现问题及时介入。

**初步实验**（约 300 条消息、20 项工作请求，合成负载，每种方案跑 5 次）：

| 方案 | 任务完成时间 p50 | 任务完成时间 p95 |
|---|---|---|
| Super-agent（双层 + 订阅直通） | 12.4 分钟 | 15.7 分钟 |
| 单 Session + Subagent 工具（中性提示） | — | 29.5 分钟（5 次都没调用 Subagent） |

另外两组数据：
- 去掉订阅直通，完成时间基本不变，但 Router 决定数增加约 30%，读缓存 Token 增加约 37%。
- Trigger 到达速率从约 1 条/分钟升到约 40 条/分钟，平均 batch 从 1.0 升到 2.8，单次请求耗时只从 2.5 秒增到 3.9 秒，单个决定分摊的推理时间从 6.4 秒降到 1.6 秒——消息越堆，单条越便宜。

**局限**（官方自己也承认）：
- 基于合成负载和简化环境，只作初步参考。
- 多会话维护导致读缓存 Token 本身就高于单会话。
- 原型权限很大（Worker/Router 以 `danger-full-access` 运行），官方建议独立系统账号、先 `observe` 模式、不要默认自动合并。
- 代码大量由 Coding Agent 完成，可能有 Bug，与内部版本/技术文章描述不完全一致。

### 1.2 广义：行业里的“超级智能体”

在更宽的产品语境里，“超级智能体（Super Agent / 超级智能体）”通常指：

> 一个面向开放域任务的通用 Agent：能自主规划、调用工具、操作电脑/浏览器、跨应用执行，长时间运行并交付文档、表格、PPT、网站等成品，具备记忆、多 Agent 协作和企业级权限治理。

它与几类相邻形态的区别：

| 形态 | 核心 | 与 Super Agent 的差别 |
|---|---|---|
| Chatbot | 回答问题 | 不交付结果、不持续执行 |
| Copilot | 在某个软件里辅助 | 不拥有完整任务、不跨应用 |
| 垂直 Agent | 单一场景（客服、审单、转录） | 不做开放域规划 |
| 工作流自动化（RPA/n8n） | 固定路径 | 不做临场决策/动态拆解 |
| Coding Agent | 写代码、跑工程 | 场景窄；Super Agent 可把 Coding Agent 当 Worker |
| Super Agent | 目标 → 计划 → 执行 → 交付 | 通用、长时、跨应用、可组织成团队 |

代表产品：Manus、Genspark、ChatGPT Work、Claude（Cowork 合并后）、Gemini Agent、Comma、WorkBuddy、豆包工作、Kimi Work、QoderWork、TRAE Work 等。它们不一定都实现了 DeepSeek 那套 Router/Worker 架构，但产品目标一致：**从“给答案”变成“交结果”。**

### 1.3 与普通 Agent、主 Agent + Subagent 的区别

| 维度 | 普通 Agent | 主 Agent + Subagent | Super-agent |
|---|---|---|---|
| 交互入口 | 单会话 | 单会话 + 派生 | 单入口、跨渠道 |
| 任务拆解 | 人拆、人盯 | 主 Agent 拆、参与执行 | Router 派整单，Worker 端到端 |
| 上下文 | 会话内 | 主上下文汇总 | Worker 隔离，Router 全局 |
| 并发 | 串行 | 有限并行 | 多 Worker 并行 |
| 触发方式 | 人输入 | 人输入 | 事件 / 定时 / 人 |
| 生命周期 | 进程内 | 进程内 | 常驻、存算分离 |
| 异常恢复 | 人工 | 人工 | Watchdog + 重试 |
| 成本 | 低 | 中 | 高（Token + 协调） |

一个类比：
- 普通 Agent = 一个能力很强的员工，但你是他的项目经理。
- 主 Agent + Subagent = 项目经理带几个实习生，项目经理仍要拆活、盯进度、汇总。
- Super-agent = 一个常驻的“总管/调度台” + 一支可并行的专业团队；你只跟总管说话，总管负责分派、追踪、回收；系统还能自己监听事件、自己巡检。

### 1.4 为什么是现在

- **模型**：长上下文、工具调用、computer use、长程任务能力跨过可用阈值。
- **协议**：MCP 统一工具接入，A2A 解决 Agent 互操作，Skills 把流程封装成可复用能力。
- **基础设施**：云沙箱、持久化会话、可观测性、成本路由逐渐成熟。
- **经济**：单 Token 成本下降，但多 Agent 并行让总 Token 上升；“用更多 Token 换更短、更稳的完成时间”成为可接受的交易。
- **竞争**：入口从 IDE/聊天框上移到桌面、OS、云端常驻进程；谁占住“执行入口”，谁就掌握下一层分发的权力。

---

## 2. Agent 工具版图

先给一张“地图”：

| 层级 | 代表 | 解决的问题 |
|---|---|---|
| 编程 Agent | Claude Code、Codex、Cursor、Copilot/Agent HQ、Devin、Trae、Qoder、CodeBuddy、Kimi Code、OpenHands | 写代码、改仓库、跑测试、提 PR |
| 通用/办公 Agent | ChatGPT Work、Claude、Gemini Agent、Manus、Genspark、Comma、WorkBuddy、豆包工作、Kimi Work、QoderWork、TRAE Work、Marvis | 跨应用完成知识工作、交付成品 |
| 框架/SDK | LangGraph、CrewAI、OpenAI Agents SDK、Claude Agent SDK、Google ADK、Microsoft Agent Framework、Mastra、Eve、Pydantic AI、Vercel AI SDK | 自己造 Agent / 把 Agent 嵌进产品 |
| 多智能体协作 | Claude Code Agent Teams、DSH AgentTeams、GitHub Agent HQ、Cursor Agents Window、Codex 多 Agent、MiniMax Agent Team、Kimi Agent Swarm | 让多个 Agent 组成团队 |
| 协议/基础设施 | MCP、A2A、Agent Skills、AGENTS.md、沙箱、记忆、可观测 | 让 Agent 能接工具、能互通、能治理 |

### 2.1 编程 Agent

| 产品 | 形态 | 核心特点 | 代价 / 适合 |
|---|---|---|---|
| **Claude Code**（Anthropic） | 终端、IDE、Web、手机、Slack、GitHub Actions | 完整 harness：文件/命令、子 Agent、hooks、Skills、MCP、Agent SDK；长任务与代码库理解强；Agent Teams 实验性 | 绑 Claude 模型；重度使用额度紧；适合深度工程 |
| **OpenAI Codex** | 云端沙箱、CLI、IDE、桌面 | 异步并行、worktree 隔离、直接出 PR；GPT-5.5/5.6；周活 500 万；非程序员占比上升 | 国内不可直连；贵；适合无人值守重构 |
| **Cursor** | AI 原生 IDE | Cursor 3 转向 agent-first：Agents Window、多 Agent 并行、Composer 2；本地审阅体验好 | 信用点计费；适合 IDE 派 |
| **GitHub Copilot / Agent HQ** | IDE + GitHub 平台 | Agent HQ 统一调度第三方 Agent；issue → PR；企业治理/权限 | 深绑 GitHub；适合平台化团队 |
| **Gemini CLI / Antigravity** | 终端 + agentic IDE | Gemini 模型；免费额度；Google 生态；多模态 | 生态外一般；适合 GCP/Google 用户 |
| **Devin**（Cognition） | 云端 + Devin Desktop | 自主 SWE；SWE-1.6；企业合规/FedRAMP；“army of Devins”；内部 89% 代码由 Devin 提交 | 贵；适合大企业/外包 |
| **Windsurf** | IDE | Cascade Agent；被 Cognition 收购，与 Devin 融合 | 定位夹在 Cursor/Claude Code 之间 |
| **Kiro**（AWS） | IDE | 规格驱动：requirements/design/tasks；结构化 | 适合强流程团队；灵活性弱 |
| **Trae**（字节） | AI IDE | 免费；SOLO/Work；国内直连；字节生态 | 企业治理薄；适合原型/个人 |
| **Qoder**（阿里） | IDE/CLI/JetBrains | Repo Wiki、Harness 循环、多模型、三层安全审查；阿里云 | 生态绑定；适合国内企业 |
| **CodeBuddy**（腾讯云） | IDE/插件/CLI | 混元 + 多模型；腾讯云企业能力 | 腾讯生态；适合企业 |
| **Kimi Code**（月之暗面） | CLI/桌面/VS Code | K3.1 Pro 1M 上下文；Agent Swarm；Skills/Hooks/MCP；开源权重 | 生态较新；适合长上下文/国产化 |
| **开源系** | OpenHands、Cline、Roo Code、Kilo Code、Aider、OpenCode | BYOK、本地、可审计、便宜 | 配置/效果参差；适合极客/内网 |

**解读：**
- 编程 Agent 已经分化为三种形态：**终端原教旨**（Claude Code、Codex CLI、Kimi Code）、**AI 原生 IDE**（Cursor、Trae、Qoder、Windsurf）、**平台化**（Copilot/Agent HQ、Codex 云端、Devin）。
- 竞争点从“补全准不准”变成“**长任务能不能一次交付**”：上下文管理、测试/验证、权限、沙箱、评审闭环。
- 国产工具的核心优势是**可直连、多模型、合规/私有化、价格**；海外工具的核心优势是**模型上限、harness 成熟度、生态**。

### 2.2 通用/办公 Agent

| 产品 | 形态 | 核心特点 | 适合 |
|---|---|---|---|
| **ChatGPT Work**（OpenAI） | 云端 + 桌面 | GPT-5.6 + Codex；跨应用；内置浏览器/computer use；1400+ 插件；定时任务；Sites | 海外、跨应用知识工作 |
| **Claude**（Cowork 合并后） | 云端 + 桌面 + 手机 | 聊天与 Cowork 合一；Docs/Slides/Design；Skills/Connectors；定时；默认先询问 | 重推理/写作/编码 |
| **Gemini Agent**（Google Cloud） | 云端（Workspace） | “接受目标而非指令”；多 Agent；多模型（含 Claude）；四层记忆；企业治理 | Google Workspace 企业 |
| **Manus** | 云端 | 过程可见、可干预；云电脑；定时；主模型 + Runtime | 美国市场、过程控 |
| **Genspark** | 云端 | 结果导向；30+ 模型路由；call/music/video；all-in-one | 日韩、长尾多任务 |
| **Comma**（AFK） | 本地 + 云 | Lead + Subagents；Salix 连本地；Tasks/Loops；常驻 | 个人常驻助理 |
| **WorkBuddy**（腾讯） | 桌面 + 云 | 专家/助理/团队；11 模型；企微/腾讯文档；腾讯称日活中国效率智能体第一 | 腾讯生态企业 |
| **豆包工作**（字节） | 桌面 | 飞书；TRAE + 扣子；Office；任务模式；免费档 | 飞书生态 |
| **Kimi Work**（月之暗面） | 桌面（macOS 优先） | 长文档；本地沙箱；子 Agent 上限 300；金融/科研/法律库 | 知识工作/调研 |
| **QoderWork**（阿里） | 桌面 | 本地优先；屏幕/浏览器/应用操作；记忆/反思/技能进化；钉钉 | 阿里/合规 |
| **TRAE Work**（字节） | 桌面 + 移动 + Web | IDE 演进；Work + Code；飞书；免费 | 字节/飞书 |
| **Marvis**（腾讯） | 系统级 | 主 Agent + 5 专家（文件/系统/应用/浏览器/搜索）；手机远程 | 电脑管理/尝鲜 |
| **千问办公/阶跃/AutoClaw/QClaw** | 桌面/本地 | 连接器/技能/MCP；OpenClaw 系；一键本地；IM 远程 | 国内生态/隐私 |

**解读：**
- 通用 Agent 的产品哲学分两派：**卖过程**（Manus：可见、可干预、可追踪）与**卖结果**（Genspark：给目标、等交付）。两派都能跑通，取决于用户所在市场的 SaaS 成熟度。
- 国内产品普遍走“**生态嵌入**”路线：不重构 OS，而是接入企微/飞书/钉钉/Office，用组织权限和数据落地。
- 另一条路线是“**OS/系统层**”：Marvis、QoderWork、Comma、QClaw，直接操作文件、应用、浏览器，争夺“用户如何使用电脑”这一层。
- 同质化严重：几乎都支持多模型、Skills、MCP、定时任务、远程控制；差异化在**场景 Know-how、生态数据、权限治理、交付质量**。

### 2.3 框架与 SDK

| 框架 | 语言/定位 | 特点 | 适合 |
|---|---|---|---|
| **LangGraph** | Python/JS | 图编排、持久状态、HITL、checkpoint；1.2.x | 长流程/生产 |
| **CrewAI** | Python | 角色化 Crew；上手快；Flows；安装重、Token chatter | 多 Agent 原型 |
| **AutoGen/AG2** | Python | 对话式多 Agent 先驱；维护/分叉 | 研究/存量 |
| **OpenAI Agents SDK** | Python | 极简、handoffs、guardrails、sessions、tracing；0.x | OpenAI 栈 |
| **Claude Agent SDK** | Python/TS | 完整 Claude Code harness；文件/命令/子 Agent/hooks；Token 开销大 | 电脑操作型 Agent |
| **Google ADK** | Python/Java/Go/TS | 多 Agent 层级、workflow runtime、eval；2.0 | GCP |
| **Microsoft Agent Framework** | .NET/Python | AutoGen + Semantic Kernel 合并；1.0；harness/hosted/CodeAct | Azure 企业 |
| **Mastra** | TypeScript | 全栈：Agent/workflow/memory/evals/studio；1.0 | TS 产品 |
| **Eve**（Vercel） | TypeScript | durable execution、文件式项目、channels；1.0 RC | 长时/跨渠道 |
| **Vercel AI SDK** | TypeScript | 流式 UI、provider 统一、v7 workflow agent | Web 产品内嵌 |
| **Pydantic AI** | Python | 类型安全、结构化输出、durable；2.0 | 数据/后端 |
| **Dify/Coze/n8n** | 低代码 | 可视化流程、连接器；不是 code-first | 业务人员/集成 |

**解读：**
- 框架的本质差异不是“能不能调工具”（2026 年这是及格线），而是：**持久状态、人类审批、可观测、Token 预算、部署形态**。
- 一个实测细节：同一道题、同一个模型，LangGraph 约 1,288 输入 Token，CrewAI 约 1,432；Claude Agent SDK 约 35,000（大部分是缓存读，但上下文窗口占用真实存在），中位延迟 8.5 秒 vs 2.5 秒。**Harness 越完整，能力和开销一起上升。**
- 选框架先看语言和部署，不要看功能清单：TS 产品选 Mastra / Vercel AI SDK；Python 重流程选 LangGraph；OpenAI 栈选 Agents SDK；Claude 栈选 Claude Agent SDK；Azure 选 MAF；GCP 选 ADK。

### 2.4 多智能体/团队协作

| 系统 | 机制 | 特点 |
|---|---|---|
| **Claude Code Agent Teams** | Lead + Teammates、共享任务列表、Mailbox、直接互发消息；实验性、默认关闭 | 3—5 人最佳；Token 成本高；不能嵌套团队；每会话一个团队 |
| **DSH AgentTeams** | Captain + 成员、任务 DAG、质量门禁（requirements/implementation/verification/review/repair/integration）、Watchdog、分阶段审批 | 质量闭环、可审计；当前环境 |
| **GitHub Agent HQ** | 平台级 mission control | 多厂商 Agent、企业治理 |
| **Cursor Agents Window** | IDE 内多 Agent 并行 | 适合本地多任务 |
| **Codex** | 多 Agent/worktree | 云端并行、无人值守 |
| **MiniMax Agent Team / Kimi Agent Swarm** | 角色分工/大规模协作单元 | 长任务并行、验证制衡 |
| **MetaGPT/ChatDev** | 角色扮演 SOP | 研究/演示 |

**解读：**
- “多 Agent”正在从“一个主 Agent 开几个 Subagent”升级为“**有共享任务板、邮箱、依赖、验收的团队**”。
- Claude Code 的文档把边界说得很清楚：Subagent 适合“只要结果”的聚焦任务；Agent Teams 适合“需要讨论、互相挑战、协同”的复杂任务；后者 Token 成本显著更高，顺序任务/同文件编辑反而更差。
- DSH AgentTeams 的差异在于把“质量门禁”和“评审/修复循环”做成了显式任务类型，而不是只靠提示词约束——这对生产级交付更关键。

### 2.5 协议与基础设施

| 层 | 代表 | 作用 |
|---|---|---|
| 工具/上下文 | **MCP** | 把外部系统接成 Agent 可调用的工具；事实上的“USB-C” |
| Agent 互操作 | **A2A** | 不同 Agent/不同厂商之间发现、委派、协作 |
| 能力封装 | **Agent Skills（SKILL.md）** | 把流程、脚本、模板封装成可复用、按需加载的技能 |
| 仓库约定 | **AGENTS.md** | 把项目规范、命令、边界写进仓库，Agent 自动读取 |
| 执行环境 | 云沙箱、本地 daemon、worktree | 隔离、安全、并行 |
| 记忆 | 会话状态、长期记忆、文件记忆 | 跨会话连续性 |
| 可观测 | LangSmith、Langfuse、OTel | 追踪、评估、成本 |

**解读：**
- 这一层是“Super Agent”能成立的前提：没有 MCP/Skills，Agent 接一个新系统就要写一次适配；没有 A2A，多厂商 Agent 无法互派任务；没有沙箱和权限，常驻 Agent 不敢放开手。
- 选型时优先把工具接成 MCP Server：编排代码不可移植，工具和提示词可以。

---

## 3. 横向对比：七个趋势

1. **从“回答问题”到“交付结果”**
   用户输入从“帮我写个函数”变成“帮我把这件事办完”；交付物是文档、PPT、表格、网站、PR，而不是一段文本。

2. **从“单 Agent”到“团队/舰队”**
   Router + Worker、Lead + Teammates、Agent HQ、Agent Swarm——组织方式在重构。关键不是堆 Agent，而是任务边界、共享状态、验收机制。

3. **从“应用内”到“OS/云端常驻”**
   Agent 从 IDE、聊天框里走出来，进入桌面、文件系统、浏览器、手机远程控制、云端后台。入口位置上移，权限和治理问题随之放大。

4. **从“Prompt Engineering”到“Harness / Context Engineering”**
   决定效果的是：上下文怎么组织、工具怎么描述、权限怎么收放、长任务怎么压缩、失败怎么恢复、结果怎么验证。模型只是其中一环。

5. **从“模型绑定”到“多模型路由/成本优化”**
   Genspark 30+ 模型路由、Gemini Agent 同时支持 Gemini/Claude、WorkBuddy 内置 11 款模型、Qoder/CodeBuddy 多模型切换——“用对的模型做对的事”比“用最强的模型”更划算。

6. **从“封闭产品”到“协议/生态/治理”**
   MCP、A2A、Skills、插件市场、企业 RBAC/审计/私有化。单点能力容易被追上，生态和治理是护城河。

7. **从“个人提效”到“组织生产力”**
   专家/数字员工、团队空间、管理后台、用量与权限——2026 年 To B 产品的共同转向。

---

## 4. 怎么选：一张决策清单

**先问四个问题：**

1. **工作资产在哪里？**
   - 代码在 GitHub/GitLab → Claude Code、Codex、Cursor、Copilot/Agent HQ
   - 文档在飞书/企微/钉钉/Google Workspace → 豆包工作、WorkBuddy、Gemini Agent、千问办公
   - 文件/应用在本地、且敏感 → QoderWork、Kimi Work、Comma、QClaw、本地开源
2. **任务有多长？**
   - 分钟级、单文件 → IDE 补全/Chat
   - 小时级、多文件 → Coding Agent / 桌面 Agent
   - 天级、跨应用、常驻 → Super Agent 形态（Manus、ChatGPT Work、Claude、Gemini Agent、Comma）
3. **权限有多敏感？**
   - 可上云 → 云端沙箱
   - 数据不出境/不出内网 → 本地优先、私有化、开源 + 本地模型
4. **你要“用”还是“造”？**
   - 用 → 选产品，先小范围试点，看 adoption 而不是 demo
   - 造 → 选框架 + 协议，先把工具接成 MCP，再谈编排

**按角色的快速建议：**

| 角色 | 首选 | 备选 |
|---|---|---|
| 个人开发者 | Claude Code / Codex / Cursor | Trae、Kimi Code、Cline |
| 国内研发团队 | Qoder / CodeBuddy / Trae | Kimi Code、通义灵码、CodeGeeX |
| 企业平台/治理 | GitHub Agent HQ / Copilot | Devin、Codex Enterprise、Qoder 企业版 |
| 知识工作者 | Claude / ChatGPT Work / Kimi Work | WorkBuddy、豆包工作、Manus |
| 国内企业办公 | WorkBuddy / 豆包工作 / 千问办公 | QoderWork、TRAE Work、Marvis |
| 想自建 Agent | LangGraph / Mastra / MAF / Claude Agent SDK | OpenAI Agents SDK、ADK、Pydantic AI |
| 想自建 Super Agent | Router/Worker + 事件 + 订阅 + 异步 + 持久 + Watchdog | DSH AgentTeams、Claude Agent Teams |

---

## 5. 对构建 Super Agent 产品的启示

如果目标是做“Super Agent / Agent 团队”产品，而不是再造一个 Coding Agent，值得优先想清楚六件事：

1. **Router 要轻，Worker 要强**
   Router 的职责是理解、分派、汇总、对外；不要让它陷入具体执行。把最强模型留给 Worker，把成本花在“干活的上下文”上。

2. **入口决定天花板**
   事件源（IM、GitHub、CI、邮件、日历）比多一个模型更能提升“主动感”。先接一个高频事件源，做深，不要一开始铺十个。

3. **订阅直通是规模化的关键**
   没有直通，Router 会变成消息瓶颈；有了直通，后续事件直达 Worker，Router 只处理“新单”。这是从 1 个任务到 10 个任务的分水岭。

4. **异步与持久是体验分水岭**
   用户能不能在任务跑着时插话、叫停、改需求；机器关了任务会不会丢；换设备能不能继续——这三件事决定“常驻”是不是真的。

5. **质量门禁比“更聪明的 Agent”更稀缺**
   多 Agent 最大的风险不是能力不够，而是“看起来做完了”。任务 DAG、验收标准、独立评审、失败修复、证据链，是生产级产品的核心。

6. **安全与成本要前置**
   - 权限：独立账号、最小权限、危险操作人工确认、先 observe 再放权。
   - 成本：多 Agent 的 Token 是指数级的；需要模型路由、上下文压缩、预算上限、按任务核算。
   - 评估：完成时间、人工介入率、一次通过率、单任务 Token、回归率——没有这五个指标，无法判断“Super”是不是真的。

---

## 6. 参考来源

- DeepSeek 官方原型仓库：<https://github.com/deepseek-ai/dsh-superagent-prototype>
- 七牛云《DeepSeek 开源 Super-agent 是什么》（2026-11-01）：<https://news.qiniu.com/archives/1793499698327>
- EET-China《DeepSeek Super-agent 是什么，跟普通 agent 有什么区别》（2026-11-06）：<https://www.eet-china.com/mp/a537285.html>
- 观察者网《这次 DeepSeek 和硅谷团队形成共识？》（2026-11-02）：<https://baijiahao.baidu.com/s?id=1880735660065287684>
- 站长之家《DeepSeek 开源 Super-agent 架构》（2026-11-02）：<https://www.chinaz.com/ainews/32001.shtml>
- Claude Code 产品页：<https://claude.com/product/claude-code>
- Claude Code Agent Teams 文档：<https://code.claude.com/docs/en/agent-teams>
- Claude Cowork 与 Chat 合并（2026-09-16）：<https://claude.com/blog/cowork-is-now-claude>
- ChatGPT Work 发布（DigitalToday，2026-07-10）：<https://www.digitaltoday.co.kr/en/view/80208/openai-launches-chatgpt-work-evolves-into-work-partner>
- Gemini Agent 发布（cnBeta/网易，2026-10-08）：<https://m.163.com/dy/article/L8OLVPRR0511BLFD.html>
- 36 氪《2026，10000 个中国版 Codex 大乱斗》（2026-06-25）：<https://eu.36kr.com/zh/p/3868029236401414>
- 腾讯云《Codex 月烧 200 刀、Trae 永久免费、WorkBuddy 日活登顶》（2026-07-21）：<https://cloud.tencent.com.cn/developer/article/2712863>
- 云巴巴《桌面办公智能体怎么挑》（2026-09-03）：<https://www.yun88.com/news/13993.html>
- 36 氪《半年内收入翻倍不止，Manus 和 Genspark 跑通变现》（2026-06-17）：<https://www.c114.net.cn/industry/91304.html>
- AgentMail《The 10 Best AI Agent Frameworks in 2026》（2026-07-08）：<https://www.agentmail.to/blog/best-ai-agent-frameworks-2026>
- Microsoft Agent Framework at BUILD 2026：<https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-at-build-2026-announce/>
- Cursor 3（Digit，2026-04-03）：<https://www.digit.in/news/general/cursor-unveils-new-ai-agent-to-take-on-claude-code-and-openai-codex-what-it-can-do.html/amp/>
- Devin / Cognition（2026-05-27）：<https://cognition.com/blog/series-d>
- GitHub Agent HQ 解读：<https://www.eficode.com/insights/blog/why-github-agent-hq-matters-for-engineering-teams-in-2026>
- IT 之家《六款产品，三种形态，一个生态：AI 编程工具形态拼图（2026）》：<https://www.ithome.com/1/019/989.htm>

> 注：本文基于 2026 年 11 月 9 日前公开资料整理；产品版本、价格、功能迭代很快，落地前请以官方最新信息为准。
