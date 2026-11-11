# P0-2 常驻一级入口 rail（对话 / 任务 / 团队 / 记忆 / 邮箱）

- **任务**：t216 — 依据 `docs/team/ux-audit-final.md` P0-2 与 bb-98/bb-97，保留 Dock，新增可见一级入口 rail
- **分支**：`feature/t216-primary-rail`
- **基线**：main `6b2331e`（t208 Dock 最大分栏合并后）
- **范围**：`src/App.tsx`、`src/styles.css`、`src/shell/`；未改数据层/kernel/git/memory/review，未重写 Dock
- **结论**：rail 常驻、五入口、active/aria-current、鼠标 + 键盘、折叠图标栏、关闭面板可重开；Dock/⌘K/Alt/深链/窄窗/Settings 保留。

---

## 1. 设计决策：rail 放在现有 Sidebar 内

bb-97 的措辞是「侧栏 rail」。本实现没有新增独立宽度列，而是在现有 `.sidebar` 内、工作区信息之后加入 `PrimaryRail`：

| 状态 | 表现 |
|---|---|
| Sidebar 展开（1440） | rail 宽约 249px，每项「图标 + 短标签」，顶部「工作台」 |
| Sidebar 折叠（≤960 自动，或 Ctrl/⌘+B / 品牌按钮） | rail 宽约 55px，只留 40px 图标按钮；label 仅 CSS 隐藏，按钮显式 `aria-label` 保留读屏名 |

这样做的原因：

- 不改变 `DockShell` 的宽度预算，不新增第二个面板状态；
- 1440/960/窄窗下 rail 不会与侧栏/主区争抢横向空间，Dock 仍按 P0-1 的 single/侧栏折叠规则；
- 「可折叠为窄图标栏」复用现有 sidebar collapse（`localStorage["deer.sidebarCollapsed"]`），展开状态刷新后保持（会话内足够）。

折叠不是独立于侧栏的第二套状态；没有新增 rail 自己的持久化宽度/面板状态。

## 2. 五个入口与 active

`src/shell/primaryRailData.ts`：

```ts
PRIMARY_RAIL_ENTRIES = [
  { key: "chat",    label: "对话", icon: "◉", title: "对话（Chat）" },
  { key: "tasks",   label: "任务", icon: "☰", title: "任务（Tasks）" },
  { key: "team",    label: "团队", icon: "◈", title: "团队（Team）" },
  { key: "board",   label: "记忆", icon: "▤", title: "记忆（Board）" },
  { key: "mailbox", label: "邮箱", icon: "✉", title: "邮箱（Mailbox）" },
]
```

- `railKeyForActive(activePanelKey, tab)` 优先取现有 Dock 激活面板；不是五入口（runs/context/polls/watchdog/settings）时回退 route tab（runs→tasks）；
- active 项设置 `aria-current="page"`，并加 `.is-active` 样式；
- 不新增 `railActive` state；现有面板/tab 是唯一来源。

## 3. 点击、键盘、重开与聚焦

`src/shell/PrimaryRail.tsx`：

- 点击：`onOpen(key)` → App `openPrimaryPanel` → 复用现有 `openPanel(key)`；
- 键盘：
  - `Tab` 进入按钮；
  - `ArrowDown/ArrowRight`、`ArrowUp/ArrowLeft`、`Home/End` 在 rail 内移动焦点（wrapping）；
  - `Enter` / `Space` 打开当前项；方向键不打开；
- 关闭面板重开：`openPanel` 仍调用 `dockRef.current?.openPanel(key)`；DockShell 对不存在面板执行 `ensurePanel`（t194 既有行为），rail 不复制面板状态。

聚焦（t220 repair 后）：

- Dock 面板容器 `DockPanelBody` 增加 `tabIndex={-1}`；
- rail 打开后在 React 提交后聚焦面板容器；chat 优先 composer `textarea/[contenteditable]`；
- 使用 **generation/token**（ref 自增，无 Date.now nonce）：每次 request 递增 token 并取消旧 timer/递归 timer；
- `pointerdown` / `keydown`（含 ⌘K/Ctrl K、Alt 快捷键）以及 `activePanelKey` 变化时 invalidate，旧 timer 不再抢焦；
- 聚焦前校验：`activePanelKey` 必须仍是目标面板、元素非 inert、有 layout rect、visibility/display 可见；只对当前面板聚焦；
- hook 在组件卸载时清 timer；递归重试上限 40×80ms，成功后立即停止并清空。

实测（真实 Electron，CDP 焦点仿真开启）：

| 操作 | active rail | 焦点所在 panel |
|---|---|---|
| 1440 点击「团队」 | 团队 | `team` |
| 960 点击「记忆」 | 记忆 | `board` |
| 960 键盘 ArrowDown → Enter（从对话到任务） | 任务 | `tasks` |
| rail→立即 Tasks→等待 >2.5s | 任务 | `tasks`（旧 timer 已取消） |
| rail→⌘K/Alt | 对应面板/命令面板 | 不被旧面板抢焦 |

## 4. 保留项

- Dock 标签/拆栏/存档 schema 不变；▦ 面板启动器、⌘K/Ctrl K、Alt+1–6 不变；
- 深链 `#/chat|tasks|team|board|mailbox` 不变；rail 只是调用同一 `openPanel`；
- 窄窗 ≤960 仍由 sidebar 自动折叠 + Dock single；rail 无宽度列，不破坏 P0-1；
- Settings 仍为全高 Modal/独立入口，rail 不替换；
- Sidebar 矮窗口（`max-height: 960px`）隐藏「导航提示」文本，防止 rail 增加高度后 sidebar `overflow:hidden` 截断 footer；操作、rail、Key/成员状态优先保留。
- t220：960×700 手动展开 Sidebar 时 footer 可见（实测 `footer.top=654 / bottom=700 / height=46`，sidebar scrollHeight=clientHeight=700）；短视口 rail 收紧为 179px，仍保留图标+短标签（默认 960 仍自动折叠图标栏；若产品要求 960 默认也显示标签，需单独评审侧栏宽度/布局）。

## 5. 测试与验证

新增 `src/shell/primaryRail.test.tsx`（t220 后 **10 例**）：

1. 五入口 key/label/icon 顺序；
2. active 从现有 panel/tab 派生（chat/board/runs→tasks/context→chat/settings→null）；
3. Arrow/Home/End 索引与 wrap；
4. 服务端渲染含 `aria-label="一级入口"`、五项 label、`aria-current="page"`、`is-active`；
5. 折叠仍保留五项按钮/title/`aria-label`，点击、ArrowLeft/Right、Enter/Space 触发正确 onOpen；
6. 折叠态 SSE 含五项显式 `aria-label`（读屏名），label 文本仍在 DOM；
7. hook：旧 rail timer 在立即切 Tasks 后取消，>2.5s 焦点仍 Tasks；
8. hook：⌘K/Ctrl K、Alt 输入 invalidate，不再补焦旧面板；
9. hook：pointerdown / activePanelKey 变化 invalidate；
10. hook：聚焦成功后停止递归重试。

全量验证（worktree，最终代码）：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **0** |
| `pnpm build` | **0**：js **1,237.45 kB / gzip 340.13**；css 247.63 / gzip 29.95 |
| `pnpm test` | **0**：**64 文件 / 650 用例**（rail 10 例；含既有 deeplink、窄窗、Dock、权限/审批/内核/评审套件） |

> 全量测试曾命中既有 watchdog 5s timing flake（5018ms）；独立/重跑通过，非 rail 改动。

## 6. 截图

真实 Electron + 真实「按钮工厂」workspace DB，1440×900 / 960×700：

| 1440：rail 展开（图标+标签，团队 active） | 960：侧栏折叠为图标 rail（记忆 active） |
|---|---|
| `docs/team/t216-rail-1440-team.png` | `docs/team/t216-rail-960-board.png` |

另：`t216-rail-960-tasks.png` 为 960 下键盘 Arrow+Enter 切换任务后的状态；`t216-rail-1440-team-reopened.png` 为团队面板关闭后从 rail 重开的截图；`t216-rail-960-footer.png` 为 960×700 手动展开 Sidebar 时 footer（Key/成员）完整可见的截图；`t216-rail-footer-metrics.json` 记录 footer top=654/bottom=700、sidebar scrollHeight=clientHeight=700、rail=179、⌘K 后焦点在 palette input。

`t216-rail-metrics.json` 记录三组交互的 title/hash、sidebar/rail 宽度与 class、五入口 label/display、active 与 focus panel；1440 labelDisplay=`block` 且 rail≈249，960 labelDisplay=`none`、rail≈55。

## 7. 风险与回滚

- 风险：rail 占用 sidebar 垂直空间；矮窗口隐藏导航提示（非功能入口）。侧栏仍可折叠，Dock 宽度不受影响。
- 风险：rail 点击始终通过现有 `openPanel`，因此 Settings dirty guard/面板菜单关闭等既有行为一致；不新增绕过路径。
- 回滚：revert 本 PR 单提交；无数据/schema 改动；面板状态仍由既有 Dock store 持久化，删除 rail 不影响深链/Dock。

## 8. 改动文件

```text
src/shell/PrimaryRail.tsx        五入口 rail + usePrimaryRailFocus（generation/token、取消 timer、aria-label）
src/shell/primaryRailData.ts     entry 常量、active 派生、焦点索引纯函数
src/shell/primaryRail.test.tsx   10 例 rail/焦点取消单测
src/shell/dock/DockShell.tsx     面板容器 tabIndex=-1（供 rail 打开后聚焦）
src/App.tsx                      挂载 rail、active 派生、tryFocus 可见性/active 校验、open/reopen
src/styles.css                   rail 展开/折叠样式、矮窗口提示隐藏
docs/team/primary-rail.md
docs/team/t216-rail-{1440-team,1440-team-reopened,960-board,960-tasks,960-footer}.png
docs/team/t216-rail-metrics.json
docs/team/t216-rail-footer-metrics.json
```
