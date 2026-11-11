# P0-6 错误脱敏与 Modal/设置草稿安全最终集成验收（t193）

- **任务**：t193 — 集成验收 P0-6 安全修复
- **实现链**：t190 基础 → t198 修复 → t200 修复 → t202 测试 → t203 复验 → t204 repair-round-2 → t206 stacking → t207 review pass
- **PR**：[#32](https://github.com/DeerLuuu/deer-super-group/pull/32) — **MERGED（squash）**
- **合并提交**：`d12d7ab`（2026-11-12）
- **实现文档**：`docs/team/security-modal-safety.md`
- **复验报告**：`security-modal-safety-verification.md`、`security-modal-safety-reverification.md`、`security-modal-safety-queue-reverification.md`、`security-modal-safety-palette-reverification.md`
- **结论**：**PASS，可交付**；PR 已合并，t190 worktree/branch 已清理，main clean。

## 1. 结论

P0-6（信任与恢复）已完成最终集成验收：

- **secret sanitize**：renderer 错误、toast、chat 终态、provider 列表/保存错误统一走 shared sanitizer；覆盖 `sk-`、Bearer/任意 scheme Authorization、x-api-key、token/secret/password、Cookie/Set-Cookie、URL query、internal/file URL、RFC1918/IPv6/.local、stack、provider JSON body；保留可用 code/摘要。
- **服务端一致性**：`terminalText`/chat error/listModels/interactive ingest 复用 `safeErrorSummary`/`sanitizeErrorText`；持久化 terminal 与旧事件投影均不泄漏 provider 原文。
- **Modal 栈**：公共 `modalStack` LIFO；`#root` inert；非 top dialog `aria-hidden`；Esc/Tab/backdrop 只作用于 top；顶层关闭回焦触发控件；body scroll lock 引用计数；CommandPalette/Toast/KernelAnnouncer portal 到 body，root inert 时仍可用/可见。
- **Settings/Git 草稿**：providers/models/default/mock + translation + Git 基线 dirty 指纹；关闭/切换面板/深链离开前确认；保存失败不关闭、草稿保留；成功后清 dirty；beforeunload 守卫。
- **MergeQueue**：改用公共 Modal，继承 LIFO/inert/Esc/Tab/backdrop/回焦；不再自建 overlay/keydown。
- **权限/审批/内核无回归**：未改 permission/approval/execution/scheduler/toolPolicy/review gate 语义；service 改动只替换错误摘要与 terminal 清洗。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| 错误脱敏（renderer/UI） | `src/shared/errorRedaction.ts`；`copy.ts` `formatError`；App banner/toast/actionError；Settings provider/save error | `errorRedaction.test.ts` 9 项；SettingsView 3 项；command palette/Toast portal |
| 错误脱敏（服务端/终态） | `src/kernel/service.ts` `terminalText`/`safeErrorSummary`；`chatTurnProjection.ts` `capTerminalText` 复用 | `chatTurnTerminalService.test.ts` 8 项（provider 401 body + Cookie/client/access/private）；projection 15 项 |
| Authorization 任意 scheme 整段 | errorRedaction Authorization/Cookie 规则；terminal 同步 | t198/t204 测试（Basic/Token/Digest/Bearer/大小写/snake/camel） |
| Modal LIFO / inert / 回焦 | `src/shared/modalStack.ts`；`Modal.tsx`；`App.tsx`；`CommandPalette.tsx`；`GitPanels.tsx` | modalStack 4、modalLayering 2、MergeQueueLayer 2、CommandPalette 1 |
| 非 top inert/aria-hidden | modalStack + Modal | modalLayering、MergeQueueLayer 双 Modal |
| Esc/Tab/backdrop top-only | Modal keydown/backdrop + stack | modalLayering 2；MergeQueueLayer 2 |
| 全局快捷键不穿透 | App `hasOpenModal`；CommandPalette `isTopModal` | t202 合同探针；App 生产 handler 检查；t203 PASS |
| body scroll lock 引用计数 | modalStack push/pop | modalStack 4；t204 非 top 卸载仍锁测试 |
| Settings dirty/保存失败 | `SettingsView.tsx` onDirtyChange/Promise save；App confirmClose/beforeunload | SettingsView 3 项（dirty/失败保留/成功清 dirty/beforeunload） |
| Git 分区 dirty | `GitPanels.tsx` 基线 + onDirtyChange；App 合并 dirty | GitPanels 4 项 |
| MergeQueue 公共 Modal | `GitPanels.tsx` 删除自建 overlay/keydown | MergeQueueLayer 2（只关队列/回焦/root inert/快捷键） |
| Toast/Announcer 在 inert 外 | AppLiveRegions `.app-toast-layer` zIndex 1200/pointer-events none；toast auto | AppLiveRegions 1 项 |
| 无权限/审批/内核回归 | diff 无相关文件；service 仅 sanitizer | permission 44、approval 9、approval-wiring 2、execution kernel 43 全绿 |
| 三命令 | — | typecheck 0 / build 0 / test 59 files/600 |

## 3. 独立验证（合并后 main）

工作目录：`S:\DeerSuperGroup`（main `d12d7ab`，worktree 仅 main，clean）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；408 modules
                 # js 1,229.23 kB / gzip 337.64
                 # css 245.43 kB / gzip 29.56
                 # electron main 1.5 MB / preload 11.7 KB
pnpm test        # exit 0；59 files / 600 tests
```

> 说明：合并后首次 main 全量跑中 `watchdog.test.tsx > resets provider failure window...` 出现一次 5s 测试超时（既有 timing 型 flake）；该文件单独复跑 23/23 通过，随后全量复跑 **59/600 全绿**。PR worktree 内首次全量已是 59/600，两者一致；flake 不作为功能失败，但保留为 P1 测试稳定性项。

## 4. 安全/交互验收证据

1. **secret fixture**：`errorRedaction.test.ts` 9 例覆盖 `sk-`、Bearer/Authorization 任意 scheme、x-api-key、token/secret/password、Cookie/Set-Cookie、URL query、internal URL、private IP/local、stack/provider body、大小写/snake/camel。
2. **真实终态持久化**：`chatTurnTerminalService.test.ts` 的 provider 401 body + Cookie/client_secret/accessToken/private_key 用例断言持久化 terminal 不含 secret；旧事件投影 negative 断言不泄漏。
3. **Modal 叠层**：`modalLayering.test.tsx` 2 例；`MergeQueueLayer.test.tsx` 2 例（队列+设置双 Modal，Esc 只关队列；root inert/回焦/快捷键）；`CommandPalette.test.tsx` 真实 root/body portal。
4. **Settings/Git 草稿**：`SettingsView.test.tsx` 3 例 + `GitPanels.test.tsx` 4 例；保存失败保留草稿，成功后清 dirty，beforeunload 注册。
5. **Toast 可见性**：`AppLiveRegions.test.tsx` 断言 `.app-toast-layer` 层叠高于 modal/palette、pointer-events none、toast close/action 可点击、backdrop 不触发。
6. **视觉证据**：`docs/team/t190-settings-dirty.png`（Settings 修改后显示“有未保存修改”）。
7. **评审**：t207 verdict=pass，未发现 blocker/findings；t203 PASS；t199/t192/t201 findings 已由 t198/t200/t202/t204/t206 关闭。

## 5. 范围/兼容性检查

- PR #32 合并 27 文件：`src/shared/{errorRedaction,modalStack}.ts`、`src/Modal.tsx`、`App.tsx`、`SettingsView.tsx`、`CommandPalette.tsx`、`GitPanels.tsx`、`chatTurnProjection.ts`、`kernel/service.ts`、`styles.css`、docs/截图/tests。
- **无** `src/kernel/permission*`/`approval*`/`execution/`/scheduler/tool policy 语义改动；无 schema/migration；无 review/merge gate 语义改动。
- `service.ts` 变更只把错误文本交给 shared sanitizer；`terminalText` 仍遵守 2KiB/500 字等既有上限。
- 旧事件/旧消息无需迁移；投影对旧 terminal 继续使用同一 sanitizer。
- 合并前 PR #32 OPEN/MERGEABLE/CLEAN，head `7fd171e`（含 t193 验证文档）；合并后 main `d12d7ab`；t190 worktree 已移除，branch 已删除。
- 未直接修改 main 代码；合并通过 GitHub squash merge。

## 6. 遗留项（P1/低优先，不阻塞）

1. **测试稳定性**：watchdog provider-window 用例存在偶尔 5s 超时；建议提高该用例 timeout 或拆分 fake clock 测试（P1）。
2. **真实 DOM**：Modal/CommandPalette/MergeQueueLayer 测试使用 `react-test-renderer`/FakeElement，不是真实 Chromium；发布前建议 Electron/Playwright 冒烟（N2）。
3. **App 快捷键集成**：guardedShortcut 为合同探针，非 App 实例真实 keydown 测试（t203 N1）；生产 `hasOpenModal` handler 已检查。
4. **Git dirty 来源**：App 能合并 Git dirty，但 GitSettingsPanel 的 dirty 判定仍是基线快照方式；更细字段级 dirty 可后续增强。
5. **Toast 层叠**：CSS z-index 1200 为当前约定；若未来新增全局层需统一 token，避免层级冲突。
6. **错误脱敏规则**：未知 provider 错误形态仍可能包含未识别字段；新增 provider 时需补 fixture。
7. **无真实用户安全测试**：本验收是代码/单测/评审证据，不是渗透测试。

## 7. 合并/清理状态

| 项 | 状态 |
|----|------|
| PR #32 | MERGED（squash） |
| 实现 head / 文档 head | `335f43c` / `7fd171e` |
| merge commit | `d12d7ab` |
| main | `d12d7ab`，工作树 clean |
| t190 worktree | 已移除（`pnpm branch:remove t190-security-modal-safety`） |
| t190 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 最终三命令 | typecheck 0 / build 0 / test 59 files/600 |

**最终结论：PASS；P0-6 错误脱敏、Modal 栈与 Settings/Git 草稿安全已完成集成。残余均为 P1/测试稳定性项，不阻塞交付。**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
