# WorkflowRail + NeedsMe · 独立验证报告（t223）

- **任务**：t223 [verification] 独立验证 t222 P0-3 WorkflowRail/NeedsMe
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #36 `feature/t222-workflow-rail-needsme`，HEAD `4f5ec25`（OPEN/MERGEABLE；worktree `branches/t222-workflow-rail-needsme`，clean）；未合并，未修改生产代码。
- **方法**：worktree 复跑三命令 + 读 workflowData/WorkflowRail/App/CSS/tests + 看 1440/960 截图；重点核对 MergeQueue 加载/刷新与 no-fake 边界。

---

## 1. 结论：**BLOCKED（不通过，needs revision）**

WorkflowRail 六阶段/CTA/unknown 与 NeedsMe 纯投影大部分成立；但发现 **MergeQueue 状态未区分“未加载/失败”与“已知为空”**，导致：

1. **初始/加载失败时伪造“无待合并”**：`App` 用 `useState<MergeQueueItem[]>([])`，catch 也 `setMergeQueueItems([])`；`deriveWorkflow`/`deriveNeedsMe` 收到 `[]` 会当作“已知无待合并”，于是 `done` 任务显示「记忆」而不是「交付」，NeedsMe 不显示待合并——与文档「MergeQueue 未加载不推断」相反。
2. **MergeQueue 状态不会刷新**：`mergeQueueItems` 只在 `[snapshot?.workspace.id]` effect 加载一次；打开 MergeQueue/批准/合并/任务刷新均不会重新读取，Rail/NeedsMe 会长期停留在旧阶段/旧计数。

这是“无第二事实源/不伪造状态”的实质违约，**FAIL**。此外默认 `pnpm test` 在负载下出现 3 个既有 5s timeout；`--testTimeout=10000` 656/656 通过（见 §5 N1）。

---

## 2. 命令（worktree HEAD `4f5ec25`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 415 modules；js 1,242.92 kB (gzip 341.84)；css 250.61 kB (gzip 30.48)；electron main 1.5MB/preload 11.7kB |
| `pnpm test`（默认） | **1** | 3 个既有 5s timeout：`openai.test`、`watchdog`（pauses）、`git.test`（symlink/junction） |
| `pnpm exec vitest run --testTimeout=10000` | **0** | **66 文件 / 656 用例**全绿；WorkflowRail 2、workflowData 4 |

---

## 3. 逐项验证

### 3.1 六阶段/当前阶段/唯一 CTA/unknown（PASS，有边界）

`workflowData.ts`：

- `WORKFLOW_STAGES` 六项：discuss/plan/run/review/deliver/remember；
- `deriveWorkflow` 优先级 run>review>deliver>plan>remember>discuss>unknown；`unknown` 返回 `cta:null`；
- 测试：空 tasks→discuss；ready→plan；queued/failed→run；review→review；done+merge ready→deliver；done→remember；cancelled→unknown 无 CTA；`mergeQueue:null` 不推 deliver。
- `WorkflowRail` 当前阶段 `aria-current="step"`；只有当前 stage 显示 CTA 文案；其他 stage 显示 hint；unknown 显示「阶段未知」且无 CTA（`WorkflowRail.test` 2 项）。
- `handleWorkflowStage`：discuss→chat、plan/run→tasks（focus task）、review→ReviewSection focus、deliver→MergeQueue、remember→board；复用现有入口。
- 边界：**failed/blocked 任务被归为 run**，CTA「查看运行」；NeedsMe 另列失败/阻塞。不是伪造，但 CTA 对失败任务偏“查看”而非“重试/处理”，见 N4。

### 3.2 NeedsMe 聚合/去重/空态/定位（PASS，纯函数层）

- `deriveNeedsMe` 聚合 failed/blocked/review task、active MergeQueue、open watchdog alert、hard budget；
- 去重 `task:<kind>:<id>` / `merge:<id>` / `alert:<id>` / `budget:workspace`；重复 failed/alert 测试只 1 条；merged 队列项排除；
- budget：`workspaceDay.ratio>=1` 且无 open budget alert 才加一条，避免与 budget alert 重复；
- 空输入 `[]` 不渲染 NeedsMe；`WorkflowRail` 仅 `needs.length>0` 渲染 badge；
- 点击：failed/blocked→任务页；review→ReviewSection；merge→MergeQueue；alert/budget→watchdog；`WorkflowRail.test` 覆盖。
- **缺口不在此纯函数**：App 传入的 `mergeQueueItems` 初始/失败值见 §3.3。

### 3.3 MergeQueue 加载/刷新（FAIL，blocker）

`App.tsx:400`：

```ts
const [mergeQueueItems, setMergeQueueItems] = useState<MergeQueueItem[]>([]);
```

`App.tsx:981-998`：

```ts
if (!workspaceId || typeof window.deer.mergeQueue !== "function") {
  setMergeQueueItems([]); return;
}
window.deer.mergeQueue(workspaceId)
  .then((queue) => setMergeQueueItems(queue.items))
  .catch(() => setMergeQueueItems([]));
```

- **初始 `[]`**：首屏异步未返回前，`deriveWorkflow` 看到 `mergeQueue=[]`，若存在 done 任务会显示「记忆」而不是「交付」；NeedsMe 无 merge 项。
- **失败 `[]`**：API 失败被当作“已知无待合并”，永久显示错误阶段/漏项，直接违反 t222 文档「MergeQueue 未加载（undefined）时不推断」和「失败/未加载不伪造」。
- **无刷新**：`useEffect` 依赖仅 `[snapshot?.workspace.id]`；`handleOpenMergeQueue`、merge 模态内的 approve/start/waive、任务 refresh 均未重新调用 `mergeQueue` 或更新 `mergeQueueItems`。打开队列/合并后 Rail 阶段和 NeedsMe 计数保持旧值。
- 截图/文档只展示单次初始加载后的状态，未覆盖加载失败/合并后刷新；`workflowData.test` 只测纯函数，不测 App 加载状态。

**Required fix（blocker）**：把状态改为 `MergeQueueItem[] | null`（初始 null、catch null），把 null 传给 derive（不推断）；提供 `loadMergeQueue` 并在打开 MergeQueue、merge 操作成功、workspace refresh 时刷新；补 App/integration 测试：首屏 pending、API reject、队列从空→ready、merge 后计数/阶段变化。

### 3.4 既有 rail/Dock/⌘K/Alt/深链/960（PASS）

- WorkflowRail 在 `<main>` 顶部，不替代 PrimaryRail/Dock/Settings；未注册全局快捷键，不拦 Esc/Tab/⌘K；NeedsMe popover Esc/外部 pointerdown 关闭。
- CSS `@media 1100/720`：阶段 hint 收起/当前 hint 显示；960 截图阶段条仍在顶部，PrimaryRail 折叠、Dock 单栏正常。
- 未改 deeplink/DockShell/权限/审批/任务状态机；review/merge gate 文件未改；66/656 全绿（extended timeout）。
- **未新增第二套任务/事件事实源**；`mergeQueueItems` 只是 API 副本，但上面的 stale/null 问题成立。

### 3.5 范围（PASS）

- 9 文件：App.tsx、WorkflowRail.tsx、workflowData.ts、两个 test、styles.css、docs、2 截图；未改 kernel/git/memory/review/watchdog/electron。
- PR #36 OPEN/MERGEABLE/CLEAN；worktree clean。

---

## 4. 发现

| ID | 级别 | 发现 | Required fix |
|----|------|------|--------------|
| F1 | **blocker** | MergeQueue 初始/失败都存 `[]`，derive 当作“已知无待合并”，Rail 可把 done 任务显示为记忆、NeedsMe 漏 merge；与“未加载不推断/不伪造”冲突 | 用 `null` 表示未加载/失败；derive 不推断；补 reject/首屏测试 |
| F2 | **high** | `mergeQueueItems` 只在 workspace effect 加载一次；打开 MergeQueue、approve/start/waive、refresh 后不更新 | 抽出 `loadMergeQueue` 并在这些动作后刷新；补 App 集成测试 |
| F3 | medium | 默认 `pnpm test` 在负载下 3 个既有 5s timeout（openai/watchdog/git symlink）；`--testTimeout=10000` 656/656；非本功能 | 单独放宽脆弱测试 timeout/串行；CI 记录 flake |
| F4 | medium | failed/blocked task 被归 run，CTA「查看运行」；错误恢复下一步不够明确 | 失败/阻塞优先 NeedsMe；CTA 文案可改「处理失败/阻塞」或跳任务动作 |
| F5 | low | NeedsMe listbox 仅按钮 Tab，无 Arrow/aria-controls；popover 无焦点首项策略 | 补键盘导航/焦点管理 |
| F6 | low | `mergeQueue` 空数组/未加载语义只靠注释，类型未区分 | 使用 `null`/显式 loading 状态（与 F1 同批） |

---

## 5. 结论

- 纯函数投影、六阶段、NeedsMe 去重/空态、CTA/unknown、960/1440 布局均成立。
- **MergeQueue 加载/刷新语义是 blocker**：首屏/失败伪造“无待合并”，且合并操作后不刷新；Rail/NeedsMe 会长期错误。
- 默认 `pnpm test` 有既有 5s flake，但 extended timeout 656/656；不作为功能 blocker，仍需 CI 处理。
- PR #36 需 repair F1/F2（建议 F4/F5 同批）后重验；本次未修改生产代码。

*本次验证仅新增本报告。*
