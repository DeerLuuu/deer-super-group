# 第 1 场布局与入口评审 · 集成与最终验收报告（t24）

- **场次**：第 1 场布局与入口评审（2026-11-09）
- **任务**：t24 [integrate] 集成与最终验收（in scope：`src/`、`docs/team/`）
- **集成人**：kai（Documentation & Integration）
- **输入**：
  - 候选与计票：`docs/team/layout-council.md`、`docs/team/layout-decisions.md`（黑板 `bb-1`–`bb-45`）
  - 实现映射：`docs/team/layout-implementation-layout.md`（t20 / mika，C01/C03/C06/C09/C10/C14）、`docs/team/layout-implementation-ux.md`（t21 / lin，C11/C12/C24/C25/C26）
  - 评审：t22（layout 首轮，`needs_revision`）→ t25（修复）→ t26（layout 复审，`verdict=pass`）；t23（ux 评审，`verdict=pass`）
- **验证**：`pnpm typecheck`、`pnpm build`、`pnpm test`（首次与 IF-01 修复后各执行一次，最终全部通过）

---

## 1. 最终结论

| 验收点 | 结果 | 依据 |
|--------|------|------|
| 两项评审均已通过 | ✅ | t26 `verdict=pass`（TASK_STATE 记录）、t23 `verdict=pass`；t22 的 3 条 findings 由 t25 修复、t26 复验通过（§3） |
| 11 个采纳 C-ID 均可在实现或文档中找到结果 | ✅ | 11/11 逐项对应到文件/组件与行为，见 §2、§5 |
| typecheck / build / test 全部通过 | ✅ | 最终一轮：exit 0 / 0 / 0，测试 6 文件 41 用例全绿（§4） |
| `docs/team/layout-final.md` 汇总采纳项、验证与后续项 | ✅ | 本文件 |
| 无未采纳提案被误改 | ✅ | 16 条逐条核验证据，见 §6 |

**额外结论**：集成阶段发现并修复 1 个**阻断级**缺陷（IF-01，React Hooks 顺序违规，会让开发构建在「打开工作区」时崩溃），另有 6 项低优先级观察/文档差异记录在 §7。缺陷修复后已重跑全部三条命令并通过。

---

## 2. 采纳项交付清单（11 / 11）

票数与来源见 `layout-decisions.md`；「实现位置」指最终代码（本报告所有行号对应当前 HEAD）。

| C-ID | 票数 | 实现位置 | 交付要点 | 验收/评审依据 |
|------|------|----------|----------|----------------|
| C01 | 6 | 新增 `src/shared/copy.ts`（五张映射 + `statusLabel`）、`src/StatusBadge.tsx`；`src/App.tsx`（`1310`/`1389` 使用，邮箱/黑板类型与置信度改用映射）、`src/TeamDashboard.tsx:3,231`、`src/TaskStarMap.tsx:4,360`、`src/styles.css:19–27`（`--status-*` 语义 token） | 状态/类型/置信度中文单一来源；删除 TeamDashboard、TaskStarMap 各自的本地映射与 `StatusPill`；状态色统一 token | t26 pass；全站无英文字符串直出（源码枚举名保留）；同一任务在任务页/星图/进度条同词同色 |
| C03 | 6 | `src/App.tsx:868–880`（面包屑「工作区 › 页面 › 选中对象」）、`:725–734`（`document.title`，位置见 IF-01）、`:829`（`aria-current` 仅导航）、`src/styles.css:390` | 去掉顶栏重复页名/hint；面包屑显示位置与选中对象；页面地标（窗口标题+导航 aria） | t26 pass；t25 修复 R3（面包屑容器 aria-current 移除，改 `aria-label`） |
| C06 | 5 | `src/App.tsx`：`TasksView` 工具栏 `1256–1276`（搜索 + 状态 chips + 计数）、分栏 resizer `1324–1333`、收起/展开 `1336–1364`、顶栏失败 pill `882–891`（`jumpToFailedTasks`）；`src/styles.css:577–630`（`--task-list-w`、`.task-toolbar`、`.task-resizer`） | 搜索（标题/ID/摘要）+ 7 档状态过滤与计数、紧凑行高；列表 280–520px 可拖/双击复位/可收起且持久化；失败任务全局计数一键过滤 | t26 pass；过滤状态提升到 App（`App.tsx:104`），与 C15 共享的过滤字段就位（C15 未采纳，未启用） |
| C09 | 6 | `src/App.tsx:39–53`（6 tab + `NAV_GROUPS` 三组）、`:99–102`（折叠状态）、`:163–180`（≤1100px 自动折叠，含 t25 R2 修复）、`:183–207`（Ctrl/⌘+B、Ctrl/⌘+K、Alt+1–6）、`:793–802`（折叠按钮）、`:816–838`（分组渲染/单行 hint/tooltip/`aria-current`）；`src/styles.css:283–299,325–360` | 「工作 / 协作 / 系统」三组；hint 动词化；折叠 56px 图标栏、tooltip 补名、宽度与折叠态持久化 | t26 pass；t25 修复 R2（挂载即窄窗同步折叠，仅「宽→窄」边沿自动折叠，不覆盖手动展开） |
| C10 | 5 | `src/App.tsx:38–46`（`Tab` 仅 6 项）、`:1584` 注释（RouterView 已移除）、`TasksView` 头部「规划任务」`1236–1244`、`ChatView` 概述折叠卡 `2264–2274`；`src/shared/deeplink.ts:11–13,47–48`（旧 `#/router` → `#/tasks`） | Captain 裁决「合并 7→6」：删除 Router tab 与 `RouterView`（同时清理死代码 `TeamView`），概述并入对话页、规划动作归位任务页；旧深链重定向 | t26 pass；`#/router` 重定向有 deeplink 单测覆盖；任务页规划入口 ≤2 步 |
| C11 | 7 | 新增 `src/CommandPalette.tsx`（`ROUTE_TABS` 导航 6 项 + 创建 5 项 + 实体，`CREATE_LABELS`/`CREATE_TARGET_TAB`）；`src/App.tsx:111–114`（状态）、`:895–936`（⌘K 按钮 + 「＋新建 ▾」菜单）、`:183–207`（快捷键）、`:969/996/1034/1045`（createIntent 分发） | Ctrl/⌘+K 命令面板（↑↓/Enter/Esc、分组、`aria-activedescendant`）；Alt+1–6 切页；任意页「＋新建」1 步入菜单、2 步入弹窗，提交后留在当前页 | t23 pass；验收句「输入任务标题回车落在任务页且选中」「任意页 2 步内打开对应弹窗」均满足 |
| C12 | 6 | 新增 `src/shared/deeplink.ts`、`src/shared/deeplink.test.ts`（13 用例）；`src/App.tsx:82`（初始路由）、`:142–158`（状态→hash，tab 变化产生 history、选中 replaceState）、`:289–302`（初始深链应用）、`:305–325`（hashchange 前进/后退）、`:116–117`（邮箱/黑板选中提升） | `#/tasks?t=`、`#/team?t=`、`#/chat?task=`、`#/mailbox?m=`、`#/board?b=`、`#/settings`；旧 `#/router` 重定向；刷新/后退可恢复 | t23 pass；13 条深链单测全绿（含重定向与往返一致） |
| C14 | 8 | `src/App.tsx:84`（App 级 `selectedTaskId`）、`:106`（`contextSource`）、`:108`（`starmapFocus`）、`:597–608`（记录来源 / 定位请求）、`:983–1001`（TeamDashboard 受控 props）、`:2240–2249`（「返回任务/返回团队」）；`src/TeamDashboard.tsx:19–53,214–221`（受控选中 + 星图 focus）；`src/TaskStarMap.tsx:65–79,128–163,189–204`（focus 优先于 fitView、双 rAF 居中、ResizeObserver 让位） | 三页共享唯一「当前任务」；任务详情「在星图中定位」居中并高亮；打开会话记录来源，对话页可 1 步返回 | t26 pass（含 t25 修复 R1 后复验）；8/8 全票项 |
| C24 | 7 | 新增 `src/EmptyState.tsx`；替换 9 处：`App.tsx:1281/1292/1367`（任务列表空/过滤空/详情未选）、`1696/1741`（邮箱）、`1968`（黑板）、`2279`（对话，3 个示例 chip）、`TeamDashboard.tsx:280`、`TaskStarMap.tsx:395`；另修正黑板板块空提示文案（`App.tsx` 板块 tabs） | 统一「图标+标题+说明+主/次 CTA」；去掉「点右上角」错误指代；对话空态示例一键填入输入框 | t23 pass；`grep 「点右上角」` 全 `src/` 仅剩 EmptyState 注释；C24 验收句为「9 处」 |
| C25 | 7 | 新增 `src/Modal.tsx`（Esc + 脏确认 `window.confirm`、首焦点、Tab 陷阱、回焦、`role=dialog`/`aria-modal`/`aria-label`、背景滚动锁）；5 个弹窗迁移：`App.tsx:1498`（新建任务）/`1599`（规划）/`1804`（发邮件）/`2034`（发布黑板）、`TeamDashboard.tsx:456`（成员编辑）；原 `autoFocus` 移除 | 5 个弹窗共用原语；脏关闭统一确认；焦点归还原触发按钮 | t23 pass；5/5 弹窗均使用 `Modal`；`confirmClose` 由各自表单 dirty 状态驱动 |
| C26 | 6 | 新增 `src/Toast.tsx`（`useToasts` + `ToastHost`：右下角、≤3 条、5s 自动消失、hover 暂停、去重、`aria-live`）；`src/App.tsx:119`（挂载）、7 处成功 toast `465/499/520/542/661/691/717`、错误 banner `940–958`（`formatError` + 复制详情 + `role=alert`）、busy `aria-live` `892`；`src/shared/copy.ts:64–71`（`formatError`） | 7 个写操作成功反馈（可带「查看」跳转）；错误文案去 IPC 前缀、可复制；读屏可感知 busy/成功/错误 | t23 pass；7/7 写操作有 toast；错误无 `Error invoking remote method` 前缀 |

> 口径：t20 负责 6 项（C01/C03/C06/C09/C10/C14），t21 负责 5 项（C11/C12/C24/C25/C26）；两者并集恰为采纳清单 11 项，无重叠、无遗漏。

---

## 3. 评审流转与结论

| 任务 | 对象 | 状态 | verdict | 结论与后续 |
|------|------|------|---------|------------|
| t22 | impl-layout（t20，6 项） | failed | needs_revision | 5 项完整；C14 定位居中不生效（R1 high），另 2 处 low：R2 窄窗启动不自动折叠（C09）、R3 面包屑容器与导航重复 `aria-current`（C03） |
| t25 | repair（mika） | completed | — | 3/3 修复：`appliedFocusNonceRef` + 双 rAF + 挂载/ResizeObserver 让位；matchMedia 挂载同步检查 + 仅宽→窄边沿折叠；移除 `topbar-crumb` 的 `aria-current`。typecheck/build/test 全过 |
| t26 | layout 复审（noor） | completed | **pass** | 3 条 findings 逐项复核通过；`commandsRun` typecheck/test 通过。**注意**：该任务 `output` 字段为空，权威结论以 `verdict=pass` + acceptance/commands 记录为准（IF-05） |
| t23 | impl-ux 评审（t21，5 项） | completed | **pass** | C11/C12/C24/C25/C26 全部有实现证据；未采纳 16 项抽查零改动；附 2 条不阻塞观察（聊天流错误未走 `formatError`、成员实体跳转不选中成员） |

**集成人对 t23 两条观察的复核**：
- 「聊天流错误未走 `formatError`」属实（`App.tsx:378–383` 中 `setError(event.error)`）；该错误来自模型流而非 IPC，不带 `Error invoking remote method` 前缀，影响极小，归入 §7-IF 后续项。
- 「CommandPalette 成员跳转只到团队页」属实（`CommandPalette.tsx:105–113` 成员行动作仅 `onNavigate("team")`）；C11 验收句只要求任务类跳转选中，符合契约，不阻塞。

---

## 4. 最终验证（t24 实跑）

### 命令与结果

| 命令 | 结果 | 退出码 | 关键输出 |
|------|------|--------|----------|
| `pnpm typecheck` | ✅ | 0 | `tsc --noEmit` 无输出 |
| `pnpm build` | ✅ | 0 | `vite build`：278 modules transformed；`dist/index.html 0.40 kB`、`dist/assets/index-ELgO0lti.js 468.13 kB (gzip 140.48 kB)`、`dist/assets/index-CHWp72Tx.css 36.57 kB (gzip 7.34 kB)`；`build:electron`：`dist-electron/main.cjs 843.5kb`、`preload.cjs 2.3kb` |
| `pnpm test` | ✅ | 0 | `vitest run`：**Test Files 6 passed / Tests 41 passed**，用时 3.33s；含 `src/shared/deeplink.test.ts` 13 条深链用例、`Markdown` 2 条、kernel 18 条、models 8 条 |

### 执行记录

1. **首次执行**（收到任务后，IF-01 修复前）：typecheck 0 / build 0 / test 41/41 —— 自动化全绿。
2. **集成静态核对**发现 IF-01（Hooks 顺序）→ 修复 `src/App.tsx`（移动 `document.title` effect）。
3. **修复后重跑**：typecheck 0 / build 0 / test 41/41（构建产物 hash 由 `index-Cfy5PZj5.js` 变为 `index-ELgO0lti.js`，符合改动预期）。

> 说明：`dist/`、`dist-electron/` 是本任务 `verify` 要求产生的构建产物，属生成物，未手工修改（任务 out of scope）。

---

## 5. 决策 ↔ 实现映射 ↔ 最终代码 一致性

- **覆盖**：`layout-decisions.md` 采纳清单 11 项，逐项在 §2 映射到「最终代码位置 + 行为 + 评审证据」，无遗漏。
- **职责边界**：两份实现文档各自声明范围与「不在本任务」清单；t20 文档声明 C11/C12/C24/C25/C26 归 t21，t21 文档声明未动 t20 的组件与行为。核对代码：C11 只在 `topbar-actions` 追加入口、复用 C14 的 App 级选中态；C12 把邮箱/黑板选中提升到 App 后，`MailboxView`/`BoardView` 改为受控（`App.tsx:1033,1044`），行为一致，无重复实现。
- **依赖顺序**：C12（深链/跳转协议）→ C14（当前任务/返回）→ C11（搜索跳转）；C09↔C10 同批（6 项分组）；C25↔C24/C26 共享组件/反馈——最终代码符合该顺序（`deeplink.ts` 被 `CommandPalette` 与 `App` 共用；`Modal`/`Toast`/`EmptyState` 独立可复用）。
- **文档口径差异（已记录，未阻塞）**：`layout-implementation-ux.md` 写「空态 11 处」，代码实际 9 个 `<EmptyState>` + 1 处板块提示文案 + 1 处加载态（`ContextPanel`「上下文加载中…」未改）；C24 验收句为「9 处」，建议实现文档按 9 处修订（§7-IF-06）。

---

## 6. 未采纳 16 条零改动核验

对每条未采纳项，选取其「提案要求改动的面」在最终代码中定位；结论均为**保持原状**。

| C-ID | 提案 | 核验证据（最终代码） | 结论 |
|------|------|----------------------|------|
| C02 | 时间显示规范 | `App.tsx:57–63` 仍只有 `toLocaleTimeString`（HH:mm:ss）；全 `src/` 无 `formatTime`/相对时间文案 | 未动 ✅ |
| C04 | 统一滚动模型/页面骨架 | `styles.css:435` `.content{overflow:auto}` 与 `.panel` 各自滚动、无 `height:100%` 骨架重构 | 未动 ✅ |
| C05 | 响应式断点体系（1280/1100/900/760） | `styles.css` 仅两段 `@media(max-width:1100px)`（`2554`、`2586`，重复段仍在）；无 1280/900/760；`electron/main.ts:28` `minWidth:1100` 未改 | 未动 ✅ |
| C07 | 黑板/邮箱 Markdown | 黑板仍 `<p>{entry.content}</p>`（`App.tsx:1981`），邮箱仍 `<pre className="mailbox-body">`（`1738`）；`<Markdown>` 仅用于对话（`2407`） | 未动 ✅ |
| C08 | 字号/对比度治理 | `styles.css:10` `--muted:#8b98a9` 未变；10px/8px 字号仍存在（如 `726`、`2375`） | 未动 ✅ |
| C13 | 工作区切换+窗口标题 | `App.tsx:811` 仍是「切换工作区」按钮（系统目录对话框）；`electron/main.ts:32` 窗口 `title` 仍为固定 `DeerSuperGroup`（C03 只改 `document.title`） | 未动 ✅ |
| C15 | 任务视图切换（列表/星图/看板） | 全 `src/` 无「看板」；任务页工具栏只有搜索+状态过滤（`1256–1276`），无视图分段控件 | 未动 ✅ |
| C16 | 协作中心/收件箱+未读 | `NAV_GROUPS` 仍 3 组 6 项（`App.tsx:49–53`）；无新顶层入口/未读角标 | 未动 ✅ |
| C17 | 邮箱线程/refs/未读 | 邮箱仍平铺列表；选中仍回落 `messages[0]`（`App.tsx:1671–1674`）；无 `threadId`/refs 渲染 | 未动 ✅ |
| C18 | 任务详情事实面板 | 详情仍只有描述/验收/摘要（`App.tsx:1427–1448`）；`branch`/`worktree` 仅存在于 `shared/types.ts` 与 kernel，未渲染 | 未动 ✅ |
| C19 | 详情「发送到…」带引用 | 全 `src/` 无「发送到」按钮/引用字段透传 | 未动 ✅ |
| C20 | 黑板 kind 过滤/搜索/pin | 黑板头仅领域 chips（`App.tsx:1951–1964`），无 kind chips/搜索/pin 操作；发布弹窗的 kind 下拉为原有实现（`2064–2078`）；「已置顶」是 C01 允许的展示文案 | 未动 ✅ |
| C21 | 对象操作菜单（右键/「…」） | 全 `src/` 无 `onContextMenu`/`ContextMenu`/行尾「…」菜单 | 未动 ✅ |
| C22 | 扩展位能力注册表 | `SettingsView.tsx:13–19` 仍 5 个分区；`626–681` 仍三个独立 `Placeholder`（插件/MCP/Skills，`coming next`） | 未动 ✅ |
| C23 | 开始使用 4 步 + 帮助中心 | 无 `OnboardingCard`；设置无「帮助」分区；全 `src/` 无帮助入口 | 未动 ✅ |
| C27 | 键盘与动效可达性基线 | 全 `src/` 无 `:focus-visible`、无 `prefers-reduced-motion`；星图节点仍为 `div`（`TaskStarMap.tsx:347`）；两处 resizer（`App.tsx:856–863`、`1325–1332`）无 `tabIndex`/方向键 | 未动 ✅ |

---

## 7. 集成发现与处理

### IF-01（**blocker，已修复**）：`document.title` effect 位于条件提前返回之后，违反 React Hooks 规则

- **位置**：`src/App.tsx`（修复前 768–774 行，位于 `if (!snapshot) return (<welcome/>)` 之后；修复后 725–734 行，提前返回之前）。
- **问题**：首屏 `snapshot === null` 走欢迎页提前返回，少调用一个 hook；快照就绪后的重渲染多调用一个 hook。React 开发构建在「重渲染时 hook 数多于上一次」会抛 `Rendered more hooks than during the previous render.`（已核对本地 react-dom 19.3.1：`node_modules/react-dom/cjs/react-dom-client.development.js:8224`），因此「欢迎页 → 打开/自动恢复工作区」这一必经路径在 `pnpm dev` 下会崩溃。
- **为何此前未发现**：t20 新增该 effect 时未运行应用；t22/t26 为静态审查、未覆盖 hook 顺序；typecheck/build/test 均不执行组件渲染（App 无单测），三条命令无法暴露。
- **修复**：把该 effect 移到 `if (!snapshot)` 之前，内部用 `snapshot ? ... : "DeerSuperGroup"` 兼容空快照；加注释标明 IF-01 与原因。
- **验证**：修复后 `pnpm typecheck` / `pnpm build` / `pnpm test` 全部通过（§4）；全文件复核无其他「提前返回之后的 hook」。
- **建议**：本修复发生在两项评审之后，建议 Captain 知悉；下一场在验收清单里增加「首启 → 打开工作区 → 6 tab 切换 → 新建任务 → 运行 → 星图定位 → 返回」冒烟项，并在 CI 之外保留该手工检查。

### IF-02（low，未修复）：错误「复制详情」复制的是已格式化文案，与实现文档不一致

- `App.tsx:940–958`：`navigator.clipboard?.writeText(error)`，而 `error` 在写入 state 前已经过 `errorText()`→`formatError` 剥前缀（`App.tsx:65–67`）；`layout-implementation-ux.md:51` 声称「clipboard 写入原始文案」。
- 影响：排障时复制到的是去掉 IPC 前缀的文案，不是完整原文；不违反 C26 验收句（「错误含复制且无 remote method 前缀」）。
- 建议：state 同时保留 `rawError`（或 `{message, detail}` 结构），「复制详情」复制原文。

### IF-03（low，未修复）：3 个状态文本色仍为硬编码

- `styles.css:735/747/753`：`.status-running #a5c8ff`、`.status-done #56d364`、`.status-failed #ff7b72` 为对比度调整后的文本色；同族的边框/背景已用 `color-mix(... var(--status-*))`。
- 影响：与 C01 验收句「无硬编码状态色」存在解释空间（评审已按通过处理）。
- 建议：下一场补 `--status-*-text` token 收口（S）。

### IF-04（low，未修复）：Modal 打开时首焦点落在「关闭」按钮

- `Modal.tsx:55–59` 按 DOM 顺序取首个可聚焦元素；`modal-head` 的「关闭」按钮位于表单之前，因此打开弹窗焦点在关闭按钮而非首个输入框（C25 验收句为「聚焦首个可聚焦元素」，满足契约）。
- 建议：`getFocusable` 优先返回 `input/textarea/select`，退化为首个可聚焦元素（S）。

### IF-05（low，记录）：t26 评审 `verdict=pass` 但任务 `output` 为空

- 该任务 `acceptanceResults`、`commandsRun`、`findings` 均已记录，唯一缺失是自然语言结论。t24 以 `verdict=pass` 为权威结论。
- 建议：后续评审任务至少输出一句结论 + 证据，便于集成/计票直接引用。

### IF-06（low，文档准确性）：实现文档「空态 11 处」与代码 9 处不一致

- `layout-implementation-ux.md:31` 记「11 处」，代码实际 9 个 `<EmptyState>`（§2-C24）+ 1 处板块空提示文案 + 1 处未改的加载态文案；C24 验收句为「9 处」。
- 建议：实现文档修订为 9 处并注明另 2 处非空态；本报告已按 9 处记录。

### IF-07（follow-up，超出本场范围）：README / 截图与 6-tab 现状不同步

- `README.md:96` 仍写「到「Router」点「规划任务」」，而 Router tab 已按 C10 合并（规划动作在任务页）；`README.md:5/35/44/94/144` 引用的 `docs/*.png` 含历史截图（`ui-preview.png`、`member-preview.png` 等）。
- 建议：下一场「文档同步」任务中更新 README 导航与截图、补 `docs/team/` 索引；本场不改（不在 in scope）。

---

## 8. 后续项与下一场候选

1. **6 个 3 票项（差 1 票）优先复议**：C05 响应式断点（复议前先定 `minWidth:1100` 是否下调，否则 900/760 档不可达）、C07 黑板/邮箱 Markdown、C08 字号与对比度、C20 黑板 kind 过滤/搜索/pin（pin 需 IPC）、C22 扩展位能力注册表、C27 键盘与动效基线（`:focus-visible` 建议与 C25 一起做）。
2. **2 票及以下**：C02/C04/C15/C23 可作为 1–2 天的小批次候选；C13/C16/C18/C19 建议并入相关主线（如 C13 并入工作区体验、C18/C19 并入任务详情主线）。
3. **组合建议**：C23（开始使用 + 帮助中心）与 C22（能力注册表）共享「能力状态/文案」，建议打包一次落地；C25 的 `window.confirm` 可在下一场升级为样式化确认。
4. **独立专项**：mika#8 流式渲染隔离（性能）单列任务；ren#10 任务列表多选/批量操作进 backlog（依赖调度器并发与失败恢复策略）。
5. **文档**：IF-02/IF-06 的文档修订、IF-07 的 README/截图同步；C12 在 Electron 的边界（无地址栏，深链服务刷新/重开/QA，通过 devtools 复制 hash）已写入实现文档，建议在 README 补一句。
6. **验收基建**：把 §7-IF-01 的冒烟清单（首启→打开工作区→6 tab→新建→运行→星图定位→返回）加入下一场评审的必跑项。

---

## 9. 复现与交接

```bash
# 依赖（首次）
pnpm install

# 三条验收命令（本报告结论即由它们产出）
pnpm typecheck   # tsc --noEmit
pnpm build       # vite build && pnpm build:electron
pnpm test        # vitest run（6 文件 / 41 用例）

# 开发运行（需 Electron 二进制）
pnpm dev
```

- **深链样例**：`#/tasks?t=<taskId>`、`#/team?t=<taskId>`、`#/chat?task=<taskId>`、`#/mailbox?m=<messageId>`、`#/board?b=<board>`、`#/settings`；旧 `#/router` 重定向到 `#/tasks`。
- **已知边界**：`window.confirm` 为脏关闭确认（C25 最小实现）；toast 5s 自动消失、hover 暂停（触屏无 hover，桌面场景无影响）；`Modal` 首焦点见 IF-04；`CommandPalette` 成员实体仅跳团队页（契约允许）。
- **文件清单**：
  - 新增：`src/shared/copy.ts`、`src/StatusBadge.tsx`、`src/EmptyState.tsx`、`src/Modal.tsx`、`src/Toast.tsx`、`src/CommandPalette.tsx`、`src/shared/deeplink.ts`、`src/shared/deeplink.test.ts`、`docs/team/layout-implementation-layout.md`、`docs/team/layout-implementation-ux.md`、`docs/team/layout-final.md`（本文件）
  - 修改：`src/App.tsx`、`src/TeamDashboard.tsx`、`src/TaskStarMap.tsx`、`src/styles.css`
  - 删除：`src/App.tsx` 内 `RouterView`（C10）与死代码 `TeamView`
  - 生成（不手工修改）：`dist/`、`dist-electron/`
- **变更记录**：
  - t20：C01/C03/C06/C09/C10/C14 实现（详见 `layout-implementation-layout.md`）
  - t25：C14 定位居中、C09 窄窗自动折叠、C03 aria-current 三项修复
  - t21：C11/C12/C24/C25/C26 实现（详见 `layout-implementation-ux.md`）
  - t24（本任务）：`src/App.tsx` 修复 IF-01（Hooks 顺序）；新增本文件；未改动任何未采纳项
