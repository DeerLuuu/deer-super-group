# 错误脱敏与 Modal/设置草稿安全 · 独立验证报告（t191）

- **任务**：t191 [verification] 独立验证 t190 的 P0-6：secret sanitize、Modal 栈、Settings dirty/save
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #32 `feature/t190-security-modal-safety`，HEAD `6499e40`（OPEN/MERGEABLE；worktree `branches/t190-security-modal-safety`，clean）；未合并，未修改生产代码。
- **方法**：t190 worktree 独立复跑三命令 + 读实现/测试 + 直接调用 `sanitizeErrorText` 复现敏感模式 + 逐项核对 Modal/队列/Settings 代码路径。

---

## 1. 结论：**BLOCKED（不通过，needs revision）**

t190 的共享脱敏层、公共 Modal LIFO/焦点/快捷键门禁、Settings dirty/save 反馈大部分成立；但发现 **2 个 blocker**：

1. **MergeQueueModal 没有接入 `modalStack`**：它仍是 `src/git/ui/GitPanels.tsx` 的自定义 overlay（`role="dialog"` + 自己的 document keydown），不 push/register stack，因此 `#root` 不会 inert、`hasOpenModal()` 为 false（Alt+1..6/Ctrl+K 可穿透）、关闭不恢复触发焦点；打开队列时风险审批/设置等上层 Modal 的栈关系也不成立。t190 文档自己承认队列“out of scope，未注册进本栈”，但 t191 明确要求“风险审批/队列叠层”通过。
2. **`Authorization: Basic/Token` 仍泄漏凭据**：`AUTH_HEADER` 只吃第一个非空白 token。实际运行：
   ```text
   "Authorization: Basic dXNlcjpwYXNz" -> "Authorization: [REDACTED] dXNlcjpwYXNz"
   "Authorization: Token abc.def"      -> "Authorization: [REDACTED] abc.def"
   ```
   Bearer 因先被 `BEARER` 规则替换而不泄漏；Basic/Token 的凭据仍在 banner/toast/chat/复制详情中。t190 测试只覆盖 Bearer/Authorization 文本，未覆盖 Basic/Token。

因此 6 项验收中 **2 项失败、1 项有条件通过**；命令本身全绿（56 files/588）。

---

## 2. 命令结果（worktree HEAD `6499e40`）

| 命令 | 退出码 | 关键结果 |
|------|--------|----------|
| `pnpm typecheck` | **0** | `tsc --noEmit` 无错误 |
| `pnpm build` | **0** | 408 modules；js 1,227.14 kB (gzip 336.91)；css 245.43 kB (gzip 29.56)；electron main 1.5mb、preload 11.7kb；>500kB 既有警告 |
| `pnpm test` | **0** | **56 文件 / 588 用例**全部通过；redaction 5、modalStack 3、modalLayering 2、Settings 2、permission 44、approval 9/2、kernel 43 |

---

## 3. 逐项验证

### 3.1 敏感模式脱敏（FAIL）

已覆盖并通过（`errorRedaction.test.ts` 5 项）：

- `sk-...`、`Bearer ...`、`Authorization: Bearer ...`、`token/secret/password=`；
- `127.0.0.1`/`localhost`/`file://`；URL query 凭据；
- stack frames / provider JSON body；
- Electron `Error invoking remote method` 前缀；
- `code + summary`、空文本兜底。

**缺口（blocker）**：`AUTH_HEADER = /\b(?:Authorization|x-api-key|api-key)\s*:\s*[^\s,;]+/gi`（`errorRedaction.ts:16`）只匹配到 `Basic`/`Token` 第一个词；`Basic dXNlcjpwYXNz` 是合法 Authorization 值，base64 完整保留。

**服务端/日志**（部分）：

- t175 terminal 服务端已做 `terminalText` 脱敏（2KiB/message 500/code 64），renderer 二次清洗；这部分成立。
- 非 terminal 的 service/error 路径没有统一调用 `safeErrorSummary`/`sanitizeErrorText`；它们依赖 `formatError` 在 renderer 清洗。`electron/main.ts` 只有 `console.warn(failed to load envFile)`（`main.ts:131`），未发现 provider body 日志；但“服务端双层”只在 terminal 成立，泛化错误/日志没有端到端测试（medium，见 F3）。
- 覆盖点：banner `formatError`（`App.tsx:2570/2575`）、toast 包装 `formatError`（`:405-409`）、chat error `formatError`（`:1276`）、actionError（`:3738`）、Settings provider/save（`SettingsView.tsx:157/310`）均走共享清洗。

### 3.2 Modal 栈 / inert / Esc / 焦点 / 快捷键（FAIL）

公共 `Modal` 已成立（`Modal.tsx` + `modalStack.ts`）：

- push/pop LIFO；`#root` inert；非 top dialog inert + `aria-hidden`；
- Esc/Tab/backdrop 只在 `isTopModal` 时处理；关闭顶层回焦触发控件；
- App `hasOpenModal()` 在 Alt+1..6 / Ctrl+K / Ctrl+B 前返回（`App.tsx:628`）；
- `modalLayering.test` 两项：双 Modal Esc 只关顶层、回焦；confirmClose 拒绝时不关。

**缺口（blocker）**：`MergeQueueModal`：

- `src/git/ui/GitPanels.tsx:155` 自己 `document.addEventListener("keydown", onKey)` 处理 Esc/Tab；`:176-184` 是自建 `git-queue-backdrop`/`role=dialog`，**没有 import/push/register `modalStack`**；
- 因此队列打开时 `hasOpenModal()` 为 false（快捷键穿透）、`#root` 不 inert（背景可聚焦/可操作）、非 top dialog 不 inert/aria-hidden；关闭队列不恢复触发按钮焦点（只 focus close 按钮，无 restoreFocus）。
- t190 `security-modal-safety.md` §2.2 明确写“MergeQueue 仍是 src/git 自定义 overlay（本轮 out of scope，未注册进本栈）”；t191 要求“风险审批/队列叠层”通过，故不成立。
- 队列 + 风险/设置叠层时，两套 document keydown/焦点逻辑并存；不能保证 Esc 只关顶层。

### 3.3 Settings dirty / 保存失败（PASS，含低优先边界）

通过：

- `SettingsView` 用 providers/models/default/mock + translation 指纹计算 dirty（`SettingsView.tsx:97-110`）；`onDirtyChange` 通知 App；
- App `<Modal confirmClose={settingsDirty}>`（`App.tsx:2944`）；`openPanel`/hashchange/合并队列离开路径检查 dirty（`App.tsx:461/987/2097`）；
- 保存返回 `{ok:true|false}`；失败在 Settings 内 `role=alert` 显示、Modal 不关、草稿保留；成功显示“已保存”并清 dirty；
- `SettingsView.test.tsx` 2 项覆盖失败保留草稿/成功清 dirty，58/588 全绿。

低优先边界：Git 分区仍由 `GitSettingsPanel` 自管，不纳入 model/translation 指纹（t190 已声明 out of scope）；浏览器刷新/关闭窗口无 beforeunload 守卫；这些不阻塞当前“应用内 dirty guard”通过。

### 3.4 权限/审批/内核调度回归（PASS）

- t190 只改 `App.tsx`、`Modal.tsx`、`SettingsView.tsx`、`shared/copy.ts`、`shared/errorRedaction.ts`、`shared/modalStack.ts`、`styles.css`、tests/docs；**未改** `src/kernel`/权限/审批/调度/terminal 语义。
- 56/588 中 permission 44、approval 9、approval-wiring 2、kernel 43、t175 terminal 7 全部通过；t190 未触碰 review/merge gate 或 auto_risk 行为。

---

## 4. 发现与 required fix

| ID | 级别 | 发现 | Required fix |
|----|------|------|--------------|
| F1 | **blocker** | `MergeQueueModal` 未接入 modalStack：无 inert、无 `hasOpenModal`、快捷键穿透、无焦点恢复、与风险/设置叠层无 LIFO | 迁移到公共 `Modal`，或显式 `pushModal/registerModalElement/popModal` + top-only Esc/Tab/backdrop + restoreFocus；补 queue+risk/settings 叠层测试、Alt/Ctrl+K 不穿透测试 |
| F2 | **blocker** | `Authorization: Basic/Token ...` 凭据泄漏（`errorRedaction.ts:16/43`）；banner/toast/chat/复制详情会显示 base64/token | 把 Authorization 值匹配到行尾/逗号/分号为止（支持 Basic/Token/Digest/Bearer），或对 `Authorization:` 整段替换为 `Authorization: [REDACTED]`；补 Basic/Token/Digest 与 renderer endpoint 测试 |
| F3 | medium | 服务端泛化错误/日志未统一走 `safeErrorSummary`；目前仅 terminal 服务端脱敏 + renderer 清洗；无服务端/日志端到端用例 | 在 service/IPC 边界对错误做一次 `safeErrorSummary`，日志只输出摘要；补 banner/toast/chat/log 四端点注入测试（含 Basic/Token） |
| F4 | medium | `CommandPalette`/其它自建 `role=dialog` 也不在 modalStack；Alt+1..6/Ctrl+K 只对公共 Modal 门禁 | 统一所有 overlay 到 modal stack，或至少在自建 dialog 打开时 `hasOpenModal` 等效为 true；补快捷键不穿透 |
| F5 | low | Settings dirty 只覆盖应用内导航；浏览器刷新/关闭无 beforeunload；Git 分区 dirty 不在指纹 | 后续补 beforeunload 与 GitSettingsPanel onDirtyChange；不阻塞本轮 |
| F6 | low | `INTERNAL_URL` 只覆盖 localhost/127/::1/0.0.0.0/.internal；自定义内网 IP/host 仍显示 | 服务端配置补充内网 host 规则，或按 allowlist 脱敏；补测试 |
| F7 | low | `safeErrorSummary` 已实现但未被生产路径使用（仅测试） | 与 F3 一并接入 service/IPC；否则删除未用导出或补使用点 |

---

## 5. 结论

- **命令/构建/回归**通过；Settings dirty/save 成立；公共 Modal 的顶层语义成立。
- **P0-6 不通过**：F1（队列未进入 Modal 栈）与 F2（Authorization Basic/Token 泄漏）均为 blocker；F3/F4 为同主题中等风险，建议与 F1/F2 同批修复。
- PR #32 应进入 repair（F1/F2 必须先修，F3/F4 建议同批），修复后重新跑本文档 §2 + Basic/Token 注入 + queue/risk 叠层 + 快捷键穿透；本次未修改生产代码。

*本次验证仅新增本报告。*
