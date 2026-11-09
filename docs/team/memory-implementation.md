# 记忆系统核心实现记录（t99）

> 设计基线：`docs/team/memory-system-design.md`（t74 + t86 修订，t89 复审 pass）。
> 实现分支：`feature/t99-memory-core`（worktree `branches/t99-memory-core`，基于 `origin/main` 24ba09a）。
> 范围：记忆核心存储/迁移/检索/TTL/治理；**不包含** AppService、IPC、工具、UI 集成（t99 明确 out of scope）。
> 日期：2026-11-10（Asia/Shanghai）。

---

## 1. 交付摘要

本 PR 交付可独立测试的 `src/memory/` 记忆核心：

- 黑板领域/条目/source/confidence/TTL/lastVerifiedAt/pin/归档提议 + `entry_snapshot`；
- 私有备忘录：owner、标签、sourceTaskId/sourceRunId、过期、stale、confidence；
- `TaskSummary` 扩展字段与 upsert（runId 幂等）；
- SQLite FTS5 trigram、六权重 `bm25(memory_fts,0,0,0,4,1,2)`、`ORDER BY rank ASC LIMIT 200`、结果集 min-max relevance、breakdown；
- 中文短词/FTS 不可用时的 LIKE 回退；
- 注入 Clock 的 ISO cutoff、stale 29.9/30/31d、TTL 归档提议、reject 7 天冷却、entry_snapshot；
- 人类专属治理：pin/verify/archive/decide/promote；Agent 只能读写自己的备忘录/发黑板；
- owner 四层过滤：SQL、store、service、context；
- 检索预算/去重/来源引用/untrusted 注入边界；
- 事件审计（payload 不含正文/query）、migration additive/备份/回滚；
- 24 条确定性核心测试。

**未修改** `src/kernel/store.ts`：`MemoryStore` 组合复用既有 `Store.db`、`Store.withTransaction`、`Store.backupDatabase`，避免把新的记忆行为塞进旧方法；服务/工具/IPC 接入是后续任务（见 §8）。

---

## 2. 文件与职责

| 文件 | 职责 |
|------|------|
| `src/memory/types.ts` | 记忆核心类型、配置、错误、`MemoryResult`、`Clock`；不依赖 UI/Electron |
| `src/memory/clock.ts` | `SystemClock` / `FixedClock`（确定性测试） |
| `src/memory/util.ts` | id、ISO 日期、内容归一/哈希、token 估算、LIKE 转义、snippet、去重辅助 |
| `src/memory/indexing.ts` | board/memo/summary → FTS document（title/body/tags/contentHash） |
| `src/memory/retrieval.ts` | query 归一、FTS/LIKE 相关度、min-max、六因子评分、tie-break、去重、预算截断、citation 渲染 |
| `src/memory/store.ts` | 迁移/DDL/备份/回滚、CRUD、生命周期、归档提议、FTS 索引、search、snapshot、sweep、Run 证据刷新 |
| `src/memory/service.ts` | 服务边界：actor 推断、human-only 治理、owner 过滤、错误结果、审计拒绝 |
| `src/memory/context.ts` | 三层上下文装配、预算/截断、untrusted 固定头、citation |
| `src/memory/*.test.ts` | store/retrieval/privacy/context 确定性测试 |

> 备注：设计文档曾建议 `src/kernel/memory/`，但 t99 的 in-scope 明确为 `src/memory/`；按任务范围落地，避免与未完成的 service/tools 改动混在一起。

---

## 3. Schema 与迁移

### 3.1 新增/扩展

- `board_entries`：`source/source_ref/ttl_at/last_verified_at/verified_by/evidence_at/status/archived_at/archived_by/archive_reason/promoted_to_id/stale/updated_at/content_hash`。
- `memos`：`confidence/source/source_ref/source_task_id/source_run_id/expires_at/status/stale/last_verified_at/verified_by/promoted_to_board_id/updated_at/content_hash`。
- `summaries`：`workspace_id/attempt/outcome/next_steps/evidence_refs/agent_name/model/token_in/token_out/duration_ms/content_hash/embedding`。
- 新表：`memory_schema`、`board_domains`、`board_archive_proposals`（含 `entry_snapshot TEXT`）、`memory_index_state`、`memory_fts`（6 列 + trigram）。
- 索引：board_domains workspace；archive workspace/status/proposedAt、entry/status/decidedAt、pending 部分唯一；summaries task/run；memos agent/status/time；board workspace/board/status/time。

### 3.2 迁移保证

- 首次迁移前对文件库执行 `VACUUM INTO` 备份（复用 `Store.backupDatabase`，含 `integrity_check`）；`:memory:` 跳过。
- `Store.withTransaction` 包裹 ALTER/新表/backfill/memory_schema 写入；任何 DDL/回填失败整体回滚，`Store.user_version` 不被记忆修改。
- 旧行回填：source/status/updated_at/content_hash/domains；memo confidence/source/status/stale；summary workspaceId（从 tasks）、outcome（done=completed）、attempt、agent/model/token/duration。
- 二次构造 `MemoryStore` 幂等；`memory_schema` 独立版本，不与 t68 `user_version=2` 混用。
- FTS 在 schema 提交后创建；创建失败不阻塞迁移，`ftsAvailable=false` 并走 LIKE；`memory_index_state` 记录 dirty/available。
- 已用测试验证：旧库备份、迁移失败回滚、旧 `Store.postBoard/addMemo/saveSummary` 路径、二次迁移幂等。

---

## 4. 检索

### 4.1 FTS 查询

```sql
SELECT entity_type, entity_id,
       bm25(memory_fts, 0.0, 0.0, 0.0, 4.0, 1.0, 2.0) AS rank
  FROM memory_fts
 WHERE workspace_id = ? AND memory_fts MATCH ?
 ORDER BY rank ASC
 LIMIT 200;
```

- 6 列权重对应 `entity_type/entity_id/workspace_id`（UNINDEXED 0）+ `title=4/body=1/tags=2`；
- FTS5 bm25 为负值、越负越相关；先排序再 LIMIT，避免 >200 时丢最佳项；
- query 规范化 NFKC/控制符/长度；每个 term 用双引号 phrase，内部双引号双写；
- 任一词 <3 字（中文两字）或 FTS 不可用 → 整体 LIKE，避免混合不可比 rank；
- LIKE 使用参数绑定 + `ESCAPE '\'`，显式 `ORDER BY created_at DESC, id ASC LIMIT 200`。

### 4.2 relevance 与评分

- FTS 候选经可见性/状态过滤后，对**参与排序的可见候选**做结果集 min-max：
  - `rankMin = min(rank)`（最负=最佳）→ rel=1；`rankMax = max(rank)` → rel=0；全等=1。
- `MemoryScoreBreakdown` 保留 `relevance/rawRank/normalization/confidence/freshness/typeWeight/pinBoost/verifiedBoost/evidenceBoost/penalty/score`。
- 固定 score：`rel^0.8 × confidence × freshness × typeWeight × pin × verified × evidence × penalty`，round6；tie-break `score DESC → pinned → verified → freshness → createdAt → id`。
- 去重：按 contentHash 保留最高分并合并 citations（最多 5）。
- 预算：`estimateTokens=ceil(chars/3)`；默认 semantic 900 / episodic 700，全局不超 maxTokens；超出计 omitted。
- 测试覆盖：3 次命中 > 1 次、tag 命中 > 正文噪声、>200 命中最优项保留、中文 2 字 LIKE、FTS 中文 3 字、注入输入不抛异常、重复调用确定性、内容指纹去重/citations。

---

## 5. 生命周期与治理

- 黑板领域自动创建、大小写/空白归一。
- TTL 到期只产生 pending 归档提议，不自动归档；pinned 永不自动提议。
- `entry_snapshot` 在提议时写入（board/kind/confidence/TTL/lastVerified/pin/hash/preview）；提议后 verify/pin/TTL 变化将 pending 置 superseded；批准卡可读取快照。
- 提案过期 30d；reject 后 7 天内自动 sweep 不重提，期满可重提；人工可显式提议（P0 低层允许，服务人类）。
- stale：Clock 计算 ISO cutoff，参数绑定，SQL 不使用 `datetime()`；29.9d 不 stale、30.0d/31d stale；lastVerifiedAt 优先、否则 createdAt；verify 清除 stale。
- memo 过期：status=expired，不删除；搜索默认排除。
- Run 成功只刷新 board `evidence_at`；memo 没有 evidenceAt，只用 sourceTaskId/sourceRunId。
- 服务层 human-only：pin/verify/setTtl/archive propose/decide/promote/ memo verify/archive/promote/sweep；Agent 调用返回 `MEMORY_FORBIDDEN` 并写 `memory.command_rejected`（无正文）。
- owner：listMemos 必须 agentId；search 的 memo 候选强制 `input.agentId`；snapshot 未传 agentId 返回空 memos；context 只装配 actor 自己的 memo。

---

## 6. 事件与审计

- 事件通过 `Store.appendEvent`（schemaVersion=1）写入，aggregateType `board`/`memo`/`memory`，payload 只有 id/枚举/计数/workspace，无正文/query：
  - `memory.migrated`
  - `board.domain_created`、`board.posted`、`board.pinned`、`board.verified`、`board.ttl_changed`、`board.archive_proposed`、`board.archived`、`board.archive_rejected`、`board.archive_superseded`、`board.promoted`
  - `memo.created`、`memo.verified`、`memo.archived`、`memo.promoted`
  - `memory.summary_ingested`（run 幂等键）、`memory.evidence_updated`、`memory.sweep_completed`、`memory.command_rejected`
- 测试断言事件 payload 不含 memo 正文；拒绝审计无内容。

---

## 7. 验证

### 7.1 命令与结果

```bash
git rev-parse HEAD                     # 24ba09a + 本分支提交；具体以实际记录为准
pnpm typecheck                         # pass
pnpm build                             # pass
pnpm test                              # pass（见下）
```

- `pnpm typecheck`：通过（无输出错误）。
- `pnpm build`：Vite 392 modules + electron main/preload 构建通过；>500KB chunk 为既有警告。
- `pnpm test`：**25 文件 / 313 条全部通过**（其中记忆核心 4 文件 / 24 条；既有 21 文件 / 289 条无回归）。
- 记忆核心：`pnpm vitest run src/memory` → **4 文件 / 24 条**通过（store 11、retrieval 7、privacy 3、context 3）。

### 7.2 测试覆盖映射

| 验收 | 测试 |
|------|------|
| schema/迁移/备份/回滚/旧库 | `store.test.ts` migration 3 条 |
| TTL/stale 29.9/30/31、verify fallback、reject 冷却、snapshot | `store.test.ts` lifecycle |
| 六权重/ORDER BY/>200/trigram/LIKE/minmax/breakdown/去重 | `retrieval.test.ts` 7 条 |
| owner 四层过滤/人类治理/Agent 无治理路径 | `privacy.test.ts` 3 条 |
| 预算/引用/untrusted/私有 memo 不注入 | `context.test.ts` 3 条 |

### 7.3 未覆盖/后续

- 本任务不接 `AppService`/IPC/tools/UI；`getContext`、`memory.search` 工具、MemoryView、维护定时器仍在后续集成任务。
- P1 仓库文档索引、归档恢复、UI 快照卡/ARIA 未在本 PR 实现（设计明确 P1；t99 out of scope）。
- `src/kernel/store.ts` 未改；MemoryStore 通过组合复用其 db/事务/备份。后续集成需要在 `AppService` 初始化 MemoryStore，并接 run.completed → `onRunCompleted`/`saveSummary`。
- FTS 索引当前包含 active/archived/expired 全量并在查询时过滤；hidden 行可能占候选上限，后续可改为按状态重建或加状态列（P1 优化，未影响本次验收）。

---

## 8. 与设计基线的偏差/决策

1. **路径**：设计建议 `src/kernel/memory/`，t99 in-scope 为 `src/memory/`；按任务范围，避免把 service/tools 改动混入本 PR。
2. **不修改 store.ts**：复用 `readonly db`、`withTransaction`、`backupDatabase`，减少对既有内核方法的侵入；这是最小功能 PR 的取舍。
3. **P0 文档索引=不做**：遵循 Captain Q-M5；`memory_documents`/doc scope 不实现，search 过滤 doc scope。
4. **archive 恢复**：P1；P0 只读/筛选归档。
5. **reject 冷却用 proposal.decidedAt**：不新增 entry 列，直接用 rejected proposal 的时间窗口；等价于 `last_rejected_at`，减少 schema 面积。
6. **contentHash 粒度**：board 含 board/kind 前缀，memo/summary 各自前缀；同一类同内容去重，跨类型不去重（P0 保守，避免把 board 与 memo 误合并）。
7. **MemoryStore 构造即迁移**：与 AppService 集成时可显式构造；迁移失败抛出，不阻塞 AppService 启动（后续集成可捕获并降级）。

---

## 9. 后续集成清单（不属于 t99）

1. `src/kernel/service.ts` 初始化 `MemoryStore`，暴露 `getContext`/`memory.search`/治理 IPC。
2. `src/kernel/tools.ts` 注入 `MemoryToolApi`，Agent 只可 board.write/list、memo.write/search、memory.search；无治理工具。
3. `src/shared/types.ts` 将本地 Memory 类型收敛/映射到共享类型（或保留独立 DTO）。
4. `src/App.tsx`/MemoryView：三页签、领域 Tab、TTL/stale、pin/verify/archive、memo、检索 aria-live。
5. 维护定时器 + Run 终态钩子；docs P1。
6. 事件注册表：t68 `eventRegistry` 增加 memory 聚合/事件（当前 schemaVersion=1 走 legacy 路径）。

---

## 10. 回滚

- 代码回滚：revert 本 PR；`src/memory/` 与集成调用点移除。
- DB：迁移前 `Store.backupDatabase()` 生成 `.v1-backup`；恢复备份文件即可。新列/新表可忽略，不破坏旧 Store 读取。
- 关闭记忆：后续集成 `memory.enabled=0` 只走旧路径；本 PR 未接生产启动，不改变现有行为。
