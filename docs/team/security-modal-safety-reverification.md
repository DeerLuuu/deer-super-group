# P0-6 repair 复验：Modal 栈与 Authorization 脱敏（t199）

- **任务**：t199 [verification] 独立复验 t198（P0-6 repair）
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #32 `feature/t190-security-modal-safety`，HEAD `6f29995`（OPEN/MERGEABLE；worktree `branches/t190-security-modal-safety`，clean）；未合并，未修改生产代码。
- **方法**：worktree 独立复跑三命令 + 直接调用 `sanitizeErrorText` 复验 Basic/Token/Digest/私网 + 逐项读 MergeQueue/CommandPalette/Settings/Git/service 代码与测试。

---

## 1. 结论：**BLOCKED（不通过，needs revision）**

t198 已关闭 t191 的 **F1（MergeQueue）** 与 **F2（Authorization）**，F3/F5/F6 也基本落实；但 F4 的 CommandPalette 接入引入了新的 **blocker**：

**CommandPalette 仍在 `#root` 内，而 modalStack 在任一 Modal 打开时把 `#root` 设为 inert。** 结果：Ctrl/⌘+K 打开命令面板后，`#root`（含 `.palette`）整体 inert，输入框无法聚焦/输入，Esc/Tab 失效——命令面板在真实 DOM 中不可用。t198 的 CommandPalette 测试把 `getElementById` 固定返回 null，因此没有暴露该问题。

F1/F2 已通过；由于 F4 的回归，验收 6 项中 **1 项失败（Modal/CommandPalette 叠层）**，其余通过。命令全绿（58 files/594）。

---

## 2. 命令结果（worktree HEAD `6f29995`）

| 命令 | 退出码 | 关键结果 |
|------|--------|----------|
| `pnpm typecheck` | **0** | `tsc --noEmit` 无错误 |
| `pnpm build` | **0** | 408 modules；js 1,228.34 kB (gzip 337.39)；css 245.43 kB (gzip 29.56)；electron main 1.5mb、preload 11.7kb；>500kB 既有警告 |
| `pnpm test` | **0** | **58 文件 / 594 用例**全部通过；redaction 7、MergeQueueLayer 1、CommandPalette 1、Settings 3、GitPanels 4、modalStack 3、modalLayering 2 |

---

## 3. 复验结果

### 3.1 F1 MergeQueueModal（PASS）

- `src/git/ui/GitPanels.tsx:2` 已 import 公共 `Modal`；`MergeQueueModal` 返回 `<Modal title="合并队列" onClose={onClose}>`（`:152-198`），不再自建 document keydown/overlay/`role=dialog`。
- 公共 `Modal` 提供：`pushModal/registerModalElement`、`#root` inert、非 top inert/aria-hidden、Esc/Tab/backdrop top-only、关闭回焦（`Modal.tsx`）。
- `MergeQueueLayer.test.tsx` 通过：Settings + MergeQueue 双栈，Esc 只关队列，底层 Settings 不被关。
- **低优先测试缺口**：该测试只断言 Esc/栈；未显式断言 `#root.inert`、Alt+1..6/Ctrl+K 不穿透、关闭后 focus 回触发按钮（代码由公共 Modal 继承，风险低）。建议补一条真实 root 的断言。

### 3.2 F2 Authorization（PASS）

`src/shared/errorRedaction.ts:24` 改为 `Authorization|x-api-key|api-key` 整段值到行尾/分号；`:52-56` 保留 header 名 + `[REDACTED]`。实际调用：

```text
"Authorization: Basic dXNlcjpwYXNz" -> "Authorization: [REDACTED]"
"Authorization: Token abc.def"      -> "Authorization: [REDACTED]"
"Authorization: Digest username=u response=deadbeef" -> "Authorization: [REDACTED]"
"Authorization: Bearer abc.def"     -> "Authorization: [REDACTED]"
```

- `errorRedaction.test.ts` 7 项：Basic/Token/Digest/Bearer/大小写；sk/Bearer/URL/stack/provider body/remote prefix；私网/内网 host；空文本。
- 服务端 `terminalText` 同步为 `[^\r\n;]+` 整段（`service.ts:201-204`），t175 terminal 无回退。
- **PASS**；另 `PRIVATE_IP`/`PRIVATE_IPV6`/`INTERNAL_HOST`/`INTERNAL_URL` 覆盖 10/172/192/169.254、fe80/fc/fd、`.local/.corp/.internal/.lan/.intranet/.home/.svc` 等；测试通过。

### 3.3 F3 服务端摘要（PASS）

- `src/kernel/service.ts` 已 import `safeErrorSummary`；chat error 使用 `safeErrorSummary(error)`（`:1243`），interactive ingest 使用 120 字符摘要（`:1211`），并保留 code/首行摘要；无 provider body 日志。
- `electron/main.ts` 仍只有 envFile `console.warn`（非 provider body）；未发现新增原文日志。
- **PASS**；四端点（banner/toast/chat/log）中 banner/toast/chat 走 renderer `formatError`，log 无 provider 原文。

### 3.4 F4 CommandPalette（**FAIL，blocker**）

- `CommandPalette` 的确 push/register、body lock、focus restore（`CommandPalette.tsx:89-103`），并自己处理 Esc/Tab；这部分逻辑正确。
- **但**：`CommandPalette` 仍是普通 JSX，返回 `<div className="palette-backdrop">`（`:299+`），由 `App` 渲染在 `<div className="app">`（`App.tsx:2348`）内部；`main.tsx:6` 把 App 挂到 `#root`。
- `modalStack.syncDocument` 在栈非空时执行 `document.getElementById("root").toggleAttribute("inert", true)`（`modalStack.ts:23-24`）；`#root` 的 inert 会让其后代（含 `.palette` 输入框）全部不可聚焦/不可输入。`registerModalElement` 只对 `.palette` 自身 `inert=false`，**不能覆盖祖先 `#root` 的 inert**。
- 因此真实场景：Ctrl/⌘+K 打开命令面板 → 输入框无法聚焦、Esc/Tab 无法作用；命令面板被冻结。
- t198 测试 `CommandPalette.test.tsx:51` 使用 `getElementById: () => null`，所以 `#root` 不被设置 inert；测试通过但未覆盖真实结构。
- **Required fix**：像 `Modal` 一样把 CommandPalette `createPortal(…, document.body)`，或不要把 `#root` inert 用于“挂在 root 内的顶层 overlay”；用真实 `#root` 测试 `inert` + 输入聚焦 + Esc/Tab。

### 3.5 F5 Settings/Git dirty（PASS）

- `SettingsView` 的 `dirty` 已合并 `gitDirty`（`SettingsView.tsx:99-108`）；`GitSettingsPanel` baseline + `onDirtyChange`（`GitPanels.tsx:229-232`）。
- `beforeunload` guard（`SettingsView.tsx:110-119`）；Git 分区离开确认（`:127-131`）。
- `SettingsView.test` 3 项（含 beforeunload）、`GitPanels.test` 4 项（Git dirty 清空）通过。
- **PASS**。

### 3.6 F6 internal URL（PASS）

`errorRedaction.ts:11-18` 扩展 RFC1918/169.254/IPv6 ULA/链路本地、`.internal/.local/.lan/.intranet/.corp/.home/.localdomain/.svc`；测试 7 条私网/内网 URL 通过。**PASS**。

---

## 4. 发现

| ID | 级别 | 发现 | Required fix |
|----|------|------|--------------|
| F1 | **blocker** | CommandPalette 在 `#root` 内，modalStack 打开时 `#root` inert 导致整个命令面板不可聚焦/不可输入；CommandPalette 测试 `getElementById:()=>null` 未覆盖 | portal 到 body，或把 root inert 限定为不影响的 overlay；补真实 root + 输入聚焦/Esc/Tab 测试 |
| F2 | low | MergeQueueLayer 测试只断言 Esc/栈，未断言 `#root` inert、快捷键不穿透、回焦 | 补公共 Modal 继承的 3 条断言（无需改实现） |
| F3 | low | t198 文档未更新（仍为 t190 口径；t198 自述“未更新 docs”） | 合并前补 docs 的 t198 修复记录/验收，避免交付文档落后 |
| F4 | low | `CommandPalette` 自建 trap 与公共 Modal 两套焦点逻辑；即使 portal 后也建议复用公共 Modal/统一栈语义 | 后续收敛（本轮只需 portal + 测试） |

F1 是唯一 blocker；其余为低优先。

---

## 5. 结论

- **t191 F1/F2 已关闭**：MergeQueue 已是公共 Modal；Authorization Basic/Token/Digest 整段脱敏；F3/F5/F6 通过。
- **F4 引入回归**：CommandPalette 在真实 `#root` inert 下不可用；t198 的测试用 null root 掩盖了它。
- PR #32 需再做一次 repair（CommandPalette portal + 真实 root 测试），然后重跑本文 §2 与键盘/焦点检查；本次未修改生产代码。

*本次验证仅新增本报告。*
