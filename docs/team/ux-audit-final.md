# 交互设计、界面布局与主流程可用性 · 最终审计报告（t187）

- **任务**：t187 — 会议结论/最终报告（基于 t179–t186）
- **作者**：aria（Facilitator / UX Researcher）
- **代码基线**：main `20f7a31`（代码末次提交 `f3737d9`，含 t168/t172 历史气泡、t175 终态/重试）
- **依据**：`ux-audit-agenda.md`（t179）、`ux-audit-layout.md`（t180）、`ux-audit-workflow.md`（t181）、`ux-audit-accessibility.md`（t182）、`ux-audit-feasibility.md`（t183）、`ux-audit-content.md`（t184）、`ux-audit-qa.md`（t185）、`ux-audit-shortlist.md`（t186，黑板 bb-97）
- **性质**：报告/产品与布局裁决；**不写生产代码**，不修改 `src/`、`electron/`、`dist*/`、`branches/`
- **一句话结论**：功能深度已经足够，缺的是一条**可发现、可恢复、可完成**的工作流。保留 Dock，不做全量重写；先做 8 个 P0 切口，把“我在哪/下一步是什么/哪里出错了”投影到常驻界面，再把长内容从 Modal/长滚动移出。
- **裁决状态**：Captain 已对 t186 短名单作出裁决，本报告按裁决落定，不再投票（详见 §0）。

---

## 0. Captain 已裁决（t187 输入）

1. **范围**：批准 P0 8 / P1 7 / 不做-后置 5 类；`ux-audit-shortlist.md`（bb-97）作为最终 shortlist。
2. **一级 rail**：保留 Dock，新增常驻「一级入口 rail」（图标+短标签，可折叠）；NeedsMe/阶段/唯一 CTA 常驻。
3. **WorkflowRail**：作为工作区内的**常驻轻量阶段条**，不另开弹窗；每阶段只暴露一个主 CTA，详细动作进二级面板。
4. **窄窗**：≤960 默认 single 变体 + 侧栏自动折叠；Team 使用 `within`，不再强制 right split；恢复手动展开后不被自动覆盖。
5. **任务详情**：tab 化为 `概览 / 运行 / 评审 / Git / 历史` + sticky 动作头；Review/Merge/冲突的下一步必须在首屏可见。
6. **Settings**：保留全高 Modal/覆盖层（左侧分区），补 dirty guard 与 Modal 内保存反馈；**MergeQueue 改为 Dock 面板**（交付期高频）。
7. **性能顺序**：先 R1 流式隔离、R2 面板渲染隔离、R3 刷新降噪，再 R4 懒加载/vendor 拆分；不做全量 Dock 重写/Monaco/虚拟列表库/React Compiler/微前端。
8. **报告要求**：常驻 S1–S7、逐屏 keep/move/panel/modal、before/after、P0/P1/P2、依赖/验收/不做清单，以及首批实现拆分建议（P0 ①–④，本轮不实现）。

---

## 1. 执行摘要

### 1.1 三个最大优势

1. **Dock + 深链 + 布局持久化**已经是一个真实的多工作区容器：chat/team/tasks/runs/mailbox/board/context/polls/watchdog 可并行、可拖动/分栏、按 workspace × 变体保存；不是只能单页切换的原型。
2. **领域深度和状态覆盖完整**：任务内核、Run/attempt/lease、trace、Review gate、VCS/PR/checks/merge queue、Watchdog/预算、Memory/归档、Poll、Question/Risk Approval 都已存在，且 t154/t168/t175 等已有评审/验证基础。
3. **恢复与反馈基础比多数同类原型强**：t175 取消/失败终态 + 重试、历史 execution process、统一 EmptyState/Modal/Toast、状态 badge、`aria-live`、KernelAnnouncer、任务动作 disabled 原因——问题主要是“入口/层级/投影”不对，不是没有能力。

### 1.2 五个最大问题

1. **看不见的一级导航 + 被藏起来的辅助面板**：没有常驻 rail；主切换靠 Dock tab/▦/⌘K/Alt；Runs/Context/Polls/Watchdog 默认关闭，context/polls/watchdog 无 route；关闭面板后没有 badge/入口标记。命令面板从“加速器”变成“唯一发现路径”。
2. **讨论 → 规划 → DAG 断裂**：规划入口在 Tasks 的长表单 Modal，Chat 讨论完要换面板重输目标；`plan` 直接创建任务，没有 DAG/owner/依赖/验收预览，也不能在创建前修正；模型/权限/满血/预算“执行契约”在 Chat、Plan、Task 三处不一致且不可见。
3. **任务交付流水线埋在长滚动里**：任务详情从描述/验收/摘要 → VCS → ReviewSection → RunHistory → trace 全部纵向堆叠；动作行有 3 个 primary（运行/重试/批准）；“批准”在任务交付、代码评审、合并队列三处复用；Review/Merge/Conflict 的下一步在底部，容易漏 gate/误操作。
4. **窄窗与三栏存在结构性冲突**：1100 默认窗口 Dock≈844、主组≈473；960 侧栏稍窄时 Dock≈774、主组≈403，但 Tasks `minWidth=560`、Team 仍 right split；single/900/760 下 `#/team` 可能直接裁切。裁决采用 ≤960 single + 侧栏自动折叠 + Team `within`（P0-1），并保留手动展开不被覆盖。
5. **信任与性能基础设施风险**：错误横幅仍可能使用 provider 原文（A11Y-06 blocker：终态脱敏了，banner/复制详情没有）；Settings 无 dirty guard、Modal 叠层/快捷键穿透/背景非 inert；同时 App 单组件 + 内联 `renderPanel` 让每个流式 token/事件刷新重渲染所有已挂载面板，长历史/2000 trace/5 IPC 是结构性成本。

### 1.3 总体判断

**当前产品是“一组强面板”，还不是“一条工作流”。** 不应重做 Dock/数据层；应做**投影层**改造：

- 常驻最小集 S1–S7（工作区就绪、一级入口、WorkflowRail、NeedsMe、当前任务/来源、关键错误、Chat composer/契约）；
- 8 个 P0：窄窗自适应、可见 rail、WorkflowRail+NeedsMe、Chat→Plan 可编辑 DAG、任务交付流水线、信任/恢复、首用就绪、流式/刷新性能；
- 7 个 P1：Settings 全高 Modal 守卫 + MergeQueue Dock 面板、历史/翻译/失败恢复、辅助面板 route/溢出、a11y 基线、任务/团队去重+契约、内容/术语/空态、第二批数据/性能（含 R4 懒加载）；
- 不在本轮：Monaco/虚拟列表/React Compiler/微前端、全量 Dock 重写、邮箱线程、星图 >150/聊天虚拟化、字号三档、插件/MCP/Skills 真功能、owner/依赖数据层重构。

**裁决执行**：Captain 已批准 t186 的 P0 8 + P1 7（bb-97）；先修 P0-6 的 secret 泄漏，再按 §5 的顺序分阶段实现；每个 P0/P1 独立任务、独立评审，不把审计建议当一次性大改。

---

## 2. 当前信息架构与四层模型

### 2.1 当前屏幕/面板/弹窗清单

| 层 | 表面 | 当前入口/默认 | 备注 |
|---|---|---|---|
| Shell | Welcome / 打开工作区 | 无 workspace 时全屏 | 只有打开/最近/错误；无模型/Key/团队就绪/下一步 |
| Shell | Sidebar | 常驻可折叠（180–480，默认 250） | 工作区、⌘K、＋新建、刷新、▦面板、⚙设置、导航提示、Key/Mock、成员数、失败 pill；**无一级导航列表** |
| Shell | Error banner | 常驻（有 error 时） | 最近一条错误 + 复制详情/关闭；可能泄漏原文 |
| Shell | Watchdog topbar | 有 snapshot 时常驻 | 看门狗入口、今日预算、open alerts 数 |
| Shell | Dock host | 常驻 | 主组 + Team 右组；最多 4 组；布局持久化；无 drawer |
| Dock | `chat` 对话 | 主组默认可见；`#/chat` | 对话/轨迹内部 tab；composer；模型/权限/满血；上下文/压缩/清空；任务上下文返回 |
| Dock | `team` 团队 | 右组默认可见；`#/team` | 总进度、合并队列/记忆/运行入口、成员列表/编辑/删除、任务星图、选中任务摘要 |
| Dock | `tasks` 任务 | 主组 tab；`#/tasks` | SchedulerBar；搜索/状态过滤/可收起列表；任务详情含动作、runtime、描述/验收/摘要、VCS、Review、RunHistory、trace |
| Dock | `runs` 运行 | 默认关闭；`#/tasks?t=&r=` | 调度、活跃/队列、当前任务动作、Run 详情/时间线；与任务 RRunHistory 重复 |
| Dock | `mailbox` 邮箱 | 主组 tab；`#/mailbox` | 列表/详情/Compose Modal；无未读/线程（后置） |
| Dock | `board` 记忆 | 主组 tab；`#/board` | MemoryWorkbench：黑板/备忘录/归档审批、检索、发布/治理、投票入口 |
| Dock | `context` 上下文 | 默认关闭；无 routeTab | 从 Chat/Task 打开；任务上下文返回；无固定入口 |
| Dock | `polls` 投票 | 默认关闭；无 routeTab | 从面板启动器/⌘K/任务/记忆打开；结果入口弱 |
| Dock | `watchdog` 看门狗 | 默认关闭；无 routeTab | 预算/成本/告警/hold/handoff/fallback/健康 |
| Dock | `settings` 设置 | 现为独立 Modal；`#/settings` | 旧 `settings` PanelKey 仍在注册表；恢复旧布局可能空面板 |
| Overlay | 设置 Modal | ⚙、⌘K、`#/settings`、Git 深链 | 7 段：模型/翻译/Git/插件/MCP/Skills/团队；长内容 Modal |
| Overlay | 合并队列 Modal | Team 进度、⌘K、`#/tasks?merge=1` | 多项 branch/checks/PR、批准/合并/waive；关闭丢上下文 |
| Overlay | 任务 Compose/Plan/Delete | 任务页、⌘K、空态、详情 | Compose/Plan 短表单；Delete 危险确认；Plan 无预览 |
| Overlay | Question / Risk Approval | assistant 提问 / auto_risk | 阻塞 Modal；Risk 有 120s 超时；有互斥逻辑 |
| Overlay | KernelConfirm / Member edit / Memory governance / Poll create | 各对象动作 | 短表单/危险确认 |
| Overlay | Command Palette / Toast | ⌘K / 写操作 | 导航/命令/实体搜索；toast ≤3、5s |
| Inline | Task VCS / ReviewSection / RunHistory / trace | 任务详情内 | 无 tab；长滚动 |
| Inline | Team 任务摘要 | Team 右栏内 | 与 Tasks 详情重复可操作入口 |
| Help | 无全局帮助/术语/错误目录 | — | 目前只有零散 tooltip/hint |

**当前没有**：可见一级导航、统一 attention 队列、独立帮助/术语中心、drawer。**当前有**：Dock 面板、Modal、内联二级区、命令面板、toast/error banner。

### 2.2 目标四层模型

> 原则：只把“随时要看/会改变下一步/隐藏会误操作”放常驻；长内容进面板；只有短/原子/阻塞动作进 Modal；解释进帮助。

#### 第一层：必须常驻（S1–S7）

| # | 常驻信息 | 位置 | 内容/状态 |
|---|---|---|---|
| S1 | 工作区身份 + 就绪度 | 侧栏顶部/一行 | 名称/路径、模型/Key/Mock、成员数、是否可开始 |
| S2 | 一级入口 rail | 侧栏 rail（图标+短标签，可折叠） | 对话/任务/团队/记忆/邮箱 + 打开态/badge/route；Dock 仍是组内切换 |
| S3 | 当前阶段 + 唯一下一步 | WorkflowRail 常驻轻量阶段条（不另开弹窗） | 讨论→计划→运行→评审→交付→记忆；当前 stage + 每阶段 1 个主 CTA；详情进二级面板 |
| S4 | NeedsMe 汇总 | rail badge + 顶部短条 | 失败/阻塞/待评审/待合并/告警/预算 |
| S5 | 当前任务/上下文/来源 | 任务面板头部/面包屑 | 当前任务、Run、来源（Chat/Team/Tasks） |
| S6 | 关键错误/恢复 | 顶部 inline banner | 脱敏摘要 + 1 个恢复动作 + 详情；非仅 toast |
| S7 | Chat composer + 执行契约 | Chat 面板 | 模型/权限/满血/上下文 chip；发送/停止 |

#### 第二层：默认收起、按钮/路由打开的面板

| 内容 | 落位 | 打开方式 |
|---|---|---|
| Runs/完整监控 | 二级面板/任务 `Runs` tab | 任务 Runs、监控入口、`?run=`；默认收起 |
| Context | 二级面板 | Chat/任务“上下文”；保留返回源 |
| Polls | 二级面板 + 结果入口 | 任务/记忆发起后打开；保留计数/decision |
| Watchdog/预算详情 | 二级面板；topbar 仅预算/告警数 | topbar 数字、NeedsMe |
| Review diff / Git | 任务内 `评审`/`Git` tab | Task Workspace；不是任务详情底部内联 |
| MergeQueue | **Dock 面板**（交付期高频）；Modal 仅单次“确认合并” | Team/Rail badge、`?merge=1`、Task Git tab |
| Task History/trace | 任务 `历史` tab + 分页/增量 | Task Workspace |
| Memory 归档/TTL | 记忆面板内 tab + badge | 记忆 → 归档审批 |
| 任务列表/详情、Team、Chat、Memory、Mailbox | Dock 面板（保留） | rail/tab/深链 |

#### 第三层：按钮触发的短 Modal（≤1 屏、单决定）

- 新建任务、任务删除、成员编辑、Poll 创建、记忆发布/复核/TTL/归档/提升、Kernel 确认、Question、Risk Approval。
- **Settings 特例**：保留全高 Modal/覆盖层（左侧分区），但必须有 dirty guard + Modal 内保存反馈/错误/重试；它是“长 Modal 的唯一批准例外”，不是普通短 Modal。
- **原则**：必须有明确 onClose/脏确认/焦点回源；同一时刻只允许一个一级 Modal；背景 inert；Esc 只关顶层；全局快捷键不穿透。
- **不适合普通 Modal**：Plan Draft（可编辑 DAG，>1 屏）、Review diff、MergeQueue 面板、任务详情；Settings 按上述全高覆盖层例外处理。

#### 第四层：帮助（非主界面、可关闭、不阻塞）

- 首用工作流卡（Router→任务→Run→评审→记忆）、术语表（Run/attempt、checks、blocker、head/base、quorum/decision、handoff/hold/fallback）、错误目录（code→标题/原因/下一步）、快捷键/Dock 帮助、空态示例。
- 入口：Welcome 首次卡、`?`、命令面板、侧栏一次提示；不占常驻空间。

### 2.3 当前 IA 与目标模型的差异

| 当前 | 目标 | 差异 |
|---|---|---|
| 无 rail；Dock tab/▦/⌘K | 常驻 rail + Dock 组内 tab | 新增入口层，但**不替换 Dock** |
| failed pill + Team 进度 + topbar + 详情 | S4 NeedsMe 统一汇总 | 状态投影，不新增事实源 |
| Chat/Tasks/Plan 分离 | Chat→Plan Draft→Tasks | 规划入口回到讨论，增加预览/确认 |
| 任务详情长滚动 | Task Workspace tabs + sticky CTA | UI 分区，不改数据层/gate |
| Settings/MergeQueue Modal | Settings 全高 Modal（dirty/save 守卫）；MergeQueue Dock 面板 | 长内容出普通 Modal；Settings 保留全高覆盖层 |
| 无帮助/术语 | Help 层 | 解释性内容不进常驻 |

---

## 3. 逐屏建议（保留 / 移动 / 新增 / 删除）

> 以下为产品/IA 建议，不是实现细节；“移动”指层级/入口变化，不一定改代码位置。

### 3.1 对话（Chat）

- **保留**：Chat 作为主流程起点和默认主面板；历史 execution process、t175 终态气泡/预填重试、composer、对话/轨迹内部 tab、Context 入口、模型/权限/满血控制。
- **移动**：把“规划”从 Tasks Modal 拉回 Chat（上下文/目标 →「从这段对话规划」）；模型/权限/满血/预算从 composer 下方分散控制提升为**执行契约 chip**，在 Plan/Task/Run 之间复用。
- **新增**：Chat→Plan Draft 入口；Plan 失败 inline 恢复；关键 Chat 错误进入 S6；帮助/快捷键提示；空态示例旁加“配置模型/使用 Mock”。
- **删除/收敛**：不删除轨迹（审计需要）；但明确“过程气泡”和“轨迹 tab”的分工，避免两套过程视图无解释。**理由**：主流程起点必须能直接产生计划，而不是把用户推到另一个面板重述目标。

### 3.2 团队（Team）

- **保留**：团队总进度、成员状态、任务星图、运行/合并/记忆摘要入口；作为只读监控。
- **移动**：任务详情/运行/Git/评审操作统一移到 Tasks；成员 CRUD 收敛到 Team 一个 owner（Settings 只保留默认模型/跳转）；合并队列入口保留为 badge/跳转。
- **新增**：NeedsMe 计数/“需要我处理”入口；当前任务/来源始终可见；星图选中后“在任务中打开”明确。
- **删除/收敛**：Team 内可编辑任务摘要、重复的 VCS/运行详情；成员编辑与 Settings 团队表二选一。**理由**：右栏同时承担监控、成员管理、任务详情，和主任务区竞争；只读监控更适合常驻。

### 3.3 任务（Tasks）

- **保留**：任务列表、搜索/状态过滤、可收起列表、SchedulerBar、任务状态/下一步、RunHistory/trace 数据。
- **移动**：VCS/Review/RunHistory/trace 从纵向堆叠改为 **Task Workspace tabs**：`概览 | 运行 | 评审 | Git | 历史`；Review/Merge/冲突的下一步放到任务头部/sticky；RunPanel 作为二级详情。
- **新增**：唯一 primary（由 `taskNextStep` 决定）+ 其余动作 overflow；术语分域（批准任务交付 / 通过代码评审 / 批准入队 / 确认合并）；Plan Draft 确认后进入任务列表；冲突/blocker 的“处理冲突/去评审”固定入口；sticky 动作头首屏可见。
- **删除/收敛**：3 个 primary 同屏；任务详情与 Team 双可操作详情；底部隐式 Review gate。**理由**：任务交付是主流程最长的一段，必须按阶段分区，而不是让用户滚 2–3 屏找按钮。

### 3.4 记忆（Memory）

- **保留**：MemoryWorkbench、黑板/备忘录/归档审批内部 tab、检索/scope、发布/治理、归档 badge。
- **移动**：从主组 tab 提升为 rail 一级入口（`记忆`）；任务完成卡提供“发布到记忆/查看相关记忆”；Poll 结果入口从记忆/任务进入。
- **新增**：完成后记忆草稿、相关记忆/反向链接（先只做任务/Q2 关联，不重后端）、归档待办 badge、统一“记忆/黑板/备忘录”说明。
- **删除/收敛**：把“黑板”作为记忆内部的领域/视图名，不再作为顶层产品名；避免“记忆=黑板”的二选一。
- **理由**：记忆是主流程闭环的最后一环，不能只是隐藏 tab 和可选支线。

### 3.5 邮箱（Mailbox）

- **保留**：列表/详情/Compose Modal；作为团队沟通面板。
- **移动**：rail 一级入口（低优先级）；Compose 仍 Modal；从任务/评审“发送到…”暂不做（C19 未采纳）。
- **新增**：未读 badge/线程/回执列为 P2，不在本轮主流程；至少保留 route/入口。
- **删除/收敛**：不删除；不把它塞进主流程。**理由**：邮箱不是“指挥 AI 开发”的必经步骤，过度投入会扩大范围。

### 3.6 运行 / 看门狗（Runs / Watchdog）

- **保留**：SchedulerBar、RunPanel、RunHistory、topbar 预算/告警数、Watchdog 面板的预算/告警/hold/handoff。
- **移动**：完整 Run 监控进任务 `运行` tab/二级面板；Watchdog 详情进二级面板；topbar 只保留预算/告警数并接入 NeedsMe；“看门狗”改为用户语言（如“运行监控/限额”）或加副标题。
- **新增**：route/hash、打开态/badge、告警“去处理”、运行中/暂停的全局状态；Run/Task 契约 chip（owner/model/permission/FT/预算）。
- **删除/收敛**：RunHistory 与 RunPanel 的重复主视图收敛为“任务内摘要 + 二级详情”；告警不只停留在 toast/topbar。**理由**：监控是跨任务的安全/状态面，必须常驻摘要 + 可下钻。

### 3.7 设置（Settings）

- **保留**：**全高 Modal/覆盖层**形态与左侧分区；7 段配置内容、子导航、保存；模型/翻译/Git/团队真实配置。
- **移动**：不迁 Dock（Captain 裁决）；插件/MCP/Skills 收进“实验室/即将支持”或隐藏；团队默认值/成员编辑收敛（Settings 只保留默认模型，成员 CRUD 去 Team）。
- **新增**：dirty/confirm、保存失败 inline/重试、关闭前确认；模型页分“连接/默认/高级”；Mock 解释；首次 Key/模型就绪入口；帮助。
- **删除/收敛**：死入口 Placeholder、开发者字段平铺、重复成员编辑、未保存静默丢失。**理由**：Settings 是长内容，但 Captain 选择保留全高 Modal 以维持现有入口；必须用 dirty/save 守卫抵消 Modal 风险，而不是半改半留。

### 3.8 上下文（Context）

- **保留**：独立 Context 面板；任务上下文返回源。
- **移动**：增加 route/“已打开”状态/rail 或任务 tab 入口；默认关闭的定位保留，但不作为唯一路径。
- **新增**：loading/error/retry；来源说明；任务上下文 breadcrumb；从任务/对话打开时保留滚动/返回位置。
- **删除/收敛**：无。**理由**：上下文跨 Chat/Task，但当前无 route、默认关闭，容易迷路。

### 3.9 合并队列（MergeQueue）

- **保留**：队列项、branch/checks/PR、批准/合并/waive、blocked 原因。
- **移动**：Modal → **Dock 面板**（交付期高频）；仅单次“确认合并”保留 Modal；从 Task Git、Team、NeedsMe、`?merge=1` 打开。
- **新增**：筛选/选择、blocked/等待计数、焦点回源、保留滚动；冲突处理下一步。
- **删除/收敛**：长 Modal 多行比较；合并审批和任务/评审“批准”的术语分域。**理由**：多行比较/多次操作/上下文需要，Dock 面板能保留滚动与任务上下文；队长已定面板，不再讨论 Modal 长列表方案。

### 3.10 评审（Review）

- **保留**：文件/diff/行内评论/blocker/decision（通过/要求修改）、200 行窗口/分页。
- **移动**：ReviewSection 从任务详情底部 → Task Workspace `评审` tab；任务头部显示 gate 摘要（blocker/reviewer/approval）；Review 队列 badge 进 NeedsMe。
- **新增**：blocker 摘要/跳转、评审人分配、通过/修改后的下一步（交付/合并）、评审摘要用用户语言。
- **删除/收敛**：长内联堆叠、任务“批准”与“通过评审”的语义混合。**理由**：评审是交付门禁，必须在任务头部可见；不是滚到底才发现的 section。

---

## 4. 主流程 before/after

### 4.1 Before（当前实际）

```text
Welcome（只打开文件夹）
  → Dock: Chat + Team 右栏（Tasks 是 tab；Runs/Context/Polls/Watchdog 默认关闭）
  → Chat 讨论（规划入口不在这里）
  → 切 Tasks → 规划任务 Modal（只填 goal）→ 直接创建 DAG → 自动选中首任务
  → 任务详情长滚动（动作 10+ / 3 primary；VCS→Review→RunHistory→trace）
  → 运行（SchedulerBar/任务按钮；Runs 默认关）
  → 评审（滚到 ReviewSection；任务批准/Review 通过/MergeQueue 批准三层）
  → 交付（Task VCS 入队 → MergeQueue Modal → 合并）
  → 切 Memory tab 发布/验证
  → 无“下一轮/下一个任务/发布到记忆”CTA
```

**表面数**：完整周期至少 4 个（Chat/Tasks/MergeQueue/Memory），加 Runs/Context/Team 可到 6–7；规划、评审、合并、记忆都不是“下一步”自然出现。

### 4.2 After（目标最小流程，不重写 Dock）

```text
Welcome / Workspace Home
  就绪：工作区 · 模型/Key/Mock · 成员 → [开始对话] [继续上次]
    │
常驻 Shell：rail（对话/任务/团队/记忆/邮箱）+ WorkflowRail（讨论→计划→运行→评审→交付→记忆）+ NeedsMe
    │
Chat：讨论 + 执行契约 chip + [从这段对话规划]
    → Plan Draft（可编辑：任务/依赖/owner/验收/风险/契约）→ [确认创建] / 取消
    → Tasks：列表 ⇄ DAG，owner/依赖/下一可运行；[运行下一个] [自动推进 ready]
    → Task Workspace：概览 | 运行 | 评审 | Git | 历史 + sticky 动作头
        ├─ 运行：step/tool/心跳/终态/重试
        ├─ 评审：diff/评论/blocker/decision
        └─ Git：VCS/PR/checks/queue → MergeQueue Dock 面板 → 确认合并
    → Done Card：摘要草稿 + [发布到记忆] + [下一个依赖任务] / [继续规划]
    → Memory：共享黑板/备忘录/归档；NeedsMe 横切
```

**保留**：Dock、Chat/Team/Tasks、星图、现有深链、t175 终态、t154 review gate。**不新增**：独立工作流页面、第二套任务数据源、全量 Dock 替换。

### 4.3 每步：目标 / 可见信息 / 主操作 / 失败下一步

| 步骤 | 用户目标 | 必须先看到 | 主操作 | 失败/阻塞下一步 |
|---|---|---|---|---|
| 0 打开工作区 | 确认项目与就绪 | 名称/路径、模型/Key/Mock、成员、上次未完成 | 打开/继续 | 未配置→设置/使用 Mock；无成员→创建成员；错误→inline + 帮助 |
| 1 讨论 | 澄清目标与约束 | Chat 上下文、执行契约 chip、历史过程/终态 | 发消息/停止/上下文 | Chat 失败→终态重试/设置/复制脱敏摘要 |
| 2 规划 | 从讨论形成可确认计划 | Plan Draft 任务卡、依赖、owner、验收、风险、契约 | 编辑/确认/取消 | Plan 失败→inline 错误/重试；不创建半成品；取消保留对话 |
| 3 DAG/任务 | 看懂并补全依赖 | 列表/DAG、依赖/owner/优先级/下一可运行 | 调整草案/运行下一个 | 无 owner/依赖未完成→就地链接/去 Team；不要静默失败 |
| 4 运行 | 把 ready 任务交给合适成员 | 可用成员、并发/队列、预算、gate | 运行/暂停/恢复/批量 ready | 无 worker→Team；预算/冷却→Watchdog；失败→重试/查看 Run |
| 5 监控 | 知道在跑什么/卡在哪 | WorkflowRail、NeedsMe、活跃/队列、告警、待评审/合并 | 打开 NeedsMe/Runs/任务 | 卡住/告警→NeedsMe 定位；暂停→恢复；Run 失败→重试/取消 |
| 6 评审 | 通过或要求修改 | gate、blocker、reviewer、diff/评论 | 通过评审/要求修改 | blocker→就地评论/修复；无 reviewer→分配；过期→重新评审 |
| 7 交付/合并 | 入队并安全合并 | branch/PR/checks/queue、blocked 原因 | 创建 PR/入队/批准入队/确认合并 | checks 失败→查看/waive（需原因）；冲突→处理冲突；blocked→NeedsMe |
| 8 记忆/下一轮 | 沉淀并继续 | 完成卡、摘要草稿、相关记忆、下一个 ready | 发布到记忆/下一个任务/继续规划 | 记忆保存失败→重试/跳过不阻塞；无下一任务→继续规划 |

**目标表面数**：讨论→计划不重输；目标→首任务运行 ≤2 表面；任务→评审→合并 ≤2 表面；完成→记忆/下一轮 1 个 CTA。

---

## 5. 优先级路线图

### 5.1 P0（本轮批准；成本不含评审/投票）

| ID | 切口 | 成本 | 依赖 | 核心验收 |
|---|---|---|---|---|
| P0-1 | 窄窗 Dock/Team 自适应 | M | DockShell/panelRegistry/sidebar | ≤960 默认 single + 侧栏自动折叠；Team `within` 不强制 right split；手动展开不被覆盖；960/900/760 × 默认/`#/team`/Review 无横向滚动；发送/批准/合并可点；1440/1100 不变 |
| P0-2 | 可见一级导航 rail | M | 路由/深链/Dock 恢复 | 常驻图标+短标签 rail（可折叠）；新用户 10s 内找到对话/任务/团队/记忆；关闭 Runs/Context/Poll 后可恢复；Dock 仍是工作区 |
| P0-3 | WorkflowRail + NeedsMe | M–L | P0-2；现有 task/run/review/merge/watchdog 状态 | 工作区内常驻轻量阶段条（非弹窗）；每阶段 1 个主 CTA；失败/阻塞/待评审/待合并/告警/预算均有单一条目+定位+下一步；完整周期每段 ≤2 表面 |
| P0-4 | Chat→Plan + 可编辑 DAG 草案 | M | P0-2/3；plan API | 从 Chat 目标带入 100%；确认前可编辑任务/依赖/owner/验收/契约；确认前无隐藏副作用 |
| P0-5 | 任务交付流水线 | M | P0-3/4；t154 review gate | Task tabs：概览/运行/评审/Git/历史 + sticky 动作头；首屏只有一个 primary；Review/Merge/冲突下一步首屏可见；三个“批准”文案/作用域可区分；未通过 review 不能 merge |
| P0-6 | 信任与恢复 | M | Modal/服务边界 | secret fixture 不泄漏；Settings 未保存不静默丢失/保存失败 inline；Esc 只关顶层；dialog 打开时全局快捷键不穿透 |
| P0-7 | 首用就绪 + 帮助/错误/空态 | S–M | P0-2/6 | 无 Key 新用户 60s 内说出下一步；Top 10 错误有脱敏摘要+恢复动作；Run/Context/Review/VCS/星图空态有 CTA |
| P0-8 | 流式/刷新/长历史性能 | M（R1–R3） | App/Chat/数据层；与 UX P0 并行 | 长聊天流式输入/滚动不卡；长任务事件期间 IPC/重渲染下降；150 条聊天可加载更早；无 API 回归；R1–R3 完成后再做 R4 |

### 5.2 P1（同轮或下一轮排期）

| ID | 切口 | 成本 | 依赖 | 核心验收 |
|---|---|---|---|---|
| P1-1 | Settings 全高 Modal 守卫 + MergeQueue Dock 面板 | M | P0-6；MergeQueue 路由 | Settings 保留全高覆盖层/左侧分区；dirty/关闭确认/保存失败 Modal 内反馈；MergeQueue 改 Dock 面板，可筛选/保留选择/焦点回源；无假控件 |
| P1-2 | 历史/翻译/关键失败恢复 | M | P0-8；Chat 数据层 | 150 条 fixture 可加载更早；翻译失败可重试且不重复；关键失败离开面板仍可见；冲突有“处理冲突” |
| P1-3 | 辅助面板 route/badge/溢出恢复 | M | P0-2 | Runs/Context/Polls/Watchdog 有 hash/恢复路径；关闭后可启；tab 溢出可键盘操作；旧 settings 不空面板 |
| P1-4 | 无障碍基线 | M | Shell/组件 | Tab-only 完成 Settings→Chat→Review→Merge；composer label/tabs/resizer/review/toast 断言；图例 ≥4.5:1；200% 无裁切 |
| P1-5 | 任务/团队去重 + 执行契约 | M | P0-5 | 同一任务只有一个可操作详情；成员只有一处保存；任务头显示 owner/model/permission/FT/预算并可跳设置 |
| P1-6 | 内容/术语/空态/设置密度 | M | P0-7 | 主界面裸 Run/blocker/checks/quorum 明显下降；记忆三 tab 可解释；模型配置 5 分钟完成；空态均有下一步 |
| P1-7 | 第二批数据/性能边界（含 R4） | M–L | P0-8 R1–R3；真机基线 | R4 懒加载/vendor 拆分；trace 分页可全量；150 任务星图有局部/过滤；20k diff 可搜索；200% 无裁切；关键文字 ≥12px；构建预算 |

### 5.3 P2（后置/本轮不做）

| 项 | 原因/时机 |
|---|---|
| 邮箱线程/未读/回执 | 不在“指挥 AI 开发”主流程；先保留列表面板/rail |
| 星图 >150 全量渲染优化、聊天虚拟列表、trace 虚拟化 | P1-7 先分页/过滤/基线，避免过早复杂化 |
| 字号三档/完整 rem 化 | 先做 200% 验收与关键 12px；完整 token 化另立任务 |
| 插件/MCP/Skills 实际功能 | 当前占位；先移除死入口/标“即将支持”，不承诺功能 |
| 大 diff 全文搜索/文件过滤 | 先 200 行窗口/分页；搜索后续 |
| 多用户/权限/审计扩展 | 非本场范围 |
| 任务 owner/依赖数据层重构 | P0-4 只做 UI 草案；内核自动选择/调度语义不变 |
| Monaco/自研 canvas/第三方虚拟列表/React Compiler/微前端 | 当前瓶颈是全树重渲染/全量刷新，不是缺重依赖 |
| 全量 Dock/App 重写、替换为传统多页路由 | 保留 Dock；rail/WorkflowRail 是入口层，不重写容器 |

### 5.4 顺序

1. **安全先行**：P0-6 的 secret sanitize（A11Y-06）立即修；其余 Modal/dirty 同组。
2. **布局/入口**：P0-1 → P0-2 → P0-3（P0-1 可与 P0-2 并行）。
3. **主流程**：P0-4 → P0-5（P0-3 提供 stage/next）。
4. **首用/信任**：P0-7 与 P0-6 后半同批。
5. **性能**：P0-8 先 R1 流式隔离、R2 面板渲染隔离、R3 刷新降噪；R4 懒加载/vendor 拆分进 P1-7；不做全量 Dock 重写/Monaco/虚拟列表库/React Compiler/微前端。
6. **P1** 按 P1-1/P1-2/P1-3/P1-4/P1-5/P1-6/P1-7；不把 P1 全塞进一个 PR。
7. **P2** 不进本轮；需要后续确认。

### 5.5 首批实现拆分建议（P0 ①–④，本轮不实现）

| 批次 | 内容 | 依赖/顺序 | 交付边界 |
|---|---|---|---|
| P0-① Shell/入口/布局 | P0-1 窄窗 single+侧栏折叠+Team within；P0-2 rail；P0-3 WorkflowRail/NeedsMe | 先做；P0-1 可与 P0-2 并行；P0-3 依赖 P0-2 | 不改数据层；保留 Dock/深链；三档截图 |
| P0-② 规划/DAG | P0-4 Chat→Plan Draft→可编辑确认；复用现有 plan API | 依赖 P0-① 的 WorkflowRail/rail；先无隐藏副作用 | Chat/Plan/Tasks 三层验收；创建前可取消 |
| P0-③ 交付/评审 | P0-5 Task tabs（概览/运行/评审/Git/历史）+ sticky；P1-1 MergeQueue Dock 面板 | 依赖 P0-②；review gate 不变；MergeQueue 面板按交付期高频 | 首屏唯一下一步；三个“批准”分域；未过 review 不能 merge |
| P0-④ 信任/首用/性能 | P0-6 secret sanitize/Modal stack/Settings dirty；P0-7 首用/帮助/错误/空态；P0-8 R1–R3 | P0-6 安全先行；P0-8 与 P0-①/②/③ 并行；R4 进 P1-7 | 可独立验收；不改消息/事件/terminal/IPC 契约 |

> 批次不是一次性大 PR；每批再拆实现/评审/集成任务。P0-③ 纳入 P1-1 的 MergeQueue Dock 面板，因为 Captain 要求在交付期高频使用；Settings dirty/save 守卫仍由 P0-6 承担。P1-2–P1-7 在 P0-①–④ 稳定后排期。

---

## 6. 已裁决与剩余问题

### 6.1 Captain 已裁决（不再投票）

| # | 裁决 | 报告落点 |
|---|---|---|
| 1 | 批准 P0 8 / P1 7 / 不做-后置 5 类，bb-97 为最终 shortlist | §0、§5 |
| 2 | 保留 Dock + 常驻一级 rail（图标+短标签，可折叠）；NeedsMe/阶段/唯一 CTA 常驻 | S1–S7、P0-2/3 |
| 3 | WorkflowRail 为工作区常驻轻量阶段条，不另开弹窗；每阶段一个主 CTA | P0-3、§4.2 |
| 4 | ≤960 single + 侧栏自动折叠；Team within；手动展开不被覆盖 | P0-1、§7.2 |
| 5 | 任务 tabs：概览/运行/评审/Git/历史 + sticky；Review/Merge/冲突首屏可见 | P0-5、§3.3 |
| 6 | Settings 保留全高 Modal（左侧分区）+ dirty/save 反馈；MergeQueue 改 Dock 面板 | §2.2、§3.7/3.9、P1-1 |
| 7 | 性能先 R1/R2/R3，再 R4；不做全量 Dock/Monaco/虚拟列表/React Compiler/微前端 | P0-8、P1-7、§5.3 |
| 8 | 报告含 S1–S7、逐屏、before/after、路线图、依赖/验收/不做、首批拆分 | §2–§5 |

### 6.2 剩余待确认（不阻塞本轮）

- **P2 后置项**（邮箱线程、星图 >150/聊天虚拟列表/trace 虚拟化、字号三档、插件/MCP/Skills 真功能、大 diff 搜索、多用户/审计、owner/依赖数据层）何时进入下一轮；本报告建议不纳入。
- **帮助层形态**：Help 弹窗 + Welcome 首次卡已足够；是否另建帮助中心不在本轮。
- **Settings 高级折叠分组**的具体信息架构可在 P1-6 实现时细化，不改变“保留全高 Modal”的裁决。
- **旧 settings PanelKey 清理**（P1-3）与旧 Dock 布局迁移：建议做兼容/重定向，具体实现由后续任务决定。

---

## 7. 风险与迁移（不破坏现有能力）

### 7.1 深链

必须保留/兼容：

- `#/chat`、`#/tasks`、`#/team`、`#/mailbox`、`#/board`、`#/settings`
- `#/tasks?t=<taskId>`、`#/team?t=`、`#/chat?task=`
- `#/tasks?t=&r=<runId>`、`?merge=1`、`?vcs=1`、`?review=1`
- `#/mailbox?m=`、`#/board?b=`、`#/settings?git=1`
- 旧 `#/router` 继续重定向到 `#/tasks`（现有 deeplink 行为）。

新增 rail/route 必须是**扩展**，不能破坏上述 query；未知参数应忽略而非报错。

### 7.2 Dock 布局持久化

- 当前 key：`deer.dock.v1.<workspaceId>`，变体 `wide/medium/narrow/single`，保存 `layout` + `activePanel`；最多 4 组。
- 新增 rail/WorkflowRail 不应改变 Dock 内部布局；≤960 默认 single + 侧栏自动折叠，`team` 用 `within` 而非 right split；用户手动展开侧栏/调整分栏后不被自动覆盖，**不删用户保存的分栏**。
- 旧布局中 `settings` 面板可能在 restore 后空 body（P3/F15）：迁移时过滤/重定向；不要静默丢整份布局；失败回退默认布局。
- 保留 `PanelLauncher`/⌘K/Alt+1–6/命令面板作为第二入口；rail 不是唯一入口。

### 7.3 快捷键

保留 `Ctrl/⌘+K`、`Ctrl/⌘+B`、`Alt+1–6`、`Ctrl+Alt+W`、`Ctrl+Shift+Alt+方向键/[ ]`；新增 rail/WorkflowRail 时：

- dialog 打开时全局快捷键不穿透（P0-6）；
- 不与文本框/输入法冲突；
- 面板关闭/重开/焦点恢复；
- 键盘 rail 可用（Tab/Arrow/Enter），并有 aria-current/名称。

### 7.4 权限/安全语义

- **不改**权限模式、审批超时、auto_risk、review gate、merge gate；P0-5 只是 UI 分区/术语，不改变“未通过 review 不能 merge”。
- P0-6 的错误 sanitize 在 service 边界做，UI 只消费脱敏摘要；`terminal` 已脱敏，banner/复制详情必须同样脱敏（blocker）。
- Modal 背景 `inert`/`aria-hidden`、顶层 Esc、焦点回源；不因视觉层改动绕过审批/确认。
- 不新增第二套任务/事件事实源；WorkflowRail/NeedsMe 只投影现有 task/run/review/merge/watchdog 状态，unknown 显示 unknown，不伪造。

### 7.5 性能/回归

- P0-8 先做 R1（流式隔离/memo/parse 缓存/rAF）、R2（稳定 renderPanel/分域 context）、R3（刷新降噪/trace 分页/长历史 cursor）；R4 懒加载/vendor 拆分进 P1-7。R1–R3 不改消息/事件/terminal 契约；需 t175 终态回归测试。
- 长历史分页/翻译重试不能重复消息/翻译请求；保留 t168/t172/t175 的 userMessageId 绑定、幂等、去重。
- 构建拆分/懒加载只改入口，不改变面板可发现性；以真机包体/首屏报告验收，不把“拆 vendor”当性能完成；不做全量 Dock 重写/Monaco/虚拟列表库/React Compiler/微前端。
- 窄窗/200%/键盘/Modal 需真机截图/Playwright 复核；静态审计不能冒充 visual pass。

### 7.6 迁移节奏

1. **不改数据层**：P0-1/2/3/4（草案）/5/6/7 全部是 UI/投影/服务边界；P0-8 是渲染/刷新。
2. **先兼容后清理**：旧 settings PanelKey、旧 Dock 布局、旧深链先兼容；P1-3 再清理。
3. **独立任务/评审**：每个 P0/P1 独立实现、独立验收；不把 8+7 塞进一个 PR。
4. **验收矩阵**：1440/1100/960/900/760 × 默认/`#/team`/Task Review/Merge/Settings；Tab-only、200%、secret fixture、长历史/大 diff/多面板；真机截图/录屏。
5. **回滚**：rail/WorkflowRail/Plan Draft 可回退为现有 Dock/命令/Modal；不迁移数据，不阻塞旧入口。

---

## 8. 结论

**按 Captain 裁决执行 P0 8 + P1 7，不做全量 Dock 重写。** 本轮的核心不是增加功能，而是把已有能力投影成一条工作流：

- **常驻**：S1–S7；
- **面板**：Dock 主/右组 + 长内容监控/评审/Git/交付/MergeQueue；
- **全高覆盖层**：Settings（左侧分区 + dirty/save 守卫）；
- **Modal**：短/原子/阻塞；
- **帮助**：解释性内容按需。

首批按 §5.5 的 P0-①–④ 拆分，先修 P0-6 的 secret 泄漏与 Modal/草稿安全，再做布局/入口、Chat→Plan/DAG、任务交付流水线、首用与性能 R1–R3；P1 排期，P2 后置。这样既保留现有 Dock/深链/快捷键/权限语义，又让用户在每个阶段都能回答：**我在哪、下一步是什么、失败了怎么办。**
