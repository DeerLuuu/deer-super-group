# Chat → Plan Draft · 可编辑 DAG 草案设计（P0-4）

- **状态**：需求/交互设计，未写生产代码
- **任务**：t230
- **基线**：main `53862c9`（P0-1 / P0-2 / P0-3 已合入后）；现有 Ping/Chat/Tasks/Dock/WorkflowRail 形态
- **依据**：`docs/team/ux-audit-final.md` P0-4、bb-98、bb-97
- **目标**：把规划从 Tasks 的 goal-only Modal 拉回 Chat；在**确认前零任务副作用**的前提下，生成、编辑、校验并一次性创建可执行的 DAG。
- **不做什么**：不改 review/merge gate、权限、任务状态机；不新增第二任务数据源；不在本任务增加任务级执行契约列（见 §7）；不重写 Dock/App。

---

## 0. 结论先行（需要 Captain 确认的 8 个默认）

1. **Plan Preview 只读**：新增 `previewPlan`（LLM 规划 + 纯校验），不调用 `store.createTask`、不 append `router.plan`、不刷新任务、不自动打开 Tasks。
2. **确认才建任务**：`confirmPlan` 在一个 Store 事务里创建整张 DAG；任一失败全部回滚；不自动运行、不自动改 owner 成员/预算/权限。
3. **草案在 Dock 面板，不在 Modal**：Chat 提供入口，完整编辑器作为 `planDraft` Dock 面板；1440 可在主组 tab，960 在 single 主组，不新增宽度列/rail 项。
4. **100% 带入当前对话**：Chat 捕获当前对话上下文 + composer 目标 + 工作区 overview，原样送入 planner；不做 UI 静默截断、不要求重输。超上限时**阻断生成并要求用户显式压缩/缩小范围**，不偷偷丢上下文。
5. **DAG 以本地 `d1..dn` 草案 ID 编辑**：依赖、增删、排序、owner、优先级全部在本地；确认时才映射为真实 task ID。
6. **执行契约是只读投影**：owner、model、permission、FT、context、budget 显示其真实来源。P0-4 **不允许**逐任务改 model/permission/FT/budget（Task 表没有这些列；强行加列会违反“不新数据源/不动数据层”）；owner 选择就是契约的可编辑杠杆，另提供去 Team/Settings/Watchdog 的链接。逐任务契约留 P1-5。
7. **复用现有 plan API**：同一 planner prompt/parse、同一 `tasks` 表、同一 `router.plan` 事件；新增 preview/confirm 只是把现有 `plan` 的“生成”和“创建”拆开。旧 `plan` 保留兼容，UI 不再直接调用。
8. **幂等 + 原子**：客户端 `confirmId` + 服务端事务内 `appendEventIdempotent("plan.confirm:<key>")`；双击/超时重试返回同一批 task IDs；事务失败不产生半张 DAG。

---

## 1. 现状盘点：现在确实是“点一下直接建任务”

### 1.1 调用链

```text
Tasks 页「规划任务」
  → RouterPlanModal（goal-only Modal）
  → onSubmit: onPlan(goal); onClose()
  → App.handlePlan(goal)
      → setBusy(true)
      → window.deer.plan(workspaceId, goal)
          → IPC router:plan
          → AppService.plan(workspaceId, goal)
              → 读 settings.model（全局模型，不是 Chat/Router 当前模型）
              → LLM complete(ROUTER_PLANNER, goal + workspace/path/overview)
              → parsePlan(completion.text)
                  ├─ 成功：tasks[]（title/description/acceptance/dependsOn 索引）
                  └─ 失败：静默 fallback 为一个「goal 截断为标题」的任务
              → 逐个 store.createTask(...)          ← 任务立刻写入
              → 逐个 store.updateTask(dependsOn)    ← 依赖写回
              → store.appendEvent("router.plan")
              → return Task[]
      → refresh(snapshot)                            ← 全量刷新
      → 选中 tasks[0]、loadTrace(tasks[0])
      → openPanel("tasks")                           ← 自动切走
      → toast「已规划 N 个任务」
```

关键源码位置：

| 位置 | 现状 |
|---|---|
| `src/kernel/service.ts:1789` `AppService.plan` | LLM 规划与 `store.createTask` 在同一方法里；没有 preview 分支 |
| `src/kernel/service.ts:290` `parsePlan` | 只接受 `title/description/acceptance/dependsOn`（零基索引）；无 owner/优先级/契约 |
| `src/kernel/service.ts:1843-1857` | `createTask` 逐个创建；之后才 `updateTask(dependsOn)`；**不在一个事务内** |
| `src/kernel/service.ts:1832-1839` | JSON 解析失败 **静默 fallback 一个任务** |
| `src/shared/ipc.ts:122` / `electron/main.ts:213` | `plan(workspaceId, goal)` 直达 `AppService.plan`；无 preview |
| `src/App.tsx:1888` `handlePlan` | 成功后 refresh、选中首任务、打开 Tasks、toast；均有副作用 |
| `src/App.tsx:4301` `RouterPlanModal` | 只有一个 goal textarea；提交即 `onPlan` + 关闭；没有预览/编辑 |
| `src/shared/ipc.ts:100` / `service.ts:578` | `createTask` IPC 只接受 title/description/acceptance/scopePaths；不接受 owner/depends/priority |
| `src/kernel/store.ts:1356` | Store 内部可写 `ownerId`/`dependsOn`，priority 固定 50；这是现有能力，不是第二事实源 |
| `src/shared/types.ts:68-110` | `Task` 有 status/ownerId/dependsOn/priority，但**没有** model/permission/FT/context/budget 字段 |
| `src/App.tsx:1839` / `ChatView` | Chat 的模型/权限/FT 控制写 Router agent；`plan` 却读全局 `settings.model`，两者不一致 |
| `src/App.tsx:2991` | Chat 入口/组件已存在，但没有「从这段对话规划」按钮 |

### 1.2 “点一下”实际发生了哪些副作用

| # | 副作用 | 现状 | P0-4 目标 |
|---|---|---|---|
| S1 | LLM 调用/成本 | 立即发生 | **预览仍会调用 LLM**（这是用户主动生成，不是隐藏副作用）；失败不建任务 |
| S2 | `tasks` 插入 | 立即发生 | **只有 confirm 才发生** |
| S3 | `dependsOn` 更新 | 立即发生 | 与任务插入在同一事务内 |
| S4 | `router.plan` 事件 | 立即发生 | 只在 confirm 事务内发生 |
| S5 | 全量 `refresh` | 立即发生 | 预览不 refresh 任务；confirm 成功后一次 refresh |
| S6 | 选中首任务 / loadTrace | 立即发生 | confirm 成功后导航；预览不改变当前选中 |
| S7 | 切到 Tasks 面板 | 立即发生 | 预览留在 Chat/Plan Draft；confirm 后才打开 Tasks |
| S8 | success toast | 立即发生 | 预览不出现「已规划」；confirm 成功才有 |
| S9 | 解析失败 fallback 任务 | 立即发生 | 预览返回 `PLAN_UNPARSEABLE`，**不 fallback** |
| S10 | 非事务部分失败 | 可能留下半张 DAG | 新 confirm 事务全成/全败 |
| S11 | Chat 契约（model/permission/FT） | 完全不进入 plan | 作为只读来源显示；owner 决定任务执行契约 |

### 1.3 现状缺口（P0-4 要修的）

- **入口断层**：Chat 讨论完要切 Tasks，重述 goal；Chat 没有 plan 按钮。
- **无预览**：没有任务/依赖/owner/验收/风险/契约预览，只有 Modal 的 goal。
- **无确认**：`plan` 即创建，无法取消、编辑、修正后再确认。
- **契约不一致**：Chat 控制条改的是 Router agent；plan 用全局 `settings.model`；创建出的任务没有 owner/priority/contract；运行时契约由 owner agent/FT/workspace 决定，用户看不到。
- **部分失败**：`createTask` 循环不在一个事务，第二次插任务失败会留下第一批。
- **fallback 静默建任务**：模型输出坏 JSON 也建一个任务，用户没有机会修正。
- **没有 owner/priority**：plan 创建的任务 owner 为空、priority 固定 50；无法在确认前分配。
- **无并发/重复确认保护**：双击/重试没有 idempotency；网络超时不知道任务是否已建。
- **无 960 规划体验**：Modal 是短表单；长 DAG 没有可编辑容器；P0-4 明确 Plan Draft 不是普通 Modal。

---

## 2. 设计原则

1. **事实源只有一个**：任务事实源仍是 `tasks` 表；草案不是任务、不是事件、不是第二数据源。草案只存在于 renderer 的 App 状态中。
2. **先预览，后提交**：LLM 生成和持久化严格拆开；preview 可重试、可丢弃；confirm 才写。
3. **确认前零任务副作用**：preview/编辑/校验/取消不写 tasks、不写 `router.plan`、不刷新任务、不自动选任务、不自动跑任务、不改 agent/预算/权限。
4. **原子 DAG**：confirm 在一个 `BEGIN IMMEDIATE` 事务内建整张 DAG；失败回滚全部。
5. **不伪造能力**：没有 Task 契约列就不做“每任务 model/permission/FT”假编辑；显示真实 owner/agent/workspace 来源，给出真实链接。
6. **无障碍优先**：列表编辑是主路径，DAG 图是辅助；不依赖拖拽、不依赖颜色、不依赖鼠标。
7. **1024/960 可用**：Plan Draft 是 Dock 面板，960 single 下单列表单 + 可切换紧凑依赖视图；不横向裁切。

---

## 3. Plan Draft 数据模型（UI-only）

> 全部类型是**草案 DTO**，不落库、不进 `Snapshot`、不进事件。类型名建议放 `src/shared/planDraft.ts`，renderer/kernel 共用纯校验；但不建表。

### 3.1 `PlanSource`（100% 带入的冻结源）

```ts
type PlanGoalSource = "composer" | "last_user_message" | "edited";

interface PlanSource {
  workspaceId: string;
  capturedAt: string;
  /** 当前 composer 非空则用它；否则最近一条 user message；都空则入口禁用。 */
  goalText: string;
  goalSource: PlanGoalSource;
  /** 当前 Chat 工作上下文（已加载的消息 + 压缩摘要），按原顺序。 */
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  }>;
  /** 若当前上下文已被 compact，摘要必须一起带入，不能只带尾部。 */
  compactedSummary: string | null;
  workspaceOverview: string | null;
  characterCount: number;
  /** canonical JSON 的 SHA-256；只做变更检测/显示，不做安全边界。 */
  digest: string;
  /** Chat 控制条当前值；只用于显示与 planner 说明，不写回。 */
  chatContract: {
    modelProfileId: string | null;
    modelLabel: string;
    permission: PermissionMode;
    fullThrottle: boolean;
  };
}
```

**100% 的定义**：

- “100%”指**当前 Chat 工作上下文 + composer 目标 + 已压缩摘要**原样进入 preview 请求；不是重新向用户要 goal，也不是 UI 随机采样。
- 若 `goalText` 来自 composer，显示“使用输入框目标”；否则显示“使用最近一条用户消息”。
- 预览面板顶部显示：来源为“当前对话”、消息数、字符数、是否含压缩摘要、source digest 前 8 位；用户能核对。
- **不做静默截断**：若 `characterCount`/估算 token 超过 `PLAN_SOURCE_MAX`（建议 24k chars，实测后定），preview 返回 `SOURCE_TOO_LARGE`，UI 不生成草案，给两条真实路径：
  1. 使用现有 Chat「压缩上下文」后重试（摘要会进入 source）；
  2. 明确“仅使用输入框目标”生成（source 改为 composer goal，UI 显示范围已缩小）。
- 预览生成后若 Chat 有新消息（digest 变化），**confirm 禁用**并显示“对话已更新”：用户必须「基于新对话重新生成」或明确「仍按旧源确认」（后者要二次确认；默认不推荐）。这是避免“100% 带入”在确认时偷偷变旧。

### 3.2 `PlanDraft`

```ts
type PlanDraftStatus =
  | "generating"
  | "editing"
  | "confirming"
  | "error"
  | "confirmed";

interface PlanDraft {
  id: string;                 // renderer randomUUID；不是 task id
  workspaceId: string;
  revision: number;           // 每次本地编辑 +1；confirm 绑 revision
  status: PlanDraftStatus;
  source: PlanSource;
  tasks: PlanDraftTask[];
  planRisks: PlanRisk[];
  validation: PlanValidation;
  createdAt: string;
  updatedAt: string;
  /** 预留给“恢复”；当前只在 App 内存，不写 localStorage/sessionStorage。 */
}
```

### 3.3 `PlanDraftTask`

```ts
interface PlanDraftTask {
  /** 本地稳定 id：d1, d2...；不冒充 task id，不写进后端。 */
  id: string;
  title: string;
  description: string;
  acceptance: string[];
  dependsOn: string[];        // 只能引用本草案内的 task.id
  ownerId: string | null;     // null = 未分配（warning，不是静默）
  priority: number;           // 0..100，整数；默认 50（与 Task.priority 一致）
  risks: string[];            // 生成 + 用户可编辑
  unknowns: string[];         // 生成 + 用户可编辑
  contract: PlanContractSnapshot; // 从 owner/工作区派生；只读
}
```

字段来源：

| 字段 | 可编辑 | 持久化到 Task | 说明 |
|---|---|---|---|
| title | 是 | 是 | 必填，trim 后非空 |
| description | 是 | 是 | 可空但建议写 |
| acceptance | 是（增删） | 是 | 空验收是 warning，不静默 |
| dependsOn | 是（多选） | 是 | 本地 ID → 真实 task ID |
| ownerId | 是（workspace agents） | 是（`Task.ownerId`，既有列） | null = 未分配 warning；非 workspace owner = error |
| priority | 是（0–100） | 是（`Task.priority`，既有列） | Store 新图形创建方法透传；无迁移 |
| risks/unknowns | 是 | **否** | 草案辅助信息，不新增任务列；确认后不持久化，避免 second source |
| contract | **否** | **否** | 见 §3.4；避免假控件/数据层扩张 |

### 3.4 `PlanContractSnapshot`（真实来源，不伪造）

```ts
interface PlanContractSnapshot {
  ownerId: string | null;
  modelProfileId: string | null;
  modelLabel: string;
  permission: PermissionMode | null;
  fullThrottle: boolean | null;  // 仅 Router 会话有真实 FT；owner 不是 Router 时为 null
  context: {
    policy: "workspace+chat+task+deps";
    sections: Array<"workspace" | "chat" | "task" | "dependencies">;
  };
  budget: {
    workspaceDayRatio: number | null;
    workspaceDayLimitUsd: number | null;
    taskLimitUsd: number | null;
    hardAction: string | null;
  };
  source: "owner" | "chat" | "workspace" | "mixed" | "unavailable";
  editable: false;
  note: string; // 例如“模型/权限来自 owner 成员；FT 仅 Router 会话”
}
```

**为什么只读**：

- `Task` 表当前没有 `model/permission/full_throttle/context_policy/budget` 列；运行契约由 `task.ownerId` 对应 agent 的 `model/permission`、Router 的 FT 会话、`getContext` 和 watchdog budget 决定。
- 若在 P0-4 在任务上强行落这些字段，就必须改数据层/迁移，且会有“草案值”和“实际执行值”两套事实源，违反本任务约束。
- 因此 P0-4 的契约编辑**只有一个真实杠杆：owner**。选择 owner 后，model/permission 从该 agent 实时投影；FT/budget/context 标真实来源并给去 Team/Settings/Watchdog 的链接。**逐任务契约 override 明确留 P1-5**，届时需要新列 + 迁移 + 新的执行链路，不在本 PR。

**混合 owner**：不同任务的 owner 可能不同，plan-level contract 显示 `source:"mixed"`、`modelProfileId:null`、文案“多成员执行，按各 owner 的模型/权限”；每个任务卡显示自己的 owner 契约。不会把某一个成员的值冒充全 plan。

### 3.5 风险/未知与验证

```ts
interface PlanRisk {
  id: string;
  severity: "low" | "medium" | "high";
  title: string;
  detail: string;
  taskId?: string;            // 可选关联某草案任务
  source: "planner" | "user";
  acknowledged: boolean;
}

interface PlanValidation {
  errors: PlanIssue[];        // 阻断 confirm
  warnings: PlanIssue[];      // 不阻断，但必须在 UI 显示；可要求勾选 acknowledgedWarnings
  acknowledgedWarnings: string[];
}

interface PlanIssue {
  code: string;               // 稳定 code，见 §5
  field?: string;             // "tasks.d2.title" / "plan"
  message: string;
  taskId?: string;
}
```

- 高风险（`severity:"high"`）必须 `acknowledged=true` 才能 confirm；这是“风险不埋掉”的最低成本做法。
- 低/中风险显示但不阻断；用户可编辑 `risks/unknowns`。
- **警告不会静默消失**：confirm 按钮旁始终显示 `N 个警告`，展开可见；确认时记录到 `router.plan` event 的 payload 摘要（不新建事实源）。

---

## 4. 入口与 UI

### 4.1 Chat 入口（唯一入口）

- `ChatView` 头部/尾部增加 **「从这段对话规划」** button：
  - 位置建议：Chat header 右侧（与「上下文」「轨迹」同组）或在 composer controls 上方；不新增全局面板按钮。
  - `aria-label="从当前对话生成规划草案，不会创建任务"`；tooltip 必须包含“不会创建任务”。
  - **启用条件**：有 `goalText`（composer 或最近 user message）且 `chatBusy` 为 false；空对话显示禁用 + 原因。
  - 点击时 **只捕获 PlanSource 并打开 `planDraft` Dock 面板**；不生成任务；生成由面板触发（也可点击后立即生成，但仍是只读 preview）。
  - Chat 里显示 **草案摘要 card**（状态、任务数、未确认 badge、来源），点击“继续编辑”重开面板。这样 Chat 不失去上下文。
- **入口不接受在 Task Modal 中填 goal**：Tasks 的旧「规划任务」按钮改为：
  - 空态/头部 → 打开 Chat 并 focus「从这段对话规划」；
  - 不直接打开旧 RouterPlanModal；旧 Modal 从 UI 移除（代码选项保留至旧 API 下线）。
- `WorkflowRail` 的“计划”阶段 CTA（`去规划`）同样路由到 Chat 入口；不直接打开 Plan Draft，除非已有草案（已有则重开草案）。
- `PrimaryRail` 仍只有五个一级入口；**不新增“规划”rail 项**；规划是 Chat 的子动作 + Dock 面板。

### 4.2 Plan Draft Dock 面板

- 新增 `planDraft` PanelKey（`panelRegistry`/`DockShell`），**不新增 hash 路由**；从 Chat 打开到主组 tab，不新增宽度列。
- 面板不是 Modal：没有焦点陷阱，Escape 只关闭本地弹出菜单，不关闭整个面板（关闭由面板 X/取消按钮负责，且有未确认提示）。
- 1440：两栏：
  - 左/主：任务卡列表（编辑表单）；
  - 右：紧凑 DAG（按拓扑层列）；底部 sticky 校验/确认条。
- 960 / single：单列；顶部 `列表 | 依赖` segmented control；底部 sticky 确认条；任务卡内字段折行；无横向滚动。
- 面板头：
  - `Plan Draft` + `未创建任务` 状态徽章；
  - 来源摘要（当前对话、N 条、含摘要、source digest 前 8 位）；
  - `返回对话`；`重新生成`（带覆盖确认）；`取消草案`。
- 任务卡：
  - 标题、描述、验收列表（增删）、`owner` select、`priority` number/stepper；
  - 依赖多选（按本地标题；已选依赖显示 chips；循环时不能选并显示原因）；
  - 风险/未知（只读生成 + 可加 note）；
  - contract chips（只读）+ “来源/为什么不可编辑” popover + 去 Team/Settings/Watchdog 链接；
  - 上移/下移/删除（删除前确认依赖者；有依赖者时提示先改依赖）。
- “+ 添加任务”创建空 `dN`（无副作用；空标题显示 error）。
- 任务顺序：仅影响创建顺序和列表展示；**不承诺 Task 持久化排序**（Task 无 order 列），confirm 后按 created_at 等现有列表排序。不要把它做成第二数据源。
- 依赖可视化：
  - 以 **拓扑层列** 渲染卡片（root → 后续层），边用 SVG/HTML 线或 `d1 → d2` 文本；
  - 卡片可点击聚焦对应编辑卡；
  - “列表/依赖”切换；依赖图是辅助，**键盘和读屏走列表编辑**；
  - 不引入第三方图库；不伪造边、不按标题猜依赖。
- 校验区：
  - error summary 置顶（`role="alert"`），warning 可展开；
  - confirm CTA 文案固定：`确认创建 N 个任务`；disabled 时 `aria-describedby` 指向错误摘要；
  - confirming 时 `aria-busy`，按钮禁用，表单只读；
  - 取消/关闭：有编辑时二次确认“丢弃草案？（不会影响已创建任务）”；**取消不写任何东西**。

### 4.3 与 WorkflowRail / PrimaryRail / Dock / Tasks 的关系

| 表面 | 关系 |
|---|---|
| **PrimaryRail** | 不新增；Chat 仍是一级入口；Plan Draft 不是 rail 项 |
| **WorkflowRail** | “计划”阶段 CTA 打开 Chat 规划入口；**草案本身不改变 stage**（草案不是任务事实）；确认后 tasks 才让 stage 变化 |
| **NeedsMe** | 不聚合未确认草案；草案错误是本地 UI，不进 NeedsMe；确认失败的 task 才会成为后续 NeedsMe |
| **Dock** | Plan Draft 是普通 Dock 面板（主组 tab）；用户可关闭；关闭不丢草案（App 内存）；960 single 内 tab；不新增右组 |
| **Tasks** | 保留列表/DAG/任务详情；旧 Plan Modal UI 移除，按钮改跳 Chat 入口；确认后打开 Tasks 并选中首任务 |
| **Chat** | 讨论/来源/入口/摘要 card；不把 Plan Draft 做成第二个 Chat 页面 |
| **Settings/Team/Watchdog** | 契约只读来源的链接；不改其数据（owner 选择只改任务归属，不改成员档案） |

---

## 5. 校验规则（client + server 共用纯函数）

### 5.1 Plan 级

| Code | 级别 | 规则 |
|---|---|---|
| `PLAN_EMPTY` | error | 至少 1 个任务 |
| `PLAN_TOO_MANY_TASKS` | error | ≤ 12（建议；现有 prompt 2–4，用户可加） |
| `SOURCE_EMPTY` | error | goal 为空且无消息 |
| `SOURCE_TOO_LARGE` | error | 超过 `PLAN_SOURCE_MAX`，禁止 preview（要求显式压缩/缩小） |
| `SOURCE_CHANGED` | error（confirm） | draft.source.digest ≠ 当前 Chat digest；必须重新生成或二次确认旧源 |
| `PLAN_RISK_HIGH_UNACK` | error | 存在未 ack 的 high risk |
| `DUPLICATE_TITLE` | warning | 标题重复（不阻断，提示合并） |
| `ISOLATED_TASK` | warning | 多任务中某任务无上游也无下游（独立任务不一定是错，但不隐藏） |

### 5.2 Task 级

| Code | 级别 | 规则 |
|---|---|---|
| `TASK_TITLE_REQUIRED` | error | 空白 title；trim 后长度 1–200 |
| `TASK_DESCRIPTION_EMPTY` | warning | 空描述（允许，但提示补全） |
| `TASK_ACCEPTANCE_EMPTY` | warning | 空验收（允许，但提示）；不静默 |
| `TASK_ACCEPTANCE_TOO_MANY` | error | > 30 项（防异常 payload） |
| `TASK_PRIORITY_INVALID` | error | 非整数或 0–100 之外 |
| `OWNER_UNASSIGNED` | warning | ownerId=null；任务可创建，但运行前需分配/由现有调度逻辑处理 |
| `OWNER_UNKNOWN` | error | owner 不在当前 workspace agents |
| `OWNER_INACTIVE` | error | agent 已删除/不可用（以当前 snapshot 为准） |
| `OWNER_ROUTER` | warning | 指派 Router 为 owner（允许，但提示它也是对话 agent） |
| `CONTRACT_UNAVAILABLE` | warning | owner 无有效模型/权限；显示原因；不伪造契约 |
| `SOURCE_CONTRACT_MIXED` | info/warning | 多 owner；plan-level contract 为 mixed |

### 5.3 依赖/孤儿/环

- `DEPENDENCY_MISSING`（error）：`dependsOn` 引用了不在 `draft.tasks` 的 ID（即“孤儿引用”）。
- `DEPENDENCY_SELF`（error）：自己依赖自己。
- `DEPENDENCY_DUPLICATE`（error）：同一依赖重复。
- `DEPENDENCY_CYCLE`（error）：DFS/Kahn 检测；显示最长环路径（如 `d2 → d3 → d2`）。
- `DEPENDENCY_OUTSIDE_DRAFT`（error）：引用已创建任务/其它工作区（本任务只允许草案内依赖；外部依赖用“提交后编辑任务”后续能力，不在 P0-4 混淆）。
- **孤立**：允许没有依赖也没有被依赖的任务（root/independent），但 `ISOLATED_TASK` warning；不自动连线、不伪造依赖。
- 任务顺序：由拓扑层展示；**cycle 时 confirm 不可用**。

### 5.4 确认时的服务端校验

- **不信任客户端**：服务端用同一 `validatePlanDraft` + 重新读取 workspace agents/tasks；
- 检查 `workspaceId`、owner 存在、依赖本地 ID 完整、priority、task 数、标题；
- 若 owner 在 preview 后被删除 → `OWNER_UNKNOWN`，**无写入**；
- 若 source digest 与请求声明不一致 → 拒绝（防止 UI 用旧源冒充 100%）；
- **contract 不进入 confirm 持久化**；服务端按 owner 重新投影执行契约，避免客户端伪造。

---

## 6. 确认/失败/幂等/并发

### 6.1 `previewPlan`（只读）

请求：

```ts
interface PreviewPlanRequest {
  workspaceId: string;
  source: PlanSource;
}
interface PreviewPlanResult {
  draft: PlanDraft;        // status=editing, tasks from LLM, local d ids
  sourceDigest: string;
}
```

行为：

1. 校验 source（空/超限）；
2. 用现有 `ROUTER_PLANNER` 的 prompt 思路，但输入改为 **完整 source（goal + messages + summary + workspace overview）**；
3. 使用 **Router/Chat 当前有效模型**（不是全局 `settings.model`），temperature 0.2；planner 不启用工具；
4. 解析输出；**解析失败返回 `PLAN_UNPARSEABLE`，不 fallback 任务**；
5. 把 tasks 转成本地 d IDs；`dependsOn` 索引转 d IDs；owner 默认 null；priority 默认 50；
6. 不写 tasks/事件，不 refresh 任务，不选任务，不打开 Tasks，不 toast“已规划”。

### 6.2 `confirmPlan`（原子创建）

```ts
interface ConfirmPlanRequest {
  workspaceId: string;
  idempotencyKey: string;     // 客户端每次确认生成一次；重试保持不变
  draftId: string;
  revision: number;
  sourceDigest: string;
  tasks: Array<{
    localId: string;
    title: string;
    description: string;
    acceptance: string[];
    dependsOn: string[];
    ownerId: string | null;
    priority: number;
  }>;
  acknowledgedRisks: string[];
}

interface ConfirmPlanResult {
  tasks: Task[];              // 真实 task IDs
  alreadyConfirmed: boolean;  // 幂等命中
}
```

事务内步骤：

1. `BEGIN IMMEDIATE`；
2. **先查 idempotencyKey**：若 `router.plan` 事件已存在，读取 payload.taskIds，返回 tasks + `alreadyConfirmed:true`；**不再插入**。
3. 重新校验（§5），失败 → 回滚，返回结构化 error；
4. 为每个 localId 生成真实 task id，先插入 task 投影（owner/priority/no deps 初始）；
5. 映射 dependsOn → 真实 ID，在同一事务内 `updateTask` 依赖/状态（root ready，dependents blocked/waiting_dependencies）；
6. append **一次** `router.plan` 事件（复用现有 type，不新增事件表/事件类型源）：
   ```json
   {
     "goal": "...",
     "draftId": "...",
     "sourceDigest": "...",
     "tasks": ["task_..."],
     "acknowledgedRisks": ["..."]
   }
   ```
   带 `idempotencyKey: "plan.confirm:<key>"`；
7. `COMMIT`；
8. 返回 tasks。

**原子边界**：任务插入、依赖更新、事件追加全在同一个 Store 事务内。任何一步失败 → `ROLLBACK`，**没有半张 DAG**。

**UI 成功后**：close Plan Draft；refresh snapshot；`openPanel("tasks")`；选中 `tasks[0]`；toast `已创建 N 个任务`；不自动 run。

**不自动做的事**：不自动 startTask、不改 owner agent、不 setFullThrottle、不 setWatchdogBudget、不创建 Run、不写记忆。

### 6.3 重复确认/双击

- UI：`confirmingRef` + `status="confirming"` 双保险；按钮 disabled、表单 readOnly、`aria-busy`；忽略第二次 click/Enter。
- 客户端：同一 draft/revision 使用同一 `idempotencyKey`；重试不换 key。
- 服务端：事件 idempotency；并发第二个事务在第一个 commit 后查事件，返回 same task IDs。
- **成功后**：即使响应丢失，重试返回 `alreadyConfirmed:true`；UI 显示“已创建（幂等命中）”并导航，不重复建。
- **用户改完草案再确认**：revision 变化 → 新 `idempotencyKey`；仅当上一请求确定为失败（无事件）或用户明确“放弃上次，重新创建”才允许；网络未知时不自动换 key（防重复）。

### 6.4 并发编辑

- **同一窗口**：单 draft 状态；生成/确认时表单只读；编辑在本地 reducer 串行，revision++。
- **两个 Dock tab / 两个窗口**：P0-4 声明**非协同编辑**；每个窗口的 draft 是独立本地状态，不互相推送；不使用服务端草稿锁。第二个窗口若从同一 Chat 生成会得到新 draft；这是独立用户动作，不在服务端自动合并。文档/UI 不承诺协同。
- **Chat 在草案打开期间更新**：source digest 变化 → banner + confirm 禁用（§3.1）；用户显式重新生成或确认旧源（二次确认）。
- **workspace 切换**：关闭/丢弃草案前二次确认；server confirm 始终带 workspaceId，owner 不在 workspace 时拒绝；不跨 workspace 创建。
- **owner 被删除/权限变更**：confirm server 校验失败，**无写入**；UI 返回任务卡改 owner；不自动选另一个 owner（避免静默）。
- **任务列表外部变化**：草案依赖只在草案内；不把外部任务当依赖；confirm 不修改既有任务。

### 6.5 失败语义

| 阶段 | 结果 | 语义 |
|---|---|---|
| LLM preview 失败/解析失败 | `PLAN_UNPARSEABLE` / `PLAN_GENERATION_FAILED` | 无任务；保留 source；面板 inline retry；**不 fallback** |
| Source 超限/空 | `SOURCE_TOO_LARGE` / `SOURCE_EMPTY` | 无 preview；要求显式压缩/补目标 |
| 客户端校验失败 | errors | 无请求；focus error summary；confirm disabled |
| 服务端校验失败 | `PLAN_INVALID` + issues | 无写；返回字段级错误；draft 保留 |
| 事务失败（DB/约束） | `PLAN_COMMIT_FAILED` | 全部回滚；无任务；同一 key 可重试 |
| 网络超时/未知 | `PLAN_CONFIRM_UNKNOWN` | **不换 key**；提供“重试确认”（同一 key）；不得直接再建 |
| 幂等命中 | `alreadyConfirmed` | 展示已创建任务；不重复 |
| 提交成功但 UI refresh 失败 | `tasks` 已提交 | 不重试创建；显示“已创建，刷新失败”，提供打开 Tasks/重试刷新 |
| 部分失败 | **不发生** | 由事务保证；若测试发现，视为 blocker |

### 6.6 取消 / 恢复

- **取消草案**：二次确认“丢弃未确认草案？不会删除已创建任务”；清除 App 内存 draft；关闭 panel；回 Chat；**无任何 server 写**。
- **关闭 panel 不取消**：draft 仍在 App 内存；Chat 摘要 card 显示“继续编辑草案”；重新打开 panel 恢复输入焦点/滚动位置（会话内）。
- **刷新/重载**：草案不持久化（不写 localStorage/sessionStorage，避免把聊天内容以任务草案名义持久化）；刷新后丢失，UI 在关闭/重载前显示“草案未确认”badge；无后台草稿。
- **切换工作区**：dirty draft 先确认丢弃；确认后清空；不从旧 workspace 带入。
- **恢复**：同一 App 会话内可恢复；不提供跨设备/跨窗口恢复（P1 可考虑 sessionStorage，但需单独评审隐私）。

---

## 7. 与现有 plan API 的复用（不是第二套）

### 7.1 服务端结构

```text
src/kernel/planDraft.ts (new, pure)
  ├─ buildPlanSourcePrompt(source)
  ├─ parsePlanDraft(text)             // 复用现 parsePlan 的 JSON 容错，但只产出 draft 形状
  ├─ validatePlanDraft(draft, ctx)    // client/server 共用
  └─ topologicalLayers(tasks)

src/kernel/service.ts (refactor)
  ├─ generatePlanDraft(source)        // LLM only; no store
  ├─ previewPlan(workspaceId, source) // generate + validate; no writes
  ├─ confirmPlan(request)             // validate + Store.createTaskGraph + event
  └─ plan(workspaceId, goal)          // legacy: preview + confirm with generated key, kept compatible
```

- **同一 planner prompt / parse**：`plan` 和 `previewPlan` 共用；不维护第二套 LLM 逻辑。
- **同一 `tasks` 表**：confirm 走 `Store.createTaskGraph`（新事务方法），底层仍是 `insertTaskProjection`/`updateTask`，不建新表、不复制任务。
- **同一 `router.plan` 事件**：复用现有事件 type；payload 增加 draft/source 字段；不新增事件表/事实源。
- **owner/priority/depends**：Task 表已有 `owner_id/depends_on/priority`，只需在 confirm/createTaskGraph 透传；不做 schema 迁移。
- **legacy `plan`**：保留 IPC/API 兼容（旧 Tasks/测试/外部调用）；内部可改用 preview+confirm 的生成/提交代码，但仍保持“调用即创建”的旧语义；**新 UI 不再调用它**。后续可标 deprecated。
- **旧 Tasks `RouterPlanModal`**：从 UI 移除/重定向；不删除旧 API 直到确认无调用。
- **不新增**：`PlanDraft` 表、`task_drafts`、`plan_draft` 本地持久化、第二套任务状态机、第二套 planner。

### 7.2 建议 IPC/文件面

```text
src/shared/types.ts          PlanSource/PlanDraft/PlanIssue/ConfirmPlanRequest/Result（DTO）
src/shared/ipc.ts            previewPlan / confirmPlan（保留 plan）
electron/main.ts             router:plan:preview / router:plan:confirm
electron/preload.ts          previewPlan / confirmPlan
src/kernel/planDraft.ts      prompt/parse/validate/topology 纯函数
src/kernel/service.ts        previewPlan/confirmPlan/legacy plan 复用
src/kernel/store.ts          createTaskGraph(transaction; owner/priority/depends; idempotent event)
src/App.tsx                  PlanSource capture; draft state; panel open; confirm/cancel
src/shell/ChatView/App      “从这段对话规划”入口 + 摘要 card（App 内 ChatView 子组件）
src/shell/PlanDraftPanel.tsx 草案编辑器/DAG/校验/CTA
src/shell/planDraftData.ts  reducer/selection/format 纯函数
src/shell/dock/panelRegistry.ts / DockShell.tsx  planDraft PanelKey/render
src/shell/WorkflowRail.tsx   计划 CTA → Chat 入口
src/styles.css               Plan Draft panel、卡片、DAG、960 布局
tests                        见 §9
```

**不写生产代码**是本设计任务的边界；上述只是实现落点。

---

## 8. 交互、无障碍、1440/960、深链

### 8.1 键盘/读屏

- Chat 入口是 `<button>`；有 `aria-label` 和“不会创建任务”说明；禁用时 `aria-describedby`。
- Plan Draft panel：
  - `<section aria-labelledby>`，标题聚焦（生成完成/打开面板）；
  - 任务卡用 `<fieldset><legend>`；每个输入有 label；
  - 依赖多选可用原生 `<select multiple>` 或 combobox + listbox；**键盘可增删**，不只拖拽；
  - 上移/下移是按钮，支持 Home/End? 至少 Up/Down 按钮；删除前确认；
  - error summary `role="alert"`，`aria-live=assertive`；warning `aria-live=polite`；
  - confirm CTA disabled 时有 `aria-describedby` 指向错误；confirming 时 `aria-busy=true`；
  - 关闭/取消有 `confirm`；确认后焦点到 Tasks 首任务或成功 toast；
  - 不设焦点陷阱（面板不是 Modal）；Tab 顺序覆盖所有字段/按钮；
  - 颜色不是唯一状态；错误有图标/文本；200% 不裁切（P1-4 统一字号，但本设计不能横向裁切）。
- **DAG**：提供等价文本列表（`d1 → d3`），键盘/读屏用户不必操作 SVG；图上的点击只是增强。
- **无鼠标**：添加/删除/排序/依赖/确认/取消全部键盘可达。

### 8.2 1440 / 960

| 宽度 | 布局 |
|---|---|
| 1440 | 主组 Plan Draft 面板；两栏（任务卡 2fr / DAG 1fr）；sticky footer；无横向滚动 |
| 1100 | 同上，右栏收窄；卡片字段换行 |
| 960 | single 主组；单列；`列表/依赖` segmented；每张任务卡全宽；sticky CTA；DAG 仅拓扑列表，不横向 |
| 760（P0-1 后续） | 单列；字段堆叠；最小按钮 36–40px；不依赖 hover |

### 8.3 深链/路由

- **不新增 `#/plan`**：Plan Draft 是工作区内的临时 UI，不是可分享事实；刷新/深链不恢复草案。
- Chat 仍 `#/chat`；Tasks 仍 `#/tasks`；确认后 `openPanel("tasks")` + 选中首任务（现有行为）。
- 在 Plan Draft 面板中点击 `#/chat`/`#/tasks` 深链：若 draft dirty，先 `confirm` 丢弃；不静默丢失。
- 确认后的任务可沿用现有 `#/tasks`（若现有 deeplink 支持选中 ID，则带选中；不支持则只打开 Tasks，不新增格式）。
- **浏览器后退**：草案不产生 hash 历史；取消回 Chat；不会出现“后退回到旧草案”的幻影。

---

## 9. 测试计划

### 9.1 纯函数（unit）

- `parsePlanDraft`：合法 JSON、围栏 JSON、坏 JSON、缺字段、dependsOn 索引越界 → `PLAN_UNPARSEABLE`/issue。
- `validatePlanDraft`：
  - 空 plan、>12、空 title、priority 越界；
  - missing/self/duplicate/cycle（含 2/3 节点环、最长环路径）；
  - isolated task warning；duplicate title warning；
  - owner null warning；owner 非 workspace error；Router warning；
  - acceptance 空 warning；高风险未 ack error。
- `topologicalLayers`：稳定顺序、root、断连组件。
- source digest 变化检测；source 超限。
- contract projection：owner 变化 → model/permission 变化；mixed；unavailable；不写回。

### 9.2 Store / service

- `previewPlan`：LLM 成功/失败；成功后 `tasks.length`/`events`/`router.plan` **完全不变**；不调用 `createTask`。
- `confirmPlan`：
  - 正常 N 任务 + owner/priority/depends 正确；root ready、依赖 blocked；
  - 事务中途失败 → 0 任务、0 `task.created`、0 `router.plan`；
  - 重复 `idempotencyKey` → same task IDs、`alreadyConfirmed`、无额外任务；
  - 并发两个 confirm（同一 key）→ 只有一组任务；
  - sourceDigest 不匹配、owner 删除、cycle、空 title → 无写；
  - 事件 payload task IDs 与任务一致。
- 旧 `plan` API 兼容：原 tests 仍通过；旧 plan 的 fallback 行为只保留在 legacy，不被新 UI 使用。

### 9.3 UI / integration

- Chat 入口：source 100%（composer 优先、最近 user message fallback）；空对话禁用；预览不建任务；不 toast“已规划”。
- Plan Draft：
  - 生成→编辑→新增/删除/排序/改依赖/owner/priority；
  - cycle/missing/owner/empty 错误阻断；
  - 高风险未 ack、source 更新、source 超限；
  - confirm 双击只发一次；网络超时重试同 key；成功导航 Tasks 首任务；
  - 取消/关闭 panel/恢复草案；workspace 切换丢弃确认；
  - contract chips 只读，链接正确；mixed owner 文案。
- 1440/960 截图 + 960 单列/DAG 切换；无横向裁切；键盘 Tab-only 完成“入口→编辑→确认/取消”；焦点/aria-live/错误摘要。
- 深链：`#/chat` 不恢复草案；`#/tasks` 正常；确认后的 hash/选中不破坏现有 deeplink 测试。
- WorkflowRail：计划 CTA 到 Chat 入口；Task 旧规划按钮重定向；PrimaryRail/Dock/⌘K/Alt 无回归。
- 回归：Tasks/Dock/Review/Merge/Permission/Approval/Workflow/NeedsMe；现有 `plan` API 测试。

### 9.4 手工/真机

- 1440/960：生成、编辑长描述、依赖多选、确认、失败、取消、重开 panel；无横向滚动。
- 真实 Electron + fixture workspace；真实 Chat 源；不 mock 掉 Dock/panel。
- 网络慢/LLM 失败/解析失败/DB 异常（可注入）各一次。
- 200% 作为 P1-4 的观测项；本设计至少 1440/960、Tab-only。

### 9.5 命令

```text
pnpm typecheck
pnpm build
pnpm test
```

实现阶段必须三命令全绿；测试计划中的 failed case 需有 fault injection，不允许仅靠手工声称。

---

## 10. 验收标准（AC）

| ID | 验收 | 证据 |
|---|---|---|
| AC-01 | Chat 能从当前对话生成草案，goal 来自 composer/最近 user message，消息/摘要/overview 100% 带入；无需重输 | source 元数据/单测/截图 |
| AC-02 | Preview 前后 `tasks`、`router.plan`、`task.created` 数量不变；不 refresh 任务、不自动选任务/开 Tasks、不 toast 已规划 | service/integration 断言、网络/IPC spy |
| AC-03 | Draft 可编辑 title/description/acceptance/dependsOn/owner/priority；增删/排序/取消；所有字段有来源/校验 | UI tests + 截图 |
| AC-04 | 空 title/空 plan/自依赖/环/重复/丢失依赖/非法 owner/priority 越界阻断；owner null、空验收、孤立、重复标题为 warning 且可见 | pure validator + UI |
| AC-05 | Confirm 一次创建整张 DAG（owner/priority/depends 正确）；任何中途失败 0 任务、0 事件；无部分失败 | store/service tests |
| AC-06 | 双击/重复 confirm/超时重试同 key 只创建一组任务；返回 `alreadyConfirmed` | concurrency/idempotency tests |
| AC-07 | 取消/关闭 panel/workspace 切换不建任务；会话内可恢复草案；刷新丢失且无 server 草稿 | UI/integration |
| AC-08 | 执行契约 model/permission/FT/context/budget 显示真实 owner/workspace 来源；不出现可编辑假控件；owner 改变即重算；P1-5 范围写明 | UI screenshot + contract tests |
| AC-09 | 与现有 `plan` API 共用 planner/parse/tasks/event；无 PlanDraft 表/第二任务源；旧 plan 兼容 | code review/schema check/tests |
| AC-10 | WorkflowRail 计划 CTA、Tasks 旧规划按钮、PrimaryRail、Dock、⌘K、Alt、深链无回归；960 single 没有横向裁切 | integration + 1440/960 screenshots |
| AC-11 | 纯键盘完成“Chat 入口→编辑→校验→确认/取消”；错误/警告可读；无焦点陷阱/鼠标专属依赖 | a11y/keyboard test |
| AC-12 | 三命令全绿；无数据层/权限/gate 改动；无越界 | CI/PR diff |

---

## 11. 风险与回滚

| 风险 | 影响 | 缓解/回滚 |
|---|---|---|
| Plan source 包含长 Chat/敏感内容 | LLM 调用成本/隐私 | 只在用户点击时捕获；不持久化；不写日志；超限阻断；沿用 Chat 既有 provider 边界 |
| Planner 输出质量/坏 JSON | 无法生成 | 不 fallback 建任务；inline error + retry；用户可手改 |
| 事务改动影响任务创建 | 回归 | 新增 `createTaskGraph`，旧 `createTask` 不动；事务测试；失败回滚 |
| owner/priority 透传引入 API 变更 | 旧调用方兼容 | 新 confirm 专用 DTO；旧 `createTask`/`plan` 不改签名；无 schema 迁移 |
| 契约只读不满足“可编辑契约” | 产品预期落差 | 明确 owner 是唯一真实杠杆；P1-5 做任务级契约（需要列/迁移）；不在 P0-4 造假 |
| 草案丢失/刷新 | 用户输入丢失 | 会话内恢复；关闭/重载提示；不写本地持久化；P1 再评审 session 恢复 |
| 双击/并发重复建图 | 重复任务 | UI single-flight + 服务端 idempotency event + 事务 |
| Plan Draft 面板挤压 Dock | 960 回归 | 主组 tab 不新增宽度列；960 单列；截图/键盘测试 |
| 旧 Tasks Modal 移除 | 旧路径用户 | 先重定向到 Chat 入口；保留 legacy API；发布说明；可回滚 |
| LLM 窗口/超时 | 长对话 | 显式 source limit；压缩；错误重试；不静默截断 |

**回滚**：

- UI 开关：隐藏 Chat 规划入口、WorkflowRail 计划 CTA 回 Tasks；旧 RouterPlanModal 仍可恢复；不迁移数据。
- API：保留旧 `plan`；新 preview/confirm 停用不影响任务表。
- 无 schema/迁移，回滚不涉及数据修复；已确认任务保留是正常结果，不删除。

---

## 12. 需要 Captain/产品确认的开放项

1. **逐任务执行契约是否必须**：本设计 P0-4 只读（owner 选择为杠杆）；若必须逐任务改 model/permission/FT/budget，需 P1-5 新列/迁移，超出“UI 草案/不新数据源”。
2. **owner 未分配是否允许 confirm**：默认允许 + warning；若要求“全部 owner 必填”，改为 error。
3. **空验收是否允许 confirm**：默认 warning；若要求质量门禁，改为 error。
4. **source 的边界**：默认“当前 Chat 上下文 + 压缩摘要 + composer”；是否要求包含所有分页历史（会增大成本/上下文）。
5. **草案是否跨刷新恢复**：默认不持久化（隐私/无第二源）；如需，另评 sessionStorage 方案。
6. **任务数上限**：默认 12；现有 planner prompt 仍建议 2–4。
7. **旧 Tasks 规划 Modal**：默认从 UI 移除，仅保留 legacy API；是否需要过渡入口。
8. **Plan Draft 是否进入 WorkflowRail 阶段数据**：默认不进入（草案不是任务），只在 Chat/panel 表示“未确认”。

---

## 13. 实现切片建议（不写代码，供后续排期）

1. **P0-4a（纯契约）**：`PlanSource/PlanDraft/PlanIssue` 类型 + `parsePlanDraft`/`validatePlanDraft`/`topologicalLayers` + 单测；无 UI/无 store。
2. **P0-4b（只读 preview）**：service `previewPlan` + IPC/preload/main + fake LLM；断言 0 任务/0 事件；Chat 入口 capture source。
3. **P0-4c（草稿面板）**：PlanDraftPanel + Chat 摘要 + Dock `planDraft`；编辑/校验/取消/恢复；1440/960。
4. **P0-4d（原子确认）**：`Store.createTaskGraph` + `confirmPlan` + idempotency + 失败/重复测试 + Tasks 导航。
5. **P0-4e（旧路径收口）**：Tasks Plan 按钮重定向、旧 Modal UI 移除、WorkflowRail 计划 CTA、回归/截图/文档。

每片独立 review/verify；不得把 P0-4a–e 塞进一个大 PR。

---

## 14. 一句话

**Plan Draft 是 Chat 到 Tasks 之间的唯一缓冲层：它保存完整对话来源和可编辑 DAG，但只有用户按下「确认创建」并在一个事务内成功后才产生任务；在此之前，任务表、事件、owner、预算、权限都不动。**
