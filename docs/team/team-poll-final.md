# 团队 Poll 最终集成报告（t140）

- **任务**：t140 — 集成验收：团队 Poll
- **模型路由**：`deepseek-official/deepseek-flash`（成员 aria）
- **最终代码基线**：`d51b18999786e3a8a11ede505fb294ec8a79518c`（`feat(poll): add team polls with decisions and dock UI (t136) (#8)`）
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/8（**MERGED**，head `67cc1cc`，squash merge）
- **设计/实现基线**：`DESIGN.md` §14、`docs/team/team-poll.md`
- **质量门**：t136 实现 → t152 repair → **t153 review-round-2 pass**（36 文件 / 463 用例）
- **日期**：2026-11-10（Asia/Shanghai）
- **结论**：**pass** — Poll 创建/投票/结果/decision 已合入 main，UI/IPC/审计/权限链路可用；三命令全绿，既有功能无回归。

> 说明：t137（watchdog/cost 设计审查）首轮 needs_revision，已由 t141 requirements 修订 pass；它与 Poll 是独立系统，不是 Poll 的实现门禁。Poll 的最终质量门为 t153。

---

## 1. 质量门与集成动作

- t136 交付 polls 表、服务/IPC、PollPanel、decision 落库与审计；t152 修复 F1–F6（workspace/actor/voter 可信边界、decision 走 MemoryRuntime、匿名 ballot、交互测试、canClose、ballot UNIQUE/改票）。
- t153 独立复审 **pass**：36 文件 / 463 用例；PR #8 OPEN/MERGEABLE/CLEAN、worktree clean。
- 按 Captain 指示执行 `gh pr merge 8 --squash`：main `5a99385 → d51b189`，PR #8 MERGED；随后 `pnpm branch:remove t136-team-poll` 清理 worktree/branch。
- 本次集成未改生产代码；仅修正 `docs/team/team-poll.md` 的 t152 decision 说明并新增本报告。
- `branches/t144-watchdog-cost` 仍在进行，属并行任务，不属 Poll。

---

## 2. 已合入的 Poll 全链路

| 层 | 文件 | 内容 |
|---|---|---|
| 类型/纯规则 | `src/shared/poll.ts` | scope/mode/threshold/status、normalize、selection、evaluate、expiry、decision summary |
| 持久化 | `src/kernel/store.ts` | `polls`/`poll_options`/`poll_ballots`/`poll_decisions` additive 表、CRUD、事件、decision 黑板条目 |
| 服务 | `src/kernel/service.ts` | list/get/create/cast/close、可信 user actor、workspace 校验、匿名 sanitize、MemoryRuntime decision 写入 |
| IPC | `src/shared/ipc.ts`、`electron/main.ts`、`electron/preload.ts` | `listPolls`/`getPoll`/`createPoll`/`castPoll`/`closePoll` + workspace 参数 |
| UI | `src/shell/PollPanel.tsx` | Dock polls 面板（默认关闭）、创建 Modal、投票/改票、结果/quorum/截止、decision |
| 集成入口 | `src/App.tsx`、`CommandPalette.tsx`、`panelRegistry.ts`、`MemoryWorkbench.tsx` | 侧栏/命令面板/任务详情/黑板卡片「发起投票」预填 |
| 样式 | `src/styles.css` | 结果条/quorum/窄窗单列/focus-visible |
| 测试 | `src/shared/poll.test.ts`、`src/kernel/poll.test.ts`、`pollService.test.ts`、`src/shell/PollPanel.test.tsx` | 规则 4 + store 8 + service 4 + UI 8 = 24 条 |

---

## 3. 业务规则与可追溯性

### 3.1 创建/投票/截止

- 创建即 `open`（P0）；校验标题、2–50 候选、候选长度、single/multi、`maxSelections`、阈值、quorum、未来截止。
- `cast` 校验 poll open 且未过期、选项属于 poll、single ≤1、multi ≤maxSelections、不允许弃权时非空。
- `poll_ballots` 唯一 `(poll_id,voter_id)`；重复提交改票，不新增 ballot，`revision+1`；相同选择幂等。
- `closed/expired` 拒绝投票；close 幂等返回同一 decision。
- 关闭权限：服务端 `createdBy="user"` + actor 固定 `user`；非 user 创建者无 close。
- 可信边界：poll get/cast/close 均带 workspaceId；Service 校验 poll.workspaceId；human voter 固定 `user`，agent voter 校验同 workspace；客户端不能覆盖 createdBy/actor。

### 3.2 结果与 decision

- `gt`：票数 > thresholdValue；`majority`：> 总 ballot 50%；`percent`：≥ thresholdValue%。
- quorum 未达到：`insufficientQuorum=true`、`adoptedOptionIds=[]`，写 `poll_decisions` 审计行但不写黑板 decision 条目。
- 有采纳项：close 写 `poll_decisions`，并通过 `MemoryRuntime.postBoard(HUMAN)` 写入 `decisions` 黑板（source=user、sourceRef=null、domain/FTS/contentHash 完整），回填 `board_entry_id`/`decision_ref`。
- 审计：`poll.created`/`poll.voted`/`poll.closed`/`poll.decided`/`poll.expired`；`poll.voted` 只记录 voter 类型/选择数/revision，不写候选正文。
- 匿名：API list/get/cast/close 仅返回当前 viewer 的 ballot；审计保留 voter actor，UI 不展示身份列表。

### 3.3 UI / 可访问性 / 窄窗

- Dock `polls` 面板默认关闭，侧栏/命令面板入口；创建 Modal 复用 Esc/焦点陷阱/aria-modal；表单 Ctrl/⌘+Enter 提交。
- 原生 radio/checkbox + fieldset；结果 `role=list`、票数条 `role=progressbar`/aria-valuenow；quorum/阈值线/截止倒计时。
- 投票/改票/关闭/错误 `role=status`/`aria-live` + toast；空/错误态有文案/重试/创建。
- 900px 窄窗单列；PollPanel 8 条交互测试覆盖创建/Ctrl+Enter/cast/改票/close/decision/错误/非 user close/匿名/窄窗 CSS。
- 真机 Electron 键盘/窄窗仍为 P1 manual（t153 记录，不阻塞）。

---

## 4. 验证

### 4.1 三命令（main `d51b189`）

```text
$ pnpm typecheck
exit 0

$ pnpm build
exit 0
vite: 401 modules
dist/assets/index-*.js   1,174.82 kB / gzip 322.50 kB
dist/assets/index-*.css    222.60 kB / gzip 25.84 kB
electron main.cjs         1.3 MB（既有 chunk 警告，非阻断）
preload.cjs               8.0 kB

$ pnpm test
exit 0
69 files / 911 tests passed  # 含 branches/t144-watchdog-cost worktree 副本
```

主工作树单独运行（不把 t144 副本计入）：

```text
pnpm vitest run --exclude "branches/**"
→ 36 files / 463 tests passed
```

### 4.2 Poll 测试分布（main）

| 文件 | 用例 | 覆盖 |
|---|---:|---|
| `src/shared/poll.test.ts` | 4 | normalize/单选多选/弃权/gt/majority/percent/quorum/截止/无采纳 summary |
| `src/kernel/poll.test.ts` | 8 | 建表/创建/非法选择/截止/close 拒绝/改票/双连接 UNIQUE/>3 采纳 decision/quorum/权限 |
| `src/kernel/pollService.test.ts` | 4 | workspace 与 actor/voter 可信边界、agent 校验、MemoryRuntime decision、匿名 ballot |
| `src/shell/PollPanel.test.tsx` | 8 | 创建 Ctrl+Enter/cast/改票/close/decision/错误/非 user close/匿名/窄窗 |
| **合计** | **24** | — |

既有 kernel/Git/memory/UI/画布/交互测试全部保留通过；main-only 36/463。

---

## 5. 已知边界 / 后续（不阻塞）

1. **P0 创建即 open**：draft + 人工 `poll.open` 留 P1。
2. **majority/percent 分母**：以 ballot 数计，弃权也计入 quorum/分母；无加权票/角色票。
3. **quorum 不足**：保留 `poll_decisions` 审计行但无采纳项、无黑板 decision；若产品要求完全不落 decision 行，需 P1 调整。
4. **本地单用户**：投票人 `user` + 同 workspace agent；跨工作区/角色权重/导出审计报告不在本 PR。
5. **真机 Electron 键盘/窄窗**：无头环境未执行完整手工走查；SSR/组件交互/CSS 断点为自动化证据，发布前补测。
6. **测试发现范围**：根目录 `pnpm test` 会纳入并行 worktree 副本（t144）；main-only 36/463 为准，建议后续固定 Vitest exclude。
7. **构建 chunk 警告**：js 1,174.82 kB >500 kB，为既有问题；建议后续 code-split。

---

## 6. 回滚

- 代码：revert merge commit `d51b189`（PR #8）；移除 PollPanel/命令入口/App 入口/IPC/preload/main/service/store Poll 路径。
- 数据：`polls`/`poll_options`/`poll_ballots`/`poll_decisions` 为 additive `CREATE TABLE IF NOT EXISTS`；回滚代码不删除数据，旧 Store 不再读取；如需彻底清理，人工删除四表（确认无审计需求）。
- UI：`polls` panel 默认关闭；移除 panel key/命令项即可恢复旧布局。
- 无 kernel `user_version`/memory schema 变更；不影响 Git/内核/记忆核心。

---

## 7. 最终验收结论

| 验收项 | 结论 | 证据 |
|---|---|---|
| t153 最终 pass，PR #8 已合入 main | 通过 | t153 verdict=pass；PR #8 MERGED；main `d51b189`；t136→t152→t153 链完整 |
| Poll 全链路可用 | 通过 | §2–§3：四表、5 IPC、Service 可信边界、single/multi/阈值/quorum/截止/close decision、MemoryRuntime 黑板、匿名/审计、PollPanel 24 测试 |
| typecheck / build / test | 通过 | exit 0/0/0；401 modules；main-only 36/463；根 `pnpm test` 69/911（含 t144 副本） |
| `docs/team/team-poll-final.md` | 通过 | 本文件 |

**结论：团队 Poll 最终集成通过。** 真机键盘/窄窗为 P1 manual，发布前补测；不再重复本 PR 的核心实现。
