# 对话滚动与 turn 刻度条 G11 · 最终集成验收（t446）

- **任务**：t446 — 最终集成 G11：对话初始贴底 / 加载更早 / turn 刻度条
- **集成人**：sol
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/64（**MERGED**；head `fb5adf1`；squash merge `287b1bb`）
- **基线**：main `fea1c74`；合并后 main `287b1bb`
- **结论**：**PASS**。初始/切换/发送贴底、上滚不拉底、真实服务端分页加载更早（含 hasMore/已到最早）、Settings 即时生效、turn 刻度条/键盘/三档/性能证据全部落地；PR 已合并、worktree/branch 清理。

---

## 0. 验收摘要

| 验收项 | 结论 |
|---|---|
| 初始/加载/设置/刻度可追溯 | **PASS**：t443 实现 → t466 性能 → t472 PASS → t473/t475/t477 修复 → t478 review pass |
| 独立三命令 | **PASS**：typecheck 0；build 0（458 modules）；clean main serial 150 文件/1012 |
| 三档/成员切换/性能无回归 | **PASS**：1440/960/480 截图；480 rail 隐藏；真实 100 turns + 300 turn 组件夹具口径；全量套件含 chat-agent-switch |
| 最终文档 + PR/合并/worktree | **PASS**：本文件；PR #64 MERGED `287b1bb`；本任务 worktree/branch 清理 |

---

## 1. 追溯链

| 阶段 | 任务/产物 | 结论 |
|---|---|---|
| 实现 | t443 PR #64 | stickToBottom、加载更早、chatHistoryLimit、turn rail |
| 性能/细节 | t466 | 真实 100 turns + 300 turn 组件夹具；上滚跟随/rail hover/键盘 |
| 合同修正复验 | t472 | PASS；明确真实 IPC 100 turns 与 300 fixture 口径 |
| 修复 | t473 | server-only append、rail 0/100%、中文状态、文档 |
| 修复 | t475 | pending token/显式 loadedCount、finally 清 ref、空页/reject 行为 |
| 修复 | t477 | 真实分页 append：`chat:list` before cursor、真实 AppService+SQLite 300 条 |
| 复审 | t478 `chat-scroll-turns-review-4.md` | pass；无 blocker |
| 集成 | t446（本文件） | PASS、合并、清理 |

---

## 2. 行为验收

- **初始贴底**：打开/切换成员/historyLimit 变化/发送消息滚到底；`scrollTop + clientHeight ≈ scrollHeight`。
- **上滚不拉底**：上滚 >96px 取消 follow；ChatLiveTail 仅在近底跟随；流式 token 到达不改变用户视口（t466 CDP/store delta）。
- **加载更早**：
  - 顶部显示「加载更早」；使用真实 `chat:list` 分页（`limit/before`，`(createdAt,id)` 游标）；
  - 前缀插入 messages/turns 按 id 去重，visible 按实际插入数增长；
  - 高度锚点补偿保持首可见 turn；空页/hasMore=false 显示「已到最早」；reject/空页清 preserve；后续发送仍贴底。
- **Settings**：`layout.chatHistoryLimit` 20/40/80/全部（0），默认 40；保存后 ChatView 同实例即时生效。
- **turn rail**：按真实 user turn 内容位置归一化 0/100%；title/aria 含首行/时间/中文状态；点击/键盘跳转并高亮；≤480 隐藏；切换 agent 重置。
- **成员切换**：per-agent messages/turns/scroll 隔离；Rail 不串线；全量 chat-agent-switch 测试通过。

---

## 3. 三档 / 性能 / 真实口径

- 真实 Electron 截图：`t443-chat-1440.png`、`t443-chat-960.png`、`t443-chat-480.png`、`t443-top-1440.png`（顶部/加载更早）；`t466-large-1440/960`、`t466-rail-hover/keyboard`、`t466-stream-up`。
- 三档无横向；480 rail `display:none`；1440/960 rail 可点击/键盘。
- **修正口径**：真实 Electron/WS 受 `CHAT_TURNS_MESSAGE_LIMIT=200` 消息上限，约 100 turns；300 turns/600 messages 为同组件夹具（非真实 Chromium），已在 `chat-scroll-turns-performance.md` 明确，不冒充真实。
- 真实 100 turns：40 rows/20 ticks/852 nodes；100 scroll 6.6ms；全量 100 rows/50 ticks/1330 nodes；300 fixture render 167ms/60 scroll 3ms/5148 nodes（阈值 2500ms/7000）。
- 加载更早真实 AppService+SQLite 300 条测试：初始 100，点击后 rows +10 user=20 messages、rail 增加、preserve=0、listChat 带 before；空/ reject/发送贴底覆盖。

---

## 4. 范围 / 回归

- PR 改动：`chat:list` **可选参数** `ChatMessagePageOptions`（limit/before）经 IPC/preload/main/service，新增真实分页方法；无新通道、无 schema/权限/gate/依赖变更。
- `ChatView`/App 滚动与分页；Settings historyLimit；turn rail；测试/docs/截图。
- 全量 150 文件/1012 用例（含 chat-agent-switch、G6/G7/G8/G9/G10、Git/G1、mailbox 等）通过；三档/成员切换无回归。
- 无 production service 破坏；无外部模型依赖（真实模型 token 未伪造，store/service 路径验证）。

---

## 5. 验证命令

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0**：458 modules；index 340.12 kB / gzip 101.56；CSS 137.28 / gzip 23.42；main 1.6MB/preload 13.5 |
| `pnpm test`（PR worktree，2 workers） | **exit 0**：150 文件/1012 用例 |
| `pnpm test -- --testTimeout=20000 --maxWorkers=1`（干净 detached main） | **exit 0**：150 文件/1012 用例 |

> 主工作区有 stale `branches/**` 目录，默认 Vitest 可能扫入并行测试；集成使用干净 detached main checkout。主工作区 `.gitignore`/`.npmrc`/`.electron-runtime` 等本地内容为其他任务，本任务未提交。

---

## 6. 非阻塞项

| ID | 内容 |
|---|---|
| N1 low | 消息页 20 条与 turn 页 20 turns 的游标独立，极端边界可能需多点一次「加载更早」 |
| N2 low | `loadChat` 500 条上限（既有）；更早加载按 20/页 |
| N3 low | 480 无 300 大历史；真实外部模型 token 环境不可用，未伪造；store/service 路径覆盖 |
| N4 low | helper 防御分支/既有 5s 并发 flake |
| N5 low | 主工作区 stale branches 污染默认 test；干净 checkout 全绿 |

---

## 7. 合并 / 清理

- PR #64 **squash merged** → main `287b1bb`。
- worktree `branches/t443-chat-scroll-turns` 删除。
- local/remote `feature/t443-chat-scroll-turns` 删除。
- 集成临时 clean checkout 删除。
- `git worktree list` 仅主 worktree；本任务清理完成。

---

## 8. 最终 AC

| AC | 证据 | 结论 |
|---|---|---|
| 初始/加载/设置/刻度可追溯 | t443/t466/t472/t473/t475/t477/t478 + §2–4 | PASS |
| 独立三命令 | typecheck 0 / build 0 / clean 150/1012 | PASS |
| 三档/成员切换/性能无回归 | 三档截图/rail、真实 100 turns + 300 fixture 口径、全量套件 | PASS |
| 最终文档 + PR/合并/worktree | 本文件；PR #64 MERGED `287b1bb`；cleanup | PASS |

**集成结论：PASS，可交付。**
