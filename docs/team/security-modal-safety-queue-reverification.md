# t203 复验：MergeQueueLayer 测试补强

- **任务**：t203 [verification] 独立复验 t202（仅测试补强）
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #32 `feature/t190-security-modal-safety`，HEAD `d479c4b`（OPEN/MERGEABLE；worktree `branches/t190-security-modal-safety`，clean）；未合并，未修改生产代码。
- **方法**：worktree 独立复跑三命令 + 读 MergeQueueLayer.test（两条用例）/CommandPalette.test + 与 App/Modal 生产路径对照。

---

## 1. 结论：**PASS（通过，无 blocker）**

t202 已将 MergeQueueLayer 的测试从单条 Esc/栈扩展为两条真实状态测试：

- 队列+设置双 Modal 打开时 `#root.inert===true`；Alt+1/Ctrl+K/Meta+K 经 `hasOpenModal()` 门控不触发；Esc 只关队列；卸载后 root.inert=false、trigger.focus 1 次。
- stateful QueueHarness：Esc 真正 `setOpen(false)` 卸载队列；root.inert=false、hasOpenModal=false、trigger.focus 1 次。
- FakeElement 的 `toggleAttribute`/`setAttribute`/`removeAttribute` 已真实维护 inert/aria-hidden，不再是空实现。
- CommandPalette 的真实 root+body test 无回退；三命令 0/0/0（58/595）。

发现 3 项低优先（见 §4），无阻塞。

---

## 2. 命令（worktree HEAD `d479c4b`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 408 modules；js 1,228.44 kB (gzip 337.43)；css 245.43 kB (gzip 29.56)；electron main 1.5mb/preload 11.7kb |
| `pnpm test` | **0** | **58 文件 / 595 用例**全部通过；MergeQueueLayer 2、CommandPalette 1、modalStack 3、modalLayering 2、redaction 7 |

---

## 3. 逐项验证

### 3.1 root inert 打开/释放（PASS）

`MergeQueueLayer.test.tsx` 第一条：

```ts
expect(hasOpenModal()).toBe(true);
expect(root.inert).toBe(true);   // FakeElement.toggleAttribute 写真实 inert
...
await act(async () => renderer?.unmount());
expect(root.inert).toBe(false);
```

第二条 stateful `QueueHarness`：

```ts
expect(root.inert).toBe(true);
expect(hasOpenModal()).toBe(true);
// Esc -> onClose -> setOpen(false) -> 队列卸载
expect(root.inert).toBe(false);
expect(hasOpenModal()).toBe(false);
```

`FakeElement.toggleAttribute(name, force)` 写入 `this.inert`；`setAttribute/removeAttribute` 写入 `aria-hidden`。不是空实现。

### 3.2 Alt+1..6 / Ctrl+K 不穿透（PASS，低优先说明）

测试内 `guardedShortcut` 镜像 App 的守卫：

```ts
if (hasOpenModal()) return;
if (altKey && /^[1-6]$/) onNavigate();
if ((ctrlKey || metaKey) && key === "k") onPalette();
```

队列打开时 `hasOpenModal()===true`，Alt+1/Ctrl+K/Meta+K 均未调用 `navigate`/`palette`；App 生产 handler 同样在首行 `if (hasOpenModal()) return`（`App.tsx:628`）。**断言通过**。
说明：这是**合同探针**而非 App 组件的真实 keydown 集成测试，见 §4 N1。

### 3.3 关闭回焦（PASS）

- 第一条：Modal 卸载后 `trigger.focus` 调用 1 次。
- 第二条：QueueHarness 通过 Esc 真正卸载，`trigger.focus` 调用 1 次。
- 公共 Modal 的 restoreFocus 语义（`Modal.tsx`）成立。

### 3.4 FakeElement inert/toggleAttribute（PASS）

- `toggleAttribute("inert", force)`：`this.inert=Boolean(force)`；`setAttribute/removeAttribute` 维护 `aria-hidden`。
- 测试对 root.inert 有 true/false 双断言；不再是 t201 指出的空实现。

### 3.5 CommandPalette 真实结构无回退（PASS）

- `CommandPalette.test.tsx` 仍用实际 `getElementById` root + body、`portalTargets[0]===body`、root.inert=true、input focus、Esc、Tab、关闭回焦、卸载后 root.inert=false；本次仅测试补强未动 CommandPalette 实现，58/595 通过。

### 3.6 PR/范围（PASS）

- PR #32 HEAD `d479c4b`；worktree clean；t202 commit `4c1bb62`/`d479c4b` 仅改 `src/git/ui/MergeQueueLayer.test.tsx`（203 additions），未改 src/CommandPalette/Modal/App/shared/kernel/docs。
- PR OPEN/MERGEABLE；未改权限/审批/内核调度语义。

---

## 4. 发现（低优先，不阻塞）

| ID | 级别 | 发现 | 建议 |
|----|------|------|------|
| N1 | low | `guardedShortcut` 是复制 App 守卫逻辑的合同探针，不是 App 真实 keydown 集成测试；若 App 以后漏写 `hasOpenModal`，本测试仍会通过（App 当前有该门禁，代码核对通过） | 后续抽 `isGlobalShortcutBlocked()` 纯函数或挂 App 测试，避免双实现 |
| N2 | low | FakeElement 非真实 DOM；root inert/aria 语义由 fake 属性验证，真实 Chromium inert 行为仍需 Playwright/Electron 冒烟 | 发布前补一次真实窗口冒烟 |
| N3 | low | t198/t200/t202 修复仍未更新 docs（security-modal-safety.md 仍是 t190 口径） | 合并前补 docs 记录/计数 |

N2/N3 与 t199 F3/F5 同源，不阻塞本轮；N1 为测试架构债。

---

## 5. 结论

**PASS**：MergeQueueLayer 的 root inert 打开/释放、Alt/Ctrl+K 门控、关闭回焦、FakeElement inert 真实表示均有断言；CommandPalette 真实结构测试无回退；三命令 0/0/0，58/595。PR #32 可进入后续评审/合并流程；N1–N3 为低优先改进。

*本次验证仅新增本报告，未修改生产代码。*
