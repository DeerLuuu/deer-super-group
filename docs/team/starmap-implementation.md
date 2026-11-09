# 星图第二轮实现映射 · t46（Obsidian 风格重设计 / mika）

- **实现人**：mika（Frontend Engineer: layout）
- **依据**：`docs/team/starmap-obsidian-research.md`、`starmap-council.md`、`starmap-decisions.md`（t45 采纳 11 项）、黑板 bb-47（视觉/交互目标）与 bb-49（用户视觉目标优先）
- **验证**：`pnpm typecheck` ✅ · `pnpm build` ✅ · `pnpm test` 46/46 ✅（新增 `TaskStarMap.test.ts` 5 项图模型断言）
- **改动文件**：`src/TaskStarMap.tsx`（重写）、`src/TaskStarMap.test.ts`（新增）、`src/TeamDashboard.tsx`、`src/App.tsx`、`src/styles.css`（星图区块重写）

## S-ID → 文件 / 交互变化

### S01 默认视觉基线（8 票）
- 节点从 210×86 卡片改为 **6–14px 圆点/圆环**（`src/styles.css` `.star-dot`）：尺寸 = 连接数（DOT_MIN..DOT_MAX）；状态**颜色×形状双编码**——running/review/failed 实心（failed 加警示环）、blocked/ready 空心圆环、done 半透明、cancelled 弱化；running 外圈脉冲（reduced-motion 下停用）。
- 连线改 **1.1px 细灰直线**（`.star-edge`），done 半透明，箭头仅在 `scale≥1` 时显示（`show-arrows`）。
- 深色星点画布保留；不恢复卡片墙——卡片信息由 S03 标签与 S04 浮窗承接。

### S02 默认自然聚类布局：确定性力导向（7 票）
- `computeLayout()`：以分层 DAG 坐标为种子（createdAt 排序去随机），叠加**成对斥力 + 依赖连线弹簧（170px） + 依赖深度 x 软约束（LEVEL_X） + 质心回收**，固定 240 次迭代、α 线性衰减、重叠分离按索引方向（无随机源）。
- **确定性**：纯函数，同一任务集合两次计算坐标逐点一致（单测覆盖）；事件刷新（snapshot 变更）经内容键 memo 零重算、零跳动。
- 依赖方向仍大致沿 x 正向可读（单测：下游 x > 上游 x − 120 容差）。

### S03 缩放渐进标签 LOD（7 票）
- 阈值常量 `LOD_TITLE=0.55 / LOD_FULL=0.9`：<0.55 仅状态点；0.55–0.9 单行标题（≤12 字截断）；≥0.9 标题 + 状态·负责人两行。
- selected / hover / 聚焦源节点**任意缩放强制完整标签**；同屏标签 ≤ `MAX_LABELS=24`，优先级 selected > hover/focus > failed/blocked > 度数；截断保留原生 title。

### S04 单击浮窗 + 双击会话契约（8 票）
- 单击节点：选中（App 级 selectedTaskId 不变）+ 屏幕坐标**非模态浮窗**（`role=dialog`、`aria-modal=false`、随平移缩放重锚定、容器内钳制）：状态徽章/标题/负责人/上游 N·下游 M/摘要 2 行/任务 id。
- 动作：**打开会话**（onOpen→C14 对话页，返回团队）/ **在任务页打开**（新 prop `onOpenTaskPage`→App 选中并切任务页）/ **居中** / **聚焦**（进 S06）/ **复制 ID**。
- 双击节点或 Ctrl/⌘+Enter 进会话；Esc/空白关闭浮窗并**保留选中**、焦点归还触发节点；浮窗打开后聚焦首个动作。

### S05 hover/键盘邻居高亮（8 票）
- hover 或键盘 focus 节点（150ms 防抖）→ 中心 + 1 跳上下游全亮、相关边保持，**其余节点 0.25 / 边 0.12 透明度**（dim 不 hide、不重排）；浮窗显示「上游 N / 下游 M」计数（仅由 dependsOn 计算）。

### S06 Local Focus 1–3 跳 + 返回（6 票）
- 浮窗「聚焦」进入局部视图：depth 1–3 步进、上游/下游/双向切换；**范围外 dim（不删不重排）**；面包屑「全部任务 › 聚焦：标题 · 双向 d 跳 · n/total」+ 退出(Esc)。
- 退出**还原进入前视口**（preFocusView 快照）；C14 定位在聚焦态照常居中；聚焦/过滤计数经 aria-live 播报。

### S07 过滤/搜索 + 视图状态条（8 票）
- 星图顶部视图状态条：关键字搜索（标题/ID/负责人）+ 状态下拉（7 态）+「只看」开关；成员过滤 chip（点击清除，回调 TeamDashboard setMemberFilter）+ 清除全部。
- **dim 默认**（不匹配 0.15 透明度、布局不重算）；「只看」才 hide 并报「已隐藏 N 任务 / M 依赖边 / K 跨边界」；缺失端点依赖单独计数提示。
- 空结果两态：真无任务（EmptyState 引导去任务页）vs 过滤下无任务（清除过滤 CTA）。

### S08 图模型单一事实源 + owner hub 二级（7 票）
- `buildGraph(tasks)` 纯函数（已导出供测试）：layout/upstream/downstream/degree/issues；**dependsOn 唯一依赖边来源**；缺失端点只计数、不补假节点（单测覆盖）。
- **归属视图**（默认关，控制条「归属」切换）：owner 为下缘成员带 hub 节点 + **虚线无箭头归属边**（`.star-edge.owns`），不参与依赖语义/层级/坐标；点 hub = 成员过滤；图例明确「依赖（实线箭头）≠ 归属（虚线）」。

### S10 首访引导 + 稀疏/空图双态 + 帮助（6 票）
- 首访引导卡（`deer.starmap.guide.<workspaceId>` 记忆）：单击浮窗/双击会话/缩放平移/hover 邻域/聚焦/编码说明。
- 稀疏图（1–3 任务且未开归属）：提示卡 + 一键开启归属视图（不填假节点假边）；空图/过滤为空见 S07。
- 常驻**可折叠图例**（边类型/尺寸/状态色形状）；控制条「?」打开**帮助面板（复用 C25 Modal）**：手势快捷键表 + 图例 + **恢复默认视图**。

### S11 键盘可达性基线（8 票）
- 节点改 `<button>`，Tab 顺序按依赖层级；`aria-label`=标题/状态/负责人/N 上游 M 下游；Enter=选中+浮窗、Ctrl/⌘+Enter=会话。
- 画布 `tabIndex=0` + focus-visible 外框：方向键平移（Shift 加速）、+/−/0 缩放、Esc 逐级退出（浮窗→聚焦→高亮）；dim 节点仍可聚焦；`role=status` aria-live 播报聚焦/过滤；reduced-motion 停用脉冲与过渡。

### S12 镜头模型与视图状态（5 票）
- 视口 {x,y,scale} 正式状态；滚轮绕指针、+/− 绕中心；缩放平移不改选中、浮窗跟随重锚定。
- **任务更新不再 auto-fit**：仅显式「适应」/首次挂载/C14 定位改视口；任务集合变化显示「布局已更新 · 适应」chip。
- 视口+过滤+归属开关按工作区持久化（`deer.starmap.view.<workspaceId>`，不保存节点坐标）；控制条只读读数「缩放% · N 点 · M 边」。

## 保留能力（验收项）
- DAG 依赖边语义：边集 = dependsOn（单测断言无伪造）；C14 定位/居中（双 rAF + fitView 让位逻辑原样保留，适配新点坐标）；pan/zoom/fit；TeamDashboard 成员过滤；状态色沿用 C01 `--status-*` token；任务↔对话链路（打开会话→对话页任务上下文→返回团队）不变；底部完整任务详情保留（浮窗只做概述）。

## Obsidian 参考取舍（未采纳 → 未实现）
- S09 分组切换：未做（图例降级为状态色/形状 + 边类型 + 尺寸含义，正是采纳案文写明的降级形态）。
- S13 拖拽/固定、S14 性能分级、S15 关联区、S16 图层注册表：未实现（未采纳）。S14 的基本保障以 memo/内容键实现顺带覆盖，但未作验收项。
- 明确不借鉴：查询语言 Groups、tags/attachments 过滤、按引用数唯一编码、创建时间动画、保存节点坐标、minimap/pin/多选拖拽。

## 已知边界（供 t47 评审）
1. S12 的 hash 携带 zoom/filter 未接：deeplink 模块（C12）team 段扩展需协调，本轮以 localStorage 持久化替代，hash 集成留待评审判断是否补做。
2. 浮窗焦点为「打开聚焦首动作 + Esc 回焦节点」，未做 Tab 循环圈禁（非模态语义下 Tab 可达画布其余节点，符合 S04 非模态契约）。
3. 力模拟 O(n²×240)：≤200 节点毫秒级；更大规模属 S14（未采纳）范围。
4. 单击即开浮窗 + 双击会话：双击前会先触发一次单击（浮窗闪开即被关闭），与 bb-47「不与单击冲突」语义一致但存在一次闪动，评审可裁决是否加 250ms 延迟。
