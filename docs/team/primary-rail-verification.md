# 一级入口 rail · 独立验证报告（t217）

- **任务**：t217 [verification] 独立验证 t216 P0-2 一级入口 rail
- **验证人**：max（QA / Release Reviewer，`deepseek-official/deepseek-flash`）
- **日期**：2026-11-12
- **被验证对象**：PR #35 `feature/t216-primary-rail`，HEAD `05f23fe`（OPEN/MERGEABLE；worktree `branches/t216-primary-rail`，clean）；未合并，未修改生产代码。
- **方法**：worktree 独立复跑三命令 + 读 PrimaryRail/App/CSS/tests + 查看 1440/960 真实 Electron 截图与 metrics + 逐项核对 active/keyboard/reopen/focus。

---

## 1. 结论：**PASS（通过，无 blocker）**

- 五个一级入口（对话/任务/团队/记忆/邮箱）、图标+短标签、active/`aria-current="page"` 均成立；展开/折叠 rail 与现有 Sidebar 一致。
- 鼠标点击、Enter/Space、Arrow/Home/End 均在 rail 内移动/打开；关闭面板后从 rail 重开经现有 `openPanel`/`ensurePanel`；打开后聚焦面板（chat 优先 composer）。
- 侧栏折叠、Dock tabs/split、▦、⌘K、Alt+1–6、deeplink、960 窄窗/Settings 均保留；未新增第二套面板状态。
- 1440 展开（rail 249px）与 960 折叠（rail 55px/图标）截图与 metrics 一致，无裁切；真实 Electron 1920 workspace 打开任务后滚动/宽度正常。
- 三命令最终全绿（64 文件/645 用例）；首次负载下出现既有 5s timeout，重跑通过（N2）。

发现 3 项低/中优先（§4），不阻塞本轮通过。

---

## 2. 命令（worktree HEAD `05f23fe`）

| 命令 | 退出码 | 结果 |
|------|--------|------|
| `pnpm typecheck` | **0** | 无错误 |
| `pnpm build` | **0** | 413 modules；js 1,236.12 kB (gzip 339.74)；css 247.63 kB (gzip 29.95)；electron main 1.5MB/preload 11.7kJ |
| `pnpm test`（最终） | **0** | **64 文件 / 645 用例**全绿；primaryRail 5、narrowWindow 28、DockShell 3、deeplink 17、permission 44、approval 9/2、review 17 |
| `pnpm test`（首次） | 1（环境 flake） | 2 个既有 5s timeout：openai、watchdog；`--testTimeout=20000` 与最终全量 645/645 通过 |

---

## 3. 逐项验证

### 3.1 五入口/图标/短标签/active/aria-current（PASS）

- `PRIMARY_RAIL_ENTRIES` 恰好 5 项且顺序为 `chat/tasks/team/board/mailbox`，每项 label/icon/title 非空（`primaryRailData.ts`）。
- 展开：249px，显示「图标 + 短标签 + 工作台」；折叠：55px，只留 40px 图标按钮，label 仍在 DOM（CSS `display:none`），button `title` 提供可访问名。
- active 由现有 `activePanelKey`/route tab 派生：`railKeyForActive` 对 runs→tasks、context→chat、settings→null；不新增 active state。
- active 按钮带 `aria-current="page"` + `.is-active`；`primaryRail.test` 服务端渲染断言 `aria-label="一级入口"`、五个 label、aria-current、is-active。
- 真实截图：1440 team active「团队」，960 board active「记忆」，与 metrics `activeEntry` 一致。

### 3.2 鼠标/键盘/关闭重开/焦点（PASS）

- `PrimaryRail` 原生 button：点击调用 `onOpen`；`onKeyDown` 处理 Enter/Space 打开，ArrowDown/Right、ArrowUp/Left、Home/End 移动焦点并 wrap（`railFocusIndex`）。
- App `openPrimaryPanel` 复用唯一 `openPanel`；关闭面板由 DockShell `ensurePanel` 重开（t194 既有行为，未复制面板状态）。
- 打开后 `railFocusRequest` 在 React 提交后调用 `focusPanelWhenReady`：非 chat 聚焦 `data-panel` 容器（tabIndex=-1），chat 优先 `textarea/[contenteditable]`，再回退可聚焦元素；之后 120/450/1200/2500ms 重试。
- 真实 Electron metrics：
  - 1440 点击团队 → active 团队、focusPanel=team；
  - 960 点击记忆 → active 记忆、focusPanel=board；
  - 960 ArrowDown→Enter → active 任务、focusPanel=tasks；
  - 1440 团队面板关闭后从 rail 重开截图 `t216-rail-1440-team-reopened.png`。
- `primaryRail.test` 5 例覆盖点击、ArrowDown 焦点移动、Enter 打开、折叠 title；无 blocker。

### 3.3 折叠/Dock/⌘K/Alt/深链/窄窗（PASS）

- 折叠复用 `sidebarCollapsed`/Ctrl+B/localStorage，无第二套宽度列或 rail state；rail 在 `.sidebar.collapsed` 内 55px，Dock 宽度预算未变。
- Dock tabs/split、▦ 面板启动器、⌘K/Ctrl+K、Alt+1–6、deeplink 均保留（App 未替换这些入口）。
- 960 窄窗仍由 t194 的 sidebar auto-collapse + Dock single + Team within 控制；rail 只加图标栏，不新增横向列；截图/`metrics` 的 sidebar/rail class 与宽度一致。
- Settings 仍为独立 Modal；rail 不替代 Settings 入口；Dock 存档 schema `deer.dock.v1` 未变。

### 3.4 1440/960 无裁切 / 无第二套面板状态（PASS）

- `t216-rail-metrics.json`：1440×900 rail 249px、`primary-rail`、五 label `display:block`、active 团队、focus team；960×700 rail 55px、`primary-rail is-collapsed`、label `display:none`、active 记忆/任务、focus board/tasks。
- 截图 `t216-rail-1440-team.png`、`t216-rail-960-board.png`、`t216-rail-960-tasks.png` 显示 rail 与 Dock/侧栏无重叠；1440/960 均无横向裁切。
- App 仅新增 `railFocusRequest`（opening focus 请求），panel 选择仍由 `activePanelKey`/`tab`/Dock store 决定；无第二套面板状态。

### 3.5 回归/范围（PASS）

- 改动 12 文件：`App.tsx`、`PrimaryRail.tsx`、`primaryRailData.ts`、`primaryRail.test.tsx`、`DockShell.tsx` 一行 tabIndex、`styles.css`、docs/4 图/JSON。
- 未改 shared/kernel/git/memory/review/watchdog/electron；64/645 全绿：narrowWindow 28、DockShell 3、permission 44、approval 9/2、execution 43、review 17、watchdog 23、git 56。
- PR #35 OPEN/MERGEABLE/CLEAN；worktree clean；未合并。

---

## 4. 发现（低/中，非阻塞）

| ID | 级别 | 发现 | 建议 |
|----|------|------|------|
| N1 | **medium** | `focusPanelWhenReady` 在 120/450/1200/2500ms 重试聚焦面板，未在用户点击其他 Dock/rail/菜单后取消；用户打开 rail 后 2.5s 内操作可能被旧面板抢焦点 | 在 pointerdown/keydown 或 activePanel 变化时取消待执行 focus；仅在 activeElement 仍是 body/rail 时补焦 |
| N2 | low | 首次 `pnpm test` 在负载下出现既有 openai/watchdog 5s timeout（非本 PR）；最终 645/645 通过 | CI 将脆弱网络/时钟测试单独放宽 timeout 或串行 |
| N3 | low | `primaryRail.test` 未直接覆盖 ArrowLeft/ArrowRight/Space（实现已支持）；focusPanel 仅有 Electron metrics，无组件级焦点负例 | 补 2-3 条单测；把 N1 的“用户先操作后不抢焦点”纳入回归 |
| N4 | low | active 在面板关闭后仍保留（`activePanelKey` 未清），rail 显示最后入口；对“关闭后重开”是有用提示，但可能需要徽标/提示“已关闭” | 维持现状即可，或加 title“已关闭，点击重开” |
| N5 | low | rail 点击后设置 `railFocusRequest` 使用 `Date.now()` nonce；同一毫秒连续同 key 点击不会触发新 effect | 用递增计数器替代 nonce（极低概率） |

---

## 5. 结论

**PASS**：五入口/短标签/aria-current、鼠标+键盘、关闭重开、focusPanel、折叠/1440/960、Dock/深链/快捷键/窄窗无回归；三命令最终全绿（64/645）。N1 为中等焦点健壮性改进，建议后续修复；不阻塞 PR #35 进入评审/合并流程。

*本次验证仅新增本报告，未修改生产代码。*
