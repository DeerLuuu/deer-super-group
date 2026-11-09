# 第 2 轮星图评审 · 集成与最终验收报告（t48）

- **场次**：第 2 轮「任务星图重设计为 Obsidian Graph View 风格」（2026-11-09）
- **任务**：t48 [integrate] 集成验收（in scope：`src/`、`docs/team/`）
- **集成人**：kai（Documentation & Integration）
- **输入**：
  - 硬目标：黑板 `bb-47`（视觉/交互目标）、`bb-49`（Captain 纠正：用户视觉目标优先于 t27 建议）
  - 研究/议程：`docs/team/starmap-obsidian-research.md`、`bb-48`
  - 决策：`docs/team/starmap-decisions.md`（t45：11 采纳 / 5 未采纳）
  - 实现映射：`docs/team/starmap-implementation.md`（t46 / mika）
  - 评审：t47（noor，`verdict=pass`；output 为空，acceptance/commands 完整 —— 见 IF-08）
- **验证**：`pnpm typecheck`、`pnpm build`、`pnpm test`（首轮与 IF-01/IF-02 修复后各执行一次，最终全部通过）

---

## 1. 最终结论

| 验收点 | 结果 | 依据 |
|--------|------|------|
| 评审 t47 已通过 | ✅ | `verdict=pass`；6 条 acceptance 全 `passed`（S01–S12 有实现证据、视觉契约、无伪造边、C14/过滤/缩放链路、未采纳零改动、4 项边界裁决）；output 为空但结论以 verdict 为准（IF-08） |
| 11 个采纳 S-ID 均可追溯 | ✅ | S01–S08、S10–S12 逐项对应到最终代码与行为（§2），与 `starmap-implementation.md` 一致 |
| typecheck / build / test 全部通过 | ✅ | 最终一轮：exit 0 / 0 / 0；测试 7 文件 46 用例全绿（§4） |
| `docs/team/starmap-final.md` 汇总采纳项、验证与后续项 | ✅ | 本文件 |
| 未采纳项没有被误改 | ✅ | S09/S13/S14/S15/S16 逐项核验保持原状（§6） |

**额外结论**：集成阶段发现并**修复 2 个缺陷**（IF-01：S04「点击空白关闭浮窗」缺失；IF-02：S12 切换工作区时视口/过滤串档并覆盖新工作区存档），另记录 8 项低/中优先级差异与后续项（§7）。修复后三命令重跑全过。

---

## 2. 采纳项交付清单（11 / 11）

票数与裁决见 `docs/team/starmap-decisions.md`；「实现位置」为最终代码（行号对应当前 HEAD）。

| S-ID | 票数 | 实现位置（最终代码） | 交付要点 | 验收证据 |
|------|------|----------------------|----------|----------|
| S01 | 8 | `src/styles.css:2160–2704`（星图 v2 区块）；`src/TaskStarMap.tsx:31–32`（DOT_MIN/MAX）、`:947`（`radiusOf` 度数定尺寸）、`:2245–2307`（状态颜色×形状双编码/选中/焦点环） | 6–14px 圆点/圆环、1.1px 细灰线（`:2205–2213`，done 半透明）、深色星点底；不再渲染 210×86 卡片；节点大小=连接数，状态=颜色+形状 | t47 pass；默认截图中无卡片墙；状态双通道 |
| S02 | 7 | `src/TaskStarMap.tsx:112–213`（`computeLayout`：分层种子 + 成对斥力/连线弹簧/x 软约束，无随机源，240 次迭代）、`:376`（modelKey）/`:383`（`model`）、`:200–213`（确定性排序） | 默认确定性自然聚类；同一快照两次计算坐标一致；事件刷新零重算；C14 focus 不重排 | 单测：确定性、方向容差；`src/TaskStarMap.test.ts` 5 条 |
| S03 | 7 | `TaskStarMap.tsx:28–30`（LOD_TITLE/FULL/MAX_LABELS）、`:872`（档位）/`:873`（`labelIds`，≤24，优先级 selected>hover/focus>failed/blocked>度数）、`:1242`（标签渲染：tier2 截断 12 字、tier3 标题+状态·负责人） | 三档 LOD；selected/hover/聚焦源任意缩放全标签；截断保留 title 全量；CSS `:2318–2357` | t47 pass；节点本体仍是圆点/圆环 |
| S04 | 8 | `TaskStarMap.tsx:787`（openPopover）/`:792`（closePopover）、`:901`（浮窗位置钳制）、`:1282`（`role=dialog`、`aria-modal=false`、5 字段、5 动作：打开会话/在任务页打开/居中/聚焦/复制 ID）、`:1220`（双击）/`:1228`（Ctrl/⌘+Enter） | 单击非模态浮窗、双击进会话、Esc 关闭并回焦；空白关闭见 IF-01（已修复）；底部完整详情保留 | t47 pass；C14 onOpen 链路统一 |
| S05 | 8 | `TaskStarMap.tsx:774`（150ms 防抖）、`:489`（1 跳邻居集合）、`:920`（`nodeClassName`）/`:931`（`edgeClassName`）的 dim 分类 | hover/键盘 focus 高亮中心+1 跳上下游，其余节点 0.25、边 0.12；dim 不 hide、不重排；浮窗显示上游 N/下游 M | t47 pass；CSS `.star-dot.dim/.star-edge.dim`（`:2215–2217`、`:2296–2298`） |
| S06 | 6 | `TaskStarMap.tsx:264`（`reachable` 1–3 跳）、`:351–352`（focusMode/preFocusView）、`:805`/`:811`（进入/退出并还原视口）、`:999`（聚焦面包屑与 −跳/+跳/方向/退出）、`:920`（范围外 dim） | 全局/局部双视图；1–3 跳、上/下游/双向；Esc 退出并还原进入前视口；C14 定位在聚焦态可用；「隐藏范围外」与“聚焦进 hash”未实现（IF-05） | t47 pass |
| S07 | 8 | `TaskStarMap.tsx:438`（matchFilter：标题/ID/负责人/状态）、`:1069`（过滤条 + 成员 chip + 清除全部 + 隐藏计数 + 缺失依赖计数）、`:460`（隐藏任务/边/跨边界统计）、`:1382`（过滤为空两态 + 清除 CTA） | dim 默认（布局不重算）；「只看」才 hide 并报「已隐藏 N 任务 / M 依赖边 / K 跨边界」；空结果区分真无任务/过滤下无任务；过滤持久化（S12） | t47 pass；成员过滤仍为上游预裁（IF-03，建议下一轮） |
| S08 | 7 | `TaskStarMap.tsx:216–261`（`buildGraph` 纯函数导出供单测）、`:395`（owner 下缘成员带）、`:1191`（虚线无箭头 `owns` 边）、`:1266`（owner hub 点击=成员过滤）、`:1440–1466`（图例：依赖实线/归属虚线/尺寸/状态） | `dependsOn` 唯一依赖边；缺失端点只计数不补假节点；owner 仅二级虚线、默认关、不参与依赖方向/坐标；图例区分两类边 | 单测：无伪造边、缺失只计数；t47 pass |
| S10 | 6 | `TaskStarMap.tsx:1411`（首访引导，按能力清单、`deer.starmap.guide.<workspaceId>` 记忆）、`:1396`（1–3 任务稀疏提示 + 归属视图入口）、`:1468`（只读读数/归属/「?」）、`:1523`（帮助 Modal：手势表/图例/恢复默认视图）、`:1369`（0 任务空态；CTA 缺失见 IF-04） | 首访引导、稀疏/空图双态、图例、帮助面板；无假节点假边 | t47 pass |
| S11 | 8 | `TaskStarMap.tsx:975–976`（画布 `tabIndex=0`/`role=application`）、`:822`（方向键平移、+/−/0、Esc 逐级退出）、`:1210`（节点 `<button>` + `aria-label` =标题/状态/负责人/N 上游 M 下游）、`:991`（aria-live）、`:605`（聚焦/过滤播报）；CSS `:2183`、`:2304`、`:2697–2704`（focus-visible、reduced-motion） | 键盘全链路（Tab/Enter/Ctrl+Enter/Esc）；dim 节点仍可聚焦；浮窗焦点入首个动作、Esc 回焦；reduced-motion 停脉冲/过渡 | t47 pass；浮窗 Tab 不圈禁为 t47 已裁决边界 |
| S12 | 5 | `TaskStarMap.tsx:337–338`（视口状态）、`:502`（fitView）、`:523`（按工作区恢复视口/过滤/归属，IF-02 修复）、`:592`（持久化）、`:1504`（布局已更新·适应）、`:1472`（只读读数）；fitView 不再随任务更新触发 | 视口正式状态；任务更新不 auto-fit；跨页返回/重挂载还原视角；视口+过滤+归属按工作区持久化（不存节点坐标）；readout「缩放% · N 点 · M 边」 | t47 pass；hash 携带 zoom/filter 未接（t47 已裁决边界） |

> 口径：t45 采纳 11 项 = S01–S08 + S10–S12；t46 实现文档逐项对应；t47 评审 6 条 acceptance 全部 passed；本表为集成复核后的最终落点。

---

## 3. 评审与流转

| 任务 | 对象 | 状态 | 结论 |
|------|------|------|------|
| t45 | 计票（8/8 成员，87 upvote / 0 downvote） | completed | 11 采纳 / 5 未采纳；S09、S14 各 3 票差 1 票 |
| t46 | 实现（mika） | completed | 11 项全部实现；typecheck/build/test 46/46；4 项已知边界写入实现文档 |
| t47 | 评审（noor） | completed，`verdict=pass` | 6 条 acceptance 全 passed：S01–S12 实现证据、bb-47+bb-49 视觉契约、无伪造边、C14/过滤/缩放链路、未采纳零改动、4 项边界裁决（hash 视口/浮窗圈禁/力模拟规模/单击双击闪动） |

**集成复核意见**：t47 的 6 条覆盖成立；4 项边界裁决无异议（均在实现文档与决策文档中可查）。t47 未覆盖的两处功能缺口已由本任务修复（IF-01/IF-02）；另一处需产品取舍的缺口（IF-03 成员过滤受控化）记录为下一轮建议，未擅自改动。

---

## 4. 最终验证（t48 实跑）

### 命令与结果

| 命令 | 结果 | 退出码 | 关键输出 |
|------|------|--------|----------|
| `pnpm typecheck` | ✅ | 0 | `tsc --noEmit` 无输出 |
| `pnpm build` | ✅ | 0 | `vite build`：278 modules transformed；`dist/index.html 0.40 kB`、`dist/assets/index-COajJk9S.js 485.54 kB (gzip 145.96 kB)`、`index-2jLekCe5.css 39.44 kB (gzip 7.97 kB)`；`build:electron`：`main.cjs 843.5kb`、`preload.cjs 2.3kb` |
| `pnpm test` | ✅ | 0 | `vitest run`：**Test Files 7 passed / Tests 46 passed**（3.36s）；含 `src/TaskStarMap.test.ts` 5 条图模型用例、deeplink 13 条、Markdown 2 条、kernel 18 条、models 8 条 |

### 执行记录

1. **首轮**（修复前）：typecheck 0 / build 0 / test 46/46（构建产物 `index-D9lTOQgU.js`）。
2. **集成静态核对**发现 IF-01（S04 空白关闭缺失）→ 修复；复跑 0/0/0（产物 `index-hDyd40td.js`）。
3. **继续核对**发现 IF-02（S12 切换工作区串档）→ 修复；**最终**复跑 0/0/0（产物 `index-COajJk9S.js`）。

> `dist/`、`dist-electron/` 为验证要求产生的构建产物（out of scope），未手工修改。

---

## 5. 决策 ↔ 实现 ↔ 代码一致性 & Obsidian 参考取舍

- **覆盖**：`starmap-decisions.md` 的 11 项采纳在 §2 逐项落到最终代码与行为；实现文档 `starmap-implementation.md` 的 S-ID → 文件/交互描述与代码一致（本次复核未发现冲突条目）。
- **硬目标（bb-47 + bb-49）**：默认小圆点/圆环 + 细线 + 深色底 + 自然聚类 ✅；无 210×86 卡片默认 ✅；`dependsOn` 唯一依赖边、无伪造节点/边 ✅（`buildGraph` + 单测）；owner hub 仅二级虚线且默认关、图例区分 ✅；单击浮窗 + 双击会话 ✅；C14 定位/居中、成员过滤、状态色、pan/zoom/fit、任务↔对话链路保留 ✅。
- **借鉴 Obsidian**：小圆点/细线/深色画布（S01）、自然聚类（S02）、Text fade threshold 式 LOD（S03）、点击打开/空白关闭（S04）、hover 邻居（S05）、Local graph + depth（S06）、Filters + 状态可见（S07）、Groups 的图例思路降级为固定图例（S08/S10）、键盘平移缩放/回车打开（S11）、视图状态记忆（S12）。
- **明确不借鉴（本轮）**：查询语言式 Groups、tags/attachments/unresolved 过滤、按引用数定尺寸作为唯一编码、创建时间回放动画、保存节点坐标/pin、minimap、多选拖拽、canvas 渲染。
- **降级项（S09 未采纳）**：不做分组切换；图例只列「状态色/形状 + 两类边 + 尺寸含义」，不展示负责人/深度分组 —— 与决策文档降级形态一致。

---

## 6. 未采纳 5 项零改动核验

| S-ID | 提案 | 核验证据（最终代码） | 结论 |
|------|------|----------------------|------|
| S09 | 分组切换 + 单一主编码 + 图例 | 星图无 `groupBy`/分组切换控件；图例仅状态色/形状、两类边与尺寸（`TaskStarMap.tsx:1440–1466`），无负责人/深度分组 | 未动 ✅ |
| S13 | 节点拖拽/固定/复位 | 节点无 `draggable`/拖动处理；`onPointerDown` 只在空白起平移（`:736`），节点仅点击/双击/键盘（`:1210`） | 未动 ✅ |
| S14 | 大图性能与渲染分级 | 无 culling/渲染分级/性能阈值逻辑；仅 S02 的内容键 memo（`:376`/`:383`）与 fitView 降级，不构成 S14 实现 | 未动 ✅ |
| S15 | 任务↔团队/对话/决定关联区 | 浮窗/底部详情无 `refs` 关联区、无 boardEntries/messages 查询；全 `src/` 无 `refs` 渲染 | 未动 ✅ |
| S16 | 图层注册表 + 能力层占位 + 视图偏好 | 无 `GraphLayer` 注册表、无能力层占位、无显示设置 popover；`归属` 开关属 S08 的 owner 二级图层，不属 S16 | 未动 ✅ |

---

## 7. 集成发现与处理

### IF-01（**已修复**，S04）：点击空白不关闭浮窗

- 位置：`src/TaskStarMap.tsx` `onPointerDown`（`:736` 起，空白关闭分支 `:741`）。
- 问题：原实现只有 Esc 与动作按钮会关闭浮窗；bb-47 #4 与候选 S04 均要求「点击空白关闭」。t47 未覆盖该点。
- 修复：空白按下（即将开始平移）时 `closePopover(false)` —— 关闭浮窗、保留选中、不抢焦点；点击节点/浮窗内部不触发。
- 验证：三命令最终一轮全过；逻辑上不影响双击/平移。

### IF-02（**已修复**，S12）：切换工作区时视口/过滤串档

- 位置：`src/TaskStarMap.tsx:369–371`（`initializedWorkspaceRef`）、`:523`（按工作区初始化 effect）、`:592`（持久化 effect）。
- 问题：原用一次性 `didInitRef` 初始化；切换工作区时组件不重挂载 → 新工作区不读取自己的存档，且持久化 effect 因 `workspaceId` 变化把旧视口/过滤写进新工作区存档（新存覆盖旧档）。
- 修复：初始化改为按 `workspaceId` 记录与重放（读存档或 fitView，并重置过滤/归属默认值）；持久化与「布局已更新」提示都加工作区守卫。
- 验证：三命令最终一轮全过；按工作区读/写语义与 S12 一致。

### 评审已接受的边界（t47 裁决，集成复核无异议）

1. **hash 视口/过滤未接**（S12）：`src/shared/deeplink.ts:68` 的 team 段只带 `?t=`；star map 视口/过滤/聚焦仅在 localStorage 与会话内。t47 已裁决留待后续。
2. **浮窗 Tab 不圈禁**（S04）：非模态语义下 Tab 可到画布其余节点；焦点入首个动作 + Esc 回焦节点已实现。
3. **力模拟 O(n²×240)**（S02）：≤200 节点毫秒级；更大规模属 S14（未采纳）。
4. **单击/双击闪动**（S04）：双击前会先开一次浮窗；t47 接受（可下一轮加 250ms 延迟）。

### 集成新发现（未修复，建议下一轮）

| 编号 | 严重度 | 问题 | 证据 | 建议 |
|------|--------|------|------|------|
| IF-03 | 中 | S07「成员过滤必须提升为受控状态（不能先裁任务再构图）」未落实：TeamDashboard 仍先裁 `visibleTasks` 再传给星图，成员过滤时跨成员依赖边被静默移除且无计数 | `TeamDashboard.tsx:90–92,218`；决策文档 `starmap-decisions.md:79` | 下一轮把 `memberFilterId` 纳入 `matchFilter`、星图接收全量 tasks（dim 优先），「清除过滤」CTA 同时清成员过滤 |
| IF-04 | 低 | S10「0 任务 CTA『去规划/新建』」缺失：空态只有说明文字，无按钮 | `TaskStarMap.tsx:1369–1377` | 增加 `onGoToTasks` 回调（App→TeamDashboard→星图）并在空态挂 CTA |
| IF-05 | 低 | S06「可选隐藏范围外」未实现（仅 dim）；S06「聚焦进 hash」未实现；S07「搜索 fly-to + 浮窗」未实现（`centerOn` 仅浮窗动作） | `TaskStarMap.tsx:920`（范围外 dim）、`:1069`（过滤条，无 fly-to）、`:720`（centerOn） | 下一轮随 hash 集成（C12 team 段）一并补 |
| IF-06 | 低 | S04 摘要为 96 字截断 + CSS 2 行 clamp，无「展开」；候选文本为「2 行可展开」 | `TaskStarMap.tsx:1313`（摘要截断）；`styles.css:2459–2467` | 加「展开」切换或改为 line-clamp + title 全文 |
| IF-07 | 低 | S12 视口持久化 effect 依赖 `view`，平移/缩放每帧写一次 localStorage | `TaskStarMap.tsx:592`（持久化 effect） | 250ms 防抖或 pointerup/zoom 结束后写 |
| IF-08 | 低 | t47 评审 output 为空（verdict/acceptance/commands 完整） | 团队状态 t47 | 评审任务补一句自然语言结论（同 t26 先例） |
| IF-09 | 低 | 图例 `STATUS_LEGEND` 未列 cancelled（节点有该状态样式）；`.star-popover-meta` 无独立 CSS 规则（靠 muted/tiny） | `TaskStarMap.tsx:294–301`；`styles.css` 无 `.star-popover-meta` | 图例补 cancelled；补 meta 样式或删类名 |
| IF-10 | follow-up | README 与 `docs/*.png` 截图仍是旧星图（`docs/team-preview.png` 等） | `README.md:41–44` | 文档同步任务更新截图与说明 |

---

## 8. 后续项

1. **下一轮优先复议**：S09（分组切换，3 票）、S14（大图性能分级，3 票，差 1 票）；S13/S15/S16 各 1 票转下一轮。
2. **建议下一轮一并做的缺口**：IF-03 成员过滤受控化（S07 契约）、IF-04 0 任务 CTA（S10 契约）、IF-05 隐藏范围外/fly-to/聚焦进 hash、IF-06 摘要展开、IF-07 持久化防抖、IF-09 图例补全。
3. **hash 集成**：S12/C12 的 team 段扩展（`?t=` + 视口/过滤/聚焦参数），单列小任务并补 deeplink 单测。
4. **性能**：S14 未采纳，保留 100 节点 pan/zoom 观察项（非阻断）；若后续任务规模上升再单列。
5. **文档**：更新 README 星图说明与截图（IF-10）；`docs/team/` 增加索引（研究/候选/决策/实现/最终报告）。
6. **体验观察（非阻断）**：单击/双击闪动可加 250ms 判定；浮窗摘要展开；图例默认折叠在 >15 节点时更省空间。

---

## 9. 复现与交接

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # vite build && pnpm build:electron
pnpm test        # vitest run（7 文件 / 46 用例）
pnpm dev         # Electron 开发运行（需二进制）
```

- **深链**：`#/team?t=<taskId>`；星图视口/过滤/聚焦暂不写 hash（t47 已裁决边界）。
- **人工冒烟清单**（对应决策文档验证口径）：
  1. 默认视觉：无 210×86 卡片，圆点 6–14px、边 1.1px、深色底；
  2. 布局确定性：刷新/事件更新后节点坐标不跳变，显示「布局已更新 · 适应」chip（不自动 fit）；
  3. 8 节点夹具：8 节点 / 8 依赖边 / 无伪造边（单测已覆盖）；
  4. 单击节点 → 浮窗 5 字段 + 5 动作；点击空白/Esc 关闭；双击/Ctrl+Enter 进会话（C14「返回团队」可用）；
  5. 局部聚焦：1–3 跳、上/下游/双向、面包屑、Esc 还原视口；
  6. 过滤：dim 默认；「只看」隐藏并显示隐藏任务/依赖/跨边界计数；成员过滤 chip 可清除；空结果两态；
  7. LOD：0.3/0.6/1.0 三档内容正确，selected 在低缩放仍全标签、同屏 ≤24；
  8. 键盘：Tab→节点→Enter 浮窗→Esc 回焦；Ctrl+Enter 开会话；方向键平移、+/−/0；
  9. 归属视图：默认关；开启后 owner hub + 虚线归属边，图例区分；不产生依赖边；
  10. 100 节点 pan/zoom 观察项（S14 未采纳，不阻断）。
- **文件清单**：
  - 修改：`src/TaskStarMap.tsx`（重写 + IF-01/IF-02 集成修复）、`src/TeamDashboard.tsx`、`src/App.tsx`、`src/styles.css`（星图 v2 区块）
  - 新增：`src/TaskStarMap.test.ts`、`docs/team/starmap-obsidian-research.md`、`starmap-council.md`、`starmap-decisions.md`、`starmap-implementation.md`、`starmap-final.md`（本文件）
  - 生成（不手工修改）：`dist/`、`dist-electron/`
- **变更记录**：
  - t46：S01–S08/S10–S12 实现（详见 `starmap-implementation.md`）
  - t47：评审 verdict=pass（4 项边界裁决）
  - t48（本任务）：修复 IF-01（空白关闭）、IF-02（工作区持久化）；新增本文件；未触碰未采纳项
