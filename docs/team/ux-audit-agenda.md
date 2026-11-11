# UX / 布局 / 主流程可用性审计 · 会议议程（t179）

- **主持**：aria（Facilitator / UX Researcher）
- **基线**：main `b908d1a`（t168/t172 历史气泡、t175 终态已合入；Dock shell + 后续 UI）
- **范围**：Dock shell、对话/轨迹、团队、任务/DAG、运行、监控/看门狗、评审/合并、记忆、邮箱、投票、上下文、设置，以及“用户指挥 AI 开发项目”的端到端主流程
- **约束**：本轮只审计、不写生产代码；只修改/新增 `docs/team/`
- **产出**：本文档 + 黑板议程 note；各审计员按 §5/§6 提交证据卡；后续由 Captain 汇总候选 → 投票 → 实现

---

## 1. 屏幕/面板清单与当前入口

### 1.1 Shell 层（常驻）

| 区域 | 当前内容 | 入口/可见性 | 审计关注 |
|---|---|---|---|
| Welcome / 打开工作区 | 品牌、说明、打开文件夹、最近工作区列表、错误 | 无 workspace 时全屏 | 首次使用是否知道下一步；最近工作区是否带状态/时间；模型/Key/Mock 是否可见 |
| 左侧 Sidebar | 品牌、工作区名/路径/切换、⌘K、＋新建、刷新、▦面板、⚙设置、导航提示、Mock/Key、成员数、失败 pill | 常驻；可折叠为图标栏；宽度可拖 | 是否为导航、是否承载太多系统状态；折叠后图标可发现性 |
| 全局 error banner | 最近一次错误、复制详情、关闭 | 主内容顶部 | 是否与 toast/面板内错误重复；刷新是否丢失 |
| Watchdog topbar | 看门狗入口、今日预算 BudgetBar、open alerts 计数 | 有 watchdog snapshot 时常驻 | 预算/告警是否应升级为全局“需要我处理” |
| Dock host | 可拖动/拆分/合并的面板容器；最多 4 组；布局按 workspace × 变体持久化 | 常驻 | tab 即主导航；面板关闭后的发现/恢复；分栏在窄窗是否可用 |
| Toast host | 右下角、≤3 条、自动消失、aria-live | 写操作后 | 成功/失败是否可追溯；关键失败是否只停在 toast |
| KernelAnnouncer | 任务/Run/调度变化的视觉隐藏播报 | 常驻 | 读屏是否重复/过载 |

**当前没有**：可见的侧栏一级导航列表、固定面包屑/页面地标、全局“收件箱/待办”入口。主页面切换依赖 Dock tabs、▦面板菜单、⌘K 命令面板和 Alt+1–6；`TABS` 只用于快捷键/标题映射，不是可见导航。（t24 时期的 NAV_GROUPS 已在 Dock 重构中移除，旧截图/旧文档不能直接代表现状。）

### 1.2 Dock 面板

| PanelKey | 标题 | 默认 | 路由/深链 | renderer | 当前内容与入口 | 审计关注 |
|---|---|---|---|---|---|---|
| `chat` | 对话 | 主组默认可见 | `#/chat`（routeTab chat） | always | Router 对话、工作区概述、chat/trajectory 内部 tab、模型/权限/满血控制、上下文/压缩/清空、任务上下文返回、问题 chip | 主流程入口是否过载；规划动作不在对话；实时/历史/终态是否清楚 |
| `team` | 团队 | 右组默认可见 | `#/team`（routeTab team） | always | 团队总进度、合并队列/记忆/运行入口、成员列表/编辑/删除、任务星图、选中任务详情（打开会话/运行/Git） | 与任务页重复；右侧常驻是否挤压主流程；星图可读性 |
| `tasks` | 任务 | 主组 tab | `#/tasks`（routeTab tasks） | always | SchedulerBar、搜索/状态过滤、可收起任务列表、任务详情（动作行、runtime、描述/验收/摘要、Task VCS、ReviewSection、RunHistory、执行 trace）、Compose/Plan/Delete modal | 任务详情长滚动/动作过密；DAG 编辑；评审/合并是否被埋在底部 |
| `runs` | 运行 | 默认关闭 | `#/tasks?t=&r=`（routeTab tasks） | always | 调度状态、活跃 Run、队列、当前任务动作、Run 详情/时间线 | 与任务详情 RunHistory 重复；默认关闭导致监控入口不显眼 |
| `mailbox` | 邮箱 | 主组 tab | `#/mailbox`（routeTab mailbox） | onlyWhenVisible | 消息列表/详情、Compose modal | 无未读/线程；团队沟通是否被工具化 |
| `board` | 记忆 | 主组 tab | `#/board`（routeTab board） | onlyWhenVisible | MemoryWorkbench：黑板/备忘录/归档审批内部 tab、检索、scope chips、发布 modal、投票入口 | “记忆/黑板/备忘录”命名与发现性；归档审批是否被看见 |
| `context` | 上下文 | 默认关闭 | 无 routeTab | always | 上下文 sections、任务上下文清除 | 默认关闭且无 tab；打开后是否知道来自哪里；任务上下文如何回到源 |
| `polls` | 投票 | 默认关闭 | 无 routeTab | onlyWhenVisible | Poll 列表/创建 modal、任务/黑板来源预填 | 无主 tab/深链；何时需要投票不可发现 |
| `watchdog` | 看门狗 | 默认关闭 | 无 routeTab | onlyWhenVisible | 预算/成本、告警、hold、handoff、fallback、健康状态 | 技术命名；告警/预算与任务流程割裂；面板关闭时只剩 topbar |
| `settings` | 设置（legacy 面板） | — | `#/settings` | — | 现已改为独立 Modal；Dock 注册表仍保留但恢复布局时关闭 | 旧面板/新 Modal 双形态的文档与无障碍一致性 |

### 1.3 弹窗 / 覆盖层 / 内部二级视图

| 表面 | 触发 | 类型 | 当前内容 | 审计关注 |
|---|---|---|---|---|
| 设置 Modal | 侧栏 ⚙、`#/settings`、命令面板、Git 深链 | Modal（长） | 左侧 7 段：模型/翻译/Git/插件/MCP/Skills/团队；模型/翻译/团队有保存；插件/MCP/Skills 仍是占位 | 长内容用 Modal 是否合适；首次配置模型/Key 的路径；未保存关闭/深链 |
| 合并队列 Modal | 团队进度「合并队列」、⌘K、`#/tasks?merge=1` | Modal（列表） | 每项 task/status/branch/checks/PR、批准/合并/waive checks 原因 | 需要比较/多次操作，是否应为面板/路由；与 ReviewSection 分离 |
| 新建任务 Modal | 任务页 +新建、⌘K、空状态 | Modal（短表单） | 标题/描述/验收；无依赖/优先级/负责人 | DAG 手工创建是否被 Modal 截断；与规划入口的差异 |
| 规划任务 Modal | 任务页「规划任务」、⌘K、空状态 | Modal（表单） | 目标 textarea；调用 Router plan；无 DAG 预览/确认 | 规划是否应留在对话；创建前能否预览/编辑 |
| 删除任务 Modal | 任务详情「删除任务」 | Modal（危险确认） | 影响说明、永久删除 | 合理；与其它确认样式一致 |
| Kernel 确认 Modal | 有副作用的动作 | Modal（确认） | intent、review notes、确认 | 动作语义是否与主按钮一致 |
| 高风险审批 Modal | auto_risk 工具 | Modal（阻塞） | 风险/成员/任务/工具/目标/原因、批准/拒绝、120s | 阻塞与超时反馈；与普通确认区分 |
| 提问 Modal | assistant 提问 | Modal（阻塞） | 表单/画布；Esc/延后/取消/过期 | 队列/自动打开/与聊天焦点 |
| Poll 创建 Modal | Poll panel/任务/记忆 | Modal（表单） | 候选/单选多选/阈值/quorum/截止 | 入口与投票结果的可发现性 |
| 记忆发布/复核/TTL/归档/提升 | MemoryWorkbench | Modal/Dialog | 表单与危险操作 | 记忆治理是否被埋在面板底部 |
| 成员编辑 Dialog | 团队成员列表 | Modal | 名称/角色/模型/权限/提示词 | 与设置“团队”重复 |
| 命令面板 ⌘K | 全局快捷键/侧栏 | 覆盖层 | 导航 6、创建 5、面板 10、Git 3、任务/成员/邮件/黑板实体 | 主功能的“第二入口”是否变成唯一入口 |
| Task VCS / ReviewSection / RunHistory | 任务详情内联 | 内联二级区 | Git 状态、行级评审、Run 历史/trace | 同一任务详情堆叠 3 个长区；是否应改 tab/面板 |

**无独立 drawer**；任务列表可收起，不是抽屉。Dock 面板可拖动/拆分，属于常驻/半常驻容器。

### 1.4 内部 tab / 分段

- Chat：`对话 | 轨迹`（`aria-selected`、tablist）。
- Memory：`黑板 | 备忘录 | 归档审批`（roving tabindex、Arrow/Home/End）。
- Settings：`模型 | 翻译 | Git | 插件 | MCP | Skills | 团队`。
- 任务详情：**没有 tab**；描述/验收/摘要 → VCS → Review → RunHistory → trace 顺序堆叠。
- Team：**没有 tab**；进度 → 成员 → 星图 → 选中任务详情在同一右栏内滚动。
- RunPanel：**没有 tab**；调度 → 活跃/队列 → 当前任务 → Run 详情同屏。
- Chat 轨迹是内部 tab，但不是 Dock panel；没有独立路由。

### 1.5 现有截图（审计证据，注意时效）

| 文件 | 日期 | 覆盖 | 时效说明 |
|---|---|---|---|
| `t69-task-scheduler.png` | 2026-11-10 | 默认主面板 + 任务列表/详情 + 团队右栏 + 星图 | t168/t175 前；可作为三栏密度基线，需重拍当前版 |
| `t69-run-panel.png` | 2026-11-10 | Run panel + 队列/当前任务/Run 时间线 + 团队右栏 | 可与任务详情 RunHistory 对照；需重拍 |
| `t69-run-history.png` | 2026-11-10 | RunHistory | 需重拍 |
| `t103-task-vcs.png` | 2026-11-10 | 任务详情 + Git 状态 + trace + 星图 | 评审/合并当前已增加 ReviewSection；需重拍 |
| `t103-merge-queue.png` | 2026-11-10 | 合并队列 Modal + 背景任务/团队 | 当前仍是 Modal；需重拍 |
| `t103-git-settings.png` | 2026-11-10 | 旧设置 Modal + Git 区 | 旧 IA：当前 SettingsView 已拆 Git/翻译；不可作为现设置结构证据 |
| `t168-chat-history.png` | 2026-11-11 | 历史同泡 execution process | 当前基线（t172 后仍有参考价值） |
| `t175-chat-terminal.png` | 2026-11-11 | 已取消终态 + 重试 + chat/team 双栏 | 当前基线 |
| `team-poll.png` | 2026-11-10 | Poll UI | 需重拍当前版本 |

**截图缺口**：team/tasks 当前三栏、memory/mail、narrow（900/760/single）、全 Modal/键盘状态没有当前截图。审计员需用当前 main 以 mock 数据重拍；不得拿 `t69`/`t103` 旧图直接当现状结论。

---

## 2. 主流程剧本：打开工作区 → 规划 → DAG → 运行 → 监控 → 评审/合并 → 记忆沉淀

> 每步格式：**用户目标 / 需要看到 / 需要操作 / 当前摩擦（代码或截图假设，待审计确认）**。所有“摩擦”先作为问题，不直接当结论。

### Step 0 · 打开工作区

- **目标**：确认是哪个项目、能否开始；知道下一步。
- **需要看到**：工作区名/路径；最近工作区状态；模型/Key/Mock；团队是否已有 Router/成员；上次会话/未完成项。
- **需要操作**：打开文件夹、选择最近工作区、必要时切换/初始化团队。
- **当前路径**：Welcome →「打开工作区文件夹」→ snapshot；默认 Dock 打开对话+团队；任务/邮箱/记忆在对话组 tab；运行/上下文/投票/看门狗关闭；设置在设置 Modal。
- **摩擦（待验证）**：
  - Welcome 只有打开/最近列表，未展示模型/Key/Mock、团队就绪度、上次未完成工作；这些信息在打开后分散到 Sidebar footer/设置。
  - 打开后没有“开始使用 4 步/下一步”引导（旧 C23 未采纳）；用户可能直接停在空对话。
  - 最近工作区没有时间/任务状态/健康度；切换工作区的后果（Dock 布局、选中任务、上下文）不显性。

### Step 1 · 与 Router 讨论 / 规划

- **目标**：把模糊目标澄清为可执行计划；确认 Router 理解正确。
- **需要看到**：对话上下文、模型/权限、当前工作区概述、Router 计划草案（任务/DAG/依赖/验收）。
- **需要操作**：发消息、看/收执行过程、切模型/权限、发起规划、预览/修正计划。
- **当前路径**：Chat 面板（默认主组）→ composer；`规划任务`在 Tasks 面板头部 → `RouterPlanModal`（目标 textarea）→ `window.deer.plan` 直接创建任务 → `openPanel("tasks")` + toast「已规划 N 个任务」+ 选中第一个任务。Chat 页有工作区概述和上下文按钮；上下文是独立 panel。
- **摩擦（待验证）**：
  - **规划动作不在对话里**：用户和 Router 讨论完，要到任务页找「规划任务」；上下文/目标需要重复输入或手动复制。
  - **无 DAG 预览/确认**：规划 Modal 只有目标；调用后直接创建任务，不能先看依赖图/验收/负责人再确认；失败只剩全局 error。
  - 规划完成自动选中第一个任务并切 Tasks；用户失去对话上下文；返回对话需靠「返回任务/团队」或重新开 chat。
  - 模型/权限/满血控制集中在 composer 下方，规划入口在另一面板；新手难以建立“先配置/后规划”的顺序。
  - Chat 的 `轨迹` tab 与历史 execution process 是两套“过程”视图（一个轨迹账本、一个气泡内折叠过程），发现性/一致性需要审。

### Step 2 · 建任务 DAG

- **目标**：看懂依赖、优先级、负责人、验收；必要时补/改任务。
- **需要看到**：任务列表状态、任务详情、依赖上下游、任务星图、调度队列、可运行条件。
- **需要操作**：规划/新建、选中、查看依赖、定位星图、调整/发起投票（当前无编辑依赖）。
- **当前路径**：Tasks 面板 = SchedulerBar + 任务列表（搜索/状态 chips）+ 详情（动作、runtime、描述/验收/摘要、VCS、Review、RunHistory、trace）。Team 右栏 = 进度/成员/星图/选中任务详情。任务星图是 Team 内的 canvas，支持拖动/滚轮/双击/键盘？需审。
- **摩擦（待验证）**：
  - **手工 DAG 不完整**：`TaskComposeModal` 只有标题/描述/验收；没有依赖、优先级、负责人；依赖主要由 Router plan 产生。用户无法在创建时编排 DAG。
  - 规划 Modal 与新建 Modal 是两条语义不同的入口（“Router 拆”vs“我写”），但都在 Tasks 头部、都叫任务；何时用哪条无说明。
  - 依赖只在任务详情 runtime grid/描述区显示数量/上游按钮；没有边编辑、没有“前置任务未完成”的可视链路；星图只是可视化/定位，不是编辑器。
  - Tasks 详情与 Team 右栏详情重复；同一任务在左右两处可操作，容易状态不一致/误操作。

### Step 3 · 运行任务

- **目标**：把 ready 任务交给合适成员，控制并发/队列，知道为什么不能运行。
- **需要看到**：成员可用性/工作区、并发上限、队列、任务 gate（依赖/评审/失败）、预算、开始后的 Run。
- **需要操作**：运行任务、暂停/恢复调度、重试、取消；必要时打开 Run 面板。
- **当前路径**：Tasks 顶部 SchedulerBar（运行中/排队/上限/暂停/队列/运行面板）；任务详情动作行（运行任务/重试任务/批准/拒绝/取消任务）；RunPanel 有同样动作；`startTask` 入队，scheduler 按配额启动；Team 进度有运行面板/合并队列入口。
- **摩擦（待验证）**：
  - **动作过载/层级不清**：同一行同时有“运行任务/重试任务/批准/拒绝/取消任务”，多个 primary；用户很难判断当前唯一正确动作；`taskNextStep` 有提示但不在动作行内。
  - 运行/重试/审批/取消在 Tasks、RunPanel、RunHistory、Team 详情多处重复；状态与 busy 文案需一致。
  - **没有“运行所有 ready/自动排队”**的一眼入口；SchedulerBar 有队列但没有“下一批 ready”动作；用户需逐任务点运行。
  - 失败/暂停/冻结/无法启动的原因分散在 taskActionState、inline hint、SchedulerBar、Run error；没有就近的“为什么不能运行”聚合（仅详情 hint）。
  - 预算/看门狗只在 topbar 和关闭面板；运行前没有预算/冷却的显式 gate 提示（可能以失败形式出现）。

### Step 4 · 监控

- **目标**：随时知道“在跑什么/卡在哪/需要我做什么”，不必逐面板找。
- **需要看到**：活跃 Run、队列、失败/阻塞、评审待办、预算/告警、最近交付。
- **需要操作**：跳到任务/Run、暂停/恢复、处理告警/告警确认、打开评审/合并。
- **当前路径**：Team 右栏总进度（状态条/交付率/行动按钮）；Tasks SchedulerBar 与任务行 hint；RunPanel（默认关闭，需手动开）；RunHistory/trace 内联；topbar watchdog 预算/告警计数；Sidebar 失败 pill；Toast/KernelAnnouncer。
- **摩擦（待验证）**：
  - **没有单一“需要我处理”队列**：失败 pill 只过滤任务；watchdog 告警只在 topbar/panel；评审待办在详情；合并队列在 Modal；预算在 topbar。用户需要跨 5+ 个表面拼状态。
  - Team 总进度、SchedulerBar、任务行、RunPanel、RunHistory 多套状态词汇/计数；“运行中”“排队中”“等待依赖”“评审中”在空间上分散。
  - Run panel 默认关闭，且与任务详情 RunHistory 重复；从 Team/Task 打开 Run 面板会改变 Dock 布局/选中状态，返回路径需审计。
  - 长任务/事件多时 trace/run timeline 只显示最新；没有“从上次查看后有什么变化”的增量提示。

### Step 5 · 评审 / 合并

- **目标**：确认 diff/评论/blocker；通过或要求修改；按队列合并并处理 checks。
- **需要看到**：评审 gate、blocker/评论、diff、VCS 分支/PR/checks、合并队列状态、等待/失败原因。
- **需要操作**：查看 diff、评论/回复/解决、通过/要求修改；创建 PR、入队、批准/合并、waive checks。
- **当前路径**：任务详情内联 `TaskVcsPanel` → `ReviewSection` → `RunHistory`/trace（全部堆叠）；任务动作行另有“批准/拒绝任务”；Team 进度「合并队列」→ `MergeQueueModal`；⌘K/Git 命令/深链 `#/tasks?t=&review=1`、`?vcs=1`、`?merge=1`。
- **摩擦（待验证）**：
  - **评审/合并被埋在任务详情纵向长滚动**；用户点「批准」时未必看到 blocker/ReviewSection；“问题/阻断”是否阻止任务批准需审计。
  - **三个“批准/通过”**：任务动作「批准」、ReviewSection「通过评审」、MergeQueue「批准」；它们分别改变任务状态/评审决定/合并审批，术语近似但作用域不同，极易误操作。
  - **合并队列是 Modal**：需要比较多项/分支/checks/waive 原因，Modal 内滚动、关闭丢上下文；与任务详情/Team 进度之间来回切换。
  - **没有全局评审/合并待办**：Team 进度只有合并队列按钮；没有待评审数/待合并数/blocker 数的稳定 badge；只能靠任务状态或进详情。
  - VCS 与 Review 同属“交付质量”但没有 tab/分区；在同一任务上，用户可能因滚动位置错过 gate 或合并入口。

### Step 6 · 记忆沉淀

- **目标**：把有效结论/经验留给后续任务/成员；能找到、复核、归档。
- **需要看到**：黑板/备忘录/归档审批、搜索/scope、来源/置信度/stale/TTL、待审批数。
- **需要操作**：发布/搜索/复核/TTL/提升/归档/恢复；从任务/评审/投票发起记忆。
- **当前路径**：Dock `board` 面板（标题“记忆”）→ MemoryWorkbench 内部 tab `黑板/备忘录/归档审批`；搜索 scope、kind/status filter；发布 Modal；归档审批；任务页可发起投票；team 进度有「记忆」按钮。
- **摩擦（待验证）**：
  - **命名不一致**：顶部 tab/文档/团队按钮称“记忆”，内部主 tab 称“黑板”，条目/类型称“黑板/备忘录/摘要”；旧截图直接显示“黑板”。新用户不知道“记忆=黑板+备忘录+归档”。
  - 任务完成后没有就近的“沉淀到记忆/发起复盘”入口；记忆在单独 tab，容易漏。
  - 黑板/备忘录内容当前的渲染/可读性（Markdown?）与长文阅读在旧布局评审 C07 未采纳；需按新 MemoryWorkbench 复核。
  - 归档审批有 pending count badge（内部 tab），但没有全局/侧栏提示；治理风险。
  - Poll 是独立 panel 且默认关闭；从 memory/task 发起后用户是否知道去哪里看结果/decision，需审计。

### Step 7 · 团队 / 邮箱 / 设置（跨流程）

- **团队**：Progress/Members/StarMap/Task detail 常驻右栏；成员编辑 Dialog。摩擦：右栏既是监控又是任务详情，宽度/滚动与主任务区竞争；新建成员/权限/模型分散在 Team/设置。
- **邮箱**：默认主组 tab；列表/详情/Compose modal；无未读 badge/线程（旧 C17 未采纳）。摩擦：团队沟通不在主流程节点上；发消息后无回执/未读反馈。
- **设置**：Settings Modal；7 段；模型/翻译/Git/团队有实际配置，插件/MCP/Skills 仍是占位。摩擦：长内容 Modal、首次配置模型/Key 的路径、未保存关闭、设置与 Team/成员编辑/Git 面板的重复入口。
- **上下文**：默认关闭且无 tab；从 Chat「上下文」/Task「查看上下文」打开；任务上下文有返回源按钮。摩擦：用户可能不知道上下文已打开/来自哪个任务；关闭后只能通过面板菜单/命令找回。
- **投票**：默认关闭、无深链/主 tab；入口在 panel launcher/command/task/memory；摩擦：主动发起后难以发现结果。

---

## 3. 审计维度与检查点

| 维度 | 必查问题 | 证据/方法 |
|---|---|---|
| 1. 信息层级 | 常驻/侧栏/二级面板/弹窗是否与使用频率、跨任务需要匹配；是否把长内容塞进 Modal；是否同时出现多个 primary | 每个表面记录“用户在此停留时长、是否需与另一面板并看、是否阻塞其他操作”；对比 §4 准则 |
| 2. 导航与发现性 | 无可见的一级导航时，用户能否在 ≤2 步内到 Chat/Tasks/Team/Runs/Review/Merge/Memory/Settings；关闭面板后能否恢复；深链/Alt/⌘K 是否一致 | 遮住文档，新用户路径；记录点击次数/迷路点；检查 PanelLauncher/CommandPalette/routeTab |
| 3. 密度与可读性 | 三栏 1424/1440、960×700、900/760/single 下是否横向溢出；任务详情/评审/合并/设置长文是否可扫读；字号/对比/行宽/嵌套层级 | 截图 + DOM 检查；标出滚动容器/固定头/可折叠；记录 10px/9px 文本、纯色状态 |
| 4. 状态与反馈 | loading/empty/error/busy/disabled 原因/成功/失败/过期/stale 是否可见且不重复；刷新后是否保留 | 逐 surface 触发：无工作区、无任务、无 worker、失败、排队、超时、预算、blocker、断网/翻译失败；对照 Toast/Inline/Banner |
| 5. 错误恢复 | 每个错误是否有就近恢复（重试/重开/重选/回退/取消/复制详情）；错误是否吞掉/只停在 toast；是否保留用户输入 | Chat 终态重试（t175）、Task 运行/重试、Run 取消、Review gate、Merge 失败、Settings 保存失败、Plan 失败、Context/Memory 加载失败 |
| 6. 无障碍 | 键盘完整路径、focus-visible、Modal focus trap/回焦、tab/tablist roving、aria-live/role、canvas 星图/Review grid、颜色非唯一信息、reduced motion | Tab-only 走主流程；读屏/快捷键；检查 `aria-*`、`prefers-reduced-motion`、对比度；记录 DOM/截图 |
| 7. 性能 | 首屏/Tab 切换/星图/大列表/2000 events/200 行 diff/200 条记忆/Modal 打开/设置保存是否卡顿；是否重复请求/重渲染 | 记录规模（任务数/消息数/diff 行/记忆数）、操作耗时、loading skeleton、是否有虚拟化/分页；不把“感觉慢”当证据 |
| 8. 文案一致性 | 记忆/黑板、任务/工作、运行/Run、评审/评审 section/合并、批准/通过/合并、模型/Model、成员/Agent、trace/轨迹、checks/检查；中英混用；状态词/按钮词一致 | 建立词表；对照 `src/shared/copy.ts`/各组件；记录屏幕+字符串 |

### 严重度（审计员统一）

- **P0 / blocker**：主流程无法完成、数据/操作不可恢复、误操作风险（如批准/合并错对象）、关键状态刷新后丢失。
- **P1 / high**：完成主流程需要绕路/记忆路径、关键信息被埋在 3+ 层、明显误导（术语/入口）、窄窗不可用。
- **P2 / medium**：局部密度/文案/一致性问题，有 workaround，不阻断。
- **P3 / low**：纯 polish、视觉细节、非关键效率。

每条 finding 必须含：屏幕/面板、viewport、状态/数据规模、复现步骤、期望/实际、证据（代码路径/截图）、严重度、建议层级（常驻/面板/Modal）、是否阻塞。

---

## 4. “应常驻 / 应收进面板 / 应进按钮触发的二级弹窗”判断准则

### 4.1 判断准则

**应常驻（Persistent，始终可见或一眼可达）**，满足任意两条：

1. 在 2 个以上连续阶段被使用（工作区身份、当前项目、当前任务、主流程下一步）。
2. 跨任务/跨面板的安全/状态信息（运行中、失败/阻塞、预算/告警、待评审），隐藏会导致误操作或漏处理。
3. 用户需要随时扫一眼而不离开当前工作（状态、告警、who is doing what）。
4. 关闭后很难恢复/没有可见入口（当前 PanelLauncher/⌘K 不是随时可见）。

**应收进面板（Panel / Dock tab）**，满足任意两条：

1. 领域内容 >1 屏，需滚动/比较/多次操作（任务详情、评审 diff、运行队列、合并队列、记忆、设置）。
2. 需要与其他面板并看（chat + team + tasks；task + runs；review + VCS）。
3. 长时间/频繁使用，保留滚动/选择/过滤器状态有意义。
4. 有独立深链/返回路径，用户会从多个入口到达（task/review/VCS/merge）。

**应进按钮触发的二级弹窗（Modal，短、原子）**，满足全部：

1. 只做一个决定/一次短表单，通常 ≤1 屏，不需要与其他视图并看。
2. 必须打断当前流程（危险确认、人工审批、必答问题）或从选中对象发起的短动作（新建任务、创建投票、成员编辑）。
3. 关闭后不需要保留滚动/比较状态；Esc/取消语义明确，脏数据有确认。
4. 不是导航目的地；不能通过它完成主流程的多步任务。

**反模式（本场重点找）**：

- 长内容（7 段设置、合并队列、行级评审、任务详情）塞进 Modal。
- 把需要随时扫的状态（失败、告警、待评审）只放在 toast/关闭面板/Modal。
- 把主流程入口只放 ⌘K/文档；没有可见入口或 ≤2 步路径。
- Modal 套 Modal / 关闭丢草稿 / 焦点不回触发按钮。
- 多个“批准/通过/合并”相似词在同一屏幕不同作用域。

### 4.2 当前表面的初步分级假设（待审计验证）

| 表面 | 初步判断 | 需要验证的点 |
|---|---|---|
| 工作区身份 + 模型/Key/Mock + 当前任务 | 常驻/侧栏 | 目前分散在 Sidebar footer/设置；首次开工作区是否可见 |
| 运行中/排队/失败/预算/告警/待评审 | 常驻的“需要我处理”汇总 | 现在分散 Sidebar/Team/Scheduler/topbar/任务详情 |
| Chat / Team / Tasks | 面板（默认可见） | 三栏宽度、并行、状态保持 |
| Runs | 面板（可默认关闭） | 与任务详情 RunHistory 重复；打开/返回成本 |
| Context | 面板（默认关闭） | 无 routeTab；任务上下文返回 |
| ReviewSection / Task VCS | 面板/任务详情 tab，不应是长内联堆叠 | 当前无 tab，滚动位置/发现性 |
| MergeQueue | 面板/路由，优先于 Modal | 多项比较、waive/checks 需要上下文 |
| Settings | 面板/全页，优先于 Modal | 7 段长内容；首次模型/Key 路径 |
| Task compose / Plan / Delete / Approval / Question / Poll create / Member dialog / Memory publish | Modal | 短/阻塞/危险；Plan 可能需要预览（见 Q2） |
| Command Palette / Toast / Error banner | 覆盖层/反馈 | 是否成为唯一入口；错误是否持久 |
| Polls / Watchdog | 面板 + 全局入口 | 默认关闭/无 routeTab；告警是否应常驻 |

> 这张表是“审计假设”，不是实现决定；审计员可以推翻，但必须给屏幕/路径/证据。

---

## 5. 每位审计员统一回答的 10 个关键问题

> 每题给：结论（P0–P3 + 建议层级）、屏幕/路径、viewport、状态数据、复现步骤、证据（截图/代码）。同一问题可由两人交叉验证。

1. **首次 3 分钟**：新用户打开 workspace 后，能否知道“项目已就绪、模型/Key 是否可用、团队是否有 worker、下一步做什么”？看 Welcome、Sidebar footer、Chat 空态、Team 空态；截图 capture（当前无）。
2. **规划是否可发现、可确认**：从 Chat 讨论完，用户能否 ≤2 步找到规划入口；规划 Modal 是否展示 DAG 预览/依赖/验收/负责人并可取消/修改，而不是直接创建？看 Chat、Tasks 头部、`RouterPlanModal`、Team 星图、`t69-task-scheduler`。
3. **DAG 是否可读可编辑**：在 Tasks 列表/详情/星图中，用户能否理解依赖链、优先级、负责人、可运行条件；能否手工补依赖/调整？看 TaskComposeModal、task detail dependsOn、TaskStarMap、`t103-task-vcs`。
4. **动作层级**：任务详情动作行（运行/重试/批准/拒绝/取消）是否有唯一主行动和就近原因；是否与 RunPanel/Team/RunHistory 重复/矛盾？看 Tasks、RunPanel、`t69-run-panel`、`t69-task-scheduler`。
5. **注意力入口**：用户能否在一个地方看到失败/阻塞/待评审/待合并/告警/预算？看 Sidebar 失败 pill、Team 进度、SchedulerBar、Watchdog topbar/panel、MergeQueue、`t103-merge-queue`。
6. **评审/合并是否可发现且不误操作**：ReviewSection、Task VCS、任务「批准」、Review「通过评审」、MergeQueue「批准」之间的层级/术语/状态是否清楚；长任务详情滚动是否导致漏看 blocker？看 `t103-task-vcs`、ReviewSection、MergeQueue、`t69-run-history`。
7. **记忆/邮箱/投票**：用户能否区分记忆/黑板/备忘录/归档/投票，能否从任务/评审就近沉淀，归档审批是否有提示？看 MemoryWorkbench（3 tab）、Mailbox、PollPanel、`team-poll.png`。
8. **设置/首次配置**：Settings Modal 的 7 段是否适合 Modal；模型/Key/翻译/Git/团队是否可在 ≤2 步内找到；未保存关闭/深链/焦点是否安全？看 SettingsView、`t103-git-settings`（旧图需重拍）、Sidebar。
9. **窄窗与三栏**：1424/1440、1100、960×700、Dock 900/760/single 下，Sidebar+Chat+Team+Tasks、任务详情、Review diff、MergeQueue、Settings 是否横向溢出/遮挡/失去主行动？看 DockShell/`selectVariant`、`styles.css` media、当前重拍。
10. **可访问性与效率**：Tab-only 能否完成打开→规划→运行→评审→合并→记忆；Modal focus trap/回焦、ARIA、键盘星图、Review grid、颜色非唯一、reduced-motion 是否成立；大列表/大 diff/大事件量是否卡顿？看代码 + 键盘 walkthrough + 性能记录。

### 5.1 8 个席位的分工建议（每人回答全部 10 问，但主责 2–3 问）

| 席位 | 主责问题 | 重点屏幕 | 备注 |
|---|---|---|---|
| A（Shell/Dock） | Q1、Q9、Q10 | Sidebar、Dock tabs/watermark、PanelLauncher、CommandPalette、960/900/760 | 负责导航/恢复/窄窗 |
| B（Chat/Context） | Q2、Q6、Q10 | Chat、Trajectory、Context、t168/t175 | 负责对话→规划断裂、终态恢复 |
| C（Task/DAG） | Q2、Q3、Q4 | Tasks、Plan/Compose、Team 星图、t69/t103 | 负责 DAG 与动作层级 |
| D（Run/调度/Watchdog） | Q4、Q5、Q10 | SchedulerBar、RunPanel、RunHistory、Watchdog topbar/panel | 负责队列/告警/预算 |
| E（Review/Merge/VCS） | Q5、Q6、Q9 | Task VCS、ReviewSection、MergeQueue、t103 | 负责 gate/术语/Modal |
| F（Memory/Mail/Poll） | Q1、Q7、Q8 | MemoryWorkbench、Mailbox、PollPanel、team-poll | 负责记忆模型/沟通/投票 |
| G（Settings/Onboarding） | Q1、Q8、Q9 | Welcome、SettingsView、Git/模型/翻译、t103 | 负责首次配置/长 Modal |
| H（Cross-cutting） | Q9、Q10 + 全问交叉 | 全屏 + CSS/DOM + 键盘 + 性能 | 负责 a11y/perf/copy/证据一致性 |

---

## 6. 会议执行与交付格式

### 6.1 会议节奏（建议 75–90 分钟）

1. **10 min**：主持人 walkthrough（本议程 §1/§2/§4），确认基线/截图时效。
2. **10 min**：现场三栏/窄窗/Modal 复现（使用当前 main + mock 数据，不写代码）。
3. **35 min**：按 §5 分头审计；每席位产出 3–5 张证据卡（至少 1 张 P1/P0 候选）。
4. **20 min**：逐条读证据卡；只讨论“用户任务/路径/证据”，不讨论实现方案；标记 duplicate/merge。
5. **10 min**：按 §4 给每个表面初步分级（常驻/面板/Modal）；列出需 Captain 裁决项。

### 6.2 证据卡模板

```text
ID: UX-<seat>-<n>
问题: <一句话用户任务/障碍>
屏幕/入口: <panel/modal + 路径 + 截图名>
Viewport/数据: <1440x900 / 960x700 / 900 / 760 / single; 任务数/messages/diff 行>
步骤: 1... 2... 3...
期望: ...
实际: ...
证据: <截图/代码路径/测试/录屏>
严重度: P0/P1/P2/P3
建议层级: 常驻 / 面板 / Modal / 保持
重复: <相关 finding id>
```

### 6.3 审计范围守卫

- 只读代码与 UI；不修改 `src/`、`electron/`、`dist*/`、`branches/`；不顺手做“小修复”。
- 不重新评审已合入的 t168/t175 功能正确性，除非它造成当前 UX/主流程问题；功能 bug 交给独立验证/修复，不混入本场。
- 不把旧截图/旧文档的已解决状态当现状；以当前 main + 重拍截图为准。
- 不提出“全部改成某一种布局”的大重构；每条建议必须对应屏幕/用户任务/证据。

### 6.4 交付

- 每个席位 3–5 张证据卡（Markdown，追加到当天 `docs/team/ux-audit-notes-<seat>.md` 或等价文件）。
- 主持人汇总 `docs/team/ux-audit-findings.md`：按严重度/表面/主题分组，附截图/代码；去重后交 Captain 进入提案/投票。
- 若本轮只产出议程，则验收为：本文件 + 黑板 note + 各席位确认收到问题/屏幕清单。

---

## 7. 已知历史背景（避免重复/误判）

- 第 1 场布局评审（`layout-decisions.md`）已采纳 C01/C03/C06/C09/C10/C11/C12/C14/C24/C25/C26；已被后续 Dock/命令面板实现吸收，但部分可见导航（旧 NAV_GROUPS）在 Dock 重构后改变，需按当前界面复核，不要拿旧报告当现状。
- 未采纳项仍是本场候选背景：C05（响应式断点）、C07（黑板/邮箱 Markdown）、C08（字号/对比）、C17（邮箱线程/未读）、C20（黑板搜索/pin，当前 MemoryWorkbench 已部分实现）、C22（插件/MCP/Skills）、C23（4 步上手）、C27（键盘/动效可达性）。本场应重新验证而非直接沿用票数。
- 当前代码已新增 t168/t172 历史同泡/懒翻译、t175 取消失败终态+重试；审计需覆盖这些新表面，不要只按 t69 截图审。

---

## 8. 验收（本议程）

- [ ] 屏幕/面板清单覆盖 §1 全部可见表面，标明常驻/tab/Modal/内部二级。
- [ ] 主流程 §2 每步有目标/需看到/需操作/摩擦假设，引用代码或截图。
- [ ] 审计维度 §3 覆盖信息层级、导航、密度、状态、错误恢复、无障碍、性能、文案。
- [ ] 分级准则 §4 可直接判定“常驻/面板/Modal”，并给出反模式和当前表面假设。
- [ ] 10 个关键问题 §5 均绑定屏幕/截图/路径；8 席位分工明确。
- [ ] 证据卡模板、会议节奏、范围守卫、交付物明确。
- [ ] 仅新增本文件与黑板 note，不修改生产代码。
