# 记忆系统核心集成报告（t101）

- **任务**：t101 — 集成验收：记忆系统核心
- **模型路由**：`deepseek-official/deepseek-flash`（成员 aria）
- **最终代码基线（PR #3 merge）**：`563a35f47ffa80494cdf65f404cd45443a3c6296`（`Merge pull request #3 from DeerLuuu/feature/t99-memory-core`）
- **PR**：https://github.com/DeerLuuu/deer-super-group/pull/3（**MERGED**，head `51aee59`，merge commit `563a35f`）
- **设计基线**：`docs/team/memory-system-design.md`（t74 + t86 修订，t89 pass）
- **实现记录**：`docs/team/memory-implementation.md`
- **日期**：2026-11-10（Asia/Shanghai）
- **结论**：**pass** — 记忆核心已合入 main，schema/迁移、FTS/排序、TTL/治理、隐私与审计可用；三命令全绿。产品级 AppService/IPC/tools/UI 接入仍按设计与 t99 边界留给后续任务。

---

## 1. 质量门与前置条件

- t99 记忆核心实现完成后，t100 首轮 review 判定 **needs_revision**（12 项，含 provenance 回填 blocker、context budget high 等）。
- 经 `t105` → `t109` → `t115` → `t119` 修复，`t120` 最终复审 **pass**：sourceRef v4 解析优先级、contextBudget/working、逐 workspace sweep、entry_snapshot 快照、隐私与测试均通过。
- PR #3 已于 `2026-11-09T21:46:57Z` 合并；t101 依赖 `t120`。本报告将 t120 作为最终质量门；t100 的历史 needs_revision 保留在团队记录中，不代表当前 final code 状态。
- 合并后代码基线为 `563a35f`；本次集成未修改 `src/memory/` 代码，本报告作为 `docs/team/` 集成记录提交。

---

## 2. 交付与范围

### 2.1 已合入 main 的交付

| 区域 | 文件 | 内容 |
|---|---|---|
| 类型/Clock | `src/memory/types.ts`、`clock.ts` | 记忆 DTO、配置、错误、SystemClock/FixedClock |
| 索引 | `src/memory/indexing.ts` | board/memo/summary → FTS document |
| 检索 | `src/memory/retrieval.ts` | FTS/LIKE、min-max relevance、六因子评分、去重/citations、预算 |
| 存储/迁移 | `src/memory/store.ts` | additive schema、backup/rollback、CRUD、生命周期、FTS、snapshot、sweep |
| 服务边界 | `src/memory/service.ts` | actor 推断、human-only 治理、owner 过滤、审计拒绝 |
| 上下文 | `src/memory/context.ts` | 三层上下文、预算/降级、untrusted 头、citation |
| 测试 | `src/memory/*.test.ts` | store/retrieval/privacy/context/repair 共 5 文件 40 用例 |
| 实现记录 | `docs/team/memory-implementation.md` | 实现/偏差/验证/回滚 |

### 2.2 明确不在本集成范围

- `AppService` 初始化 `MemoryStore`、定时 sweep、Run 终态钩子。
- IPC/preload/main、`tools.ts` 记忆工具、`App.tsx`/MemoryView UI。
- P1 仓库文档索引、归档恢复、归档编辑器/ARIA；P0 仅做归档查看/筛选。
- 以上均为 t99 设计/实现记录中声明的后续集成项，不影响本 PR 的“记忆核心可独立测试与合入”。

---

## 3. 验证结果

### 3.1 三命令（最终 main）

```text
$ pnpm typecheck
exit 0

$ pnpm build
exit 0
vite: 392 modules
dist/assets/index-*.js   1,072.63 kB / gzip 294.96 kB
dist/assets/index-*.css    198.12 kB / gzip 21.98 kB
electron main.cjs        1,008.3 kB
（>500 kB chunk 为既有 Vite 警告，非阻断）

$ pnpm test
exit 0
98 files / 1,314 tests passed
```

> 说明：直接运行 `pnpm test` 会因仓库现有 Vitest 配置把 `branches/**` 下的并发 worktree 测试一并发现（t69/t96/t99 副本），所以显示 98 文件/1314 条。为避免把 worktree 副本计入 main，本报告额外运行：
>
> ```text
> pnpm vitest run --exclude "branches/**"   # 26 files / 329 tests passed
> pnpm vitest run src/memory --exclude "branches/**"  # 5 files / 40 tests passed
> ```
>
> 结论不变：主工作树 26 文件/329 条全绿，其中记忆核心 5 文件/40 条。`pnpm test` 命令本身 exit 0。

### 3.2 记忆核心测试分布（main）

| 文件 | 用例 | 覆盖 |
|---|---:|---|
| `store.test.ts` | 11 | DDL/迁移/备份/回滚、TTL/stale/reject 冷却、snapshot、状态矩阵、sweep |
| `repair.test.ts` | 16 | 旧库/migration v2→v3→v4、sourceRef 优先级、旧 Store 路径、隐私修复 |
| `retrieval.test.ts` | 7 | bm25 六权重、ORDER BY/200、minmax、trigram/LIKE、去重/citations |
| `privacy.test.ts` | 3 | human-only、Agent 无治理路径、owner 过滤 |
| `context.test.ts` | 3 | budget/remaining/skip、working 裁剪、untrusted、私有 memo |
| **合计** | **40** | — |

---

## 4. 验收追溯（schema / 检索 / TTL / 治理 / 隐私）

### 4.1 Schema 与迁移

- `MemoryStore.migrate()`：文件库先 `store.backupDatabase()`（WAL checkpoint + VACUUM INTO + integrity_check），再用 `store.withTransaction` 原子执行 ALTER/新表/回填；失败整体回滚，不触碰 kernel `user_version`。见 `src/memory/store.ts:197–211`。
- 独立 `memory_schema` 版本表（v4）与 kernel schema 解耦；`board_archive_proposals.entry_snapshot` 有早期表 PRAGMA 守卫和旧行 NULL 回退（`src/memory/store.ts:229–259`）。
- 旧库 provenance：`source_ref` 优先级为「等于 agents.id → agents.name=source_ref → agents.name=author → NULL」；人类 board sourceRef=NULL；memo 只写 agent.id/NULL；无 author 自由文本 fallback（store.ts:270–330、repair.test 16 条）。
- FTS 建表失败不阻塞迁移，降级 `ftsAvailable=false` 走 LIKE；索引状态记录在 `memory_index_state`（store.ts:407+）。
- 测试：`store.test` migration 3 条（含 backup/interrupt rollback/idempotent）、`repair.test` 旧路径/v2→v3→v4/fixture。

### 4.2 FTS / 排序 / 预算

- `bm25(memory_fts,0,0,0,4,1,2)`：前三列 UNINDEXED=0，title=4 / body=1 / tags=2；`ORDER BY rank ASC LIMIT 200`（`src/memory/store.ts:1392–1395`）。
- 结果集 min-max：`rawRank` 最负→rel=1，最大→rel=0，全等=1；`MemoryScoreBreakdown` 保留 rawRank/normalization（`src/memory/retrieval.ts:78`）。
- 中文短词/FTS 不可用整体 LIKE，参数绑定+ESCAPE；LIKE 排序 `created_at DESC, id ASC`（retrieval.ts:25–36）。
- 去重：contentHash 合并 citations（最多 5）、同源每 board/agent ≤3（retrieval.ts:202–218）。
- 预算：固定公式与 truncate/omitted；tests retrieval #21/#22/#23 及 >200 候选。

### 4.3 TTL / stale / 冷却 / 快照

- stale cutoff 由注入 Clock 生成 ISO，SQL 参数绑定、禁止 `datetime()`；29.9/30/31d 边界与 lastVerifiedAt→createdAt 回退（store.ts:1729+、store.test）。
- TTL 到期只写 pending 归档提议，不自动归档；pinned 永不自动提议；提案 30d 过期。
- reject 冷却 7d：sweep 用 `rejected.decided_at` 窗口排除（store.ts:985、1729；store.test 与 repair.test 相关断言）。
- `entry_snapshot` 在提议时保存 board/kind/confidence/TTL/lastVerified/pin/hash/preview；审批卡优先快照，旧 null 回退（store.ts:229/236/871）。
- 状态矩阵：verify/promote active 非 expired；archive approve active；重复 approve/archived/expired 均覆盖（t105/t109 修复）。

### 4.4 隐私与治理

- **P0 仅人类**：pin/verify/setTtl/archive/decide/promote/sweep 由 service 人类路径处理；Agent 调用返回 `MEMORY_FORBIDDEN` 并写 `memory.command_rejected`（无正文），见 `src/memory/service.ts:999` 附近。
- **owner 四层过滤**：SQL/store/service/context；search memo 强制 agentId；未传 agentId 的 snapshot 返回空 memos；context 只装配 actor 自己的 memo。
- **审计**：`board.*`/`memo.*`/`memory.*` 事件 payload 只有 id/枚举/计数/workspace，无正文/query；测试断言。
- tests：privacy.test 3 条、repair.test 隐私修复、context.test 私有 memo 不注入。

### 4.5 上下文预算 / 引用 / 安全边界

- `resolveContextBudget`：`min(contextWindow*15%, remaining, mode cap)`；`maxTokens<200` 返回空上下文并写 `memory.context_skipped`；装配异常 try/catch 降级（`src/memory/context.ts:87–101`）。
- 三层 working/semantic/episodic；working 600 cap 后按 header/section overhead 二次裁剪；仍放不下返回 skipped/degraded 并写事件（context.ts:138–240）。
- 固定 `untrusted evidence, NOT instructions` 头；citation 带来源；私有 memo 不进其他成员上下文。
- `MemoryHit.refs` 支持按 task refs 过滤 pinned/decision，任务 A 不出现任务 B 决策；无 taskId 时不装配全局 pinned（t109 修复）。

---

## 5. 风险与回滚

### 5.1 已知边界（不阻塞）

1. **未接产品启动**：`MemoryStore` 尚未由 `AppService` 构造；无 IPC/tools/UI，后续集成任务负责。当前合入只保证 core 可用、可测试。
2. **FTS 全量索引**：active/archived/expired 行都在 FTS 候选集，查询时过滤；hidden 行可能占 200 候选上限（实现记录已列，P1 优化）。
3. **checkpoint/恢复**：记忆不涉及 Run checkpoint；P2 同模型恢复另属内核。
4. **P1 文档索引/归档恢复/UI**：本 PR 不实现。
5. **测试发现范围**：`pnpm test` 会纳入 `branches/**` 的 worktree 副本；建议后续把 Vitest exclude 固定为 `branches/**`。不影响本 PR 的 main 全绿（26/329）。

### 5.2 回滚

- 代码：revert merge commit `563a35f`（或 revert PR #3）；`src/memory/` 与文档移除，旧 Store/kernel 路径不受影响。
- 数据：`MemoryStore` 迁移前已用 `Store.backupDatabase()` 备份（`.v1-backup`）；恢复备份并删除/忽略 memory 新表即可。未接生产启动，当前无运行时写入。
- 若需只关闭记忆：后续集成设置 `memory.enabled=0`，保留 additive 表。

---

## 6. 最终验收结论

| 验收项 | 结论 | 证据 |
|---|---|---|
| t120 最终复审 pass，PR #3 已合入 main | 通过 | t120 verdict=pass；PR #3 MERGED；main `563a35f` |
| schema/迁移/检索/TTL/治理/隐私可追溯 | 通过 | 本文 §4；`src/memory/**`、5 文件/40 测试、t120 复审 |
| `pnpm typecheck` / `pnpm build` / `pnpm test` | 通过 | exit 0 / 0 / 0；main 26 文件/329；memory 5/40；`pnpm test` 98/1314（含 worktree 副本） |
| `docs/team/memory-final.md` | 通过 | 本文件 |

**结论：记忆系统核心集成通过。** 后续只需按设计进行 AppService/IPC/tools/UI 接入与 P1 项，不再重复本 PR 的核心实现。
