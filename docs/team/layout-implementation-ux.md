# 布局评审采纳项实现映射 · t21（impl-ux / lin）

- **实现人**：lin（Product Designer / impl-ux）
- **范围**：C11、C12、C24、C25、C26（Captain 裁决 bb-46 归属 t21 的 5 项采纳项）
- **不在本任务**：C01/C03/C06/C09/C10/C14 已由 t20（mika）实现，见 `layout-implementation-layout.md`；未采纳 16 项未做任何改动
- **验证**：`pnpm typecheck` ✅ · `pnpm build` ✅ · `pnpm test` 41/41 ✅（含新增 `src/shared/deeplink.test.ts` 13 条用例）

## C-ID → 文件 / 交互变化

### C12 hash 路由与深链
- `src/shared/deeplink.ts`（新增）：`parseHash` / `buildHash` / `ROUTE_TABS` / `RouteTab`。格式：`#/tasks?t=<id>`、`#/team?t=<id>`、`#/chat?task=<id>`、`#/mailbox?m=<id>`、`#/board?b=<board>`、`#/settings`。**旧 `#/router` 深链重定向到 `#/tasks`**（C10 合并 7→6 的兼容层，`parseHash` 返回 `redirected` 标记）。
- `src/shared/deeplink.test.ts`（新增）：13 条单测——6 tab 解析、四类参数、旧 router 重定向、未知 tab 回退、build 往返一致、非当前页参数不写入。
- `src/App.tsx`：
  - 初始 tab 直接取自 `parseHash(window.location.hash)`；快照就绪后应用 `t/task/m/b` 选中对象（首次应用前不改写 URL，避免欢迎页丢参）。
  - 状态 → hash：**tab 变更产生 history 条目**（浏览器前进/后退可用），选中对象变化 `replaceState` 原地替换；自己写入的 hash 不回环处理。
  - `hashchange`（后退/前进/外部修改）→ 恢复 tab + 全部选中态并加载 trace。
  - 邮箱选中邮件、黑板选中板块从 View 内部 state **提升到 App**（`selectedMessageId` / `selectedBoard`），进入深链；`resetForWorkspace` 一并清理。
- `src/CommandPalette.tsx`：跳转动作复用 `RouteTab` 协议（依赖 C12/C14 的选中态与 `onOpenTask` 等 handler）。

### C11 全局搜索 / 命令面板 + 快捷键 + ＋新建
- `src/CommandPalette.tsx`（新增）：Ctrl/⌘+K 打开；单一命令注册表——导航 6 项（hint 带 `Alt+N`）、新建 5 项（任务/规划/邮件/黑板/成员）、实体（任务×N、成员×N、邮件×N、黑板板块×N）；↑↓ 选择、Enter 执行、Esc 关闭；空查询显示导航+新建；`role="dialog"` + `role="listbox"/option` + `aria-activedescendant`。
- `src/App.tsx`：
  - 顶栏新增「⌘K 搜索」按钮与「＋新建 ▾」下拉（5 个创建入口，`role="menu"`，外点关闭）；C06 的失败 pill 与刷新按钮保留同区。
  - 快捷键：Ctrl/⌘+K 开关面板、**Alt+1–6 切换页面**（与 t20 的 Ctrl/⌘+B 折叠侧栏并存于同一全局监听）。
  - 创建意图 `createIntent`：从面板/菜单选择后跳到目标页并自动打开对应弹窗，提交后留在当前页——`TasksView(autoOpen: task|plan)`、`MailboxView(autoOpenCompose)`、`BoardView(autoOpenPublish)`、`TeamDashboard(autoOpenMemberDialog)`，一次性消费后回调 `onAutoOpenHandled` 清除。
  - 面板实体跳转 handler：任务→任务页选中并加载 trace；邮件→`#/mailbox?m=`；黑板→`#/board?b=`；成员→团队页。
- `src/TeamDashboard.tsx`：接收 `autoOpenMemberDialog`，自动打开「新建成员」弹窗。

### C24 空状态统一 EmptyState
- `src/EmptyState.tsx`（新增）：图标 + 标题 + 说明 + 主/次 CTA（`compact` 模式供嵌位场景）。
- 替换的空态（11 处，全部去掉「点右上角」类指代错误文案）：
  - `App.tsx` TasksView：任务列表空（CTA：规划任务 / + 新建任务）、过滤无结果（CTA：清除过滤）、详情未选空态（无任务时带 CTA）；
  - MailboxView：列表空（CTA：发邮件）、详情未选（有邮件时 CTA：发邮件）；
  - BoardView：条目空（CTA：+ 发布条目）+ 板块零提示文案修正；
  - ChatView：对话空态升级为 3 个**可点击示例 chip**（一步填入输入框发起对话）；
  - `TeamDashboard.tsx`：底部任务详情未选空态；
  - `TaskStarMap.tsx`：星图空态（嵌于原 `star-empty` 定位容器，保留 pointer-events: none）。
- 未动的加载态文案（ContextPanel「上下文加载中…」）不属于空状态语义，保持原样。

### C25 模态框可用性基线
- `src/Modal.tsx`（新增）：全部 5 个弹窗共用的原语——Esc 关闭（**有未保存内容先 `confirm`**）、打开聚焦首个可聚焦元素、Tab/Shift+Tab 焦点陷阱、关闭后焦点归还触发按钮、`role="dialog"` + `aria-modal` + `aria-label`、背景滚动锁、backdrop 点击与「关闭」按钮走同一关闭路径（同样受确认保护）。
- 替换的 5 个弹窗（每个按自身表单状态计算 `confirmClose` 脏标记）：
  - `App.tsx`：TaskComposeModal（新建任务）、RouterPlanModal（规划）、MailboxComposeModal（发邮件）、BoardComposeModal（发布黑板）；
  - `TeamDashboard.tsx`：AgentDialog（新建/编辑成员）。
- 各弹窗原 `autoFocus` 属性移除（由 Modal 统一聚焦）。

### C26 全局反馈：toast + 错误文案 + aria-live
- `src/Toast.tsx`（新增）：`useToasts` hook + `ToastHost`（右下角、最多 3 条新挤旧、5s 自动消失、**hover 暂停计时**）；容器 `aria-live="polite"`，成功 `role="status"`、错误 `role="alert"`（assertive）。
- `src/App.tsx`：
  - 7 个写操作成功 toast（可带「查看」动作跳转）：创建任务、Router 规划（含任务数）、发邮件、发布黑板（跳对应板块）、创建成员、保存成员、保存设置。
  - 错误统一经 `formatError`（新增于 `src/shared/copy.ts`）：剥离 `Error invoking remote method <name>:` 前缀；错误 banner 加「**复制详情**」按钮（clipboard 写入原始文案）与 `role="alert"`。
  - 顶栏 busy 状态包 `aria-live="polite"` 容器（`.topbar-live`），读屏可感知运行状态切换。
- `src/shared/copy.ts`：`formatError`（REMOTE_METHOD_PREFIX 正则剥离）。

## 与 t20 的接口（未改动其职责）
- 侧栏分组/折叠（C09）、面包屑（C03）、任务工具栏（C06）、Router 合并（C10）、当前任务/返回（C14）的组件与行为零改动；本任务只在顶栏 `topbar-actions` 同区追加 C11 入口，并复用 C14 的 App 级选中态实现 C12 深链与 C11 跳转。
- 未采纳 16 项（C02/C04/C05/C07/C08/C13/C15/C16/C17/C18/C19/C20/C21/C22/C23/C27）零改动。

## 链路自检
- 深链：打开 `#/chat?task=t5` → 恢复对话页任务上下文；`#/router` → 任务页；选中任务后复制 URL 新窗口还原同一视图；浏览器后退回到上一 tab 与选中。
- 命令面板：Ctrl+K → 输入任务标题片段 → Enter 落在任务页且该任务选中；「＋新建 ▾」→「发邮件」→ 邮箱页自动弹出写信框。
- 弹窗：任一弹窗填入内容后按 Esc / 点遮罩 → 弹确认；确认后焦点回到触发按钮；Tab 循环不出弹窗。
- 反馈：创建任务后右下角 toast「已创建任务…」+「查看」；5s 自动消失，hover 暂停。

## 已知边界（供评审判断）
- Electron 无地址栏，深链主要服务于「刷新/重开恢复视图、前进后退、QA 可复现（通过 devtools/console 复制 hash）」；与 bb-43 中 kai 的备注一致，本实现保留了完整 URL 语义。
- `window.confirm` 用于弹窗脏关闭确认（C25 候选文案「未保存确认」的最小实现），原生 confirm 在 Electron 下可用；如需样式化确认可下一场升级。
- toast hover 暂停通过 mouseenter/mouseleave 实现，触屏设备无 hover（桌面应用场景无影响）。
