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
6) bounds 加 80 padding。
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
3) 节点 x = 40 + indexInLane*220；y = laneY + 44；组内顺序 = node.order ?? 数组顺序。
4) 泳道标题在 x=8（world 左缘），宽 160；节点起点 x=200，避免压标题。
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
| 点击空白 | 关闭详情浮窗并清除选中（保留聚焦？→ 设计：关闭详情；再次点击空白清除聚焦） |

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
- 加载态（P1 流式）：「正在生成画布…」带 skeleton；不渲染半截。
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
- 尺寸 = bounds + 48 padding；背景 `--bg-2`；最大 4096×4096；超过则按比例缩小或拒绝并 toast。
- 下载文件名：`deer-canvas-<slug(title)>-<yyyymmdd-hhmm>.svg`；`slug` 只保留字母/数字/汉字/`-`/`_`，截断 48，去除路径分隔符与控制字符。
- 生成失败 toast（error）+「查看详情」控制台错误码；不静默。

**PNG（P1）**

- 将 SVG 字符串 → `Blob` → `Image` → `<canvas>` → `toBlob('image/png')`；无外部资源，不污染 canvas；最大 4096；5s 超时；失败回退「下载 SVG」。
- 不引入 html2canvas 等依赖（体积/安全/字体问题）。

**导出与状态**

- 导出不改变画布状态；不写数据库；不写 localStorage；导出成功 toast（success，带文件名，不含路径）。
- 折叠/聚焦/缩放不影响导出内容（导出总是完整可见图，按当前可见集合）。
- 导出的是画布，不含对话/节点详情浮窗。

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
<!-- PART3 -->
