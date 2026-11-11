# 指挥 AI 开发项目：主流程与交互摩擦审计（t181）

- **任务**：t181 — 审计“用户指挥 AI 帮忙开发项目”的主流程与交互摩擦
- **性质**：work / 审计；**只读代码与截图，不修改生产代码**
- **基线**：main `b908d1a`（已合入 t175 终态、t168/t172 历史气泡；Dock shell + 当前 Review/Run/Team 实现）
- **范围**：`src/App.tsx`、`src/shell/dock/`、`src/review/ui/`、`src/git/ui/`、`src/RunPanel.tsx`、`src/RunHistory.tsx`、`src/TeamDashboard.tsx`、`src/SchedulerBar.tsx`、`src/kernel/` 的相关只读路径；`docs/team/`
- **交付**：本文；不修改 `src/`、`electron/`、`dist/`、`dist-electron/`、`branches/`

## 0. 审计方法与证据边界

- **方法**：按真实用户操作顺序做代码走查 + 对照当前/历史截图；把“用户看到什么、点什么、切换几个表面、下一步在哪”逐项记录；摩擦先作为待验证问题，再给优先级和建议。
- **当前截图**：`t175-chat-terminal.png`（当前 Chat/Team 双栏 + 终态气泡）、`t69-task-scheduler.png`（任务列表/任务详情/团队三栏）、`t69-run-panel.png`（运行面板）、`t103-task-vcs.png`（任务 VCS；当前 ReviewSection 已在其后新增，旧图只作布局参考）。
- **已知时效限制**：`t69`/`t103` 的截图早于 t168/t175/ReviewSection；本文只借用其**布局事实**，不把旧图上的按钮集合当当前全部状态。未做用户访谈、点击埋点或性能测量；文中的“摩擦”是代码/结构证据支持的审计假设。
- **不涉及**：具体视觉样式评分、动效性能、真实网络/企业 host、权限安全实现细节；这些留给对应审计卡。

---

## 1. 当前表面地图（与主流程相关的部分）

### 1.1 常驻 Shell

| 区域 | 当前事实 | 对主流程的影响 |
|---|---|---|
| Welcome / 打开工作区 | 只有品牌说明、打开文件夹、最近工作区、错误；不显示模型/Key/Mock、团队就绪度、上次未完成项 | 首次用户必须先“打开后才知道”；没有进入后的第一步引导 |
| 左侧 Sidebar | 工作区名/路径、⌘K、＋新建、刷新、▦面板、⚙设置、导航提示、Mock/Key 状态、成员数、失败 pill；**没有一级导航列表** | 主功能入口不在侧栏；用户靠 Dock tab/命令面板/Alt+1–6 |
| Dock host | 默认：主组 `对话` 激活，`任务/邮箱/记忆` 为同组 tab；右组 `团队`；`运行/上下文/投票/看门狗` 默认关闭；`设置` 是 Modal | 主流程跨 4 个以上表面；关闭的面板没有 route/固定入口 |
| 全局 error banner / Toast | banner 最近一次错误；toast 自动消失；看门狗告警只在 topbar | 关键失败/等待评审/合并阻塞没有统一“待我处理” |
| Watchdog topbar | 入口、预算条、open alerts 数量 | 预算/告警与任务详情/评审/合并割裂 |

**关键结构事实**：`TABS` 只用于快捷键/标题映射，不是可见导航；真正的导航是 Dock tabs、▦面板菜单、⌘K 命令面板和 Alt+1–6。见 `src/App.tsx:125-132`、`src/shell/dock/DockShell.tsx:142-173`、`src/shell/dock/panelRegistry.ts:42-158`。

### 1.2 本流程会碰到的表面

| 表面 | 打开方式 | 默认 | 本流程中的职责 |
|---|---|---|---|
| 对话 Chat | Dock 默认主组 | 可见 | Router 讨论、模型/权限/满血、上下文入口、历史 process/终态、重试 |
| 任务 Tasks | 主组 tab | tab 存在 | 规划/新建任务、任务列表、任务详情（动作、VCS、Review、RunHistory、trace） |
| 规划 Modal | 任务页「规划任务」/空状态/⌘K | 关 | 输入目标；**调用后直接创建任务** |
| 新建任务 Modal | 任务页「+新建」/空状态/⌘K | 关 | 标题/描述/验收；无依赖/负责人/优先级 |
| 团队 Team | 右组默认 | 可见 | 总进度、合并队列入口、成员、星图、任务详情（Git/运行/会话） |
| 运行 Runs | 任务详情「运行详情」/团队「运行面板」/⌘K | **关闭** | 调度、活跃/队列、Run 详情/时间线 |
| 上下文 Context | Chat「上下文」/任务详情「查看上下文」/⌘K | **关闭、无 route** | 上下文 sections、任务上下文清除 |
| 任务 VCS | 任务详情内联 | 随详情 | 分支/PR/checks/合并状态；创建 PR、加入合并队列、清理工作树 |
| 行级评审 ReviewSection | 任务详情内联 | 随详情 | 文件 diff、行内评论、blocker、评审决定 |
| 合并队列 Modal | 团队「合并队列」/⌘K/`#/tasks?merge=1` | 关 | 队列项、批准、合并、waive checks |
| 记忆 MemoryWorkbench | 主组 tab | tab 存在 | 黑板/备忘录/归档审批；发布/验证/提升 |
| 设置 Modal | 侧栏 ⚙/`#/settings`/⌘K | 关 | 模型/翻译/Git/团队等配置 |

---

## 2. 真实流程走查（当前实现）

### 2.1 一句话流程

**打开工作区 → 在 Chat 讨论 → 切到 Tasks 打开「规划任务」→ 输入目标直接创建 DAG → 手动选任务运行 → 在任务详情底部看 Run/Review → 任务 VCS 入队 → 团队/命令面板打开合并队列 → 记忆 tab 发布/验证 → 回任务页继续。**

### 2.2 Before：当前流程 ASCII

```text
┌─────────────────────────────┐
│ Welcome                     │
│ [打开文件夹] [最近工作区]    │  ← 不显示模型/Key/团队/上次进度
└──────────────┬──────────────┘
               │ 打开
               ▼
┌─────────────────────────────┐       ┌──────────────────┐
│ Dock 主组                    │       │ Dock 右组         │
│ [对话] [任务] [邮箱] [记忆]  │       │ [团队]            │
│   ▲ active                  │       │  总进度/合并队列  │
└──────┬──────────────────────┘       │  成员/星图/任务   │
       │                              └────────┬─────────┘
       │ Chat: 目标/上下文/模型/权限/满血          │ 只读定位
       │ 讨论完，规划入口不在这里                  │
       ▼                                          │
 [切 Tasks tab] ──▶ [规划任务 Modal]               │
                        │ 输入目标（可能重打一遍）  │
                        │ 无 DAG 预览/确认          │
                        ▼                          │
                 直接创建 2–4 个任务               │
                 自动选中第一个任务                 │
                        │                          │
                        ▼                          │
┌──────────────────────────────────────────────┐   │
│ 任务详情（同一长面板，无内 tab）               │   │
│ 动作行：定位/上下文/运行详情/发起投票/运行/重试 │   │
│         /批准/拒绝/取消/删除（10+ 按钮）       │   │
│ 运行状态/下一步/运行网格/描述/验收/摘要         │   │
│ Git 状态 → 行级评审 → Run 历史 → 执行 trace    │   │
└──────┬───────────────────────────────┬────────┘   │
       │ 运行任务                       │ 滚动/打开     │
       ▼                               ▼              │
 [SchedulerBar: 排队/运行]        [Runs 面板(默认关)]  │
       │                               │              │
       │ 任务详情底部 ReviewSection     │              │
       │ 通过/要求修改 + 任务批准/拒绝   │              │
       ▼                               │              │
 [Task VCS: 加入合并队列] ──▶ [团队/MergeQueue Modal]  │
                                批准 → 合并            │
                                       │               │
                                       ▼               │
                               [切 Memory tab]          │
                               黑板/备忘录/验证          │
                                       │               │
                                       ▼               │
                         没有“下一轮/下一个任务” CTA     │
                         用户自行回 Tasks / 星图 / 对话  │
```

### 2.3 当前每步：看到 / 点击 / 切换

| # | 步骤 | 用户看到 | 用户点击 | 表面切换 | 当前摩擦点 |
|---|---|---|---|---|---|
| 0 | 打开工作区 | Welcome、最近工作区、打开按钮 | 打开/选最近 | 0 | 不知道模型/Key/团队/上次进度；打开后无“下一步” |
| 1 | Router 讨论/澄清 | Chat 消息、历史 process、终态、上下文按钮；底部模型/权限/满血 | 输入、发送、展开过程、切模型/权限 | 0（Chat 默认） | 模型/权限/满血与规划入口分离；讨论约束不会自动进入规划上下文 |
| 2 | 规划任务 | Tasks 标签、规划按钮、规划 Modal | 切 Tasks tab → 规划任务 → 输入目标 → 开始规划 | 1 个 tab + 1 个 Modal | 目标需重述；无 DAG 预览/确认/编辑；失败只有 error |
| 3 | 建/分配任务 | 任务列表、任务详情、团队星图 | 自动选中首任务；手工则 +新建（仅标题/描述/验收） | 0–1（Tasks/Team） | 无负责人/依赖/优先级编辑；`selectAgent` 运行时自动挑第一个可用成员，用户看不到 |
| 4 | 运行/暂停 | SchedulerBar、任务状态、运行任务按钮 | 运行任务；暂停/恢复调度 | 0（Tasks） | 规划后不会自动按依赖运行；默认手动入队；用户需逐任务运行；暂停状态不在 Chat 全局可见 |
| 5 | 查看运行与工具过程 | 任务详情 RunHistory/trace；或 Runs 面板 | 运行详情/在运行面板打开；查看工具/心跳 | 0–1（Runs 默认关闭） | 关键监控入口默认关闭且无 route；RunHistory/Review/trace 同屏长滚动 |
| 6 | 评审 diff | ReviewSection 在 Git 之后；任务头部批准/拒绝 | 选文件、查看 diff、评论、通过/要求修改；任务批准/拒绝 | 0（长滚动） | 行级评审与任务级批准/拒绝是两套语义；位置在详情底部；无评审人分配入口；需先满足 reviewer/blocker gate |
| 7 | 合并 | Task VCS 的 PR/checks/合并状态；合并队列 Modal | 加入队列 → 团队合并队列 → 批准 → 合并/waive | 1–2 个表面 + Modal | Review 通过、任务级批准、合并队列批准/合并形成多层门禁；Modal 关闭后队列阻塞不可见 |
| 8 | 记忆/黑板沉淀 | MemoryWorkbench 黑板/备忘录/归档审批 | 切 Memory tab → 发布/验证/归档/提升 | 1 个 tab | 任务完成不自动生成可发布记忆草稿；TaskSummary 自动保存但内容为空；与任务详情无桥 |
| 9 | 继续下一轮 | 任务列表/星图/依赖关系 | 自行找下一个 ready 任务，再运行 | 0–1 | 没有“Next/继续”CTA；依赖完成后不会提示/自动推进 |

**表面切换结论**：一次完整周期至少 **4 个表面**（Chat、Tasks、MergeQueue Modal、Memory），加上 Runs/Context/Team 可到 **6–7 个**；Review/VCS/RunHistory 虽然是内联，但通过长滚动切换“注意力”，不是通过 tab/路由切换。**用户不是在一个“项目工作流”里前进，而是在多个面板之间搬运状态。**

---

## 3. 跨维度审计

### 3.1 主流程是否连续

**不连续的三处断层：**

1. **讨论 → 规划断层**：Chat 负责澄清，规划按钮在 Tasks；规划 Modal 只收目标，不会带入刚才的对话/约束；规划结果直接落任务，无确认。用户要么重述目标，要么手动复制。证据：`src/App.tsx:1717-1741`（handlePlan 直接 plan+refresh+选中首任务）、`src/App.tsx:4010-4048`（Modal 仅 goal）、`src/kernel/service.ts:1797-1876`（plan 只传 goal，不接收对话上下文）。
2. **配置 → 执行断层**：Chat 底部有 Router 模型/权限/满血；规划使用全局 `settings.model`（`service.plan`），不是 Router 当前模型；任务运行又用成员自己的 model/permission。用户看不到“这次执行到底用谁、什么权限、是否满血/预算”，也无法从任务详情直接改。证据：`src/kernel/service.ts:1802-1805`、`src/kernel/execution/kernel.ts:1528-1543`、`src/App.tsx:3585-3690`。
3. **交付 → 沉淀断层**：任务 done 只更新状态/摘要，记忆需要用户切 Memory 手动发布；没有完成后“写一条记忆/开下一轮”的闭环。证据：`src/kernel/service.ts:2169-2179`（自动 saveSummary 的空字段）、`src/App.tsx` 任务详情与 Board 无直接 CTA。

### 3.2 不必要的确认 / 重复输入

- **重复输入目标**：Chat 已讨论目标，规划 Modal 再输入一遍；没有“从当前对话创建计划”。
- **多层批准**：`ReviewSection` 的「通过评审」、任务动作「批准」、合并队列「批准」、合并队列「合并」是四次语义相近的动作；其中 ReviewSection 与任务批准是不同数据层（行级 vs kernel review），但 UI 没有解释。
- **确认不一致**：
  - 会二次确认：调度暂停/恢复、任务重试/取消、任务批准/拒绝、删除任务；
  - 不二次确认：合并队列「合并」、`清理工作树`、`创建 PR`、规划直接创建任务；
  - 结果：用户既觉得安全动作被拦，又可能在不可逆合并/清理上缺少一次确认。
- **批量能力缺失**：规划出 DAG 后没有“运行全部 ready / 自动推进”；每个任务都要回到详情点击运行，重复劳动。

### 3.3 隐藏关键状态

| 状态 | 用户在哪里能看到 | 问题 |
|---|---|---|
| 调度暂停 | Tasks 的 SchedulerBar、Team 总进度 | Chat/任务详情底部/合并队列看不到；用户可能疑惑“为什么不动” |
| 队列/活跃 Run | Tasks SchedulerBar、Team 进度、Runs 面板 | Runs 默认关闭；任务详情只显示当前任务 |
| 审查等待/blocker | 任务行状态、任务详情 nextStep、ReviewSection | 没有“待我处理”入口；ReviewSection 在详情底部 |
| 合并队列/blocked | 只在 MergeQueue Modal/任务 VCS | Modal 关闭后无全局计数；失败/阻塞无 badge |
| 看门狗告警/预算 | topbar、watchdog 面板（默认关）、选中任务 banner | 不随任务/评审流程聚合 |
| 模型/权限/Key/Mock | Sidebar footer、Settings Modal、Chat composer | Welcome/任务/运行不显示“执行契约” |
| 负责人（auto） | 任务行/团队详情 | 无分配 UI；运行时由 `selectAgent` 自动选择，用户不能预期/选择 |
| 任务上下文 | Chat 的上下文、Context 面板（默认关、无 route） | 进入任务/返回后易丢失当前位置 |

### 3.4 权限 / 模型 / 满血 / 上下文在主流程中的位置

- **模型**：Chat 的模型选择只影响 Router 对话；规划固定用 `settings.model`；任务用成员的 model。三个位置、三次决策，任务详情不显示最终模型。→ 需要一条“执行契约”贯穿计划/任务/Run。
- **权限**：Chat 显示 Router 的 permission；任务执行使用任务 owner 的 permission；高风险审批弹窗出现时，用户看得到工具/目标，但任务详情没有“当前权限/为什么被拦”。→ 失败后用户只能去 Team 改成员，再回任务重试。
- **满血模式**：只在 Chat 底部；“满血”是预算/努力提示，不是权限；任务/Run 页没有标识，用户无法判断当前消耗模式和预算。
- **上下文**：Chat 的 Context 面板默认关闭且无 route；任务详情「查看上下文」会跳 Chat，但没有面包屑/返回原详情位置；规划不读取对话上下文。→ 讨论、规划、执行之间的上下文不连续。

### 3.5 失败 / 取消 / 卡住 / 等待评审后的下一步

| 场景 | 当前反馈 | 可执行下一步 | 审计判断 |
|---|---|---|---|
| 任务失败 | 任务行失败 badge、失败 pill、nextStep「失败原因」、RunHistory 错误 | 重试（确认）或打开 Run/任务；可新建 | 主要反馈在任务详情；用户若不在任务页，只剩 sidebar 失败 pill，不能直接到失败任务 |
| 任务取消 | 任务状态 cancelled、nextStep「取消是终态」 | 只能新建任务（无快捷按钮） | 终态说明清楚，但恢复路径弱 |
| 任务阻塞/依赖未完成 | nextStep「等待上游依赖」+ 上游任务链接 | 点上游任务；运行上游 | 链接很好；但依赖完成后没有“继续”提示/自动推进 |
| 等待评审 | 任务状态 review、nextStep、ReviewSection | 通过/要求修改；任务批准/拒绝 | 两个层级动作并列，位置在详情底部；无待评审 inbox |
| 合并 blocked | 只在合并队列 Modal / VCS merge state | 解决冲突/重排队 | Modal 关闭后用户不知道队列被卡 |
| 调度暂停 | SchedulerBar/Team | 恢复调度（确认） | 不在 Chat/任务详情顶部；无全局状态 |
| 看门狗卡住/预算/交接 | topbar、watchdog 面板、任务 banner | ack/resolve/release/fallback | 与任务/评审流程分离；默认面板关闭 |
| 审批等待 | 高风险 Modal | 批准/拒绝/超时 | 阻塞式，合理；但任务详情不显示“正在等待审批”的阶段 |
| Chat 取消/失败 | t175 终态气泡 + 重试预填 | 重试（新 user） | 已明显改善；但与任务重试语义不同，需要在文档/文案区分 |

### 3.6 返回路径与可发现性

- **没有可见的一级导航**：新用户看到的只是 Dock 标签和右侧 Team；Runs/Context/Polls/Watchdog 默认关闭，关闭后要从 ▦/⌘K/Alt 键找回。
- **任务详情的“查看上下文”跳 Chat**：Chat 有「返回任务/团队」，但返回后任务详情的滚动位置/打开的内联区（Review/Run）不保证恢复。
- **任务 VCS/Review 没有 tab/锚点导航**：只能滚动；命令面板可以聚焦，但普通用户不知道。
- **合并队列关闭后**：队列状态只留在 VCS 摘要，没有“队列中有 2 项/1 项 blocked”的常驻 badge。
- **规划完成自动切 Tasks 并选中首任务**：这会把用户从对话上下文带走；虽然 task context 可回 Chat，但对话 scroll/草稿/问题队列不保证恢复。

### 3.7 记忆与下一轮

- 任务完成时 `saveSummary` 写入空的 changes/files/tests/decisions/risks；Memory 的 TaskSummary 不会自动变成可审阅的记忆草稿。
- Memory 是独立 Dock tab，黑板/备忘录/归档审批在内部 tab；任务详情没有“沉淀到记忆”按钮或完成卡。
- 完成后没有“下一个依赖任务/下一轮”快捷入口；用户需回 Tasks 列表/星图寻找 ready 任务并重新运行。
- 因此“继续下一轮”完全依赖用户记住：任务页 → 找任务 → 运行；记忆沉淀是可选支线，主流程没有闭合。

---

## 4. 摩擦与优化建议（12 条）

优先级：**P0 = 主流程阻塞/高杠杆；P1 = 明显降低效率或认知负担；P2 = 打磨/一致性**。

| ID | P | 摩擦（证据） | 建议 | 期望效果 |
|---|---|---|---|---|
| **F1** | P0 | 规划与对话断开：Chat 讨论完去 Tasks 重输目标；规划 Modal 只有 goal，直接创建，无预览（`App.tsx:1717-1741,4010-4048`；`service.ts:1797-1859`） | Chat composer 增加“从这段对话规划”入口；打开**可编辑草案**：目标带入、任务卡、依赖、验收、owner；确认后才创建 | 少一次目标重述；创建前能纠错；讨论→计划连续 |
| **F2** | P0 | 无 DAG/owner/依赖编辑；任务创建不含 owner/deps，`selectAgent` 运行时自动挑第一个非 Router 成员（`App.tsx:1540-1572`；`kernel.ts:1528-1543`；`service.ts:1851-1866`） | 计划草案和任务详情提供**DAG 预览 + 任务卡编辑**（owner/依赖/优先级/验收）；运行前显示“将用谁/为什么” | 用户能控制谁执行、顺序与责任，不再盲跑 |
| **F3** | P0 | 没有常驻的“当前阶段/下一步”；主导航是 Dock tabs，Runs/Context/Polls/Watchdog 默认关；Chat 没有工作流提示（`panelRegistry.ts:42-158`；`App.tsx:125-132`） | 主面板顶部加**WorkflowRail**（讨论→计划→运行→评审→交付→记忆）与唯一主 CTA；保留 Dock，不替代 | 用户始终知道“我在哪、下一步做什么”；减少找面板 |
| **F4** | P1 | 任务详情是长滚动：10+ 动作按钮 + 运行网格 + 描述/验收 + VCS + ReviewSection + RunHistory + trace；Review/合并被埋（`App.tsx:3585-3837`） | 任务详情改**Overview / Review / Runs / Deliver / History 内 tab 或锚点**；主 CTA sticky；危险动作收进菜单 | 评审/交付入口可发现；减少滚动和误点 |
| **F5** | P0 | 多层门禁：ReviewSection「通过评审」、任务「批准」、合并队列「批准」、合并队列「合并」；两套 review 语义无解释（`ReviewSection.tsx:494-532`；`App.tsx:3648-3674`；`GitPanels.tsx:187-226`） | 统一为**一条交付流水线**：行级评审通过 → 合并门禁 → merge；任务级批准只作为兼容快捷入口，文案明确数据层 | 用户不再重复批准/不确定是否已通过 |
| **F6** | P1 | 合并队列是 Modal，关闭后无全局计数/阻塞 badge；只有 Team header 的「合并队列」入口（`GitPanels.tsx:107-226`；`TeamDashboard.tsx`） | WorkflowRail/顶部显示「合并队列 N · blocked M」；点击直接筛选对应任务；队列可作为任务 Deliver tab | 合并阻塞不会丢；从任务到队列一跳 |
| **F7** | P1 | 失败/取消/阻塞/待评审/审批/看门狗分散在任务 nextStep、RunHistory、Chat 终态、topbar、Modal；无统一“待我处理”（`kernelUi.ts:299-350`；`App.tsx:3718-3738`） | 增加**NeedsMe inbox**：失败重试、review、merge blocked、watchdog、审批、问题；每条给一个下一步和一个定位链接 | 用户不用巡面板找异常；恢复路径清晰 |
| **F8** | P1 | 默认手动入队且无“运行全部 ready/自动推进”；规划 Modal 写“任务默认按依赖顺序执行”，实际需逐任务运行；暂停/队列状态不全局（`service.ts:1851-1866`；`kernel.ts` select/autoAdmit；`SchedulerBar.tsx`） | 计划确认时明确选择「运行下一个 / 自动推进 ready」；WorkflowRail 显示 paused/queued；依赖完成后给“继续下游” | 消除“规划完为什么不动”的疑惑；DAG 真正可执行 |
| **F9** | P1 | 执行契约不可见：Chat model/permission/FT 只影响 Router；规划用 `settings.model`；任务用成员 model/permission；任务详情不显示最终契约（`service.ts:1802-1805`；`kernel.ts:1528-1543`；`App.tsx` composer controls） | 在 plan draft、任务头、Run 详情显示**执行契约 chip**：owner / model / permission / FT/预算 / context scope；可跳转编辑 | 任务失败时知道是模型/权限/预算还是代码问题 |
| **F10** | P2 | 上下文面板默认关闭、无 route；任务详情「查看上下文」跳 Chat 后没有面包屑/位置恢复；Review/Run 滚动位置丢失（`panelRegistry.ts:64-74`；`App.tsx:2020-2025,2091-2113`） | 给 Context 一个可恢复入口（Dock tab/route 或任务上下文抽屉）；统一面包屑/返回栈；保存 task detail scroll/tab | 讨论—任务—运行可来回，不迷路 |
| **F11** | P2 | 完成不自动生成记忆草稿；TaskSummary 空字段；Memory 独立 tab，无完成→沉淀→下一轮 CTA（`service.ts:2169-2179`；MemoryWorkbench） | 任务 done/merged 后显示**完成卡**：摘要自动草稿 + “发布到记忆/验证” + 下一个依赖任务/继续规划；失败终态也可记录 | 主流程闭环；下一轮不再靠回忆 |
| **F12** | P2 | 确认层级不一致：暂停/恢复/重试/取消/批准确认；合并、清理工作树、创建 PR 直接执行；动作行有多个 primary（`App.tsx:1439-1530,3585-3690`；`GitPanels.tsx:86-96`） | 建**确认矩阵**：安全可撤销动作直接执行（运行/暂停可撤销）；不可逆动作（合并/清理/删除）二次确认；每屏一个 primary | 降低误操作，同时减少无意义打断 |

> 建议数量 12 条；其中 F1/F2/F3/F5 是 P0。每条都可在不改变权限/内核语义的前提下先做 UI/投影层，属于审计后的候选实现项。

---

## 5. 每一步的理想入口与可见信息

| 步骤 | 理想入口 | 用户应看到 | 唯一主操作 | 次操作 |
|---|---|---|---|---|
| 0 打开 | 现有 Welcome + 打开后的 Workspace Home（可用 Chat 顶部卡片，不新增页面） | 项目名/路径、模型/Key/Mock、Router/成员就绪、上次未完成任务/评审、最近活动 | 继续上次 / 开始规划 | 打开设置、切换工作区 |
| 1 讨论/澄清 | Chat composer | 目标上下文、Router 当前模型/权限、FT/预算、任务上下文 chip、终端/重试 | 发送 | 切模型/权限、清空/压缩、查看上下文 |
| 2 规划/DAG | Chat「从这段对话规划」或 Tasks「规划」 | 目标带入、2–4 任务卡、依赖箭头、owner、验收、风险 | 确认并创建 | 编辑任务/依赖/owner、取消 |
| 3 任务/分配 | Tasks 的 Plan/DAG 视图（列表/星图同一数据） | 任务状态、owner、依赖、下一可运行任务、执行契约 | 运行下一个 / 运行全部 ready | 改 owner/优先级、编辑验收 |
| 4 运行/暂停 | 任务头 + SchedulerBar | 当前阶段、排队原因、活跃 Run、暂停/恢复、并发/预算 | 运行 | 暂停、取消、重试 |
| 5 监控 | Task 的 Runs/Activity tab（不依赖默认关闭的 Runs 面板） | 当前 step/工具、心跳、tokens/成本、错误、运行历史、trace | 查看/取消/重试 | 打开完整 Runs 面板 |
| 6 评审 | Task 的 Review tab（diff/comments/decision 同屏） | 文件列表、diff、blocker、reviewer、评审 gate、我的决定 | 通过评审 / 要求修改 | 评论、解决、移除 reviewer、分配 reviewer |
| 7 交付/合并 | Task 的 Deliver tab + WorkflowRail 队列 badge | PR/checks/merge 状态、队列位置、blocked 原因、批准/合并 | 加入队列 / 合并 | 创建 PR、waive checks（需原因）、清理工作树（确认） |
| 8 记忆/下一轮 | Task done 完成卡 + Memory | 自动摘要草稿、可发布记忆、下一个依赖任务、下一轮入口 | 发布记忆并继续 | 跳过、只发布、打开黑板 |
| 9 异常恢复 | NeedsMe inbox + 任务/聊天气泡 | 失败/取消/阻塞/审批/告警的原因、影响、一个下一步 | 重试/恢复/处理 | 定位 Run、查看 trace、忽略 |

---

## 6. After：建议的目标流程 ASCII

```text
                    ┌──────────────────────────────────────────────┐
                    │ WorkflowRail: 讨论 → 计划 → 运行 → 评审 → 交付 → 记忆 │
                    │ [NeedsMe: 失败2 · 评审1 · 合并blocked1]              │
                    └──────────────────┬───────────────────────────┘
                                       │
┌─────────────┐    ┌──────────────────▼──────────────────┐
│ Workspace   │    │ Chat                                 │
│ Home        │───▶│ 讨论/澄清 + [从这段对话规划]           │
│ 就绪/上次   │    │ 模型/权限/FT/context 执行契约 chip      │
└─────────────┘    └──────────────────┬──────────────────┘
                                      │ 生成可编辑草案
                                      ▼
                       ┌──────────────────────────────┐
                       │ Plan Draft / DAG Preview     │
                       │ 任务卡/依赖/owner/验收/风险    │
                       │ [编辑] [确认创建]             │
                       └──────────────┬───────────────┘
                                      │ 确认
                                      ▼
                       ┌──────────────────────────────┐
                       │ Tasks: 列表 ⇄ DAG            │
                       │ 状态/owner/依赖/下一可运行     │
                       │ [运行下一个] [运行全部 ready]  │
                       └──────────────┬───────────────┘
                                      │
                                      ▼
                       ┌──────────────────────────────┐
                       │ Task Workspace               │
                       │ Overview | Runs | Review |   │
                       │ Deliver | History            │
                       │ 执行契约 + sticky CTA        │
                       └───────┬───────────┬──────────┘
                               │           │
                    运行时活动 │           │ 评审/交付
                               ▼           ▼
                    ┌────────────────┐  ┌────────────────────┐
                    │ Run Activity   │  │ Review + Deliver   │
                    │ step/tool/心跳 │  │ diff/check/PR/队列 │
                    │ 失败/重试      │  │ 通过→合并          │
                    └────────┬───────┘  └─────────┬──────────┘
                             │                    │
                             └──────────┬─────────┘
                                        ▼
                       ┌──────────────────────────────┐
                       │ Done Card                    │
                       │ 摘要草稿 + 记忆发布/验证      │
                       │ 下一个依赖任务/继续规划       │
                       └──────────────────────────────┘

NeedsMe 横切：失败/取消/阻塞/审批/评审/合并 blocked/看门狗，每条带定位 + 下一步。
```

关键不是新增一个页面，而是**把已有状态投影成一条连续的工作流**：Dock 保留，但 WorkflowRail/NeedsMe 常驻；Chat/Tasks/Review/Merge/Memory 成为同一周期的不同阶段，而不是用户要自己记住的面板集合。

---

## 7. 建议的验收/度量（供后续实现与复审）

1. **表面切换**：完整“目标→首个任务运行”≤2 个表面；“任务→评审→合并”≤2 个表面（当前 4–6 + 多层 Modal）。
2. **计划可纠错**：从讨论创建计划时目标自动带入率 100%；计划确认前可编辑任务/依赖/owner；创建前无隐藏副作用。
3. **可达性**：仅键盘可完成“讨论→计划确认→运行→评审→合并→发布记忆”；所有状态有可读标签/role；返回不丢选中任务与当前 tab。
4. **异常闭环**：失败/取消/阻塞/评审等待/合并 blocked/看门狗均有 NeedsMe 条目、一个下一步和定位链接；不存在只在 Modal/toast 中的关键状态。
5. **门禁唯一性**：同一交付不被要求多次“批准”；ReviewSection 与 merge gate 的层级/文案可区分；未通过 review 不能意外 merge。
6. **记忆闭环**：done/merged 后有自动摘要草稿与“发布/跳过/下一任务”入口；任务完成不强制写记忆。
7. **指标**：目标到首任务时间、每周期表面切换数、review→merge 完成率、NeedsMe 滞留时长、上下文恢复成功率、误操作率（合并/清理）、用户主观“知道下一步”评分。

---

## 8. 证据卡 / 待确认问题

### 8.1 代码证据

| 事实 | 证据 |
|---|---|
| 默认 Dock：chat + team；tasks/mailbox/board tab；runs/context/polls/watchdog 关闭 | `src/shell/dock/panelRegistry.ts:42-158`、`src/shell/dock/DockShell.tsx:142-173` |
| 主导航不是侧栏；TABS 只用于快捷键/标题 | `src/App.tsx:125-132`、`src/App.tsx:2277-2282` |
| Welcome 只显示打开/最近 | `src/App.tsx:2284-2314` |
| 规划入口在 Tasks，Modal 只有 goal，直接创建/选中首任务 | `src/App.tsx:1717-1741,4010-4048`；`src/kernel/service.ts:1797-1876` |
| 创建任务无 owner/deps/priority | `src/App.tsx:1540-1572`；`src/kernel/service.ts:586-...` |
| 运行时自动选 owner/成员 | `src/kernel/execution/kernel.ts:1528-1543` |
| 任务详情长滚动和 10+ 动作 | `src/App.tsx:3585-3837` |
| ReviewSection 决定在 diff/评论后 | `src/review/ui/ReviewSection.tsx:494-532` |
| VCS 的加入队列/创建 PR/清理 | `src/git/ui/GitPanels.tsx:86-96` |
| 合并 Modal 批准/合并/waive | `src/git/ui/GitPanels.tsx:187-226` |
| nextStep 文案覆盖失败/阻塞/评审/运行 | `src/shared/kernelUi.ts:299-350` |
| TaskSummary 自动保存但字段空 | `src/kernel/service.ts:2169-2179` |
| 当前 Chat 终态/重试 | `src/App.tsx` `ChatTurnTerminalBubble`、`retryComposerState`；`docs/team/t175-chat-terminal.png` |

### 8.2 截图证据

- `docs/team/t175-chat-terminal.png`：当前 Chat/Team 双栏 + 取消终态 + 重试。
- `docs/team/t69-task-scheduler.png`：Tasks/Scheduler/任务详情/Team/星图三栏基线（旧图；当前 ReviewSection 会继续加长详情）。
- `docs/team/t69-run-panel.png`：Runs 面板（默认关闭；当前仍是独立面板）。
- `docs/team/t103-task-vcs.png`：任务 VCS（旧图；当前其后新增 ReviewSection）。

### 8.3 待确认问题（不阻塞本审计）

1. 规划后的执行策略：产品是否希望默认“运行下一个”，还是保持完全手动？是否 expose `kernel.autoAdmit`？
2. 行级 ReviewSection 与 kernel review 的产品关系：评审通过是否应自动允许 merge，还是保留独立 merge approval？
3. 合并队列的常驻表达：顶部 badge、WorkflowRail 或 Task Deliver tab，哪个优先？
4. 记忆沉淀：任务完成自动生成草稿并等待人类发布，还是保持完全手动？
5. 负责人分配：是否允许任务级 owner 覆盖，还是坚持运行时自动选择？
6. 窄窗/单栏下 WorkflowRail 与任务 tab 的降级方式；是否需要将 Team 改成按需面板？

> 本审计不实现以上建议；建议先由 Captain 汇总/投票，再按 worktree/PR 拆分（F1/F2/F3/F5 可先做最小可用实现，F4/F6–F12 分批）。
