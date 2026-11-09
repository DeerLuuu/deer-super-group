# 主界面 Dock 布局设计（VSCode 风格 · 对话 / 团队双主面板）

- **任务**：t49｜主界面 Dock 布局设计（设计文档，不写代码）
- **日期**：2026-11-09
- **作者**：sol（系统工程师 · 信息架构）
- **输入**：`src/App.tsx`（2499 行）、`src/CommandPalette.tsx`、`src/TeamDashboard.tsx`、`src/TaskStarMap.tsx`、`src/SettingsView.tsx`、`src/styles.css`（2876 行）、`src/shared/deeplink.ts`、`electron/main.ts`、`docs/team/layout-final.md`（第一轮 11 项已实现）
- **状态**：设计提案。实现另开任务；本文件不改任何代码。

---

## 0. 决策摘要（TL;DR）

| 项 | 决策 |
|---|---|
| 库 | **dockview-react 8.9.0（MIT core）**，精确锁版本；备选 flexlayout-react（切换被适配层隔离） |
| 面板模型 | 7 个单例面板：`chat`(对话) / `team`(团队) / `context`(上下文) / `tasks`(任务) / `mailbox`(邮箱) / `board`(黑板) / `settings`(设置) |
| 默认布局 | 根横向分栏：主组 **58%**（对话激活；任务/邮箱/黑板/设置作为同组 tab）+ 团队组 **42%**；**上下文默认关闭**，按需打开 |
| 多 dock 区 | 最多 **4 个组**；tab 可跨组拖动、拖到组边缘拆分、拖回合并；组内重排；关闭最后一个 tab 自动收起组 |
| 持久化 | `localStorage["deer.dock.v1.<workspaceId>"]`，按 **变体（wide/medium/narrow/single）** 分别记忆用户布局；版本化 + 校验 + 损坏回退默认 |
| 导航 / hash | 6 个导航入口全部改为 `openPanel(key)`；`activePanelId` 是唯一真相；`activePanel → RouteTab` 映射沿用现有 `deeplink.ts`（schema 不变，`deeplink.test.ts` 不用改） |
| 命令面板 | 新增「面板」命令组：打开 / 关闭当前 / 移动当前面板（四个方向 + 新分栏）/ 重置布局 / 恢复默认比例 |
| 键盘 / ARIA | 复用 dockview 的 WAI-ARIA 基线（tablist/tabpanel/region、roving tabindex、live region、focus-visible）；自建 `F6`、`Ctrl+Alt+方向键`、`Ctrl+Alt+W` 等快捷键；**不使用** enterprise 的键盘 docking |
| 响应式 | 按 dock 容器宽度选变体：≥1100 wide（58/42）、900–1099 medium（56/44）、760–899 narrow（52/48）、<760 single（单组 tab + 恢复双栏提示） |
| 对话/团队比例 | wide 58/42（1440 窗口 ≈ 668/484px）；medium 56/44（1100 窗口 ≈ 563/443px）；narrow 52/48 |
| 不做（v1） | 浮动组、弹出窗口、edge groups、pinned tabs、多行 tab、布局历史、画布渲染、拖拽持久化节点坐标 |

---

## 1. 目标、范围与约束

### 1.1 目标

1. 主界面从「单视图切换」升级为「VSCode 式多面板工作台」：**对话与团队是两个主面板，默认同时可见**。
2. 支持：多个 dock 区、tab 跨区拖动、拆分/合并、拖动分隔条调整大小、关闭/重开、布局持久化。
3. 侧栏 6 个导航入口打开/聚焦对应面板；hash 深链、命令面板、设置、任务、邮箱、黑板继续可用。
4. 键盘 / ARIA 可用；窄窗可用。

### 1.2 范围

- **在范围内**：前端 shell 层（布局容器、面板注册、导航/hash/命令面板对接、布局持久化、键盘与 ARIA、响应式变体、CSS 收口）。
- **不在范围内**：后端 / IPC / 数据模型任何改动；星图、任务、邮箱、黑板、设置的功能改动（只做「容器适配 + 上下文面板抽取 + 团队紧凑模式」）；浮动/多窗口；企业版特性。

### 1.3 硬约束

- 不新增后端字段，不改 `shared/index.ts` 的 IPC 面。
- `deeplink.ts` 的 **6 个 RouteTab 与 hash 语法保持不变**（`deeplink.test.ts` 13 条用例必须继续通过）。
- 不重复实现已交付能力（C01/C03/C06/C09/C10/C11/C12/C14/C24/C25/C26），只在其上包一层 dock。
- Electron 窗口当前 `minWidth: 1100`、`minHeight: 700`、默认 1440×920（`electron/main.ts:24–38`），窄窗策略必须在此约束下成立。

---

## 2. 现状分析（基于当前 HEAD）

### 2.1 Shell 与视图

| 现状 | 位置 | 对 Dock 化的含义 |
|---|---|---|
| Shell：`.app` flex → 侧栏（可折叠 56px / 180–480px 可拖）+ resizer + `.main`（`.topbar` 58px + `.content`） | `App.tsx:781–854`、`865–938`、`960–1058`；`styles.css:193,199,237,366,373,435` | `.content` 是单滚动容器（`overflow:auto; padding:16px`），Dock 需要「确定高度、外层不滚、面板自管滚动」，必须替换为 `.dock-host` 并收口高度链 |
| 6 个视图按 `tab` 条件渲染，一次只挂载一个 | `App.tsx:960–1058` | 改为常驻面板（懒挂载 + 可见性事件），视图组件本身复用 |
| 对话：chat + 上下文两栏（280–640 可拖、可隐藏、宽度存 localStorage） | `ChatView` `App.tsx:2129–2371`；`contextWidth` 2164–2170；拖拽 2181–2203；布局 2226–2369；`ContextPanel` 2419+ | 上下文需要升级为独立面板（否则 dock 内再嵌一条 390px 列会把对话压到 <420） |
| 团队：进度头 + 成员 252px + 星图 + 底部详情 ≤190px | `TeamDashboard.tsx:87–89,203–287`；`styles.css:1853` | 团队面板宽度 <560 时需紧凑模式（成员改横排 chips、详情可折叠），否则 42% 宽度放不下 |
| 任务：列表（280–520 可拖/可收）+ 详情 + trace | `TasksView` `App.tsx:1094+`；`styles.css:577` | 作为主组 tab 常驻；内部布局不变 |
| 邮箱/黑板/设置 | 邮箱 `App.tsx:1639+`、黑板 `1898+`、设置 `SettingsView.tsx` | 作为主组 tab；`settings` 为唯一「默认不可关闭」面板（见 §7.4） |
| 顶栏：面包屑（工作区 › 页面 › 对象）+ 失败计数 + ⌘K + ＋新建 + 刷新 | `App.tsx:866–938` | 页面名来源从 `tab` 改为 `activePanelId → panel.title`；其余不动 |
| 侧栏导航：`NAV_GROUPS` 三组 6 项，`aria-current` 按 `tab` | `App.tsx:39–53,816–838` | 改为按 `activePanelId` 高亮；点击调 `openPanel` |

### 2.2 状态与路由

| 现状 | 位置 | Dock 化后 |
|---|---|---|
| `tab: RouteTab` 是当前视图 | `App.tsx:82–83` | 由 `activePanelId` 派生（`RouteTab` 子集）；`tab` 保留为计算值以兼容面包屑/hash |
| hash 同步：tab 变化 push、选中项 replace；hashchange 反向 setTab | `App.tsx:142–158,305–325` | 保留协议；改为 `activePanel → hash` 与 `hash → openPanel`，加防环 guard |
| 路由表：`#/tasks?t=`、`#/team?t=`、`#/chat?task=`、`#/mailbox?m=`、`#/board?b=`、`#/settings`；空 hash 默认 tasks；`#/router` 重定向 tasks | `shared/deeplink.ts:6–79`；测试 `deeplink.test.ts` | **不改 schema**。`context` 面板不参与 hash；关闭的面板在 hash 命中时自动重开 |
| C14 当前任务：`selectedTaskId`（App 级）、`contextTaskId/contextSource`、`starmapFocus` | `App.tsx:84,106–110,597–608` | 保留；「在星图中定位」改为 `openPanel('team') + setStarmapFocus`；对话「返回任务/团队」改为 `openPanel(source)` |
| 命令面板：导航 6 + 新建 5 + 实体（任务/成员/邮件/黑板） | `CommandPalette.tsx:68–145` | 导航动作改 `openPanel`；新增「面板」组；实体跳转前先 `openPanel` |
| 全局快捷键：Ctrl/⌘+B 折叠侧栏、Ctrl/⌘+K 面板、Alt+1–6 切页 | `App.tsx:183–207` | 保留；Alt+1–6 改为 `openPanel(TABS[n])`；新增 dock 快捷键（§10） |
| 全局 Modal / Toast / 空状态 / 错误 banner | `Modal.tsx`、`Toast.tsx`、`EmptyState.tsx`、`App.tsx:940–958,1061–1075` | 全部留在 shell 层，不在 dock 内；面板关闭不销毁这些全局设施 |

### 2.3 样式与 Electron

- `.content` 是唯一滚动容器；各视图用 `height:100%` 链式依赖（tasks/mailbox/chat/team）。Dock 化后必须给每个面板一个「`height:100%` + `overflow:auto`」的宿主，且 `.dock-host` 置 `overflow:hidden`，否则出现三层滚动条。
- 仍存在两段重复的 `@media (max-width:1100px)`（`styles.css:2554,2586`）——不属于本任务，但 dock 变体应由 **容器宽度**（ResizeObserver）决定，而不是继续堆 media query。
- Electron `minWidth:1100` → 侧栏折叠时 dock 可用宽度约 `1100 − 56 − 6 − 32 = 1006px`；侧栏展开时约 `812px`。**narrow（<900）在当前窗口下可通过「展开侧栏」触发**，`single（<760）` 需要将来下调 `minWidth` 才可达（列为待确认项 Q1）。
- `autoHideMenuBar:true`（`electron/main.ts:31`）→ 没有原生菜单，所有快捷键必须在 renderer 注册；dock 库的 enterprise 键盘方案不可用也不依赖。

---

## 3. 库调研与选型

### 3.1 评估维度与权重

| 维度 | 权重 | 说明 |
|---|---|---|
| 功能匹配 | 30% | tab 跨组拖动、拆分/合并、调整大小、关闭/重开、多 dock 区 |
| 持久化与受控性 | 15% | 布局序列化/恢复、受控 API、面板最小尺寸 |
| 键盘 / ARIA | 20% | WAI-ARIA tabs、roving tabindex、焦点管理、live region、键盘等价物 |
| 维护与风险 | 15% | 版本节奏、下载量、license、企业特性边界、React 19 兼容 |
| 体积与依赖 | 10% | gzip 体积、运行时依赖 |
| 集成成本 | 10% | 与现有 CSS/状态/路由的耦合面、迁移成本 |

### 3.2 候选快照（2026-11-09 拉取）

| 项 | flexlayout-react | rc-dock | dockview-react | 自研 |
|---|---|---|---|---|
| 版本 | 0.11.1 | 4.1.0 | **8.9.0** | — |
| License | MIT | Apache-2.0 | MIT（core）；企业特性另售 | — |
| React peer | ^18 \|\| ^19 | >=18（dev 18） | ^16.8 – ^19 | 本项目 React 19.3 |
| npm 周下载（11-02~11-08） | 285,523 | 26,492 | **881,376** | — |
| Bundle（bundlephobia） | 208.8KB min / **52.7KB gzip**，0 运行时依赖 | 189.4KB / 57.7KB gzip + 6 个依赖族（@rc-component tabs/menu/trigger/util/overflow/motion、rc-new-window、bowser 等，依赖估算 ≈ 230KB） | dockview 390.7KB / **90.6KB gzip** + `dockview-core`（估算 ≈ 781KB 未压缩，实际以 rollup 复测为准） | 至少 600–900 行 + 测试，3–5 人日 + 长期维护 |
| 布局模型 | JSON 树 `row → tabset → tab` + `borders`；`weight` 比例；`tabSetMinWidth/minHeight` | `dockbox/floatbox` 树；`PanelData.size`；`panelLock.minWidth/minHeight` | grid `branch/leaf` + `panels`；`api.addPanel({position, minimumWidth/Height, initialWidth/Height})`；`toJSON/fromJSON` | 自定义 |
| Tab 拖动/拆分 | ✅ tab/tabset 拖动、边缘拆分、tab overflow、tab groups、borders（含 overlay） | ✅ 拖拽、float、new window、`dockMove` API | ✅ tab/group 拖拽、边缘 drop zones、touch/pen、外部拖入 | 需自建拖放与命中测试 |
| 调整大小 | ✅ splitter + tabset min/max | ✅ splitter + panelLock min | ✅ splitter + panel min/max（**随布局持久化**）；group constraints 不序列化，需重放 | 需自建 |
| 持久化 | `model.toJson()` / `Model.fromJson()` | `saveLayout()` / `loadLayout()`（**React content 不进序列化**，需按 id 重灌） | `api.toJSON()` / `fromJSON()`；`onDidLayoutChange` 带 reasons | 需自建 |
| 关闭/重开 | `Actions.addTab/removeTab`；`tabSetEnableDeleteWhenEmpty` | `closable` + `dockMove` | `panel.api.close()` / `api.removePanel()` / `api.addPanel()`；空布局 watermark | 需自建 |
| ARIA / 键盘 | README 声明 ARIA roles、可配置 keymap、可见焦点；`tabset.name` 即 tablist 的 `aria-label`（类型文件证实） | 未声明无障碍承诺；类型里有内部 `navigateToPanel`，但无 ARIA/键盘拆分承诺 | **文档详述 WAI-ARIA tabs/tabpanel/region、roving tabindex、Home/End、live region 播报、`:focus-visible`、焦点 API**；空间键盘导航与键盘 docking 为 **Enterprise** | 全自建，WCAG 风险最高 |
| 主题 | 9 套主题 + `--flexlayout-*` CSS 变量 | light/dark less，样式耦合较深 | 主题对象 + `--dv-*` CSS 变量（含 GitHub Dark）、可自定义 | 自建 |
| 主要风险 | 0.x API 变化；a11y 细节需实现前核对（本环境取不到 `docs/accessibility.md` 全文）；ESM-only | 内容不可序列化、无 a11y 承诺、依赖多、下载量低、VSCode 手感弱 | 企业特性边界；group constraints 不持久化；体积最大 | 成本与 bug 风险最高，拖拽/分栏/ARIA 都要重做 |

> 数据来源：npm registry（版本/peer/license）、npm downloads API（周下载，2026-11-02~11-08）、bundlephobia API（体积，近似值）、dockview 官方文档（a11y/serialization/rendering/constraints）、flexlayout README + `IJsonModel.d.ts`、rc-dock README + `DockData.d.ts`。

### 3.3 能力对比矩阵（只列本任务要求）

| 要求 | flexlayout-react | rc-dock | dockview-react | 自研 |
|---|---|---|---|---|
| 多 dock 区 | ✅ rows/tabsets/borders | ✅ box/panel | ✅ grid groups | 需自建 |
| tab 拖到其他区域 | ✅ | ✅ | ✅ | 需自建 |
| 拆分 / 合并 | ✅ | ✅ | ✅ | 需自建 |
| 调整大小 + 最小尺寸 | ✅ | ✅ | ✅（panel min/max 持久化） | 需自建 |
| 关闭 / 重开 | ✅ | ✅ | ✅（+ watermark） | 需自建 |
| 布局持久化 | ✅ JSON 树 | ⚠️ 内容不入序列化 | ✅ 序列化 + 事件 | 需自建 |
| ARIA / 键盘基线 | ⚠️ 声明但细节未核 | ❌ 无承诺 | ✅ 文档级 | ❌ |
| 与现有 6 视图集成 | 低（工厂按 component） | 中（content 为 React 元素） | 低（注册 component + props 注入） | 高 |
| React 19 | ✅ | ⚠️ 未声明 | ✅ | — |

### 3.4 选择：dockview-react 8.9.0

**理由（按权重）**

1. **功能与受控性最完整（30%+15%）**：`addPanel({ position, minimumWidth/minimumHeight, initialWidth/Height })`、`panel.api.moveTo()`、`api.removePanel()`、`api.toJSON()/fromJSON()`、`onDidLayoutChange`、`proportionalLayout={false}`（VS Code 式分栏行为，`docs/core/sizing`）。panel 级 min/max **随布局持久化**，正好覆盖「面板最小尺寸 + 持久化」。
2. **ARIA/键盘基线是唯一有文档级承诺的（20%）**：WAI-ARIA tabs/tabpanel/region、roving tabindex、Home/End、Enter/Space、live region 播报布局变化、`:focus-visible`；并且 `activateNext/activatePrevious/adjacentGroupInDirection` 等焦点 API 在 MIT core 内，可自建 F6/方向键导航（`docs/advanced/focus-navigation`）。
3. **维护与风险（15%）**：周下载 88 万+、v8 活跃迭代（8.9.0，带 npm provenance）、React 16.8–19 peer；license 清晰。
4. **体积可接受（10%）**：~90KB gzip 量级，Electron 本地加载无网络成本；`dockview-core` 实际 gzip 以打包复测为准。
5. **集成成本可控（10%）**：以「注册 component + 注入 props」接入，不需要把 React 元素塞进布局数据（rc-dock 的序列化痛点），也不依赖库的 JSON 语法（我们另有稳定 spec）。

**放弃理由**

- **flexlayout-react（备选）**：体积/依赖更优（52.7KB gzip、0 deps）、JSON 树模型清晰、README 声明 ARIA + 可配置 keymap；但 (a) 本环境无法取得 a11y 文档全文，键盘是否覆盖「移动 tab/拆分」待核；(b) v0.x API 变化风险；(c) 与 dockview 相比缺少文档化的焦点 API 与 renderer 模式。保留为**备选**：适配层隔离，切换成本限制在 `dockAdapter` 一个文件。
- **rc-dock（淘汰）**：布局数据里直接放 React 元素导致序列化需按 id 重灌；无 ARIA/键盘承诺；6 个依赖族；下载量低（2.6 万/周）；float/new-window 模型与「单窗口 + hash」冲突。
- **自研（淘汰）**：要达到可用的 tab 拖放（含跨组、边缘拆分、drop 指示器）、splitter 约束、序列化、焦点管理，估计 600–900 行 + 大量测试，3–5 人日，且难以稳定达到 VSCode 手感；长期维护成本高于引入库。

**风险边界**：锁 `dockview-react@8.9.0`（精确版本，不用 `^`），升级必须走 `dockAdapter` 回归清单。

### 3.5 明确不用的企业特性（Enterprise）与替代

| Enterprise 特性 | v1 影响 | 我们的替代 |
|---|---|---|
| 空间键盘导航 / 键盘 docking（`keyboardNavigation`） | 无库内置键盘拆分 | 自建：`F6`/`Shift+F6` 组间焦点（MIT 焦点 API）；`Ctrl+Alt+方向键` 用 `panel.api.moveTo()` 移动/拆分；命令面板「移动当前面板」 |
| 多行 tabs | 无 | 单行 + 内置 tab overflow 菜单（core 免费） |
| Pinned tabs | 无 | 主面板不可固定；用「重置布局」恢复 |
| 高级 overflow（搜索/最近优先） | 无 | 面板只有 7 个，不需要 |
| DnD compass / smart guides | 无 | 边缘 drop zones 已够用；不做对齐吸附 |
| Layout history（撤销布局） | 无 | 只提供「重置布局」；不做逐步 undo |
| Auto-hide / edge groups | 无 | 不需要 |

> 若未来产品要求「与 VSCode 完全一致的键盘 docking/布局历史」，需评估 `dockview-enterprise` 商业授权；本设计的验收不依赖企业特性。

---

## 4. 目标架构

### 4.1 模块边界（实现时的新文件，本任务不创建）

```
src/shell/dock/
  DockShell.tsx          // <DockviewReact> 容器 + 事件桥接（activePanel / layout change / visibility）
  panelRegistry.tsx      // PanelKey → 标题/组件/routeTab/min 尺寸/renderer/可关闭
  layoutSpec.ts          // 默认布局 spec（§4.4）+ selectVariant(dockWidth)
  layoutBuild.ts         // spec → api.addPanel 调用序列（纯函数，可单测）
  dockState.ts           // 持久化读写/校验/迁移/变体状态机（纯函数为主，可单测）
  dockCommands.ts        // 命令面板动作：打开/关闭/移动/重置/比例
  dockTheme.css          // dockview 变量映射到现有 token（或合并进 styles.css）
```

`App.tsx` 只保留：数据与选中态、面板内容渲染、导航/hash/命令面板接线；**不出现 dockview 类型**，全部经 `DockShell` 的受控 props/回调（便于换库）。

### 4.2 面板注册表

| key | 标题 | routeTab | 组件 | renderer | 默认组 | 可关闭 | min W×H | 关闭后状态 |
|---|---|---|---|---|---|---|---|---|
| `chat` | 对话 | `chat` | ChatView（去掉内嵌上下文列） | always | main | ✅ | 420×320 | 消息/草稿在 App，重开即恢复 |
| `team` | 团队 | `team` | TeamDashboard（+compact） | always | team | ✅ | 360×320 | 选中/成员过滤在 App，重开 refit 星图 |
| `context` | 上下文 | —（不进 hash） | ContextPanelView（从 ChatView 抽出） | always | 默认关闭；打开时 chat 右侧或 chat 组 tab | ✅ | 280×240 | 上下文数据在 App |
| `tasks` | 任务 | `tasks` | TasksView | always | main | ✅ | 560×360 | 过滤在 App；列表滚动/搜索文本丢失（可接受） |
| `mailbox` | 邮箱 | `mailbox` | MailboxView | onlyWhenVisible | main | ✅ | 480×320 | 选中在 App |
| `board` | 黑板 | `board` | BoardView | onlyWhenVisible | main | ✅ | 360×280 | 选中板块在 App |
| `settings` | 设置 | `settings` | SettingsView | onlyWhenVisible | main | ❌（v1） | 560×400 | 不可关闭，避免本地草稿丢失；见 §7.4 |

- **单例**：每个 key 只能有一个面板实例；拖动是移动，不复制；重复 `openPanel` = 激活已有实例。
- **renderer**：`always` 保留 DOM/滚动位置（对话、团队、上下文、任务需要）；`onlyWhenVisible` 降低常驻成本（邮箱/黑板/设置）。
- **可见性事件**：`onDidVisibilityChange` → 团队面板可见时 `requestAnimationFrame ×2` 后 `fitView()`；对话可见时若正在流式则 `scrollToBottom()`。

### 4.3 布局 spec（版本化，稳定 JSON）

原则：**不手写 dockview 的 `SerializedDockview`**（内部格式随版本变化）。我们维护一份稳定、可读、可评审的 spec（下节 JSON），启动时由 `layoutBuild.ts` 通过公开 API 构建；用户拖拽后的布局另存为库的 `toJSON()` 不透明快照（§8），两者用 `schema/version` 隔离。

### 4.4 默认布局 JSON（`deer.dock.layout` v1）

```json
{
  "schema": "deer.dock.layout",
  "version": 1,
  "defaults": {
    "gap": 8,
    "splitter": 6,
    "maxGroups": 4,
    "contextOpenRule": {
      "splitMinMainWidth": 708,
      "splitMinDockWidth": 1100,
      "splitPlacement": "right-of-chat",
      "fallback": "tab-in-chat-group"
    }
  },
  "panels": {
    "chat": {
      "title": "对话",
      "component": "chat",
      "routeTab": "chat",
      "renderer": "always",
      "minWidth": 420,
      "minHeight": 320,
      "closable": true
    },
    "team": {
      "title": "团队",
      "component": "team",
      "routeTab": "team",
      "renderer": "always",
      "minWidth": 360,
      "minHeight": 320,
      "closable": true
    },
    "context": {
      "title": "上下文",
      "component": "context",
      "routeTab": null,
      "renderer": "always",
      "minWidth": 280,
      "minHeight": 240,
      "closable": true,
      "defaultClosed": true
    },
    "tasks": {
      "title": "任务",
      "component": "tasks",
      "routeTab": "tasks",
      "renderer": "always",
      "minWidth": 560,
      "minHeight": 360,
      "closable": true
    },
    "mailbox": {
      "title": "邮箱",
      "component": "mailbox",
      "routeTab": "mailbox",
      "renderer": "onlyWhenVisible",
      "minWidth": 480,
      "minHeight": 320,
      "closable": true
    },
    "board": {
      "title": "黑板",
      "component": "board",
      "routeTab": "board",
      "renderer": "onlyWhenVisible",
      "minWidth": 360,
      "minHeight": 280,
      "closable": true
    },
    "settings": {
      "title": "设置",
      "component": "settings",
      "routeTab": "settings",
      "renderer": "onlyWhenVisible",
      "minWidth": 560,
      "minHeight": 400,
      "closable": false
    }
  },
  "variants": [
    {
      "id": "wide",
      "minDockWidth": 1100,
      "root": {
        "type": "row",
        "orientation": "horizontal",
        "children": [
          {
            "type": "group",
            "id": "main",
            "weight": 58,
            "minWidth": 420,
            "activePanel": "chat",
            "panels": ["chat", "tasks", "mailbox", "board", "settings"]
          },
          {
            "type": "group",
            "id": "team",
            "weight": 42,
            "minWidth": 360,
            "activePanel": "team",
            "panels": ["team"]
          }
        ]
      }
    },
    {
      "id": "medium",
      "minDockWidth": 900,
      "root": {
        "type": "row",
        "orientation": "horizontal",
        "children": [
          {
            "type": "group",
            "id": "main",
            "weight": 56,
            "minWidth": 420,
            "activePanel": "chat",
            "panels": ["chat", "tasks", "mailbox", "board", "settings"]
          },
          {
            "type": "group",
            "id": "team",
            "weight": 44,
            "minWidth": 360,
            "activePanel": "team",
            "panels": ["team"]
          }
        ]
      }
    },
    {
      "id": "narrow",
      "minDockWidth": 760,
      "root": {
        "type": "row",
        "orientation": "horizontal",
        "children": [
          {
            "type": "group",
            "id": "main",
            "weight": 52,
            "minWidth": 420,
            "activePanel": "chat",
            "panels": ["chat", "tasks", "mailbox", "board", "settings"]
          },
          {
            "type": "group",
            "id": "team",
            "weight": 48,
            "minWidth": 360,
            "activePanel": "team",
            "panels": ["team"]
          }
        ]
      }
    },
    {
      "id": "single",
      "minDockWidth": 0,
      "root": {
        "type": "row",
        "orientation": "horizontal",
        "children": [
          {
            "type": "group",
            "id": "main",
            "weight": 100,
            "minWidth": 420,
            "activePanel": "chat",
            "panels": ["chat", "team", "tasks", "mailbox", "board", "settings"]
          }
        ]
      }
    }
  ],
  "closedByDefault": ["context"]
}
```

> 说明：`minDockWidth` 自上而下匹配（取第一个 `dockWidth >= minDockWidth` 的变体）。**变体选的是「默认结构」**；用户在同一变体下的拖拽结果会覆盖该变体的默认（§8）。`single` 变体在 `<760` 时保证「有且仅有一个组」，此时对话/团队以 tab 形式仍可用，并在页面顶部显示「窗口过窄，已切换为标签模式 · 恢复双栏」提示（点击恢复 wide/medium 结构）。

### 4.5 spec → dockview 构建算法（`layoutBuild.ts`）

1. `variant = selectVariant(dockWidth)`（ResizeObserver 首次回调后执行；首帧用 `window.innerWidth` 粗选，回调后校正）。
2. 若该变体有用户持久化布局且校验通过 → `api.fromJSON(saved.layout, { reuseExistingPanels: true })`，随后 `reconcilePanels()`：
   - 丢弃 registry 中不存在的 panel id；
   - 缺失的**必保面板**（`chat`、`team`）按默认 home 重新 `addPanel`；
   - 重新应用组约束（`group.api.setConstraints`，因为 group constraints 不随布局序列化）；
   - 若 `settings` 在布局中却被标记不可关闭，保持。
3. 否则按 spec 构建：
   - 根行第一个组：`api.addPanel({ id: 'chat', component: 'chat', title: '对话', minimumWidth: 420, minimumHeight: 320, renderer: 'always' })`；
   - 同组其余 tab：`api.addPanel({ id, component, title, position: { referencePanel: 'chat', direction: 'within' } })`，按 `panels` 顺序；
   - 团队组：`api.addPanel({ id: 'team', ..., position: { direction: 'right', referencePanel: 'chat' } })`（容器右缘/相对组的差异在 spike 中确认，二者语义二选一，验收以「右侧独立组」为准）；
   - 逐组设置 `group.api.setSize({ width })` 或依赖 `initialWidth`，再应用 `weights` 换算的像素（`dockWidth * weight / 100`）；
   - `activePanel` 的最后一次 `setActive()` 生效；`closedByDefault` 的面板不创建。
4. `applyRoute(route)`（首帧深链）→ `openPanel(route.tab)` + 选中项回填，优先于 spec 的 `activePanel`。
5. 绑定事件：`onDidActivePanelChange`、`onDidLayoutChange`、`onDidVisibilityChange`、`onDidAddPanel/onDidRemovePanel`。

### 4.6 面板内容适配

**(A) 上下文面板抽取（模块边界调整）**

- `ChatView` 去掉 `contextWidth/contextVisible` 与拖拽分隔条（`App.tsx:2164–2223` 一段），保留消息列表、流式、composer、工作区概述折叠卡、任务上下文徽标与「返回来源」。
- 新 `ContextPanelView`：复用现有 `ContextPanel`（`App.tsx:2419+`）的渲染，props 由 App 的 `context` state 注入；头部「关闭上下文」= `panel.api.close()`。
- 对话头「显示上下文」→ `openPanel('context')`：
  - 若 chat 所在主组宽度 ≥ 708 → 在 chat 右侧拆分（context 280，chat 被 clamp 到 ≥420）；
  - 否则在 chat 组内作为 tab 打开（不压缩对话），并提示「可拖动上下文标签到右侧分栏」。
- 首次迁移提示（一次性 toast）：「上下文已移到独立面板，可从对话页或 Ctrl+K 打开」。

**(B) 团队紧凑模式（container query / ResizeObserver）**

| 团队面板宽度 | 布局 |
|---|---|
| ≥560 | 现状：成员栏 252 + 星图 + 底部详情 |
| 420–559 | 成员栏改为顶部横排头像 chips（高 56，含「全部」）；底部详情默认收起，点「详情」展开为浮层/抽屉（≤40% 高度） |
| <420 | 只保留进度条 + 星图 + chips；进度卡片/环形图折叠进「进度」popover |

- 星图尺寸变化时复用 `ResizeObserver + fitView`（`TaskStarMap.tsx` 已有）；C14 `starmapFocus` 在紧凑模式同样生效。
- 成员过滤从左侧列表改为 chips 后，过滤状态仍由 `TeamDashboard` 的 `memberFilter` 承担（后续可提升到 App，见 §13 风险）。

**(C) CSS 收口**

- 新增 `.dock-host`（替代 `.content` 作为 dock 容器）：`flex:1; min-height:0; overflow:hidden; padding:0;`（VSCode 风格贴边；是否保留 16px 外边距见 Q3）。
- 每个面板包一层 `.dock-panel-body`：`height:100%; min-height:0; display:flex;` 且内容区自管滚动；把现有 `.content` 的 `padding:16px` 下沉到 `.dock-panel-body` 内层（`padding:0` 的视图自己负责）。
- dock chrome 主题映射：`--dv-group-view-background-color: transparent`、`--dv-tabs-and-actions-container-background-color: var(--bg-2)`、active tab 背景 `var(--panel)`、文字 `var(--text)`、accent 下划线 `var(--accent)`；splitter 6px，hover 用 `--accent`（复用 `.resizer` 视觉）。
- 去掉 `.content` 的双滚动：`.dock-host` 不滚，面板内部滚；逐页验收无嵌套滚动条。

---

## 5. 默认布局与比例

### 5.1 对话 : 团队

| 变体 | dock 宽度 | 比例（main : team） | 典型场景 | 实际像素（1440/1100 窗口） |
|---|---|---|---|---|
| wide | ≥1100 | **58 : 42** | 1440 窗口 + 侧栏展开 | 1152 → 668 / 484 |
| medium | 900–1099 | **56 : 44** | 1100 窗口 + 侧栏折叠（1006） | 1006 → 563 / 443 |
| narrow | 760–899 | **52 : 48** | 1100 窗口 + 侧栏展开（812） | 812 → 422 / 390 |
| single | <760 | 单组 tab | 未来下调 minWidth 后 | — |

理由：

1. 对话在显示「上下文」时已被拆为独立面板，主对话宽度 58% 足够读 82% 宽的聊天气泡；团队 42% 在 `compact` 模式下（成员 chips + 详情收起）可用。
2. 1440（默认窗口）下 668/484 是「对话可读、星图不塌」的平衡点；团队 484 触发紧凑模式（<560），星图仍有 ~484×640 的可视区。
3. 1100（最小窗口）侧栏自动折叠后 563/443，仍满足 chat ≥420、team ≥360。
4. 为什么不是 50/50：对话是输入密集面板，低于 ~600 会在气泡换行上明显变差；团队在 420–480 区间靠紧凑模式仍然可读。
5. 用户可拖拽分栏，比例持久化到该变体（§8）；「恢复默认比例」命令可一键回到 58/42。

### 5.2 上下文面板的默认策略

- **默认关闭**（`closedByDefault: ["context"]`）。
- 打开规则：主组宽度 ≥708（chat 420 + context 280 + gap 8）→ 在 chat 右侧拆分（280px，chat clamp 420）；否则 chat 组内 tab。
- 不默认并排的原因：在 1440 默认窗口下并排会吃掉 280–390px，把对话压到 400px 以下（低于 min 420），且对话才是主输入面板；上下文是「按需查看的辅助信息」。
- 迁移：老用户 `deer.contextVisible === "1"` 时首次升级自动打开上下文面板（tab 形式）并 toast 一次；`deer.contextWidth` 不再使用（保留 key 不删，避免反复迁移）。

### 5.3 其它视图的默认落位

- 主组 tab 顺序：`对话` → `任务` → `邮箱` → `黑板` → `设置`（对话在前，符合「对话为主」；任务/邮箱/黑板/设置随取随用）。
- 团队组只有 `团队` 一个 tab；用户可把任意 tab 拖过去（库原生），拖走后团队组消失，由「重开/重置」恢复。
- 默认激活：spec `activePanel=chat`；但**首帧深链优先**：空 hash 时沿用 C12 默认 `#/tasks`（`deeplink.test.ts` 已锁定），所以冷启动激活的是「任务」tab；对话/团队仍同时可见。这是唯一「默认可见但不激活」的说明，避免破坏既有深链契约。

---

## 6. 面板最小尺寸与分栏规则

| 面板 | min W | min H | 依据 |
|---|---|---|---|
| chat | 420 | 320 | 聊天气泡 + composer + 3 行输入；composer 约占 150px |
| team | 360 | 320 | 星图最小可读宽度 300 + 内边距；紧凑模式下成员 chips 高 56 |
| context | 280 | 240 | 现有上下文列下限 280（`App.tsx:2165–2167`） |
| tasks | 560 | 360 | 列表 280 + 详情 280（列表可收起到 ~200） |
| mailbox | 480 | 320 | 列表 260 + 详情 |
| board | 360 | 280 | 条目卡片可读宽度 |
| settings | 560 | 400 | 子导航 210 + 表单区 |

**分栏规则**

1. 组最小宽度 = 组内最宽 minWidth 与 spec 的 `minWidth` 取大；根两组最小和 = 420 + 360 + 8(gap) = 788 ≤ 当前最小 dock 宽度（侧栏展开 812）→ 1100 窗口仍能双栏。
2. dockview 的 **panel min/max 随布局持久化**；**group constraints 不序列化**（官方文档明示），因此 `reconcilePanels()` 必须在 `fromJSON` 之后重放 `root 两组` 的 `setConstraints`。
3. 拖动分隔条时库按约束 clamp；若用户把窗口缩小到约束不可满足，库会尽量压缩并允许溢出前先压到 min；此时 UI 显示「面板已到最小宽度」提示（aria-live polite）。
4. 双击分隔条：v1 不绑定（库未提供 splitter dblclick），改为命令面板「恢复默认比例」（等价于把 main/team 设为 58/42，用 `group.api.setSize` 计算）。
5. 最多 4 个组；达到上限时 `onWillDrop` 拒绝新增拆分的 drop，并 toast「最多 4 个分栏，请先拖回合并」。

---

## 7. 交互规则（拖动 / 拆分 / 合并 / 关闭 / 重开）

### 7.1 允许的拖拽

| 操作 | 行为 | 库能力 |
|---|---|---|
| 组内 tab 重排 | 顺序变化，active 保持 | 原生 |
| tab 拖到另一组 tab 条 | 并入该组（合并） | 原生 |
| tab 拖到组内容区 | 并入该组（合并） | 原生 |
| tab 拖到组边缘（左/右/上/下） | 拆分为新组（同方向插入） | 原生 drop zones |
| 拖动整组（组标题/空白） | 组移动/重排（v1 允许，但隐藏组拖拽把手以外不做额外入口） | 原生 |
| 拖到 root 边缘 | 生成新组（最多 4 组） | 原生 |

### 7.2 明确禁用（v1）

- 浮动组（floating）与弹出窗口（popout）：单窗口 Electron + hash/持久化语义复杂；不暴露入口（库默认也不创建，需显式 `floating` 选项）。
- 组边缘 auto-hide、edge groups、pinned tabs、多行 tabs、DnD compass/smart guides：企业特性或不需要。
- 节点坐标持久化：面板布局不保存像素坐标之外的语义状态（库的序列化只含结构/尺寸，符合要求）。

### 7.3 关闭语义

| 面板 | 关闭方式 | 关闭后 | 重开落点 |
|---|---|---|---|
| chat | tab ×｜命令「关闭当前面板」 | 消息/草稿在 App，不丢 | 主组（若主组不存在 → 右边缘新建组） |
| team | 同上 | 选中/过滤在 App；星图卸载后重开 refit | 团队组位置（若不存在 → 右边缘） |
| context | 同上 | 上下文数据在 App | chat 右侧拆分或 chat 组 tab（按 §5.2） |
| tasks | 同上 | 过滤在 App；搜索文本/滚动位置丢失（已接受） | 主组末尾 |
| mailbox | 同上 | 选中在 App | 主组末尾 |
| board | 同上 | 选中板块在 App | 主组末尾 |
| settings | **不可关闭**（v1） | 保留本地草稿 | — |

- 关闭某组最后一个 tab：组自动移除；根布局为空时显示 **watermark**：「所有面板已关闭」+「恢复默认布局」+「打开对话」两个按钮。
- 关闭时不触发全局错误/toast（静默），但 watermark 出现时 aria-live 播报一次。

### 7.4 设置面板不可关闭的理由

`SettingsView` 的编辑状态（providers/models/mock/默认模型）是组件内 state，且没有全局 store；dock 关闭会卸载组件导致未保存修改丢失。dockview 的 tab 关闭按钮无法可靠拦截（需 `onWillPanelClose` 类钩子，本版本未确认），因此 v1 **隐藏 settings 的关闭按钮**；命令面板「关闭设置」也不可用。后续可把设置草稿提升到 App/模块级 store 后再开放关闭（列入 §16 Q5）。

### 7.5 重开与导航语义

```
openPanel(key, opts?):
  1. panel = api.getPanel(key)
  2. if panel: panel.api.setActive(); panel.api.focus?（或 group focus）; return
  3. home = 计算落点（registry.defaultGroup → 存在则用；否则按 §7.3 的「右边缘/主组末尾」）
  4. api.addPanel({ id: key, component, title, minimumWidth, minimumHeight, initialWidth?, renderer, position })
  5. panel.api.setActive()
```

- 导航点击、Alt+1–6、命令面板导航、hash 深链、实体跳转（任务/邮件/黑板）都走 `openPanel`。
- 关闭后再次 `openPanel`：优先回到它**关闭前所在的组**（若该组仍存在），否则回默认组；实现上在 close 时记录 `lastGroupId` 到内存（不持久化）。
- 打开一个已在**非激活组**的面板：激活它所在组并聚焦该 tab。

---

## 8. 持久化与恢复

### 8.1 存储结构

- Key：`deer.dock.v1.<workspaceId>`
- Value（JSON，≤64KB）：

```json
{
  "schema": "deer.dock.state",
  "version": 1,
  "updatedAt": "2026-11-09T15:30:00.000+08:00",
  "variants": {
    "wide": {
      "layout": { "grid": "…SerializedDockview（库不透明格式，不手写）" },
      "activePanel": "chat",
      "closed": ["context"]
    },
    "medium": { "layout": {}, "activePanel": "tasks", "closed": [] },
    "narrow": { "layout": {}, "activePanel": "team", "closed": [] },
    "single": { "layout": {}, "activePanel": "chat", "closed": [] }
  }
}
```

- **按变体分别记忆**：窗口跨断点时只切换当前变体的布局，不破坏用户在 other 变体下调好的分栏；每个变体首次使用 = spec 默认。
- 不持久化：浮动位置（未启用）、面板内部滚动位置、对话草稿（由现有 App 状态管理）、节点坐标。

### 8.2 写入

- 监听 `onDidLayoutChange(event)`：
  - `event.reasons` 含 `structure` 或 `activePanel` → 立即（或 150ms 防抖）写入；
  - 仅 `geometry`（拖分隔条）→ 400ms 防抖；
  - 写入前把当前变体状态合并进整体对象。
- `beforeunload`、切换工作区、`重置布局` 前 flush。
- 失败（配额/序列化异常）→ 静默降级 + 一次 toast「布局无法保存，将使用默认布局」。

### 8.3 读取与校验

1. JSON 解析失败 / `schema` 或 `version` 不符 / `layout` 非对象 / 体积超限 → 删除该 key → 使用 spec 默认 → toast「布局数据已损坏，已恢复默认」。
2. `fromJSON` 抛错（库会「throw and reset gracefully」）→ 捕获 → 同上回退。
3. 校验通过后仍执行 `reconcilePanels()`：未知 panel 丢弃；`chat`/`team` 缺失按默认补；重放组约束；若目标变体与当前窗口不一致（例如用户从 1440 拖到 1100 再启动）→ 用当前变体的缓存（若存在）否则默认。

### 8.4 重置与迁移

- 「恢复默认布局」：清空当前变体的 `layout`（保留其它变体）→ 按 spec 重建 → 保持当前激活面板（若仍存在）→ 不改变 hash。
- 全局「重置所有布局」：删除整个 key（命令面板带确认）。
- 迁移：
  - `deer.contextVisible === "1"` → 首次启动打开 context（tab 形式）并 toast 一次；
  - `deer.contextWidth`、`deer.taskListWidth` 不影响 dock（前者废弃，后者仍在 TasksView 内部使用）；
  - `deer.sidebarWidth/sidebarCollapsed` 不变（dock 在侧栏内层）。
- 版本策略：`version` 提升时提供 `migrate(vN → vN+1)`；无法迁移则按 §8.3 回退。

---

## 9. 与导航 / hash / 命令面板 / 其它功能的集成

### 9.1 侧栏导航（6 入口）

| 导航项 | 动作 | 高亮条件 |
|---|---|---|
| 任务 | `openPanel('tasks')` | `activePanelId === 'tasks'` |
| 团队 | `openPanel('team')` | `activePanelId === 'team'` |
| 对话 | `openPanel('chat')` | `activePanelId === 'chat'` |
| 邮箱 | `openPanel('mailbox')` | `activePanelId === 'mailbox'` |
| 黑板 | `openPanel('board')` | `activePanelId === 'board'` |
| 设置 | `openPanel('settings')` | `activePanelId === 'settings'` |

- `aria-current="page"` 从 `tab` 改为 `activePanelId` 派生；`tab` 保留为 `activePanel → RouteTab` 的计算值，供面包屑与 hash 使用。
- Alt+1–6 保持现有顺序（`TABS` 顺序：任务/团队/对话/邮箱/黑板/设置），动作改为 `openPanel` + 聚焦。
- 侧栏折叠、Ctrl/⌘+B、工作区按钮、footer 不变。

### 9.2 hash 路由

- 映射：`activePanelId` ∈ {tasks, team, chat, mailbox, board, settings} → `RouteTab`；`context` 不映射（不写 hash，也不从 hash 打开）。
- 写入：`onDidActivePanelChange` → 若映射存在且与当前 hash 不同：
  - 面板切换视为「tab 变化」→ `history.pushState`（保留后退语义），沿用 `buildHash(tab, selection)`；
  - 选中项变化 → 沿用现有 `history.replaceState` 逻辑（`App.tsx:142–158`）。
- 读取：`hashchange` / 首帧 → `parseHash` → `openPanel(route.tab)` + 现有选中回填 effect；面板被关闭时先重开再激活。
- 防环：`syncingFromDockRef` / `applyingHashRef` 两个 guard；写 hash 前比较当前值，避免 `replaceState` 循环。
- `#/router` 别名、空 hash 默认 `tasks`、未知 tab 回退 `tasks`：**全部保持**（`deeplink.test.ts` 不改）。
- 边界：Electron 无地址栏，深链主要服务 QA/重启恢复（现有 README 已注明）；dock 不改变这一点。

### 9.3 命令面板（C11）

在 `CommandPalette.tsx` 现有 action 列表（`68–145`）基础上：

1. **导航组**：`前往 X` 改为 `打开 X`（`onOpenPanel`）。
2. **新建组**：`startCreate` 先 `openPanel(CREATE_TARGET_TAB[intent])`，再在目标面板打开弹窗（现有 `createIntent` 机制保留）。
3. **实体组**（任务/成员/邮件/黑板）：
   - 任务 → `openPanel('tasks')` + `selectedTaskId`；
   - 成员 → `openPanel('team')`（可选：设置 `memberFilter` 聚焦该成员，后续增强）；
   - 邮件 → `openPanel('mailbox')` + 选中；
   - 黑板 → `openPanel('board')` + 选中板块。
4. **新增「面板」组**：
   - 打开 对话 / 团队 / 上下文 / 任务 / 邮箱 / 黑板 / 设置；
   - 关闭当前面板（settings 不可用，disabled + 说明）；
   - 移动当前面板：左 / 右 / 上 / 下 / 新分栏（调 `panel.api.moveTo` 或 `addPanel` 拆分；键盘 docking 的 MIT 替代）；
   - 恢复默认比例（58/42 或当前变体默认）；
   - 重置布局（当前变体 / 全部，带确认）。
5. 快捷键提示 footer 增补 `F6`、`Ctrl+Alt+方向键`、`Ctrl+Alt+W`。

### 9.4 其它功能

| 功能 | 集成方式 |
|---|---|
| C14 任务→星图定位 | `openPanel('team')` + `setStarmapFocus`；星图可见后 fit/focus 仍由 `TaskFocus` 双 rAF 逻辑保证（`TaskStarMap.tsx:128–163`） |
| C14 对话「返回任务/团队」 | `openPanel(contextSource)`；`contextSource` 仍由 `handleShowTaskContext` 记录 |
| C06 任务过滤/失败计数 | 不变；顶栏失败 pill 点击 `openPanel('tasks')` + 过滤 |
| C24 空状态 / C25 Modal / C26 Toast | 全局层不变；Dock 关闭面板不影响已打开的 modal（modal 挂在 shell） |
| 星图相机 | 团队面板隐藏 → 可见时 `fitView()`（统一在 `onDidVisibilityChange`）；避免在 `onlyWhenVisible` 下 ResizeObserver 读到 0 |
| 邮箱/黑板选中 | 仍存 App；`openPanel` 后由现有受控 props 恢复 |
| 设置子导航 | 不变；settings 不可关闭 |
| 侧栏折叠 | 不变；`Ctrl/⌘+B` 仍优先于 dock 快捷键（无冲突） |

---

## 10. 键盘与无障碍

### 10.1 库基线（dockview core，MIT）

- `role="tablist"` / `role="tab"`（`aria-selected`、`aria-controls`）/ `role="tabpanel"`（`aria-labelledby`）；组为 `role="region"`（以激活面板标题命名）。
- tab 条内 **roving tabindex**：方向键移动焦点、Home/End 首尾、Enter/Space 激活；仅激活 tab 是一个 Tab stop。
- 布局变化通过 **aria-live** 播报（polite/assertive）；`:focus-visible` 焦点环。
- 焦点 API：`activateNext/activatePrevious({includePanel})`、`adjacentGroupInDirection`、`group.api.boundingBox`（自建空间导航用）。

### 10.2 App 级快捷键（renderer 注册；Electron `autoHideMenuBar` 无原生菜单）

| 快捷键 | 行为 | 说明 |
|---|---|---|
| `Ctrl/⌘ + K` | 命令面板 | 现有 |
| `Alt + 1–6` | 打开/聚焦 6 个导航面板 | 现有语义，改 `openPanel` |
| `Ctrl/⌘ + B` | 折叠侧栏 | 现有 |
| `F6` / `Shift+F6` | 下一个/上一个面板组焦点 | 新增，用 `activateNext/activatePrevious({includePanel:true})` |
| `Ctrl + Shift + \` | 聚焦当前组 tab 条 | 新增（DOM 钩子：`[role=tab][aria-selected=true]`，adapter 内集中实现） |
| `Ctrl + Alt + ←/→/↑/↓` | 把当前面板移动到该方向的相邻组；无相邻组则拆分到该方向 | 新增；`panel.api.moveTo()`；遵守 4 组上限 |
| `Ctrl + Alt + Shift + ←/→` | 增大/缩小当前组宽度（步进 80px，clamp min） | 新增；`panel.api.setSize()`（键盘等价分栏调整） |
| `Ctrl + Alt + W` | 关闭当前面板（settings 禁用） | 新增；焦点按 §7.3 规则回收 |
| `Esc` | 关闭命令面板 / 取消进行中的「移动面板」提示 | 复用/新增 |
| `Tab / Shift+Tab` | 面板内容内正常焦点遍历 | 不拦截 |

> 不使用 enterprise 的 `keyboardNavigation` 键位；上表全部可在 MIT core 上实现。冲突检查：`autoHideMenuBar` 下无系统菜单快捷键；`Ctrl+Alt+方向键` 在 Windows 上与部分输入法/显示驱动有冲突风险，列为 Q4（可改为 `Ctrl+Shift+Alt+方向键`）。

### 10.3 移动/拆分的键盘流程

1. 激活目标面板（Alt+1–6 或 F6）。
2. `Ctrl+Alt+方向键` → adapter 计算目标：`adjacentGroupInDirection(activeGroup, dir)`；存在则 `panel.api.moveTo({ group: target, position: 'within' })`；不存在则 `panel.api.moveTo({ position: dir })`（拆分，若组数=4 则 toast 拒绝）。
3. 通过 live region 播报「已移动 对话 到右侧」；失败播报原因（如「已达 4 个分栏上限」）。
4. 命令面板「移动当前面板…」提供同样动作的可发现入口（两步：输入「移动面板」→ 选择方向），并在面板不可移动时禁用项。

### 10.4 焦点与读屏细节

- 关闭面板后焦点：同组下一个 tab → 同组上一个 tab → 相邻组激活面板 → 主组 `chat`；watermark 时聚焦「恢复默认布局」按钮。
- 面板标题即 tab 可访问名；关闭按钮可访问名需包含面板名（若库默认英文，adapter 用 `messages`/自定义 tab 渲染本地化为「关闭 对话」；spike 验证）。
- 布局变化播报本地化（dockview `messages` 支持）；我们自己触发的变化（键盘移动、重置、到最小宽度）用 App 的 toast/aria-live 补充。
- `prefers-reduced-motion: reduce`：禁用 tab 拖拽动画、分栏过渡、现有脉冲（星图 running 脉冲、流式光标）——后两项属全局样式，顺带在 dock 主题层加 `@media`。
- 高对比：dock 主题变量使用现有 token；tab 激活态不仅靠颜色（下划线 + 背景 + `aria-selected`）。
- 与 C25 Modal 的焦点管理不冲突：modal 打开时 dock 不抢焦点；modal 关闭回焦到触发元素（现有 Modal 逻辑）。

---

## 11. 响应式与窄窗

| dock 宽度 | 变体 | 布局 | 团队面板 | 上下文打开方式 | 备注 |
|---|---|---|---|---|---|
| ≥1100 | wide | 横排 58/42 | 正常/紧凑 | chat 右侧拆分（主组 ≥708）否则 tab | 1440 默认窗口 |
| 900–1099 | medium | 横排 56/44 | 紧凑 | tab（主组通常 <708） | 1100 窗口侧栏折叠 |
| 760–899 | narrow | 横排 52/48 | 紧凑（<440 时进一步隐藏进度卡） | tab | 1100 窗口侧栏展开 |
| <760 | single | 单组 tab（6 view 全在） | 全宽 | tab | 顶部提示「窗口过窄 · 恢复双栏」；需下调 minWidth 才可达 |

- **为什么窄窗不竖排**：窗口最小高度 700 时 dock 高度约 610，而 chat/team 的 `minHeight` 各 320，竖排两者最小和 640 > 610，会挤压破约束；横排时两者共享 610 高度，均满足。因此窄窗采用横排 + 紧凑团队，而不是上下堆叠。
- 变体切换时：先 flush 当前变体布局到持久化，再按目标变体的缓存/默认重建；**激活面板保持不变**（若存在），否则落到 `chat`。
- 变体切换不写 hash（避免用户拖动窗口就产生历史记录）。
- 窗口最小 1100：`minWidth` 是否下调到 960（让 single 可达）列为 Q1；不改也满足「窄窗可用」（narrow 可达）。
- 断点判定用 `ResizeObserver` 监听 `.dock-host`，不用 `@media`（避免与现有两段 1100 media 混淆；媒体查询仅保留侧栏折叠逻辑）。

---

## 12. 性能与规模

| 项 | 设计 | 验收口径 |
|---|---|---|
| 面板数量 | 7 个；最多 4 组 | 内存/帧率不随组数线性恶化（≤4） |
| 渲染模式 | chat/team/context/tasks = `always`；mailbox/board/settings = `onlyWhenVisible` | 隐藏面板不销毁对话/星图 DOM；切换 tab 不重置星图相机（除首次 fit） |
| 星图相机 | 团队隐藏时暂停；可见时双 rAF 后 `fitView`（避免 0×0） | 切走再切回，星图不出现空白/错位；C14 定位仍居中所选节点 |
| 对话滚动 | `always` 保留 scrollTop；流式时可见则自动滚底 | 切到团队再回对话，消息位置不跳（除非在流式） |
| 布局序列化 | `onDidLayoutChange` 分档防抖（structure/active 150ms，geometry 400ms）；容量 <64KB | 拖分隔条 10 秒内 localStorage 写入 ≤ 20 次；单次序列化 <5ms |
| React 重渲染 | 面板组件 `memo`；dock props 稳定（回调 `useCallback`）；App 的 snapshot 刷新沿用 220ms 防抖 | 流式输出期间拖动分隔条不出现 >50ms 长任务（DevTools Performance 采样） |
| 包体 | dockview-react + dockview-core（约 90KB gzip 量级，打包复测） | `vite build` 后 dock 相关 chunk ≤ 200KB gzip |
| 规模上界 | 7 面板 / 4 组 / 单面板内容已是现有列表；不引入 canvas | 夹具 6 任务 + 2 成员 + 1 邮件 + 2 黑板，交互 ≥50fps |
| 持久化开销 | 变体级独立 layout，切换/关闭时才写 | 刷新恢复 <100ms；损坏回退 <100ms |

---

## 13. 风险与缓解

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | dockview 的键盘 docking / 空间导航属 enterprise，不能直接用 | 键盘无法像鼠标一样拆分 | 用 MIT `moveTo` + 命令面板 + 自建 `F6`/`Ctrl+Alt+方向键`；验收 A-K3 覆盖 |
| R2 | 上下文从 ChatView 内嵌列抽出，回归面大 | C14 返回、任务上下文徽标、流式、滚动可能坏 | 单独阶段（§14 P2）+ 专项验收 A-R4；保留旧 `ContextPanel` 渲染代码，只换宿主 |
| R3 | 团队 42% 宽度下信息过密 | 星图/详情不可用 | 紧凑模式（§4.6B）+ 容器查询；验收 A-R2 |
| R4 | hash ↔ dock 双向同步成环 | 无限 replaceState / 历史污染 | 单一真相 `activePanelId` + 两个 guard ref；单测 `routeFromPanel/panelFromRoute`；验收 A-H3 |
| R5 | 持久化损坏 / 版本升级 | 启动白屏或布局错乱 | 版本化 + 校验 + `fromJSON` try/catch + 回退默认 + toast；验收 A-P3 |
| R6 | group constraints 不随布局持久化 | 刷新后分栏可被拖到小于 min | `reconcilePanels()` 重放 `setConstraints`；验收 A-S2 |
| R7 | `.content` 高度/滚动收口不彻底 | 双滚动条、面板裁切 | 统一 `.dock-host`/`.dock-panel-body`；逐页验收 A-R5 |
| R8 | 关闭 settings 丢草稿 | 用户配置丢失 | v1 不可关闭（§7.4）；后续草稿提升到 store 再开放（Q5） |
| R9 | 深链指向已关闭面板 | 打开空白/无激活 | `openPanel` 自动重开；验收 A-H2 |
| R10 | 企业特性诱惑后续被引入 | 授权/升级风险 | 设计明确列出禁用清单；PR 检查项 |
| R11 | 库版本升级破坏 API | 返工 | 精确锁 8.9.0；升级必须过 `dockAdapter` 回归清单 |
| R12 | `Ctrl+Alt+方向键` 与系统/输入法冲突 | 快捷键不可用 | Q4 可改键；命令面板始终有等价入口 |
| R13 | 1100 最小窗口下窄变体与 single 不可测 | 验收覆盖不足 | 用 DevTools 模拟 dock 宽度（或临时改 minWidth 的构建）验证；Q1 决定是否正式下调 |
| R14 | 无 Playwright，DnD/焦点只能手测 | 回归成本 | 先补纯函数单测（spec 选择/持久化/路由映射）+ 手工清单；Playwright 作为后续项 |

---

## 14. 实施计划（本任务不执行）

| 阶段 | 内容 | 产出/门槛 | 估计 |
|---|---|---|---|
| P0 Spike | 引入 dockview-react@8.9.0，最小 `DockShell`（2 个占位面板），验证：addPanel position/initialWidth、fromJSON、panel min 持久化、group constraints 重放、tab 关闭按钮本地化、焦点 API、watermark | spike 分支可跑；记录 5 个未确认点结论 | 0.5d |
| P1 Shell + spec | `.dock-host`、`panelRegistry`、`layoutSpec`、`layoutBuild`、主题变量；6 视图接入（context 先占位） | 默认布局双面板可见；6 视图可打开 | 1d |
| P2 内容适配 | ChatView 去上下文列、`ContextPanelView`、团队紧凑模式、CSS 收口 | 对话/团队/上下文在三档变体下可用 | 1.5d |
| P3 导航/hash/命令面板 | `activePanelId` 提升、导航打开/聚焦、hash 双向同步、命令面板「面板」组、C14 接线 | 6 入口、深链、命令动作全通 | 1d |
| P4 持久化/键盘/a11y | 变体级持久化、迁移、重置、快捷键与播报、reduced-motion | 刷新恢复、键盘全流程 | 1d |
| P5 响应式/收尾 | 变体切换、min 尺寸、最多 4 组、空 watermark、回归 | 全量验收清单通过 | 0.5d |

总计约 **5–6 人日（L）**，依赖：C11/C12/C14/C25 已交付（已完成）。测试：`dockState.test.ts`（变体选择/校验/迁移/路由映射）、手工 DnD/焦点清单；可选后续 Playwright。

---

## 15. 可执行验收清单

> 夹具：工作区 `dock-fixture`（1440×920 窗口）：成员 2 位、任务 6 个（A→B→C 链、D/E 扇出、F 孤立）、邮件 1 封、黑板 2 条。每项给出「步骤 / 期望」。
> Electron 无地址栏：hash 类用例通过 DevTools 执行 `location.hash = '#/chat'`（或等价方式）触发 `hashchange`；「重启恢复」用例可用同样方式验证。

### A. 默认布局

| ID | 步骤 | 期望 |
|---|---|---|
| A-L1 | 冷启动（无 hash） | 同时看到「对话」与「团队」两个面板；对话在左、团队在右；激活面板是「任务」（C12 默认 `parseHash('') = tasks`）；hash 为空或 `#/tasks`（沿用现有行为，不强制写 hash） |
| A-L2 | 测量两组宽度（DevTools） | 比例 58:42（±2pp）；1440 窗口下约 668/484px；侧栏折叠/展开后比例不变 |
| A-L3 | 关闭全部面板 | 出现 watermark「所有面板已关闭」+「恢复默认布局」「打开对话」；无报错 |
| A-L4 | 点「恢复默认布局」 | 回到 §4.4 wide 结构；对话/团队可见；当前 hash 不变 |

### B. 拖拽 / 拆分 / 合并

| ID | 步骤 | 期望 |
|---|---|---|
| A-D1 | 把「任务」tab 拖到右侧团队组 tab 条尾部 | 任务并入团队组，成为第 2 个 tab；任务面板变宽/高适配；无内容丢失 |
| A-D2 | 把「邮箱」tab 拖到主组内容区右边缘 | 出现 drop 指示，松手后拆分为新组（主组右侧）；组数变 3 |
| A-D3 | 把新组里的「邮箱」tab 拖回主组 tab 条 | 合并回主组；空组自动移除；布局恢复 2 组 |
| A-D4 | 主组内拖动「设置」到「任务」之前 | tab 顺序变化；激活面板不变；刷新后顺序保持（A-P1） |
| A-D5 | 连续拆分到 4 组后再尝试拆第 5 组 | 第 5 次被拒绝，toast「最多 4 个分栏，请先拖回合并」；已有 4 组不变 |

### C. 调整大小 / 最小尺寸

| ID | 步骤 | 期望 |
|---|---|---|
| A-S1 | 拖动对话/团队分隔条到最左 | 对话停在 min 420（或当前变体约束），不出现负宽/裁切；分隔条 hover 高亮 |
| A-S2 | 刷新页面 | 分栏比例恢复；各组不违反 min 尺寸（constraints 已重放） |
| A-S3 | 把团队组拖到最窄 | 团队停在 min 360；星图保持可用（紧凑模式）；无横向滚动条出现在组外 |
| A-S4 | 命令面板「恢复默认比例」 | 回到 58/42（或当前变体默认），当前激活面板不变 |

### D. 关闭 / 重开

| ID | 步骤 | 期望 |
|---|---|---|
| A-C1 | 关闭「团队」tab | 团队组消失；对话占满整宽（或主组扩展）；无报错 |
| A-C2 | 点侧栏「团队」 | 团队面板在默认位置重开并激活；星图自动 fit，选中任务仍高亮 |
| A-C3 | 关闭「对话」后从命令面板打开「对话」 | 对话重开，历史消息仍在，composer 草稿仍在（App 状态） |
| A-C4 | 关闭「上下文」 | 不影响对话；「显示上下文」可再次打开 |
| A-C5 | 尝试关闭「设置」 | 没有关闭按钮；命令面板「关闭当前面板」对设置禁用并给出说明 |
| A-C6 | 关闭某组最后一个 tab | 该组自动移除；若无可显示面板 → watermark；焦点落到「恢复默认布局」 |

### E. 持久化 / 恢复

| ID | 步骤 | 期望 |
|---|---|---|
| A-P1 | 按 A-D1/A-D2/A-S1 调整后刷新 | 布局结构、分栏比例、tab 顺序、激活面板全部恢复 |
| A-P2 | 关闭某个面板后刷新 | 关闭状态保持（不自动重开） |
| A-P3 | DevTools 手工把 `deer.dock.v1.<ws>` 改成 `{oops}` 后刷新 | 回退默认布局；toast「布局数据已损坏，已恢复默认」；无白屏 |
| A-P4 | 两个工作区分别调整布局后切换 | 各自恢复；不串布局 |
| A-P5 | 窗口从 1440 拖到 1100 再拖回 | 切到 medium/narrow 结构；回到 1440 时恢复 wide 下用户布局；不产生 hash 历史 |

### F. 导航 / hash

| ID | 步骤 | 期望 |
|---|---|---|
| A-N1 | 依次点击 6 个导航项 | 对应面板打开/聚焦；侧栏高亮跟随；未关闭其它面板 |
| A-N2 | 在任务页选中任务 A | hash `#/tasks?t=<A>`；切到团队再切回任务，选中保留 |
| A-N3 | 地址栏输入 `#/chat?task=<A>` 后回车（或重启恢复） | 对话面板激活；顶部显示「任务上下文」徽标；「返回任务」可回 |
| A-N4 | 输入 `#/mailbox?m=<id>` / `#/board?b=general` / `#/settings` | 对应面板打开并激活；选中项正确 |
| A-N5 | 输入旧 `#/router` | 重定向到任务（现有行为），不报错 |
| A-N6 | 关闭「邮箱」后在地址栏输入 `#/mailbox` | 邮箱面板自动重开并激活 |

### G. 命令面板

| ID | 步骤 | 期望 |
|---|---|---|
| A-K1 | Ctrl/⌘+K 输入「团队」回车 | 团队面板激活；面板不重复创建 |
| A-K2 | 输入「关闭当前面板」→ 回车 | 当前面板关闭；设置面板时该项禁用 |
| A-K3 | 输入「移动面板」→ 选择「右侧」 | 当前面板移动到右侧组（无相邻组则拆分，受 4 组上限约束）；aria-live 播报 |
| A-K4 | 输入「重置布局」→ 回车（确认） | 当前变体恢复默认；激活面板不变；hash 不变 |
| A-K5 | 输入「上下文」回车 | 上下文面板打开（按 §5.2 规则拆分或 tab） |

### H. 键盘 / ARIA

| ID | 步骤 | 期望 |
|---|---|---|
| A-K6 | 只用键盘：Tab 到 tab 条，←/→ 移动焦点，Enter 激活 | 焦点环可见；tab 激活；面板内容可继续 Tab |
| A-K7 | F6 / Shift+F6 | 焦点在面板组之间循环（含面板内）；不进入 modal |
| A-K8 | Ctrl+Alt+←/→/↑/↓ | 当前面板移动/拆分；失败时 toast/live 说明；4 组上限生效 |
| A-K9 | Ctrl+Alt+Shift+←/→ | 当前组宽度增减 80px，clamp 到 min；无横向溢出 |
| A-K10 | 关闭当前面板（Ctrl+Alt+W） | 焦点按 §10.4 规则回收；读屏播报关闭 |
| A-K11 | 屏幕阅读器（NVDA/浏览器辅助）打开页面 | 能读到 tablist / tab / tabpanel 名称；布局变更（打开/关闭/移动）有播报 |
| A-K12 | 系统开启「减弱动效」 | tab 拖拽动画/分栏过渡/星图脉冲/流式光标停止；功能不受影响 |

### I. 响应式 / 窄窗

| ID | 步骤 | 期望 |
|---|---|---|
| A-R1 | 窗口 1440 → 1100（侧栏保持折叠） | 变体 medium（56/44）；两面板仍可见；对话 ≥420、团队 ≥360 |
| A-R2 | 1100 窗口 + 展开侧栏（dock ≈812） | 变体 narrow（52/48）；团队进入紧凑模式；星图可用；无溢出 |
| A-R3 | 1100 窗口下把团队拖到 360 | 仍可用；详情可展开/收起；无横向滚动条出现在组外 |
| A-R4 | 对话页点「显示上下文」 | 主组 ≥708 时右侧拆分（对话 ≥420、上下文 ≥280）；否则上下文为对话组 tab；两种方式上下文内容完整 |
| A-R5 | 逐页检查 6 个面板滚动 | 每个面板只有内部一个滚动条；`.dock-host` 不滚；固定头部（tab 条/面板头）不漂移 |
| A-R6 | 模拟 dock 宽度 740（DevTools 改窗口或临时构建） | 变体 single：单组 tab，对话/团队可切换；顶部出现「恢复双栏」提示；点击恢复 |

### J. 功能回归

| ID | 步骤 | 期望 |
|---|---|---|
| A-G1 | 任务：筛选/搜索/失败 pill 跳转/运行任务/trace | 与改造前一致；详情在任务面板内 |
| A-G2 | 团队：成员过滤、星图 pan/zoom/fit、点击/双击、C14 定位 | 与改造前一致；定位后团队面板自动激活并居中 |
| A-G3 | 邮箱：发邮件 modal、选中、空态 | 与改造前一致；dock 不遮挡 modal |
| A-G4 | 黑板：板块切换、发布条目、空态 | 与改造前一致 |
| A-G5 | 设置：供应商/模型/默认模型/Mock、保存 toast | 与改造前一致；不可关闭 |
| A-G6 | 顶栏：面包屑、⌘K、＋新建、失败计数、刷新 | 与改造前一致；面包屑页名来自激活面板 |
| A-G7 | 全局：modal Esc/焦点、toast、错误 banner、空状态 | 与改造前一致 |

### K. 性能 / 稳定性

| ID | 步骤 | 期望 |
|---|---|---|
| A-X1 | 打开 7 个面板（2 组）后拖分隔条 10s | 无 >50ms 长任务（Performance 采样）；内存增量 <25MB |
| A-X2 | 对话流式输出期间在团队面板 pan/zoom | 对话不中断；团队交互 ≥50fps（肉眼/帧率工具） |
| A-X3 | 切到团队再切回对话 | 对话滚动位置保留（`always`）；星图无空白 |
| A-X4 | 8 小时/长会话（可选） | 无布局监听器泄漏（事件计数稳定）；localStorage 体积 <64KB |

---

## 16. 待确认问题（Q）与决策记录（ADR）

### 16.1 待确认（需 Captain/用户拍板）

| ID | 问题 | 建议 |
|---|---|---|
| Q1 | 是否把 Electron `minWidth` 从 1100 下调到 960，让 `single` 变体可达？ | 建议下调到 960（`electron/main.ts:28`），同时保留窄窗提示；不下调也可上线（narrow 已覆盖 1100 侧栏展开场景） |
| Q2 | 上下文面板默认关闭（按需打开）是否接受？还是默认以 300px 并排（会压缩对话到 ~420）？ | 建议默认关闭 + 对话头常驻「显示上下文」，避免一上来就把主对话压到最小 |
| Q3 | dock 是否贴边（去掉 `.content` 16px 外边距，VSCode 风格）？ | 建议贴边；面板内部保留 12–16px 内边距 |
| Q4 | `Ctrl+Alt+方向键` 是否改为 `Ctrl+Shift+Alt+方向键`（规避输入法/显卡驱动冲突）？ | spike 后定；命令面板始终有等价入口 |
| Q5 | 设置面板是否在把草稿提升到 App/store 后允许关闭？ | v1 不关闭；后续单独任务 |
| Q6 | 是否接受「最多 4 个分栏」上限？ | 建议接受；防止 7 个面板被拆成不可用的小格 |
| Q7 | 是否允许「团队」默认 42%（紧凑模式）？还是给团队 50%？ | 建议 58/42；若用户实测觉得团队窄，可通过拖拽或后续调默认 |

### 16.2 ADR

- **ADR-D01 选 dockview-react 8.9.0**：理由见 §3.4；备选 flexlayout 通过适配层隔离；不采用 rc-dock/自研。
- **ADR-D02 默认 58/42，上下文默认关闭**：见 §5.1/§5.2。
- **ADR-D03 面板单例，id = view key**：保证 hash 一对一映射与状态不分裂。
- **ADR-D04 不启用浮动/弹出/企业特性**：见 §3.5/§7.2。
- **ADR-D05 持久化按 workspace × 变体、版本化**：见 §8。
- **ADR-D06 上下文升级为独立面板**：模块边界调整，避免对话被压到最小；保留 `ContextPanel` 渲染。
- **ADR-D07 键盘用「MIT 焦点/移动 API + 命令面板 + 自建快捷键」补齐 enterprise 缺口**：见 §10。

---

## 17. 参考来源

- dockview 文档：Core concepts / Adding panels / Move panel / Remove panel / Rendering panels / Saving & Loading state / Sizing / Resizing / Constraints / Theming / Drag & drop / Watermark / Accessibility / Focus navigation / Keyboard navigation（Enterprise）/ Licensing：
  - https://dockview.dev/docs/core/overview/
  - https://dockview.dev/docs/core/panels/add/
  - https://dockview.dev/docs/core/panels/move/
  - https://dockview.dev/docs/core/panels/remove/
  - https://dockview.dev/docs/core/panels/rendering/
  - https://dockview.dev/docs/core/state/save/
  - https://dockview.dev/docs/core/state/load/
  - https://dockview.dev/docs/core/sizing/
  - https://dockview.dev/docs/core/panels/resizing/
  - https://dockview.dev/docs/core/groups/constraints/
  - https://dockview.dev/docs/core/theming/
  - https://dockview.dev/docs/core/dnd/overview/
  - https://dockview.dev/docs/core/watermark/
  - https://dockview.dev/docs/advanced/accessibility/
  - https://dockview.dev/docs/advanced/focus-navigation/
  - https://dockview.dev/docs/advanced/keyboard/
  - https://dockview.dev/docs/overview/licence/
- npm registry / downloads / bundlephobia：
  - https://registry.npmjs.org/dockview-react/latest
  - https://registry.npmjs.org/dockview/latest
  - https://registry.npmjs.org/dockview-core/latest
  - https://registry.npmjs.org/flexlayout-react/latest
  - https://registry.npmjs.org/rc-dock/latest
  - https://api.npmjs.org/downloads/point/last-week/dockview
  - https://api.npmjs.org/downloads/point/last-week/flexlayout-react
  - https://api.npmjs.org/downloads/point/last-week/rc-dock
  - https://bundlephobia.com/api/size?package=dockview@8.9.0
  - https://bundlephobia.com/api/size?package=flexlayout-react@0.11.1
  - https://bundlephobia.com/api/size?package=rc-dock@4.1.0
- flexlayout README（npm 包内）：https://unpkg.com/flexlayout-react@0.11.1/README.md
- flexlayout `IJsonModel.d.ts`：https://unpkg.com/flexlayout-react@0.11.1/types/model/IJsonModel.d.ts
- rc-dock README：https://unpkg.com/rc-dock@4.1.0/README.md
- rc-dock `DockData.d.ts`：https://unpkg.com/rc-dock@4.1.0/lib/DockData.d.ts
- 当前代码：`src/App.tsx`、`src/CommandPalette.tsx`、`src/TeamDashboard.tsx`、`src/TaskStarMap.tsx`、`src/SettingsView.tsx`、`src/styles.css`、`src/shared/deeplink.ts`、`electron/main.ts`、`docs/team/layout-final.md`

> 所有外部资料仅作为选型依据；版本/体积/下载量为 2026-11-09 拉取值，实现前需在锁版本后复测一次 bundle 与 a11y 行为。
