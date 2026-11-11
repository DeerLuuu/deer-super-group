# 无障碍、状态反馈与错误恢复审计（t182）

- **审计人**：ivy（Accessibility & Usability Reviewer）
- **基线**：`main` / `b908d1a`（t168/t172 历史气泡、t175 取消/失败终态已合入）
- **议程**：`docs/team/ux-audit-agenda.md`（t179）
- **范围**：Shell / Dock / Modal / Chat / Tasks / Team / Runs / Review / Git / Memory / Poll / Settings 的键盘、焦点、ARIA、对比度、窄窗、加载/空/错/取消/重试/翻译失败/工具拒绝
- **约束**：只审计，不修改 `src/`、`electron/`、`dist*`；本轮只新增本文档
- **方法**：当前 `main` 静态代码审计 + 已有组件/服务测试 + 既有截图；未在无头环境执行完整真实 Electron 键盘/视觉走查
- **结论**：**1 blocker、5 high、8 medium、1 low**；最优先修复错误横幅原文泄漏、Settings 未保存/保存失败、全局快捷键穿透 Modal、Modal 背景非 inert、Chat composer 无标签。

> 说明：本文的「证据」是当前代码路径与已有测试；未重拍真实窗口截图。视觉类结论（字号/对比度）以 CSS token 和选择器直接计算，真机仍应在发布前补测。

---

## 1. 分级口径

| 级别 | 含义 | 本审计处理 |
|---|---|---|
| blocker / P0 | 敏感信息泄漏、数据/状态丢失且无恢复、主流程被错误操作破坏 | 必须先修复 |
| high / P1 | 主流程需要绕路、关键反馈不可见/不可达、显著无障碍阻断 | 本轮应修 |
| medium / P2 | 有 workaround 的键盘/ARIA/窄窗/反馈问题 | 可排入下一轮 |
| low / P3 | 文案、局部 polish | 随手项 |

---

## 2. Findings 总表

| ID | 级别 | 表面 | 一句话问题 | 证据 |
|---|---|---|---|---|
| A11Y-01 | high | Settings Modal | 未保存的模型/翻译/团队修改，Esc/关闭/backdrop/快捷键关闭时静默丢失 | `App.tsx:2913`、`SettingsView.tsx` 本地 state |
| A11Y-02 | high | Settings Modal | 保存失败只写页面背后的全局 banner，Modal 内无错误/重试 | `App.tsx:2257-2267`、`2540` |
| A11Y-03 | high | 全局 Shell | 对话框打开时 Ctrl+K / Alt+1–6 / Ctrl+B 仍穿透；Alt+1 可静默关闭 Settings | `App.tsx:607-631`、`445-452` |
| A11Y-04 | high | 全部 Modal | `aria-modal` 但背景未 inert/aria-hidden；多个 Modal 可同时存在，Esc 监听叠加 | `Modal.tsx`、`App.tsx:2913/2962` |
| A11Y-05 | high | Chat composer | 主输入框只有 placeholder，无 label/aria-label | `App.tsx:4860-4878` |
| A11Y-06 | **blocker** | Chat / 全局 error banner | 终态气泡已脱敏，但 `emitChat error` 与全局 banner 仍使用 provider 原始错误 | `service.ts:1239-1250`、`App.tsx:1253/2542` |
| A11Y-07 | medium | Chat 视图 tab | `role=tab` 无 `aria-controls`/`tabIndex`/方向键/tabpanel | `App.tsx:4735-4754` |
| A11Y-08 | medium | Sidebar / Tasks | 两个 resizer 是 `role=separator` 的 div，仅鼠标，无 tabIndex/aria-valuenow | `App.tsx:2532`、`3500` |
| A11Y-09 | medium | Toast | 5s 自动消失，仅 mouseenter 暂停；键盘 focus 不暂停，错误 action 可能消失 | `Toast.tsx:22-32/98-120` |
| A11Y-10 | medium | Chat/Poll/Team | 大量状态/元数据仍为 9–10px，覆盖了 t184 的 12px 基线；窄窗 team 进度 9px | `styles.css:2013/4297/4380/4389` |
| A11Y-11 | medium | StarMap 图例 | 归属图例 `#6e7681` 在 `#151b24` 上约 **3.77:1**，低于正文 4.5:1 | `styles.css:3521`、token |
| A11Y-12 | medium | ReviewSection | Enter/评论打开行内 composer 后焦点不进入 textarea，取消不回到 diff 行 | `ReviewSection.tsx:216-219` |
| A11Y-13 | medium | Shell | 无 skip-to-content；Tab 从品牌/侧栏/两个 resizer 才能到主内容，`aside` 无名称 | `App.tsx:2322/2532/2540` |
| A11Y-14 | medium | Chat 翻译/工具 | 「机翻失败」和工具失败只有状态/错误文本，没有重试、设置或权限/审批下一步 | `App.tsx:5089-5129/5516-5519` |
| A11Y-15 | low | Settings 子导航 | 当前 section 只有 `.active` class，没有 `aria-current`/`aria-selected` | `SettingsView.tsx:255-262` |

---

## 3. 证据卡

### A11Y-01 · Settings 未保存修改静默丢失（high / P1）

- **表面/入口**：设置 Modal；侧栏 ⚙、`#/settings`、命令面板。
- **Viewport/状态**：1440×900、960×700；编辑模型 provider、翻译源、团队默认模型后不发保存。
- **复现**：打开设置 → 修改任一字段 → 按 Esc / 点击 backdrop / 点右上角「关闭」/按 Alt+1。
- **期望**：有未保存内容时提示确认（或保留草稿）；取消关闭后字段仍在。
- **实际**：`SettingsView` 使用本地 `useState`；关闭路径 `closeSettings` 直接卸载 Modal，未传 `confirmClose`，也没有 dirty 汇总。修改丢失且无提示。
- **证据**：`src/App.tsx:2913-2923`（`Modal` 只有 `title/onClose/className`）；`src/SettingsView.tsx:44` 起的本地 state，`:217` 的 `save()`；`src/App.tsx:470-475` 的 `closeSettings`。
- **建议层级**：Modal 内确认或 workspace 级草稿；不要仅靠 toast。
- **验收句**：**Settings 有未保存修改时，Esc、关闭按钮、backdrop、Alt+1 均不得静默丢弃；选择取消后字段值保持原样，选择丢弃后明确提示。**（组件测试 + 真机键盘）

### A11Y-02 · Settings 保存失败反馈在 Modal 背后（high / P1）

- **表面/入口**：设置 Modal → 模型/翻译/团队页的保存。
- **Viewport/状态**：设置 Modal 打开，模拟 `saveSettings` reject。
- **复现**：改设置 → 保存 → 让 IPC 返回错误；观察 Modal。
- **期望**：Modal 内出现 `role=alert`、错误摘要、重试；字段不丢；可关闭/复制详情。
- **实际**：`handleSaveSettings` catch 只 `setError(...)`；错误 banner 渲染在 `<main>` 内、Modal backdrop 之后，用户在 Modal 内看不到；`SettingsView` 没有 error/onRetry prop，保存按钮恢复后无提示。
- **证据**：`src/App.tsx:2257-2267`；错误 banner `src/App.tsx:2540-2555`；`SettingsView.save()` 直接 `onSave(...)`，无本地 error。
- **建议层级**：把错误作为 Settings Modal 内联状态；全局 banner 作为兜底。
- **验收句**：**任意 Settings 保存失败时必须在该 Modal 内显示 role=alert 的错误与重试入口，并保留用户字段；不得只写 Modal 背后的全局 banner。**（mock IPC reject 测试）

### A11Y-03 · 全局快捷键穿透打开的对话框（high / P1）

- **表面/入口**：任意 Modal（设置、高风险审批、提问、合并队列、新建/规划）。
- **Viewport/状态**：1440×900；Settings 有未保存修改；RiskApproval 同时出现。
- **复现**：打开 Settings → 按 Ctrl+K（命令面板叠上来）或 Alt+1（切换 chat/tasks）；Settings 被关闭；按 Ctrl+B 折叠背景侧栏。
- **期望**：对话框打开时，除对话框自身快捷键外，全局导航/命令快捷键不生效或被排队；Esc 只关最上层。
- **实际**：`App` 在 `window` 上无条件监听 Ctrl+B/Ctrl+K/Alt+1–6；`Modal` 只在 document capture 上处理 Tab/Esc，未阻止这些组合。Alt+1 调用 `openPanel`，非 settings 分支会 `setSettingsOpen(false)`。
- **证据**：`src/App.tsx:607-631`；`openPanel` 的 settings 分支 `:445-452`；`Modal.tsx` keydown 只处理 Escape/Tab。
- **建议层级**：全局 shortcut dispatcher 增加 `dialogCount`/topmost 判断；Modal stack 统一 Esc。
- **验收句**：**任一 dialog 打开时，Ctrl+K、Alt+1–6、Ctrl+B 不得改变背景或关闭当前 dialog；Esc 仅关闭最上层，并回到触发控件。**（键盘手测 + shortcut 单测）

### A11Y-04 · Modal 背景非 inert，叠加 Modal 焦点/关闭冲突（high / P1）

- **表面/入口**：所有 `Modal`；另见 `MergeQueueModal` 自定义 dialog。
- **Viewport/状态**：Settings + 高风险审批同时打开；或 Settings + 合并队列（快捷键/事件触发）。
- **复现**：打开 Settings → 让 risk approval 到达（或快捷键打开另一个 Modal）→ 用屏幕阅读器虚拟光标浏览背景；按 Esc 观察两个 listener。
- **期望**：仅最上层 dialog 可聚焦/可读；背景 `inert` 或 `aria-hidden`；Esc 只关最上层；关闭后焦点回触发按钮。
- **实际**：`Modal` 只设置 `aria-modal="true"`，没有对 `#root`/背景设 `inert`/`aria-hidden`；每个 Modal 都在 document 上注册 keydown，叠加时同一次 Esc 可能触发多个 `onClose`。MRQ 自定义 dialog 也没有背景 inert。`MergeQueueModal` 打开时 focus close，但关闭后不恢复触发按钮。
- **证据**：`src/Modal.tsx:70-180`；`src/App.tsx:2913`（Settings）与 `2962`（RiskApproval）可同时渲染；`src/git/ui/GitPanels.tsx:129-169`（MergeQueue 自定义 focus trap，无 restore）。
- **建议层级**：统一 Modal stack；背景 inert；撤销 MergeQueue 自定义 dialog 或补 restore。
- **验收句**：**打开任一 Modal 时背景内容不可被 Tab/读屏访问；两个 Modal 叠加时只有最上层可聚焦，Esc 只关闭最上层，关闭后焦点回到触发按钮。**（DOM/AT 检查）

### A11Y-05 · Chat 主输入框无可访问名称（high / P1）

- **表面/入口**：Chat 面板 composer。
- **Viewport/状态**：任何会话。
- **复现**：用屏幕阅读器聚焦 composer；只听到 textarea/placeholder，没有稳定 label；placeholder 含快捷键混排。
- **期望**：程序化名称（如「给 Router 发消息」）+ 快捷键说明（`aria-describedby`）；错误/发送状态可关联。
- **实际**：`<textarea ref={composerRef} ... placeholder="给 Router 发消息… Ctrl+Enter 发送 · /clear 清空 · /compact 压缩" />`，没有 `aria-label`/`<label>`/`aria-describedby`。
- **证据**：`src/App.tsx:4860-4878`。
- **建议层级**：Panel 内主输入，始终需要 label。
- **验收句**：**Chat composer 必须有稳定的可访问名称和快捷键/清空说明；屏幕阅读器不依赖 placeholder 也能识别其用途。**（SSR/AT 断言）

### A11Y-06 · 错误横幅仍可能泄漏 provider 原文（blocker / P0）

- **表面/入口**：任何 IPC/chat 失败；重点 Chat provider error、工具错误、复制详情。
- **Viewport/状态**：provider 返回带 `Authorization`/`sk-`/URL query token/请求体的错误；或工具错误含敏感路径。
- **复现**：mock provider reject，message 含 `sk-test...`/Bearer/请求体；发送消息后看终态气泡与全局 error banner。
- **期望**：终态和全局 banner 都只显示脱敏、截断后的摘要；复制详情也不得含原文。
- **实际**：`persistChatTurnTerminal` 的 terminal.message 走 `terminalText` 脱敏；但同一 catch 里 `errorMessage = error.message` 原样放入 `emitChat({type:"error", error: errorMessage})`；App `setError(event.error)`，全局 banner 和「复制详情」直接显示。终态气泡安全，banner 不安全。`formatError` 只去掉 remote prefix，不脱敏。
- **证据**：`src/kernel/service.ts:1239-1250`；`src/App.tsx:1253`（`setError(event.error)`）、`2542`（banner）、`2550`（复制详情）；`src/shared/copy.ts:146`。
- **建议层级**：错误在 service 边界统一 sanitize/cap；UI 只消费安全摘要；provider body/stack 不进入 IPC。
- **验收句**：**当 provider/工具错误包含 `sk-`、`Bearer`、`Authorization`、token/secret 字段时，终态气泡、全局 banner 和复制详情均不出现原文；用 secret fixture 断言。**（安全测试）

### A11Y-07 · Chat 对话/轨迹 tab 只有半套 ARIA（medium / P2）

- **表面/入口**：Chat 面板「对话 / 轨迹」。
- **Viewport/状态**：任意；键盘用户。
- **复现**：Tab 到 tablist，按 ArrowLeft/Right；读屏读 tab 无面板关联。
- **期望**：WAI-ARIA tabs：`id`/`aria-controls`/`tabIndex` roving、Arrow/Home/End、对应 `role=tabpanel`；或改为普通 segmented buttons。
- **实际**：两个 button 有 `role=tab`/`aria-selected`，但没有 id/aria-controls/tabindex；内容没有 `role=tabpanel`；无方向键处理。
- **证据**：`src/App.tsx:4735-4754`。
- **建议层级**：内部 tab。
- **验收句**：**Chat 两个视图 tab 必须符合 WAI-ARIA tabs 或有等价的分段按钮语义；方向键可切换且读屏能关联当前面板。**（组件断言 + 键盘测试）

### A11Y-08 · 两个 resizer 仅鼠标可调（medium / P2）

- **表面/入口**：左侧 Sidebar 与 Tasks 列表之间的 resizer。
- **Viewport/状态**：1440/960；键盘用户。
- **复现**：Tab 到 `div.resizer`（若浏览器可聚焦）或用鼠标拖动；无法用键盘调整宽度，读屏不播报当前宽度。
- **期望**：可 Tab 聚焦的 separator，Arrow/Home/End 调整，`aria-valuenow/min/max`；双击恢复；或至少提供「重置宽度」按钮。
- **实际**：两个 `div role="separator"` 只有 `onMouseDown`/`onDoubleClick`，无 `tabIndex`、无键盘 handler、无 aria-valuenow；CSS 不阻止鼠标，但键盘不可达。
- **证据**：`src/App.tsx:2532-2537`（sidebar）、`:3500-3505`（task list）。
- **建议层级**：Shell 布局控制。
- **验收句**：**Sidebar/Tasks resizer 可由键盘聚焦并调整宽度，读屏能播报当前值；双击/Home 可恢复默认，且窄窗不横向溢出。**（键盘测试）

### A11Y-09 · Toast 自动消失不响应键盘 focus（medium / P2）

- **表面/入口**：全局 Toast（成功/错误/info，含「重新发送回答」action）。
- **Viewport/状态**：错误 action 在 5s 内消失；键盘用户尚未操作。
- **复现**：触发带 action 的错误 toast → 只用 Tab focus（不 hover）→ 5s 后 toast 消失，action 不可达。
- **期望**：focus/hover 都暂停计时；错误/toast 带动作时至少保持到显式关闭或更长；关闭按钮 aria-label 稳定。
- **实际**：`DEFAULT_DURATION=5000`；只绑定 `onMouseEnter/onMouseLeave`；`aria-live/role=alert` 有，但键盘 focus 不暂停；错误 action 随 toast 消失。
- **证据**：`src/Toast.tsx:22-32`、`:98-120`。
- **建议层级**：全局反馈。
- **验收句**：**Toast 在键盘 focus 或 hover 时暂停自动消失；带 action 的错误提示在用户操作前不自动消失，且可由 Esc/关闭按钮关闭。**（Toast 交互测试）

### A11Y-10 · 关键状态/元数据仍有 9–10px（medium / P2）

- **表面/入口**：Chat 终态阶段/时间、Poll 卡片/详情元数据、Team 进度卡窄窗。
- **Viewport/状态**：1440/900/760；100% 与 125% 缩放。
- **复现**：打开 Chat 终态、Poll 列表/详情、Team 进度；检查字号。
- **期望**：关键状态/操作说明 ≥12px，行高 ≥1.4；不因窄窗把重要信息压到 9px。
- **实际**：多组选择器显式 9/10px，且优先级高于末尾 t184 的 `.tiny/.muted` 12/12.5：`.chat-turn-terminal-time/.chat-turn-terminal-stage` 10px、`.poll-card-meta/.poll-meta-row/.poll-threshold-note` 10px、`.team-progress-card .muted:last-child` 9px（≤900）。
- **证据**：`src/styles.css:2013-2016`、`:4297`、`:4380`、`:4389`、`:4427`；t184 基线在文件末尾 `:7316` 但被更具体选择器覆盖。
- **建议层级**：全局字号 token / 组件 CSS 清理。
- **验收句**：**Chat 终态阶段、Poll 元数据/阈值、Team 进度等关键文字在 100%/125% 与 900/760 宽度下均 ≥12px 且不截断；窄窗不得降到 9px。**（截图/DOM 计算）

### A11Y-11 · 星图归属图例对比度不足（medium / P2）

- **表面/入口**：Team 星图图例「归属」线。
- **Viewport/状态**：深色主题；1440×900。
- **复现**：打开星图 → 图例；用取色器/计算工具测 `#6e7681` 对 `#151b24`。
- **期望**：正文/图例文字 ≥4.5:1（或非文本图形 ≥3:1，并配文字标签）。
- **实际**：`.legend-line.legend-own { color:#6e7681 }` 对 `--panel #151b24` 约 **3.77:1**；10px 小字，低于 4.5:1。
- **证据**：`src/styles.css:3521`、token `--panel:#151b24`（`:5`）；计算值 3.77:1。
- **建议层级**：图例配色。
- **验收句**：**星图归属图例文字（含 10px 标签）在深色主题达到 4.5:1，或改为非文本线型+可读文字标签；截图复测。**（对比度检查）

### A11Y-12 · Review 行内评论 composer 不接管焦点（medium / P2）

- **表面/入口**：Task 详情 → ReviewSection → diff 行「评论」/Enter。
- **Viewport/状态**：键盘用户；任意 diff。
- **复现**：Tab 到 diff 行 → Enter 打开 composer → 焦点仍在 diff 行，需多次 Tab 才到 textarea；取消后不回到原行。
- **期望**：打开 composer 后焦点进入 textarea（或「评论内容」字段）；Esc/取消回到触发行。
- **实际**：`openComposerAt` 只 `setComposer/setCommentBody`，没有 ref/focus；composer 取消只 `setComposer(null)`，无 focus 恢复。
- **证据**：`src/review/ui/ReviewSection.tsx:216-219`；composer 在 `:425-445`。
- **建议层级**：内联二级区。
- **验收句**：**从任意 diff 行打开评论 composer 时焦点自动进入「评论内容」，取消/Esc 后焦点返回原行；键盘可完成发布。**（Review 组件键盘测试）

### A11Y-13 · 无 skip-to-content，侧栏 landmark 未命名（medium / P2）

- **表面/入口**：Shell 首屏。
- **Viewport/状态**：键盘/读屏用户。
- **复现**：页面加载后连续 Tab；焦点经过品牌、侧栏切换、多个操作、两个 resizer 后才进入主内容。
- **期望**：首个可聚焦「跳到主内容」链接（focus 可见），指向 `<main id="main">`；`aside` 有 `aria-label`；主内容 landmark 唯一。
- **实际**：有 `<aside>` 和 `<main>`，但无 skip link；`aside` 没有 aria-label；`main` 无 id/aria-label；Tab 顺序从侧栏开始。
- **证据**：`src/App.tsx:2322-2540`；无 `skip` 字符串；`aside` 无 aria-label。
- **建议层级**：Shell。
- **验收句**：**首 Tab 出现「跳到主内容」并在 focus 时可见，激活后焦点/滚动到 main；侧栏 aside 有可读名称。**（键盘手测）

### A11Y-14 · 翻译失败/工具拒绝缺少下一步（medium / P2）

- **表面/入口**：Chat 思考段的机翻；Chat 工具调用结果。
- **Viewport/状态**：Bing/模型翻译 429/网络失败；工具权限拒绝/执行失败。
- **复现**：让翻译请求 reject；或让工具返回 denied/error；看提示。
- **期望**：失败摘要 + 就近动作：重试翻译/打开翻译设置；工具失败显示原因 + 可请求审批/重试/查看权限（按语义）。
- **实际**：翻译段只显示「机翻失败」静态文本，无重试/设置入口；工具失败只显示「失败」和错误 pre，无 action；用户需自己寻找设置/权限。
- **证据**：`src/App.tsx:5516-5519`（翻译状态）；`src/App.tsx:5089-5129`（工具 status/pre）。
- **建议层级**：Chat 内联反馈。
- **验收句**：**机翻失败提供重试/翻译设置入口；工具拒绝/失败提供原因和至少一个下一步（重试、查看权限/审批）；不留下死状态。**（交互测试）

### A11Y-15 · Settings 子导航当前项未暴露（low / P3）

- **表面/入口**：设置 Modal 左侧 7 段导航。
- **Viewport/状态**：读屏用户切换 section。
- **复现**：用读屏遍历设置子导航；当前 section 只有视觉 `.active`。
- **期望**：当前项 `aria-current="page"`（或 `aria-selected` + tab 语义）；名称/提示可读。
- **实际**：button 只有 class active；无 aria-current/aria-selected/aria-controls；hint 是可见文本，读屏可读。
- **证据**：`src/SettingsView.tsx:255-262`。
- **建议层级**：Settings 子导航。
- **验收句**：**Settings 子导航当前 section 通过 aria-current（或等价 tabs 语义）暴露，读屏能区分当前项。**（SSR 断言）

---

## 4. 覆盖与回归观察（非 finding）

- **已较好覆盖**：Chat 取消/失败终态气泡 `role=status/alert`、retry 仅预填不自动发送、busy disabled；PollPanel 主 tablist/结果 `role=progressbar/list`；Memory 主三页签 roving/Arrow/Home/End；Review diff grid 的 roving focus/方向键、文件 `aria-pressed`；StarMap 节点 button/键盘平移/缩放/aria-live；Modal 的 Tab trap/回焦/滚动锁在单层场景有效。
- **Loading/空态**：Tasks/Team/Mailbox/Memory/Poll/Review/Git 均有显式空态或 `role=status`；全局错误 banner 有复制/关闭。**但** Settings/Plan/Compose 等 Modal 的提交错误仍落在背景 banner（与 A11Y-02 同类模式，建议统一组件化）。
- **窄窗**：CSS 已有 `@media (max-width: 1100/900/760)` 与 Dock variant；本条未做真实视口截图，A11Y-08/10 需真机复核。
- **reduced-motion**：存在 `prefers-reduced-motion` 块（star/dock），但并非全应用统一；本轮未发现主流程被动画阻断，保留观察。
- **敏感信息**：A11Y-06 是唯一 blocker；`terminalText` 的正则和 cap 本身有效，问题在错误事件/全局 banner 的旁路。

---

## 5. 建议修复顺序

1. **A11Y-06**：错误在 service 边界统一 sanitize，再进入 terminal/error event；补 secret fixture。先堵泄漏。
2. **A11Y-01/02/03/04**：Settings dirty/confirm、Modal 内错误、shortcut modal guard、顶层 dialog/inert/回焦。它们是数据丢失和交互混乱的同一组根因。
3. **A11Y-05/07/08/12/13**：composer label、Chat tabs、resizer、Review composer focus、skip link；一次性补键盘/ARIA 基线。
4. **A11Y-09/10/11/14/15**：Toast 计时、字号/对比度、翻译/工具下一步、Settings nav 状态。

---

## 6. 验收与限制

- 本审计未修改生产代码；`git status` 仅新增本文件（及 t179 agenda 未跟踪文件）。
- 证据为当前 `main` 代码/既有测试；未执行真实 Electron 键盘/读屏/窄窗人工走查，相关项已在各 finding 的验收句中列为发布前必测。
- 建议在修复后补：键盘-only walkthrough（首 Tab → skip → Settings → 保存失败 → Esc → Chat → Review → Merge）、NVDA/VoiceOver 快速检查、960/760/125% 截图、secret 错误 fixture。
