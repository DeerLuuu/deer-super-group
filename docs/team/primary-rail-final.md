# 一级入口 rail 最终集成验收（t219）

- **任务**：t219 — 集成验收 P0-2：常驻一级入口 rail
- **实现链**：t216 实现 → t217 独立验证 → t218 评审 → t220 repair-round-2 → t221 review pass
- **PR**：[#35](https://github.com/DeerLuuu/deer-super-group/pull/35) — **MERGED（squash）**
- **合并提交**：`6087ee0`（2026-11-12）
- **实现文档**：`docs/team/primary-rail.md`
- **验证/评审**：`primary-rail-verification.md`、`primary-rail-review.md`、`primary-rail-review-2.md`
- **结论**：**PASS，可交付**；PR 已合并，t216 worktree/branch 已清理。

## 1. 结论

P0-2 一级入口 rail 已完成最终集成验收：

- **五入口常驻**：对话 / 任务 / 团队 / 记忆 / 邮箱，图标 + 短标签；不新增第二套 panel state，复用现有 `openPanel`/Dock 容器。
- **active 一致**：由现有 `activePanelKey`/route tab 派生，`aria-current="page"` + `is-active`；关闭面板后点击 rail 经 `ensurePanel` 重开。
- **键盘完整**：点击、Enter/Space；ArrowUp/Down/Left/Right/Home/End 移动并 wrap；打开后聚焦 panel 容器（chat 优先 composer），但用户 pointerdown/⌘K/Alt/active 变化会取消待执行聚焦，不抢焦。
- **折叠**：展开 249px，复用 `sidebarCollapsed` 折叠为 55px 图标 rail；Ctrl/⌘+B 持久化；矮窗口收紧 179px 并保住 footer。
- **无回归**：Dock tabs/split、▦、⌘K、Alt+1–6、深链、Settings、≤960 single/Team within 均保留；1440/960 截图与 metrics 一致。
- **范围干净**：只改 `src/App.tsx`、`src/shell/PrimaryRail.tsx`、`primaryRailData.ts`、`DockShell.tsx`、`styles.css`、测试、docs/截图；无 `src/kernel/`、data、git、memory、review 变更，未重写 Dock。

## 2. 需求→实现→验证追溯

| 验收项 | 实现落点 | 验证证据 |
|---|---|---|
| 五入口（chat/tasks/team/board/mailbox） | `primaryRailData.ts`；`PrimaryRail.tsx` | `primaryRail.test.tsx` 10 例；SSR label 断言 |
| 图标 + 短标签；折叠仍可读 | PrimaryRail CSS；label 保留 DOM，CSS 隐藏 | t220 F2 aria-label 五项 + 折叠 SSR |
| active 从 activePanel/route 派生 | `activeEntry()` + `aria-current` | t216/t217 代码/截图；t221 review |
| 点击/Enter/Space 打开 | `onActivate` → `openPanel` | primaryRail 10 例；t217 CDP |
| Arrow/Home/End 焦点 wrap | `onKeyDown` roving | t220 F4 补 ArrowLeft/Right/Space |
| 关闭面板后重开 | `openPanel`/`ensurePanel` | t217 关闭重开；t220 F1 |
| 打开后 focusPanel（chat composer） | `usePrimaryRailFocus` + App `focusPanelNow` | 10 例：立即切 Tasks、>2.5s、pointerdown/⌘K/Alt、成功停止 |
| 展开 249 / 折叠 55 | 复用 `sidebarCollapsed` | 1440/960 截图、`t216-rail-metrics.json` |
| 矮窗口 footer 可见 | CSS 收紧 179px | 960×700 footer metrics/screenshot；top654/bottom700/height46 |
| Dock/⌘K/Alt/深链/Settings 无回归 | 未改 Dock/route 逻辑 | `narrowWindow` 28、`DockShell` 3、deeplink 17、permission 44、approval 9/2、review 17 |
| 无数据/kernel 变更 | diff 无相关文件 | `git diff --name-only` 14 文件（含 docs/截图） |
| 测试/三命令 | — | 64 files / 650 tests；typecheck/build 0 |

## 3. 独立验证（合并后 main）

工作目录：`S:\DeerSuperGroup`（main `6087ee0`；worktree 仅 main）

```text
pnpm typecheck   # exit 0
pnpm build       # exit 0；413 modules
                 # js 1,237.45 kB / gzip 340.13
                 # css 247.63 kB / gzip 29.95
                 # electron main 1.5 MB / preload 11.7 KB
pnpm test        # exit 0；64 files / 650 tests
```

> 说明：PR worktree 与 main 首轮均出现既有 `openai`/`watchdog` 5s timing flake（环境负载）；隔离复跑 24/24 通过，随后全量复跑 **64/650 全绿**。该 flake 与 rail 无因果关系，保留为 P1 测试稳定性项。

## 4. 1440/960 与无回归证据

1. **1440 展开**：`t216-rail-1440-team.png`；rail 249px，Team 面板打开，五入口标签完整。
2. **960 折叠**：`t216-rail-960-board.png`；rail 55px 图标栏，记忆面板可打开，无横向裁切。
3. **960 键盘任务**：`t216-rail-960-tasks.png`；Arrow+Enter 聚焦 Tasks panel。
4. **团队重开**：`t216-rail-1440-team-reopened.png`；关闭后点击 rail 重新打开。
5. **960×700 footer**：`t216-rail-960-footer.png` + `t216-rail-footer-metrics.json`；footer 可见，sidebar 无滚动溢出。
6. **metrics**：`t216-rail-metrics.json` 记录 1440/960 rail 宽度、panel 矩形、无重叠/裁切。
7. **回归**：Dock tabs/split、▦ 面板启动器、⌘K、Alt+1–6、深链、Settings、≤960 single/Team within 均保留；narrowWindow 28 例、DockShell 3 例、deeplink 17 例全绿。
8. **焦点防抢**：t220 F1 用 generation/timer registry；pointerdown/keydown(⌘K/Alt)/activePanel 变化 invalidate；聚焦前校验 active/inert/rect/visibility；成功停止；卸载清理。

## 5. 范围/兼容性检查

- PR #35 合并 17 文件：`App.tsx`、`src/shell/PrimaryRail.tsx`、`primaryRailData.ts`、`dock/DockShell.tsx`、`styles.css`、`primaryRail.test.tsx`、docs/截图/metrics。
- **无** `src/kernel/`、`src/git/`、`src/memory/`、`src/review/`、`electron/` 数据或权限/调度语义改动；未新增第二套 panel state。
- rail 复用现有 `sidebarCollapsed`/`openPanel`/Dock，不重写 Dock；深链/Alt/⌘K/设置入口不变。
- 合并前 PR #35 OPEN/MERGEABLE/CLEAN，head `665f28a`（含 t217/t218/t221 报告）；合并后 main `6087ee0`；t216 worktree 已移除，branch 已删除。
- 当前 main 有 4 个与 t219 无关的未跟踪 docs（dock-max-groups、narrow-window 系列，属其他任务）；t219 未删除/修改它们，交付路径仅 rail 文档与代码。`git status` 因此非空，但 t219 自身无未提交改动。

## 6. 遗留项（P1/低优先，不阻塞）

1. **测试稳定性**：openai/watchdog 偶发 5s timeout；建议提高该用例 timeout 或拆分 fake clock。
2. **真实 Electron 冒烟**：rail→立即切换/⌘K/Alt 的焦点取消有 Harness 单测，但无新增真实 Electron 截图；发布前建议补 CDP 冒烟（t221 N1）。
3. **960 默认形态**：默认 960 仍是 55px 图标栏；若产品要求默认图标+短标签，需要另评审侧栏宽度/布局（t220 F3）。
4. **关闭面板 active 保留**：t217 N4 低优先；当前 active 仍按 activePanel 派生，关闭后无面板但入口保留高亮，后续可定义“无活动面板”态。
5. **测试覆盖**：ArrowLeft/Right/Space 已在 t220 补测；更复杂的触摸/指针组合仍未覆盖。

## 7. 合并/清理状态

| 项 | 状态 |
|----|------|
| PR #35 | MERGED（squash） |
| 实现 head / 文档 head | `e3fcc1e` / `665f28a` |
| merge commit | `6087ee0` |
| main | `6087ee0`（+ 本报告提交） |
| t216 worktree | 已移除（`pnpm branch:remove t216-primary-rail`） |
| t216 branch | 已删除 |
| 当前 worktree | 仅 `S:\DeerSuperGroup` main |
| 最终三命令 | typecheck 0 / build 0 / test 64 files/650 |

**最终结论：PASS；五入口 rail、active、键盘、折叠、关闭重开与 1440/960 回归均已完成集成。残余均为 P1 测试稳定性/真机冒烟项，不阻塞交付。**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
