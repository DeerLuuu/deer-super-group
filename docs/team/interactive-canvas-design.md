# DeerSuperGroup 交互式画布与提问表单设计（t63）

- **任务**：t63 `[work]` 设计：WorkBuddy 风格交互画布与提问表单
- **作者**：nova（Product Designer，DeepSeek 顶替 lin 席位）
- **日期**：2026-11-10（Asia/Shanghai）
- **性质**：设计文档；**不修改任何代码**
- **下游**：t64 实现（ray）→ t65 评审（ivy）→ t66 集成验收（kai）
- **输入**：
  - 任务契约（交互画布、模型生成协议、提问弹窗、UI/UX、安全、阶段/IPC/验收）
  - 用户提供的 **WorkBuddy 交互式表单生成** 参考；用户提供的 **DeerOpDaw 流程/路线图截图**（见 §0.5 的可读性说明）
  - 当前代码：`src/App.tsx`、`src/Markdown.tsx`、`src/Modal.tsx`、`src/Toast.tsx`、`src/TaskStarMap.tsx`、`src/shell/dock/DockShell.tsx`、`src/shell/dock/panelRegistry.ts`、`src/styles.css`、`src/kernel/{service,store,model,tools}.ts`、`src/shared/{types,ipc,deeplink,copy}.ts`、`electron/{main,preload}.ts`
  - 团队既有产出：`docs/team/starmap-final.md`、`dock-layout-design.md`、`layout-final.md`、`starmap-decisions.md`、`AGENTS.md`

> 本文是 t64 的唯一实现依据。文中所有小节号、`AC-xx` 验收编号、`DEC-xx` 决策编号、`E_*` 错误码、schema 与 IPC 名称都可被实现文档、评审与集成报告直接引用。
>
> **行号说明**：文中代码行号基于本任务开始（2026-11-10 03:19）时的 main 快照；共享工作区中并发的 UI 任务（如侧栏/设置改造）会移动行号。行号仅作定位辅助，**以文件/符号/行为为准**；t64 实现前请以当时 HEAD 重新核对集成点。

---

## 0. 结论摘要

### 0.1 一句话方案

给 Router 对话增加两种**受控的结构化消息块**——`deer-canvas`（画布 artifact）与 `deer-question`（原生提问表单）：

1. 模型只在回复里输出 fenced JSON，不输出 HTML/JS；
2. 共享协议层负责解析、白名单校验、归一化与失败回退；
3. 画布由客户端**确定性布局**渲染为可缩放/平移/适配的 SVG+DOM 画布，内联在对话气泡里（Dock 面板 P1）；
4. 提问由原生表单 Modal 收集答案，答案以一条普通用户消息（格式化文本）回到对话与模型上下文，问题状态持久化，支持队列、延后、取消、超时与防重复提交；
5. 渲染层没有 `dangerouslySetInnerHTML`、没有 `eval`、没有任意节点/边/颜色/坐标，所有文本用 React 转义，导出使用自绘 SVG / 白名单 Mermaid。

### 0.2 三个关键取舍

| # | 取舍 | 选择 | 理由 | 备选与否决原因 |
|---|------|------|------|----------------|
| 1 | 模型如何输出结构化内容 | **P0 用 fenced JSON**：```` ```deer-canvas ```` / ```` ```deer-question ````；P1 增加工具调用 `render_canvas` / `ask_user`，复用同一个 zod 校验器 | 当前对话管线 `service.sendChat()`（`src/kernel/service.ts:377–474`）**没有给对话暴露 tools**，工具循环只用于任务执行（`src/kernel/loop.ts`）；fenced JSON 可流式、可回退、历史可读、无后端阻塞 | 直接上工具调用要改对话循环与历史回放，P0 风险大；让模型输出 HTML/SVG 字符串会引入 XSS 与不可控布局，明确否决 |
| 2 | 画布放在哪里 | **P0 内联在对话消息中**；P1 增加 Dock「画布」面板承载放大/固定 | t64 契约写的是「在 ChatView/对话面板实现」；内联已满足任务的「嵌入对话消息**或**独立 dock 面板」；Dock 面板会引入面板注册表、布局恢复、活动 artifact 持久化，放到 P1 可显著降低 P0 回归面 | P0 直接加 Dock 面板会碰 `panelRegistry` 的布局存档兼容（`deer.dock.v1.*`）与命令面板，超出本轮必要范围 |
| 3 | 提问的回答如何回流 | **回答 = 新建一条用户消息**（`question:answer` 只落问题状态并生成格式化文本，随后调用现有 `sendChat`） | 对话管线是「一问一答」而非工具阻塞循环；把回答变成普通用户回合，模型上下文、历史、刷新恢复全部复用现有机制，无需改 `ChatMessage` 表结构 | 让聊天「暂停等待」需要在主进程维持半开流与恢复协议，P0 复杂且易产生悬挂会话；不采用 |

### 0.3 交付边界（P0 / P1 / P2）

| 能力 | P0（t64 必须） | P1 | P2 |
|------|----------------|----|----|
| 画布类型 | 思维导图 / 流程图 / 路线图 / 依赖图 四类 | 泳道自定义、时间轴日期刻度 | 自由画布、白板协作 |
| 节点/边/分组/状态色 | 白名单 node/edge/group + 7 状态色（复用 `--status-*`） | 边标签显示、分组配色自定义（固定色板内） | 图层注册表（对齐星图 S16） |
| 缩放/平移/fit | ✅（滚轮、拖拽、`+/-/0`、适应按钮、键盘方向键） | 双指缩放、触摸手势 | 惯性/平滑动画（reduced-motion 关闭） |
| 节点详情 | 单击非模态浮窗（字段+动作）；双击 1 跳聚焦；折叠/展开 | 节点关联真实任务/消息/黑板并可跳转 | 评论、批注、变更历史 |
| 分组折叠 | ✅ 分组与思维导图分支 | 折叠状态持久化 | 记忆式折叠策略 |
| 承载方式 | 对话内联卡片 | Dock「画布」独立面板 + 活动 artifact 切换 | 多窗口/分离窗口 |
| 模型协议 | fenced JSON + zod 校验 + 失败回退 + 历史压缩 | 工具调用通道 + 自动修复重试 + 渐进式流式渲染 | 用户自定义模板/协议扩展 |
| 导出 | **Mermaid（复制/下载）+ SVG（下载）** | PNG 导出 | PDF、嵌入邮件/黑板 |
| 提问类型 | 单选 / 多选 / 自由文本 / 确认 | 评分、排序、日期、文件（需新安全评估） | 分支表单、多步向导、模板库 |
| 提问生命周期 | 队列、延后、取消、可选超时、防重复、回答回流 | 回答草稿、已答修改并重发、取消时通知模型 | 条件字段、跨会话问题箱 |
| 安全 | 白名单 schema、纯文本、无 HTML/JS、服务端校验、大小/数量限制 | URL 白名单（https）、问题敏感词提示 | 签名 artifact、跨团队共享 |
| 主题/可达性 | 复用 token、键盘全链路、ARIA、reduced-motion、窄窗 | 列表视图替代画布、屏幕阅读器图形摘要增强 | 高对比主题、字体缩放专项 |
| 测试 | 单测（协议/布局/导出/答案/存储）+ SSR 安全测试 + 手工清单 | 组件交互测试（引入 jsdom 需评审） | 视觉回归截图 |

### 0.4 关键决策清单

| ID | 决策 | 结果 |
|----|------|------|
| DEC-01 | 协议版本 | `protocol` 字段 + `version: 1`；未知版本不渲染，回退卡片显示「协议版本过新」 |
| DEC-02 | 坐标与颜色来源 | 模型**不得**输出 x/y、width/height、颜色、CSS、class；坐标由客户端布局计算，颜色只由 `status`/`groupId` 语义决定 |
| DEC-03 | 画布边类型 | 白名单 `flow` / `depends` / `contains` / `relates` 四类；`dependsOn` 语义仅用于依赖图，不能伪装成任务真实依赖（P0 画布不写任务） |
| DEC-04 | 画布状态 | 7 态 `planned/active/blocked/review/done/failed/cancelled`，一一映射现有 `--status-*` token；颜色+形状双编码 |
| DEC-05 | 单击/双击 | 单击立即选中、250ms 后开详情；双击取消详情并切换 1 跳聚焦；键盘 `Enter`=详情、`Ctrl/⌘+Enter`=聚焦；**详情不会先于双击闪出**（吸收星图 S04 已知缺陷） |
| DEC-06 | 提问字段 | P0 四种：`single` / `multi` / `text` / `confirm`；一个 `deer-question` = 一张 1–6 字段的表单（即 WorkBuddy 式「模型生成表单」） |
| DEC-07 | 回答格式 | 回答先落 `chat_questions.answer`，再生成 `[回答表单] …` 的纯文本用户消息；模型上下文因此无需新协议 |
| DEC-08 | 状态持久化 | 画布以**助手消息 content 为事实源**，`chat_artifacts` 只是索引投影；问题状态在 `chat_questions`，二者以 `messageId#b<blockIndex>` 稳定键关联 |
| DEC-09 | 超时 | 可选 `timeoutSec`（5–3600，默认无超时）；过期由 `listChatQuestions` 惰性清算（不启后台定时器） |
| DEC-10 | 自动弹窗 | 仅当对话面板可见、窗口有焦点、无其他 Modal、输入框无未发送草稿且用户未延后时自动打开；否则 Toast（info）+ 内联卡片提示 |
| DEC-11 | 失败原子性 | 一个画布块要么整体合法渲染，要么整体回退为错误卡片 + 原始 JSON；**绝不**渲染半张图 |
| DEC-12 | 依赖 | 不新增运行时依赖；复用现有 `zod@4.6.7`、`react-markdown`、`Modal`、`Toast`；测试不引入 jsdom/testing-library（沿用 `renderToStaticMarkup` + 纯函数测试） |

### 0.5 输入假设与待复核（重要）

1. **DeerOpDaw 截图可读性**：本工作区中可枚举的图片只有 `docs/*.png` 六张应用预览（`chat-preview.png`、`team-preview.png` 等），**没有 DeerOpDaw 流程/路线图截图文件**；截图内容来自任务描述与用户上下文。本文按「阶段列/泳道 + 节点卡 + 状态色 + 方向箭头 + 图例」的流程/路线图视觉契约设计（§2.2）。若截图还包含本文未覆盖的视觉要素（例如时间轴刻度、里程碑旗帜、泳道着色规则），以用户截图与 Captain 复核为准，实现文档需记录差异。
2. **WorkBuddy 参考**：公开资料显示其表单生成是「自然语言/图片 → 表单配置 → 可迭代修改 → 提交/回收数据」的闭环（见 §2.1 引用）。本文只取其 **schema 驱动 + 对话内生成 + 可迭代重生成** 的产品语义，不引入外部表单平台、二维码、远程建表。
3. **“提问弹窗”不是工具审批**：`ask_user_question` 式交互仅用于澄清需求/收集选择；高风险工具审批仍走 t58 的 `risk:approval` 单次审批链路（`src/App.tsx:1362–1428`），两者不能合并、不能互相替代（§8.4）。
4. **本轮不改任务执行链路**：画布/提问只在 Router 对话（`sendChat`）中生效；任务执行的 worker 循环（`src/kernel/loop.ts`）不注入该协议，避免影响现有任务 DAG 与工具权限。

### 0.6 任务要求 → 本文覆盖索引

| 任务要求 | 本文小节 | P0 验收 |
|----------|----------|---------|
| 1) 画布 artifact：四类图、节点/边/分组/状态色、缩放平移 fit、节点详情、折叠展开、内联/ Dock、导出 | §4、§7.5、§12.1 | AC-02 ~ AC-07、AC-20 |
| 2) 模型生成协议：fenced JSON/工具调用、schema、校验、失败回退、历史持久化 | §5、§9 | AC-01、AC-07、AC-16、AC-27 |
| 3) 提问弹窗：四种字段、队列、超时/取消、回答回流、键盘/ARIA、防重复 | §6 | AC-09 ~ AC-12、AC-14 |
| 4) UI/UX：ChatView/对话框呈现、Dock/Markdown/Modal/Toast/token、单击不误触双击、窄窗 | §7 | AC-05、AC-13 ~ AC-19 |
| 5) 安全：白名单节点/边、不执行 HTML/JS、选项不可注入 | §8 | AC-08、AC-28 |
| 6) 阶段 P0/P1/P2、数据模型、IPC/API、验收与测试策略 | §9、§10、§12、§13 | 全部 |

> **t64 阅读路径（时间有限的实现者）**：§0 → §5.3/5.4（schema）→ §4.4/4.5（布局与交互）→ §6（提问）→ §9/§10（存储与 IPC）→ §11（落位与顺序）→ §13（AC/测试）。其余章节用于安全评审与取舍追溯。

---

## 1. 背景与现状

### 1.1 今天的对话里有什么

- 对话面板是 Dock 的「对话」面板（`src/App.tsx:1262–1293`；`src/shell/dock/panelRegistry.ts:39–49`，`minWidth: 420`）。`ChatView` 的消息区只做两件事：用户消息纯文本、助手消息 `<Markdown>`（`src/App.tsx:2749–2756`）。
- Markdown 组件固定 `skipHtml`（`src/Markdown.tsx:9`），这是一个很好的安全基线：**当前对话不会被注入 HTML**。
- 流式输出是纯文本累积：`chatStream` 字符串逐 delta 追加（`src/App.tsx:475–502`），结束后 `done` → `loadChat()` 重载。
- 对话历史在 `chat_messages` 表（`src/kernel/store.ts:121–130`），字段只有 `role/content/reasoning/created_at`；`sendChat` 把最近 30 条历史直接拼给模型（`src/kernel/service.ts:397–417`），**没有任何结构化附件、artifact 或提问实体**。
- 对话管线没有工具：`sendChat` 调 `client.stream()` 时只传 messages 与 maxOutputTokens（`src/kernel/service.ts:425–435`）；工具循环只在任务运行里（`src/kernel/loop.ts`）。
- 现有的 Modal 基线（`src/Modal.tsx`）已提供 Esc、焦点陷阱、回焦、`role="dialog"`、`aria-modal`、滚动锁；Toast（`src/Toast.tsx`）提供 `aria-live`、最多 3 条、hover 暂停；状态 token 在 `src/styles.css:1–29`。
- 任务星图（`src/TaskStarMap.tsx`）已经验证了一套可复用交互：确定性布局、LOD、非模态浮窗、键盘、局部聚焦、`aria-live`、reduced-motion；画布应复用这些经验，但**不复用任务数据模型**，也不把任务星图改成通用画布（避免回归已交付的 S01–S12）。

### 1.2 为什么现在需要画布与提问

| 场景 | 今天 | 需要的体验 |
|------|------|------------|
| 「把实现流程画出来」 | 只能输出列表/文字，用户脑内补图 | 流程/路线图/依赖图直接出现在对话里，可缩放、看节点详情 |
| 「这个任务依赖哪些前置」 | 一段文字描述，关系容易丢 | 依赖图 + 方向箭头 + 状态色，一眼可读 |
| 「先确认几个偏好再动手」 | 模型把问题写成一段话，用户逐条打字 | 原生单选/多选/文本/确认表单，一次提交结构化回答 |
| 「讨论过程中逐步长出一张路线图」 | 每次重发文字，版本散落 | 画布作为消息 artifact 持久化，迭代时模型重发新版本，历史可回看 |
| 窄窗/键盘用户 | 复杂内容只能读文本 | 画布可键盘浏览、有文本替代；表单全键盘可完成 |

### 1.3 现状缺口（带代码证据）

| 缺口 | 证据 | 影响 |
|------|------|------|
| 无结构化消息块 | `ChatBubble` 只渲染 Markdown（`src/App.tsx:2718–2762`） | 无法承载画布/表单；把 JSON 直接渲染成代码块，体验差 |
| 无 artifact 数据模型 | `chat_messages` 仅 role/content/reasoning（`src/kernel/store.ts:121–130`） | 刷新后只能靠正文重解析，缺少索引/状态；无法做 Dock/导出 |
| 无提问实体 | `src/shared/types.ts:165–183` 的 `ChatMessage`/`ChatEvent` 无问题结构 | 无法表达待回答/已回答/过期，无法防重复 |
| 无对话级工具 | `sendChat` 不带 tools（`src/kernel/service.ts:425–435`） | 模型只能靠文本/JSON 表达结构 |
| 无协议校验 | 没有共享 schema；`parsePlan` 是任务规划专用、宽松解析（`src/kernel/service.ts:110–143`） | 模型一旦输出坏 JSON 或未知节点，前端会崩/渲染垃圾 |
| 无历史压缩 | 历史直接拼接（`src/kernel/service.ts:397–417`） | 大画布 JSON 会挤占上下文，连续生成后 token 爆炸 |
| 无画布通用布局 | `TaskStarMap` 布局与任务强耦合（`src/TaskStarMap.tsx:112–213`） | 不能复用为任意流程图/路线图 |
| 无多模态提问 | 只有 `risk:approval` 审批（`src/App.tsx:1362–1428`） | 审批安全链路不能复用来做普通需求澄清 |

### 1.4 目标 / 非目标

**目标（P0）**

1. 助手回复里出现合法 `deer-canvas` 时，ChatView 能渲染四类图，含节点/边/分组/状态色，支持缩放、平移、fit、节点详情、折叠/展开。
2. 助手回复里出现合法 `deer-question` 时，能以原生表单 Modal 收集单选/多选/文本/确认答案；回答回流为新的用户消息并进入模型上下文。
3. 协议层可复用、可测试、可演进：解析、校验、归一化、失败回退、大小限制、版本兼容、历史压缩。
4. 刷新/切换对话/切换工作区后，画布与问答状态可恢复。
5. 安全：不执行任意 HTML/JS；节点/边/字段/选项全部白名单；服务端复核答案；无新依赖。
6. 与现有 Markdown / Modal / Toast / Dock / 主题 token / 状态语义一致；键盘、ARIA、reduced-motion、窄窗可用。

**非目标（P0）**

- 任意 HTML/JS/SVG/Canvas 绘图代码；模型自定义颜色、字体、坐标、CSS class。
- 自由拖拽节点、保存节点坐标、多人实时协作、评论批注、白板。
- 外部表单平台（金数据等）、二维码、远程发布。
- 用提问弹窗代替高风险工具审批；用画布内容触发任何工具/文件操作。
- 在任务执行 worker 中注入该协议；改任务 DAG 语义。
- 为画布引入 canvas 位图渲染或第三方图布局库（P0 用 DOM/SVG + 自研确定性布局）。

### 1.5 用户故事与验收句

| ID | 用户故事 | 验收句（可直接手工验证） |
|----|----------|--------------------------|
| US-1 | 作为用户，我让 Router 画流程，看到图而不是一堵 JSON | 发送含合法 `deer-canvas` 的回复后，对话中出现画布卡片；无 JSON 原文裸露（除非展开「原始数据」） |
| US-2 | 作为用户，我想放大看细节 | 滚轮缩放、拖空白平移、点「适应」回到全景；`+/-/0` 与方向键同样有效 |
| US-3 | 作为用户，我想知道某个节点是什么 | 单击节点出现详情浮窗；双击不再额外闪出第二个浮窗，而是进入 1 跳聚焦 |
| US-4 | 作为用户，我想先回答几个问题再让 AI 动手 | 模型发来表单；可单选/多选/填写/确认；提交后对话出现「[回答表单]…」用户消息，卡片显示已回答 |
| US-5 | 作为用户，我暂时不想回答 | 点「稍后」关闭弹窗，卡片保留；刷新后仍未回答；可再次打开 |
| US-6 | 作为用户/评审，我要确认坏数据不会破坏界面 | 手工把画布 JSON 改坏后重放消息，出现错误卡片 + 原始 JSON，可复制；页面无脚本、无样式污染 |
| US-7 | 作为键盘用户，我要完成整条链路 | 纯键盘：Tab 到节点 → Enter 看详情 → Esc 关闭回焦 → Tab 到「回答」→ 表单填写 → 提交 |
| US-8 | 作为窄窗用户，我要能读能操作 | 960px 窗口、Dock single 变体下，画布不横向溢出、工具栏折行/收进「更多」，表单不超出视口 |

---
## 2. 参考与视觉契约

### 2.1 WorkBuddy 的“交互式表单生成”：借鉴什么、不借鉴什么

公开资料里 WorkBuddy 的表单能力有两条典型路径：

1. **对话内生成表单并回传**：用户用自然语言描述调研目的，WorkBuddy 设计题目并选择题型（单选/多选/评分/简答等），调用金数据建表，返回链接/二维码；数据回收后可继续让 AI 汇总（[金数据：Workbuddy 问卷生成器](https://fusion.jinshuju.net/guides/workbuddy-survey-generator-jsj)）。
2. **AI 生成表单配置**：自然语言/图片 → 可编辑的表单配置；支持迭代修改与实时流式输出（[腾讯云社区：我用 WorkBuddy 做了一个 AI 生成表单配置的功能](https://cloud.tencent.cn/developer/article/2696261)，其目录明确列出“文字生成表单 / 迭代修改 / 图片生成表单 / 实时流式输出”）。

**借鉴**

| 借鉴点 | 在 DeerSuperGroup 的落法 |
|--------|--------------------------|
| 模型先生成一份**表单配置（schema）**，再由客户端渲染 | `deer-question` JSON → zod 校验 → 原生 React 表单（§6.2） |
| 题型可选、字段标签/说明/必填/选项由模型给 | `single/multi/text/confirm` 四型 + label/description/required/options/min/max/placeholder/maxLength |
| 支持**对话内迭代**：用户说“再加一个问题/换成多选”，模型重发新表单 | 画布/表单是消息 artifact；再次生成即新版本，旧版本保留在历史里；提交旧版本会被状态机拦截（§6.6） |
| 流式生成过程可见 | P0 流式阶段显示“正在生成画布/表单…”占位；P1 完整块渐进渲染（§7.1） |
| 表单不止收集，还要能继续推进任务 | 回答直接回到对话，Router 继续推进；P1 可把回答写入任务描述/黑板（需单独权限设计） |

**不借鉴 / 明确否决**

| 不做 | 原因 |
|------|------|
| 调外部表单平台建表、返回链接/二维码 | 本产品本地优先；数据不出工作区；P0 无网络副作用 |
| 模型输出任意 HTML/React 组件/样式 | 安全与主题一致性；违反 `skipHtml` 基线 |
| 自由布局的“表单设计器” | 本任务的表单是**对话中的一次性提问**，不是可视化表单搭建器；编辑能力放 P2 |
| 图片生成表单 | 需视觉模型与图片上传链路，独立任务；P2 评估 |
| 让模型自定义提交按钮行为/颜色/图标 | 按钮行为固定，仅 label/选项文本可配置；避免诱导点击与注入面 |

### 2.2 DeerOpDaw 流程/路线图截图的视觉对齐

> 说明：如 §0.5，本工作区没有可直接读取的截图文件。以下将任务描述中的“流程图/路线图”拆成可实现的视觉契约；截图若提供额外细节（日期刻度、里程碑旗标、阶段编号、泳道底色规则），以截图为准并在实现文档记录差异。本节只定义**视觉语言**，不假设截图的业务字段。

采用的目标观感（与现有深色工作台一致）：

| 视觉要素 | 设计 |
|----------|------|
| 画布底 | 深色 `--bg-2` + 低密度点阵（24px world 间距），无强网格、无视差（reduced-motion 安全） |
| 阶段/泳道 | 路线图用横向泳道（分组行）+ 左侧泳道标题；流程图用纵向阶段层；依赖图左→右分层 |
| 节点 | 圆角小卡/胶囊 + 语义形状（决策菱形、里程碑菱形旗、注记虚线框），不是大段富文本卡 |
| 方向 | 依赖/流程使用细线 + 小箭头；`relates` 虚线无箭头；`contains` 细线无箭头（思维导图） |
| 状态 | 7 态颜色复用任务状态 token；每条节点有小状态标记（形状+文字工具提示），颜色不是唯一通道 |
| 里程碑 | 菱形 + 加粗标签；路线图里与阶段泳道对齐 |
| 图例 | 画布左下/底部可折叠：状态色 + 节点形状 + 边类型 + 泳道含义；与星图 S01/S08/S10 图例语义一致 |
| 信息密度 | 默认 LOD：低缩放只显示节点和少量标签；高缩放显示标题+meta；同屏标签 ≤24，选中/聚焦强制全标签 |
| 交互暗示 | 画布顶部工具条（缩放读数、适应、导出、更多）；底部一行手势提示，与星图底部提示同风格 |

**不做**：截图里常见的自由拖拽节点、任意连线、画布缩放动画、渐变发光、图片节点、富文本节点。

### 2.3 与星图（TaskStarMap）的关系

| 维度 | 任务星图（已交付 S01–S12） | 交互画布（本设计） |
|------|---------------------------|--------------------|
| 数据来源 | 工作区任务 `dependsOn` / `ownerId`（真实数据） | 模型输出的 `deer-canvas`（对话产物，非工作区事实） |
| 布局 | 确定性力导向混合（`TaskStarMap.tsx:112–213`） | 四类图的确定性分层/径向/泳道布局（§4.4） |
| 是否可伪造关系 | 否：`dependsOn` 唯一事实源，缺失只计数 | 画布内关系是模型表达，**不写入任务**；不能声称代表真实任务依赖（除非 P1 显式绑定 `refs.taskId` 并标注来源） |
| 复用 | LOD 阈值、非模态浮窗、键盘、局部聚焦、reduced-motion 模式 | 复用交互范式与 CSS 习惯，**不复用组件/数据模型**，避免回归 |
| 单击/双击 | 单击浮窗、双击进任务会话，存在“双击前先闪一次浮窗”的已知缺陷（`starmap-final.md` IF 区） | 用 250ms 延迟+`event.detail` 消除闪出（§7.8） |

---

## 3. 总体架构

### 3.1 分层

```
┌──────────────────────────────────────────────────────────────────────┐
│ 模型（Router chat completion）                                        │
│  纯文本 + ```deer-canvas JSON + ```deer-question JSON                │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ text deltas / final message
┌───────────────────────────────▼──────────────────────────────────────┐
│ 主进程 AppService.sendChat（现有，最小改动）                           │
│  1. 保存 assistant 消息（content 保留原始 fenced 块 = 事实源）         │
│  2. ingestInteractive(message)：共享协议层解析/校验                    │
│       ├─ 合法 canvas   → chat_artifacts 索引投影（幂等）              │
│       ├─ 合法 question → chat_questions（pending，可带 expiresAt）    │
│       └─ 非法块        → 审计事件 chat.interactive_invalid            │
│  3. emitChat({type:"done", message})                                  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ IPC（preload: window.deer.*）
┌───────────────────────────────▼──────────────────────────────────────┐
│ Renderer（ChatView / App）                                            │
│  历史消息 → ChatContent（按 block 切分）                               │
│    ├─ text      → <Markdown>（skipHtml，保持现状）                     │
│    ├─ canvas    → <CanvasCard>（解析/校验结果来自共享层）              │
│    └─ question  → <QuestionCard>（状态来自 chat_questions）            │
│  画布：deterministic layout → SVG edges + DOM buttons（可缩放/平移）   │
│  提问：QuestionModal（复用 Modal）→ answerChatQuestion → sendChat     │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.2 一条消息的生命周期（P0）

```
用户提问
  → sendChat(workspace, text)
      → 保存 user message
      → 组装 system prompt（含交互协议 v1 + 最近画布摘要）
      → 流式 text
      → 保存 assistant message（content 原样）
      → ingestInteractive()：解析/校验/落库问题/画布索引
      → emitChat done(message)
  → App.loadChat()（拉 messages + getContext + listChatQuestions）
  → ChatBubble 解析 content：
       text 段 → Markdown
       canvas 合法 → CanvasCard（本地解析结果，无需再查库）
       canvas 非法 → CanvasFallbackCard
       question 合法 → QuestionCard（用 listChatQuestions 的状态）
       question 非法 → QuestionFallbackCard
  → 若存在待回答且满足自动打开条件 → QuestionModal
  → 用户提交：
       answerChatQuestion({questionId, values})
         → 校验（服务端）→ pending→answered（一次性）
         → 返回 answerText
       → sendChat(workspace, answerText)  ← 普通用户回合
       → 模型继续
```

### 3.3 单一事实源与投影

| 实体 | 事实源 | 投影/缓存 | 说明 |
|------|--------|-----------|------|
| 画布内容 | **assistant message `content` 中的 fenced JSON** | 渲染层解析结果（`useMemo`）；`chat_artifacts.payload`（索引，供 P1 Dock/导出/统计） | 消息不可编辑，故内容即版本；投影损坏不影响渲染（P0 渲染不依赖表） |
| 问题定义 | assistant message `content` 中的 fenced JSON | `chat_questions.payload`（服务端校验后的规范 JSON） | 服务端必须存一份用于答案校验，不信任 renderer |
| 问题状态/答案 | `chat_questions.status/answer` | Renderer 的 `questions` state + 内联卡片 | 状态机唯一写入点在主进程（§9.4） |
| 回答消息 | `chat_messages`（普通 user 消息） | 对话历史 | 内容格式 `[回答表单] …`；无隐藏元数据也可被模型读懂 |
| 画布视图状态（缩放/折叠） | P0 组件内存 / P1 localStorage | — | 不影响业务事实，丢失可接受 |

### 3.4 关键约束（实现不得违反）

1. **无执行**：渲染层不出现 `dangerouslySetInnerHTML`、`innerHTML`、`eval`、`new Function`、动态 `import()`、`<iframe>`、`<object>`、`<embed>`、远程图片。
2. **无任意样式**：模型不能提供颜色/px/坐标/CSS；所有视觉由组件 + token 决定。
3. **原子渲染**：单块解析/校验失败 → 整块回退；不允许“先画一半再报错”。
4. **一次回答**：`chat_questions` 的 `pending → answered` 必须条件更新（`WHERE status='pending'`），重复提交返回既有答案，不新增用户消息。
5. **主进程校验**：`answerChatQuestion` 必须在主进程重新校验 `values` 与 `payload`；renderer 只做体验级校验。
6. **工作区隔离**：问题/画布查询按 `workspace_id + agent_id`；跨工作区 id 不可读/不可答。
7. **大小上限**：任何模型输出进入渲染/DB 前先做长度/数量/字节检查（§8.6）。
8. **历史压缩**：进入模型上下文的历史必须压缩画布块（§5.10），防止上下文被 JSON 挤爆。
9. **现有能力不回归**：Markdown、任务星图、Dock 布局、Modal 焦点、Toast、状态 token 的行为不得改变；新增只在“助手消息内容解析”这一层接入。

---

## 4. 画布 artifact

### 4.1 四种画布

| kind | 用途 | 节点语义 | 默认边语义 | 布局 | 典型动作 |
|------|------|----------|------------|------|----------|
| `mindmap` | 主题拆解、方案空间 | `root` 1 个；`topic` 分支；`note` 补充 | `contains`（父子）；`relates` 横向关联 | 径向树（根中心，逐层外扩） | 折叠分支、1 跳聚焦、看节点备注 |
| `flowchart` | 流程、阶段、决策路径 | `step` 步骤；`decision` 决策；`risk` 风险点 | `flow` 顺序；`relates` 旁路 | 纵向分层（TB，可选 LR） | 决策节点详情、风险标记、折叠分组 |
| `roadmap` | 版本/阶段路线图 | `step` 工作项；`milestone` 里程碑；`note` | `flow` 推进；`relates` 依赖旁注 | 横向泳道（分组=阶段/工作流）+ 行内顺序 | 泳道折叠、里程碑详情、导出 Mermaid |
| `dependency` | 依赖图、前置关系 | `task`/`step`；`milestone` 交付点 | `depends` 依赖（箭头）；`relates` 参考 | 左→右分层（LR） | 上下游详情、环依赖提示、聚焦链路 |

**通用规则**

- 一个画布 1–80 个节点、0–240 条边、0–12 个分组；一个助手消息最多 3 个画布 + 3 个提问、全部交互块 ≤6。
- 节点 id 必填且消息内唯一（`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`）；边可省略 id（服务端生成/归一化为 `e<n>`）。
- 边端点必须存在；不允许自环；重复边（from/to/kind 相同）归一化去重并给 warning。
- 分组引用必须存在；未被引用分组允许存在（显示空泳道，UI 提示）。
- `relates` 不参与分层/径向树构建，只画虚线，避免把旁路关系误当依赖。
- 环：`flowchart` 允许（回边画虚线 + 循环标记），`dependency` 允许但 warning（显示“存在环依赖”），`mindmap` 树化时忽略回边并 warning。
- 模型不能指定节点 x/y、尺寸、颜色、CSS；只能给 `kind/status/groupId/order/meta/refs` 等语义字段。

### 4.2 数据模型与白名单

（完整 schema 与 zod 定义见 §5.3；这里给实现者心智模型。）

```ts
type CanvasKind = "mindmap" | "flowchart" | "roadmap" | "dependency";
type CanvasStatus = "planned" | "active" | "blocked" | "review" | "done" | "failed" | "cancelled";
type NodeKind = "root" | "topic" | "step" | "task" | "milestone" | "note" | "decision" | "risk";
type EdgeKind = "flow" | "depends" | "contains" | "relates";

interface DeerCanvas {
  protocol: "deer-canvas";
  version: 1;
  kind: CanvasKind;
  title: string;          // 1–160
  summary?: string;       // ≤400
  direction?: "TB" | "LR";
  nodes: DeerCanvasNode[]; // 1–80
  edges: DeerCanvasEdge[]; // 0–240
  groups: DeerCanvasGroup[]; // 0–12
}
```

| 字段 | 白名单/限制 | 说明 |
|------|-------------|------|
| `node.id` | 正则 + 唯一 | 用于边引用与详情定位；不进入 DOM id，不拼 HTML |
| `node.label` | 1–120 纯文本 | 渲染为 React text；控制字符/双向控制符会被清洗（§8.3） |
| `node.kind` | 8 枚举，默认 `step` | 决定形状与 Mermaid 形状 |
| `node.status` | 7 枚举，默认 `planned` | 决定颜色 + 状态标记；不是任务状态，不写任务 |
| `node.note` | ≤600 纯文本 | 详情浮窗展示；换行保留但最多 8 行视觉 |
| `node.meta` | ≤80 纯文本 | 副标题（负责人/日期/版本等），只做文本 |
| `node.groupId` | 必须引用存在分组 | 分组=泳道/阶段；决定泳道归属 |
| `node.order` | 0–99 可选 | 路线图/同层排序提示；不参与其他图坐标 |
| `node.refs` | 仅 `taskId/messageId/board` 各 ≤64 的 id 字符串 | P0 只读展示、不可点击；P1 才允许跳转（且需校验对象存在） |
| `edge.from/to` | 必须存在节点 | 不存在 → 校验失败（不补假节点） |
| `edge.kind` | 4 枚举，默认 `flow` | 箭头/线型由它决定 |
| `edge.label` | ≤40 纯文本 | 悬浮/高亮时可显示；默认不常显 |
| `group.id` | 正则 + 唯一 | 泳道/阶段 id |
| `group.label` | 1–60 纯文本 | 泳道标题 |
| `group.order` | 0–99 可选 | 泳道排序；缺省按数组顺序 |
| `group.tone` | `accent/purple/green/yellow/red/neutral` 枚举可选 | 只从固定色板取色，不接受任意色值；缺省按索引轮换 |
| `group.status` | 7 枚举可选 | 泳道状态点（用于路线图阶段状态） |

**状态 → token → 标记（双编码）**

| status | token | 语义 | 状态标记（形状通道） |
|--------|-------|------|----------------------|
| `planned` | `--status-ready`（紫） | 计划中/待启动 | 空心圆 `○` |
| `active` | `--status-running`（蓝） | 进行中 | 半填充圆 `◐` |
| `blocked` | `--status-blocked`（黄） | 阻塞/等待 | 暂停竖条 `▮` |
| `review` | `--status-review`（亮蓝） | 待评审 | 菱形 `◇` |
| `done` | `--status-done`（绿） | 完成 | 对勾 `✓` |
| `failed` | `--status-failed`（红） | 失败 | 叉 `✕` |
| `cancelled` | `--status-cancelled`（灰） | 取消 | 斜杠圈 `⊘` |

> 颜色不是唯一通道：每个节点右上角有状态标记 + 详情里有中文文本；图例同时展示颜色+标记+文案。与星图 S01/S11 的可达性结论一致。

### 4.3 视觉规范（token / 形状 / 线 / 图例）

**新增 token（只做别名，不新增调色板）** — 加到 `src/styles.css` `:root`：

```css
--canvas-bg: var(--bg-2);
--canvas-grid: color-mix(in srgb, var(--border) 45%, transparent);
--canvas-node-bg: var(--panel);
--canvas-node-bg-strong: var(--panel-2);
--canvas-node-border: var(--border-2);
--canvas-edge: var(--border-2);
--canvas-edge-strong: var(--accent);
--canvas-lane: color-mix(in srgb, var(--panel-2) 55%, transparent);
--canvas-focus: var(--accent);
```

**节点形状（按 kind，SVG 绘制在 button 内，文字覆盖）**

| kind | 形状 | 默认尺寸（world px） | 备注 |
|------|------|----------------------|------|
| `root` | 圆角胶囊 + 双描边 | 200×64 | 思维导图中心 |
| `topic` | 圆角矩形 | 176×52 | 分支主题 |
| `step` | 圆角矩形 | 176×52 | 流程步骤/路线图工作项 |
| `task` | 矩形（小圆角） | 176×52 | 依赖图任务，与任务卡视觉区分（不带卡片信息） |
| `milestone` | 菱形 | 140×72 | 路线图里程碑 |
| `decision` | 六边形/菱形 | 176×80 | 流程决策；详情里显示“是/否”出口提示（若有） |
| `note` | 虚线圆角矩形 | 176×64 | 补充说明 |
| `risk` | 三角/警示框 | 168×64 | 风险点；`failed` 状态时更强警示 |

**边**

| 边类型 | 线型 | 箭头 | 用途 |
|--------|------|------|------|
| `flow` | 实线 1.25px | 有（末端小箭头） | 流程推进、路线图顺序 |
| `depends` | 实线 1.25px | 有 | 依赖方向（上游→下游） |
| `contains` | 细实线 1px，颜色更淡 | 无 | 思维导图父子 |
| `relates` | 虚线 1px（4/4） | 无 | 参考/旁路关系 |

- 高亮/选中时边 2px、`--canvas-edge-strong`；非邻域 dim 到 0.25。
- 边交叉不做自动避让（P0）；流程/依赖用分层降低交叉；路线图尽可能同泳道内连。
- 箭头 marker 7px，颜色 `currentColor`，避免模型控制。

**标签 LOD（与星图阈值一致：`LOD_TITLE=0.55`, `LOD_FULL=0.9`）**

| 缩放 | 显示 |
|------|------|
| `< 0.55` | 只显示节点形状 + 状态标记；选中/聚焦/详情节点强制显示标题 |
| `0.55 – 0.9` | 标题截断（≤12 字 + …），meta 隐藏 |
| `≥ 0.9` | 完整标题 + meta（若存在）+ 状态标记 |
| 任意 | 同屏标签 ≤24；选中/悬停/聚焦优先；去掉重复标签 |

**画布 Chrome**

- 顶部工具条：标题/kind 徽章/节点数·边数 · 缩放读数 · `+` `−` `适应` · `导出` · `更多`；高度 34px，sticky 在卡片顶部。
- 底部提示：手势/快捷键一行；窄窗自动缩短为「拖动平移 · 滚轮缩放 · 单击详情」。
- 图例：左下浮层，可折叠；窄窗默认折叠；内容=状态色+标记+文案、边类型、泳道说明。
- 背景：点阵（24px world），不显示大网格；无视差。
- 焦点环：`:focus-visible` 2px `--accent`，offset 2px；节点按钮必须保留可见焦点环。
- reduced-motion：关闭缩放过渡/脉冲/淡入，直接切换（CSS 媒体查询）。

### 4.4 布局算法（确定性、纯函数）

实现文件：`src/canvas/layout.ts`。输入 `(artifact, uiState)`，输出：

```ts
type PositionedNode = {
  node: DeerCanvasNode;
  x: number; y: number; w: number; h: number;
  dimmed?: boolean;
  hidden?: boolean;
};
type PositionedEdge = {
  edge: DeerCanvasEdge;
  from: PositionedNode; to: PositionedNode;
  kind: EdgeKind;
  back?: boolean;
  path: string; // SVG path d
};
type CanvasLayout = {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  lanes: Array<{ group: DeerCanvasGroup; x; y; w; h; collapsed }>;
  bounds: { minX; minY; maxX; maxY };
  warnings: LayoutWarning[];
};
```

**公共步骤**

1. 计算可见集合：折叠的 group 隐藏其内节点；折叠的 mindmap 分支隐藏后代；被折叠隐藏的边不渲染，统计 `hiddenNodeCount/hiddenEdgeCount`。
2. 排序输入必须稳定：节点按数组顺序；边按数组顺序；分组按 `order ?? index`，同 order 按 id 字典序。**不使用 `Math.random`、`Date.now`、`localeCompare` 的非确定实现**（localeCompare 结果随环境，改用 id 的 `<` 比较）。
3. 节点尺寸按 kind 查表；碰撞/间距由层距与列距保证，不做力模拟（P0 规模小，确定性优先）。
4. 输出坐标保留 2 位小数；同输入两次调用逐坐标相等（单测 AC-02）。

**A. 流程图（flowchart，TB/LR）**

```
1) 构图：只用 flow/depends/contains 边做 layering；忽略 relates。
2) 3 色 DFS 计算 level：
   level(node) = max(level(pred) + 1)（忽略回边；回边记 back=true）
   多根（无入边）level=0；孤立节点 level=0。
3) TB：y = 80 + level*150；x = 60 + inLevelIndex*220（按节点数组顺序）。
   LR：x = 80 + level*230；y = 60 + inLevelIndex*110。
4) 决策节点同层高 80；行内垂直居中。
5) 边：TB 从底边中心到顶边中心的三次贝塞尔；LR 从右边中心到左边中心。
   回边：从底部绕行（dashed + 小环标记），避免穿越节点。
6) 分组：绘制为节点包围盒/淡色底（不改变分层坐标），用于折叠与语义分区；路线图才把分组画成泳道。
7) bounds 加 80 padding。
```

**B. 依赖图（dependency，LR）**

与 A 的 LR 版本共用分层；差异：

- 边默认 `depends`；箭头始终显示；边可显示 label（hover）。
- 节点默认 `task`；同层按 `order`/数组顺序。
- 环依赖：保留回边、图层正常，画布顶部显示 warning chip「存在环依赖 N 处」。
- P1 若节点 `refs.taskId` 命中工作区真实任务：节点右上角显示「任务」小徽章并允许跳转；P0 不跳转。

**C. 思维导图（mindmap）**

```
1) 根：kind=root 的第一个节点；没有则第一个节点（warning）。
2) 用 contains/flow/depends 边构建树（BFS）；回边/多父取第一次访问，warning。
3) 深度 d 的半径 R(d) = d===0 ? 0 : 170 + (d-1)*150。
   每层按父节点分组，在父节点角度扇区内均分；根的子节点从 -90° 开始均分 360°。
4) 叶子少于 6 个时，扇区扩展为整圈以避免挤在一起；同父超过 8 个子节点时半径 +40（warning 标签密度）。
5) 深度 >4 的节点截断为折叠，节点上加「+N」徽章。
6) 边用直线/轻曲线；contains 无箭头。
```

**D. 路线图（roadmap）**

```
1) 泳道：groups 按 order,id 排序；无 group 的节点进入「未分组」泳道（末尾）。
2) 每条泳道 y = 60 + laneIndex*160；lane 高度 140。
3) 节点 x = 200 + indexInLane*220；y = laneY + 44；组内顺序 = node.order ?? 数组顺序。
4) 泳道标题固定在世界左缘 x=8，宽 168；节点区从 x=200 开始，避免压标题。
5) 边：同泳道用短弧；跨泳道用 S 形贝塞尔；里程碑同泳道加粗。
6) 若 group 声明 status：泳道标题右侧显示状态点；不改变节点状态。
7) 折叠泳道：只渲染标题行 + 「N 项」摘要按钮；隐藏其内节点/边。
```

**fit 与 bounds**

- `fitView(viewport, bounds, containerSize, {padding:48, minScale:0.3, maxScale:1.4})`：`scale = clamp(min(w/bw, h/bh), ...)`，再居中。
- 首次挂载自动 fit；**消息更新/窗口尺寸变化不自动 fit**（避免用户视角被重置）；容器显著变化且用户从未交互时可重新 fit 一次；提供「适应」按钮与 `0` 快捷键。
- 缩放范围 `0.3–2.2`；滚轮以指针为锚点；`+/-` 以容器中心/选中节点为锚点。

### 4.5 交互规范

**视口**

| 操作 | 行为 |
|------|------|
| 拖拽空白 | 平移；移动 >4px 才进入拖拽，避免误触 |
| 滚轮 | 以鼠标位置为锚点缩放（`scale *= exp(-deltaY*0.0015)`） |
| `+` / `−` | 1.2 / 0.83；以选中节点或容器中心为锚点 |
| `0` / 适应按钮 | fit 全部可见节点 + 折叠摘要 |
| 方向键 | 平移 40px；Shift 120px；不抢 Tab 焦点 |
| 双击空白 | 清除聚焦（不缩放） |
| 点击空白 | 第一次：关闭详情浮窗并清除选中；第二次：清除聚焦（保留视口） |

**节点单击 / 双击（DEC-05 状态机）**

```
onPointerDown(node): 记录 {x,y,t}
onClick(node, event):
  if (拖动位移 > 4px) return;                  // 拖拽误触
  if (event.detail === 1):                    // 第一次点击
      select(node);                            // 立即反馈
      pending = setTimeout(() => openDetail(node), 250);
  else if (event.detail === 2):               // 第二次点击（双击）
      clearTimeout(pending);
      toggleFocus(node);                       // 1 跳聚焦
onKeyDown(node):
  Enter          → openDetail(node)
  Ctrl/⌘+Enter   → toggleFocus(node)
  Escape         → 关详情/退聚焦（逐级）
```

- 详情浮窗**不会在双击时先闪出**：第一次点击只选中，250ms 后才开详情；第二次点击在计时器触发前取消。
- 单击节点不会触发卡片的展开/收起或导出等外层动作（`stopPropagation`）。
- 节点内若有折叠 chevron（思维导图分支/分组摘要），它是独立 `<button>`，`stopPropagation`，单击或 Enter 只折叠。

**节点详情浮窗（非模态）**

- 内容：标题（h 级语义）+ kind 中文 + status 中文 + meta + note（≤3 行可展开）+ 分组名 + 入/出度 + 「聚焦 1 跳 / 清除聚焦 / 复制节点 ID / 复制标题」。
- 定位：节点屏幕坐标 + 12px 偏移；clamp 在卡片可视区内；随 pan/zoom 重新计算（或关闭后重开；P0 跟随）。
- 焦点：打开时焦点移到第一个动作；`Esc` 关闭并回焦节点；Tab 可离开（非模态，不圈禁，符合 ARIA）。
- 角色：`role="dialog" aria-modal="false" aria-labelledby`；不可用 `aria-modal="true"`。
- 关闭：空白点击、Esc、再次单击同一节点、切换聚焦。
- P0 不展示真实任务跳转；`refs` 只读展示文本（P1 才可点击）。

**1 跳聚焦**

- 节点及其直接上游/下游（所有边类型）保持 1.0，其余节点 0.25、边 0.15；不重排、不隐藏依赖（与星图 S05/S06 结论一致）。
- 顶部显示面包屑「全部 › 聚焦：<节点标题> · 退出(Esc)」；再次双击/Ctrl+Enter 退出；空白点击两次退出（第一次关详情，第二次清聚焦）。
- `aria-live` 播报「已聚焦：<标题>，N 个邻居」。
- 折叠节点仍可聚焦；被 dim 的节点仍可 Tab 到达（聚焦即恢复全亮，不重排）。

**折叠/展开**

- 分组折叠：路线图/流程图的分组标题变 `<button aria-expanded>`；折叠后显示「N 项」摘要 + 状态点；其内边隐藏并在底部报「已折叠 N 节点 / M 边」。
- 思维导图分支折叠：有子节点的节点显示 chevron；折叠后节点保留，子节点隐藏，节点徽章 `+N`。
- 折叠状态 P0 为组件内 state（刷新重置）；P1 存 `localStorage`（§9.5）。折叠不会重写画布 JSON。

**键盘与读屏**

- 容器：`tabIndex=0`、`role="application"`、`aria-label="交互画布：<title>，<kind>，N 个节点，M 条边"`；`aria-describedby` 指向一段 `sr-only` 用法说明。
- 节点：`<button type="button">`，`aria-label="<标题>，<kind 中文>，<status 中文>，<分组>，<N 上游>，<M 下游>"`；`aria-describedby` 指向 note 摘要（有则）。
- 边：SVG `aria-hidden="true"`；关系信息通过节点 aria-label 的上下游计数表达。
- `aria-live="polite"` 播报：聚焦、折叠、适应、选中。
- 焦点顺序：按布局稳定顺序（层/泳道/数组）而非 DOM 随机。
- reduced-motion 下无过渡/脉冲；`fit` 直接跳转。
- P1 提供「列表视图」：同数据的表格（标题/状态/分组/上下游），作为画布的等价替代（更强可达性）。

### 4.6 对话内画布卡片的 Anatomy

```
┌───────────────────────────────────────────────────────────────┐
│ ▣ 交互画布 · 流程图        [路线图]  12 节点 · 14 边   [适应][⋯] │  ← header 34px
├───────────────────────────────────────────────────────────────┤
│                                                               │
│   ● 打开工作区 ──▶ ● Router 规划 ──▶ ◆ 分配成员             │  ← 画布视口
│        (点阵背景, 折叠分组摘要, 状态标记)                       │     clamp 高度
│                                                               │
├───────────────────────────────────────────────────────────────┤
│ 图例 ▾   已折叠 3 节点 · 2 边        [在画布面板打开(P1)]      │  ← footer 30px
└───────────────────────────────────────────────────────────────┘
```

- 卡片宽度 = 气泡可用宽度；不设固定 px 宽；`max-width: 100%`；`overflow: hidden`。
- 视口高度：`clamp(240px, 34vh, 420px)`；「放大」切换为 `min(560px, 60vh)`；窄窗（容器 <520）下限 220px。
- 顶部 header 动作：适应、放大/还原、导出菜单（Mermaid 复制/下载、SVG 下载）、原始数据（`<details>` 展示 escaped `<pre>`）。
- 画布内不重复显示长标题：标题在 header；画布内不画大标题（避免与节点重复）。
- 摘要 `summary` 显示在画布上方一行 muted 文本（可选，最多 2 行）。
- 错误态见 §4.9；空态不合法（节点至少 1 个），因此没有“空画布”状态；若可见集合为空（全折叠）显示「全部已折叠 · 展开全部」。
- 加载态（P0 流式占位「正在生成画布…」；P1 完整块渐进渲染）：不渲染半截。
- 卡片不使用 Modal/backdrop；不阻塞对话滚动。

### 4.7 Dock 集成

**P0（必须）**

- 画布内联在「对话」Dock 面板中；面板宽度可随拖拽变化：卡片用 `ResizeObserver` 读取自身宽度，切换 `data-width="compact|regular|wide"`（不依赖窗口宽度，因为 Dock 分栏宽度 ≠ 窗口宽度）。
- 不改变 dockview 的布局存档；不新增面板 key；不注册新的 `DockHandle` 方法。
- 画布内容不得撑破面板：卡片 `min-width:0; max-width:100%; overflow:hidden`；SVG/DOM 用 world transform，不产生页面级横向滚动。
- 关闭/切换对话面板再回来：画布从消息内容重新解析渲染（P0 无额外状态）。
- Dock 的 `minWidth` 约束：`chat` 面板 420（`panelRegistry.ts:44`）；画布 compact 断点 520/360 只影响样式，不改变面板最小宽度。

**P1（面板规格，供后续实现）**

| 项 | 规格 |
|----|------|
| PanelKey | `"canvas"` |
| title | 「画布」 |
| routeTab | `null`（不新增顶层导航/不改 6 tab） |
| defaultClosed | `true` |
| minWidth / minHeight | 360 / 320 |
| 单例 | 一个 key 一个面板（与 context 相同） |
| 打开方式 | 画布卡片动作「在画布面板打开」；命令面板新增「面板：画布」 |
| 数据 | App 从已加载的 chat messages 解析出 `artifactKey → DeerCanvas`；面板通过 `canvasFocus {key, nonce}` 定位；若 key 不在当前 100 条消息内，用 `getChatArtifact` IPC 取 `chat_artifacts.payload`，失败显示「原始画布不在当前会话中」 |
| 恢复 | dock 持久化恢复该面板时显示 loading/空态；不得写入/破坏现有 `deer.dock.v1.*` 存档 |
| 与其他面板 | 与「上下文」面板同组/相邻；不影响 chat/team 默认布局与 58/42 比例 |

> P0 不做面板的原因：涉及 `panelRegistry`、`DockShell` 布局存档、App 级活动 artifact、命令面板与 hash 多处改动，收益是“更大画布”，用内联「放大」已能覆盖 P0 需求；把风险留给 P1。

### 4.8 导出（Mermaid / SVG / PNG）

**入口**：画布 header「导出」菜单（原生 button + 弹出菜单，非 Modal）：

- 复制 Mermaid
- 下载 Mermaid（`.mmd`）
- 下载 SVG（`.svg`）
- 下载 PNG（P1）
- （P1）发送到黑板/邮件（需要权限与引用设计）

**Mermaid 映射**

| 画布 | Mermaid | 说明 |
|------|---------|------|
| `flowchart` | `flowchart TD/LR` | `step/topic/task` → `n0["label"]`；`decision` → `n1{"label"}`；`milestone` → `n2(["label"])`；`risk` → `n3[["label"]]`；`note` → `n4[/"label"/]` |
| `dependency` | `flowchart LR` | 边 `depends` → `n0 --> n1`；`relates` → `n0 -.-> n1`；`flow`/`contains` → `-->` / `---` |
| `roadmap` | `flowchart LR` + `subgraph` | 每个 group 一个 subgraph；节点顺序按 lane order；里程碑用 `(["..."])` |
| `mindmap` | `mindmap` | 仅当图是树（单根、无多父、无环）时生成；否则降级为 `flowchart` 并提示 warning |

安全规则（必须）：

1. 节点/分组 id 不使用模型给的 id 直接拼 Mermaid，统一映射为 `n0…n79` / `g0…g11`；边引用用映射后的 id。
2. 标签清洗：去掉控制字符与双向控制符；换行→空格；`"`→`'`；去除 `<`、`>`、反引号、`]]>`；长度截断到 120。
3. 不输出 `classDef`/`style`/`click`/`linkStyle` 等可执行/外链指令；P0 不导出颜色（Mermaid 默认主题）。
4. 生成后再次用白名单行检查：只允许 `flowchart`/`mindmap`/`subgraph`/`end`/`n<数字>`/`g<数字>`/箭头/括号/引号/文本；出现其他指令 → 返回错误，不下载。
5. 复制使用 `navigator.clipboard.writeText`；失败 toast，并提供 `window.prompt` 兜底？——**不用 prompt**（阻塞/不可测）；失败时展开只读 textarea 供手动复制。

**SVG 导出**

- 由纯函数 `renderCanvasSvg(artifact, layout, themeSnapshot)` 生成字符串：自绘 `<svg>` + `<rect>/<path>/<polygon>/<text>`；不使用 `foreignObject`（避免字体/样式不可控），不引用外部字体/图片/远程 URL。
- 文本用 `escapeXml`（`& < > " '`）；所有 fill/stroke 来自 `themeSnapshot`（从容器 `getComputedStyle` 读取 token 的 hex fallback；读取失败用 `styles.css` 的常量兜底表）。
- SVG 不嵌入字体（体积/许可），依赖查看器系统字体；中文/英文均正常，最多因字体回退略有差异。
- 尺寸 = bounds + 48 padding；背景 `--bg-2`；最大 4096×4096；超过则按比例缩小或拒绝并 toast。
- 下载文件名：`deer-canvas-<slug(title)>-<yyyymmdd-hhmm>.svg`；`slug` 只保留字母/数字/汉字/`-`/`_`，截断 48，去除路径分隔符与控制字符。
- 生成失败 toast（error）+「查看详情」控制台错误码；不静默。

**PNG（P1）**

- 将 SVG 字符串 → `Blob` → `Image` → `<canvas>` → `toBlob('image/png')`；无外部资源，不污染 canvas；最大 4096；5s 超时；失败回退「下载 SVG」。
- 不引入 html2canvas 等依赖（体积/安全/字体问题）。

**导出与状态**

- 导出不改变画布状态；不写数据库；不写 localStorage；导出成功 toast（success，带文件名，不含路径）。
- 导出的是**当前可见集合**（折叠分组/分支的内容不导出，与所见一致）；聚焦 dim、缩放、选中、详情浮窗不影响导出。
- 导出不含对话/节点详情浮窗；导出不改变画布状态。

### 4.9 持久化与历史

| 场景 | 行为 |
|------|------|
| 刷新页面 | Chat messages 重载 → `ChatContent` 重新解析 → 画布重建；问题是 `listChatQuestions` 返回状态 |
| 切换对话上下文（任务上下文） | `loadChat` 重新拉取该 Router 的消息与问题；画布随消息 |
| 切换工作区 | 清空 chat/questions 状态，按新工作区重新加载；键/表按 workspace 隔离 |
| 切换 Dock 布局/面板 | 消息仍在内存；画布组件可能卸载重挂载 → 视口重置（P0 接受），内容不丢 |
| 消息被截断（最近 100 条） | 更早画布不显示；`chat_artifacts` 索引保留，P1 Dock 可通过 `getChatArtifact` 读取 |
| 消息重放/编辑 | 不支持编辑；若未来支持，按 `(messageId, blockIndex)` 更新投影并重置问题状态（P2） |
| 数据损坏（DB 中 payload 非法） | 渲染以消息 content 为准；`getChatArtifact` 返回 null/错误，不崩溃 |
| 导出/视图状态 | 导出不持久化；缩放/折叠 P0 不持久化，P1 按 artifactKey 存 localStorage（上限 100 条，LRU） |

**失败回退（画布）**

| 失败 | 卡片行为 |
|------|----------|
| JSON 语法错误 | 显示「画布数据无效 · E_JSON」+ 原始文本（`<pre>` escaped，最多 64KB）+ 复制按钮；其余文本 Markdown 正常渲染 |
| schema/白名单失败 | 「画布包含不受支持的内容 · E_SCHEMA」+ 第一条错误路径；原始 JSON 可展开 |
| 超限 | 「画布过大 · E_TOO_LARGE（节点 93 > 80）」；不渲染图 |
| 版本过新 | 「画布版本过新 · E_VERSION」；提示升级应用 |
| 未闭合 fence 且流已结束 | 「画布数据未完成 · E_UNCLOSED」+ 原始文本 |
| 流式未完成 | 不显示错误；显示「正在生成画布…」占位（§7.1） |
| 渲染层异常（布局/React） | Error boundary 级联回退到该卡片的 fallback；console 记录 `canvas.render_error`；不影响其他消息 |

> 回退卡片仍然可复制原始 JSON；P1 提供「让模型修复」按钮（发一条用户消息附带错误码，模型重发）。

---
## 5. 模型生成协议

### 5.1 通道选择与演进

| 阶段 | 通道 | 原因 |
|------|------|------|
| P0 | **fenced JSON**：```` ```deer-canvas ```` / ```` ```deer-question ```` | 当前 `sendChat` 无 tools（`src/kernel/service.ts:425–435`）；fenced 文本天然流式、可回退、可历史压缩、无需改对话循环与 IPC 事件 |
| P1 | 工具调用 `render_canvas` / `ask_user` | 结构化参数、模型更可靠地遵循 schema；复用同一 zod 校验器与持久化，只是入参来源不同 |
| P2 | 模板/协议扩展 | 用户自定义画布模板、更多控件类型；需要版本化与权限设计 |

**不采用的方案**

- 让模型输出 HTML/SVG 字符串：XSS、主题不一致、不可校验、布局不可控。
- 让模型输出 base64 图片：体积、不可交互、不可导出结构化内容。
- 让模型输出 React/JSX 或组件名：等于执行任意代码，直接违反安全基线。
- 让模型输出 x/y/颜色/class：布局与主题不可控，且会诱导用户把模型当渲染器。

### 5.2 Fence 语法

````text
```deer-canvas
{ ...单个 JSON 对象... }
```

```deer-question
{ ...单个 JSON 对象... }
```
````

规则：

1. 语言标识**精确匹配** `deer-canvas` / `deer-question`（大小写不敏感，两侧空白允许）；`deer-canvas foo` 之类带额外信息的 fence 不识别，按普通 Markdown 代码块处理。
2. fence 起始最多 3 个前导空格；` ``` ` 或 `~~~` 均可；结束 fence 字符与长度必须 ≥ 起始，且该行只有 fence 与空白。
3. 一个 fence 内**只能有一个 JSON 对象**；不允许注释、尾逗号、Markdown、多个对象拼接。
4. 同一助手消息的交互块：总数 ≤6，画布 ≤3，问题 ≤3；超出的块回退为 `E_LIMIT` 卡片（不丢弃后续文本）。
5. 未闭合：流式期间不渲染；消息结束后仍未闭合 → `E_UNCLOSED` 回退卡片。
6. 非 `deer-*` 的代码块完全保持现有 Markdown 行为（`src/Markdown.tsx` 不变）。
7. **仅助手消息解析**；用户消息/系统消息一律纯文本，防止用户伪造画布/问题（安全 §8.4）。
8. **快速路径**：若 `content` 不包含 `deer-canvas` / `deer-question` 子串，解析器直接返回单个文本段，不进入 fence 扫描/JSON/zod；这是 100 条历史消息的零成本路径。

示例（正常）：

````text
下面是实现流程：

```deer-canvas
{"protocol":"deer-canvas","version":1,"kind":"flowchart","title":"实现流程","nodes":[{"id":"a","label":"写协议","kind":"step","status":"done"}],"edges":[]}
```

有 3 个点需要你确认：

```deer-question
{"protocol":"deer-question","version":1,"title":"确认范围","fields":[{"id":"scope","kind":"multi","label":"P0 必须包含","required":true,"options":[{"id":"flow","label":"流程图"},{"id":"ask","label":"提问"}]}]}
```
````

### 5.3 Canvas Schema v1（可直接落地的 zod）

实现文件：`src/shared/interactive.ts`。复用现有依赖 `zod`（`package.json` 声明 `^4.1.12`，当前安装 4.6.7，支持 `z.strictObject`），不新增包。

```ts
import { z } from "zod";

export const CANVAS_PROTOCOL = "deer-canvas" as const;
export const CANVAS_VERSION = 1 as const;
export const QUESTION_PROTOCOL = "deer-question" as const;
export const QUESTION_VERSION = 1 as const;

export const CANVAS_KINDS = ["mindmap", "flowchart", "roadmap", "dependency"] as const;
export const CANVAS_STATUSES = [
  "planned", "active", "blocked", "review", "done", "failed", "cancelled",
] as const;
export const NODE_KINDS = [
  "root", "topic", "step", "task", "milestone", "note", "decision", "risk",
] as const;
export const EDGE_KINDS = ["flow", "depends", "contains", "relates"] as const;
export const GROUP_TONES = ["accent", "purple", "green", "yellow", "red", "neutral"] as const;

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const Id = z.string().regex(ID_PATTERN, "id 只能包含字母/数字/_/-，1–64 字符");

export const CANVAS_LIMITS = {
  nodes: 80,
  edges: 240,
  groups: 12,
  title: 160,
  summary: 400,
  label: 120,
  note: 600,
  meta: 80,
  edgeLabel: 40,
  groupLabel: 60,
  jsonBytes: 64 * 1024,
  blocksPerMessage: 6,
  questionsPerMessage: 3,
  canvasesPerMessage: 3,
} as const;

export const CanvasNodeSchema = z.strictObject({
  id: Id,
  label: z.string().trim().min(1).max(CANVAS_LIMITS.label),
  kind: z.enum(NODE_KINDS).default("step"),
  status: z.enum(CANVAS_STATUSES).default("planned"),
  note: z.string().trim().max(CANVAS_LIMITS.note).optional(),
  meta: z.string().trim().max(CANVAS_LIMITS.meta).optional(),
  groupId: Id.optional(),
  order: z.number().int().min(0).max(99).optional(),
  refs: z
    .strictObject({
      taskId: z.string().trim().min(1).max(64).optional(),
      messageId: z.string().trim().min(1).max(64).optional(),
      board: z.string().trim().min(1).max(64).optional(),
    })
    .optional(),
});

export const CanvasEdgeSchema = z.strictObject({
  id: Id.optional(),
  from: Id,
  to: Id,
  kind: z.enum(EDGE_KINDS).default("flow"),
  label: z.string().trim().max(CANVAS_LIMITS.edgeLabel).optional(),
});

export const CanvasGroupSchema = z.strictObject({
  id: Id,
  label: z.string().trim().min(1).max(CANVAS_LIMITS.groupLabel),
  order: z.number().int().min(0).max(99).optional(),
  tone: z.enum(GROUP_TONES).optional(),
  status: z.enum(CANVAS_STATUSES).optional(),
});

export const CanvasSchema = z
  .strictObject({
    protocol: z.literal(CANVAS_PROTOCOL),
    version: z.literal(CANVAS_VERSION),
    kind: z.enum(CANVAS_KINDS),
    title: z.string().trim().min(1).max(CANVAS_LIMITS.title),
    summary: z.string().trim().max(CANVAS_LIMITS.summary).optional(),
    direction: z.enum(["TB", "LR"]).optional(),
    nodes: z.array(CanvasNodeSchema).min(1).max(CANVAS_LIMITS.nodes),
    edges: z.array(CanvasEdgeSchema).max(CANVAS_LIMITS.edges).default([]),
    groups: z.array(CanvasGroupSchema).max(CANVAS_LIMITS.groups).default([]),
  })
  .superRefine((value, ctx) => {
    // 仅供示意：zod issue 的 message 前缀作为 detail（E_DUP_NODE/E_GROUP_REF/E_EDGE_FROM…）；
    // 对外 code 统一映射为 E_SCHEMA（见 §5.6），不让模型/用户看到 zod 原始结构。
    const nodeIds = new Set<string>();
    value.nodes.forEach((node, index) => {
      if (nodeIds.has(node.id)) {
        ctx.addIssue({ code: "custom", message: `E_DUP_NODE: ${node.id}`, path: ["nodes", index, "id"] });
      }
      nodeIds.add(node.id);
    });

    const groupIds = new Set<string>();
    value.groups.forEach((group, index) => {
      if (groupIds.has(group.id)) {
        ctx.addIssue({ code: "custom", message: `E_DUP_GROUP: ${group.id}`, path: ["groups", index, "id"] });
      }
      groupIds.add(group.id);
    });

    value.nodes.forEach((node, index) => {
      if (node.groupId && !groupIds.has(node.groupId)) {
        ctx.addIssue({
          code: "custom",
          message: `E_GROUP_REF: 节点 ${node.id} 引用了不存在的分组 ${node.groupId}`,
          path: ["nodes", index, "groupId"],
        });
      }
    });

    const edgeIds = new Set<string>();
    value.edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.from)) {
        ctx.addIssue({ code: "custom", message: `E_EDGE_FROM: ${edge.from}`, path: ["edges", index, "from"] });
      }
      if (!nodeIds.has(edge.to)) {
        ctx.addIssue({ code: "custom", message: `E_EDGE_TO: ${edge.to}`, path: ["edges", index, "to"] });
      }
      if (edge.from === edge.to) {
        ctx.addIssue({ code: "custom", message: `E_SELF_EDGE: ${edge.from}`, path: ["edges", index] });
      }
      if (edge.id) {
        if (edgeIds.has(edge.id)) {
          ctx.addIssue({ code: "custom", message: `E_DUP_EDGE_ID: ${edge.id}`, path: ["edges", index, "id"] });
        }
        edgeIds.add(edge.id);
      }
    });
  });

export type DeerCanvas = z.infer<typeof CanvasSchema>;
export type DeerCanvasNode = z.infer<typeof CanvasNodeSchema>;
export type DeerCanvasEdge = z.infer<typeof CanvasEdgeSchema>;
export type DeerCanvasGroup = z.infer<typeof CanvasGroupSchema>;
```

要点：

- `z.strictObject` 拒绝未知字段（拒绝前向透传，避免模型塞 `html`/`style`/`url`）。
- `z.enum` + `default` 让缺省字段安全落地；`nodes` 的 `label` 经 `.trim()`，空字符串直接 schema 失败。
- **不包含** x/y/width/height/color/style/class/html/link 字段；模型试图添加会触发 `E_SCHEMA` 并回退。
- `edges`/`groups` 缺省 `[]`；`nodes` 至少 1。
- `refs` 只是 id 文本；P0 不渲染成链接。

### 5.4 Question Schema v1

```ts
export const QUESTION_LIMITS = {
  fields: 6,
  options: 12,
  title: 120,
  description: 400,
  label: 80,
  optionDescription: 160,
  textMaxLength: 4000,
  answerBytes: 16 * 1024,
} as const;

const QuestionOptionSchema = z.strictObject({
  id: Id,
  label: z.string().trim().min(1).max(QUESTION_LIMITS.label),
  description: z.string().trim().max(QUESTION_LIMITS.optionDescription).optional(),
});

const fieldBase = {
  id: Id,
  label: z.string().trim().min(1).max(QUESTION_LIMITS.label),
  description: z.string().trim().max(QUESTION_LIMITS.optionDescription).optional(),
  required: z.boolean().default(true),
};

const SingleFieldSchema = z.strictObject({
  ...fieldBase,
  kind: z.literal("single"),
  options: z.array(QuestionOptionSchema).min(2).max(QUESTION_LIMITS.options),
});

const MultiFieldSchema = z.strictObject({
  ...fieldBase,
  kind: z.literal("multi"),
  options: z.array(QuestionOptionSchema).min(2).max(QUESTION_LIMITS.options),
  min: z.number().int().min(0).max(QUESTION_LIMITS.options).optional(),
  max: z.number().int().min(0).max(QUESTION_LIMITS.options).optional(),
});

const TextFieldSchema = z.strictObject({
  ...fieldBase,
  kind: z.literal("text"),
  placeholder: z.string().trim().max(120).optional(),
  maxLength: z.number().int().min(1).max(QUESTION_LIMITS.textMaxLength).default(500),
  multiline: z.boolean().default(true),
});

const ConfirmFieldSchema = z.strictObject({
  ...fieldBase,
  kind: z.literal("confirm"),
  danger: z.boolean().default(false),
});

export const QuestionFieldSchema = z.discriminatedUnion("kind", [
  SingleFieldSchema,
  MultiFieldSchema,
  TextFieldSchema,
  ConfirmFieldSchema,
]);

export const QuestionSchema = z
  .strictObject({
    protocol: z.literal(QUESTION_PROTOCOL),
    version: z.literal(QUESTION_VERSION),
    /** 仅用于展示/引用；真实问题 id 由 messageId + blockIndex 派生（§9.1） */
    id: z.string().trim().max(64).optional(),
    title: z.string().trim().min(1).max(QUESTION_LIMITS.title),
    description: z.string().trim().max(QUESTION_LIMITS.description).optional(),
    fields: z.array(QuestionFieldSchema).min(1).max(QUESTION_LIMITS.fields),
    /** 5–3600 秒；缺省表示不过期 */
    timeoutSec: z.number().int().min(5).max(3600).optional(),
  })
  .superRefine((value, ctx) => {
    const fieldIds = new Set<string>();
    value.fields.forEach((field, index) => {
      if (fieldIds.has(field.id)) {
        ctx.addIssue({ code: "custom", message: `E_DUP_FIELD: ${field.id}`, path: ["fields", index, "id"] });
      }
      fieldIds.add(field.id);

      if (field.kind === "single" || field.kind === "multi") {
        const optionIds = new Set<string>();
        field.options.forEach((option, optionIndex) => {
          if (optionIds.has(option.id)) {
            ctx.addIssue({
              code: "custom",
              message: `E_DUP_OPTION: ${option.id}`,
              path: ["fields", index, "options", optionIndex, "id"],
            });
          }
          optionIds.add(option.id);
        });
      }
      if (field.kind === "multi") {
        const min = field.min ?? 0;
        const max = field.max ?? field.options.length;
        if (min > max || max > field.options.length) {
          ctx.addIssue({ code: "custom", message: "E_MULTI_RANGE", path: ["fields", index] });
        }
      }
    });
  });

export type DeerQuestion = z.infer<typeof QuestionSchema>;
export type QuestionField = z.infer<typeof QuestionFieldSchema>;
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;
export type QuestionValue = string | string[] | boolean;
export type QuestionValues = Record<string, QuestionValue>;
export type QuestionAnswers = { values: QuestionValues; answeredAt: string };

export type QuestionFieldErrorCode =
  | "required"
  | "unknown_field"
  | "invalid_type"
  | "invalid_option"
  | "too_few"
  | "too_many"
  | "too_long"
  | "invalid_value";

export interface QuestionFieldError {
  fieldId: string;
  code: QuestionFieldErrorCode;
  /** 面向用户的中文；不含模型原文中的 HTML */
  message: string;
}

/**
 * 客户端与服务端共用：按 question 定义校验 values。
 * - 只遍历 question.fields，忽略/拒绝额外 key
 * - 返回归一化后的 values（trim、选项顺序按 options 定义）
 */
export function validateQuestionAnswers(
  question: DeerQuestion,
  input: unknown,
): { ok: true; values: QuestionValues } | { ok: false; errors: QuestionFieldError[] };
```

设计说明：

- **一个 `deer-question` 就是一张表单**（1–6 字段），因此“提问弹窗”与“交互式表单生成”共用一套 schema；不需要再引入 `deer-form`。
- 单选至少 2 个选项；多选可选 `min/max`（缺省 0 / 选项数）；文本有 `maxLength`；确认有 `danger` 仅控制危险样式，不产生任何执行副作用。
- `submitLabel`/按钮文案不由模型决定：UI 固定「提交回答 / 稍后回答 / 取消提问」，避免诱导性按钮（例如把“提交”写成“立即删除”）。
- `timeoutSec` 可选；P0 UI 会展示倒计时但默认无超时。
- 字段/选项 id 仅用于数据映射；**不拼 DOM id、不拼 HTML/URL**。

### 5.5 四种画布示例（均通过上面的 schema）

**A. 流程图**

```json
{
  "protocol": "deer-canvas",
  "version": 1,
  "kind": "flowchart",
  "title": "交互画布实现流程",
  "summary": "从协议到上线的 5 个阶段",
  "direction": "TB",
  "groups": [
    { "id": "p0", "label": "P0 对话内", "order": 0, "tone": "accent" },
    { "id": "p1", "label": "P1 面板与导出", "order": 1, "tone": "purple" }
  ],
  "nodes": [
    { "id": "schema", "label": "协议与校验", "kind": "step", "status": "done", "groupId": "p0" },
    { "id": "parse", "label": "消息解析", "kind": "step", "status": "active", "groupId": "p0" },
    { "id": "render", "label": "画布渲染", "kind": "decision", "status": "active", "groupId": "p0", "note": "合法→渲染；非法→回退卡片" },
    { "id": "ask", "label": "提问表单", "kind": "step", "status": "planned", "groupId": "p0" },
    { "id": "dock", "label": "Dock 面板", "kind": "step", "status": "planned", "groupId": "p1" }
  ],
  "edges": [
    { "from": "schema", "to": "parse", "kind": "flow" },
    { "from": "parse", "to": "render", "kind": "flow" },
    { "from": "render", "to": "ask", "kind": "flow" },
    { "from": "render", "to": "dock", "kind": "relates" }
  ]
}
```

**B. 思维导图**

```json
{
  "protocol": "deer-canvas",
  "version": 1,
  "kind": "mindmap",
  "title": "交互画布范围",
  "nodes": [
    { "id": "root", "label": "交互画布", "kind": "root", "status": "active" },
    { "id": "types", "label": "四类图", "kind": "topic" },
    { "id": "flow", "label": "流程图", "kind": "topic" },
    { "id": "mind", "label": "思维导图", "kind": "topic" },
    { "id": "road", "label": "路线图", "kind": "topic" },
    { "id": "dep", "label": "依赖图", "kind": "topic" },
    { "id": "safety", "label": "安全", "kind": "topic", "status": "review" },
    { "id": "white", "label": "白名单", "kind": "note", "note": "节点/边/字段枚举 + 纯文本" },
    { "id": "nohtml", "label": "不执行 HTML/JS", "kind": "note" }
  ],
  "edges": [
    { "from": "root", "to": "types", "kind": "contains" },
    { "from": "types", "to": "flow", "kind": "contains" },
    { "from": "types", "to": "mind", "kind": "contains" },
    { "from": "types", "to": "road", "kind": "contains" },
    { "from": "types", "to": "dep", "kind": "contains" },
    { "from": "root", "to": "safety", "kind": "contains" },
    { "from": "safety", "to": "white", "kind": "contains" },
    { "from": "safety", "to": "nohtml", "kind": "contains" }
  ]
}
```

**C. 路线图**

```json
{
  "protocol": "deer-canvas",
  "version": 1,
  "kind": "roadmap",
  "title": "交互画布路线图",
  "direction": "LR",
  "groups": [
    { "id": "p0", "label": "P0 · 对话内", "order": 0, "tone": "accent", "status": "active" },
    { "id": "p1", "label": "P1 · 面板与导出", "order": 1, "tone": "purple", "status": "planned" },
    { "id": "p2", "label": "P2 · 编辑与协作", "order": 2, "tone": "neutral", "status": "planned" }
  ],
  "nodes": [
    { "id": "p0-schema", "label": "协议/校验", "kind": "step", "status": "done", "groupId": "p0", "order": 0 },
    { "id": "p0-ui", "label": "画布 + 表单", "kind": "step", "status": "active", "groupId": "p0", "order": 1 },
    { "id": "p0-ga", "label": "安全与可达性测试", "kind": "milestone", "status": "planned", "groupId": "p0", "order": 2 },
    { "id": "p1-panel", "label": "Dock 画布面板", "kind": "step", "status": "planned", "groupId": "p1", "order": 0 },
    { "id": "p1-png", "label": "PNG/导出增强", "kind": "step", "status": "planned", "groupId": "p1", "order": 1 },
    { "id": "p1-tools", "label": "工具调用通道", "kind": "step", "status": "planned", "groupId": "p1", "order": 2 },
    { "id": "p2-edit", "label": "节点拖拽/批注", "kind": "step", "status": "planned", "groupId": "p2", "order": 0 }
  ],
  "edges": [
    { "from": "p0-schema", "to": "p0-ui", "kind": "flow" },
    { "from": "p0-ui", "to": "p0-ga", "kind": "flow" },
    { "from": "p0-ga", "to": "p1-panel", "kind": "flow" },
    { "from": "p1-panel", "to": "p1-png", "kind": "flow" },
    { "from": "p1-png", "to": "p1-tools", "kind": "flow" },
    { "from": "p1-tools", "to": "p2-edit", "kind": "flow" }
  ]
}
```

**D. 依赖图**

```json
{
  "protocol": "deer-canvas",
  "version": 1,
  "kind": "dependency",
  "title": "交互画布任务依赖",
  "nodes": [
    { "id": "t63", "label": "设计协议与交互", "kind": "task", "status": "done" },
    { "id": "t64", "label": "实现画布与提问", "kind": "task", "status": "active" },
    { "id": "t65", "label": "评审：安全与可达性", "kind": "task", "status": "planned" },
    { "id": "t66", "label": "集成验收", "kind": "task", "status": "planned" },
    { "id": "ship", "label": "可交付", "kind": "milestone", "status": "planned" }
  ],
  "edges": [
    { "from": "t63", "to": "t64", "kind": "depends" },
    { "from": "t64", "to": "t65", "kind": "depends" },
    { "from": "t65", "to": "t66", "kind": "depends" },
    { "from": "t66", "to": "ship", "kind": "depends" }
  ]
}
```

**E. 表单（同时覆盖四种字段）**

```json
{
  "protocol": "deer-question",
  "version": 1,
  "id": "q-scope",
  "title": "确认 P0 实现范围",
  "description": "回答后我会按你的选择继续推进；可稍后再答。",
  "timeoutSec": 900,
  "fields": [
    {
      "id": "platform",
      "kind": "single",
      "label": "优先平台",
      "required": true,
      "options": [
        { "id": "desktop", "label": "桌面 Electron（默认）" },
        { "id": "web", "label": "浏览器 Web" }
      ]
    },
    {
      "id": "features",
      "kind": "multi",
      "label": "P0 必须包含",
      "description": "可多选；至少 1 项",
      "required": true,
      "min": 1,
      "max": 4,
      "options": [
        { "id": "flow", "label": "流程图" },
        { "id": "mind", "label": "思维导图" },
        { "id": "road", "label": "路线图" },
        { "id": "ask", "label": "提问表单" }
      ]
    },
    {
      "id": "notes",
      "kind": "text",
      "label": "补充说明",
      "required": false,
      "placeholder": "可留空",
      "maxLength": 500,
      "multiline": true
    },
    {
      "id": "confirm",
      "kind": "confirm",
      "label": "按以上范围开始实现",
      "required": true,
      "danger": false
    }
  ]
}
```

### 5.6 校验规则（错误码 / 严重度 / 行为）

| 规则 | 检查 | 错误码 | 严重度 | 行为 |
|------|------|--------|--------|------|
| V01 | 单消息交互块 ≤6 | `E_LIMIT` | fatal（该块） | 该块回退，后续文本保留 |
| V02 | 画布块 ≤3 / 问题块 ≤3 | `E_LIMIT` | fatal（该块） | 同上 |
| V03 | 单块原始文本 ≤64KB | `E_TOO_LARGE` | fatal | 不解析，直接回退 |
| V04 | 合法 JSON | `E_JSON` | fatal | 回退 + 原始文本 |
| V05 | `protocol` 精确匹配 | `E_PROTOCOL` | fatal | 回退；提示“不是受支持的画布/表单” |
| V06 | `version === 1`；大于 1 → 版本过新 | `E_VERSION` | fatal | 回退；提示升级应用 |
| V07 | kind / node kind / edge kind / status / tone 枚举 | `E_SCHEMA` | fatal | 回退 + 第一个错误路径 |
| V08 | 标题/标签/备注长度 | `E_SCHEMA` | fatal | 同上 |
| V09 | 节点数 1–80、边 ≤240、分组 ≤12 | `E_SCHEMA` | fatal | 同上 |
| V10 | 节点 id 正则且唯一 | `E_SCHEMA` | fatal | 同上 |
| V11 | 分组 id 正则且唯一 | `E_SCHEMA` | fatal | 同上 |
| V12 | `groupId` 必须存在 | `E_SCHEMA` | fatal | 同上 |
| V13 | 边端点存在 | `E_SCHEMA` | fatal | 同上 |
| V14 | 不允许自环 | `E_SCHEMA` | fatal | 同上 |
| V15 | 边 id（若给）唯一 | `E_SCHEMA` | fatal | 同上 |
| V16 | 未知字段（strict） | `E_SCHEMA` | fatal | 同上；尤其拒绝 `html/style/url/color/x/y` |
| V17 | 重复边（from/to/kind 相同） | `W_DUP_EDGE` | warning | 归一化去重，正常渲染 |
| V18 | 流程图/依赖环 | `W_CYCLE` | warning | 正常渲染 + 回边虚线 + 提示 |
| V19 | 思维导图无根/多根 | `W_ROOT` | warning | 取第一个/第一个 root，提示 |
| V20 | 思维导图不可达节点 | `W_UNREACHABLE` | warning | 作为孤立节点渲染（不隐藏） |
| V21 | 空分组 | `W_EMPTY_GROUP` | warning | 渲染空泳道，footer 提示 |
| V22 | 深度 >4 / 同父 >8 子 | `W_DENSITY` | warning | 布局截断/加半径，提示 |
| V23 | 问题字段 1–6 / id 唯一 | `E_SCHEMA` | fatal | 回退 |
| V24 | 选项 ≥2、≤12、option id 唯一 | `E_SCHEMA` | fatal | 回退 |
| V25 | 多选 min/max 合法（0≤min≤max≤选项数） | `E_SCHEMA` | fatal | 回退 |
| V26 | 文本 maxLength 1–4000 | `E_SCHEMA` | fatal | 回退 |
| V27 | `timeoutSec` 5–3600 整数 | `E_SCHEMA` | fatal | 回退 |
| V28 | 答案值类型匹配字段 | `E_INVALID_ANSWER` | fatal（提交） | 表单内联错误，不落库 |
| V29 | 必填字段齐全 | `E_INVALID_ANSWER` | fatal（提交） | 同上 |
| V30 | single/multi 值必须是选项 id | `E_INVALID_ANSWER` | fatal（提交） | 同上 |
| V31 | 多选数量在 min/max 内 | `E_INVALID_ANSWER` | fatal（提交） | 同上 |
| V32 | 文本长度 ≤ maxLength | `E_INVALID_ANSWER` | fatal（提交） | 同上 |
| V33 | 禁止额外字段/未知 key | `E_INVALID_ANSWER` | fatal（提交） | 同上 |
| V34 | 答案序列化 ≤16KB | `E_TOO_LARGE` | fatal（提交） | 提示缩短 |
| V35 | 问题必须 pending 且未过期 | `E_EXPIRED` / `E_CLOSED` | fatal（提交） | 刷新状态 + toast |
| V36 | 工作区/agent 归属匹配 | `E_WORKSPACE_MISMATCH` | fatal（提交） | 拒绝，不泄漏 |

**错误对象形状**

```ts
export type InteractiveErrorCode =
  | "E_JSON" | "E_SCHEMA" | "E_PROTOCOL" | "E_VERSION"
  | "E_TOO_LARGE" | "E_LIMIT" | "E_UNCLOSED";

export interface InteractiveError {
  code: InteractiveErrorCode;
  /** 面向用户的一句中文；不含模型原文中的潜在 HTML */
  message: string;
  /** 面向“查看详情”的首个错误路径/细节；纯文本 */
  detail?: string;
}
```

**归一化（在 schema 通过后执行，N01–N08）**

| 编号 | 内容 |
|------|------|
| N01 | 节点 id/分组 id 保持原值；边缺失 id → `e1…eN`（冲突时加 `_2` 后缀） |
| N02 | 重复边按 `(from,to,kind)` 去重，保留第一条 |
| N03 | 文本清洗：去除 C0 控制符（除 `\n\t`）、零宽与双向控制符；连续空白折叠为单空格（note 保留换行，最多 8 行） |
| N04 | 默认 direction：flowchart=TB；dependency/roadmap=LR；mindmap 忽略 |
| N05 | 分组排序在布局阶段进行，**不重排 JSON 数组**（保证同输入的布局可复现） |
| N06 | 空边/空分组数组补 `[]`（schema default 已完成） |
| N07 | 问题/画布不自动补节点、不补假关系 |
| N08 | 计算 `artifactId = chatBlockKey(messageId, blockIndex)`（§9.1） |

### 5.7 失败回退（协议 → UI）

```
原始 assistant content
  ├─ 文本段 ─────────────────────────────► Markdown（skipHtml，保持现状）
  ├─ ```deer-canvas（合法）──────────────► CanvasCard
  ├─ ```deer-canvas（非法/超限/版本新）──► CanvasFallbackCard + 原始 JSON（escaped）
  ├─ ```deer-question（合法）────────────► QuestionCard（状态来自 DB）
  ├─ ```deer-question（非法）────────────► QuestionFallbackCard（不可答）
  └─ 未闭合 fence（消息结束）────────────► Fallback E_UNCLOSED
```

回退卡片必须：

1. 保留用户可读的错误原因与错误码（如 `E_SCHEMA · nodes[2].groupId`），不显示堆栈/文件路径。
2. 原始 JSON 放在 `<pre>` 中，React 转义；可折叠、可复制；不执行。
3. 不阻止同一消息中其他文本/合法块渲染。
4. 不写入 `chat_artifacts`（只写一条 `chat.interactive_invalid` 审计事件）；不创建问题状态。
5. 不自动重试模型（P1 用户点“让模型修复”才重试）。

**测试要求**：每个 fatal 错误码至少一个 fixture；每个 warning 至少一个“仍正常渲染”的断言（§13.3）。

### 5.8 系统提示注入（Router 对话）

在 `buildRouterSystemPrompt()`（`src/kernel/service.ts:65–79`）末尾追加一段**固定版本**的协议提示。只注入 Router 系统提示（`sendChat` 与 `getContext` 同源，`src/kernel/service.ts:401`、`:616`）；`buildWorkerSystemPrompt` 与任务执行循环不注入。

````text
## 交互协议 v1（deer-canvas / deer-question）

当你需要画图或向用户提问时，在回复中插入 fenced JSON 块；否则不要使用。

画布：
```deer-canvas
{"protocol":"deer-canvas","version":1,"kind":"flowchart","title":"标题","nodes":[{"id":"a","label":"节点 A","kind":"step","status":"planned"},{"id":"b","label":"节点 B","kind":"step","status":"planned"}],"edges":[{"from":"a","to":"b","kind":"flow"}]}
```

提问：
```deer-question
{"protocol":"deer-question","version":1,"title":"需要确认的问题","fields":[{"id":"choice","kind":"single","label":"选项","required":true,"options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}]}
```

规则：
- kind 只能是 mindmap / flowchart / roadmap / dependency；node kind 只能是 root/topic/step/task/milestone/note/decision/risk；edge kind 只能是 flow/depends/contains/relates；status 只能是 planned/active/blocked/review/done/failed/cancelled。
- 不输出 HTML、CSS、JS、颜色、坐标、尺寸、URL；节点/分组/选项 id 用 ASCII 字母、数字、`_`、`-`（1–64 字符）且唯一；边端点必须存在；标题/标签用纯文本。
- 上限：画布 ≤80 节点、≤240 边、≤12 分组；提问 ≤6 字段；一次回复最多 3 个画布 + 3 个提问。
- 只问真正影响下一步的决策；不要问密码/密钥/令牌；不要用提问代替系统的高风险操作审批。
- 用户的回答会以「[回答表单]」开头的普通消息出现；不要假装用户已经回答。
````

实现注意：

1. 这段文本建议常量 `INTERACTIVE_PROMPT_V1` 放在 `src/shared/interactive.ts`（与 schema 同文件，版本一起改），service 只拼接。
2. 约 450 tokens；不随每次请求重复拼接多个版本；`getContext` 里显示为 system 段的一部分，便于排查。
3. 提示中加入“否则不要使用”，避免模型对每个回复都强行画图。
4. 模型若忽略协议，功能退化为普通文本，不影响现有产品。

### 5.9 历史压缩与上下文

**问题**：画布 JSON 可达 64KB；30 条历史若原样塞给模型，会挤爆上下文。**方案**：进入模型上下文前压缩画布/问题块，用户界面与数据库保留完整内容。

```ts
export function compressInteractiveForModel(content: string, messageId: string): string
```

规则：

| 块 | 压缩形态 |
|----|----------|
| 合法画布 | `[画布「<title>」kind=flowchart 12 节点/14 边 id=<messageId>#b0]` |
| 非法画布 | `[画布：数据无效（E_SCHEMA），未渲染]` |
| 合法问题 | `[表单提问「<title>」4 字段 id=<messageId>#b1]` |
| 非法问题 | `[表单提问：数据无效（E_JSON）]` |
| 未闭合 | `[交互块：未完成]` |
| 文本 | 保留 |

- 只压缩**助手消息**；用户消息原文保留（回答已经足够精炼）。
- 每个块替换后 ≤120 字符；一条消息压缩后若超过 16KB，按 16KB 截断并加 `…`（极少发生）。
- 另在**主 system 消息末尾**（协议段之后）追加「Recent canvases for this conversation:」（最多 5 条，来自 `chat_artifacts`，按 created_at 倒序）。保持**单条 system 消息**，避免不同 OpenAI-compatible provider 对多条 system 的处理差异：

```text
Recent canvases for this conversation:
- <artifactId> "交互画布路线图" (roadmap, 7 nodes)
- ...
```

- 这样模型仍知道“刚才画了什么”，需要完整结构时可通过 P1 的 `artifact.get` 工具读取；P0 不提供工具，模型可选择重画/让用户重发。
- `getContext` 增加 `interactive` 段（复用 `kind: "history"`），列出最近画布/表单摘要与 token 估算；上下文面板无需新增 UI 类型（`src/App.tsx:2811–2825` 直接遍历 sections）。

**示例**（进入模型的历史）：

```text
assistant: 下面是流程：[画布「交互画布实现流程」kind=flowchart 5 节点/4 边 id=chat_x#b0]
user: [回答表单] 确认 P0 实现范围
- 优先平台：桌面 Electron（默认）
- P0 必须包含：流程图、提问表单
- 补充说明：（空）
```

### 5.10 工具调用通道（P1）

| 工具 | 参数 | 返回 | 语义 |
|------|------|------|------|
| `render_canvas` | `DeerCanvas`（不含 protocol/version，或含亦可） | `{ok:true, artifactId}` / `{ok:false, error}` | 渲染一张画布；校验失败把错误回给模型重试（最多 1 次） |
| `ask_user` | `DeerQuestion` | `{ok:true, questionId, pending:true}` | 挂起问题；模型回合结束，用户回答后以普通消息续聊（或工具结果续聊，取决于 P1 循环实现） |

约束：

- 工具只在 Router 对话可用；worker/任务执行不可见。
- 工具本身无文件/shell 权限；`policyCheck` 归为低风险 UI 工具（P1 需要给 `policyCheck` 增加白名单，默认允许所有权限模式，因为无副作用）。
- 每次模型回合最多 2 次 `render_canvas` + 2 次 `ask_user`，超出返回 `E_LIMIT`。
- 工具结果会被回放；服务端仍以 zod 重新校验，绝不信任模型直接给的对象。
- P1 不在本轮实现；t64 只需保证 `src/shared/interactive.ts` 的 `parseCanvasJson`/`parseQuestionJson` 可被工具层直接复用。

### 5.11 版本兼容策略

| 情况 | 行为 |
|------|------|
| `version: 1` | 支持 |
| `version > 1` | `E_VERSION` 回退卡片，提示“画布版本过新，请升级 DeerSuperGroup” |
| `version` 缺失/0/负数 | `E_SCHEMA` |
| 未来 v2 | `interactive.ts` 保留 `SUPPORTED_CANVAS_VERSIONS = [1]`；迁移函数放同文件；渲染层按版本分支 |
| 协议字段大小写 | 精确匹配；`deer-canvas ` 前导/尾随空白 trim 后匹配 |
| 旧消息 | 无 `deer-*` 块 → 行为完全不变；有合法块 → 正常渲染 |
| 回退块 | 不缓存、不迁移、不参与历史压缩以外的处理 |

---
## 6. 提问弹窗与交互式表单

### 6.1 概念模型

- **一个 `deer-question` 块 = 一张表单**，包含 1–6 个字段；提交一次 = 一个回答。
- **问题不是“阻塞等待”**：模型本轮回复照常结束；问题以卡片/弹窗等待用户，回答后作为**新的用户消息**继续对话（§6.5）。
- **问题状态机**只有主进程可写：

```
pending ──submit──▶ answered（终态）
   │
   ├──cancel（用户显式取消）──▶ cancelled（终态）
   └──expiresAt 到期（惰性清算）──▶ expired（终态）
```

- **deferred（稍后）不是状态**：只是 UI 关闭弹窗、问题保持 pending。
- 终态不可逆；同一问题不会再次弹出；P1 的“重新提问”是生成一个新问题（新块）。

### 6.2 卡片与弹窗 Anatomy

**内联卡片（对话气泡内，始终显示）**

```
┌───────────────────────────────────────────────────────┐
│ ◇ 需要你确认 · 4 个字段             待回答 · 14:32 剩余 │
│ 确认 P0 实现范围                                      │
│ 回答后我会按你的选择继续推进。                          │
│ [ 回答问题 ]                              [ 查看字段 ] │
└───────────────────────────────────────────────────────┘
```

- 已回答：边框转 muted，标题前 `✓`，显示前 3 项答案摘要 + 「展开全部」；无操作按钮。
- 已过期：`⚠ 已过期 · 未提交`；P1 提供「让模型重问」。
- 已取消：`⊘ 已取消`。
- 非法表单：见 §5.7 回退卡片，不可答。
- 状态记录缺失：`questions` 尚未加载时显示「问题状态加载中…」并禁用；已加载但该 key 无记录时显示 `E_NOT_PERSISTED` 回退（说明服务端未落库，不可答），**不无限 loading**。
- 客户端时间已过 `expiresAt`、但服务端尚未清算：卡片先按「即将过期/已过期」禁用提交，提交时仍以服务端 `E_EXPIRED` 为准。
- 卡片本身就是可发现的入口；即使自动弹窗被抑制（用户在别处/正在输入），卡片仍在。

**弹窗（App 根节点，复用 `Modal`）**

```
┌───────────────────────────────────────────────────────────────┐
│ 问题：确认 P0 实现范围            问题 1/3 · 剩余 14:32   关闭 │
├───────────────────────────────────────────────────────────────┤
│ 回答后我会按你的选择继续推进。                                  │
│                                                               │
│ 优先平台 *                                                    │
│   (•) 桌面 Electron（默认）     ( ) 浏览器 Web                 │
│                                                               │
│ P0 必须包含 *   可多选；至少 1 项        已选 2/4              │
│   [x] 流程图   [x] 思维导图   [ ] 路线图   [ ] 提问表单       │
│                                                               │
│ 补充说明                                                      │
│   ┌─────────────────────────────────────────────────────┐     │
│   │ 可留空                                              │     │
│   └─────────────────────────────────────────────────────┘     │
│                                                               │
│ 按以上范围开始实现 *                                          │
│   [ 确认 ]   [ 不确认 ]                                        │
│                                                               │
│ [错误摘要 role=alert]                                         │
├───────────────────────────────────────────────────────────────┤
│ 回答会作为一条消息发送给当前配置的模型。                        │
│ [稍后回答]        [取消提问]                  [提交回答]       │
└───────────────────────────────────────────────────────────────┘
```

- 标题区显示队列位置 `问题 1/N`；`N` 来自当前 workspace+agent 的 pending（不含 deferred 差异，deferred 仍是 pending）。
- 超时存在时显示剩余时间；无超时显示「可稍后回答」。
- 底部固定隐私提示；不显示模型/供应商名称，避免泄漏路由细节。
- 提交后：成功 toast「回答已提交，Router 继续」；若下一问题存在且满足自动打开条件，直接切到下一问题（标题更新，不卸载 modal 外壳也可，P0 可重建）。

### 6.3 队列与自动打开

**队列规则**

1. 队列 = 当前 workspace + router agent 下 `status === "pending"` 且未过期的问题，按 `createdAt` 升序；同一时间只显示一个 Modal。
2. 用户手动点击卡片「回答问题」→ 立即打开该问题（即使已有其它问题在队列）。
3. 提交/取消当前问题后：若有下一个，且自动打开条件满足 → 打开下一个；否则关闭并保留卡片。
4. 「稍后回答」= 关闭 Modal，问题保持 pending，并记录 `deferredIds`（会话内）；自动打开不再对该 id 触发，直到用户手动点开。
5. 最多保留 200 条问题记录（按 workspace+agent 查询上限）；pending 正常不会很多。
6. 两个问题同时到达（同一消息多次提问）：按 blockIndex 排序；Modal 顶部显示「还有 N 个待回答」。

**自动打开条件（DEC-10）**

| 条件 | 要求 |
|------|------|
| 对话面板可见 | 当前激活 dock 面板是 `chat`（`onActivePanelChange` → `tab === "chat"`） |
| 窗口有焦点 | `document.hasFocus()` |
| 无其他 Modal | 没有 `riskApproval`、成员编辑、发布黑板等弹窗；实现上用 `document.querySelector('[role="dialog"]')` 排除当前问题弹窗（画布详情浮窗也算 dialog，此时不自动抢焦点） |
| 用户不在输入 | composer 无未发送文本且未聚焦；避免抢输入焦点 |
| 未延后 | 该问题不在 `deferredIds` |
| 每个问题只自动开一次 | `autoOpenedRef` 记录 id，避免关闭后死循环 |

任一条件不满足：不弹 Modal；如果问题新到达且不在当前面板，push **info toast**（带「去回答」动作，点击打开 chat 面板并弹该问题）。同一批多个问题只发一条 toast（「Router 有 2 个问题需要你回答」）。

### 6.4 超时、延后与取消

| 动作 | UI | 服务端 | 结果 |
|------|----|--------|------|
| 稍后回答 | Modal 关闭，焦点回触发按钮；卡片保留；`deferredIds` 记录 | 无调用 | pending 不变 |
| 取消提问 | 按钮二次确认（第一次变「确认取消？」，4s 内再点才生效；`Escape`/移开取消确认） | `cancelChatQuestion`：`UPDATE ... WHERE status='pending'`；写 `chat.question_cancelled` 事件 | cancelled 终态；卡片显示已取消 |
| 超时 | 倒计时到 0：关闭 Modal，toast error「问题已过期」；卡片显示过期 | `listChatQuestions` 惰性清算：`WHERE status='pending' AND expires_at <= now` → expired；写事件 | expired 终态 |
| 提交时已过期 | 表单提交返回 `E_EXPIRED`；刷新状态；表单内容保留在草稿 | `answerChatQuestion` 检查 `expires_at` | 不落库；toast；可复制草稿 |
| 提交时已回答 | 返回 `changed:false`；不重复发消息 | 条件更新失败后读回 | 卡片显示已回答；toast info |
| 工作区切换 | 关闭 Modal、清空队列/草稿、清 `deferredIds` | — | 新工作区独立 |
| 应用重启 | 未回答的 pending 从 DB 恢复；已过期在首次 list 时清算；deferred 丢失（自动打开可能再次触发一次） | 惰性清算 | 可接受（P1 持久化 deferred） |

- **超时不阻塞**：到期只是状态变化，不会撤销已发生的对话；用户可继续聊别的内容。
- **取消不通知模型（P0）**：模型可能认为问题仍待回答；P1 在取消时追加一条系统/用户提示「用户取消了提问」。P0 在卡片显示已取消，用户可自行说明。
- **超时/取消的文案**使用 `formatError` 风格的中文，不带堆栈。

### 6.5 回答回流格式

**服务端生成**（`formatQuestionAnswer`，纯函数）：

```text
[回答表单] 确认 P0 实现范围

- 优先平台：桌面 Electron（默认）
- P0 必须包含：流程图、思维导图
- 补充说明：
  先做对话内，Dock 面板下一轮。
- 按以上范围开始实现：确认
```

规则：

1. 首行固定 `[回答表单] <title>`；模型系统提示已声明该前缀。
2. 按 question.fields 顺序输出；label 使用字段原文（纯文本）。
3. `single` → 选中 option.label；`multi` → 以 `、` 连接 option.label；`confirm` → `确认` / `不确认`；`text` → 原文，多行缩进 2 空格；空文本输出 `（空）`。
4. 不包含隐藏 id/JSON/HTML；option 文本已清洗。
5. 格式化消息总长度 ≤8KB；结构化答案 JSON ≤16KB（`QUESTION_LIMITS.answerBytes`）；超出 → `E_TOO_LARGE` 并提示缩短。
6. 回答作为**普通用户消息**写入 `chat_messages`（`role:"user"`），随后 `sendChat` 让 Router 继续；历史/刷新/上下文自动包含，不需要新增 `ChatMessage` 字段。
7. 结构化答案同时保存在 `chat_questions.answer`，供 UI 回显与审计；模型只依赖格式化文本即可读懂。
8. 如果用户回答的是旧问题（已有更新问题存在），仍然按当前问题继续；不自动串联到最新问题。

**为什么不加隐藏 JSON 元数据**：用户消息在 UI 中按纯文本渲染（`src/App.tsx:2753–2755`），隐藏 JSON 会露出来或需要额外渲染分支；格式化文本已经足够模型解析，且可读、可复制、可审计。P1 若需要机器可读引用，再给 `ChatMessage` 加 `meta` 列（需要迁移与 UI 调整），不在 P0。

### 6.6 防重复提交与幂等

| 层 | 机制 |
|----|------|
| UI | `submitting` state；按钮 `disabled` + `aria-busy`；表单 `submit` 只允许一次（防双击/回车连发）；轮询/事件刷新不会重置正在提交的表单 |
| 客户端校验 | 提交前 `validateQuestionAnswers`；失败不发 IPC，聚焦第一个错误 |
| IPC | `answerChatQuestion` 请求携带 `questionId`（规范键），无“重试 id”；重复请求由服务端判定 |
| 服务端 | 单事务条件更新：`UPDATE chat_questions SET status='answered', answer=?, answered_at=? WHERE id=? AND status='pending' AND (expires_at IS NULL OR expires_at > ?)`；`changes===0` 时读回状态：answered → 返回 `changed:false` + 既有 answerText；expired → `E_EXPIRED`；cancelled → `E_CLOSED` |
| 会话层 | `changed:true` 才发送用户消息；`changed:false` 不重复发送 |
| 发送失败 | 回答已保存、消息未发出：toast error + 「重新发送回答」；重发前用 `loadChat` 检查最后一条消息内容是否已等于 answerText，避免重复 |
| 多窗口 | 当前 Electron 单窗口；服务端条件更新仍能兜底（第二个提交返回 answered） |
| 多标签/多实例 | 不做跨实例协调；后写失败并收到 answered，属可接受 |
| 两个不同问题并发提交 | UI 一次只显示一个 Modal，正常不会并发；服务端只保证单问题幂等，不合并两次发送；P1 若多窗口开放，增加发送队列/幂等键 |

**answerText 重建**：`chat_questions.answer` 存 `{values, answeredAt}`；对 answered 状态重复请求时用同一 `formatQuestionAnswer` 重新生成，保证幂等返回一致。

### 6.7 键盘与 ARIA

| 场景 | 约定 |
|------|------|
| 打开弹窗 | 焦点进入第一个字段（不是“关闭”按钮）；通过扩展 `Modal` 的 `initialFocusRef` 实现，默认行为不变 |
| 单选 | 原生 `<input type="radio">`，`↑/↓/←/→` 切换，`Space` 选择；`fieldset/legend` 分组 |
| 多选 | 原生 `<input type="checkbox">`；`Space` 切换；显示 `已选 n/max` |
| 文本 | `<textarea>` 或 `<input>`；`Ctrl/⌘+Enter` 提交，`Enter` 换行（multiline） |
| 确认 | 两个按钮/单选值「确认 / 不确认」；选择只作为回答值、不执行操作；`aria-describedby` 说明“这是对当前问题的回答，不会关闭提问”；`danger` 只加危险样式 |
| 提交 | 表单 `onSubmit`；按钮文案固定「提交回答」；`aria-busy`；Enter 在非 textarea 字段可提交 |
| 错误 | 字段级 `aria-invalid` + `aria-describedby`；错误摘要 `role="alert"`；焦点移到第一个错误字段 |
| 队列 | 标题「问题 n/N」；新问题/提交成功用 `aria-live="polite"` 播报（不重复读倒计时） |
| 倒计时 | 视觉倒计时 `aria-hidden="true"`；对读屏提供静态「该问题在 HH:mm 前有效」 |
| 稍后 | Esc / 头部关闭 / 「稍后回答」都走同一路径；焦点回到触发卡片按钮 |
| 取消 | 显式按钮；二次确认；不用 `window.confirm`（阻塞、不可测） |
| 焦点陷阱 | 继承 `Modal`：Tab/Shift+Tab 循环、打开聚焦、关闭回焦、背景滚动锁、`role=dialog aria-modal` |
| 读屏文案 | 不使用纯颜色/图标表达必填/错误；状态有中文文本 |
| 高对比/减弱动效 | 状态边框 + 文本；`prefers-reduced-motion` 关闭过渡与倒计时动画 |

**Modal 需要的小扩展**（backward compatible）：

```ts
export default function Modal({
  // 现有 props 不变
  initialFocusRef?: React.RefObject<HTMLElement | null>,
  // ...
}) {
  // 打开时：initialFocusRef?.current?.focus() ?? focusable[0]
}
```

- 影响范围：`src/Modal.tsx` 仅新增可选 prop；现有 5 个弹窗不传时行为不变，t21 的 Modal 基线测试/手测不回归。
- 不用 `autoFocus`（t21 明确移除过，避免意外抢焦点/可访问性问题）。

### 6.8 提问安全细则

| 风险 | 对策 |
|------|------|
| 选项注入 HTML/Markdown | option.label/description 只以 React 文本渲染；**不经过 Markdown**；导出/回答文本同样纯文本；控制字符清洗 |
| 选项诱导执行 | 选项只是值，不绑定动作；不渲染链接/按钮以外的元素；`confirm` 不执行任何操作，真正的危险操作仍走工具审批 |
| 伪造问题 | 只解析助手消息；问题记录由主进程 ingest 时落库；renderer 不能自造问题 id 让用户答 |
| 越权回答 | 服务端校验 workspace/agent、状态、字段 id、选项 id、类型、必填、长度；额外字段拒绝 |
| 重放/重复 | 条件更新 + changed 标志；终态不可回 pending |
| 秘密收集 | 系统提示禁止询问密码/密钥/令牌；P0 不做自动检测（P1 可加敏感词提示）；回答明文进入会话，用户可见 |
| 超长/资源耗尽 | 字段/选项/文本长度限制；答案序列化上限 16KB；问题块原始 JSON ≤64KB |
| 状态欺骗 | 不信任 renderer 的 `status`；每次读取来自 DB；答案只从 `answerChatQuestion` 写入 |
| 计时器攻击 | 倒计时只影响 UI；过期判定以服务端时间为准（ISO 字符串比较） |
| 错误信息泄漏 | 错误只显示错误码与字段路径，不回显内部路径/堆栈 |

### 6.9 窄窗与多问题

- Modal 宽度 `min(560px, calc(100vw - 32px))`；`max-height: min(760px, 85vh)`；内容区滚动、footer sticky。
- 窄窗（<520px 容器）：字段描述换行；选项一行一个（不横向并排）；队列位置与倒计时换行；「取消提问」收进次级位置，主按钮仍清晰。
- 长选项/长描述：`overflow-wrap:anywhere`；禁用水平滚动。
- 多个问题：只弹一个；队列数在标题；提交后自动下一个（满足自动打开条件时）。
- 弹窗打开期间不改变 Dock 布局；背景滚动被 Modal 锁定（现有行为），内容区自身滚动（`max-height` + `overflow:auto`）。

---

## 7. UI / UX 与现有系统集成

### 7.1 ChatView 内的呈现

**渲染路径（新增 `src/ChatContent.tsx`）**

```
ChatBubble
 ├─ role === "assistant"
 │    └─ <ChatContent messageId={message.id} content={message.content} questions={questionsById} ... />
 │         ├─ text part  → <Markdown content={text} />
 │         ├─ canvas ok  → <CanvasCard ... />
 │         ├─ canvas bad → <CanvasFallbackCard ... />
 │         ├─ question ok→ <QuestionCard record=... onAnswer=... />
 │         └─ question bad→ <QuestionFallbackCard ... />
 ├─ role === "user" → 纯文本（保持现状，不解析 deer-*）
 └─ streaming → <StreamingPreview text={chatStream} reasoning={chatReasoning} />
```

- 助手消息仍保留 `chat-meta`、头像、时间、reasoning 折叠（`src/App.tsx:2718–2762` 的结构不变）。
- `ChatContent` 只负责切的“内容区”，不改变气泡宽度/布局；卡片 `display:block; margin:8px 0`。
- **用户消息永远不解析为画布/表单**（即使手动输入 `deer-canvas`），防止伪造与误导。
- 系统消息同理。

**流式阶段（P0）**

- 流式文本中一旦出现 `deer-canvas` / `deer-question` fence（含未闭合），从预览中**移除该 fence 及其后内容**，显示一行：
  - 「正在生成画布…」/「正在生成表单…」（带静态点或 reduced-motion 下静态文本）。
- 流式阶段不渲染半张画布/半张表单；避免 JSON 裸露与布局跳动。
- 结束后 `done` 重载消息 → 完整解析渲染。
- 若流式结束时仍无闭合 → 回退卡片 `E_UNCLOSED`（而不是永久“生成中”）。
- 纯函数 `stripInteractiveForStreaming(content)` 放 `src/shared/interactive.ts`，可单测。

**滚动与展开**

- 现有 `useEffect` 在 messages/stream 变化时滚到底（`src/App.tsx:2530–2535`）。画布卡片可能较高：P0 接受“滚到底”（看到卡片底部）；用户可手动上滚。
- 「放大」只改变卡片内高度（240–420 → 560），不弹 Modal；「适应」重新 fit。
- 卡片不自动抢占滚动焦点；不自动播放动画。

**ChatView 头部**

- 新增一个轻量 badge：`待回答 N`（仅当 pending>0），点击打开队首问题；与现有「任务上下文」「返回」按钮并列（`src/App.tsx:2557–2576`）。
- 不在侧栏/顶栏新增入口，避免违反 C10「不新增第 8 个顶层入口」。
- 空状态/示例不变（`EmptyState`），避免本轮改动面扩大。

### 7.2 与 Markdown 的关系

| 点 | 设计 |
|----|------|
| 解析顺序 | 先按 fence 切分（`parseChatContent`），再对每个文本段调用现有 `<Markdown>`；画布/表单块不进入 Markdown |
| `skipHtml` | 保持 `src/Markdown.tsx:9` 不变；新增组件也不使用 `dangerouslySetInnerHTML` |
| 其他代码块 | 完全保持 Markdown 代码块渲染（含语法样式）；只有 `deer-canvas`/`deer-question` 被拦截 |
| 内联代码 | `` `deer-canvas` `` 行内代码**不触发**；只有 fence 触发 |
| 文本块边界 | 保持原文空行，避免 Markdown 段落被切碎；切分只替换 fence 区域 |
| 流式 | 预览只显示剥离后的文本；完整块在 done 后渲染 |
| 测试 | 现有 `src/Markdown.test.tsx` 两条（标题/列表/代码/表格 + 丢弃 raw HTML）必须继续通过；新增 `ChatContent` 测试只断言分段与卡片存在 |
| 主题 | 卡片内部样式独立；文本段仍使用 `.markdown-body`；不向 Markdown 注入新插件 |

### 7.3 与 Modal 的关系

- **问题弹窗**复用 `src/Modal.tsx`：Esc/焦点陷阱/回焦/`aria-modal`/滚动锁全部继承；新增可选 `initialFocusRef`（§6.7）。
- **画布详情浮窗不使用 Modal**：它是非模态 popover（与星图 S04 一致），避免打开节点详情就锁背景滚动。
- **不允许嵌套 Modal**：问题弹窗打开期间若出现 `riskApproval`，立即收起问题弹窗（保留 pending + toast「先处理高风险审批」）；审批处理后用户可重新打开。反之，审批弹窗打开时不自动打开问题弹窗。
- **z-index**：Modal backdrop 100（现有）；toast 200（现有）；画布详情浮窗在卡片内（z-index ≤20）；互不遮挡。
- **未保存草稿**：问题弹窗关闭 = 稍后，不销毁草稿（App 持有草稿 state）；`confirmClose` 保持 false，避免“关闭即丢”和二次确认噪音；显式「取消提问」才失效。
- **焦点回退**：关闭后焦点回到触发卡片按钮；若由自动打开触发，回到 composer（或触发前焦点）；实现需记录 `restoreFocusRef`。

### 7.4 与 Toast 的关系

- 扩展 `ToastItem.kind` 增加 `"info"`（`src/Toast.tsx:11–17`），用于「新问题到达」「回答已保存待发送」「已回答」等中性提示；CSS 增加 `.toast-info`（边框 `--accent`，role=status，aria-live=polite）。
- 成功：导出成功、回答已提交、取消成功。
- 错误：导出失败、回答过期、发送回答失败、问题数据损坏（仅一次，不刷屏）。
- 每个事件最多一条；同一 tick 去重（按 message+kind）；最多 3 条继承现有逻辑。
- 不使用 toast 报告每个画布节点的点击/折叠（噪音）。
- Toast 动作：新问题「去回答」、发送失败「重试」、导出失败「重试」；action 点击后 dismiss（现有 `src/Toast.tsx:108–117`）。
- 无障碍：info/success `role=status`，error `role=alert`；继承现有实现。

### 7.5 与 Dock 的关系

- P0：画布/提问只存在于 `chat` 面板内部；不新增面板、不改 `panelRegistry.ts`、不改 `DockShell.tsx` 的持久化/变体逻辑。
- 卡片宽度自适应：用 `ResizeObserver` 读取自身宽度，设置 `data-width="compact|regular|wide"` 类；**不按 window 宽度**做断点（Dock 分栏宽度独立）。
- `chat` 面板最小宽度 420（`panelRegistry.ts:44`）：画布在 420 宽时进入 compact（单行工具条 + 图例折叠 + 标签 LOD 更激进）；不横向溢出。
- Dock 变体（wide/medium/narrow/single，`panelRegistry.ts:128–147`）不改变画布组件行为，只改变可用宽度；P0 用容器宽度自适应覆盖。
- Dock 的 `context` 面板仍是独立面板；画布不需要上下文面板。
- P1「画布」面板规格见 §4.7；实现时须保持现有 `deer.dock.v1.*` 存档兼容（新增 key 的默认关闭面板不改变旧存档，`fromJSON` 未知 key 丢弃的现有行为需验证）。

### 7.6 与主题 token 的关系

| 用途 | token/规则 |
|------|-----------|
| 画布背景 | `--canvas-bg`（`--bg-2`） |
| 点阵 | `--canvas-grid`（`--border` 的 color-mix） |
| 节点底/边 | `--canvas-node-bg` / `--canvas-node-border` / `--canvas-edge` |
| 选中/聚焦 | `--canvas-focus`（`--accent`）2px 环 + 节点描边 |
| 状态色 | 仅 `--status-ready/running/blocked/review/done/failed/cancelled`（`src/styles.css:18–27`） |
| 状态底 | `color-mix(in srgb, var(--status-*) 18%, var(--panel))`；文本仍用 `--text` |
| 分组泳道 | `--canvas-lane`；tone 映射到 accent/purple/green/yellow/red/muted 六个 token，不新增色板 |
| 画布/表单 | `--panel`/`--panel-2`/`--border-2`/`--accent`，与现有 Modal 表单一致 |
| 焦点 | `:focus-visible` 2px `--accent`，offset 2px（与星图/控制条一致） |
| 字号 | 节点标题 12px（低缩放 11px）；meta 11px；卡片标题 12px；不使用 10px 以下正文 |
| 对比度 | 节点文字 `--text` on `--panel`；状态文字用中文+高对比；dim 节点在聚焦时恢复 1.0，非焦点 dim ≥0.25（仅视觉，不删信息） |
| 动效 | 过渡 120–160ms；`prefers-reduced-motion` 下全部 none |

**禁止**：新增品牌色、模型传入色值、内联 `style={{ color: modelValue }}`、class 名来自模型。

### 7.7 窄窗与响应式

| 宽度 | 行为 |
|------|------|
| 卡片自身 ≥760 | `wide`：完整工具条、图例展开、标签 LOD 正常 |
| 520–759 | `regular`：工具条 2 行、图例默认折叠、meta 隐藏 |
| <520 | `compact`：工具条只留「适应/导出/更多」；图例收进「更多」；底部提示一句；画布高度 220px 起 |
| `chat` 面板 420（Dock 最小值） | 无横向滚动；节点标签截断；详情浮窗宽 ≤260，clamp 在卡片内 |
| 960 窗口（Electron minWidth） | Dock single 变体下 chat 全宽；画布/表单可用；表单宽度不超视口 |
| 1100 / 1440 | 常规两栏；画布不被 team 面板挤压到溢出 |
| 200% 缩放 | 工具条可换行；节点命中区≥44px；表单字段可滚动；无内容被裁切 |

- 窄窗下 **画布不降级为纯文本**：仍可缩放/查看节点；P1 提供列表视图作为无障碍替代。
- 图例、提示、导出菜单在 compact 下收入「更多」按钮（原生 button + 简易菜单，不用 portal/复杂浮层）。
- Modal 宽度与最大高度见 §6.9；footer 按钮在窄窗可换行。

### 7.8 “单击不误触双击”状态机（硬要求）

```
         pointerdown(node)
               │
         pointerup / click
               │
   moved > 4px ? ──yes──▶ 视为拖拽，忽略点击
               │no
       event.detail === 1
               │
        select(node) 立即反馈
               │
        timer = setTimeout(openDetail, 250ms)
               │
   second click within 250ms (detail === 2)
               │
        clearTimeout(timer)
        toggleFocus(node)     ← 双击语义：1 跳聚焦
        （不会先闪出详情浮窗）

   Enter        → openDetail
   Ctrl/⌘+Enter → toggleFocus
   Escape       → 详情 → 聚焦 → 清空（逐级）
```

- 为什么用 `event.detail`：比 `onDoubleClick` + `setTimeout` 更可靠；`detail` 由浏览器维护，第二次点击会取消 pending。
- 拖拽位移阈值 4px（与星图候选 S13 的 `<4px` 阈值一致）；缩放/平移时指针事件不冒泡到节点。
- 触屏：`pointer` 事件统一处理；`click.detail` 在移动端可能为 1，双击手势属于 P1（Electron 桌面为主）。
- 键盘用户不存在双击问题；`Enter` 与 `Ctrl+Enter` 显式区分。
- 状态机由纯函数 `resolveNodeClick(state, event)` 实现并单测（AC-05）。

### 7.9 加载 / 空 / 错误状态文案

| 场景 | 文案 | 交互 |
|------|------|------|
| 流式生成 | 正在生成画布… / 正在生成表单… | 无按钮 |
| 画布全折叠 | 全部已折叠 | 「展开全部」 |
| 画布无可见节点（过滤/折叠） | 没有可见节点 | 「展开全部」 |
| 非法画布 | 画布数据无效 · E_SCHEMA | 「查看原始数据」「复制」 |
| 超限 | 画布过大 · E_TOO_LARGE（93 > 80 节点） | 「复制原始数据」 |
| 版本过新 | 画布版本过新 · E_VERSION | 「复制原始数据」 |
| 未闭合 | 画布数据未完成 · E_UNCLOSED | 「复制原始数据」 |
| 问题已回答 | 已回答 · 3 个字段 | 「展开回答」 |
| 问题已过期 | 已过期 · 未提交 | （P1 让模型重问） |
| 问题已取消 | 已取消 | 无 |
| 无待回答问题 | （不展示） | — |
| 导出失败 | 导出失败：<原因> | toast「重试」 |
| 发送回答失败 | 回答已保存，但发送失败 | toast「重试」 |
| Router 正在回复时提交 | Router 正在回复，完成后才能提交回答 | 提交禁用 |

### 7.10 可访问性检查表（P0 必须）

| 检查 | 期望 |
|------|------|
| 键盘完成画布链路 | Tab 到节点 → Enter 详情 → Esc 回焦 → Tab 到卡片动作 |
| 键盘完成表单链路 | Tab 逐字段 → Space 选择 → Tab 提交 → Enter → 成功提示 |
| 焦点可见 | 所有 button/radio/checkbox/textarea `:focus-visible` 2px accent |
| 焦点不丢 | 打开/关闭 Modal、详情浮窗后焦点可预测；无“掉到 body” |
| 语义 | Modal `role=dialog aria-modal`；画布 `role=application` + label；节点 button + label；表单 fieldset/legend |
| 状态播报 | 聚焦/折叠/队列/提交结果 `aria-live`；错误 `role=alert` |
| 颜色非唯一 | 状态有图标/文字；图例有三通道；错误有文本 |
| 对比度 | 正文/按钮/节点文字 ≥4.5:1（大文本 ≥3:1）；dim 仅装饰 |
| 动效 | reduced-motion 下关闭过渡/脉冲/倒计时动画 |
| 缩放 | 200% 下不裁切、不横向滚动 |
| 读屏 | 节点读「标题/类型/状态/分组/上下游」；表单错误可读；问题标题/队列可读 |
| 纯色/灰度 | 灰度截图仍能通过状态标记区分（手工） |

---
## 8. 安全设计

### 8.1 威胁模型

| 资产/边界 | 威胁 | 影响 | 对策 |
|-----------|------|------|------|
| 模型输出（不可信） | 输出 `<script>`/`<img onerror>`/事件处理器 | XSS / 本地文件读取 | 只走纯文本 + React 转义；无 `dangerouslySetInnerHTML`；Markdown `skipHtml` |
| 模型输出 | 输出任意 HTML/SVG/CSS/URL | 钓鱼、外链、样式覆盖、数据外泄 | schema 白名单 + strictObject；无 href/src/style/class；导出自绘 SVG/白名单 Mermaid |
| 模型输出 | 恶意 Mermaid 标签注入指令/链接 | 导出文件注入、外部请求 | id 内部映射、标签清洗、导出后白名单行检查、不导 `click/style`/链接 |
| 模型输出 | 超长/递归/环/节点爆炸 | 卡死、内存/CPU DoS | 字节/数量/深度/边数上限；布局 visited 集合；无随机/无指数递归 |
| 模型输出 | 伪装成系统提示/工具结果 | 诱导执行/越权 | 画布/提问内容只做展示；不参与工具调用；系统提示明确“用户回答以 [回答表单] 开头” |
| 用户输入（不可信） | 手打 `deer-canvas` 伪造画布/问题 | 伪造 AI 产物、误导他人 | 只解析 assistant 消息；用户消息纯文本 |
| Renderer（可信度有限） | 篡改 answer values / 状态 | 绕过必填/选项约束、重放 | 主进程重新校验 + 条件更新 + 终态不可逆 |
| Renderer | 越工作区读取 artifact/question | 数据隔离破坏 | 所有查询带 workspace/agent 条件；answer 校验工作区 |
| 持久化 | 旧消息/DB 被手工污染 | 渲染崩溃/注入 | 渲染以 schema 校验为准；DB payload 读时再校验；损坏 → 回退 |
| 导出文件 | 文件名路径穿越 | 写任意路径 | 浏览器下载 API + slug 文件名，不含 `/ \ : ..` 与控制字符 |
| 问题弹窗 | 诱骗用户输入密码/密钥 | 凭据泄漏 | 系统提示禁止；UI 隐私提示；P1 敏感词提示；回答只在本地 DB + 当前模型 |
| 问题弹窗 | 把危险操作伪装成“确认” | 用户误点 | confirm 不执行任何操作；危险操作审批仍走独立 Modal/工具门禁 |

**信任边界**：Renderer 是展示层，主进程是状态机；模型输出是**数据**，不是指令；任何“请忽略之前指令/执行命令”类文本在画布/问题里都只会作为文本显示。

### 8.2 白名单原则

1. **协议白名单**：只有 `deer-canvas` / `deer-question` 两个 fence、version 1、固定 protocol 字符串。
2. **结构白名单**：只有 schema 列出的字段；`z.strictObject` 拒绝其余字段；数组长度上限。
3. **枚举白名单**：kind/status/node kind/edge kind/tone/field kind 全部枚举；未知值 → 整块回退。
4. **属性白名单**：模型不能给 `href/src/style/className/id(HTML)/onClick/dangerouslySetInnerHTML/color/width/height/x/y`。
5. **节点/边语义白名单**：只有 `flow/depends/contains/relates`；画布内容不会变成真实任务依赖、不会写任务/黑板/邮箱。
6. **问题字段白名单**：只有四种控件；不支持上传、URL、文件路径、命令、HTML。
7. **导出白名单**：Mermaid 只允许受控指令集；SVG 只由自绘函数生成；无外部资源。

### 8.3 渲染安全（画布/卡片/导出）

| 面 | 规则 |
|----|------|
| 文本 | 全部通过 React `{text}` 渲染；不拼 innerHTML；不 `decodeURIComponent` 模型文本；控制符/双向控制符清洗（N03） |
| 属性 | 不允许模型值进入 `href/src/style/className/dangerouslySetInnerHTML`；DOM class 全部静态拼接 + 枚举（`status-${status}` 中 status 已是枚举） |
| SVG（界面） | 节点形状/边由组件生成；`<text>` 只放 React 文本；`aria-hidden` 用于装饰；不使用 `foreignObject` |
| SVG（导出） | 纯函数生成字符串；所有动态文本经 `escapeXml`；fill/stroke 来自 token 快照；不引用外部字体/图片/URL；无 `<script>`/`<foreignObject>`/事件属性 |
| Mermaid | id 重新映射（`n0`…/`g0`…）；标签清洗；不输出 classDef/style/click/linkStyle；导出前白名单行校验 |
| Markdown | 保持 `skipHtml`；画布/问题不经过 Markdown；文本段仍用现有组件 |
| React key | 可用模型 id 作为 `key`（不写入 DOM）；重复 id 已在 schema 拒绝 |
| 错误展示 | 只回显错误码/路径/截断后的原始 JSON（`<pre>`），不显示堆栈/文件路径 |
| 控制台 | 渲染异常记录 `console.error`（含错误码），不上报网络 |

**明确禁止的 API**（代码评审需 grep 确认）：`dangerouslySetInnerHTML`、`innerHTML`、`outerHTML`、`eval`、`new Function`、`setTimeout(string)`、`document.write`、`<iframe>/<object>/<embed>`、`window.open`（导出文件名/URL 不来自模型）。

### 8.4 问题选项与回答注入

| 攻击 | 说明 | 防护 |
|------|------|------|
| 选项 HTML | `label: "<img src=x onerror=...>"` | 纯文本渲染；React 转义；SSR 测试断言不出现 `<img` |
| 选项 Markdown | `label: "[点我](javascript:...)"` | 选项不经过 Markdown；不渲染链接 |
| 选项占位符 | 超长/换行/双向控制符 | trim、长度上限、清洗控制符；UI `overflow-wrap` |
| 伪造 option id | 提交 `optionId` 不在 schema | 服务端校验 `optionIds.has(value)`；拒绝并返回字段错误 |
| 类型混淆 | multi 传 string / single 传数组 | 服务端严格类型检查；拒绝 |
| 额外字段 | values 里塞 `__proto__`/`constructor` | 只遍历 question.fields；用 `Object.create(null)` 或显式字段构建；拒绝未知 key |
| 必填绕过 | 提交空字符串/空数组 | required 校验（trim 后非空；multi 长度 ≥1） |
| 重放 | 旧问题重复提交 | pending 条件更新；answered 返回 `changed:false` |
| 过期提交 | 客户端时间作弊 | 服务端用 ISO 时间比较；`E_EXPIRED` |
| 审批替换 | 用问题选项诱导“批准高风险操作” | 系统提示禁止；问题无执行副作用；审批仅来自 `risk:approval` |
| 秘密收集 | 问题要求输入 API Key | 系统提示禁止；P0 不做自动拦截（P1 敏感词）；用户可取消 |

### 8.5 IPC 信任边界

| 通道 | 主进程必须校验 |
|------|----------------|
| `chat:questions:list` | workspace 存在；agent 属于 workspace；limit 上限 200 |
| `chat:question:answer` | question 存在；workspace 匹配；status=pending；未过期；chat 不忙；answer 通过完整 schema 校验；序列化 ≤16KB |
| `chat:question:cancel` | question 存在；workspace 匹配；status=pending（answered → 幂等失败/已关闭） |
| `chat:artifacts:list` | workspace/agent 隔离；limit ≤200 |
| `chat:artifact:get` | artifact 存在；workspace 匹配；payload 读时再校验 |
| （现有）`chat:send` | 保持现有校验；回答消息内容由服务端生成的格式化文本，renderer 不能把隐藏结构化字段塞入 |

- preload **不做业务校验**，只做类型转发；避免“renderer 绕过 preload 直接 invoke”的误解（Electron contextIsolation 已开，Node 不可达）。
- 所有 SQL 使用参数化查询；查询条件必须带 `workspace_id`。
- 不新增 shell/fs 相关 IPC；导出完全在 renderer 内存中完成。

### 8.6 资源限制

| 资源 | 上限 | 超限行为 |
|------|------|----------|
| 单交互块原始文本 | 64 KiB | `E_TOO_LARGE`，不解析 |
| 节点/边/分组 | 80 / 240 / 12 | `E_SCHEMA`（zod max） |
| 标题/标签/备注/meta | 160/120/600/80 | `E_SCHEMA` |
| 问题字段/选项 | 6 / 12 | `E_SCHEMA` |
| 问题文本字段 | maxLength ≤4000 | schema 限制 + UI 计数 |
| 答案序列化 | 16 KiB | `E_TOO_LARGE` |
| 每条消息交互块 | ≤6（画布 ≤3、问题 ≤3） | `E_LIMIT`（超出块回退） |
| 每次列表查询 | artifacts 100 / questions 200 | 截断（不影响消息渲染） |
| 画布布局递归/遍历 | visited 集合；mindmap 深度 ≤4 显示；BFS/DFS 线性 | 超深折叠 + warning，不无限递归 |
| 导出尺寸 | 4096×4096 | 按比例缩小或拒绝 |
| 事件 payload | 复用 `limitPayload`（6000 字符） | 截断 |
| 倒计时定时器 | 1 个/打开的问题；关闭即清理 | 不使用全局轮询 |

- 无复杂正则回溯：ID 正则锚定、线性；标签清洗逐字符/简单 replace。
- 不用 `JSON.parse` 之外的解析器；不递归解析嵌套 JSON。

### 8.7 审计与隐私

**审计事件（`events` 表，append-only）**

| type | payload | 说明 |
|------|---------|------|
| `chat.artifact_ingested` | `{artifactId, kind, nodes, edges}` | 画布索引成功；不含内容 |
| `chat.question_created` | `{questionId, fieldCount, expiresAt}` | 不含问题标题/选项 |
| `chat.question_answered` | `{questionId, changed, fieldIds}` | **不含答案值** |
| `chat.question_cancelled` | `{questionId}` | — |
| `chat.question_expired` | `{questionId}` | — |
| `chat.interactive_invalid` | `{messageId, blockIndex, kind, code}` | 只记错误码 |
| `chat.interactive_ingest_failed` | `{messageId, code}` | 主进程异常兜底 |
| `chat.question_answer_failed`（P1） | `{questionId, code}` | 发送阶段失败 |

**隐私**

- 画布/问题/答案只保存在本地 SQLite（与对话相同），不新增网络请求。
- 答案会作为对话消息发给**当前配置的模型 provider**（用户已通过对话使用该 provider）；弹窗底部明确提示。
- 审计事件不记录答案值/问题标题，避免二次泄漏。
- 导出文件由用户主动触发，只写下载目录（浏览器/Electron 默认下载），不读取其他路径。
- P1 如需把画布/回答写入黑板/邮件，必须走显式用户动作与权限校验。

### 8.8 安全测试矩阵（自动化）

| 用例 | 断言 |
|------|------|
| 节点/标题含 `<img src=x onerror=alert(1)>` | SSR 输出无 `<img`；文本被转义 |
| 节点/选项含 `</script><script>alert(1)</script>` | 无 `<script>`；无事件属性 |
| 节点含 `<a href="javascript:...">` | 不产生链接 |
| 未知字段 `style/html/url/x/y` | `E_SCHEMA`；不渲染 |
| 超 64KB JSON | `E_TOO_LARGE`；不 `JSON.parse` 深层 |
| 重复 id/缺失端点/自环 | `E_SCHEMA`；整块回退 |
| 边数 241 / 节点 81 | 整块回退 |
| 问题选项 1 个/13 个/重复 id | `E_SCHEMA` |
| 提交非法 option id / 额外 key / 超长文本 | `ok:false` 字段错误；DB 不变 |
| 重复提交同一问题 | 第二次 `changed:false`，只产生一条答案消息 |
| 过期/取消后提交 | `E_EXPIRED`/`E_CLOSED`，DB 不变 |
| 其他 workspace 的 questionId | 拒绝，不泄漏标题 |
| Mermaid 标签含 `` ` ``、`]`、`-->`、换行 | 生成结果无法注入新指令/边；单测断言 |
| SVG 导出文本含 `</text><script>` | 输出已转义；无 script |
| 用户消息手打 `deer-canvas` | 不渲染画布（纯文本） |
| 流式中未闭合 fence | 预览不裸露 JSON；结束后回退 |
| 同一消息 7 个交互块 | 第 7 个 `E_LIMIT`，前面正常 |

---

## 9. 数据模型

### 9.1 共享类型（`src/shared/types.ts` 增量）

```ts
import type {
  DeerCanvas,
  DeerQuestion,
  QuestionAnswers,
  QuestionFieldError,
} from "./interactive.js";

export type CanvasKind = "mindmap" | "flowchart" | "roadmap" | "dependency";

export interface ChatArtifactRecord {
  /** 稳定键：`${messageId}#b${blockIndex}`（见 §9.2） */
  id: string;
  workspaceId: string;
  agentId: string;
  messageId: string;
  blockIndex: number;
  kind: CanvasKind;
  title: string;
  protocolVersion: number;
  payload: DeerCanvas;
  createdAt: string;
}

export type ChatQuestionStatus = "pending" | "answered" | "cancelled" | "expired";

export interface ChatQuestionRecord {
  /** 稳定键：`${messageId}#b${blockIndex}`（与 artifact 同规则，不同表） */
  id: string;
  workspaceId: string;
  agentId: string;
  messageId: string;
  blockIndex: number;
  title: string;
  payload: DeerQuestion;
  status: ChatQuestionStatus;
  answer: QuestionAnswers | null;
  createdAt: string;
  answeredAt: string | null;
  expiresAt: string | null;
}

export interface AnswerChatQuestionInput {
  workspaceId: string;
  questionId: string;
  values: Record<string, string | string[] | boolean>;
}

export type AnswerErrorCode =
  | "E_NOT_FOUND"
  | "E_WORKSPACE_MISMATCH"
  | "E_BUSY"
  | "E_INVALID_ANSWER"
  | "E_EXPIRED"
  | "E_CLOSED"
  | "E_TOO_LARGE";

export type AnswerChatQuestionResult =
  | { ok: true; changed: boolean; question: ChatQuestionRecord; answerText: string }
  | { ok: false; code: AnswerErrorCode; message: string; fieldErrors?: QuestionFieldError[] };

export interface CancelChatQuestionInput {
  workspaceId: string;
  questionId: string;
}

export type CancelChatQuestionResult =
  | { ok: true; question: ChatQuestionRecord }
  | { ok: false; code: AnswerErrorCode; message: string };
```

**稳定键规则**

```ts
export function chatBlockKey(messageId: string, blockIndex: number): string {
  return `${messageId}#b${blockIndex}`;
}
```

- `blockIndex` 是该消息内**交互块**的序号（仅 canvas/question，从 0 开始），不是行号；同一 content 的解析结果稳定。
- artifact 与 question 分表，键可相同；不把该键拼进 HTML id/URL；只作为数据键与 `data-key`（React 属性，不参与选择器时无需转义）。
- 模型给的 `id`（问题可选字段）**不是**系统 id；展示/引用时只作为文本。

### 9.2 SQLite 表（加入 `src/kernel/store.ts` 的 `SCHEMA`）

```sql
CREATE TABLE IF NOT EXISTS chat_artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  protocol_version INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(message_id, block_index)
);
CREATE INDEX IF NOT EXISTS idx_chat_artifacts_ws
  ON chat_artifacts(workspace_id, agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_artifacts_msg
  ON chat_artifacts(message_id);

CREATE TABLE IF NOT EXISTS chat_questions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  answer TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  expires_at TEXT,
  UNIQUE(message_id, block_index)
);
CREATE INDEX IF NOT EXISTS idx_chat_questions_ws
  ON chat_questions(workspace_id, agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_questions_status
  ON chat_questions(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_chat_questions_msg
  ON chat_questions(message_id);
```

说明：

- 现有 `SCHEMA` 每次启动执行 `CREATE TABLE IF NOT EXISTS`（`src/kernel/store.ts:36–176`）；新增表对存量数据库**无迁移风险**。
- 不需要改 `chat_messages` 表；不新增列，避免与 t53/t58 的列迁移逻辑纠缠。
- `UNIQUE(message_id, block_index)` 保证重复 ingest 幂等；`INSERT ... ON CONFLICT DO NOTHING`。
- `payload` 存**归一化后的 JSON**；读取时再 `JSON.parse` + schema 校验（DB 损坏不崩溃）。
- 任务/工作区删除目前不存在；“删除消息”功能也不存在，因此不需要级联清理。P2 如支持删除消息，需按 `message_id` 清理两张表。

### 9.3 Store 方法

```ts
// src/kernel/store.ts

saveCanvasArtifact(input: {
  id: string;
  workspaceId: string;
  agentId: string;
  messageId: string;
  blockIndex: number;
  kind: CanvasKind;
  title: string;
  protocolVersion: number;
  payload: DeerCanvas;
  createdAt: string;
}): void;

listCanvasArtifacts(workspaceId: string, agentId?: string, limit = 100): ChatArtifactRecord[];

getCanvasArtifact(workspaceId: string, artifactId: string): ChatArtifactRecord | null;

saveChatQuestion(input: {
  id: string;
  workspaceId: string;
  agentId: string;
  messageId: string;
  blockIndex: number;
  title: string;
  payload: DeerQuestion;
  createdAt: string;
  expiresAt: string | null;
}): ChatQuestionRecord;

listChatQuestions(workspaceId: string, agentId?: string, limit = 200): ChatQuestionRecord[];

getChatQuestion(questionId: string): ChatQuestionRecord | null;

/** 条件更新：仅 pending 且未过期才成功；返回是否发生变更。 */
answerChatQuestion(input: {
  questionId: string;
  answer: QuestionAnswers;
  answeredAt: string;
}): boolean;

/** 条件更新：仅 pending 才能取消；幂等。 */
cancelChatQuestion(input: {
  questionId: string;
  finishedAt: string; // 写入 answered_at，语义为“终态时间”
}): boolean;

/** 惰性过期：返回被标记的 id 列表（供服务写事件）。 */
expireChatQuestions(workspaceId: string, nowIso: string): string[];
```

**答案条件更新 SQL**

```sql
UPDATE chat_questions
   SET status = 'answered',
       answer = ?,
       answered_at = ?
 WHERE id = ?
   AND status = 'pending'
   AND (expires_at IS NULL OR expires_at > ?);
```

- `changes === 0` 时**不要**直接报错；服务层读回记录判断 answered/expired/cancelled，返回对应结果。
- 取消同理：`UPDATE ... SET status='cancelled', answered_at=? WHERE id=? AND status='pending'`。
- 过期：`UPDATE ... SET status='expired', answered_at=? WHERE workspace_id=? AND status='pending' AND expires_at IS NOT NULL AND expires_at <= ? RETURNING id`（`node:sqlite` 支持 `RETURNING`；若实现环境不支持，先 SELECT 再事务内 UPDATE）。

### 9.4 服务层与状态机

```ts
// src/kernel/service.ts 增量
ingestAssistantInteractive(
  workspaceId: string,
  agentId: string,
  message: ChatMessage,
): { artifacts: number; questions: number; errors: InteractiveError[] };

listChatQuestions(workspaceId: string, agentId?: string): ChatQuestionRecord[];
answerChatQuestion(input: AnswerChatQuestionInput): AnswerChatQuestionResult;
cancelChatQuestion(input: CancelChatQuestionInput): CancelChatQuestionResult;
listChatArtifacts(workspaceId: string, agentId?: string): ChatArtifactRecord[];
getChatArtifact(workspaceId: string, artifactId: string): ChatArtifactRecord | null;
```

**状态机（问题）**

| 当前 | 事件 | 目标 | 调用方 | 副作用 |
|------|------|------|--------|--------|
| pending | 用户提交且校验通过 | answered | `answerChatQuestion` | 写 answer/answeredAt；事件；返回 answerText |
| pending | 用户取消 | cancelled | `cancelChatQuestion` | 事件；不生成消息 |
| pending | 到达 expiresAt（list 时清算） | expired | `listChatQuestions`/`answer` 前置 | 事件；Modal 关闭（renderer 侧） |
| answered | 再次提交 | answered（`changed:false`） | `answerChatQuestion` | 返回既有答案，不重复发消息 |
| cancelled/expired | 提交 | 不变 | `answerChatQuestion` | 返回 `E_CLOSED`/`E_EXPIRED` |
| 任意 | 再次取消 | answered → `E_CLOSED`；cancelled → 幂等；expired → `E_EXPIRED` | `cancelChatQuestion` | — |

**状态机（画布）**：无状态变化；解析成功 = 可渲染；解析失败 = 回退。`chat_artifacts` 只有 ingest 时写入一次（幂等）。

**`answerChatQuestion` 伪代码**

```ts
answerChatQuestion(input) {
  const question = store.getChatQuestion(input.questionId);
  if (!question) return fail("E_NOT_FOUND", "问题不存在或已被清理");
  if (question.workspaceId !== input.workspaceId) return fail("E_WORKSPACE_MISMATCH", "问题不属于当前工作区");
  if (this.chatAborts.has(input.workspaceId)) return fail("E_BUSY", "Router 正在回复，请稍后再提交");

  const now = new Date().toISOString();
  if (question.status === "answered") {
    const answerText = formatQuestionAnswer(question.payload, question.answer!.values);
    return { ok: true, changed: false, question, answerText };
  }
  if (question.status === "cancelled") return fail("E_CLOSED", "该问题已取消");
  if (question.status === "expired") return fail("E_EXPIRED", "该问题已过期");
  if (question.expiresAt && question.expiresAt <= now) {
    store.expireChatQuestions(question.workspaceId, now); // 含当前问题；实现也可用单条条件更新
    appendEvent("chat.question_expired", { questionId: question.id });
    return fail("E_EXPIRED", "该问题已过期");
  }

  const validated = validateQuestionAnswers(question.payload, input.values);
  if (!validated.ok) return fail("E_INVALID_ANSWER", "回答未通过校验", validated.errors);

  const answer = { values: validated.values, answeredAt: now };
  const changed = store.answerChatQuestion({ questionId: question.id, answer, answeredAt: now });
  if (!changed) {
    const latest = store.getChatQuestion(question.id)!;
    if (latest.status === "answered") {
      appendEvent("chat.question_answered", { questionId: latest.id, changed: false, fieldIds: [] });
      return { ok: true, changed: false, question: latest, answerText: formatQuestionAnswer(latest.payload, latest.answer!.values) };
    }
    if (latest.status === "expired") return fail("E_EXPIRED", "...");
    return fail("E_CLOSED", "...");
  }
  const updated = store.getChatQuestion(question.id)!;
  const answerText = formatQuestionAnswer(updated.payload, validated.values);
  appendEvent("chat.question_answered", { questionId: updated.id, changed: true, fieldIds: Object.keys(validated.values) });
  return { ok: true, changed: true, question: updated, answerText };
}
```

- `E_BUSY` 在标记 answered **之前**检查；若用户绕过 UI，不会出现“答案已存但没发出”的状态。
- `changed:false` 也写一条 `chat.question_answered` 事件（payload `changed=false`），便于诊断重复点击/并发；**不**重复发送用户消息。
- 答案校验使用与服务端同一 `validateQuestionAnswers`（shared 模块），不信任 renderer。

**`ingestAssistantInteractive`**

1. `parseChatContent(message.content, { role: "assistant" })`。
2. 遍历交互块：`artifactId/questionId = chatBlockKey(message.id, blockIndex)`。
3. 画布：`ok` → `saveCanvasArtifact` + 事件；`!ok` → `chat.interactive_invalid`。
4. 问题：`ok` → `expiresAt = timeoutSec ? new Date(Date.parse(message.createdAt) + timeoutSec*1000).toISOString() : null`；`saveChatQuestion` + `chat.question_created`；`!ok` → 事件。
5. 幂等：`ON CONFLICT DO NOTHING`；重复 ingest 不重复事件（先查存在或依赖 changes 判断）。
6. 任何异常 catch → 写 `chat.interactive_ingest_failed`，不阻断 `sendChat` 的 `done`。

### 9.5 localStorage / 会话状态

| 键/状态 | P0 | P1 |
|---------|----|----|
| `deer.canvas.ui` | 不用（视口/折叠只在组件内存） | `{schema:"deer.canvas.ui",version:1,items:{[artifactId]:{scale,x,y,collapsed:string[],legendOpen:boolean,updatedAt}}}`，最多 100 条 LRU，超 64KB 拒绝保存；损坏删除回退 |
| `deferredIds` | React state（刷新丢失） | 可按 artifactKey 存 localStorage，TTL 会话级 |
| 问题草稿 | React state（App 持有，关闭弹窗不丢；刷新丢） | localStorage 可选（含敏感输入，默认不做，需用户主动开启） |
| 已展开的原始 JSON | 组件 state | 不持久化 |
| 画布导出历史 | 不持久化 | 不持久化 |

- 所有 localStorage 访问包 `try/catch`（隐私模式/配额）；不存答案/问题内容到 localStorage（P0）。
- 不把画布 JSON 写进 URL/hash；P1 Dock 面板也不新增 hash 参数（保持 `routeTab: null`）。

### 9.6 数据备份/迁移/清理

| 事项 | 策略 |
|------|------|
| 存量 DB | `CREATE TABLE IF NOT EXISTS` 自动建表；旧消息无 `deer-*` 块，行为不变 |
| 旧消息中的合法块 | 渲染层解析即可显示画布；**问题**在旧数据中不存在（功能上线前无提问），无需回填 |
| 回填 | P1 可加 `interactive:backfill`：对最近 N 条消息补建 artifact/question 记录；P0 不自动回填 |
| 记录上限 | `chat_artifacts`/`chat_questions` 只增不减；P2 增加清理策略（按消息删除/按时间） |
| 损坏 | 读取时 schema 校验失败 → 返回 null/跳过；UI 回退；不自动删除原始消息 |
| 隐私删除 | P2 提供“删除该消息的交互数据”（两张表按 message_id 删除） |

---

## 10. IPC / API

### 10.1 `DeerApi` 增量（`src/shared/ipc.ts`）

```ts
import type {
  AnswerChatQuestionInput,
  AnswerChatQuestionResult,
  CancelChatQuestionInput,
  CancelChatQuestionResult,
  ChatArtifactRecord,
  ChatQuestionRecord,
} from "./types.js";

export interface DeerApi {
  // ...现有方法保持不变...

  /** P0：画布索引（P1 Dock/导出使用；P0 渲染不依赖） */
  listChatArtifacts(workspaceId: string, agentId?: string): Promise<ChatArtifactRecord[]>;
  getChatArtifact(workspaceId: string, artifactId: string): Promise<ChatArtifactRecord | null>;

  /** P0：问题状态（含已回答/过期/取消，供内联卡片回显） */
  listChatQuestions(workspaceId: string, agentId?: string): Promise<ChatQuestionRecord[]>;
  answerChatQuestion(input: AnswerChatQuestionInput): Promise<AnswerChatQuestionResult>;
  cancelChatQuestion(input: CancelChatQuestionInput): Promise<CancelChatQuestionResult>;
}
```

### 10.2 IPC 通道（`electron/main.ts` + `electron/preload.ts`）

| 通道 | 主进程 handler | 入参 | 返回 |
|------|----------------|------|------|
| `chat:artifacts:list` | `getService().listChatArtifacts(...)` | `workspaceId, agentId?` | `ChatArtifactRecord[]` |
| `chat:artifact:get` | `getService().getChatArtifact(...)` | `workspaceId, artifactId` | `ChatArtifactRecord \| null` |
| `chat:questions:list` | `getService().listChatQuestions(...)` | `workspaceId, agentId?` | `ChatQuestionRecord[]` |
| `chat:question:answer` | `getService().answerChatQuestion(input)` | `AnswerChatQuestionInput` | `AnswerChatQuestionResult` |
| `chat:question:cancel` | `getService().cancelChatQuestion(input)` | `CancelChatQuestionInput` | `CancelChatQuestionResult` |

实现风格沿用现有 `handle(channel, fn)`（`electron/main.ts:54–62`）：异常统一抛出；`AnswerChatQuestionResult` 的预期业务失败**不抛异常**，以便 renderer 拿到字段错误；未预期异常仍由 `handle` 抛给 renderer。

preload：

```ts
listChatArtifacts: (workspaceId: string, agentId?: string) =>
  ipcRenderer.invoke("chat:artifacts:list", workspaceId, agentId),
getChatArtifact: (workspaceId: string, artifactId: string) =>
  ipcRenderer.invoke("chat:artifact:get", workspaceId, artifactId),
listChatQuestions: (workspaceId: string, agentId?: string) =>
  ipcRenderer.invoke("chat:questions:list", workspaceId, agentId),
answerChatQuestion: (input: AnswerChatQuestionInput) =>
  ipcRenderer.invoke("chat:question:answer", input),
cancelChatQuestion: (input: CancelChatQuestionInput) =>
  ipcRenderer.invoke("chat:question:cancel", input),
```

### 10.3 Renderer 调用序列（App）

```ts
// 1) 载入：消息与上下文并行；questions 单独失败不阻断消息渲染
const [messages, contextSnapshot] = await Promise.all([
  window.deer.listChat(workspaceId, router.id),
  window.deer.getContext(workspaceId, contextTaskId ? undefined : router.id, contextTaskId ?? undefined),
]);
let questions: ChatQuestionRecord[] = [];
try {
  questions = await window.deer.listChatQuestions(workspaceId, router.id);
} catch (error) {
  pushToast({ kind: "error", message: `问题状态加载失败：${formatError(error)}` });
}
setChatMessages(messages);
setContext(contextSnapshot);
setChatQuestions(questions);

// 2) 提交回答（先落库、后发消息；changed 才发）
async function handleAnswerQuestion(questionId: string, values: QuestionValues) {
  if (chatBusy) return; // UI 已禁用，双保险
  const result = await window.deer.answerChatQuestion({ workspaceId, questionId, values });
  if (!result.ok) {
    // 字段错误 → 表单内联；其余 → toast
    return result;
  }
  setChatQuestions((prev) => prev.map((q) => (q.id === questionId ? result.question : q)));
  if (result.changed) {
    setChatBusy(true);
    await window.deer.sendChat(workspaceId, result.answerText);
    // done / cancelled / error 事件会复位 busy 并 loadChat
  } else {
    pushToast({ kind: "info", message: "该问题已回答，未重复发送" });
  }
  return result;
}

// 3) 取消
await window.deer.cancelChatQuestion({ workspaceId, questionId });
// 重新 listChatQuestions 或本地替换返回记录
```

- 回答成功后**不复用** `chatInput`，避免污染用户草稿；直接 `sendChat` 格式化文本。
- `sendChat` 的事件流（`src/App.tsx:475–502`）已有 delta/reasoning/done/error/cancelled；无需新增 ChatEvent 类型。
- `done` 的处理器现有逻辑会 `loadChat()`；P0 在 `loadChat` 里同时刷新 questions，保证状态与服务端一致。
- 若回答发送失败：answers 已落库，卡片显示已回答；toast error 提供「重试发送」，重试前 `loadChat` 检查最后一条用户消息内容是否等于 answerText，避免重复消息。

### 10.4 错误码与用户文案

| code | 场景 | 用户文案（摘要） | 处理 |
|------|------|------------------|------|
| `E_NOT_FOUND` | questionId 不存在/已清理 | 问题不存在或已被清理 | toast error；刷新列表 |
| `E_WORKSPACE_MISMATCH` | 跨工作区 | 问题不属于当前工作区 | toast error；刷新 |
| `E_BUSY` | 提交时 Router 正在回复 | Router 正在回复，请稍后再提交 | 表单保留；按钮恢复 |
| `E_INVALID_ANSWER` | 服务端字段校验失败 | 回答未通过校验：<字段> | 字段内联错误 + 焦点 |
| `E_EXPIRED` | 已过期 | 该问题已过期，未提交 | 关闭弹窗；刷新；卡片过期 |
| `E_CLOSED` | 已取消/已回答后取消 | 该问题已结束 | 关闭；刷新 |
| `E_TOO_LARGE` | 答案/字段过大 | 回答内容过长，请精简 | 表单内联 |
| `E_JSON`/`E_SCHEMA`/... | 画布/问题解析失败 | 回退卡片内展示 | 不弹 toast（除非用户点“复制”失败） |

- 所有业务失败都用返回值表达，不用异常字符串解析；`formatError` 只用于未预期 IPC 异常。
- UI 不显示 SQL/路径/堆栈。

### 10.5 事件（复用 `events` + `app:event`）

| type | 触发 | payload |
|------|------|---------|
| `chat.artifact_ingested` | ingest 合法画布 | `{artifactId, kind, nodes, edges}` |
| `chat.question_created` | ingest 合法问题 | `{questionId, fieldCount, expiresAt}` |
| `chat.question_answered` | 提交成功/重复提交 | `{questionId, changed, fieldIds}` |
| `chat.question_cancelled` | 取消 | `{questionId}` |
| `chat.question_expired` | 惰性过期 | `{questionId}` |
| `chat.interactive_invalid` | 块校验失败 | `{messageId, blockIndex, kind, code}` |
| `chat.interactive_ingest_failed` | ingest 未预期异常 | `{messageId, code}` |

- **不新增 renderer 事件通道**；renderer 的状态来源是 `chat:send` 的 `done` + `listChatQuestions` 调用，事件仅用于审计/调试。
- 现有 App 的 `onEvent` 会触发 snapshot refresh（`src/App.tsx:398–410`）；这些事件频率低（每条消息 ≤6），可接受；实现时可在 refresh 回调里忽略 `chat.*` 事件，减少无意义的快照刷新（P0 可选优化）。
- 事件 payload 会被 `limitPayload` 截断（`src/kernel/service.ts:104–108`），不存原始内容。

### 10.6 兼容性与回滚

| 项 | 策略 |
|----|------|
| 旧 IPC | 只新增，不改现有方法/返回结构；renderer 旧逻辑不受影响 |
| 旧 DB | 新表 `IF NOT EXISTS`；不修改旧表；旧消息无块 → 原样 |
| 旧 renderer/新 main | 不会出现（同一打包）；开发 HMR 下旧 renderer 调用新 API 不存在也不会崩（未调用） |
| 新 renderer/旧 main | 同一打包；如需防御，`ChatView` 在 `window.deer.listChatQuestions` 不存在时可降级为纯 Markdown（可选） |
| 回滚 | 移除 renderer 解析与提问 UI 后，消息内容仍是普通文本；DB 新表无副作用；无需数据迁移 |
| 日志 | 不打印画布/问题原文（可能敏感）；只打印错误码/计数 |
| 包体 | 新增 zod 到 renderer 共享路径，预计 +10–20KB gzip（现有 bundle 约 486KB / gzip 146KB）；可接受，仍不新增依赖 |

---
## 11. 组件与代码落位

### 11.1 新增/修改文件树

```
src/
├─ shared/
│  ├─ interactive.ts          ★新增：schema/类型/解析/校验/清洗/压缩/答案格式化/稳定键/系统提示常量
│  ├─ interactive.test.ts     ★新增：协议与安全单测
│  ├─ types.ts                ✎修改：ChatArtifactRecord/ChatQuestionRecord/Answer 结果类型
│  └─ ipc.ts                  ✎修改：DeerApi 5 个新方法
├─ canvas/
│  ├─ layout.ts               ★新增：四类图确定性布局（纯函数）
│  ├─ layout.test.ts          ★新增
│  ├─ export.ts               ★新增：Mermaid/SVG/主题快照/下载工具（纯函数 + 浏览器 API 薄封装）
│  ├─ export.test.ts          ★新增
│  ├─ CanvasArtifact.tsx      ★新增：画布视口（缩放/平移/节点/浮窗/聚焦/折叠）
│  ├─ CanvasCard.tsx          ★新增：对话内卡片（header/footer/放大/导出/原始数据）
│  ├─ CanvasFallback.tsx      ★新增：非法块回退卡片
│  └─ CanvasArtifact.test.tsx ★新增：SSR 结构与安全断言
├─ interactive/
│  ├─ QuestionCard.tsx        ★新增：对话内问题卡片（状态/答案摘要）
│  ├─ QuestionCard.test.tsx   ★新增：卡片四状态 SSR 断言
│  ├─ QuestionModal.tsx       ★新增：原生表单弹窗（四类字段）
│  ├─ QuestionFallback.tsx    ★新增：非法提问回退
│  └─ QuestionModal.test.tsx  ★新增：SSR 字段/ARIA 断言
├─ ChatContent.tsx            ★新增：按 block 切分 Markdown/画布/提问
├─ ChatContent.test.tsx       ★新增
├─ Markdown.tsx               ✎不改（保持 skipHtml；文本段继续复用）
├─ Modal.tsx                  ✎修改：新增可选 initialFocusRef（向后兼容）
├─ Toast.tsx                  ✎修改：新增 info kind（role=status）
├─ App.tsx                    ✎修改：ChatView/ChatBubble 接入；问题队列/弹窗/回答/自动打开
├─ styles.css                 ✎修改：画布/问题/信息 toast/响应式样式（只用 token）
└─ kernel/
   ├─ store.ts                ✎修改：新增两张表 + 9 个方法
   ├─ service.ts              ✎修改：ingest、问题 API、系统提示、历史压缩、getContext
   ├─ model.ts                ✎修改（可选但推荐）：Mock 模式画布/提问触发，便于离线演示与手工验收
   └─ interactive.test.ts     ★新增：ingest/回答/取消/过期/隔离测试

electron/
├─ main.ts                    ✎修改：5 个 IPC handler
└─ preload.ts                 ✎修改：5 个 DeerApi 方法

docs/team/
├─ interactive-canvas-design.md          ★本文件（t63）
└─ interactive-canvas-implementation.md  ★t64 产出（协议/组件/测试/验收映射）
```

**不改**：`src/TaskStarMap.tsx`、`src/TeamDashboard.tsx`、`src/shell/dock/panelRegistry.ts`、`src/shell/dock/DockShell.tsx`、`src/shared/deeplink.ts`、`electron/main.ts` 的窗口/权限配置、`package.json` 依赖列表。

### 11.2 组件契约

```tsx
// src/ChatContent.tsx
export default function ChatContent(props: {
  role: ChatRole;
  content: string;
  messageId?: string;
  streaming?: boolean;
  /** 按 chatBlockKey 索引的问题状态；来自 App 的 listChatQuestions */
  questions?: ReadonlyMap<string, ChatQuestionRecord>;
  /** false=状态尚未加载（显示 loading）；true=已加载（缺失记录按 E_NOT_PERSISTED 回退） */
  questionsLoaded?: boolean;
  /** 用户点击「回答问题」；App 负责打开 Modal */
  onAnswerQuestion?: (questionId: string) => void;
}): ReactElement;

// src/canvas/CanvasCard.tsx
export default function CanvasCard(props: {
  artifactKey: string;
  artifact: DeerCanvas;
}): ReactElement;

// src/canvas/CanvasArtifact.tsx
export default function CanvasArtifact(props: {
  artifact: DeerCanvas;
  /** 视口初始高度（CSS 可覆盖） */
  height?: number;
  /** 是否显示 header 工具条（画布面板 P1 可传 false） */
  showToolbar?: boolean;
  /** 供 P1 Dock 面板复用的外部视口状态键 */
  viewKey?: string;
}): ReactElement;

// src/canvas/CanvasFallback.tsx
export default function CanvasFallback(props: {
  raw: string;
  error: InteractiveError;
}): ReactElement;

// src/interactive/QuestionCard.tsx
export default function QuestionCard(props: {
  questionId: string;
  question: DeerQuestion;
  record?: ChatQuestionRecord;     // 未加载时显示「状态加载中」并禁用
  questionsLoaded?: boolean;       // true 且 record 缺失 → E_NOT_PERSISTED 回退
  onOpen: (questionId: string) => void;
}): ReactElement;

// src/interactive/QuestionModal.tsx
export default function QuestionModal(props: {
  question: ChatQuestionRecord;
  index: number;
  total: number;
  busy: boolean;
  initialValues?: QuestionValues;
  onDraftChange?: (values: QuestionValues) => void;
  /** 返回 false 表示失败并保持打开；字段错误由组件内联展示 */
  onSubmit: (values: QuestionValues) => Promise<{ ok: true } | { ok: false; fieldErrors?: QuestionFieldError[]; message?: string }>;
  onDefer: () => void;
  onCancel: () => Promise<void>;
  onExpire?: () => void;
}): ReactElement;
```

- `CanvasCard` 与 `CanvasArtifact` 不访问 `window.deer`；纯展示/交互，导出在 `export.ts`。
- `QuestionModal` 不直接调用 IPC；由 App 注入 `onSubmit`，便于测试与错误处理。
- 所有组件不读取 `localStorage`（P1 视图状态除外，且必须 try/catch）。
- 返回类型写成 `ReactElement`（React 19 下比全局 `JSX.Element` 稳）；实现时也可直接省略返回类型。

### 11.3 现有文件改动点（精确到行为，不要求行号不变）

| 文件 | 现状 | 改动 |
|------|------|------|
| `src/App.tsx` `ChatView` | messages/stream/busy/input 等 props | 新增 `questions`、`onAnswerQuestion`、`pendingQuestionCount`、`onOpenFirstQuestion`；消息渲染改用 `ChatContent`；头部加「待回答 N」chip |
| `src/App.tsx` `ChatBubble` | assistant → `<Markdown>` | assistant → `<ChatContent>`；user/system 保持纯文本；reasoning 不变 |
| `src/App.tsx` App state（chat 状态区） | chat 状态 | 新增 `chatQuestions`、`questionModalId`、`questionDrafts`、`deferredQuestionIds`、`autoOpenedQuestionIds`；workspace 切换/`resetForWorkspace` 清理 |
| `src/App.tsx` `loadChat` | messages + context | 并行增加 `listChatQuestions`；questions 单独失败不阻断消息渲染（单独 catch + toast） |
| `src/App.tsx` 事件处理（`onChatEvent`） | done/error 重载 | done 后 `loadChat` 已包含 questions；新增回答提交/取消/自动打开 effect；`riskApproval` 出现时收起问题弹窗 |
| `src/App.tsx` 根渲染（ToastHost 前） | ToastHost | ToastHost 之前渲染 `QuestionModal`（`riskApproval` 为空时才渲染） |
| `src/Modal.tsx` | 聚焦第一个可聚焦元素 | 新增 `initialFocusRef?: RefObject<HTMLElement|null>`；若提供则优先聚焦；默认行为不变 |
| `src/Toast.tsx` | kind: success/error | 增加 `info`；role=status；CSS `.toast-info` |
| `src/styles.css` | 深色 token / 星图 / dock | 追加 `.canvas-*`、`.question-*`、`.toast-info`、窄窗规则；新增 canvas token 别名；不覆盖现有选择器 |
| `src/kernel/store.ts` | SCHEMA + chat 方法 | 追加两张表与 9 个方法；`toChatArtifact/toChatQuestion` 行映射；损坏 payload 跳过/回退 |
| `src/kernel/service.ts` | sendChat / system prompt / getContext | ① 系统提示追加 `INTERACTIVE_PROMPT_V1`；② assistant 消息保存后 `ingestAssistantInteractive`（catch 不阻断 done）；③ 历史映射用 `compressInteractiveForModel` + 最近画布摘要；④ `getContext` 增加 interactive 段；⑤ 新增问题 API |
| `src/kernel/model.ts` | Mock 固定回复 | （推荐）Router 回复检测「画布/流程/路线图/依赖图/问我/确认」返回固定合法画布/问题，供离线手工验收；不改变真实模型路径 |
| `src/shared/types.ts` | ChatMessage/ChatEvent | 只追加类型；不改现有字段（避免 DB/IPC 迁移） |
| `src/shared/ipc.ts` / `electron/preload.ts` / `electron/main.ts` | 现有 API | 只追加 5 个方法与通道；不改现有通道签名 |
| `src/Markdown.tsx` | `skipHtml` | **不动**；新增解析在 `ChatContent` 中，文本段继续复用 |
| `src/shell/dock/*` | 面板注册表 | **P0 不动**；P1 才新增 `canvas` 面板 |

### 11.4 CSS 类与样式约定

**画布**

`.chat-content`（块容器）、`.canvas-card`、`.canvas-head`、`.canvas-badge`、`.canvas-title`、`.canvas-sub`、`.canvas-toolbar`、`.canvas-tool`、`.canvas-viewport`、`.canvas-world`、`.canvas-edges`、`.canvas-node`、`.canvas-node-shape`、`.canvas-node-label`、`.canvas-node-meta`、`.canvas-status-mark`、`.canvas-detail`、`.canvas-detail-head`、`.canvas-detail-actions`、`.canvas-legend`、`.canvas-legend-body`、`.canvas-footer`、`.canvas-collapsed-note`、`.canvas-focusbar`、`.canvas-readout`、`.canvas-hint`、`.canvas-menu`、`.canvas-fallback`、`.canvas-empty`。

**提问**

`.question-card`、`.question-card-head`、`.question-card-title`、`.question-card-desc`、`.question-card-meta`、`.question-card-actions`、`.question-card-answers`、`.question-modal`、`.question-modal-head`、`.question-field`、`.question-options`、`.question-option`、`.question-option-desc`、`.question-count`、`.question-error`、`.question-error-summary`、`.question-foot`、`.question-privacy`、`.question-queue`、`.question-timeout`、`.question-danger`、`.question-confirm`。

**复用现有类**：`primary`/`ghost`/`small`/`tiny`/`chip`/`badge`/`panel-title`/`muted`/`mono`/`ellipsis`/`sr-only`/`modal*`/`toast*`。

**约定**

- 不新增颜色字面量；所有颜色来自 `var(--...)` 或 `color-mix`。
- 不在 JSX 中写 `style={{ color }}`；坐标 transform 用 `style` 是允许的（`translate/scale` 值只来自布局/视口，不来自模型）。
- `data-width="compact|regular|wide"` 由 ResizeObserver 设置；CSS 用属性选择器。
- `@media (prefers-reduced-motion: reduce)` 中禁用画布/卡片/弹窗过渡与倒计时动画。
- 新增样式放 `styles.css` 末尾独立分区，避免影响星图/dock 现有规则。

### 11.5 实现顺序建议（t64）

1. **协议层**（`src/shared/interactive.ts` + 测试）：类型、schema、parser、清洗、答案格式化、压缩、key、prompt 常量。
2. **存储/服务层**（`store.ts` + `service.ts` + 测试）：两张表、ingest、list/answer/cancel/expire、系统提示、历史压缩、getContext。
3. **IPC 层**（types/ipc/preload/main）：5 个通道 + 返回类型 + 错误映射。
4. **布局/导出**（`canvas/layout.ts` + `export.ts` + 测试）：先纯函数，保证确定性/安全。
5. **画布渲染**（`CanvasArtifact.tsx` + `CanvasCard.tsx` + `CanvasFallback.tsx` + SSR 测试）：四类图、交互、详情、折叠、图例。
6. **对话接入**（`ChatContent.tsx` + `ChatBubble` + streaming + 测试）：文本段/Markdown 不变。
7. **提问 UI**（`QuestionCard/Modal/Fallback` + App 队列/自动打开/回答/取消/超时 + 测试）。
8. **系统提示与 Mock 触发**（`model.ts`）：离线可演示；真模型验证。
9. **样式/窄窗/可达性**（`styles.css`、`:focus-visible`、reduced-motion、container width）。
10. **安全/性能/文档/PR**：grep 禁止 API、跑三命令、写 `interactive-canvas-implementation.md`、PR。

> 每一步均可独立 typecheck；建议 1–3 先合入同一分支，4–7 再接 UI，避免大量半成品同时存在。

---

## 12. 分阶段计划（P0 / P1 / P2）

### 12.1 P0（t64 必须，全部为验收项）

| # | 交付 | 关键实现 | 估时 |
|---|------|----------|------|
| P0-1 | 协议层 | `interactive.ts`：两套 schema、parser、fence 扫描、错误码、清洗、归一化、答案校验/格式化、历史压缩、稳定键、prompt 常量 | 0.8–1.0d |
| P0-2 | 持久化 | `chat_artifacts`/`chat_questions` 表 + Store 方法 + 幂等/条件更新 | 0.4d |
| P0-3 | 服务层 | ingest、list/answer/cancel/expire、系统提示、历史压缩、getContext 段 | 0.6–0.8d |
| P0-4 | IPC | types/ipc/preload/main 5 通道 + 错误/结果类型 | 0.3d |
| P0-5 | 布局 | 四类图确定性布局、bounds/fit、环/折叠处理 | 0.8–1.0d |
| P0-6 | 画布 UI | 视口/节点/边/详情/聚焦/折叠/图例/工具条/回退/SSR 安全 | 1.2–1.6d |
| P0-7 | 导出 | Mermaid（复制/下载）+ SVG（下载）+ 清洗 + 主题快照 | 0.4–0.6d |
| P0-8 | 对话接入 | `ChatContent` 切分、streaming 剥离、`ChatBubble` 改造 | 0.3d |
| P0-9 | 提问 UI | 卡片/Modal/队列/草稿/自动打开/超时/取消/防重复 | 1.0–1.3d |
| P0-10 | 系统提示/Mock | prompt 注入、历史压缩、Mock 触发、真模型验证 | 0.3d |
| P0-11 | 样式/可达性 | 全部 UI、窄窗、focus、ARIA、reduced-motion、手工清单 | 0.6–0.8d |
| P0-12 | 测试/文档/PR | 单测/SSR/手工、三命令、实现文档、worktree/PR | 0.8–1.0d |
| **合计** | | | **约 7.5–10.5 人日（1 人）** |

**P0 明确不做**：Dock 画布面板、PNG 导出、工具调用、自动修复重试、渐进流式渲染、节点关联跳转、问题草稿持久化、列表视图。

### 12.2 P1（下一轮）

1. **Dock「画布」面板**（§4.7）：注册表 + 活动 artifact + 命令面板 + 布局恢复 + `getChatArtifact` 兜底。
2. **PNG 导出**（SVG→canvas）+ 导出文件名/尺寸选项；导出到黑板/邮件（带引用与权限）。
3. **工具调用通道**：`render_canvas` / `ask_user`（§5.10）；工具结果回放与限流。
4. **自动修复重试**：回退卡片「让模型修复」→ 带错误码重发；最多 1 次。
5. **渐进式流式渲染**：完整块一出现即渲染（需处理 viewport/fit 稳定性）。
6. **节点关联**：`refs.taskId/messageId/board` 校验存在后可点击跳转（联动 C12/C14）。
7. **问题草稿持久化**与「已回答修改并重发」（新消息 + changed 语义扩展）。
8. **取消时通知模型**：追加一条系统/用户提示。
9. **列表视图**（画布等价替代）与屏幕阅读器摘要增强。
10. **CSP/安全加固**：Electron 会话 CSP、`sandbox` 评估、导出白名单独立审计。

### 12.3 P2（更长期）

- 节点拖拽/固定/自动布局混合（对齐星图 S13 未采纳项）。
- 批注/评论/变更历史；多人协作。
- 条件字段/多步向导/表单模板；评分/排序/日期/文件字段（需新安全评估）。
- Mermaid 导入、模板库、画布版本 diff。
- 能力层/插件目录（与 C22/S16 对齐）。
- 大图 canvas 渲染降级（>150 节点）。
- 用户自定义主题/高对比模式。

### 12.4 依赖与并行建议

- P0-1 是 P0-2/4/5/9 的硬前置；P0-2/3/4 可与 P0-5（布局）并行。
- P0-6 依赖 P0-1/5；P0-9 依赖 P0-1/3/4；P0-8 依赖 P0-1/6/9。
- 与现有 t60（权限集成）无代码依赖；不要在本任务中改权限/审批逻辑。
- 按 `AGENTS.md §8`：t64 必须 `pnpm branch:start t64 interactive-canvas` 在 `branches/t64-interactive-canvas/` worktree 内开发，完成后 PR，不直接推 main；本设计任务（t63）只写 `docs/team/`，不改代码。

---

## 13. 验收标准与测试策略

### 13.1 验收标准（AC）

> 口径：P0 全部 AC 必须通过；标注“人工”的由 t65 评审/t66 集成按清单复核；标注“单测/SSR”的必须有自动化断言。AC 编号供 t64/t65/t66 直接引用。

| AC | 验收句 | 验证方式 | 关联 |
|----|--------|----------|------|
| AC-01 | 合法的 `deer-canvas`/`deer-question` fence 被切分为结构化块；其他代码块保持 Markdown 行为 | 单测（parser）+ 现有 Markdown 测试 | §5.2 |
| AC-02 | 四类画布（mindmap/flowchart/roadmap/dependency）均能以节点、边、分组、状态色渲染 | 单测（布局）+ SSR（节点数量/标签/状态类）+ 人工四夹具 | §4.1/4.4 |
| AC-03 | 7 种状态映射到 `--status-*` token，且有状态标记/图例，颜色不是唯一通道 | SSR/样式断言 + 人工灰度截图 | §4.2/4.3 |
| AC-04 | 滚轮缩放（指针锚点）、拖空白平移、fit、`+/-/0`、方向键均可用；缩放不重置选中 | 单测（fit/math）+ 人工 | §4.5 |
| AC-05 | 单击节点先选中、250ms 后详情；双击不闪出详情而进入 1 跳聚焦；Enter/Ctrl+Enter 等价；空白/Esc 关闭 | 纯函数状态机单测 + 人工 | §4.5/7.8 |
| AC-06 | 分组折叠/展开、思维导图分支折叠可用；折叠不改变 JSON、报隐藏节点数 | 单测（可见集合/布局）+ 人工 | §4.5 |
| AC-07 | 非法 JSON/schema/超限/版本过新/未闭合 → 整块回退卡片 + 原始文本可复制；其余文本正常渲染，无半张图 | 单测（每个错误码）+ SSR + 人工 | §4.9/5.6/5.7 |
| AC-08 | 节点/边/分组/选项/导出中不能执行 HTML/JS；无 `dangerouslySetInnerHTML`/`eval`/`new Function` | SSR 安全测试 + 源码 grep + 人工 | §8 |
| AC-09 | 提问弹窗支持单选/多选/自由文本/确认；必填、选项、min/max、maxLength 校验生效 | 单测（答案校验）+ SSR（字段/ARIA）+ 人工 | §6 |
| AC-10 | 提交回答后：问题状态变 answered；生成一条 `[回答表单]` 用户消息；模型下一轮可见；刷新后仍在 | 服务测试 + 人工 | §6.5 |
| AC-11 | 队列（多个问题按序）、稍后、取消（二次确认）、超时（可选）、过期清算是可用的 | 服务测试（过期/取消）+ 人工 | §6.3/6.4 |
| AC-12 | 重复提交/双击提交只产生一次答案与一条消息；重复请求返回 changed=false | 服务测试 + 状态机单测 + 人工 | §6.6 |
| AC-13 | 纯键盘完成：画布节点→详情→Esc→表单→提交；无鼠标可用 | 人工清单 | §7.10 |
| AC-14 | 画布/问题具备正确 role/aria-label/aria-live/focus 管理；错误 role=alert；焦点不丢 | SSR 断言 + 人工读屏/键盘 | §4.5/6.7/7.10 |
| AC-15 | 960/1100/1440 窗口与 `chat` 面板 420/520/760 宽度下无横向溢出、按钮可达、表单可用；200% 缩放可用 | 人工清单 | §7.7 |
| AC-16 | 刷新、切换对话上下文、切换工作区后：画布可从消息恢复；问题状态/答案可恢复；无跨工作区串数据 | 服务测试 + 人工 | §4.9/9.5 |
| AC-17 | Toast 集成：导出成功/失败、回答提交、新问题提示、发送失败重试；不刷屏；aria-live 正确 | SSR/组件断言 + 人工 | §7.4 |
| AC-18 | Markdown 现有行为不回退：标题/列表/表格/代码块正常，raw HTML 仍被丢弃；画布块不进入 Markdown | 现有 `Markdown.test.tsx` + 新 `ChatContent` 测试 | §7.2 |
| AC-19 | Modal 基线不回退：Esc/焦点陷阱/回焦/滚动锁/aria-modal 正常；问题弹窗对齐首个字段；风险审批期间不叠加弹窗 | 现有测试/人工 + 代码 review | §7.3 |
| AC-20 | 导出 Mermaid/SVG 可下载/复制；标签/文件名无注入、无路径穿越；P1 PNG 不在 P0 验收 | 单测（生成/清洗/白名单）+ 人工打开文件 | §4.8 |
| AC-21 | 全部画布/问题样式只使用主题 token；无硬编码颜色/尺寸来源模型 | 代码 grep + 人工 | §7.6 |
| AC-22 | 80 节点画布的 pan/zoom 保持在可交互帧率（人工观察 ≥30fps 即可，不阻断）；平移/缩放不重新计算布局 | 人工 + React memo 代码 review | §4.4 |
| AC-23 | 审计事件记录 ingest/问题生命周期/非法块；不记录答案值；事件不阻断对话 | 服务测试 | §8.7 |
| AC-24 | Mock 模式可稳定产出画布/提问夹具，离线可手工验收 | 人工（mock） | §11.3 |
| AC-25 | `pnpm typecheck`、`pnpm build`、`pnpm test` 全部通过；不新增依赖 | 命令 | §13.4 |
| AC-26 | `docs/team/interactive-canvas-implementation.md` 记录协议、组件、测试、AC 映射与遗留 | 文档评审 | t64 |
| AC-27 | 未支持的协议版本/未知字段整块回退，不尝试“猜”渲染 | 单测 | §5.11 |
| AC-28 | 服务端拒绝篡改的答案（选项/类型/必填/额外 key/超长），renderer 校验只是体验层 | 服务测试 | §8.4 |
| AC-29 | 跨 workspace 读取/回答问题被拒绝；列表按 workspace+agent 隔离 | 服务测试 | §8.5 |
| AC-30 | 用户消息里手打 `deer-canvas`/`deer-question` 不被渲染为画布/表单 | SSR/单测 + 人工 | §5.2/7.1 |
| AC-31 | 流式期间不裸露半截 JSON；显示“正在生成…”；结束后未闭合回退 `E_UNCLOSED` | 单测（strip）+ 人工 | §7.1 |
| AC-32 | 问题卡片正确显示 pending/answered/expired/cancelled 与答案摘要；非法提问不可答 | SSR + 人工 | §6.2 |
| AC-33 | 不引入第三方图布局/导出/表单库；deps 不变 | `package.json` diff + review | §5.3 |
| AC-34 | 旧消息/旧 DB 无回归；新增两张表通过 `CREATE TABLE IF NOT EXISTS` 自动建立，旧数据可继续打开对话 | 服务测试（旧库打开）+ review | §9.6/§10.6 |
| AC-35 | reduced-motion 下无画布/弹窗过渡、无倒计时动画；状态仍可读 | 人工（系统设置） | §7.10 |
| AC-36 | 画布/问题文本经过清洗（控制字符/双向控制符），超长文本不撑破布局 | 单测 + 人工 | §8.3 |

### 13.2 t64 契约验收映射

| t64 acceptance | 对应设计 | P0 AC |
|----------------|----------|-------|
| ChatView 渲染合法 deer-canvas，支持四类图、节点/边/分组/状态色 | §4.1–4.6、§7.1 | AC-02、AC-03、AC-18 |
| 缩放/平移/fit、节点点击详情；非法/危险回退；不执行 HTML/JS | §4.5、§4.9、§8、§5.7 | AC-04、AC-05、AC-07、AC-08 |
| 提问弹窗四类字段、回答回流对话与模型上下文；取消/超时/防重复 | §6 | AC-09、AC-10、AC-11、AC-12、AC-28 |
| 刷新/切换对话后恢复；与 Dock/Markdown/Modal/Toast/token 集成 | §4.9、§7.2–7.6 | AC-16、AC-17、AC-18、AC-19、AC-21 |
| 键盘/ARIA/窄窗可用；schema 校验与安全测试 | §7.7、§7.10、§8.8、§13.3 | AC-08、AC-13、AC-14、AC-15、AC-28、AC-36 |
| AGENTS §8 worktree + PR、不改 main | §12.4 | 流程检查（t66） |
| typecheck/build/test 通过 | §13.4 | AC-25 |
| `docs/team/interactive-canvas-implementation.md` | §11.1、AC-26 | AC-26 |

### 13.3 测试策略

**分层**

| 层 | 工具/方式 | 覆盖 |
|----|-----------|------|
| 纯函数单测 | vitest（现有） | parser、schema、清洗、布局确定性、导出清洗、答案校验/格式化、压缩、状态机 |
| SSR 渲染测试 | `renderToStaticMarkup`（现有 Markdown 测试模式） | 画布节点/状态类/无脚本/文本转义；表单字段/ARIA；回退卡片；ChatContent 分段；不引入 jsdom |
| 主进程/存储测试 | vitest + `AppService`/`Store` 临时目录（现有 `service.test.ts`/`approval.test.ts` 模式） | ingest 幂等、问题状态机、过期、取消、工作区隔离、事件、chat 历史压缩 |
| 手工 QA | 真实 Electron + mock/真实模型 | 交互、窄窗、键盘、读屏、导出、流畅度、刷新恢复 |
| 静态检查 | grep/代码 review | 禁止 API、无硬编码颜色、无新依赖 |

**新增测试文件与用例（建议 ≥45 条）**

`src/shared/interactive.test.ts`（约 24）

1. 识别 `deer-canvas` / `deer-question` fence；其他 fence 不动。
2. 大小写/前后空白/CRLF/BOM；带额外 info 的 fence 不识别。
3. 未闭合（complete/streaming）行为。
4. 多个块 + blockIndex 稳定。
5. 超过 6 块 → E_LIMIT；第 7 块回退。
6. 坏 JSON → E_JSON。
7. protocol 不匹配 → E_PROTOCOL；version 2 → E_VERSION。
8. 未知字段 `style` → E_SCHEMA。
9. 节点 id 重复/缺失端点/自环 → E_SCHEMA。
10. 分组引用不存在 → E_SCHEMA。
11. 节点 81/边 241 → E_SCHEMA。
12. 64KB+ → E_TOO_LARGE。
13. 重复边去重 + warning；环 warning。
14. mindmap 无根/多根 warning。
15. 文本清洗：控制字符/双向控制符/超长。
16. `<img onerror>` 标签保留为文本（转义由渲染层做）。
17. 单选/多选/文本/确认字段解析。
18. 字段 id 重复、选项 id 重复、multi min>max → E_SCHEMA。
19. 答案校验：必填、类型、选项 id、min/max、maxLength、额外 key。
20. 答案格式化（四类字段、多行文本、空文本）。
21. `chatBlockKey` 稳定。
22. 压缩：合法/非法/未闭合块 → 摘要素；文本保留。
23. 流式 strip：去掉 fence，返回 pending 类型。
24. prompt 常量版本存在且包含两种协议。

`src/canvas/layout.test.ts`（约 10）

1. 同输入两次坐标完全一致（四类图各一）。
2. flowchart TB/LR 分层方向正确。
3. dependency 环终止、回边标记、坐标有限。
4. mindmap 深度/根/子节点数正确；无随机。
5. roadmap 泳道顺序、未分组泳道、x 递增。
6. 折叠分组后可见集合/边减少，节点坐标不因折叠重排其余泳道。
7. bounds 包含所有可见节点。
8. fitView 居中/比例 clamp。
9. 80 节点性能 smoke（不设严格阈值，<100ms 断言可选）。
10. 空/单节点边界。

`src/canvas/export.test.ts`（约 8）

1. 四类图 Mermaid 关键字/节点形状正确。
2. mindmap 非树 → 降级 flowchart + warning。
3. 标签清洗：引号/反引号/`]`/`-->`/换行/超长。
4. 生成结果通过白名单行检查；含 `click`/`style` → 拒绝。
5. SVG 文本转义 `& < > " '`；无 `<script>`/`foreignObject`/外部 URL。
6. SVG 尺寸/背景/节点数正确。
7. slug 文件名：中文/空格/路径分隔符/控制字符/超长。
8. 主题快照 fallback 不崩溃。

`src/kernel/interactive.test.ts`（约 14）

1. ingest 合法消息 → artifact + question 记录；计数正确。
2. 重复 ingest 幂等（记录数不变、事件不重复）。
3. 非法块 → 事件 + 不落库。
4. `sendChat` ingest 失败不阻断 done（mock/stub）。
5. 问题 created 时 `expiresAt` 计算。
6. answer 成功 → answered、answerText、事件。
7. 重复 answer → changed=false、answerText 一致、无第二条消息。
8. 过期 answer → E_EXPIRED、DB 不变。
9. cancel → cancelled；再次 cancel 幂等；answer 后 cancel → E_CLOSED。
10. 跨 workspace answer/list → 拒绝/隔离。
11. chatBusy 时 answer → E_BUSY。
12. list 惰性过期 → 状态与事件。
13. 答案篡改（非法选项/额外 key/超长）→ E_INVALID_ANSWER。
14. 历史压缩函数在 `sendChat` 使用时不影响用户原文（可测 helper 调用）。

`src/canvas/CanvasArtifact.test.tsx`（约 4）

1. 四类图 SSR 包含节点数/标签/状态类。
2. 恶意标签被转义，无 `<img`/`<script>`/事件属性。
3. 回退卡片含错误码与 escaped raw，不渲染节点。
4. 图例/状态标记存在；无 `style` 颜色来自模型。

`src/interactive/QuestionModal.test.tsx`（约 3）

1. 四类字段渲染为 fieldset/legend/radio/checkbox/textarea/confirm。
2. 必填/描述/队列位置/隐私提示可见。
3. 选项文本转义，不渲染 Markdown/HTML。

`src/interactive/QuestionCard.test.tsx`（约 2）

1. answered/expired/cancelled 卡片不显示提交入口，显示答案摘要。
2. record 缺失时显示加载/不可答状态。

`src/ChatContent.test.tsx`（约 5）

1. 文本 + 画布 + 提问分段正确，文本段仍由 Markdown 渲染。
2. 用户消息不解析。
3. 非法块回退、其余文本保留。
4. 流式 strip 不显示 JSON。
5. 问题 record 缺失时卡片禁用/加载态。

**现有测试**：`src/Markdown.test.tsx`（2）、`src/TaskStarMap.test.ts`（5）、`src/shared/deeplink.test.ts`（13）、models（8）、kernel（73：permission 44、approval 9、approval-wiring 2、model 10、openai 1、service 7）必须继续通过。**2026-11-10 03:34 实跑基线：10 个测试文件 / 101 条全绿**（并发 UI 任务可能继续增加用例，以当时实跑为准）。

**手工 QA 清单（t64 完成前/t65 复核）**

1. 四类画布各一张（含分组/状态/决策/里程碑/注记）。
2. 滚轮/拖拽/fit/`+/-/0`/方向键；缩放不丢选中。
3. 单击节点 → 250ms 详情；双击 → 聚焦且无详情闪出；Esc 逐级。
4. 分组/分支折叠；折叠计数正确；展开恢复。
5. 非法 JSON/schema/超限/版本/未闭合五个回退夹具。
6. XSS 夹具（标签/选项）无脚本执行。
7. 表单四字段；必填/多选 min-max/文本长度错误；焦点到错误字段。
8. 提交回答 → 用户消息出现；刷新后 answered；再点不重复提交。
9. 两个问题：队列、稍后、切换、提交后下一个。
10. 5 秒超时问题：倒计时、到期关闭、卡片过期、提交返回 E_EXPIRED。
11. 取消：二次确认、状态、无消息。
12. 纯键盘走通画布 + 表单。
13. 960/1100/1440 + chat 面板 420/520/760 宽；无横向滚动。
14. 200% 缩放；reduced-motion。
15. 导出 Mermaid/SVG：文件可打开、无脚本、标签正确。
16. 刷新/切工作区/切任务上下文：画布与问题状态恢复且不串档。
17. Toast：成功/失败/新问题/重试；最多 3 条；读屏播报。
18. 风险审批弹窗出现时问题弹窗收起；审批后不叠加。
19. mock 触发画布/提问；真模型各一次。
20. `rg -n "dangerouslySetInnerHTML|innerHTML|eval\\(|new Function" src` 无结果；`git diff --stat` 无 `package.json` 依赖变化。

### 13.4 命令与门禁

```bash
pnpm typecheck   # tsc --noEmit
pnpm build       # vite build && pnpm build:electron
pnpm test        # vitest run（设计时基线 101 条 + 新增 ≥45 条）
```

- 在 t64 的 worktree 中运行；结果、退出码、测试计数写入实施文档。
- 额外检查：
  ```bash
  rg -n "dangerouslySetInnerHTML|innerHTML|eval\\(|new Function|document\\.write|window\\.open" src
  git diff -- package.json pnpm-lock.yaml   # 应为空
  ```
- 手工验收按 §13.3 清单；评审/集成报告引用 AC 编号。

### 13.5 完成定义（Definition of Done）

1. P0 AC-01–AC-36 全部通过（自动化优先；人工项有记录）。
2. 三命令全绿；无新依赖；`git diff` 只含 in-scope 文件（`src/`、`electron/`、`docs/team/`）。
3. 代码 review 无禁止 API；无模型可控样式/HTML/URL。
4. 现有 Markdown/星图/Dock/Modal/Toast/权限链路无回归（手工冒烟）。
5. `docs/team/interactive-canvas-implementation.md` 完成，包含 AC↔实现映射、测试证据、遗留项。
6. 按 AGENTS §8 走 worktree + PR，不直接改 main。

---

## 14. 风险、待裁决与后续

### 14.1 风险登记

| ID | 风险 | 概率/影响 | 缓解 |
|----|------|-----------|------|
| R-01 | 模型不遵循 fence 协议（不输出/输出坏 JSON） | 中/中 | 系统提示 + 严格回退 + Mock 触发 + P1 工具调用/自动修复；不影响纯文本使用 |
| R-02 | 布局在极端图（80 节点、密集环、超长标签）下可读性差 | 中/中 | 数量上限、LOD、标签截断、分层/泳道降交叉；P1 列表视图 |
| R-03 | 单击/双击在真实设备（触屏/触控板）仍有误触 | 低/中 | `event.detail` + 250ms + 4px 阈值 + 纯函数状态机；P1 触屏专项 |
| R-04 | 自动弹窗打扰用户 | 中/中 | DEC-10 条件 + 延后 + Toast 替代 + 卡片常驻 |
| R-05 | 回答发送失败导致“已答但没发” | 低/中 | `E_BUSY` 前置 + 发送失败 toast 重试 + 发送前内容去重；P1 幂等键 |
| R-06 | 历史压缩丢失画布细节，模型无法基于旧图修改 | 中/低 | P1 `artifact.get` 工具/让用户重发；P0 模型可重画 |
| R-07 | 新增 zod 到 renderer 增大包体 | 高/低 | 预期 +10–20KB gzip；可接受；P2 可换轻量校验 |
| R-08 | P0 工作量偏大（约 1–2 周） | 中/高 | 明确 P0 不含 Dock 面板/PNG/工具；按 §11.5 顺序小步合并；必要时拆 t64 后续任务（需 Captain 同意） |
| R-09 | 与风险审批 Modal 叠加/焦点冲突 | 低/高 | 优先级规则：risk 优先、问题弹窗收起；不嵌套；测试覆盖 |
| R-10 | 没有 jsdom，交互测试覆盖不足 | 中/低 | 交互逻辑抽纯函数（点击状态机/队列/校验/布局）单测；DOM 用手工清单 + SSR 结构 |
| R-11 | 截图细节未确认导致视觉不符 | 中/中 | §0.5 显式假设；实现前 Captain/user 复核；视觉差异记录在实施文档 |
| R-12 | `node:sqlite` `RETURNING` 兼容性 | 低/低 | 用 SELECT + 条件 UPDATE 替代；现有 Node 24 支持 |
| R-13 | 用户消息里出现 `[回答表单]` 被模型误认为真实回答 | 低/低 | 系统提示声明该前缀来自系统；P1 可加随机关联 id（需 ChatMessage 元数据） |
| R-14 | 问题答案含敏感信息进入模型/DB | 中/中 | 隐私提示、系统提示禁止索要秘密、P1 敏感词检测；本地存储与现有对话一致 |

### 14.2 待 Captain / 用户裁决

| # | 问题 | 默认建议 |
|---|------|----------|
| Q1 | DeerOpDaw 截图的额外视觉要素是否必须 P0 还原？ | 按 §2.2 基础视觉契约；截图细节复核后增量 |
| Q2 | 问题默认超时：无超时 vs 10 分钟？ | **默认无超时**，模型可显式 `timeoutSec`；避免打断长思考 |
| Q3 | Dock「画布」面板是否必须在 P0？ | **P1**；P0 内联 + 放大已覆盖 |
| Q4 | PNG 导出是否必须 P0？ | **P1**；Mermaid/SVG 已满足“可导出” |
| Q5 | 已回答问题是否允许修改并重发？ | P1（会重复发用户消息，需 run/幂等设计） |
| Q6 | 取消问题是否通知模型？ | P1；P0 卡片状态+用户自行说明 |
| Q7 | 是否引入列表视图作为画布替代？ | P1（可达性增强） |
| Q8 | Mock 触发器是否允许改 `MockClient`（仅 mock/测试路径）？ | 默认做（约 0.2d，P0-10），不影响真实模型与生产路径 |

### 14.3 后续文档

- t64：`docs/team/interactive-canvas-implementation.md`（协议落点、组件、测试计数、AC 映射、偏差记录）。
- t65：评审报告引用本文件 AC 编号与 §8/§13；重点复核安全、服务端校验、无回归。
- t66：集成报告引用 t64/t65，列 P1 待办（Dock 面板、PNG、工具调用、列表视图等）。

---

## 附录 A · 快速实现检查清单（t64 用）

**协议层**

- [ ] `deer-canvas`/`deer-question` 常量、schema、类型导出
- [ ] parser：多块、未闭合、大小写、其他 fence 不拦截、blockIndex
- [ ] 错误码映射与中文文案
- [ ] 清洗（控制字符/双向控制符）、长度/数量/字节上限
- [ ] 归一化（edge id、去重、默认 direction）
- [ ] 答案校验/格式化（四类字段）
- [ ] `chatBlockKey`、`compressInteractiveForModel`、`stripInteractiveForStreaming`
- [ ] `INTERACTIVE_PROMPT_V1` 常量

**主进程**

- [ ] 两张表 + Store 9 方法 + 条件更新
- [ ] `ingestAssistantInteractive`（幂等、catch 不阻断 done）
- [ ] `answerChatQuestion`（E_BUSY 前置、校验、changed、answerText）
- [ ] `cancelChatQuestion`、`listChatQuestions`（惰性过期）
- [ ] `listChatArtifacts`/`getChatArtifact`
- [ ] 系统提示追加、历史压缩、最近画布摘要、getContext 段
- [ ] 事件（不记录答案值）
- [ ] IPC 5 通道 + preload + types

**Renderer**

- [ ] `ChatContent` 切分 + streaming 剥离
- [ ] `CanvasArtifact`：四类布局、节点/边/状态/图例、pan/zoom/fit、详情、双击保护、聚焦、折叠、键盘、aria
- [ ] `CanvasCard`：header/footer/放大/导出/原始数据
- [ ] `CanvasFallback`：错误码 + escaped raw + 复制
- [ ] `QuestionCard`：四状态 + 答案摘要
- [ ] `QuestionModal`：四字段、校验、队列、超时、稍后、取消二次确认、隐私提示、initialFocus
- [ ] App：questions state、loadChat、回答/取消、自动打开、risk 优先级、workspace reset、Toast info
- [ ] 样式：token、窄窗、focus-visible、reduced-motion
- [ ] Mock 触发（可选）

**验证**

- [ ] 新增测试文件全部通过
- [ ] 三命令（typecheck/build/test）退出码 0
- [ ] grep 禁止 API 无结果；`package.json` 无依赖变化
- [ ] 手工清单 20 项
- [ ] `interactive-canvas-implementation.md` + worktree/PR

## 附录 B · 错误码索引

| 代码 | 含义 | 出现位置 |
|------|------|----------|
| `E_JSON` | JSON 语法错误 | parser |
| `E_SCHEMA` | zod/白名单/数量/长度失败 | parser |
| `E_PROTOCOL` | protocol 字段不匹配 | parser |
| `E_VERSION` | version > 1 | parser |
| `E_TOO_LARGE` | 原始 JSON/答案超限 | parser/answer |
| `E_LIMIT` | 单消息交互块超限 | parser |
| `E_UNCLOSED` | fence 未闭合（消息结束） | parser |
| `E_NOT_FOUND` | 问题/画布不存在 | service |
| `E_WORKSPACE_MISMATCH` | 跨工作区 | service |
| `E_BUSY` | 聊天回复中提交 | service |
| `E_INVALID_ANSWER` | 答案字段校验失败 | service |
| `E_EXPIRED` | 问题已过期 | service |
| `E_CLOSED` | 问题已取消/已回答后取消 | service |
| `E_NOT_PERSISTED` | 问题状态记录缺失（renderer 回退，非 IPC 错误码） | renderer fallback |
| `W_DUP_EDGE` | 重复边（去重） | parser warning |
| `W_CYCLE` | 环依赖（仍渲染） | layout warning |
| `W_ROOT` | 思维导图根缺失/多根 | layout warning |
| `W_UNREACHABLE` | 思维导图孤立节点 | layout warning |
| `W_EMPTY_GROUP` | 空分组 | layout warning |
| `W_DENSITY` | 深度/子节点过密 | layout warning |

## 附录 C · 参考链接

- WorkBuddy + 金数据问卷/表单生成：[https://fusion.jinshuju.net/guides/workbuddy-survey-generator-jsj](https://fusion.jinshuju.net/guides/workbuddy-survey-generator-jsj)
- WorkBuddy AI 生成表单配置（迭代修改/图片生成/流式）：[https://cloud.tencent.cn/developer/article/2696261](https://cloud.tencent.cn/developer/article/2696261)
- 团队既有设计：`docs/team/starmap-final.md`、`docs/team/starmap-decisions.md`、`docs/team/dock-layout-design.md`、`docs/team/dock-layout-final.md`、`docs/team/layout-final.md`
- 代码基线：`src/App.tsx`、`src/Markdown.tsx`、`src/Modal.tsx`、`src/Toast.tsx`、`src/TaskStarMap.tsx`、`src/shell/dock/{DockShell.tsx,panelRegistry.ts}`、`src/styles.css`、`src/kernel/{service,store,model}.ts`、`src/shared/{types,ipc}.ts`、`electron/{main,preload}.ts`

---

> 本文为 t63 设计交付；t64 实现请严格以本文的 schema、白名单、状态机、IPC 与 AC 为准。任何偏离必须在 `interactive-canvas-implementation.md` 中记录原因，并由 t65 评审裁决。

