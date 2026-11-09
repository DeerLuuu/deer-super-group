# DeerSuperGroup 交互式画布与提问表单 · 实现说明（t64）

- **任务**：t64 `[work]` 实现 WorkBuddy 风格交互画布与提问弹窗
- **实现依据**：`docs/team/interactive-canvas-design.md`（t63，3049 行）
- **执行者**：ray（Frontend Engineer: layout，DeepSeek 顶替 mika 席位）
- **模型路由**：`deepseek-official/deepseek-flash`（GLM 席位暂用 DeepSeek，AGENTS §1）
- **分支 / worktree**：`feature/t64-interactive-canvas` @ `branches/t64-interactive-canvas/`（AGENTS §8）；已合并 `main`（`494faef`，含 t63 设计文档与 Windows worktree 路径修复）后复跑三命令。
- **验证命令**：`pnpm typecheck` / `pnpm build` / `pnpm test`
- **下游**：t65 评审（ivy）→ t66 集成验收（kai）

> 本文件记录实际落地的协议、存储、IPC、布局、组件、测试与 AC 映射；任何与设计文档的差异在 §13 集中列出。

---

## 1. 交付结论

P0 全部能力已实现：`deer-canvas` / `deer-question` 结构化协议、四类画布（思维导图、流程图、路线图、依赖图）、确定性布局、缩放/平移/fit/节点详情/1 跳聚焦/分组与分支折叠、Mermaid/SVG 导出、提问表单弹窗（单选/多选/文本/确认）、队列/稍后/取消/超时/防重复、回答回流对话与模型上下文、刷新与切换对话/工作区后的恢复、主题 token / Modal / Toast / Dock 集成、键盘与 ARIA、安全白名单与校验测试。

**不做（按设计 P0 边界）**：Dock「画布」独立面板、PNG 导出、工具调用通道 `render_canvas`/`ask_user`、自动修复重试、渐进式流式渲染、节点关联跳转、列表视图、问题草稿持久化。均列入 P1（§14）。

---

## 2. 交付映射（P0-1 ~ P0-12）

| 设计项 | 交付 | 文件 |
|--------|------|------|
| P0-1 协议层 | fence 扫描、双 schema、错误码、清洗、归一化、答案校验/格式化、历史压缩、稳定键、系统提示 | `src/shared/interactive.ts`、`src/shared/interactive.test.ts` |
| P0-2 持久化 | `chat_artifacts` / `chat_questions` 两表 + 9 个方法 + 条件更新/惰性过期 | `src/kernel/store.ts` |
| P0-3 服务层 | ingest、list/answer/cancel/expire、系统提示注入、历史压缩、最近画布摘要、getContext 交互段 | `src/kernel/service.ts`、`src/kernel/interactive.test.ts` |
| P0-4 IPC | 5 通道 + 类型 + preload + main handler | `src/shared/types.ts`、`src/shared/ipc.ts`、`electron/main.ts`、`electron/preload.ts` |
| P0-5 布局 | 四类图确定性布局、bounds、fitView、折叠可见集合、环/根/孤立 warning | `src/canvas/layout.ts`、`src/canvas/layout.test.ts` |
| P0-6 画布 UI | 视口、节点/边、缩放/平移/fit、详情浮窗、1 跳聚焦、折叠、图例、工具条、回退卡片、LOD、键盘/ARIA | `src/canvas/CanvasArtifact.tsx`、`src/canvas/CanvasCard.tsx`、`src/canvas/CanvasFallback.tsx`、`src/canvas/CanvasArtifact.test.tsx` |
| P0-7 导出 | Mermaid（复制/下载）+ SVG（下载）+ 标签清洗/白名单行校验 + 主题快照 | `src/canvas/export.ts`、`src/canvas/export.test.ts` |
| P0-8 对话接入 | `ChatContent` 切分、流式剥离、`ChatBubble` 改造、用户消息纯文本保护 | `src/ChatContent.tsx`、`src/ChatContent.test.tsx`、`src/App.tsx` |
| P0-9 提问 UI | 卡片四状态、Modal 四字段、队列、稍后、取消二次确认、可选超时、防重复、草稿、隐私提示 | `src/interactive/QuestionCard.tsx`、`src/interactive/QuestionModal.tsx`、`src/interactive/QuestionFallback.tsx`、对应 `*.test.tsx` |
| P0-10 系统提示/Mock | `INTERACTIVE_PROMPT_V1` 注入 Router 系统提示；Mock 画布/表单夹具 | `src/shared/interactive.ts`、`src/kernel/model.ts` |
| P0-11 样式/可达性 | 画布/提问/回退/Toast info 样式、窄窗、focus-visible、reduced-motion | `src/styles.css`（新增 §t64 分区） |
| P0-12 测试/文档/PR | 9 个新测试文件、本文件、worktree/PR 流程 | 本文件 |

**小幅扩展的现有文件**：`src/Modal.tsx`（可选 `initialFocusRef`）、`src/Toast.tsx`（`kind: "info"`）、`src/shared/types.ts` / `src/shared/ipc.ts`（只追加类型与方法）。

---

## 3. 协议层（`src/shared/interactive.ts`）

### 3.1 Fence 与切分

- 精确识别 ```` ```deer-canvas ```` / ```` ```deer-question ````：大小写不敏感、两侧空白允许、最多 3 个前导空格、```` ``` ```` 或 `~~~`；结束 fence 字符相同且长度 ≥ 起始；带额外 info（如 `deer-canvas foo`）不识别，按普通 Markdown 处理。
- **其他语言 fence 完全不拦截**（交给现有 `<Markdown>`）；行内代码 `` `deer-canvas` `` 不触发。
- **只解析助手消息**；用户/系统消息一律纯文本（防伪造）。
- 快速路径：正文不含 `deer-canvas` / `deer-question` 子串时直接返回单个文本段，不进入 fence 扫描/JSON/zod。
- 交互块统一编号 `blockIndex`（仅 canvas/question，从 0 开始），稳定键 `chatBlockKey(messageId, blockIndex) = "<messageId>#b<blockIndex>"`。
- 未闭合 fence：消息结束时生成 `E_UNCLOSED` 回退块；流式阶段由 `stripInteractiveForStreaming` 切除。

### 3.2 Schema 与限制

- `CanvasSchema`：`strictObject` + 枚举白名单（4 kind / 7 status / 8 node kind / 4 edge kind / 6 group tone）；节点 1–80、边 ≤240、分组 ≤12；节点/分组 id 正则 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`；边端点必须存在、禁止自环、边 id 唯一；分组引用必须存在。
- `QuestionSchema`：1–6 字段；`single`/`multi` 选项 2–12 且 id 唯一；`multi.min/max` 合法；`text.maxLength` 1–4000；`timeoutSec` 5–3600；字段 id 唯一。
- 单消息上限：交互块 ≤6、画布 ≤3、提问 ≤3；超出的块回退 `E_LIMIT`，前后文本保留。
- 单块原始文本 >64KiB → `E_TOO_LARGE`（在 `JSON.parse` 之前按 UTF-8 字节判断）。
- 错误码：`E_JSON / E_SCHEMA / E_PROTOCOL / E_VERSION / E_TOO_LARGE / E_LIMIT / E_UNCLOSED`；`detail` 只包含首个 zod 路径/细节，不显示堆栈。
- 归一化：边 id 缺失生成 `e1…`（跳过已有 id 冲突）；重复边（from/to/kind 相同）去重 + `W_DUP_EDGE`；默认方向 flowchart=`TB`、dependency/roadmap=`LR`。
- 文本清洗：去 C0 控制符（保留 `\n\t`）、零宽与双向控制符；单行折叠空白；多行（note/description）保留换行且最多 8 行。

### 3.3 答案与回流

- `validateQuestionAnswers(question, input)`：只遍历 question.fields；拒绝额外 key；严格类型；single/multi 必须是选项 id；multi 归一化为 options 顺序并按 `min/max` 校验；text trim 后按 `maxLength`；confirm 布尔；必填为 trim 后非空（multi 至少 1 项）。`values` 用 `Object.create(null)` 构建，避免 `__proto__` 注入。
- `formatQuestionAnswer`：首行 `[回答表单] <title>`，其后每个字段一行；`confirm` → 确认/不确认；`multi` 用 `、` 连接；文本多行缩进 2 空格；空文本 `（空）`；总长 ≤8KB。
- `compressInteractiveForModel`：画布 `[画布「title」kind=… N 节点/M 边 id=…]`、提问 `[表单提问「title」F 字段 id=…]`、非法块只保留错误码；结果上限 16KB。
- `stripInteractiveForStreaming`：遇到首个 deer-* fence 即切除其后内容，返回 `{text, pending}`，流式预览不裸露 JSON。
- `INTERACTIVE_PROMPT_V1`：设计 §5.8 原文常量，由 `buildRouterSystemPrompt()` 追加（worker 提示不注入）。

---

## 4. 存储与状态机（`src/kernel/store.ts`）

新增两张表（`CREATE TABLE IF NOT EXISTS`，存量库自动建立、无迁移风险）：

- `chat_artifacts(id PK, workspace_id, agent_id, message_id, block_index, kind, title, protocol_version, payload, created_at, UNIQUE(message_id, block_index))` + 2 个索引。
- `chat_questions(id PK, workspace_id, agent_id, message_id, block_index, title, payload, status, answer, created_at, answered_at, expires_at, UNIQUE(message_id, block_index))` + 3 个索引。

Store 方法（与设计 §9.3 对齐）：

| 方法 | 语义 |
|------|------|
| `saveCanvasArtifact` | `INSERT … ON CONFLICT DO NOTHING`（幂等） |
| `listCanvasArtifacts` / `getCanvasArtifact` | 按 workspace（+agent）隔离；读取时再次 zod 校验，损坏行跳过/返回 null |
| `saveChatQuestion` | 幂等插入，返回记录（payload 存服务端校验后的规范 JSON） |
| `listChatQuestions` / `getChatQuestion` | 按 workspace（+agent）隔离；按 created_at 升序 |
| `answerChatQuestion` | `UPDATE … WHERE id=? AND status='pending' AND (expires_at IS NULL OR expires_at > ?)`，返回 changes>0 |
| `cancelChatQuestion` | `UPDATE … SET status='cancelled' WHERE status='pending'` |
| `expireChatQuestions` | 先 SELECT 过期 id，再逐条条件 UPDATE（不依赖 `RETURNING`），返回被标记 id |

问题状态机（唯一写入点在主进程）：

```
pending ──submit(校验通过)──▶ answered（终态）
   ├──cancel──────────────▶ cancelled（终态）
   └──expiresAt 到期（list 时惰性清算）──▶ expired（终态）
```

---

## 5. IPC / API（设计 §10）

`DeerApi` 新增 5 个方法，`electron/preload.ts` 仅做类型转发，主进程 `electron/main.ts` 通过现有 `handle()` 注册：

| 通道 | 服务层 | 说明 |
|------|--------|------|
| `chat:artifacts:list` | `listChatArtifacts(workspaceId, agentId?)` | 画布索引（P0 渲染不依赖） |
| `chat:artifact:get` | `getChatArtifact(workspaceId, artifactId)` | 单张画布（P1 Dock 用） |
| `chat:questions:list` | `listChatQuestions(workspaceId, agentId?)` | 含惰性过期清算 |
| `chat:question:answer` | `answerChatQuestion(input)` | 业务失败用返回值表达（不抛异常，保留 fieldErrors） |
| `chat:question:cancel` | `cancelChatQuestion(input)` | 同上 |

主进程校验：问题存在、workspace 匹配、状态 pending、未过期、Router 不在回复（`E_BUSY`）、答案 schema/选项/必填/长度/序列化 ≤16KB；所有 SQL 参数化且带 `workspace_id`。

---

## 6. 服务层（`src/kernel/service.ts`）

- `ingestAssistantInteractive(workspaceId, agentId, message)`：解析 → 合法画布写 `chat_artifacts` + `chat.artifact_ingested`；合法提问写 `chat_questions`（`expiresAt = message.createdAt + timeoutSec`）+ `chat.question_created`；非法块写 `chat.interactive_invalid`；幂等（已存在则跳过、不重复事件）。
- `sendChat`：助手消息保存后调用 ingest，任何异常写 `chat.interactive_ingest_failed` 且**不阻断** `done`。
- `answerChatQuestion`：`E_NOT_FOUND → E_WORKSPACE_MISMATCH → E_BUSY → answered(changed:false) → cancelled/expired → 到期清算 → 校验 → ≤16KB → 条件更新`；`changed:false` 也写 `chat.question_answered{changed:false}`，但不生成消息。
- `cancelChatQuestion`：answered→`E_CLOSED`、expired→`E_EXPIRED`、cancelled 幂等；成功写 `chat.question_cancelled`。
- `listChatQuestions`：先 `expireChatQuestions` 并逐条写 `chat.question_expired`。
- 系统提示：`buildRouterSystemPrompt()` 末尾追加 `INTERACTIVE_PROMPT_V1`（`sendChat` 与 `getContext` 同源）。
- 历史压缩：进入模型上下文的助手消息经 `compressInteractiveForModel`；用户原文保留；system 末尾追加最近 5 张画布摘要（单条 system 消息，兼容 OpenAI-compatible provider）。
- `getContext`：新增 `id="interactive"`、`kind="history"` 段，列出最近画布 / 待回答 / 已回答摘要与计数（上下文面板无需新增 UI 类型）。

---

## 7. 布局与视口（`src/canvas/layout.ts`）

确定性纯函数（无 `Math.random` / `Date.now` / `localeCompare`），同输入两次调用逐坐标/逐路径相等：

| 画布 | 算法 | 要点 |
|------|------|------|
| `flowchart` | 3 色 DFS 判回边 + Kahn 拓扑 + 最长路径分层 | TB: `y=80+level*150`；LR: `x=80+level*230`；行内按数组顺序、层内垂直居中；决策高度 80；分组画包围盒（22px padding + 18px 标题带） |
| `dependency` | 复用分层（默认 LR） | 回边虚线 + `W_CYCLE`；边默认 `depends` |
| `mindmap` | 径向树：BFS 构树（首个父节点优先）、按叶子数比例分扇区、`R(d)=170+(d-1)*150`（d≥1） | 根缺失/多根 `W_ROOT`；不可达节点 `W_UNREACHABLE`（渲染在下方隔离区，不隐藏）；深度 >4 截断 + `+N` 徽章 + `W_DENSITY`；同父 >8 子加 `W_DENSITY` |
| `roadmap` | 泳道：分组按 `order`/id 排序，无分组进末尾「未分组」泳道 | 泳道 `y=60+index*160`、高 140；节点 `x=200+index*220`、`y=laneY+44`；空分组 `W_EMPTY_GROUP`；折叠泳道隐藏成员并保留计数 |

- 节点尺寸按 kind 查表（root 200×64、topic/step/task 176×52、milestone 140×72、decision 176×80、note 176×64、risk 168×64）。
- 折叠：分组折叠隐藏成员并重算 `hiddenNodeCount/hiddenEdgeCount`，**不重排其他节点**；思维导图分支折叠隐藏后代并在节点上显示 `+N`。
- `bounds`：所有可见节点 + 分组盒 + padding 80；空图返回 0 尺寸。
- `fitView(bounds, container, {padding:48, minScale:0.3, maxScale:1.4})`：按容器尺寸等比缩放 + 居中，缩放范围 0.3–2.2。
- 辅助：`oneHopNeighbors`（聚焦 1 跳）、`nodeDegrees`（详情入/出度）、`statusVariable`（status→token）。

视口交互（`CanvasArtifact.tsx`）：滚轮以指针为锚点缩放、空白拖拽平移（>4px 才进入拖拽）、`+/-/0`、方向键平移 40/120px、双击空白清聚焦、空白点击逐级清理；`ResizeObserver` 自动 fit 且用户交互后不再自动 fit。

---

## 8. 导出（`src/canvas/export.ts`）

- **Mermaid**：id 重映射为 `n0…/g0…`；`step/topic/task`→`["…"]`、`decision`→`{"…"}`、`milestone`→`(["…"])`、`risk`→`[["…"]]`；`flow/depends`→`-->`、`contains`→`---`、`relates`→`-.->`；分组→`subgraph gN["…"]`；思维导图是树时输出 `mindmap`，否则降级 `flowchart` 并 warning。
- 标签清洗：控制字符/双向字符、`"`→`'`、去除 `[]{}()<>` 与反引号，截断 120；生成后再做**白名单行校验**（只允许 `flowchart TB/TD/LR`、`mindmap`、`subgraph gN["…"]`、`end`、受控节点/边行），并扫描骨架中的 `classDef/linkStyle/click/style/javascript:/…` → 拒绝导出。
- **SVG**：纯函数自绘 `<svg>`（rect/polygon/path/text），所有文本 `escapeXml`，颜色来自 `CanvasTheme`（`readCanvasTheme` 读取 `getComputedStyle` token，失败回退 `FALLBACK_CANVAS_THEME`）；无 `foreignObject`/`script`/事件属性/外部 URL；尺寸 >4096 拒绝并提示。
- 下载走浏览器 Blob API；文件名 `deer-canvas-<kind>-<slug>-<timestamp>.<ext>`，slug 去路径分隔符/控制字符/非法字符，保留中文，截断 48。剪贴板失败时展开只读 textarea 兜底，不静默失败。

---

## 9. 组件与 App 集成

### 9.1 组件

| 组件 | 职责 |
|------|------|
| `ChatContent` | 助手消息按块切分：文本→`Markdown`（`skipHtml` 不变）；canvas→`CanvasCard`；question→`QuestionCard`；失败块→回退卡片；用户/系统消息纯文本；流式剥离 |
| `CanvasCard` | 卡片 header（kind 徽章/标题/计数/放大/导出/原始数据）、`CanvasArtifact`、footer（状态/警告）、原始 JSON `<pre>`、剪贴板兜底；`ResizeObserver` 设置 `data-width=compact|regular|wide` |
| `CanvasArtifact` | 视口/节点/边/分组/泳道、缩放平移 fit、LOD、详情浮窗、1 跳聚焦、折叠、图例、工具条、`role=application` + `aria-live` + 键盘 |
| `CanvasFallback` / `QuestionFallback` | 错误码 + 中文原因 + 首个错误路径 + 转义原始 JSON + 复制；不渲染节点/表单 |
| `QuestionCard` | 四状态（pending/answered/expired/cancelled）+ 答案摘要 + 加载/`E_NOT_PERSISTED`；卡片是「稍后回答」后的再次入口 |
| `QuestionModal` | 复用 `Modal`（`initialFocusRef` 聚焦首个字段）；四字段、必填/描述/min-max/maxLength、错误内联 + `role=alert` 摘要、取消二次确认（4s）、倒计时、隐私提示、`aria-busy` |

### 9.2 App 状态与流程（`src/App.tsx`）

- 新增状态：`chatQuestions`、`questionsLoaded`、`questionModalId`、`questionDrafts`、`deferredQuestionIds`、`submittingQuestion`；`autoOpenedQuestionIdsRef` / `knownPendingQuestionIdsRef`。
- `loadChat`：消息 + context 并行，`listChatQuestions` 单独 catch（失败 toast，不阻断画布/文本渲染）。
- 队列与自动打开（DEC-10）：`pending` 按 `createdAt` 升序；满足「chat 面板可见 + 窗口有焦点 + 无其他 `role=dialog` + 输入框无草稿 + 未延后 + 每个问题只自动开一次」才自动弹窗；否则 info toast（带「去回答」）。
- 回答：`answerChatQuestion` → 成功更新本地记录、清草稿、关闭弹窗；`changed:true` 才 `sendChat(answerText)`（失败 toast「回答已保存，但发送失败」）；`changed:false` 只提示「未重复发送」。
- 稍后：关闭弹窗、记入 `deferredIds`、草稿保留；取消：服务端 `cancelChatQuestion` 后更新卡片；超时：Modal 倒计时到 0 → 关闭 + 刷新 + toast。
- 高风险审批优先：`riskApproval` 出现时收起问题弹窗并 toast（不嵌套 Modal）。
- 工作区切换：清空问题/草稿/延后/自动打开记录；画布随消息重新解析。
- `ChatView` 头部新增「待回答 N」chip（点击打开队首问题）；`ChatBubble` 助手消息改用 `ChatContent`，用户/系统消息保持纯文本。

### 9.3 Markdown / Modal / Toast / Dock / Token

- `Markdown.tsx` **未改**（`skipHtml`），文本段仍复用；画布/表单不经过 Markdown。
- `Modal.tsx` 仅新增可选 `initialFocusRef`；Esc/焦点陷阱/回焦/`aria-modal`/滚动锁与现有 5 个弹窗行为不变。
- `Toast.tsx` 新增 `kind:"info"`（`role=status`）；CSS 加 `.toast-info`。
- Dock：P0 不新增面板、不改 `panelRegistry`/`DockShell` 持久化；画布卡片宽度来自自身 `ResizeObserver`（compact <520，regular <760，wide ≥760）。
- Token：新增 `--canvas-*` 别名（全部指向现有 token）；状态色只经 `[data-status]` → `--node-status` → `--status-*`；不新增色板、不接受模型色值。

---

## 10. 安全实现

| 威胁 | 对策（已落地） |
|------|----------------|
| 模型输出 HTML/JS | 全部纯文本经 React 转义；无 `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function`/`document.write`/`window.open`（grep 0 命中）；Markdown 保持 `skipHtml` |
| 模型自定义样式/坐标 | schema 拒绝未知字段（`style/html/url/color/x/y` 等触发 `E_SCHEMA`）；坐标/尺寸/颜色全部客户端计算 |
| 选项注入 | 选项只渲染 React 文本，不经过 Markdown，不生成链接；控制字符清洗 |
| 伪造 artifact/问题 | 只解析助手消息；问题记录由主进程 ingest 落库；renderer 不能自造问题 |
| 篡改答案 | 主进程 `validateQuestionAnswers` 全量复核（选项 id/类型/必填/min-max/长度/额外 key）→ 失败 `E_INVALID_ANSWER` |
| 重放/重复提交 | 条件更新 `WHERE status='pending'`；`changed:false` 不重复发消息；终态不可回 pending |
| 过期作弊 | 服务端 ISO 时间比较；`E_EXPIRED`；list 惰性清算 |
| 跨工作区读取/回答 | 所有查询带 `workspace_id`；`getChatQuestion`/`getChatArtifact` 校验归属；`E_WORKSPACE_MISMATCH` |
| 资源耗尽 | 64KiB/块、80/240/12 数量、16KB 答案、6 块/消息、标签截断、布局线性遍历、无指数递归 |
| 导出注入 | Mermaid id 重映射 + 标签清洗 + 白名单行校验；SVG 纯函数 + `escapeXml` + 无外部资源；文件名去路径分隔符 |
| 审计与隐私 | `chat.*` 事件只记录 id/计数/错误码，**不记录答案值**、不记录问题标题/选项 |

---

## 11. 测试与验证

### 11.1 命令结果（本 worktree 实跑）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | 0 | `tsc --noEmit` 无错误 |
| `pnpm build` | 0 | `dist/assets/index-*.css` 197.76 kB（gzip 21.94 kB）；`dist/assets/index-*.js` 1,069.05 kB（gzip 293.76 kB）；`dist-electron/main.cjs` 924.4 kB；`preload.cjs` 3.5 kB |
| `pnpm test` | 0 | **19 个测试文件 / 206 条用例全部通过** |

> 测试基线：t64 开始前为 10 文件 / 101 条（t60 基线）。本任务新增 9 个测试文件 / 105 条用例。

### 11.2 新增测试清单

| 文件 | 数量 | 覆盖 |
|------|------|------|
| `src/shared/interactive.test.ts` | 36 | fence/大小写/CRLF/未闭合/用户消息不解析/快路径/块上限/E_JSON/E_PROTOCOL/E_VERSION/E_SCHEMA（未知字段/重复 id/端点/自环/分组引用/81 节点/241 边）/E_TOO_LARGE/重复边去重/控制符清洗/HTML 保留为文本/四类字段/问题 schema/答案校验/格式化/压缩/流式剥离/稳定键/expiresAt/prompt |
| `src/canvas/layout.test.ts` | 17 | 四类图确定性、TB/LR 分层、relates 不参与分层、环、分组折叠、mindmap 径向/折叠/无根/深树、roadmap 泳道排序/空分组/折叠、bounds、fitView、80 节点性能 smoke |
| `src/canvas/export.test.ts` | 13 | 四类 Mermaid、mindmap 降级、标签注入、白名单校验、SVG 转义/无脚本/无外链、4096 限制、文件名安全 |
| `src/canvas/interaction.test.ts` | 7 | 单击延时详情、双击不闪详情、窗口内二次点击、拖拽阈值、计时器隔离、cancel、Esc 逐级 |
| `src/kernel/interactive.test.ts` | 14 | ingest 幂等/事件、四字段落库、非法块事件、回答 changed/answerText、重复回答、篡改拒绝、过期清算、取消幂等、已答后取消、跨工作区隔离、E_BUSY、E_NOT_FOUND、context 交互段、原始消息保留 |
| `src/canvas/CanvasArtifact.test.tsx` | 6 | 四类画布 SSR、状态双编码、恶意标签转义、无链接、卡片结构、回退卡片 |
| `src/interactive/QuestionModal.test.tsx` | 3 | 四字段/ARIA/队列/隐私、选项转义、busy 态 |
| `src/interactive/QuestionCard.test.tsx` | 4 | pending/answered/expired/cancelled、缺失记录 |
| `src/ChatContent.test.tsx` | 5 | 分段渲染、用户消息不解析、非法回退、流式剥离、问题状态缺失 |

### 11.3 静态检查

- `rg "dangerouslySetInnerHTML|innerHTML|eval\(|new Function|document\.write|window\.open" src` → 0 命中。
- `git diff -- package.json pnpm-lock.yaml` → 空（无新依赖；复用已有 zod 4.6.7）。
- 所有新增颜色均来自 `var(--…)` / `color-mix`；JSX 中无模型可控颜色/尺寸（节点坐标来自布局纯函数）。

---

## 12. 验收标准映射（AC ↔ 实现 ↔ 测试）

| AC | 结论 | 证据 |
|----|------|------|
| AC-01 合法 fence 切分、其他代码块不变 | ✅ | `interactive.test.ts`（fence 组）、`ChatContent.test.tsx` |
| AC-02 四类图节点/边/分组/状态色 | ✅ | `layout.test.ts`（四类）、`CanvasArtifact.test.tsx`（四类 SSR） |
| AC-03 7 状态 token + 标记/图例 | ✅ | `styles.css` `[data-status]` 映射；`CanvasArtifact.tsx` 图例；SSR 状态断言 |
| AC-04 缩放/平移/fit/±0/方向键 | ✅ | `CanvasArtifact.tsx` 交互实现 + `layout.test.ts` fitView；手工项见 §15 |
| AC-05 单击延时/双击聚焦/Enter/Esc | ✅ | `interaction.test.ts` 7 条 |
| AC-06 分组/分支折叠且不改 JSON | ✅ | `layout.test.ts` 折叠用例；组件折叠状态为本地 state |
| AC-07 非法/超限/版本/未闭合整块回退 | ✅ | `interactive.test.ts` 各错误码 + `CanvasArtifact.test.tsx` 回退卡片 |
| AC-08 不能执行 HTML/JS | ✅ | SSR 转义用例 + grep 0 命中 + `export.test.ts` 注入用例 |
| AC-09 四类字段 + 校验 | ✅ | `QuestionModal.test.tsx`、`interactive.test.ts` 答案校验 |
| AC-10 回答后 answered + `[回答表单]` 用户消息 + 模型可见 + 刷新仍在 | ✅ | `interactive.test.ts`（answer/answerText/changed）+ 设计 §3.2 发送链路 |
| AC-11 队列/稍后/取消/超时/过期 | ✅ | App 队列/自动打开/稍后/取消/onExpire + `interactive.test.ts` 过期/取消 |
| AC-12 重复提交 changed=false、不重复发消息 | ✅ | `interactive.test.ts` 重复回答；App `handleAnswerQuestion` |
| AC-13 纯键盘完成链路 | ✅（实现 + 手工项） | 节点 button/Enter/Ctrl+Enter/Esc；表单原生控件 + fieldset/legend；§15 手工清单 |
| AC-14 role/aria-live/焦点管理 | ✅ | `CanvasArtifact.tsx`（application/label/live）、`QuestionModal.tsx`（dialog/alert）、SSR 断言 |
| AC-15 960/1100/1440 与 420/520/760 无横向溢出 | ✅（样式 + 手工项） | `data-width` 断点 + `.canvas-viewport{overflow:hidden}`；§15 手工清单 |
| AC-16 刷新/切对话/切工作区恢复 | ✅ | 画布以消息 content 为事实源；问题来自 DB；工作区切换清空重载 |
| AC-17 Toast 集成 | ✅ | 导出成功/失败、回答提交、新问题到达、发送失败；`ToastItem.kind:"info"` |
| AC-18 Markdown 不回退 | ✅ | `Markdown.test.tsx` 2 条仍通过；`ChatContent` 文本段仍用 `<Markdown>` |
| AC-19 Modal 基线不回退 | ✅ | `Modal.tsx` 仅新增可选 prop；现有弹窗不传时行为不变 |
| AC-20 Mermaid/SVG 导出与注入防护 | ✅ | `export.test.ts` 13 条 |
| AC-21 只用主题 token | ✅ | `styles.css` t64 分区全部 `var()`/`color-mix` |
| AC-22 80 节点性能 | ✅ | `layout.test.ts` 性能 smoke（<1000ms，实际 ~1ms） |
| AC-23 审计事件、不记录答案值 | ✅ | `interactive.test.ts` 事件断言（payload 不含答案值） |
| AC-24 Mock 可稳定产出夹具 | ✅ | `model.ts` `MOCK_FLOWCHART/MINDMAP/ROADMAP/DEPENDENCY/QUESTION` + 关键词触发 |
| AC-25 三命令通过、无新依赖 | ✅ | §11.1；`package.json` 无变化 |
| AC-26 实现文档 | ✅ | 本文件 |
| AC-27 未支持版本/未知字段整块回退 | ✅ | `interactive.test.ts` E_VERSION/未知字段 |
| AC-28 服务端拒绝篡改答案 | ✅ | `interactive.test.ts` 篡改/额外 key/非法选项 |
| AC-29 跨 workspace 隔离 | ✅ | `interactive.test.ts` 跨工作区用例 |
| AC-30 用户消息不解析 deer-* | ✅ | `ChatContent.test.tsx` + `parseChatContent` role 保护 |
| AC-31 流式不裸露 JSON | ✅ | `stripInteractiveForStreaming` + `ChatContent.test.tsx` |
| AC-32 四状态卡片 + 非法不可答 | ✅ | `QuestionCard.test.tsx` |
| AC-33 不引入第三方图/表单库 | ✅ | 依赖未改（zod 为已有依赖） |
| AC-34 旧库/旧消息无回归 | ✅ | 两表 `IF NOT EXISTS`；旧消息无 deer-* 子串走快路径；现有 101 条测试全绿 |
| AC-35 reduced-motion | ✅ | `styles.css` `prefers-reduced-motion` 分区 |
| AC-36 文本清洗/超长不撑破布局 | ✅ | `interactive.test.ts` 清洗；CSS `overflow-wrap:anywhere` + 截断 |

---

## 13. 与设计的偏差与取舍（需评审确认）

1. **Dock「画布」面板 / PNG / 工具调用 / 渐进流式 / 自动修复 / 列表视图**：全部按设计 P0 边界不做，P1 再议；P0 用内联卡片 + 放大 + Mermaid/SVG 导出覆盖。
2. **zod 进入 renderer bundle**：设计估算 +10–20KB gzip，实测 gzip 约 +48KB（245.4→293.75 kB）。原因：zod 全量 + 两套 strict schema；未新增依赖（zod 已是项目依赖）。若评审要求控包体，P1 可拆出「仅 renderer 使用的轻量校验器」，但会与主进程 schema 产生第二事实源，本轮不采用。
3. **`saveCanvasArtifact` 返回 void**：设计 §9.3 写 void；服务层用 `getChatArtifact` 先查存在实现幂等（单进程无并发写入）。`saveChatQuestion` 返回记录，与设计一致。
4. **事件 aggregateType**：设计只列 type/payload；实现统一 `aggregateType: "chat"`、`aggregateId` 为 artifact/question id（非法块用 messageId），便于按对象回放。
5. **`getContext` 交互段**：`id="interactive"`、`kind="history"`（设计 §5.9 明确复用 history，上下文面板零改动）。
6. **提问卡片入口**：设计示意图写「待回答 · 14:32 剩余」，实现为卡片头部状态 + `question-timeout`；ChatView 头部「待回答 N」chip 点击打开队首（与设计 §7.1 一致）。
7. **问题草稿**：App state 持有（关闭弹窗不丢），刷新丢失；与设计 §9.5 P0 一致，未写 localStorage（含敏感输入，默认不持久化）。
8. **自动打开实现**：用 `document.hasFocus()` + `document.querySelector('[role="dialog"]')` + `chatInput.trim()` + `tab === "chat"` + `deferredIds` + `autoOpened` 集合；与 DEC-10 逐条对应，未额外引入可见性 API。
9. **导出菜单**：卡片内原生按钮弹出菜单（非 Modal/portal），与设计 §4.8 一致；点击外部不自动关闭（P0 可接受，未列入 AC）。
10. **`chat_questions` 排序**：Store 按 `created_at ASC`（队列语义），设计 §9.3 未指定；服务层 list 同时做惰性过期。
11. **思维导图 Mermaid 导出**：树结构输出 `mindmap`（根 `n0((label))`、子节点 `nN[label]`），非树降级 `flowchart`；与设计 §4.8 映射一致。
12. **画布 LOD/图例断点**：使用卡片自身宽度 `data-width` + 视口缩放 LOD（0.55/0.9），未使用 window 宽度。

---

## 14. 已知限制 / P1 待办

- Dock「画布」独立面板（`PanelKey="canvas"`、活动 artifact、布局存档兼容）——P1。
- PNG 导出（SVG→canvas）与导出到黑板/邮件——P1。
- 工具调用通道 `render_canvas` / `ask_user`（复用同一校验器）——P1。
- 回退卡片「让模型修复」自动重试、渐进式流式渲染——P1。
- 节点 `refs.taskId/messageId/board` 点击跳转（P0 只读展示）——P1。
- 问题草稿持久化、已回答修改并重发、取消时通知模型、列表视图——P1。
- 画布缩放/折叠状态持久化（localStorage，LRU 100 条）——P1。
- 渲染层未引入 jsdom/testing-library：交互逻辑由纯函数覆盖，DOM 行为依赖 §15 手工清单（与设计 R-10 一致）。
- `CanvasCard` 导出菜单点击外部不会自动收起；`downloadText`/clipboard 在非浏览器环境返回 false（UI 有只读 textarea 兜底）。

---

## 15. 手工 QA 清单（t65/t66 复核用）

1. Mock 模式输入「画一张流程图 / 思维导图 / 路线图 / 依赖图」→ 对应画布出现，无 JSON 裸露（可展开「原始数据」）。
2. 滚轮缩放（指针锚点）、拖空白平移、`+/-/0`、方向键、适应按钮；缩放不丢选中。
3. 单击节点 250ms 后出现详情；双击不闪详情、直接 1 跳聚焦；Esc 逐级退出；Enter/Ctrl+Enter 等价。
4. 路线图泳道折叠/展开；流程分组折叠；思维导图分支折叠；折叠计数正确。
5. 五个回退夹具：坏 JSON、schema 非法、超限（81 节点）、版本 2、未闭合；均出错误码 + 原始 JSON，可复制。
6. XSS 夹具：节点标签/选项含 `<img onerror>`/`<script>` → 页面无脚本执行（手工确认）。
7. 表单四字段：必填、multi min/max、text maxLength、confirm；错误内联 + 焦点到首个错误字段。
8. 提交回答 → 出现 `[回答表单]` 用户消息 → Router 继续；刷新后卡片显示已回答；再次点击不重复提交。
9. 两个问题：队列（问题 1/2）、稍后、切换、提交后下一个是否按条件自动打开。
10. `timeoutSec` 问题：倒计时、到期自动关闭、卡片过期、提交返回 `E_EXPIRED`。
11. 取消提问：二次确认 4s 内再点生效、卡片已取消、无用户消息。
12. 纯键盘走通画布（Tab→Enter→Esc→Tab 到按钮）与表单（Tab→Space→提交）。
13. 960/1100/1440 窗口与 chat 面板 420/520/760 宽度：无横向滚动、按钮可达、表单不超视口。
14. 200% 缩放 + 系统 reduced-motion：无过渡/动画、内容可读。
15. 导出 Mermaid（复制/下载）与 SVG（下载）：文件可打开、无脚本、标签正确；剪贴板不可用时出现 textarea 兜底。
16. 刷新 / 切换任务上下文 / 切换工作区：画布与问题状态恢复且不串档。
17. Toast：导出成功/失败、回答提交、新问题到达、发送失败重试；最多 3 条、读屏播报。
18. 风险审批弹窗出现时问题弹窗收起；审批结束后问题卡片仍在、可重新打开。
19. Mock 与真实模型各触发一次画布/提问；真实模型不遵循协议时退化为普通文本。
20. `rg "dangerouslySetInnerHTML|innerHTML|eval\(|new Function" src` 无命中；`package.json`/`pnpm-lock.yaml` 无变化。

---

## 16. 运行与复现

```bash
# 在 worktree 内
cd branches/t64-interactive-canvas
pnpm install          # worktree 首次需要
pnpm typecheck
pnpm build
pnpm test

# 离线演示（Mock）：设置里勾选 Mock 模式（默认开启），对话输入：
#   画一张流程图 / 画一张思维导图 / 画一个路线图 / 画一张依赖图
#   帮我做个表单确认一下范围
```

- **分支**：`feature/t64-interactive-canvas`（`branches/t64-interactive-canvas/`）；PR 流程见 AGENTS §8。
- **未修改 `main`**：所有代码改动在 worktree/分支内；合并走 PR。

---

> 本文件为 t64 实现交付；评审（t65）请重点复核 §10 安全实现、§12 AC 映射与 §13 偏差；集成（t66）请按 §15 手工清单与三命令复跑。
