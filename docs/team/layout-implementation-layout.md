# 布局评审采纳项实现映射 · t20（impl-layout / mika）

- **实现人**：mika（Frontend Engineer: layout）
- **范围**：C01、C03、C06、C09、C10（Captain 裁决 bb-46：合并 7→6）、C14
- **不在本任务**：C11/C12/C24/C25/C26 归 t21（impl-ux / lin）；未采纳项未做任何改动
- **验证**：`pnpm typecheck` ✅、`pnpm build` ✅、`pnpm test` 28/28 ✅

## C-ID → 文件 / 交互变化

### C01 状态与枚举统一（语义 token + 中文文案单一来源）
- `src/shared/copy.ts`（新增）：`TASK_STATUS_LABEL` / `AGENT_STATUS_LABEL` / `MESSAGE_KIND_LABEL` / `BOARD_KIND_LABEL` / `BOARD_CONFIDENCE_LABEL` / `statusLabel()`，全应用唯一映射。
- `src/StatusBadge.tsx`（新增）：统一状态徽章组件，替代 App.tsx 中的 `StatusPill`（已删除）。
- `src/styles.css`：`--status-running/review/ready/blocked/done/failed/cancelled/idle/offline` 语义 token；`.status-*`、`.star-status.status-*`、`.team-progress-seg.*`、`.dot.*` 全部改用 token，跨页同词同色（如 ready 统一为紫、running 统一为蓝、blocked 统一为黄，与团队进度条一致）。
- `src/TeamDashboard.tsx` / `src/TaskStarMap.tsx`：删除各自本地 `STATUS_LABEL`，改引 `shared/copy`。
- `src/App.tsx`：任务列表/详情徽章换 `StatusBadge`；邮箱类型徽标、黑板类型与置信度（`置信度低/中/高`、`已置顶`）改中文映射。

### C03 顶栏与页面头部：去重 + 面包屑 + 页面地标
- `src/App.tsx`：顶栏改为面包屑「工作区 › 页面 › 选中对象」（对象随 C14 选中态联动），去掉与侧栏重复的页名/hint 双行；活动导航 `aria-current="page"`；`document.title` 随工作区/页面更新。
- `src/styles.css`：`.topbar-crumb` / `.crumb-*` 样式。

### C06 任务列表工具栏与分栏伸缩
- `src/App.tsx` `TasksView`：
  - 工具栏：搜索框（标题/ID/摘要）+ 状态过滤 chips（全部/进行中/等待依赖/待运行/评审中/已交付/失败，各带计数）+ 空结果提示；行高紧凑化（`.task-row.compact`）。
  - 分栏：列表 280–520px 可拖宽（`--task-list-w` 驱动 grid）、双击复位、可收起（列表隐藏、详情头部「» 任务列表」一键展开），宽度/收起态 localStorage 持久化（`deer.taskListWidth` / `deer.taskListCollapsed`）。
  - 过滤状态提升到 App（`taskStatusFilter`），供顶栏跳转。
- 顶栏：失败任务计数 pill（`失败 N`），一键跳任务页并过滤 failed。
- `src/styles.css`：`.task-toolbar` / `.task-filter-chips` / `.task-resizer` / `.tasks-layout.collapsed` / `.pill-failed`；1100px 断点列宽改 `minmax(280px, var(--task-list-w, 320px))`。

### C09 侧栏导航分组 + 折叠图标栏（按 6 项）
- `src/App.tsx`：`NAV_GROUPS` = 工作（任务/团队/对话）· 协作（邮箱/黑板）· 系统（设置）；hint 动词化；折叠按钮 + Ctrl/⌘+B 全局快捷键；≤1100px 窄窗进入时自动折叠；折叠态 56px 图标栏，tooltip 补「名称 · hint」；状态 localStorage 持久化（`deer.sidebarCollapsed`）。
- `src/styles.css`：`.nav-group` / `.nav-group-label` / `.sidebar.collapsed` / `.sidebar-toggle`。

### C10 Router 入口治理：合并 7→6（Captain 裁决路线）
- `src/App.tsx`：
  - 删除顶层 Router tab（`Tab` 类型移除 `router`）与 `RouterView`；同时删除议程已标注的死代码 `TeamView`。
  - 工作区概述并入对话页：ChatView 顶部新增可折叠「工作区概述」卡（`.overview-card`，默认收起）。
  - 「规划任务」归位任务页：任务列表面板头新增按钮，复用 `RouterPlanModal`（规划完成仍自动跳任务页并选中首个任务）。
  - 原 Router 页的重复 mini 任务列表不再保留（任务列表在任务页本身就是主视图）。
- 兼容：无旧 hash 深链残留（C12 深链由 t21 实现，届时 `#/router` 需重定向，已在移交说明中标注）。

### C14 统一「当前任务」与跨页定位/返回（8/8 全票）
- `src/App.tsx`：
  - 选中态唯一来源：App 级 `selectedTaskId` 传入 TeamDashboard（删除其内部 selectedTaskId state）；切 tab 保留选中。
  - 任务详情新增「在星图中定位」：`handleLocateInStarMap` → 跳团队页 + `starmapFocus {taskId, nonce}` 居中该节点。
  - 跨页返回：`handleShowTaskContext(taskId, source)` 记录来源（tasks/team）；对话页任务上下文条新增「返回任务 / 返回团队」按钮；清除上下文时同时清来源。
- `src/TeamDashboard.tsx`：受控 `selectedTaskId` / `onSelectTask` / `starmapFocus`；底部详情与星图共享 App 选中态。
- `src/TaskStarMap.tsx`：新增 `focus` prop，收到定位请求时平移+缩放居中该节点（nonce 允许重复定位同一任务）。

## 链路自检（C14 主链路）
任务页选中 t → 详情「在星图中定位」→ 团队页星图居中并高亮同一任务 → 双击/「↗」打开任务会话（来源=team）→ 对话页「返回团队」回到团队页且选中保持；从任务页「查看上下文」进入则显示「返回任务」。

## 交给 t21（impl-ux）的注意事项
- C12 深链落地时：`Tab` 已无 `router`，`#/router` 应重定向到 `#/tasks`；对象级面包屑已由 App 级 `selectedTaskId`/`contextTaskId` 支持。
- C25 模态框：现有 5 个弹窗位置不变（新建任务、Router 规划——现从任务页/顶栏入口打开、发邮件、发布黑板、成员编辑）。
- C06 的顶栏「失败 N」pill 已占用 topbar-actions 左侧位置，C11 搜索框/＋新建放同区即可。
