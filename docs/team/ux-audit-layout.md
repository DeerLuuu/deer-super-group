# 界面层级与信息架构审计（t180）

- **审计员**：nova（DeepSeek 席位）
- **基线**：`main@b908d1a`（2026-11-11）
- **输入**：`docs/team/ux-audit-agenda.md`、Dock/App/Team/Settings/Git/Review 当前代码、现有截图
- **范围**：只审计信息层级与二级面板/弹窗边界；不修改 `src/`、`electron/`、`dist*/`、`branches/`
- **视图基准**：1440×900、1424×855（旧截图）、1100×760、960×700（Electron min）、Dock 900/760/single
- **结论**：未发现 P0 级布局阻断；发现 **8 条 P1、6 条 P2、1 条 P3**。最需要先裁决的是：一级导航缺失、1100 宽度/窄侧栏下主区与团队栏互相挤压、任务详情无 tab、Settings/MergeQueue 长内容 Modal 化。

> **证据等级**：`C1` = 当前代码路径/行号；`C2` = 当前截图；`C3` = 代码推导的复现假设（需真机确认）。
> `t69-*`、`t103-*` 截图早于 t168/t175/t177/watchdog/poll；本文只用它们作布局/密度参考，不把旧图当现状结论。

---

## 1. 当前层级图

```text
Window (.app)
├─ Sidebar（常驻，可折叠；宽 180–480，默认 250）
│  ├─ Brand
│  ├─ Workspace（名称/路径/切换）
│  ├─ 操作：⌘K、＋新建、刷新、▦面板、⚙设置
│  ├─ 运行中/失败 pill（折叠时隐藏状态区）
│  ├─ 导航提示
│  └─ Footer：Key/Mock、成员数（折叠时隐藏）
├─ Resizer（6px）
└─ main
   ├─ 全局 error banner（最近一条错误）
   ├─ Watchdog topbar（有 snapshot 时：看门狗按钮 + 今日预算 + open alert 数）
   └─ Dock host（唯一主内容区）
      ├─ Main group：chat / tasks / mailbox / board 的 tab
      └─ Team group（右栏，默认 42–48%，single 变体不创建）
         └─ team: 总进度 → 成员 → 星图 → 选中任务摘要（同一纵向滚动）
Overlays（z-index 1000）：
   Settings Modal / MergeQueue Modal / Question Modal / Risk Approval Modal /
   KernelConfirm / TaskCompose / RouterPlan / Delete / Member edit / Memory dialogs /
   Poll create Modal / Command Palette / Toast
Inline 二级区（不是路由）：
   Tasks: 任务动作行 → runtime → 描述/验收/摘要 → TaskVcsPanel → ReviewSection → RunHistory → trace
   Team: 进度 → 成员 → 星图 → 选中任务摘要
```

### 1.1 当前默认可见性

| 层 | 默认可见 | 默认关闭/隐藏 | 说明 |
|---|---|---|---|
| Dock main group | chat、tasks、mailbox、board（tab） | runs、context、polls、watchdog | `MAIN_GROUP_ORDER` 只列 4 个；`team` 默认右栏 |
| Dock right group | team | — | 窗口/Dock ≥760 才创建；single 变体不创建 |
| Sidebar | 常驻；可折叠 | 折叠时隐藏导航提示、footer、失败 pill 文案 | 折叠后仍有图标按钮 |
| Settings | 点击/⌘K/`#/settings` 打开 Modal | 不是 Dock 面板 | 旧 `settings` PanelKey 仍在注册表 |
| MergeQueue | 按钮/⌘K/`#/tasks?merge=1` | — | 独立 `git-queue-modal`，不是通用 Modal |
| Context | 默认关闭 | 无 routeTab | 从 Chat/Task 打开 |
| Polls | 默认关闭 | 无 routeTab | 从面板启动器/⌘K/任务/黑板打开 |
| Watchdog | 默认关闭 | 无 routeTab | Topbar 常驻入口/预算/告警数 |

证据：`src/shell/dock/panelRegistry.ts:14-24`、`41-157`；`src/shell/dock/DockShell.tsx:142-163`；`src/App.tsx:121-131`、`2449-2466`、`2540-2584`。

---

## 2. 逐屏 keep / move / panel / modal 表

> 目标层：**常驻** = 始终可见/一眼可达；**面板** = Dock/全页，保留滚动与上下文；**Modal** = 短、原子、必须打断。成本 S/M/L 只估算改造验证成本，不含投票/评审时间。

| 表面/信息 | 当前层 | 建议 | 理由 | 成本 |
|---|---|---|---|---|
| 工作区身份（名称/路径/切换） | Sidebar 常驻 | **keep**，并补最近工作区状态 | 跨流程需要；当前切走会丢 Dock/选中上下文 | S |
| 模型/Key/Mock/团队就绪度 | Split：Welcome 无、Sidebar footer 有 Key/Mock | **move** 到 Welcome 预检 + 常驻状态条 | 首次打开无法一眼确认能否开始 | S |
| 一级导航（Chat/Tasks/Team/Runs/Memory/Poll/Watchdog/Settings） | Dock tabs + ▦菜单 + ⌘K | **panel/常驻 rail**：增加可见、带标签与状态的一级导航 | 现在没有“页面”概念；隐藏面板无入口标记 | M |
| 运行中/排队/失败 | Sidebar pill + Team 进度 + SchedulerBar + 任务行 | **常驻 “需要我处理” 汇总** | 状态分散在 4+ 表面，折叠后失败 pill 消失 | M |
| 预算/告警 | Watchdog topbar + 面板 | **keep topbar**，告警升级为全局 attention；面板保留详情 | 预算/告警跨任务，不应只在关闭面板/单行 topbar | M |
| 待评审/blocker | ReviewSection（任务详情底部） | **panel/tab**：增加“待评审”入口与计数 | 当前只有进入任务并滚到底部才看见 | M |
| 待合并/checks/waive | MergeQueue Modal | **move → 面板/路由** | 多行比较、反复操作、需要背景上下文，Modal 不合适 | M |
| Settings 7 段 | Settings Modal | **move → 全页/面板** | 长内容 + 多次保存 + 深链；Modal 关闭丢草稿 | M |
| Chat 对话 | Dock panel | **keep**；把“规划”动作从 Tasks 拉回 Chat composer/上下文 | 讨论后必须换面板重新输入目标 | S |
| Team 总进度/成员/星图 | 右栏 panel | **keep panel**，但只读摘要；编辑/详情移出 | 右栏同时承担监控、成员管理、任务详情，信息竞争 | M |
| Tasks 列表 + 详情 | Dock panel | **keep**；详情改内部 tab/subnav | 当前 VCS/Review/RunHistory/trace 长滚动堆叠 | M |
| Task 动作行（运行/重试/批准/拒绝/取消） | Inline 行 | **keep 一个 primary + overflow** | 当前 3 个 primary，用户不知唯一下一步 | S |
| Runs | 默认关闭 panel | **panel**；补 hash/状态标记，或作为 Tasks 的 delivery tab | 与 RunHistory 重复，默认关闭导致监控不可发现 | M |
| Context | 默认关闭 panel、无 route | **panel**；保留返回源按钮，增加“已打开”状态 | 任务上下文容易迷路；关闭后只能菜单找回 | S |
| Memory/Board | tab panel | **keep**；统一“记忆/黑板/备忘录”命名 | 命名分层不清（见 Q7） | S |
| Polls | 默认关闭 panel、无 route | **panel**；从任务/黑板发起后给结果入口/计数 | 发起后结果不可发现 | M |
| Watchdog | 默认关闭 panel + topbar | **panel**；技术命名改“运行监控/限额”或补副标题 | “看门狗”对非工程用户不可读 | S |
| 新建任务/规划/删除 | Modal | **keep Modal**；规划加预览（见 F04） | 短表单/危险确认适合 Modal | S/M |
| 提问/高风险审批 | 阻塞 Modal | **keep Modal**，禁止嵌套 | 必须打断、单次决定；当前已有 risk 优先 | S |
| 成员编辑/删除 | Modal + Settings 团队表 | **one owner**；Settings 只跳转/汇总 | 同一成员字段两处编辑 | M |
| 记忆发布/复核/TTL/归档 | Modal/Dialog | **keep Modal** | 从条目发起的短动作 | S |
| Poll 创建 | Modal | **keep Modal** | 短表单；候选来源可预填 | S |
| Command Palette | Overlay | **keep**，但不能是唯一入口 | 导航第二入口；当前隐藏面板依赖它 | S |
| Toast / 全局 error banner | Overlay / 顶部 banner | **keep**；统一错误入口，面板错误就近保留 | 当前 toast、banner、面板 error 三套 | S |

---

## 3. Findings（15 条）

> 每条：ID / 严重度 / 视图 / 现状与证据 / 影响 / 建议 / 成本。
> “证据”里的行号对应当前 `main@b908d1a`。

### F01 · P1 · 没有可见的一级导航，关闭的辅助面板只能靠通用“面板”菜单/⌘K 找回

- **视图**：所有；1424×900，960×700。
- **现状/证据**：
  - `TABS` 只有 6 个映射项，用于快捷键/标题，不是可见导航（`src/App.tsx:133-141`）。
  - 面板启动器是一组按钮，面板列表只在 `panel-menu` 弹出层里渲染（`src/App.tsx:121-131`、`2443-2466`）。
  - `runs`、`context`、`polls`、`watchdog` 默认关闭；其中 context/polls/watchdog 没有 `routeTab`（`src/shell/dock/panelRegistry.ts:64-75`、`87-100`、`123-145`）。
  - 面板关闭后，如果还有其他面板存在，没有 tab 或 badge 表示它曾打开；⌘K 是唯一稳定入口。
- **影响**：新用户无法从界面知道“运行/投票/上下文/看门狗”存在；关闭后不可发现。命令面板从“第二入口”变成隐藏功能的唯一入口。
- **建议**：增加可见的一级 rail/list（Chat、Tasks、Team、Runs、Review、Memory、Poll、Monitor、Settings），显示打开状态/待办计数；Dock tab 仅作为组内切换。保留 ⌘K 作为加速器。
- **成本**：M。

### F02 · P1 · “需要我处理”的状态分散在 5+ 表面，没有单一 attention 队列

- **视图**：所有；有失败/告警/待评审数据时。
- **现状/证据**：
  - Sidebar 只有 `failedCount` pill，且位于 `!sidebarCollapsed` 分支（`src/App.tsx:2486-2495`）。
  - Watchdog topbar 只显示预算和 open alert 数（`src/App.tsx:2561-2584`）。
  - Team 总进度把“合并队列/记忆/运行面板”做成三个无计数的 ghost 按钮（`src/TeamDashboard.tsx:455-477`）。
  - 待评审/blocker 只在任务详情 ReviewSection（`src/review/ui/ReviewSection.tsx:204-213`、`517-529`）。
  - 合并队列是 Modal，无全局入口计数；任务详情的 RunHistory 也没有全局未处理数。
- **影响**：用户要跨 Sidebar、Team、SchedulerBar、Task、Watchdog、MergeQueue 拼状态；失败/待评审/告警容易漏处理，尤其侧栏折叠时。
- **建议**：在常驻区域增加“需要我处理”汇总（failed / blocked / pending review / pending merge / open alerts / budget），每项可跳到对应过滤视图；顶级计数应在折叠侧栏也可见或放到 topbar。
- **成本**：M–L。

### F03 · P1 · 1100 默认宽度 / 960+窄侧栏时，Tasks 主区被 Team 右栏压到低于其最小宽度

- **视图**：1100×760（默认侧栏）；960×700（Electron 最小，侧栏拖到 180）；1440×900 对照。
- **现状/证据**：
  - Electron `minWidth: 960`（`electron/main.ts:59-64`）。
  - Sidebar 最小 180、默认 250，resizer 6（`src/styles.css:200-218`）。
  - 1100 默认侧栏 250 → Dock 约 844；`selectVariant(844)` = `medium`，Team 权重 44% ≈371，主组 ≈473。
  - 960 侧栏 180 → Dock 约 774；`selectVariant(774)` = `narrow`，Team 48% ≈371，主组 ≈403；只有侧栏保持默认 250 时 Dock 704 才落到 `single`（Team 不创建）。
  - narrow/medium 下 Team 都创建右栏（`DockShell:155-163`）；Tasks panel `minWidth: 560`（`registry:76-85`）。
  - Tasks 内部列表 + 6px resizer + 详情列（`src/styles.css:769-775`），详情动作行还会 wrap。
- **影响**：1100 默认窗口即可让任务详情低于 560 最小宽度；960 下用户只要把侧栏拖窄（或保存过 180 宽度）就会触发。动作按钮换行、内容横向收缩；Team 右栏却保留 371px。
- **建议**：按 Dock 实际宽度而不是窗口宽度选 single；或者在主组 <760 时自动把 Team 收为 tab；或提高 Team 折叠阈值（例如 <1200 即单栏）；同时复核 Tasks 详情列在 420–560 的最小可用性。
- **成本**：M。
- **备注**：此条是代码推导的 P1 假设，需在 1100×760 与 960×700（侧栏 180）真机复核；没有当前窄窗截图。

### F04 · P1 · “规划”入口在 Tasks Modal，和 Chat 讨论断裂；执行前无 DAG 预览

- **视图**：Chat → Tasks；`RouterPlanModal`。
- **现状/证据**：
  - 规划按钮在 Tasks 面板头部（`src/App.tsx:3397-3405`），点击只打开目标 textarea Modal（`3998-4048`）。
  - Chat composer 没有规划动作；用户讨论完要切面板、重新输入目标。
  - Modal 直接 `onPlan(goal)`；没有依赖/负责人/验收预览，也没有确认步骤（`4017-4044`）。
- **影响**：从“讨论”到“计划”多一次上下文切换与重复输入；用户无法在创建前修正 DAG，错误计划直接进入任务列表。
- **建议**：在 Chat 的上下文/目标直接提供“规划”入口；规划结果先进入可编辑预览（DAG + 验收 + 负责人）或只读确认 Sheet，再由用户确认创建。
- **成本**：M。

### F05 · P2 · Settings 是 7 段长 Modal，且关闭不保护未保存草稿

- **视图**：打开设置（Sidebar/⌘K/`#/settings`/Git 深链）。
- **现状/证据**：
  - `SettingsView` 有 7 段：模型/翻译/Git/插件/MCP/Skills/团队（`src/SettingsView.tsx:14-31`）。
  - 设置以 `Modal` 渲染，`.settings-modal` 宽 `min(1180px,96vw)`、高 `88vh`（`src/App.tsx:2913-2918`、`src/styles.css:3737-3744`）。
  - `closeSettings` 直接关闭并清理翻译缓存，没有 dirty 检查（`src/App.tsx:470-476`）。
  - 插件/MCP/Skills 仍是 `Placeholder`（`src/SettingsView.tsx:791-812`），但导航仍列 3 段。
- **影响**：长设置不适合 Modal：关闭丢草稿、无法与任务/日志并看；占位段增加“已配置”的错觉。
- **建议**：把 Settings 作为面板/全页路由（保持子导航与保存）；补 dirty close 确认；未实现段改为“即将支持”并在导航降级/隐藏。
- **成本**：M。

### F06 · P2 · 合并队列是 Modal，不适合多行比较与反复操作

- **视图**：Team 总进度「合并队列」、⌘K、`#/tasks?merge=1`。
- **现状/证据**：
  - App 将 `MergeQueueModal` 作为独立 Modal 挂载（`src/App.tsx:2931-2935`）。
  - 队列组件自定义 `git-queue-modal`，宽 720、最高 90vh，内部滚动（`src/git/ui/GitPanels.tsx:175-184`）。
  - 每项有批准/合并/waive checks 原因输入（`GitPanels.tsx:187-226`）。
  - 旧截图 `docs/team/t103-merge-queue.png` 仍是当前形态，仅用于参考。
- **影响**：用户需要对照多项 branch/checks/PR 并多次操作；Modal 关闭即丢滚动/选择，背景任务详情不可见。
- **建议**：改为面板/路由（或全页 Drawer），保留队列筛选、行选择、背景任务上下文；Modal 仅保留单次“确认合并”危险动作。
- **成本**：M。

### F07 · P1 · 任务详情没有 tab，VCS/Review/RunHistory/trace 纵向堆叠，评审容易被埋

- **视图**：Tasks 详情；有 VCS/评审/多 Run 时。
- **现状/证据**：
  - `task-detail-panel` 无内部 tab（`src/App.tsx:3509-3547`）。
  - 内容顺序为描述/验收/摘要 → TaskVcsPanel → ReviewSection → RunHistory → trace（`App.tsx:3782-3835`）。
  - 旧截图 `t69-task-scheduler.png` 只到 RunHistory，已可见纵向内容很长；当前 ReviewSection/评审增加了更多步骤。
- **影响**：用户点“批准”时可能尚未看到 ReviewSection/blocker；评审/合并被埋在 2–3 屏之后，容易漏 gate。
- **建议**：详情内部 tab/子导航：`概览 | 交付 (VCS/Review) | 运行历史 | 事件`；或至少把 Review gate 摘要固定在头部，问题/bocker 直接跳转。
- **成本**：M。

### F08 · P1 · 任务动作行有 3 个 primary，缺少“当前唯一建议动作”

- **视图**：Tasks 任务详情头部；任意状态。
- **现状/证据**：
  - 同一行渲染“运行任务 / 重试任务 / 批准”三个 `primary small`，另有拒绝/取消 ghost（`src/App.tsx:3620-3689`）。
  - `taskNextStep` 已算出下一步，但以独立提示块显示在动作行下方（`App.tsx:3718-3737`），与按钮不绑定。
  - RunPanel/Team 详情还有同类动作。
- **影响**：三个 primary 竞争注意力；用户可能运行一个正在等待评审的任务，或批准一个未运行的任务；误操作风险与状态提示不一致。
- **建议**：从 `taskNextStep` 选唯一 primary，其余动作收进 overflow/更多菜单；每个动作显示作用域与前置 gate（如“批准交付” vs “通过评审”）。
- **成本**：S。

### F09 · P1 · Tasks 详情与 Team 右栏详情重复，Team 还同时承担监控/成员/星图

- **视图**：默认 1424×900；Team 右栏。
- **现状/证据**：
  - 默认创建 Team 右栏（`DockShell:155-163`），宽度 42–48%。
  - Team 主体是进度 → 成员 → 星图 → 选中任务摘要，全部纵向（`src/TeamDashboard.tsx:164-175`、`261-366`）。
  - 选中任务摘要提供 Git 状态/运行详情/打开任务会话（`TeamDashboard.tsx:296-320`），与 Tasks 详情的 VCS/Run/动作重复。
- **影响**：同一任务存在两个可操作表面，状态/选择可能不一致；右栏把监控、成员管理、任务详情混合，用户必须滚动找当前任务。
- **建议**：Team 只保留只读监控（进度/成员状态/星图 + 任务摘要），任务操作统一跳到 Tasks 详情；成员编辑留在 Team 或 Settings 的单一入口。
- **成本**：M。

### F10 · P1 · “批准”一词在三个作用域复用：任务交付、代码评审、合并队列

- **视图**：Tasks 动作行；ReviewSection；MergeQueue Modal。
- **现状/证据**：
  - Tasks 动作行按钮“批准”“拒绝”（`src/App.tsx:3648-3675`）。
  - ReviewSection 按钮“通过评审 / 要求修改”（`src/review/ui/ReviewSection.tsx:507-529`）。
  - MergeQueue 每项“批准 / 合并 / 豁免 checks”（`src/git/ui/GitPanels.tsx:187-226`）。
- **影响**：三个“批准”改变不同对象（任务状态、评审 gate、合并审批）；用户在同一任务流里容易点错，且错误后不可逆。
- **建议**：术语和作用域显式化：`批准任务交付`、`通过代码评审`、`批准入队` + `确认合并`；按钮旁显示目标分支/commit/checks 摘要。
- **成本**：S。

### F11 · P2 · Modal 没有统一队列/仲裁；Settings、MergeQueue、Question、Risk 可各自挂载

- **视图**：深链/⌘K/自动触发并发时。
- **现状/证据**：
  - Settings、MergeQueue、Question、Risk 是四个独立条件渲染（`src/App.tsx:2913-2918`、`2931-2935`、`2939-2960`、`2961-3026`）。
  - 只有 Question 与 Risk 有互斥逻辑：风险审批到达时关闭问题（`App.tsx:1115-1120`）；没有 Settings/MergeQueue 的统一仲裁。
  - 命令面板和 hash 都可以在打开 Modal 时改变状态（`App.tsx:947-997`）。
- **影响**：可能出现多层 backdrop / 焦点被抢 / 关闭一个 Modal 回到另一个未预期 Modal；未保存草稿无确认（Settings）。
- **建议**：引入单一 overlay/modal 队列（同一时刻最多一个一级 Modal；危险确认可在其内用内联确认），统一 Esc/焦点/关闭策略；或明确规定“设置/合并队列打开时禁用深链和自动弹窗”。
- **成本**：M。

### F12 · P2 · 辅助面板缺少 route/可见状态，发起 Poll/上下文后难找回

- **视图**：Polls/Context/Watchdog/Runs。
- **现状/证据**：
  - `context`、`polls`、`watchdog` 的 `routeTab: null`，默认 `defaultClosed`（`panelRegistry.ts:64-75`、`123-145`）。
  - `runs` 路由复用 `tasks`，只有 `r=?` 深链；默认关闭（`registry.ts:87-100`）。
  - Poll 从 Tasks/Board 发起后只调用 `openPanel("polls")`；关闭后没有未读/结果 badge。
  - `TABS` 不含 polls/watchdog/context（`App.tsx:133-141`）。
- **影响**：用户发起投票/查看上下文后，关闭面板即失去对象；结果/告警只有再次打开菜单才能发现。
- **建议**：给这些面板加 hash route（或至少 `?poll=`/`?context=` 参数）和“已打开/有更新”状态；Poll 关闭后保留 decision 通知/入口；Watchdog 告警纳入 attention。
- **成本**：M。

### F13 · P2 · 首次 3 分钟的“就绪度”分散在 Welcome/Sidebar/设置

- **视图**：Welcome、首次打开 workspace。
- **现状/证据**：
  - Welcome 只有品牌、说明、打开文件夹、最近工作区、错误（`src/App.tsx:2286-2315`）。
  - 模型/Key/Mock 只在打开后的 Sidebar footer（`App.tsx:2515-2527`）；模型配置在 Settings Modal；团队就绪度只在 Team 面板。
  - 没有“下一步”引导或预检清单。
- **影响**：新用户不知道模型是否可用、是否有 worker、该先规划还是先对话；容易停在空 Chat。
- **建议**：Welcome/首启加 4 项预检：模型/Key、模式（Mock/真实）、团队成员、下一步（打开对话/规划）；Sidebar footer 补模型名而不是只显示 Key 来源。
- **成本**：S–M。

### F14 · P2 · 成员管理在两个层级重复：Settings 团队表 vs Team 成员列表/编辑 Dialog

- **视图**：Settings → 团队；Team → 成员。
- **现状/证据**：
  - Settings 团队段有成员表 + 保存（`src/SettingsView.tsx:722-788`）。
  - Team 右栏有新建成员、编辑、删除（`src/TeamDashboard.tsx:175-255`），编辑 Dialog 字段包括模型/权限/提示词（`TeamDashboard.tsx:624-748`）。
  - Settings 团队段提示“默认模型与成员”，与 Team 的新建/编辑重叠。
- **影响**：同一成员可在两处改模型/权限；保存语义不同（Settings 批量保存 vs Dialog 单次），容易出现“我改了但没保存/被覆盖”。
- **建议**：把成员 CRUD 收敛到一个表面（建议 Team 成员列表 + Dialog，Settings 只保留默认值与跳转）；或在 Settings 团队段只读并明确“去团队页编辑”。
- **成本**：M。

### F15 · P3 · `settings` 仍注册为 Dock PanelKey，但实际是 Modal；旧布局恢复可能得到空面板

- **视图**：旧版本保存的 Dock 布局 / `#/settings` 恢复。
- **现状/证据**：
  - `panelRegistry.ts:147-157` 仍定义 `settings` 面板（`routeTab: "settings"`，不可关闭）。
  - `openPanel("settings")` 被 App 特判为打开 Modal（`src/App.tsx:443-447`）。
  - `renderPanel` switch 没有 `case "settings"`；DockShell 从 localStorage 恢复的旧布局若含 settings，会渲染空 body（`DockShell.tsx:184-217`；`App.tsx:2595` switch）。
- **影响**：升级后的旧布局可能出现无名/空白设置 tab；面板注册表与真实 IA 双形态，增加维护/文档歧义。
- **建议**：从 `PanelKey`/`PANEL_DEFS` 删除 settings，或保留 key 但在 `renderPanel` 渲染重定向提示；迁移保存布局时过滤 settings。
- **成本**：S。

---

## 4. 重复入口 / 信息分散矩阵

| 信息/操作 | 入口 A | 入口 B | 入口 C | 主要风险 | 关联 |
|---|---|---|---|---|---|
| 任务详情 | Tasks 详情 | Team 右栏摘要 | 星图选中 | 双可操作表面、选择状态不同 | F09 |
| 运行历史 | Tasks `RunHistory` | RunPanel | Team “运行面板” | 默认关闭 + 两套视图 | F07/F12 |
| 评审 gate | ReviewSection | 任务动作“批准” | MergeQueue 批准 | 语义/作用域混淆 | F10 |
| 合并 | MergeQueue | Task VCS 入口 | Team 进度“合并队列” | 都在 Modal/不同上下文 | F06/F10 |
| 成员编辑 | Team 成员列表 | Settings 团队表 | 新建成员 Modal | 保存语义不一致 | F14 |
| 记忆 | Board tab | Team “记忆” | Tasks/Board 发起 Poll | 命名/入口层级不同 | F12/Q7 |
| 设置 | Sidebar ⚙ | ⌘K | `#/settings` / Git 深链 | Modal 无 dirty guard | F05/F11 |
| 规划 | Tasks 头部「规划任务」 | ⌘K | 空状态 | Chat 无入口，需换面板 | F04 |
| 告警/预算 | Watchdog topbar | Watchdog 面板 | 任务/运行内联 banner | 无单一 attention 队列 | F02/F12 |

---

## 5. 窄窗/三栏验算（代码推导）

| 窗口 | Sidebar | Dock 宽 | Variant | Team 宽 | Main 主组宽 | Tasks min 560 是否满足 | 风险 |
|---|---:|---:|---|---:|---:|---|---|
| 1440 | 250 | 1184 | wide | 42% ≈497 | 58% ≈687 | 是（列表+详情分列） | 主详情仍偏窄 |
| 1100 | 250 | 844 | medium | 44% ≈371 | 56% ≈473 | **否** | 默认侧栏即冲突 |
| 1100 | 180 | 914 | medium | 44% ≈402 | 56% ≈512 | **否** | 同上 |
| 960 | 250 | 704 | single | 0 | 704 | 是 | Team 消失，需重新打开 |
| 960 | 180 | 774 | narrow | 48% ≈371 | 52% ≈403 | **否** | 侧栏拖窄即踩 |
| 900 | 180 | 714 | single | 0 | 714 | 是 | Team 无右栏 |

> 计算依据：`electron/main.ts:59-64`、`src/styles.css:200-218`、`panelRegistry.ts:171-186`、`DockShell.tsx:155-163`、`panelRegistry.ts:76-85`。
> 这不等于实际 dockview 的最终像素（还有 minimumWidth 约束与用户拖动），但说明阈值设计存在结构性冲突；需要用 960×700 真机确认。

---

## 6. 与 t179 议程假设的对照

| t179 假设 | 本次结论 | 证据 |
|---|---|---|
| Settings 长 Modal 是重点 | 成立，且补出 **无 dirty guard**、3 个占位段 | F05 |
| MergeQueue 可能改面板 | 成立；多行比较+waive，Modal 不合适 | F06 |
| Task 详情无 tab 长滚动 | 成立；Review 在 VCS 之后、RunHistory 之前 | F07 |
| 动作行层级不清 | 成立；3 个 primary + nextStep 分离 | F08 |
| 注意力入口分散 | 成立；failed pill/watchdog/Team/review/merge 分散 | F02 |
| 设置/成员重复 | 成立；Settings 团队表与 Team Dialog | F14 |
| 窄窗 960 可能有问题 | 代码验算成立；**需真机截图确认** | F03 |
| 旧 `settings` 面板残留 | 成立；无 switch case，旧布局可能空白 | F15 |
| 没有可见一级导航 | 成立；TABS 不渲染、隐藏面板靠 ▦/⌘K | F01/F12 |

---

## 7. 建议 Captain 优先裁决的 5 个 IA 问题

1. **一级导航形态**：常驻 rail / Dock tab / 命令面板优先？是否接受“功能藏在 ▦ 菜单”？（F01）
2. **960 窄窗策略**：Team 自动变 tab、还是允许主详情压缩、还是把 960 最小窗口提高？（F03）
3. **长内容归属**：Settings、MergeQueue 是否迁出 Modal，采用全页面板？任务详情是否引入 tab？（F05–F07）
4. **任务动作模型**：以 `taskNextStep` 唯一 primary + overflow，是否取代当前多 primary？（F08/F10）
5. **Attention 队列**：是否建立常驻“需要我处理”汇总（失败/评审/合并/告警/预算）并把 badge 放到一级导航？（F02/F12）

## 8. 建议的下一步（不在本审计实施）

- 先用 960×700、1100×760、1440×900 真机重拍当前布局（含 Team 右栏、Task 详情、Settings、MergeQueue）。
- 对 F03/F05/F06/F07 做可点击原型或低保真线框，再进入提案/投票；不要直接全量重构 Dock。
- 把 F01/F02 的一级导航 + attention 汇总作为一个整体设计问题，避免分别加 badge 造成新的重复入口。
- F15/F12 可作为小范围清理项，不阻塞大布局决策。

## 9. 验收自检

- [x] 覆盖 Shell、Dock 主/右组、10 个 PanelKey、Sidebar、Settings、MergeQueue、Question/Risk、Task detail、Memory/Poll 入口。
- [x] 给出逐屏 keep/move/panel/modal 表。
- [x] 给出 15 条 findings，每条含严重度、视图、证据、影响、建议、成本 S/M/L。
- [x] 检查重复入口、同类信息分散、主内容被工具栏挤压、面板关闭后不可发现。
- [x] 用代码行号 + 现有截图标注证据等级；旧截图明确不当作现状。
- [x] 只新增 `docs/team/ux-audit-layout.md`，未修改生产代码。

> 截图引用：`docs/team/t69-task-scheduler.png`（旧：任务/团队/星图密度基线）、`docs/team/t103-merge-queue.png`（旧：合并队列 Modal）、`docs/team/team-poll.png`（Poll 面板）。旧图仅用于形态参考，实际行号/结构以 `main@b908d1a` 代码为准。
