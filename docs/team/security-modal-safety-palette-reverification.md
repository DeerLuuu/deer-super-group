# t201 复验：CommandPalette inert 修复与 MergeQueueLayer 断言

- **任务**：t201 [verification] 独立复验 t200
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #32 `feature/t190-security-modal-safety`，HEAD `1c12303`（OPEN/MERGEABLE；worktree `branches/t190-security-modal-safety`，clean）；未合并，未修改生产代码。
- **方法**：worktree 独立复跑三命令 + 读 CommandPalette/portal/test + MergeQueueLayer test + PR 范围。

---

## 1. 结论：**BLOCKED（验收 3 未满足，needs revision）**

- **CommandPalette inert 修复 PASS**：已 `createPortal` 到 `document.body`；真实 `#root` 存在且栈打开时 `root.inert=true`；测试断言 portal target=body、input focus、Esc、Tab 首尾环形、关闭回焦、卸载后 root.inert=false/栈释放。
- **MergeQueueLayer/快捷键/回焦断言 FAIL**：t200 只改了 `CommandPalette.tsx` + test；`MergeQueueLayer.test.tsx` 仍是 t198 的单条 Esc/栈测试，未补 `#root` inert、Alt+1..6/Ctrl+K 不穿透、关闭回焦断言。t201 明确要求这三项补强，故验收 3 不成立。
- 其余命令/脱敏/Modal 功能无回归；命令全绿（58/594）。

这是**测试证据缺口**，不是 CommandPalette 功能 blocker；但按 t201 acceptance 不能 PASS。

---

## 2. 命令（worktree HEAD `1c12303`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 408 modules；js 1,228.44 kB (gzip 337.43)；css 245.43 kB (gzip 29.56)；electron main 1.5mb/preload 11.7kb |
| `pnpm test` | **0** | **58 文件 / 594 用例**全部通过；CommandPalette 1、MergeQueueLayer 1、modalStack 3、modalLayering 2、redaction 7 |

---

## 3. 逐项

### 3.1 CommandPalette 移出 inert 根（PASS）

- `src/CommandPalette.tsx:2` import `createPortal`；`:358` `createPortal(content, document.body)`；不再位于 `#root/.app`。
- `useEffect`：`pushModal` → `registerModalElement` → 保存触发焦点 → `input.focus()` → body overflow lock；cleanup：`isTopModal` → `popModal` → 恢复 overflow → 回焦触发控件（`:90-106`）。
- `onKeyDown`/`onDialogKeyDown` 首行 `isTopModal`；Tab 用 `button/input/[tabindex]` + `offsetParent` 过滤 + 首尾环形（`:248-292`）；Esc/Tab 仅顶层。
- `CommandPalette.test.tsx`：
  - `getElementById("root")` 返回**实际 root**（非 null），断言 `root.inert===true`；
  - `createPortal` mock 记录 target，断言 `portalTargets[0]===body`；
  - input focus 1 次；Esc 关闭；last→first Tab wrap；卸载后 `trigger.focus`、`hasOpenModal()===false`、`root.inert===false`。
- **PASS**：真实结构（root + body）覆盖，不再用 `getElementById:()=>null`。

### 3.2 CommandPalette 与 Modal trap 收敛（部分）

- 已共用 `modalStack` token/`isTopModal`/root inert/body lock/回焦语义；Tab 可聚焦选择器与公共 Modal 基本一致。
- 但 CommandPalette 仍保留自建 `onDialogKeyDown`/backdrop 逻辑（`CommandPalette.tsx:269-292`），未复用 `Modal` 组件；t200 自述“最小收敛”，属低优先架构债，不影响本轮验收。

### 3.3 MergeQueueLayer/快捷键/回焦（FAIL）

- `src/git/ui/MergeQueueLayer.test.tsx` 仍只有：
  - `it("registers in the common stack and Esc only closes the queue on top")`
  - 断言 `hasOpenModal()===true`、Esc 后 `closeSettings` 未调用、`closeQueue` 1 次。
- **缺失**：
  1. `#root.inert===true`（FakeElement.toggleAttribute 目前是空实现，无法证明）；
  2. Alt+1..6/Ctrl+K 不穿透（至少断言 `hasOpenModal()` 门禁或 App handler 早退）；
  3. 关闭队列后 focus 回到触发按钮（公共 Modal 的 restoreFocus）。
- t200 的文件范围只含 `CommandPalette.tsx` + test；MergeQueueLayer test 未改，t201 acceptance 明确要求“补强”，故 **FAIL**。
- 实现层面 MergeQueue 已用公共 Modal，功能继承；**required fix 仅为测试补强**（三条断言 + FakeElement.toggleAttribute 实现）。

### 3.4 范围/HEAD（PASS）

- PR #32 HEAD `1c12303`；worktree clean；t200 commit `1c12303` 只含 CommandPalette.tsx/test（相对 t198 HEAD）。
- PR OPEN/MERGEABLE；未改权限/审批/内核调度；t190/t198 的脱敏/Settings/Git/internal URL 保留。

---

## 4. 发现

| ID | 级别 | 发现 | Required fix |
|----|------|------|--------------|
| F1 | **high（验收失败）** | MergeQueueLayer.test 仍只测 Esc/栈；未补 `#root.inert`、快捷键穿透、关闭回焦；t201 acceptance 3 未满足 | 补三条断言 + FakeElement.toggleAttribute 实现；可直接复用公共 Modal 语义，无需改生产代码 |
| F2 | low | CommandPalette 仍自建 trap/backdrop，与公共 Modal 两套逻辑；t200 仅“最小收敛” | 后续抽取 overlay primitive；本轮不阻塞 |
| F3 | low | t198/t200 修复未更新 docs（security-modal-safety.md 仍是 t190 口径） | 合并前补 docs 记录/计数 |

---

## 5. 结论

- CommandPalette 已真正移出 inert root，真实结构测试通过；这是 t200 的核心修复，**功能 PASS**。
- MergeQueueLayer 的 root inert/快捷键/回焦断言未补，**t201 验收 3 FAIL**；PR #32 需补测试（无需改实现）后复验。
- 本次未修改生产代码；报告为准。

*复核命令：`pnpm typecheck` / `pnpm build` / `pnpm test`，worktree `1c12303`，58/594 全绿。*
