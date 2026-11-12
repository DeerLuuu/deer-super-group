# MergeQueue Dock 面板 · 最终集成验收（t312）

- **任务**：t312 — 集成验收 P1-1 MergeQueue Dock 面板
- **集成人**：sol
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/46（**MERGED**；head `d8b8dcc`；squash merge `7ccc0e6`）
- **基线**：main `97dc005`；合并后 main `7ccc0e6`
- **结论**：**PASS**。MergeQueue 从常驻 Modal 改为 Dock 面板（确认合并不变）；入口/恢复/失败/空/冲突/三档/Modal 焦点均落地；merge gate/权限/状态机/数据源未改；PR 已合并、worktree/branch 清理。

---

## 0. 验收摘要

| 验收项 | 结论 |
|---|---|
| 面板/入口/Modal/操作可追溯 | **PASS**：t309 实现 → t313/t315/t317 修复 → t318 PASS → t311 review pass |
| 独立三命令 | **PASS**：typecheck 0；build 0（441 modules）；test extended 111 文件/828 用例 |
| merge gate/权限/数据源未改，现有入口无回归 | **PASS**：App 顶层单一 `useMergeQueue`；确认后才 mergeStart；approve/waive/gate 未改 |
| 1440/960/480/键盘/aria | **PASS**：真实 Electron 截图 + Modal/listbox/tab 测试 |
| 最终文档 | **PASS**：本文件 |
| PR/合并/worktree | **PASS**：PR #46 MERGED `7ccc0e6`；worktree/local+remote branch 已清理 |

---

## 1. 追溯链

| 阶段 | 任务 | 结论 |
|---|---|---|
| 实现 | t309 | 新增 `MergeQueuePanel` Dock 面板；确认 Modal；旧 `MergeQueueModal` 删除 |
| 修复 1 | t313 | 失败态/loading/error、真实 1440/960/480 截图、close→reopen、冲突/等待统计 |
| 修复 2 | t315 | 恢复点击测试、inline 重试、冲突态 960/480 截图 |
| 修复 3 | t317 | 真实 App 级关闭→重开测试（sidebar/Dock X/launcher） |
| 复验 | t318 | PASS；N1–N5 非阻塞 |
| 评审 | t311 | pass；无 blocker；N1–N5 记录 |
| 集成 | t312 | 本文件；合并/清理 |

---

## 2. 面板与操作

- 新增 Dock panel `mergeQueue`（`onlyWhenVisible`、默认关闭）：摘要（共/可合并/等待/进行中/stale/冲突）、任务列表（provider/PR/branch/位置/checks/state/conflict/lastError）、刷新、批准、豁免、查看任务；`合并…` 只打开确认 Modal。
- **确认 Modal**：显示任务、分支、provider、checks、位置；取消不发请求；`确认合并` 才调用既有 `mergeStart(taskId)`；Esc/focus/Tab 复用统一 `Modal` 原语。
- **入口**：Sidebar「合并队列」、面板启动器、Team/Workflow/NeedsMe、TaskVcs「查看合并队列」、Command Palette 既有动作、`#/merge` / `?merge=1`；关闭后从 launcher/sidebar 恢复。
- **App 接线**：`openPanel("mergeQueue")` 直接 setMergeQueueOpen+reload；`onPanelClose` 复位；Dock activePanelKey 不作为唯一打开状态。

---

## 3. Gate / 数据源不变

- App 顶层仅一个 `useMergeQueue`，Panel 接收 items/stale/error/loading props，未新增第二数据源。
- `MergeQueuePanel` 只调用既有 `window.deer.mergeApprove/mergeWaiveChecks/mergeStart`；无新增 IPC、权限、gate、状态机或 DB 写入。
- 旧常驻 `MergeQueueModal` 已从 `GitPanels.tsx`/App 删除；`TaskVcsPanel` 只新增只读「查看合并队列」入口。
- merge queue 服务端 gate（review/approval/checks）未改；确认前不发 mergeStart。

---

## 4. 1440 / 960 / 480 / 键盘

真实 Electron 截图：

- `t313-1440-list.png`：1440 列表/摘要/冲突行。
- `t313-1440-modal.png`：确认合并 Modal（focus/Tab）。
- `t313-1440-empty.png`：空队列。
- `t313-960-list.png`：≤960 单列。
- `t313-480-list.png`：480 单列，无横向页面溢出。
- `t315-960-conflict.png`、`t315-480-conflict.png`：冲突态；480 冲突行可通过列表纵向滚动查看。

- Modal：Esc 关闭、初始焦点、Tab 陷阱、回焦 trigger；列表摘要/状态有文本，不只靠颜色。
- 键盘：面板按钮原生可聚焦；确认 Modal 取消/确认顺序；源码测试覆盖 focus/Tab；N2 480 冲突行初始视口外需滚动，非裁切。

---

## 5. 验证命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：441 modules；js 1,320.16 kB / gzip 365.15；css 266.21 / gzip 33.19；electron main 1.6MB、preload 12.6kB |
| `pnpm test`（裸） | 既有 5 个 5s timeout（service/watchdog） |
| `pnpm test -- --testTimeout=20000 --maxWorkers=2` | **exit 0**：**111 文件 / 828 用例** |

> 裸跑 5s timeout 为既有并发 flake；扩展全量通过（t318/t311 同记录）。

---

## 6. 非阻塞项

| ID | 内容 |
|---|---|
| N1 medium | 真实 App 恢复测试 mock DockShell；Team 入口为 source contract |
| N2 low | 480 冲突行在初始视口外，可滚动查看 |
| N3 low | 失败态用组件/hook 测试，未伪造 IPC 失败截图（Captain 已接受） |
| N4 low | 旧 EntryHarness 测试仍保留 |
| N5 low | 裸 `pnpm test` 既有 5s flake |

---

## 7. 合并 / 清理

- PR #46 **squash merged** → main `7ccc0e6`。
- worktree `branches/t309-merge-queue-panel` 删除。
- local/remote `feature/t309-merge-queue-panel` 删除。
- `git worktree list` 仅主 worktree；集成报告见本文件。

---

## 8. 最终 AC

| AC | 证据 | 结论 |
|---|---|---|
| 面板/入口/Modal/操作可追溯 | t309/t313/t315/t317/t318/t311 + 本文件 | PASS |
| 三命令 | typecheck 0 / build 0 / extended 111/828 | PASS |
| merge gate/权限/数据源未改，现有入口无回归 | §3；全量套件 | PASS |
| 1440/960/480/键盘/aria | §4 截图 + Modal/listbox/tab 测试 | PASS |
| 最终文档 | 本文件 | PASS |
| PR/合并/worktree | PR #46 MERGED 7ccc0e6；worktree/branch 清理 | PASS |

**集成结论：PASS，可交付。**
