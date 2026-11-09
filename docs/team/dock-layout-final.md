# Dock 布局与主界面 · 集成与最终验收报告（t52）

- **场次**：主界面 Dock 布局（VSCode 风格，对话/团队为主）｜2026-11-10
- **任务**：t52 [integrate] 集成验收（in scope：`src/`、`docs/team/`）
- **集成人**：kai（Documentation & Integration）
- **输入**：
  - 设计：`docs/team/dock-layout-design.md`（t49 / sol，选型 dockview-react 8.9.0）
  - 实现：`docs/team/dock-layout-implementation.md`（t50 / mika + t56 修复记录）
  - 评审：t51（noor，`needs_revision`，D1 high / D2 medium / D3 low）→ t56 修复 → **t57 复审 `verdict=pass`**
  - 裁决：`bb-83`（Q1 minWidth 960、Q4 快捷键改绑、F3 拖拽组数守卫等）
- **验证**：`pnpm typecheck`、`pnpm build`、`pnpm test`（修复前基线、修复后最终各一轮，最终全部通过）

---

## 1. 最终结论

| 验收点 | 结果 | 依据 |
|--------|------|------|
| t51 评审通过 | ✅ | t51 `needs_revision` 的 3 条 findings 由 t56 全部修复（D1 快捷键改绑、D2 minWidth 960、D3 拖拽组数守卫），t57 复审 `verdict=pass`（output 为空，权威取 verdict/acceptance/commands，见 IF-11） |
| 对话与团队默认同时可见，布局符合设计 | ✅（修复后） | 无显式深链冷启动：主组激活「对话」、团队右组可见（IF-01 修复；详见 §7.1）；变体权重 wide 58/42、medium 56/44、narrow 52/48、single 单组 |
| tab 拖动/拆分/合并/调整大小/关闭重开与持久化可用 | ✅ | dockview 原生 DnD + DockShell 关闭/重开/持久化（§7.2）；键盘调宽修复（IF-02）；无 e2e，DnD 手测项见 §10 |
| 6 个视图与 hash/命令面板/C14/Modal/Toast/侧栏链路无回归 | ✅ | 6+1 面板注册表、deeplink 模块与 13 条测试零改动、面板命令组 8 项、C14 定位/返回 openPanel、Modal/Toast 全局、侧栏 6 项 + aria-current（§7.3）；「查看上下文」打开上下文面板（IF-04 修复） |
| typecheck / build / test 全部通过 | ✅ | 最终一轮 exit 0/0/0；测试 7 文件 46 用例（§6） |
| `docs/team/dock-layout-final.md` 输出选型、布局、验证与后续项 | ✅ | 本文件 |

**额外结论**：集成阶段发现并修复 **4 个缺陷**（IF-01 冷启动主面板、IF-02 键盘调宽、IF-03 深链重开被关闭面板、IF-04 任务详情「查看上下文」未开上下文面板），另记录 7 项低优先级差异/后续项（§8）。所有修复后三命令重跑通过。

---

## 2. 选型结论（复核 t49）

**主选：dockview-react 8.9.0（MIT core，`package.json` 精确锁版本，`dockview-core` 同版本）** —— 复核确认：
- `package.json:17–18` 锁定 `dockview-core 8.9.0` / `dockview-react 8.9.0`，无 `^` 漂移。
- 采用理由（与 t49 §3 一致）：WAI-ARIA 文档级支持（tablist/tabpanel/region、roving tabindex、live region、focus-visible）、MIT 焦点/移动 API（`activateNext`/`adjacentGroupInDirection`/`panel.api.moveTo`）、`toJSON/fromJSON` 布局序列化、panel min/max 随布局持久化、React 19 peer、周下载体量。
- 未使用其 enterprise 特性（空间键盘导航/键盘 docking/pinned tabs/多行 tabs/布局历史），键盘等价物由自定义快捷键 + 命令面板补齐（F6 未做，见 IF-08）。
- 备选 flexlayout-react 0.11.1（适配层可切换）、rc-dock（淘汰：React content 不入序列化、无 a11y 承诺）、自研（淘汰：600–900 行 + 拖拽/ARIA 风险）——复核无异议。
- 代价：构建产物由 ~485 kB 增至 ~898 kB（gzip 243 kB），触发 >500 kB 警告（IF-10）。

---

## 3. 默认布局与变体（复核 t49/t50）

- **面板注册表 7 个单例**（`src/shell/dock/panelRegistry.ts:38`）：chat/team/context/tasks/mailbox/board/settings；min 宽 420/360/280/560/480/360/560；`settings` `closable: false`（`:114`，t49 §7.4 草稿保护）；`context` `defaultClosed: true`（`:71`）。
- **默认布局**（`DockShell.tsx:140` `buildDefaultLayout`）：主组 chat 锚 + tasks/mailbox/board/settings 同组 tab；`team` 以 `direction: "right"` 拆分右组；宽窗组宽 = dockWidth × 42/44/48%（≥360 下限）；`single`（<760）合并为单组 tab。
- **变体**（`panelRegistry.ts:131–147`）：wide ≥1100 / medium ≥900 / narrow ≥760 / single <760；按 `.dock-host` 实测宽度选择（`App.tsx:162` 起 ResizeObserver，`setDockWidth` 于 `:166`）；跨档 flush 旧变体存档 → 按新变体缓存/默认重建。
- **冷启动激活**：无显式深链 → 对话（IF-01 修复后）；显式 `#/tasks` 等 → 对应面板；`context` 不参与 hash（`routeTabFromPanel` 返回 null，`panelRegistry.ts:209`）。
- **术语与 hash**：6 个 RouteTab 映射沿用 `src/shared/deeplink.ts`，schema 与测试零改动（§7.3）。

---

## 4. 交付清单（实现落点）

| 区域 | 文件 / 行 | 交付要点 |
|------|-----------|----------|
| Dock 容器 | `src/shell/dock/DockShell.tsx:140`（默认布局）、`:171`（rebuild 恢复/清除）、`:242`（onReady 事件桥接）、`:264`（变体切换）、`:274`（工作区切换）、`:284`（beforeunload flush）、`:297`（DockHandle） | 7 面板渲染容器、默认双主面板、事件/持久化/命令编排；App 不接触 dockview 类型 |
| 面板注册表/持久化 | `src/shell/dock/panelRegistry.ts:38/114/120/131/142/160/164/166/190/201` | 面板定义、主组顺序、权重、变体、`deer.dock.v1.<workspaceId>`（schema/version/64KB 校验、损坏回退、清 key） |
| App 接线 | `src/App.tsx:93–96`（bootPanel/tab）、`:150`（openPanel 唯一入口）、`:157`（active→路由）、`:182`（状态→hash 防环，effect 至 `:201`）、`:331`（初始深链应用）、`:347`（hashchange→openPanel）、`:672`（面板命令分发）、`:897–910`（侧栏）、`:951`（面包屑）、`:1041–1170`（DockShell + renderPanel）、`:1198`（ToastHost） | 导航/深链/dock 双向同步、C14 全部走 openPanel、Modal/Toast 保持全局 |
| 命令面板 | `src/CommandPalette.tsx:107–116`（面板组 8 项）、`:259–260`（footer 快捷键） | 打开上下文/关闭当前/移动×4/恢复默认/重置所有；快捷键提示与 t56 改键一致 |
| 键盘/组约束 | `DockShell.tsx:364`（键盘 effect：Ctrl+Shift+Alt+方向键、Ctrl+Shift+Alt+[ ]、Ctrl+Alt+W）、`:395`（onWillDrop 4 组守卫）、`:348`（resizeActiveGroup） | bb-83 F1/F3 落实；`electron/main.ts:30` minWidth 960（F2） |
| 样式 | `src/styles.css:3151–3241` | `.dock-host`/`.dock-panel-body`（贴边 + 12px 内边距 + 自管滚动）、dockview token 映射、水印、reduced-motion |

---

## 5. 评审与修复流转（t51 → t56 → t57）

| 阶段 | 结果 |
|------|------|
| t51（noor，首轮） | `needs_revision`：D1（high）快捷键仍为 Ctrl+Alt+方向键、命令面板 hint 未同步；D2（medium）`electron/main.ts` minWidth 仍 1100，single 变体不可达；D3（low）4 组上限仅键盘/命令路径，拖拽未挂 `onWillDrop` |
| t56（mika，repair-round-2） | 3/3 修复：移动/拆分改 Ctrl+Shift+Alt+方向键、调宽改 Ctrl+Shift+Alt+[ ]、Ctrl+Alt+W 保持，CommandPalette/注释/帮助文案同步；minWidth 960（960/1100 两档算术冒烟）；`onWillDrop` 拆分型 drop 拒绝并 toast。typecheck/build/test 全过 |
| t57（noor，复审） | `verdict=pass`：D1/D2/D3 逐项复核通过；acceptance 6 项（S 范围、契约、无伪造、未采纳零改动、边界）全 passed；output 为空（IF-11），commands 全过 |

**集成复核**：t56 的 3 项修复在最终代码中成立（`DockShell.tsx:364` 键盘改键、`:395` onWillDrop 守卫、`electron/main.ts:28–31` minWidth 960、`CommandPalette.tsx:107–116/259–260` 提示同步）；t51 的 D1/D2/D3 均闭环，无残留。

---

## 6. 最终验证（t52 实跑）

| 命令 | 结果 | 退出码 | 关键输出 |
|------|------|--------|----------|
| `pnpm typecheck` | ✅ | 0 | `tsc --noEmit` 无输出 |
| `pnpm build` | ✅ | 0 | 283 modules transformed；`dist/index.html 0.40 kB`、`dist/assets/index-DOyxSJV_.js 897.77 kB (gzip 243.26 kB)`、`index-eppCHzoJ.css 41.41 kB (gzip 8.31 kB)`；`build:electron`：main.cjs 843.6kb、preload.cjs 2.3kb；**chunk >500 kB 警告**（IF-10） |
| `pnpm test` | ✅ | 0 | `vitest run`：**Test Files 7 passed / Tests 46 passed**（3.39s）；含 `deeplink.test.ts` 13 条（零改动）、`TaskStarMap.test.ts` 5 条、kernel 18 条、models 8 条、Markdown 2 条 |

### 执行记录

1. **修复前基线**：exit 0/0/0，46/46（产物 `index-CS3uxjef.js`）。
2. **IF-01 修复**：首版 `bootPanel` 误用 `PanelKey`（比 `Tab` 宽）触发 `TS2345` → 立即改为 `Tab | null`；随后 0/0/0（产物 `index-OXAdAMrz.js`）。
3. **IF-02/IF-03/IF-04 修复后最终轮**：0/0/0（产物 `index-DOyxSJV_.js`），即上表数据。

> `dist/`、`dist-electron/` 为验证要求产生的构建产物（out of scope），未手工修改。

---

## 7. 验收链路核对

### 7.1 对话与团队默认同时可见

- **冷启动（无显式深链）**：`App.tsx:93–96` `bootPanel = null` → `DockShell.buildDefaultLayout`（`:140–168`）创建主组（chat 锚）与团队右组（`direction:"right"`），target 回退 `chat`（`:162–168`）→ 主组显示对话、右组显示团队；同时 `tab` 初始为 `chat`，hash 首次写 `#/chat`（replace，不新增历史）。
- **显式深链**（`#/tasks?t=` 等）：`bootPanel = initialRoute.tab`，激活对应面板（仍保留 chat/team 双组）；`#/router` 经 deeplink 重定向 tasks 不变。
- **变体**：wide/medium/narrow 均为「主组 + 团队右组」；single 合并单组 tab（设计 §11，<760 不可达时不会误隔离）。
- **说明**：t49 设计 §9 曾写「空 hash 沿用 C12 默认 `#/tasks`，冷启动激活任务 tab」，该例外与验收「对话/团队默认同时可见」及设计 §4 `activePanel=chat` 冲突；本任务按验收与 §4 修正为冷启动激活对话（IF-01），显式深链行为不变。**请 Captain 确认此项裁决**（若坚持 §9 例外，回退点仅 `App.tsx:93–96` 一处）。

### 7.2 tab 拖动/拆分/合并/调整/关闭重开/持久化

- **拖动/拆分/合并**：`DockviewReact` 未禁用 drag；dockview 原生 tab 拖拽到组边缘拆分、拖入组合并、分栏拖动调宽；4 组上限在鼠标路径由 `onWillDrop` 守卫（`DockShell.tsx:395`：拆分型 drop 且 `api.groups.length >= 4` → `preventDefault` + toast；center 放行），键盘路径在 `moveActivePanel` 内同样检查（`:324` 起）。
- **调整大小**：分栏 sash 原生拖拽；键盘 Ctrl+Shift+Alt+[ / ] 经 `resizeActiveGroup`（`:348`，IF-02 修复为 `boundingBox.width` 基准 ±80，下限 280）。
- **关闭/重开**：tab ×、Ctrl+Alt+W、命令面板「关闭当前面板」；settings 拒绝并 toast（`:307` 起）；重开走 `openPanel`/`ensurePanel`（`:129`）：已有实例激活，不存在时 team 落右组、其余落主组 tab。
- **持久化**：`onDidLayoutChange` → 400ms 防抖 → `toJSON` 按 `workspaceId × variant` 写入 `deer.dock.v1.<workspaceId>`（schema/version/64KB 校验，损坏删 key 回退，`panelRegistry.ts:160–207`）；beforeunload/卸载/变体切换/工作区切换均 flush（`DockShell.tsx:264`、`:274`、`:284`）；`fromJSON` 失败回退默认（`:199` catch → `:204` 默认布局）。
- **恢复默认**：命令面板「恢复默认布局」（当前变体重建、保持激活面板）/「重置所有布局」（confirm 后清 key）（`App.tsx:672` 起）+ 空布局水印按钮（`DockShell.tsx:438`）。
- **限制**：DnD 与真实窗口缩放手测未纳入自动化（无 Playwright/e2e），见 §10 手测清单。

### 7.3 6 视图 + hash/命令面板/C14/Modal/Toast/侧栏 无回归

- **6 视图 + 上下文**：`App.tsx:1049–1170` `renderPanel` 覆盖 tasks/team/chat/mailbox/board/settings + context；侧栏 6 项 `openPanel`（`:897–910`），`aria-current` 由派生 `tab` 驱动（`:909`）；路径式面包屑沿用（`:951`）。
- **hash**：`src/shared/deeplink.ts` 与 `deeplink.test.ts` **零改动**（13 条通过）；App 状态→hash（push/replace + 防环 `:182` 起）、hashchange→`openPanel`（`:347` 起）、初始深链选中回填（`:331` 起）均保留；`context` 不写 hash。
- **命令面板**：新增「面板」组 8 项（打开上下文/关闭当前/移动×4/恢复默认/重置所有），快捷键提示与 t56 改键一致（`CommandPalette.tsx:107–116/259–260`）；Alt+1–6 改走 `openPanel`。
- **C14**：任务→星图定位 `openPanel("team")+starmapFocus`（`App.tsx:648`）；对话「返回任务/团队」`openPanel(contextSource)`（`:1120`）；「查看上下文」同时打开上下文面板（IF-04）；任务会话/上下文来源保留。
- **Modal / Toast**：C25 Modal 与 C26 ToastHost 挂 shell 全局（`:1198`），不受面板关闭影响；错误 banner 仍在 topbar 下方。
- **侧栏**：分组/折叠（C09）不变；≤1100 自动折叠与 dock 变体联动；侧栏拖宽触发 `.dock-host` ResizeObserver → 变体重算。
- **上下文抽取**：ChatView 移除内嵌上下文列/拖拽条/显隐切换，保留任务上下文徽标、返回来源、工作区概述卡；头部「上下文」按钮 → `openPanel("context")`（`:2315`）；`ContextPanel` 独立面板复用（`:2456`）。

---

## 8. 集成发现与处理

### 已修复（代码变更，发生在 t57 之后，已披露）

| 编号 | 严重度 | 问题 | 修复 | 证据 |
|------|--------|------|------|------|
| IF-01 | 高（验收级） | 冷启动（空 hash）按 C12 默认激活「任务」tab，主组显示任务、对话内容不可见，与验收「对话与团队默认同时可见」/设计 §4 `activePanel=chat` 冲突 | `App.tsx:93–96`：无 `#/` 深链时 `bootPanel=null` → DockShell 默认激活 chat；显式深链仍优先；deeplink 模块/默认路由契约不变 | 3 命令最终轮通过；设计 §9 例外已在本报告 §7.1 披露 |
| IF-02 | 中 | 键盘调宽 `resizeActiveGroup` 读取 `group.api.width`（dockview 未暴露该属性）→ 恒以 480 为基准，按一次跳到 400/560 | `DockShell.tsx:348` 改用公开 `group.api.boundingBox.width`（无则 480），±80、下限 280 | 代码走查 + 3 命令通过 |
| IF-03 | 中 | 首帧深链指向的面板若在用户保存布局里被关闭，`rebuild` 只 reconcile chat/team，不重开该面板 → 深链被静默改写为其它 tab（违背设计 §9「关闭的面板在 hash 命中时自动重开」） | `DockShell.tsx:188` 起：restore 后若 `activateKey` 不存在则 `ensurePanel` 补开 | 代码走查；hashchange 路径本就重开，行为一致 |
| IF-04 | 中低 | 上下文抽为独立面板后，任务详情「查看上下文」只 `openPanel("chat")`，动作名与结果不符（旧版为内联上下文） | `App.tsx:1070–1075`：onContext 同时 `openPanel("context")` | 代码走查；C14 主链路仍可用 |

### 未修复（记录 / 后续项）

| 编号 | 严重度 | 问题 | 证据 | 建议 |
|------|--------|------|------|------|
| IF-05 | 低 | 设计要求的上下文迁移未实现：老用户 `deer.contextVisible === "1"` 首次升级应自动打开上下文面板并 toast 一次（§4.6A/§5.2/§8.3） | 全 `src/` 无 `deer.contextVisible` 读写；实现文档偏差未列此项 | 下一轮加一次性迁移（保留旧 key，避免反复迁移） |
| IF-06 | 低 | 设计 §11 single 变体应显示「窗口过窄，已切换为标签模式 · 恢复双栏」提示，未实现 | `src/` 无「标签模式/恢复双栏」文案 | 下一轮补提示 + 一键恢复 wide/medium |
| IF-07 | 低 | 设计 §4.6A 要求上下文面板头部「关闭上下文」= `panel.api.close()`，当前仅能通过 tab × 关闭 | `ContextPanel`（`App.tsx:2456–2531`）无关闭按钮 | 下一轮补头部关闭按钮 |
| IF-08 | 低 | 设计 §10 的 F6 / Ctrl+Shift+\ 组焦点快捷键未实现（实现文档偏差 #3 已记录） | `src/` 无 F6 绑定 | 下一轮随 dockview 焦点 API 补齐 |
| IF-09 | 低 | 已记录的实现偏差：上下文打开拆分规则简化为 tab（#2）、组级 `setConstraints` 未重放（#4）、持久化防抖统一 400ms（#5）、团队紧凑模式未做（#6）、模块合并为 2 文件（#1） | `dock-layout-implementation.md:48–54` | 接受（本轮验收不涉及）或下一轮排期 |
| IF-10 | follow-up | 构建产物 897.77 kB（gzip 243.26）超过 500 kB 警告；dockview 使 JS 从 ~485 kB 增至 ~898 kB；另 `.content` 为死 CSS（`styles.css:435`） | 构建输出；`App.tsx` 不再渲染 `.content` | 动态导入 DockShell / manualChunks；清理死 CSS |
| IF-11 | 低（流程） | t57 复审 output 为空（verdict=pass、acceptance/commands 完整） | 团队状态 t57 | 评审任务补一句自然语言结论（同 t26/t47 先例） |

### 限制说明

- 无 Playwright/e2e：tab DnD、输入法下快捷键、960/1100 窗口实测、中文输入法组合键行为均依赖人工冒烟（§10）；本验收以「代码走查 + 三命令 + 设计映射核对」为准，已在验收表中如实标注。

---

## 9. 后续项

1. **Captain 裁决**：IF-01 的冷启动默认（对话 vs 设计 §9 的 tasks 例外）请确认；若保留 §9 例外，回退点仅 `App.tsx:93–96`。
2. **下一轮补齐**：IF-05 上下文迁移、IF-06 single 提示、IF-07 上下文面板关闭按钮、IF-08 F6/组焦点快捷键。
3. **性能/工程**：IF-10 代码分块（DockShell 动态导入）、清理 `.content` 死 CSS；保留 dockview 8.9.0 精确锁版本，升级需同步回归 A-L/A-D/A-S/A-C/A-P/A-N/A-K/A-R 清单。
4. **团队紧凑模式**（设计 §4.6B，偏差 #6）：`<560` 成员 chips 化，建议与容器查询一并做。
5. **人工冒烟基建**：把 §10 清单做成可勾选 release checklist；后续若引入 Playwright，优先覆盖「关闭重开 + 刷新恢复 + hash 往返 + 4 组守卫」。

---

## 10. 复现与人工冒烟

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # vite build && pnpm build:electron
pnpm test        # vitest run（7 文件 / 46 用例）
pnpm dev         # Electron 开发运行
```

**人工冒烟清单（关键 12 项）**：
1. 冷启动（无 hash）：主组显示对话、右组显示团队；刷新后回到 `#/chat` 且布局恢复。
2. 显式 `#/tasks?t=<id>`：任务面板激活，对话/团队双组仍在；`#/router` 重定向任务。
3. tab 拖到组边缘拆分、拖入合合并、分栏拖动调宽；超过 4 组拆分被拒绝并 toast。
4. 关闭对话/团队/任务/邮箱/黑板/上下文某面板 → 从侧栏/命令面板/深链重开；settings 关闭被拒绝。
5. 关闭所有可关闭面板（若 settings 不在布局）→ 水印「所有面板已关闭」+ 打开对话/恢复默认可用。
6. 改名布局（拖拽/调宽/关闭）→ 刷新恢复；命令面板「恢复默认布局」「重置所有布局」行为正确。
7. 切换工作区：各自布局独立，切回原工作区恢复原布局与激活面板。
8. 侧栏 6 项、面包屑、`aria-current`、Ctrl+B 折叠、Alt+1–6 与激活面板一致。
9. 命令面板：Ctrl+K → 面板组 8 项可执行；footer 快捷键文案与 t56 改键一致。
10. C14：任务「在星图中定位」→ 团队面板居中；对话「返回任务/团队」；任务「查看上下文」打开对话 + 上下文面板。
11. 缩放到 single：窗口 960 + 侧栏展开时 dock=710 → 单组 tab；恢复宽窗后双栏/比例正确（960/1100 两档）。
12. 输入法激活下 Ctrl+Shift+Alt+方向键 / `[ ]` 不触发系统行为；Modal/Toast/dock 关闭互不影响。

- **文件清单**：
  - 新增：`src/shell/dock/panelRegistry.ts`、`src/shell/dock/DockShell.tsx`、`docs/team/dock-layout-design.md`（t49）、`docs/team/dock-layout-implementation.md`（t50+t56）、`docs/team/dock-layout-final.md`（本文件）
  - 修改：`src/App.tsx`（dock 接线 + ChatView 上下文抽取 + 冷启动默认 IF-01 + 「查看上下文」IF-04）、`src/CommandPalette.tsx`（面板命令组）、`src/styles.css`（dock 主题）、`electron/main.ts`（minWidth 960，t56）、`package.json`/`pnpm-lock.yaml`（dockview 8.9.0）、`src/shell/dock/DockShell.tsx`（IF-02/IF-03 集成修复）
  - 生成（不手工修改）：`dist/`、`dist-electron/`
- **变更记录**：
  - t50：按 t49 实现 Dock 布局（dockview-react 8.9.0）
  - t56：bb-83 三项修复（快捷键改绑、minWidth 960、拖拽组数守卫）
  - t57：复审 verdict=pass
  - t52（本任务）：修复 IF-01（冷启动默认对话）、IF-02（键盘调宽基准）、IF-03（深链重开被关闭面板）、IF-04（查看上下文两面板联动）；新增本文件；未改未采纳/范围外面
