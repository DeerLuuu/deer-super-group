# DeerSuperGroup 性能、布局技术约束与可实现性审计（t183）

- **任务**：t183 `[work]` 审计：性能、布局技术约束与可实现性（只审计，不写代码）
- **输入**：`docs/team/ux-audit-agenda.md`（t179 §1 屏幕清单 / §3 性能维度 / §5 关键问题）
- **审计基线**：`main` `20f7a31`（2026-11-12 00:18；代码最近提交 `f3737d9`，之后仅 docs）；构建产物 `dist/` 来自 `f3737d9` 后 t178 集成，406 modules
- **版本**：React 19.3.1 / dockview 8.9.0 / zod 4.6.7 / react-markdown 10.1.0 + remark-gfm 4.0.1 / Vite 8.3.6 / Electron 45.2.3
- **约束**：只读代码 + 只读测量；未改 `src/`、`electron/`、`dist/`、`dist-electron/`。临时 code-split 构建与 esbuild 归因输出均在 `%TEMP%`，审计后删除临时配置，仓库无残留
- **环境限制**：无 Electron 窗口/无 GUI 性能分析器；本文的帧率、堆内存、Electron 启动耗时均**未实测**，用静态代码/构建数据 + 结构性推理给出边界与验证方案

---

## 0. 结论摘要（给评审会的 6 句话）

1. **bundle 略超 1.2MB 是真实问题，但拆分收益有上限**：实测 vendor 构成 `dockview 415KB + react 207KB + markdown 154KB + zod 87KB + 业务 348KB`；首屏业务/面板可拆约 **120KB 原始 JS（≈index chunk 的 35%）**，zod 可随画布/提问/事件校验延迟约 **87KB**；dockview 与 React 属于 Shell 必需，强行延迟只省欢迎页。
2. **当前最贵的不是 bundle，而是「一帧全 App 重渲染」**：App 5.7k 行单组件，`DockShell renderPanel` 为内联函数（App.tsx:2595），每次 App 状态变化（包括**每个流式 token**）都会让所有已挂载面板重新渲染；chat 历史每条消息的 Markdown 每次重解析（ChatContent.tsx:62），流式期是 O(历史消息) 的重复工作。
3. **事件刷新链路过重**：任何 `app:event` 触发 220ms 防抖后同时拉 `getSnapshot`（全部 tasks/mailbox/board/settings）+ scheduler + watchdog + **`getTaskTrace`（最多 2000 事件）** + `listRuns`（App.tsx:819-834），并把新 snapshot 灌回 App；长任务期间会持续 5 个 IPC + 大对象克隆 + 全树渲染。
4. **面板常驻策略不统一**：chat/tasks/team 等 `always` 常驻（DockShell:124 + panelRegistry），启动即挂 chat + 隐藏 tasks + team/星图；mailbox/board/polls/watchdog `onlyWhenVisible`，切 tab 卸载、局部状态丢失/重开重取。默认布局还会创建未激活的 tasks 面板，等于首屏多渲染一个 TasksView。
5. **布局的主要硬约束是 minWidth 与 px 字号**：960px 最小窗 + 侧栏 250 → Dock≈710（single 变体），1100px 窗 → Dock≈850（narrow，主组仅 442px）却仍声明 tasks 面板 minWidth 560，存在约束冲突；全站 0 个 `rem`，body 14px/tiny 12px 为最近 t184 抬升，但仍有大量 10–11px 组件级硬编码，无应用内字号/缩放设置。
6. **聊天历史/工具轨迹/星图/Diff 都有明确边界**：聊天固定 100 条消息、无虚拟化且无「加载更早」入口；`getChatTurns` 每次加载 200 消息 + 2000 事件只为拼 20 轮；trace 上限 2000；星图全量任务节点；Diff 已做 300 行分页 + 200 行窗口（相对最健康）。聊天与事件刷新是下一轮必须处理的 P0 性能项。

---

## 1. 审计方法与证据口径

| 项 | 做法 |
|---|---|
| 代码阅读 | `src/App.tsx`（5,705 行）、`src/shell/dock/*`、`src/ChatContent.tsx`、`src/TaskStarMap.tsx`、`src/review/ui/ReviewSection.tsx`、`src/kernel/{service,store,chatTurnProjection}.ts`、`src/shared/interactive.ts`、`src/styles.css`、`electron/main.ts` |
| 构建测量 | 读取当前 `dist/` 产物与 t178 集成文档的 Vite 输出；未重跑 `pnpm build`（避免改 `dist/`） |
| 拆分实验 | 临时 Vite 配置（`%TEMP%`）以 `manualChunks` 重建到 `%TEMP%`，得到 react/dockview/zod/markdown/业务 chunk 的真实尺寸与 gzip 值；配置与产物审计后删除，未改仓库 |
| 模块归因 | 临时 esbuild 生产 bundle + metafile（`%TEMP%`）按 input bytes 归因到 src 面板/依赖，作为**相对估算**（esbuild 与 Vite tree-shaking 口径不同，绝对值以 Vite 为准） |
| 未测项 | Electron 进程首屏、DevTools Performance 帧耗时、堆快照、真实 200% 缩放、Dock 拖拽极限；建议 t185 在真机补基线 |

---

## 2. 当前构建与依赖事实

### 2.1 当前 Vite 产物（main `f3737d9` 后，406 modules）

| 产物 | 原始大小 | gzip |
|---|---|---|
| `dist/assets/index-*.js`（单 chunk，无人工拆分） | **1,223.51 kB** | **335.10 kB** |
| `dist/assets/index-*.css` | 245.15 kB | 29.52 kB |
| `dist-electron/main.cjs` | 1,586,283 B（≈1.5 MB） | — |
| `dist-electron/preload.cjs` | 12,008 B（≈9.8 kB） | — |

Vite 每轮构建都会报 `chunks larger than 500 kB`；目前**没有任何 `React.lazy` / `import()` / manualChunks**（`src/main.tsx` 直接 `import App`，App 顶层静态 import 全部面板与 Modal）。

### 2.2 临时 code-split 实验（同一源码，Vite 生产构建，输出到 `%TEMP%`）

| chunk | 原始大小 | gzip |
|---|---|---|
| `index`（业务入口：App + 所有静态面板/组件/样式） | 347.92 kB | 98.57 kB |
| `vendor-dockview` | **414.89 kB** | 97.22 kB |
| `vendor-react`（react/react-dom/scheduler） | 206.75 kB | 64.81 kB |
| `vendor-markdown`（react-markdown/remark/mdast/hast/micromark/unified） | 154.38 kB | 45.38 kB |
| `vendor-zod` | 87.21 kB | 24.79 kB |
| `vendor`（其余第三方） | 10.25 kB | 4.34 kB |
| `rolldown-runtime` | 0.72 kB | 0.42 kB |
| CSS：`index` / `vendor-dockview` | 109.11 / 136.04 kB | 18.91 / 10.89 kB |

> 结论：拆分本身**不改变总量**（约 1.22MB / 335KB gzip），但证明 vendor 与业务的比例：**dockview 34%、业务入口 28%、React 17%、Markdown 13%、zod 7%**。只有 **懒加载（动态 import）** 才能降低首屏解析/内存；vendor 拆分只改善缓存/可读性（Electron 本地加载收益有限）。

### 2.3 业务面板/模块的静态归因（esbuild 估算，单位 KB；用于挑选可懒加载面板）

| 模块 | 估算 | 默认挂载/可视 | 懒加载候选 |
|---|---|---|---|
| `App.tsx`（含全部内联视图：ChatView/TasksView/TeamDashboard 等） | 97.1 | 是 | 否（需拆分 App 才有效，见 R12） |
| `src/shell/MemoryWorkbench.tsx` | 31.9 | 否（board tab，onlyWhenVisible） | **是（首屏不在）** |
| `TaskStarMap.tsx`（TeamDashboard 内） | 25.1 | 是（team 默认可见；single 变体不默认） | 条件（见 R9） |
| `SettingsView.tsx` | 18.6 | 否（Modal） | **是** |
| `poll/PollPanel.tsx` | 17.6 | 否（默认关闭） | **是** |
| `TeamDashboard.tsx` | 15.6 | 是（非 single） | 条件 |
| `ReviewSection.tsx` | 12.3 | 条件（任务详情选中） | **是** |
| `RunPanel.tsx` | 9.8 | 否（默认关闭） | **是** |
| `git/ui/GitPanels.tsx` | 9.7 | 条件（Modal/任务 VCS） | **是** |
| `RunHistory.tsx` | 9.1 | 条件（任务详情） | **是** |
| `CommandPalette` | 6.3 | 否（⌘K） | **是** |
| `watchdog`（Panel/Alert/Budget ≈） | 5.6 | 否（默认关闭） | **是** |
| canvas 目录（CanvasArtifact/layout/export/…） | 45.2 | chat 内（默认可能） | 否（聊天主路径） |
| `shared/interactive.ts` + `interactive/` | 19.1 + 14.7 | chat 内 | 否（聊天主路径） |

> 上表来自 esbuild metafile 的 `bytesInOutput`，与 Vite tree-shaking 有差异，仅作**相对排序**；真正的收益以 R4 的 lazy 边界 + 实测 chunk 验收。

### 2.4 运行时架构事实（比 bundle 更关键）

| 事实 | 位置/参数 | 影响 |
|---|---|---|
| App 单组件 5,705 行，统一持有 snapshot/chat/questions/polls/watchdog/review 等 | `src/App.tsx` | 任一下沉状态更新都重渲染整棵 App 树 |
| `DockShell renderPanel={(key)=>...}` 为内联函数 | App.tsx:2595 | 新 identity → `PanelContentContext` value 变化 → 所有已挂载面板重渲染 |
| dockview `always` 面板保持挂载（即使 tab 不可见） | DockShell.tsx:115-129；`DockviewPanelRenderer = 'onlyWhenVisible' \| 'always'`（dockview-core `overlayRenderContainer.d.ts`） | chat/tasks/team（及打开后的 runs/context）常驻 DOM/Effect/状态 |
| 默认布局创建 chat + tasks + mailbox + board 四个主组 tab + team 右组 | DockShell.tsx:142-176、panelRegistry `MAIN_GROUP_ORDER` | 启动即挂载 chat、**隐藏的 tasks**、team（星图）；mailbox/board 因 onlyWhenVisible 不挂 |
| 事件刷新 220ms 防抖后做 5 类读取 | App.tsx:819-834、1022-1029 | getSnapshot（全量 tasks/mailbox 200/board）+ scheduler + watchdog + trace 2000 + runs |
| 流式事件直接 `setChatStream(prev+text)` / reasoning / tool 追加 | App.tsx:1181-1220 | 每个 token/工具事件触发全 App 重渲染 |
| Chat 无 memo、无虚拟化；ChatContent 每次 render 重新 parse + Markdown | App.tsx:4795、5566；ChatContent.tsx:62；Markdown.tsx:5-9 | O(历史消息 × Markdown) 每帧；100 条消息封顶 |
| `listChat` 固定 100 条；`getChatTurns` 固定 200 消息 + 2000 事件、返回 20 轮 | service.ts:685、819-873；chatTurnProjection.ts:18-19 | 每次打开/每轮结束（done/cancel/retry）都重算一次大历史 |
| `getTaskTrace` 固定 2000 事件 | service.ts:2189-2190 | 每次事件刷新都拉取选中任务全 trace |
| 聊天工具/思考数组在轮内无上限 | App.tsx:297-298、1199-1220 | 长 Agent 轮次（多 step/工具）数组线性增长并每事件重渲染 |
| Diff 已分页/窗口化 | ReviewSection.tsx:77（300 行/页）、217（200 行窗口）、364-381（上一页/下一页） | 大文件可控，但整个文件 diff 仍会逐步追加进内存 |
| 星图全量任务节点 + SVG 边；LOD 标题阈值 0.55/0.9、MAX_LABELS=24 | TaskStarMap.tsx:28-32、227+ | 100–200+ 任务时 DOM/SVG 与布局成本上升；无节点上限 |
| 无 rem；t184 后 body 14px/tiny 12px，但仍有 10–11px 组件级字号；6 个 container query | styles.css:42/7319、70/7510；@container 6 处 | 大字体重排只能靠全局 zoom，无应用内字号设置 |
| 窗口 1440×920，min 960×700 | electron/main.ts:59-64 | 960 宽时 Dock≈710，single 变体 |

---

## 3. 性能边界评估

| # | 表面/路径 | 当前行为与上限 | 最坏情况 | 风险 | 结论/对应建议 |
|---|---|---|---|---|---|
| P1 | 聊天流式 + 长历史 | 100 条消息全渲染；每 token 全 App 重渲染；每条助手消息 Markdown 重新 parse；无 memo/虚拟化 | 100 条长代码块 + 长回复流式：每 token 重解析全部历史，主线程掉帧、输入卡顿 | **高** | R1/R2/R7 |
| P2 | 聊天历史加载 | loadChat：listChat 100 + getContext + getChatTurns(200 消息+2000 事件→20 轮) + questions，每次 done/cancel/retry 触发 | 长会话每轮结束多一次大 IPC + 主进程投影计算；UI 白屏/延迟感 | **高** | R3/R7 |
| P3 | 全局事件刷新 | 220ms 防抖后 5 个 IPC（snapshot/trace 2000/scheduler/watchdog/runs）+ 全树渲染 | 运行中高频工具事件 → 每秒多次全 App 重渲染 + 大对象克隆；GC/卡顿 | **高** | R3 |
| P4 | 工具 payload / 轨迹 | 服务端事件 payload 截断、UI 4000 字；轨迹页 200 消息 + 500 事件全渲染；历史 step/tool 折叠 | 轨迹页一次渲染 500 条事件与大量 pre；长工具体积仍可读但 DOM 大 | 中 | R8 |
| P5 | 任务 trace | `getTaskTrace` 固定 2000 事件，任务页/Run 面板渲染 trace | 长任务 2000 事件每次事件刷新重新拉取；任务页长列表 | 中高 | R3/R8 |
| P6 | 星图 | 全量任务节点 + SVG 边；LOD 只降标签密度；无节点上限 | 200+ 任务：首屏/过滤/缩放重绘昂贵；team 默认可见 | 中 | R9 |
| P7 | Review diff | 300 行/页、200 行窗口 + 分页；线程/评论列表全量 | 数千行文件需多次 load-more，但单次渲染受控；评论很多时列表长 | 低-中 | R8（保留窗口策略） |
| P8 | 记忆/Poll/Watchdog 面板 | onlyWhenVisible；打开时组件挂载并拉取（Poll/Memory 内部 fetch）；关闭/切 tab 卸载 | 重开需重新请求；局部筛选/滚动丢失；无跨面板保活 | 中 | R11 |
| P9 | 多面板 Dock | dockview 415KB；always 面板常驻；每 App 渲染全部 panel 重渲染 | 打开 chat+tasks+team+runs+context 时 DOM/渲染树大，隐藏面板仍参与渲染 | 中高 | R2/R11 |
| P10 | 首次打开工作区 | 默认创建 4 tab + team；chat/tasks/team 三面板首帧；TaskStarMap 若已有任务即布局 | 任务多/历史长时启动卡顿；welcome→workspace 切换需解析全部 App+面板代码 | 中 | R4/R11 |

---

## 4. 常驻 vs 二级面板 / 弹窗

### 4.1 当前策略矩阵

| 面板 | renderer | 默认 | 状态保持 | 内存/渲染成本 | 备注 |
|---|---|---|---|---|---|
| chat | always | 可见 | 切 tab 保持（DOM/滚动/输入） | 高（消息树） | 主流程，必须保持 |
| tasks | always | 隐藏 tab | 保持 | 高（列表+详情+Review/RunHistory/执行 trace） | 启动即挂载，首屏隐性成本 |
| team | always | 可见（非 single） | 保持 | 中高（成员+星图） | 首屏可见，星图成本随任务数 |
| runs | always | 关闭 | 保持（打开后） | 中（调度+Run+时间线） | 默认关闭；打开后常驻 |
| context | always | 关闭 | 保持（打开后） | 低-中（20 条历史 + system prompt） | 无 route |
| mailbox | onlyWhenVisible | tab | **切走卸载**（选中项 App 提升） | 中 | 切回重挂载 |
| board | onlyWhenVisible | tab | **切走卸载**（选中项提升；内部筛选/滚动丢失） | 中高（MemoryWorkbench 31.9KB） | 重开重新取数 |
| polls | onlyWhenVisible | 关闭 | 卸载 | 中（PollPanel 内部 fetch） | 无 route，发现性弱 |
| watchdog | onlyWhenVisible | 关闭 | 卸载 | 中（snapshot 来自 App） | 告警 topbar 常驻 |
| settings | Modal（Dock 注册表退场） | 关闭 | 关闭即销毁（草稿由 Settings 自己管理） | 低（静态 import，未挂载） | 1180×88vh Modal |

### 4.2 结论

- **首屏不必要成本**：tasks 面板默认创建 + `always` → 即使未点「任务」tab 也已挂载 TasksView（SchedulerBar/列表/选中详情）。建议改成**首次激活时挂载、之后保持（keep-alive）**；若需要状态恢复，把筛选/选中/滚动位置提升到 App 或 URL（部分已提升）。
- **二级面板/弹窗的取舍**：
  - 长时间比较/多步操作（合并队列、Review、Run 历史）用 Modal 会丢失上下文、阻塞对比；但这些目前多数在任务详情内联（Review/RunHistory）或 Modal（合并队列）——评审会应确认合并队列是否升为面板（结构改动，S/M）。
  - 短表单/危险确认 Modal 合理（Esc/焦点/回滚）；关闭即销毁无内存负担。
  - 设置 Modal 内容长（7 段，min(1180,96vw)、88vh），在 960 窄窗/200% zoom 下接近全屏，可接受但应补窄窗测试。
- **状态保持**：`always` 保持的是**组件状态**而非数据一致性；App 每次事件刷新用新 snapshot 替换数组，面板会重渲染但数据来自服务端，不需要保活来“防丢”。因此可对重面板用 onlyWhenVisible + App/URL 提升关键状态，换取内存与首屏。

---

## 5. 布局技术约束（窄窗 / 多面板 / 大字体）

### 5.1 窗口与 Dock 尺寸算术

- Electron：1440×920 默认，**min 960×700**（electron/main.ts:59-64）；侧栏 250（可 180–480/折叠）。
- Dock 宽度 ≈ 窗口 − 侧栏：1440→1190（wide ≥1100）；1200→950（medium 900–1100）；1100→850（narrow 760–900）；960→710（**single <760**）。
- 变体权重（panelRegistry.ts:171-187）：wide main 58%、medium 56%、narrow 52%、single 100%。
- 由此：**1100 窗在 narrow 时主组仅 442px、右组 408px；1200 窗 medium 主组 532px**。

### 5.2 面板 minWidth 与分组宽度的冲突

| 面板 | minWidth | narrow 主组 442 | medium 主组 532 | wide 主组 690 | 结论 |
|---|---|---|---|---|---|
| chat | 420 | ✅ 勉强 | ✅ | ✅ | 安全 |
| tasks | **560** | ❌ 冲突 | ❌ 冲突 | ✅ | **需放宽或改布局** |
| mailbox | 480 | ❌（主组 tab 时） | ✅ | ✅ | 窄窗需降级 |
| board | 360 | ✅ | ✅ | ✅ | 安全 |
| team（右组） | 360 | 408 ✅ | 418 ✅ | ✅ | 安全 |
| runs / context / polls / watchdog | 380/280/430/420 | 需单组/浮动 | 视分组 | 视分组 | 取决于拆分 |

> 关键：`tasks` minWidth=560 在 narrow（442）与 medium（532）不可满足；dockview 会按约束压缩/溢出，当前没有“自动切 single / 提示用户 / 放宽 minWidth”的守卫。**这是必须改结构/注册表策略的一项**（R10），仅改 CSS 不够。

### 5.3 Modal / 浮层

- 基础 Modal：`width: min(620px, 100%)`、`max-height:min(760px,90vh)`、backdrop padding 24（styles.css:3727）；窄窗安全。
- 设置 Modal：`width: min(1180px, 96vw)`、`max-height:88vh`（styles.css:3737）；960 窗时约 922×88vh，7 段长表单接近全屏，内部滚动可用。
- 合并队列/Review 等表格类弹窗部分使用固定 `width: 900/1100px` 的规则（styles.css 中仍有多处 700/900/1100px 固定宽）；在 960 窗或 200% zoom 下需要统一检查 `max-width:100%`，否则横向溢出。**CSS 可解，但要逐表面验证**。

### 5.4 大字体 / 200% 缩放

- **0 个 `rem`/`em` 字号**：全部字号为 px；body 14px、tiny 12px（t184 抬升），但组件级仍有 10px/11px（如 `.sidebar-panel-hint kbd` 10px；大量旧规则 10–11px）。用户系统“更大字体/文本缩放”不会生效（px 固定）。
- 放大只能靠 **Electron 缩放**（默认菜单 Ctrl+/−/0；本项目 `autoHideMenuBar` 但默认 role 仍可能可用——未实测）或 OS 显示缩放；**没有应用内字号/缩放下限设置**。
- 200% 缩放下，960×700 窗口的 CSS 视口≈480×350：Dock 进入 single；Modal 96vw≈460px；固定 900/1100px 的表格/队列弹窗会溢出；`@media` 断点按 CSS px 触发，因此多数会切到窄布局，但缺少针对 480px 宽度与 350px 高度的验证。
- 现有 6 个 `@container`（team/run-panel/scheduler）已覆盖部分面板窄容器；chat/tasks/review/memory 尚未容器化。
- 固定高度（27–78px 多处、dock tab 34px、textarea rows）在 zoom 下按比例缩放，不直接裁切；但视口变小后可用高度不足，需测滚动与焦点可见。

### 5.5 结构 vs CSS 分类

| 需求 | 只需 CSS | 必须改结构/注册表 |
|---|---|---|
| 窄窗内边距/换行/溢出 | ✅（min-width:0、overflow-wrap、flex-wrap、container query） | — |
| tasks minWidth 冲突 | — | ✅（放宽 registry minWidth 或自动切 single/分组守卫） |
| Modal 固定宽溢出 | ✅（max-width:100%/clamp） | — |
| 字号抬升/200% 缩放 | 部分（统一 CSS 变量/clamp） | 应用内字号设置需 App/设置/IPC（小结构） |
| 首屏/隐藏面板成本 | — | ✅（懒挂载、renderPanel memo、面板策略） |
| 聊天长历史 | 局部（高度/滚动） | ✅（分页/虚拟化、消息 memo） |
| 多面板状态保持 | — | ✅（keep-alive 策略/状态提升） |

---

## 6. 建议（12 条：成本 S/M/L、风险、依赖、时机）

> 「现在做」= 本轮 UX 评审后第一批；「下轮」= 需要独立任务/API 变更；「不建议」= 本轮明确不做。成本为单人体感（S ≤0.5d、M 1–2d、L >3d）。

| ID | 建议 | 类型 | 成本 | 风险 | 依赖 | 时机 |
|---|---|---|---|---|---|---|
| **R1** | **聊天流式渲染隔离**：`memo(ChatBubble)` + 把 streaming 气泡独立为子树（stream 状态下沉到 ChatView 内部/local store）+ `parseChatContent`/Markdown 结果按 content 缓存；token 合并到 rAF 批量刷新 | 结构 | M | 中：memo 需稳定 props；流式样式/自动滚动需回归 | 当前 ChatView props 已集中，可在 App 之前先拆 stream state | **现在做** |
| **R2** | **面板渲染隔离**：`renderPanel` 改 `useCallback`/Context 拆分，避免内联函数导致所有面板重渲染；对 TeamDashboard/TasksView/MemoryWorkbench 等 `memo`；把 snapshot 按域拆 context（tasks/chat/board/watchdog） | 结构 | M | 中：context 拆分涉及 App 大改；可先做 memo + 稳定回调（低风险） | App.tsx 5.7k 行重构（可渐进） | **现在做**（先 S 步：稳定 renderPanel） |
| **R3** | **事件刷新降噪**：220ms→300–500ms 可配；仅刷新 dirty 域（事件 type→domain 映射）；隐藏面板不刷新（或标 stale 后首次可见刷新）；`getTaskTrace` 改按 run/分页/增量，不再每次 2000 全量；`getSnapshot` 拆 `tasks/snapshot` 与 mailbox/board 惰性 | 结构 | M | 中高：事件驱动一致性/漏刷新；需要 kernel 事件类型稳定（已有 type/aggregate） | 事件目录（kernel 事件注册表已存在）、IPC 扩展 | **现在做**（先做 trace 分页 + 500ms 两档） |
| **R4** | **按需加载重面板 + vendor 拆分**：`React.lazy` 设置/记忆/Poll/Run/Review/Git/看门狗/命令面板；Vite `manualChunks` 固定 react/dockview/markdown/zod 便于缓存；首屏保留 chat/team/canvas。预期从 index 347.9KB 移出约 120KB（≈35%） | 结构 | S-M | 低-中：Suspense 闪 loading、首开面板延迟；需 loading 态 | 无新依赖；建议先 R2 再 R4 | **现在做** |
| **R5** | **CSS 布局硬化**：`min-width:0`/`overflow-wrap`/`flex-wrap` 补齐；Modal/表格 `max-width:min(100%, …)`；chat/tasks/review/memory 补 container query；去掉副作用固定的 min-height/height；统一 `:focus-visible` | CSS | S | 低 | 无 | **现在做** |
| **R6** | **构建/性能预算门禁**：在脚本/CI 加 JS/CSS 体积预算（如 initial JS ≤1.25MB raw、≤340KB gzip；新增依赖需显式加预算），输出 chunk 报告；禁止再次无感知增长 | 结构（脚本） | S | 低 | R4 的 chunk 划分 | **现在做** |
| **R7** | **聊天历史分页/虚拟化**：用已有 `getChatTurns` cursor + `hasEarlierMessages`（当前 UI 未用）实现「加载更早」；默认只渲染最近 N（30–50）条/轮；>100 条再考虑虚拟列表；保留搜索/定位 | 结构 | M | 中：滚动锚定、aria-live、复制全文 | 服务端 cursor 已存在；UI 需新增状态 | **下轮** |
| **R8** | **Trace/工具/轨迹分页**：任务 trace 按 aggregate（run/step）分页；轨迹页按需渲染事件（默认最近 N）；工具/思考数组轮内设上限（如工具 100、思考段 50，超出折叠为“更多”）；Diff 保持 300/200 窗口 | 结构 | M | 中：审计完整性要求（trace 需可全量查看） | service/IPC 分页参数 | **下轮** |
| **R9** | **星图密度策略**：任务数 >150 时默认只显示当前任务 1–2 跳邻域/按状态过滤；节点上限/分页提示；布局与边 memo 化；必要时 canvas 渲染（>300 节点） | 结构 | M | 中：可读性/完整视图诉求；需 UX 裁决 | TaskStarMap 已有 filter/LOD | **下轮** |
| **R10** | **Dock minWidth/变体守卫**：将 tasks 560 在 narrow/medium 的冲突改为「自动 single / 提示 / 放宽到 420」；拆分组时校验最小和；right 组 team 在 single 下的入口保留（已有面板菜单） | 结构（registry+CSS） | S | 中：布局存档兼容（deer.dock.v1） | panelRegistry/DockShell；t50 存档约束 | **下轮**（若本轮布局评审要动 Dock 则提前） |
| **R11** | **面板状态策略**：明确 keep-alive 列表（chat/tasks/team 保持；memory/poll 首次激活挂载后保持；其余 onlyWhenVisible）；收起/关闭面板的恢复入口与滚动/筛选持久化（URL/会话级/localStorage） | 结构 | M | 中：状态丢失/恢复歧义；需 UX 决策 | DockShell renderer、App 状态提升 | **下轮** |
| **R12** | **本轮不做**：引入 Monaco/自研 canvas 图表/第三方虚拟列表/React Compiler 或拆微前端；在 R1–R6 完成并建立真机性能基线前，避免以重依赖换未知收益 | — | L | 高：依赖/维护/包体反增 | R1–R6 基线 | **不建议（本轮）** |

---

## 7. 优先级与预期

### 7.1 现在做（P0，建议本轮布局评审后立即拆任务）

1. **R1 流式隔离**（用户体感最直接：打字/滚动/流式不再全树抖动）
2. **R2 面板渲染隔离**（低成本先做稳定 `renderPanel` + memo，再评估 context 分域）
3. **R3 事件刷新降噪**（先做 trace 分页 + 刷新间隔两档；防止长任务把 UI 拖垮）
4. **R4 懒加载重面板 + vendor chunk**（先测量：初始 index 减少约 120KB；首开面板 loading 可接受）
5. **R5 CSS 硬化 + R6 体积预算**（小成本，防回归）

### 7.2 下轮（P1，需独立设计与验收）

- **R7 聊天分页/虚拟化**：与 t168/t172 的历史投影结合，补「加载更早」；要保证复制/搜索/画布 artifact 在分页边界一致。
- **R8 Trace/工具分页与上限**：涉及 service/IPC 契约，需评审（审计/回放完整性）。
- **R9 星图密度**：需 UX 决策“完整图 vs 局部图”，先做过滤/LOD 增强。
- **R10 Dock 布局守卫 / R11 面板状态策略**：与布局评审的“常驻 vs 面板”裁决一起做，避免两次改 Dock。

### 7.3 不建议（本轮）

- **R12**：Monaco、自研 canvas 图、第三方虚拟列表、React Compiler/微前端。当前 1.2MB 与帧抖动主要来自“全 App 重渲染 + 全量刷新 + 无 memo”，先用 R1–R3 消除结构性浪费；引入重依赖会让包体和启动成本进一步上升，且 Electron 本地应用无网络加载优化收益。

### 7.4 预期收益（需要 t185 真机基线验证）

| 组合 | 预期 |
|---|---|
| R1+R2 | 流式/事件期间不再重解析全部历史；输入与滚动恢复可交互（具体帧率需真机测量） |
| R3 | 长任务期间 IPC/对象克隆/渲染次数显著下降（按事件类型过滤 + trace 分页） |
| R4 | 初始 entry chunk 原始 JS 约 −120KB（index 347.9→≈228KB，估算），设置/记忆/投票/评审/运行面板首开加载；vendor 缓存可读 |
| R5+R6 | 窄窗/200% zoom 溢出减少；构建体积不再无感增长 |
| R7+R8 | 聊天/轨迹/任务页 DOM 与内存上限可控（由 100/200/2000 上限转为分页 + 窗口） |

---

## 8. 需要评审会裁决的问题（技术）

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| Q1 | 首屏性能预算 | A 1.25MB raw / 340KB gzip；B 1.0MB / 300KB；C 不设硬预算只监控 | **A + 监控**（先防增长，再优化） |
| Q2 | 聊天历史 | A 100 条封顶（现状）；B 最近 30 条 + 加载更早（分页）；C 虚拟列表 | **B 本轮/下轮**，虚拟列表等实测再定 |
| Q3 | 面板 keep-alive | A 全 always（现状，内存高）；B 首激活挂载后保持；C 重面板 onlyWhenVisible | **B**（chat/tasks/team 保持，重面板首次挂载后保持；需要恢复入口） |
| Q4 | 大字体支持 | A 只靠 Electron zoom；B 应用内字号档位（CSS 变量/rem）；C 本轮不做 | **B 下轮**（至少 3 档 + 200% 测试） |
| Q5 | Dock minWidth | A 放宽 tasks 560→420；B 冲突时自动 single/提示；C 保持并接受溢出 | **B（校验+提示）**，A 作为兜底 |
| Q6 | 真机性能基线 | 是否在 t185 用 DevTools Performance/内存快照执行 5 个脚本（长聊天流式、长任务事件、200 任务星图、大 Diff、窄窗多面板） | **是**（否则本文的边界无法量化） |

---

## 9. 证据附录

### 9.1 关键代码位置

| 主题 | 位置 |
|---|---|
| App 单组件/内联 renderPanel | `src/App.tsx:2595`（`renderPanel={(key) => ...}`），App 共 5,705 行 |
| 事件刷新链 | `src/App.tsx:819-834`（refresh：snapshot+scheduler+watchdog+trace+runs）、`:1022-1029`（220ms） |
| 流式事件 | `src/App.tsx:1181-1220`；chatTools/segments 状态 `:297-298` |
| 聊天渲染 | `src/App.tsx:4554`（ChatView）、`:4795`（messages.map）、`:5566`（ChatBubble）；`src/ChatContent.tsx:62`（每次 parse）；`src/Markdown.tsx:5-9` |
| 历史上限 | `src/kernel/service.ts:685`（listChat 100）、`:819-873`（getChatTurns）；`src/kernel/chatTurnProjection.ts:18-19`（200 消息 / 2000 事件） |
| trace | `src/kernel/service.ts:2189-2190`（2000 事件） |
| Diff | `src/review/ui/ReviewSection.tsx:77`（300/页）、`:217`（200 行窗口）、`:364-381`（翻页） |
| Dock | `src/shell/dock/DockShell.tsx:115-129`（renderer/min）、`:142-176`（默认布局）；`src/shell/dock/panelRegistry.ts:41-157`（renderer/default/minWidth/variant） |
| 星图 | `src/TaskStarMap.tsx:28-32`（LOD/MAX_LABELS）、`:227`（buildGraph）、modelKey memo |
| 字号/布局 | `src/styles.css:42`、`:70`（旧）、`:7319`、`:7510`（t184 override）；`@container` 6 处；`:3727`（.modal）、`:3737`（.settings-modal） |
| 窗口 | `electron/main.ts:59-64`（1440×920 / min 960×700） |
| 面板 minWidth | `src/shell/dock/panelRegistry.ts` 各 PanelDef |

### 9.2 测量命令（只读/临时目录，不写仓库）

```powershell
# 当前产物（t178 后的 dist，未重跑 build）
Get-ChildItem dist\assets,dist-electron -File | Select-Object Name,Length
# → js 1,223,517 B / css 245,156 B / main.cjs 1,586,283 B / preload 12,008 B

# 临时 code-split 构建（config 与 outDir 均在 %TEMP%；审计后删除 config）
npx vite build --config <temp>/audit-vite.config.ts   # manualChunks: react/dockview/zod/markdown/other
# → index 347.92kB; vendor-dockview 414.89kB; vendor-react 206.75kB;
#   vendor-markdown 154.38kB; vendor-zod 87.21kB; vendor 10.25kB

# 临时 esbuild 生产归因（metafile；仅用于 src 面板相对排序）
esbuild src/main.tsx --bundle --minify --metafile=<temp>/meta.json ...
```

### 9.3 已知缺口

- 未执行真机 Electron 启动/帧率/堆/键盘 zoom 实测；本文的「高/中/低」是结构判断，不是帧数据。
- esbuild 归因与 Vite/Rolldown tree-shaking 口径不同，依赖百分比以 Vite split 实验为准。
- 审计期间 main 仍可能有并发提交（本文件基线 `20f7a31`；代码末次提交 `f3737d9`）；实现前需在最新基线复测。

---

> **一句话**：先修「重渲染/全量刷新/无 memo」这三类结构性问题（R1–R3），再做懒加载/预算/CSS 硬化（R4–R6）；聊天分页、trace 分页、星图密度、字号与 Dock 守卫属于下一轮，由 t185 真机基线与布局评审共同裁决。
