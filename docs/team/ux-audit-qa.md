# 边界状态、回归风险与可用性验收 · QA 审计（t185）

- **审计人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **基线**：main `b908d1a`（t168/t172 历史气泡、t175 取消/失败终态已合入；Dock shell、Review/Git/Poll/Watchdog）
- **参照**：`docs/team/ux-audit-agenda.md`（t179）§1 屏清单、§2 主流程、§3 审计维度、§4 分级、§5 关键问题
- **范围**：QA 视角的边界状态、异常恢复、回归风险与可用性验收；只审计，不修改 `src/`/`electron/`/`dist/`/`branches/`
- **方法**：main 代码静态审计 + 现有测试/文档/截图交叉核对 + 逐屏复现路径设计；本环境无 Electron 窗口，标注“需真机/截图复核”的项不冒充已通过
- **结论**：**1 个 P0、6 个 P1、5 个 P2**；主流程骨架完整，但窄窗 Team 强制分栏、Modal 叠层仲裁、长历史/异常恢复和“下一步”发现性是当前最需要先修的项

> 说明：t179 议程中的 t69/t103 截图早于 t168/t175/Dock 变更，不能作为当前视觉效果证据；本报告每条给出代码路径，截图复核项单列。

---

## 1. 审计摘要

### 1.1 已确认可工作（不阻塞）

- **0 任务**：Tasks 空状态有「规划任务」「+ 新建任务」两个明确入口（`App.tsx:3442-3448`），空态文案说明“用规划任务拆解或直接新建”（`App.tsx:3550-3562`）。
- **0 成员**：任务运行区显示“还没有可用成员。请先到「团队」创建成员或把成员设为非离线，再运行任务”（`App.tsx:3715`）；不是静默失败。
- **关闭所有面板**：Dock 提供「所有面板已关闭」水印 +「打开对话」+「恢复默认布局」（`DockShell.tsx:457-480`），不是死路。
- **大 diff**：Review 200 行窗口 + 加载更多 + per-file cap；`ReviewSection` 的 grid/rowcount/aria 已有；t154/t164 27 项 review 测试。
- **取消/失败终态**：t175 的 terminal 写入、userMessageId 绑定、幂等、刷新恢复、composer-only 重试已通过 t176 独立验证（52/576）。
- **评审门禁**：required/advisory/off 的 approve/start/process 全状态 gate；ReviewSection 在任务详情可见（`App.tsx:3813-3814`）。
- **空态/错误可读性**：全局 error banner `role=alert`（`App.tsx:2541-2544`），task action inline error（`App.tsx:3708-3710`），review error `role=alert`，Git 队列 error inline。

### 1.2 主要风险（按优先级）

| 级别 | 风险 | 影响 | 首修建议 |
|---|---|---|---|
| **P0** | 960/900/760 打开 `#/team` 时 Team 仍以 right split 打开；最小 420+360 > 内容宽 | 主流程/团队/评审在窄窗被挤到不可用，横向裁切 | 单栏变体强制 Team `within`；侧栏自动折叠；clamp minWidth；三档截图验收 |
| P1 | 设置 Modal 与高风险审批/队列 Modal 可同时存在；Escape 由多个 document handler 各自处理 | 关闭错层、设置未保存丢失、焦点/滚动恢复错乱 | 单一 Modal owner/栈；只顶层处理 Esc；统一焦点返还 |
| P1 | 长历史只取最近 100 条 chat messages（`service.ts:685`），无“加载更早” | 超过 100 条的旧对话不可达；用户误以为历史丢失 | 消息分页/“加载更早”；与 turn 的 before 游标统一 |
| P1 | 历史“机翻失败”后 `requested.current` 已 true，折叠再展开不会重试（`App.tsx:5313-5321`、`5545-5553`） | 翻译失败只能刷新恢复；原文虽在，但无法重试 | 失败态提供“重试翻译”；或复位 requested + 清 memo |
| P1 | 失败/加载类反馈过度依赖 5s toast（`Toast.tsx:18`）；`getChatTurns` 失败只 toast（`App.tsx:745-750`） | 用户离开/切面板后丢失，无法追溯 | 关键异步失败写入 inline/banner + 重试；toast 只做成功/低风险提示 |
| P1 | 任务详情的 ReviewSection 在长滚动底部（`App.tsx:3813`），Review/Merge/Conflict 的“下一步”不聚合 | 用户完成任务后找不到评审/合并/冲突处理 | 任务右栏 sticky “下一步”卡或 action row 增加“评审/合并”；冲突给“处理冲突” |
| P2 | 10 个面板、最多 4 组；tab 溢出/关闭所有后的发现性无端到端测试 | 多面板用户迷失；键盘/触控可达性未知 | tab overflow/面板启动器/恢复默认布局 e2e |
| P2 | 字体放大/200% zoom 下固定 34px tabs、58px topbar、大量 10px 标签 | 标签截断/触控目标变小 | 200% 截图；用 rem/容器查询；最小点击 24px |
| P2 | MergeQueue 自建 modal 不使用公共 Modal，关闭后不恢复触发按钮焦点 | 键盘用户焦点落到 body | 复用 Modal 或补 restoreFocus/滚动锁 |

---

## 2. 12 个可复现边界用例

> 标记：**PASS** = 代码/测试可证；**RISK** = 有实现但缺证据/存在降级；**FAIL** = 代码路径可推出明确不可用/错误行为。
> 环境：main `b908d1a`；窗口宽度按 CSS 像素；桌面 Electron/Chromium；无特殊 OS 字体设置。

### QA-01 新工作区 0 任务

- **前置**：打开空目录工作区（Router 自动创建），任务数 0。
- **步骤**：打开 Tasks 面板；看空态；点「规划任务」；返回再点「+ 新建任务」。
- **期望**：明确两条入口 + 空态说明；不出现空白列表/禁用主按钮。
- **实际/证据**：`App.tsx:3442-3448`（“还没有任务” + 规划/新建）；`App.tsx:3550-3562`（说明“用规划任务拆解或直接新建”）。**PASS**。
- **验收**：空态截图 + 两个入口都能打开对应 Modal；无 console error。
- **P2 文案**：规划与新建的差异只在说明里，建议一行“规划=Router 自动拆 DAG；新建=手工单任务”。

### QA-02 Router-only、0 可用成员

- **前置**：工作区仅 Router，其他成员离线/删除；任务 ready。
- **步骤**：打开任务 → 点「运行任务」；看提示；创建成员后重试。
- **期望**：明确“无可用成员”并指向团队创建；不静默入队失败。
- **实际/证据**：`App.tsx:3715` 提示“还没有可用成员…”；创建成员入口在 Team 面板。**PASS**。
- **验收**：点运行后提示可见、可读、可操作；创建成员后同一任务可运行。
- **P2**：提示只出现在任务详情 actions 上方，悬停/屏幕阅读器可读但容易被长详情淹没；建议与“运行任务”按钮相邻 sticky。

### QA-03 长历史（100+ 消息 / 20 turns / terminal）

- **前置**：workspace 有 150 条 chat messages、30 个 turn、若干 cancelled/error terminal；刷新应用。
- **步骤**：打开 Chat；滚到顶部；尝试查看第 1–50 条；展开历史第 1 个 turn 的 process；刷新后再看。
- **期望**：旧消息可加载（分页/“更早”），历史 process 与 terminal 不重复；滚动不卡死。
- **实际/证据**：`AppService.listChat` 固定 100（`service.ts:685`），UI `messages.map` 无“加载更早”；`getChatTurns` 默认 20（`chatTurnProjection.ts:13`）无 load older。超过 100 条的旧对话不可达；100 条 DOM 直出。**RISK（P1/P2）**。
- **验收**：150 条 fixture 下顶部有“加载更早”；首屏 <200ms（或虚拟化）；刷新后 turn/terminal 不重复。
- **建议**：消息分页与 `getChatTurns` 的 `before` 游标统一；历史 process 增加“加载更早”。

### QA-04 大 diff（20k 行 / 多文件 / 二进制）

- **前置**：任务分支有 20 个文件、单文件 20k 行 diff、1 个二进制文件。
- **步骤**：打开 ReviewSection；选文件；滚到 201 行；点“加载更多”；切文件；看 blocker/decision。
- **期望**：200 行窗口 + load more；文件列表可用；大文件不冻结；二进制/超大显示提示。
- **实际/证据**：`ReviewSection.tsx:319-379` role=grid/rowcount/rowindex + 200 行窗口 + load more；`diff.test` parser/truncate；t164 27 项 review tests。**PASS（性能需真机）**。
- **验收**：20k 行 fixture 滚动 60fps 或可接受；load more 不重复/不跳行；键盘 Enter 评论可定位。
- **P2**：无文件搜索/diff 内搜索；文件很多时只能滚动；建议后续。

### QA-05 10 面板 / 4 组 / tab 过多

- **前置**：默认布局；从面板启动器依次打开 context/runs/polls/watchdog/mailbox/board/settings legacy。
- **步骤**：把 6 个面板塞进一个 group；看 tab 溢出；拖到 4 组；再拖第 5 组。
- **期望**：tab 溢出可横向滚动/菜单；第 5 组被拒绝并提示；面板不重叠。
- **实际/证据**：`DockShell.tsx:84` MAX_GROUPS=4；`panelRegistry.ts` 10 PanelKey；tab 宽 130（`styles.css:4132`）；无 tab overflow/键盘 e2e。**RISK（P1）**。
- **验收**：6 tabs 在 710px 宽 group 内可全部到达；第 5 组有 toast；关闭/重开面板焦点合理。
- **建议**：加 tab overflow 菜单 + 面板启动器键盘测试；每个面板有 route 或 command。

### QA-06 关闭所有面板

- **前置**：已打开 chat/team/tasks/mailbox/board；逐一关闭。
- **步骤**：关闭最后一个面板；看水印；点「打开对话」；再关闭全部后点「恢复默认布局」。
- **期望**：不空白死路；两个恢复路径可用；焦点可见。
- **实际/证据**：`DockShell.tsx:457-480` 水印 + 两按钮；`resetLayout`、`openPanel` 均存在。**PASS**。
- **验收**：水印出现；按钮点击恢复；Tab 可聚焦；刷新后布局持久化不复活已关闭面板。

### QA-07 窄窗 960 / 900 / 760（重点）

- **前置**：默认布局，侧栏展开（约 250px），Dock 内容宽约 710/650/510。
- **步骤**：
  1. 960×900 打开 `#/team`；
  2. 900×800 打开任务详情 → Review；
  3. 760×800 在 Team 面板点任务 → 打开对话/评审；
  4. 记录横向滚动条/裁切/主按钮是否可见。
- **期望**：单栏可读；Team 作为 tab 而非强制右分栏；Chat 与 Team/任务可切换；无横向裁切。
- **实际/证据**：
  - `selectVariant`：<760 single，760–899 narrow，900–1099 medium（`panelRegistry.ts:182-186`）；但 `ensurePanel("team")` 在已有 chat 时**无条件** `direction:"right"`（`DockShell.tsx:131-135`）；
  - Team 最小 360、Chat 最小 420（`panelRegistry.ts` chat/team minWidth；`DockShell.tsx:125`）：960 窗口内容约 710，420+360=780 > 710；900 约 650、760 约 510 更严重；
  - 默认 250px sidebar 只有 180–480 min/max，无 shell 级 1100/900/760 自动折叠（`styles.css:200-208`）。
  - **FAIL（P0）**：`#/team` 在单栏/窄栏仍强制右分栏，主内容被挤/裁切。
- **验收**：960/900/760 三档分别打开 `#/team`、默认、任务 Review，横向滚动条不存在；主按钮（发送/批准/合并）可点；Team 可从 tab 到达。
- **建议**：`ensurePanel` 根据 `selectVariant(dockWidth)` 决定 team `within`；窄窗自动折叠 sidebar 或允许 0 min；clamp `minimumWidth`；加三档截图回归。

### QA-08 字体放大 / 200% zoom

- **前置**：960×800，Chrome/Electron zoom 200%，或 `--force-device-scale-factor` / OS 字体放大。
- **步骤**：打开 Chat、Tasks action row、Settings Modal、Review decision footer、MergeQueue。
- **期望**：文本不截断；按钮不重叠；tab/topbar 高度自适应；滚动可达。
- **实际/证据**：`.sidebar` 10–13px 固定字号（`styles.css` 多处 10px）、`.topbar height:58px`（`styles.css:566`）、Dock tab 高 34px（`styles.css:4131`）；无 zoom/200% 测试。**RISK（P1/P2）**。
- **验收**：200% zoom 截图；关键按钮/标签无裁切；tab 可滚动；最小点击目标 ≥24 CSS px。
- **建议**：优先用 rem/容器查询；`--dv-tabs-and-actions-container-height` 与 topbar 用 min-height；避免固定 10px 作为唯一正文。

### QA-09 纯键盘操作

- **前置**：不碰鼠标；侧栏、Dock、任务、Review、Settings、Modal。
- **步骤**：
  1. Tab 遍历侧栏 → ▦面板 → 选 chat/team；
  2. `Alt+1..6` 切主面板；`Cmd/Ctrl+K` 命令面板 → 打开任务评审；
  3. 任务 action row 用 Tab/Enter 运行；Review grid Arrow/Enter 评论；
  4. 打开 Settings，Tab 循环，Escape 关闭；打开 MergeQueue，Escape 再开；
  5. 检查焦点是否回到触发按钮。
- **期望**：所有主操作可达；Esc 只关顶层；关闭后焦点返回；aria-live 不重复轰炸。
- **实际/证据**：公共 `Modal` 有 focus trap/restore（`Modal.tsx:80-145`）；Review grid roving（`ReviewSection.tsx:328-346`）；`MergeQueueModal` 自建 trap、**无 restoreFocus**（`GitPanels.tsx:150-180`）；Dock tab 关闭/面板启动器无 e2e。**RISK（P1）**。
- **验收**：纯键盘完成 7 步主流程；焦点截图/activeElement 记录；Esc 只关一层。

### QA-10 Modal 叠层（设置 + 高风险审批 / 队列 + 问题）

- **前置**：打开 Settings（有未保存修改）；同时触发 auto_risk 高风险审批；或打开 MergeQueue 后收到 Router 问题。
- **步骤**：观察两个 backdrop/两个 dialog；按一次 Escape；再按一次；检查设置草稿与焦点。
- **期望**：只有顶层可交互；Esc 只关顶层；底层草稿保留；关闭后焦点回到打开者。
- **实际/证据**：`App.tsx:2913-2927` Settings Modal 与 `App.tsx:2962-3026` risk Modal 独立渲染；两者都用 `Modal`，各自在 `document` capture 监听 Esc（`Modal.tsx:105-116`）；`stopPropagation` 不能阻止同一 document 上其他 capture listener。**RISK（P1）**：一次 Esc 可能同时关闭两层，设置未保存内容丢失。
- **验收**：`aria-modal` 栈只有顶层；一次 Esc 只关一层；底层草稿/滚动位置保留；body overflow 恢复正确。
- **建议**：引入 Modal stack/owner；Settings 与 risk 二选一或嵌套 `inert`；MergeQueue 复用公共 Modal。

### QA-11 Toast 丢失 / 关键失败只 toast

- **前置**：断网或 mock 一个 `getChatTurns` reject；触发一次 Task action 失败；连续触发 4 个成功 toast。
- **步骤**：触发失败；立即切面板/等 6s；再触发 3 个成功操作；查看 error banner/console/重试入口。
- **期望**：关键失败持久可追溯（inline/banner）；toast 只做辅助；不被后续 toast 挤掉。
- **实际/证据**：`Toast.tsx:18` 默认 5000ms、`MAX_TOASTS=3` 且新 toast 挤掉最旧；`App.tsx:745-750` 历史加载失败只 `pushToast`，不写 `error`/不提供重试；成功 toast 可挤掉错误。**RISK（P1/P2）**。
- **验收**：失败后 10s 仍可在页面找到原因和重试；toast 不丢关键错误；aria-live 只播报一次。
- **建议**：新增 `AsyncErrorBanner`/inline retry；错误 toast `sticky` 或单独队列；限制成功 toast 挤掉 error。

### QA-12 异常路径恢复矩阵（取消/错误/等待评审/合并冲突/看门狗/翻译失败）

- **前置**：一条可取消的 chat 流；一个 provider error；一个 review required 任务；一个 merge conflict；一个 watchdog alert；一个翻译失败。
- **步骤/期望/实际**：

| 子场景 | 期望下一步 | 实际/证据 | 判定 |
|---|---|---|---|
| chat 取消/错误 | 终态泡 + 「重试」预填 composer，不自动发 | t175 `ChatTurnTerminalBubble` + `retryComposerState`；t176 8 项 UI 测试 | **PASS** |
| 等待评审 | 任务详情显示评审状态/blocker/decision，明确“批准/要求修改” | `ReviewSection` 在 `App.tsx:3813`；required gate | **PASS（可发现性 P1：在长详情底部）** |
| 合并冲突 | 冲突项显示 state + “处理冲突/打开任务” | `MergeQueueModal` 只显示 `item.state`/branch/checks，`合并` 按钮直接 `mergeStart`；无冲突专属动作（`GitPanels.tsx:194-220`） | **RISK（P1）** |
| 看门狗告警 | topbar 有 alert 计数；面板可 release/handoff | topbar/panel 存在；面板默认关闭、无 route；topbar 是入口（`App.tsx` watchdog 区域） | **PASS（P2 发现性）** |
| 翻译失败 | 原文可读 + 可重试 | `ChatReasoningBlock` 显示“机翻失败”但 `requested.current=true`，折叠再展开不再请求（`App.tsx:5313-5321`、`5518-5519`） | **FAIL（P1）** |
- **验收**：六个子场景各有一条可点击“下一步”；合并冲突不能在无提示下反复点“合并”；翻译失败可重试。

---

## 3. 主流程逐步验收路径与“用户下一步”

| 步骤 | 用户需看到 | 需操作 | 当前下一步 | 判定/缺口 |
|---|---|---|---|---|
| 1 打开工作区 | 最近工作区/打开文件夹/错误 | 选择目录 | Welcome 打开；失败 banner | PASS；最近工作区状态/时间弱（P2） |
| 2 Router 讨论/规划 | 空态示例、输入框、任务上下文 | 发消息/规划 | Chat 空态示例；Tasks 才有「规划任务」 | **P1**：规划入口不在 Chat，用户容易在对话里找不到“开始做” |
| 3 生成 DAG | 任务列表/星图/依赖 | 选择任务 | Plan 成功 toast +「查看」action | PASS；DAG 手工编辑仍缺（P2） |
| 4 运行 | 任务 action row、Run 状态 | 运行/重试 | 运行按钮；无成员提示 | PASS |
| 5 监控 | Runs/timeline/活跃 Run | 打开 Runs | Runs 默认关闭、无 routeTab；任务详情有 RunHistory | **P1**：监控入口默认不可见，用户需知道去任务/面板 |
| 6 评审/合并 | ReviewSection、blocker、decision、merge queue | 批准/要求修改/合并 | Review 在长详情底部；MergeQueue Modal | **P1**：下一步不聚合；冲突无处理动作 |
| 7 记忆沉淀 | 黑板/备忘录/归档 | 发布/归档 | Board 面板；无 post-task 提示 | P2：沉淀时机靠用户主动 |

**主流程总评**：7 步均有可执行动作，但第 2/5/6 步的“下一步”不在视野内；这是布局评审应优先修的可发现性问题。

---

## 4. 回归风险矩阵（影响 × 概率）

- **影响**：S1=阻断主流程/数据/安全；S2=显著降效/需绕路；S3=体验瑕疵。
- **概率**：P1=>25%；P2=5–25%；P3=<5%。

| ID | 风险 | 影响 | 概率 | 级别 | 触发/证据 |
|---|---|---|---|---|---|
| R1 | 窄窗 `#/team` 强制右分栏、min 420+360 溢出 | S1 | P2 | **P0** | 960/900/760 + `ensurePanel`；§QA-07 |
| R2 | Settings 与 risk/MergeQueue 叠层；Esc 双关 | S2 | P2 | P1 | `Modal.tsx` 两个 document capture；§QA-10 |
| R3 | 长历史超过 100 条不可达 | S2 | P2 | P1 | `service.ts:685`；§QA-03 |
| R4 | 翻译失败不可重试 | S2 | P2 | P1 | `App.tsx:5313/5518`；§QA-12 |
| R5 | 关键失败只 5s toast，被成功 toast 挤掉 | S2 | P2 | P1 | `Toast.tsx:18/31`；`App.tsx:745` |
| R6 | 10 面板/tab 溢出/关闭恢复无可达性测试 | S2 | P2 | P1 | `DockShell.tsx:84`；§QA-05 |
| R7 | Review/Merge/冲突下一步埋在长滚动底部 | S2 | P2 | P1 | `App.tsx:3813`；`GitPanels` |
| R8 | 200% zoom / 10px 固定字号裁切 | S2 | P2 | P1 | `styles.css` topbar/tab/10px |
| R9 | 键盘焦点在 MergeQueue 关闭后落到 body | S2 | P3 | P2 | `GitPanels.tsx:150-180` 无 restore |
| R10 | 0 成员/0 任务文案差异不清 | S3 | P3 | P2 | `App.tsx:3442/3715` |
| R11 | 大 diff 无搜索/文件过滤；20k 行性能未测 | S3 | P2 | P2 | `ReviewSection` 200 窗口 |
| R12 | 看门狗面板默认关闭、无 route；告警依赖 topbar | S2 | P3 | P2 | `panelRegistry` watchdog |
| R13 | t168/t175 新表面回归（terminal/history） | S2 | P3 | P2 | t176 52/576 已覆盖 |
| R14 | 设置占位（插件/MCP/Skills）让用户误以为可用 | S3 | P3 | P2 | Settings placeholder |

---

## 5. P0 / P1 / P2 建议（可执行验收）

### P0（本轮布局评审应先修）

**P0-1 窄窗 Dock/Team 布局**
- 改动：`ensurePanel` 在 `selectVariant(dockWidth) === "single"` 时 Team 用 `within` 而非 `right`；侧栏在 <1100 自动折叠/允许 0 min；`minimumWidth` 对 chat/team 做 clamp；为 `.app`/sidebar 加 960/900/760 容器规则。
- 验收：960/900/760 ×（默认、`#/team`、任务 Review）三组截图；无横向滚动条；发送/批准/合并按钮可见可点；Tab 可到达 Team/Review。
- 回归：1440/1100/900 Dock 分栏比例与持久化不变。

### P1（本场评审应排期）

1. **Modal 栈/焦点**：单一 owner，只顶层处理 Esc；Settings/risk/MergeQueue 复用同一 Modal 栈；关闭恢复打开者；补 Modal 叠层测试。
2. **长历史分页**：`listChat` 支持 `before`/limit；“加载更早”接到现有 `getChatTurns` cursor；补 150 条 fixture。
3. **翻译失败重试**：失败态按钮“重试翻译”，或折叠/展开时复位 `requested` + `clear(text)`；补失败→重试成功测试。
4. **关键失败持久化**：`getChatTurns`/队列刷新/Review 加载失败写 inline/banner + retry，不只 toast；错误 toast 不被成功 toast 挤掉。
5. **下一步聚合**：任务详情加 sticky「下一步」卡（运行→监控→评审→合并→记忆）；MergeQueue 冲突项提供“处理冲突/打开任务”；Runs 默认/route 发现性。
6. **面板/tab/键盘**：tab overflow 菜单、面板启动器键盘、关闭所有水印可达；补 10 面板/4 组 e2e。
7. **zoom/字体**：200% 截图；固定 34/58/10px 改 min-height/rem；关键按钮不裁切。

### P2（后续打磨）

- 0 任务/0 成员文案区分“规划 vs 新建”“无成员下一步”；最近工作区状态/时间。
- 长历史/大 diff 的搜索、文件过滤、虚拟列表；terminal 500 窗口。
- Toast aria（外层 polite + 内层 alert 双播报）、MergeQueue 焦点恢复。
- Watchdog/Polls/Context 增加 route 或明确“面板启动器”提示。
- Settings 插件/MCP/Skills 占位标注“未接入”，避免误操作。

---

## 6. 验收/回归计划（供会议决议后执行）

1. **视口矩阵**：1440×900、1100×800、960×800、900×800、760×800；每档默认 + `#/team` + 任务 Review + 合并队列 Modal。
2. **字体/缩放**：100%/150%/200%；检查 tab/topbar/按钮/Review grid。
3. **键盘脚本**：Tab 全链路、Alt+1–6、Cmd/Ctrl+K、Review Arrow/Enter、Modal Esc/Tab、Toast close。
4. **数据边界**：0 任务、0 成员、150 条 chat、20k 行 diff、500 terminal、10 面板/4 组。
5. **异常注入**：getChatTurns reject、provider error、cancel、merge conflict、watchdog alert、translation reject、toast 3 连发。
6. **门禁**：现有 52 文件/576 用例全绿；布局修改需补 e2e/截图；不改变 t175 终态与 t154 review gate 语义。

---

## 7. 范围守卫与假设

- 本报告只新增 `docs/team/ux-audit-qa.md`，未修改 `src/`、`electron/`、`dist/`、`branches/`。
- 静态审计基于 main `b908d1a`；无 Electron/Chromium 真机截图，QA-07/08/09/10 的视觉/焦点结论需在实现后用 Playwright/Electron 截图复核，不把静态推断当 visual pass。
- 若 Captain 已决定 Dock 在窄窗改为单栏 + 侧栏自动折叠，P0-1 的验收可直接复用本报告 §6.1；若决定保留 4 组，需要额外 tab overflow 方案。
- t175 的 tool/approval 语义、t154 的 review gate、t168 的 turn 512KiB 边界不在本轮改动范围；任何布局修复不得改变这些语义。

---

*QA 审计完成；P0-1（窄窗 Team 分栏）建议进入本轮布局评审的优先实现项。*
