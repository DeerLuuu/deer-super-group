# 错误脱敏与 Modal/设置草稿安全（t190 / P0-6）

- **任务**：t190 — 实现 P0-6 错误脱敏 + Modal 栈/设置草稿安全
- **依据**：`docs/team/ux-audit-final.md` P0-6 / t182 A11Y-06
- **分支**：`feature/t190-security-modal-safety`（基于 main `5b598ad`）
- **范围**：`src/App.tsx`、`src/Modal.tsx`、`src/SettingsView.tsx`、`src/shared/`、`src/styles.css`、`docs/team/`
- **不做**：不改权限/审批/内核调度语义；不把配置改成面板；不做视觉重设计。

---

## 0. Before / After 行为摘要

| 场景 | Before | After |
|---|---|---|
| Banner / 复制详情 | 直接显示 / 复制 IPC/provider 原文；可能含 `sk-`、`Bearer`、Authorization、内部 URL、JSON body | `formatError` → 共享 `sanitizeErrorText`；banner、复制详情、toast、chat error 全部走脱敏 |
| Stack trace | 可透出 `at OpenAiClient.stream (C:/...)` | 去掉 stack 帧，保留首行摘要/错误码 |
| Settings 关闭 | 修改后 Esc/关闭/切换面板直接丢失 | dirty guard：Esc/关闭/backdrop/离开面板先确认；保存成功才清除 dirty |
| Settings 保存失败 | 全局 banner/toast，草稿可能被关闭丢失 | 错误显示在 Settings 内部；Modal 不关闭、草稿保留 |
| Modal 叠层 | 每个 Modal 各自监听 Esc；低层也可能响应；背景可聚焦；Alt/Ctrl+K 穿透 | 全局 LIFO 栈：Esc/Tab 只由 top 处理；`#root` inert；非 top dialog inert/aria-hidden；App 全局快捷键见 Modal 即退出 |
| 焦点 | 关闭后回焦不保证 | 顶层关闭回焦触发控件；背景不可聚焦 |

---

## 1. 错误脱敏

### 1.1 共享实现 `src/shared/errorRedaction.ts`

- `sanitizeErrorText(text, max=1000)`：
  - 移除 ANSI/控制字符；
  - 移除 stack 帧（`at ...`）；
  - 脱敏 `sk-...`、`Bearer ...`、`Authorization/x-api-key/api-key: ...`、`api_key/token/secret/password=...`；
  - 脱敏 URL 查询凭据；
  - 内部 URL（`localhost/127.*/[::1]/.internal`）替换 `[内部地址已隐藏]`；
  - `file://` 替换 `[本地路径已隐藏]`；
  - `{"error":...}` / `choices/request_id/provider` provider body 替换 `[provider 原始响应已隐藏]`；
  - 折叠空白，截断 1000，空文本返回可行动兜底。
- `safeErrorSummary(error, max=1000)`：保留 `code/name` + 首行摘要（code 不重复）。
- `formatError`（`src/shared/copy.ts`）先剥离 Electron `Error invoking remote method ...:` 前缀，再调用 `sanitizeErrorText`；所有既有 `formatError` 调用（banner、toast、任务/轨迹/设置等）自动获益。

### 1.2 Renderer 覆盖点

- **全局 error banner**：显示和「复制详情」都调用 `formatError(error)`；不再复制原始 IPC 文本。
- **Toast**：App 的 `pushToast` 包装 `useToasts`，message/detail 统一 `formatError`。
- **Chat error**：`ChatEvent.error` 进入 `setError` 前 `formatError`；历史/实时 terminal 摘要由 t175 的 service/投影脱敏。
- **任务 actionError**：渲染时 `formatError`。
- **Settings**：provider 错误、model 拉取错误、保存失败信息都用 `formatError`。
- **服务端边界**：t175 的 terminal 写入（`sendChat` cancel/error）已有 `terminalText` 脱敏 + 2KiB/message 500/code 64 cap；本轮 renderer 共享层做第二次清洗，避免旧事件/新 IPC 路径泄漏。

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
- `subscribeModalStack` 供订阅（当前用于测试/未来 UI）。

### 2.2 Modal 行为

- 打开时 push + register，聚焦 `initialFocusRef` 或首个可聚焦元素。
- `Esc`：top 才处理；关闭前若 `confirmClose` 走 `window.confirm`。
- `Tab/Shift+Tab`：top 内焦点陷阱。
- 背景点击/关闭按钮：同一条 `requestClose`；只有 top 响应。
- 关闭时 pop；只有 top 关闭才回焦触发控件（避免低层 Modal 抢焦点）。
- 全局 `Alt+1–6` / `Ctrl+K` / `Ctrl+B`：App keydown 首先 `hasOpenModal()` 返回，不穿透。
- 风险审批队列（多个 `riskApprovals`）使用同一个 `Modal` 原语，因此叠层时 Esc 只关最上层；背景 `#root` inert，焦点不会跑到下层。MergeQueue 仍是 `src/git/` 的自定义 overlay（本轮 out of scope，未注册进本栈）；它打开时若上层有 Modal，Modal 的 capture Esc 会先处理，不会同时关闭两层。

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
- Git 分区仍由 `GitSettingsPanel` 自己的保存按钮/状态管理（其 dirty 不在本轮 model/translation 指纹内；见 §5 限制）。

---

## 3. 验证

新增测试：
- `src/shared/errorRedaction.test.ts`（5）：sk/Bearer/Authorization/token/password、internal/file URL、stack、provider body、Electron remote prefix、code/summary、空文本兜底。
- `src/shared/modalStack.test.ts`（3）：LIFO/top、订阅、root/non-top inert + aria-hidden。
- `src/shared/modalLayering.test.tsx`（2）：两个 Modal 叠层，Esc 只调用顶层 onClose；卸载后焦点回到触发控件；`confirmClose` 在 dirty 确认拒绝时不关闭、接受后关闭。
- `src/SettingsView.test.tsx`（2）：编辑后 dirty=true；保存失败显示在 Settings 内且草稿保留；保存成功显示「已保存」并 dirty=false。

全量基线：
- 旧：51 files / 560 tests（t172 后）
- 当前：**56 files / 588 tests**

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0（408 modules）
pnpm test        # exit 0（56 files / 588 tests）
```

构建输出：
```text
dist/assets/index-BFSGM24K.css   245.43 kB / gzip 29.56
dist/assets/index-Cdy0VSLi.js   1,227.14 kB / gzip 336.91
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

---

## 5. 限制 / 后续

- Git 分区的 dirty 仍由 `GitSettingsPanel` 自己管理（`src/git/` 本轮 out of scope）；后续可给该面板 `onDirtyChange`/`onSaved` 回调，纳入统一 Settings guard。
- 内部 URL 的判定基于常见 host；自定义企业内网 host 不在列表时仍需服务端/配置层补充。
- `window.confirm` 是系统原生确认，不是自定义 Modal；后续可替换为统一确认对话框，但语义（关闭前确认）已具备。
- 语言/文案仍有中英混合（如 provider 名称），本轮不改文案体系。
- 未修改权限/审批/内核调度；终端事件仍保留 append-only 审计。
