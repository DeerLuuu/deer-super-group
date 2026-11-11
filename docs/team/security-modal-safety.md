# 错误脱敏与 Modal/设置草稿安全（t190 / t198 / t200 / t202 / t204）

- **任务**：t190 基础 → t198 修复 → t200 CommandPalette portal → t202 队列测试 → t204 repair-round-2
- **依据**：`docs/team/ux-audit-final.md` P0-6 / t182 A11Y-06；t191 findings F1–F6；t199 F1；t201 唯一失败项；t203 PASS 复验
- **分支**：`feature/t190-security-modal-safety`（基于 main `5b598ad`）
- **范围**：`src/App.tsx`、`src/Modal.tsx`、`src/CommandPalette.tsx`、`src/SettingsView.tsx`、`src/shared/`、`src/git/ui/GitPanels.tsx`、`src/kernel/service.ts`、`src/kernel/chatTurnProjection.ts`、`src/styles.css`、`docs/team/`
- **不做**：不改权限/审批/内核调度语义；不把配置改成面板；不做视觉重设计。
- **t203 复验**：PASS，报告 `docs/team/security-modal-safety-queue-reverification.md`（main）；本文件同步纳入其结论。

---

## 0. Before / After 行为摘要

| 场景 | Before | After |
|---|---|---|
| Banner / 复制详情 | 直接显示 / 复制 IPC/provider 原文；可能含 `sk-`、`Bearer`、Authorization、内部 URL、JSON body | `formatError` → 共享 `sanitizeErrorText`；banner、复制详情、toast、chat error 全部走脱敏 |
| Stack trace | 可透出 `at OpenAiClient.stream (C:/...)` | 去掉 stack 帧，保留首行摘要/错误码 |
| Settings 关闭 | 修改后 Esc/关闭/切换面板直接丢失 | dirty guard：Esc/关闭/backdrop/离开面板先确认；保存成功才清除 dirty |
| Settings 保存失败 | 全局 banner/toast，草稿可能被关闭丢失 | 错误显示在 Settings 内部；Modal 不关闭、草稿保留 |
| Modal 叠层 | 每个 Modal 各自监听 Esc；低层也可能响应；背景可聚焦；Alt/Ctrl+K 穿透 | 全局 LIFO 栈：Esc/Tab 只由 top 处理；`#root` inert；非 top dialog inert/aria-hidden；App 全局快捷键见 Modal 即退出 |
| CommandPalette | 在 `#root` 内，Modal 打开时被祖先 inert 冻结 | portal 到 `document.body`；输入/Esc/Tab 在 inert root 下仍可用 |
| MergeQueue | 自建 overlay/keydown/role=dialog | 使用公共 `Modal`，继承 LIFO/inert/backdrop/回焦/快捷键门禁 |
| 全局 live region | ToastHost/KernelAnnouncer 在 app 内，Modal 时被 inert | portal 到 body；toast 仍可见/可关闭，aria-live 仍播报 |
| body scroll | 每个 Modal 各存 prevOverflow，非 top 先卸载会误恢复 | modalStack 引用计数，最后 pop 才恢复原值 |
| 焦点 | 关闭后回焦不保证 | 顶层关闭回焦触发控件；背景不可聚焦 |

---

## 1. 错误脱敏

### 1.1 共享实现 `src/shared/errorRedaction.ts`

- `sanitizeErrorText(text, max=1000)`：
  - 移除 ANSI/控制字符；
  - 移除 stack 帧（`at ...`）；
  - 脱敏 `sk-...`、`Bearer ...`、`Authorization/x-api-key/api-key: ...`（任意 scheme，整段值到行尾/分号）、`Cookie/Set-Cookie: ...`；
  - 脱敏 key 别名 `api_key/token/secret/password/client_secret/clientSecret/access_token/accessToken/refresh_token/private_key/access_key`（大小写、snake/camel）；
  - 脱敏 URL 查询凭据（同 key 别名）；
  - 内部 URL（`localhost/127.*`、RFC1918、169.254、IPv6 fc/fd/fe80、`.internal/.local/.lan/.intranet/.corp/.home/.localdomain/.svc`、docker.internal）替换 `[内部地址已隐藏]`；
  - `file://` 替换 `[本地路径已隐藏]`；
  - `{"error":...}` / `choices/request_id/provider` provider body 替换 `[provider 原始响应已隐藏]`；
  - 折叠空白，截断 max，空文本返回可行动兜底。
- `safeErrorSummary(error, max=1000)`：保留可行动 `code`（忽略泛型 Error/TypeError name）+ 首行摘要（code 不重复）。
- `formatError`（`src/shared/copy.ts`）先剥离 Electron `Error invoking remote method ...:` 前缀，再调用 `sanitizeErrorText`；所有既有 `formatError` 调用（banner、toast、任务/轨迹/设置等）自动获益。

### 1.2 Renderer 覆盖点

- **全局 error banner**：显示和「复制详情」都调用 `formatError(error)`；不再复制原始 IPC 文本。
- **Toast**：App 的 `pushToast` 包装 `useToasts`，message/detail 统一 `formatError`。
- **Chat error**：`ChatEvent.error` 进入 `setError` 前 `formatError`；历史/实时 terminal 摘要由 t175 的 service/投影脱敏。
- **任务 actionError**：渲染时 `formatError`。
- **Settings**：provider 错误、model 拉取错误、保存失败信息都用 `formatError`。
- **服务端边界**：terminal 写入（`terminalText`）与投影 `capTerminalText` 统一复用 `sanitizeErrorText`，不再各写一套；message/code/tool 仍保持 500/64/120 与 2KiB payload cap；`safeErrorSummary` 用于 chat error/listModels/ingest。真实 provider 401 body + Cookie/client_secret/accessToken/private_key 已由 terminal 事件测试覆盖；投影测试覆盖旧事件/手工导入。

### 1.3 Before/After 样例

```text
Before:
LLM 401: {"error":{"message":"Incorrect API key sk-live-ABC123456"}}
Authorization: Bearer abc.def.ghi
    at OpenAiClient.stream (C:/app/src/model.ts:42:9)
    GET http://127.0.0.1:8787/internal?token=secret

After:
LLM 401: [provider 原始响应已隐藏] [REDACTED]
```

（`Authorization`/internal URL 会分别替换为 `Authorization: [REDACTED]` / `[内部地址已隐藏]`；stack/provider body 不出现。）

---

## 2. Modal 栈 / inert / 快捷键

### 2.1 共享栈 `src/shared/modalStack.ts`

- `pushModal(token)` / `popModal(token)`：LIFO。
- `isTopModal(token)`：只有栈顶为 true；Esc/Tab/backdrop 只由 top 处理。
- `hasOpenModal()`：App 全局快捷键门禁。
- `registerModalElement` / `unregisterModalElement`：同步 DOM：
  - `#root` 在任一 Modal 开启时 `inert`；
  - 非 top `.modal` 加 `inert` + `aria-hidden=true`；top 移除 aria-hidden。
- **body lock 引用计数**：`pushModal` 第一次锁 body，`popModal` 最后一项才恢复原 overflow；非 top 先卸载不会提前解锁。Modal 与 CommandPalette 都只调用 push/pop，不各自保存/恢复。
- `subscribeModalStack` 供订阅（当前用于测试/未来 UI）。

### 2.2 Modal 行为

- 打开时 push + register，聚焦 `initialFocusRef` 或首个可聚焦元素。
- `Esc`：top 才处理；关闭前若 `confirmClose` 走 `window.confirm`。
- `Tab/Shift+Tab`：top 内焦点陷阱。
- 背景点击/关闭按钮：同一条 `requestClose`；只有 top 响应。
- 关闭时 pop；只有 top 关闭才回焦触发控件（避免低层 Modal 抢焦点）。
- 全局 `Alt+1–6` / `Ctrl+K` / `Ctrl+B`：App keydown 首先 `hasOpenModal()` 返回，不穿透。
- **MergeQueueModal** 已使用公共 `Modal`（不再自建 overlay/keydown/role=dialog），继承上述语义；队列+设置叠层测试通过。
- **CommandPalette** 自建 dialog 但已接入 modalStack：portal 到 body、顶层 isTopModal 门禁、Tab 环形、关闭回焦、body lock。
- 风险审批队列使用同一个 Modal 原语；MergeQueue 也已纳入。
- **全局 live region**：ToastHost + KernelAnnouncer 由 `AppLiveRegions` portal 到 body；Modal 打开时 toast 仍可见/可关闭，`role=status/alert` 与 `aria-live` 不被 inert root 屏蔽。

### 2.3 Settings dirty/save guard

- `SettingsView` 维护:
  - `modelBaselineRef`：snapshot providers/models/default model/mock 的指纹；
  - `translationBaselineRef`：翻译设置加载/保存后的基线；
  - `dirty = modelFingerprint !== baseline || translationFingerprint !== baseline`；
  - `onDirtyChange(dirty)` 通知 App。
- App:
  - `<Modal confirmClose={settingsDirty}>`；Esc/backdrop/关闭按钮先确认；
  - `openPanel`/hashchange/「合并队列」等绕过 Modal 的离开路径也检查 dirty 并确认；
  - 保存成功：App `refresh` + 返回 `{ok:true}`；Settings 内部显示「已保存」并更新基线；
  - 保存失败：返回 `{ok:false,error}`；Settings 内部 `role=alert` 显示「保存失败：…」，Modal 不关闭，草稿保留；
  - Settings 切换 section 不影响草稿；关闭后 `settingsDirty=false`。
- 保存反馈不再只靠全局 toast/banner；在 Settings 顶部 dirty 标记和保存按钮旁状态可见。
- **Git 分区已接入**：`GitSettingsPanel` 维护保存基线并通过 `onDirtyChange` 汇入 Settings dirty；Git 保存成功清 dirty，Git 分区内切换/关闭 Settings 均受守卫；dirty 时注册 `beforeunload`。

---

## 3. 验证

新增/补强测试：
- `src/shared/errorRedaction.test.ts`（9）：sk/Bearer、Authorization 任意 scheme、Cookie/Set-Cookie、client_secret/clientSecret/accessToken/private_key/access_key、URL query、私网/internal/file URL、stack/provider body、Electron remote prefix、code/空摘要。
- `src/kernel/chatTurnTerminalService.test.ts`（8）：真实 provider 401 body + Cookie/client/access/private secret fixture 经 terminal 事件持久化后不泄漏。
- `src/kernel/chatTurnProjection.test.ts`（15）：旧事件/手工导入投影同样走 shared sanitizer，secret/stack/internal/provider body negative assertions。
- `src/git/ui/MergeQueueLayer.test.tsx`（2）：队列+设置双 Modal；root inert 打开/关闭释放、Alt/Ctrl+K 门禁、Esc 只关顶层、回焦。
- `src/CommandPalette.test.tsx`（1）：inert root 下 portal body、输入 focus/Esc/Tab、关闭回焦、栈释放。
- `src/AppLiveRegions.test.tsx`（1）：Modal 打开时 toast/announcer portal body、toast 可见/可关闭、aria-live。
- `src/shared/modalStack.test.ts`（4）：LIFO/top、订阅、root/non-top inert、body lock 引用计数（非 top 先卸载仍锁）。
- `src/shared/modalLayering.test.tsx`（2）：双 Modal 顶层 Esc、confirmClose。
- `src/SettingsView.test.tsx`（3）：dirty、保存失败草稿、beforeunload。

全量基线：
- 旧：51 files / 560 tests（t172 后）
- 当前：**59 files / 600 tests**

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0（408 modules）
pnpm test        # exit 0（59 files / 600 tests）
```

构建输出：
```text
dist/assets/index-BFSGM24K.css   245.43 kB / gzip 29.56
dist/assets/index-*.js           ~1,228 kB / gzip ~337 kB
dist-electron/main.cjs 1.5mb; preload.cjs 11.7kb
```

---

## 4. 手动/安全证据

- **Settings dirty 截图**：`docs/team/t190-settings-dirty.png`（修改 Provider 名称后，左侧显示「有未保存修改」；关闭/Esc 触发确认；保存失败保留此草稿）。
- 在 dev 构建中把错误字符串设为：
  ```
  LLM 401: {"error":"bad"} sk-live-ABC123456
  Authorization: Bearer abc.def.ghi
      at OpenAiClient.stream (C:/app/src/model.ts:42:9)
  ```
  banner 只显示脱敏摘要；「复制详情」内容同样不含 `sk-live`/`Bearer`/`Authorization`/`at `。
- 打开 Settings，修改 Provider 名称 → 关闭/Esc 出现确认；取消后仍留在 Settings，输入保留。
- 模拟保存失败：Settings 内显示「保存失败：…」，Modal 不关闭，输入仍在。
- 打开 Settings → 触发风险审批 Modal（或任意第二个 Modal）：Esc 只关顶层；背景控件不可 Tab 聚焦；关闭后焦点回到触发控件。
- Modal 打开时按 Alt+1–6 / Ctrl+K：页面不切换、命令面板不打开。
- Modal 打开时 toast 仍显示在 body 层并可关闭；`aria-live` 仍播报任务/Run 状态。
- **t206 stacking**：`AppLiveRegions` 的 `.app-toast-layer` 固定 `z-index:1200`（modal-backdrop 1000、palette 150 之上），层本身 `pointer-events:none`，`.toast` 保持 `pointer-events:auto`；toast 的关闭/action 不被 backdrop 截获。
- 先关闭非 top Modal，再关闭 top：body scroll 保持锁定直到最后一个 Modal 关闭。

---

## 5. 限制 / 后续

- 内部 URL 的判定已覆盖常见私网/内网；自定义企业 host 不在列表时仍需服务端/配置层补充。
- `window.confirm` 是系统原生确认，不是自定义 Modal；后续可替换为统一确认对话框，但语义（关闭前确认）已具备。
- 语言/文案仍有中英混合（如 provider 名称），本轮不改文案体系。
- 未修改权限/审批/内核调度；终端事件仍保留 append-only 审计。
- t203 复验为 PASS（队列测试证据已补齐）；t199 的 F1 CommandPalette inert root 已由 t200 portal 修复，F2 Authorization 已由 t198/t204 整段 scheme 脱敏覆盖。
- 本文件此前 t190 口径（MergeQueue out of scope、56/588、Git 未接 dirty）已全部被上方 t198–t204 段落取代。
